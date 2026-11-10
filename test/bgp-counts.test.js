'use strict';
// bgp-counts.test.js - "installed" was a count of what had been received.
//
//   R1#show ip bgp summary
//   2 of 2 neighbour(s) established
//   2 prefix(es) installed from BGP      <- and the routing table had no BGP row installed
//   R1#show ip bgp
//   *  10.0.0.0/24 ...                   <- neither row forwarding; the connected routes win
//
// Three views, one fact, two answers. The summary counts the routing table's answer now, and says
// how many arrived as well, so a reader can tell "received" from "installed". The neighbour detail
// counts the same way, because it is the same fact.
//
// Alongside it: the table listed only what was *received*, so a box announcing its own subnets had a
// table that did not show them - and the refusal for `network` promised the table "lists what it
// would send". It does now. That refusal also promised static routes are announced; they are not, so
// the sentence says what the engine actually does.
const path = require('path');
const { Topology, Simulator } = require('../engine');
const { CliSession } = require('../engine/cli');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg); }
}
function text(out) { return out && out.output ? out.output.join('\n') : String(out); }
const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
const find = function (m) { return catalog.filter(function (x) { return x.model === m; })[0]; };

function router(t, name, sim, cfg) {
  const d = t.addDevice(find('generic-router')); d.name = name;
  const s = new CliSession(d, t, sim); s.run('enable'); s.run('configure terminal');
  for (const step of (cfg || [])) s.run(step);
  s.run('end');
  return { dev: d, cli: s };
}

console.log('A prefix that loses on distance is received, not installed:');
{
  // R1 peers with two routers; each advertises its own connected subnet, which R1 also holds.
  const t = new Topology();
  const sim = new Simulator(t);
  const a = router(t, 'R1', sim, []);
  const b = router(t, 'R2', sim, []);
  const d = router(t, 'R3', sim, []);
  t.connect(a.dev.id, 'Gi0/0', b.dev.id, 'Gi0/0');
  t.connect(a.dev.id, 'Gi0/1', d.dev.id, 'Gi0/0');
  a.cli.run('configure terminal');
  a.cli.run('interface Gi0/0'); a.cli.run('ip address 10.0.0.1 255.255.255.0'); a.cli.run('exit');
  a.cli.run('interface Gi0/1'); a.cli.run('ip address 10.1.0.1 255.255.255.0'); a.cli.run('exit');
  a.cli.run('router bgp 65001');
  a.cli.run('neighbor 10.0.0.2 remote-as 65002');
  a.cli.run('neighbor 10.1.0.2 remote-as 65003');
  a.cli.run('exit'); a.cli.run('end');
  // R2 and R3 have no other subnet, so what they send is the link subnet R1 already holds.
  b.cli.run('configure terminal');
  b.cli.run('interface Gi0/0'); b.cli.run('ip address 10.0.0.2 255.255.255.0'); b.cli.run('exit');
  b.cli.run('router bgp 65002'); b.cli.run('neighbor 10.0.0.1 remote-as 65001'); b.cli.run('exit'); b.cli.run('end');
  d.cli.run('configure terminal');
  d.cli.run('interface Gi0/0'); d.cli.run('ip address 10.1.0.2 255.255.255.0'); d.cli.run('exit');
  d.cli.run('router bgp 65003'); d.cli.run('neighbor 10.1.0.1 remote-as 65001'); d.cli.run('exit'); d.cli.run('end');

  const summary = text(a.cli.run('show ip bgp summary'));
  ok(/2 prefix\(es\) received, 0 installed/.test(summary),
    'the summary separates received from installed: ' +
      (summary.split('\n').filter(function (l) { return /prefix\(es\)/.test(l); })[0] || '').trim());
  ok(/lose on distance/.test(summary), 'and says why none is installed');
  const table = text(a.cli.run('show ip bgp'));
  const received = table.split('\n').filter(function (l) {
    return /^\s*\*\s+\d/.test(l);
  });
  ok(received.length === 2, 'the table marks both received rows as losing (' + received.length + ')');
  ok(!/^\s*\*>\s+10\.0\.0\.0\/24\s+10\.0\.0\.2/m.test(table),
    'and marks neither as forwarding');
  const rib = text(a.cli.run('show ip route'));
  ok(!/^\s*\*\s+B\s/m.test(rib), 'the routing table installs no BGP row either');
  const detail = text(a.cli.run('show ip bgp neighbors 10.0.0.2'));
  ok(/Prefixes in\s+2 \(received\)/.test(detail), 'the peer detail counts what arrived');
  ok(/0 installed - the rest lose on distance/.test(detail),
    'and the same installed count the summary gives');
}

