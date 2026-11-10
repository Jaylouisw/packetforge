#!/usr/bin/env node
/**
 * Convergence timing (#1049).
 *
 * Every timer in this engine was parsed, range-checked and then thrown away. `forward-delay 15`,
 * `hello 10`, `dead 40` never counted for anything, because computeStp() blocked its ports and
 * computeOspf() installed its routes at t=0. The result was a lab that could only ever show the
 * converged answer: you could not power a switch on and watch the seconds where the link light is
 * green and nothing passes, which is the first thing a technician sees on real gear.
 *
 * These tests pin two things separately: the arithmetic of the timers (pure, exact), and the fact
 * that the simulator acts on it (a ping asked at t before convergence must fail, and say why).
 */
'use strict';

const path = require('path');
const { Topology, Simulator, runCommands } = require('../engine');
const conv = require('../engine/convergence');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, name) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name); }
}
function eq(got, want, name) { ok(got === want, name + ' (' + got + ')'); }
function t(name, fn) {
  console.log('\n' + name);
  if (typeof fn !== 'function') return;   // some sections are a heading over bare assertions
  try { fn(); } catch (e) { failed++; console.log('  ✗ threw: ' + e.message); }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
function spec(vendor, model) {
  const s = catalog.find(function (x) { return x.vendor === vendor && x.model === model; });
  if (!s) throw new Error('missing spec ' + vendor + '/' + model);
  return s;
}
function cli(dev, topo, cmds, exec) {
  const pre = exec ? ['enable'] : ['enable', 'configure terminal'];
  return runCommands(dev, topo, null, pre.concat(cmds)).lines;
}

// ---------------------------------------------------------------------------
t('STP: a port is forwarding after Listening and Learning, not before');

{
  const d = conv.stpTimers({});
  eq(d.forwardDelaySec, 15, 'the 802.1D default forward delay is 15 s');
  eq(d.listenEndMs, 15000, 'Listening ends at one forward delay');
  eq(d.learnEndMs, 30000, 'Learning ends at two, which is when Forwarding begins');
  eq(d.forwardAtMs, 30000, 'Forwarding starts after two');
  eq(conv.stpPortStateAt({}, true, 0), 'listening', 'at t=0 a forwarding port is only Listening');
  eq(conv.stpPortStateAt({}, true, 14999), 'listening', 'still Listening just before 15 s');
  eq(conv.stpPortStateAt({}, true, 15000), 'learning', 'Learning at 15 s');
  eq(conv.stpPortStateAt({}, true, 29999), 'learning', 'still Learning just before 30 s');
  eq(conv.stpPortStateAt({}, true, 30000), 'forwarding', 'Forwarding at 30 s');
  eq(conv.stpPortStateAt({}, false, 30000), 'blocking', 'a port destined to block never forwards');
  ok(!conv.stpForwardsIn('listening') && !conv.stpForwardsIn('learning') && !conv.stpForwardsIn('blocking'),
    'no state but Forwarding passes traffic');
  ok(conv.stpForwardsIn('forwarding'), 'and Forwarding does');
}

{
  const d = conv.stpTimers({ config: { stpForwardDelaySec: 4 } });
  eq(d.forwardAtMs, 8000, 'a configured 4 s forward delay halves the wait to 8 s');
  eq(conv.stpPortStateAt({ config: { stpForwardDelaySec: 4 } }, true, 8000), 'forwarding',
    'and the state follows the configuration, not the default');
}

// ---------------------------------------------------------------------------
t('OSPF: adjacency first, then SPF, then routes');

{
  const d = conv.ospfTimers({});
  eq(d.adjacentAtMs, 11000, 'adjacency at hello 10 s + a 1 s exchange');
  eq(d.routesAtMs, 16000, 'routes 5 s later, after the SPF hold');
  const fast = conv.ospfTimers({ config: { ospf: { helloSec: 1, spfDelaySec: 0 } } });
  eq(fast.adjacentAtMs, 2000, 'a 1 s hello brings the adjacency up at 2 s');
  eq(fast.routesAtMs, 2000, 'and no SPF hold means routes land with it');
}

// ---------------------------------------------------------------------------
t('VRRP and DHCP timers');

{
  const d = conv.vrrpTimers({ advertSec: 1, priority: 100 });
  eq(d.masterDownMs, 3609.375, 'Master_Down = 3 x 1 s + skew((256-100)/256)');
  const top = conv.vrrpTimers({ advertSec: 1, priority: 255 });
  eq(top.masterDownMs, 3000, 'priority 255 has no skew: 3 s exactly');
  const cs = conv.vrrpTimers({ advertCs: 50, priority: 100 });
  ok(Math.abs(cs.masterDownMs - (3 * 0.5 + 156 / 256) * 1000) < 1e-9, 'centiseconds are honoured');
  eq(conv.dhcpTimers({}).leaseAtMs, 1000, 'a DHCP lease arrives after the four-message exchange');
}

// ---------------------------------------------------------------------------
t('The schedule is sorted, complete and honest about what a device runs');

{
  const topo = new Topology();
  const sw = topo.addDevice(spec('generic', 'generic-switch'));
  const pc = topo.addDevice(spec('generic', 'generic-pc'));
  sw.name = 'SW1'; pc.name = 'PC1';
  topo.connect(pc.id, 'eth0', sw.id, 'Fa0/1');

  const sched = conv.buildSchedule(topo);
  const procs = sched.entries.map(function (e) { return e.process + ':' + e.device.name; });
  ok(procs.indexOf('stp:SW1') !== -1, 'the switch runs spanning tree');
  ok(procs.indexOf('stp:PC1') === -1, 'a PC does not');
  eq(sched.byProcess.stp, 30000, 'and it is done at 30 s');
  for (let i = 1; i < sched.entries.length; i++) {
    ok(sched.entries[i - 1].readyAtMs <= sched.entries[i].readyAtMs, 'entry ' + i + ' is in time order');
  }
  const at10 = conv.at(sched, 10000);
  ok(at10.fullyConverged === false, 'at 10 s the schedule is not converged');
  ok(at10.pending.length > 0, 'and names what is pending');
  const at40 = conv.at(sched, 40000);
  ok(at40.fullyConverged === true, 'at 40 s it is');
}

// ---------------------------------------------------------------------------
t('A switch asked at t=5 s drops the ping and says why');

{
  const topo = new Topology();
  const sw = topo.addDevice(spec('generic', 'generic-switch'));
  const a = topo.addDevice(spec('generic', 'generic-pc'));
  const b = topo.addDevice(spec('generic', 'generic-pc'));
  sw.name = 'SW1'; a.name = 'PC1'; b.name = 'PC2';
  topo.connect(a.id, 'eth0', sw.id, 'Fa0/1');
  topo.connect(b.id, 'eth0', sw.id, 'Fa0/2');
  cli(a, topo, ['interface eth0', 'ip address 10.0.0.1 255.255.255.0', 'exit']);
  cli(b, topo, ['interface eth0', 'ip address 10.0.0.2 255.255.255.0', 'exit']);

  const early = new Simulator(topo);
  early.setRunTime(5000);
  const r1 = early.ping(a.id, '10.0.0.2', { count: 1 });
  ok(r1.replies[0].success === false, 'at 5 s there is no reply');
  eq(r1.replies[0].reason, 'converging', 'and the reason is convergence, not a broken lab');
  eq(r1.replies[0].convergingUntilMs, 30000, 'with the instant it will be ready');
  ok(r1.replies[0].pending.some(function (p) { return p.process === 'stp' && p.device === 'SW1'; }),
    'naming the switch and the process');
  eq(sw.stp.states['Fa0/1'], 'listening', 'the port is Listening, as the standard says');

  const mid = new Simulator(topo);
  mid.setRunTime(20000);
  eq(mid.ping(a.id, '10.0.0.2', { count: 1 }).replies[0].success, false, 'at 20 s it still does not pass');
  eq(sw.stp.states['Fa0/1'], 'learning', 'because the port is Learning');

  const late = new Simulator(topo);
  late.setRunTime(30000);
  eq(late.ping(a.id, '10.0.0.2', { count: 1 }).replies[0].success, true, 'at 30 s it passes');
  eq(sw.stp.states['Fa0/1'], 'forwarding', 'with the port Forwarding');
  eq(late.ping(a.id, '10.0.0.2', { count: 1 }).replies[0].reason, null, 'and no reason attached');

  // The convenience form must be the same question as setRunTime().
  const viaOpts = new Simulator(topo);
  const optRes = viaOpts.ping(a.id, '10.0.0.2', { count: 1, atMs: 5000 });
  eq(optRes.replies[0].reason, 'converging', 'ping({ atMs }) is honoured, not silently ignored');
  eq(viaOpts.runAtMs, 5000, 'and it really did set the instant');

  // The default must remain "converged", or every existing lab changes behaviour.
  const def = new Simulator(topo);
  eq(def.runAtMs, Infinity, 'a simulator that was never told an instant runs converged');
  eq(def.ping(a.id, '10.0.0.2', { count: 1 }).replies[0].success, true, 'so the default lab still works');
  eq(def.repliesReason, undefined, 'and no phantom reason appears');
}

// ---------------------------------------------------------------------------
t('A router asked before SPF has run has no route, and says so');

{
  const topo = new Topology();
  const r1 = topo.addDevice(spec('generic', 'generic-router'));
  const r2 = topo.addDevice(spec('generic', 'generic-router'));
  const h1 = topo.addDevice(spec('generic', 'generic-pc'));
  const h2 = topo.addDevice(spec('generic', 'generic-pc'));
  r1.name = 'R1'; r2.name = 'R2'; h1.name = 'H1'; h2.name = 'H2';
  topo.connect(h1.id, 'eth0', r1.id, 'Gi0/0');
  topo.connect(r1.id, 'Gi0/1', r2.id, 'Gi0/0');
  topo.connect(r2.id, 'Gi0/1', h2.id, 'eth0');

  cli(h1, topo, ['interface eth0', 'ip address 10.0.1.10 255.255.255.0', 'exit', 'ip default-gateway 10.0.1.1']);
  cli(h2, topo, ['interface eth0', 'ip address 10.0.2.10 255.255.255.0', 'exit', 'ip default-gateway 10.0.2.1']);
  cli(r1, topo, [
    'interface Gi0/0', 'ip address 10.0.1.1 255.255.255.0', 'exit',
    'interface Gi0/1', 'ip address 10.0.0.1 255.255.255.0', 'exit',
    'ospf router-id 1.1.1.1', 'ospf area 0']);
  cli(r2, topo, [
    'interface Gi0/0', 'ip address 10.0.0.2 255.255.255.0', 'exit',
    'interface Gi0/1', 'ip address 10.0.2.1 255.255.255.0', 'exit',
    'ospf router-id 2.2.2.2', 'ospf area 0']);

  const sched = conv.buildSchedule(topo);
  eq(sched.byProcess.ospf, 16000, 'both routers finish OSPF at 16 s');

  const early = new Simulator(topo);
  early.setRunTime(8000);
  const r1res = early.ping(h1.id, '10.0.2.10', { count: 1 });
  ok(r1res.replies[0].success === false, 'at 8 s the far subnet is unreachable');
  eq(r1res.replies[0].reason, 'converging', 'because OSPF has not installed a route yet');
  ok(r1res.replies[0].pending.some(function (p) { return p.process === 'ospf'; }), 'and it says OSPF');

  const late = new Simulator(topo);
  late.setRunTime(20000);
  const r2res = late.ping(h1.id, '10.0.2.10', { count: 1 });
  eq(r2res.replies[0].success, true, 'at 20 s the route is there and the ping is answered');
  ok(r2res.replies[0].rtt > 0, 'with a round-trip time that is not zero');

  // The converged answer must be identical to asking at Infinity.
  const inf = new Simulator(topo);
  const a = late.ping(h1.id, '10.0.2.10', { count: 1 }).replies[0];
  const b = inf.ping(h1.id, '10.0.2.10', { count: 1 }).replies[0];
  eq(a.success, b.success, 'Infinity and a late instant agree on the outcome');
  ok(Math.abs(a.rtt - b.rtt) < 1e-9, 'and on the delay');
}

// ---------------------------------------------------------------------------
t('setRunTime is defensive');

{
  const sim = new Simulator(new Topology());
  eq(sim.setRunTime(-5), Infinity, 'a negative instant is treated as "converged"');
  eq(sim.setRunTime('nonsense'), Infinity, 'as is a non-number');
  eq(sim.setRunTime(2500), 2500, 'and a real one is kept');
  eq(sim.setRunTime(undefined), Infinity, 'undefined resets to converged');
}

// ---------------------------------------------------------------------------
t('The CLI can ask the question, and says "converging" rather than "timed out"');

{
  const topo = new Topology();
  const sw = topo.addDevice(spec('generic', 'generic-switch'));
  const a = topo.addDevice(spec('generic', 'generic-pc'));
  const b = topo.addDevice(spec('generic', 'generic-pc'));
  sw.name = 'SW1'; a.name = 'PC1'; b.name = 'PC2';
  topo.connect(a.id, 'eth0', sw.id, 'Fa0/1');
  topo.connect(b.id, 'eth0', sw.id, 'Fa0/2');
  const sim = new Simulator(topo);
  cli(a, topo, ['interface eth0', 'ip address 10.0.0.1 255.255.255.0', 'exit']);
  cli(b, topo, ['interface eth0', 'ip address 10.0.0.2 255.255.255.0', 'exit']);

  const convOut = runCommands(a, topo, sim, ['enable', 'converge']).lines;
  ok(convOut.some(function (l) { return /^stp\s+SW1\s+30000 ms/.test(l); }), 'converge lists the switch, ready at 30 s');
  ok(convOut.some(function (l) { return /Fully converged at 30000 ms/.test(l); }), 'and the lab total');

  const early = runCommands(a, topo, sim, ['enable', 'ping 10.0.0.2 1 at 5000']).lines;
  ok(early.some(function (l) { return /Still converging: stp on SW1/.test(l); }),
    'an early ping names the process, not a timeout');
  // ...and says when it will be ready, and which instant the answer is about (#1383).
  ok(early.some(function (l) { return /ready at 30000 ms/.test(l); }), 'and when the path will be up');
  ok(early.some(function (l) { return /at t=5000 ms$/.test(l); }), 'and the instant the answer belongs to');
  ok(!early.some(function (l) { return /Request timed out/.test(l); }),
    'and does not pretend the packet was lost');

  const late = runCommands(a, topo, sim, ['enable', 'ping 10.0.0.2 1 at 31000']).lines;
  ok(late.some(function (l) { return /Reply from 10\.0\.0\.2: bytes=100 time=[0-9.]+ ms/.test(l); }),
    'a late ping reports a real millisecond time');
  ok(!late.some(function (l) { return /hops/.test(l); }), 'not a hop count wearing a time label');

  const bad = runCommands(a, topo, sim, ['enable', 'ping 10.0.0.2 1 at -3']).lines;
  ok(bad.some(function (l) { return /Invalid instant/.test(l); }), 'a negative instant is refused');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
