'use strict';
// flow.js -- transport flows: a conversation, not a probe.
//
// Everything the simulator could do before this file was a ping: one packet out,
// one packet back, and a timeline that ended when the echo did. A network is not
// judged on whether it can carry one packet, though. It is judged on whether a
// client can open a connection, push a body of bytes through it in segments that
// fit the path, and let go without leaving half a conversation behind. "The web
// server is taking 40 requests a second" and "this link is saturated" are
// statements about flows, not about echoes.
//
// This module is the data model for that conversation, and nothing else: header
// arithmetic, a small TCP state machine, and the rules for what a device listens
// on. It is pure -- no topology, no events, no I/O -- so the simulator can drive
// it through the same forwarding path a ping uses. Every segment then becomes a
// real frame that an ACL can deny, NAT can rewrite, or a PSE with no budget left
// can refuse to power.
//
// Honest, not complete. There is no congestion window, no retransmission timer,
// no SACK, no TIME_WAIT, no window scaling, and no ICMP port-unreachable for a
// stray UDP datagram. What IS modelled is what changes the answer to "can this
// network carry my traffic": the three-way handshake as three packets, an MSS
// derived from the path MTU, cumulative ACKs, and a four-way close. The gaps are
// named in engine/simulator.js and pinned by test/flow.test.js.

const PROTO = { TCP: 'tcp', UDP: 'udp' };

// Header sizes we subtract from the MTU. IPv4 options and TCP options (the MSS
// option, timestamps, SACK blocks) all eat into the same budget, so the number
// below is the *best* case: a real stack would negotiate a few bytes less.
const IPV4_HDR = 20;
const TCP_HDR = 20;
const UDP_HDR = 8;

const DEFAULT_MTU = 1500;

// RFC 879: every IPv4 host must accept a 576-byte datagram, i.e. 536 bytes of
// TCP payload. We do NOT clamp up to it: a segment larger than the path MTU is a
// lie the next link would have to tell, so a narrow path yields a small MSS
// instead of a fragment.
const TCP_MIN_MSS = 536;

// Source ports nobody is listening on. Real stacks start here rather than at 1 so
// that a client never collides with a well-known service by accident.
const EPHEMERAL_FIRST = 49152;
const EPHEMERAL_LAST = 65535;

const DEFAULT_WINDOW = 65535;

// States are the ones a learner can see on a real box. 'open' is UDP's way of
// saying "there is no state here at all", which is the honest answer.
const STATE = {
  CLOSED: 'closed',
  SYN_SENT: 'syn-sent',
  SYN_RECEIVED: 'syn-received',
  ESTABLISHED: 'established',
  FIN_WAIT: 'fin-wait',
  CLOSE_WAIT: 'close-wait',
  RESET: 'reset',
  OPEN: 'open'                 // udp only
};

// Which state may follow which. A flow that walks this graph backwards is a bug,
// and setState() refuses rather than quietly recording nonsense.
const TRANSITIONS = {
  closed: [STATE.SYN_SENT, STATE.OPEN, STATE.RESET],
  'syn-sent': [STATE.SYN_RECEIVED, STATE.ESTABLISHED, STATE.RESET, STATE.CLOSED],
  'syn-received': [STATE.ESTABLISHED, STATE.RESET, STATE.CLOSED],
  established: [STATE.FIN_WAIT, STATE.CLOSE_WAIT, STATE.RESET, STATE.CLOSED],
  'fin-wait': [STATE.CLOSED, STATE.RESET],
  'close-wait': [STATE.CLOSED, STATE.RESET],
  reset: [STATE.CLOSED],
  open: [STATE.CLOSED, STATE.RESET]
};

// What a device answers on when nobody configured anything. Capabilities are the
// catalogue's own statement of what the box is for, so an http-server serves HTTP
// and a box with a CLI answers SSH -- and a plain PC, which has neither a web
// server nor a route to being one, refuses a connection on port 80 with a RST,
// exactly like a laptop would. A lab can override the lot with
// `dev.config.listeners` (see listenerPorts).
const SERVICE_PORTS = {
  'http-server': [{ proto: PROTO.TCP, port: 80 }, { proto: PROTO.TCP, port: 443 }],
  'dhcp-server': [{ proto: PROTO.UDP, port: 67 }],
  cli: [{ proto: PROTO.TCP, port: 22 }, { proto: PROTO.TCP, port: 23 }]
};

