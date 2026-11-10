'use strict';
// port-addressing.test.js — one resolver, every command.
//
// The front panel and the vendor console disagree about what a socket is called: MikroTik
// silkscreens "SFP+1" and calls it "sfp-sfpplus1". `iface-name.js` exists to fold those
// spellings onto one key, and `Topology.connect()` and the config parser both use it — but
// the show commands compared the token to the panel name themselves, so:
//
//   * `show interfaces ether1` accepted the argument and then ignored it, printing every
//     port on the box. That is worse than a refusal, because it looks like an answer.
//   * `show interfaces transceiver sfp-sfpplus1` refused a port the parser would have
//     accepted two commands earlier.
//
// Both now go through the resolver, and these assertions hold the line: the same socket,
// whichever spelling you learned.
const path = require('path');
const { Topology, Simulator, runCommands } = require('../engine');
const { loadCatalog } = require('../devices/registry');
const ifaceName = require('../engine/iface-name');

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

// A RouterOS box: panel names 'eth1' and 'SFP+1', console names 'ether1' and 'sfp-sfpplus1'.
const t = new Topology();
const r1 = t.addDevice(model('CCR1009-7G-1C-1S+'));
r1.name = 'R1';
const sim = new Simulator(t);
function run(commands) {
  return runCommands(r1, t, sim, commands).lines.filter(function (l) {
    return !/[>#](show\b|enable|configure\b|interface\b|ip\b|hostname|$)/.test(l);
  });
}
const show = function (cmd) { return run([cmd]); };

console.log('The device really has two spellings for these ports:');
{
  ok(r1.interfaces.has('eth1'), 'the panel silkscreen calls the port eth1');
  ok(r1.interfaces.has('SFP+1'), 'and the other SFP+1');
  eq(ifaceName.resolvePortName(r1, 'ether1'), 'eth1', 'the console spelling resolves to eth1');
  eq(ifaceName.resolvePortName(r1, 'sfp-sfpplus1'), 'SFP+1', 'and sfp-sfpplus1 to SFP+1');
}

console.log('\nshow interfaces <port> answers for that port, not the whole box:');
{
  const one = show('show interfaces ether1');
  ok(one.length > 0, 'the command answers');
  // Seven lines: the port header, its status, its address, three counter lines (input, output, drops)
  // and its peer. The counters were added after this suite was written, which is why the count is
  // spelled out rather than left as ">0": a line appearing unannounced in this block is a change to a
  // command's shape and should be a decision, not a surprise.
  eq(one.length, 7, 'seven lines: port, status, address, input, output, drops, peer');
  ok(one.some((l) => /^  input : /.test(l)) && one.some((l) => /^  output: /.test(l)),
    'the counter lines are among them');
  ok(one[0].indexOf('eth1 ') === 0, 'and they are eth1\'s lines: ' + one[0]);
  ok(!one.some(function (l) { return /^eth2 /.test(l); }), 'no other port is printed');

  // The panel spelling and the console spelling are the same answer.
  eq(show('show interfaces eth1').join('\n'), one.join('\n'),
    'the panel spelling gives the identical answer');

  // No argument still means every port - that is the regression guard.
  const all = show('show interfaces');
  ok(all.length > 4, 'without a port it still lists everything (' + all.length + ' lines)');
  eq(all.length, r1.interfaces.size * 7, 'seven lines per port');
}

console.log('\nAn unknown port is refused by name, not silently ignored:');
{
  const lines = show('show interfaces bogus9');
  eq(lines.length, 2, 'two lines: what was refused, and what to try');
  ok(/^% No interface named bogus9 on R1$/.test(lines[0]), 'the refusal quotes the token: ' + lines[0]);
  ok(/show ip interface brief/.test(lines[1]), 'and points at a command that lists the real ports');
}

console.log('\nshow interfaces transceiver accepts either spelling:');
{
  const panel = show('show interfaces transceiver SFP+1');
  const console1 = show('show interfaces transceiver sfp-sfpplus1');
  eq(console1.join('\n'), panel.join('\n'), 'the two spellings give the identical record');
  ok(/^SFP\+1 \(ethernet, sfp\+\) - transceiver/.test(panel[0]),
    'and the heading names the port by its panel name: ' + panel[0]);

  // A bay that exists on the box but is not SFP+ still resolves and answers.
  const combo = show('show interfaces transceiver COMBO1');
  ok(/^COMBO1 \(/.test(combo[0]), 'a second bay answers for its own name');
}

console.log('\nAn unknown transceiver port lists the bays instead of all of them:');
{
  const lines = show('show interfaces transceiver bogus9');
  eq(lines.length, 1, 'one line, not a table of everything');
  ok(/^% No transceiver port named bogus9 on R1/.test(lines[0]), 'the refusal quotes the token');
  ok(/module bays: .*SFP\+1/.test(lines[0]), 'and lists the bays that do exist: ' + lines[0]);
}

console.log('\nThe config parser and the show commands agree on what exists:');
{
  // If config accepts a spelling, the show commands must accept it too - that is the
  // whole point, and this is the assertion that would have caught the original split.
  const configurable = run(['configure terminal', 'interface ether1', 'description uplink']);
  ok(!configurable.some(function (l) { return /^%/.test(l); }),
    'config accepts "interface ether1"');
  ok(/^eth1/.test(show('show interfaces ether1')[0]), 'and show accepts the same token');

  const refused = run(['configure terminal', 'interface bogus9']);
  ok(refused.some(function (l) { return /^%/.test(l); }), 'config refuses a port that does not exist');
  ok(show('show interfaces bogus9').some(function (l) { return /^%/.test(l); }),
    'and so does show - neither invents a port');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
