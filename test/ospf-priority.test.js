'use strict';
// `ip ospf priority` and the election that reads it.
//
// The `Pri` column of `show ip ospf neighbor` was a constant 1 and the DR/BDR role beside it was
// decided by router ID alone, because the setting did not exist: `ip ospf priority` answered the
// usage line. The rule a box applies is published twice, and the two agree:
//
//   * Cisco IOS IP Routing: OSPF Command Reference, `ip ospf priority` - range 0-255, default 1,
//     "the one with the higher router priority takes precedence. If there is a tie, the router with
//     the higher router ID takes precedence", and "A router with a router priority set to zero is
//     ineligible to become the designated router or backup designated router."
//     https://cisco.com/c/en/us/td/docs/ios-xml/ios/iproute_ospf/command/iro-cr-book.pdf
//   * RFC 2328 9.4 - routers with Router Priority 0 are discarded from the candidate list before
//     the election; the BDR election then excludes the router that just became DR, so a segment
//     with a single eligible speaker has no BDR at all.
//     https://www.rfc-editor.org/rfc/rfc2328.html#section-9.4
//
// The pair-of-DROTHERs case is the one place this model deliberately differs from a box's display:
// with both ends at 0 no DR exists, so a real pair stops at `2WAY/DROTHER` and carries no route.
// This console has no two-way state, so the link is refused and the reason is printed rather than a
// `FULL` the hardware cannot produce.
const { loadCatalog } = require('../devices/registry');
const { Topology } = require('../engine/topology');
const { Simulator } = require('../engine/simulator');
const cliModule = require('../engine/cli');
const CliSession = cliModule.CliSession || cliModule;

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}
const ROOT = require('path').join(__dirname, '..');
const specs = loadCatalog(ROOT + '/devices').filter(function (s) { return !s.error; });
const ROUTER = specs.find(function (s) { return /^ISR 4331$/.test(s.model); });
const SERIAL = specs.find(function (s) { return /^2811$/.test(s.model); });

function sess(t, id, sim) { return new CliSession(t.getDevice(id), t, sim || null); }
function configure(t, id, cmds) {
  const s = sess(t, id);
  const out = [];
  ['enable', 'configure terminal'].concat(cmds).forEach(function (c) {
    out.push(((s.run(c) || {}).output || []).join(' '));
  });
  return out.filter(Boolean).join('\n');
}
function show(t, sim, id, cmd) { return ((sess(t, id, sim).run(cmd) || {}).output || []).join('\n'); }
function rowOf(text, name) {
  return text.split('\n').filter(function (l) { return l.trim().indexOf(name + ' ') === 0; })[0] || '';
}
function stateOf(text, peer) {
  const row = rowOf(text, peer);
  const m = /\s(FULL|2WAY)\s*\/\s*(\S+)/.exec(row);
  return m ? m[1] + '/' + m[2] : '';
}

// r1 (1.1.1.1) --- r2 (2.2.2.2) on one cable, so the router ID tie-break has a definite answer.
function pair() {
  const t = new Topology();
  ['r1', 'r2'].forEach(function (id) { t.addDevice(ROUTER, id); });
  t.connect('r1', 'Gi0/0/0', 'r2', 'Gi0/0/0', { mediaId: '1000base-t', speedMbps: 1000 });
  const addr = function (id, ip) {
    const i = t.getDevice(id).interfaces.get('Gi0/0/0');
    i.ip = ip; i.mask = '255.255.255.0';
  };
  addr('r1', '10.1.0.1'); addr('r2', '10.1.0.2');
  configure(t, 'r1', ['ospf router-id 1.1.1.1']);
  configure(t, 'r2', ['ospf router-id 2.2.2.2']);
  return t;
}
function recompute(t) { const sim = new Simulator(t); sim.computeOspf(); return sim; }

