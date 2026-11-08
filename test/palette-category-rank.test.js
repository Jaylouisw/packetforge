'use strict';
// Searching a category name buried the category.
//
// "ont" is the project's own word for fibre CPE. It is also a substring of
// "Controller" - so typing the name of a device class returned 150 devices led by an
// Aruba 7210 Mobility Controller and an ExtremeCloud IQ Controller, with every actual
// ONT behind them. The ranking put any model substring at rank 2 and the category at
// rank 4, which means an accident of spelling beat a deliberate name.
//
// Same shape for "modem": the first hits were FRITZ!Box *routers* whose descriptions
// mention modems, while the DOCSIS modems sat below them.
//
// The fix adds a word tier: a query that appears as a whole word in the device's
// category outranks a query that merely occurs inside some model string. Substring
// matching is still how "mc220l" finds MC220L; it just no longer outranks a category.
// Nothing fuzzy was added, and word boundaries are compared on the raw string, so
// "on-t" still folds to the same query as "ont".
//
// This loads the real web/app.js in the stub DOM the other UI tests use.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg); }
}
function section(name) { console.log('\n' + name); }

function fakeNode() {
  const base = {
    innerHTML: '', textContent: '', value: '', checked: false, style: {}, dataset: {},
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
const mainWrap = {
  _html: '', get innerHTML() { return this._html; }, set innerHTML(v) { this._html = v; },
  addEventListener: function () {}, removeEventListener: function () {},
  style: {}, classList: { add: function () {}, remove: function () {}, toggle: function () {}, contains: function () { return false; } },
  querySelector: function () { return fakeNode(); }, querySelectorAll: function () { return []; },
  setAttribute: function () {}, getAttribute: function () { return null; }
};
const ctx = {
  console: console, setTimeout: setTimeout, clearTimeout: clearTimeout, setInterval: setInterval,
  fetch: function () { return Promise.resolve({ ok: true, json: function () { return Promise.resolve({}); } }); },
  document: { addEventListener: function () {}, querySelector: function () { return mainWrap; }, querySelectorAll: function () { return []; } },
  window: {},
  PFCanvas: { on: {}, setTopology: function () {}, fitView: function () {}, render: function () {},
    setSelected: function () {}, setSelectedLink: function () {}, animateEvents: function () {}, zoomBy: function () {} }
};
ctx.window.PFCanvas = ctx.PFCanvas;
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'web', 'app.js'), 'utf8'), ctx, { filename: 'app.js' });
const pf = ctx.window.__pf;
ok(!!pf && typeof pf.filterDevices === 'function', 'app.js loads and exposes filterDevices');

const filter = pf.filterDevices;
function ids(list) { return list.map(function (s) { return s.vendor + '/' + s.model; }); }

section('1. A category word beats an accidental substring (synthetic)');
{
  // The exact shape of the bug: a device whose model or label happens to contain "ont"
  // versus devices whose category *is* ont.
  const synth = [
    { vendor: 'aruba', model: '7210', label: 'Aruba 7210 Mobility Controller', description: '', category: 'host' },
    { vendor: 'extreme', model: 'E1120', label: 'ExtremeCloud IQ Controller', description: '', category: 'host' },
    { vendor: 'adtran', model: '411', label: 'ADTRAN 411 Micro ONT', description: '', category: 'ont' },
    { vendor: 'huawei', model: 'HG8010H', label: 'Huawei HG8010H GPON ONT', description: '', category: 'ont' },
    { vendor: 'generic', model: 'MONITOR-1', label: 'Rack monitor', description: 'a controller-adjacent box', category: 'monitor' }
  ];
  const res = filter('ont', synth);
  ok(res.length === 5, 'every device that contains "ont" somewhere is still returned (' +
    ids(res).join(', ') + ')');
  ok(res[0].category === 'ont' && res[1].category === 'ont',
    'but the two ONT devices rank first');
  // The controllers are not excluded - "Controller" really does contain "ont", and
  // substring matching is how this palette finds SKUs. What changed is the order: an
  // accidental substring now sits below a deliberate category name.
  ok(res.indexOf(synth[0]) > 1 && res.indexOf(synth[1]) > 1,
    'and both "Controller" devices rank below every ONT');
  ok(ids(filter('controller', synth)).length === 3,
    'searching "controller" still finds the controllers and the monitor that mentions one');
}

