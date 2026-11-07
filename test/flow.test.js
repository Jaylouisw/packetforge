'use strict';
// flow.test.js -- a conversation, not a probe.
//
// Everything the simulator could do before flows was ping-driven: one packet out,
// one packet back, a timeline that ended when the echo did. But no network is
// judged on whether it can carry one packet -- it is judged on whether a client
// can open a connection, push a body of bytes through it in segments that fit the
// path, and close it without leaving half a conversation behind.
//
// The rule that makes this worth modelling instead of faking: every flow packet
// is an ordinary IPv4 frame that walks the same forwarding path a ping walks. If
// it is refused, the refusal came from a router's ACL, from a PSE with no budget
// left, or from the far end sending a real RST -- not from a function returning
// false. These tests pin that, plus the arithmetic that has to be exactly right
// for a throughput number to mean anything.
//
// What is deliberately absent, and therefore untested: congestion control,
// retransmission, SACK, window scaling, TIME_WAIT, IP fragmentation.
const path = require('path');
const flowLib = require('../engine/flow');
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

function cfg(dev, t, lines) { runCommands(dev, t, null, ['configure terminal'].concat(lines)); }

// PC1 -- SW1 -- SRV: one broadcast domain, the simplest network that can hold a
// conversation. The server is a generic-server, which is an http-server, so
// something is listening on port 80 by virtue of what the box is.
function lan() {
  const t = new Topology();
  const pc = t.addDevice(spec('generic', 'generic-pc')); pc.name = 'PC1';
  const sw = t.addDevice(spec('generic', 'generic-switch')); sw.name = 'SW1';
  const srv = t.addDevice(spec('generic', 'generic-server')); srv.name = 'SRV';
  t.connect(pc.id, 'eth0', sw.id, 'Fa0/1');
  t.connect(srv.id, 'eth0', sw.id, 'Fa0/2');
  cfg(pc, t, ['interface eth0', 'ip address 10.0.0.10 255.255.255.0']);
  cfg(srv, t, ['interface eth0', 'ip address 10.0.0.80 255.255.255.0']);
  return { t: t, pc: pc, sw: sw, srv: srv, sim: new Simulator(t) };
}

// PC1 -- R1 -- SRV: two subnets and a router in the middle, so the router can
// say no (no route), or an ACL on it can.
function routed() {
  const t = new Topology();
  const pc = t.addDevice(spec('generic', 'generic-pc')); pc.name = 'PC1';
  const r1 = t.addDevice(spec('generic', 'generic-router')); r1.name = 'R1';
  const srv = t.addDevice(spec('generic', 'generic-server')); srv.name = 'SRV';
  t.connect(pc.id, 'eth0', r1.id, 'Gi0/0');
  t.connect(srv.id, 'eth0', r1.id, 'Gi0/1');
  cfg(pc, t, ['interface eth0', 'ip address 10.0.1.10 255.255.255.0', 'exit', 'ip default-gateway 10.0.1.1']);
  cfg(srv, t, ['interface eth0', 'ip address 10.0.2.80 255.255.255.0', 'exit', 'ip default-gateway 10.0.2.1']);
  cfg(r1, t, ['interface Gi0/0', 'ip address 10.0.1.1 255.255.255.0', 'exit',
    'interface Gi0/1', 'ip address 10.0.2.1 255.255.255.0']);
  return { t: t, pc: pc, r1: r1, srv: srv, sim: new Simulator(t) };
}

function eventsOf(res, type, phase) {
  return res.events.filter(function (e) {
    return e.type === type && (phase === undefined || e.phase === phase);
  });
}

