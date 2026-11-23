'use strict';
// POE-E201: the extender's own 26 W, not the 802.3at class ceiling.
//
// `devices/planet/poe-e201.json` shipped `poeOut: 30` - the 802.3at PSE class ceiling, which PLANET
// does not sell this jack at - and no `poe` block at all, so the row sat in
// `scripts/audit-poe-budget.js`'s silent cohort: `Device` asked the model-name parser for a budget
// ("POE-E201" spells no wattage), got 0, and `Simulator.computePoe()` skipped the device at
// `if (!dev.poeBudget) continue;`. `show power inline` printed "budget not modelled", and a 25.5 W
// PoE+ access point cabled to `poe_out` had neither a total nor a ceiling to be judged against.
//
// PLANET's own catalogue sheet (https://www.planet.com.tw/storage/products/49453/C-POE-E201v2_L.pdf,
// HTTP 200, 951,342 B, 4 pp, text layer, read 2026-11-23), Specifications -> Power over Ethernet:
//   PoE Power Supply Type | "PoE In" Port: IEEE 802.3at PoE+ end-span/mid-span PD class 4 PD |
//    Per "PoE Out" Port: IEEE 802.3at PoE+ end-span PSE
//   PoE Power | "PoE In" Port: 48~56V DC, max. 30.8 watts | "PoE Out" Port: 44~52V DC, max. 26 watts
//   Power Consumption: 2.6 watts (system maximum)
// and the QIG repeats it (https://www.planet.com.tw/storage/products/49453/EM-POE-E201_v2.0.pdf,
// 200, 1,389,185 B: "PoE Power 44~52V DC, 510mA; max. 26 watts", "System Power 2.6 watts").
//
// The product page prints a contradictory line - "PoE Output at maximum 36 watts"
// (https://www.planet.com.tw/en/product/poe-e201-v2, 200, 103,569 B, read 2026-11-23) - which is
// physically impossible against its own 30.8 W input maximum. 26 W is what the sheet and the QIG
// say, so 26 W is what the port and the budget carry, and the 36 W line is recorded in the spec's
// `poe.note` rather than modelled. This suite pins that choice so it cannot drift back silently.
const path = require('path');
const { Topology, Simulator } = require('../engine');
const { CliSession } = require('../engine/cli');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const CATALOGUE = loadCatalog(path.join(__dirname, '..', 'devices')).filter(function (s) { return !s.error; });
function spec(v, m) {
  const s = CATALOGUE.filter(function (x) { return x.vendor === v && x.model === m; })[0];
  if (!s) throw new Error('missing spec ' + v + '/' + m);
  return s;
}

const EXT = spec('planet', 'POE-E201');
const AT_PD = spec('aruba', 'AP-515');
const BIG_PD = spec('ruckus', 'R770');

function show(dev, t, sim, cmd) {
  return (new CliSession(dev, t, sim).run(cmd).output || []).map(String);
}

console.log('');
console.log("The row states PLANET's own two jack figures:");
ok((EXT.capabilities || []).indexOf('poe-pse') !== -1, 'the extender declares it is a PSE');
ok((EXT.capabilities || []).indexOf('poe-pd') !== -1, 'and that it is itself powered by PoE');
ok((EXT.capabilities || []).indexOf('802.3at') !== -1, 'and 802.3at');
{
  const pin = (EXT.interfaces || []).filter(function (i) { return i.name === 'poe_in'; })[0] || {};
  const pout = (EXT.interfaces || []).filter(function (i) { return i.name === 'poe_out'; })[0] || {};
  ok(pout.poeOut === 26, 'poe_out declares 26 W, the sheet maximum (' + pout.poeOut + ')');
  ok(pout.poeOut !== 30, 'not the 802.3at class ceiling it used to carry (' + pout.poeOut + ')');
  ok(pout.poeOutClass === 'PoE+', 'and is classed 802.3at as the sheet prints (' + pout.poeOutClass + ')');
  ok(pin.poeIn === 30.8, 'poe_in declares the 30.8 W input ceiling (' + pin.poeIn + ')');
  ok(!pin.poeOut, 'the inlet sources nothing');
  ok((EXT.interfaces || []).filter(function (i) { return i.poeOut; }).length === 1,
    'one PSE socket on the box, which is what makes the jack ceiling the total');
}
ok(EXT.poe && EXT.poe.budgetW === 26, 'the budget is PLANET 26 W (' + (EXT.poe && EXT.poe.budgetW) + ')');
ok(EXT.poe && /^https:\/\/www\.planet\.com\.tw\/storage\/products\/49453\//.test(String(EXT.poe.sourceUrl)),
  'cited to the catalogue sheet the rows were read from', EXT.poe && EXT.poe.sourceUrl);
