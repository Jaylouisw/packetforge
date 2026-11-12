'use strict';
// The cable key promises that colour means something, so every medium has to land on a family the key explains.
//
// The canvas classifies a medium id with MEDIUM_RULES and draws the cable in that family's colour; the palette
// draws a legend row per family from the same list. Between the two sat three kinds of hole, all found by asking
// every medium in the catalogue what colour it gets (#1489):
//
//   serial-v35   -> fiber    fibre's catch-all matched the two letters "er" inside "s-er-ial", so a V.35 pair was
//                            drawn as an LC optic and the key had no entry for a serial cable at all;
//   100base-tx   -> fiber    the copper rule spelled out "base-t$", and 100BASE-TX ends in "tx", so the one copper
//                            rate in the catalogue that does not end in "-t" was drawn as glass;
//   ghn, lte, usb-console, 2gfc-sw -> (nothing)   matched no rule, so the default cable was drawn: the drawing said
//                            "a cable" while the key offered ten specific answers.
//
// A key that cannot explain what is on screen is decoration. This test walks the whole media catalogue in both
// directions: every medium gets a family, every family has a legend row, and every legend row and drawn class has a
// style, so a cable the canvas paints is always a cable the reader can look up.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}
const ROOT = path.join(__dirname, '..');
const media = require('../engine/media');

// --- the two browser modules, loaded the way the page loads them -------------------------------
function fakeNode() {
  const base = {
    innerHTML: '', textContent: '', value: '', style: {}, dataset: {}, children: [],
    classList: { add: function () {}, remove: function () {}, toggle: function () {}, contains: function () { return false; } },
    addEventListener: function () {}, removeEventListener: function () {},
    appendChild: function (c) { base.children.push(c); return c; }, append: function () {},
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
function browserContext() {
  const wrap = fakeNode();
  const ctx = {
    console: console, setTimeout: setTimeout, clearTimeout: clearTimeout, setInterval: setInterval,
    Math: Math, JSON: JSON, Date: Date,
    fetch: function () { return Promise.resolve({ ok: true, json: function () { return Promise.resolve({}); } }); },
    document: {
      addEventListener: function () {}, querySelector: function () { return wrap; }, querySelectorAll: function () { return []; },
      getElementById: function () { return wrap; }, createElement: function () { return fakeNode(); },
      createElementNS: function () { return fakeNode(); }, body: fakeNode()
    },
    window: {}
  };
  ctx.window = ctx;
  ctx.addEventListener = function () {};
  ctx.requestAnimationFrame = function () {};
  ctx.localStorage = { getItem: function () { return null; }, setItem: function () {} };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'web', 'canvas.js'), 'utf8'), ctx, { filename: 'canvas.js' });
  const canvas = ctx.PFCanvas;
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'web', 'app.js'), 'utf8'), ctx, { filename: 'app.js' });
  return { canvas: canvas, pf: ctx.__pf || (ctx.window && ctx.window.__pf) || {} };
}
const { canvas, pf } = browserContext();
const mediumClass = canvas && canvas.mediumClass;
const legend = (pf && pf.cableFamilies) || [];
const css = fs.readFileSync(path.join(ROOT, 'web', 'style.css'), 'utf8');

// The family each medium declares, and the two documented exceptions where a cable is drawn as the plant it is
// part of rather than as the connector it plugs into: a PON drop is its own legend entry, and an AOC is not a DAC.
const FAMILY_CLASS = { 'fibre-channel': 'fiber' };
const EXCEPTIONS = [
  [/^aoc-/, 'aoc'],
  [/^(gpon|xgspon|ngpon|epon|10g-epon)/, 'pon']
];
function expectedClass(id, family) {
  for (const ex of EXCEPTIONS) if (ex[0].test(id)) return ex[1];
  return FAMILY_CLASS[family] || family;
}

