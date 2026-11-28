"use strict";
// A non-root's ports are paced by the ROOT's forward delay, not by the non-root's own config (#1722).
//
// The header lines already carry this fact - the Root ID line prints the timers the root advertised, the
// Bridge ID line the box's own (test/stp-timer-lines-source.test.js). This file is about the other half: the
// seconds a port actually spends in Listening and Learning. A bridge adopts the root's hello, forward delay
// and max age from the configuration BPDU - "BPDUs carry the configured Root Bridge Timers Values ... all
// switches in the Spanning Tree topology learn and use such Timers Values, ignoring local Timers Values"
// (Cisco Learning Network, "STP timers") - so a tree whose root runs a 4 s forward delay forwards every port
// 8 s after power-on, and a non-root left at the 15 s default is not 30 s behind.
//
// What this model used to do: `stpTimers(dev)` per device in the schedule, so the same tree converged at two
// speeds - 8 s on the root, 30 s on the defaulted non-root - while the report on that non-root printed the
// root's 4 s on its Root ID line. research/stp-root-timers-pace-the-tree.md has the sources.
const path = require('path');
const { loadCatalog } = require('../devices/registry');
const { Topology } = require('../engine/topology');
const { Simulator } = require('../engine/simulator');
const { runCommands } = require('../engine');
const { CliSession } = require('../engine/cli');

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

// Two switches face to face, `rootId` made root by bridge priority.
function pair(rootId, rootFd, otherFd) {
  const t = new Topology();
  t.addDevice(SW, 'sw1'); t.addDevice(SW, 'sw2');
  const sw1 = t.getDevice('sw1');
  const sw2 = t.getDevice('sw2');
  sw1.name = 'SW1'; sw2.name = 'SW2';
  sw1.config.stpPriority = rootId === 'sw1' ? 4096 : 32768;
  sw2.config.stpPriority = rootId === 'sw2' ? 4096 : 32768;
  const root = sw1.config.stpPriority === 4096 ? sw1 : sw2;
  const other = root === sw1 ? sw2 : sw1;
  if (rootFd) root.config.stpForwardDelaySec = rootFd;
  if (otherFd) other.config.stpForwardDelaySec = otherFd;
  t.connect('sw1', 'Fa0/1', 'sw2', 'Fa0/1', { mediaId: '1000base-t', speedMbps: 1000 });
  const sim = new Simulator(t);
  sim.recomputeStp();
  return { t: t, sim: sim };
}
function stpEntry(sched, id) {
  return sched.entries.filter(function (e) { return e.process === 'stp' && e.deviceId === id; })[0];
}
// The port's state at an instant: recompute the tree there and read what the bridge holds.
function portState(env, atMs) {
  env.sim.setRunTime(atMs);
  env.sim.recomputeStp();
  return env.t.getDevice('sw2').stp.states['Fa0/1'];
}

console.log('');
console.log('A 4 s forward delay on the root paces both bridges');
{
  const env = pair('sw1', 4, null);
  eq(env.sim.stpResult.root.key, 'sw1', 'SW1 is the root the election named');
  const sched = env.sim.getConvergence();
  eq(sched.byProcess.stp, 8000, 'the tree is done at 8 s, two of the 4 s delays');
  eq(stpEntry(sched, 'sw1').readyAtMs, 8000, 'the root forwards at 8 s, on its own timers');
  eq(stpEntry(sched, 'sw2').readyAtMs, 8000, 'and so does the non-root, which adopted them');
  ok(/the root SW1/.test(stpEntry(sched, 'sw2').basis), 'the basis names whose timers these are',
    stpEntry(sched, 'sw2').basis);
  eq(stpEntry(sched, 'sw2').forwardDelaySec, 4, 'and the number on the entry is the one in force');
}

console.log('');
console.log('The non-root port is in Listening, then Learning, then Forwarding on those numbers');
{
  const env = pair('sw1', 4, null);
  eq(portState(env, 3999), 'listening', 'at 3.999 s the port is still Listening');
  eq(portState(env, 7000), 'learning', 'at 7 s it is Learning');
  eq(portState(env, 8000), 'forwarding', 'at 8 s it forwards');
}

console.log('');
console.log('A non-root configured slow is not slowed: it is not running its own timers');
{
  const env = pair('sw1', 4, 20);
  const sched = env.sim.getConvergence();
  eq(sched.byProcess.stp, 8000, 'still 8 s, the root\'s number');
  eq(stpEntry(sched, 'sw2').forwardDelaySec, 4, 'the non-root entry carries 4, not its configured 20');
  const cli = new CliSession(env.t.getDevice('sw2'), env.t, env.sim);
  cli.run('enable');
  const lines = (cli.run('show spanning-tree').output || []).filter(function (l) { return /Hello Time/.test(l); });
  ok(/Forward Delay 4 sec/.test(lines[0] || ''), 'the Root ID line prints the root\'s 4 s', lines[0]);
  ok(/Forward Delay 20 sec/.test(lines[1] || ''), 'the Bridge ID line prints this box\'s own 20 s', lines[1]);
}

