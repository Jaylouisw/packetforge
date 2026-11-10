'use strict';
// switchport-args.test.js - the switchport verbs, one level below the VLAN verbs that were fixed last
// pass, and the same shape of defect was waiting there.
//
// Measured before this pass, on a `generic-switch`:
//   switchport access vlan abc      -> "Access VLAN NaN on Fa0/1"        (NaN, accepted)
//   switchport access vlan          -> "Access VLAN NaN on Fa0/1"        (a success message for a
//                                                                         missing argument)
//   switchport access vlan 9999     -> "% accessVlan 9999 is outside 1-4094"  (the field name)
//   switchport trunk native vlan abc-> "Trunk native VLAN NaN on Fa0/1"
//   switchport trunk allowed        -> "% Unrecognized switchport command: trunk allowed"  (one word
//                                      short, reported as if the words were wrong)
//   switchport                      -> "% Unrecognized switchport command: "  (empty command)
//   no switchport trunk allowed vlan 10
//                                   -> "Switchport reset to defaults on Fa0/1 (access VLAN 1)"
//                                      - a whole-port reset as the answer to a one-VLAN removal
//   switchport access vlan 10 on a ROUTER port, or on an SVI -> accepted and stored, so the console
//                                      confirmed a membership nothing would ever read
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
const SWITCH = catalog.find(function (s) { return s.model === 'generic-switch'; });
const ROUTER = catalog.find(function (s) { return s.model === 'generic-router'; });
const PC = catalog.find(function (s) { return s.model === 'generic-pc'; });

// The session stays in config mode for the whole block: re-entering `configure terminal` on a session
// that is already there is `% Unrecognized config command`, which is how the first draft of this file
// managed to assert nothing (every `output[0]` was that refusal).
function oneSwitch() {
  const t = new Topology();
  const sw = t.addDevice(SWITCH); sw.name = 'SW1';
  const sim = new Simulator(t);
  const c = new CliSession(sw, t, sim); c.run('enable'); c.run('configure terminal');
  return { t: t, sw: sw, sim: sim, c: c };
}
// Stand at Fa0/1 (or the named port) and run the commands there.
//
// `CliSession.run()` takes ONE line: the extra arguments of `run('a', 'b')` are ignored, so the first
// draft of this file configured nothing and asserted against the output of its own mistake. Every
// multi-command sequence here is a loop for that reason.
const at = function (l, cmds, port) {
  // Only the last command's output: the `interface` line itself prints nothing here, but on an SVI it
  // prints "created", and returning every line would make `out[0]` the wrong command's answer.
  l.c.run('interface ' + (port || 'Fa0/1'));
  let out = [];
  for (const cmd of cmds) out = l.c.run(cmd).output;
  return out;
};
const sfp = function (l, cmds, port) { return at(l, cmds, port); };
const resetMode = function (l) { l.c.run('exit'); };

console.log('\nA VLAN id is a number in a range, in every switchport spelling:');
{
  const l = oneSwitch();
  const cases = [
    [['switchport access vlan abc'], '% VLAN id must be a number, not "abc"'],
    [['switchport access vlan'], '% Incomplete command: switchport access vlan <id>'],
    [['switchport access vlan 0'], '% VLAN 0 is outside 1-4094'],
    [['switchport access vlan 4095'], '% VLAN 4095 is outside 1-4094'],
    [['switchport access vlan 9999'], '% VLAN 9999 is outside 1-4094'],
    [['switchport trunk native vlan abc'], '% VLAN id must be a number, not "abc"'],
    [['switchport trunk native vlan'], '% Incomplete command: switchport trunk native vlan <id>'],
    [['switchport trunk native vlan 9999'], '% VLAN 9999 is outside 1-4094']
  ];
  for (const [cmds, want] of cases) {
    const out = sfp(l, cmds);
    eq(out[0], want, cmds[0] + ' is refused');
    resetMode(l);
  }
  ok(!l.c.run('do show running-config').output.join('\n').includes('NaN'),
    'and no NaN reaches the configuration');
  eq(sfp(l, ['switchport access vlan 10 20'])[0],
    '% Unexpected argument "20" - switchport access vlan <id> takes no more',
    'a second id is refused rather than silently replacing the first');
  eq(sfp(l, ['switchport mode trunk access'])[0],
    '% Unexpected argument "access" - switchport mode access|trunk takes no more',
    'and a word after the mode is refused too');
  resetMode(l);
}

