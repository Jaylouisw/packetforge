'use strict';
// A LAG member whose cable was out still took a share of the traffic (#1263).
//
// `selectMember()` filtered on `enabled` and nothing else, and the forwarding path's candidate list filtered
// spanning tree and VLAN membership and nothing else. So with one member unplugged - or shut, or facing a
// shut far port - the hash landed on the dead member for its share of the flows and dropped them, while a
// perfectly good member sat idle:
//
//   both links up      true,true,true,true
//   one member down    false,false,false,false,false,false      picks: Fa0/3 every time
//
// and `show etherchannel summary` reported both members `(P)` - "these ports are carrying traffic" - for a
// member whose link was down.
const path = require('path');
const { Topology, Simulator, runCommands } = require('../engine');
const { CliSession } = require('../engine/cli');
const { loadCatalog } = require('../devices/registry');
const lagLib = require('../engine/lag');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices')).filter(function (s) { return !s.error; });
const SWITCH = catalog.filter(function (s) { return s.model === 'generic-switch'; })[0];
const PC = catalog.filter(function (s) { return s.model === 'generic-pc'; })[0];

// a -- s1 ==(2-member LAG)== s2 -- b
function lab() {
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
  for (const id of ['s1', 's2']) {
    runCommands(t.getDevice(id), t, sim, ['configure terminal',
      'interface Fa0/2', 'channel-group 1 mode active',
      'interface Fa0/3', 'channel-group 1 mode active', 'end']);
  }
  runCommands(a, t, sim, ['configure terminal', 'interface eth0',
    'ip address 10.0.0.9 255.255.255.0', 'end']);
  runCommands(b, t, sim, ['configure terminal', 'interface eth0',
    'ip address 10.0.0.10 255.255.255.0', 'end']);
  return { t: t, sim: sim, s1: s1, s2: s2, a: a, b: b };
}

function linkOn(env, port) {
  return [...env.t.links.values()].filter(function (l) {
    return (l.a.deviceId === 's1' && l.a.iface === port) || (l.b.deviceId === 's1' && l.b.iface === port);
  })[0];
}

function summary(env) {
  return ((new CliSession(env.s1, env.t, env.sim).run('show etherchannel summary').output) || [])
    .map(String).join('\n');
}

function picks(env, count) {
  const r = env.sim.ping('a', '10.0.0.10', { count: count || 6 });
  return {
    ok: r.replies.every(function (x) { return x.success; }),
    replies: r.replies,
    picks: r.events.filter(function (e) { return e.type === 'lag' && e.dev === 's1'; })
      .map(function (e) { return e.picked; })
  };
}

console.log('');
console.log('A healthy bundle behaves exactly as it did:');
{
  const env = lab();
  const r = picks(env, 4);
  ok(r.ok, 'every ping is answered', r.replies.map(function (x) { return x.success; }).join(','));
  ok(r.picks.length > 0, 'the bundle is used', String(r.picks.length));
  ok(r.picks.every(function (p) { return p === 'Fa0/2' || p === 'Fa0/3'; }),
    'and only members carry the traffic', r.picks.join(','));
  ok(/Fa0\/2\(P\) Fa0\/3\(P\)/.test(summary(env)), 'both members read (P)', summary(env));
  ok(!/not bundled/.test(summary(env)), 'and nothing is called out as unbundled', summary(env));
}

console.log('');
console.log('One member loses its cable: the bundle keeps working, on the members that can:');
{
  const env = lab();
  picks(env, 2);
  env.sim.setLinkState(linkOn(env, 'Fa0/3').id, 'down');

  const r = picks(env, 8);
  ok(r.ok, 'every ping is still answered - the whole point',
    r.replies.map(function (x) { return x.success; }).join(','));
  ok(r.picks.every(function (p) { return p === 'Fa0/2'; }),
    'and no frame is hashed onto the dead member', r.picks.join(','));

  const text = summary(env);
  ok(/Fa0\/2\(P\) Fa0\/3\(D\)/.test(text), 'the table marks the dead member (D)', text);
  ok(/not bundled \(down: link down\)/.test(text), 'and says why, in the same words show interfaces uses', text);
  ok(/running on 1 of 2 members: Fa0\/2/.test(text), 'and reports what the bundle is running on', text);
}

