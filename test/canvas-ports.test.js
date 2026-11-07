'use strict';
// The canvas must say which socket is which.
//
// Ports used to be anonymous dots: no name, no indication of copper vs fibre, no
// clue what was plugged in. On a 48-port switch every dot looked identical, so the
// drawing was decorative - you could see there were ports but not use them.
//
// This loads the real web/canvas.js against a recording stub DOM and asserts the
// drawing actually carries that information: a label per port, a tooltip naming the
// connector family and rate, and a colour that differs between copper and fibre.
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
    appendChild: function (c) { this.children.push(c); return c; },
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

// --- a device with both copper and fibre, plus a cable --------------------
const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
const router = catalog.find(function (s) { return s.vendor === 'asus' && s.model === 'RT-AX89X'; });
const pcSpec = {
  vendor: 'generic', model: 'generic-pc', label: 'PC', category: 'host',
  capabilities: ['host', 'cli'],
  interfaces: [{ name: 'eth0', type: 'ethernet', speed: '1G' }]
};
const t = new Topology();
const r = t.addDevice(router); r.name = 'R1';
const pc = t.addDevice(pcSpec); pc.name = 'PC1';
t.connect(pc.id, 'eth0', r.id, 'lan3');
PFCanvas.render(JSON.parse(JSON.stringify(t.serialize())));

// --- walk the recorded SVG tree -------------------------------------------
const world = roots.world;
function walk(node, fn) {
  (node.children || []).forEach(function (c) { fn(c); walk(c, fn); });
}
const ports = [], labels = [], titles = [];
for (const devNode of world.children) {
  walk(devNode, function (n) {
    if (n.tag === 'circle' && /(^| )port( |$)/.test(String(n.attrs.class || ''))) ports.push(n);
    if (n.tag === 'text' && String(n.attrs.class || '').indexOf('port-label') !== -1) labels.push(n);
    if (n.tag === 'title') titles.push(n);
  });
}

console.log('\nEvery port is drawn:');
ok(ports.length === r.interfaces.size + pc.interfaces.size,
  'one dot per port across both devices (' + ports.length + ')');

console.log('\nAnd every port says what it is:');
ok(labels.length > 0, 'ports carry a visible name label (' + labels.length + ' labels)');
ok(labels.length === ports.length, 'every port has a label, not just some');
const labelText = labels.map(function (l) { return String(l.textContent); });
ok(labelText.indexOf('lan3') !== -1, 'the cabled port is labelled by its real name (lan3)');
ok(labelText.some(function (s) { return s.indexOf('10g-sfp') === 0; }),
  'and so is the fibre port (10g-sfp)');
// A dual-purpose cage is marked in the label itself, so you can see at a glance that
// it is switchable without opening the inspector.
ok(labelText.some(function (s) { return s.indexOf('10g-sfp') === 0 && s.indexOf('\u21c4') !== -1; }),
  'the dual-purpose 10G cage is marked as switchable (\u21c4)');
ok(titles.length === ports.length, 'every port has a tooltip (' + titles.length + ')');
const tiptext = titles.map(function (x) { return String(x.textContent); }).join('\n');
ok(/lan3 .*cabled to PC1:eth0/.test(tiptext), 'the tooltip says what is plugged in (cabled to PC1:eth0)');
ok(/SC\/APC|SFP\+ cage/.test(tiptext), 'the tooltip names the connector family');
ok(/Mbps/.test(tiptext), 'and the supported line rate');

console.log('\nCopper and fibre are distinguishable at a glance:');
const tints = {};
for (const p of ports) {
  const nm = p.attrs['data-iface'];
  tints[nm] = p.attrs.stroke;
}
const copper = Object.keys(tints).filter(function (k) { return k.indexOf('lan') === 0 || k === 'wan'; });
const fibre = Object.keys(tints).filter(function (k) { return k === '10g-sfp'; });
ok(copper.length > 0 && fibre.length > 0, 'the sample has both families to compare');
ok(copper.every(function (k) { return tints[k] === tints[copper[0]]; }), 'all copper ports share one colour');
ok(fibre.every(function (k) { return tints[k] !== tints[copper[0]]; }),
  'the fibre cage is a different colour from copper (' + tints[fibre[0]] + ' vs ' + tints[copper[0]] + ')');
ok(!!tints['10g-sfp'], 'the fibre port is tinted');

console.log('\nA radio association is not drawn as a cable:');
{
  const t2 = new Topology();
  const ap = t2.addDevice(catalog.find(function (s) { return s.model === 'AP-515'; })); ap.name = 'AP1';
  const ph = t2.addDevice(catalog.find(function (s) { return s.model === 'iPhone 16'; })); ph.name = 'PHONE';
  t2.connect(ph.id, 'wlan0', ap.id, 'radio0');
  PFCanvas.render(JSON.parse(JSON.stringify(t2.serialize())));

  const lines = [];
  walk(roots.world, function (n) {
    if (n.tag === 'line' && String(n.attrs.class || '').indexOf('link') !== -1 &&
        String(n.attrs.class || '').indexOf('link-hit') === -1) lines.push(n);
  });
  ok(lines.length === 1, 'the association is drawn (' + lines.length + ' line)');
  ok(/link-wireless/.test(String(lines[0] && lines[0].attrs.class)),
    'and carries the wireless class, so it renders dashed instead of as a cable');

  // A cable must NOT pick up the wireless class, or the distinction means nothing.
  PFCanvas.render(JSON.parse(JSON.stringify(t.serialize())));
  const wired = [];
  walk(roots.world, function (n) {
    if (n.tag === 'line' && String(n.attrs.class || '').indexOf('link') !== -1 &&
        String(n.attrs.class || '').indexOf('link-hit') === -1) wired.push(n);
  });
  ok(wired.length === 1 && !/link-wireless/.test(String(wired[0].attrs.class)),
    'a copper cable is still drawn as a cable');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
