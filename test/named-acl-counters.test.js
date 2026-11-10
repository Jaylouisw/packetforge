'use strict';
// named-acl-counters.test.js - an access list you could build by number only, and never count.
//
// Measured before this pass:
//   R1(config)#ip access-list extended BLOCK
//   % Unrecognized config command: ip access-list extended BLOCK
//   R1(config-if)#ip access-group BLOCK in
//   % Invalid access list number: BLOCK
//   R1#show access-lists
//   Extended IP access list BLOCK2
//      1 deny icmp any host 10.1.0.1
//      2 permit ip any any
//
// So a filter could only be built by number, could not be *named*, a named one could not be
// applied at all - and no rule ever carried a hit count. An ACL that blocks the wrong traffic is
// the one command an operator runs in anger, and "which line ate my packet" had no answer.
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

// PC1 -- SW1 -- R1 -- R2 -- (10.1.0.0/24, where the far host lives)
function lab() {
  const t = new Topology();
  const r1 = t.addDevice(ROUTER); r1.name = 'R1';
  const r2 = t.addDevice(ROUTER); r2.name = 'R2';
  const sw = t.addDevice(SWITCH); sw.name = 'SW1';
  const pc = t.addDevice(PC); pc.name = 'PC1';
  t.connect(pc.id, 'eth0', sw.id, 'Fa0/1');
  t.connect(sw.id, 'Fa0/2', r1.id, 'Gi0/0');
  t.connect(r1.id, 'Gi0/1', r2.id, 'Gi0/0');
  const sim = new Simulator(t);
  const cliFor = function (d) {
    const s = new CliSession(d, t, sim);
    s.run('enable');
    return s;
  };
  const s1 = cliFor(r1), s2 = cliFor(r2), sp = cliFor(pc);
  const cfg = function (s, cmds) {
    s.run('configure terminal');
    for (const c of cmds) s.run(c);
    s.run('end');
  };
  cfg(s1, ['hostname R1', 'interface Gi0/0', 'ip address 10.0.0.1 255.255.255.0', 'exit',
    'interface Gi0/1', 'ip address 10.9.0.1 255.255.255.0', 'exit',
    'ip route 10.1.0.0 255.255.255.0 10.9.0.2']);
  cfg(s2, ['hostname R2', 'interface Gi0/0', 'ip address 10.9.0.2 255.255.255.0', 'exit',
    'interface Gi0/1', 'ip address 10.1.0.1 255.255.255.0', 'exit']);
  cfg(sp, ['hostname PC1', 'interface eth0', 'ip address 10.0.0.50 255.255.255.0',
    'ip default-gateway 10.0.0.1', 'exit']);
  return { t: t, sim: sim, r1: r1, r2: r2, pc: pc, s1: s1, s2: s2, sp: sp, cfg: cfg };
}
function rate(out) {
  const m = /Success rate is (\d+) percent/.exec((Array.isArray(out) ? out : [out]).join(' '));
  return m ? Number(m[1]) : null;
}
// The counter beside one line, read out of `show access-lists`.
function hits(out, text) {
  const line = (Array.isArray(out) ? out : String(out).split('\n')).filter(function (l) {
    return l.indexOf(text) !== -1;
  })[0] || '';
  const m = /\((\d+) match/.exec(line);
  return m ? Number(m[1]) : 0;
}

console.log('\nA list can be named, filled line by line, and entered with a prompt that says where you are:');
{
  const env = lab();
  const created = env.s1.run('configure terminal', 'ip access-list extended BLOCK').output;
  match(/Creating extended access list BLOCK, 1 entry/, created, 'the list is created and says so');
  eq(env.s1.prompt(), 'R1(config-ext-nacl)#', 'and the prompt names the list kind');
  env.s1.run('permit icmp any host 10.1.0.1');
  env.s1.run('deny tcp any host 10.1.0.1 eq 23');
  match(/^ +20 deny tcp any host 10\.1\.0\.1 eq 23/m, env.s1.run('show access-lists').output,
    'entries are numbered 10, 20 - the IOS default step');
  eq(env.s1.prompt(), 'R1(config-ext-nacl)#', 'and showing them does not leave the block');
  eq(env.s1.run('exit').output.length, 0, 'exit is silent');
  eq(env.s1.prompt(), 'R1(config)#', 'and goes back to config');
  // A named list lives beside the numbered ones and prints the same way.
  env.cfg(env.s1, ['access-list 130 deny ip any host 10.1.0.9']);
  const shown = env.s1.run('end').output.concat(env.s1.run('show access-lists').output);
  match(/Extended IP access list BLOCK/, shown, 'the named list is shown');
  match(/Extended IP access list 130/, shown, 'beside the numbered one');
  // Standard lists take a source only, and the library says so in its own words.
  const std = env.s1.run('configure terminal', 'ip access-list standard ALLOW10').output;
  match(/Creating standard access list ALLOW10/, std, 'a standard list is created');
  eq(env.s1.prompt(), 'R1(config-std-nacl)#', 'with its own prompt');
  match(/standard entries take a source only/, env.s1.run('permit tcp any any').output,
    'and refuses a protocol, quoting the rule');
  env.s1.run('permit 10.0.0.0 0.0.0.255', 'exit', 'end');
  eq(env.s1.device.config.acls.ALLOW10.kind, 'standard', 'the list remembers it is standard');
}

console.log('\nA named list can be applied, and the counters say which line decided:');
{
  const env = lab();
  eq(rate(env.sp.run('ping 10.1.0.1 count 2').output), 100, 'the far host answers before any filter');
  env.cfg(env.s1, ['ip access-list extended BLOCK', 'deny icmp any host 10.1.0.1',
    'permit ip any any', 'exit',
    'interface Gi0/0', 'ip access-group BLOCK in', 'exit']);
  eq(rate(env.sp.run('ping 10.1.0.1 count 3').output), 0, 'the named list really filters the path');
  const shown = env.s1.run('show access-lists').output;
  match(/applied IN on Gi0\/0/, shown, 'the binding is printed with the list');
  eq(hits(shown, 'deny icmp any host 10.1.0.1'), 3, 'the denying line counted all three packets');
  eq(hits(shown, 'permit ip any any'), 0, 'and the line below it counted none');
  // Traffic that the permit line does carry is counted there, not here.
  eq(rate(env.sp.run('ping 10.0.0.1 count 2').output), 100, 'a ping to the router still works');
  eq(hits(env.s1.run('show access-lists').output, 'permit ip any any'), 2,
    'and lands on the permit line');
  eq(hits(env.s1.run('show access-lists').output, 'deny icmp any host 10.1.0.1'), 3,
    'while the deny line keeps its own count');
}

console.log('\nCounters can be zeroed, which is what makes them dated evidence:');
{
  const env = lab();
  env.cfg(env.s1, ['ip access-list extended BLOCK', 'deny icmp any host 10.1.0.1',
    'permit ip any any', 'exit',
    'interface Gi0/0', 'ip access-group BLOCK in', 'exit']);
  env.sp.run('ping 10.1.0.1 count 2');
  match(/\(2 matches\)/, env.s1.run('show access-lists').output, 'two matches are shown');
  const cleared = env.s1.run('clear access-list counters').output;
  match(/Cleared 2 access-list match counters on 1 list\(s\)/, cleared,
    'clearing says how many it zeroed');
  noMatch(/matches\)/, env.s1.run('show access-lists').output, 'and no count is left behind');
  // Clearing one list leaves the other alone, and clearing again finds nothing to do.
  env.cfg(env.s1, ['access-list 140 deny ip any any']);
  env.sp.run('ping 10.1.0.1 count 1');
  const one = env.s1.run('clear access-list counters BLOCK').output;
  match(/on BLOCK$/, one, 'a named list can be cleared on its own');
  match(/Cleared 0 access-list match counters/, env.s1.run('clear access-list counters').output,
    'and a second clear reports nothing to clear, not failure');
  // Both spellings, and the privileged requirement.
  match(/on 2 list\(s\)/, env.s1.run('clear ip access-list counters').output,
    'the `ip` spelling works too');
  const unpriv = new CliSession(env.r1, env.t, env.sim);
  match(/Privileged command/, unpriv.run('clear access-list counters').output,
    'and an unprivileged session is told why it cannot');
}

