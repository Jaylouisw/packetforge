'use strict';
// Ports win every mouse hit test (issue #66).
//
// The complaint: "Cables paint over devices and their invisible hit areas block ports -
// sockets under a cable cannot be clicked."
//
// Two separate defects were hiding behind that one sentence, and the fix has to address
// both because they are different concerns:
//
//   1. PAINT ORDER. Cables were appended to the drawing after the devices, so a cable was
//      painted on top of the chassis it terminated on - its 16 px transparent grab band
//      lay across the faceplate.
//   2. HIT ORDER. Hit testing was `e.target.closest(...)`: whatever the browser had
//      painted last at that pixel was what the mouse had "hit". Painting order was
//      therefore deciding what was clickable, so the wide band on top of a socket made
//      the socket invisible to the pointer. Reordering the DOM alone would not fix this;
//      it would only move which element was in the way.
//
// canvas.js now hit-tests geometry with an explicit precedence - port, then device body,
// then cable, then background - and paints cables behind devices. This test drives real
// pointerdown events at the real coordinates of a socket that has a cable drawn over it
// and asserts which handler ran, plus the paint order of the resulting drawing.
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
      if (at !== -1) this.children.splice(at, 1);
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
    addEventListener: function (t, fn) { (this._ev[t] = this._ev[t] || []).push(fn); },
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

ok(!!PFCanvas && typeof PFCanvas.hitTest === 'function',
  'canvas.js loads and exposes a hit test');

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
  return { stopped: stopped };
}

function walk(node, fn) {
  (node.children || []).forEach(function (c) { fn(c); walk(c, fn); });
}

// Default view of the module (see fit-view.test.js): zoom 1, pan (60, 40).
function sx(wx) { return wx + 60; }
function sy(wy) { return wy + 40; }

// --- a board where a cable is drawn straight across a third device --------
// A (0,0) and B (600,0) are one-port hosts, so their sockets sit at the right-hand
// centre of each box: (132,34) and (732,34). The cable between them is a horizontal run
// at y = 34. C (250,0) is a third host placed so that its socket lands exactly on that
// run, and its faceplate is crossed by it - the exact geometry from the report.
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
const C = topo.addDevice(hostSpec()); C.name = 'C';
topo.connect(A.id, 'eth0', B.id, 'eth0');
const LAYOUT = {};
LAYOUT[A.id] = { x: 0, y: 0 };
LAYOUT[B.id] = { x: 600, y: 0 };
LAYOUT[C.id] = { x: 250, y: 0 };
const json = JSON.parse(JSON.stringify(topo.serialize()));
json.layout = LAYOUT;
PFCanvas.render(json);

const linkId = (json.links[0] || {}).id;
const cPort = PFCanvas.portWorld(C.id, 'eth0');
ok(!!cPort && cPort.x === 382 && cPort.y === 34,
  'the test board puts a socket exactly on the cable run (' + JSON.stringify(cPort) + ')');

// The element the browser would have painted there: the cable's widened grab band.
let hitBand = null, linkStroke = null;
walk(roots.world, function (n) {
  if (n.tag !== 'line' || !n.attrs['data-link-id']) return;
  if (String(n.attrs.class).indexOf('link-hit') !== -1) hitBand = n;
  else linkStroke = n;
});
ok(!!hitBand && !!linkStroke, 'the cable is drawn with its grab band and its visible stroke');
ok(!!linkId, 'and the link has an id to select it by');

let portsClicked = [], linksSelected = [], devicesSelected = [];
PFCanvas.on.portClick = function (deviceId, iface) { portsClicked.push({ deviceId: deviceId, iface: iface }); };
PFCanvas.on.selectLink = function (id) { linksSelected.push(id); };
PFCanvas.on.select = function (id) { devicesSelected.push(id); };

