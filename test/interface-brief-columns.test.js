'use strict';
// `show ip interface brief` has six columns, and every row lands in them.
//
// Two things were wrong with the table an operator pastes into a bug report:
//
//   * the Method column said `manual` beside `unassigned`, which claims somebody configured an address the
//     port does not have. IOS prints `unset` there - the Method column answers "how did this port come by
//     its address", so a port with no address has no method;
//   * the header was a hard-coded string and each row was padded by hand, and the header put `OK?` in four
//     columns where the rows put `YES  ` in five, which slid every row one column left of its own heading.
//
// The table's shape is IOS's, checked against the vendor's own sample output: the header below is the string
// Cisco's command reference prints, character for character.
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
function spec(model) { return catalog.filter(function (s) { return s.model === model; })[0]; }
const ROUTER = spec('generic-router');
const SWITCH = spec('generic-switch');

function lab() {
  const t = new Topology();
  const d = t.addDevice(ROUTER, 'r1');
  const s = new CliSession(d, t, new Simulator(t));
  return {
    t: t, d: d, s: s,
    say: function (c) { return ((s.run(c).output) || []).map(String); },
    cfg: function () { s.run('enable'); s.run('configure terminal'); return s; }
  };
}

const IOS_HEADER = 'Interface              IP-Address      OK? Method Status                Protocol';

function colOf(line, word, from) { return line.indexOf(word, from || 0); }

function rowOf(lines, name) {
  return lines.filter(function (l) { return l.indexOf(name) === 0; })[0] || '';
}

console.log('');
console.log('The header is the table own first row, not a string of its own:');
{
  const env = lab();
  env.cfg();
  env.say('interface Gi0/0');
  env.say('ip address 10.0.0.1 255.255.255.0');
  env.say('end');
  const lines = env.say('show ip interface brief');
  ok(lines[0] === IOS_HEADER, 'it is the IOS header, character for character', lines[0]);

  const row = rowOf(lines, 'GigabitEthernet0/0');
  ok(colOf(lines[0], 'OK?') === colOf(row, 'YES'), 'OK? sits above YES',
    colOf(lines[0], 'OK?') + ' vs ' + colOf(row, 'YES'));
  ok(colOf(lines[0], 'IP-Address') === colOf(row, '10.0.0.1'), 'IP-Address above the address',
    colOf(lines[0], 'IP-Address') + ' vs ' + colOf(row, '10.0.0.1'));
  ok(colOf(lines[0], 'Method') === colOf(row, 'manual'), 'Method above the method, not one column right of it',
    'header ' + colOf(lines[0], 'Method') + ' vs row ' + colOf(row, 'manual'));
  const statusAt = colOf(lines[0], 'Status');
  ok(statusAt === colOf(row, 'down', colOf(row, 'manual') + 1), 'Status above the status',
    'header ' + statusAt + ' vs row ' + colOf(row, 'down', colOf(row, 'manual') + 1));
}

console.log('');
console.log('The Method column says how the port got its address, and a port with none has no method:');
{
  const env = lab();
  env.cfg();
  env.say('interface Gi0/0');
  env.say('ip address 10.0.0.1 255.255.255.0');
  env.say('interface Gi0/1');
  env.say('ip address dhcp');
  env.say('end');
  const lines = env.say('show ip interface brief');

  const stat = rowOf(lines, 'GigabitEthernet0/0');
  ok(/YES manual /.test(stat), 'a static address is manual', stat);

  const dhcp = rowOf(lines, 'GigabitEthernet0/1');
  ok(/unassigned\s+YES DHCP/.test(dhcp), 'a DHCP client with no lease yet is unassigned beside DHCP', dhcp);

  const bare = rowOf(lines, 'GigabitEthernet0/2');
  ok(/unassigned\s+YES unset /.test(bare), 'a port nobody configured is unassigned beside unset', bare);
  ok(!/unassigned\s+YES manual/.test(bare), 'and never beside manual, which claims an address it has not got',
    bare);
}

console.log('');
console.log('The method follows the port back when the address is taken away:');
{
  const env = lab();
  env.cfg();
  env.say('interface Gi0/0');
  env.say('ip address 10.0.0.9 255.255.255.0');
  ok(/YES manual /.test(rowOf(env.say('show ip interface brief'), 'GigabitEthernet0/0')), 'manual to begin with');
  env.say('no ip address');
  env.say('end');
  const after = rowOf(env.say('show ip interface brief'), 'GigabitEthernet0/0');
  ok(/unassigned\s+YES unset /.test(after), 'and unset once the address is gone', after);
}

console.log('');
console.log('A shut port keeps its method, and the long status word does not jostle the row:');
{
  const env = lab();
  env.cfg();
  env.say('interface Gi0/0');
  env.say('ip address 10.0.0.1 255.255.255.0');
  env.say('shutdown');
  env.say('end');
  const row = rowOf(env.say('show ip interface brief'), 'GigabitEthernet0/0');
  ok(/YES manual /.test(row), 'the method is a property of the address, not of the link', row);
  ok(/administratively down\s+down$/.test(row), 'and the status column still ends in down', row);
}

console.log('');
console.log('A name wider than its column shifts the row instead of running into the address:');
{
  const env = lab();
  const iface = env.d.interfaces.get('Gi0/0');
  env.d.interfaces.delete('Gi0/0');
  iface.name = 'GigabitEthernet0/0/0';
  env.d.interfaces.set(iface.name, iface);
  env.cfg();
  env.say('interface ' + iface.name);
  env.say('ip address 10.0.0.1 255.255.255.0');
  env.say('end');
  const row = rowOf(env.say('show ip interface brief'), 'GigabitEthernet0/0/0');
  ok(/GigabitEthernet0\/0\/0  +10\.0\.0\.1/.test(row),
    'a twenty-character name keeps a space before the address', row);
}

console.log('');
console.log('Every port on a switch, not just the one a test typed into:');
{
  const t = new Topology();
  const d = t.addDevice(SWITCH, 'sw1');
  const s = new CliSession(d, t, new Simulator(t));
  s.run('enable');
  const lines = ((s.run('show ip interface brief').output) || []).map(String);
  const rows = lines.filter(function (l) { return /^[A-Za-z]+\d/.test(l) && l.indexOf('Interface') !== 0; });
  ok(rows.length === d.interfaces.size, 'the switch lists every one of its ports',
    rows.length + ' of ' + d.interfaces.size);
  const wrong = rows.filter(function (l) { return /unassigned\s+YES manual/.test(l); });
  ok(wrong.length === 0, 'and not one of them calls an empty port manual', JSON.stringify(wrong.slice(0, 2)));
  const misaligned = rows.filter(function (l) { return colOf(l, 'unset') !== colOf(lines[0], 'Method'); });
  ok(misaligned.length === 0, 'every row method starts under the heading',
    JSON.stringify(misaligned.slice(0, 2)));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
