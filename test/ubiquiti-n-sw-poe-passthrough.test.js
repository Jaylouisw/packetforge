'use strict';
// The NanoSwitch passed power through three sockets that declared no wattage and no budget.
//
// N-SW shipped as three bare `poeOut: true` sockets plus a fourth with no power field at all, and no
// `poe.budgetW`. `Device.poeDraw()` (engine/device.js) adds the bare direction bit as **1 W**, and
// `pseDraw()` (engine/validation.js) sums the same field against the budget - so three 24 V radios
// drawing 24 W each (72 W) cabled to eth0/eth1/eth2 were all accepted, `poeDraw()` answered 3 W, and
// `show power inline` reported no budget at all because the allocator had none to report.
//
// Ubiquiti's tech-spec page for this SKU (`https://techspecs.ui.com/uisp/wired/n-sw`, HTTP 200,
// 575,565 B, server-rendered `<td class="key">` table, crawler user-agent, read 2026-11-21) prints:
//   Networking interface            (4) GbE RJ45 ports [(1) PoE-in, (3) PoE passthrough]
//   Power method                    Passive 24V, 2-pair PoE-in
//   Power consumption               Typical: 1.5W / Max.: 30W
//   Passive PoE Max. Wattage per port   24V, 2-pair, 1A per port (24W)
//   Total passive PoE Max. Wattaget     24V, 2-pair, 1A for 3 ports (30W)
// Three sockets at 24 W each reach 72 W, so the 30 W aggregate is the figure that has to bind; the
// per-port ceiling alone would still let two full loads through. The vendor prints no port numbers -
// only the count "(1) PoE-in, (3) PoE passthrough" - so the three sockets that already carried
// `poeOut` stay the PSE sockets and the fourth becomes the input. The sockets are 24 V passive, not
// 802.3af, which is what `poeOutClass` said before.
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
function spec(model) { return catalog.filter(function (s) { return s.model === model; })[0]; }

const NSW = spec('N-SW');
const R2AC = spec('R2AC');   // a 24 V passive PoE draw, 24 W

console.log('NanoSwitch: one PoE-in socket and three 24 W passthrough sockets');
{
  ok(!!NSW, 'N-SW is in the catalogue');
  const eth = (NSW.interfaces || []).filter(function (i) { return i.type === 'ethernet'; });
  ok(eth.length === 4, 'it has four RJ45 sockets (' + eth.length + ')');

  const pse = eth.filter(function (i) { return i.poeOut !== undefined && i.poeOut !== false && i.poeOut !== 0; });
  ok(pse.length === 3, 'three of them source power (' + pse.length + ')');
  ok(pse.every(function (i) { return i.poeOut === 24; }),
    'each declares the vendor\'s 24 W per-port ceiling, as a number (' +
    pse.map(function (i) { return i.name + '=' + JSON.stringify(i.poeOut); }).join(',') + ')');
  ok(!eth.some(function (i) { return i.poeOut === true; }),
    'no socket is left on the bare `poeOut: true` that poeDraw() reads as 1 W');
  ok(pse.every(function (i) { return i.poeOutClass === 'passive'; }),
    'the class is passive 24V, as the vendor prints, not 802.3af (' +
    pse.map(function (i) { return i.name + '=' + i.poeOutClass; }).join(',') + ')');

  const pd = eth.filter(function (i) { return i.poeIn !== undefined && i.poeIn !== false && i.poeIn !== 0; });
  ok(pd.length === 1, 'exactly one socket is the PoE-in the unit runs from (' + pd.length + ')');
  ok(pd.length === 1 && !pd[0].poeOut, 'and it sources nothing (' + (pd[0] && pd[0].poeOut) + ')');
  ok(NSW.capabilities.indexOf('poe-pd') !== -1 && pd.length === 1,
    'the poe-pd capability now has a socket that accepts power');

  ok(NSW.poe && NSW.poe.budgetW === 30,
    'the published aggregate is 30 W (' + (NSW.poe ? NSW.poe.budgetW : 'missing') + ')');
  ok(/^https:\/\/techspecs\.ui\.com\/uisp\/wired\/n-sw$/.test(String(NSW.poe && NSW.poe.sourceUrl)),
    'and the budget cites the vendor page it came from');
  ok(/30W/.test(String(NSW.poe && NSW.poe.note)) && /24W/.test(String(NSW.poe && NSW.poe.note)),
    'the note carries both the aggregate and the per-port figure');
}

console.log('\nOne 24 W radio is charged at 24 W, not at one watt');
{
  const t = new Topology();
  const sw = t.addDevice(NSW, 'sw');
  const dev = t.devices.get(sw.id);
  ok(dev.poeBudget === 30 && dev.poeBudgetSource === 'research',
    'the allocator sees 30 W from the spec (' + dev.poeBudget + ', ' + dev.poeBudgetSource + ')');

  const pd = t.addDevice(R2AC, 'radio');
  let err = null;
  try { t.connect(pd.id, 'eth0', sw.id, 'eth0'); } catch (e) { err = e; }
  ok(!err, 'a 24 V passive radio cables to eth0: ' + (err ? err.message : 'no refusal'));
  ok(dev.poeDraw() === 24, 'poeDraw() charges the port\'s 24 W ceiling (' + dev.poeDraw() + ')');

  const sim = new Simulator(t);
  sim.computePoe();
  const lines = (new CliSession(dev, t, sim).run('show power inline').output || []).map(String);
  ok(lines[0] === 'Available:30.0(w) Used:24.0(w) Remaining:6.0(w)',
    'the summary line is the vendor aggregate: ' + lines[0]);
}

console.log('\nThe 30 W aggregate binds on the second socket');
{
  const t = new Topology();
  const sw = t.addDevice(NSW, 'sw');
  const dev = t.devices.get(sw.id);
  const a = t.addDevice(R2AC, 'radio-a');
  const b = t.addDevice(R2AC, 'radio-b');
  t.connect(a.id, 'eth0', sw.id, 'eth0');
  let err = null;
  try { t.connect(b.id, 'eth0', sw.id, 'eth1'); } catch (e) { err = e; }
  ok(!!err && err.code === 'E_POE_BUDGET',
    'the second 24 W radio is refused with E_POE_BUDGET (' + (err && err.code) + ')');
  ok(/2 powered ports draw 48 W of a 30 W budget/.test(String(err && err.message)),
    'and the message names the arithmetic: ' + (err && err.message));
  ok(dev.poeDraw() === 24, 'only the accepted load is billed (' + dev.poeDraw() + ')');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
