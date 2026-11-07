'use strict';
// l2.test.js -- VLANs, spanning tree and link aggregation in the live data path.
// These tests exercise the simulator end to end: tagging, per-VLAN learning,
// STP blocking and LAG member selection must all change real packet behaviour.
const path = require('path');
const { Topology, Simulator, runCommands } = require('../engine');
const { loadCatalog } = require('../devices/registry');
const vlan = require('../engine/vlan');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg); }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
function spec(v, m) {
  const s = catalog.find(function (x) { return x.vendor === v && x.model === m; });
  if (!s) throw new Error('spec not found: ' + v + '/' + m);
  return s;
}
function PC() { return spec('generic', 'generic-pc'); }
function SW() { return spec('generic', 'generic-switch'); }

function setIp(dev, topo, sim, addr, mask) {
  runCommands(dev, topo, sim, [
    'configure terminal', 'interface eth0',
    'ip address ' + addr + ' ' + (mask || '255.255.255.0')
  ]);
}
function allUp(replies) { return replies.every(function (r) { return r.success; }); }
function allDown(replies) { return replies.every(function (r) { return !r.success; }); }

// ---------- A: VLAN isolation on access ports ----------
console.log('Scenario A: access-port VLANs isolate broadcast domains');
{
  const t = new Topology();
  const pc1 = t.addDevice(PC());
  const pc2 = t.addDevice(PC());
  const sw = t.addDevice(SW());
  t.connect(pc1.id, 'eth0', sw.id, 'Fa0/1');
  t.connect(pc2.id, 'eth0', sw.id, 'Fa0/2');

  const sim = new Simulator(t);
  setIp(pc1, t, sim, '192.168.10.10');
  setIp(pc2, t, sim, '192.168.10.20');

  let r = sim.ping(pc1.id, '192.168.10.20', { count: 2 });
  ok(allUp(r.replies), 'default VLAN 1: same-subnet ping works');

  sw.interfaces.get('Fa0/1').vlan = vlan.normalizePortConfig({ accessVlan: 10 });
  sw.interfaces.get('Fa0/2').vlan = vlan.normalizePortConfig({ accessVlan: 20 });
  r = sim.ping(pc1.id, '192.168.10.20', { count: 2 });
  ok(allDown(r.replies), 'VLAN 10 vs VLAN 20: ping is blocked');

  sw.interfaces.get('Fa0/2').vlan = vlan.normalizePortConfig({ accessVlan: 10 });
  r = sim.ping(pc1.id, '192.168.10.20', { count: 2 });
  ok(allUp(r.replies), 'both ports moved to VLAN 10: ping works again');

  sw.macTable.clear();
  sw.macTables.clear();
  sim.ping(pc1.id, '192.168.10.20', { count: 1 });
  ok(sw.macTableFor(10).size === 2, 'VLAN 10 MAC table learned 2 addresses');
  ok(sw.macTable.size === 0, 'VLAN 1 MAC table stayed empty (VLANs are separate tables)');
}

// ---------- B: 802.1Q trunk between two switches ----------
console.log('\nScenario B: trunks tag frames and preserve VLAN separation');
{
  const t = new Topology();
  const pc1 = t.addDevice(PC());
  const pc2 = t.addDevice(PC());
  const sw1 = t.addDevice(SW());
  const sw2 = t.addDevice(SW());
  t.connect(pc1.id, 'eth0', sw1.id, 'Fa0/1');
  t.connect(sw1.id, 'Fa0/8', sw2.id, 'Fa0/8');
  t.connect(pc2.id, 'eth0', sw2.id, 'Fa0/1');

  sw1.interfaces.get('Fa0/8').vlan = vlan.normalizePortConfig({ mode: 'trunk', nativeVlan: 1, allowedVlans: 'all' });
  sw2.interfaces.get('Fa0/8').vlan = vlan.normalizePortConfig({ mode: 'trunk', nativeVlan: 1, allowedVlans: 'all' });
  sw1.interfaces.get('Fa0/1').vlan = vlan.normalizePortConfig({ accessVlan: 10 });
  sw2.interfaces.get('Fa0/1').vlan = vlan.normalizePortConfig({ accessVlan: 10 });

  const sim = new Simulator(t);
  setIp(pc1, t, sim, '192.168.10.10');
  setIp(pc2, t, sim, '192.168.10.20');

  const r = sim.ping(pc1.id, '192.168.10.20', { count: 2 });
  ok(allUp(r.replies), 'VLAN 10 crosses a trunk between two switches');

  const tagged = r.events.filter(function (e) {
    return e.type === 'frame' && e.frame && e.frame.wireTagged;
  }).length;
  ok(tagged > 0, 'frames on the trunk carry an 802.1Q tag (' + tagged + ' tagged frames)');

  const onAccess = r.events.filter(function (e) {
    return e.type === 'frame' && e.toIface === 'eth0' && e.frame && e.frame.wireTagged;
  }).length;
  ok(onAccess === 0, 'access ports deliver untagged frames to the host');

  // A port in VLAN 20 on the far switch must not reach the VLAN 10 host.
  sw2.interfaces.get('Fa0/1').vlan = vlan.normalizePortConfig({ accessVlan: 20 });
  const r2 = sim.ping(pc1.id, '192.168.10.20', { count: 2 });
  ok(allDown(r2.replies), 'VLAN 20 on the far switch cannot reach VLAN 10');
}

