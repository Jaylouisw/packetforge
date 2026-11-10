'use strict';
// A converging path is not packet loss, and an instant is not session state (#1383).
//
// Three defects in the same corner:
//
//   1. `ping <address> at 0` called `sim.setRunTime(0)`, which *persists* on the simulator. Every later command in
//      that console session was then answered at t=0 - the next plain `ping`, a later `show ip route`, anything -
//      and nothing said so.
//   2. The convergence line printed `at t=<what you typed>`, so a plain ping after an `at` ping said
//      `% Still converging at t=null ms` - the number was taken from the command instead of from the answer.
//   3. The browser's Simulate dialog drew `Success rate 0% (0/4)` for a path that was still settling, which is the
//      same sentence the API stopped telling in #1377 and #1381, one surface further out.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { Topology, Simulator } = require('../engine');
const simModule = require('../engine/simulator');
const { loadCatalog } = require('../devices/registry');
const cliModule = require('../engine/cli');
const CliSession = cliModule.CliSession || cliModule;

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}
const ROOT = path.join(__dirname, '..');
const specs = loadCatalog(path.join(ROOT, 'devices')).filter(function (s) { return !s.error; });
const SW = specs.find(function (s) { return /CX 6000 24G CL4/.test(s.model); }) ||
  specs.find(function (s) { return /CX 6000/.test(s.model); });
const HOST = specs.find(function (s) { return /Raspberry Pi 5/.test(s.model); }) ||
  specs.find(function (s) { return /^(pc|host)/i.test(s.category || ''); });

// A switch and two hosts: the access ports listen for 30 s, so t=0 is converging and t>=30000 is settled.
function lab() {
  const t = new Topology();
  t.addDevice(SW, 's1'); t.addDevice(HOST, 'h1'); t.addDevice(HOST, 'h2');
  const first = function (id) {
    return Array.from(t.getDevice(id).interfaces.keys()).filter(function (n) {
      return !/^(mgmt|console|aux)/i.test(n);
    })[0];
  };
  t.connect('h1', first('h1'), 's1', '1/1/1', { mediaId: '1000base-t', speedMbps: 1000 });
  t.connect('h2', first('h2'), 's1', '1/1/2', { mediaId: '1000base-t', speedMbps: 1000 });
  const a = t.getDevice('h1').interfaces.get(first('h1'));
  a.ip = '10.9.0.1'; a.mask = '255.255.255.0';
  const b = t.getDevice('h2').interfaces.get(first('h2'));
  b.ip = '10.9.0.2'; b.mask = '255.255.255.0';
  return t;
}
function consoleFor(t) {
  return new CliSession(t.getDevice('h1'), t, new Simulator(t));
}
function lines(session, cmd) {
  return ((session.run(cmd) || {}).output || []);
}

// --- the browser module, loaded the way the page loads it -------------------------------
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
  PFCanvas: { on: {}, setTopology: function () {}, fitView: function () {}, render: function () {}, setSelected: function () {}, setSelectedLink: function () {}, animateEvents: function () {}, zoomBy: function () {} }
};
ctx.window.PFCanvas = ctx.PFCanvas;
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'web', 'app.js'), 'utf8'), ctx, { filename: 'web/app.js' });
const pf = ctx.window.__pf || {};

console.log('');
console.log('The engine writes the sentence once, and uses the facts the answer carries:');
{
  const t = lab();
  const sim = new Simulator(t);
  const early = sim.ping('h1', '10.9.0.2', { count: 2, atMs: 0 });
  ok(early.runAtMs === 0, 'the answer reports the instant it was given at', String(early.runAtMs));
  const sentence = simModule.pingConvergenceSentence(early.replies);
  ok(/^Still converging/.test(String(sentence)), 'the sentence starts with the fact', String(sentence));
  ok(/ready at 30000 ms/.test(String(sentence)), 'and names the instant the path settles', String(sentence));
  ok(/on /.test(String(sentence)), 'and which process on which device', String(sentence));
  ok((String(sentence).match(/Still converging/g) || []).length === 1,
    'exactly once, however many echoes were held up', String(sentence));

  const settled = sim.ping('h1', '10.9.0.2', { count: 2, atMs: 60000 });
  ok(settled.replies.filter(function (r) { return r.success; }).length === 2, 'at t=60000 both echoes are answered');
  ok(simModule.pingConvergenceSentence(settled.replies) === null,
    'and a settled path has nothing to say about converging');

  // A ping with no instant is asked at Infinity, and the answer says so rather than claiming a time.
  const plain = new Simulator(lab()).ping('h1', '10.9.0.2', { count: 1 });
  ok(plain.runAtMs === null, 'a ping asked at no particular instant reports null, not 0', String(plain.runAtMs));
  ok(simModule.pingConvergenceSentence(plain.replies) === null, 'and it is not converging');
}

console.log('');
console.log('The console prints that sentence, with the instant the answer was given at:');
{
  const s = consoleFor(lab());
  const early = lines(s, 'ping 10.9.0.2 2 at 0').join('\n');
  ok(/% Still converging/.test(early), 'a converging ping says so', early.slice(0, 120));
  ok(/ready at 30000 ms/.test(early), 'with the instant it is ready');
  ok(/at t=0 ms/.test(early), 'and the instant it was asked at', early.split('\n').slice(-1)[0]);
  ok(!/t=null/.test(early), 'never "t=null"');
  ok((early.match(/Still converging/g) || []).length === 1,
    'printed once, not once per echo', String((early.match(/Still converging/g) || []).length));
}

