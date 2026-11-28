'use strict';
// Seven more UniFi switches that are not powered devices: six non-PoE members of families whose
// PoE sibling is a separate catalogue row, plus the Gen1 Standard pair.
//
// isPoePd() (engine/media.js) matches `unifi` against `model + ' ' + label`, so every copper
// port of a UniFi box that says nothing about PoE had a 12.95 W 802.3af draw inferred onto it.
// On these seven rows the vendor spec table prints no PoE section at all - no per-port
// wattage, no budget, no PoE standard - and the family PoE hardware is published as a
// different model with its own budget. So the silence is a product decision, not a blank field:
//
//   US-48           https://techspecs.ui.com/unifi/switching/us-48
//                   48x 1G RJ45, 2x 1G SFP, 2x 10G SFP+; Power Method universal 100-240V AC.
//                   PoE rows: US-48-500W 500 W, US-48-750W 750 W.
//   US-24           https://techspecs.ui.com/unifi/switching/us-24
//                   24x 1G RJ45, 2x 1G SFP; universal 100-240V AC.
//                   PoE rows: US-24-250W 250 W, US-24-500W 500 W.
//   USW-Pro-HD-24   https://techspecs.ui.com/unifi/switching/usw-pro-hd-24
//                   22x 2.5G RJ45 + 2x 10G RJ45 + 4x 10G SFP+; Max. Power Consumption 60W,
//                   internal 60W supply + USP RPS DC.  PoE row: USW-Pro-HD-24-PoE 600 W.
//   USW-Pro-XG-24   https://techspecs.ui.com/unifi/switching/usw-pro-xg-24
//                   8x 2.5G RJ45 + 16x 10G RJ45 + 2x 25G SFP28; 150W max, internal 200W.
//                   PoE row: USW-Pro-XG-24-PoE 720 W.
//   USW-Pro-XG-48   https://techspecs.ui.com/unifi/switching/usw-pro-xg-48
//                   16x 2.5G RJ45 + 32x 10G RJ45 + 4x 25G SFP28; 250W max, internal 300W.
//                   PoE row: USW-Pro-XG-48-PoE 1,080 W.
//   ECS-48S         https://techspecs.ui.com/unifi/switching/ecs-48s
//                   1x 1G RJ45 + 32x 2.5G RJ45 + 16x 10G RJ45 + 4x 25G SFP28 + 2x 100G QSFP28;
//                   250W max, 2x hot-swappable 550W AC/DC modules.  PoE row: ECS-48S-PoE.
//   ECS-24S         https://techspecs.ui.com/unifi/switching/ecs-24s
//                   1x 1G RJ45 + 8x 2.5G RJ45 + 16x 10G RJ45 + 4x 25G SFP28 + 2x 100G QSFP28;
//                   150W max, 2x hot-swappable 550W AC/DC modules.  PoE row: ECS-24S-PoE.
//                   Its one "Power Output" row sits under LEDs, beside Ethernet and SFP28: a
//                   status lamp, not a PSE port.
//
// Before the correction they asked a PSE for 3,133.9 W over 242 cables.
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
  { model: 'US-48',         g1: 48, g25: 0,  g10: 0,  cages: { sfp: 2, 'sfp+': 2 },  watts: 621.6 },
  { model: 'US-24',         g1: 24, g25: 0,  g10: 0,  cages: { sfp: 2 },             watts: 310.8 },
  { model: 'USW-Pro-HD-24', g1: 0,  g25: 22, g10: 2,  cages: { 'sfp+': 4 },          watts: 310.8 },
  { model: 'USW-Pro-XG-24', g1: 0,  g25: 8,  g10: 16, cages: { sfp28: 2 },           watts: 310.8 },
  { model: 'USW-Pro-XG-48', g1: 0,  g25: 16, g10: 32, cages: { sfp28: 4 },           watts: 621.6 },
  { model: 'ECS-48S',       g1: 1,  g25: 32, g10: 16, cages: { sfp28: 4, qsfp28: 2 }, watts: 634.6 },
  { model: 'ECS-24S',       g1: 1,  g25: 8,  g10: 16, cages: { sfp28: 4, qsfp28: 2 }, watts: 323.7 }
];

function copperOf(s) { return s.interfaces.filter(function (i) { return i.connector === 'rj45'; }); }

