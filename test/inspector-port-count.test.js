'use strict';
// The inspector header is a summary, and it has to summarise what is under it (#1299).
//
// `renderDeviceTab()` drew "28 ports · 28 up" on a switch with **nothing plugged in** - the count was of
// `enabled`, and the word was "up". Two lines above it the front panel painted every one of those sockets
// `notconnect`, and the console said `down (no cable)` for all 28. Three surfaces, two answers, and the
// disagreement was in the line people actually read: the summary.
//
// So the header now counts with the same `portVerdict()` the rows and the front panel use, and accounts for
// every port that is not up by reason instead of dropping it. This file pins the header against the console,
// case by case - the panel and the console are separate code, and the only thing keeping them honest is a test
// that compares them.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { Topology, Simulator } = require('../engine');
const { CliSession } = require('../engine/cli');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const ROOT = path.join(__dirname, '..');
const catalog = loadCatalog(path.join(ROOT, 'devices')).filter(function (s) { return !s.error; });
const spec = function (model) {
  const s = catalog.find(function (x) { return x.model === model; });
  if (!s) throw new Error('missing spec ' + model);
  return s;
};
const SW = spec('CX 6000 24G CL4 PoE 4SFP 370W');
const PD = spec('UCG-Ultra');
const ROUTER = spec('generic-router');

// A DOM stub just real enough for renderDeviceTab(), which only builds a string.
function fakeNode() {
  const base = {
    innerHTML: '', textContent: '', value: '', style: {}, dataset: {},
    classList: { add: function () {}, remove: function () {}, toggle: function () {}, contains: function () { return false; } },
    addEventListener: function () {}, removeEventListener: function () {},
    appendChild: function () { return fakeNode(); }, append: function () {},
    setAttribute: function () {}, getAttribute: function () { return null; },
    removeAttribute: function () {}, remove: function () {}, focus: function () {}, click: function () {},
    querySelector: function () { return fakeNode(); }, querySelectorAll: function () { return []; },
    closest: function () { return null; }
  };
  return new Proxy(base, {
    get: function (t, k) { return k in t ? t[k] : function () { return fakeNode(); }; },
    set: function (t, k, v) { t[k] = v; return true; }
  });
}
const wrap = {
  _html: '', get innerHTML() { return this._html; }, set innerHTML(v) { this._html = v; },
  addEventListener: function () {}, style: {},
  classList: { add: function () {}, remove: function () {}, toggle: function () {}, contains: function () { return false; } },
  querySelector: function () { return fakeNode(); }, querySelectorAll: function () { return []; },
  setAttribute: function () {}, getAttribute: function () { return null; }
};

function loadPanel() {
  const ctx = {
    console: console, setTimeout: setTimeout, clearTimeout: clearTimeout, setInterval: setInterval,
    fetch: function () { return Promise.resolve({ ok: true, json: function () { return Promise.resolve({}); } }); },
    document: {
      addEventListener: function () {},
      querySelector: function () { return wrap; },
      querySelectorAll: function () { return []; }
    },
    window: {},
    PFCanvas: { on: {}, setTopology: function () {}, fitView: function () {}, render: function () {},
      setSelected: function () {}, setSelectedLink: function () {}, animateEvents: function () {}, zoomBy: function () {} }
  };
  ctx.window.PFCanvas = ctx.PFCanvas;
  vm.createContext(ctx);
  // The page loads the faceplate first, and the header depends on the rule it owns.
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'web', 'faceplate.js'), 'utf8'), ctx,
    { filename: 'web/faceplate.js' });
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'web', 'app.js'), 'utf8'), ctx, { filename: 'web/app.js' });
  return ctx.window.__pf;
}

const pf = loadPanel();

// The console's own answer for one port: the status line of `show interfaces <port>`, without the protocol
// column and without a trailing redundant "(shut down)".
function cliLabels(env) {
  const out = {};
  const s = new CliSession(env.dev, env.t, new Simulator(env.t));
  for (const port of env.dev.interfaces.keys()) {
    const lines = s.run('show interfaces ' + port).output;
    const line = lines.filter(function (l) { return /^\s+status:/.test(l); })[0] || '';
    let text = line.replace(/^\s+status:\s*/, '').replace(/, protocol:.*$/, '').trim();
    if (text === 'administratively down (shut down)') text = 'administratively down';
    out[port] = text;
  }
  return out;
}

