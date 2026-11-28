"use strict";
// The window in which a bridge adopts the root's timers (#1731).
//
// `stpTimersInForce()` says *whose* forward delay paces a non-root's ports, and #1722 landed that. It also implied
// they had been running since the lab's t=0, whatever instant the box first heard the root: a non-root that
// powered on before the root ran the root's numbers for the minutes in between, and `hello` - carried on every
// adopted timer set and printed beside the forward delay - was counted by nothing.
//
// The model now has an instant for it. A bridge transmits a configuration BPDU from a port the moment that port
// becomes designated, which at power-on is at once, so the root's first BPDU leaves at the root's own boot. A
// bridge powered on with the root (or before it) therefore accepts it at that instant; a bridge powered on into a
// tree that is already running waits out the remainder of the root's hello timer, and one hello is the worst case.
// Until it accepts that BPDU it believes it is the root and runs its own numbers - which is the state
// `stpPortStateAt()` has to answer for, instead of counting the root's two forward delays from t=0.
//
// A re-convergence is not charged a hello: a box that was already hearing the root holds its BPDU, so a cable
// moving somewhere else in the lab does not restart the adoption clock. research/stp-root-timers-pace-the-tree.md.
const path = require('path');
const { loadCatalog } = require('../devices/registry');
const { Topology } = require('../engine/topology');
const { Simulator } = require('../engine/simulator');
const conv = require('../engine/convergence');
const cliModule = require('../engine/cli');
const CliSession = cliModule.CliSession || cliModule;

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}
function eq(got, want, msg) {
  ok(got === want, msg, JSON.stringify(got) + ' != ' + JSON.stringify(want));
}

const specs = loadCatalog(path.join(__dirname, '..', 'devices')).filter(function (s) { return !s.error; });
const SW = specs.find(function (s) { return s.model === 'generic-switch'; });

// Two switches face to face. `boot` is { sw1, sw2 } in ms; a box that is not named was powered with the lab.
function pair(opt) {
  const o = opt || {};
  const t = new Topology();
  t.addDevice(SW, 'sw1'); t.addDevice(SW, 'sw2');
  const sw1 = t.getDevice('sw1'), sw2 = t.getDevice('sw2');
  sw1.name = 'SW1'; sw2.name = 'SW2';
  sw1.config.stpPriority = o.root === 'sw2' ? 32768 : 4096;
  sw2.config.stpPriority = o.root === 'sw2' ? 4096 : 32768;
  if (o.rootFd) sw1.config.stpForwardDelaySec = o.rootFd;
  if (o.otherFd) sw2.config.stpForwardDelaySec = o.otherFd;
  if (o.hello) sw1.config.stpHelloSec = o.hello;
  const boot = o.boot || {};
  if (boot.sw1) sw1.bootedAtMs = boot.sw1;
  if (boot.sw2) sw2.bootedAtMs = boot.sw2;
  t.connect('sw1', 'Fa0/1', 'sw2', 'Fa0/1', { mediaId: '1000base-t', speedMbps: 1000 });
  const sim = new Simulator(t);
  sim.recomputeStp();
  return { t: t, sim: sim };
}
function stpEntry(sched, id) {
  return sched.entries.filter(function (e) { return e.process === 'stp' && e.deviceId === id; })[0];
}
function stateAt(env, id, port, atMs) {
  env.sim.setRunTime(atMs);
  env.sim.recomputeStp();
  return env.t.getDevice(id).stp.states[port];
}

console.log('');
console.log('The adoption instant is arithmetic on boots, not a constant');
{
  const env = pair({ rootFd: 4 });
  const ad = conv.stpAdoption(env.t, env.sim.stpResult, env.t.getDevice('sw2'), { fromMs: 0 });
  eq(ad.rootDev && ad.rootDev.id, 'sw1', 'the election names SW1 as the root SW2 hears');
  eq(ad.adopts, true, 'so SW2 adopts its timers');
  eq(ad.helloMs, 2000, 'the root advertises a 2 s hello');
  eq(ad.adoptedAtMs, 0, 'powered on together, so the first BPDU is at once and no hello is owed');
  const own = conv.stpAdoption(env.t, env.sim.stpResult, env.t.getDevice('sw1'), { fromMs: 0 });
  eq(own.adopts, false, 'the root adopts nothing - it is the one being heard');
  eq(own.adoptedAtMs, 0, 'and its own clocks start at its own boot');
  const none = conv.stpAdoption(env.t, null, env.t.getDevice('sw2'), { fromMs: 0 });
  eq(none.rootDev, null, 'no election means no root to adopt');
  eq(none.adoptedAtMs, 0, 'so SW2 falls back to its own boot instant');
}

console.log('');
console.log('A root powered on late is heard at its boot, not one hello after it');
{
  const env = pair({ rootFd: 4, boot: { sw1: 5000 } });
  const ad = conv.stpAdoption(env.t, env.sim.stpResult, env.t.getDevice('sw2'), { fromMs: 0 });
  eq(ad.adoptedAtMs, 5000, 'SW2 hears SW1 the moment SW1 sends, and SW1 sends at power-on');
  const sched = env.sim.getConvergence();
  eq(stpEntry(sched, 'sw1').readyAtMs, 13000, 'the root itself forwards 8 s after its own boot, not at 8 s');
  eq(stpEntry(sched, 'sw2').readyAtMs, 13000, 'and the non-root is paced from the same instant');
  ok(/powered on at 5000 ms/.test(stpEntry(sched, 'sw1').basis), 'the root\'s basis says when it came up',
    stpEntry(sched, 'sw1').basis);
  eq(stateAt(env, 'sw2', 'Fa0/1', 8000), 'listening',
    'at 8 s SW2 is still Listening - the old model had it Forwarding with a root that was not up yet');
  eq(stateAt(env, 'sw2', 'Fa0/1', 9000), 'learning', 'Learning once the root\'s forward delay has run');
  eq(stateAt(env, 'sw2', 'Fa0/1', 13000), 'forwarding', 'and Forwarding at 13 s');
}

