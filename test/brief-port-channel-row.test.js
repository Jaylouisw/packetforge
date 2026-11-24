'use strict';
// `show ip interface brief` on a switch with an EtherChannel: the bundle is an interface, and a box lists it
// (#2029 follow-on, research/port-channel-in-interface-brief.md).
//
// An EtherChannel creates a logical interface. Every published capture of this table taken on a switch with a
// bundle carries a row for it - `Port-channel2 unassigned YES unset up up` (Cisco doc 221664), `Port-channel1
// unassigned YES unset down down` while its members were suspended (Cisco doc 225790) - and this console listed
// only the member ports, so the interface an operator addresses and pings appeared in no view they open first.
//
// What is locked here:
//   1. a working bundle has a row, spelled `Port-channel1` - the long form, not the `Po1` the MAC table and the
//      summary print - with `unassigned YES unset up up`;
//   2. the row arrives after the physical ports, in numeric bundle order (Port-channel2 before Port-channel10);
//   3. a bundle no member joined is `down down`, even though each member is up and carrying as a single link -
//      the bundle's state is about the bundle, not about its cables;
//   4. one live member is enough for `up up`;
//   5. all members shut is `down down`;
//   6. a switch with no bundle gains no row - the table is not padded with interfaces nobody configured;
//   7. the row's columns sit under the header, and the summary still names the same bundle `Po1`, because each
//      view spells the type word the way a box spells it there.
const path = require('path');
const { Topology, Simulator } = require('../engine');
const { CliSession } = require('../engine/cli');
const lagLib = require('../engine/lag.ts');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices')).filter(function (s) { return !s.error; });
const SWITCH = catalog.filter(function (s) { return s.model === 'C2960X-24TS-L'; })[0];

if (!SWITCH) {
  console.error('  \u2717 C2960X-24TS-L is not in the catalogue');
  process.exit(1);
}

// Two switches joined by `n` cables, each end put into one channel group - the shape a lab builds.
function lab(n, opts) {
  const o = opts || {};
  const t = new Topology();
  const a = t.addDevice(SWITCH, 'sw1');
  const b = t.addDevice(SWITCH, 'sw2');
  const pa = [...a.interfaces.values()].filter(function (i) { return i.type === 'ethernet'; });
  const pb = [...b.interfaces.values()].filter(function (i) { return i.type === 'ethernet'; });
  for (let i = 0; i < n; i++) t.connect('sw1', pa[i].name, 'sw2', pb[i].name);
  const sim = new Simulator(t);
  const sa = new CliSession(a, t, sim);
  const sb = new CliSession(b, t, sim);
  sa.run('enable'); sb.run('enable');
  sa.run('configure terminal'); sb.run('configure terminal');
  for (let i = 0; i < n; i++) {
    sa.run('interface ' + pa[i].name);
    sa.run('channel-group 1 mode active');
    if (o.shut) sa.run('shutdown');
    sb.run('interface ' + pb[i].name);
    // `oneSided` leaves the far end in no group at all, so nothing there answers LACP - the stand-alone case.
    if (!o.oneSided) sb.run('channel-group 1 mode active');
  }
  sa.run('end'); sb.run('end');
  return { t: t, a: a, b: b, sa: sa, sb: sb, pa: pa, pb: pb, sim: sim };
}

function say(env, cmd) {
  return ((env.sa.run(cmd).output) || []).map(String);
}
function rowOf(lines, name) {
  return lines.filter(function (l) { return l.indexOf(name) === 0; })[0] || '';
}
// A row of the table: a line that starts with a port name - `Gi1/0/1`, `Port-channel1` - not the header.
function tableRows(lines) {
  return lines.filter(function (l) { return /^[A-Za-z][A-Za-z-]*\d/.test(l) && l.indexOf('Interface') !== 0; });
}

