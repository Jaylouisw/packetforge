'use strict';
// The second number in `[110/n]`: what `show ip route` prints for a route OSPF learned.
//
// Every row printed `[110/0]` whatever the topology. The distance half was right - OSPF's administrative
// distance is 110 - and the metric half was a literal zero, so two OSPF paths to the same prefix were
// indistinguishable in the one column an operator reads to tell them apart, and an `O` row could not be
// checked against the cost the same box prints in `show ip ospf interface`.
//
// What the device prints, and why:
//
//   * The bracket is [administrative distance/metric]. Cisco's `show ip route` command reference reads
//     "[160/5]  The first number in the brackets is the administrative distance of the information source;
//     the second number is the metric for the route."
//     https://www.cisco.com/E-Learning/bulk/public/tac/cim/cib/using_cisco_ios_software/cmdrefs/show_ip_route.htm
//     and the administrative-distance note works the same sample through: "In this case, [110/2] means that
//     the route has an administrative distance of 110 and an OSPF metric of 2."
//     http://cisco.com/c/en/us/support/docs/ip/border-gateway-protocol-bgp/15986-admin-distance.pdf
//   * The OSPF metric of a route to a network is the distance to the router that advertises it plus the cost
//     of that network link - RFC 2328 section 16.1, second stage: "D is equal to the distance from the root to
//     the router vertex (calculated in stage 1), plus the stub network link's advertised cost."
//   * A path costs the sum of the costs *the sending routers advertise*: RFC 2328 section 16.1 defines the
//     link state cost of a path as "the sum of the costs of the path's constituent links (as advertised in
//     router-LSAs)", and a router-LSA advertises the output cost of the interface the packet leaves by. The
//     engine used to add both ends of every link together, which priced a hop as though the packet left by
//     both interfaces; a hop is now what its sender says it costs.
//   * A loopback is a stub link of cost 0 (RFC 2328 section 12.4.1), so a route to a router's /32 is the
//     distance to that router and nothing more.
//
// The lab is the one Cisco's own sample uses: two routers on a gigabit segment, one LAN behind each, so the
// route to the far LAN is [110/2] - one for the interface it leaves by, one for the LAN's own link.
const path = require('path');
const { Topology, Simulator, runCommands } = require('../engine');
const { CliSession } = require('../engine/cli');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices')).filter(function (s) { return !s.error; });
const ROUTER = catalog.filter(function (s) { return /ASR 1001-X/.test(s.model); })[0] ||
  catalog.filter(function (s) { return /^ISR 4331$/.test(s.model); })[0];

// r1 -- r2 -- r3, with a LAN on r1 and another on r3.
function lab(opts) {
  opts = opts || {};
  const t = new Topology();
  const r1 = t.addDevice(ROUTER, 'r1');
  const r2 = t.addDevice(ROUTER, 'r2');
  const r3 = t.addDevice(ROUTER, 'r3');
  t.connect('r1', 'Gi0/0/0', 'r2', 'Gi0/0/0');
  t.connect('r2', 'Gi0/0/1', 'r3', 'Gi0/0/0');
  const sim = new Simulator(t);
  const cfg = function (dev, lines) {
    runCommands(dev, t, sim, ['configure terminal'].concat(lines));
  };
  cfg(r1, ['ospf router-id 1.1.1.1',
    'interface Gi0/0/0', 'ip address 10.0.12.1 255.255.255.0', 'exit',
    'interface Gi0/0/1', 'ip address 192.168.1.1 255.255.255.0', 'exit']);
  cfg(r2, ['ospf router-id 2.2.2.2',
    'interface Gi0/0/0', 'ip address 10.0.12.2 255.255.255.0', 'exit',
    'interface Gi0/0/1', 'ip address 10.0.23.2 255.255.255.0',
    (opts.r2Cost === undefined ? 'exit' : 'ip ospf cost ' + opts.r2Cost), 'exit']);
  cfg(r3, ['ospf router-id 3.3.3.3',
    'interface Gi0/0/0', 'ip address 10.0.23.3 255.255.255.0', 'exit',
    'interface Gi0/0/1', 'ip address 192.168.3.1 255.255.255.0', 'exit']);
  if (opts.staticDefault) cfg(r2, ['ip route 0.0.0.0 0.0.0.0 ' + opts.staticDefault]);
  sim.computeOspf();
  return { t: t, sim: sim, r1: r1, r2: r2, r3: r3 };
}

function show(env, dev, cmd) {
  return ((new CliSession(dev, env.t, env.sim).run(cmd).output) || []).map(String).join('\n');
}

function row(env, dev, prefix) {
  return show(env, dev, 'show ip route').split('\n').filter(function (l) {
    return l.indexOf('O ') === 0 || l.indexOf('O  ') === 0;
  }).filter(function (l) { return l.indexOf(prefix) !== -1; })[0] || '';
}

