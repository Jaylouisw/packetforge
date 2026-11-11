'use strict';
// A frame that died said the VLAN was wrong when the spanning tree was (#1437).
//
// `_forwardL2()` filters its flood candidates - blocked ports, ports outside the VLAN, the ingress port-channel -
// and when nothing was left it emitted one sentence whatever had refused: `no egress ports in VLAN <vid>`. On a
// switch whose only other port the tree had blocked, that sentence is false twice over. The port is *in* the VLAN;
// and the same box already answers `show spanning-tree` with `Fa0/4  alternate  blocking  (traffic dropped)`.
//
// Two surfaces on one box telling an operator different stories, and the counter is the one that gets acted on: it
// says VLAN, so the VLAN is re-checked, and the VLAN was never the problem. It is also the sentence `_lastDiscard()`
// reports as the reason a ping failed, so the wrong words reach the report as well as the counter.
//
// The three refusals are three different answers and each now names itself. The VLAN wording is kept - where a port
// really is outside the VLAN it was always true - and the rank slot matches both, so where the reason sits in
// `_lastDiscard()` did not move: naming the tree does not make it a different kind of cause.
const path = require('path');
const { Topology, Simulator, runCommands } = require('../engine');
const flowLib = require('../engine/flow');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
function spec(v, m) {
  const s = catalog.find(function (x) { return x.vendor === v && x.model === m; });
  if (!s) throw new Error('spec not found: ' + v + '/' + m);
  return s;
}
const SWITCH = spec('generic', 'generic-switch');
const PC = spec('generic', 'generic-pc');

function lines(out) { return (out && out.lines) ? out.lines : []; }
function dropsFor(sim, devId) {
  return sim.events.filter(function (e) { return e.dev === devId && e.type === 'drop'; });
}

// ---------------------------------------------------------------------------
// A. A triangle with a dead end: s1 is root, s3's port back to s2 is blocked, so a frame that reaches s3 has
//    nowhere to go. The frame is lost because of the tree, and the box must say so.
// ---------------------------------------------------------------------------
console.log('Scenario A: a frame lost to the tree, on the box that blocks the port');
const A = (function () {
  const t = new Topology();
  t.addDevice(SWITCH, 's1'); t.addDevice(SWITCH, 's2'); t.addDevice(SWITCH, 's3');
  t.addDevice(PC, 'a'); t.addDevice(PC, 'b');
  t.connect('a', 'eth0', 's1', 'Fa0/1');
  t.connect('s1', 'Fa0/2', 's2', 'Fa0/1');
  t.connect('s2', 'Fa0/2', 's3', 'Fa0/1');
  t.connect('s3', 'Fa0/2', 's1', 'Fa0/3');
  t.connect('b', 'eth0', 's2', 'Fa0/3');
  // The same wiring the server uses: one flow state on the topology, handed to every simulator, so the payload's
  // counters are the ones this run produced.
  const fs = flowLib.createFlowState();
  const sim = new Simulator(t, { flowState: fs });
  runCommands(t.getDevice('a'), t, sim, ['configure terminal', 'interface eth0',
    'ip address 10.0.0.10 255.255.255.0', 'end']);
  runCommands(t.getDevice('b'), t, sim, ['configure terminal', 'interface eth0',
    'ip address 10.0.0.11 255.255.255.0', 'end']);
  const ping = sim.ping('a', '10.0.0.11', { count: 1 });
  const s3 = t.getDevice('s3');
  return {
    t: t, sim: sim, s3: s3,
    pinged: ping.replies[0].success,
    tree: lines(runCommands(s3, t, sim, ['show spanning-tree'])).join('\n'),
    ifaces: lines(runCommands(s3, t, sim, ['show interfaces'])).join('\n'),
    ifaceIn: lines(runCommands(s3, t, sim, ['show interfaces Fa0/2'])).join('\n'),
    drops: dropsFor(sim, 's3'),
    counters: flowLib.counterSnapshot(fs, 's3')
  };
})();

ok(A.pinged, 'the ping itself still works (the tree only cut the redundant path)');
ok(/alternate\s+blocking/.test(A.tree), 'the premise: s3 prints one port as alternate/blocking');

const blockedPort = (A.tree.match(/(Fa\d+\/\d+)\s+alternate\s+blocking/) || [])[1];
ok(!!blockedPort, 'the blocked port is named in `show spanning-tree`', blockedPort);

ok(A.drops.length === 1, 'exactly one frame was lost at s3 (the redundant copy)', 'drops=' + A.drops.length);
const why = A.drops.length ? String(A.drops[0].reason) : '';
ok(/spanning tree blocks/.test(why), 'the lost frame says the tree blocked it', why);
ok(blockedPort ? why.indexOf(blockedPort) !== -1 : false,
  'the reason names the very port `show spanning-tree` prints as blocking', why);
