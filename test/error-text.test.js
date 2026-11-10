'use strict';
// error-text.test.js - an answer is a sentence. `% [object Object]` is not.
//
// Measured before this pass, on a `generic-router` named R1:
//   access-list 110 permit tcp any any eq abc   ->  % [object Object]
//   access-list 110 permit icmp any any echo    ->  % [object Object]
//
// engine/acl.js returns `{ error: { code, message } }`; the console did `'% ' + entry.error`, which
// stringifies the object. The parse error had a perfectly good sentence in it, and the operator saw
// the shape of the answer instead of the answer.
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

const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
const ROUTER = catalog.find(function (s) { return s.model === 'generic-router'; });

function router() {
  const t = new Topology();
  const d = t.addDevice(ROUTER); d.name = 'R1';
  const sim = new Simulator(t);
  const s = new CliSession(d, t, sim); s.run('enable'); s.run('configure terminal');
  return { t: t, d: d, s: s, sim: sim };
}

console.log('\nAn ACL entry that does not parse answers with its own sentence:');
{
  const env = router();
  const s = env.s;
  eq(s.run('access-list 110 permit tcp any any eq abc').output[0],
    '% access-list 110: bad port value "abc"', 'a bad port value is quoted, not stringified');
  eq(s.run('access-list 110 permit tcp any any eq').output[0],
    '% access-list 110: missing port after "eq"',
    'a missing port says it is missing rather than quoting an empty string');
  eq(s.run('access-list 110 permit icmp any any echo').output[0],
    '% access-list 110: unexpected token "echo"', 'an unsupported keyword is named');
  eq(s.run('access-list 1 permit ip any any').output[0],
    '% access-list 1: standard entries take a source only, not a protocol ("ip")',
    'a standard list that was given a protocol says why');
  eq(s.run('access-list 1 permit 10.0.0.0 0.0.0.999').output[0],
    '% access-list 1: invalid wildcard mask "0.0.0.999"', 'a bad wildcard is quoted');
  eq(s.run('access-list 700 permit ip any any').output[0], '% Invalid access list number: 700',
    'an out-of-range list number is refused as before');
  eq(env.d.config.acls === undefined || Object.keys(env.d.config.acls).length === 0, true,
    'and no refused entry was stored');
  // The confirmation names the sequence number the line was given, because that number is what
  // `no <sequence>` and the dump will use from now on.
  eq(s.run('access-list 110 permit tcp 10.0.0.0 0.0.0.255 any eq 443').output[0],
    'Extended access list 110 (10): permit entry added', 'while a good entry is added');
}

console.log('\nNo refusal anywhere is "the shape of an answer":');
{
  // The sweep is the point: `[object Object]` was one symptom of a `'% ' + something` that could be
  // an object. Every refusal below is checked for it, so a new one cannot slip in unnoticed.
  const env = router();
  const s = env.s;
  const commands = [
    'access-list 110 permit tcp any any eq abc',
    'access-list 110 permit icmp any any echo',
    'access-list abc permit ip any any',
    'access-list 110 permit tcp host 1.1.1.1 host 2.2.2.2 eq 80',
    'ip ospf cost abc',
    'ip ospf area abc',
    'ospf area abc',
    'ospf router-id nope',
    'scion abc',
    'scion 1-ff00:0:110 extra',
    'vrrp 1 ip nope',
    'ip route nope 255.255.255.0 10.0.0.1',
    'dns add www A nope',
    'ip dhcp pool p',
    'network nope',
    'range nope nope',
    'exit'
  ];
  const offenders = [];
  for (const cmd of commands) {
    let out = [];
    try { out = s.run(cmd).output; } catch (e) { offenders.push(cmd + ' threw: ' + e.message); continue; }
    for (const line of out) {
      if (/\[object Object\]|undefined|NaN|\(none\)|\bnull\b/.test(line)) {
        offenders.push(cmd + ' -> ' + line);
      }
    }
  }
  eq(offenders.length, 0, 'no answer contains "[object Object]", undefined, NaN, null or (none)' +
    (offenders.length ? ': ' + offenders.join(' | ') : ''));
}

console.log('\nAn OSPF cost is a number in range, and the refusal quotes what was typed:');
{
  const env = router();
  const s = env.s;
  s.run('ospf router-id 1.1.1.1');
  s.run('interface Gi0/0');
  eq(s.run('ip ospf cost abc').output[0], '% Cost must be a number 1..65535, not "abc"',
    'a word is refused by name');
  eq(s.run('ip ospf cost').output[0], '% Incomplete command: ip ospf cost <n> (1..65535)',
    'a missing value is incomplete, not "must be 1..65535" for a value that was not given');
  eq(s.run('ip ospf cost 70000').output[0], '% Cost 70000 is outside 1..65535',
    'an out-of-range number is quoted');
  eq(s.run('ip ospf cost 10 extra').output[0],
    '% Unexpected argument "extra" - ip ospf cost <n> takes no more',
    'and a trailing word is refused');
  eq(s.run('ip ospf cost 10').output[0], 'OSPF cost 10 on Gi0/0', 'a real cost is accepted');
}

console.log('\nA SCION ISD-AS takes one word:');
{
  const env = router();
  const s = env.s;
  eq(s.run('scion 1-ff00:0:110 extra').output[0],
    '% Unexpected argument "extra" - scion <isd-as> takes no more',
    'a trailing word is refused instead of being dropped');
  eq(s.run('scion 1-ff00:0:110').output[0], 'SCION 1-ff00:0:110', 'and a real one is accepted');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
