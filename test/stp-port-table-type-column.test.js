'use strict';
// `show spanning-tree`'s port table has a `Type` column, and its cell is the RSTP link type, which a
// Catalyst derives from the port's duplex.
//
// The vendor states the rule in one sentence: "Cisco Catalyst switches determine the RSTP port type based
// on two port settings: the current duplex (full or half) and whether the PortFast feature is enabled.
// First, full duplex tells the switch to use port type point-to-point, with half duplex telling the switch
// to use port type shared." (Odom, CCNA 200-301 Official Cert Guide, Appendix O; the same paragraph and the
// same transcript are in the CCNA Portable Command Guide, Appendix B.) The transcript beside it prints
// `P2p` on the full-duplex rows and `Fa0/18  Desg FWD 19  128.18  Shr` on the port with a hub hung off it,
// and a 2960 transcript prints `Fa0/41  Desg FWD 100  128.45  Shr Edge` among its `P2p Edge` rows.
//
// Only the duplex half of that rule is modelled here: `spanning-tree portfast` is a command this console
// refuses by name, so no port can be an edge port and the `Edge` suffix is never printed. A row whose port
// has no duplex answer prints `-` rather than a guessed link type.
// research/stp-port-table-type-column.md has the sources and what is still open.
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
const SWITCH = spec('generic-switch');   // 8 x 1 Gb
const FAST = spec('2530-48 (J9781A)');   // 48 x 100 Mb - the only speed at which half duplex is legal

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
function rowFor(t, sim, devId, name) {
  return (view(t, sim, devId).rows || []).filter(function (r) { return r.split(/\s+/)[0] === name; })[0] || '';
}

console.log('');
console.log('The cell is the duplex rule the vendor documents, and nothing else:');
{
  ok(stpLib.stpTypeCell('full') === 'P2p', 'full duplex is `P2p`');
  ok(stpLib.stpTypeCell('half') === 'Shr', 'half duplex is `Shr`');
  ok(stpLib.stpTypeCell('FULL') === 'P2p', 'the answer does not depend on the case of the setting');
  ok(stpLib.stpTypeCell(' half ') === 'Shr', 'nor on stray space around it');
  ok(stpLib.stpTypeCell(null) === null, 'no duplex is no answer, not `P2p`');
  ok(stpLib.stpTypeCell(undefined) === null, 'and an absent setting is the same nothing');
  ok(stpLib.stpTypeCell('auto') === null, 'an unrecognised setting is not folded onto `P2p`');
  ok(stpLib.stpTypeCell('') === null, 'nor is the empty string');
}

console.log('\nThe header, the rule and the column positions belong to the capture:');
{
  const t = new Topology();
  t.addDevice(SWITCH, 's1');
  t.addDevice(SWITCH, 's2');
  t.connect('s1', 'Fa0/1', 's2', 'Fa0/1');
  const sim = new Simulator(t);
  sim.computeStp();
  const v = view(t, sim, 's1');
  ok(v.at !== -1, 'the table is headed `Interface           Role Sts Cost      Type`', JSON.stringify(v.lines));
  ok(v.rule === '------------------- ---- --- --------- -------',
    'one rule line, each run a dash shorter than its field', v.rule);
  const row = v.rows[0] || '';
  ok(row.slice(0, 20).trim() === 'Fa0/1', 'the interface cell is 20 wide', JSON.stringify(row));
  ok(row.slice(20, 25).trim() === 'Desg', 'Role starts at column 21', JSON.stringify(row));
  ok(row.slice(25, 29).trim() === 'FWD', 'Sts starts at column 26', JSON.stringify(row));
  ok(row.slice(29, 39).trim() === '4', 'Cost starts at column 30, in a 10-wide field', JSON.stringify(row));
  ok(row.slice(39).trim() === 'P2p', 'Type starts at column 40', JSON.stringify(row));
  ok(!/\s$/.test(row), 'and the last cell carries no trailing space');
}

console.log('\nA full-duplex link reads `P2p` at both ends:');
{
  const t = new Topology();
  t.addDevice(SWITCH, 's1');
  t.addDevice(SWITCH, 's2');
  t.connect('s1', 'Fa0/1', 's2', 'Fa0/1');
  const sim = new Simulator(t);
  sim.computeStp();
  ok(/\sP2p$/.test(rowFor(t, sim, 's1', 'Fa0/1')), 'the 1 Gb end on s1', rowFor(t, sim, 's1', 'Fa0/1'));
  ok(/\sP2p$/.test(rowFor(t, sim, 's2', 'Fa0/1')), 'and the same cable on s2', rowFor(t, sim, 's2', 'Fa0/1'));
  ok(t.getDevice('s1').interfaces.get('Fa0/1').duplex === 'full',
    'the premise: the port is full duplex before anyone configures it');
}

