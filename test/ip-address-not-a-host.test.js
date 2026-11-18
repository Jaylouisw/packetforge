'use strict';
// An address that is a subnet's network or broadcast address is not a host address, and is refused (#1855).
//
// Under the mask it was typed with, the all-zeros host part names the subnet itself and the all-ones host part
// is its broadcast address. IOS refuses either one on a port, in the same one line, naming the prefix length and
// echoing what was typed:
//
//     Router(config-if)#ip address 192.168.1.255 255.255.255.0
//     Bad mask /24 for address 192.168.1.255
//     Router(config-if)#ip address 192.168.0.0 255.255.255.0
//     Bad mask /24 for address 192.168.0.0
//
//   * https://community.cisco.com/t5/switching/why-not-use-broadcast-subnet/td-p/2137545
//   * https://community.cisco.com/t5/switching/bad-mask/td-p/1972424
//   * https://learningnetwork.cisco.com/s/question/0D53i00000KsxldCAB/ip-address
//   * https://community.cisco.com/t5/switching/bad-mask-24/m-p/2128552
//
// One page prints the same sentence with a leading `%`; the unmarked form is the one four raw transcripts agree
// on, and the sibling refusal from the same parser ("Not a valid host address - 0.0.0.1") is unmarked too, so
// this console prints it unmarked. research/ip-address-not-a-host.md has the disagreement and the open cases.
//
// A /31 is the documented exception: RFC 3021 gives both of its addresses to the two ends of the link, and
// Cisco's own guide says so with `ip address 192.168.100.4 255.255.255.254` and `192.168.1.0 255.255.255.254`.
//
// The sibling sentence is a different rule and is pinned at the bottom of this file: an address in 0.0.0.0/8 or
// 127.0.0.0/8 is refused by name under any mask - `Not a valid host address - 0.0.0.1` - and the /32 exception
// does not reach it, because a loopback refuses 127/8 too. research/ip-address-host-range.md carries the
// sources for that half.
const path = require('path');
const { Topology, Simulator } = require('../engine');
const { CliSession } = require('../engine/cli');
const { loadCatalog } = require('../devices/registry');
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
      return l.indexOf(name + ' ') === 0;
    })[0] || '';
    return row.replace(/\s+/g, ' ').trim();
  };
  return { t: t, r1: r1, sim: sim, cli: cli, eth: eth, ipOf: ipOf, say: say, brief: brief };
}

console.log('The network address and the broadcast address are both refused, in the same line:');
{
  const env = lab();
  const a = env.eth[0].name;
  const net = env.say(a, '192.168.1.0', '255.255.255.0');
  ok(net.length === 1 && net[0] === 'Bad mask /24 for address 192.168.1.0',
    'the all-zeros address is the /24 network address', JSON.stringify(net));
  const bcast = env.say(a, '192.168.1.255', '255.255.255.0');
  ok(bcast.length === 1 && bcast[0] === 'Bad mask /24 for address 192.168.1.255',
    'the all-ones address is the /24 broadcast address', JSON.stringify(bcast));
  ok(env.ipOf(a) === null, 'and neither was applied to the port', String(env.ipOf(a)));
  ok(env.brief(a).indexOf('unassigned') !== -1 && env.brief(a).indexOf('unset') !== -1,
    '`show ip interface brief` still calls the port unassigned, method unset', env.brief(a));
  const run = env.cli.run('show running-config').output.join('\n');
  ok(run.indexOf('192.168.1.0') === -1 && run.indexOf('192.168.1.255') === -1,
    'and the refused lines never reach `show running-config`');
}

