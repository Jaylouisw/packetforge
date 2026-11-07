'use strict';
// Cable length is a property of the lead, not of the technology (issue #31).
//
// `lengthM` was plumbed end to end - created in engine/link.js, round-tripped by the
// topology, accepted by the REST layer, displayed by the inspector, and used to drive the
// W_DISTANCE warning - but nothing in the browser could set it. So the picker printed a
// medium's maximum reach in the place a buyer expects the length ("10G DAC (passive) · 7 m")
// and every DAC in a lab was silently installed at its maximum length. A 3 m 10G DAC, which
// is the most ordinary cable in a rack, could not be expressed at all.
const path = require('path');
const fs = require('fs');
const vm = require('vm');
const { Topology } = require('../engine');
const { loadCatalog } = require('../devices/registry');
const media = require('../engine/media');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg); }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));

function sfpPair() {
  // Two devices with SFP+ cages, so a DAC is a legal cable between them.
  const spec = catalog.find(function (s) {
    return (s.interfaces || []).some(function (i) { return i.connector === 'sfp+'; }) &&
           s.category === 'switch';
  });
  const t = new Topology();
  const a = t.addDevice(spec), b = t.addDevice(spec);
  const pa = [...a.interfaces.values()].find(function (i) { return i.hardware.cage === 'sfp+'; });
  const pb = [...b.interfaces.values()].find(function (i) { return i.hardware.cage === 'sfp+'; });
  return { t: t, a: a, b: b, pa: pa, pb: pb };
}

console.log('A 3 m 10G DAC can be built:');
{
  const L = sfpPair();
  const link = L.t.connect(L.a.id, L.pa.name, L.b.id, L.pb.name, { mediaId: 'dac-10g', lengthM: 3 });
  ok(!!link, 'the link forms');
  ok(link.lengthM === 3, 'and records a 3 m lead (' + link.lengthM + ')');
  ok(link.mediaId === 'dac-10g', 'on the passive 10G DAC');
}

console.log('\nLength survives a save and reload:');
{
  const L = sfpPair();
  L.t.connect(L.a.id, L.pa.name, L.b.id, L.pb.name, { mediaId: 'dac-10g', lengthM: 3 });
  const back = Topology.fromJSON(JSON.parse(JSON.stringify(L.t.serialize())));
  const restored = [...back.links.values()][0];
  ok(restored.lengthM === 3, 'the length is still 3 m after a round trip (' + restored.lengthM + ')');
}

console.log('\nA lead longer than the technology reaches is warned about:');
{
  const L = sfpPair();
  const max = media.mediaById('dac-10g').maxRangeM;
  const verdict = L.t.validateLink(L.a.id, L.pa.name, L.b.id, L.pb.name,
    { mediaId: 'dac-10g', lengthM: max + 5 });
  ok(verdict.ok, 'it is not physically impossible, so it is allowed');
  const warn = (verdict.warnings || []).filter(function (w) { return w.code === 'W_DISTANCE'; })[0];
  ok(!!warn, 'but W_DISTANCE fires (' + (warn ? warn.code : 'none') + ')');
  ok(warn && warn.message.indexOf(String(max)) !== -1,
    'and the warning names the reach (' + (warn ? warn.message : '') + ')');
}

console.log('\nA length within reach does not warn:');
{
  const L = sfpPair();
  const verdict = L.t.validateLink(L.a.id, L.pa.name, L.b.id, L.pb.name,
    { mediaId: 'dac-10g', lengthM: 3 });
  const warn = (verdict.warnings || []).filter(function (w) { return w.code === 'W_DISTANCE'; })[0];
  ok(!warn, 'no distance warning for a 3 m lead on a 7 m medium');
}

console.log('');
console.log('The length of an existing cable can be changed:');
{
  const L = sfpPair();
  const link = L.t.connect(L.a.id, L.pa.name, L.b.id, L.pb.name, { mediaId: 'dac-10g' });
  ok(link.lengthM === null, 'a cable created without a length records none');

  const set = L.t.setLinkLength(link.id, 3);
  ok(set.ok, 'the length can be set afterwards');
  ok(link.lengthM === 3, 'and the link carries it (' + link.lengthM + ')');

  const max = media.mediaById('dac-10g').maxRangeM;
  const tooLong = L.t.setLinkLength(link.id, max + 5);
  ok(tooLong.ok, 'an over-length run is allowed');
  ok((tooLong.warnings || []).some(function (w) { return w.code === 'W_DISTANCE'; }),
    'but warned about, the same as at cabling time');

  const bad = L.t.setLinkLength(link.id, -2);
  ok(!bad.ok && bad.errors[0].code === 'E_BAD_LENGTH', 'a negative length is refused (' +
    ((bad.errors[0] || {}).code) + ')');

  const missing = L.t.setLinkLength('l999', 3);
  ok(!missing.ok && missing.errors[0].code === 'E_NO_LINK', 'and so is a link that does not exist');

  const cleared = L.t.setLinkLength(link.id, null);
  ok(cleared.ok && link.lengthM === null, 'and it can be cleared again');
}

