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

    // Router subinterface (802.1Q router-on-a-stick). A subinterface has no
    // link of its own: it borrows its parent's MAC and carries exactly one VLAN.
    this.parent = spec.parent || null;      // physical interface name
    this.encapVid = spec.encapVid || null;  // 802.1Q VLAN id

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

  // A subinterface is virtual: it rides on a parent physical port.
  isSubinterface() { return !!this.parent; }
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
      lags: {},                  // lagId -> { mode, hashPolicy, members: [iface] }
      acls: {},                  // aclNumber -> [ { action, ... } ]
      ospf: null,                // { routerId, areaId, interfaces: [{ name, cost, area, passive }] }
      dnsServers: [],            // upstream resolvers, by IP
      dnsZones: [],              // zones this device is authoritative for
      bgp: null,                 // { as, routerId, neighbors: [{ address, remoteAs }] }
      ip6: {},                   // ifaceName -> { addr, prefix }   (global IPv6 addresses)
      routes6: [],               // [{ dest, prefix, nextHop, iface }]
      gateway6: null             // default IPv6 gateway
    };
    // Routes learned by OSPF (derived, never persisted)
    this.ospfRoutes = [];
    // Routes learned by BGP (derived, never persisted)
    this.bgpRoutes = [];
    // Per-interface ACL bindings: ifaceName -> { in: aclNumber, out: aclNumber }
    this.aclBindings = {};
  }

  interface(name) { return this.interfaces.get(name); }

  // Create (or return) a router subinterface, e.g. Gi0/0.10 for VLAN 10.
  // The physical parent automatically becomes an 802.1Q trunk.
  addSubinterface(parentName, vid) {
    const parent = this.interfaces.get(parentName);
    if (!parent) throw new Error('Unknown parent interface: ' + parentName);
    const name = parentName + '.' + vid;
    const existing = this.interfaces.get(name);
    if (existing) return existing;

    const iface = new Interface(
      { name: name, type: 'subinterface', speed: parent.speed, parent: parentName, encapVid: vid },
      this.interfaces.size,
      {}
    );
    iface.mac = parent.mac;          // subinterfaces borrow the physical MAC
    iface.hardware = parent.hardware; // and its media capabilities
    iface.enabled = parent.enabled;

    const vlanLib = require('./vlan');
    parent.vlan = vlanLib.normalizePortConfig(Object.assign({}, parent.vlan, { mode: 'trunk' }));

    this.interfaces.set(name, iface);
    return iface;
  }

  subinterfacesOf(parentName) {
    return Array.from(this.interfaces.values()).filter(function (i) { return i.parent === parentName; });
  }

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
  // Longest prefix wins; equal-length prefixes are broken by administrative
  // distance (connected 0, static 1, eBGP 20, OSPF 110, iBGP 200, default 254).
  routeTo(dstIp) {
    let best = null;

    function better(prefix, ad) {
      if (!best) return true;
      if (prefix !== best.prefix) return prefix > best.prefix;
      return ad < (best.ad === undefined ? 255 : best.ad);
    }

    // 1. connected subnets
    for (const iface of this.activeInterfaces()) {
      if (iface.ip && iface.mask && net.sameSubnet(dstIp, iface.ip, iface.mask)) {
        const prefix = net.prefixOf(iface.mask);
        if (better(prefix, 0)) {
          best = { iface: iface.name, via: dstIp, type: 'connected', prefix: prefix, ad: 0 };
        }
      }
    }

    // 2. static routes
    for (const r of (this.config.routes || [])) {
      if (net.ipInSubnet(dstIp, r.dest, r.mask)) {
        const prefix = net.prefixOf(r.mask);
        if (better(prefix, 1)) {
          best = {
            iface: r.iface || null,
            via: r.gw || dstIp, // on-link if no gateway given
            type: 'static',
            prefix: prefix,
            ad: 1
          };
        }
      }
    }

    // 3. BGP-learned routes (eBGP 20, iBGP 200)
    for (const r of (this.bgpRoutes || [])) {
      if (net.ipInSubnet(dstIp, r.dest, r.mask)) {
        const prefix = net.prefixOf(r.mask);
        const ad = r.ad || 200;
        if (better(prefix, ad)) {
          best = {
            iface: r.iface || null,
            via: r.nextHop || dstIp,
            type: 'bgp',
            prefix: prefix,
            ad: ad,
            asPath: r.asPath,
            peerAs: r.peerAs
          };
        }
      }
    }

    // 4. OSPF-learned routes
    for (const r of (this.ospfRoutes || [])) {
      if (net.ipInSubnet(dstIp, r.dest, r.mask)) {
        const prefix = net.prefixOf(r.mask);
        if (better(prefix, 110)) {
          best = {
            iface: r.iface || null,
            via: r.nextHop || dstIp,
            type: 'ospf',
            prefix: prefix,
            cost: r.cost,
            ad: 110
          };
        }
      }
    }

    // 5. default gateway (hosts / routers)
    if (!best && this.config.defaultGateway) {
      best = { iface: null, via: this.config.defaultGateway, type: 'default', prefix: 0, ad: 254 };
    }

    return best;
  }

  // --- IPv6 -------------------------------------------------------------

  // Global IPv6 addresses configured on this device.
  ip6Addrs() {
    const out = [];
    const map = this.config.ip6 || {};
    for (const name of Object.keys(map)) {
      const iface = this.interfaces.get(name);
      if (!iface || !iface.enabled) continue;
      out.push({ iface: iface, name: name, addr: map[name].addr, prefix: map[name].prefix });
    }
    return out;
  }

  // Every interface has a link-local address derived from its MAC (EUI-64),
  // exactly as a real IPv6 host does.
  linkLocal6(iface) {
    return require('./ipv6').linkLocalFromMac(iface.mac);
  }

  // Does this device own the given IPv6 address (global or link-local)?
  interfaceWithIp6(addr) {
    for (const e of this.ip6Addrs()) {
      if (e.addr === addr) return e.iface;
    }
    for (const iface of this.activeInterfaces()) {
      if (this.linkLocal6(iface) === addr) return iface;
    }
    return null;
  }

  // IPv6 routing: on-link prefixes, then static routes, then default gateway.
  route6To(dstIp6) {
    const v6 = require('./ipv6');
    let best = null;

    for (const e of this.ip6Addrs()) {
      if (v6.prefixContains6(e.addr + '/' + e.prefix, dstIp6)) {
        best = { iface: e.name, via: dstIp6, type: 'connected', prefix: e.prefix };
      }
    }
    for (const r of (this.config.routes6 || [])) {
      if (v6.prefixContains6(r.dest + '/' + r.prefix, dstIp6)) {
        if (!best || r.prefix > best.prefix) {
          best = { iface: r.iface || null, via: r.nextHop || dstIp6, type: 'static6', prefix: r.prefix };
        }
      }
    }
    if (!best && this.config.gateway6) {
      best = { iface: null, via: this.config.gateway6, type: 'default6', prefix: 0 };
    }
    return best;
  }

  // Egress interface for a next-hop IPv6 address.
  egressFor6(nextHop6) {
    const v6 = require('./ipv6');
    for (const e of this.ip6Addrs()) {
      if (v6.prefixContains6(e.addr + '/' + e.prefix, nextHop6)) return e.iface;
    }
    for (const iface of this.activeInterfaces()) {
      if (this.linkLocal6(iface) === nextHop6) return iface;
    }
    return null;
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
    for (const r of (this.ospfRoutes || [])) {
      rows.push({
        code: 'O', dest: r.dest, mask: r.mask,
        gw: r.nextHop || '-', iface: r.iface || '-', type: 'ospf'
      });
    }
    for (const r of (this.bgpRoutes || [])) {
      rows.push({
        code: 'B', dest: r.dest, mask: r.mask,
        gw: r.nextHop || '-', iface: r.iface || '-', type: 'bgp',
        ad: r.ad, asPath: r.asPath
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
        lags: JSON.parse(JSON.stringify(this.config.lags)),
        acls: JSON.parse(JSON.stringify(this.config.acls)),
        ospf: this.config.ospf ? JSON.parse(JSON.stringify(this.config.ospf)) : null,
        dnsServers: (this.config.dnsServers || []).slice(),
        dnsZones: JSON.parse(JSON.stringify(this.config.dnsZones || [])),
        bgp: this.config.bgp ? JSON.parse(JSON.stringify(this.config.bgp)) : null,
        ip6: JSON.parse(JSON.stringify(this.config.ip6 || {})),
        routes6: JSON.parse(JSON.stringify(this.config.routes6 || [])),
        gateway6: this.config.gateway6 || null
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
          lagId: i.lagId,
          // router subinterface (null for physical ports)
          parent: i.parent || null,
          encapVid: i.encapVid || null
        };
      }),
      // per-interface ACL bindings (acl definitions live in config.acls)
      aclBindings: this.aclBindings || {}
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
        d.config.acls = JSON.parse(JSON.stringify(state.config.acls || {}));
        d.config.ospf = state.config.ospf ? JSON.parse(JSON.stringify(state.config.ospf)) : null;
        d.config.dnsServers = (state.config.dnsServers || []).slice();
        d.config.dnsZones = JSON.parse(JSON.stringify(state.config.dnsZones || []));
        d.config.bgp = state.config.bgp ? JSON.parse(JSON.stringify(state.config.bgp)) : null;
        d.config.ip6 = JSON.parse(JSON.stringify(state.config.ip6 || {}));
        d.config.routes6 = JSON.parse(JSON.stringify(state.config.routes6 || []));
        d.config.gateway6 = state.config.gateway6 || null;
        d.aclBindings = JSON.parse(JSON.stringify(state.aclBindings || {}));
      }
      if (Array.isArray(state.interfaces)) {
        for (const is of state.interfaces) {
          let iface = d.interfaces.get(is.name);
          if (!iface && is.parent && is.encapVid) {
            // subinterfaces are not part of the device spec: recreate them
            try { iface = d.addSubinterface(is.parent, is.encapVid); } catch (e) { iface = null; }
          }
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