// ---------- C: spanning tree breaks a physical loop ----------
console.log('\nScenario C: STP blocks one port in a loop, traffic still flows');
{
  const t = new Topology();
  const sw1 = t.addDevice(SW());
  const sw2 = t.addDevice(SW());
  const sw3 = t.addDevice(SW());
  const pc1 = t.addDevice(PC());
  const pc2 = t.addDevice(PC());
  t.connect(sw1.id, 'Fa0/3', sw2.id, 'Fa0/3');
  t.connect(sw2.id, 'Fa0/4', sw3.id, 'Fa0/4');
  t.connect(sw3.id, 'Fa0/5', sw1.id, 'Fa0/5');
  t.connect(pc1.id, 'eth0', sw1.id, 'Fa0/1');
  t.connect(pc2.id, 'eth0', sw2.id, 'Fa0/1');

  const sim = new Simulator(t);
  setIp(pc1, t, sim, '192.168.10.10');
  setIp(pc2, t, sim, '192.168.10.20');

  sim.computeStp();
  const blocked = [sw1, sw2, sw3].reduce(function (n, s) { return n + s.stp.blocked.size; }, 0);
  ok(blocked === 1, 'exactly one port is blocked in a 3-switch triangle (got ' + blocked + ')');

  const r = sim.ping(pc1.id, '192.168.10.20', { count: 3 });
  ok(allUp(r.replies), 'ping still works once the loop is broken by STP');
  ok(r.events.some(function (e) { return e.type === 'stp-block'; }), 'a frame was dropped at an STP-blocked port');
  ok(r.events.length < 900, 'broadcasts do not storm the loop (event count ' + r.events.length + ')');
}

// ---------- D: LAG members carry traffic, STP does not half-block them ----------
console.log('\nScenario D: link aggregation');
{
  const t = new Topology();
  const sw1 = t.addDevice(SW());
  const sw2 = t.addDevice(SW());
  const pc1 = t.addDevice(PC());
  const pc2 = t.addDevice(PC());
  t.connect(pc1.id, 'eth0', sw1.id, 'Fa0/1');
  t.connect(sw1.id, 'Fa0/7', sw2.id, 'Fa0/7');
  t.connect(sw1.id, 'Fa0/8', sw2.id, 'Fa0/8');
  t.connect(pc2.id, 'eth0', sw2.id, 'Fa0/1');

  sw1.config.lags = { '1': { mode: 'active', hashPolicy: 'l2', members: ['Fa0/7', 'Fa0/8'] } };
  sw2.config.lags = { '1': { mode: 'active', hashPolicy: 'l2', members: ['Fa0/7', 'Fa0/8'] } };

  const sim = new Simulator(t);
  setIp(pc1, t, sim, '192.168.10.10');
  setIp(pc2, t, sim, '192.168.10.20');

  sim.computeStp();
  ok(sw1.stp.blocked.size === 0 && sw2.stp.blocked.size === 0,
    'LAG is treated as one logical port, so STP blocks no members');

  const r = sim.ping(pc1.id, '192.168.10.20', { count: 2 });
  ok(allUp(r.replies), 'ping works across a 2-member LAG');
  ok(r.events.some(function (e) { return e.type === 'lag'; }), 'a LAG member was selected for egress');
}

// ---------- E: CLI switchport / vlan / channel-group ----------
console.log('\nScenario E: switchport CLI');
{
  const t = new Topology();
  const sw = t.addDevice(SW());
  const sim = new Simulator(t);

  const cfg = runCommands(sw, t, sim, [
    'enable', 'configure terminal',
    'vlan 10 USERS',
    'interface Fa0/1', 'switchport mode access', 'switchport access vlan 10', 'exit',
    'interface Fa0/8', 'switchport mode trunk', 'switchport trunk native vlan 1',
    'switchport trunk allowed vlan 10,20', 'exit',
    'interface Fa0/7', 'channel-group 1 mode active', 'exit',
    'end', 'show running-config'
  ]).lines.join('\n');

  ok(/switchport access vlan 10/.test(cfg), 'CLI: access VLAN appears in running-config');
  ok(/switchport mode trunk/.test(cfg), 'CLI: trunk mode appears in running-config');
  ok(/switchport trunk allowed vlan 10,20/.test(cfg), 'CLI: allowed VLAN list appears in running-config');
  ok(/channel-group 1 mode active/.test(cfg), 'CLI: channel-group appears in running-config');
  ok(sw.interfaces.get('Fa0/1').vlan.accessVlan === 10, 'CLI: access VLAN applied to the port model');
  ok(sw.interfaces.get('Fa0/8').vlan.mode === 'trunk', 'CLI: trunk mode applied to the port model');
  ok(sw.config.lags && sw.config.lags['1'], 'CLI: LAG created on the device');

  const bad = runCommands(sw, t, sim, [
    'configure terminal', 'interface Fa0/2', 'switchport access vlan 9999'
  ]).lines.join('\n');
  ok(/outside 1-4094/.test(bad), 'CLI: out-of-range VLAN is rejected');

  const showVlan = runCommands(sw, t, sim, ['show vlan brief']).lines.join('\n');
  ok(/VLAN Name/.test(showVlan) && /Fa0\/1/.test(showVlan), 'CLI: show vlan brief lists member ports');

  const showStp = runCommands(sw, t, sim, ['show spanning-tree']).lines.join('\n');
  ok(/Spanning tree enabled/.test(showStp), 'CLI: show spanning-tree runs');

  const showEth = runCommands(sw, t, sim, ['show etherchannel summary']).lines.join('\n');
  ok(/Group/.test(showEth) && /Fa0\/7/.test(showEth), 'CLI: show etherchannel summary lists members');

  const showMac = runCommands(sw, t, sim, ['show mac address-table']).lines.join('\n');
  ok(/^Vlan/m.test(showMac), 'CLI: show mac address-table is VLAN-aware');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
