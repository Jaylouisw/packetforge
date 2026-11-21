'use strict';
// Five UniFi cloud gateways that billed every PSE socket at 1 W.
//
// UCG-Industrial, UDM-SE, UDR, UDR7 and UDR-5G-Max all carried `poeOut: true` on the ports that
// source power - the bare direction bit. `Device.poeDraw()` (engine/device.js) adds the field into
// its watt total, so `true` is 1 W, and `pseDraw()` (engine/validation.js) sums the same field
// against the budget: a 90 W 802.3bt device on UCG-Industrial eth0 was accepted as a 1 W load, and
// the 270 W budget could not bind anywhere. The faceplate's `num()` refuses a boolean, so the panel
// drew the PoE badge with no figure at all.
//
// Every figure below is Ubiquiti's, read 2026-11-21 (server-rendered tech-spec tables, crawler UA):
//   https://techspecs.ui.com/unifi/cloud-gateways/ucg-industrial  (200, 699,443 B)
//     Port Layout "2.5 GbE RJ45 = 4 (2 PoE+++, 2 PoE+)", "10 GbE RJ45 = 1 (PoE+++)";
//     "Max. PoE Wattage per Port by PSE PoE+ = 30W / PoE+++ = 90W";
//     "PoE Budget = DC input: 270W / ATX power: 75W"
//   https://dl.ui.com/ds/udm_se_ds.pdf  (200, 358,669 B, 3 pp, text layer)
//     "PoE interface (6) PoE (Pair A 1, 2+; 3, 6-) / (2) PoE+ (Pair A 1, 2+; 3, 6-)";
//     "Max. PoE wattage per port by PSE PoE: 15.4W / PoE+: 30W"
//     (the hyphenated /ds/udm-se_ds.pdf answers 302 into the 609,911-byte techspecs front page)
//   https://techspecs.ui.com/unifi/cloud-gateways/udm-se  (200, 682,320 B)
//     "PoE Budget = 180W", "PoE = 15.4W", "PoE+ = 30W"
//   https://techspecs.ui.com/unifi/cloud-gateways/udr  (200, 685,837 B)
//     "1 GbE RJ45 = 5 (2 PoE)", "PoE Budget = 40W", "PoE = 15.4W"
//   https://techspecs.ui.com/unifi/cloud-gateways/udr7  (200, 694,590 B)
//     "2.5 GbE RJ45 = 4 (1 PoE)", "PoE Budget = 15.4W", "PoE = 15.4W"
//   https://techspecs.ui.com/unifi/cloud-gateways/udr-5g-max  (200, 876,426 B)
//     "2.5 GbE RJ45 = 4 (1 PoE)", "PoE Budget = 15.4W", "PoE = 15.4W"
//
// The class-to-socket assignment is the one each row already carried; only the figure changed.
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

// model, budget, and the vendor's per-socket ceiling for each PSE socket.
const CASES = [
  ['UDR', 40, { eth0: 15.4, eth1: 15.4 }],
  ['UDR7', 15.4, { eth0: 15.4 }],
  ['UDR-5G-Max', 15.4, { eth0: 15.4 }],
  ['UDM-SE', 180, {
    'Port 1': 30, 'Port 2': 30,
    'Port 3': 15.4, 'Port 4': 15.4, 'Port 5': 15.4, 'Port 6': 15.4, 'Port 7': 15.4, 'Port 8': 15.4
  }],
  ['UCG-Industrial', 270, { eth0: 90, eth1: 90, eth2: 30, eth3: 30, eth4: 90 }]
];

const CLASS_WATTS = { 'PoE': 15.4, 'PoE+': 30, 'PoE++': 60, 'PoE+++': 90 };

