'use strict';
// cli.js — vendor-agnostic management console (Cisco-like, but the same
// commands work for every vendor in the registry). The engine operates on
// capabilities, not on vendor syntax, so a Huawei router and a Cisco router
// share one consistent command set.
const net = require('./net');

const MODE_EXEC = 'exec';
const MODE_ENABLE = 'enable';
const MODE_CONFIG = 'config';
const MODE_IFACE = 'iface';
const MODE_DHCP_POOL = 'dhcp-pool';
// One port, many spellings - and one table for it. This used to be a second copy of
// engine/iface-name.js, kept in step by hand; two copies of a naming rule drift, which is the
// failure mode this repo has already been bitten by (#1247).
const { PORT_NAME_RULES, portKey, resolvePortName } = require('./iface-name');
// Rates are spelled the way the catalogue spells them, by the parser the catalogue uses: `speed 1G` and
// `speed 1000` must land on the same port rate, and a second parser here would be a second answer.
const mediaLib = require('./media');
// VLAN membership is decided by one rule (engine/vlan.js), so a table that lists members uses it rather
// than re-deriving what a port carries.
const vlanLib = require('./vlan');


function pad(s, w) { s = String(s); return s + ' '.repeat(Math.max(0, w - s.length)); }

class CliSession {
  constructor(device, topology, simulator) {
    this.device = device;
    this.topo = topology;
    this.sim = simulator;
    this.mode = MODE_EXEC;
    this.iface = null;
  }

  prompt() {
    const host = this.device.config.hostname || this.device.hostname || this.device.name;
    if (this.mode === MODE_CONFIG) return host + '(config)#';
    if (this.mode === MODE_IFACE) return host + '(config-if)#';
    if (this.mode === MODE_DHCP_POOL) return host + '(config-dhcp)#';
    if (this.mode === MODE_ENABLE) return host + '#';
    return host + '>';
  }

  run(line) {
    const out = [];
    // A pasted config begins with the comment line the printer itself writes
    // ("! PacketForge running-config"), and every CLI in the world ignores it. This one answered
    // "% Unrecognized config command" and carried on, which is how a paste starts with an error
    // before it has read a single command (#1230).
    if (/^\s*[!#]/.test(String(line == null ? '' : line))) return { output: out, actions: [] };
    const tokens = line.trim().split(/\s+/).filter(Boolean);
    if (!tokens.length) return { output: out, actions: [] };
    const head = tokens[0].toLowerCase();

    try {
      if (this.mode === MODE_IFACE) {
        out.push.apply(out, this._ifaceMode(tokens));
      } else if (this.mode === MODE_DHCP_POOL) {
        out.push.apply(out, this._dhcpPoolMode(tokens));
      } else if (this.mode === MODE_CONFIG) {
        out.push.apply(out, this._configMode(tokens));
      } else {
        // exec / enable mode
        if (head === 'enable' || head === 'en') {
          this.mode = MODE_ENABLE;
        } else if (head === 'configure' || head === 'conf') {
          if (tokens[1] === 'terminal' || tokens[1] === 't') this.mode = MODE_CONFIG;
          else out.push('% Invalid input: ' + line);
        } else if (head === 'show') {
          out.push.apply(out, this._show(tokens.slice(1)));
        } else if (head === 'ping') {
          out.push.apply(out, this._ping(tokens.slice(1)));
        } else if (head === 'converge') {
          out.push.apply(out, this._converge(tokens.slice(1)));
        } else if (head === 'link') {
          out.push.apply(out, this._link(tokens.slice(1)));
        } else if (head === 'links') {
          out.push.apply(out, this._links());
        } else if (head === 'exit' || head === 'logout' || head === 'quit') {
          // stays in exec
        } else if (head === 'help' || head === '?') {
          out.push.apply(out, this._help());
        } else {
          out.push('% Unrecognized command: ' + line);
        }
      }
    } catch (e) {
      out.push('% Error: ' + e.message);
    }
    return { output: out, actions: [] };
  }

  // ---------- config mode ----------
  _configMode(tokens) {
    const out = [];
    const head = tokens[0].toLowerCase();
    if (head === 'hostname') {
      // The whole remainder is the name. Taking tokens[1] silently truncated
      // "core switch 1" to "core", which is what the UI's hostname field appeared to do
      // (issue #19) - the box was fine, the parser was eating the rest of the line.
      const name = tokens.slice(1).join(' ').trim();
      this.device.config.hostname = name || null;
      // device.name is what the UI renders: the canvas label, the inspector header, the
      // status bar. Setting only config.hostname left a device that reported
      // "hostname THE BIFROST" while every surface still said "THE" (issue #21). Both are
      // set from the same text, so they cannot disagree.
      if (name) this.device.name = name;
    } else if (head === 'vlan') {
      const id = parseInt(tokens[1], 10);
      const chk = require('./vlan').validatePortConfig({ accessVlan: id });
      if (!chk.ok) return ['% ' + chk.errors[0].message];
      if (!this.device.config.vlans) this.device.config.vlans = {};
      const name = tokens.slice(2).join(' ') || ('VLAN' + String(id).padStart(4, '0'));
      this.device.config.vlans[id] = { name: name };
      out.push('VLAN ' + id + ' created (name: ' + name + ')');
    } else if (head === 'no' && tokens[1] === 'vlan') {
      const id = parseInt(tokens[2], 10);
      if (this.device.config.vlans) delete this.device.config.vlans[id];
      out.push('VLAN ' + id + ' removed');
    } else if (head === 'no' && (tokens[1] === 'interface' || tokens[1] === 'int')) {
      const typed = tokens.slice(2).join(' ');
      const name = resolvePortName(this.device, typed);
      const vi = name ? this.device.interfaces.get(name) : null;
      if (!vi) return ['% Interface not found: ' + (typed || '')];
      if (!vi.parent) return ['% ' + typed + ' is a physical interface and cannot be removed'];
      this.device.interfaces.delete(name);
      out.push('Subinterface ' + name + ' removed');
    } else if (head === 'access-list') {
      out.push.apply(out, this._accessList(tokens.slice(1)));
    } else if (head === 'no' && tokens[1] === 'access-list') {
      const n = tokens[2];
      if (this.device.config.acls) delete this.device.config.acls[n];
      // A removed list takes its counters with it: leaving them behind would report traffic against a rule
      // that no longer exists, the moment a list of the same number is written again.
      if (this.device.aclHits) delete this.device.aclHits[String(n)];
      const binds = this.device.aclBindings || {};
      for (const k of Object.keys(binds)) {
        if (String(binds[k].in) === String(n)) delete binds[k].in;
        if (String(binds[k].out) === String(n)) delete binds[k].out;
      }
      out.push('Access list ' + n + ' removed');
    } else if (head === 'interface' || head === 'int') {
      if (!tokens[1]) return ['% Incomplete command'];
      // An interface name is the whole rest of the line, because some of them contain spaces:
      // Ubiquiti calls its ports "Port 1" and its cages "SFP+ 1", so `interface Port 1` was read as
      // an interface called "Port" and refused - which made those devices' own running-config
      // unreplayable (#1230).
      const typed = tokens.slice(1).join(' ');
      // Both spellings of a port resolve here: the panel name from the spec and
      // the vendor-console name the operator may have typed (issue #27).
      let name = resolvePortName(this.device, typed);
      if (!name) {
        // 'interface Gi0/0.10' creates a router subinterface on Gi0/0.
        const m = /^(.+)\.(\d+)$/.exec(typed);
        const parent = m ? resolvePortName(this.device, m[1]) : null;
        if (m && parent) {
          const vid = parseInt(m[2], 10);
          if (!(vid >= 1 && vid <= 4094)) return ['% VLAN out of range: ' + m[2]];
          this.device.addSubinterface(parent, vid);
          name = parent + '.' + vid;
          out.push('Created subinterface ' + name + ' (parent ' + parent + ')');
        } else {
          return ['% Interface not found: ' + typed];
        }
      }
      this.iface = name;
      this.mode = MODE_IFACE;
    } else if (head === 'vrrp') {
      // A group belongs to an interface, so this has to be configured on one - silently attaching
      // it to whichever interface happened to be selected last would be worse than refusing.
      return ['% vrrp is configured per interface: enter an interface first, e.g. interface Gi0/0'];
    } else if (head === 'ip' && tokens[1] === 'dhcp' && tokens[2] === 'pool') {
      // A pool is a named object on the device, not a property of an interface: the same server
      // can hold several, and a client chooses by the subnet its own interface sits in.
      const name = tokens[3];
      if (!name) return ['% Incomplete command: ip dhcp pool <name>'];
      if (!/^[A-Za-z0-9_.-]{1,32}$/.test(name)) return ['% Invalid pool name: ' + name];
      if (!this.device.config.dhcpPools) this.device.config.dhcpPools = [];
      let pool = this.device.config.dhcpPools.filter(function (p) { return p.name === name; })[0];
      if (!pool) {
        pool = { name: name };
        this.device.config.dhcpPools.push(pool);
        out.push('Created DHCP pool ' + name);
      }
      this.pool = name;
      this.mode = MODE_DHCP_POOL;
    } else if (head === 'scion') {
      const scionLib2 = require('./scion');
      const parsed = scionLib2.parseIsdAs(tokens[1]);
      if (!parsed.valid) out.push('% Invalid SCION ISD-AS "' + (tokens[1] || '') + '" (expected e.g. 1-ff00:0:110)');
      else {
        this.device.config.scionAs = scionLib2.formatIsdAs(parsed.isd, parsed.asHex);
        out.push('SCION ' + this.device.config.scionAs +
          (scionLib2.isCore(this.device.config.scionAs) ? ' (core AS)' : ''));
      }
    } else if (head === 'no' && tokens[1] === 'scion') {
      this.device.config.scionAs = null;
      out.push('SCION membership removed');
    } else if (head === 'ipv6' && tokens[1] === 'route') {
      out.push.apply(out, this._ipv6Route(tokens.slice(2)));
    } else if (head === 'ipv6' && tokens[1] === 'gateway') {
      const v6 = require('./ipv6');
      if (!v6.validateAddress6(tokens[2]).ok) out.push('% Invalid IPv6 gateway "' + (tokens[2] || '') + '"');
      else { this.device.config.gateway6 = tokens[2]; out.push('IPv6 default gateway ' + tokens[2]); }
    } else if (head === 'ipv6' && tokens[1] === 'nd') {
      out.push.apply(out, this._ipv6Nd(tokens.slice(2)));
    } else if (head === 'no' && tokens[1] === 'ipv6' && tokens[2] === 'nd') {
      out.push.apply(out, this._ipv6Nd(['no'].concat(tokens.slice(3))));
    } else if (head === 'no' && tokens[1] === 'ipv6') {
      this.device.config.gateway6 = null;
      this.device.config.routes6 = [];
      out.push('IPv6 routes cleared');
    } else if (head === 'router' && tokens[1] === 'bgp') {
      out.push.apply(out, this._bgp(['as', tokens[2]]));
    } else if (head === 'no' && tokens[1] === 'router' && tokens[2] === 'bgp') {
      this.device.config.bgp = null;
      this.device.bgpRoutes = [];
      out.push('BGP disabled');
    } else if (head === 'no' && tokens[1] === 'neighbor') {
      const addr = tokens[2];
      if (!this.device.config.bgp) out.push('% BGP is not enabled');
      else {
        const list = this.device.config.bgp.neighbors || [];
        const keep = list.filter(function (x) { return x.address !== addr; });
        this.device.config.bgp.neighbors = keep;
        out.push(keep.length === list.length ? '% No such neighbor ' + addr : 'Removed neighbor ' + addr);
      }
    } else if (head === 'neighbor') {
      out.push.apply(out, this._bgp(tokens.slice(1)));
    } else if (head === 'bgp') {
      out.push.apply(out, this._bgp(tokens.slice(1)));
    } else if (head === 'dns') {
      out.push.apply(out, this._dns(tokens.slice(1)));
    } else if (head === 'ip' && tokens[1] === 'name-server') {
      const ip = tokens[2];
      if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip || '')) {
        out.push('% Invalid name server "' + (ip || '') + '"');
      } else {
        if (!this.device.config.dnsServers) this.device.config.dnsServers = [];
        if (this.device.config.dnsServers.indexOf(ip) === -1) this.device.config.dnsServers.push(ip);
        out.push('Name server ' + ip);
      }
    } else if (head === 'no' && tokens[1] === 'ip' && tokens[2] === 'name-server') {
      this.device.config.dnsServers = [];
      out.push('Name servers cleared');
    } else if (head === 'ospf') {
      out.push.apply(out, this._ospfConfig(tokens.slice(1)));
    } else if (head === 'no' && tokens[1] === 'ospf') {
      this.device.config.ospf = null;
      this.device.ospfRoutes = [];
      out.push('OSPF disabled');
    } else if (head === 'ip' && tokens[1] === 'route') {
      // ip route DEST MASK GW [iface]
      const dest = tokens[2], mask = tokens[3], gw = tokens[4], iface = tokens[5] || null;
      if (!dest || !mask) return ['% Incomplete command'];
      net.maskToInt(mask); // validate
      this.device.config.routes.push({ dest: dest, mask: mask, gw: gw || null, iface: iface });
      out.push('Route added: ' + dest + '/' + net.prefixOf(mask) + ' via ' + (gw || 'on-link'));
    } else if (head === 'no' && tokens[1] === 'ip' && tokens[2] === 'route') {
      const dest = tokens[3], mask = tokens[4], gw = tokens[5] || null;
      const before = this.device.config.routes.length;
      this.device.config.routes = this.device.config.routes.filter(function (r) {
        return !(r.dest === dest && r.mask === mask && (gw == null || r.gw === gw));
      });
      out.push(before > this.device.config.routes.length ? 'Route removed' : '% Route not found');
    } else if (head === 'ip' && tokens[1] === 'default-gateway') {
      this.device.config.defaultGateway = tokens[2] || null;
      out.push('Default gateway: ' + (tokens[2] || '(none)'));
    } else if (head === 'no' && tokens[1] === 'ip' && tokens[2] === 'default-gateway') {
      this.device.config.defaultGateway = null;
      out.push('Default gateway cleared');
    } else if (head === 'exit' || head === 'end') {
      this.mode = MODE_EXEC;
    } else if (head === 'show') {
      out.push.apply(out, this._show(tokens.slice(1)));
    } else if (head === 'do') {
      // allow running exec commands from config mode: 'do show ...'
      out.push.apply(out, this._show(tokens.slice(1)));
    } else {
      out.push('% Unrecognized config command: ' + tokens.join(' '));
    }
    return out;
  }

