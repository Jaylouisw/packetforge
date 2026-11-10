'use strict';
// ospf-show.test.js — `show ip ospf` / `show ip ospf neighbor` must report the
// adjacencies the SPF actually ran over: a peer on a shared subnet is FULL, a
// passive port forms nothing, and before convergence the neighbour is INIT.
const path = require('path');
const { Topology, Simulator, runCommands } = require('../engine');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg); }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
const spec = catalog.find(function (s) { return s.vendor === 'generic' && s.model === 'generic-router'; });

const t = new Topology();
const r1 = t.addDevice(spec);
const r2 = t.addDevice(spec);
r1.name = 'R1'; r2.name = 'R2';
t.connect(r1.id, 'Gi0/0', r2.id, 'Gi0/0');

const sim = new Simulator(t);
function cli(dev, cmds) {
  return runCommands(dev, t, sim, ['enable', 'configure terminal'].concat(cmds)).lines;
}
function show(dev, cmd) {
  return runCommands(dev, t, sim, ['enable', cmd]).lines.join('\n');
}

cli(r1, ['interface Gi0/0', 'ip address 10.0.12.1 255.255.255.0', 'exit',
  'interface Gi0/1', 'ip address 10.0.1.1 255.255.255.0', 'exit',
  'ospf router-id 1.1.1.1', 'ospf area 0',
  'interface Gi0/1', 'ip ospf passive', 'exit']);
cli(r2, ['interface Gi0/0', 'ip address 10.0.12.2 255.255.255.0', 'exit',
  'interface Gi0/1', 'ip address 10.0.2.1 255.255.255.0', 'exit',
  'ospf router-id 2.2.2.2', 'ospf area 0',
  'interface Gi0/1', 'ip ospf passive', 'exit']);

const nbrs = show(r1, 'show ip ospf neighbor');
ok(/2\.2\.2\.2/.test(nbrs), 'the peer router-id appears in the neighbour table');
ok(/10\.0\.12\.2/.test(nbrs), 'the peer address appears in the neighbour table');
ok(/Gi0\/0/.test(nbrs), 'the local port for the adjacency appears');
ok(/FULL/.test(nbrs), 'the adjacency is FULL once converged');
ok(!/10\.0\.1\.1/.test(nbrs), 'a passive interface does not appear as a neighbour');

const proc = show(r1, 'show ip ospf');
ok(/Routing Process "ospf 1" with ID 1\.1\.1\.1/.test(proc), 'show ip ospf names the process and router-id');
ok(/Area 0/.test(proc), 'show ip ospf names the area');
ok(/Gi0\/1\s+\d+\s+0\s+passive/.test(proc), 'a passive interface is marked passive');
ok(/Gi0\/0\s+\d+\s+0\s+active/.test(proc), 'an active interface is marked active');

// The same neighbour before convergence is INIT, not FULL.
sim.setRunTime(0);
const early = show(r1, 'show ip ospf neighbor');
ok(/INIT/.test(early), 'before convergence the neighbour is INIT');
ok(!/FULL/.test(early), 'and is not claimed FULL yet');
sim.setRunTime(Infinity);

// A router with no OSPF configured says so instead of printing an empty table.
const plain = t.addDevice(spec);
const off = show(plain, 'show ip ospf');
ok(/% OSPF is not enabled/.test(off), 'a router without OSPF says so');

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
