'use strict';
// An OSPF adjacency formed across a cable that was not there, and `show ip route` could not say its next hop
// was unreachable (#1271).
//
// `computeOspf()` collected an interface when it was `enabled` and addressed, then formed an adjacency for
// every topology link between two such interfaces. A topology link exists while its state is `down`, and
// nothing asked. So:
//
//   cable in   O  192.168.9.0   /24  [110/0] via 10.0.0.1  Gi0
//   cable out  O  192.168.9.0   /24  [110/0] via 10.0.0.1  Gi0      <- same row, next hop unreachable
//   ping 192.168.9.1  ->  false, "no ARP reply from 10.0.0.1"
//
// BGP had the same defect one iteration earlier (#1269); OSPF had no link-state check at all.
const path = require('path');
const { Topology, Simulator, runCommands } = require('../engine');
const { CliSession } = require('../engine/cli');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices')).filter(function (s) { return !s.error; });
const ROUTER = catalog.filter(function (s) { return /ASR 1001-X/.test(s.model); })[0];
const eth = function (d) {
  return [...d.interfaces.values()].filter(function (i) { return i.type === 'ethernet'; });
};

// r1 -- r2, OSPF on the shared segment, and r1 has a LAN behind it that r2 must learn as an O route.
function lab() {
  const t = new Topology();
  const r1 = t.addDevice(ROUTER, 'r1');
  const r2 = t.addDevice(ROUTER, 'r2');
  const [a1, a2] = eth(r1).map(function (i) { return i.name; });
  const [b1] = eth(r2).map(function (i) { return i.name; });
  t.connect('r1', a1, 'r2', b1);
  const sim = new Simulator(t);
  runCommands(r1, t, sim, ['configure terminal',
    'interface ' + a1, 'ip address 10.0.0.1 255.255.255.0', 'exit',
    'interface ' + a2, 'ip address 192.168.9.1 255.255.255.0', 'exit',
    'router ospf 1', 'ospf router-id 1.1.1.1',
    'network 10.0.0.0 255.255.255.0 area 0',
    'network 192.168.9.0 255.255.255.0 area 0', 'end']);
  runCommands(r2, t, sim, ['configure terminal',
    'interface ' + b1, 'ip address 10.0.0.2 255.255.255.0', 'exit',
    'router ospf 1', 'ospf router-id 2.2.2.2',
    'network 10.0.0.0 255.255.255.0 area 0', 'end']);
  sim.computeOspf();
  return { t: t, sim: sim, r1: r1, r2: r2, a1: a1, a2: a2, b1: b1 };
}

function show(env, dev, cmd) {
  return ((new CliSession(dev, env.t, env.sim).run(cmd).output) || []).map(String).join('\n');
}

function rows(env, dev, code) {
  return show(env, dev, 'show ip route').split('\n').filter(function (l) {
    return l.indexOf(code + ' ') === 0 || l.indexOf(code + '  ') === 0;
  });
}

function pull(env) {
  env.sim.setLinkState([...env.t.links.values()][0].id, 'down');
  env.sim.computeOspf();
}

