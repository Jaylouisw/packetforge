'use strict';
// Three 24-port PoE switches whose per-socket ceiling the engine was getting wrong.
//
// US-24-250W and ES-24-500W declared a budget (250 W) or a PSU rating and no `poeOut` on any copper
// port. engine/media.js `derivePortHardware()` fills that silence with the 802.3af default of 15.4 W,
// so every socket on a chassis Ubiquiti rates at 34 W / 34.2 W PoE+ reported 15.4 W out - and on the
// US-24-250W the declared 250 W aggregate sat beside a per-port figure that contradicted it. ES-24-500W
// had no connector and no speedCaps on those sockets either, and was missing the RJ45 serial console
// (26 jacks modelled for 27 physical).
//
// ES-24-250W had the opposite silence: `poeOut: true`, a bare "this socket sources power" bit. The
// faceplate's `num()` refuses a boolean so it printed nothing, and `Device.poeDraw()` adds `true` as 1 W.
//
// Every figure below is Ubiquiti's, read 2026-11-21:
//   https://techspecs.ui.com/unifi/switching/us-24-250w   (200, 638,959 B)
//     "Port Layout 1 GbE RJ45 24 (All PoE+) (1G/100M/10M) / 1G SFP 2 (1G)";
//     "PoE Ports PoE+ 24"; "Max. PoE Wattage per Port by PSE PoE 17W / PoE+ 34W";
//     "Total PoE Availability 250W"; "Max. Power Consumption 30W (Excluding PoE output)"
//   https://techspecs.ui.com/uisp/wired/es-24-500w       (200, 582,269 B)
//     "(24) 10/100/1000 Mbps RJ45 Ethernet ports / (2) 1 Gbps SFP ports";
//     "Management interface (1) RJ45 serial port, Ethernet In/Out-Band";
//     "Max. PoE+ wattage per port by PSE 34.2W"; "Max. passive PoE wattage per port 17W";
//     "Power supply AC/DC, internal, 500W"; "Max. power consumption Includes PoE output: 500W /
//     Excludes PoE output: 30W" - and no "Total PoE available" row.
//   https://dl.ui.com/qsg/ES-24-250W_ES-24-500W/ES-24-250W_ES-24-500W_EN.html  (200, 22,805 B)
//     same interface counts and 34.2 W / 17 W ceilings; "The PoE settings for ports 1-24 are set to
//     PoE+ auto by default, so 802.3af/at devices can be plugged in and automatically receive PoE".
// There is no datasheet text layer: dl.ui.com/ds/usw-24-250w_ds.pdf and dl.ui.com/ds/es-24-500w_ds.pdf
// both answer 200 with the 609,911-byte techspecs front page.
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

const CASES = [
  ['US-24-250W', 34, 250],
  ['ES-24-250W', 34.2, 250],
  ['ES-24-500W', 34.2, null]
];

for (const [model, watts, budget] of CASES) {
  const s = spec(model);
  console.log('\n' + model + ': every copper socket is a ' + watts + ' W PoE+ PSE');
  ok(!!s, model + ' is in the catalogue');
  if (!s) continue;

  const copper = s.interfaces.filter(function (i) { return i.connector === 'rj45'; });
  const cages = s.interfaces.filter(function (i) { return i.connector === 'sfp'; });
  ok(copper.length === 24, '24 RJ45 ports (' + copper.length + ')');
  ok(copper.every(function (i) { return i.poeOut === watts; }),
    'each declares ' + watts + ' W: ' + [...new Set(copper.map(function (i) { return i.poeOut; }))].join(','));
  ok(copper.every(function (i) { return typeof i.poeOut === 'number'; }),
    'as a number, not a bare direction bit');
  ok(copper.every(function (i) { return i.poeOutClass === 'PoE+'; }), 'and carries the vendor class word PoE+');
  ok(cages.length === 2, 'two 1G SFP cages (' + cages.length + ')');
  ok(cages.every(function (i) { return i.poeOut === undefined; }), 'the cages source no power');
  ok(copper.every(function (i) {
    return Array.isArray(i.speedCaps) && i.speedCaps.indexOf('100M') !== -1;
  }), 'the copper ladder reaches 100M');
  ok(budget === null
    ? (s.poe && s.poe.budgetW === null && s.poe.budgetUnknown === true)
    : (s.poe && s.poe.budgetW === budget),
    budget === null ? 'the budget stays explicitly unknown' : 'the published ' + budget + ' W allocation is kept');

  const dev = new Topology().addDevice(s);
  const pse = [...dev.interfaces.values()].filter(function (p) { return p.hardware && p.hardware.poeOut; });
  ok(pse.length === 24, 'the engine builds 24 PSE ports (' + pse.length + ')');
  ok(pse.every(function (p) { return p.hardware.poeOut === watts; }),
    'and none of them falls back to 15.4 W: ' +
    [...new Set(pse.map(function (p) { return p.hardware.poeOut; }))].join(','));
  ok(budget === null
    ? (dev.poeBudget === 0 && dev.poeBudgetSource === 'unknown')
    : (dev.poeBudget === budget && dev.poeBudgetSource === 'research'),
    budget === null
      ? 'the allocator is told the budget is unknown, not 500 W from the model name'
      : 'the allocator sees ' + budget + ' W (' + dev.poeBudget + ')');
}

console.log('\nES-24-500W models the console Ubiquiti prints beside the 24 copper ports');
{
  const s = spec('ES-24-500W');
  const console_ = (s.interfaces || []).filter(function (i) { return i.type === 'console'; });
  ok(console_.length === 1, 'one RJ45 serial console for the CLI (' + console_.length + ')');
  ok(s.interfaces.length === 27, '27 jacks modelled for 27 physical (' + s.interfaces.length + ')');
  ['poe-pse', '802.3af', '802.3at', 'passive-poe'].forEach(function (c) {
    ok(s.capabilities.indexOf(c) !== -1, 'capability ' + c + ' is declared');
  });
}

console.log('\nA 30 W PoE+ device cables up to ES-24-500W Port 1 without being refused power');
{
  const s = spec('ES-24-500W');
  const port = (s.interfaces || []).filter(function (i) { return i.name === 'Port 1'; })[0];
  ok(!!port && port.poeOut >= 30, 'Port 1 can give a 30 W 802.3at device its watts (' + (port && port.poeOut) + ')');
  const ap = spec('U6 Enterprise');
  if (ap) {
    const t = new Topology();
    const sw = t.addDevice(s);
    const pd = t.addDevice(ap);
    const pdPort = pd.interfaces.has('eth0') ? 'eth0' : pd.interfaces.keys().next().value;
    let err = null;
    try { t.connect(pd.id, pdPort, sw.id, 'Port 1'); } catch (e) { err = e; }
    ok(!err, 'the cable is accepted: ' + (err ? err.message : 'no refusal'));
    const link = [...t.links.values()].filter(function (l) {
      return (l.a.deviceId === sw.id && l.a.iface === 'Port 1') ||
             (l.b.deviceId === sw.id && l.b.iface === 'Port 1');
    })[0];
    ok(!!link, 'Port 1 carries the link');
    ok(sw.poeBudget === 0 && sw.poeBudgetSource === 'unknown',
      'and the switch still claims no budget it was never given (' + sw.poeBudget + ', ' + sw.poeBudgetSource + ')');
  }
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
