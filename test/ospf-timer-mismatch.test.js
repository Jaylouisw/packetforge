'use strict';
// OSPF refuses a Hello whose intervals do not match the receiving port.
//
// The Hello packet carries the sender's HelloInterval and RouterDeadInterval, and RFC 2328 10.5 says
// what the receiver does with them: "the values of the Network Mask, HelloInterval, and
// RouterDeadInterval fields in the received Hello packet must be checked against the values configured
// for the receiving interface. Any mismatch causes processing to stop and the packet to be dropped."
// Two ends running different intervals therefore never leave Down, and a real box leaves only the
// debug trace `OSPF: Mismatched hello parameters from 10.0.12.2` / `Dead R 40 C 60, Hello R 10 C 15`
// (Cisco 12151, `debug ip ospf hello`).
//
// computeOspf() built the adjacency anyway: the timers reach the model as two independent per-device
// settings (`config.ospf.helloSec` / `deadSec`, the same numbers `show ip ospf neighbor` counts its
// Dead Time cell from) and nothing compared them, so `show ip route` offered an `O` route across a
// link a real pair of routers would leave down. These checks hold the engine to the RFC and hold the
// console to saying why, instead of the false "nothing on the other end runs OSPF".
const { loadCatalog } = require('../devices/registry');
const { Topology } = require('../engine/topology');
const { Simulator } = require('../engine/simulator');
const cliModule = require('../engine/cli');
const CliSession = cliModule.CliSession || cliModule;

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  ✓ ' + msg); }
  else { failed++; console.error('  ✗ ' + msg + (detail ? '  [' + detail + ']' : '')); }
}
const ROOT = require('path').join(__dirname, '..');
const specs = loadCatalog(ROOT + '/devices').filter(function (s) { return !s.error; });
const ROUTER = specs.find(function (s) { return /^ISR 4331$/.test(s.model); });

// r1 --- r2 --- r3, one subnet per wire, so r1 normally learns r3's network as an O route through r2.
function chain() {
  const t = new Topology();
  ['r1', 'r2', 'r3'].forEach(function (id) { t.addDevice(ROUTER, id); });
  t.connect('r1', 'Gi0/0/0', 'r2', 'Gi0/0/0', { mediaId: '1000base-t', speedMbps: 1000 });
  t.connect('r2', 'Gi0/0/1', 'r3', 'Gi0/0/0', { mediaId: '1000base-t', speedMbps: 1000 });
  const addr = function (id, port, ip) {
    const i = t.getDevice(id).interfaces.get(port);
    i.ip = ip; i.mask = '255.255.255.0';
  };
  addr('r1', 'Gi0/0/0', '10.1.0.1'); addr('r2', 'Gi0/0/0', '10.1.0.2');
  addr('r2', 'Gi0/0/1', '10.2.0.2'); addr('r3', 'Gi0/0/0', '10.2.0.3');
  ['r1', 'r2', 'r3'].forEach(function (id, n) {
    const s = new CliSession(t.getDevice(id), t, null);
    ['enable', 'configure terminal', 'ospf router-id ' + (n + 1) + '.' + (n + 1) + '.' + (n + 1) + '.' + (n + 1)]
      .forEach(function (c) { s.run(c); });
  });
  return t;
}
function show(t, sim, id, cmd) {
  return ((new CliSession(t.getDevice(id), t, sim || null).run(cmd) || {}).output || []).join('\n');
}
function neighbourIds(t, id) {
  return (t.getDevice(id).ospfNeighbors || []).map(function (n) { return n.routerId; }).sort();
}

console.log('');
console.log('Two ends at the default 10 s / 40 s are adjacent (the control):');
{
  const t = chain();
  const sim = new Simulator(t);
  sim.computeOspf();
  ok(neighbourIds(t, 'r1').join(',') === '2.2.2.2', 'r1 sees r2', neighbourIds(t, 'r1').join(','));
  ok(neighbourIds(t, 'r3').join(',') === '2.2.2.2', 'r3 sees r2', neighbourIds(t, 'r3').join(','));
  ok((t.getDevice('r1').ospfRejected || []).length === 0, 'and nothing was refused');
  const routes = show(t, sim, 'r1', 'show ip route');
  const learned = routes.split('\n').filter(function (l) { return /10\.2\.0\.0/.test(l); }).join('|');
  ok(/\bO\b/.test(learned), 'r1 reaches 10.2.0.0/24 through r2 as an O route', learned);
}