console.log('');
console.log('A non-root configured fast is not sped up either');
{
  const env = pair('sw1', null, 4);
  const sched = env.sim.getConvergence();
  eq(sched.byProcess.stp, 30000, 'the root\'s default 15 s still paces both bridges');
  eq(portState(env, 20000), 'learning', 'at 20 s the non-root port is Learning');
  eq(portState(env, 30000), 'forwarding', 'and forwards at 30 s, not at 8');
}

console.log('');
console.log('A box with no root to hear keeps its own timers');
{
  const t = new Topology();
  t.addDevice(SW, 'solo');
  t.getDevice('solo').name = 'SOLO';
  t.getDevice('solo').config.stpForwardDelaySec = 4;
  const sim = new Simulator(t);
  sim.recomputeStp();
  eq(sim.getConvergence().byProcess.stp, 8000, 'a lone switch converges on its own 4 s');
  eq(sim.stpResult.root.key, 'solo', 'because it is its own root');
}

console.log('');
console.log('A partitioned bridge has no BPDU to adopt, so it keeps its own config');
{
  const t = new Topology();
  ['sw1', 'sw2', 'sw3'].forEach(function (n) {
    t.addDevice(SW, n).name = n.toUpperCase();
  });
  t.getDevice('sw1').config.stpPriority = 4096;
  t.getDevice('sw1').config.stpForwardDelaySec = 4;
  t.connect('sw1', 'Fa0/1', 'sw2', 'Fa0/1', { mediaId: '1000base-t', speedMbps: 1000 });
  const cut = t.connect('sw2', 'Fa0/2', 'sw3', 'Fa0/1', { mediaId: '1000base-t', speedMbps: 1000 });
  const sim = new Simulator(t);
  sim.recomputeStp();
  eq(sim.getConvergence().byProcess.stp, 8000, 'with the link in, SW3 hears the 4 s root');
  sim.setLinkState(cut.id, 'down', { atMs: 0 });
  const sched = sim.getConvergence();
  eq(sim.stpResult.bridges.sw3.cost, Infinity, 'SW3 now has no path to the root');
  eq(stpEntry(sched, 'sw3').readyAtMs, 30000, 'so it falls back to its own 15 s, honestly');
  eq(stpEntry(sched, 'sw2').readyAtMs, 8000, 'while SW2, still hearing the root, uses its 4 s');
}

console.log('');
console.log('The reconvergence reply is the schedule\'s answer, not a factory constant');
{
  // A triangle: SW1 is root on 4 s, and pulling one side leaves both others hearing it the long way round.
  const t = new Topology();
  ['sw1', 'sw2', 'sw3'].forEach(function (n) {
    t.addDevice(SW, n).name = n.toUpperCase();
  });
  t.getDevice('sw1').config.stpPriority = 4096;
  t.getDevice('sw1').config.stpForwardDelaySec = 4;
  const l = t.connect('sw1', 'Fa0/1', 'sw2', 'Fa0/1', { mediaId: '1000base-t', speedMbps: 1000 });
  t.connect('sw1', 'Fa0/2', 'sw3', 'Fa0/1', { mediaId: '1000base-t', speedMbps: 1000 });
  t.connect('sw2', 'Fa0/2', 'sw3', 'Fa0/2', { mediaId: '1000base-t', speedMbps: 1000 });
  const sim = new Simulator(t);
  sim.recomputeStp();
  const res = sim.setLinkState(l.id, 'down', { atMs: 10000 });
  eq(res.reconvergeAtMs, 18000, 'the tree is whole again 8 s after the change, not 30');
  eq(sim.getConvergence().byProcess.stp, res.reconvergeAtMs, 'and the schedule agrees with the reply');
}

console.log('');
console.log('A failure that isolates a bridge leaves it on its own timers, and the reply says so');
{
  const t = new Topology();
  t.addDevice(SW, 'sw1'); t.addDevice(SW, 'sw2');
  t.getDevice('sw1').name = 'SW1'; t.getDevice('sw2').name = 'SW2';
  t.getDevice('sw1').config.stpPriority = 4096;
  t.getDevice('sw1').config.stpForwardDelaySec = 4;
  const l = t.connect('sw1', 'Fa0/1', 'sw2', 'Fa0/1', { mediaId: '1000base-t', speedMbps: 1000 });
  const sim = new Simulator(t);
  sim.recomputeStp();
  const res = sim.setLinkState(l.id, 'down', { atMs: 10000 });
  eq(sim.stpResult.bridges.sw2.cost, Infinity, 'SW2 has no path to the root any more');
  eq(res.reconvergeAtMs, 40000, 'so the answer is its own 30 s, not the root\'s 8 s');
}

