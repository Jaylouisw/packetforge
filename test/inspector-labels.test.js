'use strict';
// Issue #25: a port row drew its cable label and its LLDP label on top of each other.
//
// A port can carry two independent descriptions of its far end. The cable record says
// where the wire goes (→ SW1:Fa0/1); LLDP says what the far end claims about itself
// (LLDP: SW1/Fa0/1). They are allowed to disagree, which is the whole reason to show
// both - so one must never be allowed to sit on top of the other.
//
// They did. .iface-head is a 4-track grid (dot / name / media / IP) and both labels
// were emitted as bare children of it. The fifth and sixth children wrapped into an
// implicit second row, where the peer label landed in the 10px dot track and the LLDP
// label in the 1fr track: two nowrap strings in a 10px box overflow their track and
// paint straight over the neighbour. Two lines of 10px mono, unreadable.
//
// This loads the real web/app.js in the stub DOM the other UI tests use, asks it for
// the row HTML of a port that genuinely has both a cable and an LLDP neighbour, and
// checks three things:
//   1. the two labels are separate elements, each with its own class;
//   2. neither is a direct child of the grid, so neither can be auto-placed into the
//      10px dot track - they sit in a container that spans the full row and stacks
//      them on consecutive lines (checked against style.css itself);
//   3. a small geometry model of the grid, run over the fixed markup and over the same
//      markup with the wrapper removed (= the pre-fix HTML), reports an overlap for
//      the old layout and none for the new one. Without that last part the test would
//      only be asserting my own markup shape, not that the labels stopped colliding.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { Topology, Simulator } = require('../engine');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg); }
}

// --- load the real frontend in the stub DOM (same shape as test/ui-render.test.js) --
function fakeNode() {
  const base = {
    innerHTML: '', textContent: '', value: '', checked: false,
    style: {}, dataset: {},
    classList: { add: function () {}, remove: function () {}, toggle: function () {}, contains: function () { return false; } },
    addEventListener: function () {}, removeEventListener: function () {},
    appendChild: function () { return fakeNode(); }, append: function () {},
    setAttribute: function () {}, getAttribute: function () { return null; },
    removeAttribute: function () {}, remove: function () {}, focus: function () {}, click: function () {},
    querySelector: function () { return fakeNode(); }, querySelectorAll: function () { return []; },
    closest: function () { return null; }, parentElement: null, children: []
  };
  return new Proxy(base, {
    get: function (t, k) { if (k in t) return t[k]; return function () { return fakeNode(); }; },
    set: function (t, k, v) { t[k] = v; return true; }
  });
}
function makeWrap() {
  return {
    _html: '',
    get innerHTML() { return this._html; },
    set innerHTML(v) { this._html = v; },
    addEventListener: function () {}, removeEventListener: function () {},
    style: {}, classList: { add: function () {}, remove: function () {}, toggle: function () {}, contains: function () { return false; } },
    querySelector: function () { return fakeNode(); },
    querySelectorAll: function () { return []; },
    setAttribute: function () {}, getAttribute: function () { return null; }
  };
}
const mainWrap = makeWrap();
const ctx = {
  console: console,
  setTimeout: setTimeout, clearTimeout: clearTimeout, setInterval: setInterval,
  fetch: function () { return Promise.resolve({ ok: true, json: function () { return Promise.resolve({}); } }); },
  document: {
    addEventListener: function () {},
    querySelector: function () { return mainWrap; },
    querySelectorAll: function () { return []; }
  },
  window: {},
  PFCanvas: {
    on: {}, setTopology: function () {}, fitView: function () {}, render: function () {},
    setSelected: function () {}, setSelectedLink: function () {},
    animateEvents: function () {}, zoomBy: function () {}
  }
};
ctx.window.PFCanvas = ctx.PFCanvas;
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'web', 'app.js'), 'utf8'), ctx, { filename: 'app.js' });
const pf = ctx.window.__pf;
ok(!!pf && typeof pf.ifaceRowHTML === 'function', 'app.js loads and exposes ifaceRowHTML');

