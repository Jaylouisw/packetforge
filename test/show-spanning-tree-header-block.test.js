'use strict';
// `show spanning-tree` opens with the two blocks a Catalyst prints, not with a sentence of this console's own
// (#1713).
//
// The header used to be one line - `Bridge priority 4096 (this bridge is the root), root bridge core-sw1 priority
// 4096` - and no box prints it. A Catalyst asked for its tree opens with `VLAN0001`, the protocol line, a Root ID
// block (the extended priority, the root's bridge address, and then either `This bridge is the root` or the cost
// and port a non-root pays) and a Bridge ID block (the priority with its `sys-id-ext` half spelled out, the box's
// own address, the three BPDU timers, and the forwarding-database ageing). The old sentence carried no address,
// no cost and no timers, so the half of the report that explains why the election came out as it did was missing.
//
// This file pins the block against the capture transcribed in research/show-spanning-tree-header-block.md: the
// line order, the column every value starts in, the numbers, and the three cases that are not an ordinary
// election - a priority somebody set, a console with no simulator behind it, and a box that is not a bridge.
const path = require('path');
const { loadCatalog } = require('../devices/registry');
const { Topology } = require('../engine/topology');
const { Simulator } = require('../engine/simulator');
const { CliSession } = require('../engine/cli');
const { MAC_AGE_MS } = require('../engine/device');
const net = require('../engine/net');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const specs = loadCatalog(path.join(__dirname, '..', 'devices')).filter(function (s) { return !s.error; });
// A Cisco-shaped eight-port switch: the port table and the `Port` line print `FastEthernet0/1`, the long name a
// box uses when the port is the subject of a line rather than a table cell.
const SW = specs.find(function (s) { return s.model === 'generic-switch'; });
const ROUTER = specs.find(function (s) { return /ISR 4331/.test(s.model); });

function pair() {
  const t = new Topology();
  t.addDevice(SW, 'sw1'); t.addDevice(SW, 'sw2');
  t.connect('sw1', 'Fa0/1', 'sw2', 'Fa0/1', { mediaId: '1000base-t', speedMbps: 1000 });
  const sim = new Simulator(t);
  sim.setRunTime(60000);
  sim.recomputeStp();
  return { t: t, sim: sim };
}
function show(env, id) {
  const cli = new CliSession(env.t.getDevice(id), env.t, env.sim);
  cli.run('enable');
  return cli.run('show spanning-tree').output || [];
}

const TIMERS = '             Hello Time   2 sec  Max Age 20 sec  Forward Delay 15 sec';

console.log('');
console.log('The root prints the two blocks a Catalyst prints, in its order');
{
  const env = pair();
  const out = show(env, 'sw1');
  const rootMac = net.formatMac(env.t.getDevice('sw1').lowestInterfaceMac());
  ok(out[0] === 'VLAN0001', 'the report opens with the VLAN line, as a box does', out[0]);
  ok(out[1] === '  Spanning tree enabled protocol ieee', 'then the protocol line', out[1]);
  ok(out[2] === '  Root ID    Priority    32769', 'then the Root ID block, extended priority first', out[2]);
  ok(out[3] === '             Address     ' + rootMac, "with the root's bridge address under it", out[3]);
  ok(out[4] === '             This bridge is the root', "and the root saying so, in the box's own words", out[4]);
  ok(out[5] === TIMERS, 'then the three BPDU timers', out[5]);
  ok(out[6] === '', 'a blank line ends the Root ID block', JSON.stringify(out[6]));
  ok(out[7] === '  Bridge ID  Priority    32769  (priority 32768 sys-id-ext 1)',
    'the Bridge ID block spells the extended priority into the two numbers it is made of', out[7]);
  ok(out[8] === '             Address     ' + rootMac, "then this box's own address", out[8]);
  ok(out[9] === TIMERS, 'the same three timers for the bridge ID', out[9]);
  ok(out[10] === '             Aging Time  300 sec', 'and the forwarding-database ageing', out[10]);
  ok(out[11] === '', 'a blank line before the port table', JSON.stringify(out[11]));
  ok(/^Interface +Role Sts Cost/.test(out[12]), 'then the port table, unchanged', out[12]);
}

