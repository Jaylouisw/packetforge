'use strict';
// The Catalyst 2960X-48FPS-L is a 48-port PoE+ switch with a 740 W budget, and the catalogue gave it no
// PSE port and no budget at all - its own description said "48x 1G PoE+ downlinks (740 W budget)" while
// `show power inline` answered "% No PoE ... no port on this device can supply power".
//
// Cisco's hardware installation guide, Table 1 ("Catalyst 2960-X Switch Models and Descriptions"):
//
//   "Catalyst 2960X-48FPS-L | LAN Base | 48 10/100/1000 PoE+ ports (PoE budget of 740 W) and 4 SFP module
//    slots."
//
// and the same book's Technical Specifications:
//
//   "30 W-per-port maximum, 740-W switch maximum (Catalyst 2960X-48FPD-L and 2960X-48FPS-L switches)"
//
// so the model sources 802.3at on Gi1/0/1-48, the four SFP cages source nothing, and the budget - not the
// port count - is the ceiling: 24 Class-4 (25.5 W) APs fit (612 W), a 30th does not (765 W > 740 W).
// research/catalyst-2960x-poe-budget.md carries the evidence and what is still open.
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
const SWITCH = catalog.find(function (s) { return s.model === 'C2960X-48FPS-L'; });
const AP = catalog.find(function (s) { return s.vendor === 'aruba' && s.model === 'AP-515'; });

if (!SWITCH || !AP) {
  console.error('  \u2717 C2960X-48FPS-L or AP-515 is not in the catalogue');
  process.exit(1);
}

// The switch, wired to `n` access points on the first n copper ports. Nothing is configured: a real PoE
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
ok(SWITCH.poe && SWITCH.poe.budgetW === 740, 'C2960X-48FPS-L carries a 740 W budget');
ok(SWITCH.poe && SWITCH.poe.standard === '802.3at', 'and names 802.3at (PoE+) as the standard');
ok(SWITCH.poe && SWITCH.poe.perPortW === 30, 'and 30 W as the per-port maximum');
ok(SWITCH.portTemplate && SWITCH.portTemplate.poeOutClass === 'PoE+',
  'the template labels the downlinks PoE+');
ok(SWITCH.poe && /^https:\/\/www\.cisco\.com\//.test(String(SWITCH.poe.sourceUrl)),
  'with a cisco.com source URL');
ok(/740 W/.test(String(SWITCH.description)), 'the prose and the hardware agree on 740 W');

console.log('\nThe hardware, before any configuration:');
const dev = new Topology().addDevice(SWITCH, 'sw1');
ok(dev.poeBudget === 740, 'the device carries a 740 W budget (' + dev.poeBudget + ')');
ok(dev.poeBudgetSource === 'research', 'and the budget comes from the spec, not the model name (' +
  dev.poeBudgetSource + ')');
const ifaces = [...dev.interfaces.values()];
const pse = ifaces.filter(function (i) { return i.poeOut; });
ok(pse.length === 48, 'exactly 48 ports are PSE ports (' + pse.length + ')');
ok(pse.every(function (i) { return i.cage === 'rj45'; }), 'and every one of them is copper');
ok(pse.map(function (i) { return i.name; }).join(',') ===
  Array.from({ length: 48 }, function (_, i) { return 'Gi1/0/' + (i + 1); }).join(','),
  'they are Gi1/0/1 through Gi1/0/48, in order');
const cages = ['Gi1/0/49', 'Gi1/0/50', 'Gi1/0/51', 'Gi1/0/52'].map(function (n) { return dev.interfaces.get(n); });
ok(cages.every(function (i) { return i && !i.poeOut; }), 'the four SFP cages source no power');
ok(cages.every(function (i) { return i && i.cage === 'sfp'; }), 'and are still the fibre uplinks');

console.log('\n24 Class-4 access points fit in 740 W:');
{
  const { sim } = lab(24);
  const entry = sim.computePoe()[0];
  ok(entry.budget === 740, 'the run counts against 740 W');
  ok(entry.ports.length === 24, 'all 24 ports are accounted for');
  ok(entry.ports.every(function (p) { return p.powered; }), 'and all 24 are powered');
  ok(entry.used === 612, '612 W in use (24 x 25.5 W) - the whole fleet fits (' + entry.used + ' W)');
}

console.log('\nA 30th Class-4 access point is refused, not averaged:');
{
  const { t, sw, sim, cli } = lab(30);
  const entry = sim.computePoe()[0];
  const powered = entry.ports.filter(function (p) { return p.powered; });
  const denied = entry.ports.filter(function (p) { return !p.powered; });
  ok(powered.length === 29, '29 ports are powered (' + powered.length + ')');
  ok(denied.length === 1, 'and exactly one is denied');
  ok(denied[0] && denied[0].iface === 'Gi1/0/30', 'the last port in order loses out, not the first');
  ok(denied[0] && denied[0].reason === 'PSE budget exhausted: 25.5 W requested, 0.5 W left',
    'with the arithmetic in the box\'s own sentence');
  ok(entry.used === 739.5, '739.5 W of 740 W is in use (' + entry.used + ' W)');
  const ev = sim.events.filter(function (e) { return e.type === 'poe-deny'; })[0];
  ok(!!ev && ev.iface === 'Gi1/0/30', 'and a poe-deny event names the port');
  ok(t.getDevice('ap30').poeUnpowered === true, 'the refused access point is marked unpowered');

  const said = cli.run('show power inline').output.join('\n');
  ok(/^Total: 739\.5 W of 740 W in use, 0\.5 W left, 1 port denied$/m.test(said),
    '`show power inline` prints the same total');
  ok(/^  Gi1\/0\/30: PSE budget exhausted: 25\.5 W requested, 0\.5 W left$/m.test(said),
    'and the denial sentence once more under the table');
  ok(sw.poeBudget === 740, 'the budget is still the device\'s, not the run\'s');
}

console.log('\nA fibre uplink cannot be asked for power:');
{
  const { cli } = lab(1);
  const said = cli.run('show power inline Gi1/0/49').output.join('\n');
  ok(/cannot supply power \(it is not a PSE port\)/.test(said),
    'Gi1/0/49 answers that it is not a PSE port: ' + said);
  const plainTopo = new Topology();
  const plain = plainTopo.addDevice(catalog.find(function (s) {
    return s.model === 'C2960X-24TS-L';
  }), 'plain');
  const none = new CliSession(plain, plainTopo, null).run('show power inline').output.join('\n');
  ok(/% No PoE on .*no port on this device can supply power/.test(none),
    'the non-PoE 2960X-24TS-L still says it has no PoE at all');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
