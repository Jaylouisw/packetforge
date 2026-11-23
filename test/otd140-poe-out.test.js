'use strict';
// The OTD140's PoE-out jack is 802.3af at 15 W, not PoE+ - and the box could not spend a watt (#2449).
//
// The row declared `poeOut: true` with `poeOutClass: "PoE+"` on eth2 and carried no `poe` block.
// `Device` therefore asked the model-name parser for a budget ('OTD140' spells no wattage), got 0,
// and `Simulator.computePoe()` skipped the device at `if (!dev.poeBudget) continue;` - so
// `show power inline` printed `budget not modelled on ...` and a camera cabled to the PoE-out jack
// stayed dark. `poeOut: true` is also the boolean `Device.poeDraw()` bills as 1 W.
//
// Teltonika's own rows, both copies of the same revision read 2026-11-21:
//   * datasheet v1.20, 2026-07-24, p.2 (https://download.kamami.pl/p1207980-Datasheet_OTD140_1.20.pdf,
//     HTTP 200, 2,264,361 B, 11 pp, text layer):
//       POE OUT / "PoE ports 1 x PoE Out" / "PoE standards 802.3af Alternative B" /
//       "PoE Max Power per Port (at PSE) 15 W Max (power supply unit dependent)"
//     and p.7 "Power consumption Idle: < 2.5 W / Max: < 6 W / PoE Max < 21 W" - 6 W of router plus
//     15 W of PoE out is the 21 W it prints, which is the arithmetic that rules out the 24 W figure
//     in the earlier v1.6 sheet and the v1.4 flyer (both of which also call the jack 802.3at; af's
//     class ceiling is 15.4 W).
//   * the same revision, second host (sicetelecom.it, 2024-v1, 10 pp), p.3: the same three cells.
// One PSE socket means the per-port ceiling is the whole budget, so the `poe` block carries 15 W.
//
// What this suite pins: the port says 15 W and class PoE; the budget is the vendor's 15 W taken from
// the spec rather than the model name; a 12.95 W 802.3af access point is powered and printed; and a
// 25.5 W 802.3at access point is refused with the arithmetic, because this jack is not PoE+.
const path = require('path');
const { Topology, Simulator } = require('../engine');
const { CliSession } = require('../engine/cli');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices')).filter(function (s) { return !s.error; });
function spec(v, m) {
  const s = catalog.find(function (x) { return x.vendor === v && x.model === m; });
  if (!s) throw new Error('missing spec ' + v + '/' + m);
  return s;
}

const OTD = spec('teltonika', 'OTD140');
const AF_PD = spec('aruba', 'AP-505');    // 12.95 W, the 802.3af ceiling this engine gives a PD
const AT_PD = spec('aruba', 'AP-515');    // 25.5 W, an 802.3at draw

function show(dev, t, sim, cmd) {
  return (new CliSession(dev, t, sim).run(cmd).output || []).map(String);
}

console.log('');
console.log('The spec states the vendor\'s POE OUT row:');
ok((OTD.capabilities || []).indexOf('poe-pse') !== -1, 'the OTD140 declares it is a PSE');
ok((OTD.capabilities || []).indexOf('802.3af') !== -1, 'and 802.3af');
{
  const eth2 = (OTD.interfaces || []).filter(function (i) { return i.name === 'eth2'; })[0] || {};
  const eth1 = (OTD.interfaces || []).filter(function (i) { return i.name === 'eth1'; })[0] || {};
  ok(eth2.poeOut === 15, 'the PoE-out jack declares 15 W, not `true` (' + eth2.poeOut + ')');
  ok(eth2.poeOutClass === 'PoE', 'and is classed 802.3af (PoE), not PoE+ (' + eth2.poeOutClass + ')');
  ok(eth1.poeIn === 21 && !eth1.poeOut,
    'the other jack is the powered-device side: PoE in only (' + eth1.poeIn + ')');
  ok((OTD.interfaces || []).filter(function (i) { return i.poeOut; }).length === 1,
    'one PSE socket on the box, which is what makes the per-port ceiling the budget');
}
ok(OTD.poe && OTD.poe.budgetW === 15, 'the budget is Teltonika\'s 15 W (' + (OTD.poe && OTD.poe.budgetW) + ')');
ok(OTD.poe && OTD.poe.standard === '802.3af', 'and it names the 802.3af the sheet prints (' + (OTD.poe && OTD.poe.standard) + ')');
ok(OTD.poe && /^https:\/\/download\.kamami\.pl\/p1207980-/.test(String(OTD.poe.sourceUrl)),
  'cited to the datasheet page the rows were read from', OTD.poe && OTD.poe.sourceUrl);

