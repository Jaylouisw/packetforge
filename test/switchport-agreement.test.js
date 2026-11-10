'use strict';
// One switchport sentence, two surfaces (#1291).
//
// `show interfaces <port>` prints one line saying what the port does with a frame, and the inspector panel in
// the browser shows the same fact under a `VLAN` heading. The browser cannot `require` the engine, so the rule
// exists twice on purpose - and two renderings of one fact drift silently:
//
//   console: switchport: access VLAN 1 (trunk staged: native 20, not in use)
//   panel:   access 1
//
// The panel had no idea a parameter could be stored and not in force, and it fell back on `|| 1` for every
// field, so an unset trunk native VLAN and a native VLAN of 1 were indistinguishable. `test/fabric-agreement`
// and `test/port-state-agreement` exist for the same reason: where a rule has to be written twice, the two
// copies have to prove they agree.
//
// This file compares them over a matrix of port states, and then checks the sentence against the data plane
// itself - a sentence that says `allowed 10,20` about a port that drops VLAN 10 is worse than no sentence.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const vlanLib = require('../engine/vlan');
const { Topology, Simulator, runCommands } = require('../engine');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

// --- the browser side, loaded the way the page loads it ------------------------------------------------
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
  return new Proxy(base, { get: function (t, k) { return k in t ? t[k] : function () { return fakeNode(); }; },
    set: function (t, k, v) { t[k] = v; return true; } });
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
const web = ctx.window.__pf || {};

console.log('');
console.log('The panel exposes the rule as a function of the port config, not of the markup:');
ok(typeof web.switchportSentence === 'function', 'web switchportSentence is exported');
ok(typeof web.vlanSummary === 'function', 'web vlanSummary is exported');

// --- the matrix --------------------------------------------------------------------------------------
const modes = ['access', 'trunk', undefined];
const accessVlans = [undefined, 1, 20, 4094];
const nativeVlans = [undefined, null, 1, 20, 30];
const allowedLists = [undefined, 'all', [], [10, 20], [20], '10,20'];
// The voice VLAN is a switchport parameter like the others, so it belongs in the matrix: an unset field, one
// that is in the allowed list and one that is not (#1368).
const voiceVlans = [undefined, null, 20, 30];
const matrix = [];
for (const mode of modes) {
  for (const accessVlan of accessVlans) {
    for (const nativeVlan of nativeVlans) {
      for (const allowedVlans of allowedLists) {
        for (const voiceVlan of voiceVlans) {
          const cfg = {};
          if (mode !== undefined) cfg.mode = mode;
          if (accessVlan !== undefined) cfg.accessVlan = accessVlan;
          if (nativeVlan !== undefined) cfg.nativeVlan = nativeVlan;
          if (allowedVlans !== undefined) cfg.allowedVlans = allowedVlans;
          if (voiceVlan !== undefined) cfg.voiceVlan = voiceVlan;
          matrix.push(cfg);
        }
      }
    }
  }
}

console.log('');
console.log('Engine and panel produce the same sentence for ' + matrix.length + ' port states:');
{
  let diffs = [];
  for (const cfg of matrix) {
    const engine = vlanLib.switchportSentence(cfg);
    const panel = web.switchportSentence(cfg);
    if (engine !== panel) diffs.push(JSON.stringify(cfg) + ' engine=' + JSON.stringify(engine) +
      ' panel=' + JSON.stringify(panel));
  }
  ok(diffs.length === 0, 'no divergence across the matrix', JSON.stringify(diffs.slice(0, 3)));
  const distinct = new Set(matrix.map(function (c) { return vlanLib.switchportSentence(c); }));
  ok(distinct.size >= 6, 'and the matrix reaches ' + distinct.size + ' distinct sentences, so it is testing more ' +
    'than one branch', String(distinct.size));
}

console.log('');
console.log('The panel shows it under the VLAN heading, unchanged:');
{
  let bad = [];
  for (const cfg of matrix) {
    const shown = web.vlanSummary({ vlan: cfg });
    if (shown !== vlanLib.switchportSentence(cfg)) bad.push(JSON.stringify(cfg));
  }
  ok(bad.length === 0, 'vlanSummary(iface) is the sentence and nothing else', JSON.stringify(bad.slice(0, 3)));
}

