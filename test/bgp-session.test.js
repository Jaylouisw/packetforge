'use strict';

// A BGP session is a TCP conversation, not a config match.
//
// `engine/bgp.js` has carried the RFC 4271 state machine since it was written, and nothing
// ever walked it: `computeBgp()` declared a session established when two routers each had a
// `neighbor` line pointing at the other, and silently `continue`d past every mismatch. Two
// consequences, both of which flatter a lab:
//
//   - a peering over a link that is down, or with a route in only one direction, "came up";
//   - a refused session left no trace, so `show ip bgp summary` could not say why.
//
// The second is the worse one for a teaching tool: half of what a technician learns is
// reading a state other than Established and knowing which of Connect, Active, OpenSent and
// OpenConfirm they are stuck in. So the walk is real now, and every refusal is named.

const path = require('path');
const { Topology, Simulator, runCommands } = require('../engine');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg); }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
function spec(vendor, model) {
  const s = catalog.find(function (x) { return x.vendor === vendor && x.model === model; });
  if (!s) throw new Error('missing spec ' + vendor + '/' + model);
  return s;
}

function cli(t, dev, cmds) {
  return runCommands(dev, t, null, ['enable', 'configure terminal'].concat(cmds)).lines;
}

// Two routers, one link, eBGP, with a host subnet behind each. Nothing is reachable without
// BGP, so a session that does not come up shows as routes that never arrive.
function build() {
  const t = new Topology();
  const r1 = t.addDevice(spec('generic', 'generic-router'));
  const r2 = t.addDevice(spec('generic', 'generic-router'));
  r1.name = 'R1'; r2.name = 'R2';

  t.connect(r1.id, 'Gi0/1', r2.id, 'Gi0/1');

  cli(t, r1, [
    'interface Gi0/0', 'ip address 10.1.1.1 255.255.255.0', 'exit',
    'interface Gi0/1', 'ip address 10.0.12.1 255.255.255.0', 'exit',
    'router bgp 65001', 'neighbor 10.0.12.2 remote-as 65002', 'network 10.1.1.0 mask 255.255.255.0', 'exit'
  ]);
  cli(t, r2, [
    'interface Gi0/0', 'ip address 10.2.2.1 255.255.255.0', 'exit',
    'interface Gi0/1', 'ip address 10.0.12.2 255.255.255.0', 'exit',
    'router bgp 65002', 'neighbor 10.0.12.1 remote-as 65001', 'network 10.2.2.0 mask 255.255.255.0', 'exit'
  ]);
  return { t: t, r1: r1, r2: r2 };
}

function prefixes(dev) {
  return (dev.bgpRoutes || []).map(function (r) {
    return r.dest + '/' + String(r.prefix === undefined ? r.mask : r.prefix);
  });
}

console.log('A session that can come up, comes up by walking the FSM:');
{
  const lab = build();
  const sim = new Simulator(lab.t);
  sim.computeBgp();
  ok(sim.bgpSessions === 1, 'one eBGP session (got ' + sim.bgpSessions + ')');

  const list = sim.bgpSessionList || [];
  ok(list.length === 2, 'both directions recorded (' + list.length + ' records for 1 session)');
  const est = list.filter(function (s) { return s.established; });
  ok(est.length === 2, 'both are established');

  const walk = est[0] && est[0].events ? est[0].events.map(function (e) { return e.event; }) : [];
  ok(walk.join('>') === 'manual-start>tcp-connected>open-received>keepalive-received',
    'the walk went idle > connect > opensent > openconfirm > established');
}

console.log('\nAnd the routes move, which is the point of the session:');
{
  const lab = build();
  const sim = new Simulator(lab.t);
  sim.computeBgp();
  const routes = prefixes(lab.r2);
  const learned = routes.some(function (x) { return x.indexOf('10.1.1.0/') === 0; });
  ok(learned, 'R2 learned 10.1.1.0/24 over the session (' + routes.join(' ') + ')');
}

console.log('\nA peer that has not configured us is not a session:');
{
  const lab = build();
  cli(lab.t, lab.r2, ['router bgp 65002', 'no neighbor 10.0.12.1 remote-as 65001', 'exit']);
  const sim = new Simulator(lab.t);
  sim.computeBgp();
  ok(sim.bgpSessions === 0, 'zero sessions, not one (' + sim.bgpSessions + ')');

  const codes = (sim.bgpSessionList || []).filter(function (s) { return !s.established; })
    .map(function (s) { return s.code; });
  ok(codes.indexOf('E_PEER_NOT_CONFIGURED') !== -1, 'and it says why: ' + codes.join(', '));

  const leaked = prefixes(lab.r2).some(function (x) { return x.indexOf('10.1.1.0/') === 0; });
  ok(!leaked, 'R2 learned nothing from a session that is not up (' + prefixes(lab.r2).join(' ') + ')');
}

