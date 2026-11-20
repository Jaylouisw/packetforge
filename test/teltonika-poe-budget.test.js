'use strict';
// Teltonika's PoE switches: the total the datasheet prints, and the sockets it is spent on.
//
// `scripts/audit-poe-budget.js` named seven Teltonika boxes that source power and could not say how much
// of it (`tsw100`, `tsw101`, `tsw200`, `tsw202`, `swm280`, `swm282`; `tsf000` had a budget but the same port
// census defect). Every one of them publishes both rows in one table - "PoE ports Port 1-n" and "Total PoE
// Power Budget (at PSE) n W" - so the defect was not a missing number, it was a number nobody had read.
//
// The second half of the census is the part the engine gets wrong on its own: a copper port on a device that
// claims `poe-pse`, with no `poeOut` key, is inferred to be a 15.4 W 802.3af PSE (engine/media.js). On these
// models that inference invented outlets the vendor does not fit:
//
//   * tsw100 and tsf000 - the fifth port is the uplink ("4 x PoE, 1 x Uplink");
//   * tsw101 - the same, on the automotive box;
//   * swm280 - the twelve plain Gigabit ports of the mixed variant, beside its twelve PoE+ ports.
//
// With no budget those phantom ports cost nothing (computePoe() skips a box with no budget). With the budget
// added they become spendable, so the two rows have to be fixed together: a 300 W budget on SWM280 spread over
// twenty-four inferred outlets is a box that can power a device on a port with no PoE hardware behind it.
// research/teltonika-poe-budgets.md holds the quotes and the read dates.
const path = require('path');
const { Topology, Simulator } = require('../engine');
const { CliSession } = require('../engine/cli');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}
function section(name) { console.log('\n' + name); }

const catalog = loadCatalog(path.join(__dirname, '..', 'devices')).filter(function (s) { return !s.error; });
const find = function (model) { return catalog.filter(function (s) { return s.model === model; })[0]; };

// The vendor's two rows, per model: the total budget and the sockets it is printed against.
const MODELS = [
  { model: 'TSW100', budget: 120, pse: 4, doc: 'tsw100-datasheet' },
  { model: 'TSW101', budget: 60, pse: 4, doc: 'farnell.com/datasheets/4785183' },
  { model: 'TSW200', budget: 240, pse: 8, doc: 'tsw200-datasheet' },
  { model: 'TSW202', budget: 240, pse: 8, doc: 'tsw202-datasheet' },
  { model: 'SWM280', budget: 300, pse: 12, doc: 'swm280-datasheet' },
  { model: 'SWM282', budget: 300, pse: 24, doc: 'swm282-datasheet' },
  { model: 'TSF000', budget: 120, pse: 4, doc: 'wiki.teltonika-networks.com/view/TSF000' }
];

section('Each spec states the vendor figure, sourced to the vendor document');
MODELS.forEach(function (row) {
  const spec = find(row.model);
  ok(!!spec, row.model + ' is in the catalogue');
  ok(spec && spec.poe && spec.poe.budgetW === row.budget,
    row.model + ' states ' + row.budget + ' W', spec && spec.poe && spec.poe.budgetW);
  ok(spec && spec.poe && String(spec.poe.sourceUrl).indexOf(row.doc) !== -1,
    '  and cites ' + row.doc, spec && spec.poe && spec.poe.sourceUrl);
  ok(spec && spec.poe && String(spec.poe.note).indexOf(String(row.budget) + ' W') !== -1,
    '  and the note quotes the row it was read from');
});

section('The engine reads it: `show power inline` answers with the budget');
MODELS.forEach(function (row) {
  const t = new Topology();
  const dev = t.addDevice(find(row.model), 'd1');
  ok(dev.poeBudget === row.budget && dev.poeBudgetSource === 'research',
    row.model + ' resolves ' + dev.poeBudget + ' W from the document (' + dev.poeBudgetSource + ')');
  const sim = new Simulator(t);
  sim.computePoe();
  const said = new CliSession(dev, t, sim).run('show power inline').output.join('\n');
  ok(new RegExp('^Available:' + row.budget + '\\.0\\(w\\)', 'm').test(said),
    '  Available:' + row.budget + '.0(w)', said.split('\n')[0]);
  ok(said.indexOf('budget not modelled') === -1, '  and never the not-modelled sentence');
});

section('The PSE list is the vendor\'s "Port 1-n", not the engine\'s inference');
MODELS.forEach(function (row) {
  const t = new Topology();
  const dev = t.addDevice(find(row.model), 'd1');
  const pse = [...dev.interfaces.values()].filter(function (p) { return p.poeOut; });
  ok(pse.length === row.pse, row.model + ': ' + row.pse + ' PSE ports', String(pse.length));
  ok(pse.every(function (p) { return p.poeOut > 0 && p.hardware.poeOutDeclared === true; }),
    '  every one declared by the spec (' + pse.filter(function (p) { return p.hardware.poeOutDeclared === true; }).length + ')');
  const copper = [...dev.interfaces.values()].filter(function (p) { return p.cage === 'rj45'; });
  const plain = copper.filter(function (p) { return !p.poeOut; });
  ok(plain.every(function (p) { return p.poeOut === false && p.hardware.poeOutDeclared === true; }),
    '  and its plain copper ports say so ("poeOut": false) instead of being inferred at 15.4 W',
    plain.map(function (p) { return p.name + '=' + String(p.poeOut); }).join(','));
});

