'use strict';
// A static route is one entry, however many times it is typed (#1657).
//
// The console kept a row per typing, so a line already in the configuration could be added again:
//
//     r1(config)#ip route 10.9.0.0 255.255.0.0 10.0.0.254
//     Route added: 10.9.0.0/16 via 10.0.0.254
//     r1(config)#ip route 10.9.0.0 255.255.0.0 10.0.0.254
//     Route added: 10.9.0.0/16 via 10.0.0.254
//     r1# show running-config
//      ip route 10.9.0.0 255.255.0.0 10.0.0.254
//      ip route 10.9.0.0 255.255.0.0 10.0.0.254
//     r1# show ip route
//     S   10.9.0.0/16 [1/0] via 10.0.0.254  (not installed: the S route for this prefix has distance 1)
//
// The second row is the visible half of the defect: it says the route lost to itself. The stored half is
// worse - `show running-config` is meant to be a file that can be pasted back (test/config-roundtrip.test.js),
// and every paste of a backup onto a box that already carries it grew the file by one `ip route` line.
//
// A box keys a static route on the whole statement - prefix, mask, next hop or interface, and the
// administrative distance - so the same statement twice is one entry. Three shapes stay three routes because
// they are three statements: another next hop for one prefix, the floating static (same next hop, another
// distance, docs/CLI.md), and the fully specified form, whose interface is part of the statement.
// The vendor evidence, and what it does not settle, is in research/duplicate-static-route.md.

const path = require('path');
const { Topology, Simulator } = require('../engine');
const { CliSession } = require('../engine/cli');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}
const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
const spec = function (m) { return catalog.find(function (x) { return x.model === m; }); };

// Output lines only, never the echoed prompt: a receipt is asserted, and a prompt is not an answer.
function session(t, dev, sim) {
  const s = new CliSession(dev, t, sim || null);
  return function (cmds) {
    const out = [];
    for (const c of cmds) {
      const r = s.run(c);
      for (const l of ((r && r.output) || [])) out.push(String(l));
    }
    return out;
  };
}
function cli(t, dev, cmds) {
  return session(t, dev)(['enable', 'configure terminal'].concat(cmds));
}
function show(t, dev, cmd) {
  const sim = new Simulator(t);
  sim.setRunTime(60000);
  return session(t, dev, sim)(['enable', cmd]).join('\n');
}
function routeRows(table, cidr) {
  return table.split('\n').filter(function (l) { return l.trim().split(/\s+/)[1] === cidr; });
}
// The last line of an answer: `configure terminal` prints its greeting, and the receipt is what follows it.
function last(lines) { return lines.length ? lines[lines.length - 1] : ''; }
function routeLines(rc) {
  return rc.split('\n').filter(function (l) { return /^\s*ip route /.test(l); });
}

// One router, one addressed port, no cable beyond it: the table answers "is the row there" without a link,
// and no row carries a fault note that belongs to another question.
function router() {
  const t = new Topology();
  const r1 = t.addDevice(spec('ISR 4331'), 'r1');
  const port = Array.from(r1.interfaces.keys())[0];
  cli(t, r1, ['interface ' + port, 'ip address 10.0.0.1 255.255.255.0', 'no shutdown']);
  return { t: t, r1: r1, port: port };
}

console.log('');
console.log('The same statement twice is one route:');
{
  const lab = router(), t = lab.t, r1 = lab.r1;
  const first = cli(t, r1, ['ip route 10.9.0.0 255.255.0.0 10.0.0.254']);
  const second = cli(t, r1, ['ip route 10.9.0.0 255.255.0.0 10.0.0.254']);

  ok(first.length === 2 && last(first) === 'Route added: 10.9.0.0/16 via 10.0.0.254',
    'the first typing is a receipt for a route that was added', JSON.stringify(first));
  ok(/^Route unchanged: 10\.9\.0\.0\/16 via 10\.0\.0\.254\b/.test(last(second)),
    'the second says the route is already configured', JSON.stringify(second));
  ok(!/Route added/.test(second.join(' ')), 'and does not claim to have added it again');
  ok(r1.config.routes.length === 1, 'the configuration holds one route, not two', String(r1.config.routes.length));

  const rc = show(t, r1, 'show running-config');
  const lines = routeLines(rc);
  ok(lines.length === 1, 'the running-config prints the line once', JSON.stringify(lines));

  const rows = routeRows(show(t, r1, 'show ip route'), '10.9.0.0/16');
  ok(rows.length === 1, 'show ip route prints one row for the prefix', JSON.stringify(rows));
  ok(rows.length === 1 && !/not installed/.test(rows[0]),
    'and it is not annotated as having lost to something', rows[0]);
  ok(rows.length === 1 && /via 10\.0\.0\.254/.test(rows[0]), 'the row still names the next hop');
}