const css = fs.readFileSync(path.join(__dirname, '..', 'web', 'style.css'), 'utf8');
function cssRule(selector) {
  const i = css.indexOf(selector + ' {');
  if (i < 0) return null;
  const start = css.indexOf('{', i) + 1;
  const end = css.indexOf('}', start);
  return css.slice(start, end);
}
function decl(body, prop) {
  if (!body) return null;
  const m = body.match(new RegExp('(?:^|;|\\s)' + prop + '\\s*:\\s*([^;]+)'));
  return m ? m[1].trim() : null;
}

// --- a switch with two ports cabled, so real LLDP neighbours get learned ------------
const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
function spec(v, m) {
  const s = catalog.find(function (x) { return x.vendor === v && x.model === m; });
  if (!s) throw new Error('missing spec ' + v + '/' + m);
  return s;
}
const t = new Topology();
const sw = t.addDevice(spec('generic', 'generic-switch')); sw.name = 'SW1';
const pc = t.addDevice(spec('generic', 'generic-pc')); pc.name = 'PC1';
const pc2 = t.addDevice(spec('generic', 'generic-pc')); pc2.name = 'PC2';
pc.interfaces.get('eth0').ip = '10.0.0.1';
pc.interfaces.get('eth0').mask = '255.255.255.0';
t.connect(pc.id, 'eth0', sw.id, 'Fa0/1');
t.connect(pc2.id, 'eth0', sw.id, 'Fa0/2');
new Simulator(t).ping(pc.id, '10.0.0.99');       // sends LLDP, and the switch replies
const topo = JSON.parse(JSON.stringify(t.serialize()));
pf.setTopology(topo);

const swDev = topo.devices.find(function (d) { return d.id === sw.id; });
const both = swDev.interfaces.find(function (i) { return i.name === 'Fa0/1'; });
const bare = swDev.interfaces.find(function (i) { return i.name === 'Fa0/8'; });

console.log('\nThe sample port really has both claims to make:');
ok(!!both, 'the cabled port Fa0/1 is in the serialized device (wiring from the topology)');
ok(!!both && topo.links.some(function (l) {
  return (l.a.deviceId === sw.id && l.a.iface === 'Fa0/1') ||
         (l.b.deviceId === sw.id && l.b.iface === 'Fa0/1');
}), 'a cable peer exists for Fa0/1 (the cable record)');
ok(!!both && !!both.lldp, 'and an LLDP neighbour was learned over that cable (' +
  (both && both.lldp ? both.lldp.systemName + '/' + both.lldp.portId : 'none') + ')');
ok(!!bare && !bare.lldp && !topo.links.some(function (l) {
  return l.a.iface === bare.name || l.b.iface === bare.name;
}), 'an uncabled port (' + (bare && bare.name) + ') has neither, for comparison');

const row = pf.ifaceRowHTML(swDev, both);
ok(typeof row === 'string' && row.length > 0, 'ifaceRowHTML returns markup for that port');

