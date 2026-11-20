'use strict';
// `show etherchannel summary` printed a table this console invented (#1620).
//
// The header was `Group  Protocol  Ports`: no legend, no counts, no `Port-channel` column, and a Protocol
// cell that carried the negotiation mode - `LACP (active)`, `Static` - which is a string no box produces.
// A Catalyst prints a fixed nine-line flag key, two counts, then four columns, with the bundle's own flags
// in the `Po1(SU)` cell:
//
//   Number of channel-groups in use: 1
//   Number of aggregators:           1
//   Group  Port-channel  Protocol    Ports
//   ------+-------------+-----------+-----------------------------------------------
//   1      Po1(SU)         LACP      Gi1/0/1(P) Gi1/0/2(P)
//
// Evidence (research/etherchannel-summary-layout.md): the Catalyst SD-WAN 26.x interface guide, the
// Catalyst 2960-X / 9500 command references and Cisco-authored EtherChannel labs all print this key and
// this rule. Each check below pins one rule taken from those transcripts.
const path = require('path');
const { Topology, Simulator } = require('../engine');
const { CliSession } = require('../engine/cli');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  ✓ ' + msg); }
  else { failed++; console.error('  ✗ ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices')).filter(function (s) { return !s.error; });
const SWITCH = catalog.filter(function (s) { return s.model === 'generic-switch'; })[0];

function ports(dev) {
  return [...dev.interfaces.values()].filter(function (i) { return i.type === 'ethernet'; });
}

// Two switches, two cables: a bundle whose members can both carry a frame.
//
// Both ends name the group. LACP is a conversation, so a port whose partner configured no channel group
// receives no answer and is not bundled - `Po1(SD)` with the member as a single link. The table below is
// about the layout of a *working* bundle, so the far end has to be in the group for the row to be (SU)
// (research/lacp-one-sided-group.md).
function lab() {
  const t = new Topology();
  const a = t.addDevice(SWITCH, 'sw1');
  const b = t.addDevice(SWITCH, 'sw2');
  const pa = ports(a);
  const pb = ports(b);
  t.connect('sw1', pa[0].name, 'sw2', pb[0].name);
  t.connect('sw1', pa[1].name, 'sw2', pb[1].name);
  const sim = new Simulator(t);
  const s = new CliSession(a, t, sim);
  const far = new CliSession(b, t, sim);
  far.run('enable');
  far.run('configure terminal');
  for (const p of [pb[0].name, pb[1].name]) {
    far.run('interface ' + p);
    far.run('channel-group 1 mode active');
  }
  far.run('end');
  return { t: t, a: a, b: b, pa: pa, pb: pb, sim: sim, s: s };
}

function say(env, cmd) {
  return ((env.s.run(cmd).output) || []).map(String);
}

function bundle(env, id, mode) {
  say(env, 'configure terminal');
  for (const p of [env.pa[0].name, env.pa[1].name]) {
    say(env, 'interface ' + p);
    say(env, 'channel-group ' + id + ' mode ' + (mode || 'active'));
  }
  say(env, 'end');
  return say(env, 'show etherchannel summary');
}

// The row for a group: the line that starts with its number and a space.
function rowFor(lines, id) {
  return lines.filter(function (l) { return l.indexOf(String(id) + ' ') === 0; })[0] || '';
}

// The single-letter flags a line of the table uses: the character after "(" and before ")".
function flagsIn(line) {
  const out = [];
  const parts = String(line).split('(');
  for (let i = 1; i < parts.length; i++) {
    const ch = parts[i].charAt(0);
    if (parts[i].charAt(1) === ')' && ch >= 'A' && ch <= 'Z') out.push(ch);
  }
  return out;
}