// ---------- 1: handshake + transfer ----------
console.log('A TCP flow completes a three-way handshake and moves the bytes:');
{
  const L = lan();
  const r = L.sim.openFlow({
    proto: 'tcp', srcDevice: L.pc.id, dstDevice: L.srv.id, dstPort: 80, bytes: 5000
  });
  ok(r.ok === true, 'openFlow succeeded' + (r.ok ? '' : ' (' + r.code + ': ' + r.reason + ')'));
  ok(!!r.flow && typeof r.flow.id === 'string' && r.flow.id.length > 0, 'it returned a flow record with an id (' + (r.flow && r.flow.id) + ')');
  ok(r.flow && r.flow.proto === 'tcp', 'proto is tcp');
  ok(r.flow && r.flow.srcIp === '10.0.0.10' && r.flow.srcPort > 1023, 'a source address and an ephemeral source port (' + (r.flow && r.flow.srcIp + ':' + r.flow.srcPort) + ')');
  ok(r.flow && r.flow.dstIp === '10.0.0.80' && r.flow.dstPort === 80, 'the destination the caller asked for');
  ok(r.flow && r.flow.state === 'established', 'the flow ends up ESTABLISHED, not just "sent" (' + (r.flow && r.flow.state) + ')');
  ok(r.flow && r.flow.bytes === 5000 && r.flow.bytesDelivered === 5000, 'all 5000 requested bytes were delivered to the far end');
  ok(r.flow && r.flow.packets >= 3 + r.flow.segments, 'and every packet is accounted for (' + (r.flow && r.flow.packets) + ' packets for ' + (r.flow && r.flow.segments) + ' segments)');

  const phases = eventsOf(r, 'flow-open').map(function (e) { return e.phase; });
  ok(phases.join(',') === 'syn,syn-ack,established',
    'the timeline shows SYN, SYN-ACK, ACK in that order (' + phases.join(',') + ')');

  // The three handshake packets are real frames on the wire, not events invented
  // at the client: each one appears as a frame that crossed a link.
  function firstFrameWith(flag, ackToo) {
    for (let i = 0; i < r.events.length; i++) {
      const e = r.events[i];
      if (e.type !== 'frame' || !e.frame || !e.frame.l4) continue;
      const f = e.frame.l4.flags || [];
      if (f.indexOf(flag) === -1) continue;
      if (ackToo === true && f.indexOf('ACK') === -1) continue;
      if (ackToo === false && f.indexOf('ACK') !== -1) continue;
      return i;
    }
    return -1;
  }
  const iSyn = firstFrameWith('SYN', false);
  const iSynAck = firstFrameWith('SYN', true);
  const iAck = firstFrameWith('ACK', true);
  ok(iSyn > -1, 'a frame carrying the bare SYN crossed a link');
  ok(iSynAck > iSyn, 'a later frame carried SYN,ACK back the other way');
  ok(iAck > -1, 'the handshake was completed by a third frame carrying an ACK');
  ok(r.events.some(function (e) { return e.type === 'frame' && e.frame && e.frame.l4 && e.frame.l4.srcPort === 80; }),
    'the server answered from port 80, which is what something listening on 80 looks like');

  const dataOut = r.events.filter(function (e) { return e.type === 'flow-data' && e.dir === 'out'; });
  const dataIn = r.events.filter(function (e) { return e.type === 'flow-data' && e.dir === 'in'; });
  ok(dataOut.length === r.flow.segments, 'every segment has a flow-data event at the sender (' + dataOut.length + ')');
  ok(dataIn.length === r.flow.segments, 'and one at the receiver, where it arrived (' + dataIn.length + ')');
  ok(dataIn.reduce(function (n, e) { return n + e.bytes; }, 0) === 5000, 'the bytes seen arriving add up to the bytes requested');
  ok(L.sim.flows.get(r.flow.id) === r.flow, 'the flow is in the simulator\'s table, so it can be listed and closed');
}

