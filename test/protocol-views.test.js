'use strict';
// protocol-views.test.js - two views of the routing processes, and the contradictions they held.
//
// Measured before this pass, on one router with OSPF in area 0 and one BGP peer:
//
//   R1#show ip bgp summary
//   10.0.0.2  4  65002  Idle   not yet evaluated     <- the peer is configured
//
//   R1#show ip bgp neighbors
//   (no neighbours configured - add one with "bgp neighbor <ip> remote-as <as>")
//
//   R1#show ip bgp neighbors 10.0.0.2
//   % No BGP neighbour 10.0.0.2 on R1
//   % Configured: (none)                              <- advice to configure a peer that exists
//
//   R1#show ip protocols
//   % Invalid show command: ip protocols               <- a real command naming real state
//
// The summary read configuration; the detail views read only the *computed* session rows, so with no
// simulation run they saw nothing. That is the same defect the summary itself carried before: a peer
// is configuration, its session state is not.
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
function saw(re, out, msg) { ok(re.test(text(out)), msg + (re.test(text(out)) ? '' : ' (in ' + JSON.stringify(text(out).slice(0, 400)) + ')')); }
function absent(re, out, msg) { ok(!re.test(text(out)), msg + (re.test(text(out)) ? ' (unexpectedly matched)' : '')); }
const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
const find = function (m) { return catalog.filter(function (x) { return x.model === m; })[0]; };

function router(prep) {
  const t = new Topology();
  const d = t.addDevice(find('generic-router'));
  d.name = 'R1';
  const s = new CliSession(d, t, new Simulator(t));
  s.run('enable'); s.run('configure terminal');
  (prep || []).forEach(function (l) { s.run(l); });
  s.run('end');
  return { t: t, d: d, s: s };
}
const CONFIGURED = ['interface Gi0/0', 'ip address 10.0.0.1 255.255.255.0', 'exit',
  'router ospf 1', 'network 10.0.0.0 0.0.0.255 area 0', 'exit',
  'router bgp 65001', 'neighbor 10.0.0.2 remote-as 65002', 'exit'];

console.log('\nA configured peer is visible in the detail views, before any simulation ran:');
{
  const env = router(CONFIGURED);
  const neighbors = env.s.run('show ip bgp neighbors');
  absent(/no neighbours? configured/, neighbors, '"show ip bgp neighbors" does not deny the peers');
  saw(/10\.0\.0\.2/, neighbors, 'the peer is listed');
  saw(/Remote AS\s+65002/, neighbors, 'with its remote AS');
  saw(/not yet evaluated/, neighbors, 'and the reason its session is Idle, rather than a bare Idle');
  const one = env.s.run('show ip bgp neighbors 10.0.0.2');
  absent(/No BGP neighbour/, one, 'the single-peer form finds it');
  saw(/BGP neighbour 10\.0\.0\.2 on R1/, one, 'and prints the detail block');
  // Agreement, both ways: what the summary lists is what the detail lists.
  const summary = text(env.s.run('show ip bgp summary'));
  ok(/10\.0\.0\.2/.test(summary), 'the summary lists the same peer, so the two views agree');
  const missing = env.s.run('show ip bgp neighbors 10.9.9.9');
  saw(/No BGP neighbour 10\.9\.9\.9/, missing, 'a peer that is not configured is still refused');
  saw(/Configured: 10\.0\.0\.2/, missing, 'and the ones that *are* configured are named, not "(none)"');
  absent(/Configured: \(none\)/, missing, 'never "(none)" while a peer exists');
}

console.log('\nshow ip protocols answers, and agrees with the views it summarises:');
{
  const env = router(CONFIGURED);
  const out = env.s.run('show ip protocols');
  absent(/Invalid show command/, out, 'it is a command here');
  saw(/Routing Protocol is "ospf 1"/, out, 'the OSPF process is named with its id');
  saw(/Routing Protocol is "bgp 65001"/, out, 'and the BGP process with its AS');
  saw(/Interfaces\s+Gi0\/0 \(area 0\)/, out, 'the OSPF interface and its area are listed');
  saw(/Areas\s+0\b/, out, 'the area list is the area the interface is in');
  saw(/Peers\s+10\.0\.0\.2 \(AS 65002\)/, out, 'the BGP peer is listed');
  saw(/Administrative distance 110/, out, 'the OSPF distance is stated');
  saw(/20 for eBGP, 200 for iBGP/, out, 'and the BGP distances');
  // The distances are the ones the route table uses - one copy, not a second opinion.
  const route = text(env.s.run('show ip route connected'));
  ok(/255\.255\.255\.0|10\.0\.0\.0\/24/.test(route), 'the route table still answers');
  // No invented emptiness: if `show ip ospf` names an interface, this view may not say "(none)".
  const ospf = text(env.s.run('show ip ospf'));
  if (/Gi0\/0/.test(ospf)) {
    absent(/Interfaces\s+\(none/, out, 'while "show ip ospf" lists Gi0/0, this may not say "(none)"');
  }
}

console.log('\nWith nothing running, it names what would start it:');
{
  const env = router([]);
  const out = env.s.run('show ip protocols');
  saw(/No routing protocol is running/, out, 'the absence is stated');
  saw(/router ospf <process-id>/, out, 'the command that starts OSPF is named');
  saw(/router bgp <as>/, out, 'and the one that starts BGP');
  saw(/show ip route/, out, 'and where the current table is');
  // On a device that cannot route at all the answer is about the device, not about commands it
  // has no way to use.
  const t = new Topology();
  const pc = t.addDevice(find('generic-pc')); pc.name = 'PC1';
  const ps = new CliSession(pc, t, new Simulator(t)); ps.run('enable');
  const pOut = ps.run('show ip protocols');
  saw(/PC1 runs no routing protocol/, pOut, 'a host is refused by what it is');
  saw(/ip default-gateway/, pOut, 'and pointed at how a host reaches other networks');
  absent(/router ospf <process-id>/, pOut, 'without offering a router command it cannot run');
}

console.log('\nHSRP is answered by naming the redundancy this model does have:');
{
  const env = router([]);
  const out = env.s.run('show standby');
  absent(/Invalid show command/, out, '"show standby" is no longer called a typo');
  saw(/HSRP is not modelled/, out, 'it says what is absent');
  saw(/show vrrp/, out, 'and names VRRP');
  // The pointer has to work.
  saw(/VRRP|Interface/, env.s.run('show vrrp'), 'and "show vrrp" is a command that answers');
}

console.log('\nBoth views are on the exec page:');
{
  const env = router([]);
  const page = text(env.s.run('?'));
  saw(/show ip protocols/, page, 'show ip protocols is offered');
  saw(/show ip bgp neighbors \[<addr>\]/, page, 'and the per-peer form');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
