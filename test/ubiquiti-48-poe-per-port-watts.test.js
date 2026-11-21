'use strict';
// Two 48-port EdgeSwitch PoE chassis whose per-socket ceiling the engine was getting wrong.
//
// ES-48-500W and ES-48-750W declared a `poeOut` on all 48 copper ports, but as the bare boolean
// `true`. engine/media.js `poeDraw()` bills `true` as 1 W and the faceplate's `num()` prints nothing,
// so a chassis Ubiquiti rates at 34.2 W per socket by PSE could not power a 30 W 802.3at access
// point on any port. The 750 W model also carried no whole-box PoE allocation at all, and the
// 500 W model's copper ladder stopped at 100M.
//
// Every figure below is Ubiquiti's, read 2026-11-21:
//   https://techspecs.ui.com/uisp/wired/es-48-500w    (200, 583,292 B, server-rendered table)
//     "Networking interface (48) GbE RJ45 ports / (2) 1/10G SFP+ ports / (2) 1G SFP ports";
//     "PoE interface (48) PoE/PoE+ 2-pair ... / (48) 24V DC passive PoE 2-pair";
//     "Management interface (1) RJ45 serial port, Ethernet In/Out-Band";
//     "Power supply AC/DC, internal, 500W"; "Max. power consumption 64W (Excludes PoE output)";
//     "Total PoE available 500W";
//     "Max. PoE wattage per port by PSE PoE+: 34.2W / Passive PoE: 17W";
//     "Voltage range PoE mode PoE+: 50-57V / Passive PoE: 20-27V"
//   https://techspecs.ui.com/uisp/wired/es-48-750w    (200, 582,768 B)
//     "(48) 10/100/1000 Mbps RJ45 Ethernet ports / (2) 1/10 Gbps SFP+ Ethernet ports /
//      (2) 1 Gbps SFP Ethernet ports"; "Management interface (1) RJ45 serial port";
//     "Power supply AC/DC, internal, 750W";
//     "Max. power consumption Includes PoE output: 750W; Excludes PoE output: 64W";
//     "PoE interfaces PoE/PoE+ (Pins 1, 2+; 3, 6-) / 24V DC passive PoE (Pins 4, 5+; 7, 8-)";
//     "Max. PoE+ wattage per port by PSE 34.2W"; "Max. passive PoE wattage per port 17W"
//     - and NO "Total PoE available" row, unlike the 500 W sibling.
//   https://dl.ui.com/qsg/ES-48-500W_ES-48-750W/ES-48-500W_ES-48-750W_EN.html  (200, 24,302 B)
//     "Model: ES-48-500W, ES-48-750W"; "RJ45 (Ports 1 - 48) ... RJ45 ports support Power over
//      Ethernet (PoE) and 10/100/1000 Ethernet connections"; "Max. PoE+ Wattage per Port by PSE
//      34.2W"; "Max. Passive PoE Wattage per Port 17W"; "The PoE settings for ports 1-48 are set
//      to PoE+ auto by default, so 802.3af/at devices can be plugged in and automatically receive
//      PoE".
// The 500 W tech-spec row abbreviates its ladder to "GbE"; the guide that names both models prints
// 10/100/1000 for ports 1-48, so the 10M rung is modelled on both, and both surfaces are quoted in
// the spec's notes rather than reconciled into a number neither of them prints.
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

const CASES = [
  ['ES-48-500W', 500],
  ['ES-48-750W', null]
];

