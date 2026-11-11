'use strict';
// capability-gate.test.js - a verb family that changes state is refused where the device has no such state.
//
// The `?` page is capability-filtered: a row appears only where the device can use it. The parser was
// not. On a camera, a server and an AP - none of which bridges, routes or serves DHCP:
//
//   no spanning-tree vlan 10          -> "Spanning tree bridge priority on D1 is already the default (32768)"
//   ip dhcp pool lab                  -> "Created DHCP pool lab"      (and the session entered the pool)
//   no router bgp 65001               -> "BGP disabled"
//   no ospf area 10                   -> "OSPF disabled"
//   ip route 10.9.0.0 255.255.255.0 10.0.0.9 -> "Route added: 10.9.0.0/24 via 10.0.0.9"
//   no router ospf 1                  -> "% Unexpected argument \"1\" - no router ospf takes no more"
//
// Every one of those promises a state the device cannot have: a bridge priority for a box with no
// bridge, a DHCP pool on a DHCP client, a disabled routing protocol, a static route on a host. The last
// one answers a syntax question, which is the wrong question to answer first on a device that cannot run
// the protocol at all.
//
// The page already holds each refusal (`_helpRefusal` is what hides the row), so the parser asks it.
const path = require('path');
const { Topology, Simulator } = require('../engine');
const { CliSession } = require('../engine/cli');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg); }
}
function text(out) { return out && out.output ? out.output.join('\n') : String(out); }
const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
const find = function (m) { return catalog.filter(function (x) { return x.model === m; })[0]; };

function device(model) {
  const t = new Topology();
  const d = t.addDevice(find(model)); d.name = 'D1';
  const s = new CliSession(d, t, new Simulator(t));
  s.run('enable');
  s.run('configure terminal');
  return { t: t, d: d, s: s };
}
const run = function (model, line) { return text(device(model).s.run(line)); };

// A host, a server and an AP: none bridges, routes or serves DHCP.
const HOSTS = ['NetBotz NBRK0750', 'RS500A-E11-RS12U', 'AP-N506'];

console.log('A device that does not bridge is not told about its bridge priority:');
{
  for (const model of HOSTS) {
    for (const line of ['no spanning-tree vlan 10', 'no spanning-tree vlan 10 priority 4096',
      'no spanning-tree vlan 10 root primary']) {
      const out = run(model, line);
      ok(/no spanning tree/.test(out), model + ": '" + line + "' names the capability (" + out.split('\n')[0] + ')');
      ok(!/bridge priority/.test(out), 'and does not report a bridge priority');
      ok(/^%/.test(out), 'as a refusal');
    }
  }
}

console.log('\nA device that is not a DHCP server has no pool, and no pool sub-mode:');
{
  for (const model of HOSTS) {
    const env = device(model);
    const out = text(env.s.run('ip dhcp pool lab'));
    ok(/not a DHCP server/.test(out), model + ': creating a pool is refused by capability');
    ok(!/Created DHCP pool/.test(out), 'and nothing claims a pool was created');
    ok(env.s.prompt().indexOf('config-dhcp') === -1, 'and the prompt is not in a pool sub-mode');
    ok(((env.d.config.pools || {}).lab === undefined), 'and no pool was stored');
    ok(/not a DHCP server/.test(text(device(model).s.run('no ip dhcp pool lab'))),
      'and removing one is refused the same way');
  }
}

console.log('\nA device that does not route does not disable a routing protocol:');
{
  for (const model of HOSTS) {
    for (const line of ['no router bgp 65001', 'no ospf area 10', 'no router ospf 1', 'ospf area 10']) {
      const out = run(model, line);
      ok(/^%/.test(out), model + ": '" + line + "' is a refusal");
      ok(!/(BGP|OSPF) disabled/.test(out), 'and does not claim a protocol was disabled');
    }
    const ospf = run(model, 'no router ospf 1');
    ok(!/takes no more/.test(ospf), model + ': `no router ospf 1` is not answered as a syntax problem'
      + ' (' + ospf.split('\n')[0] + ')');
    ok(/no routes|not a router|does not forward/.test(ospf), 'but as the capability it lacks');
  }
}

console.log('\nA host may still hold a route, which is not the same as routing:');
{
  // Deliberately *not* gated: a host in this model carries its way out as a route
  // (`ip route 0.0.0.0 0.0.0.0 <gateway>`), labs configure exactly that, and `ip routing` is the verb
  // that refuses by name ("is not a router ... ip default-gateway"). Turning the route away would break
  // every host that has a default gateway written the way IOS writes it.
  for (const model of HOSTS) {
    const env = device(model);
    const out = text(env.s.run('ip route 0.0.0.0 0.0.0.0 10.0.0.9'));
    ok(/Route added/.test(out), model + ': a default route is accepted (' + out.split('\n')[0] + ')');
    ok(((env.d.config.routes || []).length) === 1, 'and stored');
    // What a host cannot do is *turn on forwarding*.
    const on = text(device(model).s.run('ip routing'));
    ok(/^%/.test(on), 'and `ip routing` is refused');
    ok(/not a router|default-gateway/.test(on), 'naming what it is, and what it has instead');
  }
}

console.log('\nCapability is judged before syntax:');
{
  // Both facts are true of a host - it cannot run OSPF, and `1` is an extra word for the row - and the
  // capability is the one that answers the question the operator asked.
  const out = run('NetBotz NBRK0750', 'no router ospf 1');
  ok(!/takes no more/.test(out), 'the extra word is not the answer');
  ok(/does not forward|not a router/.test(out), 'the missing capability is');
  // On a router, where the capability exists, the same line keeps its own refusal.
  const r = run('generic-router', 'no router ospf 1');
  ok(/takes no more/.test(r), 'a router still judges the word it cannot take');
}

console.log('\nThe devices that do have these capabilities are untouched:');
{
  const sw = device('generic-switch').s;
  ok(/bridge priority 4096/.test(text(sw.run('spanning-tree vlan 10 priority 4096'))),
    'a switch still sets a bridge priority');
  ok(/root primary/.test(text(sw.run('spanning-tree vlan 10 root primary'))), 'and a root bridge');
  ok(/already the default|bridge priority/.test(text(sw.run('no spanning-tree vlan 10'))),
    'and the removal still reports what it restored');
  const r = device('generic-router');
  ok(/OSPF process 1 enabled/.test(text(r.s.run('router ospf 1'))), 'a router still starts OSPF');
  ok(/BGP enabled/.test(text(device('generic-router').s.run('router bgp 65001'))), 'and BGP');
  const rt = device('generic-router');
  ok(/Route added/.test(text(rt.s.run('ip route 10.9.0.0 255.255.255.0 10.0.0.9'))),
    'and installs a static route');
  const srv = device('RS500A-E11-RS12U');
  ok(/not a DHCP server/.test(text(srv.s.run('ip dhcp pool lab'))),
    'a server is a DHCP client here, so it is refused - the catalogue decides, not the name');
  const dr = device('generic-router');
  ok(/Created DHCP pool/.test(text(dr.s.run('ip dhcp pool lab'))), 'a router still creates a pool');
}

console.log('\nThe page agrees with the parser:');
{
  for (const model of HOSTS) {
    const env = device(model);
    const page = (env.s._help() || []).join('\n');
    ok(!/ip dhcp pool/.test(page), model + ": the page offers no DHCP pool row it would refuse");
    ok(!/no spanning-tree/.test(page), 'and no spanning-tree row');
  }
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
