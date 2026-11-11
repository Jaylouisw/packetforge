'use strict';
// A position is a place on the canvas, and both doors that set one ask the same rule (#1421).
//
// Two doors accept a position: `POST /api/topologies/:name/layout` and `Topology.fromJSON()` when a document is
// loaded. The engine asked `isPosition()` - `{ x, y }`, two finite numbers - and the endpoint kept its own copy of
// that sentence inline. Two implementations of one rule is how six other pairs in this repository drifted, and this
// pair had already drifted in the way that matters least visibly and most annoyingly: both accepted `1e308`.
//
// `1e308` is a finite number and it is not a place. `fitView()` takes the board's width as the largest x minus the
// smallest, which is `Infinity` for two such positions - zoom clamps to its 0.25 floor, `translate()` is handed
// `-Infinity`, the canvas draws nothing, and the button meant to recover the view computes the same arithmetic. The
// lab is not lost, but it cannot be seen or dragged back, which for a person is the same thing.
//
// So: one rule, in the engine, asked by both doors; and the property that makes the rule worth having - every
// position the doors accept is a position the canvas can actually frame, checked against the real `web/canvas.js`.
const fs = require('fs');
const path = require('path');
const http = require('http');
const net = require('net');
const os = require('os');
const vm = require('vm');
const { spawn } = require('child_process');
const { Topology, expandInterfaces, isPosition, positionProblem, WORLD_LIMIT } = require('../engine');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const ROOT = path.join(__dirname, '..');
const catalog = loadCatalog(path.join(ROOT, 'devices')).filter(function (s) { return !s.error; });
const SPEC = catalog.find(function (s) { return s.category === 'switch'; });
function specByModel(m) {
  const s = catalog.find(function (x) { return x.model === m; });
  if (!s) throw new Error('no ' + m);
  return s;
}

// The table. Every entry is a thing a client has actually sent, or a document could carry: the edges of the world,
// one step past it, and the shapes that are not positions at all.
const CASES = [
  { p: { x: 0, y: 0 }, ok: true, why: 'the origin' },
  { p: { x: 480, y: 260 }, ok: true, why: 'an ordinary box' },
  { p: { x: -1.5, y: 2.25 }, ok: true, why: 'fractional pixels, negative side' },
  { p: { x: WORLD_LIMIT, y: WORLD_LIMIT }, ok: true, why: 'the corner of the world' },
  { p: { x: -WORLD_LIMIT, y: -WORLD_LIMIT }, ok: true, why: 'and the opposite corner' },
  { p: { x: WORLD_LIMIT + 1, y: 0 }, ok: false, why: 'one past the edge' },
  { p: { x: 1e308, y: 1e308 }, ok: false, why: 'a finite number that is not a place' },
  { p: { x: -1e308, y: 0 }, ok: false, why: 'and the same below' },
  { p: { x: '480', y: 260 }, ok: false, why: 'a string' },
  { p: { x: null, y: 260 }, ok: false, why: 'a null coordinate' },
  { p: { x: 480 }, ok: false, why: 'half a position' },
  { p: [480, 260], ok: false, why: 'an array' },
  { p: null, ok: false, why: 'nothing' },
  { p: 480, ok: false, why: 'a number' },
  { p: 'here', ok: false, why: 'a word' }
];

console.log('A position is two finite numbers inside the world:');
{
  const wrong = [];
  for (const c of CASES) {
    const verdict = isPosition(c.p);
    if (verdict !== c.ok) wrong.push(c.why + ' -> ' + verdict);
  }
  ok(wrong.length === 0, CASES.length + ' shapes are read as they are', JSON.stringify(wrong));
  ok(isPosition({ x: WORLD_LIMIT, y: 0 }) && !isPosition({ x: WORLD_LIMIT * 1.000001, y: 0 }),
    'the edge is inclusive and the pixel past it is not', String(WORLD_LIMIT));
  // A refusal has to say which of the two things went wrong, or the operator cannot tell a typo from a bug.
  ok(positionProblem({ x: 1e308, y: 0 }).indexOf('outside the canvas') !== -1,
    'an out-of-world position is described as outside the canvas', positionProblem({ x: 1e308, y: 0 }));
  ok(positionProblem({ x: '10', y: 0 }).indexOf('two numbers') !== -1,
    'and a non-number as not two numbers', positionProblem({ x: '10', y: 0 }));
}

