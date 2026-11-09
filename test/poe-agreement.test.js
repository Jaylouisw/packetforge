'use strict';
// The PoE panel must not power devices the engine is not powering (#1293).
//
// `poeSummary()` in web/app.js is a second implementation of `Simulator.computePoe()`, because the browser
// cannot require the engine. `test/ui-render.test.js` compared the two on one lab - two powered devices and a
// tight budget - and that was enough to miss this:
//
//   engine:  { budget: 30, used: 0,     ports: [] }
//   panel:   { budget: 30, used: 12.95, ports: ['1/1/1/true'] }
//
// The engine walks `activeInterfaces()`, so a shut-down PSE port serves no power. The panel walked every port,
// so a shut-down port was reported as powering a powered device - the panel inventing 12.95 W nobody was
// drawing, on a port the operator had deliberately turned off.
//
// So: one comparison is not agreement. This file compares the two across the cases a PSE actually meets -
// budget exhaustion, a shut-down port, a peer that is not a powered device, an unplugged port, and a sweep of
// budgets - and compares the per-port outcome, not just the totals.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { Topology, Simulator } = require('../engine');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

// --- load the browser module the way the page does -----------------------------------------------------
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

const catalog = loadCatalog(path.join(__dirname, '..', 'devices')).filter(function (s) { return !s.error; });
function spec(vendor, model) {
  const s = catalog.find(function (x) { return x.vendor === vendor && x.model === model; });
  if (!s) throw new Error('missing spec ' + vendor + ' ' + model);
  return s;
}

function firstPort(dev) {
  return [...dev.interfaces.values()].filter(function (i) { return i.type === 'ethernet'; })[0].name;
}

// A PSE with cabling decided by the caller, so each case is one line of setup.
function lab(opts) {
  opts = opts || {};
  const t = new Topology();
  const sw = t.addDevice(spec('aruba', 'CX 6000 24G CL4 PoE 4SFP 370W'));
  sw.name = 'SW';
  const cable = opts.cable || [{ port: '1/1/1', pd: 'a' }, { port: '1/1/2', pd: 'b' }];
  const hosts = {};
  for (const c of cable) {
    if (!hosts[c.pd]) {
      // A host with no `poeIn` on its port is a plain device, not a powered one.
      const s = c.plain ? spec('asus', 'RT-AX86U Pro') : spec('ubiquiti', 'UCG-Ultra');
      const d = t.addDevice(s);
      d.name = c.pd.toUpperCase();
      hosts[c.pd] = { dev: d, port: (c.plain ? firstPort(d) : 'port1') };
    }
    t.connect(hosts[c.pd].dev.id, hosts[c.pd].port, sw.id, c.port);
  }
  sw.poeBudget = opts.budget === undefined ? 370 : opts.budget;
  for (const name of opts.disable || []) {
    const iface = sw.interfaces.get(name);
    if (iface) iface.enabled = false;
  }
  return { t: t, sw: sw, hosts: hosts };
}

// The engine's answer, and the panel's, in one comparable shape.
function both(env) {
  const sim = new Simulator(env.t);
  const engine = sim.computePoe().filter(function (p) { return p.dev === env.sw.id || p.deviceId === env.sw.id; })[0];
  const state = JSON.parse(JSON.stringify(env.t.serialize()));
  pf.setTopology(state);
  const uiDevice = state.devices.find(function (d) { return d.id === env.sw.id; });
  const panel = pf.poeSummary(uiDevice);
  function shape(engineResult) {
    const ports = (engineResult.ports || []).map(function (p) {
      return (p.iface || p.name) + '=' + (p.powered ? 'on' : 'off');
    }).sort();
    return {
      budget: Number(engineResult.budget) || 0,
      used: Math.round((Number(engineResult.used) || 0) * 1000) / 1000,
      denied: ports.filter(function (p) { return /=off$/.test(p); }).length,
      ports: ports.join(' ')
    };
  }
  const panelEngineShape = panel ? {
    budget: panel.budget, used: Math.round(panel.used * 1000) / 1000,
    denied: panel.denied,
    ports: (panel.ports || []).map(function (p) { return p.name + '=' + (p.powered ? 'on' : 'off'); }).sort().join(' ')
  } : null;
  return { engine: engine ? shape(engine) : null, panel: panelEngineShape, raw: panel, state: state };
}

