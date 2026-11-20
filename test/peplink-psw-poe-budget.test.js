'use strict';
// The Peplink PSW switches: is the number in the model name the PoE budget the box ships with?
//
// `scripts/audit-poe-budget.js` reported exactly three devices whose budget was parsed out of the model
// string instead of read from a document - PSW-24-850W (850 W), PSW-48-800W (800 W) and PSW-8-240W-RUG
// (240 W). For two of them the name is right. For the rugged 8-port it is not:
//
//   SD Switch Rugged datasheet, ref sd-switch-rugged-202109-v14, 8-port column:
//     "Power Consumption | 20W System, 90W PoE+ Power Budget (supports up to 240W#)"
//     "# The bundled PSU provides 90W of PoE power budget. If you require 240W of power budget, please add
//      180W PSU (ACW-630) to your device."
//
//   SD Switch datasheet, ref sdswitch-201811-v5, ordering table:
//     "PSW-8-240W-RUG  Peplink SD Switch 8-Port Rugged, 8 ports, 90W power budget (Upgradable to 240W),
//      8x GE Ports (PoE+), 2x 1G SFP Ports."
//     "* The bundled PSU provides 90W of PoE+ power budget. Additional ACW-623 (180W PSU) is required to
//      enable up to 240W power budget."
//
// and the 2021 sheet's Package Content row puts a 120 W PSU in the box, which is the arithmetic behind the
// 90 W: 120 W - 20 W system = 100 W of supply, out of which the declared 90 W budget is drawn (the 24-port
// rugged does the same on its 180 W PSU: 180 - 50 = 130 W supply, 120 W budget). 240 W is 8 x 30 W, the full
// 802.3at class ceiling, and it needs the extra supply. So the box out of the crate funds 90 W, and this
// console - which read the name - credited it with 150 W it does not have.
//
// research/peplink-psw-poe-budget.md carries the quotes, the retailer pages that disagree with each other,
// and the two questions a bench reading would settle (the firmware cap and the terminal-block supply).
const path = require('path');
const { Topology, Simulator } = require('../engine');
const { CliSession } = require('../engine/cli');
const { loadCatalog } = require('../devices/registry');
const media = require('../engine/media');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}
function section(name) { console.log('\n' + name); }

const catalog = loadCatalog(path.join(__dirname, '..', 'devices')).filter(function (s) { return !s.error; });
const find = function (model) { return catalog.filter(function (s) { return s.model === model; })[0]; };
const RUG = find('PSW-8-240W-RUG');
const SW24 = find('PSW-24-850W');
const SW48 = find('PSW-48-800W');
const AP = catalog.filter(function (s) { return s.vendor === 'aruba' && s.model === 'AP-515'; })[0];

if (!RUG || !SW24 || !SW48 || !AP) {
  console.error('  \u2717 the three PSW specs or the AP-515 are not in the catalogue');
  process.exit(1);
}

// n access points on the first n copper ports, nothing configured - a PoE switch supplies power out of the
// box, so a budget is all that stands between the fleet and the ceiling.
function lab(spec, n) {
  const t = new Topology();
  const sw = t.addDevice(spec, 'sw1');
  for (let i = 1; i <= n; i++) {
    t.addDevice(AP, 'ap' + i);
    t.connect('ap' + i, 'eth0', 'sw1', 'ge' + i);
  }
  const sim = new Simulator(t);
  return { t: t, sw: sw, sim: sim, cli: new CliSession(sw, t, sim) };
}

section('The rugged 8-port spec states the vendor\'s figures, not the model name\'s');
ok(RUG.poe && RUG.poe.budgetW === 90, 'the PSW-8-240W-RUG carries 90 W, the budget its bundled PSU funds');
ok(RUG.poe && RUG.poe.standard === '802.3at', 'and names 802.3at (PoE+) as the standard');
ok(RUG.poe && RUG.poe.perPortW === 30, 'and 30 W as the per-port maximum - 8 x 30 W is the 240 W ceiling');
ok(RUG.poe && /^https:\/\/download\.peplink\.com\//.test(String(RUG.poe.sourceUrl)),
  'with a peplink.com source URL', RUG.poe && RUG.poe.sourceUrl);