// --- small helpers ---------------------------------------------------------

function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function portOrNull(v) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 65535) return null;
  return n;
}

function byteCount(v) {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// --- MTU, MSS and segmentation --------------------------------------------

// The largest TCP segment the path can carry as one frame. `mtu` is the path
// MTU (see Simulator.pathMtu), not the local one: a 9000-byte jumbo segment that
// has to cross a 1500-byte link is not a 9000-byte segment, it is a fragment.
function mssForMtu(mtu, proto) {
  const pathMtu = num(mtu, DEFAULT_MTU);
  if (pathMtu <= (proto === PROTO.UDP ? IPV4_HDR + UDP_HDR : IPV4_HDR + TCP_HDR)) return 1;
  return Math.floor(pathMtu) - (proto === PROTO.UDP ? IPV4_HDR + UDP_HDR : IPV4_HDR + TCP_HDR);
}

// How many segments it takes to move `bytes`. Zero bytes is zero segments: a
// flow that transfers nothing still handshakes, and pretending it sent one empty
// data packet would make every byte count in the lab off by one.
function segmentCount(bytes, mss) {
  const total = byteCount(bytes);
  const size = Math.floor(num(mss, 0));
  if (total <= 0 || size <= 0) return 0;
  return Math.ceil(total / size);
}

// The segment sizes, in order, for a body of `bytes`. The last one is short
// unless the body divides evenly -- which is why "segment count = ceil(bytes/MSS)"
// is the only formula that holds for both.
function segmentSizes(bytes, mss) {
  const total = byteCount(bytes);
  const size = Math.floor(num(mss, 0));
  if (total <= 0 || size <= 0) return [];
  const out = [];
  let left = total;
  while (left > 0) {
    const chunk = Math.min(left, size);
    out.push(chunk);
    left -= chunk;
  }
  return out;
}

// --- flow records ----------------------------------------------------------

// The record the API hands out and the UI lists. Only the fields in the task's
// contract are required; the rest are what a table needs to be useful (which
// devices, what MSS, how much actually arrived, why it ended).
function createFlow(spec) {
  const s = spec || {};
  const proto = String(s.proto || PROTO.TCP).toLowerCase() === PROTO.UDP ? PROTO.UDP : PROTO.TCP;
  return {
    id: String(s.id === undefined || s.id === null ? '' : s.id),
    proto: proto,
    srcIp: s.srcIp || null,
    srcPort: portOrNull(s.srcPort) || EPHEMERAL_FIRST,
    dstIp: s.dstIp || null,
    dstPort: portOrNull(s.dstPort) || (proto === PROTO.UDP ? 53 : 80),
    // requested payload, in bytes -- not header bytes, not ACK bytes
    bytes: byteCount(s.bytes),
    // every packet the flow put on the wire, control packets included
    packets: 0,
    state: s.state || STATE.CLOSED,
    // --- bookkeeping the UI and the tests read ---
    srcDevice: s.srcDevice || null,
    dstDevice: s.dstDevice || null,
    mss: s.mss || null,
    segments: s.segments || 0,
    bytesDelivered: 0,
    openedStep: null,
    closedStep: null,
    code: null,
    reason: null
  };
}

// A per-connection identity that is stable across runs: no Math.random(), no
// Date.now(). The same lab replays identically, which is what makes a simulation
// worth diffing.
function initialSeq(n) {
  const seed = Math.abs(Math.floor(num(n, 1)));
  return (100000 + (seed * 7919) % 800000) | 0;
}

// --- packet builders -------------------------------------------------------

function tcpPacket(o) {
  const p = o || {};
  return {
    proto: PROTO.TCP,
    srcPort: portOrNull(p.srcPort) || 0,
    dstPort: portOrNull(p.dstPort) || 0,
    flags: Array.isArray(p.flags) ? p.flags.slice() : [],
    seq: Math.floor(num(p.seq, 0)),
    ack: Math.floor(num(p.ack, 0)),
    bytes: byteCount(p.bytes),
    window: DEFAULT_WINDOW,
    mss: p.mss === undefined ? null : p.mss
  };
}

function synPacket(flowRec, seq) {
  return tcpPacket({
    srcPort: flowRec.srcPort, dstPort: flowRec.dstPort,
    flags: ['SYN'], seq: seq, ack: 0, mss: flowRec.mss
  });
}

function synAckPacket(flowRec, seq, ack, mss) {
  return tcpPacket({
    srcPort: flowRec.dstPort, dstPort: flowRec.srcPort,
    flags: ['SYN', 'ACK'], seq: seq, ack: ack, mss: mss === undefined ? flowRec.mss : mss
  });
}

function ackPacket(srcPort, dstPort, seq, ack) {
  return tcpPacket({ srcPort: srcPort, dstPort: dstPort, flags: ['ACK'], seq: seq, ack: ack });
}

function dataPacket(srcPort, dstPort, seq, ack, bytes) {
  return tcpPacket({
    srcPort: srcPort, dstPort: dstPort,
    flags: ['PSH', 'ACK'], seq: seq, ack: ack, bytes: bytes
  });
}

function finPacket(srcPort, dstPort, seq, ack, alsoAck) {
  return tcpPacket({
    srcPort: srcPort, dstPort: dstPort,
    flags: alsoAck === false ? ['FIN'] : ['FIN', 'ACK'],
    seq: seq, ack: ack
  });
}

function resetPacket(srcPort, dstPort, seq, ack) {
  return tcpPacket({ srcPort: srcPort, dstPort: dstPort, flags: ['RST', 'ACK'], seq: seq, ack: ack });
}

function udpPacket(o) {
  const p = o || {};
  const bytes = byteCount(p.bytes);
  return {
    proto: PROTO.UDP,
    srcPort: portOrNull(p.srcPort) || 0,
    dstPort: portOrNull(p.dstPort) || 0,
    bytes: bytes,
    // The UDP length field covers header + payload, which is why a 1-byte
    // datagram still costs 29 bytes on an IPv4 wire.
    length: bytes + UDP_HDR
  };
}

// 'SYN,ACK' -- the string a packet dump shows, and the one a test can compare.
function flagString(l4) {
  if (!l4) return '';
  if (l4.proto === PROTO.UDP) return 'UDP';
  return (l4.flags || []).join(',');
}

function hasFlag(l4, flag) {
  return !!(l4 && Array.isArray(l4.flags) && l4.flags.indexOf(flag) !== -1);
}

function isFlowPacket(frame) {
  return !!(frame && frame.l4 && (frame.l4.proto === PROTO.TCP || frame.l4.proto === PROTO.UDP));
}

// The IP protocol number a transport header rides on.
function ipProto(proto) {
  return String(proto) === PROTO.UDP ? 17 : 6;
}

// --- what a device listens on ---------------------------------------------

// Explicit configuration wins outright: `dev.config.listeners` (or dev.listeners)
// is an array of ports, 'tcp/80' strings or { proto, port } objects, or the
// string 'any'. An explicit empty array means "this box has no listeners", which
// is different from "nobody said", so it must not fall through to the
// capability defaults.
function listenerPorts(dev) {
  const cfg = (dev && dev.config) || {};
  const raw = (dev && dev.listeners !== undefined && dev.listeners !== null)
    ? dev.listeners
    : cfg.listeners;

  if (raw !== undefined && raw !== null) {
    if (raw === true || String(raw).toLowerCase() === 'any') return 'any';
    const list = Array.isArray(raw) ? raw : [raw];
    const out = [];
    for (const item of list) {
      if (item === 'any') return 'any';
      if (typeof item === 'number') out.push({ proto: PROTO.TCP, port: item });
      else if (item && typeof item === 'object') {
        out.push({ proto: String(item.proto || PROTO.TCP).toLowerCase(), port: portOrNull(item.port) });
      } else {
        const text = String(item).trim().toLowerCase();
        const pair = /^(tcp|udp)\s*\/\s*(\d{1,5})$/.exec(text);
        if (pair) out.push({ proto: pair[1], port: portOrNull(pair[2]) });
        else if (/^\d{1,5}$/.test(text)) out.push({ proto: PROTO.TCP, port: portOrNull(text) });
      }
    }
    return out.filter(function (p) { return p && p.port; });
  }

  // Capability defaults. A device that is not a host and has no CLI (a plain
  // bridge, a PON splitter) terminates nothing above L2, so it listens on
  // nothing -- which is also why a flow to a switch's MAC-only port is refused
  // rather than silently absorbed.
  const caps = (dev && dev.capabilities) || [];
  const out = [];
  for (const cap of caps) {
    const ports = SERVICE_PORTS[cap];
    if (!ports) continue;
    for (const p of ports) out.push({ proto: p.proto, port: p.port });
  }
  // A resolver is a listener by definition: it exists to answer on 53.
  if (cfg.dnsZones && cfg.dnsZones.length) {
    out.push({ proto: PROTO.UDP, port: 53 });
    out.push({ proto: PROTO.TCP, port: 53 });
  }
  return out;
}

function listensOn(dev, proto, port) {
  if (!dev) return false;
  const want = portOrNull(port);
  if (!want) return false;
  const ports = listenerPorts(dev);
  if (ports === 'any') return true;
  const p = String(proto || PROTO.TCP).toLowerCase();
  return ports.some(function (x) { return x.proto === p && x.port === want; });
}

// --- state ----------------------------------------------------------------

function canTransition(from, to) {
  const allowed = TRANSITIONS[String(from)] || [];
  return allowed.indexOf(to) !== -1;
}

// Move a flow, refusing moves the protocol does not allow. Returns true when the
// state actually changed; a refused move leaves the record untouched rather than
// painting over a real state with a wishful one.
function setState(flowRec, to) {
  if (!flowRec || !to || flowRec.state === to) return false;
  if (!canTransition(flowRec.state, to)) return false;
  flowRec.state = to;
  return true;
}

// One table per topology, shared by every Simulator built against it: the UI
// opens a flow in one request and lists it in the next, so the record cannot live
// inside a single run.
function createFlowState() {
  return {
    flows: new Map(),      // id -> record
    // devId -> { bytesIn, bytesOut, packetsIn, packetsOut, flowsOpened, flowsRefused,
    //            ports: { portName -> { packetsIn, bytesIn, packetsOut, bytesOut } } }
    // The per-port tally is what `show interfaces` needs: a device total cannot answer "did anything
    // cross THIS port", which is the question the command is used to answer (#1251).
    counters: {},
    seq: 0                 // id allocator
  };
}

function resetFlowState(state) {
  const s = state || createFlowState();
  s.flows = new Map();
  s.counters = {};
  s.seq = 0;
  return s;
}

function nextFlowId(state) {
  const s = state || createFlowState();
  s.seq = (s.seq || 0) + 1;
  return 'flow-' + s.seq;
}

// The shape of a port tally with nothing counted yet. One function so the counter, the reader and the
// drop path cannot disagree about which fields exist (#1257).
function emptyPort() {
  return {
    packetsIn: 0, bytesIn: 0, packetsOut: 0, bytesOut: 0,
    transportPacketsIn: 0, transportBytesIn: 0, transportPacketsOut: 0, transportBytesOut: 0,
    drops: { total: 0, byReason: {} }
  };
}

function emptyDrops() {
  return { total: 0, byReason: {}, unported: 0 };
}

// What a reader gets: the whole shape, always, and a copy.
//
// `counterFor()` creates a record on the first counted packet and returns the live one. That is right for the
// accounting path and wrong for a payload: a device that has carried nothing came back with six keys and no
// `drops` at all, so a client adding up drops on an idle box read `undefined` and drew NaN, while a busier box in
// the same lab had the full record - one field, two shapes (#1329). And the record handed out was the engine's own,
// so a consumer that adjusted what it was given adjusted the tally.
//
// `counted` says whether anything has ever been counted for this device, which is not the same fact as a zero.
function counterSnapshot(state, devId, topology) {
  const live = (state && state.counters) ? state.counters[devId] : null;
  const c = live || {
    bytesIn: 0, bytesOut: 0, packetsIn: 0, packetsOut: 0,
    flowsOpened: 0, flowsRefused: 0,
    drops: emptyDrops(),
    ports: {}
  };
  const drops = c.drops || emptyDrops();
  const out = {
    bytesIn: c.bytesIn || 0,
    bytesOut: c.bytesOut || 0,
    packetsIn: c.packetsIn || 0,
    packetsOut: c.packetsOut || 0,
    flowsOpened: c.flowsOpened || 0,
    flowsRefused: c.flowsRefused || 0,
    counted: !!live,
    drops: {
      total: drops.total || 0,
      byReason: Object.assign({}, drops.byReason || {}),
      unported: drops.unported || 0
    },
    ports: {}
  };
  for (const name of Object.keys(c.ports || {})) {
    const p = c.ports[name] || {};
    const pd = p.drops || { total: 0, byReason: {} };
    out.ports[name] = {
      packetsIn: p.packetsIn || 0, bytesIn: p.bytesIn || 0,
      packetsOut: p.packetsOut || 0, bytesOut: p.bytesOut || 0,
      transportPacketsIn: p.transportPacketsIn || 0, transportBytesIn: p.transportBytesIn || 0,
      transportPacketsOut: p.transportPacketsOut || 0, transportBytesOut: p.transportBytesOut || 0,
      drops: { total: pd.total || 0, byReason: Object.assign({}, pd.byReason || {}) }
    };
  }
  return out;
}

function counterFor(state, devId) {
  const s = state || null;
  if (!s) return null;
  if (!s.counters[devId]) {
    s.counters[devId] = {
      bytesIn: 0, bytesOut: 0, packetsIn: 0, packetsOut: 0,
      flowsOpened: 0, flowsRefused: 0,
      drops: emptyDrops(),
      ports: {}
    };
  }
  return s.counters[devId];
}

// Count a packet on a device's interfaces. `dir` is 'in' or 'out'; `bytes` is the
// payload it carried (0 for a pure ACK, which is a real packet and a real
// interrupt, but not a byte of payload).
// Two tallies, because they answer two different questions.
//
//   * the device totals (`bytesIn`, `packetsOut`, …) are the *flow* accounting: transport payload a
//     connection carried. A flow's byte count must not move because a switch sent an LLDP frame.
//   * the port tallies (`ports[port]`) are the *interface* accounting: every frame that crossed that
//     socket, ARP and LLDP and ICMP included, which is what `show interfaces` reports.
//
// `kind` is 'l4' for transport and anything else for a control frame. It defaults to transport so callers
// that predate the distinction keep their meaning.
function countPacket(state, devId, dir, bytes, port, kind) {
  const c = counterFor(state, devId);
  if (!c) return null;
  const n = byteCount(bytes);
  const transport = (kind === undefined || kind === null || kind === 'l4');
  if (transport) {
    if (dir === 'out') { c.packetsOut += 1; c.bytesOut += n; }
    else { c.packetsIn += 1; c.bytesIn += n; }
  }
  // The same packet, against the port it crossed. Named, because "the device sent 12 packets" does not
  // tell you which socket to look at.
  if (port) {
    const key = String(port);
    if (!c.ports) c.ports = {};
    const p = c.ports[key] || (c.ports[key] = emptyPort());
    if (dir === 'out') {
      p.packetsOut += 1; p.bytesOut += n;
      if (transport) { p.transportPacketsOut += 1; p.transportBytesOut += n; }
    } else {
      p.packetsIn += 1; p.bytesIn += n;
      if (transport) { p.transportPacketsIn += 1; p.transportBytesIn += n; }
    }
  }
  return c;
}

// The tally for one port, or null when nothing has ever been counted on it. A port with no traffic on a
// device that has carried some reads zero for that port and non-zero for its neighbour - which is the
// distinction a total cannot make.
// How much a frame carried, whichever builder produced it.
//
// The counters used to be fed only when `frame.l4` existed, so ICMP echo and ARP - which carry `icmp` and
// `arp` instead - were never counted at all. A ping could succeed twenty times on a port that `show
// interfaces` then reported as having carried nothing, and the flow counters were the only place that
// noticed, which is nowhere an operator looks (#1251). Units are the payload the frame carried: the
// transport payload, the echo payload, or ARP's 28 bytes.
const ARP_PAYLOAD_BYTES = 28;

function frameBytes(frame) {
  if (!frame) return 0;
  if (frame.l4 && typeof frame.l4.bytes === 'number') return frame.l4.bytes;
  if (frame.icmp) {
    return typeof frame.icmp.bytes === 'number' ? frame.icmp.bytes : 56;   // the echo payload default
  }
  if (frame.arp) return ARP_PAYLOAD_BYTES;
  if (frame.lldp) return typeof frame.lldp.bytes === 'number' ? frame.lldp.bytes : 0;
  return 0;
}

function portCounters(state, devId, port) {
  const s = state || null;
  // null means "nothing is counting" and is the only case that does. A device that has simply not sent
  // anything yet has a measured zero, which is a different answer and the one `show interfaces` prints.
  if (!s || !s.counters) return null;
  const c = s.counters[devId];
  if (!c || !c.ports) {
    return {
      packetsIn: 0, bytesIn: 0, packetsOut: 0, bytesOut: 0,
      transportPacketsIn: 0, transportBytesIn: 0, transportPacketsOut: 0, transportBytesOut: 0
    };
  }
  return c.ports[String(port)] || emptyPort();
}

// What a device threw away, and why.
//
// `show interfaces` reported what crossed a port but nothing about what was discarded there, so two
// datagrams dropped for want of a route read the same as a port nothing ever touched: "0 packets input"
// beside a ping that failed twice. The reasons were already computed at every drop site and thrown away
// with the event log. Counted at the one place every drop passes through, so a new drop site cannot
// forget to tally itself.
function countDrop(state, devId, port, reason) {
  const c = counterFor(state, devId);
  if (!c) return null;
  if (!c.drops) c.drops = emptyDrops();
  const why = reason ? String(reason) : 'unspecified';
  c.drops.total += 1;
  c.drops.byReason[why] = (c.drops.byReason[why] || 0) + 1;
  // Some drops never had a port in scope - "no route to 10.77.77.77" happens before an egress is chosen -
  // and counting those against a port would invent one.
  if (port) {
    const key = String(port);
    const p = c.ports[key] || (c.ports[key] = emptyPort());
    if (!p.drops) p.drops = { total: 0, byReason: {} };
    p.drops.total += 1;
    p.drops.byReason[why] = (p.drops.byReason[why] || 0) + 1;
  } else {
    c.drops.unported += 1;
  }
  return c.drops;
}

// The device's whole drop tally, including the drops that named no port.
function dropsFor(state, devId) {
  const s = state || null;
  if (!s || !s.counters) return null;
  const c = s.counters[devId];
  if (!c || !c.drops) return emptyDrops();
  return c.drops;
}

function listFlows(state) {
  if (!state || !state.flows) return [];
  return Array.from(state.flows.values());
}

// A one-line description for the timeline and for `show flows`.
function describe(flowRec) {
  if (!flowRec) return '';
  const l4 = flowRec.proto === PROTO.UDP ? 'udp' : 'tcp';
  return l4 + ' ' + flowRec.srcIp + ':' + flowRec.srcPort + ' -> ' +
    flowRec.dstIp + ':' + flowRec.dstPort;
}

module.exports = {
  PROTO,
  STATE,
  TRANSITIONS,
  SERVICE_PORTS,
  IPV4_HDR,
  TCP_HDR,
  UDP_HDR,
  DEFAULT_MTU,
  DEFAULT_WINDOW,
  TCP_MIN_MSS,
  EPHEMERAL_FIRST,
  EPHEMERAL_LAST,
  mssForMtu,
  segmentCount,
  segmentSizes,
  createFlow,
  initialSeq,
  tcpPacket,
  udpPacket,
  synPacket,
  synAckPacket,
  ackPacket,
  dataPacket,
  finPacket,
  resetPacket,
  flagString,
  hasFlag,
  isFlowPacket,
  ipProto,
  listenerPorts,
  listensOn,
  canTransition,
  setState,
  createFlowState,
  counterSnapshot,
  resetFlowState,
  nextFlowId,
  counterFor,
  countDrop,
  dropsFor,
  emptyPort,
  countPacket,
  frameBytes,
  portCounters,
  listFlows,
  describe
};
