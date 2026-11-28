'use strict';
// Three UniFi switches the engine had been treating as powered devices.
//
// `isPoePd()` (engine/media.js) matches `unifi` in the model/label, so every copper port on a
// UniFi box that says nothing about PoE got a 12.95 W 802.3af draw. On the three non-PoE rows
// below that is a fiction the vendor's own sheet contradicts:
//
//   USW-Pro-48  https://dl.ui.com/ds/usw-pro-48_ds.pdf  (200, application/pdf, 447,392 B)
//               "Networking interface (48) GbE RJ45 ports / (4) 1/10G SFP+ ports",
//               "Power method Universal input, 100-240V AC, 50/60 Hz; USP RPS DC input,
//                11.5V DC, 5.22A", "Power supply AC/DC, internal, 60W", "Max. power consumption 60W".
//   USW-Pro-24  https://dl.ui.com/ds/usw-pro-24_ds.pdf  (200, application/pdf, 415,079 B)
//               "(24) GbE RJ45 ports / (2) 1/10G SFP+ ports", RPS DC input 11.5V DC, 2.61A,
//               "Power supply AC/DC, internal, 36W", "Max. power consumption 30W".
//   USW-48      https://dl.ui.com/ds/usw-48_ds.pdf      (200, application/pdf, 2,599,051 B)
//               "(48) 10/100/1000 Mbps Ethernet RJ45 Ports / (4) 1 Gbps SFP Ports",
//               "Power Method Universal AC Input: 100-240VAC, 50/60 Hz",
//               "Power Supply AC/DC, Internal, 60W", "Max. Power Consumption 40W".
//
// None of the three prints a PoE line, a class or a budget, and all three are powered from an
// internal AC supply with an RPS DC bus as backup. So each copper socket is `poeIn: false`.
// Before the correction they asked a PSE for 621.6 W + 310.8 W + 621.6 W over 120 cables.
const path = require('path');
const { Topology, Simulator } = require('../engine');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices')).filter(function (s) { return !s.error; });
function spec(model) {
  return catalog.find(function (s) { return s.vendor === 'ubiquiti' && s.model === model; });
}

const ROWS = [
  { model: 'USW-Pro-48', copper: 48, cages: 4 },
  { model: 'USW-Pro-24', copper: 24, cages: 2 },
  { model: 'USW-48', copper: 48, cages: 4 }
];

console.log('The rows are in the catalogue, with the port census their own datasheet prints:');
for (const r of ROWS) {
  const s = spec(r.model);
  ok(!!s, r.model + ' is in the catalogue');
  if (!s) continue;
  const copper = s.interfaces.filter(function (i) { return i.connector === 'rj45'; });
  const cages = s.interfaces.filter(function (i) { return /^sfp/.test(String(i.connector)); });
  ok(copper.length === r.copper, r.model + ' has ' + r.copper + ' RJ45 ports', String(copper.length));
  ok(cages.length === r.cages, r.model + ' has ' + r.cages + ' SFP ports', String(cages.length));
}

console.log('\nEvery copper socket says it is not a powered device:');
for (const r of ROWS) {
  const s = spec(r.model);
  if (!s) continue;
  const copper = s.interfaces.filter(function (i) { return i.connector === 'rj45'; });
  ok(copper.every(function (i) { return i.poeIn === false; }),
    r.model + ': all ' + copper.length + ' copper ports declare poeIn: false');
  ok(copper.every(function (i) { return i.poeOut === undefined || i.poeOut === false; }),
    r.model + ' declares no PSE port');
}

console.log('\nThe engine derives no draw from them (nothing is inferred back in):');
for (const r of ROWS) {
  const s = spec(r.model);
  if (!s) continue;
  const t = new Topology();
  const d = t.addDevice(s);
  const ports = [...d.interfaces.values()].map(function (i) { return i.hardware; })
    .filter(function (h) { return h && (h.cage === 'rj45' || h.cage === 'combo'); });
  const pd = ports.filter(function (h) { return h.poeIn !== null && h.poeIn !== undefined && h.poeIn !== false; });
  ok(ports.length === r.copper, r.model + ': the engine sees ' + r.copper + ' copper ports', String(ports.length));
  ok(pd.length === 0, r.model + ': zero ports draw power', String(pd.length));
}

console.log('\nA PSE that cables all three spends nothing:');
const PSE = 'CX 6000 24G CL4 PoE 4SFP 370W';
const pse = catalog.find(function (s) { return s.vendor === 'aruba' && s.model === PSE; });
ok(!!pse, 'the Aruba reference PSE is in the catalogue');
if (pse) {
  const t = new Topology();
  const sw = t.addDevice(pse);
  const ports = ['1/1/1', '1/1/2', '1/1/3'];
  let cabled = 0;
  ROWS.forEach(function (r, i) {
    const s = spec(r.model);
    if (!s) return;
    const d = t.addDevice(s);
    try { t.connect(d.id, 'eth0', sw.id, ports[i]); cabled++; }
    catch (e) { ok(false, r.model + ' cables to ' + ports[i], e.message); }
  });
  ok(cabled === 3, 'all three switches are cabled to the PSE');
  const sim = new Simulator(t);
  sim.computePoe();
  ok(sim.poe.length === 1, 'one PSE is accounted for');
  ok(sim.poe[0].used === 0, 'the PSE spends 0 W on them', String(sim.poe[0].used));
  ok(sim.poe[0].ports.every(function (p) { return !p.powered; }), 'no cable to them is powered');
}

console.log('\nA device that really is a PD still declares what it draws:');
const u6 = spec('U6-Pro');
ok(!!u6, 'U6-Pro is in the catalogue');
if (u6) {
  const decl = u6.interfaces.filter(function (i) { return typeof i.poeIn === 'number'; });
  ok(decl.length === 1 && decl[0].poeIn === 12.95, 'U6-Pro declares 12.95 W on ' + (decl[0] && decl[0].name));
  const t = new Topology();
  const sw = t.addDevice(catalog.find(function (s) { return s.vendor === 'aruba' && s.model === PSE; }));
  const ap = t.addDevice(u6);
  t.connect(ap.id, decl[0].name, sw.id, '1/1/1');
  const sim = new Simulator(t);
  sim.computePoe();
  ok(sim.poe[0].used === 12.95, 'and the PSE spends it (' + sim.poe[0].used + ' W)', String(sim.poe[0].used));
  ok(sim.poe[0].ports[0].powered === true, 'the AP is powered');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exitCode = 1;