console.log('');
console.log('The sentence agrees with the data plane about every VLAN it mentions:');
{
  // For each state, whatever VLANs the sentence claims the port carries must be carried, and `none` must mean
  // nothing is. This is the part that makes the sentence worth printing.
  function carried(cfg, vid) {
    const a = vlanLib.classifyEgress(cfg, vid);
    return (((Array.isArray(a) ? a : [a])[0] || {}).action || 'drop') !== 'drop';
  }
  const probes = [1, 10, 20, 30, 4094];
  let bad = [];
  for (const cfg of matrix) {
    const sentence = vlanLib.switchportSentence(cfg);
    if (/^trunk /.test(sentence)) {
      // A trunk's sentence is a claim about the allowed list, so the allowed list has to match the data plane
      // exactly - including `none`.
      // The voice clause is a claim too: the port carries that VLAN whatever the allowed list says, and if the
      // sentence names it the classifier had better agree in both directions.
      const voiceMatch = /· voice (\d+)/.exec(sentence);
      const voiceVid = voiceMatch ? Number(voiceMatch[1]) : null;
      if (voiceVid !== null && !carried(cfg, voiceVid)) {
        bad.push('names voice ' + voiceVid + ' but drops it: ' + JSON.stringify(cfg));
      }
      const voiceCarried = voiceVid !== null && carried(cfg, voiceVid);
      if (/allowed all/.test(sentence)) {
        for (const vid of probes) if (!carried(cfg, vid)) bad.push('all but drops ' + vid + ': ' + JSON.stringify(cfg));
      } else if (/allowed none/.test(sentence)) {
        for (const vid of probes) {
          if (carried(cfg, vid) && !(voiceCarried && vid === voiceVid)) {
            bad.push('none but carries ' + vid + ': ' + JSON.stringify(cfg));
          }
        }
      } else {
        const listed = /allowed ([\d,]+)/.exec(sentence)[1].split(',').map(Number);
        for (const vid of listed) if (!carried(cfg, vid)) bad.push('lists ' + vid + ' but drops it: ' + JSON.stringify(cfg));
        for (const vid of probes) {
          if (listed.indexOf(vid) === -1 && carried(cfg, vid) && !(voiceCarried && vid === voiceVid)) {
            bad.push('carries ' + vid + ' but claims it is not allowed: ' + JSON.stringify(cfg));
          }
        }
      }
      // And a voice VLAN outside the allowed list must actually be the one the clause names - a clause that
      // named the wrong VLAN would pass the check above.
      if (voiceVid !== null) {
        const outro = vlanLib.classifyEgress(cfg, voiceVid);
        // Untagged is right when the voice VLAN is also the native VLAN - the frame still leaves the port.
        if (outro.action === 'drop') bad.push('voice ' + voiceVid + ' is dropped: ' + JSON.stringify(cfg));
      }
    } else {
      // An access port's sentence is a claim about one VLAN - and, in its staged clause, an explicit claim that
      // the rest are NOT in use. So the access VLAN must be carried, and every staged VLAN must not be.
      const access = Number(/^access VLAN (\d+)/.exec(sentence)[1]);
      if (!carried(cfg, access)) bad.push('access says ' + access + ' but drops it: ' + JSON.stringify(cfg));
      const staged = /trunk staged: ([^(]+)/.exec(sentence);
      if (staged) {
        const nums = (staged[1].match(/\d+/g) || []).map(Number);
        for (const vid of nums) {
          if (vid !== access && carried(cfg, vid)) {
            bad.push('calls ' + vid + ' staged but carries it: ' + JSON.stringify(cfg));
          }
        }
      }
    }
  }
  ok(bad.length === 0, 'every claim about a VLAN matches classifyEgress', JSON.stringify(bad.slice(0, 3)));
}

console.log('');
console.log('...and `show interfaces <port>` prints exactly that sentence:');
{
  const catalog = loadCatalog(path.join(__dirname, '..', 'devices')).filter(function (s) { return !s.error; });
  const SWITCH = catalog.filter(function (s) { return s.model === 'generic-switch'; })[0];
  const t = new Topology();
  const d = t.addDevice(SWITCH, 'sw');
  const sim = new Simulator(t);
  const run = function (lines) { return runCommands(d, t, sim, lines).lines; };

  run(['enable', 'configure terminal',
    'interface Fa0/1', 'switchport access vlan 20', 'exit',
    'interface Fa0/2', 'switchport mode trunk', 'switchport trunk native vlan 30',
    'switchport trunk allowed vlan 10,20', 'exit',
    'interface Fa0/3', 'switchport trunk native vlan 20', 'exit',
    'interface Fa0/4', 'switchport mode trunk', 'exit',
    'end']);

  let bad = [];
  for (const port of ['Fa0/1', 'Fa0/2', 'Fa0/3', 'Fa0/4', 'Fa0/5']) {
    const iface = d.interfaces.get(port);
    const line = run(['show interfaces ' + port]).filter(function (l) { return /switchport:/.test(l); })[0] || '';
    const engineSentence = vlanLib.switchportSentence(iface.vlan);
    const shown = line.replace(/^\s*switchport:\s*/, '');
    if (shown !== engineSentence) bad.push(port + ' cli=' + JSON.stringify(shown) + ' engine=' + JSON.stringify(engineSentence));
    // ...and the panel would show the same thing for that port.
    if (web.vlanSummary(iface) !== engineSentence) bad.push(port + ' panel disagrees');
  }
  ok(bad.length === 0, 'five ports, four states: console, engine and panel all say one thing',
    JSON.stringify(bad));

  // The specific states this iteration is about.
  const staged = run(['show interfaces Fa0/3']).filter(function (l) { return /switchport:/.test(l); })[0];
  ok(/trunk staged: native 20 \(not in use\)/.test(staged),
    'a stored-but-unused parameter is marked as such in the console', staged);
  const trunkAll = run(['show interfaces Fa0/4']).filter(function (l) { return /switchport:/.test(l); })[0];
  ok(/trunk \u00b7 native 1 \u00b7 allowed all/.test(trunkAll), 'a trunk allowing all says so', trunkAll);
  const plain = run(['show interfaces Fa0/5']).filter(function (l) { return /switchport:/.test(l); })[0];
  ok(/switchport: access VLAN 1$/.test(plain), 'and a default port says one short thing', plain);
}

console.log('');
console.log('A trunk that allows nothing does not claim to allow everything:');
{
  // `[]` is what a hand-edited lab file can hold; `classifyEgress` drops every VLAN on it. Printing "allowed
  // all" there was a sentence the data plane contradicted.
  const cfg = { mode: 'trunk', allowedVlans: [] };
  ok(vlanLib.switchportSentence(cfg) === 'trunk \u00b7 native 1 \u00b7 allowed none',
    'engine says none', vlanLib.switchportSentence(cfg));
  ok(web.switchportSentence(cfg) === vlanLib.switchportSentence(cfg), 'panel says none too',
    web.switchportSentence(cfg));
  ok(vlanLib.classifyEgress(cfg, 20).action === 'drop', 'and the data plane drops VLAN 20',
    JSON.stringify(vlanLib.classifyEgress(cfg, 20)));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
