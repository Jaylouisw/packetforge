'use strict';
// The Dream Wall's twelve powered sockets billed 1 W each.
//
// `devices/ubiquiti/udw.json` carried `poeOut: true` on eth0-eth11 - the bare direction bit.
// engine/device.js `poeDraw()` adds `iface.poeOut` straight into the watt total, so `true` is
// **1 W**, and engine/validation.js `pseDraw()` sums the identical field against the chassis
// budget: a 420 W PSE that could not be loaded. web/faceplate.js `num()` refuses a boolean, so
// every socket also printed no "PoE out" figure at all.
//
// Ubiquiti publishes the per-class ceiling on both surfaces, read 2026-11-21:
//   https://techspecs.ui.com/unifi/cloud-gateways/udw  (200, 704,702 B, server-rendered table)
//     "PoE Budget 420W"; "Max. PoE Wattage per Port by PSE PoE: 15.4W / PoE+: 30W / PoE++: 60W";
//     "Voltage Range PoE Mode  PoE: 44-57V / PoE+/PoE++: 50-57V";
//     "Power Method Universal AC input 100-240V AC, 7A Max., 50/60Hz"
//   https://dl.ui.com/ds/udw_ds.pdf  (200, 544,909 B, 3 pp, text layer)
//     "PoE interface (4) PoE ... / (4) PoE+ ... / (4) PoE++ ...";
//     "Max. PoE wattage per port by PSE PoE: 15.4W / PoE+: 30W / PoE++: 60W"
// Neither surface numbers which four sockets are which, so the class-to-socket assignment that
// already shipped is kept; only the figure changed.
const path = require('path');
const { Topology, Simulator } = require('../engine');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices')).filter(function (s) { return !s.error; });
function spec(model) { return catalog.filter(function (s) { return s.model === model; })[0]; }

const s = spec('UDW');
console.log('\nUDW: the twelve powered sockets carry the vendor ceiling for their class');
ok(!!s, 'UDW is in the catalogue');
if (s) {
  const powered = s.interfaces.filter(function (i) { return i.poeOut !== undefined && i.poeOut !== null; });
  ok(powered.length === 12, '12 PoE sockets (' + powered.length + ')');
  ok(powered.every(function (i) { return typeof i.poeOut === 'number'; }),
    'every one is a number, not the direction bit: ' +
    [...new Set(powered.map(function (i) { return i.poeOut; }))].join(','));
  const by = {};
  powered.forEach(function (i) { by[i.poeOutClass] = (by[i.poeOutClass] || 0) + 1; });
  ok(by['PoE++'] === 4 && by['PoE+'] === 4 && by['PoE'] === 4,
    'four of each class, as the datasheet counts them: ' + JSON.stringify(by));
  ok(powered.filter(function (i) { return i.poeOutClass === 'PoE++'; })
    .every(function (i) { return i.poeOut === 60; }), 'PoE++ sockets declare 60 W by PSE');
  ok(powered.filter(function (i) { return i.poeOutClass === 'PoE+'; })
    .every(function (i) { return i.poeOut === 30; }), 'PoE+ sockets declare 30 W by PSE');
  ok(powered.filter(function (i) { return i.poeOutClass === 'PoE'; })
    .every(function (i) { return i.poeOut === 15.4; }), 'PoE sockets declare 15.4 W by PSE');
  const cages = s.interfaces.filter(function (i) { return i.connector === 'sfp+'; });
  ok(cages.length === 2 && cages.every(function (i) { return i.poeOut === undefined; }),
    'neither SFP+ cage sources power');
  ok(s.poe && s.poe.budgetW === 420, 'the published 420 W allocation is kept (' + (s.poe && s.poe.budgetW) + ')');
}

console.log('\nTwo 21 W APs on eth0/eth4: the budget spends 42 W, and the cabled ceilings are 90 W, not 2 W');
{
  const ap = spec('U7-Pro');
  ok(!!ap, 'U7-Pro (21 W PoE+ PD) is in the catalogue');
  if (s && ap) {
    const t = new Topology();
    const udw = t.addDevice(s, 'udw');
    const ap1 = t.addDevice(ap, 'ap1');
    const ap2 = t.addDevice(ap, 'ap2');
    ok(udw.poeBudget === 420 && udw.poeBudgetSource === 'research',
      'the allocator sees 420 W from the spec (' + udw.poeBudget + ', ' + udw.poeBudgetSource + ')');
    ['eth0', 'eth4'].forEach(function (p, n) {
      t.connect('ap' + (n + 1), 'eth0', 'udw', p);
    });
    ok(udw.interfaces.get('eth0').poeOut === 60, 'eth0 offers 60 W (' + udw.interfaces.get('eth0').poeOut + ')');
    ok(udw.interfaces.get('eth4').poeOut === 30, 'eth4 offers 30 W (' + udw.interfaces.get('eth4').poeOut + ')');
    // poeDraw() sums the declared ceiling of every cabled PSE socket (60 + 30), which is the
    // number the old boolean read as 1 + 1.
    ok(udw.poeDraw() === 90, 'poeDraw() sums the cabled ceilings, 90 W, not 2 (' + udw.poeDraw() + ')');
    const sim = new Simulator(t);
    sim.computePoe();
    const row = sim.poe.filter(function (r) { return r.dev === 'udw'; })[0];
    ok(!!row && row.used === 42, 'show power inline spends 42 W of 420 (' + (row && row.used) + ')');
    ok(!!row && row.ports.length === 2 && row.ports.every(function (p) { return p.powered; }),
      'both APs are powered (' + (row && row.ports.length) + ')');
  }
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
