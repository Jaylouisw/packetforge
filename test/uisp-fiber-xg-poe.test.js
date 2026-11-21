'use strict';
// Fiber XG is Ubiquiti's XGPON ONU - one 2.5G RJ45 jack and one SC/APC PON port - and that single
// copper jack was filed as a PoE *output*: `poeOut: true, poeOutClass: "PoE"` (802.3af, a
// negotiated 48 V standard) on the very port the ONU is powered from. `poeDraw()` bills a bare
// `true` as 1 W, so the box advertised a PSE it does not have, and `show power inline` had a port
// to report against a budget the vendor never prints.
//
// The vendor says the opposite, three times over, read 2026-11-21:
//   https://techspecs.ui.com/uisp/fiber/uisp-fiber-xg  (200, rendered spec table)
//   https://dl.ui.com/ds/uisp-fiber-xg_ds.pdf          (200, application/pdf, 1,056,083 B, 3 pp,
//                                                       text layer)
//   https://store.ui.com/us/en/products/uisp-fiber-xg  (200, US store listing)
//     "Networking interface (1) SC/APC, ITU-G.987 XGPON WAN port, (1) 100/1,000/2,500 MbE RJ45
//      LAN ports"; "PoE interface (1) PoE in, 24V DC passive PoE"; "Max. power consumption 6W";
//     "Power supply Passive PoE 2-pair (4, 5+; 7, 8-)"; "Supported voltage range 10-30V DC passive PoE".
// One PoE interface, and it is an input. So: poeIn 6 W, no poeOut anywhere, and the 2.5G jack can
// never light a downstream radio.
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

const onu = spec('UISP-FIBER-XG');
const radio = spec('NBE-5AC-Gen2');

console.log('The ONU is in the catalogue with the vendor\'s port census:');
ok(!!onu, 'UISP-FIBER-XG is in the catalogue');
ok(!!radio, 'NBE-5AC-Gen2 (a 24 V passive airMAX radio) is in the catalogue');

if (onu) {
  const copper = onu.interfaces.filter(function (i) { return i.connector === 'rj45'; });
  const pon = onu.interfaces.filter(function (i) { return i.type === 'pon'; });
  ok(copper.length === 1, 'one RJ45 port (' + copper.length + ')');
  ok(pon.length === 1, 'one PON port (' + pon.length + ')');
  ok(copper[0].speed === '2.5G', 'the RJ45 port is 2.5G (' + copper[0].speed + ')');

  console.log('\nThe RJ45 jack is the power inlet, not a PSE:');
  ok(copper[0].poeIn === 6, 'it sinks 6 W, the vendor\'s max consumption (' + copper[0].poeIn + ')');
  ok(copper[0].poeOut === undefined,
    'and declares no poeOut (' + JSON.stringify(copper[0].poeOut) + ')');
  ok(copper[0].poeOutClass === undefined,
    'and no 802.3af class on a 24 V passive inlet (' + JSON.stringify(copper[0].poeOutClass) + ')');
  ok((onu.capabilities || []).indexOf('poe-pse') === -1, 'the row claims no poe-pse capability');
  ok((onu.capabilities || []).indexOf('poe-pd') !== -1, 'it claims poe-pd');
  ok((onu.capabilities || []).indexOf('802.3af') === -1 && (onu.capabilities || []).indexOf('802.3at') === -1,
    'and claims no 802.3af/at');

  console.log('\nThe engine agrees: a PON ONU has no PSE ports and no budget to spend:');
  const t = new Topology();
  const dev = t.addDevice(onu, 'onu1');
  const pse = [...dev.interfaces.values()].filter(function (i) { return i.hardware && i.hardware.poeOut; });
  ok(pse.length === 0, 'every interface is dry (' + pse.length + ' PSE)');
  ok(dev.poeBudget === 0, 'and the PoE budget is 0 (' + dev.poeBudget + ')');

  if (radio) {
    const ap = t.addDevice(radio, 'ap1');
    const link = t.connect(dev.id, 'eth0', ap.id, 'eth0');
    ok(!!link, 'an airMAX radio cables to the ONU\'s 2.5G jack');
    const sim = new Simulator(t);
    sim.computePoe();
    const entry = (sim.poe || []).filter(function (p) { return p.dev === dev.id; })[0];
    ok(!entry, 'and the ONU is absent from the PoE table rather than claiming to power it (' +
      JSON.stringify(entry) + ')');
    ok(dev.poeDraw() === 0, 'poeDraw() is 0 W (' + dev.poeDraw() + ')');
  }
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
