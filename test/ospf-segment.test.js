'use strict';
// ospf-segment.test.js - two routers on one segment, and the adjacency that never came up.
//
// The ordinary lab shape is R1 -- SW1 -- R2. Nothing about it is wrong: one broadcast segment, both
// interfaces in 10.0.0.0/24, both in area 0, neither passive. OSPF formed no adjacency, learned no
// routes, and said:
//
//   R1#show ip ospf neighbor
//   (no adjacencies - no neighbour passed the passive, subnet and area checks)   <- all three passed
//
// Two causes, both fixed here. Adjacency was built only from a direct `topology.links` entry, so a
// switch between two speakers - which is transparent to frames - broke it; and the engine required a
// configured `router-id`, so a lab that never typed one had no speakers at all, while `show ip ospf`
// promised "the model uses the highest interface address".
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

// R1 -- SW1 -- R2, with R2 also holding 172.16.0.1/24 so there is something to learn.
function switchedLab(opts) {
  const o = opts || {};
  const t = new Topology();
  const r1 = t.addDevice(find('generic-router')); r1.name = 'R1';
  const sw = t.addDevice(find('generic-switch')); sw.name = 'SW1';
  const r2 = t.addDevice(find('generic-router')); r2.name = 'R2';
  const swPorts = Array.from(sw.interfaces.values()).filter(function (i) { return !i.svi; }).map(function (i) { return i.name; });
  t.connect(r1.id, 'Gi0/0', sw.id, swPorts[0]);
  t.connect(sw.id, swPorts[1], r2.id, 'Gi0/0');
  const sim = new Simulator(t);
  const s1 = new CliSession(r1, t, sim); s1.run('enable'); s1.run('configure terminal');
  s1.run('interface Gi0/0'); s1.run('ip address ' + (o.r1Ip || '10.0.0.1') + ' 255.255.255.0'); s1.run('exit');
  s1.run('router ospf 1');
  s1.run('network 10.0.0.0 0.0.0.255 area ' + (o.r1Area === undefined ? 0 : o.r1Area));
  s1.run('exit');
  // `passive-interface` is not this console's spelling: it is `ip ospf passive` inside the block.
  // The answer is checked, because a refused setup command would leave the negative test below
  // passing for a reason it never established.
  if (o.r1Passive) {
    s1.run('interface Gi0/0');
    const ans = text(s1.run('ip ospf passive'));
    if (!/OSPF passive on Gi0\/0/.test(ans)) throw new Error('passive setup failed: ' + ans);
    s1.run('exit');
  }
  s1.run('end');
  const s2 = new CliSession(r2, t, sim); s2.run('enable'); s2.run('configure terminal');
  s2.run('interface Gi0/0'); s2.run('ip address ' + (o.r2Ip || '10.0.0.2') + ' 255.255.255.0'); s2.run('exit');
  s2.run('interface Gi0/1'); s2.run('ip address 172.16.0.1 255.255.255.0'); s2.run('exit');
  s2.run('router ospf 1');
  s2.run('network 10.0.0.0 0.0.0.255 area ' + (o.r2Area === undefined ? 0 : o.r2Area));
  s2.run('network 172.16.0.0 0.0.0.255 area 0');
  s2.run('exit'); s2.run('end');
  return { t: t, sim: sim, r1: r1, r2: r2, s1: s1, s2: s2 };
}
function neighborRows(body) {
  return body.split('\n').filter(function (l) { return /FULL|INIT|2WAY|EXSTART/.test(l); });
}

console.log('Two routers on one segment, with no router-id configured:');
{
  const env = switchedLab();
  const n1 = text(env.s1.run('show ip ospf neighbor'));
  const n2 = text(env.s2.run('show ip ospf neighbor'));
  ok(neighborRows(n1).length === 1, 'R1 lists one neighbour: ' + (neighborRows(n1)[0] || n1.split('\n').pop()).trim());
  ok(/FULL/.test(n1), 'and the state is FULL');
  ok(/10\.0\.0\.2/.test(n1), 'with the address it formed over');
  ok(/Gi0\/0/.test(n1), 'and the interface it formed on');
  ok(neighborRows(n2).length === 1, 'R2 lists one neighbour too');
  const table = text(env.s1.run('show ip route'));
  ok(/172\.16\.0\.0\/24/.test(table), 'R1 learned the far subnet');
  ok(/^\s*\*\s+O\s+172\.16\.0\.0\/24\s+110\s+10\.0\.0\.2\s+Gi0\/0/m.test(table),
    'as an O route with its gateway and egress port');
  const ping = text(env.s1.run('ping 172.16.0.1 count 3'));
  ok(/100 percent \(3\/3\)/.test(ping), 'and the router forwards over it');
}

