'use strict';
// exec-options.test.js - traceroute accepted options it never read, and `show ip arp` was refused.
//
// Measured before this pass, on a `generic-router`:
//   traceroute 10.0.0.5 source abc   ->  a full hop table, no mention of `source abc`
//   traceroute 10.0.0.5 ttl abc      ->  a full hop table, no mention of `ttl abc`
//
// `ping` refused both of those (`% Unrecognised argument "source"`), so the two half-siblings had
// different ideas about whether a word they cannot use is the operator's mistake or nobody's.
// traceroute's parser loop looked for `at` and `continue`d past everything else, which is exactly
// the shape of "the answer is fine, the answer to what you asked is not".
//
// And `show ip arp` - the spelling IOS puts in its own help - answered `% Invalid show command:
// ip arp`, while the shorthand `show arp` worked.
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
const PC = catalog.find(function (s) { return s.model === 'generic-pc'; });

// PC1 -- R1 -- PC2: a real two-hop path, so traceroute has names to resolve.
function lab() {
  const t = new Topology();
  const r1 = t.addDevice(ROUTER); r1.name = 'R1';
  const pc1 = t.addDevice(PC); pc1.name = 'PC1';
  const pc2 = t.addDevice(PC); pc2.name = 'PC2';
  t.connect(pc1.id, 'eth0', r1.id, 'Gi0/0');
  t.connect(pc2.id, 'eth0', r1.id, 'Gi0/1');
  const sim = new Simulator(t);
  const cfg = function (d, cmds) {
    const s = new CliSession(d, t, sim);
    s.run('enable'); s.run('configure terminal');
    for (const cmd of cmds) s.run(cmd);
    s.run('end');
    return s;
  };
  cfg(r1, ['interface Gi0/0', 'ip address 10.1.1.1 255.255.255.0', 'exit',
    'interface Gi0/1', 'ip address 10.2.2.1 255.255.255.0', 'exit']);
  cfg(pc1, ['interface eth0', 'ip address 10.1.1.10 255.255.255.0', 'exit',
    'ip default-gateway 10.1.1.1']);
  cfg(pc2, ['interface eth0', 'ip address 10.2.2.10 255.255.255.0', 'exit',
    'ip default-gateway 10.2.2.1']);
  const s = new CliSession(pc1, t, sim); s.run('enable');
  return { t: t, r1: r1, pc1: pc1, pc2: pc2, sim: sim, s: s };
}

console.log('\nTraceroute refuses a word it does not use:');
{
  const env = lab();
  for (const word of ['source', 'ttl', 'size', 'timeout', 'repeat', 'df-bit']) {
    eq(env.s.run('traceroute 10.2.2.10 ' + word + ' abc').output[0],
      '% Unrecognised argument "' + word + '" (expected at <ms>|converged or numeric)',
      '`' + word + '` is named, not skipped');
  }
  // ...and the trace it would have printed is not printed: a refusal, not a trace with a warning.
  const refused = env.s.run('traceroute 10.2.2.10 source abc').output;
  eq(refused.length, 1, 'the refusal is the whole answer - no hop table was printed');
  ok(!refused.some(function (l) { return /Type escape sequence/.test(l); }),
    'and nothing starts a trace that was never asked for');
}

console.log('\n`numeric` is taken, and it means what it says:');
{
  const env = lab();
  const named = env.s.run('traceroute 10.2.2.10').output;
  const numeric = env.s.run('traceroute 10.2.2.10 numeric').output;
  ok(named.some(function (l) { return /Device/.test(l); }), 'the plain trace resolves names into a Device column');
  ok(named.some(function (l) { return /R1/.test(l) && l.indexOf('10.1.1.1') !== -1; }),
    'and names the router at the first hop');
  ok(!numeric.some(function (l) { return /Device/.test(l); }), '`numeric` drops that column');
  ok(!numeric.some(function (l) { return /\bR1\b|\bPC2\b/.test(l); }), 'and prints no device names at all');
  ok(numeric.some(function (l) { return /10\.1\.1\.1/.test(l); }), 'while the addresses are all still there');
  ok(numeric.some(function (l) { return /^Path: 10\.1\.1\.1 -> 10\.2\.2\.10/.test(l); }),
    'including in the path line, which is addresses only');
  ok(named.some(function (l) { return /^Path: PC1 -> R1 -> PC2/.test(l); }),
    'the plain trace still names the path');
  // Both spellings of the command take the option.
  ok(env.s.run('tracert 10.2.2.10 numeric').output.some(function (l) { return !/Device/.test(l); }),
    'and `tracert` takes it too');
}

console.log('\n`at` with nothing after it is incomplete, not invalid:');
{
  const env = lab();
  eq(env.s.run('traceroute 10.2.2.10 at').output[0],
    '% Incomplete command: traceroute <dst> [at <ms>|converged] [numeric]',
    'traceroute says the command is incomplete');
  eq(env.s.run('ping 10.2.2.10 at').output[0],
    '% Incomplete command: ping <dst> [count <n>] [at <ms>|converged]',
    'and ping no longer quotes the placeholder "(none)" at the operator');
  // A bad instant is still named.
  eq(env.s.run('traceroute 10.2.2.10 at abc').output[0], '% Invalid instant: abc',
    'while a real bad instant is quoted');
  ok(env.s.run('traceroute 10.2.2.10 numeric at 5000').output
    .some(function (l) { return /at t=5000 ms/.test(l); }),
    'and the options combine: numeric at an instant, labelled with the instant');
}

console.log('\n`show ip arp` is the same command as `show arp`:');
{
  const env = lab();
  env.s.run('ping 10.2.2.10 count 1');
  const short = env.s.run('show arp').output;
  const long = env.s.run('show ip arp').output;
  eq(long.join('\n'), short.join('\n'), 'both doors give the same table');
  // PC1 ARPs for its gateway, not for the far host: the cache holds what it addressed at L2.
  ok(long.some(function (l) { return /10\.1\.1\.1/.test(l); }), 'and it holds the gateway entry the ping created');
  ok(!long.some(function (l) { return /10\.2\.2\.10/.test(l); }),
    'while the far host is absent, because PC1 addressed the gateway at L2');
  eq(env.s.run('show ip arp eth0').output.join('\n'), env.s.run('show arp eth0').output.join('\n'),
    'the port filter works through either spelling');
  ok(env.s.run('show ip arp at 5000').output.some(function (l) { return /at t=5000 ms/.test(l); }),
    'and `show ip arp` can be asked about an instant, like `show arp`');
  eq(env.s.run('show ip arp eth9').output[0], '% show arp takes a port, or an address - not "eth9"',
    'a port that does not exist is refused rather than ignored');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
