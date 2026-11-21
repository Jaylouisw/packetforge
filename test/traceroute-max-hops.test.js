'use strict';
// `traceroute <target> max <n>`: the hop cap the index promised and the parser never read (#2435).
//
// `help` has printed `traceroute|tracert <address|name> [max <n>]` since #1484, and docs/CLI.md recorded
// the gap in as many words: `_traceroute()` read `tokens[0]` and nothing else, so `traceroute 10.0.0.1 max 5`
// ran the default thirty-hop walk and swallowed `max 5` without a word (`Simulator.traceroute()`'s
// `opts.maxHops` was never passed). A console that answers a different question than the one typed, silently,
// is the defect class this project keeps closing; here the answer was not merely imprecise, it was uncapped.
//
// What is locked here:
//
//   1. `max <n>` really caps the walk: the trace stops at TTL n and no hop beyond it is printed;
//   2. a cap at or above the path length changes nothing - the destination is still reached and no summary
//      line is added, so `max 30` and a bare `traceroute` print the same bytes;
//   3. what a box prints after the last hop of a capped trace is nothing (Cisco 13730: "The traceroute command
//      terminates when the destination is reached or when this value is reached"), and this console's own
//      `% destination not reached` sentence is the one line it adds for an unfinished walk - capped or cut by
//      a cable, the same sentence;
//   4. the range is the vendors': 1-255 (CBS 250/350 `ttl max-ttl ... (Range: 1-255)`; ASR 5000 `maxttl`
//      "an integer from 1 through 255"), and the engine honours the top of it - the simulator's own clamp was
//      64, so `max 255` would have been accepted by the console and cut at 64;
//   5. every other word after the target is refused rather than ignored: a bare number, a missing value, a
//      duplicate cap and a non-numeric value each get one sentence and no walk is sent.
//
// research/traceroute-hop-cap.md carries the evidence table and the two spellings this console does not adopt
// (`ttl <max-ttl>`, `ttl <min> <max>`).
const path = require('path');
const { Topology, Simulator, runCommands } = require('../engine');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.log('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}
function eq(actual, expected, msg) {
  ok(actual === expected, msg + ' (expected ' + JSON.stringify(expected) +
    ', got ' + JSON.stringify(actual) + ')');
}
function section(name) { console.log('\n' + name); }

const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
function spec(model) { return catalog.find(function (x) { return x.model === model; }); }
function cfg(dev, cmds, topo, sim) {
  return runCommands(dev, topo, sim, ['enable', 'configure terminal'].concat(cmds));
}

// host --R1--R2-- server: three routed hops, so a two-hop cap is visibly short of the destination.
function bench() {
  const topo = new Topology();
  const pc = topo.addDevice(spec('generic-pc'));
  const r1 = topo.addDevice(spec('generic-router'));
  const r2 = topo.addDevice(spec('generic-router'));
  const srv = topo.addDevice(spec('generic-pc'));
  topo.connect(pc.id, 'eth0', r1.id, 'Gi0/0');
  topo.connect(r1.id, 'Gi0/1', r2.id, 'Gi0/0');
  topo.connect(r2.id, 'Gi0/1', srv.id, 'eth0');
  const sim = new Simulator(topo);
  cfg(pc, ['interface eth0', 'ip address 10.0.1.1 255.255.255.0', 'exit',
    'ip default-gateway 10.0.1.254', 'exit'], topo, sim);
  cfg(r1, ['interface Gi0/0', 'ip address 10.0.1.254 255.255.255.0', 'exit',
    'interface Gi0/1', 'ip address 10.0.2.1 255.255.255.0', 'exit',
    'ip route 10.0.3.0 255.255.255.0 10.0.2.2', 'exit'], topo, sim);
  cfg(r2, ['interface Gi0/0', 'ip address 10.0.2.2 255.255.255.0', 'exit',
    'interface Gi0/1', 'ip address 10.0.3.1 255.255.255.0', 'exit',
    'ip route 10.0.1.0 255.255.255.0 10.0.2.1', 'exit'], topo, sim);
  cfg(srv, ['interface eth0', 'ip address 10.0.3.9 255.255.255.0', 'exit',
    'ip default-gateway 10.0.3.1', 'exit'], topo, sim);
  return { topo: topo, pc: pc, r1: r1, r2: r2, srv: srv, sim: sim };
}

function run(env, cmd) {
  return runCommands(env.pc, env.topo, env.sim, ['enable', cmd]).lines;
}
function hopLine(lines, n) {
  const re = new RegExp('^ +' + n + '  ');
  return lines.filter(function (l) { return re.test(l); })[0] || '';
}

section('1. `max <n>` caps the walk where it says');
{
  const b = bench();
  const lines = run(b, 'traceroute 10.0.3.9 max 2');
  ok(!!hopLine(lines, 1) && !!hopLine(lines, 2), 'hops 1 and 2 are on the trace');
  eq(hopLine(lines, 3), '', 'and hop 3 is not: the cap stopped the walk');
  const hopRows = lines.filter(function (l) { return /^ +[0-9]+  /.test(l); });
  ok(!hopRows.some(function (l) { return l.indexOf('10.0.3.9') !== -1; }),
    'and no hop row is the destination: the walk never got there');
  const summary = lines.filter(function (l) { return /destination not reached/.test(l); })[0];
  eq(summary, '% destination not reached after 2 hops', 'the summary counts the hops that were walked');
  const probes = b.sim.events.filter(function (e) { return e.type === 'traceroute-probe'; });
  eq(probes.length, 6, 'six probes left the box - three at TTL 1 and three at TTL 2, none at TTL 3');
}

section('2. A one-hop cap says `1 hop`, not `1 hops`');
{
  const b = bench();
  const lines = run(b, 'traceroute 10.0.3.9 max 1');
  ok(!!hopLine(lines, 1), 'hop 1 is printed');
  eq(hopLine(lines, 2), '', 'hop 2 is not');
  eq(lines.filter(function (l) { return /destination not reached/.test(l); })[0],
    '% destination not reached after 1 hop', 'the sentence is singular for one hop');
}

section('3. A cap at or above the path length changes nothing');
{
  const b = bench();
  const plain = run(b, 'traceroute 10.0.3.9');
  const capped = run(b, 'traceroute 10.0.3.9 max 30');
  const top = run(b, 'traceroute 10.0.3.9 max 255');
  // The echoed command line differs by design; everything the command prints must not.
  const printed = function (lines) { return lines.slice(2).join('\n'); };
  eq(printed(capped), printed(plain), '`max 30` prints what the bare command prints');
  eq(printed(top), printed(plain), 'so does `max 255`, the top of the vendor range');
  ok(plain.join('\n').indexOf('destination not reached') === -1, 'and a reached destination draws no summary');
}

section('4. The alias takes the cap too, and the keyword is case-insensitive');
{
  const b = bench();
  const a = run(b, 'tracert 10.0.3.9 max 2');
  const c = run(b, 'traceroute 10.0.3.9 MAX 2');
  eq(hopLine(a, 3), '', '`tracert ... max 2` stops at two hops');
  eq(a.filter(function (l) { return /destination not reached/.test(l); })[0],
    '% destination not reached after 2 hops', 'with the same summary');
  eq(hopLine(c, 3), '', '`MAX` is the same keyword as `max`');
}

section('5. The engine honours the top of the range');
{
  // The simulator clamped `maxHops` at 64, so a console that accepted `max 255` would still have cut the walk
  // at 64 - the accepted value and the value used would have been two different numbers. A two-router routing
  // loop expires every probe, so the walk runs to whatever cap it was given.
  const topo = new Topology();
  const r1 = topo.addDevice(spec('generic-router'));
  const r2 = topo.addDevice(spec('generic-router'));
  topo.connect(r1.id, 'Gi0/0', r2.id, 'Gi0/0');
  const sim = new Simulator(topo);
  cfg(r1, ['interface Gi0/0', 'ip address 10.0.0.1 255.255.255.0', 'exit',
    'ip route 0.0.0.0 0.0.0.0 10.0.0.2', 'exit'], topo, sim);
  cfg(r2, ['interface Gi0/0', 'ip address 10.0.0.2 255.255.255.0', 'exit',
    'ip route 0.0.0.0 0.0.0.0 10.0.0.1', 'exit'], topo, sim);
  const res = sim.traceroute(r1.id, '192.0.2.1', { maxHops: 255 });
  eq(res.hops.length, 255, 'a 255-hop cap walks 255 hops');
  eq(res.success, false, 'and does not claim the destination');
  const viaCli = runCommands(r1, topo, sim, ['enable', 'traceroute 192.0.2.1 max 255']).lines;
  ok(/% destination not reached after 255 hops/.test(viaCli.join('\n')),
    'the console reports all 255 hops it walked');
}

section('6. Bad arguments are refused, and no probe is sent');
{
  const b = bench();
  const cases = [
    ['traceroute 10.0.3.9 max', '% Invalid hop limit: "max" needs a number from 1 to 255'],
    ['traceroute 10.0.3.9 max 0', '% Hop limit must be a whole number from 1 to 255 (asked for 0)'],
    ['traceroute 10.0.3.9 max 256', '% Hop limit must be a whole number from 1 to 255 (asked for 256)'],
    ['traceroute 10.0.3.9 max abc', '% Hop limit must be a whole number from 1 to 255 (asked for abc)'],
    ['traceroute 10.0.3.9 max 2.5', '% Hop limit must be a whole number from 1 to 255 (asked for 2.5)'],
    ['traceroute 10.0.3.9 max -1', '% Hop limit must be a whole number from 1 to 255 (asked for -1)'],
    ['traceroute 10.0.3.9 5', '% Unrecognized "5" (traceroute <address|name> [max <1-255>])'],
    ['traceroute 10.0.3.9 max 2 max 3', '% the hop limit was given twice (max 2, then max 3)']
  ];
  for (const row of cases) {
    const lines = run(b, row[0]);
    eq(lines[lines.length - 1], row[1], '`' + row[0] + '` is refused');
    ok(lines.join('\n').indexOf('Type escape sequence to abort') === -1,
      '  and the walk never starts');
  }
  const probes = b.sim.events.filter(function (e) { return e.type === 'traceroute-probe'; });
  eq(probes.length, 0, 'eight refused lines sent no probe at all');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