console.log('\nThe implicit deny is counted, because it is the line that ate the packet:');
{
  const env = lab();
  // No permit at the end: everything unmatched falls off the list and is denied.
  env.cfg(env.s1, ['ip access-list extended STRICT', 'deny icmp any host 10.1.0.5', 'exit',
    'interface Gi0/0', 'ip access-group STRICT in', 'exit']);
  eq(rate(env.sp.run('ping 10.1.0.1 count 2').output), 0, 'the unmatched traffic is dropped');
  const shown = env.s1.run('show access-lists').output;
  match(/implicit deny +\(2 matches\)/, shown,
    'and the implicit deny carries the count, which is the only warning an operator gets');
}

console.log('\nRemoving a line, by number or by meaning:');
{
  const env = lab();
  env.cfg(env.s1, ['ip access-list extended BLOCK', 'deny icmp any host 10.1.0.1',
    'permit ip any any', 'exit',
    'interface Gi0/0', 'ip access-group BLOCK in', 'exit']);
  env.s1.run('configure terminal', 'ip access-list extended BLOCK');
  match(/Removed entry 20 \(permit ip any any\)/,
    env.s1.run('no 20').output, 'a line is removed by its sequence number');
  match(/No entry 20 in access list BLOCK/, env.s1.run('no 20').output,
    'and removing it twice says it is not there');
  match(/Entries: 10/, env.s1.run('no 20').output, 'listing the numbers that are');
  // The deny line is still deciding traffic - removing it changes the data path back.
  eq(rate(env.sp.run('ping 10.1.0.1 count 1').output), 0, 'the remaining line still blocks');
  env.s1.run('no deny icmp any host 10.1.0.1');
  eq(rate(env.sp.run('ping 10.1.0.1 count 1').output), 100,
    'and removing it by meaning lets the packet through');
  // A line that was *used* since it was typed can still be removed: the hit counter is not part
  // of what the line means.
  env.cfg(env.s1, ['ip access-list extended BLOCK', 'deny icmp any host 10.1.0.1', 'permit ip any any', 'exit']);
  env.sp.run('ping 10.1.0.1 count 2');
  ok(hits(env.s1.run('show access-lists').output, 'deny icmp any host 10.1.0.1') > 0,
    'the line has been used since it was typed');
  env.s1.run('configure terminal', 'ip access-list extended BLOCK');
  match(/Removed entry \d+ \(deny icmp any host 10\.1\.0\.1\) from BLOCK/,
    env.s1.run('no deny icmp any host 10.1.0.1').output,
    'and is still removable by meaning');
}

