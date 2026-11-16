'use strict';
// Where the Ports cell of `show vlan` runs out of line.
//
// The table's four columns are the device's own, Ports starting at column 48, and a box wraps the list at the
// console's 80 columns: the continuation begins back under the Ports heading, not at column 0, and the break
// carries no comma. Three vendor samples show the same shape at two different port-name lengths:
//
//   Cisco Catalyst 2960-X 15.2(6)E command reference, `show vlan` (48 Gi1/0/x ports, three to a line):
//     https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst2960x/software/15_2_6_e/command_reference/b_1526_2960x_cr/vlan_commands.html
//   2950 reset procedure, `show vlan` (24 Fa0/x ports, four to a line):
//     https://www.cisco.com/c/en/us/support/docs/lan-switching/vlan/217969-reset-catalyst-switches-to-factory-defau.html
//   Cisco lab 5.5.1, `show vlan` (indentation intact, four to a line, continuation under Ports):
//     https://is.muni.cz/el/1433/jaro2014/PV234/cviceni/ESwitching/ESwitching_Lab_5_5_1.pdf
//
// The arithmetic that produces both is one rule, not a per-family count: 80 - 48 = 32 columns of room, entries
// joined by ", ", and an entry that would overrun the window starts a new line indented to 48.
const path = require('path');
const { Topology, Simulator, CliSession } = require('../engine');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices')).filter(function (s) { return !s.error; });
const FAST = catalog.filter(function (s) { return s.portTemplate && s.portTemplate.prefix === 'Fa0/' && s.portTemplate.count === 24; })[0];
const GIG = catalog.filter(function (s) { return s.portTemplate && s.portTemplate.prefix === 'Gi1/0/' && s.portTemplate.count === 24; })[0];

function showVlan(spec) {
  const t = new Topology();
  const sw = t.addDevice(spec, 'sw');
  const sim = new Simulator(t);
  return new CliSession(sw, t, sim).run('show vlan').output.map(String);
}

// The row for VLAN 1 is the first data row; its Ports cell plus every continuation line belonging to it.
function vlan1Lines(lines) {
  const start = lines.findIndex(function (l) { return /^VLAN\s+Name\s+Status\s+Ports/.test(l); });
  const out = [lines[start + 2]];
  for (let i = start + 3; i < lines.length; i++) {
    const l = lines[i];
    if (l.slice(0, 4).trim() || l.slice(5, 37).trim() || l.slice(38, 47).trim()) break;
    out.push(l);
  }
  return out;
}

console.log('A row is one line until the Ports cell runs out of room:');
ok(!!FAST && !!GIG, 'the catalogue carries a 24-port Fast Ethernet switch and a 24-port Gi1/0 switch',
  (FAST ? FAST.model : 'no Fa0/ switch') + ' / ' + (GIG ? GIG.model : 'no Gi1/0 switch'));

const fast = vlan1Lines(showVlan(FAST));
ok(fast.length === 6, '24 Fast Ethernet ports print as six lines, four to a line', fast.length + ' line(s)');
ok(fast[0] === '1    default                          active    Fa0/1, Fa0/2, Fa0/3, Fa0/4',
  'the first line is the row as the 2950 sample prints it', JSON.stringify(fast[0]));
ok(fast[1] === ' '.repeat(48) + 'Fa0/5, Fa0/6, Fa0/7, Fa0/8',
  'and the continuation starts back under the Ports heading, at column 48', JSON.stringify(fast[1]));
ok(fast.every(function (l) { return l.length <= 80; }), 'no line runs past the console\'s 80 columns',
  Math.max.apply(null, fast.map(function (l) { return l.length; })) + ' columns');

const gig = vlan1Lines(showVlan(GIG));
ok(gig.length === 10, 'the Gi1/0 switch has 28 ports, printed as ten lines of three', gig.length + ' line(s)');
ok(gig[0] === '1    default                          active    Gi1/0/1, Gi1/0/2, Gi1/0/3',
  'the longer name fits three to a line, as the 2960-X sample prints it', JSON.stringify(gig[0]));
ok(gig[1] === ' '.repeat(48) + 'Gi1/0/4, Gi1/0/5, Gi1/0/6',
  'and breaks before the entry that would overrun the 32-column window', JSON.stringify(gig[1]));

console.log('\nThe break is a break, not a separator the device prints:');
ok(fast.every(function (l) { return !/,\s*$/.test(l); }),
  'no line ends with a comma the box does not print', fast.join(' | '));
ok(fast.slice(1).every(function (l) { return !l.slice(48).trim().startsWith(','); }),
  'and no continuation line opens with one', fast.slice(1).join(' | '));

console.log('\nThe list is whole across the break:');
const flat = fast.map(function (l, i) { return i === 0 ? l.slice(48) : l.slice(48); }).join(' ');
const seen = flat.split(/\s+/).length;
ok(seen === 24, 'every one of the 24 ports appears, none twice', seen + ' entr(ies)');
ok(flat.indexOf('Fa0/1') === 0 && flat.indexOf('Fa0/24') !== -1, 'first to last, in port order');

console.log('\nA short list stays on the row it belongs to:');
{
  const t = new Topology();
  const sw = t.addDevice(FAST, 'sw');
  const sim = new Simulator(t);
  const cli = new CliSession(sw, t, sim);
  cli.run('configure terminal'); cli.run('vlan 20 twenty'); cli.run('interface Fa0/7');
  cli.run('switchport access vlan 20');
  const lines = new CliSession(sw, t, sim).run('show vlan').output.map(String);
  const row = lines.filter(function (l) { return l.slice(0, 4).trim() === '20'; })[0];
  ok(!!row && row === '20   twenty                           active    Fa0/7',
    'a one-port VLAN is one line, and the next row starts a new one', JSON.stringify(row));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
