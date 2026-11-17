'use strict';
// A traceroute hop line is an address and three measured probes (#1755).
//
// The command announced its target, listed the hops in order and then printed nothing else: a hop was one
// line with an address on it and no figure at all, while `ping` - over the same latency model, on the same
// path, one command earlier in the same ticket - printed the round trip in milliseconds. So the trace said
// which boxes the path crossed and left out the only number a trace is read for.
//
// A Cisco-style `traceroute` sends three probes at every TTL (`Probe count [3]`) and prints a result for
// each, so a hop is `1 172.16.12.2 4 msec 4 msec 4 msec`: the address, then one column per probe, in
// `msec`. What is locked here:
//
//   1. the engine really sends three probes per hop, so the three columns are three probes and not one
//      figure copied three times;
//   2. every column is a measured round trip, and the figure is the same measurement `ping` reports for the
//      same address - the two commands cannot disagree about one path;
//   3. the unit and the shape are the vendor's: `msec`, three columns, the address first;
//   4. a hop that answered nothing prints three stars and no address, and keeps the reason the drop
//      recorded in brackets;
//   5. the figures are the model's, so three identical probes agree to the last digit - no jitter is
//      invented to make the columns look livelier than the model is.
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

// host --R1--R2-- server. Three routed hops from the host to the server, so both kinds of hop line -
// a probe expired in transit and an echo answered by the destination - appear in one trace.
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

function trace(env, target) {
  return runCommands(env.pc, env.topo, env.sim, ['enable', 'traceroute ' + target]).lines;
}
function hopLine(lines, n) {
  return lines.filter(function (l) { return l.indexOf(' ' + n + '  ') === 0; })[0] || '';
}

section('1. Three probes leave the box for every hop');
{
  const b = bench();
  const res = b.sim.traceroute(b.pc.id, '10.0.3.9');
  eq(res.hops.length, 3, 'three hops to the destination');
  ok(res.hops.every(function (h) { return h.probes.length === 3; }),
    'and every hop carries three probe results');
  const sent = b.sim.events.filter(function (e) { return e.type === 'traceroute-probe'; });
  eq(sent.length, 9, 'the engine emitted three probes per hop, nine in all');
  eq(sent.filter(function (e) { return e.ttl === 1; }).length, 3, 'three of them at TTL 1');
}

section('2. Every column is a measured round trip');
{
  const b = bench();
  const res = b.sim.traceroute(b.pc.id, '10.0.3.9');
  ok(res.hops.every(function (h) {
    return h.probes.every(function (p) { return typeof p.rttMs === 'number' && isFinite(p.rttMs); });
  }), 'all nine probes carry a finite round-trip time');
  ok(res.hops.every(function (h) {
    return h.probes.every(function (p) { return p.rttMs > 0; });
  }), 'and none of them is zero: the wire takes time');
  // A time-exceeded probe used to have no figure at all, because the return leg is an ICMP error rather
  // than an echo reply. Hop 1 is exactly that case.
  eq(res.hops[0].reason, 'time-exceeded', 'hop 1 expires in transit');
  ok(res.hops[0].rttMs > 0, 'and still reports a round trip (' + res.hops[0].rttMs + ' ms)');
}

section('3. The figure is the same measurement ping reports');
{
  const b = bench();
  const res = b.sim.traceroute(b.pc.id, '10.0.3.9');
  const pingHop1 = b.sim.ping(b.pc.id, '10.0.1.254', { count: 1 });
  const pingDest = b.sim.ping(b.pc.id, '10.0.3.9', { count: 1 });
  eq(Number(res.hops[0].rttMs.toFixed(3)), Number(pingHop1.replies[0].rtt.toFixed(3)),
    'hop 1 takes as long as a ping to that router');
  eq(Number(res.hops[2].rttMs.toFixed(3)), Number(pingDest.replies[0].rtt.toFixed(3)),
    'and the last hop takes as long as a ping to the destination');
  ok(res.hops[1].rttMs > res.hops[0].rttMs, 'hop 2 is further away than hop 1 (' +
    res.hops[0].rttMs + ' -> ' + res.hops[1].rttMs + ' ms)');
}

section('4. Three identical probes on a deterministic path');
{
  const b = bench();
  const res = b.sim.traceroute(b.pc.id, '10.0.3.9');
  ok(res.hops.every(function (h) {
    return h.probes.every(function (p) { return p.rttMs === h.probes[0].rttMs; });
  }), 'the three probes of a hop agree: nothing in the model jitters them');
}

section('5. The line is the shape the vendor prints');
{
  const b = bench();
  const lines = trace(b, '10.0.3.9');
  const hop1 = hopLine(lines, 1);
  ok(/^ 1  10\.0\.1\.254  [0-9.]+ msec  [0-9.]+ msec  [0-9.]+ msec$/.test(hop1),
    'hop 1 is the address and three figures: "' + hop1 + '"');
  eq((hop1.match(/msec/g) || []).length, 3, 'three `msec` figures, one per probe');
  ok(!/ ms(\s|$)/.test(hop1), 'and the unit is `msec`, not the `ms` a ping reply line uses');
  const dest = hopLine(lines, 3);
  ok(/^ 3  10\.0\.3\.9  [0-9.]+ msec  [0-9.]+ msec  [0-9.]+ msec$/.test(dest),
    'the destination is a line like any other: "' + dest + '"');
  ok(!/destination reached/.test(lines.join('\n')),
    'nothing says "destination reached": a trace stops at the address it was asked about');
}

section('6. A silent hop prints three stars, and the reason it recorded');
{
  const b = bench();
  const cable = [...b.topo.links.values()].filter(function (l) {
    return l.endpoint(b.r1.id, 'Gi0/1') && l.endpoint(b.r2.id, 'Gi0/0');
  })[0];
  b.sim.setLinkState(cable.id, 'down');
  const lines = trace(b, '10.0.3.9');
  const hop2 = hopLine(lines, 2);
  ok(/^ 2  \*  \*  \*  \(link down/.test(hop2), 'hop 2 is three stars and the reason: "' + hop2 + '"');
  eq((hop2.match(/\*/g) || []).length, 3, 'one star per probe that came back empty');
  ok(hop2.indexOf('10.0.2.2') === -1, 'and no address, because nothing answered for that hop');
  ok(/% destination not reached after 2 hops/.test(lines.join('\n')), 'the walk ends where the wire did');
}

section('7. A destination-unreachable is still a refusal with words');
{
  const b = bench();
  const lines = trace(b, '198.51.100.7');
  const hop2 = hopLine(lines, 2);
  ok(/!H  host unreachable/.test(hop2), 'hop 2 keeps the refusal: "' + hop2 + '"');
  ok(!/msec/.test(hop2),
    'and invents no probe columns for it: how three probes against an unreachable destination are ' +
    'spelled is not settled by the evidence this change rests on');
  ok(/% destination not reached/.test(lines.join('\n')), 'the trace does not claim success');
}

section('8. The probe count is the caller\'s, and defaults to three');
{
  const b = bench();
  eq(b.sim.traceroute(b.pc.id, '10.0.3.9').hops[0].probes.length, 3, 'the default is three probes a hop');
  eq(b.sim.traceroute(b.pc.id, '10.0.3.9', { probes: 1 }).hops[0].probes.length, 1,
    'a caller can ask for one');
  eq(b.sim.traceroute(b.pc.id, '10.0.3.9', { probes: 99 }).hops[0].probes.length, 10,
    'and an absurd count is capped rather than obeyed');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