console.log('');
console.log('A second statement is a second route:');
{
  const lab = router(), t = lab.t, r1 = lab.r1;
  cli(t, r1, ['ip route 10.9.0.0 255.255.0.0 10.0.0.254']);
  const otherHop = cli(t, r1, ['ip route 10.9.0.0 255.255.0.0 10.0.0.253']);
  ok(/^Route added: 10\.9\.0\.0\/16 via 10\.0\.0\.253$/.test(last(otherHop)),
    'another next hop for the same prefix is added, not swallowed', JSON.stringify(otherHop));
  const rows = routeRows(show(t, r1, 'show ip route'), '10.9.0.0/16');
  ok(rows.length === 2, 'and both rows are in the table (the model has no ECMP, so one is marked)',
    JSON.stringify(rows));
  ok(rows.filter(function (r) { return /not installed/.test(r); }).length === 1,
    'exactly one of them carries the not-installed note');
}
{
  const lab = router(), t = lab.t, r1 = lab.r1;
  cli(t, r1, ['ip route 10.9.0.0 255.255.0.0 10.0.0.254']);
  const floating = cli(t, r1, ['ip route 10.9.0.0 255.255.0.0 10.0.0.254 200']);
  ok(/^Route added: 10\.9\.0\.0\/16 via 10\.0\.0\.254 \(distance 200\)$/.test(last(floating)),
    'the floating static - same next hop, another distance - is a different route',
    JSON.stringify(floating));
  const rows = routeRows(show(t, r1, 'show ip route'), '10.9.0.0/16');
  ok(rows.length === 2, 'and it prints as its own row', JSON.stringify(rows));
  ok(rows.some(function (r) {
    return /\[200\/0\]/.test(r) && /not installed: the S route for this prefix has distance 1/.test(r);
  }), 'the backup is priced 200 and says what beats it', JSON.stringify(rows));
  const again = cli(t, r1, ['ip route 10.9.0.0 255.255.0.0 10.0.0.254 200']);
  ok(/^Route unchanged: .*\(distance 200\)/.test(last(again)),
    'retyping the backup is also unchanged', JSON.stringify(again));
}
{
  const lab = router(), t = lab.t, r1 = lab.r1;
  cli(t, r1, ['ip route 10.9.0.0 255.255.0.0 10.0.0.254']);
  const explicit = cli(t, r1, ['ip route 10.9.0.0 255.255.0.0 10.0.0.254 1']);
  ok(/^Route unchanged:/.test(last(explicit)),
    'a distance of 1 typed out is the distance the route already has', JSON.stringify(explicit));
  const rc = routeLines(show(t, r1, 'show running-config'));
  ok(rc.length === 1 && rc[0].trim() === 'ip route 10.9.0.0 255.255.0.0 10.0.0.254',
    'so the saved file keeps the form that was typed first', JSON.stringify(rc));
}
{
  const lab = router(), t = lab.t, r1 = lab.r1;
  cli(t, r1, ['ip route 10.9.0.0 255.255.0.0 10.0.0.254']);
  const full = cli(t, r1, ['ip route 10.9.0.0 255.255.0.0 10.0.0.254 ' + lab.port]);
  ok(/^Route added:/.test(last(full)),
    'the fully specified form names an interface, so it is another statement', JSON.stringify(full));
  ok(r1.config.routes.length === 2, 'and the box holds both');
}

console.log('');
console.log('A route can still be removed and typed again:');
{
  const lab = router(), t = lab.t, r1 = lab.r1;
  cli(t, r1, ['ip route 10.9.0.0 255.255.0.0 10.0.0.254']);
  const removed = cli(t, r1, ['no ip route 10.9.0.0 255.255.0.0 10.0.0.254']);
  ok(last(removed) === 'Route removed', 'the no form removes it', JSON.stringify(removed));
  const back = cli(t, r1, ['ip route 10.9.0.0 255.255.0.0 10.0.0.254']);
  ok(/^Route added:/.test(last(back)), 'and the same line is added again afterwards', JSON.stringify(back));
  ok(r1.config.routes.length === 1, 'once');
}

console.log('');
console.log('The same rule in IPv6:');
{
  const lab = router(), t = lab.t, r1 = lab.r1;
  const first = cli(t, r1, ['ipv6 route 2001:db8:9::/64 2001:db8::1']);
  const second = cli(t, r1, ['ipv6 route 2001:db8:9::/64 2001:db8::1']);
  ok(/^IPv6 route 2001:db8:9::\/64 via 2001:db8::1$/.test(last(first)), 'the first line is a receipt',
    JSON.stringify(first));
  ok(/^IPv6 route unchanged: 2001:db8:9::\/64 via 2001:db8::1/.test(last(second)),
    'the second says it is already configured', JSON.stringify(second));
  ok((r1.config.routes6 || []).length === 1, 'one entry is stored', String((r1.config.routes6 || []).length));
  const rc = show(t, r1, 'show running-config').split('\n').filter(function (l) {
    return /^\s*ipv6 route /.test(l);
  });
  ok(rc.length === 1, 'and printed once', JSON.stringify(rc));
  const other = cli(t, r1, ['ipv6 route 2001:db8:9::/64 2001:db8::2']);
  ok(/^IPv6 route /.test(last(other)) && !/unchanged/.test(last(other)),
    'another next hop is a different route', JSON.stringify(other));
  ok((r1.config.routes6 || []).length === 2, 'and is stored');
}

console.log('');
console.log('Pasting a backup onto a box that already carries it does not grow the file:');
{
  const source = router();
  cli(source.t, source.r1, [
    'ip route 10.9.0.0 255.255.0.0 10.0.0.254',
    'ip route 10.9.0.0 255.255.0.0 10.0.0.254',
    'ipv6 route 2001:db8:9::/64 2001:db8::1',
    'ipv6 route 2001:db8:9::/64 2001:db8::1'
  ]);
  const rc = show(source.t, source.r1, 'show running-config');
  const target = router();
  const replay = cli(target.t, target.r1, rc.split('\n'));
  const rejected = replay.filter(function (l) { return /^%/.test(l); });
  ok(rejected.length === 0, 'the backup replays without a refusal', JSON.stringify(rejected.slice(0, 2)));
  ok(show(target.t, target.r1, 'show running-config') === rc, 'the target holds the same file');
  const again = cli(target.t, target.r1, rc.split('\n'));
  ok(again.filter(function (l) { return /^%/.test(l); }).length === 0, 'a second paste is accepted too');
  ok(show(target.t, target.r1, 'show running-config') === rc, 'and adds nothing');
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
if (failed) process.exitCode = 1;