console.log('');
console.log('An OSPF route carries its cost, not a zero:');
{
  const env = lab();
  const far = row(env, env.r2, '192.168.1.0');
  ok(far !== '', 'r2 has an O route to the LAN behind r1', show(env, env.r2, 'show ip route'));
  ok(/\[110\/2\]/.test(far), 'and prints [110/2]: 1 for the port it leaves by, 1 for the LAN link', far);
  ok(row(env, env.r2, '10.0.12.0') === '', 'the segment r2 is on is C, not O');
  const third = row(env, env.r1, '192.168.3.0');
  ok(/\[110\/3\]/.test(third), 'r1 reaches the LAN behind r3 at [110/3]', third);
  const all = show(env, env.r2, 'show ip route');
  ok(!/\[110\/0\]/.test(all), 'no OSPF row prints a metric of 0 any more', all);
  ok(/192\.168\.1\.0\s+\/24\s+\[110\/2\] via 10\.0\.12\.1/.test(all),
    'the row reads in the device order: prefix, bracket, next hop', all);
  ok(/C\s+10\.0\.12\.0\s+\/24\s+is directly connected/.test(all) && !/is directly connected.*\[/.test(all),
    'and a connected route still has no bracket at all', all);
}

console.log('');
console.log('A configured cost is the number the metric is built from:');
{
  const env = lab({ r2Cost: 10 });
  const far = row(env, env.r2, '192.168.3.0');
  ok(/\[110\/11\]/.test(far), 'ip ospf cost 10 on the link plus the LAN link is [110/11]', far);
  const fromR1 = row(env, env.r1, '192.168.3.0');
  ok(/\[110\/12\]/.test(fromR1), 'and r1 pays its own hop too: [110/12]', fromR1);
  const iface = show(env, env.r2, 'show ip ospf interface');
  ok(/Gi0\/0\/1\s+10\.0\.23\.2\/24\s+0\s+10\s+configured/.test(iface),
    'the interface report names the same cost the metric was built from', iface);
}

console.log('');
console.log('The metric is the protocol cost, not a distance: a static route keeps 0 there:');
{
  const env = lab({ staticDefault: '10.0.12.1' });
  const text = show(env, env.r2, 'show ip route');
  // The code is `S*` now: the asterisk marks the row as a candidate default, and on IOS it belongs to every
  // route to 0.0.0.0/0 rather than to one particular row (research/show-ip-route-candidate-default.md).
  ok(/S\*\s+0\.0\.0\.0\s+\/0\s+\[1\/0\] via 10\.0\.12\.1/.test(text),
    'a static default is S*, [1/0] - distance 1, metric 0 - as the device prints it', text);
  ok(/\[110\/2\]/.test(text), 'and the O row beside it still carries its cost', text);
}

console.log('');
console.log('Both surfaces read the same field:');
{
  const env = lab();
  const rows = env.r2.routesTable(env.t);
  const ospfRows = rows.filter(function (r) { return r.type === 'ospf'; });
  ok(ospfRows.length > 0, 'the inspector table holds the OSPF rows', String(rows.length));
  ok(ospfRows.every(function (r) { return r.metric > 0; }),
    'every OSPF row carries a positive metric', JSON.stringify(ospfRows.map(function (r) { return r.metric; })));
  ok(rows.filter(function (r) { return r.type === 'static'; }).every(function (r) { return r.metric === 0; }),
    'and every static row carries the 0 it really has');
  const printed = row(env, env.r2, '192.168.1.0');
  const field = ospfRows.filter(function (r) { return r.dest === '192.168.1.0'; })[0];
  ok(field && printed.indexOf('[' + field.distance + '/' + field.metric + ']') !== -1,
    'the console prints the bracket the table holds, not a second calculation',
    printed + ' vs ' + JSON.stringify(field));
}

console.log('');
console.log('A loopback is a stub link of cost 0 (RFC 2328 section 12.4.1):');
{
  const ospf = require('../engine/ospf');
  const routers = [
    { id: 'a', routerId: '1.1.1.1', areaId: 0, interfaces: [
      { name: 'e', ip: '10.0.12.1', mask: '255.255.255.0', cost: 10 },
      { name: 'lo', ip: '1.1.1.1', mask: '255.255.255.255' }] },
    { id: 'b', routerId: '2.2.2.2', areaId: 0, interfaces: [
      { name: 'e', ip: '10.0.12.2', mask: '255.255.255.0', cost: 10 },
      { name: 'lo', ip: '2.2.2.2', mask: '255.255.255.255' }] }
  ];
  const links = [{ a: { router: 'a', iface: 'e' }, b: { router: 'b', iface: 'e' } }];
  const g = ospf.buildGraph(routers, links);
  const routes = ospf.routesFromSpt(g, 'a', ospf.spf(g, 'a'));
  const lo = routes.filter(function (r) { return r.dest === '2.2.2.2'; })[0];
  ok(lo && lo.cost === 10, 'the /32 costs the one hop to b and nothing for the loopback itself',
    JSON.stringify(routes));
  ok(!routes.filter(function (r) { return r.dest === '10.0.12.0'; })[0],
    'and b transit link is not re-advertised to a', JSON.stringify(routes));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