// A switch's steady state at an instant, asked the way the console asks it: rebuild the tree at that instant
// and read the port. `recomputeStp()` is what the report, the board and the data plane all end up reading.
function portAt(env, id, port, atMs) {
  env.sim.setRunTime(atMs);
  env.sim.recomputeStp();
  return env.t.getDevice(id).stp.states[port];
}

console.log('');
console.log('A port that has just come out of Blocking does not forward at the instant of the change');
{
  // #1731. The schedule already re-based at the change; the *ports* did not. `stpPortStateAt()` compared the
  // absolute instant with a timer that started at t=0, so at t=60 s every port the new tree had just unblocked
  // read Forwarding - 8 s before the reply under it said the tree was whole. A triangle, so pulling one side
  // leaves SW3 with a new path the long way round through SW2.
  const t = new Topology();
  ['sw1', 'sw2', 'sw3'].forEach(function (n) { t.addDevice(SW, n).name = n.toUpperCase(); });
  t.getDevice('sw1').config.stpPriority = 4096;
  t.getDevice('sw1').config.stpForwardDelaySec = 4;
  const l = t.connect('sw1', 'Fa0/1', 'sw2', 'Fa0/1', { mediaId: '1000base-t', speedMbps: 1000 });
  t.connect('sw1', 'Fa0/2', 'sw3', 'Fa0/1', { mediaId: '1000base-t', speedMbps: 1000 });
  t.connect('sw2', 'Fa0/2', 'sw3', 'Fa0/2', { mediaId: '1000base-t', speedMbps: 1000 });
  const env = { t: t, sim: new Simulator(t) };
  env.sim.recomputeStp();
  eq(env.t.getDevice('sw3').stp.states['Fa0/2'], 'blocking', 'before the change SW3 blocks its way to SW2');
  const res = env.sim.setLinkState(l.id, 'down', { atMs: 60000 });
  eq(res.reconvergeAtMs, 68000, 'the reply says the tree is whole 8 s after the change');
  eq(stpEntry(env.sim.getConvergence(), 'sw3').readyAtMs, 68000, 'and the schedule says the same');
  eq(portAt(env, 'sw3', 'Fa0/2', 60000), 'listening',
    'at the instant of the change the newly unblocked port is Listening, not Forwarding');
  eq(portAt(env, 'sw3', 'Fa0/2', 63999), 'listening', 'still Listening one second before one forward delay is up');
  eq(portAt(env, 'sw3', 'Fa0/2', 64000), 'learning', 'Learning at 4 s, the root\'s delay');
  eq(portAt(env, 'sw3', 'Fa0/2', 67999), 'learning', 'still Learning one second before two are up');
  eq(portAt(env, 'sw3', 'Fa0/2', 68000), 'forwarding', 'Forwarding at exactly the instant the reply promised');
  eq(portAt(env, 'sw3', 'Fa0/1', 60000), 'forwarding',
    'and the port that was already forwarding was not interrupted by the change');
}

