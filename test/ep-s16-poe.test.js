'use strict';
// The EdgePoint S16 is a 16-port WISP switch whose PoE census was inverted and whose budget was
// missing altogether. Filed as:
//   * sixteen PSE ports and no `poe` block, so `engine/simulator.js` opened with
//     `if (!dev.poeBudget) continue;` and skipped the box - the ports were not "unknown", they
//     could not light anything at all (`show power inline`: "budget not modelled");
//   * ports 1-4 labelled `poeOutClass: "PoE"` (802.3af, a negotiated 48 V standard) when the
//     vendor describes them as "54V or 24V /1.4A, 4-Pair ... Passive PoE" - the four highest-power
//     ports filed as the weakest ones, and the twelve 802.3af/at ports as the strongest;
//   * no PoE input on ports 1-2, although the datasheet lists them as 54 V/1.5 A passive PoE
//     inputs, so cabling the switch to a PoE source said it was unpowered.
//
// Every figure below is the vendor's, read 2026-11-19:
//   https://dl.ui.com/datasheets/edgemax/EdgePoint_DS.pdf  (200, application/pdf, 6,571,516 B, 12 pp)
//     page 8 "Hardware Specifications EP-S16": "Data Ports (16) 10/100/1000 RJ45 Ports,
//     (2) 1/10 Gbps SFP+ Ports"; "Passive PoE Input (2) 54V /1.5A, 4-Pair ... Ports 1 and 2";
//     "Passive PoE Output (4) 54V or 24V /1.4A, 4-Pair ... Ports 1 to 4" and
//     "(12) 802.3af/at or 24V/0.7A, 2-Pair ... Ports 5 to 16"; "Power Method (1) DC terminal block
//     54V DC, 6A input"; "Max. power consumption 40W (Excludes PoE output)".
//   https://techspecs.ui.com/uisp/wired/ep-s16  (200, 577,761 B, rendered spec table)
// 324 W in at 54 V x 6 A, less the 40 W the switch itself draws, leaves 284 W for the ports - a
// derived ceiling, recorded as derived, in the same shape as devices/ubiquiti/uisp-r.json.
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

const sw = spec('EP-S16');
const radio = spec('NBE-5AC-Gen2');

console.log('The switch is in the catalogue with the vendor\'s port census:');
ok(!!sw, 'EP-S16 is in the catalogue');
ok(!!radio, 'NBE-5AC-Gen2 (a 24 V passive airMAX radio) is in the catalogue');

if (sw) {
  const copper = sw.interfaces.filter(function (i) { return i.connector === 'rj45'; });
  const fibre = sw.interfaces.filter(function (i) { return i.connector === 'sfp+'; });
  ok(copper.length === 16, 'sixteen RJ45 ports (' + copper.length + ')');
  ok(fibre.length === 2, 'two SFP+ cages (' + fibre.length + ')');

  console.log('\nPorts 1-4 are the passive 54/24 V 4-pair ports, ports 5-16 the 802.3af/at ones:');
  ok(copper.slice(0, 4).every(function (i) { return i.poeOut === 75.6; }),
    'ports 1-4 carry poeOut 75.6 (54 V x 1.4 A): ' + copper.slice(0, 4).map(function (i) { return i.poeOut; }).join(','));
  ok(copper.slice(0, 4).every(function (i) { return i.poeOutClass === 'passive'; }),
    'and their class is passive, not 802.3af');
  ok(copper.slice(4).every(function (i) { return i.poeOut === 30; }),
    'ports 5-16 carry the vendor class PoE+ (30 W): ' + copper.slice(4).map(function (i) { return i.poeOut; }).join(','));
  ok(copper.slice(4).every(function (i) { return i.poeOutClass === 'PoE+'; }),
    'and stay labelled PoE+');
  ok(copper.slice(0, 2).every(function (i) { return i.poeIn === 40; }),
    'ports 1-2 are PoE inputs at the switch\'s own 40 W draw: ' + copper.slice(0, 2).map(function (i) { return i.poeIn; }).join(','));
  ok(copper.slice(2).every(function (i) { return i.poeIn === undefined; }),
    'no other port claims to be a PD');
  const caps = sw.capabilities || [];
  ok(caps.indexOf('passive-poe') !== -1 && caps.indexOf('802.3af') !== -1 && caps.indexOf('802.3at') !== -1,
    'the row claims passive PoE and 802.3af/at, which is exactly what ports 1-4 and 5-16 are');

  console.log('\nThe budget is the DC-input headroom, not a number in the model name:');
  const dev = new Topology().addDevice(sw, 'sw1');
  ok(dev.poeBudget === 284, 'the budget is 284 W (54 V x 6 A less the 40 W device draw): ' + dev.poeBudget);
  ok(dev.poeBudgetSource === 'research', 'and it comes from the spec, not the model name (' + dev.poeBudgetSource + ')');
  ok(sw.poe && /^https:\/\/dl\.ui\.com\/datasheets\/edgemax\/EdgePoint_DS\.pdf$/.test(String(sw.poe.sourceUrl)),
    'the budget cites the datasheet it was derived from');
  ok(/derived/i.test(String(sw.poe && sw.poe.note)),
    'and says in the note that it is derived rather than quoted');
  ok(284 < 4 * 75.6, 'the supply, not the port count, is what limits a full fill (4 x 75.6 W > 284 W)');

  console.log('\nA radio cabled to it is powered instead of silently skipped:');
  const t = new Topology();
  t.addDevice(sw, 'sw1');
  t.addDevice(radio, 'radio1');
  t.connect('sw1', 'eth4', 'radio1', 'eth0');
  const entry = new Simulator(t).computePoe().find(function (e) { return e.dev === 'sw1'; });
  ok(!!entry, 'computePoe() has an entry for the switch at all');
  if (entry) {
    const p = (entry.ports || []).find(function (x) { return x.iface === 'eth4'; });
    ok(!!p && p.powered === true, 'eth4 powers the radio (' + JSON.stringify(p) + ')');
    ok(entry.budget === 284 && entry.used === 12.95, 'against a 284 W budget, 12.95 W used');
  }
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
