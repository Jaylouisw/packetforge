'use strict';
// `show spanning-tree`'s port table has a `Cost` column, and the first column is headed `Interface`.
//
// The table this console printed was three columns wide - `Port  Role  Sts` - and no device prints that
// header. A Catalyst's table is
//
//   Interface           Role Sts Cost      Prio.Nbr Type
//   ------------------- ---- --- --------- -------- --------------------------------
//   Gi0/2               Desg FWD 4         128.3    Shr
//
// (ntc-templates, `tests/cisco_ios/show_spanning-tree/cisco_ios_show_spanning_tree.raw` - a machine-recorded
// session, so the spaces survived; the same header is printed in the Catalyst 9300 17.12 command reference's
// sample). The `Cost` cell is not a new derivation: it is the number `computeStp()` charged the port on its
// way to choosing root ports, so the table and the tree cannot disagree about what a link costs.
//
// One column of that header is deliberately still missing: `Prio.Nbr` is the platform's interface index
// (that capture reads `Gi0/2 -> 128.3`, which no derivation from the name reproduces). `Type` is printed
// from the row's duplex - `P2p` full, `Shr` half - and never carries the `Edge` suffix, because
// `spanning-tree portfast` is not a command this console has
// (research/stp-port-table-type-column.md).
const path = require('path');
const { Topology, Simulator, runCommands } = require('../engine');
const { CliSession } = require('../engine/cli');
const { loadCatalog } = require('../devices/registry');
const stpLib = require('../engine/stp');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices')).filter(function (s) { return !s.error; });
function spec(model) { return catalog.filter(function (s) { return s.model === model; })[0]; }
const SWITCH = spec('generic-switch');
const FAST = spec('2530-48 (J9781A)');   // 48 x 100 Mb access ports - the short table's 19

function view(t, sim, devId) {
  const lines = new CliSession(t.getDevice(devId), t, sim).run('show spanning-tree').output.map(String);
  const at = lines.indexOf('Interface           Role Sts Cost      Type');
  return {
    lines: lines,
    at: at,
    rule: at < 0 ? '' : lines[at + 1],
    rows: at < 0 ? [] : lines.slice(at + 2).filter(Boolean)
  };
}

console.log('');
console.log('The header, the rule and the column positions are the capture\'s:');
{
  const t = new Topology();
  t.addDevice(SWITCH, 's1');
  t.addDevice(SWITCH, 's2');
  t.connect('s1', 'Fa0/1', 's2', 'Fa0/1');
  const sim = new Simulator(t);
  sim.computeStp();
  const v = view(t, sim, 's1');
  ok(v.at !== -1, 'the table is headed `Interface           Role Sts Cost      Type`', JSON.stringify(v.lines));
  ok(v.lines.indexOf('Port          Role          Sts') === -1, 'and `Port` is no longer a column heading');
  ok(v.rule === '------------------- ---- --- --------- -------',
    'one rule line, each run a dash shorter than its field, as the capture draws it', v.rule);
  const row = v.rows[0] || '';
  ok(row.slice(0, 20).trim() === 'Fa0/1', 'the interface cell is 20 wide', JSON.stringify(row));
  ok(row.slice(20, 25).trim() === 'Desg', 'Role starts at column 21', JSON.stringify(row));
  ok(row.slice(25, 29).trim() === 'FWD', 'Sts starts at column 26', JSON.stringify(row));
  ok(row.slice(29, 39).trim() === '4', 'and Cost follows, in a 10-wide field as the capture draws it',
    JSON.stringify(row));
  ok(row.slice(39).trim() === 'P2p', 'with the link type last', JSON.stringify(row));
}