// The key as a box prints it: nine flag lines, with a blank line between the `f - failed to allocate
// aggregator` text and the `M - not in use` line. Both machine-recorded captures in
// research/etherchannel-summary-layout.md carry that gap (`ntc-templates`, cisco_ios, show_etherchannel_summary
// .raw and summary2.raw), so it is in the bytes and not an artifact of extraction.
const KEY_LINES = [
  'Flags:  D - down        P - bundled in port-channel',
  '        I - stand-alone s - suspended',
  '        H - Hot-standby (LACP only)',
  '        R - Layer3      S - Layer2',
  '        U - in use      f - failed to allocate aggregator',
  '',
  '        M - not in use, minimum links not met',
  '        u - unsuitable for bundling',
  '        w - waiting to be aggregated',
  '        d - default port'
];
const RULE = '------+-------------+-----------+-----------------------------------------------';
const HEADER = 'Group  Port-channel  Protocol    Ports';
const PROTOCOL_AT = 23;
const PORTS_AT = 33;

console.log('');
console.log('The key, the counts and the rule come before the table:');
{
  const env = lab();
  const lines = bundle(env, 1);
  ok(JSON.stringify(lines.slice(0, 10)) === JSON.stringify(KEY_LINES),
    'the nine-line flag key is the device key, line for line, gap included',
    JSON.stringify(lines.slice(0, 10)));
  ok(lines[5] === '', 'the gap sits after the `f` text and before `M`', JSON.stringify(lines[5]));
  ok(lines[10] === 'Number of channel-groups in use: 1', 'then the count of groups', lines[10]);
  ok(lines[11] === 'Number of aggregators:           1',
    'then the aggregator count, in the same column as the first number', lines[11]);
  ok(lines[12] === '', 'then the blank line a box prints above the table', JSON.stringify(lines[12]));
  ok(lines[13] === HEADER, 'then the four-column header, at the device widths', lines[13]);
  ok(lines[14] === RULE, 'then the rule line, drawn under those columns', lines[14]);
  ok(lines[15].indexOf('1      Po1(') === 0, 'and only then a group row', lines[15]);
  // Every flag letter the table prints is explained by the key printed above it.
  const used = new Set();
  for (const l of lines.slice(15)) for (const f of flagsIn(l)) used.add(f);
  ok(used.size > 0, 'the table uses flag letters', JSON.stringify([...used]));
  for (const letter of used) {
    ok(KEY_LINES.join('\n').indexOf(letter + ' - ') !== -1,
      '(' + letter + ') is a flag the key explains', KEY_LINES.join('\n'));
  }
}

console.log('');
console.log('A row says which port-channel it is and what the bundle is doing:');
{
  const env = lab();
  const row = rowFor(bundle(env, 1), 1);
  ok(row.indexOf('Po1(SU)') === 7, 'the Port-channel cell is Po1(SU), in its own column', row);
  ok(row.indexOf('LACP') === PROTOCOL_AT, 'the protocol starts at column 23, where the device puts it', row);
  ok(row.indexOf(env.pa[0].name + '(P)') === PORTS_AT,
    'and the member list starts in column 33, under Ports', row);
  ok(HEADER.indexOf('Ports') === PORTS_AT, 'which is where the header puts Ports', HEADER);
}

console.log('');
console.log('The bundle flags follow the members:');
{
  const env = lab();
  bundle(env, 1);
  ok(rowFor(say(env, 'show etherchannel summary'), 1).indexOf('Po1(SU)') !== -1,
    'a bundle with a member that can carry reads (SU)');
  say(env, 'configure terminal');
  say(env, 'interface ' + env.pa[1].name);
  say(env, 'shutdown');
  say(env, 'end');
  const half = rowFor(say(env, 'show etherchannel summary'), 1);
  ok(half.indexOf('Po1(SU)') !== -1 && half.indexOf('(D)') !== -1,
    'one member down leaves the bundle up: (SU), with that member (D)', half);
  say(env, 'configure terminal');
  say(env, 'interface ' + env.pa[0].name);
  say(env, 'shutdown');
  say(env, 'end');
  const dead = rowFor(say(env, 'show etherchannel summary'), 1);
  ok(dead.indexOf('Po1(SD)') !== -1, 'a bundle no member can carry reads (SD)', dead);
  ok(dead.indexOf('Po1(SU)') === -1, 'and not (SU), which would call it in use', dead);
}