for (const [model, budget] of CASES) {
  const s = spec(model);
  console.log('\n' + model + ': all 48 copper sockets are 34.2 W PoE+ PSEs');
  ok(!!s, model + ' is in the catalogue');
  if (!s) continue;

  const copper = s.interfaces.filter(function (i) { return i.connector === 'rj45'; });
  const sfpPlus = s.interfaces.filter(function (i) { return i.connector === 'sfp+'; });
  const sfp = s.interfaces.filter(function (i) { return i.connector === 'sfp'; });
  const console_ = s.interfaces.filter(function (i) { return i.type === 'console'; });

  ok(copper.length === 48, '48 RJ45 ports (' + copper.length + ')');
  ok(copper.every(function (i) { return i.poeOut === 34.2; }),
    'each declares 34.2 W: ' + [...new Set(copper.map(function (i) { return i.poeOut; }))].join(','));
  ok(copper.every(function (i) { return typeof i.poeOut === 'number'; }),
    'as a number, not the bare direction bit it shipped before');
  ok(copper.every(function (i) { return i.poeOutClass === 'PoE+'; }),
    'and carries the vendor class word PoE+ (ports 1-48 ship PoE+ auto)');
  ok(copper.every(function (i) { return Array.isArray(i.speedCaps) && i.speedCaps.indexOf('10M') !== -1; }),
    'the copper ladder reaches 10M, as the guide states for ports 1-48');
  ok(sfpPlus.length === 2 && sfpPlus.every(function (i) { return i.speedCaps.indexOf('10G') !== -1; }),
    'two 1/10G SFP+ cages (' + sfpPlus.length + ')');
  ok(sfp.length === 2 && sfp.every(function (i) { return i.speedCaps.indexOf('1G') !== -1; }),
    'two 1G SFP cages (' + sfp.length + ')');
  ok([...sfpPlus, ...sfp].every(function (i) { return i.poeOut === undefined; }),
    'no cage sources power');
  ok(console_.length === 1, 'one RJ45 serial console (' + console_.length + ')');
  ok(s.interfaces.length === 53, '53 jacks modelled for 53 physical (' + s.interfaces.length + ')');
  ['poe-pse', '802.3af', '802.3at', 'passive-poe'].forEach(function (c) {
    ok(s.capabilities.indexOf(c) !== -1, 'capability ' + c + ' is declared');
  });
  ok(budget === null
    ? (s.poe && s.poe.budgetW === null && s.poe.budgetUnknown === true)
    : (s.poe && s.poe.budgetW === budget),
    budget === null ? 'the budget stays explicitly unknown' : 'the published ' + budget + ' W allocation is kept');

  const dev = new Topology().addDevice(s);
  const pse = [...dev.interfaces.values()].filter(function (p) { return p.hardware && p.hardware.poeOut; });
  ok(pse.length === 48, 'the engine builds 48 PSE ports (' + pse.length + ')');
  ok(pse.every(function (p) { return p.hardware.poeOut === 34.2; }),
    'and none falls back to 15.4 W: ' +
    [...new Set(pse.map(function (p) { return p.hardware.poeOut; }))].join(','));
  ok(budget === null
    ? (dev.poeBudget === 0 && dev.poeBudgetSource === 'unknown')
    : (dev.poeBudget === budget && dev.poeBudgetSource === 'research'),
    budget === null
      ? 'the allocator is told the budget is unknown, not 750 W from the model name'
      : 'the allocator sees ' + budget + ' W (' + dev.poeBudget + ')');
}

console.log('\nA 30 W 802.3at device cables up to ES-48-500W Port 48 without being refused power');
{
  const s = spec('ES-48-500W');
  const port = (s.interfaces || []).filter(function (i) { return i.name === 'Port 48'; })[0];
  ok(!!port && port.poeOut >= 30, 'Port 48 can give a 30 W device its watts (' + (port && port.poeOut) + ')');
  const ap = spec('U6 Enterprise');
  if (ap) {
    const t = new Topology();
    const sw = t.addDevice(s);
    const pd = t.addDevice(ap);
    const pdPort = pd.interfaces.has('eth0') ? 'eth0' : pd.interfaces.keys().next().value;
    let err = null;
    try { t.connect(pd.id, pdPort, sw.id, 'Port 48'); } catch (e) { err = e; }
    ok(!err, 'the cable is accepted: ' + (err ? err.message : 'no refusal'));
    const link = [...t.links.values()].filter(function (l) {
      return (l.a.deviceId === sw.id && l.a.iface === 'Port 48') ||
             (l.b.deviceId === sw.id && l.b.iface === 'Port 48');
    })[0];
    ok(!!link, 'Port 48 carries the link');
  }
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
