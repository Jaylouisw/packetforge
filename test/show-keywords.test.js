'use strict';
// show-keywords.test.js - a keyword is not a port name.
//
// Measured before this pass, on a switch and a router:
//   SW1#show spanning-tree summary     -> % No interface named summary on SW1
//   SW1#show spanning-tree root        -> % No interface named root on SW1
//   SW1#show mac address-table count   -> % No interface named count on SW1
//   SW1#show mac address-table dynamic -> % No interface named dynamic on SW1
//   R1#show ip arp 10.0.0.50           -> % No interface named 10.0.0.50 on R1
//
// Every one of those is a real IOS sub-word and every one was read as a port name, so the console
// sent the operator to look for a port that cannot exist. None of the answers needed new data: the
// spanning-tree election already stores the root, the root path cost and each port's role and state,
// the MAC table already holds every learned entry, and the ARP cache is keyed by address.
const path = require('path');
const { Topology, Simulator } = require('../engine');
const { CliSession } = require('../engine/cli');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg); }
}
function eq(actual, expected, msg) {
  ok(actual === expected, msg + (actual === expected ? '' : ' (got ' + JSON.stringify(actual) + ')'));
}
function match(re, haystack, msg) {
  const text = Array.isArray(haystack) ? haystack.join('\n') : String(haystack);
  ok(re.test(text), msg + (re.test(text) ? '' : ' (no match in ' + JSON.stringify(text.slice(0, 500)) + ')'));
}
function noMatch(re, haystack, msg) {
  const text = Array.isArray(haystack) ? haystack.join('\n') : String(haystack);
  ok(!re.test(text), msg + (re.test(text) ? ' (found ' + re + ')' : ''));
}
const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
const ROUTER = catalog.find(function (s) { return s.model === 'generic-router'; });
const SWITCH = catalog.find(function (s) { return s.model === 'generic-switch'; });
const PC = catalog.find(function (s) { return s.model === 'generic-pc'; });

// A triangle of switches (the only shape that blocks a port - parallel links are aggregated as a
// LAG by design) with a PC and a router hanging off it, so every table has something in it.
function lab() {
  const t = new Topology();
  const s1 = t.addDevice(SWITCH); s1.name = 'SW1';
  const s2 = t.addDevice(SWITCH); s2.name = 'SW2';
  const s3 = t.addDevice(SWITCH); s3.name = 'SW3';
  const pc = t.addDevice(PC); pc.name = 'PC1';
  const r1 = t.addDevice(ROUTER); r1.name = 'R1';
  t.connect(s1.id, 'Fa0/1', s2.id, 'Fa0/1');
  t.connect(s2.id, 'Fa0/2', s3.id, 'Fa0/1');
  t.connect(s3.id, 'Fa0/2', s1.id, 'Fa0/2');
  t.connect(pc.id, 'eth0', s1.id, 'Fa0/3');
  t.connect(s2.id, 'Fa0/3', r1.id, 'Gi0/0');
  const sim = new Simulator(t);
  const mk = function (d) { const s = new CliSession(d, t, sim); s.run('enable'); return s; };
  const a = mk(s1), b = mk(s2), c = mk(s3), sp = mk(pc), r = mk(r1);
  const cfg = function (s, cmds) { s.run('configure terminal'); cmds.forEach(function (x) { s.run(x); }); s.run('end'); };
  cfg(sp, ['hostname PC1', 'interface eth0', 'ip address 10.0.0.50 255.255.255.0',
    'ip default-gateway 10.0.0.1', 'exit']);
  cfg(r, ['hostname R1', 'interface Gi0/0', 'ip address 10.0.0.1 255.255.255.0', 'exit']);
  sp.run('ping 10.0.0.1 count 1');
  return { t: t, sim: sim, s1: s1, s2: s2, s3: s3, pc: pc, r1: r1, a: a, b: b, c: c, sp: sp, r: r, cfg: cfg };
}

console.log('\n`show spanning-tree summary` counts the tree it just described:');
{
  const env = lab();
  const sum = env.a.run('show spanning-tree summary').output;
  match(/Spanning tree enabled protocol ieee - summary for SW1/, sum, 'the summary names the device');
  match(/Root bridge: priority 32768, \S+ \(SW1\) - this bridge/, sum, 'and the root, marked as this bridge');
  match(/Root path cost: 0/, sum, 'with the cost to reach it');
  match(/Ports in the tree: 3 \(root 0, designated 3, alternate 0\)/, sum,
    'and the ports counted by role');
  match(/Port states: 3 forwarding/, sum, 'and by state');
  // The blocked port is the whole point of a tree, so the summary says it is working.
  const sw3 = env.c.run('show spanning-tree summary').output;
  match(/Ports in the tree: 2 \(root 1, designated 0, alternate 1\)/, sw3,
    'the switch with the redundant link counts its alternate port');
  match(/1 port is blocking: the loop is cut, which is the tree working/, sw3,
    'and the blocked port is explained rather than just counted');
  match(/Root path cost: 20000/, sw3, 'its cost to the root is the number the election chose');
  // The counts must agree with the table the other command prints.
  const table = env.c.run('show spanning-tree').output.join('\n');
  const forwarding = (table.match(/forwarding/g) || []).length;
  match(new RegExp('Port states: ' + forwarding + ' forwarding'), sw3,
    'the summary counts exactly the rows `show spanning-tree` prints');
}