console.log('');
console.log('A live adjacency installs an O route, unmarked:');
{
  const env = lab();
  const o = rows(env, env.r2, 'O');
  ok(o.length === 1, 'one O route on r2', show(env, env.r2, 'show ip route'));
  ok(/192\.168\.9\.0\s+\/24/.test(o.join('\n')), 'for r1\'s LAN', o.join(' | '));
  ok(/via 10\.0\.0\.1/.test(o.join('\n')), 'through r1 as next hop', o.join(' | '));
  ok(!/\(/.test(o.join('\n')), 'and nothing is marked, because nothing is wrong', o.join(' | '));
}

console.log('');
console.log('Pull the cable and the adjacency goes with it:');
{
  const env = lab();
  pull(env);
  const o = rows(env, env.r2, 'O');
  ok(o.length === 0, 'no O route survives a cable that is out', show(env, env.r2, 'show ip route'));
  ok(!/192\.168\.9\.0/.test(show(env, env.r2, 'show ip route')),
    'the prefix is withdrawn, not merely annotated');
  // The data plane was already honest - "no ARP reply from 10.0.0.1" - which is how the table's silence was
  // found: the route said the path existed and the ping said the neighbour was not answering.
  const r = env.sim.ping('r2', '192.168.9.1', { count: 1 });
  ok(r.replies.every(function (x) { return !x.success; }), 'and a ping to that LAN fails',
    r.replies.map(function (x) { return x.success; }).join(','));
}

console.log('');
console.log('A shut far port forms no adjacency either:');
{
  const env = lab();
  runCommands(env.r1, env.t, env.sim, ['configure terminal', 'interface ' + env.a1, 'shutdown', 'end']);
  env.sim.computeOspf();
  ok(rows(env, env.r2, 'O').length === 0, 'r2 withdraws the route', show(env, env.r2, 'show ip route'));
}

console.log('');
console.log('Restoring the cable brings the adjacency back:');
{
  const env = lab();
  pull(env);
  ok(rows(env, env.r2, 'O').length === 0, 'down while the cable is out');
  env.sim.setLinkState([...env.t.links.values()][0].id, 'up');
  env.sim.computeOspf();
  ok(rows(env, env.r2, 'O').length === 1, 'and back when it is restored',
    show(env, env.r2, 'show ip route'));
}

console.log('');
console.log('A route that is still installed but leads nowhere says so:');
{
  const env = lab();
  // A static route is configuration, not a learned fact: it stays, whatever the wire is doing. But a row
  // that reads as a working path while every packet to it is dropped is the defect.
  runCommands(env.r2, env.t, env.sim, ['configure terminal',
    'ip route 172.20.0.0 255.255.0.0 10.0.0.1', 'end']);
  pull(env);
  const s = rows(env, env.r2, 'S').join('\n');
  ok(/172\.20\.0\.0/.test(s), 'the static route is still listed', s);
  ok(/\(down: link down\)/.test(s),
    'and marked with the reason its next hop cannot be reached', s);
  ok(/via 10\.0\.0\.1/.test(s), 'while still naming the next hop', s);

  // The connected route on the far side of nothing is marked too: a `C` row that says "directly connected"
  // about a port with no cable is the same lie in a different table. (r1 is the router with an unconnected
  // addressed port.)
  const env2 = lab();
  const r1Routes = show(env2, env2.r1, 'show ip route');
  ok(/192\.168\.9\.0\s+\/24\s+is directly connected, Gi0\/0\/0\s+\(down: no cable\)/.test(r1Routes),
    'a connected route on a port with no cable is marked', r1Routes);
  ok(!/10\.0\.0\.0\s+\/24\s+is directly connected, Gi0\s+\(/.test(r1Routes),
    'and the one on the live cable is not', r1Routes);
}

console.log('');
console.log('The mark is the same sentence the other tables use:');
{
  const env = lab();
  pull(env);
  runCommands(env.r2, env.t, env.sim, ['configure terminal',
    'ip route 172.20.0.0 255.255.0.0 10.0.0.1', 'end']);
  const routeLine = rows(env, env.r2, 'S').join('\n');
  const ifaceText = show(env, env.r2, 'show interfaces ' + env.b1).split('\n')
    .filter(function (l) { return /^  status:/.test(l); })[0] || '';
  // Three tables describe this one port: the route row, the interface block, and - once a neighbour has been
  // learned through it - `show arp` and `show mac address-table`. The route marker must be the shared helper's
  // own words, or an operator comparing two screens has to translate between them.
  ok(/down \(link down\)/.test(ifaceText), 'show interfaces says the link is down', ifaceText);
  ok(/\(down: link down\)/.test(routeLine), 'and show ip route says why, in the shared form', routeLine);
  const cli = new CliSession(env.r2, env.t, env.sim);
  const shared = cli._staleNote(env.r2.interfaces.get(env.b1));
  ok(shared === '(down: link down)',
    'the route marker is exactly what the shared helper produces for that port', shared);
  ok(routeLine.indexOf(shared) !== -1, 'and is what the row actually prints', routeLine);
}

console.log('');
console.log('Nothing is marked when nothing is wrong:');
{
  const env = lab();
  const text = show(env, env.r2, 'show ip route');
  ok(!/\(down|\(administratively/.test(text), 'no route row carries a warning on a healthy lab', text);
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