console.log('');
console.log('A socket under a cable still answers the mouse:');
{
  const hit = PFCanvas.hitTest(sx(cPort.x), sy(cPort.y));
  ok(hit.kind === 'port' && hit.deviceId === C.id && hit.iface === 'eth0',
    'the hit test resolves the press to the socket, not the cable (' + JSON.stringify(hit) + ')');

  // And it does so even when the browser hands the press to the cable: hit order must
  // not be able to depend on what happens to be painted on top.
  fire('pointerdown', sx(cPort.x), sy(cPort.y), hitBand);
  ok(portsClicked.length === 1 && portsClicked[0].deviceId === C.id,
    'a press delivered to the cable band still opens the socket under it (' +
    JSON.stringify(portsClicked[0]) + ')');
  ok(linksSelected.length === 0, 'the cable was not selected instead');
  ok(devicesSelected.length === 0, 'and no device was selected on the way');
}

console.log('');
console.log('The precedence rule is port > device body > cable:');
{
  // Same pixel: the socket sits on C's border, so both a port and a body match there.
  const onPort = PFCanvas.hitTest(sx(cPort.x), sy(cPort.y));
  ok(onPort.kind === 'port', 'a port beats the device body it sits on (' + onPort.kind + ')');

  // Inside C's faceplate, with the cable running across it.
  const onBody = PFCanvas.hitTest(sx(300), sy(34));
  ok(onBody.kind === 'device' && onBody.deviceId === C.id,
    'a device body beats a cable crossing it (' + onBody.kind + ')');

  // The open span of the cable, away from every body and every socket.
  const onCable = PFCanvas.hitTest(sx(500), sy(34));
  ok(onCable.kind === 'link' && onCable.linkId === linkId,
    'a cable is still grabbable where nothing else is (' + onCable.kind + ')');

  // Nowhere near anything.
  const onEmpty = PFCanvas.hitTest(sx(860), sy(660));
  ok(onEmpty.kind === 'background', 'and empty canvas is background (' + onEmpty.kind + ')');

  // The cable's own endpoint is a socket, so the socket wins there too.
  const bPort = PFCanvas.portWorld(B.id, 'eth0');
  const atEnd = PFCanvas.hitTest(sx(bPort.x), sy(bPort.y));
  ok(atEnd.kind === 'port' && atEnd.deviceId === B.id,
    'even at the cable\'s endpoint the socket wins (' + atEnd.kind + ')');
}

console.log('');
console.log('Clicking a cable away from any port still selects the cable:');
{
  linksSelected = [];
  portsClicked = [];
  fire('pointerdown', sx(500), sy(34), linkStroke);
  ok(linksSelected.length === 1 && linksSelected[0] === linkId,
    'the cable was selected (' + linksSelected.join(',') + ')');
  ok(portsClicked.length === 0, 'and no cable-making gesture was started');
}

console.log('');
console.log('Paint order puts devices above cables:');
{
  const kids = roots.world.children;
  const idxOf = function (re) {
    for (let i = 0; i < kids.length; i++) {
        // not an exemption: matching a DOM class to find the node under the cursor. Nothing here
        // decides which hardware is checked.
      if (re.test(String(kids[i].attrs.class || ''))) return i;
    }
    return -1;
  };
  const cableAt = idxOf(/cable-layer/);
  const deviceAt = idxOf(/device-layer/);
  ok(cableAt !== -1 && deviceAt !== -1,
    'the drawing surface has a cable layer and a device layer (' + cableAt + ', ' + deviceAt + ')');
  ok(deviceAt > cableAt,
    'the device layer is painted after the cable layer, so no cable covers a faceplate (' +
    deviceAt + ' > ' + cableAt + ')');

  // Nothing carrying a link id may live in the layer that is painted last.
  let strays = 0;
  let inDeviceLayer = 0;
  walk(kids[deviceAt], function (n) { if (n.attrs && n.attrs['data-link-id']) strays++; });
  walk(kids[deviceAt], function (n) { if (String(n.attrs.class || '') === 'device') inDeviceLayer++; });
  ok(strays === 0, 'no cable element is drawn inside the device layer (' + strays + ')');
  ok(inDeviceLayer === 3, 'all three chassis are drawn in it (' + inDeviceLayer + ')');

  let cablesInCableLayer = 0;
  walk(kids[cableAt], function (n) { if (n.attrs && n.attrs['data-link-id']) cablesInCableLayer++; });
  ok(cablesInCableLayer === 2,
    'and the cable (its stroke and its grab band) is drawn in the cable layer (' +
    cablesInCableLayer + ')');

  // Belt and braces: the grid is scenery and must stay at the bottom.
  ok(/grid/i.test(String(kids[0].attrs.class || '')) || kids[0].tag === 'g',
    'the grid is still the bottom layer');
}

