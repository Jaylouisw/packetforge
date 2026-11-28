'use strict';
// An OSPF election does not preempt.
//
// "OSPF DR and BDR elections are not preemptive. If a new router with a higher priority or higher
// router ID is added to the network after the DR and BDR election, the newly added router does not
// take over the DR or the BDR role. This is because those roles have already been assigned" (Cisco
// Networking Academy, CCNA 3, 5.1.2.7 "DR/BDR Election Process"). The same page carries the two
// consequences: the BDR takes a failed DR's place "even if another DROTHER with a higher priority or
// router ID is added", and only then is the empty BDR seat voted on.
//
// computeOspf() is a converged-graph pass, so before this it held a fresh election on every run: a
// router given priority 255 in place was DR by the time the next "show ip ospf neighbor" asked, which
// is the one thing a real segment will not do. The roles now come from the previous election while
// the incumbents are still standing and still eligible - held on the topology, like a DHCP lease,
// because the answer one request reaches is the input to the next.
// research/ospf-dr-election-is-not-preemptive.md carries the captures.
const { loadCatalog } = require('../devices/registry');
const { Topology } = require('../engine/topology');
const { Simulator } = require('../engine/simulator');
const cliModule = require('../engine/cli');
const CliSession = cliModule.CliSession || cliModule;

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  OK  ' + msg); }
  else { failed++; console.error('  FAIL ' + msg + (detail ? '  [' + detail + ']' : '')); }
}
const ROOT = require('path').join(__dirname, '..');
const specs = loadCatalog(ROOT + '/devices').filter(function (s) { return !s.error; });
const ROUTER = specs.find(function (s) { return /^ISR 4331$/.test(s.model); });
const SWITCH = specs.find(function (s) { return /2960/i.test(s.model); });

function sess(t, id, sim) { return new CliSession(t.getDevice(id), t, sim || null); }
function cmd(t, id, words) {
  const s = sess(t, id);
  s.run('enable');
  s.run('configure terminal');
  words.forEach(function (c) { s.run(c); });
}
function show(t, sim, id, word) {
  return ((sess(t, id, sim).run(word) || {}).output || []).join('\n');
}
function stateOf(text, peer) {
  const lines = text.split('\n');
  const row = lines.filter(function (l) { return l.trim().indexOf(peer + ' ') === 0; })[0] || '';
  const m = /\s(FULL|2WAY)\s*\/\s*(\S+)/.exec(row);
  return m ? m[1] + '/' + m[2] : '';
}

// n routers in one VLAN on one access switch, every priority left at the default 1 and router IDs
// 1..n, so a first election's ranking is unambiguous.
function lab(n) {
  const t = new Topology();
  const ids = [];
  for (let i = 1; i <= n; i++) ids.push('r' + i);
  ids.forEach(function (id) { t.addDevice(ROUTER, id); });
  t.addDevice(SWITCH, 'sw1');
  ids.forEach(function (id, i) {
    const dev = t.getDevice(id);
    const port = dev.interfaces.get('Gi0/0/0');
    port.enabled = true;
    port.ip = '10.0.0.' + (i + 1);
    port.mask = '255.255.255.0';
    const back = dev.interfaces.get('Gi0/0/1');
    back.enabled = true;
    back.ip = '10.' + (i + 1) + '.0.1';
    back.mask = '255.255.255.0';
    cmd(t, id, ['hostname ' + id,
      'ospf router-id ' + (i + 1) + '.' + (i + 1) + '.' + (i + 1) + '.' + (i + 1),
      'ospf area 0']);
  });
  ids.forEach(function (id, i) { t.connect(id, 'Gi0/0/0', 'sw1', 'Fa0/' + (i + 1)); });
  return { t: t, ids: ids };
}
function run(t) { const sim = new Simulator(t); sim.computeOspf(); return sim; }
function priority(t, id, p) { cmd(t, id, ['interface Gi0/0/0', 'ip ospf priority ' + p]); }

console.log('');
console.log('A first election is a vote: highest priority, then highest router ID:');
{
  const env = lab(4);
  const sim = run(env.t);
  const r1 = show(env.t, sim, 'r1', 'show ip ospf neighbor');
  ok(stateOf(r1, '4.4.4.4') === 'FULL/DR', 'r4 (highest ID) is the DR', r1);
  ok(stateOf(r1, '3.3.3.3') === 'FULL/BDR', 'r3 is the BDR', r1);
  ok(stateOf(r1, '2.2.2.2') === '2WAY/DROTHER', 'and r1 and r2 are DROTHERs', r1);
  priority(env.t, 'r1', 255);
  ok(!!run(env.t), 'the segment still converges after the priority change');
}

console.log('');
console.log('A router given priority 255 does not take the DR seat - the roles are assigned:');
{
  const env = lab(4);
  run(env.t);
  priority(env.t, 'r1', 255);                 // higher than anybody else on the segment
  const sim = run(env.t);                     // what the next request sees
  const r1 = show(env.t, sim, 'r1', 'show ip ospf neighbor');
  const r3 = show(env.t, sim, 'r3', 'show ip ospf neighbor');
  ok(stateOf(r1, '4.4.4.4') === 'FULL/DR', 'r4 is still the DR, seen from r1', r1);
  ok(stateOf(r1, '3.3.3.3') === 'FULL/BDR', 'r3 is still the BDR', r1);
  ok(stateOf(r1, '2.2.2.2') === '2WAY/DROTHER',
    'and r1 is still a DROTHER - 2WAY with the other DROTHER, not FULL with it', r1);
  ok(stateOf(r3, '1.1.1.1') === 'FULL/DROTHER', 'the BDR sees r1 as a DROTHER too', r3);
  ok(/3 neighbour\(s\), 2 fully adjacent \(1 in 2WAY\/DROTHER\)/.test(r1),
    'the count still calls one row 2WAY', r1);
}

