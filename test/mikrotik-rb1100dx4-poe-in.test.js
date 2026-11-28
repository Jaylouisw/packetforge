'use strict';
// The RB1100AHx4 Dude Edition is a 13-port rack router with one PoE inlet, on port 13:
//
//   https://mikrotik.com/product/RB1100Dx4
//     Number of DC inputs 2 (PoE-IN, 2-pin terminal); PoE in 802.3af/at;
//     PoE in input Voltage 20-57 V; Max power consumption 33 W (25 W without attachments).
//   https://help.mikrotik.com/docs/spaces/UM/pages/19136539/RB1100-series
//     "The device also accepts 12-57V passive or 802.3af/at PoE on Ethernet port 13."
//     "ETH13 port accepts PoE power, and can be used to boot the device from the network".
//
// The spec carried the `poe-pd` capability and nothing per-port, so isPoePd() put 12.95 W on
// all thirteen copper sockets: 168.35 W of demand on a box whose own maximum draw is 33 W, and
// twelve cables asked to power a router that only hears about power down the thirteenth. Other
// MikroTik rows record the inlet on eth1 because their table states a method but not a port;
// this sheet names the port, so the declaration follows the manual.

const path = require('path');
const { Topology, Simulator } = require('../engine');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  ✓ ' + msg); }
  else { failed++; console.error('  ✗ ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices')).filter(function (s) { return !s.error; });
const spec = catalog.find(function (s) { return s.vendor === 'mikrotik' && s.model === 'RB1100Dx4'; });
const MODEL = 'RB1100AHx4 Dude Edition';
const COPPER = ['rj45', 'combo'];
function copperPorts(dev) {
  return [...dev.interfaces.values()].map(function (i) { return i.hardware; })
    .filter(function (h) { return h && COPPER.indexOf(h.cage) !== -1; });
}
function drawing(dev) {
  return copperPorts(dev).filter(function (h) { return typeof h.poeIn === 'number' && h.poeIn > 0; });
}

console.log('The row is in the catalogue with the census the sheets print:');
ok(!!spec, 'mikrotik/RB1100Dx4 is in the catalogue');
if (!spec) { console.log(passed + ' passed, ' + failed + ' failed'); process.exit(1); }
ok(spec.label === MODEL, 'its label is the Dude Edition of the RB1100AHx4 (' + spec.label + ')');
ok(spec.interfaces.length === 13, 'thirteen interfaces, as the product page prints 13x 1G RJ45', String(spec.interfaces.length));
ok(spec.interfaces.every(function (i) { return i.type === 'ethernet' && i.speed === '1G'; }),
  'every one is a 1G Ethernet port');
ok(spec.interfaces.every(function (i) { return !i.poeOut; }), 'it declares no PSE port - it sources nothing');
ok(!spec.poe || spec.poe.budgetW == null, 'and no PoE budget');
ok(spec.capabilities.indexOf('poe-pd') !== -1, 'the poe-pd capability stays: the box really is a PD');
ok(spec.capabilities.indexOf('802.3at') !== -1 && spec.capabilities.indexOf('802.3af') !== -1,
  'and it still claims both 802.3af and 802.3at, which the product table prints as PoE in 802.3af/at');

console.log('');
console.log('One socket is the inlet and twelve say they are not:');
const named = spec.interfaces.filter(function (i) { return i.name === 'eth13'; });
ok(named.length === 1, 'eth13 exists');
ok(named.length === 1 && named[0].poeIn === 25.5,
  'eth13 declares 25.5 W - the 802.3at Type 2 ceiling, not the 12.95 W af default',
  String(named[0] && named[0].poeIn));
ok(named.length === 1 && typeof named[0].poeIn === 'number',
  'the inlet states watts as a number, not true (12.95 and 25.5 are different devices)');
const others = spec.interfaces.filter(function (i) { return i.name !== 'eth13'; });
ok(others.length === 12, 'twelve other copper sockets');
ok(others.every(function (i) { return i.poeIn === false; }),
  'all twelve declare poeIn: false - a claim, not the silence the guess refills');
ok(spec.interfaces.every(function (i) { return i.poeIn !== undefined && i.poeIn !== null; }),
  'no socket is left silent for isPoePd() to fill in');
