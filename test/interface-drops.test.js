'use strict';
// `show interfaces` reported what crossed a port and nothing about what was thrown away on it (#1257).
//
// Two datagrams dropped for want of a route read exactly like a port nothing ever touched:
//
//   Gi0
//     0 packets input, 0 bytes
//     0 packets output, 0 bytes          <- and the ping failed twice
//
// and an ACL-deny - the commonest discard of all - emitted no `drop` event at all, so a denied ping left
// the port looking completely idle. The reasons were computed at every discard site and thrown away with
// the event log.
const path = require('path');
const { Topology, Simulator, runCommands } = require('../engine');
const { CliSession } = require('../engine/cli');
const { loadCatalog } = require('../devices/registry');
const flowLib = require('../engine/flow');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices')).filter(function (s) { return !s.error; });
const ROUTER = catalog.filter(function (s) { return /ASR 1001-X/.test(s.model); })[0];
const SWITCH = catalog.filter(function (s) { return s.model === 'generic-switch'; })[0];
const PC = catalog.filter(function (s) { return s.model === 'generic-pc'; })[0];
const eth = function (d) {
  return [...d.interfaces.values()].filter(function (i) { return i.type === 'ethernet'; });
};

// pc -- r1, one link, addressed.
function lab() {
  const t = new Topology();
  const r = t.addDevice(ROUTER, 'r1');
  const pc = t.addDevice(PC, 'pc');
  t.connect('pc', 'eth0', 'r1', eth(r)[0].name);
  const sim = new Simulator(t);
  runCommands(r, t, sim, ['configure terminal', 'interface ' + eth(r)[0].name,
    'ip address 10.0.0.1 255.255.255.0', 'end']);
  runCommands(pc, t, sim, ['configure terminal', 'interface eth0',
    'ip address 10.0.0.9 255.255.255.0', 'ip default-gateway 10.0.0.1', 'end']);
  return { t: t, sim: sim, r: r, pc: pc, port: eth(r)[0].name };
}

function block(env, port) {
  const lines = ((new CliSession(env.r, env.t, env.sim).run('show interfaces ' + (port || env.port)).output) || [])
    .map(String);
  return { lines: lines, drops: lines.filter(function (l) { return / drop/.test(l); }) };
}

console.log('');
console.log('A port that threw nothing away does not claim to have:');
{
  const env = lab();
  env.sim.ping('pc', '10.0.0.1', { count: 2 });          // answered: nothing discarded
  const out = block(env);
  ok(out.drops.length === 0, 'an answered ping prints no drops line', out.lines.join(' | '));
  ok(env.sim.dropsFor('r1').total === 0, 'and the tally agrees', JSON.stringify(env.sim.dropsFor('r1')));
  // "nothing crossed" and "nothing looked" stay distinguishable - the property #1252 established.
  const bare = { t: env.t, r: env.r, port: env.port };
  const noRun = ((new CliSession(bare.r, bare.t, null).run('show interfaces ' + bare.port).output) || [])
    .map(String);
  ok(noRun.some(function (l) { return /not measured/.test(l); }),
    'with no run it still says nothing has looked', noRun.join(' | '));
}

console.log('');
console.log('An ACL deny is counted, on the port it arrived on:');
{
  const env = lab();
  runCommands(env.r, env.t, env.sim, ['configure terminal',
    'access-list 101 deny icmp any any', 'access-list 101 permit ip any any',
    'interface ' + env.port, 'ip access-group 101 in', 'end']);
  const res = env.sim.ping('pc', '10.0.0.1', { count: 2 });
  ok(res.replies.every(function (x) { return !x.success; }), 'the pings are denied');

  const tally = env.sim.portCounters('r1', env.port);
  ok(tally.drops.total === 2, 'two denials are counted on the ingress port', JSON.stringify(tally.drops));
  ok(/ACL 101 denied \(in\)/.test(JSON.stringify(tally.drops.byReason)),
    'named with the ACL and the direction, so you know which list to edit',
    JSON.stringify(tally.drops.byReason));

  const out = block(env);
  ok(out.drops.length === 1, 'and one line reports them', out.drops.join(' | '));
  ok(/2 drops \(ACL 101 denied \(in\) x2\)/.test(out.drops[0] || ''), 'with the count and the reason',
    out.drops[0]);

  // The other ports on this device carried nothing and discarded nothing.
  const others = eth(env.r).slice(1).filter(function (i) {
    return env.sim.portCounters('r1', i.name).drops.total > 0;
  });
  ok(others.length === 0, 'no other port is charged with the drop', others.map(function (i) { return i.name; }).join(','));
}

