'use strict';
// A cable the engine refuses must not be drawn as a working one (#1305).
//
// `ca11588` gave every state payload a verdict per cable (`state.verdicts`, one verdict per cable, filed under
// the cable that caused it) and taught the inspector to print it. The canvas was the last surface still drawing
// on its own opinion: an impossible cable - copper terminated in a fibre cage, an optic the port cannot seat -
// came out as the same 2 px line as a good one. In a diagram the broken thing has to be the thing you see.
//
// Two kinds of bad, drawn differently on purpose, because they need different fixes:
//
//   * refused (an error)  - dotted red. The cable cannot be what it claims.
//   * caveat  (a warning) - amber. The run is longer than the medium's reach; it links, it just will not carry.
//
// And `link-down` (a cut cable) stays exactly what it was: a cut is a state, not an impossibility.
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

// --- recording stub DOM -------------------------------------------------------------------------------------
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
      if (at !== -1) this.children.splice(at, 1);
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
  setTimeout: function () { return 0; },
  clearTimeout: function () {},
  requestAnimationFrame: function () { return 0; },
  performance: { now: function () { return 0; } },
  localStorage: { getItem: function () { return null; }, setItem: function () {} }
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'web', 'canvas.js'), 'utf8'), sandbox,
  { filename: 'canvas.js' });
const PFCanvas = sandbox.window.PFCanvas || sandbox.PFCanvas;
ok(!!PFCanvas && typeof PFCanvas.render === 'function', 'canvas.js loads and exposes render()');

const catalog = loadCatalog(path.join(__dirname, '..', 'devices')).filter(function (s) { return !s.error; });
const SW = catalog.find(function (s) { return /CX 6000/.test(s.model); });

function doc() {
  const t = new Topology();
  const a = t.addDevice(SW, 'a'); a.name = 'SW1';
  const b = t.addDevice(SW, 'b'); b.name = 'SW2';
  t.connect(a.id, '1/1/1', b.id, '1/1/1');
  return JSON.parse(JSON.stringify(t.serialize()));
}

// The drawn cable - the grab band also carries data-link-id, and it is not the picture.
function drawnCable(state) {
  PFCanvas.render(state);
  const out = [];
  (function walk(n) {
    (n.children || []).forEach(function (c) {
      if (c.tag === 'line' && c.attrs['data-link-id'] && String(c.attrs.class || '').indexOf('link-hit') === -1) {
        out.push(c);
      }
      walk(c);
    });
  })(roots.world);
  return out[0];
}

const verdictsOf = function (issues, extra) {
  const byLink = {};
  for (const i of (issues || [])) (byLink[i.linkId] = byLink[i.linkId] || []).push(i);
  return Object.assign({
    ok: !(issues || []).some(function (i) { return i.severity === 'error'; }),
    errorCount: (issues || []).filter(function (i) { return i.severity === 'error'; }).length,
    warningCount: (issues || []).filter(function (i) { return i.severity === 'warning'; }).length,
    checked: true, byLink: byLink, issues: issues || []
  }, extra || {});
};

console.log('');
console.log('A refused cable is drawn as refused:');
{
  const state = doc();
  state.verdicts = verdictsOf([{ severity: 'error', code: 'E_MEDIA_NOT_SUPPORTED', linkId: state.links[0].id,
    message: '10GBASE-SR is not supported by both Aruba CX 6000/1/1/1 and Aruba CX 6000/1/1/1; possible media: ' +
      '10BASE-T, 100BASE-TX, 1000BASE-T.' }]);
  const line = drawnCable(state);
  const cls = String(line.attrs.class);
  ok(/\blink-invalid\b/.test(cls), 'the cable carries link-invalid', cls);
  ok(!/\blink-down\b/.test(cls), 'and is not confused with a cut cable', cls);
  ok(line.attrs['data-link-valid'] === 'false', 'data-link-valid says false', line.attrs['data-link-valid']);
  ok(line.attrs['data-link-issue'] === 'E_MEDIA_NOT_SUPPORTED', 'the code travels with the drawing',
    line.attrs['data-link-issue']);
  ok(/10BASE-T/.test(line.attrs['data-link-issue-text'] || ''), 'and so does the sentence',
    (line.attrs['data-link-issue-text'] || '').slice(0, 80));
  const title = (line.children || []).filter(function (c) { return c.tag === 'title'; })[0];
  ok(title && /not supported by both/.test(title.textContent), 'with the message on hover, without a click',
    title && title.textContent);
}

console.log('');
console.log('A good cable is not marked, and says so:');
{
  const state = doc();
  state.verdicts = verdictsOf([]);
  const line = drawnCable(state);
  ok(!/link-invalid/.test(String(line.attrs.class)), 'no red', String(line.attrs.class));
  ok(line.attrs['data-link-valid'] === 'true', 'data-link-valid says true', line.attrs['data-link-valid']);
  ok(line.attrs['data-link-issue'] === '', 'and no issue code', JSON.stringify(line.attrs['data-link-issue']));
  ok(!(line.children || []).some(function (c) { return c.tag === 'title'; }), 'and no tooltip to explain');
}