console.log('');
console.log('A working bundle is an interface, and the row says what a box says:');
{
  const env = lab(2);
  const lines = say(env, 'show ip interface brief');
  const row = rowOf(lines, 'Port-channel1');
  ok(!!row, 'the bundle has a row', JSON.stringify(lines.slice(-2)));
  ok(/^Port-channel1\s+unassigned\s+YES unset\s+up\s+up$/.test(row),
    'unassigned, unset, up, up - the capture in Cisco doc 221664', row);
  ok(rowOf(lines, 'Po1') === '', 'and not the short form: `Po1` is the summary\'s spelling, not this table\'s');
  // The same object, named the way each view names it - so the two cannot describe two different bundles.
  const summary = say(env, 'show etherchannel summary');
  const groupRow = summary.filter(function (l) { return /^1\s+Po1\(/.test(l); })[0] || '';
  ok(/Po1\(SU\)/.test(groupRow), 'the summary still calls it Po1(SU)', groupRow);
  ok(lagLib.portChannelIfaceName('1') === 'Port-channel1' && lagLib.portChannelName('1') === 'Po1',
    'and both names come from one library, so they cannot disagree about the id');
}

console.log('');
console.log('The row arrives after the physical ports, and bundles sort by number:');
{
  const env = lab(1);
  // A second group on two more ports, numbered 10, so a text sort would put it before 2.
  env.sa.run('configure terminal');
  env.sa.run('interface ' + env.pa[2].name); env.sa.run('channel-group 10 mode active');
  env.sa.run('interface ' + env.pa[3].name); env.sa.run('channel-group 2 mode active');
  env.sa.run('end');
  const lines = say(env, 'show ip interface brief');
  const rows = tableRows(lines);
  const names = rows.map(function (l) { return l.split(/\s+/)[0]; });
  const firstBundle = names.findIndex(function (n) { return n.indexOf('Port-channel') === 0; });
  ok(names.indexOf('Port-channel1') > names.indexOf('GigabitEthernet1/0/28'),
    'every bundle follows the last physical port', names.slice(-4).join(' '));
  ok(names.indexOf('Port-channel2') < names.indexOf('Port-channel10'),
    'bundles in numeric order, not string order', names.slice(firstBundle).join(' '));
  ok(names.filter(function (n) { return n.indexOf('Port-channel') === 0; }).length === 3,
    'one row per group, no more', names.slice(firstBundle).join(' '));
}

console.log('');
console.log('A bundle no member joined is down, and the members are not:');
{
  const env = lab(2, { oneSided: true });
  const lines = say(env, 'show ip interface brief');
  const row = rowOf(lines, 'Port-channel1');
  ok(/down\s+down$/.test(row), 'the bundle is down down', row);
  ok(/^GigabitEthernet1\/0\/1\s+unassigned\s+YES unset\s+up\s+up$/.test(rowOf(lines, 'GigabitEthernet1/0/1')),
    'while the member is up up, carrying as a single link', rowOf(lines, 'GigabitEthernet1/0/1'));
  ok(/\bI\)/.test(say(env, 'show etherchannel summary').filter(function (l) {
    return /^1\s+Po1\(/.test(l);
  })[0] || ''), 'and the summary marks each member stand-alone (I), the state the bundle is not in');
}

console.log('');
console.log('One live member is enough for the bundle to be up; all of them shut is not:');
{
  const one = lab(2);
  one.sa.run('configure terminal');
  one.sa.run('interface ' + one.pa[0].name); one.sa.run('shutdown');
  one.sa.run('end');
  const rowOne = rowOf(say(one, 'show ip interface brief'), 'Port-channel1');
  ok(/up\s+up$/.test(rowOne), 'one member still in the bundle keeps it up up', rowOne);

  const none = lab(2, { shut: true });
  const rowNone = rowOf(say(none, 'show ip interface brief'), 'Port-channel1');
  ok(/down\s+down$/.test(rowNone), 'with every member shut it is down down', rowNone);
  ok(/Po1\(SD\)/.test(say(none, 'show etherchannel summary').filter(function (l) {
    return /^1\s+Po1\(/.test(l);
  })[0] || ''), 'and the summary agrees: Po1(SD)');
}

console.log('');
console.log('A switch with no bundle gains no row:');
{
  const t = new Topology();
  const d = t.addDevice(SWITCH, 'sw1');
  const s = new CliSession(d, t, new Simulator(t));
  s.run('enable');
  const lines = ((s.run('show ip interface brief').output) || []).map(String);
  const bundles = tableRows(lines).filter(function (l) { return l.indexOf('Port-channel') === 0; });
  ok(bundles.length === 0, 'nothing is invented for a box nobody bundled', JSON.stringify(bundles));
  ok(tableRows(lines).length === d.interfaces.size, 'and every port is still listed',
    tableRows(lines).length + ' of ' + d.interfaces.size);
}

console.log('');
console.log('The row lines up under the table it sits in:');
{
  const env = lab(2);
  const lines = say(env, 'show ip interface brief');
  const head = lines[0];
  const row = rowOf(lines, 'Port-channel1');
  const at = function (word, line) { return line.indexOf(word); };
  ok(at('unassigned', row) === at('IP-Address', head), 'the address starts under IP-Address',
    at('unassigned', row) + ' vs ' + at('IP-Address', head));
  ok(at('unset', row) === at('Method', head), 'the method starts under Method',
    at('unset', row) + ' vs ' + at('Method', head));
  ok(at('up', row) === at('Status', head), 'the status starts under Status',
    at('up', row) + ' vs ' + at('Status', head));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
