'use strict';
// The packet log is the panel whose job is to explain what happened to a frame (#1475).
//
// It renders every simulation event through one switch. A type that switch does not know falls through to
// `default: return e.type` - so the row reads `flow-refused`, or `vrrp`, or `tap`. Not an error, not a blank: a
// row that names a mechanism instead of saying what happened, in the place a learner goes to find out. Seventeen
// of the fifty-four event types were in that state, including one added the day before this test existed.
//
// So the test does not check a hand-written list. It enumerates the types from the engine's own source - every
// `_emit({ type: '...' })` and `events.push({ type: '...' })` - and requires the legend to know each one, so a new
// event cannot land in the log without a sentence, and a legend case cannot outlive the event it describes.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const ROOT = path.join(__dirname, '..');
const ENGINE = path.join(ROOT, 'engine');

// --- what the engine can emit -------------------------------------------------
function emittedTypes() {
  const types = new Set();
  const re = /(?:\._emit|events\.push)\(\s*\{\s*type:\s*'([a-z0-9-]+)'/g;
  for (const file of fs.readdirSync(ENGINE).filter(function (f) { return /\.js$/.test(f); })) {
    const src = fs.readFileSync(path.join(ENGINE, file), 'utf8');
    let m;
    while ((m = re.exec(src)) !== null) types.add(m[1]);
  }
  return Array.from(types).sort();
}

// --- the real UI, in a stub DOM (the same way test/ui-render.test.js loads it) --
function loadUi() {
  const el = function () {
    return {
      textContent: '', innerHTML: '', value: '', checked: false, style: {}, dataset: {},
      classList: { add: function () {}, remove: function () {}, toggle: function () {}, contains: function () { return false; } },
      appendChild: function () {}, removeChild: function () {}, remove: function () {},
      addEventListener: function () {}, removeEventListener: function () {}, focus: function () {}, blur: function () {},
      setAttribute: function () {}, getAttribute: function () { return null; }, hasAttribute: function () { return false; },
      querySelector: function () { return null; }, querySelectorAll: function () { return []; },
      getBoundingClientRect: function () { return { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 }; },
      getContext: function () { return null; }, cloneNode: function () { return el(); },
      children: [], childNodes: [], firstChild: null, parentNode: null
    };
  };
  // Same shape test/ui-render.test.js loads app.js with: a bare `window` object carrying the canvas stub, and
  // just enough document for the boot path to run to the point where it publishes window.__pf.
  const ctx = {
    console: console,
    setTimeout: function () {}, clearTimeout: function () {}, setInterval: function () {}, clearInterval: function () {},
    requestAnimationFrame: function () {}, cancelAnimationFrame: function () {},
    localStorage: { getItem: function () { return null; }, setItem: function () {}, removeItem: function () {} },
    location: { href: '', search: '', hash: '', origin: 'http://localhost' },
    navigator: { userAgent: 'node' },
    fetch: function () {
      return Promise.resolve({ ok: true, json: function () { return Promise.resolve({}); }, text: function () { return Promise.resolve(''); } });
    },
    WebSocket: function () { this.send = function () {}; this.close = function () {}; this.addEventListener = function () {}; },
    document: {
      getElementById: function () { return el(); },
      querySelector: function () { return el(); },
      querySelectorAll: function () { return []; },
      createElement: function () { return el(); },
      addEventListener: function () {},
      body: el(), documentElement: el(), head: el()
    },
    alert: function () {}, confirm: function () { return false; }, prompt: function () { return null; },
    window: {}
  };
  ctx.window.PFCanvas = {
    on: {}, setTopology: function () {}, fitView: function () {}, render: function () {},
    setSelected: function () {}, setSelectedLink: function () {}, animateEvents: function () {}, zoomBy: function () {}
  };
  ctx.PFCanvas = ctx.window.PFCanvas;   // app.js refers to the canvas bare as well as through window
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'web', 'app.js'), 'utf8'), ctx, { filename: 'app.js' });
  return ctx.window.__pf;
}