console.log('\nThe prefix length in the line is the mask that was typed, not the classful one:');
{
  const env = lab();
  const a = env.eth[0].name;
  const lo = env.say(a, '172.16.4.0', '255.255.252.0');
  ok(lo.length === 1 && lo[0] === 'Bad mask /22 for address 172.16.4.0',
    'a /22 network address prints /22', JSON.stringify(lo));
  const hi = env.say(a, '172.16.7.255', '255.255.252.0');
  ok(hi.length === 1 && hi[0] === 'Bad mask /22 for address 172.16.7.255',
    'and so does the /22 broadcast address', JSON.stringify(hi));
  const first = env.say(a, '172.16.4.1', '255.255.252.0');
  ok(first.join(' ').indexOf('172.16.4.1/22') !== -1 && env.ipOf(a) === '172.16.4.1/22',
    'the address inside the range is taken', JSON.stringify(first));
  const last = env.say(a, '172.16.7.254', '255.255.252.0');
  ok(last.join(' ').indexOf('172.16.7.254/22') !== -1,
    'and so is the last usable one', JSON.stringify(last));
}

console.log('\nThe mask may be typed as a prefix length, and the answer is the same:');
{
  const env = lab();
  const a = env.eth[0].name;
  const out = env.say(a, '10.0.0.0', '24');
  ok(out.length === 1 && out[0] === 'Bad mask /24 for address 10.0.0.0',
    '`ip address 10.0.0.0 24` prints the dotted-mask sentence', JSON.stringify(out));
}

console.log('\nA /30 keeps exactly two usable addresses:');
{
  const env = lab();
  const a = env.eth[0].name;
  ok(env.say(a, '10.1.1.0', '255.255.255.252')[0] === 'Bad mask /30 for address 10.1.1.0',
    '10.1.1.0/30 is the network address');
  ok(env.say(a, '10.1.1.3', '255.255.255.252')[0] === 'Bad mask /30 for address 10.1.1.3',
    '10.1.1.3/30 is the broadcast address');
  ok(env.say(a, '10.1.1.1', '255.255.255.252').join(' ').indexOf('10.1.1.1/30') !== -1,
    '10.1.1.1/30 is taken');
  ok(env.say(a, '10.1.1.2', '255.255.255.252').join(' ').indexOf('10.1.1.2/30') !== -1,
    '10.1.1.2/30 is taken');
}

console.log('\nA /31 is the exception RFC 3021 documents, and both addresses are host addresses:');
{
  const env = lab();
  const a = env.eth[0].name;
  const zero = env.say(a, '192.168.1.0', '255.255.255.254');
  ok(zero.join(' ').indexOf('192.168.1.0/31') !== -1 && env.ipOf(a) === '192.168.1.0/31',
    'the all-zeros address of a /31 is accepted', JSON.stringify(zero));
  // The other end of the link is another box: two ports of one router in the same /31 is an overlap, exactly
  // as two ports in the same /24 is, so the second address belongs on a second device.
  const t2 = new Topology();
  const r2 = t2.addDevice(ROUTER, 'r2');
  const sim2 = new Simulator(t2);
  const cli2 = new CliSession(r2, t2, sim2);
  cli2.run('enable');
  cli2.run('configure terminal');
  const b = [...r2.interfaces.values()].filter(function (i) { return i.type === 'ethernet'; })[0].name;
  const one = cli2.run('interface ' + b).output.concat(
    cli2.run('ip address 192.168.1.1 255.255.255.254').output);
  const got = r2.interfaces.get(b);
  ok(one.join(' ').indexOf('192.168.1.1/31') !== -1 && got.ip === '192.168.1.1' &&
    netLib.prefixOf(got.mask) === 31,
    'and the all-ones address of the same /31 is accepted on the other end', JSON.stringify(one));
}

console.log('\nA port that already holds an address keeps it when the next one is refused:');
{
  const env = lab();
  const a = env.eth[0].name;
  env.say(a, '10.9.9.1', '255.255.255.0');
  const out = env.say(a, '10.9.9.0', '255.255.255.0');
  ok(out.length === 1 && out[0] === 'Bad mask /24 for address 10.9.9.0', 'the refusal is one line',
    JSON.stringify(out));
  ok(env.ipOf(a) === '10.9.9.1/24', 'and the address it held is untouched', String(env.ipOf(a)));
}