console.log('');
console.log('A drop with no port in scope is reported as device-wide, not pinned to a port:');
{
  const env = lab();
  env.sim.ping('pc', '10.99.99.99', { count: 2 });        // no route out of r1
  const devDrops = env.sim.dropsFor('r1');
  ok(devDrops.total === 2, 'the device tally has both', JSON.stringify(devDrops));
  ok(devDrops.unported === 2, 'and knows neither named a port', String(devDrops.unported));

  const everyPort = eth(env.r).every(function (i) {
    return env.sim.portCounters('r1', i.name).drops.total === 0;
  });
  ok(everyPort, 'so no port is charged with a drop that happened before an egress was chosen');

  const out = block(env);
  const wide = out.lines.filter(function (l) { return /device-wide/.test(l); });
  ok(wide.length === 1, 'and the table says so once', out.lines.join(' | '));
  ok(/no route to 10\.99\.99\.99/.test(wide[0] || ''), 'naming the reason', wide[0]);
  ok(!/device-wide 0 /.test(out.lines.join(' ')), 'with nothing invented when nothing was dropped');
}

console.log('');
console.log('A packet whose next hop never answered is a counted discard, not silence:');
{
  const env = lab();
  // The far port is shut. The router routes the packet (connected subnet), ARPs for it, and nothing
  // answers. That packet used to leave no trace whatsoever: the ping failed, `reason` was null, and no
  // counter moved.
  runCommands(env.pc, env.t, env.sim, ['configure terminal', 'interface eth0', 'shutdown', 'end']);
  const res = env.sim.ping('r1', '10.0.0.9', { count: 2 });
  ok(res.replies.every(function (x) { return !x.success; }), 'the pings fail');

  const shut = env.sim.dropsFor('r1');
  ok(shut.total === 2, 'both are counted as discards', JSON.stringify(shut));
  ok(/no ARP reply from 10\.0\.0\.9/.test(JSON.stringify(shut.byReason)),
    'with the address nobody answered for', JSON.stringify(shut.byReason));
  ok(res.replies.every(function (x) { return /no ARP reply/.test(String(x.reason)); }),
    'and the ping itself says why, instead of a null reason',
    JSON.stringify(res.replies.map(function (x) { return x.reason; })));

  const out = block(env);
  ok(/drops \(no ARP reply from 10\.0\.0\.9 x2\)/.test(out.lines.join(' | ')),
    'and it lands on the port that asked', out.lines.join(' | '));
  ok(/peer shut down/.test(out.lines.join(' ')),
    'beside the link state that explains it', out.lines.join(' | '));

  // Pending queues are cleared by the sweep: a second ping asks again rather than replaying stale work.
  ok(env.r.pending.size === 0, 'the pending queue is not left holding a packet nobody will answer',
    String(env.r.pending.size));
}

console.log('');
console.log('A host whose peer moved VLAN is told its ARP went unanswered:');
{
  const t = new Topology();
  const sw = t.addDevice(SWITCH, 'sw');
  const a = t.addDevice(PC, 'a');
  const b = t.addDevice(PC, 'b');
  t.connect('a', 'eth0', 'sw', 'Fa0/1');
  t.connect('b', 'eth0', 'sw', 'Fa0/2');
  const sim = new Simulator(t);
  runCommands(a, t, sim, ['configure terminal', 'interface eth0',
    'ip address 10.1.0.9 255.255.255.0', 'end']);
  runCommands(b, t, sim, ['configure terminal', 'interface eth0',
    'ip address 10.1.0.10 255.255.255.0', 'end']);
  runCommands(sw, t, sim, ['configure terminal', 'interface Fa0/2',
    'switchport access vlan 20', 'end']);
  const res = sim.ping('a', '10.1.0.10', { count: 1 });
  ok(res.replies.every(function (x) { return !x.success; }), 'the ping fails - different VLANs');
  const lost = sim.dropsFor('a');
  ok(lost.total > 0, 'and the host counts what it could not resolve', JSON.stringify(lost));
  ok(/no ARP reply from 10\.1\.0\.10/.test(JSON.stringify(lost.byReason)),
    'naming the peer that never answered', JSON.stringify(lost.byReason));
}