console.log('\nA half-duplex port is a shared segment, and the two ends of a mismatch disagree:');
{
  const t = new Topology();
  t.addDevice(FAST, 'f1');
  t.addDevice(FAST, 'f2');
  t.connect('f1', '1', 'f2', '1');
  const sim = new Simulator(t);
  for (const id of ['f1', 'f2']) {
    runCommands(t.getDevice(id), t, sim,
      ['configure terminal', 'interface 1', 'speed 100', 'duplex half', 'end']);
  }
  sim.computeStp();
  // The 2530's ports are named `1`..`48` in the catalogue, and the row prints the port's stored name.
  ok(/\sShr$/.test(rowFor(t, sim, 'f1', '1')), 'both ends forced half read `Shr`', rowFor(t, sim, 'f1', '1'));
  ok(/\sShr$/.test(rowFor(t, sim, 'f2', '1')), 'on the far end too', rowFor(t, sim, 'f2', '1'));

  // One end forced half, the other left auto: a duplex mismatch, which a box reports as exactly this pair.
  const m = new Topology();
  m.addDevice(FAST, 'g1');
  m.addDevice(FAST, 'g2');
  m.connect('g1', '1', 'g2', '1');
  const ms = new Simulator(m);
  runCommands(m.getDevice('g1'), m, ms, ['configure terminal', 'interface 1', 'speed 100', 'duplex half', 'end']);
  ms.computeStp();
  ok(/\sShr$/.test(rowFor(m, ms, 'g1', '1')), 'the half-duplex end reads `Shr`', rowFor(m, ms, 'g1', '1'));
  ok(/\sP2p$/.test(rowFor(m, ms, 'g2', '1')), 'while its full-duplex peer reads `P2p`',
    rowFor(m, ms, 'g2', '1'));
}

console.log('\nA bundle is one row, and its link type is its members\' - which must agree:');
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
  const po = rowFor(t, sim, 's1', 'Po1');
  ok(!!po, 'the table names the bundle `Po1`', JSON.stringify(view(t, sim, 's1').rows));
  ok(/\sP2p$/.test(po), 'and a full-duplex bundle reads `P2p`', po);

  // `validateLag()` refuses members that differ on duplex, so the bundle's answer is its members' one answer.
  const h = new Topology();
  h.addDevice(FAST, 'h1');
  h.addDevice(FAST, 'h2');
  const hc = ['configure terminal'];
  for (const p of ['1', '2']) {
    h.connect('h1', p, 'h2', p);
    hc.push('interface ' + p, 'speed 100', 'duplex half', 'channel-group 1 mode active');
  }
  hc.push('end');
  const hs = new Simulator(h);
  for (const id of ['h1', 'h2']) runCommands(h.getDevice(id), h, hs, hc);
  hs.computeStp();
  ok(/\sShr$/.test(rowFor(h, hs, 'h1', 'Po1')), 'a half-duplex bundle reads `Shr`', rowFor(h, hs, 'h1', 'Po1'));
}

console.log('\nNothing is invented for a port the model has no answer for, and no `Edge` is claimed:');
{
  const t = new Topology();
  t.addDevice(SWITCH, 's1');
  t.addDevice(SWITCH, 's2');
  t.connect('s1', 'Fa0/1', 's2', 'Fa0/1');
  t.connect('s1', 'Fa0/2', 's2', 'Fa0/2');
  const sim = new Simulator(t);
  sim.computeStp();
  // A hand-edited document can carry no duplex at all; the cell must not default to `P2p`.
  t.getDevice('s1').interfaces.get('Fa0/2').duplex = null;
  ok(/\s-$/.test(rowFor(t, sim, 's1', 'Fa0/2')), 'a port with no duplex answer prints `-`',
    rowFor(t, sim, 's1', 'Fa0/2'));

  const text = view(t, sim, 's1').lines.join('\n');
  ok(!/\bEdge\b/.test(text), 'no row claims `Edge`: `spanning-tree portfast` is not a command this box has');
  ok(!/Prio\.Nbr/.test(text), 'and no `Prio.Nbr` column is invented (the port index is the platform\'s)');

  const cells = view(t, sim, 's1').rows.map(function (r) { return r.trim().split(/\s+/); });
  ok(cells.length === 2, 'the table has the two cabled rows', String(cells.length));
  ok(cells.every(function (c) { return c.length === 5; }), 'every row is five cells: name, role, sts, cost, type',
    JSON.stringify(cells));
  ok(cells.every(function (c) { return ['P2p', 'Shr', '-'].indexOf(c[4]) !== -1; }),
    'and the last cell is one of the three answers the model can defend', JSON.stringify(cells.map(function (c) { return c[4]; })));
  ok(cells.every(function (c) { return /^\d+$/.test(c[3]); }), 'the cost cell stays a bare number');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