console.log('The rows are in the catalogue, with the port census their own sheet prints:');
for (const r of ROWS) {
  const s = spec(r.model);
  ok(!!s, r.model + ' is in the catalogue');
  if (!s) continue;
  const copper = copperOf(s);
  ok(copper.length === r.g1 + r.g25 + r.g10,
    r.model + ' has ' + (r.g1 + r.g25 + r.g10) + ' RJ45 ports', String(copper.length));
  ok(copper.filter(function (i) { return i.speed === '1G'; }).length === r.g1,
    r.model + ' has ' + r.g1 + ' GbE RJ45');
  ok(copper.filter(function (i) { return i.speed === '2.5G'; }).length === r.g25,
    r.model + ' has ' + r.g25 + ' 2.5G RJ45');
  ok(copper.filter(function (i) { return i.speed === '10G'; }).length === r.g10,
    r.model + ' has ' + r.g10 + ' 10G RJ45');
  for (const cage of Object.keys(r.cages)) {
    const n = s.interfaces.filter(function (i) { return i.connector === cage; }).length;
    ok(n === r.cages[cage], r.model + ' has ' + r.cages[cage] + ' ' + cage + ' cages', String(n));
  }
}

console.log('');
console.log('Every copper socket says it is not a powered device:');
for (const r of ROWS) {
  const s = spec(r.model);
  if (!s) continue;
  const copper = copperOf(s);
  ok(copper.every(function (i) { return i.poeIn === false; }),
    r.model + ': all ' + copper.length + ' copper ports declare poeIn: false');
  ok(copper.every(function (i) { return i.poeOut === undefined || i.poeOut === false; }),
    r.model + ' declares no PSE port');
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
  ok(hw.length === r.g1 + r.g25 + r.g10,
    r.model + ': the engine sees ' + (r.g1 + r.g25 + r.g10) + ' copper ports', String(hw.length));
  ok(pd.length === 0, r.model + ': zero ports draw power', String(pd.length));
  ok(!d.poeBudget, r.model + ': sources nothing of their own', String(d.poeBudget));
}

console.log('');
console.log('A PSE that cables all seven spends nothing:');
const PSE_MODEL = 'CX 6000 24G CL4 PoE 4SFP 370W';
const refPse = catalog.find(function (s) { return s.vendor === 'aruba' && s.model === PSE_MODEL; });
ok(!!refPse, 'the Aruba reference PSE is in the catalogue');
if (refPse) {
  const t = new Topology();
  const sw = t.addDevice(refPse);
  const seats = ['1/1/1', '1/1/2', '1/1/3', '1/1/4', '1/1/5', '1/1/6', '1/1/7'];
  let cabled = 0;
  ROWS.forEach(function (r, i) {
    const s = spec(r.model);
    if (!s) return;
    const d = t.addDevice(s);
    try { t.connect(d.id, 'eth0', sw.id, seats[i]); cabled++; }
    catch (e) { ok(false, r.model + ' cables to ' + seats[i], e.message); }
  });
  ok(cabled === ROWS.length, 'all seven switches are cabled to the PSE');
  const sim = new Simulator(t);
  sim.computePoe();
  ok(sim.poe.length === 1, 'one PSE is accounted for');
  ok(sim.poe[0].used === 0, 'the PSE spends 0 W on them (used to be 3,133.9 W)', String(sim.poe[0].used));
  ok(sim.poe[0].ports.every(function (p) { return !p.powered; }), 'no cable to them is powered');
}

console.log('');
console.log('The PoE siblings are still powered devices with their own budgets:');
[
  { model: 'US-48-500W', budget: 500 },
  { model: 'US-48-750W', budget: 750 },
  { model: 'US-24-250W', budget: 250 },
  { model: 'US-24-500W', budget: 500 },
  { model: 'USW-Pro-HD-24-PoE', budget: 600 },
  { model: 'USW-Pro-XG-24-PoE', budget: 720 },
  { model: 'USW-Pro-XG-48-PoE', budget: 1080 },
  { model: 'ECS-48S-PoE', budget: 2150 },
  { model: 'ECS-24S-PoE', budget: 1050 }
].forEach(function (r) {
  const s = spec(r.model);
  ok(!!s, r.model + ' is in the catalogue');
  if (!s) return;
  ok(!!s.poe && s.poe.budgetW === r.budget, r.model + ' still declares a ' + r.budget + ' W budget',
    String(s.poe && s.poe.budgetW));
  const sourcing = s.interfaces.filter(function (i) { return i.poeOut === true || (typeof i.poeOut === 'number' && i.poeOut > 0); });
  ok(sourcing.length > 0, r.model + ' still declares PSE ports', String(sourcing.length));
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