console.log('');
console.log('A clear re-elects, and then the 255 does win:');
{
  const env = lab(4);
  run(env.t);
  priority(env.t, 'r1', 255);
  run(env.t);
  env.t.ospfRoles.clear();                    // the model's clear of the seats
  const sim = run(env.t);
  const r2 = show(env.t, sim, 'r2', 'show ip ospf neighbor');
  ok(stateOf(r2, '1.1.1.1') === 'FULL/DR', 'r1 is the DR after a fresh election', r2);
  ok(stateOf(r2, '4.4.4.4') === 'FULL/BDR', 'and r4, the old DR, is now the BDR', r2);
  const r1 = show(env.t, sim, 'r1', 'show ip ospf neighbor');
  ok(!/FULL\/DR\b/.test(r1), 'the DR names no DR in its own table', r1);
  const routes = show(env.t, sim, 'r2', 'show ip route');
  ok(/^O\s+10\.1\.0\.0\/24/m.test(routes), 'r2 still learns r1s network', routes);
  ok(/^O\s+10\.3\.0\.0\/24/m.test(routes), 'and r3s, through the new DR', routes);
}

console.log('');
console.log('When the DR fails, the BDR is promoted ahead of the ranking:');
{
  const env = lab(4);
  run(env.t);
  priority(env.t, 'r1', 255);
  run(env.t);
  env.t.ospfRoles.clear();
  run(env.t);                                     // DR r1 (255), BDR r4, r3 and r2 DROTHERs
  cmd(env.t, 'r1', ['interface Gi0/0/0', 'shutdown']);   // the DRs port goes down
  const sim = run(env.t);
  const r2 = show(env.t, sim, 'r2', 'show ip ospf neighbor');
  ok(stateOf(r2, '4.4.4.4') === 'FULL/DR', 'the old BDR (r4) is the new DR', r2);
  ok(stateOf(r2, '3.3.3.3') === 'FULL/BDR', 'and the BDR seat is voted on - r3 takes it', r2);
  ok(r2.indexOf('1.1.1.1') === -1, 'the failed DR is gone from the table', r2);
}

console.log('');
console.log('An old DR that comes back does not take the seat back:');
{
  const env = lab(4);
  run(env.t);
  priority(env.t, 'r1', 255);
  run(env.t);
  env.t.ospfRoles.clear();
  run(env.t);                                     // DR r1, BDR r4
  cmd(env.t, 'r1', ['interface Gi0/0/0', 'shutdown']);
  run(env.t);                                     // DR r4, BDR r3
  cmd(env.t, 'r1', ['interface Gi0/0/0', 'no shutdown']);
  const sim = run(env.t);
  const r1 = show(env.t, sim, 'r1', 'show ip ospf neighbor');
  ok(stateOf(r1, '4.4.4.4') === 'FULL/DR', 'r4 keeps the DR seat', r1);
  ok(stateOf(r1, '3.3.3.3') === 'FULL/BDR', 'r3 keeps the BDR seat', r1);
  ok(stateOf(r1, '2.2.2.2') === '2WAY/DROTHER', 'the returning ex-DR is a DROTHER', r1);
  const back = show(env.t, sim, 'r1', 'show ip route');
  ok(/^O\s+10\.2\.0\.0\/24/m.test(back), 'and it still routes over the segment', back);
}

console.log('');
console.log('Priority 0 withdraws an incumbent, and the seat is filled at once:');
{
  const env = lab(3);
  const sim0 = run(env.t);
  const r1a = show(env.t, sim0, 'r1', 'show ip ospf neighbor');
  ok(stateOf(r1a, '3.3.3.3') === 'FULL/DR', 'r3 is the DR to begin with', r1a);
  priority(env.t, 'r3', 0);                       // "that router withdraws as DR"
  const sim = run(env.t);
  const r1 = show(env.t, sim, 'r1', 'show ip ospf neighbor');
  ok(stateOf(r1, '2.2.2.2') === 'FULL/DR', 'the BDR (r2) is promoted immediately', r1);
  const r3 = show(env.t, sim, 'r3', 'show ip ospf neighbor');
  ok(stateOf(r3, '2.2.2.2') === 'FULL/DR' && stateOf(r3, '1.1.1.1') === 'FULL/BDR',
    'the withdrawn router is a DROTHER - FULL with both seats, as a DROTHER is', r3);
  const r2 = show(env.t, sim, 'r2', 'show ip ospf neighbor');
  ok(stateOf(r2, '1.1.1.1') === 'FULL/BDR',
    'the open BDR seat goes to the ranking (r1), not to the withdrawn router', r2);
  ok(stateOf(r2, '3.3.3.3') === 'FULL/DROTHER', 'which is left a DROTHER', r2);
}

console.log('');
console.log('The roles survive a new simulator on the same board, and a reset drops them:');
{
  const env = lab(3);
  run(env.t);
  priority(env.t, 'r1', 200);
  const next = new Simulator(env.t);               // a later request, as the server builds it
  next.computeOspf();
  const row = show(env.t, next, 'r1', 'show ip ospf neighbor');
  ok(stateOf(row, '3.3.3.3') === 'FULL/DR', 'a second simulator still finds r3 the DR', row);
  env.t.ospfRoles.clear();                         // the /reset endpoint
  const fresh = new Simulator(env.t);
  fresh.computeOspf();
  const r2 = show(env.t, fresh, 'r2', 'show ip ospf neighbor');
  ok(stateOf(r2, '1.1.1.1') === 'FULL/DR', 'and after a reset the 200 wins the empty seat', r2);
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
