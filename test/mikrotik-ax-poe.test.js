'use strict';
// The three MikroTik AX boxes - hAP ax², hAP ax³ and cAP ax - each carry one PoE-out port, and
// each of them was recorded wrong in the same two ways:
//
//   * the port was classed `PoE+` (802.3at, a negotiated 48 V standard) on hardware the vendor's own
//     manual calls "Passive PoE", and on two of the three the PSE was put on the wrong port
//     (eth5 on the ax², eth4 on the ax³);
//   * there was no `poe` block, so `engine/device.js` fell through to `parsePoeBudget('<model>')`,
//     found no number in a name like `C52iG-5HaxD2HaxD-TC`, and got 0 - a PSE that cannot be asked
//     how much it supplies (scripts/audit-poe-budget.js counts this cohort as "silent").
//
// The ax³ was also in the catalogue twice, and the copy that won the palette search had four copper
// ports where the vendor states five (4x 1G + 1x 2.5G), so a lab could not cable the 2.5G port at
// all. One product, one file: the duplicates are absorbed into the SKU-named entries.
//
// Every figure below is the vendor's, read 2026-11-20:
//   https://manual.mikrotik.com/hardware/hap-ax-2/  "PoE-out Passive PoE Ether1, max out per port
//       output (input < 30 V): 600mA"; "A number of 1G Ethernet ports 5"
//   https://mikrotik.com/product/hap_ax2         "Total output power 16.8W", "Total output current 0.6"
//   https://manual.mikrotik.com/hardware/hap-ax-3/  "PoE-out Passive PoE Ether1, max out per port
//       output (input < 30 V): 0.625 A"; "PoE-out total output power 15 W"; "Number of 1G Ethernet
//       ports 4"; "Number of 2.5G Ethernet ports 1 (supports PoE-in/out)"
//   https://mikrotik.com/product/cap_ax        "PoE-out ports Ether2", "PoE out Passive PoE up to 57V",
//       "Total output current 0.4", "Total output power 19.2"
//   https://manual.mikrotik.com/hardware/cap-ax/    "PoE-Out ports Ether2, max out per port output
//       (input < 30 V): 600 mA, max out per port output (input > 30 V): 400 mA"; "PoE-in 802.3af/at"
const path = require('path');
const { Topology } = require('../engine');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices')).filter(function (s) { return !s.error; });
function spec(model) {
  return catalog.find(function (s) { return s.vendor === 'mikrotik' && s.model === model; });
}
function copper(s) { return s.interfaces.filter(function (i) { return i.connector === 'rj45'; }); }
function pse(s) { return s.interfaces.filter(function (i) { return i.poeOut; }); }

const ax2 = spec('C52iG-5HaxD2HaxD-TC');
const ax3 = spec('C53UiG+5HPaxD2HPaxD');
const cap = spec('cAPGi-5HaxD2HaxD');

console.log('One file per box:');
[['hAP ax2', 'hAP ax\u00b2'], ['hAP ax3', 'hAP ax\u00b3'], ['cAP ax']].forEach(function (names) {
  names.forEach(function (n) {
    const shadow = catalog.filter(function (s) { return String(s.model).toLowerCase() === n.toLowerCase(); });
    ok(shadow.length === 0, 'no second entry is modelled as "' + n + '"');
  });
});
ok(!!ax2 && !!ax3 && !!cap, 'the three SKU-named entries are the survivors');

