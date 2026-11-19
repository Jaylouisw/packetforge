'use strict';
// The EdgePoint R6 and R8 are Ubiquiti's tower-mounted routers - outdoor boxes whose whole point is
// that an airMAX radio plugs into them and is powered by them. Both were catalogued as boxes that
// could not power anything, from the same datasheet, in two different ways:
//
//   * EP-R6 declared `poe-pse` and carried no PSE port at all - "Passive PoE output (5) 24V / 0.7A,
//     2-Pair ... eth0 to eth4" was not modelled, so all five copper ports were dry;
//   * EP-R8 had the direction inverted - `poeOut` on eth0 and eth1 with class "PoE" (802.3af, a
//     negotiated 48 V standard) on a box with no 802.3 detection anywhere, eth0 being the port the
//     vendor lists under PoE *input*, and eth2-eth7 - five real PSE ports - declared dry.
//
// Neither had a `poe` block, so `engine/simulator.js` skipped both at `if (!dev.poeBudget) continue;`
// and `show power inline` reported nothing at all rather than "unknown".
//
// Every figure below is the vendor's, read 2026-11-19:
//   https://dl.ui.com/datasheets/edgemax/EdgePoint_DS.pdf  (200, application/pdf, 6,571,516 B, 12 pp)
//     page 6 = EP-R6 table, page 7 = EP-R8 table, both text layers.
//   https://techspecs.ui.com/uisp/wired/ep-r6   (200, 577,753 B) - same rows, rendered.
//   https://techspecs.ui.com/uisp/wired/ep-r8   (200, 578,035 B) - same rows, rendered.
// Both budgets are DERIVED from printed input and draw: 24V x 3A - 7W = 65W (R6),
// 54V x 6A - 40W = 284W (R8), the same shape as devices/ubiquiti/ep-s16.json and uisp-r.json.
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
function copperOf(s) {
  return (s.interfaces || []).filter(function (i) { return i.connector === 'rj45'; });
}
function budget(entry, iface) {
  return (entry.ports || []).find(function (p) { return p.iface === iface; });
}

const r6 = spec('EP-R6');
const r8 = spec('EP-R8');
const radio = spec('NBE-5AC-Gen2');
const PDF = 'https://dl.ui.com/datasheets/edgemax/EdgePoint_DS.pdf';

console.log('Both boxes are in the catalogue, with the vendor\'s copper census:');
ok(!!r6, 'EP-R6 is in the catalogue');
ok(!!r8, 'EP-R8 is in the catalogue');
ok(!!radio, 'NBE-5AC-Gen2 (a 24V passive airMAX radio, 12.95 W) is in the catalogue');
if (r6) ok(copperOf(r6).length === 5, 'EP-R6 has five RJ45 ports (' + copperOf(r6).length + ')');
if (r8) ok(copperOf(r8).length === 8, 'EP-R8 has eight RJ45 ports (' + copperOf(r8).length + ')');

if (r6) {
  console.log('\nEP-R6: all five copper ports source 24V/0.7A passive PoE at 16.8 W:');
  const c = copperOf(r6);
  ok(c.every(function (i) { return i.poeOut === 16.8; }),
    'every copper port carries poeOut 16.8 (' + c.map(function (i) { return i.poeOut; }).join(',') + ')');
  ok(c.every(function (i) { return i.poeOutClass === 'passive'; }), 'and its class is passive, not 802.3af');
  ok((r6.capabilities || []).indexOf('802.3af') === -1 && (r6.capabilities || []).indexOf('802.3at') === -1,
    'the row claims no 802.3af/at capability');
  const eth0 = c.find(function (i) { return i.name === 'eth0'; });
  ok(!!eth0 && eth0.poeIn === 7, 'eth0 also accepts passive PoE in and draws 7 W (' + (eth0 && eth0.poeIn) + ')');
  ok((r6.capabilities || []).indexOf('poe-pd') !== -1, 'and the row claims poe-pd');

  console.log('\nEP-R6: the budget is the 24 V / 3 A headroom, not a number in the model name:');
  const dev = new Topology().addDevice(r6, 'r6');
  ok(dev.poeBudget === 65, 'the budget is 65 W (24V x 3A less the 7 W device draw): ' + dev.poeBudget);
  ok(dev.poeBudgetSource === 'research', 'and it comes from the spec, not the model name (' + dev.poeBudgetSource + ')');
  ok(r6.poe && r6.poe.sourceUrl === PDF, 'the budget cites the vendor datasheet it was derived from');
  ok(/derived/i.test(String(r6.poe && r6.poe.note)), 'and says in the note that it is derived rather than quoted');
}