  // ---------- interface mode ----------
  _ifaceMode(tokens) {
    const out = [];
    const iface = this.device.interfaces.get(this.iface);
    const head = tokens[0].toLowerCase();

    // IOS treats a new `interface <name>` line inside interface mode as a mode switch, not as an
    // error. Configs copied out before #1230 rely on exactly this, because they have no `exit`
    // between blocks; the config-mode handler already knows how to open an interface (including a
    // dot1q subinterface), so reuse it.
    if (head === 'interface' || head === 'int') {
      this.mode = MODE_CONFIG;
      return this._configMode(tokens);
    }

    if (head === 'vrrp') {
      const res = this._vrrpIfaceCommand(tokens);
      if (res) return res;
    }
    if (head === 'no' && tokens[1] === 'vrrp') {
      const vrid = parseInt(tokens[2], 10);
      const groups = (this.device.config.vrrp || []);
      const kept = groups.filter(function (g) {
        return !(g.vrid === vrid && g.interface === this.iface);
      }, this);
      if (kept.length === groups.length) return ['% No VRRP group ' + tokens[2] + ' on ' + this.iface];
      this.device.config.vrrp = kept;
      return ['VRRP group ' + vrid + ' removed from ' + this.iface];
    }
    if (head === 'ip' && tokens[1] === 'address') {
      if (tokens[2] === 'dhcp') {
        iface.dhcp = true;
        out.push('Interface ' + iface.name + ' set to DHCP');
      } else {
        const ip = tokens[2], mask = tokens[3];
        if (!ip || !mask) return ['% Incomplete command'];
        net.ipToInt(ip);                       // an address error is reported as an address error
        // A netmask must be a run of ones then zeros, and a bad mask is reported as a *mask* - the old
        // code let maskToInt() throw and the message came out as "Invalid IPv4 address: garbage",
        // pointing at the wrong argument (#1249).
        if (!net.isContiguousMask(mask)) {
          return ['% Invalid mask: ' + mask + ' - a netmask is a run of ones then zeros (255.255.255.0, or 24)'];
        }
        // Store the dotted form whichever way it was typed: a port left holding "24" reads as /2 to
        // anything that parses a dotted mask, the front panel included.
        const dotted = net.maskFromPrefix(net.prefixOf(mask));
        iface.ip = ip; iface.mask = dotted; iface.dhcp = false;
        out.push('IP address set on ' + iface.name + ': ' + ip + '/' + net.prefixOf(dotted));
      }
    } else if (head === 'no' && tokens[1] === 'ip' && tokens[2] === 'address') {
      iface.ip = null; iface.mask = null; iface.dhcp = false;
      out.push('IP address removed from ' + iface.name);
    } else if (head === 'shutdown') {
      iface.enabled = false;
      out.push(iface.name + ' administratively down');
    } else if (head === 'no' && tokens[1] === 'shutdown') {
      iface.enabled = true;
      out.push(iface.name + ' up');
    } else if (head === 'ipv6' && tokens[1] === 'address') {
      out.push.apply(out, this._ipv6Iface(tokens.slice(2), iface));
    } else if (head === 'no' && tokens[1] === 'ipv6' && tokens[2] === 'address') {
      if (String(tokens[3] || '').toLowerCase() === 'autoconfig') {
        out.push.apply(out, this._noAutoconfig(iface));
      } else {
        if (this.device.config.ip6) delete this.device.config.ip6[iface.name];
        iface.autoconfig = false;
        out.push('IPv6 address removed from ' + iface.name);
      }
    } else if (head === 'ip' && tokens[1] === 'ospf') {
      out.push.apply(out, this._ipOspf(tokens.slice(2), iface));
    } else if (head === 'no' && tokens[1] === 'ip' && tokens[2] === 'ospf') {
      out.push.apply(out, this._ipOspf(['no'].concat(tokens.slice(3)), iface));
    } else if (head === 'ip' && tokens[1] === 'access-group') {
      out.push.apply(out, this._accessGroup(tokens.slice(2), iface));
    } else if (head === 'encapsulation') {
      out.push.apply(out, this._encap(tokens.slice(1), iface));
    } else if (head === 'switchport') {
      out.push.apply(out, this._switchport(tokens.slice(1), iface));
    } else if (head === 'no' && tokens[1] === 'switchport') {
      out.push.apply(out, this._switchport(['reset'], iface));
    } else if (head === 'channel-group') {
      out.push.apply(out, this._channelGroup(tokens.slice(1), iface));
    } else if (head === 'no' && tokens[1] === 'channel-group') {
      out.push.apply(out, this._channelGroup(['remove'], iface));
    } else if (head === 'speed') {
      out.push.apply(out, this._speed(tokens.slice(1), iface));
    } else if (head === 'no' && tokens[1] === 'speed') {
      out.push.apply(out, this._speed(['auto'], iface));
    } else if (head === 'duplex') {
      out.push.apply(out, this._duplex(tokens.slice(1), iface));
    } else if (head === 'no' && tokens[1] === 'duplex') {
      out.push.apply(out, this._duplex(['auto'], iface));
    } else if (head === 'description') {
      iface.description = tokens.slice(1).join(' ');
      out.push('Description set');
    } else if (head === 'no' && tokens[1] === 'description') {
      iface.description = '';
    } else if (head === 'exit') {
      this.mode = MODE_CONFIG;
    } else if (head === 'end') {
      this.mode = MODE_EXEC;
    } else if (head === 'show') {
      out.push.apply(out, this._show(tokens.slice(1)));
    } else {
      // Still inside an interface block, but the line may be a global config command - the last
      // block of an old running-config is followed by `ip route`, `access-list` and friends with no
      // `exit` in front of them. Try config mode before complaining, and report the interface error
      // if config mode does not recognise it either (#1230).
      const asConfig = this._configMode(tokens);
      const rejected = asConfig.length === 1 && /^% Unrecognized config command/.test(asConfig[0]);
      if (rejected) out.push('% Unrecognized interface command: ' + tokens.join(' '));
      else out.push.apply(out, asConfig);
    }
    return out;
  }

  // ---------- 802.1Q encapsulation on a router subinterface ----------
  _encap(tokens, iface) {
    const t = tokens.map(function (x) { return String(x).toLowerCase(); });
    if (t[0] !== 'dot1q') return ['% Unsupported encapsulation: ' + (t[0] || '')];
    if (!iface.isSubinterface || !iface.isSubinterface()) {
      return ['% encapsulation dot1q is only valid on a subinterface (e.g. ' + iface.name + '.10)'];
    }
    const vid = parseInt(t[1], 10);
    if (!(vid >= 1 && vid <= 4094)) return ['% VLAN out of range: ' + (t[1] || '')];
    iface.encapVid = vid;
    const parent = this.device.interfaces.get(iface.parent);
    if (parent) {
      const vlanLib = require('./vlan');
      parent.vlan = vlanLib.normalizePortConfig(Object.assign({}, parent.vlan, { mode: 'trunk' }));
    }
    return ['Subinterface ' + iface.name + ' encapsulation dot1q ' + vid];
  }

  // ---------- IPv6 ----------
  _ipv6Iface(tokens, iface) {
    const v6 = require('./ipv6');
    const spec = String(tokens[0] || '');

    // 'ipv6 address autoconfig': the address comes from a router advertisement.
    // Any address typed in by hand is removed, because two sources of truth for
    // one address is how a lab ends up "not working" with nothing to look at.
    if (spec.toLowerCase() === 'autoconfig') {
      if (this.device.config.ip6) delete this.device.config.ip6[iface.name];
      iface.autoconfig = true;
      return ['IPv6 address autoconfig on ' + iface.name +
        ' (no address until a router advertisement arrives)'];
    }

    const parts = spec.split('/');
    const parsed = v6.parseIpv6(parts[0]);
    if (!parsed.valid) return ['% Invalid IPv6 address "' + parts[0] + '"'];
    const len = parts.length > 1 ? parseInt(parts[1], 10) : 64;
    if (!(len >= 0 && len <= 128)) return ['% Invalid prefix length "' + parts[1] + '"'];
    if (!this.device.config.ip6) this.device.config.ip6 = {};
    const addr = v6.formatIpv6(parsed.groups);
    // A static address cancels autoconfiguration: the operator has just said
    // what the address is, so waiting for a router to say otherwise would only
    // produce a second address nobody asked for.
    iface.autoconfig = false;
    this.device.config.ip6[iface.name] = { addr: addr, prefix: len };
    return ['IPv6 address ' + addr + '/' + len + ' on ' + iface.name];
  }

  // Withdrawing autoconfiguration has to take the learned address with it.
  // Otherwise the host keeps an address nobody refreshes any more, which is the
  // stale-address problem that makes "the ping still works but nothing else
  // does" so hard to explain.
  _noAutoconfig(iface) {
    const dev = this.device;
    const out = [];
    iface.autoconfig = false;
    const entry = dev.config.ip6 && dev.config.ip6[iface.name];
    if (entry && entry.autoconfig) {
      delete dev.config.ip6[iface.name];
      out.push('SLAAC address ' + entry.addr + '/' + entry.prefix + ' removed from ' + iface.name);
    }
    let waiting = 0;
    for (const i of dev.interfaces.values()) if (i.autoconfig) waiting++;
    if (!waiting && dev.config.gateway6 && dev.config.gateway6Iface) {
      dev.config.gateway6 = null;
      dev.config.gateway6Iface = null;
      out.push('Default IPv6 gateway (learned from a router advertisement) cleared');
    }
    out.push('IPv6 autoconfiguration disabled on ' + iface.name);
    return out;
  }

