'use strict';
// Three more UniFi switches that are not powered devices: the non-PoE Pro Max family.
//
// `isPoePd()` (engine/media.js) matches `unifi` against `model + ' ' + label`, so every copper
// port of a UniFi box that says nothing about PoE got a 12.95 W 802.3af draw inferred onto it.
// On the three rows below that is a fiction the vendor's own spec table contradicts - and the
// table is the figure of record because Ubiquiti publishes the Pro Max PoE siblings separately,
// each with its own budget, so "no PoE row" here is a product decision, not a blank field:
//
//   USW-Pro-Max-48  https://techspecs.ui.com/unifi/switching/usw-pro-max-48
//               Port Layout 32x 1G RJ45 / 16x 2.5G RJ45 / 4x 10G SFP+, Max. Power Consumption
//               100W, Power Method (1) Universal input 100-240V AC + (1) USP RPS DC input,
//               Power Supply AC/DC internal 100W.    (PoE sibling: usw-pro-max-48-poe, 720 W)
//   USW-Pro-Max-24  https://techspecs.ui.com/unifi/switching/usw-pro-max-24
//               16x 1G RJ45 / 8x 2.5G RJ45 / 2x 10G SFP+, Max. Power Consumption 50W,
//               Power Supply AC/DC internal 60W.      (PoE sibling: usw-pro-max-24-poe, 400 W)
//   USW-Pro-Max-16  https://techspecs.ui.com/unifi/switching/usw-pro-max-16
//               12x 1G RJ45 / 4x 2.5G RJ45 / 2x 10G SFP+, Max. Power Consumption 25W,
//               Power Method AC/DC Adapter (included), Power Input USB Type-C 5V DC 5A,
//               Power Supply AC/DC external 25W.      (PoE sibling: USW-Pro-Max-16-PoE)
//
// None of the three prints a PoE line, a per-port wattage or a budget. Before the correction
// they asked a PSE for 621.6 W + 310.8 W + 207.2 W over 88 cables.
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

// The port layout is quoted from the same spec table as the PoE verdict, so the two cannot
// drift apart: a file that grows a port has to come back to the sheet.
const ROWS = [
  { model: 'USW-Pro-Max-48', g1: 32, g25: 16, cages: 4, watts: 621.6 },
  { model: 'USW-Pro-Max-24', g1: 16, g25: 8, cages: 2, watts: 310.8 },
  { model: 'USW-Pro-Max-16', g1: 12, g25: 4, cages: 2, watts: 207.2 }
];

console.log('The rows are in the catalogue, with the port census their own sheet prints:');
for (const r of ROWS) {
  const s = spec(r.model);
  ok(!!s, r.model + ' is in the catalogue');
  if (!s) continue;
  const copper = s.interfaces.filter(function (i) { return i.connector === 'rj45'; });
  const g1 = copper.filter(function (i) { return i.speed === '1G'; });
  const g25 = copper.filter(function (i) { return i.speed === '2.5G'; });
  const cages = s.interfaces.filter(function (i) { return /^sfp/.test(String(i.connector)); });
  ok(copper.length === r.g1 + r.g25, r.model + ' has ' + (r.g1 + r.g25) + ' RJ45 ports', String(copper.length));
  ok(g1.length === r.g1, r.model + ' has ' + r.g1 + ' GbE RJ45', String(g1.length));
  ok(g25.length === r.g25, r.model + ' has ' + r.g25 + ' 2.5G RJ45', String(g25.length));
  ok(cages.length === r.cages, r.model + ' has ' + r.cages + ' SFP+ cages', String(cages.length));
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
  ok(!s.poe || s.poe.budgetW == null, r.model + ' declares no PoE budget');
}

console.log('\nThe engine derives no draw from them (nothing is inferred back in):');
for (const r of ROWS) {
  const s = spec(r.model);
  if (!s) continue;
  const d = new Topology().addDevice(s);
  const ports = [...d.interfaces.values()].map(function (i) { return i.hardware; })
    .filter(function (h) { return h && (h.cage === 'rj45' || h.cage === 'combo'); });
  const pd = ports.filter(function (h) { return h.poeIn !== null && h.poeIn !== undefined && h.poeIn !== false; });
  ok(ports.length === r.g1 + r.g25, r.model + ': the engine sees ' + (r.g1 + r.g25) + ' copper ports', String(ports.length));
  ok(pd.length === 0, r.model + ': zero ports draw power', String(pd.length));
  ok(!d.poeBudget, r.model + ': source nothing of their own', String(d.poeBudget));
}

console.log('\nA PSE that cables all three spends nothing:');
const PSE_MODEL = 'CX 6000 24G CL4 PoE 4SFP 370W';
const refPse = catalog.find(function (s) { return s.vendor === 'aruba' && s.model === PSE_MODEL; });
ok(!!refPse, 'the Aruba reference PSE is in the catalogue');
if (refPse) {
  const t = new Topology();
  const sw = t.addDevice(refPse);
  const seats = ['1/1/1', '1/1/2', '1/1/3'];
  let cabled = 0;
  ROWS.forEach(function (r, i) {
    const s = spec(r.model);
    if (!s) return;
    const d = t.addDevice(s);
    try { t.connect(d.id, 'eth0', sw.id, seats[i]); cabled++; }
    catch (e) { ok(false, r.model + ' cables to ' + seats[i], e.message); }
  });
  ok(cabled === 3, 'all three switches are cabled to the PSE');
  const sim = new Simulator(t);
  sim.computePoe();
  ok(sim.poe.length === 1, 'one PSE is accounted for');
  ok(sim.poe[0].used === 0, 'the PSE spends 0 W on them (used to be 1,139.6 W)', String(sim.poe[0].used));
  ok(sim.poe[0].ports.every(function (p) { return !p.powered; }), 'no cable to them is powered');
}

console.log('\nThe PoE siblings are still powered devices with their own budgets:');
[
  { model: 'USW-Pro-Max-48-PoE', budget: 720 },
  { model: 'USW-Pro-Max-24-PoE', budget: 400 }
].forEach(function (r) {
  const s = spec(r.model);
  ok(!!s, r.model + ' is in the catalogue');
  if (!s) return;
  ok(!!s.poe && s.poe.budgetW === r.budget, r.model + ' still declares a ' + r.budget + ' W budget',
    String(s.poe && s.poe.budgetW));
  const sourcing = s.interfaces.filter(function (i) { return i.poeOut === true || (typeof i.poeOut === 'number' && i.poeOut > 0); });
  ok(sourcing.length > 0, r.model + ' still declares PSE ports', String(sourcing.length));
});

console.log('\nA device that really is a PD still declares what it draws:');
const u6 = spec('U6-Pro');
ok(!!u6, 'U6-Pro is in the catalogue');
if (u6 && refPse) {
  const decl = u6.interfaces.filter(function (i) { return typeof i.poeIn === 'number'; });
  ok(decl.length === 1 && decl[0].poeIn === 12.95, 'U6-Pro declares 12.95 W on ' + (decl[0] && decl[0].name));
  const t = new Topology();
  const sw = t.addDevice(refPse);
  const ap = t.addDevice(u6);
  t.connect(ap.id, decl[0].name, sw.id, '1/1/1');
  const sim = new Simulator(t);
  sim.computePoe();
  ok(sim.poe[0].used === 12.95, 'and the PSE spends it (' + sim.poe[0].used + ' W)', String(sim.poe[0].used));
  ok(sim.poe[0].ports[0].powered === true, 'the AP is powered');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exitCode = 1;
