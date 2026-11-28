'use strict';
// A box that is not a bridge answers `show spanning-tree` with the box's own sentence.
//
// This console used to answer a router (and every other non-bridge model) with an explanation of its own:
//
//   Spanning tree is not running on this device: it is not a bridge (no L2 forwarding).
//
// Nothing on the hardware prints that. An IOS/IOS XE router asked for a tree prints one line -
// `No spanning tree instance exists.` - and the reports that do print it are the same sentence on routers with
// no bridging configured, on routers whose only L2 path is a bridge domain, and on a switch whose VLAN has no
// instance up. The captures are in `research/stp-no-instance-wording.md`.
//
// The explanation was true, but it is the console's, not the device's: an operator diffing a lab against a
// router sees a sentence the router never says, which is the defect this file pins. What the sentence must
// still not do is claim a tree - so the checks below look for the root, the election and the protocol word as
// well as for the words themselves.
const path = require('path');
const { CliSession } = require('../engine/cli');
const { Topology } = require('../engine/topology');
const { Simulator } = require('../engine/simulator');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices')).filter(function (s) { return !s.error; });
const pick = function (re) { return catalog.filter(function (s) { return re.test(s.model); })[0]; };
const ROUTER = pick(/^ISR 4331$/);
const HOST = pick(/^Raspberry Pi 5$/);
const SWITCH = pick(/CX 6000 24G CL4/);

const BOX_SENTENCE = 'No spanning tree instance exists.';

// The line the vendor prints, spelled out here rather than taken from the engine, so a change to either side
// shows up as a failure instead of agreeing with itself.
function show(spec, cmd, id) {
  const t = new Topology();
  t.addDevice(spec, id || 'd1');
  const sim = new Simulator(t);
  sim.setRunTime(0);                       // the state an operator sees first: powered on, nothing has happened
  const cli = new CliSession(t.getDevice(id || 'd1'), t, sim);
  return cli.run(cmd).output || [];
}

console.log('A router asked for a spanning tree gives the box\'s answer, and only it');
{
  const out = show(ROUTER, 'show spanning-tree');
  ok(out.length === 1, 'one line, not a paragraph', JSON.stringify(out));
  ok(out[0] === BOX_SENTENCE, 'the sentence is `' + BOX_SENTENCE + '` word for word', JSON.stringify(out[0]));
  ok(out[0].indexOf('%') === -1, 'and it carries no `% ` prefix: this is not an error', out[0]);
  ok(!/not a bridge|no L2 forwarding/.test(out[0]), 'the console\'s own explanation is gone', out[0]);
  const text = out.join('\n');
  ok(!/root bridge|Bridge priority/.test(text), 'no root and no priority are named for a box that has none', text);
  ok(!/election/.test(text), 'nor an election it could never join', text);
  ok(!/enabled protocol/.test(text), 'and it does not claim a tree is enabled', text);
  ok(!/Port\s+Role\s+State/.test(text), 'nor print a port table with no rows', text);
}

console.log('');
console.log('The older plural is a different box\'s sentence, and this console does not print it');
{
  const out = show(ROUTER, 'show spanning-tree').join('\n');
  ok(out.indexOf('No spanning tree instances exist.') === -1, 'not `instances` - the IOS 12.x/15.x router form',
    out);
}

console.log('');
console.log('A host model answers the same way: it is not a bridge either');
{
  const out = show(HOST, 'show spanning-tree');
  ok(out.length === 1 && out[0] === BOX_SENTENCE, 'the same one line', JSON.stringify(out));
}

console.log('');
console.log('A switch that has a tree still prints the tree');
{
  // Two switches, one cable: an election, a root and one forwarding port. The last thing this change may do is
  // reach the bridge path.
  const t = new Topology();
  t.addDevice(SWITCH, 's1'); t.addDevice(SWITCH, 's2');
  t.connect('s1', '1/1/1', 's2', '1/1/1', { mediaId: '1000base-t', speedMbps: 1000 });
  const sim = new Simulator(t);
  sim.setRunTime(0);
  const out = (new CliSession(t.getDevice('s1'), t, sim).run('show spanning-tree').output || []).join('\n');
  ok(/Spanning tree enabled protocol ieee/.test(out), 'a cabled bridge still reports a tree', out);
  ok(/Bridge ID  Priority    32769  [(]priority 32768 sys-id-ext 1[)]/.test(out),
    'with the bridge ID block a box prints, extended priority and all', out);
  ok(out.indexOf(BOX_SENTENCE) === -1, 'and never the no-instance sentence', out);
}

console.log('');
console.log('The answer does not depend on how the console was reached');
{
  // The same device, asked twice on two sessions: the sentence is the device's state, not one session's memory.
  const t = new Topology();
  t.addDevice(ROUTER, 'r1');
  const sim = new Simulator(t);
  sim.setRunTime(0);
  const first = (new CliSession(t.getDevice('r1'), t, sim).run('show spanning-tree').output || []);
  const second = (new CliSession(t.getDevice('r1'), t, sim).run('show spanning-tree').output || []);
  ok(first.join('\n') === second.join('\n') && first[0] === BOX_SENTENCE,
    'a second session prints the same line', JSON.stringify([first, second]));
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