  // ---------- IPv6 neighbour discovery / router advertisements ----------
  //
  // 'ipv6 nd ...' describes a router to its link: which prefixes it owns, whether
  // hosts should configure themselves from them, and whether it may be used as a
  // default router. Only the policy lives here; the message format is engine/ra.js.
  _ipv6Nd(tokens) {
    const v6 = require('./ipv6');
    const raLib = require('./ra');
    const dev = this.device;
    const t = tokens.map(function (x) { return String(x).toLowerCase(); });

    let negated = false;
    if (t[0] === 'no') { negated = true; t.shift(); }
    if (!t.length) return ['% Incomplete command: ipv6 nd ra|prefix|suppress-ra'];

    function cfg() {
      if (!dev.config.ra) dev.config.ra = raLib.normalizeConfig(null);
      if (!Array.isArray(dev.config.ra.prefixes)) dev.config.ra.prefixes = [];
      return dev.config.ra;
    }

    // Advertising a prefix is a promise to route traffic inside it. A device
    // without l3-forward cannot keep that promise, so the configuration is
    // refused here rather than producing a link full of black holes.
    function needsRouter() {
      if (dev.hasCap('l3-forward')) return null;
      return ['% ' + dev.name + ' cannot advertise: it has no l3-forward capability, ' +
        'so it could not route the traffic a prefix would attract'];
    }

    if (t[0] === 'ra') {
      const sub = t[1] || '';
      const bad = needsRouter();
      if (bad) return bad;
      const c = cfg();

      if (sub === 'enable' || sub === 'disable') {
        // 'no ipv6 nd ra enable' reads as "stop advertising", and that is what it
        // does: the negated form flips the verb rather than being refused.
        const on = (sub === 'enable') !== negated;
        c.enabled = on;
        return [on
          ? 'IPv6 router advertisements enabled on ' + dev.name
          : 'IPv6 router advertisements disabled on ' + dev.name];
      }
      if (sub === 'managed' || sub === 'other-config') {
        const on = !negated;
        if (sub === 'managed') c.m = on; else c.o = on;
        return ['IPv6 RA ' + (sub === 'managed' ? 'M (managed)' : 'O (other-config)') +
          ' flag ' + (on ? 'set' : 'cleared')];
      }
      if (sub === 'lifetime') {
        const val = t[2];
        if (val === undefined) return ['% Incomplete command: ipv6 nd ra lifetime <seconds>'];
        if (!/^\d{1,5}$/.test(val)) return ['% Invalid router lifetime "' + val + '" (0..65535 seconds)'];
        const n = parseInt(val, 10);
        if (n > 65535) return ['% Router lifetime out of range: ' + val + ' (0..65535)'];
        c.routerLifetime = n;
        return ['IPv6 RA router lifetime ' + n + 's' + (n === 0 ? ' (not a default router)' : '')];
      }
      return ['% Unknown IPv6 RA command: ipv6 nd ra ' + sub];
    }

    if (t[0] === 'suppress-ra') {
      const bad = needsRouter();
      if (bad) return bad;
      const c = cfg();
      c.suppress = !negated;
      return [negated
        ? 'IPv6 periodic router advertisements resume'
        : 'IPv6 router advertisements suppressed: solicited advertisements only'];
    }

    if (t[0] === 'prefix') {
      const bad = needsRouter();
      if (bad) return bad;
      const raw = t[1];
      if (!raw) return ['% Incomplete command: ipv6 nd prefix <prefix>/<len> [valid <s>] [preferred <s>]'];
      const parsed = v6.parsePrefix6(raw);
      if (!parsed.valid) return ['% Invalid IPv6 prefix "' + raw + '"'];
      const network = v6.networkAddress6(parsed);
      const c = cfg();
      const same = function (p) {
        const pp = raLib.normalizePrefixInfo(p);
        return !!(pp && pp.prefix === network && pp.prefixLen === parsed.prefixLen);
      };

      if (negated) {
        const before = c.prefixes.length;
        c.prefixes = c.prefixes.filter(function (p) { return !same(p); });
        if (c.prefixes.length === before) {
          return ['% No such advertised prefix: ' + network + '/' + parsed.prefixLen];
        }
        return ['IPv6 ND prefix ' + network + '/' + parsed.prefixLen + ' withdrawn'];
      }

      let valid = raLib.DEFAULTS.validLifetime;
      let preferred = raLib.DEFAULTS.preferredLifetime;
      const rest = t.slice(2);
      for (let i = 0; i < rest.length; i += 2) {
        const key = rest[i];
        const val = rest[i + 1];
        if (key !== 'valid' && key !== 'preferred') {
          return ['% Unexpected "' + key + '": expected [valid <seconds>] [preferred <seconds>]'];
        }
        if (val === undefined) return ['% Incomplete command: ' + key + ' needs a value in seconds'];
        if (!/^\d{1,10}$/.test(val)) return ['% Invalid lifetime "' + val + '" (whole seconds)'];
        const n = parseInt(val, 10);
        if (n > raLib.INFINITE) return ['% Lifetime out of range: ' + val + ' (0..' + raLib.INFINITE + ')'];
        if (key === 'valid') valid = n; else preferred = n;
      }
      // A preferred lifetime past the valid one is a contradiction on the wire;
      // refusing it here means the router never advertises nonsense.
      if (preferred > valid) {
        return ['% Preferred lifetime (' + preferred + 's) cannot exceed the valid lifetime (' + valid + 's)'];
      }

      // One advertisement per prefix: re-issuing the command replaces the entry,
      // which is what an operator means by running it again.
      c.prefixes = c.prefixes.filter(function (p) { return !same(p); });
      c.prefixes.push({
        prefix: network, prefixLen: parsed.prefixLen,
        onLink: true, autonomous: true,
        validLifetime: valid, preferredLifetime: preferred
      });

      const lines = ['IPv6 ND prefix ' + network + '/' + parsed.prefixLen +
        ' advertised (L=1 A=1, valid ' + valid + 's, preferred ' + preferred + 's)'];
      if (parsed.prefixLen !== 64) {
        lines.push('% note: only a /64 leaves room for a 64-bit interface identifier, ' +
          'so hosts will not form a SLAAC address from this prefix');
      }
      return lines;
    }

    return ['% Unknown IPv6 ND command: ipv6 nd ' + t.join(' ')];
  }

  _ipv6Route(tokens) {
    const v6 = require('./ipv6');
    const dest = tokens[0];
    const nh = tokens[1];
    const p = v6.parsePrefix6(dest);
    if (!p.valid) return ['% Invalid IPv6 prefix "' + (dest || '') + '"'];
    if (!v6.validateAddress6(nh).ok) return ['% Invalid IPv6 next hop "' + (nh || '') + '"'];
    if (!this.device.config.routes6) this.device.config.routes6 = [];
    const net = v6.networkAddress6(dest);
    this.device.config.routes6.push({ dest: net, prefix: p.prefixLen, nextHop: nh });
    return ['IPv6 route ' + net + '/' + p.prefixLen + ' via ' + nh];
  }

  // ---------- BGP ----------
  _bgp(tokens) {
    const dev = this.device;
    const t = tokens.map(function (x) { return String(x); });
    const isIp = function (s) { return /^\d{1,3}(\.\d{1,3}){3}$/.test(String(s || '')); };

    function ensure(asn) {
      if (!dev.config.bgp) dev.config.bgp = { as: null, routerId: null, neighbors: [] };
      if (!dev.config.bgp.neighbors) dev.config.bgp.neighbors = [];
      if (asn !== undefined && asn !== null && asn !== '') dev.config.bgp.as = asn;
      return dev.config.bgp;
    }

    // router bgp <as>
    if (t[0] === 'as') {
      const asn = parseInt(t[1], 10);
      if (!(asn >= 1 && asn <= 4294967295)) return ['% Invalid AS number "' + (t[1] || '') + '"'];
      ensure(asn);
      return ['BGP enabled, local AS ' + asn];
    }

    // bgp router-id <ip>
    if (t[0] === 'router-id') {
      if (!isIp(t[1])) return ['% Invalid router-id "' + (t[1] || '') + '"'];
      if (!dev.config.bgp) return ['% BGP is not enabled (use "router bgp <as>")'];
      dev.config.bgp.routerId = t[1];
      return ['BGP router-id ' + t[1]];
    }

    // neighbor <ip> remote-as <as>
    if (isIp(t[0]) && String(t[1] || '').toLowerCase() === 'remote-as') {
      const asn = parseInt(t[2], 10);
      if (!(asn >= 1 && asn <= 4294967295)) return ['% Invalid remote AS "' + (t[2] || '') + '"'];
      if (!dev.config.bgp) return ['% BGP is not enabled (use "router bgp <as>" first)'];
      const list = dev.config.bgp.neighbors;
      let n = null;
      for (const x of list) { if (x.address === t[0]) { n = x; break; } }
      if (n) n.remoteAs = asn;
      else list.push({ address: t[0], remoteAs: asn });
      return ['BGP neighbor ' + t[0] + ' remote-as ' + asn];
    }

    return ['% Usage: router bgp <as> | bgp router-id <ip> | neighbor <ip> remote-as <as>'];
  }

  // ---------- DNS ----------
  _dns(tokens) {
    const dnsLib = require('./dns');
    const dev = this.device;
    const t = tokens.map(function (x) { return String(x); });
    if (!dev.config.dnsZones) dev.config.dnsZones = [];

    if (t[0] === 'zone') {
      const apex = t[1];
      if (!apex) return ['% Usage: dns zone <name>'];
      const key = dnsLib.normalizeName(apex);
      let z = dev.config.dnsZones.filter(function (x) { return dnsLib.normalizeName(x.name) === key; })[0];
      if (!z) {
        z = { name: key, defaultTtl: 3600, records: [] };
        dev.config.dnsZones.push(z);
      }
      this._dnsZone = z.name;
      return ['DNS zone ' + z.name + ' ready'];
    }

    if (t[0] === 'add') {
      const name = t[1];
      const type = String(t[2] || 'A').toUpperCase();
      const value = t[3];
      if (!name || !value) return ['% Usage: dns add <name> <A|CNAME|MX|TXT> <value>'];
      if (dnsLib.RECORD_TYPES.indexOf(type) === -1) {
        return ['% Unknown record type "' + type + '" (use ' + dnsLib.RECORD_TYPES.join('/') + ')'];
      }
      let z = null;
      if (this._dnsZone) {
        z = dev.config.dnsZones.filter(function (x) { return x.name === this._dnsZone; }, this)[0];
      }
      if (!z) z = dev.config.dnsZones[dev.config.dnsZones.length - 1];
      if (!z) return ['% No zone yet - create one with "dns zone <name>"'];
      z.records.push({ name: name, type: type, ttl: z.defaultTtl, value: value });
      return ['Added ' + name + ' ' + type + ' ' + value + ' to ' + z.name];
    }

    return ['% Usage: dns zone <name> | dns add <name> <type> <value>'];
  }

  // ---------- OSPF ----------
  _ospfConfig(tokens) {
    const dev = this.device;
    const t = tokens.map(function (x) { return String(x); });
    if (!t.length) return ['% Usage: ospf router-id <ip> | ospf area <id>'];
    const cfg = dev.config.ospf || { routerId: null, areaId: 0, interfaces: [] };
    if (!cfg.interfaces) cfg.interfaces = [];

    if (t[0] === 'router-id') {
      const ip = t[1] || '';
      if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return ['% Invalid router-id "' + ip + '"'];
      cfg.routerId = ip;
      dev.config.ospf = cfg;
      return ['OSPF enabled, router-id ' + ip + ' area ' + (cfg.areaId || 0)];
    }
    if (t[0] === 'area') {
      const id = parseInt(t[1], 10);
      if (!(id >= 0 && id <= 2147483647)) return ['% Invalid area id "' + (t[1] || '') + '"'];
      cfg.areaId = id;
      dev.config.ospf = cfg;
      return ['OSPF area ' + id];
    }
    return ['% Usage: ospf router-id <ip> | ospf area <id>'];
  }

  _ipOspf(tokens, iface) {
    const dev = this.device;
    if (!dev.config.ospf) return ['% OSPF is not enabled (use "ospf router-id <ip>" in config mode)'];
    const cfg = dev.config.ospf;
    if (!cfg.interfaces) cfg.interfaces = [];

    let ov = null;
    for (const x of cfg.interfaces) { if (x.name === iface.name) { ov = x; break; } }
    if (!ov) { ov = { name: iface.name }; cfg.interfaces.push(ov); }

    const t = tokens.map(function (x) { return String(x).toLowerCase(); });
    const negate = t[0] === 'no';
    const rest = negate ? t.slice(1) : t;

    if (rest[0] === 'cost') {
      if (negate) { delete ov.cost; return ['OSPF cost reset on ' + iface.name]; }
      const c = parseInt(rest[1], 10);
      if (!(c >= 1 && c <= 65535)) return ['% Cost must be 1..65535'];
      ov.cost = c;
      return ['OSPF cost ' + c + ' on ' + iface.name];
    }
    if (rest[0] === 'area') {
      if (negate) { delete ov.area; return ['OSPF area reset on ' + iface.name]; }
      const id = parseInt(rest[1], 10);
      if (!(id >= 0 && id <= 2147483647)) return ['% Invalid area id'];
      ov.area = id;
      return ['OSPF area ' + id + ' on ' + iface.name];
    }
    if (rest[0] === 'passive') {
      ov.passive = !negate;
      return ['OSPF ' + (negate ? 'active' : 'passive') + ' on ' + iface.name];
    }
    return ['% Usage: ip ospf cost <n> | ip ospf area <id> | ip ospf passive'];
  }

