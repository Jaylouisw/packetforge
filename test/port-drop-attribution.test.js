'use strict';
// port-drop-attribution.test.js — which events are allowed to charge a port's drop counter.
//
// Last iteration shipped the counters with the rule `iface && dev && /drop|deny|block/.test(type)`.
// A regex over English type names is a guess about meaning, and it guessed wrong in both directions:
//
//   * `poe-deny` matched, and the **power budget computation** emitted that type. So the port that
//     lost the budget was charged a frame drop for a frame that never existed - `drops : 1
//     (1 poe-deny)` on a port that had carried nothing at all.
//   * Drops whose reason already named a port (`egress interface down`, `no source IP on Gi0/0`)
//     carried no `iface`, so the port they named was never charged for them.
//
// The rule is now a named set, and the budget computation emits `poe-budget` rather than `poe-deny`.
// This suite holds both halves of that: a counter may only be charged for a frame, and every frame a
// port discarded must be charged to it. The reconciliation block at the end is the part that does not
// trust either the set or the engine: it walks the event log and requires the counter to agree.
const path = require('path');
const { Topology, Simulator, runCommands, CliSession } = require('../engine');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg); }
}
function eq(actual, expected, msg) {
  ok(actual === expected, msg + (actual === expected ? '' : '\n      got: ' + JSON.stringify(actual) +
    '\n      want: ' + JSON.stringify(expected)));
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
const model = (m) => {
  const s = catalog.find((x) => x.model === m);
  if (!s) throw new Error('missing model ' + m);
  return s;
};
const spec = (v, m) => {
  const s = catalog.find((x) => x.vendor === v && x.model === m);
  if (!s) throw new Error('missing spec ' + v + '/' + m);
  return s;
};
const ARUBA = 'CX 6000 24G CL4 PoE 4SFP 370W';

// The types this suite believes mean "a frame was discarded on this port". Written out here on
// purpose: if the engine's set changes, this list must change too, and the reconciliation block will
// notice either way.
const COUNTED = ['drop', 'acl-deny', 'vlan-drop', 'stp-block', 'nat-drop', 'poe-deny'];

function cli(dev, t, sim, cmds) {
  // A single session, so mode carries over - runCommands opens a fresh one per call.
  const s = new CliSession(dev, t, sim);
  const out = [];
  for (const c of cmds) out.push.apply(out, s.run(c).output);
  return out.join('\n');
}

console.log('A power-budget decision charges no port, because nothing was dropped:');
{
  const t = new Topology();
  const sw = t.addDevice(spec('aruba', ARUBA));
  const pd1 = t.addDevice(spec('ubiquiti', 'UCG-Ultra'));
  const pd2 = t.addDevice(spec('ubiquiti', 'UCG-Ultra'));
  sw.name = 'SW1'; pd1.name = 'PD1'; pd2.name = 'PD2';
  t.connect(pd1.id, 'port1', sw.id, '1/1/1');
  t.connect(pd2.id, 'port1', sw.id, '1/1/2');
  sw.poeBudget = 25;                          // funds one of the two
  const sim = new Simulator(t);
  sim.computePoe();
  const budget = sim.events.filter((e) => e.type === 'poe-budget');
  eq(budget.length, 1, 'the PSE announces one port it cannot fund');
  eq(budget[0].iface, '1/1/2', 'and names it');
  const denied = sim.portStats(sw.id, '1/1/2');
  eq(denied.drops, 0, 'that port has no frame drops - nothing was ever transmitted');
  eq(Object.keys(denied.reasons).length, 0, 'and no reason is recorded against it');
  // The bug this replaced: the same lab reported `drops : 1 (1 poe-deny)` here.
  ok(!/PSE budget exhausted/.test(JSON.stringify(sim.portStats(sw.id))),
    'the budget message never appears in any port counter');
  eq(sim.portStats(sw.id, '1/1/1').drops, 0, 'and the funded port has none either');
}

console.log('\nA frame refused for want of power IS charged to the port that refused it:');
{
  const t = new Topology();
  const sw = t.addDevice(spec('aruba', ARUBA));
  const pd1 = t.addDevice(spec('ubiquiti', 'UCG-Ultra'));
  const pd2 = t.addDevice(spec('ubiquiti', 'UCG-Ultra'));
  sw.name = 'SW1'; pd1.name = 'PD1'; pd2.name = 'PD2';
  t.connect(pd1.id, 'port1', sw.id, '1/1/1');
  t.connect(pd2.id, 'port1', sw.id, '1/1/2');
  sw.poeBudget = 25;
  const sim = new Simulator(t);
  runCommands(pd1, t, sim, ['enable', 'configure terminal', 'interface port1',
    'ip address 192.168.50.1 255.255.255.0', 'exit', 'exit']);
  runCommands(pd2, t, sim, ['enable', 'configure terminal', 'interface port1',
    'ip address 192.168.50.2 255.255.255.0', 'exit', 'exit']);
  const r = sim.ping(pd1.id, '192.168.50.2', { count: 1 });
  eq(r.replies[0].success, false, 'the ping to the unpowered device fails');
  const dead = sim.portStats(pd2.id, 'port1');
  ok(dead.drops > 0, 'the dead device\'s port records the frames it could not handle (' + dead.drops + ')');
  const reasons = Object.keys(dead.reasons).join(' | ');
  ok(/PoE power|PoE-powered/.test(reasons), 'with the power reason: ' + reasons);
  ok(!/PSE budget exhausted/.test(reasons),
    'and not the PSE\'s budgeting message, which belongs to the switch, not to this port');
  // The switch's port facing the dead device dropped nothing: the frames crossed it fine.
  eq(sim.portStats(sw.id, '1/1/2').drops, 0, 'the switch port in between dropped nothing');
}

console.log('\nEvery port-level drop reason is charged, and device-level drops are not:');
{
  const t = new Topology();
  const r = t.addDevice(model('generic-router'));
  const a = t.addDevice(model('generic-pc'));
  r.name = 'R1'; a.name = 'PC1';
  t.connect(a.id, 'eth0', r.id, 'Gi0/0');
  const sim = new Simulator(t);
  runCommands(r, t, sim, ['enable', 'configure terminal', 'hostname R1', 'interface Gi0/0',
    'ip address 10.0.1.1 255.255.255.0', 'exit', 'exit']);
  runCommands(a, t, sim, ['enable', 'configure terminal', 'interface eth0',
    'ip address 10.0.1.10 255.255.255.0', 'exit', 'exit']);
  // A frame arrives at PC1 addressed somewhere it cannot reach: "not for us and not routable".
  runCommands(r, t, sim, ['enable', 'configure terminal',
    'ip route 10.9.9.0 255.255.255.0 10.0.1.10', 'exit']);
  runCommands(a, t, sim, ['enable', 'configure terminal',
    'ip route 10.9.9.0 255.255.255.0 10.0.1.1', 'exit']);
  runCommands(a, t, sim, ['enable', 'ping 10.9.9.9 count 1']);
  const pcDrops = sim.portStats(a.id, 'eth0');
  ok(pcDrops.drops > 0, 'the host that received an unroutable frame is charged for discarding it');
  ok(Object.keys(pcDrops.reasons).some((k) => /not for us/.test(k)),
    'and its reason is the real one: ' + Object.keys(pcDrops.reasons).join(' | '));
  // A drop with no route at all happens before a port is chosen, so no port may be charged.
  const before = JSON.stringify(sim.portStats(r.id));
  runCommands(r, t, sim, ['enable', 'ping 192.0.2.1 count 1']);
  const noRoute = sim.events.filter((e) => e.type === 'drop' && /^no route to /.test(e.reason || ''));
  ok(noRoute.length > 0, 'the router logged a no-route drop');
  ok(noRoute.every((e) => !e.iface), 'and it carries no port, because no egress was chosen');
  eq(JSON.stringify(sim.portStats(r.id)).replace(/"rx":\d+|"tx":\d+|"rxBytes":\d+|"txBytes":\d+/g, ''),
    before.replace(/"rx":\d+|"tx":\d+|"rxBytes":\d+|"txBytes":\d+/g, ''),
    'so no port counter moved except by traffic');
}

console.log('\nThe rule is the funnel, so a new event type cannot be charged by accident:');
{
  const t = new Topology();
  const r = t.addDevice(model('generic-router'));
  r.name = 'R1';
  const sim = new Simulator(t);
  const dev = r.id;
  // Each of these is emitted by a real site somewhere in the engine; the ones that mean "a frame died
  // on this port" charge it, and the ones that mean something else do not.
  sim._emit({ type: 'drop', dev: dev, iface: 'Gi0/0', reason: 'something specific' });
  sim._emit({ type: 'poe-budget', dev: dev, iface: 'Gi0/0', reason: 'PSE budget exhausted: 30 W requested' });
  sim._emit({ type: 'slaac-refused', dev: dev, iface: 'Gi0/0', reason: 'no global address' });
  sim._emit({ type: 'tap-inject-refused', dev: dev, iface: 'Gi0/0', reason: 'instrument' });
  sim._emit({ type: 'scion-drop', src: '1-1', dst: '2-2', reason: 'policy' });
  sim._emit({ type: 'limit', dev: dev, reason: 'step ceiling' });
  const st = sim.portStats(dev, 'Gi0/0');
  eq(st.drops, 1, 'exactly one of those six is a frame drop');
  eq(Object.keys(st.reasons).join(','), 'something specific', 'and its reason is the only one recorded');
}

console.log('\nReconciliation: the counters agree with the log, port by port:');
{
  const t = new Topology();
  const sw = t.addDevice(spec('aruba', ARUBA));
  const r = t.addDevice(model('generic-router'));
  const a = t.addDevice(model('generic-pc'));
  const b = t.addDevice(model('generic-pc'));
  sw.name = 'SW1'; r.name = 'R1'; a.name = 'PC1'; b.name = 'PC2';
  t.connect(a.id, 'eth0', sw.id, '1/1/3');
  t.connect(b.id, 'eth0', sw.id, '1/1/4');
  t.connect(sw.id, '1/1/5', r.id, 'Gi0/0');
  const sim = new Simulator(t);
  const cfg = [
    // Three access VLANs so one host can reach the router and the other cannot reach anything: the
    // VLAN the router's port sits in is the one that can carry traffic, and that is the drop path.
    runCommands(sw, t, sim, ['enable', 'configure terminal', 'hostname SW1',
      'interface 1/1/3', 'switchport mode access', 'switchport access vlan 10', 'exit',
      'interface 1/1/4', 'switchport mode access', 'switchport access vlan 20', 'exit',
      'interface 1/1/5', 'switchport mode access', 'switchport access vlan 10', 'exit', 'exit']),
    // The static route matters: an ingress ACL is only consulted for a frame the box would otherwise
    // act on, and "no route to 10.0.0.99" is a device-level drop that never reaches the ACL.
    runCommands(r, t, sim, ['enable', 'configure terminal', 'hostname R1', 'interface Gi0/0',
      'ip address 10.0.0.1 255.255.255.0', 'exit',
      'ip route 10.9.9.0 255.255.255.0 10.0.0.10',
      'access-list 110 deny ip host 10.0.0.10 any', 'access-list 110 permit ip any any',
      'exit', 'exit']),
    runCommands(a, t, sim, ['enable', 'configure terminal', 'interface eth0',
      'ip address 10.0.0.10 255.255.255.0', 'exit', 'ip route 0.0.0.0 0.0.0.0 10.0.0.1', 'exit']),
    // PC2 needs an address of its own, or its ping never gets a source and the drop under test (the
    // switch having nowhere to put a VLAN-20 frame) never happens.
    runCommands(b, t, sim, ['enable', 'configure terminal', 'interface eth0',
      'ip address 10.0.0.11 255.255.255.0', 'exit', 'exit']),
  ];
  for (const res of cfg) {
    const refused = (res.lines || []).filter((l) => /^%/.test(l));
    if (refused.length) throw new Error('lab refused: ' + refused.join(' / '));
  }
  // Bind the ACL so the deny is real, then offer traffic that hits every reachable drop path.
  cli(r, t, sim, ['enable', 'configure terminal', 'interface Gi0/0', 'ip access-group 110 in',
    'exit', 'exit']);
  // Each console command starts a fresh run, so the event log is replaced by each one. The counters,
  // by contrast, are cumulative - which is exactly what makes them worth cross-checking. So the log is
  // collected from every run and concatenated, and the reconciliation compares the sum.
  const log = [];
  const tap = () => { log.push.apply(log, sim.events); };
  cli(a, t, sim, ['enable', 'ping 10.9.9.9 count 2']);        // hits the ACL deny at R1
  tap();
  cli(b, t, sim, ['enable', 'ping 10.0.0.10 count 1']);       // VLAN 20 -> VLAN 10: not allowed
  tap();

  // The log is the authority. Count every event that carries a port and means "a frame died here",
  // per port, and require the counter to match it exactly - both the total and the reasons.
  const expected = new Map();
  const others = new Map();
  for (const e of log) {
    if (!e.dev || !e.iface) continue;
    const key = e.dev + '\u0000' + e.iface;
    if (!COUNTED.includes(e.type)) { others.set(e.type, (others.get(e.type) || 0) + 1); continue; }
    const rec = expected.get(key) || { n: 0, reasons: {} };
    rec.n++;
    const why = e.reason || e.type;
    rec.reasons[why] = (rec.reasons[why] || 0) + 1;
    expected.set(key, rec);
  }
  ok(expected.size >= 2, 'the lab produced port-level drops on at least two ports (' + expected.size + ')');
  let totalCounted = 0, totalCharged = 0, problems = [];
  for (const [key, exp] of expected.entries()) {
    const cut = key.indexOf('\u0000');
    const devId = key.slice(0, cut), iface = key.slice(cut + 1);
    const got = sim.portStats(devId, iface);
    totalCounted += exp.n;
    totalCharged += got.drops;
    if (got.drops !== exp.n) problems.push(iface + ': logged ' + exp.n + ', counted ' + got.drops);
    if (Object.keys(got.reasons).sort().join('|') !== Object.keys(exp.reasons).sort().join('|')) {
      problems.push(iface + ': reasons differ (' + Object.keys(got.reasons).sort().join('|') +
        ' vs ' + Object.keys(exp.reasons).sort().join('|') + ')');
    }
  }
  eq(problems.join(' ; '), '', 'every charged port matches the log, count and reasons');
  eq(totalCharged, totalCounted, 'and no port is charged for an event that did not name it');
  // Nothing outside the set may appear in a counter, however many such events the lab produced.
  const allReasons = JSON.stringify(sim.portStats(sw.id)) + JSON.stringify(sim.portStats(r.id));
  for (const type of others.keys()) {
    ok(!allReasons.includes('"' + type + '"'), 'events of type "' + type + '" contribute no drop reason');
  }
  // And the console shows the same numbers the model holds.
  const out = cli(r, t, sim, ['enable', 'show interfaces counters']);
  const row = out.split('\n').filter((l) => /^Gi0\/0 /.test(l))[0] || '';
  const cells = row.trim().split(/\s+/);
  eq(cells[5], String(sim.portStats(r.id, 'Gi0/0').drops), 'show interfaces counters agrees with portStats');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