console.log('\nWhen every received prefix is installed, both views say so:');
{
  // R1 -- R2, where R2 also holds a subnet R1 does not have.
  const t = new Topology();
  const sim = new Simulator(t);
  const a = router(t, 'R1', sim, []);
  const b = router(t, 'R2', sim, []);
  t.connect(a.dev.id, 'Gi0/0', b.dev.id, 'Gi0/0');
  a.cli.run('configure terminal');
  a.cli.run('interface Gi0/0'); a.cli.run('ip address 10.0.0.1 255.255.255.0'); a.cli.run('exit');
  a.cli.run('router bgp 65001'); a.cli.run('neighbor 10.0.0.2 remote-as 65002'); a.cli.run('exit'); a.cli.run('end');
  b.cli.run('configure terminal');
  b.cli.run('interface Gi0/0'); b.cli.run('ip address 10.0.0.2 255.255.255.0'); b.cli.run('exit');
  b.cli.run('interface Gi0/1'); b.cli.run('ip address 192.168.5.1 255.255.255.0'); b.cli.run('exit');
  b.cli.run('router bgp 65002'); b.cli.run('neighbor 10.0.0.1 remote-as 65001'); b.cli.run('exit'); b.cli.run('end');
  const summary = text(a.cli.run('show ip bgp summary'));
  ok(/2 prefix\(es\) received, 1 installed/.test(summary),
    'one of the two is installed: ' + (summary.split('\n').filter(function (l) {
      return /prefix\(es\)/.test(l);
    })[0] || '').trim());
  const rib = text(a.cli.run('show ip route'));
  ok(/^\s*\*\s+B\s+192\.168\.5\.0\/24/m.test(rib), 'and that is the far subnet, per show ip route');
}

console.log('\nThe table lists what this router announces:');
{
  const t = new Topology();
  const sim = new Simulator(t);
  const a = router(t, 'R1', sim, []);
  a.cli.run('configure terminal');
  a.cli.run('interface Gi0/0'); a.cli.run('ip address 10.0.0.1 255.255.255.0'); a.cli.run('exit');
  a.cli.run('router bgp 65001'); a.cli.run('exit'); a.cli.run('end');
  const table = text(a.cli.run('show ip bgp'));
  const local = table.split('\n').filter(function (l) { return /^\s*\*>/.test(l); })[0];
  ok(!!local, 'the local prefix is in the table with next hop 0.0.0.0: ' + (local || '').trim());
  ok(/10\.0\.0\.0\/24/.test(local || ''), 'and it is the subnet the box holds');
  ok(/announces the subnets it has an address on/.test(table),
    'and the answer says what the announcement rule is');
}

console.log('\nThe refusal for `network` states the rule the engine follows:');
{
  const t = new Topology();
  const sim = new Simulator(t);
  const a = router(t, 'R1', sim, []);
  const b = router(t, 'R2', sim, []);
  t.connect(a.dev.id, 'Gi0/0', b.dev.id, 'Gi0/0');
  a.cli.run('configure terminal');
  a.cli.run('interface Gi0/0'); a.cli.run('ip address 10.0.0.1 255.255.255.0'); a.cli.run('exit');
  a.cli.run('ip route 172.16.0.0 255.255.0.0 10.0.0.2');
  a.cli.run('router bgp 65001');
  // A refusal is several lines, each prefixed `% `; join them into the sentence they are.
  const refusal = text(a.cli.run('network 172.16.0.0 mask 255.255.0.0')).replace(/\n% /g, ' ');
  a.cli.run('neighbor 10.0.0.2 remote-as 65002'); a.cli.run('exit'); a.cli.run('end');
  b.cli.run('configure terminal');
  b.cli.run('interface Gi0/0'); b.cli.run('ip address 10.0.0.2 255.255.255.0'); b.cli.run('exit');
  b.cli.run('router bgp 65002'); b.cli.run('neighbor 10.0.0.1 remote-as 65001'); b.cli.run('exit'); b.cli.run('end');
  ok(/announces the subnets it has an address\s+on, and nothing else/.test(refusal),
    'the refusal says connected subnets only');
  ok(/there is no "redistribute" either/.test(refusal), 'and that no redistribute exists');
  ok(!/static ones/.test(refusal),
    'it does not promise static routes, which it used to do and the engine never did');
  // The promise and the behaviour agree: a static route is not announced.
  const peerTable = text(b.cli.run('show ip bgp'));
  ok(!/172\.16\.0\.0/.test(peerTable), 'and indeed the static route never reaches the peer');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
