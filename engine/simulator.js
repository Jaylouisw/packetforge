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
const ipv6Lib = require('./ipv6');
const scionLib = require('./scion');

// --- frame builders ---
function ethFrame(dstMac, srcMac, etherType, ip, icmp, arp) {
  return {
    dstMac: dstMac, srcMac: srcMac, etherType: etherType,
    ip: ip || null, icmp: icmp || null, arp: arp || null,
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
  constructor(topology) {
    this.topo = topology;
    this.reset();
  }

  reset() {
    this.events = [];
    this.queue = [];          // pending transmissions: {devId, iface, frame}
    this.step = 0;
    this.maxSteps = 8000;
    this.icmpReplies = [];    // {dst, id, seq, step}
    this.icmp6Replies = [];   // {dst, id, seq, step}  (ICMPv6 echo replies)
    this.scion = null;        // last computed SCION beaconing state
    this._icmpId = 0x1000;
    this._stpDirty = true;
    this.stpResult = null;
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
          return { ok: true, address: addr, server: c.dev.name, rcode: res.rcode, answers: answers };
        }
      }
    }

    return {
      ok: false,
      rcode: dnsLib.RCODE.NXDOMAIN,
      server: candidates.length ? candidates[0].dev.name : null,
      answers: []
    };
  }

  // --- public: run a ping from srcDeviceId to dstIp ---
  ping(srcId, dstIp, opts) {
    opts = opts || {};
    const count = opts.count || 4;
    this.reset();
    // Recompute spanning tree before the run so blocked ports are honoured.
    this.computeStp();
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
        rcode: dnsResult.rcode
      });
      if (!dnsResult.ok) {
        return {
          events: this.events,
          replies: [{ seq: 0, success: false, reason: 'dns-nxdomain' }],
          step: this.step, success: false, resolved: null, dns: dnsResult
        };
      }
      target = dnsResult.address;
    }

    const id = this._icmpId++;
    const replies = [];
    for (let seq = 0; seq < count; seq++) {
      const startStep = this.step;
      this._emit({ type: 'ping', src: srcId, dst: target, seq: seq });
      this._sendIcmp(src, target, { type: net.ICMP_ECHO_REQUEST, code: 0, id: id, seq: seq });
      this._run();
      const got = this.icmpReplies.filter(function (r) {
        return r.dst === srcId && r.id === id && r.seq === seq;
      })[0];
      replies.push({
        seq: seq,
        success: !!got,
        hops: got ? (got.step - startStep) : null,
        rtt: got ? (got.step - startStep) : null
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
    this._stpDirty = false;
    return res;
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
        if (ov && ov.passive) continue;      // advertised but no adjacency
        ifaces.push({
          name: i.name,
          ip: i.ip,
          mask: i.mask,
          cost: (ov && ov.cost) || this._ospfCost(i),
          area: (ov && ov.area !== undefined) ? ov.area : (cfg.areaId || 0)
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
      const seen = Object.create(null);

      for (const [destId, info] of spt.entries()) {
        if (destId === r.id) continue;
        const hopId = (info.path && info.path.length > 1) ? info.path[1] : info.nextHopRouterId;
        const hop = nbr[hopId];
        const dest = byId[destId];
        if (!hop || !dest) continue;         // not reachable over a real adjacency
        for (const di of dest.entry.interfaces) {
          const netAddr = net.intToIp(net.networkOf(di.ip, di.mask));
          const key = netAddr + '/' + di.mask;
          if (seen[key]) continue;
          seen[key] = 1;
          routes.push({
            dest: netAddr,
            mask: di.mask,
            nextHop: hop.ip,
            iface: hop.iface,
            cost: info.cost,
            learnedFrom: hopId
          });
        }
      }

      byId[r.id].dev.ospfRoutes = routes;
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
  computeBgp() {
    const speakers = [];

    for (const dev of this.topo.devices.values()) {
      dev.bgpRoutes = [];
      const cfg = dev.config && dev.config.bgp;
      if (!cfg || !cfg.as) continue;

      const addrs = [];
      for (const i of dev.interfaces.values()) {
        if (!i.enabled || !i.ip || !i.mask) continue;
        addrs.push({ ip: i.ip, mask: i.mask, iface: i.name });
      }
      if (!addrs.length) continue;

      speakers.push({
        dev: dev,
        as: Number(cfg.as),
        routerId: cfg.routerId || addrs[0].ip,
        addrs: addrs,
        neighbors: (cfg.neighbors || []).slice(),
        adj: [],
        cands: Object.create(null),   // prefix -> [candidates]
        best: Object.create(null)     // prefix -> current best candidate
      });
    }

    if (speakers.length < 2) { this.bgpResult = null; this.bgpSessions = 0; return null; }

    // --- sessions: both ends must agree ---
    for (const a of speakers) {
      for (const nb of a.neighbors) {
        let local = null;
        for (const x of a.addrs) {
          if (net.sameSubnet(nb.address, x.ip, x.mask)) { local = x; break; }
        }
        if (!local) continue;                       // neighbour not on a connected subnet

        let b = null;
        for (const s of speakers) {
          if (s === a) continue;
          for (const y of s.addrs) { if (y.ip === nb.address) { b = s; break; } }
          if (b) break;
        }
        if (!b) continue;
        if (Number(nb.remoteAs) !== b.as) continue;  // remote-as does not match the peer

        let back = null;
        for (const n of b.neighbors) { if (n.address === local.ip) { back = n; break; } }
        if (!back || Number(back.remoteAs) !== a.as) continue;   // peer has not configured us

        a.adj.push({
          peer: b,
          peerIp: nb.address,
          localIp: local.ip,
          iface: local.iface,
          type: bgpLib.sessionType(a.as, b.as)
        });
      }
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
            const asPath = adj.type === 'ebgp' ? [a.as].concat(e.asPath) : e.asPath.slice();
            if (!bgpLib.pathIsLoopFree(asPath, adj.peer.as)) continue;
            updates.push({
              to: adj.peer,
              cand: {
                dest: e.dest, mask: e.mask, asPath: asPath,
                origin: e.origin, localPreference: e.localPreference, med: e.med,
                weight: 0, nextHop: adj.localIp,
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
    this.computeOspf();
    this.computeBgp();

    const src = this.topo.getDevice(srcId);
    if (!src) throw new Error('Unknown device: ' + srcId);

    const id = this._icmpId++;
    const replies = [];
    for (let seq = 0; seq < count; seq++) {
      const startStep = this.step;
      this._emit({ type: 'ping6', src: srcId, dst: dstIp6, seq: seq });
      this._sendIcmp6(src, dstIp6, {
        type: ipv6Lib.ICMPV6_TYPES.ECHO_REQUEST, code: 0, id: id, seq: seq
      });
      this._run();
      const got = this.icmp6Replies.filter(function (r) {
        return r.dst === srcId && r.id === id && r.seq === seq;
      })[0];
      replies.push({
        seq: seq,
        success: !!got,
        hops: got ? (got.step - startStep) : null,
        rtt: got ? (got.step - startStep) : null
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
  _aclCheck(dev, ifaceName, dir, frame) {
    const bind = dev.aclBindings && dev.aclBindings[ifaceName];
    if (!bind || bind[dir] == null) return { action: 'permit', acl: null };
    if (frame.etherType !== net.ETH_IPV4 || !frame.ip) return { action: 'permit', acl: bind[dir] };
    const list = (dev.config.acls || {})[String(bind[dir])];
    if (!list || !list.length) return { action: 'permit', acl: bind[dir] };
    const pkt = {
      srcIp: frame.ip.src,
      dstIp: frame.ip.dst,
      protocol: frame.icmp ? 'icmp' : 'ip',
      srcPort: null,
      dstPort: null
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

  _sendL3(dev, egress, nextHopIp, ip, icmp, vid) {
    const v = (vid === undefined || vid === null) ? portPvid(egress) : vid;
    const mac = dev.arp.get(nextHopIp);
    if (mac) {
      this._emit({ type: 'forward', dev: dev.id, iface: egress.name, nextHop: nextHopIp, mac: mac, via: 'arp-cache', vlan: v });
      this._emitFrame(dev, egress, ethFrame(mac, egress.mac, net.ETH_IPV4, ip, icmp, null), v);
      return;
    }
    // ARP resolution
    this._emit({ type: 'arp-request', dev: dev.id, iface: egress.name, targetIp: nextHopIp, vlan: v });
    this._emitFrame(dev, egress, arpRequest(egress.mac, egress.ip, nextHopIp), v);
    // stash the pending packet until the ARP reply arrives
    let list = dev.pending.get(nextHopIp);
    if (!list) { list = []; dev.pending.set(nextHopIp, list); }
    list.push({ egress: egress.name, ip: ip, icmp: icmp, vid: v });
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
      this._emitFrame(dev, egress, ethFrame(mac, egress.mac, net.ETH_IPV4, item.ip, item.icmp, null), v);
    }
  }

  // ---------------------------------------------------------------------
  // Transmission / egress tagging
  // ---------------------------------------------------------------------

  // Apply egress VLAN rules to a frame leaving `iface` in `vid`, then queue it.
  // A subinterface has no link of its own: the frame leaves the parent physical
  // port, tagged with the subinterface's VLAN.
  _emitFrame(dev, iface, frame, vid) {
    if (!iface) return;
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
    this._enqueue(dev.id, port.name, out);
  }

  _enqueue(devId, iface, frame) {
    this.queue.push({ devId: devId, iface: iface, frame: frame });
  }

  _run() {
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

    // 3. MAC learning, scoped to the VLAN.
    if (inIface) dev.macTableFor(vid).set(f.srcMac, inIface);

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
    // Multicast (including the 33:33:xx IPv6 range) must be received and
    // flooded exactly like broadcast, or neighbour discovery never arrives.
    const mcast = net.isMulticastMac(f.dstMac);
    const flood = bcast || mcast;
    const mine = dev.interfaceWithMac(f.dstMac);

    // 4. Bridge / switch: forward at L2. An L3-capable switch may also
    //    terminate frames addressed to its own MAC (routing / management).
    if (dev.isL2()) {
      if (mine && !flood && dev.hasCap('l3-forward')) {
        if (this._tryProcessL3(dev, f, inIface)) return;
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
      if (dev.interfaceWithIp(frame.ip.dst)) { this._handleLocalIp(dev, frame, inIface); return true; }
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
    this._sendL3(dev, egress, nextHopIp, newIp, frame.icmp, portPvid(egress));
  }

  _handleArp(dev, frame, inIface) {
    const arp = frame.arp;
    const vid = frame.vid || 1;
    if (arp.op === 'request') {
      const iface = dev.interfaceWithIp(arp.targetIp);
      if (iface) {
        if (arp.senderIp) dev.arp.set(arp.senderIp, arp.senderMac);
        this._emit({ type: 'arp-reply', dev: dev.id, iface: iface.name, targetIp: arp.targetIp, mac: iface.mac, vlan: vid });
        this._emitFrame(dev, iface, arpReply(frame, iface.mac, iface.ip), vid);
      }
      // else: ignore (not for us)
    } else if (arp.op === 'reply') {
      dev.arp.set(arp.senderIp, arp.senderMac);
      this._emit({ type: 'arp-cache', dev: dev.id, ip: arp.senderIp, mac: arp.senderMac, vlan: vid });
      this._flushPending(dev, arp.senderIp, arp.senderMac, vid);
    }
  }

  _handleLocalIp(dev, frame, inIface) {
    const icmp = frame.icmp;
    if (!icmp) return;
    const vid = frame.vid || 1;
    if (icmp.type === net.ICMP_ECHO_REQUEST) {
      const iface = dev.interfaceWithIp(frame.ip.dst);
      if (!iface) {
        this._emit({ type: 'drop', reason: 'echo for unknown local IP', dev: dev.id });
        return;
      }
      this._emit({ type: 'icmp-echo', dev: dev.id, iface: iface.name, from: frame.ip.src, seq: icmp.seq, vlan: vid });
      const replyIp = { src: frame.ip.dst, dst: frame.ip.src, ttl: 64, proto: 1, id: icmp.id };
      const replyIcmp = { type: net.ICMP_ECHO_REPLY, code: 0, id: icmp.id, seq: icmp.seq };
      this._emit({ type: 'icmp-reply', dev: dev.id, iface: iface.name, to: frame.ip.src, seq: icmp.seq, vlan: vid });
      this._emitFrame(dev, iface, ethFrame(frame.srcMac, iface.mac, net.ETH_IPV4, replyIp, replyIcmp, null), vid);
    } else if (icmp.type === net.ICMP_ECHO_REPLY) {
      this.icmpReplies.push({ dst: dev.id, id: icmp.id, seq: icmp.seq, step: this.step });
      this._emit({ type: 'icmp-received', dev: dev.id, from: frame.ip.src, seq: icmp.seq, vlan: vid });
    }
  }
}

module.exports = { Simulator, ethFrame, arpRequest, arpReply, portPvid, speedToCost };
