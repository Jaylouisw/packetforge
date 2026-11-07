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
    if (this.mode === MODE_ENABLE) return host + '#';
    return host + '>';
  }

  run(line) {
    const out = [];
    const tokens = line.trim().split(/\s+/).filter(Boolean);
    if (!tokens.length) return { output: out, actions: [] };
    const head = tokens[0].toLowerCase();

    try {
      if (this.mode === MODE_IFACE) {
        out.push.apply(out, this._ifaceMode(tokens));
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
      this.device.config.hostname = tokens[1] || null;
      if (tokens[1]) this.device.name = tokens[1];
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
      const name = tokens[2];
      const vi = name ? this.device.interfaces.get(name) : null;
      if (!vi) return ['% Interface not found: ' + (name || '')];
      if (!vi.parent) return ['% ' + name + ' is a physical interface and cannot be removed'];
      this.device.interfaces.delete(name);
      out.push('Subinterface ' + name + ' removed');
    } else if (head === 'access-list') {
      out.push.apply(out, this._accessList(tokens.slice(1)));
    } else if (head === 'no' && tokens[1] === 'access-list') {
      const n = tokens[2];
      if (this.device.config.acls) delete this.device.config.acls[n];
      const binds = this.device.aclBindings || {};
      for (const k of Object.keys(binds)) {
        if (String(binds[k].in) === String(n)) delete binds[k].in;
        if (String(binds[k].out) === String(n)) delete binds[k].out;
      }
      out.push('Access list ' + n + ' removed');
    } else if (head === 'interface' || head === 'int') {
      if (!tokens[1]) return ['% Incomplete command'];
      if (!this.device.interfaces.has(tokens[1])) {
        // 'interface Gi0/0.10' creates a router subinterface on Gi0/0.
        const m = /^(.+)\.(\d+)$/.exec(tokens[1]);
        if (m && this.device.interfaces.has(m[1])) {
          const vid = parseInt(m[2], 10);
          if (!(vid >= 1 && vid <= 4094)) return ['% VLAN out of range: ' + m[2]];
          this.device.addSubinterface(m[1], vid);
          out.push('Created subinterface ' + tokens[1] + ' (parent ' + m[1] + ')');
        } else {
          return ['% Interface not found: ' + tokens[1]];
        }
      }
      this.iface = tokens[1];
      this.mode = MODE_IFACE;
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
    if (head === 'ip' && tokens[1] === 'address') {
      if (tokens[2] === 'dhcp') {
        iface.dhcp = true;
        out.push('Interface ' + iface.name + ' set to DHCP');
      } else {
        const ip = tokens[2], mask = tokens[3];
        if (!ip || !mask) return ['% Incomplete command'];
        net.ipToInt(ip); net.maskToInt(mask);
        iface.ip = ip; iface.mask = mask; iface.dhcp = false;
        out.push('IP address set on ' + iface.name + ': ' + ip + '/' + net.prefixOf(mask));
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
      out.push('% Unrecognized interface command: ' + tokens.join(' '));
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

  // ---------- switchport / VLAN membership ----------
  _switchport(tokens, iface) {
    const vlanLib = require('./vlan');
    const t = tokens.map(function (x) { return String(x).toLowerCase(); });

    if (t[0] === 'reset') {
      iface.vlan = vlanLib.normalizePortConfig({});
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
      return ['Switchport mode ' + mode + ' on ' + iface.name];
    }
    if (t[0] === 'access' && t[1] === 'vlan') {
      const id = parseInt(t[2], 10);
      const chk = vlanLib.validatePortConfig({ accessVlan: id });
      if (!chk.ok) return ['% ' + chk.errors[0].message];
      iface.vlan = vlanLib.normalizePortConfig(Object.assign({}, iface.vlan, { mode: 'access', accessVlan: id }));
      return ['Access VLAN ' + id + ' on ' + iface.name];
    }
    if (t[0] === 'trunk' && t[1] === 'native' && t[2] === 'vlan') {
      const id = parseInt(t[3], 10);
      const chk = vlanLib.validatePortConfig({ nativeVlan: id });
      if (!chk.ok) return ['% ' + chk.errors[0].message];
      iface.vlan = vlanLib.normalizePortConfig(Object.assign({}, iface.vlan, { mode: 'trunk', nativeVlan: id }));
      return ['Trunk native VLAN ' + id + ' on ' + iface.name];
    }
    if (t[0] === 'trunk' && t[1] === 'allowed' && t[2] === 'vlan') {
      const spec = t.slice(3).join('');
      if (!spec) return ['% Incomplete command'];
      if (spec === 'all') {
        iface.vlan = vlanLib.normalizePortConfig(Object.assign({}, iface.vlan, { allowedVlans: 'all' }));
        return ['Trunk on ' + iface.name + ' allows all VLANs'];
      }
      const parsed = vlanLib.parseVlanList(spec);
      if (!parsed.ok) return ['% ' + (parsed.message || 'invalid VLAN list')];
      const bad = parsed.vlans.filter(function (v) { return v < 1 || v > 4094; });
      if (bad.length) return ['% VLAN out of range: ' + bad[0]];
      iface.vlan = vlanLib.normalizePortConfig(Object.assign({}, iface.vlan, { mode: 'trunk', allowedVlans: parsed.vlans }));
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

  // ---------- ping ----------
  _ping(tokens) {
    const out = [];
    const ip = tokens[0];
    const count = tokens[1] ? parseInt(tokens[1], 10) : 4;
    if (!ip || !net.isIp(ip)) return ['% Invalid ping target: ' + (ip || '(none)')];
    if (!this.sim) return ['% Simulator not attached'];
    out.push('Type escape sequence to abort.');
    out.push('Sending ' + count + ', 100-byte ICMP Echos to ' + ip + ', timeout is 2 seconds:');
    const res = this.sim.ping(this.device.id, ip, { count: count });
    const marks = res.replies.map(function (r) { return r.success ? '!' : '.'; }).join('');
    out.push(marks);
    const ok = res.replies.filter(function (r) { return r.success; }).length;
    out.push('Success rate is ' + Math.round((ok / count) * 100) + ' percent (' + ok + '/' + count + ')');
    for (const r of res.replies) {
      if (r.success) out.push('Reply from ' + ip + ': bytes=100 time=' + r.hops + ' hops');
      else out.push('Request timed out (seq ' + r.seq + ')');
    }
    return out;
  }

  // ---------- show ----------
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
        const status = i.enabled ? 'up' : 'administratively down';
        out.push(pad(i.name, 22) + pad(ip, 16) + 'YES  ' + pad(i.dhcp ? 'DHCP' : 'manual', 8) + pad(status, 22) + (i.enabled ? 'up' : 'down'));
      }
    } else if (what === 'ip' && tokens[1] === 'route') {
      out.push('Codes: C - connected, S - static');
      for (const r of dev.routesTable()) {
        out.push(r.code + '  ' + pad(r.dest, 15) + '/' + net.prefixOf(r.mask) + '  via ' + r.gw + '  ' + r.iface);
      }
    } else if (what === 'access-lists' || what === 'access-list') {
      const aclLib = require('./acl');
      const acls = dev.config.acls || {};
      const ids = Object.keys(acls).sort(function (a, b) { return parseInt(a, 10) - parseInt(b, 10); });
      if (!ids.length) out.push('% No access lists configured');
      const binds = dev.aclBindings || {};
      for (const id of ids) {
        const kind = aclLib.aclKind(parseInt(id, 10));
        out.push((kind === 'standard' ? 'Standard' : 'Extended') + ' IP access list ' + id);
        let n = 1;
        for (const e of acls[id]) {
          out.push('  ' + (n++) + ' ' + (e.line || (e.action + ' ' + (e.protocol || 'ip'))));
        }
        for (const k of Object.keys(binds)) {
          if (String(binds[k].in) === String(id)) out.push('    applied IN on ' + k);
          if (String(binds[k].out) === String(id)) out.push('    applied OUT on ' + k);
        }
      }
    } else if (what === 'vlan') {
      out.push('VLAN Name                             Status    Ports');
      const byVlan = new Map();
      for (const i of dev.interfaces.values()) {
        const v = i.vlan || { mode: 'access', accessVlan: 1 };
        if (v.mode === 'trunk') {
          const ids = (v.allowedVlans === 'all' || !Array.isArray(v.allowedVlans))
            ? [Number(v.nativeVlan) || 1]
            : v.allowedVlans;
          for (const id of ids) {
            if (!byVlan.has(id)) byVlan.set(id, []);
            byVlan.get(id).push(i.name + (id === (Number(v.nativeVlan) || 1) ? '(n)' : '(t)'));
          }
          if (v.allowedVlans === 'all') {
            const anyKey = 'all';
            if (!byVlan.has(anyKey)) byVlan.set(anyKey, []);
            byVlan.get(anyKey).push(i.name + '(trunk)');
          }
        } else {
          const id = Number(v.accessVlan) || 1;
          if (!byVlan.has(id)) byVlan.set(id, []);
          byVlan.get(id).push(i.name);
        }
      }
      const keys = Array.from(byVlan.keys()).sort(function (a, b) {
        if (a === 'all') return 1;
        if (b === 'all') return -1;
        return a - b;
      });
      for (const id of keys) {
        if (id === 'all') {
          out.push(pad(1, 8) + pad((dev.config.vlans && dev.config.vlans[1] && dev.config.vlans[1].name) || 'default', 33) + pad('active', 10) + byVlan.get(id).join(', '));
          continue;
        }
        const name = (dev.config.vlans && dev.config.vlans[id] && dev.config.vlans[id].name) || ('VLAN' + String(id).padStart(4, '0'));
        out.push(pad(id, 8) + pad(name, 33) + pad('active', 10) + byVlan.get(id).join(', '));
      }
    } else if (what === 'spanning-tree') {
      const st = dev.stp || { states: {}, roles: {}, blocked: new Set() };
      const names = Object.keys(st.states || {}).sort();
      out.push('Spanning tree enabled protocol ieee');
      if (!names.length) {
        out.push('  No bridged ports: this device is not part of any L2 loop.');
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
        out.push('Group  Protocol   Ports');
        for (const id of ids) {
          const l = lags[id] || {};
          const members = (l.members || []).map(function (m) {
            const blocked = dev.stp && dev.stp.blocked && dev.stp.blocked.has(m);
            return m + '(' + (blocked ? 'D' : 'P') + ')';
          });
          out.push(pad(id, 7) + pad(l.mode || 'static', 11) + members.join(' '));
        }
      }
    } else if (what === 'arp') {
      out.push('Protocol  Address          Age (min)  Hardware Addr   Interface');
      for (const [ip, mac] of dev.arp.entries()) {
        out.push('Internet  ' + pad(ip, 15) + '-          ' + mac);
      }
    } else if (what === 'mac' && tokens[1] === 'address-table') {
      out.push('Vlan    Mac Address         Type        Ports');
      const rows = [];
      for (const [mac, iface] of dev.macTable.entries()) rows.push([1, mac, iface]);
      for (const [vid, table] of (dev.macTables || new Map()).entries()) {
        for (const [mac, iface] of table.entries()) rows.push([vid, mac, iface]);
      }
      rows.sort(function (a, b) { return (a[0] - b[0]) || String(a[1]).localeCompare(String(b[1])); });
      for (const r of rows) out.push(pad(r[0], 8) + pad(r[1], 20) + 'DYNAMIC     ' + r[2]);
    } else if (what === 'interfaces' || what === 'interface') {
      for (const i of dev.interfaces.values()) {
        out.push(i.name + ' (' + i.type + ', ' + i.speed + '), MAC ' + i.mac);
        out.push('  status: ' + (i.enabled ? 'up' : 'administratively down') + (i.description ? ', desc: ' + i.description : ''));
        out.push('  ip: ' + (i.ip ? i.ip + '/' + net.prefixOf(i.mask) : 'unassigned') + (i.dhcp ? ' (dhcp)' : ''));
        out.push('  peer: ' + (i.peer ? i.peer.deviceId + '/' + i.peer.iface : 'disconnected'));
      }
    } else if (what === 'running-config' || what === 'run') {
      out.push('! PacketForge running-config');
      out.push('hostname ' + (dev.config.hostname || dev.name));
      for (const i of dev.interfaces.values()) {
        out.push('interface ' + i.name);
        if (i.description) out.push('  description ' + i.description);
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
      '  ip default-gateway <gw>  shutdown / no shutdown',
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

module.exports = { CliSession, runCommands };
