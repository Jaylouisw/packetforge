'use strict';
// `show power inline` — the console catches up with a mechanism it never reported (#1295).
//
// PoE has been modelled since the engine gained `computePoe()`: the budget is allocated in port order, a denial
// emits a `poe-deny` event with a reason, the powered device is flagged `unpowered`, and the inspector panel
// displays the whole thing. The console — the surface this project is for — could not answer "how much power is
// drawn, and why did that port get nothing". Every other modelled mechanism has a `show`.
//
// So this is a read-only view of an existing result, not a new mechanism. What it must get right:
//
//   * the numbers come from `sim.poe` (the engine's own allocation), never from a second copy of the rule;
//   * a port the engine leaves out of its table is still named, with the reason it supplies nothing;
//   * the denial sentence is the one the timeline emitted, not a re-rendering of the same arithmetic;
//   * "not measured" (nothing has run) is different from "measured zero";
//   * a device with no budget says so instead of reporting 0 W it never measured;
//   * and it agrees with the inspector panel, port by port, because the panel is the other surface that shows
//     this.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { Topology, Simulator } = require('../engine');
const { CliSession } = require('../engine/cli');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices')).filter(function (s) { return !s.error; });
function spec(vendor, model) {
  const s = catalog.find(function (x) { return x.vendor === vendor && x.model === model; });
  if (!s) throw new Error('missing spec ' + vendor + ' ' + model);
  return s;
}

function lab(opts) {
  opts = opts || {};
  const t = new Topology();
  const sw = t.addDevice(spec('aruba', 'CX 6000 24G CL4 PoE 4SFP 370W'), 'sw');
  sw.name = 'SW1';
  const hosts = {};
  for (const c of (opts.cable || [])) {
    if (!hosts[c.pd]) {
      const s = c.plain ? spec('asus', 'RT-AX86U Pro') : spec('ubiquiti', 'UCG-Ultra');
      const d = t.addDevice(s);
      d.name = 'PD' + c.pd.toUpperCase();
      hosts[c.pd] = { dev: d, port: c.plain ? [...d.interfaces.values()][0].name : 'port1' };
    }
    t.connect(hosts[c.pd].dev.id, hosts[c.pd].port, sw.id, c.port);
  }
  // `budget: null` means "no budget modelled", which the catalogue model has by default - so it has to be
  // cleared, not merely left alone.
  if (opts.budget === null) sw.poeBudget = 0;
  else sw.poeBudget = opts.budget === undefined ? 370 : opts.budget;
  for (const name of (opts.disable || [])) {
    const iface = sw.interfaces.get(name);
    if (iface) iface.enabled = false;
  }
  return { t: t, sw: sw, hosts: hosts };
}

function cliOf(env, sim) {
  return new CliSession(env.sw, env.t, sim);
}

function twoPDs() {
  return lab({ budget: 25, cable: [{ port: '1/1/1', pd: 'a' }, { port: '1/1/2', pd: 'b' }] });
}

console.log('');
console.log('Nothing has run, and the command says so rather than measuring nothing:');
{
  const env = twoPDs();
  const out = cliOf(env, new Simulator(env.t)).run('show power inline').output.join('\n');
  ok(/Not measured \(no simulation run\)/.test(out), 'the answer is "not measured", not zeros', out);
  ok(!/0 W of/.test(out), 'and no total is invented', out);
}

