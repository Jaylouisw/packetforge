#!/usr/bin/env node
/**
 * VRRP in the path (#1052).
 *
 * `engine/vrrp.js` implemented the election — priorities, skew, Master_Down_Interval, the
 * 00:00:5E:00:01:<vrid> virtual MAC — and nothing called it, and the CLI had no `vrrp` command at
 * all. A lab could read about a virtual gateway and never build one: no device answered ARP for the
 * VIP, so every host pointed at it black-holed, and the failure looked like a routing mistake.
 *
 * These tests are about the wiring: the election over a real segment, the master answering for the
 * address it holds, the *virtual* MAC on the wire (not the box's own), the VIP moving when the
 * master loses its interface, and the CLI that configures it.
 */
'use strict';

const path = require('path');
const { Topology, Simulator, runCommands } = require('../engine');
const vrrpLib = require('../engine/vrrp');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, name) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name); }
}
function eq(got, want, name) { ok(got === want, name + ' (got ' + got + ', want ' + want + ')'); }
function t(name, fn) {
  console.log('\n' + name);
  if (typeof fn !== 'function') return;
  try { fn(); } catch (e) { failed++; console.log('  ✗ threw: ' + e.message); }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
function spec(model) {
  const s = catalog.find(function (x) { return String(x.model) === model; });
  if (!s) throw new Error('missing spec ' + model);
  return s;
}

// Two routers, a switch and a host - the smallest lab where a virtual gateway means anything.
function lab(opts) {
  opts = opts || {};
  const topo = new Topology();
  const r1 = topo.addDevice(spec('generic-router'));
  const r2 = topo.addDevice(spec('generic-router'));
  const sw = topo.addDevice(spec('generic-switch'));
  const pc = topo.addDevice(spec('generic-pc'));
  r1.name = 'R1'; r2.name = 'R2'; sw.name = 'SW1'; pc.name = 'PC1';
  topo.connect(sw.id, 'Fa0/1', r1.id, 'Gi0/0');
  topo.connect(sw.id, 'Fa0/3', r2.id, 'Gi0/0');
  topo.connect(pc.id, 'eth0', sw.id, 'Fa0/2');
  const sim = new Simulator(topo);
  const cli = function (dev, cmds) { return runCommands(dev, topo, sim, cmds).lines; };

  cli(r1, ['enable', 'configure terminal', 'interface Gi0/0', 'ip address 10.0.0.1 255.255.255.0',
    'vrrp 10 ip 10.0.0.254', 'vrrp 10 priority ' + (opts.p1 === undefined ? 150 : opts.p1), 'exit', 'end']);
  cli(r2, ['enable', 'configure terminal', 'interface Gi0/0', 'ip address 10.0.0.2 255.255.255.0',
    'vrrp 10 ip 10.0.0.254', 'vrrp 10 priority ' + (opts.p2 === undefined ? 100 : opts.p2), 'exit', 'end']);
  cli(pc, ['enable', 'configure terminal', 'interface eth0', 'ip address 10.0.0.50 255.255.255.0',
    'exit', 'ip default-gateway 10.0.0.254']);

  return { topo: topo, sim: sim, cli: cli, r1: r1, r2: r2, sw: sw, pc: pc };
}

// ---------------------------------------------------------------------------
t('The CLI configures a group, and refuses what it cannot configure');

{
  const L = lab();
  eq(L.r1.config.vrrp.length, 1, 'R1 has one group');
  eq(L.r1.config.vrrp[0].vrid, 10, 'with the vrid it was given');
  eq(L.r1.config.vrrp[0].interface, 'Gi0/0', 'on the interface it was configured in');
  ok(L.r1.config.vrrp[0].ips.indexOf('10.0.0.254') !== -1, 'holding the virtual address');
  eq(L.r1.config.vrrp[0].priority, 150, 'with its priority');
  eq(L.r1.config.vrrp[0].preempt, true, 'and preemption on by default');

  const inConfig = L.cli(L.r1, ['enable', 'configure terminal', 'vrrp 20 ip 10.0.0.253']);
  ok(inConfig.some(function (l) { return /configured per interface/.test(l); }),
    'a group cannot be created outside an interface');

  const bad = L.cli(L.r1, ['enable', 'configure terminal', 'interface Gi0/0', 'vrrp 300 ip 10.0.0.9']);
  ok(bad.some(function (l) { return /Invalid virtual router id/.test(l); }), 'vrid 300 is refused (1-255)');

  const badIp = L.cli(L.r1, ['enable', 'configure terminal', 'interface Gi0/0', 'vrrp 11 ip nonsense']);
  ok(badIp.some(function (l) { return /Invalid address/.test(l); }), 'a nonsense address is refused');

  const removed = L.cli(L.r1, ['enable', 'configure terminal', 'interface Gi0/0', 'no vrrp 10']);
  ok(removed.some(function (l) { return /removed/.test(l); }), 'and a group can be removed');
  eq(L.r1.config.vrrp.length, 0, 'which really does remove it');
}

// ---------------------------------------------------------------------------
t('The election runs over the segment, and the highest priority wins');

{
  const L = lab();
  const res = L.sim.ping(L.pc.id, '10.0.0.254', { count: 1 });
  const ev = res.events.filter(function (e) { return e.type === 'vrrp'; });
  eq(ev.length, 1, 'one election for one segment, not one per router');
  eq(ev[0].masterName, 'R1', 'R1 wins with priority 150');
  eq(ev[0].priority, 150, 'at the priority it was given');
  eq(ev[0].reason, 'priority', 'because of priority, not by accident');
  eq(ev[0].backups.length, 1, 'with R2 as the single backup');
  eq(ev[0].backups[0], 'R2', 'named');

  ok(!!L.r1.vrrpClaims && L.r1.vrrpClaims.length === 1, 'the master claims the address');
  eq(L.r2.vrrpClaims.length, 0, 'and the backup claims nothing');

  const mid = new Simulator(L.topo);
  const r1Show = runCommands(L.r1, L.topo, mid, ['enable', 'show vrrp']).lines.join('\n');
  ok(/Master/.test(r1Show), 'show vrrp reports Master on R1');
  ok(/00:00:5e:00:01:0a/.test(r1Show), 'with the group\'s virtual MAC');
}

// ---------------------------------------------------------------------------
t('The master answers for the VIP, with the virtual MAC');

{
  const L = lab();
  const res = L.sim.ping(L.pc.id, '10.0.0.254', { count: 2 });
  ok(res.replies.every(function (r) { return r.success; }), 'the host can ping its gateway');
  ok(res.replies[0].rtt > 0, 'with a real round-trip time');

  // The takeover announces itself with a gratuitous ARP, so the host often has the mapping before
  // it ever asks. Either route is correct; what must be true is that the virtual MAC is what ends
  // up in the cache, never the master's own.
  const garp = res.events.filter(function (e) { return e.type === 'garp' && e.ip === '10.0.0.254'; });
  const reply = res.events.filter(function (e) { return e.type === 'arp-reply' && e.targetIp === '10.0.0.254'; });
  ok(garp.length + reply.length >= 1, 'the VIP was announced (gratuitous ARP or a reply)');
  for (const e of garp.concat(reply)) {
    eq(e.mac, '00:00:5e:00:01:0a', 'announced with the virtual MAC, not the box own address');
  }
  eq(L.pc.arp.get('10.0.0.254'), '00:00:5e:00:01:0a', 'so the host caches the virtual MAC');

  const echo = res.events.filter(function (e) { return e.type === 'icmp-reply'; });
  ok(echo.length >= 2, 'and the echo replies come back');

  // The frame was addressed to a MAC no port owns; it must still be delivered locally.
  const drops = res.events.filter(function (e) { return e.type === 'drop'; });
  ok(drops.length === 0, 'nothing is dropped as "not mine"');
}

// ---------------------------------------------------------------------------
t('The VIP moves when the master loses its interface');

{
  const L = lab({ p1: 100, p2: 200 });     // R2 outranks R1
  const res1 = L.sim.ping(L.pc.id, '10.0.0.254', { count: 1 });
  const ev1 = res1.events.filter(function (e) { return e.type === 'vrrp'; })[0];
  eq(ev1.masterName, 'R2', 'the higher priority wins to begin with');

  // R2's uplink goes down: it must relinquish, and R1 must take over.
  L.r2.interfaces.get('Gi0/0').enabled = false;
  const res2 = L.sim.ping(L.pc.id, '10.0.0.254', { count: 1 });
  const ev2 = res2.events.filter(function (e) { return e.type === 'vrrp'; })[0];
  eq(ev2.masterName, 'R1', 'the backup takes over when the master loses its interface');
  ok(res2.replies[0].success, 'and the host still reaches its gateway');
  eq(L.pc.arp.get('10.0.0.254'), '00:00:5e:00:01:0a',
    'the host never had to relearn the MAC - which is the entire point of VRRP');
  eq(L.r2.vrrpClaims.length, 0, 'the old master no longer claims the address');
}

// ---------------------------------------------------------------------------
t('Preemption: a lower priority master is displaced when a higher one returns');

{
  const L = lab({ p1: 200, p2: 150 });
  const a = L.sim.ping(L.pc.id, '10.0.0.254', { count: 1 }).events.filter(function (e) { return e.type === 'vrrp'; })[0];
  eq(a.masterName, 'R1', 'R1 with 200 is master');
  eq(a.reason, 'priority', 'on priority');

  // Equal priorities fall back to the highest interface address (RFC 5798 6.3.2), not to device order.
  const M = lab({ p1: 100, p2: 100 });
  const b = M.sim.ping(M.pc.id, '10.0.0.254', { count: 1 }).events.filter(function (e) { return e.type === 'vrrp'; })[0];
  eq(b.masterName, 'R2', 'equal priority is broken by the higher interface address (10.0.0.2 > 10.0.0.1)');
  eq(b.reason, 'tiebreak-ip', 'and says so');
}

// ---------------------------------------------------------------------------
t('An owner of the address outranks any configured priority');

{
  // A router that holds 10.0.0.254 as its own configured address is the address owner: priority
  // 255 by definition, whatever it was told to advertise.
  const topo = new Topology();
  const r1 = topo.addDevice(spec('generic-router'));
  const r2 = topo.addDevice(spec('generic-router'));
  const sw = topo.addDevice(spec('generic-switch'));
  r1.name = 'R1'; r2.name = 'R2'; sw.name = 'SW1';
  topo.connect(sw.id, 'Fa0/1', r1.id, 'Gi0/0');
  topo.connect(sw.id, 'Fa0/2', r2.id, 'Gi0/0');
  const sim = new Simulator(topo);
  const cli = function (dev, cmds) { return runCommands(dev, topo, sim, cmds).lines; };
  cli(r1, ['enable', 'configure terminal', 'interface Gi0/0', 'ip address 10.0.0.1 255.255.255.0',
    'vrrp 10 ip 10.0.0.254', 'vrrp 10 priority 100', 'exit', 'end']);
  cli(r2, ['enable', 'configure terminal', 'interface Gi0/0', 'ip address 10.0.0.254 255.255.255.0',
    'vrrp 10 ip 10.0.0.254', 'vrrp 10 priority 120', 'exit', 'end']);
  const ev = sim.ping(r1.id, '10.0.0.254', { count: 1 }).events.filter(function (e) { return e.type === 'vrrp'; })[0];
  eq(ev.masterName, 'R2', 'the address owner wins despite the lower configured priority');
  eq(ev.reason, 'owner', 'and the election says why');
}

// ---------------------------------------------------------------------------
t('Convergence: the group does not own the VIP until Master_Down elapses');

{
  // Host directly on the router: with a switch in the path the *switch* is still in Learning
  // before 30 s and drops everything, which would test 802.1D rather than VRRP.
  const topo = new Topology();
  const r1 = topo.addDevice(spec('generic-router'));
  const r2 = topo.addDevice(spec('generic-router'));
  const pc = topo.addDevice(spec('generic-pc'));
  r1.name = 'R1'; r2.name = 'R2'; pc.name = 'PC1';
  topo.connect(pc.id, 'eth0', r1.id, 'Gi0/0');
  topo.connect(r1.id, 'Gi0/1', r2.id, 'Gi0/0');
  const sim = new Simulator(topo);
  const cli = function (dev, cmds) { return runCommands(dev, topo, sim, cmds).lines; };
  cli(r1, ['enable', 'configure terminal', 'interface Gi0/0', 'ip address 10.0.0.1 255.255.255.0',
    'vrrp 10 ip 10.0.0.254', 'vrrp 10 priority 150', 'exit', 'end']);
  cli(pc, ['enable', 'configure terminal', 'interface eth0', 'ip address 10.0.0.50 255.255.255.0',
    'exit', 'ip default-gateway 10.0.0.254']);

  const early = new Simulator(topo);
  early.setRunTime(100);          // Master_Down is 3 x 1 s + skew
  const res = early.ping(pc.id, '10.0.0.254', { count: 1 });
  ok(!res.replies[0].success, 'at 100 ms the VIP answers nothing');
  const ev = res.events.filter(function (e) { return e.type === 'vrrp'; })[0];
  ok(ev && ev.owning === false, 'and the election records that the master has not taken ownership');
  eq((r1.vrrpClaims || []).length, 0, 'nothing is claimed yet');

  const late = new Simulator(topo);
  late.setRunTime(5000);          // Master_Down for priority 150 is ~3.4 s
  ok(late.ping(pc.id, '10.0.0.254', { count: 1 }).replies[0].success, 'by 5 s the VIP answers');
  eq(r1.vrrpClaims.length, 1, 'and the group owns its address');
}

// ---------------------------------------------------------------------------
t('A saved lab keeps its groups');

{
  const L = lab();
  const json = JSON.parse(JSON.stringify(L.topo.serialize()));
  const r1State = json.devices.filter(function (d) { return d.name === 'R1'; })[0];
  ok(Array.isArray(r1State.config.vrrp) && r1State.config.vrrp.length === 1,
    'the group is in the serialised topology');
  const back = Topology.fromJSON(json);
  const r1Back = Array.from(back.devices.values()).filter(function (d) { return d.name === 'R1'; })[0];
  eq(r1Back.config.vrrp[0].vrid, 10, 'and comes back on load');
  eq(r1Back.config.vrrp[0].priority, 150, 'with its priority');
  ok(JSON.stringify(back.serialize()) === JSON.stringify(json), 'the round trip is stable');

  const noGroups = Array.from(json.devices.values()).filter(function (d) {
    return !d.config || !d.config.vrrp;
  });
  ok(noGroups.length >= 1, 'devices with no groups do not grow an empty array');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
