'use strict';
// A broadcast was flooded into every port nobody had shut - including ports with no cable (#1273).
//
// `_forwardL2()` built its flood list from `activeInterfaces()`, which filters `enabled` and nothing else. So
// every broadcast went out of every spare port, was dropped on delivery ("link administratively down" for a
// shut port, nothing at all for an uncabled one), and `show interfaces` reported discards on ports that were
// never part of the path. A real switch floods to ports that are up, not to every port it owns.
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
const SWITCH = catalog.filter(function (s) { return s.model === 'generic-switch'; })[0];
const PC = catalog.filter(function (s) { return s.model === 'generic-pc'; })[0];

// a -- s1 -- s2 -- b, with every other port on both switches spare.
function line() {
  const t = new Topology();
  const s1 = t.addDevice(SWITCH, 's1');
  const s2 = t.addDevice(SWITCH, 's2');
  const a = t.addDevice(PC, 'a');
  const b = t.addDevice(PC, 'b');
  t.connect('a', 'eth0', 's1', 'Fa0/1');
  t.connect('s1', 'Fa0/2', 's2', 'Fa0/1');
  t.connect('b', 'eth0', 's2', 'Fa0/2');
  const sim = new Simulator(t);
  runCommands(a, t, sim, ['configure terminal', 'interface eth0',
    'ip address 10.0.0.9 255.255.255.0', 'end']);
  runCommands(b, t, sim, ['configure terminal', 'interface eth0',
    'ip address 10.0.0.10 255.255.255.0', 'end']);
  return { t: t, sim: sim, s1: s1, s2: s2, a: a, b: b };
}

function iface(env, dev, cmd) {
  return ((new CliSession(dev, env.t, env.sim).run(cmd).output) || []).map(String).join('\n');
}

// The counters block for one port, as the table prints it. Blocks begin with a port name at column 0, so the
// table is split into blocks first rather than sliced by string search.
function counters(env, dev, port) {
  const text = iface(env, dev, 'show interfaces');
  const blocks = [];
  let current = null;
  text.split('\n').forEach(function (line) {
    if (/^\S/.test(line) && /\(/.test(line)) {
      current = { head: line, lines: [] };
      blocks.push(current);
    } else if (current) {
      current.lines.push(line);
    }
  });
  const block = blocks.filter(function (b) { return b.head.split(' ')[0] === port; })[0];
  if (!block) return { nums: {}, drops: null, found: false };
  const nums = {};
  block.lines.forEach(function (l) {
    const m = /^\s+(\d+) packets (input|output), (\d+) bytes/.exec(l);
    if (m) { nums[m[2]] = Number(m[1]); nums[m[2] + 'Bytes'] = Number(m[3]); }
  });
  const dropLine = block.lines.filter(function (l) { return /drops \(/.test(l); })[0];
  return { nums: nums, drops: dropLine ? dropLine.trim() : null, found: true };
}

console.log('');
console.log('Spare ports see no traffic and record no discards:');
{
  const env = line();
  const r = env.sim.ping('a', '10.0.0.10', { count: 3 });
  ok(r.replies.every(function (x) { return x.success; }), 'the pings cross',
    r.replies.map(function (x) { return x.success; }).join(','));

  // Before the fix every broadcast was queued to all eight spares and dropped on arrival, so the device
  // total was non-zero for a lab in which nothing had gone wrong.
  const drops = env.sim.dropsFor('s1');
  ok(drops.total === 0, 'the switch discarded nothing', JSON.stringify(drops));

  for (const port of ['Fa0/3', 'Fa0/4', 'Fa0/8']) {
    const c = counters(env, env.s1, port);
    ok((c.nums.input || 0) === 0 && (c.nums.output || 0) === 0,
      port + ' is untouched, both directions', JSON.stringify(c.nums));
    ok(c.drops === null, port + ' records no discard', c.drops);
  }
  // The ports that did carry the traffic still report it, so the fix cannot be "count nothing".
  const carried = counters(env, env.s1, 'Fa0/2');
  ok((carried.nums.output || 0) > 0, 'the port that carried it still reports output',
    JSON.stringify(carried.nums));
}

console.log('');
console.log('A port whose cable is down is not a flood target:');
{
  const env = line();
  const link = [...env.t.links.values()].filter(function (l) {
    return (l.a.deviceId === 's1' && l.a.iface === 'Fa0/2') || (l.b.deviceId === 's1' && l.b.iface === 'Fa0/2');
  })[0];
  env.sim.setLinkState(link.id, 'down');
  const r = env.sim.ping('a', '10.0.0.10', { count: 1 });
  ok(r.replies.every(function (x) { return !x.success; }), 'the pings fail, as they must',
    r.replies.map(function (x) { return x.success; }).join(','));
  const c = counters(env, env.s1, 'Fa0/2');
  // The frame is not queued to it at all now; either way it must not be credited with input it never took.
  ok((c.nums.input || 0) === 0, 'the dead port took nothing in', JSON.stringify(c.nums));
}

console.log('');
console.log('A shut port is not a flood target, and a frame aimed at it is still counted:');
{
  const env = line();
  runCommands(env.s2, env.t, env.sim, ['configure terminal', 'interface Fa0/1', 'shutdown', 'end']);
  const r = env.sim.ping('a', '10.0.0.10', { count: 1 });
  ok(r.replies.every(function (x) { return !x.success; }), 'nothing gets through',
    r.replies.map(function (x) { return x.success; }).join(','));

  // A flood never went near it; a *unicast* whose known destination sits behind it is a real discard and
  // must still be counted, or the fix would have hidden a genuine loss.
  const reason = r.replies[0] && r.replies[0].reason;
  ok(!!reason, 'and the failure carries a reason', String(reason));
  ok(/link administratively down|peer port shut|no ARP reply/.test(reason),
    'naming the shut link or the unanswered ARP', String(reason));
}

console.log('');
console.log('A healthy lab reports no discards at all:');
{
  const env = line();
  env.sim.ping('a', '10.0.0.10', { count: 2 });
  for (const dev of [env.s1, env.s2]) {
    const d = env.sim.dropsFor(dev.id);
    ok(d.total === 0, dev.id + ' discarded nothing', JSON.stringify(d));
  }
  const text = iface(env, env.s1, 'show interfaces');
  ok(!/drops \(/.test(text), 'and show interfaces prints no drop summary', text.split('\n')
    .filter(function (l) { return /drops/.test(l); }).join(' | '));
}

console.log('');
console.log('A link that really did drop frames still reports them:');
{
  // Take the working link down *after* traffic has crossed it and a frame is aimed at the far side: the
  // discard has to be visible, or the fix traded a phantom for a silence.
  const env = line();
  env.sim.ping('a', '10.0.0.10', { count: 1 });
  const link = [...env.t.links.values()].filter(function (l) {
    return (l.a.deviceId === 's2' && l.a.iface === 'Fa0/2') || (l.b.deviceId === 's2' && l.b.iface === 'Fa0/2');
  })[0];
  env.sim.setLinkState(link.id, 'down');
  const r = env.sim.ping('b', '10.0.0.9', { count: 1 });
  ok(r.replies.every(function (x) { return !x.success; }), 'the ping fails',
    r.replies.map(function (x) { return x.success; }).join(','));
  const d = env.sim.dropsFor('s2');
  ok(d.total > 0, 'and the switch that threw the frame away has counted it', JSON.stringify(d));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
