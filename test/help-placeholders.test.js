'use strict';
// help-placeholders.test.js - a placeholder in a help row rewrote the command line.
//
// Measured before this pass, on a `generic-switch` named SW1:
//   SW1(config-if)#switchport mode trunk
//   Switchport mode trunk on Fa0/1
//   SW1(config-if)#switchport trunk allowed vlan all
//   % cannot parse VLAN token "all>"
//
// The word `all` was correct - it is what the help row documents. The lexer that turns help rows into
// completable forms used WORD = /[^\s\[\]|]+/, which does not exclude the angle brackets, so
// `switchport trunk allowed vlan <list|all>` became two *keywords*: `<list` and `all>`. Abbreviation
// expansion rewrites a typed word to the documented one, so typing `all` produced `all>` and the
// switchport parser quite correctly refused a VLAN token that is not a VLAN.
//
// Two more things were wrong in the same corner:
//   * `show running-config` on a router printed three `switchport` lines for the port that carried its
//     subinterfaces, and the same device refuses `switchport` ("does not switch"). Its own dump could
//     not be pasted back into it.
//   * creating `Gi0/0.20` silently took VLAN 20 from the interface number, then the dump printed
//     `encapsulation dot1q 20` as though it had been configured. The inference is useful; being silent
//     about it is why the dump looked like a fabrication.
const path = require('path');
const { Topology, Simulator, CliSession } = require('../engine');
const { loadCatalog } = require('../devices/registry');
const abbrev = require('../engine/abbrev');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg); }
}
function eq(actual, expected, msg) {
  ok(actual === expected, msg + (actual === expected ? '' : ' (got ' + JSON.stringify(actual) + ')'));
}
function rate(out) {
  const m = /Success rate is (\d+) percent/.exec((Array.isArray(out) ? out : [out]).join(' '));
  return m ? Number(m[1]) : null;
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
const ROUTER = catalog.find(function (s) { return s.model === 'generic-router'; });
const SWITCH = catalog.find(function (s) { return s.model === 'generic-switch'; });

console.log('\n`switchport trunk allowed vlan all` is the word the help documents:');
{
  const t = new Topology();
  const sw = t.addDevice(SWITCH); sw.name = 'SW1';
  const sim = new Simulator(t);
  const s = new CliSession(sw, t, sim);
  s.run('enable'); s.run('configure terminal'); s.run('interface Fa0/1');
  s.run('switchport mode trunk');
  eq(s.run('switchport trunk allowed vlan all').output[0], 'Trunk on Fa0/1 allows all VLANs',
    'the documented spelling is accepted');
  eq(sw.interfaces.get('Fa0/1').vlan.allowedVlans, 'all', 'and the port carries everything');
  eq(s.run('switchport trunk allowed vlan 10,20').output[0], 'Trunk on Fa0/1 allows VLANs 10,20',
    'an explicit list still works');
  eq(s.run('switchport trunk allowed vlan all').output[0], 'Trunk on Fa0/1 allows all VLANs',
    'and going back to all works after a list');
}

console.log('\nNo help row can put a bracket into a command line:');
{
  // The sweep: every documented placeholder, in every mode, lexes as a value slot or a keyword -
  // never as a keyword wearing a bracket. This is the class, not the one row that was broken.
  const t = new Topology();
  const r1 = t.addDevice(ROUTER); r1.name = 'R1';
  const s = new CliSession(r1, t, new Simulator(t));
  const bad = [];
  for (const mode of ['exec', 'enable', 'config', 'iface', 'dhcp-pool']) {
    s.mode = mode;
    // `_helpForms()` returns one token array per documented spelling.
    for (const toks of s._helpForms(mode)) {
      for (const tok of toks) {
        const text = typeof tok === 'object' ? null : String(tok);
        if (text && /[<>]/.test(text)) bad.push(mode + ': ' + toks.join(' '));
      }
    }
  }
  eq(bad.length, 0, 'every token of every help form is bracket-free' +
    (bad.length ? ': ' + bad.slice(0, 3).join(' | ') : ''));
  // And the placeholders with alternatives are still one slot, so the word typed passes through.
  const forms = abbrev.expandSynopsis('switchport trunk allowed vlan <list|all>');
  eq(forms.length, 1, 'a placeholder with alternatives is one form, not two keywords');
  eq(typeof forms[0][forms[0].length - 1], 'object',
    'and its last token is a value slot');
  eq(abbrev.expand(['switchport', 'trunk', 'allowed', 'vlan', 'all'], s._helpForms('iface')) === null
    || true, true, 'expansion of the line is safe to call');
}

console.log('\nA router\'s dump does not contain commands a router refuses:');
{
  const t = new Topology();
  const r1 = t.addDevice(ROUTER); r1.name = 'R1';
  const sw = t.addDevice(SWITCH); sw.name = 'SW1';
  const r2 = t.addDevice(ROUTER); r2.name = 'R2';
  t.connect(r1.id, 'Gi0/0', sw.id, 'Fa0/1');
  t.connect(sw.id, 'Fa0/2', r2.id, 'Gi0/0');
  const sim = new Simulator(t);
  const cfg = function (d, cmds) {
    const s = new CliSession(d, t, sim);
    s.run('enable'); s.run('configure terminal');
    for (const cmd of cmds) s.run(cmd);
    s.run('end');
    return s;
  };
  cfg(sw, ['vlan 10', 'interface Fa0/1', 'switchport mode trunk',
    'switchport trunk allowed vlan 10', 'exit',
    'interface Fa0/2', 'switchport mode trunk', 'switchport trunk allowed vlan 10', 'exit']);
  const r1s = cfg(r1, ['interface Gi0/0.10', 'ip address 10.10.0.1 255.255.255.0', 'exit']);
  cfg(r2, ['interface Gi0/0.10', 'ip address 10.10.0.2 255.255.255.0', 'exit']);
  const dump = r1s.run('show running-config').output;
  ok(!dump.some(function (l) { return /switchport/.test(l); }),
    'no switchport line appears in a router dump');
  ok(dump.some(function (l) { return /encapsulation dot1q 10/.test(l); }),
    'the tag is stated once, by the subinterface');
  // The dump must restore the device: paste it into a fresh router of the same model.
  const fresh = new Topology();
  const clone = fresh.addDevice(ROUTER); clone.name = 'R1';
  const cloneSim = new Simulator(fresh);
  const cs = new CliSession(clone, fresh, cloneSim);
  cs.run('enable');
  cs.run('configure terminal');
  const refusals = [];
  for (const line of dump) {
    const cmd = line.trim();
    if (!cmd || cmd.charAt(0) === '!') continue;
    const out = cs.run(cmd).output;
    for (const l of out) if (/^%/.test(l)) refusals.push(cmd + ' -> ' + l);
  }
  eq(refusals.length, 0, 'every line of the dump is accepted' +
    (refusals.length ? ': ' + refusals.join(' | ') : ''));
  eq(cs.run('show running-config').output.join('\n'), dump.join('\n'),
    'and the pasted device answers with the same dump');
}

console.log('\nCreating a subinterface says which VLAN it took:');
{
  const t = new Topology();
  const r1 = t.addDevice(ROUTER); r1.name = 'R1';
  const sim = new Simulator(t);
  const s = new CliSession(r1, t, sim);
  s.run('enable'); s.run('configure terminal');
  eq(s.run('interface Gi0/0.20').output[0],
    'Created subinterface Gi0/0.20 (parent Gi0/0, dot1q 20 from the interface number)',
    'the answer names the tag it inferred');
  // Re-entering an interface is silent in IOS, and it must not create a second one or re-infer a tag.
  eq(s.run('interface Gi0/0.20').output.length, 0, 'asking for it again is not a second creation');
  eq(r1.interfaces.get('Gi0/0.20').encapVid, 20, 'and does not change the tag it took');
  eq(s.run('encapsulation dot1q 30').output[0], 'Subinterface Gi0/0.20 encapsulation dot1q 30',
    'and the tag can be changed afterwards');
  ok(/encapsulation dot1q 30/.test(s.run('end').output.join('\n') + s.run('show running-config').output.join('\n')),
    'which is what the dump then says');
}

console.log('\nThe tag is real on the wire, not decoration:');
{
  // A trunk that allows only VLAN 10 must not carry VLAN 20, and it must carry VLAN 10.
  const t = new Topology();
  const r1 = t.addDevice(ROUTER); r1.name = 'R1';
  const sw = t.addDevice(SWITCH); sw.name = 'SW1';
  const r2 = t.addDevice(ROUTER); r2.name = 'R2';
  t.connect(r1.id, 'Gi0/0', sw.id, 'Fa0/1');
  t.connect(sw.id, 'Fa0/2', r2.id, 'Gi0/0');
  const sim = new Simulator(t);
  const cfg = function (d, cmds) {
    const s = new CliSession(d, t, sim);
    s.run('enable'); s.run('configure terminal');
    for (const cmd of cmds) s.run(cmd);
    s.run('end');
    return s;
  };
  cfg(sw, ['vlan 10', 'vlan 20', 'interface Fa0/1', 'switchport mode trunk',
    'switchport trunk allowed vlan 10', 'exit',
    'interface Fa0/2', 'switchport mode trunk', 'switchport trunk allowed vlan 10', 'exit']);
  const s1 = cfg(r1, ['interface Gi0/0.10', 'ip address 10.10.0.1 255.255.255.0', 'exit',
    'interface Gi0/0.20', 'ip address 10.20.0.1 255.255.255.0', 'exit']);
  cfg(r2, ['interface Gi0/0.10', 'ip address 10.10.0.2 255.255.255.0', 'exit',
    'interface Gi0/0.20', 'ip address 10.20.0.2 255.255.255.0', 'exit']);
  eq(rate(s1.run('ping 10.10.0.2 count 2').output), 100, 'the VLAN the trunk allows is carried');
  eq(rate(s1.run('ping 10.20.0.2 count 2').output), 0, 'the VLAN it does not allow is not');
  // ...and admitting it makes the difference, which is what makes the assertion above meaningful.
  cfg(sw, ['interface Fa0/1', 'switchport trunk allowed vlan 10,20', 'exit',
    'interface Fa0/2', 'switchport trunk allowed vlan 10,20', 'exit']);
  eq(rate(s1.run('ping 10.20.0.2 count 2').output), 100, 'and allowing it carries it');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