function headerFor(env) {
  const state = JSON.parse(JSON.stringify(env.t.serialize()));
  pf.setTopology(state);
  pf.selectDevice(env.dev.id);
  pf.renderDeviceTab();
  const m = /iface-count">([^<]*)</.exec(wrap._html);
  return m ? m[1] : null;
}

// The header rendered into {up: n, groups: {label: n}}.
function parseHeader(text) {
  const parts = (text || '').split(' · ');
  const out = { up: null, groups: {}, parts: parts };
  for (const p of parts) {
    const m = /^(\d+) (.*)$/.exec(p);
    if (!m) continue;
    const n = Number(m[1]);
    const label = m[2];
    if (label === 'up') out.up = n;
    else if (/^ports?$/.test(label)) out.total = n;
    else out.groups[label] = n;
  }
  return out;
}

function lab(kind) {
  const t = new Topology();
  if (kind === 'router-cabled') {
    const r = t.addDevice(ROUTER, 'r'); r.name = 'R1';
    const p = t.addDevice(PD, 'p'); p.name = 'P1';
    const ports = [...r.interfaces.keys()].filter(function (n) { return /^Gi/.test(n); });
    t.connect(p.id, 'port1', r.id, ports[0]);
    return { t: t, dev: r, label: 'a router with one live cable' };
  }
  const sw = t.addDevice(SW, 'sw'); sw.name = 'SW1';
  if (kind === 'empty') return { t: t, dev: sw, label: 'a switch with nothing plugged in' };
  const pd = t.addDevice(PD, 'pd'); pd.name = 'PD1';
  t.connect(pd.id, 'port1', sw.id, '1/1/1');
  if (kind === 'live') return { t: t, dev: sw, label: 'one cable to a live peer' };
  if (kind === 'peer-shut') {
    pd.interfaces.get('port1').enabled = false;
    return { t: t, dev: sw, label: 'a cable to a peer whose port is shut down' };
  }
  if (kind === 'link-down') {
    [...t.links.values()][0].state = 'down';
    return { t: t, dev: sw, label: 'a cable whose link was taken down' };
  }
  if (kind === 'admin-down') {
    sw.interfaces.get('1/1/1').enabled = false;
    return { t: t, dev: sw, label: 'a cabled port that is administratively down' };
  }
  if (kind === 'mixed') {
    sw.interfaces.get('1/1/1').enabled = false;
    sw.interfaces.get('1/1/2').enabled = false;
    const pd2 = t.addDevice(PD, 'pd2'); pd2.name = 'PD2';
    t.connect(pd2.id, 'port1', sw.id, '1/1/3');
    pd.interfaces.get('port1').enabled = false;
    return { t: t, dev: sw, label: 'a mixture: two shut ports, a dead peer, an idle port' };
  }
  throw new Error('unknown case ' + kind);
}

const cases = ['empty', 'live', 'peer-shut', 'link-down', 'admin-down', 'mixed', 'router-cabled'];

console.log('');
console.log('The header counts the same ports the console calls up:');
{
  const bad = [];
  for (const kind of cases) {
    const env = lab(kind);
    const hdr = parseHeader(headerFor(env));
    const labels = cliLabels(env);
    const cliUp = Object.keys(labels).filter(function (p) { return labels[p] === 'up'; }).length;
    if (hdr.up !== cliUp) bad.push(kind + ': header says ' + hdr.up + ' up, console says ' + cliUp);
  }
  ok(bad.length === 0, cases.length + ' situations, header up-count == console up-count', JSON.stringify(bad));
}

