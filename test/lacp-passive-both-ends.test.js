'use strict';
// Two ends in `mode passive` never form a bundle, and this model built one anyway.
//
// `channel-group 1 mode passive` stores a mode, validates it, and prints it back - and then nothing read it
// when the bundle was brought up. The summary said `Po1(SU)` with both members `(P)`, the data plane hashed
// frames across them, and a ping across a pair of passive/passive switches worked. On the hardware no such
// bundle exists: a passive port answers LACP and never starts it, so two passive ends wait for a partner
// neither of them sends -
//
//   "A port in the passive mode cannot form an EtherChannel with another port that is also in the passive mode
//    because neither port starts LACP negotiation."      Cisco, Configuring EtherChannels (LACP modes)
//
// - and the unnegotiated member is not lost, it "is put into an independent state and continues to carry data
// traffic as would any other single link" (same chapter). So the expected picture is a bundle that is down and
// two ports that still forward: (SD) with (I) stand-alone members, no hashing, and the spanning tree seeing two
// links where the bundle used to be one, so one of them is blocked. The letter is `(I)` and not `(s)` because
// the key printed above the table reserves `s - suspended` for a member that is not carrying: these two are,
// and the state the 2960/3750 chapters name for them is "independent" - `I - stand-alone`
// (research/lacp-one-sided-group.md).
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

// a -- s1 ==(Fa0/2 + Fa0/3)== s2 -- b
function lab(modeA, modeB) {
  const t = new Topology();
  const s1 = t.addDevice(SWITCH, 's1');
  const s2 = t.addDevice(SWITCH, 's2');
  const a = t.addDevice(PC, 'a');
  const b = t.addDevice(PC, 'b');
  t.connect('a', 'eth0', 's1', 'Fa0/1');
  t.connect('b', 'eth0', 's2', 'Fa0/1');
  t.connect('s1', 'Fa0/2', 's2', 'Fa0/2');
  t.connect('s1', 'Fa0/3', 's2', 'Fa0/3');
  const sim = new Simulator(t);
  if (modeA !== null) {
    runCommands(s1, t, sim, ['configure terminal', 'interface Fa0/2', 'channel-group 1 mode ' + modeA,
      'interface Fa0/3', 'channel-group 1 mode ' + modeA, 'end']);
  }
  if (modeB !== null) {
    runCommands(s2, t, sim, ['configure terminal', 'interface Fa0/2', 'channel-group 1 mode ' + modeB,
      'interface Fa0/3', 'channel-group 1 mode ' + modeB, 'end']);
  }
  runCommands(a, t, sim, ['configure terminal', 'interface eth0',
    'ip address 10.0.0.9 255.255.255.0', 'end']);
  runCommands(b, t, sim, ['configure terminal', 'interface eth0',
    'ip address 10.0.0.10 255.255.255.0', 'end']);
  return { t: t, sim: sim, s1: s1, s2: s2, a: a, b: b };
}

function summary(env, dev) {
  return ((new CliSession(dev, env.t, env.sim).run('show etherchannel summary').output) || []).map(String);
}

function rowFor(lines, id) {
  return lines.filter(function (l) { return l.indexOf(String(id) + ' ') === 0; })[0] || '';
}

function notes(lines, id) {
  const i = lines.findIndex(function (l) { return l.indexOf(String(id) + ' ') === 0; });
  if (i === -1) return [];
  const out = [];
  for (let j = i + 1; j < lines.length; j++) {
    if (!/^  /.test(lines[j])) break;
    out.push(lines[j]);
  }
  return out;
}

function ping(env, count) {
  return env.sim.ping('a', '10.0.0.10', { count: count || 3 });
}

