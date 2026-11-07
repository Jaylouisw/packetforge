'use strict';
// A redraw must never leave the canvas blank.
//
// Issue #20: editing a hostname blanked the whole lab. The topology was fine on the
// server (a reload restored it) but the canvas stayed empty, and the WebSocket handler
// disposed of the exception with a bare `catch (e) {}`, so there was no console line, no
// toast and no status message. The cause was structural: render() cleared the drawing
// surface and only then drew, so any throw after the clear destroyed the picture.
//
// This loads the real web/canvas.js against a stub DOM and asserts the two guarantees
// that replace it:
//   - one malformed item is skipped and reported, everything else still draws
//   - if the frame cannot be completed, the previous drawing is restored
// It needs no engine, so it keeps working while other lanes touch the simulator.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg); }
}

// --- stub DOM that remembers what was put in it -----------------------------
function rec(name, attrs) {
  const node = {
    tag: name,
    attrs: attrs || {},
    children: [],
    textContent: '',
    style: {},
    _html: '',
    appendChild: function (c) { this.children.push(c); return c; },
    setAttribute: function (k, v) { this.attrs[k] = v; },
    getAttribute: function (k) { return this.attrs[k]; },
    addEventListener: function () {},
    removeEventListener: function () {},
    classList: { add: function () {}, remove: function () {}, toggle: function () {}, contains: function () { return false; } },
    querySelector: function () { return null; },
    querySelectorAll: function () { return []; }
  };
  Object.defineProperty(node, 'innerHTML', {
    get: function () { return this._html; },
    set: function (v) { this._html = String(v); this.children.length = 0; }
  });
  return node;
}

const roots = {};
['canvas', 'world', 'packets', 'overlay'].forEach(function (id) { roots[id] = rec('g', { id: id }); });

const sandbox = {
  console: { log: function () {}, error: function () {}, warn: function () {} },
  document: {
    getElementById: function (id) { return roots[id] || rec('div'); },
    createElementNS: function (ns, name) { return rec(name, {}); },
    createElement: function (name) { return rec(name, {}); },
    addEventListener: function () {},
    querySelector: function () { return null; },
    querySelectorAll: function () { return []; },
    body: rec('body')
  },
  window: {},
  requestAnimationFrame: function () { return 0; },
  performance: { now: function () { return 0; } },
  setTimeout: setTimeout, clearTimeout: clearTimeout
};
sandbox.window.window = sandbox.window;
sandbox.globalThis = sandbox;

const src = fs.readFileSync(path.join(__dirname, '..', 'web', 'canvas.js'), 'utf8');
vm.createContext(sandbox);
vm.runInContext(src, sandbox, { filename: 'canvas.js' });
const PFCanvas = sandbox.window.PFCanvas || sandbox.PFCanvas;

ok(!!PFCanvas && typeof PFCanvas.render === 'function', 'canvas.js loads and exposes PFCanvas.render');
ok(!!PFCanvas.on && 'renderError' in PFCanvas.on, 'the canvas exposes a renderError callback');

function goodDevice(id, name, ports) {
  return {
    id: id, name: name, vendor: 'generic', model: 'probe', label: name,
    category: 'switch', color: '#3f7cff',
    interfaces: (ports || ['eth1', 'eth2']).map(function (p) {
      return { name: p, type: 'ethernet', speed: '1G', cage: 'rj45', enabled: true };
    })
  };
}

function topo(devices, links) {
  return { devices: devices, links: links || [], layout: {} };
}

// ---------------------------------------------------------------------------
console.log('\nOne malformed device does not take out the drawing:');
{
  let reported = null;
  PFCanvas.on.renderError = function (failures, fatal) { reported = { failures: failures, fatal: fatal }; };

  // A null entry in the port list is a genuine layout failure, unlike a missing list
  // (which the canvas now tolerates by treating it as no ports).
  const bad = { id: 'd-bad', name: 'broken', vendor: 'x', model: 'y', category: 'switch', interfaces: [null] };
  PFCanvas.render(topo([goodDevice('d1', 'sw1'), bad, goodDevice('d2', 'sw2')]));

  ok(!!reported, 'the failure is reported rather than swallowed');
  ok(reported && !reported.fatal, 'it is reported as a partial failure, not a fatal one');
  ok(reported && reported.failures.length === 1, 'exactly one item is named as undrawable (' +
    (reported ? reported.failures.length : 'none') + ')');
  ok(reported && reported.failures[0].id === 'd-bad', 'the report names the offending device');
  ok(reported && typeof reported.failures[0].message === 'string' && reported.failures[0].message.length > 0,
    'and carries a message');
  ok(roots.world.children.length > 0, 'the healthy devices were still drawn (' + roots.world.children.length + ' nodes)');
}

// ---------------------------------------------------------------------------
console.log('\nA frame that cannot be completed restores what was there before:');
{
  let reported = null;
  PFCanvas.on.renderError = function (failures, fatal) { reported = { failures: failures, fatal: fatal }; };

  // Whatever was on screen before the attempt, marked so it can be recognised.
  roots.world.innerHTML = '<previous-drawing/>';
  roots.overlay.innerHTML = '<previous-overlay/>';

  // A device whose id cannot even be read throws inside the layout pass, which is the
  // shape of failure that used to leave the surface cleared.
  const hostile = {
    get id() { throw new Error('id exploded'); },
    name: 'hostile', vendor: 'x', model: 'y', category: 'switch', interfaces: []
  };
  let threw = null;
  try {
    PFCanvas.render(topo([hostile]));
  } catch (e) { threw = e; }

  ok(threw === null, 'render() does not re-throw at the caller');
  ok(reported && !!reported.fatal, 'the failure is reported as fatal (the error object is passed through)');
  ok(roots.world.innerHTML === '<previous-drawing/>', 'the previous drawing was put back, not left blank');
  ok(roots.overlay.innerHTML === '<previous-overlay/>', 'and so was the overlay');
}

// ---------------------------------------------------------------------------
console.log('\nOdd topologies are tolerated:');
{
  PFCanvas.on.renderError = function () {};
  let threw = null;
  try {
    PFCanvas.render({ devices: undefined, links: undefined });
    PFCanvas.render(null);
    PFCanvas.render(topo([goodDevice('d3', 'sw3')], [
      { id: 'l1', a: { deviceId: 'd3', iface: 'eth1' }, b: { deviceId: 'missing', iface: 'eth1' } }
    ]));
  } catch (e) { threw = e; }
  ok(threw === null, 'a missing device list, a null topology and a dangling link all survive');
}

// ---------------------------------------------------------------------------
console.log('\nA reporting callback that throws cannot break the render:');
{
  PFCanvas.on.renderError = function () { throw new Error('reporter exploded'); };
  let threw = null;
  try {
    PFCanvas.render(topo([{ id: 'd9', name: 'bad', vendor: 'x', model: 'y', category: 'switch', interfaces: 42 }]));
  } catch (e) { threw = e; }
  ok(threw === null, 'the canvas survives a misbehaving error handler');
  PFCanvas.on.renderError = null;
  let threw2 = null;
  try { PFCanvas.render(topo([{ id: 'd10', name: 'bad', vendor: 'x', model: 'y', category: 'switch', interfaces: 42 }])); }
  catch (e) { threw2 = e; }
  ok(threw2 === null, 'and survives having no handler at all');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
