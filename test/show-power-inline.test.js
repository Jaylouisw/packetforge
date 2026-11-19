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
      const s = c.plain ? spec('asus', 'RT-AX86U Pro') : spec('mikrotik', 'RBSXTsqG-5acD');
      const d = t.addDevice(s);
      d.name = 'PD' + c.pd.toUpperCase();
      hosts[c.pd] = { dev: d, port: c.plain ? [...d.interfaces.values()][0].name : 'eth1' };
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

  ok(out[1].indexOf('Interface') === 0 && /Admin/.test(out[1]) && /Powered device/.test(out[1]),
    'there is a table with a header', out[1]);
  // The devices are named PDA/PDB by the factory, so the row has to show that name - the point is that the
  // console names the powered device, not that it invents one.
  ok(out.some(function (l) { return /^1\/1\/1\s+auto\s+on\s+12\.95 W\s+PDA/.test(l); }),
    'the powered port shows its device and its draw', JSON.stringify(out.slice(0, 3)));
  ok(out.some(function (l) { return /^1\/1\/2\s+auto\s+off\s+12\.95 W\s+PDB\s+\(denied\)/.test(l); }),
    'the denied port is marked denied', JSON.stringify(out.slice(0, 3)));
  ok(out.some(function (l) { return /^1\/1\/3\s+auto\s+off\s+-\s+the far end is not a powered device/.test(l); }),
    'a port cabled to something that is not a powered device says so', JSON.stringify(out));
  ok(out.some(function (l) { return /^1\/1\/4\s+auto\s+off\s+-\s+administratively down/.test(l); }),
    'a shut-down port says why it supplies nothing', JSON.stringify(out));

  // The box's summary line, above the table, carrying the engine's own numbers rather than a second copy.
  const summary = out[0] || '';
  const nums = /^Available:([\d.]+)\(w\) Used:([\d.]+)\(w\) Remaining:([\d.]+)\(w\)$/.exec(summary);
  ok(!!nums, 'the summary is the box\'s `Available:.../Used:.../Remaining:...` line, first', summary);
  ok(nums && Math.abs(Number(nums[1]) - engine.budget) < 0.06 && Math.abs(Number(nums[2]) - engine.used) < 0.06 &&
    Math.abs(Number(nums[3]) - (engine.budget - engine.used)) < 0.06,
    'with the engine\'s own budget, draw and remainder', summary + ' vs engine ' +
      JSON.stringify({ used: engine.used, budget: engine.budget }));
  ok(/^Interface\s+Admin\s+Oper/.test(out[1] || ''), 'and the port table follows it', out[1]);

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
console.log('The Admin column is the PoE administration mode, not the link state:');
{
  // The vendor's own field table names this column's three words - "Administration mode: auto, off, static" -
  // and `auto` is the factory default ("The default is auto (enabled)"). This view used to print `up`/`down`
  // here, which is the *link's* administrative state: every working port read `up`, a word the column never
  // carries, and a shut port read `down` as though its PoE mode had been configured. Both cases in one lab:
  const env = lab({ budget: 25, disable: ['1/1/4'], cable: [{ port: '1/1/1', pd: 'a' }] });
  const sim = new Simulator(env.t);
  sim.computePoe();
  const out = cliOf(env, sim).run('show power inline').output;
  const row = function (name) {
    return out.filter(function (l) { return l.indexOf(name + ' ') === 0; })[0] || '';
  };
  ok(/^1\/1\/1\s+auto\s+on\s/.test(row('1/1/1')), 'a port supplying power is `auto`', row('1/1/1'));
  ok(/^1\/1\/4\s+auto\s+off\s/.test(row('1/1/4')),
    'and a shut port is `auto` too: shutting the link does not configure the PoE mode', row('1/1/4'));
  ok(/administratively down/.test(row('1/1/4')),
    'the shutdown is said where it belongs, in the reason column', row('1/1/4'));
  const modes = out.filter(function (l) { return /^1\//.test(l); }).map(function (l) { return l.split(/\s+/)[1]; });
  ok(modes.length > 1 && modes.every(function (w) { return w === 'auto'; }),
    'every PSE row carries a PoE mode word, never `up` or `down`', JSON.stringify(modes));
}

console.log('');
console.log('Shutting a PoE port stops the power it was supplying; the mode is untouched:');
{
  // The vendor's own worked example pins both halves at once. Catalyst 3850, IOS XE 16.9,
  // `show power inline police` (Interface and Hardware Commands, "show power inline"):
  //
  //   Gi1/0/1   auto   off         none       n/a        n/a    0.0
  //   Gi1/0/4   off    off         none       n/a        n/a    0.0
  //
  // and the note under it says "The Gi1/0/1 port is shut down, and policing is not configured" while
  // "Device detection is disabled on the Gi1/0/4 port". So shutting a port that was powering a device
  // removes the power - Oper `off`, nothing allocated - and leaves `Admin` at the configured mode,
  // `auto`. `off` is `power inline never`, a different command.
  //   https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst3850/software/release/16-9/command_reference/b_169_3850_cr/interface_and_hardware_commands.html
  //
  // This lab has a powered device cabled to a port that is then shut, which is the case the engine's
  // allocation walk has to get right: the port is not in `activeInterfaces()`, so it must drop out of
  // the allocation rather than keep drawing a budget it can no longer use.
  const env = lab({ budget: 370, disable: ['1/1/1'], cable: [{ port: '1/1/1', pd: 'a' }] });
  const sim = new Simulator(env.t);
  const engine = sim.computePoe()[0];
  const out = cliOf(env, sim).run('show power inline').output;
  const row = out.filter(function (l) { return l.indexOf('1/1/1 ') === 0; })[0] || '';
  ok(/^1\/1\/1\s+auto\s+off\s+-\s+administratively down/.test(row),
    'a shut port with a powered device cabled to it reads `auto / off`, draws nothing, and says why', row);
  const stillAllocated = (engine.ports || []).some(function (p) { return p.iface === '1/1/1'; });
  ok(engine.used === 0 && !stillAllocated,
    'and the engine allocates no watts to it: the shut port supplies nothing',
    JSON.stringify({ used: engine.used, ports: engine.ports }));
  const summary = out.filter(function (l) { return /^Available:/.test(l); })[0] || '';
  ok(/^Available:370\.0\(w\) Used:0\.0\(w\) Remaining:370\.0\(w\)$/.test(summary),
    'so the device summary is the budget it has, not power nobody is drawing', summary);
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
  ok(one.some(function (l) { return /^1\/1\/9\s+auto\s+off\s+-\s+nothing plugged in/.test(l); }),
    'and asked about individually', JSON.stringify(one));
  ok(!one.some(function (l) { return /^Available:/.test(l); }),
    'a question about one port gets no device-wide summary', JSON.stringify(one));
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
  ok(!/^Available:/m.test(out), 'rather than reporting a summary it never computed', out);
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
    const summary = out.split('\n').filter(function (l) { return /^Available:/.test(l); })[0] || '';
    const shown = Number((/Used:([\d.]+)\(w\)/.exec(summary) || [])[1]);
    if (Math.abs(shown - Math.round(panel.used * 10) / 10) > 0.05) {
      bad.push(c.label + ': console used ' + shown + ' vs panel ' + panel.used);
    }
  }
  ok(bad.length === 0, cases.length + ' allocations: console rows and totals match the panel', JSON.stringify(bad));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