console.log('\nA subinterface is refused the same way its parent is:');
{
  const env = lab();
  const a = env.eth[0].name;
  env.cli.run('interface ' + a + '.20');
  const out = env.cli.run('ip address 10.5.0.0 255.255.255.0').output;
  ok(out.length === 1 && out[0] === 'Bad mask /24 for address 10.5.0.0',
    'a network address on a dot1q subinterface is refused', JSON.stringify(out));
  const fine = env.cli.run('ip address 10.5.0.1 255.255.255.0').output;
  ok(fine.join(' ').indexOf('10.5.0.1/24') !== -1, 'and the host address beside it is taken',
    JSON.stringify(fine));
}

console.log('\nThe mask is still checked first, and says so in its own words:');
{
  const env = lab();
  const a = env.eth[0].name;
  const out = env.say(a, '10.0.0.0', '255.0.255.0');
  ok(out.length === 1 && out[0].indexOf('% Invalid mask: 255.0.255.0') === 0,
    'a non-contiguous mask is a mask error, not a host-address error', JSON.stringify(out));
}

console.log('\nA /32 is refused on a port: the mask names a subnet with no host space, and a box says so:');
{
  const env = lab();
  const a = env.eth[0].name;
  env.say(a, '10.20.20.1', '255.255.255.0');
  const out = env.say(a, '10.20.20.1', '255.255.255.255');
  ok(out.length === 1 && out[0] === 'Bad mask /32 for address 10.20.20.1',
    'the refusal is one line, in the same words as the network-address refusal', JSON.stringify(out));
  ok(env.ipOf(a) === '10.20.20.1/24', 'and the address the port held is untouched', String(env.ipOf(a)));
  const bare = env.say(a, '10.20.20.1', '32');
  ok(bare.length === 1 && bare[0] === 'Bad mask /32 for address 10.20.20.1',
    'the prefix typed bare is refused with the prefix, not the dotted mask', JSON.stringify(bare));
  const cfg = env.cli.run('show running-config').output.join('\n');
  ok(cfg.indexOf('/32') === -1, 'and `show running-config` never carries the refused line');
}

console.log('\nA one-bit-longer mask is still a host address, so the rule stops exactly at /32:');
{
  const env = lab();
  const a = env.eth[0].name;
  const out = env.say(a, '10.21.21.2', '255.255.255.254');
  ok(out.join(' ').indexOf('10.21.21.2/31') !== -1, 'a /31 host address is still taken',
    JSON.stringify(out));
}

console.log('\nA subinterface is refused the same way its parent is:');
{
  const env = lab();
  const a = env.eth[0].name;
  env.cli.run('interface ' + a + '.30');
  const out = env.cli.run('ip address 10.30.30.1 255.255.255.255').output;
  ok(out.length === 1 && out[0] === 'Bad mask /32 for address 10.30.30.1',
    'a /32 on a dot1q subinterface is refused', JSON.stringify(out));
}
console.log('\nAn address in 0.0.0.0/8 is not a host address, and the box names it instead of a prefix:');
{
  const env = lab();
  const a = env.eth[0].name;
  const one = env.say(a, '0.0.0.1', '255.255.255.0');
  ok(one.length === 1 && one[0] === 'Not a valid host address - 0.0.0.1',
    '`ip add 0.0.0.1 255.255.255.0` answers in the vendor\'s own sentence', JSON.stringify(one));
  const two = env.say(a, '0.0.0.2', '255.255.255.0');
  ok(two.length === 1 && two[0] === 'Not a valid host address - 0.0.0.2',
    'each refusal echoes the address that was typed', JSON.stringify(two));
  ok(env.ipOf(a) === null, 'and neither was applied to the port', String(env.ipOf(a)));
  ok(env.brief(a).indexOf('unassigned') !== -1 && env.brief(a).indexOf('unset') !== -1,
    '`show ip interface brief` still calls the port unassigned, method unset', env.brief(a));
  const cfg = env.cli.run('show running-config').output.join('\n');
  ok(cfg.indexOf('0.0.0.1') === -1 && cfg.indexOf('0.0.0.2') === -1,
    'and neither line reaches `show running-config`');
}

