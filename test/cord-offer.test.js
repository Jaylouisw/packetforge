'use strict';

// A refusal that names a part is a refusal you can act on (issue #92).
//
// The complaint: "The refusal names the hybrid cord, but nobody can act on it from the UI."
// The engine already knew the answer. Ask it for an SC/UPC to SC/APC link and it replies:
//
//   E_POLISH_MISMATCH ... A hybrid patch cord (SMSCSX, sc-upc to sc-apc, 0.3 dB insertion
//   loss) joins these two polishes: declare it on the link (patchCord: "SMSCSX") ...
//
// and then nothing could declare it. The only way to build that run was to hand-edit the
// topology JSON, which is the wrong shape of work for a simulator whose whole promise is
// that a lab you can draw is a lab you can build.
//
// Two halves, tested separately because they fail separately:
//   1. the engine states the fix as data, not only as prose - `patchCordOptions` and an
//      error-level `suggestion` carrying the exact field and value;
//   2. the UI reads that suggestion and offers to apply it, instead of printing a paragraph
//      and leaving the user to work out which part to buy.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { Topology } = require('../engine');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg); }
}

// --- fixture: an SC/UPC port meeting an SC/APC port -------------------------
function board() {
  const t = new Topology();
  const a = t.addDevice({ vendor: 'test', model: 'upc', category: 'switch',
    interfaces: [{ name: 'p', type: 'ethernet', speed: '1G', cage: 'sc-upc', media: ['gpon-sc-upc'] }] });
  const b = t.addDevice({ vendor: 'test', model: 'apc', category: 'switch',
    interfaces: [{ name: 'p', type: 'ethernet', speed: '1G', cage: 'sc-apc', media: ['gpon-sc-apc'] }] });
  return { t: t, a: a, b: b };
}

console.log('The engine states the fix as data:');

const f = board();
const refused = f.t.validateLink(f.a.id, 'p', f.b.id, 'p', {});

ok(refused.ok === false, 'the bare pair is refused');
ok(refused.errors[0].code === 'E_POLISH_MISMATCH', 'and refused for the right reason');

const sug = refused.errors[0].suggestion;
ok(!!sug, 'the refusal carries a suggestion, not only a sentence');
ok(sug && sug.code === 'S_PATCH_CORD_REQUIRED', 'whose code says what kind of fix it is');
ok(sug && sug.field === 'patchCord', 'and names the field to set: ' + (sug && sug.field));
ok(sug && sug.value === 'SMSCSX', 'and the value: ' + (sug && sug.value));
ok(sug && sug.lossDb === 0.3, 'with the insertion loss that has to be paid: ' + (sug && sug.lossDb));

ok(Array.isArray(refused.patchCordOptions) && refused.patchCordOptions.length === 1,
  'and one patch-cord option, so a picker has something to show');
const opt = (refused.patchCordOptions || [])[0] || {};
ok(opt.patchCord === 'SMSCSX', 'the option is orderable by part number');
ok(opt.endA && opt.endB && opt.endA !== opt.endB, 'and states both ends (' + opt.endA + ' → ' + opt.endB + ')');

// Applying the suggestion must actually work - a suggestion that does not build the link
// would be worse than no suggestion.
const accepted = f.t.validateLink(f.a.id, 'p', f.b.id, 'p', { patchCord: sug.value });
ok(accepted.ok === true, 'declaring the suggested cord makes the link buildable');
ok(accepted.mediaId === 'gpon-sc-hybrid', 'through the cord as the medium: ' + accepted.mediaId);
ok(accepted.patchCordLossDb === 0.3, 'and the loss is charged to the budget');
ok(accepted.polishWeakened === true, 'and the run is marked as polish-weakened, not silently normal');

console.log('\nNo suggestion where none would help:');
{
  // Different connector shapes: there is no orderable lead that turns LC into SC here, and
  // inventing one would be worse than refusing.
  const t = new Topology();
  const a = t.addDevice({ vendor: 'test', model: 'lc', category: 'switch',
    interfaces: [{ name: 'p', type: 'ethernet', speed: '1G', cage: 'lc-upc', media: ['1000base-lx'] }] });
  const b = t.addDevice({ vendor: 'test', model: 'sc', category: 'switch',
    interfaces: [{ name: 'p', type: 'ethernet', speed: '1G', cage: 'sc-upc', media: ['gpon-sc-upc'] }] });
  const v = t.validateLink(a.id, 'p', b.id, 'p', {});
  ok(v.ok === false, 'LC to SC is refused');
  ok(!(v.errors[0] || {}).suggestion, 'and offers no part, because no part would fit');
  ok(Array.isArray(v.patchCordOptions) && v.patchCordOptions.length === 0,
    'the options list is present and empty rather than missing');
}
{
  // A perfectly good link must not claim to need a cord.
  const t = new Topology();
  const a = t.addDevice({ vendor: 'test', model: 'a', category: 'switch',
    interfaces: [{ name: 'p', type: 'ethernet', speed: '1G' }] });
  const b = t.addDevice({ vendor: 'test', model: 'b', category: 'switch',
    interfaces: [{ name: 'p', type: 'ethernet', speed: '1G' }] });
  const v = t.validateLink(a.id, 'p', b.id, 'p', {});
  ok(v.ok === true, 'copper to copper is fine');
  ok(v.patchCordOptions.length === 0 && !(v.errors[0] || {}).suggestion,
    'and asks for no cord');
}

