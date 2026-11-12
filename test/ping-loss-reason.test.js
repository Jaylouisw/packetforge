'use strict';
// The engine knew why the echo was lost, and the console said "Request timed out" (#1485).
//
// `ping()` has recorded a reason for every lost echo since #1431 ranked the causes - `no route to 10.0.0.1`,
// `no ARP reply from 10.91.0.10`, `peer port shut (R1 Gi0/0/0)`, `ACL 101 denied (in)`. And `_pingReplyLines()`
// printed one line per echo, `Request timed out (seq 0)`, and dropped the reason on the floor:
//
//   Request timed out (seq 0)              <- everything the console said
//   replies: [{ reason: "no ARP reply from 10.91.0.10" }]   <- everything it knew
//
// So the most-used command in the lab answered "something went wrong" to the question "what went wrong". This is the
// same defect family as the packet log's bare event types (#1475) and the two ARP rows that disagreed (#1417), one
// surface further in: the mechanism computed a sentence and the view did not print it.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { Topology, Simulator, runCommands } = require('../engine');
const simModule = require('../engine/simulator');
const cliModule = require('../engine/cli');
const CliSession = cliModule.CliSession || cliModule;
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}
const ROOT = path.join(__dirname, '..');
const catalog = loadCatalog(path.join(ROOT, 'devices'));
function spec(v, m) { return catalog.find(function (x) { return x.vendor === v && x.model === m; }); }

function lab() {
  const t = new Topology();
  const r1 = t.addDevice(spec('cisco', 'ISR 4331')); r1.name = 'R1';
  const sw = t.addDevice(spec('generic', 'generic-switch')); sw.name = 'SW';
  const a = t.addDevice(spec('generic', 'generic-pc')); a.name = 'PC';
  t.connect(r1.id, 'Gi0/0/0', sw.id, 'Fa0/1');
  t.connect(sw.id, 'Fa0/2', a.id, 'eth0');
  const cfg = function (d, lines) { runCommands(d, t, null, ['configure terminal'].concat(lines)); };
  cfg(r1, ['interface Gi0/0/0', 'ip address 10.91.0.1 255.255.255.0', 'no shutdown', 'end']);
  cfg(a, ['interface eth0', 'ip address 10.91.0.10 255.255.255.0', 'end']);
  return { t: t, r1: r1, sw: sw, a: a, cfg: cfg };
}
// The console, as an operator meets it: one session, one device, the answer it printed.
function console_(t, devId, command) {
  const sim = new Simulator(t);
  const s = new CliSession(t.getDevice(devId) || devId, t, sim);
  const out = ((s.run(command) || {}).output || []);
  return { lines: out, text: out.join('\n'), sim: sim };
}
// Degrade to a marked value rather than throwing when the rule is missing: a revert should report many failures
// naming the defect, not one opaque crash (the lesson from test/event-legend.test.js).
function lossSay(replies) {
  return typeof simModule.pingLossSentence === 'function' ? simModule.pingLossSentence(replies) : '<no rule>';
}
function dropsSay(drops, limit) {
  return typeof simModule.dropsSentence === 'function' ? simModule.dropsSentence(drops, limit) : '<no rule>';
}
const lossLine = function (text) {
  const m = text.split('\n').filter(function (l) { return /^\% Echoes lost: /.test(l); });
  return m.length ? m : [];
};

console.log('');
console.log('A ping that fails says why, in the words the engine already used:');
{
  const L = lab();
  const r = console_(L.t, L.a.id, 'ping 10.91.0.1 1');
  ok(/Success rate is 100 percent/.test(r.text), 'the lab answers while the link is up');
  ok(lossLine(r.text).length === 0, 'and a ping that was answered has no loss line', r.text.split('\n').join(' | '));

  // Now something nobody owns, on a path that is up: the reason is silence, and it names the address.
  const gap = console_(L.t, L.a.id, 'ping 10.91.0.99 1');
  const lines = lossLine(gap.text);
  ok(lines.length === 1, 'an unanswered echo gets exactly one loss line', gap.text.split('\n').join(' | '));
  ok(/10\.91\.0\.99/.test(lines[0] || ''), 'and it names the address that did not answer', lines[0]);
  ok(/ARP|no route/i.test(lines[0] || ''), 'and the reason, not just the address', lines[0]);
  ok(/^\% /.test(lines[0] || ''), 'written in the console\'s explanatory voice ("% ...")', lines[0]);
  ok(gap.text.indexOf('Request timed out') < gap.text.indexOf(lines[0] || 'x'),
    'after the per-echo lines, so the report reads top to bottom', gap.text.split('\n').join(' | '));
}