  // ---------- line rate and duplex ----------
  //
  // Both were modelled and neither was reachable: `Interface.duplex` was written as 'full' for every port
  // in the catalogue and no command could change it, so `W_DUPLEX_MISMATCH` - a warning the connector docs
  // promise - could never fire. The rule is worth having because it is the classic "the link is up but slow"
  // answer, and a simulator that cannot produce it cannot be asked the question (#1259).
  _speed(tokens, iface) {
    const want = (tokens[0] || '').toLowerCase();
    if (!want) return ['% Usage: speed auto | <mbps>'];
    if (iface.type !== 'ethernet' && iface.type !== 'wireless') {
      return ['% ' + iface.name + ' has no line rate to set (type ' + iface.type + ')'];
    }
    if (want === 'auto') {
      iface.speedMbps = null;
      this._renegotiate(iface);
      return ['Speed auto-negotiation on ' + iface.name];
    }
    // `speed 1000`, `speed 1G` and `speed 1g` all mean the same port rate; the parser is the one the
    // catalogue uses, so a spelling the specs accept is not refused here.
    const mbps = mediaLib.parseSpeedMbps(want);
    const caps = (iface.hardware && Array.isArray(iface.hardware.speedCaps))
      ? iface.hardware.speedCaps.slice() : [];
    if (mbps === null || !(mbps > 0)) {
      return ['% Invalid rate "' + tokens[0] + '" - give a number of Mbps or auto'];
    }
    if (!caps.length) {
      // Nothing in the catalogue states this port's ladder, so a rate cannot be refused honestly - but it
      // can be stored, and the link verdict will say what it negotiated to.
      iface.speedMbps = mbps;
      this._renegotiate(iface);
      return ['Speed ' + mediaLib.formatSpeedMbps(mbps) + ' on ' + iface.name];
    }
    if (caps.indexOf(mbps) === -1) {
      return ['% ' + iface.name + ' does not support ' + mediaLib.formatSpeedMbps(mbps) +
        ' - it supports ' + caps.map(function (c) { return mediaLib.formatSpeedMbps(c); }).join(', ')];
    }
    iface.speedMbps = mbps;
    this._renegotiate(iface);
    return ['Speed ' + mediaLib.formatSpeedMbps(mbps) + ' on ' + iface.name];
  }

  _duplex(tokens, iface) {
    const want = (tokens[0] || '').toLowerCase();
    if (!['auto', 'full', 'half'].includes(want)) {
      return ['% Usage: duplex auto | full | half'];
    }
    if (iface.type !== 'ethernet') {
      return ['% ' + iface.name + ' has no duplex setting (type ' + iface.type + ')'];
    }
    // `auto` means "let the link decide", and what a link decides in this engine is full duplex.
    iface.duplex = (want === 'auto') ? 'full' : want;
    this._renegotiate(iface);
    return ['Duplex ' + (want === 'auto' ? 'auto (full)' : want) + ' on ' + iface.name];
  }

  // Any change to rate or duplex changes what the cable can do, so the verdict is re-run by the same rule
  // that made it. Invisible when the port is not cabled: there is no link to renegotiate.
  _renegotiate(iface) {
    if (!this.topo || typeof this.topo.renegotiate !== 'function') return null;
    const res = this.topo.renegotiate(this.device.id, iface.name);
    if (!res) return null;
    if (!res.verdict.ok) {
      const why = (res.verdict.errors || []).map(function (e) { return e.message; }).join('; ');
      return { error: why };
    }
    return res;
  }

  // ---------- switchport / VLAN membership ----------
  _switchport(tokens, iface) {
    const vlanLib = require('./vlan');
    const t = tokens.map(function (x) { return String(x).toLowerCase(); });

    if (t[0] === 'reset') {
      iface.vlan = vlanLib.normalizePortConfig({});
      this.device.flushMacsOnPort(iface.name);
      return ['Switchport reset to defaults on ' + iface.name + ' (access VLAN 1)'];
    }
    if (t[0] === 'mode') {
      const mode = t[1];
      if (mode !== 'access' && mode !== 'trunk') return ['% Usage: switchport mode access|trunk'];
      const next = Object.assign({}, iface.vlan, { mode: mode });
      // A trunk with no explicit allowed list must carry everything, otherwise
      // it would silently carry no VLANs at all.
      if (mode === 'trunk' && next.allowedVlans === undefined) next.allowedVlans = 'all';
      iface.vlan = vlanLib.normalizePortConfig(next);
      this.device.flushMacsOnPort(iface.name);
      return ['Switchport mode ' + mode + ' on ' + iface.name];
    }
    if (t[0] === 'access' && t[1] === 'vlan') {
      const id = parseInt(t[2], 10);
      const chk = vlanLib.validatePortConfig({ accessVlan: id });
      if (!chk.ok) return ['% ' + chk.errors[0].message];
      iface.vlan = vlanLib.normalizePortConfig(Object.assign({}, iface.vlan, { mode: 'access', accessVlan: id }));
      this.device.flushMacsOnPort(iface.name);
      return ['Access VLAN ' + id + ' on ' + iface.name];
    }
    if (t[0] === 'trunk' && t[1] === 'native' && t[2] === 'vlan') {
      const id = parseInt(t[3], 10);
      const chk = vlanLib.validatePortConfig({ nativeVlan: id });
      if (!chk.ok) return ['% ' + chk.errors[0].message];
      iface.vlan = vlanLib.normalizePortConfig(Object.assign({}, iface.vlan, { mode: 'trunk', nativeVlan: id }));
      this.device.flushMacsOnPort(iface.name);
      return ['Trunk native VLAN ' + id + ' on ' + iface.name];
    }
    if (t[0] === 'trunk' && t[1] === 'allowed' && t[2] === 'vlan') {
      const spec = t.slice(3).join('');
      if (!spec) return ['% Incomplete command'];
      if (spec === 'all') {
        iface.vlan = vlanLib.normalizePortConfig(Object.assign({}, iface.vlan, { allowedVlans: 'all' }));
        this.device.flushMacsOnPort(iface.name);
        return ['Trunk on ' + iface.name + ' allows all VLANs'];
      }
      const parsed = vlanLib.parseVlanList(spec);
      if (!parsed.ok) return ['% ' + (parsed.message || 'invalid VLAN list')];
      const bad = parsed.vlans.filter(function (v) { return v < 1 || v > 4094; });
      if (bad.length) return ['% VLAN out of range: ' + bad[0]];
      iface.vlan = vlanLib.normalizePortConfig(Object.assign({}, iface.vlan, { mode: 'trunk', allowedVlans: parsed.vlans }));
      this.device.flushMacsOnPort(iface.name);
      return ['Trunk on ' + iface.name + ' allows VLANs ' + parsed.vlans.join(',')];
    }
    return ['% Unrecognized switchport command: ' + t.join(' ')];
  }

  // ---------- link aggregation ----------
  _channelGroup(tokens, iface) {
    const lagLib = require('./lag');
    const dev = this.device;
    const t = tokens.map(function (x) { return String(x).toLowerCase(); });
    if (!dev.config.lags) dev.config.lags = {};

    if (t[0] === 'remove') {
      for (const id of Object.keys(dev.config.lags)) {
        const l = dev.config.lags[id];
        l.members = (l.members || []).filter(function (m) { return m !== iface.name; });
        if (!l.members.length) delete dev.config.lags[id];
      }
      return ['Removed ' + iface.name + ' from any channel group'];
    }

    const id = t[0];
    if (!id) return ['% Usage: channel-group <id> mode active|passive|on'];
    let mode = 'active';
    const mi = t.indexOf('mode');
    if (mi !== -1 && t[mi + 1]) mode = t[mi + 1];
    if (['active', 'passive', 'on', 'static'].indexOf(mode) === -1) {
      return ['% Invalid mode: ' + mode + ' (use active|passive|on)'];
    }
    const g = dev.config.lags[id] || { mode: mode, hashPolicy: 'l2', members: [] };
    g.mode = mode;
    if (g.members.indexOf(iface.name) === -1) g.members.push(iface.name);
    dev.config.lags[id] = g;

    const out = ['Interface ' + iface.name + ' added to channel group ' + id + ' (mode ' + mode + ')'];
    const chk = lagLib.validateLag ? lagLib.validateLag(g) : null;
    if (chk && chk.ok === false && chk.errors && chk.errors.length) {
      out.push('% Warning: ' + chk.errors[0].message);
    }
    return out;
  }

  // ---------- access lists ----------
  _accessList(tokens) {
    const aclLib = require('./acl');
    if (!tokens.length) return ['% Incomplete command'];
    const num = parseInt(tokens[0], 10);
    const kind = aclLib.aclKind(num);
    if (!kind) return ['% Invalid access list number: ' + tokens[0]];
    const entry = aclLib.parseEntry(tokens.slice(1).join(' '), num);
    if (!entry || entry.error) return ['% ' + ((entry && entry.error) || 'invalid entry')];
    const dev = this.device;
    if (!dev.config.acls) dev.config.acls = {};
    const key = String(num);
    if (!dev.config.acls[key]) dev.config.acls[key] = [];
    dev.config.acls[key].push(entry);
    return [kind.charAt(0).toUpperCase() + kind.slice(1) + ' access list ' + num +
      ': ' + entry.action + ' entry added'];
  }

  _accessGroup(tokens, iface) {
    const aclLib = require('./acl');
    const num = parseInt(tokens[0], 10);
    const dir = String(tokens[1] || '').toLowerCase();
    if (!aclLib.aclKind(num)) return ['% Invalid access list number: ' + (tokens[0] || '')];
    if (dir !== 'in' && dir !== 'out') return ['% Usage: ip access-group <acl> in|out'];
    const dev = this.device;
    if (!dev.config.acls || !dev.config.acls[String(num)]) {
      return ['% Access list ' + num + ' does not exist'];
    }
    if (!dev.aclBindings) dev.aclBindings = {};
    if (!dev.aclBindings[iface.name]) dev.aclBindings[iface.name] = {};
    dev.aclBindings[iface.name][dir] = num;
    return ['Interface ' + iface.name + ': access list ' + num + ' applied ' + dir];
  }

  // ---------- config: vrrp (per interface) ----------
  //
  // A group belongs to an interface: the vrid plus the interface is the key, which is why the same
  // vrid can exist on two interfaces of one router without them being the same group.
  _vrrpIfaceCommand(tokens) {
    const vrrpLib = require('./vrrp');
    const out = [];
    const dev = this.device;
    if (!this.iface) return ['% vrrp must be configured inside an interface'];
    const vrid = parseInt(tokens[1], 10);
    if (!Number.isInteger(vrid) || vrid < 1 || vrid > 255) {
      return ['% Invalid virtual router id: ' + (tokens[1] || '(none)') + ' (1-255)'];
    }
    if (!Array.isArray(dev.config.vrrp)) dev.config.vrrp = [];

    const find = function () {
      return dev.config.vrrp.filter(function (g) {
        return g.vrid === vrid && g.interface === this.iface;
      }, this)[0];
    }.bind(this);

    if (tokens[0] === 'no' || tokens[0] === 'no-') {
      // 'no vrrp <vrid>' is dispatched from the config mode handler, not here.
      return null;
    }

    let group = find();
    // The argument is validated BEFORE the group exists: a command that is refused must not leave
    // an empty group behind, or `show vrrp` reports a virtual gateway that was never configured.
    if (!group && !tokens[2]) return ['% Incomplete command: vrrp <vrid> ip <address>'];
    const what = (tokens[2] || '').toLowerCase();
    if (what === 'ip') {
      const ip = tokens[3];
      if (!ip || !net.isIp(ip)) return ['% Invalid address: ' + (tokens[3] || '(none)')];
      // A virtual gateway is only a gateway for hosts on its own wire. Cisco refuses the line
      // ("% 10.0.0.254 is not in the subnet of Gi0/0"), and without this check the election happily
      // makes the router master of a group whose address belongs to a network it cannot reach - the
      // claim then answers ARP from the wrong segment (#1245).
      const port = dev.resolveIface(this.iface);
      if (!port) return ['% No interface ' + this.iface];
      if (!port.ip || !port.mask) {
        return ['% Interface ' + this.iface + ' has no address: a VRRP group needs one in the same subnet'];
      }
      if (!net.sameSubnet(ip, port.ip, port.mask)) {
        return ['% ' + ip + ' is not in the subnet of ' + this.iface +
          ' (' + port.ip + '/' + net.prefixOf(port.mask) + ')'];
      }
      if (!group) {
        group = { vrid: vrid, interface: this.iface, ips: [], priority: 100, preempt: true, advertSec: 1 };
        dev.config.vrrp.push(group);
      }
      if (group.ips.indexOf(ip) === -1) group.ips.push(ip);
      out.push('VRRP group ' + vrid + ' on ' + this.iface + ' owns ' + ip);
    } else if (what === 'priority') {
      if (!group) return ['% No VRRP group ' + vrid + ' on ' + this.iface + ': give it an address first'];
      const p = parseInt(tokens[3], 10);
      if (!Number.isInteger(p) || p < 1 || p > 255) return ['% Invalid priority: ' + (tokens[3] || '(none)') + ' (1-255)'];
      group.priority = p;
      out.push('VRRP group ' + vrid + ' priority ' + p);
    } else if (what === 'preempt') {
      if (!group) return ['% No VRRP group ' + vrid + ' on ' + this.iface];
      group.preempt = !(tokens[0] === 'no');
      out.push('VRRP group ' + vrid + ' preempt ' + (group.preempt ? 'enabled' : 'disabled'));
    } else if (what === 'advertise' || what === 'advertisement') {
      if (!group) return ['% No VRRP group ' + vrid + ' on ' + this.iface];
      const a = Number(tokens[3]);
      if (!Number.isFinite(a) || a <= 0) return ['% Invalid advertisement interval: ' + (tokens[3] || '(none)')];
      group.advertSec = a;
      out.push('VRRP group ' + vrid + ' advertises every ' + a + ' s');
    } else if (what === 'authentication') {
      if (!group) return ['% No VRRP group ' + vrid + ' on ' + this.iface];
      group.authText = tokens.slice(3).join(' ').slice(0, 8);
      out.push('VRRP group ' + vrid + ' authentication set');
    } else {
      return ['% Unrecognized vrrp command: ' + tokens.join(' ')];
    }

    // The library validates the group; report its judgement rather than a second opinion.
    const check = vrrpLib.validateGroup(vrrpLib.normalizeGroup(group));
    if (!check.ok && check.errors.length) {
      for (const e of check.errors) out.push('% ' + e.code + ': ' + (e.message || e.description || ''));
    }
    return out;
  }

