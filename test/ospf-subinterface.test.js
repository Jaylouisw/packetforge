'use strict';
// ospf-subinterface.test.js - router-on-a-stick, where the interface holding the address is a tag.
//
// R1 and R2 both use `interface Gi0/0.20` on one trunk through SW1. Two things were wrong:
//
//   R1(config-router)#network 10.0.20.0 0.0.0.255 area 0
//   % No interface of R1 matches 10.0.20.0 0.0.0.255 - nothing was changed
//   % The interfaces and their addresses are in "show ip interface brief"
//
// ...for an interface holding 10.0.20.1. The matcher skipped `i.parent` (and `i.svi`), so the one
// address it was asked about was the one it could not see. And `segmentOf()` starts at `iface.peer`,
// which a subinterface does not have - it rides its parent's wire with a tag - so once the area was
// configurable, nothing walked that segment and no adjacency formed.
//
// `segmentOf(..., { vid })` now walks a *tagged* frame: every switch port it touches must carry the
// tag, so a trunk that does not allow the VLAN stops the adjacency exactly as it stops the frame.
const path = require('path');
const { Topology, Simulator } = require('../engine');
const { CliSession } = require('../engine/cli');
const { loadCatalog } = require('../devices/registry');
const seg = require('../engine/segment');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg); }
}
function text(out) { return out && out.output ? out.output.join('\n') : String(out); }
const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
const find = function (m) { return catalog.filter(function (x) { return x.model === m; })[0]; };
function neighborRows(body) {
  return body.split('\n').filter(function (l) { return /FULL|INIT|2WAY|EXSTART/.test(l); });
}

// R1 -- SW1 -- R2, both routers addressed on a subinterface. `o` bends one end of the lab.
function stick(opts) {
  const o = opts || {};
  const t = new Topology();
  const r1 = t.addDevice(find('generic-router')); r1.name = 'R1';
  const sw = t.addDevice(find('generic-switch')); sw.name = 'SW1';
  const r2 = t.addDevice(find('generic-router')); r2.name = 'R2';
  const ports = Array.from(sw.interfaces.values()).filter(function (i) { return !i.svi; }).map(function (i) { return i.name; });
  t.connect(r1.id, 'Gi0/0', sw.id, ports[0]);
  t.connect(sw.id, ports[1], r2.id, 'Gi0/0');
  const sim = new Simulator(t);
  const allowed = o.allowed === undefined ? '20' : o.allowed;
  const ss = new CliSession(sw, t, sim); ss.run('enable'); ss.run('configure terminal');
  ss.run('vlan 20'); ss.run('vlan 30');
  for (const p of [ports[0], ports[1]]) {
    ss.run('interface ' + p);
    ss.run('switchport mode trunk');
    const ans = text(ss.run('switchport trunk allowed vlan ' + allowed));
    if (o.assertSetup !== false && !/Trunk on/.test(ans)) throw new Error('trunk setup failed: ' + ans);
    ss.run('exit');
  }
  ss.run('end');
  // R1: subinterface 20. R2: subinterface 20, unless the case says otherwise.
  const s1 = new CliSession(r1, t, sim); s1.run('enable'); s1.run('configure terminal');
  s1.run('interface Gi0/0'); s1.run('no shutdown'); s1.run('exit');
  s1.run('interface Gi0/0.' + (o.r1Tag || 20));
  s1.run('encapsulation dot1q ' + (o.r1Tag || 20));
  s1.run('ip address ' + (o.r1Ip || '10.0.20.1') + ' 255.255.255.0'); s1.run('exit');
  s1.run('router ospf 1');
  const net = text(s1.run('network ' + (o.r1Net || '10.0.20.0') + ' 0.0.0.255 area 0'));
  if (o.assertSetup !== false && !/put 1 interface in area 0/.test(net)) {
    throw new Error('R1 network statement failed: ' + net);
  }
  s1.run('exit'); s1.run('end');
  const s2 = new CliSession(r2, t, sim); s2.run('enable'); s2.run('configure terminal');
  s2.run('interface Gi0/0'); s2.run('no shutdown'); s2.run('exit');
  if (o.r2Untagged) {
    s2.run('interface Gi0/0'); s2.run('ip address ' + (o.r2Ip || '10.0.20.2') + ' 255.255.255.0'); s2.run('exit');
    s2.run('router ospf 1'); s2.run('network 10.0.20.0 0.0.0.255 area 0'); s2.run('exit');
  } else {
    s2.run('interface Gi0/0.' + (o.r2Tag || 20));
    s2.run('encapsulation dot1q ' + (o.r2Tag || 20));
    s2.run('ip address ' + (o.r2Ip || '10.0.20.2') + ' 255.255.255.0'); s2.run('exit');
    s2.run('router ospf 1'); s2.run('network 10.0.20.0 0.0.0.255 area 0'); s2.run('exit');
  }
  if (o.r2Shutdown) {
    s2.run('interface Gi0/0'); s2.run('shutdown'); s2.run('exit');
  }
  s2.run('end');
  return { t: t, sim: sim, r1: r1, r2: r2, s1: s1, s2: s2, ports: ports };
}

