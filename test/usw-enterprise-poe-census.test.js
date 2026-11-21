'use strict';
// The Enterprise PoE switches sourced 802.3af watts on 802.3at ports.
//
// USW-Enterprise-8-PoE and USW-Enterprise-24-PoE shipped a `poe.budgetW` and no `poeOut` on any copper port. That
// did not leave the ports dark - engine/media.js `derivePortHardware()` falls back to the 802.3af default when a
// copper port declares no PoE direction - but it made every port a 15.4 W PSE on a box whose whole copper bank the
// vendor calls PoE+. The faceplate tooltip ("PoE out 15.4 W") and the port detail panel ("PSE, 15.4 W out") both
// print the derived figure, so a lab sizing the 25.5 W PD a WiFi 6E AP draws read the switch as unable to power it.
//
// Every figure below is the vendor's, read 2026-11-21:
//   https://dl.ui.com/ds/usw-enterprise-8-poe_ds.pdf   (200, application/pdf, 526,714 B, 2 pp)
//     "Networking interface (8) 1/2.5 GbE RJ45", "SFP+ interface (2) 1/10 Gbps SFP+",
//     "PoE interface (8) PoE/PoE+ (Pins 1, 2+; 3, 6-)", "Max. PoE+ wattage per port by PSE 32W",
//     "Max PoE power 120W", "Power method (1) 100-240V AC ... Universal Input".
//   https://dl.ui.com/ds/usw-enterprise-24-poe_ds.pdf  (200, application/pdf, 397,353 B, 2 pp)
//     "Networking interface (12) 10/100/1000 MbE RJ45 / (12) 100/1000/2500 MbE RJ45", "(2) 1/10G SFP+",
//     "PoE interface (24) PoE/PoE+ (Pins 1, 2+; 3, 6-)", "Max. PoE+ wattage per port by PSE 34.2W",
//     "PoE budget 400W".
//   https://techspecs.ui.com/unifi/switching/usw-enterprise-8-poe   (200, 648,955 B, rendered spec table)
//     "2.5 GbE RJ45 = 8 (All PoE+) (2.5G/1G/100/10M)", "PoE+ = 8", "Total PoE Availability = 120W".
//   https://techspecs.ui.com/unifi/switching/usw-enterprise-24-poe  (200, 650,004 B, rendered spec table)
//     "1 GbE RJ45 = 12 (All PoE+)", "2.5 GbE RJ45 = 12 (All PoE+)", "PoE+ = 24",
//     "Total PoE Availability = 400W".
const path = require('path');
const { Topology } = require('../engine');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices')).filter(function (s) { return !s.error; });
function spec(model) { return catalog.filter(function (s) { return s.model === model; })[0]; }

[['USW-Enterprise-8-PoE', 8, 32, 120], ['USW-Enterprise-24-PoE', 24, 34.2, 400]]
  .forEach(function (row) {
    const model = row[0], copperCount = row[1], perPort = row[2], budget = row[3];
    const sw = spec(model);
    ok(!!sw, model + ' is in the catalogue');
    if (!sw) return;
    const copper = sw.interfaces.filter(function (i) { return i.connector === 'rj45'; });
    const cages = sw.interfaces.filter(function (i) { return i.connector === 'sfp+'; });

    console.log('\n' + model + ': ' + copperCount + ' PoE+ RJ45 ports at the vendor\'s ' + perPort + ' W PSE ceiling');
    ok(copper.length === copperCount, copperCount + ' RJ45 ports (' + copper.length + ')');
    ok(cages.length === 2, 'two SFP+ cages (' + cages.length + ')');
    ok(cages.every(function (i) { return i.poeOut === undefined; }), 'the cages are not PSE ports');
    ok(copper.every(function (i) { return i.poeOut === perPort; }),
      'every copper port sources ' + perPort + ' W: ' + [...new Set(copper.map(function (i) { return i.poeOut; }))].join(','));
    ok(copper.every(function (i) { return i.poeOutClass === 'PoE+'; }),
      'and carries the vendor class word PoE+');
    ok(copper.every(function (i) { return i.poeIn === undefined; }),
      "no copper port accepts PoE in (the map's power method is AC input)");
    ['poe-pse', '802.3af', '802.3at'].forEach(function (c) {
      ok(sw.capabilities.indexOf(c) !== -1, 'capability ' + c + ' is declared');
    });
    ok(sw.poe && sw.poe.budgetW === budget, 'the ' + budget + ' W budget is unchanged');

    const dev = new Topology().addDevice(sw);
    const pse = [...dev.interfaces.values()].filter(function (p) { return p.hardware && p.hardware.poeOut; });
    ok(pse.length === copperCount, 'the engine sees ' + copperCount + ' PSE ports (' + pse.length + ')');
    ok(pse.every(function (p) { return p.hardware.poeOut === perPort; }),
      'and reports ' + perPort + ' W, not the 802.3af default: ' +
      [...new Set(pse.map(function (p) { return p.hardware.poeOut; }))].join(','));
  });

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
