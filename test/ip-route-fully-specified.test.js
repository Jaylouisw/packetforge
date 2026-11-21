'use strict';
// `ip route <prefix> <mask> <interface> <next-hop>` - the vendor's FULLY SPECIFIED static route.
//
// The syntax line is `ip route prefix mask { ip-address | interface-type interface-number [ip-address] }
// [distance]` (Cisco IOS IP Routing: Protocol-Independent Command Reference, `ip route`), so the next hop
// comes *after* the exit interface, never before it. This console read every word past the fifth as a port
// name or a distance, so the documented form was refused:
//
//   R1(config)# ip route 10.2.3.0 255.255.255.0 g0/0/0 10.1.2.2
//   % 10.2.3.0/24: no interface called "10.1.2.2"
//
// and a CCNA lab types exactly that line and gets a route:
//
//   R1(config)# ip route 10.2.3.0 255.255.255.0 g0/0/0 10.1.2.2
//   R1# show ip route
//   S 10.2.3.0/24 [1/0] via 10.1.2.2, GigabitEthernet0/0/0
//     https://itexamanswers.net/6-1-2-lab-investigate-static-routes-answers.html
//
// The same row appears in Manning's *Acing the CCNA Exam* for `ip route 192.168.3.0 255.255.255.0 g0/0
// 192.168.12.2`: `S 192.168.3.0/24 [1/0] via 192.168.12.2, GigabitEthernet0/0`
//   https://livebook.manning.com/learn/concepts/fully-specified-static-route--technique/acing-the-ccna-exam-fundamentals-and-protocols
// The printed row is not new here - `show ip route` already prints `via <hop>, <port>` for a row that holds
// both (research/show-ip-route-interface-spelling.md); what was missing was a way to *type* the route.
//
// The removal form repeats the words that made the route, so it takes the same order. Two removal bugs came
// out of the same slot: a port in the fifth position was matched against the row's `gw` (always null for a
// directly connected route), so `no ip route <prefix> <mask> <iface>` answered `% Route not found` for a
// route that was in the table.
//
// What is still open (running-config's word order for this shape) is in research/ip-route-fully-specified.md.
const path = require('path');
const { Device } = require('../engine');
const { CliSession } = require('../engine/cli');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices')).filter(function (s) { return !s.error; });
const ROUTER = catalog.filter(function (s) { return /ASR 1001-X/.test(s.model); })[0];

function build() {
  const dev = new Device('r1', ROUTER);
  const ports = [...dev.interfaces.values()].filter(function (i) { return i.type === 'ethernet'; });
  const cli = new CliSession(dev, null, null);
  const cfg = function (lines) { return lines.map(function (l) { return cli.run(l).output.join('\n'); }); };
  cfg(['configure terminal']);
  cfg(['interface ' + ports[0].name, 'ip address 10.1.2.3 255.255.255.0', 'no shutdown', 'exit']);
  return { dev: dev, cli: cli, ports: ports, cfg: cfg };
}
function show(s, cmd) { return (s.cli.run(cmd).output || []).map(String); }
function rows(lines) { return lines.filter(function (l) { return /^[A-Z]\*?\s/.test(l) && !/^Codes:/.test(l); }); }
function rowFor(s, pfx) { return rows(show(s, 'show ip route')).filter(function (l) { return l.indexOf(pfx) !== -1; }); }

console.log('');
console.log('The documented order - interface, then next hop - is accepted and prints the vendor row');
{
  const s = build();
  const p = s.ports[1].name;
  const said = s.cfg(['ip route 10.2.3.0 255.255.255.0 ' + p + ' 10.1.2.2']).join(' | ');
  ok(!/^%/m.test(said), 'the line is not refused', said);
  const stored = s.dev.config.routes.filter(function (r) { return r.dest === '10.2.3.0'; })[0];
  ok(stored && stored.gw === '10.1.2.2', 'the next hop is stored as the gateway', JSON.stringify(stored));
  ok(stored && stored.iface === p, 'and the interface is stored as the exit port', JSON.stringify(stored));

  const row = rowFor(s, '10.2.3.0/24');
  ok(row.length === 1, 'the table holds one row for it', row.join(' | '));
  const long = require('../engine/iface-name').displayName(p);
  ok(/^S\s+10\.2\.3\.0\/24 \[1\/0\] via 10\.1\.2\.2, /.test(row[0] || ''),
    'and it reads S, the prefix, [1/0] via the hop, then the port', row[0]);
  ok((row[0] || '').indexOf(', ' + long) !== -1, 'naming the port after the comma', row[0]);
  const r = s.dev.routeTo('10.2.3.9');
  ok(r && r.via === '10.1.2.2' && r.ad === 1,
    'forwarding goes to the next hop at distance 1', JSON.stringify(r));
}

console.log('');
console.log('A distance after the next hop is the distance, and the bracket prices it');
{
  const s = build();
  const p = s.ports[1].name;
  const said = s.cfg(['ip route 10.2.4.0 255.255.255.0 ' + p + ' 10.1.2.2 40']).join(' | ');
  ok(!/^%/m.test(said), 'the line is accepted', said);
  const stored = s.dev.config.routes.filter(function (r) { return r.dest === '10.2.4.0'; })[0];
  ok(stored && stored.gw === '10.1.2.2' && stored.iface === p && Number(stored.distance) === 40,
    'both halves and the distance are stored', JSON.stringify(stored));
  const row = rowFor(s, '10.2.4.0/24');
  ok(/\[40\/0\] via 10\.1\.2\.2, /.test(row[0] || ''), 'the row shows [40/0]', row[0]);
}

