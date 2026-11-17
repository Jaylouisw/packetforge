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
//      invented to make the columns look livelier than the model is;
//   6. a probe refused with an ICMP destination-unreachable prints the letter for its code in that probe's
//      column - `!N` for network unreachable, `!H` for host unreachable - so a refused hop is a run of
//      letters, not a sentence with a time missing from it;
//   7. the hop number is a fixed three-character field, right-aligned, so hop 10 does not move the address
//      (research/traceroute-hop-line.md: two captured IOS-XE traces, hops 1-15 and 1-12).
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
// The hop number is a fixed three-character field, right-aligned ('  1', ' 10'), so a line is matched on that
// field rather than on "a space and the number" - the old helper was written for the one-space form this
// suite used to lock, and answered nothing once the field was right-aligned.
function hopLine(lines, n) {
  const re = new RegExp('^ +' + n + '  ');
  return lines.filter(function (l) { return re.test(l); })[0] || '';
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
  ok(/^  1  10\.0\.1\.254  [0-9.]+ msec  [0-9.]+ msec  [0-9.]+ msec$/.test(hop1),
    'hop 1 is the address and three figures: "' + hop1 + '"');
  eq((hop1.match(/msec/g) || []).length, 3, 'three `msec` figures, one per probe');
  ok(!/ ms(\s|$)/.test(hop1), 'and the unit is `msec`, not the `ms` a ping reply line uses');
  const dest = hopLine(lines, 3);
  ok(/^  3  10\.0\.3\.9  [0-9.]+ msec  [0-9.]+ msec  [0-9.]+ msec$/.test(dest),
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
  ok(/^  2  \*  \*  \*  \(link down/.test(hop2), 'hop 2 is three stars and the reason: "' + hop2 + '"');
  eq((hop2.match(/\*/g) || []).length, 3, 'one star per probe that came back empty');
  ok(hop2.indexOf('10.0.2.2') === -1, 'and no address, because nothing answered for that hop');
  ok(/% destination not reached after 2 hops/.test(lines.join('\n')), 'the walk ends where the wire did');
}

section('7. A destination-unreachable prints a letter in every probe column');
{
  const b = bench();
  const lines = trace(b, '198.51.100.7');
  const hop2 = hopLine(lines, 2);
  // R1 has no route to 198.51.100.7, so it answers all three probes with ICMP type 3 code 0 - network
  // unreachable - and a box's word for that is `!N` in the probe's column. The transcript this follows is
  // `4 172.30.36.131 !N !N !N` (community.cisco.com/t5/network-security/trace-route-n-n-n/td-p/3025719);
  // `2 10.10.20.2 !H * !H` is the same rule when one of the three probes went missing.
  eq(hop2, '  2  10.0.1.254  !N  !N  !N', 'hop 2 is three letters, one per refused probe');
  eq((hop2.match(/!N/g) || []).length, 3, 'one letter per probe');
  ok(!/msec/.test(hop2), 'and no time in any column: an error frame is not an echo');
  ok(!/unreachable/i.test(hop2), 'the letter is the whole answer - no words are printed beside it');
  ok(/% destination not reached/.test(lines.join('\n')), 'the trace does not claim success');
  eq(b.sim.traceroute(b.pc.id, '198.51.100.7').hops.length, 2, 'and it stops at the refusal');
}

section('8. The letter follows the ICMP code; a code with no letter keeps `?`');
{
  const b = bench();
  const { CliSession } = require('../engine/cli');
  const sess = new CliSession(b.topo.getDevice(b.pc.id), b.topo, b.sim);
  const saved = b.sim.traceroute;
  function probe(code) {
    return { answered: true, reached: false, address: '10.0.1.254', errorType: 3, code: code,
      rttMs: 0.5, sent: true, dropped: null };
  }
  function refusedWith(code) {
    return { events: [], success: false, target: '198.51.100.7', hops: [{
      ttl: 1, address: '10.0.1.254', dev: null, reached: false, reason: 'unreachable',
      errorType: 3, code: code, rttMs: 0.5, probes: [probe(code), probe(code), probe(code)]
    }] };
  }
  const letters = [0, 1, 2, 3, 13, 99].map(function (code) {
    b.sim.traceroute = function () { return refusedWith(code); };
    return sess.run('traceroute 198.51.100.7').output[2];
  });
  b.sim.traceroute = saved;
  // Codes 0-3 are the four the vendor's own ICMP type-3 table names, 13 is administratively prohibited,
  // and 99 is a code no table this console has seen names - `?` is that table's word for it, not a guess.
  eq(letters[0], '  1  10.0.1.254  !N  !N  !N', 'code 0 is network unreachable: !N');
  eq(letters[1], '  1  10.0.1.254  !H  !H  !H', 'code 1 is host unreachable: !H');
  eq(letters[2], '  1  10.0.1.254  !P  !P  !P', 'code 2 is protocol unreachable: !P');
  eq(letters[3], '  1  10.0.1.254  !U  !U  !U', 'code 3 is port unreachable: !U');
  eq(letters[4], '  1  10.0.1.254  !A  !A  !A', 'code 13 is administratively prohibited: !A');
  eq(letters[5], '  1  10.0.1.254  !?  !?  !?', 'an unnamed code is ? rather than a letter');
}

section('9. The probe count is the caller\'s, and defaults to three');
{
  const b = bench();
  eq(b.sim.traceroute(b.pc.id, '10.0.3.9').hops[0].probes.length, 3, 'the default is three probes a hop');
  eq(b.sim.traceroute(b.pc.id, '10.0.3.9', { probes: 1 }).hops[0].probes.length, 1,
    'a caller can ask for one');
  eq(b.sim.traceroute(b.pc.id, '10.0.3.9', { probes: 99 }).hops[0].probes.length, 10,
    'and an absurd count is capped rather than obeyed');
}

section('10. A two-digit hop number does not move the address column');
{
  // pc -- r1 -- ... -- r11 -- (11 routed hops), so the trace crosses the 9 -> 10 boundary. Every router is
  // configured symmetrically so the time-exceeded replies have a way home; without the return route the hops
  // past the first are silent and the trace never reaches eleven.
  const topo = new Topology();
  const pc = topo.addDevice(spec('generic-pc'));
  const routers = [];
  for (let i = 0; i < 11; i++) routers.push(topo.addDevice(spec('generic-router')));
  topo.connect(pc.id, 'eth0', routers[0].id, 'Gi0/0');
  for (let i = 0; i < routers.length - 1; i++) topo.connect(routers[i].id, 'Gi0/1', routers[i + 1].id, 'Gi0/0');
  const sim = new Simulator(topo);
  cfg(pc, ['interface eth0', 'ip address 10.9.1.1 255.255.255.0', 'exit',
    'ip default-gateway 10.9.1.2', 'exit'], topo, sim);
  for (let i = 0; i < routers.length; i++) {
    const cmds = ['interface Gi0/0', 'ip address 10.9.' + (i + 1) + '.2 255.255.255.0', 'exit'];
    if (i < routers.length - 1) {
      cmds.push('interface Gi0/1', 'ip address 10.9.' + (i + 2) + '.1 255.255.255.0', 'exit',
        'ip route 0.0.0.0 0.0.0.0 10.9.' + (i + 2) + '.2',
        'ip route 10.9.1.0 255.255.255.0 10.9.' + (i + 1) + '.1', 'exit');
    }
    cfg(routers[i], cmds, topo, sim);
  }
  const lines = runCommands(pc, topo, sim, ['enable', 'traceroute 10.9.11.2']).lines;
  const hop9 = hopLine(lines, 9);
  const hop10 = hopLine(lines, 10);
  const hop11 = hopLine(lines, 11);
  const col = function (line, addr) { return line.indexOf(addr); };
  ok(!!hop9 && !!hop10 && !!hop11, 'the trace reaches eleven hops: 9, 10 and 11 are on it');
  eq(col(hop9, '10.9.9.2'), col(hop10, '10.9.10.2'),
    'hop 10 puts its address in the column hop 9 used');
  eq(col(hop10, '10.9.10.2'), col(hop11, '10.9.11.2'), 'and hop 11 in the same one');
  ok(/^ 10  10\.9\.10\.2  /.test(hop10),
    'the number is right-aligned in a three-character field: "' + hop10 + '"');
  ok(/^  9  10\.9\.9\.2  /.test(hop9), 'hop 9 carries two leading spaces: "' + hop9 + '"');
  ok(lines.join('\n').indexOf('% destination not reached') === -1, 'and the walk finished at its target');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