console.log('');
console.log('No label no box prints, and no number this model did not compute');
{
  const env = pair();
  const out = show(env, 'sw1');
  const text = out.join(' ');
  ok(!/root bridge/.test(text), 'the invented `root bridge <name> priority <n>` label is gone', text);
  ok(!/Bridge priority /.test(text), 'and so is `Bridge priority <n>`, which no block prints', text);
  ok(!/[A-Z][a-z]+ CX /.test(text), 'no catalogue model label reaches the block', text);
  ok(out[10].slice(25) === String(Math.round(MAC_AGE_MS / 1000)) + ' sec',
    "the ageing line is the model's own timer, read rather than typed in twice", out[10]);
  ok(out[10].indexOf(' 20 ') === -1, 'and it is not the max age, which is a different timer', out[10]);
}

console.log('');
console.log('Every field sits in the column the capture puts it in');
{
  const env = pair();
  const out = show(env, 'sw1');
  ok(out[2].slice(0, 13) === '  Root ID    ', 'the Root ID label starts in column 3 and ends in column 13',
    JSON.stringify(out[2]));
  ok(out[2].slice(13, 21) === 'Priority' && out[2].slice(25) === '32769',
    'its value starts in column 26, in the field the label pads out to', JSON.stringify(out[2]));
  ok(out[3].slice(13, 20) === 'Address' &&
    out[3].slice(25) === net.formatMac(env.t.getDevice('sw1').lowestInterfaceMac()),
    'and so does every Address line', JSON.stringify(out[3]));
  ok(out[7].slice(0, 13) === '  Bridge ID  ', 'the Bridge ID label occupies the same thirteen columns',
    JSON.stringify(out[7]));
}

console.log('');
console.log('A non-root prints what it pays to reach the root');
{
  const env = pair();
  const out = show(env, 'sw2');
  const rootMac = net.formatMac(env.t.getDevice('sw1').lowestInterfaceMac());
  const ownMac = net.formatMac(env.t.getDevice('sw2').lowestInterfaceMac());
  ok(out[2] === '  Root ID    Priority    32769', 'the same Root ID priority as the root', out[2]);
  ok(out[3] === '             Address     ' + rootMac, "the root's address, not its own", out[3]);
  ok(out[4] === '             Cost        4', 'the cost of the whole path to the root, in the short method', out[4]);
  ok(out[5] === '             Port        1 (FastEthernet0/1)',
    'and the root port, by number and by the long name a box uses in a sentence', out[5]);
  // The Cost and Port lines make the non-root block one line longer than the root's, so the Bridge ID block
  // starts at 8 here.
  ok(out[8] === '  Bridge ID  Priority    32769  (priority 32768 sys-id-ext 1)', 'its own bridge ID', out[8]);
  ok(out[9].slice(25) === ownMac, "and its own address, which is not the root's", out[9]);
  // The number in the `Port` line is the same ordinal the table's `Prio.Nbr` cell prints for that row, so the two
  // halves of the report cannot name the root port by different numbers.
  const row = out.filter(function (l) { return l.indexOf('Fa0/1') === 0; })[0] || '';
  ok(row.indexOf('128.1') !== -1, "the Port line's number is the table row's Prio.Nbr ordinal", row);
  ok(out.join(' ').indexOf('This bridge is the root') === -1, 'a non-root does not claim to be the root', row);
}

