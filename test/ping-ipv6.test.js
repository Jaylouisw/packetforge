'use strict';
// The console answered a literal IPv6 address with a DNS failure (#1461).
//
//   p> ping 2001:db8:1::1
//   % Could not resolve "2001:db8:1::1": SERVFAIL - no device in this lab hosts a DNS zone, or no listed server
//     answered
//   % Nothing was sent. Check the zone on none, or the name servers this device asks.
//
// The address check before the resolver was IPv4-only (`net.ipToInt`), so every literal IPv6 address fell through to
// the name path. Meanwhile the engine has had an IPv6 echo path all along - `Simulator.ping6()` sends ICMPv6 echo
// requests, runs neighbour discovery, and models the same latency as IPv4 - and the console could not reach it at
// all. A v6 lab could be built, addressed, routed and announced, and then not pinged.
const path = require('path');
const { Topology, Simulator } = require('../engine');
const { CliSession } = require('../engine/cli');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const ROOT = path.join(__dirname, '..');
const catalog = loadCatalog(path.join(ROOT, 'devices')).filter(function (s) { return !s.error; });
const ROUTER = catalog.find(function (s) { return s.model === 'generic-router'; });
const SWITCH = catalog.find(function (s) { return s.model === 'generic-switch'; });
const PC = catalog.find(function (s) { return s.model === 'generic-pc'; });

const V6_ROUTER = '2001:db8:1::1';
const V6_HOST = '2001:db8:1::10';
const V4_ROUTER = '10.0.0.1';

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
  cfg('r1', ['interface Gi0/0', 'ipv6 address ' + V6_ROUTER + '/64', 'ip address ' + V4_ROUTER + ' 255.255.255.0']);
  cfg('p', ['interface eth0', 'ipv6 address ' + V6_HOST + '/64', 'ip address 10.0.0.10 255.255.255.0']);
  cfg('p', ['ipv6 gateway ' + V6_ROUTER, 'ip default-gateway ' + V4_ROUTER]);
  return {
    t: t, sim: sim, cli: cli, cfg: cfg,
    run: function (cmd) { return cli('p').run(cmd).output; },
    joined: function (cmd) { return cli('p').run(cmd).output.join('\n'); }
  };
}

console.log('');
console.log('A literal IPv6 address is an address:');
{
  const L = lab();
  const before = L.sim.events.length;
  const out = L.run('ping ' + V6_ROUTER);
  const text = out.join('\n');
  ok(/Sending 4, 100-byte ICMP Echos to 2001:db8:1::1/.test(text), 'it is echoed, not resolved', text.split('\n')[1]);
  ok(/!!!!/.test(text), 'all four replies arrive', text);
  ok(/Success rate is 100 percent \(4\/4\)/.test(text), 'and the rate says so', text);
  ok(/Reply from 2001:db8:1::1: bytes=100 time=/.test(text), 'each reply names the address', text);
  ok(text.indexOf('Could not resolve') === -1, 'no resolver was asked', text);
  ok(text.indexOf('SERVFAIL') === -1, 'and no DNS status is reported about an address', text);

  const events = L.sim.events.slice(before);
  ok(events.some(function (e) { return e.type === 'icmp6-echo'; }),
    'an ICMPv6 echo request actually crossed the wire', JSON.stringify(events.map(function (e) { return e.type; }).slice(0, 12)));
  ok(events.some(function (e) { return e.type === 'icmp6-received'; }), 'and an ICMPv6 reply came back', '');
  ok(events.some(function (e) { return e.type === 'nd-request' || e.type === 'nd-advert'; }),
    'neighbour discovery ran for it', '');
  ok(!events.some(function (e) { return e.type === 'dns'; }), 'while nothing consulted DNS', '');
}

