// The `vlan` line in `show running-config`: does it carry the name the box would have generated?
//
// Every VLAN a Cisco switch holds has a name, whether or not anyone typed one: `VLANxxxx` for any id and
// `default` for VLAN 1 ("VLAN name: VLANxxxx, where xxxx represents four numeric digits (including leading
// zeros) equal to the VLAN ID number" - Ethernet VLAN defaults). A running-configuration lists what was
// configured, not what a box fills in - that is why `show running-config all` is a different command - and
// Cisco's own transparent-mode capture proves the rule for this line: VLANs that were created and never
// named are listed as
//
//     vlan 1
//     vlan 20-21,50-51
//
// with no ` name` sub-line under them, in a stanza that does carry the sub-lines a box really holds
// (` tb-vlan1 1002`). research/running-config-vlan-default-name.md has the captures.
//
// This console printed `vlan 44 VLAN0044` for a VLAN nothing had named - the generated name written back
// into the file - which is a line no switch prints. The name is now printed only when it differs from the
// generated one, so a saved config is shorter and every fact left in it was typed by somebody.
//
// The placement of a name that WAS typed is still this console's own (`vlan 20 twenty` on one line, where a
// box prints `vlan 20` and then ` name twenty` one space in): `name` is a vlan sub-mode command, this console
// has no vlan sub-mode, and the one-line form is the form that can be pasted back. Nothing here asserts that
// placement - only which names appear at all.
'use strict';
const path = require('path');
const { Topology, Simulator } = require('../engine');
const { CliSession } = require('../engine/cli');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices')).filter(function (s) { return !s.error; });
const SWITCH = catalog.filter(function (s) { return s.model === 'C2960X-48FPS-L'; })[0] ||
  catalog.filter(function (s) { return s.model === 'generic-switch'; })[0];

function lab() {
  const t = new Topology();
  const d = t.addDevice(SWITCH, 'sw1');
  const s = new CliSession(d, t, new Simulator(t));
  s.run('enable');
  const run = function (cmds) {
    const out = [];
    for (const c of cmds) for (const l of (s.run(c).output || [])) out.push(String(l));
    return out;
  };
  const firstPort = Array.from(d.interfaces.keys()).filter(function (n) {
    return !/^(mgmt|console|aux)/i.test(n);
  })[0];
  return { t: t, d: d, s: s, run: run, p: firstPort };
}

function vlanLines(env) {
  return env.run(['show running-config']).filter(function (l) { return /^vlan [0-9]/.test(l); })
    .map(function (l) { return l.replace(/[ ]+$/, ''); });
}
function rowFor(env, id) {
  return env.run(['show vlan brief']).filter(function (l) { return new RegExp('^' + id + ' ').test(l); })[0];
}

console.log('');
console.log('A VLAN created with no name is written with its id alone:');
{
  const env = lab();
  env.run(['configure terminal', 'vlan 60', 'end']);
  const lines = vlanLines(env);
  ok(lines.length === 1 && lines[0] === 'vlan 60', 'the line is `vlan 60`, not `vlan 60 VLAN0060`',
    JSON.stringify(lines));
  ok(lines[0] === lines[0].trim(), 'and it carries no trailing space');
  ok(env.d.config.vlans[60] && env.d.config.vlans[60].name === 'VLAN0060',
    'the database still holds the generated name', JSON.stringify(env.d.config.vlans[60]));
  const row = rowFor(env, 60);
  ok(!!row && row.indexOf('VLAN0060') !== -1, 'and `show vlan brief` still prints it', row);
}

console.log('');
console.log('A VLAN made by a port assignment - nobody typed `vlan` at all - is the same line:');
{
  const env = lab();
  const out = env.run(['configure terminal', 'interface ' + env.p, 'switchport access vlan 44', 'end']);
  ok(out.indexOf('% Access VLAN does not exist. Creating vlan 44') !== -1,
    'the switch still announces that it made the VLAN', JSON.stringify(out));
  const lines = vlanLines(env);
  ok(lines.length === 1 && lines[0] === 'vlan 44', 'and the file says `vlan 44`', JSON.stringify(lines));
  const row = rowFor(env, 44);
  ok(!!row && row.indexOf('VLAN0044') !== -1, 'while the VLAN table still names it VLAN0044', row);
}

