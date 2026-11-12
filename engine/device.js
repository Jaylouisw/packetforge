'use strict';

// How long a dynamically learned MAC survives silence, in milliseconds. 300 s is the usual switch default and the
// number `show mac address-table` implies when it prints an age. Named here because the table's writer, its
// reader and its reporter all have to agree on it (#1395).
const MAC_AGE_MS = 300000;

// How long a dynamic ARP entry survives silence, in milliseconds: 4 hours, which is the IOS default
// (`arp timeout 14400`) and the number the `Age (min)` column is a count of. The comment on `arpRows()` used to
// say the age could not be modelled because "the simulator has steps, not minutes" - that stopped being true
// when convergence gave the model an instant in milliseconds (#1397).
const ARP_AGE_MS = 14400000;
// device.js -- Device + Interface model (vendor-agnostic).
const net = require('./net');
const { resolvePortName } = require('./iface-name');
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
    this.mask = null;         // dotted-quad mask or null
    this.enabled = true;
    this.dhcp = false;
    // 'ipv6 address autoconfig': this interface asks a router for its address
    // instead of being given one. Separate from `dhcp` because it is a different
    // protocol with a different failure mode (no router = no address, quietly).
    this.autoconfig = false;
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
    // Which side of a NAT translation this port is on: 'inside' | 'outside' | null. Set by
    // `ip nat inside` / `ip nat outside` (#1391).
    this.natRole = spec.natRole || null;
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
    // A rate forced by configuration (`speed 100`), in Mbps, or null for auto-negotiation. The validator
    // has modelled a duplex mismatch since the beginning and nothing could ever set duplex, so the rule
    // was unreachable; both live here now and both are read by validateLink (#1259).
    this.speedMbps = null;
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

// The physical facts a device was built from, minus the ones the document already states at the top level.
//
// They are not decoration. The optical budget reads `splitRatio` and `ponClass`, `isPassive()` reads `passive`, and
// the passive layer reads `insertionLossDb`. A device rebuilt from a hand-picked handful of keys came back looking
// like a plain box: a 1:32 splitter loaded as if it split nothing, so the budget rule for a 60 km run went quiet
// instead of refusing it (#1459).
const SPEC_FACTS_KEPT_ELSEWHERE = {
  // Stated at the top level of the document already.
  vendor: true, model: true, label: true, category: true, capabilities: true, color: true, icon: true,
  // Saved port by port, or the template the ports were expanded from - which is the ports.
  interfaces: true, portTemplate: true,
  // Catalogue prose and search aids: not facts about this lab.
  description: true, notes: true, sourceUrl: true, aliases: true,
  // Where the port split came from, as prose about our confidence in a datasheet.
  portSplitNote: true
};

