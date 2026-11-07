'use strict';
// device.js -- Device + Interface model (vendor-agnostic).
const net = require('./net');
const media = require('./media');

class Interface {
  constructor(spec, index, deviceSpec) {
    this.name = spec.name;
    this.type = spec.type || 'ethernet';
    this.speed = spec.speed || '1G';
    this.index = index;
    this.mac = null;          // assigned by Topology

    // Physical hardware: cage, supported media, speed caps, PoE.
    // Derived from the terse spec (name/type/speed) unless the spec overrides.
    this.hardware = media.derivePortHardware(spec, deviceSpec || {});

    // runtime / configurable state
    this.ip = null;           // dotted-quad or null
    this.mask = null;         // dotted-quad or null
    this.enabled = true;
    this.dhcp = false;
    this.description = '';
    this.peer = null;         // { deviceId, iface }

    // L2 configuration (802.1Q)
    this.vlan = {
      mode: 'access',         // 'access' | 'trunk'
      accessVlan: 1,
      nativeVlan: 1,
      allowedVlans: 'all'     // 'all' | array of VLAN ids
    };
    this.lagId = null;        // LAG (link aggregation) group this port belongs to
    this.duplex = 'full';
    this.mtu = 1500;
  }

  // Convenience accessors over the derived hardware block.
  get cage() { return this.hardware.cage; }
  get supportedMedia() { return this.hardware.media; }
  get speedCaps() { return this.hardware.speedCaps; }
  get poeOut() { return this.hardware.poeOut; }
  get poeIn() { return this.hardware.poeIn; }

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
  'dhcp-server', 'dhcp-client', 'nat', 'firewall', 'wireless', 'http-server',
  // physical / L2 feature tokens
  'poe-pse',      // can source PoE
  'poe-pd',       // is powered by PoE
  'vlan',         // supports 802.1Q
  'lacp',         // supports link aggregation
  'stp'           // participates in spanning tree
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
      const iface = new Interface(ifaceSpec, i, spec);
      this.interfaces.set(iface.name, iface);
    });

    // PoE budget on the PSE side, in watts. 0 = does not source PoE.
    this.poeBudget = spec.poeBudget || (spec.poe && spec.poe.budgetW) || 0;

    // runtime forwarding state
    // VLAN 1 keeps the flat legacy table (also used by `show mac address-table`);
    // other VLANs get their own table because VLANs are separate broadcast domains.
    this.macTable = new Map();   // mac -> iface name (VLAN 1)
    this.macTables = new Map();  // vid -> Map(mac -> iface)
    this.arp = new Map();        // ip -> mac
    this.pending = new Map();    // nextHopIp -> [ {egress, frame} ] awaiting ARP

    // STP state, populated by Simulator.computeStp()
    this.stp = { blocked: new Set(), states: {}, roles: {} };

    // persistent configuration
    this.config = {
      hostname: null,
      routes: [],                // { dest, mask, gw, iface }
      defaultGateway: null,
      motd: null,
      vlans: {},                 // vid -> { name }
      lags: {}                   // lagId -> { mode, hashPolicy, members: [iface] }
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

  // MAC table for a given VLAN (VLAN 1 keeps the legacy flat map).
  macTableFor(vid) {
    const v = Number(vid) || 1;
    if (v === 1) return this.macTable;
    let m = this.macTables.get(v);
    if (!m) { m = new Map(); this.macTables.set(v, m); }
    return m;
  }

  // The LAG group a port belongs to, or null.
  lagFor(ifaceName) {
    const lags = this.config.lags || {};
    for (const id of Object.keys(lags)) {
      const lag = lags[id] || {};
      if ((lag.members || []).indexOf(ifaceName) !== -1) {
        return { id: id, mode: lag.mode, hashPolicy: lag.hashPolicy, members: lag.members };
      }
    }
    return null;
  }

  // Total PoE draw currently sourced by this device (watts).
  poeDraw() {
    let w = 0;
    for (const iface of this.interfaces.values()) {
      if (!iface.peer) continue;
      if (!iface.poeOut) continue;
      w += iface.poeOut;
    }
    return w;
  }

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
      poeBudget: this.poeBudget,
      config: {
        hostname: this.config.hostname,
        defaultGateway: this.config.defaultGateway,
        routes: this.config.routes.slice(),
        motd: this.config.motd,
        vlans: Object.assign({}, this.config.vlans),
        lags: JSON.parse(JSON.stringify(this.config.lags))
      },
      interfaces: Array.from(this.interfaces.values()).map(function (i) {
        return {
          name: i.name, type: i.type, speed: i.speed,
          ip: i.ip, mask: i.mask, enabled: i.enabled,
          dhcp: i.dhcp, description: i.description,
          // physical hardware (so the UI can render cages/media without re-deriving)
          cage: i.hardware.cage,
          media: i.hardware.media,
          speedCaps: i.hardware.speedCaps,
          poeOut: i.hardware.poeOut,
          poeIn: i.hardware.poeIn,
          duplex: i.duplex,
          vlan: {
            mode: i.vlan.mode,
            accessVlan: i.vlan.accessVlan,
            nativeVlan: i.vlan.nativeVlan,
            allowedVlans: i.vlan.allowedVlans
          },
          lagId: i.lagId
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
      if (state.poeBudget !== undefined) d.poeBudget = state.poeBudget || 0;
      if (state.config) {
        d.config.hostname = state.config.hostname || null;
        d.config.defaultGateway = state.config.defaultGateway || null;
        d.config.routes = (state.config.routes || []).slice();
        d.config.motd = state.config.motd || null;
        d.config.vlans = Object.assign({}, state.config.vlans || {});
        d.config.lags = JSON.parse(JSON.stringify(state.config.lags || {}));
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
          if (is.duplex) iface.duplex = is.duplex;
          if (is.lagId !== undefined) iface.lagId = is.lagId || null;
          if (is.vlan && typeof is.vlan === 'object') {
            iface.vlan = {
              mode: is.vlan.mode === 'trunk' ? 'trunk' : 'access',
              accessVlan: Number(is.vlan.accessVlan) || 1,
              nativeVlan: Number(is.vlan.nativeVlan) || 1,
              allowedVlans: is.vlan.allowedVlans === undefined ? 'all' : is.vlan.allowedVlans
            };
          }
        }
      }
    }
    return d;
  }
}

module.exports = { Device, Interface, CAPABILITIES };
