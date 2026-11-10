'use strict';
// The palette's search keys, computed once per spec instead of once per keystroke.
//
// Typing in the palette used to rebuild every spec's searchable form on every keystroke: six
// lower-case-and-strip passes over vendor, model, label, description, category and each alias, for
// all 2,015 specs. Measured at ~10 ms per keystroke, which is a tenth of a frame at 100 Hz spent
// re-deriving strings that cannot have changed - the catalogue is immutable for the life of the page.
//
// Caching them is only safe if it is invisible, so that is what this file checks: the results are
// identical to a cold run, a replaced spec object gets fresh keys (a reload really does reload), and
// the cache cannot grow without bound because it is keyed on the spec objects themselves.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
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
console.log('The keys are cached by identity, and by nothing else:');
{
  ok(typeof pf.specKeys === 'function', 'specKeys is exported for testing');
  const s = { vendor: 'Acme', model: 'XR-1', label: 'XR 1', category: 'switch', aliases: ['XR1'], description: 'a box' };
  const a = pf.specKeys(s);
  const b = pf.specKeys(s);
  ok(a === b, 'the same spec object returns the same cached object');
  const c = pf.specKeys({ vendor: 'Acme', model: 'XR-1', label: 'XR 1', category: 'switch', aliases: ['XR1'], description: 'a box' });
  ok(c !== a, 'a different object gets its own entry, even with identical content');
  ok(JSON.stringify(c) === JSON.stringify(a), 'and the same keys');
  ok(a.model === 'xr1', 'the model key is lower-cased and stripped', a.model);
  ok(a.vm === 'acmexr1', 'the vendor+model key is what lets a spaced query land', a.vm);
  ok(Array.isArray(a.aliases) && a.aliases[0] === 'xr1', 'aliases are keyed too');
  ok(a.hay.indexOf('xr1') !== -1, 'and the multi-token haystack contains them');
}

console.log('');
console.log('Empty aliases never reach the loop:');
{
  const k = pf.specKeys({ vendor: 'a', model: 'b', aliases: ['', null, '  ', 'real'] });
  ok(k.aliases.length === 1 && k.aliases[0] === 'real', 'blank aliases are dropped once, not scanned on every keystroke', JSON.stringify(k.aliases));
  const none = pf.specKeys({ vendor: 'a', model: 'b' });
  ok(Array.isArray(none.aliases) && none.aliases.length === 0, 'a spec with no aliases gets an empty array, not undefined');
}

console.log('');
console.log('Cached and uncached results are the same results:');
{
  const QUERIES = ['c', 'cr', 'crs', 'crs326', 'mikrotik crs', '10g switch', 'ubiquiti', 'B1LDCD', 'e6616', 'M1D-B', 'zzzz'];
  const warm = QUERIES.map(function (q) { return pf.filterDevices(q, specs, {}).map(function (s) { return s.model; }); });
  const again = QUERIES.map(function (q) { return pf.filterDevices(q, specs, {}).map(function (s) { return s.model; }); });
  let mismatches = 0;
  for (let i = 0; i < QUERIES.length; i++) {
    if (JSON.stringify(warm[i]) !== JSON.stringify(again[i])) {
      mismatches++;
      console.log('    ' + QUERIES[i] + ': ' + warm[i].slice(0, 3).join(',') + ' vs ' + again[i].slice(0, 3).join(','));
    }
  }
  ok(mismatches === 0, 'a cache hit cannot change the ranking', String(mismatches));
  ok(warm[3].length > 0 && warm[3][0].indexOf('CRS326') === 0, 'and CRS326 still lands its own model first', warm[3][0]);
  ok(warm[7].length === 2, 'the B1LDCD alias still finds both shelves', String(warm[7].length));
  ok(warm[10].length === 0, 'a query that matches nothing still matches nothing');
}

console.log('');
console.log('A reloaded catalogue is not stale:');
{
  // The palette reloads by replacing the catalogue objects. If the cache were keyed on the model
  // string instead of the object, a corrected spec would keep its old keys - and the bug would look
  // like "the search is wrong" months later.
  const before = [{ vendor: 'acme', model: 'Old', category: 'switch' }];
  ok(pf.filterDevices('old', before, {}).length === 1, 'the old object is found by its own name');
  const after = [{ vendor: 'acme', model: 'New', category: 'switch' }];
  ok(pf.filterDevices('new', after, {}).length === 1, 'the replacement object is found by its own name');
  ok(pf.filterDevices('old', after, {}).length === 0, 'and the name it no longer has is not found');
}

console.log('');
console.log('The whole catalogue still filters in a keystroke-shaped budget:');
{
  // Wall-clock is the wrong unit for a shared runner: two CI jobs on one host, and a warm filter
  // that measures 0.4 ms on an idle machine measures 8 ms behind a Docker build - which is how this
  // suite went red on commits whose neighbours were green. So the assertion is a RATIO between the
  // same work done twice in the same process under the same load, and the absolute ceiling is only a
  // catastrophe guard (an O(n^2) haystack, or a cache that never hits), set wide enough that load
  // alone cannot trip it.
  const perCall = function (fn, n) {
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < n; i++) fn(i);
    return Number(process.hrtime.bigint() - t0) / 1e6 / n;
  };
  pf.filterDevices('crs3', specs, {});
  const warm = perCall(function () { pf.filterDevices('crs3', specs, {}); }, 50);
  // A fresh copy every iteration: object identity changes, so every one of these is a cache miss and
  // the keys are rebuilt exactly as they were before the cache existed.
  const cold = perCall(function () {
    const fresh = specs.map(function (s) { return Object.assign({}, s); });
    pf.filterDevices('crs3', fresh, {});
  }, 20);

  console.log('    warm ' + warm.toFixed(2) + ' ms/filter, cold ' + cold.toFixed(2) + ' ms/filter over ' +
    specs.length + ' specs');
  ok(warm < cold * 0.75,
    'a warm filter is faster than a cold one (' + warm.toFixed(2) + ' ms vs ' + cold.toFixed(2) + ' ms, ' +
    (cold / Math.max(warm, 0.001)).toFixed(1) + 'x)');
  ok(warm < 25,
    'and stays inside a catastrophic-regression ceiling of 25 ms (' + warm.toFixed(2) + ' ms)');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exitCode = 1;