console.log('');
console.log('A name somebody typed is written, and the generated one is not:');
{
  const env = lab();
  env.run(['configure terminal', 'vlan 20 name twenty', 'vlan 21', 'vlan 22 name VLAN0022', 'end']);
  const lines = vlanLines(env);
  ok(lines.indexOf('vlan 20 twenty') !== -1, 'a typed name is printed beside the id', JSON.stringify(lines));
  ok(lines.indexOf('vlan 21') !== -1, 'an unnamed VLAN prints bare', JSON.stringify(lines));
  ok(lines.indexOf('vlan 22') !== -1,
    'a typed name equal to the generated one prints bare too: the box cannot tell them apart either',
    JSON.stringify(lines));
  ok(lines.length === 3 && lines[0] === 'vlan 20 twenty' && lines[1] === 'vlan 21' && lines[2] === 'vlan 22',
    'and the ids stay in numeric order', JSON.stringify(lines));
}

console.log('');
console.log('What the shorter line costs: nothing, when the file is pasted back:');
{
  const env = lab();
  env.run(['configure terminal', 'vlan 60', 'vlan 61 name sixtyone', 'end']);
  const cfg = env.run(['show running-config']).filter(function (l) { return l.trim(); });
  const t2 = new Topology();
  const d2 = t2.addDevice(SWITCH, 'sw1');
  const s2 = new CliSession(d2, t2, new Simulator(t2));
  s2.run('enable');
  s2.run('configure terminal');
  const back = [];
  for (const line of cfg.filter(function (l) { return !/^!/.test(l); })) {
    for (const l of (s2.run(line).output || [])) back.push(String(l));
  }
  ok(!back.filter(function (l) { return /^%/.test(l); }).length, 'the paste earns no complaint',
    JSON.stringify(back));
  ok(d2.config.vlans[60] && d2.config.vlans[60].name === 'VLAN0060',
    'the unnamed VLAN comes back with the name the box would have given it',
    JSON.stringify(d2.config.vlans));
  ok(d2.config.vlans[61] && d2.config.vlans[61].name === 'sixtyone',
    'and the named one with its own', JSON.stringify(d2.config.vlans));
  const s3 = new CliSession(d2, t2, new Simulator(t2));
  s3.run('enable');
  const pick = function (lines) {
    return lines.filter(function (l) { return /^6[01] /.test(l); });
  };
  const before = pick(env.run(['show vlan brief']));
  const after = pick((s3.run('show vlan brief').output || []).map(String));
  ok(JSON.stringify(before) === JSON.stringify(after), 'and the VLAN table is identical on both boxes',
    JSON.stringify({ before: before, after: after }));
}

console.log('');
console.log('VLAN 1 is the other generated name, and it is never written either:');
{
  const env = lab();
  env.run(['configure terminal', 'vlan 1', 'end']);
  ok(vlanLines(env).length === 0, 'asking for VLAN 1 leaves no `vlan 1 default` line behind',
    JSON.stringify(vlanLines(env)));
  env.d.config.vlans[1] = { name: 'default' };
  const lines = vlanLines(env);
  ok(lines.length === 1 && lines[0] === 'vlan 1', 'a VLAN 1 record prints as `vlan 1`, without `default`',
    JSON.stringify(lines));
}

console.log('');
console.log('A typed name is still replayed by this console own grammar:');
{
  const env = lab();
  env.run(['configure terminal', 'vlan 20 name twenty', 'end']);
  const line = vlanLines(env)[0];
  const r = env.run(['configure terminal', line]);
  ok(!r.filter(function (l) { return /^%/.test(l); }).length,
    '`' + line + '` is accepted when pasted, because it is the command that made it', JSON.stringify(r));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
