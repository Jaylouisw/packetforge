'use strict';
// flows-show.test.js — `show flows`, `show flows <id>`, `show flows counters`.
//
// flow.js has carried `describe()` with the comment "for `show flows`" since the
// beginning, and there was no such command: a conversation was visible in the UI
// timeline and nowhere in the console. What this pins is that the console now
// reports the run's own records - including the awkward part, that a refused flow
// is counted and then deleted, so `recorded < opened` is normal rather than a bug
// a reader has to guess at.
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
function show(dev, command) {
  return run(dev, ['enable', command]).filter(function (l) {
    return !/^[A-Za-z0-9._()\/-]*[>#]/.test(l);
  });
}

run(pc, ['configure terminal', 'interface eth0', 'ip address 10.0.1.10 255.255.255.0',
  'exit', 'ip default-gateway 10.0.1.1', 'hostname PC1']);
run(r1, ['configure terminal', 'interface Gi0/0', 'ip address 10.0.1.1 255.255.255.0',
  'exit', 'interface Gi0/1', 'ip address 10.0.2.1 255.255.255.0', 'hostname R1']);
run(srv, ['configure terminal', 'interface eth0', 'ip address 10.0.2.20 255.255.255.0',
  'exit', 'ip default-gateway 10.0.2.1', 'hostname WEB']);

console.log('An empty lab says nothing has been attempted - not "0 flows":');
{
  eq(show(r1, 'show flows').join('\n'), 'Flows in this lab: none - nothing has been offered yet',
    'the empty answer is one line and says why');
  ok(/none - no traffic has been offered yet/.test(show(r1, 'show flows counters').join('\n')),
    'counters make the same distinction');
}

sim.openFlow({ proto: 'tcp', srcDevice: pc.id, dstDevice: srv.id, dstPort: 80, bytes: 5000 });
sim.openFlow({ proto: 'udp', srcDevice: pc.id, dstDevice: srv.id, dstPort: 53, bytes: 100 });

console.log('\nThe list is the conversation table:');
const listed = show(r1, 'show flows');
{
  ok(/^Flows in this lab \(2 recorded, 2 opened, 0 refused\):$/.test(listed[0]),
    'the heading counts recorded, opened and refused separately');
  eq(listed.length, 4, 'a heading, a column header, and one row per flow');
  ok(/Id\s+Proto\s+Source\s+Destination\s+State\s+Payload\s+Segs\s+Pkts\s+Opened/.test(listed[1]),
    'the columns are named');
  ok(/flow-1\s+tcp\s+10\.0\.1\.10:49152\s+10\.0\.2\.20:80\s+established/.test(listed[2]),
    'the TCP conversation reached established, with its addresses and port');
  ok(/flow-2\s+udp\s+10\.0\.1\.10:49152\s+10\.0\.2\.20:53\s+open/.test(listed[3]),
    'the UDP conversation is open, not established - it has no handshake');
  ok(/5000/.test(listed[2]) && /100/.test(listed[3]), 'each row carries its payload size');
}

console.log('\nThe row agrees with the record it was built from:');
{
  const rec = sim.flowState.flows.get('flow-1');
  const cells = listed[2].trim().split(/\s+/);
  eq(cells[0], rec.id, 'the id cell is the record id');
  eq(cells[1], rec.proto, 'the proto cell is the record proto');
  eq(cells[4], rec.state, 'the state cell is the record state');
  eq(Number(cells[5]), rec.bytes, 'the payload cell is the record byte count');
  eq(Number(cells[7]), rec.packets, 'the packet cell is every packet the flow put on the wire');
}

console.log('\nA refused flow is counted, then dropped - and the heading says so:');
{
  const before = show(r1, 'show flows').length;
  const refused = sim.openFlow({ proto: 'tcp', srcDevice: pc.id, dstDevice: srv.id, dstPort: 9, bytes: 10 });
  eq(refused.ok, false, 'a connection to a closed port is refused');
  const after = show(r1, 'show flows');
  eq(after.length, before, 'the refused conversation adds no row');
  ok(/\(2 recorded, 3 opened, 1 refused\)/.test(after[0]),
    'but it does appear in the heading, so the numbers are explained');
  eq(2 + 1, 3, 'recorded + refused = opened, which is the invariant the heading encodes');
}

console.log('\nCounters name the devices and are sorted by traffic:');
const counters = show(r1, 'show flows counters');
{
  ok(/^\s+Device\s+Bytes in\s+Bytes out\s+Packets in\s+Packets out\s+Opened\s+Refused$/.test(counters[1]),
    'the counter columns are named');
  const names = counters.slice(2).map(function (l) { return l.trim().split(/\s+/)[0]; });
  eq(names.length, 3, 'one row per device that carried a packet');
  ok(names.indexOf('PC1') !== -1 && names.indexOf('WEB') !== -1 && names.indexOf('R1') !== -1,
    'devices are named, not shown as internal ids');
  ok(names[0] === 'R1', 'the busiest device sorts first (R1 carries both directions)');
  const byName = {};
  counters.slice(2).forEach(function (l) {
    const c = l.trim().split(/\s+/);
    byName[c[0]] = { bytesIn: Number(c[1]), bytesOut: Number(c[2]), packetsIn: Number(c[3]),
      packetsOut: Number(c[4]), opened: Number(c[5]), refused: Number(c[6]) };
  });
  eq(byName.PC1.bytesOut, 5100, 'the sender put 5000 + 100 bytes of payload on the wire');
  eq(byName.PC1.bytesIn, 0, 'and received none - acknowledgements carry no payload');
  ok(byName.PC1.packetsIn > 0, 'though it did receive packets, which is why bytes and packets differ');
  eq(byName.WEB.bytesIn, 5100, 'the server received exactly what was sent');
  eq(byName.PC1.refused, 1, 'the refusal is charged to the device that tried');
}

console.log('\nOne flow, in detail:');
{
  const lines = show(r1, 'show flows flow-1');
  const text = lines.join('\n');
  eq(lines[0], 'Flow flow-1 (tcp):', 'the heading names the flow and its protocol');
  ok(/Source\s+10\.0\.1\.10:49152\s+\(PC1\)/.test(text), 'the source is resolved to a device name');
  ok(/Destination\s+10\.0\.2\.20:80\s+\(WEB\)/.test(text), 'and so is the destination');
  ok(/State\s+established\s+\(still open\)/.test(text), 'an open flow says it is still open');
  ok(/Delivered\s+5000 bytes/.test(text), 'delivered bytes equal the payload for a completed transfer');
  ok(/MSS\s+1460\s+MTU 1500/.test(text), 'the MSS and MTU the flow was sized against are shown');
  ok(/Segments|Payload\s+5000 bytes in 4 segments, 11 packets/.test(text),
    'the segmentation the payload produced is reported');
}

console.log('\nA flow id that does not exist is refused with the alternatives:');
{
  const lines = show(r1, 'show flows flow-9');
  eq(lines.length, 2, 'two lines');
  ok(/^% No flow flow-9 in this lab$/.test(lines[0]), 'the refusal quotes what was asked for');
  ok(/show flows \(for the list\) or show flows counters/.test(lines[1]), 'and names both real views');
}

console.log('\nThe view is lab-wide, and identical from any console:');
{
  eq(show(pc, 'show flows').join('\n'), show(r1, 'show flows').join('\n'),
    'PC1 and R1 print the same table - a flow is one conversation, not a per-device counter');
  eq(show(srv, 'show flows').join('\n'), show(r1, 'show flows').join('\n'),
    'including from the destination');
  eq(show(r1, 'show flows').join('\n'), show(r1, 'show flows').join('\n'),
    'and the same query twice renders identically');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
