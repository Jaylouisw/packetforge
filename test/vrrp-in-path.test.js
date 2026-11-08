'use strict';
// VRRP in the data path: a virtual gateway has to actually answer.
//
// engine/vrrp.js has modelled the election, the virtual MAC and the skew timer since it was
// written, was exported from the engine API, and was tested in isolation. Nothing called it.
// A lab could configure a virtual gateway on two routers, point every host at it, and get a
// black hole: no device owned the address, so no ARP reply ever came back and every ping
// failed with no explanation. That is the same shape of defect DHCP had.
//
// What is locked here:
//   1. a virtual address is reachable even though no interface holds it;
//   2. it answers ARP with the VRRP virtual MAC, never the interface's - a host caches that
//      binding, and a physical MAC would send its next packet to a router that lost the group;
//   3. the highest priority wins, a tie breaks on the higher address, and the owner of the
//      address wins outright at 255;
//   4. only the master answers; the backup stays silent;
//   5. when the master's interface goes down the backup takes the group and the gateway
//      keeps working - including the gratuitous ARP that moves the virtual MAC in the
//      switch's table;
//   6. bring the master back and it takes the group again;
//   7. the group survives save/load and still elects afterwards.
//
// The election is computed at the start of a run rather than carried as adverts, the same
// approximation OSPF, BGP and STP already make. There is no master-down timer counted in
// real time; an interface that is down before the run simply does not compete.
const path = require('path');
const { Topology, Simulator, runCommands } = require('../engine');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.log('  \u2717 ' + msg); }
}
function eq(actual, expected, msg) {
  ok(actual === expected, msg + ' (expected ' + JSON.stringify(expected) +
    ', got ' + JSON.stringify(actual) + ')');
}
function section(name) { console.log('\n' + name); }

const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
function spec(model) { return catalog.find(function (x) { return x.model === model; }); }
function cfg(dev, cmds, topo, sim) {
  return runCommands(dev, topo, sim, ['enable', 'configure terminal'].concat(cmds));
}

// Two routers and a host on one switch: the classic first-hop redundancy lab.
function bench() {
  const topo = new Topology();
  const sw = topo.addDevice(spec('generic-switch'));
  const r1 = topo.addDevice(spec('generic-router'));
  const r2 = topo.addDevice(spec('generic-router'));
  const pc = topo.addDevice(spec('generic-pc'));
  topo.connect(r1.id, 'Gi0/0', sw.id, 'Fa0/1');
  topo.connect(r2.id, 'Gi0/0', sw.id, 'Fa0/2');
  topo.connect(pc.id, 'eth0', sw.id, 'Fa0/3');
  const sim = new Simulator(topo);
  return { topo: topo, sw: sw, r1: r1, r2: r2, pc: pc, sim: sim };
}
const VIP = '192.168.1.254';

function setupVrrp(b, prio1, prio2) {
  const a = ['interface Gi0/0', 'ip address 192.168.1.1 255.255.255.0', 'vrrp 10 ip ' + VIP];
  if (prio1 !== undefined) a.push('vrrp 10 priority ' + prio1);
  a.push('exit');
  cfg(b.r1, a, b.topo, b.sim);

  const c = ['interface Gi0/0', 'ip address 192.168.1.2 255.255.255.0', 'vrrp 10 ip ' + VIP];
  if (prio2 !== undefined) c.push('vrrp 10 priority ' + prio2);
  c.push('exit');
  cfg(b.r2, c, b.topo, b.sim);

  cfg(b.pc, ['interface eth0', 'ip address 192.168.1.10 255.255.255.0',
    'ip default-gateway ' + VIP, 'exit'], b.topo, b.sim);
}
function masterOf(sim) {
  const ev = sim.events.filter(function (e) { return e.type === 'vrrp-master'; })[0];
  return ev || null;
}

section('1. The virtual address is reachable although no interface holds it');
{
  const b = bench();
  setupVrrp(b, 110, 100);
  eq(b.r1.interfaces.get('Gi0/0').ip, '192.168.1.1', 'R1 holds .1, not the VIP');
  eq(b.r2.interfaces.get('Gi0/0').ip, '192.168.1.2', 'R2 holds .2, not the VIP');

  const ping = b.sim.ping(b.pc.id, VIP, { count: 1 });
  ok(ping.success, 'the host can ping the virtual gateway');
}