console.log('\nStopping one word short is not the same as typing nonsense:');
{
  const l = oneSwitch();
  eq(sfp(l, ['switchport trunk allowed'])[0],
    '% Incomplete command: switchport trunk allowed vlan <list|all>',
    'switchport trunk allowed names the word that is missing');
  eq(sfp(l, ['switchport trunk allowed vlan'])[0],
    '% Incomplete command: switchport trunk allowed vlan <list|all>',
    'and so does the next word down, in the same words');
  const bare = sfp(l, ['switchport']);
  void bare;
  eq(bare[0], '% Incomplete command: switchport mode access|trunk', 'bare switchport is incomplete');
  ok(/Also: switchport access vlan <id>/.test(bare[1]), 'and lists the forms it does take');
  eq(sfp(l, ['switchport bogus 1'])[0], '% Unrecognized switchport command: bogus 1',
    'while a wrong word is still a wrong word');
  resetMode(l);
}

console.log('\nA no-form is as narrow as the command it undoes:');
{
  const l = oneSwitch();
  sfp(l, ['switchport mode trunk', 'switchport trunk native vlan 99',
    'switchport trunk allowed vlan 10,20,30']);
  const removed = sfp(l, ['no switchport trunk allowed vlan 10']);
  eq(removed[0], 'Trunk on Fa0/1: removed 10, still allows 20,30',
    'no switchport trunk allowed vlan 10 removes one VLAN and says what is left');
  // The defect this replaces was a full reset, so assert the parts a reset would have destroyed.
  const cfg = l.c.run('do show running-config').output.join('\n');
  ok(/switchport mode trunk/.test(cfg), 'the port is still a trunk (a reset would have made it access)');
  ok(/switchport trunk native vlan 99/.test(cfg), 'its native VLAN survived (a reset would have set 1)');
  ok(/switchport trunk allowed vlan 20,30/.test(cfg), 'and the list is 20,30 in running-config');

  eq(sfp(l, ['no switchport trunk allowed vlan 99'])[0],
    '% VLAN 99 is not in the allowed list on Fa0/1 (it allows 20,30)',
    'removing a VLAN that is not in the list is refused and names the list');
  eq(sfp(l, ['no switchport trunk allowed vlan 20,30'])[0],
    'Trunk on Fa0/1: removed 20,30 - the list is now empty',
    'removing the rest empties the list rather than resetting the port');
  eq(sfp(l, ['no switchport trunk allowed vlan'])[0],
    'Trunk on Fa0/1 allows all VLANs (no explicit list)',
    'with no list, the no-form means "all again"');
  eq(sfp(l, ['no switchport trunk allowed vlan 5'])[0],
    '% The trunk on Fa0/1 allows all VLANs - there is no list to remove 5 from',
    'and then a removal from "all" is refused, because the model cannot say "all but 5"');
  resetMode(l);
}

console.log('\nThe other no-forms touch only what they name:');
{
  const l = oneSwitch();
  sfp(l, ['switchport mode trunk', 'switchport trunk native vlan 99']);
  eq(sfp(l, ['no switchport mode'])[0],
    'Switchport mode access on Fa0/1 (the default) - access VLAN 1 is unchanged',
    'no switchport mode returns to access and says the access VLAN is untouched');
  resetMode(l);
  const l2 = oneSwitch();
  sfp(l2, ['switchport access vlan 30']);
  eq(sfp(l2, ['no switchport access vlan'])[0],
    'Access VLAN 1 on Fa0/1 (the default, was VLAN 30)',
    'no switchport access vlan reports what it replaced');
  resetMode(l2);
  const l3 = oneSwitch();
  sfp(l3, ['switchport mode trunk', 'switchport trunk native vlan 99']);
  eq(sfp(l3, ['no switchport trunk native vlan'])[0],
    'Trunk native VLAN 1 on Fa0/1 (the default, was VLAN 99)',
    'no switchport trunk native vlan reports what it replaced, and the mode stays trunk');
  ok(/switchport mode trunk/.test(l3.c.run('do show running-config').output.join('\n')),
    'the port is still a trunk afterwards');
  resetMode(l3);
  const l4 = oneSwitch();
  sfp(l4, ['switchport mode trunk', 'switchport access vlan 30']);
  eq(sfp(l4, ['no switchport'])[0], 'Switchport reset to defaults on Fa0/1 (access VLAN 1)',
    'bare no switchport is still the full reset');
  resetMode(l4);
  ok(!/switchport/.test(l4.c.run('do show running-config').output.join('\n')),
    'and the port has no switchport lines left');
}

