'use strict';
// The Chateau family is mains-powered: five RJ45 ports, one DC jack, no PoE inlet.
//
// Every Chateau spec carries category `wireless` (it is a Wi-Fi router with an LTE modem),
// and isPoePd() (engine/media.js) promotes that category to 12.95 W on every copper socket.
// The vendor Powering block says otherwise: "Number of DC inputs: 1 (DC jack)" and no
// PoE-in row at all. The one exception is Chateau PRO ax, whose Powering block adds a
// PoE-out device: Ether5 sources passive PoE up to 57 V (600 mA, 22.8 W total out) - it
// still accepts nothing.
//
// Read on 2026-11-28 from the product pages, Powering section:
//   Chateau 5G          https://mikrotik.com/product/chateau_5g          DC jack 12-28 V
//   Chateau 5G ax       https://mikrotik.com/product/chateau_5g_ax       DC jack 12-28 V
//   Chateau 5G R16      https://mikrotik.com/product/chateau5gr16        DC jack 12-28 V
//   Chateau 5G R17 ax   https://mikrotik.com/product/chateau_5g_r17_ax   DC jack 12-28 V
//   Chateau LTE12       https://mikrotik.com/product/chateau_lte12       DC jack 12-28 V
//   Chateau LTE12 2025  https://mikrotik.com/product/chateau_lte12_2025  DC jack 12-28 V
//   Chateau LTE6        https://mikrotik.com/product/chateau_lte6        DC jack 12-28 V
//   Chateau LTE6 ax     https://mikrotik.com/product/chateau_lte6_ax     DC jack 12-28 V
//   Chateau LTE6-US     https://mikrotik.com/product/chateau_lte6_us     DC jack 12-28 V
//   Chateau LTE7        https://mikrotik.com/product/chateau_lte7        DC jack 12-28 V
//   Chateau LTE7 ax     https://mikrotik.com/product/chateau_lte7_ax     DC jack 12-28 V
//   Chateau LTE18 ax    https://mikrotik.com/product/chateaulte18_ax     DC jack 12-28 V
//   Chateau PRO ax      https://mikrotik.com/product/chateau_pro_ax      DC jack 18-57 V, PoE-out Ether5
// Each page Ethernet block lists "10/100/1000 Ethernet ports: 5" (LTE18 ax: four 1G plus
// one 2.5G), so a Chateau asking a PSE for 5 x 12.95 W is 64.75 W of nothing: 841.75 W
// across the thirteen rows that were inferring it.
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
  return catalog.find(function (s) { return s.vendor === 'mikrotik' && s.model === model; });
}

// model code -> the copper census its own page prints.
const ROWS = [
  { model: 'Chateau 5G',                      g1: 5, g25: 0 },
  { model: 'Chateau LTE18 ax',                g1: 4, g25: 1 },
  { model: 'D53G-5HacD2HnD-TC&EG06-A',        g1: 5, g25: 0 },
  { model: 'D53G-5HacD2HnD-TC&EG120K-EA',     g1: 5, g25: 0 },
  { model: 'D53G-5HacD2HnD-TC&FG621-EA',      g1: 5, g25: 0 },
  { model: 'D53G-5HacD2HnD-TC&R11e-LTE7',     g1: 5, g25: 0 },
  { model: 'D53G-5HacD2HnD-TC&RG502Q-EA',     g1: 5, g25: 0 },
  { model: 'D53G-5HacD2HnD-TC&RG520F-EU',     g1: 5, g25: 0 },
  { model: 'H53UiG-5HaxQ2HaxQ',               g1: 5, g25: 0 },
  { model: 'RBD53G-5HacD2HnD-TC&EG12-EA',     g1: 5, g25: 0 },
  { model: 'S53UG+5HaxD2HaxD-TC&EG18-EA',     g1: 4, g25: 1 },
  { model: 'S53UG+5HaxD2HaxD-TC&FG621-EA', g1: 4, g25: 1 },
  { model: 'S53UG+5HaxD2HaxD-TC&R11e-LTE7',   g1: 4, g25: 1 },
  { model: 'S53UG+5HaxD2HaxD-TC&RG650E-EU', g1: 4, g25: 1 },
  { model: 'S53UG+M-5HaxD2HaxD-TC&RG502Q-EA', g1: 4, g25: 1 }
];

function copperOf(s) {
  return s.interfaces.filter(function (i) { return /^eth\d+$/.test(i.name); });
}

