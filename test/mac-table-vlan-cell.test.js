'use strict';
// The `Vlan` cell of `show mac address-table` is a four-character field holding a right-aligned value.
//
// Real hardware prints a learned entry in VLAN 1 as `   1`, and the reserved block's `All` as ` All` - the word
// is a value in the same field, not a label in column 0. Machine-recorded Catalyst sessions preserve the leading
// spaces that a pasted web sample loses: ntc-templates keeps the raw CLI text for two of them, and both print
// `Vlan    Mac Address       Type        Ports` over ` All    0100.0ccc.cccc    STATIC      CPU` and
// `   1    30a3.30a3.a1c3    DYNAMIC     Po1`
// (https://github.com/networktocode/ntc-templates/tree/master/tests/cisco_ios/show_mac-address-table,
// `cisco_ios_show_mac-address-table4.raw` and `cisco_ios_show_mac-address-table13.raw`; the 6500's older
// `show mac-address-table` in `...table2.raw` right-aligns its six-character vlan field the same way:
// `   666`). This console printed every VLAN id in column 0, so a row read `1       0200...` where a box reads
// `   1    0200...`: the one column an operator scans to see which VLAN an entry belongs to was in the wrong
// place on every row.
//
// The console's own table carries an `Age` column the vendor's does not, so its Vlan column is eight characters
// wide. The value keeps the device's alignment - right-aligned to the right edge of the four-dash rule under the
// heading - and the field grew to the right, so the MAC column still starts in column 8.
const path = require('path');
const { Topology, Simulator, runCommands } = require('../engine');
const net = require('../engine/net');
const { CliSession } = require('../engine/cli');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices')).filter(function (s) { return !s.error; });
const SWITCH = catalog.filter(function (s) { return s.model === 'generic-switch'; })[0];
const PC = catalog.filter(function (s) { return s.model === 'generic-pc'; })[0];

function show(dev, t, sim, command) {
  return ((new CliSession(dev, t, sim).run(command).output) || []).map(String);
}
function body(lines) {
  const head = lines.findIndex(function (l) { return /^Vlan\s/.test(l); });
  const total = lines.findIndex(function (l) { return /^Total Mac Addresses for this criterion:/.test(l); });
  return lines.slice(head + 2, total < 0 ? lines.length : total).filter(function (l) { return l.trim() !== ''; });
}
function rowOf(lines, mac) {
  return body(lines).filter(function (l) { return l.indexOf(mac) !== -1; })[0] || '';
}

// Two VLANs, so one table holds a one-digit and a four-digit id: VLAN 1 is the access VLAN of Fa0/1-Fa0/2,
// VLAN 1000 of Fa0/3-Fa0/4, and a ping inside each pair teaches the switch both MACs.
function lab() {
  const t = new Topology();
  const sw = t.addDevice(SWITCH, 'sw');
  const a = t.addDevice(PC, 'a');
  const b = t.addDevice(PC, 'b');
  const c = t.addDevice(PC, 'c');
  const d = t.addDevice(PC, 'd');
  t.connect('a', 'eth0', 'sw', 'Fa0/1');
  t.connect('b', 'eth0', 'sw', 'Fa0/2');
  t.connect('c', 'eth0', 'sw', 'Fa0/3');
  t.connect('d', 'eth0', 'sw', 'Fa0/4');
  const sim = new Simulator(t);
  const addr = [['a', '10.0.0.9'], ['b', '10.0.0.10'], ['c', '10.0.1.9'], ['d', '10.0.1.10']];
  for (const pair of addr) {
    runCommands(t.getDevice(pair[0]), t, sim,
      ['configure terminal', 'interface eth0', 'ip address ' + pair[1] + ' 255.255.255.0', 'end']);
  }
  runCommands(sw, t, sim, ['configure terminal',
    'interface Fa0/3', 'switchport access vlan 1000', 'exit',
    'interface Fa0/4', 'switchport access vlan 1000', 'exit', 'end']);
  sim.ping('a', '10.0.0.10', { count: 1 });
  sim.ping('c', '10.0.1.10', { count: 1 });
  return { t: t, sim: sim, sw: sw, a: a, b: b, c: c, d: d };
}

