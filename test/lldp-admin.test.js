'use strict';
// lldp-admin.test.js - a neighbour table that could only ever fill.
//
// Measured before this pass, on two switches cabled together:
//   SW1(config)#no lldp run
//   % Unrecognized config command: no lldp run
//   SW1(config-if)#no lldp transmit
//   % Unrecognized interface command: no lldp transmit
//   SW1(config-if)#no lldp receive
//   % Unrecognized interface command: no lldp receive
//
// The neighbour table is trustworthy precisely because it is filled from LLDPDUs that really crossed
// the link - and it could only ever grow. The only way to empty it was to unplug the cable, and a lab
// in which discovery must not work (the usual reason to care about LLDP) could not be built.
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
  ok(re.test(text), msg + (re.test(text) ? '' : ' (no match in ' + JSON.stringify(text.slice(0, 600)) + ')'));
}
function noMatch(re, haystack, msg) {
  const text = Array.isArray(haystack) ? haystack.join('\n') : String(haystack);
  ok(!re.test(text), msg + (re.test(text) ? ' (found ' + re + ')' : ''));
}
const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
const SWITCH = catalog.find(function (s) { return s.model === 'generic-switch'; });

// SW1 Fa0/1 -- Fa0/1 SW2, with a second cable on Fa0/2 so a per-port decision has a port to spare.
function lab() {
  const t = new Topology();
  const a = t.addDevice(SWITCH); a.name = 'SW1';
  const b = t.addDevice(SWITCH); b.name = 'SW2';
  t.connect(a.id, 'Fa0/1', b.id, 'Fa0/1');
  t.connect(a.id, 'Fa0/2', b.id, 'Fa0/2');
  const sim = new Simulator(t);
  const mk = function (d) { const s = new CliSession(d, t, sim); s.run('enable'); return s; };
  const s1 = mk(a), s2 = mk(b);
  s1.run('configure terminal'); s1.run('hostname SW1'); s1.run('end');
  s2.run('configure terminal'); s2.run('hostname SW2'); s2.run('end');
  const cfg = function (s, cmds) {
    s.run('configure terminal');
    const out = [];
    for (const c of cmds) out.push.apply(out, s.run(c).output);
    s.run('end');
    return out;
  };
  return { t: t, sim: sim, s1: s1, s2: s2, a: a, b: b, cfg: cfg };
}

console.log('\nBoth devices start out knowing each other:');
{
  const env = lab();
  const out = env.s1.run('show lldp neighbors').output;
  match(/Neighbour\s+Local port\s+Port ID\s+Mgmt address/, out, 'the table has a header');
  match(/SW2\s+Fa0\/1\s+Fa0\/1/, out, 'and SW1 sees SW2 on the cabled ports');
  match(/SW2\s+Fa0\/2/, out, 'including the second cable');
}

console.log('\n`no lldp run` stops the device speaking and forgets what it heard:');
{
  const env = lab();
  // Both tables are populated before anything is turned off, so "forgotten" has something to mean.
  env.s1.run('show lldp neighbors');
  env.s2.run('show lldp neighbors');
  const out = env.cfg(env.s1, ['no lldp run']);
  match(/LLDP disabled on SW1: no port announces and none listens/, out, 'the command says what it did');
  match(/2 neighbours forgotten; peers keep their entries until they stop listening/, out,
    'and what was forgotten, and what was not');
  eq(env.a.lldp.size, 0, 'the neighbour table is empty');
  const asked = env.s1.run('show lldp neighbors').output;
  match(/% LLDP is disabled on SW1 \(no lldp run\)/, asked,
    'a question about neighbours is answered with the state, not with "none"');
  noMatch(/none - no LLDP has been heard/, asked,
    'and not with an emptiness that reads like a cabling fault');
  // The peer is honest about the same fact from its own side: nothing ages in this model.
  match(/SW1\s+Fa0\/1/, env.s2.run('show lldp neighbors').output,
    'the peer keeps the entry it learned (this model has no hold timer, and says so)');
  // Re-enabling is a new simulation: the table fills again.
  match(/LLDP enabled on SW1: every cabled port announces and listens/,
    env.cfg(env.s1, ['lldp run']), '`lldp run` turns it back on');
  match(/SW2\s+Fa0\/1/, env.s1.run('show lldp neighbors').output,
    'and the neighbour is heard again on the next run');
  match(/is already enabled/, env.cfg(env.s1, ['lldp run']), 'enabling twice says it is already on');
  env.cfg(env.s1, ['no lldp run']);
  match(/is already disabled/, env.cfg(env.s1, ['no lldp run']), 'and disabling twice says so');
}