// With no budget the engine emits no entry at all (computePoe skips a device with no PSE budget), and the only
// agreement available is that the panel claims nothing either: it must say the budget is not modelled rather
// than report 0 W in use as a measurement.
function agreeOne(env) {
  const a = both(env);
  if (!a.engine) {
    const claimsNothing = !a.panel || (a.panel.used === 0 && a.panel.ports === '' &&
      a.raw && a.raw.unknown === true);
    return { same: !!claimsNothing, detail: 'engine has no entry; panel=' + JSON.stringify(a.raw && {
      budget: a.raw.budget, used: a.raw.used, unknown: a.raw.unknown
    }) };
  }
  return {
    same: !!a.panel && JSON.stringify(a.engine) === JSON.stringify(a.panel),
    detail: 'engine=' + JSON.stringify(a.engine) + ' panel=' + JSON.stringify(a.panel)
  };
}

function agree(label, env) {
  const r = agreeOne(env);
  ok(r.same, label, r.same ? '' : r.detail);
  return both(env);
}

console.log('');
console.log('A shut-down PSE port powers nothing, in either implementation:');
{
  // The regression this file exists for.
  const env = lab({ budget: 30, disable: ['1/1/1'], cable: [{ port: '1/1/1', pd: 'a' }] });
  const a = both(env);
  ok(a.engine.used === 0, 'the engine draws nothing through a shut-down port', JSON.stringify(a.engine));
  ok(a.engine.ports === '1/1/1=off' || a.engine.ports === '',
    'and either omits the port from its table or marks it unpowered', a.engine.ports);
  const shown = a.state.devices.find(function (d) { return d.id === env.sw.id; }).interfaces
    .filter(function (i) { return i.poeOut; }).length;
  ok(shown >= 1, 'the panel still counts the port as PSE hardware (' + shown + ' of them)');
}

console.log('');
console.log('Every case a PSE actually meets, compared port by port:');
{
  agree('both powered devices fit the budget',
    lab({ budget: 100 }));
  agree('the budget cannot fit both',
    lab({ budget: 25 }));
  agree('one PSE port shut down, budget fine',
    lab({ budget: 100, disable: ['1/1/1'] }));
  agree('one PSE port shut down, budget tight',
    lab({ budget: 20, disable: ['1/1/1'] }));
  agree('both PSE ports shut down',
    lab({ budget: 100, disable: ['1/1/1', '1/1/2'] }));
  agree('the peer is not a powered device',
    lab({ budget: 100, cable: [{ port: '1/1/1', pd: 'a' }, { port: '1/1/2', pd: 'pc', plain: true }] }));
  agree('a PSE port with nothing plugged in',
    lab({ budget: 100, cable: [{ port: '1/1/1', pd: 'a' }] }));
  agree('no budget configured at all (the panel says "not modelled")',
    lab({ budget: 0 }));
}

console.log('');
console.log('A sweep of budgets, so no threshold is left to chance:');
{
  const budgets = [0, 5, 12, 12.95, 13, 20, 25.9, 26, 30, 51.8, 100, 370];
  let bad = [];
  for (const budget of budgets) {
    const env = lab({ budget: budget });
    const a = both(env);
    const r = agreeOne(env);
    if (!r.same) bad.push(budget + ': ' + r.detail);
    // A budget that is not exceeded is a decoration: neither surface may report more drawn than it has.
    if (a.engine && a.engine.used > budget + 1e-9) bad.push(budget + ': engine drew ' + a.engine.used);
    if (a.panel && a.panel.used > budget + 1e-9) bad.push(budget + ': panel drew ' + a.panel.used);
  }
  ok(bad.length === 0, budgets.length + ' budgets agree, and neither implementation draws more than it has',
    JSON.stringify(bad.slice(0, 3)));
}

console.log('');
console.log('And the inspector says what the numbers are:');
{
  // The panel's HTML is the only place an operator sees PoE, so the sentence has to match the accounting.
  const env = lab({ budget: 30, disable: ['1/1/1'], cable: [{ port: '1/1/1', pd: 'a' }] });
  const a = both(env);
  pf.selectDevice(env.sw.id);
  pf.renderDeviceTab();
  const html = ctx.document.querySelector('#device-tab') ? wrap.innerHTML : wrap.innerHTML;
  ok(/PoE budget/.test(html), 'the panel states the budget');
  const used = /PoE in use<\/span><span[^>]*>([\d.]+) W/.exec(html);
  ok(!!used, 'and the power in use', used ? '' : html.slice(0, 200));
  ok(used && Number(used[1]) === 0,
    'as zero, because the only PSE port is shut down', used && used[1]);
  ok(!/DENIED/.test(html), 'with nothing denied, because nothing was asked for', 'DENIED present');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