console.log('');
console.log('...and accounts for every port that is not up, by reason:');
{
  const bad = [];
  for (const kind of cases) {
    const env = lab(kind);
    const hdr = parseHeader(headerFor(env));
    const labels = cliLabels(env);
    const ports = Object.keys(labels);

    // Every port is in exactly one bucket.
    const counted = (hdr.up || 0) + Object.keys(hdr.groups).reduce(function (n, k) { return n + hdr.groups[k]; }, 0);
    if (counted !== ports.length) bad.push(kind + ': header accounts for ' + counted + ' of ' + ports.length);

    // Each bucket's count is the number of ports the console describes that way.
    for (const label of Object.keys(hdr.groups)) {
      const cliCount = ports.filter(function (p) { return labels[p].indexOf(label) === 0; }).length;
      if (cliCount !== hdr.groups[label]) {
        bad.push(kind + ': header says ' + hdr.groups[label] + ' "' + label + '", console says ' + cliCount);
      }
    }
    // ...and no port the console calls up is left in a down bucket, or vice versa.
    const cliDownLabels = {};
    for (const p of ports) if (labels[p] !== 'up') cliDownLabels[labels[p]] = true;
    for (const label of Object.keys(cliDownLabels)) {
      const matched = Object.keys(hdr.groups).some(function (g) { return label.indexOf(g) === 0; });
      if (!matched) bad.push(kind + ': console says "' + label + '", header never mentions it');
    }
  }
  ok(bad.length === 0, cases.length + ' situations, every down port named by reason', JSON.stringify(bad));
}

console.log('');
console.log('The defect itself, in the words it was reported in:');
{
  const env = lab('empty');
  const text = headerFor(env);
  ok(text && /· 0 up\b/.test(text), 'a switch with nothing plugged in does not claim a single port up', text);
  ok(text && /down \(no cable\)/.test(text), 'and says why every port is down', text);
  ok(!/28 up/.test(text || ''), 'the old sentence is gone', text);
}

console.log('');
console.log('The header stays readable rather than becoming a second table:');
{
  const env = lab('mixed');
  const hdr = parseHeader(headerFor(env));
  ok(hdr.parts.length <= 4, 'at most four segments', JSON.stringify(hdr.parts));
  ok(/^\d+ ports? · /.test(headerFor(env) || ''), 'total first, then up, then reasons', headerFor(env));
  // A one-port device says "port", not "ports". Nothing in the catalogue has exactly one interface, so this
  // is a synthetic device - the singular is about the sentence, not about any particular part.
  const one = pf.interfacesHeader({ id: 'solo', interfaces: [{ name: 'Gi0/0', enabled: true }] });
  ok(/^1 port · /.test(one.text), 'a one-port device reads "1 port"', one.text);
}

console.log('');
console.log('With the state rule missing the header admits it instead of guessing:');
{
  // A deployment where faceplate.js failed to load: the old code fell back to `enabled` and would have
  // claimed every port up again. The header now says it does not know.
  const ctx = {
    console: console, setTimeout: setTimeout, clearTimeout: clearTimeout, setInterval: setInterval,
    fetch: function () { return Promise.resolve({ ok: true, json: function () { return Promise.resolve({}); } }); },
    document: {
      addEventListener: function () {},
      querySelector: function () { return { _h: '', get innerHTML() { return this._h; }, set innerHTML(v) { this._h = v; },
        addEventListener: function () {}, style: {}, classList: { add: function () {}, remove: function () {}, toggle: function () {} },
        querySelector: function () { return fakeNode(); }, querySelectorAll: function () { return []; } }; },
      querySelectorAll: function () { return []; }
    },
    window: {},
    PFCanvas: { on: {}, setTopology: function () {}, fitView: function () {}, render: function () {},
      setSelected: function () {}, setSelectedLink: function () {}, animateEvents: function () {}, zoomBy: function () {} }
  };
  ctx.window.PFCanvas = ctx.PFCanvas;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'web', 'app.js'), 'utf8'), ctx, { filename: 'web/app.js' });
  const panel = ctx.window.__pf;
  const env = lab('empty');
  const state = JSON.parse(JSON.stringify(env.t.serialize()));
  panel.setTopology(state);
  const hdr = panel.interfacesHeader(state.devices.find(function (d) { return d.id === env.dev.id; }));
  ok(hdr.up === 0, 'no port is called up when the rule is absent', JSON.stringify(hdr));
  ok(/unknown/.test(hdr.text), 'and the header says the state is unknown', hdr.text);
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