section('2. It answers ARP with the virtual MAC, not the interface MAC');
{
  const b = bench();
  setupVrrp(b, 110, 100);
  b.sim.ping(b.pc.id, VIP, { count: 1 });

  // The master announces the binding itself with a gratuitous ARP, so by the time the host
  // sends, its cache already holds the virtual MAC and no request/reply round is needed.
  // What matters is the binding the host ends up with.
  const learned = b.pc.arp.get(VIP);
  eq(learned, '00:00:5e:00:01:0a', 'the host binds the VIP to the group-10 virtual MAC');

  const physical = [b.r1, b.r2].map(function (r) {
    return r.interfaces.get('Gi0/0').mac;
  });
  ok(physical.indexOf(learned) === -1, 'and not to either router\'s physical MAC');

  const garp = b.sim.events.filter(function (e) {
    return e.type === 'vrrp-gratuitous-arp';
  })[0];
  ok(!!garp, 'the master announced itself');
  eq(garp.mac, '00:00:5e:00:01:0a', 'with the virtual MAC in the announcement');
}

section('3. The election: priority, then address, then ownership');
{
  const b = bench();
  setupVrrp(b, 110, 100);
  b.sim.computeVrrp();
  const m = masterOf(b.sim);
  eq(m.dev, b.r1.id, 'the higher priority wins');
  eq(m.reason, 'priority', 'and says so');
  eq(m.priority, 110, 'reporting the winner\'s own priority');
  eq(m.backups, 1, 'with one backup');

  // Equal priority: the higher address wins, deterministically.
  const b2 = bench();
  setupVrrp(b2, 100, 100);
  b2.sim.computeVrrp();
  const m2 = masterOf(b2.sim);
  eq(m2.dev, b2.r2.id, 'equal priority breaks to the higher address');
  eq(m2.reason, 'tiebreak-ip', 'and names the tiebreak');

  // The owner of the virtual address wins outright whatever its priority says.
  const b3 = bench();
  cfg(b3.r1, ['interface Gi0/0', 'ip address ' + VIP + ' 255.255.255.0',
    'vrrp 10 ip ' + VIP, 'vrrp 10 priority 1', 'exit'], b3.topo, b3.sim);
  cfg(b3.r2, ['interface Gi0/0', 'ip address 192.168.1.2 255.255.255.0',
    'vrrp 10 ip ' + VIP, 'vrrp 10 priority 200', 'exit'], b3.topo, b3.sim);
  b3.sim.computeVrrp();
  const m3 = masterOf(b3.sim);
  eq(m3.dev, b3.r1.id, 'the address owner wins at priority 255 despite priority 1');
  eq(m3.priority, 255, 'and is reported at 255');
}

section('4. Only the master answers; the backup stays silent');
{
  const b = bench();
  setupVrrp(b, 110, 100);
  b.sim.computeVrrp();
  ok(b.r1.ownsIpOn('Gi0/0', VIP), 'the master owns the virtual address');
  eq(b.r2.ownsIpOn('Gi0/0', VIP), null, 'the backup does not');
  eq(b.r2.vrrpMacFor(VIP), null, 'and has no virtual MAC to answer with');
}

section('5. Failover: the backup takes the group and the gateway keeps working');
{
  const b = bench();
  setupVrrp(b, 110, 100);
  ok(b.sim.ping(b.pc.id, VIP, { count: 1 }).success, 'reachable with R1 master');

  cfg(b.r1, ['interface Gi0/0', 'shutdown', 'exit'], b.topo, b.sim);
  const after = b.sim.ping(b.pc.id, VIP, { count: 1 });
  ok(after.success, 'still reachable after the master goes down');

  const m = masterOf(b.sim);
  eq(m.dev, b.r2.id, 'R2 is now master');
  ok(b.r2.ownsIpOn('Gi0/0', VIP), 'and owns the address');
  eq(b.r1.ownsIpOn('Gi0/0', VIP), null, 'while the failed router owns nothing');

  // The gratuitous ARP is what moves the virtual MAC in the switch's table. Without it the
  // address stays learned on the dead router's port and the failover above still fails.
  const garp = b.sim.events.filter(function (e) { return e.type === 'vrrp-gratuitous-arp'; });
  ok(garp.length > 0, 'the new master sends a gratuitous ARP');
  eq(garp[garp.length - 1].dev, b.r2.id, 'from the new master');
}