section('2. Word boundaries, not substrings, decide the category tier (synthetic)');
{
  // "monitor" contains "oni" but not the word "ont"; the tier must not fire on
  // an arbitrary substring of a category name.
  const synth = [
    { vendor: 'x', model: 'A1', label: 'Monitor', description: '', category: 'monitor' },
    { vendor: 'y', model: 'B2', label: 'An ONT', description: '', category: 'ont' }
  ];
  const res = filter('ont', synth);
  ok(res[0] === synth[1], '"ont" ranks the ont category above a category that merely contains "moni"');
  // And the folded forms must behave the same, because punctuation is stripped first.
  for (const raw of ['ONT', 'OnT', 'on-t', 'on t', ' ont ']) {
    const r = filter(raw, synth);
    ok(r.length && r[0] === synth[1], 'query ' + JSON.stringify(raw) + ' folds to the same ranking');
  }
}

section('3. Model prefix still outranks the category word');
{
  // The tiers are ordered deliberately: an exact model, then a model prefix, then a
  // category word. A device whose model literally starts with the query is what the
  // user typed, so it stays first even when another device's category matches.
  const synth = [
    { vendor: 'netgear', model: 'Switch 8', label: 'Switch 8', description: '', category: 'switch' },
    { vendor: 'acme', model: 'X100', label: 'X100', description: '', category: 'switch' }
  ];
  const res = filter('switch', synth);
  ok(res[0] === synth[0], 'a model starting with the query stays first');
  ok(res[1] === synth[1], 'and the other member of the category follows');
}

section('4. The real catalogue leads with the category');
{
  const specs = loadCatalog(path.join(__dirname, '..', 'devices'));
  ok(specs.length > 1000, 'catalogue loaded: ' + specs.length + ' specs');
  // Every one of these is a category the project uses. Before the fix, "ont" and
  // "modem" did not lead with their own category.
  const cats = ['ont', 'olt', 'modem', 'splitter', 'router', 'nas', 'ptp', 'printer'];
  for (const c of cats) {
    const res = filter(c, specs);
    ok(res.length > 0, 'query ' + JSON.stringify(c) + ' returns devices (' + res.length + ')');
    const top = res.slice(0, 6);
    const allCat = top.every(function (s) { return s.category === c; });
    ok(allCat, 'query ' + JSON.stringify(c) + ' leads with its own category (' +
      top.map(function (s) { return s.category; }).join(',') + ')');
  }
}

section('5. The specific devices that used to hijack "ont" are gone from the top');
{
  const specs = loadCatalog(path.join(__dirname, '..', 'devices'));
  const res = filter('ont', specs);
  const top10 = res.slice(0, 10);
  // A device can only justify its place here if "ont" appears in its category, or in
  // its model/label as a word. "Controller" does not qualify.
  const unjustified = top10.filter(function (s) {
    if (s.category === 'ont') return false;
    const txt = String(s.model) + ' ' + String(s.label);
    return !/\bont\b/i.test(txt);
  });
  ok(unjustified.length === 0, 'no device reaches the top 10 on a "Controller" accident (' +
    (unjustified.length ? ids(unjustified).join(', ') : 'none') + ')');
  const first = res[0];
  ok(first && first.category === 'ont', 'the first result is an ONT (' +
    (first ? first.vendor + '/' + first.model : 'none') + ')');
}

section('6. Nothing was made fuzzy to achieve this');
{
  const specs = loadCatalog(path.join(__dirname, '..', 'devices'));
  ok(filter('zzzznotadevice', specs).length === 0, 'a query matching nothing still returns nothing');
  // A transposition is still not a match.
  ok(filter('MC202L', specs).length === 0, 'a transposed SKU does not match MC220L');
  const mc = specs.filter(function (s) { return s.model === 'MC220L'; })[0];
  ok(!!mc, 'MC220L is in the catalogue');
  ok(filter('mc-220l', specs)[0] === mc, 'and punctuation folding still finds it first');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
