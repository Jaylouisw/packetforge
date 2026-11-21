'use strict';
// The Gen1 UniFi 48-port PoE pair declared a `poeOut` on all 48 copper ports, but as the bare
// boolean `true`. engine/media.js `poeDraw()` sums `true` as 1 W and the faceplate's `num()` prints
// nothing, so a chassis Ubiquiti rates at 34.2 W per socket by PSE reserved 1 W a socket and 20
// cabled 25.5 W APs reported 20 W of draw against a 500 W budget. The catalogue also carried only
// the two 1G SFP cages - 50 jacks for 52 physical - so the 10G SFP+ pair was uncabled.
//
// Every figure below is Ubiquiti's, read 2026-11-21:
//   https://dl.ui.com/qsg/US-48-500W_US-48-750W/US-48-500W_US-48-750W_EN.html  (200, 19,990 B)
//     "Model: US-48-500W, US-48-750W"; "Networking (48) 10/100/1000 Mbps RJ45 Ethernet Ports /
//      (2) 1/10 Gbps SFP+ Ethernet Ports / (2) 1 Gbps SFP Ethernet Ports"; "Management (1) RJ45
//      Serial Port Out-of-Band, Ethernet In-Band"; "PoE Interfaces POE+ IEEE 802.3af/at
//      (Pins 1, 2+; 3, 6-)"; "Max. PoE+ Wattage per Port by PSE 34.2W"; "Voltage Range 802.3at
//      Mode 50-57V"; "RJ45 ports support Power over Ethernet (PoE) and 10/100/1000 Ethernet
//      connections".
//   https://techspecs.ui.com/unifi/switching/us-48-500w  (200, 626,072 B)
//   https://techspecs.ui.com/unifi/switching/us-48-750w  (200, 619,881 B)
//     "1 GbE RJ45 48 (All PoE+) (1G/100M/10M)"; "1G SFP 2 (1G)"; "10G SFP+ 2 (10G/1G)";
//     "Max. PoE Output Up to PoE+"; "Total PoE Availability 500W" / "... 750W"; "PoE Ports PoE+ 48"
//     (the 500 W page; the 750 W page prints the port count only in its Port Layout row).
// The QSG's PoE LED legend also names "24V Passive PoE" on ports 1-48, but neither surface prints a
// passive per-port wattage, so `passive-poe` is not declared and no passive ceiling is invented.
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

const CASES = [['US-48-500W', 500], ['US-48-750W', 750]];

for (const [model, budget] of CASES) {
  const s = spec(model);
  console.log('\n' + model + ': all 48 copper sockets are 34.2 W PoE+ PSEs');
  ok(!!s, model + ' is in the catalogue');
  if (!s) continue;

  const copper = s.interfaces.filter(function (i) { return i.connector === 'rj45'; });
  const sfpPlus = s.interfaces.filter(function (i) { return i.connector === 'sfp+'; });
  const sfp = s.interfaces.filter(function (i) { return i.connector === 'sfp'; });
  const consoles = s.interfaces.filter(function (i) { return i.type === 'console'; });

  ok(copper.length === 48, '48 RJ45 ports (' + copper.length + ')');
  ok(copper.every(function (i) { return i.poeOut === 34.2; }),
    'each declares 34.2 W: ' + [...new Set(copper.map(function (i) { return i.poeOut; }))].join(','));
  ok(copper.every(function (i) { return typeof i.poeOut === 'number'; }),
    'as a number, not the bare direction bit it shipped before');
  ok(copper.every(function (i) { return i.poeOutClass === 'PoE+'; }),
    'and carries the vendor class word PoE+');
  ok(copper.every(function (i) { return Array.isArray(i.speedCaps) && i.speedCaps.indexOf('10M') !== -1; }),
    'the copper ladder reaches 10M, as the QSG states for ports 1-48');
  ok(sfpPlus.length === 2 && sfpPlus.every(function (i) { return i.speedCaps.indexOf('10G') !== -1; }),
    'two 1/10G SFP+ cages (' + sfpPlus.length + ')');
  ok(sfp.length === 2 && sfp.every(function (i) { return i.speedCaps.indexOf('1G') !== -1; }),
    'two 1G SFP cages (' + sfp.length + ')');
  ok(sfpPlus.concat(sfp).every(function (i) { return i.poeOut === undefined; }),
    'no cage sources power');
  ok(consoles.length === 1, 'one RJ45 serial console (' + consoles.length + ')');
  ok(s.interfaces.length === 53, '53 jacks modelled for 53 physical (' + s.interfaces.length + ')');
  ['poe-pse', '802.3af', '802.3at'].forEach(function (c) {
    ok(s.capabilities.indexOf(c) !== -1, 'capability ' + c + ' is declared');
  });
  ok(s.capabilities.indexOf('passive-poe') === -1,
    'no passive ceiling invented: the wiring guide names 24V passive in its LED legend only');
  ok(s.poe && s.poe.budgetW === budget && /^https:\/\/techspecs\.ui\.com\/unifi\/switching\//.test(String(s.poe.sourceUrl)),
    'the published ' + budget + ' W allocation is kept, cited to the tech-spec page');

  const dev = new Topology().addDevice(s);
  const pse = [...dev.interfaces.values()].filter(function (p) { return p.hardware && p.hardware.poeOut; });
  ok(pse.length === 48, 'the engine builds 48 PSE ports (' + pse.length + ')');
  ok(pse.every(function (p) { return p.hardware.poeOut === 34.2; }),
    'and none falls back to 15.4 W: ' +
    [...new Set(pse.map(function (p) { return p.hardware.poeOut; }))].join(','));
  ok(dev.poeBudget === budget && dev.poeBudgetSource === 'research',
    'the allocator sees ' + budget + ' W from the spec (' + dev.poeBudgetSource + ')');
}

