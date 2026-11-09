'use strict';
// One rule, two implementations - so make them prove they agree.
//
// The fabric audit exists twice: `engine/fabric.js` computes it for the catalogue, and
// `web/app.js` computes it again for the inspector, because the browser cannot require the engine.
// Two implementations of one rule is a defect waiting to happen: change the exclusion rule in one
// place and the panel starts disagreeing with the audit, quietly, on hardware nobody re-checks.
//
// So this file compares them across every device in the catalogue. It also pins the newest way the
// rule could be wrong: an exclusion glob that matches no port.
//
// `excludes: ["line*"]` on a shelf whose ports are `L1..L12` excludes nothing. The audit then counts
// both ends of every connection and reports a figure that is wrong in the direction of sounding
// impressive - 6x oversubscribed instead of 3x - while every part of the pipeline sees valid JSON,
// valid ports and a number that renders.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const fabric = require('../engine/fabric');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; }
  else { failed++; console.log('  not ok - ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

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
  return new Proxy(base, { get: function (t, k) { return k in t ? t[k] : function () { return fakeNode(); }; }, set: function (t, k, v) { t[k] = v; return true; } });
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

const specs = loadCatalog(path.join(__dirname, '..', 'devices'));

console.log('');
console.log('The engine and the inspector agree about every device:');
{
  ok(typeof pf.fabricSummary === 'function', 'the inspector implementation is available');
  const withFabric = specs.filter(function (s) { return s.fabric; });
  ok(withFabric.length >= 5, 'there are devices to compare (' + withFabric.length + ')');

  const disagreements = [];
  for (const s of withFabric) {
    const engine = fabric.auditFabric(s);
    const ui = pf.fabricSummary(s);
    if (!engine || !ui) { disagreements.push(s.model + ': one side returned nothing'); continue; }
    if (engine.capacityMbps !== ui.capacityMbps) disagreements.push(s.model + ': capacity ' + engine.capacityMbps + ' vs ' + ui.capacityMbps);
    if (engine.offeredMbps !== ui.offeredMbps) disagreements.push(s.model + ': offered ' + engine.offeredMbps + ' vs ' + ui.offeredMbps);
    if (engine.exceeds !== ui.exceeds) disagreements.push(s.model + ': exceeds ' + engine.exceeds + ' vs ' + ui.exceeds);
    if (Math.abs(engine.ratio - ui.ratio) > 1e-9) disagreements.push(s.model + ': ratio ' + engine.ratio + ' vs ' + ui.ratio);
  }
  ok(disagreements.length === 0, 'same capacity, same offered figure, same verdict, same ratio', disagreements.slice(0, 3).join(' | '));

  const e6608 = specs.filter(function (s) { return /OptiXtrans E6608/.test(s.model || ''); })[0];
  ok(fabric.auditFabric(e6608).ratio === 3, 'the E6608 is 3x on both sides of the wire', String(fabric.auditFabric(e6608).ratio));
  ok(/3\.0\u00d7 oversubscribed/.test(pf.fabricSummary(e6608).text), 'and the panel says so in words', pf.fabricSummary(e6608).text);
}

console.log('');
console.log('An exclusion that matches nothing is caught, not silently obeyed:');
{
  const wrongGlob = {
    vendor: 'acme', model: 'glitch', category: 'switch',
    interfaces: [
      { name: 'L1', type: 'ethernet', speed: '200G' },
      { name: 'L2', type: 'ethernet', speed: '200G' }
    ],
    fabric: { capacityMbps: 800000, excludes: ['line*'] }
  };
  const problems = fabric.validateFabric(wrongGlob);
  ok(problems.length === 1, 'exactly one problem is reported', problems.join(' | '));
  ok(/matches no port/.test(problems[0] || ''), 'and it says the glob matches nothing', problems[0]);
  // The damage it would have done, stated as a number: the audit counts both ends.
  ok(fabric.auditFabric(wrongGlob).offeredMbps === 400000, 'without the exclusion both ports count (400 Gbit/s)');

  const excludesAll = {
    vendor: 'acme', model: 'everything', category: 'switch',
    interfaces: [{ name: 'line1', type: 'ethernet', speed: '200G' }],
    fabric: { capacityMbps: 800000, excludes: ['line*'] }
  };
  ok(/excludes every data port/.test(fabric.validateFabric(excludesAll).join(' ')), 'a glob that excludes every data port is refused too',
     fabric.validateFabric(excludesAll).join(' | '));

  const noPorts = { vendor: 'acme', model: 'template', portTemplate: { prefix: 'eth', count: 8, speed: '1G' }, fabric: { capacityMbps: 10000, excludes: ['eth*'] } };
  ok(/no explicit interfaces/.test(fabric.validateFabric(noPorts).join(' ')), 'and a template device cannot be excluded from, because there is nothing to name yet',
     fabric.validateFabric(noPorts).join(' | '));

  const every = fabric.excludedGlobProblems(wrongGlob);
  ok(every.length === 1, 'the helper is exported for callers that want only this check', String(every.length));
}

console.log('');
console.log('The shipped catalogue passes the new check:');
{
  const broken = [];
  for (const s of specs) {
    const problems = fabric.validateFabric(s);
    if (problems.length) broken.push(s.vendor + '/' + s.model + ': ' + problems[0]);
  }
  ok(broken.length === 0, 'no device has a fabric that cannot be described', broken.slice(0, 3).join(' | '));
  const excluding = specs.filter(function (s) { return s.fabric && (s.fabric.excludes || []).length; });
  ok(excluding.length >= 2, 'the devices that exclude a side still do (' + excluding.length + ')');
  for (const s of excluding) {
    ok(fabric.excludedGlobProblems(s).length === 0, s.model + ': its exclusions are real', fabric.excludedGlobProblems(s).join(' | '));
  }
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exitCode = 1;
