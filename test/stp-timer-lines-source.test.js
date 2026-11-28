'use strict';
// The two timer lines in the header print two different sets, and that is not a bug (#1724).
//
// `show spanning-tree` prints `Hello Time ... Max Age ... Forward Delay ...` twice. On a root both lines carry the
// root's own timers. On a non-root they carry different sets: the Root ID line carries the timers the root
// advertised in its BPDU, the Bridge ID line the timers this box has configured itself. Three captures show it -
// networkplayroom's lab (root given 10/40/30, non-root printing those above its own 2/20/15),
// keithcla.wordpress.com's (Forward Delay 4 over Forward Delay 15), and a Cisco community thread asking why the
// second block "is ignored" - because only the root's timers pace the tree.
// research/stp-timer-lines-source.md has them, plus the standard.
//
// This model knows both sets: `stpForwardDelaySec` / `stpMaxAgeSec` / `stpHelloSec` on a device's config, read by
// `stpTimers()`. So neither line is a literal, and the two are read from the two devices they describe.
const path = require('path');
const { loadCatalog } = require('../devices/registry');
const { Topology } = require('../engine/topology');
const { Simulator } = require('../engine/simulator');
const { CliSession } = require('../engine/cli');
const conv = require('../engine/convergence');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const specs = loadCatalog(path.join(__dirname, '..', 'devices')).filter(function (s) { return !s.error; });
const SW = specs.find(function (s) { return s.model === 'generic-switch'; });

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
// The Root ID block's timer line and the Bridge ID block's, in the order a box prints them.
function boxes(out) {
  const lines = out.filter(function (l) { return /Hello Time/.test(l); });
  return { root: lines[0], bridge: lines[1], count: lines.length };
}
const DEFAULT = '             Hello Time   2 sec  Max Age 20 sec  Forward Delay 15 sec';

console.log('');
console.log('An unconfigured pair prints the standard defaults on both lines');
{
  const env = pair();
  const b = boxes(show(env, 'sw1'));
  ok(b.count === 2, 'one timer line per block', String(b.count));
  ok(b.root === DEFAULT, 'the Root ID line', b.root);
  ok(b.bridge === DEFAULT, 'the Bridge ID line', b.bridge);
}

console.log('');
console.log('A non-root prints the root timers above, its own below - the capture');
{
  const env = pair();
  const rootKey = env.sim.stpResult.root.key;
  const otherKey = Array.from(env.t.devices.keys()).filter(function (k) { return k !== rootKey; })[0];
  const rootDev = env.t.getDevice(rootKey);
  rootDev.config.stpHelloSec = 10;
  rootDev.config.stpMaxAgeSec = 40;
  rootDev.config.stpForwardDelaySec = 30;
  const b = boxes(show(env, otherKey));
  ok(b.root === '             Hello Time   10 sec  Max Age 40 sec  Forward Delay 30 sec',
    'the Root ID line reads the root 10/40/30, as the networkplayroom capture does', b.root);
  ok(b.bridge === DEFAULT, 'the Bridge ID line keeps this box own 2/20/15, as the same capture does', b.bridge);
  ok(b.root !== b.bridge, 'so the two lines differ on a non-root, which is the whole point', b.root + ' / ' + b.bridge);
}

console.log('');
console.log('The root prints its own timers twice, and moves both lines together');
{
  const env = pair();
  const rootKey = env.sim.stpResult.root.key;
  env.t.getDevice(rootKey).config.stpMaxAgeSec = 10;
  const b = boxes(show(env, rootKey));
  ok(b.root === '             Hello Time   2 sec  Max Age 10 sec  Forward Delay 15 sec',
    'max age 10 on the Root ID line', b.root);
  ok(b.bridge === b.root, 'and the same number on the Bridge ID line, as a root prints it', b.bridge);
}

console.log('');
console.log('The line and the schedule read one number, not two copies of it');
{
  const env = pair();
  const dev = env.t.getDevice('sw1');
  dev.config.stpForwardDelaySec = 4;
  const b = boxes(show(env, 'sw1'));
  const shown = /Forward Delay ([0-9]+) sec/.exec(b.bridge)[1];
  const timers = conv.stpTimers(dev);
  ok(Number(shown) === timers.forwardDelaySec, 'the printed delay is the timer function answer', shown);
  ok(timers.forwardAtMs === 8000, 'which is the 8 s the schedule waits', String(timers.forwardAtMs));
  ok(String(timers.forwardAtMs / 2000) === shown, 'two forward delays, exactly as printed', String(timers.forwardAtMs / 2000));
}

console.log('');
console.log('stpTimers() carries the three fields the line prints');
{
  const t = conv.stpTimers({ config: { stpHelloSec: 1, stpMaxAgeSec: 6, stpForwardDelaySec: 4 } });
  ok(t.helloSec === 1, 'hello', String(t.helloSec));
  ok(t.maxAgeSec === 6, 'max age', String(t.maxAgeSec));
  ok(t.forwardDelaySec === 4, 'forward delay', String(t.forwardDelaySec));
  ok(t.maxAgeMs === 6000, 'and the millisecond form the schedule uses is the same number', String(t.maxAgeMs));
  const dflt = conv.stpTimers({});
  ok(dflt.helloSec === 2 && dflt.maxAgeSec === 20 && dflt.forwardDelaySec === 15,
    'the defaults are the 802.1D ones, not zeroes', JSON.stringify(dflt));
}

console.log('');
console.log('The ageing line is not the max age, even when the max age moves');
{
  const env = pair();
  const rootKey = env.sim.stpResult.root.key;
  env.t.getDevice(rootKey).config.stpMaxAgeSec = 10;
  const aging = show(env, rootKey).filter(function (l) { return /Aging Time/.test(l); });
  ok(aging.length === 1, 'one ageing line', String(aging.length));
  ok(/Aging Time  300 sec/.test(aging[0]), 'still the forwarding-database ageing, unmoved by the BPDU timer', aging[0]);
}

console.log('');
if (failed) { console.error(failed + ' failed, ' + passed + ' passed'); process.exit(1); }
console.log(passed + ' passed, 0 failed');
