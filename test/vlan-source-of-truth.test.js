'use strict';
// vlan-source-of-truth.test.js - one source of truth for whether a VLAN exists.
//
//   SW1(config-if)#switchport trunk native vlan 99
//   Trunk native VLAN 99 on Fa0/8
//   SW1#show vlan
//   99    VLAN0099  active  Fa0/8(n)
//   SW1#show running-config
//     switchport trunk native vlan 99      <- and no `vlan 99` anywhere
//
// The access and voice forms were made to declare the VLAN they name; the other two carriers were
// not, so a native VLAN or an SVI still appeared in the table while the configuration had no such
// VLAN. Same defect, two more doors. And the table printed VLAN 1 twice for a switch whose trunk
// allows every VLAN - the `all` bucket rendered as a row numbered 1 named `default`.
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

console.log('A native VLAN declares the VLAN it names:');
{
  const env = lab();
  const out = text(env.s.run('configure terminal', 'interface Fa0/8', 'switchport mode trunk',
    'switchport trunk native vlan 99'));
  ok(/Trunk native VLAN 99 on Fa0\/8/.test(out), 'the native VLAN is set');
  ok(/VLAN 99 did not exist and was created/.test(out), 'and the line says it created the VLAN');
  ok((env.sw.config.vlans || {})[99] !== undefined, 'the configuration has the VLAN');
  const run = text(env.s.run('end', 'show running-config'));
  ok(/^vlan 99( VLAN0099)?$/m.test(run), 'show running-config carries it');
  ok(/^99\s+VLAN0099\s+active/m.test(text(env.s.run('show vlan'))), 'and the table lists it by name');
}

console.log('\nAn SVI declares its VLAN too:');
{
  const env = lab();
  const out = text(env.s.run('configure terminal', 'interface vlan 42'));
  ok(/Vlan42 created/.test(out), 'the SVI is created');
  ok(/VLAN 42 did not exist and was created/.test(out), 'and the VLAN with it, in the same line');
  ok((env.sw.config.vlans || {})[42] !== undefined, 'the VLAN is in the configuration');
  env.s.run('ip address 10.0.42.1 255.255.255.0', 'end');
  const run = text(env.s.run('show running-config'));
  ok(/^vlan 42( VLAN0042)?$/m.test(run), 'the dump has the VLAN block');
  ok(/interface Vlan42/.test(run), 'and the interface');
}

console.log('\nVLAN 1 is never declared, and never printed twice:');
{
  const env = lab();
  env.s.run('configure terminal', 'interface Fa0/8', 'switchport mode trunk',
    'switchport trunk allowed vlan all', 'end');
  const table = text(env.s.run('show vlan'));
  const ones = table.split('\n').filter(function (l) { return /^1\s/.test(l); });
  ok(ones.length === 1, 'VLAN 1 is one row, not two (' + ones.length + ')');
  ok(!/^1\s+default\s/m.test(table), 'and the synthetic `default` row is gone');
  ok(/Fa0\/8 allows every VLAN on its trunk/.test(table),
    'the all-VLAN trunk is stated below the table instead');
  const run = text(env.s.run('show running-config'));
  ok(!/^vlan 1( |$)/m.test(run), 'no VLAN 1 stanza is written');
}

console.log('\nThe carriers agree with each other and with the dump:');
{
  const env = lab();
  env.s.run('configure terminal', 'interface Fa0/1', 'switchport access vlan 10',
    'exit', 'interface Fa0/2', 'switchport access vlan 10', 'switchport voice vlan 20',
    'exit', 'interface Fa0/8', 'switchport mode trunk', 'switchport trunk native vlan 30',
    'exit', 'interface vlan 40', 'ip address 10.0.40.1 255.255.255.0', 'exit', 'end');
  const declared = Object.keys(env.sw.config.vlans || {}).map(Number).sort(function (a, b) { return a - b; });
  ok(JSON.stringify(declared) === JSON.stringify([10, 20, 30, 40]),
    'every VLAN a carrier named is declared (got ' + declared.join(',') + ')');
  const table = text(env.s.run('show vlan'));
  for (const id of [10, 20, 30, 40]) {
    ok(new RegExp('^' + id + '\\s').test(table.split('\n').filter(function (l) { return new RegExp('^' + id + '\\s').test(l); })[0] || ''),
      'VLAN ' + id + ' has a row');
  }
  ok(!/allowed on a trunk but not configured/.test(table),
    'and nothing is reported as allowed-but-missing, because every allowed VLAN exists');
}

console.log('\nA saved copy round-trips without inventing or losing VLANs:');
{
  const env = lab();
  env.s.run('configure terminal', 'interface Fa0/1', 'switchport access vlan 10',
    'exit', 'interface vlan 40', 'ip address 10.0.40.1 255.255.255.0', 'exit', 'end');
  env.s.run('write memory');
  const before = text(env.s.run('show vlan'));
  const copy = text(env.s.run('copy startup-config running-config'));
  ok(/did not change|already in force/.test(copy), 'the copy changes nothing (got: ' + copy.split('\n')[0] + ')');
  ok(text(env.s.run('show vlan')) === before, 'and the VLAN table is identical afterwards');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