console.log('');
console.log('A real allocation is reported port by port:');
{
  const env = lab({ budget: 25, disable: ['1/1/4'],
    cable: [{ port: '1/1/1', pd: 'a' }, { port: '1/1/2', pd: 'b' }, { port: '1/1/3', pd: 'pc', plain: true }] });
  const sim = new Simulator(env.t);
  const engine = sim.computePoe()[0];
  const out = cliOf(env, sim).run('show power inline').output;

  ok(out[0].indexOf('Interface') === 0 && /Admin/.test(out[0]) && /Powered device/.test(out[0]),
    'there is a table with a header', out[0]);
  // The devices are named PDA/PDB by the factory, so the row has to show that name - the point is that the
  // console names the powered device, not that it invents one.
  ok(out.some(function (l) { return /^1\/1\/1\s+up\s+on\s+12\.95 W\s+PDA/.test(l); }),
    'the powered port shows its device and its draw', JSON.stringify(out.slice(0, 3)));
  ok(out.some(function (l) { return /^1\/1\/2\s+up\s+off\s+12\.95 W\s+PDB\s+\(denied\)/.test(l); }),
    'the denied port is marked denied', JSON.stringify(out.slice(0, 3)));
  ok(out.some(function (l) { return /^1\/1\/3\s+up\s+off\s+-\s+the far end is not a powered device/.test(l); }),
    'a port cabled to something that is not a powered device says so', JSON.stringify(out));
  ok(out.some(function (l) { return /^1\/1\/4\s+down\s+off\s+-\s+administratively down/.test(l); }),
    'a shut-down port says why it supplies nothing', JSON.stringify(out));

  // The engine's own numbers, not a second copy of them.
  const total = out.filter(function (l) { return /^Total:/.test(l); })[0] || '';
  ok(total.indexOf(String(Math.round(engine.used * 100) / 100) + ' W of ' + engine.budget + ' W') !== -1,
    'the total is the engine\'s own figure', total + ' vs engine ' + JSON.stringify({ used: engine.used, budget: engine.budget }));
  const deniedCount = engine.ports.filter(function (p) { return !p.powered; }).length;
  ok(total.indexOf(deniedCount + ' port' + (deniedCount === 1 ? '' : 's') + ' denied') !== -1,
    'and the denial count', total);

  // One sentence, kept by the engine, used by the timeline and by this command.
  const event = (sim.events || []).filter(function (e) { return e.type === 'poe-deny'; })[0];
  const entry = (sim.poe[0].ports || []).filter(function (p) { return !p.powered; })[0];
  ok(event && entry && event.reason === entry.reason,
    'the denial reason on the entry is the one the timeline emitted',
    JSON.stringify({ event: event && event.reason, entry: entry && entry.reason }));
  ok(out.some(function (l) { return l.trim() === '1/1/2: ' + entry.reason; }),
    'and the console prints that exact sentence', JSON.stringify(out.filter(function (l) { return /1\/1\/2:/.test(l); })));
}

console.log('');
console.log('A wall of idle ports is summarised, not printed one per line:');
{
  const env = twoPDs();
  const sim = new Simulator(env.t);
  sim.computePoe();
  const out = cliOf(env, sim).run('show power inline').output;
  const idleRows = out.filter(function (l) { return /nothing plugged in/.test(l); });
  ok(idleRows.length === 1, 'idle ports appear once, as a summary', JSON.stringify(idleRows));
  ok(/^\d+ ports with nothing plugged in: /.test(idleRows[0]), 'naming how many and which', idleRows[0]);
  ok(/\(\+\d+ more\)/.test(idleRows[0]), 'with the tail counted rather than listed', idleRows[0]);
  // ...and any one of them can still be asked about by name.
  const one = cliOf(env, sim).run('show power inline 1/1/9').output;
  ok(one.some(function (l) { return /^1\/1\/9\s+up\s+off\s+-\s+nothing plugged in/.test(l); }),
    'and asked about individually', JSON.stringify(one));
  ok(!one.some(function (l) { return /^Total:/.test(l); }),
    'a question about one port gets no device-wide total', JSON.stringify(one));
}

console.log('');
console.log('What cannot be answered is refused by name, not guessed:');
{
  const env = twoPDs();
  const sim = new Simulator(env.t);
  sim.computePoe();
  const s = cliOf(env, sim);
  ok(/% No interface 9\/9\/9 on SW1/.test(s.run('show power inline 9/9/9').output.join('\n')),
    'an unknown port', s.run('show power inline 9/9/9').output.join('\n'));

  // A port that exists but is not a PSE port: the router's port, say.
  const t2 = new Topology();
  const r = t2.addDevice(spec('generic', 'generic-router') || catalog[0], 'r');
  const s2 = new CliSession(r, t2, new Simulator(t2));
  const noPoe = s2.run('show power inline').output.join('\n');
  ok(/No PoE on|No interface/.test(noPoe), 'a device with no PSE ports says so', noPoe);
}

console.log('');
console.log('A device with PSE ports but no budget reports the ports and claims no watts:');
{
  const env = lab({ budget: null, cable: [{ port: '1/1/1', pd: 'a' }] });
  const sim = new Simulator(env.t);
  sim.computePoe();
  const out = cliOf(env, sim).run('show power inline').output.join('\n');
  ok(/budget not modelled on SW1/.test(out), 'it says the budget is not modelled', out);
  ok(/not measured/.test(out), 'and marks the supply not measured', out);
  ok(!/Total:/.test(out), 'rather than reporting a total it never computed', out);
}

