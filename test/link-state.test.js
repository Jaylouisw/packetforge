#!/usr/bin/env node
/**
 * Link state, and re-convergence after a cable is pulled.
 *
 * `Link` has carried a `state` field ('up' | 'down' | 'blocked') since the physical layer was built,
 * and nothing in the engine ever read it. A cable marked down still passed every frame, still cost
 * what it cost in the spanning tree, and was still walked by the DHCP segment search: the field was
 * decoration, and the failure it hides is total - a lab could show a cut link carrying traffic.
 *
 * These tests make the field real, and then use it for the thing a technician actually does: pull a
 * cable, watch the network heal or die, and count the seconds until it works again.
 */
'use strict';

const path = require('path');
const { Topology, Simulator, runCommands, convergence } = require('../engine');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, name) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name); }
}
function eq(got, want, name) { ok(got === want, name + ' (got ' + got + ', want ' + want + ')'); }
function t(name, fn) {
  console.log('\n' + name);
  if (typeof fn !== 'function') return;
  try { fn(); } catch (e) { failed++; console.log('  ✗ threw: ' + e.message); }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
function spec(model) {
  const s = catalog.find(function (x) { return String(x.model) === model; });
  if (!s) throw new Error('missing spec ' + model);
  return s;
}

// ---------------------------------------------------------------------------
// The smallest cut: two hosts and two switches in a line, so the only path is the middle link.
function line() {
  const topo = new Topology();
  const s1 = topo.addDevice(spec('generic-switch'));
  const s2 = topo.addDevice(spec('generic-switch'));
  const h1 = topo.addDevice(spec('generic-pc'));
  const h2 = topo.addDevice(spec('generic-pc'));
  s1.name = 'SW1'; s2.name = 'SW2'; h1.name = 'H1'; h2.name = 'H2';
  const mid = topo.connect(s1.id, 'Fa0/1', s2.id, 'Fa0/1');
  topo.connect(h1.id, 'eth0', s1.id, 'Fa0/2');
  topo.connect(h2.id, 'eth0', s2.id, 'Fa0/2');
  const sim = new Simulator(topo);
  const cli = function (dev, cmds) { return runCommands(dev, topo, sim, cmds).lines; };
  cli(h1, ['enable', 'configure terminal', 'interface eth0', 'ip address 10.0.0.1 255.255.255.0', 'exit']);
  cli(h2, ['enable', 'configure terminal', 'interface eth0', 'ip address 10.0.0.2 255.255.255.0', 'exit']);
  return { topo: topo, sim: sim, cli: cli, s1: s1, s2: s2, h1: h1, h2: h2, mid: mid };
}

// Three switches in a triangle, with a host on the first and the last: two paths, one blocked.
function triangle() {
  const topo = new Topology();
  const s1 = topo.addDevice(spec('generic-switch'));
  const s2 = topo.addDevice(spec('generic-switch'));
  const s3 = topo.addDevice(spec('generic-switch'));
  const h1 = topo.addDevice(spec('generic-pc'));
  const h2 = topo.addDevice(spec('generic-pc'));
  s1.name = 'SW1'; s2.name = 'SW2'; s3.name = 'SW3'; h1.name = 'H1'; h2.name = 'H2';
  topo.connect(s1.id, 'Fa0/1', s2.id, 'Fa0/1');
  topo.connect(s2.id, 'Fa0/2', s3.id, 'Fa0/1');
  const L13 = topo.connect(s1.id, 'Fa0/2', s3.id, 'Fa0/2');
  topo.connect(h1.id, 'eth0', s1.id, 'Fa0/3');
  topo.connect(h2.id, 'eth0', s3.id, 'Fa0/3');
  const sim = new Simulator(topo);
  const cli = function (dev, cmds) { return runCommands(dev, topo, sim, cmds).lines; };
  cli(h1, ['enable', 'configure terminal', 'interface eth0', 'ip address 10.0.0.1 255.255.255.0', 'exit']);
  cli(h2, ['enable', 'configure terminal', 'interface eth0', 'ip address 10.0.0.2 255.255.255.0', 'exit']);
  return { topo: topo, sim: sim, cli: cli, s1: s1, s2: s2, s3: s3, h1: h1, h2: h2, L13: L13 };
}

// ---------------------------------------------------------------------------
t('A link that is down carries nothing at all');

{
  const L = line();
  ok(L.sim.ping(L.h1.id, '10.0.0.2', { count: 1 }).replies[0].success, 'the line works to begin with');

  const res = L.sim.linkDown(L.mid.id, { atMs: 0 });
  ok(res.ok && res.changed, 'the link goes down');
  eq(L.mid.state, 'down', 'and says so on the link');
  eq(L.mid.isUp(), false, 'isUp() is false');

  const cut = L.sim.ping(L.h1.id, '10.0.0.2', { count: 1 });
  ok(!cut.replies[0].success, 'and the ping fails');

  // The frame must die at the cable, not quietly vanish: a lab has to be able to see where.
  const drops = cut.events.filter(function (e) { return e.type === 'drop'; });
  ok(drops.length >= 1, 'with a drop recorded');
  ok(drops.some(function (e) { return e.reason === 'link down'; }), 'naming the link as the reason');

  // An unplugged-port style silence would leave no trace at all.
  const again = L.sim.ping(L.h1.id, '10.0.0.2', { count: 1 });
  ok(!again.replies[0].success, 'still down on the next run');

  const healed = L.sim.linkUp(L.mid.id, { atMs: 0 });
  ok(healed.ok && healed.changed, 'the cable goes back in');
  ok(L.sim.ping(L.h1.id, '10.0.0.2', { count: 1 }).replies[0].success, 'and the line works again');
}

// ---------------------------------------------------------------------------
t('setLinkState refuses what it cannot do');

{
  const L = line();
  const missing = L.sim.setLinkState('l999', 'down');
  ok(!missing.ok, 'an unknown link is refused');
  eq(missing.code, 'E_NO_LINK', 'with a code that names the problem');

  const bad = L.sim.setLinkState(L.mid.id, 'sideways');
  ok(!bad.ok, 'a nonsense state is refused');
  eq(L.mid.state, 'up', 'and nothing changed');

  const same = L.sim.setLinkState(L.mid.id, 'up');
  ok(same.ok && same.changed === false, 'setting the state it already has changes nothing');
}

// ---------------------------------------------------------------------------
t('The spanning tree heals around a failed link');

{
  const L = triangle();
  const base = L.sim.ping(L.h1.id, '10.0.0.2', { count: 1 });
  ok(base.replies[0].success, 'a redundant triangle works');

  // One of the two paths is blocked by STP; which one is the tree's business.
  const blockedBefore = L.s1.stp.blocked.size + L.s3.stp.blocked.size;
  ok(blockedBefore >= 1, 'with one path held in reserve (blocked)');

  L.sim.linkDown(L.L13.id, { atMs: 0 });

  // The down cable is not a bridge port, so the tree finds the other way and nothing is blocked.
  ok(L.s1.stp.blocked.size + L.s3.stp.blocked.size === 0,
    'breaking the direct link unblocks the reserve path');
  ok(L.sim.ping(L.h1.id, '10.0.0.2', { count: 1 }).replies[0].success,
    'and traffic still flows, through the other switch');

  // Put it back: the reserve is blocked again, and the direct path carries the traffic.
  L.sim.linkUp(L.L13.id, { atMs: 0 });
  ok(L.s1.stp.blocked.size + L.s3.stp.blocked.size >= 1, 'healing the link re-blocks the reserve');
  ok(L.sim.ping(L.h1.id, '10.0.0.2', { count: 1 }).replies[0].success, 'and traffic flows again');
}

// ---------------------------------------------------------------------------
t('A broken network stays broken when there is no second path');

{
  const L = triangle();
  // Take out both ways between SW1 and SW3.
  L.sim.linkDown(L.L13.id, { atMs: 0 });
  for (const l of L.topo.links.values()) {
    if ((l.a.deviceId === L.s2.id && l.b.deviceId === L.s3.id) ||
        (l.a.deviceId === L.s3.id && l.b.deviceId === L.s2.id)) {
      L.sim.linkDown(l.id, { atMs: 0 });
    }
  }
  ok(!L.sim.ping(L.h1.id, '10.0.0.2', { count: 1 }).replies[0].success, 'nothing gets through');

  // Heal one, and the network comes back: the tree was never the problem.
  for (const l of L.topo.links.values()) {
    if ((l.a.deviceId === L.s2.id && l.b.deviceId === L.s3.id) ||
        (l.a.deviceId === L.s3.id && l.b.deviceId === L.s2.id)) {
      L.sim.linkUp(l.id, { atMs: 0 });
    }
  }
  ok(L.sim.ping(L.h1.id, '10.0.0.2', { count: 1 }).replies[0].success, 'healing one link is enough');
}

// ---------------------------------------------------------------------------
t('After a change, the timers run again from the instant of the change');

{
  const L = triangle();
  L.sim.linkDown(L.L13.id, { atMs: 10000 });

  const schedule = L.sim.getConvergence();
  eq(schedule.fromMs, 10000, 'the schedule is re-based at the change');
  eq(schedule.convergedAtMs, 40000, 'so it converges at 10 s + 30 s, not at 30 s');
  ok(schedule.entries.some(function (e) { return e.process === 'change'; }),
    'and the change itself is an entry, so nothing claims to precede it');

  // Nothing forward before the tree settles again.
  const early = new Simulator(L.topo);
  early.setRunTime(11000);
  const e1 = early.ping(L.h1.id, '10.0.0.2', { count: 1 });
  ok(!e1.replies[0].success, 'one second after the change, nothing works');
  eq(e1.replies[0].reason, 'converging', 'and the reply says why');

  const mid = new Simulator(L.topo);
  mid.setRunTime(20000);
  ok(!mid.ping(L.h1.id, '10.0.0.2', { count: 1 }).replies[0].success,
    'twenty seconds later it still does not');

  const late = new Simulator(L.topo);
  late.setRunTime(41000);
  ok(late.ping(L.h1.id, '10.0.0.2', { count: 1 }).replies[0].success,
    'but once the change is absorbed it does');

  // A lab that never changed anything must not pay for this.
  const fresh = triangle();
  eq(fresh.sim.getConvergence().convergedAtMs, 30000, 'an untouched lab still converges at 30 s');
  eq(fresh.sim.getConvergence().fromMs, 0, 'with nothing to re-base');
}

// ---------------------------------------------------------------------------
t('A change flushes the forwarding tables');

{
  const L = triangle();
  L.sim.ping(L.h1.id, '10.0.0.2', { count: 1 });
  ok(L.s2.macTable.size >= 1, 'the middle switch learned where the hosts are');

  L.sim.linkDown(L.L13.id, { atMs: 0 });
  eq(L.s2.macTable.size, 0,
    'and a topology change empties it - a stale entry is how a real network black-holes');
  eq(L.s1.macTable.size, 0, 'on every switch');
}

// ---------------------------------------------------------------------------
t('A down link is not walked by the broadcast-domain search');

{
  // A DHCP client on the far side of a cut cable must not be offered a lease by a server it cannot
  // reach. The segment walk has to stop at the cable, exactly as a frame does.
  const topo = new Topology();
  const r1 = topo.addDevice(spec('generic-router'));
  const s1 = topo.addDevice(spec('generic-switch'));
  const s2 = topo.addDevice(spec('generic-switch'));
  const pc = topo.addDevice(spec('generic-pc'));
  r1.name = 'R1'; s1.name = 'SW1'; s2.name = 'SW2'; pc.name = 'PC1';
  topo.connect(r1.id, 'Gi0/1', s1.id, 'Fa0/1');
  const cut = topo.connect(s1.id, 'Fa0/2', s2.id, 'Fa0/1');
  topo.connect(pc.id, 'eth0', s2.id, 'Fa0/2');
  const sim = new Simulator(topo);
  runCommands(r1, topo, sim, ['enable', 'configure terminal', 'interface Gi0/1',
    'ip address 10.0.0.1 255.255.255.0', 'exit',
    'ip dhcp pool LAN', 'network 10.0.0.0 255.255.255.0', 'default-router 10.0.0.1',
    'range 10.0.0.100 10.0.0.110', 'exit']);
  runCommands(pc, topo, sim, ['enable', 'configure terminal', 'interface eth0',
    'ip address dhcp', 'exit']);

  const working = sim.ping(pc.id, '10.0.0.1', { count: 1 });
  ok(working.replies[0].success, 'the client gets a lease while the cable is in');

  // Fresh client, cut cable.
  const topo2 = Topology.fromJSON(JSON.parse(JSON.stringify(topo.serialize())));
  const pc2 = Array.from(topo2.devices.values()).filter(function (d) { return d.name === 'PC1'; })[0];
  pc2.interfaces.get('eth0').ip = null;
  pc2.interfaces.get('eth0').dhcp = true;
  const sim2 = new Simulator(topo2);
  const cut2 = Array.from(topo2.links.values()).filter(function (l) { return l.id === cut.id; })[0];
  sim2.linkDown(cut2.id, { atMs: 0 });
  const res = sim2.ping(pc2.id, '10.0.0.1', { count: 1 });
  ok(!res.replies[0].success, 'with the cable cut it gets nothing');
  ok(!pc2.interfaces.get('eth0').ip, 'and stays unaddressed');
}

// ---------------------------------------------------------------------------
t('A lab saved with a cable down comes back with it down');

{
  const L = triangle();
  L.sim.linkDown(L.L13.id, { atMs: 10000 });
  const json = JSON.parse(JSON.stringify(L.topo.serialize()));

  // The board's clock is not in the file. It is an instant in a run, and a run ends: a board reopened tomorrow
  // would build its schedule from an instant belonging to a session that no longer exists (#1331). What is saved
  // is the thing that happened, and the clock is derived from it on the way in.
  eq(json.lastChangeAtMs, undefined, 'no run instant is written to the file');
  const saved = json.links.filter(function (l) { return l.id === L.L13.id; })[0];
  eq(saved.state, 'down', 'the cable that went down is saved as down');
  eq(saved.stateSinceMs, 10000, 'and when it changed');
  eq(Topology.fromJSON(json).lastChangeAtMs, 10000, 'a reloaded board derives its clock from the newest fault');

  // Links that never moved must not carry the field, or every diff grows noise.
  const untouched = json.links.filter(function (l) { return l.id !== L.L13.id; });
  ok(untouched.every(function (l) { return l.stateSinceMs === undefined; }),
    'links that never changed stay clean');

  const back = Topology.fromJSON(json);
  const link = Array.from(back.links.values()).filter(function (l) { return l.id === L.L13.id; })[0];
  eq(link.state, 'down', 'the reloaded link is still down');
  eq(link.stateSinceMs, 10000, 'at the instant it was cut');
  eq(back.lastChangeAtMs, 10000, 'and the network still knows when');

  const sim = new Simulator(back);
  sim.setRunTime(20000);
  const res = sim.ping(L.h1.id, '10.0.0.2', { count: 1 });
  ok(!res.replies[0].success, 'so the reloaded lab is still re-converging at 20 s');
  eq(sim.getConvergence().convergedAtMs, 40000, 'and says when it will be done');

  sim.setRunTime(41000);
  ok(sim.ping(L.h1.id, '10.0.0.2', { count: 1 }).replies[0].success, 'and it is done by 41 s');
}

// ---------------------------------------------------------------------------
t('The convergence module reports the re-base without the simulator');

{
  const L = triangle();
  const fresh = convergence.buildSchedule(L.topo);
  const moved = convergence.buildSchedule(L.topo, { fromMs: 5000 });
  ok(moved.convergedAtMs > fresh.convergedAtMs, 'a later base means a later convergence');
  eq(moved.convergedAtMs - fresh.convergedAtMs, 5000, 'by exactly the offset');
  ok(moved.entries.every(function (e) { return e.readyAtMs >= 5000; }),
    'and nothing claims to be ready before the change');
}

// ---------------------------------------------------------------------------
t('The CLI can pull a cable, list cables, and refuses nonsense');

{
  const L = line();
  const out = L.cli(L.h1, ['enable', 'links']);
  ok(out.some(function (l) { return /^Link/.test(l); }), 'links prints a header');
  ok(out.some(function (l) { return l.indexOf(L.mid.id) !== -1 && /\bup\b/.test(l); }),
    'and lists the cable as up');
  ok(out.some(function (l) { return /H1:eth0 <-> SW1:Fa0\/2/.test(l); }),
    'naming both ends by device and port');

  const cut = L.cli(L.h1, ['enable', 'link down ' + L.mid.id + ' at 10000']);
  ok(cut.some(function (l) { return /is now down/.test(l); }), 'link down reports the change');
  ok(cut.some(function (l) { return /converges again at 40000 ms/.test(l); }),
    'and says when the network will be whole');
  eq(L.mid.state, 'down', 'the cable really is down');
  eq(L.mid.stateSinceMs, 10000, 'at the instant it was cut');

  const state = L.cli(L.h1, ['enable', 'link state ' + L.mid.id]);
  // The instant is named as an instant. It used to read `since 10000 ms`, which reads as a duration - and it is not
  // one: at run time 5000 the cable did not go down 10000 ms ago, it went down at 10000 ms (#1331).
  ok(state.some(function (l) { return /state: down, changed at 10000 ms/.test(l); }),
    'link state shows the state and the instant it changed');
  ok(!state.some(function (l) { return /since 10000 ms/.test(l); }),
    'without presenting the instant as a duration');

  const again = L.cli(L.h1, ['enable', 'link down ' + L.mid.id]);
  ok(again.some(function (l) { return /already down/.test(l); }), 'cutting it twice is a no-op');

  const missing = L.cli(L.h1, ['enable', 'link down l999']);
  ok(missing.some(function (l) { return /E_NO_LINK/.test(l); }), 'an unknown cable is refused');

  const bad = L.cli(L.h1, ['enable', 'link sideways ' + L.mid.id]);
  ok(bad.some(function (l) { return /expected up, down or state/.test(l); }), 'a bad verb is refused');

  const noTime = L.cli(L.h1, ['enable', 'link down ' + L.mid.id + ' at later']);
  ok(noTime.some(function (l) { return /Invalid time/.test(l); }), 'a bad time is refused');

  const incomplete = L.cli(L.h1, ['enable', 'link down']);
  ok(incomplete.some(function (l) { return /Incomplete command/.test(l); }), 'a missing id is refused');

  const back = L.cli(L.h1, ['enable', 'link up ' + L.mid.id]);
  ok(back.some(function (l) { return /is now up/.test(l); }), 'and the cable can go back in');
  ok(L.sim.ping(L.h1.id, '10.0.0.2', { count: 1 }).replies[0].success, 'traffic flows again');

  const help = L.cli(L.h1, ['enable', 'help']);
  ok(help.some(function (l) { return /link up\|down/.test(l); }), 'help names the command');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
