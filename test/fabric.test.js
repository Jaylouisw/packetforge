'use strict';
// Fabric capacity: the cages a box has versus the bits it can actually move.
//
// The OptiXtrans E6608 forced this. It is a 2U MS-OTN subrack with six service slots, so a full
// load of B1LDCD boards presents twelve 200G line cages - and the honest figure is 24x 100GE
// client behind an **800 Gbit/s** cross-connect: three times the fabric. The port list said "100G"
// twenty-four times and a note said the rest, which is a note nobody reads at the moment they are
// counting ports.
//
// The subtlety this test pins is the one a naive sum gets wrong: on a muxponder the client port and
// the line port are two ends of one connection, so the fabric carries that service ONCE. Adding
// both sides would report the E6608 as 6x oversubscribed and invent capacity the box does not have.
const path = require('path');
const fs = require('fs');
const vm = require('vm');
const fabric = require('../engine/fabric');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; }
  else { failed++; console.log('  not ok - ' + msg + (detail ? '  [' + detail + ']' : '')); }
}
function eq(a, b, msg) { ok(a === b, msg, 'got ' + JSON.stringify(a) + ', wanted ' + JSON.stringify(b)); }

console.log('');
console.log('A spec may declare a fabric, or not:');
eq(fabric.parseFabric({}), null, 'no fabric field is null, not an error');
eq(fabric.parseFabric({ fabric: null }), null, 'an explicit null is the same');
let threw = false;
try { fabric.parseFabric({ fabric: 800000 }); } catch (e) { threw = true; }
ok(threw, 'a bare number is refused - the shape has to be an object so it can carry a kind');
threw = false;
try { fabric.parseFabric({ fabric: { capacityMbps: -1 } }); } catch (e) { threw = true; }
ok(threw, 'a negative capacity is refused');
const parsed = fabric.parseFabric({ fabric: { capacityMbps: 800000 } });
eq(parsed.capacityMbps, 800000, 'capacity is read');
eq(parsed.kind, 'fabric', 'kind defaults rather than being undefined in the UI');

console.log('');
console.log('Rates in the schema mean what the schema says:');
eq(fabric.speedToMbps('200G'), 200000, '200G is 200 000 Mbps');
eq(fabric.speedToMbps('1G'), 1000, '1G is 1000 Mbps');
eq(fabric.speedToMbps('100M'), 100, '100M is 100 Mbps');
eq(fabric.speedToMbps('2.5G'), 2500, 'a fractional rate survives');
eq(fabric.speedToMbps('867M'), 867, 'a Wi-Fi-class rate is not rounded');
eq(fabric.speedToMbps('fast'), 0, 'junk is zero rather than NaN');
eq(fabric.speedToMbps(1000), 1000, 'a bare number is already Mbps');

console.log('');
console.log('Only ports that reach the fabric are counted:');
const mixed = {
  fabric: { capacityMbps: 100000 },
  interfaces: [
    { name: 'eth1', type: 'ethernet', speed: '10G' },
    { name: 'eth2', type: 'ethernet', speed: '10G' },
    { name: 'con', type: 'console', speed: '1M' },
    { name: 'wlan0', type: 'wireless', speed: '867M' },
    { name: 'wwan0', type: 'wireless', speed: '300M' }
  ]
};
eq(fabric.offeredMbps(mixed), 20000, 'two 10G ports offer 20 Gbit/s; console and radios do not count');

console.log('');
console.log('The far end of a connection is not counted twice:');
const mux = {
  fabric: { capacityMbps: 800000, excludes: ['line*'] },
  interfaces: [
    { name: 'c100g1', type: 'ethernet', speed: '100G' },
    { name: 'c100g2', type: 'ethernet', speed: '100G' },
    { name: 'line1', type: 'ethernet', speed: '200G' },
    { name: 'line2', type: 'ethernet', speed: '200G' }
  ]
};
eq(fabric.offeredMbps(mux), 200000, 'client side only: 2x 100G, not 2x100G + 2x200G');
const noExclude = JSON.parse(JSON.stringify(mux));
delete noExclude.fabric.excludes;
eq(fabric.offeredMbps(noExclude), 600000, 'without the exclusion both sides count - that is the double-count this guards');

console.log('');
console.log('Globs are one feature, not a regex engine:');
ok(fabric.matchesGlob('line1', 'line*') === true, 'line* matches line1');
ok(fabric.matchesGlob('client1', 'line*') === false, 'line* does not match client1');
ok(fabric.matchesGlob('line1', 'line1') === true, 'an exact glob matches exactly');
ok(fabric.matchesGlob('line10', 'line1') === false, 'and does not match a longer name');

console.log('');
console.log('The audit answers the question:');
const audit = fabric.auditFabric(mux);
eq(audit.offeredMbps, 200000, 'the audit counts the same 200G the helper does');
ok(audit.exceeds === false, '200G of client behind an 800G fabric is not oversubscribed');
eq(audit.overByMbps, 0, 'so nothing is over by anything');
// And the shape that does exceed, with the arithmetic stated: 10x 100GE client behind 800G.
const tight = {
  fabric: { capacityMbps: 800000, excludes: ['line*'] },
  interfaces: Array.from({ length: 10 }, function (_, i) { return { name: 'c100g' + (i + 1), type: 'ethernet', speed: '100G' }; })
};
const t = fabric.auditFabric(tight);
eq(t.offeredMbps, 1000000, '10x 100GE offers 1 Tbit/s');
ok(t.exceeds === true, 'which does exceed 800G');
eq(t.overByMbps, 200000, 'by 200 Gbit/s');
eq(t.ratio, 1.25, 'a ratio of 1.25x');

