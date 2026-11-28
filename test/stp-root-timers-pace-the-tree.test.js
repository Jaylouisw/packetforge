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

// The port's state on a named device at an instant: recompute the tree there and read what the bridge holds.
function stateAt(sim, topo, devId, port, atMs) {
  sim.setRunTime(atMs);
  sim.recomputeStp();
  return topo.getDevice(devId).stp.states[port];
}

console.log('');
console.log('A port that came out of Blocking listens at the instant of the change, not before it');
{
  // This is the "window" half of #1731. `link down` at 60 s answered "Network converges again at 68000 ms"
  // - two of the root's 4 s forward delays, from the change - while every port the new tree had just
  // unblocked read Forwarding the same instant, because stpPortStateAt() compared the absolute clock with a
  // timer that started at t=0. The schedule knew when the transition began; the port state did not ask.
  const t = new Topology();
  t.addDevice(SW, 'sw1'); t.addDevice(SW, 'sw2');
  t.getDevice('sw1').name = 'SW1'; t.getDevice('sw2').name = 'SW2';
  t.getDevice('sw1').config.stpPriority = 4096;
  t.getDevice('sw1').config.stpForwardDelaySec = 4;
  const a = t.connect('sw1', 'Fa0/1', 'sw2', 'Fa0/1', { mediaId: '1000base-t', speedMbps: 1000 });
  t.connect('sw1', 'Fa0/2', 'sw2', 'Fa0/2', { mediaId: '1000base-t', speedMbps: 1000 });
  const sim = new Simulator(t);
  sim.recomputeStp();
  eq(sim.stpResult.ports.sw2['Fa0/2'].state, 'blocking',
    'SW2 blocks its second cable while the first one works');
  const res = sim.setLinkState(a.id, 'down', { atMs: 60000 });
  eq(res.reconvergeAtMs, 68000, 'the change is answered with 8 s from the change, on the root 4 s');
  const sched = sim.getConvergence();
  eq(stpEntry(sched, 'sw2').startedAtMs, 60000, 'and the schedule says the timers started at the change');
  eq(stpEntry(sched, 'sw2').readyAtMs, 68000, 'and finish 8 s later');
  eq(stateAt(sim, t, 'sw2', 'Fa0/2', 60000), 'listening',
    'the port the tree has just unblocked is Listening at the instant of the change, not Forwarding');
  eq(stateAt(sim, t, 'sw2', 'Fa0/2', 63999), 'listening', 'still Listening just before 64 s');
  eq(stateAt(sim, t, 'sw2', 'Fa0/2', 64000), 'learning', 'Learning at 64 s');
  eq(stateAt(sim, t, 'sw2', 'Fa0/2', 67999), 'learning', 'still Learning just before 68 s');
  eq(stateAt(sim, t, 'sw2', 'Fa0/2', 68000), 'forwarding', 'and Forwarding when the answer said it would be');
}

console.log('');
console.log('The Max Age a partitioned bridge waits out is Blocking, not Listening');
{
  // A box that loses the root without losing a port sits on the old root's BPDU until it ages out
  // (#1746 put that wait in the schedule). During the wait the port is not transitioning yet - it is
  // still dropping, and saying Listening would move every state 10 s earlier than the answer.
  const t = new Topology();
  ['sw1', 'sw2', 'sw3'].forEach(function (n) { t.addDevice(SW, n).name = n.toUpperCase(); });
  t.getDevice('sw1').config.stpPriority = 4096;
  t.getDevice('sw1').config.stpForwardDelaySec = 4;
  t.getDevice('sw1').config.stpMaxAgeSec = 10;
  const near = t.connect('sw1', 'Fa0/1', 'sw2', 'Fa0/1', { mediaId: '1000base-t', speedMbps: 1000 });
  t.connect('sw2', 'Fa0/2', 'sw3', 'Fa0/1', { mediaId: '1000base-t', speedMbps: 1000 });
  const sim = new Simulator(t);
  sim.recomputeStp();
  eq(sim.getConvergence().byProcess.stp, 8000, 'the tree is on the root 4 s before the cut');
  const res = sim.setLinkState(near.id, 'down', { atMs: 10000 });
  eq(res.reconvergeAtMs, 50000, 'SW3 needs the 10 s Max Age and its own 30 s');
  eq(stateAt(sim, t, 'sw3', 'Fa0/1', 19999), 'blocking',
    'at 19.999 s SW3 is still waiting for the old root BPDU to age out, so the port is Blocking');
  eq(stateAt(sim, t, 'sw3', 'Fa0/1', 20000), 'listening', 'Listening once it has aged out, at 20 s');
  eq(stateAt(sim, t, 'sw3', 'Fa0/1', 34999), 'listening', 'still Listening just before 35 s');
  eq(stateAt(sim, t, 'sw3', 'Fa0/1', 35000), 'learning', 'Learning at 35 s');
  eq(stateAt(sim, t, 'sw3', 'Fa0/1', 49999), 'learning', 'and Forwarding at 50 s, where the reply pointed');
  eq(stateAt(sim, t, 'sw3', 'Fa0/1', 50000), 'forwarding', 'exactly then');
}

console.log('');
if (failed) { console.error(failed + ' failed, ' + passed + ' passed'); process.exit(1); }
console.log(passed + ' passed, 0 failed');
