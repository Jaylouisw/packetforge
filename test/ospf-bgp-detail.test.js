'use strict';
// ospf-bgp-detail.test.js - two shows that answered a different question than they named.
//
// Measured before this pass, on two routers peered in OSPF and in BGP:
//   R1#show ip ospf database
//   Routing Process "ospf 1" with ID 1.1.1.1
//     Area 0
//     Interfaces:
//       Interface  Cost  Area  State
//       Gi0/0      10    0     active
//       Gi0/1      10    0     active
//     Neighbors: 1 (1 FULL)
//   R1#show ip ospf interface      <- byte for byte the same output
//
//   R1#show ip bgp neighbors       <- the summary table again, under another name
//   Neighbor  V  AS     State        Reason
//   10.9.0.2  4  65002  Established  eBGP
//
// So the link-state database had no command, and neither did per-peer BGP detail - the two shows
// an operator types when a route is missing. `show ip bgp summary` on a freshly configured peer
// also answered "0 of 0 neighbour(s) established ... run a simulation" with a simulator attached.
const path = require('path');
const { Topology, Simulator, CliSession } = require('../engine');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg); }
}
function eq(actual, expected, msg) {
  ok(actual === expected, msg + (actual === expected ? '' : ' (got ' + JSON.stringify(actual) + ')'));
}
function match(re, haystack, msg) {
  const text = Array.isArray(haystack) ? haystack.join('\n') : String(haystack);
  ok(re.test(text), msg + (re.test(text) ? '' : ' (no match in ' + JSON.stringify(text.slice(0, 500)) + ')'));
}
function noMatch(re, haystack, msg) {
  const text = Array.isArray(haystack) ? haystack.join('\n') : String(haystack);
  ok(!re.test(text), msg + (re.test(text) ? ' (found ' + re + ')' : ''));
}
const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
const ROUTER = catalog.find(function (s) { return s.model === 'generic-router'; });

// R1 -- R2, both in OSPF area 0 and BGP, each with a LAN behind it.
function lab(opts) {
  const o = opts || {};
  const t = new Topology();
  const r1 = t.addDevice(ROUTER); r1.name = 'R1';
  const r2 = t.addDevice(ROUTER); r2.name = 'R2';
  t.connect(r1.id, 'Gi0/0', r2.id, 'Gi0/0');
  const sim = new Simulator(t);
  const cliFor = function (d) {
    const s = new CliSession(d, t, sim);
    s.run('enable');
    return s;
  };
  const a = cliFor(r1), b = cliFor(r2);
  const cfg = function (s, cmds) {
    s.run('configure terminal');
    for (const c of cmds) s.run(c);
    s.run('end');
  };
  cfg(a, ['hostname R1', 'interface Gi0/0', 'ip address 10.9.0.1 255.255.255.0', 'exit',
    'interface Gi0/1', 'ip address 10.0.0.1 255.255.255.0', 'exit',
    'ospf router-id 1.1.1.1', 'ospf area ' + (o.area1 === undefined ? 0 : o.area1),
    'interface Gi0/0', 'ip ospf area ' + (o.area1 === undefined ? 0 : o.area1), 'exit',
    'interface Gi0/1', 'ip ospf area ' + (o.area1 === undefined ? 0 : o.area1), 'exit']);
  cfg(b, ['hostname R2', 'interface Gi0/0', 'ip address 10.9.0.2 255.255.255.0', 'exit',
    'interface Gi0/1', 'ip address 10.1.0.1 255.255.255.0', 'exit',
    'ospf router-id 2.2.2.2', 'ospf area ' + (o.area2 === undefined ? 0 : o.area2),
    'interface Gi0/0', 'ip ospf area ' + (o.area2 === undefined ? 0 : o.area2), 'exit',
    'interface Gi0/1', 'ip ospf area ' + (o.area2 === undefined ? 0 : o.area2), 'exit']);
  if (o.bgp !== false) {
    cfg(a, ['router bgp 65001', 'bgp neighbor 10.9.0.2 remote-as 65002', 'exit']);
    cfg(b, ['router bgp 65002', 'bgp neighbor 10.9.0.1 remote-as 65001', 'exit']);
  }
  return { t: t, sim: sim, r1: r1, r2: r2, a: a, b: b, cfg: cfg };
}

