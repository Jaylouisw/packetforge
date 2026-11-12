'use strict';
// ICMP errors, and the traceroute that depends on them.
//
// Until this existed the engine decremented TTL, saw it reach zero, and dropped the packet
// with a timeline entry nobody outside the simulator can read. It did the same when it had
// no route. Two consequences:
//
//   * traceroute was impossible in principle - the whole command works by provoking
//     "time exceeded" replies from each hop in turn, and no hop ever replied;
//   * a lab could not tell "the packet died at hop 3" from "the packet died here", because
//     the only evidence was a drop event with no packet sent back.
//
// What is locked here:
//   1. TTL expiry sends ICMP type 11 back to the sender, naming the router that killed it;
//   2. no route sends ICMP type 3, so an unroutable destination is a refusal and not silence;
//   3. an ICMP error is never sent about an ICMP error - that is how a routing loop becomes
//      a packet storm;
//   4. traceroute reports the hops in order, and the destination as reached;
//   5. a destination one hop away is one hop, not two;
//   6. an unreachable network stops the trace with a refusal rather than a timeout;
//   7. ping is unchanged by any of it.
const path = require('path');
const { Topology, Simulator, runCommands } = require('../engine');
const net = require('../engine/net');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.log('  \u2717 ' + msg); }
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

// host --R1--R2-- server, two routed hops between the ends.
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

section('1. TTL expiry is answered, not swallowed');
{
  const b = bench();
  // A probe aimed at the middle of the path: TTL 1 dies at R1.
  const res = b.sim.traceroute(b.pc.id, '10.0.3.9', { maxHops: 1 });
  eq(res.hops.length, 1, 'one hop probed');
  eq(res.hops[0].reason, 'time-exceeded', 'and it timed out in transit');
  eq(res.hops[0].address, '10.0.1.254', 'R1 answered for it');

  const ev = b.sim.events.filter(function (e) { return e.type === 'icmp-error'; });
  ok(ev.length > 0, 'an ICMP error was actually sent');
  eq(ev[0].errorType, net.ICMP_TIME_EXCEEDED, 'of type 11 (time exceeded)');
  eq(ev[0].code, 0, 'code 0 (TTL reached zero in transit)');
  eq(ev[0].to, '10.0.1.1', 'addressed to the host that sent the probe');
  eq(ev[0].from, '10.0.1.254', 'from the router\'s address on the ingress side');
}

section('2. No route is a refusal, not silence');
{
  const b = bench();
  // The host asks for a network nobody routes.
  // The first probe carries TTL 1, so it dies of TTL before anyone evaluates the route -
  // which is what a real traceroute shows too. The second probe survives the decrement at
  // R1 with a TTL left, R1 finds no route, and *that* is the refusal.
  const res = b.sim.traceroute(b.pc.id, '198.51.100.7', { maxHops: 5 });
  eq(res.hops[0].reason, 'time-exceeded', 'hop 1 expires at the first router');
  const first = res.hops[1];
  eq(first.reason, 'unreachable', 'hop 2 is refused for want of a route');
  eq(first.address, '10.0.1.254', 'and the router names itself');
  eq(first.errorType, net.ICMP_DEST_UNREACH, 'with type 3');
  eq(res.success, false, 'the trace does not claim success');
  eq(res.hops.length, 2, 'and it stops at the refusal instead of probing on');
}

section('3. An ICMP error never provokes another ICMP error');
{
  const b = bench();
  b.sim.traceroute(b.pc.id, '10.0.3.9', { maxHops: 3 });
  const errors = b.sim.events.filter(function (e) { return e.type === 'icmp-error'; });
  // Two hops expire the probe; the third reaches the host. A router answering an error with
  // an error would show up here as extra events, and in a real loop as a storm.
  ok(errors.length <= 2, 'no error was raised in response to an error (' + errors.length + ' sent)');
  ok(errors.every(function (e) { return e.aboutDst === '10.0.3.9'; }),
    'and every error is about the original probe, not about another error');
}

section('4. Traceroute walks the path in order');
{
  const b = bench();
  const res = b.sim.traceroute(b.pc.id, '10.0.3.9');
  eq(res.hops.length, 3, 'three hops to the destination');
  eq(res.hops[0].address, '10.0.1.254', 'hop 1 is R1');
  eq(res.hops[0].reason, 'time-exceeded', 'which expires the probe');
  eq(res.hops[1].address, '10.0.2.2', 'hop 2 is R2');
  eq(res.hops[1].reason, 'time-exceeded', 'which expires it too');
  eq(res.hops[2].address, '10.0.3.9', 'hop 3 is the destination');
  eq(res.hops[2].reason, 'echo-reply', 'which answers the echo');
  eq(res.success, true, 'and the trace succeeds');
}

section('5. A destination one hop away is one hop');
{
  const b = bench();
  // R2 to the server is one link, no router in between.
  const res = b.sim.traceroute(b.r2.id, '10.0.3.9');
  eq(res.hops.length, 1, 'one hop');
  eq(res.hops[0].reason, 'echo-reply', 'answered, not expired');
  eq(res.hops[0].address, '10.0.3.9', 'by the destination itself');
  eq(res.success, true, 'success');
}

section('6. maxHops is respected');
{
  const b = bench();
  const res = b.sim.traceroute(b.pc.id, '10.0.3.9', { maxHops: 2 });
  eq(res.hops.length, 2, 'two probes sent');
  eq(res.success, false, 'the destination was not reached in two');
  ok(res.hops.every(function (h) { return !h.reached; }), 'and no hop claims to be it');
}

section('7. The CLI prints the hops the way an operator reads them');
{
  const b = bench();
  const out = runCommands(b.pc, b.topo, b.sim, ['enable', 'traceroute 10.0.3.9']);
  const text = out.lines.join('\n');
  ok(/Tracing the route to 10\.0\.3\.9/.test(text), 'it announces the target');
  ok(/ 1  10\.0\.1\.254/.test(text), 'hop 1 with its address');
  ok(/ 2  10\.0\.2\.2/.test(text), 'hop 2 with its address');
  ok(/ 3  10\.0\.3\.9  destination reached/.test(text), 'and the destination, marked reached');

  const bad = runCommands(b.pc, b.topo, b.sim, ['enable', 'traceroute not-an-ip']);
  ok(/% Invalid traceroute target/.test(bad.lines.join('\n')), 'a nonsense target is refused');
}

section('8. Ping is unaffected, and still explains a failure');
{
  const b = bench();
  ok(b.sim.ping(b.pc.id, '10.0.3.9', { count: 1 }).success, 'a reachable host still answers');
  const bad = b.sim.ping(b.pc.id, '198.51.100.7', { count: 1 });
  eq(bad.success, false, 'an unroutable host still fails');

  const b2 = bench();
  const out = runCommands(b2.pc, b2.topo, b2.sim, ['enable', 'ping 198.51.100.7 1']);
  ok(/Success rate is 0 percent/.test(out.lines.join('\n')), 'and the CLI reports it honestly');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
