'use strict';
// simulator.js -- event-driven packet simulation.
//
// Layers: physical (media/speed, already modelled on the Link), L2 (802.1Q VLANs,
// MAC learning per VLAN, flooding within a VLAN, LAG egress selection, 802.1D
// spanning-tree blocking), and L3 (ARP, IPv4 longest-prefix routing, ICMP).
const net = require('./net');
const psLib = require('./portsecurity');
const vlanLib = require('./vlan');
const lagLib = require('./lag');
const stpLib = require('./stp');
const aclLib = require('./acl');
const ospfLib = require('./ospf');
const dnsLib = require('./dns');
const bgpLib = require('./bgp');
const lldp = require('./lldp');
const ipv6Lib = require('./ipv6');
const raLib = require('./ra');
const scionLib = require('./scion');
const natLib = require('./nat');
const flowLib = require('./flow');
const latencyLib = require('./latency');
const convergenceLib = require('./convergence');
const dhcpLib = require('./dhcp');
const vrrpLib = require('./vrrp');
const segmentLib = require('./segment');
const mediaModel = require('./media');

// Two routers advertise the same OSPF network; when the SPF cost ties, the
// lower advertising router id wins, so the installed table never depends on
// the order the topology happened to be walked in (#44).
function compareAdvId(a, b) {
  const x = (a === undefined || a === null) ? '' : String(a);
  const y = (b === undefined || b === null) ? '' : String(b);
  if (x === y) return 0;
  if (net.isIp(x) && net.isIp(y)) {
    try {
      const xi = net.ipToInt(x);
      const yi = net.ipToInt(y);
      if (xi !== yi) return xi < yi ? -1 : 1;
    } catch (err) { /* not a plain IPv4 router id: fall through */ }
  }
  return x < y ? -1 : 1;
}

// --- frame builders ---
// `opts` carries the two fields that are not part of an L2/L3 header but are part
// of this frame on this wire: the transport header (l4) and the simulator-only tag
// that says which flow the packet belongs to. The tag never crosses a socket in
// the real world; here it is what lets the return path be attributed to the
// connection that started it, through NAT, without guessing from a 4-tuple.
function ethFrame(dstMac, srcMac, etherType, ip, icmp, arp, opts) {
  const o = opts || {};
  return {
    dstMac: dstMac, srcMac: srcMac, etherType: etherType,
    ip: ip || null, icmp: icmp || null, arp: arp || null,
    l4: o.l4 || null, flow: o.flow || null,
    vid: 1, wireTagged: false, wireVid: null
  };
}

// The on-wire size of a frame, for the per-port counters.
//
// Deliberately approximate and deliberately stated: the console prints "100-byte ICMP Echos", so a
// ping contributes 100 bytes of payload plus a 20-byte IPv4 header and a 14-byte Ethernet header, and
// a transport segment contributes its own byte count plus the same headers. A counter that reported
// payload only would be a number every operator has to correct in their head, and a counter that
// claimed exact framing (preamble, FCS, minimum frame size) would be lying about a model that does
// not build them. ARP and LLDP are counted as the 64-byte minimum, which is what a real switch counts.
// The event types that mean "a frame was discarded on *this port*", and therefore belong in its drop
// counter. Everything else is deliberately absent:
//   - `poe-budget` announces that a PSE could not fund a port. Nothing was transmitted, so nothing was
//     dropped; charging the port would report a lost frame that never existed.
//   - `no route`, `TTL expired`, `echo for unknown local IP` and friends are `drop` events with no
//     port, because the frame was discarded before an egress was chosen. They are real drops that no
//     port counter can honestly own, and `show logging` is where they are read.
//   - `scion-drop` is a path-policy rejection in the SCION overlay, not a frame on a cable.
//   - `slaac-refused` and `tap-inject-refused` are configuration and test-instrument refusals.
const FRAME_DROP_TYPES = new Set(['drop', 'acl-deny', 'vlan-drop', 'stp-block', 'nat-drop', 'poe-deny']);

const ICMP_PAYLOAD_BYTES = 100;
function frameBytes(frame) {
  if (!frame) return 0;
  if (frame.l4 && frame.l4.bytes) return Number(frame.l4.bytes) + 34;
  if (frame.icmp) return ICMP_PAYLOAD_BYTES + 20 + 14;
  return 64;
}

function arpRequest(senderMac, senderIp, targetIp) {
  return ethFrame(
    net.BROADCAST_MAC, senderMac, net.ETH_ARP, null, null,
    { op: 'request', senderMac: senderMac, senderIp: senderIp, targetMac: net.ZERO_MAC, targetIp: targetIp }
  );
}

function arpReply(request, senderMac, senderIp) {
  return ethFrame(
    request.arp.senderMac, senderMac, net.ETH_ARP, null, null,
    { op: 'reply', senderMac: senderMac, senderIp: senderIp, targetMac: request.arp.senderMac, targetIp: request.arp.senderIp }
  );
}

// The untagged/native VLAN a port belongs to before ingress classification.
function portPvid(iface) {
  if (!iface) return 1;
  if (iface.encapVid) return Number(iface.encapVid);   // router subinterface
  if (!iface.vlan) return 1;
  if (iface.vlan.mode === 'trunk') return Number(iface.vlan.nativeVlan) || 1;
  return Number(iface.vlan.accessVlan) || 1;
}

// STP path cost from a link's negotiated speed.
function speedToCost(mbps) {
  if (!mbps) return 20000;
  if (mbps >= 100000) return 200;
  if (mbps >= 40000) return 400;
  if (mbps >= 25000) return 800;
  if (mbps >= 10000) return 2000;
  if (mbps >= 1000) return 20000;
  return 200000;
}

class Simulator {
  constructor(topology, opts) {
    this.topo = topology;
    // Flows outlive a run. The server builds a fresh Simulator for every HTTP
    // request but hands it the same table, so a flow opened in one request is
    // still there to be listed, closed or counted in the next.
    const o = opts || {};
    // Which instant questions are asked at. Infinity = fully converged, the behaviour every
    // existing lab and test relies on. See setRunTime().
    this.runAtMs = Infinity;
    this.flowState = o.flowState || flowLib.createFlowState();
    this.reset();
  }

  // Flows and interface counters, as a Map plus per-device tallies.
  get flows() { return this.flowState.flows; }
  get counters() { return this.flowState.counters; }

  reset() {
    this.events = [];
    // Per-port counters are NOT cleared here, for the reason DHCP leases are not: a console session
    // starts every command with a reset, so clearing them would make `show interfaces counters` always
    // report zero - the counters would be reset by the act of asking. They are cumulative from the
    // laboratory's start, exactly as a real device counts from boot, and `clear counters` is how an
    // operator zeroes them.
    this.queue = [];          // pending transmissions: {devId, iface, frame}
    this.step = 0;
    this.maxSteps = 8000;
    // NB: runAtMs is deliberately NOT reset here. reset() rewinds a run, and the instant the
    // question is asked at is a property of the question, not of the run - ping() calls reset()
    // first, so resetting it here would silently make every run "converged" again.
    this.icmpReplies = [];    // {dst, id, seq, step}
    this.icmp6Replies = [];   // {dst, id, seq, step}  (ICMPv6 echo replies)
    this.scion = null;        // last computed SCION beaconing state
    this._icmpId = 0x1000;
    this._ipId = 0x4000;      // IPv4 identification for transport packets
    this._stpDirty = true;
    this.stpResult = null;
    // Everything derived from the lab is now stale: a rewound run has no routes learned, no
    // adjacencies and no tree computed. Bumping the revision is what tells the next question to
    // re-derive the planes instead of answering from the state an earlier run left behind.
    this.markChanged();
    // Lease state per server device is *not* rebuilt: a binding is server state with a lifetime, so
    // it belongs with the MAC tables and ARP caches that survive a run, and it ages on the lease
    // timer rather than disappearing whenever something is asked. This used to be rebuilt on every
    // reset, which had two consequences the old code could not see because nothing aged at all: a
    // binding vanished the moment a ping was run (so `show ip dhcp binding` after a ping printed an
    // empty table while the client still held its address), and every run restarted the timer.
    //
    // Rebuilding was there to stop a stale lease making the second ping answer with an address
    // nobody was offered. That is now handled where it belongs: a client that holds a live lease
    // asks to renew *that* address instead of starting a new DISCOVER.
    if (!this._dhcpStates) this._dhcpStates = new Map();
    if (!this.dhcpLeases) this.dhcpLeases = [];
    if (this.dhcpExpired === undefined) this.dhcpExpired = null;
    // reset() rewinds a run, not the connection table: a ping must not tear down
    // somebody's TCP session.
    if (!this.flowState) this.flowState = flowLib.createFlowState();
  }

  // Per-port counters.
  //
  // These exist because of a promise I made and did not keep: the refusal for `show interfaces
  // counters` said "per-port counters and status are in `show interfaces <port>`", and that command
  // printed a name, a status and a peer - no counters at all. A message that sends an operator to a
  // command which cannot answer is worse than "not a command here", so the counters are now real, and
  // the command that was refused now exists.
  //
  // Counted where they happen: a frame that is transmitted is counted on the port it left, a frame
  // that arrives is counted on the port it arrived at, and a frame that is dropped is counted against
  // the port named in the drop event with the reason kept. Nothing is estimated, and a frame denied by
  // an ACL is never counted as output - it never left.
  // Nested per device, not a "dev/iface" string key: a port name contains slashes (`Gi0/0`, `1/1/3`),
  // so the flattened form could not be split back apart - the first version reported an empty table for
  // every device while `show interfaces Gi0/0` happily showed its counters.
  _portStat(devId, iface) {
    if (!this.portCounters) this.portCounters = new Map();
    let ports = this.portCounters.get(devId);
    if (!ports) { ports = new Map(); this.portCounters.set(devId, ports); }
    let rec = ports.get(iface);
    if (!rec) {
      rec = { rx: 0, tx: 0, rxBytes: 0, txBytes: 0, drops: 0, reasons: {} };
      ports.set(iface, rec);
    }
    return rec;
  }

  // The counters for one port, or for every port of a device as a sorted list.
  portStats(devId, iface) {
    const ports = (this.portCounters && this.portCounters.get(devId)) || null;
    if (iface) {
      const rec = ports && ports.get(iface);
      return rec || { rx: 0, tx: 0, rxBytes: 0, txBytes: 0, drops: 0, reasons: {} };
    }
    const out = [];
    for (const [name, rec] of (ports || new Map()).entries()) {
      out.push(Object.assign({ iface: name }, rec));
    }
    out.sort(function (a, b) { return String(a.iface).localeCompare(String(b.iface)); });
    return out;
  }

  _emit(ev) {
    ev.step = this.step;
    // Dropped frames are counted here, at the one place every drop site goes through, so a new drop
    // reason cannot be added without its port being charged for it.
    //
    // The types are named rather than matched by a regex, because the regex this replaced was wrong in
    // both directions: it charged a port for `poe-budget` - an announcement that a PSE could not fund
    // a port, where no frame ever existed - and it read "deny" inside that word, so the power
    // computation inflated the frame-drop count of whichever port lost the budget. A regex over
    // English type names is a guess about meaning; a set is a statement about it.
    if (ev && ev.iface && ev.dev && FRAME_DROP_TYPES.has(ev.type)) {
      const rec = this._portStat(ev.dev, ev.iface);
      rec.drops++;
      const why = ev.reason || ev.type;
      rec.reasons[why] = (rec.reasons[why] || 0) + 1;
    }
    this.events.push(ev);
    return ev;
  }

  // ---------------------------------------------------------------------
  // DNS resolution
  // ---------------------------------------------------------------------

  // Resolve a hostname to an IPv4 address using the devices in the topology.
  // A device answers for zones it hosts (config.dnsZones); a client asks the
  // servers in config.dnsServers, or any server in the lab when it lists none
  // (small labs would otherwise need explicit resolver configuration).
  resolveName(src, qname) {
    const client = src || null;
    const wanted = (client && client.config && client.config.dnsServers) || [];
    const candidates = [];

    for (const dev of this.topo.devices.values()) {
      const zones = (dev.config && dev.config.dnsZones) || [];
      if (!zones.length) continue;
      const ips = [];
      for (const i of dev.interfaces.values()) { if (i.enabled && i.ip) ips.push(i.ip); }
      const listed = ips.some(function (ip) { return wanted.indexOf(ip) !== -1; });
      if (wanted.length && !listed) continue;
      candidates.push({ dev: dev, zones: zones, ips: ips });
    }

    for (const c of candidates) {
      for (const zone of c.zones) {
        const res = dnsLib.resolve(zone, qname, 'A');
        const answers = (res && res.answers) || [];
        if (!answers.length) continue;
        const a = answers.filter(function (x) {
          return String(x.type || '').toUpperCase() === 'A';
        })[0] || answers[0];
        const addr = a && (a.value || a.address || a.data);
        if (addr) {
          return { ok: true, address: addr, status: 'OK', server: c.dev.name, rcode: res.rcode, answers: answers };
        }
      }
    }

    // Three different failures used to leave here as NXDOMAIN, which taught the
    // wrong lesson: "the A record is missing" and "the name does not exist" have
    // different causes and different fixes, and a resolver that answers
    // NOERROR-with-nothing is the whole reason NODATA is a distinct outcome (#241).
    let sawName = false;
    let sawZone = false;
    let server = candidates.length ? candidates[0].dev.name : null;

    for (const c of candidates) {
      for (const zone of c.zones) {
        const res = dnsLib.resolve(zone, qname, 'A');
        if (!res) continue;
        // Only an *authoritative* answer says anything about this name. A zone asked
        // about a name it does not own replies NXDOMAIN-without-authority, and counting
        // that as "a zone was asked" made `nothing.example` come back as
        // "NXDOMAIN from WEB" - accusing a server of denying a domain it never served.
        if (!res.authoritative) continue;
        sawZone = true;
        // The name exists in this zone (whatever the type), there is just no A.
        if (res.rcode !== dnsLib.RCODE.NXDOMAIN) sawName = true;
      }
    }

    if (!candidates.length) {
      // No device in the lab hosts any zone: that is a server failure, not a
      // statement about the name.
      return { ok: false, rcode: dnsLib.RCODE.SERVFAIL, status: 'SERVFAIL', server: null, answers: [] };
    }
    if (sawName) {
      // NOERROR, zero answers: the name resolves, the type does not exist.
      return { ok: false, rcode: dnsLib.RCODE.NOERROR, status: 'NODATA', server: server, answers: [] };
    }
    return {
      ok: false,
      rcode: dnsLib.RCODE.NXDOMAIN,
      status: sawZone ? 'NXDOMAIN' : 'SERVFAIL',
      server: server,
      answers: []
    };
  }

  // ---------------------------------------------------------------------
  // Latency (engine/latency.js)
  // ---------------------------------------------------------------------
  //
  // The simulator advances in queue steps, not in seconds: one step is "one frame
  // handed to one port", which is a hop count wearing the name of a time. A ping
  // answered on the first pass therefore reported rtt === hops, and a 40 km fibre
  // span came back in exactly the same time as a 1 m patch lead. The number a
  // ping is actually asked for -- the first thing anyone looks at -- is the delay,
  // so it is computed from the path the exchange really walked: every `frame`
  // event between the request and the reply names the port the frame left, and
  // that port's link carries the medium, the length and the line rate.
  //
  // The model itself lives in engine/latency.js and is pure. Nothing here adds a
  // timer or changes how many steps a run takes: the delay is a number computed
  // at the end of the run that already happened.

