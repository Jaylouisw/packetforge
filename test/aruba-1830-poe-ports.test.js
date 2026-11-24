'use strict';
// Which copper sockets on an Aruba Instant On 1830 PoE switch can source power, and at how many watts.
//
// The models are sold by that number - "8G 4p Class4 PoE 65W" (JL811A), "24G 12p Class4 PoE 2SFP
// 195W" (JL813A), "48G 24p Class4 PoE 4SFP 370W" (JL815A) - so the split is the product, not a
// detail. HPE prints it three ways in the same document set:
//
//   Installation and Getting Started guide, "1830 Switch Series PoE Power Delivery":
//     JL811A  65W   Ports 1 - 4    4 ports at 15.4W    2 ports at 30W
//     JL813A  195W  Ports 1 - 12  12 ports at 15.4W    6 ports at 30W
//     JL815A  370W  Ports 1-24    24 ports at 15.4W   12 ports at 30W
//   (https://arubanetworking.hpe.com/techdocs/hardware/switches/1830/1830_IGSG.pdf)
//
//   the same guide's front-panel figures, which draw "PoE & 1GbE RJ45 ports" and "1GbE RJ45 ports"
//   as two separate callouts on the JL811A, JL813A and JL815A;
//
//   the data sheet's I/O row - "8 RJ-45 autosensing 10/100/1000 ports IEEE 802.3at Class 4 PoE
//   (ports 1-4)" for the JL811A, "(ports 1-12)" for the JL813A, "(ports 1-24)" for the JL815A;
//
//   and the regulatory sheet's PoE output table - "30W per port, 4 ports, total max. output power
//   65W" (https://arubanetworking.hpe.com/techdocs/hardware/switches/1830/1830_SH_EN.pdf).
//
// The specs named the subset only in the free-text `poe.note` and left every port object silent, so
// the engine's switch rule inferred an 802.3af 15.4 W PSE on ALL copper ports: the data sockets
// powered powered devices, the PoE sockets advertised 15.4 W instead of 30 W, and `show power inline`
// counted ports that cannot source a watt. research/aruba-1830-poe-ports.md carries the evidence and
// what is still open (the 1960 family's 20/4 split, and the cabling guard's worst-case arithmetic).
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
function spec(model) {
  const s = catalog.find(function (x) { return x.model === model; });
  if (!s) throw new Error('missing spec ' + model);
  return s;
}
function names(n) { const out = []; for (let i = 1; i <= n; i++) out.push(String(i)); return out; }

const MODELS = [
  { model: 'Instant On 1830 8G 4p Class4 PoE 65W (JL811A)', budget: 65, poe: 4, sfp: [] },
  { model: 'Instant On 1830 24G 12p Class4 PoE 2SFP 195W (JL813A)', budget: 195, poe: 12, sfp: ['25', '26'] },
  { model: 'Instant On 1830 48G 24p Class4 PoE 4SFP 370W (JL815A)', budget: 370, poe: 24, sfp: ['49', '50', '51', '52'] }
];
const AP = spec('Instant On AP11 (R2W96A)');

console.log('The vendor split is in the spec, not only in its prose:');
for (const m of MODELS) {
  const s = spec(m.model);
  ok(s.poe && s.poe.budgetW === m.budget, m.model + ' carries the ' + m.budget + ' W budget');
  ok(s.poe && s.poe.standard === '802.3at', 'and names 802.3at, the standard on the data sheet');
  ok(s.poe && s.poe.perPortW === 30, 'and 30 W as the per-port ceiling, the sheet\'s row');
}

console.log('\nEvery model sources on the low-numbered copper ports only:');
for (const m of MODELS) {
  const s = spec(m.model);
  const t = new Topology();
  const dev = t.addDevice(s, 'sw1');
  const ifaces = [...dev.interfaces.values()];
  const pse = ifaces.filter(function (i) { return i.poeOut; });
  const expected = names(m.poe);
  ok(pse.map(function (i) { return i.name; }).join(',') === expected.join(','),
    m.model + ': the PSE ports are ' + expected[0] + '-' + expected[expected.length - 1] +
    ' and nothing else', pse.map(function (i) { return i.name; }).join(','));
  ok(pse.length === m.poe, 'exactly ' + m.poe + ' sockets source power (' + pse.length + ')');
  ok(pse.every(function (i) { return i.poeOut === 30; }),
    'and every one of them is a 30 W Class 4 outlet, not the inferred 15.4 W',
    pse.map(function (i) { return i.poeOut; }).join(','));
  const declared = s.interfaces.filter(function (i) { return i.poeOut; });
  ok(declared.length === m.poe && declared.every(function (i) { return i.poeOutClass === 'PoE+'; }),
    'and the spec labels ' + declared.length + ' of them PoE+ (Class 4)');
  ok(pse.every(function (i) { return i.cage === 'rj45'; }), 'and all of them are copper');

  const data = ifaces.filter(function (i) { return /^\d+$/.test(i.name) && Number(i.name) > m.poe; });
  ok(data.length > 0 && data.every(function (i) { return i.poeOut === 0; }),
    'the other ' + data.length + ' copper sockets state 0 - they source nothing, and the number keeps ' +
    'inference from promoting them again', data.map(function (i) { return i.name + '=' + i.poeOut; }).join(' '));

  const sfp = m.sfp.map(function (n) { return dev.interfaces.get(n); });
  ok(sfp.every(function (i) { return i && !i.poeOut; }),
    m.sfp.length ? 'the ' + m.sfp.length + ' SFP cages source nothing' : 'and this model has no SFP cage to source power');
}

