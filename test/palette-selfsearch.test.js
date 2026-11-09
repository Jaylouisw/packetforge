'use strict';
// Every device must find itself.
//
// The palette's search has been fixed three times, each time for a case somebody
// reported: "MC220L" missed the MC220L, "ont" buried the ONTs, "modem" returned
// routers. All three were found by a person typing a name into the box and getting
// the wrong answer, which means the failures were discovered by users, not by us.
//
// This is the cheap invariant that turns that around: for every spec in the
// catalogue, searching its own model name - with its own vendor facet selected, the
// way a person narrows - must return that device first. No network, no DOM events,
// no knowledge of which vendors are in the catalogue today.
//
// Two real bugs this shape catches that a hand-written test does not: a model name
// that normalises to the same key as another device from the same vendor (they will
// shadow each other, and only one is ever reachable), and a model that ranks below
// some other device when searched for by its exact name.
//
// Loads the real web/app.js in the stub DOM the other UI tests use.
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
    innerHTML: '', textContent: '', value: '', checked: false,
    style: {}, dataset: {},
    classList: { add: function () {}, remove: function () {}, toggle: function () {}, contains: function () { return false; } },
    addEventListener: function () {}, removeEventListener: function () {},
    appendChild: function () { return fakeNode(); }, append: function () {},
    setAttribute: function () {}, getAttribute: function () { return null; },
    removeAttribute: function () {}, remove: function () {}, focus: function () {}, click: function () {},
    querySelector: function () { return fakeNode(); }, querySelectorAll: function () { return []; },
    closest: function () { return null; }, parentElement: null, children: []
  };
  return new Proxy(base, {
    get: function (t, k) { if (k in t) return t[k]; return function () { return fakeNode(); }; },
    set: function (t, k, v) { t[k] = v; return true; }
  });
}
function makeWrap() {
  return {
    _html: '',
    get innerHTML() { return this._html; },
    set innerHTML(v) { this._html = v; },
    addEventListener: function () {}, removeEventListener: function () {},
    style: {}, classList: { add: function () {}, remove: function () {}, toggle: function () {}, contains: function () { return false; } },
    querySelector: function () { return fakeNode(); },
    querySelectorAll: function () { return []; },
    setAttribute: function () {}, getAttribute: function () { return null; }
  };
}
const mainWrap = makeWrap();
const ctx = {
  console: console,
  setTimeout: setTimeout, clearTimeout: clearTimeout, setInterval: setInterval,
  fetch: function () { return Promise.resolve({ ok: true, json: function () { return Promise.resolve({}); } }); },
  document: {
    addEventListener: function () {},
    querySelector: function () { return mainWrap; },
    querySelectorAll: function () { return []; }
  },
  window: {},
  PFCanvas: {
    on: {}, setTopology: function () {}, fitView: function () {}, render: function () {},
    setSelected: function () {}, setSelectedLink: function () {},
    animateEvents: function () {}, zoomBy: function () {}
  }
};
ctx.window.PFCanvas = ctx.PFCanvas;
vm.createContext(ctx);
const appSrc = fs.readFileSync(path.join(__dirname, '..', 'web', 'app.js'), 'utf8');
vm.runInContext(appSrc, ctx, { filename: 'web/app.js' });
const pf = ctx.window.__pf || {};
const filterDevices = pf.filterDevices;

console.log('');
console.log('The harness sees the real filter:');
ok(typeof filterDevices === 'function', 'window.__pf.filterDevices is exported');
// Without this the shadowing check below would compare `null` to `null` and pass for
// every device, which is a green light over nothing.
ok(typeof pf.searchKey === 'function', 'window.__pf.searchKey is exported, so the shadowing check is real');

const specs = loadCatalog(path.join(__dirname, '..', 'devices'));
console.log('');
console.log('Every device finds itself (' + specs.length + ' specs):');

const notFirst = [];
const shadowed = [];
for (const s of specs) {
  if (!s || !s.model || s.error) continue;
  const hits = filterDevices(s.model, specs, { vendor: s.vendor });
  const first = hits[0];
  if (!first || first.model !== s.model) {
    notFirst.push({ model: s.model, vendor: s.vendor, got: first ? first.vendor + '/' + first.model : '(nothing)' });
  }
  // Same vendor, same normalised name: two devices that cannot both be reached by
  // typing one of their names.
  const key = pf.searchKey ? pf.searchKey(s.model) : null;
  if (key) {
    const twins = specs.filter(function (o) {
      return o && o.model && !o.error && o.vendor === s.vendor && pf.searchKey(o.model) === key;
    });
    if (twins.length > 1 && twins[0].model === s.model) {
      shadowed.push({ vendor: s.vendor, models: twins.map(function (t) { return t.model; }) });
    }
  }
}

ok(notFirst.length === 0, 'searching a model name returns that model first',
  notFirst.length + ' miss(es): ' + notFirst.slice(0, 8).map(function (x) {
    return x.vendor + '/' + x.model + ' -> ' + x.got;
  }).join(' ; '));
ok(shadowed.length === 0, 'no two devices from one vendor share a search key',
  shadowed.slice(0, 5).map(function (x) { return x.vendor + ': ' + x.models.join(' / '); }).join(' ; '));

console.log('');
console.log('A vendor-qualified phrase still lands, for a sample across the catalogue:');
const step = Math.max(1, Math.floor(specs.length / 60));
const misses = [];
for (let i = 0; i < specs.length; i += step) {
  const s = specs[i];
  if (!s || !s.model || s.error) continue;
  const hits = filterDevices(s.vendor + ' ' + s.model, specs, {});
  if (!hits.some(function (h) { return h.model === s.model && h.vendor === s.vendor; })) {
    misses.push(s.vendor + '/' + s.model);
  }
}
ok(misses.length === 0, 'vendor + model finds the device with no facet selected',
  misses.slice(0, 6).join(' ; '));

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exitCode = 1;
