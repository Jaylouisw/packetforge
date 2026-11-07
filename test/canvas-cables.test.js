'use strict';
// The canvas must draw the plant, not just some lines (issue #34).
//
// Copper, fibre, a DAC, an AOC, a PON drop, coax, a phone line and a mains adapter all
// rendered as the same 2 px grey line: the only distinction the drawing had was
// wireless-versus-not. And links were appended before the devices, so any cable passing
// under a chassis was erased for that span and the drawing showed two disconnected stubs.
//
// This loads the real web/canvas.js against a recording stub DOM and asserts that each
// medium is identifiable from the drawing alone, and that a cable is continuous from
// socket to socket.
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

// --- recording stub DOM ----------------------------------------------------
function rec(name, attrs) {
  return {
    tag: name,
    attrs: attrs || {},
    children: [],
    textContent: '',
    style: {},
    parentNode: null,
    appendChild: function (c) {
      const at = this.children.indexOf(c);
      if (at !== -1) this.children.splice(at, 1);   // appendChild moves a node
      c.parentNode = this;
      this.children.push(c);
      return c;
    },
    setAttribute: function (k, v) { this.attrs[k] = v; },
    getAttribute: function (k) { return this.attrs[k]; },
    addEventListener: function () {},
    removeEventListener: function () {},
    classList: { add: function () {}, remove: function () {}, toggle: function () {}, contains: function () { return false; } },
    querySelector: function () { return null; },
    querySelectorAll: function () { return []; },
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
sandbox.document.createElementNS = function (ns, t) { return rec(t); };

vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'web', 'canvas.js'), 'utf8'),
  sandbox, { filename: 'canvas.js' });
const PFCanvas = sandbox.window.PFCanvas || sandbox.PFCanvas;

ok(!!PFCanvas && typeof PFCanvas.render === 'function', 'canvas.js loads and exposes render()');

const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));

function walk(node, fn) {
  (node.children || []).forEach(function (c) { fn(c); walk(c, fn); });
}

// A board with one cable, rendered, returning the drawn cable lines.
function drawWith(mediaId, pickPair) {
  const t = new Topology();
  const pair = pickPair(t);
  t.connect(pair.a.id, pair.aIface, pair.b.id, pair.bIface, { mediaId: mediaId });
  PFCanvas.render(JSON.parse(JSON.stringify(t.serialize())));
  const lines = [];
  walk(roots.world, function (n) { if (n.tag === 'line' && n.attrs['data-link-id']) lines.push(n); });
  return lines;
}

function twoSfpSwitches(t) {
  const spec = catalog.find(function (s) {
    return s.category === 'switch' &&
      (s.interfaces || []).some(function (i) { return i.connector === 'sfp+'; });
  });
  const a = t.addDevice(spec), b = t.addDevice(spec);
  const pa = [...a.interfaces.values()].find(function (i) { return i.hardware.cage === 'sfp+'; });
  const pb = [...b.interfaces.values()].find(function (i) { return i.hardware.cage === 'sfp+'; });
  return { a: a, b: b, aIface: pa.name, bIface: pb.name };
}

function twoCopperEndpoints(t) {
  // Specs declare type/connector; the cage is derived by Device. So select on the spec,
  // then resolve the cage on the instantiated device.
  const spec = catalog.find(function (s) {
    return s.category === 'switch' &&
      (s.interfaces || []).some(function (i) {
        return i.type === 'ethernet' && (!i.connector || String(i.connector).toLowerCase() === 'rj45');
      });
  });
  const a = t.addDevice(spec), b = t.addDevice(spec);
  const pa = [...a.interfaces.values()].find(function (i) { return i.hardware.cage === 'rj45'; });
  const pb = [...b.interfaces.values()].find(function (i) { return i.hardware.cage === 'rj45'; });
  return { a: a, b: b, aIface: pa.name, bIface: pb.name };
}

