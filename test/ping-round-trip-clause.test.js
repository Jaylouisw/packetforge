'use strict';
// The success-rate line is a sentence IOS never leaves unfinished.
//
//   Router4#ping 172.16.6.5
//   Sending 5, 100-byte ICMP Echos to 172.16.6.5, timeout is 2 seconds:
//   .!!!!
//   Success rate is 80 percent (4/5), round-trip min/avg/max = 1/1/2 ms
//
// This console printed the rate and stopped, so the one number a ping is actually asked for - how long it took - was
// missing from a command whose whole output is about that. The clause is in every Cisco transcript, and so is its
// absence: a ping that loses every echo prints `Success rate is 0 percent (0/5)` and nothing after it, because there
// is no round trip to average. Both halves are pinned here.
//
// **Sources.** The 4/5 example is the NAT connectivity note, and the same shape appears in the ASR 1000 management
// Ethernet guide; `Success rate is 100 percent (5/5), round-trip min/avg/max = 4/6/8 ms` and the bare
// `Success rate is 0 percent (0/5)` are both in the ping/traceroute note.
//   https://www.cisco.com/c/en/us/support/docs/ip/network-address-translation-nat/221481-8605-13.html
//   https://cisco.com/c/en/us/td/docs/routers/asr1000/configuration/guide/chassis/xe-17/asr1000-software-config-guide-17-1/mgmt-ether-asr.html
//   http://cisco.com/c/en/us/support/docs/ios-nx-os-software/ios-software-releases-121-mainline/12778-ping-traceroute.html
//
// The figures keep this console's units rather than the vendor's whole milliseconds (a real box prints `0/0/0 ms` for a
// sub-millisecond path), because the fractional rtt is the latency model's whole point; what is checked here is that the
// clause's figures and the `Reply from ... time=` lines are the same measurement spelled the same way.
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

const V6_HOST = '2001:db8:1::10';
const V6_ROUTER = '2001:db8:1::1';

function lab() {
  const t = new Topology();
  t.addDevice(SWITCH, 'sw'); t.addDevice(PC, 'h1'); t.addDevice(PC, 'h2'); t.addDevice(ROUTER, 'r1');
  t.connect('h1', 'eth0', 'sw', 'Fa0/1');
  t.connect('h2', 'eth0', 'sw', 'Fa0/2');
  t.connect('r1', 'Gi0/0', 'sw', 'Fa0/3');
  const sim = new Simulator(t);
  const S = {};
  const cli = function (id) { return (S[id] = S[id] || new CliSession(t.getDevice(id), t, sim)); };
  const cfg = function (id, lines) {
    cli(id).run('configure terminal');
    lines.forEach(function (l) { return cli(id).run(l); });
    cli(id).run('end');
  };
  cfg('h1', ['interface eth0', 'ip address 10.0.0.1 255.255.255.0', 'ipv6 address ' + V6_HOST + '/64']);
  cfg('h2', ['interface eth0', 'ip address 10.0.0.2 255.255.255.0']);
  cfg('r1', ['interface Gi0/0', 'ipv6 address ' + V6_ROUTER + '/64']);
  return { t: t, sim: sim, cli: cli, run: function (cmd) { return cli('h1').run(cmd).output; },
    joined: function (cmd) { return cli('h1').run(cmd).output.join('\n'); } };
}

function clauseOf(text) {
  const m = text.match(/, round-trip min\/avg\/max = ([0-9.]+)\/([0-9.]+)\/([0-9.]+) ms/);
  return m ? [m[1], m[2], m[3]] : null;
}

console.log('');
console.log('A ping that came back says how long it took:');
{
  const L = lab();
  const text = L.joined('ping 10.0.0.2 3');
  ok(/Success rate is 100 percent \(3\/3\), round-trip min\/avg\/max = [0-9.]+\/[0-9.]+\/[0-9.]+ ms/.test(text),
    'the rate carries the round-trip clause', text);
  const c = clauseOf(text);
  const times = (text.match(/time=([0-9.]+) ms/g) || []).map(function (s) { return s.replace(/time=| ms/g, ''); });
  ok(c !== null && times.length === 3, 'three replies print and the clause parses', String(c) + ' / ' + String(times));
  if (c && times.length) {
    // The summary and the detail are one measurement: min/avg/max of the replies is what the clause prints.
    const nums = times.map(Number);
    const min = Math.min.apply(null, nums), max = Math.max.apply(null, nums);
    const avg = nums.reduce(function (a, b) { return a + b; }, 0) / nums.length;
    const f = function (ms) { return ms.toFixed(max < 1 ? 3 : 1); };
    ok(c[0] === f(min) && c[2] === f(max), 'min and max are the smallest and largest reply',
      c.join('/') + ' vs ' + f(min) + '/' + f(max));
    ok(c[1] === f(avg), 'and avg is their mean, in the same units', c[1] + ' vs ' + f(avg));
    ok(Number(c[0]) <= Number(c[1]) && Number(c[1]) <= Number(c[2]),
      'the three read min/avg/max, in order', c.join('/'));
    ok(times.every(function (s) { return s === times[0]; }), 'a flat lab reports one round trip, not three',
      times.join(','));
  }
}

