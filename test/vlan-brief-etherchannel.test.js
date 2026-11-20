'use strict';
// `show vlan brief` names an access EtherChannel by the bundle, and not by its members.
//
// A working two-member access bundle printed `Fa0/2, Fa0/3` in the VLAN's Ports cell: the cell named the
// cables a frame might cross instead of the interface the switch forwards on, while `show etherchannel summary`
// on the same box printed `1 Po1(SU) LACP Fa0/2(P) Fa0/3(P)`.
//
// The device's own output - an IOU switch, `Et0/0`-`Et0/1` in channel-group 1 (PAgP desirable), both members
// `switchport mode access` / `switchport access vlan 10`, read at https://lkjil1224.tistory.com/70:
//
//   SW1#show etherchannel summary
//   1      Po1(SU)         PAgP      Et0/0(P) Et0/1(P)
//   SW1#show vlan brief
//   VLAN Name                             Status    Ports
//   ---- -------------------------------- --------- -------------------------------
//   1    default                          active
//   10   VLAN0010                         active    Po1
//   1002 fddi-default                     act/unsup
//
// The VLAN 1 cell is empty, which is the second half of the rule: the members are not listed under the VLAN
// they were moved out of either. `research/show-vlan-brief-etherchannel.md` holds the evidence and the two
// NX-OS/Arista captures that agree.
//
// What must NOT change: a member that never negotiated forwards as an ordinary link, so it keeps its own name
// in the cell (the rule the MAC table applies to the same state), and a plain access port beside a bundle is
// still listed beside it.
const path = require('path');
const { Topology, Simulator, runCommands } = require('../engine');
const { CliSession } = require('../engine/cli');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices')).filter(function (s) { return !s.error; });
const SWITCH = catalog.filter(function (s) { return s.model === 'generic-switch'; })[0];

// s1 --(Fa0/2, Fa0/3 channel-group 1)-- s2, with `mode` typed on each end; `peer` false leaves s2 plain, so
// s1's members never negotiate. Fa0/1 is a plain access port in VLAN 10 on s1 in every lab.
function lab(mode, peer) {
  const t = new Topology();
  const s1 = t.addDevice(SWITCH, 's1');
  const s2 = t.addDevice(SWITCH, 's2');
  t.connect('s1', 'Fa0/2', 's2', 'Fa0/2');
  t.connect('s1', 'Fa0/3', 's2', 'Fa0/3');
  const sim = new Simulator(t);
  const bundle = ['configure terminal',
    'interface Fa0/2', 'switchport mode access', 'switchport access vlan 10',
    'channel-group 1 mode ' + mode,
    'interface Fa0/3', 'switchport mode access', 'switchport access vlan 10',
    'channel-group 1 mode ' + mode, 'end'];
  runCommands(s1, t, sim, bundle);
  if (peer !== false) runCommands(s2, t, sim, bundle);
  runCommands(s1, t, sim, ['configure terminal', 'interface Fa0/1',
    'switchport mode access', 'switchport access vlan 10', 'end']);
  return { t: t, sim: sim, s1: s1, s2: s2 };
}

function output(env, dev, command) {
  return ((new CliSession(dev, env.t, env.sim).run(command).output) || []).map(String);
}
// The Ports cell of one VLAN's row, with a continuation line joined back on.
function portsOf(lines, vlan) {
  const at = lines.findIndex(function (l) { return new RegExp('^' + vlan + '\\s').test(l); });
  if (at === -1) return null;
  const first = lines[at].slice(48);
  const next = lines[at + 1] || '';
  const cont = /^\s{48}\S/.test(next) ? ' ' + next.trim() : '';
  return (first + cont).trim();
}
function row(lines, vlan) {
  return lines.filter(function (l) { return new RegExp('^' + vlan + '\\s').test(l); })[0] || '';
}

console.log('');
console.log('A working access bundle is one port, named by the bundle:');
{
  const env = lab('active', true);
  const lines = output(env, env.s1, 'show vlan brief');
  ok(portsOf(lines, 10) === 'Fa0/1, Po1', 'VLAN 10 names the plain port and the bundle',
    JSON.stringify(portsOf(lines, 10)));
  ok(lines.join('\n').indexOf('Fa0/2') === -1, 'the member Fa0/2 is in no cell');
  ok(lines.join('\n').indexOf('Fa0/3') === -1, 'the member Fa0/3 is in no cell');
  const vlan1 = lines.slice(2).filter(function (l) { return /^(\s{48})?Fa0\/[4-8]/.test(l) || /^1\s/.test(l); });
  ok(!/Fa0\/2|Fa0\/3|Po1/.test(vlan1.join(' ')), 'the members are in no other VLAN either',
    JSON.stringify(vlan1));
  ok(output(env, env.s1, 'show etherchannel summary').join('\n').indexOf('Po1(SU)') !== -1,
    'the bundle it names is up');
  ok(output(env, env.s2, 'show vlan brief').filter(function (l) { return /Po1/.test(l); }).length === 1,
    "the far end's table names the same one bundle");
}

console.log('');
console.log('The full view\'s first table says the same thing:');
{
  const env = lab('on', true);
  const lines = output(env, env.s1, 'show vlan');
  ok(portsOf(lines, 10) === 'Fa0/1, Po1', '`show vlan` also names Po1, not the members',
    JSON.stringify(portsOf(lines, 10)));
  ok(lines.some(function (l) { return /^1\s+enet\s+100001/.test(l); }), 'and still prints its media table');
}

console.log('');
console.log('A member that never negotiated is still its own port:');
{
  const env = lab('active', false);
  const lines = output(env, env.s1, 'show vlan brief');
  ok(portsOf(lines, 10) === 'Fa0/1, Fa0/2, Fa0/3', 'the suspended members keep their own names',
    JSON.stringify(portsOf(lines, 10)));
  ok(lines.join('\n').indexOf('Po1') === -1, 'no bundle is named, because no member joined it');
}

console.log('');
console.log('A plain port beside the bundle is still listed, and the bundle after it:');
{
  const env = lab('active', true);
  const lines = output(env, env.s1, 'show vlan brief');
  // Fa0/1 is the plain member; the bundle name follows the physical ports.
  ok(/Fa0\/1,\s*Po1$/.test(portsOf(lines, 10) || ''),
    'the cell reads `Fa0/1, Po1` - physical ports, then the bundle', JSON.stringify(portsOf(lines, 10)));
  ok(row(lines, 10).indexOf('VLAN0010') !== -1, 'the VLAN keeps its generated name');
}

console.log('');
console.log('A bundle with one member is still the bundle:');
{
  const t = new Topology();
  const s1 = t.addDevice(SWITCH, 's1');
  const s2 = t.addDevice(SWITCH, 's2');
  t.connect('s1', 'Fa0/2', 's2', 'Fa0/2');
  const sim = new Simulator(t);
  const cfg = ['configure terminal', 'interface Fa0/2', 'switchport mode access',
    'switchport access vlan 10', 'channel-group 1 mode on', 'end'];
  runCommands(s1, t, sim, cfg); runCommands(s2, t, sim, cfg);
  const lines = output({ t: t, sim: sim }, s1, 'show vlan brief');
  ok(portsOf(lines, 10) === 'Po1', 'a one-member static bundle reads Po1', JSON.stringify(portsOf(lines, 10)));
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