ok(!!spec.sourceUrl && /^https:\/\//.test(spec.sourceUrl), 'the row names its source URL');
ok(/help\.mikrotik\.com/.test(String(spec.notes)), 'notes cite the hardware manual that names the port');
ok(/Ethernet port 13|ETH13/.test(String(spec.notes)), 'notes quote the manual naming port 13');
ok(/168\.35/.test(String(spec.notes)) && /25\.5/.test(String(spec.notes)),
  'notes record the old guess and the new draw');

console.log('');
console.log('The engine derives one inlet, not thirteen (it used to derive 168.35 W):');
const dev = new Topology().addDevice(spec);
ok(copperPorts(dev).length === 13, 'the engine sees thirteen copper ports', String(copperPorts(dev).length));
ok(drawing(dev).length === 1, 'exactly one of them draws power', String(drawing(dev).length));
ok(drawing(dev).length === 1 && drawing(dev)[0].poeIn === 25.5, 'and it draws 25.5 W',
  String(drawing(dev)[0] && drawing(dev)[0].poeIn));
const total = copperPorts(dev).reduce(function (a, h) { return a + (typeof h.poeIn === 'number' ? h.poeIn : 0); }, 0);
ok(Math.abs(total - 25.5) < 1e-9, 'the whole router asks for 25.5 W, down from 168.35 W', String(total));
ok(copperPorts(dev).filter(function (h) { return h.poeIn === 12.95; }).length === 0,
  'no port carries the inferred 12.95 W af figure any more');
ok(!dev.poeBudget, 'and it is still not a power source of its own', String(dev.poeBudget));

console.log('');
console.log('Cabled to a real PSE, the inlet costs what it says and the other sockets cost nothing:');
const pse = catalog.find(function (s) { return s.vendor === 'aruba' && s.model === 'CX 6000 24G CL4 PoE 4SFP 370W'; });
ok(!!pse, 'the Aruba 370 W reference PSE is in the catalogue');
if (pse) {
  const t = new Topology();
  const sw = t.addDevice(pse, 'sw1');
  t.addDevice(spec, 'r1');
  t.connect('r1', 'eth13', 'sw1', '1/1/1');
  const sim = new Simulator(t);
  sim.computePoe();
  const entry = sim.poe[0];
  ok(entry.used === 25.5, 'the PSE spends 25.5 W on the inlet (' + entry.used + ' W)');
  ok(entry.ports.find(function (p) { return p.iface === '1/1/1'; }).powered === true,
    'and that cable is powered');

  const t2 = new Topology();
  const sw2 = t2.addDevice(pse, 'sw2');
  t2.addDevice(spec, 'r2');
  t2.connect('r2', 'eth1', 'sw2', '1/1/2');
  const sim2 = new Simulator(t2);
  sim2.computePoe();
  ok(sim2.poe[0].used === 0, 'a cable into eth1 buys 0 W, because eth1 is not a PD (' + sim2.poe[0].used + ' W)');
  ok(sim2.poe[0].ports.every(function (p) { return !p.powered; }), 'and nothing on that cable is powered');

  const t3 = new Topology();
  const sw3 = t3.addDevice(pse, 'sw3');
  t3.addDevice(spec, 'r3');
  t3.addDevice(spec, 'r4');
  t3.connect('r3', 'eth13', 'sw3', '1/1/3');
  t3.connect('r4', 'eth13', 'sw3', '1/1/4');
  const sim3 = new Simulator(t3);
  sim3.computePoe();
  ok(sim3.poe[0].used === 51, 'two routers on two inlets spend 51 W of 370 (' + sim3.poe[0].used + ' W)');
  ok(sim3.poe[0].ports.filter(function (p) { return p.powered; }).length === 2, 'both are powered');
}

console.log('');
console.log('The non-Dude RB1100AHx4, same chassis, still draws nothing from the guess:');
const plain = catalog.find(function (s) { return s.vendor === 'mikrotik' && s.model === 'RB1100AHx4'; });
ok(!!plain, 'RB1100AHx4 is in the catalogue');
if (plain) {
  const d = new Topology().addDevice(plain);
  ok(drawing(d).length === 0, 'its thirteen sockets draw nothing - no poe-pd capability, no inlet stated',
    String(drawing(d).length));
  ok(copperPorts(d).length === 13, 'and it still has all thirteen copper ports', String(copperPorts(d).length));
}

console.log('');
console.log('The single-inlet pattern the rest of the MikroTik rows already follow is intact:');
const mt = catalog.filter(function (s) { return s.vendor === 'mikrotik'; });
const oneInlet = mt.filter(function (s) {
  const ins = (s.interfaces || []).filter(function (i) { return typeof i.poeIn === 'number' && i.poeIn > 0; });
  return ins.length === 1;
});
ok(oneInlet.length >= 10, 'at least ten MikroTik rows declare exactly one inlet (' + oneInlet.length + ')');
const sx = catalog.find(function (s) { return s.vendor === 'mikrotik' && s.model === 'RBSXTsqG-5acD'; });
ok(!!sx, 'RBSXTsqG-5acD is in the catalogue');
if (sx) {
  const p = sx.interfaces.find(function (i) { return i.name === 'eth1'; });
  ok(!!p && p.poeIn === 12.95, 'it still declares 12.95 W on eth1', String(p && p.poeIn));
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
if (failed) process.exitCode = 1;