console.log('\nA port that cannot be a switchport says so, instead of storing the setting:');
{
  const t = new Topology();
  const r = t.addDevice(ROUTER); r.name = 'R1';
  const c = new CliSession(r, t, new Simulator(t));
  c.run('enable'); c.run('configure terminal');
  const out = at({ c: c }, ['switchport access vlan 10'], 'Gi0/0');
  eq(out[0], '% R1 does not switch - it has no switchports',
    'a router port is refused by name');
  ok(/put the address on the port/.test(out[1]), 'and the refusal names what to do instead');
  c.run('exit'); c.run('end');
  ok(!/switchport/.test(c.run('show running-config').output.join('\n')),
    'so nothing is stored for it');

  const l = oneSwitch();
  l.c.run('vlan 10');
  const svi = at(l, ['switchport access vlan 10'], 'vlan 10');
  eq(svi[0], '% Vlan10 is a logical interface - it is not a switchport',
    'an SVI is refused as a logical interface');
  ok(/An SVI is the VLAN's own address/.test(svi[1]), 'and the refusal says what an SVI is for');
  l.c.run('exit');
  ok(!/Vlan10\n\s+switchport/.test(l.c.run('do show running-config').output.join('\n')),
    'and running-config still emits no switchport line for it');
}

console.log('\nThe narrow removal changes the data path - and only where it says it does:');
{
  // Two switches joined by a trunk, a VLAN 10 pair and a VLAN 20 pair. Removing VLAN 10 from the
  // trunk must kill the VLAN 10 ping and leave the VLAN 20 ping alone. The old behaviour (a full
  // port reset) would have killed both, which is what makes this assertion non-vacuous.
  const t = new Topology();
  const sw1 = t.addDevice(SWITCH); sw1.name = 'SW1';
  const sw2 = t.addDevice(SWITCH); sw2.name = 'SW2';
  const host = function (name, addr, port, sw) {
    const pc = t.addDevice(PC); pc.name = name;
    t.connect(pc.id, 'eth0', sw.id, port);
    return { pc: pc, addr: addr };
  };
  const a10 = host('PC1', '10.0.10.1', 'Fa0/1', sw1);
  const a20 = host('PC2', '10.0.20.1', 'Fa0/2', sw1);
  const b10 = host('PC3', '10.0.10.2', 'Fa0/1', sw2);
  const b20 = host('PC4', '10.0.20.2', 'Fa0/2', sw2);
  t.connect(sw1.id, 'Fa0/8', sw2.id, 'Fa0/8');
  const sim = new Simulator(t);
  // One session per device, commands in order: `CliSession.run()` runs a single line, so a sequence
  // built by re-entering a fresh session per command configures nothing.
  const cfg = function (sw, cmds) {
    const s = new CliSession(sw, t, sim);
    s.run('enable'); s.run('configure terminal');
    for (const cmd of cmds) s.run(cmd);
    return s;
  };
  for (const [h, sw, port, vlan] of [[a10, sw1, 'Fa0/1', 10], [a20, sw1, 'Fa0/2', 20],
    [b10, sw2, 'Fa0/1', 10], [b20, sw2, 'Fa0/2', 20]]) {
    const ps = new CliSession(h.pc, t, sim);
    for (const cmd of ['enable', 'configure terminal', 'interface eth0',
      'ip address ' + h.addr + ' 255.255.255.0', 'end']) ps.run(cmd);
    cfg(sw, ['interface ' + port, 'switchport mode access',
      'switchport access vlan ' + vlan, 'exit']);
  }
  for (const sw of [sw1, sw2]) {
    cfg(sw, ['interface Fa0/8', 'switchport mode trunk',
      'switchport trunk allowed vlan 10,20', 'exit']);
  }
  const rate = function (pc, dst) {
    const h = new CliSession(pc, t, sim); h.run('enable');
    const m = /Success rate is (\d+) percent/.exec(
      h.run('ping ' + dst + ' count 1').output.join(' '));
    return m ? Number(m[1]) : null;
  };
  eq(rate(a10.pc, '10.0.10.2'), 100, 'VLAN 10 crosses the trunk before the removal');
  eq(rate(a20.pc, '10.0.20.2'), 100, 'and so does VLAN 20');

  const s1 = new CliSession(sw1, t, sim); s1.run('enable'); s1.run('configure terminal');
  const out = at({ c: s1 }, ['no switchport trunk allowed vlan 10'], 'Fa0/8');
  eq(out[0], 'Trunk on Fa0/8: removed 10, still allows 20',
    'the command answers with the port it changed and the list that is left');
  s1.run('exit', 'end');
  eq(rate(a10.pc, '10.0.10.2'), 0, 'after removing VLAN 10 from the trunk, VLAN 10 stops crossing');
  eq(rate(a20.pc, '10.0.20.2'), 100,
    'and VLAN 20 still crosses - a reset would have taken this away too');
  ok(/switchport mode trunk/.test(s1.run('show running-config').output.join('\n')),
    'the trunk is still a trunk, which is why VLAN 20 survives');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
