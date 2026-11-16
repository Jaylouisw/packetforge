'use strict';
// Where the columns of `show vlan` sit.
//
// The table is pasted into tickets and compared line by line against a real box, so the *shape* is the
// deliverable: a four-character VLAN id, a 32-character Name, a nine-character Status, the Ports list in
// column 48, and a rule line under the header that draws those widths in dashes.
//
//   VLAN Name                             Status    Ports
//   ---- -------------------------------- --------- -------------------------------
//   1    default                          active    Fa0/1, Fa0/2
//   1002 fddi-default                     act/unsup
//
// This console padded the id to eight characters and printed no rule line, so `Status` sat at column 41 and
// the ports at 51 - every row three columns right of the heading above it.
//
// Sources (all four print the same header, the same rule line and the same field widths):
//   Cisco IOS LAN Switching Command Reference, `show vlan`:
//     https://www.cisco.com/c/en/us/td/docs/ios/lanswitch/command/reference/lsw_book/lsw_s2.html
//   Cisco IOS XE 16.6 Command Reference (Catalyst 9400), `show vlan`:
//     https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst9400/software/release/16-6/command_reference/b_166_9400_cr/b_166_9400_cr_chapter_01100.html
//   Cisco IOS XE 16.1 Command Reference (Catalyst 3850), `show vlan`:
//     http://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst3850/software/release/16-1/command_reference/b_161_consolidated_3850_cr/b_161_consolidated_3850_cr_chapter_010010.html
//   Cisco Catalyst 3650 16.2 Command Reference, `show vlan` (PDF):
//     https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst3650/software/release/16-2/command_reference/b_162_consolidated_3650_cr/b_162_consolidated_3650_cr_chapter_010010.pdf
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

// The vendor's own header and rule line, character for character.
const HEADER = 'VLAN Name                             Status    Ports';
const RULE = '---- -------------------------------- --------- -------------------------------';
const STATUS_COL = HEADER.indexOf('Status');
const PORTS_COL = HEADER.indexOf('Ports');

function lab() {
  const t = new Topology();
  const sw = t.addDevice(SWITCH, 'sw');
  const sim = new Simulator(t);
  runCommands(sw, t, sim, ['configure terminal', 'vlan 20 twenty',
    'interface Fa0/1', 'switchport access vlan 20', 'end']);
  return { t: t, sim: sim, sw: sw };
}

function table(env, cmd) {
  return runCommands(env.sw, env.t, env.sim, ['enable', cmd]).lines.map(String)
    .filter(function (l) { return !/^(Switch|[A-Za-z0-9-]+[>#])/.test(l); });
}

console.log('');
console.log('The header is the vendor header, and the rule line follows it:');
{
  const lines = table(lab(), 'show vlan');
  ok(lines[0] === HEADER, 'the header is `VLAN Name ... Status Ports` at the vendor\'s widths', lines[0]);
  ok(lines[1] === RULE, 'a rule line under the header draws those widths in dashes', lines[1]);
  ok(RULE.length === 79, 'and it is 79 characters, so the Ports window ends one short of column 80',
    String(RULE.length));
}

console.log('');
console.log('Each dash group starts in the column its heading starts in:');
{
  const groups = [];
  RULE.replace(/-+/g, function (m, at) { groups.push(at); return m; });
  const heads = [HEADER.indexOf('VLAN'), HEADER.indexOf('Name'), STATUS_COL, PORTS_COL];
  ok(JSON.stringify(groups) === JSON.stringify(heads),
    'VLAN/Name/Status/Ports dashes align with VLAN/Name/Status/Ports headings',
    groups.join(',') + ' vs ' + heads.join(','));
}

console.log('');
console.log('Rows sit under their columns, whatever the id and the name are:');
{
  const lines = table(lab(), 'show vlan');
  const rows = lines.slice(2).filter(function (l) { return l.trim(); });
  const one = rows.filter(function (l) { return /^1\s/.test(l); })[0] || '';
  const twenty = rows.filter(function (l) { return /^20\s/.test(l); })[0] || '';
  const reserved = rows.filter(function (l) { return /^1002\s/.test(l); })[0] || '';
  ok(one.indexOf('active') === STATUS_COL, 'VLAN 1: `active` starts in the Status column', one);
  ok(one.indexOf('Fa0/') === PORTS_COL, 'VLAN 1: the port list starts in the Ports column', one);
  ok(twenty.indexOf('active') === STATUS_COL, 'a two-digit id does not shift the Status column', twenty);
  ok(twenty.indexOf('twenty') === 5, 'the name starts in column 5, one past the four-character id', twenty);
  ok(reserved === '1002 fddi-default                     act/unsup',
    'a reserved VLAN with no ports ends after its status, at the vendor\'s spacing', reserved);
  ok(rows.every(function (l) { return /^\d+\s+\S/.test(l); }),
    'and every row still begins with an id, so the rule was not counted as a row', rows.join(' | '));
}

console.log('');
console.log('The header, the rule and the rows are built from one list of widths:');
{
  const src = require('fs').readFileSync(path.join(__dirname, '..', 'engine', 'cli.js'), 'utf8');
  ok(/const VLAN_COLUMNS = \[/.test(src), 'the widths are declared once, as VLAN_COLUMNS');
  ok(/out\.push\(vlanLine\(VLAN_COLUMNS\.map/.test(src), 'the header is drawn from it');
  ok(/out\.push\(vlanRule\(\)\)/.test(src), 'so is the rule line');
  const paddings = (src.match(/pad\((id|name|fixed\.name), 8\)/g) || []);
  ok(paddings.length === 0, 'and no row is padded to the old eight-character id column', paddings.join(','));
}

console.log('');
console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