console.log('\nA remote-as that disagrees with the peer is not a session:');
{
  const lab = build();
  cli(lab.t, lab.r2, ['router bgp 65002', 'neighbor 10.0.12.1 remote-as 65099', 'exit']);
  const sim = new Simulator(lab.t);
  sim.computeBgp();
  ok(sim.bgpSessions === 0, 'zero sessions (' + sim.bgpSessions + ')');
  const codes = (sim.bgpSessionList || []).map(function (s) { return s.code; });
  ok(codes.indexOf('E_REMOTE_AS_MISMATCH') !== -1, 'reported as a remote-as mismatch: ' + codes.join(', '));
}

console.log('\nA session over a link that is down never leaves Connect:');
{
  const lab = build();
  cli(lab.t, lab.r1, ['interface Gi0/1', 'shutdown', 'exit']);
  const sim = new Simulator(lab.t);
  sim.computeBgp();
  ok(sim.bgpSessions === 0, 'zero sessions over a shut interface (' + sim.bgpSessions + ')');

  const refused = (sim.bgpSessionList || []).filter(function (s) { return !s.established; });
  const codes = refused.map(function (s) { return s.code; });
  ok(codes.indexOf('E_IFACE_DOWN') !== -1, 'and blames the port, not the config: ' + codes.join(', '));

  // The state a technician would actually see. Connect means TCP never opened, which is a
  // different fault from an OPEN the far end rejected.
  const died = refused.filter(function (s) { return s.diedIn; }).map(function (s) { return s.diedIn; });
  ok(died.indexOf('connect') !== -1, 'the walk died in connect (' + died.join(',') + ')');
}

console.log('\nA neighbour address that is not on any subnet cannot be opened:');
{
  const lab = build();
  cli(lab.t, lab.r1, ['router bgp 65001', 'no neighbor 10.0.12.2 remote-as 65002',
    'neighbor 192.0.2.99 remote-as 65002', 'exit']);
  const sim = new Simulator(lab.t);
  sim.computeBgp();
  ok(sim.bgpSessions === 0, 'zero sessions (' + sim.bgpSessions + ')');
  const codes = (sim.bgpSessionList || []).map(function (s) { return s.code; });
  ok(codes.indexOf('E_PEER_NOT_ON_SUBNET') !== -1,
    'reported as a neighbour with no next hop: ' + codes.join(', '));
}

console.log('\nThe refusals reach the event log, where a lab is read:');
{
  const lab = build();
  cli(lab.t, lab.r2, ['router bgp 65002', 'no neighbor 10.0.12.1 remote-as 65001', 'exit']);
  const sim = new Simulator(lab.t);
  sim.reset();
  sim.computeBgp();
  const events = sim.events.filter(function (e) { return e.type === 'bgp-session'; });
  ok(events.length > 0, events.length + ' bgp-session event(s) emitted');
  const refusedEvent = events.filter(function (e) { return e.established === false; })[0];
  ok(refusedEvent && refusedEvent.code, 'a refusal carries a machine-readable code (' +
    (refusedEvent && refusedEvent.code) + ')');
  ok(refusedEvent && typeof refusedEvent.summary === 'string' && refusedEvent.summary.indexOf('BGP') !== -1,
    'and a human-readable summary: ' + (refusedEvent && refusedEvent.summary));
}

console.log('\nAnd the box can tell you, in the command a technician would type:');
{
  const lab = build();
  const sim = new Simulator(lab.t);
  sim.reset();
  sim.computeBgp();
  const up = runCommands(lab.r1, lab.t, null, ['enable', 'show ip bgp summary']).lines.join('\n');
  ok(/Established/.test(up), 'a live session reads Established');
  ok(/10\.0\.12\.2/.test(up), 'against the peer address');
  ok(/AS number 65001/.test(up), 'under the local AS');

  cli(lab.t, lab.r2, ['router bgp 65002', 'no neighbor 10.0.12.1 remote-as 65001', 'exit']);
  sim.computeBgp();
  const down = runCommands(lab.r1, lab.t, null, ['enable', 'show ip bgp summary']).lines.join('\n');
  ok(!/Established/.test(down), 'a refused one does not');
  const idle = down.split('\n').filter(function (l) { return /Idle/.test(l); }).join('').trim();
  ok(/no neighbour 10\.0\.12\.1/.test(down), 'and says why, in the table: ' + idle);
  ok(/0 of 1 neighbour/.test(down), 'and counts zero established');
}

console.log('');
if (failed) { console.log(failed + ' failed, ' + passed + ' passed'); process.exit(1); }
console.log(passed + ' passed, 0 failed');