// ---------- 2: MSS from the path ----------
console.log('\nThe MSS comes from the path MTU, and the segment count follows from it:');
{
  const L = lan();
  const r = L.sim.openFlow({ proto: 'tcp', srcDevice: L.pc.id, dstDevice: L.srv.id, dstPort: 80, bytes: 10000 });
  ok(r.mtu === 1500, 'the path MTU is the Ethernet default (1500)');
  ok(r.mss === 1460, 'so the MSS is 1500 - 20 (IPv4) - 20 (TCP) = 1460 (' + r.mss + ')');
  ok(r.flow.segments === Math.ceil(10000 / 1460), 'segment count is ceil(bytes/MSS) = ' + Math.ceil(10000 / 1460));
  const segs = r.events.filter(function (e) { return e.type === 'flow-data' && e.dir === 'out'; });
  ok(segs.length === r.flow.segments, 'and that is how many segments were actually emitted (' + segs.length + ')');
  ok(segs[segs.length - 1].bytes === 10000 - 6 * 1460, 'the last segment is short (' + segs[segs.length - 1].bytes + ' bytes), not padded');
  ok(segs.reduce(function (n, e) { return n + e.bytes; }, 0) === 10000, 'the segments sum to exactly the bytes requested');

  // A narrower link on the path must shrink the segment: an MSS that assumes
  // 1500 would build segments this link has to fragment, which is the lie the
  // whole MSS mechanism exists to avoid.
  L.pc.interfaces.get('eth0').mtu = 1000;
  const r2 = L.sim.openFlow({ proto: 'tcp', srcDevice: L.pc.id, dstDevice: L.srv.id, dstPort: 80, bytes: 3000 });
  ok(r2.ok === true, 'the same flow still opens across the narrow link');
  ok(r2.mtu === 1000, 'the path MTU is now 1000');
  ok(r2.mss === 960, 'and the MSS dropped to 960 (' + r2.mss + ')');
  ok(r2.flow.segments === Math.ceil(3000 / 960), 'which changes the segment count to ' + Math.ceil(3000 / 960));
  ok(r2.flow.bytesDelivered === 3000, 'all 3000 bytes still arrive');

  const u = L.sim.openFlow({ proto: 'udp', srcDevice: L.pc.id, dstDevice: L.srv.id, dstPort: 53, bytes: 100 });
  ok(u.mss === 972, 'UDP pays only 8 header bytes, so its payload is 28 less than the MTU (' + u.mss + ')');
}

// ---------- 3: ACL deny ----------
console.log('\nAn ACL can refuse the flow, and the refusal is a real verdict:');
{
  const L = routed();
  const before = new Simulator(L.t).openFlow({ proto: 'tcp', srcDevice: L.pc.id, dstDevice: L.srv.id, dstPort: 80, bytes: 1500 });
  ok(before.ok === true, 'the flow opens before any ACL exists');

  cfg(L.r1, L.t, ['access-list 110 deny tcp any host 10.0.2.80 eq 80',
    'access-list 110 permit ip any any', 'interface Gi0/0', 'ip access-group 110 in']);

  const denied = L.sim.openFlow({ proto: 'tcp', srcDevice: L.pc.id, dstDevice: L.srv.id, dstPort: 80, bytes: 1500 });
  ok(denied.ok === false, 'openFlow now refuses');
  ok(denied.code === 'E_ACL_DENY', 'with a code the API can switch on (' + denied.code + ')');
  ok(/access list 110/.test(denied.reason), 'and a reason that names the list: "' + denied.reason + '"');
  ok(denied.events.some(function (e) { return e.type === 'acl-deny' && String(e.acl) === '110'; }),
    'the timeline shows the router denying the SYN itself, not just the client giving up');
  ok(L.sim.flows.size === 0, 'a refused connection leaves no flow behind to close');

  // The grant above is 'permit ip any any', so the same ACL must let a flow to a
  // port it never mentioned through. If the ACL stage ignored protocol and port,
  // this would be denied too.
  const other = L.sim.openFlow({ proto: 'tcp', srcDevice: L.pc.id, dstDevice: L.srv.id, dstPort: 443, bytes: 100 });
  ok(other.ok === true, 'a flow to port 443 still opens (the deny matched tcp/80, not "ip")');
}

