'use strict';
// The two UniFi mobile routers passed power through a socket that declared no wattage.
//
// UMR and UMR-Industrial each carry one PSE socket (rj45-2 / eth1) marked `poeOut: true` and
// `poeOutClass: "PoE+"`, next to a `poe.budgetW` of 10 W whose note quotes Ubiquiti's own line.
// `Device.poeDraw()` (engine/device.js) adds `iface.poeOut` into its total when the port has a
// peer, so `true` bills **1 W**; `pseDraw()` (engine/validation.js) sums the same field against
// the 10 W budget. A 9 W camera on the passthrough was therefore priced at 1 W and the budget
// could never bind - the same defect PR #2407 fixed on five cloud gateways, left standing on
// these two rows because a previous pass probed `/unifi/cloud-gateways/umr` (which 307s to `/`)
// instead of the live `/unifi/integrations/umr-us`.
//
// Ubiquiti's figure, read 2026-11-21 (server-rendered tech-spec table, crawler UA):
//   https://techspecs.ui.com/unifi/integrations/umr-us             (200, 708,698 B)
//   https://techspecs.ui.com/unifi/integrations/umr-industrial-us  (200, 693,659 B)
//     "PoE Interface (1) PoE input / (1) PoE output (Max. 10W, requires PoE+ switch)"
//
// Note the deliberate disagreement: the class stays PoE+ because that is the upstream feed the
// passthrough requires, while the 10 W is a passthrough cap well under the PoE+ class ceiling.
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

// The spec's `model` is what the catalogue keys on; `umr.json` carries it lower-case.
const CASES = [
  ['umr', 'UMR', { 'rj45-2': 10 }],
  ['UMR-Industrial', 'UMR-Industrial', { eth1: 10 }]
];

for (const [key, model, panel] of CASES) {
  const s = spec(key);
  console.log('\n' + model + ': one 10 W passthrough socket');
  ok(!!s, model + ' is in the catalogue');
  if (!s) continue;

  const pse = (s.interfaces || []).filter(function (i) {
    return i.poeOut !== undefined && i.poeOut !== false && i.poeOut !== 0;
  });
  ok(pse.length === 1, 'it has exactly one PSE socket (' + pse.length + ')');
  ok(JSON.stringify(pse.map(function (i) { return i.name; }).sort()) === JSON.stringify(Object.keys(panel).sort()),
    'and it is the socket the vendor names: ' + pse.map(function (i) { return i.name; }).join(', '));

  for (const i of pse) {
    const want = panel[i.name];
    ok(i.poeOut === want, i.name + ' declares ' + want + ' W (' + JSON.stringify(i.poeOut) + ')');
    ok(typeof i.poeOut === 'number', i.name + ' carries a number, not a bare direction bit');
  }

  ok(!(s.interfaces || []).some(function (i) { return i.poeOut === true; }),
    'no socket is left on the bare `poeOut: true` that poeDraw() reads as 1 W');

  ok(s.poe && s.poe.budgetW === 10, 'the published passthrough budget is 10 W (' +
    (s.poe ? s.poe.budgetW : 'missing') + ')');
  ok(/Max\. 10W/.test(s.poe && s.poe.note || '') || /10 W/.test(s.poe && s.poe.note || ''),
    'and its note quotes the vendor line that bounds it');

  const dev = new Topology().addDevice(s);
  ok(dev.poeBudget === 10 && dev.poeBudgetSource === 'research',
    'the allocator sees 10 W (' + dev.poeBudget + ', ' + dev.poeBudgetSource + ')');

  const hw = [...dev.interfaces.values()].filter(function (p) { return p.hardware && p.hardware.poeOut; });
  ok(hw.length === 1 && hw[0].hardware.poeOut === 10,
    'the PSE port reaches the engine with its 10 W ceiling (' +
    hw.map(function (p) { return p.name + '=' + p.hardware.poeOut; }).join(',') + ')');

  // The load the budget is meant to police: a powered device on the passthrough.
  const pd = spec('U6-Lite');
  if (pd) {
    const t = new Topology();
    const gw = t.addDevice(s, 'gw');
    const ap = t.addDevice(pd, 'ap');
    const first = pse[0].name;
    const apPort = (pd.interfaces || []).filter(function (i) { return i.type === 'ethernet'; })[0];
    let err = null;
    try { t.connect('ap', apPort.name, 'gw', first); } catch (e) { err = e; }
    ok(!err, 'a powered device cables to ' + first + ': ' + (err ? err.message : 'no refusal'));
    ok(gw.poeDraw() === 10, 'and the router bills 10 W for it, not 1 W (' + gw.poeDraw() + ')');
  }
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
