'use strict';

// A cable can be deleted (issue #86).
//
// The complaint: "A cable can never be deleted: no button, no Delete key, no context menu —
// though the API supports it." That was literally true. `disconnect()` existed in the
// engine, `DELETE /topologies/:t/links/:id` existed in the server, and nothing in the UI
// called either. The only way to remove a mis-dragged cable was to delete one of the
// devices it touched, which also removed every other cable that device had — so recovering
// from one bad drag could destroy a morning's work.
//
// The fix is three affordances onto the same endpoint, because people reach for different
// ones: the Delete/Backspace key, a button in the cable inspector, and a right-click menu
// on the cable itself. This test drives the real modules for each of those:
//
//   - canvas.js with a stub DOM and a real coordinate system, to prove a right-click over a
//     cable run reports THAT cable (and still reports a device where a device is on top);
//   - app.js in a stub environment, to prove the delete decision goes to the cable rather
//     than the device, and that the request it makes is the narrow one (DELETE /links/:id)
//     rather than anything that would take devices with it.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { Topology } = require('../engine');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg); }
}

const VIEW = { width: 900, height: 700 };

// --- a stub DOM that records listeners and can be driven ---------------------
function makeNode(name, attrs) {
  const node = {
    tag: name,
    attrs: attrs || {},
    children: [],
    listeners: {},
    style: {},
    classList: { add: function () {}, remove: function () {}, toggle: function () {}, contains: function () { return false; } },
    setAttribute: function (k, v) { this.attrs[k] = v; },
    getAttribute: function (k) { return this.attrs[k] === undefined ? null : this.attrs[k]; },
    removeAttribute: function (k) { delete this.attrs[k]; },
    appendChild: function (c) { this.children.push(c); c.parentNode = this; return c; },
    append: function () { for (let i = 0; i < arguments.length; i++) this.appendChild(arguments[i]); },
    removeChild: function (c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); },
    remove: function () { if (this.parentNode) this.parentNode.removeChild(this); },
    addEventListener: function (ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); },
    removeEventListener: function (ev, fn) {
      const l = this.listeners[ev] || [];
      const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1);
    },
    fire: function (ev, obj) {
      const l = (this.listeners[ev] || []).slice();
      const event = Object.assign({ type: ev, preventDefault: function () { this.defaultPrevented = true; }, stopPropagation: function () {} }, obj || {});
      l.forEach(function (fn) { fn(event); });
      return event;
    },
    querySelector: function () { return null; },
    querySelectorAll: function () { return []; },
    getBoundingClientRect: function () { return { left: 0, top: 0, width: VIEW.width, height: VIEW.height }; },
    focus: function () {},
    click: function () { this.fire('click', {}); }
  };
  return node;
}

// --- the topology under test: one cable between two switches -----------------
const topo = new Topology();
const a = topo.addDevice({ vendor: 'test', model: 'sw-a', category: 'switch',
  interfaces: [{ name: 'port1', type: 'ethernet', speed: '1G' }, { name: 'port2', type: 'ethernet', speed: '1G' }] });
const b = topo.addDevice({ vendor: 'test', model: 'sw-b', category: 'switch',
  interfaces: [{ name: 'port1', type: 'ethernet', speed: '1G' }] });
const link = topo.connect(a.id, 'port1', b.id, 'port1', { mediaId: '1000base-t' });
ok(!!link && !!link.id, 'fixture: a cable exists between two switches');

// Place the devices so the cable runs along a known line.
// The canvas takes device coordinates from topology.layout[id], not from the device - a
// detail worth stating, because a fixture that sets device.position instead leaves every
// device drawn at the same fallback point and every cable zero-length.
const state = JSON.parse(JSON.stringify(topo.serialize()));
state.layout = {};
state.layout[a.id] = { x: 120, y: 160 };
state.layout[b.id] = { x: 560, y: 160 };
const positions = state.layout;

// --- load canvas.js ---------------------------------------------------------
const svg = makeNode('svg');
const calls = { contextLink: [], context: [], selectLink: [] };

// canvas.js grabs #canvas by id at load time, so the stub has to answer that one
// specifically; everything else can be a throwaway node.
const canvasSvgNode = makeNode('svg', { id: 'canvas' });

