'use strict';
// The three UniFi "Pro ... PoE" rack switches shipped a PoE budget and no PoE direction on any port.
//
// USW-Pro-24-PoE (400 W), USW-Pro-48-PoE (600 W) and USW-Pro-Max-48-PoE (720 W) each declared
// `poe.budgetW` and left every RJ45 socket's `poeOut` unset. engine/media.js `derivePortHardware()`
// reads that silence as the 802.3af ceiling - a copper port on a switch whose label says PoE becomes
// a 15.4 W PSE - so web/faceplate.js printed "PoE out 15.4 W" on every socket of a chassis that the
// datasheet rates 802.3at and 802.3bt. A lab asking "can this port power a 25.5 W U6-Enterprise"
// got the wrong answer on all 24, 48 and 48 sockets respectively. Worse on the Max 48: the budget
// (720 W) and the per-port default (15.4 W) cannot both be true of the same box.
//
// Every figure below is Ubiquiti's, read 2026-11-21.
//   https://dl.ui.com/ds/usw-pro-24-poe_ds.pdf  (200, application/pdf, 443,168 B, 2 pp)
//     "Networking interface (24) GbE RJ45 ports / (2) 1/10G SFP+ ports"
//     "PoE interface (16) PoE/PoE+ (Pins 1, 2+; 3, 6-) / (8) 60W PoE++; PoE/PoE+ ..."
//     "Total available PoE 400W"; "Max PoE wattage per port by PSE PoE+: 32W / PoE++: 64W"
//   https://dl.ui.com/ds/usw-pro-48-poe_ds.pdf  (200, application/pdf, 450,616 B, 2 pp)
//     "PoE interface (40) PoE/PoE+ ... / (8) 60W PoE++"; "Total available PoE 600W"; same 32W/64W row
//   https://techspecs.ui.com/unifi/switching/usw-pro-24-poe  (200, 654,711 B) - "24 (16 PoE+; 8 PoE++)",
//     "10G SFP+ 2", "Total PoE Availability 400W", and a lower per-port row "PoE+ 30W / PoE++ 60W"
//   https://techspecs.ui.com/unifi/switching/usw-pro-48-poe  (200, 656,334 B) - "48 (40 PoE+; 8 PoE++)",
//     "Total PoE Availability 600W", "PoE+ 32W / PoE++ 60W"
//   https://techspecs.ui.com/unifi/switching/usw-pro-max-48-poe (200, 661,949 B)
//     "1 GbE RJ45 32 (24 PoE+; 8 PoE++)", "2.5 GbE RJ45 16 (8 PoE+; 8 PoE++)", "10G SFP+ 4",
//     "Total PoE Availability 720W", "PoE+ 32W / PoE++ 64W"
// The datasheet PDFs and the techspecs table disagree by 2 W on the PoE+ ceiling (Pro 24) and on
// PoE++ (Pro 24, Pro 48); the specs carry the datasheet figures and record the disagreement in
// `notes`. Ubiquiti prints counts, never port numbers, so the PoE++ banks are the upper-numbered
// sockets of each speed bank - the ordering this catalogue already applies to USW-Pro-Max-24-PoE.
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

const rows = [
  { model: 'USW-Pro-24-PoE',      copper: 24, poePlus: 16, budget: 400 },
  { model: 'USW-Pro-48-PoE',      copper: 48, poePlus: 40, budget: 600 },
  { model: 'USW-Pro-Max-48-PoE',  copper: 48, poePlus: 32, budget: 720 }
];

rows.forEach(function (row) {
  const s = spec(row.model);
  console.log('\n' + row.model + ': every copper socket is a PSE, and the vendor says at which class');
  ok(!!s, row.model + ' is in the catalogue');
  if (!s) return;

  const copper = s.interfaces.filter(function (i) { return i.connector === 'rj45'; });
  const cages = s.interfaces.filter(function (i) { return i.connector === 'sfp+'; });
  const plus = copper.filter(function (i) { return i.poeOutClass === 'PoE+'; });
  const plusPlus = copper.filter(function (i) { return i.poeOutClass === 'PoE++'; });

  ok(copper.length === row.copper, row.copper + ' RJ45 sockets (' + copper.length + ')');
  ok(copper.every(function (i) { return typeof i.poeOut === 'number' && i.poeOut > 0; }),
    'every one declares the watts it sources');
  ok(plus.length === row.poePlus, row.poePlus + ' at the PoE+ ceiling (' + plus.length + ')');
  ok(plus.every(function (i) { return i.poeOut === 32; }), 'each 32 W by PSE');
  ok(plusPlus.length + plus.length === copper.length,
    'the rest are PoE++ and nothing is left classless (' + plusPlus.length + ')');
  ok(plusPlus.every(function (i) { return i.poeOut === 64; }), 'each 64 W by PSE');
  ok(cages.length === 4 || cages.length === 2, 'the SFP+ cages are present (' + cages.length + ')');
  ok(cages.every(function (i) { return i.poeOut === undefined; }), 'and none of them sources power');

  ['poe-pse', '802.3af', '802.3at', '802.3bt'].forEach(function (c) {
    ok(s.capabilities.indexOf(c) !== -1, 'capability ' + c + ' is declared');
  });
  ok(s.poe && s.poe.budgetW === row.budget, 'the ' + row.budget + ' W budget is recorded');

  const dev = new Topology().addDevice(s);
  const psePorts = [...dev.interfaces.values()].filter(function (p) { return p.hardware && p.hardware.poeOut; });
  ok(psePorts.length === row.copper, 'the engine sees ' + row.copper + ' PSE ports (' + psePorts.length + ')');
  ok(psePorts.every(function (p) { return p.hardware.poeOut !== 15.4; }),
    'none of them falls back to the 802.3af 15.4 W default');
  const first = dev.interfaces.get('Port 1');
  ok(first && first.hardware.poeOut === 32, 'Port 1 sources 32 W (' + (first && first.hardware.poeOut) + ')');
});

console.log('\nA 25.5 W load on a PoE+ socket is powered, and the budget is enforced at the vendor figure');
const s24 = spec('USW-Pro-24-PoE');
if (s24) {
  const ap = spec('U6 Enterprise');
  ok(!!ap, 'U6 Enterprise is available as the load');
  if (ap) {
    const t = new Topology();
    const sw = t.addDevice(s24);
    const u6 = t.addDevice(ap);
    t.connect(u6.id, u6.interfaces.has('eth0') ? 'eth0' : u6.interfaces.keys().next().value, sw.id, 'Port 1');
    const sim = new Simulator(t);
    sim.computePoe();
    const row = sim.poe.filter(function (p) { return p.dev === sw.id; })[0];
    ok(!!row, 'the switch is accounted for as a PSE');
    ok(row && row.ports.some(function (p) { return p.powered && p.draw === 22; }),
      'the 22 W AP is powered at its declared draw');
    ok(row && row.used === 22, 'and only 22 W of the 400 W budget is spent (' + (row && row.used) + ')');
  }
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
