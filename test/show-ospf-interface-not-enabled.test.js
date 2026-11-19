'use strict';
// `show ip ospf interface <port>` on a port that exists and carries no OSPF.
//
// A box answers that with one tagged system message and nothing else:
//
//   %OSPF: OSPF not enabled on GigabitEthernet9/1
//
// (Cisco Community td-p/2039094, `sh ip ospf interface gigabitEthernet 9/1` on an L2 access port). Five
// captures print the same sentence - the tag is glued to the percent sign, there is no `is`, and the port
// is named in its long type spelling with no space (`s0` comes back as `Serial0`; Cisco 13693-22). The line
// does not say *why* OSPF is off, and it is the same line for an unaddressed port, an L2 port and a port a
// network statement never covered. This console used to answer with its own sentences - `% Gi0/1 has no
// address: OSPF needs one to form an adjacency` and `% Gi0/1 is not in OSPF`.
//
// The shut-port branch is not part of this question any more: a shut port the process covers prints its
// interface block, opening with the port's own state line (research/show-ospf-interface-shut-port.md), and
// test/show-ospf-interface-shut-port.test.js pins that shape. What is checked here is only that this branch
// does not draw the tagged message - the port is on OSPF, it is just down.
const { loadCatalog } = require('../devices/registry');
const { Topology } = require('../engine/topology');
const { Simulator } = require('../engine/simulator');
const cliModule = require('../engine/cli');
const CliSession = cliModule.CliSession || cliModule;

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}
const ROOT = require('path').join(__dirname, '..');
const specs = loadCatalog(ROOT + '/devices').filter(function (s) { return !s.error; });
const ROUTER = specs.find(function (s) { return /^ISR 4331$/.test(s.model); }) ||
  specs.find(function (s) { return /ISR 4331/.test(s.model); });

// r1 --- r2 on Gi0/0/0 (10.1.0.0/24), both addressed and in OSPF. Gi0/0/2 is a port that exists with no
// cable and no address, which is the state a real box answers with the "not enabled" line.
function lab() {
  const t = new Topology();
  ['r1', 'r2'].forEach(function (id) { t.addDevice(ROUTER, id); });
  t.connect('r1', 'Gi0/0/0', 'r2', 'Gi0/0/0', { mediaId: '1000base-t', speedMbps: 1000 });
  const addr = function (dev, port, ip) {
    const i = t.getDevice(dev).interfaces.get(port);
    i.ip = ip; i.mask = '255.255.255.0';
  };
  addr('r1', 'Gi0/0/0', '10.1.0.1'); addr('r2', 'Gi0/0/0', '10.1.0.2');
  addr('r1', 'Gi0/0/1', '10.2.0.1');          // addressed, no cable: the port the shut branch is asked about
  return t;
}
function sess(t, id, sim) { return new CliSession(t.getDevice(id), t, sim || null); }
function configure(t, id, cmds) {
  const s = sess(t, id);
  ['enable', 'configure terminal'].concat(cmds).forEach(function (c) { s.run(c); });
}
function show(t, sim, id, cmd) { return ((sess(t, id, sim).run(cmd) || {}).output || []).join('\n'); }
const lines = function (text) { return String(text).split('\n').filter(function (l) { return l !== ''; }); };
function running() {
  const t = lab();
  configure(t, 'r1', ['ospf router-id 1.1.1.1']);
  const sim = new Simulator(t);
  sim.computeOspf();
  return { t: t, sim: sim };
}

console.log('');
console.log('A port with no OSPF on it gets the box\'s own line:');
{
  const r = running();
  const asked = show(r.t, r.sim, 'r1', 'show ip ospf interface Gi0/0/2');
  ok(asked === '%OSPF: OSPF not enabled on GigabitEthernet0/0/2',
    'the answer is the vendor sentence, long spelling, nothing after it', JSON.stringify(asked));
  ok(lines(asked).length === 1, 'one line: no table header above a message that is not a table',
    JSON.stringify(lines(asked)));
  ok(/^%OSPF: /.test(asked), 'the tag is glued to the percent sign and followed by one space',
    JSON.stringify(asked.slice(0, 8)));
  ok(!/has no address|is not in OSPF|needs one to form/.test(asked),
    'neither of the two sentences this console invented survives', asked);
  ok(!/IP Address/.test(asked), 'and no column heading is printed around it', asked);
}

console.log('');
console.log('The line does not explain why - the same words for every reason:');
{
  const r = running();
  // The same port, asked three ways, resolves through the console's one name table: the answer names the
  // port the way a box does, not the way it was typed.
  const lower = show(r.t, r.sim, 'r1', 'show ip ospf interface gi0/0/2');
  ok(lower === '%OSPF: OSPF not enabled on GigabitEthernet0/0/2',
    'a lowercase spelling gets the same sentence', lower);
  const spaced = show(r.t, r.sim, 'r1', 'show ip ospf interface gigabitethernet 0/0/2');
  ok(/^%OSPF: OSPF not enabled on GigabitEthernet0\/0\/2$/.test(spaced),
    'so does the long spelling with a space in it, answered in the long form', spaced);
  // An L2 access port: the case the Cisco Community capture is about (td-p/2039094), and the engine's
  // switch ports answer with the same one line rather than a sentence about addresses.
  const sw = specs.find(function (s) { return /^C9200L-24T-4G$/.test(s.model); });
  const t2 = new Topology();
  t2.addDevice(sw, 'sw1');
  const i1 = t2.getDevice('sw1').interfaces.get('Gi1/0/1');
  i1.ip = '10.9.9.9'; i1.mask = '255.255.255.0';
  configure(t2, 'sw1', ['ospf router-id 9.9.9.9']);
  const sim2 = new Simulator(t2);
  sim2.computeOspf();
  const onSwitch = show(t2, sim2, 'sw1', 'show ip ospf interface Gi1/0/2');
  ok(/^%OSPF: OSPF not enabled on GigabitEthernet1\/0\/2$/.test(onSwitch),
    'a switch port with no address gets the same line, which is what the capture is', onSwitch);
}

console.log('');
console.log('The shut and missing branches are not this message:');
{
  const r = running();
  configure(r.t, 'r1', ['interface Gi0/0/1', 'shutdown']);
  const sim = new Simulator(r.t);
  sim.computeOspf();
  const shut = show(r.t, sim, 'r1', 'show ip ospf interface Gi0/0/1');
  ok(/^GigabitEthernet0\/0\/1 is administratively down, line protocol is down/.test(shut),
    'a shut port opens its block with the port state line (its own question)', shut.split('\n')[0]);
  ok(!/OSPF not enabled/.test(shut),
    'and never claims OSPF is off a port the process covers', shut);
  const missing = show(r.t, sim, 'r1', 'show ip ospf interface Gi9/9');
  ok(/^% No interface Gi9\/9 on /.test(missing),
    'a port the box does not have is still named as missing', missing);
}

console.log('');
console.log('The table itself is untouched:');
{
  const r = running();
  const table = show(r.t, r.sim, 'r1', 'show ip ospf interface');
  ok(/Interface/.test(table) && /Gi0\/0\/0/.test(table),
    'the unfiltered report still prints its row for the port OSPF runs on', table.split('\n')[0]);
  ok(!/not enabled on/.test(table), 'and no system message is mixed into the table', table);
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
