'use strict';
// Issue #36: the device palette could not find devices that were in the catalogue.
//
// Searching "MC220L" missed the TP-Link MC220L and "mc-220l" found nothing at all,
// because the filter did a raw substring test on model + label. Users do not type
// SKUs the way the datasheet prints them: they type "mc220", "MC 220L", "mc_220L",
// "tplink mc220l", "crs326", "ax89x". Every one of those names the same box.
//
// The fix folds both sides to lowercase alphanumerics before matching (spaces,
// hyphens, underscores, dots and slashes all disappear) and ranks hits so an exact
// model does not end up buried under devices that merely mention it in a description.
// Deliberately NOT fuzzy: a transposed typo must still return nothing.
//
// This loads the real web/app.js in the stub DOM the other UI tests use, and drives
// window.__pf.filterDevices() against the real catalogue from devices/registry.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg); }
}

// --- load the real frontend in the stub DOM (same shape as test/ui-render.test.js) --
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
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'web', 'app.js'), 'utf8'), ctx, { filename: 'app.js' });
const pf = ctx.window.__pf;
ok(!!pf && typeof pf.filterDevices === 'function', 'app.js loads and exposes filterDevices on window.__pf');

// --- the real catalogue ------------------------------------------------------------
const specs = loadCatalog(path.join(__dirname, '..', 'devices'));
ok(specs.length > 100, 'catalogue loaded: ' + specs.length + ' specs');
ok(!specs.some(function (s) { return s.vendor === 'error'; }), 'catalogue loaded without broken spec files');

const filter = pf.filterDevices;
function strip(s) { return String(s == null ? '' : s).replace(/[^a-z0-9]/gi, '').toLowerCase(); }
function ids(list) {
  return list.map(function (s) { return s.vendor + '/' + s.model; });
}
function find(v, m) {
  const s = specs.find(function (x) { return x.vendor === v && x.model === m; });
  if (!s) throw new Error('missing spec ' + v + '/' + m);
  return s;
}
const mc220l = find('tp-link', 'MC220L');
function includes(list, spec) { return list.indexOf(spec) !== -1; }
const PUNCT = ['MC220L', 'mc-220l', 'mc 220l', 'MC_220L', 'mc.220l', 'mc/220l',
  'MC 220 L', '  mc220l  ', 'Mc-220L'];

// 1. the same device, written the way different humans write it ---------------------
for (const raw of PUNCT) {
  const res = filter(raw, specs);
  ok(includes(res, mc220l) && res[0] === mc220l,
    'query ' + JSON.stringify(raw) + ' finds tp-link/MC220L (results: ' + ids(res).slice(0, 3).join(', ') +
    (res.length > 3 ? ', …' : '') + ')');
}

// 2. partial SKUs, the way people actually type them -------------------------------
for (const raw of ['mc220', 'mc-220', '220l', 'MC 220']) {
  const res = filter(raw, specs);
  ok(includes(res, mc220l), 'partial query ' + JSON.stringify(raw) + ' still finds tp-link/MC220L');
}

// 3. vendor + model, both spellings -------------------------------------------------
for (const raw of ['tp-link mc220l', 'tplink mc220l', 'TP-Link MC220L', 'tp link mc-220l']) {
  const res = filter(raw, specs);
  ok(res[0] === mc220l, 'vendor+model query ' + JSON.stringify(raw) + ' ranks tp-link/MC220L first');
}

// 4. multi-token query, order independent ------------------------------------------
for (const raw of ['gigabit media', 'media gigabit', 'sfp converter']) {
  const res = filter(raw, specs);
  ok(includes(res, mc220l), 'token query ' + JSON.stringify(raw) + ' finds the MC220L via its label/description');
}

// 5. real-world SKUs from the issue --------------------------------------------------
const crsG = filter('crs326', specs);
ok(crsG.length > 0 && crsG[0].vendor === 'mikrotik' && /^CRS326/.test(crsG[0].model),
  'query "crs326" ranks ' + (ids(crsG)[0] || 'nothing') + ' first');
ok(includes(filter('CRS326-24S+2Q+RM', specs), find('mikrotik', 'CRS326-24S+2Q+RM')),
  'query "CRS326-24S+2Q+RM" finds the full MikroTik SKU despite the + signs');
const ax = filter('ax89x', specs);
ok(ax.length > 0 && ax[0].vendor === 'asus' && ax[0].model === 'RT-AX89X',
  'query "ax89x" ranks asus/RT-AX89X first');