console.log('\nThe dump carries the block, and pastes back:');
{
  const env = lab();
  env.cfg(env.s1, ['ip access-list extended BLOCK', 'deny icmp any host 10.1.0.1',
    'permit ip any any', 'exit',
    'interface Gi0/0', 'ip access-group BLOCK in', 'exit']);
  const dump = env.s1.run('show running-config').output;
  match(/^ip access-list extended BLOCK$/m, dump, 'the named list is dumped as a block');
  match(/^ {2}10 deny icmp any host 10\.1\.0\.1$/m, dump, 'with its sequence numbers');
  match(/^ {2}ip access-group BLOCK in$/m, dump, 'and the binding by name');
  // A named list must never be dumped in the numbered form, which would rebuild a different object.
  noMatch(/^access-list BLOCK /m, dump, 'never in the numbered form');
  // Paste it into a fresh lab and the filter still decides the same traffic.
  const fresh = lab();
  fresh.s1.run('configure terminal');
  dump.filter(function (l) { return !/^!/.test(l) && !/^hostname /.test(l); })
    .forEach(function (l) { fresh.s1.run(l); });
  fresh.s1.run('end');
  eq(rate(fresh.sp.run('ping 10.1.0.1 count 2').output), 0, 'the pasted lab filters the same traffic');
  match(/applied IN on Gi0\/0/, fresh.s1.run('show access-lists').output, 'with the binding restored');
}

