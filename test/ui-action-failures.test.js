'use strict';
// A user action that fails must say so, and the canvas must not show what the server refused (#1423).
//
// `web/app.js` reports most of its failures - `api()` records the failed call and rethrows, and nearly every caller
// shows the reason in a toast, a hint or the status bar. One did not:
//
//   PFCanvas.on.move = async function (id, x, y) {
//     topo.layout[id] = { x, y };
//     try { await api('POST', '.../layout', ...) } catch (e) {}      // <- the drag was a save, and the save was lost
//   };
//
// Drag a device while the server is refusing the position (or is simply not there) and the box stays where it was
// dropped: the canvas is showing a lab that is not the lab on disk, and the next reload - or another tab's next
// broadcast - puts it back somewhere else with no explanation. The error reached the bug report and nobody else.
//
// This file guards both halves:
//
//   1. the defect, behaviourally: with the real `web/app.js` in a stub DOM, a drag whose save fails is reported and
//      the box goes back; a drag that saves keeps its position;
//   2. the class, statically: every `catch` in `web/*.js` that wraps a call to `api()` must report to the user -
//      or carry a marker saying why silence is right there, which is a sentence a reviewer has to read.
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

const ROOT = path.join(__dirname, '..');
const WEB = path.join(ROOT, 'web');
const catalog = loadCatalog(path.join(ROOT, 'devices')).filter(function (s) { return !s.error; });