  // One direction of an echo exchange, as latency legs. A leg is one link
  // crossing, and every crossing but the last is entered by a device that must
  // receive the whole frame, decide, and transmit it again -- one store-and-
  // forward hop. The last crossing is entered by the host that answers, whose own
  // ICMP processing is explicitly not modelled.
  _echoLegs(events, icmpType, id, seq, bits) {
    const legs = [];
    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      if (e.type !== 'frame' || !e.frame || !e.frame.icmp) continue;
      const icmp = e.frame.icmp;
      if (icmp.type !== icmpType || icmp.id !== id || icmp.seq !== seq) continue;
      const link = this._linkAt(e.from, e.fromIface);
      const mediaId = link ? link.mediaId : null;
      const media = mediaId ? mediaModel.mediaById(mediaId) : null;
      legs.push({
        mediaId: mediaId,
        lengthM: link ? link.lengthM : null,
        speedMbps: (link && link.speedMbps) || (media && media.speedMbps) || null,
        bits: bits,
        hops: 0
      });
    }
    for (let i = 0; i < legs.length - 1; i++) legs[i].hops = 1;
    return legs;
  }

  // Out and back for one exchange: every link is crossed twice, so the round trip
  // is the sum of both directions, not one of them.
  _roundTripFor(events, reqType, replyType, id, seq, bits) {
    const forward = this._echoLegs(events, reqType, id, seq, bits);
    const reverse = this._echoLegs(events, replyType, id, seq, bits);
    return latencyLib.roundTripDetail(forward, reverse);
  }

  // ---------------------------------------------------------------------
  // Run instant (engine/convergence.js)
  // ---------------------------------------------------------------------
  //
  // Every control plane used to finish at t=0, because finish is the only thing it could do:
  // computeStp() blocked its ports and computeOspf() installed its routes before the first packet
  // was sent. That is the converged answer, always. A lab cannot show "power it on and watch it
  // come up" if coming up is instantaneous.
  //
  // `runAtMs` says which instant the question is being asked at. Infinity (the default) means
  // "once everything has converged", which is the behaviour every existing lab and test relies on.
  // A finite value leaves the processes that have not finished yet in the state they would really
  // be in: STP ports Listening or Learning (so they drop traffic), OSPF without its learned routes,
  // VRRP not yet owning the VIP.

  setRunTime(atMs) {
    const n = Number(atMs);
    this.runAtMs = Number.isFinite(n) && n >= 0 ? n : Infinity;
    return this.runAtMs;
  }

    // Rebuild the control planes that decide forwarding, in dependency order.
  //
  // Any question about "what would forward right now" has to do this first, in this order:
  // spanning tree blocks ports, PoE refuses to power a port, VRRP decides who owns a VIP, DHCP
  // hands out leases, then OSPF and BGP install routes. `tracePath()`, `openFlow()` and
  // `show ip route at <ms>` all ask that question, and a control plane missing from the list is
  // not a missing feature - it is a wrong answer (a flow to a VIP failed on a fresh simulator
  // because the election had not run).
  //
  // `atMs` re-bases the run at that instant first; without it the lab is taken as converged.
  refreshControlPlanes(opts) {
    const o = opts || {};
    if (o.atMs !== undefined && o.atMs !== null) this.setRunTime(o.atMs);
    if (o.reset) this.reset();
    // Derived once per change, not once per question. A console command asks the same question on a
    // fresh simulator as it does after a ping - `show spanning-tree` answered "no bridged ports" until
    // something else had run - so a reader derives the planes itself. Deriving them again on every
    // keystroke would re-run the DHCP exchange and re-announce LLDP, which are events, not answers.
    const asked = o.atMs !== undefined && o.atMs !== null;
    // Each "announce then hear" plane remembers whether its queue has actually been run: a plane that
    // was derived but whose frames were never delivered is not answered yet. DHCP joins LLDP and RA
    // here because the ACK is what puts the address on the port - without the flag, a lab configured
    // a moment ago answered `unassigned` to the first question and an address to the second.
    if (!asked && !o.force && this._planesDone === this._planesRev &&
      this._planesAtMs === this.runAtMs && (!o.lldp || this._planesLldp) &&
      (!o.ra || this._planesRa) && (!o.dhcp || this._planesDhcp)) {
      return;
    }
    this.computeStp();
    this.computePoe();
    // After the spanning tree, because an SVI's line protocol depends on whether *any* port in its
    // VLAN can carry traffic right now. A blocked port still counts, exactly as on a real switch.
    this.computeSviState();
    // LLDP and RA are not routing decisions, so a routing question can skip them - but a
    // question about what was *heard* cannot: `show lldp neighbors at <ms>` would answer
    // `none` forever if nothing announced. They run before VRRP because a group's virtual MAC
    // has to exist before anything advertises it.
    if (o.lldp) this.announceLldp();
    if (o.ra) this.announceRa();
    this.computeVrrp();
    this.computeDhcp();
    this.computeOspf();
    this.computeBgp();
    // Announcing is not hearing. `announceLldp()` puts frames in the queue, and a queue that is never
    // run leaves every neighbour table empty - which is why `show lldp neighbors` said "none" on a
    // fresh lab however often it was asked, and only filled in after a ping had delivered the frames.
    // The DHCP exchange is also announce-then-hear: responding to the ACK is what puts the address on
    // the interface, and that happens when the queue runs. Leaving the queue unrun meant a fresh
    // client's lease existed (so `show ip dhcp binding` reported it) while `show ip interface brief`
    // still said `unassigned`, until some unrelated command ran the queue - the answer depended on
    // what else had been typed.
    if (o.lldp || o.ra || o.dhcp) this._run();
    this._planesDone = this._planesRev;
    this._planesAtMs = this.runAtMs;
    if (o.lldp) this._planesLldp = true;
    if (o.ra) this._planesRa = true;
    if (o.dhcp) this._planesDhcp = true;
  }

  // An SVI is not up merely because it exists.
  //
  // A real switch brings `Vlan10`'s line protocol up only when at least one port in VLAN 10 can carry
  // traffic, and drops it when the last such port goes away. Modelling the SVI as permanently up made
  // a management address answer on a VLAN whose every port was shut, which is the one situation an
  // operator is usually trying to diagnose. The state is stored on the interface as `lineUp` and read
  // by ownsIpOn(), routeTo() and the two show commands, so there is one answer and not three.
  // A physical port's line state, for every table that has a state column.
  //
  // `lineUp` used to be maintained only for SVIs and subinterfaces, so a switch port with nothing
  // plugged into it answered `up/up` in `show ip interface brief` and `show interfaces`, and the new
  // `show interfaces status` would have had to invent `connected` for it. A port is up when the
  // administrator has not shut it, a cable is attached, and that cable's link is up - the same three
  // facts the data path already requires before it will forward a frame out of the port.
  computePortState() {
    for (const dev of this.topo.devices.values()) {
      for (const iface of dev.interfaces.values()) {
        if (iface.svi || iface.parent) continue;   // a logical interface borrows someone else's line
        if (!iface.peer) {
          iface.lineUp = false;
          iface.lineStateReason = 'no cable attached';
          continue;
        }
        // A port security violation err-disables the port: administratively enabled, operationally
        // dead. It is checked with the cable and the link because it is the same kind of fact - the
        // port cannot carry traffic - and `show interfaces` would otherwise report it up/up while
        // every frame on it was being dropped.
        const secState = psLib.peek(dev, iface.name);
        if (secState && secState.errDisabled) {
          iface.lineUp = false;
          iface.lineStateReason = 'err-disabled (port security): ' + (secState.shutdownReason || 'violation');
          continue;
        }
        const link = this._linkAt(dev.id, iface.name);
        if (link && !link.isUp()) {
          iface.lineUp = false;
          iface.lineStateReason = link.reason ? String(link.reason()) : 'the cable is down';
          continue;
        }
        iface.lineUp = true;
        iface.lineStateReason = null;
      }
    }
  }

  computeSviState() {
    const vlanLib = require('./vlan');
    // The SVIs below are decided from what the ports are doing, so the ports are decided first.
    this.computePortState();
    for (const dev of this.topo.devices.values()) {
      for (const iface of dev.interfaces.values()) {
        if (!iface.svi) continue;
        const vid = Number(iface.vlan && iface.vlan.accessVlan) || 1;
        let up = false;
        for (const port of dev.bridgedInterfaces()) {
          if (!port.peer) continue;                       // nothing plugged in
          if (port.parent) continue;                      // a subinterface is not a port
          const link = this._linkAt(dev.id, port.name);
          if (link && !link.isUp()) continue;             // cable down
          if (vlanLib.classifyEgress(port.vlan, vid).action === 'drop') continue; // not a member
          up = true;
          break;
        }
        iface.lineUp = up;
        // The reason has to be computed from *all* ports, not from the active ones: a shut port is
        // excluded from bridgedInterfaces(), so asking that list whether anything is cabled reported
        // "no port is cabled" on a switch whose every port was merely shut - the exact case an
        // operator is looking at when they read this line.
        const cabled = Array.from(dev.interfaces.values()).filter(function (p) {
          return !p.svi && !p.parent && p.peer;
        });
        iface.lineStateReason = up ? null
          : (cabled.length
            ? 'no active port in VLAN ' + vid
            : 'no port is cabled');
      }
      // A subinterface is a tag on its parent, so it has no line of its own: if the parent is
      // administratively down, or has no cable, the tagged interface is down too. It said `up` in
      // `show ip interface brief` while a ping to its address answered 0% - the data path knew and
      // the table did not, which is the one thing a state column must not do.
      for (const iface of dev.interfaces.values()) {
        if (!iface.parent) continue;
        const parent = dev.interfaces.get(iface.parent);
        if (!parent) {
          iface.lineUp = false;
          iface.lineStateReason = 'parent interface ' + iface.parent + ' is gone';
          continue;
        }
        if (!parent.enabled) {
          iface.lineUp = false;
          iface.lineStateReason = 'parent ' + parent.name + ' is administratively down';
          continue;
        }
        const plink = this._linkAt(dev.id, parent.name);
        if (parent.peer && plink && !plink.isUp()) {
          iface.lineUp = false;
          iface.lineStateReason = 'parent ' + parent.name + ' has no link';
          continue;
        }
        iface.lineUp = true;
        iface.lineStateReason = null;
      }
    }
    return this;
  }

  // The routing subset, kept as a name because that is the common question.
  refreshRoutes(opts) { this.refreshControlPlanes(opts); }

  // The schedule of when each process finishes, as data.
  getConvergence() {
    // Rebuilt on every call. It is a pure walk over the device list, and a cache here would be one
    // more thing that can disagree with the topology it describes.
    //
    // After a link change the same timers run again, from the instant of the change: that is what
    // re-convergence is. Without the offset, a lab that broke a cable would report the network as
    // converged because it converged once, hours ago, before the cable was pulled.
    const from = this.reconvergeFromMs !== undefined && this.reconvergeFromMs !== null
      ? this.reconvergeFromMs
      : (this.topo.lastChangeAtMs || 0);
    return convergenceLib.buildSchedule(this.topo, { fromMs: from });
  }

  // ---------------------------------------------------------------------
  // Link state (what happens when a cable is pulled)
  // ---------------------------------------------------------------------

  /**
   * setLinkState(linkId, 'up' | 'down', { atMs })
   *
   * Marks a cable up or down *without removing it*, which is the case a lab needs: the port still
   * exists, the cable is still plugged in at both ends, and nothing gets through.
   *
   * A change does three things beyond flipping the flag, all of them what real gear does:
   *   - the spanning tree is rebuilt, so a redundant topology heals around the failure;
   *   - every bridge's MAC table is flushed (a topology change notification), so frames are not
   *     unicast into the port that used to lead somewhere;
   *   - the convergence schedule is re-based at `atMs`, so the seconds after the change are the
   *     seconds during which nothing works.
   */
  setLinkState(linkId, state, opts) {
    const o = opts || {};
    const link = this.topo.getLink(linkId);
    if (!link) return { ok: false, code: 'E_NO_LINK', linkId: linkId };
    if (state !== 'up' && state !== 'down') {
      return { ok: false, code: 'E_BAD_STATE', detail: 'state must be up or down' };
    }

    const atMs = Number.isFinite(Number(o.atMs)) ? Number(o.atMs) : 0;
    const before = link.state;
    link.state = state;
    if (o.force !== true && before === state) {
      return { ok: true, linkId: linkId, changed: false, state: state, atMs: atMs };
    }

    // Topology change: MAC tables age out instantly in the model, and the tree is rebuilt.
    for (const dev of this.topo.devices.values()) {
      // A topology change notification flushes the forwarding tables. Keeping them would unicast
      // frames into the port that used to lead somewhere, which is the single most common way a
      // real network black-holes after a link failure.
      if (dev.macTable && typeof dev.macTable.clear === 'function') dev.macTable.clear();
      if (dev.macTables && typeof dev.macTables.forEach === 'function') {
        dev.macTables.forEach(function (m) { if (m && typeof m.clear === 'function') m.clear(); });
      }
    }
    // A cable moved: the tree, every SVI's line protocol and every relay path derived from the links
    // are stale, so the next question re-derives them instead of answering about a cable that is gone.
    this.markChanged();
    this._stpDirty = true;
    this.recomputeStp();
    this.reconvergeFromMs = atMs;
    link.stateSinceMs = atMs;
    // The network remembers: a later Simulator on this topology still knows when the cable moved.
    if (typeof this.topo.markChange === 'function') this.topo.markChange(atMs);

    const stp = convergenceLib.stpTimers({});
    return {
      ok: true, linkId: linkId, changed: true, state: state, atMs: atMs,
      // How long until this change has finished being absorbed.
      reconvergeAtMs: atMs + stp.forwardAtMs,
      affects: [link.a.deviceId, link.b.deviceId]
    };
  }

  // The tree is a function of the link states, so it is thrown away and rebuilt rather than
  // patched. Anything that reads stp right after a change sees the network as it is now.
  recomputeStp() {
    for (const dev of this.topo.devices.values()) {
      if (!dev.isBridge || !dev.isBridge()) continue;
      if (dev.stp) dev.stp.blocked = new Set();
      if (dev.portStates) dev.portStates = new Map();
    }
    this._stpDirty = true;
    try {
      this.computeStp();
    } catch (e) {
      // A half-built topology can legitimately fail to span; the next run rebuilds it.
      this._stpDirty = true;
    }
    return true;
  }

  linkDown(linkId, opts) { return this.setLinkState(linkId, 'down', opts); }
  linkUp(linkId, opts) { return this.setLinkState(linkId, 'up', opts); }

  // The lab changed: configuration, cabling, or the run itself. The control planes derived from it are
  // stale until something re-derives them, and a reader must never answer from the previous state.
  // A counter, not a set of dirty flags: the planes depend on each other (an SVI's line protocol reads
  // the tree, OSPF reads the addresses), so the whole set is derived together or not at all.
  markChanged() {
    this._planesRev = (this._planesRev || 0) + 1;
    return this._planesRev;
  }

  // Has this process on this device finished by the run instant?
  _converged(process, dev) {
    if (this.runAtMs === Infinity) return true;
    const sched = this.getConvergence();
    const t = convergenceLib.readyAt(sched, process, dev.id);
    return t === null ? true : t <= this.runAtMs;
  }

  // Processes still running at the run instant, earliest first - the honest reason a packet
  // went nowhere.
  _stillConverging() {
    if (this.runAtMs === Infinity) return [];
    const sched = this.getConvergence();
    return convergenceLib.at(sched, this.runAtMs).pending;
  }

  // --- public: run a ping from srcDeviceId to dstIp ---
  ping(srcId, dstIp, opts) {
    opts = opts || {};
    const count = opts.count || 4;
    // Ask the question at an instant, if the caller named one. setRunTime() is the assignment;
    // this is the convenience form, so `ping(a, b, { atMs: 5000 })` cannot quietly be ignored.
    if (opts.atMs !== undefined) this.setRunTime(opts.atMs);
    this.reset();
    // Recompute spanning tree before the run so blocked ports are honoured.
    this.computeStp();
    // Resolve PoE power before the run: an unpowered device must not transmit.
    this.computePoe();
    // Elect the virtual gateways first: a host that pulls a gateway from DHCP should be pulling the
    // address something actually answers for.
    this.computeVrrp();
    // Let hosts pull addresses before anything is asked of them.
    this.computeDhcp();
    // Announce ourselves on every cabled port, the way real gear does on link-up.
    this.announceLldp();
    // Then let the routers hand out IPv6 prefixes, so a host configured for
    // autoconfiguration has an address before anyone asks it to send a packet.
    this.announceRa();
    // Recompute OSPF so learned routes are present before the first packet.
    this.computeOspf();
    // Recompute BGP so learned routes are present before the first packet.
    this.computeBgp();
    const src = this.topo.getDevice(srcId);
    if (!src) throw new Error('Unknown device: ' + srcId);

    // A hostname destination is resolved through the lab's DNS servers before
    // a single packet is sent, exactly like a real host would.
    let target = dstIp;
    let dnsResult = null;
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(String(dstIp))) {
      dnsResult = this.resolveName(src, String(dstIp));
      this._emit({
        type: 'dns', qname: String(dstIp), ok: !!dnsResult.ok,
        address: dnsResult.address || null, server: dnsResult.server || null,
        rcode: dnsResult.rcode, status: dnsResult.status || null
      });
      if (!dnsResult.ok) {
        return {
          events: this.events,
          // Name the failure the resolver actually reported, so a NODATA does not
          // present itself in the timeline as a missing domain (#241).
          replies: [{ seq: 0, success: false,
            reason: 'dns-' + String(dnsResult.status || 'nxdomain').toLowerCase() }],
          step: this.step, success: false, resolved: null, dns: dnsResult
        };
      }
      target = dnsResult.address;
    }

    const id = this._icmpId++;
    const replies = [];
    // How many bits an echo frame puts on the wire. Serialisation time is a
    // function of it, so it is computed once for the whole run.
    const bits = latencyLib.pingFrameBits(opts.payloadSize);
    for (let seq = 0; seq < count; seq++) {
      const startStep = this.step;
      const evStart = this.events.length;
      this._emit({ type: 'ping', src: srcId, dst: target, seq: seq });
      this._sendIcmp(src, target, { type: net.ICMP_ECHO_REQUEST, code: 0, id: id, seq: seq });
      this._run();
      const got = this.icmpReplies.filter(function (r) {
        return r.dst === srcId && r.id === id && r.seq === seq;
      })[0];
      // Time the frame actually spent: propagation in the medium of every link
      // crossed, twice (out and back), serialisation at every port twice, and
      // store-and-forward at every device in between. `hops` stays what it always
      // was -- the queue-step count -- so callers that use it are unaffected.
      const delay = got
        ? this._roundTripFor(this.events.slice(evStart), net.ICMP_ECHO_REQUEST, net.ICMP_ECHO_REPLY, id, seq, bits)
        : null;
      // A run asked at an instant before everything has converged deserves the reason, not just
      // silence: "no reply" and "the spanning tree is still learning" look identical otherwise.
      const pending = got ? [] : this._stillConverging();
      replies.push({
        seq: seq,
        success: !!got,
        reason: got ? null : (pending.length ? 'converging' : null),
        pending: pending.map(function (e) {
          return { process: e.process, device: e.device.name, readyAtMs: e.readyAtMs };
        }),
        convergingUntilMs: pending.length ? pending[0].readyAtMs : null,
        hops: got ? (got.step - startStep) : null,
        rtt: delay ? delay.totalMs : null,
        rttUs: delay ? delay.totalUs : null,
        lengthKnown: delay ? delay.lengthKnown : null,
        delay: delay
      });
    }
    return { events: this.events, replies: replies, step: this.step, success: replies.some(function (r) { return r.success; }), resolved: target, dns: dnsResult };
  }

  // ---------------------------------------------------------------------
  // Spanning tree (802.1D)
  // ---------------------------------------------------------------------

  // The link attached to (devId, iface), or null.
  _linkAt(devId, ifaceName) {
    for (const l of this.topo.links.values()) {
      const e = l.endpoint(devId, ifaceName);
      if (e) return l;
    }
    return null;
  }

  // Logical port name for a physical port: LAG members collapse into one port.
  _logicalPortName(dev, ifaceName) {
    const lag = dev.lagFor ? dev.lagFor(ifaceName) : null;
    return lag ? ('lag-' + lag.id) : ifaceName;
  }

  // Build the STP graph and mark blocking ports on each device.
  computeStp() {
    const bridges = [];
    for (const dev of this.topo.devices.values()) {
      if (!dev.isL2()) continue;

      // Group physical ports into logical ports (one per LAG).
      const groups = {};
      for (const iface of dev.interfaces.values()) {
        if (!iface.peer) continue;
        // A port whose cable is down is not a port as far as the spanning tree is concerned - that
        // is precisely how a redundant topology heals itself when a link fails.
        const ownLink = this._linkAt(dev.id, iface.name);
        if (ownLink && !ownLink.isUp()) continue;
        const key = this._logicalPortName(dev, iface.name);
        if (!groups[key]) groups[key] = [];
        groups[key].push(iface);
      }

      const ports = [];
      for (const key of Object.keys(groups)) {
        const members = groups[key];
        const first = members[0];
        const peerDev = this.topo.getDevice(first.peer.deviceId);
        const link = this._linkAt(dev.id, first.name);
        // A configured speed beats the cable's negotiated speed, exactly as `spanning-tree cost` beats
        // both: `speed 100` on a 1G port is a fact about the port, and the tree should see it.
        const configuredMbps = members.filter(function (m) { return m.speedConfigured && m.speedMbps; })[0];
        let cost = speedToCost(configuredMbps ? Number(configuredMbps.speedMbps)
          : (link ? link.speedMbps : null));
        // `spanning-tree cost <n>` beats the speed-derived cost, exactly as on real gear: the whole
        // point of the command is to make the tree choose a path the speeds would not.
        for (const m of members) {
          if (m.stpCost !== undefined && m.stpCost !== null) { cost = Number(m.stpCost); break; }
        }
        if (members.length > 1 && members[0].stpCost === undefined) {
          cost = Math.round(cost / members.length); // aggregate
        }
        ports.push({
          name: key,
          cost: cost,
          to: (peerDev && peerDev.isL2())
            ? { bridge: peerDev.id, port: this._logicalPortName(peerDev, first.peer.iface) }
            : null
        });
      }

      let mac = null;
      for (const iface of dev.interfaces.values()) {
        if (iface.mac && (!mac || iface.mac < mac)) mac = iface.mac;
      }

      bridges.push({
        key: dev.id,
        // Priority 0 is legal (it wins every election) and `||` threw it away, so the lowest
        // possible bridge priority was the one priority the model ignored.
        priority: (dev.config && dev.config.stpPriority !== undefined && dev.config.stpPriority !== null)
          ? dev.config.stpPriority : stpLib.STP_DEFAULT_PRIORITY,
        mac: mac || '00:00:00:00:00:00',
        ports: ports
      });
    }

    const res = stpLib.runStp({ bridges: bridges });
    this.stpResult = res;

    // Reset, then apply decisions back onto physical ports.
    for (const dev of this.topo.devices.values()) {
      if (!dev.isL2()) continue;
      // `show spanning-tree` has to answer "who is root, and why this port" -- the help row for it
      // promised a root bridge while the table printed roles only. Carrying the election's own
      // answers (root identity, path cost, per-port cost) alongside the roles costs nothing here
      // and is the difference between a table and an answer.
      dev.stp = {
        blocked: new Set(), states: {}, roles: {}, costs: {},
        root: { priority: res.root && res.root.priority, mac: res.root && res.root.mac },
        pathCost: (res.pathCost && res.pathCost[dev.id] !== undefined) ? res.pathCost[dev.id] : null,
        // The bridge ID is the lowest interface MAC, which is what the election actually compared;
        // `dev.mac` is null on a switch until something assigns it, so comparing against it made
        // every switch look like a non-root and left the root unnamed.
        bridgeId: (function () {
          let m = null;
          for (const i of dev.interfaces.values()) {
            if (i.mac && (!m || i.mac < m)) m = i.mac;
          }
          return m;
        })(),
        isRoot: false
      };
      dev.stp.isRoot = !!(res.root && String(res.root.mac || '') === String(dev.stp.bridgeId || ''));
    }
    for (const bridgeKey of Object.keys(res.ports || {})) {
      const dev = this.topo.getDevice(bridgeKey);
      if (!dev || !dev.stp) continue;
      const portMap = res.ports[bridgeKey];
      for (const logicalName of Object.keys(portMap)) {
        const info = portMap[logicalName];
        dev.stp.states[logicalName] = info.state;
        dev.stp.roles[logicalName] = info.role;
        dev.stp.costs[logicalName] = info.cost;
        if (info.state === 'blocking') {
          // mark every physical member of this logical port as blocked
          for (const iface of dev.interfaces.values()) {
            if (this._logicalPortName(dev, iface.name) === logicalName) {
              dev.stp.blocked.add(iface.name);
            }
          }
        }
      }
    }

    // A port that is *destined* to forward is not forwarding yet: it is somewhere between
    // Listening and Learning, and it drops traffic in both. This is the whole point of asking a
    // question at an instant - the cable is green, the switch is up, and nothing passes.
    if (this.runAtMs !== Infinity) {
      for (const dev of this.topo.devices.values()) {
        if (!dev.isL2() || !dev.stp) continue;
        if (this._converged('stp', dev)) continue;
        for (const logicalName of Object.keys(dev.stp.states || {})) {
          const steady = dev.stp.states[logicalName];
          if (steady === 'blocking') continue;
          const now = convergenceLib.stpPortStateAt(dev, true, this.runAtMs);
          dev.stp.states[logicalName] = now;
          if (!convergenceLib.stpForwardsIn(now)) {
            for (const iface of dev.interfaces.values()) {
              if (this._logicalPortName(dev, iface.name) === logicalName) {
                dev.stp.blocked.add(iface.name);
              }
            }
          }
        }
      }
    }
    this._stpDirty = false;
    return res;
  }

  // ---------------------------------------------------------------------
  // VRRP (engine/vrrp.js)
  // ---------------------------------------------------------------------
  //
  // The election was implemented and never called: a lab could configure a virtual gateway and no
  // device would answer for it, so every host pointing at the VIP black-holed and the failure looked
  // like a routing mistake. This runs the election over each L2 segment before the first packet,
  // hands the winner its group's addresses, and lets ownsIpOn() serve them.
  //
  // Candidates are the routers in the same broadcast domain with the same vrid - a VRRP peer that
  // cannot hear you is not a peer - and the winner answers ARP with the group's virtual MAC, which
  // is what makes a failover invisible to the hosts.

  computeVrrp() {
    const events = [];
    for (const dev of this.topo.devices.values()) dev.clearVrrp();

    // Group the candidates by (segment, vrid): peers are whoever shares a broadcast domain.
    const elections = new Map();
    for (const dev of this.topo.devices.values()) {
      const groups = Array.isArray(dev.config && dev.config.vrrp) ? dev.config.vrrp : [];
      for (const raw of groups) {
        const g = vrrpLib.normalizeGroup(raw);
        if (!g.ips.length) continue;
        const ifaceName = dev.resolveIface(g.interfaceName || '') || dev.interfaces.get(g.interfaceName);
        if (!ifaceName) continue;
        if (ifaceName.enabled === false || !ifaceName.ip) continue;

        // The set of routers that can hear each other on this interface.
        const segment = segmentLib.segmentOf(this.topo, dev, ifaceName.name);
        // A VRRP peer is a device that can hold an L3 address in this domain. There is no
        // isRouter() on Device - the capability is isL3(), and a bridged L3 switch can hold a
        // virtual gateway too.
        const peerIds = segment
          .filter(function (e) { return e.device && e.device.isL3 && e.device.isL3(); })
          .map(function (e) { return e.device.id; });
        peerIds.push(dev.id);
        const key = peerIds.slice().sort().join('|') + '#vrid' + g.vrid;

        if (!elections.has(key)) {
          elections.set(key, { vrid: g.vrid, group: g, peerIds: peerIds, candidates: [] });
        }
        const e = elections.get(key);
        if (!e.candidates.some(function (c) { return c.id === dev.id; })) {
          e.candidates.push({
            id: dev.id, dev: dev, iface: ifaceName,
            priority: g.priority, ip: ifaceName.ip,
            // A group on a down interface relinquishes mastership - that is the failover every lab
            // is built to demonstrate. "Down" has to mean what `show ip interface brief` says it
            // means: shut, no cable, or an SVI whose VLAN carries nothing. Checking only `enabled`
            // and `ip` left a router that had its cable pulled reporting `State: Master` while the
            // other router had already taken the group - two masters in one table.
            up: ifaceName.enabled !== false && !!(ifaceName.ip) && ifaceName.lineUp !== false &&
              (function () {
                const l = this._linkAt(dev.id, ifaceName.name);
                return !(ifaceName.peer && l && !l.isUp());
              }).call(this)
          });
        }
      }
    }

    for (const e of elections.values()) {
      // Only routers that actually belong to the segment and run this vrid can win it.
      const voters = e.candidates.filter(function (c) { return e.peerIds.indexOf(c.id) !== -1; });
      if (!voters.length) continue;

      const res = vrrpLib.electMaster(voters.map(function (c) {
        return { id: c.id, priority: c.priority, ip: c.ip, up: c.up };
      }), e.group);

      const master = voters.filter(function (c) { return c.id === res.masterId; })[0];
      if (!master) continue;

      // A master whose own group has not finished converging does not own the VIP yet.
      const owning = this._converged('vrrp', master.dev);
      if (owning) {
        master.dev.claimVrrp({
          vrid: e.vrid, iface: master.iface.name,
          ips: e.group.ips, mac: vrrpLib.virtualMac(e.vrid)
        });
        // A gratuitous ARP per virtual address, and it is not decoration: a switch's MAC table
        // still points the virtual MAC at the *old* master's port, so without this every frame for
        // the gateway is unicast into a box that no longer owns it and black-holes. This is exactly
        // why real VRRP masters send one on takeover.
        for (const vip of e.group.ips) {
          this._sendGratuitousArp(master.dev, master.iface, vip, vrrpLib.virtualMac(e.vrid));
          events.push({
            type: 'garp', dev: master.dev.id, devName: master.dev.name, iface: master.iface.name,
            ip: vip, mac: vrrpLib.virtualMac(e.vrid), vrid: e.vrid
          });
        }
      }

      events.push({
        type: 'vrrp', vrid: e.vrid, ips: e.group.ips.slice(),
        master: master.dev.id, masterName: master.dev.name, iface: master.iface.name,
        priority: master.priority, reason: res.reason,
        backups: voters.filter(function (c) { return c.id !== master.dev.id; })
          .map(function (c) { return c.dev.name; }),
        mac: vrrpLib.virtualMac(e.vrid),
        owning: owning
      });
    }

    for (const ev of events) this._emit(ev);
    return events;
  }

  // A gratuitous ARP: a broadcast *request* whose sender address is the address being announced,
  // so every switch relearns the MAC on the new port and every host replaces a stale cache entry.
  _sendGratuitousArp(dev, iface, ip, mac) {
    if (!iface || iface.enabled === false) return null;
    const frame = arpRequest(mac, ip, ip);
    this._sendFromOwnIp(dev, iface, frame, portPvid(iface));
    return frame;
  }

  // ---------------------------------------------------------------------
  // DHCP (engine/dhcp.js, engine/segment.js)
  // ---------------------------------------------------------------------
  //
  // The library modelled the exchange completely and nothing called it: `ip address dhcp` set a
  // flag, no DISCOVER was ever sent, and the host stayed unaddressed for the life of the lab. This
  // is the caller.
  //
  // A DISCOVER is a broadcast, so the servers are whatever sits in the same broadcast domain and
  // holds a pool covering its own interface subnet. The exchange runs before the first packet the
  // user asked for, which is when a real host would have done it too.

  // The clock DHCP leases are measured against.
  //
  // Leases are counted in ticks (one tick = one second - `dhcp.js STEP_SECONDS`) while a question is
  // asked in milliseconds. Before this existed, the exchange stamped leases with `this.step`, the
  // *packet-loop* counter, which never moves when someone asks `at 120000` - so a 60-second lease
  // still said "Expires in 60s" two minutes later, and the lease timer was decoration.
  _nowStep() {
    if (Number.isFinite(this.runAtMs)) return Math.floor(this.runAtMs / 1000);
    // No instant asked means "the run at rest", which is t=0 - not `this.step`, which counts frame
    // hops during a packet run. Using the hop counter as a clock made a fresh lab report a 62-second
    // lease on a 60-second pool, and made the answer depend on how many pings had been sent.
    return 0;
  }

  // Which router on this wire will forward the client's request, and to whom.
  //
  // `ip helper-address` is a per-port statement, so this looks at every other device on the shared
  // segment for a port that (a) has helper addresses and (b) has an address of its own, because that
  // address becomes giaddr - the field that tells the server which subnet to allocate from. The
  // helper target has to be a device in the lab that actually owns the named address and has a pool
  // covering the relay port's subnet; anything less and the request is not relayable, so the client
  // keeps its honest `no-server` answer.
  _dhcpRelayFor(client, clientIface, segment) {
    for (const endpoint of segment) {
      const router = endpoint.device;
      if (!router || router === client) continue;
      const port = endpoint.iface;
      if (!port || !port.ip || !port.mask) continue;
      const helpers = port.helperAddresses;
      if (!Array.isArray(helpers) || !helpers.length) continue;
      for (const target of helpers) {
        for (const dev of this.topo.devices.values()) {
          if (dev === router || !dev.config || !Array.isArray(dev.config.dhcpPools)) continue;
          if (!dev.config.dhcpPools.length) continue;
          if (!dev.interfaceWithIp(target)) continue;
          // The server has to have a pool for the subnet the relay port sits in - that is what
          // giaddr is for. A server with pools only for its own wire cannot serve this client.
          const covering = dev.config.dhcpPools.filter(function (rawPool) {
            try {
              const pool = dhcpLib.normalizePool(rawPool);
              if (!dhcpLib.validatePool(pool).ok) return false;
              return net.ipInSubnet(port.ip, pool.network, pool.mask);
            } catch (e) { return false; }
          });
          if (!covering.length) continue;
          const srvPort = dev.interfaceWithIp(target);
          return {
            relay: { dev: router, iface: port },
            giaddr: port.ip,
            server: { device: dev, iface: srvPort },
            helper: target
          };
        }
      }
    }
    return null;
  }

  computeDhcp() {
    const events = [];
    const nowStep = this._nowStep();
    let expired = 0;

    // A server forgets a binding when its own lease timer runs out, whatever the client is doing -
    // that is what makes the pool's free list grow again. `expireLeases()` has existed and been
    // tested since the DHCP work and had no caller, so nothing in a live lab ever aged.
    for (const state of this._dhcpStates.values()) {
      expired += dhcpLib.expireLeases(state, nowStep);
    }
    // Recorded *with the step it happened at*, and never reset to zero: a second refresh at the same
    // instant finds nothing left to expire, and forgetting that a lease had just died made the empty
    // table claim "no client has completed an exchange" - the opposite of what had happened.
    if (expired) this.dhcpExpired = { step: nowStep, count: expired };

    for (const dev of this.topo.devices.values()) {
      // Which interfaces are asking?
      const clients = [];
      for (const iface of dev.interfaces.values()) {
        if (iface.dhcp && iface.enabled !== false) clients.push(iface);
      }
      if (!clients.length) continue;

      // A run asked at an instant before the exchange finished leaves the host unaddressed, which
      // is exactly what a real host is at that moment - and the ping path reports it as converging
      // rather than as a broken lab.
      if (!this._converged('dhcp', dev)) continue;

      for (const clientIface of clients) {
        const segment = segmentLib.segmentOf(this.topo, dev, clientIface.name);
        let servers = segment.filter(function (e) {
          return e.device && e.device !== dev && e.device.config &&
            Array.isArray(e.device.config.dhcpPools) && e.device.config.dhcpPools.length &&
            e.iface.ip;
        });
        // Nothing on this wire to ask. A DISCOVER is a broadcast and dies at the first router, which
        // is why `ip helper-address` exists: the router on this wire re-sends it as a unicast to a
        // server somewhere else, stamping its own port address into giaddr so the server knows which
        // subnet to allocate from. Without this a lab with a central server and a remote subnet
        // simply never worked, and said `no-server`.
        let relay = null;
        if (!servers.length) relay = this._dhcpRelayFor(dev, clientIface, segment);
        if (relay) servers = [relay.server];

        // A host that already holds a live lease does not start over. Before this, every refresh ran
        // a fresh DISCOVER, so asking the same question twice could hand the client a *different*
        // address (10.0.1.100, then 10.0.1.101) and re-stamp the timer as if no time had passed.
        // A released lease stays released until someone asks for one. Without this, the next refresh
        // (any `show` at all, since deriving the planes runs this pass) ran a fresh DISCOVER and the
        // address came straight back - so `release dhcp` reported a release, `show ip interface brief`
        // showed no address, and the next command showed the address again with the same lease.
        if (clientIface.dhcpReleased && !clientIface.dhcpForceRenew) continue;
        // `renew dhcp` is an instruction, not a question: it asks the server even inside T1, which is
        // the whole point of the verb. Everything else keeps the "still valid" shortcut.
        const held = clientIface.dhcpForceRenew ? null : clientIface.dhcpLease;
        if (held && held.expiresStep !== undefined && held.expiresStep > nowStep) {
          // Renewal is due at T1 = half the lease; before that the lease is simply still valid, and
          // nothing about it changes.
          const t1 = held.expiresStep - Math.max(1, Math.floor(held.leaseSec || 0) / 2);
          if (nowStep < t1) {
            events.push({
              type: 'dhcp', client: dev.id, clientName: dev.name, iface: clientIface.name,
              mac: held.mac, phase: 'held', ok: true, ip: held.ip,
              leaseSec: held.leaseSec, remainingSec: held.expiresStep - nowStep,
              detail: 'lease still valid until step ' + held.expiresStep
            });
            continue;
          }
        }

        // An expired lease is not held any more: the client drops the address before asking again,
        // which is what leaves it honestly unaddressed when no server answers.
        if (held && held.expiresStep !== undefined && held.expiresStep <= nowStep) {
          events.push({
            type: 'dhcp', client: dev.id, clientName: dev.name, iface: clientIface.name,
            mac: held.mac, phase: 'expired', ok: false, ip: held.ip,
            detail: 'lease expired at step ' + held.expiresStep + '; the client asks again'
          });
          clientIface.ip = null;
          clientIface.mask = null;
          clientIface.dhcpLease = null;
        }

        // A renewal asks for the address the client already holds; the first exchange asks for
        // nothing in particular.
        const result = this._runDhcpExchange(dev, clientIface, servers, {
          requestedIp: clientIface.dhcpLease ? clientIface.dhcpLease.ip : null,
          nowStep: nowStep,
          relay: relay
        });
        events.push(result.event);
        if (result.lease) {
          if (result.lease.giaddr) {
            // Remember which server handed this out and from which relay, so its binding table can
            // say so. Replaced rather than appended when the same address is re-leased.
            if (!this._dhcpRelayed) this._dhcpRelayed = [];
            this._dhcpRelayed = this._dhcpRelayed.filter(function (r) {
              return r.ip !== result.lease.ip;
            });
            const srv = this.topo.devices.values();
            let serverId = null;
            for (const d of srv) {
              if (d.interfaceWithIp(result.lease.server)) { serverId = d.id; break; }
            }
            this._dhcpRelayed.push({
              serverId: serverId, ip: result.lease.ip, giaddr: result.lease.giaddr,
              relayDevice: result.lease.relayDevice, client: dev.id
            });
          }
          clientIface.ip = result.lease.ip;
          clientIface.mask = result.lease.mask;
          clientIface.dhcpLease = result.lease;
          if (!dev.config.defaultGateway && result.lease.gateway) {
            dev.config.defaultGateway = result.lease.gateway;
          }
          this.dhcpLeases.push(result.lease);
        }
      }
    }
    for (const e of events) this._emit(e);
    return events;
  }

  // The leases a device holds as a DHCP server, ordered by address. Public: the CLI
  // and an inspector panel should read the same numbers, and neither should reach
  // into `_dhcpStates`.
  // Give a lease back. The client drops the address and every server that recorded the binding
  // forgets it, which is what makes `show ip dhcp binding` on the server agree with
  // `show ip interface brief` on the client after `release dhcp` - the two tables are written by
  // this one call rather than by two commands that could disagree.
  releaseDhcpLease(clientId, ifaceName) {
    const client = this.topo.getDevice(clientId);
    if (!client) return null;
    const iface = client.interfaces.get(ifaceName);
    if (!iface || !iface.dhcpLease) return null;
    const mac = iface.dhcpLease.mac || iface.mac;
    const held = iface.dhcpLease;
    let forgotten = 0;
    for (const state of (this._dhcpStates ? this._dhcpStates.values() : [])) {
      if (dhcpLib.releaseLease(null, state, mac)) forgotten++;
    }
    if (Array.isArray(this.dhcpLeases)) {
      const before = this.dhcpLeases.length;
      this.dhcpLeases = this.dhcpLeases.filter(function (l) {
        return !(l.clientId === clientId && l.iface === ifaceName);
      });
      forgotten += before - this.dhcpLeases.length;
    }
    iface.ip = null;
    iface.mask = null;
    iface.dhcpLease = null;
    return { ip: held.ip, mac: mac, forgotten: forgotten };
  }

  dhcpBindings(devId) {
    // Passed the clock the answer is about, so `Expires in` is a countdown rather than the
    // configured lease length restated.
    return dhcpLib.leaseTable(this._dhcpStates.get(devId), this._nowStep());
  }

  // Which of this server's live bindings arrived through a relay, and from where. Kept beside the
  // lease state rather than inside it because giaddr is a property of the *exchange*, not of the
  // lease (the library's lease record is address + deadline, deliberately).
  dhcpRelayedBindings(devId) {
    const out = [];
    for (const rec of (this._dhcpRelayed || [])) {
      if (rec.serverId !== devId) continue;
      const state = this._dhcpStates.get(devId);
      const stillThere = state && dhcpLib.leaseTable(state)
        .some(function (row) { return row.ip === rec.ip; });
      if (stillThere) out.push(rec);
    }
    return out;
  }

  // One client, one interface, one exchange. `opts.requestedIp` makes it a *renewal*: a client that
  // already holds a lease sends REQUEST straight for its address (no DISCOVER), and a NAK sends it
  // back to the beginning - which is what a real host does. `opts.nowStep` is the instant the
  // question is being asked at, so a lease is stamped against the clock the answer is about.
  _runDhcpExchange(client, clientIface, servers, opts) {
    const o = opts || {};
    const step = o.nowStep === undefined ? this.step : o.nowStep;
    const mac = clientIface.mac || (client.macAddress || '00:00:00:00:00:00');
    const base = {
      type: 'dhcp', client: client.id, clientName: client.name,
      iface: clientIface.name, mac: mac
    };

    if (!servers.length) {
      return {
        lease: null,
        event: Object.assign({}, base, {
          phase: 'failed', reason: 'no-server',
          detail: 'no DHCP server in this broadcast domain'
        })
      };
    }

    // A server answers only for a pool that covers the subnet the request came *from*. Without a
    // relay that is the server's own interface; with one it is the giaddr the relay wrote - which is
    // the whole reason the field exists, since the request arrived from somewhere the server has no
    // interface on. The first match wins, in device order, so a run is deterministic.
    const fromSubnet = o.relay && o.relay.giaddr ? o.relay.giaddr : null;
    let chosen = null;
    for (const s of servers) {
      const pickFrom = fromSubnet || s.iface.ip;
      for (const rawPool of s.device.config.dhcpPools) {
        const pool = dhcpLib.normalizePool(rawPool);
        const check = dhcpLib.validatePool(pool);
        if (!check.ok) continue;
        // The question is "is this address inside the pool's subnet", not "could this address be
        // handed out" - the gateway is deliberately not allocatable, and asking ipInPool() would
        // reject every correctly configured router.
        if (net.ipInSubnet(pickFrom, pool.network, pool.mask)) {
          chosen = { server: s, pool: pool };
          break;
        }
      }
      if (chosen) break;
    }

    if (!chosen) {
      return {
        lease: null,
        event: Object.assign({}, base, {
          phase: 'failed', reason: 'no-pool',
          server: servers[0].device.id, serverName: servers[0].device.name,
          detail: 'the address of ' + servers[0].iface.ip + ' is in none of the server pools'
        })
      };
    }

    const serverDev = chosen.server.device;
    if (!this._dhcpStates.has(serverDev.id)) {
      this._dhcpStates.set(serverDev.id, dhcpLib.createLeaseState());
    }
    const state = this._dhcpStates.get(serverDev.id);

    // A renewal skips DISCOVER: the client already knows which address it wants.
    let offer = null;
    if (o.requestedIp) {
      const renewal = dhcpLib.handleRequest(chosen.pool, state, {
        mac: mac, requestedIp: o.requestedIp, step: step
      });
      if (renewal && renewal.type === dhcpLib.DHCP_MESSAGE_TYPES.ACK) {
        const leaseSecRenew = Number(chosen.pool.leaseSec);
        return {
          lease: {
            ip: renewal.ip, mask: chosen.pool.mask,
            gateway: chosen.pool.gateway || null,
            dns: (chosen.pool.dns || []).slice(),
            server: chosen.server.iface.ip, pool: chosen.pool.name,
            leaseSec: leaseSecRenew, expiresStep: renewal.expiresStep,
            giaddr: fromSubnet, relayedVia: o.relay && o.relay.relay ? o.relay.relay.iface.name : null,
            relayDevice: o.relay && o.relay.relay ? o.relay.relay.dev.id : null,
            client: client.id, iface: clientIface.name, mac: mac, renewed: true
          },
          event: Object.assign({}, base, {
            phase: 'renewed', ok: true, ip: renewal.ip, mask: chosen.pool.mask,
            server: serverDev.id, serverName: serverDev.name,
            serverIp: chosen.server.iface.ip, pool: chosen.pool.name,
            gateway: chosen.pool.gateway || null, leaseSec: leaseSecRenew
          })
        };
      }
      // NAK (the server no longer holds that address for this client): start over, like a real host.
    } else {
      offer = dhcpLib.handleDiscover(chosen.pool, state, { mac: mac, step: step });
    }
    if (!offer && !o.requestedIp) {
      return {
        lease: null,
        event: Object.assign({}, base, {
          phase: 'failed', reason: 'pool-exhausted',
          server: serverDev.id, serverName: serverDev.name, pool: chosen.pool.name,
          detail: 'pool ' + chosen.pool.name + ' has no address left to offer'
        })
      };
    }
    if (!offer) {
      offer = dhcpLib.handleDiscover(chosen.pool, state, { mac: mac, step: step });
      if (!offer) {
        return {
          lease: null,
          event: Object.assign({}, base, {
            phase: 'failed', reason: 'pool-exhausted',
            server: serverDev.id, serverName: serverDev.name, pool: chosen.pool.name,
            detail: 'pool ' + chosen.pool.name + ' has no address left to offer'
          })
        };
      }
    }

    const ack = dhcpLib.handleRequest(chosen.pool, state, {
      mac: mac, requestedIp: offer.ip, step: step
    });
    if (!ack || ack.type !== dhcpLib.DHCP_MESSAGE_TYPES.ACK) {
      return {
        lease: null,
        event: Object.assign({}, base, {
          phase: 'failed', reason: 'nak',
          server: serverDev.id, serverName: serverDev.name, pool: chosen.pool.name,
          detail: 'the server refused to acknowledge ' + offer.ip
        })
      };
    }

    // normalizePool() already resolved the lease to seconds; taking it from there keeps the
    // configured value instead of quietly reporting the library default.
    const leaseSec = Number(chosen.pool.leaseSec);
    return {
      lease: {
        ip: ack.ip, mask: chosen.pool.mask,
        gateway: chosen.pool.gateway || null,
        dns: (chosen.pool.dns || []).slice(),
        server: chosen.server.iface.ip, pool: chosen.pool.name,
        // The expiry step is what lets a later question work out whether this lease is still
        // alive; without it the client had no clock and every answer re-stamped the timer.
        leaseSec: leaseSec, expiresStep: ack.expiresStep,
        // A relayed lease remembers where it came from: the client's own address is useless to the
        // server for routing, so giaddr is the only thing that explains how it was handed out.
        giaddr: fromSubnet, relayedVia: o.relay && o.relay.relay ? o.relay.relay.iface.name : null,
        relayDevice: o.relay && o.relay.relay ? o.relay.relay.dev.id : null,
        client: client.id, iface: clientIface.name, mac: mac
      },
      event: Object.assign({}, base, {
        phase: 'ack', ok: true, ip: ack.ip, mask: chosen.pool.mask,
        server: serverDev.id, serverName: serverDev.name,
        serverIp: chosen.server.iface.ip, pool: chosen.pool.name,
        gateway: chosen.pool.gateway || null, leaseSec: leaseSec,
        relayed: !!fromSubnet, giaddr: fromSubnet,
        relayName: o.relay && o.relay.relay ? o.relay.relay.dev.name : null
      })
    };
  }

  // ---------------------------------------------------------------------
  // OSPF route installation
  // ---------------------------------------------------------------------

  // Default OSPF interface cost from the link rate (reference bandwidth 100 Mbps).
  _ospfCost(iface) {
    const s = String(iface && iface.speed || '').toUpperCase();
    if (s === '100M') return 100;
    if (s === '1G') return 10;
    if (s === '2.5G') return 4;
    if (s === '5G') return 2;
    if (s === '10G' || s === '25G' || s === '40G' || s === '100G') return 1;
    return ospfLib.DEFAULT_COST;
  }

  // Run OSPF over the live topology and install the resulting routes on each
  // router as dev.ospfRoutes, which Device.routeTo() consults.
  computeOspf() {
    const routers = [];
    const byId = Object.create(null);

    for (const dev of this.topo.devices.values()) {
      dev.ospfRoutes = [];
      dev.ospfNeighbors = [];
      dev.ospfAreaMismatch = [];
      const cfg = dev.config && dev.config.ospf;
      if (!cfg || !cfg.routerId) continue;

      const ifaces = [];
      for (const i of dev.interfaces.values()) {
        if (!i.enabled || !i.ip || !i.mask) continue;
        let ov = null;
        for (const x of (cfg.interfaces || [])) { if (x.name === i.name) { ov = x; break; } }
        ifaces.push({
          name: i.name,
          ip: i.ip,
          mask: i.mask,
          cost: (ov && ov.cost) || this._ospfCost(i),
          area: (ov && ov.area !== undefined) ? ov.area : (cfg.areaId || 0),
          // A passive interface suppresses hellos, not its prefix: it forms no
          // adjacency but still appears in the router LSA as a stub (#43).
          passive: !!(ov && ov.passive)
        });
      }
      if (!ifaces.length) continue;

      const entry = { id: dev.id, routerId: cfg.routerId, areaId: cfg.areaId || 0, interfaces: ifaces };
      routers.push(entry);
      byId[dev.id] = { dev: dev, entry: entry };
    }

    if (routers.length < 2) { this.ospfResult = null; return null; }

    // Adjacencies: a link between two OSPF speakers that both address it.
    const links = [];
    const areaMismatch = [];
    for (const l of this.topo.links.values()) {
      const a = byId[l.a.deviceId];
      const b = byId[l.b.deviceId];
      if (!a || !b) continue;
      const ai = a.entry.interfaces.filter(function (x) { return x.name === l.a.iface; })[0];
      const bi = b.entry.interfaces.filter(function (x) { return x.name === l.b.iface; })[0];
      if (!ai || !bi) continue;
      if (ai.passive || bi.passive) continue;   // passive: no hello, no adjacency (#43)
      // Both ends of a broadcast link must address the same subnet with the same
      // mask. Without this the adjacency forms on the strength of a cable alone,
      // and the route installed behind it points at a next hop that is on no
      // connected subnet -- so it never resolves and the traffic is black-holed.
      // A misconfigured router is exactly what the subnet check exists to catch (#240).
      if (String(ai.mask) !== String(bi.mask)) continue;
      if (net.networkOf(ai.ip, ai.mask) !== net.networkOf(bi.ip, bi.mask)) continue;
      // An adjacency requires both ends to sit in the same OSPF area - the first rule in RFC 2328,
      // and the one engine/ospf.js's own header states ("a link is usable only when both endpoints
      // sit in the same area"). The area was configurable, displayed, and never compared: two
      // routers in areas 1 and 2 formed a FULL adjacency and exchanged routes. A mismatched link is
      // recorded rather than silently dropped, so `show ip ospf neighbor` can say why.
      if (ai.area !== bi.area) {
        areaMismatch.push({
          a: { dev: a.dev, iface: ai.name, area: ai.area },
          b: { dev: b.dev, iface: bi.name, area: bi.area }
        });
        continue;
      }
      links.push({
        a: { router: l.a.deviceId, iface: l.a.iface },
        b: { router: l.b.deviceId, iface: l.b.iface },
        cost: 10
      });
    }

    // Each side sees the link that was excluded, and why: an operator with a cable in place and no
    // neighbour in the table needs the reason, not an empty table.
    for (const m of areaMismatch) {
      m.a.dev.ospfAreaMismatch.push({
        peer: m.b.dev.name || m.b.dev.id, peerArea: m.b.area, iface: m.a.iface, area: m.a.area
      });
      m.b.dev.ospfAreaMismatch.push({
        peer: m.a.dev.name || m.a.dev.id, peerArea: m.a.area, iface: m.b.iface, area: m.b.area
      });
    }

    const graph = ospfLib.buildGraph(routers, links);
    const result = Object.create(null);

    for (const r of routers) {
      // Directly connected peers, so a next hop can be turned into a real IP.
      const nbr = Object.create(null);
      for (const l of links) {
        // The adjacency's area is the local interface's area, which is what an
        // operator reads in `show ip ospf neighbor` (a per-interface area can
        // differ from the process default).
        const localName = (l.a.router === r.id) ? l.a.iface : l.b.iface;
        const localIf = r.interfaces.filter(function (x) { return x.name === localName; })[0];
        const area = localIf ? localIf.area : (r.areaId || 0);
        if (l.a.router === r.id) {
          const peer = byId[l.b.router].entry.interfaces.filter(function (x) { return x.name === l.b.iface; })[0];
          if (peer) nbr[l.b.router] = { ip: peer.ip, iface: l.a.iface, area: area };
        } else if (l.b.router === r.id) {
          const peer = byId[l.a.router].entry.interfaces.filter(function (x) { return x.name === l.a.iface; })[0];
          if (peer) nbr[l.a.router] = { ip: peer.ip, iface: l.b.iface, area: area };
        }
      }

      const spt = ospfLib.spf(graph, r.id);
      const routes = [];
      const seen = Object.create(null);      // network key -> index into routes
      const advOf = Object.create(null);     // network key -> advertising router id

      // Networks this router is directly connected to are code C already, so no
      // OSPF route is installed for them -- the connected route is the route.
      // This is the rule routesFromSpt() already applies in engine/ospf.js (#42).
      const ownNets = Object.create(null);
      for (const ri of r.interfaces) {
        ownNets[net.intToIp(net.networkOf(ri.ip, ri.mask)) + '/' + ri.mask] = 1;
      }

      for (const [destId, info] of spt.entries()) {
        if (destId === r.id) continue;
        const hopId = (info.path && info.path.length > 1) ? info.path[1] : info.nextHopRouterId;
        const hop = nbr[hopId];
        const dest = byId[destId];
        if (!hop || !dest) continue;         // not reachable over a real adjacency
        for (const di of dest.entry.interfaces) {
          const netAddr = net.intToIp(net.networkOf(di.ip, di.mask));
          const key = netAddr + '/' + di.mask;
          if (ownNets[key]) continue;        // the connected route is the route (#42)
          const cand = {
            dest: netAddr,
            mask: di.mask,
            nextHop: hop.ip,
            iface: hop.iface,
            cost: info.cost,
            learnedFrom: hopId
          };
          // One entry per destination, and the cheapest advertisement wins. The
          // first one used to be kept, so the cost of a network advertised by
          // two routers depended on the order the SPT produced -- effectively on
          // device id order. A genuine tie goes to the lower advertising router
          // id, so the table is deterministic (#44).
          const idx = seen[key];
          if (idx === undefined) {
            seen[key] = routes.length;
            advOf[key] = dest.routerId;
            routes.push(cand);
            continue;
          }
          const prev = routes[idx];
          if (cand.cost < prev.cost ||
            (cand.cost === prev.cost && compareAdvId(dest.routerId, advOf[key]) < 0)) {
            routes[idx] = cand;
            advOf[key] = dest.routerId;
          }
        }
      }

      // Routes land when the adjacency has finished and SPF has run, not with the cable.
      const ospfDev = byId[r.id].dev;
      const converged = this._converged('ospf', ospfDev);
      // Persist the adjacencies the SPF ran over, so `show ip ospf neighbor`
      // reports the same set the routes were built from and cannot invent one:
      // a passive port or a subnet mismatch never reaches `nbr`.
      const neighbors = [];
      for (const nid of Object.keys(nbr)) {
        const peerEntry = byId[nid].entry;
        neighbors.push({
          deviceId: nid,
          name: byId[nid].dev.name || nid,
          routerId: peerEntry.routerId,
          ip: nbr[nid].ip,
          iface: nbr[nid].iface,
          area: nbr[nid].area,
          state: converged ? 'FULL' : 'INIT'
        });
      }
      neighbors.sort(function (a, b) { return String(a.ip).localeCompare(String(b.ip)); });
      ospfDev.ospfNeighbors = neighbors;
      if (converged) {
        ospfDev.ospfRoutes = routes;
      } else {
        ospfDev.ospfRoutes = [];
      }
      result[r.id] = routes;
    }

    this.ospfResult = result;
    return result;
  }

  // ---------------------------------------------------------------------
  // BGP route installation
  // ---------------------------------------------------------------------

  // Build BGP sessions from configuration, run advertisement to convergence,
  // and install the best path per prefix as dev.bgpRoutes.
  //
  // A session only forms when BOTH sides are configured: each must list the
  // other's address as a neighbour with a matching remote-as. That is real BGP
  // behaviour, and it is what makes "half a peering is not a peering" testable.
  // Can `dev` open a TCP connection to `peerIp`? Only the parts of the question that can be
  // answered without walking the path: a route, an egress that is up, and a source address.
  // ACLs on intermediate hops are not consulted yet, so a session this calls reachable may
  // still be dropped in the data path - it is a floor, not a promise.
  _bgpReachable(dev, peerIp) {
    if (!dev) return { ok: false, code: 'E_PEER_NOT_FOUND', reason: 'no device' };
    if (dev.poeUnpowered) {
      return { ok: false, code: 'E_POE', reason: 'no PoE power available - ' + dev.name + ' was not powered' };
    }
    const route = dev.routeTo(peerIp);
    if (!route) return { ok: false, code: 'E_NO_ROUTE_TO_PEER', reason: 'no route to ' + peerIp + ' on ' + dev.name };
    const egress = route.iface ? dev.interfaces.get(route.iface) : dev.egressFor(route.via);
    if (!egress || !egress.enabled) {
      return { ok: false, code: 'E_IFACE_DOWN', reason: 'egress interface for ' + peerIp + ' is down on ' + dev.name };
    }
    if (!egress.ip) {
      return { ok: false, code: 'E_NO_SOURCE_IP', reason: 'no source address on ' + egress.name + ' of ' + dev.name };
    }
    return { ok: true, code: null, reason: null, egress: egress.name, srcIp: egress.ip };
  }

  computeBgp() {
    const speakers = [];

    for (const dev of this.topo.devices.values()) {
      dev.bgpRoutes = [];
      const cfg = dev.config && dev.config.bgp;
      if (!cfg || !cfg.as) continue;

      // Usable addresses - these originate prefixes and can be a session's source. A shut
      // port must not advertise its subnet, so it is excluded here.
      const addrs = [];
      // Configured addresses - these are what a `neighbor` line can sit on, whether or not the
      // port is up. Keeping only the usable list made a shut interface look like an
      // unconfigured one: the neighbour then "was not on a connected subnet" and the session
      // was reported as a configuration error instead of a link that is down.
      const configured = [];
      for (const i of dev.interfaces.values()) {
        if (!i.ip || !i.mask) continue;
        configured.push({ ip: i.ip, mask: i.mask, iface: i.name, up: !!i.enabled });
        if (!i.enabled) continue;
        addrs.push({ ip: i.ip, mask: i.mask, iface: i.name });
      }
      if (!configured.length) continue;

      speakers.push({
        dev: dev,
        as: Number(cfg.as),
        routerId: cfg.routerId || (addrs[0] && addrs[0].ip) || configured[0].ip,
        addrs: addrs,
        configured: configured,
        neighbors: (cfg.neighbors || []).slice(),
        adj: [],
        cands: Object.create(null),   // prefix -> [candidates]
        best: Object.create(null)     // prefix -> current best candidate
      });
    }

    if (speakers.length < 2) { this.bgpResult = null; this.bgpSessions = 0; return null; }

    // --- sessions: both ends must agree, AND the peer must be reachable ---
    //
    // Config agreement is necessary and nowhere near sufficient. Until now this loop simply
    // `continue`d past every mismatch, so a session existed because two configs said so: a
    // peering over a down link, or with a route in one direction only, came up in the lab and
    // would never come up on a bench. Each refusal is now named, and the RFC state machine is
    // actually walked instead of being declared.
    const self = this;
    this.bgpSessionList = [];
    function refuse(a, nb, code, reason, extra) {
      const rec = {
        local: a.dev.name, localAs: a.as, peerIp: nb.address,
        remoteAs: Number(nb.remoteAs) || null,
        state: 'idle', established: false, session: null,
        code: code, reason: reason
      };
      if (extra) Object.assign(rec, extra);
      self.bgpSessionList.push(rec);
      self._emit({
        type: 'bgp-session', dev: a.dev.name, peerIp: nb.address, state: 'idle',
        established: false, code: code, reason: reason,
        summary: 'BGP ' + a.dev.name + ' -> ' + nb.address + ': ' + reason
      });
      return rec;
    }

    for (const a of speakers) {
      for (const nb of a.neighbors) {
        let local = null;
        for (const x of a.configured) {
          if (net.sameSubnet(nb.address, x.ip, x.mask)) { local = x; break; }
        }
        if (!local) {
          // A neighbour address that is not on any configured subnet cannot be opened: BGP
          // rides on TCP, TCP needs a next hop, and there is none.
          refuse(a, nb, 'E_PEER_NOT_ON_SUBNET',
            'neighbour ' + nb.address + ' is not on a connected subnet of ' + a.dev.name);
          continue;
        }
        // The address is configured, the port is down. Say that, rather than blaming the
        // configuration for a cable or an admin shutdown.
        if (local.up === false) {
          refuse(a, nb, 'E_IFACE_DOWN',
            local.iface + ' is administratively down on ' + a.dev.name,
            { localIp: local.ip, diedIn: 'connect' });
          continue;
        }

        let b = null;
        for (const s of speakers) {
          if (s === a) continue;
          for (const y of s.configured) { if (y.ip === nb.address) { b = s; break; } }
          if (b) break;
        }
        if (!b) {
          refuse(a, nb, 'E_PEER_NOT_FOUND',
            'no BGP speaker holds ' + nb.address, { localIp: local.ip });
          continue;
        }
        if (Number(nb.remoteAs) !== b.as) {
          refuse(a, nb, 'E_REMOTE_AS_MISMATCH',
            'remote-as ' + nb.remoteAs + ' but ' + b.dev.name + ' is AS' + b.as,
            { localIp: local.ip, peer: b.dev.name });
          continue;
        }

        let back = null;
        for (const n of b.neighbors) { if (n.address === local.ip) { back = n; break; } }
        if (!back) {
          refuse(a, nb, 'E_PEER_NOT_CONFIGURED',
            b.dev.name + ' has no neighbour ' + local.ip,
            { localIp: local.ip, peer: b.dev.name });
          continue;
        }
        if (Number(back.remoteAs) !== a.as) {
          refuse(a, nb, 'E_REMOTE_AS_MISMATCH',
            b.dev.name + ' expects AS' + back.remoteAs + ' for ' + local.ip + ', we are AS' + a.as,
            { localIp: local.ip, peer: b.dev.name });
          continue;
        }

        // The two-way reachability a TCP session needs. A route out and none back is the
        // half-configured lab that looks fine in a config diff and never comes up.
        const peerEnd = (b.configured || []).filter(function (y) { return y.ip === nb.address; })[0];
        const out = this._bgpReachable(a.dev, nb.address);
        const rev = (peerEnd && peerEnd.up === false)
          ? { ok: false, code: 'E_IFACE_DOWN', reason: peerEnd.iface + ' is down on ' + b.dev.name }
          : this._bgpReachable(b.dev, local.ip);
        const walk = bgpLib.establishSession({
          localAs: a.as, remoteAs: b.as,
          probe: function (step) {
            // TCP is where reachability decides it; OPEN and KEEPALIVE cannot succeed if the
            // socket never opened, so they inherit the verdict rather than inventing one.
            if (step.event === 'manual-start' && out.code === 'E_POE') return out;
            if (step.event === 'tcp-connected') return out.ok ? rev : out;
            return { ok: true };
          }
        });

        if (!walk.established) {
          refuse(a, nb, walk.code, walk.reason || 'session did not establish',
            { localIp: local.ip, peer: b.dev.name, diedIn: walk.diedIn, events: walk.events });
          continue;
        }

        const adj = {
          peer: b,
          peerIp: nb.address,
          localIp: local.ip,
          iface: local.iface,
          type: bgpLib.sessionType(a.as, b.as),
          state: walk.state
        };
        a.adj.push(adj);
        this.bgpSessionList.push({
          local: a.dev.name, localAs: a.as, peer: b.dev.name, peerIp: nb.address,
          remoteAs: b.as, state: 'established', established: true,
          session: adj.type, localIp: local.ip, iface: local.iface,
          code: null, reason: null, events: walk.events
        });
      }
    }

    // The per-neighbour state a technician would read off the box. Installed on the device
    // rather than kept only on the simulator, because `show ip bgp summary` is a question
    // about one router and the CLI should not have to reach into the simulator to answer it.
    for (const s of speakers) {
      // The identifier the box actually elected, not the one a config left blank. Showing
      // 0.0.0.0 in `show ip bgp summary` would be a small lie in a command whose whole job
      // is telling a technician the truth about a session.
      s.dev.bgpRouterId = s.routerId || null;
      s.dev.bgpNeighbors = (this.bgpSessionList || [])
        .filter(function (r) { return r.local === s.dev.name; })
        .map(function (r) {
          return {
            address: r.peerIp, remoteAs: r.remoteAs, session: r.session,
            state: r.state, established: r.established, code: r.code, reason: r.reason
          };
        });
    }

    // One event per established session, so the log shows the peering.
    for (const a of speakers) {
      for (const adj of a.adj) {
        if (a.dev.id > adj.peer.dev.id) continue;
        this._emit({
          type: 'bgp', dev: a.dev.name, peer: adj.peer.dev.name,
          session: adj.type, localAs: a.as, remoteAs: adj.peer.as
        });
      }
    }

    // --- originate every connected prefix ---
    for (const s of speakers) {
      for (const x of s.addrs) {
        const netAddr = net.intToIp(net.networkOf(x.ip, x.mask));
        const key = netAddr + '/' + net.prefixOf(x.mask);
        s.cands[key] = [{
          dest: netAddr, mask: x.mask, asPath: [], origin: bgpLib.BGP_ORIGIN.IGP,
          localPreference: bgpLib.DEFAULT_LOCAL_PREF, med: 0, weight: 0,
          nextHop: null, ad: 0, from: 'local', iface: x.iface
        }];
      }
    }

    function computeBest(s) {
      const out = Object.create(null);
      for (const key of Object.keys(s.cands)) {
        const winner = bgpLib.bestPath(s.cands[key]);
        if (winner) out[key] = winner;
      }
      return out;
    }
    for (const s of speakers) s.best = computeBest(s);

    // --- advertise until the tables stop changing ---
    const MAX_ROUNDS = 12;
    let rounds = 0;
    for (; rounds < MAX_ROUNDS; rounds++) {
      const updates = [];
      for (const a of speakers) {
        for (const adj of a.adj) {
          for (const key of Object.keys(a.best)) {
            const e = a.best[key];
            if (e.from === adj.peer.dev.id) continue;     // never advertise a route back
            // iBGP split horizon: a route learned from an iBGP peer is not
            // re-advertised to another iBGP peer. Inside one AS the next hop is
            // left alone, so a relayed route would also be unreachable; real
            // BGP solves both with a route reflector or a full mesh (#41).
            if (adj.type === 'ibgp' && e.session === 'ibgp') continue;
            const asPath = adj.type === 'ebgp' ? [a.as].concat(e.asPath) : e.asPath.slice();
            if (!bgpLib.pathIsLoopFree(asPath, adj.peer.as)) continue;
            // eBGP rewrites the next hop to this router's address on the session.
            // iBGP carries the original next hop through unchanged; only a
            // locally originated prefix points at this router itself (#41).
            const nextHop = adj.type === 'ebgp' ? adj.localIp : (e.nextHop || adj.localIp);
            updates.push({
              to: adj.peer,
              cand: {
                dest: e.dest, mask: e.mask, asPath: asPath,
                origin: e.origin, localPreference: e.localPreference, med: e.med,
                weight: 0, nextHop: nextHop,
                ad: adj.type === 'ebgp' ? 20 : 200,
                from: a.dev.id, session: adj.type
              }
            });
          }
        }
      }

      let changed = false;
      for (const u of updates) {
        const key = u.cand.dest + '/' + u.cand.mask;
        if (!u.to.cands[key]) { u.to.cands[key] = []; changed = true; }
        const list = u.to.cands[key];
        let idx = -1;
        for (let i = 0; i < list.length; i++) { if (list[i].from === u.cand.from) { idx = i; break; } }
        if (idx === -1) { list.push(u.cand); changed = true; }
        else if (bgpLib.comparePaths(u.cand, list[idx]) < 0) { list[idx] = u.cand; changed = true; }
      }
      if (!changed) break;
      for (const s of speakers) s.best = computeBest(s);
    }

    // --- install ---
    const result = Object.create(null);
    let sessions = 0;
    for (const s of speakers) {
      sessions += s.adj.length;
      const routes = [];
      for (const key of Object.keys(s.best)) {
        const e = s.best[key];
        if (e.from === 'local') continue;               // connected already covers it
        if (!e.nextHop) continue;
        let iface = null;
        for (const x of s.addrs) {
          if (net.sameSubnet(e.nextHop, x.ip, x.mask)) { iface = x.iface; break; }
        }
        routes.push({
          dest: e.dest, mask: e.mask, nextHop: e.nextHop, iface: iface,
          ad: e.ad, asPath: e.asPath.slice(),
          peerAs: e.asPath.length ? e.asPath[0] : null,
          session: e.session
        });
      }
      s.dev.bgpRoutes = routes;
      result[s.dev.id] = routes;
    }

    this.bgpResult = result;
    this.bgpSessions = Math.floor(sessions / 2);   // sessions were counted once per direction
    this.bgpRounds = rounds;
    return result;
  }

  // ---------------------------------------------------------------------
  // IPv6: neighbour discovery and ICMPv6 echo
  // ---------------------------------------------------------------------

  // Solicited-node multicast MAC: 33:33:ff followed by the low 24 bits of the
  // target address. This is what a real host sends an NS to.
  _snmMac(ip6) {
    const b = ipv6Lib.ipv6ToBigInt(ip6);
    if (b === null) return null;
    const hex = (b & 0xFFFFFFn).toString(16).padStart(6, '0');
    return '33:33:ff:' + hex.slice(0, 2) + ':' + hex.slice(2, 4) + ':' + hex.slice(4, 6);
  }

  _ndTable(dev) {
    if (!dev.nd) dev.nd = new Map();
    return dev.nd;
  }

  // The address a device sources packets from on a given interface.
  _srcAddr6(dev, iface) {
    for (const e of dev.ip6Addrs()) {
      if (e.name === iface.name) return e.addr;
    }
    return dev.linkLocal6(iface);
  }

  // Send an IPv6 packet, resolving the next hop with neighbour discovery.
  _sendL3v6(dev, egress, nextHop6, ip6, icmp6, vid) {
    const v = (vid === undefined || vid === null) ? portPvid(egress) : vid;
    const mac = this._ndTable(dev).get(nextHop6);
    if (mac) {
      this._emit({ type: 'forward', dev: dev.id, iface: egress.name, nextHop: nextHop6, mac: mac, via: 'nd-cache', vlan: v });
      this._emitFrame(dev, egress, ethFrame(mac, egress.mac, net.ETH_IPV6, ip6, icmp6, null), v);
      return;
    }
    const snm = this._snmMac(nextHop6);
    this._emit({ type: 'nd-request', dev: dev.id, iface: egress.name, target: nextHop6, mac: snm, vlan: v });
    this._emitFrame(dev, egress, {
      dstMac: snm,
      srcMac: egress.mac,
      etherType: net.ETH_ND,
      nd: { type: 'ns', target: nextHop6, srcIp6: this._srcAddr6(dev, egress) }
    }, v);

    if (!dev.pending6) dev.pending6 = new Map();
    let list = dev.pending6.get(nextHop6);
    if (!list) { list = []; dev.pending6.set(nextHop6, list); }
    list.push({ egress: egress.name, ip: ip6, icmp: icmp6, vid: v });
  }

  _sendIcmp6(src, dstIp6, icmp6) {
    let route = src.route6To(dstIp6);
    // A link-local destination has no prefix in the routing table; it is
    // reachable on whichever interface owns a link-local address.
    if (!route && ipv6Lib.isLinkLocal(dstIp6)) {
      const ifaces = src.activeInterfaces();
      if (ifaces.length) {
        route = { iface: ifaces[0].name, via: dstIp6, type: 'link-local', prefix: 64 };
      }
    }
    if (!route) {
      this._emit({ type: 'drop', reason: 'no IPv6 route to ' + dstIp6, dev: src.id });
      return;
    }
    const egress = route.iface ? src.interfaces.get(route.iface) : src.egressFor6(route.via);
    if (!egress || !egress.enabled) {
      this._emit({ type: 'drop', reason: 'IPv6 egress interface down', dev: src.id });
      return;
    }
    const ip6 = {
      src: this._srcAddr6(src, egress), dst: dstIp6,
      hopLimit: 64, nextHeader: 58, id: icmp6.id
    };
    this._sendL3v6(src, egress, route.via, ip6, icmp6, portPvid(egress));
  }

  _handleNd(dev, frame, inIface) {
    const nd = frame.nd;
    const vid = frame.vid || 1;

    // Router solicitation and advertisement are neighbour-discovery messages
    // too (RFC 4861 §4), and they are the ones that hand out addresses.
    if (nd.type === 'rs') { this._handleRs(dev, frame, inIface); return; }
    if (nd.type === 'ra') { this._handleRa(dev, frame, inIface); return; }

    if (nd.type === 'ns') {
      const iface = dev.interfaceWithIp6(nd.target);
      if (!iface) return;                       // not our address: stay silent
      this._ndTable(dev).set(nd.srcIp6, frame.srcMac);
      this._emit({ type: 'nd-advert', dev: dev.id, iface: iface.name, target: nd.target, mac: iface.mac, vlan: vid });
      this._emitFrame(dev, iface, {
        dstMac: frame.srcMac,
        srcMac: iface.mac,
        etherType: net.ETH_ND,
        nd: { type: 'na', target: nd.target, targetMac: iface.mac, srcIp6: this._srcAddr6(dev, iface) }
      }, vid);
      return;
    }

    if (nd.type === 'na') {
      this._ndTable(dev).set(nd.target, nd.targetMac);
      this._emit({ type: 'nd-cache', dev: dev.id, addr: nd.target, mac: nd.targetMac, vlan: vid });
      const list = (dev.pending6 && dev.pending6.get(nd.target)) || [];
      if (dev.pending6) dev.pending6.delete(nd.target);
      for (const item of list) {
        const egress = dev.interfaces.get(item.egress);
        if (!egress) continue;
        this._emit({ type: 'forward', dev: dev.id, iface: egress.name, nextHop: nd.target, mac: nd.targetMac, via: 'nd-resolved', vlan: item.vid });
        this._emitFrame(dev, egress, ethFrame(nd.targetMac, egress.mac, net.ETH_IPV6, item.ip, item.icmp, null), item.vid);
      }
    }
  }

  // ---------------------------------------------------------------------
  // IPv6 stateless address autoconfiguration (SLAAC)
  //
  // A host that has been told 'ipv6 address autoconfig' has no address at all
  // until a router gives it one. That is the point of the feature: the address
  // must come off the wire, not out of the configuration, or the lab proves
  // nothing about how IPv6 is deployed.
  // ---------------------------------------------------------------------

  // One exchange: routers advertise, hosts that are waiting solicit, routers
  // answer. A real network repeats the unsolicited advertisement every few
  // minutes and a host solicits at boot; one pass at the start of a run is
  // enough here, and it has to happen before the first packet, otherwise the
  // host would be asked to send from an address it does not have yet.
  announceRa() {
    for (const dev of this.topo.devices.values()) {
      // A device that cannot forward has no prefix to give away; skip it before
      // even looking at the configuration.
      if (!dev.isL3()) continue;
      const cfg = raLib.normalizeConfig(dev.config.ra);
      if (!cfg.enabled) continue;
      for (const iface of dev.activeInterfaces()) {
        if (iface.parent) continue;              // subinterfaces are not ports
        if (!iface.peer) continue;               // nothing plugged in: nobody to tell
        this._sendRa(dev, iface, { solicited: false });
      }
    }

    // Then the hosts that are still waiting ask, which is what puts a
    // solicitation on the timeline instead of making the address appear by magic.
    for (const dev of this.topo.devices.values()) {
      for (const iface of dev.activeInterfaces()) {
        if (iface.parent || !iface.peer || !iface.autoconfig) continue;
        this._sendRs(dev, iface);
      }
    }

    this._run();
    return this;
  }

  // Router solicitation to all routers (ff02::2). Sent from the link-local
  // address, because until the router answers that is the only address this
  // interface has.
  _sendRs(dev, iface, opts) {
    const o = opts || {};
    const vid = (o.vid === undefined || o.vid === null) ? portPvid(iface) : o.vid;
    const msg = raLib.buildRs({ srcMac: iface.mac });
    this._emit({
      type: 'rs-send', dev: dev.id, iface: iface.name,
      dst: raLib.ALL_ROUTERS, mac: raLib.ALL_ROUTERS_MAC,
      from: dev.linkLocal6(iface), vlan: vid
    });
    this._emitFrame(dev, iface, {
      dstMac: raLib.ALL_ROUTERS_MAC,
      srcMac: iface.mac,
      etherType: net.ETH_ND,
      nd: { type: 'rs', srcIp6: dev.linkLocal6(iface), rs: msg }
    }, vid);
    return 1;
  }

  // Router advertisement to all nodes (ff02::1).
  _sendRa(dev, iface, opts) {
    const o = opts || {};
    // A prefix is a promise to route the traffic addressed inside it. A bridge
    // that advertises one is lying: the hosts would send it packets it can only
    // flood. The CLI refuses to configure it too, but config files and imported
    // labs exist, so the forwarding path is the line that matters.
    if (!dev.hasCap('l3-forward')) return 0;

    const cfg = raLib.normalizeConfig(dev.config.ra);
    if (!cfg.enabled) return 0;
    // suppress-ra silences the periodic advertisement, not the router: a host
    // that asks still gets an answer, which is exactly what the command means on
    // real gear. A router that never answers is a router with RAs switched off.
    if (cfg.suppress && o.solicited !== true) return 0;

    // A router advertises a prefix on the link it is attached to, not on every
    // port it happens to own. Sending the aa::/64 down the bb link would hand
    // every host on that wire an address on the wrong subnet - the kind of
    // silent mistake that looks like "IPv6 does not work" for an hour.
    const onLink = [];
    for (const p of cfg.prefixes) {
      if (this._prefixOnIface(dev, iface, p)) onLink.push(p);
    }

    const msg = raLib.buildRa({
      m: cfg.m, o: cfg.o,
      curHopLimit: cfg.curHopLimit,
      routerLifetime: cfg.routerLifetime,
      reachableTime: cfg.reachableTime,
      retransTimer: cfg.retransTimer,
      prefixes: onLink,
      srcMac: iface.mac
    });

    const vid = (o.vid === undefined || o.vid === null) ? portPvid(iface) : o.vid;
    this._emit({
      type: 'ra-send', dev: dev.id, iface: iface.name,
      dst: raLib.ALL_NODES, mac: raLib.ALL_NODES_MAC,
      from: dev.linkLocal6(iface),
      m: msg.m, o: msg.o, routerLifetime: msg.routerLifetime,
      prefixes: msg.prefixes.map(function (p) { return p.prefix + '/' + p.prefixLen; }),
      solicited: o.solicited === true,
      vlan: vid
    });
    this._emitFrame(dev, iface, {
      dstMac: raLib.ALL_NODES_MAC,
      srcMac: iface.mac,
      etherType: net.ETH_ND,
      nd: { type: 'ra', srcIp6: dev.linkLocal6(iface), ra: msg }
    }, vid);
    return 1;
  }

  // Does this interface hold an address inside the prefix? A router only has a
  // right to advertise a prefix it is actually attached to.
  _prefixOnIface(dev, iface, pio) {
    for (const e of dev.ip6Addrs()) {
      if (e.name !== iface.name) continue;
      if (ipv6Lib.prefixContains6(pio.prefix + '/' + pio.prefixLen, e.addr)) return true;
    }
    return false;
  }

  _handleRs(dev, frame, inIface) {
    if (!dev.hasCap('l3-forward')) return;       // nothing to advertise, and no right to
    const cfg = raLib.normalizeConfig(dev.config.ra);
    if (!cfg.enabled) return;
    const iface = dev.resolveIface(inIface);
    if (!iface) return;
    this._emit({
      type: 'rs-recv', dev: dev.id, iface: iface.name,
      from: (frame.nd && frame.nd.srcIp6) || null, mac: frame.srcMac,
      vlan: frame.vid || 1
    });
    // The answer leaves the interface the question arrived on: a router with
    // eight ports has eight different links and only one of them asked.
    this._sendRa(dev, iface, { solicited: true, vid: frame.vid || null });
  }

  _handleRa(dev, frame, inIface) {
    const iface = dev.resolveIface(inIface);
    if (!iface) return;
    // Only an interface that was told to autoconfigure reacts. A host given an
    // address by hand must not have it rewritten by a router it never asked,
    // and a switch that terminates the flooded all-nodes frame has no use for it.
    if (!iface.autoconfig) return;

    // Decode the wire encoding instead of reading the sender's object: what
    // arrives is ICMPv6 type 134 octets, and a mistake in that layout is
    // supposed to be visible here rather than hidden behind a shared structure.
    const decoded = raLib.parseRa(raLib.encodeRa(frame.nd.ra));
    if (!decoded.valid) {
      this._emit({
        type: 'drop', dev: dev.id, iface: iface.name,
        reason: 'malformed router advertisement: ' + decoded.error.message
      });
      return;
    }
    const ra = decoded.ra;
    const vid = frame.vid || 1;
    const router = (frame.nd && frame.nd.srcIp6) || null;

    this._emit({
      type: 'ra-recv', dev: dev.id, iface: iface.name, from: router, mac: frame.srcMac,
      m: ra.m, o: ra.o, routerLifetime: ra.routerLifetime,
      prefixes: ra.prefixes.map(function (p) { return p.prefix + '/' + p.prefixLen; }),
      vlan: vid
    });

    // RFC 4861 §6.3.4: the source link-layer address option seeds the neighbour
    // cache, so the first packet to the router needs no solicitation of its own.
    if (router) this._ndTable(dev).set(router, frame.srcMac);

    if (ra.m) {
      // M=1 means "this network hands out addresses with DHCPv6". A host that
      // autoconfigured anyway would hold an address the network does not manage,
      // so refusing is the correct behaviour - and it is reported, because a
      // host that silently stays unaddressed is a lab bug that takes an hour to
      // find.
      this._emit({
        type: 'slaac-refused', dev: dev.id, iface: iface.name, from: router, flag: 'm',
        reason: 'router set the M (managed) flag: addresses on this network come from DHCPv6, so stateless autoconfiguration must not run'
      });
      return;
    }

    const existing = (dev.config.ip6 || {})[iface.name];
    if (existing && !existing.autoconfig) {
      this._emit({
        type: 'slaac-refused', dev: dev.id, iface: iface.name, from: router, flag: 'manual',
        reason: 'interface already carries the manually configured address ' + existing.addr +
          '; autoconfiguration will not overwrite it'
      });
      return;
    }

    const installed = [];
    for (const pio of ra.prefixes) {
      // A=0 means on-link only: the prefix tells the host who is reachable
      // directly, but it must not invent an address inside it.
      if (!raLib.canAutoconfigure(pio)) continue;
      // One global address per interface in this model. A real host would keep one
      // address per advertised prefix; taking the first autonomous prefix is
      // honest about the limit instead of letting the last option win by accident.
      if (installed.length) break;
      const addr = raLib.deriveAddress(pio.prefix, pio.prefixLen, iface.mac);
      if (!addr) continue;

      dev.config.ip6[iface.name] = {
        addr: addr, prefix: pio.prefixLen, autoconfig: true,
        validLifetime: pio.validLifetime, preferredLifetime: pio.preferredLifetime,
        from: router
      };
      installed.push(addr);
      this._emit({
        type: 'slaac-address', dev: dev.id, iface: iface.name, addr: addr,
        prefix: pio.prefixLen, prefixSource: pio.prefix + '/' + pio.prefixLen,
        router: router, validLifetime: pio.validLifetime,
        preferredLifetime: pio.preferredLifetime, vlan: vid
      });
    }

    // Router lifetime 0 means "do not use me as a default router" - a router
    // being drained says exactly that, and honouring it is the difference
    // between a graceful shutdown and a black hole.
    if (ra.routerLifetime > 0 && router) {
      dev.config.gateway6 = router;
      // fe80:: is on-link on every interface, so a link-local next hop only
      // means something together with the port it was heard on. Without this
      // the default route exists but has no egress to send by.
      dev.config.gateway6Iface = iface.name;
    }
    return installed;
  }

  _handleLocalIp6(dev, frame, inIface) {
    const icmp = frame.icmp;
    if (!icmp) return;
    const vid = frame.vid || 1;

    if (icmp.type === ipv6Lib.ICMPV6_TYPES.ECHO_REQUEST) {
      const iface = dev.interfaceWithIp6(frame.ip.dst);
      if (!iface) {
        this._emit({ type: 'drop', reason: 'echo for unknown local IPv6', dev: dev.id });
        return;
      }
      this._emit({ type: 'icmp6-echo', dev: dev.id, iface: iface.name, from: frame.ip.src, seq: icmp.seq, vlan: vid });
      const replyIp = { src: frame.ip.dst, dst: frame.ip.src, hopLimit: 64, nextHeader: 58, id: icmp.id };
      const replyIcmp = { type: ipv6Lib.ICMPV6_TYPES.ECHO_REPLY, code: 0, id: icmp.id, seq: icmp.seq };
      this._emit({ type: 'icmp6-reply', dev: dev.id, iface: iface.name, to: frame.ip.src, seq: icmp.seq, vlan: vid });
      this._emitFrame(dev, iface, ethFrame(frame.srcMac, iface.mac, net.ETH_IPV6, replyIp, replyIcmp, null), vid);
    } else if (icmp.type === ipv6Lib.ICMPV6_TYPES.ECHO_REPLY) {
      this.icmp6Replies.push({ dst: dev.id, id: icmp.id, seq: icmp.seq, step: this.step });
      this._emit({ type: 'icmp6-received', dev: dev.id, from: frame.ip.src, seq: icmp.seq, vlan: vid });
    }
  }

  _forwardL3v6(dev, frame, inIface) {
    frame.ip.hopLimit -= 1;
    if (frame.ip.hopLimit <= 0) {
      this._emit({ type: 'drop', reason: 'hop limit exceeded', dev: dev.id });
      return;
    }
    // `no ipv6 unicast-routing` is a real switch, not a decoration: a box with it off does not
    // forward an IPv6 packet that is not addressed to it, however good its routing table looks.
    // Without this the command would be accepted and change nothing, which is the shape of lie this
    // console keeps finding - and "the route is there but nothing forwards" is exactly the question
    // `show ipv6 route` cannot answer on its own.
    if (dev.config && dev.config.ip6Routing === false) {
      this._emit({ type: 'drop', reason: 'IPv6 unicast routing is disabled', dev: dev.id });
      return;
    }
    const route = dev.route6To(frame.ip.dst);
    if (!route) {
      this._emit({ type: 'drop', reason: 'no IPv6 route to ' + frame.ip.dst, dev: dev.id });
      return;
    }
    const egress = route.iface ? dev.interfaces.get(route.iface) : dev.egressFor6(route.via);
    if (!egress || !egress.enabled) {
      this._emit({ type: 'drop', reason: 'no usable IPv6 egress interface', dev: dev.id });
      return;
    }
    this._emit({ type: 'route6', dev: dev.id, dst: frame.ip.dst, via: route.via, iface: egress.name, hopLimit: frame.ip.hopLimit });
    const newIp = {
      src: frame.ip.src, dst: frame.ip.dst,
      hopLimit: frame.ip.hopLimit, nextHeader: 58, id: frame.ip.id
    };
    this._sendL3v6(dev, egress, route.via, newIp, frame.icmp, portPvid(egress));
  }

  // --- public: IPv6 ping ---
  ping6(srcId, dstIp6, opts) {
    opts = opts || {};
    const count = opts.count || 4;
    this.reset();
    this.computeStp();
    this.computePoe();
    // SLAAC first: a host with 'ipv6 address autoconfig' and no router answer
    // would otherwise be asked to send from an address it has never had.
    this.announceRa();
    this.computeOspf();
    this.computeBgp();

    const src = this.topo.getDevice(srcId);
    if (!src) throw new Error('Unknown device: ' + srcId);

    const id = this._icmpId++;
    const replies = [];
    const bits = latencyLib.pingFrameBits(opts.payloadSize);
    for (let seq = 0; seq < count; seq++) {
      const startStep = this.step;
      const evStart = this.events.length;
      this._emit({ type: 'ping6', src: srcId, dst: dstIp6, seq: seq });
      this._sendIcmp6(src, dstIp6, {
        type: ipv6Lib.ICMPV6_TYPES.ECHO_REQUEST, code: 0, id: id, seq: seq
      });
      this._run();
      const got = this.icmp6Replies.filter(function (r) {
        return r.dst === srcId && r.id === id && r.seq === seq;
      })[0];
      // Same delay model as IPv4: an echo reply over IPv6 crosses the same
      // physical links, and 40 km of glass does not care which header is on the
      // frame. Only the ICMP version differs.
      const delay = got
        ? this._roundTripFor(this.events.slice(evStart), ipv6Lib.ICMPV6_TYPES.ECHO_REQUEST,
          ipv6Lib.ICMPV6_TYPES.ECHO_REPLY, id, seq, bits)
        : null;
      replies.push({
        seq: seq,
        success: !!got,
        hops: got ? (got.step - startStep) : null,
        rtt: delay ? delay.totalMs : null,
        rttUs: delay ? delay.totalUs : null,
        lengthKnown: delay ? delay.lengthKnown : null,
        delay: delay
      });
    }
    return {
      events: this.events, replies: replies, step: this.step,
      success: replies.some(function (r) { return r.success; })
    };
  }

  // ---------------------------------------------------------------------
  // SCION: path-aware networking over the AS topology
  // ---------------------------------------------------------------------

  // Devices that belong to an ISD-AS, sorted by canonical id.
  scionMembers() {
    const out = [];
    for (const dev of this.topo.devices.values()) {
      const raw = dev.config.scionAs;
      if (!raw) continue;
      const p = scionLib.parseIsdAs(raw);
      if (!p.valid) continue;
      out.push({ dev: dev, id: scionLib.formatIsdAs(p.isd, p.asHex) });
    }
    out.sort(function (a, b) { return a.id < b.id ? -1 : (a.id > b.id ? 1 : 0); });
    return out;
  }

  _scionDevice(asId) {
    for (const m of this.scionMembers()) {
      if (m.id === asId) return m.dev;
    }
    return null;
  }

  _resolveScionAs(dst) {
    if (!dst) return null;
    const dev = this.topo.getDevice(dst);
    if (dev && dev.config.scionAs) return dev.config.scionAs;
    const p = scionLib.parseIsdAs(dst);
    if (p.valid) return scionLib.formatIsdAs(p.isd, p.asHex);
    return String(dst);
  }

  _linkBetween(aId, bId) {
    for (const l of this.topo.links.values()) {
      if ((l.a.deviceId === aId && l.b.deviceId === bId) ||
          (l.a.deviceId === bId && l.b.deviceId === aId)) return l;
    }
    return null;
  }

  // The link plugged into a specific port, if any.
  _linkOnPort(deviceId, ifaceName) {
    for (const l of this.topo.links.values()) {
      if (l.a.deviceId === deviceId && l.a.iface === ifaceName) return l;
      if (l.b.deviceId === deviceId && l.b.iface === ifaceName) return l;
    }
    return null;
  }

  // ---------------------------------------------------------------------
  // PoE power budgeting
  // ---------------------------------------------------------------------
  // A PSE has a finite budget. Powered devices are served in port order until
  // the budget runs out; the ones that miss out never power up, which is what
  // a real switch does rather than silently over-subscribing.
  // Populate the neighbour tables without running a simulation. Used when the
  // topology changes (a cable is added or removed) so the UI can show what is on the
  // other end straight away, instead of leaving the tables empty until something is
  // pinged.
  refreshNeighbours() {
    this.computePoe();
    this.announceLldp();
    // The same argument applies to IPv6: a host that was just plugged into a
    // router advertising a prefix should have an address before anyone asks it
    // a question, not only after the next ping.
    this.announceRa();
    this._run();
    return this;
  }

  // Send an LLDPDU out of every active, cabled port. Real devices do this on a
  // timer; here it runs at the start of a simulation so the neighbour tables are
  // populated before anyone asks a question about them.
  announceLldp() {
    for (const dev of this.topo.devices.values()) {
      if (!dev.lldp) continue;
      // `no lldp run` is the device not speaking at all; `no lldp transmit` is one port not
      // speaking. Both were unreachable from the console, so a neighbour table could only ever
      // fill - and the only way to empty it was to unplug the cable.
      if (dev.config && dev.config.lldp && dev.config.lldp.run === false) continue;
      for (const iface of dev.activeInterfaces()) {
        if (!iface.peer) continue;                 // nothing plugged in
        if (iface.parent) continue;                // subinterfaces are not ports
        if (iface.lldpTx === false) continue;      // `no lldp transmit` on this port
        try {
          this._emitFrame(dev, iface, lldp.buildFrame(dev, iface));
        } catch (e) {
          // A port that cannot transmit right now simply does not announce.
        }
      }
    }
  }

  computePoe() {
    this.poe = [];

    for (const dev of this.topo.devices.values()) dev.poeUnpowered = false;

    for (const dev of this.topo.devices.values()) {
      if (!dev.poeBudget) continue;

      let remaining = dev.poeBudget;
      const ports = [];
      const names = dev.activeInterfaces()
        .filter(function (i) { return i.poeOut; })
        .map(function (i) { return i.name; })
        .sort();

      for (const name of names) {
        const link = this._linkOnPort(dev.id, name);
        if (!link) continue;
        const other = (link.a.deviceId === dev.id)
          ? { id: link.b.deviceId, iface: link.b.iface }
          : { id: link.a.deviceId, iface: link.a.iface };
        const peer = this.topo.getDevice(other.id);
        const peerIface = peer && peer.interfaces.get(other.iface);
        if (!peerIface || !peerIface.poeIn) continue;   // not a powered device

        const draw = peerIface.poeIn;
        // `power inline never` is the administrator withholding power from this port. It is checked
        // before the budget because it is a decision, not a shortage: the port is refused and its
        // watts stay available to the ports that do want them.
        const ifaceRec = dev.interfaces.get(name);
        const admin = (ifaceRec && ifaceRec.poeAdmin) || 'auto';
        if (admin === 'never') {
          ports.push({ iface: name, pd: other.id, draw: draw, powered: false, admin: 'never' });
          peer.poeUnpowered = true;
          this._emit({
            type: 'poe-admin-off', dev: dev.id, iface: name, pd: other.id, draw: draw,
            reason: 'power inline never on ' + name + ': the port is administratively without power'
          });
          continue;
        }
        if (remaining >= draw) {
          remaining -= draw;
          ports.push({ iface: name, pd: other.id, draw: draw, powered: true, admin: admin });
        } else {
          ports.push({ iface: name, pd: other.id, draw: draw, powered: false, admin: admin });
          peer.poeUnpowered = true;
          this._emit({
            // Not `poe-deny`: this is the budget being computed, not a frame being refused. The
            // frame-level refusals keep that name (and are counted as drops on the port).
            type: 'poe-budget', dev: dev.id, iface: name, pd: other.id,
            draw: draw, remaining: remaining,
            reason: 'PSE budget exhausted: ' + draw + ' W requested, ' + remaining + ' W left'
          });
        }
      }

      this.poe.push({
        dev: dev.id,
        budget: dev.poeBudget,
        used: dev.poeBudget - remaining,
        ports: ports
      });
    }

    return this.poe;
  }

  // Core-to-core segments: chains across adjacent core ASes.
  _scionCoreSegments(cores, neighbours) {
    const adj = new Map();
    for (const c of cores) adj.set(c, []);
    for (const pair of neighbours) {
      if (scionLib.isCore(pair[0]) && scionLib.isCore(pair[1])) {
        adj.get(pair[0]).push(pair[1]);
        adj.get(pair[1]).push(pair[0]);
      }
    }
    const out = [];
    for (const from of cores) {
      const parent = new Map();
      const seen = new Set([from]);
      let frontier = [from];
      while (frontier.length) {
        const next = [];
        for (const node of frontier) {
          for (const nb of (adj.get(node) || [])) {
            if (seen.has(nb)) continue;
            seen.add(nb);
            parent.set(nb, node);
            next.push(nb);
          }
        }
        frontier = next;
      }
      for (const to of cores) {
        if (to === from || !seen.has(to)) continue;
        const chain = [to];
        let cur = to;
        while (parent.has(cur)) { cur = parent.get(cur); chain.push(cur); }
        chain.reverse();
        out.push({ type: scionLib.PATH_TYPES.CORE, from: from, to: to, hops: chain });
      }
    }
    return out;
  }

  // Run beaconing over the real peering graph and keep the segment set.
  computeScion() {
    const members = this.scionMembers();

    // AS adjacency is the physical topology: a link between two SCION-enabled
    // devices is a peering between their ASes.
    const neighbours = [];
    for (const link of this.topo.links.values()) {
      const a = this.topo.getDevice(link.a.deviceId);
      const b = this.topo.getDevice(link.b.deviceId);
      if (!a || !b || !a.config.scionAs || !b.config.scionAs) continue;
      const pa = scionLib.parseIsdAs(a.config.scionAs);
      const pb = scionLib.parseIsdAs(b.config.scionAs);
      if (!pa.valid || !pb.valid) continue;
      const ia = scionLib.formatIsdAs(pa.isd, pa.asHex);
      const ib = scionLib.formatIsdAs(pb.isd, pb.asHex);
      if (ia === ib) continue;               // same AS: internal, not a peering
      neighbours.push([ia, ib]);
    }

    const cores = members.filter(function (m) { return scionLib.isCore(m.id); })
      .map(function (m) { return m.id; });

    const segments = scionLib.beaconing(cores, neighbours).map(function (s) {
      return scionLib.createSegment(s);
    });
    const coreSegments = this._scionCoreSegments(cores, neighbours);
    for (const c of coreSegments) segments.push(scionLib.createSegment(c));

    this.scion = {
      members: members,
      cores: cores,
      neighbours: neighbours,
      segments: segments,
      coreSegments: coreSegments
    };
    return this.scion;
  }

  // Every path the beaconed segments can compose between two ASes.
  scionPaths(srcAs, dstAs) {
    const S = this.computeScion();
    const paths = [];
    const failures = [];
    const add = function (segs) {
      const p = scionLib.buildPath(segs);
      if (p.valid) paths.push(p); else failures.push(p);
    };

    const UP = scionLib.PATH_TYPES.UP;
    const DOWN = scionLib.PATH_TYPES.DOWN;
    const ups = S.segments.filter(function (s) { return s.type === UP && s.from === srcAs; });
    const downs = S.segments.filter(function (s) { return s.type === DOWN && s.to === dstAs; });
    const cores = S.coreSegments;

    // non-core -> core -> non-core, with or without a core segment in between
    for (const a of ups) {
      for (const d of downs) {
        if (a.to === d.from) add([a, d]);
        else for (const c of cores) if (c.from === a.to && c.to === d.from) add([a, c, d]);
      }
    }
    // core source
    if (scionLib.isCore(srcAs)) {
      for (const d of downs) {
        if (d.from === srcAs) add([d]);
        else for (const c of cores) if (c.from === srcAs && c.to === d.from) add([c, d]);
      }
    }
    // core destination
    if (scionLib.isCore(dstAs)) {
      for (const a of ups) if (a.to === dstAs) add([a]);
      if (scionLib.isCore(srcAs)) {
        for (const c of cores) if (c.from === srcAs && c.to === dstAs) add([c]);
      }
    }
    return { paths: paths, failures: failures, scion: S };
  }

  selectScionPath(srcAs, dstAs, policy) {
    const r = this.scionPaths(srcAs, dstAs);
    return {
      path: scionLib.selectPath(r.paths, policy),
      candidates: r.paths,
      failures: r.failures,
      scion: r.scion
    };
  }

  // Source-routed SCION packet: the path is carried in the packet, and each
  // hop is an AS. Nothing here consults the IP routing table.
  pingScion(srcId, dst, opts) {
    opts = opts || {};
    this.reset();
    this.computePoe();
    this.computeScion();

    const src = this.topo.getDevice(srcId);
    if (!src) throw new Error('Unknown device: ' + srcId);
    if (!src.config.scionAs) throw new Error(src.name + ' is not a SCION AS');

    const srcAs = src.config.scionAs;
    const dstAs = this._resolveScionAs(dst);
    const sel = this.selectScionPath(srcAs, dstAs, opts.policy);
    const result = {
      srcAs: srcAs, dstAs: dstAs,
      candidates: sel.candidates.length,
      path: sel.path || null
    };

    if (!sel.path) {
      let why = 'no beaconed path reaches ' + dstAs;
      if (sel.failures.length) why = sel.failures[0].error.message + ' [' + sel.failures[0].error.code + ']';
      this._emit({ type: 'scion-drop', src: srcAs, dst: dstAs, reason: why });
      result.success = false;
      result.reason = why;
      result.events = this.events;
      result.step = this.step;
      return result;
    }

    const hops = scionLib.pathHops(sel.path);
    this._emit({
      type: 'scion-path', src: srcAs, dst: dstAs, hops: hops,
      shape: sel.path.segments.map(function (s) { return s.type; }).join('|'),
      latencyMs: scionLib.pathLatency(sel.path)
    });

    let prev = null;
    for (const hop of hops) {
      const dev = this._scionDevice(hop);
      if (!dev) {
        const why = 'no device in the topology belongs to AS ' + hop;
        this._emit({ type: 'scion-drop', src: srcAs, dst: dstAs, reason: why });
        result.success = false; result.reason = why;
        result.events = this.events; result.step = this.step;
        return result;
      }
      if (prev) {
        const link = this._linkBetween(prev.id, dev.id);
        if (!link) {
          const why = 'no physical interconnect between ' + prev.name + ' and ' + dev.name;
          this._emit({ type: 'scion-drop', src: srcAs, dst: dstAs, reason: why });
          result.success = false; result.reason = why;
          result.events = this.events; result.step = this.step;
          return result;
        }
        this._emit({ type: 'scion-hop', from: prev.name, to: dev.name, as: hop, link: link.id });
      } else {
        this._emit({ type: 'scion-hop', from: null, to: dev.name, as: hop, link: null });
      }
      prev = dev;
    }

    this._emit({ type: 'scion-delivered', src: srcAs, dst: dstAs, at: prev ? prev.name : null });
    result.success = true;
    result.hops = hops;
    result.latencyMs = scionLib.pathLatency(sel.path);
    result.events = this.events;
    result.step = this.step;
    return result;
  }

  _isBlocked(dev, ifaceName) {
    return !!(dev.stp && dev.stp.blocked && dev.stp.blocked.has(ifaceName));
  }

  // Evaluate an access list bound to (iface, direction) against a frame.
  // ACLs are IP filters: ARP and other non-IP traffic pass untouched.
  // A transport flow is where extended ACLs earn their keep: `deny tcp any host
  // 10.0.0.5 eq 80` can only ever match a packet that carries a protocol and a
  // port, so the check reads them off the frame instead of calling every packet
  // "ip".
  _aclCheck(dev, ifaceName, dir, frame) {
    const bind = dev.aclBindings && dev.aclBindings[ifaceName];
    if (!bind || bind[dir] == null) return { action: 'permit', acl: null };
    if (frame.etherType !== net.ETH_IPV4 || !frame.ip) return { action: 'permit', acl: bind[dir] };
    const list = (dev.config.acls || {})[String(bind[dir])];
    if (!list || !list.length) return { action: 'permit', acl: bind[dir] };
    const pkt = {
      srcIp: frame.ip.src,
      dstIp: frame.ip.dst,
      protocol: frame.icmp ? 'icmp' : (frame.l4 ? String(frame.l4.proto) : 'ip'),
      srcPort: frame.l4 ? frame.l4.srcPort : null,
      dstPort: frame.l4 ? frame.l4.dstPort : null
    };
    const verdict = aclLib.evaluate(list, pkt);
    verdict.acl = bind[dir];
    // Counters, per line, counted where the decision is made. `show access-lists` printing rules
    // with no hit counts is a list of intentions: the question an operator brings to an ACL that
    // blocks the wrong traffic is *which line ate my packet*, and only the counter answers it.
    if (verdict.matchedIndex !== null && verdict.matchedIndex !== undefined && list[verdict.matchedIndex]) {
      const entry = list[verdict.matchedIndex];
      entry.matches = (entry.matches || 0) + 1;
    } else if (verdict.implicit) {
      list.implicitMatches = (list.implicitMatches || 0) + 1;
    }
    return verdict;
  }

  // ---------------------------------------------------------------------
  // L3 origination
  // ---------------------------------------------------------------------

  _sendIcmp(src, dstIp, icmp) {
    // An address this box holds is answered by this box, without a frame ever reaching a wire.
    // `ping 10.0.0.1` typed on the router that owns 10.0.0.1 answered **0 percent** with no drop
    // event anywhere: the packet was routed out of the very port it was addressed to, ARP'd for
    // itself, and died. Pinging your own new address is the first check an operator runs, and it is
    // also what makes a VRRP master unable to see its own virtual address.
    const mine = (function () {
      const configured = typeof src.interfaceWithIp === 'function' ? src.interfaceWithIp(dstIp) : null;
      if (configured) return configured;
      if (typeof src.vrrpClaimFor !== 'function') return null;
      const claim = src.vrrpClaimFor(dstIp, null);
      if (!claim) return null;
      const held = src.interfaces.get(claim.iface);
      return held || null;
    })();
    if (mine) {
      this._emit({ type: 'icmp-echo', dev: src.id, iface: mine.name, from: dstIp, seq: icmp.seq, local: true });
      this.icmpReplies.push({ dst: src.id, id: icmp.id, seq: icmp.seq, step: this.step, local: true });
      this._emit({ type: 'icmp-reply', dev: src.id, iface: mine.name, to: dstIp, seq: icmp.seq, local: true });
      return;
    }
    const route = src.routeTo(dstIp);
    if (!route) {
      this._emit({ type: 'drop', reason: 'no route to ' + dstIp, dev: src.id, summary: 'No route to ' + dstIp });
      return;
    }
    const egress = route.iface ? src.interfaces.get(route.iface) : src.egressFor(route.via);
    if (!egress || !egress.enabled) {
      // `iface` when the port is known: the reason already names it, and an operator reading that
      // port's counters should see the discards it accumulated. With no egress at all there is no
      // port to charge, and the drop is device-level.
      this._emit({ type: 'drop', reason: 'egress interface down', dev: src.id,
        iface: egress ? egress.name : undefined });
      return;
    }
    if (!egress.ip) {
      this._emit({ type: 'drop', reason: 'no source IP on ' + egress.name, dev: src.id, iface: egress.name });
      return;
    }
    const ip = { src: egress.ip, dst: dstIp, ttl: 64, proto: 1, id: icmp.id };
    const nextHopIp = route.via;
    this._sendL3(src, egress, nextHopIp, ip, icmp);
  }

  // Send a transport packet from `dev` to `dstIp`, reusing the exact same
  // origination checks, ARP resolution and queueing a ping uses. This is the one
  // door every SYN, data segment, ACK and FIN walks through, which is why a flow
  // can be ACL-denied or NAT-translated without the flow code knowing about ACLs
  // or NAT.
  //   opts.l4    -- the TCP/UDP header
  //   opts.flow  -- flow id this packet belongs to (the attribution tag)
  //   opts.srcIp -- reply from the address the peer actually talked to
  // Returns the egress port name, or null when nothing was sent.
  _sendTransport(dev, dstIp, l4, opts) {
    const o = opts || {};
    const route = dev.routeTo(dstIp);
    if (!route) {
      this._emit({ type: 'drop', reason: 'no route to ' + dstIp, dev: dev.id, summary: 'No route to ' + dstIp });
      return null;
    }
    let egress = route.iface ? dev.interfaces.get(route.iface) : dev.egressFor(route.via);
    // A reply must come from the address that was addressed, not from whichever
    // port the routing table happens to pick: this is the same rule ICMP replies
    // follow, and the reason a server on two subnets answers on the right one.
    const own = o.srcIp ? dev.interfaceWithIp(o.srcIp) : null;
    if (own && own.enabled) egress = own;
    if (!egress || !egress.enabled) {
      this._emit({ type: 'drop', reason: 'egress interface down', dev: dev.id,
        iface: egress ? egress.name : undefined });
      return null;
    }
    const srcIp = o.srcIp || egress.ip;
    if (!srcIp) {
      this._emit({ type: 'drop', reason: 'no source IP on ' + egress.name, dev: dev.id, iface: egress.name });
      return null;
    }
    const ip = {
      src: srcIp, dst: dstIp, ttl: 64,
      proto: flowLib.ipProto(l4.proto), id: this._ipId++
    };
    this._sendL3(dev, egress, route.via, ip, null, undefined, { l4: l4, flow: o.flow || null });
    return egress.name;
  }

  _sendL3(dev, egress, nextHopIp, ip, icmp, vid, opts) {
    const v = (vid === undefined || vid === null) ? portPvid(egress) : vid;
    const o = opts || {};
    const found = dev.arpLookup ? dev.arpLookup(nextHopIp) : (dev.arp.get(nextHopIp) ? { mac: dev.arp.get(nextHopIp), source: 'learned' } : null);
    const mac = found ? found.mac : null;
    if (mac) {
      // `via` says which table answered: a frame sent to a hand-written MAC never asked ARP, and the
      // timeline should not claim it came from the cache it never read.
      this._emit({ type: 'forward', dev: dev.id, iface: egress.name, nextHop: nextHopIp, mac: mac,
        via: found.source === 'static' ? 'arp-static' : 'arp-cache', vlan: v });
      this._sendFromOwnIp(dev, egress, ethFrame(mac, egress.mac, net.ETH_IPV4, ip, icmp, null, o), v);
      return;
    }
    // ARP resolution
    this._emit({ type: 'arp-request', dev: dev.id, iface: egress.name, targetIp: nextHopIp, vlan: v });
    this._sendFromOwnIp(dev, egress, arpRequest(egress.mac, egress.ip, nextHopIp), v);
    // stash the pending packet until the ARP reply arrives
    let list = dev.pending.get(nextHopIp);
    if (!list) { list = []; dev.pending.set(nextHopIp, list); }
    list.push({ egress: egress.name, ip: ip, icmp: icmp, vid: v, l4: o.l4 || null, flow: o.flow || null });
  }

  _flushPending(dev, ip, mac, vid) {
    const list = dev.pending.get(ip);
    if (!list) return;
    dev.pending.delete(ip);
    for (const item of list) {
      const egress = dev.interfaces.get(item.egress);
      if (!egress) continue;
      const v = (vid === undefined || vid === null) ? item.vid : vid;
      this._emit({ type: 'forward', dev: dev.id, iface: egress.name, nextHop: ip, mac: mac, via: 'arp-resolved', vlan: v });
      this._emitFrame(dev, egress, ethFrame(mac, egress.mac, net.ETH_IPV4, item.ip, item.icmp, null,
        { l4: item.l4 || null, flow: item.flow || null }), v);
    }
  }

  // ---------------------------------------------------------------------
  // Transmission / egress tagging
  // ---------------------------------------------------------------------

  // Apply egress VLAN rules to a frame leaving `iface` in `vid`, then queue it.
  // A subinterface has no link of its own: the frame leaves the parent physical
  // port, tagged with the subinterface's VLAN.
  // Send a frame that originates from one of this device's own L3 addresses.
  //
  // On a router that address belongs to a point-to-point-facing port, so sending
  // out that port is right. On a multilayer switch it belongs to a VLAN, not to
  // a cable: the peer may be three ports away, and pinning the reply to the port
  // that happens to hold the address sends it into an empty socket. So for L2
  // devices the reply is handed to the bridge, which unicasts it to whichever
  // port the peer's MAC was learned on.
  _sendFromOwnIp(dev, iface, frame, vid) {
    const v = (vid === undefined || vid === null) ? 1 : vid;
    if (dev.isL2()) {
      this._forwardL2(dev, frame, null, net.isBroadcastMac(frame.dstMac), v);
      return;
    }
    this._emitFrame(dev, iface, frame, v);
  }

  _emitFrame(dev, iface, frame, vid) {
    if (!iface) return;
    // A device that could not get power from its PSE cannot transmit.
    if (dev.poeUnpowered) {
      this._emit({
        type: 'poe-deny', dev: dev.id, iface: iface.name,
        reason: 'no PoE power available - budget exhausted at the PSE'
      });
      return;
    }
    let port = iface;
    let v = (vid === undefined || vid === null) ? portPvid(iface) : vid;
    if (iface.parent) {
      port = dev.interfaces.get(iface.parent);
      if (!port || !port.enabled) {
        this._emit({ type: 'drop', reason: 'parent interface down for ' + iface.name, dev: dev.id, iface: iface.name });
        return;
      }
      v = Number(iface.encapVid) || v;
    }

    // Outbound access list is evaluated on the physical port the frame leaves.
    const aclOut = this._aclCheck(dev, port.name, 'out', frame);
    if (aclOut.action === 'deny') {
      this._emit({
        type: 'acl-deny', dev: dev.id, iface: port.name, dir: 'out', acl: aclOut.acl,
        src: frame.ip ? frame.ip.src : null, dst: frame.ip ? frame.ip.dst : null, vlan: v
      });
      return;
    }

    const egress = vlanLib.classifyEgress(port.vlan, v);
    if (egress.action === 'drop') {
      this._emit({ type: 'vlan-drop', dev: dev.id, iface: port.name, vlan: v, reason: 'VLAN ' + v + ' not allowed on egress' });
      return;
    }
    const out = Object.assign({}, frame, {
      vid: v,
      wireTagged: egress.action === 'tagged',
      wireVid: egress.action === 'tagged' ? v : null
    });
    // Interface counters. Counted here and not when the packet was built,
    // because a frame that never left the box -- denied by an ACL above, or
    // dropped for want of a VLAN -- is not throughput.
    const bytesOut = (out.l4 && out.l4.bytes) || frameBytes(out);
    if (out.l4) flowLib.countPacket(this.flowState, dev.id, 'out', out.l4.bytes || 0);
    const tx = this._portStat(dev.id, port.name);
    tx.tx++;
    tx.txBytes += bytesOut;
    // A subinterface's traffic is its own too. Counting only the parent left
    // `show interfaces Gi0/0.10` reporting 0 packets after pings that answered 100 percent - the
    // one place an operator looks to confirm a tagged interface is carrying anything.
    if (port !== iface) {
      const sub = this._portStat(dev.id, iface.name);
      sub.tx++;
      sub.txBytes += bytesOut;
    }
    this._enqueue(dev.id, port.name, out);
  }

  _enqueue(devId, iface, frame) {
    this.queue.push({ devId: devId, iface: iface, frame: frame });
  }

  _run() {
    this.computePoe();
    let guard = 0;
    while (this.queue.length) {
      if (this.step >= this.maxSteps) { this._emit({ type: 'limit', reason: 'max steps reached' }); break; }
      if (++guard > 100000) { this._emit({ type: 'limit', reason: 'runaway loop' }); break; }
      const tx = this.queue.shift();
      this.step++;
      this._deliver(tx);
    }
  }

  _deliver(tx) {
    const dev = this.topo.getDevice(tx.devId);
    if (!dev) return;
    const iface = dev.interfaces.get(tx.iface);
    if (!iface) return;
    if (!iface.enabled) {
      this._emit({ type: 'drop', reason: 'link administratively down', dev: dev.id, iface: iface.name });
      return;
    }
    const peer = iface.peer;
    if (!peer) return; // unplugged port (e.g. flood to an empty switch port)
    // A link that is down carries nothing at all. Link.state existed and nothing read it, so a
    // cable marked down kept passing every frame - the field was decoration.
    const crossing = this._linkAt(dev.id, iface.name);
    if (crossing && !crossing.isUp()) {
      this._emit({ type: 'drop', reason: 'link down', dev: dev.id, iface: iface.name, link: crossing.id });
      return;
    }
    const peerDev = this.topo.getDevice(peer.deviceId);
    if (!peerDev) return;
    const rx = this._portStat(peerDev.id, peer.iface);
    rx.rx++;
    rx.rxBytes += frameBytes(tx.frame);
    // The same accounting on the way in: a tagged frame that a subinterface will answer belongs to
    // that subinterface as well as to the parent that carried it.
    {
      const tag = tx.frame.wireVid === null || tx.frame.wireVid === undefined
        ? tx.frame.vid : tx.frame.wireVid;
      if (tag) {
        const subs = typeof peerDev.subinterfacesOf === 'function'
          ? peerDev.subinterfacesOf(peer.iface) : [];
        for (const sub of subs) {
          if (Number(sub.encapVid) !== Number(tag)) continue;
          const rec = this._portStat(peerDev.id, sub.name);
          rec.rx++;
          rec.rxBytes += frameBytes(tx.frame);
        }
      }
    }
    this._emit({
      type: 'frame', from: dev.id, fromIface: iface.name,
      to: peerDev.id, toIface: peer.iface, frame: tx.frame
    });
    this._processFrame(peerDev, tx.frame, peer.iface);
  }

  // ---------------------------------------------------------------------
  // Ingress
  // ---------------------------------------------------------------------

  _processFrame(dev, frame, inIface) {
    const inI = inIface ? dev.interfaces.get(inIface) : null;

    // 1. Spanning tree: a blocking port does not forward (either direction).
    if (inIface && this._isBlocked(dev, inIface)) {
      this._emit({ type: 'stp-block', dev: dev.id, iface: inIface, reason: 'port in STP blocking state' });
      return;
    }

    // 2. VLAN ingress classification: resolve the internal VLAN of this frame.
    let vid = frame.vid || 1;
    if (inI) {
      const res = vlanLib.classifyIngress(inI.vlan, {
        tagged: !!frame.wireTagged,
        vid: frame.wireVid
      });
      if (res.action === 'drop') {
        this._emit({ type: 'vlan-drop', dev: dev.id, iface: inIface, vlan: frame.wireVid, reason: res.reason || 'VLAN not allowed on ingress' });
        return;
      }
      vid = res.vlanId;
    }

    const f = (frame.vid === vid) ? frame : Object.assign({}, frame, { vid: vid });

    // 2b. Interface counters, ingress side. Counted on arrival, before any of the
    // drop tests below, because that is what a real `show interfaces` counter
    // does: a frame the ACL throws away was still received.
    if (f.l4) flowLib.countPacket(this.flowState, dev.id, 'in', f.l4.bytes || 0);

    // 3. MAC learning, scoped to the VLAN.
    // A passive coupler has no table to learn into: it forwards everything both
    // ways regardless of what it has seen before.
    // A passive coupler and a passive tap have no table to learn into: neither can
    // remember what it has seen, so neither may be credited with learning.
    // 2c. Port security: whether this port may hear this source at all.
    //
    // It runs before learning, not after, because a frame from a violating source must not be
    // remembered: the table would then contain the very address the port refused, and `show mac
    // address-table` would contradict `show port-security`.
    if (inIface && !dev.isSplitter() && !dev.isPassiveTap()) {
      const nowMs = Number.isFinite(this.runAtMs) ? this.runAtMs : 0;
      // Aging runs before the decision: an address that has aged out is not held by the port any
      // more, so the frame that arrives after it left is a new station, not a violation.
      const expired = psLib.age(dev, nowMs);
      if (expired.length) {
        for (const gone of expired) {
          this._emit({ type: 'port-security-age', dev: dev.id, iface: gone.port, mac: gone.mac,
            addressType: gone.type, agingMinutes: (psLib.peek(dev, gone.port) || {}).agingTimeMin });
        }
      }
      const sec = psLib.checkIngress(dev, this._logicalPortName(dev, inIface) || inIface, f.srcMac, vid, nowMs);
      if (sec.action === 'drop') {
        this._emit({ type: 'port-security-drop', dev: dev.id, iface: inIface, mac: f.srcMac,
          mode: sec.mode, counted: !!sec.count, errDisabled: !!sec.errDisable, reason: sec.reason });
        if (sec.errDisable) {
          // The port stops carrying traffic the moment it err-disables, so the line state is derived
          // again rather than waiting for something else to notice.
          this.computePortState();
        }
        return;
      }
      if (sec.learned) {
        this._emit({ type: 'port-security-learn', dev: dev.id, iface: inIface, mac: f.srcMac,
          vlan: vid, sticky: !!sec.sticky });
      }
    }

    if (inIface && !dev.isSplitter() && !dev.isPassiveTap()) dev.macTableFor(vid).set(f.srcMac, inIface);

    // 3b. Inbound access list.
    const aclIn = this._aclCheck(dev, inIface, 'in', f);
    if (aclIn.action === 'deny') {
      this._emit({
        type: 'acl-deny', dev: dev.id, iface: inIface, dir: 'in', acl: aclIn.acl,
        src: f.ip ? f.ip.src : null, dst: f.ip ? f.ip.dst : null, vlan: vid
      });
      return;
    }

    const bcast = net.isBroadcastMac(f.dstMac);
    // A powered device whose PSE budget ran out is dead: it receives nothing.
    if (dev.poeUnpowered) {
      this._emit({
        type: 'poe-deny', dev: dev.id, iface: inIface, vlan: vid,
        reason: 'device is PoE-powered but the PSE budget is exhausted'
      });
      return;
    }
    // Multicast (including the 33:33:xx IPv6 range) must be received and
    // flooded exactly like broadcast, or neighbour discovery never arrives.
    const mcast = net.isMulticastMac(f.dstMac);
    const flood = bcast || mcast;
    // A frame addressed to a group's virtual MAC is addressed to this device when this device is
    // the master of that group. Without this the master answers ARP for the VIP and then drops
    // every packet sent to it - the host resolves the gateway and still cannot reach it.
    let mine = dev.interfaceWithMac(f.dstMac);
    if (!mine && Array.isArray(dev.vrrpClaims) && inIface) {
      const claim = dev.vrrpClaims.filter(function (c) { return c.mac === f.dstMac; })[0];
      if (claim) mine = dev.interfaces.get(claim.iface) || null;
    }

    // LLDP is sent to the nearest-bridge multicast group, which a bridge must NOT
    // forward: the frame carries one hop and dies. Flooding it would invent
    // neighbours two switches away, so terminate it here and record what announced
    // itself. This is the protocol that answers "what is plugged into this port" on
    // real hardware.
    if (lldp.isLldp(f)) {
      // `no lldp receive` drops the LLDPDU at the door: the frame arrived, the port was told not to
      // listen, and the neighbour table must not record what the port refused to hear.
      const listening = !(dev.config && dev.config.lldp && dev.config.lldp.run === false) &&
        (function (port) { return !(port && port.lldpRx === false); })(inIface ? dev.interfaces.get(inIface) : null);
      if (dev.lldp && inIface && listening) {
        const nb = lldp.neighbourFrom(f, inIface);
        dev.lldp.set(inIface, nb);
        this._emit({
          type: 'lldp', dev: dev.id, iface: inIface,
          neighbour: nb.systemName, neighbourPort: nb.portId
        });
      }
      return;
    }

    // 4. Bridge / switch: forward at L2. An L3-capable switch also terminates
    //    frames addressed to itself: unicast to one of its MACs (routing and
    //    management) and ARP/ND for its own interface addresses. The last part
    //    used to be missed: an ARP request is a broadcast, so `mine` is always
    //    null and the frame was flooded without ever being offered to the L3
    //    path. The result was that no multilayer switch in the catalogue could
    //    answer for its own IP - it routed traffic for everyone else but its own
    //    management address was dead.
    // 3b. Passive optical splitter: replicate to every other leg, unchanged.
    //     Downstream the OLT's frame reaches every ONT on the branch (which is
    //     why GPON downstream is encrypted); upstream one ONT's frame reaches the
    //     OLT and every sibling, which is why a PON needs time slots. No learning,
    //     no filtering, no VLAN rewrite - a coupler cannot do any of those.
    // 3a. Passive tap: the link keeps working and the monitor gets a copy.
    //
    // These were catalogued as category 'firewall' with no capabilities, which made
    // the engine treat them as a device that drops everything: a tap inserted into a
    // live link silently cut it. That is the one thing a tap must not do. Network
    // ports pass frames through unchanged; monitor ports receive a duplicate, and a
    // frame arriving on a monitor port is discarded, because a tap is not a hub.
    if (dev.isTap() && dev.isPassiveTap()) {
      // inIface arrives as a port object from some callers and as a plain name from
      // others. Testing `port.name` on a string silently read undefined, matched no
      // monitor prefix, and forwarded a frame that came in on a monitor port - so the
      // tap behaved as a hub for exactly the broadcasts (ARP) that matter most.
      const nameOf = function (p) {
        return typeof p === 'string' ? p : String((p && p.name) || '');
      };
      const isMonitor = function (p) { return /^mon(itor)?/i.test(nameOf(p)); };
      const arrivedOn = nameOf(inIface);
      if (isMonitor(arrivedOn)) {
        this._emit({ type: 'tap-inject-refused', dev: dev.id, iface: arrivedOn, vlan: vid });
        return;
      }
      let passed = 0, copied = 0;
      for (const port of dev.activeInterfaces()) {
        if (port.name === arrivedOn) continue;
        if (inIface.peer && port.peer === inIface.peer) continue;
        if (isMonitor(port)) { this._emitFrame(dev, port, Object.assign({}, f), vid); copied++; continue; }
        this._emitFrame(dev, port, Object.assign({}, f), vid);
        passed++;
      }
      this._emit({ type: 'tap', dev: dev.id, iface: arrivedOn, through: passed, monitors: copied, vlan: vid });
      return;
    }

    if (dev.isSplitter()) {
      let legs = 0;
      for (const port of dev.activeInterfaces()) {
        if (port.name === inIface.name) continue;
        if (inIface.peer && port.peer === inIface.peer) continue;
        legs++;
        this._emitFrame(dev, port, Object.assign({}, f), vid);
      }
      this._emit({ type: 'split', dev: dev.id, iface: inIface.name, legs: legs, vlan: vid });
      return;
    }

    if (dev.isL2()) {
      const l3 = dev.hasCap('l3-forward');
      const isArp = f.etherType === net.ETH_ARP;
      const isNd = f.etherType === net.ETH_ND;
      // Owning an address is a HOST function, not a routing one. Plenty of
      // hardware bridges user traffic and still has a management stack on the
      // same chip - an ONT, an AP in bridge mode, an unmanaged switch with a
      // management IP. Requiring l3-forward for them meant such a device could
      // never answer ARP for the address printed on its own label, so the whole
      // PON branch was unreachable even though every cable was right.
      // ...and so does a switch with a management SVI: it owns an address on a VLAN, so a frame
      // addressed to that address must reach its stack instead of being bridged past it. Without
      // this the SVI existed, printed in `show ip interface brief`, and answered nothing.
      const canTerminate = l3 || dev.isHost() || dev.hasSvi();
      const forOurIp = !!(f.ip && dev.ownsIpOn(inIface, f.ip.dst));
      if (canTerminate && mine && !flood) {
        if (this._tryProcessL3(dev, f, inIface)) return;
      } else if (canTerminate && (isArp || isNd || forOurIp)) {
        // Offer it locally first - _handleArp only replies when the target
        // address is actually ours - then flood it like any switch would.
        this._tryProcessL3(dev, f, inIface);
      }
      this._forwardL2(dev, f, inIface, flood, vid);
      return;
    }

    // 5. Host / router / firewall: only act on frames addressed to us or group-addressed.
    if (!mine && !flood) {
      this._emit({ type: 'drop', reason: 'not addressed to this device', dev: dev.id, iface: inIface });
      return;
    }

    this._tryProcessL3(dev, f, inIface);
  }

  _tryProcessL3(dev, frame, inIface) {
    if (frame.etherType === net.ETH_ARP) { this._handleArp(dev, frame, inIface); return true; }
    if (frame.etherType === net.ETH_ND) { this._handleNd(dev, frame, inIface); return true; }
    if (frame.etherType === net.ETH_IPV6) {
      if (dev.interfaceWithIp6(frame.ip.dst)) { this._handleLocalIp6(dev, frame, inIface); return true; }
      if (dev.isL3()) { this._forwardL3v6(dev, frame, inIface); return true; }
      this._emit({ type: 'drop', reason: 'IPv6 packet not for us and not routable', dev: dev.id, iface: inIface });
      return true;
    }
    if (frame.etherType === net.ETH_IPV4) {
      // The "in" half of NAT: a packet addressed to a global address is rewritten
      // to the inside local before anyone asks whether the address is ours, which
      // is the order a real NAT box works in -- otherwise the router would
      // swallow its own translation.
      this._natInbound(dev, frame, inIface);
      if (dev.ownsIpOn(inIface, frame.ip.dst)) { this._handleLocalIp(dev, frame, inIface); return true; }
      if (dev.isL3()) { this._forwardL3(dev, frame, inIface); return true; }
      this._emit({ type: 'drop', reason: 'packet not for us and not routable', dev: dev.id, iface: inIface });
      return true;
    }
    return false;
  }

  // ---------------------------------------------------------------------
  // L2 forwarding (VLAN-scoped, STP-aware, LAG-aware)
  // ---------------------------------------------------------------------

  _forwardL2(dev, frame, inIface, bcast, vid) {
    const table = dev.macTableFor(vid);
    const candidates = [];

    if (bcast) {
      // bridgedInterfaces(), not activeInterfaces(): an SVI is enabled and cabled to nothing, so
      // listing it as an egress would have the switch try to send the frame out of its own
      // management address.
      for (const iface of dev.bridgedInterfaces()) {
        if (iface.parent) continue;               // subinterfaces are not bridged ports
        if (iface.name !== inIface) candidates.push(iface.name);
      }
    } else {
      const out = table.get(frame.dstMac);
      if (out && out !== inIface) {
        candidates.push(out);
      } else if (out === inIface) {
        this._emit({ type: 'drop', reason: 'loop: egress equals ingress', dev: dev.id, iface: inIface });
        return;
      } else {
        // unknown unicast -> flood within the VLAN
        for (const iface of dev.bridgedInterfaces()) {
          if (iface.parent) continue;             // subinterfaces are not bridged ports
          if (iface.name !== inIface) candidates.push(iface.name);
        }
      }
    }

    // A frame that arrived on a LAG member never leaves by the same LAG: the
    // whole group is one logical port, so hairpinning it would create a loop.
    const inLag = (dev.lagFor && inIface) ? dev.lagFor(inIface) : null;
    const inLagId = inLag ? inLag.id : null;

    // Filter: blocked ports, ports outside this VLAN, and the ingress LAG.
    const usable = [];
    for (const name of candidates) {
      if (this._isBlocked(dev, name)) {
        this._emit({ type: 'stp-block', dev: dev.id, iface: name, vlan: vid, reason: 'STP blocking' });
        continue;
      }
      const iface = dev.interfaces.get(name);
      if (!iface) continue;
      const lag = dev.lagFor ? dev.lagFor(name) : null;
      if (inLagId && lag && lag.id === inLagId) continue;
      if (vlanLib.classifyEgress(iface.vlan, vid).action === 'drop') continue; // not a member of this VLAN
      usable.push(name);
    }

    // Collapse LAG members: one frame leaves one member of each group.
    const byLag = {};
    const egresses = [];
    for (const name of usable) {
      const lag = dev.lagFor ? dev.lagFor(name) : null;
      if (!lag) { egresses.push(name); continue; }
      if (!byLag[lag.id]) byLag[lag.id] = [];
      byLag[lag.id].push(name);
    }
    for (const id of Object.keys(byLag)) {
      const members = byLag[id].slice().sort();
      const cfg = (dev.config.lags && dev.config.lags[id]) || {};
      const picked = lagLib.selectMember(members, frame, cfg.hashPolicy || 'l2') || members[0];
      egresses.push(picked);
      if (members.length > 1) {
        this._emit({ type: 'lag', dev: dev.id, lag: id, members: members, picked: picked, vlan: vid });
      }
    }

    if (!egresses.length) {
      this._emit({ type: 'drop', reason: 'no egress ports in VLAN ' + vid, dev: dev.id, iface: inIface, vlan: vid });
      return;
    }

    for (const e of egresses) {
      this._emit({
        type: 'switch', dev: dev.id, iface: e, vlan: vid,
        action: bcast ? 'flood' : (table.has(frame.dstMac) ? 'forward' : 'flood')
      });
      const iface = dev.interfaces.get(e);
      this._emitFrame(dev, iface, frame, vid);
    }
  }

  _forwardL3(dev, frame, inIface) {
    // NAT happens before the routing decision on the way in and after it on the
    // way out; this is the "out" half. A translated packet keeps its identity
    // (the flow tag) but gets a new source address.
    if (this._natOutbound(dev, frame) === 'drop') return;
    frame.ip.ttl -= 1;
    if (frame.ip.ttl <= 0) {
      this._emit({ type: 'drop', reason: 'TTL expired', dev: dev.id });
      return;
    }
    const route = dev.routeTo(frame.ip.dst);
    if (!route) {
      this._emit({ type: 'drop', reason: 'no route to ' + frame.ip.dst, dev: dev.id });
      return;
    }
    const egress = route.iface ? dev.interfaces.get(route.iface) : dev.egressFor(route.via);
    if (!egress || !egress.enabled || !egress.ip) {
      this._emit({ type: 'drop', reason: 'no usable egress interface', dev: dev.id,
        iface: egress ? egress.name : undefined });
      return;
    }
    // `mtu <n>` on a port is a promise about what that port will carry, and `pathMtu()` only feeds
    // the number a flow *derives* its segments from - a packet built elsewhere and routed through a
    // smaller port still has to be refused by that port, or the MTU would only ever be advice.
    const onWire = frameBytes(frame);
    if (egress.mtu && onWire > egress.mtu) {
      this._emit({
        type: 'drop', reason: 'frame of ' + onWire + ' bytes exceeds the ' + egress.mtu +
          '-byte MTU on ' + egress.name, dev: dev.id, iface: egress.name,
        size: onWire, mtu: egress.mtu
      });
      return;
    }
    const nextHopIp = route.via;
    this._emit({ type: 'route', dev: dev.id, dst: frame.ip.dst, via: nextHopIp, iface: egress.name, ttl: frame.ip.ttl });
    // Plain routing: preserve the original source IP, decrement TTL, rewrite
    // only the L2 header. The frame leaves in the egress port's native VLAN.
    const newIp = { src: frame.ip.src, dst: frame.ip.dst, ttl: frame.ip.ttl, proto: frame.ip.proto, id: frame.ip.id };
    this._sendL3(dev, egress, nextHopIp, newIp, frame.icmp, portPvid(egress),
      { l4: frame.l4 || null, flow: frame.flow || null });
  }

  _handleArp(dev, frame, inIface) {
    const arp = frame.arp;
    const vid = frame.vid || 1;
    if (arp.op === 'request') {
      const inIf = dev.resolveIface(inIface);
      // RFC 826: a station updates its table from any ARP it receives, not only from replies.
      // This is what makes a gratuitous ARP work - it is a request, and the whole point is that
      // the hosts who did not ask for it still believe it.
      // RFC 826 says a station updates its table from any ARP it receives - and a static entry is
      // the exception every switch has: it is not learned, so it cannot be relearned by whoever
      // answers. This is what makes `arp <ip> <mac>` a defence against a spoofed reply rather than
      // a hint that the first responder can overwrite.
      const staticHere = dev.arpStatic && dev.arpStatic.has(arp.senderIp);
      if (arp.senderIp && arp.senderMac && !staticHere) dev.arp.set(arp.senderIp, arp.senderMac);
      const owner = dev.ownsIpOn(inIf, arp.targetIp);
      if (owner) {
        // Reply out of the port that asked: inside a bridge group every port reaches
        // the same address, and answering on the wrong socket is how a LAN address
        // becomes unreachable from half the switch.
        // Inside a bridge group the group is one switch, so the reply leaves by the
        // port that asked. Otherwise the reply must leave by the interface that owns
        // the address: a router subinterface carries the VLAN tag, and sending the
        // reply out the raw trunk port would strip it.
        const sameGroup = owner.bridgeGroup && inIf && inIf.bridgeGroup === owner.bridgeGroup;
        // An SVI needs no rule here, and adding one was a mistake worth recording: _sendFromOwnIp()
        // already treats an L2 device as *bridging* its own frames rather than transmitting them out a
        // socket (`if (dev.isL2()) this._forwardL2(...)`), which is exactly what a switch's management
        // stack does. Forcing the reply out of the ingress port replaced a bridge with a unicast and
        // looked correct only because the two happen to reach the same host in a one-host lab.
        const replyIface = sameGroup ? inIf : owner;
        if (arp.senderIp && !(dev.arpStatic && dev.arpStatic.has(arp.senderIp))) {
          dev.arp.set(arp.senderIp, arp.senderMac);
        }
        // A virtual address is answered with the group's virtual MAC, not the box's own: that is
        // what lets a host keep its cache entry when mastership moves to the other router.
        // The address being defended is the one that was asked for. owner.ip is the interface's own
        // address, which for a virtual gateway is *not* the VIP - answering with it told the host
        // that 10.0.0.254 was at the router's own MAC under the router's own address, so the host
        // cached nothing usable for the gateway and every packet it sent died at that step.
        const claimed = (typeof dev.vrrpClaimFor === 'function') ? dev.vrrpClaimFor(arp.targetIp, replyIface.name) : null;
        const answerIp = claimed ? arp.targetIp : owner.ip;
        // No special case for the SVI MAC: macForIp() resolves the address to its owner, so a reply
        // for Vlan10's address carries Vlan10's MAC whichever port it leaves by. The only thing the
        // SVI needed was a port to leave through.
        const replyMac = (typeof dev.macForIp === 'function' ? dev.macForIp(answerIp, replyIface.name) : null) || replyIface.mac;
        this._emit({ type: 'arp-reply', dev: dev.id, iface: replyIface.name, targetIp: arp.targetIp, mac: replyMac, vlan: vid });
        this._sendFromOwnIp(dev, replyIface, arpReply(frame, replyMac, answerIp), vid);
      }
      // else: ignore (not for us)
    } else if (arp.op === 'reply') {
      const stat = dev.arpStatic && dev.arpStatic.get(arp.senderIp);
      if (stat) {
        // A reply that disagrees with a hand-written entry is refused, and the pending frame is sent
        // to the configured MAC instead. The event says so, because "my ping went to the wrong MAC"
        // is exactly the question this answers.
        if (String(arp.senderMac) !== String(stat)) {
          this._emit({ type: 'arp-static-hold', dev: dev.id, ip: arp.senderIp,
            offered: arp.senderMac, kept: stat, vlan: vid });
        }
        this._flushPending(dev, arp.senderIp, stat, vid);
        return;
      }
      dev.arp.set(arp.senderIp, arp.senderMac);
      this._emit({ type: 'arp-cache', dev: dev.id, ip: arp.senderIp, mac: arp.senderMac, vlan: vid });
      this._flushPending(dev, arp.senderIp, arp.senderMac, vid);
    }
  }

  _handleLocalIp(dev, frame, inIface) {
    // A transport packet addressed to one of our addresses is the business of the
    // transport layer, not of ICMP. Same entry point, different protocol.
    if (flowLib.isFlowPacket(frame)) { this._handleTransport(dev, frame, inIface); return; }
    const icmp = frame.icmp;
    if (!icmp) return;
    const vid = frame.vid || 1;
    if (icmp.type === net.ICMP_ECHO_REQUEST) {
      const inIf4 = dev.resolveIface(inIface);
      const owner = dev.ownsIpOn(inIf4, frame.ip.dst);
      if (!owner) {
        this._emit({ type: 'drop', reason: 'echo for unknown local IP', dev: dev.id });
        return;
      }
      const sameGroup4 = owner.bridgeGroup && inIf4 && inIf4.bridgeGroup === owner.bridgeGroup;
      // Which port the reply leaves by. `owner` - the port that holds the address - is wrong when the
      // echo arrived on a different port: R2 answered a ping for its own 10.9.9.2 (on Gi0/1) that
      // arrived on Gi0/0, and the reply was then sent into Gi0/1's empty socket, so the ping timed out
      // with no drop event anywhere. A router sources the reply from the address that was pinged and
      // routes it back to the sender; the ingress port is the fallback when there is no route yet.
      // (The L2 case below already had this comment; the echo path never got the fix.)
      let replyIface = sameGroup4 ? inIf4 : owner;
      if (!sameGroup4) {
        let back = null;
        if (typeof dev.routeTo === 'function') {
          try { back = dev.routeTo(frame.ip.src); } catch (e) { back = null; }
        }
        const backIface = back && back.iface ? dev.interfaces.get(back.iface) : null;
        if (backIface && backIface.enabled && backIface.ip) replyIface = backIface;
        else if (inIf4 && inIf4.enabled && inIf4.ip) replyIface = inIf4;
      }
      this._emit({ type: 'icmp-echo', dev: dev.id, iface: replyIface.name, from: frame.ip.src, seq: icmp.seq, vlan: vid });
      const replyIp = { src: frame.ip.dst, dst: frame.ip.src, ttl: 64, proto: 1, id: icmp.id };
      const replyIcmp = { type: net.ICMP_ECHO_REPLY, code: 0, id: icmp.id, seq: icmp.seq };
      this._emit({ type: 'icmp-reply', dev: dev.id, iface: replyIface.name, to: frame.ip.src, seq: icmp.seq, vlan: vid });
      // An echo to the VIP is answered from the VIP and with the group's virtual MAC, so the reply
      // looks identical whichever router in the group happens to be master.
      const echoMac = (typeof dev.macForIp === 'function' ? dev.macForIp(frame.ip.dst, replyIface.name) : null) || replyIface.mac;
      this._sendFromOwnIp(dev, replyIface, ethFrame(frame.srcMac, echoMac, net.ETH_IPV4, replyIp, replyIcmp, null), vid);
    } else if (icmp.type === net.ICMP_ECHO_REPLY) {
      this.icmpReplies.push({ dst: dev.id, id: icmp.id, seq: icmp.seq, step: this.step });
      this._emit({ type: 'icmp-received', dev: dev.id, from: frame.ip.src, seq: icmp.seq, vlan: vid });
    }
  }

  // ---------------------------------------------------------------------
  // Transport flows (engine/flow.js)
  // ---------------------------------------------------------------------
  //
  // A ping proves a path carries one packet. A flow asks whether the path can
  // carry a conversation: three packets before a byte moves, every segment
  // acknowledged, two packets to let go. Nothing here invents a shortcut around
  // the forwarding path -- a SYN is built as an ordinary IPv4 frame and handed to
  // the same _sendL3 / _emitFrame / _deliver / _processFrame chain an echo uses,
  // so it can be ACL-denied at a router, NAT-translated at the edge, or silenced
  // by a PSE that never powered the box.
  //
  // Deliberately NOT modelled, because pretending otherwise would be the lie:
  //   * congestion window / slow start -- segments go out back to back
  //   * RTO and retransmission -- a dropped segment stalls the flow (visible as
  //     bytesDelivered < bytes plus a `stalled` field) instead of being retried
  //   * SACK, window scaling, TIME_WAIT, path-MTU black holes
  //   * IP fragmentation -- the MSS is derived from the path MTU, so no segment
  //     needs to fragment; a path too narrow just yields a smaller MSS
  //   * UDP has no acknowledgement at all in reality; a datagram flow is reported
  //     as opened only when the datagram actually arrived, because a flow nobody
  //     received is not a flow

  // Resolve an API device reference: an id first, then a hostname.
  _deviceRef(ref) {
    if (ref === undefined || ref === null || ref === '') return null;
    const byId = this.topo.getDevice(String(ref));
    if (byId) return byId;
    for (const d of this.topo.devices.values()) {
      if (d.name === ref || d.hostname === ref) return d;
    }
    return null;
  }

  // The device that currently holds an address, or null. Used to follow a path
  // hop by hop (path MTU) and to name the far end of a flow.
  ownerOfIp(ip) {
    if (!ip) return null;
    for (const d of this.topo.devices.values()) {
      if (d.interfaceWithIp(ip)) return d;
    }
    return null;
  }

  // Which of the destination's addresses to send to. Prefer one the source can
  // actually reach: a server with an interface on an unroutable subnet and one on
  // the lab subnet should be reached on the lab subnet.
  _pickDestIp(src, dst) {
    const ips = [];
    for (const i of dst.activeInterfaces()) if (i.ip) ips.push(i.ip);
    if (!ips.length) return null;
    for (const ip of ips) { if (src.routeTo(ip)) return ip; }
    return ips[0];
  }

  // Path MTU: the smallest MTU along the hops an IP packet would walk. This is
  // the honest version of "assume 1500" -- it is 1500 unless a link says
  // otherwise, and a link that says otherwise is the whole reason MSS exists.
  pathMtu(src, dstIp) {
    if (!src || !dstIp) return flowLib.DEFAULT_MTU;
    const destination = this.ownerOfIp(dstIp);
    let dev = src;
    let nextHop = dstIp;
    let mtu = flowLib.DEFAULT_MTU;
    let hops = 0;
    const seen = new Set();
    while (dev && hops++ < 32) {
      if (seen.has(dev.id)) break;
      seen.add(dev.id);
      const route = dev.routeTo(nextHop);
      if (!route) break;
      const egress = route.iface ? dev.interfaces.get(route.iface) : dev.egressFor(route.via);
      if (egress && egress.mtu) mtu = Math.min(mtu, egress.mtu);
      if (route.via === dstIp) break;              // the last hop
      const next = this.ownerOfIp(route.via);
      if (!next || next === destination || next.id === dev.id) break;
      dev = next;
    }
    return mtu;
  }

  // traceroute: the forwarding path a packet would walk, hop by hop.
  //
  // TTL expiry is not modelled - nothing here decrements a counter or waits for an
  // ICMP error. It answers the question a traceroute is used to answer ("which way
  // does the traffic go, and how far is each hop") by following the same routeTo()
  // the forwarder uses. When a hop has no route, or the path loops, the reason is
  // returned instead of a fabricated star-star-star.
  tracePath(srcId, dstIp, opts) {
    const o = opts || {};
    const src = this.topo.getDevice(srcId);
    const out = { ok: false, arrived: false, hops: [], reason: null, pending: [] };
    if (!src) { out.reason = 'no such source device'; return out; }
    if (!dstIp) { out.reason = 'no destination'; return out; }

    // Refresh the control planes before walking. A trace is a question about the
    // network, not a dump of whatever the last run left behind, so the routes are
    // rebuilt here: at the named instant when one is given, otherwise fully
    // converged. Without this a fresh lab traces only as far as its static routes.
    this.refreshRoutes({ atMs: o.atMs });

    const bits = latencyLib.pingFrameBits(64);
    let dev = src;
    let guard = 0;
    const seen = new Set();
    while (dev && guard++ < 32) {
      if (seen.has(dev.id)) { out.reason = 'routing loop at ' + (dev.name || dev.id); break; }
      seen.add(dev.id);
      const route = dev.routeTo(dstIp);
      if (!route) {
        // "No route" and "the routing table is not built yet" look identical to a
        // star, so name the process that would have produced the route.
        const waiting = this._stillConverging().filter(function (e) { return e.device.id === dev.id; });
        out.reason = 'no route to ' + dstIp + ' on ' + (dev.name || dev.id) +
          (waiting.length ? ' yet: ' + waiting.map(function (e) {
            return e.process + ' still converging (ready at ' + e.readyAtMs + ' ms)';
          }).join(', ') : '');
        out.pending = waiting.map(function (e) {
          return { process: e.process, device: e.device.name, readyAtMs: e.readyAtMs };
        });
        break;
      }
      const egress = route.iface ? dev.interfaces.get(route.iface) : dev.egressFor(route.via);
      const link = egress ? this._linkAt(dev.id, egress.name) : null;
      const media = (link && link.mediaId) ? mediaModel.mediaById(link.mediaId) : null;
      const last = route.via === dstIp;
      const detail = latencyLib.linkDelayDetail({
        mediaId: link ? link.mediaId : null,
        lengthM: link ? link.lengthM : null,
        speedMbps: (link && link.speedMbps) || (media && media.speedMbps) || null,
        bits: bits,
        // Every crossing but the last is entered by a device that must receive the
        // whole frame, decide and retransmit it: one store-and-forward hop.
        hops: last ? 0 : 1
      });
      const hopDev = this.ownerOfIp(route.via);
      out.hops.push({
        address: route.via,
        device: hopDev ? (hopDev.name || hopDev.id) : null,
        from: dev.name || dev.id,
        iface: egress ? egress.name : null,
        delayS: detail.totalS,
        delayKnown: !!(detail.lengthKnown && detail.rateKnown),
        last: last
      });
      if (last) { out.ok = true; out.arrived = true; break; }
      if (!hopDev || hopDev.id === dev.id) {
        out.reason = 'next hop ' + route.via + ' is not a device in this lab';
        break;
      }
      dev = hopDev;
    }
    if (guard >= 32) out.reason = 'path did not end within 32 hops';
    return out;
  }

  // A refusal is a real answer, not a throw: the caller gets the same reason
  // string a ping would have logged, plus a stable code the API can switch on.
  _refuse(code, reason, info) {
    const i = info || {};
    if (i.src) flowLib.counterFor(this.flowState, i.src.id).flowsRefused += 1;
    this._emit({
      type: 'flow-refused', dev: i.src ? i.src.id : null, proto: i.proto || null,
      src: i.srcIp || null, dst: i.dstIp || null,
      srcPort: i.srcPort || null, dstPort: i.dstPort || null,
      code: code, reason: reason
    });
    return {
      ok: false, code: code, reason: reason, flow: null,
      events: this.events, step: this.step
    };
  }

  // Attribute a failed open to what the timeline actually shows. The point of
  // reusing the forwarding path is that the answer is not guessed here: if the
  // SYN was denied there is an acl-deny event, if the box had no power there is a
  // poe-deny event, and if nobody answered there is silence and this says so.
  _flowFailure(rec, from) {
    const evs = this.events.slice(from || 0);
    if (rec && rec.resetBy) {
      return { code: 'E_REFUSED', reason: rec.reason || ('connection refused by ' + rec.resetBy) };
    }
    const deny = evs.filter(function (e) { return e.type === 'acl-deny'; })[0];
    if (deny) {
      return {
        code: 'E_ACL_DENY',
        reason: 'denied by access list ' + deny.acl + ' ' + deny.dir + ' ' + deny.iface + ' on ' + deny.dev
      };
    }
    // A router in the middle with no route for the destination is the same
    // answer ping gives: "no route to X", not "unreachable".
    const noRoute = evs.filter(function (e) {
      return e.type === 'drop' && /^no route to /.test(String(e.reason || ''));
    })[0];
    if (noRoute) return { code: 'E_NO_ROUTE', reason: noRoute.reason };
    // Either power event answers "was it power?": `poe-budget` is the PSE's computation, `poe-deny`
    // is the frame-level refusal, and a flow that never opened may have recorded either.
    const poe = evs.filter(function (e) {
      return e.type === 'poe-deny' || e.type === 'poe-budget';
    })[0];
    if (poe) return { code: 'E_POE', reason: poe.reason || 'no PoE power available' };
    const vlan = evs.filter(function (e) { return e.type === 'vlan-drop'; })[0];
    if (vlan) return { code: 'E_VLAN', reason: vlan.reason || 'VLAN not allowed' };
    const stp = evs.filter(function (e) { return e.type === 'stp-block'; })[0];
    if (stp) return { code: 'E_STP', reason: stp.reason || 'port is blocked by spanning tree' };
    const nat = evs.filter(function (e) { return e.type === 'nat-drop'; })[0];
    if (nat) return { code: nat.code || 'E_NAT', reason: nat.reason || 'NAT could not translate the flow' };
    return { code: 'E_UNREACHABLE', reason: 'no response from ' + rec.dstIp + ':' + rec.dstPort };
  }

  // Open a transport flow. Returns { ok, flow, events, step, code?, reason? }.
  //
  // The handshake is not computed by a formula: the SYN, the SYN-ACK and the final
  // ACK each go on the wire and are read back out of the same queue a ping uses.
  // If the SYN-ACK never arrives, the flow never opens.
  openFlow(opts) {
    const o = opts || {};
    const proto = String(o.proto || 'tcp').toLowerCase();
    const src = this._deviceRef(o.srcDevice !== undefined ? o.srcDevice : o.src);
    const dst = this._deviceRef(o.dstDevice !== undefined ? o.dstDevice : o.dst);
    const dstIp = o.dstIp || (dst && src ? this._pickDestIp(src, dst) : null);
    const wantSrcPort = Number.isInteger(Number(o.srcPort)) ? Number(o.srcPort) : null;
    const wantDstPort = Number.isInteger(Number(o.dstPort)) ? Number(o.dstPort) : null;
    const info = {
      proto: proto, src: src, dst: dst, srcIp: null,
      dstIp: dstIp || null, srcPort: wantSrcPort, dstPort: wantDstPort
    };

    // Same setup a ping does, in the same order: spanning tree, PoE, LLDP, RA,
    // first-hop redundancy, DHCP, then the routing protocols. A flow must see the
    // network a ping sees.
    //
    // VRRP and DHCP used to be missing from this list, which made a flow to a
    // virtual IP fail with "no response" on a fresh simulator while a ping to the
    // same address succeeded: nothing had run the election, so no device owned the
    // VIP and the SYN was never answered. A flow may end on a VIP, so the election
    // has to happen here too.
    this.refreshControlPlanes({ atMs: o.atMs, reset: true, lldp: true, ra: true });

    if (proto !== flowLib.PROTO.TCP && proto !== flowLib.PROTO.UDP) {
      return this._refuse('E_PROTO', 'proto must be tcp or udp (got ' + String(o.proto) + ')', info);
    }
    if (!src) {
      throw new Error('Unknown source device: ' + (o.srcDevice !== undefined ? o.srcDevice : o.src));
    }
    if (!dst && !dstIp) {
      throw new Error('Unknown destination device: ' + (o.dstDevice !== undefined ? o.dstDevice : o.dst));
    }
    if (!dstIp) return this._refuse('E_NO_ADDRESS', 'destination device has no IP address', info);
    info.dstIp = dstIp;

    // 1. Power. A box the PSE never powered cannot open a connection any more
    //    than it can answer an echo; say so instead of blaming the route.
    if (src.poeUnpowered) {
      return this._refuse('E_POE', 'no PoE power available - ' + src.name + ' was not powered by its PSE', info);
    }
    if (dst && dst !== src && dst.poeUnpowered) {
      return this._refuse('E_POE', 'no PoE power available - ' + dst.name + ' was not powered by its PSE', info);
    }

    // 2. Reachability, with the exact reasons ping logs.
    const route = src.routeTo(dstIp);
    if (!route) return this._refuse('E_NO_ROUTE', 'no route to ' + dstIp, info);
    const egress = route.iface ? src.interfaces.get(route.iface) : src.egressFor(route.via);
    if (!egress || !egress.enabled) return this._refuse('E_IFACE_DOWN', 'egress interface down', info);
    if (!egress.ip) return this._refuse('E_NO_SOURCE_IP', 'no source IP on ' + egress.name, info);
    info.srcIp = egress.ip;

    // 3. Segment maths from the path, not from a constant.
    const mtu = this.pathMtu(src, dstIp);
    const mss = flowLib.mssForMtu(mtu, proto);
    const probe = flowLib.createFlow({
      id: 'probe', proto: proto, srcIp: egress.ip,
      srcPort: wantSrcPort === null ? flowLib.EPHEMERAL_FIRST : wantSrcPort,
      dstIp: dstIp, dstPort: wantDstPort,
      bytes: o.bytes
    });
    info.srcPort = probe.srcPort;
    info.dstPort = probe.dstPort;
    const segments = flowLib.segmentCount(probe.bytes, mss);
    // A flow is a run of packets through a queue, and the run has to fit the step
    // budget or the tail of the transfer would be silently truncated.
    const MAX_SEGMENTS = 512;
    if (segments > MAX_SEGMENTS) {
      return this._refuse('E_FLOW_TOO_LARGE',
        probe.bytes + ' bytes would need ' + segments + ' segments at MSS ' + mss +
        ' (path MTU ' + mtu + '); this simulator caps a flow at ' + MAX_SEGMENTS + ' segments',
        info);
    }

    const id = flowLib.nextFlowId(this.flowState);
    const rec = flowLib.createFlow({
      id: id,
      proto: proto,
      srcIp: egress.ip,
      srcPort: probe.srcPort,
      dstIp: dstIp,
      dstPort: probe.dstPort,
      bytes: probe.bytes,
      srcDevice: src.id,
      dstDevice: dst ? dst.id : (this.ownerOfIp(dstIp) || {}).id || null,
      mss: mss,
      state: flowLib.STATE.CLOSED
    });
    rec.segments = segments;
    rec.mtu = mtu;
    rec.iface = egress.name;
    rec.openedStep = this.step;
    this.flows.set(rec.id, rec);
    flowLib.counterFor(this.flowState, src.id).flowsOpened += 1;

    const startedAt = this.events.length;
    const clientIsn = flowLib.initialSeq(this.flowState.seq * 31 + 7);
    rec.clientIsn = clientIsn;
    rec.nextSeq = clientIsn + 1;

    // 4. UDP: one datagram, no state at all. It counts as opened when it arrives.
    if (proto === flowLib.PROTO.UDP) {
      flowLib.setState(rec, flowLib.STATE.OPEN);
      const l4 = flowLib.udpPacket({ srcPort: rec.srcPort, dstPort: rec.dstPort, bytes: rec.bytes });
      this._emit({
        type: 'flow-open', flow: rec.id, dev: src.id, proto: 'udp', phase: 'datagram',
        src: rec.srcIp, dst: rec.dstIp, srcPort: rec.srcPort, dstPort: rec.dstPort,
        bytes: rec.bytes, length: l4.length
      });
      this._emit({
        type: 'flow-data', flow: rec.id, dev: src.id, proto: 'udp', dir: 'out',
        src: rec.srcIp, dst: rec.dstIp, srcPort: rec.srcPort, dstPort: rec.dstPort,
        bytes: rec.bytes
      });
      rec.packets += 1;
      this._sendTransport(src, rec.dstIp, l4, { flow: rec.id });
      this._run();
      if (!rec.delivered) {
        const why = this._flowFailure(rec, startedAt);
        rec.state = flowLib.STATE.RESET;
        rec.code = why.code;
        rec.reason = why.reason;
        flowLib.counterFor(this.flowState, src.id).flowsRefused += 1;
        // A datagram that never arrived leaves no connection behind: the record
        // is handed back to the caller for its code and reason, but it does not
        // join the list of flows anybody could close.
        this.flows.delete(rec.id);
        return {
          ok: false, code: why.code, reason: why.reason, flow: rec,
          events: this.events, step: this.step
        };
      }
      return { ok: true, flow: rec, events: this.events, step: this.step, mtu: mtu, mss: mss, segments: 0 };
    }

    // 5. TCP three-way handshake, one packet at a time.
    flowLib.setState(rec, flowLib.STATE.SYN_SENT);
    this._emit({
      type: 'flow-open', flow: rec.id, dev: src.id, proto: 'tcp', phase: 'syn', flags: 'SYN',
      src: rec.srcIp, dst: rec.dstIp, srcPort: rec.srcPort, dstPort: rec.dstPort,
      seq: clientIsn, ack: 0, mss: mss
    });
    rec.packets += 1;
    this._sendTransport(src, rec.dstIp, flowLib.synPacket(rec, clientIsn), { flow: rec.id });
    this._run();

    if (!rec.synAcked) {
      const why = this._flowFailure(rec, startedAt);
      rec.state = flowLib.STATE.RESET;
      rec.code = why.code;
      rec.reason = why.reason;
      flowLib.counterFor(this.flowState, src.id).flowsRefused += 1;
      // Nothing was established, so nothing is left to close. The record goes
      // back to the caller; the timeline keeps the refusal.
      this.flows.delete(rec.id);
      return {
        ok: false, code: why.code, reason: why.reason, flow: rec,
        events: this.events, step: this.step
      };
    }

    // The third packet: the client acknowledges the server's ISN. The connection
    // exists from this moment, and only from this moment.
    this._emit({
      type: 'flow-open', flow: rec.id, dev: src.id, proto: 'tcp', phase: 'established', flags: 'ACK',
      src: rec.srcIp, dst: rec.dstIp, srcPort: rec.srcPort, dstPort: rec.dstPort,
      seq: clientIsn + 1, ack: rec.serverIsn + 1
    });
    rec.packets += 1;
    this._sendTransport(src, rec.dstIp,
      flowLib.ackPacket(rec.srcPort, rec.dstPort, clientIsn + 1, rec.serverIsn + 1), { flow: rec.id });
    this._run();
    flowLib.setState(rec, flowLib.STATE.ESTABLISHED);

    // 6. The body, in segments that fit the path.
    let seq = clientIsn + 1;
    let sent = 0;
    for (let i = 0; i < segments; i++) {
      const size = Math.min(rec.mss, rec.bytes - sent);
      const l4 = flowLib.dataPacket(rec.srcPort, rec.dstPort, seq, rec.serverIsn + 1, size);
      this._emit({
        type: 'flow-data', flow: rec.id, dev: src.id, proto: 'tcp', dir: 'out',
        src: rec.srcIp, dst: rec.dstIp, srcPort: rec.srcPort, dstPort: rec.dstPort,
        seq: seq, ack: rec.serverIsn + 1, bytes: size,
        segment: i + 1, of: segments, mss: rec.mss
      });
      rec.packets += 1;
      this._sendTransport(src, rec.dstIp, l4, { flow: rec.id });
      this._run();
      seq += size;
      rec.nextSeq = seq;
      sent += size;
      if ((rec.ackedBytes || 0) < sent) {
        // Nothing acknowledged this segment, and there is no retransmission here,
        // so the flow stops where the network stopped carrying it. Saying so beats
        // reporting bytes that never arrived.
        rec.stalled = { segment: i + 1, bytesSent: sent, bytesAcked: rec.ackedBytes || 0 };
        break;
      }
    }

    return {
      ok: true, flow: rec, events: this.events, step: this.step,
      mtu: mtu, mss: mss, segments: segments
    };
  }

  // Close a flow. TCP gets a four-way close (FIN, FIN-ACK, ACK) over the same
  // path; UDP has nothing to close, so the record is simply retired.
  closeFlow(id) {
    const key = String(id);
    const rec = this.flows.get(key);
    if (!rec) {
      return { ok: false, code: 'E_NO_FLOW', reason: 'no such flow: ' + key, events: this.events, step: this.step };
    }
    if (rec.state === flowLib.STATE.CLOSED) {
      return { ok: true, flow: rec, events: this.events, step: this.step, already: true };
    }
    const src = this.topo.getDevice(rec.srcDevice);
    if (!src) {
      rec.state = flowLib.STATE.CLOSED;
      rec.closedStep = this.step;
      return { ok: true, flow: rec, events: this.events, step: this.step, detached: true };
    }
    if (rec.proto === flowLib.PROTO.UDP) {
      this._emit({
        type: 'flow-close', flow: rec.id, dev: src.id, proto: 'udp', phase: 'closed',
        src: rec.srcIp, dst: rec.dstIp, srcPort: rec.srcPort, dstPort: rec.dstPort,
        reason: 'connectionless'
      });
      rec.state = flowLib.STATE.CLOSED;
      rec.closedStep = this.step;
      return { ok: true, flow: rec, events: this.events, step: this.step };
    }

    flowLib.setState(rec, flowLib.STATE.FIN_WAIT);
    const finSeq = rec.nextSeq || (rec.clientIsn + 1 + rec.bytes);
    this._emit({
      type: 'flow-close', flow: rec.id, dev: src.id, proto: 'tcp', phase: 'fin', flags: 'FIN,ACK',
      src: rec.srcIp, dst: rec.dstIp, srcPort: rec.srcPort, dstPort: rec.dstPort,
      seq: finSeq, ack: (rec.serverIsn || 0) + 1
    });
    rec.packets += 1;
    this._sendTransport(src, rec.dstIp,
      flowLib.finPacket(rec.srcPort, rec.dstPort, finSeq, (rec.serverIsn || 0) + 1), { flow: rec.id });
    const before = this.events.length;
    this._run();

    if (rec.state !== flowLib.STATE.CLOSED) {
      // No FIN-ACK came back. The local side closes anyway -- that is what a host
      // does when the peer vanishes -- but the timeline records why.
      const why = this._flowFailure(rec, before);
      rec.teardown = 'fin-timeout';
      rec.code = why.code;
      rec.reason = why.reason;
      this._emit({
        type: 'flow-close', flow: rec.id, dev: src.id, proto: 'tcp', phase: 'closed',
        src: rec.srcIp, dst: rec.dstIp, srcPort: rec.srcPort, dstPort: rec.dstPort,
        reason: why.reason
      });
      rec.state = flowLib.STATE.CLOSED;
    }
    rec.closedStep = this.step;
    return { ok: true, flow: rec, events: this.events, step: this.step };
  }

  // The receiving half of a flow: every TCP and UDP packet addressed to one of
  // this device's addresses lands here, from the same _handleLocalIp that answers
  // echoes. Replies go to the ports the packet was received on, not to the flow's
  // original ones, so a NAT-translated conversation answers where it was asked.
  _handleTransport(dev, frame, inIface) {
    const l4 = frame.l4;
    const rec = frame.flow ? this.flows.get(String(frame.flow)) : null;
    const vid = frame.vid || 1;
    const fromClient = !!(rec && rec.srcDevice === dev.id);
    const bytes = l4.bytes || 0;

    if (l4.proto === flowLib.PROTO.UDP) {
      if (rec) {
        rec.delivered = true;
        rec.bytesDelivered += bytes;
      }
      this._emit({
        type: 'flow-data', flow: rec ? rec.id : null, dev: dev.id, proto: 'udp', dir: 'in',
        src: frame.ip.src, dst: frame.ip.dst, srcPort: l4.srcPort, dstPort: l4.dstPort,
        bytes: bytes, vlan: vid
      });
      return;
    }

    const flags = flowLib.flagString(l4);

    // RST: the far end had nothing to say to us -- no listener, or a stale
    // connection. A refusal is a packet, not an error code invented here.
    if (flowLib.hasFlag(l4, 'RST')) {
      if (rec) {
        rec.resetBy = dev.id;
        rec.reason = rec.reason ||
          ('connection refused: nothing listening on ' + frame.ip.dst + ':' + l4.dstPort);
        flowLib.setState(rec, flowLib.STATE.RESET);
      }
      this._emit({
        type: 'flow-reset', flow: rec ? rec.id : null, dev: dev.id, flags: flags,
        src: frame.ip.src, dst: frame.ip.dst, srcPort: l4.srcPort, dstPort: l4.dstPort, vlan: vid
      });
      return;
    }

    // SYN with no ACK: a client wants to open a socket here.
    if (flowLib.hasFlag(l4, 'SYN') && !flowLib.hasFlag(l4, 'ACK')) {
      if (!flowLib.listensOn(dev, 'tcp', l4.dstPort)) {
        if (rec) {
          rec.reason = 'connection refused: nothing listening on ' + frame.ip.dst + ':' + l4.dstPort;
          rec.packets += 1;
        }
        this._emit({
          type: 'flow-reset', flow: rec ? rec.id : null, dev: dev.id, flags: 'RST,ACK',
          src: frame.ip.dst, dst: frame.ip.src, srcPort: l4.dstPort, dstPort: l4.srcPort,
          reason: 'nothing listening on port ' + l4.dstPort, vlan: vid
        });
        this._sendTransport(dev, frame.ip.src,
          flowLib.resetPacket(l4.dstPort, l4.srcPort, 0, l4.seq + 1),
          { srcIp: frame.ip.dst, flow: rec ? rec.id : null });
        return;
      }
      const serverIsn = flowLib.initialSeq((rec ? Number(String(rec.id).replace(/\D/g, '')) || 1 : 1) + 17);
      if (rec) {
        rec.clientIsn = l4.seq;
        rec.serverIsn = serverIsn;
        rec.mss = l4.mss || rec.mss;
        flowLib.setState(rec, flowLib.STATE.SYN_RECEIVED);
        rec.packets += 1;
      }
      this._emit({
        type: 'flow-open', flow: rec ? rec.id : null, dev: dev.id, proto: 'tcp', phase: 'syn-ack',
        flags: 'SYN,ACK', src: frame.ip.dst, dst: frame.ip.src,
        srcPort: l4.dstPort, dstPort: l4.srcPort,
        seq: serverIsn, ack: l4.seq + 1, mss: rec ? rec.mss : null, vlan: vid
      });
      this._sendTransport(dev, frame.ip.src,
        flowLib.tcpPacket({
          srcPort: l4.dstPort, dstPort: l4.srcPort,
          flags: ['SYN', 'ACK'], seq: serverIsn, ack: l4.seq + 1,
          mss: rec ? rec.mss : null
        }),
        { srcIp: frame.ip.dst, flow: rec ? rec.id : null });
      return;
    }

    // SYN-ACK reaching the client: the server's ISN is now known.
    if (flowLib.hasFlag(l4, 'SYN') && flowLib.hasFlag(l4, 'ACK')) {
      if (rec && fromClient) {
        rec.synAcked = true;
        rec.serverIsn = l4.seq;
        rec.mss = l4.mss || rec.mss;
        flowLib.setState(rec, flowLib.STATE.ESTABLISHED);
      }
      return;
    }

    // FIN from the client: the server goes to close-wait and answers FIN-ACK.
    if (flowLib.hasFlag(l4, 'FIN') && rec && !fromClient) {
      flowLib.setState(rec, flowLib.STATE.CLOSE_WAIT);
      rec.packets += 1;
      this._emit({
        type: 'flow-close', flow: rec.id, dev: dev.id, proto: 'tcp', phase: 'fin-ack',
        flags: 'FIN,ACK', src: frame.ip.dst, dst: frame.ip.src,
        srcPort: l4.dstPort, dstPort: l4.srcPort, vlan: vid
      });
      this._sendTransport(dev, frame.ip.src,
        flowLib.tcpPacket({
          srcPort: l4.dstPort, dstPort: l4.srcPort,
          flags: ['FIN', 'ACK'], seq: (rec.serverIsn || 0) + 1, ack: l4.seq + 1
        }),
        { srcIp: frame.ip.dst, flow: rec.id });
      return;
    }

    // FIN-ACK reaching the client: acknowledge it and let the connection go.
    if (flowLib.hasFlag(l4, 'FIN') && rec && fromClient) {
      rec.packets += 1;
      this._emit({
        type: 'flow-close', flow: rec.id, dev: dev.id, proto: 'tcp', phase: 'ack',
        flags: 'ACK', src: frame.ip.dst, dst: frame.ip.src,
        srcPort: l4.dstPort, dstPort: l4.srcPort, vlan: vid
      });
      this._sendTransport(dev, frame.ip.src,
        flowLib.ackPacket(l4.dstPort, l4.srcPort, l4.ack, l4.seq + 1),
        { srcIp: frame.ip.dst, flow: rec.id });
      rec.state = flowLib.STATE.CLOSED;
      rec.closedStep = this.step;
      return;
    }

    // Data arriving at the server: count it, then acknowledge cumulatively.
    if (bytes > 0) {
      if (!rec) return;
      rec.bytesDelivered += bytes;
      rec.ackedBytes = (l4.seq - (rec.clientIsn + 1)) + bytes;
      this._emit({
        type: 'flow-data', flow: rec.id, dev: dev.id, proto: 'tcp', dir: 'in',
        src: frame.ip.src, dst: frame.ip.dst, srcPort: l4.srcPort, dstPort: l4.dstPort,
        seq: l4.seq, ack: l4.ack, bytes: bytes, vlan: vid
      });
      rec.packets += 1;
      this._sendTransport(dev, frame.ip.src,
        flowLib.ackPacket(l4.dstPort, l4.srcPort, (rec.serverIsn || 0) + 1, l4.seq + bytes),
        { srcIp: frame.ip.dst, flow: rec.id });
      return;
    }

    // A bare ACK. On the server side it is either the third packet of the
    // handshake or a cumulative acknowledgement of data; nothing goes back.
    if (flowLib.hasFlag(l4, 'ACK') && rec && !fromClient) {
      rec.ackedBytes = Math.max(rec.ackedBytes || 0, l4.ack - (rec.clientIsn + 1));
      if (rec.state === flowLib.STATE.SYN_RECEIVED) flowLib.setState(rec, flowLib.STATE.ESTABLISHED);
      else if (rec.state === flowLib.STATE.CLOSE_WAIT) flowLib.setState(rec, flowLib.STATE.CLOSED);
      return;
    }
  }

  // ---------------------------------------------------------------------
  // NAT on the forwarding path
  // ---------------------------------------------------------------------
  //
  // engine/nat.js is a pure library: tables in, verdicts out. It had never been
  // wired to the data path, which meant a lab could configure NAT and watch every
  // packet ignore it. A flow is where that shows up first -- a client behind PAT
  // is only reachable if the translation is applied to the SYN and to every
  // segment after it -- so the hooks live here, at the two points where a real
  // router translates: before routing on the way in, after routing on the way out.

  _isNat(dev) {
    const cfg = dev && dev.config ? (dev.config.nat || null) : null;
    if (cfg && ((cfg.rules && cfg.rules.length) || (cfg.portForwards && cfg.portForwards.length))) return true;
    return !!(dev && dev.config && dev.config.natRules && dev.config.natRules.length);
  }

  // Which side of the box a port is on, when the console says so. A lab built from the topology
  // marks no roles, and there the presence of rules is the whole story (that is how every NAT lab
  // in the suite is built); the moment an operator writes `ip nat inside`, the roles are honoured,
  // because otherwise the command would be decoration.
  _natRolesDeclared(dev) {
    for (const i of dev.interfaces.values()) if (i.natRole) return true;
    return false;
  }

  _natRoleOf(dev, ifaceName) {
    const i = dev.interfaces.get(ifaceName);
    return i ? i.natRole || null : null;
  }

  // The table is per device and lives with the device, so translations survive
  // from the SYN to the FIN exactly as they do on real hardware.
  _natTableOf(dev) {
    if (!dev.natTable) {
      const cfg = dev.config.nat || {};
      const table = natLib.createNatTable();
      table.rules = ((cfg.rules || dev.config.natRules) || []).slice();
      for (const fwd of (cfg.portForwards || [])) table.rules.push(fwd);
      dev.natTable = table;
    }
    return dev.natTable;
  }

  // An ICMP echo has no ports, and NAT used to pass it through untouched because of it: a lab could
  // ping across a NAT box and watch nothing appear in `show ip nat translations`, because `frame.l4`
  // was the gate. Real NAT rewrites the echo's source address, and PAT uses the echo identifier as
  // the flow's key; this gives ICMP the same treatment, without inventing a transport header on the
  // wire (the write-back goes to `frame.icmp.id`, not to a fabricated `frame.l4`).
  _natL4Of(frame) {
    if (frame.l4) return frame.l4;
    if (frame.icmp) {
      const id = frame.icmp.id;
      return { proto: 'icmp', srcPort: id, dstPort: id, synthetic: true };
    }
    return null;
  }

  _natSetPorts(frame, which, value) {
    if (frame.l4) {
      frame.l4 = Object.assign({}, frame.l4, which === 'src' ? { srcPort: value } : { dstPort: value });
      return;
    }
    if (frame.icmp) {
      frame.icmp = Object.assign({}, frame.icmp, { id: value });
    }
  }

  _natPacket(frame) {
    const l4 = this._natL4Of(frame);
    return {
      srcIp: frame.ip.src, dstIp: frame.ip.dst,
      protocol: l4.proto, srcPort: l4.srcPort, dstPort: l4.dstPort
    };
  }

  // Inside -> outside. Returns 'translate', 'pass' or 'drop'.
  _natOutbound(dev, frame) {
    if (!frame || !frame.ip || !this._natL4Of(frame) || !this._isNat(dev)) return 'pass';
    // A packet leaving by a port that is not marked `outside` is not being translated on its way
    // out; without this check the role commands would store state and change nothing.
    if (this._natRolesDeclared(dev)) {
      // A static route carries no interface - `_forwardL3` resolves the egress from the next hop,
      // and this check has to resolve it the same way or every route with a next hop looks like
      // "no outside port" and the translation is silently skipped.
      const route = dev.routeTo(frame.ip.dst);
      if (!route) return 'pass';
      const egress = route.iface ? dev.interfaces.get(route.iface)
        : (typeof dev.egressFor === 'function' ? dev.egressFor(route.via) : null);
      if (!egress || this._natRoleOf(dev, egress.name) !== 'outside') return 'pass';
    }
    const table = this._natTableOf(dev);
    const res = natLib.translateOutbound(table, this._natPacket(frame), this.step);
    if (res.action === 'drop') {
      this._emit({
        type: 'nat-drop', dev: dev.id, code: res.reason || 'E_NAT',
        reason: res.message || 'NAT could not translate the packet',
        src: frame.ip.src, dst: frame.ip.dst, flow: frame.flow || null
      });
      return 'drop';
    }
    if (res.action !== 'translate') return 'pass';
    const l4 = this._natL4Of(frame);
    const localIp = frame.ip.src;
    const localPort = l4.srcPort;
    frame.ip = Object.assign({}, frame.ip, { src: res.pkt.srcIp });
    this._natSetPorts(frame, 'src', res.pkt.srcPort);
    frame.nat = {
      dir: 'out', type: res.entry ? res.entry.type : null,
      insideLocal: localIp, insideGlobal: res.pkt.srcIp,
      localPort: localPort, globalPort: res.pkt.srcPort
    };
    this._emit({
      type: 'nat-outbound', dev: dev.id, proto: l4.proto,
      insideLocal: localIp, insideGlobal: res.pkt.srcIp,
      localPort: localPort, globalPort: res.pkt.srcPort,
      dst: frame.ip.dst, dstPort: l4.dstPort, flow: frame.flow || null
    });
    return 'translate';
  }

  // Outside -> inside. Returns true when the packet was rewritten.
  _natInbound(dev, frame, inIface) {
    if (!frame || !frame.ip || !this._natL4Of(frame) || !this._isNat(dev)) return false;
    // ...and `ip nat outside` means the untranslation happens on the way in from that port only.
    if (this._natRolesDeclared(dev)) {
      const port = typeof inIface === 'string' ? inIface : (inIface && inIface.name);
      if (this._natRoleOf(dev, port) !== 'outside') return false;
    }
    const table = this._natTableOf(dev);
    const res = natLib.translateInbound(table, this._natPacket(frame), this.step);
    if (!res || res.action !== 'translate') return false;
    const l4 = this._natL4Of(frame);
    const globalIp = frame.ip.dst;
    const globalPort = l4.dstPort;
    frame.ip = Object.assign({}, frame.ip, { dst: res.pkt.dstIp });
    this._natSetPorts(frame, 'dst', res.pkt.dstPort);
    frame.nat = {
      dir: 'in', type: res.entry ? res.entry.type : null,
      insideGlobal: globalIp, insideLocal: res.pkt.dstIp,
      globalPort: globalPort, localPort: res.pkt.dstPort
    };
    this._emit({
      type: 'nat-inbound', dev: dev.id, proto: l4.proto,
      insideGlobal: globalIp, insideLocal: res.pkt.dstIp,
      globalPort: globalPort, localPort: res.pkt.dstPort,
      src: frame.ip.src, srcPort: l4.srcPort, flow: frame.flow || null
    });
    return true;
  }
}

module.exports = { Simulator, ethFrame, arpRequest, arpReply, portPvid, speedToCost };