  // show vrrp - the state after the last election, which is what an operator checks.
  _showVrrp() {
    const out = [];
    const dev = this.device;
    const groups = Array.isArray(dev.config && dev.config.vrrp) ? dev.config.vrrp : [];
    if (!groups.length) { out.push('% VRRP is not configured'); return out; }
    // The election's own verdict, when there has been one. `show vrrp` used to print this device's name
    // in the Master column for every group, so a backup router advertised itself as the master - the one
    // column an operator reads to find out which box is answering for the gateway (#1241).
    const verdicts = (this.sim && typeof this.sim.vrrpFor === 'function') ? this.sim.vrrpFor(dev.id) : [];
    const claims = (dev.vrrpClaims || []);
    out.push(pad('Interface', 14) + pad('Group', 7) + pad('Pri', 5) + pad('State', 11) +
      pad('Master', 18) + pad('Virtual IP', 16) + 'Virtual MAC');
    for (const g of groups) {
      const verdict = verdicts.filter(function (v) {
        return v.vrid === g.vrid && v.iface === (g.interface || v.iface);
      })[0] || null;
      const claim = claims.filter(function (c) {
        return c.vrid === g.vrid && c.iface === g.interface;
      })[0];
      const port = dev.resolveIface(g.interface);
      // Eligible at all? An interface that is down or unaddressed cannot host the group, and neither can
      // one whose subnet does not contain the virtual address - the command refuses that now, but a
      // topology file written before it existed can still carry such a group (#1245).
      const ips = Array.isArray(g.ips) ? g.ips : [];
      const offSubnet = !!(port && port.ip && port.mask) && ips.length > 0 &&
        !ips.some(function (ip) { return net.sameSubnet(ip, port.ip, port.mask); });
      const outOfIt = !port || port.enabled === false || !port.ip || offSubnet;
      let state;
      let master;
      if (verdict) {
        state = verdict.masterId === dev.id ? 'Master' : 'Backup';
        // "elected but not yet answering" is a real, temporary state and worth showing: the winner is
        // decided, the virtual MAC is not answering ARP for it until the group converges.
        master = (verdict.masterIp || verdict.masterName) + (verdict.owning ? '' : ' (pending)');
      } else if (outOfIt) {
        // VRRP calls a router that is not participating Init. "Backup" would claim it is standing by for
        // a group its own interface cannot reach - whether it is down, unaddressed, or the address is not
        // on this wire at all.
        state = 'Init';
        master = '-';
        if (offSubnet) {
          out.push('% VRRP group ' + g.vrid + ' on ' + g.interface + ': ' + ips.join(',') +
            ' is not in the subnet of ' + port.name + ' (' + port.ip + '/' + net.prefixOf(port.mask) +
            ') - the group cannot take part');
        }
      } else {
        state = claim ? 'Master' : 'Backup';
        master = claim ? (dev.name || dev.id) : '-';
      }
      out.push(pad(String(g.interface), 14) + pad(String(g.vrid), 7) +
        pad(String(g.priority === undefined ? 100 : g.priority), 5) +
        pad(state, 11) +
        pad(master, 18) +
        pad((g.ips || []).join(','), 16) +
        ((verdict && verdict.mac) || (claim && claim.mac) || '-'));
    }
    // The old note fired whenever this device held no claim, and told you to run a simulation even when
    // one had just run. Two different situations, two different sentences.
    if (!verdicts.length && !claims.length) {
      out.push(this.sim
        ? '(this device took part in no VRRP election - check that its interface is up and addressed)'
        : '(no election has run for this device - start a simulation)');
    }
    return out;
  }

  // ---------- config: ip dhcp pool ----------
  //
  // The pool is stored exactly as engine/dhcp.js normalises it at run time, and validated here so a
  // typo is caught while it is typed rather than by a client that never gets an address. The
  // validation is the library's own, not a second opinion: normalizePool() + validatePool().
  _dhcpPoolMode(tokens) {
    const out = [];
    const dhcpLib = require('./dhcp');
    const head = tokens[0].toLowerCase();
    const pools = (this.device.config && this.device.config.dhcpPools) || [];
    const pool = pools.filter(function (p) {
      return p.name === this.pool;
    }, this)[0];
    if (!pool) { this.mode = MODE_CONFIG; return ['% Pool no longer exists']; }

    // A pool is legitimately incomplete while it is being typed - 'network' before 'range' is not an
    // error, it is the second keystroke. Nothing is validated per command; the pool is checked once,
    // when the operator leaves the sub-mode, and again at run time where it matters.
    function incomplete(msg) {
      out.push('% ' + msg);
      return out;
    }

    const finish = (mode) => {
      // Leaving the sub-mode is the first honest moment to judge the pool.
      const check = dhcpLib.validatePool(dhcpLib.normalizePool(pool));
      if (!check.ok) {
        for (const e of check.errors) out.push('% ' + e.code + ': ' + e.message);
      }
      this.mode = mode;
      this.pool = null;
      return out;
    };

    if (head === 'exit') return finish(MODE_CONFIG);
    if (head === 'end') return finish(MODE_EXEC);
    if (head === 'network') {
      if (!tokens[1]) return incomplete('Incomplete command: network <network> [mask|/prefix]');
      pool.network = tokens[1];
      if (tokens[2]) pool.mask = tokens[2];
    } else if (head === 'default-router') {
      if (!tokens[1]) return incomplete('Incomplete command: default-router <address>');
      pool.gateway = tokens[1];
    } else if (head === 'dns-server') {
      if (!tokens[1]) return incomplete('Incomplete command: dns-server <address...>');
      pool.dns = tokens.slice(1).join(' ');
    } else if (head === 'range') {
      if (!tokens[1] || !tokens[2]) return incomplete('Incomplete command: range <start> <end>');
      pool.rangeStart = tokens[1];
      pool.rangeEnd = tokens[2];
    } else if (head === 'excluded-address' || (head === 'excluded' && tokens[1] === 'address')) {
      const from = head === 'excluded' ? 2 : 1;
      const addrs = tokens.slice(from).filter(Boolean);
      if (!addrs.length) return incomplete('Incomplete command: excluded-address <address[-address]>');
      pool.excluded = (Array.isArray(pool.excluded) ? pool.excluded : []).concat(addrs);
    } else if (head === 'lease') {
      // Days by default, like IOS: `lease 0 12 0` is 12 hours.
      const nums = tokens.slice(1).filter(function (x) { return /^\d+$/.test(x); }).map(Number);
      if (!nums.length) return incomplete('Incomplete command: lease <days> [hours] [minutes]');
      const days = nums[0] || 0, hours = nums[1] || 0, mins = nums[2] || 0;
      const sec = days * 86400 + hours * 3600 + mins * 60;
      if (sec <= 0) return incomplete('A lease must be longer than zero');
      pool.leaseSec = String(sec);
    } else if (head === 'host') {
      // host <address> <hardware-address> - a reservation, which is how a printer keeps its address.
      if (!tokens[1] || !tokens[2]) return incomplete('Incomplete command: host <address> <mac>');
      if (!pool.reservations) pool.reservations = {};
      pool.reservations[tokens[2]] = tokens[1];
    } else if (head === 'no') {
      const what = (tokens[1] || '').toLowerCase();
      if (what === 'default-router') delete pool.gateway;
      else if (what === 'dns-server') delete pool.dns;
      else if (what === 'range') { delete pool.rangeStart; delete pool.rangeEnd; }
      else if (what === 'lease') delete pool.leaseSec;
      else if (what === 'excluded-address') pool.excluded = [];
      else if (what === 'pool') {
        this.device.config.dhcpPools = pools.filter(function (p) { return p.name !== this.pool; }, this);
        this.mode = MODE_CONFIG;
        this.pool = null;
        out.push('Removed DHCP pool');
        return out;
      }
      return out;
    } else {
      return ['% Unrecognized DHCP pool command: ' + tokens.join(' ')];
    }

    return out;
  }

  // ---------- ping ----------
  //
  // `ping 10.0.0.2` and `ping 10.0.0.2 5 at 5000` - the last form asks the question 5 seconds after
  // power-on, which is the only way to watch a lab come up. Real hardware prints a time in
  // milliseconds; this prints the delay the engine computed from the path (propagation +
  // serialisation + store-and-forward), and falls back to the hop count if a link has no length.
  _ping(tokens) {
    const out = [];
    const ip = tokens[0];
    let count = 4;
    let atMs = null;
    for (let i = 1; i < tokens.length; i++) {
      if (tokens[i] === 'at' && tokens[i + 1]) { atMs = Number(tokens[i + 1]); i++; continue; }
      const n = parseInt(tokens[i], 10);
      if (Number.isFinite(n) && n > 0) count = n;
    }
    if (!ip || !net.isIp(ip)) return ['% Invalid ping target: ' + (ip || '(none)')];
    if (!this.sim) return ['% Simulator not attached'];
    if (atMs !== null) {
      if (!Number.isFinite(atMs) || atMs < 0) return ['% Invalid instant: ' + tokens[tokens.indexOf('at') + 1]];
      this.sim.setRunTime(atMs);
    }
    out.push('Type escape sequence to abort.');
    out.push('Sending ' + count + ', 100-byte ICMP Echos to ' + ip + ', timeout is 2 seconds:' +
      (atMs !== null ? '  (at t=' + atMs + ' ms)' : ''));
    const res = this.sim.ping(this.device.id, ip, { count: count });
    const marks = res.replies.map(function (r) { return r.success ? '!' : '.'; }).join('');
    out.push(marks);
    const ok = res.replies.filter(function (r) { return r.success; }).length;
    out.push('Success rate is ' + Math.round((ok / count) * 100) + ' percent (' + ok + '/' + count + ')');
    for (const r of res.replies) {
      if (r.success) {
        const t = (r.rtt === null || r.rtt === undefined)
          ? (r.hops + ' hops')
          : (r.rtt < 1 ? r.rtt.toFixed(3) : r.rtt.toFixed(1)) + ' ms';
        out.push('Reply from ' + ip + ': bytes=100 time=' + t);
      } else if (r.reason === 'converging') {
        // Not "request timed out": nothing was lost, the network is not up yet.
        const who = (r.pending || []).map(function (p) { return p.process + ' on ' + p.device; }).join(', ');
        out.push('% Still converging at t=' + atMs + ' ms: ' + who +
          (r.convergingUntilMs !== null ? ' (ready at ' + r.convergingUntilMs + ' ms)' : ''));
      } else {
        out.push('Request timed out (seq ' + r.seq + ')');
      }
    }
    return out;
  }

  // ---------- converge ----------
  //
  // The answer to "when is it up?" - every process, every device, in the order they finish.
  _converge(tokens) {
    if (!this.sim) return ['% Simulator not attached'];
    const sched = this.sim.getConvergence();
    const out = [];
    if (!sched.entries.length) {
      out.push('% Nothing in this lab runs a control plane that converges over time');
      return out;
    }
    const atMs = tokens[0] !== undefined ? Number(tokens[0]) : null;
    out.push('Process   Device                 Ready   Basis');
    for (const e of sched.entries) {
      const mark = (atMs !== null && Number.isFinite(atMs) && e.readyAtMs > atMs) ? '  (pending)' : '';
      out.push(pad(e.process, 10) + pad(String(e.device.name || e.deviceId), 23) +
        pad(e.readyAtMs + ' ms', 10) + (e.basis || '') + mark);
    }
    out.push('');
    out.push('Fully converged at ' + sched.convergedAtMs + ' ms.' +
      (sched.fromMs ? ' (re-based at the link change at ' + sched.fromMs + ' ms)' : ''));
    return out;
  }

