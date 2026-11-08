'use strict';

// The create-link panel itself (issue #68).
//
// The engine half is covered by link-options.test.js; this is the part a person actually
// sees - does clicking two devices produce a panel naming the link types and the port pairs,
// and does a refusal arrive as an explanation rather than as nothing at all?
//
// It loads the real web/app.js in a stub DOM with a stubbed fetch, the same way
// test/ui-render.test.js does, because the interesting failures here are wiring failures:
// a wrong URL, a thrown promise, a panel that renders into a detached node.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg); }
}

// --- a stub DOM just rich enough for the modal ----------------------------------------
function makeNode(tag) {
  const node = {
    tagName: (tag || 'div').toUpperCase(),
    className: '',
    innerHTML: '',
    textContent: '',
    style: {},
    dataset: {},
    children: [],
    _listeners: {},
    classList: {
      _set: {},
      add: function (c) { this._set[c] = true; },
      remove: function (c) { delete this._set[c]; },
      toggle: function (c, on) { if (on) this._set[c] = true; else delete this._set[c]; },
      contains: function (c) { return !!this._set[c]; }
    },
    appendChild: function (n) { this.children.push(n); n.parentNode = this; return n; },
    removeChild: function (n) { this.children = this.children.filter(function (x) { return x !== n; }); return n; },
    remove: function () { if (this.parentNode) this.parentNode.removeChild(this); },
    addEventListener: function (ev, fn) { (this._listeners[ev] = this._listeners[ev] || []).push(fn); },
    removeEventListener: function () {},
    setAttribute: function (k, v) { this[k] = v; },
    getAttribute: function (k) { return this[k] === undefined ? null : this[k]; },
    querySelector: function () { return null; },
    querySelectorAll: function () { return []; },
    closest: function () { return null; },
    click: function () {
      const ls = this._listeners.click || [];
      for (const fn of ls) fn({ target: this, preventDefault: function () {} });
    }
  };
  return node;
}

const overlayCapture = [];
const body = makeNode('body');
body.appendChild = function (n) { overlayCapture.push(n); n.parentNode = body; return n; };

const hintNode = makeNode('span');
hintNode.textContent = 'scroll to zoom';

// Every fetch the panel makes, recorded, and answered from `routes`.
const calls = [];
let routes = {};
function fakeFetch(url, opts) {
  calls.push({ url: url, opts: opts || {} });
  for (const prefix of Object.keys(routes)) {
    if (url.indexOf(prefix) === 0) {
      const r = routes[prefix];
      return Promise.resolve({
        ok: r.ok !== false,
        status: r.status || 200,
        statusText: r.statusText || 'OK',
        json: function () { return Promise.resolve(r.json); }
      });
    }
  }
  return Promise.resolve({ ok: true, status: 200, statusText: 'OK', json: function () { return Promise.resolve({}); } });
}

const ctx = {
  console: console,
  setTimeout: setTimeout,
  clearTimeout: clearTimeout,
  setInterval: setInterval,
  setImmediate: setImmediate,
  Promise: Promise,
  JSON: JSON,
  fetch: fakeFetch,
  document: {
    readyState: 'complete',
    addEventListener: function () {},
    querySelector: function (sel) {
      if (sel === '#canvas-hint') return hintNode;
      if (sel === '#btn-link') return makeNode('button');
      return makeNode('div');
    },
    querySelectorAll: function () { return []; },
    getElementById: function () { return null; },
    createElement: function (tag) { return makeNode(tag); },
    body: body
  },
  window: {},
  PFCanvas: {
    on: {},
    setTopology: function () {}, fitView: function () {}, render: function () {},
    setSelected: function () {}, setSelectedLink: function () {},
    animateEvents: function () {}, zoomBy: function () {}
  }
};
ctx.window.PFCanvas = ctx.PFCanvas;
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'web', 'app.js'), 'utf8'), ctx, { filename: 'app.js' });

const pf = ctx.window.__pf;
ok(!!pf && !!pf.linkMode, 'app.js exposes the create-link mode');
ok(typeof pf.linkMode.arm === 'function' && typeof pf.linkMode.select === 'function',
  'with arm() and select() callable');

