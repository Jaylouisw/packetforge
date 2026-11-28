'use strict';
// The four BR1 Mini SKUs are powered devices, and a powered device has one inlet.
//
// Every one of these rows carried the `poe-pd` capability and no port that said where power
// enters, so `derivePortHardware()` filled every copper port from the device class
// (`engine/media.js`, `isPoePd()`): a three-port router asked a switch for 3 x 12.95 W to run
// an 18 W box. The vendor does say which socket, just not on the sheet the rows cited.
//
//   https://www.peplink.com/compare/tech-specs/br1-mini.pdf
//     (HTTP 200, application/pdf, 226,453 B, 6 pp) page 6: "PoE Input Yes [11]", footnote
//     "[11] 1x 802.3at PoE", "Nominal Power Consumption 13W", "Maximum Power Consumption 18W"
//   https://download.peplink.com/manual/br1_mini_hw3_hardware_reference_guide.pdf
//     (HTTP 200, application/pdf, 4,816,585 B) back-panel drawing: "LAN 1 | 2 | 3 / WAN" with
//     "802.3at PoE IN" under LAN 1; parts list "1x GE LAN Port with 802.3at PoE Input"
//   https://download.peplink.com/resources/br1_mini_m2m_datasheet.pdf
//     (HTTP 200, application/pdf, 9,889,455 B) "Power over Ethernet 802.3at",
//     "Power Consumption 13W (nominal), 18W (max.)"
//   https://download.peplink.com/manual/br1_mini_m2m_hardware_reference_guide.pdf
//     (HTTP 200, application/pdf, 3,244,594 B) panel "LAN 1 | 2 / WAN", 802.3at PoE IN under LAN 1
//
// The inlet is LAN 1 on both boards, and the draw is the sheet maximum consumption - 18 W, not
// the 25.5 W an 802.3at class ceiling would let it ask for. LAN 2 (and LAN 3 / WAN) declare
// `poeIn: false`: a silence there is exactly what the class inference refills.
const path = require('path');
const { Topology, Simulator } = require('../engine');
const { loadCatalog } = require('../devices/registry');
let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices')).filter(function (s) { return !s.error; });
const FAMILY = ['MAX-BR1-MINI-LTE-E', 'MAX-BR1-MINI-LTEA-E', 'MAX-BR1-MINI-LTEA-W', 'MAX-BR1-MINI-M2M-HW3'];
function spec(model) {
  return catalog.find(function (s) { return s.vendor === 'peplink' && s.model === model; });
}

console.log('The BR1 Mini family is in the catalogue:');
for (const m of FAMILY) ok(!!spec(m), m + ' is in the catalogue');

console.log('\nEach SKU declares one inlet, on LAN 1, at the draw its own sheet prints:');
for (const m of FAMILY) {
  const s = spec(m);
  if (!s) { ok(false, m + ' is missing'); continue; }
  const copper = s.interfaces.filter(function (i) { return i.connector === 'rj45'; });
  const inlets = copper.filter(function (i) { return typeof i.poeIn === 'number'; });
  ok(inlets.length === 1, m + ': exactly one port draws power (' + inlets.length + ')');
  ok(inlets.length === 1 && inlets[0].name === 'lan1',
    m + ': and it is LAN 1, the port the panel marks 802.3at PoE IN',
    inlets.map(function (i) { return i.name; }).join(','));
  ok(inlets.length === 1 && inlets[0].poeIn === 18,
    m + ': at 18 W, the sheet maximum consumption (' + (inlets[0] && inlets[0].poeIn) + ')');
  const rest = copper.filter(function (i) { return i.name !== 'lan1'; });
  ok(rest.length > 0, m + ': has LAN ports that are not inlets (' + rest.length + ')');
  ok(rest.every(function (i) { return i.poeIn === false; }),
    m + ': and the other copper ports declare poeIn: false, not silence',
    rest.filter(function (i) { return i.poeIn !== false; }).map(function (i) {
      return i.name + '=' + JSON.stringify(i.poeIn);
    }).join(','));
  ok(!s.interfaces.some(function (i) { return i.poeOut; }),
    m + ': nothing on the box sources power');
  ok((s.capabilities || []).indexOf('poe-pd') !== -1, m + ': still declares the poe-pd capability');
}

console.log('\nWhat the engine exposes is the declared figure, not a guess:');
for (const m of FAMILY) {
  const s = spec(m);
  if (!s) continue;
  const dev = new Topology().addDevice(s, 'r1');
  const lan1 = dev.interfaces.get('lan1');
  ok(!!lan1 && lan1.hardware.poeIn === 18, m + ': lan1 carries 18 W into the board (' +
    (lan1 && lan1.hardware.poeIn) + ')');
  const others = [...dev.interfaces.values()].filter(function (i) {
    return i.type === 'ethernet' && i.name !== 'lan1';
  });
  ok(others.length > 0 && others.every(function (i) { return i.hardware.poeIn === false || i.hardware.poeIn === 0; }),
    m + ': and no other copper port was handed a draw (' +
    others.map(function (i) { return i.name + '=' + JSON.stringify(i.hardware.poeIn); }).join(',') + ')');
}

console.log('\nA PoE+ switch powers it at 18 W, once, on one cable:');
{
  const pse = catalog.find(function (s) { return s.vendor === 'peplink' && s.model === 'MAX-HD4-MBX-GLTE'; });
  const pd = spec('MAX-BR1-MINI-LTE-E');
  if (pse && pd) {
    const t = new Topology();
    t.addDevice(pse, 'mbx1');
    t.addDevice(pd, 'r1');
    t.connect('mbx1', 'lan1', 'r1', 'lan1');
    const entry = new Simulator(t).computePoe().find(function (e) { return e.dev === 'mbx1'; });
    ok(!!entry, 'computePoe() reports the switch');
    if (entry) {
      ok(entry.used === 18, 'and one BR1 Mini uses 18 W of the 305.7 W budget (' + entry.used + ')');
      const p = (entry.ports || []).find(function (x) { return x.iface === 'lan1'; });
      ok(!!p && p.powered === true, 'lan1 is powered (' + JSON.stringify(p) + ')');
    }
    ok(entry && entry.used !== 38.85, 'not the 3 x 12.95 W the class inference used to ask for');
  }
}
console.log('\nThe M2M row cites a datasheet that answers:');
{
  const m2m = spec('MAX-BR1-MINI-M2M-HW3');
  if (m2m) {
    ok(!/resources\/br1-mini-m2m\.pdf$/.test(String(m2m.sourceUrl)),
      'the dead https://download.peplink.com/resources/br1-mini-m2m.pdf (HTTP 403) is gone');
    ok(/br1_mini_m2m_datasheet\.pdf$/.test(String(m2m.sourceUrl)),
      'and the row cites the datasheet the product page links (' + m2m.sourceUrl + ')');
  }
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