console.log('');
console.log('A bridge that loses the root with its root port still up waits out Max Age first');
{
  // #1731. SW1 is root, SW2 is in the middle, SW3 is behind it. Pulling SW1-SW2 takes SW2's own root port
  // down - its information goes with the port, so it re-runs its own timers at once. SW3's port to SW2 is
  // still up and still plugged in; what stopped is the BPDU stream. 802.1D keeps the last configuration BPDU
  // until Max Age expires, and only then may the box believe itself root and run Listening and Learning.
  const t = new Topology();
  ['sw1', 'sw2', 'sw3'].forEach(function (n) { t.addDevice(SW, n).name = n.toUpperCase(); });
  t.getDevice('sw1').config.stpPriority = 4096;
  t.getDevice('sw1').config.stpForwardDelaySec = 4;
  const l = t.connect('sw1', 'Fa0/1', 'sw2', 'Fa0/1', { mediaId: '1000base-t', speedMbps: 1000 });
  t.connect('sw2', 'Fa0/2', 'sw3', 'Fa0/1', { mediaId: '1000base-t', speedMbps: 1000 });
  const env = { t: t, sim: new Simulator(t) };
  env.sim.recomputeStp();
  eq(env.sim.getConvergence().byProcess.stp, 8000, 'in the whole tree everyone is paced by the 4 s root');
  const res = env.sim.setLinkState(l.id, 'down', { atMs: 10000 });
  const sched = env.sim.getConvergence();
  eq(stpEntry(sched, 'sw2').readyAtMs, 40000,
    'SW2 lost the root port itself, so it runs its own 30 s from the change with no wait');
  eq(stpEntry(sched, 'sw3').readyAtMs, 60000,
    'SW3 still has its root port, so it waits 20 s of max age and then 30 s of its own');
  eq(res.reconvergeAtMs, 60000, 'and the reply to the pull is the last of those, not the first');
  ok(/max-age 20 s/.test(stpEntry(sched, 'sw3').basis), 'the basis names the max age it is waiting out',
    stpEntry(sched, 'sw3').basis);
  ok(/root port Fa0\/1 still up/.test(stpEntry(sched, 'sw3').basis),
    'and why it waits rather than discarding: the port is still there', stpEntry(sched, 'sw3').basis);
  ok(!/max-age/.test(stpEntry(sched, 'sw2').basis), 'while SW2, which lost the port, names no max age',
    stpEntry(sched, 'sw2').basis);
  eq(portAt(env, 'sw3', 'Fa0/1', 29999), 'forwarding',
    'SW3 keeps forwarding on the tree it still believes in until the information ages out');
  eq(portAt(env, 'sw3', 'Fa0/1', 30000), 'listening',
    'at max age it starts claiming to be root, and its port goes back to Listening');
  eq(portAt(env, 'sw3', 'Fa0/1', 59999), 'learning', 'Learning one second before its own 30 s are up');
  eq(portAt(env, 'sw3', 'Fa0/1', 60000), 'forwarding', 'Forwarding at the instant the schedule named');
}

console.log('');
console.log('A bridge that never had the root does not wait for Max Age at power-on');
{
  // The other side of the same rule: there was no BPDU to age out. An isolated switch is root from t=0 and
  // runs its own two forward delays, with no 20 s in front of them.
  const t = new Topology();
  t.addDevice(SW, 'sw1').name = 'SW1';
  const sim = new Simulator(t);
  sim.recomputeStp();
  eq(sim.getConvergence().byProcess.stp, 30000, 'a lone switch forwards after its own two 15 s delays');
  ok(!/max-age/.test(stpEntry(sim.getConvergence(), 'sw1').basis), 'and the basis does not invent a wait',
    stpEntry(sim.getConvergence(), 'sw1').basis);
}

console.log('');
console.log('Closing the port that carries the BPDUs is the same wait as a cut upstream');
{
  // A port an operator administratively disables keeps the far end's socket and takes its BPDUs away - the
  // ageing-out case, reached from configuration rather than from `link down`. The console marks a configuration
  // change as a topology change (#1331), so the schedule is re-based at it like any other.
  const t = new Topology();
  ['sw1', 'sw2', 'sw3'].forEach(function (n) { t.addDevice(SW, n).name = n.toUpperCase(); });
  t.getDevice('sw1').config.stpPriority = 4096;
  t.getDevice('sw1').config.stpForwardDelaySec = 4;
  t.connect('sw1', 'Fa0/1', 'sw2', 'Fa0/1', { mediaId: '1000base-t', speedMbps: 1000 });
  t.connect('sw2', 'Fa0/2', 'sw3', 'Fa0/1', { mediaId: '1000base-t', speedMbps: 1000 });
  const env = { t: t, sim: new Simulator(t) };
  env.sim.recomputeStp();
  env.sim.setRunTime(10000);
  runCommands(t.getDevice('sw1'), t, env.sim,
    ['configure terminal', 'interface Fa0/1', 'shutdown', 'end']);
  // The console marks the change; the tree is rebuilt when something asks for it, which is what every view
  // (`show spanning-tree`, the board) does. Ask for it here too, or the schedule would quote no election at all.
  env.sim.recomputeStp();
  const sched = env.sim.getConvergence();
  eq(stpEntry(sched, 'sw2').readyAtMs, 60000,
    'SW2 keeps its root port and waits 20 s of max age, then its own 30 s');
  ok(/max-age 20 s/.test(stpEntry(sched, 'sw2').basis), 'and says so', stpEntry(sched, 'sw2').basis);
  eq(portAt(env, 'sw2', 'Fa0/2', 29999), 'forwarding', 'it forwards on the old tree while the information ages');
  eq(portAt(env, 'sw2', 'Fa0/2', 30000), 'listening', 'and starts over once it has aged out');
  eq(portAt(env, 'sw2', 'Fa0/2', 60000), 'forwarding', 'the instant the schedule named');
}

console.log('');
if (failed) { console.error(failed + ' failed, ' + passed + ' passed'); process.exit(1); }
console.log(passed + ' passed, 0 failed');
