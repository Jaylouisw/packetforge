'use strict';
// A cable must be completable with the mouse (issue #61).
//
// The complaint: "Cannot create any link: the ghost cable follows the cursor and swallows
// the click on the destination port."
//
// Root cause was not the ghost line being drawn - it was that the canvas decided what the
// mouse had hit from `e.target`, i.e. from whatever the browser had painted last at that
// pixel. The rubber band ends exactly at the pointer by definition, so for the whole drag
// it was the topmost element under the cursor: the press landed on the ghost, the canvas
// found no port in the target chain, fell through to "background" and started a pan. The
// destination port was never asked. No link could be completed by mouse, at all.
//
// This loads the real web/canvas.js against a recording stub DOM, drives real
// pointerdown/pointermove/pointerup events at the exact coordinates of a port, and asserts
// what actually happened: which callback ran, and what the topology contains afterwards.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { Topology } = require('../engine');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg); }
}

// --- stub DOM that records listeners and can be driven ----------------------
const VIEW = { width: 900, height: 700 };

function makeNode(name, attrs) {
  const node = {
    tag: name,
    attrs: attrs || {},
    children: [],
    textContent: '',
    style: {},
    parentNode: null,
    _ev: {},
    appendChild: function (c) {
      const at = this.children.indexOf(c);
      if (at !== -1) this.children.splice(at, 1);       // appendChild moves a node
      c.parentNode = this;
      this.children.push(c);
      return c;
    },
    removeChild: function (c) {
      const at = this.children.indexOf(c);
      if (at !== -1) this.children.splice(at, 1);
      c.parentNode = null;
      return c;
    },
    remove: function () { if (this.parentNode) this.parentNode.removeChild(this); },
    setAttribute: function (k, v) { this.attrs[k] = v; },
    getAttribute: function (k) { return this.attrs[k]; },
    addEventListener: function (t, fn) {
      (this._ev[t] = this._ev[t] || []).push(fn);
    },
    removeEventListener: function () {},
    setPointerCapture: function () {},
    releasePointerCapture: function () {},
    getBoundingClientRect: function () {
      return { left: 0, top: 0, width: VIEW.width, height: VIEW.height,
        right: VIEW.width, bottom: VIEW.height };
    },
    classList: {
      add: function () {}, remove: function () {}, toggle: function () {},
      contains: function () { return false; }
    },
    querySelector: function () { return null; },
    querySelectorAll: function () { return []; },
    set innerHTML(v) { this.children.length = 0; },
    get innerHTML() { return ''; }
  };
  return node;
}

const roots = {};
['canvas', 'world', 'packets', 'overlay'].forEach(function (id) { roots[id] = makeNode('g', { id: id }); });