ok(EXT.poe && /read 2026-11-23/.test(String(EXT.poe.note)) && /max\. 26 watts/.test(String(EXT.poe.note)) &&
  /30\.8/.test(String(EXT.poe.note)), 'and the note records the reading that produced it');
ok(EXT.poe && /36 watts/.test(String(EXT.poe.note)),
  'the product page 36 W line is recorded, not modelled');

console.log('\nThe built device carries that budget and no phantom PSE:');
{
  const t = new Topology();
  const r = t.addDevice(EXT, 'r1');
  const dev = t.devices.get(r.id);
  ok(dev.poeBudget === 26, 'the built device carries 26 W (' + dev.poeBudget + ')');
  ok(dev.poeBudgetSource === 'research', 'from the spec poe block (' + dev.poeBudgetSource + ')');
  ok(dev.interfaces.get('poe_out').poeOut === 26, 'poe_out is a 26 W PSE port');
  ok(!dev.interfaces.get('poe_in').poeOut, 'poe_in sources nothing');
}

console.log('\nA 25.5 W 802.3at access point on the PoE-out jack is powered and printed:');
{
  const t = new Topology();
  const r = t.addDevice(EXT, 'r1');
  const ap = t.addDevice(AT_PD, 'ap1');
  ok(!!t.connect(ap.id, 'eth0', r.id, 'poe_out'), 'the access point cables to poe_out');
  const dev = t.devices.get(r.id);
  const sim = new Simulator(t);
  sim.computePoe();
  const entry = sim.poe.filter(function (p) { return p.dev === r.id; })[0];
  const row = entry && entry.ports.filter(function (p) { return p.iface === 'poe_out'; })[0];
  ok(!!row && row.powered === true, 'the access point is powered (' + JSON.stringify(row) + ')');
  ok(!!row && row.draw === 25.5, 'drawing 25.5 W (' + (row && row.draw) + ')');

  const lines = show(dev, t, sim, 'show power inline');
  ok(lines[0] === 'Available:26.0(w) Used:25.5(w) Remaining:0.5(w)',
    'the summary line is the vendor budget: ' + lines[0]);
  ok(!lines.some(function (l) { return /budget not modelled/.test(l); }),
    'and the view no longer says the budget is not modelled');
  const portRow = lines.filter(function (l) { return /^poe_out\s/.test(l); })[0] || '';
  ok(/\bon\b/.test(portRow) && /25\.5/.test(portRow), 'the port reads on and 25.5: ' + portRow);
}

console.log('\nA 32 W device is refused, because this jack is 26 W:');
{
  const t = new Topology();
  const r = t.addDevice(EXT, 'r2');
  const ap = t.addDevice(BIG_PD, 'big1');
  ok(!!t.connect(ap.id, 'eth0', r.id, 'poe_out'), 'the 32 W device cables to poe_out');
  const dev = t.devices.get(r.id);
  const sim = new Simulator(t);
  sim.computePoe();
  const entry = sim.poe.filter(function (p) { return p.dev === r.id; })[0] || { ports: [] };
  const row = entry.ports.filter(function (p) { return p.iface === 'poe_out'; })[0];
  ok(!!row && row.powered === false, 'it is not powered');
  ok(!!row && row.reason === 'PSE budget exhausted: 32 W requested, 26 W left',
    'with the arithmetic that refused it: ' + (row && row.reason));
  const lines = show(dev, t, sim, 'show power inline');
  ok(lines[0] === 'Available:26.0(w) Used:0.0(w) Remaining:26.0(w)',
    'nothing was allocated, so nothing is used: ' + lines[0]);
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
