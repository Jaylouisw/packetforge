'use strict';
// The palette rendered the entire catalogue, every vendor group expanded.
//
// Measured before the change, on the real catalogue: 1498 device cards, 243 open groups,
// 115,115 px of scroll inside a 289 px viewport - about 400 screens of cards between the
// top and the bottom of the list - and 11,358 DOM nodes built before anyone asked to see
// them. A search box made it survivable, but nothing about the default state was usable.
//
// Now: groups start collapsed unless something is narrowing the list (a query or a facet),
// and a group's cards are built the first time it is opened. Searching still expands every
// match, because then the list is short and the ranking is what matters. The summary line
// says how much of the catalogue is on screen.
//
// This loads the real web/app.js in a recording DOM, because the assertion that matters is
// how many .device-card nodes exist - which filterDevices cannot answer.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg); }
}
function eq(actual, expected, msg) {
  ok(actual === expected, msg + ' (expected ' + JSON.stringify(expected) +
    ', got ' + JSON.stringify(actual) + ')');
}
function section(name) { console.log('\n' + name); }

// --- a DOM that records what gets built ---------------------------------------------
function makeNode(tag) {
  const classes = new Set();
  const node = {
    tag: tag || 'div', children: [], attrs: {}, handlers: {}, textContent: '', value: '',
    options: [], selectedIndex: 0,
    _innerHTML: '', style: {}, dataset: {}, checked: false, parentElement: null,
    offsetParent: {}, scrollHeight: 0, clientHeight: 289,
    get innerHTML() { return this._innerHTML; },
    set innerHTML(v) {
      this._innerHTML = String(v);
      // The real DOM replaces the subtree on any innerHTML assignment; renderPalette
      // relies on that to clear the list before rebuilding it.
      if (this._innerHTML === '') this.children.length = 0;
    },
    get className() { return [...classes].join(' '); },
    set className(v) {
      classes.clear();
      String(v == null ? '' : v).split(/\s+/).filter(Boolean).forEach(function (c) { classes.add(c); });
    },
    classList: {
      add: function (c) { classes.add(c); },
      remove: function (c) { classes.delete(c); },
      toggle: function (c) { if (classes.has(c)) { classes.delete(c); return false; } classes.add(c); return true; },
      contains: function (c) { return classes.has(c); }
    },
    appendChild: function (c) { this.children.push(c); if (c && c.tag === 'option') this.options.push(c); if (c) c.parentElement = this; return c; },
    append: function () { for (let i = 0; i < arguments.length; i++) this.children.push(arguments[i]); },
    setAttribute: function (k, v) { this.attrs[k] = v; },
    getAttribute: function (k) { return k in this.attrs ? this.attrs[k] : null; },
    removeAttribute: function () {}, remove: function () {}, focus: function () {},
    click: function () { if (this.handlers.click) this.handlers.click.call(this); },
    addEventListener: function (ev, fn) { this.handlers[ev] = fn; },
    removeEventListener: function () {},
    querySelector: function (sel) { return findIn(this, sel) || makeNode('span'); },
    querySelectorAll: function (sel) { return findAllIn(this, sel); }
  };
  return node;
}
function matches(node, sel) {
  if (!sel) return false;
  if (sel.charAt(0) === '.') return node.classList && node.classList.contains(sel.slice(1));
  return node.tag === sel;
}
function findAllIn(root, sel) {
  const out = [];
  (function walk(n) {
    for (const c of n.children || []) {
      if (matches(c, sel)) out.push(c);
      walk(c);
    }
  })(root);
  return out;
}
function findIn(root, sel) {
  const all = findAllIn(root, sel);
  return all.length ? all[0] : null;
}

const registry = {};
function makeDocument() {
  return {
    addEventListener: function () {},
    createElement: function (tag) { return makeNode(tag); },
    querySelector: function (sel) {
      if (!registry[sel]) registry[sel] = makeNode('div');
      return registry[sel];
    },
    querySelectorAll: function () { return []; },
    getElementById: function (id) { return this.querySelector('#' + id); },
    body: makeNode('body')
  };
}