// --- a tiny tag scanner: direct children of a container, plus their inner text ------
function directChildren(html) {
  const re = /<\/?([a-zA-Z0-9]+)([^>]*)>/g;
  const out = [];
  const stack = [];
  let m;
  while ((m = re.exec(html))) {
    const closing = m[0].charAt(1) === '/';
    const tag = m[1].toLowerCase();
    const attrs = m[2] || '';
    const selfClose = /\/\s*$/.test(attrs) || tag === 'input' || tag === 'br';
    const inner = m.index + m[0].length;
    const cls = (attrs.match(/class="([^"]*)"/) || ['', ''])[1];
    if (closing) {
      const node = stack.pop();
      if (node && node.depth === 0) { node.end = m.index; out.push(node); }
    } else if (selfClose) {
      if (stack.length === 0) out.push({ tag: tag, cls: cls, depth: 0, start: inner, end: inner });
    } else {
      stack.push({ tag: tag, cls: cls, depth: stack.length, start: inner });
    }
  }
  out.forEach(function (n) { n.text = html.slice(n.start, n.end).replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim(); });
  return out;
}
function innerOf(html, cls) {
  const re = new RegExp('<div class="' + cls + '">');
  const m = re.exec(html);
  if (!m) return null;
  // find the matching close for this div by counting nested <div>s
  const from = m.index + m[0].length;
  const divRe = /<\/?div\b[^>]*>/g;
  divRe.lastIndex = from;
  let depth = 1, d;
  while ((d = divRe.exec(html))) {
    depth += d[0].charAt(1) === '/' ? -1 : 1;
    if (depth === 0) return html.slice(from, d.index);
  }
  return null;
}

console.log('\nEach label is its own element:');
ok((row.match(/class="port-peer"/g) || []).length === 1, 'exactly one cable-peer label');
ok((row.match(/class="port-lldp"/g) || []).length === 1, 'exactly one LLDP label');
const peerSpan = /<span class="port-peer"[^>]*>([\s\S]*?)<\/span>/.exec(row);
const lldpSpan = /<span class="port-lldp"[^>]*>([\s\S]*?)<\/span>/.exec(row);
ok(!!peerSpan && /\u2192/.test(peerSpan[1]), 'the peer label is the cable record (' +
  (peerSpan ? peerSpan[1].trim() : '') + ')');
ok(!!lldpSpan && /^LLDP:/.test(lldpSpan[1]), 'the LLDP label is the announcement (' +
  (lldpSpan ? lldpSpan[1].trim() : '') + ')');
ok(!!peerSpan && !!lldpSpan && peerSpan.index + peerSpan[0].length <= lldpSpan.index,
  'the two spans do not nest inside one another');
ok(!/style="[^"]*position\s*:\s*absolute/.test(row), 'neither label is absolutely positioned');
ok(!/style="[^"]*(top|left)\s*:/.test(row), 'and no inline offsets are used to place them');

console.log('\nNeither label can land in the 10px dot track:');
const headBody = innerOf(row, 'iface-head');
ok(!!headBody, 'the row has an iface-head');
const headKids = headBody ? directChildren(headBody) : [];
const headClasses = headKids.map(function (n) { return n.cls; });
ok(headKids.length === 5, 'the head has 5 direct children, not 6 (' + headKids.length + ')');
ok(headClasses.some(function (c) { return /\bport-labels\b/.test(c); }),
  'the labels live in one wrapper: ' + JSON.stringify(headClasses));
ok(!headClasses.some(function (c) { return /\bport-(peer|lldp)\b/.test(c); }),
  'neither label is a direct grid child (that is what caused the collision)');
ok(/\bport-labels\b/.test(headClasses[headClasses.length - 1] || ''),
  'the wrapper is the last thing in the head, i.e. the line under the port');

const labelsBody = innerOf(row, 'port-labels');
ok(!!labelsBody, 'the wrapper only exists when there is something to label');
const labelKids = labelsBody ? directChildren(labelsBody).filter(function (n) { return n.tag === 'span'; }) : [];
ok(labelKids.length === 2, 'both labels are separate children of that wrapper (' + labelKids.length + ')');
ok(!!labelKids[0] && /\bport-peer\b/.test(labelKids[0].cls) &&
   !!labelKids[1] && /\bport-lldp\b/.test(labelKids[1].cls),
  'cable first, LLDP second, distinct classes');