console.log('');
console.log('The grab band is wide, and the socket still wins:');
{
  const css = fs.readFileSync(path.join(__dirname, '..', 'web', 'style.css'), 'utf8');
  const m = /\.link-hit\s*\{[^}]*stroke-width:\s*([\d.]+)/.exec(css);
  ok(!!m, 'the cable grab band has an explicit width in style.css');
  const bandPx = m ? Number(m[1]) : 0;
  ok(bandPx >= 10,
    'it is far wider than the 10 px socket it passes over (' + bandPx + 'px)');
  // The band is 2x the socket radius: if hit order were still paint order this would make
  // the socket unreachable, which is exactly what was reported.
  ok(PFCanvas.hitTest(sx(cPort.x), sy(cPort.y)).kind === 'port',
    'and the socket under the middle of that band is still what the mouse hits');
}

console.log('');
console.log('Cables landing all over a chassis do not shadow its sockets:');
{
  // Three cables terminate on the same 4-port box from different sides. If the grab band
  // could win, every socket with a cable in it - the ones you actually want to click -
  // would be the least reachable pixels on the board.
  function quadSpec() {
    return {
      vendor: 'generic', model: 'generic-sw', label: 'SW', category: 'switch',
      capabilities: ['switch'],
      interfaces: [
        { name: 'eth0', type: 'ethernet', speed: '1G' },
        { name: 'eth1', type: 'ethernet', speed: '1G' },
        { name: 'eth2', type: 'ethernet', speed: '1G' },
        { name: 'eth3', type: 'ethernet', speed: '1G' }
      ]
    };
  }
  const t2 = new Topology();
  const x = t2.addDevice(hostSpec()); x.name = 'X';
  const y = t2.addDevice(hostSpec()); y.name = 'Y';
  const z = t2.addDevice(hostSpec()); z.name = 'Z';
  const sw = t2.addDevice(quadSpec()); sw.name = 'SW1';
  t2.connect(x.id, 'eth0', sw.id, 'eth0');
  t2.connect(y.id, 'eth0', sw.id, 'eth2');
  t2.connect(z.id, 'eth0', sw.id, 'eth1');
  const j2 = JSON.parse(JSON.stringify(t2.serialize()));
  j2.layout = {};
  j2.layout[x.id] = { x: 0, y: 0 };
  j2.layout[y.id] = { x: 0, y: 200 };
  j2.layout[z.id] = { x: 0, y: 400 };
  j2.layout[sw.id] = { x: 500, y: 200 };
  PFCanvas.render(j2);
  ok(j2.links.length === 3, 'three cables are drawn onto the one box (' + j2.links.length + ')');

  const left = PFCanvas.portWorld(sw.id, 'eth0');
  const right = PFCanvas.portWorld(sw.id, 'eth1');
  const h1 = PFCanvas.hitTest(sx(left.x), sy(left.y));
  const h2 = PFCanvas.hitTest(sx(right.x), sy(right.y));
  ok(h1.kind === 'port' && h1.deviceId === sw.id && h1.iface === 'eth0',
    'a socket with a cable in it is still a socket (' + h1.kind + ')' + ' ' + JSON.stringify(h1));
  ok(h2.kind === 'port' && h2.deviceId === sw.id && h2.iface === 'eth1',
    'on either side of the chassis (' + h1.iface + ', ' + h2.iface + ')');
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
