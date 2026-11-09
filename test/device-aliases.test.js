'use strict';
// Device aliases: the names people actually type, which are not the model string.
//
// The catalogue has three conventions that make names long and unlike what anyone says out loud:
// a card complement in the model (`OptiXtrans E6616 (14x B1LDCD)`), a family name that everybody
// shortens (`NetEngine 8000 M1D-B` -> "M1D-B"), and a board name that identifies the shelf to the
// person holding the optic (`B1LDCD`).
//
// All three already *matched* before this - as rank 3 substrings, behind whatever else happened to
// contain those characters. That is the same failure the category-word tier was added to fix: a
// deliberate name should not sit below an accident of spelling. Aliases rank with a model prefix.
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
    innerHTML: '', textContent: '', value: '', style: {}, dataset: {},
    classList: { add: function () {}, remove: function () {}, toggle: function () {}, contains: function () { return false; } },
    addEventListener: function () {}, removeEventListener: function () {},
    appendChild: function () { return fakeNode(); }, append: function () {},
    setAttribute: function () {}, getAttribute: function () { return null; },
    removeAttribute: function () {}, remove: function () {}, focus: function () {}, click: function () {},
    querySelector: function () { return fakeNode(); }, querySelectorAll: function () { return []; },
    closest: function () { return null; }, parentElement: null, children: []
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
const filterDevices = pf.filterDevices;
const specs = loadCatalog(path.join(__dirname, '..', 'devices'));

console.log('');
console.log('The harness sees the real filter:');
ok(typeof filterDevices === 'function', 'filterDevices is exported');

console.log('');
console.log('A fixture where the alias matters, so the ranking is visible:');
{
  const FIX = [
    { vendor: 'huawei', model: 'OptiXtrans E6616 (14x B1LDCD)', aliases: ['E6616', 'B1LDCD'], category: 'switch', interfaces: [] },
    { vendor: 'huawei', model: 'Something Else', description: 'works with E6616 shelves', category: 'switch', interfaces: [] },
    { vendor: 'acme', model: 'E6616', category: 'switch', interfaces: [] }
  ];
  const hits = filterDevices('E6616', FIX, {});
  ok(hits[0].vendor === 'acme' && hits[0].model === 'E6616', 'an exact model still wins outright', hits[0].model);
  const shelf = hits.filter(function (h) { return /OptiXtrans/.test(h.model); })[0];
  const desc = hits.filter(function (h) { return h.model === 'Something Else'; })[0];
  ok(hits.indexOf(shelf) < hits.indexOf(desc), 'the alias outranks a description that merely mentions the string');

  const b = filterDevices('B1LDCD', FIX, {});
  ok(b.length >= 1 && /OptiXtrans/.test(b[0].model), 'a board name finds the shelf that takes it', b[0] && b[0].model);

  // The vendor facet is still the vendor facet: an alias must not smuggle a device into another
  // vendor's listing.
  const faceted = filterDevices('B1LDCD', FIX, { vendor: 'acme' });
  ok(faceted.every(function (h) { return h.vendor === 'acme'; }), 'an alias cannot cross the vendor facet');
}

console.log('');
console.log('Against the real catalogue:');
{
  const e6616 = filterDevices('E6616', specs, {});
  ok(e6616.length >= 1 && /OptiXtrans E6616/.test(e6616[0].model), 'E6616 finds the shelf first', e6616[0] && e6616[0].model);

  const m1d = filterDevices('M1D-B', specs, { vendor: 'huawei' });
  ok(m1d[0] && /M1D-B/.test(m1d[0].model), 'M1D-B finds the NetEngine', m1d[0] && m1d[0].model);

  const board = filterDevices('B1LDCD', specs, {});
  ok(board.length === 2, 'B1LDCD finds both shelves that take the board', String(board.length));

  const multi = filterDevices('b1ldcd 14x', specs, {});
  ok(multi.length >= 1 && /E6616/.test(multi[0].model), 'a multi-token query can mix an alias with a model word', multi[0] && multi[0].model);

  ok(filterDevices('E6616', specs, {}).every(function (h) { return h.vendor === 'huawei'; }) ||
     filterDevices('E6616', specs, {}).length > 0, 'the search still works with no facet');
}

console.log('');
console.log('The catalogue invariant: an alias must not shadow another device:');
{
  const problems = [];
  const modelKeys = new Map();
  for (const s of specs) {
    if (!s.model) continue;
    const k = pf.searchKey(s.model);
    if (!modelKeys.has(k)) modelKeys.set(k, []);
    modelKeys.get(k).push(s.vendor + '/' + s.model);
  }
  for (const s of specs) {
    const aliases = s.aliases;
    if (aliases == null) continue;
    if (!Array.isArray(aliases)) { problems.push(s.model + ': aliases is not an array'); continue; }
    const seen = new Set();
    for (const a of aliases) {
      if (typeof a !== 'string' || !a.trim()) { problems.push(s.model + ': empty or non-string alias'); continue; }
      const k = pf.searchKey(a);
      if (seen.has(k)) problems.push(s.model + ': duplicate alias ' + JSON.stringify(a));
      seen.add(k);
      if (k === pf.searchKey(s.model)) problems.push(s.model + ': alias is its own model name');
      if (modelKeys.has(k)) problems.push(s.model + ': alias ' + JSON.stringify(a) + ' is another device\'s model (' + modelKeys.get(k)[0] + ')');
    }
  }
  ok(problems.length === 0, 'no alias is empty, duplicated, self-referential, or another model name', problems.slice(0, 4).join(' ; '));
}

console.log('');
console.log('A device with no aliases behaves exactly as it did:');
{
  const plain = specs.filter(function (s) { return !s.aliases && /MC220L/i.test(s.model || ''); })[0];
  ok(!!plain, 'found a device with no aliases');
  const hits = filterDevices(plain.model, specs, { vendor: plain.vendor });
  ok(hits[0] && hits[0].model === plain.model, 'and it still finds itself first');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exitCode = 1;
