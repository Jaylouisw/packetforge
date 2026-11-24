'use strict';
// `show spanning-tree`'s `Prio.Nbr` cell is `128.<the port's place in the chassis port table>` (#2580).
//
// The column was missing from this table because the number is not a function of the port's name: `Gi0/1`
// reads `128.1` on a Catalyst 1200 and `128.25` on a 24-port 2960. It is a function of the port's *place*,
// and on a single-unit box - every model in this catalogue - the place is the ordinal in the front-panel
// list. Three captures of the shape this catalogue is full of, and one machine-recorded session, agree:
//
//   Fa0/13 128.13, Gi0/1 128.25, Gi0/2 128.26       (Pearson, CCNA Portable Command Guide, appendix B)
//   Gi1/0/24 128.24 ... Gi1/0/27 128.27             (community.cisco.com/t5/switching/
//                                                     root-bridge-has-backup-port/td-p/4818830)
//   Gi0/25 128.25 ... Gi0/27 128.27                 (community.cisco.com/t5/switching/
//                                                     spanning-tree-between-4-connected-switches/td-p/2546434)
//   Gi0/2 128.3, Gi0/3 128.4, Gi1/0 128.5           (ntc-templates, cisco_ios_show_spanning_tree.raw - a
//                                                     machine-recorded session, so the spacing survived)
//
// research/stp-port-table-prio-nbr-column.md holds the sources, the affine `base(module) + port` rule this
// ordinal is the single-unit case of, and the two shapes the console still refuses to number.
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

const HEADER = 'Interface           Role Sts Cost      Prio.Nbr Type';

function view(t, sim, devId) {
  const lines = new CliSession(t.getDevice(devId), t, sim).run('show spanning-tree').output.map(String);
  const at = lines.indexOf(HEADER);
  const rows = [];
  for (let i = at + 2; at !== -1 && i < lines.length; i++) {
    if (!/^\S/.test(lines[i])) break;
    rows.push(lines[i]);
  }
  return { lines: lines, at: at, rows: rows, rule: at !== -1 ? lines[at + 1] : '' };
}
function rowFor(t, sim, devId, name) {
  return view(t, sim, devId).rows.filter(function (r) { return r.indexOf(name + ' ') === 0; })[0] || '';
}

// ---------------------------------------------------------------------------
console.log("The cell is the port's place in the chassis table, counted off the front panel:");
{
  // The 24-downlink + 4-SFP shape: the uplinks continue the numbering, 128.25 and up, as both captures of a
  // 2960 with SFP uplinks print them.
  const shape = spec('C2960X-24TS-L');
  const t = new Topology();
  t.addDevice(shape, 's1');
  t.addDevice(shape, 's2');
  t.connect('s1', 'Gi1/0/1', 's2', 'Gi1/0/1');
  t.connect('s1', 'Gi1/0/25', 's2', 'Gi1/0/25');
  const sim = new Simulator(t);
  sim.computeStp();
  const v = view(t, sim, 's1');
  ok(v.at !== -1, "the table is headed `Prio.Nbr`, in the capture's own column", JSON.stringify(v.lines));
  ok(v.rule === '------------------- ---- --- --------- -------- -------',
    'the field is 9 wide, its rule run 8 dashes, as the capture draws it', v.rule);
  const first = rowFor(t, sim, 's1', 'Gi1/0/1');
  ok(first.slice(39, 48) === '128.1    ', 'the first downlink reads `128.1` in a 9-wide field',
    JSON.stringify(first));
  ok(first.slice(48) === 'P2p', 'and `Type` starts at column 49, where the capture puts it', JSON.stringify(first));
  const uplink = rowFor(t, sim, 's1', 'Gi1/0/25');
  ok(uplink.slice(39, 48).trim() === '128.25',
    'the 25th port reads `128.25` - the uplinks continue the downlinks, they do not restart at 1',
    JSON.stringify(uplink));
}

console.log('\nA combo uplink is one position with two front ends, so it takes one number:');
{
  // C1000-8P-2G-L: eight copper ports, then Gi1/0/9 and Gi1/0/10 each with an `-sfp` twin. A real box has ten
  // front-panel positions here, so the split halves must not push the numbers along.
  const combo = spec('C1000-8P-2G-L');
  const t = new Topology();
  const dev = t.addDevice(combo, 's1');
  const comboAndTwin = [...dev.interfaces.values()].filter(function (p) { return p.comboWith; });
  ok(comboAndTwin.length === 4, 'the premise: this model declares two combo positions, four interfaces',
    String(comboAndTwin.length));
  const ordinals = stpLib.portOrdinals(dev);
  ok(ordinals['Gi1/0/9'] === 9, 'the RJ45 half of the first combo reads 9', String(ordinals['Gi1/0/9']));
  ok(ordinals['Gi1/0/9-sfp'] === 9, 'and its SFP half reads the same 9, not 10', String(ordinals['Gi1/0/9-sfp']));
  ok(ordinals['Gi1/0/10'] === 10, 'the next position is still 10', String(ordinals['Gi1/0/10']));
  ok(Object.keys(ordinals).length === 12, 'every interface gets an answer or shares one - none is skipped',
    String(Object.keys(ordinals).length));
}

console.log('\nA port that is not an Ethernet front end takes no place in the table:');
{
  // A console line is not a bridge port, so it is not a position: a model file that lists the console first
  // still numbers its first Ethernet port 1.
  const fake = { interfaces: new Map([
    ['Console', { name: 'Console', type: 'console' }],
    ['gw0', { name: 'gw0', type: 'ethernet' }],
    ['lan1', { name: 'lan1', type: 'ethernet' }],
    ['wlan0', { name: 'wlan0', type: 'wireless' }],
    ['lan2', { name: 'lan2', type: 'ethernet' }]
  ]) };
  const ordinals = stpLib.portOrdinals(fake);
  ok(ordinals.Console === undefined && ordinals.wlan0 === undefined,
    'the console and the radio have no place', JSON.stringify(ordinals));
  ok(ordinals.gw0 === 1 && ordinals.lan1 === 2 && ordinals.lan2 === 3,
    'and the three Ethernet ports are 1, 2, 3 regardless of what sits between them', JSON.stringify(ordinals));
  ok(Object.keys(stpLib.portOrdinals(null)).length === 0,
    'a device with no ports answers nothing rather than throwing');
}

console.log("\nA bundle has a port ID too, but it is the platform's own, so the cell stays `-`:");
{
  const SWITCH = spec('generic-switch');
  const t = new Topology();
  t.addDevice(SWITCH, 's1');
  t.addDevice(SWITCH, 's2');
  t.connect('s1', 'Fa0/1', 's2', 'Fa0/1');
  t.connect('s1', 'Fa0/2', 's2', 'Fa0/2');
  const sim = new Simulator(t);
  const cfg = ['configure terminal',
    'interface Fa0/1', 'channel-group 1 mode active',
    'interface Fa0/2', 'channel-group 1 mode active', 'end'];
  runCommands(t.getDevice('s1'), t, sim, cfg);
  runCommands(t.getDevice('s2'), t, sim, cfg);
  sim.computeStp();
  const po = rowFor(t, sim, 's1', 'Po1');
  ok(!!po, 'the bundle has a row', JSON.stringify(view(t, sim, 's1').rows));
  ok(po.slice(39, 48).trim() === '-',
    'its `Prio.Nbr` cell is `-`: 128.20, 128.65 and 128.3433 in three captures is not a rule', JSON.stringify(po));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