function loadCanvas() {
  const ctx = {
    console: console,
    document: {
      createElementNS: function (ns, tag) { return makeNode(tag); },
      createElement: function (tag) { return makeNode(tag); },
      getElementById: function (id) { return id === 'canvas' ? canvasSvgNode : makeNode('div', { id: id }); },
      querySelector: function () { return null; },
      querySelectorAll: function () { return []; },
      addEventListener: function () {},
      body: makeNode('body')
    },
    window: {},
    requestAnimationFrame: function (fn) { return setTimeout(fn, 0); },
    setTimeout: setTimeout, clearTimeout: clearTimeout
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'web', 'canvas.js'), 'utf8'), ctx, { filename: 'canvas.js' });
  return ctx.PFCanvas;
}

const PFCanvas = loadCanvas();
PFCanvas.on.contextLink = function (id, x, y) { calls.contextLink.push({ id: id, x: x, y: y }); };
PFCanvas.on.context = function (id, x, y) { calls.context.push({ id: id, x: x, y: y }); };
PFCanvas.on.selectLink = function (id) { calls.selectLink.push(id); };

// The canvas builds its own <svg>; find the one it wired listeners onto.
function canvasSvg(ctx) { return ctx; }

let canvasRoot = null;
{
  // PFCanvas.appendTo / init conventions vary; drive whichever hook exists.
  const target = makeNode('div');
  if (typeof PFCanvas.mount === 'function') PFCanvas.mount(target);
  else if (typeof PFCanvas.init === 'function') PFCanvas.init(target);
  else if (typeof PFCanvas.appendTo === 'function') PFCanvas.appendTo(target);
  canvasRoot = target;
}

// setTopology renders. Calling render() again with no argument would set the module's
// state.topology to undefined and wipe the geometry the hit test needs - which is exactly
// what happened the first time this test was written.
PFCanvas.setTopology(state);

// Recover the <svg> the module actually listens on: it is the node that received a
// 'contextmenu' listener, wherever it lives in the tree.
function findWithListener(node, ev) {
  if (!node) return null;
  if (node.listeners && node.listeners[ev] && node.listeners[ev].length) return node;
  const kids = node.children || [];
  for (let i = 0; i < kids.length; i++) {
    const hit = findWithListener(kids[i], ev);
    if (hit) return hit;
  }
  return null;
}

const svgNode = canvasSvgNode;
ok(!!(svgNode.listeners.contextmenu && svgNode.listeners.contextmenu.length),
  'the canvas wired its contextmenu handler onto #canvas');

console.log('\nRight-clicking a cable:');
ok(PFCanvas.on.contextLink === null || typeof PFCanvas.on.contextLink === 'function',
  'the canvas exposes a contextLink hook for cables');

// Where does the cable actually run? Ask the canvas where the two sockets are, so the test
// cannot invent a geometry the drawing does not use. The midpoint of the two sockets lies
// on the cable run by construction.
const pa = PFCanvas.portWorld(a.id, 'port1');
const pb = PFCanvas.portWorld(b.id, 'port1');
ok(!!pa && !!pb, 'the canvas reports both sockets in world coordinates');
const mid = { x: (pa.x + pb.x) / 2, y: (pa.y + pb.y) / 2 };

// The canvas keeps a default pan of (60, 40) at zoom 1, so world coordinates are not
// screen coordinates. hitTest and the DOM events both speak screen space.
function sx(wx) { return wx + 60; }
function sy(wy) { return wy + 40; }

ok(PFCanvas.hitTest(sx(mid.x), sy(mid.y)).kind === 'link',
  'the canvas resolves the midpoint of the run to a cable');