console.log('\n`no lldp receive` drops what that port heard, and nothing else:');
{
  const env = lab();
  env.s1.run('show lldp neighbors');
  const out = env.cfg(env.s1, ['interface Fa0/1', 'no lldp receive']);
  match(/LLDP receive off on Fa0\/1: the port is no longer listening/, out, 'the port stops listening');
  match(/The neighbour learned earlier on this port \(SW2\) is dropped/, out,
    'and the entry it had learned is dropped, naming the peer');
  eq(env.a.interfaces.get('Fa0/1').lldpRx, false, 'the port records the decision');
  ok(env.a.lldp.has('Fa0/2'), 'the other cabled port still has its neighbour');
  const one = env.s1.run('show lldp neighbors Fa0/1').output;
  match(/% Fa0\/1 is not listening for LLDP \(no lldp receive\)/, one,
    'asking about that port is answered with the reason');
  // The port still announces - receive and transmit are independent decisions.
  match(/SW1\s+Fa0\/1/, env.s2.run('show lldp neighbors').output,
    'the port still announces itself to its neighbour');
  env.cfg(env.s1, ['interface Fa0/1', 'lldp receive']);
  match(/LLDP receive on Fa0\/1 is already on/, env.cfg(env.s1, ['interface Fa0/1', 'lldp receive']),
    'and putting it back again says it is already on');
  match(/SW2\s+Fa0\/1/, env.s1.run('show lldp neighbors').output, 'and the neighbour is heard again');
}

console.log('\n`no lldp transmit` stops one port announcing:');
{
  const env = lab();
  env.s1.run('show lldp neighbors');
  const out = env.cfg(env.s1, ['interface Fa0/2', 'no lldp transmit']);
  match(/LLDP transmit off on Fa0\/2: the port is no longer announcing itself/, out,
    'the port stops announcing');
  match(/this model keeps no timers, so it stays/, out,
    'and the command says the peer will keep its entry, because nothing ages here');
  eq(env.a.interfaces.get('Fa0/2').lldpTx, false, 'the port records the decision');
  // A neighbour already learned on that port is what the peer keeps; the local table is unaffected.
  ok(env.a.lldp.has('Fa0/2'), 'this device still hears its neighbour on that port');
  match(/LLDP transmit on Fa0\/2 re-enabled/, env.cfg(env.s1, ['interface Fa0/2', 'lldp transmit']),
    'and it can be put back');
}

console.log('\nThe words that make no sense are refused, and `?` offers the rest:');
{
  const env = lab();
  match(/% Unexpected argument "extra" - no lldp run takes no more/,
    env.cfg(env.s1, ['no lldp run extra']), 'a trailing word after `no lldp run` is refused');
  match(/% Unexpected argument "extra" - no lldp transmit takes no more/,
    env.cfg(env.s1, ['interface Fa0/1', 'no lldp transmit extra']),
    'and after `no lldp transmit`');
  env.s1.run('configure terminal');
  for (const q of ['lldp ?', 'no lldp ?']) {
    const rows = env.s1.run(q).output;
    ok(rewritesAnswer(rows), '`' + q + '` answers in config mode');
  }
  env.s1.run('interface Fa0/1');
  for (const q of ['lldp ?', 'no lldp ?']) {
    ok(rewritesAnswer(env.s1.run(q).output), '`' + q + '` answers in interface mode');
  }
  env.s1.run('end');
  function rewritesAnswer(rows) {
    return !rows.some(function (l) { return /% No completions/.test(l); });
  }
}

console.log('\nThe decision survives a dump and a paste:');
{
  const env = lab();
  env.cfg(env.s1, ['interface Fa0/1', 'no lldp receive', 'interface Fa0/2', 'no lldp transmit']);
  env.cfg(env.s2, ['no lldp run']);
  const dump1 = env.s1.run('show running-config').output;
  match(/no lldp receive/, dump1, 'the per-port line is in the dump');
  match(/no lldp transmit/, dump1, 'both directions are');
  // A port nobody told anything contributes no line.
  const block = (dump1.join('\n').split('interface Fa0/3')[1] || '').split(/^interface /m)[0];
  ok(!/lldp/.test(block), 'a port left alone contributes no lldp line');
  match(/no lldp run/, env.s2.run('show running-config').output, 'the global off state is in the dump');
  // Paste both dumps into twins and check the decisions land.
  for (const [src, name] of [[env.s1, 'SW1'], [env.s2, 'SW2']]) {
    const lines = src.run('show running-config').output;
    const t2 = new Topology();
    const twin = t2.addDevice(SWITCH);
    const s = new CliSession(twin, t2, new Simulator(t2));
    s.run('enable'); s.run('configure terminal');
    for (const line of lines.slice(1)) {
      // Ordinary control flow: the banner and the terminator are not commands to paste.
      if (/^!/.test(line) || /^end$/.test(line)) continue;
      s.run(line);
    }
    s.run('end');
    if (name === 'SW1') {
      eq(twin.interfaces.get('Fa0/1').lldpRx, false, 'the receive decision survives a paste');
      eq(twin.interfaces.get('Fa0/2').lldpTx, false, 'and so does the transmit decision');
      eq(twin.interfaces.get('Fa0/3').lldpRx, undefined, 'while an untouched port stays untouched');
    } else {
      eq(twin.config.lldp && twin.config.lldp.run, false, 'the global off state survives a paste');
    }
  }
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
