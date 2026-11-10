'use strict';
// link-verdict.test.js - a cable is checked when it is drawn, and the answer is kept.
//
// connect() asks the physical rule once, at the moment of building, and then forgets the answer.
// Nothing asked again - so a topology that arrived from a file (hand-edited, written against an
// older catalogue, or produced by something that was not this UI) could hold a run that could never
// have been built, and the link inspector answered for all of them with one hardcoded sentence:
//
//   this cable passed the physical-layer check when it was created
//
// which was a claim about a check nobody had run, printed over a cable the engine's own rule calls
// impossible. This suite pins the replacement: the verdict is computed against the hardware as it is
// now, carried on the state every view reads, and rendered as what it says.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { Topology } = require('../engine');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg); }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
function spec(v, m) {
  const s = catalog.find(function (x) { return x.vendor === v && x.model === m; });
  if (!s) throw new Error('missing spec ' + v + '/' + m);
  return s;
}

// A copper run between a PC and a switch: the ordinary, buildable case.
function copperLab() {
  const t = new Topology();
  const pc = t.addDevice(spec('generic', 'generic-pc')); pc.name = 'PC1';
  const sw = t.addDevice(spec('generic', 'generic-switch')); sw.name = 'SW1';
  const link = t.connect(pc.id, 'eth0', sw.id, 'Fa0/1');
  return { t: t, pc: pc, sw: sw, link: link };
}

console.log('A cable that was built here reports the verdict that allowed it:');
{
  const { t, link } = copperLab();
  const v = t.linkVerdict(t.links.get(link.id));
  ok(v && v.ok === true, 'the verdict is ok');
  ok((v.errors || []).length === 0, 'and carries no errors');
  ok(v.mediaId === '1000base-t', 'and names the medium it negotiated (' + v.mediaId + ')');
}

console.log('\nA cable that could never be built is reported as such:');
{
  // The file says two rj45 ports are joined by single-mode fibre. Nothing stopped that file from
  // existing; what matters is what the engine says about it once it is loaded.
  const { t, pc, sw } = copperLab();
  const json = JSON.parse(JSON.stringify(t.serialize()));
  json.links[0].mediaId = '1000base-lx';
  json.links[0].media = '1000base-lx';
  const loaded = Topology.fromJSON(json);
  ok(loaded.links.size === 1, 'fromJSON loads it rather than refusing the whole file');
  const v = loaded.linkVerdict(loaded.links.get(loaded.serialize().links[0].id));
  ok(v.ok === false, 'and the verdict is not ok');
  const codes = (v.errors || []).map(function (e) { return e.code; });
  ok(codes.indexOf('E_MEDIA_NOT_SUPPORTED') >= 0, 'the error is E_MEDIA_NOT_SUPPORTED (' + codes.join(',') + ')');
  const msg = (v.errors[0] || {}).message || '';
  ok(/\/eth0/.test(msg) && /\/Fa0\/1/.test(msg),
    'and it names both ports, so the reader knows where to look (' + msg.slice(0, 120) + ')');
  ok(codes.indexOf('E_PORT_IN_USE') < 0,
    'the pair is not refused for being cabled to each other - that is what it is');
}

console.log('\nThe verdict is an answer about now, so it is not written into the saved file:');
{
  const { t } = copperLab();
  const saved = t.serialize();
  ok(saved.links.length === 1, 'the topology still serialises its cable');
  ok(!('verdict' in saved.links[0]),
    'and the saved link carries no verdict, which would be read back as fact later');
  ok(!JSON.stringify(saved).includes('"verdict"'), 'nothing anywhere in the saved state mentions one');
}

console.log('\nA cable naming a port that is gone says so, instead of throwing:');
{
  const { t, link } = copperLab();
  const live = t.links.get(link.id);
  live.b.iface = 'Fa0/99';
  const v = t.linkVerdict(live);
  ok(v.ok === false, 'the verdict is not ok');
  ok((v.errors[0] || {}).code === 'E_NO_PORT', 'the error is E_NO_PORT');
  ok(String((v.errors[0] || {}).message || '').indexOf('Fa0/99') >= 0, 'and the message names the missing port');
}

console.log('\nA warning is carried through, because the rule warns rather than refuses:');
{
  const t = new Topology();
  const a = t.addDevice(spec('asus', 'RT-AX89X')); a.name = 'A';
  const b = t.addDevice(spec('asus', 'RT-AX89X')); b.name = 'B';
  const link = t.connect(a.id, '10g-sfp', b.id, '10g-sfp');
  t.setLinkLength(link.id, 1200);
  const v = t.linkVerdict(t.links.get(link.id));
  ok(v.ok === true, 'an over-length run is still buildable, so the verdict is ok');
  const warn = (v.warnings || [])[0] || {};
  ok(warn.code === 'W_DISTANCE', 'but it carries W_DISTANCE (' + warn.code + ')');
  ok(String(warn.message || '').indexOf('1200 m') >= 0, 'and the message states the length that caused it');
}