console.log('\n`show spanning-tree root` answers who is root and what it costs:');
{
  const env = lab();
  const root = env.a.run('show spanning-tree root').output;
  match(/Root bridge for VLAN 1: priority 32768, \S+ \(SW1\) - this bridge/, root,
    'on the root, it says so');
  match(/This bridge is the root: root path cost 0/, root, 'and that its cost is zero');
  const leaf = env.c.run('show spanning-tree root').output;
  match(/Root bridge for VLAN 1: priority 32768, \S+ \(SW1\)/, leaf, 'a non-root names the root by name');
  noMatch(/this bridge/, leaf, 'and does not claim to be it');
  match(/Root path cost for SW3: 20000/, leaf, 'its root path cost is stated');
  match(/Root port: Fa0\/2/, leaf, 'and which port leads there');
  // The root port named here is the role in the table.
  match(/Fa0\/2\s+root\s+forwarding/, env.c.run('show spanning-tree').output,
    'the port it names is the one the table calls root');
}

console.log('\n`show mac address-table count` totals what the table holds:');
{
  const env = lab();
  const count = env.a.run('show mac address-table count').output;
  match(/Mac address table count on SW1:/, count, 'the count is headed by the device');
  match(/Vlan\s+Entries/, count, 'with a column per VLAN');
  const rows = env.a.run('show mac address-table').output.filter(function (l) {
    return /^\d+\s+\S{2}:/.test(l);
  });
  match(new RegExp('Total: ' + rows.length + ' dynamic'), count,
    'the total is exactly the number of rows in the table');
  match(/0 static, 0 secure/, count, 'and static and secure are reported honestly as zero');
}

console.log('\n`show mac address-table dynamic|static|vlan` are their own commands:');
{
  const env = lab();
  const dyn = env.a.run('show mac address-table dynamic').output;
  const all = env.a.run('show mac address-table').output;
  eq(dyn.length, all.length, 'every entry this model has is dynamic, so the two tables match');
  const stat = env.a.run('show mac address-table static').output;
  match(/% No static MAC entries on SW1/, stat, 'there are no static entries, and it says so');
  match(/all \d+ are dynamic/, stat, 'naming where the dynamic ones are instead');
  match(/Mac address table for VLAN 1 on SW1:/, env.a.run('show mac address-table vlan 1').output,
    'a VLAN can be asked for by number');
  match(/% Incomplete command: show mac address-table vlan <id>/,
    env.a.run('show mac address-table vlan').output, 'and a VLAN with no number is incomplete');
  match(/% VLAN id must be a number 1-4094, not "abc"/,
    env.a.run('show mac address-table vlan abc').output, 'and a bad number is refused by name');
  match(/% Unexpected argument "extra" - show mac address-table dynamic takes no more/,
    env.a.run('show mac address-table dynamic extra').output, 'a word after the keyword is refused');
}

console.log('\n`show ip arp <address>` answers for one address:');
{
  const env = lab();
  const one = env.r.run('show ip arp 10.0.0.50').output;
  match(/Protocol\s+Address\s+Age \(min\)\s+Hardware Addr\s+Interface/, one,
    'the header is the header of the whole table');
  match(/Internet\s+10\.0\.0\.50\s+-\s+([0-9a-f]{2}:){5}[0-9a-f]{2}/, one,
    'and the row is that address with its MAC');
  // The MAC must be the one the table lists for the same address.
  const mac = /Internet\s+10\.0\.0\.50\s+-\s+((?:[0-9a-f]{2}:){5}[0-9a-f]{2})/.exec(one.join('\n'));
  match(new RegExp((mac ? mac[1] : 'x') + '\\s'), env.r.run('show arp').output,
    'the same MAC the whole table prints for it');
  const missing = env.r.run('show ip arp 10.0.0.99').output;
  match(/% No ARP entry for 10\.0\.0\.99 on R1/, missing, 'an address with no entry is refused');
  match(/a ping to 10\.0\.0\.99 would learn it/, missing, 'and the way to learn it is named');
  match(/% show arp takes one port or one address, not "10\.0\.0\.50 10\.0\.0\.51"/,
    env.r.run('show ip arp 10.0.0.50 10.0.0.51').output, 'two addresses are refused');
  // A port argument still works, and an unknown word names both shapes.
  match(/ARP entries on Gi0\/0/, env.r.run('show arp Gi0/0').output, 'a port still filters by port');
  match(/% show arp takes a port, or an address - not "bogus"/, env.r.run('show arp bogus').output,
    'an unknown word is refused with both shapes');
}

console.log('\nA keyword is refused as a keyword, not as a missing port:');
{
  const env = lab();
  match(/% show spanning-tree takes a port, or summary \/ root - not "bogus"/,
    env.a.run('show spanning-tree bogus').output, 'spanning-tree lists its keywords');
  match(/% show mac address-table takes a port, or count \/ dynamic \/ static \/ vlan - not "bogus"/,
    env.a.run('show mac address-table bogus').output, 'so does the MAC table');
  noMatch(/No interface named/, env.a.run('show spanning-tree bogus').output,
    'and neither calls the word a port that does not exist');
  // A router runs no tree, and says why rather than inventing an empty one.
  match(/% R1 does not bridge, so it runs no spanning tree/, env.r.run('show spanning-tree summary').output,
    'a router is refused, with why');
  match(/% Unexpected argument "extra" - show spanning-tree root takes no more/,
    env.a.run('show spanning-tree root extra').output, 'a word after `root` is refused');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
