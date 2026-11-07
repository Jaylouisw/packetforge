'use strict';
// engine.test.js — end-to-end tests of the simulation engine.
const path = require('path');
const { Topology, Simulator, runCommands } = require('../engine');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg); }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
function spec(vendor, model) {
  const s = catalog.find(function (x) { return x.vendor === vendor && x.model === model; });
  if (!s) throw new Error('spec not found: ' + vendor + '/' + model);
  return s;
}

console.log('catalog devices:', catalog.length);
ok(catalog.length >= 20, 'registry loaded >= 20 vendor device models');

// ---------- Scenario A: two PCs through a switch ----------
console.log('\nScenario A: PC -> switch -> PC (same subnet)');
{
  const t = new Topology();
  const pc1 = t.addDevice(spec('generic', 'generic-pc'));
  const pc2 = t.addDevice(spec('generic', 'generic-pc'));
  const sw = t.addDevice(spec('generic', 'generic-switch'));
  t.connect(pc1.id, 'eth0', sw.id, 'Fa0/1');
  t.connect(pc2.id, 'eth0', sw.id, 'Fa0/2');

  const sim = new Simulator(t);
  runCommands(pc1, t, sim, ['configure terminal', 'interface eth0', 'ip address 192.168.1.10 255.255.255.0']);
  runCommands(pc2, t, sim, ['configure terminal', 'interface eth0', 'ip address 192.168.1.20 255.255.255.0']);

  const res = sim.ping(pc1.id, '192.168.1.20', { count: 4 });
  ok(res.replies.every(function (r) { return r.success; }), 'all 4 pings succeed through the switch');
  ok(sw.macTable.size === 2, 'switch learned 2 MAC addresses');
  ok(sw.arp.size === 0, 'L2 switch does not populate an ARP table');
  ok(pc1.arp.has('192.168.1.20'), 'PC1 resolved PC2 MAC via ARP');
}

// ---------- Scenario B: router between two subnets ----------
console.log('\nScenario B: PC -> router -> PC (two subnets, static/gateway routing)');
{
  const t = new Topology();
  const pc1 = t.addDevice(spec('generic', 'generic-pc'));
  const pc2 = t.addDevice(spec('generic', 'generic-pc'));
  const r1 = t.addDevice(spec('generic', 'generic-router'));
  t.connect(pc1.id, 'eth0', r1.id, 'Gi0/0');
  t.connect(pc2.id, 'eth0', r1.id, 'Gi0/1');

  const sim = new Simulator(t);
  runCommands(pc1, t, sim, ['configure terminal', 'interface eth0', 'ip address 10.0.1.10 255.255.255.0', 'exit', 'ip default-gateway 10.0.1.1']);
  runCommands(pc2, t, sim, ['configure terminal', 'interface eth0', 'ip address 10.0.2.20 255.255.255.0', 'exit', 'ip default-gateway 10.0.2.1']);
  runCommands(r1, t, sim, ['configure terminal', 'interface Gi0/0', 'ip address 10.0.1.1 255.255.255.0', 'exit', 'interface Gi0/1', 'ip address 10.0.2.1 255.255.255.0']);

  const res = sim.ping(pc1.id, '10.0.2.20', { count: 4 });
  ok(res.replies.every(function (r) { return r.success; }), 'all 4 pings cross the router between subnets');
  ok(r1.arp.has('10.0.2.20'), 'router resolved far-host MAC via ARP');
  ok(pc1.arp.has('10.0.1.1'), 'PC1 resolved gateway MAC via ARP');
}

// ---------- Scenario C: unreachable host times out ----------
console.log('\nScenario C: unreachable destination times out');
{
  const t = new Topology();
  const pc1 = t.addDevice(spec('generic', 'generic-pc'));
  const pc2 = t.addDevice(spec('generic', 'generic-pc'));
  const sw = t.addDevice(spec('generic', 'generic-switch'));
  t.connect(pc1.id, 'eth0', sw.id, 'Fa0/1');
  t.connect(pc2.id, 'eth0', sw.id, 'Fa0/2');
  const sim = new Simulator(t);
  runCommands(pc1, t, sim, ['configure terminal', 'interface eth0', 'ip address 192.168.1.10 255.255.255.0']);
  runCommands(pc2, t, sim, ['configure terminal', 'interface eth0', 'ip address 192.168.1.20 255.255.255.0']);
  const res = sim.ping(pc1.id, '192.168.1.99', { count: 2 });
  ok(res.replies.every(function (r) { return !r.success; }), 'ping to non-existent IP times out');
}

// ---------- Scenario D: serialization round-trip ----------
console.log('\nScenario D: serialize / deserialize round-trip');
{
  const t = new Topology();
  const pc = t.addDevice(spec('generic', 'generic-pc'));
  const r = t.addDevice(spec('generic', 'generic-router'));
  t.connect(pc.id, 'eth0', r.id, 'Gi0/0');
  runCommands(pc, t, new Simulator(t), ['configure terminal', 'interface eth0', 'ip address 192.168.5.2 255.255.255.0', 'exit', 'ip default-gateway 192.168.5.1']);
  const json = t.serialize();
  const t2 = Topology.fromJSON(json);
  const pc2 = t2.getDevice(pc.id);
  ok(pc2 && pc2.interfaces.get('eth0').ip === '192.168.5.2', 'device config restored after load');
  ok(t2.links.size === 1, 'link restored after load');
  const r2 = t2.getDevice(r.id);
  ok(r2.interfaces.get('Gi0/0').peer, 'interface peer references restored after load');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
