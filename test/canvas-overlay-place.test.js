'use strict';
// Dropping a device under the floating toolbar created a device with no clickable point
// at all (#33).
//
// The toolbar is HTML floating over the drawing surface. A press that starts on the
// canvas and is released over the toolbar still arrives at the SVG - pointer capture
// keeps sending it there - so the app placed the device at those coordinates. The device
// existed on the server, was painted on the drawing, and sat underneath the panel where
// it could not be clicked, dragged or deleted. From the user's side the drop simply
// worked and then the device was gone.
//
// The fix asks the document what is actually at that pixel and refuses a placement aimed
// at an overlay. These checks pin the rule (`elementCoversPoint`, pure and exported) and
// the wiring, so neither can quietly regress.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  <- ' + detail : '')); }
}

const WEB = path.join(__dirname, '..', 'web');
const canvasjs = fs.readFileSync(path.join(WEB, 'canvas.js'), 'utf8');
const appjs = fs.readFileSync(path.join(WEB, 'app.js'), 'utf8');

// --- enough DOM for canvas.js to load and hand back the rule -----------------
function stubNode(name) {
  const n = {
    tag: name, attrs: {}, children: [], style: {}, textContent: '', classList: {
      add: function () {}, remove: function () {}, toggle: function () {}, contains: function () { return false; }
    },
    appendChild: function (c) { n.children.push(c); return c; },
    removeChild: function () {}, remove: function () {},
    setAttribute: function (k, v) { n.attrs[k] = v; }, getAttribute: function (k) { return n.attrs[k]; },
    addEventListener: function () {}, removeEventListener: function () {},
    getBoundingClientRect: function () { return { left: 0, top: 0, width: 900, height: 700 }; },
    getScreenCTM: function () { return null; },
    createSVGPoint: function () { return { x: 0, y: 0, matrixTransform: function () { return { x: 0, y: 0 }; } }; },
    contains: function () { return false; },
    querySelector: function () { return null; }, querySelectorAll: function () { return []; }
  };
  return n;
}
const svg = stubNode('svg');
const ctx = {
  console: console, Math: Math, Number: Number, String: String, Object: Object, Array: Array, JSON: JSON,
  setTimeout: setTimeout, clearTimeout: clearTimeout,
  document: {
    createElementNS: function (ns, tag) { return stubNode(tag); },
    createElement: function (tag) { return stubNode(tag); },
    getElementById: function (id) { return id === 'canvas' ? svg : null; },
    querySelector: function () { return svg; },
    elementFromPoint: function () { return null; }
  },
  window: {},
  requestAnimationFrame: function (f) { return setTimeout(f, 0); }
};
ctx.window = ctx;
vm.createContext(ctx);
vm.runInContext(canvasjs, ctx, { filename: 'canvas.js' });
const pf = ctx.PFCanvas || ctx.window.PFCanvas;

console.log('canvas.js exposes the rule:');
ok(!!pf, 'PFCanvas is on the window');
ok(typeof pf.elementCoversPoint === 'function', 'elementCoversPoint is exported for testing');

const rule = pf.elementCoversPoint;
const toolbar = stubNode('div');
const device = stubNode('g');
const root = { contains: function (el) { return el === device; } };

console.log('\nWhat counts as "covered by something floating over the canvas":');
ok(rule(toolbar, root) === true, 'the toolbar covers the point');
ok(rule(stubNode('div'), root) === true, 'any other element outside the drawing surface covers it too');
ok(rule(device, root) === false, 'a device inside the drawing surface does not');
ok(rule(root, root) === false, 'the drawing surface itself does not');
ok(rule(null, root) === false, 'nothing reported at that point does not block a placement');
ok(rule(toolbar, null) === true, 'and with no root to compare against, an element still blocks');
ok(rule(undefined, root) === false, 'undefined is treated like nothing reported, not like an overlay');
ok(rule(stubNode('div'), { contains: function () { return false; } }) === true,
  'an element the surface does not contain is an overlay even if contains() is strict');

console.log('\nThe placement path consults it:');
ok(/if \(elementCoversPoint\(pointElement\(e\.clientX, e\.clientY\), svg\)\)/.test(canvasjs),
  'the pointerup placement branch asks whether the point is covered');
ok(/on\.placeBlocked\(w\.x, w\.y, state\.placing\)/.test(canvasjs),
  'and reports instead of placing when it is');
ok(/placeBlocked: null/.test(canvasjs), 'the callback exists in the on{} table');
ok(/typeof document === 'undefined' \|\| typeof document\.elementFromPoint !== 'function'/.test(canvasjs),
  'elementFromPoint is feature-detected, so a stub DOM does not throw');
ok(/try \{ return document\.elementFromPoint\(clientX, clientY\) \|\| null; \} catch/.test(canvasjs),
  'and a throwing implementation is survivable');

console.log('\nThe user is told, rather than left with a silent click:');
ok(/PFCanvas\.on\.placeBlocked = function/.test(appjs), 'app.js handles placeBlocked');
ok(/under the toolbar/.test(appjs), 'the toast names the cause');
ok(/toast\(/.test(appjs.slice(appjs.indexOf('PFCanvas.on.placeBlocked'), appjs.indexOf('PFCanvas.on.placeBlocked') + 500)),
  'and it goes through the normal toast path');
ok(!/placing = null/.test(appjs.slice(appjs.indexOf('PFCanvas.on.placeBlocked'), appjs.indexOf('PFCanvas.on.placeBlocked') + 500)),
  'placing mode is left armed, so the next click on the canvas works');

console.log('\nThe normal path is untouched:');
ok(/on\.place\(w\.x, w\.y, state\.placing\);/.test(canvasjs), 'a placement on the canvas still places');
ok(/else if \(state\.placing && on\.place\) \{/.test(canvasjs), 'gated inside the existing placing check');

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.error('\n' + failed + ' overlay-placement check(s) failed'); process.exit(1); }
console.log('\n' + passed + ' overlay-placement checks passed.');