// One JL811A; an AP11 on the socket named in `port`, and optionally more of them.
function lab(ports, opts) {
  const t = new Topology();
  const sw = t.addDevice(spec(MODELS[0].model), 'sw1');
  ports.forEach(function (p, i) {
    t.addDevice(AP, 'ap' + (i + 1));
    t.connect('ap' + (i + 1), 'eth0', 'sw1', p, opts);
  });
  const sim = new Simulator(t);
  sim.computePoe();  // a box out of the box has already classified what is plugged into it
  const cli = new CliSession(sw, t, sim);
  cli.run('enable');
  return { t: t, sw: sw, sim: sim, lines: cli.run('show power inline').output };
}

console.log('\nA powered device on a data-only socket gets no power:');
{
  const { sim, lines } = lab(['5']);
  const entry = sim.computePoe()[0];
  ok(entry.ports.length === 0, 'the run has no PoE port in play at all (' + entry.ports.length + ')');
  ok(lines[0] === 'Available:65.0(w) Used:0.0(w) Remaining:65.0(w)',
    'the budget line counts nothing used: ' + lines[0]);
  ok(!lines.some(function (l) { return /^5\s/.test(l); }), 'and port 5 is not a row in the table');
  ok(lines[lines.length - 1] === '4 ports with nothing plugged in: 1, 2, 3, 4',
    'the "nothing plugged in" list is the four PoE sockets, not all eight: ' + lines[lines.length - 1]);
}

console.log('\nA powered device on a PoE socket is powered at its own draw:');
{
  const { sim, lines } = lab(['4']);
  const entry = sim.computePoe()[0];
  const p = entry.ports.find(function (x) { return x.iface === '4'; });
  ok(!!p && p.powered === true, 'port 4 powers the AP');
  ok(entry.used === 12.9, 'and 12.9 W - the AP\'s draw, not the port\'s 30 W ceiling (' + entry.used + ')');
  ok(lines.some(function (l) { return /^4\s+auto\s+on\s+12\.9\s+/.test(l); }),
    'show power inline prints the row: ' + (lines[4] || ''));
}

console.log('\nFour 12.9 W APs fit a 65 W budget in the run (the guide\'s "4 at 15.4W" row):');
{
  // Connected with `force` because the cabling guard charges the port's capability (30 W), the
  // worst case the guide also prints ("2 at 30W"); the run allocates by usage, the vendor's default
  // mode. The guard is asserted on its own below, and the tension is recorded in the research note.
  const { sim, lines } = lab(['1', '2', '3', '4'], { force: true });
  const entry = sim.computePoe()[0];
  ok(entry.ports.filter(function (p) { return p.powered; }).length === 4, 'all four are powered');
  ok(entry.used === 51.6, '51.6 W of 65 W in use (' + entry.used + ')');
  ok(lines[0] === 'Available:65.0(w) Used:51.6(w) Remaining:13.4(w)', 'the header adds up: ' + lines[0]);
}

console.log('\nThe cabling guard is the worst case, and it is the same gate as everywhere else:');
{
  const t = new Topology();
  const sw = t.addDevice(spec(MODELS[0].model), 'sw1');
  let err = null;
  for (let i = 1; i <= 3; i++) {
    t.addDevice(AP, 'ap' + i);
    try { t.connect('ap' + i, 'eth0', 'sw1', String(i)); } catch (e) { err = e; }
  }
  ok(!!err && err.code === 'E_POE_BUDGET', 'the third 30 W socket is refused when cabled (E_POE_BUDGET)');
  ok(/3 powered ports draw 90 W of a 65 W budget/.test(String(err && err.message)),
    'and the sentence does the arithmetic against the vendor budget: ' + (err && err.message));
  ok(sw.poeBudget === 65, 'while the budget itself is untouched by the refusal');
}

console.log('\nThe data-only siblings still source nothing:');
for (const model of ['Instant On 1830 8G (JL810A)', 'Instant On 1830 24G 2SFP (JL812A)', 'Instant On 1830 48G 4SFP (JL814A)']) {
  const t = new Topology();
  const dev = t.addDevice(spec(model), 'sw9');
  const pse = [...dev.interfaces.values()].filter(function (i) { return i.poeOut; });
  ok(pse.length === 0, model + ' has no PSE port (' + pse.length + ')');
}
{
  const t = new Topology();
  const dev = t.addDevice(spec('Instant On 1830 8G (JL810A)'), 'sw9');
  const cli = new CliSession(dev, t, new Simulator(t));
  cli.run('enable');
  const lines = cli.run('show power inline').output;
  ok(/^% No PoE on /.test(lines[0]), 'and `show power inline` refuses in words: ' + lines[0]);
}

console.log('');
if (failed) {
  console.log(failed + ' failed, ' + passed + ' passed');
  process.exit(1);
}
console.log(passed + ' passed, 0 failed');
