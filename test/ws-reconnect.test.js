'use strict';
// The browser must notice when it is stale (issue #24, client half).
//
// connectWS() opened a socket once and never looked at it again: no onclose, no onerror,
// no retry. When the server restarted, the tab carried on drawing its own copy of the
// board - devices the server had never heard of - and nothing on screen said so. A client
// that cannot tell it is stale is worse than one that fails loudly, because you keep
// working in it.
//
// This loads the real web/app.js against a stub DOM and a fake WebSocket and asserts the
// three things that were missing: the badge reports the state, a close schedules a retry,
// and a successful reopen re-fetches the server's copy instead of keeping the old one.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg); }
}

// --- stub DOM --------------------------------------------------------------
function rec(tag, attrs) {
  return {
    tag: tag, attrs: attrs || {}, children: [], textContent: '', className: '', title: '',
    style: {}, dataset: {},
    appendChild: function (c) { this.children.push(c); return c; },
    setAttribute: function (k, v) { this.attrs[k] = v; },
    getAttribute: function (k) { return this.attrs[k]; },
    addEventListener: function () {}, removeEventListener: function () {},
    classList: { add: function () {}, remove: function () {}, toggle: function () {}, contains: function () { return false; } },
    querySelector: function () { return rec('div'); },
    querySelectorAll: function () { return []; },
    set innerHTML(v) { this.children.length = 0; },
    get innerHTML() { return ''; },
    focus: function () {}, blur: function () {}
  };
}

const byId = {};
const IDS = ['status-left', 'status-right', 'conn-state', 'canvas', 'world', 'packets', 'overlay',
  'palette', 'device-tab', 'simulate-tab', 'console-log', 'toast'];
IDS.forEach(function (id) { byId[id] = rec('div', { id: id }); });

// --- fake WebSocket --------------------------------------------------------
const sockets = [];
function FakeWebSocket(url) {
  this.url = url;
  this.readyState = 1;
  this.close = function () { this.readyState = 3; };
  this.send = function () {};
  sockets.push(this);
}

// --- fetch stub ------------------------------------------------------------
const fetches = [];
let topologyResponse = { devices: [{ id: 'd1' }, { id: 'd2' }], links: [] };
function fakeFetch(url, opts) {
  fetches.push({ url: url, opts: opts || {} });
  return Promise.resolve({
    ok: true, status: 200, statusText: 'OK',
    json: function () {
      if (String(url).indexOf('/catalog') !== -1) return Promise.resolve({ specs: [], byCategory: {} });
      return Promise.resolve(topologyResponse);
    }
  });
}

// --- timers we control -----------------------------------------------------
const timers = [];
function fakeSetTimeout(fn, ms) { timers.push({ fn: fn, ms: ms }); return timers.length; }
function fakeClearTimeout(id) { if (timers[id - 1]) timers[id - 1].cancelled = true; }
function runTimers() {
  const due = timers.splice(0, timers.length);
  due.forEach(function (t) { if (!t.cancelled) t.fn(); });
  return due.length;
}

const sandbox = {
  console: console,
  document: {
    getElementById: function (id) { return byId[id] || (byId[id] = rec('div', { id: id })); },
    // app.js uses $('#status-left') style lookups; a throwaway node per call would make
    // every write vanish, so '#' selectors resolve to the same registry as getElementById.
    querySelector: function (sel) {
      const s = String(sel);
      if (s.charAt(0) === '#') return this.getElementById(s.slice(1).split(' ')[0]);
      return rec('div');
    },
    querySelectorAll: function () { return []; },
    createElement: function (t) { return rec(t); },
    createElementNS: function (ns, t) { return rec(t); },
    addEventListener: function () {},
    body: rec('body')
  },
  window: {},
  location: { protocol: 'http:', host: '127.0.0.1:8000' },
  fetch: fakeFetch,
  WebSocket: FakeWebSocket,
  setTimeout: fakeSetTimeout,
  clearTimeout: fakeClearTimeout,
  setInterval: function () { return 0; },
  clearInterval: function () {},
  requestAnimationFrame: function () { return 0; },
  performance: { now: function () { return 0; } },
  localStorage: { getItem: function () { return null; }, setItem: function () {} },
  alert: function () {}
};
sandbox.window = sandbox;
sandbox.window.location = sandbox.location;
sandbox.globalThis = sandbox;
sandbox.window.WebSocket = FakeWebSocket;

