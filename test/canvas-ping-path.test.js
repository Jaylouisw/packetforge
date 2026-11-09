'use strict';
// A packet leaves a socket and arrives at a socket (#1228).
//
// The canvas animates one dot per `frame` event the simulator reports. It used to tween the *centre*
// of the source chassis to the *centre* of the destination, so the dot cut across empty canvas while
// the cable itself was drawn socket-to-socket somewhere else - and after a device had been dragged, the
// dot used the new layout while the cable was still drawn at the old one, so it followed neither.
//
// This loads the real web/canvas.js against a recording stub DOM with a controllable animation clock,
// runs a real ping frame through animateEvents(), and reads every position the dot was given.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { Topology } = require('../engine');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

// --- recording stub DOM, with a trace of every packet position --------------
let created = [];
function rec(name, attrs) {
  const node = {
    tag: name,
    attrs: attrs || {},
    trace: [],
    children: [],
    textContent: '',
    style: {},
    parentNode: null,
    appendChild: function (c) {
      const at = this.children.indexOf(c);
      if (at !== -1) this.children.splice(at, 1);
      c.parentNode = this;
      this.children.push(c);
      return c;
    },
    remove: function () {
      if (this.parentNode) {
        const at = this.parentNode.children.indexOf(this);
        if (at !== -1) this.parentNode.children.splice(at, 1);
        this.parentNode = null;
      }
    },
    setAttribute: function (k, v) {
      this.attrs[k] = v;
      if (this.tag === 'circle') {
        if (k === 'cx') this.trace.push({ x: Number(v) });
        else if (k === 'cy' && this.trace.length) this.trace[this.trace.length - 1].y = Number(v);
      }
    },
    getAttribute: function (k) { return this.attrs[k]; },
    addEventListener: function () {},
    removeEventListener: function () {},
    classList: { add: function () {}, remove: function () {}, toggle: function () {}, contains: function () { return false; } },
    querySelector: function () { return null; },
    querySelectorAll: function () { return []; },
    set innerHTML(v) { this.children.length = 0; },
    get innerHTML() { return ''; }
  };
  created.push(node);
  return node;
}

const roots = {};
['canvas', 'world', 'packets', 'overlay'].forEach(function (id) { roots[id] = rec('g', { id: id }); });

let clock = 0;
const rafQueue = [];
const timerQueue = [];

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
  localStorage: { getItem: function () { return null; }, setItem: function () {} },
  performance: { now: function () { return clock; } },
  // The animation clock. Frames are queued, never run inline: the test pumps them so the trace is
  // complete when the assertions run.
  requestAnimationFrame: function (cb) { rafQueue.push(cb); return rafQueue.length; },
  cancelAnimationFrame: function () {},
  setTimeout: function (fn, ms) { timerQueue.push({ fn: fn, at: clock + (ms || 0) }); return timerQueue.length; },
  clearTimeout: function () {},
  setInterval: function () { return 0; },
  clearInterval: function () {}
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;

vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'web', 'canvas.js'), 'utf8'),
  sandbox, { filename: 'canvas.js' });
const PFCanvas = sandbox.window.PFCanvas || sandbox.PFCanvas;

// Run one queued callback, or advance the clock if there is nothing to do.
function step() {
  if (rafQueue.length) {
    const cb = rafQueue.shift();
    clock += 16;
    cb(clock);
    return true;
  }
  if (timerQueue.length) {
    const t = timerQueue.shift();
    if (t.at > clock) clock = t.at;
    else clock += 1;
    t.fn();
    return true;
  }
  clock += 1;
  return false;
}

