'use strict';
// A shut port went on spanning, receiving and forwarding (#1274).
//
// Two defects that together black-holed a whole switch:
//
//   1. `computeStp()` put a port in the tree if its *cable* was up, so a port someone shut - and a port whose
//      far end someone shut - stayed an edge. The tree then kept blocking the port that would have healed the
//      ring. Pull the cable and the ring healed; shut the same port and it did not.
//   2. `_deliver()` checked the *sending* port and never the receiving one, so a frame aimed at a shut port
//      was delivered, learned from and forwarded. The ring never actually broke: frames were replicated
//      around it, a switch learned a host on the port it could not use, and a host's own address turned up in
//      another host's ARP cache.
//
// Measured before the fix, four-switch ring, PC on s1 and PC on s3:
//
//   all up     blocked {s3:[Fa0/2]}   ping true
//   cable out  blocked {}             ping true
//   far shut   blocked {s3:[Fa0/2]}   ping FALSE   <- s3 has no usable path left
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

// Four switches in a ring, a PC on s1 and a PC on s3, so every path between them is two hops of the ring.
function ring() {
  const t = new Topology();
  const s1 = t.addDevice(SWITCH, 's1');
  const s2 = t.addDevice(SWITCH, 's2');
  const s3 = t.addDevice(SWITCH, 's3');
  const s4 = t.addDevice(SWITCH, 's4');
  const a = t.addDevice(PC, 'a');
  const b = t.addDevice(PC, 'b');
  t.connect('s1', 'Fa0/1', 's2', 'Fa0/1');
  t.connect('s2', 'Fa0/2', 's3', 'Fa0/1');
  t.connect('s3', 'Fa0/2', 's4', 'Fa0/1');
  t.connect('s4', 'Fa0/2', 's1', 'Fa0/2');
  t.connect('a', 'eth0', 's1', 'Fa0/3');
  t.connect('b', 'eth0', 's3', 'Fa0/3');
  const sim = new Simulator(t);
  runCommands(a, t, sim, ['configure terminal', 'interface eth0',
    'ip address 10.0.0.9 255.255.255.0', 'end']);
  runCommands(b, t, sim, ['configure terminal', 'interface eth0',
    'ip address 10.0.0.10 255.255.255.0', 'end']);
  sim.computeStp();     // the addresses exist now, so the tree can be the one this lab really has
  return { t: t, sim: sim, s1: s1, s2: s2, s3: s3, s4: s4, a: a, b: b };
}

function blocked(env) {
  const out = {};
  for (const dev of env.t.devices.values()) {
    out[dev.id] = [...((dev.stp && dev.stp.blocked) || [])].sort();
  }
  return out;
}

function shut(env, deviceId, port) {
  runCommands(env.t.getDevice(deviceId), env.t, env.sim,
    ['configure terminal', 'interface ' + port, 'shutdown', 'end']);
  env.sim.computeStp();
}

function pull(env, aId, bId) {
  const link = [...env.t.links.values()].filter(function (l) {
    return [l.a.deviceId, l.b.deviceId].sort().join(',') === [aId, bId].sort().join(',');
  })[0];
  env.sim.setLinkState(link.id, 'down');
  env.sim.computeStp();
  return link;
}

function ping(env, count) {
  return env.sim.ping('a', '10.0.0.10', { count: count || 4 });
}

console.log('');
console.log('A ring with every link up blocks exactly one port, and works:');
{
  const env = ring();
  const bl = blocked(env);
  const total = Object.keys(bl).reduce(function (n, k) { return n + bl[k].length; }, 0);
  ok(total === 1, 'one port is blocked', JSON.stringify(bl));
  const r = ping(env);
  ok(r.replies.every(function (x) { return x.success; }), 'and the pings cross',
    r.replies.map(function (x) { return x.success; }).join(','));
}

