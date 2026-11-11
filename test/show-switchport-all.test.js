'use strict';
// show-switchport-all.test.js - the whole switch's L2 state in one answer.
//
//   SW1#show interfaces switchport
//   % "show interfaces switchport" is not a command here
//   % A port's L2 state is split across three tables: ...
//
// The per-port block existed (`show interfaces <port> switchport`) and the family form did not, so
// reading a 24-port switch meant twenty-four commands or a script - for a table the console could
// print in one go from the records it already had.
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
  const r = t.addDevice(find('generic-router')); r.name = 'R1';
  const sr = new CliSession(r, t, sim); sr.run('enable');
  s.run('configure terminal', 'vlan 10',
    'interface Fa0/1', 'switchport access vlan 10', 'description desk port', 'no shutdown', 'exit',
    'interface Fa0/2', 'switchport mode trunk', 'switchport trunk allowed vlan 10', 'no shutdown', 'exit', 'end');
  return { t: t, sim: sim, sw: sw, s: s, r: r, sr: sr };
}

console.log('Every physical port gets its block:');
{
  const env = lab();
  const out = text(env.s.run('show interfaces switchport'));
  ok(!/is not a command here/.test(out), 'the family form is a command');
  ok(!/^%/m.test(out), 'and answers without a refusal');
  const phys = Array.from(env.sw.interfaces.values()).filter(function (i) { return !i.svi && !i.parent; });
  const names = (out.match(/^Name: (\S+)$/gm) || []).map(function (l) { return l.replace('Name: ', ''); });
  ok(names.length === phys.length, 'one block per physical port (' + names.length + ' of ' + phys.length + ')');
  ok(names.indexOf('Fa0/1') !== -1 && names.indexOf('Fa0/2') !== -1, 'the configured ports are among them');
  ok(/Access Mode VLAN: 10/.test(out), 'the access VLAN is shown');
  ok(/Trunking VLANs Enabled: 10/.test(out), 'and the trunk\'s allowed list');
  ok(/Description: desk port/.test(out), 'and the description, which the per-port view also carries');
}

console.log('\nThe block is the same one the per-port form prints:');
{
  const env = lab();
  const all = env.s.run('show interfaces switchport').output;
  const one = env.s.run('show interfaces switchport Fa0/1').output;
  const start = all.indexOf('Name: Fa0/1');
  const block = all.slice(start, start + one.length);
  ok(JSON.stringify(block) === JSON.stringify(one),
    'a port\'s block is identical whichever spelling asked for it');
  ok(!/Name: Fa0\/2/.test(one.join('\n')), 'and naming a port leaves the others out');
}

console.log('\nThe refusing half is still there:');
{
  const env = lab();
  const bad = text(env.s.run('show interfaces switchport zzzz'));
  ok(/No interface named zzzz/.test(bad), 'a port that does not exist is named as missing');
  ok(/show ip interface brief/.test(bad), 'and the refusal points at the port list');
  const extra = text(env.s.run('show interfaces switchport Fa0/1 zzzz'));
  ok(/takes one port at most/.test(extra), 'a second word is refused rather than dropped');
  env.s.run('configure terminal', 'interface vlan 10', 'ip address 10.0.10.1 255.255.255.0', 'exit', 'end');
  const svi = text(env.s.run('show interfaces switchport Vlan10'));
  ok(/is a logical interface/.test(svi), 'an SVI is named as a logical interface, not a switchport');
  const router = text(env.sr.run('show interfaces switchport'));
  ok(/does not switch/.test(router), 'a router says none of its ports has switchport state');
  ok(/subinterface/.test(router), 'and points at what carries a tag on a routed port');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