console.log('\nThe stylesheet gives that wrapper its own row:');
const headRule = cssRule('.iface-head');
const cols = (decl(headRule, 'grid-template-columns') || '').split(/\s+/).filter(Boolean);
ok(cols.length === 4, '.iface-head is still a 4-track grid (' + cols.join(' ') + ')');
const wrapRule = cssRule('.port-labels');
ok(!!wrapRule, '.port-labels has a rule of its own');
const gc = decl(wrapRule, 'grid-column');
ok(gc === '1 / -1' || gc === '1/-1', 'it spans the whole row, so it is not squeezed into one track (' + gc + ')');
ok(decl(wrapRule, 'display') === 'flex', 'it is a flex container, so its items cannot overlap');
ok(decl(wrapRule, 'flex-direction') === 'column', 'and it stacks them: one label per line');
ok(decl(wrapRule, 'min-width') === '0', 'min-width:0 lets a long name ellipsis instead of overflowing');
const peerRule = cssRule('.port-peer');
const lldpRule = cssRule('.port-lldp');
ok(decl(peerRule, 'position') === null && decl(lldpRule, 'position') === null,
  'neither label rule positions itself');
ok(decl(peerRule, 'margin-left') === null,
  'the peer label no longer pushes itself with margin-left:auto (that is what made it collide)');