console.log('');
console.log('Shutting a port heals the ring exactly as pulling the cable does:');
{
  const cableOut = ring();
  pull(cableOut, 's2', 's3');

  const farShut = ring();
  shut(farShut, 's3', 'Fa0/1');          // the same cable, made unusable from the far end

  const localShut = ring();
  shut(localShut, 's2', 'Fa0/2');        // ...and from the near end

  const cableTree = JSON.stringify(blocked(cableOut));
  ok(cableTree === JSON.stringify(blocked(farShut)),
    'a shut far port gives the tree a pulled cable gives', cableTree + ' vs ' + JSON.stringify(blocked(farShut)));
  ok(cableTree === JSON.stringify(blocked(localShut)),
    'and so does a locally shut port', cableTree + ' vs ' + JSON.stringify(blocked(localShut)));
  ok(cableTree === JSON.stringify({ s1: [], s2: [], s3: [], s4: [], a: [], b: [] }),
    'which is no blocked port at all, because the ring is broken', cableTree);

  for (const [name, env] of [['far shut', farShut], ['local shut', localShut], ['cable out', cableOut]]) {
    const r = ping(env, 6);
    ok(r.replies.every(function (x) { return x.success; }), name + ': traffic still crosses the ring',
      r.replies.map(function (x) { return x.success; }).join(','));
  }
}

console.log('');
console.log('A shut port receives nothing, so nothing is learned behind it:');
{
  const env = ring();
  shut(env, 's3', 'Fa0/1');
  const r = ping(env, 3);
  ok(r.replies.every(function (x) { return x.success; }), 'the pings cross',
    r.replies.map(function (x) { return x.success; }).join(','));

  // `a` is two hops away, on the other side of the ring. s3 must have learned it on the live side, never on
  // the shut port - which is what sent the reply out of a dead port before this fix.
  const table = [...env.s3.macTableFor(1).entries()];
  const aMac = env.a.interfaces.get('eth0').mac;
  const learned = table.filter(function (row) { return row[0] === aMac; })[0];
  ok(!!learned, 's3 learned the far host', JSON.stringify(table));
  ok(learned && learned[1] !== 'Fa0/1', 'and not on the shut port', JSON.stringify(learned));
  ok(table.every(function (row) { return row[1] !== 'Fa0/1'; }),
    'nothing at all is learned on the shut port', JSON.stringify(table));

  // No loop: before the fix frames were replicated around the break and this fired repeatedly.
  ok(r.events.filter(function (e) { return /loop/.test(e.reason || ''); }).length === 0,
    'no frame is caught by the loop guard');
}

console.log('');
console.log('Neither host ends up with a poisoned ARP cache:');
{
  const env = ring();
  shut(env, 's3', 'Fa0/1');
  ping(env, 3);
  const aArp = [...env.a.arp.entries()];
  const bArp = [...env.b.arp.entries()];
  ok(aArp.length === 1 && aArp[0][0] === '10.0.0.10',
    'a knows only b', JSON.stringify(aArp));
  ok(aArp[0] && aArp[0][1] === env.b.interfaces.get('eth0').mac,
    'and knows b by its real MAC', JSON.stringify(aArp));
  ok(bArp.length === 1 && bArp[0][0] === '10.0.0.9',
    'b knows only a', JSON.stringify(bArp));
  // The failure this replaces: a cached its own address pointing at a switch's bridge MAC.
  ok(!aArp.some(function (row) { return row[0] === '10.0.0.9'; }),
    'and nobody cached their own address', JSON.stringify(aArp));
}

