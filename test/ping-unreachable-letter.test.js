'use strict';
// A `ping` probe that draws an ICMP destination-unreachable is marked `U` on an IOS-like box; `.` is the
// timeout character and nothing else. This console could only print `.`, because the reply object had no
// field for "an error came back" - the engine recorded the ICMP error per seq and no caller read it, so a
// router saying "no route" and a cable in the dark produced the same character (research/ping-unreachable-letter.md).
//
// The vendor's own words, from the ping/traceroute note this repo already cites for the traceroute letters
// (Cisco doc 12778, "Possible Output Characters From the Ping Facility"):
//
//   !  Each exclamation point indicates receipt of a reply.
//   .  Each period indicates the network server timed out as it waits for a reply.
//   U  A destination unreachable error PDU was received.
//
// and the same page's worked example prints `U.U.U` for a probe answered with ICMP type 3 **code 1** (host
// unreachable) - so a `U` is not per code, which is the opposite of `traceroute`'s `!H`/`!N` letters. The
// alternating `U.U.U` form itself is not reproduced: this engine prints one character per echo.
const path = require('path');
const { Topology, Simulator, runCommands } = require('../engine');
const cliModule = require('../engine/cli');
const CliSession = cliModule.CliSession || cliModule;
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}
const ROOT = path.join(__dirname, '..');
const catalog = loadCatalog(path.join(ROOT, 'devices'));
function spec(v, m) { return catalog.find(function (x) { return x.vendor === v && x.model === m; }); }

// R1 --- R2. R1 knows two prefixes: one R2 also knows (so the far side has the subnet and fails on ARP),
// one R2 does not (so R2 answers "no route" with an ICMP unreachable).
function lab() {
  const t = new Topology();
  const r1 = t.addDevice(spec('cisco', 'ISR 4331')); r1.name = 'R1';
  const r2 = t.addDevice(spec('cisco', 'ISR 4331')); r2.name = 'R2';
  t.connect(r1.id, 'Gi0/0/0', r2.id, 'Gi0/0/0');
  const cfg = function (d, lines) { runCommands(d, t, null, ['configure terminal'].concat(lines)); };
  cfg(r1, ['interface Gi0/0/0', 'ip address 10.0.12.1 255.255.255.0', 'no shutdown', 'exit',
    'ip route 192.0.2.0 255.255.255.0 10.0.12.2',
    'ip route 192.168.2.0 255.255.255.0 10.0.12.2', 'end']);
  cfg(r2, ['interface Gi0/0/0', 'ip address 10.0.12.2 255.255.255.0', 'no shutdown', 'exit',
    'interface Gi0/0/1', 'ip address 192.168.2.1 255.255.255.0', 'no shutdown', 'end']);
  return { t: t, r1: r1, r2: r2, cfg: cfg };
}
function console_(t, devId, command) {
  const sim = new Simulator(t);
  const s = new CliSession(t.getDevice(devId), t, sim);
  return { lines: (s.run(command) || {}).output || [], sim: sim };
}
const marks = function (text) {
  const lines = String(text).split('\n');
  const i = lines.findIndex(function (l) { return /^Sending \d+, 100-byte ICMP Echos to /.test(l); });
  return i === -1 ? null : lines[i + 1];
};

console.log('');
console.log('An echo answered with a destination-unreachable is a U, not a timeout:');
{
  const L = lab();
  const r = console_(L.t, L.r1.id, 'ping 192.0.2.10 3');
  const text = r.lines.join('\n');
  ok(marks(text) === 'UUU', 'three probes, three U marks', marks(text));
  ok((text.match(/Request timed out/g) || []).length === 0,
    'and no `Request timed out` line contradicts the mark above it', text.split('\n').join(' | '));
  ok(/Success rate is 0 percent \(0\/3\)/.test(text), 'the success rate is the vendor\'s short form', text.split('\n').join(' | '));

  const sim = new Simulator(L.t);
  const raw = sim.ping(L.r1.id, '192.0.2.10', { count: 2 });
  const err = raw.replies[0] || {};
  ok(err.unreachable === true, 'the reply itself says an error came back, not just the console', JSON.stringify(err));
  ok(err.unreachableFrom === '10.0.12.2', 'and names the box that answered', String(err.unreachableFrom));
  ok(err.errorType === 3 && err.errorCode === 0, 'with the ICMP type and code the engine recorded',
    err.errorType + '/' + err.errorCode);
  ok(/no route to 192\.0\.2\.10/.test(String(err.reason)), 'the loss sentence is unchanged, so `% Echoes lost:` still explains', String(err.reason));
}