const env = lab();
const lines = show(env.sw, env.t, env.sim, 'show mac address-table');
const macA = net.formatMac(env.a.interfaces.get('eth0').mac);
const macC = net.formatMac(env.c.interfaces.get('eth0').mac);

console.log('');
console.log('The Vlan cell is a four-character field, right-aligned:');
{
  const reserved = rowOf(lines, '0100.0ccc.cccc');
  ok(reserved.slice(0, 4) === ' All', 'the reserved `All` row starts with one space', JSON.stringify(reserved.slice(0, 8)));
  const one = rowOf(lines, macA);
  ok(one.slice(0, 4) === '   1', 'a VLAN 1 entry starts with three spaces', JSON.stringify(one.slice(0, 8)));
  const big = rowOf(lines, macC);
  ok(big.slice(0, 4) === '1000', 'a four-digit VLAN fills the field with no pad', JSON.stringify(big.slice(0, 8)));
  ok(reserved.charAt(0) === ' ' && one.charAt(0) === ' ' && big.charAt(0) === '1',
    'and no row puts a value in column 0 except a full-width id');
}

console.log('');
console.log('The value ends where the heading\'s rule ends:');
{
  const header = lines.filter(function (l) { return /^Vlan\s/.test(l); })[0] || '';
  const rule = lines.filter(function (l) { return /^-{4}\s/.test(l); })[0] || '';
  ok(header.slice(0, 4) === 'Vlan', 'the heading keeps `Vlan` in the first four columns', JSON.stringify(header.slice(0, 4)));
  ok(rule.slice(0, 4) === '----', 'and its underline is four dashes', JSON.stringify(rule.slice(0, 4)));
  const one = rowOf(lines, macA);
  ok(one.charAt(3) === '1', 'a one-digit id sits under the last dash of that rule (column 3)', JSON.stringify(one.slice(0, 4)));
  const reserved = rowOf(lines, '0100.0ccc.cccc');
  ok(reserved.slice(0, 3) === ' Al', 'and `All` ends in the same column', JSON.stringify(reserved.slice(0, 4)));
}

console.log('');
console.log('Nothing else in the row moved:');
{
  const atEight = body(lines).map(function (l) { return /^ {0,3}[0-9A-Za-z]{1,4} {1,}/.test(l.slice(0, 8)) && l.slice(8, 9) !== ' '; });
  ok(atEight.length > 0 && atEight.every(Boolean), 'every row starts its MAC cell in column 8');
  const one = rowOf(lines, macA);
  ok(one.indexOf(macA) === 8, 'the learned MAC is the cell at column 8', one);
  ok(one.slice(28, 35) === 'DYNAMIC', 'and `DYNAMIC` still begins in column 28', JSON.stringify(one.slice(28, 36)));
}

console.log('');
console.log('The filtered view keeps the same alignment:');
{
  const filtered = show(env.sw, env.t, env.sim, 'show mac address-table interface Fa0/1');
  const row = rowOf(filtered, macA);
  ok(row.slice(0, 4) === '   1', 'a single-port view prints the same cell', JSON.stringify(row.slice(0, 8)));
  ok(row.indexOf(macA) === 8, 'at the same column', row);
}

console.log('');
console.log('The old left-aligned shape is gone:');
{
  const bad = body(lines).filter(function (l) { return /^([0-9]+|All) {5,}/.test(l); });
  ok(bad.length === 0, 'no row begins with an unpadded VLAN id', bad[0] || 'none');
  const all = body(lines).filter(function (l) { return /^All\b/.test(l); });
  ok(all.length === 0, 'and no `All` row begins in column 0', all[0] || 'none');
}

console.log('');
console.log('mac-table-vlan-cell: ' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exitCode = 1;