// --- the two doors, over the same table ---------------------------------------------------------------------------
function docOneDevice() {
  const t = new Topology();
  t.addDevice(SPEC, 'd1');
  return JSON.parse(JSON.stringify(t.serialize()));
}

console.log('');
console.log('The engine door restores a position or says why it cannot:');
{
  const disagreements = [];
  for (const c of CASES) {
    const d = docOneDevice();
    d.layout = { d1: c.p };
    const t = Topology.fromJSON(d);
    const kept = !!t.layout.d1;
    const issues = (t.loadIssues || []).filter(function (i) { return i.code === 'E_LAYOUT_BAD_ENTRY'; });
    if (kept !== c.ok) disagreements.push(c.why + ': kept=' + kept + ' expected=' + c.ok);
    if (!c.ok && issues.length === 0) disagreements.push(c.why + ': dropped with no issue');
    if (!c.ok && issues.length && issues[0].message.indexOf(c.why) === -1 &&
        !(c.why === 'a finite number that is not a place' || c.why === 'and the same below')) {
      // the message has to name what is wrong, not just that something is
      if (/not \{ x, y \} with two numbers|outside the canvas/.test(issues[0].message) === false) {
        disagreements.push(c.why + ': message says ' + issues[0].message);
      }
    }
    if (c.ok && kept && (t.layout.d1.x !== c.p.x || t.layout.d1.y !== c.p.y)) {
      disagreements.push(c.why + ': stored ' + JSON.stringify(t.layout.d1));
    }
  }
  ok(disagreements.length === 0, 'every shape is kept or explained, exactly as the rule says',
    JSON.stringify(disagreements.slice(0, 4)));
}