// ---------- 4: unreachable ----------
console.log('\nA flow to nowhere does not open, and says which kind of nowhere:');
{
  const L = routed();
  // Same subnet as the PC, but no device holds the address: the ARP never
  // resolves and nothing answers.
  const ghost = L.sim.openFlow({ proto: 'tcp', srcDevice: L.pc.id, dstIp: '10.0.1.99', dstPort: 80, bytes: 100 });
  ok(ghost.ok === false, 'a phantom host on the local subnet is refused');
  ok(ghost.code === 'E_UNREACHABLE', 'with E_UNREACHABLE (' + ghost.code + ')');
  ok(/no response from 10\.0\.1\.99:80/.test(ghost.reason), 'naming the address nobody answered for: "' + ghost.reason + '"');

  // Beyond the default route, where the router has no entry at all: that is the
  // same 'no route to X' a ping logs.
  const noroute = L.sim.openFlow({ proto: 'tcp', srcDevice: L.pc.id, dstIp: '192.0.2.99', dstPort: 80, bytes: 100 });
  ok(noroute.ok === false, 'an address the routers cannot reach is refused');
  ok(noroute.code === 'E_NO_ROUTE', 'with E_NO_ROUTE (' + noroute.code + ')');
  ok(/no route to 192\.0\.2\.99/.test(noroute.reason), 'using ping\'s own wording: "' + noroute.reason + '"');
  ok(noroute.events.some(function (e) { return e.type === 'drop' && /no route to 192\.0\.2\.99/.test(e.reason || ''); }),
    'the drop came from the router in the middle, not from the client guessing');

  const nosrc = L.sim.openFlow({ proto: 'tcp', srcDevice: L.pc.id, dstDevice: L.srv.id, dstPort: 80, bytes: 100, srcPort: 1 });
  ok(nosrc.ok === true, 'a caller-pinned source port is honoured, not overwritten');
  ok(nosrc.flow.srcPort === 1, 'the flow kept port 1 (' + (nosrc.flow && nosrc.flow.srcPort) + ')');
  ok(L.sim.flows.size === 1, 'only the flow that opened is in the table');
}

// ---------- 5: UDP ----------
console.log('\nUDP opens with a single datagram and no handshake at all:');
{
  const L = lan();
  const r = L.sim.openFlow({ proto: 'udp', srcDevice: L.pc.id, dstDevice: L.srv.id, dstPort: 53, bytes: 120 });
  ok(r.ok === true, 'openFlow succeeded');
  ok(r.flow.proto === 'udp', 'proto is udp');
  ok(r.flow.state === 'open', 'the state is "open", which is the honest answer for a protocol with no state (' + r.flow.state + ')');
  ok(r.flow.packets === 1, 'exactly one packet went out (' + r.flow.packets + ')');
  ok(r.flow.bytesDelivered === 120, 'carrying all 120 bytes');

  const opens = eventsOf(r, 'flow-open');
  ok(opens.length === 1 && opens[0].phase === 'datagram', 'one flow-open event, phase "datagram"');
  ok(eventsOf(r, 'flow-open', 'syn').length === 0, 'no SYN was ever sent');
  ok(eventsOf(r, 'flow-data').length === 2, 'the datagram is logged at both ends (out and in)');

  const closed = L.sim.closeFlow(r.flow.id);
  ok(closed.ok === true, 'closeFlow accepts it');
  ok(closed.flow.state === 'closed', 'and retires the record');
  ok(closed.flow.packets === 1, 'without inventing a teardown packet for a connectionless protocol');
  ok(eventsOf(closed, 'flow-close').every(function (e) { return e.phase === 'closed'; }),
    'the close event says there was nothing to close');
}

