'use strict';
// The Flex 2.5G sourced 802.3af watts on all nine copper sockets, and advertised its power inlet as a PSE.
//
// USW-Flex-2.5G-8-PoE shipped a `poe.budgetW` (196) and no PoE direction on any port. engine/media.js
// `derivePortHardware()` fills that silence: a copper port on a switch whose label says PoE becomes a 15.4 W
// PSE. The vendor's own table says the eight 2.5G sockets are "All PoE++" with a 64 W PSE ceiling, and the
// ninth copper socket - the 10G RJ45 - is the box's power INLET ("Power Method: (1) AC/DC adapter (Excluded),
// (1) PoE+++"), so the engine was handing out watts from the socket that consumes them.
//
// Every figure below is Ubiquiti's, read 2026-11-21 from
//   https://techspecs.ui.com/unifi/switching/usw-flex-2-5g-8-poe   (200, 632,312 B, server-rendered table)
//     "Port Layout 2.5 GbE RJ45 8 (All PoE++) (2.5G/1G/100M/10M) / 10 GbE RJ45 1 (PoE+++) (10G/5G/2.5G/1G/100M)
//      / 10G SFP+ 1 (10G/1G)"
//     "PoE Ports PoE++ 8"; "Max. PoE Wattage per Port by PSE PoE 15.4W / PoE+ 32W / PoE++ 64W"
//     "Max. PoE Output Up to PoE++"; "Total PoE Availability PoE+++ input: 76W / PoE++ input: 46W /
//      PoE+ input: 16W / 210W AC adapter input: 196W"
//     "Max. Power Consumption 14W (Excluding PoE output) with PoE input"
// There is no datasheet text layer: https://dl.ui.com/ds/usw-flex-2-5g-8-poe_ds.pdf answers 200 with the
// 609,911-byte techspecs front page.
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

const flex = spec('USW-Flex-2.5G-8-PoE');
ok(!!flex, 'USW-Flex-2.5G-8-PoE is in the catalogue');
if (flex) {
  const copper = flex.interfaces.filter(function (i) { return i.connector === 'rj45'; });
  const outlets = copper.filter(function (i) { return i.name !== 'Port 9'; });
  const inlet = copper.filter(function (i) { return i.name === 'Port 9'; })[0];
  const cages = flex.interfaces.filter(function (i) { return i.connector === 'sfp+'; });

  console.log('\nThe eight 2.5G sockets are the vendor\'s PoE++ bank at 64 W per port by PSE');
  ok(outlets.length === 8, 'eight 2.5G RJ45 outlets (' + outlets.length + ')');
  ok(outlets.every(function (i) { return i.speed === '2.5G'; }), 'all at 2.5G');
  ok(outlets.every(function (i) { return i.poeOut === 64; }),
    'each sources 64 W: ' + [...new Set(outlets.map(function (i) { return i.poeOut; }))].join(','));
  ok(outlets.every(function (i) { return i.poeOutClass === 'PoE++'; }), 'and carries the vendor class word PoE++');
  ok(outlets.every(function (i) { return i.poeIn === undefined; }), 'none of them accepts power in');

  console.log('\nThe 10G RJ45 is the power inlet, not a ninth PSE');
  ok(!!inlet, 'the 10G copper socket is present');
  ok(inlet && inlet.poeIn === 90, 'it draws 90 W (' + (inlet && inlet.poeIn) + ')');
  ok(inlet && inlet.poeOut === undefined, 'and sources nothing');
  ok(inlet && inlet.speedCaps && inlet.speedCaps.indexOf(5000) !== -1,
    'the inlet takes 10G/5G/2.5G/1G/100M, as the vendor prints');

  console.log('\nThe cage and the standards');
  ok(cages.length === 1, 'one 10G SFP+ cage (' + cages.length + ')');
  ok(cages.every(function (i) { return i.poeOut === undefined && i.poeIn === undefined; }),
    'the cage neither sources nor sinks power');
  ['poe-pse', '802.3af', '802.3at', '802.3bt'].forEach(function (c) {
    ok(flex.capabilities.indexOf(c) !== -1, 'capability ' + c + ' is declared');
  });
  ok(flex.poe && flex.poe.budgetW === 196, 'the 196 W AC-adapter budget is recorded');

  console.log('\nThe engine now reports the vendor figures, not the 802.3af default');
  const dev = new Topology().addDevice(flex);
  const pse = [...dev.interfaces.values()].filter(function (p) { return p.hardware && p.hardware.poeOut; });
  ok(pse.length === 8, 'eight PSE ports (' + pse.length + ')');
  ok(pse.every(function (p) { return p.hardware.poeOut === 64; }),
    'each at 64 W: ' + [...new Set(pse.map(function (p) { return p.hardware.poeOut; }))].join(','));
  const inletPort = dev.interfaces.get('Port 9');
  ok(inletPort.hardware.poeOut === null, 'Port 9 is not a PSE any more (' + inletPort.hardware.poeOut + ')');
  ok(inletPort.hardware.poeIn === 90, 'it is the powered device on the uplink (' + inletPort.hardware.poeIn + ')');
}

console.log('\nA 22 W access point on Port 1 is powered inside the budget');
if (flex) {
  const ap = spec('U6 Enterprise');
  const t = new Topology();
  const sw = t.addDevice(flex);
  const u6 = ap ? t.addDevice(ap) : null;
  if (u6) {
    t.connect(u6.id, u6.interfaces.has('eth0') ? 'eth0' : u6.interfaces.keys().next().value, sw.id, 'Port 1');
    const sim = new Simulator(t);
    sim.computePoe();
    const flexRow = sim.poe.filter(function (p) { return p.dev === sw.id; })[0];
    ok(!!flexRow, 'the Flex is accounted for as a PSE');
    ok(flexRow && flexRow.ports.some(function (p) { return p.powered && p.draw === 22; }),
      'the 22 W AP is powered at its declared draw');
    ok(flexRow && flexRow.used === 22, 'and only 22 W of the 196 W budget is spent (' + (flexRow && flexRow.used) + ')');
  }
}

console.log('\nA PoE+++ source upstream of Port 9 sees the switch as a 90 W load');
if (flex) {
  const src = spec('M4250-10G2XF-PoE++ (GSM4212UX)');
  if (src) {
    const t = new Topology();
    const uplink = t.addDevice(src);
    const sw = t.addDevice(flex);
    t.connect(sw.id, 'Port 9', uplink.id, 'port1');
    const sim = new Simulator(t);
    sim.computePoe();
    const row = sim.poe.filter(function (p) { return p.dev === uplink.id; })[0];
    ok(!!row, 'the upstream switch reports a PSE allocation');
    const pd = row && row.ports.filter(function (p) { return p.pd === sw.id; })[0];
    ok(!!pd && pd.draw === 90, 'charging the inlet its full 90 W (' + (pd && pd.draw) + ')');
    ok(!!pd && pd.powered, 'and it is powered: the source port is a 90 W 802.3bt port');
  }
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