console.log('');
console.log('The order this console already took still works, and the row is the same one');
{
  const s = build();
  const p = s.ports[1].name;
  s.cfg(['ip route 10.2.5.0 255.255.255.0 10.1.2.2 ' + p]);
  const row = rowFor(s, '10.2.5.0/24');
  ok(/^S\s+10\.2\.5\.0\/24 \[1\/0\] via 10\.1\.2\.2, /.test(row[0] || ''),
    'next hop first, then the port, prints the same shape', row[0]);
  const stored = s.dev.config.routes.filter(function (r) { return r.dest === '10.2.5.0'; })[0];
  ok(stored && stored.gw === '10.1.2.2' && stored.iface === p,
    'and stores the same two facts', JSON.stringify(stored));
}

console.log('');
console.log('A second next hop is refused, not taken as a replacement');
{
  const s = build();
  const p = s.ports[1].name;
  const before = s.dev.config.routes.length;
  const said = s.cfg(['ip route 10.2.6.0 255.255.255.0 ' + p + ' 10.1.2.2 10.1.2.9']).join(' | ');
  ok(/a route takes one next hop, and 10\.1\.2\.2 is already it/.test(said),
    'the refusal names the hop already given', said);
  ok(s.dev.config.routes.length === before, 'and nothing was installed', String(s.dev.config.routes.length));
}

console.log('');
console.log('The no-form removes the route by the words that made it');
{
  const s = build();
  const p = s.ports[1].name;
  s.cfg([
    'ip route 10.2.7.0 255.255.255.0 ' + p + ' 10.1.2.2',
    'ip route 10.2.7.0 255.255.255.0 10.1.2.9'          // same prefix, recursive, must survive
  ]);
  let left = s.dev.config.routes.filter(function (r) { return r.dest === '10.2.7.0'; });
  ok(left.length === 2, 'two candidates are configured', JSON.stringify(left));
  const said = s.cfg(['no ip route 10.2.7.0 255.255.255.0 ' + p + ' 10.1.2.2']).join(' | ');
  ok(/Route removed/.test(said), 'the fully specified form is removed', said);
  left = s.dev.config.routes.filter(function (r) { return r.dest === '10.2.7.0'; });
  ok(left.length === 1 && left[0].gw === '10.1.2.9' && !left[0].iface,
    'the recursive route for the same prefix is untouched', JSON.stringify(left));

  // And the interface-only removal, which used to match no row at all.
  const s2 = build();
  const q = s2.ports[2].name;
  s2.cfg(['ip route 10.2.8.0 255.255.255.0 ' + q, 'ip route 10.2.8.0 255.255.255.0 10.1.2.9']);
  const said2 = s2.cfg(['no ip route 10.2.8.0 255.255.255.0 ' + q]).join(' | ');
  ok(/Route removed/.test(said2), 'the interface-only form removes its route', said2);
  const left2 = s2.dev.config.routes.filter(function (r) { return r.dest === '10.2.8.0'; });
  ok(left2.length === 1 && left2[0].gw === '10.1.2.9',
    'and leaves the recursive route to the same prefix alone', JSON.stringify(left2));
}

console.log('');
console.log('A distance names one row, not every candidate for the prefix');
{
  const s = build();
  const p = s.ports[1].name;
  s.cfg([
    'ip route 10.2.9.0 255.255.255.0 ' + p + ' 10.1.2.2',
    'ip route 10.2.9.0 255.255.255.0 ' + p + ' 10.1.2.2 200'
  ]);
  const said = s.cfg(['no ip route 10.2.9.0 255.255.255.0 ' + p + ' 10.1.2.2 200']).join(' | ');
  ok(/Route removed/.test(said), 'the distance-200 row is removed', said);
  const left = s.dev.config.routes.filter(function (r) { return r.dest === '10.2.9.0'; });
  ok(left.length === 1 && left[0].distance === undefined,
    'the distance-1 row with the same hop and port stays', JSON.stringify(left));
}

console.log('');
console.log('The saved file replays without a refused line');
{
  const s = build();
  const p = s.ports[1].name;
  s.cfg([
    'ip route 10.3.1.0 255.255.255.0 ' + p + ' 10.1.2.2',
    'ip route 10.3.2.0 255.255.255.0 ' + p + ' 10.1.2.2 40',
    'ip route 10.3.3.0 255.255.255.0 ' + p
  ]);
  const printed = show(s, 'show running-config').join('\n').split('\n')
    .filter(function (l) { return /^ip route /.test(l); });
  ok(printed.length === 3, 'three route lines are printed', JSON.stringify(printed));
  const fresh = build();
  const errs = [];
  for (const line of printed) {
    for (const l of fresh.cfg([line])) if (/^%/.test(String(l))) errs.push(String(l));
  }
  ok(errs.length === 0, 'and every one of them is taken back by this parser', JSON.stringify(errs));
  ok(fresh.dev.config.routes.length === 3, 'with all three routes restored',
    JSON.stringify(fresh.dev.config.routes));
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
