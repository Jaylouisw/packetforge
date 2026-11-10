'use strict';
// dns-policy.test.js - the two settings that decide what a name query even means.
//
// Measured before this pass, on a PC with a resolver reachable and a zone in the lab:
//   PC1(config)#ip domain-name lab.test
//   % Unrecognized config command: ip domain-name lab.test
//   PC1(config)#no ip domain-lookup
//   % Unrecognized config command: no ip domain-lookup
//
// Name resolution worked and could not be configured: it was always on, and a name was always asked
// exactly as typed. A lab about DNS is mostly about those two facts - "show me that resolution can be
// switched off" and "why does `ping www` answer here" - and neither had a command.
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
  ok(re.test(text), msg + (re.test(text) ? '' : ' (no match in ' + JSON.stringify(text.slice(0, 700)) + ')'));
}
function noMatch(re, haystack, msg) {
  const text = Array.isArray(haystack) ? haystack.join('\n') : String(haystack);
  ok(!re.test(text), msg + (re.test(text) ? ' (found ' + re + ')' : ''));
}
const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
const ROUTER = catalog.find(function (s) { return s.model === 'generic-router'; });
const PC = catalog.find(function (s) { return s.model === 'generic-pc'; });

// PC1 10.0.0.50 -- R1 10.0.0.1/24, with R1 authoritative for lab.test and www.lab.test -> PC1.
function lab() {
  const t = new Topology();
  const r1 = t.addDevice(ROUTER); r1.name = 'R1';
  const pc = t.addDevice(PC); pc.name = 'PC1';
  t.connect(pc.id, 'eth0', r1.id, 'Gi0/0');
  const sim = new Simulator(t);
  const mk = function (d) { const s = new CliSession(d, t, sim); s.run('enable'); return s; };
  const a = mk(r1), sp = mk(pc);
  const cfg = function (s, cmds) {
    s.run('configure terminal');
    const out = [];
    for (const c of cmds) out.push.apply(out, s.run(c).output);
    s.run('end');
    return out;
  };
  cfg(sp, ['hostname PC1', 'interface eth0', 'ip address 10.0.0.50 255.255.255.0',
    'ip default-gateway 10.0.0.1', 'exit']);
  cfg(a, ['hostname R1', 'interface Gi0/0', 'ip address 10.0.0.1 255.255.255.0', 'exit',
    'dns zone lab.test', 'dns add www.lab.test A 10.0.0.50']);
  return { t: t, sim: sim, r1: r1, pc: pc, a: a, sp: sp, cfg: cfg };
}

console.log('\nA fully-qualified name resolves, as it always did:');
{
  const env = lab();
  const out = env.sp.run('ping www.lab.test count 1').output;
  match(/Translating "www\.lab\.test"\.\.\.domain server \(R1\)/, out, 'the resolution is announced');
  match(/Success rate is 100 percent \(1\/1\)/, out, 'and the name reaches the address');
  match(/Reply from 10\.0\.0\.50/, out, 'from the right host');
}

console.log('\n`ip domain-name` makes an unqualified name a question with an answer:');
{
  const env = lab();
  match(/% Unknown host www: no DNS server in this lab hosts a zone for it/,
    env.sp.run('ping www count 1').output,
    'without a domain name, `ping www` asks for `www` - and nothing hosts it');
  const set = env.cfg(env.sp, ['ip domain-name lab.test']);
  match(/Domain name on PC1 set to lab\.test/, set, 'the domain name is set');
  match(/asked as name\.lab\.test first/, set, 'and the command says what will happen to a bare name');
  eq(env.pc.config.domainName, 'lab.test', 'the device records it');
  const out = env.sp.run('ping www count 1').output;
  match(/\(as www\.lab\.test - "ip domain-name" appended the suffix\)/, out,
    'the suffix is shown, not left to be guessed from the answer');
  match(/Success rate is 100 percent \(1\/1\)/, out, 'and the suffixed name resolves');
  // The same note from traceroute: two commands resolving one name must agree about it.
  match(/\(as www\.lab\.test - "ip domain-name" appended the suffix\)/,
    env.sp.run('traceroute www').output, 'traceroute reports the same suffix');
  // A name that already has a dot is asked as typed.
  match(/Translating "www\.lab\.test"/, env.sp.run('ping www.lab.test count 1').output,
    'a qualified name is not given the suffix again');
  // `no ip domain-name` puts the bare-name question back.
  match(/Domain name cleared on PC1 \(was lab\.test\)/, env.cfg(env.sp, ['no ip domain-name']),
    'the domain name can be cleared');
  match(/% Unknown host www: no DNS server/, env.sp.run('ping www count 1').output,
    'and `ping www` is a question with no answer again');
  match(/No domain name is set on PC1/, env.cfg(env.sp, ['no ip domain-name']),
    'clearing it twice says there was nothing to clear');
}

