'use strict';
// Address ownership: one IP stack per routing device, one interface per scope.
//
// ownsIpOn() answers "will I serve this address on this interface". Delivery needs a
// different question first - "do I hold this address at all" - and the function conflated
// them. When a frame arrived addressed to an address the device held on ANOTHER interface,
// and no rule matched, it returned null: the frame was forwarded, the TTL decremented, and
// the packet died. A host could ping its gateway's near-side address and not its far-side
// one, on the same router, over the same cable.
//
// Worse, the fix has two halves and the second is easy to miss: once the router accepts the
// packet it has to send the reply back the way the request came. It replied out the
// interface that OWNS the address - a port with no cable - so the router answered and the
// host still saw silence. Both halves are locked here.
//
// What is locked:
//   1. a router holds and serves its own addresses on any of its ports;
//   2. the reply leaves by the port the request arrived on, not the port that owns it;
//   3. WAN/LAN role separation still outranks that (a LAN address is not served on a WAN
//      port - that is what NAT is for);
//   4. a pure L2 switch still does not answer an address across VLANs;
//   5. a tagged subinterface still replies tagged, from the subinterface;
//   6. a bridge group still answers on any port in the group.
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

section('1. A router holds its own addresses on every port');
{
  const topo = new Topology();
  const r = topo.addDevice(spec('generic-router'));
  cfg(r, ['interface Gi0/0', 'ip address 10.0.1.254 255.255.255.0', 'exit',
    'interface Gi0/1', 'ip address 10.0.2.1 255.255.255.0', 'exit'], topo, new Simulator(topo));

  eq(r.holdsIp('10.0.2.1') && r.holdsIp('10.0.2.1').name, 'Gi0/1', 'it holds the far-side address');
  ok(!r.holdsIp('10.0.9.9'), 'and does not hold an address it was never given');

  ok(!!r.ownsIpOn('Gi0/0', '10.0.2.1'),
    'and serves it on a port that does not own it - one IP stack, one device');
  ok(!!r.ownsIpOn('Gi0/1', '10.0.2.1'), 'as well as on the port that does');
  ok(!!r.ownsIpOn('Gi0/0', '10.0.1.254'), 'and the near-side address still works');
}

section('2. The ping that used to fail, and the port the reply leaves by');
{
  const topo = new Topology();
  const pc = topo.addDevice(spec('generic-pc'));
  const r = topo.addDevice(spec('generic-router'));
  topo.connect(pc.id, 'eth0', r.id, 'Gi0/0');
  const sim = new Simulator(topo);
  cfg(pc, ['interface eth0', 'ip address 10.0.1.1 255.255.255.0', 'exit',
    'ip default-gateway 10.0.1.254', 'exit'], topo, sim);
  cfg(r, ['interface Gi0/0', 'ip address 10.0.1.254 255.255.255.0', 'exit',
    'interface Gi0/1', 'ip address 10.0.2.1 255.255.255.0', 'exit'], topo, sim);

  const near = sim.ping(pc.id, '10.0.1.254', { count: 1 });
  ok(near.success, 'the near-side address answers');
  const far = sim.ping(pc.id, '10.0.2.1', { count: 1 });
  ok(far.success, 'and so does the far-side address, over the same cable');

  // The reply must leave the way the request came, or the router answers into a dead port.
  const reply = sim.events.filter(function (e) { return e.type === 'icmp-reply'; }).pop();
  ok(!!reply, 'the router replied');
  eq(reply.iface, 'Gi0/0', 'out of the port the request arrived on');
  eq(reply.to, '10.0.1.1', 'addressed back to the host');
}

section('3. WAN and LAN stay separate - the rule the fix must not swallow');
{
  const topo = new Topology();
  const r = topo.addDevice(spec('RT-AX89X'));
  const sim = new Simulator(topo);
  const wan = [...r.interfaces.values()].filter(function (i) { return i.role === 'wan'; })[0];
  const lan = [...r.interfaces.values()].filter(function (i) {
    return i.role === 'lan' && i.bridgeGroup === 'lan';
  })[0];
  ok(!!wan && !!lan, 'the router has a WAN port and LAN ports');

  cfg(r, ['interface ' + lan.name, 'ip address 192.168.1.1 255.255.255.0', 'exit'], topo, sim);
  eq(r.ownsIpOn(wan.name, '192.168.1.1'), null,
    'the WAN port does not serve the LAN address, whatever stack ownership says');
  ok(!!r.ownsIpOn(lan.name, '192.168.1.1'), 'the LAN port does');
}

section('4. A pure L2 switch still does not answer across VLANs');
{
  const topo = new Topology();
  const sw = topo.addDevice(spec('generic-switch'));
  ok(sw.isL2(), 'the generic switch is an L2 device');
  ok(!sw.hasCap('route'), 'and does not route');

  const ports = [...sw.interfaces.values()];
  const a = ports[0];
  const b = ports[1];
  a.ip = '10.0.10.1';
  a.mask = '255.255.255.0';
  a.vlan = { mode: 'access', accessVlan: 20 };
  b.vlan = { mode: 'access', accessVlan: 10 };

  eq(sw.ownsIpOn(a.name, '10.0.10.1').name, a.name, 'a port in the address\'s own VLAN serves it');

  const c = ports[2];
  c.vlan = { mode: 'access', accessVlan: 20 };
  ok(!!sw.ownsIpOn(c.name, '10.0.10.1'), 'so does another port in that VLAN');
  eq(sw.ownsIpOn(b.name, '10.0.10.1'), null,
    'but a port in a different VLAN does not - stack ownership is not an excuse to cross it');
}

section('5. A tagged subinterface replies tagged, from the subinterface');
{
  const topo = new Topology();
  const r = topo.addDevice(spec('generic-router'));
  const sim = new Simulator(topo);
  cfg(r, ['interface Gi0/0', 'no shutdown', 'exit',
    'interface Gi0/0.10', 'encapsulation dot1q 10', 'ip address 10.0.10.254 255.255.255.0',
    'exit'], topo, sim);

  const sub = r.interfaces.get('Gi0/0.10');
  ok(!!sub, 'the subinterface exists');
  eq(sub.parent, 'Gi0/0', 'and hangs off the parent port');
  ok(!!r.ownsIpOn('Gi0/0.10', '10.0.10.254'), 'it owns its address');
  // The frame arrives on the parent (tagged); the reply has to be tagged too, so the
  // subinterface sends it rather than the untagged parent port.
  ok(!!r.ownsIpOn('Gi0/0', '10.0.10.254'),
    'the parent port delivers frames for it, because tagged frames arrive there');
}

section('6. A bridge group answers on any of its ports');
{
  const topo = new Topology();
  const r = topo.addDevice(spec('RT-AX89X'));
  const sim = new Simulator(topo);
  const lan = [...r.interfaces.values()].filter(function (i) {
    return i.role === 'lan' && i.bridgeGroup === 'lan';
  });
  ok(lan.length > 1, 'the router has several ports in one bridge group');
  cfg(r, ['interface ' + lan[0].name, 'ip address 192.168.1.1 255.255.255.0', 'exit'], topo, sim);
  ok(!!r.ownsIpOn(lan[1].name, '192.168.1.1'),
    'a sibling port in the group reaches the address');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
