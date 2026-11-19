'use strict';
// A box that pings an address it holds talks to its own stack - the echo never reaches a wire.
//
//   r1# ping 10.0.0.1
//   .....
//   Success rate is 0 percent (0/5)
//   Request timed out (seq 0) ...
//   % Echoes lost: 5 drops (no ARP reply from 10.0.0.1 x5)
//
// 10.0.0.1 is the address r1 configured on Gi0/0. On the device the request is answered by the local IP stack:
// no frame is built, no ARP is sent, and the echo comes back in the same instant. The engine instead routed the
// request out of the port that owns the address and waited for an ARP reply to its own address, which no NIC
// ever sends - so every box in the simulator was unable to reach itself, and the console explained the silence
// with a drop that named the box the operator was sitting at ("no ARP reply from 10.0.0.1").
//
// The wire half still has to work, so a neighbour that holds nothing is pinned here too, and both an IPv4 and
// an IPv6 address are asked: `Simulator.ping()` and `ping6()` are two doors onto one rule.
const path = require('path');
const { Topology, Simulator } = require('../engine');
const { CliSession } = require('../engine/cli');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices')).filter(function (s) { return !s.error; });
const ROUTER = catalog.find(function (s) { return s.model === 'generic-router'; });
const SWITCH = catalog.find(function (s) { return s.model === 'generic-switch'; });
const PC = catalog.find(function (s) { return s.model === 'generic-pc'; });

const V4_ROUTER = '10.0.0.1';
const V4_HOST = '10.0.0.10';
const V6_ROUTER = '2001:db8:1::1';

function lab() {
  const t = new Topology();
  t.addDevice(SWITCH, 'sw'); t.addDevice(ROUTER, 'r1'); t.addDevice(PC, 'p');
  t.connect('r1', 'Gi0/0', 'sw', 'Fa0/1');
  t.connect('p', 'eth0', 'sw', 'Fa0/3');
  const sim = new Simulator(t);
  const S = {};
  const cli = function (id) { return (S[id] = S[id] || new CliSession(t.getDevice(id), t, sim)); };
  const cfg = function (id, lines) {
    cli(id).run('configure terminal');
    lines.forEach(function (l) { return cli(id).run(l); });
    cli(id).run('end');
  };
  cfg('r1', ['interface Gi0/0', 'ip address ' + V4_ROUTER + ' 255.255.255.0',
    'ipv6 address ' + V6_ROUTER + '/64']);
  cfg('p', ['interface eth0', 'ip address ' + V4_HOST + ' 255.255.255.0',
    'ip default-gateway ' + V4_ROUTER]);
  return {
    t: t, sim: sim, cli: cli,
    joined: function (id, cmd) { return cli(id).run(cmd).output.join('\n'); }
  };
}

console.log('');
console.log('A router pings its own interface address:');
{
  const L = lab();
  const before = L.sim.events.length;
  const out = L.joined('r1', 'ping ' + V4_ROUTER);
  ok(/!!!!!/.test(out), 'all five echoes come back', out);
  ok(/Success rate is 100 percent \(5\/5\)/.test(out), 'and the success rate says so', out);
  ok(!/^Reply from /m.test(out), 'and the report is the marks line and the rate, with no per-echo sentence', out);
  ok(out.indexOf('no ARP reply') === -1, 'the console does not blame an ARP reply from the box itself', out);
  const types = L.sim.events.slice(before).map(function (e) { return e.type; });
  ok(types.indexOf('icmp-echo') !== -1, 'the stack answered the echo', JSON.stringify(types));
  ok(types.indexOf('icmp-received') !== -1, 'and the reply landed', JSON.stringify(types));
  ok(types.indexOf('arp-request') === -1, 'nothing was put on the wire to find itself', JSON.stringify(types));
}

console.log('');
console.log('So does a host:');
{
  const L = lab();
  const out = L.joined('p', 'ping ' + V4_HOST);
  ok(/!!!!!/.test(out), 'a PC reaches its own address', out);
  ok(/Success rate is 100 percent \(5\/5\)/.test(out), 'at full rate', out);
}

console.log('');
console.log('The engine API answers the same way:');
{
  const L = lab();
  const res = L.sim.ping('r1', V4_ROUTER);
  ok(res.replies.every(function (r) { return r.success; }),
    'every reply is a success', JSON.stringify(res.replies.map(function (r) { return r.success; })));
  ok(res.replies.every(function (r) { return r.rtt !== null && r.rtt !== undefined; }),
    'and each one carries a round trip rather than null', JSON.stringify(res.replies.map(function (r) { return r.rtt; })));
}

console.log('');
console.log('The wire is untouched - a neighbour that holds nothing still loses every echo:');
{
  const L = lab();
  const out = L.joined('r1', 'ping 10.0.0.99');
  ok(/Success rate is 0 percent \(0\/5\)/.test(out), 'the ping fails', out);
  ok(/no ARP reply from 10\.0\.0\.99/.test(out), 'and names the address nobody answered for', out);
  const far = L.joined('p', 'ping ' + V4_ROUTER);
  ok(/Success rate is 100 percent \(5\/5\)/.test(far), 'while the host still reaches the router over the wire', far);
}

console.log('');
console.log('Traceroute to the box itself is one hop:');
{
  const L = lab();
  const out = L.joined('r1', 'traceroute ' + V4_ROUTER);
  ok(out.split('\n').filter(function (l) { return /^\s*1\s/.test(l); }).length === 1, 'exactly one hop is printed', out);
  ok(/10\.0\.0\.1/.test(out), 'and it is the address asked about', out);
}

console.log('');
console.log('The IPv6 echo follows the same rule:');
{
  const L = lab();
  const out = L.joined('r1', 'ping ' + V6_ROUTER);
  ok(/!!!!!/.test(out), 'all five ICMPv6 echoes come back', out);
  ok(/Success rate is 100 percent \(5\/5\)/.test(out), 'at full rate', out);
  ok(out.indexOf('no ARP reply') === -1, 'with no invented IPv4 drop', out);
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