console.log('The area statement can name an interface that is a tag:');
{
  const env = stick();
  const brief = text(env.s1.run('show ip interface brief'));
  ok(/Gi0\/0\.20/.test(brief) && /10\.0\.20\.1/.test(brief), 'the subinterface holds the address');
  const nbr = text(env.s1.run('show ip ospf neighbor'));
  ok(neighborRows(nbr).length === 1, 'R1 has one neighbour: ' +
    (neighborRows(nbr)[0] || nbr.split('\n').pop()).trim());
  ok(/Gi0\/0\.20/.test(nbr), 'named on the subinterface it formed over');
  ok(neighborRows(text(env.s2.run('show ip ospf neighbor'))).length === 1, 'R2 has one too');
}

console.log('\nThe tagged walk is the one that carries the tag:');
{
  const env = stick();
  const walk = seg.segmentOf(env.t, env.r1, 'Gi0/0', { vid: 20 })
    .map(function (x) { return x.device.name + '/' + x.iface.name; });
  ok(walk.indexOf('R2/Gi0/0') !== -1, 'a frame tagged 20 reaches R2: ' + JSON.stringify(walk));
  // Both ends must see each other: an adjacency is symmetric, and a walk that only worked one way
  // would form one side of a conversation.
  const back = seg.segmentOf(env.t, env.r2, 'Gi0/0', { vid: 20 })
    .map(function (x) { return x.device.name + '/' + x.iface.name; });
  ok(back.indexOf('R1/Gi0/0') !== -1, 'and the walk from R2 reaches R1: ' + JSON.stringify(back));
  // The same walk for a tag the trunk does not carry goes nowhere.
  const wrong = seg.segmentOf(env.t, env.r1, 'Gi0/0', { vid: 30 });
  ok(wrong.filter(function (x) { return x.device.name === 'R2'; }).length === 0,
    'a frame tagged 30 does not: the trunk allows only 20');
}

console.log('\nA trunk that does not carry the VLAN forms nothing:');
{
  const env = stick({ allowed: '30' });
  ok(neighborRows(text(env.s1.run('show ip ospf neighbor'))).length === 0, 'R1 has no neighbour');
  ok(neighborRows(text(env.s2.run('show ip ospf neighbor'))).length === 0, 'and R2 has none');
}

console.log('\nDifferent tags in one subnet form nothing:');
{
  const env = stick({ r2Tag: 30, allowed: '20,30' });
  ok(neighborRows(text(env.s1.run('show ip ospf neighbor'))).length === 0,
    'VLAN 20 and VLAN 30 are two segments, not one');
  ok(neighborRows(text(env.s2.run('show ip ospf neighbor'))).length === 0, 'on either side');
}

console.log('\nA tag on one end and none on the other forms nothing:');
{
  const env = stick({ r2Untagged: true, assertSetup: false });
  ok(neighborRows(text(env.s1.run('show ip ospf neighbor'))).length === 0,
    'an untagged port is not a member of VLAN 20');
}

console.log('\nA shut parent port takes the subinterface with it:');
{
  const env = stick({ r2Shutdown: true, assertSetup: false });
  ok(neighborRows(text(env.s1.run('show ip ospf neighbor'))).length === 0,
    'no adjacency through a port that is down');
}

console.log('\nTwo subinterfaces in different subnets form nothing:');
{
  const env = stick({ r2Ip: '10.0.99.2', r1Net: '10.0.20.0', assertSetup: false });
  ok(neighborRows(text(env.s1.run('show ip ospf neighbor'))).length === 0,
    'the subnet check still applies to a tagged segment');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