// --- 1. the class: a catch around an api() call reports -------------------------------------------------------------
//
// A tiny scan rather than a regex sweep, because the question is "what is inside this catch block" and a regex cannot
// answer it. Strings and comments are skipped so a brace in a message does not move the block boundary.
function blocks(src) {
  const out = [];
  let i = 0;
  const n = src.length;
  const stack = [];
  while (i < n) {
    const ch = src[i], next = src[i + 1];
    if (ch === '/' && next === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (ch === '/' && next === '*') { i += 2; while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; continue; }
    if (ch === '"' || ch === "'" || ch === '`') {
      const q = ch; i++;
      while (i < n && src[i] !== q) { if (src[i] === '\\') i++; i++; }
      i++; continue;
    }
    if (ch === '{') { stack.push(i); i++; continue; }
    if (ch === '}') {
      const start = stack.pop();
      if (start !== undefined) out.push({ start: start, end: i });
      i++; continue;
    }
    i++;
  }
  return out;
}

function scanCatchSites(src) {
  const all = blocks(src);
  const sites = [];
  const re = /\bcatch\s*(?:\([^)]*\))?\s*\{/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const open = m.index + m[0].length - 1;
    const body = all.filter(function (b) { return b.start === open; })[0];
    if (!body) continue;
    // The try block is the brace block that ends just before this `catch`, across no more than a line or two of
    // whitespace - which is what a try/catch looks like.
    const back = src.slice(0, m.index);
    const tryAt = back.lastIndexOf('try');
    if (tryAt === -1) continue;
    const between = back.slice(tryAt + 3);
    // ordinary control flow: a source scanner looking for the shape of a try block, not a check on a device
    if (!/^\s*\{/.test(between)) continue;
    const tryOpen = tryAt + 3 + between.indexOf('{');
    const tryBlock = all.filter(function (b) { return b.start === tryOpen; })[0];
    if (!tryBlock) continue;
    const tryBody = src.slice(tryBlock.start, tryBlock.end);
    // ordinary control flow: a catch whose try block calls no API call is not what this rule is about
    if (!/\bapi\s*\(/.test(tryBody)) continue;
    sites.push({
      line: src.slice(0, m.index).split('\n').length,
      tryBody: tryBody,
      catchBody: src.slice(body.start, body.end + 1)
    });
  }
  return sites;
}

console.log('Every catch that wraps an api() call says something to the user:');
{
  const REPORTING = [
    /\btoast\s*\(/, /\bsetStatus\s*\(/, /\bsetLinkHint\s*\(/, /\brecordError\s*\(/,
    /\bthrow\b/, /lines\s*\.\s*push\s*\(/, /\/\*\s*silent-ok\s*:/,
    // Writing into the page is telling somebody: a result panel that shows the reason, in the server's words, counts.
    /\binnerHTML\s*=/, /\btextContent\s*=/
  ];
  // console.error alone is not reporting: the person who clicked does not read the console - that was the whole
  // finding of #20, where a redraw that threw produced an empty canvas and "no output anywhere".
  const files = fs.readdirSync(WEB).filter(function (f) { return f.endsWith('.js'); });
  ok(files.length >= 2, 'web/ has the scripts', files.join(', '));

  let scanned = 0;
  const silent = [];
  const marked = [];
  for (const file of files) {
    const src = fs.readFileSync(path.join(WEB, file), 'utf8');
    for (const site of scanCatchSites(src)) {
      scanned++;
      const reports = REPORTING.some(function (re) { return re.test(site.catchBody); });
      if (!reports) silent.push(file + ':' + site.line + ' -> ' + site.catchBody.replace(/\s+/g, ' ').slice(0, 90));
      if (/\/\*\s*silent-ok\s*:/.test(site.catchBody)) {
        const why = /\/\*\s*silent-ok\s*:\s*([^*]*)\*\//.exec(site.catchBody);
        const text = why ? why[1].replace(/\s+/g, ' ').trim() : '';
        if (text.length < 20) marked.push(file + ':' + site.line + ' -> the marker has no reason: "' + text + '"');
      }
    }
  }
  ok(scanned >= 10, 'the scan found the catch sites that call the API', String(scanned));
  ok(silent.length === 0, 'every one of them reports, or carries a reason for not doing so', silent.join(' | '));
  ok(marked.length === 0, 'and every marked silence says why in a sentence', marked.join(' | '));
}

// --- 2. the defect: a drag whose save fails is reported, and the box goes back ---------------------------------------
function stubDom() {
  const nodes = {};
  function node(id) {
    const n = {
      _id: id, textContent: '', innerHTML: '', value: '', checked: false, style: {}, dataset: {},
      classList: { add: function () {}, remove: function () {}, toggle: function () {}, contains: function () { return false; } },
      addEventListener: function () {}, removeEventListener: function () {},
      appendChild: function () { return node('kid'); }, append: function () {},
      setAttribute: function () {}, getAttribute: function () { return null; },
      removeAttribute: function () {}, remove: function () {}, focus: function () {}, click: function () {},
      querySelector: function () { return node('q'); }, querySelectorAll: function () { return []; },
      closest: function () { return null; }, parentElement: null, children: []
    };
    return n;
  }
  const shared = node('shared');
  const document = {
    getElementById: function (id) { return nodes[id] || (nodes[id] = node(id)); },
    querySelector: function (sel) { return nodes[sel] || (nodes[sel] = node(sel)); },
    querySelectorAll: function () { return []; },
    addEventListener: function () {},
    createElement: function () { return node('el'); },
    createElementNS: function () { return node('el'); }
  };
  return { document: document, nodes: nodes, shared: shared };
}

function loadApp(opts) {
  const dom = stubDom();
  const calls = [];
  const ctx = {
    console: { log: function () {}, warn: function () {}, error: function () {} },
    setTimeout: setTimeout, clearTimeout: clearTimeout, setInterval: setInterval, clearInterval: clearInterval,
    fetch: function (url, o) {
      calls.push({ url: url, method: (o && o.method) || 'GET', body: o && o.body });
      if (opts && opts.fail) return Promise.reject(new Error('server is not answering'));
      return Promise.resolve({ ok: true, status: 200, statusText: 'OK', json: function () { return Promise.resolve({ ok: true }); } });
    },
    document: dom.document,
    window: {},
    location: { host: 'localhost', protocol: 'http:', href: 'http://localhost/' },
    navigator: { userAgent: 'test' },
    PFCanvas: {
      on: {}, setTopology: function () {}, fitView: function () {}, render: function () {},
      setSelected: function () {}, setSelectedLink: function () {}, animateEvents: function () {}, zoomBy: function () {},
      ensureGeoCurrent: function () {}, refreshCableGeometry: function () {}, setConnecting: function () {}, setPlacing: function () {}
    },
    WebSocket: function () { this.close = function () {}; }
  };
  ctx.window = ctx;
  ctx.window.PFCanvas = ctx.PFCanvas;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(WEB, 'app.js'), 'utf8'), ctx, { filename: 'app.js' });
  return { ctx: ctx, pf: ctx.window.__pf, calls: calls, dom: dom };
}

const SPEC = catalog.find(function (s) { return s.category === 'switch' && /EKI-5728I/.test(s.model); }) ||
  catalog.find(function (s) { return s.category === 'switch'; });
function oneDevice() {
  const t = new Topology();
  const d = t.addDevice(SPEC, 'd1');
  d.name = 'd1';
  const json = JSON.parse(JSON.stringify(t.serialize()));
  json.layout = { d1: { x: 100, y: 100 } };
  return json;
}

(async function () {
  console.log('');
  console.log('A drag that saves keeps its position, silently:');
  {
    const app = loadApp({ fail: false });
    ok(typeof app.ctx.PFCanvas.on.move === 'function', 'the canvas handler is wired by app.js');
    app.pf.setTopology(oneDevice());
    await app.ctx.PFCanvas.on.move('d1', 320, 240);
    const layout = app.pf.getTopology().layout;
    ok(layout.d1 && layout.d1.x === 320 && layout.d1.y === 240, 'the box is where it was dropped',
      JSON.stringify(layout.d1));
    const posted = app.calls.filter(function (c) { return /\/layout$/.test(c.url); });
    ok(posted.length === 1 && /320/.test(posted[0].body), 'and the position was sent to the server',
      JSON.stringify(posted.map(function (c) { return c.body; })));
    ok(!/Position not saved/.test(app.dom.nodes['#toast'] ? app.dom.nodes['#toast'].textContent : ''),
      'and nothing was complained about');
  }

  console.log('');
  console.log('A drag whose save fails says so, and the box goes back:');
  {
    const app = loadApp({ fail: true });
    app.pf.setTopology(oneDevice());
    await app.ctx.PFCanvas.on.move('d1', 700, 500);
    const layout = app.pf.getTopology().layout;
    ok(layout.d1 && layout.d1.x === 100 && layout.d1.y === 100,
      'the box went back to where the server has it', JSON.stringify(layout.d1));
    const toastEl = app.dom.nodes['#toast'];
    ok(!!toastEl && /Position not saved/.test(toastEl.textContent), 'the user is told',
      toastEl ? toastEl.textContent : 'no toast element');
    ok(!!toastEl && /not answering/.test(toastEl.textContent), 'and told why, in the server\'s own words',
      toastEl ? toastEl.textContent : '');
    const statusEl = app.dom.nodes['#status-left'];
    ok(!!statusEl && /Position not saved/.test(statusEl.textContent), 'the status bar agrees',
      statusEl ? statusEl.textContent : '');

    // A device that had no position at all: the failed save must not leave an invented one behind.
    const fresh = loadApp({ fail: true });
    const doc = oneDevice();
    doc.layout = {};
    fresh.pf.setTopology(doc);
    await fresh.ctx.PFCanvas.on.move('d1', 50, 60);
    ok(!fresh.pf.getTopology().layout.d1, 'a first drag that fails leaves no position behind',
      JSON.stringify(fresh.pf.getTopology().layout));
  }

  console.log('');
  console.log(passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