console.log('\n`no ip domain-lookup` refuses the question instead of answering it:');
{
  const env = lab();
  const out = env.cfg(env.sp, ['no ip domain-lookup']);
  match(/Name lookup disabled on PC1: a name is refused instead of resolved, and an address still works/, out,
    'the command says what it did and what it did not do');
  const refused = env.sp.run('ping www.lab.test count 1').output;
  match(/% Cannot resolve www\.lab\.test: name lookup is disabled on PC1 \(no ip domain-lookup\)/, refused,
    'a name is refused by naming the switch that refused it');
  match(/put resolution back with "ip domain-lookup"/, refused, 'and naming the way back');
  noMatch(/Unknown host/, refused, 'and not blamed on a missing zone');
  // An address is not a lookup, so it still works - which is the diagnostic value of the switch.
  match(/Success rate is 100 percent \(1\/1\)/, env.sp.run('ping 10.0.0.50 count 1').output,
    'an address still reaches the same host');
  match(/% Cannot resolve www: name lookup is disabled on PC1/,
    env.sp.run('traceroute www').output, 'traceroute refuses the same way');
  // `show dns` states the policy beside the zones it governs.
  const dns = env.sp.run('show dns').output;
  match(/Lookup\s+: disabled \(no ip domain-lookup\)/, dns, '`show dns` reports the policy');
  match(/Domain name : none/, dns, 'and whether a suffix would be added');
  match(/Name lookup enabled on PC1/, env.cfg(env.sp, ['ip domain-lookup']), 'and it can be turned back on');
  match(/Success rate is 100 percent/, env.sp.run('ping www.lab.test count 1').output,
    'after which a name resolves again');
  match(/is already enabled/, env.cfg(env.sp, ['ip domain-lookup']), 'enabling twice says it is already on');
  env.cfg(env.sp, ['no ip domain-lookup']);
  match(/is already disabled/, env.cfg(env.sp, ['no ip domain-lookup']), 'and disabling twice says so');
}

console.log('\nA suffix that cannot be a name is refused where it is typed:');
{
  const env = lab();
  for (const [word, why] of [
    ['bad..name', 'an empty label'],
    ['-x.test', 'starts or ends with a hyphen'],
    ['under_score.test', 'has a character a name cannot carry'],
    ['a'.repeat(70) + '.test', 'is longer than 63 characters']
  ]) {
    const out = env.cfg(env.sp, ['ip domain-name ' + word]).join('\n');
    ok(out.indexOf('% "' + word + '" is not a domain name:') === 0,
      '"' + (word.length > 30 ? word.slice(0, 12) + '...' : word) + '" is refused at the console');
    ok(out.indexOf(why) !== -1, 'and the reason names it: ' + why);
  }
  match(/% Incomplete command: ip domain-name <name>/, env.cfg(env.sp, ['ip domain-name']),
    'a bare command is incomplete, not silent');
  match(/% Unexpected argument "extra" - ip domain-name <name> takes no more/,
    env.cfg(env.sp, ['ip domain-name ok.test extra']), 'a trailing word is refused');
  ok(!env.pc.config.domainName, 'and none of the refused words was stored');
}

console.log('\nBoth settings survive a dump and a paste:');
{
  const env = lab();
  env.cfg(env.sp, ['ip domain-name lab.test', 'no ip domain-lookup']);
  const dump = env.sp.run('show running-config').output;
  match(/^ip domain-name lab\.test$/m, dump, 'the domain name is in the dump');
  match(/^no ip domain-lookup$/m, dump, 'and the disabled lookup');
  // A device with neither line carries neither.
  const plain = env.a.run('show running-config').output;
  noMatch(/ip domain-name|no ip domain-lookup/, plain, 'a device left alone contributes neither line');
  const t2 = new Topology();
  const twin = t2.addDevice(PC);
  const s2 = new CliSession(twin, t2, new Simulator(t2));
  s2.run('enable'); s2.run('configure terminal');
  for (const line of dump.slice(1)) {
    // Ordinary control flow: the banner and the terminator are not commands to paste.
    if (/^!/.test(line) || /^end$/.test(line)) continue;
    s2.run(line);
  }
  s2.run('end');
  eq(twin.config.domainName, 'lab.test', 'the domain name survives a paste');
  eq(twin.config.domainLookup, false, 'and so does the disabled lookup');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
