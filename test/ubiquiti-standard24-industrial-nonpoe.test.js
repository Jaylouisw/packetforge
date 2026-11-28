'use strict';
// Two UniFi switches that the vendor spec table says neither source nor sink power:
//
//   USW-24                  https://techspecs.ui.com/unifi/switching/usw-24
//                           24x 1G RJ45, 2x 1G SFP; Max. Power Consumption 25W;
//                           Power Method universal input 100-240V AC; AC/DC internal 36W.
//                           The PoE hardware is a different SKU (USW-24-PoE).
//   USW-Industrial-DIN-8    https://techspecs.ui.com/unifi/switching/usw-industrial-din-8
//                           8x 1G RJ45, 2x 1G SFP, 1 console; (2) 2-pin DC inputs, 12-60V DC;
//                           Max. Power Consumption 12W. Its PoE sibling prints PoE Ports /
//                           Max. PoE Wattage per Port by PSE / Total PoE Availability; this row
//                           prints none of them.
//
// isPoePd() (engine/media.js) matches "unifi" against model + label, so every copper port of a
// UniFi box whose spec is silent about PoE had a 12.95 W 802.3af draw inferred onto it: 310.8 W
// over 24 cables for the Standard 24, 103.6 W over 8 for the industrial DIN 8. #1721 corrected
// seven sibling rows (US-24, US-48, USW-Pro-HD-24, the Pro-XG pair, ECS-24S/48S) and missed the
// model whose own name is USW-24.

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
const COPPER = ['rj45', 'combo'];
function hardware(dev) {
  return [...dev.interfaces.values()].map(function (i) { return i.hardware; })
    .filter(function (h) { return h && COPPER.indexOf(h.cage) !== -1; });
}
function draws(dev) {
  return hardware(dev).filter(function (h) { return typeof h.poeIn === 'number'; });
}
function rj45(s) {
  return s.interfaces.filter(function (i) { return i.type === 'ethernet' && !/^sfp/i.test(i.name); });
}

const ROWS = [
  { model: 'USW-24',               copper: 24, cages: 2, was: 310.8, note: 'Standard 24' },
  { model: 'USW-Industrial-DIN-8', copper: 8,  cages: 2, was: 103.6, note: 'Industrial DIN 8' }
];

console.log('The port census is the one the vendor sheet prints:');
for (const r of ROWS) {
  const s = spec(r.model);
  ok(!!s, r.model + ' (' + r.note + ') is in the catalogue');
  if (!s) continue;
  ok(rj45(s).length === r.copper, r.model + ' has ' + r.copper + ' Ethernet RJ45 ports', String(rj45(s).length));
  const sfp = s.interfaces.filter(function (i) { return i.connector === 'sfp' || /^sfp/i.test(i.name); });
  ok(sfp.length === r.cages, r.model + ' has ' + r.cages + ' SFP cages', String(sfp.length));
}

console.log('');
console.log('Every copper socket says it is not a powered device:');
for (const r of ROWS) {
  const s = spec(r.model);
  if (!s) continue;
  ok(rj45(s).every(function (i) { return i.poeIn === false; }),
    r.model + ': all ' + rj45(s).length + ' copper ports declare poeIn: false');
  ok(s.interfaces.every(function (i) { return !i.poeOut; }), r.model + ' declares no PSE port');
  ok(!s.poe || s.poe.budgetW == null, r.model + ' declares no PoE budget');
  ok(!!s.sourceUrl && /^https:\/\//.test(s.sourceUrl), r.model + ' names a source URL');
  ok(typeof s.notes === 'string' && /PoE/.test(s.notes), r.model + ' records the PoE finding in notes');
}

console.log('');
console.log('The engine derives no draw from them (nothing is inferred back in):');
for (const r of ROWS) {
  const s = spec(r.model);
  if (!s) continue;
  const d = new Topology().addDevice(s);
  ok(hardware(d).length === r.copper, r.model + ': the engine sees ' + r.copper + ' copper ports',
    String(hardware(d).length));
  ok(draws(d).length === 0, r.model + ': zero ports draw power', String(draws(d).length));
  ok(!d.poeBudget, r.model + ': sources nothing of their own', String(d.poeBudget));
}

console.log('');
console.log('A PSE that cables both spends nothing (they used to ask for 414.4 W):');
const refPse = catalog.find(function (s) {
  return s.vendor === 'aruba' && s.model === 'CX 6000 24G CL4 PoE 4SFP 370W';
});
ok(!!refPse, 'the Aruba 370 W reference PSE is in the catalogue');
if (refPse) {
  const t = new Topology();
  const sw = t.addDevice(refPse);
  const seats = ['1/1/1', '1/1/2'];
  let cabled = 0;
  ROWS.forEach(function (r, i) {
    const s = spec(r.model);
    if (!s) return;
    const d = t.addDevice(s);
    try { t.connect(d.id, rj45(s)[0].name, sw.id, seats[i]); cabled++; }
    catch (e) { ok(false, r.model + ' cables to ' + seats[i], e.message); }
  });
  ok(cabled === ROWS.length, 'both switches are cabled to the PSE');
  const sim = new Simulator(t);
  sim.computePoe();
  ok(sim.poe.length === 1, 'one PSE is accounted for');
  ok(sim.poe[0].used === 0, 'the PSE spends 0 W on them (used to be 414.4 W)', String(sim.poe[0].used));
  ok(sim.poe[0].ports.every(function (p) { return !p.powered; }), 'no cable to them is powered');
}

console.log('');
console.log('The PoE hardware of each family is still a separate, powered row:');
[
  { model: 'USW-24-POE', budget: 95 },
  { model: 'USW-Industrial-DIN-8-PoE', budget: 480 }
].forEach(function (r) {
  const s = spec(r.model);
  ok(!!s, r.model + ' is in the catalogue');
  if (!s) return;
  if (r.budget != null) {
    ok(!!s.poe && s.poe.budgetW === r.budget, r.model + ' still declares a ' + r.budget + ' W budget',
      String(s.poe && s.poe.budgetW));
  }
  ok(s.interfaces.filter(function (i) { return i.poeOut; }).length > 0, r.model + ' still declares PSE ports');
});

console.log('');
console.log('A device that really is a PD still declares what it draws (the inference did not go quiet):');
const u6 = spec('U6-Pro');
ok(!!u6, 'U6-Pro is in the catalogue');
if (u6 && refPse) {
  const decl = u6.interfaces.filter(function (i) { return typeof i.poeIn === 'number'; });
  ok(decl.length === 1 && decl[0].poeIn === 12.95, 'U6-Pro declares 12.95 W on ' + (decl[0] && decl[0].name));
  const t = new Topology();
  const sw = t.addDevice(refPse);
  const ap = t.addDevice(u6);
  t.connect(ap.id, decl[0].name, sw.id, '1/1/9');
  const sim = new Simulator(t);
  sim.computePoe();
  ok(sim.poe[0].used === 12.95, 'and the PSE spends it (' + sim.poe[0].used + ' W)', String(sim.poe[0].used));
  ok(sim.poe[0].ports[0].powered === true, 'the AP is powered');
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
if (failed) process.exitCode = 1;