console.log('');
console.log('A ping that lost every echo has no round trip to report:');
{
  const L = lab();
  const text = L.joined('ping 10.0.0.99 1');
  ok(/Success rate is 0 percent \(0\/1\)/.test(text), 'the rate is still printed', text);
  ok(clauseOf(text) === null, 'and no min/avg/max clause is invented for it', text);
  ok(text.indexOf('round-trip') === -1, 'the word does not appear at all', text);
  const many = L.joined('ping 10.0.0.99 2');
  ok(/Success rate is 0 percent \(0\/2\)/.test(many) && many.indexOf('round-trip') === -1,
    'however many echoes were lost', many);
}

console.log('');
console.log('Partial loss keeps the rate honest and averages only what came back:');
{
  const L = lab();
  // The report the vendor prints for a 4/5 ping: one dot, four bangs, and a clause built from the four that returned.
  const replies = [
    { seq: 0, success: false, reason: 'no ARP reply from 10.0.0.9', rtt: null, hops: null },
    { seq: 1, success: true, reason: null, rtt: 1.4, hops: 1 },
    { seq: 2, success: true, reason: null, rtt: 3.2, hops: 1 },
    { seq: 3, success: true, reason: null, rtt: 1.4, hops: 1 },
    { seq: 4, success: true, reason: null, rtt: 1.4, hops: 1 }
  ];
  const out = [];
  L.cli('h1')._pingReplyLines(out, '10.0.0.9', 5, replies);
  const text = out.join('\n');
  ok(/^\.!!!!$/m.test(text), 'the marks line keeps one dot for the lost echo', text);
  ok(/Success rate is 80 percent \(4\/5\)/.test(text), 'the rate is 80 percent (4/5)', text);
  ok(/round-trip min\/avg\/max = 1\.4\/1\.9\/3\.2 ms/.test(text),
    'and the clause averages the four that returned, not the five that were sent', text);
}

console.log('');
console.log("The figures are the console's units, with one precision per clause:");
{
  const L = lab();
  const render = function (replies, count) {
    const out = [];
    L.cli('h1')._pingReplyLines(out, '10.0.0.2', count || replies.length, replies);
    return out.join('\n');
  };
  const sub = render([
    { seq: 0, success: true, rtt: 0.2, hops: 1 },
    { seq: 1, success: true, rtt: 0.4, hops: 1 }
  ]);
  ok(/round-trip min\/avg\/max = 0\.200\/0\.300\/0\.400 ms/.test(sub),
    'a sub-millisecond lab prints three decimals throughout', sub);
  const mixed = render([
    { seq: 0, success: true, rtt: 0.4, hops: 1 },
    { seq: 1, success: true, rtt: 1.6, hops: 1 }
  ]);
  ok(/round-trip min\/avg\/max = 0\.4\/1\.0\/1\.6 ms/.test(mixed),
    'and one figure at a millisecond or more makes the whole clause one-decimal', mixed);
  const clauseText = mixed.slice(mixed.indexOf('round-trip'), mixed.indexOf('round-trip') + 60);
  ok(clauseText.indexOf('0.400') === -1, 'no clause mixes the two precisions', clauseText);
  const unmeasured = render([
    { seq: 0, success: true, rtt: null, hops: 2 },
    { seq: 1, success: true, rtt: null, hops: 2 }
  ]);
  ok(/Success rate is 100 percent \(2\/2\)/.test(unmeasured), 'a reply with no modelled delay still counts', unmeasured);
  ok(unmeasured.indexOf('round-trip') === -1, 'but it cannot be averaged, so no clause is printed', unmeasured);
  ok(/time=2 hops/.test(unmeasured), 'the reply line says what it does know', unmeasured);
}

console.log('');
console.log('One report, two address families:');
{
  const L = lab();
  const v6 = L.joined('ping ' + V6_ROUTER + ' 2');
  ok(/\(2\/2\), round-trip min\/avg\/max = /.test(v6), 'an IPv6 ping gets the clause too', v6);
  ok(clauseOf(v6) !== null, 'with three figures in it', v6);
  const v4 = L.joined('ping 10.0.0.2 2');
  ok(clauseOf(v4) !== null, 'and IPv4 keeps it', v4);
  const shape = function (t) { return t.split('\n')[2].replace(/[0-9.]+/g, 'N'); };
  ok(shape(v6) === shape(v4), 'the line has one shape in both families', shape(v6) + '  vs  ' + shape(v4));
  const dead = L.joined('ping 2001:db8:1::99 1');
  ok(dead.indexOf('round-trip') === -1, 'a v6 ping that got nothing prints no clause either', dead);
}

console.log('');
console.log('Nothing else about the report moved:');
{
  const L = lab();
  const lines = L.joined('ping 10.0.0.2 1').split('\n');
  ok(lines[0] === 'Type escape sequence to abort.', 'the abort hint is still first', lines[0]);
  ok(/^Sending 1, 100-byte ICMP Echos to 10\.0\.0\.2, timeout is 2 seconds:$/.test(lines[1]),
    'the send line is unchanged', lines[1]);
  ok(lines[2] === '!', 'the marks line follows it', lines[2]);
  ok(/^Success rate is 100 percent \(1\/1\), round-trip/.test(lines[3]), 'the rate is third, clause and all',
    lines[3]);
  ok(/^Reply from 10\.0\.0\.2: bytes=100 time=/.test(lines[4]), 'and the reply lines still follow the rate', lines[4]);
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
