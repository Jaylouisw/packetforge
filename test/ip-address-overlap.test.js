'use strict';
// A second primary address in a subnet this box already holds is refused, in the vendor's one line (#1758).
//
// A router keeps one connected route per subnet. Two interfaces in the same subnet would mean two next hops
// for one connected route, so IOS refuses the command and names the interface it collided with:
//
//     R4(config-if)#ip address 192.168.254.32 255.255.255.192
//     % 192.168.254.0 overlaps with FastEthernet0/0
//
// The number is the *attempted* network under the *attempted* mask, and nothing is applied: the same transcript
// runs `show ip int bri` afterwards and the second port is still `unassigned`.
//
//   * https://learningnetwork.cisco.com/s/question/0D53i00000Kt12sCAB/can-one-subnet-be-on-opposite-sides-of-a-router
//   * https://learningnetwork.cisco.com/s/question/0D53i00000Ksv3lCAB/two-interfaces-on-the-same-subnet
//     (`% 10.1.0.0 overlaps with GigabitEthernet0/0` for `10.1.1.2 255.255.0.0` beside `10.1.1.1 255.255.0.0`)
//   * https://learningnetwork.cisco.com/s/question/0D53i00000KsxMfCAJ/subinterfaces
//     (`% 192.168.1.0 overlaps with GigabitEthernet0/1.10` - a subinterface collides like any other port)
//
// This console took the address and wrote it down, so a lab could hold two ports in one subnet and two
// connected routes printed in `show ip route` for a network a router has only one wire for.
const path = require('path');
const { Topology, Simulator } = require('../engine');
const { CliSession } = require('../engine/cli');
const { loadCatalog } = require('../devices/registry');
const { displayName } = require('../engine/iface-name');
const netLib = require('../engine/net');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices')).filter(function (s) { return !s.error; });
const ROUTER = catalog.filter(function (s) { return /ASR 1001-X/.test(s.model); })[0];

function lab() {
  const t = new Topology();
  const r1 = t.addDevice(ROUTER, 'r1');
  const sim = new Simulator(t);
  const cli = new CliSession(r1, t, sim);
  cli.run('enable');
  cli.run('configure terminal');
  const eth = [...r1.interfaces.values()].filter(function (i) { return i.type === 'ethernet'; });
  const ipOf = function (name) {
    const i = r1.interfaces.get(name);
    return i.ip ? i.ip + '/' + netLib.prefixOf(i.mask) : null;
  };
  const say = function (iface, address, mask) {
    return cli.run('interface ' + iface).output.concat(
      cli.run('ip address ' + address + ' ' + mask).output.concat(cli.run('exit').output));
  };
  const brief = function (name) {
    const row = cli.run('show ip interface brief').output.filter(function (l) {
      return l.indexOf(displayName(name) + ' ') === 0;
    })[0] || '';
    return row.replace(/\s+/g, ' ').trim();
  };
  return { t: t, r1: r1, sim: sim, cli: cli, eth: eth, ipOf: ipOf, say: say, brief: brief };
}

console.log('The vendor refuses the second subnet, and nothing is applied:');
{
  const env = lab();
  const a = env.eth[0].name, b = env.eth[1].name;
  const first = env.say(a, '192.168.254.1', '255.255.255.192');
  ok(first.join(' ').indexOf('192.168.254.1/26') !== -1, 'the first port takes the address',
    JSON.stringify(first));
  const out = env.say(b, '192.168.254.32', '255.255.255.192');
  ok(out.length === 1 && out[0] === '% 192.168.254.0 overlaps with ' + a,
    'the refusal is one line, naming the incumbent and the attempted network', JSON.stringify(out));
  ok(env.ipOf(b) === null, 'the second port holds no address', String(env.ipOf(b)));
  ok(/unassigned .*unset/.test(env.brief(b)), 'and `show ip interface brief` still says unassigned/unset',
    env.brief(b));
  ok(env.cli.run('show running-config').output.filter(function (l) {
    return /ip address 192\.168\.254\.32/.test(l);
  }).length === 0, 'the refused address never reaches the running-config');
  ok(env.ipOf(a) === '192.168.254.1/26', 'the incumbent is untouched');
}

