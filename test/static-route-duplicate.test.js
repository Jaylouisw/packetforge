'use strict';
// Typing the same static route twice leaves one row, not two.
//
// A static route is a statement, not a stack of them: `ip route 10.9.0.0 255.255.0.0 10.0.0.254` entered
// again is the same route, and the box keeps one line in the configuration and one entry in the table.
// This console pushed a second copy of the object, so
//
//   R1(config)# ip route 10.9.0.0 255.255.0.0 10.0.0.254
//   R1(config)# ip route 10.9.0.0 255.255.0.0 10.0.0.254
//   R1# show running-config
//    ip route 10.9.0.0 255.255.0.0 10.0.0.254
//    ip route 10.9.0.0 255.255.0.0 10.0.0.254
//   R1# show ip route
//   S   10.9.0.0/16 [1/0] via 10.0.0.254  (down: no cable)
//   S   10.9.0.0/16 [1/0] via 10.0.0.254  (down: no cable)  (not installed: the S route for this prefix has distance 1)
//
// The second row is the route losing to itself, which the shadowing note cannot say and no box prints.
// It also makes a backup grow: pasting show running-config onto a box that already carries the config
// adds one row per ip route / ipv6 route line, every time. A paste of a printed config is a supported
// path - test/config-roundtrip.test.js exists for exactly that property.
//
// What must not collapse: a second route to the same prefix with a different next hop (the model has no
// ECMP, and both lines belong in the config - docs/SIMULATION.md, "No ECMP"), and a route to the same
// prefix and next hop with a different administrative distance, which is the floating static
// (docs/CLI.md, "floating static"). The duplicate test therefore compares every field the command sets.
const path = require('path');
const { Device } = require('../engine');
const { CliSession } = require('../engine/cli');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  ✓ ' + msg); }
  else { failed++; console.error('  ✗ ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices')).filter(function (s) { return !s.error; });
const ROUTER = catalog.filter(function (s) { return /ASR 1001-X/.test(s.model); })[0];

function build() {
  const dev = new Device('r1', ROUTER);
  const ports = [...dev.interfaces.values()].filter(function (i) { return i.type === 'ethernet'; });
  const cli = new CliSession(dev, null, null);
  const run = function (line) { return (cli.run(line).output || []).map(String).join('\n'); };
  run('enable');
  run('configure terminal');
  run('interface ' + ports[0].name);
  run('ip address 10.0.0.1 255.255.255.0');
  run('exit');
  return { dev: dev, cli: cli, run: run, port: ports[0].name };
}
function routeLines(s) {
  return (s.cli.run('show running-config').output || []).map(String)
    .filter(function (l) { return /^\s*ip route /.test(l); });
}
function routeRows(s, pfx) {
  return (s.cli.run('show ip route').output || []).map(String)
    .filter(function (l) { return /^\s*S\*?\s/.test(l) && l.indexOf(pfx) !== -1; });
}

console.log('');
console.log('The same route typed twice is one route:');
{
  const s = build();
  const first = s.run('ip route 10.9.0.0 255.255.0.0 10.0.0.254');
  ok(/^Route added: 10\.9\.0\.0\/16 via 10\.0\.0\.254/.test(first), 'the first typing adds the route', first);
  ok((s.dev.config.routes || []).length === 1, 'one row is stored', String((s.dev.config.routes || []).length));

  const again = s.run('ip route 10.9.0.0 255.255.0.0 10.0.0.254');
  ok((s.dev.config.routes || []).length === 1, 'the second typing stores nothing new',
    JSON.stringify(s.dev.config.routes));
  ok(!/^Route added:/.test(again), 'and the receipt does not claim it added the route again', again);
  ok(/already configured/.test(again), 'it says the route is already there', again);

  ok(routeLines(s).filter(function (l) { return /10\.9\.0\.0/.test(l); }).length === 1,
    'running-config prints the line once', routeLines(s).join(' | '));
  const rows = routeRows(s, '10.9.0.0/16');
  ok(rows.length === 1, 'show ip route prints one S row for the prefix', rows.join(' | '));
  ok(!rows.some(function (l) { return /not installed/.test(l); }),
    'and nothing claims the route lost to itself', rows.join(' | '));
}

