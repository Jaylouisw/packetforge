'use strict';
// Does a run of two consecutive VLAN ids print as a range, or as two ids?
//
// `switchport trunk allowed vlan` is stored as a set and printed back folded, and the fold's threshold is the
// one thing this file is about. This model folded *every* run, so a backup carried
//
//   switchport trunk allowed vlan 59,157-158,160
//
// where the switch that was configured the same way prints
//
//   switchport trunk allowed vlan 59,157,158,160
//
// Three `show running-config` captures settle it, and all three spell a pair out:
//
//   interface GigabitEthernet2/1                    interface FastEthernet2/0/39
//    switchport trunk native vlan 999                switchport access vlan 160
//    switchport trunk allowed vlan 1,81,82,171,999   switchport trunk encapsulation dot1q
//    ...                                             switchport trunk native vlan 160
//                                                    switchport trunk allowed vlan 59,157,158,160
//                                                    switchport mode trunk
//                                                    switchport voice vlan 155
//
//   (Cisco support doc 68100, `w-backbone-6k#show running-config interface gigabitethernet 2/1`;
//    `MEXSWP04-NAP#sh run int fa2/0/39`, a Catalyst 3750 stack - research/trunk-allowed-two-id-run.md)
//
// and a third, `MEXSW09-NAP#sh run int gi1/0/3`, prints `55,56,59,155,157,158,160,200` - two pairs, both
// spelled out. Against that, the c3550 transcript of `remove 5-10,12` plus `add 7` prints `1-4,7,11,13-4094`:
// a run of four folds. So the rule is "a range only where it is strictly shorter than the list it replaces" -
// three ids - and `81-82` (five characters) is no shorter than `81,82`.
const path = require('path');
const vlanLib = require('../engine/vlan');
const { Topology, Simulator, runCommands } = require('../engine');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices')).filter(function (s) { return !s.error; });
const SWITCH = catalog.filter(function (s) { return s.model === 'generic-switch'; })[0];

function lab() {
  const t = new Topology();
  const d = t.addDevice(SWITCH, 'sw');
  const sim = new Simulator(t);
  return {
    t: t, d: d, sim: sim,
    run: function (lines) { return runCommands(d, t, sim, lines).lines; },
    config: function () { return runCommands(d, t, sim, ['enable', 'show running-config']).lines; }
  };
}

// One interface's block, prompt stripped, `!`/`exit` ending it.
const ifaceName = require('../engine/iface-name');
function block(lines, name) {
  const out = [];
  let inside = false;
  for (const raw of lines) {
    const line = String(raw).replace(/^.*?#\s*/, '');
    const m = /^interface (.+)$/.exec(line);
    if (m) { inside = ifaceName.portKey(m[1]) === ifaceName.portKey(name); continue; }
    if (!inside) continue;
    if (/^!$/.test(line) || /^exit$/.test(line)) break;
    if (line.trim()) out.push(line.trim());
  }
  return out;
}
function setConfig(lines) { return ['enable', 'configure terminal'].concat(lines).concat(['end']); }
function allowedLine(lines, name) {
  return block(lines, name).filter(function (l) { return /^switchport trunk allowed vlan /.test(l); })[0] || '';
}

console.log('');
console.log('A pair of consecutive ids is printed as two ids, as the captured backups do:');
{
  ok(vlanLib.formatVlanList([157, 158]) === '157,158', '157,158 - the pair in MEXSWP04-NAP#sh run int fa2/0/39',
    vlanLib.formatVlanList([157, 158]));
  ok(vlanLib.formatVlanList([81, 82]) === '81,82', '81,82 - the pair in the doc 68100 backup',
    vlanLib.formatVlanList([81, 82]));
  ok(vlanLib.formatVlanList([55, 56]) === '55,56', '55,56 - one of the two pairs in MEXSW09-NAP#sh run int gi1/0/3',
    vlanLib.formatVlanList([55, 56]));
}

console.log('');
console.log('A run of three still folds, because the range is shorter:');
{
  ok(vlanLib.formatVlanList([1, 2, 3, 100]) === '1-3,100', '1,2,3,100 reads 1-3,100 (the 3650 backup shape)',
    vlanLib.formatVlanList([1, 2, 3, 100]));
  ok(vlanLib.formatVlanList([1, 2, 3, 4, 7, 11]) === '1-4,7,11', '1-4 folds, a run of four, as the c3550 prints it',
    vlanLib.formatVlanList([1, 2, 3, 4, 7, 11]));
}

console.log('');
console.log('The whole block the 3750 prints comes out character for character:');
{
  const env = lab();
  env.run(setConfig([
    'interface Fa0/5', 'switchport mode trunk', 'switchport voice vlan 155',
    'switchport trunk allowed vlan 59,157,158,160', 'switchport trunk native vlan 160',
    'switchport access vlan 160', 'end'
  ]));
  const got = block(env.config(), 'Fa0/5');
  const want = [
    'switchport access vlan 160',
    'switchport trunk native vlan 160',
    'switchport trunk allowed vlan 59,157,158,160',
    'switchport mode trunk',
    'switchport voice vlan 155'
  ];
  ok(JSON.stringify(got) === JSON.stringify(want), 'five lines, in the order MEXSWP04-NAP prints them',
    JSON.stringify(got));
}

console.log('');
console.log('The long list from the second 3750 backup is printed as it was configured:');
{
  const env = lab();
  const typed = '55,56,59,155,157,158,160,200';
  env.run(setConfig(['interface Fa0/6', 'switchport mode trunk', 'switchport trunk allowed vlan ' + typed, 'end']));
  ok(allowedLine(env.config(), 'Fa0/6') === 'switchport trunk allowed vlan ' + typed,
    'no pair in it is folded', allowedLine(env.config(), 'Fa0/6'));
}

console.log('');
console.log('What the console says and what it prints agree, and the list still round-trips:');
{
  const env = lab();
  const said = env.run(setConfig([
    'interface Fa0/7', 'switchport mode trunk', 'switchport trunk allowed vlan 10,11,30,31,32', 'end'
  ]));
  const receipt = said.filter(function (l) { return /allows VLANs/.test(String(l)); }).pop() || '';
  ok(/allows VLANs 10,11,30-32/.test(receipt), 'the receipt spells the pair and folds the run of three', receipt);
  const line = allowedLine(env.config(), 'Fa0/7');
  ok(line === 'switchport trunk allowed vlan 10,11,30-32', 'and the config line says the same', line);

  const shown = env.run(['enable', 'show interfaces Fa0/7']);
  const sentence = shown.filter(function (l) { return /switchport:/.test(String(l)); })[0] || '';
  ok(sentence.indexOf('allowed 10,11,30-32') !== -1, '`show interfaces` carries the same list', sentence);

  // The printed line has to be a line the box itself accepts, unchanged.
  const round = lab();
  round.run(setConfig(['interface Fa0/7', 'switchport mode trunk', 'switchport trunk allowed vlan ' +
    line.replace(/^switchport trunk allowed vlan /, ''), 'end']));
  ok(allowedLine(round.config(), 'Fa0/7') === line, 're-typing the printed list gives the same line back',
    allowedLine(round.config(), 'Fa0/7'));
  const ids = vlanLib.parseVlanList('10,11,30,31,32');
  ok(vlanLib.formatVlanList(ids.vlans) === '10,11,30-32', 'and the fold is a function of the set, not of typing order',
    vlanLib.formatVlanList(ids.vlans));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