// --- the UI's half ---------------------------------------------------------
console.log('\nThe UI turns the suggestion into an offer:');

function loadApp() {
  function fakeNode() {
    const base = {
      innerHTML: '', textContent: '', value: '', checked: false, style: {}, dataset: {},
      classList: { add: function () {}, remove: function () {}, toggle: function () {}, contains: function () { return false; } },
      addEventListener: function () {}, removeEventListener: function () {},
      appendChild: function () { return fakeNode(); }, append: function () {},
      setAttribute: function () {}, getAttribute: function () { return null; },
      removeAttribute: function () {}, remove: function () {}, focus: function () {}, click: function () {},
      querySelector: function () { return fakeNode(); }, querySelectorAll: function () { return []; },
      closest: function () { return null; }, parentElement: null, children: []
    };
    return new Proxy(base, {
      get: function (t, k) { if (k in t) return t[k]; return function () { return fakeNode(); }; },
      set: function (t, k, v) { t[k] = v; return true; }
    });
  }
  const wrap = fakeNode();
  const ctx = {
    console: console,
    setTimeout: setTimeout, clearTimeout: clearTimeout, setInterval: setInterval,
    fetch: function () { return Promise.resolve({ ok: true, json: function () { return Promise.resolve({}); } }); },
    document: {
      addEventListener: function () {},
      querySelector: function () { return wrap; },
      querySelectorAll: function () { return []; },
      getElementById: function () { return fakeNode(); },
      createElement: function () { return fakeNode(); },
      body: fakeNode()
    },
    window: {},
    PFCanvas: {
      on: {}, setTopology: function () {}, fitView: function () {}, render: function () {},
      setSelected: function () {}, setSelectedLink: function () {},
      animateEvents: function () {}, zoomBy: function () {}
    }
  };
  ctx.window = ctx;
  ctx.window.PFCanvas = ctx.PFCanvas;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'web', 'app.js'), 'utf8'), ctx, { filename: 'app.js' });
  return ctx.window.__pf;
}

const pf = loadApp();
ok(!!pf && typeof pf.cordOfferFor === 'function', 'the offer logic is exposed as one function');

const offer = pf.cordOfferFor(refused);
ok(!!offer, 'a refused pair with a suggestion produces an offer');
ok(offer && offer.value === 'SMSCSX', 'carrying the part number: ' + (offer && offer.value));
ok(offer && offer.field === 'patchCord', 'and the field to set');
ok(offer && offer.lossDb === 0.3, 'and the loss, so the dialog can state the cost');

ok(pf.cordOfferFor(accepted) === null, 'a link that already works produces no offer');
ok(pf.cordOfferFor(null) === null, 'and a missing verdict produces no offer');

// The selector must not turn every refusal into a cord pitch - that would teach users to
// click through the one dialog that matters.
{
  const t = new Topology();
  const a = t.addDevice({ vendor: 'test', model: 'w', category: 'wireless',
    interfaces: [{ name: 'wlan0', type: 'wireless', speed: '1G' }] });
  const b = t.addDevice({ vendor: 'test', model: 's', category: 'switch',
    interfaces: [{ name: 'p', type: 'ethernet', speed: '1G' }] });
  const v = t.validateLink(a.id, 'wlan0', b.id, 'p', {});
  ok(v.ok === false, 'radio to copper is refused');
  ok(pf.cordOfferFor(v) === null, 'and no patch cord is offered for it');
}

// An older response shape (options but no marker) must still be actionable.
{
  const legacy = { ok: false, errors: [{ code: 'E_POLISH_MISMATCH', message: 'x' }],
    patchCordOptions: [{ patchCord: 'SMSCSX', label: 'SMSCSX (sc-upc → sc-apc)', lossDb: 0.3 }] };
  const o = pf.cordOfferFor(legacy);
  ok(!!o && o.value === 'SMSCSX', 'an options-only response still yields an offer');
}

console.log('');
if (failed) { console.log(failed + ' failed, ' + passed + ' passed'); process.exit(1); }
console.log(passed + ' passed, 0 failed');