// ---------- 6: counters ----------
console.log('\nPer-device counters add up to the bytes that moved:');
{
  const L = lan();
  const r = L.sim.openFlow({ proto: 'tcp', srcDevice: L.pc.id, dstDevice: L.srv.id, dstPort: 80, bytes: 5000 });
  const c = L.sim.counters;
  ok(!!c[L.pc.id] && !!c[L.srv.id] && !!c[L.sw.id], 'all three devices have counters');
  ok(c[L.pc.id].bytesOut === 5000, 'the client counted 5000 bytes out (' + c[L.pc.id].bytesOut + ')');
  ok(c[L.srv.id].bytesIn === 5000, 'the server counted the same 5000 bytes in (' + c[L.srv.id].bytesIn + ')');
  ok(c[L.sw.id].bytesIn === 5000 && c[L.sw.id].bytesOut === 5000, 'and so did the switch it passed through, both directions of the counter');
  ok(c[L.pc.id].bytesIn === 0, 'the client received acknowledgements but no payload, so its bytesIn is 0');
  ok(c[L.pc.id].packetsOut === 2 + r.flow.segments, 'the client put its SYN, its ACK and ' + r.flow.segments + ' segments on the wire (' + c[L.pc.id].packetsOut + ')');
  ok(c[L.pc.id].packetsIn > 0, 'and received the answers (' + c[L.pc.id].packetsIn + ' packets)');
  ok(c[L.pc.id].flowsOpened === 1 && c[L.pc.id].flowsRefused === 0, 'the flow tallies are kept per device as well');

  const closed = L.sim.closeFlow(r.flow.id);
  ok(closed.ok === true, 'the flow can be torn down');
  ok(closed.flow.state === 'closed', 'and ends closed');
  const phases = closed.events.filter(function (e) { return e.type === 'flow-close'; }).map(function (e) { return e.phase; });
  ok(phases.join(',') === 'fin,fin-ack,ack', 'with a four-way close on the wire: FIN, FIN-ACK, ACK (' + phases.join(',') + ')');
  ok(c[L.pc.id].packetsOut === 2 + r.flow.segments + 2, 'the close added exactly two packets at the client (FIN and the final ACK)');
  ok(L.sim.closeFlow(r.flow.id).already === true, 'closing twice is idempotent, not an error');
  ok(L.sim.closeFlow('flow-nope').code === 'E_NO_FLOW', 'closing an unknown id says so');
}

// ---------- 7: PoE ----------
console.log('\nA PoE-unpowered device cannot open a flow:');
{
  const PSE = 'CX 6000 24G CL4 PoE 4SFP 370W';
  const PD = 'UCG-Ultra';
  const t = new Topology();
  const sw = t.addDevice(spec('aruba', PSE)); sw.name = 'SW1';
  const pd1 = t.addDevice(spec('ubiquiti', PD)); pd1.name = 'PD1';
  const pd2 = t.addDevice(spec('ubiquiti', PD)); pd2.name = 'PD2';
  t.connect(pd1.id, 'port1', sw.id, '1/1/1');
  t.connect(pd2.id, 'port1', sw.id, '1/1/2');
  cfg(pd1, t, ['interface port1', 'ip address 10.9.0.1 255.255.255.0']);
  cfg(pd2, t, ['interface port1', 'ip address 10.9.0.2 255.255.255.0', 'exit', 'ip default-gateway 10.9.0.1']);

  // 2 x 12.95 W does not fit in 25 W, so the second port in order loses out.
  sw.poeBudget = 25;
  const sim = new Simulator(t);
  sim.computePoe();
  ok(sim.poe[0] && sim.poe[0].ports.filter(function (p) { return p.powered; }).length === 1,
    'the PSE had power for exactly one of the two devices');

  const fromDead = sim.openFlow({ proto: 'tcp', srcDevice: pd2.id, dstDevice: pd1.id, dstPort: 80, bytes: 100 });
  ok(fromDead.ok === false, 'the unpowered device cannot open a flow');
  ok(fromDead.code === 'E_POE', 'the refusal is attributed to power (' + fromDead.code + ')');
  ok(/PoE power/.test(fromDead.reason), 'with a reason that says so: "' + fromDead.reason + '"');

  const toDead = sim.openFlow({ proto: 'tcp', srcDevice: pd1.id, dstDevice: pd2.id, dstPort: 80, bytes: 100 });
  ok(toDead.ok === false, 'and nothing can open a flow to it either');
  ok(toDead.code === 'E_POE', 'for the same reason (' + toDead.code + ')');

  // Give the PSE the budget it was sold with. The same call now gets through the
  // power stage and reaches the far end, which is the proof that power was the
  // only thing standing in the way.
  pd2.config.listeners = [80];
  sw.poeBudget = 370;
  const restored = sim.openFlow({ proto: 'tcp', srcDevice: pd1.id, dstDevice: pd2.id, dstPort: 80, bytes: 100 });
  ok(restored.ok === true, 'with the budget restored the same flow opens');
  ok(restored.flow && restored.flow.bytesDelivered === 100, 'and the bytes arrive');
  ok(restored.code !== 'E_POE', 'the power refusal is gone (' + (restored.code || 'no code') + ')');
}