ok(RUG.poe && /240\s*W/.test(String(RUG.poe.note)) && /ACW-630/.test(String(RUG.poe.note)),
  'the note keeps the 240 W ceiling and the accessory that reaches it, so the name is explained');
ok(/90 W/.test(String(RUG.description)) && /240 W/.test(String(RUG.description)),
  'the description says 90 W as shipped and names the 240 W option', RUG.description);

section('The device takes that figure, and the name is not it');
{
  const t = new Topology();
  const sw = t.addDevice(RUG, 'sw1');
  ok(sw.poeBudget === 90, 'poeBudget is 90 W (' + sw.poeBudget + ')');
  ok(sw.poeBudgetSource === 'research', 'and its provenance is a document, not the name (' + sw.poeBudgetSource + ')');
  ok(media.parsePoeBudget('PSW-8-240W-RUG') === 240,
    'the model string still parses to 240 - which is the trap this spec now steps out of');
}

section('Three access points fit in 90 W, and the fourth is refused - the 240 W figure would have powered all 8');
{
  const { sim, sw, cli } = lab(RUG, 4);
  const entry = sim.computePoe()[0];
  ok(entry.budget === 90, 'the run counts against 90 W');
  const powered = entry.ports.filter(function (p) { return p.powered; });
  const denied = entry.ports.filter(function (p) { return !p.powered; });
  ok(powered.length === 3, '3 ports are powered (' + powered.length + ')');
  ok(denied.length === 1 && denied[0].iface === 'ge4', 'and ge4 is denied',
    denied[0] && denied[0].iface);
  ok(denied[0] && denied[0].reason === 'PSE budget exhausted: 25.5 W requested, 13.5 W left',
    'with the arithmetic in the box\'s own sentence', denied[0] && denied[0].reason);
  ok(entry.used === 76.5, '76.5 W of 90 W is in use (' + entry.used + ')');
  const said = cli.run('show power inline').output.join('\n');
  ok(/^Available:90\.0\(w\) Used:76\.5\(w\) Remaining:13\.5\(w\)$/m.test(said),
    '`show power inline` prints the 90 W budget, not 240 W', said.split('\n')[0]);
  ok(/^  ge4: PSE budget exhausted: 25\.5 W requested, 13\.5 W left$/m.test(said),
    'and the denial under the table');
  ok(sw.poeBudget === 90, 'the budget is the device\'s, not the run\'s');
}

section('The 24- and 48-port: the name is the shipped budget, and now the spec says so');
{
  ok(SW24.poe && SW24.poe.budgetW === 850, 'PSW-24-850W carries 850 W');
  ok(SW48.poe && SW48.poe.budgetW === 800, 'PSW-48-800W carries 800 W');
  ok([SW24, SW48].every(function (s) {
    return s.poe && /^https:\/\/download\.peplink\.com\//.test(String(s.poe.sourceUrl));
  }), 'both cite Peplink\'s own datasheet');
  const t24 = new Topology();
  const d24 = t24.addDevice(SW24, 'sw24');
  ok(d24.poeBudget === 850 && d24.poeBudgetSource === 'research',
    'the 24-port device takes 850 W from the document (' + d24.poeBudget + ' / ' + d24.poeBudgetSource + ')');
}

section('No Peplink PSW is name-derived any more');
{
  const psw = catalog.filter(function (s) { return s.vendor === 'peplink' && /^PSW-/.test(String(s.model)); });
  ok(psw.length === 3, 'the catalogue holds 3 PSW models (' + psw.length + ')');
  const named = [];
  for (const spec of psw) {
    const t = new Topology();
    const dev = t.addDevice(spec, 'x');
    if (dev.poeBudgetSource === 'name') named.push(spec.model);
  }
  ok(named.length === 0, 'none of them reads its budget off the model string',
    named.join(', '));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