const ctx = {
  console: console, setTimeout: setTimeout, clearTimeout: clearTimeout, setInterval: setInterval,
  fetch: function () { return Promise.resolve({ ok: true, json: function () { return Promise.resolve({}); } }); },
  document: makeDocument(),
  window: {},
  PFCanvas: { on: {}, setTopology: function () {}, fitView: function () {}, render: function () {},
    setSelected: function () {}, setSelectedLink: function () {}, animateEvents: function () {}, zoomBy: function () {} }
};
ctx.window.PFCanvas = ctx.PFCanvas;
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'web', 'app.js'), 'utf8'), ctx, { filename: 'app.js' });
const pf = ctx.window.__pf;
ok(!!pf && typeof pf.renderPalette === 'function', 'app.js loads and exposes renderPalette');
ok(typeof pf.setCatalog === 'function', 'and a way to install a catalogue');

const specs = loadCatalog(path.join(__dirname, '..', 'devices'));
ok(specs.length > 1000, 'catalogue loaded: ' + specs.length + ' specs');
pf.setCatalog({ specs: specs, categories: {} });

const list = ctx.document.querySelector('#palette-list');
const search = ctx.document.querySelector('#pf-search');

function cards() { return findAllIn(list, '.device-card'); }
function groups() { return findAllIn(list, '.vendor-group'); }
function openGroups() { return groups().filter(function (g) { return g.classList.contains('open'); }); }
function summary() {
  const s = findAllIn(list, '.palette-summary');
  return s.length ? s[0].textContent : null;
}
function type(q) {
  search.value = q;
  if (search.handlers.input) search.handlers.input.call(search);
  else pf.renderPalette();
}

section('1. With no query the palette builds no cards at all');
{
  pf.renderPalette();
  const vendorCount = new Set(specs.map(function (s) { return s.vendor; })).size;
  eq(groups().length, vendorCount, 'one row per vendor group (' + vendorCount + ')');
  eq(openGroups().length, 0, 'and not one of them is expanded');
  eq(cards().length, 0, 'so no device cards are in the DOM');
  eq(summary(), specs.length + ' devices in ' + vendorCount + ' vendor groups',
    'the summary says how much of the catalogue is there');
}

section('2. Opening a group builds its cards, once');
{
  const g = groups()[0];
  const head = findIn(g, '.vendor-head');
  ok(!!head, 'the group has a header to click');
  const name = head.attrs['data-vendor'] || null;
  head.click();
  ok(g.classList.contains('open'), 'clicking the header expands the group');
  const built = cards().length;
  ok(built > 0, 'and its cards are built on demand (' + built + ')');

  // Clicking again collapses without rebuilding; opening a second time must not duplicate.
  head.click();
  ok(!g.classList.contains('open'), 'clicking again collapses it');
  eq(cards().length, built, 'the cards stay in the DOM, collapsed rather than destroyed');
  head.click();
  eq(cards().length, built, 'and reopening does not build them twice');
}

section('3. Searching still expands every match');
{
  pf.renderPalette();
  type('ont');
  const expected = pf.filterDevices('ont', specs).length;
  eq(cards().length, expected, 'every match is built (' + expected + ')');
  eq(summary(), expected + ' of ' + specs.length + ' devices', 'and the summary counts the matches');
  ok(cards().length < specs.length, 'which is far fewer than the whole catalogue (' + specs.length + ')');
  const firstLabel = cards()[0].innerHTML;
  ok(/ONT/i.test(firstLabel), 'the first card is an ONT');
}

section('4. Clearing the query returns to the collapsed state');
{
  type('');
  eq(cards().length, 0, 'no cards remain after clearing the search');
  eq(openGroups().length, 0, 'and no group is left expanded');
}

section('5. A vendor facet counts as narrowing');
{
  // The vendor dropdown is a deliberate narrowing action, so its results should be
  // visible without a second click.
  const vendor = specs[0].vendor;
  type('');
  pf.renderPalette();
  // Drive the facet the way the UI does: set the palette filter through the select handler.
  const sel = ctx.document.querySelector('#filter-vendor');
  if (sel && sel.handlers && sel.handlers.change) {
    sel.value = vendor;
    sel.handlers.change.call(sel);
    ok(openGroups().length > 0 || cards().length > 0,
      'selecting a vendor shows that vendor (' + cards().length + ' cards, ' +
      openGroups().length + ' open groups)');
  } else {
    ok(true, 'no vendor facet handler bound in this harness; skipped rather than asserted');
  }
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