console.log('\nThe link-state database is the database, not the interface table:');
{
  const env = lab();
  const db = env.a.run('show ip ospf database').output;
  const ifaces = env.a.run('show ip ospf interface').output;
  ok(db.join('\n') !== ifaces.join('\n'),
    'the two commands no longer print the same table');
  match(/^OSPF link-state database for process 1 \(ID 1\.1\.1\.1\)/m, db,
    'the database names the process it belongs to');
  match(/links carry no age or\s*\n?\s*sequence number/, db,
    'and says what it cannot show, instead of inventing an age');
  noMatch(/LS Age|Seq#/, db, 'there is no fabricated LS age or sequence number');
  match(/Router Link States \(Area 0\)/, db, 'the router link states are listed per area');
  // R1's own two links, with the adjacency each produced.
  match(/1\.1\.1\.1\s+1\.1\.1\.1\s+Gi0\/0\s+10\s+2\.2\.2\.2\s+FULL/, db,
    'the link with a neighbour carries the peer and the adjacency state');
  match(/1\.1\.1\.1\s+1\.1\.1\.1\s+Gi0\/1\s+10\s+-\s+stub/, db,
    'and a link with nobody on it is a stub, not a blank');
  match(/2\.2\.2\.2\s+2\.2\.2\.2\s+Gi0\/0\s+-\s+1\.1\.1\.1\s+FULL/, db,
    'the peer\'s own link state is in the database too');
  // The prefix the SPF installed, which is what the database is for.
  match(/Prefixes this database produced:/, db, 'the prefixes it produced are listed');
  match(/10\.1\.0\.0\/24\s+10\.9\.0\.2\s+Gi0\/0\s+20/, db,
    'with the prefix, next hop, interface and cost');
  // ...and it agrees with the route table, which is the point of showing it here.
  match(/O 10\.1\.0\.0\/24\s+110\s+10\.9\.0\.2/, env.a.run('show ip route').output,
    'and the route table agrees with it');
}

console.log('\nThe database is per area, and an area mismatch is named:');
{
  const env = lab({ area1: 0, area2: 1 });
  const db = env.a.run('show ip ospf database').output;
  match(/Router Link States \(Area 0\)/, db, 'this router\'s links are in its own area');
  noMatch(/\(Area 1\)/, db, 'and an area it has no links in is not invented');
  match(/R2 on Gi0\/0 advertises area 1 - excluded from this database/, db,
    'a peer in another area is reported as excluded, with why');
  noMatch(/10\.1\.0\.0\/24/, db, 'and it contributed no prefix');
  match(/\(none - no SPF result has been installed/, db,
    'so the prefix list says none rather than showing a route it did not build');
}

console.log('\nNo OSPF at all is answered, not crashed:');
{
  const t = new Topology();
  const r1 = t.addDevice(ROUTER); r1.name = 'R1';
  const s = new CliSession(r1, t, new Simulator(t));
  s.run('enable');
  match(/% OSPF is not enabled/, s.run('show ip ospf database').output,
    'a router with no process says so');
}

console.log('\nSub-words are accepted or refused by name:');
{
  const env = lab();
  eq(env.a.run('show ip ospf interface').output[0],
    env.a.run('show ip ospf').output[0],
    '`show ip ospf interface` is the process view');
  // The list now includes a process id, because `show ip ospf <pid>` is a real form (see
  // test/instant-vs-argument.test.js) - the assertion follows the message, and still checks that an
  // unknown sub-word is refused by naming what does exist.
  match(/% show ip ospf takes neighbor, database, interface or a process id, not "routes"/,
    env.a.run('show ip ospf routes').output,
    'an unknown sub-word is refused, listing what exists');
}

console.log('\nBGP neighbours are per peer, and a down peer says why:');
{
  const env = lab();
  const detail = env.a.run('show ip bgp neighbors').output;
  ok(detail.join('\n') !== env.a.run('show ip bgp summary').output.join('\n'),
    'the detail is not the summary under another name');
  match(/BGP neighbour 10\.9\.0\.2 on R1 \(local AS 65001\)/, detail, 'the peer is named');
  match(/Remote AS\s+65002 \(eBGP\)/, detail, 'with its AS and session type');
  match(/State\s+Established/, detail, 'and the session state');
  match(/Hold time\s+180 s/, detail, 'the hold time comes from the library, not a guess');
  // The count must be the same number the summary reports - two shows, one fact.
  const summaryCount = /(\d+) prefix\(es\) installed from BGP/.exec(
    env.a.run('show ip bgp summary').output.join('\n'));
  match(/Prefixes in\s+\d+ \(installed from BGP on this router\)/, detail,
    'and how many prefixes are installed');
  match(new RegExp('Prefixes in\\s+' + (summaryCount ? summaryCount[1] : '1') + ' '), detail,
    'which is the same count the summary gives (' + (summaryCount ? summaryCount[1] : '?') + ')');
  // One peer by address, and an address that is not a peer named with the ones that are.
  eq(env.a.run('show ip bgp neighbors 10.9.0.2').output.join('\n'), detail.join('\n'),
    'asking for one configured peer gives that peer');
  match(/% No BGP neighbour 10\.9\.0\.9 on R1/, env.a.run('show ip bgp neighbors 10.9.0.9').output,
    'an address that is not a peer is refused');
  match(/% Configured: 10\.9\.0\.2/, env.a.run('show ip bgp neighbors 10.9.0.9').output,
    'with the peers that are');
  match(/% Unexpected argument "extra"/, env.a.run('show ip bgp neighbors 10.9.0.2 extra').output,
    'a third word is refused');
  match(/% show ip bgp takes summary or neighbors, not "bogus"/, env.a.run('show ip bgp bogus').output,
    'and so is an unknown sub-word');
  // A peer that never answers is down *for a reason*, and the reason is the whole point.
  env.cfg(env.a, ['router bgp 65001', 'no bgp neighbor 10.9.0.2',
    'bgp neighbor 10.9.0.99 remote-as 65002', 'exit']);
  const down = env.a.run('show ip bgp neighbors').output;
  match(/State\s+idle/, down, 'a peer that never answers is idle');
  match(/Reason\s+no BGP speaker holds 10\.9\.0\.99/, down,
    'with the reason, which a state column cannot carry');
  match(/Prefixes in\s+0 \(no session, so nothing was exchanged\)/, down,
    'and no prefixes claimed for a session that does not exist');
}

console.log('\nThe first question after configuring a peer answers with the state now:');
{
  const env = lab();
  // Nothing has been pinged and no session has been forced: the very first show must know.
  const fresh = new CliSession(env.r1, env.t, env.sim);
  fresh.run('enable');
  const out = fresh.run('show ip bgp summary').output;
  match(/Established/, out, 'the peer is already established in the first answer');
  noMatch(/run a simulation/, out, 'and it does not tell an operator to start one');
  match(/1 of 1 neighbour\(s\) established/, out, 'the count is real');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
