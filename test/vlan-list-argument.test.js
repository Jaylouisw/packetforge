'use strict';
// The `vlan` argument is a LIST on a box, and this console answered a range as though IOS had no such grammar.
//
// The command reference says it in one sentence: "You can enter a single VLAN ID, a series of VLAN IDs separated
// by commas, or a range of VLAN IDs separated by hyphens" (Catalyst 9600, IOS XE 17.7, VLAN Commands, `vlan`),
// and the configuration guides write the syntax as `vlan vlan_ID {[-vlan_ID]|[,vlan_ID]}`. This console creates
// one VLAN per command, so the form is still refused - a list would create many, each with its own receipt, and
// `no vlan` would need the same list; that is a capability, not a fidelity fix. What it must not do is refuse a
// range by claiming a VLAN id cannot be a range: `% Invalid VLAN id "10-12": a VLAN id is a whole number from 1
// to 4094` is a sentence an operator can check against the vendor's own grammar and find false. The refusal now
// names the vendor's two spellings and the one-id-per-line form this console takes instead, and says that
// nothing was changed (research/vlan-list-argument.md).
const path = require('path');
const { Topology, Simulator, runCommands } = require('../engine');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}
const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
const spec = function (m) { return catalog.find(function (x) { return x.model === m; }); };
// A box that really switches frames: the VLAN doors are gated on the capability, and a refusal for the wrong
// reason would pass this suite without proving anything.
const SWITCH = 'EKI-7708G-4FI';

function cli(t, dev, cmds) {
  return runCommands(dev, t, null, ['enable', 'configure terminal'].concat(cmds)).lines
    .filter(function (l) {
      return !/\(config|>enable|#configure/.test(String(l)) &&
        !/^Enter configuration commands, one per line\./.test(String(l));
    });
}
function show(t, dev, cmd) {
  const s = new Simulator(t);
  s.setRunTime(60000);
  return runCommands(dev, t, s, ['enable', cmd]).lines.join('\n');
}
function lab() {
  const t = new Topology();
  const d = t.addDevice(spec(SWITCH), 'sw1');
  const port = Array.from(d.interfaces.values()).filter(function (p) { return p.type === 'ethernet'; })[0].name;
  return { t: t, d: d, port: port };
}
const LIST = /^% VLAN list "([^"]+)" is not modelled: a box takes a range \(10-12\) or a comma-separated list \(10,12\) on `vlan`, and this console takes one id per line - nothing was (changed|removed)$/;

console.log('`vlan <range>` is refused in words that name the box\'s grammar');
{
  const { t, d } = lab();
  const said = cli(t, d, ['vlan 10-12']);
  ok(said.length === 1, 'the answer is one line', JSON.stringify(said));
  ok(LIST.test(said[0]), 'the sentence names both of the vendor\'s spellings and the one-id-per-line form', said[0]);
  ok(/nothing was changed$/.test(said[0]), 'and says that nothing was changed', said[0]);
  ok(!/Invalid VLAN id/.test(said[0]), 'it no longer calls a range an invalid id', said[0]);
  ok(!/whole number/.test(said[0]), 'nor claims a VLAN id cannot be a range', said[0]);
  ok(!/outside 1-4094/.test(said[0]), 'nor reads 1-4094 as an id outside the range', said[0]);
  ok(Object.keys(d.config.vlans || {}).length === 0, 'no VLAN was created',
    JSON.stringify(Object.keys(d.config.vlans || {})));
  const table = show(t, d, 'show vlan brief');
  ok(!/^\s*(10|11|12)\s/m.test(table), 'and the table lists none of the ids the range named');
  ok(!/vlan 10-12/.test(show(t, d, 'show running-config')), 'and the saved config carries no list line');
}

console.log('');
console.log('the comma list is the same sentence, quoted back as typed');
{
  const { t, d } = lab();
  const said = cli(t, d, ['vlan 20,22']);
  ok(said.length === 1 && LIST.test(said[0]), 'a comma list is refused in the same words', said[0]);
  ok(/"20,22"/.test(said[0]), 'quoting the list that was typed', said[0]);
  ok(Object.keys(d.config.vlans || {}).length === 0, 'and creates nothing');
  const mixed = cli(t, d, ['vlan 10-12,20']);
  ok(mixed.length === 1 && /"10-12,20"/.test(mixed[0]), 'a range and a list together is quoted whole', mixed[0]);
  const wide = cli(t, d, ['vlan 1-4094']);
  ok(LIST.test(wide[0]), 'the widest range is refused as a list, not as an id out of range', wide[0]);
  ok(Object.keys(d.config.vlans || {}).length === 0, 'and still creates nothing');
}