section('A non-PSE socket refuses the question rather than reporting power');
{
  const cases = [
    { model: 'TSW100', port: 'eth0', what: 'the uplink' },
    { model: 'TSW101', port: 'eth5', what: 'the uplink' },
    { model: 'SWM280', port: 'eth20', what: 'the plain Gigabit half' },
    { model: 'TSF000', port: 'eth0', what: 'the uplink' }
  ];
  cases.forEach(function (c) {
    const t = new Topology();
    const dev = t.addDevice(find(c.model), 'd1');
    const sim = new Simulator(t);
    sim.computePoe();
    const said = new CliSession(dev, t, sim).run('show power inline ' + c.port).output.join('\n');
    ok(said.indexOf('cannot supply power (it is not a PSE port)') !== -1,
      c.model + ' ' + c.port + ' (' + c.what + ') is not a PSE port', said.split('\n')[0]);
  });
}

section('The budget, not the port class, is what refuses the next device');
// The cable is reserved at the port's own ceiling (30 W), not at the PD's nameplate draw, so the count that
// fits is budget / 30: two on the 60 W automotive box, ten on either 300 W chassis, and every port on the three
// models whose total is exactly ports x 30.
const PD = 'AP-515';
function pseNames(model) {
  const t = new Topology();
  const dev = t.addDevice(find(model), 'sw');
  return [...dev.interfaces.values()].filter(function (p) { return p.poeOut; }).map(function (p) { return p.name; });
}
function wire(model, n) {
  const t = new Topology();
  const sw = t.addDevice(find(model), 'sw');
  const names = pseNames(model);
  for (let i = 1; i <= n; i++) {
    const pd = t.addDevice(find(PD), 'ap' + i);
    const inPort = [...pd.interfaces.values()].filter(function (p) { return p.poeIn; })[0];
    t.connect('sw', names[i - 1], 'ap' + i, inPort.name);
  }
  return { t: t, sw: sw };
}
function cablesUntilRefusal(model) {
  const limit = pseNames(model).length;
  let n = 0, error = null;
  for (let i = 1; i <= limit; i++) {
    try { wire(model, i); n = i; } catch (e) { error = e; break; }
  }
  return { fit: n, error: error, ports: limit };
}
[
  { model: 'TSW101', fit: 2, budget: 60 },
  { model: 'SWM280', fit: 10, budget: 300 },
  { model: 'SWM282', fit: 10, budget: 300 }
].forEach(function (row) {
  const r = cablesUntilRefusal(row.model);
  ok(r.fit === row.fit, row.model + ': ' + row.fit + ' ports reserve 30 W each before the budget runs out', String(r.fit));
  ok(!!r.error && r.error.code === 'E_POE_BUDGET',
    '  the next cable is refused as a budget overrun', r.error && r.error.code);
  ok(!!r.error && new RegExp('of a ' + row.budget + ' W budget').test(r.error.message),
    '  and the sentence quotes the ' + row.budget + ' W budget', r.error && r.error.message);
});
// The full-fill models: 30 W a port x the port count lands exactly on the total, so nothing is refused.
[
  { model: 'TSW100', ports: 4 },
  { model: 'TSW200', ports: 8 },
  { model: 'TSW202', ports: 8 }
].forEach(function (row) {
  const r = cablesUntilRefusal(row.model);
  ok(r.fit === row.ports && !r.error,
    row.model + ': all ' + row.ports + ' ports fund a 25.5 W device with nothing refused',
    r.fit + ' fit, ' + (r.error && r.error.message));
});

section('A refused port still reads power-deny, and the arithmetic is printed under the table');
{
  // Twelve cables on a 300 W chassis: the last one cannot be funded once the real draw is counted. The cables
  // are made while the budget is large enough to accept them and the real figure is put back before the
  // allocation runs, which is how test/show-power-inline.test.js reaches the same state - a denial is a result
  // about power, not a refused cable.
  const t = new Topology();
  const sw = t.addDevice(find('SWM280'), 'sw');
  const names = pseNames('SWM280');
  sw.poeBudget = 400;
  for (let i = 1; i <= 12; i++) {
    const pd = t.addDevice(find(PD), 'ap' + i);
    const inPort = [...pd.interfaces.values()].filter(function (p) { return p.poeIn; })[0];
    t.connect('sw', names[i - 1], 'ap' + i, inPort.name);
  }
  sw.poeBudget = 300;
  const sim = new Simulator(t);
  sim.computePoe();
  const said = new CliSession(sw, t, sim).run('show power inline').output.join('\n');
  // Eleven ports powered at the PD's 25.5 W nameplate = 280.5 W supplied; the twelfth (306 W) is refused.
  ok(/^Available:300\.0\(w\) Used:280\.5\(w\) Remaining:19\.5\(w\)$/m.test(said),
    'Available 300.0, Used 280.5, Remaining 19.5', said.split('\n')[0]);
  const deny = said.split('\n').filter(function (l) { return l.indexOf('power-deny') !== -1; });
  ok(deny.length === 1 && /^eth11\b/.test(deny[0]), 'exactly one port is power-deny, and it is eth11',
    deny.join(' | '));
  ok(/eth11:\s+PSE budget exhausted/.test(said), 'and the denial sentence is printed under the table');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
