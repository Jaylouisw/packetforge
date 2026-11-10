'use strict';
// clear-tables.test.js - the two tables a lab learns for itself could be read and never emptied.
//
// Measured before this pass, on R1 --- SW1 --- PC1 after one ping:
//   R1#clear arp                     ->  % Unrecognized command: clear arp
//   R1#clear ip arp                  ->  % Unrecognized command: clear ip arp
//   SW1#clear mac address-table      ->  % Unrecognized command: clear mac address-table
//   R1#clear ip route *              ->  % Unrecognized command: clear ip route *
//
// `clear counters`, `clear interface counters` and `clear logging` all existed, so the family was
// half-built: the two tables that fill up as traffic crosses the lab - the ones an operator empties
// to watch learning happen a second time - were the two that could not be emptied. The only way to
// see a fresh ARP request was to rebuild the topology.
//
// `clear ip route *` and `clear ip bgp *` are a different case: this model derives those tables, so
// there is nothing to flush. "Unrecognized command" was still the wrong answer for them - an
// operator who knows IOS reads it as "this tool is missing a command" and goes looking.
const path = require('path');
const { Topology, Simulator, CliSession } = require('../engine');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg); }
}
function eq(actual, expected, msg) {
  ok(actual === expected, msg + (actual === expected ? '' : ' (got ' + JSON.stringify(actual) + ')'));
}
function rows(out) {
  // The tables print a header and then rows; a filter keeps the data rows.
  return out.filter(function (l) { return /^Internet|^\d+\s/.test(l) || /^\s+\d/.test(l); });
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
const ROUTER = catalog.find(function (s) { return s.model === 'generic-router'; });
const SWITCH = catalog.find(function (s) { return s.model === 'generic-switch'; });
const PC = catalog.find(function (s) { return s.model === 'generic-pc'; });

// R1 -- SW1 -- PC1, with the router as the host's gateway: one ping fills both tables.
function lab() {
  const t = new Topology();
  const r1 = t.addDevice(ROUTER); r1.name = 'R1';
  const sw = t.addDevice(SWITCH); sw.name = 'SW1';
  const pc = t.addDevice(PC); pc.name = 'PC1';
  t.connect(r1.id, 'Gi0/0', sw.id, 'Fa0/1');
  t.connect(sw.id, 'Fa0/2', pc.id, 'eth0');
  const sim = new Simulator(t);
  const cfg = function (d, cmds) {
    const s = new CliSession(d, t, sim);
    s.run('enable'); s.run('configure terminal');
    for (const cmd of cmds) s.run(cmd);
    s.run('end');
    return s;
  };
  cfg(r1, ['interface Gi0/0', 'ip address 10.0.0.1 255.255.255.0', 'exit']);
  cfg(pc, ['interface eth0', 'ip address 10.0.0.10 255.255.255.0', 'exit',
    'ip default-gateway 10.0.0.1']);
  const r = cfg(r1, []);
  const s = cfg(sw, []);
  r.run('ping 10.0.0.10 count 2');
  return { t: t, r1: r1, sw: sw, pc: pc, sim: sim, r: r, s: s };
}

console.log('\nThe ARP cache can be emptied, and it refills by itself:');
{
  const env = lab();
  const before = env.r.run('show arp').output;
  ok(before.some(function (l) { return /10\.0\.0\.10/.test(l); }), 'the ping left an ARP entry');
  eq(env.r.run('clear arp').output[0], 'ARP cache cleared on R1 (1 entry)', 'and clear arp removes it, saying how many');
  ok(!env.r.run('show arp').output.some(function (l) { return /10\.0\.0\.10/.test(l); }),
    'the table is empty afterwards');
  // The point of clearing: watch the next ARP request. It is rebuilt by the next packet, so the
  // command is a reset of *learning*, not a broken cache.
  eq(/Success rate is (\d+) percent/.exec(env.r.run('ping 10.0.0.10 count 1').output.join(' '))[1], '100',
    'a ping after the clear still succeeds');
  ok(env.r.run('show arp').output.some(function (l) { return /10\.0\.0\.10/.test(l); }),
    'and the entry is back, re-learned rather than restored');
  // Only now is the cache empty, so only now does the refusal wording apply: the previous clear
  // was followed by a ping, and the ping re-learned the entry.
  env.r.run('clear arp');
  eq(env.r.run('clear arp').output[0], 'ARP cache on R1 was already empty - nothing to clear',
    'clearing an empty cache says so instead of claiming a clear');
}

console.log('\n`clear ip arp` is the same command, and a port narrows it:');
{
  const env = lab();
  eq(env.r.run('clear ip arp').output[0], 'ARP cache cleared on R1 (1 entry)',
    'the long spelling clears the same cache');
  eq(env.r.run('clear ip arp zzz').output[0], '% No interface named zzz on R1',
    'a port that does not exist is refused, not ignored');
  // The cache holds no port, so a port comes from the topology exactly as `show arp` derives it -
  // and that derivation says `-` for a host behind a switch. So a port-scoped clear removes the
  // entries it can attribute, and says plainly that there were none rather than wrenching the
  // whole cache.
  const behind = lab();
  eq(behind.r.run('clear arp Gi0/0').output[0], 'ARP cache on R1 for Gi0/0 was already empty - nothing to clear',
    'a host behind a switch belongs to no port, so it is not attributed to one');
  ok(behind.r.run('show arp').output.some(function (l) { return /10\.0\.0\.10/.test(l); }),
    'and the entry survives a port-scoped clear it cannot be attributed to');

  // A directly cabled peer is attributable, so a port clear takes it and leaves the rest.
  const t = new Topology();
  const r1 = t.addDevice(ROUTER); r1.name = 'R1';
  const direct = t.addDevice(PC); direct.name = 'PC2';
  t.connect(direct.id, 'eth0', r1.id, 'Gi0/1');
  const sim2 = new Simulator(t);
  const cfg = function (d, cmds) {
    const s = new CliSession(d, t, sim2);
    s.run('enable'); s.run('configure terminal');
    for (const cmd of cmds) s.run(cmd);
    s.run('end');
    return s;
  };
  const rs = cfg(r1, ['interface Gi0/1', 'ip address 10.9.9.1 255.255.255.0', 'exit']);
  cfg(direct, ['interface eth0', 'ip address 10.9.9.2 255.255.255.0', 'exit',
    'ip default-gateway 10.9.9.1']);
  rs.run('ping 10.9.9.2 count 1');
  ok(/10\.9\.9\.2\s+-\s+\S+\s+Gi0\/1/.test(rs.run('show arp').output.join('\n')),
    'a directly cabled peer is attributed to its port');
  eq(rs.run('clear arp Gi0/1').output[0], 'ARP cache cleared on R1 for Gi0/1 (1 entry)',
    'so a port-scoped clear empties exactly that port');
}

console.log('\nThe MAC table can be emptied, and only a bridge has one:');
{
  const env = lab();
  const before = env.s.run('show mac address-table').output;
  ok(before.some(function (l) { return /Fa0\/2/.test(l); }), 'the ping taught SW1 where PC1 is');
  ok(/^MAC address table cleared on SW1 \(\d+ entr(?:y|ies)\)$/.test(env.s.run('clear mac address-table').output[0]),
    'clear mac address-table empties it and says how many entries went');
  ok(!env.s.run('show mac address-table').output.some(function (l) { return /Fa0\/2/.test(l); }),
    'the table is empty afterwards');
  eq(/Success rate is (\d+) percent/.exec(env.r.run('ping 10.0.0.10 count 1').output.join(' '))[1], '100',
    'the next ping still works');
  ok(env.s.run('show mac address-table').output.some(function (l) { return /Fa0\/2/.test(l); }),
    'and the switch learns the address again');
  // A router has no bridge, so it has no table: answering "cleared (0 entries)" would read like an
  // empty switch.
  eq(env.r.run('clear mac address-table').output[0],
    '% R1 does not bridge, so it has no MAC address table', 'a router refuses by naming the reason');
  eq(env.r.run('clear mac address-table').output[1],
    '% Try "show arp" for the addresses it has learned', 'and points at the table it does have');
}

console.log('\nPrivileged, and it names its target:');
{
  const t = new Topology();
  const r1 = t.addDevice(ROUTER); r1.name = 'R1';
  const sim = new Simulator(t);
  const user = new CliSession(r1, t, sim);          // no `enable`
  ok(/needs enable mode/.test(user.run('clear arp').output[0]),
    'a user-exec session is told the command is privileged, not that it does not exist');
  ok(/needs enable mode/.test(user.run('clear mac address-table').output[0]),
    'the same for the MAC table');
}

console.log('\nA table this model derives is not offered a flush it would ignore:');
{
  const env = lab();
  for (const cmd of ['clear ip route *', 'clear ip bgp *']) {
    const out = env.r.run(cmd).output;
    ok(!out.some(function (l) { return /Unrecognized/.test(l); }),
      cmd + ' is not "Unrecognized command"');
    ok(/to clear: this model derives/.test(out[0]), 'it says why there is nothing to flush');
    ok(/show ip (route|bgp) at <ms>\|converged/.test(out[1]), 'and points at the question it can answer');
  }
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