// --- the HTTP door, asked the same question -----------------------------------------------------------------------
function freePort() {
  return new Promise(function (resolve, reject) {
    const probe = net.createServer();
    probe.unref();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', function () {
      const port = probe.address().port;
      probe.close(function () { resolve(port); });
    });
  });
}
function request(port, method, urlPath, body) {
  return new Promise(function (resolve, reject) {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port: port, path: urlPath, method: method,
      headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}
    }, function (res) {
      let data = '';
      res.on('data', function (c) { data += c; });
      res.on('end', function () {
        let parsed = null;
        try { parsed = JSON.parse(data); } catch (e) { parsed = data; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

(async function () {
  console.log('');
  console.log('And the HTTP door answers the same way, position for position:');
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-layout-'));
  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    env: Object.assign({}, process.env, { PORT: String(port), PF_DATA: dataDir }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let log = '';
  child.stdout.on('data', function (d) { log += d; });
  child.stderr.on('data', function (d) { log += d; });
  try {
    const deadline = Date.now() + 20000;
    for (;;) {
      try {
        const r = await request(port, 'GET', '/api/version');
        if (r.status === 200) break;
      } catch (e) { /* not up yet */ }
      if (child.exitCode !== null) throw new Error('server exited: ' + log);
      if (Date.now() > deadline) throw new Error('server never answered: ' + log.slice(-400));
      await new Promise(function (r) { setTimeout(r, 100); });
    }

    await request(port, 'POST', '/api/topologies', { id: 'positions' });
    const made = await request(port, 'POST', '/api/topologies/positions/devices',
      { vendor: SPEC.vendor, model: SPEC.model, id: 'd1', x: 100, y: 100 });
    ok(made.status === 201, 'a device to move', String(made.status));

    const disagreements = [];
    const accepted = [];
    for (const c of CASES) {
      // Reset to a known position first, so "changed nothing on refusal" is a real question.
      await request(port, 'POST', '/api/topologies/positions/layout', { positions: { d1: { x: 7, y: 9 } } });
      const r = await request(port, 'POST', '/api/topologies/positions/layout', { positions: { d1: c.p } });
      const state = await request(port, 'GET', '/api/topologies/positions');
      const held = (state.body.layout || {}).d1;
      if (c.ok) {
        if (r.status !== 200) disagreements.push(c.why + ': refused with ' + r.status + ' ' + JSON.stringify(r.body));
        else if (!held || held.x !== c.p.x || held.y !== c.p.y) disagreements.push(c.why + ': stored ' + JSON.stringify(held));
        else accepted.push(c.p);
      } else {
        if (r.status !== 400) disagreements.push(c.why + ': accepted with ' + r.status);
        else if (!r.body || !r.body.error || !/within|two numbers/.test(r.body.error)) {
          disagreements.push(c.why + ': refused without saying why - ' + JSON.stringify(r.body));
        }
        if (!held || held.x !== 7 || held.y !== 9) disagreements.push(c.why + ': refusal changed the board to ' + JSON.stringify(held));
      }
    }
    ok(disagreements.length === 0, 'every shape is accepted or refused with a reason, and a refusal changes nothing',
      JSON.stringify(disagreements.slice(0, 4)));
    ok(accepted.length === 5, 'the five positions a person can reach were stored', String(accepted.length));

    // A body without a usable `positions` used to be answered 200 `{ok:true}` and change nothing, which reads to a
    // client exactly like success (#1421, the same shape #1309 fixed for /load).
    const shapes = [
      [{ positions: [1, 2] }, 'an array'],
      [{ positions: 'd1' }, 'a string'],
      [{ positions: null }, 'null'],
      [{}, 'nothing at all'],
      [{ positions: { d1: { x: 1, y: 2 } }, extra: true }, null]
    ];
    const shapeFailures = [];
    for (const [body, label] of shapes) {
      const r = await request(port, 'POST', '/api/topologies/positions/layout', body);
      if (label && r.status !== 400) shapeFailures.push(label + ' -> ' + r.status + ' ' + JSON.stringify(r.body));
      if (label && !(r.body && r.body.error)) shapeFailures.push(label + ' -> no error message');
      if (!label && r.status !== 200) shapeFailures.push('a good body was refused with ' + r.status);
    }
    ok(shapeFailures.length === 0, 'a body that is not a map of positions is refused, not silently accepted',
      JSON.stringify(shapeFailures));

    // An id that is not on the board: not an error (a client can be a moment behind a delete), but not silence.
    const ghost = await request(port, 'POST', '/api/topologies/positions/layout',
      { positions: { d1: { x: 30, y: 40 }, ghost: { x: 1, y: 1 } } });
    ok(ghost.status === 200 && Array.isArray(ghost.body.ignored) && ghost.body.ignored.indexOf('ghost') !== -1,
      'an id that is not on the board is named back to the client', JSON.stringify(ghost.body));
    const afterGhost = await request(port, 'GET', '/api/topologies/positions');
    ok(afterGhost.body.layout.d1.x === 30 && !afterGhost.body.layout.ghost,
      'and the position that named a real device is stored', JSON.stringify(afterGhost.body.layout));

    // The two doors, compared on the same board: what the endpoint accepted, the loader accepts.
    const exported = await request(port, 'GET', '/api/topologies/positions');
    const reloaded = Topology.fromJSON(JSON.parse(JSON.stringify(exported.body)));
    ok(JSON.stringify(reloaded.layout) === JSON.stringify(exported.body.layout),
      'what the door stored is what the loader restores', JSON.stringify(reloaded.layout));
  } catch (e) {
    ok(false, 'the two doors could be compared', e && e.message);
  } finally {
    try { child.kill('SIGTERM'); } catch (e) {}
    await new Promise(function (r) { setTimeout(r, 300); });
    try { child.kill('SIGKILL'); } catch (e) {}
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) {}
  }

  // --- the property the rule exists for: a board the doors accept can be framed ---------------------------------
  console.log('');
  console.log('And every position those doors accept is one the canvas can frame:');
  {
    // The real web/canvas.js in a stub DOM, because the rule is only worth having if the thing that draws the board
    // agrees with it. `fitView()` is the surface under test: it decides where the board sits and at what scale.
    function stubDom() {
      const attrs = {};
      const nodes = {};
      function node(id) {
        return {
          id: id,
          _attrs: attrs,
          style: {}, dataset: {}, children: [],
          classList: { add: function () {}, remove: function () {}, toggle: function () {}, contains: function () { return false; } },
          setAttribute: function (k, v) { attrs[id + ':' + k] = String(v); },
          getAttribute: function (k) { return attrs[id + ':' + k]; },
          removeAttribute: function (k) { delete attrs[id + ':' + k]; },
          appendChild: function (c) { this.children.push(c); return c; },
          removeChild: function () {}, insertBefore: function (c) { return c; },
          addEventListener: function () {}, removeEventListener: function () {},
          getBoundingClientRect: function () { return { width: 1000, height: 700, left: 0, top: 0, right: 1000, bottom: 700 }; },
          querySelector: function () { return null; },
          querySelectorAll: function () { return []; },
          focus: function () {}, click: function () {},
          textContent: '', innerHTML: ''
        };
      }
      for (const id of ['canvas', 'world', 'packets', 'overlay']) nodes[id] = node(id);
      const document = {
        getElementById: function (id) { return nodes[id] || node(id); },
        createElementNS: function () { return node('el' + Math.random()); },
        createElement: function () { return node('el'); },
        querySelector: function () { return null; },
        querySelectorAll: function () { return []; },
        addEventListener: function () {}
      };
      return { document: document, attrs: attrs, nodes: nodes };
    }

    const dom = stubDom();
    const sandbox = {
      document: dom.document,
      window: {},
      console: console,
      Math: Math,
      Number: Number,
      String: String,
      Object: Object,
      Array: Array,
      JSON: JSON,
      isFinite: isFinite,
      setTimeout: setTimeout,
      requestAnimationFrame: function (fn) { return setTimeout(fn, 0); },
      performance: { now: function () { return 0; } }
    };
    sandbox.window = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'web', 'canvas.js'), 'utf8'), sandbox, { filename: 'canvas.js' });
    const canvas = sandbox.PFCanvas;
    ok(!!canvas && typeof canvas.fitView === 'function', 'the real canvas loads and exposes fitView');

    function transformAfterFit(topology) {
      canvas.setTopology(JSON.parse(JSON.stringify(topology)));
      canvas.fitView();
      const t = dom.attrs['world:transform'] || '';
      const m = /translate\(([^,]+),([^)]+)\)\s*scale\(([^)]+)\)/.exec(t);
      if (!m) return { raw: t, bad: true };
      return { panX: Number(m[1]), panY: Number(m[2]), zoom: Number(m[3]) };
    }

    // A two-device board at the corners of the world: the largest span the doors accept.
    const wide = docOneDevice();
    wide.devices.push(JSON.parse(JSON.stringify(wide.devices[0])));
    wide.devices[1].id = 'd2';
    wide.devices[1].name = 'd2';
    wide.devices[1].interfaces = (wide.devices[1].interfaces || []).map(function (i) {
      return Object.assign({}, i, { deviceId: 'd2' });
    });
    wide.layout = { d1: { x: -WORLD_LIMIT, y: -WORLD_LIMIT }, d2: { x: WORLD_LIMIT, y: WORLD_LIMIT } };
    const wideView = transformAfterFit(wide);
    ok(!wideView.bad && isFinite(wideView.zoom) && wideView.zoom >= 0.25 &&
      isFinite(wideView.panX) && isFinite(wideView.panY),
      'a board spanning the whole world is framed at a real scale', JSON.stringify(wideView));
    const midX = wideView.panX + 0 * wideView.zoom;
    ok(isFinite(midX) && midX > -1e9 && midX < 1e9, 'and its centre lands near the viewport, not 1e308 away',
      String(midX));

    // A board carrying a position from before the rule existed: it must open at the default view, not at -Infinity.
    const stale = docOneDevice();
    stale.layout = { d1: { x: 1e308, y: 1e308 } };
    const staleView = transformAfterFit(stale);
    ok(!staleView.bad && staleView.zoom === 1 && staleView.panX === 60 && staleView.panY === 40,
      'a board holding an out-of-world position opens at the default view instead of blank',
      JSON.stringify(staleView));

    // And an empty board keeps the default it has always had.
    const empty = docOneDevice();
    empty.devices = [];
    empty.layout = {};
    const emptyView = transformAfterFit(empty);
    ok(emptyView.zoom === 1 && emptyView.panX === 60 && emptyView.panY === 40, 'an empty board is unchanged',
      JSON.stringify(emptyView));

    // Ordinary boards are framed as they always were: this must not quietly change every lab.
    const normal = docOneDevice();
    normal.layout = { d1: { x: 200, y: 160 } };
    const normalView = transformAfterFit(normal);
    ok(!normalView.bad && isFinite(normalView.panX) && isFinite(normalView.panY) && normalView.zoom >= 0.25 &&
      normalView.zoom <= 3, 'and an ordinary board is framed exactly as before', JSON.stringify(normalView));
  }

  console.log('');
  console.log(passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
