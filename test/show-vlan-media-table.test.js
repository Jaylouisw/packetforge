// `show vlan` is two tables; `show vlan brief` is only the first.
//
//   VLAN Type  SAID       MTU   Parent RingNo BridgeNo Stp  BrdgMode Trans1 Trans2
//   ---- ----- ---------- ----- ------ ------ -------- ---- -------- ------ ------
//   1    enet  100001     1500  -      -      -        -    -        0      0
//   1002 fddi  101002     1500  -      -      -        -    -        0      0
//   1003 tr    101003     1500  -      -      -        -    -        0      0
//   1004 fdnet 101004     1500  -      -      -        ieee -        0      0
//   1005 trnet 101005     1500  -      -      -        ibm  -        0      0
//
// Both words went to the same printer here, so the full view answered with the brief one and a reader
// asking which media a VLAN is, or what its SAID is, had no column holding the answer. The vendor's syntax
// description defines `brief` as "only a single line for each VLAN, naming the VLAN, status, and ports" -
// the subset - and what follows the first table is the media table and two empty sections:
//
//   Remote SPAN VLANs
//   ------------------------------------------------------------------------------
//
//   Primary Secondary Type              Ports
//   ------- --------- ----------------- ------------------------------------------
//
// Sources:
//   Cisco IOS LAN Switching Command Reference, `show vlan` (exact spacing of header, rule and rows):
//     https://www.cisco.com/c/en/us/td/docs/ios/lanswitch/command/reference/lsw_book/lsw_s2.html
//   Cisco Catalyst 2960-XR 15.2(5)E Consolidated Platform Command Reference, `show vlan`:
//     https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst2960xr/software/15-2_5_e/command_reference/b_1525e_consolidated_2960xr_cr/m_vlan_cr.html
//   Cisco Catalyst 9200 16.10 Command Reference, VLAN Commands (PDF; the 78-dash RSPAN rule):
//     https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst9200/software/release/16-10/command_reference/b_1610_9200_cr/b_1610_9200_cr_chapter_010010.pdf
//   Cisco Community, "Show Vlan command does not show all Vlans" (a live 3850: same rows, `1003 tr`):
//     https://community.cisco.com/t5/switching/show-vlan-command-does-not-show-all-vlans/m-p/3918577
'use strict';
const path = require('path');
const { Topology, Simulator, runCommands } = require('../engine');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices')).filter(function (s) { return !s.error; });
const SWITCH = catalog.filter(function (s) { return s.model === 'generic-switch'; })[0];

// The vendor's header and rule, character for character (78 columns each).
const MEDIA_HEADER = 'VLAN Type  SAID       MTU   Parent RingNo BridgeNo Stp  BrdgMode Trans1 Trans2';
const MEDIA_RULE = '---- ----- ---------- ----- ------ ------ -------- ---- -------- ------ ------';
const RSPAN_RULE = '------------------------------------------------------------------------------';
const PVLAN_HEADER = 'Primary Secondary Type              Ports';
const PVLAN_RULE = '------- --------- ----------------- ------------------------------------------';
// Where each column's text begins, counted off that header.
const COL_AT = { VLAN: 0, Type: 5, SAID: 11, MTU: 22, Parent: 28, RingNo: 35, BridgeNo: 42, Stp: 51,
  BrdgMode: 56, Trans1: 65, Trans2: 72 };

function lab() {
  const t = new Topology();
  const sw = t.addDevice(SWITCH, 'sw');
  const sim = new Simulator(t);
  runCommands(sw, t, sim, ['configure terminal', 'vlan 20 twenty',
    'interface Fa0/1', 'switchport access vlan 20', 'end']);
  return { t: t, sim: sim, sw: sw };
}

function say(env, cmd) {
  return runCommands(env.sw, env.t, env.sim, ['enable', cmd]).lines.map(String);
}

function mediaTable(lines) {
  const at = lines.indexOf(MEDIA_HEADER);
  if (at === -1) return null;
  const rows = [];
  for (let i = at + 2; i < lines.length; i++) {
    if (!/^\d/.test(lines[i])) break;
    rows.push(lines[i]);
  }
  return { header: lines[at], rule: lines[at + 1], rows: rows };
}

console.log('');
console.log('The full view prints the media table, at the vendor\'s widths:');
{
  const env = lab();
  const lines = say(env, 'show vlan');
  const media = mediaTable(lines);
  ok(!!media, '`show vlan` prints a `VLAN Type SAID ...` table at all', lines.join(' | '));
  ok(media && media.header === MEDIA_HEADER, 'the header is the vendor header, character for character',
    media && JSON.stringify(media.header));
  ok(media && media.header.length === 78, 'the header is 78 columns wide', media && String(media.header.length));
  ok(media && media.rule === MEDIA_RULE, 'and the rule line draws those widths in dashes',
    media && JSON.stringify(media.rule));
  ok(media && media.rule.length === 78, 'which is 78 columns too', media && String(media.rule.length));
  ok(media && media.rows.length > 0 && media.rows.every(function (r) { return r.length === 73; }),
    'every row is 73 columns, ending at the last Trans2 value (the box trims its own padding)',
    media && media.rows.map(function (r) { return r.length; }).join(','));
}

console.log('');
console.log('Every value sits under its own heading:');
{
  const media = mediaTable(say(lab(), 'show vlan'));
  const first = media && media.rows.filter(function (r) { return /^1\s/.test(r); })[0];
  for (const name of Object.keys(COL_AT)) {
    const at = COL_AT[name];
    const heading = media ? media.header.indexOf(name) : -1;
    const value = first ? first.slice(at) : '';
    ok(heading === at, '`' + name + '` begins at column ' + at + ' in the header', String(heading));
    ok(!!first && value.length > 0 && value[0] !== ' ', 'and row 1 has a value there', JSON.stringify(first));
  }
}