// --- what each emit site actually provides ------------------------------------
//
// The strongest property here is static: a legend case may only read fields the event carries. That catches the
// other half of the same bug - a sentence that prints "undefined" because it was written against a payload from
// memory rather than from the source.
function emitSites() {
  const sites = [];
  const re = /(?:._emit|events\.push)\(\s*\{([\s\S]*?)\}\)\s*;/g;
  for (const file of fs.readdirSync(ENGINE).filter(function (f) { return /\.js$/.test(f); })) {
    const src = fs.readFileSync(path.join(ENGINE, file), 'utf8');
    let m;
    while ((m = re.exec(src)) !== null) {
      const body = m[1];
      const t = /type:\s*'([a-z0-9-]+)'/.exec(body);
      if (!t) continue;
      const keys = [];
      const kre = /(?:^|[,{])\s*([A-Za-z0-9_]+)\s*:/g;
      let k;
      while ((k = kre.exec(body)) !== null) keys.push(k[1]);
      sites.push({ type: t[1], keys: keys, file: file });
    }
  }
  return sites;
}

// The fields a legend case reads, and how it reads them (an array is only needed when the case joins or maps).
function legendReads(pf) {
  const src = fs.readFileSync(path.join(ROOT, 'web', 'app.js'), 'utf8');
  const i = src.indexOf('function describeEvent(e)');
  const body = src.slice(i, src.indexOf('default: return e.type', i));
  const out = {};
  const re = /case '([a-z0-9-]+)':([\s\S]*?)(?=case '|default:|$)/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    const type = m[1], text = m[2];
    const fields = [];
    const fre = /e\.([A-Za-z0-9_]+)/g;
    let f;
    while ((f = fre.exec(text)) !== null) {
      if (fields.indexOf(f[1]) === -1) fields.push(f[1]);
    }
    // A field is read as a list when the sentence joins, maps, filters or counts it - including through the
    // `(e.x || []).join(...)` guard, which is the shape most of these use.
    const arrays = fields.filter(function (name) {
      return new RegExp('e\.' + name + '\b[^;]{0,40}\b(join|map|filter|length)\b').test(text);
    });
    out[type] = { fields: fields, arrays: arrays };
  }
  return out;
}

function payloadFor(site, reads) {
  const p = { type: site.type };
  for (const key of site.keys) {
    if (key === 'type') continue;
    p[key] = (reads && reads.arrays.indexOf(key) !== -1) ? ['ONE', 'TWO'] : 'VAL';
  }
  return p;
}

console.log('');
console.log('The legend knows every event the engine can emit:');
const types = emittedTypes();
const pf = loadUi();
ok(types.length > 40, 'the enumeration found the engine\'s event types', types.length + ' types');
ok(typeof pf.describeEvent === 'function', 'the UI exposes its legend, so the test reads the real one');
// Without the export every line below degrades to the bare type and the suite says so, instead of throwing on the
// first call and reporting one opaque failure.
const describe = function (e) {
  return typeof pf.describeEvent === 'function' ? pf.describeEvent(e) : (e && e.type);
};

const sites = emitSites();
const reads = legendReads(pf);
ok(sites.length > 40, 'the enumeration found the emit sites', sites.length + ' sites');

const missing = types.filter(function (t) { return !reads[t]; });
ok(missing.length === 0, 'no emitted type falls through to its bare name', missing.join(', '));
console.log('    (' + types.length + ' event types, ' + sites.length + ' emit sites checked)');

console.log('');
console.log('Each line says what happened, from the fields the event actually carries:');
{
  // A case may only read fields its event provides. This is the half of the bug a render check misses: a
  // sentence written against a remembered payload prints "undefined" in the one panel meant to explain things.
  const invented = [];
  for (const t of types) {
    if (!reads[t]) continue;
    const provided = new Set();
    for (const site of sites) {
      if (site.type === t) site.keys.forEach(function (k) { provided.add(k); });
    }
    for (const field of reads[t].fields) {
      if (field === 'type') continue;
      if (!provided.has(field)) invented.push(t + ' reads e.' + field + ' (not on the wire)');
    }
  }
  ok(invented.length === 0, 'no case reads a field its event does not carry', invented.slice(0, 8).join(' | '));

  // And rendering every real payload shape produces a sentence, not a hole.
  const holes = [];
  const raws = [];
  for (const site of sites) {
    const payload = payloadFor(site, reads[site.type]);
    let line;
    try { line = String(describe(payload) || ''); }
    catch (err) { line = 'THREW ' + (err && err.message); }
    if (line.trim() === '' || line.trim() === site.type) raws.push(site.type + ' -> ' + JSON.stringify(line));
    if (/undefined|NaN|\[object Object\]/.test(line)) holes.push(site.type + ' -> ' + line);
  }
  ok(raws.length === 0, 'every emit site renders as a sentence, never as its bare type', raws.slice(0, 6).join(' | '));
  ok(holes.length === 0, 'and no site renders undefined, NaN or [object Object]', holes.slice(0, 6).join(' | '));
}

console.log('');
console.log('An unknown type is still survivable:');
const bare = types.map(function (t) { return String(describe({ type: t }) || ''); });
ok(bare.every(function (l) { return l.trim().length > 0; }),
  'a payload with no fields still produces a line, so a partial event cannot blank the log',
  bare.filter(function (l) { return l.trim().length === 0; }).join(', '));
ok(String(describe({ type: 'no-such-event' })) === 'no-such-event',
  'a type nothing knows is passed through rather than dropped');

console.log('');
console.log('The families are told apart in the log:');
{
  const line = function (o) { return String(describe(o)); };
  ok(/ARP CONFLICT/.test(line({ type: 'arp-conflict', dev: 'r1', iface: 'Gi0/0/1', ip: '10.0.0.10', macs: ['A', 'B'] })),
    'a duplicate address reads as a conflict');
  ok(/answered by A and B/.test(line({ type: 'arp-conflict', dev: 'r1', iface: 'Gi0/0/1', ip: '10.0.0.10', macs: ['A', 'B'] })),
    'naming both claimants');
  ok(/FLOW 4 TCP SRCIP:1234 → DSTIP:80/.test(line({ type: 'flow-open', flow: 4, proto: 'tcp', src: 'SRCIP', srcPort: 1234, dst: 'DSTIP', dstPort: 80, phase: 'syn' })),
    'a flow names its two ends and its number');
  ok(/NAT DROP r1  SRCIP → DSTIP/.test(line({ type: 'nat-drop', dev: 'r1', src: 'SRCIP', dst: 'DSTIP', code: 'E_NAT' })),
    'a NAT refusal reads as a drop');
  ok(/TAP INJECT REFUSED r1\/mon0/.test(line({ type: 'tap-inject-refused', dev: 'r1', iface: 'mon0', vlan: 10 })),
    'a refused injection names the port it happened on');
  ok(/VRRP 7 master r1\/Vlan10/.test(line({ type: 'vrrp', vrid: 7, master: 'r1', masterName: 'r1', iface: 'Vlan10', ips: ['10.0.0.254'], priority: 110 })),
    'a VRRP election names the winner');
  ok(/neighbour sw1 on Fa0\/1/.test(line({ type: 'lldp', dev: 'r1', iface: 'Gi0/0/1', neighbour: 'sw1', neighbourPort: 'Fa0/1' })),
    'LLDP names who was discovered and where');
}

console.log('');
console.log('And the legend does not outlive the engine:');
{
  const src = fs.readFileSync(path.join(ROOT, 'web', 'app.js'), 'utf8');
  const i = src.indexOf('function describeEvent(e)');
  const body = src.slice(i, src.indexOf('default: return e.type', i));
  const cases = [];
  const re = /case '([a-z0-9-]+)':/g;
  let m;
  while ((m = re.exec(body)) !== null) cases.push(m[1]);
  const orphans = cases.filter(function (c) { return types.indexOf(c) === -1; });
  ok(orphans.length === 0, 'no legend case describes an event the engine no longer emits', orphans.join(', '));
  ok(cases.length === new Set(cases).size, 'and no type is described twice');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
