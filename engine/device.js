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

    // Combo ports: this interface shares one physical cage position with
    // another. Cabling either half occupies the cage, so the other half cannot
    // be used. Real switches expose the pair as two interfaces exactly like
    // this, and configuring one disables the other.
    this.comboWith = spec.comboWith || null;   // sibling interface name
    this.comboRole = spec.comboRole || null;   // 'rj45' | 'sfp'

    // Port role. Plenty of hardware ships a cage that is either a WAN or a LAN
    // port depending on how you configure it (a consumer router's 10G combo, a
    // firewall's "DMZ or LAN" pair). `dualRole` lists what the port may become and
    // `role` is what it currently is; a port with no dualRole just has a fixed role
    // or none at all.
    this.role = spec.role || null;             // 'wan' | 'lan'
    this.dualRole = spec.dualRole || null;     // e.g. ['wan', 'lan']

    // Bridge group: the ports of an internal switch chip all reach the same L3
    // interface. On a consumer router the eight LAN sockets are one switch, so an
    // address configured on "the LAN" answers on every one of them - it is not
    // eight separate addresses. Ports sharing a group name share an address.
    this.bridgeGroup = spec.bridgeGroup || null;   // e.g. 'lan'

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
    // A PoE budget can come from the spec, from research, from the model name,
    // or be explicitly unknown. An explicit "unknown" must NOT fall through to
    // the name parser: 'ES-24-500W' would otherwise be credited with 500 W of
    // PoE when 500 W is only its PSU rating and no budget is published.
    const mediaLib = require('./media');
    let budget, budgetSource;
    if (spec.poeBudget !== undefined && spec.poeBudget !== null) { budget = spec.poeBudget; budgetSource = 'spec'; }
    else if (spec.poe && spec.poe.budgetW !== undefined && spec.poe.budgetW !== null) { budget = spec.poe.budgetW; budgetSource = 'research'; }
    else if (spec.poe && spec.poe.budgetUnknown) { budget = 0; budgetSource = 'unknown'; }
    else { budget = mediaLib.parsePoeBudget(spec.model) || 0; budgetSource = 'name'; }
    this.poeBudget = budget;
    this.poeBudgetSource = budgetSource;

    // runtime forwarding state
    // VLAN 1 keeps the flat legacy table (also used by `show mac address-table`);
    // other VLANs get their own table because VLANs are separate broadcast domains.
    this.macTable = new Map();   // mac -> iface name (VLAN 1)
    this.macTables = new Map();  // vid -> Map(mac -> iface)
    this.arp = new Map();        // ip -> mac
    // LLDP neighbour table: our port name -> what announced itself on it. This is how
    // real hardware answers "what is plugged in here", and it is filled from frames
    // that actually crossed the link rather than from the topology file.
    this.lldp = new Map();
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
      gateway6: null,            // default IPv6 gateway
      scionAs: null              // SCION ISD-AS membership, e.g. '1-ff00:0:110'
    };
    // Routes learned by OSPF (derived, never persisted)
    this.ospfRoutes = [];
    // Routes learned by BGP (derived, never persisted)
    this.bgpRoutes = [];
    // Per-interface ACL bindings: ifaceName -> { in: aclNumber, out: aclNumber }
    this.aclBindings = {};

    // A budget parsed out of the model name is a guess, and a guess only means
    // something if the device can actually source power. 'AR651W-8P' parses to
    // 651 W but is a router with no PoE-out ports at all, so the guess is
    // discarded. Research-sourced figures are kept even if they look odd - a
    // contradiction there is a data bug for a human to see, not to hide.
    if (this.poeBudgetSource === 'name') {
      let sources = false;
      for (const i of this.interfaces.values()) {
        if (i.hardware && i.hardware.poeOut) { sources = true; break; }
      }
      if (!sources) this.poeBudget = 0;
    }
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

  // Which interface answers for an address, seen from the port a frame arrived on.
  //
  // An address lives on exactly one interface, but an internal switch chip means it
  // is reachable from every port in that bridge group - the eight LAN sockets of a
  // router are one broadcast domain with one router address, not eight. So a reply
  // must leave by the port the request came in on, otherwise a host on lan3 never
  // hears back from an address configured on lan1.
  // Callers pass either an Interface or a port name depending on the layer, so
  // resolve both rather than making every call site remember which it holds.
  resolveIface(x) {
    if (!x) return null;
    if (typeof x === 'string') return this.interfaces.get(x) || null;
    if (x.name && this.interfaces.has(x.name)) return this.interfaces.get(x.name);
    return null;
  }

  ownsIpOn(incomingIface, ip) {
    const owner = this.interfaceWithIp(ip);
    if (!owner) return null;
    const inIface = this.resolveIface(incomingIface);
    if (!inIface || owner.name === inIface.name) return owner;

    // Router-on-a-stick: the address lives on a tagged subinterface, and the frames
    // that reach it arrive on that subinterface's parent port.
    if (owner.parent && owner.parent === inIface.name) return owner;

    // WAN and LAN are separate L3 surfaces. A router's LAN address is not reachable
    // from its WAN port - that is what NAT is for - so role separation outranks the
    // VLAN shortcut below.
    if (owner.role && inIface.role && owner.role !== inIface.role) return null;

    // A switch's management address belongs to a VLAN, not to a socket, so any port
    // in that same access VLAN can reach it. Scoped to access ports on both sides:
    // a router subinterface is a tagged logical interface, and answering a tagged
    // frame from an untagged port (or vice versa) would put traffic on the wrong VLAN
    // entirely, which is worse than being unreachable.
    const bothPhysical = !owner.parent && !inIface.parent;
    const ownerAccess = owner.vlan && owner.vlan.mode !== 'trunk';
    const inAccess = inIface.vlan && inIface.vlan.mode !== 'trunk';
    if (bothPhysical && ownerAccess && inAccess &&
        typeof this.isL2 === 'function' && this.isL2()) {
      const ov = Number(owner.vlan && owner.vlan.accessVlan) || 1;
      const iv = Number(inIface.vlan && inIface.vlan.accessVlan) || 1;
      if (ov === iv) return owner;
    }

    // A router's LAN sockets are one switch chip with one address: every port in the
    // group reaches it, and a reply leaves by the port that asked.
    if (owner.bridgeGroup && inIface.bridgeGroup &&
        owner.bridgeGroup === inIface.bridgeGroup) {
      return owner;
    }
    return null;
  }

  // The interface that represents a bridge group for configuration purposes: the
  // first member, so "the LAN address" has one obvious home.
  bridgeGroupRep(group) {
    for (const iface of this.interfaces.values()) {
      if (iface.bridgeGroup === group) return iface;
    }
    return null;
  }


  hasCap(c) { return this.capabilities.indexOf(c) !== -1; }
  isHost() { return this.hasCap('host'); }
  isL2() { return this.hasCap('l2-forward'); }
  // A passive optical splitter has no MAC table, no power and no configuration.
  // It is a coupler: whatever arrives on one leg leaves on every other leg, in
  // both directions. Modelling it as a switch would be wrong - a switch learns
  // and filters, a splitter cannot.
  isSplitter() { return String(this.spec.category || '') === 'splitter'; }
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
    // The interface map below runs in a callback, so the device reference has to be
    // captured: `this` is not the device inside it.
    const self = this;
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
        gateway6: this.config.gateway6 || null,
        scionAs: this.config.scionAs || null
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
          // port role: a dual-purpose cage can be WAN or LAN, and a bridge group
          // tells the UI which ports share one switch chip and therefore one address
          role: i.role || null,
          dualRole: i.dualRole || null,
          bridgeGroup: i.bridgeGroup || null,
          // What announced itself on this port, learned from an LLDP frame that
          // actually crossed the link. null until something is cabled and speaks.
          lldp: self.lldp.get(i.name) || null,
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
        d.config.scionAs = state.config.scionAs || null;
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
          if (is.role !== undefined) iface.role = is.role || null;
          if (is.dualRole !== undefined) iface.dualRole = is.dualRole || null;
          if (is.bridgeGroup !== undefined) iface.bridgeGroup = is.bridgeGroup || null;
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