console.log('');
console.log('Against the real catalogue:');
{
  const specs = loadCatalog(path.join(__dirname, '..', 'devices'));
  const e6608 = specs.filter(function (s) { return /OptiXtrans E6608/.test(s.model || ''); })[0];
  ok(!!e6608, 'the E6608 is in the catalogue');
  const a = fabric.auditFabric(e6608);
  eq(a.capacityMbps, 800000, 'its cross-connect is 800 Gbit/s');
  eq(a.offeredMbps, 2400000, 'its client cages offer 2.4 Tbit/s');
  eq(a.ratio, 3, 'so it is exactly 3x oversubscribed');
  ok(a.exceeds === true, 'and the audit says so');
  eq(a.overByMbps, 1600000, 'by 1.6 Tbit/s');

  const e6616 = specs.filter(function (s) { return /OptiXtrans E6616/.test(s.model || ''); })[0];
  const b = fabric.auditFabric(e6616);
  eq(b.capacityMbps, 2800000, 'the E6616 cross-connect is 2.8 Tbit/s');
  eq(b.ratio, 2, 'and its 5.6 Tbit/s of client cages are 2x that');

  const m1db = specs.filter(function (s) { return /NetEngine 8000 M1D-B/.test(s.model || ''); })[0];
  const c = fabric.auditFabric(m1db);
  ok(c && c.exceeds === false, 'the M1D-B is not oversubscribed - 188G of ports behind 368 Gbit/s');

  // The invariant that catches a typo rather than an oversubscription: no vendor ships a cage
  // faster than the fabric behind it.
  const broken = [];
  for (const s of specs) {
    const problems = fabric.validateFabric(s);
    if (problems.length) broken.push(s.vendor + '/' + s.model + ': ' + problems[0]);
  }
  eq(broken.length, 0, 'every declared fabric is at least as fast as its fastest port', broken.slice(0, 4).join(' ; '));

  const declared = specs.filter(function (s) { return s.fabric; }).length;
  ok(declared >= 5, 'the devices whose vendors state a capacity declare it (' + declared + ')');
}

console.log('');
console.log('The inspector says it in words a reader can act on:');
{
  function fakeNode() {
    const base = {
      innerHTML: '', textContent: '', value: '', style: {}, dataset: {},
      classList: { add: function () {}, remove: function () {}, toggle: function () {}, contains: function () { return false; } },
      addEventListener: function () {}, removeEventListener: function () {},
      appendChild: function () { return fakeNode(); }, append: function () {},
      setAttribute: function () {}, getAttribute: function () { return null; },
      removeAttribute: function () {}, remove: function () {}, focus: function () {}, click: function () {},
      querySelector: function () { return fakeNode(); }, querySelectorAll: function () { return []; },
      closest: function () { return null; }, parentElement: null, children: []
    };
    return new Proxy(base, { get: function (t, k) { return k in t ? t[k] : function () { return fakeNode(); }; }, set: function (t, k, v) { t[k] = v; return true; } });
  }
  const wrap = {
    _html: '', get innerHTML() { return this._html; }, set innerHTML(v) { this._html = v; },
    addEventListener: function () {}, style: {}, classList: { add: function () {}, remove: function () {}, toggle: function () {}, contains: function () { return false; } },
    querySelector: function () { return fakeNode(); }, querySelectorAll: function () { return []; },
    setAttribute: function () {}, getAttribute: function () { return null; }
  };
  const ctx = {
    console: console, setTimeout: setTimeout, clearTimeout: clearTimeout, setInterval: setInterval,
    fetch: function () { return Promise.resolve({ ok: true, json: function () { return Promise.resolve({}); } }); },
    document: { addEventListener: function () {}, querySelector: function () { return wrap; }, querySelectorAll: function () { return []; } },
    window: {},
    PFCanvas: { on: {}, setTopology: function () {}, fitView: function () {}, render: function () {}, setSelected: function () {}, setSelectedLink: function () {}, animateEvents: function () {}, zoomBy: function () {} }
  };
  ctx.window.PFCanvas = ctx.PFCanvas;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'web', 'app.js'), 'utf8'), ctx, { filename: 'web/app.js' });
  const pf = ctx.window.__pf || {};
  ok(typeof pf.fabricSummary === 'function', 'fabricSummary is exported for testing');

  const e6608 = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'devices', 'huawei', 'optixtrans-e6608.json'), 'utf8'));
  const s = pf.fabricSummary(e6608);
  ok(/800 Gbit\/s/.test(s.text), 'the capacity is stated in Gbit/s', s.text);
  ok(/2\.4 Tbit\/s/.test(s.text), 'the cage total is stated in Tbit/s', s.text);
  ok(/3\.0× oversubscribed/.test(s.text), 'and the ratio is spelled out', s.text);
  ok(pf.fabricSummary({ interfaces: [] }) === null, 'a device with no fabric gets no row at all');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exitCode = 1;