console.log('');
console.log('What each column says for an ordinary Ethernet VLAN:');
{
  const media = mediaTable(say(lab(), 'show vlan'));
  const row = (media && media.rows.filter(function (r) { return /^20\s/.test(r); })[0]) || '';
  ok(/^20\s+enet/.test(row), 'VLAN 20 is `enet`', row);
  ok(row.indexOf('100020') === COL_AT.SAID, 'its SAID is 100000 + 20 (100020), as the vendor documents the default',
    row);
  ok(row.indexOf('1500') === COL_AT.MTU, 'its MTU is 1500', row);
  ok(row.slice(COL_AT.Trans1) === '0      0', 'and it translates to nothing (Trans1 0, Trans2 0)',
    JSON.stringify(row.slice(COL_AT.Trans1)));
  ok(row.slice(COL_AT.Stp, COL_AT.Stp + 1) === '-',
    'Stp reads `-` even though an Ethernet VLAN default stp-type is ieee - that is what the table prints', row);
}

console.log('');
console.log('The four reserved VLANs carry the medium they come from:');
{
  const media = mediaTable(say(lab(), 'show vlan'));
  const row = function (id) {
    return (media && media.rows.filter(function (r) { return String(r).split(' ')[0] === String(id); })[0]) || '';
  };
  ok(/^1002\s+fddi\s+101002/.test(row(1002)), '1002 is `fddi`, SAID 101002', row(1002));
  ok(/^1003\s+tr\s+101003/.test(row(1003)), '1003 is `tr` (not `trcrf`), SAID 101003', row(1003));
  ok(/^1004\s+fdnet\s+101004/.test(row(1004)) && row(1004).slice(COL_AT.Stp, COL_AT.Stp + 4) === 'ieee',
    '1004 is `fdnet` with IEEE spanning tree', row(1004));
  ok(/^1005\s+trnet\s+101005/.test(row(1005)) && row(1005).slice(COL_AT.Stp, COL_AT.Stp + 3) === 'ibm',
    '1005 is `trnet` with IBM spanning tree', row(1005));
  ok(media && media.rows.length === 6,
    'the media table has one row per VLAN in the table above it (VLAN 1, 20, and 1002-1005)',
    media && String(media.rows.length));
}

console.log('');
console.log('The two sections the full view ends with:');
{
  const lines = say(lab(), 'show vlan');
  const rspan = lines.indexOf('Remote SPAN VLANs');
  ok(rspan !== -1, '`Remote SPAN VLANs` is printed', lines.slice(-6).join(' | '));
  ok(rspan !== -1 && lines[rspan + 1] === RSPAN_RULE, 'under a 78-dash rule', rspan !== -1 ? lines[rspan + 1] : '');
  ok(rspan !== -1 && lines[rspan + 2] === '',
    'with nothing under it - this console cannot configure an RSPAN VLAN',
    rspan !== -1 ? JSON.stringify(lines[rspan + 2]) : '');
  const pv = lines.indexOf(PVLAN_HEADER);
  ok(pv !== -1, 'the private-VLAN table heading follows', lines.slice(-4).join(' | '));
  ok(pv !== -1 && lines[pv + 1] === PVLAN_RULE, 'and its rule line', pv !== -1 ? lines[pv + 1] : '');
  ok(pv > rspan, 'in that order', rspan + ' < ' + pv);
  ok(lines[lines.length - 1] === PVLAN_RULE, 'the view ends there, with no note this console invented',
    JSON.stringify(lines[lines.length - 1]));
}

console.log('');
console.log('`brief` is the subset, so it stops after the first table:');
{
  const lines = say(lab(), 'show vlan brief');
  ok(lines.indexOf(MEDIA_HEADER) === -1, 'no media table in `show vlan brief`');
  ok(lines.indexOf('Remote SPAN VLANs') === -1, 'no RSPAN section either');
  ok(lines.indexOf(PVLAN_HEADER) === -1, 'and no private-VLAN table');
  ok(lines.some(function (l) { return /^20\s+twenty/.test(l); }), 'the name/status/ports row is still there',
    lines.join(' | '));
  const full = say(lab(), 'show vlan');
  ok(full.indexOf(MEDIA_HEADER) !== -1 && lines.indexOf(MEDIA_HEADER) === -1,
    'so the two words differ by exactly the part the vendor calls extra');
}

console.log('');
console.log('There is one blank line between the first table and the media table:');
{
  const lines = say(lab(), 'show vlan');
  const at = lines.indexOf(MEDIA_HEADER);
  ok(lines[at - 1] === '', 'the line above the media header is empty', JSON.stringify(lines[at - 1]));
  ok(/act\/unsup$/.test(lines[at - 2] || ''), 'and above that is the last reserved row of the first table',
    JSON.stringify(lines[at - 2]));
}

console.log('');
console.log('The widths are declared once, and every part is drawn from them:');
{
  const src = require('fs').readFileSync(path.join(__dirname, '..', 'engine', 'cli.js'), 'utf8');
  ok(/const VLAN_MEDIA_COLUMNS = \[/.test(src), 'the widths live in VLAN_MEDIA_COLUMNS');
  ok(/out\.push\(vlanMediaLine\(VLAN_MEDIA_COLUMNS\.map/.test(src), 'the header is drawn from it');
  ok(/out\.push\(vlanMediaRule\(\)\)/.test(src), 'so is the rule line');
  ok(/for \(const id of ids\) out\.push\(vlanMediaLine\(vlanMediaCells\(id\)\)\)/.test(src),
    'and the rows are keyed by the same id list the first table prints, so the two cannot list different VLANs');
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
if (failed) process.exitCode = 1;