async function drain() {
  for (let i = 0; i < 20000; i++) {
    step();
    await new Promise(function (r) { setImmediate(r); });
    if (!rafQueue.length && !timerQueue.length) {
      // Give the promise chain one more turn to settle before deciding it is finished.
      await new Promise(function (r) { setImmediate(r); });
      if (!rafQueue.length && !timerQueue.length) return;
    }
  }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices')).filter(function (s) { return !s.error; });
const SWITCH = catalog.filter(function (s) { return /CRS326-24G/.test(s.model); })[0];
const PC = catalog.filter(function (s) { return /generic-pc/.test(s.model); })[0];

// A rendered lab: two boxes with a cable between ether1 and eth0, laid out far apart so a
// centre-to-centre line is nowhere near the cable.
function buildLab(opts) {
  const o = opts || {};
  const t = new Topology({});
  const sw = t.addDevice(SWITCH);
  const pc = t.addDevice(PC);
  const link = t.connect(sw.id, 'ether1', pc.id, 'eth0', { mediaId: '1000base-t' });
  const doc = JSON.parse(JSON.stringify(t.serialize()));
  doc.layout = {};
  doc.layout[sw.id] = { x: o.swX === undefined ? 100 : o.swX, y: o.swY === undefined ? 100 : o.swY };
  doc.layout[pc.id] = { x: o.pcX === undefined ? 900 : o.pcX, y: o.pcY === undefined ? 520 : o.pcY };
  // Use the names the engine resolved to, not the ones typed: resolvePortName() maps aliases
  // ('ether1' -> 'eth1' on this switch), and the drawing uses the resolved name.
  return { doc: doc, sw: sw.id, pc: pc.id, link: link, ether: link.a.iface, eth0: link.b.iface };
}

function distanceToSegment(p, a, b) {
  const vx = b.x - a.x, vy = b.y - a.y;
  const wx = p.x - a.x, wy = p.y - a.y;
  const len2 = vx * vx + vy * vy;
  let t = len2 ? (wx * vx + wy * vy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const dx = a.x + t * vx - p.x, dy = a.y + t * vy - p.y;
  return Math.sqrt(dx * dx + dy * dy);
}

function insideRect(p, pos, size, inset) {
  const i = inset || 0;
  return p.x > pos.x + i && p.x < pos.x + size.w - i && p.y > pos.y + i && p.y < pos.y + size.h - i;
}

(async function main() {
  console.log('');
  console.log('The dot runs from socket to socket:');
  const lab = buildLab();
  PFCanvas.render(lab.doc);
  const from = PFCanvas.portWorld(lab.sw, lab.ether);
  const to = PFCanvas.portWorld(lab.pc, lab.eth0);
  ok(!!from && !!to, 'both sockets have a world position');
  const cable = PFCanvas.cables()[0];
  ok(cable && cable.from && cable.to, 'the cable is drawn between them');
  ok(Math.round(cable.from.x) === Math.round(from.x) && Math.round(cable.to.x) === Math.round(to.x),
    'and the drawing agrees with the sockets', JSON.stringify({ cable: cable.from, socket: from }));

  const before = created.length;
  const p = PFCanvas.animateEvents([{ type: 'frame', from: lab.sw, fromIface: lab.ether, to: lab.pc, toIface: lab.eth0, frame: {} }]);
  await drain();
  await p;

  const dots = created.slice(before).filter(function (n) { return n.tag === 'circle'; });
  ok(dots.length === 1, 'one dot was animated', String(dots.length));
  const trace = (dots[0] && dots[0].trace) || [];
  ok(trace.length > 5, 'with a trace of positions', String(trace.length));

  const first = trace[0], last = trace[trace.length - 1];
  // The first sampled position is one animation frame in (16 ms of a 240 ms tween), so it is a few
  // pixels along the cable rather than exactly on the socket. On a ~950 px run that is under 2%.
  const firstGap = first ? Math.sqrt(Math.pow(first.x - from.x, 2) + Math.pow(first.y - from.y, 2)) : Infinity;
  ok(firstGap < 20, 'it starts at the source socket', JSON.stringify(first) + ' vs ' + JSON.stringify(from) +
    ' (' + firstGap.toFixed(1) + ' px in)');
  ok(last && Math.abs(last.x - to.x) < 1 && Math.abs(last.y - to.y) < 1,
    'and finishes at the destination socket', JSON.stringify(last) + ' vs ' + JSON.stringify(to));

  const worst = Math.max.apply(null, trace.map(function (pt) { return distanceToSegment(pt, from, to); }));
  ok(worst < 0.75, 'every position lies on the cable', 'worst deviation ' + worst.toFixed(2) + ' px');

  const incomplete = trace.filter(function (pt) { return pt.x === undefined || pt.y === undefined; });
  ok(incomplete.length === 0, 'no position is missing a coordinate', JSON.stringify(trace.slice(0, 3)));

  // The signature of the old behaviour: the path was the line joining the two device centres. A path
  // along the cable departs from that line wherever the sockets are not the centres - which is
  // everywhere except a perfectly symmetric pair.
  const c1 = PFCanvas.deviceCenter(lab.sw), c2 = PFCanvas.deviceCenter(lab.pc);
  const worstFromCentres = Math.max.apply(null, trace.map(function (pt) { return distanceToSegment(pt, c1, c2); }));
  ok(worstFromCentres > 10, 'the path is not the centre-to-centre line the old code drew',
    'closest approach to it ' + worstFromCentres.toFixed(1) + ' px');
  ok(!insideRect(trace[Math.floor(trace.length / 2)], { x: c1.x - 8, y: c1.y - 8 }, { w: 16, h: 16 }, 0),
    'and the dot is not sitting inside the source chassis half way through');

  console.log('');
  console.log('A device that has been moved is animated where it now is:');
  {
    // Move the switch 400 px right in the layout, exactly as a drag persists it, and do NOT redraw.
    const lab2 = buildLab();
    PFCanvas.render(lab2.doc);
    lab2.doc.layout[lab2.sw] = { x: 500, y: 700 };
    const staleSocket = PFCanvas.portWorld(lab2.sw, lab2.ether);
    const created2 = created.length;
    const p2 = PFCanvas.animateEvents([{ type: 'frame', from: lab2.sw, fromIface: lab2.ether, to: lab2.pc, toIface: lab2.eth0 }]);
    await drain();
    await p2;
    const dot2 = created.slice(created2).filter(function (n) { return n.tag === 'circle'; })[0];
    const trace2 = (dot2 && dot2.trace) || [];
    const start2 = trace2[0];
    const nowSocket = PFCanvas.portWorld(lab2.sw, lab2.ether);
    const gap2 = start2 ? Math.sqrt(Math.pow(start2.x - nowSocket.x, 2) + Math.pow(start2.y - nowSocket.y, 2)) : Infinity;
    ok(gap2 < 20, 'the dot starts at the new socket position',
      JSON.stringify(start2) + ' vs ' + JSON.stringify(nowSocket) + ' (' + gap2.toFixed(1) + ' px in)');
    ok(!start2 || Math.abs(start2.x - staleSocket.x) > 1 || Math.abs(start2.y - staleSocket.y) > 1,
      'and not at the pre-move one', JSON.stringify(staleSocket));
    ok(nowSocket.x !== staleSocket.x || nowSocket.y !== staleSocket.y, 'the fixture really did move');
  }

  console.log('');
  console.log('Dragging a box takes its cables with it:');
  {
    const lab3 = buildLab();
    PFCanvas.render(lab3.doc);
    const before3 = PFCanvas.cables()[0];
    PFCanvas.dragPreview(lab3.sw, 120, -40);
    const after3 = PFCanvas.cables()[0];
    ok(Math.round(after3.from.x - before3.from.x) === 120 && Math.round(after3.from.y - before3.from.y) === -40,
      'the end attached to the dragged box moved by the drag',
      JSON.stringify({ before: before3.from, after: after3.from }));
    ok(after3.to.x === before3.to.x && after3.to.y === before3.to.y,
      'and the far end did not move', JSON.stringify(after3.to));
    const moved = PFCanvas.portWorld(lab3.sw, lab3.ether);
    ok(Math.abs(moved.x - (before3.from.x + 120)) < 1 && Math.abs(moved.y - (before3.from.y - 40)) < 1,
      'the socket table moved with it, so a ping during the drag follows the cable',
      JSON.stringify(moved));
  }

  console.log('');
  console.log('A position is never invented:');
  {
    const lab4 = buildLab();
    PFCanvas.render(lab4.doc);
    ok(PFCanvas.socketPoint('nosuchdevice', 'eth0') === null, 'an unknown device has no position');
    ok(PFCanvas.socketPoint(lab4.sw, 'nosuchport') !== null,
      'a known device with an unknown port falls back to its body, not the grid origin');
    // A device with no layout entry is drawn by the canvas at its default position, so the packet
    // position must be the same place the drawing puts it - the fault was inventing a position that
    // the picture did not agree with.
    const noLayout = JSON.parse(JSON.stringify(lab4.doc));
    delete noLayout.layout[lab4.sw];
    PFCanvas.render(noLayout);
    const fallback = PFCanvas.socketPoint(lab4.sw, lab4.ether);
    const drawn = PFCanvas.cables().find(function (c) { return c.id === lab4.link.id; });
    ok(fallback && drawn && Math.abs(fallback.x - drawn.from.x) < 1 && Math.abs(fallback.y - drawn.from.y) < 1,
      'a device with no layout entry is placed where the canvas actually drew it',
      JSON.stringify(fallback) + ' vs ' + JSON.stringify(drawn && drawn.from));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch(function (e) {
  console.error('  \u2717 the test itself threw: ' + (e && e.stack || e));
  process.exit(1);
});
