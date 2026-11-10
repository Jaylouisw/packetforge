'use strict';
// static-route.test.js - `ip route` accepted four words without checking any of them, and a typo in
// the first one bricked the router's data path.
//
// Measured before this pass, on a `generic-router` named R1:
//   ip route abc 255.0.0.0 1.1.1.1      -> "Route added: abc/8 via 1.1.1.1"
//   ...and from then on routeTo('10.0.0.5') threw `Invalid IPv4 address: abc`, so every ping,
//   traceroute and flow on that router failed with `% Error: Invalid IPv4 address: abc` - a message
//   about a word typed three commands earlier, surfacing in a different command.
//   ip route 10.0.0.0 255.255.255.0 abc        -> "Route added: 10.0.0.0/24 via abc"
//   ip route 10.0.0.0 255.255.255.0 1.1.1.1 250 -> stored `250` as an interface name
//   ip route 10.0.0.0 255.255.255.0             -> "via on-link": listed in `show ip route`, and 0/4
//   ip route 10.0.0.0 255.255.255.0 Gi0/0       -> listed with an interface, and 0/4
//   no ip route 10.0.0.0 255.255.255.0          -> "Route removed" for a route never configured
//   ip default-gateway abc                      -> "Default gateway: abc"
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

const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
const ROUTER = catalog.find(function (s) { return s.model === 'generic-router'; });
const PC = catalog.find(function (s) { return s.model === 'generic-pc'; });

// R1 --- R2 --- PC2, with R2 routing for PC2's subnet. This is the lab every claim below is measured
// in, so "the route works" means a ping that came back, not a row in a table.
function lab() {
  const t = new Topology();
  const r1 = t.addDevice(ROUTER); r1.name = 'R1';
  const r2 = t.addDevice(ROUTER); r2.name = 'R2';
  const pc = t.addDevice(PC); pc.name = 'PC2';
  t.connect(r1.id, 'Gi0/0', r2.id, 'Gi0/0');
  t.connect(r2.id, 'Gi0/1', pc.id, 'eth0');
  const sim = new Simulator(t);
  const cfg = function (dev, cmds) {
    const s = new CliSession(dev, t, sim);
    s.run('enable'); s.run('configure terminal');
    for (const cmd of cmds) s.run(cmd);
    s.run('end');
    return s;
  };
  cfg(r1, ['interface Gi0/0', 'ip address 10.0.0.1 255.255.255.252', 'exit']);
  cfg(r2, ['interface Gi0/0', 'ip address 10.0.0.2 255.255.255.252', 'exit',
    'interface Gi0/1', 'ip address 192.168.2.1 255.255.255.0', 'exit']);
  cfg(pc, ['interface eth0', 'ip address 192.168.2.10 255.255.255.0', 'exit',
    'ip default-gateway 192.168.2.1']);
  return { t: t, r1: r1, r2: r2, pc: pc, sim: sim, cfg: cfg };
}
function console_(env, dev) {
  const s = new CliSession(dev || env.r1, env.t, env.sim);
  s.run('enable');
  return s;
}
function rate(s, dst) {
  const m = /Success rate is (\d+) percent/.exec(s.run('ping ' + dst + ' count 4').output.join(' '));
  return m ? Number(m[1]) : null;
}

console.log('\nA destination network is an address:');
{
  const env = lab();
  const s = console_(env);
  s.run('configure terminal');
  const cases = [
    [['ip route abc 255.0.0.0 1.1.1.1'],
      '% "abc" is not an IPv4 address, so it cannot be a destination network'],
    [['ip route 10.0.0.999 255.255.255.0 1.1.1.1'],
      '% "10.0.0.999" is not an IPv4 address, so it cannot be a destination network'],
    [['ip route 10.0.0.0 abc 1.1.1.1'],
      '% "abc" is not a subnet mask (e.g. 255.255.255.0)'],
    [['ip route 10.0.0.0'], '% Incomplete command: ip route <network> <mask> <next-hop> [<interface>]']
  ];
  for (const [cmds, want] of cases) eq(s.run(cmds[0]).output[0], want, cmds[0] + ' is refused');
  eq(env.r1.config.routes.length, 0, 'and none of them reached the routing table');
  // The whole point of refusing them: a refused word cannot poison a later lookup.
  ok(env.r1.routeTo('10.0.0.5') !== undefined, 'routeTo() still answers after the refusals');
  s.run('end');
  eq(rate(s, '192.168.2.10'), 0, 'and the lab is unchanged - R1 still has no route to PC2');
}

