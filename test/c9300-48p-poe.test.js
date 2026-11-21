'use strict';
// The Catalyst 9300-48P is a 48-port PoE+ switch with a 437 W default budget, and the catalogue gave it
// no PSE port and no budget at all - its own description said "48x 1G PoE+ (437 W budget)" while
// `show power inline` answered "% No PoE ... no port on this device can supply power", and the device
// fell through to the model-name parser for a budget (0 W, source "name").
//
// Cisco's Catalyst 9300 data sheet, Table 1 ("switch configurations"), prints the row:
//
//   "C9300-48P | 48 POE+ | Modular Uplinks | 715W AC | 437W"
//
// Table 3 ("PoE power capacity") gives 437 W on the default PWR-C1-715WAC, 787 W with a 350 W secondary,
// 1152 W with a 715 W secondary and 1440 W with a 1100 W secondary, and the PoE feature list states
// "PoE+ on all ports (30W per port)". The 1440 W figure carries the footnote "Limited by port number and
// port rating (e.g. 24 PoE+ 30W ports = 720W)" - the budget is the ceiling this model must keep.
//
//   https://www.cisco.com/c/en/us/products/collateral/switches/catalyst-9300-series-switches/nb-06-cat9300-ser-data-sheet-cte-en.html
//
// So the model sources 802.3at at 30 W on Gi1/0/1-48, its eight Gi1/1/x modular uplinks source nothing,
// and the 437 W budget - not the 48-port count - is what refuses the 18th Class-4 access point
// (17 x 25.5 W = 433.5 W; the 18th needs 25.5 W and only 3.5 W is left).
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
const SWITCH = catalog.find(function (s) { return s.model === 'C9300-48P'; });
const AP = catalog.find(function (s) { return s.vendor === 'aruba' && s.model === 'AP-515'; });

if (!SWITCH || !AP) {
  console.error('  \u2717 C9300-48P or AP-515 is not in the catalogue');
  process.exit(1);
}

// The switch, wired to `n` access points on the first n copper ports. Nothing is configured: a PoE+
// switch supplies power out of the box, so no CLI line is run before the budget is asked for.
function lab(n) {
  const t = new Topology();
  const sw = t.addDevice(SWITCH, 'sw1');
  for (let i = 1; i <= n; i++) {
    const id = 'ap' + i;
    t.addDevice(AP, id);
    t.connect(id, 'eth0', 'sw1', 'Gi1/0/' + i);
  }
  const sim = new Simulator(t);
  return { t: t, sw: sw, sim: sim, cli: new CliSession(sw, t, sim) };
}

console.log('The spec states the budget Cisco publishes:');
ok(SWITCH.poe && SWITCH.poe.budgetW === 437, 'C9300-48P carries a 437 W budget');
ok(SWITCH.poe && SWITCH.poe.standard === '802.3at', 'and names 802.3at (PoE+) as the standard');
ok(SWITCH.poe && SWITCH.poe.perPortW === 30, 'and 30 W as the per-port maximum');
ok(SWITCH.poe && /^https:\/\/www\.cisco\.com\//.test(String(SWITCH.poe.sourceUrl)),
  'with a cisco.com source URL');
ok(SWITCH.portTemplate && SWITCH.portTemplate.poeOutClass === 'PoE+',
  'the template labels the downlinks PoE+');
ok(/437 W/.test(String(SWITCH.description)), 'the prose and the hardware agree on 437 W');
ok((SWITCH.capabilities || []).includes('poe-pse'), 'and the box declares itself a PSE');

console.log('\nThe hardware, before any configuration:');
const dev = new Topology().addDevice(SWITCH, 'sw1');
ok(dev.poeBudget === 437, 'the device carries a 437 W budget (' + dev.poeBudget + ')');
ok(dev.poeBudgetSource === 'research', 'and the budget comes from the spec, not the model name (' +
  dev.poeBudgetSource + ')');
const ifaces = [...dev.interfaces.values()];
const pse = ifaces.filter(function (i) { return i.poeOut; });
ok(pse.length === 48, 'exactly 48 ports are PSE ports (' + pse.length + ')');
ok(pse.every(function (i) { return i.cage === 'rj45'; }), 'and every one of them is copper');
ok(pse.map(function (i) { return i.name; }).join(',') ===
  Array.from({ length: 48 }, function (_, i) { return 'Gi1/0/' + (i + 1); }).join(','),
  'they are Gi1/0/1 through Gi1/0/48, in order');
const uplinks = ['Gi1/1/1', 'Gi1/1/2', 'Gi1/1/3', 'Gi1/1/4', 'Gi1/1/5', 'Gi1/1/6', 'Gi1/1/7', 'Gi1/1/8']
  .map(function (n) { return dev.interfaces.get(n); });
ok(uplinks.every(function (i) { return i && !i.poeOut; }), 'the eight modular uplinks source no power');
ok(uplinks.every(function (i) { return i && i.cage === 'sfp+'; }), 'and are still the fibre uplinks');

console.log('\n17 Class-4 access points fit in 437 W:');
{
  const { sim } = lab(17);
  const entry = sim.computePoe()[0];
  ok(entry.budget === 437, 'the run counts against 437 W');
  ok(entry.ports.length === 17, 'all 17 ports are accounted for');
  ok(entry.ports.every(function (p) { return p.powered; }), 'and all 17 are powered');
  ok(entry.used === 433.5, '433.5 W in use (17 x 25.5 W) (' + entry.used + ' W)');
}

console.log('\nAn 18th Class-4 access point is refused, not averaged:');
{
  const { t, sw, sim, cli } = lab(18);
  sim.computePoe();
  const entry = sim.computePoe()[0];
  const powered = entry.ports.filter(function (p) { return p.powered; });
  const denied = entry.ports.filter(function (p) { return !p.powered; });
  ok(powered.length === 17, '17 ports are powered (' + powered.length + ')');
  ok(denied.length === 1, 'and exactly one is denied');
  ok(denied[0] && denied[0].iface === 'Gi1/0/18', 'the last port in order loses out, not the first');
  ok(denied[0] && denied[0].reason === 'PSE budget exhausted: 25.5 W requested, 3.5 W left',
    'with the arithmetic in the box\'s own sentence');
  ok(entry.used === 433.5, '433.5 W of 437 W is in use (' + entry.used + ' W)');
  const ev = sim.events.filter(function (e) { return e.type === 'poe-deny'; })[0];
  ok(!!ev && ev.iface === 'Gi1/0/18', 'and a poe-deny event names the port');
  ok(t.getDevice('ap18').poeUnpowered === true, 'the refused access point is marked unpowered');

  const said = cli.run('show power inline').output.join('\n');
  ok(/^Available:437\.0\(w\) Used:433\.5\(w\) Remaining:3\.5\(w\)$/m.test(said),
    '`show power inline` prints the same budget summary');
  ok(/^  Gi1\/0\/18: PSE budget exhausted: 25\.5 W requested, 3\.5 W left$/m.test(said),
    'and the denial sentence once more under the table');
  ok(sw.poeBudget === 437, 'the budget is still the device\'s, not the run\'s');
}

console.log('\nA modular uplink cannot be asked for power:');
{
  const { cli } = lab(1);
  const said = cli.run('show power inline Gi1/1/1').output.join('\n');
  ok(/cannot supply power \(it is not a PSE port\)/.test(said),
    'Gi1/1/1 answers that it is not a PSE port: ' + said);
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