  // ---------- cables ----------
  /**
   * link <up|down|state> <linkId> [at <ms>]
   *
   * The one operation a lab reaches for most often, and the one the engine had no word for: take a
   * cable down without unplugging it. `at <ms>` is when, in milliseconds since power-on, so a script
   * can say "the uplink fails at 10 s" and then ask what happens at 11 s.
   */
  _link(args) {
    if (!this.sim) return ['% Simulator not attached'];
    const out = [];
    const what = (args[0] || '').toLowerCase();
    const id = args[1];
    if (!what || what === '?') {
      return ['  link <up|down|state> <linkId> [at <ms>]',
              '  links                            - list every cable and its state'];
    }
    if (what === 'state' || what === 'show') {
      const l = this.topo.links.get(id);
      if (!l) return ['% No such link: ' + (id || '(none)')];
      out.push('Link ' + l.id + '  ' + this._endpointName(l.a) + ' <-> ' + this._endpointName(l.b));
      out.push('  state: ' + l.state + (l.stateSinceMs ? ' since ' + l.stateSinceMs + ' ms' : ''));
      return out;
    }
    if (what !== 'up' && what !== 'down') {
      return ['% Invalid input: link ' + args.join(' ') + ' - expected up, down or state'];
    }
    if (!id) return ['% Incomplete command: link ' + what + ' <linkId>'];

    let atMs = 0;
    const at = args.indexOf('at');
    if (at !== -1) {
      atMs = Number(args[at + 1]);
      if (!Number.isFinite(atMs) || atMs < 0) return ['% Invalid time: ' + (args[at + 1] || '(none)')];
    }

    const res = this.sim.setLinkState(id, what, { atMs: atMs });
    if (!res.ok) return ['% ' + (res.code || 'refused') + (res.detail ? ': ' + res.detail : '')];
    if (!res.changed) {
      out.push('Link ' + id + ' is already ' + what + '.');
      return out;
    }

    const link = this.topo.links.get(id);
    out.push('Link ' + id + ' (' + this._endpointName(link.a) + ' <-> ' +
      this._endpointName(link.b) + ') is now ' + what + '.');
    // The number a lab actually cares about: when the network has finished reacting.
    out.push('Network converges again at ' + res.reconvergeAtMs + ' ms.');
    return out;
  }

  _links() {
    const out = ['Link   Endpoints                                                  State'];
    for (const l of this.topo.links.values()) {
      out.push(pad(l.id, 7) + pad(this._endpointName(l.a) + ' <-> ' + this._endpointName(l.b), 59) +
        l.state);
    }
    return out;
  }

  _endpointName(end) {
    const dev = this.topo.getDevice(end.deviceId);
    return (dev ? dev.name : end.deviceId) + ':' + end.iface;
  }

  // ---------- show ----------
  // show ip bgp [summary]
  //
  // The interesting column is State, and the interesting news is that it can be something
  // other than Established. Before the session walk existed, every configured neighbour was
  // Established by definition - which is the one thing a lab must not teach, because the
  // whole skill is reading Active or OpenSent and knowing what it means.
  _showBgp(args) {
    const dev = this.device;
    const cfg = dev.config && dev.config.bgp;
    const out = [];
    if (!cfg || !cfg.as) { out.push('% BGP is not enabled'); return out; }

    const rows = dev.bgpNeighbors || [];
    out.push('BGP router identifier ' + (dev.bgpRouterId || cfg.routerId || '0.0.0.0') +
      ', local AS number ' + cfg.as);
    out.push('');
    out.push(pad('Neighbor', 17) + pad('V', 3) + pad('AS', 8) + pad('State', 16) + 'Reason');
    if (!rows.length) {
      out.push('(no neighbours have been evaluated yet - run a simulation)');
    } else {
      for (const r of rows) {
        out.push(pad(r.address, 17) + pad('4', 3) + pad(String(r.remoteAs == null ? '?' : r.remoteAs), 8) +
          pad(r.established ? 'Established' : 'Idle', 16) +
          (r.established ? (r.session === 'ibgp' ? 'iBGP' : 'eBGP') : (r.reason || r.code || '')));
      }
    }
    const up = rows.filter(function (r) { return r.established; }).length;
    out.push('');
    out.push(up + ' of ' + rows.length + ' neighbour(s) established');
    const learned = (dev.bgpRoutes || []).length;
    out.push(learned + ' prefix(es) installed from BGP');
    return out;
  }

  // "speed: 1Gb/s (auto), duplex: full" - or the forced rate, plainly marked, with what the link actually
  // negotiated when the two differ.
  _linkRateLine(iface) {
    const rated = mediaLib.parseSpeedMbps(iface.speed);
    const forced = iface.speedMbps || null;
    const devId = this.device && this.device.id;
    const link = (this.topo && this.topo.links && iface.peer && devId)
      ? [...this.topo.links.values()].filter(function (l) {
        return (l.a.deviceId === devId && l.a.iface === iface.name) ||
          (l.b.deviceId === devId && l.b.iface === iface.name);
      })[0]
      : null;
    const negotiated = (link && link.speedMbps) ? link.speedMbps : null;
    const fmt = function (m) { return m ? mediaLib.formatSpeedMbps(m) + 'b/s' : 'unknown'; };
    let text = 'speed: ' + (forced ? fmt(forced) + ' (forced)' : fmt(rated) + ' (auto)');
    if (link && link.negotiationFailed) {
      // The two ends were forced to rates with nothing in common. Saying "1Gb/s (forced)" and moving on
      // would describe a link that is not carrying anything.
      text += ', link: down (no common rate with the peer)';
    } else if (negotiated && negotiated !== (forced || rated)) {
      text += ', link runs at ' + fmt(negotiated);
    }
    text += ', duplex: ' + (iface.duplex || 'full');
    return text;
  }

  // "3 drops (no route to 10.0.0.99 x2, link down x1)" - reasons longest-first, then a count of whatever
  // did not fit, so a port with forty distinct reasons cannot turn one block into a wall.
  _dropSummary(drops, limit) {
    if (!drops || !drops.total) return '';
    const max = limit || 3;
    const pairs = Object.keys(drops.byReason || {})
      .map(function (why) { return [why, drops.byReason[why]]; })
      .sort(function (a, b) { return (b[1] - a[1]) || a[0].localeCompare(b[0]); });
    const shown = pairs.slice(0, max).map(function (p) {
      return p[0] + (p[1] > 1 ? ' x' + p[1] : '');
    });
    const rest = pairs.length - shown.length;
    return drops.total + (drops.total === 1 ? ' drop' : ' drops') +
      (shown.length ? ' (' + shown.join(', ') + (rest > 0 ? ', and ' + rest + ' more reason' + (rest === 1 ? '' : 's') : '') + ')' : '');
  }

  // "Is this port still somewhere a frame can go, and if not why" - the sentence both tables append to a
  // stale row. One helper so `show arp` and `show mac address-table` cannot describe the same port state
  // two different ways.
  _staleNote(port, extra) {
    if (!port) return extra || '(gone)';
    const link = this.device.ifaceStatus(port, this.topo);
    if (link.status === 'up') return extra || '';
    // `administratively down` already says who did it; "shut down" after it would be the same fact twice.
    const why = (!link.reason || link.reason === 'shut down' || link.reason === link.status)
      ? link.status : link.status + ': ' + link.reason;
    return '(' + why + ')';
  }

