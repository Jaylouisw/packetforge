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
    this._icmpId = 0x1000;
    this._stpDirty = true;
    this.stpResult = null;
  }

  _emit(ev) {
    ev.step = this.step;
    this.events.push(ev);
    return ev;
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
    const src = this.topo.getDevice(srcId);
    if (!src) throw new Error('Unknown device: ' + srcId);

    const id = this._icmpId++;
    const replies = [];
    for (let seq = 0; seq < count; seq++) {
      const startStep = this.step;
      this._emit({ type: 'ping', src: srcId, dst: dstIp, seq: seq });
      this._sendIcmp(src, dstIp, { type: net.ICMP_ECHO_REQUEST, code: 0, id: id, seq: seq });
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
    return { events: this.events, replies: replies, step: this.step, success: replies.some(function (r) { return r.success; }) };
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
    const mine = dev.interfaceWithMac(f.dstMac);

    // 4. Bridge / switch: forward at L2. An L3-capable switch may also
    //    terminate frames addressed to its own MAC (routing / management).
    if (dev.isL2()) {
      if (mine && !bcast && dev.hasCap('l3-forward')) {
        if (this._tryProcessL3(dev, f, inIface)) return;
      }
      this._forwardL2(dev, f, inIface, bcast, vid);
      return;
    }

    // 5. Host / router / firewall: only act on frames addressed to us or broadcast.
    if (!mine && !bcast) {
      this._emit({ type: 'drop', reason: 'not addressed to this device', dev: dev.id, iface: inIface });
      return;
    }

    this._tryProcessL3(dev, f, inIface);
  }

  _tryProcessL3(dev, frame, inIface) {
    if (frame.etherType === net.ETH_ARP) { this._handleArp(dev, frame, inIface); return true; }
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
