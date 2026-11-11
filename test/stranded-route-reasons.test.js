'use strict';
// stranded-route-reasons.test.js - a drop reason names the thing that failed.
//
//   R1(config)#ip route 10.8.0.0 255.255.255.0 192.168.99.1
//   R1#ping 10.8.0.9
//   .... Request timed out  ->  "show logging": drop, reason "egress interface down"
//
// Nothing was down. Gi0/0 was up with an address. The next hop was simply not on any subnet the
// router is attached to, and both that case and a shut port collapsed into one reason - the single
// diagnostic an operator follows, pointing at a cable that was never there.
//
// Two more of the same shape came out of the same probe: `traceroute` printed the stranded next hop
// as hop 1 with a timing (an address that was never reached, presented as a router that replied in
// 50 us), and the per-destination route lookup said `Interface -` and nothing else.
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

function lab(opts) {
  const o = opts || {};
  const t = new Topology();
  const r1 = t.addDevice(find('generic-router')); r1.name = 'R1';
  const r2 = t.addDevice(find('generic-router')); r2.name = 'R2';
  t.connect(r1.id, 'Gi0/0', r2.id, 'Gi0/0');
  const sim = new Simulator(t);
  const R1 = new CliSession(r1, t, sim); R1.run('enable');
  R1.run('configure terminal', 'interface Gi0/0', 'ip address 10.0.0.1 255.255.255.0', 'no shutdown', 'exit', 'end');
  const R2 = new CliSession(r2, t, sim); R2.run('enable');
  R2.run('configure terminal', 'interface Gi0/0', 'ip address 10.0.0.2 255.255.255.0', 'no shutdown', 'exit', 'end');
  if (o.shut) R1.run('configure terminal', 'interface Gi0/0', 'shutdown', 'exit', 'end');
  return { t: t, sim: sim, r1: r1, r2: r2, R1: R1, R2: R2 };
}
const drops = function (env) {
  return (env.sim.events || []).filter(function (e) { return e.type === 'drop'; })
    .map(function (e) { return e.reason; });
};

console.log('A drop at an unresolvable next hop names the next hop:');
{
  const env = lab();
  env.R1.run('configure terminal', 'ip route 10.8.0.0 255.255.255.0 192.168.99.1', 'exit', 'end');
  env.R1.run('ping 10.8.0.9');
  const reasons = drops(env);
  ok(reasons.length > 0, 'the packets were dropped, and each drop is logged');
  ok(reasons.every(function (r) { return /next hop 192\.168\.99\.1 is not on any connected subnet/.test(r); }),
    'the reason is the next hop, not a cable (' + reasons[0] + ')');
  ok(!reasons.some(function (r) { return /egress interface down/.test(r); }),
    'and nothing claims the port went down');
}

console.log('\nThree different failures keep three different sentences:');
{
  // A shut port withdraws its connected route, so the honest answer is "no route" - a third reason,
  // not the next-hop one and not "egress interface down". The point of the block is that the
  // sentences stay distinct: collapsing any two of them sends the operator to the wrong place.
  const env = lab({ shut: true });
  env.R1.run('ping 10.0.0.2');
  const reasons = drops(env);
  ok(reasons.some(function (r) { return /no route to 10\.0\.0\.2/.test(r); }),
    'a withdrawn route says there is no route (' + (reasons[0] || 'nothing logged') + ')');
  ok(!reasons.some(function (r) { return /not on any connected subnet/.test(r); }),
    'and is not blamed on the next hop');
  ok(!reasons.some(function (r) { return /egress interface down/.test(r); }),
    'nor on a cable, when the route is simply gone');
}

console.log('\nA flow gets a code of its own for it:');
{
  const env = lab();
  env.R1.run('configure terminal', 'ip route 10.8.0.0 255.255.255.0 192.168.99.1', 'exit', 'end');
  const res = env.sim.openFlow
    // The destination is the stranded prefix, not a device on the wire: a flow to a directly
    // connected address never consults the route that cannot resolve.
    ? env.sim.openFlow({ proto: 'tcp', srcDevice: env.r1.id, dstIp: '10.8.0.9', dstPort: 80 })
    : null;
  if (res) {
    ok(res.ok === false && res.code === 'E_UNRESOLVED_NEXT_HOP',
      'an unresolvable next hop is its own refusal code (' + res.code + ')');
    ok(/not on any connected subnet/.test(res.reason), 'with the same sentence');
  } else {
    ok(true, 'no openFlow entry point in this build (skipped)');
  }
}

console.log('\ntraceroute prints no hop it never reached:');
{
  const env = lab();
  env.R1.run('configure terminal', 'ip route 10.8.0.0 255.255.255.0 192.168.99.1', 'exit', 'end');
  const out = text(env.R1.run('traceroute 10.8.0.9'));
  ok(/\*  \*  \*/.test(out), 'the unanswered probes are stars');
  ok(/next hop 192\.168\.99\.1 is not a device in this lab/.test(out), 'and the reason is stated');
  ok(!/192\.168\.99\.1\s+50 us/.test(out), 'the unreached address is not printed as a hop with a timing');
}

console.log('\nA working path still prints its hops:');
{
  const env = lab();
  env.R1.run('configure terminal', 'ip route 10.8.0.0 255.255.255.0 10.0.0.2', 'exit', 'end');
  env.R2.run('configure terminal', 'interface Gi0/0', 'ip address 10.0.0.2 255.255.255.0', 'exit',
    'ip route 10.8.0.0 255.255.255.0 10.0.0.1', 'exit', 'end');
  const out = text(env.R1.run('traceroute 10.0.0.2'));
  ok(/Hop/.test(out), 'the table has its header');
  ok(/10\.0\.0\.2/.test(out), 'and the reached address appears');
}

console.log('\nThe per-destination lookup says why it will not forward:');
{
  const env = lab();
  env.R1.run('configure terminal', 'ip route 10.8.0.0 255.255.255.0 192.168.99.1', 'exit', 'end');
  const out = text(env.R1.run('show ip route 10.8.0.9'));
  ok(/Matched\s+10\.8\.0\.0\/24/.test(out), 'the match is named');
  ok(/Reachability 192\.168\.99\.1 is not on any connected subnet/.test(out),
    'and the lookup says the next hop is unreachable');
  ok(/show logging/.test(out), 'pointing at where the drop reason is recorded');
  const good = text(env.R1.run('show ip route 10.0.0.2'));
  ok(!/Reachability/.test(good), 'a reachable next hop gets no such note');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