for (const [model, budget, panel] of CASES) {
  const s = spec(model);
  console.log('\n' + model + ': ' + Object.keys(panel).length + ' PSE socket(s) at the vendor ceiling');
  ok(!!s, model + ' is in the catalogue');
  if (!s) continue;

  const pse = (s.interfaces || []).filter(function (i) { return i.poeOut !== undefined && i.poeOut !== false && i.poeOut !== 0; });
  ok(pse.length === Object.keys(panel).length,
    'the panel has ' + Object.keys(panel).length + ' PSE socket(s) (' + pse.length + ')');

  const names = pse.map(function (i) { return i.name; }).sort();
  ok(JSON.stringify(names) === JSON.stringify(Object.keys(panel).sort()),
    'and they are the sockets the vendor names: ' + names.join(', '));

  for (const i of pse) {
    const want = panel[i.name];
    ok(i.poeOut === want, i.name + ' declares ' + want + ' W (' + JSON.stringify(i.poeOut) + ')');
    ok(typeof i.poeOut === 'number', i.name + ' carries a number, not a bare direction bit');
    ok(CLASS_WATTS[i.poeOutClass] === want,
      i.name + ' says ' + i.poeOutClass + ', whose ceiling is ' + want + ' W');
  }

  ok(!(s.interfaces || []).some(function (i) { return i.poeOut === true; }),
    'no socket is left on the bare `poeOut: true` that poeDraw() reads as 1 W');

  const dev = new Topology().addDevice(s);
  ok(dev.poeBudget === budget && dev.poeBudgetSource === 'research',
    'the allocator sees the published ' + budget + ' W (' + dev.poeBudget + ', ' + dev.poeBudgetSource + ')');
  const hw = [...dev.interfaces.values()].filter(function (p) { return p.hardware && p.hardware.poeOut; });
  ok(hw.every(function (p) { return p.hardware.poeOut === panel[p.name]; }),
    'every PSE port reaches the engine with its ceiling: ' +
    [...new Set(hw.map(function (p) { return p.hardware.poeOut; }))].join(','));

  const sum = Math.round(pse.reduce(function (a, i) { return a + i.poeOut; }, 0) * 10) / 10;
  ok(sum > 0, 'the panel sums to ' + sum + ' W');

  // The load the budget is meant to police: cable a powered device to the first PSE socket and
  // read what the gateway says it is supplying.
  const pd = spec('U6-Lite');
  if (pd) {
    const t = new Topology();
    const g = t.addDevice(s, 'gw');
    const ap = t.addDevice(pd, 'ap');
    const first = pse[0].name;
    const apPort = (pd.interfaces || []).filter(function (i) { return i.type === 'ethernet'; })[0];
    let err = null;
    try { t.connect('ap', apPort.name, 'gw', first); } catch (e) { err = e; }
    ok(!err, 'a powered device cables to ' + first + ': ' + (err ? err.message : 'no refusal'));
    ok(g.poeDraw() === panel[first], 'and the gateway bills ' + panel[first] + ' W for it (' + g.poeDraw() + ')');
  }
}

console.log('\nThe budget, not the socket sum, is what binds');
{
  const ucg = spec('UCG-Industrial');
  const pse = ucg.interfaces.filter(function (i) { return i.poeOut; });
  const sum = pse.reduce(function (a, i) { return a + i.poeOut; }, 0);
  ok(sum === 330, 'UCG-Industrial: 3 x 90 + 2 x 30 = ' + sum + ' W of socket capacity');
  ok(sum > ucg.poe.budgetW, 'against a ' + ucg.poe.budgetW + ' W budget, so a full 90 W fill is refused');

  const udm = spec('UDM-SE');
  const udmSum = udm.interfaces.filter(function (i) { return i.poeOut; })
    .reduce(function (a, i) { return a + i.poeOut; }, 0);
  ok(Math.round(udmSum * 10) / 10 === 152.4, 'UDM-SE: 2 x 30 + 6 x 15.4 = ' + udmSum + ' W');
  ok(udmSum < udm.poe.budgetW, 'which fits inside the published ' + udm.poe.budgetW + ' W');

  const udr = spec('UDR');
  const udrSum = udr.interfaces.filter(function (i) { return i.poeOut; })
    .reduce(function (a, i) { return a + i.poeOut; }, 0);
  ok(Math.round(udrSum * 10) / 10 === 30.8, 'UDR: 2 x 15.4 = ' + udrSum + ' W, as its budget note already said');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