section('6. Bring the master back and it takes the group again');
{
  const b = bench();
  setupVrrp(b, 110, 100);
  b.sim.ping(b.pc.id, VIP, { count: 1 });
  cfg(b.r1, ['interface Gi0/0', 'shutdown', 'exit'], b.topo, b.sim);
  b.sim.ping(b.pc.id, VIP, { count: 1 });
  eq(masterOf(b.sim).dev, b.r2.id, 'R2 holds it while R1 is down');

  cfg(b.r1, ['interface Gi0/0', 'no shutdown', 'exit'], b.topo, b.sim);
  ok(b.sim.ping(b.pc.id, VIP, { count: 1 }).success, 'the gateway is reachable again');
  eq(masterOf(b.sim).dev, b.r1.id, 'and R1 has the group back');
}

section('7. No group configured means no virtual gateway (nothing is invented)');
{
  const b = bench();
  cfg(b.r1, ['interface Gi0/0', 'ip address 192.168.1.1 255.255.255.0', 'exit'], b.topo, b.sim);
  cfg(b.r2, ['interface Gi0/0', 'ip address 192.168.1.2 255.255.255.0', 'exit'], b.topo, b.sim);
  cfg(b.pc, ['interface eth0', 'ip address 192.168.1.10 255.255.255.0',
    'ip default-gateway ' + VIP, 'exit'], b.topo, b.sim);

  eq(b.r1.ownsIpOn('Gi0/0', VIP), null, 'nobody owns the unconfigured address');
  ok(!b.sim.ping(b.pc.id, VIP, { count: 1 }).success, 'and the ping fails, as it should');
}

section('8. The group survives save/load and still elects');
{
  const b = bench();
  setupVrrp(b, 110, 100);
  const saved = b.topo.serialize();
  const groups = saved.devices.map(function (d) {
    return ((d.config && d.config.vrrp) || []).length;
  }).reduce(function (a, c) { return a + c; }, 0);
  eq(groups, 2, 'both routers keep their group in the saved topology');

  const reloaded = Topology.fromJSON(saved);
  const sim2 = new Simulator(reloaded);
  sim2.computeVrrp();
  const m = sim2.events.filter(function (e) { return e.type === 'vrrp-master'; })[0];
  ok(!!m, 'the reloaded topology elects a master');
  eq(m.groupId, 10, 'for the same group');
  eq(m.backups, 1, 'with the other router as backup');
}

section('9. Routers that cannot hear each other never elect each other');
{
  // Two separate segments, one router each, both claiming the same group id.
  const topo = new Topology();
  const sw1 = topo.addDevice(spec('generic-switch'));
  const sw2 = topo.addDevice(spec('generic-switch'));
  const r1 = topo.addDevice(spec('generic-router'));
  const r2 = topo.addDevice(spec('generic-router'));
  topo.connect(r1.id, 'Gi0/0', sw1.id, 'Fa0/1');
  topo.connect(r2.id, 'Gi0/0', sw2.id, 'Fa0/1');
  const sim = new Simulator(topo);
  cfg(r1, ['interface Gi0/0', 'ip address 10.0.0.1 255.255.255.0',
    'vrrp 10 ip 10.0.0.254', 'vrrp 10 priority 110', 'exit'], topo, sim);
  cfg(r2, ['interface Gi0/0', 'ip address 10.0.1.1 255.255.255.0',
    'vrrp 10 ip 10.0.1.254', 'exit'], topo, sim);

  sim.computeVrrp();
  const masters = sim.events.filter(function (e) { return e.type === 'vrrp-master'; });
  eq(masters.length, 2, 'each segment elects its own master');
  ok(masters.every(function (m) { return m.backups === 0; }),
    'and each has no backup, because the other router is behind a router-less gap');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