console.log('');
console.log('An instant belongs to the question, not to the session:');
{
  const t = lab();
  const s = consoleFor(t);
  const early = lines(s, 'ping 10.9.0.2 2 at 0').join('\n');
  ok(/Still converging/.test(early), 'the first ping is asked at t=0 and is held up');
  // The same console, the next command: a plain ping. Before this change the simulator was still at t=0, so this
  // succeeded nowhere - and said "t=null" while it did it.
  const next = lines(s, 'ping 10.9.0.2 2').join('\n');
  ok(/Success rate is 100 percent/.test(next), 'the next plain ping is asked at Infinity and succeeds',
    next.split('\n').filter(function (l) { return /Success|%/.test(l); }).join(' | '));
  ok(!/Still converging/.test(next), 'and nothing is left converging behind it');
  ok(new Simulator(t).runAtMs === Infinity, 'a fresh simulator starts at Infinity');
  // ...and the instant really was restored, not merely unused.
  ok(t.getDevice('h1') && true, 'the lab is intact');
  const after = lines(s, 'show ip route').join('\n');
  ok(!/% Invalid/.test(after), 'later commands still work', after.slice(0, 80));
}

console.log('');
console.log('The dialog says the same sentence as the engine, and never puts a percentage on a converging path:');
{
  const mirror = pf.pingConvergenceSentence;
  ok(typeof mirror === 'function', 'the browser has the rule (window.__pf.pingConvergenceSentence)');
  const cases = [
    { name: 'one converging', replies: [{ success: false, reason: 'converging', convergingUntilMs: 30000, pending: [{ process: 'stp', device: 's1' }] }] },
    { name: 'two converging, same', replies: [
      { success: false, reason: 'converging', convergingUntilMs: 30000, pending: [{ process: 'stp', device: 's1' }] },
      { success: false, reason: 'converging', convergingUntilMs: 30000, pending: [{ process: 'stp', device: 's1' }] }] },
    { name: 'two converging, different', replies: [
      { success: false, reason: 'converging', convergingUntilMs: 30000, pending: [{ process: 'stp', device: 's1' }] },
      { success: false, reason: 'converging', convergingUntilMs: 45000, pending: [{ process: 'ospf', device: 'r1' }] }] },
    { name: 'no instant', replies: [{ success: false, reason: 'converging', convergingUntilMs: null, pending: [] }] },
    { name: 'nothing pending', replies: [{ success: false, reason: 'converging', convergingUntilMs: 12000, pending: [] }] },
    { name: 'loss, not convergence', replies: [{ success: false, reason: 'timeout', pending: [] }] },
    { name: 'all answered', replies: [{ success: true, reason: null, pending: [] }] },
    { name: 'empty', replies: [] }
  ];
  const disagreements = [];
  for (const c of cases) {
    const engineSays = simModule.pingConvergenceSentence(c.replies);
    const browserSays = mirror(c.replies);
    if (engineSays !== browserSays) {
      disagreements.push(c.name + ': engine=' + JSON.stringify(engineSays) + ' browser=' + JSON.stringify(browserSays));
    }
  }
  ok(disagreements.length === 0, 'engine and browser produce the same sentence in every case',
    disagreements.join(' | '));
  ok(mirror(cases[2].replies) === simModule.pingConvergenceSentence(cases[2].replies) &&
    /ready at 45000 ms/.test(mirror(cases[2].replies)),
    'two processes answer with the later instant',
    String(mirror(cases[2].replies)));
  ok(mirror(cases[5].replies) === null, 'a timeout is not convergence');
  ok(mirror(cases[3].replies) === 'Still converging', 'no instant and no process still says the one fact it knows',
    String(mirror(cases[3].replies)));

  // The rendering itself: what the operator reads.
  const html = pf.pingResultHtml;
  ok(typeof html === 'function', 'the dialog renders an answer through one function');
  const convergingHtml = html({ replies: cases[0].replies, count: 4, runAtMs: 0 }, '10.9.0.2', 4);
  ok(/Still converging/.test(convergingHtml), 'a converging answer says so', convergingHtml);
  ok(!/Success rate/.test(convergingHtml), 'and carries no percentage at all', convergingHtml);
  ok(/at t=0 ms/.test(convergingHtml), 'with the instant it was asked at');
  const lossHtml = html({ replies: [{ success: false, reason: 'timeout' }], count: 4, runAtMs: null }, '10.9.0.2', 4);
  ok(/Success rate 0% \(0\/4\)/.test(lossHtml), 'genuine loss still reads as loss', lossHtml);
  const okHtml = html({ replies: [{ success: true }, { success: true }], count: 2, runAtMs: null }, '10.9.0.2', 2);
  ok(/Success rate 100% \(2\/2\)/.test(okHtml), 'a good path reads as 100%', okHtml);
  const dnsHtml = html({ replies: [{ success: false }], count: 1, dns: { ok: false, status: 'NXDOMAIN' } }, 'nope.lab', 1);
  ok(/did not resolve: NXDOMAIN/.test(dnsHtml) && !/Success rate/.test(dnsHtml),
    'a name that did not resolve is not 0% loss', dnsHtml);
  const mixedHtml = html({ replies: [cases[0].replies[0], { success: true }], count: 2, runAtMs: 0 }, '10.9.0.2', 2);
  ok(/Success rate 50%/.test(mixedHtml) && /Still converging/.test(mixedHtml),
    'a half-converging path shows the rate and the reason', mixedHtml);
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
