'use strict';
// The EdgeRouter 12 is a ten-port router with ONE PoE inlet, on port 0 (eth0):
//
//   https://dl.ui.com/qsg/ER-12/ER-12_EN.html
//     "Port 0 supports 24V Passive PoE In and port 9 supports optional Passive PoE Out
//      (disabled by default)."
//     Interfaces: "(10) 10/100/1000 RJ45 Ports  Port 0 Supports PoE IN; Port 9 Supports PoE Out"
//     PoE: "PoE In (1) 24V Passive PoE Port, 2-pair (4, 5+; 7, 8-)"
//          "Passive PoE Max. Wattage Per Port 20W (24V, 0.83A)"
//          "Max. Power Consumption 20W (Excludes PoE Output)"
//
//   https://techspecs.ui.com/uisp/wired/er-12 - same 20 W per-port ceiling and device draw.
//
// The spec carried the poe-pd capability and nothing per-port, so isPoePd() put 12.95 W on
// all ten copper sockets: 129.5 W of demand on a router whose own maximum draw is 20 W, and nine
// cables asked to power a box that only has an inlet on the first. The guide names the port, so
// the declaration follows the guide.

const path = require('path');
const { Topology, Simulator } = require('../engine');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices')).filter(function (s) { return !s.error; });
const spec = catalog.find(function (s) { return s.vendor === 'ubiquiti' && s.model === 'ER-12'; });
const COPPER = ['rj45', 'combo'];
function copperPorts(dev) {
  return [...dev.interfaces.values()].map(function (i) { return i.hardware; })
    .filter(function (h) { return h && COPPER.indexOf(h.cage) !== -1; });
}
function drawing(dev) {
  return copperPorts(dev).filter(function (h) { return typeof h.poeIn === 'number' && h.poeIn > 0; });
}

console.log('The row is in the catalogue with the census the guide prints:');
ok(!!spec, 'ubiquiti/ER-12 is in the catalogue');
if (!spec) { console.log(passed + ' passed, ' + failed + ' failed'); process.exit(1); }
ok(spec.label === 'EdgeRouter 12', 'its label is EdgeRouter 12 (' + spec.label + ')');
ok(spec.interfaces.length === 12, 'twelve interfaces: ten RJ45 plus two SFP', String(spec.interfaces.length));
ok(spec.interfaces.filter(function (i) { return i.type === 'ethernet' && i.speed === '1G'; }).length === 12,
  'every one is a 1G Ethernet port');
ok(spec.interfaces.filter(function (i) { return i.connector === 'rj45'; }).length === 10,
  'ten of them are RJ45');
ok(spec.interfaces.every(function (i) { return !i.poeOut; }),
  'it declares no PSE port - the port 9 passthrough is not modelled as one');
ok(!spec.poe || spec.poe.budgetW == null, 'and no PoE budget');
ok(spec.capabilities.indexOf('poe-pd') !== -1, 'the poe-pd capability stays: the box really is a PD');
ok(spec.capabilities.indexOf('passive-poe') !== -1, 'and passive-poe, because the inlet is 24V passive');

console.log('');
console.log('One socket is the inlet and nine say they are not:');
const named = spec.interfaces.filter(function (i) { return i.name === 'eth0'; });
ok(named.length === 1, 'eth0 exists');
ok(named.length === 1 && named[0].poeIn === 20,
  'eth0 declares 20 W - the stated per-port ceiling (24V, 0.83A) and the device draw, not 12.95 W',
  String(named[0] && named[0].poeIn));
ok(named.length === 1 && typeof named[0].poeIn === 'number',
  'the inlet states watts as a number, not true');
const others = spec.interfaces.filter(function (i) { return i.name !== 'eth0' && i.connector === 'rj45'; });
ok(others.length === 9, 'nine other copper sockets', String(others.length));
ok(others.every(function (i) { return i.poeIn === false; }),
  'all nine declare poeIn: false - a claim, not the silence the guess refills');
ok(spec.interfaces.filter(function (i) { return i.connector === 'rj45'; })
  .every(function (i) { return i.poeIn !== undefined && i.poeIn !== null; }),
  'no copper socket is left silent for isPoePd() to fill in');