console.log('\nA link that is not a cable is not called impossible:');
{
  // Radios associate, they are not cabled. A verdict that refused them would put "this cable cannot
  // exist as drawn" over a working Wi-Fi link, which is the same class of lie in the other
  // direction, so the wireless case is pinned here rather than assumed.
  const t = new Topology();
  const a = t.addDevice(spec('asus', 'RT-AX89X')); a.name = 'AP1';
  const b = t.addDevice(spec('asus', 'RT-AX89X')); b.name = 'AP2';
  const link = t.connect(a.id, 'radio0', b.id, 'radio0');
  ok(link.mediaId === 'wireless-5', 'two radios associate over a wireless medium (' + link.mediaId + ')');
  const v = t.linkVerdict(t.links.get(link.id));
  ok(v.ok === true, 'and the verdict is ok, so the panel does not call a Wi-Fi link impossible');
  ok(v.mediaId === 'wireless-5', 'and it reports the band it negotiated');
}

console.log('\nA file written before mediaId existed is negotiated, not refused:');
{
  const { t } = copperLab();
  const json = JSON.parse(JSON.stringify(t.serialize()));
  delete json.links[0].mediaId;
  const loaded = Topology.fromJSON(json);
  const live = loaded.links.get(loaded.serialize().links[0].id);
  const v = loaded.linkVerdict(live);
  ok(v.ok === true, 'the link still validates');
  ok(v.mediaId === '1000base-t', 'and the medium is settled from the ports, not from the file');
  live.lengthM = 500;
  const v2 = loaded.linkVerdict(live);
  const codes = (v2.warnings || []).map(function (w) { return w.code; });
  ok(v2.ok === true, 'a 500 m copper run is still buildable');
  ok(codes.indexOf('W_DISTANCE') >= 0, 'with W_DISTANCE (' + codes.join(',') + ')');
  ok(codes.indexOf('W_COPPER_LONGRUN') >= 0, 'and W_COPPER_LONGRUN, as the build-time rule would give');
}

console.log('\nEvery writer of a state payload goes through fullState, and fullState attaches the verdict:');
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
  const start = src.indexOf('function fullState(topo) {');
  ok(start >= 0, 'fullState exists');
  // Walk its braces so "inside fullState" is a fact rather than a guess.
  let i = src.indexOf('{', start), depth = 0, end = -1;
  for (let p = i; p < src.length; p++) {
    if (src[p] === '{') depth++;
    else if (src[p] === '}') { depth--; if (depth === 0) { end = p; break; } }
  }
  ok(end > start, 'and its body can be delimited');
  const body = src.slice(start, end);
  ok(/verdict\s*=\s*live\s*\?\s*topo\.linkVerdict\(live\)/.test(body),
    'the body computes a verdict per link from the topology, not from the file');

  // Any other place that builds a state payload by hand would be the stale shape: a response that
  // looks like the others but carries no verdicts. Two things are allowed to call serialize(): the
  // device and link payloads (which are not topology state), and the file writer - a saved file
  // records what was built, and a verdict written into it would be read back as fact long after the
  // hardware it describes had changed.
  const saveStart = src.indexOf('function saveTopologyNow(');
  let saveEnd = -1;
  if (saveStart >= 0) {
    let d2 = 0;
    for (let p = src.indexOf('{', saveStart); p < src.length; p++) {
      if (src[p] === '{') d2++;
      else if (src[p] === '}') { d2--; if (d2 === 0) { saveEnd = p; break; } }
    }
  }
  ok(saveEnd > saveStart, 'the file writer can be delimited too');
  const offenders = [];
  let at = src.indexOf('.serialize()');
  while (at !== -1) {
    const lineStart = src.lastIndexOf('\n', at) + 1;
    const ahead = src.slice(lineStart, at).trimEnd();
    const inFull = at > start && at < end;
    const inSave = saveEnd > saveStart && at > saveStart && at < saveEnd;
    const isPartPayload = /(?:^|[^\w$])(?:dev|link)$/.test(ahead);
    if (!inFull && !inSave && !isPartPayload) {
      offenders.push(src.slice(lineStart, src.indexOf('\n', at)).trim());
    }
    at = src.indexOf('.serialize()', at + 1);
  }
  ok(offenders.length === 0,
    'no topology state is serialised anywhere but fullState and the file writer' +
      (offenders.length ? ' (' + offenders.join(' | ') + ')' : ''));
  ok(!/verdict/.test(src.slice(saveStart, saveEnd)),
    'and the file writer persists no verdict, so a reload cannot inherit a stale one');
  const handBuilt = (src.match(/state:\s*[A-Za-z_$][\w$]*\.serialize\(\)/g) || []);
  ok(handBuilt.length === 0, 'and no response is built from a bare serialize() call');
}

