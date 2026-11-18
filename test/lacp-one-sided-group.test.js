'use strict';
// A channel group configured at one end of the cable only: does a bundle come up?
//
// No. LACP is a conversation, and a far port that never configured a channel group never sends or answers
// an LACPDU, so the near end gets no response and nothing is bundled. This model built the bundle anyway:
// `channel-group 1 mode active` on one switch, a plain access port on the other, and the summary read
// `Po1(SU)` with both members `(P)` while the data plane hashed frames across two links that the far end
// sees as unrelated single ports.
//
//   "When you configure one end of an EtherChannel in either PAgP or LACP mode, the system negotiates with
//    the other end of the channel to determine which ports should become active. Incompatible ports are
//    suspended. Beginning with Cisco IOS Release 12.2(35)SE, instead of a suspended state, the local port is
//    put into an independent state and continues to carry data traffic as would any other single link. The
//    port configuration does not change, but the port does not participate in the EtherChannel."
//     - Catalyst 2960, Configuring EtherChannels, 12.2(46)SE (the platform these views follow)
//
//   "When no response is received from an LACP peer, ports in the port channel are moved to suspended state."
//     - Catalyst 9200/9300/9600 Layer 2 Configuration Guide, 17.13/17.14/17.17 (IOS XE), same chapter
//
// Both generations agree on the rule: the bundle does not exist and the port keeps carrying traffic as
// itself. They disagree on the flag letter - IOS XE says suspended, the 2960 chapter says an independent
// state (which its summary key spells `I - stand-alone`), and the IOS XE page also carries "with
// CSCtn96950, by default, standalone mode is enabled" beside a note saying the opposite. This model has one
// word for "negotiated nothing but still forwards" and prints it for every way of losing the negotiation:
// `(I)` stand-alone, the flag the key above the table gives a port that is operating independently, because
// `(s)` suspended is the flag the same key gives a port that is NOT carrying. research/lacp-one-sided-group.md
// records the platform split behind that choice.
//
// `on` is deliberately outside the rule: it negotiates nothing, so there is no answer to wait for, and the
// vendor says the switch *forces* the bundle up - which is why one-sided `on` still reads (SU) below.
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

// a -- s1 ==(Fa0/2 + Fa0/3)== s2 -- b. `modeA` is configured on s1; `modeB` on s2 when it is not null, so
// null is the single-ended lab this file is about.
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

// The whole picture for one negotiating mode, identical for active and passive: no partner, no bundle.
function noPartner(mode) {
  console.log('');
  console.log('One end in mode ' + mode + ', the other end in no group:');
  const env = lab(mode, null);
  const lines = summary(env, env.s1);
  const row = rowFor(lines, 1);
  ok(/Po1\(SD\)/.test(row), 'the port-channel is down, not in use', row);
  ok(/Fa0\/2\(I\)/.test(row), 'member Fa0/2 is stand-alone, not bundled', row);
  ok(/Fa0\/3\(I\)/.test(row), 'member Fa0/3 is stand-alone, not bundled', row);
  ok(!/\(P\)/.test(row), 'no member claims to be carrying as a member', row);
  const why = notes(lines, 1).join(' | ');
  ok(/no channel group/.test(why), 'the reason names the far end having no group', why);
  ok(/single link/.test(why), 'and says the port still carries traffic on its own', why);
  ok(/no member joined it/.test(why), 'the bundle says nothing joined it', why);
  ok(!/traffic is dropped/.test(why), 'it does not claim the traffic is lost', why);

  // Frames: they cross, over the links that exist, and none was hashed onto a bundle that is not there.
  const r = ping(env);
  ok(r.replies.length === 3 && r.replies.every(function (x) { return x.success; }),
    'the ping still crosses the two switches', JSON.stringify(r.replies.map(function (x) { return x.success; })));
  ok(r.events.filter(function (e) { return e.type === 'lag'; }).length === 0,
    'no frame was hashed onto a bundle, because there is none',
    String(r.events.filter(function (e) { return e.type === 'lag'; }).length));

  // With the bundle gone, the tree sees two parallel links and has to block one.
  const blocked = [...((env.s2.stp && env.s2.stp.blocked) || [])];
  ok(blocked.filter(function (p) { return p === 'Fa0/2' || p === 'Fa0/3'; }).length === 1,
    'the spanning tree blocks one of the two parallel links', JSON.stringify(blocked));

  // The far end never made a bundle, so its view has no group at all.
  const far = summary(env, env.s2);
  ok(far.some(function (l) { return /Number of channel-groups in use: 0/.test(l); }),
    'the end that configured no group counts no groups',
    far.filter(function (l) { return /Number of/.test(l); }).join(' | '));

  // A refusal in the data plane, yes; a rejected command, no. The mode is still in the configuration.
  const cfg = ((new CliSession(env.s1, env.t, env.sim).run('show running-config').output) || []).join('\n');
  ok(new RegExp('channel-group 1 mode ' + mode).test(cfg), 'the mode is still in the configuration');
}

noPartner('active');
noPartner('passive');

console.log('');
console.log('One end in mode on: no negotiation, so nothing to lose - the bundle is forced up:');
{
  const env = lab('on', null);
  const row = rowFor(summary(env, env.s1), 1);
  ok(/Po1\(SU\)/.test(row), 'a one-ended static group still comes up', row);
  ok(/Fa0\/2\(P\)/.test(row) && /Fa0\/3\(P\)/.test(row), 'with both members in it', row);
}

console.log('');
console.log('Two ends in the same negotiating mode are untouched:');
{
  const env = lab('active', 'active');
  const row = rowFor(summary(env, env.s1), 1);
  ok(/Po1\(SU\)/.test(row), 'active + active still bundles', row);
  const r = ping(env);
  ok(r.replies.length === 3 && r.replies.every(function (x) { return x.success; }),
    'and traffic crosses', String(r.replies.length));
  ok(r.events.filter(function (e) { return e.type === 'lag'; }).length > 0,
    'on the bundle, not on a single link',
    String(r.events.filter(function (e) { return e.type === 'lag'; }).length));
}

console.log('');
console.log('A member whose far port cannot name a group at all - a PC, a router port:');
{
  const t = new Topology();
  const s = t.addDevice(SWITCH, 's1');
  const p = t.addDevice(PC, 'p');
  t.connect('p', 'eth0', 's1', 'Fa0/1');
  const sim = new Simulator(t);
  runCommands(s, t, sim, ['configure terminal', 'interface Fa0/1', 'channel-group 1 mode active', 'end']);
  const lines = summary({ t: t, sim: sim }, s);
  const row = rowFor(lines, 1);
  ok(/Po1\(SD\)/.test(row), 'the bundle is down', row);
  ok(/Fa0\/1\(I\)/.test(row), 'the member is stand-alone, not bundled', row);
  const why = notes(lines, 1).join(' | ');
  ok(/no channel group/.test(why), 'and the reason is the same one', why);
}

console.log(String.fromCharCode(10) + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