console.log('\nThe whole 0.0.0.0/8 block, not just its first /24, and the next block along is ordinary:');
{
  const env = lab();
  const a = env.eth[0].name;
  const far = env.say(a, '0.255.255.254', '255.255.255.0');
  ok(far.length === 1 && far[0] === 'Not a valid host address - 0.255.255.254',
    'the last usable address of the block is refused too', JSON.stringify(far));
  const next = env.say(a, '1.0.0.1', '255.255.255.0');
  ok(next.join(' ').indexOf('1.0.0.1/24') !== -1 && env.ipOf(a) === '1.0.0.1/24',
    'while 1.0.0.1, one block along, is taken', JSON.stringify(next));
}

console.log('\n127.0.0.0/8 is refused the same way, and the loopback transcript is why it outranks a /32:');
{
  const env = lab();
  const a = env.eth[0].name;
  const host = env.say(a, '127.0.0.2', '255.255.255.0');
  ok(host.length === 1 && host[0] === 'Not a valid host address - 127.0.0.2',
    '`ip address 127.0.0.2 255.255.255.0` is refused by name', JSON.stringify(host));
  const wide = env.say(a, '127.1.1.1', '255.255.255.0');
  ok(wide.length === 1 && wide[0] === 'Not a valid host address - 127.1.1.1',
    'and so is an address far from 127.0.0.x, which is what makes it a block rather than a subnet',
    JSON.stringify(wide));
  const sixteen = env.say(a, '127.0.0.100', '255.255.0.0');
  ok(sixteen.length === 1 && sixteen[0] === 'Not a valid host address - 127.0.0.100',
    'a /16 under the same block prints no prefix either', JSON.stringify(sixteen));
  const thirtytwo = env.say(a, '127.0.0.1', '255.255.255.255');
  ok(thirtytwo.length === 1 && thirtytwo[0] === 'Not a valid host address - 127.0.0.1',
    'the address sentence wins over `Bad mask /32`: the range is asked first', JSON.stringify(thirtytwo));
}

console.log('\nA port that already holds an address keeps it when the range refusal comes back:');
{
  const env = lab();
  const a = env.eth[0].name;
  env.say(a, '10.9.9.1', '255.255.255.0');
  const out = env.say(a, '127.0.0.9', '255.255.255.0');
  ok(out.length === 1 && out[0] === 'Not a valid host address - 127.0.0.9', 'the refusal is one line',
    JSON.stringify(out));
  ok(env.ipOf(a) === '10.9.9.1/24', 'and the address it held is untouched', String(env.ipOf(a)));
}

console.log('\nA subinterface is refused the same way its parent is:');
{
  const env = lab();
  const a = env.eth[0].name;
  env.cli.run('interface ' + a + '.40');
  const out = env.cli.run('ip address 0.0.0.5 255.255.255.0').output;
  ok(out.length === 1 && out[0] === 'Not a valid host address - 0.0.0.5',
    'a reserved-block address on a dot1q subinterface is refused', JSON.stringify(out));
}

console.log('\nThe mask is still checked before the range, in its own words:');
{
  const env = lab();
  const a = env.eth[0].name;
  const out = env.say(a, '0.0.0.1', '255.0.255.0');
  ok(out.length === 1 && out[0].indexOf('% Invalid mask: 255.0.255.0') === 0,
    'a non-contiguous mask is a mask error, whichever block the address is in', JSON.stringify(out));
}

console.log('\nThe one command this rule steps around, still open: 0.0.0.0 with a /0 mask');
{
  const env = lab();
  const a = env.eth[0].name;
  const out = env.say(a, '0.0.0.0', '0.0.0.0');
  ok(out.join(' ').indexOf('0.0.0.0/0') !== -1,
    'nothing in hand says what a box prints for it, so the range rule does not decide it',
    JSON.stringify(out));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
