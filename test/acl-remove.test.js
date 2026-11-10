'use strict';
// acl-remove.test.js — `no access-list` removes what was asked for, and nothing else.
//
// `no access-list 101 permit tcp any host 10.0.1.5 eq 80` used to delete the whole list and
// answer "Access list 101 removed". The operator asked to drop one line; every other line went
// with it, and the confirmation named the list rather than the entry, so the loss looked like
// success. IOS removes the entry, and so does this now.
//
// The match is on what an entry *means*, not how it was typed: `eq 80` and `eq www` are port 80,
// and `host 10.0.1.5` and `10.0.1.5 0.0.0.0` are the same address - an operator removing an
// entry they just read in `show access-lists` should not have to reproduce the spelling.
const path = require('path');
const { Topology, Simulator, runCommands } = require('../engine');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg); }
}
function eq(actual, expected, msg) {
  ok(actual === expected, msg + (actual === expected ? '' : ' (got ' + JSON.stringify(actual) +
    ', want ' + JSON.stringify(expected) + ')'));
}
function match(re, text, msg) {
  ok(re.test(text), msg + (re.test(text) ? '' : ' (no match in ' + JSON.stringify(text) + ')'));
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
const model = (n) => catalog.find((x) => x.model === n);

// PC1 -- R1 -- WEB, so an ACL can be shown to change what actually forwards.
const t = new Topology();
const pc = t.addDevice(model('generic-pc'));
const r1 = t.addDevice(model('generic-router'));
const web = t.addDevice(model('generic-server'));
pc.name = 'PC1'; r1.name = 'R1'; web.name = 'WEB';
t.connect(pc.id, 'eth0', r1.id, 'Gi0/0');
t.connect(r1.id, 'Gi0/1', web.id, 'eth0');
const sim = new Simulator(t);
function run(dev, cmds) {
  // Strip prompts of every shape: `R1>`, `R1#`, `R1(config)#`, `R1(config-if)#`. Missing the
  // parenthesised forms leaves prompt lines in the compared text, which reads as a failure.
  return runCommands(dev, t, sim, cmds).lines.filter(function (l) {
    return !/^[A-Za-z0-9_.()-]+[>#]/.test(l);
  });
}
function cli(dev, cmds) { return run(dev, ['enable'].concat(cmds)).join('\n'); }

run(pc, ['configure terminal', 'interface eth0', 'ip address 10.0.1.10 255.255.255.0',
  'exit', 'ip default-gateway 10.0.1.1']);
run(r1, ['configure terminal', 'interface Gi0/0', 'ip address 10.0.1.1 255.255.255.0',
  'exit', 'interface Gi0/1', 'ip address 10.0.2.1 255.255.255.0']);
run(web, ['configure terminal', 'interface eth0', 'ip address 10.0.2.20 255.255.255.0',
  'exit', 'ip default-gateway 10.0.2.1']);

console.log('One entry goes, the others stay:');
{
  run(r1, ['configure terminal',
    'access-list 101 permit tcp any host 10.0.1.5 eq 80',
    'access-list 101 deny ip any any',
    'access-list 101 permit tcp any host 10.0.1.6 eq 443',
    'exit']);
  const before = cli(r1, ['show access-lists']);
  match(/10 permit tcp any host 10\.0\.1\.5 eq 80/, before, 'three entries are there to begin with');

  const out = cli(r1, ['configure terminal', 'no access-list 101 permit tcp any host 10.0.1.5 eq 80', 'exit']);
  match(/^Access list 101: removed "permit tcp any host 10\.0\.1\.5 eq 80" \(2 left\)$/m, out,
    'the confirmation quotes the entry and counts what is left');

  const after = cli(r1, ['show access-lists']);
  ok(!/10\.0\.1\.5/.test(after), 'the removed entry is gone');
  ok(/deny ip any any/.test(after) && /10\.0\.1\.6/.test(after), 'the other two are untouched');
  // Sequence numbers are the IOS default 10, 20, 30 and they persist: removing the middle line
  // leaves 10 and 30, which is what makes a sequence number a stable name for a line.
  eq((after.match(/^ +\d+ /gm) || []).length, 2, 'and two entries are left');
  eq((after.match(/^ +20 deny ip any any$/m) || []).length, 1, 'the deny keeps its own number, 20');
}

console.log('\nAn entry is matched by meaning, not by spelling:');
{
  run(r1, ['configure terminal', 'access-list 102 permit tcp any host 10.0.1.7 eq www', 'exit']);
  const out = cli(r1, ['configure terminal', 'no access-list 102 permit tcp any 10.0.1.7 0.0.0.0 eq 80', 'exit']);
  match(/removed "permit tcp any host 10\.0\.1\.7 eq www"/, out,
    '"10.0.1.7 0.0.0.0 eq 80" removes the entry stored as "host 10.0.1.7 eq www"');
  const after = cli(r1, ['show access-lists']);
  ok(!/10\.0\.1\.7/.test(after), 'the list is gone with its only entry');
}

console.log('\nAn entry that is not there is refused, and nothing changes:');
{
  run(r1, ['configure terminal', 'access-list 103 permit tcp any host 10.0.1.8 eq 80',
    'access-list 103 deny ip any any', 'exit']);
  const before = cli(r1, ['show access-lists']);
  const out = cli(r1, ['configure terminal', 'no access-list 103 permit tcp any host 10.9.9.9 eq 80', 'exit']);
  match(/^% Access list 103 has no entry "permit tcp any host 10\.9\.9\.9 eq 80"$/m, out,
    'the refusal quotes what was asked for');
  match(/^% Entries: 1\) permit tcp any host 10\.0\.1\.8 eq 80  2\) deny ip any any$/m, out,
    'and prints what the list does hold, so the difference is visible');
  eq(cli(r1, ['show access-lists']), before, 'the list is byte-identical afterwards');

  eq(cli(r1, ['configure terminal', 'no access-list 104 permit ip any any', 'exit']),
    '% Access list 104 does not exist', 'a number with no list is refused too');
  eq(cli(r1, ['configure terminal', 'no access-list 5000 permit ip any any', 'exit']),
    '% Invalid access list number: 5000', 'and so is a number that is not an ACL number');
}