console.log('');
console.log('The default is IOS\'s 1, and the higher router ID is still the DR:');
{
  const t = pair();
  const sim = recompute(t);
  const r1 = show(t, sim, 'r1', 'show ip ospf neighbor');
  const r2 = show(t, sim, 'r2', 'show ip ospf neighbor');
  // The State cell carries the *neighbour's* role: r2 (higher ID) is the DR, so r1 reads FULL/DR.
  ok(stateOf(r1, '2.2.2.2') === 'FULL/DR', 'r1 reads r2 as FULL/DR at the default priority', r1);
  ok(stateOf(r2, '1.1.1.1') === 'FULL/BDR', 'and r2 reads r1 as FULL/BDR', r2);
  ok(/\s1\s+FULL\/DR/.test(rowOf(r1, '2.2.2.2')), 'the Pri column prints 1, the hardware default',
    rowOf(r1, '2.2.2.2'));
  const iface = show(t, sim, 'r1', 'show ip ospf interface');
  ok(/\bPri\b/.test(iface), 'show ip ospf interface has a Pri column', iface);
  ok(/\s1\s+yes\s+no\s*$/.test(rowOf(iface, 'Gi0/0/0')),
    'and prints the port\'s own priority beside its adjacency', rowOf(iface, 'Gi0/0/0'));
}

console.log('');
console.log('A configured priority outranks the router ID, on both sides of the cable:');
{
  const t = pair();
  configure(t, 'r1', ['interface Gi0/0/0', 'ip ospf priority 200']);
  const sim = recompute(t);
  const r1 = show(t, sim, 'r1', 'show ip ospf neighbor');
  const r2 = show(t, sim, 'r2', 'show ip ospf neighbor');
  ok(stateOf(r1, '2.2.2.2') === 'FULL/BDR', 'the higher-ID box is now the BDR', r1);
  ok(stateOf(r2, '1.1.1.1') === 'FULL/DR', 'and the low-ID box is the DR', r2);
  ok(/\s200\s+FULL\/DR/.test(rowOf(r2, '1.1.1.1')),
    'the neighbour table prints the priority the far end carries in its Hello', rowOf(r2, '1.1.1.1'));
  ok(/\s200\s+yes\s+no\s*$/.test(rowOf(show(t, sim, 'r1', 'show ip ospf interface'), 'Gi0/0/0')),
    'and the box that set it reads 200 back on its own port',
    rowOf(show(t, sim, 'r1', 'show ip ospf interface'), 'Gi0/0/0'));

  // Roles are display-only: the two routers are still one connected wire, and no O route is
  // invented for a network each box already owns.
  const routes = show(t, sim, 'r2', 'show ip route');
  ok(/^C\s+10\.1\.0\.0\/24/m.test(routes), 'the connected route is still the route', routes);
  ok(!/^O\s/m.test(routes), 'and the election invented no O route for it', routes);
  ok((t.getDevice('r2').ospfNeighbors || []).length === 1,
    'and the adjacency itself is unchanged', JSON.stringify(t.getDevice('r2').ospfNeighbors));

  const run = show(t, sim, 'r1', 'show running-config');
  ok(/^\s+ip ospf priority 200$/m.test(run), 'running-config prints the line the parser takes back', run);
  // Round trip: a fresh box fed that line holds the same priority.
  const t2 = pair();
  configure(t2, 'r1', ['interface Gi0/0/0', 'ip ospf priority 200']);
  ok(t2.getDevice('r1').config.ospf.interfaces[0].priority === 200,
    'and restoring it sets the same value', JSON.stringify(t2.getDevice('r1').config.ospf.interfaces));
}

console.log('');
console.log('Equal priorities fall through to the router ID, as before:');
{
  const t = pair();
  configure(t, 'r1', ['interface Gi0/0/0', 'ip ospf priority 50']);
  configure(t, 'r2', ['interface Gi0/0/0', 'ip ospf priority 50']);
  const sim = recompute(t);
  ok(stateOf(show(t, sim, 'r1', 'show ip ospf neighbor'), '2.2.2.2') === 'FULL/DR',
    'a 50/50 tie leaves the higher router ID the DR');
  ok(stateOf(show(t, sim, 'r2', 'show ip ospf neighbor'), '1.1.1.1') === 'FULL/BDR',
    'and the lower one the BDR');
}

console.log('');
console.log('Priority 0 is eligible for neither role, and the other end takes the DR alone:');
{
  const t = pair();
  configure(t, 'r1', ['interface Gi0/0/0', 'ip ospf priority 0']);
  const sim = recompute(t);
  const r1 = show(t, sim, 'r1', 'show ip ospf neighbor');
  const r2 = show(t, sim, 'r2', 'show ip ospf neighbor');
  ok(stateOf(r2, '1.1.1.1') === 'FULL/DROTHER', 'the eligible end sees a DROTHER', r2);
  ok(stateOf(r1, '2.2.2.2') === 'FULL/DR', 'the ineligible end still becomes FULL with the DR', r1);
  ok(!/BDR/.test(r2), 'and no BDR is elected, because there is no second candidate', r2);
  ok((t.getDevice('r1').ospfNeighbors || []).length === 1,
    'the adjacency forms - a DROTHER synchronises with the DR', JSON.stringify(t.getDevice('r1').ospfNeighbors));
}

