"use strict";
// The Max Age a bridge has left is not Max Age: it is Max Age less the age of the BPDU it stored (#1751).
//
// STP tells time in two currencies and this engine knew only one of them. `cost` is the price of a path and
// it is paid in speed: 19 for a 100 Mb hop, 4 for a 1 Gb hop, 2 for 10 Gb. `Message Age` is the age of the
// configuration BPDU and it is paid in bridges: the root sends 0, and every bridge adds 1 before it forwards
// the message on, whatever the link it forwards it over. Cisco's timer guide, doc 19120, has both halves:
//
//   "The root bridge sends all its BPDUs with a message age value of 0, and all subsequent switches add 1 to
//    this value."
//   "The age timer starts at the message age that is received in that configuration BPDU ... Switches B and C
//    receive a configuration BPDU from switch A with a message age of 0. On the port that goes to A, the
//    information ages out in (max age - 0) seconds. This time is 20 seconds by default. Switches D and E
//    receive the BPDU from switch B with a message age of 1 ... (max age - 1) seconds. This time is 19
//    seconds by default. Switch F receives the BPDU from switch E with a message age of 2 ... 18 seconds."
//
// Huawei's STP timer chapter says the same and adds the discard rule that goes with it: a BPDU whose message
// age has reached max age is dropped, which is why the recommended diameter is seven bridges and not twenty.
// howtonetwork tabulates the arithmetic as Max Age - Message Age per switch.
//
// So a partitioned bridge ages its stored BPDU out after (max age - message age) seconds, and only then starts
// Listening/Learning. research/stp-message-age.md.
const path = require('path');
const { loadCatalog } = require('../devices/registry');
const { Topology } = require('../engine/topology');
const { Simulator } = require('../engine/simulator');
const convergence = require('../engine/convergence');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  ✓ ' + msg); }
  else { failed++; console.error('  ✗ ' + msg + (detail ? '  [' + detail + ']' : '')); }
}
function eq(got, want, msg) {
  ok(got === want, msg, JSON.stringify(got) + ' != ' + JSON.stringify(want));
}

const specs = loadCatalog(path.join(__dirname, '..', 'devices')).filter(function (s) { return !s.error; });
const SW = specs.find(function (s) { return s.model === 'generic-switch'; });

function stpEntry(sched, id) {
  return sched.entries.filter(function (e) { return e.process === 'stp' && e.deviceId === id; })[0];
}

// sw1 -- sw2 -- ... -- swN, one cable per pair, root = sw1.
function chain(n, speeds) {
  const t = new Topology();
  const names = [];
  const links = [];
  for (let i = 1; i <= n; i++) {
    const id = 'sw' + i;
    t.addDevice(SW, id).name = id.toUpperCase();
    names.push(id);
  }
  t.getDevice('sw1').config.stpPriority = 4096;
  for (let i = 2; i <= n; i++) {
    const l = t.connect('sw' + (i - 1), 'Fa0/' + (i === 2 ? 1 : 2), 'sw' + i, 'Fa0/1', {
      mediaId: '1000base-t', speedMbps: (speeds && speeds[i - 2]) || 1000
    });
    links.push(l.id || l);
  }
  const sim = new Simulator(t);
  sim.recomputeStp();
  return { t: t, sim: sim, names: names, links: links };
}

console.log('');
console.log('A hop is a bridge, not a link cost');
{
  // 100 Mb (cost 19), then 10 Gb (cost 2): the two hops are worth 21 in cost and 2 in age.
  const env = chain(3, [100, 10000]);
  const b = env.sim.stpResult.bridges;
  eq(b.sw1.hops, 0, 'the root has crossed no bridge, so it sends message age 0');
  eq(b.sw2.hops, 1, 'one bridge away');
  eq(b.sw3.hops, 2, 'two, whatever the links cost');
  eq(b.sw2.cost, 19, 'the root path cost is the 100 Mb number');
  eq(b.sw3.cost, 21, 'and the 10 Gb hop adds 2 to it, not 1');
  eq(convergence.stpMessageAgeOf(b.sw3), 1, 'so the BPDU stored on SW3 reads message age 1, not 21');
  eq(convergence.stpMessageAgeOf(b.sw1), null, 'the root stores no BPDU from anyone, so its age is unknown');
}