console.log('');
console.log('The Protocol column names a protocol, not the mode:');
{
  for (const pair of [['active', 'LACP'], ['passive', 'LACP'], ['on', '-']]) {
    const env = lab();
    const row = rowFor(bundle(env, 1, pair[0]), 1);
    const cell = row.slice(PROTOCOL_AT, PORTS_AT).trim();
    ok(cell === pair[1], 'mode ' + pair[0] + ' reads ' + pair[1] + ' in the Protocol column', JSON.stringify(cell));
  }
  // Nothing prints the strings this console used to invent for that column.
  const active = bundle(lab(), 1).join('\n');
  const staticMode = bundle(lab(), 1, 'on').join('\n');
  ok(active.indexOf('LACP (') === -1, 'no row reads LACP with a mode in brackets', active);
  ok(!/^1 +Po1(S[UD]) +Static/m.test(staticMode),
    'and no row calls mode on Static - no protocol is running in that mode', staticMode);
  // The mode is still readable where the device keeps it.
  const env = lab();
  bundle(env, 1, 'passive');
  ok(say(env, 'show running-config').some(function (l) { return /channel-group 1 mode passive/.test(l); }),
    'the mode is in show running-config, where it is set',
    JSON.stringify(say(env, 'show running-config').filter(function (l) { return /channel-group/.test(l); })));
}

console.log('');
console.log('Two groups, counted:');
{
  const env = lab();
  bundle(env, 1);
  say(env, 'configure terminal');
  say(env, 'interface ' + env.pa[2].name);
  say(env, 'channel-group 10 mode on');
  say(env, 'end');
  const lines = say(env, 'show etherchannel summary');
  ok(lines[10] === 'Number of channel-groups in use: 2', 'the count is of the groups, not the members', lines[10]);
  ok(lines[11] === 'Number of aggregators:           2', 'and one aggregator per group here', lines[11]);
  const rows = lines.filter(function (l) { return rowFor([l], parseInt(l, 10)).length > 0; });
  ok(rows.length === 2, 'one row per group', JSON.stringify(rows));
  ok(rows[0].indexOf('1 ') === 0 && rows[1].indexOf('10 ') === 0, 'ordered by number', JSON.stringify(rows));
  ok(rows[0].indexOf('Po1(') === 7 && rows[1].indexOf('Po10(') === 7,
    'and Po<N> names group N, in the same column', JSON.stringify(rows));
}

console.log('');
// A box with no channel groups still prints the view. Cisco's errdisable recovery document opens its
// port-channel example with a 6500 that has no groups in use - the nine-line key, both counts at 0, the
// header and the rule - and no rows under it (cat6k# show etherchannel summary,
// <https://www.cisco.com/c/en/us/support/docs/lan-switching/spanning-tree-protocol/69980-errdisable-recovery.html>).
// The community transcript in research/etherchannel-summary-layout.md shows the same table on a second
// switch. This console answered `% No link aggregation groups configured` instead: an error sentence no IOS
// prints, which reported an empty view as a refusal.
console.log('A device with no bundle prints the view with nothing in it, not an error sentence:');
{
  const t = new Topology();
  const sw = t.addDevice(SWITCH, 'lonely');
  const s = new CliSession(sw, t, new Simulator(t));
  const lines = ((s.run('show etherchannel summary').output) || []).map(String);
  ok(lines.length === 15, 'the key, the two counts, the blank line, the header and the rule - fifteen lines, no rows',
    JSON.stringify(lines));
  ok(lines[0] === 'Flags:  D - down        P - bundled in port-channel' && lines[9] === '        d - default port',
    'the key is the same ten lines it prints over a populated table', JSON.stringify(lines.slice(0, 10)));
  ok(lines[10] === 'Number of channel-groups in use: 0', 'the first count is zero', lines[10]);
  ok(/^Number of aggregators: +0$/.test(lines[11]) && lines[11].length === lines[10].length,
    'and so is the second, ending in the same column', JSON.stringify(lines[11]));
  ok(lines[12] === '', 'the blank line above the table is printed too', JSON.stringify(lines[12]));
  ok(lines[13] === 'Group  Port-channel  Protocol    Ports', 'the header is printed with no row under it',
    lines[13]);
  ok(lines[14] === '------+-------------+-----------+-----------------------------------------------',
    'and the rule under the header', lines[14]);
  ok(lines.every(function (l) { return l.indexOf('% ') !== 0; }), 'no line reports the view as an error',
    JSON.stringify(lines));
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
