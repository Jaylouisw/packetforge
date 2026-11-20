'use strict';
// The rows a Catalyst prints above everything it has learned.
//
// `show mac address-table` on an untouched switch is not the empty table this console used to print: the box
// forwards a fixed set of group addresses to its own CPU - CDP's two, the `0180.c200.0000`-`0010` run (spanning
// tree, LACP, LLDP among them), the all-nodes broadcast - and lists them as `All ... STATIC ... CPU` before the
// learned rows, counting them in the total
// (#1395 follow). A student's first paste therefore reads `Total Mac Addresses for this criterion: 20` on a
// switch nobody has configured, and 21 once one address has been learned.
//
// The twenty rows below are the block a real 2960 prints (12.2SE paste, twenty CPU rows and one learned address,
// closing at 21 - https://brezular.com/2010/10/10/mac-flooding-attack-2/ ; the CCNA "Viewing Network Device MAC
// Addresses" lab shows the same twenty over two learned rows, closing at 22). IOS XE switches print one more,
// `0180.c200.0021` between `0010` and `ffff.ffff.ffff`, in the Catalyst 9300 16.12 command reference and the
// 9200/9400/9500/9600 pages. This console speaks one IOS-shaped table for the whole catalogue, so it prints the
// twenty every transcript agrees on. research/mac-table-reserved-rows.md records the split and why the
// eleven-row `0000.0000.000x` sample in Cisco's current 2960-X/2960-L/1000 references was not used.
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

const RESERVED = ['0100.0ccc.cccc', '0100.0ccc.cccd'].concat(
  Array.from({ length: 17 }, function (_, i) { return '0180.c200.' + i.toString(16).padStart(4, '0'); }),
  ['ffff.ffff.ffff']);

function show(dev, t, sim, command) {
  return ((new CliSession(dev, t, sim).run(command).output) || []).map(String);
}

// The rows between the heading's dash rule and the closing total.
function body(lines) {
  const head = lines.findIndex(function (l) { return /^Vlan\s/.test(l); });
  const total = lines.findIndex(function (l) { return /^Total Mac Addresses for this criterion:/.test(l); });
  return lines.slice(head + 2, total < 0 ? lines.length : total).filter(function (l) { return l.trim() !== ''; });
}
// A row starts with the Vlan cell, which is a right-aligned four-character field: ` All` for the reserved
// block, `   1` for a learned address (research/mac-table-vlan-cell). So the row begins with spaces before
// either word, and the patterns allow for them.
const reservedRows = function (lines) { return body(lines).filter(function (l) { return /^\s*All\s/.test(l); }); };
const learnedRows = function (lines) { return body(lines).filter(function (l) { return /^\s*\d+\s/.test(l); }); };
const totalOf = function (lines) {
  const last = lines[lines.length - 1];
  const m = last.match(/^Total Mac Addresses for this criterion: (\d+)$/);
  return m ? Number(m[1]) : null;
};

// A switch nobody has touched, and the same switch with two hosts talking through it.
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
console.log('A switch that has learned nothing still holds the CPU-forwarded addresses:');
{
  const env = untouched();
  const out = show(env.sw, env.t, env.sim, 'show mac address-table');
  const reserved = reservedRows(out);
  ok(reserved.length === 20, 'twenty rows are printed before anything is learned', String(reserved.length));
  ok(totalOf(out) === 20, 'and the total is 20, not 0', String(totalOf(out)));
  ok(out[0] === '          Mac Address Table' && out[2] === '',
    'the title, the rule and the blank line are unchanged', JSON.stringify(out.slice(0, 3)));
  ok(body(out)[0] === reserved[0], 'the block starts directly under the headings\' dash rule');
}