console.log('');
console.log('A shut port is named as the cause, and the reason keeps its own brackets:');
{
  const L = lab();
  L.cfg(L.r1, ['interface Gi0/0/0', 'shutdown', 'end']);
  const r = console_(L.t, L.a.id, 'ping 10.91.0.1 1');
  const lines = lossLine(r.text);
  ok(lines.length === 1, 'one loss line for a shut link', lines.join(' | '));
  ok(/shut/i.test(lines[0] || ''), 'it says the port is shut', lines[0]);
  // "peer port shut (R1 Gi0/0/0)" brings its own brackets; inside the summary's they would nest or end the list.
  ok(/"[^"]*\([^)]*\)[^"]*"/.test(lines[0] || '') || !/\([^()]*\(/.test(lines[0] || ''),
    'a reason that brings brackets is quoted, so the list stays one level deep', lines[0]);
}

console.log('');
console.log('A device with no address at all is not a mystery either:');
{
  const t = new Topology();
  const pc = t.addDevice(spec('generic', 'generic-pc')); pc.name = 'PC';
  const r = console_(t, pc.id, 'ping 10.0.0.1 1');
  const lines = lossLine(r.text);
  ok(lines.length === 1, 'the ping still explains itself', lines.join(' | '));
  ok(/no route|no source/i.test(lines[0] || ''), 'naming the missing route or source', lines[0]);
}

console.log('');
console.log('Four lost echoes are one statement about the path, not four:');
{
  const L = lab();
  L.cfg(L.r1, ['interface Gi0/0/0', 'shutdown', 'end']);
  const r = console_(L.t, L.a.id, 'ping 10.91.0.1 4');
  const lines = lossLine(r.text);
  ok(lines.length === 1, 'a four-echo ping adds one loss line, not four', lines.join(' | '));
  ok(/4 drops/.test(lines[0] || ''), 'and counts the echoes in it', lines[0]);
  ok((r.text.match(/Request timed out/g) || []).length === 4, 'while every echo still gets its own timeout line');
}

console.log('');
console.log('Convergence is not loss, and the two sentences never both claim the same echo:');
{
  const L = lab();
  const early = new Simulator(L.t);
  early.setRunTime(0);
  const p = early.ping(L.a.id, '10.91.0.1', { count: 2 });
  const converging = simModule.pingConvergenceSentence(p.replies);
  const lost = lossSay(p.replies);
  ok(converging !== null, 'a path that is still settling gets the converging sentence', String(converging));
  ok(lost === null, 'and no loss sentence, because nothing was lost yet', String(lost));
  ok(lossSay([{ success: true, reason: null }]) === null, 'an answered echo is not a loss');
  ok(lossSay([]) === null, 'and an empty report says nothing rather than zero drops');
  // A loss with no recorded reason must not be dressed up as an explanation.
  ok(lossSay([{ success: false, reason: null }]) === null,
    'a failure with no reason is left for the timeout line to state');
  ok(lossSay([{ success: false, reason: '   ' }]) === null, 'and blank is not a reason');
}

console.log('');
console.log('One phrasing for one fact: the console and `show interfaces` still use the same words:');
{
  const drops = { total: 3, byReason: { 'no route to 10.0.0.99': 2, 'link down': 1 } };
  const sentence = dropsSay(drops, 3);
  ok(sentence === '3 drops (no route to 10.0.0.99 x2, link down)', 'longest reason first, counts as xN', sentence);
  ok(dropsSay({ total: 1, byReason: { 'link down': 1 } }, 3) === '1 drop (link down)',
    'one drop is singular', dropsSay({ total: 1, byReason: { 'link down': 1 } }, 3));
  const many = { total: 6, byReason: { a: 2, b: 1, c: 1, d: 1, e: 1 } };
  const cut = dropsSay(many, 3);
  ok(/and 2 more reasons/.test(cut), 'reasons past the limit are counted, not dropped silently', cut);
  const one = dropsSay({ total: 2, byReason: { a: 1, b: 1, c: 1 } }, 2);
  ok(/and 1 more reason\b/.test(one), 'and singular "reason" for one', one);
  ok(dropsSay({ total: 0, byReason: {} }) === '', 'nothing to say prints nothing');

  // `show interfaces` delegates to that helper, so its sentence cannot drift from a ping's.
  const L = lab();
  L.cfg(L.r1, ['interface Gi0/0/0', 'shutdown', 'end']);
  const r = console_(L.t, L.r1.id, 'show interfaces Gi0/0/0');
  ok(!/undefined|NaN|\[object Object\]/.test(r.text), 'no interface line prints a broken value', r.text.slice(0, 200));
  const cliSource = fs.readFileSync(path.join(ROOT, 'engine', 'cli.js'), 'utf8');
  ok(/_dropSummary\(drops, limit\) \{\s*\n\s*return require\('\.\/simulator'\)\.dropsSentence\(drops, limit\);/.test(cliSource),
    'and `show interfaces` reaches that phrasing through one function, not a copy of it');
}

console.log('');
console.log('The dialog says the same sentence as the console, case for case:');
{
  // Loaded the way the page loads it, with the same stub test/ping-convergence.test.js uses: app.js wires listeners
  // on nodes it looks up at load time, so a bare object is not enough.
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
  const ctx = {
    console: console, setTimeout: setTimeout, clearTimeout: clearTimeout, setInterval: setInterval,
    fetch: function () { return Promise.resolve({ ok: true, json: function () { return Promise.resolve({}); } }); },
    document: { addEventListener: function () {}, querySelector: function () { return wrap; }, querySelectorAll: function () { return []; } },
    window: {},
    PFCanvas: { on: {}, setTopology: function () {}, fitView: function () {}, render: function () {},
      setSelected: function () {}, setSelectedLink: function () {}, animateEvents: function () {}, zoomBy: function () {} }
  };
  ctx.window.PFCanvas = ctx.PFCanvas;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'web', 'app.js'), 'utf8'), ctx, { filename: 'app.js' });
  const pf = ctx.window.__pf || ctx.__pf;
  const mirror = pf && pf.pingLossSentence;
  ok(typeof mirror === 'function', 'the browser has the rule (window.__pf.pingLossSentence)');
  const cases = [
    { name: 'no route', replies: [{ success: false, reason: 'no route to 10.0.0.1' }] },
    { name: 'no ARP reply', replies: [{ success: false, reason: 'no ARP reply from 10.91.0.10' }] },
    { name: 'bracketed reason', replies: [{ success: false, reason: 'ACL 101 denied (in)' }, { success: false, reason: 'ACL 101 denied (in)' }] },
    { name: 'two reasons', replies: [{ success: false, reason: 'link down' }, { success: false, reason: 'no route to 10.0.0.1' }] },
    { name: 'five reasons', replies: [{ success: false, reason: 'a' }, { success: false, reason: 'b' }, { success: false, reason: 'c' },
      { success: false, reason: 'd' }, { success: false, reason: 'e' }] },
    { name: 'mixed with success', replies: [{ success: true, reason: null }, { success: false, reason: 'link down' }] },
    { name: 'converging only', replies: [{ success: false, reason: 'converging' }] },
    { name: 'reasonless failure', replies: [{ success: false, reason: null }] },
    { name: 'all answered', replies: [{ success: true, reason: null }] },
    { name: 'empty', replies: [] }
  ];
  const disagree = [];
  for (const c of cases) {
    const engineSays = lossSay(c.replies);
    const browserSays = typeof mirror === 'function' ? mirror(c.replies) : '<missing>';
    if (engineSays !== browserSays) disagree.push(c.name + ': engine=' + JSON.stringify(engineSays) + ' browser=' + JSON.stringify(browserSays));
  }
  ok(disagree.length === 0, 'the two surfaces agree on all ' + cases.length + ' cases', disagree.join('; '));

  // And the dialog actually renders it, rather than computing a sentence nobody draws.
  const html = pf && pf.pingResultHtml ? pf.pingResultHtml({
    replies: [{ seq: 0, success: false, reason: 'no route to 10.0.0.1' }],
    runAtMs: null
  }, '10.0.0.1', 1) : '';
  ok(/Echoes lost: 1 drop/.test(html), 'and the simulated dialog shows the sentence', String(html).slice(0, 160));
  const converged = pf && pf.pingResultHtml ? pf.pingResultHtml({
    replies: [{ seq: 0, success: false, reason: 'converging', convergingUntilMs: 30000, pending: [] }],
    runAtMs: 0
  }, '10.0.0.1', 1) : '';
  ok(!/Echoes lost/.test(converged), 'a converging dialog does not also claim loss', String(converged).slice(0, 160));
}

console.log('');
if (failed) {
  console.error(passed + ' passed, ' + failed + ' failed');
  process.exit(1);
}
console.log(passed + ' passed, 0 failed');