console.log('\nEverything it refuses, it refuses by name:');
{
  const env = lab();
  env.s1.run('configure terminal');
  const said = function (line) { return env.s1.run(line).output; };
  match(/% access lists come in standard or extended, not "bogus"/, said('ip access-list bogus BLOCK'),
    'the kind must be standard or extended');
  match(/% Incomplete command: ip access-list extended <name>/, said('ip access-list extended'),
    'a missing name is incomplete');
  match(/% Unexpected argument "extra"/, said('ip access-list extended A extra'),
    'a trailing word is refused');
  match(/% 101 is a number, and numbered access lists are built with/,
    said('ip access-list extended 101'),
    'a number belongs in the numbered form, and the refusal says where');
  match(/% No access list NOPE - the lists here:/, said('no ip access-list NOPE'),
    'removing a list that is not there names what is');
  // A named list cannot change kind under itself.
  env.s1.run('ip access-list standard S1', 'exit');
  match(/% Access list S1 is standard, not extended/, said('ip access-list extended S1'),
    'a list cannot change kind, and the refusal says how to');
  // Binding a name that is not configured names the lists that are.
  match(/% Access list GHOST does not exist \(named lists are bound by name\)/,
    env.s1.run('interface Gi0/0', 'ip access-group GHOST in', 'exit').output,
    'binding a missing list is refused, and says named lists bind by name');
  match(/% Configured: S1/, env.s1.run('interface Gi0/0', 'ip access-group GHOST in', 'exit').output,
    'with the lists that do exist');
  match(/% Unexpected argument "out"/, env.s1.run('interface Gi0/0', 'ip access-group S1 in out', 'exit').output,
    'a third word on a binding is refused');
  env.s1.run('end');
  // Inside the block.
  env.s1.run('configure terminal', 'ip access-list extended BLOCK');
  match(/a line starts with permit or deny/, env.s1.run('bogus').output,
    'a line that is neither permit nor deny is refused');
  match(/% BLOCK: a permit or deny with no protocol/, env.s1.run('deny').output,
    'an incomplete entry quotes the library');
  match(/% no 10 takes a sequence number alone/, env.s1.run('no 10 20').output,
    'no with a number takes nothing else');
  env.s1.run('exit', 'end');
}

console.log('\nThe block cannot outlive its list:');
{
  const env = lab();
  env.cfg(env.s1, ['ip access-list extended GONE', 'deny ip any any', 'exit',
    'interface Gi0/0', 'ip access-group GONE in', 'exit']);
  // Removing the list unbinds it, and says so - a filter that silently stops filtering is worse
  // than one that refuses to be removed.
  const removed = env.s1.run('configure terminal', 'no ip access-list GONE', 'end').output;
  match(/Extended access list GONE removed \(1 entry\), unbound from Gi0\/0 in/, removed,
    'removing a bound list reports the binding it took with it');
  eq(rate(env.sp.run('ping 10.1.0.1 count 1').output), 100, 'and the port stops filtering');
  // A session left inside a list that disappears is told, not left writing into nothing.
  const s = new CliSession(env.r1, env.t, env.sim);
  s.run('enable');
  s.run('configure terminal', 'ip access-list extended VANISH');
  env.s1.run('configure terminal', 'no ip access-list VANISH', 'end');
  match(/Access list VANISH no longer exists - back to config/, s.run('permit ip any any').output,
    'and a session inside it is put back in config, not left stranded');
  eq(s.prompt(), 'R1(config)#', 'with the prompt to prove it');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