console.log('\nhAP ax²: the PoE-out is ether1 and it is passive:');
if (ax2) {
  ok(copper(ax2).length === 5, 'five RJ45 ports (' + copper(ax2).length + ')');
  ok(pse(ax2).length === 1 && pse(ax2)[0].name === 'eth1', 'exactly one PSE port, and it is eth1',
    pse(ax2).map(function (i) { return i.name; }).join(','));
  ok(pse(ax2)[0].poeOutClass === 'passive', 'and it is classed passive, not PoE+ (' + pse(ax2)[0].poeOutClass + ')');
  ok((ax2.capabilities || []).indexOf('802.3at') === -1, 'the spec claims no 802.3at capability');
  const dev = new Topology().addDevice(ax2, 'ax2');
  ok(dev.poeBudget === 16.8, 'budget 16.8 W, the vendor\'s "Total output power" (' + dev.poeBudget + ')');
  ok(dev.poeBudgetSource === 'research', 'and it comes from the spec, not the model name (' + dev.poeBudgetSource + ')');
  ok(/^https:\/\/mikrotik\.com\/product\/hap_ax2$/.test(String(ax2.poe && ax2.poe.sourceUrl)),
    'the budget cites the vendor page');
  ok((ax2.aliases || []).indexOf('hAP ax2') !== -1, 'the absorbed name "hAP ax2" is an alias');
}

console.log('\nhAP ax³: five copper ports, the 2.5G one is the PSE:');
if (ax3) {
  const eth = ax3.interfaces.filter(function (i) { return i.type === 'ethernet'; });
  ok(eth.length === 5, 'five Ethernet ports, not four (' + eth.length + ')');
  ok(eth.filter(function (i) { return i.speed === '2.5G'; }).length === 1, 'one of them is 2.5G');
  ok(eth[0].name === 'eth1' && eth[0].speed === '2.5G', 'the 2.5G port is eth1 (' + eth[0].name + ' ' + eth[0].speed + ')');
  ok(pse(ax3).length === 1 && pse(ax3)[0].name === 'eth1', 'the PSE is eth1, the 2.5G port',
    pse(ax3).map(function (i) { return i.name; }).join(','));
  ok(pse(ax3)[0].poeOutClass === 'passive', 'classed passive, not PoE+ (' + pse(ax3)[0].poeOutClass + ')');
  const dev = new Topology().addDevice(ax3, 'ax3');
  ok(dev.poeBudget === 15, 'budget 15 W, the vendor\'s "PoE-out total output power" (' + dev.poeBudget + ')');
  ok(/^https:\/\/manual\.mikrotik\.com\/hardware\/hap-ax-3\/$/.test(String(ax3.poe && ax3.poe.sourceUrl)),
    'the budget cites the hardware manual');
  const p = new Topology().addDevice(ax3, 'x').interfaces.get('eth1');
  ok(p && p.hardware && p.hardware.maxSpeedMbps === 2500,
    'eth1 is a 2500 Mbit/s cage in the engine (' + (p && p.hardware && p.hardware.maxSpeedMbps) + ')');
}

console.log('\ncAP ax: the PoE-out is ether2, passive, and the radios are radios:');
if (cap) {
  ok(copper(cap).length === 2, 'two RJ45 ports (' + copper(cap).length + ')');
  ok(pse(cap).length === 1 && pse(cap)[0].name === 'eth2', 'the PSE is eth2',
    pse(cap).map(function (i) { return i.name; }).join(','));
  ok(pse(cap)[0].poeOutClass === 'passive', 'classed passive, not PoE+ (' + pse(cap)[0].poeOutClass + ')');
  const radios = cap.interfaces.filter(function (i) { return i.type === 'wireless'; });
  ok(radios.length === 2 && radios.every(function (r) { return r.speed !== '1G'; }),
    'the two radios carry radio rates, not 1G (' + radios.map(function (r) { return r.speed; }).join(',') + ')');
  ok((cap.capabilities || []).indexOf('poe-pd') !== -1, 'it still declares poe-pd: 802.3af/at on the input');
  const dev = new Topology().addDevice(cap, 'cap');
  ok(dev.poeBudget === 19.2, 'budget 19.2 W, the vendor\'s "Total output power" (' + dev.poeBudget + ')');
  ok(/^https:\/\/mikrotik\.com\/product\/cap_ax$/.test(String(cap.poe && cap.poe.sourceUrl)),
    'the budget cites the vendor page');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