console.log('\nOverlap is asked of the two ranges, not of "the same subnet":');
{
  const env = lab();
  const a = env.eth[0].name, b = env.eth[1].name;
  env.say(a, '10.1.1.1', '255.255.0.0');
  let out = env.say(b, '10.1.2.1', '255.255.255.0');
  ok(out[0] === '% 10.1.2.0 overlaps with ' + a,
    'a narrower address inside a wider one is refused, and the message carries the narrower network',
    JSON.stringify(out));
  const env2 = lab();
  const c = env2.eth[0].name, d = env2.eth[1].name;
  env2.say(c, '172.16.5.1', '255.255.255.0');
  const out2 = env2.say(d, '172.16.0.1', '255.255.0.0');
  ok(out2[0] === '% 172.16.0.0 overlaps with ' + c,
    'a wider address that swallows an existing one is refused too', JSON.stringify(out2));
}

console.log('\nAdjacent subnets, the same port, and a second box are all allowed:');
{
  const env = lab();
  const a = env.eth[0].name, b = env.eth[1].name;
  env.say(a, '192.168.254.1', '255.255.255.128');
  const out = env.say(b, '192.168.254.129', '255.255.255.128');
  ok(out.join(' ').indexOf('overlaps') === -1 && env.ipOf(b) === '192.168.254.129/25',
    'the two halves of a /24 do not overlap', JSON.stringify(out));
  const same = env.say(a, '192.168.254.2', '255.255.255.128');
  ok(same.join(' ').indexOf('overlaps') === -1 && env.ipOf(a) === '192.168.254.2/25',
    'the same port may be re-addressed', JSON.stringify(same));
  const t2 = new Topology();
  const r1 = t2.addDevice(ROUTER, 'r1');
  const r2 = t2.addDevice(ROUTER, 'r2');
  const s2 = new Simulator(t2);
  const c1 = new CliSession(r1, t2, s2), c2 = new CliSession(r2, t2, s2);
  [c1, c2].forEach(function (c) { c.run('enable'); c.run('configure terminal'); });
  const p1 = [...r1.interfaces.values()].filter(function (i) { return i.type === 'ethernet'; })[0].name;
  const p2 = [...r2.interfaces.values()].filter(function (i) { return i.type === 'ethernet'; })[0].name;
  const saw = function (c, name, ip) {
    c.run('interface ' + name);
    const o = c.run('ip address ' + ip + ' 255.255.255.0').output;
    c.run('exit');
    return o;
  };
  saw(c1, p1, '10.9.9.1');
  const two = saw(c2, p2, '10.9.9.2');
  ok(two.join(' ').indexOf('overlaps') === -1,
    'the other end of the wire is another box, and it takes the subnet', JSON.stringify(two));
}

console.log('\nThe subnet is freed by the command that frees the address:');
{
  const env = lab();
  const a = env.eth[0].name, b = env.eth[1].name;
  env.say(a, '10.0.7.1', '255.255.255.0');
  env.cli.run('interface ' + a);
  env.cli.run('no ip address');
  env.cli.run('exit');
  const out = env.say(b, '10.0.7.2', '255.255.255.0');
  ok(out.join(' ').indexOf('overlaps') === -1 && env.ipOf(b) === '10.0.7.2/24',
    'after `no ip address` the subnet is nobody\'s', JSON.stringify(out));
}

