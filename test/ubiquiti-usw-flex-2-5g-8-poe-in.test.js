'use strict';
// The Flex 2.5G (non-PoE) was asking for 12.95 W on all nine copper sockets - 116.55 W of demand
// from a 14 W box, and from a model whose vendor sheet has no PoE output row at all.
//
// engine/media.js `derivePortHardware()` fills a silent `poeIn` from `isPoePd()`: a switch whose
// label matches /unifi/ becomes a 12.95 W device on every RJ45 socket. USW-Flex-2.5G-8 is the
// mains-or-PoE+ fed sibling of USW-Flex-2.5G-8-PoE (whose own inlet the sibling sheet already
// declares at Port 9); its eight 2.5G sockets source nothing and sink nothing, and its one inlet
// draws 14 W, not nine times 12.95.
//
// Every figure below is Ubiquiti's, read 2026-11-28 from
//   https://techspecs.ui.com/unifi/switching/usw-flex-2-5g-8   (200, 625,101 B, server-rendered table)
//     "Port Layout 2.5 GbE RJ45 8 (2.5G/1G/100M/10M) / 10 GbE RJ45 1 (10G/5G/2.5G/1G/100M) /
//      10G SFP+ 1 (10G/1G)"
//     "Max. Power Consumption 14W with PoE input / 14W with AC adapter input"
//     "Power Method (1) USB Type-C, 5V DC, 3A / (1) PoE+"
//     "Supported Voltage Range 4.8-5.2V DC/USB, 44V-57V PoE"
//   and the socket the inlet sits on, https://store.ui.com/us/en/products/usw-flex-2-5g-8
//     "8-port 2.5 GbE switch with a 10 GbE RJ45/SFP+ combination uplink port that can be powered
//      with a USB-C or PoE+ adapter."
// There is no datasheet text layer to read: https://dl.ui.com/ds/USW-Flex-2.5G-8_DS.pdf answers
// 200 with the 609,911-byte techspecs front page, which is why both URLs above are the sources.
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

const flex = spec('USW-Flex-2.5G-8');
ok(!!flex, 'USW-Flex-2.5G-8 is in the catalogue');

if (flex) {
  const copper = flex.interfaces.filter(function (i) { return (i.connector || 'rj45') === 'rj45'; });
  const bank = copper.filter(function (i) { return i.speed === '2.5G'; });
  const inlet = copper.filter(function (i) { return i.name === 'Port 9'; })[0];
  const cage = flex.interfaces.filter(function (i) { return i.connector === 'sfp+'; })[0];

  console.log('\nThe eight 2.5G sockets are neither PSEs nor PDs');
  ok(bank.length === 8, 'eight 2.5G RJ45 sockets (' + bank.length + ')');
  ok(bank.every(function (i) { return i.poeIn === false; }),
    'each declares poeIn: false, not a guessed 12.95 W');
  ok(bank.every(function (i) { return i.poeOut === undefined; }), 'and none of them sources power');

  console.log('\nThe 10G RJ45 uplink is the one inlet, at the vendor\'s 14 W');
  ok(!!inlet, 'the 10G copper socket is present');
  ok(inlet && inlet.poeIn === 14, 'it draws 14 W (' + (inlet && inlet.poeIn) + ')');
  ok(inlet && inlet.poeOut === undefined, 'and sources nothing');

  console.log('\nThe SFP+ cage carries no power either way');
  ok(!!cage, 'one 10G SFP+ cage is present');
  ok(cage && cage.poeIn === undefined && cage.poeOut === undefined, 'the cage has no PoE fields');

  console.log('\nNo capability claims power the sheet does not');
  ['poe-pse', 'poe-pd'].forEach(function (c) {
    ok(flex.capabilities.indexOf(c) === -1, 'it does not declare ' + c);
  });
  ok(!flex.poe || flex.poe.budgetW === undefined, 'and no PSE budget is recorded');
}

console.log('\nThe engine no longer sees nine powered devices');
if (flex) {
  const dev = new Topology().addDevice(flex);
  const ports = [...dev.interfaces.values()];
  const drawing = ports.filter(function (p) { return typeof p.hardware.poeIn === 'number' && p.hardware.poeIn > 0; });
  ok(drawing.length === 1 && drawing[0].name === 'Port 9',
    'exactly one port draws power (' + drawing.map(function (p) { return p.name; }).join(',') + ')');
  ok(drawing.every(function (p) { return p.hardware.poeIn === 14; }),
    'and it draws 14 W (' + drawing.map(function (p) { return p.hardware.poeIn; }).join(',') + ')');
  ok(ports.every(function (p) { return p.hardware.poeOut === null; }), 'no port sources power');
  const total = ports.reduce(function (n, p) {
    return n + (typeof p.hardware.poeIn === 'number' ? p.hardware.poeIn : 0);
  }, 0);
  ok(total === 14, 'the device asks for 14 W, not 116.55 W (' + total + ')');
}

console.log('\nA 30 W 802.3at switch upstream of Port 9 powers it at 14 W');
const uplinkModel = 'USW-Lite-16-PoE';
const uplink = spec(uplinkModel);
if (flex && uplink) {
  const t = new Topology();
  const pse = t.addDevice(uplink);
  const sw = t.addDevice(flex);
  const psePort = [...pse.interfaces.values()].filter(function (p) { return p.hardware.poeOut; })[0];
  t.connect(pse.id, psePort.name, sw.id, 'Port 9');
  const sim = new Simulator(t);
  sim.computePoe();
  const row = sim.poe.filter(function (p) { return p.dev === pse.id; })[0];
  ok(!!row, 'the upstream switch reports a PSE allocation');
  const pd = row && row.ports.filter(function (p) { return p.pd === sw.id; })[0];
  ok(!!pd && pd.draw === 14, 'charging the inlet 14 W (' + (pd && pd.draw) + ')');
  ok(!!pd && pd.powered, 'and it is powered');
} else {
  ok(false, uplinkModel + ' is in the catalogue for the two-party budget case');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
