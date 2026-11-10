'use strict';
// flow-cli.test.js — `flow open` / `flow close`.
//
// The console could read the conversation table (show flows) but could not start a
// conversation: openFlow()/closeFlow() were reachable only from the UI and the API.
// That is the engine's most detailed model - three-way handshake, MSS-sized
// segments, cumulative ACKs, four-way close - so it was also the hardest thing to
// see from the one interface an operator actually types into.
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

const t = new Topology();
const pc = t.addDevice(model('generic-pc'));
const r1 = t.addDevice(model('generic-router'));
const srv = t.addDevice(model('generic-server'));
pc.name = 'PC1'; r1.name = 'R1'; srv.name = 'WEB';
t.connect(pc.id, 'eth0', r1.id, 'Gi0/0');
t.connect(r1.id, 'Gi0/1', srv.id, 'eth0');
const sim = new Simulator(t);

function run(dev, commands) { return runCommands(dev, t, sim, commands).lines; }
function do_(command, dev) {
  return run(dev || pc, ['enable', command]).filter(function (l) {
    return !/^[A-Za-z0-9._()\/-]*[>#]/.test(l);
  });
}

console.log('A source with no address is refused honestly, before anything else:');
{
  const lines = do_('flow open 10.0.2.20 port 80');
  ok(/^% flow refused \(E_NO_ROUTE\): no route to 10\.0\.2\.20$/.test(lines[0]),
    'an unconfigured host is refused with the code the data path gave');
  ok(/the timeline says why/.test(lines[1]), 'and points at where to look');
}

run(pc, ['configure terminal', 'interface eth0', 'ip address 10.0.1.10 255.255.255.0',
  'exit', 'ip default-gateway 10.0.1.1', 'hostname PC1']);
run(r1, ['configure terminal', 'interface Gi0/0', 'ip address 10.0.1.1 255.255.255.0',
  'exit', 'interface Gi0/1', 'ip address 10.0.2.1 255.255.255.0', 'hostname R1']);
run(srv, ['configure terminal', 'interface eth0', 'ip address 10.0.2.20 255.255.255.0',
  'exit', 'ip default-gateway 10.0.2.1', 'hostname WEB']);

console.log('\nA TCP conversation opens and reports what the record says:');
const opened = do_('flow open 10.0.2.20 port 80 bytes 5000');
{
  eq(opened[0], 'Flow flow-1 opened: tcp 10.0.1.10:49152 -> 10.0.2.20:80, established',
    'the summary line names the flow, both ends and the resulting state');
  ok(/5000 bytes in 4 segments, 11 packets on the wire, MSS 1460 \(MTU 1500\)/.test(opened[1]),
    'the segmentation is reported alongside the payload');
  ok(/show flows flow-1 for the record/.test(opened[2]), 'and the reader is told how to see the record');

  const rec = sim.flowState.flows.get('flow-1');
  ok(!!rec, 'the command really created a flow, it did not just print one');
  eq(rec.bytes, 5000, 'the record carries the requested payload');
  eq(rec.state, 'established', 'and the state the handshake reached');
  eq(rec.dstDevice, srv.id, 'the destination device was resolved from the address');
}

console.log('\nDefaults are stated by the help and honoured by the parser:');
{
  const lines = do_('flow open 10.0.2.20');
  ok(/^Flow flow-2 opened: tcp .* -> 10\.0\.2\.20:80, established$/.test(lines[0]),
    'port 80 and tcp are the defaults (1000 bytes, so 1 segment)');
  const rec = sim.flowState.flows.get('flow-2');
  eq(rec.bytes, 1000, 'the default payload is 1000 bytes');
  eq(rec.dstPort, 80, 'the default port is 80');
}

console.log('\nKeywords are honoured, including an explicit source port:');
{
  const lines = do_('flow open 10.0.2.20 port 53 proto udp bytes 100 sport 40000');
  ok(/^Flow flow-3 opened: udp 10\.0\.1\.10:40000 -> 10\.0\.2\.20:53, open$/.test(lines[0]),
    'UDP opens straight to "open" - there is no handshake, so there is nothing to establish');
  const rec = sim.flowState.flows.get('flow-3');
  eq(rec.srcPort, 40000, 'the requested source port is the one used');
  eq(rec.segments, 1, '100 bytes fits one segment');
}

console.log('\nA refused connection is a first-class answer, not a silent nothing:');
{
  const before = sim.flowState.flows.size;
  const lines = do_('flow open 10.0.2.20 port 9 bytes 10');
  ok(/^% flow refused \(E_REFUSED\): connection refused: nothing listening on 10\.0\.2\.20:9$/.test(lines[0]),
    'the reason comes from the peer, and names the port');
  eq(sim.flowState.flows.size, before, 'no record is kept for a refused flow');
  const refusedCount = sim.flowState.counters[pc.id].flowsRefused;
  ok(refusedCount >= 1, 'but the refusal is counted on the device that tried (' + refusedCount + ')');
}

console.log('\nAn unroutable destination is a different code, because it is a different thing:');
{
  const lines = do_('flow open 192.0.2.99 port 80');
  ok(/^% flow refused \(E_NO_ROUTE\): no route to 192\.0\.2\.99$/.test(lines[0]),
    'no route says no route - not "refused"');
}

console.log('\nBad input is refused before a flow is attempted:');
{
  const cases = [
    ['flow open 999.1.1.1', /^% Invalid destination: 999\.1\.1\.1$/],
    ['flow open 10.0.2.20 port abc', /^% port needs a number \(got abc\)$/],
    ['flow open 10.0.2.20 port 70000', /^% port out of range: 70000$/],
    ['flow open 10.0.2.20 sport 0', /^% sport out of range: 0$/],
    ['flow open 10.0.2.20 proto sctp', /^% proto must be tcp or udp \(got sctp\)$/],
    ['flow open 10.0.2.20 wibble 3', /^% Unknown keyword: wibble$/],
    ['flow open', /^% Incomplete command: flow open <dst> \[port <n>\] \[bytes <n>\] \[proto tcp\|udp\]$/]
  ];
  for (const [command, pattern] of cases) {
    const lines = do_(command);
    ok(pattern.test(lines[0]), command.slice(0, 34) + ' -> ' + lines[0].slice(0, 46));
  }
  const sizeBefore = sim.flowState.flows.size;
  do_('flow open 999.1.1.1');
  eq(sim.flowState.flows.size, sizeBefore, 'a malformed command creates nothing');
}

console.log('\n`flow` with no verb explains the verbs:');
{
  const lines = do_('flow');
  eq(lines.length, 3, 'three lines: open, close, and where to read the result');
  ok(/Usage: flow open/.test(lines[0]) && /flow close <flow-id>/.test(lines[1]) &&
    /show flows/.test(lines[2]), 'each line names a real next step');
}

console.log('\nClosing a TCP flow runs the four-way close and can be repeated:');
{
  const rec = sim.flowState.flows.get('flow-1');
  const packetsBefore = rec.packets;
  const lines = do_('flow close flow-1');
  eq(lines[0], 'Flow flow-1 closed: closed, 5000 of 5000 bytes delivered',
    'the close reports the final state and what was delivered');
  ok(rec.packets > packetsBefore, 'the close put more packets on the wire (FIN, FIN-ACK, ACK): ' +
    packetsBefore + ' -> ' + rec.packets);
  eq(rec.state, 'closed', 'the record ends closed');

  const again = do_('flow close flow-1');
  ok(/\(already closed\)$/.test(again[0]), 'closing twice is not an error, and says so');
  ok(/^% no such flow: flow-99$/.test(do_('flow close flow-99')[0]),
    'closing a flow that never existed is refused by name');
}

console.log('\nThe closed flow is still in the table - retired records are history:');
{
  const table = do_('show flows');
  ok(/flow-1\s+tcp\s+10\.0\.1\.10:49152\s+10\.0\.2\.20:80\s+closed/.test(table.join('\n')),
    'show flows still lists it, with state closed');
  const detail = do_('show flows flow-1').join('\n');
  ok(/State\s+closed\s+\(closed at step \d+\)/.test(detail),
    'and its detail view says when, instead of "still open"');
}

console.log('\nThe command is discoverable:');
{
  const help = do_('?').join('\n');
  ok(/flow open <dst> \[port <n>\] \[bytes <n>\] \[proto tcp\|udp\] \[sport <n>\]/.test(help),
    'help lists the full syntax');
  ok(/flow close <id>/.test(help), 'and the close verb');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