console.log('');
console.log('A caveat is amber, not red:');
{
  const state = doc();
  state.verdicts = verdictsOf([
    { severity: 'warning', code: 'W_DISTANCE', linkId: state.links[0].id,
      message: '5000 m exceeds the 100 m reach of 1000BASE-T.' }
  ]);
  const line = drawnCable(state);
  const cls = String(line.attrs.class);
  ok(/\blink-caveat\b/.test(cls), 'a warning is drawn as a caveat', cls);
  ok(!/link-invalid/.test(cls), 'not as a refusal - the cable does link', cls);
  ok(line.attrs['data-link-valid'] === 'warn', 'and the attribute says warn', line.attrs['data-link-valid']);
  ok(line.attrs['data-link-issue'] === 'W_DISTANCE', 'the code is still carried', line.attrs['data-link-issue']);
}

console.log('');
console.log('A cut cable and an impossible cable are both visible, and distinguishable:');
{
  const state = doc();
  state.links[0].state = 'down';
  state.verdicts = verdictsOf([{ severity: 'error', code: 'E_MEDIA_NOT_SUPPORTED', linkId: state.links[0].id,
    message: 'not supported' }]);
  const cls = String(drawnCable(state).attrs.class);
  ok(/link-down/.test(cls) && /link-invalid/.test(cls), 'both classes, because both are true', cls);

  const cut = doc();
  cut.links[0].state = 'down';
  cut.verdicts = verdictsOf([]);
  const cutCls = String(drawnCable(cut).attrs.class);
  ok(/link-down/.test(cutCls) && !/link-invalid/.test(cutCls), 'a cut cable alone is just cut', cutCls);
}

console.log('');
console.log('No verdict in the payload means no claim:');
{
  const state = doc();
  const line = drawnCable(state);
  ok(line.attrs['data-link-valid'] === 'unchecked', 'the drawing says it could not check',
    line.attrs['data-link-valid']);
  ok(!/link-invalid/.test(String(line.attrs.class)), 'and does not paint a fault it cannot know about',
    String(line.attrs.class));

  const off = doc();
  off.verdicts = { ok: false, errorCount: 0, warningCount: 0, checked: false, byLink: {}, issues: [] };
  ok(drawnCable(off).attrs['data-link-valid'] === 'unchecked',
    'and a verdict object that reports it could not check reads the same');
}

console.log('');
console.log('The verdict is filed per cable, so one bad cable does not redden the lab:');
{
  // Two switches, two cables: one impossible, one fine.
  const t = new Topology();
  const a = t.addDevice(SW, 'a'); a.name = 'SW1';
  const b = t.addDevice(SW, 'b'); b.name = 'SW2';
  t.connect(a.id, '1/1/1', b.id, '1/1/1');
  t.connect(a.id, '1/1/2', b.id, '1/1/2');
  const state = JSON.parse(JSON.stringify(t.serialize()));
  ok(state.links.length === 2, 'the lab has two cables', JSON.stringify(state.links.length));
  state.verdicts = verdictsOf([{ severity: 'error', code: 'E_MEDIA_NOT_SUPPORTED', linkId: state.links[0].id,
    message: 'bad' }]);
  PFCanvas.render(state);
  const lines = [];
  (function walk(n) {
    (n.children || []).forEach(function (c) {
      if (c.tag === 'line' && c.attrs['data-link-id'] && String(c.attrs.class || '').indexOf('link-hit') === -1) {
        lines.push(c);
      }
      walk(c);
    });
  })(roots.world);
  const bad = lines.filter(function (l) { return /link-invalid/.test(String(l.attrs.class)); });
  const good = lines.filter(function (l) { return !/link-invalid/.test(String(l.attrs.class)); });
  ok(bad.length === 1 && good.length === 1, 'exactly one cable is red', JSON.stringify(lines.map(function (l) {
    return l.attrs['data-link-id'] + '=' + l.attrs['data-link-valid'];
  })));
  ok(good[0] && good[0].attrs['data-link-valid'] === 'true', 'the other reads as accepted',
    good[0] && good[0].attrs['data-link-valid']);
}

console.log('');
console.log('Drawing an impossible cable is not allowed to break the frame:');
{
  const state = doc();
  // A verdict with no message, a null issue and an unknown severity - the shapes a future server might send.
  state.verdicts = { ok: false, errorCount: 2, warningCount: 0, checked: true,
    byLink: { [state.links[0].id]: [{ severity: 'error', code: 'E_X' }, null] }, issues: [] };
  let threw = null;
  let line = null;
  try { line = drawnCable(state); } catch (e) { threw = e; }
  ok(!threw, 'a malformed issue does not throw', threw && threw.message);
  ok(line && /link-invalid/.test(String(line.attrs.class)), 'and the cable is still drawn as refused',
    line && String(line.attrs.class));
  ok(line && line.attrs['data-link-issue'] === 'E_X', 'with the code that was there',
    line && line.attrs['data-link-issue']);
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