console.log('\nA subinterface collides exactly like a port:');
{
  const env = lab();
  const a = env.eth[0].name;
  env.say(a, '10.5.0.1', '255.255.255.0');
  const made = env.cli.run('interface ' + a + '.20').output;
  ok(made.join(' ').indexOf('.20') !== -1, 'a subinterface is created', JSON.stringify(made));
  const out = env.cli.run('ip address 10.5.0.2 255.255.255.0').output;
  ok(out.length === 1 && out[0] === '% 10.5.0.0 overlaps with ' + a,
    'and refuses an address in the parent\'s subnet, naming the parent', JSON.stringify(out));
}


console.log('\n' + 'A shut port takes an overlapping address, and `no shutdown` is where it is refused:');
{
  // The rule is about the routing table, not about the typing: a port that is administratively down
  // installs no connected route, so its address collides with nothing. Opening it is what puts the
  // address into the table, so that is where the box refuses - in the same one line, leaving the port
  // shut. Evidence, and the limit of it, in research/ip-address-overlap.md.
  //
  //   https://www.connecteddots.online/resources/cisco/network-overlaps-with-GigabitEthernet
  const env = lab();
  const a = env.eth[0].name, b = env.eth[1].name;
  const shut = function (name) {
    env.cli.run('interface ' + name);
    const o = env.cli.run('shutdown').output;
    env.cli.run('exit');
    return o;
  };
  const open = function (name) {
    env.cli.run('interface ' + name);
    const o = env.cli.run('no shutdown').output;
    env.cli.run('exit');
    return o;
  };
  env.say(a, '172.20.100.1', '255.255.254.0');
  shut(b);
  const typed = env.say(b, '172.20.101.1', '255.255.255.0');
  ok(typed.join(' ').indexOf('overlaps') === -1 && env.ipOf(b) === '172.20.101.1/24',
    'a port that is shut accepts the address in silence', JSON.stringify(typed));
  ok(env.cli.run('show ip route').output.filter(function (l) {
    return /172.20.101.0/.test(l);
  }).length === 0, 'and its subnet is in no connected route while it is shut',
    env.cli.run('show ip route').output.join(' | '));
  const refused = open(b);
  ok(refused.length === 1 && refused[0] === '% 172.20.101.0 overlaps with ' + a,
    '`no shutdown` is refused in the same one line the box uses at address entry, naming the live port', JSON.stringify(refused));
  ok(env.r1.interfaces.get(b).enabled === false && /administratively down/.test(env.brief(b)),
    'and the port stays administratively down', env.brief(b));
  // The other half of the same fact: a shut port does not reserve its subnet either.
  shut(a);
  const allowed = open(b);
  ok(allowed.length === 1 && allowed[0] === b + ' up',
    'once the incumbent is shut, the same port opens with the address it already held',
    JSON.stringify(allowed));
}

console.log('\n' + 'A shut incumbent does not block an address on a live port:');
{
  const env = lab();
  const a = env.eth[0].name, b = env.eth[1].name;
  env.say(a, '10.4.0.1', '255.255.255.0');
  env.cli.run('interface ' + a); env.cli.run('shutdown'); env.cli.run('exit');
  const out = env.say(b, '10.4.0.2', '255.255.255.0');
  ok(out.join(' ').indexOf('overlaps') === -1 && env.ipOf(b) === '10.4.0.2/24',
    'a shut port holds no connected route, so the subnet is free', JSON.stringify(out));
}

console.log('\n' + 'A subinterface on a shut parent reserves nothing:');
{
  const env = lab();
  const a = env.eth[0].name, b = env.eth[1].name;
  env.cli.run('interface ' + a + '.30');
  env.cli.run('ip address 10.5.30.1 255.255.255.0');
  env.cli.run('exit');
  env.cli.run('interface ' + a); env.cli.run('shutdown'); env.cli.run('exit');
  const out = env.say(b, '10.5.30.2', '255.255.255.0');
  ok(out.join(' ').indexOf('overlaps') === -1 && env.ipOf(b) === '10.5.30.2/24',
    'its route goes out through the parent, so a shut parent frees the subnet', JSON.stringify(out));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