console.log('');
console.log('Two passive ends: no bundle, and both ports carry on as single links.');
{
  const env = lab('passive', 'passive');
  const lines = summary(env, env.s1);
  const row = rowFor(lines, 1);
  ok(/Po1\(SD\)/.test(row), 'the port-channel is down, not in use', row);
  ok(/Fa0\/2\(I\)/.test(row), 'member Fa0/2 is stand-alone, not bundled', row);
  ok(/Fa0\/3\(I\)/.test(row), 'member Fa0/3 is stand-alone, not bundled', row);
  ok(!/\(P\)/.test(row), 'no member claims to be carrying as a member', row);
  const why = notes(lines, 1).join(' | ');
  ok(/passive/.test(why), 'the reason names the mode that could not negotiate', why);
  ok(/single link/.test(why), 'and says the port still carries traffic on its own', why);
  ok(/no member joined it/.test(why), 'the bundle says nothing joined it', why);
  ok(!/traffic is dropped/.test(why), 'it does not claim the traffic is lost - the ports still forward', why);

  // The frames are the proof: they still cross (as two single links), and none of them was hashed onto a
  // bundle member, because there is no bundle.
  const r = ping(env);
  ok(r.replies.length === 3 && r.replies.every(function (x) { return x.success; }),
    'the ping still crosses the two switches', JSON.stringify(r.replies.map(function (x) { return x.success; })));
  ok(r.replies.length === 3, 'and each echo came back once - no duplicate from a loop',
    String(r.replies.length));
  ok(r.events.filter(function (e) { return e.type === 'lag'; }).length === 0,
    'no frame was hashed onto a bundle, because there is none',
    String(r.events.filter(function (e) { return e.type === 'lag'; }).length));

  // With the bundle gone the tree sees two parallel links between the bridges, which is a loop: exactly one
  // of them has to be blocked, or a broadcast would circle for ever.
  const blocked = [...((env.s2.stp && env.s2.stp.blocked) || [])];
  ok(blocked.filter(function (p) { return p === 'Fa0/2' || p === 'Fa0/3'; }).length === 1,
    'the spanning tree blocks one of the two parallel links', JSON.stringify(blocked));
  ok(summary(env, env.s2).filter(function (l) { return l.indexOf('1 ') === 0; })
    .some(function (l) { return /Po1\(SD\)/.test(l); }),
    'the far end agrees: its bundle is down too');

  // The configuration is untouched: a suspended port is a working state, not a rejected command.
  const cfg = ((new CliSession(env.s1, env.t, env.sim).run('show running-config').output) || []).join('\n');
  ok(/channel-group 1 mode passive/.test(cfg), 'the mode is still in the configuration');
}

console.log('');
console.log('The modes that do negotiate are untouched:');
{
  const ap = lab('active', 'passive');
  const row = rowFor(summary(ap, ap.s1), 1);
  ok(/Po1\(SU\)/.test(row), 'active + passive still bundles', row);
  ok(/Fa0\/2\(P\)/.test(row) && /Fa0\/3\(P\)/.test(row), 'and both members are in it', row);
  const r = ping(ap);
  ok(r.replies.length === 3 && r.replies.every(function (x) { return x.success; }),
    'and traffic crosses', String(r.replies.length));
  ok(r.events.filter(function (e) { return e.type === 'lag'; }).length > 0,
    'on the bundle, not on a single link',
    String(r.events.filter(function (e) { return e.type === 'lag'; }).length));

  const aa = lab('active', 'active');
  ok(/Po1\(SU\)/.test(rowFor(summary(aa, aa.s1), 1)), 'active + active still bundles',
    rowFor(summary(aa, aa.s1), 1));

  const on = lab('on', 'on');
  ok(/Po1\(SU\)/.test(rowFor(summary(on, on.s1), 1)), 'on + on still bundles',
    rowFor(summary(on, on.s1), 1));
}

// A far end in no channel group is the same question with a shorter answer - nothing over there answers
// LACP, so nothing is bundled - and it has its own file, because it changes what a one-ended lab does:
// test/lacp-one-sided-group.test.js.

console.log(String.fromCharCode(10) + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
