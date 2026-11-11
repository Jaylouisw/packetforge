'use strict';
// access-vlan-creation.test.js - a VLAN a port names has to exist in the configuration.
//
//   SW1(config-if)#switchport access vlan 99
//   Access VLAN 99 on Fa0/2
//   SW1#show vlan
//   VLAN  Name      Status  Ports
//   99    VLAN0099  active  Fa0/2
//   SW1#show running-config
//   interface Fa0/2
//     switchport access vlan 99          <- and no `vlan 99` anywhere
//
// The view described an active VLAN with a port in it, while the configuration had no such VLAN: two
// sources of truth for one object, and a saved copy that would lose it. IOS creates the VLAN when a
// port names it, and says so - the message is the only place the operator learns a VLAN now exists.
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

function lab() {
  const t = new Topology();
  const sw = t.addDevice(find('generic-switch')); sw.name = 'SW1';
  const sim = new Simulator(t);
  const s = new CliSession(sw, t, sim); s.run('enable');
  return { t: t, sim: sim, sw: sw, s: s };
}

console.log('A VLAN a port names is created, and the console says so:');
{
  const env = lab();
  const out = text(env.s.run('configure terminal', 'interface Fa0/2', 'switchport access vlan 99'));
  ok(/Access VLAN 99 on Fa0\/2/.test(out), 'the assignment is reported');
  ok(/did not exist and was created/.test(out), 'and says the VLAN was created by it');
  ok(/"no vlan 99" removes it/.test(out), 'and names the command that undoes it');
  const vlan = text(env.s.run('end', 'show vlan'));
  ok(/^99\s+VLAN0099\s+active/m.test(vlan), 'show vlan lists it with a name and its port');
  const run = text(env.s.run('show running-config'));
  // The model's own one-line spelling of a VLAN declaration, which the parser takes back.
  ok(/^vlan 99(\s+VLAN0099)?$/m.test(run), 'show running-config has the VLAN');
  ok(/^  switchport access vlan 99$/m.test(run), 'and the port assignment');
}

console.log('\nA VLAN that already exists is not created again:');
{
  const env = lab();
  env.s.run('configure terminal', 'vlan 99 name voice', 'interface Fa0/2');
  const out = text(env.s.run('switchport access vlan 99'));
  ok(/Access VLAN 99 on Fa0\/2/.test(out), 'the assignment is reported');
  ok(!/did not exist/.test(out), 'without claiming to have created anything');
  const vlan = text(env.s.run('end', 'show vlan'));
  ok(/^99\s+voice\s/m.test(vlan), 'and the name that was configured survives');
}

console.log('\nThe default VLAN never gets a stanza of its own:');
{
  const env = lab();
  env.s.run('configure terminal', 'interface Fa0/3', 'switchport access vlan 1', 'end');
  const run = text(env.s.run('show running-config'));
  ok(!/^vlan 1$/m.test(run), 'assigning VLAN 1 does not write a VLAN 1 block');
  ok(text(env.s.run('show vlan')).split('\n').some(function (l) { return /^1\s/.test(l); }),
    'and show vlan still lists it, because it always exists');
}

console.log('\nThe created VLAN cannot then be half-removed:');
{
  const env = lab();
  env.s.run('configure terminal', 'interface Fa0/2', 'switchport access vlan 99', 'exit', 'end');
  const del = text(env.s.run('configure terminal', 'no vlan 99'));
  ok(/Fa0\/2/.test(del), 'removing it names the port that carries it');
  ok(/^%/m.test(del), 'and it is refused rather than done silently');
  ok(/^99\s/m.test(text(env.s.run('end', 'show vlan'))), 'so the VLAN is still there');
}

console.log('\nAn allowed list does not create VLANs, and the trunk view says so:');
{
  const env = lab();
  env.s.run('configure terminal', 'interface Fa0/4', 'switchport mode trunk',
    'switchport trunk allowed vlan 77', 'no shutdown', 'end');
  const vlan = text(env.s.run('show vlan'));
  ok(!/^77\s/m.test(vlan), 'an allowed VLAN that does not exist is not invented');
  ok(/77 is allowed on a trunk but not configured/.test(vlan), 'and the table says where it went');
  ok(/switchport trunk allowed vlan remove/.test(vlan), 'and names the command that drops it');
  const trunk = text(env.s.run('show interfaces trunk'));
  ok(/77/.test(trunk), 'the trunk table still lists it as allowed');
  ok(/not-trunking|none/.test(trunk), 'and reports it as not active, which is the honest answer');
}

console.log('\nThe voice form follows the same rule:');
{
  const env = lab();
  const out = text(env.s.run('configure terminal', 'interface Fa0/5', 'switchport access vlan 10',
    'switchport voice vlan 20'));
  ok(/Voice VLAN 20 on Fa0\/5/.test(out), 'the voice assignment is reported');
  ok(/VLAN 20 did not exist and was created/.test(out), 'and the created VLAN is named');
  const vlan = text(env.s.run('end', 'show vlan'));
  ok(/^20\s+VLAN0020/m.test(vlan), 'so it appears in the VLAN table');
  ok(/^10\s+VLAN0010/m.test(vlan), 'alongside the access VLAN, which was created the same way');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
