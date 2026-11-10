'use strict';
// dest-arguments.test.js — the first argument of `ping`, `traceroute` and `flow open` is a
// destination, and it is never one of the command's own keywords.
//
// Three defects, one shape, all measured before the fix:
//
//   R1#ping                              % Invalid ping target: (none)
//   R1#ping at 5000                      % Unknown host at: no DNS server in this lab hosts a zone for it
//   R1#flow open port 22                 % Unknown host port: no DNS server in this lab hosts a zone for it
//   R1#flow open                         % Incomplete command: flow open <dst-ip> [port <n>] ...
//
// The third line is the bad one: a forgotten address was answered with an accusation about DNS, so an
// operator learns "this lab has no name server" from a command that never named a host. `(none)` is
// the same mistake in a different costume - a placeholder printed where a value belongs. And the
// fourth quoted a placeholder (`<dst-ip>`) that appears in no help row; the documented one is `<dst>`.
const path = require('path');
const { Topology, Simulator, CliSession } = require('../engine');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg); }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
const ROUTER = catalog.find(function (s) { return s.model === 'generic-router'; });
const PC = catalog.find(function (s) { return s.model === 'generic-pc'; });

// A host and a router, so a legitimately-resolvable name exists and a ping can actually leave.
function lab() {
  const t = new Topology();
  const r = t.addDevice(ROUTER); r.name = 'R1';
  const pc = t.addDevice(PC); pc.name = 'PC1';
  t.connect(pc.id, 'eth0', r.id, 'Gi0/1');
  const sim = new Simulator(t);
  const s = new CliSession(r, t, sim);
  s.run('enable');
  s.run('configure terminal');
  s.run('dns zone lab.test');
  s.run('dns add www.lab.test A 10.0.1.50');
  s.run('end');
  return { t: t, r: r, pc: pc, sim: sim, run: function (cmd) { return s.run(cmd).output; } };
}

const USAGES = {
  'ping': 'ping <dst> [count <n>] [at <ms>|converged]',
  'traceroute': 'traceroute <dst> [at <ms>|converged]',
  'flow open': 'flow open <dst> [port <n>] [bytes <n>] [proto tcp|udp]'
};

console.log('\nA missing destination is an incomplete command, not a target:');
{
  const l = lab();
  for (const cmd of ['ping', 'traceroute', 'flow open']) {
    const out = l.run(cmd).join('\n').trim();
    ok(out === '% Incomplete command: ' + USAGES[cmd], cmd + ' with no argument quotes its own synopsis');
    ok(!/\(none\)/.test(out), cmd + ' does not print a placeholder as if it were a value');
    ok(!/Users|host/i.test(out), cmd + ' does not blame the resolver for a missing argument');
  }
  // The placeholder in every one of these messages is the one help prints.
  const help = l.run('help').join('\n');
  for (const s of ['ping <dst>', 'traceroute <dst>', 'flow open <dst>']) {
    ok(help.indexOf(s) !== -1, 'help advertises "' + s + '"');
  }
  ok(!/<dst-ip>/.test(help + l.run('flow open').join('\n')), 'the invented placeholder <dst-ip> is gone');
}

console.log('\nA command that begins with its own keyword has no destination:');
{
  const l = lab();
  // Every keyword of the family, in the destination slot. None of these may reach the resolver.
  const cases = [
    ['ping at 5000', 'ping'], ['ping count 2', 'ping'],
    ['traceroute at 1000', 'traceroute'],
    ['flow open at 1000', 'flow open'], ['flow open port 22', 'flow open'],
    ['flow open bytes 64', 'flow open'], ['flow open proto tcp', 'flow open'],
    ['flow open sport 1000', 'flow open']
  ];
  for (const [cmd, family] of cases) {
    const out = l.run(cmd).join('\n').trim();
    ok(out === '% Incomplete command: ' + USAGES[family], cmd + ' is refused as incomplete');
    ok(!/Unknown host/.test(out), cmd + ' never asks DNS about the keyword');
  }
  // Case does not smuggle it through either.
  const upper = l.run('ping AT 5000').join('\n').trim();
  ok(upper === '% Incomplete command: ' + USAGES['ping'], 'an upper-case keyword is the same keyword');
}

console.log('\nA real destination still works, including a name:');
{
  const l = lab();
  const ip = l.run('ping 10.0.1.50 count 1').join('\n');
  ok(/Sending 1, 100-byte ICMP Echos to 10\.0\.1\.50/.test(ip), 'ping <addr> <count> is unaffected');
  const name = l.run('ping www.lab.test count 1').join('\n');
  ok(/Translating "www\.lab\.test"\.\.\.domain server \(R1 \(authoritative for lab\.test\)\)/.test(name),
    'a name still resolves first, and the line names the server that answered');
  const tr = l.run('traceroute 10.0.1.50').join('\n');
  ok(/Tracing the route to 10\.0\.1\.50/.test(tr), 'traceroute <addr> is unaffected');
  const trAt = l.run('traceroute 10.0.1.50 at 0').join('\n');
  ok(/Tracing the route to 10\.0\.1\.50/.test(trAt), 'traceroute <addr> at <ms> is unaffected');
  const fl = l.run('flow open 10.0.1.50 port 80').join('\n');
  ok(/10\.0\.1\.50/.test(fl) && !/Incomplete/.test(fl), 'flow open <addr> port <n> is unaffected');
  // And an address that merely *starts* like a keyword is still an address, because only the whole
  // first token is compared.
  const near = l.run('ping atlantis.lab.test count 1').join('\n');
  ok(!/Incomplete command/.test(near), 'a name beginning with "at" is not treated as the keyword');
}

console.log('\nnslookup speaks the same language:');
{
  const l = lab();
  const out = l.run('nslookup').join('\n').trim();
  ok(out === '% Incomplete command: nslookup <name> [type]', 'a missing name is incomplete, not a usage error');
  ok(/Query:/.test(l.run('nslookup www.lab.test').join('\n')), 'and a name still answers');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