  _show(tokens) {
    const what = (tokens[0] || '').toLowerCase();
    const dev = this.device;
    const out = [];
    if (what === 'version' || what === 'ver') {
      out.push(this._banner());
      out.push('Vendor     : ' + dev.vendor);
      out.push('Model      : ' + dev.model + ' (' + dev.label + ')');
      out.push('Category   : ' + dev.category);
      out.push('Capabilities: ' + dev.capabilities.join(', '));
      out.push('Interfaces : ' + dev.interfaces.size);
      out.push('Simulator  : PacketForge 0.1.0');
    } else if (what === 'ip' && tokens[1] === 'interface' && tokens[2] === 'brief') {
      out.push('Interface              IP-Address      OK? Method Status                Protocol');
      for (const i of dev.interfaces.values()) {
        const ip = i.ip ? i.ip + '/' + net.prefixOf(i.mask) : 'unassigned';
        // Status is whether the port can carry a frame, not merely whether someone shut it (#1237).
        // The topology has to be passed in: it is the only thing that knows a cable is missing.
        const link = dev.ifaceStatus(i, this.topo);
        out.push(pad(i.name, 22) + pad(ip, 16) + 'YES  ' + pad(i.dhcp ? 'DHCP' : 'manual', 8) +
          pad(link.status, 22) + link.protocol);
      }
    } else if (what === 'ip' && tokens[1] === 'route') {
      // The legend has to name every code the table can produce: routesTable() emits O (OSPF) and B
      // (BGP) rows as well as C and S, and an undefined code in the legend is a code the reader has to
      // guess at (#1234).
      out.push('Codes: C - connected, S - static, O - OSPF, B - BGP');
      const rows = dev.routesTable();

      // The administrative distance of a route source, in one place: the table prints it and the
      // gateway line sorts by it, so the two can never disagree (#1234).
      const distanceOf = function (r) {
        if (r.type === 'connected') return 0;
        if (r.type === 'static') return 1;
        if (r.type === 'ospf') return 110;
        if (r.type === 'bgp') return (r.ad === undefined || r.ad === null) ? 200 : r.ad;
        if (r.type === 'default') return 254;
        return 1;
      };

      // "Gateway of last resort" names the default that is actually installed — the one routeTo()
      // would pick among the candidates: longest prefix first, then lowest distance. A configured
      // gateway (254) loses to a static default (1), and printing the losing one would send the reader
      // after a next hop no packet ever uses.
      const fallback = rows
        .filter(function (r) { return r.mask === '0.0.0.0' && r.gw && r.gw !== '-'; })
        .sort(function (a, b) { return distanceOf(a) - distanceOf(b); })[0];
      if (fallback) out.push('Gateway of last resort is ' + fallback.gw + ' to network 0.0.0.0');

      for (const r of rows) {
        const prefix = net.prefixOf(r.mask);
        const dest = pad(r.dest, 15) + '/' + prefix;
        if (r.type === 'connected') {
          out.push('C   ' + dest + '  is directly connected, ' + r.iface);
          continue;
        }
        // [administrative distance/metric] - the distance is half of the rule that picks the installed
        // route (longest prefix first, then lowest distance), so a table without it cannot be checked
        // by reading.
        const code = r.type === 'default' ? 'S*' : r.code;
        const distance = distanceOf(r);
        // Three columns whatever the code length, so `S*` does not shift the whole row.
        out.push((code.length === 1 ? code + '  ' : code + ' ') + dest + '  [' + distance + '/0] via ' + r.gw +
          (r.iface && r.iface !== '-' ? '  ' + r.iface : ''));
      }
    } else if (what === 'ip' && tokens[1] === 'bgp') {
      out.push.apply(out, this._showBgp(tokens.slice(2)));
    } else if (what === 'ipv6' && tokens[1] === 'nd') {
      out.push.apply(out, this._showIpv6Nd());
    } else if (what === 'lldp') {
      // The table that answers "what is plugged into this port" - and it is honest,
      // because it is filled from LLDPDUs that actually crossed the link rather than
      // from the topology file. An empty table means nothing has announced itself.
      out.push('LLDP neighbours on ' + dev.name + ':');
      const rows = Array.from(dev.lldp.entries());
      if (!rows.length) {
        out.push('  ' + pad('Neighbour', 20) + pad('Local port', 16) + pad('Port ID', 16) + 'Mgmt address');
        out.push('  (none - no LLDP has been heard on any port)');
      } else {
        // Column widths come from the data. A fixed 20-character Neighbour column ran a 55-character router
        // name into the Local port column, so the row could not be read field by field - and the one thing
        // this table is for is answering "what is on that port" (#1265).
        const cells = rows.map(function (r) {
          const port = r[0];
          const nb = r[1] || {};
          const iface = dev.resolveIface(port);
          // A neighbour is not "here" because we once heard it: an entry whose port can no longer carry a
          // frame is stale, and the row has to say so. Reached for the same sentence `show arp` and
          // `show mac address-table` use, because it is the same fact about the same port.
          const note = iface ? this._staleNote(iface) : '(gone)';
          return {
            name: nb.systemName || '?',
            port: port + (note ? ' ' + note : ''),
            portId: nb.portId || '?',
            mgmt: nb.mgmtIp || '-'
          };
        }, this);
        const w = function (key) {
          return cells.reduce(function (max, c) { return Math.max(max, String(c[key]).length); }, 0) + 2;
        };
        const wName = Math.max(w('name'), 11), wPort = Math.max(w('port'), 12);
        const wId = Math.max(w('portId'), 9);
        out.push('  ' + pad('Neighbour', wName) + pad('Local port', wPort) + pad('Port ID', wId) +
          'Mgmt address');
        for (const c of cells) {
          out.push('  ' + pad(c.name, wName) + pad(c.port, wPort) + pad(c.portId, wId) + c.mgmt);
        }
      }
    } else if (what === 'access-lists' || what === 'access-list') {
      const aclLib = require('./acl');
      const acls = dev.config.acls || {};
      const ids = Object.keys(acls).sort(function (a, b) { return parseInt(a, 10) - parseInt(b, 10); });
      if (!ids.length) out.push('% No access lists configured');
      const binds = dev.aclBindings || {};
      const hits = dev.aclHits;
      for (const id of ids) {
        const kind = aclLib.aclKind(parseInt(id, 10));
        out.push((kind === 'standard' ? 'Standard' : 'Extended') + ' IP access list ' + id);
        const tally = hits ? hits[String(id)] : null;
        let n = 1;
        for (const e of acls[id]) {
          // Which line is doing the denying is the question this table is opened for. A rule that matched
          // nothing says nothing - printing "(0 matches)" beside every line of a twenty-line ACL is noise,
          // and the absence of a count is the same statement.
          const ruleText = e.line || (e.action + ' ' + (e.protocol || 'ip'));
          const count = tally && tally.entries[ruleText] ? tally.entries[ruleText] : 0;
          out.push('  ' + (n++) + ' ' + ruleText +
            (count ? ' (' + count + (count === 1 ? ' match' : ' matches') + ')' : ''));
        }
        if (tally && tally.implicit) {
          // The implicit deny exists whether or not anyone wrote it, and it is what drops the traffic that
          // matched nothing. Real gear prints it once it has fired.
          out.push('  (implicit deny all: ' + tally.implicit +
            (tally.implicit === 1 ? ' match' : ' matches') + ')');
        }
        if (!tally) {
          // "Nothing matched" and "nothing has looked" are different answers (#1252) - and "no run" is
          // different again from "a run, but no packet came through here".
          out.push(this.sim
            ? '  counters: no packet has been tested against this list'
            : '  counters: not measured (no simulation run)');
        }
        for (const k of Object.keys(binds)) {
          if (String(binds[k].in) === String(id)) out.push('    applied IN on ' + k);
          if (String(binds[k].out) === String(id)) out.push('    applied OUT on ' + k);
        }
      }
    } else if (what === 'vrrp') {
      out.push.apply(out, this._showVrrp());
    } else if (what === 'vlan') {
      // One table, and one row per VLAN.
      //
      // It printed two: trunks listed under the VLANs they carry, and then an extra pseudo-row called
      // `all` rendered as VLAN 1 - so VLAN 1 appeared twice with the same ports, and a trunk that carries
      // every VLAN was reported as a member of VLAN 1 and of nothing else. Membership is now decided by
      // `classifyEgress()`, the same rule the data plane forwards by, so the table cannot list a port the
      // switch would drop for, or omit one it would forward to (#1261).
      const vlanSet = new Set();
      const named = dev.config.vlans || {};
      Object.keys(named).forEach(function (k) { vlanSet.add(Number(k)); });
      vlanSet.add(1);
      for (const i of dev.interfaces.values()) {
        const v = i.vlan || {};
        if (v.mode === 'trunk') {
          vlanSet.add(Number(v.nativeVlan) || 1);
          if (Array.isArray(v.allowedVlans)) v.allowedVlans.forEach(function (id) { vlanSet.add(Number(id)); });
        } else {
          vlanSet.add(Number(v.accessVlan) || 1);
        }
      }
      // A trunk with `allowedVlans: all` carries every VLAN in the table, so it is listed in each row.
      const ids = Array.from(vlanSet).filter(function (id) { return Number.isFinite(id) && id >= 1; })
        .sort(function (a, b) { return a - b; });
      out.push(pad('VLAN', 8) + pad('Name', 33) + pad('Status', 10) + 'Ports');
      for (const id of ids) {
        const members = [];
        for (const i of dev.interfaces.values()) {
          const verdict = vlanLib.classifyEgress(i.vlan, id);
          if (verdict.action === 'drop') continue;
          members.push(i.name);
        }
        const name = (named[id] && named[id].name)
          || (id === 1 ? 'default' : 'VLAN' + String(id).padStart(4, '0'));
        out.push(pad(id, 8) + pad(name, 33) + pad('active', 10) + members.join(', '));
      }
    } else if (what === 'spanning-tree') {
      const st = dev.stp || { states: {}, roles: {}, blocked: new Set() };
      const names = Object.keys(st.states || {}).sort();
      out.push('Spanning tree enabled protocol ieee');
      if (!names.length) {
        // With nothing having run, "no ports are bridging" is a claim the command cannot make - the same
        // distinction `show interfaces` makes for its counters (#1252). Both answers used to be the same
        // sentence, so a lab that had never been simulated reported itself as loop-free (#1261).
        out.push(this.sim
          ? '  No ports are bridging: this device is not part of an L2 loop.'
          : '  Not measured (no simulation run): nothing has computed the spanning tree.');
      } else {
        out.push('Port          Role          State');
        for (const n of names) {
          const role = (st.roles || {})[n] || '-';
          out.push(pad(n, 14) + pad(role, 14) + st.states[n] +
            (st.states[n] === 'blocking' ? '   (traffic dropped)' : ''));
        }
      }
    } else if (what === 'etherchannel') {
      const lags = dev.config.lags || {};
      const ids = Object.keys(lags).sort();
      if (!ids.length) {
        out.push('% No link aggregation groups configured');
      } else {
        const lagLib = require('./lag');
        out.push('Group  Protocol   Ports');
        for (const id of ids) {
          const l = lags[id] || {};
          const raw = Array.isArray(l.members) ? l.members : [];
          // Bundled (P) or down (D) is a statement about the link, not just about spanning tree: a member
          // whose cable is out used to read (P), i.e. "this port is carrying traffic", while it was
          // dropping everything hashed to it (#1263).
          const why = {};
          const canCarry = (function (self, reasons) {
            return function (name) {
              const iface = dev.interfaces.get(name);
              if (!iface) { reasons[name] = '(no such port)'; return false; }
              if (dev.stp && dev.stp.blocked && dev.stp.blocked.has(name)) {
                reasons[name] = '(STP blocking)';
                return false;
              }
              // The same sentence `show interfaces` and `show arp` use for the same fact.
              const note = self._staleNote(iface);
              if (note) { reasons[name] = note; return false; }
              return true;
            };
          })(this, why);
          const live = lagLib.eligibleMembers(raw, canCarry);
          const shown = raw.map(function (m) {
            return m + (live.indexOf(m) === -1 ? '(D)' : '(P)');
          });
          out.push(pad(id, 7) + pad(l.mode || 'static', 11) + shown.join(' '));
          // Why a member is not carrying, in the same words `show interfaces` uses, and what that means for
          // the bundle as a whole.
          for (const m of raw) {
            if (live.indexOf(m) === -1) {
              out.push('  ' + pad(m, 10) + 'not bundled ' + (why[m] || '(cannot carry a frame)'));
            }
          }
          if (!live.length && raw.length) {
            out.push('  bundle ' + id + ' is down: no member can carry a frame (traffic is dropped)');
          } else if (live.length < raw.length) {
            out.push('  bundle ' + id + ' is running on ' + live.length + ' of ' + raw.length +
              ' members: ' + live.join(', '));
          }
        }
      }
    } else if (what === 'arp') {
      // The Interface column used to be a header over nothing - every row stopped at the MAC - so the one
      // table that tells you which port a neighbour is on could not tell you (#1253). It also presented
      // every entry as a live neighbour: an entry learned on a port that has since gone down is a stale
      // cache entry, not evidence that the address is still reachable, and that is exactly the state you
      // are in when you run this command.
      out.push(pad('Protocol', 10) + pad('Address', 17) + pad('Age (min)', 11) +
        pad('Hardware Addr', 18) + 'Interface');
      const rows = [];
      for (const [ip, mac] of dev.arp.entries()) {
        const portName = (dev.arpPorts && dev.arpPorts.get(ip)) || null;
        let note = '-';
        if (portName) {
          const port = dev.resolveIface(portName);
          if (!port) {
            note = portName + ' (gone)';
          } else {
            // The reason travels with the status here too: "down" alone sends you looking for a cable
            // when the cable is fine and the far port is shut (#1253).
            const stale = this._staleNote(port);
            note = port.name + (stale ? ' ' + stale : '');
          }
        }
        // Age is not modelled: the simulator has steps, not minutes, and printing a step count in a
        // minutes column would be a number with the wrong unit. '-' is what a device prints for an entry
        // it cannot age, and is honest here.
        rows.push([ip, mac, note]);
      }
      rows.sort(function (a, b) { return String(a[0]).localeCompare(String(b[0]), undefined, { numeric: true }); });
      for (const r of rows) {
        out.push(pad('Internet', 10) + pad(r[0], 17) + pad('-', 11) + pad(r[1], 18) + r[2]);
      }
    } else if (what === 'mac' && tokens[1] === 'address-table') {
      out.push(pad('Vlan', 8) + pad('Mac Address', 20) + pad('Type', 12) + 'Ports');
      const rows = [];
      for (const [mac, iface] of dev.macTable.entries()) rows.push([1, mac, iface]);
      for (const [vid, table] of (dev.macTables || new Map()).entries()) {
        for (const [mac, iface] of table.entries()) rows.push([vid, mac, iface]);
      }
      rows.sort(function (a, b) { return (a[0] - b[0]) || String(a[1]).localeCompare(String(b[1])); });
      for (const r of rows) {
        // Where the entry points, and whether that is still somewhere a frame for this VLAN can go. A
        // MAC learned before its port was shut or moved keeps its row - real switches age entries out,
        // this one does not - so the row has to say that it is stale rather than read as current (#1255).
        const where = (r[2] && typeof r[2] === 'object') ? r[2] : dev.resolveIface(r[2]);
        const name = where ? where.name : String(r[2]);
        // A port that no longer carries this VLAN cannot be the way to a MAC in it, even while the port
        // itself is up: moving a port between VLANs is exactly how that happens.
        const mismatch = (where && vlanLib.classifyEgress(where.vlan, r[0]).action === 'drop')
          ? '(vlan mismatch)' : '';
        const note = this._staleNote(where, mismatch);
        out.push(pad(r[0], 8) + pad(r[1], 20) + pad('DYNAMIC', 12) + name + (note ? ' ' + note : ''));
      }
    } else if (what === 'interfaces' || what === 'interface') {
      for (const i of dev.interfaces.values()) {
        out.push(i.name + ' (' + i.type + ', ' + i.speed + '), MAC ' + i.mac);
        // The reason travels with the status: this block used to print `status: up` directly above
        // `peer: disconnected`, which is two halves of the same output disagreeing (#1237).
        const link = dev.ifaceStatus(i, this.topo);
        out.push('  status: ' + link.status +
          (link.reason ? ' (' + link.reason + ')' : '') +
          ', protocol: ' + link.protocol +
          (i.description ? ', desc: ' + i.description : ''));
        out.push('  ip: ' + (i.ip ? i.ip + '/' + net.prefixOf(i.mask) : 'unassigned') + (i.dhcp ? ' (dhcp)' : ''));
        out.push('  peer: ' + (i.peer ? i.peer.deviceId + '/' + i.peer.iface : 'disconnected'));
        // The rate the link actually runs at, and whether anybody forced it. A forced 100 on a 1G port is
        // the answer to "why is this link slow", so it belongs in the block you read to ask (#1259).
        out.push('  ' + this._linkRateLine(i));
        // What has actually crossed this socket. The simulator counted it all along, per device, so the
        // command could not answer the one question it is opened for: is traffic flowing on THIS port?
        // Counted wherever a frame is enqueued and received, including frames later dropped - a frame the
        // ACL threw away was still received (#1251).
        const counters = (this.sim && typeof this.sim.portCounters === 'function')
          ? this.sim.portCounters(dev.id, i.name) : null;
        if (counters) {
          out.push('  ' + counters.packetsIn + ' packets input, ' + counters.bytesIn + ' bytes');
          out.push('  ' + counters.packetsOut + ' packets output, ' + counters.bytesOut + ' bytes');
          // What the port threw away, next to what it carried. Two datagrams dropped for want of a route
          // used to read as a quiet port: "0 packets input" beside a ping that failed twice (#1257).
          const dropped = this._dropSummary(counters.drops);
          if (dropped) out.push('  ' + dropped);
        } else {
          // "Not measured" and "measured zero" are different answers; printing zeros without a run would
          // claim the port is idle when nothing has looked.
          out.push('  counters: not measured (no simulation run)');
        }
      }
      // Drops that never named a port ("no route to 10.0.0.99" happens before an egress is chosen) belong
      // at the end of the whole table, not invented onto whichever port happens to be printed first.
      const deviceDrops = (this.sim && typeof this.sim.dropsFor === 'function')
        ? this.sim.dropsFor(dev.id) : null;
      if (deviceDrops && deviceDrops.unported) {
        const line = this._dropSummary({ total: deviceDrops.unported, byReason: deviceDrops.byReason });
        out.push('device-wide ' + line);
      }
    } else if (what === 'running-config' || what === 'run') {
      out.push('! PacketForge running-config');
      out.push('hostname ' + (dev.config.hostname || dev.name));
      for (const i of dev.interfaces.values()) {
        out.push('interface ' + i.name);
        if (i.description) out.push('  description ' + i.description);
        // Only when forced: a config that emits `speed auto` on every port is noise, and the round trip
        // already asserts that nothing configured is left out (#1259).
        if (i.speedMbps) out.push('  speed ' + i.speedMbps);
        if (i.duplex && i.duplex !== 'full') out.push('  duplex ' + i.duplex);
        if (i.parent) out.push('  encapsulation dot1q ' + i.encapVid);
        if (i.ip) out.push('  ip address ' + i.ip + ' ' + i.mask);
        else if (i.dhcp) out.push('  ip address dhcp');
        if (i.vlan) {
          if (i.vlan.mode === 'trunk') {
            out.push('  switchport mode trunk');
            out.push('  switchport trunk native vlan ' + i.vlan.nativeVlan);
            const av = i.vlan.allowedVlans;
            out.push('  switchport trunk allowed vlan ' +
              (av === 'all' || !Array.isArray(av) ? 'all' : av.join(',')));
          } else {
            const av = Number(i.vlan.accessVlan) || 1;
            if (av !== 1) {
              out.push('  switchport mode access');
              out.push('  switchport access vlan ' + av);
            }
          }
        }
        const lag = dev.lagFor ? dev.lagFor(i.name) : null;
        if (lag) out.push('  channel-group ' + lag.id + ' mode ' + (lag.mode || 'on'));
        const binds = dev.aclBindings && dev.aclBindings[i.name];
        if (binds && binds.in != null) out.push('  ip access-group ' + binds.in + ' in');
        if (binds && binds.out != null) out.push('  ip access-group ' + binds.out + ' out');
        if (!i.enabled) out.push('  shutdown');
        // A VRRP group belongs to an interface, so it is printed inside that interface's block - the
        // only place the config parser will accept it. It used to be printed nowhere at all: the
        // group existed, `show vrrp` reported it, and a config saved from the device had no trace of
        // it (#1232).
        for (const g of (dev.config.vrrp || [])) {
          if (!g || g.interface !== i.name) continue;
          for (const ip of (g.ips || [])) out.push('  vrrp ' + g.vrid + ' ip ' + ip);
          if (g.priority !== undefined && g.priority !== null && g.priority !== 100) {
            out.push('  vrrp ' + g.vrid + ' priority ' + g.priority);
          }
          if (g.preempt === false) out.push('  no vrrp ' + g.vrid + ' preempt');
          if (g.advertSec !== undefined && g.advertSec !== null && Number(g.advertSec) !== 1) {
            out.push('  vrrp ' + g.vrid + ' advertise ' + g.advertSec);
          }
          if (g.authText) out.push('  vrrp ' + g.vrid + ' authentication ' + g.authText);
        }
        // Close the block. Without this the next `interface` line is read while still inside the
        // previous block, every following line is parsed as an interface command, and a pasted config
        // applies its addresses and shutdowns to whichever interface was current (#1230).
        out.push('exit');
      }
      // The VLAN table: the ids exist because someone typed `vlan <id> <name>`, and without these
      // lines a restored config has ports in VLAN 42 with no VLAN 42 (#1232).
      const vlans = dev.config.vlans || {};
      for (const id of Object.keys(vlans).sort(function (a, b) { return Number(a) - Number(b); })) {
        const v = vlans[id] || {};
        out.push('vlan ' + id + (v.name ? ' ' + v.name : ''));
      }

      // DHCP pools. A pool is a sub-mode, so each one closes with `exit` before the next begins.
      for (const pool of (dev.config.dhcpPools || [])) {
        if (!pool || !pool.name) continue;
        out.push('ip dhcp pool ' + pool.name);
        if (pool.network) out.push('  network ' + pool.network + (pool.mask ? ' ' + pool.mask : ''));
        if (pool.rangeStart) out.push('  range ' + pool.rangeStart + (pool.rangeEnd ? ' ' + pool.rangeEnd : ''));
        if (pool.gateway) out.push('  default-router ' + pool.gateway);
        if (pool.dns) out.push('  dns-server ' + pool.dns);
        for (const ex of (Array.isArray(pool.excluded) ? pool.excluded : [])) out.push('  excluded-address ' + ex);
        if (pool.leaseSec) {
          // Seconds back to the days/hours/minutes the command takes. Only whole minutes survive the
          // round trip, which is every value the command itself can express.
          const sec = Number(pool.leaseSec);
          if (Number.isFinite(sec) && sec > 0) {
            const days = Math.floor(sec / 86400);
            const hours = Math.floor((sec % 86400) / 3600);
            const mins = Math.floor((sec % 3600) / 60);
            out.push('  lease ' + days + ' ' + hours + ' ' + mins);
          }
        }
        // `reservations` is keyed by hardware address and holds the address it is pinned to, while the
        // command reads `host <address> <hardware-address>` - so the key is printed second.
        const reservations = pool.reservations || {};
        for (const mac of Object.keys(reservations)) out.push('  host ' + reservations[mac] + ' ' + mac);
        out.push('exit');
      }

      // DNS zones and their records. `dns add` answers under the zone last named, so the zone line
      // must come first and no `exit` may come between it and its records.
      for (const z of (dev.config.dnsZones || [])) {
        if (!z || !z.name) continue;
        out.push('dns zone ' + z.name);
        for (const r of (z.records || [])) {
          if (!r || !r.name) continue;
          out.push('  dns add ' + r.name + ' ' + (r.type || 'A') + ' ' + r.value);
        }
      }

      const allAcls = dev.config.acls || {};
      for (const id of Object.keys(allAcls).sort(function (a, b) { return parseInt(a, 10) - parseInt(b, 10); })) {
        for (const e of allAcls[id]) out.push('access-list ' + id + ' ' + (e.line || e.action));
      }
      for (const r of dev.config.routes) {
        out.push('ip route ' + r.dest + ' ' + r.mask + ' ' + (r.gw || '') + (r.iface ? ' ' + r.iface : ''));
      }
      if (dev.config.defaultGateway) out.push('ip default-gateway ' + dev.config.defaultGateway);
    } else {
      out.push('% Invalid show command: ' + (tokens.join(' ') || '(empty)'));
    }
    return out;
  }