function specFacts(spec) {
  const out = {};
  if (!spec) return out;
  for (const key of Object.keys(spec)) {
    if (SPEC_FACTS_KEPT_ELSEWHERE[key]) continue;
    const value = spec[key];
    if (value === undefined || value === null) continue;
    out[key] = (typeof value === 'object') ? JSON.parse(JSON.stringify(value)) : value;
  }
  return out;
}

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
    // A dynamic entry is `{ port, atMs }`: where it was seen and when. A bare port name is still accepted
    // everywhere (it means "no timestamp"), because a fixture or an imported lab may write one (#1395).
    this.macTable = new Map();   // mac -> { port, atMs } (VLAN 1)
    this.macTables = new Map();  // vid -> Map(mac -> { port, atMs })
    this.arp = new Map();        // ip -> mac
    // ip -> when the box last heard this neighbour. Kept beside the map rather than inside it so `arp` stays
    // ip -> mac for every reader and fixture that has ever written one (#1397).
    this.arpSeenAt = new Map();
    // Which port a neighbour was learned on (#1253). `show arp` prints an Interface column, and without
    // this the column was a header over nothing: the one field that tells you where to look when a
    // neighbour answers but traffic still dies.
    this.arpPorts = new Map();   // ip -> port name (null when the entry came from somewhere else)
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
      // VRRP groups, one entry per vrid per interface:
      // { vrid, interface, ips: [], priority, preempt, advertSec }
      vrrp: [],
      dnsServers: [],            // upstream resolvers, by IP
      dnsZones: [],              // zones this device is authoritative for
      bgp: null,                 // { as, routerId, neighbors: [{ address, remoteAs }] }
      ip6: {},                   // ifaceName -> { addr, prefix }   (global IPv6 addresses)
      routes6: [],               // [{ dest, prefix, nextHop, iface }]
      gateway6: null,            // default IPv6 gateway
      // A link-local default gateway only means something together with the
      // interface it was heard on: fe80:: is on-link everywhere, so without this
      // the route resolves to no egress at all. Filled in by an RA.
      gateway6Iface: null,
      // Router advertisement policy: { enabled, suppress, m, o, prefixes[] }.
      // null until the device is told to advertise anything, which is why no
      // existing lab suddenly starts emitting RAs.
      ra: null,
      scionAs: null,
      // Bridge priority for the spanning-tree root election: 0..61440 in 4096 steps, lower wins.
      // `computeStp()` has read this since STP was modelled, and nothing ever wrote it - a switch's
      // bridge priority was fixed at the default and no command could change it (#1364).
      stpPriority: null,
      // { rules: [...], pools: { name: { start, end, netmask } } } - the shape Simulator._natTableOf reads.
      nat: { rules: [], pools: {} }              // SCION ISD-AS membership, e.g. '1-ff00:0:110'
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

  // Learn a neighbour, remembering the port it was heard on. Kept as one entry point so the port cannot be
  // forgotten at one call site and remembered at another.
  learnArp(ip, mac, portName, atMs) {
    if (!ip || !mac) return null;
    this.arp.set(ip, mac);
    let name = null;
    if (portName) {
      const port = this.resolveIface(portName);
      name = port ? port.name : String(portName);
    }
    if (!this.arpPorts) this.arpPorts = new Map();
    this.arpPorts.set(ip, name);
    // When the box last heard from this neighbour, so the entry can age. A caller that does not know the instant
    // writes nothing here, and an entry nothing dated is never aged (#1397).
    if (!this.arpSeenAt) this.arpSeenAt = new Map();
    if (Number.isFinite(atMs)) this.arpSeenAt.set(ip, atMs); else this.arpSeenAt.delete(ip);
    return name;
  }

  // The neighbour's hardware address, at an instant. An entry older than ARP_AGE_MS is not there at all: a host
  // that moved would otherwise be sent frames at an address it no longer answers to. Real behaviour is to ARP
  // again, which is what a null answer causes (#1397).
  arpLookup(ip, nowMs) {
    if (!this.arp) return null;
    const mac = this.arp.get(ip);
    if (mac === undefined || mac === null) return null;
    const at = this.arpSeenAt ? this.arpSeenAt.get(ip) : undefined;
    if (Number.isFinite(at) && Number.isFinite(nowMs) && (nowMs - at) > ARP_AGE_MS) return null;
    return mac;
  }

  // Every neighbour older than the age is gone, from the address and from where and when it was heard.
  ageArps(nowMs) {
    if (!Number.isFinite(nowMs) || !this.arp) return 0;
    let dropped = 0;
    for (const ip of [...this.arp.keys()]) {
      const at = this.arpSeenAt ? this.arpSeenAt.get(ip) : undefined;
      if (Number.isFinite(at) && (nowMs - at) > ARP_AGE_MS) {
        this.arp.delete(ip);
        this.arpSeenAt.delete(ip);
        if (this.arpPorts) this.arpPorts.delete(ip);
        dropped++;
      }
    }
    return dropped;
  }

  activeInterfaces() {
    return Array.from(this.interfaces.values()).filter(function (i) { return i.enabled; });
  }

  // Can this port actually carry a frame, and if not, why not (#1237)?
  //
  // The CLI used to answer "is it shut down" and call that the status, so a port with no cable - the
  // commonest reason a lab does not work - reported up/up in the table people paste into bug reports.
  // `topo` is optional on purpose: a device that was never put in a topology has no cables to report
  // on, and inventing "down" for every port of a bare device would be a different lie.
  ifaceStatus(iface, topo) {
    const port = typeof iface === 'string' ? this.interfaces.get(iface) : iface;
    if (!port) return { status: 'down', protocol: 'down', reason: 'no such port' };
    if (!port.enabled) return { status: 'administratively down', protocol: 'down', reason: 'shut down' };
    if (!topo) return { status: 'up', protocol: 'up', reason: null };
    // A wireless radio has no cable to miss; its link is the radio.
    if (port.type === 'wireless' || (port.hardware && port.hardware.cage === 'antenna')) {
      return { status: 'up', protocol: 'up', reason: null };
    }
    if (!port.peer) return { status: 'down', protocol: 'down', reason: 'no cable' };
    const peerDev = topo.getDevice ? topo.getDevice(port.peer.deviceId) : null;
    const peerPort = peerDev && peerDev.interfaces.get(port.peer.iface);
    if (!peerDev || !peerPort) return { status: 'down', protocol: 'down', reason: 'peer missing' };
    // A cable can be patched and still be down - `link down` pulls it without deleting it, and the
    // simulator will not carry a frame across it. The ports stay plugged, so this is not "no cable"
    // and reporting the port as up would send the operator hunting for a routing fault (#1238).
    if (topo.linksFor) {
      const devId = this.id;
      const cut = topo.linksFor(devId).filter(function (l) {
        if (!l || l.state !== 'down') return false;
        return (l.a.deviceId === devId && l.a.iface === port.name) ||
               (l.b.deviceId === devId && l.b.iface === port.name);
      })[0];
      if (cut) return { status: 'down', protocol: 'down', reason: 'link down' };
    }
    if (!peerPort.enabled) return { status: 'down', protocol: 'down', reason: 'peer shut down' };
    return { status: 'up', protocol: 'up', reason: null };
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
  // Accepts an Interface, a panel spelling, or a console spelling ("ether1" for "eth1"), because the
  // engine and the CLI must agree on what a port is called (#1247). Exact names are tried first, so this
  // cannot rename anything; a name that matches nothing, or matches two ports, resolves to null rather
  // than a guess.
  resolveIface(x) {
    if (!x) return null;
    if (typeof x === 'object') {
      if (x.name && this.interfaces.has(x.name)) return this.interfaces.get(x.name);
      return null;
    }
    const typed = String(x);
    const exact = this.interfaces.get(typed);
    if (exact) return exact;
    const name = resolvePortName(this, typed);
    return name ? this.interfaces.get(name) || null : null;
  }

  ownsIpOn(incomingIface, ip) {
    const owner = this.interfaceWithIp(ip);
    if (!owner) {
      // Not a configured address - but the group may hold it. A master that does not answer for
      // its own VIP is a router that forwards a packet addressed to itself.
      const claim = this.vrrpClaimFor(ip, incomingIface);
      if (claim) {
        const held = this.interfaces.get(claim.iface);
        if (held) return held;
      }
      return null;
    }
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

    // Nothing above said no, and this is an L3 device: a router has ONE IP stack, so any
    // address it holds is its own whichever port the frame arrives on. Before this rule the
    // function returned null here and the frame was forwarded - so a packet addressed to a
    // router's far-side address was decremented and, at TTL 1, died of time-exceeded instead
    // of being delivered. A host could not ping the other side of its own gateway, and
    // traceroute to a far-side address of the first hop timed out.
    //
    // The checks above still outrank this one, which is what keeps the two cases that are
    // genuinely interface-scoped: WAN/LAN role separation (a LAN address is not served on
    // the WAN port - that is what NAT is for) and L2 isolation on a switch (an address in
    // VLAN 20 is not answered from a port in VLAN 10). A pure switch stays unscoped-L3-free.
    const routes = this.hasCap('route') || this.hasCap('router') || !this.isL2();
    if (routes) return owner;
    return null;
  }


  // ---------------------------------------------------------------------------
  // VRRP ownership
  // ---------------------------------------------------------------------------
  //
  // A virtual address is not configured on an interface, so interfaceWithIp() cannot find it. The
  // master holds it on behalf of the group, and everything that asks "is this address mine?"
  // - ARP, ICMP, the TTL path - has to get the same answer, or a ping to the VIP is forwarded and
  // dies three hops later instead of being answered by the router sitting right there.

  // Called by Simulator.computeVrrp() on the elected master only.
  claimVrrp(claim) {
    if (!Array.isArray(this.vrrpClaims)) this.vrrpClaims = [];
    this.vrrpClaims = this.vrrpClaims.filter(function (c) {
      return !(c.vrid === claim.vrid && c.iface === claim.iface);
    });
    this.vrrpClaims.push({
      vrid: claim.vrid, iface: claim.iface,
      ips: (claim.ips || []).slice(), mac: claim.mac || null
    });
    return this.vrrpClaims;
  }

  clearVrrp() {
    this.vrrpClaims = [];
    return this;
  }

  // The claim covering this address on this interface, or null.
  vrrpClaimFor(ip, ifaceName) {
    const claims = this.vrrpClaims || [];
    const inName = ifaceName ? this.resolveIface(ifaceName) : null;
    const inPort = inName ? inName.name : null;
    for (const c of claims) {
      if (c.ips.indexOf(ip) === -1) continue;
      if (inPort && c.iface !== inPort) {
        // A subinterface's claim is reachable from its parent port, the same rule ownsIpOn() uses.
        const owner = this.interfaces.get(c.iface);
        if (!(owner && owner.parent === inPort)) continue;
      }
      return c;
    }
    return null;
  }

  // The MAC this device puts on the wire when it answers for an address: the group's virtual MAC
  // for a VIP, the interface's own otherwise. A host that caches the wrong one black-holes the
  // moment mastership moves, which is the entire reason VRRP has a virtual MAC.
  macForIp(ip, ifaceName) {
    const claim = this.vrrpClaimFor(ip, ifaceName);
    if (claim && claim.mac) return claim.mac;
    const owner = this.interfaceWithIp(ip);
    return owner ? owner.mac : null;
  }

  // Does this device hold the address at all, on any interface? This is the stack-ownership question, as
  // opposed to ownsIpOn()'s "will I serve it on this interface". Deliverability is the second question;
  // forwarding has to ask the first one first, or it decrements the TTL of a packet that was addressed
  // to the router itself (#1223).
  holdsIp(ip) {
    return this.interfaceWithIp(ip) || null;
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

  // A tap is a one-way street with a copy: network ports pass the link's traffic
  // through untouched, monitor ports receive a duplicate and can never transmit back.
  // A passive tap has no software stack at all, so it cannot learn, filter or tag.
  isTap() { return String(this.spec.category || '') === 'tap'; }
  isPassiveTap() {
    if (!this.isTap()) return false;
    if (this.spec.passive === true) return true;
    return (this.spec.capabilities || []).length === 0;
  }
  isL3() { return this.hasCap('l3-forward'); }

  // MAC table for a given VLAN (VLAN 1 keeps the legacy flat map).
  // -- What the tables say ------------------------------------------------------------------------------
  //
  // The console has printed these rows since #1253-#1255: which port a MAC or a neighbour was learned on, and
  // whether that port can still carry a frame. The state payload published the raw maps instead - `mac` ->
  // `"1/1/1"`, `{"10.0.0.2": "02:.."}` - so a client was told an entry existed but not that it was stale, and
  // LLDP was not published at all. Same fault as the Routes table in #1300: the fact is computed in one place
  // (here) and read by every surface, so the sentences cannot drift.

  // "Is this port still somewhere a frame can go, and if not why" - the sentence every table appends to a row
  // whose port can no longer carry. `extra` is an additional reason that outranks the port state (`vlan mismatch`).
  portCarrierNote(port, topo, extra) {
    if (!port) return extra || '(gone)';
    const link = this.ifaceStatus(port, topo);
    if (link.status === 'up') return extra || '';
    // `administratively down` already says who did it; "shut down" after it would be the same fact twice.
    const why = (!link.reason || link.reason === 'shut down' || link.reason === link.status)
      ? link.status : link.status + ': ' + link.reason;
    return '(' + why + ')';
  }

  // `show mac address-table`, as data: every entry, the VLAN it belongs to, the port it points at, and the note
  // explaining why that port cannot be the way to it.
  macRows(topo, nowMs) {
    const vlanLib = require('./vlan');
    // The rows are the rows at the instant asked. No instant means no ageing, which is what every caller got
    // before the table had timestamps (#1395).
    if (Number.isFinite(nowMs)) this.ageMacs(nowMs);
    const rows = [];
    const collect = function (vid, table) {
      for (const [mac, where] of table.entries()) {
        const at = (where && typeof where === 'object') ? where.atMs : null;
        rows.push({ vlan: vid, mac: mac, port: (where && typeof where === 'object') ? where.port : where, atMs: at });
      }
    };
    collect(1, this.macTable);
    for (const [vid, table] of (this.macTables || new Map()).entries()) {
      if (Number(vid) === 1) continue;
      collect(vid, table);
    }
    rows.sort(function (a, b) { return (a.vlan - b.vlan) || String(a.mac).localeCompare(String(b.mac)); });
    return rows.map(function (r) {
      const port = (r.port && typeof r.port === 'object') ? r.port : this.resolveIface(r.port);
      const name = port ? port.name : String(r.port);
      // A port that no longer carries this VLAN cannot be the way to a MAC in it, even while the port itself is
      // up: moving a port between VLANs is exactly how that happens (#1255).
      const mismatch = (port && vlanLib.classifyEgress(port.vlan, r.vlan).action === 'drop') ? '(vlan mismatch)' : '';
      // Seconds since the switch heard from this address, or null when nothing recorded when it did.
      const ageSec = (Number.isFinite(r.atMs) && Number.isFinite(nowMs))
        ? Math.max(0, Math.floor((nowMs - r.atMs) / 1000))
        : null;
      return { vlan: r.vlan, mac: r.mac, port: name, age: ageSec, note: this.portCarrierNote(port, topo, mismatch) };
    }, this);
  }

  // `show arp`, as data: the neighbour, the port it was learned on, and whether that port still carries.
  arpRows(topo, nowMs) {
    // The rows are the rows at the instant asked. No instant means no ageing, which is what every caller got
    // before the table carried timestamps (#1397).
    if (Number.isFinite(nowMs)) this.ageArps(nowMs);
    const rows = [];
    for (const [ip, mac] of this.arp.entries()) {
      const portName = (this.arpPorts && this.arpPorts.get(ip)) || null;
      let port = '-';
      let note = '';
      if (portName) {
        const iface = this.resolveIface(portName);
        if (!iface) { port = portName; note = '(gone)'; }
        else {
          port = iface.name;
          // The reason travels with the status: "down" alone sends you looking for a cable when the cable is
          // fine and the far port is shut (#1253).
          note = this.portCarrierNote(iface, topo);
        }
      }
      // Minutes since this neighbour was last heard, or null when nothing recorded when it was: a fixture's entry
      // has no age, and inventing one would be worse than saying nothing (#1397).
      const at = this.arpSeenAt ? this.arpSeenAt.get(ip) : undefined;
      const age = (Number.isFinite(at) && Number.isFinite(nowMs)) ? Math.max(0, Math.floor((nowMs - at) / 60000)) : null;
      rows.push({ ip: ip, mac: mac, port: port, age: age, note: note });
    }
    rows.sort(function (a, b) { return String(a.ip).localeCompare(String(b.ip)); });
    return rows;
  }

  // `show lldp`, as data: a neighbour is not "here" because it was once heard.
  lldpRows(topo) {
    const rows = [];
    for (const [portName, nb] of this.lldp.entries()) {
      const iface = this.resolveIface(portName);
      rows.push({
        port: iface ? iface.name : portName,
        systemName: (nb && nb.systemName) || '?',
        portId: (nb && nb.portId) || '?',
        mgmtIp: (nb && nb.mgmtIp) || '-',
        note: iface ? this.portCarrierNote(iface, topo) : '(gone)'
      });
    }
    rows.sort(function (a, b) { return String(a.port).localeCompare(String(b.port)); });
    return rows;
  }

  // A learned MAC is not "here" for ever. Real switches age dynamic entries out after a few minutes of silence
  // (300 s is the usual default), and this table never did: `show mac address-table` listed an entry until the
  // port changed VLAN or the lab was reloaded, which is why the row had to carry a (vlan mismatch) note to say it
  // might be stale. The simulator has had an instant in milliseconds since convergence was modelled, so an entry
  // can be stamped with when it was seen and aged against the question being asked (#1395).
  //
  // An entry written without a timestamp - by a fixture, an imported lab, or an older caller - is not aged and
  // reports no age. That is the honest reading: nothing said when it was seen.
  learnMac(vid, mac, port, atMs) {
    if (!mac || !port) return null;
    const table = this.macTableFor(vid);
    const when = Number.isFinite(atMs) ? atMs : null;
    table.set(mac, { port: (port && typeof port === 'object') ? port.name : port, atMs: when });
    return table.get(mac);
  }

  // The port a MAC is reachable by, at an instant. An entry older than MAC_AGE_MS is not there at all - the
  // data plane must not send a frame to a port the table only remembers, or a host that moved would be
  // unreachable while the frame went to where it used to be.
  macLookup(vid, mac, nowMs) {
    const table = this.macTableFor(vid);
    const hit = table.get(mac);
    if (hit === undefined || hit === null) return null;
    const at = (hit && typeof hit === 'object') ? hit.atMs : null;
    const port = (hit && typeof hit === 'object') ? hit.port : hit;
    if (Number.isFinite(at) && Number.isFinite(nowMs) && (nowMs - at) > MAC_AGE_MS) return null;
    return (port && typeof port === 'object') ? port.name : port;
  }

  // Every dynamic entry older than the age is gone. Called by the report so a long run does not carry a table of
  // addresses nobody has spoken from since the first second.
  ageMacs(nowMs) {
    if (!Number.isFinite(nowMs)) return 0;
    let dropped = 0;
    const sweep = function (table) {
      if (!table || typeof table.keys !== 'function') return;
      for (const [mac, where] of [...table.entries()]) {
        const at = (where && typeof where === 'object') ? where.atMs : null;
        if (Number.isFinite(at) && (nowMs - at) > MAC_AGE_MS) { table.delete(mac); dropped++; }
      }
    };
    sweep(this.macTable);
    for (const table of (this.macTables || new Map()).values()) sweep(table);
    return dropped;
  }

  macTableFor(vid) {
    const v = Number(vid) || 1;
    if (v === 1) return this.macTable;
    let m = this.macTables.get(v);
    if (!m) { m = new Map(); this.macTables.set(v, m); }
    return m;
  }

  // Forget every MAC learned on one port, in every VLAN.
  //
  // A port that changes VLAN membership cannot still be the way to a MAC it learned in the old VLAN, and a
  // table that keeps saying so is a table that lies - `show mac address-table` went on listing a VLAN-1
  // entry on a port that had been moved to VLAN 20, indefinitely, because nothing ages entries out here
  // (#1255). Real switches flush a port's dynamic entries when its membership changes; this is that rule.
  flushMacsOnPort(portName) {
    if (!portName) return 0;
    const name = (function (self, x) {
      const port = self.resolveIface(x);
      return port ? port.name : String(x);
    })(this, portName);
    let dropped = 0;
    const sweep = function (table) {
      if (!table || typeof table.keys !== 'function') return;
      for (const [mac, where] of [...table.entries()]) {
        // An entry is `{ port, atMs }` now; `.name` is tolerated because an interface object is also written
        // here by some callers, and a flush that matched neither would silently drop nothing (#1395).
        const at = (where && typeof where === 'object') ? (where.port || where.name) : where;
        const atName = (at && typeof at === 'object') ? at.name : at;
        if (atName === name) { table.delete(mac); dropped++; }
      }
    };
    sweep(this.macTable);
    for (const table of (this.macTables || new Map()).values()) sweep(table);
    return dropped;
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

  // Global IPv6 addresses configured on this device. `autoconfig` marks the ones
  // that came from a router advertisement rather than from a human, so `show` can
  // tell "the host configured itself" apart from "someone typed this in".
  ip6Addrs() {
    const out = [];
    const map = this.config.ip6 || {};
    for (const name of Object.keys(map)) {
      const iface = this.interfaces.get(name);
      if (!iface || !iface.enabled) continue;
      out.push({
        iface: iface, name: name,
        addr: map[name].addr, prefix: map[name].prefix,
        autoconfig: !!map[name].autoconfig,
        from: map[name].from || null
      });
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
      best = {
        iface: this.config.gateway6Iface || null,
        via: this.config.gateway6,
        type: 'default6',
        prefix: 0
      };
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

  // The port a next hop would leave by if it could, whether or not it can carry anything.
  //
  // `egressFor()` only looks at ports that are up, so a shut port's subnet answers "no interface" - which is a
  // different story from "no interface at all", and the two send a reader to different places (configure the
  // routing, or bring the port up). Asked by the route table and by the forwarding path's drop reason (#1439).
  egressCandidateFor(nextHopIp) {
    for (const iface of this.interfaces.values()) {
      if (iface.ip && iface.mask && net.sameSubnet(nextHopIp, iface.ip, iface.mask)) {
        return iface;
      }
    }
    return null;
  }

  // The administrative distance of a route source, in one place: `show ip route` prints it, its
  // "Gateway of last resort" line sorts by it, and the inspector's table shows it (#1301). Two copies of this
  // would drift the moment a source is added.
  static routeDistance(r) {
    if (!r) return 1;
    if (r.type === 'connected') return 0;
    if (r.type === 'static') return 1;
    if (r.type === 'ospf') return 110;
    if (r.type === 'bgp') return (r.ad === undefined || r.ad === null) ? 200 : r.ad;
    if (r.type === 'default') return 254;
    return 1;
  }

  // Why a row in the route table cannot carry a packet, in the sentence the console prints - and the same
  // sentence the inspector shows, because a route table that reads healthy while every packet to that prefix is
  // dropped sends the operator looking for a host instead of at the wire (#1271, #1301).
  //
  // Two different faults, deliberately kept apart:
  //   * the egress cannot carry a frame (shut, no cable, peer shut, link down) - the route is unusable;
  //   * an interface-only static has no next hop at all, and works only if the far side proxies ARP for the
  //     destination - that is a caveat, not a fault, so the row stays usable.
  routeNote(row, topo) {
    if (!row) return { note: '', unusable: false };
    const carry = (iface) => {
      if (!iface) return null;
      const link = this.ifaceStatus(iface, topo);
      if (link.status === 'up') return '';
      const why = (!link.reason || link.reason === 'shut down' || link.reason === link.status)
        ? link.status : link.status + ': ' + link.reason;
      return '(' + why + ')';
    };
    if (row.type === 'connected') {
      const iface = row.iface && row.iface !== '-' ? this.interfaces.get(row.iface) : null;
      const why = iface ? carry(iface) : '(gone)';
      return { note: why || '', unusable: !!why };
    }
    if (row.type === 'static' && (row.gw === '-' || row.gw == null)) {
      // No next hop: the packet is ARPed for on the segment. Worth saying, but the row still works where the
      // far side proxies.
      const why = row.iface && row.iface !== '-' ? carry(this.interfaces.get(row.iface)) : '';
      return {
        note: ['(no next hop: ARP for the destination on that segment)', why].filter(Boolean).join('  '),
        unusable: !!why
      };
    }
    const explicit = row.iface && row.iface !== '-';
    const egress = explicit ? this.interfaces.get(row.iface) : this.egressFor(row.gw);
    // A next hop no interface is on the subnet of means there is nowhere to put the packet, however healthy the
    // rest of the box is. This used to fall through to "no problem": `egress` was null, `why` stayed empty, and
    // `S 192.168.50.0/24 [1/0] via 172.16.9.1` read as an installed route on a router holding only 10.0.0.1/24 -
    // while the data plane answered "no usable egress interface" for the same prefix. One table, two verdicts, and
    // the printed one said the route was fine (#1439).
    if (!egress) {
      // The subnet may still be held by a port that cannot carry - `egressFor()` only looks at ports that are up,
      // so a shut port reads as "no interface", which is a different story and points at a different fix.
      const holder = explicit ? null : this.egressCandidateFor(row.gw);
      if (holder) {
        const why = carry(holder);
        return {
          note: '(next hop ' + row.gw + ' would leave by ' + holder.name + ', which cannot carry' +
            (why ? ': ' + why.replace(/^\(/, '').replace(/\)$/, '') : '') + ')',
          unusable: true
        };
      }
      return {
        note: explicit ? '(gone: ' + row.iface + ' is not a port on this device)'
          : '(no interface on the subnet of next hop ' + row.gw + ')',
        unusable: true
      };
    }
    const why = carry(egress);
    return { note: why || '', unusable: !!why };
  }

  // Connected + static routes as display rows, annotated so that every surface prints the same thing about
  // them: the code (`S*` for the installed default), the distance, and the reason a row cannot be used.
  routesTable(topo) {
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
    // Annotate in one pass, so a row cannot reach a surface without its verdict. `checked` says whether the
    // verdict could be computed at all: without a topology there is no cable state, and a row that reports
    // "usable" because nobody looked is the guess that produced #1299. Surfaces print `note` and honour
    // `unusable`; a caller that passes no topology gets `checked: false` and should say so rather than imply
    // the route was examined.
    for (const row of rows) {
      row.displayCode = row.type === 'default' ? 'S*' : row.code;
      row.distance = Device.routeDistance(row);
    }

    // One prefix, one installed route (#1407).
    //
    // The table used to print every candidate it held, so a BGP route for a subnet the box is *directly
    // connected to* appeared beside the connected route as an equal:
    //
    //     C   10.0.12.0      /24  is directly connected, Gi0
    //     B  10.0.12.0      /24  [20/0] via 10.0.12.2  Gi0
    //
    // Two rows for one destination, and only one of them can be installed. `routeTo()` - the thing that
    // actually forwards - has always chosen by longest prefix then lowest distance, so the engine knew the
    // answer and the report did not say it. A received route is not deleted from the table (dropping it would
    // hide what the peer sent); it is marked, with the row that beat it named.
    const groups = new Map();
    for (const row of rows) {
      const key = row.dest + '/' + row.mask;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row);
    }
    for (const group of groups.values()) {
      let best = group[0];
      for (const row of group) {
        // Strictly lower wins; a tie keeps the earlier row, which is the order routeTo() tries them in
        // (connected, static, BGP, OSPF). Nothing here invents a preference the data plane does not have.
        if (row.distance < best.distance) best = row;
      }
      for (const row of group) {
        row.installed = row === best;
        if (row !== best) row.shadowedBy = { code: best.displayCode, distance: best.distance, iface: best.iface };
      }
    }

    for (const row of rows) {
      const verdict = this.routeNote(row, topo);
      // Two different facts, kept apart on purpose. `note` means "this row cannot carry a packet" and drives
      // the fault styling; `shadow` means "this row is fine, but another route for the same prefix wins". Folding
      // them into one string made a perfectly healthy candidate default read as a fault, which is what
      // `test/routes-agreement.test.js` caught.
      row.shadow = (row.installed === false && row.shadowedBy)
        ? '(not installed: the ' + row.shadowedBy.code + ' route for this prefix has distance ' +
          row.shadowedBy.distance + ')'
        : '';
      row.note = verdict.note;
      row.unusable = verdict.unusable;
      row.checked = !!topo;
    }
    return rows;
  }

  serialize() {
    // The interface map below runs in a callback, so the device reference has to be
    // captured: `this` is not the device inside it.
    const self = this;
    const out = {
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
        gateway6Iface: this.config.gateway6Iface || null,
        ra: this.config.ra ? JSON.parse(JSON.stringify(this.config.ra)) : null,
        scionAs: this.config.scionAs || null
      },
      interfaces: Array.from(this.interfaces.values()).map(function (i) {
        // A port is written once and read back as itself, but an unset optional field is not a fact worth a line in
        // every board: `maxRangeM`, `comboWith` and `comboRole` are added below only when they hold something.
        const doc = {
          name: i.name, type: i.type, speed: i.speed,
          ip: i.ip, mask: i.mask, enabled: i.enabled,
          dhcp: i.dhcp, description: i.description,
          // 'ipv6 address autoconfig' - the interface is waiting for a router
          autoconfig: !!i.autoconfig,
          // physical hardware (so the UI can render cages/media without re-deriving)
          cage: i.hardware.cage,
          media: i.hardware.media,
          speedCaps: i.hardware.speedCaps,
          poeOut: i.hardware.poeOut,
          poeIn: i.hardware.poeIn,
          // The two hardware facts that are *computed* rather than read off the cage, and were therefore the
          // two that did not survive a save: a 115.2 kbps console came back believing it could do 1 Gbps, and
          // 1,499 ports that declared their own PoE came back looking as if the engine had guessed it (#1321).
          maxSpeedMbps: i.hardware.maxSpeedMbps,
          poeOutDeclared: i.hardware.poeOutDeclared,
          duplex: i.duplex,
          vlan: (function () {
            // The voice VLAN is written only when it is set, for the same reason the optional hardware fields
            // above are: a board should not grow a `voiceVlan: null` line on every port in the catalogue. It is
            // written at all because before this a saved lab came back with its voice VLANs gone (#1368).
            const out = {
              mode: i.vlan.mode,
              accessVlan: i.vlan.accessVlan,
              nativeVlan: i.vlan.nativeVlan,
              allowedVlans: i.vlan.allowedVlans
            };
            if (i.vlan.voiceVlan !== null && i.vlan.voiceVlan !== undefined) {
              out.voiceVlan = i.vlan.voiceVlan;
            }
            return out;
          })(),
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
        // A combo port shares one cage with its sibling: cabling either half occupies it. Without these the pair
        // came back as two independent ports and the "only one half" rule stopped applying (#1321).
        // `ip nat inside` / `ip nat outside`: which side of the translation this port is on. Written only when
        // set, like every other optional port fact - a board should not grow a `natRole: null` line on every
        // port in the catalogue (#1391).
        if (i.natRole) doc.natRole = i.natRole;
        if (i.comboWith) doc.comboWith = i.comboWith;
        if (i.comboRole) doc.comboRole = i.comboRole;
        // The operator's line rate, when it has been forced with `speed <mbps>`. `duplex` is written above
        // unconditionally because it is always a value; this one is optional by the same rule as `natRole` - a
        // port negotiating its own rate should not grow a `speedMbps: null` line - but when it *is* set the save
        // has to carry it. It did not: a lab saved with `speed 100` came back at the hardware rate, and the
        // command had gone from running-config as well, so nothing put it back (#1405).
        if (i.speedMbps) doc.speedMbps = i.speedMbps;
        if (i.hardware.maxRangeM !== null && i.hardware.maxRangeM !== undefined) doc.maxRangeM = i.hardware.maxRangeM;
        return doc;
      }),
      // per-interface ACL bindings (acl definitions live in config.acls)
      aclBindings: this.aclBindings || {}
    };

    // Only when there is something in it. A server that forgets its pools on save is broken - the
    // lab silently stops handing out addresses - but a device with no pools should not grow an
    // empty array in every saved topology either.
    if (this.config.dhcpPools && this.config.dhcpPools.length) {
      out.config.dhcpPools = JSON.parse(JSON.stringify(this.config.dhcpPools));
    }
    // Same rule: a router that forgets its virtual gateway on save leaves every host that used it
    // black-holed, but a router with no groups should not grow an empty array.
    if (this.config.vrrp && this.config.vrrp.length) {
      out.config.vrrp = JSON.parse(JSON.stringify(this.config.vrrp));
    }
    // Same rule again, and for the same reason: a switch that never had a bridge priority should not grow a
    // null in every saved board, but one that had it must not lose it - the root election changes on reload.
    // `0` is a legal priority and the best one, so this tests for null rather than falsiness.
    if (this.config.stpPriority !== null && this.config.stpPriority !== undefined) {
      out.config.stpPriority = this.config.stpPriority;
    }
    // NAT: rules and the pools they name. A reloaded lab that kept its addresses but forgot its translations
    // would send the same packets somewhere else, which is the opposite of a save.
    if (this.config.nat && ((this.config.nat.rules || []).length || Object.keys(this.config.nat.pools || {}).length)) {
      out.config.nat = JSON.parse(JSON.stringify(this.config.nat));
    }
    // The spec facts the rules read, and only when there are any: a plain PC has none, and a board should not grow
    // an empty object on every device for it (#1459).
    const facts = specFacts(this.spec);
    if (Object.keys(facts).length) out.spec = facts;
    return out;
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
        d.config.gateway6Iface = state.config.gateway6Iface || null;
        d.config.ra = state.config.ra ? JSON.parse(JSON.stringify(state.config.ra)) : null;
        d.config.scionAs = state.config.scionAs || null;
        d.config.stpPriority = (state.config.stpPriority === 0 || state.config.stpPriority)
          ? Number(state.config.stpPriority) : null;
        d.config.nat = state.config.nat
          ? JSON.parse(JSON.stringify(state.config.nat))
          : { rules: [], pools: {} };
        d.config.dhcpPools = (state.config && Array.isArray(state.config.dhcpPools))
          ? JSON.parse(JSON.stringify(state.config.dhcpPools)) : [];
        d.config.vrrp = (state.config && Array.isArray(state.config.vrrp))
          ? JSON.parse(JSON.stringify(state.config.vrrp)) : [];
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
          iface.autoconfig = !!is.autoconfig;
          iface.description = is.description || '';
          if (is.duplex) iface.duplex = is.duplex;
          // The other half of the same setting. `speed 100` was stored, printed by `show interfaces` as
          // "100Mb/s (forced)" and written to running-config - and the port document never carried it, so a saved
          // lab came back at whatever the hardware negotiates, with the command gone from the config too: nothing
          // put it back (#1405). `duplex` sat one line above and was saved all along.
          const forcedMbps = Number(is.speedMbps);
          if (Number.isFinite(forcedMbps) && forcedMbps > 0) iface.speedMbps = forcedMbps;
          if (is.lagId !== undefined) iface.lagId = is.lagId || null;
          if (is.role !== undefined) iface.role = is.role || null;
          if (is.natRole !== undefined) iface.natRole = (is.natRole === 'inside' || is.natRole === 'outside') ? is.natRole : null;
          if (is.dualRole !== undefined) iface.dualRole = is.dualRole || null;
          if (is.bridgeGroup !== undefined) iface.bridgeGroup = is.bridgeGroup || null;
          if (is.vlan && typeof is.vlan === 'object') {
            iface.vlan = {
              mode: is.vlan.mode === 'trunk' ? 'trunk' : 'access',
              accessVlan: Number(is.vlan.accessVlan) || 1,
              nativeVlan: Number(is.vlan.nativeVlan) || 1,
              allowedVlans: is.vlan.allowedVlans === undefined ? 'all' : is.vlan.allowedVlans
            };
            // Restored, not re-derived: the reader rebuilt this object from four keys, so a saved voice VLAN
            // came back as a port that had never had one (#1368).
            const voice = Number(is.vlan.voiceVlan);
            if (Number.isInteger(voice) && voice > 0 && voice <= 4094) iface.vlan.voiceVlan = voice;
          }
          // Physical hardware is saved, so it must be restored - not re-derived.
          //
          // `new Device(id, spec)` works hardware out from the spec, and the spec that reaches this
          // point carries little more than the port name and type. Re-deriving threw away three
          // things the document had already decided:
          //
          //   * the order of `speedCaps` (a 2500/1000/100/10 port came back 10/100/1000/2500),
          //   * `poeOut: true` - the spec's way of saying "this port sources power" - which
          //     derivePortHardware reads as a wattage and turned into 15.4 W,
          //   * the same for `poeIn` (12.95 W).
          //
          // The second one was not cosmetic: the PoE budget adds `iface.poeOut`, so a save and reload
          // changed the number the budget check saw. A lab file has to mean the same thing twice.
          if (is.cage !== undefined || Array.isArray(is.media) || Array.isArray(is.speedCaps) ||
              ('poeOut' in is) || ('poeIn' in is)) {
            const derived = iface.hardware || {};
            iface.hardware = Object.assign({}, derived, {
              cage: is.cage !== undefined ? is.cage : derived.cage,
              media: Array.isArray(is.media) ? is.media.slice() : derived.media,
              speedCaps: Array.isArray(is.speedCaps) ? is.speedCaps.slice() : derived.speedCaps,
              poeOut: ('poeOut' in is) ? is.poeOut : derived.poeOut,
              poeIn: ('poeIn' in is) ? is.poeIn : derived.poeIn
            });
          }
        }
      }
    }
    return d;
  }
}

module.exports = { Device, Interface, CAPABILITIES, MAC_AGE_MS, ARP_AGE_MS };
