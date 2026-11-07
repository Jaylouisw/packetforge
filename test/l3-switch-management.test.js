'use strict';
// Multilayer switch management addresses.
//
// A switch that can also route (l2-forward + l3-forward) must still answer for
// its own IP. It did not: an ARP request is a broadcast, so the check for "is
// this frame addressed to one of my MACs" was false, and the frame was bridged
// without ever being offered to the L3 path. Every L3 switch in the catalogue
// would route traffic for everyone else while its own management address was
// dead - you could build a whole lab through a switch and never ping the switch.
//
// The second half of the bug: a switch's address belongs to a VLAN, not to a
// cable. Pinning the reply to the port that holds the address sent it out of an
// empty socket whenever the peer was on a different port.
const path = require('path');
const { Topology, Simulator } = require('../engine');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg); }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
const pcSpec = {
  vendor: 'generic', model: 'generic-pc', label: 'PC', category: 'host',
  capabilities: ['host', 'cli'],
  interfaces: [{ name: 'eth0', type: 'ethernet', speed: '1G' }]
};

function buildSwitchLab(model) {
  const spec = catalog.find(function (s) {
    return s.vendor === 'aruba' && s.model === model;
  });
  const t = new Topology();
  const sw = t.addDevice(spec), a = t.addDevice(pcSpec), b = t.addDevice(pcSpec);
  sw.name = 'SW1'; a.name = 'PC-A'; b.name = 'PC-B';
  const rj45 = [...sw.interfaces.values()]
    .filter(function (i) { return i.hardware.cage === 'rj45'; })
    .map(function (i) { return i.name; });
  // The address sits on port 1; the hosts are on ports 2 and 3. This is the
  // arrangement that used to fail: peer and address on different ports.
  sw.interfaces.get(rj45[0]).ip = '10.9.9.1';
  sw.interfaces.get(rj45[0]).mask = '255.255.255.0';
  a.interfaces.get('eth0').ip = '10.9.9.10';
  a.interfaces.get('eth0').mask = '255.255.255.0';
  b.interfaces.get('eth0').ip = '10.9.9.11';
  b.interfaces.get('eth0').mask = '255.255.255.0';
  t.connect(a.id, 'eth0', sw.id, rj45[1]);
  t.connect(b.id, 'eth0', sw.id, rj45[2]);
  return { t: t, sw: sw, a: a, b: b };
}

console.log('A multilayer switch answers for its own address:');
{
  const lab = buildSwitchLab('2930F 24G 4SFP+');
  const sim = new Simulator(lab.t);
  const r = sim.ping(lab.a.id, '10.9.9.1', { count: 2 });
  ok(r.success, 'a host can ping the switch interface IP');
  ok(r.replies.length === 2, 'both echo requests are answered (' + r.replies.length + ')');
  ok(r.events.some(function (e) { return e.type === 'arp-reply' && e.dev === lab.sw.id; }),
    'the switch answered the ARP for its own address');
  ok(r.events.some(function (e) { return e.type === 'icmp-echo' && e.dev === lab.sw.id; }),
    'and the ICMP echo was terminated locally, not forwarded');
}

console.log('\nThe switch can originate traffic itself:');
{
  const lab = buildSwitchLab('2930F 24G 4SFP+');
  const sim = new Simulator(lab.t);
  const r = sim.ping(lab.sw.id, '10.9.9.10', { count: 2 });
  ok(r.success, 'the switch can ping a host on another port of the same VLAN');
}

console.log('\nBridging is unchanged - it is still a switch:');
{
  const lab = buildSwitchLab('2930F 24G 4SFP+');
  const sim = new Simulator(lab.t);
  const r = sim.ping(lab.a.id, '10.9.9.11', { count: 2 });
  ok(r.success, 'two hosts still reach each other through it');
  ok(r.events.some(function (e) { return e.type === 'switch'; }),
    'the frames were switched, not routed');
  // And it must not answer for an address it does not own.
  const other = sim.ping(lab.a.id, '10.9.9.99', { count: 1 });
  ok(!other.success, 'an address the switch does not own still gets no reply');
}

console.log('\nThe same is true of other multilayer platforms:');
{
  const models = ['2930F 48G PoE+ 4SFP+'];
  for (const m of models) {
    const lab = buildSwitchLab(m);
    const r = new Simulator(lab.t).ping(lab.a.id, '10.9.9.1', { count: 1 });
    ok(r.success, m + ' answers for its own IP');
  }
}

console.log('\nA plain router is unaffected:');
{
  const rtr = catalog.find(function (s) { return s.vendor === 'huawei' && s.model === 'AR2220'; });
  const t = new Topology();
  const r = t.addDevice(rtr), h = t.addDevice(pcSpec);
  r.name = 'R1'; h.name = 'PC1';
  r.interfaces.get('Gi0/0/1').ip = '10.0.0.1';
  r.interfaces.get('Gi0/0/1').mask = '255.255.255.0';
  h.interfaces.get('eth0').ip = '10.0.0.9';
  h.interfaces.get('eth0').mask = '255.255.255.0';
  t.connect(r.id, 'Gi0/0/1', h.id, 'eth0');
  const res = new Simulator(t).ping(h.id, '10.0.0.1', { count: 1 });
  ok(res.success, 'a router still answers on a routed port');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