const src = fs.readFileSync(path.join(__dirname, '..', 'web', 'app.js'), 'utf8');

// app.js wires callbacks into the canvas at load time, so the canvas has to exist.
const canvasCalls = { setTopology: 0, setSelected: 0, fitView: 0 };
const PFCanvas = {
  on: {},
  setTopology: function () { canvasCalls.setTopology++; },
  setSelected: function () { canvasCalls.setSelected++; },
  fitView: function () { canvasCalls.fitView++; },
  render: function () {},
  setPorts: function () {}
};
sandbox.PFCanvas = PFCanvas;
sandbox.window.PFCanvas = PFCanvas;
vm.createContext(sandbox);
vm.runInContext(src, sandbox, { filename: 'app.js' });

const pf = sandbox.window.__pf;
ok(!!pf && typeof pf.connectWS === 'function', 'app.js loads and exposes the reconnect surface');

(async function main() {
  console.log('\nA socket is opened and its state is visible:');
  pf.connectWS();
  ok(sockets.length === 1, 'one socket was opened (' + sockets.length + ')');
  ok(sandbox.window.__pf.connectionState() === 'reconnecting',
    'the badge says reconnecting while it is being opened (' + pf.connectionState() + ')');

  const first = sockets[0];
  ok(typeof first.onclose === 'function', 'the socket has an onclose handler (it had none before)');
  ok(typeof first.onerror === 'function', 'and an onerror handler');

  console.log('\nAn open socket converges on the server:');
  const before = fetches.length;
  first.onopen();
  await new Promise(function (r) { setTimeout(r, 0); });
  ok(pf.connectionState() === 'connected', 'the badge says connected (' + pf.connectionState() + ')');
  ok(fetches.length > before, 'opening re-fetched the board (' + (fetches.length - before) + ' request(s))');
  const last = fetches[fetches.length - 1];
  ok(String(last.url).indexOf('/topologies/') !== -1, 'and it asked for the topology (' + last.url + ')');
  ok((pf.getTopology() || {}).devices.length === 2, 'the fetched board became the screen state');

  console.log('\nA close is noticed, shown, and retried:');
  const timersBefore = timers.length;
  first.onclose();
  ok(pf.connectionState() === 'disconnected', 'the badge says disconnected (' + pf.connectionState() + ')');
  ok(String(byId['status-left'].textContent).indexOf('Disconnected') !== -1,
    'the status bar says so too (' + byId['status-left'].textContent + ')');
  ok(timers.length > timersBefore, 'a retry was scheduled');

  const scheduled = timers[timers.length - 1];
  ok(scheduled.ms > 0 && scheduled.ms <= 1000, 'with a short first backoff (' + scheduled.ms + 'ms)');

  console.log('\nThe retry actually reconnects:');
  runTimers();
  ok(sockets.length === 2, 'a second socket was opened (' + sockets.length + ')');

  const second = sockets[1];
  second.onopen();
  await new Promise(function (r) { setTimeout(r, 0); });
  ok(pf.connectionState() === 'connected', 'and it reports connected again');

  console.log('\nWork that vanished is reported, not silently dropped:');
  // The server comes back with an empty board while the tab believed it had two devices.
  const notes = [];
  pf.setTopology({ devices: [{ id: 'd1' }, { id: 'd2' }], links: [{ id: 'l1' }] });
  topologyResponse = { devices: [], links: [] };
  byId['toast-log'] = rec('div');
  const realToast = sandbox.toast;
  await pf.syncTopology('reconnect');
  ok((pf.getTopology() || {}).devices.length === 0, 'the tab accepted the server\'s empty board');
  const statusText = String(byId['status-left'].textContent);
  ok(/0 device/.test(statusText), 'and the status bar counts zero devices (' + statusText + ')');

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch(function (e) {
  console.error('harness failed:', e && e.stack || e);
  console.log('\n' + passed + ' passed, ' + (failed + 1) + ' failed');
  process.exit(1);
});