const sandbox = {
  console: console,
  document: {
    getElementById: function (id) { return roots[id] || makeNode('div'); },
    createElementNS: function (ns, name) { return makeNode(name, {}); },
    createElement: function (name) { return makeNode(name, {}); },
    addEventListener: function () {},
    querySelector: function () { return null; },
    querySelectorAll: function () { return []; },
    body: makeNode('body')
  },
  window: {},
  setTimeout: function () { return 0; },
  clearTimeout: function () {},
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

ok(!!PFCanvas && typeof PFCanvas.render === 'function', 'canvas.js loads and exposes PFCanvas.render');

// --- drive the real event handlers ----------------------------------------
// `visualTarget` is the element the browser *would* report as e.target - normally the
// topmost painted thing at that pixel, which during a drag is the ghost cable itself.
function fire(type, x, y, visualTarget) {
  const fns = (roots.canvas._ev[type] || []).slice();
  let stopped = false;
  const e = {
    clientX: x, clientY: y, pointerId: 1,
    target: visualTarget || roots.canvas,
    preventDefault: function () {},
    stopPropagation: function () { stopped = true; }
  };
  fns.forEach(function (fn) { fn(e); });
  return { stopped: stopped, handlers: fns.length };
}

function walk(node, fn) {
  (node.children || []).forEach(function (c) { fn(c); walk(c, fn); });
}

// The module's default view (see fit-view.test.js): zoom 1, pan (60, 40).
const PAN = { x: 60, y: 40, zoom: 1 };
function sx(wx) { return wx * PAN.zoom + PAN.x; }
function sy(wy) { return wy * PAN.zoom + PAN.y; }

// --- a board with two one-port hosts --------------------------------------
function hostSpec() {
  return {
    vendor: 'generic', model: 'generic-pc', label: 'PC', category: 'host',
    capabilities: ['host', 'cli'],
    interfaces: [{ name: 'eth0', type: 'ethernet', speed: '1G' }]
  };
}

const topo = new Topology();
const A = topo.addDevice(hostSpec()); A.name = 'A';
const B = topo.addDevice(hostSpec()); B.name = 'B';
const LAYOUT = {};
LAYOUT[A.id] = { x: 80, y: 80 };
LAYOUT[B.id] = { x: 520, y: 300 };
// The layout travels with the topology, so every redraw keeps the sockets where the
// pointer is aiming. (A redraw with a different layout would move the targets out from
// under the test - and out from under the user, which is why app.js keeps topo.layout.)
function topologyJson() {
  const json = JSON.parse(JSON.stringify(topo.serialize()));
  json.layout = json.layout || {};
  Object.keys(LAYOUT).forEach(function (id) { json.layout[id] = LAYOUT[id]; });
  return json;
}
PFCanvas.render(topologyJson());

const aPort = PFCanvas.portWorld(A.id, 'eth0');
const bPort = PFCanvas.portWorld(B.id, 'eth0');
ok(!!aPort && !!bPort && aPort.x !== bPort.x,
  'both sockets have a position on the drawing (' + JSON.stringify([aPort, bPort]) + ')');

// --- the callback app.js installs -----------------------------------------
// app.js's PFCanvas.on.portClick is the ONE path that makes a cable: with no pending
// connection it starts one, with a pending connection it completes it. The canvas's job
// is to deliver every port click - first or second - to that same callback. That is the
// contract asserted here; the stand-in below implements exactly those two branches and,
// for the completion branch, really does add the link to the topology.
const calls = [];
PFCanvas.on.portClick = function (deviceId, iface) {
  calls.push({ deviceId: deviceId, iface: iface, pending: PFCanvas.getConnecting() });
  const c = PFCanvas.getConnecting();
  if (!c) { PFCanvas.setConnecting({ deviceId: deviceId, iface: iface }); return; }
  if (c.deviceId === deviceId) { PFCanvas.setConnecting(null); return; }
  topo.connect(c.deviceId, c.iface, deviceId, iface);
  PFCanvas.setConnecting(null);
  PFCanvas.setTopology(topologyJson());
};

let selected = [], selectedLink = [];
PFCanvas.on.select = function (id) { selected.push(id); };
PFCanvas.on.selectLink = function (id) { selectedLink.push(id); };
let cancels = 0;
PFCanvas.on.connectCancel = function () { cancels++; };

function ghostEl() {
  let found = null;
  walk(roots.overlay, function (n) { if (String(n.attrs.class || '').indexOf('link-ghost') !== -1) found = n; });
  return found;
}

console.log('');
console.log('The rubber band follows the cursor:');
{
  // First click: on A's socket. Nothing is pending, so this starts a cable.
  fire('pointerdown', sx(aPort.x), sy(aPort.y));
  ok(calls.length === 1 && calls[0].deviceId === A.id && calls[0].iface === 'eth0',
    'the first port click starts a cable on that socket (' + JSON.stringify(calls[0] && calls[0].iface) + ')');
  ok(!!PFCanvas.getConnecting(), 'and the canvas is now connecting');

  const ghost = ghostEl();
  ok(!!ghost, 'a ghost cable is drawn in the overlay');

  fire('pointermove', sx(bPort.x), sy(bPort.y));
  const g2 = ghostEl();
  ok(!!g2, 'the ghost cable is still there while the pointer moves');
  ok(g2 && Math.abs(Number(g2.attrs.x2) - bPort.x) < 0.001 &&
           Math.abs(Number(g2.attrs.y2) - bPort.y) < 0.001,
    'and it ends exactly under the cursor, on the destination socket (' +
    (g2 && (g2.attrs.x2 + ',' + g2.attrs.y2)) + ')');

  // The bug, stated as a fact: the ghost really is the thing under the pointer.
  ok(g2 && g2.attrs['pointer-events'] === 'none',
    'the ghost is pointer-events:none, so the browser cannot make it the target either');
  const css = fs.readFileSync(path.join(__dirname, '..', 'web', 'style.css'), 'utf8');
  const rule = /\.link-ghost\s*\{[^}]*pointer-events:\s*none/.test(css);
  ok(rule, 'and style.css says the same thing (.link-ghost { ... pointer-events: none })');
}

console.log('');
console.log('The click on the destination socket reaches the port, not the ghost:');
{
  // This is issue #61 reproduced literally: the press is delivered with the ghost cable
  // as e.target, exactly as the browser did before the fix.
  const ghost = ghostEl();
  const before = calls.length;
  fire('pointerdown', sx(bPort.x), sy(bPort.y), ghost);

  ok(calls.length === before + 1, 'exactly one port callback ran for the press');
  const c = calls[calls.length - 1];
  ok(c && c.deviceId === B.id && c.iface === 'eth0',
    'and it was the destination socket (' + (c && (c.deviceId + '/' + c.iface)) + ')');
  ok(c && c.pending && c.pending.deviceId === A.id,
    'with the first socket still pending, so the handler can see it is completing a link');

  // Observable result: the cable exists.
  const json = JSON.parse(JSON.stringify(topo.serialize()));
  ok(json.links.length === 1, 'the topology now contains one cable (' + json.links.length + ')');
  const l = json.links[0];
  ok(l && ((l.a.deviceId === A.id && l.b.deviceId === B.id) || (l.a.deviceId === B.id && l.b.deviceId === A.id)),
    'between exactly the two sockets that were clicked');
  ok(PFCanvas.getConnecting() === null, 'and the canvas is no longer connecting');
  ok(selected.length === 0,
    'nothing selected a device on the way (the press was never treated as a background click)');

  // The click must not have started a pan either: releasing it here must not deselect.
  fire('pointerup', sx(bPort.x), sy(bPort.y));
  ok(selected.length === 0, 'releasing over the socket does not deselect anything');
}

console.log('');
console.log('The ghost cable is not a hit target on its own account:');
{
  // Mid-drag, over empty space, with the rubber band passing through that very point:
  // the hit test must answer "background", never "ghost".
  fire('pointerdown', sx(bPort.x), sy(bPort.y));       // starts a cable from B
  ok(!!PFCanvas.getConnecting(), 'a ghost cable is being dragged from B');
  const over = { x: 700, y: 120 };                     // empty canvas, no cable, no device
  fire('pointermove', sx(over.x), sy(over.y));
  const ghost = ghostEl();
  ok(ghost && Math.abs(Number(ghost.attrs.x2) - over.x) < 0.001,
    'the rubber band is drawn through that point (' + (ghost && ghost.attrs.x2) + ')');
  const hit = PFCanvas.hitTest(sx(over.x), sy(over.y));
  ok(hit && hit.kind === 'background',
    'a press there is background, not the ghost (' + (hit && hit.kind) + ')');
  ok(hit && hit.kind !== 'link' && hit.kind !== 'port',
    'and nothing was invented underneath it either');

  const kinds = {};
  for (let gx = 0; gx <= VIEW.width; gx += 13) {
    for (let gy = 0; gy <= VIEW.height; gy += 13) {
      const h = PFCanvas.hitTest(gx, gy);
      kinds[h.kind] = true;
    }
  }
  const allowed = ['port', 'device', 'link', 'background'];
  const extra = Object.keys(kinds).filter(function (k) { return allowed.indexOf(k) === -1; });
  ok(extra.length === 0,
    'across the whole canvas the hit test only ever answers port/device/link/background' +
    (extra.length ? ' (saw ' + extra.join(', ') + ')' : ''));
}

console.log('');
console.log('An empty-canvas click abandons the drag:');
{
  const c0 = cancels;
  const s0 = selected.length;
  const empty = { x: 860, y: 660 };
  fire('pointerdown', sx(empty.x), sy(empty.y));
  fire('pointerup', sx(empty.x), sy(empty.y));
  ok(PFCanvas.getConnecting() === null, 'the pending cable is gone');
  ok(cancels === c0 + 1, 'the cancel callback ran, so the UI can drop its prompt');
  ok(selected.length === s0, 'and the click was not spent on deselecting instead');
  ok(!ghostEl(), 'the ghost cable was erased with it');
}

console.log('');
console.log('A click on a device body during a drag selects the device:');
{
  // Start again from A, then press the middle of B's chassis - nowhere near a socket.
  fire('pointerdown', sx(aPort.x), sy(aPort.y));
  ok(!!PFCanvas.getConnecting(), 'a cable is in flight again');

  const bodyX = B && PFCanvas.portWorld(B.id, 'eth0').x - 60;
  const bodyY = PFCanvas.portWorld(B.id, 'eth0').y;
  const before = calls.length;
  selected = [];
  fire('pointerdown', sx(bodyX), sy(bodyY));
  ok(selected.length === 1 && selected[0] === B.id,
    'the press selected the device under it (' + selected.join(',') + ')');
  ok(calls.length === before, 'it did not start or complete a cable');
  ok(!!PFCanvas.getConnecting(), 'and the cable in flight is untouched');

  fire('pointerup', sx(bodyX), sy(bodyY));
  const json = JSON.parse(JSON.stringify(topo.serialize()));
  ok(json.links.length === 1, 'releasing without moving added no cable (' + json.links.length + ' link)');
}

console.log('');
console.log('A press on empty canvas with nothing pending still deselects:');
{
  PFCanvas.setConnecting(null);
  selected = [];
  const empty = { x: 860, y: 660 };
  fire('pointerdown', sx(empty.x), sy(empty.y));
  fire('pointerup', sx(empty.x), sy(empty.y));
  ok(selected.length === 1 && selected[0] === null,
    'the normal deselect-on-background click is unchanged (' + JSON.stringify(selected) + ')');
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
