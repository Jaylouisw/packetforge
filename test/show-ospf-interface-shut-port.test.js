'use strict';
// `show ip ospf interface <port>` on a port that is administratively down.
//
// A shut port the OSPF process covers is still an OSPF interface, and a box prints its block - the block
// opens with the port's own state line, at the left margin, and the address and area under it indented two
// spaces:
//
//   R1# show ip ospf interface loopback 100
//   Loopback100 is administratively down, line protocol is down
//   Internet Address 100.1.1.1/24, Area 0
//   Process ID 1, Router ID 1.1.1.1, Network Type LOOPBACK, Cost: 1
//     (howtonetwork.org, "Troubleshooting Route Advertisement"; the same box's `show ip ospf interface brief`
//      lists Lo100 with State DOWN and Nbrs F/C 0/0, so shutting the port did not remove it from the process)
//
//   R1# show ip ospf interface
//   FastEthernet0/0 is administratively down, line protocol is down
//     Internet Address 192.168.100.1/24, Area 0
//     Process ID 1, Router ID 1.1.1.1, Network Type BROADCAST, Cost: 1
//     ...
//     Transmit Delay is 1 sec, State DOWN, Priority 1
//     (tech.pjin.jp, OSPF neighbour-failure drill, IOS 12.4: `interface FastEthernet0/0` carries
//      `ip address 192.168.100.1 255.255.255.0`, `ip ospf 1 area 0` and `shut` + `down`)
//
// This console answered that question with a sentence no box prints - `% Gi0/1 is administratively down:
// OSPF runs on no shut port with an address` - and the rule inside it is false. The checks below pin the
// captured head of the block, and pin that the block stops there: `Process ID`, `Network Type` and `State`
// are fields this model does not carry, so the console prints the two lines it can state and nothing more.
// research/show-ospf-interface-shut-port.md records the evidence and the half that is still open.
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
const specs = loadCatalog(require('path').join(__dirname, '..', 'devices'))
  .filter(function (s) { return !s.error; });
const ROUTER = specs.find(function (s) { return /^ISR 4331$/.test(s.model); });

const FIRST = 'GigabitEthernet0/0/1 is administratively down, line protocol is down';
const ADDRESS = '  Internet Address 10.2.0.1/24, Area 0';

// r1 --- r2 on Gi0/0/0. Gi0/0/1 is addressed and cabled to nothing, which is the port shut below.
function lab() {
  const t = new Topology();
  ['r1', 'r2'].forEach(function (id) { t.addDevice(ROUTER, id); });
  t.connect('r1', 'Gi0/0/0', 'r2', 'Gi0/0/0', { mediaId: '1000base-t', speedMbps: 1000 });
  const addr = function (dev, port, ip) {
    const i = t.getDevice(dev).interfaces.get(port);
    i.ip = ip; i.mask = '255.255.255.0';
  };
  addr('r1', 'Gi0/0/0', '10.1.0.1');
  addr('r2', 'Gi0/0/0', '10.1.0.2');
  addr('r1', 'Gi0/0/1', '10.2.0.1');
  return t;
}
function configure(t, id, cmds) {
  const s = new CliSession(t.getDevice(id), t, null);
  ['enable', 'configure terminal'].concat(cmds).forEach(function (c) { s.run(c); });
}
function show(t, sim, id, cmd) {
  return ((new CliSession(t.getDevice(id), t, sim).run(cmd) || {}).output || []);
}
// The lab with Gi0/0/1 shut and the process brought up, which is the state both captures are in.
function shut() {
  const t = lab();
  configure(t, 'r1', ['ospf router-id 1.1.1.1', 'interface Gi0/0/1', 'shutdown', 'exit']);
  const sim = new Simulator(t);
  sim.computeOspf();
  return { t: t, sim: sim };
}

console.log('');
console.log('A shut port OSPF covers prints its block, not a refusal:');
{
  const r = shut();
  const out = show(r.t, r.sim, 'r1', 'show ip ospf interface Gi0/0/1');
  ok(out[0] === FIRST, 'the first line is the port\'s own state line, word for word', JSON.stringify(out[0]));
  ok(out[1] === ADDRESS, 'the address and area follow, indented two spaces', JSON.stringify(out[1]));
  ok(out.length === 2, 'and the block stops there: no invented Process ID, Network Type or State line',
    JSON.stringify(out));
  const text = out.join('\n');
  ok(text.indexOf('%') === -1, 'no system message: this is a report, not an error', text);
  ok(!/OSPF not enabled/.test(text), 'and it does not claim OSPF is off the port', text);
  ok(!/OSPF runs on no shut port/.test(text), 'the sentence this console invented is gone', text);
  ok(/^GigabitEthernet0\/0\/1 /.test(out[0]), 'the port is named in its long type spelling', out[0]);
}

console.log('');
console.log('The name is the port\'s, whatever was typed:');
{
  const r = shut();
  ['show ip ospf interface gi0/0/1', 'show ip ospf interface gigabitethernet 0/0/1'].forEach(function (cmd) {
    const out = show(r.t, r.sim, 'r1', cmd);
    ok(out[0] === FIRST, '`' + cmd + '` opens with the same line', JSON.stringify(out[0]));
  });
}

console.log('');
console.log('The Area is the one configured on the port:');
{
  const t = lab();
  configure(t, 'r1', ['ospf router-id 1.1.1.1', 'ospf area 0',
    'interface Gi0/0/1', 'ip ospf area 7', 'shutdown', 'exit']);
  const sim = new Simulator(t);
  sim.computeOspf();
  const out = show(t, sim, 'r1', 'show ip ospf interface Gi0/0/1');
  ok(out[1] === '  Internet Address 10.2.0.1/24, Area 7',
    'the interface\'s own area overrides the process default', JSON.stringify(out[1]));
}

console.log('');
console.log('A shut port with no address draws the one-line message:');
{
  const t = lab();
  configure(t, 'r1', ['ospf router-id 1.1.1.1', 'interface Gi0/0/2', 'shutdown', 'exit']);
  const sim = new Simulator(t);
  sim.computeOspf();
  const out = show(t, sim, 'r1', 'show ip ospf interface Gi0/0/2');
  ok(out.length === 1 && out[0] === '%OSPF: OSPF not enabled on GigabitEthernet0/0/2',
    'the vendor sentence, long spelling, and nothing else', JSON.stringify(out));
}

console.log('');
console.log('An up port is answered as it was before:');
{
  const r = shut();
  const out = show(r.t, r.sim, 'r1', 'show ip ospf interface Gi0/0/0');
  ok(/Interface\s+IP Address/.test(out[0]), 'the interface table still heads the answer', out[0]);
  ok(!/administratively down/.test(out.join('\n')), 'and no port-state line is mixed into it', out[0]);
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