console.log('The family is in the catalogue, with the port census its own page prints:');
for (const r of ROWS) {
  const s = spec(r.model);
  ok(!!s, r.model + ' is in the catalogue');
  if (!s) continue;
  const copper = copperOf(s);
  ok(copper.length === r.g1 + r.g25,
    r.model + ' has ' + (r.g1 + r.g25) + ' Ethernet ports', String(copper.length));
  ok(copper.filter(function (i) { return i.speed === '1G'; }).length === r.g1,
    r.model + ' has ' + r.g1 + ' GbE port(s)');
  ok(copper.filter(function (i) { return i.speed === '2.5G'; }).length === r.g25,
    r.model + ' has ' + r.g25 + ' 2.5G port(s)');
}

console.log('');
console.log('Every port says it is not a powered device, and names the sheet:');
for (const r of ROWS) {
  const s = spec(r.model);
  if (!s) continue;
  const copper = copperOf(s);
  ok(copper.every(function (i) { return i.poeIn === false; }),
    r.model + ': all ' + copper.length + ' copper ports declare poeIn: false');
  ok(typeof s.sourceUrl === 'string' && s.sourceUrl.indexOf('mikrotik.com/product/') !== -1,
    r.model + ' records its product page as sourceUrl', s.sourceUrl);
  ok(typeof s.notes === 'string' && /DC jack/.test(s.notes),
    r.model + ' notes quote the Powering block');
  ok(!s.poe || s.poe.budgetW == null, r.model + ' declares no PoE budget');
}

console.log('');
console.log('The engine derives no draw from them (nothing is inferred back in):');
for (const r of ROWS) {
  const s = spec(r.model);
  if (!s) continue;
  const d = new Topology().addDevice(s);
  const hw = [...d.interfaces.values()].map(function (i) { return i.hardware; })
    .filter(function (h) { return h && (h.cage === 'rj45' || h.cage === 'combo'); });
  const pd = hw.filter(function (h) { return h.poeIn !== null && h.poeIn !== undefined && h.poeIn !== false; });
  ok(hw.length === r.g1 + r.g25,
    r.model + ': the engine sees ' + (r.g1 + r.g25) + ' copper ports', String(hw.length));
  ok(pd.length === 0, r.model + ': zero ports draw power', String(pd.length));
  ok(!d.poeBudget, r.model + ': sources nothing of its own', String(d.poeBudget));
}

console.log('');
console.log('A PSE that cables the whole family spends nothing:');
const PSE_MODEL = 'CX 6000 24G CL4 PoE 4SFP 370W';
const refPse = catalog.find(function (s) { return s.vendor === 'aruba' && s.model === PSE_MODEL; });
ok(!!refPse, 'the Aruba reference PSE is in the catalogue');
if (refPse) {
  const t = new Topology();
  const sw = t.addDevice(refPse);
  let cabled = 0;
  ROWS.forEach(function (r, i) {
    const s = spec(r.model);
    if (!s) return;
    const d = t.addDevice(s);
    const port = copperOf(s)[0].name;
    try { t.connect(d.id, port, sw.id, '1/1/' + (i + 1)); cabled++; }
    catch (e) { ok(false, r.model + ' cables to 1/1/' + (i + 1), e.message); }
  });
  ok(cabled === ROWS.length, 'all ' + ROWS.length + ' routers are cabled to the PSE');
  const sim = new Simulator(t);
  sim.computePoe();
  ok(sim.poe.length === 1, 'one PSE is accounted for');
  ok(sim.poe[0].used === 0, 'the PSE spends 0 W on them (used to be 841.75 W)', String(sim.poe[0].used));
  ok(sim.poe[0].ports.every(function (p) { return !p.powered; }), 'no cable to them is powered');
}

console.log('');
console.log('A device that really is a PD still declares what it draws (the inference did not go quiet):');
const u6 = catalog.find(function (s) { return s.vendor === 'ubiquiti' && s.model === 'U6-Pro'; });
ok(!!u6, 'U6-Pro is in the catalogue');
if (u6 && refPse) {
  const decl = u6.interfaces.filter(function (i) { return typeof i.poeIn === 'number'; });
  ok(decl.length === 1 && decl[0].poeIn === 12.95, 'U6-Pro declares 12.95 W on ' + (decl[0] && decl[0].name));
  const t = new Topology();
  const sw = t.addDevice(refPse);
  const ap = t.addDevice(u6);
  t.connect(ap.id, decl[0].name, sw.id, '1/1/20');
  const sim = new Simulator(t);
  sim.computePoe();
  ok(sim.poe[0].used === 12.95, 'and the PSE spends it (' + sim.poe[0].used + ' W)', String(sim.poe[0].used));
  ok(sim.poe[0].ports[0].powered === true, 'the AP is powered');
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
if (failed) process.exitCode = 1;