console.log('');
console.log('Administratively down and a shut far port are different reasons, both unbundled:');
{
  const env = lab();
  runCommands(env.s1, env.t, env.sim, ['configure terminal', 'interface Fa0/3', 'shutdown', 'end']);
  const r = picks(env, 6);
  ok(r.ok, 'traffic still flows over the remaining member',
    r.replies.map(function (x) { return x.success; }).join(','));
  const text = summary(env);
  ok(/Fa0\/3\(D\)/.test(text), 'the shut member is (D)', text);
  ok(/not bundled \(administratively down\)/.test(text),
    'and the reason is the local shutdown, not a cable fault', text);

  const env2 = lab();
  // The far end of Fa0/3 shut on s2: s1's own port is fine, its peer is not.
  runCommands(env2.s2, env2.t, env2.sim, ['configure terminal', 'interface Fa0/3', 'shutdown', 'end']);
  const r2 = picks(env2, 6);
  ok(r2.ok, 'and with a shut far port, traffic still flows',
    r2.replies.map(function (x) { return x.success; }).join(','));
  const text2 = summary(env2);
  ok(/Fa0\/3\(D\)/.test(text2), 's1 marks that member down even though its own port is up', text2);
  ok(/peer shut down/.test(text2), 'naming the far end as the cause', text2);
}

console.log('');
console.log('No member can carry: the bundle says so, and the frames are accounted for:');
{
  const env = lab();
  env.sim.setLinkState(linkOn(env, 'Fa0/2').id, 'down');
  env.sim.setLinkState(linkOn(env, 'Fa0/3').id, 'down');
  const r = picks(env, 2);
  ok(!r.ok, 'the pings fail', r.replies.map(function (x) { return x.success; }).join(','));
  const text = summary(env);
  ok(/Fa0\/2\(D\) Fa0\/3\(D\)/.test(text), 'both members read (D)', text);
  ok(/bundle 1 is down: no member can carry a frame/.test(text),
    'and the bundle itself is reported down rather than looking degraded but alive', text);

  // The frames are still attempted and dropped with a reason, so the loss is countable (#1258) rather than
  // vanishing into a bundle that looks healthy.
  const lost = env.sim.dropsFor('s1');
  ok(lost.total > 0 && /link down/.test(JSON.stringify(lost.byReason)),
    'and the drops are counted with a reason', JSON.stringify({ total: lost.total, reasons: lost.byReason }));
}

console.log('');
console.log('The selection rule itself: eligibility is a predicate, and the order is unchanged:');
{
  const frame = { srcMac: '02:00:00:00:00:aa', dstMac: '02:00:00:00:00:bb', vid: 1 };
  const both = lagLib.selectMember(['Fa0/2', 'Fa0/3'], frame, 'l2');
  const again = lagLib.selectMember(['Fa0/3', 'Fa0/2'], frame, 'l2');
  ok(both === again, 'the pick does not depend on the order the config listed members', both + '/' + again);
  ok(lagLib.selectMember(['Fa0/2', 'Fa0/3'], frame, 'l2', { canCarry: function (n) { return n !== 'Fa0/3'; } }) === 'Fa0/2',
    'a member that cannot carry is not eligible');
  ok(lagLib.selectMember(['Fa0/2', 'Fa0/3'], frame, 'l2', { canCarry: function () { return false; } }) === null,
    'and null when nothing can, so the caller decides what that means');
  ok(lagLib.eligibleMembers(['Fa0/3', 'Fa0/2', 'Fa0/3'], function () { return true; }).join(',') === 'Fa0/2,Fa0/3',
    'eligibleMembers dedupes and sorts the same way');
  ok(lagLib.eligibleMembers([{ name: 'Fa0/2', enabled: false }, 'Fa0/3'], function () { return true; }).join(',') === 'Fa0/3',
    'and still honours the enabled flag');
}

console.log('');
console.log('The timeline records why a member was not used:');
{
  const env = lab();
  env.sim.setLinkState(linkOn(env, 'Fa0/3').id, 'down');
  const r = env.sim.ping('a', '10.0.0.10', { count: 1 });
  const ev = r.events.filter(function (e) { return e.type === 'lag' && e.dev === 's1'; })[0];
  ok(!!ev, 'a lag event is emitted');
  ok(JSON.stringify(ev.members) === JSON.stringify(['Fa0/2', 'Fa0/3']),
    'listing every member of the bundle', JSON.stringify(ev.members));
  ok(JSON.stringify(ev.live) === JSON.stringify(['Fa0/2']),
    'and the ones that could carry', JSON.stringify(ev.live));
  ok(ev.degraded === true, 'marked degraded, so a viewer does not have to diff two arrays');
  ok(ev.noLiveMember === false, 'and not marked dead');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