console.log('');
console.log('A non-root powered on into a running tree waits one hello and runs its own numbers until then');
{
  const env = pair({ rootFd: 4, boot: { sw2: 5000 } });
  const ad = conv.stpAdoption(env.t, env.sim.stpResult, env.t.getDevice('sw2'), { fromMs: 0 });
  eq(ad.adoptedAtMs, 7000, 'SW2 comes up at 5 s and waits at most one 2 s hello for SW1\'s next BPDU');
  const sched = env.sim.getConvergence();
  eq(stpEntry(sched, 'sw2').readyAtMs, 15000, 'so the root\'s two 4 s delays start at 7 s and end at 15 s');
  eq(stpEntry(sched, 'sw1').readyAtMs, 8000, 'while the root, up before it, forwards at 8 s as always');
  ok(/heard the root SW1 at 7000 ms/.test(stpEntry(sched, 'sw2').basis),
    'the basis names the instant the root was heard', stpEntry(sched, 'sw2').basis);
  eq(stateAt(env, 'sw2', 'Fa0/1', 4999), 'blocking', 'before it is powered on its port drops, like a dark port');
  eq(stateAt(env, 'sw2', 'Fa0/1', 6000), 'listening',
    'at 6 s it is Listening on its OWN 15 s forward delay, not the root\'s 4 s');
  eq(stateAt(env, 'sw2', 'Fa0/1', 7000), 'listening', 'Listening again from the adoption instant');
  eq(stateAt(env, 'sw2', 'Fa0/1', 11000), 'learning', 'Learning one root forward delay later');
  eq(stateAt(env, 'sw2', 'Fa0/1', 15000), 'forwarding', 'and Forwarding where the schedule said');
}

console.log('');
console.log('The hello that is counted is the root\'s, because that is the timer in force');
{
  const env = pair({ rootFd: 4, hello: 4, boot: { sw2: 5000 } });
  const ad = conv.stpAdoption(env.t, env.sim.stpResult, env.t.getDevice('sw2'), { fromMs: 0 });
  eq(ad.helloMs, 4000, 'SW1 advertises a 4 s hello');
  eq(ad.adoptedAtMs, 9000, 'so a box up at 5 s waits until SW1\'s next one, at 9 s');
  eq(stpEntry(env.sim.getConvergence(), 'sw2').readyAtMs, 17000, 'and finishes 8 s later');
}

console.log('');
console.log('A cable moving elsewhere does not restart the adoption clock');
{
  const env = pair({ rootFd: 4, boot: { sw1: 3000 } });
  const l1 = env.t.connect('sw1', 'Fa0/2', 'sw2', 'Fa0/2', { mediaId: '1000base-t', speedMbps: 1000 });
  env.sim.recomputeStp();
  const res = env.sim.setLinkState(l1.id, 'down', { atMs: 20000 });
  eq(res.reconvergeAtMs, 28000, 'the change costs the root\'s two forward delays, and no hello after it');
  const e = stpEntry(env.sim.getConvergence(), 'sw2');
  eq(e.adoptedAtMs, 20000, 'SW2 was already hearing SW1, so the change is where its clocks start');
  eq(e.readyAtMs, 28000, 'and the entry agrees with the reply');
}

console.log('');
console.log('A box powered on after the change has no stored BPDU, so no Max Age to sit out');
{
  const t = new Topology();
  ['sw1', 'sw2', 'sw3'].forEach(function (n) { t.addDevice(SW, n).name = n.toUpperCase(); });
  t.getDevice('sw1').config.stpPriority = 4096;
  t.getDevice('sw1').config.stpForwardDelaySec = 4;
  t.getDevice('sw1').config.stpMaxAgeSec = 10;
  t.getDevice('sw3').bootedAtMs = 30000;
  const near = t.connect('sw1', 'Fa0/1', 'sw2', 'Fa0/1', { mediaId: '1000base-t', speedMbps: 1000 });
  t.connect('sw2', 'Fa0/2', 'sw3', 'Fa0/1', { mediaId: '1000base-t', speedMbps: 1000 });
  const sim = new Simulator(t);
  sim.recomputeStp();
  sim.setLinkState(near.id, 'down', { atMs: 10000 });
  const e = stpEntry(sim.getConvergence(), 'sw3');
  eq(e.maxAgeHoldMs, 0, 'nothing was ever heard on a dark switch, so nothing can age out');
  eq(e.adoptedAtMs, 30000, 'its clocks start when it is powered on');
  eq(e.readyAtMs, 60000, 'and it walks its own 15 s twice from there');
  ok(/^powered on at 30000 ms, then listening \+ learning \(15 s forward-delay each\)/.test(e.basis),
    'the basis says both facts, in the order they happen', e.basis);
}

console.log('');
console.log('The console prints the window it used');
{
  const env = pair({ rootFd: 4, boot: { sw2: 5000 } });
  const s = new CliSession(env.t.getDevice('sw2'), env.t, env.sim);
  const out = (s.run('converge').output || []).map(String).join('\n');
  ok(/stp\s+SW2\s+15000 ms\s+heard the root SW1 at 7000 ms, then listening \+ learning \(4 s forward-delay each/
    .test(out), 'one row, one sentence: the instant, then the delays it starts', out);
}

console.log('');
if (failed) { console.error(failed + ' failed, ' + passed + ' passed'); process.exit(1); }
console.log(passed + ' passed, 0 failed');