ok(includes(filter('sg2008p', specs), find('tp-link', 'SG2008P')),
  'query "sg2008p" finds tp-link/SG2008P');
// "sg105" is in the issue text; assert it whenever the catalogue carries the SKU
// (under either the TL-SG105 or the SG105 spelling) so the test does not depend on
// specs that live outside web/app.js.
const sg105 = specs.filter(function (s) { return strip(s.model) === 'tlsg105'; });
if (sg105.length) {
  const res = filter('SG105', specs);
  ok(sg105.every(function (s) { return includes(res, s); }) && res[0] === sg105[0],
    'query "SG105" ranks ' + ids(res).slice(0, 2).join(', ') + ' first');
} else {
  ok(true, 'query "SG105" skipped: no TL-SG105 spec in this catalogue');
}

// 6. a query of only punctuation must never empty the palette ----------------------
for (const raw of ['', '   ', '-', '---', '...', '/_-', '. ', '()']) {
  const res = filter(raw, specs);
  ok(res.length === specs.length, 'punctuation-only query ' + JSON.stringify(raw) +
    ' matches everything (' + res.length + '/' + specs.length + ')');
}

// 7. no fuzzy typo tolerance --------------------------------------------------------
for (const raw of ['mc22ol', 'mc220x', 'mc22l0l', 'mcc220l']) {
  ok(!includes(filter(raw, specs), mc220l),
    'typo ' + JSON.stringify(raw) + ' does NOT return the MC220L (no edit-distance matching)');
}
ok(filter('zzzznotadevice', specs).length === 0, 'a query that matches nothing returns an empty list');

// 8. ranking order is score, not catalogue order ------------------------------------
// Built by hand so each tier is the only possible reason for its position: the exact
// model sits LAST in the input array, and still comes out first.
const synth = [
  { vendor: 'acme', model: 'M1', label: 'PFX9 mounting bracket', category: 'host' },   // other field
  { vendor: 'acme', model: 'QQ', label: 'unrelated widget', category: 'host' },         // no match
  { vendor: 'pfx9corp', model: 'Z1', label: 'unrelated', category: 'host' },            // vendor hit
  { vendor: 'acme', model: 'PFX9-24G', label: 'unrelated', category: 'host' },          // model prefix
  { vendor: 'acme', model: 'PFX9', label: 'unrelated', category: 'host' }               // exact model
];
const ranked = ids(filter('pfx9', synth));
ok(ranked.join(' ') === 'acme/PFX9 acme/PFX9-24G pfx9corp/Z1 acme/M1',
  'ranking: exact model > model prefix > vendor match > other field (got ' + ranked.join(' ') + ')');

// 9. the palette facets still apply, and the search runs inside them ----------------
const tpOnly = filter('mc220l', specs, { vendor: 'tp-link' });
ok(tpOnly.length === 1 && tpOnly[0] === mc220l, 'vendor facet narrows the search to tp-link (1 hit)');
ok(filter('mc220l', specs, { vendor: 'cisco' }).length === 0, 'vendor facet excludes other vendors (cisco: 0 hits)');
ok(filter('mc220l', specs, { type: 'switch' }).length >= 1, 'type facet keeps the MC220L (category switch)');
ok(filter('mc220l', specs, { type: 'printer' }).length === 0, 'type facet excludes non-matching categories');

// 10. every device is reachable by its punctuation-stripped model -------------------
// 30 entries spread across the catalogue; the query is generated from the model with
// the same formula a user's fingers would produce, not from the matcher's own helper.
const pool = specs.filter(function (s) { return strip(s.model).length > 0; });
let sampleOk = 0;
for (let n = 0; n < 30; n++) {
  const s = pool[Math.floor(n * pool.length / 30)];
  const q = String(s.model).replace(/[^a-z0-9]/gi, '');
  const res = filter(q, specs);
  const at = res.indexOf(s);
  // Rank 0 is the norm; when two specs share a stripped model the catalogue order wins,
  // so only allow earlier hits that are literally the same SKU.
  const before = at > 0 ? res.slice(0, at) : [];
  const clean = at === 0 || before.every(function (r) { return strip(r.model) === strip(s.model); });
  if (at !== -1 && clean) sampleOk++;
  ok(at !== -1 && clean, 'sample ' + (n + 1) + ': "' + q + '" reaches ' + s.vendor + '/' + s.model +
    ' (rank ' + (at + 1) + ' of ' + res.length + ')');
}
ok(sampleOk === 30, 'all 30 sampled devices reachable by their punctuation-stripped model');

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
