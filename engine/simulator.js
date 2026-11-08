'use strict';
// simulator.js -- event-driven packet simulation.
//
// Layers: physical (media/speed, already modelled on the Link), L2 (802.1Q VLANs,
// MAC learning per VLAN, flooding within a VLAN, LAG egress selection, 802.1D
// spanning-tree blocking), and L3 (ARP, IPv4 longest-prefix routing, ICMP).
const net = require('./net');
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
    // Lease state per server device, rebuilt each run: a lease is a property of a run, not of the
    // topology, and a stale one would make the second ping in a lab answer with an address nobody
    // was offered.
    this._dhcpStates = new Map();
    this.dhcpLeases = [];
    // reset() rewinds a run, not the connection table: a ping must not tear down
    // somebody's TCP session.
    if (!this.flowState) this.flowState = flowLib.createFlowState();
  }

  _emit(ev) {
    ev.step = this.step;
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

  // The schedule of when each process finishes, as data.
  getConvergence() {
    // Rebuilt on every call. It is a pure walk over the device list, and a cache here would be one
    // more thing that can disagree with the topology it describes.
    return convergenceLib.buildSchedule(this.topo);
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
        let cost = speedToCost(link ? link.speedMbps : null);
        if (members.length > 1) cost = Math.round(cost / members.length); // aggregate
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
        priority: (dev.config && dev.config.stpPriority) || stpLib.STP_DEFAULT_PRIORITY,
        mac: mac || '00:00:00:00:00:00',
        ports: ports
      });
    }

    const res = stpLib.runStp({ bridges: bridges });
    this.stpResult = res;

    // Reset, then apply decisions back onto physical ports.
    for (const dev of this.topo.devices.values()) {
      if (!dev.isL2()) continue;
      dev.stp = { blocked: new Set(), states: {}, roles: {} };
    }
    for (const bridgeKey of Object.keys(res.ports || {})) {
      const dev = this.topo.getDevice(bridgeKey);
      if (!dev || !dev.stp) continue;
      const portMap = res.ports[bridgeKey];
      for (const logicalName of Object.keys(portMap)) {
        const info = portMap[logicalName];
        dev.stp.states[logicalName] = info.state;
        dev.stp.roles[logicalName] = info.role;
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

  computeDhcp() {
    const events = [];
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
        const servers = segment.filter(function (e) {
          return e.device && e.device !== dev && e.device.config &&
            Array.isArray(e.device.config.dhcpPools) && e.device.config.dhcpPools.length &&
            e.iface.ip;
        });

        const result = this._runDhcpExchange(dev, clientIface, servers);
        events.push(result.event);
        if (result.lease) {
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

  // One client, one interface, one DISCOVER -> OFFER -> REQUEST -> ACK.
  _runDhcpExchange(client, clientIface, servers) {
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

    // A server answers only for a pool that covers the subnet its own interface is in. The first
    // match wins, in device order, so a run is deterministic.
    let chosen = null;
    for (const s of servers) {
      for (const rawPool of s.device.config.dhcpPools) {
        const pool = dhcpLib.normalizePool(rawPool);
        const check = dhcpLib.validatePool(pool);
        if (!check.ok) continue;
        // The question is "is this server's interface inside the pool's subnet", not "could this
        // address be handed out" - the gateway is deliberately not allocatable, and asking
        // ipInPool() would reject every correctly configured router.
        if (net.ipInSubnet(s.iface.ip, pool.network, pool.mask)) {
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

    const offer = dhcpLib.handleDiscover(chosen.pool, state, { mac: mac, step: this.step });
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

    const ack = dhcpLib.handleRequest(chosen.pool, state, {
      mac: mac, requestedIp: offer.ip, step: this.step
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
        leaseSec: leaseSec, client: client.id, iface: clientIface.name, mac: mac
      },
      event: Object.assign({}, base, {
        phase: 'ack', ok: true, ip: ack.ip, mask: chosen.pool.mask,
        server: serverDev.id, serverName: serverDev.name,
        serverIp: chosen.server.iface.ip, pool: chosen.pool.name,
        gateway: chosen.pool.gateway || null, leaseSec: leaseSec
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
      links.push({
        a: { router: l.a.deviceId, iface: l.a.iface },
        b: { router: l.b.deviceId, iface: l.b.iface },
        cost: 10
      });
    }

    const graph = ospfLib.buildGraph(routers, links);
    const result = Object.create(null);

    for (const r of routers) {
      // Directly connected peers, so a next hop can be turned into a real IP.
      const nbr = Object.create(null);
      for (const l of links) {
        if (l.a.router === r.id) {
          const peer = byId[l.b.router].entry.interfaces.filter(function (x) { return x.name === l.b.iface; })[0];
          if (peer) nbr[l.b.router] = { ip: peer.ip, iface: l.a.iface };
        } else if (l.b.router === r.id) {
          const peer = byId[l.a.router].entry.interfaces.filter(function (x) { return x.name === l.a.iface; })[0];
          if (peer) nbr[l.a.router] = { ip: peer.ip, iface: l.b.iface };
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
      if (this._converged('ospf', ospfDev)) {
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
      for (const iface of dev.activeInterfaces()) {
        if (!iface.peer) continue;                 // nothing plugged in
        if (iface.parent) continue;                // subinterfaces are not ports
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
        if (remaining >= draw) {
          remaining -= draw;
          ports.push({ iface: name, pd: other.id, draw: draw, powered: true });
        } else {
          ports.push({ iface: name, pd: other.id, draw: draw, powered: false });
          peer.poeUnpowered = true;
          this._emit({
            type: 'poe-deny', dev: dev.id, iface: name, pd: other.id,
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
    return verdict;
  }

  // ---------------------------------------------------------------------
  // L3 origination
  // ---------------------------------------------------------------------

  _sendIcmp(src, dstIp, icmp) {
    const route = src.routeTo(dstIp);
    if (!route) {
      this._emit({ type: 'drop', reason: 'no route to ' + dstIp, dev: src.id, summary: 'No route to ' + dstIp });
      return;
    }
    const egress = route.iface ? src.interfaces.get(route.iface) : src.egressFor(route.via);
    if (!egress || !egress.enabled) {
      this._emit({ type: 'drop', reason: 'egress interface down', dev: src.id });
      return;
    }
    if (!egress.ip) {
      this._emit({ type: 'drop', reason: 'no source IP on ' + egress.name, dev: src.id });
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
      this._emit({ type: 'drop', reason: 'egress interface down', dev: dev.id });
      return null;
    }
    const srcIp = o.srcIp || egress.ip;
    if (!srcIp) {
      this._emit({ type: 'drop', reason: 'no source IP on ' + egress.name, dev: dev.id });
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
    const mac = dev.arp.get(nextHopIp);
    if (mac) {
      this._emit({ type: 'forward', dev: dev.id, iface: egress.name, nextHop: nextHopIp, mac: mac, via: 'arp-cache', vlan: v });
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
    if (out.l4) flowLib.countPacket(this.flowState, dev.id, 'out', out.l4.bytes || 0);
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
    const peerDev = this.topo.getDevice(peer.deviceId);
    if (!peerDev) return;
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
    const mine = dev.interfaceWithMac(f.dstMac);

    // LLDP is sent to the nearest-bridge multicast group, which a bridge must NOT
    // forward: the frame carries one hop and dies. Flooding it would invent
    // neighbours two switches away, so terminate it here and record what announced
    // itself. This is the protocol that answers "what is plugged into this port" on
    // real hardware.
    if (lldp.isLldp(f)) {
      if (dev.lldp && inIface) {
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
      const canTerminate = l3 || dev.isHost();
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
      this._natInbound(dev, frame);
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
      for (const iface of dev.activeInterfaces()) {
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
        for (const iface of dev.activeInterfaces()) {
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
      this._emit({ type: 'drop', reason: 'no usable egress interface', dev: dev.id });
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
        const replyIface = sameGroup ? inIf : owner;
        if (arp.senderIp) dev.arp.set(arp.senderIp, arp.senderMac);
        this._emit({ type: 'arp-reply', dev: dev.id, iface: replyIface.name, targetIp: arp.targetIp, mac: replyIface.mac, vlan: vid });
        this._sendFromOwnIp(dev, replyIface, arpReply(frame, replyIface.mac, owner.ip), vid);
      }
      // else: ignore (not for us)
    } else if (arp.op === 'reply') {
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
      const replyIface = sameGroup4 ? inIf4 : owner;
      this._emit({ type: 'icmp-echo', dev: dev.id, iface: replyIface.name, from: frame.ip.src, seq: icmp.seq, vlan: vid });
      const replyIp = { src: frame.ip.dst, dst: frame.ip.src, ttl: 64, proto: 1, id: icmp.id };
      const replyIcmp = { type: net.ICMP_ECHO_REPLY, code: 0, id: icmp.id, seq: icmp.seq };
      this._emit({ type: 'icmp-reply', dev: dev.id, iface: replyIface.name, to: frame.ip.src, seq: icmp.seq, vlan: vid });
      this._sendFromOwnIp(dev, replyIface, ethFrame(frame.srcMac, replyIface.mac, net.ETH_IPV4, replyIp, replyIcmp, null), vid);
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
    const poe = evs.filter(function (e) { return e.type === 'poe-deny'; })[0];
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
    // then the routing protocols. A flow must see the network a ping sees.
    this.reset();
    this.computeStp();
    this.computePoe();
    this.announceLldp();
    this.announceRa();
    this.computeOspf();
    this.computeBgp();

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

  _natPacket(frame) {
    return {
      srcIp: frame.ip.src, dstIp: frame.ip.dst,
      protocol: frame.l4.proto, srcPort: frame.l4.srcPort, dstPort: frame.l4.dstPort
    };
  }

  // Inside -> outside. Returns 'translate', 'pass' or 'drop'.
  _natOutbound(dev, frame) {
    if (!frame || !frame.l4 || !this._isNat(dev)) return 'pass';
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
    const localIp = frame.ip.src;
    const localPort = frame.l4.srcPort;
    frame.ip = Object.assign({}, frame.ip, { src: res.pkt.srcIp });
    frame.l4 = Object.assign({}, frame.l4, { srcPort: res.pkt.srcPort });
    frame.nat = {
      dir: 'out', type: res.entry ? res.entry.type : null,
      insideLocal: localIp, insideGlobal: res.pkt.srcIp,
      localPort: localPort, globalPort: res.pkt.srcPort
    };
    this._emit({
      type: 'nat-outbound', dev: dev.id, proto: frame.l4.proto,
      insideLocal: localIp, insideGlobal: res.pkt.srcIp,
      localPort: localPort, globalPort: res.pkt.srcPort,
      dst: frame.ip.dst, dstPort: frame.l4.dstPort, flow: frame.flow || null
    });
    return 'translate';
  }

  // Outside -> inside. Returns true when the packet was rewritten.
  _natInbound(dev, frame) {
    if (!frame || !frame.l4 || !this._isNat(dev)) return false;
    const table = this._natTableOf(dev);
    const res = natLib.translateInbound(table, this._natPacket(frame), this.step);
    if (!res || res.action !== 'translate') return false;
    const globalIp = frame.ip.dst;
    const globalPort = frame.l4.dstPort;
    frame.ip = Object.assign({}, frame.ip, { dst: res.pkt.dstIp });
    frame.l4 = Object.assign({}, frame.l4, { dstPort: res.pkt.dstPort });
    frame.nat = {
      dir: 'in', type: res.entry ? res.entry.type : null,
      insideGlobal: globalIp, insideLocal: res.pkt.dstIp,
      globalPort: globalPort, localPort: res.pkt.dstPort
    };
    this._emit({
      type: 'nat-inbound', dev: dev.id, proto: frame.l4.proto,
      insideGlobal: globalIp, insideLocal: res.pkt.dstIp,
      globalPort: globalPort, localPort: res.pkt.dstPort,
      src: frame.ip.src, srcPort: frame.l4.srcPort, flow: frame.flow || null
    });
    return true;
  }
}

module.exports = { Simulator, ethFrame, arpRequest, arpReply, portPvid, speedToCost };
