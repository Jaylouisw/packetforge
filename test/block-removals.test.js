'use strict';
// block-removals.test.js - a `no` line says something, and a global line in a block says what it did.
//
// Two silences, found by typing `no <every candidate word>` at five prompts and a global command at
// three blocks:
//
//   R1(config-dhcp)#no range          <- nothing at all
//   R1(config-dhcp)#no zz             <- nothing at all: a typo, accepted in silence
//   R1(config-if)#no interface
//   % Interface not found:            <- a port with no name, or a line that stopped too early?
//   R1(config-std-nacl)#hostname R9
//   (applied, prompt moved to global config, and not one word about either)
//
// The rules:
//   1. A `no` line always answers. Silence is the one reply that cannot be told apart from "ignored".
//   2. A missing argument is not a missing object: `no interface` says the command is incomplete.
//   3. A global command typed in a block says it was applied at global scope and what became of the
//      block - kept (interface) or left (process and list blocks, which a pasted dump relies on).
const path = require('path');
const { Topology, Simulator } = require('../engine');
const { CliSession } = require('../engine/cli');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg); }
}
function text(out) { return out && out.output ? out.output.join('\n') : String(out); }
const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
const find = function (m) { return catalog.filter(function (x) { return x.model === m; })[0]; };

function router() {
  const t = new Topology();
  const d = t.addDevice(find('generic-router')); d.name = 'R1';
  const s = new CliSession(d, t, new Simulator(t)); s.run('enable');
  return { t: t, d: d, s: s };
}

console.log('A pool removal says what it cleared:');
{
  const env = router();
  env.s.run('configure terminal');
  env.s.run('ip dhcp pool LAN');
  env.s.run('network 10.5.0.0 255.255.255.0');
  env.s.run('default-router 10.5.0.1');
  env.s.run('dns-server 10.5.0.53');
  env.s.run('range 10.5.0.10 10.5.0.99');
  env.s.run('lease 1');
  const cases = [
    ['no default-router', /Default router cleared \(was 10\.5\.0\.1\)/],
    ['no dns-server', /DNS servers cleared \(were 10\.5\.0\.53\)/],
    ['no range', /Lease range cleared \(was 10\.5\.0\.10 - 10\.5\.0\.99\)/],
    ['no lease', /Lease length cleared \(was 86400s\)/]
  ];
  for (const [cmd, want] of cases) {
    const out = text(env.s.run(cmd));
    ok(out.trim() !== '', cmd + ' answers');
    ok(want.test(out), '  and says what it cleared: ' + out.split('\n')[0].slice(0, 60));
  }
  // Removing something that is no longer there says that too - it is not the same as silence.
  const again = text(env.s.run('no range'));
  ok(/No range was configured/.test(again), 'a second no range says there is nothing to clear');
  // A word the pool cannot remove is refused by name, with the words it does take.
  const typo = text(env.s.run('no zz'));
  ok(/is not something this pool can remove/.test(typo), 'a stray word is refused, not ignored');
  ok(/default-router, dns-server, range, lease, excluded-address, pool/.test(typo),
    '  and the words it does take are named');
  ok(!/^\s*$/.test(typo), '  the answer is not blank');
  // The pool is still there, and still valid - a refusal changed nothing.
  ok(env.d.config.dhcpPools.length === 1, 'the pool itself survives the refusal');
}

console.log('\nA missing argument is not a missing interface:');
{
  const env = router();
  env.s.run('configure terminal');
  env.s.run('interface Gi0/0');
  for (const cmd of ['no interface', 'no int']) {
    const out = text(env.s.run(cmd));
    ok(/Incomplete command: no interface <name>/.test(out), cmd + ' names the missing argument');
    ok(!/not found/.test(out), '  and does not claim a port is missing');
    ok(/Usage:/.test(out), '  with the forms that do take a name');
  }
  ok(/Interface not found: zz/.test(text(env.s.run('no interface zz'))),
    'a name that is wrong is still reported as a name');
  ok(/Interface not found: zz/.test(text(env.s.run('no int zz'))), 'under both spellings');
}

console.log('\nA global command in a block says what it did:');
{
  const KEPT = /is a global command - applied at global scope; you are still in this interface block/;
  const LEFT = /is a global command - applied at global scope; this block was left/;
  // The interface block is kept: the operator typing three lines for one port is not evicted.
  const iface = router();
  iface.s.run('configure terminal'); iface.s.run('interface Gi0/0');
  const kept = text(iface.s.run('hostname R1-core'));
  ok(KEPT.test(kept), 'in an interface block: applied, and the block is kept');
  ok(/config-if/.test(iface.s.prompt()), '  the prompt really is still the port');
  // A process block is left, because a pasted dump relies on it - and now says so.
  for (const [name, steps] of [
    ['OSPF block', ['configure terminal', 'router ospf 1']],
    ['BGP block', ['configure terminal', 'router bgp 65001']],
    ['ACL block', ['configure terminal', 'ip access-list extended BLOCK']]
  ]) {
    const env = router();
    for (const step of steps) env.s.run(step);
    const out = text(env.s.run('hostname R2-core'));
    ok(LEFT.test(out), name + ': applied at global scope and the block was left');
    ok(/R2-core/.test(env.d.config.hostname || ''), '  the hostname really changed');
    ok(/config\)#/.test(env.s.prompt()), '  and the prompt matches what the note said');
  }
}

console.log('\nThe sweep behind it: no `no` line in any block is silent:');
{
  // Every quoted lowercase literal is a candidate removal word. Silence is the failure this looks for.
  const fs = require('fs');
  const src = fs.readFileSync(path.join(__dirname, '..', 'engine', 'cli.js'), 'utf8');
  const words = new Set();
  for (const m of src.matchAll(/'([a-z][a-z0-9-]{2,13})'/g)) words.add(m[1]);
  const MODES = [
    ['global config', ['configure terminal']],
    ['interface block', ['configure terminal', 'interface Gi0/0']],
    ['DHCP pool', ['configure terminal', 'ip dhcp pool LAN']],
    ['standard ACL', ['configure terminal', 'ip access-list standard BLOCK']],
    ['OSPF process', ['configure terminal', 'router ospf 1']],
    ['BGP process', ['configure terminal', 'router bgp 65001']]
  ];
  let typed = 0;
  const silent = [];
  for (const [name, steps] of MODES) {
    const env = router();
    const enter = function () {
      env.s.run('end');
      for (const step of steps) env.s.run(step);
    };
    enter();
    const want = env.s.mode;
    for (const w of words) {
      enter();
      const out = String(text(env.s.run('no ' + w)));
      typed++;
      // Not an exemption, ordinary control flow: a word that moved the prompt is a mode change, and
      // the next word starts from a restored prompt anyway.
      if (env.s.mode !== want) continue;
      if (out.trim() === '') silent.push(name + ': no ' + w);
    }
  }
  ok(typed > 1000, 'the sweep typed a `no` line for every candidate word (' + typed + ')');
  ok(silent.length === 0, 'and no `no` line was silent'
    + (silent.length ? ' - ' + silent.slice(0, 6).join(', ') : ''));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