console.log('');
console.log('A frame aimed into a shut port is a reasoned discard, not a silent loss:');
{
  // A line, so the only path is the shut one.
  const t = new Topology();
  const s1 = t.addDevice(SWITCH, 's1');
  const s2 = t.addDevice(SWITCH, 's2');
  const c = t.addDevice(PC, 'c');
  const d = t.addDevice(PC, 'd');
  t.connect('c', 'eth0', 's1', 'Fa0/1');
  t.connect('s1', 'Fa0/2', 's2', 'Fa0/1');
  t.connect('d', 'eth0', 's2', 'Fa0/2');
  const sim = new Simulator(t);
  runCommands(c, t, sim, ['configure terminal', 'interface eth0',
    'ip address 10.0.0.9 255.255.255.0', 'end']);
  runCommands(d, t, sim, ['configure terminal', 'interface eth0',
    'ip address 10.0.0.10 255.255.255.0', 'end']);

  const before = sim.ping('c', '10.0.0.10', { count: 1 });
  ok(before.replies.every(function (x) { return x.success; }), 'the line works while it is up',
    before.replies.map(function (x) { return x.success; }).join(','));

  runCommands(s2, t, sim, ['configure terminal', 'interface Fa0/1', 'shutdown', 'end']);
  const after = sim.ping('c', '10.0.0.10', { count: 1 });
  ok(after.replies.every(function (x) { return !x.success; }), 'and stops when the far port is shut',
    after.replies.map(function (x) { return x.success; }).join(','));
  const reason = after.replies[0] && after.replies[0].reason;
  ok(!!reason, 'the failure carries a reason', String(reason));

  // Whoever sent a frame into it has a counted discard naming the far end, so the loss is findable.
  const lost = after.events.filter(function (e) {
    return e.type === 'drop' && /peer port shut/.test(e.reason || '');
  });
  ok(lost.length > 0, 'and the discard names the shut far port',
    JSON.stringify(after.events.filter(function (e) { return e.type === 'drop'; }).slice(0, 3)));
}

console.log('');
console.log('Re-enabling the port puts the ring back:');
{
  const env = ring();
  const before = JSON.stringify(blocked(env));
  shut(env, 's3', 'Fa0/1');
  ok(JSON.stringify(blocked(env)) !== before, 'the tree changes when the port goes down');
  runCommands(env.s3, env.t, env.sim, ['configure terminal', 'interface Fa0/1', 'no shutdown', 'end']);
  env.sim.computeStp();
  ok(JSON.stringify(blocked(env)) === before, 'and returns when it comes back', JSON.stringify(blocked(env)));
  const r = ping(env);
  ok(r.replies.every(function (x) { return x.success; }), 'traffic crosses on the healed ring',
    r.replies.map(function (x) { return x.success; }).join(','));
}

console.log('');
console.log('A lab with nothing wrong is untouched:');
{
  // Two switches in a line, no ring: nothing to block, nothing to heal, no new discards.
  const t = new Topology();
  const s1 = t.addDevice(SWITCH, 's1');
  const s2 = t.addDevice(SWITCH, 's2');
  const c = t.addDevice(PC, 'c');
  const d = t.addDevice(PC, 'd');
  t.connect('c', 'eth0', 's1', 'Fa0/1');
  t.connect('s1', 'Fa0/2', 's2', 'Fa0/1');
  t.connect('d', 'eth0', 's2', 'Fa0/2');
  const sim = new Simulator(t);
  runCommands(c, t, sim, ['configure terminal', 'interface eth0',
    'ip address 10.0.0.9 255.255.255.0', 'end']);
  runCommands(d, t, sim, ['configure terminal', 'interface eth0',
    'ip address 10.0.0.10 255.255.255.0', 'end']);
  const r = sim.ping('c', '10.0.0.10', { count: 4 });
  ok(r.replies.every(function (x) { return x.success; }), 'the pings cross',
    r.replies.map(function (x) { return x.success; }).join(','));
  const bl = blocked({ t: t });
  ok(Object.keys(bl).every(function (k) { return bl[k].length === 0; }), 'nothing is blocked',
    JSON.stringify(bl));
  ok(sim.dropsFor('s1').total === 0 || sim.dropsFor('s1').byReason['peer port shut'],
    'and no discard is invented', JSON.stringify(sim.dropsFor('s1')));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