console.log('');
console.log('`no vlan <range>` says nothing was removed, and removes nothing');
{
  const { t, d } = lab();
  ok(cli(t, d, ['vlan 10'])[0] === 'VLAN 10 created (name: VLAN0010)', 'a single id is still created');
  const said = cli(t, d, ['no vlan 10-12']);
  ok(said.length === 1 && LIST.test(said[0]), 'the range is refused in the same sentence', said[0]);
  ok(/nothing was removed$/.test(said[0]), 'with the verb the door owns', said[0]);
  ok(/^\s*10\s/m.test(show(t, d, 'show vlan brief')), 'VLAN 10 is still in the table');
  ok(!!(d.config.vlans && d.config.vlans[10]), 'and still in the VLAN database');
  ok(LIST.test(cli(t, d, ['no vlan 1-4094'])[0]), 'the wide range is refused the same way');
  ok(cli(t, d, ['no vlan 10'])[0] === 'VLAN 10 removed', 'and a single id still removes');
}

console.log('');
console.log('the advice on the refusal line is actionable');
{
  const { t, d } = lab();
  const said = cli(t, d, ['vlan 10-12', 'vlan 10', 'vlan 11', 'vlan 12']);
  ok(LIST.test(said[0]), 'the range is refused first');
  ok(said.slice(1).join(' | ') === 'VLAN 10 created (name: VLAN0010) | VLAN 11 created (name: VLAN0011) | ' +
    'VLAN 12 created (name: VLAN0012)', 'the three ids the advice asks for then create three VLANs',
    said.slice(1).join(' | '));
  const table = show(t, d, 'show vlan brief');
  ok(['10', '11', '12'].every(function (id) { return new RegExp('^\\s*' + id + '\\s', 'm').test(table); }),
    'and the table lists all three');
}

console.log('');
console.log('everything that is not a list keeps the refusal it had');
{
  const { t, d } = lab();
  const cases = [
    ['vlan -5', 'a negative number is a word here, not a range'],
    ['vlan 1.5', 'a fractional id is not a range'],
    ['vlan abc', 'a word is not a range'],
    ['vlan 10-', 'a dangling hyphen is not a range'],
    ['vlan 10,', 'a dangling comma is not a range']
  ];
  for (const pair of cases) {
    const said = cli(t, d, [pair[0]]);
    ok(said.length === 1 && /^% Invalid VLAN id "/.test(said[0]), pair[1], said[0]);
  }
  ok(cli(t, d, ['vlan 4095'])[0] === '% VLAN id 4095 is outside 1-4094', 'an out-of-range id is still an id');
  ok(cli(t, d, ['vlan'])[0] === '% Incomplete command: give a VLAN id (1-4094)', 'a missing id is still incomplete');
  ok(/VLAN id 1002 is reserved/.test(cli(t, d, ['vlan 1002'])[0]), 'the media default is still refused by name');
  ok(Object.keys(d.config.vlans || {}).length === 0, 'and none of the refusals created anything');
}

console.log('');
console.log('a port takes one VLAN, so its refusals are unchanged');
{
  const { t, d, port } = lab();
  const access = cli(t, d, ['interface ' + port, 'switchport access vlan 10-12']);
  ok(/^% Invalid VLAN id "10-12": an access VLAN is a whole number from 1 to 4094$/.test(access[0]),
    'an access VLAN really is one id, and says so', access[0]);
  const port2 = Array.from(d.interfaces.values()).filter(function (p) { return p.type === 'ethernet'; })[1].name;
  ok(/trunk native VLAN is a whole number/.test(cli(t, d, ['interface ' + port2, 'switchport trunk native vlan 10-12'])[0]),
    'so does the native VLAN');
  ok(/voice VLAN is a whole number from 1 to 4094 or "none"/.test(
    cli(t, d, ['interface ' + port2, 'switchport voice vlan 10-12'])[0]), 'and the voice VLAN');
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
