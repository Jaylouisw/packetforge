'use strict';
// What surrounds `show mac address-table` on a real switch (#1395 follow).
//
// A Catalyst prints a titled table, not a bare column list: a centred `Mac Address Table`, a rule of dashes,
// the headings with their own dash underline, the rows, and one closing sentence that counts them. PacketForge
// printed the heading and the rows and nothing else, so the two things a printed table carries were missing -
// what it is, and how many rows it is - and on a filtered view there was nothing at all saying the count is the
// filter's rather than the box's.
//
// The device's own output (Catalyst 9200, IOS XE 26.x, "Display MAC Addresses"):
//
//   Device# show mac address-table
//
//             Mac Address Table
//   -------------------------------------------
//
//   Vlan    Mac Address       Type        Ports
//   ----    -----------       --------    -----
//      1    188b.45eb.cc01    DYNAMIC     Gi1/0/1
//   Total Mac Addresses for this criterion: 22
//
// and for a filtered view, `Total Mac Addresses for this criterion: 1` over the single row.
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
const PC = catalog.filter(function (s) { return s.model === 'generic-pc'; })[0];

function lab() {
  const t = new Topology();
  const sw = t.addDevice(SWITCH, 'sw');
  const a = t.addDevice(PC, 'a');
  const b = t.addDevice(PC, 'b');
  t.connect('a', 'eth0', 'sw', 'Fa0/1');
  t.connect('b', 'eth0', 'sw', 'Fa0/2');
  const sim = new Simulator(t);
  runCommands(a, t, sim, ['configure terminal', 'interface eth0',
    'ip address 10.0.0.9 255.255.255.0', 'end']);
  runCommands(b, t, sim, ['configure terminal', 'interface eth0',
    'ip address 10.0.0.10 255.255.255.0', 'end']);
  sim.ping('a', '10.0.0.10', { count: 1 });
  return { t: t, sim: sim, sw: sw };
}

function lines(env, command) {
  return ((new CliSession(env.sw, env.t, env.sim).run(command).output) || []).map(String);
}

const RULE = '-------------------------------------------';

console.log('');
console.log('The table is titled and ruled, the way the device prints it:');
{
  const out = lines(lab(), 'show mac address-table');
  ok(out[0] === '          Mac Address Table', 'it opens with the centred title', JSON.stringify(out[0]));
  ok(RULE.length === 43 && out[1] === RULE, 'a rule of 43 dashes sits under the title', JSON.stringify(out[1]));
  ok(out[2] === '', 'and a blank line separates the rule from the headings', JSON.stringify(out[2]));
  ok(/^Vlan\s+Mac Address\s+Type\s+Age\s+Ports$/.test(out[3]), 'the headings are the fourth line', JSON.stringify(out[3]));
  // The device underlines each field with its own fixed run of dashes - 4, 11, 8 and 5 for Vlan, Mac Address,
  // Type and Ports - even though a dotted MAC is wider than its 11-dash rule. `Age` is this model's column and
  // has no counterpart there, so it takes the length of its own heading.
  ok(/^----\s{4}-{11}\s{9}-{8}\s{4}-{3}\s{5}-{5}$/.test(out[4]),
    'the underline is the device\'s 4/11/8/5, with Age under its own name', JSON.stringify(out[4]));
}

console.log('');
console.log('The count at the end is of the rows just printed:');
{
  const env = lab();
  const out = lines(env, 'show mac address-table');
  // The twenty reserved `All ... CPU` rows a switch prints before anything is learned count too - the device
  // counts them (research/mac-table-reserved-rows.md) - so the total over two learned entries is 22.
  ok(out[out.length - 1] === 'Total Mac Addresses for this criterion: 22',
    'the whole table ends with its total, reserved rows included', JSON.stringify(out[out.length - 1]));
  const rows = out.filter(function (l) { return /^\d+\s/.test(l); }).length;
  ok(rows === 2, 'and the learned rows above it are the two the hosts sent', String(rows));
  const reserved = out.filter(function (l) { return /^All\s/.test(l); });
  ok(reserved.length === 20 && /CPU$/.test(reserved[0]),
    'twenty reserved CPU rows precede them, and the total counts those too',
    String(reserved.length));

  const filtered = lines(env, 'show mac address-table interface Fa0/1');
  ok(filtered[filtered.length - 1] === 'Total Mac Addresses for this criterion: 1',
    'a filtered view counts the filter, not the box', JSON.stringify(filtered[filtered.length - 1]));
  ok(filtered.filter(function (l) { return /^\d+\s/.test(l); }).length === 1,
    'which is the one row it printed');
  // The title and the rule travel with the filter too: the device reprints the table's furniture.
  ok(filtered[0] === '          Mac Address Table' && filtered[1] === RULE,
    'the filtered table is titled and ruled like the whole one', JSON.stringify(filtered.slice(0, 2)));
}

console.log('');
console.log('An empty table prints its count as zero rather than losing the line:');
{
  const env = lab();
  // A port on the switch with nothing behind it.
  const out = lines(env, 'show mac address-table interface Fa0/8');
  ok(/no entry learned on Fa0\/8/.test(out.join('\n')),
    'the empty view still says which port it is about', out.join(' | '));
  ok(out[out.length - 1] === 'Total Mac Addresses for this criterion: 0',
    'and the total is 0, not a missing line', JSON.stringify(out[out.length - 1]));
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