ok(!!spec.sourceUrl && /^https:\/\//.test(spec.sourceUrl), 'the row names its source URL');
ok(/dl\.ui\.com\/qsg\/ER-12/.test(String(spec.notes)), 'notes cite the quick start guide that names port 0');
ok(/Port 0 supports 24V Passive PoE In/.test(String(spec.notes)),
  'notes quote the guide naming the inlet');
ok(/129\.5/.test(String(spec.notes)) && /20 W/.test(String(spec.notes)),
  'notes record the old guess (129.5 W) and the new draw (20 W)');

console.log('');
console.log('The engine derives one inlet, not ten (it used to derive 129.5 W):');
const dev = new Topology().addDevice(spec);
ok(copperPorts(dev).length === 10, 'the engine sees ten copper ports', String(copperPorts(dev).length));
ok(drawing(dev).length === 1, 'exactly one of them draws power', String(drawing(dev).length));
ok(drawing(dev).length === 1 && drawing(dev)[0].poeIn === 20, 'and it draws 20 W',
  String(drawing(dev)[0] && drawing(dev)[0].poeIn));
const total = copperPorts(dev).reduce(function (a, h) { return a + (typeof h.poeIn === 'number' ? h.poeIn : 0); }, 0);
ok(Math.abs(total - 20) < 1e-9, 'the whole router asks for 20 W, down from 129.5 W', String(total));
ok(copperPorts(dev).filter(function (h) { return h.poeIn === 12.95; }).length === 0,
  'no port carries the inferred 12.95 W af figure any more');
ok(!dev.poeBudget, 'and it is still not a power source of its own', String(dev.poeBudget));

console.log('');
console.log('Cabled to a real PSE, the inlet costs what it says and the other sockets cost nothing:');
const pse = catalog.find(function (s) { return s.vendor === 'aruba' && s.model === 'CX 6000 24G CL4 PoE 4SFP 370W'; });
ok(!!pse, 'the Aruba 370 W reference PSE is in the catalogue');
if (pse) {
  const t = new Topology();
  t.addDevice(pse, 'sw1');
  t.addDevice(spec, 'r1');
  t.connect('r1', 'eth0', 'sw1', '1/1/1');
  const sim = new Simulator(t);
  sim.computePoe();
  const entry = sim.poe[0];
  ok(entry.used === 20, 'the PSE spends 20 W on the inlet (' + entry.used + ' W)');
  ok(entry.ports.find(function (p) { return p.iface === '1/1/1'; }).powered === true,
    'and that cable is powered');

  const t2 = new Topology();
  t2.addDevice(pse, 'sw2');
  t2.addDevice(spec, 'r2');
  t2.connect('r2', 'eth1', 'sw2', '1/1/2');
  const sim2 = new Simulator(t2);
  sim2.computePoe();
  ok(sim2.poe[0].used === 0, 'a cable into eth1 buys 0 W, because eth1 is not a PD (' + sim2.poe[0].used + ' W)');
  ok(sim2.poe[0].ports.every(function (p) { return !p.powered; }), 'and nothing on that cable is powered');

  const t3 = new Topology();
  t3.addDevice(pse, 'sw3');
  t3.addDevice(spec, 'r3');
  t3.addDevice(spec, 'r4');
  t3.connect('r3', 'eth0', 'sw3', '1/1/3');
  t3.connect('r4', 'eth0', 'sw3', '1/1/4');
  const sim3 = new Simulator(t3);
  sim3.computePoe();
  ok(sim3.poe[0].used === 40, 'two routers on two inlets spend 40 W of 370 (' + sim3.poe[0].used + ' W)');
  ok(sim3.poe[0].ports.filter(function (p) { return p.powered; }).length === 2, 'both are powered');
}

console.log('');
console.log('The PoE-out sibling is unaffected, and the rest of the family keeps its shape:');
const p12 = catalog.find(function (s) { return s.vendor === 'ubiquiti' && s.model === 'ER-12P'; });
ok(!!p12, 'ER-12P is in the catalogue');
if (p12) {
  const d = new Topology().addDevice(p12);
  ok(drawing(d).length === 0, 'the 12P draws nothing: its ten ports are outputs, not inlets',
    String(drawing(d).length));
  ok(copperPorts(d).filter(function (h) { return h.poeOut; }).length === 10,
    'and it still sources on all ten', String(copperPorts(d).filter(function (h) { return h.poeOut; }).length));
}
const erx = catalog.find(function (s) { return s.vendor === 'ubiquiti' && s.model === 'ER-X'; });
ok(!!erx, 'ER-X is in the catalogue');
if (erx) {
  const ex = erx.interfaces.find(function (i) { return i.name === 'port1'; });
  ok(!!ex && ex.poeIn === 5, 'its inlet is still 5 W on port1', String(ex && ex.poeIn));
}
const ub = catalog.filter(function (s) { return s.vendor === 'ubiquiti'; });
const multi = ub.filter(function (s) {
  const ins = (s.interfaces || []).filter(function (i) { return typeof i.poeIn === 'number' && i.poeIn > 0; });
  return ins.length > 1;
});
ok(multi.every(function (s) { return s.model !== 'ER-12'; }), 'ER-12 is not a multi-inlet row');

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
if (failed) process.exitCode = 1;
