'use strict';
// What `show spanning-tree` calls a bundle in its Port column.
//
// The engine models an EtherChannel as one logical port, keyed `lag-<id>` (`Simulator._logicalPortName`,
// `engine/segment.js`), which is the right shape: the tree really does see one port. The CLI printed that key as
// the port's name, so a switch with a bundle answered:
//
//   Port          Role          Sts
//   lag-1         Desg          FWD
//
// No device prints `lag-1`. A Cisco summary table names the bundle `Po1` in the Interface column, at every
// generation and on every platform whose output was read: `Po1 Root FWD 100000 128.65 P2p` (Catalyst 2950),
// `Po1 Desg FWD 10000 128.3433 P2p` (Catalyst 9600, Cisco doc 221588), `Po1 Desg FWD 20000 128.833 P2p`
// (Cisco's STP troubleshooting guide) and `Po1 Root FWD 9 128.27 P2p` (Cisco Learning Network). The long form
// belongs to prose, not to this cell: the same captures print `Port 27 (Port-channel1) of VLAN0001 is root
// forwarding` in the detail view, where the name is the subject of a sentence. The role and state cells are
// the device's abbreviations too - `Desg`, `FWD`, `Altn`, `BLK` - and `stpRoleCell()`/`stpStateCell()` own that
// mapping for every view (`research/stp-port-table-role-and-sts.md`).
//
// `engine/lag.js` already owns both spellings - `portChannelName()` for a cell, `portChannelIfaceName()` for a
// subject - and the MAC table and `show etherchannel summary` take their `Po1` from it. This suite pins the third
// view to the same function, because a second naming rule is how one object gets three names.
// research/stp-port-channel-name.md has the sources.
const path = require('path');
const { CliSession } = require('../engine/cli');
const { Topology, Simulator, runCommands } = require('../engine');
const stpLib = require('../engine/stp');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices')).filter(function (s) { return !s.error; });
const SWITCH = catalog.filter(function (s) { return s.model === 'generic-switch'; })[0];

// The Port column's rows, as the console printed them: name, role cell, state cell.
function portRows(lines) {
  const at = lines.indexOf('Port          Role          Sts');
  if (at === -1) return null;
  return lines.slice(at + 1);
}

// Two switches, `members` 1 Gb cables bundled into channel-group 1, plus an optional spare cable that stays a
// physical port. Returns the near switch's view.
function bundle(members, withSpare) {
  const t = new Topology();
  t.addDevice(SWITCH, 's1');
  t.addDevice(SWITCH, 's2');
  const cmds = ['configure terminal'];
  for (let i = 2; i < 2 + members; i++) {
    t.connect('s1', 'Fa0/' + i, 's2', 'Fa0/' + i);
    cmds.push('interface Fa0/' + i, 'channel-group 1 mode active');
  }
  if (withSpare) t.connect('s1', 'Fa0/' + (2 + members), 's2', 'Fa0/' + (2 + members));
  cmds.push('end');
  const sim = new Simulator(t);
  for (const id of ['s1', 's2']) runCommands(t.getDevice(id), t, sim, cmds);
  sim.computeStp();
  const lines = new CliSession(t.getDevice('s1'), t, sim).run('show spanning-tree').output.map(String);
  return { rows: portRows(lines), lines: lines, sim: sim };
}

console.log('');
console.log('A bundle is one port in the tree, and the table names it `Po1`');
{
  const b = bundle(2, false);
  ok(Array.isArray(b.rows), 'the table has its port rows', JSON.stringify(b.lines));
  ok(b.rows.length === 1, 'a two-member bundle is one row', JSON.stringify(b.rows));
  ok(/^Po1\s/.test(b.rows[0] || ''), 'and it is named `Po1`', b.rows[0]);
  ok(b.lines.join('\n').indexOf('lag-') === -1, 'the engine\'s internal key is printed nowhere', b.lines.join('\n'));
  ok(b.lines.join('\n').indexOf('Port-channel1') === -1,
    'nor the long form: the short one is the cell spelling', b.lines.join('\n'));
}

console.log('');
console.log('The row reports the verdict the election gave the bundle');
{
  const b = bundle(2, false);
  const v = b.sim.stpResult.ports.s1['lag-1'];
  const cells = String(b.rows[0] || '').trim().split(/\s+/);
  ok(cells[1] === stpLib.stpRoleCell(v.role), 'role is the engine\'s, in the cell spelling (' + v.role + ')', b.rows[0]);
  ok(cells[2] === stpLib.stpStateCell(v.state), 'state is the engine\'s, in the cell spelling (' + v.state + ')', b.rows[0]);
}

console.log('');
console.log('A physical port beside the bundle keeps its own name');
{
  const b = bundle(2, true);
  const text = b.rows.join('\n');
  ok(b.rows.length === 2, 'two ports in the tree, two rows', JSON.stringify(b.rows));
  ok(b.rows.some(function (r) { return /^Fa0\/4\s/.test(r); }), 'the spare cable is printed as `Fa0/4`', text);
  ok(b.rows.some(function (r) { return /^Po1\s/.test(r); }), 'the bundle is still `Po1`', text);
  ok(text.indexOf('lag-') === -1, 'and nothing in the table is called `lag-1`', text);
}

console.log('');
console.log('A blocking bundle is still named `Po1`, and carries the cells a box prints');
{
  // Three switches in a triangle, s1 and s2 carrying a bundle on each side of s3. s3 has two paths to the root and
  // blocks one of them; the blocked bundle is the case where a wrong label reads as a port that does not exist.
  const t = new Topology();
  for (const id of ['s1', 's2', 's3']) t.addDevice(SWITCH, id);
  t.connect('s1', 'Fa0/2', 's2', 'Fa0/2');
  t.connect('s2', 'Fa0/3', 's3', 'Fa0/3');
  t.connect('s2', 'Fa0/4', 's3', 'Fa0/4');
  t.connect('s1', 'Fa0/3', 's3', 'Fa0/5');
  t.connect('s1', 'Fa0/4', 's3', 'Fa0/6');
  const sim = new Simulator(t);
  for (const id of ['s1', 's2', 's3']) {
    runCommands(t.getDevice(id), t, sim,
      ['configure terminal', 'interface Fa0/3', 'channel-group 1 mode active',
        'interface Fa0/4', 'channel-group 1 mode active', 'end']);
  }
  sim.computeStp();
  const rows = portRows(new CliSession(t.getDevice('s3'), t, sim).run('show spanning-tree').output.map(String));
  const blocked = (rows || []).filter(function (r) { return /\bBLK\b/.test(r); });
  ok(blocked.length > 0, 'the topology has a blocking port', JSON.stringify(rows));
  ok(blocked.some(function (r) { return /^Po1\s+Altn\s+BLK/.test(r); }),
    'the blocked bundle is `Po1 Altn BLK`', JSON.stringify(blocked));
  ok(blocked.every(function (r) { return !/\(traffic dropped\)/.test(r); }),
    'and no row carries a sentence the device table does not print', JSON.stringify(blocked));
}

console.log('');
console.log('A box that never formed a bundle invents no port-channel name');
{
  const t = new Topology();
  t.addDevice(SWITCH, 'lone');
  const sim = new Simulator(t);
  sim.setRunTime(0);
  const text = new CliSession(t.getDevice('lone'), t, sim).run('show spanning-tree').output.join('\n');
  ok(!/^Po\d+\s/m.test(text), 'no `Po` label on a switch with no bundle', text);
  ok(text.indexOf('lag-') === -1, 'and no internal key either', text);
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
