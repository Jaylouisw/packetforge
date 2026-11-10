'use strict';
// instant.test.js — `at <ms>` and the fact that it sticks.
//
// Asking at an instant sets the time the simulator answers at, and it stays set: it
// belongs to the run, not to the one command. That is the right model ("what does the
// network do at t=X" is a question about a state) but it is a trap in practice — ask
// once at t=0, before anything has converged, and every command afterwards fails for a
// reason that is no longer on screen. `at converged` is the way back, and this pins it
// on all three data-path commands.
const path = require('path');
const { Topology, Simulator, runCommands } = require('../engine');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg); }
}
function eq(actual, expected, msg) {
  ok(actual === expected, msg + (actual === expected ? '' : ' (got ' + JSON.stringify(actual) +
    ', want ' + JSON.stringify(expected) + ')'));
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
function model(name) { return catalog.find(function (x) { return x.model === name; }); }

// The VIP makes the instant observable: at t=0 nobody owns it, later somebody does.
function build() {
  const topo = new Topology();
  const pc = topo.addDevice(model('generic-pc'));
  const r1 = topo.addDevice(model('generic-router'));
  const r2 = topo.addDevice(model('generic-router'));
  pc.name = 'PC1'; r1.name = 'R1'; r2.name = 'R2';
  topo.connect(pc.id, 'eth0', r1.id, 'Gi0/0');
  topo.connect(r1.id, 'Gi0/1', r2.id, 'Gi0/1');
  const sim = new Simulator(topo);
  function run(dev, cmds) { return runCommands(dev, topo, sim, cmds).lines; }
  run(pc, ['configure terminal', 'interface eth0', 'ip address 10.0.1.10 255.255.255.0',
    'exit', 'ip default-gateway 10.0.1.1', 'hostname PC1']);
  run(r1, ['configure terminal', 'interface Gi0/0', 'ip address 10.0.1.1 255.255.255.0',
    'vrrp 1 ip 10.0.1.100', 'vrrp 1 priority 200', 'exit',
    'interface Gi0/1', 'ip address 10.0.12.1 255.255.255.0', 'exit', 'hostname R1']);
  run(r2, ['configure terminal', 'interface Gi0/1', 'ip address 10.0.12.2 255.255.255.0',
    'vrrp 1 ip 10.0.1.100', 'vrrp 1 priority 100', 'exit', 'hostname R2']);
  return { topo: topo, sim: sim, run: run, pc: pc };
}

function clean(lines) {
  return lines.filter(function (l) { return !/^[A-Za-z0-9._()\/-]*[>#]/.test(l); });
}

console.log('An instant is a property of the run, and it persists:');
{
  const L = build();
  const early = clean(L.run(L.pc, ['enable', 'ping 10.0.1.100 at 0']));
  ok(/\(at t=0 ms\)/.test(early[1]), 'the header names the instant that was asked for');
  ok(/^\.+$/.test(early[2]), 'at t=0 the election has not run, so the echoes fail');
  eq(L.sim.runAtMs, 0, 'and the simulator is left answering at that instant');

  const plain = clean(L.run(L.pc, ['enable', 'ping 10.0.1.100']));
  ok(/^\.+$/.test(plain[2]), 'a later plain ping still answers at t=0 - the instant stuck');
  ok(!/\(at /.test(plain[1]), 'even though its own header does not mention an instant');
}

console.log('\n`at converged` is the way back:');
{
  const L = build();
  clean(L.run(L.pc, ['enable', 'ping 10.0.1.100 at 0']));

  const back = clean(L.run(L.pc, ['enable', 'ping 10.0.1.100 at converged']));
  ok(/\(at converged\)/.test(back[1]), 'the header says "converged", not "t=Infinity ms"');
  ok(/^!+$/.test(back[2]), 'and the VIP answers again');
  eq(L.sim.runAtMs, Infinity, 'the simulator is back to its default of "everything has finished"');

  const plain = clean(L.run(L.pc, ['enable', 'ping 10.0.1.100']));
  ok(/^!+$/.test(plain[2]), 'so an ordinary command works without repeating the keyword');
}

console.log('\nEvery data-path command takes it:');
{
  const L = build();
  const tr = clean(L.run(L.pc, ['enable', 'traceroute 10.0.1.100 at converged']));
  ok(/\(at converged\)/.test(tr[1]), 'traceroute says converged');
  ok(tr.join('\n').indexOf('10.0.1.100') !== -1, 'and traces to the VIP');

  const fl = clean(L.run(L.pc, ['enable', 'flow open 10.0.1.100 port 22 at converged']));
  ok(/\(at converged\)$/.test(fl[0]), 'flow open says converged');
  ok(/^Flow flow-\d+ opened:/.test(fl[0]), 'and opens');

  // `infinity` / `inf` are accepted spellings of the same thing.
  const inf = clean(L.run(L.pc, ['enable', 'ping 10.0.1.100 at infinity']));
  ok(/\(at converged\)/.test(inf[1]), 'at infinity is reported as converged');
  const inf2 = clean(L.run(L.pc, ['enable', 'ping 10.0.1.100 at inf']));
  ok(/\(at converged\)/.test(inf2[1]), 'and so is at inf');
}

console.log('\nA value that is not an instant is refused, not guessed at:');
{
  const L = build();
  const cases = [
    ['ping 10.0.1.100 at soon', /^% Invalid instant: soon$/],
    ['ping 10.0.1.100 at', /^% Invalid instant: \(none\)$/],
    ['ping 10.0.1.100 at -5', /^% Invalid instant: -5$/],
    ['traceroute 10.0.1.100 at soon', /^% Invalid instant: soon$/],
    ['flow open 10.0.1.100 at soon', /^% Invalid instant: soon$/]
  ];
  for (const [command, pattern] of cases) {
    const lines = clean(L.run(L.pc, ['enable', command]));
    ok(pattern.test(lines[0]), command + ' -> ' + lines[0]);
  }
  eq(L.sim.runAtMs, Infinity, 'a refused command changes nothing about the instant');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