console.log('\nThe Cost cell is the short path cost of the link, the number the election charges:');
{
  const g = new Topology();
  g.addDevice(SWITCH, 's1');
  g.addDevice(SWITCH, 's2');
  g.connect('s1', 'Fa0/1', 's2', 'Fa0/1');
  const gs = new Simulator(g);
  gs.computeStp();
  const gv = view(g, gs, 's1');
  ok(/\s4\s+P2p$/.test(gv.rows[0] || ''), 'a 1 Gb port reads 4', gv.rows[0]);
  ok(stpLib.costForSpeedMbps(1000) === 4, 'which is the published short-method row for 1 Gb');

  const f = new Topology();
  f.addDevice(FAST, 'f1');
  f.addDevice(FAST, 'f2');
  f.connect('f1', '1', 'f2', '1');
  const fs = new Simulator(f);
  fs.computeStp();
  const fv = view(f, fs, 'f1');
  ok(/\s19\s+P2p$/.test(fv.rows[0] || ''), 'a 100 Mb port reads 19', fv.rows[0]);
  ok(stpLib.costForSpeedMbps(100) === 19, 'which is the published short-method row for 100 Mb');
}

console.log('\nAnd it is one number, not two: every printed cell equals what the tree charged the port.');
{
  const t = new Topology();
  for (const id of ['s1', 's2', 's3']) t.addDevice(SWITCH, id);
  t.connect('s1', 'Fa0/1', 's2', 'Fa0/1');
  t.connect('s2', 'Fa0/2', 's3', 'Fa0/1');
  t.connect('s3', 'Fa0/2', 's1', 'Fa0/2');
  const sim = new Simulator(t);
  sim.computeStp();
  let checked = 0;
  for (const id of ['s1', 's2', 's3']) {
    const dev = t.getDevice(id);
    const rows = view(t, sim, id).rows;
    for (const row of rows) {
      const cells = row.trim().split(/\s+/);
      const logicalName = cells[0] === 'Po1' ? 'lag-1' : cells[0];
      ok(Number(cells[3]) === dev.stp.costs[logicalName],
        id + ' ' + cells[0] + ': the cell is the cost the election used', row);
      checked++;
    }
  }
  ok(checked >= 3, 'three switches, every row checked', String(checked));
}

console.log('\nA bundle is one row, and its cost is the number the election charged the bundle:');
{
  const t = new Topology();
  t.addDevice(SWITCH, 's1');
  t.addDevice(SWITCH, 's2');
  const cmds = ['configure terminal'];
  for (const p of ['Fa0/2', 'Fa0/3']) {
    t.connect('s1', p, 's2', p);
    cmds.push('interface ' + p, 'channel-group 1 mode active');
  }
  cmds.push('end');
  const sim = new Simulator(t);
  for (const id of ['s1', 's2']) runCommands(t.getDevice(id), t, sim, cmds);
  sim.computeStp();
  const rows = view(t, sim, 's1').rows;
  const po = rows.filter(function (r) { return r.indexOf('Po1 ') === 0; })[0] || '';
  ok(!!po, 'the table names the bundle `Po1`', JSON.stringify(rows));
  ok(/\s2\s+P2p$/.test(po), 'two 1 Gb members read 2 - the pair the vendor capture measures', po);
  ok(Number(po.trim().split(/\s+/)[3]) === t.getDevice('s1').stp.costs['lag-1'],
    'and it is the bundle cost the election charged, not a member\'s');
}

console.log('\nNo column is invented for what the model cannot state:');
{
  const t = new Topology();
  t.addDevice(SWITCH, 's1');
  t.addDevice(SWITCH, 's2');
  t.connect('s1', 'Fa0/1', 's2', 'Fa0/1');
  const sim = new Simulator(t);
  sim.computeStp();
  const text = view(t, sim, 's1').lines.join('\n');
  ok(!/Prio\.Nbr/.test(text), 'there is no `Prio.Nbr` column (the port number is the platform\'s index)');
  ok(/\bP2p\b/.test(text), 'and `Type` is printed from the row\'s duplex (full duplex here, so `P2p`)');
  ok(!/\bEdge\b/.test(text), 'but never `Edge`: `spanning-tree portfast` is not a command this box has');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