console.log('');
console.log('A different Hello interval on one end means no adjacency at all:');
{
  const t = chain();
  const sim = new Simulator(t);
  // `ip ospf hello-interval 5` on r2 alone: the pair it then sends is 5 / 20 against r1's default
  // 10 / 40, which is the mismatch `Dead R 40 C 60, Hello R 10 C 15` reports under `debug ip ospf hello`.
  const r2 = t.getDevice('r2');
  r2.config.ospf.helloSec = 5;
  r2.config.ospf.deadSec = 20;
  sim.computeOspf();

  ok(neighbourIds(t, 'r1').length === 0, 'r1 has no neighbour', neighbourIds(t, 'r1').join(','));
  ok(neighbourIds(t, 'r2').length === 0, 'and neither does r2', neighbourIds(t, 'r2').join(','));
  ok((t.getDevice('r1').ospfRoutes || []).length === 0,
    'so r1 installs no O route across that link', String((t.getDevice('r1').ospfRoutes || []).length));
  const routes = show(t, sim, 'r1', 'show ip route');
  ok(!/10\.2\.0\.0/.test(routes), 'and 10.2.0.0/24 is not in the table', routes);

  const one = show(t, sim, 'r1', 'show ip ospf neighbor Gi0/0/0');
  ok(/Hello 5 s \/ Dead 20 s/.test(one) && /Hello 10 s \/ Dead 40 s/.test(one),
    'the port names both interval pairs', one);
  ok(/RFC 2328 10\.5/.test(one), 'and cites the paragraph the rule comes from');
  ok(!/nothing on the other end runs OSPF/.test(one),
    'the far end is running OSPF, so the console must not say it is not', one);

  const all = show(t, sim, 'r1', 'show ip ospf neighbor');
  ok(/1 link\(s\) were offered and refused/.test(all), 'the whole table counts the refusal', all);
  const summary = show(t, sim, 'r1', 'show ip ospf');
  ok(/Links refused: 1/.test(summary), 'the process summary counts it too', summary);

  // The record is symmetric: each side explains the same link from its own end.
  const seen = t.getDevice('r2').ospfRejected[0];
  ok(seen && seen.peer === 'r1' && seen.helloSec === 5 && seen.peerHellSec === 10,
    'r2 records the same link with the numbers swapped', JSON.stringify(seen));
}

console.log('');
console.log('Equal Hello, different Dead is still a mismatch:');
{
  // The debug line is a pair of numbers, not one: comparing only the hello interval would let this
  // pair through, and the dead interval is the one that decides when a neighbour is declared down.
  const t = chain();
  const sim = new Simulator(t);
  t.getDevice('r2').config.ospf.deadSec = 60;   // hello untouched at the 10 s default
  sim.computeOspf();
  ok(neighbourIds(t, 'r1').length === 0,
    'r2 sends Hello 10 / Dead 60 against r1\'s 10 / 40, so no neighbour', neighbourIds(t, 'r1').join(','));
  ok(/Dead 60 s/.test(show(t, sim, 'r1', 'show ip ospf neighbor Gi0/0/0')),
    'and the answer names the number that disagreed');
}

console.log('');
console.log('Matching the intervals again brings the adjacency back:');
{
  // Same wires, addresses and router IDs - only the timer that was changed is put back, so the
  // refusal is the timers and nothing else.
  const t = chain();
  const sim = new Simulator(t);
  const r2 = t.getDevice('r2');
  r2.config.ospf.helloSec = 5;
  r2.config.ospf.deadSec = 20;
  sim.computeOspf();
  ok(neighbourIds(t, 'r1').length === 0, 'refused while they differ');
  r2.config.ospf.helloSec = 10;
  r2.config.ospf.deadSec = 40;
  sim.computeOspf();
  ok(neighbourIds(t, 'r1').join(',') === '2.2.2.2', 'adjacent once they match', neighbourIds(t, 'r1').join(','));
  ok((t.getDevice('r1').ospfRejected || []).length === 0, 'and the refusal list is empty again');
}

console.log('');
console.log('A different area is recorded as its own reason, not as "nothing runs OSPF":');
{
  const t = chain();
  const sim = new Simulator(t);
  // `ip ospf area 1` on r2's port towards r1 only: the link is refused, but the reason is the area.
  t.getDevice('r2').config.ospf.interfaces = [{ name: 'Gi0/0/0', area: 1 }];
  sim.computeOspf();
  ok(neighbourIds(t, 'r1').length === 0, 'no adjacency across areas', neighbourIds(t, 'r1').join(','));
  const why = show(t, sim, 'r1', 'show ip ospf neighbor Gi0/0/0');
  ok(/area 1/.test(why) && /area 0/.test(why), 'the answer names both areas', why);
  ok(t.getDevice('r1').ospfRejected[0].reason === 'area', 'and the engine recorded it as an area refusal',
    JSON.stringify(t.getDevice('r1').ospfRejected[0]));
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
