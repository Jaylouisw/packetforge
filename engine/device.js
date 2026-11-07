'use strict';
// device.js — Device + Interface model (vendor-agnostic).
const net = require('./net');

class Interface {
  constructor(spec, index) {
    this.name = spec.name;
    this.type = spec.type || 'ethernet';
    this.speed = spec.speed || '1G';
    this.index = index;
    this.mac = null;          // assigned by Topology
    // runtime / configurable state
    this.ip = null;           // dotted-quad or null
    this.mask = null;         // dotted-quad or null
    this.enabled = true;
    this.dhcp = false;
    this.description = '';
    this.peer = null;         // { deviceId, iface }
  }

  get status() { return this.enabled ? 'up' : 'admin down'; }
  get cidr() {
    if (!this.ip || !this.mask) return null;
    return this.ip + '/' + net.prefixOf(this.mask);
  }
}

const CAPABILITIES = [
  'host',         // end device: terminates packets, responds to ARP/ICMP
  'l2-forward',   // bridge/switch: MAC learning + flooding
  'l3-forward',   // router: IP forwarding between subnets
  'cli',          // exposes a management console
  'dhcp-server', 'dhcp-client', 'nat', 'firewall', 'wireless', 'http-server'
];

class Device {
  constructor(id, spec) {
    this.id = id;
    this.spec = spec;
    this.vendor = spec.vendor || 'generic';
    this.model = spec.model || 'device';
    this.label = spec.label || this.model;
    this.category = spec.category || 'generic';
    this.color = spec.color || '#3f7cff';
    this.icon = spec.icon || this.category;
    this.capabilities = (spec.capabilities || []).slice();
    this.name = spec.name || (this.label + '-' + String(id).slice(-4));
    this.hostname = this.name;

    this.interfaces = new Map();
    (spec.interfaces || []).forEach((ifaceSpec, i) => {
      const iface = new Interface(ifaceSpec, i);
      this.interfaces.set(iface.name, iface);
    });

    // runtime forwarding state
    this.macTable = new Map();   // mac -> iface name
    this.arp = new Map();        // ip -> mac
    this.pending = new Map();    // nextHopIp -> [ {egress, frame} ] awaiting ARP

    // persistent configuration
    this.config = {
      hostname: null,
      routes: [],                // { dest, mask, gw, iface }
      defaultGateway: null,
      motd: null
    };
  }

  interface(name) { return this.interfaces.get(name); }

  activeInterfaces() {
    return Array.from(this.interfaces.values()).filter(function (i) { return i.enabled; });
  }

  interfaceWithMac(mac) {
    const m = net.normalizeMac(mac);
    for (const iface of this.interfaces.values()) {
      if (iface.mac && net.normalizeMac(iface.mac) === m) return iface;
    }
    return null;
  }

  interfaceWithIp(ip) {
    for (const iface of this.activeInterfaces()) {
      if (iface.ip === ip) return iface;
    }
    return null;
  }

  hasCap(c) { return this.capabilities.indexOf(c) !== -1; }
  isHost() { return this.hasCap('host'); }
  isL2() { return this.hasCap('l2-forward'); }
  isL3() { return this.hasCap('l3-forward'); }

  // Determine the egress interface + next-hop IP for a destination.
  // Returns { iface, via, type, prefix } or null.
  routeTo(dstIp) {
    let best = null;

    // 1. connected subnets (highest priority, longest prefix)
    for (const iface of this.activeInterfaces()) {
      if (iface.ip && iface.mask && net.sameSubnet(dstIp, iface.ip, iface.mask)) {
        const prefix = net.prefixOf(iface.mask);
        if (!best || prefix > best.prefix) {
          best = { iface: iface.name, via: dstIp, type: 'connected', prefix: prefix };
        }
      }
    }

    // 2. static routes (longest prefix match)
    for (const r of (this.config.routes || [])) {
      if (net.ipInSubnet(dstIp, r.dest, r.mask)) {
        const prefix = net.prefixOf(r.mask);
        if (!best || prefix > best.prefix) {
          best = {
            iface: r.iface || null,
            via: r.gw || dstIp, // on-link if no gateway given
            type: 'static',
            prefix: prefix
          };
        }
      }
    }

    // 3. default gateway (hosts / routers)
    if (!best && this.config.defaultGateway) {
      best = { iface: null, via: this.config.defaultGateway, type: 'default', prefix: 0 };
    }

    return best;
  }

  // Resolve the concrete egress interface when only a gateway IP is known.
  egressFor(nextHopIp) {
    for (const iface of this.activeInterfaces()) {
      if (iface.ip && iface.mask && net.sameSubnet(nextHopIp, iface.ip, iface.mask)) {
        return iface;
      }
    }
    return null;
  }

  // Connected + static routes as display rows.
  routesTable() {
    const rows = [];
    for (const iface of this.activeInterfaces()) {
      if (iface.ip && iface.mask) {
        rows.push({
          code: 'C', dest: net.intToIp(net.networkOf(iface.ip, iface.mask)),
          mask: iface.mask, gw: '-', iface: iface.name, type: 'connected'
        });
      }
    }
    for (const r of (this.config.routes || [])) {
      rows.push({
        code: 'S', dest: r.dest, mask: r.mask,
        gw: r.gw || '-', iface: r.iface || '-', type: 'static'
      });
    }
    if (this.config.defaultGateway) {
      rows.push({ code: 'S', dest: '0.0.0.0', mask: '0.0.0.0', gw: this.config.defaultGateway, iface: '-', type: 'default' });
    }
    return rows;
  }

  serialize() {
    return {
      id: this.id,
      vendor: this.vendor,
      model: this.model,
      label: this.label,
      category: this.category,
      color: this.color,
      icon: this.icon,
      capabilities: this.capabilities,
      name: this.name,
      config: {
        hostname: this.config.hostname,
        defaultGateway: this.config.defaultGateway,
        routes: this.config.routes.slice(),
        motd: this.config.motd
      },
      interfaces: Array.from(this.interfaces.values()).map(function (i) {
        return {
          name: i.name, type: i.type, speed: i.speed,
          ip: i.ip, mask: i.mask, enabled: i.enabled,
          dhcp: i.dhcp, description: i.description
        };
      })
    };
  }

  // Apply a previously serialized device body onto this instance.
  static hydrate(id, spec, state) {
    const d = new Device(id, spec);
    if (state) {
      d.name = state.name || d.name;
      if (state.color) d.color = state.color;
      if (state.icon) d.icon = state.icon;
      if (state.config) {
        d.config.hostname = state.config.hostname || null;
        d.config.defaultGateway = state.config.defaultGateway || null;
        d.config.routes = (state.config.routes || []).slice();
        d.config.motd = state.config.motd || null;
      }
      if (Array.isArray(state.interfaces)) {
        for (const is of state.interfaces) {
          const iface = d.interfaces.get(is.name);
          if (!iface) continue;
          iface.ip = is.ip || null;
          iface.mask = is.mask || null;
          iface.enabled = is.enabled !== false;
          iface.dhcp = !!is.dhcp;
          iface.description = is.description || '';
        }
      }
    }
    return d;
  }
}

module.exports = { Device, Interface, CAPABILITIES };