// --- the inspector, loaded in the same stub DOM the render suites use --------------
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
    get: function (t, k) { return k in t ? t[k] : function () { return fakeNode(); }; },
    set: function (t, k, v) { t[k] = v; return true; }
  });
}
function makeWrap() {
  return {
    _html: '', get innerHTML() { return this._html; }, set innerHTML(v) { this._html = v; },
    addEventListener: function () {}, removeEventListener: function () {}, style: {},
    classList: { add: function () {}, remove: function () {}, toggle: function () {}, contains: function () { return false; } },
    querySelector: function () { return fakeNode(); }, querySelectorAll: function () { return []; },
    setAttribute: function () {}, getAttribute: function () { return null; }
  };
}
const wrap = makeWrap();
const ctx = {
  console: console, setTimeout: setTimeout, clearTimeout: clearTimeout, setInterval: setInterval,
  fetch: function () { return Promise.resolve({ ok: true, json: function () { return Promise.resolve({}); } }); },
  document: { addEventListener: function () {}, querySelector: function () { return wrap; }, querySelectorAll: function () { return []; } },
  window: {},
  PFCanvas: {
    on: {}, setTopology: function () {}, fitView: function () {}, render: function () {},
    setSelected: function () {}, setSelectedLink: function () {}, animateEvents: function () {}, zoomBy: function () {}
  }
};
ctx.window.PFCanvas = ctx.PFCanvas;
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'web', 'app.js'), 'utf8'), ctx, { filename: 'app.js' });
const pf = ctx.window.__pf;
ok(!!pf, 'web/app.js loads in the stub environment');

function renderFor(stateTopo, linkId) {
  pf.setTopology(stateTopo);
  pf.selectLink(linkId);
  const w = makeWrap();
  pf.renderLinkInspector(w);
  return w.innerHTML;
}
const verdictText = (html) => (html.match(/class="verdict"[^>]*>([\s\S]*?)<\/div>/) || [])[1] || '';

console.log('\nWhat the inspector says follows the verdict it was given:');
{
  const { t } = copperLab();
  const state = JSON.parse(JSON.stringify(t.serialize()));
  for (const l of state.links) l.verdict = t.linkVerdict(t.links.get(l.id));
  const html = renderFor(state, state.links[0].id);
  const text = verdictText(html);
  ok(/checked against the hardware as it is now/.test(text),
    'a buildable cable is described as checked now, not as checked once');
  ok(!/passed the physical-layer check when it was created/.test(html),
    'and the old promise about a past check is gone');
}

console.log('\nAn impossible cable is described as impossible, not as checked:');
{
  const { t } = copperLab();
  const json = JSON.parse(JSON.stringify(t.serialize()));
  json.links[0].mediaId = '1000base-lx';
  json.links[0].media = '1000base-lx';
  const loaded = Topology.fromJSON(json);
  const state = JSON.parse(JSON.stringify(loaded.serialize()));
  for (const l of state.links) l.verdict = loaded.linkVerdict(loaded.links.get(l.id));
  const html = renderFor(state, state.links[0].id);
  const text = verdictText(html);
  ok(/cannot exist as drawn/.test(text), 'the inspector says the cable cannot exist');
  ok(/E_MEDIA_NOT_SUPPORTED|not supported by both/.test(text), 'and carries the engine\'s own words for why');
  ok(/would be refused/.test(text), 'and says drawing it now would be refused');
  ok(!/Cages mate/.test(html), 'it does not claim the cages mate');
  ok(/color:#e5484d/.test(html), 'the block is marked as a failure, so it is not read as a footnote');
}

console.log('\nNo verdict at all is reported as no check, not as a pass:');
{
  const { t } = copperLab();
  const state = JSON.parse(JSON.stringify(t.serialize()));   // nothing attached
  const html = renderFor(state, state.links[0].id);
  const text = verdictText(html);
  ok(/has not been checked/.test(text), 'the inspector says the cable has not been checked');
  ok(!/Cages mate/.test(html), 'and does not suggest it has');
  ok(!/cannot exist/.test(html), 'nor does it accuse a cable of being impossible on no evidence');
}

console.log('\nA warning travels with the verdict into the panel:');
{
  const t = new Topology();
  const a = t.addDevice(spec('asus', 'RT-AX89X')); a.name = 'A';
  const b = t.addDevice(spec('asus', 'RT-AX89X')); b.name = 'B';
  const link = t.connect(a.id, '10g-sfp', b.id, '10g-sfp');
  t.setLinkLength(link.id, 1200);
  const state = JSON.parse(JSON.stringify(t.serialize()));
  for (const l of state.links) l.verdict = t.linkVerdict(t.links.get(l.id));
  const html = renderFor(state, state.links[0].id);
  ok(/Cages mate/.test(html), 'the cable is still reported as buildable');
  ok(/exceeds the 300 m reach/.test(html), 'and the reach warning is shown, not swallowed');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exitCode = failed ? 1 : 0;
