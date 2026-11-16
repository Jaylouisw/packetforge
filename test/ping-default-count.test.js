'use strict';
// A bare `ping <address>` sends five echoes, because that is what a box sends.
//
//   Router# ping 192.168.7.27
//   Repeat count [5]:
//   Sending 5, 100-byte ICMP Echos to 192.168.7.27, timeout is 2 seconds:
//   !!!!!
//
// The vendor's own field list is explicit - "Repeat count [5]: Number of ping packets that will be sent to the
// destination address. Default: 5" - and every sample in the same reference opens with `Sending 5`. This console
// sent four and said `Sending 4`, so a reader comparing one command against a real box was one echo short, and
// `Success rate is 100 percent (4/4)` was a report no box would print for the same command.
//
// **Sources.** The `ping` command reference (field list and the `Sending 5` sample) and the ping/traceroute note that
// spells the rule out in words ("By default, the repeat count is five times, so there will be five echo requests,
// and five echo replies"):
//   https://www.cisco.com/E-Learning/bulk/public/tac/cim/cib/using_cisco_ios_software/cmdrefs/ping.htm
//   https://www.cisco.com/c/en/us/support/docs/ios-nx-os-software/ios-software-releases-121-mainline/12778-ping-traceroute.html
//
// The number lives in three surfaces - the engine's default, the console's default and the browser dialog's field -
// and all three are pinned here, because a dialog that sends `count: 4` explicitly never consults the engine's
// default and would have stayed wrong on its own.
const fs = require('fs');
const path = require('path');
const { Topology, Simulator } = require('../engine');
const { CliSession } = require('../engine/cli');
const { loadCatalog } = require('../devices/registry');
const simLib = require('../engine/simulator');

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
  return { t: t, sim: sim, cli: cli,
    run: function (cmd) { return cli('h1').run(cmd).output; },
    joined: function (cmd) { return cli('h1').run(cmd).output.join('\n'); } };
}

console.log('');
console.log('The engine sends the vendor default when nobody names a count:');
{
  ok(simLib.PING_COUNT_DEFAULT === 5, 'the default repeat count is five', String(simLib.PING_COUNT_DEFAULT));
  const L = lab();
  const r = L.sim.ping('h1', '10.0.0.2', {});
  ok(r.replies.length === 5, 'a bare ping sends five echoes', String(r.replies.length));
  ok(r.count === 5 && r.requestedCount === null,
    'and the answer says five was sent while nothing was asked for',
    JSON.stringify([r.count, r.requestedCount]));
  ok(r.replies.filter(function (x) { return x.success; }).length === 5, 'all five come back on a healthy path',
    JSON.stringify(r.replies.map(function (x) { return x.success; })));

  // The IPv6 echo is the same command on the same box, so it is the same default - it had its own `|| 4` copy.
  const r6 = L.sim.ping6('h1', V6_ROUTER, {});
  ok(r6.replies.length === 5, 'an IPv6 ping sends five by default too', String(r6.replies.length));
}

console.log('');
console.log('The console prints the count it actually sent:');
{
  const L = lab();
  const out = L.run('ping 10.0.0.2');
  const text = out.join('\n');
  ok(/^Sending 5, 100-byte ICMP Echos to 10\.0\.0\.2, timeout is 2 seconds:$/m.test(text),
    'the header is `Sending 5, ...`, as a box prints it', out[1]);
  ok(/^!!!!!$/m.test(text), 'the marks line is five replies', text.split('\n').filter(function (l) { return /^[!.]/.test(l); })[0]);
  ok(/Success rate is 100 percent \(5\/5\)/.test(text), 'and the rate is out of five', text);
  ok((text.match(/^Reply from /gm) || []).length === 5, 'five reply lines are printed, one per echo',
    String((text.match(/^Reply from /gm) || []).length));

  // An explicit count still wins, so the default is a default and not a floor.
  const two = L.joined('ping 10.0.0.2 2');
  ok(/Sending 2, 100-byte ICMP Echos to 10\.0\.0\.2/.test(two), 'an explicit count is still what is sent', two.split('\n')[1]);
  ok(/Success rate is 100 percent \(2\/2\)/.test(two), 'and the rate is out of two', two);
}

console.log('');
console.log('The browser dialog sends the same default:');
{
  const app = fs.readFileSync(path.join(ROOT, 'web', 'app.js'), 'utf8');
  ok(/id="ping-count"[^>]*value="5"/.test(app), 'the count field defaults to 5', '');
  ok(app.indexOf('id="ping-count" type="number" min="1" max="50" value="5"') !== -1,
    'and no other default is written beside it', '');
  ok(/pingCountProblem\(countField === '' \? '5' : countField\)/.test(app),
    'an emptied field is validated as 5, not as 4', '');
  ok(app.indexOf("Number(countField === '' ? 5 : countField)") !== -1,
    'and the number actually sent from an emptied field is 5', '');
}

console.log('');
console.log('The CLI reference shows the default it documents:');
{
  const doc = fs.readFileSync(path.join(ROOT, 'docs', 'CLI.md'), 'utf8');
  ok(doc.indexOf('Sending 5, 100-byte ICMP Echos to 10.0.1.10') !== -1, 'the worked example sends five', '');
  ok(doc.indexOf('Sending 4,') === -1, 'and no example still shows four', '');
  ok(/a ping sends \*\*five\*\* echoes/.test(doc), 'the prose names the default and its source', '');
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exitCode = failed ? 1 : 0;