console.log('');
console.log('The block is the device\'s list, in the device\'s order:');
{
  const env = untouched();
  const out = show(env.sw, env.t, env.sim, 'show mac address-table');
  const macs = reservedRows(out).map(function (l) { return l.trim().split(/\s+/)[1]; });
  ok(JSON.stringify(macs) === JSON.stringify(RESERVED),
    'two 0100.0ccc addresses, then 0180.c200.0000 up to 0010, then the broadcast address',
    macs.join(','));
  ok(macs[0] === '0100.0ccc.cccc' && macs[1] === '0100.0ccc.cccd', 'CDP\'s two addresses come first', macs.slice(0, 2).join(' '));
  ok(macs[macs.length - 1] === 'ffff.ffff.ffff', 'and the all-nodes address is last', macs[macs.length - 1]);
  ok(macs.includes('0180.c200.000a') && macs.includes('0180.c200.0010'),
    'the group-address run is printed in hex, not decimal', macs.join(','));
}

console.log('');
console.log('Every row says the same three things about itself:');
{
  const env = untouched();
  const out = show(env.sw, env.t, env.sim, 'show mac address-table');
  const fields = reservedRows(out).map(function (l) { return l.trim().split(/\s+/); });
  ok(fields.every(function (f) { return f.length === 5; }), 'each row has the table\'s five columns',
    JSON.stringify(fields[0]));
  ok(fields.every(function (f) { return f[0] === 'All'; }),
    'the Vlan cell is `All`: these addresses belong to no VLAN', fields.map(function (f) { return f[0]; }).join(','));
  ok(fields.every(function (f) { return f[2] === 'STATIC'; }), 'they are STATIC: nothing learned them');
  ok(fields.every(function (f) { return f[4] === 'CPU'; }),
    'and CPU is the Ports cell - they go to the box, not out of a port', fields.map(function (f) { return f[4]; }).join(','));
  ok(fields.every(function (f) { return f[3] === '-'; }), 'a reserved entry was never heard, so it has no age');
}

console.log('');
console.log('The total counts them, and the learned rows follow:');
{
  const env = lab();
  const out = show(env.sw, env.t, env.sim, 'show mac address-table');
  ok(learnedRows(out).length === 2, 'the two hosts are still listed', String(learnedRows(out).length));
  ok(totalOf(out) === 22, 'twenty reserved rows plus two learned ones is 22', String(totalOf(out)));
  const all = body(out);
  ok(reservedRows(out).length === 20 && all.slice(20).every(function (l) { return /^\s*\d+\s/.test(l); }),
    'the reserved block is above every learned row, never interleaved', all.slice(19).join(' | '));
  const first = all[20].trim().split(/\s+/);
  ok(first[0] === '1' && first[2] === 'DYNAMIC' && /^Fa0\/[12]$/.test(first[4]),
    'and a learned row keeps its own columns', JSON.stringify(first));
}

console.log('');
console.log('A filtered view has no CPU rows, because none of them is on a port:');
{
  const env = lab();
  const one = show(env.sw, env.t, env.sim, 'show mac address-table interface Fa0/1');
  ok(reservedRows(one).length === 0, 'the port view prints no reserved rows', one.join(' | '));
  ok(totalOf(one) === 1, 'and its total is that port\'s entries, as before', String(totalOf(one)));
  const empty = show(env.sw, env.t, env.sim, 'show mac address-table interface Fa0/8');
  ok(totalOf(empty) === 0 && /no entry learned on Fa0\/8/.test(empty.join('\n')),
    'a port with nothing behind it still totals 0', String(totalOf(empty)));
}

console.log('');
console.log('The block is a switch\'s, so a host that answers this command does not print it:');
{
  const t = new Topology();
  const pc = t.addDevice(PC, 'pc');
  const out = show(pc, t, new Simulator(t), 'show mac address-table');
  ok(reservedRows(out).length === 0, 'a PC\'s table holds no CPU-forwarded addresses', out.join(' | '));
  ok(totalOf(out) === 0, 'and its total stays 0', String(totalOf(out)));
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