ok(!/in VLAN/.test(why), 'the reason does not claim a VLAN problem (the port is in VLAN 1)', why);
ok(/\(no egress ports: spanning tree blocks/.test(A.ifaces),
  '`show interfaces` says the same thing in the port\'s drop row', A.ifaces.split('\n').filter(function (l) {
    return /drop/.test(l);
  }).join(' | '));
ok(A.drops.length === 1 && A.drops[0].iface === 'Fa0/2',
  'the drop is counted against the port the frame arrived on', A.drops.length ? A.drops[0].iface : '-');
const byReason = Object.keys(A.counters.drops.byReason || {});
ok(byReason.some(function (k) { return /spanning tree blocks/.test(k); }),
  'the payload counts the same sentence the console prints', JSON.stringify(byReason));
ok(byReason.every(function (k) { return !/in VLAN/.test(k); }),
  'no surface anywhere still files this frame under a VLAN reason', JSON.stringify(byReason));
ok((A.counters.drops.byReason || {})['no egress ports: spanning tree blocks Fa0/1'] === 1,
  'and counts it once, not once per blocked candidate');

// The same box, both surfaces, one story: the sentence the counter uses names a port the tree table calls blocking.
ok(new RegExp(blockedPort + '\\s+alternate\\s+blocking[\\s\\S]*no egress ports: spanning tree blocks ' + blockedPort)
  .test(A.tree + '\n' + A.ifaces),
  'the two surfaces on this box point at the same port');

// ---------------------------------------------------------------------------
// B. Where the port really is outside the VLAN, the VLAN wording is right and is kept.
// ---------------------------------------------------------------------------
console.log('Scenario B: a port that genuinely is not in the VLAN');
{
  const t = new Topology();
  t.addDevice(SWITCH, 's1'); t.addDevice(SWITCH, 's2');
  t.addDevice(PC, 'a'); t.addDevice(PC, 'b');
  t.connect('a', 'eth0', 's1', 'Fa0/1');
  t.connect('s1', 'Fa0/2', 's2', 'Fa0/1');
  t.connect('b', 'eth0', 's2', 'Fa0/2');
  const sim = new Simulator(t);
  runCommands(t.getDevice('s1'), t, sim, ['configure terminal', 'vlan 10',
    'interface Fa0/1', 'switchport access vlan 10',
    'interface Fa0/2', 'switchport mode trunk', 'end']);
  runCommands(t.getDevice('s2'), t, sim, ['configure terminal', 'vlan 10', 'vlan 20',
    'interface Fa0/1', 'switchport mode trunk',
    'interface Fa0/2', 'switchport access vlan 20', 'end']);
  runCommands(t.getDevice('a'), t, sim, ['configure terminal', 'interface eth0',
    'ip address 10.0.0.10 255.255.255.0', 'end']);
  sim.ping('a', '10.0.0.99', { count: 1 });
  const d = dropsFor(sim, 's2');
  ok(d.length === 1, 'one frame was lost at s2', 'drops=' + d.length);
  const w = d.length ? String(d[0].reason) : '';
  ok(/no egress ports in VLAN 10/.test(w), 'a real VLAN refusal still says VLAN 10', w);
  ok(!/spanning tree/.test(w), 'and does not blame the tree', w);
  const view = lines(runCommands(t.getDevice('s2'), t, sim, ['show interfaces Fa0/1'])).join('\n');
  ok(/switchport: trunk/.test(view) && /1 drop \(no egress ports in VLAN 10\)/.test(view),
    'the trunk port carries the VLAN sentence, next to a switchport line that agrees', view.split('\n').pop());
}

// ---------------------------------------------------------------------------
// C. A frame that cannot hairpin back down the port-channel it arrived on says so, rather than naming a VLAN.
// ---------------------------------------------------------------------------
console.log('Scenario C: the only other port is the far member of the ingress bundle');
{
  const t = new Topology();
  t.addDevice(SWITCH, 's1'); t.addDevice(SWITCH, 's2');
  t.addDevice(PC, 'a');
  t.connect('s1', 'Fa0/1', 's2', 'Fa0/1');
  t.connect('s1', 'Fa0/2', 's2', 'Fa0/2');
  t.connect('a', 'eth0', 's2', 'Fa0/3');
  const sim = new Simulator(t);
  const lag = ['configure terminal', 'interface Fa0/1', 'channel-group 1 mode active',
    'interface Fa0/2', 'channel-group 1 mode active', 'end'];
  runCommands(t.getDevice('s1'), t, sim, lag);
  runCommands(t.getDevice('s2'), t, sim, lag);
  runCommands(t.getDevice('a'), t, sim, ['configure terminal', 'interface eth0',
    'ip address 10.0.0.10 255.255.255.0', 'end']);
  sim.ping('a', '10.0.0.99', { count: 1 });
  const d = dropsFor(sim, 's1');
  ok(d.length === 1, 'one frame was lost at the bare switch', 'drops=' + d.length);
  const w = d.length ? String(d[0].reason) : '';
  ok(/ingress port-channel/.test(w), 'the reason names the port-channel the frame arrived on', w);
  ok(!/in VLAN/.test(w), 'and does not claim a VLAN problem either', w);
}

// ---------------------------------------------------------------------------
// D. Where the reason sits in `_lastDiscard()` did not move, and both wordings match that one slot.
// ---------------------------------------------------------------------------
console.log('Scenario D: the ranking slot still recognises both wordings');
{
  const sim = A.sim;
  const tree = { type: 'drop', dev: 'x', iface: 'Fa0/4', reason: 'no egress ports: spanning tree blocks Fa0/4' };
  const vlan = { type: 'drop', dev: 'x', iface: 'Fa0/3', reason: 'no egress ports in VLAN 7' };
  const acl = { type: 'acl-deny', dev: 'y', iface: 'Gi0/0', dir: 'in', acl: '110' };
  const silence = { type: 'drop', dev: 'z', iface: 'Gi0/1', discard: true, reason: 'no ARP reply from 10.9.9.9' };
  ok(sim._lastDiscard([tree]) === 'no egress ports: spanning tree blocks Fa0/4',
    'the tree wording is reported, not skipped as an empty slot');
  ok(sim._lastDiscard([vlan]) === 'no egress ports in VLAN 7', 'the VLAN wording still matches');
  ok(sim._lastDiscard([silence, tree]) === 'no ARP reply from 10.9.9.9',
    'silence still outranks it, exactly as before');
  ok(sim._lastDiscard([tree, acl]) === 'no egress ports: spanning tree blocks Fa0/4',
    'it still outranks policy, exactly as before');
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
