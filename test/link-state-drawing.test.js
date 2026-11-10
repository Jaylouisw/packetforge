#!/usr/bin/env node
/**
 * A cut cable has to look cut.
 *
 * The canvas drew every cable the same way whatever its state, so a lab with a failed link looked
 * exactly like a lab where everything worked - which is the one thing a diagram of a broken network
 * must never do. This drives the real renderer against a DOM stub and asserts the drawing says so,
 * and that the stylesheet actually carries the rule the class depends on.
 */
'use strict';

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

function rec(name, attrs) {
  return {
    tag: name, attrs: attrs || {}, children: [], textContent: '', style: {}, parentNode: null,
    appendChild: function (c) {
      const at = this.children.indexOf(c);
      if (at !== -1) this.children.splice(at, 1);
      c.parentNode = this;
      this.children.push(c);
      return c;
    },
    setAttribute: function (k, v) { this.attrs[k] = v; },
    getAttribute: function (k) { return this.attrs[k]; },
    addEventListener: function () {}, removeEventListener: function () {},
    classList: { add: function () {}, remove: function () {}, toggle: function () {}, contains: function () { return false; } },
    querySelector: function () { return null; }, querySelectorAll: function () { return []; },
    set innerHTML(v) { this.children.length = 0; }, get innerHTML() { return ''; }
  };
}

// A fresh sandbox per render: the renderer captures its layer node when it loads, so reusing one
// context between renders means drawing into a node the next test cannot reach.
function makeCanvas() {
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
  return { PFCanvas: sandbox.window.PFCanvas || sandbox.PFCanvas, roots: roots };
}

const boot = makeCanvas();
ok(!!boot.PFCanvas && typeof boot.PFCanvas.render === 'function',
  'canvas.js loads and exposes render()');

const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));

function walk(node, fn) {
  (node.children || []).forEach(function (c) { fn(c); walk(c, fn); });
}

// One board, one cable, drawn, with the cable's state whatever we ask for.
function draw(linkState, extra) {
  const { PFCanvas, roots } = makeCanvas();
  const t = new Topology();
  // Specs declare type/connector; the cage is derived by Device, so select on the spec and
  // resolve the cage on the instantiated device.
  const spec = catalog.find(function (s) {
    return s.category === 'switch' &&
      (s.interfaces || []).some(function (i) {
        return i.type === 'ethernet' && (!i.connector || String(i.connector).toLowerCase() === 'rj45');
      });
  });
  const a = t.addDevice(spec), b = t.addDevice(spec);
  const pa = [...a.interfaces.values()].find(function (i) { return i.hardware.cage === 'rj45'; });
  const pb = [...b.interfaces.values()].find(function (i) { return i.hardware.cage === 'rj45'; });
  const link = t.connect(a.id, pa.name, b.id, pb.name, { mediaId: '1000base-t' });
  if (linkState) link.state = linkState;

  // Rendered from the serialised form, which is what the browser actually receives - and which is
  // where a state field silently went missing once already. `extra` is what fullState() adds on top
  // of the saved file (carries, stateReason); a browser gets those, so a drawing test that omits
  // them would be testing a payload nothing sends.
  const payload = JSON.parse(JSON.stringify(t.serialize()));
  if (extra) Object.assign(payload.links[0], extra);
  PFCanvas.render(payload);

  const lines = [], hits = [];
  walk(roots.world, function (n) {
    if (n.tag !== 'line' || !n.attrs['data-link-id']) return;
    // The 16 px transparent grab band carries the same data-link-id as the cable it covers, so it
    // has to be told apart or the test inspects the hit area and calls it the drawing.
    const cls = String(n.attrs.class || '');
    if (/\blink-hit\b/.test(cls)) hits.push(n);
    else lines.push(n);
  });
  return { lines: lines, hits: hits, link: link };
}

console.log('\nA working cable is drawn as a working cable');
{
  const d = draw('up');
  ok(d.lines.length === 1, 'the cable is drawn (' + d.lines.length + ' drawn line)');
  ok(d.hits.length === 1, 'with its clickable band');
  const line = d.lines[0];
  ok(!/\blink-down\b/.test(String(line.attrs.class || '')), 'with no dead-cable class');
  ok(line.attrs['data-link-state'] === 'up', 'and says it is up');
}

console.log('\nA cable that is down says so in the drawing');
{
  const d = draw('down');
  ok(d.lines.length === 1, 'the cable is still drawn - a failed link is not a removed one');
  ok(d.hits.length === 1, 'and is still clickable');
  const line = d.lines[0];
  ok(/\blink-down\b/.test(String(line.attrs.class || '')), 'marked as down');
  ok(line.attrs['data-link-state'] === 'down', 'and its state is readable from the DOM');
  // The family class must survive, or the plant stops being readable from the drawing.
  ok(/\blink-copper\b/.test(String(line.attrs.class || '')), 'without losing its medium class');
}

console.log('\nA cable with a disabled port at one end is not drawn as a working one either');
{
  // The cable itself is up - nobody pulled it - and the drawing used to be identical to a working
  // one, which is how a board showed a shut port carrying traffic.
  const d = draw('up', { carries: false, stateReason: 'SW1/Fa0/1 is administratively down' });
  const line = d.lines[0];
  ok(/\blink-down\b/.test(String(line.attrs.class || '')), 'the cable is marked as not carrying');
  ok(line.attrs['data-link-state'] === 'up', 'while the cable itself still reads up');
  ok(line.attrs['data-carries'] === 'no', 'and the DOM says plainly that it carries nothing');
  ok(String(line.attrs['data-state-reason']).indexOf('administratively down') !== -1,
    'with the reason attached, so a test or a tooltip can say which end');
  ok(/\blink-copper\b/.test(String(line.attrs.class || '')), 'without losing its medium class');

  const good = draw('up', { carries: true });
  ok(!/\blink-down\b/.test(String(good.lines[0].attrs.class || '')), 'a carrying cable is not marked');
  ok(good.lines[0].attrs['data-carries'] === 'yes', 'and says so');

  // The conservative case: a payload from before the field existed. Nothing crosses is not the same
  // claim as nothing is known, and dashing on a guess would put a fault on the board that nobody
  // reported.
  const old = draw('up');
  ok(!/\blink-down\b/.test(String(old.lines[0].attrs.class || '')), 'an unlabelled payload draws as before');
  ok(old.lines[0].attrs['data-carries'] === 'unknown', 'and admits the state is unknown');
}

console.log('\nThe class is not decorative: the stylesheet makes it visible');
{
  const css = fs.readFileSync(path.join(__dirname, '..', 'web', 'style.css'), 'utf8');
  const rule = css.split('\n').filter(function (l) { return /\.link\.link-down\b/.test(l); }).join('\n');
  ok(rule.length > 0, 'there is a rule for .link.link-down');
  ok(/dasharray/.test(rule), 'it dashes the cable');
  ok(/red|--red|#[0-9a-f]{3,6}/i.test(rule), 'and recolours it');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