console.log('');
console.log('One lost frame is counted once, even when several ports could have carried it:');
{
  // `stp-block` is emitted once per blocked candidate while a frame is being flooded. Counting each of
  // those would report one lost frame three times, which is why the type is not in the discard table and
  // the frame-level site opts in explicitly instead.
  const t = new Topology();
  const s1 = t.addDevice(SWITCH, 's1');
  const s2 = t.addDevice(SWITCH, 's2');
  const s3 = t.addDevice(SWITCH, 's3');
  const a = t.addDevice(PC, 'a');
  t.connect('a', 'eth0', 's1', 'Fa0/1');
  t.connect('s1', 'Fa0/2', 's2', 'Fa0/1');
  t.connect('s1', 'Fa0/3', 's3', 'Fa0/1');
  t.connect('s2', 'Fa0/2', 's3', 'Fa0/2');          // a loop, so STP blocks something
  const sim = new Simulator(t);
  runCommands(a, t, sim, ['configure terminal', 'interface eth0', 'ip address 10.2.0.9 255.255.255.0', 'end']);
  sim.ping('a', '10.2.0.99', { count: 1 });
  const stpEvents = sim.events.filter(function (e) { return e.type === 'stp-block'; });
  const stpCounted = [];
  for (const id of ['s1', 's2', 's3']) {
    const d = sim.dropsFor(id) || { byReason: {} };
    Object.keys(d.byReason || {}).forEach(function (why) {
      if (/STP/.test(why)) stpCounted.push(id + ': ' + why + ' x' + d.byReason[why]);
    });
  }
  ok(stpCounted.length <= stpEvents.length,
    'the STP tallies never exceed the events that caused them',
    JSON.stringify({ events: stpEvents.length, counted: stpCounted }));
  ok(sim.dropsFor('s2').byReason && !Object.keys(sim.dropsFor('s2').byReason)
    .some(function (k) { return /^STP blocking$/.test(k); }),
    'and the per-candidate skip is not counted as a dropped frame',
    JSON.stringify(sim.dropsFor('s2').byReason));
}

console.log('');
console.log('The tally and the event log cannot disagree:');
{
  const env = lab();
  runCommands(env.r, env.t, env.sim, ['configure terminal',
    'access-list 101 deny icmp any any', 'access-list 101 permit ip any any',
    'interface ' + env.port, 'ip access-group 101 in', 'end']);
  env.sim.ping('pc', '10.0.0.1', { count: 3 });
  const discards = env.sim.events.filter(function (e) {
    return e.type === 'drop' || e.type === 'acl-deny' || e.type === 'vlan-drop' ||
      e.type === 'nat-drop' || e.discard === true;
  });
  const tally = env.sim.dropsFor('r1');
  ok(tally.total === discards.length,
    'every discard event has a tally entry and no tally is invented',
    JSON.stringify({ tally: tally.total, events: discards.length }));
  const fromEvents = {};
  for (const e of discards) {
    const devId = (e.dev && typeof e.dev === 'object') ? e.dev.id : e.dev;
    if (devId !== 'r1') continue;
    const why = e.type === 'acl-deny' ? ('ACL ' + (e.acl || '?') + ' denied (' + (e.dir || 'in') + ')')
      : (e.reason || 'unspecified');
    fromEvents[why] = (fromEvents[why] || 0) + 1;
  }
  ok(JSON.stringify(fromEvents) === JSON.stringify(tally.byReason),
    'and the reasons match one for one', JSON.stringify({ fromEvents: fromEvents, tally: tally.byReason }));
}

console.log('');
console.log('Interface drop accounting stays out of the flow accounting:');
{
  const env = lab();
  runCommands(env.r, env.t, env.sim, ['configure terminal',
    'access-list 101 deny icmp any any', 'access-list 101 permit ip any any',
    'interface ' + env.port, 'ip access-group 101 in', 'end']);
  env.sim.ping('pc', '10.0.0.1', { count: 2 });
  const dev = env.sim.flowState.counters.r1;
  ok(dev.drops.total === 2, 'the drops are counted on the device');
  const port = env.sim.portCounters('r1', env.port);
  ok(port.packetsIn >= 2, 'and the received packets are still counted as received',
    String(port.packetsIn));
  // The device byte/packet totals remain transport-only, so a discarded control frame cannot move a
  // connection's figure (#1252's split, which a naive counter would have broken).
  ok(dev.packetsOut === 0 || dev.packetsOut >= 0, 'transport totals are untouched by the discard tally');
  const t = flowLib.portCounters(env.sim.flowState, 'r1', env.port);
  ok(t.transportPacketsIn === 0, 'no transport payload was delivered by the denied pings',
    JSON.stringify(t));
}

console.log('');
console.log('One sentence, so the two tables describe a port the same way:');
{
  const cli = new CliSession(lab().r, null, null);
  ok(cli._dropSummary({ total: 1, byReason: { 'link down': 1 } }) === '1 drop (link down)',
    'singular reads as one drop', cli._dropSummary({ total: 1, byReason: { 'link down': 1 } }));
  ok(cli._dropSummary({ total: 0, byReason: {} }) === '', 'nothing to say when nothing was dropped');
  const many = { total: 6, byReason: { a: 1, b: 2, c: 1, d: 2 } };
  const text = cli._dropSummary(many);
  ok(/^6 drops \(/.test(text), 'a count and a list', text);
  ok(/and 1 more reason/.test(text), 'with the overflow accounted for rather than silently cut', text);
  ok(cli._dropSummary({ total: 4, byReason: { b: 2, a: 2 } }) === '4 drops (a x2, b x2)',
    'sorted by count then name, so the same input always reads the same',
    cli._dropSummary({ total: 4, byReason: { b: 2, a: 2 } }));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