console.log('');
console.log('The console and the inspector agree, port by port:');
{
  // The panel is the other surface that shows PoE (test/poe-agreement.test.js pins it to the engine). If the
  // console disagreed with it, one of the three would be wrong and nobody would know which.
  function fakeNode() {
    const base = {
      innerHTML: '', textContent: '', value: '', style: {}, dataset: {},
      classList: { add: function () {}, remove: function () {}, toggle: function () {}, contains: function () { return false; } },
      addEventListener: function () {}, removeEventListener: function () {},
      appendChild: function () { return fakeNode(); }, append: function () {},
      setAttribute: function () {}, getAttribute: function () { return null; },
      removeAttribute: function () {}, remove: function () {}, focus: function () {}, click: function () {},
      querySelector: function () { return fakeNode(); }, querySelectorAll: function () { return []; },
      closest: function () { return null; }
    };
    return new Proxy(base, { get: function (t, k) { return k in t ? t[k] : function () { return fakeNode(); }; },
      set: function (t, k, v) { t[k] = v; return true; } });
  }
  const wrap = {
    _html: '', get innerHTML() { return this._html; }, set innerHTML(v) { this._html = v; },
    addEventListener: function () {}, style: {}, classList: { add: function () {}, remove: function () {}, toggle: function () {}, contains: function () { return false; } },
    querySelector: function () { return fakeNode(); }, querySelectorAll: function () { return []; },
    setAttribute: function () {}, getAttribute: function () { return null; }
  };
  const ctx = {
    console: console, setTimeout: setTimeout, clearTimeout: clearTimeout, setInterval: setInterval,
    fetch: function () { return Promise.resolve({ ok: true, json: function () { return Promise.resolve({}); } }); },
    document: { addEventListener: function () {}, querySelector: function () { return wrap; }, querySelectorAll: function () { return []; } },
    window: {},
    PFCanvas: { on: {}, setTopology: function () {}, fitView: function () {}, render: function () {}, setSelected: function () {}, setSelectedLink: function () {}, animateEvents: function () {}, zoomBy: function () {} }
  };
  ctx.window.PFCanvas = ctx.PFCanvas;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'web', 'app.js'), 'utf8'), ctx, { filename: 'web/app.js' });
  const pf = ctx.window.__pf || {};

  const cases = [
    { label: 'both fit', opts: { budget: 100, cable: [{ port: '1/1/1', pd: 'a' }, { port: '1/1/2', pd: 'b' }] } },
    { label: 'budget exhausted', opts: { budget: 25, cable: [{ port: '1/1/1', pd: 'a' }, { port: '1/1/2', pd: 'b' }] } },
    { label: 'one PSE port shut down', opts: { budget: 30, disable: ['1/1/1'], cable: [{ port: '1/1/1', pd: 'a' }] } }
  ];
  let bad = [];
  for (const c of cases) {
    const env = lab(c.opts);
    const sim = new Simulator(env.t);
    sim.computePoe();
    const out = cliOf(env, sim).run('show power inline').output.join('\n');

    const state = JSON.parse(JSON.stringify(env.t.serialize()));
    pf.setTopology(state);
    const panel = pf.poeSummary(state.devices.find(function (d) { return d.id === env.sw.id; }));

    // Every port the panel says is powered must say "on" in the console, and vice versa.
    for (const p of (panel.ports || [])) {
      const row = out.split('\n').filter(function (l) { return l.indexOf(p.name + ' ') === 0; })[0] || '';
      const cliOn = /\s+on\s+/.test(row);
      if (cliOn !== !!p.powered) bad.push(c.label + ' ' + p.name + ': panel ' + p.powered + ' console ' + cliOn);
    }
    const total = out.split('\n').filter(function (l) { return /^Total:/.test(l); })[0] || '';
    const shown = Number((/^Total: ([\d.]+) W/.exec(total) || [])[1]);
    if (Math.abs(shown - Math.round(panel.used * 100) / 100) > 0.01) {
      bad.push(c.label + ': console total ' + shown + ' vs panel ' + panel.used);
    }
  }
  ok(bad.length === 0, cases.length + ' allocations: console rows and totals match the panel', JSON.stringify(bad));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
