'use strict';
// traceroute-at.test.js — `traceroute <ip> at <ms>`, the companion to
// `ping ... at <ms>`: ask which way the traffic goes at an instant, before the
// control plane has finished. Without it a trace at t=0 and a trace after
// convergence were the same answer.
const path = require('path');
const { Topology, Simulator, runCommands } = require('../engine');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg); }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
function spec(v, m) {
  const s = catalog.find(function (x) { return x.vendor === v && x.model === m; });
  if (!s) throw new Error('spec not found: ' + v + '/' + m);
  return s;
}

// PC1 -- R1 -- R2 -- PC2, with OSPF on the two routers only. R1 learns PC2's
// subnet from OSPF, so before the SPF hold there is no route at all.
function build() {
  const t = new Topology();
  const pc1 = t.addDevice(spec('generic', 'generic-pc'));
  const pc2 = t.addDevice(spec('generic', 'generic-pc'));
  const r1 = t.addDevice(spec('generic', 'generic-router'));
  const r2 = t.addDevice(spec('generic', 'generic-router'));
  pc1.name = 'PC1'; pc2.name = 'PC2'; r1.name = 'R1'; r2.name = 'R2';
  t.connect(pc1.id, 'eth0', r1.id, 'Gi0/0');
  t.connect(r1.id, 'Gi0/1', r2.id, 'Gi0/0');
  t.connect(r2.id, 'Gi0/1', pc2.id, 'eth0');
  const sim = new Simulator(t);
  const cfg = function (dev, cmds) {
    runCommands(dev, t, sim, ['configure terminal'].concat(cmds));
  };
  cfg(pc1, ['interface eth0', 'ip address 10.0.1.10 255.255.255.0', 'exit',
    'ip default-gateway 10.0.1.1']);
  cfg(pc2, ['interface eth0', 'ip address 10.0.2.20 255.255.255.0', 'exit',
    'ip default-gateway 10.0.2.1']);
  cfg(r1, ['interface Gi0/0', 'ip address 10.0.1.1 255.255.255.0', 'exit',
    'interface Gi0/1', 'ip address 10.0.12.1 255.255.255.0', 'exit',
    'ospf router-id 1.1.1.1', 'ospf area 0']);
  cfg(r2, ['interface Gi0/0', 'ip address 10.0.12.2 255.255.255.0', 'exit',
    'interface Gi0/1', 'ip address 10.0.2.1 255.255.255.0', 'exit',
    'ospf router-id 2.2.2.2', 'ospf area 0']);
  return { t: t, sim: sim, pc1: pc1, pc2: pc2, r1: r1, r2: r2 };
}
function trace(env, cmd) {
  return runCommands(env.pc1, env.t, env.sim, ['enable', cmd]).lines.join('\n');
}

// The schedule this lab actually produces.
const probe = build();
const sched = probe.sim.getConvergence();
const ospfReady = sched.entries.filter(function (e) { return e.process === 'ospf'; })[0].readyAtMs;
ok(ospfReady > 0, 'the lab has a non-zero OSPF convergence time (' + ospfReady + ' ms)');

// Before convergence: the trace reaches the first router and stops, naming the
// process that has not produced the route yet.
{
  const env = build();
  const out = trace(env, 'traceroute 10.0.2.20 at 5000');
  ok(/Tracing the route to 10\.0\.2\.20\s+\(at t=5000 ms\)/.test(out), 'the header names the instant');
  ok(/^\s+1\s+10\.0\.1\.1/m.test(out), 'the first hop is still reported - the default route exists');
  ok(/\*  \*  \*/.test(out), 'the walk stops with stars');
  ok(new RegExp('no route to 10\\.0\\.2\\.20 on R1 yet: ospf still converging \\(ready at ' + ospfReady + ' ms\\)').test(out),
    'and says OSPF has not converged, with the ready time');
  ok(!/\(3 hops\)/.test(out), 'no path summary is invented for a path that does not exist');
}

// After convergence: the full path.
{
  const env = build();
  const out = trace(env, 'traceroute 10.0.2.20 at ' + (ospfReady + 1000));
  ok(/^\s+1\s+10\.0\.1\.1/m.test(out), 'hop 1');
  ok(/^\s+2\s+10\.0\.12\.2/m.test(out), 'hop 2 is the OSPF-learned next hop');
  ok(/^\s+3\s+10\.0\.2\.20\s+.*\(destination\)/m.test(out), 'hop 3 is the destination');
  ok(/Path: PC1 -> R1 -> R2 -> PC2\s+\(3 hops\)/.test(out), 'the summary appears');
  ok(!/still converging/.test(out), 'and nothing claims to be converging');
}

// The instant is honoured in both directions on the same simulator: early fails,
// late succeeds, early again fails.
{
  const env = build();
  const early1 = trace(env, 'traceroute 10.0.2.20 at 1000');
  const late = trace(env, 'traceroute 10.0.2.20 at ' + (ospfReady + 1000));
  const early2 = trace(env, 'traceroute 10.0.2.20 at 1000');
  ok(/still converging/.test(early1), 'an early trace fails');
  ok(/\(3 hops\)/.test(late), 'a late trace succeeds');
  ok(/still converging/.test(early2), 'and going back to the early instant fails again');
}

// No `at`: unchanged behaviour, the converged answer.
{
  const env = build();
  const out = trace(env, 'traceroute 10.0.2.20');
  ok(/\(3 hops\)/.test(out), 'without "at" the trace is the converged path');
  ok(!/at t=/.test(out), 'and no instant is claimed');
}

// Refusals.
{
  const env = build();
  const bad = trace(env, 'traceroute 10.0.2.20 at soon');
  ok(/% Invalid instant: soon/.test(bad), 'a non-numeric instant is refused');
  const missing = trace(env, 'traceroute 10.0.2.20 at');
  ok(/% Incomplete command: traceroute <ip> at <ms>/.test(missing), 'a missing instant is refused');
  const neg = trace(env, 'traceroute 10.0.2.20 at -5');
  ok(/% Invalid instant: -5/.test(neg), 'a negative instant is refused');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
