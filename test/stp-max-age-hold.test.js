"use strict";
// A bridge that loses the root without losing a port waits Max Age before it believes itself (#1731).
//
// The window this file is about is not the forward delay but what comes before it. Two failures look the
// same from the graph and are not the same event on a box:
//
//   direct    this box own port goes down. The stored BPDU on that port is invalidated on the spot, the box
//             falls back to its own configuration, and its ports are Listening Forward Delay from the
//             instant the cable moved: 30 s with the defaults.
//   indirect  the cable that broke is somewhere else. This box ports are still up and merely stop
//             receiving. The stored configuration BPDU lives out its Max Age before it is discarded, and
//             only then may the box claim the root role and start Listening/Learning: 20 s + 30 s.
//
// Cisco, "Understand and Configure Backbone Fast on Catalyst Switches" (doc 12014), on the indirect case:
// "After max_age timer expires (20 seconds by default), the BPDU stored on S for port P ages out ... Port P
// moves to the forwarding state through listening and learning states. This takes twice the fw_delay
// value, an additional 30 seconds ... It took the max_age value (20 seconds) plus twice the fw_delay value
// (2x15 seconds) to recover from this indirect link failure. This is 50 seconds with the default
// parameters." The same note says backbone fast "only works if a bridge detects a direct link failure" -
// the 20 s is exactly what a direct failure does not pay. research/stp-max-age-hold.md.
//
// What the model used to do: stpRootOf() saw cost === Infinity and handed the partitioned box its own
// timers from the instant of the change, so an indirect failure converged in 30 s - the direct-failure
// number, for the failure that is 20 s slower.
//
// The wait is not the whole Max Age either: the age timer starts at the Message Age the cached BPDU carries,
// so a bridge two bridges from the root (SW3 here, whose root port faces SW2) ages 10 - 1 = 9 s. The numbers
// below were one second higher until that subtraction was modelled; research/stp-message-age.md.
const path = require('path');
const { loadCatalog } = require('../devices/registry');
const { Topology } = require('../engine/topology');
const { Simulator } = require('../engine/simulator');
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

function stpEntry(sched, id) {
  return sched.entries.filter(function (e) { return e.process === 'stp' && e.deviceId === id; })[0];
}

// SW1 -- SW2 -- SW3. SW1 is root; the cable between SW1 and SW2 is the one that will be cut, which leaves
// SW3 (whose own links are untouched) with no path to the root and no BPDU to say so.
function line(rootOpts, farOpts) {
  const t = new Topology();
  ['sw1', 'sw2', 'sw3'].forEach(function (n) { t.addDevice(SW, n).name = n.toUpperCase(); });
  const sw1 = t.getDevice('sw1');
  sw1.config.stpPriority = 4096;
  sw1.config.stpForwardDelaySec = 4;
  const o = rootOpts || {};
  if (o.maxAgeSec !== undefined) sw1.config.stpMaxAgeSec = o.maxAgeSec;
  const f = farOpts || {};
  if (f.maxAgeSec !== undefined) t.getDevice('sw3').config.stpMaxAgeSec = f.maxAgeSec;
  if (f.forwardDelaySec !== undefined) t.getDevice('sw3').config.stpForwardDelaySec = f.forwardDelaySec;
  const near = t.connect('sw1', 'Fa0/1', 'sw2', 'Fa0/1', { mediaId: '1000base-t', speedMbps: 1000 });
  const far = t.connect('sw2', 'Fa0/2', 'sw3', 'Fa0/1', { mediaId: '1000base-t', speedMbps: 1000 });
  const sim = new Simulator(t);
  sim.recomputeStp();
  return { t: t, sim: sim, near: near.id || near, far: far.id || far };
}

console.log('');
console.log('An indirect failure pays the old root Max Age before the transition');
{
  // SW1 runs a 4 s forward delay and a 10 s Max Age, so "the root number" and "the default" differ on both
  // halves of the arithmetic.
  const env = line({ maxAgeSec: 10 });
  eq(env.sim.getConvergence().byProcess.stp, 8000, 'the whole tree is on the 4 s root before the cut');
  const res = env.sim.setLinkState(env.near, 'down', { atMs: 10000 });
  const sched = env.sim.getConvergence();
  eq(env.sim.stpResult.bridges.sw3.cost, Infinity, 'SW3 has no path to the root any more');
  eq(stpEntry(sched, 'sw3').maxAgeHoldMs, 9000,
    'SW3 waits what is left of the Max Age that was in force: 10 s less the 1 s message age it stored');
  eq(stpEntry(sched, 'sw3').readyAtMs, 49000, '9 s of Max Age left + 2 x 15 s own forward delay = 49 s after the change');
  eq(stpEntry(sched, 'sw3').forwardDelaySec, 15, 'the transition runs on SW3 own 15 s, because by then it is root');
  ok(/Max Age/.test(stpEntry(sched, 'sw3').basis),
    'the schedule says why it is waiting, not just how long', stpEntry(sched, 'sw3').basis);
  eq(res.reconvergeAtMs, sched.byProcess.stp, 'the reply to the cable change is the schedule own answer');
  eq(res.reconvergeAtMs, 49000, 'so the console can promise 49 s, not 30');
  ok(res.affects.indexOf('sw3') === -1, 'SW3 is not one end of the cable that moved');
}

