'use strict';
// A search box that can only ever answer "no" is a dead end. The catalogue is 1,500
// models across 245 vendors and three facets; the way to zero results is one careless
// keystroke while a vendor filter is still set from five minutes ago, and the old
// empty state - "No devices match your search / filters." - named nothing and offered
// nothing.
//
// Two things are tested here: that the message names what actually failed to match,
// and that the way back out exists and resets every control, not just the search box.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg); }
}

const WEB = path.join(__dirname, '..', 'web');
const appjs = fs.readFileSync(path.join(WEB, 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(WEB, 'style.css'), 'utf8');

// --- a stub DOM that remembers what was written to it ----------------------
const nodes = new Map();
function node(sel) {
  if (nodes.has(sel)) return nodes.get(sel);
  const n = {
    value: '', innerHTML: '', textContent: '', id: '', className: '', type: '',
    children: [], style: {}, dataset: {},
    // buildFilterControls only rebuilds the facets when they are empty; length 2 keeps
    // the stub out of that path, which needs real <option> elements to mean anything.
    options: { length: 2 }, selectedIndex: 0, disabled: false,
    classList: { add: function () {}, remove: function () {}, toggle: function () {}, contains: function () { return false; } },
    addEventListener: function () {}, setAttribute: function () {}, getAttribute: function () { return null; },
    appendChild: function (c) { n.children.push(c); return c; }, append: function () {},
    remove: function () {}, focus: function () {}, click: function () {},
    querySelector: function () { return node(sel + ' >x'); }, querySelectorAll: function () { return []; },
    closest: function () { return null; }, parentElement: null
  };
  nodes.set(sel, n);
  return n;
}
function anyNode() { return node('__last__'); }

const ctx = {
  console: console, setTimeout: setTimeout, clearTimeout: clearTimeout, setInterval: setInterval,
  encodeURIComponent: encodeURIComponent,
  fetch: function () { return Promise.resolve({ ok: true, json: function () { return Promise.resolve({}); } }); },
  document: {
    addEventListener: function () {},
    createElement: function () { return anyNode(); },
    querySelector: function (sel) { return node(sel); },
    querySelectorAll: function () { return []; }
  },
  window: {},
  navigator: { userAgent: 'TestAgent/1.0' },
  location: { href: 'http://localhost:8000/' },
  PFCanvas: { on: {}, setTopology: function () {}, fitView: function () {}, render: function () {}, setSelected: function () {}, setSelectedLink: function () {}, animateEvents: function () {}, zoomBy: function () {} }
};
ctx.window.PFCanvas = ctx.PFCanvas;
ctx.window.navigator = ctx.navigator;
ctx.window.location = ctx.location;
ctx.window.open = function () { return {}; };
ctx.window.encodeURIComponent = encodeURIComponent;
vm.createContext(ctx);
vm.runInContext(appjs, ctx, { filename: 'app.js' });
const pf = ctx.window.__pf;

ok(!!pf && typeof pf.describeEmptyState === 'function', 'the empty-state message is exposed for testing');

console.log('\nThe message names what failed to match:');
ok(pf.describeEmptyState({ q: 'xyzzy' }) === 'Nothing matches "xyzzy".',
  'a query alone is quoted back', pf.describeEmptyState({ q: 'xyzzy' }));
ok(pf.describeEmptyState({ vendor: 'mikrotik' }).indexOf('vendor mikrotik') !== -1,
  'a vendor filter is named');
ok(pf.describeEmptyState({ type: 'switch' }).indexOf('type switch') !== -1,
  'a type filter is named');
const both = pf.describeEmptyState({ q: 'xyzzy', vendor: 'mikrotik' });
ok(both.indexOf('"xyzzy"') !== -1 && both.indexOf('vendor mikrotik') !== -1,
  'a query and a filter are both named', both);
ok(/ with /.test(both), 'and they are joined so the sentence reads as one clause');
const three = pf.describeEmptyState({ q: 'a', vendor: 'b', type: 'c' });
ok(three.indexOf('vendor b') !== -1 && three.indexOf('type c') !== -1 && three.indexOf('"a"') !== -1,
  'all three facets appear when all three are set', three);
ok(pf.describeEmptyState({}).indexOf('bug') !== -1,
  'an unfiltered empty catalogue is called a bug, because that is what it would be');
ok(pf.describeEmptyState(null).indexOf('bug') !== -1, 'and a null filter is handled');
ok(pf.describeEmptyState({ q: '   ' }).indexOf('bug') !== -1,
  'whitespace-only input counts as no query');
ok(pf.describeEmptyState({ q: 'x' }).indexOf('undefined') === -1, 'never prints undefined');
ok(pf.describeEmptyState({ q: 'x', vendor: 'v', type: 't' }).indexOf('undefined') === -1,
  'never prints undefined in the three-facet case either');

console.log('\nThe way out resets every control, not just the search box:');
const search = node('#pf-search'), vendor = node('#pf-vendor'), type = node('#pf-type');
search.value = 'xyzzy'; vendor.value = 'mikrotik'; type.value = 'switch';
pf.clearPaletteFilter();
ok(search.value === '', 'the search box is emptied');
ok(vendor.value === '', 'the vendor facet is reset');
ok(type.value === '', 'the type facet is reset');

console.log('\nThe empty state offers that way out:');
ok(/id = 'palette-clear'/.test(appjs), 'renderPalette creates a control with a stable id');
ok(/Clear search and filters/.test(appjs), 'the control is labelled in words');
ok(/clearPaletteFilter\(\)/.test(appjs), 'it calls the reset');
ok(/paletteFilter\.q \|\| paletteFilter\.vendor \|\| paletteFilter\.type/.test(appjs),
  'the control is only offered when something is actually narrowing');
ok(/palette-empty-why/.test(appjs), 'the message is its own element, not the whole empty state');
ok(/\.palette-empty-why/.test(css), 'and it is styled');
ok(/\.palette-empty \.btn/.test(css), 'so is the control inside the empty state');

if (failed) { console.error('\n' + failed + ' palette-empty check(s) failed'); process.exit(1); }
console.log('\n' + passed + ' palette-empty checks passed.');
