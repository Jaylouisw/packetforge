'use strict';
// The UISP Router is Ubiquiti's MicroPoP router - eight copper ports, every one of them 27V passive
// PoE at 30 W - and it was filed as a box with eight 802.3af PoE ports that could power nothing.
//
// Two separate faults, both from the same missing rows:
//   * the ports said `poeOutClass: "PoE"` (802.3af, a negotiated 48 V standard) on hardware the vendor
//     describes as "27V passive PoE ... 2-pair (pins 4, 5+/7, 8-) or 4-pair", voltage range 27V DC;
//   * there was no `poe` block, so `engine/device.js` fell through to `parsePoeBudget('UISP-R')`, found no
//     number in the name, and got 0. `engine/simulator.js` opens `computePoe()` with
//     `if (!dev.poeBudget) continue;` - so the box was skipped rather than reported unknown, and the
//     eight PSE ports it advertises could not light a single airMAX radio.
//
// Every figure below is the vendor's, read 2026-11-19:
//   https://techspecs.ui.com/uisp/wired/uisp-r   (200, 583,910 B)
//   https://dl.ui.com/ds/uisp-r_ds.pdf           (200, application/pdf, 2,635,831 B, 2 pp, text layer)
// "Networking interface (8) GbE RJ45 ports, (1) 1G SFP port"; "PoE interface (8) 27V passive PoE";
// "Max. Passive PoE wattage per port 30W/27V DC"; "Power supply 27V DC, 4.4A power adapter (included)";
// "Max. power consumption 10W (Excluding PoE output)". 27 V x 4.4 A = 118.8 W, less the 10 W the router
// itself draws, leaves 108.8 W for the ports - a derived ceiling, recorded as derived, in the same shape
// as devices/antaira/lmp-1002g-sfp-t.json.
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

const router = spec('UISP-R');
const radio = spec('NBE-5AC-Gen2');

console.log('The router is in the catalogue with the vendor\'s port census:');
ok(!!router, 'UISP-R is in the catalogue');
ok(!!radio, 'NBE-5AC-Gen2 (a 24/27V airMAX radio) is in the catalogue');

if (router) {
  const copper = router.interfaces.filter(function (i) { return i.connector === 'rj45'; });
  const fibre = router.interfaces.filter(function (i) { return i.connector === 'sfp'; });
  ok(copper.length === 8, 'eight RJ45 ports (' + copper.length + ')');
  ok(fibre.length === 1, 'one SFP port (' + fibre.length + ')');

  console.log('\nAll eight copper ports source 27V passive PoE at the vendor\'s 30 W ceiling:');
  ok(copper.every(function (i) { return i.poeOut === 30; }),
    'every copper port carries poeOut 30 (' + copper.map(function (i) { return i.poeOut; }).join(',') + ')');
  ok(copper.every(function (i) { return i.poeOutClass === 'passive'; }),
    'and its class is passive, not 802.3af');
  ok((router.capabilities || []).indexOf('802.3af') === -1 && (router.capabilities || []).indexOf('802.3at') === -1,
    'the row claims no 802.3af/at capability');
  ok((router.capabilities || []).indexOf('passive-poe') !== -1, 'and does claim passive PoE');

  console.log('\nThe budget is the adapter headroom, not a number in the model name:');
  const dev = new Topology().addDevice(router, 'r1');
  ok(dev.poeBudget === 108.8, 'the budget is 108.8 W (27V x 4.4A less the 10 W device draw): ' + dev.poeBudget);
  ok(dev.poeBudgetSource === 'research', 'and it comes from the spec, not the model name (' + dev.poeBudgetSource + ')');
  ok(router.poe && /^https:\/\/techspecs\.ui\.com\/uisp\/wired\/uisp-r$/.test(String(router.poe.sourceUrl)),
    'the budget cites the vendor page it was derived from');
  ok(/derived/i.test(String(router.poe && router.poe.note)),
    'and says in the note that it is derived rather than quoted');

  console.log('\nA radio cabled to it is powered instead of silently skipped:');
  const t = new Topology();
  t.addDevice(router, 'r1');
  t.addDevice(radio, 'radio1');
  t.connect('r1', 'eth4', 'radio1', 'eth0');
  const entry = new Simulator(t).computePoe().find(function (e) { return e.dev === 'r1'; });
  ok(!!entry, 'computePoe() has an entry for the router at all');
  if (entry) {
    const p = (entry.ports || []).find(function (x) { return x.iface === 'eth4'; });
    ok(!!p && p.powered === true, 'eth4 powers the radio (' + JSON.stringify(p) + ')');
    ok(entry.budget === 108.8 && entry.used === 12.95, 'against a 108.8 W budget, 12.95 W used');
  }
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
