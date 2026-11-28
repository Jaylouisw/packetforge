'use strict';
// Three more Peplink rows that declared `poe-pd` and no inlet, so `derivePortHardware()` filled
// every copper port from the device class (`engine/media.js`, `isPoePd()`): the IP55 asked for
// 3 x 12.95 W, the HD2 Mini 3 x 12.95 W, the BR2 Pro 6 x 12.95 W.
//
// The vendor names the socket in each case, and not always on the sheet the row cites:
//
//   MAX-BR1-IP55    https://download.peplink.com/resources/pepwave_max_br_ip55_datasheet.pdf
//                   (200, application/pdf) panel: "1x 10/100/1000M Ethernet WAN (PoE Input)" and
//                   "2x 10/100/1000M Ethernet LAN (LAN1 - 802.3at PoE Output)";
//                   tech spec: Max. 18W, Typical 11W, Min. 8W.
//   MAX-HD2-MINI    https://download.peplink.com/resources/pepwave_max_hd2_mini_datasheet.pdf
//                   panel: "1x 100/1000M Ethernet WAN/LAN with 802.3at PoE Input",
//                   "2x 100/1000M Ethernet LAN with 802.3at PoE #" (outputs, kit ACW-609);
//                   tech spec: "Maximum Power Consumption 15W (w/o PoE)".
//   MAX BR2 Pro 5G  https://download.peplink.com/manual/br2_pro_hardware_reference_guide.pdf
//                   "1x GE WAN/LAN Port with 802.3at PoE Input" beside "4x GE LAN Ports" and
//                   "1x 2.5Gbps WAN Port"; tech spec: "PoE Input Yes [15]", "[15] 1x 802.3at PoE
//                   port provide a power supply of 25W ... If you require 30W ... use the bundled
//                   power adapter".
//
// The inlet is the WAN-side port on all three (the BR2's GE WAN/LAN is `wan2` in this file), and
// the draw is the sheet's figure for the PoE inlet, not the class ceiling: 18 W, 15 W, 25 W.
const path = require('path');
const { Topology, Simulator } = require('../engine');
const { loadCatalog } = require('../devices/registry');
let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices')).filter(function (s) { return !s.error; });
const ROWS = [
  { model: 'MAX-BR1-IP55', inlet: 'wan1', watts: 18, copper: 3 },
  { model: 'MAX-HD2-MINI', inlet: 'wan1', watts: 15, copper: 3 },
  { model: 'MAX BR2 Pro 5G', inlet: 'wan2', watts: 25, copper: 6 }
];
function spec(model) {
  return catalog.find(function (s) { return s.vendor === 'peplink' && s.model === model; });
}

console.log('The rows are in the catalogue:');
for (const r of ROWS) ok(!!spec(r.model), r.model + ' is in the catalogue');

console.log('\nEach row declares one inlet, on the port its own panel marks:');
for (const r of ROWS) {
  const s = spec(r.model);
  if (!s) { ok(false, r.model + ' is missing'); continue; }
  const copper = s.interfaces.filter(function (i) { return i.connector === 'rj45'; });
  ok(copper.length === r.copper, r.model + ': ' + r.copper + ' copper ports (' + copper.length + ')');
  const inlets = copper.filter(function (i) { return typeof i.poeIn === 'number'; });
  ok(inlets.length === 1, r.model + ': exactly one port draws power (' + inlets.length + ')');
  ok(inlets.length === 1 && inlets[0].name === r.inlet,
    r.model + ': and it is ' + r.inlet,
    inlets.map(function (i) { return i.name; }).join(','));
  ok(inlets.length === 1 && inlets[0].poeIn === r.watts,
    r.model + ': at ' + r.watts + ' W (' + (inlets[0] && inlets[0].poeIn) + ')');
  const rest = copper.filter(function (i) { return i.name !== r.inlet; });
  ok(rest.every(function (i) { return i.poeIn === false; }),
    r.model + ': the other copper ports declare poeIn: false, not silence',
    rest.filter(function (i) { return i.poeIn !== false; }).map(function (i) {
      return i.name + '=' + JSON.stringify(i.poeIn);
    }).join(','));
  ok(!s.interfaces.some(function (i) { return i.poeOut; }),
    r.model + ': nothing on the box sources power in this file');
  ok((s.capabilities || []).indexOf('poe-pd') !== -1, r.model + ': still declares the poe-pd capability');
  ok(/poeIn/.test(String(s.notes)), r.model + ': the notes say which socket and why');
}

console.log('\nThe engine exposes the declared figure, not the class guess:');
for (const r of ROWS) {
  const s = spec(r.model);
  if (!s) continue;
  const dev = new Topology().addDevice(s, 'r1');
  const inlet = dev.interfaces.get(r.inlet);
  ok(!!inlet && inlet.hardware.poeIn === r.watts,
    r.model + ': ' + r.inlet + ' carries ' + r.watts + ' W (' + (inlet && inlet.hardware.poeIn) + ')');
  const others = [...dev.interfaces.values()].filter(function (i) {
    return i.type === 'ethernet' && i.name !== r.inlet;
  });
  ok(others.length > 0 && others.every(function (i) { return i.hardware.poeIn === false || i.hardware.poeIn === 0; }),
    r.model + ': no other copper port was handed a draw (' +
    others.map(function (i) { return i.name + '=' + JSON.stringify(i.hardware.poeIn); }).join(',') + ')');
}

console.log('\nThe BR2 Pro takes the 25 W its PoE inlet supplies, not the 30 W mains figure:');
{
  const s = spec('MAX BR2 Pro 5G');
  if (!s) { ok(false, 'BR2 Pro is missing'); }
  else {
    const inlet = s.interfaces.find(function (i) { return i.name === 'wan2'; });
    ok(inlet && inlet.poeIn === 25, 'wan2 declares 25 W, the 802.3at port the guide names');
    ok(!s.interfaces.some(function (i) { return i.poeIn === 30; }),
      'no port claims the 30 W the box can only reach on its own PSU');
    ok(s.interfaces.find(function (i) { return i.name === 'wan1'; }).poeIn === false,
      'the 2.5G WAN is not an inlet');
  }
}

console.log('\nA PoE+ switch powers each one once, on one cable:');
for (const r of ROWS) {
  const pse = catalog.find(function (s) { return s.vendor === 'peplink' && s.model === 'MAX-HD4-MBX-GLTE'; });
  const pd = spec(r.model);
  if (!pse || !pd) { ok(false, r.model + ': missing PSE or PD'); continue; }
  const t = new Topology();
  t.addDevice(pse, 'mbx1');
  t.addDevice(pd, 'r1');
  t.connect('mbx1', 'lan1', 'r1', r.inlet);
  const entry = new Simulator(t).computePoe().find(function (e) { return e.dev === 'mbx1'; });
  ok(!!entry, r.model + ': computePoe() reports the switch');
  if (entry) {
    ok(entry.used === r.watts, r.model + ': uses ' + r.watts + ' W of the MBX budget (' + entry.used + ')');
    const p = (entry.ports || []).find(function (x) { return x.iface === 'lan1'; });
    ok(!!p && p.powered === true, r.model + ': ' + r.inlet + ' is powered (' + JSON.stringify(p) + ')');
  }
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