console.log('\nThe built device carries that budget and no phantom PSE:');
{
  const t = new Topology();
  const r = t.addDevice(OTD, 'r1');
  const dev = t.devices.get(r.id);
  ok(dev.poeBudget === 15, 'the built device carries 15 W (' + dev.poeBudget + ')');
  ok(dev.poeBudgetSource === 'research', 'from the spec\'s poe block, not the model name (' + dev.poeBudgetSource + ')');
  ok(dev.interfaces.get('eth2').poeOut === 15, 'eth2 is a 15 W PSE port');
  ok(dev.interfaces.get('eth1').poeOut === null || !dev.interfaces.get('eth1').poeOut,
    'eth1 sources nothing');
}

console.log('\nA 12.95 W camera on the PoE-out jack is powered and printed:');
{
  const t = new Topology();
  const r = t.addDevice(OTD, 'r1');
  const ap = t.addDevice(AF_PD, 'ap1');
  ok(!!t.connect(ap.id, 'E0', r.id, 'eth2'), 'an 802.3af access point cables to eth2');
  const dev = t.devices.get(r.id);
  ok(dev.poeDraw() === 15, 'poeDraw() bills the 15 W ceiling, not the boolean\'s 1 W (' + dev.poeDraw() + ')');
  const sim = new Simulator(t);
  sim.computePoe();
  const entry = sim.poe.filter(function (p) { return p.dev === r.id; })[0];
  const row = entry && entry.ports.filter(function (p) { return p.iface === 'eth2'; })[0];
  ok(!!row && row.powered === true, 'the access point is powered (' + JSON.stringify(row) + ')');
  ok(!!row && row.draw === 12.95, 'drawing 12.95 W (' + (row && row.draw) + ')');

  const lines = show(dev, t, sim, 'show power inline');
  ok(lines[0] === 'Available:15.0(w) Used:13.0(w) Remaining:2.0(w)',
    'the summary line is the vendor budget: ' + lines[0]);
  ok(!lines.some(function (l) { return /budget not modelled/.test(l); }),
    'and the view no longer says the budget is not modelled');
  const portRow = lines.filter(function (l) { return /^eth2\s/.test(l); })[0] || '';
  ok(/\bon\b/.test(portRow) && /13\.0/.test(portRow), 'the port reads on and 13.0: ' + portRow);
}

console.log('\nA 25.5 W 802.3at device is refused, because this jack is not PoE+:');
{
  const t = new Topology();
  const r = t.addDevice(OTD, 'r2');
  const ap = t.addDevice(AT_PD, 'at1');
  ok(!!t.connect(ap.id, 'eth0', r.id, 'eth2'), 'a 25.5 W access point cables to eth2');
  const dev = t.devices.get(r.id);
  const sim = new Simulator(t);
  sim.computePoe();
  const entry = sim.poe.filter(function (p) { return p.dev === r.id; })[0] || { ports: [] };
  const row = entry.ports.filter(function (p) { return p.iface === 'eth2'; })[0];
  ok(!!row && row.powered === false, 'it is not powered');
  ok(!!row && row.reason === 'PSE budget exhausted: 25.5 W requested, 15 W left',
    'with the arithmetic that refused it: ' + (row && row.reason));
  const lines = show(dev, t, sim, 'show power inline');
  const portRow = lines.filter(function (l) { return /^eth2\s/.test(l); })[0] || '';
  ok(/power-deny/.test(portRow), 'the Oper cell is power-deny: ' + portRow);
  ok(lines.some(function (l) { return /eth2: PSE budget exhausted/.test(l); }),
    'and the denial is named under the table');
  ok(lines[0] === 'Available:15.0(w) Used:0.0(w) Remaining:15.0(w)',
    'nothing was allocated, so nothing is used: ' + lines[0]);
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