console.log('');
console.log('Every medium in the catalogue is drawn as the family it belongs to:');
{
  const ids = Object.keys(media.MEDIA || {});
  ok(ids.length > 60, 'the catalogue is where the test thinks it is (' + ids.length + ' media)');
  const wrong = [];
  const unclassed = [];
  for (const id of ids) {
    const fam = media.MEDIA[id].family;
    const got = typeof mediumClass === 'function' ? mediumClass(id) : '<no classifier>';
    if (!got) { unclassed.push(id + ' (' + fam + ')'); continue; }
    if (got !== expectedClass(id, fam)) wrong.push(id + ': family ' + fam + ' drawn as ' + got);
  }
  ok(unclassed.length === 0, 'no medium falls through to the default cable', unclassed.join(', '));
  ok(wrong.length === 0, 'and none is drawn as a different family', wrong.join('; '));
  // The three that were wrong, named, because a regression here is silent on screen.
  const named = [
    ['serial-v35', 'serial', 'a V.35 pair is not an LC optic'],
    ['100base-tx', 'copper', 'the only copper rate that does not end in -t'],
    ['ghn', 'powerline', 'a mains adapter'],
    ['ghn-25', 'powerline', 'and its 25 MHz sibling'],
    ['lte', 'wireless', 'a radio link'],
    ['5g-mmwave', 'wireless', 'and a millimetre-wave one'],
    ['usb-console', 'console', 'a management lead'],
    ['2gfc-sw', 'fiber', 'fibre channel is fibre'],
    ['10gfc-lw', 'fiber', 'at 10G too'],
    ['5gbase-t', 'copper', 'a 5GBASE-T lead is copper, whatever its name starts with']
  ];
  const misses = named.filter(function (n) { return mediumClass(n[0]) !== n[1]; })
    .map(function (n) { return n[0] + ' -> ' + mediumClass(n[0]) + ' (' + n[2] + ')'; });
  ok(misses.length === 0, 'and the ten that were wrong or invisible now say the right thing', misses.join('; '));
}

console.log('');
console.log('Every family a cable can be drawn in has a row in the key:');
{
  const families = Array.from(new Set(Object.keys(media.MEDIA || {}).map(function (id) {
    return mediumClass(id);
  }))).filter(Boolean).sort();
  const ids = legend.map(function (f) { return f.id; });
  const missing = families.filter(function (f) { return ids.indexOf(f) === -1; });
  ok(legend.length > 0, 'the legend is exposed for the test (' + legend.length + ' rows)');
  ok(missing.length === 0, 'no drawn family is missing from the key', missing.join(', '));
  const dead = ids.filter(function (id) { return families.indexOf(id) === -1; });
  ok(dead.length === 0, 'and no row describes a family nothing can be drawn in', dead.join(', '));
  ok(ids.indexOf('serial') !== -1, 'the V.35 family has its own row');
  ok(ids.indexOf('console') !== -1, 'and so does a console lead');
  const unlabelled = legend.filter(function (f) { return !f.label || !String(f.label).trim(); });
  ok(unlabelled.length === 0, 'every row is labelled', unlabelled.map(function (f) { return f.id; }).join(', '));
  // The key promises the label matches the drawing, so a serial row may not describe an optic.
  const serialRow = legend.filter(function (f) { return f.id === 'serial'; })[0] || {};
  ok(/serial/i.test(serialRow.label || ''), 'the serial row names the cable it means', String(serialRow.label));
}

console.log('');
console.log('Every row and every drawn family has a style, so the colour is real:');
{
  const families = Array.from(new Set(Object.keys(media.MEDIA || {}).map(mediumClass).filter(Boolean)));
  const noStyle = families.filter(function (f) { return css.indexOf('.link.link-' + f) === -1; });
  ok(noStyle.length === 0, 'each family has a stroke rule on the canvas', noStyle.join(', '));
  const noSwatch = families.filter(function (f) { return css.indexOf('.lg-row.link-' + f) === -1; });
  ok(noSwatch.length === 0, 'and a swatch rule in the key', noSwatch.join(', '));
  const hardcoded = families.filter(function (f) {
    const re = new RegExp('\\.link\\.link-' + f + '\\s*\\{[^}]*\\}');
    const m = re.exec(css);
    return m && !/var\(--c-[a-z-]+\)/.test(m[0]);
  });
  ok(hardcoded.length === 0, 'and the drawn colour comes from the same variable the swatch uses', hardcoded.join(', '));
  ok(css.indexOf('--c-serial') !== -1 && css.indexOf('--c-console') !== -1,
    'the two new families have their own colour variables');
  // No two families may share a colour: that is what made copper and fibre indistinguishable to begin with.
  const vars = families.map(function (f) {
    const m = new RegExp('\\.lg-row\\.link-' + f + '\\s*\\{\\s*--cable:\\s*var\\((--c-[a-z-]+)\\)').exec(css);
    return m ? m[1] : null;
  }).filter(Boolean);
  ok(new Set(vars).size === vars.length, 'and every family has a colour no other family uses',
    vars.length + ' families, ' + new Set(vars).size + ' distinct colours');
}

console.log('');
if (failed) {
  console.error(passed + ' passed, ' + failed + ' failed');
  process.exit(1);
}
console.log(passed + ' passed, 0 failed');