if (r8) {
  console.log('\nEP-R8: the two PoE directions are the vendor\'s, not each other\'s:');
  const c = copperOf(r8);
  const eth0 = c.find(function (i) { return i.name === 'eth0'; });
  ok(!!eth0 && eth0.poeIn === 40, 'eth0 draws 40 W from a passive PoE source (' + (eth0 && eth0.poeIn) + ')');
  ok(!!eth0 && !eth0.poeOut, 'and does not source power - the vendor lists it under PoE input only');
  const high = c.filter(function (i) { return i.name === 'eth1' || i.name === 'eth2'; });
  ok(high.every(function (i) { return i.poeOut === 75.6 && i.poeOutClass === 'passive'; }),
    'eth1-eth2 source 75.6 W passive 4-pair (54V x 1.4A)');
  const low = c.filter(function (i) { return ['eth3', 'eth4', 'eth5', 'eth6', 'eth7'].indexOf(i.name) !== -1; });
  ok(low.every(function (i) { return i.poeOut === 16.8 && i.poeOutClass === 'passive'; }),
    'eth3-eth7 source 16.8 W passive 2-pair (24V x 0.7A) - five ports that were dry');
  ok(c.filter(function (i) { return i.poeOut; }).length === 7, 'seven PSE ports in total');
  ok(c.every(function (i) { return i.poeOutClass !== 'PoE' && i.poeOutClass !== 'PoE+'; }),
    'no port claims an 802.3 class on hardware with no detection');
  ok((r8.capabilities || []).indexOf('poe-pd') !== -1, 'the row claims poe-pd for its PoE input');

  console.log('\nEP-R8: the budget is the 54 V / 6 A headroom:');
  const dev = new Topology().addDevice(r8, 'r8');
  ok(dev.poeBudget === 284, 'the budget is 284 W (54V x 6A less the 40 W device draw): ' + dev.poeBudget);
  ok(dev.poeBudgetSource === 'research', 'and it comes from the spec, not the model name (' + dev.poeBudgetSource + ')');
  ok(r8.poe && r8.poe.sourceUrl === PDF, 'the budget cites the vendor datasheet it was derived from');
  ok(/derived/i.test(String(r8.poe && r8.poe.note)), 'and says in the note that it is derived rather than quoted');
}

if (r6 && radio) {
  console.log('\nA radio cabled to the R6 is powered - the whole point of the box:');
  const t = new Topology();
  t.addDevice(r6, 'r6');
  t.addDevice(radio, 'radio1');
  t.connect('r6', 'eth4', 'radio1', 'eth0');
  const entry = new Simulator(t).computePoe().find(function (e) { return e.dev === 'r6'; });
  ok(!!entry, 'computePoe() has an entry for the R6 at all');
  if (entry) {
    const p = budget(entry, 'eth4');
    ok(!!p && p.powered === true, 'eth4 powers the radio (' + JSON.stringify(p) + ')');
    ok(entry.budget === 65 && entry.used === 12.95, 'against a 65 W budget, 12.95 W used');
  }
}

if (r8 && radio) {
  console.log('\nA radio on a 16.8 W port is powered from the 284 W envelope:');
  const t = new Topology();
  t.addDevice(r8, 'r8');
  t.addDevice(radio, 'radio1');
  t.connect('r8', 'eth3', 'radio1', 'eth0');
  const entry = new Simulator(t).computePoe().find(function (e) { return e.dev === 'r8'; });
  ok(!!entry, 'computePoe() has an entry for the R8 at all');
  if (entry) {
    const p = budget(entry, 'eth3');
    ok(!!p && p.powered === true, 'eth3 powers the radio (' + JSON.stringify(p) + ')');
    ok(entry.used === 12.95, 'and only 12.95 W of the 284 W is counted');
  }
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