console.log('');
console.log('The wait is the old root number, the transition is the box own');
{
  // SW3 is given a 40 s Max Age of its own and a 4 s forward delay. Neither is in force while it is a
  // non-root: the BPDU in its port came from SW1, so it is SW1 10 s that expires, and by the time its own
  // ports transition it is the root of its island, so its 4 s is what paces them.
  const env = line({ maxAgeSec: 10 }, { maxAgeSec: 40, forwardDelaySec: 4 });
  const res = env.sim.setLinkState(env.near, 'down', { atMs: 0 });
  const e = stpEntry(env.sim.getConvergence(), 'sw3');
  eq(e.maxAgeHoldMs, 9000, 'SW3 own 40 s Max Age does not stretch the wait, and the stored 1 s message age shortens it');
  eq(e.forwardDelaySec, 4, 'and its own 4 s forward delay is the one that paces the transition');
  eq(e.readyAtMs, 17000, '9 s + 2 x 4 s');
  eq(stpEntry(env.sim.getConvergence(), 'sw2').readyAtMs, 30000, 'SW2, whose own port went down, is the slower box at 30 s');
  eq(res.reconvergeAtMs, 30000, 'so the island as a whole is announced at 30 s, while SW3 itself forwards at 18 s');
}

console.log('');
console.log('A direct failure still converges in two forward delays');
{
  const env = line({ maxAgeSec: 10 });
  const res = env.sim.setLinkState(env.far, 'down', { atMs: 0 });
  eq(env.sim.stpResult.bridges.sw3.cost, Infinity, 'SW3 is isolated again');
  eq(stpEntry(env.sim.getConvergence(), 'sw3').maxAgeHoldMs, 0, 'but its own port went down, so nothing has to age out');
  eq(res.reconvergeAtMs, 30000, 'so it converges in 30 s, the direct-failure number');
}

console.log('');
console.log('A bridge that still hears the root does not wait for anything to expire');
{
  // A triangle: pulling SW1-SW2 leaves both others hearing SW1 the long way round, which is a superior
  // BPDU on another port - it supersedes, and nothing ages out.
  const t = new Topology();
  ['sw1', 'sw2', 'sw3'].forEach(function (n) { t.addDevice(SW, n).name = n.toUpperCase(); });
  t.getDevice('sw1').config.stpPriority = 4096;
  t.getDevice('sw1').config.stpForwardDelaySec = 4;
  t.getDevice('sw1').config.stpMaxAgeSec = 10;
  const l = t.connect('sw1', 'Fa0/1', 'sw2', 'Fa0/1', { mediaId: '1000base-t', speedMbps: 1000 });
  t.connect('sw1', 'Fa0/2', 'sw3', 'Fa0/1', { mediaId: '1000base-t', speedMbps: 1000 });
  t.connect('sw2', 'Fa0/2', 'sw3', 'Fa0/2', { mediaId: '1000base-t', speedMbps: 1000 });
  const sim = new Simulator(t);
  sim.recomputeStp();
  const res = sim.setLinkState(l.id, 'down', { atMs: 10000 });
  eq(stpEntry(sim.getConvergence(), 'sw3').maxAgeHoldMs, 0, 'SW3 is still hearing the root, so no Max Age wait');
  eq(res.reconvergeAtMs, 18000, 'the tree is whole again on the root 4 s forward delay, as before');
}

console.log('');
console.log('Nothing to age out: a converged board, and a cable put back');
{
  const env = line({ maxAgeSec: 10 });
  eq(stpEntry(env.sim.getConvergence(), 'sw3').maxAgeHoldMs, 0, 'a converged board carries no Max Age hold');
  eq(stpEntry(env.sim.getConvergence(), 'sw3').readyAtMs, 8000, 'and is paced by the root 4 s');

  env.sim.setLinkState(env.near, 'down', { atMs: 0 });
  const back = env.sim.setLinkState(env.near, 'up', { atMs: 300000 });
  eq(stpEntry(env.sim.getConvergence(), 'sw3').maxAgeHoldMs, 0,
    'putting the cable back gives SW3 a root again, so nothing has to expire');
  eq(back.reconvergeAtMs, 308000, 'and it converges on the root 8 s from the instant of the repair');
}

console.log('');
console.log('Each change is measured against the election it interrupted');
{
  const env = line({ maxAgeSec: 10 });
  env.sim.setLinkState(env.near, 'down', { atMs: 10000 });
  eq(stpEntry(env.sim.getConvergence(), 'sw3').maxAgeHoldMs, 9000, 'the indirect cut carries the wait, less one hop of message age');
  // A second change later, this time on SW3 own cable: that is a direct failure, and the record of the
  // first change must not be reused for it.
  const second = env.sim.setLinkState(env.far, 'down', { atMs: 20000 });
  eq(stpEntry(env.sim.getConvergence(), 'sw3').maxAgeHoldMs, 0,
    'the later direct cut carries no wait from the earlier one');
  eq(second.reconvergeAtMs, 50000, 'and converges 30 s after its own instant, not 20 s of history before it');
}

console.log('');
console.log('The console says the same number');
{
  const env = line({ maxAgeSec: 10 });
  const cli = new CliSession(env.t.getDevice('sw1'), env.t, env.sim);
  env.sim.setRunTime(10000);
  const out = ((cli.run('link down ' + env.near) || {}).output || []).join(String.fromCharCode(10));
  ok(/converges again at 49000 ms/.test(out), 'the tree is whole again 49 s after the cut', out.slice(0, 160));
  ok(!/converges again at 39000 ms/.test(out), 'not the 30 s a direct failure would take');
}

console.log('');
if (failed) { console.error(failed + ' failed, ' + passed + ' passed'); process.exit(1); }
console.log(passed + ' passed, 0 failed');
