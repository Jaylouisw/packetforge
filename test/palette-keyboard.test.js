'use strict';
// The palette is the only way into a catalogue of ~1,700 models, and it was
// pointer-only: type a query, read the ranked list, then reach for the mouse. Arrow
// keys and Enter are what a search box is expected to do, and for anyone who cannot
// use a pointer they are the difference between this catalogue being usable and being
// unavailable.
//
// What is tested here is the behaviour a keyboard user gets: the first ArrowDown
// selects the first card (not the second), the highlight wraps at both ends, Enter
// commits the highlighted card, Enter with exactly one result and nothing highlighted
// commits that one, Enter with several results and nothing highlighted does nothing
// (picking one would be a guess), and Escape clears the highlight.
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

// --- stub DOM ---------------------------------------------------------------
// Cards remember whether they were clicked and whether they carry the highlight, and
// the search box hands back the listener it was given so a test can drive it.
const listeners = {};
function makeCard(id) {
  const classes = new Set();
  return {
    id: id, clicked: 0,
    classList: {
      add: function (c) { classes.add(c); },
      remove: function (c) { classes.delete(c); },
      contains: function (c) { return classes.has(c); },
      toggle: function () {},
      _all: function () { return Array.from(classes); }
    },
    scrollIntoView: function () {},
    click: function () { this.clicked += 1; }
  };
}
let cards = [];
const searchEl = {
  value: '',
  attrs: {},
  addEventListener: function (evt, fn) { listeners[evt] = fn; },
  setAttribute: function (k, v) { this.attrs[k] = v; },
  getAttribute: function (k) { return this.attrs[k] === undefined ? null : this.attrs[k]; }
};
const nodes = new Map();
function node(sel) {
  if (sel === '#pf-search') return searchEl;
  if (nodes.has(sel)) return nodes.get(sel);
  const n = {
    value: '', innerHTML: '', textContent: '', id: '', className: '', type: '',
    children: [], style: {}, dataset: {}, options: { length: 2 }, selectedIndex: 0, disabled: false,
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

const ctx = {
  console: console, setTimeout: setTimeout, clearTimeout: clearTimeout, setInterval: setInterval,
  encodeURIComponent: encodeURIComponent,
  fetch: function () { return Promise.resolve({ ok: true, json: function () { return Promise.resolve({}); } }); },
  document: {
    addEventListener: function () {},
    createElement: function () { return node('__el__' + Math.random()); },
    getElementById: function (id) { return null; },
    querySelector: function (sel) { return node(sel); },
    // The only selector the palette keyboard uses.
    querySelectorAll: function (sel) { return sel === '#palette-list .device-card' ? cards : []; }
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
vm.createContext(ctx);
vm.runInContext(appjs, ctx, { filename: 'app.js' });
const pf = ctx.window.__pf;

function key(k) {
  let prevented = false;
  const ev = { key: k, preventDefault: function () { prevented = true; } };
  listeners.keydown(ev);
  return prevented;
}

console.log('The wrap arithmetic, without a DOM:');
ok(typeof pf.nextPaletteIndex === 'function', 'nextPaletteIndex is exposed for testing');
ok(pf.nextPaletteIndex(-1, 5, 1) === 0, 'the first ArrowDown selects the first card, not the second');
ok(pf.nextPaletteIndex(-1, 5, -1) === 4, 'the first ArrowUp selects the last card');
ok(pf.nextPaletteIndex(0, 5, 1) === 1, 'ArrowDown advances');
ok(pf.nextPaletteIndex(4, 5, 1) === 0, 'and wraps past the end');
ok(pf.nextPaletteIndex(0, 5, -1) === 4, 'ArrowUp wraps before the start');
ok(pf.nextPaletteIndex(2, 1, 1) === 0, 'a single result stays selected');
ok(pf.nextPaletteIndex(-1, 0, 1) === -1, 'no results means no selection');
ok(pf.nextPaletteIndex(0, 0, -1) === -1, 'no results means no selection upwards either');

console.log('\nThe listener is bound to the search box:');
ok(pf.bindPaletteKeyboard() === true, 'bindPaletteKeyboard attaches to #pf-search');
ok(typeof listeners.keydown === 'function', 'a keydown listener is registered');

console.log('\nArrow keys move a visible highlight:');
cards = [makeCard('pf-card-a'), makeCard('pf-card-b'), makeCard('pf-card-c')];
ok(key('ArrowDown') === true, 'ArrowDown is handled, so the page does not scroll');
ok(pf.paletteActiveIndex() === 0, 'it highlights the first card');
ok(cards[0].classList.contains('kbd-active'), 'the first card is marked');
ok(searchEl.attrs['aria-activedescendant'] === 'pf-card-a',
  'and the search box points at it for a screen reader');
key('ArrowDown');
ok(pf.paletteActiveIndex() === 1, 'a second ArrowDown moves to the second');
ok(!cards[0].classList.contains('kbd-active'), 'the previous card loses the mark');
key('ArrowUp');
ok(pf.paletteActiveIndex() === 0, 'ArrowUp moves back');
key('ArrowUp');
ok(pf.paletteActiveIndex() === 2, 'and wraps to the last card');

console.log('\nEnter commits what is highlighted:');
ok(key('Enter') === true, 'Enter is handled');
ok(cards[2].clicked === 1, 'the highlighted card is clicked, exactly once');
ok(cards[0].clicked === 0 && cards[1].clicked === 0, 'and no other card is');

console.log('\nEscape clears the highlight:');
ok(key('Escape') === true, 'Escape is handled while something is highlighted');
ok(pf.paletteActiveIndex() === -1, 'the highlight is cleared');
ok(!cards[2].classList.contains('kbd-active'), 'and the card is unmarked');
ok(key('Escape') === false, 'Escape with nothing highlighted is left to the page');

console.log('\nEnter with a single result and nothing highlighted:');
cards = [makeCard('pf-card-only')];
ok(key('Enter') === true, 'Enter is handled');
ok(cards[0].clicked === 1, 'the only result is committed, which is what clicking it would do');

console.log('\nEnter with several results and nothing highlighted:');
cards = [makeCard('pf-card-x'), makeCard('pf-card-y')];
ok(key('Enter') === false, 'Enter is not handled');
ok(cards[0].clicked === 0 && cards[1].clicked === 0,
  'nothing is clicked, because picking one of several would be a guess');

console.log('\nThe empty list:');
cards = [];
ok(key('ArrowDown') === false, 'ArrowDown is not handled when there is nothing to move through');
ok(key('Enter') === false, 'and Enter is not handled either');
ok(pf.paletteActiveIndex() === -1, 'no selection can exist');

console.log('\nThe re-render, the id and the styling:');
ok(/paletteActiveIndex = -1;/.test(appjs), 'a re-render clears any stale highlight');
ok(/card\.id = 'pf-card-'/.test(appjs), 'cards get a stable id to point at');
ok(/bindPaletteKeyboard\(\);/.test(appjs), 'boot binds the keyboard handler');
ok(/scrollIntoView/.test(appjs), 'the highlight is scrolled into view, not left off-screen');
ok(/\.device-card\.kbd-active/.test(css), 'the highlight is styled');
ok(/outline/.test(css.slice(css.indexOf('.device-card.kbd-active'))),
  'and it uses an outline, so highlighting does not shift the layout');

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.error('\n' + failed + ' palette-keyboard check(s) failed'); process.exit(1); }
console.log('\n' + passed + ' palette-keyboard checks passed.');