function wirelessPair(t) {
  const ap = catalog.find(function (s) {
    return s.category === 'wireless' && (s.interfaces || []).some(function (i) { return i.type === 'wireless'; });
  });
  const phone = catalog.find(function (s) {
    return s.category === 'phone' && (s.interfaces || []).some(function (i) { return i.type === 'wireless'; });
  });
  const a = t.addDevice(ap), b = t.addDevice(phone);
  const pa = [...a.interfaces.values()].find(function (i) { return i.type === 'wireless'; });
  const pb = [...b.interfaces.values()].find(function (i) { return i.type === 'wireless'; });
  return { a: a, b: b, aIface: pa.name, bIface: pb.name };
}

console.log('');
console.log('Each medium is identifiable from the drawing:');
const expectations = [
  ['dac-10g', twoSfpSwitches, 'dac'],
  ['1000base-sx', twoSfpSwitches, 'fiber'],
  ['1000base-t', twoCopperEndpoints, 'copper'],
  ['wireless-5', wirelessPair, 'wireless']
];
const seen = [];
for (const row of expectations) {
  const lines = drawWith(row[0], row[1]);
  const line = lines.filter(function (l) { return String(l.attrs.class).indexOf('link-hit') === -1; })[0];
  ok(!!line, row[0] + ': a cable line is drawn');
  if (!line) continue;
  const cls = String(line.attrs.class || '');
  ok(cls.indexOf('link-' + row[2]) !== -1, row[0] + ' draws as link-' + row[2] + ' (' + cls.trim() + ')');
  ok(line.attrs['data-medium'] === row[2], row[0] + ' records its medium (' + line.attrs['data-medium'] + ')');
  ok(line.attrs['data-media-id'] === row[0], 'and keeps the exact media id');
  seen.push(cls);
}

console.log('');
console.log('Different media do not look the same:');
{
  const distinct = new Set(seen.map(function (c) { return String(c).replace(/\s+(selected|link-media)/g, '').trim(); }));
  ok(distinct.size === expectations.length,
    expectations.length + ' media produce ' + distinct.size + ' distinct classes');
}

console.log('');
console.log('The stylesheet gives each family its own stroke:');
{
  const css = fs.readFileSync(path.join(__dirname, '..', 'web', 'style.css'), 'utf8');
  const families = ['copper', 'fiber', 'dac', 'aoc', 'pon', 'coax', 'dsl', 'powerline', 'wireless'];
  const missing = families.filter(function (f) {
    return !new RegExp('\\.link\\.link-' + f + '\\s*\\{[^}]*stroke:').test(css);
  });
  ok(missing.length === 0, 'every family has a stroke rule' + (missing.length ? ' (missing: ' + missing.join(', ') + ')' : ''));
  const colours = families.map(function (f) {
    const m = css.match(new RegExp('\\.link\\.link-' + f + '\\s*\\{[^}]*stroke:\\s*([^;]+);'));
    return m ? m[1].trim() : null;
  });
  ok(new Set(colours.filter(Boolean)).size >= 8,
    'at least eight of them are distinguishable colours (' + new Set(colours.filter(Boolean)).size + ')');
}

console.log('');
console.log('A cable is drawn above the chassis it passes:');
{
  const lines = drawWith('dac-10g', twoSfpSwitches);
  const line = lines.filter(function (l) { return String(l.attrs.class).indexOf('link-hit') === -1; })[0];
  const order = roots.world.children;
  const lineAt = order.indexOf(line);
  ok(lineAt !== -1, 'the cable is a direct child of the drawing surface');
  const deviceNodes = order.filter(function (n) {
    return String(n.attrs && n.attrs.class || '').indexOf('device') !== -1;
  });
  ok(deviceNodes.length > 0, 'there are device groups to compare against (' + deviceNodes.length + ')');
  const lastDevice = Math.max.apply(null, deviceNodes.map(function (n) { return order.indexOf(n); }));
  ok(lineAt > lastDevice,
    'the cable sits after every device, so a run under a chassis stays continuous (' +
    lineAt + ' > ' + lastDevice + ')');
}

console.log('');
console.log('The clickable hit target survives the reorder:');
{
  const lines = drawWith('1000base-t', twoCopperEndpoints);
  const hit = lines.filter(function (l) { return String(l.attrs.class).indexOf('link-hit') !== -1; })[0];
  ok(!!hit, 'a hit line still exists for a 2 px cable');
  ok(hit && hit.attrs['data-link-id'], 'and it carries the link id for selection');
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