console.log('');
console.log('The fully specified order is the same route as the plain one:');
{
  const s = build();
  s.run('ip route 10.9.0.0 255.255.0.0 ' + s.port + ' 10.0.0.254');
  const again = s.run('ip route 10.9.0.0 255.255.0.0 10.0.0.254 ' + s.port);
  ok((s.dev.config.routes || []).length === 1,
    'interface-then-hop and hop-then-interface are one row', JSON.stringify(s.dev.config.routes));
  ok(/already configured/.test(again), 'the second spelling is answered as already configured', again);
  ok(s.dev.config.routes[0].iface === s.port && s.dev.config.routes[0].gw === '10.0.0.254',
    'and the row still holds the port and the next hop', JSON.stringify(s.dev.config.routes[0]));
}

console.log('');
console.log('A network written with host bits is the same prefix:');
{
  const s = build();
  s.run('ip route 10.9.5.0 255.255.0.0 10.0.0.254');
  const again = s.run('ip route 10.9.0.0 255.255.0.0 10.0.0.254');
  ok((s.dev.config.routes || []).length === 1,
    '10.9.5.0/16 and 10.9.0.0/16 are one route', JSON.stringify(s.dev.config.routes));
  ok(/already configured/.test(again), 'and the second is answered as already there', again);
}

console.log('');
console.log('Routes that really are different stay:');
{
  const s = build();
  s.run('ip route 10.9.0.0 255.255.0.0 10.0.0.254');
  s.run('ip route 10.9.0.0 255.255.0.0 10.0.0.253');
  ok((s.dev.config.routes || []).length === 2,
    'a different next hop for the same prefix is a second row', JSON.stringify(s.dev.config.routes));
  ok(routeLines(s).length === 2, 'both lines are printed', routeLines(s).join(' | '));
}
{
  const s = build();
  s.run('ip route 10.9.0.0 255.255.0.0 10.0.0.254');
  s.run('ip route 10.9.0.0 255.255.0.0 10.0.0.254 200');
  ok((s.dev.config.routes || []).length === 2,
    'the floating static (same hop, distance 200) is a second row', JSON.stringify(s.dev.config.routes));
  ok((s.dev.config.routes[1].distance === 200), 'and it keeps its distance',
    JSON.stringify(s.dev.config.routes[1]));
}

console.log('');
console.log('The removal form still removes the one row:');
{
  const s = build();
  s.run('ip route 10.9.0.0 255.255.0.0 10.0.0.254');
  s.run('ip route 10.9.0.0 255.255.0.0 10.0.0.254');
  const removed = s.run('no ip route 10.9.0.0 255.255.0.0 10.0.0.254');
  ok(/Route removed/.test(removed), 'the route is removed', removed);
  ok((s.dev.config.routes || []).length === 0, 'and nothing is left',
    JSON.stringify(s.dev.config.routes));
}

console.log('');
console.log('The IPv6 route has the same shape:');
{
  const s = build();
  const first = s.run('ipv6 route 2001:db8:9::/64 2001:db8::1');
  ok(/^IPv6 route 2001:db8:9::\/64 via 2001:db8::1/.test(first), 'the first typing adds it', first);
  const again = s.run('ipv6 route 2001:db8:9::/64 2001:db8::1');
  ok((s.dev.config.routes6 || []).length === 1, 'the second typing stores nothing new',
    JSON.stringify(s.dev.config.routes6));
  ok(/already configured/.test(again), 'and says it is already there', again);
  const v6lines = (s.cli.run('show running-config').output || []).map(String)
    .filter(function (l) { return /^\s*ipv6 route /.test(l); });
  ok(v6lines.length === 1, 'the IPv6 line is printed once', v6lines.join(' | '));
}
{
  const s = build();
  s.run('ipv6 route 2001:db8:9::/64 2001:db8::1');
  s.run('ipv6 route 2001:db8:9::/64 2001:db8::2');
  ok((s.dev.config.routes6 || []).length === 2,
    'a different IPv6 next hop is a second row', JSON.stringify(s.dev.config.routes6));
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
if (failed) process.exitCode = 1;