  // What this device would advertise right now. A router shows its policy and the
  // exact options that would go on the wire; a host shows which interfaces are
  // waiting for a router, because "no address yet" is the failure mode of SLAAC
  // and it should be visible rather than mysterious.
  _showIpv6Nd() {
    const raLib = require('./ra');
    const dev = this.device;
    const cfg = raLib.normalizeConfig(dev.config.ra);
    const canAdvertise = dev.hasCap('l3-forward');
    const out = [];

    out.push('IPv6 router advertisements on ' + dev.name + ':');
    out.push('  Device      : ' + dev.model + (canAdvertise ? '  (l3-forward)' : '  (no l3-forward)'));
    if (!canAdvertise) {
      out.push('  Advertise   : unavailable - a device without l3-forward cannot route a prefix');
    } else if (!cfg.enabled) {
      out.push('  Advertise   : disabled  (ipv6 nd ra enable to start)');
    } else if (cfg.suppress) {
      out.push('  Advertise   : enabled, suppressed  (solicited advertisements only)');
    } else {
      out.push('  Advertise   : enabled');
    }
    out.push('  Flags       : M=' + (cfg.m ? 1 : 0) + ' O=' + (cfg.o ? 1 : 0) +
      '   router lifetime ' + cfg.routerLifetime + 's' +
      (cfg.routerLifetime === 0 ? ' (not a default router)' : ''));
    out.push('  Timers      : reachable ' + cfg.reachableTime + 'ms, retrans ' + cfg.retransTimer +
      'ms, hop limit ' + cfg.curHopLimit);

    if (!cfg.prefixes.length) {
      out.push('  Prefixes    : none - hosts would learn a default router only');
    } else {
      out.push('  Prefixes    : ' + cfg.prefixes.length);
      out.push('    ' + pad('prefix', 26) + pad('L', 3) + pad('A', 3) + pad('valid(s)', 12) + 'preferred(s)');
      for (const p of cfg.prefixes) {
        out.push('    ' + pad(p.prefix + '/' + p.prefixLen, 26) +
          pad(p.onLink ? '1' : '0', 3) + pad(p.autonomous ? '1' : '0', 3) +
          pad(p.validLifetime, 12) + p.preferredLifetime);
      }
    }

    if (canAdvertise) {
      const v6 = require('./ipv6');
      const ports = dev.activeInterfaces()
        .filter(function (i) { return !i.parent && i.peer; });
      const holds = function (iface, p) {
        for (const e of dev.ip6Addrs()) {
          if (e.name !== iface.name) continue;
          if (v6.prefixContains6(p.prefix + '/' + p.prefixLen, e.addr)) return true;
        }
        return false;
      };
      if (!ports.length) {
        out.push('  Interfaces  : (no cabled ports)');
      } else {
        // Which prefix would go out of which port: a router advertises a prefix
        // on the link it is attached to, not on every port it owns.
        const rows = ports.map(function (i) {
          const list = cfg.prefixes.filter(function (p) { return holds(i, p); })
            .map(function (p) { return p.prefix + '/' + p.prefixLen; });
          return i.name + (list.length ? ' (' + list.join(', ') + ')' : ' (default router only)');
        });
        out.push('  Interfaces  : ' + rows.join(', '));
      }
      for (const p of cfg.prefixes) {
        if (ports.some(function (i) { return holds(i, p); })) continue;
        out.push('  % ' + p.prefix + '/' + p.prefixLen +
          ' is configured but no interface has an address inside it, so it is never advertised');
      }
    }

    const waiting = [];
    for (const i of dev.activeInterfaces()) {
      if (!i.autoconfig) continue;
      const learned = (dev.config.ip6 || {})[i.name];
      waiting.push(i.name + (learned && learned.autoconfig
        ? ' -> ' + learned.addr + '/' + learned.prefix + ' (from ' + (learned.from || 'RA') + ')'
        : ' (waiting for a router)'));
    }
    out.push('  Autoconfig  : ' + (waiting.length ? waiting.join(', ') : 'none'));
    if (dev.config.gateway6) {
      out.push('  Default gw  : ' + dev.config.gateway6 +
        (dev.config.gateway6Iface ? ' via ' + dev.config.gateway6Iface : ''));
    }
    return out;
  }

  _banner() {
    const dev = this.device;
    return 'PacketForge ' + dev.label + ' (' + dev.vendor + ' ' + dev.model + ')';
  }

  _help() {
    return [
      'Available commands:',
      '  enable / configure terminal / interface <name>',
      '  hostname <name>          ip address <ip> <mask>',
      '  ip route <dest> <mask> <gw> [iface]',
      '  show lldp neighbors               neighbours learned over the wire',
      '  ip default-gateway <gw>  shutdown / no shutdown',
      '  ipv6 address <addr>/<len> | autoconfig        (interface mode)',
      '  ipv6 nd ra enable|disable|managed|other-config|lifetime <s>',
      '  ipv6 nd prefix <prefix>/<len> [valid <s>] [preferred <s>]',
      '  ipv6 nd suppress-ra',
      '  show ipv6 nd                    what this device would advertise',
      '  vlan <id> [name]                       (config mode)',
      '  interface <parent>.<vlan>              (creates a subinterface)',
      '  encapsulation dot1q <vlan>             (interface mode)',
      '  switchport mode access|trunk            (interface mode)',
      '  switchport access vlan <id>',
      '  switchport trunk native vlan <id>',
      '  switchport trunk allowed vlan <list|all>',
      '  channel-group <id> mode active|passive|on',
      '  access-list <1-2699> permit|deny ...        (config mode)',
      '  ip access-group <acl> in|out               (interface mode)',
      '  ping <ip> [count]',
      '  converge [at <ms>]                - when each control plane finishes',
      '  link up|down <id> [at <ms>]       - pull or replace a cable, re-converge from there',
      '  links                             - every cable and its state',
      '  show version | ip interface brief | ip route | arp',
      '  show vlan [brief] | spanning-tree | etherchannel summary',
      '  show access-lists',
      '  show mac address-table | interfaces | running-config'
    ];
  }
}

// Convenience: run a list of commands, returning { output, lines }.
function runCommands(device, topology, simulator, commands) {
  const session = new CliSession(device, topology, simulator);
  const lines = [];
  for (const cmd of commands) {
    lines.push(session.prompt() + cmd);
    const res = session.run(cmd);
    for (const l of res.output) lines.push(l);
  }
  return { output: lines.join('\n'), lines: lines, session: session };
}

// resolvePortName / portKey are exported so the naming test can pin the alias
// rules directly, rather than only through the commands that use them.
module.exports = { CliSession, runCommands, resolvePortName, portKey };
