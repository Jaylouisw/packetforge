'use strict';
// `show spanning-tree` prints the Role and Sts cells as the device abbreviates them, not as the detail
// view spells them.
//
// A Cisco summary table reads `Fa0/13  Desg FWD 19  128.13  P2p` / `Gi0/1  Root FWD 4  128.25  P2p` /
// `Gi0/2  Altn BLK 4  128.26  P2p` (Pearson, *CCNA Portable Command Guide* appendix B, `show spanning-tree
// vlan 10`). The command reference's field table fixes the vocabulary: Role is "Boun (boundary), Desg
// (designated), Root, Altn (alternate), and Back (backup)"; Sts is "BKN* (broken), BLK (blocking), DWN
// (down), LTN (listening), LBK (loopback), LRN (learning), and FWD (forwarding)" (Catalyst 9300 17.12
// command reference). The long words are real device output too, but in `show spanning-tree detail`, where
// the port is the subject of a sentence: `Port 14 (GigabitEthernet0/0/7) of VLAN0001 is alternate blocking`
// (Cisco ASR 920 LAN Switching guide) - the same box prints `Altn BLK` in the table one command away.
//
// This console printed the sentence in the cell (`Fa0/1  alternate  blocking  (traffic dropped)`). No
// capture prints `(traffic dropped)` in that table; the note was this console's own. The table now prints
// the device's cells, and the payload keeps the detail view's sentence for the tooltip, which is the view
// that really says it. research/stp-port-table-role-and-sts.md has the sources and the columns still open.
const path = require('path');
const { Topology, Simulator } = require('../engine');
const { CliSession } = require('../engine/cli');
const { loadCatalog } = require('../devices/registry');
const stpLib = require('../engine/stp');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices')).filter(function (s) { return !s.error; });
const SWITCH = catalog.filter(function (s) { return s.model === 'generic-switch'; })[0];

console.log('The value vocabularies are the command reference\'s:');
{
  ok(stpLib.stpRoleCell('root') === 'Root', 'root is `Root`');
  ok(stpLib.stpRoleCell('designated') === 'Desg', 'designated is `Desg`');
  ok(stpLib.stpRoleCell('alternate') === 'Altn', 'alternate is `Altn`');
  ok(stpLib.stpStateCell('forwarding') === 'FWD', 'forwarding is `FWD`');
  ok(stpLib.stpStateCell('blocking') === 'BLK', 'blocking is `BLK`');
  // A word the election cannot produce is not given an invented cell: the mapping covers only what this
  // model can print, and a role/state added later has to bring its own word with it.
  ok(stpLib.stpRoleCell('backup') === 'backup', 'a role this model cannot elect is returned unchanged');
  ok(stpLib.stpStateCell('listening') === 'LTN', 'listening is `LTN`');
  ok(stpLib.stpStateCell('learning') === 'LRN', 'learning is `LRN`');
  ok(stpLib.stpStateCell('disabled') === 'disabled', 'and a state this model cannot report is returned unchanged');
  ok(stpLib.stpPortText('blocking') === 'blocking (traffic dropped)',
    'the detail-view sentence is still the payload\'s wording', stpLib.stpPortText('blocking'));
}

console.log('\nA three-switch triangle, read where all three roles appear:');
const t = new Topology();
for (const id of ['s1', 's2', 's3']) t.addDevice(SWITCH, id);
t.connect('s1', 'Fa0/1', 's2', 'Fa0/1');
t.connect('s2', 'Fa0/2', 's3', 'Fa0/1');
t.connect('s3', 'Fa0/2', 's1', 'Fa0/2');
const sim = new Simulator(t);
sim.computeStp();

function table(devId) {
  const lines = new CliSession(t.getDevice(devId), t, sim).run('show spanning-tree').output.map(String);
  const at = lines.indexOf('Interface           Role Sts Cost      Type');
  // The header, the rule under it, then one row per port.
  return { lines: lines, rows: at < 0 ? [] : lines.slice(at + 2).filter(Boolean) };
}

// A console asked while the election is still settling prints the transitional states, and a box
// abbreviates those too: `LTN` (listening) then `LRN` (learning) before `FWD`.
sim.setRunTime(1000);
const early = table('s1');
ok(early.rows.some(function (r) { return /\sLTN\s+\d+\s+(P2p|Shr|-)$/.test(r); }),
  'a port still listening reads `LTN`, not `listening`', early.rows.join(' | '));
ok(!/listening|learning|forwarding|blocking/.test(early.lines.join('\n')),
  'and no cell is spelled out', early.lines.join('\n'));

sim.setRunTime(30000);
const s2 = table('s2');
const s3 = table('s3');
const rows = s2.rows.concat(s3.rows);
const cells = rows.map(function (r) { return r.trim().split(/\s+/); });

ok(s2.rows.length > 0 && s3.rows.length > 0, 'both switches print a port table',
  JSON.stringify(s2.lines) + ' / ' + JSON.stringify(s3.lines));
ok(cells.every(function (c) { return c.length === 5; }),
  'each row is name, role, state, cost and link type and nothing else (Prio.Nbr is still not invented)',
  JSON.stringify(rows));
ok(cells.every(function (c) { return ['Root', 'Desg', 'Altn'].indexOf(c[1]) !== -1; }),
  'every role cell is one of the table\'s words', JSON.stringify(cells.map(function (c) { return c[1]; })));
ok(cells.every(function (c) { return ['FWD', 'BLK'].indexOf(c[2]) !== -1; }),
  'and every state cell is `FWD` or `BLK`', JSON.stringify(cells.map(function (c) { return c[2]; })));
ok(rows.some(function (r) { return /\bRoot\s+FWD\b/.test(r); }), 'the root port reads `Root FWD`', rows.join(' | '));
ok(rows.some(function (r) { return /\bDesg\s+FWD\b/.test(r); }), 'a designated port reads `Desg FWD`', rows.join(' | '));
ok(rows.some(function (r) { return /\bAltn\s+BLK\b/.test(r); }), 'the blocked alternate reads `Altn BLK`', rows.join(' | '));

console.log('\nNo cell carries the detail view\'s sentence or this console\'s annotation:');
{
  const text = s2.lines.concat(s3.lines).join('\n');
  ok(!/\bdesignated\b/.test(text), '`designated` is not a table cell', text);
  ok(!/\bforwarding\b/.test(text), '`forwarding` is not a table cell', text);
  ok(!/\balternate\b/.test(text), '`alternate` is not a table cell', text);
  ok(!/traffic dropped/.test(text), 'and no row says `(traffic dropped)`, which no device table prints');
}

console.log('\nThe payload and the table are two voices of one verdict, not two verdicts:');
{
  const blocked = t.getDevice('s3').stp.blocked;
  const blockedName = blocked && Array.from(blocked)[0];
  const row = s3.rows.filter(function (r) { return r.indexOf(blockedName + ' ') === 0; })[0] || '';
  ok(!!blockedName, 'the election blocked one port on s3', String(blockedName));
  ok(new RegExp('^' + blockedName + '\\s+Altn\\s+BLK\\s+\\d+\\s+(P2p|Shr|-)$').test(row.trim()),
    'the table names it `Altn BLK`, followed by the cost the election charged and the link type', row);
  ok(stpLib.stpPortText('blocking') === 'blocking (traffic dropped)',
    'while the payload sentence still explains what BLK does to a frame');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
