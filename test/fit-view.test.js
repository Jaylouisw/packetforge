'use strict';
// "Fit to view" must fit the view (issue #56).
//
// fitView() was `view.zoom = 1; view.panX = 60; view.panY = 40` - a hard-coded reset wearing
// the label of the button next to it. On any board larger than the initial window it threw
// most of the network off-screen, and since zoomBy() clamps to 0.25 there was no other
// overview control: the only way to see a whole topology was to press "−" repeatedly.
//
// This loads the real web/canvas.js against a stub DOM, lays out boards of different sizes,
// presses "fit", and asserts from the resulting transform that every device is inside the
// viewport.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { Topology } = require('../engine');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg); }
}

// --- stub DOM with a measurable viewport ----------------------------------
const VIEW = { width: 654, height: 528 };   // the size the issue measured at
function rec(name, attrs) {
  return {
    tag: name, attrs: attrs || {}, children: [], textContent: '', style: {}, parentNode: null,
    appendChild: function (c) { c.parentNode = this; this.children.push(c); return c; },
    setAttribute: function (k, v) { this.attrs[k] = v; },
    getAttribute: function (k) { return this.attrs[k]; },
    getBoundingClientRect: function () {
      return { left: 0, top: 0, width: VIEW.width, height: VIEW.height,
        right: VIEW.width, bottom: VIEW.height };
    },
    addEventListener: function () {}, removeEventListener: function () {},
    classList: { add: function () {}, remove: function () {}, toggle: function () {}, contains: function () { return false; } },
    querySelector: function () { return null; }, querySelectorAll: function () { return []; },
    set innerHTML(v) { this.children.length = 0; },
    get innerHTML() { return ''; }
  };
}

const roots = {};
['canvas', 'world', 'packets', 'overlay'].forEach(function (id) { roots[id] = rec('g', { id: id }); });

const sandbox = {
  console: console,
  document: {
    getElementById: function (id) { return roots[id] || rec('div'); },
    querySelector: function () { return rec('div'); },
    querySelectorAll: function () { return []; },
    createElement: function (t) { return rec(t); },
    createElementNS: function (ns, t) { return rec(t); },
    addEventListener: function () {}
  },
  window: {},
  setTimeout: function () { return 0; }, clearTimeout: function () {},
  requestAnimationFrame: function () { return 0; },
  performance: { now: function () { return 0; } },
  localStorage: { getItem: function () { return null; }, setItem: function () {} }
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;

vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'web', 'canvas.js'), 'utf8'),
  sandbox, { filename: 'canvas.js' });
const PFCanvas = sandbox.window.PFCanvas || sandbox.PFCanvas;
ok(!!PFCanvas && typeof PFCanvas.fitView === 'function', 'canvas.js loads and exposes fitView()');

const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
const swSpec = catalog.find(function (s) {
  return s.category === 'switch' && (s.interfaces || []).length > 0;
});

// The transform applyView() writes is the observable: translate(panX,panY) scale(zoom).
function currentView() {
  const t = String(roots.world.attrs.transform || '');
  const m = /translate\(([-\d.]+),([-\d.]+)\)\s*scale\(([-\d.]+)\)/.exec(t);
  if (!m) return null;
  return { panX: parseFloat(m[1]), panY: parseFloat(m[2]), zoom: parseFloat(m[3]) };
}

// Build a board of n devices on a spread-out grid, render it, press fit, and report
// whether every device box lands inside the viewport.
function fitBoard(n, spacing) {
  const t = new Topology();
  for (let i = 0; i < n; i++) {
    const d = t.addDevice(swSpec);
    t.setLayout ? t.setLayout(d.id, { x: 80 + (i % 4) * spacing, y: 60 + Math.floor(i / 4) * spacing })
                : null;
    if (!t.setLayout) t.state = t.state || {};
  }
  // The engine may not expose a layout setter; write into the serialized form instead.
  const json = JSON.parse(JSON.stringify(t.serialize()));
  json.layout = json.layout || {};
  for (let i = 0; i < n; i++) {
    const id = json.devices[i].id;
    json.layout[id] = { x: 80 + (i % 4) * spacing, y: 60 + Math.floor(i / 4) * spacing };
  }
  PFCanvas.render(json);
  PFCanvas.fitView();
  const v = currentView();
  let inside = 0, total = 0;
  for (const d of json.devices) {
    const box = json.layout[d.id];
    const w = 150, h = 90;   // deviceSize for a small switch; exactness is not the point
    total++;
    const left = v.panX + box.x * v.zoom;
    const top = v.panY + box.y * v.zoom;
    const right = left + w * v.zoom;
    const bottom = top + h * v.zoom;
    if (left >= -1 && top >= -1 && right <= VIEW.width + 1 && bottom <= VIEW.height + 1) inside++;
  }
  return { view: v, inside: inside, total: total };
}

console.log('');
console.log('A board bigger than the window is framed:');
{
  const r = fitBoard(10, 320);
  ok(!!r.view, 'the view transform was written (' + JSON.stringify(r.view) + ')');
  ok(r.inside === r.total,
    'every device is inside the viewport (' + r.inside + '/' + r.total + ')');
  ok(r.view.zoom < 1, 'and it zoomed out to do it (zoom ' + (r.view && r.view.zoom) + ')');
}

console.log('');
console.log('A small board is framed without being blown up:');
{
  const r = fitBoard(2, 220);
  ok(r.inside === r.total, 'both devices are inside the viewport');
  ok(r.view.zoom <= 1.0001, 'and the zoom never exceeds 100% (zoom ' + (r.view && r.view.zoom) + ')');
}

console.log('');
console.log('It is not the old constant assignment:');
{
  const a = fitBoard(10, 320).view;
  const b = fitBoard(3, 180).view;
  ok(a && b && (a.zoom !== b.zoom || a.panX !== b.panX || a.panY !== b.panY),
    'two different boards produce two different views (' +
    (a && a.zoom) + ' vs ' + (b && b.zoom) + ')');
  ok(!(a.zoom === 1 && a.panX === 60 && a.panY === 40),
    'and never falls back to the hard-coded 1/(60,40) for a board that has devices');
}

console.log('');
console.log('The zoom stays inside the manual limits:');
{
  const r = fitBoard(16, 900);
  ok(r.view.zoom >= 0.25 && r.view.zoom <= 3,
    'a very large board clamps at 0.25 rather than vanishing (' + r.view.zoom + ')');
}

console.log('');
console.log('An empty board keeps the default view:');
{
  PFCanvas.render({ devices: [], links: [], layout: {} });
  PFCanvas.fitView();
  const v = currentView();
  ok(v && v.zoom === 1 && v.panX === 60 && v.panY === 40,
    'nothing to frame means the default view, not NaN (' + JSON.stringify(v) + ')');
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
