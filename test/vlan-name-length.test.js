'use strict';
// How long a VLAN name may be.
//
// Every Cisco reference that documents the field gives it the same range - 1 to 32 characters - and the Name
// column of `show vlan` is exactly those 32 characters wide. The two are one fact, not two: a name the console
// cannot print inside its own cell is not a name the box stores.
//
//   * Cisco IOS LAN Switching Command Reference, `show vlan` - "the VLAN name is an ASCII string from 1 to 32
//     characters"
//     https://www.cisco.com/c/en/us/td/docs/ios/lanswitch/command/reference/lsw_book/lsw_s2.html
//   * Catalyst 2960-X 15.2(6)E command reference, `vlan` - "names the VLAN with an ASCII string from 1 to 32
//     characters"
//     https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst2960x/software/15_2_6_e/command_reference/b_1526_2960x_cr.pdf
//   * Catalyst 1200/1300 CLI guide, `vlan` - "vlan-name - Specifies the VLAN name. (range: 1-32 characters)",
//     and the same one-line `vlan <id> name <text>` grammar this console uses
//     https://www.cisco.com/c/en/us/td/docs/switches/campus-lan-switches-access/Catalyst-1200-and-1300-Switches/cli/C1300-cli/vlan-commands.html
//
// Before this rule, `vlan 4094 name <40 characters>` was accepted and `show vlan` printed a row eight columns
// wide of its cell, pushing `Status` and the ports list right - on the table an operator holds against a change
// record. What a box does with an over-long name is not witnessed for IOS (research/vlan-name-length.md), so the
// refusal is in this console's words while the limit it quotes is the vendor's.
const path = require('path');
const { Topology, Simulator, runCommands } = require('../engine');
const { loadCatalog } = require('../devices/registry');
const vlanLib = require('../engine/vlan');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  ok   ' + msg); }
  else { failed++; console.error('  FAIL ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices')).filter(function (s) { return !s.error; });
const SWITCH = catalog.filter(function (s) { return s.model === 'generic-switch'; })[0];

const HEADER = 'VLAN Name                             Status    Ports';
const STATUS_COL = HEADER.indexOf('Status');

function lab() {
  const t = new Topology();
  const sw = t.addDevice(SWITCH, 'sw');
  const sim = new Simulator(t);
  return { t: t, sim: sim, sw: sw };
}

// What the console said, without the echoed prompt lines.
function output(env, cmds) {
  const text = runCommands(env.sw, env.t, env.sim, ['enable', 'end'].concat(cmds)).output;
  return text.split(/\r?\n/).filter(function (l) { return !/^(Switch|[A-Za-z0-9-]+[>#])/.test(l); });
}

function row(env, id) {
  return output(env, ['show vlan brief']).filter(function (l) {
    return new RegExp('^' + id + ' ').test(l);
  })[0] || null;
}

console.log('');
console.log('The limit is the width of the Name column:');
{
  ok(vlanLib.VLAN_NAME_MAX === 32, 'VLAN_NAME_MAX is 32 characters', String(vlanLib.VLAN_NAME_MAX));
}

console.log('');
console.log('A 32-character name is stored, and its row is a printed row:');
{
  const env = lab();
  const name = 'A'.repeat(32);
  const out = output(env, ['configure terminal', 'vlan 100 name ' + name]);
  ok(out.some(function (l) { return l === 'VLAN 100 created (name: ' + name + ')'; }),
    'a name of exactly 32 characters is accepted', out.join(' | '));
  ok(env.sw.config.vlans[100].name === name, 'and it is what the VLAN holds');

  const r = row(env, 100);
  ok(!!r, 'the VLAN has a row in `show vlan brief`');
  ok(r.indexOf('active') === STATUS_COL,
    'Status still starts in column ' + STATUS_COL + ' with a 32-character name', JSON.stringify(r));
}

console.log('');
console.log('A 33-character name is refused, and nothing is left behind:');
{
  const env = lab();
  const name = 'B'.repeat(33);
  const out = output(env, ['configure terminal', 'vlan 101 name ' + name]);
  ok(out.some(function (l) {
    return l === '% VLAN name "' + name + '" is 33 characters: a VLAN name is 1-32 characters, ' +
      'so nothing was changed';
  }), 'the refusal counts the name it refused and quotes the limit', out.join(' | '));
  ok(!env.sw.config.vlans[101], 'the VLAN was not created');
  ok(!row(env, 101), 'and `show vlan brief` has no row for it');
  ok(output(env, ['show running-config']).every(function (l) { return l.indexOf('vlan 101') === -1; }),
    'and the running-config has no line for it');
  ok(output(env, ['configure terminal', 'no vlan 101']).some(function (l) {
    return l === '% VLAN 101 does not exist';
  }), 'so `no vlan 101` says there is nothing to delete');
}

console.log('');
console.log('A 33-character rename leaves the old name in place:');
{
  const env = lab();
  output(env, ['configure terminal', 'vlan 200 name SALES']);
  const out = output(env, ['configure terminal', 'vlan 200 name ' + 'C'.repeat(33)]);
  ok(out.some(function (l) { return l.indexOf('% VLAN name "CCC') === 0; }), 'the rename is refused');
  ok(env.sw.config.vlans[200].name === 'SALES', 'and the VLAN still holds SALES');
  ok(row(env, 200).indexOf('SALES') !== -1, 'as the table shows');
}

console.log('');
console.log('The keywordless spelling obeys the same limit:');
{
  const env = lab();
  const out = output(env, ['configure terminal', 'vlan 300 ' + 'D'.repeat(33)]);
  ok(out.some(function (l) { return l.indexOf('% VLAN name "DDD') === 0; }),
    '`vlan 300 <33 characters>` is refused, not stored as a name', out.join(' | '));
  ok(!env.sw.config.vlans[300], 'and the VLAN was not created');
}

console.log('');
console.log('The default name is inside the limit, so a bare `vlan` still works:');
{
  const env = lab();
  output(env, ['configure terminal', 'vlan 400']);
  ok(env.sw.config.vlans[400].name === 'VLAN0400', 'a VLAN made by id alone is named VLAN0400');
  ok(row(env, 400).indexOf('VLAN0400') !== -1, 'and the table prints that name');
  ok(row(env, 400).indexOf('active') === STATUS_COL, 'and Status is where the header puts it');
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