console.log('\nWith no entry given, the whole list still goes:');
{
  run(r1, ['configure terminal', 'access-list 110 permit ip any any', 'access-list 110 deny ip any any', 'exit']);
  const out = cli(r1, ['configure terminal', 'no access-list 110', 'exit']);
  eq(out, 'Access list 110 removed (2 entries)', 'the count is reported, so "all of it" is explicit');
  ok(!/110/.test(cli(r1, ['show access-lists'])), 'and the list is gone');
}

console.log('\nRemoving the last entry removes the list, and says so:');
{
  run(r1, ['configure terminal', 'access-list 111 permit ip any any', 'exit']);
  const out = cli(r1, ['configure terminal', 'no access-list 111 permit ip any any', 'exit']);
  match(/the list is now empty and was deleted/, out, 'the message explains the side effect');
  ok(!/111/.test(cli(r1, ['show access-lists'])), 'and no empty list is left behind to confuse a reader');
}

console.log('\nA binding survives losing an entry, and goes with the list:');
{
  run(r1, ['configure terminal', 'access-list 120 deny ip any any',
    'access-list 120 permit ip any any',
    'interface Gi0/0', 'ip access-group 120 in', 'exit', 'exit']);
  ok(/applied IN on Gi0\/0/.test(cli(r1, ['show access-lists'])), 'the list is bound to Gi0/0');

  const partial = cli(r1, ['configure terminal', 'no access-list 120 deny ip any any', 'exit']);
  match(/\(1 left\)/, partial, 'one entry is removed');
  ok(/applied IN on Gi0\/0/.test(cli(r1, ['show access-lists'])),
    'and the interface is still filtering with the remaining entry');

  cli(r1, ['configure terminal', 'no access-list 120', 'exit']);
  const after = cli(r1, ['show access-lists']);
  ok(!/access list 120/.test(after), 'deleting the list removes it');
  ok(!/applied IN on Gi0\/0/.test(after), 'and takes the binding with it, so the port stops filtering');
}

console.log('\nThe entry really was deciding traffic:');
{
  run(r1, ['configure terminal', 'access-list 130 deny ip any any',
    'interface Gi0/0', 'ip access-group 130 in', 'exit', 'exit']);
  const blocked = cli(pc, ['ping 10.0.2.20 count 1']);
  match(/Success rate is 0 percent \(0\/1\)/, blocked, 'a deny entry stops the ping');

  const removed = cli(r1, ['configure terminal', 'no access-list 130 deny ip any any', 'exit']);
  match(/the list is now empty and was deleted/, removed, 'removing that entry deletes the list');
  const allowed = cli(pc, ['ping 10.0.2.20 count 1']);
  match(/Success rate is 100 percent \(1\/1\)/, allowed,
    'and the same ping now succeeds - the removal changed the data path, not just a table');
}

console.log('\nRunning-config loses the entry too - one model, two doors:');
{
  run(r1, ['configure terminal', 'access-list 140 permit tcp any host 10.0.1.9 eq 22',
    'access-list 140 deny ip any any', 'exit']);
  const before = cli(r1, ['show running-config']);
  ok(/access-list 140 permit tcp any host 10\.0\.1\.9 eq 22/.test(before),
    'the dump shows the entry before removal');
  cli(r1, ['configure terminal', 'no access-list 140 permit tcp any host 10.0.1.9 eq 22', 'exit']);
  const after = cli(r1, ['show running-config']);
  ok(!/10\.0\.1\.9/.test(after), 'and not after - the console and the dump read one model');
  ok(/access-list 140 deny ip any any/.test(after), 'while the surviving entry is still in the dump');
}

console.log('\nThe command is discoverable:');
{
  const help = run(r1, ['enable', 'configure terminal', 'help']).join('\n');
  match(/no access-list <1-2699> \[<entry>\]\s+remove one entry, or the whole list/, help,
    'config help names both forms and what they do');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