console.log('');
console.log('Both ends at 0: no DR exists, so no FULL adjacency and no route:');
{
  const t = pair();
  configure(t, 'r1', ['interface Gi0/0/0', 'ip ospf priority 0']);
  configure(t, 'r2', ['interface Gi0/0/0', 'ip ospf priority 0']);
  const sim = recompute(t);
  ok((t.getDevice('r1').ospfNeighbors || []).length === 0, 'r1 has no neighbour');
  ok((t.getDevice('r2').ospfNeighbors || []).length === 0, 'and neither does r2');
  ok((t.getDevice('r1').ospfRoutes || []).length === 0, 'no O route is installed across the link');
  const r1 = show(t, sim, 'r1', 'show ip ospf neighbor Gi0/0/0');
  ok(/priority 0/.test(r1) && /2WAY/.test(r1),
    'and the console names the reason instead of printing a FULL that cannot exist', r1);
  ok(/RFC 2328 9\.4/.test(r1), 'with the paragraph the rule comes from', r1);
}

console.log('');
console.log('The range is 0-255 and nothing else, and `no` restores the default:');
{
  const t = pair();
  const s = sess(t, 'r1');
  ['enable', 'configure terminal', 'interface Gi0/0/0'].forEach(function (c) { s.run(c); });
  const say = function (c) { return ((s.run(c) || {}).output || []).join(' '); };
  ok(/% Priority must be 0\.\.255/.test(say('ip ospf priority 256')), '256 is refused');
  ok(/% Priority must be 0\.\.255/.test(say('ip ospf priority -1')), '-1 is refused');
  ok(/% Priority must be 0\.\.255/.test(say('ip ospf priority abc')), 'a word is refused');
  ok(/% Priority must be 0\.\.255/.test(say('ip ospf priority')), 'the bare command is refused');
  ok(/% Priority must be 0\.\.255/.test(say('ip ospf priority 5 6')), 'a trailing word is refused, not ignored');
  ok(t.getDevice('r1').config.ospf.interfaces[0].priority !== 5,
    'and a refused line leaves the setting alone',
    JSON.stringify(t.getDevice('r1').config.ospf.interfaces));
  ok(/priority 255/.test(say('ip ospf priority 255')), '255 is accepted');
  ok(/not eligible/.test(say('ip ospf priority 0')), '0 is accepted, and says what it means');
  ok(/reset to 1/.test(say('no ip ospf priority')), 'and `no` restores the default');

  const sim = recompute(t);
  ok(stateOf(show(t, sim, 'r1', 'show ip ospf neighbor'), '2.2.2.2') === 'FULL/DR',
    'after the reset the router-ID tie-break decides again');
}

console.log('');
console.log('On a point-to-point serial port the command is stored and no election runs:');
{
  const t = new Topology();
  t.addDevice(SERIAL, 'a1');
  t.addDevice(SERIAL, 'a2');
  configure(t, 'a1', ['interface Se0/0/0', 'ip address 10.9.0.1 255.255.255.0', 'clock rate 64000']);
  configure(t, 'a2', ['interface Se0/0/0', 'ip address 10.9.0.2 255.255.255.0']);
  t.connect('a1', 'Se0/0/0', 'a2', 'Se0/0/0', { mediaId: 'serial-v35' });
  configure(t, 'a1', ['ospf router-id 1.1.1.1', 'interface Se0/0/0', 'ip ospf priority 200']);
  configure(t, 'a2', ['ospf router-id 2.2.2.2']);
  const sim = recompute(t);
  const a2 = show(t, sim, 'a2', 'show ip ospf neighbor');
  ok(/FULL\/ -/.test(rowOf(a2, '1.1.1.1')),
    'the role cell is still a dash - point-to-point has no election', rowOf(a2, '1.1.1.1'));
  ok(/\s200\s+FULL/.test(rowOf(a2, '1.1.1.1')),
    'but the Pri column carries what the far end configured', rowOf(a2, '1.1.1.1'));
  ok(/^\s+ip ospf priority 200$/m.test(show(t, sim, 'a1', 'show running-config')),
    'and the line survives a save on a point-to-point port too');
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