console.log('\nThe picker offers the lengths that are actually sold:');
{
  const byId = {};
  ['status-left', 'status-right', 'conn-state'].forEach(function (id) {
    byId[id] = { textContent: '', className: '', title: '', style: {}, children: [],
      appendChild: function (c) { this.children.push(c); return c; },
      setAttribute: function () {}, getAttribute: function () { return null; },
      addEventListener: function () {}, removeEventListener: function () {},
      querySelector: function () { return null; }, querySelectorAll: function () { return []; },
      set innerHTML(v) { this.children.length = 0; }, get innerHTML() { return ''; } };
  });
  function rec(tag) {
    return { tag: tag, attrs: {}, children: [], textContent: '', style: {}, dataset: {},
      appendChild: function (c) { this.children.push(c); return c; },
      setAttribute: function () {}, getAttribute: function () { return null; },
      addEventListener: function () {}, removeEventListener: function () {},
      querySelector: function () { return null; }, querySelectorAll: function () { return []; },
      classList: { add: function () {}, remove: function () {}, toggle: function () {}, contains: function () { return false; } },
      set innerHTML(v) { this.children.length = 0; }, get innerHTML() { return ''; } };
  }
  const PFCanvas = { on: {}, setTopology: function () {}, setSelected: function () {}, fitView: function () {}, render: function () {} };
  const sandbox = {
    console: console,
    document: {
      getElementById: function (id) { return byId[id] || rec('div'); },
      querySelector: function (sel) {
        const s = String(sel);
        if (s.charAt(0) === '#') return byId[s.slice(1)] || rec('div');
        return rec('div');
      },
      querySelectorAll: function () { return []; },
      createElement: rec, createElementNS: function (ns, t) { return rec(t); },
      addEventListener: function () {}, body: rec('body')
    },
    window: {}, location: { protocol: 'http:', host: 'x' },
    fetch: function () { return Promise.resolve({ ok: true, json: function () { return Promise.resolve({}); } }); },
    WebSocket: function () { this.close = function () {}; },
    setTimeout: function () { return 0; }, clearTimeout: function () {},
    setInterval: function () { return 0; }, clearInterval: function () {},
    requestAnimationFrame: function () { return 0; }, performance: { now: function () { return 0; } },
    localStorage: { getItem: function () { return null; }, setItem: function () {} }
  };
  sandbox.window = sandbox; sandbox.globalThis = sandbox;
  sandbox.window.location = sandbox.location;
  sandbox.PFCanvas = PFCanvas; sandbox.window.PFCanvas = PFCanvas;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'web', 'app.js'), 'utf8'), sandbox, { filename: 'app.js' });

  const pick = sandbox.window.__pf.lengthChoicesFor;
  ok(typeof pick === 'function', 'the picker exposes its length table');
  const dac10 = pick('dac', media.mediaById('dac-10g').maxRangeM);
  ok(dac10.indexOf(3) !== -1, 'a 3 m passive 10G DAC is offered (' + dac10.join(', ') + ')');
  ok(dac10.every(function (m) { return m <= media.mediaById('dac-10g').maxRangeM; }),
    'and nothing longer than the medium can carry');
  const copper = pick('copper', 100);
  ok(copper.indexOf(100) !== -1 && copper.indexOf(0.5) !== -1, 'copper offers both patch and run lengths');
  const fibre = pick('fiber', 10000);
  ok(fibre.indexOf(300) !== -1 && fibre.indexOf(10000) !== -1, 'fibre offers building and campus lengths');

  // The label must not present the reach as the length.
  const src = fs.readFileSync(path.join(__dirname, '..', 'web', 'app.js'), 'utf8');
  ok(/up to ' \+ o\.maxRangeM/.test(src), 'the ceiling is labelled "up to N m"');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