console.log('\nThe derived router-id is stated, not described:');
{
  const env = switchedLab();
  const body = text(env.s1.run('show ip ospf'));
  ok(/with ID 10\.0\.0\.1/.test(body), 'the process prints the id it is running (' +
    (body.split('\n').filter(function (l) { return /with ID/.test(l); })[0] || '').trim() + ')');
  ok(/derived: no router-id is configured/.test(body), 'and says the id was derived');
  ok(!/not configured - the model uses/.test(body), 'rather than describing a rule instead of an answer');
}

console.log('\nA configured router-id is the one used:');
{
  const env = switchedLab();
  env.s1.run('configure terminal'); env.s1.run('bgp router-id 1.1.1.1'); env.s1.run('end');
  env.s1.run('configure terminal'); env.s1.run('router ospf 1'); env.s1.run('router-id 9.9.9.9');
  env.s1.run('exit'); env.s1.run('end');
  const body = text(env.s1.run('show ip ospf'));
  ok(/with ID 9\.9\.9\.9/.test(body), 'the configured id wins over the highest address');
  ok(!/derived/.test(body), 'and is not called derived');
  const n2 = text(env.s2.run('show ip ospf neighbor'));
  ok(/9\.9\.9\.9/.test(n2), 'the neighbour sees that id (' +
    (neighborRows(n2)[0] || '').trim() + ')');
}

console.log('\nAn area mismatch across the segment is named:');
{
  const env = switchedLab({ r2Area: 2 });
  const n1 = text(env.s1.run('show ip ospf neighbor'));
  ok(neighborRows(n1).length === 0, 'no adjacency forms');
  ok(/area 2/.test(n1) && /area 0/.test(n1), 'and the answer names both areas');
  ok(/matching area/.test(n1), 'and the rule');
  ok(neighborRows(text(env.s2.run('show ip ospf neighbor'))).length === 0, 'neither side forms one');
}

console.log('\nA passive interface across the segment forms nothing:');
{
  const env = switchedLab({ r1Passive: true });
  ok(neighborRows(text(env.s1.run('show ip ospf neighbor'))).length === 0, 'R1 has no neighbour');
  ok(neighborRows(text(env.s2.run('show ip ospf neighbor'))).length === 0, 'and R2 has none');
  // R2's own 172.16.0.0/24 is a connected route there, so the check is for an OSPF row at all.
  ok(!/^\s*\*\s+O\s/m.test(text(env.s2.run('show ip route'))),
    'and R2 learns no OSPF route from the silent side');
}

console.log('\nDifferent subnets on one segment form nothing:');
{
  const env = switchedLab({ r2Ip: '10.0.9.2' });
  ok(neighborRows(text(env.s1.run('show ip ospf neighbor'))).length === 0, 'no adjacency on a subnet mismatch');
  ok(!/172\.16\.0\.0\/24/.test(text(env.s1.run('show ip route'))), 'and nothing is learned behind it');
}

console.log('\nA direct cable still works, and still names its port:');
{
  const t = new Topology();
  const r1 = t.addDevice(find('generic-router')); r1.name = 'R1';
  const r2 = t.addDevice(find('generic-router')); r2.name = 'R2';
  t.connect(r1.id, 'Gi0/0', r2.id, 'Gi0/0');
  const sim = new Simulator(t);
  const s1 = new CliSession(r1, t, sim); s1.run('enable'); s1.run('configure terminal');
  s1.run('interface Gi0/0'); s1.run('ip address 10.0.0.1 255.255.255.0'); s1.run('exit');
  s1.run('router ospf 1'); s1.run('network 10.0.0.0 0.0.0.255 area 0'); s1.run('exit'); s1.run('end');
  const s2 = new CliSession(r2, t, sim); s2.run('enable'); s2.run('configure terminal');
  s2.run('interface Gi0/0'); s2.run('ip address 10.0.0.2 255.255.255.0'); s2.run('exit');
  s2.run('interface Gi0/1'); s2.run('ip address 172.16.0.1 255.255.255.0'); s2.run('exit');
  s2.run('router ospf 1'); s2.run('network 10.0.0.0 0.0.0.255 area 0');
  s2.run('network 172.16.0.0 0.0.0.255 area 0'); s2.run('exit'); s2.run('end');
  ok(neighborRows(text(s1.run('show ip ospf neighbor'))).length === 1, 'a cabled pair still forms an adjacency');
  const table = text(s1.run('show ip route'));
  ok(/^\s*\*\s+O\s+172\.16\.0\.0\/24\s+110\s+10\.0\.0\.2\s+Gi0\/0/m.test(table),
    'and its route carries the egress port');
  ok(/100 percent \(3\/3\)/.test(text(s1.run('ping 172.16.0.1 count 3'))), 'and forwards');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