console.log('\nThe declared ceiling makes the budget arithmetic bind where it used to be silent');
{
  const ap = spec('AP-515');
  ok(!!ap && ap.interfaces[0].poeIn === 25.5, 'AP-515 is a 25.5 W powered device');
  for (const [model, budget, firstRefusal] of [['US-48-500W', 500, 15], ['US-48-750W', 750, 22]]) {
    const t = new Topology();
    t.addDevice(spec(model), 'sw1');
    let accepted = 0, refusal = null;
    for (let i = 0; i < 25; i++) {
      t.addDevice(ap, 'ap' + i);
      try { t.connect('ap' + i, 'eth0', 'sw1', 'eth' + i); accepted++; }
      catch (e) { refusal = e; break; }
    }
    ok(accepted + 1 === firstRefusal,
      model + ': AP #' + firstRefusal + ' is the first 25.5 W AP refused (' + (accepted + 1) + ')');
    ok(!!refusal && refusal.code === 'E_POE_BUDGET' &&
      String(refusal.message).indexOf('of a ' + budget + ' W budget') !== -1,
      'for the budget, not for the port: ' + (refusal && refusal.message));
    const used = t.getDevice('sw1').poeDraw();
    ok(Math.abs(used - accepted * 34.2) < 1e-9,
      model + ': ' + accepted + ' powered ports report ' + (accepted * 34.2) +
      ' W, not ' + accepted + ' W (' + used + ')');
  }
}

console.log('\nA 30 W 802.3at device gets its watts on the last copper port');
{
  const s = spec('US-48-500W');
  const port = (s.interfaces || []).filter(function (i) { return i.name === 'eth47'; })[0];
  ok(!!port && port.poeOut >= 30, 'eth47 can give a 30 W device its watts (' + (port && port.poeOut) + ')');
  const ap = spec('U6 Enterprise');
  if (ap) {
    const t = new Topology();
    const sw = t.addDevice(s);
    const pd = t.addDevice(ap);
    const pdPort = pd.interfaces.has('eth0') ? 'eth0' : pd.interfaces.keys().next().value;
    let err = null;
    try { t.connect(pd.id, pdPort, sw.id, 'eth47'); } catch (e) { err = e; }
    ok(!err, 'the cable is accepted: ' + (err ? err.message : 'no refusal'));
    ok([...t.links.values()].some(function (l) {
      return (l.a.deviceId === sw.id && l.a.iface === 'eth47') ||
             (l.b.deviceId === sw.id && l.b.iface === 'eth47');
    }), 'eth47 carries the link');
  }
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
