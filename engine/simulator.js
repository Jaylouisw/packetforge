'use strict';
// simulator.js — event-driven packet simulation (L2 MAC learning, ARP, IPv4 routing, ICMP).
const net = require('./net');

// --- frame builders ---
function ethFrame(dstMac, srcMac, etherType, ip, icmp, arp) {
  return { dstMac: dstMac, srcMac: srcMac, etherType: etherType, ip: ip || null, icmp: icmp || null, arp: arp || null };
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

  // --- send an ICMP packet from a source device toward dstIp ---
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

  // --- send an IP packet out `egress` toward `nextHopIp`, doing ARP if needed ---
  _sendL3(dev, egress, nextHopIp, ip, icmp) {
    const mac = dev.arp.get(nextHopIp);
    if (mac) {
      this._emit({ type: 'forward', dev: dev.id, iface: egress.name, nextHop: nextHopIp, mac: mac, via: 'arp-cache' });
      this._enqueue(dev.id, egress.name, ethFrame(mac, egress.mac, net.ETH_IPV4, ip, icmp, null));
      return;
    }
    // ARP resolution
    this._emit({ type: 'arp-request', dev: dev.id, iface: egress.name, targetIp: nextHopIp });
    this._enqueue(dev.id, egress.name, arpRequest(egress.mac, egress.ip, nextHopIp));
    // stash the pending packet until the ARP reply arrives
    let list = dev.pending.get(nextHopIp);
    if (!list) { list = []; dev.pending.set(nextHopIp, list); }
    list.push({ egress: egress.name, ip: ip, icmp: icmp });
  }

  _flushPending(dev, ip, mac) {
    const list = dev.pending.get(ip);
    if (!list) return;
    dev.pending.delete(ip);
    for (const item of list) {
      const egress = dev.interfaces.get(item.egress);
      if (!egress) continue;
      this._emit({ type: 'forward', dev: dev.id, iface: egress.name, nextHop: ip, mac: mac, via: 'arp-resolved' });
      this._enqueue(dev.id, egress.name, ethFrame(mac, egress.mac, net.ETH_IPV4, item.ip, item.icmp, null));
    }
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

  _processFrame(dev, frame, inIface) {
    // 1. MAC learning
    if (inIface) dev.macTable.set(frame.srcMac, inIface);

    const bcast = net.isBroadcastMac(frame.dstMac);
    const mine = dev.interfaceWithMac(frame.dstMac); // unicast to one of our interfaces

    // Bridge / switch: forward at L2. An L3-capable switch may also terminate
    // frames addressed to its own MAC (routing / management).
    if (dev.isL2()) {
      if (mine && !bcast && dev.hasCap('l3-forward')) {
        if (this._tryProcessL3(dev, frame, inIface)) return;
      }
      this._forwardL2(dev, frame, inIface, bcast);
      return;
    }

    // Host / router / firewall: only act on frames addressed to us (unicast)
    // or broadcast. Routers never flood broadcasts across subnets.
    if (!mine && !bcast) {
      this._emit({ type: 'drop', reason: 'not addressed to this device', dev: dev.id, iface: inIface });
      return;
    }

    this._tryProcessL3(dev, frame, inIface);
  }

  // Attempt to terminate (or route) a frame at L3. Returns true if handled.
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

  _forwardL2(dev, frame, inIface, bcast) {
    const egresses = [];
    if (bcast) {
      for (const iface of dev.activeInterfaces()) if (iface.name !== inIface) egresses.push(iface.name);
    } else {
      const out = dev.macTable.get(frame.dstMac);
      if (out && out !== inIface) egresses.push(out);
      else if (out === inIface) {
        // frame looped back to ingress port -> drop (no STP yet)
        this._emit({ type: 'drop', reason: 'loop: egress equals ingress', dev: dev.id, iface: inIface });
        return;
      } else {
        // unknown unicast -> flood
        for (const iface of dev.activeInterfaces()) if (iface.name !== inIface) egresses.push(iface.name);
      }
    }
    if (!egresses.length) {
      this._emit({ type: 'drop', reason: 'no egress ports', dev: dev.id, iface: inIface });
      return;
    }
    for (const e of egresses) {
      this._emit({ type: 'switch', dev: dev.id, iface: e, action: bcast ? 'flood' : (dev.macTable.has(frame.dstMac) ? 'forward' : 'flood') });
      this._enqueue(dev.id, e, frame);
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
    // Plain routing: preserve the original source IP, decrement TTL, and
    // rewrite only the L2 header. (Source-NAT is a separate future feature.)
    const newIp = { src: frame.ip.src, dst: frame.ip.dst, ttl: frame.ip.ttl, proto: frame.ip.proto, id: frame.ip.id };
    this._sendL3(dev, egress, nextHopIp, newIp, frame.icmp);
  }

  _handleArp(dev, frame, inIface) {
    const arp = frame.arp;
    if (arp.op === 'request') {
      const iface = dev.interfaceWithIp(arp.targetIp);
      if (iface) {
        if (arp.senderIp) dev.arp.set(arp.senderIp, arp.senderMac);
        this._emit({ type: 'arp-reply', dev: dev.id, iface: iface.name, targetIp: arp.targetIp, mac: iface.mac });
        this._enqueue(dev.id, iface.name, arpReply(frame, iface.mac, iface.ip));
      }
      // else: ignore (not for us)
    } else if (arp.op === 'reply') {
      dev.arp.set(arp.senderIp, arp.senderMac);
      this._emit({ type: 'arp-cache', dev: dev.id, ip: arp.senderIp, mac: arp.senderMac });
      this._flushPending(dev, arp.senderIp, arp.senderMac);
    }
  }

  _handleLocalIp(dev, frame, inIface) {
    const icmp = frame.icmp;
    if (!icmp) return;
    if (icmp.type === net.ICMP_ECHO_REQUEST) {
      // The interface that owns the destination IP is the correct reply interface.
      const iface = dev.interfaceWithIp(frame.ip.dst);
      if (!iface) {
        this._emit({ type: 'drop', reason: 'echo for unknown local IP', dev: dev.id });
        return;
      }
      this._emit({ type: 'icmp-echo', dev: dev.id, iface: iface.name, from: frame.ip.src, seq: icmp.seq });
      const replyIp = { src: frame.ip.dst, dst: frame.ip.src, ttl: 64, proto: 1, id: icmp.id };
      const replyIcmp = { type: net.ICMP_ECHO_REPLY, code: 0, id: icmp.id, seq: icmp.seq };
      // reply directly out the ingress interface (we already know the source MAC)
      this._emit({ type: 'icmp-reply', dev: dev.id, iface: iface.name, to: frame.ip.src, seq: icmp.seq });
      this._enqueue(dev.id, iface.name, ethFrame(frame.srcMac, iface.mac, net.ETH_IPV4, replyIp, replyIcmp, null));
    } else if (icmp.type === net.ICMP_ECHO_REPLY) {
      this.icmpReplies.push({ dst: dev.id, id: icmp.id, seq: icmp.seq, step: this.step });
      this._emit({ type: 'icmp-received', dev: dev.id, from: frame.ip.src, seq: icmp.seq });
    }
  }
}

module.exports = { Simulator, ethFrame, arpRequest, arpReply };