console.log('\nA next hop is an address, and the fourth word is an interface or nothing:');
{
  const env = lab();
  const s = console_(env);
  s.run('configure terminal');
  eq(s.run('ip route 192.168.2.0 255.255.255.0 abc').output[0],
    '% "abc" is neither an IPv4 next hop nor an interface on R1',
    'a word that is neither an address nor an interface is refused by name');
  const listed = s.run('ip route 192.168.2.0 255.255.255.0 abc').output.join('\n');
  ok(/Interfaces: Gi0\/0/.test(listed), 'and the refusal lists the interfaces that do exist');

  const distance = s.run('ip route 192.168.2.0 255.255.255.0 10.0.0.2 250').output.join('\n');
  ok(/is not an interface on R1/.test(distance), 'a numeric fourth word is refused as an interface');
  ok(/no per-route administrative distance/.test(distance),
    'and says why a distance cannot be used here, instead of looking like a typo');

  eq(s.run('ip route 192.168.2.0 255.255.255.0 10.0.0.2 Gi9/9').output[0],
    '% "Gi9/9" is not an interface on R1', 'an interface that does not exist is refused');

  const noHop = s.run('ip route 192.168.2.0 255.255.255.0').output;
  eq(noHop[0], '% Incomplete command: ip route <network> <mask> <next-hop> [<interface>]',
    'a route with no next hop is incomplete');
  ok(/needs a next hop/.test(noHop.join('\n')), 'and says a static route needs one');

  const ifaceOnly = s.run('ip route 192.168.2.0 255.255.255.0 Gi0/0').output.join('\n');
  ok(/is an interface, not a next hop/.test(ifaceOnly),
    'the interface-only form is refused by name, not installed');
  ok(/would forward nothing here/.test(ifaceOnly),
    'and says it is an IOS form that would forward nothing in this model');
  eq(env.r1.config.routes.length, 0, 'so nothing was stored');
  s.run('end');
  eq(rate(s, '192.168.2.10'), 0, 'and the table that would have shown a dead route does not exist');
}

console.log('\nA valid route forwards, and the table says the same thing the console said:');
{
  const env = lab();
  const s = console_(env);
  s.run('configure terminal');
  eq(s.run('ip route 192.168.2.0 255.255.255.0 10.0.0.2').output[0],
    'Route added: 192.168.2.0/24 via 10.0.0.2', 'the route is added');
  s.run('end');
  eq(rate(s, '192.168.2.10'), 100, 'and four pings to the host behind R2 come back');
  const table = s.run('show ip route').output.join('\n');
  ok(/S 192\.168\.2\.0\/24\s+1\s+10\.0\.0\.2/.test(table), 'show ip route shows it as a static route');
  const running = s.run('show running-config').output.filter(function (l) { return /^ip route/.test(l); });
  eq(running.join('|'), 'ip route 192.168.2.0 255.255.255.0 10.0.0.2',
    'running-config carries the same line, for a startup-config round trip');
  // The lookup and the console must agree about the next hop.
  const route = env.r1.routeTo('192.168.2.10');
  eq(route && route.via, '10.0.0.2', 'and routeTo() resolves through the configured next hop');
  eq(route && route.type, 'static', 'as a static route');

  // Gateway plus interface: both are named, both are kept, and the line round-trips with one space.
  s.run('configure terminal');
  eq(s.run('ip route 172.16.0.0 255.255.0.0 10.0.0.2 Gi0/0').output[0],
    'Route added: 172.16.0.0/16 via 10.0.0.2', 'an interface may be named alongside the next hop');
  s.run('end');
  const two = s.run('show running-config').output.filter(function (l) { return /^ip route 172/.test(l); });
  eq(two.join('|'), 'ip route 172.16.0.0 255.255.0.0 10.0.0.2 Gi0/0',
    'and the line round-trips with the interface and no doubled space');
  eq(env.r1.routeTo('172.16.5.5').iface, 'Gi0/0', 'routeTo() keeps the interface');

  // Removal says which route it removed, and the data path notices.
  s.run('configure terminal');
  eq(s.run('no ip route 192.168.2.0 255.255.255.0').output[0],
    'Route removed: 192.168.2.0/24', 'removal names the route it removed');
  s.run('end');
  eq(rate(s, '192.168.2.10'), 0, 'and the pings stop - the row and the data path are the same route');
}