ok((css.match(/\.port-peer\s*\{/g) || []).length === 1 &&
   (css.match(/\.port-lldp\s*\{/g) || []).length === 1 &&
   (css.match(/\.port-labels\s*\{/g) || []).length === 1,
  'each of the three rules is declared exactly once (no later override)');

// --- geometry model of the head grid ----------------------------------------------
// Not a browser: a rectangle model of what CSS would do, just precise enough to tell
// "on separate lines" from "on top of each other". 10px mono advances ~6px per char;
// white-space:nowrap text overflows its track instead of wrapping, which is exactly
// how the old layout painted one label over the other.
const PANEL = 320, PAD = 18;
function textW(s) { return Math.max(8, String(s || '').length * 6); }
function layOut(headHtml) {
  const kids = directChildren(headHtml);
  const contentW = PANEL - PAD;
  const gap = 7;
  const claimed = kids.filter(function (k) { return !/\bport-labels\b/.test(k.cls); });
  const autoW = [textW(claimed[2] && claimed[2].text), textW(claimed[3] && claimed[3].text)];
  const tracks = [10, null, autoW[0], autoW[1]];
  const fixed = tracks.reduce(function (s, c) { return s + (c === null ? 0 : c); }, 0);
  const flexW = Math.max(20, contentW - fixed - gap * 3);
  const width = tracks.map(function (c) { return c === null ? flexW : c; });
  const xs = [];
  let x = 0;
  width.forEach(function (w) { xs.push(x); x += w + gap; });
  const ROWH = 14;
  const boxes = [];
  kids.forEach(function (k, idx) {
    if (/\bport-labels\b/.test(k.cls)) {
      // spans 1 / -1: full width, on the line under the port
      boxes.push({ name: 'port-labels', x: 0, y: ROWH, w: contentW, h: 25, container: true });
      const inner = directChildren(k.text.length ? innerOf(headHtml, 'port-labels') || '' : '');
      inner.filter(function (n) { return n.tag === 'span'; }).forEach(function (n, i) {
        boxes.push({ name: n.cls, x: 0, y: ROWH + i * 13, w: Math.min(contentW, textW(n.text)), h: 12 });
      });
      return;
    }
    const r = Math.floor(idx / width.length), c = idx % width.length;
    boxes.push({ name: k.cls, x: xs[c], y: r * ROWH, w: Math.max(width[c], textW(k.text)), h: 12 });
  });
  return boxes;
}
function overlaps(boxes) {
  const hits = [];
  const leaves = boxes.filter(function (b) { return !b.container; });
  for (let i = 0; i < leaves.length; i++) {
    for (let j = i + 1; j < leaves.length; j++) {
      const a = leaves[i], b = leaves[j];
      const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
      const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
      if (ox > 0 && oy > 0) hits.push(a.name + ' over ' + b.name);
    }
  }
  return hits;
}

console.log('\nThe labels do not occupy the same pixels:');
const fixedBoxes = layOut(headBody || '');
const fixedHits = overlaps(fixedBoxes);
ok(fixedHits.length === 0, 'no two things in the row share space' +
  (fixedHits.length ? ' (' + fixedHits.join(', ') + ')' : ''));
const peerBox = fixedBoxes.find(function (b) { return /port-peer/.test(b.name); });
const lldpBox = fixedBoxes.find(function (b) { return /port-lldp/.test(b.name); });
ok(!!peerBox && !!lldpBox, 'both labels got a box in the model');
ok(!!peerBox && !!lldpBox && peerBox.y !== lldpBox.y,
  'they are on different lines (y=' + (peerBox && peerBox.y) + ' vs ' + (lldpBox && lldpBox.y) + ')');
ok(!!peerBox && !!lldpBox && peerBox.y < lldpBox.y, 'the cable record is the upper line, LLDP below it');

// The same markup with the wrapper stripped is the pre-fix HTML. The model must call
// that broken, or this test would not have caught issue #25.
const legacy = (headBody || '').replace('<div class="port-labels">', '').replace(/<\/div>$/, '');
const legacyKids = directChildren(legacy);
ok(legacyKids.length === 6, 'stripping the wrapper reproduces the old six-child grid (' + legacyKids.length + ')');
const legacyHits = overlaps(layOut(legacy));
ok(legacyHits.length > 0, 'the old markup really did overlap: ' + (legacyHits.join(', ') || 'none'));
ok(legacyHits.join(',').indexOf('port-peer') >= 0 && legacyHits.join(',').indexOf('port-lldp') >= 0,
  'and it was the cable label and the LLDP label that collided');

console.log('\nRows with a single label, or none, stay tidy:');
const bareRow = pf.ifaceRowHTML(swDev, bare);
ok(bareRow.indexOf('port-labels') < 0, 'an uncabled port does not get an empty label line');
const bareHead = innerOf(bareRow, 'iface-head') || '';
ok(directChildren(bareHead).length === 4, 'and its head is back to four grid children');
ok(overlaps(layOut(bareHead)).length === 0, 'nothing overlaps on an uncabled port');
{
  // LLDP without a cable record: the announcement still gets its own line.
  const orphan = Object.assign({}, both, { name: 'Fa0/9' });
  const orphanRow = pf.ifaceRowHTML(swDev, orphan);
  ok(/class="port-lldp"/.test(orphanRow) && !/class="port-peer"/.test(orphanRow),
    'an LLDP neighbour with no cable record still renders on its own');
  ok(!!innerOf(orphanRow, 'port-labels'), 'inside the label wrapper');
  // A cable record with no LLDP: same, other way round.
  const wiredOnly = Object.assign({}, both, { name: 'Fa0/2', lldp: null });
  const wiredRow = pf.ifaceRowHTML(swDev, wiredOnly);
  ok(/class="port-peer"/.test(wiredRow) && !/class="port-lldp"/.test(wiredRow),
    'a cable record with no LLDP renders alone');
  ok(!!innerOf(wiredRow, 'port-labels'), 'also inside the wrapper');
}

console.log('\nThe whole inspector uses the fixed row:');
pf.selectDevice(sw.id);
pf.renderDeviceTab();
const devHtml = mainWrap.innerHTML;
ok(/class="port-labels"/.test(devHtml), 'rendering the Device tab emits the label wrapper');
const rowsWithLabels = (devHtml.match(/class="port-labels"/g) || []).length;
ok(rowsWithLabels === 2, 'one per cabled port, not per port (' + rowsWithLabels + ' of ' +
  swDev.interfaces.length + ')');
ok(/class="iface-row"/.test(devHtml) && /class="dot up"/.test(devHtml) &&
   /class="port-name"/.test(devHtml), 'the row contract the other UI tests rely on is intact');

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