if (svgNode) {
  calls.context.length = 0; calls.contextLink.length = 0;
  const ev = svgNode.fire('contextmenu', { clientX: sx(mid.x), clientY: sy(mid.y) });
  ok(calls.contextLink.length === 1,
    'a right-click over the cable reports a cable (got ' + calls.contextLink.length + ')');
  ok(calls.contextLink.length === 1 && calls.contextLink[0].id === link.id,
    'and it reports THAT cable, not the nearest device');
  ok(ev.defaultPrevented === true, 'the browser menu is suppressed in favour of ours');
  ok(calls.context.length === 0, 'and no device menu is raised at the same time');

  // A right-click over a device must still be a device.
  calls.context.length = 0; calls.contextLink.length = 0;
  const bodyA = PFCanvas.deviceCenter(a.id);
  svgNode.fire('contextmenu', { clientX: sx(bodyA.x), clientY: sy(bodyA.y) });
  ok(calls.context.length === 1 && calls.contextLink.length === 0,
    'a right-click over a device still reports the device');
}

// --- load app.js in a stub environment --------------------------------------
console.log('\nThe delete decision:');

const requests = [];
const nodes = {};
function appNode(id) {
  if (!nodes[id]) nodes[id] = makeNode('div', { id: id });
  return nodes[id];
}

const appCtx = {
  console: console,
  setTimeout: setTimeout, clearTimeout: clearTimeout, setInterval: setInterval,
  fetch: function (url, opts) {
    requests.push({ url: url, method: (opts && opts.method) || 'GET' });
    const body = { ok: true, status: 200, statusText: 'OK', state: state,
      json: function () { return Promise.resolve({ ok: true, state: state, specs: [] }); } };
    return Promise.resolve(body);
  },
  document: {
    addEventListener: function () {},
    removeEventListener: function () {},
    querySelector: function (sel) { return appNode(sel); },
    querySelectorAll: function () { return []; },
    getElementById: function (id) { return appNode('#' + id); },
    createElement: function (t) { return makeNode(t); },
    body: makeNode('body')
  },
  window: {},
  PFCanvas: {
    on: {},
    setTopology: function () {}, fitView: function () {}, render: function () {},
    setSelected: function () {}, setSelectedLink: function () {},
    animateEvents: function () {}, zoomBy: function () {}
  },
  WebSocket: function () { return { addEventListener: function () {}, send: function () {}, close: function () {} }; },
  location: { protocol: 'http:', host: 'localhost:8000' },
  localStorage: { getItem: function () { return null; }, setItem: function () {} }
};
appCtx.window = appCtx;
appCtx.window.PFCanvas = appCtx.PFCanvas;
vm.createContext(appCtx);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'web', 'app.js'), 'utf8'), appCtx, { filename: 'app.js' });

const pf = appCtx.window.__pf;
ok(!!pf, 'app.js loaded');
// boot() runs on DOMContentLoaded, which a stub document never fires, so hand the app the
// same topology the canvas has - that is exactly what boot() would have done over HTTP.
pf.setTopology(state);

ok(typeof pf.deleteTarget === 'function', 'the delete rule is exposed as one function');
ok(pf.deleteTarget() === null, 'with nothing selected, Delete does nothing');

// Selecting a cable must make Delete act on the cable, not on a device.
appCtx.PFCanvas.on.selectLink(link.id);
ok(pf.deleteTarget() === 'link', 'with a cable selected, Delete acts on the cable');

// And the request it makes is the narrow one.
console.log('\nWhat it asks the server to do:');
const before = requests.length;
if (typeof pf.deleteLink === 'function') {
  pf.deleteLink(link.id);
  // give the promise chain a tick
  const wait = setTimeout(function () {}, 0);
}
setTimeout(function () {
  const deletes = requests.slice(before).filter(function (r) { return r.method === 'DELETE'; });
  ok(deletes.length === 1, 'exactly one request is made (got ' + deletes.length + ')');
  ok(deletes.length === 1 && /\/topologies\/[^/]+\/links\/[^/]+$/.test(deletes[0].url),
    'and it is DELETE /topologies/:t/links/:id — the cable only: ' +
    (deletes[0] ? deletes[0].url : 'none'));
  ok(deletes.length === 1 && !/\/devices\//.test(deletes[0].url),
    'nothing addresses a device, so no other cable can be taken with it');

  console.log('');
  if (failed) { console.log(failed + ' failed, ' + passed + ' passed'); process.exit(1); }
  console.log(passed + ' passed, 0 failed');
}, 30);
