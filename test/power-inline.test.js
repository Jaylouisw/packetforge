'use strict';
// power-inline.test.js — `show power inline`. PoE budgeting was enforced in
// computePoe() but the console could not answer "why is this camera dead": the
// only trace was a poe-deny event on the timeline.
const path = require('path');
const { Topology, Simulator, runCommands } = require('../engine');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg); }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
function spec(v, m) {
  const s = catalog.find(function (x) { return x.vendor === v && x.model === m; });
  if (!s) throw new Error('missing spec ' + v + '/' + m);
  return s;
}

function build() {
  const t = new Topology();
  const sw = t.addDevice(spec('aruba', 'CX 6000 24G CL4 PoE 4SFP 370W'));
  const pd1 = t.addDevice(spec('ubiquiti', 'UCG-Ultra'));
  const pd2 = t.addDevice(spec('ubiquiti', 'UCG-Ultra'));
  sw.name = 'SW1'; pd1.name = 'PD1'; pd2.name = 'PD2';
  t.connect(pd1.id, 'port1', sw.id, '1/1/1');
  t.connect(pd2.id, 'port1', sw.id, '1/1/2');
  return { t: t, sim: new Simulator(t), sw: sw, pd1: pd1, pd2: pd2 };
}
function show(env, dev, cmd) {
  return runCommands(dev, env.t, env.sim, ['enable', cmd]).lines.join('\n');
}

// Enough budget for both powered devices.
{
  const env = build();
  const draw = env.pd1.interfaces.get('port1').poeIn;
  const out = show(env, env.sw, 'show power inline');
  ok(/Power inline on SW1/.test(out), 'the PSE names itself');
  ok(/Budget\s+: 370 W\s+\(from research\)/.test(out), 'the budget and where it came from');
  ok(new RegExp('Used\\s+: ' + (draw * 2)).test(out), 'total draw is both devices');
  ok(/Available\s+: 344\.1 W/.test(out), 'the headroom is the remainder');
  ok(/Port\s+Powered device\s+Requested\s+Status/.test(out), 'the per-port table has a header');
  ok(/1\/1\/1\s+PD1\s+12\.95 W\s+on/.test(out), 'the first port powers PD1');
  ok(/1\/1\/2\s+PD2\s+12\.95 W\s+on/.test(out), 'the second port powers PD2');
  ok(!/denied/.test(out), 'nothing is denied when the budget covers everything');

  const pdView = show(env, env.pd1, 'show power inline');
  ok(/port1\s+12\.95 W from SW1 port 1\/1\/1 - powered/.test(pdView), 'the PD reports what feeds it, and from where');
  ok(!/no PSE answers/.test(pdView), 'and stays quiet about its unconnected PoE ports');
}

// Budget too small for both: the second is denied, and both ends say so.
{
  const env = build();
  env.sw.poeBudget = 25;
  const out = show(env, env.sw, 'show power inline');
  ok(/Budget\s+: 25 W/.test(out), 'the narrowed budget is reported');
  ok(/denied \(budget exhausted\)/.test(out), 'the port that missed out is marked denied');
  ok(/Available\s+: 12\.1 W/.test(out), 'with the leftover reported honestly (12.1 W cannot cover 12.95 W)');

  const powered = env.pd1.interfaces.get('port1');
  const stripped = env.pd2.interfaces.get('port1');
  ok(powered && stripped, 'both PD ports exist');
  const okPd = show(env, env.pd1, 'show power inline');
  const deadPd = show(env, env.pd2, 'show power inline');
  const states = [okPd, deadPd].map(function (s) { return /- powered/.test(s); });
  ok(states.filter(Boolean).length === 1, 'exactly one PD reports being powered');
  ok(/- denied \(PSE budget exhausted\)/.test(okPd + deadPd), 'the other names the PSE budget as the reason');
  ok(env.pd1.poeUnpowered !== env.pd2.poeUnpowered, 'and the engine marked exactly one of them unpowered');
}

// PoE-capable ports with no budget at all.
{
  const env = build();
  env.sw.poeBudget = 0;
  const out = show(env, env.sw, 'show power inline');
  ok(/has 24 PoE-capable port\(s\) but no power budget/.test(out), 'a budget of zero is called out, not shown as a table');
  ok(/none of them can source power/.test(out), 'and says what that means');
}

// A device with no PoE at all.
{
  const t = new Topology();
  const r = t.addDevice(spec('generic', 'generic-router'));
  r.name = 'R1';
  const sim = new Simulator(t);
  const out = runCommands(r, t, sim, ['enable', 'show power inline']).lines.join('\n');
  ok(/% R1 neither sources nor draws PoE/.test(out), 'a plain router says it has no PoE');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