console.log('');
console.log('Each timer line reads the timers it belongs to, not a literal');
{
  // Both lines used to be one literal - `Hello Time   2 sec  Max Age 20 sec  Forward Delay 15 sec` typed in twice -
  // while the forward delay and max age on the device config already paced the ports. A fixture with a 4 s forward
  // delay forwarded its ports at 8 s and its own report told the reader 15 (#1724).
  //
  // A real box prints two *different* sets: the Root ID block carries the root's timers (they arrive in the root's
  // configuration BPDU, and only those pace the tree), the Bridge ID block this box's own configuration. The
  // fixture is the networkplayroom shape from research/stp-timer-lines-source.md - root 10/40/30 over a local
  // 2/20/15 - which is the pair a capture shows on one screen.
  const env = pair();
  const conv = require('../engine/convergence');
  const root = env.t.getDevice('sw1');
  const local = env.t.getDevice('sw2');
  root.config.stpPriority = 4096;
  root.config.stpHelloSec = 10;
  root.config.stpMaxAgeSec = 40;
  root.config.stpForwardDelaySec = 30;
  local.config.stpForwardDelaySec = 4;

  const rootOut = show(env, 'sw1');
  const rootLine = '             Hello Time  10 sec  Max Age 40 sec  Forward Delay 30 sec';
  ok(rootOut[5] === rootLine, 'a root prints its own timers on the Root ID line', rootOut[5]);
  ok(rootOut[9] === rootLine, 'and the same ones on the Bridge ID line, as a box does', rootOut[9]);

  const out = show(env, 'sw2');
  ok(out[6] === rootLine, "a non-root prints the root's timers on the Root ID line", out[6]);
  ok(out[6].indexOf('Hello Time  10') === 13,
    'a two-digit hello keeps the columns: two spaces after the label',
    JSON.stringify(out[6]));
  ok(out[10] === '             Hello Time   2 sec  Max Age 20 sec  Forward Delay 4 sec',
    'and its own configuration on the Bridge ID line, forward delay and all', out[10]);
  ok(out.slice(6, 11).indexOf(rootLine) !== -1 && out[10] !== rootLine,
    'the two lines are read separately, not printed twice from one literal',
    JSON.stringify([out[6], out[10]]));

  // The number in the report is the number the ports converge on: one function, `stpTimers()`, feeds both. This
  // is the assertion the literal failed - it called the delay 15 while the same device's table forwarded at 8 s.
  const printed = Number(/Forward Delay (\d+) sec/.exec(out[10])[1]);
  ok(printed === conv.stpTimers(local).forwardDelaySec,
    'the printed forward delay is the one `stpTimers()` returns', String(printed));
  ok(conv.stpPortStateAt(local, true, printed * 2000) === 'forwarding',
    'and the instant the report implies is the instant the port forwards at', String(printed * 2000));
  ok(conv.stpPortStateAt(local, true, printed * 2000 - 1) === 'learning',
    'one millisecond earlier it is still learning', String(printed * 2000 - 1));
}

console.log('');
console.log('A priority somebody set moves the extended half of the bridge ID');
{
  const env = pair();
  const cli = new CliSession(env.t.getDevice('sw1'), env.t, env.sim);
  cli.run('enable');
  cli.run('configure terminal');
  cli.run('spanning-tree priority 4096');
  const out = (cli.run('show spanning-tree').output || []);
  ok(out[2] === '  Root ID    Priority    4097', 'the Root ID block prints 4096 plus the VLAN number', out[2]);
  ok(out[7] === '  Bridge ID  Priority    4097  (priority 4096 sys-id-ext 1)',
    'and the Bridge ID block says which two numbers made it', out[7]);
  ok(out[4] === '             This bridge is the root', 'and the box is the root now', out[4]);
}

console.log('');
console.log('A console with no simulator behind it prints what it knows and says what it does not');
{
  const env = pair();
  const ownMac = net.formatMac(env.t.getDevice('sw2').lowestInterfaceMac());
  const bare = new CliSession(env.t.getDevice('sw2'), env.t, null);
  bare.run('enable');
  const out = (bare.run('show spanning-tree').output || []);
  ok(out[0] === 'VLAN0001', 'the block still opens with its VLAN line', out[0]);
  ok(out[2] === '  Root ID    Priority    -', 'with no election, no priority is invented', out[2]);
  ok(out[3] === '             Address     -', 'nor a root address', out[3]);
  ok(out[4] === '             root bridge not measured (no election has run)',
    'the line says what is missing rather than guessing a root', out[4]);
  ok(/[(]priority 32768 sys-id-ext 1[)]/.test(out[7]), 'the bridge ID it does know is still printed', out[7]);
  ok(out[8].slice(25) === ownMac, "with the box's own address, from the device rather than from an election", out[8]);
  // No root has spoken, so the Root ID line has no root's timers to carry and the box prints what it is configured
  // with on both - its own numbers, not a second literal (#1724).
  ok(out[5] === TIMERS && out[9] === TIMERS,
    'with no election, both lines read the timers this box is configured with', JSON.stringify([out[5], out[9]]));
}

console.log('');
console.log('A box that is not a bridge still answers with its one line');
{
  const t = new Topology();
  t.addDevice(ROUTER, 'r1');
  const cli = new CliSession(t.getDevice('r1'), t, new Simulator(t));
  cli.run('enable');
  const out = (cli.run('show spanning-tree').output || []);
  ok(out.length === 1 && out[0] === 'No spanning tree instance exists.',
    "a router prints the box's sentence and nothing else", JSON.stringify(out));
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