// ---------- 8: NAT ----------
console.log('\nA flow that needs NAT is translated, and still arrives:');
{
  const t = new Topology();
  const pc = t.addDevice(spec('generic', 'generic-pc')); pc.name = 'PC1';
  const edge = t.addDevice(spec('generic', 'generic-router')); edge.name = 'EDGE';
  const web = t.addDevice(spec('generic', 'generic-server')); web.name = 'WEB';
  t.connect(pc.id, 'eth0', edge.id, 'Gi0/0');
  t.connect(web.id, 'eth0', edge.id, 'Gi0/1');
  cfg(pc, t, ['interface eth0', 'ip address 192.168.1.10 255.255.255.0', 'exit', 'ip default-gateway 192.168.1.1']);
  cfg(web, t, ['interface eth0', 'ip address 198.51.100.20 255.255.255.0', 'exit', 'ip default-gateway 198.51.100.1']);
  cfg(edge, t, ['interface Gi0/0', 'ip address 192.168.1.1 255.255.255.0', 'exit',
    'interface Gi0/1', 'ip address 198.51.100.1 255.255.255.0']);
  edge.config.nat = {
    rules: [{ type: 'pat', insideLocal: '192.168.1.0/24', insideGlobal: '198.51.100.1', protocol: 'any' }]
  };

  const sim = new Simulator(t);
  const r = sim.openFlow({ proto: 'tcp', srcDevice: pc.id, dstDevice: web.id, dstPort: 80, bytes: 3000 });
  ok(r.ok === true, 'the flow opens across the NAT edge');
  ok(r.flow.bytesDelivered === 3000, 'and every byte arrives');

  const out = r.events.filter(function (e) { return e.type === 'nat-outbound'; });
  const inb = r.events.filter(function (e) { return e.type === 'nat-inbound'; });
  ok(out.length > 0, 'the SYN and its segments were translated on the way out');
  ok(out[0].insideLocal === '192.168.1.10' && out[0].insideGlobal === '198.51.100.1',
    'the inside local became the global address (' + out[0].insideLocal + ' -> ' + out[0].insideGlobal + ')');
  ok(out[0].globalPort >= 1024, 'with a translated source port (' + out[0].globalPort + ')');
  ok(inb.length > 0, 'and the replies were translated back on the way in');
  ok(inb[0].insideLocal === '192.168.1.10', 'landing on the inside host (' + inb[0].insideLocal + ':' + inb[0].localPort + ')');

  const arrived = r.events.filter(function (e) { return e.type === 'flow-data' && e.dir === 'in'; })[0];
  ok(arrived && arrived.src === '198.51.100.1', 'the server saw the connection coming from the global address (' + (arrived && arrived.src) + ')');
  ok(edge.natTable && edge.natTable.translations.length === 1,
    'one translation entry carried the whole conversation (' + (edge.natTable && edge.natTable.translations.length) + ')');
  ok(sim.counters[pc.id].bytesOut === 3000 && sim.counters[web.id].bytesIn === 3000,
    'counters still balance through a translated path');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
