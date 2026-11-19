#!/usr/bin/env node
/**
 * The shape of a `ping` report: one marks line and the success rate, and nothing per echo (#fidelity).
 *
 * This console used to append a sentence for every echo - `Reply from <address>: bytes=100 time=<rtt> ms` for each
 * answered probe, `Request timed out (seq N)` for each lost one. Neither is IOS output. A box reports each echo as
 * one character of the marks line and closes the run with `Success rate is ...`, with the round trip riding on that
 * line as `, round-trip min/avg/max = a/b/c ms`. The `Reply from ...: bytes=<n> time=<t>` shape is *Windows* ping
 * (`ping -l 100`), so the extra lines had this console speaking one operating system's dialect on another operating
 * system's prompt. research/ping-report-shape.md cites the captures; this file pins the report they describe.
 *
 * What must NOT regress here is the converse: the console must not answer a ping with nothing at all. The marks
 * line, the rate and - when there is one - the clause are all still asserted, and so is the `% Echoes lost:`
 * sentence that explains a lost echo, because that sentence is the console's own voice and carries the reason.
 */
'use strict';

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
  cfg('h1', ['interface eth0', 'ip address 10.0.0.1 255.255.255.0', 'ipv6 address 2001:db8:1::10/64']);
  cfg('h2', ['interface eth0', 'ip address 10.0.0.2 255.255.255.0']);
  cfg('r1', ['interface Gi0/0', 'ipv6 address ' + V6_ROUTER + '/64']);
  return { t: t, sim: sim, cli: cli, run: function (cmd) { return cli('h1').run(cmd).output; },
    joined: function (cmd) { return cli('h1').run(cmd).output.join('\n'); } };
}

// Every line the console must never print after a ping, whichever family answered.
const PER_ECHO = /^(Reply from |Request timed out)/;

console.log('');
console.log('A successful ping is four lines: hint, send line, marks, rate');
{
  const L = lab();
  const out = L.run('ping 10.0.0.2 3');
  ok(out.length === 4, 'the report is exactly four lines', out.length + ': ' + out.join(' | '));
  ok(out[0] === 'Type escape sequence to abort.', 'the abort hint leads', out[0]);
  ok(/^Sending 3, 100-byte ICMP Echos to 10\.0\.0\.2, timeout is 2 seconds:$/.test(out[1]),
    'then the send line', out[1]);
  ok(out[2] === '!!!', 'then one character per echo, as a box prints it', out[2]);
  ok(/^Success rate is 100 percent \(3\/3\), round-trip min\/avg\/max = [0-9.]+\/[0-9.]+\/[0-9.]+ ms$/.test(out[3]),
    'and the rate closes the report, the round trip riding on it', out[3]);
  ok(!out.some(function (l) { return PER_ECHO.test(l); }), 'with no per-echo sentence anywhere',
    out.join(' | '));
  ok(out.join('\n').indexOf('bytes=') === -1, 'and no `bytes=` field, which is one host OS\'s spelling', '');
}

console.log('');
console.log('A ping that lost every echo is three lines, and the marks carry the loss');
{
  const L = lab();
  const out = L.run('ping 10.0.0.99 2');
  ok(out.length === 5, 'the report is hint, send line, marks, rate, and the console\'s explanation',
    out.length + ': ' + out.join(' | '));
  ok(out[2] === '..', 'two dots are the two lost echoes', out[2]);
  ok(out[3] === 'Success rate is 0 percent (0/2)',
    'the rate is the short form the vendor prints for a total loss', out[3]);
  ok(!out.some(function (l) { return PER_ECHO.test(l); }), 'and no per-echo timeout line is invented', '');
  ok(out.join('\n').indexOf('round-trip') === -1, 'nor a round trip nothing measured', '');
}

console.log('');
console.log('Partial loss: the marks say which echo went missing, the rate does the arithmetic');
{
  // The report the vendor prints for a 4/5 ping: one dot, four bangs, a rate over five, and nothing else. The
  // replies are handed to the renderer directly because no lab in this file loses exactly one of five.
  const L = lab();
  const out = [];
  L.cli('h1')._pingReplyLines(out, 5, [
    { seq: 0, success: false, reason: 'no ARP reply from 10.0.0.9', rtt: null },
    { seq: 1, success: true, rtt: 1.4 },
    { seq: 2, success: true, rtt: 3.2 },
    { seq: 3, success: true, rtt: 1.4 },
    { seq: 4, success: true, rtt: 1.4 }
  ]);
  ok(out.length === 2, 'the report is the marks line and the rate, nothing per echo', out.join(' | '));
  ok(out[0] === '.!!!!', 'one dot, four bangs', out[0]);
  ok(out[1] === 'Success rate is 80 percent (4/5), round-trip min/avg/max = 1.4/1.9/3.2 ms',
    'and the rate averages the four that came back', out[1]);
  ok(!out.some(function (l) { return PER_ECHO.test(l); }), 'no sentence about the one that did not', '');
}

console.log('');
console.log('IPv6 prints the same report - one helper, one shape');
{
  const L = lab();
  const out = L.run('ping ' + V6_ROUTER + ' 2');
  ok(out.length === 4, 'four lines, exactly as IPv4', out.join(' | '));
  ok(out[2] === '!!', 'the marks line is one character per echo', out[2]);
  ok(/^Success rate is 100 percent \(2\/2\), round-trip min\/avg\/max = [0-9.]+\/[0-9.]+\/[0-9.]+ ms$/.test(out[3]),
    'and the rate carries the clause', out[3]);
  ok(!out.some(function (l) { return PER_ECHO.test(l); }), 'with no per-echo sentence of its own', '');
}

console.log('');
console.log('The explanation of a lost echo survives the deletion, in the console\'s own voice');
{
  const L = lab();
  const r1 = L.cli('h1');
  // A path that is up but leads nowhere: the echo is lost and the engine knows why.
  const out = r1.run('ping 10.0.0.99 1').output;
  const lost = out.filter(function (l) { return /^% Echoes lost: /.test(l); });
  ok(lost.length === 1, 'one `% Echoes lost:` sentence explains the drop', out.join(' | '));
  ok(/^% /.test(lost[0] || ''), 'written as commentary, with the console\'s `%` prefix', lost[0]);
  ok(/10\.0\.0\.99/.test(lost[0] || ''), 'and it names the address', lost[0]);
  ok(out.indexOf(lost[0]) > out.findIndex(function (l) { return /^\.+$/.test(l); }),
    'after the marks line, so the report reads top to bottom', out.join(' | '));
}

console.log('');
console.log('The rule is the report\'s, not one code path\'s: no vendor silence is a promise of a line');
{
  // `bytes=100` was the tell: IOS never states the probe size on a reply, because it never prints a reply line.
  const L = lab();
  ['ping 10.0.0.2 1', 'ping 10.0.0.2 5', 'ping 10.0.0.99 2', 'ping ' + V6_ROUTER + ' 2', 'ping 2001:db8:1::99 2']
    .forEach(function (cmd) {
      const text = L.joined(cmd);
      ok(text.indexOf('bytes=') === -1, 'no `bytes=` after `' + cmd + '`', text.split('\n').join(' | '));
    });
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