function lastOverlayHTML() {
  const ov = overlayCapture[overlayCapture.length - 1];
  if (!ov || !ov.children.length) return null;
  return ov.children[0].innerHTML;
}

function flush(n) {
  let p = Promise.resolve();
  for (let i = 0; i < (n || 6); i++) p = p.then(function () { return null; });
  return p;
}

(async function run() {
  console.log('\nArming the mode changes the hint:');
  {
    pf.linkMode.arm(true);
    ok(/click the first device/i.test(hintNode.textContent), 'hint asks for the first device: ' + hintNode.textContent);
    ok(pf.linkMode.state.armed === true, 'the mode is armed');
    pf.linkMode.arm(false);
    ok(pf.linkMode.state.armed === false, 'and disarmable');
    ok(/Scroll to zoom/i.test(hintNode.textContent), 'restoring the normal hint');
  }

  console.log('\nTwo clicks on cablable devices offer link types:');
  {
    routes = {
      '/api/topologies/default/link-options': {
        json: {
          ok: true,
          a: { id: 'd1', name: 'SW1' }, b: { id: 'd2', name: 'PC1' },
          free: { a: 7, b: 1 },
          options: [{
            mediaName: '1000BASE-T', mediaId: '1000base-t', family: 'copper',
            speedMbps: 1000, ports: 2, maxRangeM: 100, warnings: [],
            pairs: [
              { a: { iface: 'Fa0/1', label: 'Fa0/1' }, b: { iface: 'eth0', label: 'eth0' } },
              { a: { iface: 'Fa0/2', label: 'Fa0/2' }, b: { iface: 'eth0', label: 'eth0' } }
            ]
          }],
          refusals: {}
        }
      }
    };
    overlayCapture.length = 0;
    pf.setTopology({ devices: [{ id: 'd1', name: 'SW1' }, { id: 'd2', name: 'PC1' }, { id: 'd3', name: 'FIB1' }] });
    pf.linkMode.arm(true);
    pf.linkMode.select('d1');
    ok(/first device is SW1/i.test(hintNode.textContent), 'the first click names the device: ' + hintNode.textContent);
    pf.linkMode.select('d2');
    await flush(8);

    const html = lastOverlayHTML();
    ok(!!html, 'a panel was rendered');
    ok(html && /Cable SW1/.test(html) && /PC1/.test(html), 'titled with both devices');
    ok(html && /1000BASE-T/.test(html), 'naming the link type');
    ok(html && /1G/.test(html), 'with the negotiated speed (as the UI formats it, 1G)');
    ok(html && /Fa0\/1/.test(html) && /eth0/.test(html), 'and the port pairs to pick from');
    ok(html && /7 free port/.test(html), 'and what is free on each side');
    ok(calls.some(function (c) { return c.url === '/api/topologies/default/link-options'; }),
      'asked the topology-scoped endpoint (' + (calls[0] && calls[0].url) + ')');
    ok(pf.linkMode.state.armed === false, 'and disarms after the pair is chosen');
  }

  console.log('\nA refusal is rendered as a diagnosis, not as silence:');
  {
    routes = {
      '/api/topologies/default/link-options': {
        json: {
          ok: false, code: 'E_CONNECTOR_MISMATCH',
          reason: 'no port pair on SW1 and FIB1 can be cabled (E_CONNECTOR_MISMATCH)',
          options: [], refused: 12,
          refusals: { E_CONNECTOR_MISMATCH: 12 },
          free: { a: 8, b: 4 }
        }
      }
    };
    overlayCapture.length = 0;
    pf.linkMode.arm(true);
    pf.linkMode.select('d1');
    pf.linkMode.select('d3');
    await flush(8);

    const html = lastOverlayHTML();
    ok(!!html, 'a panel was rendered for the refusal too');
    ok(html && /Cannot cable/.test(html), 'which says it cannot be cabled');
    ok(html && /E_CONNECTOR_MISMATCH/.test(html), 'names the code');
    ok(html && /no port pair/.test(html), 'and repeats the reason the engine gave');
    ok(html && /&times;12|12/.test(html), 'with how many pairs were refused');
  }

  console.log('');
  if (failed) { console.log(failed + ' failed, ' + passed + ' passed'); process.exit(1); }
  console.log(passed + ' passed, 0 failed');
})();
