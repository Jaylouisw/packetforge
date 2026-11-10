'use strict';
// flow-vip.test.js — a flow and a ping must see the same network.
//
// `openFlow()` refreshed spanning tree, PoE, LLDP, RA, OSPF and BGP but not VRRP or
// DHCP. On a fresh simulator that made a flow to a first-hop-redundancy virtual IP
// fail with "no response" while a ping to the very same address succeeded: nothing
// had run the election, so no device owned the VIP and the SYN was never answered.
// The bug is invisible in a lab where something else ran first, because the VRRP
// state is sticky - which is why every case here starts from a fresh Simulator.
const path = require('path');
const { Topology, Simulator, runCommands } = require('../engine');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg); }
}
function eq(actual, expected, msg) {
  ok(actual === expected, msg + (actual === expected ? '' : ' (got ' + JSON.stringify(actual) +
    ', want ' + JSON.stringify(expected) + ')'));
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
function model(name) { return catalog.find(function (x) { return x.model === name; }); }

// Two routers sharing a VIP on the LAN, a host that uses it as its gateway. Port 22 is
// the port a router really listens on (`cli` capability), so a flow ending on the VIP
// is a flow ending on a real listener rather than an arbitrary port.
function build() {
  const topo = new Topology();
  const pc = topo.addDevice(model('generic-pc'));
  const r1 = topo.addDevice(model('generic-router'));
  const r2 = topo.addDevice(model('generic-router'));
  pc.name = 'PC1'; r1.name = 'R1'; r2.name = 'R2';
  topo.connect(pc.id, 'eth0', r1.id, 'Gi0/0');
  topo.connect(r1.id, 'Gi0/1', r2.id, 'Gi0/0');
  const sim = new Simulator(topo);
  function run(dev, cmds) { return runCommands(dev, topo, sim, cmds).lines; }
  run(pc, ['configure terminal', 'interface eth0', 'ip address 10.0.1.10 255.255.255.0',
    'exit', 'ip default-gateway 10.0.1.1', 'hostname PC1']);
  run(r1, ['configure terminal', 'interface Gi0/0', 'ip address 10.0.1.1 255.255.255.0',
    'vrrp 1 ip 10.0.1.100', 'vrrp 1 priority 200', 'exit',
    'interface Gi0/1', 'ip address 10.0.12.1 255.255.255.0', 'exit', 'hostname R1']);
  run(r2, ['configure terminal', 'interface Gi0/1', 'ip address 10.0.12.2 255.255.255.0',
    'vrrp 1 ip 10.0.1.100', 'vrrp 1 priority 100', 'exit', 'hostname R2']);
  return { topo: topo, sim: sim, run: run, pc: pc, r1: r1, r2: r2 };
}

console.log('A fresh simulator: ping and flow agree about a virtual IP:');
{
  const L = build();
  const ping = L.sim.ping(L.pc.id, '10.0.1.100', { count: 1 });
  ok(ping.replies[0].success, 'ping to the VIP answers (this always worked)');

  const flow = L.sim.openFlow({ proto: 'tcp', srcDevice: L.pc.id, dstIp: '10.0.1.100', dstPort: 22, bytes: 100 });
  eq(flow.ok, true, 'a flow to the same VIP now opens too - the election runs in openFlow()');
  eq(flow.flow.state, 'established', 'and completes its handshake');
}

console.log('\nThe election really is what makes it work:');
{
  const L = build();
  // Asking at t=0 is before three advertise intervals have passed, so nobody owns the VIP.
  const early = L.sim.openFlow({
    proto: 'tcp', srcDevice: L.pc.id, dstIp: '10.0.1.100', dstPort: 22, bytes: 100, atMs: 0
  });
  eq(early.ok, false, 'at t=0 the VIP is not owned yet, so the flow is refused');
  eq(early.code, 'E_UNREACHABLE', 'and the code says the address did not answer');

  const later = L.sim.openFlow({
    proto: 'tcp', srcDevice: L.pc.id, dstIp: '10.0.1.100', dstPort: 22, bytes: 100, atMs: 5000
  });
  eq(later.ok, true, 'by 5 s the election has finished and the same flow opens');
}

console.log('\nThe console names the pending election instead of shrugging:');
{
  const L = build();
  const lines = L.run(L.pc, ['enable', 'flow open 10.0.1.100 port 22 at 0'])
    .filter(function (l) { return !/^PC1[>#]/.test(l); });
  ok(/^% flow refused \(E_UNREACHABLE\): no response from 10\.0\.1\.100:22$/.test(lines[0]),
    'the refusal is reported with its code');
  ok(/^% yet: vrrp on (R1|R2) still converging \(ready at [\d.]+ ms\)/.test(lines[1]),
    'and the next line names vrrp and when it will be ready: ' + lines[1]);
  ok(/at <ms>/.test(lines[2]) && /at converged/.test(lines[2]), 'with both ways to ask differently');

  const good = L.run(L.pc, ['enable', 'flow open 10.0.1.100 port 22 at 5000'])
    .filter(function (l) { return !/^PC1[>#]/.test(l); });
  eq(good[0], 'Flow flow-2 opened: tcp 10.0.1.10:49152 -> 10.0.1.100:22, established  (at t=5000 ms)',
    'asking after the election opens the flow, and the header says which instant it answered at');
}

console.log('\nA flow to a real address on the same box is unaffected:');
{
  const L = build();
  const flow = L.sim.openFlow({ proto: 'tcp', srcDevice: L.pc.id, dstIp: '10.0.1.1', dstPort: 22, bytes: 100 });
  eq(flow.ok, true, 'the owning router\'s own address still answers - the fix did not break the plain case');
}

console.log('\nDHCP is in the same list, for the same reason:');
{
  // A client that gets its address by DHCP must be addressable by a flow without
  // something else having run the exchange first - computeDhcp() is now called for
  // the same reason computeVrrp() is.
  const topo = new Topology();
  const srv = topo.addDevice(model('generic-router'));
  const pc = topo.addDevice(model('generic-pc'));
  srv.name = 'R1'; pc.name = 'PC1';
  topo.connect(srv.id, 'Gi0/0', pc.id, 'eth0');
  const sim = new Simulator(topo);
  function run(dev, cmds) { return runCommands(dev, topo, sim, cmds).lines; }
  run(srv, ['configure terminal', 'interface Gi0/0', 'ip address 10.0.9.1 255.255.255.0', 'exit',
    'ip dhcp pool LAN', 'network 10.0.9.0 255.255.255.0', 'range 10.0.9.100 10.0.9.150',
    'default-router 10.0.9.1', 'exit', 'hostname R1']);
  run(pc, ['configure terminal', 'interface eth0', 'ip address dhcp', 'exit', 'hostname PC1']);

  const flow = sim.openFlow({ proto: 'tcp', srcDevice: pc.id, dstIp: '10.0.9.1', dstPort: 22, bytes: 100 });
  eq(flow.ok, true, 'a DHCP client can open a flow on the first call, with no prior run');
  ok(/^10\.0\.9\./.test(flow.flow.srcIp), 'using the address the exchange gave it (' + flow.flow.srcIp + ')');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