console.log('');
console.log('One report for both families:');
{
  const L = lab();
  const v6 = L.run('ping ' + V6_ROUTER);
  const v4 = L.run('ping ' + V4_ROUTER);
  const shape = function (lines) {
    return lines.slice(0, 4).map(function (l) {
      return l.replace(/[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+|2001:[0-9a-f:]+/g, 'ADDR')
        .replace(/\d+/g, 'N').replace(/[.!]+/, 'MARKS');
    }).join('|');
  };
  ok(shape(v6) === shape(v4), 'the first four lines have the same shape', shape(v6) + '  vs  ' + shape(v4));
  ok(/^Reply from 2001:db8:1::1: bytes=100 time=/m.test(v6.join('\n')), 'the v6 reply line has the v4 format', '');
  ok(/^Reply from 10\.0\.0\.1: bytes=100 time=/m.test(v4.join('\n')), 'and the v4 line is unchanged', '');
}

console.log('');
console.log('The count and the instant mean the same thing:');
{
  const L = lab();
  ok(/Sending 2,/.test(L.joined('ping ' + V6_ROUTER + ' 2')) && /\(2\/2\)/.test(L.joined('ping ' + V6_ROUTER + ' 2')),
    'a count of 2 sends two', L.joined('ping ' + V6_ROUTER + ' 2'));
  ok(/% Count must be a whole number from 1 to 50/.test(L.joined('ping ' + V6_ROUTER + ' 0')),
    'a count of 0 is refused', L.joined('ping ' + V6_ROUTER + ' 0'));
  ok(/% Count must be a whole number from 1 to 50/.test(L.joined('ping ' + V6_ROUTER + ' 99')),
    'so is 99', L.joined('ping ' + V6_ROUTER + ' 99'));

  const at = L.joined('ping ' + V6_ROUTER + ' 2 at 60000');
  ok(/at t=60000 ms/.test(at), 'the instant is named in the answer', at.split('\n')[1]);
  ok(/\(2\/2\)/.test(at), 'and answered at that instant', at);
  const at4 = L.joined('ping ' + V4_ROUTER + ' 2 at 60000');
  ok(/\(2\/2\)/.test(at4), 'the same instant answers the same way over IPv4', at4);
  // A mid-convergence instant is answered by the engine's own clock rules, which know nothing about an address
  // family: whatever it says, it has to say the same thing to both.
  const rate = function (text) { return (text.match(/Success rate is \d+ percent \(\d+\/\d+\)/) || [''])[0]; };
  const same = rate(L.joined('ping ' + V6_ROUTER + ' 2 at 5000'));
  const same4 = rate(L.joined('ping ' + V4_ROUTER + ' 2 at 5000'));
  ok(same !== '' && same === same4, 'and at a mid-convergence instant both families agree', same + ' vs ' + same4);

  // The instant is a property of the question: asking at 60000 must not leave the console answering at 60000.
  const prior = L.sim.runAtMs;
  L.run('ping ' + V6_ROUTER + ' 1 at 60000');
  ok(L.sim.runAtMs === prior, 'the session is left at the instant it arrived with',
    String(prior) + ' -> ' + String(L.sim.runAtMs));
}

console.log('');
console.log('A malformed IPv6 literal is refused as an address:');
{
  const L = lab();
  const cases = [
    ['2001:db8:::1', "':' runs longer than '::' are invalid"],
    ['2001:db8:1::11/64', 'illegal character'],
    ['2001:db8:1::gggg', 'illegal character']
  ];
  cases.forEach(function (c) {
    const text = L.joined('ping ' + c[0]);
    ok(/^% Invalid IPv6 address: /.test(text), c[0] + ' is refused as an address', text.split('\n')[0]);
    ok(text.indexOf(c[1]) !== -1, 'and the reason says why', text.split('\n')[0]);
    ok(text.indexOf('Could not resolve') === -1, 'it is never sent to the resolver', text);
  });
}

console.log('');
console.log('IPv4 and names behave exactly as before:');
{
  const L = lab();
  ok(/Success rate is 100 percent \(4\/4\)/.test(L.joined('ping ' + V4_ROUTER)), 'IPv4 still answers', '');
  ok(/% Invalid ping target: 10\.0\.0\.999/.test(L.joined('ping 10.0.0.999')),
    'a v4 typo still gets the v4 sentence', L.joined('ping 10.0.0.999'));
  const name = L.joined('ping nosuchname.lab');
  ok(/% Could not resolve "nosuchname\.lab"/.test(name), 'a name is still resolved', name.split('\n')[0]);
  ok(/% Nothing was sent\./.test(name), 'and nothing is sent when it does not resolve', name);
  ok(/% Invalid ping target: \(none\)/.test(L.joined('ping')), 'no target is still refused', L.joined('ping'));
  ok(/% Unrecognized/.test(L.joined('ping ' + V6_ROUTER + ' now')),
    'a stray word is still refused', L.joined('ping ' + V6_ROUTER + ' now'));
}

console.log('');
console.log('An address nobody owns times out, and says so:');
{
  const L = lab();
  const text = L.joined('ping 2001:db8:1::99');
  ok(/Success rate is 0 percent \(0\/4\)/.test(text), 'nothing answers', text.split('\n')[2]);
  ['0', '1', '2', '3'].forEach(function (seq) {
    ok(new RegExp('Request timed out \\(seq ' + seq + '\\)').test(text), 'seq ' + seq + ' says it timed out', '');
  });
}

console.log('');
console.log('The help names the family it accepts:');
{
  const L = lab();
  const help = L.cli('p').run('help').output.concat(L.cli('p').run('?').output).join('\n');
  ok(/ping <address\|name>/.test(help), 'the ping row is still there', '');
  ok(/IPv4 or IPv6/.test(help), 'and says it takes either', help.split('\n').filter(function (l) { return /ping <address/.test(l); })[0]);
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exitCode = failed ? 1 : 0;
