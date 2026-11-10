'use strict';
// ipv6-console.test.js - IPv6 could be configured and never tested, and its arguments were dropped.
//
// Measured before this pass, on two `generic-router`s sharing a link:
//   R1#ping 2001:db8:1::2
//   % Invalid ping target: 2001:db8:1::2
//   R1#ping ipv6 2001:db8:1::2
//   % Unrecognised argument "2001:db8:1::2" (expected count <n> or at <ms>)
//
// Addresses, static routes and router advertisements were all configurable, and none of it could be
// tested from the console: the simulator has had ping6() all along, the door was missing.
//
// The same corner dropped words and invented meanings:
//   ipv6 address 2001:db8:1::2/64 extra   -> "IPv6 address ... on Gi0/0"      (extra dropped)
//   ipv6 address 2001:db8:1::1/64  (twice) -> success both times, no duplicate check
//   ipv6 address ff02::1/64               -> accepted, then show ipv6 route printed a
//                                            *connected route for ff02::/64* - a multicast group
//                                            worn as a subnet
//   ipv6 address ::1/128                  -> accepted
//   ipv6 address                          -> % Invalid IPv6 address ""      (an empty word quoted)
//   ipv6 route ... 2001:db8:1::2 250      -> accepted, 250 dropped
//   ipv6 nd suppress-ra extra             -> inside an interface block: refused by the *global*
//                                            handler, which the fall-through did not recognise as a
//                                            refusal, so it left interface mode and the operator's
//                                            next commands went to the wrong prompt
//   ipv6 unicast-routing                  -> % Unrecognized config command
const path = require('path');
const { Topology, Simulator, CliSession } = require('../engine');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg); }
}
function eq(actual, expected, msg) {
  ok(actual === expected, msg + (actual === expected ? '' : ' (got ' + JSON.stringify(actual) + ')'));
}
function rate(out) {
  const m = /Success rate is (\d+) percent/.exec((Array.isArray(out) ? out : [out]).join(' '));
  return m ? Number(m[1]) : null;
}
function cli(t, dev, cmds) {
  const s = new CliSession(dev, t, new Simulator(t));
  s.run('enable');
  s.run('configure terminal');
  for (const c of cmds) s.run(c);
  s.run('end');
  return s;
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
const ROUTER = catalog.find(function (s) { return s.model === 'generic-router'; });

// R1 --- R2 sharing 2001:db8:1::/64.
function pair() {
  const t = new Topology();
  const r1 = t.addDevice(ROUTER); r1.name = 'R1';
  const r2 = t.addDevice(ROUTER); r2.name = 'R2';
  t.connect(r1.id, 'Gi0/0', r2.id, 'Gi0/0');
  const s1 = cli(t, r1, ['ipv6 unicast-routing', 'interface Gi0/0',
    'ipv6 address 2001:db8:1::1/64', 'exit']);
  const s2 = cli(t, r2, ['ipv6 unicast-routing', 'interface Gi0/0',
    'ipv6 address 2001:db8:1::2/64', 'exit']);
  return { t: t, r1: r1, r2: r2, s1: s1, s2: s2, sim: new Simulator(t) };
}

// A --- M --- Z, so M is only ever a transit router.
function chain() {
  const t = new Topology();
  const a = t.addDevice(ROUTER); a.name = 'A';
  const m = t.addDevice(ROUTER); m.name = 'M';
  const z = t.addDevice(ROUTER); z.name = 'Z';
  t.connect(a.id, 'Gi0/0', m.id, 'Gi0/0');
  t.connect(m.id, 'Gi0/1', z.id, 'Gi0/0');
  const sa = cli(t, a, ['ipv6 unicast-routing', 'interface Gi0/0',
    'ipv6 address 2001:db8:12::1/64', 'exit', 'ipv6 route 2001:db8:23::/64 2001:db8:12::2']);
  const sm = cli(t, m, ['ipv6 unicast-routing',
    'interface Gi0/0', 'ipv6 address 2001:db8:12::2/64', 'exit',
    'interface Gi0/1', 'ipv6 address 2001:db8:23::2/64', 'exit']);
  const sz = cli(t, z, ['ipv6 unicast-routing', 'interface Gi0/0',
    'ipv6 address 2001:db8:23::1/64', 'exit', 'ipv6 route 2001:db8:12::/64 2001:db8:23::2']);
  return { t: t, a: a, m: m, z: z, sa: sa, sm: sm, sz: sz, sim: new Simulator(t) };
}

console.log('\nPing works over IPv6, both spellings:');
{
  const env = pair();
  eq(rate(env.s1.run('ping 2001:db8:1::2 count 2').output), 100, 'ping <v6addr> answers');
  eq(rate(env.s1.run('ping ipv6 2001:db8:1::2 count 2').output), 100, 'ping ipv6 <v6addr> answers');
  const out = env.s1.run('ping 2001:db8:1::2 count 1').output;
  ok(out.some(function (l) { return /^Reply from 2001:db8:1::2: bytes=100 time=/.test(l); }),
    'and the reply line names the IPv6 address');
  ok(out.some(function (l) { return /^Sending 1, 100-byte ICMP Echos to 2001:db8:1::2/.test(l); }),
    'with the same report shape as the IPv4 ping');
  eq(rate(env.s1.run('ping 2001:db8:1::2 count abc').output), null, 'a bad count is refused');
  ok(/% count expects a whole number/.test(env.s1.run('ping 2001:db8:1::2 count abc').output[0]),
    'by name');
  // The link-local address every port has is a legitimate target too.
  const ll = env.r2.linkLocal6(env.r2.interfaces.get('Gi0/0'));
  eq(rate(env.s1.run('ping ' + ll + ' count 1').output), 100, 'a link-local address answers as well');
}

console.log('\nA failed IPv6 ping says why:');
{
  const env = chain();
  const unreachable = env.sa.run('ping 2001:db8:99::1 count 1').output;
  eq(rate(unreachable), 0, 'an address with no route answers 0 percent');
  ok(unreachable.some(function (l) { return /% no IPv6 route to 2001:db8:99::1 on A/.test(l); }),
    'and the reason names the route that is missing');
}

console.log('\nipv6 unicast-routing is a real switch:');
{
  const env = chain();
  eq(rate(env.sa.run('ping 2001:db8:23::1 count 2').output), 100, 'the transit router forwards');
  env.sm.run('configure terminal');
  eq(env.sm.run('no ipv6 unicast-routing').output[0],
    'IPv6 unicast routing disabled on M - this device now forwards no IPv6 packet ' +
    '(its own addresses still answer)', 'the command says what it stopped');
  env.sm.run('end');
  const blocked = env.sa.run('ping 2001:db8:23::1 count 2').output;
  eq(rate(blocked), 0, 'and nothing is forwarded through it any more');
  ok(blocked.some(function (l) { return /% IPv6 unicast routing is disabled on M/.test(l); }),
    'the answer names the router and the reason');
  // The table is not deleted - the routes are still configured, they just do not forward.
  const table = env.sm.run('show ipv6 route').output;
  ok(table.some(function (l) { return /^! IPv6 unicast routing is DISABLED/.test(l); }),
    'show ipv6 route warns that the table is not a promise');
  ok(table.filter(function (l) { return /C 2001:db8:/.test(l); }).length === 2,
    'and the connected routes are still listed');
  env.sm.run('configure terminal');
  eq(env.sm.run('ipv6 unicast-routing').output[0], 'IPv6 unicast routing enabled on M', 're-enabled');
  env.sm.run('end');
  eq(rate(env.sa.run('ping 2001:db8:23::1 count 2').output), 100, 'and forwarding resumes');
  eq(env.sm.run('configure terminal', 'ipv6 unicast-routing', 'end').output[0],
    'IPv6 unicast routing is already enabled on M', 'saying it twice is not a second change');
  // A device that cannot route refuses to claim it can.
  const pc = catalog.find(function (s) { return s.model === 'generic-pc'; });
  const t2 = new Topology(); const h = t2.addDevice(pc); h.name = 'PC1';
  const hs = cli(t2, h, ['ipv6 unicast-routing']);
  ok(/% PC1 does not route/.test(hs.run('configure terminal', 'ipv6 unicast-routing').output[0]),
    'a host refuses ipv6 unicast-routing by naming why');
}

console.log('\nipv6 address takes exactly the words it uses:');
{
  const env = pair();
  const s = env.s1;
  s.run('configure terminal', 'interface Gi0/0');
  eq(s.run('ipv6 address').output[0],
    '% Incomplete command: ipv6 address <addr>/<len> | autoconfig', 'a bare command is incomplete');
  eq(s.run('ipv6 address 2001:db8:1::1/64').output[0],
    'IPv6 address 2001:db8:1::1/64 on Gi0/0 (already configured)', 'the same address twice is named');
  ok(/% Unexpected argument "extra"/.test(s.run('ipv6 address 2001:db8:1::5/64 extra').output[0]),
    'a trailing word is refused');
  ok(/% 2001:db8:1::1 is already configured on Gi0\/0/.test(
    (function () { s.run('interface Gi0/1'); return s.run('ipv6 address 2001:db8:1::1/64').output[0]; })()),
    'the same address on another port names the port that owns it');
  ok(/% 2001:db8:1::\/64 is already on Gi0\/0/.test(s.run('ipv6 address 2001:db8:1::7/64').output[0]),
    'a second port in one IPv6 subnet is refused as ambiguous');
  ok(/% 2001:db8:1::5 does not have a prefix/.test('') ||
    /Invalid prefix length/.test(s.run('ipv6 address 2001:db8:2::1/129').output[0]),
    'a prefix length above 128 is refused');
  ok(/Incomplete command: ipv6 address/.test(s.run('ipv6 address 2001:db8:2::1').output[0]),
    'the address without a length is incomplete');
  ok(/% ::1 is the loopback address/.test(s.run('ipv6 address ::1/128').output[0]),
    'the loopback address is refused by name');
  ok(/% ff02::1 is a multicast address/.test(s.run('ipv6 address ff02::1/64').output[0]),
    'a multicast address is refused by name');
  ok(/% fe80::1 is link-local/.test(s.run('ipv6 address fe80::1/64').output[0]),
    'a hand-typed link-local is refused, naming the one the port already has');
  // The consequence the multicast address had: a connected route for a group address.
  s.run('end');
  const table = s.run('show ipv6 route').output.join('\n');
  ok(!/C ff02::/.test(table), 'and no connected route is derived for a group address');
  // Replacing an address says so, because one global address per port is the model's limit.
  const replaced = s.run('configure terminal', 'interface Gi0/0',
    'ipv6 address 2001:db8:3::1/64').output;
  ok(/note: replaced 2001:db8:1::1\/64/.test(replaced.join('\n')),
    'replacing an address says what it replaced');
}

console.log('\nipv6 route and the ND verbs refuse words they do not use:');
{
  const env = pair();
  const s = env.s1;
  s.run('configure terminal');
  ok(/% Unexpected argument "250"/.test(s.run('ipv6 route 2001:db8:9::/64 2001:db8:1::2 250').output[0]),
    'a distance word is refused rather than dropped');
  ok(/% Unexpected argument "extra"/.test(s.run('ipv6 nd suppress-ra extra').output[0]),
    'suppress-ra with a trailing word is refused');
  ok(/% Unexpected argument "900"/.test(s.run('ipv6 nd ra lifetime 600 900').output[0]),
    'a second lifetime is refused');
  ok(/% Unexpected argument "extra"/.test(s.run('ipv6 nd ra enable extra').output[0]),
    'ra enable with a trailing word is refused');
}

console.log('\nA refused command does not change the operator\'s mode:');
{
  const env = pair();
  const s = env.s1;
  s.run('configure terminal', 'interface Gi0/0');
  eq(s.mode, 'iface', 'we are in an interface block');
  const refused = s.run('ipv6 nd suppress-ra extra').output;
  ok(/% Unrecognized interface command/.test(refused[0]), 'the command is refused');
  eq(s.mode, 'iface', 'and the interface block is kept, not silently left');
  // A command that really is global still leaves the block - and the note names a form that exists.
  const global = s.run('ipv6 nd ra enable').output;
  eq(s.mode, 'config', 'a genuine global command does leave the block');
  ok(global.some(function (l) { return /is a global command/.test(l); }),
    'and says so');
  ok(!/ip ipv6/.test(global.join(' ')),
    'without inventing a per-port form that does not exist');
}

console.log('\nshow ipv6 interface brief is a table, not a port name:');
{
  const env = pair();
  const brief = env.s1.run('show ipv6 interface brief').output;
  ok(brief.some(function (l) { return /^Interface\s+IP-Address\s+Status\s+Protocol/.test(l); }),
    'the brief table has its own header');
  ok(brief.some(function (l) { return /^Gi0\/0\s+2001:db8:1::1\/64\s+up\s+up/.test(l); }),
    'and the configured address, status and protocol');
  ok(brief.some(function (l) { return /^Gi0\/1\s+unassigned/.test(l); }),
    'a port with no IPv6 address says unassigned');
  const one = env.s1.run('show ipv6 interface brief Gi0/0').output;
  ok(one[0] === 'Interface Gi0/0 on R1:', 'a named port filters the table');
  // The state is the shared one, so shutting the port shows up here too.
  env.s1.run('configure terminal', 'interface Gi0/0', 'shutdown', 'exit', 'end');
  const shut = env.s1.run('show ipv6 interface brief').output
    .filter(function (l) { return /^Gi0\/0/.test(l); })[0].trim().split(/\s{2,}/);
  eq(shut[shut.length - 2] + '/' + shut[shut.length - 1], 'administratively down/down',
    'and a shut port reports the administrator state');
}

console.log('\ntraceroute over IPv6 is refused by name:');
{
  const env = pair();
  const out = env.s1.run('traceroute 2001:db8:1::2').output;
  ok(/% traceroute does not follow an IPv6 path in this model/.test(out[0]),
    'it does not read as a malformed address');
  ok(/ping 2001:db8:1::2/.test(out.join(' ')), 'and points at the command that does answer');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