console.log('');
console.log('The ladder in doc 19120: 20, 19, 18 as the BPDU walks away from the root');
{
  // Five bridges, root at one end, all factory timers. Cut the root's own cable: SW2 is one end of it (a
  // direct failure, nothing to age out), and SW3, SW4, SW5 are left holding BPDUs of increasing age.
  const env = chain(5);
  env.sim.setLinkState(env.links[0], 'down', { atMs: 0 });
  const sched = env.sim.getConvergence();
  eq(stpEntry(sched, 'sw2').maxAgeHoldMs, 0, 'SW2 is at the cable that moved: direct, no Max Age');
  eq(stpEntry(sched, 'sw3').maxAgeHoldMs, 19000, 'SW3 runs the age timer of a message age 1 BPDU: 19 s');
  eq(stpEntry(sched, 'sw4').maxAgeHoldMs, 18000, 'SW4: message age 2, so 18 s');
  eq(stpEntry(sched, 'sw5').maxAgeHoldMs, 17000, 'SW5: message age 3, so 17 s');
  eq(stpEntry(sched, 'sw3').messageAgeSec, 1, 'and the schedule carries the field it subtracted');
  eq(stpEntry(sched, 'sw3').readyAtMs, 49000, '19 s + listening + learning = 49 s, slightly under 50');
  ok(/19 s = 20 s Max Age less message age 1/.test(stpEntry(sched, 'sw3').basis),
    'the basis carries both numbers, so the subtraction can be audited', stpEntry(sched, 'sw3').basis);
}

console.log('');
console.log('A BPDU that has reached Max Age is not stored at all');
{
  // A hand-made election record: a root with a 10 s Max Age and a far box 10 bridges out, one hop past what
  // that Max Age can carry. Nothing is left to wait for, so the answer is 0 rather than a negative hold.
  const far = { id: 'far', name: 'FAR', config: { stpForwardDelaySec: 15 } };
  const root = { id: 'root', name: 'ROOT', config: { stpMaxAgeSec: 10, stpForwardDelaySec: 15 } };
  const topo = { getDevice: function (k) { return k === 'root' ? root : far; } };
  function election(hops, rootKey) {
    return {
      root: { key: rootKey || 'root' },
      bridges: {
        root: { cost: 0, rootPort: null, hops: 0 },
        far: { cost: (rootKey === 'far') ? 0 : hops * 4, rootPort: 'Fa0/1', hops: hops }
      }
    };
  }
  function holdAt(hops) {
    // Before the cut the box is `hops` out and hears the root; after it, it is the root itself.
    return convergence.stpMaxAgeHoldInfo(topo, far, {
      stpBefore: election(hops, 'root'), stp: election(hops, 'far'), touched: []
    });
  }
  eq(holdAt(10).messageAgeSec, 9, 'nine bridges crossed, so a message age of 9');
  eq(holdAt(10).ms, 1000, '10 s Max Age less 9 leaves 1 s, not a negative hold');
  eq(holdAt(11).ms, 0, 'a message age at Max Age leaves nothing to age out');
  eq(holdAt(2).ms, 9000, 'and two bridges out leaves 9 s, the same arithmetic from the other end');
}

console.log('');
console.log('An election that cannot place the box falls back to the whole Max Age');
{
  const dev = { id: 'x', name: 'X', config: { stpMaxAgeSec: 20, stpForwardDelaySec: 15 } };
  const topo = { getDevice: function () { return { config: { stpMaxAgeSec: 20 } }; } };
  const opts = {
    stpBefore: { root: { key: 'r' }, bridges: { x: { cost: 4, rootPort: 'Fa0/1', hops: null } } },
    stp: { root: { key: 'x' }, bridges: { x: { cost: 0, rootPort: null, hops: 0 } } },
    touched: []
  };
  const info = convergence.stpMaxAgeHoldInfo(topo, dev, opts);
  eq(info.ms, 20000, 'unknown hops means the full Max Age, not a guessed 0');
  eq(info.messageAgeSec, null, 'and the schedule says the age is unknown rather than printing a 0');
  const l2 = Object.assign({}, dev, { isL2: function () { return true; } });
  const sched = convergence.buildSchedule({ devices: new Map([['x', l2]]) }, opts);
  const entry = sched.entries.filter(function (x) { return x.process === 'stp'; })[0];
  eq(entry.maxAgeHoldMs, 20000, 'the schedule uses it too');
  ok(!/message age/.test(entry.basis), 'and does not claim a message age it does not know', entry.basis);
}

console.log('');
console.log('A converged board is unchanged: no hold, no message age');
{
  const env = chain(3);
  const e = stpEntry(env.sim.getConvergence(), 'sw3');
  eq(e.maxAgeHoldMs, 0, 'nothing is aging out at power-on');
  eq(e.messageAgeSec, null, 'so the field is null, not 0');
  ok(!/message age/.test(e.basis), 'and the basis is the forward delay on its own', e.basis);
}

console.log('');
if (failed) { console.error(failed + ' failed, ' + passed + ' passed'); process.exit(1); }
console.log(passed + ' passed, 0 failed');