console.log('\nRemoving a route that is not there is not a success:');
{
  const env = lab();
  const s = console_(env);
  s.run('configure terminal');
  const missing = s.run('no ip route 10.9.9.0 255.255.255.0').output;
  eq(missing[0], '% No route to 10.9.9.0/24 is configured',
    'removing a route that was never added is refused');
  ok(/no static routes/.test(missing.join('\n')), 'and the refusal says what is configured');
  s.run('ip route 10.9.9.0 255.255.255.0 10.0.0.2');
  ok(/No route to 10\.9\.9\.0\/24 via 10\.0\.0\.9/.test(
    s.run('no ip route 10.9.9.0 255.255.255.0 10.0.0.9').output.join('\n')),
    'a removal whose next hop does not match is refused');
  eq(env.r1.config.routes.length, 1, 'and the route it did not match survives');
  eq(s.run('no ip route 10.9.9.0 255.255.255.0 10.0.0.2').output[0],
    'Route removed: 10.9.9.0/24 via 10.0.0.2', 'while the matching removal works');
  eq(s.run('no ip route abc 255.255.255.0').output[0], '% "abc" is not an IPv4 address',
    'and a non-address cannot be used to remove anything');
}

console.log('\nThe default gateway is an address too:');
{
  // `ip default-gateway` is a host command, so it is measured on the PC in the same lab.
  const env = lab();
  const s = console_(env, env.pc);
  s.run('configure terminal');
  eq(s.run('ip default-gateway 192.168.2.1').output[0], 'Default gateway: 192.168.2.1',
    'a real address is accepted');
  eq(env.pc.config.defaultGateway, '192.168.2.1', 'and stored as typed');
  eq(s.run('ip default-gateway abc').output[0],
    '% "abc" is not an IPv4 address, so it cannot be a default gateway',
    'a word is refused by name');
  eq(env.pc.config.defaultGateway, '192.168.2.1', 'and the previous gateway is untouched');
  eq(s.run('ip default-gateway 192.168.2.999').output[0],
    '% "192.168.2.999" is not an IPv4 address, so it cannot be a default gateway',
    'an address-shaped word is refused too, because isIp() parses rather than pattern-matches');
  eq(s.run('ip default-gateway').output[0], '% Incomplete command: ip default-gateway <address>',
    'and a bare command is incomplete, not a silent clear');
  eq(env.pc.config.defaultGateway, '192.168.2.1', 'with the gateway still in place');
}

console.log('\nThe neighbours that quoted an empty or placeholder value:');
{
  const env = lab();
  const s = console_(env);
  s.run('configure terminal');
  eq(s.run('ipv6 route 2001:db8:1::/64').output[0],
    '% Incomplete command: ipv6 route <prefix> <next-hop>',
    'ipv6 route with no next hop no longer quotes an empty string');
  eq(s.run('ipv6 route 2001:db8:1::/64 banana').output[0], '% Invalid IPv6 next hop "banana"',
    'and a bad next hop still names it');
  eq(s.run('ipv6 route 2001:db8:1::/64 2001:db8::1').output[0],
    'IPv6 route 2001:db8:1::/64 via 2001:db8::1', 'while a real one is added');

  s.run('interface Gi0/0');
  eq(s.run('vrrp 1 ip').output[0], '% Incomplete command: vrrp <vrid> ip <address>',
    'vrrp <vrid> ip with no address is incomplete, not "% Invalid address: (none)"');
  eq(s.run('vrrp 1 ip banana').output[0], '% Invalid address: banana', 'a bad address is named');

  s.run('interface Gi0/1.10');
  eq(s.run('encapsulation dot1q').output[0], '% Incomplete command: encapsulation dot1q <vlan-id>',
    'encapsulation dot1q with no VLAN is incomplete, not "VLAN out of range: "');
  eq(s.run('encapsulation dot1q abc').output[0], '% VLAN id must be a number, not "abc"',
    'a word is "not a number", not out of range');
  eq(s.run('encapsulation dot1q 9999').output[0], '% VLAN 9999 is outside 1-4094',
    'and a number outside the range says so');
  eq(s.run('encapsulation dot1q 10 extra').output[0],
    '% Unexpected argument "extra" - encapsulation dot1q <vlan-id> takes no more',
    'a trailing word is refused');
  eq(s.run('encapsulation dot1q 10').output[0], 'Subinterface Gi0/1.10 encapsulation dot1q 10',
    'while a real VLAN is accepted');
  s.run('end');
  eq(s.run('show running-config').output.filter(function (l) { return /encapsulation/.test(l); }).length,
    1, 'and running-config carries it once');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