console.log('');
console.log('Silence is still a dot, and the two are told apart inside one run:');
{
  // R2 holds 192.168.2.0/24, so the packet gets there and nothing answers the ARP: that is a timeout on a box,
  // and it must not become a U now that U exists.
  const L = lab();
  const r = console_(L.t, L.r1.id, 'ping 192.168.2.99 2');
  const text = r.lines.join('\n');
  ok(marks(text) === '..', 'an ARP that nobody answers is two dots', marks(text));
  ok(!/^Reply from /m.test(text), 'and neither echo gets a per-echo sentence', text.split('\n').join(' | '));
  const raw = new Simulator(L.t).ping(L.r1.id, '192.168.2.99', { count: 1 });
  ok(raw.replies[0].unreachable === false, 'the reply says no error came back', JSON.stringify(raw.replies[0]));
  ok(raw.replies[0].errorType === null, 'and carries no ICMP type it did not receive', String(raw.replies[0].errorType));
}

console.log('');
console.log('A box that cannot route the echo itself is the open half, and stays a dot until a capture says otherwise:');
{
  // Cisco's note shows this case with `debug ip packet` interleaved, so the marks line is not readable in the
  // capture ("unroutable" then `Success rate is 0 percent (0/5)`). No clean transcript was found for it, so the
  // engine generates no error for a locally failed lookup and the console prints a dot. Pinned on purpose: if a
  // capture turns up showing `U`, this is the test to change, and research/ping-unreachable-letter.md is where
  // the evidence goes.
  const L = lab();
  const r = console_(L.t, L.r1.id, 'ping 198.51.100.7 2');
  const text = r.lines.join('\n');
  ok(marks(text) === '..', 'a source-side `no route` is not a received error, so it stays a dot', marks(text));
  ok(!/^Reply from /m.test(text), 'with no per-echo line invented to explain it');
}

console.log('');
console.log('The answered case and the mark count are untouched:');
{
  const L = lab();
  const r = console_(L.t, L.r1.id, 'ping 10.0.12.2 2');
  const text = r.lines.join('\n');
  ok(marks(text) === '!!', 'a reply is still an exclamation mark', marks(text));
  ok(/round-trip min\/avg\/max = /.test(text), 'and the round-trip clause is still printed', text.split('\n').join(' | '));

  // One character per echo, whatever the mix: the length of the marks line is the count that was sent, which is
  // what makes `Success rate is N percent (ok/count)` readable against it.
  const raw = new Simulator(L.t).ping(L.r1.id, '192.0.2.10', { count: 4 });
  const U = raw.replies.filter(function (x) { return x.unreachable; }).length;
  const dots = raw.replies.filter(function (x) { return !x.success && !x.unreachable; }).length;
  ok(U + dots + raw.replies.filter(function (x) { return x.success; }).length === 4,
    'every probe is exactly one of reply / unreachable / silence', U + '+' + dots);
  ok(marks(console_(L.t, L.r1.id, 'ping 192.0.2.10 4').lines.join('\n')) === 'UUUU',
    'and four unreachable probes print four characters, one per echo');
}

console.log('');
console.log('IPv6 has no such field, and a ping6 does not grow a U:');
{
  const L = lab();
  const r = console_(L.t, L.r1.id, 'ping 2001:db8::1 1');
  ok(!/U/.test(marks(r.lines.join('\n')) || ''), 'an IPv6 echo with nothing back is not marked U', marks(r.lines.join('\n')));
}

console.log('');
if (failed) {
  console.error(passed + ' passed, ' + failed + ' failed');
  process.exit(1);
}
console.log(passed + ' passed, 0 failed');
