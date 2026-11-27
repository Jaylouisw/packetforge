'use strict';
// `show mac address-table dynamic`: the box's own filter for what it learned, and the rows it leaves out.
//
// `show mac address-table` prints the twenty `All ... STATIC ... CPU` rows a Catalyst forwards to its own CPU
// before anything is learned, and counts them (research/mac-table-reserved-rows.md). The vendor's `dynamic` form
// is the view of what is left: every reference that prints it prints learned rows only.
//
//   2960-X 15.2(7)E, System Management Commands
//   <https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst2960x/software/15-2_7_e/command_reference/b_1527_2960x_cr/system_management_commands.html>
//
//     Switch# show mac address-table dynamic
//     Mac Address Table
//     ------------------------------------------
//     Vlan    Mac Address       Type        Ports
//     ----    -----------       ----        -----
//        1    0030.b635.7862    DYNAMIC     Gi0/2
//        1    00b0.6496.2741    DYNAMIC     Gi0/2
//     Total Mac Addresses for this criterion: 2
//
// Not one `All ... STATIC ... CPU` row, and the total counts the two printed rows - the same sentence the
// unfiltered view closes with, counting a different criterion. The 15.2(4)E consolidated guide and the 2960
// 15.0(2)SE command reference print the same sample. The console used to refuse the word outright and tell the
// operator to use `interface <port>` instead, which is a form of the command the box does have.
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

function show(dev, t, sim, command) {
  return ((new CliSession(dev, t, sim).run(command).output) || []).map(String);
}
function body(lines) {
  const head = lines.findIndex(function (l) { return /^Vlan\s/.test(l); });
  const total = lines.findIndex(function (l) { return /^Total Mac Addresses for this criterion:/.test(l); });
  return lines.slice(head + 2, total < 0 ? lines.length : total).filter(function (l) { return l.trim() !== ''; });
}
const reservedRows = function (lines) { return body(lines).filter(function (l) { return /^\s*All\s/.test(l); }); };
const learnedRows = function (lines) { return body(lines).filter(function (l) { return /^\s*\d+\s/.test(l); }); };
const totalOf = function (lines) {
  const m = String(lines[lines.length - 1]).match(/^Total Mac Addresses for this criterion: (\d+)$/);
  return m ? Number(m[1]) : null;
};

function untouched() {
  const t = new Topology();
  const sw = t.addDevice(SWITCH, 'sw');
  return { t: t, sim: new Simulator(t), sw: sw };
}
function lab() {
  const t = new Topology();
  const sw = t.addDevice(SWITCH, 'sw');
  const a = t.addDevice(PC, 'a');
  const b = t.addDevice(PC, 'b');
  t.connect('a', 'eth0', 'sw', 'Fa0/1');
  t.connect('b', 'eth0', 'sw', 'Fa0/2');
  const sim = new Simulator(t);
  runCommands(a, t, sim, ['configure terminal', 'interface eth0', 'ip address 10.0.0.9 255.255.255.0', 'end']);
  runCommands(b, t, sim, ['configure terminal', 'interface eth0', 'ip address 10.0.0.10 255.255.255.0', 'end']);
  sim.ping('a', '10.0.0.10', { count: 1 });
  return { t: t, sim: sim, sw: sw };
}

console.log('');
console.log('On a switch that has learned nothing, the dynamic view is empty while the full one holds twenty:');
{
  const env = untouched();
  const dyn = show(env.sw, env.t, env.sim, 'show mac address-table dynamic');
  const full = show(env.sw, env.t, env.sim, 'show mac address-table');
  ok(body(dyn).length === 0, 'no row at all', JSON.stringify(body(dyn)));
  ok(totalOf(dyn) === 0, 'and the total is 0, because the criterion matched nothing', String(totalOf(dyn)));
  ok(totalOf(full) === 20 && reservedRows(full).length === 20,
    'the unfiltered view still prints and counts its twenty CPU rows', String(totalOf(full)));
}

console.log('');
console.log('After two hosts speak, the view holds the two learned rows and no CPU row:');
{
  const env = lab();
  const out = show(env.sw, env.t, env.sim, 'show mac address-table dynamic');
  ok(learnedRows(out).length === 2, 'both learned addresses are printed', JSON.stringify(learnedRows(out)));
  ok(reservedRows(out).length === 0, 'not one `All ... STATIC ... CPU` row', JSON.stringify(reservedRows(out)));
  ok(totalOf(out) === 2, 'the total is the two printed rows, as the vendor sample closes at 2', String(totalOf(out)));
  ok(out[0] === '          Mac Address Table' && out[2] === '',
    'the title, the rule and the blank line are the same furniture', JSON.stringify(out.slice(0, 3)));
  const row = learnedRows(out)[0].trim().split(/\s+/);
  ok(row[2] === 'DYNAMIC' && /^Fa0\/[12]$/.test(row[4]), 'a row keeps its own columns', JSON.stringify(row));
}

console.log('');
console.log('The short form is the same view, because a box matches a keyword by its prefix:');
{
  const env = lab();
  const long = show(env.sw, env.t, env.sim, 'show mac address-table dynamic');
  const short = show(env.sw, env.t, env.sim, 'show mac address-table dyn');
  ok(JSON.stringify(short) === JSON.stringify(long), '`dyn` and `dynamic` print the same table', short.join(' | '));
  const one = show(env.sw, env.t, env.sim, 'show mac address-table d');
  ok(JSON.stringify(one) === JSON.stringify(long), 'and so does `d`, the shortest prefix no other word claims', one.join(' | '));
}

console.log('');
console.log('It combines with the port filter the console already had:');
{
  const env = lab();
  const out = show(env.sw, env.t, env.sim, 'show mac address-table dynamic interface Fa0/1');
  ok(learnedRows(out).length === 1, 'one row for the one port', JSON.stringify(learnedRows(out)));
  ok(/Fa0\/1$/.test(learnedRows(out)[0]), 'and it is the port that was asked about', learnedRows(out)[0]);
  ok(totalOf(out) === 1, 'the total counts the filter rows', String(totalOf(out)));
}

console.log('');
console.log('A filtered view with nothing to say still says how many rows that is:');
{
  const env = untouched();
  const out = show(env.sw, env.t, env.sim, 'show mac address-table dynamic interface Fa0/7');
  ok(learnedRows(out).length === 0 && reservedRows(out).length === 0, 'no rows', JSON.stringify(body(out)));
  ok(totalOf(out) === 0, 'and a closing count of 0', String(totalOf(out)));
}

console.log('');
console.log('The words it does not take are still refused, and the refusal names the ones it does:');
{
  const env = untouched();
  const out = show(env.sw, env.t, env.sim, 'show mac address-table vlan 1');
  ok(out.length === 1 && /^% /.test(out[0]), 'a refusal, as before', JSON.stringify(out));
  ok(/dynamic/.test(out[0]) && /interface/.test(out[0]), 'and it names both filters this console has', out[0]);
  ok(!/use `show mac address-table interface <port>` for one port$/.test(out[0]),
    'it no longer names one form as though it were the only one', out[0]);
}

console.log('');
console.log('A host that is not a switch answers the view rather than failing it:');
{
  const t = new Topology();
  const pc = t.addDevice(PC, 'pc');
  const sim = new Simulator(t);
  const out = show(pc, t, sim, 'show mac address-table dynamic');
  ok(learnedRows(out).length === 0 && reservedRows(out).length === 0, 'an empty table', JSON.stringify(body(out)));
  ok(totalOf(out) === 0, 'closing at 0', String(totalOf(out)));
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
