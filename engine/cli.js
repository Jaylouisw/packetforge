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
const ifaceName = { resolvePortName };
// Rates are spelled the way the catalogue spells them, by the parser the catalogue uses: `speed 1G` and
// `speed 1000` must land on the same port rate, and a second parser here would be a second answer.
const mediaLib = require('./media');
// VLAN membership is decided by one rule (engine/vlan.js), so a table that lists members uses it rather
// than re-deriving what a port carries.
const vlanLib = require('./vlan');


function pad(s, w) { s = String(s); return s + ' '.repeat(Math.max(0, w - s.length)); }

// A `show` command that does not take an argument says so, and names the command that answers the question asked.
//
// The alternative - and what eight of these did - is to drop the words and print the whole table. That is not a
// refusal, it is a wrong answer: `show ip route 192.0.2.0/24` on a router whose table held only 10.0.0.0/24 printed
// 10.0.0.0/24, which reads as "yes, that prefix is in the table" (#1403). An operator checking whether a prefix is
// installed is checking exactly the thing the drop fabricates.
//
// `whole` says what the command does print; `instead` names the command that answers the narrower question, when
// one exists. Refusing is the truthful answer: this console has no `show ip route <prefix>`, and pretending it does
// is worse than saying so.
function showNoTail(cmd, tail, whole, instead) {
  return ['% ' + cmd + ' does not take "' + tail.join(' ') + '": ' + whole +
    (instead ? ' - ' + instead : '')];
}

// The words that are views under `show interfaces` in IOS, and the answer this console can give instead (#1443).
//
// Every one of these used to answer `% No interface <word> on <box>` - the same sentence a mistyped port name gets -
// so an operator who typed a command they know from IOS was told a socket did not exist. That is the wrong lesson to
// teach: the port is fine, the view is not here, and the answer should point at the command that does answer the
// question. Each entry says where to go; none of them invent a view this console does not have.
const INTERFACES_VIEW_KEYWORDS = {
  switchport: 'A port\'s own switchport line is in `show interfaces <port>`; VLAN membership is in `show vlan brief`.',
  trunk: '`show vlan brief` names each VLAN\'s ports, and `show interfaces <port>` prints the port\'s trunk settings.',
  status: '`show interfaces` prints every port\'s status and protocol, one block each.',
  description: '`show interfaces <port>` prints the port\'s description when one is set.',
  counters: '`show interfaces <port>` prints that port\'s packet and byte counters; `show interfaces` prints them for every port.',
  summary: '`show interfaces` is the summary: one block per port with status, address and counters.',
  capabilities: 'What a box can do is in `show version` and in its catalogue entry; a port\'s own facts are in `show interfaces <port>`.',
  transceiver: 'The cage and its optics are in `show interfaces <port>` and in the port\'s catalogue entry.',
  errdisable: 'A port that cannot carry a frame says why in `show interfaces <port>` and in `show interfaces`.',
  flowcontrol: 'Flow control is not simulated: there is no negotiation to report.',
  history: 'Counters are a running total, not a history: `show interfaces <port>` prints the totals since the run began.',
  stats: '`show interfaces <port>` prints the totals since the run began.'
};

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

  // A capability is a promise about what a box can do with a packet: the catalogue declares it, the engine honours
  // it in the data plane, and until now exactly one command refused configuration on a device that could not keep
  // the promise (`ipv6 nd ra`). Everything else was accepted and then silently inert - a Raspberry Pi took
  // `ip dhcp pool`, `ip route` and `ospf router-id` and created objects nothing on it could use (#1387). The
  // refusal names the capability and the consequence, in the same words the RA gate uses.
  // What to use instead of `switchport` on a box that routes. A host gets no advice, because "this port routes"
  // would be a second wrong statement in the same sentence.
  _routedPortHint() {
    return (this.device && typeof this.device.hasCap === 'function' && this.device.hasCap('l3-forward'))
      ? ' - this port routes: use `ip address <address> <mask>`'
      : '';
  }

  // Which side of a NAT translation a port is on. One setter and one clearer, so the interface command and the
  // `no` form that arrives through global config mode cannot drift apart (#1391).
  // The translation table at the instant this session is asking about, aged first. Reading `dev.natTable`
  // directly showed entries that had been idle longer than their protocol timeout, because ageing only ever ran
  // on the data path (#1393). A device that has never translated anything still has no table: creating one to
  // read it would turn "nothing has crossed" into "an empty table", which are different answers.
  _natTableAt() {
    const dev = this.device;
    if (!dev.natTable) return null;
    if (this.sim && typeof this.sim._natTableOf === 'function') return this.sim._natTableOf(dev);
    return dev.natTable;
  }

  // One sentence for "which ports are inside, and which outside", or the honest statement that nobody has said.
  _natPortsSentence() {
    const inside = [];
    const outside = [];
    this.device.interfaces.forEach(function (i) {
      if (!i || !i.natRole) return;
      if (i.natRole === 'inside') inside.push(i.name);
      else if (i.natRole === 'outside') outside.push(i.name);
    });
    if (!inside.length && !outside.length) {
      return 'Ports: no port is declared inside or outside - a rule may translate on any port';
    }
    return 'Ports: inside ' + (inside.length ? inside.join(', ') : '(none)') +
      ' - outside ' + (outside.length ? outside.join(', ') : '(none)');
  }

  _setNatRole(iface, role) {
    const was = iface.natRole || null;
    if (was === role) return ['Interface ' + iface.name + ' is already the ' + role + ' interface for NAT'];
    iface.natRole = role;
    this._controlPlaneChanged();
    return ['Interface ' + iface.name + ' is now the ' + role + ' interface for NAT' + (was ? ' (was ' + was + ')' : '')];
  }

  _clearNatRole(iface, role) {
    const was = iface.natRole || null;
    if (was !== role) {
      return ['% ' + iface.name + ' is not the ' + role + ' interface' +
        (was ? ' (it is the ' + was + ' interface)' : ' (it has no NAT role)')];
    }
    iface.natRole = null;
    this._controlPlaneChanged();
    return ['Interface ' + iface.name + ' is no longer the ' + role + ' interface for NAT'];
  }

  // A VLAN id arrives as one token, and a word is not one (#1409). `parseInt` answered NaN for it, every gate that
  // normalises before it validates turned that NaN into VLAN 1, and the console then printed the NaN it was still
  // holding - so `switchport access vlan WORD` reported "Access VLAN NaN on 1" and `vlan WORD` created a VLAN
  // numbered NaN, while `show interfaces`, `show vlan` and the saved file all said VLAN 1.
  //
  // The shape of the argument is a console concern (tokens, not values), so it is checked here; the range and the
  // reserved block stay with `validatePortConfig`, which every door shares.
  _vlanIdRefusal(token, what, alternative) {
    const lib = require('./vlan');
    const text = String(token === undefined || token === null ? '' : token).trim();
    const hint = alternative ? ' or "' + alternative + '"' : '';
    if (!text) {
      return '% Incomplete command: give a VLAN id (' + lib.VLAN_MIN + '-' + lib.VLAN_MAX + ')' + hint;
    }
    if (!/^[0-9]+$/.test(text)) {
      return '% Invalid VLAN id "' + text + '": ' + what + ' is a whole number from ' + lib.VLAN_MIN +
        ' to ' + lib.VLAN_MAX + hint;
    }
    const id = parseInt(text, 10);
    if (id < lib.VLAN_MIN || id > lib.VLAN_MAX) {
      return '% VLAN id ' + id + ' is outside ' + lib.VLAN_MIN + '-' + lib.VLAN_MAX;
    }
    return null;
  }

  // What is left for the shared validator to say is about the number, not the caller's word for it: the messages
  // are written for whoever validated a port object ("accessVlan 1002 is reserved..."), and the operator typed
  // `switchport access vlan 1002`. Only the field name is swapped; the reason is the validator's.
  _vlanRefusal(chk, what) {
    const first = chk && chk.errors && chk.errors[0];
    if (!first) return '% Invalid VLAN';
    return '% ' + String(first.message).replace(/^(accessVlan|nativeVlan|pvid|voiceVlan)\b/, what);
  }

  _capabilityRefusal(cap, consequence) {
    const dev = this.device;
    if (!dev || typeof dev.hasCap !== 'function' || dev.hasCap(cap)) return null;
    return '% ' + dev.name + ' cannot ' + consequence + ': it has no ' + cap + ' capability';
  }

  _configMode(tokens) {
    const out = [];
    const head = tokens[0].toLowerCase();
    if (head === 'ip' && tokens[1] && tokens[1].toLowerCase() === 'nat' &&
        tokens[2] && /^(inside|outside)$/i.test(String(tokens[2])) && tokens[3] === undefined) {
      // The keyword belongs to a port, not to the box. Saying so beats printing the pool/rule usage, which does
      // not mention inside or outside at all (#1391).
      return ['% ip nat ' + String(tokens[2]).toLowerCase() + ' belongs to an interface: enter one first, ' +
        'e.g. interface Gi0/0/1'];
    }
    if (head === 'ip' && tokens[1] && tokens[1].toLowerCase() === 'nat') {
      // engine/nat.js models static, dynamic and PAT translation, and the flow path translates and emits
      // `nat-drop` -- but nothing in the product ever wrote `config.nat`, so `_isNat()` was always false and
      // the whole mechanism was unreachable. This is the way in (#1366).
      return this._natConfig(tokens.slice(2));
    }
    if (head === 'spanning-tree') {
      // The engine has read `config.stpPriority` since STP was modelled and nothing ever wrote it, so
      // every box in every lab ran the default and the root was decided by MAC address alone. This is
      // the command that reaches it (#1364).
      const dev = this.device;
      if (tokens[1] && tokens[1].toLowerCase() === 'vlan') {
        // IOS spells this per VLAN. This model runs one spanning tree for the device, so accepting a
        // VLAN id would promise a per-VLAN election that does not exist - say so instead of quietly
        // applying it to everything.
        return ['% This device runs one spanning tree, not one per VLAN: use `spanning-tree priority <0-61440>`'];
      }
      const value = tokens[2];
      if (!value || !/^\d+$/.test(value)) {
        return ['% Usage: spanning-tree priority <0-61440 in 4096 steps>'];
      }
      const p = Number(value);
      const stpLib = require('./stp');
      const problem = p % 4096 !== 0
        ? 'it must be a multiple of 4096 (the low 12 bits are the system ID extension); the nearest valid values are ' +
          (Math.floor(p / 4096) * 4096) + ' and ' + Math.ceil(p / 4096) * 4096
        : (p > 61440 ? 'the range is 0 to 61440' : null);
      if (problem) return ['% ' + p + ' is not a valid bridge priority: ' + problem];
      const was = dev.config.stpPriority;
      dev.config.stpPriority = p;
      out.push('Bridge priority set to ' + p + ' (lower wins the root election)' +
        (was === null || was === undefined ? '' : ', was ' + was) +
        (dev.isL2 && dev.isL2() ? '' : '; this device has no bridging ports, so no election runs here'));
      this._controlPlaneChanged();
      return out;
    }
    if (head === 'hostname') {
      // The whole remainder is the name. Taking tokens[1] silently truncated
      // "core switch 1" to "core", which is what the UI's hostname field appeared to do
      // (issue #19) - the box was fine, the parser was eating the rest of the line.
      const name = tokens.slice(1).join(' ').trim();
      if (!this.device.config.hostname) this.device.nameBeforeHostname = this.device.name;
      this.device.config.hostname = name || null;
      // device.name is what the UI renders: the canvas label, the inspector header, the
      // status bar. Setting only config.hostname left a device that reported
      // "hostname THE BIFROST" while every surface still said "THE" (issue #21). Both are
      // set from the same text, so they cannot disagree.
      if (name) this.device.name = name;
    } else if (head === 'vlan') {
      const bad = this._vlanIdRefusal(tokens[1], 'a VLAN id');
      if (bad) return [bad];
      const id = parseInt(tokens[1], 10);
      const chk = require('./vlan').validatePortConfig({ accessVlan: id });
      if (!chk.ok) return [this._vlanRefusal(chk, 'VLAN id')];
      if (!this.device.config.vlans) this.device.config.vlans = {};
      const name = tokens.slice(2).join(' ') || ('VLAN' + String(id).padStart(4, '0'));
      this.device.config.vlans[id] = { name: name };
      out.push('VLAN ' + id + ' created (name: ' + name + ')');
    } else if (head === 'no' && tokens[1] === 'ip' && tokens[2] && tokens[2].toLowerCase() === 'nat' &&
               tokens[3] && /^(inside|outside)$/i.test(String(tokens[3])) && tokens[4] === undefined &&
               this.mode === MODE_IFACE) {
      // `no ip nat inside` typed on a port clears that port's role. It reached the rule handler below, which read
      // "inside" as the start of a rule and answered with the pool/rule usage (#1391).
      return [this._clearNatRole(this.topo.getDevice(this.device.id).interfaces.get(this.iface), String(tokens[3]).toLowerCase())];
    } else if (head === 'no' && tokens[1] === 'ip' && tokens[2] && tokens[2].toLowerCase() === 'nat') {
      const nat = this.device.config.nat || { rules: [], pools: {} };
      const rest = tokens.slice(3).map(function (t) { return String(t).toLowerCase(); });
      if (rest[0] === 'pool') {
        const name = tokens[4];
        if (!name || !nat.pools || !nat.pools[name]) {
          return ['% No NAT pool called "' + (name || '') + '"' +
            (nat.pools && Object.keys(nat.pools).length ? ' (configured: ' + Object.keys(nat.pools).join(', ') + ')' : '')];
        }
        const users = (nat.rules || []).filter(function (r) { return r.pool === name; }).length;
        if (users) {
          return ['% NAT pool "' + name + '" is still used by ' + users + ' rule(s): remove those first'];
        }
        delete nat.pools[name];
        this.device.config.nat = nat;
        this._controlPlaneChanged();
        return ['NAT pool "' + name + '" removed'];
      }
      if (rest[0] === 'inside' && rest[1] === 'source') {
        const rules = nat.rules || [];
        if (!rules.length) return ['% No NAT rules configured'];
        const last = rules[rules.length - 1];
        rules.pop();
        this.device.config.nat = nat;
        this._controlPlaneChanged();
        return ['NAT rule removed: ' + require('./nat').formatRuleLine(last)];
      }
      return ['% Usage: no ip nat pool <name> | no ip nat inside source'];
    } else if (head === 'no' && tokens[1] === 'spanning-tree') {
      const dev = this.device;
      if (!dev.config.stpPriority && dev.config.stpPriority !== 0) {
        const stpLib = require('./stp');
        return ['% No bridge priority set: the device is using the default ' + stpLib.STP_DEFAULT_PRIORITY];
      }
      const was = dev.config.stpPriority;
      dev.config.stpPriority = null;
      this._controlPlaneChanged();
      const stpLib = require('./stp');
      return ['Bridge priority cleared (was ' + was + '), back to the default ' + stpLib.STP_DEFAULT_PRIORITY];
    } else if (head === 'no' && tokens[1] === 'hostname') {
      // `hostname` was a one-way door: the console accepted it, `show running-config` printed it, and there
      // was no way to take it back short of rewriting the device. A backup you cannot edit back is half a
      // backup.
      const was = this.device.config.hostname;
      if (!was) return ['% No hostname set (the device is named ' + this.device.name + ')'];
      // Restore the name the box had before the hostname was typed, not a guess at a default: `hostname` sets
      // both config.hostname and device.name so the canvas and the console cannot disagree (#21), so undoing
      // it has to put both back or the line stays in the config and the label lies.
      const prior = this.device.nameBeforeHostname || null;
      this.device.config.hostname = null;
      if (prior) this.device.name = prior;
      this.device.nameBeforeHostname = null;
      out.push('Hostname cleared (device is now ' + this.device.name + ')');
    } else if (head === 'no' && tokens[1] === 'vlan') {
      const bad = this._vlanIdRefusal(tokens[2], 'a VLAN id');
      if (bad) return [bad];
      const id = parseInt(tokens[2], 10);
      const have = this.device.config.vlans && this.device.config.vlans[id];
      // It used to print "VLAN 42 removed" whether or not there was one - the same sentence for work done and
      // work not done - and it would remove a VLAN that ports still carried: `show running-config` then
      // stopped printing `vlan 42` while `show vlan` still listed it from the ports, so the table and the
      // config described different switches.
      if (!have) return ['% VLAN ' + id + ' does not exist'];
      // Two kinds of port depend on this VLAN, and both have to be named.
      //
      //   * ports that carry it - asked of the data plane's own rule (`classifyEgress`), not of a second
      //     copy of it, so a trunk allowing all VLANs counts and a staged parameter does not;
      //   * ports that only reference it - a native VLAN or an allowed list stored on a port that is not in
      //     trunk mode yet. Those used to be missed, and removing the VLAN then rewrote the port's staged
      //     configuration in silence: `no vlan 20` said "VLAN 20 removed" and a port that had been staged for
      //     VLAN 20 quietly came back with native VLAN 1.
      const carriers = [];
      const staged = [];
      for (const i of this.device.interfaces.values()) {
        if (!i.vlan) continue;
        const verdict = vlanLib.classifyEgress(i.vlan, id);
        const action = (verdict && verdict.action) || 'drop';
        if (action !== 'drop') {
          carriers.push(i.name + (i.vlan.mode === 'trunk' && action === 'untagged' ? ' (native)' : ''));
          continue;
        }
        const where = [];
        if (Number(i.vlan.nativeVlan) === id) where.push('trunk native');
        if (Array.isArray(i.vlan.allowedVlans) && i.vlan.allowedVlans.indexOf(id) !== -1) where.push('trunk allowed');
        if (where.length) staged.push(i.name + ' (' + where.join(', ') + ', stored)');
      }
      const list = function (arr) {
        return arr.slice(0, 5).join(', ') + (arr.length > 5 ? ' (+' + (arr.length - 5) + ' more)' : '');
      };
      if (carriers.length) {
        return ['% VLAN ' + id + ' is still carried by ' + carriers.length + ' port(s): ' + list(carriers) +
          ' - move them off it first'];
      }
      if (staged.length) {
        return ['% VLAN ' + id + ' is still referenced by ' + staged.length + ' port(s): ' + list(staged) +
          ' - clear that first'];
      }
      delete this.device.config.vlans[id];
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
      const cannotServe = this._capabilityRefusal('dhcp-server', 'serve DHCP');
      if (cannotServe) return [cannotServe];
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
    } else if (head === 'no' && tokens[1] === 'ip' && tokens[2] === 'dhcp' && tokens[3] === 'pool') {
      const name = tokens[4];
      if (!name) return ['% Incomplete command: no ip dhcp pool <name>'];
      const pools = this.device.config.dhcpPools || [];
      const idx = pools.findIndex(function (p) { return p.name === name; });
      if (idx === -1) return ['% No DHCP pool named ' + name];
      pools.splice(idx, 1);
      if (this.pool === name) this.mode = MODE_CONFIG;
      out.push('DHCP pool ' + name + ' removed');
    } else if (head === 'no' && tokens[1] === 'dns' && tokens[2] === 'zone') {
      const dnsLib = require('./dns');
      const apex = tokens[3];
      if (!apex) return ['% Usage: no dns zone <name>'];
      const key = dnsLib.normalizeName(apex);
      const zones = this.device.config.dnsZones || [];
      const idx = zones.findIndex(function (x) { return dnsLib.normalizeName(x.name) === key; });
      if (idx === -1) return ['% No DNS zone named ' + key];
      const gone = zones[idx];
      zones.splice(idx, 1);
      if (this._dnsZone && dnsLib.normalizeName(this._dnsZone) === key) this._dnsZone = null;
      out.push('DNS zone ' + gone.name + ' removed' +
        (gone.records && gone.records.length ? ' with ' + gone.records.length + ' record(s)' : ''));
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
      if (!net.isIp(ip || '')) {
        out.push('% Invalid name server "' + (ip || '') + '": not an IPv4 address');
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
      // ip route DEST MASK GW [iface]   and   ip route DEST MASK <iface>   (the directly-connected form)
      const dest = tokens[2], mask = tokens[3];
      const cannotRoute = this._capabilityRefusal('l3-forward', 'install a route');
      if (cannotRoute) return [cannotRoute];
      let gw = tokens[4] || null;
      let iface = tokens[5] || null;
      if (!dest || !mask) return ['% Incomplete command: ip route <dest> <mask> <gateway|interface>'];
      if (!net.isIp(dest)) return ['% Invalid destination "' + dest + '": not an IPv4 address'];
      // The mask was "validated" by a call whose result was thrown away, and `maskToInt()` does not refuse a
      // non-contiguous mask - it turns 255.0.255.0 into an integer and `prefixOf()` then reports 8, so
      // `ip route 192.0.2.0 255.0.255.0 10.1.1.9` answered "Route added: 192.0.2.0/8" and installed a prefix
      // nobody asked for. `ip address` has refused this mask, with this sentence, all along (#1411).
      if (!net.isContiguousMask(mask)) {
        return ['% Invalid mask: ' + mask + ' - a netmask is a run of ones then zeros (255.255.255.0, or 24)'];
      }
      // A port name used to be stored in the *gateway* field: `ip route 10.9.0.0 255.255.0.0 Gi0` kept
      // gw:"Gi0", and the route then tried to ARP for an address called "Gi0" - a route that is listed,
      // installed, printed, and cannot carry a packet, with nothing anywhere saying why. The directly
      // connected form is legal, so it is stored where routeTo() looks for it.
      if (gw) {
        const asPort = resolvePortName(this.device, gw);
        if (asPort) {
          if (iface) return ['% ' + dest + '/' + net.prefixOf(mask) + ': ' + asPort +
            ' is an interface, so it cannot also be followed by ' + iface];
          gw = null;
          iface = asPort;
        } else if (!net.isIp(gw)) {
          return ['% ' + dest + '/' + net.prefixOf(mask) + ': "' + gw + '" is neither a next-hop address ' +
            'nor an interface on ' + this.device.name];
        }
      }
      if (iface) {
        const named = resolvePortName(this.device, iface);
        if (!named) return ['% ' + dest + '/' + net.prefixOf(mask) + ': no interface called "' + iface + '"'];
        iface = named;
      }
      // With neither a next hop nor an interface there is nothing to send a packet to and no segment to ARP on,
      // and the route was still installed and reported as "on-link" - a route the table then describes with
      // "no next hop: ARP for the destination on that segment", naming a segment the command never mentioned.
      if (!gw && !iface) {
        return ['% Incomplete command: ip route ' + dest + ' ' + mask + ' needs a next hop or an interface'];
      }
      this.device.config.routes.push({ dest: dest, mask: mask, gw: gw || null, iface: iface });
      out.push('Route added: ' + dest + '/' + net.prefixOf(mask) +
        (gw ? ' via ' + gw + (iface ? ' ' + iface : '') : (iface ? ' out ' + iface : ' on-link')));
      if (!gw && iface) {
        // Legal, and often not what the operator wanted on a segment that is not point-to-point: with no
        // next hop the box ARPs for the *destination* on that wire, and only answers if the router in
        // between proxies ARP for it. Saying so at the moment of configuration is cheaper than letting it
        // look installed and carry nothing.
        out.push('  no next hop: this resolves by ARP on that segment, which needs proxy ARP on the far side');
      }
    } else if (head === 'no' && tokens[1] === 'ip' && tokens[2] === 'route') {
      const dest = tokens[3], mask = tokens[4], gw = tokens[5] || null;
      const before = this.device.config.routes.length;
      this.device.config.routes = this.device.config.routes.filter(function (r) {
        return !(r.dest === dest && r.mask === mask && (gw == null || r.gw === gw));
      });
      out.push(before > this.device.config.routes.length ? 'Route removed' : '% Route not found');
    } else if (head === 'ip' && tokens[1] === 'default-gateway') {
      const gw = tokens[2];
      // Accepted anything, including an address that cannot exist: the box then had a gateway no packet could
      // ever be sent to, and said "Default gateway: 300.1.1.1" (#1411).
      if (gw !== undefined && !net.isIp(gw)) {
        return ['% Invalid default gateway "' + gw + '": not an IPv4 address'];
      }
      this.device.config.defaultGateway = gw || null;
      out.push('Default gateway: ' + (gw || '(none)'));
    } else if (head === 'no' && tokens[1] === 'ip' && tokens[2] === 'default-gateway') {
      this.device.config.defaultGateway = null;
      out.push('Default gateway cleared');
    } else if (head === 'exit' || head === 'end') {
      // One level up from config mode is privileged EXEC (`#`), not user EXEC (`>`). Both `exit` and `end`
      // dropped two levels, so a script that left config mode came back with a `>` prompt - a prompt that
      // says the session lost its privileges, when it had lost nothing but a level.
      this.mode = MODE_ENABLE;
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
      // A virtual router answers for an address on behalf of a box that routes. Without l3-forward there is
      // nothing behind the group to answer for (#1387).
      const cannotRoute = this._capabilityRefusal('l3-forward', 'run a VRRP group');
      if (cannotRoute) return [cannotRoute];
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
    if (head === 'ip' && tokens[1] && String(tokens[1]).toLowerCase() === 'nat') {
      // `ip nat inside` / `ip nat outside` - which side of the translation this port is on. The model translated
      // on every port in both directions, so a rule for 192.168.10.0/24 rewrote the source of a packet going from
      // one inside host to another. The two words that say which side is which were missing (#1391).
      const cannotTranslate = this._capabilityRefusal('nat', 'translate addresses');
      if (cannotTranslate) return [cannotTranslate];
      const role = tokens[2] ? String(tokens[2]).toLowerCase() : '';
      if (role !== 'inside' && role !== 'outside') {
        return ['% Usage: ip nat inside | ip nat outside'];
      }
      return [this._setNatRole(iface, role)];
    }
    if (head === 'ip' && tokens[1] === 'address' && String(tokens[2] || '').indexOf('/') !== -1) {
      // `ip address 10.0.0.1/24` was answered with "% Incomplete command", which says nothing about what is
      // wrong or what would work. The address-and-prefix spelling is what almost every other tool takes, so
      // the refusal names the problem and both forms this parser accepts.
      const parts = String(tokens[2]).split('/');
      const bits = parts[1];
      const maskFromPrefix = require('./net').maskFromPrefix;
      const dotted = /^\d+$/.test(bits) && parseInt(bits, 10) <= 32
        ? maskFromPrefix(parseInt(bits, 10)) : '255.255.255.0';
      return ['% "' + tokens[2] + '" is an address with a prefix length, not an address and a mask: use ' +
        '"ip address ' + parts[0] + ' ' + dotted + '" or "ip address ' + parts[0] + ' ' + bits + '"'];
    }
    if (head === 'ip' && tokens[1] === 'address') {
      if (tokens[2] === 'dhcp') {
        // A port has one method, and this used to leave both: `ip address dhcp` set the DHCP flag while the
        // static address stayed on the interface. Three surfaces then disagreed - the port held an address it
        // did not own, `show ip interface brief` reported Method DHCP beside that address, and
        // `show running-config` printed only the static line, so a restore lost the DHCP intent entirely.
        // Setting the method displaces the other one, and says which.
        const had = iface.ip ? iface.ip + '/' + require('./net').prefixOf(iface.mask) : null;
        iface.dhcp = true;
        iface.ip = null;
        iface.mask = null;
        out.push('Interface ' + iface.name + ' set to DHCP' +
          (had ? ' (static address ' + had + ' removed)' : ''));
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
        // The other half of the same rule: a static address displaces the DHCP client, and says so, rather
        // than quietly changing the port's method.
        const wasDhcp = iface.dhcp === true;
        iface.ip = ip; iface.mask = dotted; iface.dhcp = false;
        out.push('IP address set on ' + iface.name + ': ' + ip + '/' + net.prefixOf(dotted) +
          (wasDhcp ? ' (DHCP client removed)' : ''));
      }
    } else if (head === 'no' && tokens[1] === 'ip' && tokens[2] === 'address') {
      // "IP address removed" was the answer whether or not there was one to remove, and whether the port was
      // asking DHCP for one or not.
      const hadIp = iface.ip ? iface.ip + '/' + require('./net').prefixOf(iface.mask) : null;
      const hadDhcp = iface.dhcp === true;
      iface.ip = null; iface.mask = null; iface.dhcp = false;
      if (!hadIp && !hadDhcp) out.push('% No IP address on ' + iface.name);
      else if (hadIp && hadDhcp) out.push('IP address ' + hadIp + ' and the DHCP client removed from ' + iface.name);
      else if (hadDhcp) out.push('DHCP client removed from ' + iface.name);
      else out.push('IP address ' + hadIp + ' removed from ' + iface.name);
    } else if (head === 'shutdown') {
      iface.enabled = false;
      // A port coming up or going down makes STP, OSPF and VRRP do their timers again. The clock only moved for a
      // cable before this, so a board that had already converged said it still was (#1331).
      this._controlPlaneChanged();
      out.push(iface.name + ' administratively down');
    } else if (head === 'no' && tokens[1] === 'shutdown') {
      iface.enabled = true;
      this._controlPlaneChanged();
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
    } else if (head === 'no' && tokens[1] === 'ip' && tokens[2] === 'access-group') {
      out.push.apply(out, this._accessGroup(['no'].concat(tokens.slice(3)), iface));
    } else if (head === 'ip' && tokens[1] === 'access-group') {
      out.push.apply(out, this._accessGroup(tokens.slice(2), iface));
    } else if (head === 'encapsulation') {
      out.push.apply(out, this._encap(tokens.slice(1), iface));
    } else if (head === 'switchport') {
      // Switching a frame is what `l2-forward` means. A router took `switchport mode trunk` and answered
      // "Switchport mode trunk on Gi0", then `show interfaces` printed nothing about it because the printer
      // knows a routed port does not switch (#1387). The command and the printer disagreed about the same box.
      const cannotSwitch = this._capabilityRefusal('l2-forward', 'switch frames');
      if (cannotSwitch) return [cannotSwitch + this._routedPortHint()];
      const changed = this._switchport(tokens.slice(1), iface);
      // A VLAN parameter changes which ports forward for which VLAN, which is exactly what STP's timers are about.
      this._controlPlaneChanged();
      out.push.apply(out, changed);
    } else if (head === 'no' && tokens[1] === 'switchport') {
      const cannotSwitch = this._capabilityRefusal('l2-forward', 'switch frames');
      if (cannotSwitch) return [cannotSwitch + this._routedPortHint()];
      // `no switchport access vlan` has to remove the access VLAN, not the whole switchport configuration.
      // Every `no switchport ...` form used to fall through to the blanket reset, so removing one leaf
      // cleared the mode, the native VLAN and the allowed list as well - five fields gone, announced as
      // "reset to defaults".
      out.push.apply(out, this._switchport(['no'].concat(tokens.slice(2)), iface));
    } else if (head === 'channel-group') {
      // A LAG is a bundle of switch ports; there is nothing to bundle on a box that does not switch.
      const cannotBundle = this._capabilityRefusal('l2-forward', 'bundle ports into a LAG');
      if (cannotBundle) return [cannotBundle];
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
      this.mode = MODE_ENABLE;
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
    const isIp = function (s) { return net.isIp(String(s || '')); };

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

    // `neighbor 300.1.1.1 remote-as 65002` fell through to the generic usage line, because this form is guarded by
    // isIp(): the refusal named the whole syntax instead of the address that is not one (#1411).
    if (!isIp(t[0]) && /^[0-9.]+$/.test(String(t[0] || '')) && String(t[1] || '').toLowerCase() === 'remote-as') {
      return ['% Invalid neighbor address "' + t[0] + '": not an IPv4 address'];
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
      const cannotRoute = this._capabilityRefusal('l3-forward', 'run OSPF');
      if (cannotRoute) return [cannotRoute];
      const ip = t[1] || '';
      if (!net.isIp(ip)) return ['% Invalid router-id "' + ip + '": not an IPv4 address'];
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
    // A VLAN parameter is not a mode change. These three commands used to set the port's `mode` as a side
    // effect, so `switchport trunk native vlan 20` on an access port silently turned it into a trunk: a
    // different command, in a different column of the table, changed what the port forwards. Real gear stores
    // the parameter and leaves the mode alone - which is also how a trunk is staged before the cable is
    // patched - and now so does this one, saying what is stored and what it will take to use it.
    function modeNote(self, iface, wanted) {
      const current = (iface.vlan && iface.vlan.mode) || 'access';
      if (current === wanted) return '';
      return ' (stored; the port is in ' + current + ' mode - set "switchport mode ' + wanted + '" to use it)';
    }
    // ---------------------------------------------------------------- per-leaf `no`
    if (t[0] === 'no') {
      const leaf = t.slice(1);
      const cur = vlanLib.normalizePortConfig(iface.vlan || {});
      const written = function (next, message) {
        iface.vlan = vlanLib.normalizePortConfig(Object.assign({}, cur, next));
        this.device.flushMacsOnPort(iface.name);
        return [message];
      }.bind(this);

      // `no switchport` - the whole port, back to the defaults it boots with.
      if (!leaf.length) {
        // Spelled out rather than left to the normaliser: for an access port it fills an unset allowed list
        // with `[]`, which is indistinguishable from the empty list the reset would then report as a change
        // on every subsequent run. A trunk's default really is "all".
        const defaults = vlanLib.normalizePortConfig({
          mode: 'access', accessVlan: 1, nativeVlan: 1, allowedVlans: 'all', voiceVlan: null
        });
        const changed = [];
        if (cur.mode !== 'access') changed.push('mode ' + cur.mode + ' -> access');
        if (Number(cur.accessVlan) !== 1) changed.push('access VLAN ' + cur.accessVlan + ' -> 1');
        if (Number(cur.nativeVlan) !== 1) changed.push('native VLAN ' + cur.nativeVlan + ' -> 1');
        if (JSON.stringify(cur.allowedVlans) !== JSON.stringify(defaults.allowedVlans)) {
          changed.push('allowed list -> all');
        }
        if (cur.voiceVlan !== null) changed.push('voice VLAN ' + cur.voiceVlan + ' -> none');
        if (!changed.length) {
          // Nothing to do, so do not claim to have done it.
          return ['% ' + iface.name + ' already has default switchport settings (access VLAN 1)'];
        }
        iface.vlan = defaults;
        this.device.flushMacsOnPort(iface.name);
        return ['Switchport reset to defaults on ' + iface.name + ' (' + changed.join(', ') + ')'];
      }

      if (leaf[0] === 'access' && leaf[1] === 'vlan') {
        const wanted = leaf[2] === undefined ? null : parseInt(leaf[2], 10);
        if (wanted !== null && wanted !== Number(cur.accessVlan)) {
          return ['% ' + iface.name + ' access VLAN is ' + cur.accessVlan + ', not ' + wanted];
        }
        if (Number(cur.accessVlan) === 1) {
          return ['% ' + iface.name + ' access VLAN is already the default (1)'];
        }
        const was = cur.accessVlan;
        return written({ accessVlan: 1 }, 'Access VLAN ' + was + ' removed from ' + iface.name +
          ' (back to 1)');
      }
      if (leaf[0] === 'trunk' && leaf[1] === 'native' && leaf[2] === 'vlan') {
        if (Number(cur.nativeVlan) === 1) {
          return ['% ' + iface.name + ' trunk native VLAN is already the default (1)'];
        }
        const was = cur.nativeVlan;
        return written({ nativeVlan: 1 }, 'Trunk native VLAN ' + was + ' removed from ' + iface.name +
          ' (back to 1)');
      }
      if (leaf[0] === 'trunk' && leaf[1] === 'allowed' && leaf[2] === 'vlan') {
        if (cur.allowedVlans === 'all') {
          return ['% ' + iface.name + ' trunk already allows all VLANs'];
        }
        return written({ allowedVlans: 'all' }, 'Trunk on ' + iface.name + ' allows all VLANs again');
      }
      if (leaf[0] === 'voice' && leaf[1] === 'vlan') {
        if (cur.voiceVlan === null) return ['% ' + iface.name + ' has no voice VLAN'];
        const was = cur.voiceVlan;
        return written({ voiceVlan: null }, 'Voice VLAN ' + was + ' removed from ' + iface.name);
      }
      if (leaf[0] === 'mode') {
        if (cur.mode === 'access') {
          return ['% ' + iface.name + ' is already in access mode'];
        }
        // The parameters are stored independently of the mode, so they stay - which is what makes it
        // possible to go back to a trunk later without retyping them.
        return written({ mode: 'access' },
          iface.name + ' back to access mode (trunk settings kept: native ' + cur.nativeVlan + ', allowed ' +
          (cur.allowedVlans === 'all' ? 'all' : (Array.isArray(cur.allowedVlans) ? cur.allowedVlans.join(',') : 'all')) +
          ')');
      }
      return ['% Unrecognized switchport command: no ' + leaf.join(' ')];
    }

    if (t[0] === 'access' && t[1] === 'vlan') {
      const bad = this._vlanIdRefusal(tokens[2], 'an access VLAN');
      if (bad) return [bad];
      const id = parseInt(t[2], 10);
      const chk = vlanLib.validatePortConfig({ accessVlan: id });
      if (!chk.ok) return [this._vlanRefusal(chk, 'access VLAN')];
      const note = modeNote(this, iface, 'access');
      iface.vlan = vlanLib.normalizePortConfig(Object.assign({}, iface.vlan, { accessVlan: id }));
      this.device.flushMacsOnPort(iface.name);
      return ['Access VLAN ' + id + ' on ' + iface.name + note];
    }
    if (t[0] === 'voice' && t[1] === 'vlan') {
      // The voice VLAN was in the config shape, validated and printed, and read by nothing: a phone on a
      // port configured for voice traffic landed in the data VLAN (#1368).
      const arg = String(t[2] === undefined ? '' : t[2]).toLowerCase();
      if (arg === 'none') {
        const was = vlanLib.normalizePortConfig(iface.vlan || {}).voiceVlan;
        if (was === null) return ['% ' + iface.name + ' has no voice VLAN'];
        iface.vlan = vlanLib.normalizePortConfig(Object.assign({}, iface.vlan, { voiceVlan: null }));
        this.device.flushMacsOnPort(iface.name);
        return ['Voice VLAN ' + was + ' removed from ' + iface.name];
      }
      const bad = this._vlanIdRefusal(tokens[2], 'a voice VLAN', 'none');
      if (bad) return [bad];
      const id = parseInt(arg, 10);
      // Validate the field this command writes, not the whole port: a port whose native VLAN is not in its own
      // allowed list (legal to build, reported by `show interfaces`) must still accept a voice VLAN, and the
      // refusal has to be about the number the operator just typed.
      const chk = vlanLib.validatePortConfig({ voiceVlan: id });
      if (!chk.ok) return [this._vlanRefusal(chk, 'voice VLAN')];
      const note = modeNote(this, iface, 'trunk');
      iface.vlan = vlanLib.normalizePortConfig(Object.assign({}, iface.vlan, { voiceVlan: id }));
      this.device.flushMacsOnPort(iface.name);
      return ['Voice VLAN ' + id + ' on ' + iface.name + note];
    }
    if (t[0] === 'trunk' && t[1] === 'native' && t[2] === 'vlan') {
      const bad = this._vlanIdRefusal(tokens[3], 'a trunk native VLAN');
      if (bad) return [bad];
      const id = parseInt(t[3], 10);
      const chk = vlanLib.validatePortConfig({ nativeVlan: id });
      if (!chk.ok) return [this._vlanRefusal(chk, 'trunk native VLAN')];
      const note = modeNote(this, iface, 'trunk');
      iface.vlan = vlanLib.normalizePortConfig(Object.assign({}, iface.vlan, { nativeVlan: id }));
      this.device.flushMacsOnPort(iface.name);
      return ['Trunk native VLAN ' + id + ' on ' + iface.name + note];
    }
    if (t[0] === 'trunk' && t[1] === 'allowed' && t[2] === 'vlan') {
      const spec = t.slice(3).join('');
      if (!spec) return ['% Incomplete command'];
      const allowedNote = (iface.vlan && iface.vlan.mode) === 'trunk' ? ''
        : ' (stored; the port is in ' + ((iface.vlan && iface.vlan.mode) || 'access') +
          ' mode - set "switchport mode trunk" to use it)';
      if (spec === 'all') {
        iface.vlan = vlanLib.normalizePortConfig(Object.assign({}, iface.vlan, { allowedVlans: 'all' }));
        this.device.flushMacsOnPort(iface.name);
        return ['Trunk on ' + iface.name + ' allows all VLANs' + allowedNote];
      }
      const parsed = vlanLib.parseVlanList(spec);
      if (!parsed.ok) return ['% ' + (parsed.message || 'invalid VLAN list')];
      const bad = parsed.vlans.filter(function (v) { return v < 1 || v > 4094; });
      if (bad.length) return ['% VLAN out of range: ' + bad[0]];
      iface.vlan = vlanLib.normalizePortConfig(Object.assign({}, iface.vlan, { allowedVlans: parsed.vlans }));
      this.device.flushMacsOnPort(iface.name);
      return ['Trunk on ' + iface.name + ' allows VLANs ' + parsed.vlans.join(',') + allowedNote];
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
      // It used to print "Removed Fa0/4 from any channel group" for a port that was in none - the same
      // sentence for work done and work not done.
      const was = Object.keys(dev.config.lags).filter(function (id) {
        return (dev.config.lags[id].members || []).indexOf(iface.name) !== -1;
      });
      if (!was.length) return ['% ' + iface.name + ' is not in a channel group'];
      const gone = [];
      for (const id of was) {
        const l = dev.config.lags[id];
        l.members = (l.members || []).filter(function (m) { return m !== iface.name; });
        gone.push(id);
        if (!l.members.length) delete dev.config.lags[id];
      }
      return [iface.name + ' removed from channel group ' + gone.join(', ') +
        (gone.some(function (id) { return !dev.config.lags[id]; }) ? ' (the group had no other members)' : '')];
    }

    const id = t[0];
    if (!id) return ['% Usage: channel-group <id> mode active|passive|on'];
    let typed = 'active';
    const mi = t.indexOf('mode');
    if (mi !== -1 && t[mi + 1]) typed = t[mi + 1];
    if (['active', 'passive', 'on', 'static'].indexOf(typed) === -1) {
      return ['% Invalid mode: ' + typed + ' (use active|passive|on)'];
    }
    // The console's word is translated to the model's once, here; nothing downstream should ever see "active".
    const mode = lagLib.canonicalMode(typed);
    const existing = dev.config.lags[id];
    const g = existing || { mode: mode, hashPolicy: 'l2', members: [] };
    const out = [];
    if (existing && existing.mode && existing.mode !== mode) {
      // A group is one object: its mode belongs to every member. Changing it from one port silently rewrote
      // what the other ports were configured with, and `show running-config` quietly reprinted them all with
      // the new mode. Say it.
      const others = (existing.members || []).filter(function (m) { return m !== iface.name; });
      out.push('Channel group ' + id + ' mode changed from ' + lagLib.cliMode(existing.mode) + ' to ' + typed +
        (others.length ? ' for every member: ' + others.join(', ') : ''));
    }
    g.mode = mode;
    if (!g.members) g.members = [];
    if (g.members.indexOf(iface.name) === -1) g.members.push(iface.name);
    dev.config.lags[id] = g;

    out.push('Interface ' + iface.name + ' added to channel group ' + id + ' (mode ' + lagLib.cliMode(mode) + ')');
    const chk = lagLib.validateLag ? lagLib.validateLag(g) : null;
    // A group is built one port at a time, so "needs at least 2 members" is true of every bundle for as long
    // as it takes to type the second line. Warning on it turns every correct configuration into a warning
    // storm, which is how a warning stops being read. The shortfall is reported where it matters - in
    // `show etherchannel summary`, which already says the bundle is not carrying traffic and why.
    const NOT_HERE_YET = ['E_LAG_TOO_FEW'];
    const real = (chk && chk.ok === false && Array.isArray(chk.errors))
      ? chk.errors.filter(function (e) { return NOT_HERE_YET.indexOf(e.code) === -1; })
      : [];
    if (real.length) out.push('% Warning: ' + real[0].message);
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
    // `parseEntry` reports a refusal as `{ code, message }`, and this printed the object: `access-list 10 permit
    // 300.1.1.0 0.0.0.255` answered `% [object Object]` (#1411). The message is the part to print.
    if (!entry || entry.error) {
      const why = entry && entry.error;
      return ['% ' + (why && why.message ? why.message : (typeof why === 'string' ? why : 'invalid entry'))];
    }
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
    const dev0 = this.device;
    if (String(tokens[0]).toLowerCase() === 'no') {
      // `ip access-group` had no `no` form at all: an interface could be given an access list, the config
      // printed the line, and there was no way to take it off again from the console.
      const rest = tokens.slice(1);
      const want = rest[0] != null ? parseInt(rest[0], 10) : null;
      const dir = String(rest[1] || '').toLowerCase();
      if (dir && dir !== 'in' && dir !== 'out') return ['% Usage: no ip access-group [<acl>] [in|out]'];
      const binds = (dev0.aclBindings && dev0.aclBindings[iface.name]) || {};
      const dirs = dir ? [dir] : ['in', 'out'];
      const cleared = [];
      for (const d of dirs) {
        if (binds[d] == null) continue;
        // Never unbind a different list than the one named: silently clearing whatever happened to be there
        // would take away a policy the operator did not ask about.
        if (want != null && Number(binds[d]) !== want) {
          return ['% Access list ' + binds[d] + ' is applied ' + d + ' on ' + iface.name + ', not ' + want];
        }
        delete binds[d];
        cleared.push(d);
      }
      if (!cleared.length) {
        const what = want != null ? 'access list ' + want : 'an access list';
        return ['% No ' + what + ' applied ' + (dir || 'in or out') + ' on ' + iface.name];
      }
      if (dev0.aclBindings && dev0.aclBindings[iface.name] &&
          !Object.keys(dev0.aclBindings[iface.name]).length) {
        delete dev0.aclBindings[iface.name];
      }
      return ['Interface ' + iface.name + ': access list unapplied ' + cleared.join(' and ')];
    }
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
        // Phrased as a statement about the pool, not about the command just typed: after `no range` this used
        // to read like the deletion had been rejected, when it had been carried out and left the pool
        // incomplete - which is exactly the state the operator asked for.
        for (const e of check.errors) out.push('% Pool ' + pool.name + ' is incomplete - ' + e.message +
          ' (' + e.code + ')');
      }
      this.mode = mode;
      this.pool = null;
      return out;
    };

    if (head === 'exit') return finish(MODE_CONFIG);
    if (head === 'end') return finish(MODE_ENABLE);
    if (head === 'network') {
      if (!tokens[1]) return incomplete('Incomplete command: network <network> [mask|/prefix]');
      // The usage line has always advertised the `/prefix` spelling, and the parser stored it verbatim: the
      // pool then held network "10.5.0.0/24", which the validator rejects, so a documented form of the
      // command produced a pool that could not serve. Split it here, with the one mask rule, so both
      // spellings end up as the same state.
      const slash = String(tokens[1]).indexOf('/');
      if (slash !== -1) {
        const networkPart = String(tokens[1]).slice(0, slash);
        const prefixPart = String(tokens[1]).slice(slash + 1);
        const maskFromPrefix = require('./net').maskFromPrefix;
        const mask = /^\d+$/.test(prefixPart) && parseInt(prefixPart, 10) <= 32
          ? maskFromPrefix(parseInt(prefixPart, 10)) : null;
        if (!networkPart || !mask) {
          return incomplete('Invalid network "' + tokens[1] +
            '" - use <network> <mask> or <network> <prefix-bits>');
        }
        pool.network = networkPart;
        pool.mask = mask;
      } else {
        pool.network = tokens[1];
        if (tokens[2]) pool.mask = tokens[2];
      }
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
      //
      // The two tokens are told apart by shape, because `host <mac> <address>` is the same statement in the other
      // order and this handler used to store it verbatim: the reservation came out keyed by the *address*, so the
      // pool held `{"192.168.10.104": "aa:bb:cc:00:00:98"}` and said nothing until `exit` refused the whole pool
      // with "reservation key ... is not a valid MAC address" (#1373). A refusal at the point of the typo beats a
      // refusal three commands later that blames the pool.
      if (!tokens[1] || !tokens[2]) return incomplete('Incomplete command: host <address> <mac> | host <mac> <address>');
      const isMacShaped = function (x) { return /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/i.test(String(x)); };
      const isAddrShaped = function (x) { return net.isIp(String(x)); };
      let address = null, mac = null;
      if (isAddrShaped(tokens[1]) && isMacShaped(tokens[2])) { address = tokens[1]; mac = tokens[2]; }
      else if (isMacShaped(tokens[1]) && isAddrShaped(tokens[2])) { address = tokens[2]; mac = tokens[1]; }
      if (address === null || mac === null) {
        return ['% Not a reservation: give an address and a MAC, in either order ' +
          '(host ' + tokens[1] + ' ' + tokens[2] + ' is neither). A MAC is six hex pairs, like aa:bb:cc:00:00:99.'];
      }
      if (!pool.reservations) pool.reservations = {};
      pool.reservations[mac] = address;
    } else if (head === 'no') {
      const what = (tokens[1] || '').toLowerCase();
      // These used to answer nothing at all - not even "done" - so a `no` that silently did nothing was
      // indistinguishable from one that worked, and `no network` was missing outright. Each now says what it
      // removed, or refuses and names what is not there.
      if (what === 'network') {
        if (pool.network == null && pool.mask == null) return ['% No network configured in pool ' + pool.name];
        delete pool.network;
        delete pool.mask;
        out.push('Network cleared from pool ' + pool.name);
      } else if (what === 'default-router') {
        if (pool.gateway == null) return ['% No default-router in pool ' + pool.name];
        delete pool.gateway;
        out.push('Default router cleared from pool ' + pool.name);
      } else if (what === 'dns-server') {
        if (pool.dns == null) return ['% No dns-server in pool ' + pool.name];
        delete pool.dns;
        out.push('DNS servers cleared from pool ' + pool.name);
      } else if (what === 'range') {
        if (pool.rangeStart == null) return ['% No range in pool ' + pool.name];
        delete pool.rangeStart;
        delete pool.rangeEnd;
        out.push('Range cleared from pool ' + pool.name);
      } else if (what === 'lease') {
        if (pool.leaseSec == null) return ['% No lease in pool ' + pool.name + ' (the default applies)'];
        delete pool.leaseSec;
        out.push('Lease cleared from pool ' + pool.name + ' (the default applies)');
      } else if (what === 'excluded-address' || (what === 'excluded' && tokens[2] === 'address')) {
        // Naming one address removes that one; naming none clears the list. Clearing the whole list when one
        // address was named is how a box quietly starts handing out an address that was reserved for a printer.
        const from = what === 'excluded' ? 3 : 2;
        const named = tokens.slice(from).filter(Boolean);
        const have = Array.isArray(pool.excluded) ? pool.excluded : [];
        if (!have.length) return ['% No excluded addresses in pool ' + pool.name];
        if (!named.length) {
          pool.excluded = [];
          out.push('All excluded addresses cleared from pool ' + pool.name + ' (' + have.length + ')');
        } else {
          const missing = named.filter(function (x) { return have.indexOf(x) === -1; });
          if (missing.length === named.length) {
            return ['% Not excluded in pool ' + pool.name + ': ' + named.join(', ')];
          }
          pool.excluded = have.filter(function (x) { return named.indexOf(x) === -1; });
          out.push('Excluded address removed from pool ' + pool.name + ': ' +
            named.filter(function (x) { return have.indexOf(x) !== -1; }).join(', '));
        }
      } else if (what === 'host') {
        // host <address> [<mac>] - the address may be named alone when only one reservation holds it.
        // `no host <addr>` and `no host <mac>` are both legal: a MAC address and an IPv4 address are told
        // apart by shape, so the one-token form is not mistaken for an address it can never match.
        const looksMac = function (x) { return /:/.test(String(x || '')); };
        const addr = looksMac(tokens[2]) ? null : tokens[2];
        const mac = looksMac(tokens[2]) ? tokens[2] : tokens[3];
        const res = pool.reservations || {};
        const byMac = Object.keys(res).filter(function (m) {
          if (mac) return m === mac;
          return res[m] === addr;
        });
        if (!addr && !mac) return ['% Incomplete command: no host <address> [<mac>]'];
        if (!byMac.length) {
          return ['% No reservation' + (addr ? ' for ' + addr : '') + ' in pool ' + pool.name];
        }
        const gone = byMac.map(function (m) { return res[m] + ' (' + m + ')'; });
        for (const m of byMac) delete res[m];
        out.push('Reservation removed from pool ' + pool.name + ': ' + gone.join(', '));
      } else if (what === 'pool') {
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
    let requestedCount = null;
    let atMs = null;
    let strayToken = null;
    let atProblem = null;
    for (let i = 1; i < tokens.length; i++) {
      const tok = String(tokens[i]);
      if (tok.toLowerCase() === 'at') {
        const when = tokens[i + 1];
        if (when === undefined) { atProblem = 'Invalid instant: "at" needs a time in milliseconds'; i++; continue; }
        const t = Number(when);
        if (!Number.isFinite(t) || t < 0) { atProblem = 'Invalid instant: ' + when; i++; continue; }
        atMs = t;
        i++;
        continue;
      }
      if (/^[0-9]+$/.test(tok)) { requestedCount = Number(tok); count = requestedCount; continue; }
      if (strayToken === null) strayToken = tok;
    }
    // A hostname is a target. `Simulator.ping()` has resolved names through the lab's DNS servers since
    // #241 - it emits a dns event and distinguishes NXDOMAIN from NODATA from SERVFAIL - and this guard
    // refused the name before the engine ever saw it, so the one command everybody reaches for first could
    // not use the resolver the product already has (#1375).
    const target = String(ip === undefined || ip === null ? '' : ip);
    if (!target) return ['% Invalid ping target: (none)'];
    // The count was whatever the number after the address happened to be, so `ping 10.0.0.1 5000` sent 5000
    // echoes, `ping 10.0.0.1 0` silently sent four, and a stray word was ignored. Name the rule instead (#1379):
    // one syntax, one message per mistake.
    if (strayToken !== null) {
      return ['% Unrecognized "' + strayToken + '" (ping <address|name> [<count 1-50>] [at <ms>])'];
    }
    if (requestedCount !== null && (requestedCount < 1 || requestedCount > 50)) {
      return ['% Count must be a whole number from 1 to 50 (asked for ' + requestedCount + ')'];
    }
    if (atProblem !== null) return ['% ' + atProblem];
    // `net.isIp()` is a shape check (three dots, one to three digits), so 10.0.0.999 passes it and the engine
    // throws "Invalid IPv4 address" at the first packet. Ask the question properly here: is every octet in range?
    const strictIp = function (x) {
      try { net.ipToInt(x); return true; } catch (e) { return false; }
    };
    const namedTarget = !strictIp(target);
    // Digits and dots that are not an address are a typo, not a hostname: resolving 10.0.0.999 as a name would
    // answer NXDOMAIN and send the operator looking in the wrong place.
    if (namedTarget && /^[0-9.]+$/.test(target)) {
      return ['% Invalid ping target: ' + target + ' (not an IPv4 address, and not a name that could resolve)'];
    }
    if (!this.sim) return ['% Simulator not attached'];
    // The instant is a property of the question, not of the session. `setRunTime()` persists on the simulator, so
    // `ping <a> at 0` used to leave the whole console answering at t=0 - the next plain `ping`, a later
    // `show ip route`, anything - and the answer's convergence line printed `at t=null ms` because it read the
    // typed value instead of the instant used (#1383).
    const priorRunAtMs = this.sim.runAtMs;
    if (atMs !== null) {
      if (!Number.isFinite(atMs) || atMs < 0) return ['% Invalid instant: ' + tokens[tokens.indexOf('at') + 1]];
      this.sim.setRunTime(atMs);
    }
    try {
    out.push('Type escape sequence to abort.');
    let shownTarget = target;
    if (namedTarget) {
      // Resolve first, the way a box prints it: Translating "server.lab"...domain server (10.0.0.53) [OK]
      const probe = this.sim.resolveName ? this.sim.resolveName(this.device, target) : null;
      const serverLabel = function (pr) {
        if (!pr) return 'none';
        if (pr.serverIp) return pr.serverIp;
        return pr.serverId || pr.server || 'none';
      };
      if (probe && probe.ok) {
        out.push('Translating "' + target + '"...domain server (' +
          serverLabel(probe) + ') [OK]');
        out.push('  ' + target + ' -> ' + probe.address);
        shownTarget = probe.address;
      } else if (probe) {
        const status = String(probe.status || 'unknown').toUpperCase();
        const why = {
          NXDOMAIN: 'no zone any server here hosts contains that name',
          NODATA: 'the name exists on ' + serverLabel(probe) + ' but has no A record',
          SERVFAIL: 'no device in this lab hosts a DNS zone, or no listed server answered'
        }[status] || 'the resolver did not answer';
        return ['% Could not resolve "' + target + '": ' + status + ' - ' + why,
          '% Nothing was sent. ' + (status === 'NODATA'
            ? 'Add an A record: dns add ' + target + ' A <address>'
            : 'Check the zone on ' + serverLabel(probe) + ', or the name servers this device asks.')];
      }
    }
    out.push('Sending ' + count + ', 100-byte ICMP Echos to ' + shownTarget + ', timeout is 2 seconds:' +
      (atMs !== null ? '  (at t=' + atMs + ' ms)' : ''));
    const res = this.sim.ping(this.device.id, namedTarget ? target : ip, { count: count });
    const marks = res.replies.map(function (r) { return r.success ? '!' : '.'; }).join('');
    out.push(marks);
    const ok = res.replies.filter(function (r) { return r.success; }).length;
    out.push('Success rate is ' + Math.round((ok / count) * 100) + ' percent (' + ok + '/' + count + ')');
    for (const r of res.replies) {
      if (r.success) {
        const t = (r.rtt === null || r.rtt === undefined)
          ? (r.hops + ' hops')
          : (r.rtt < 1 ? r.rtt.toFixed(3) : r.rtt.toFixed(1)) + ' ms';
        out.push('Reply from ' + shownTarget + ': bytes=100 time=' + t);
      } else if (r.reason === 'converging') {
        // Not "request timed out": nothing was lost, the network is not up yet. Said once, below, rather than
        // once per echo - the answer is one fact about the path, not four (#1383).
      } else {
        out.push('Request timed out (seq ' + r.seq + ')');
      }
    }
    // "Still converging" is a statement about the path, so it is printed once, with the instant the answer was
    // given at - which is the answer's own, not the one the operator typed (#1383).
    const converging = require('./simulator').pingConvergenceSentence(res.replies);
    if (converging) {
      out.push('% ' + converging + (res.runAtMs === null ? '' : ' at t=' + res.runAtMs + ' ms'));
    }
    return out;
    } finally {
      // Whatever the ping did or failed to do, the session is left at the instant it arrived with.
      this.sim.runAtMs = priorRunAtMs;
    }
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
      // "since 1200 ms" is an instant wearing a duration's clothes: it reads as "1200 ms ago", and at run time 5000
      // it is 3800 ms ago. Say both, and say plainly when the instant belongs to a run that is not this one.
      const now = (this.sim && Number.isFinite(this.sim.runAtMs)) ? this.sim.runAtMs : null;
      let when = '';
      // `l.stateSinceMs` was tested for truth, so a cable pulled at t=0 - the first change in a run - printed no
      // instant at all, while every later one did (#1385).
      if (l.stateSinceMs !== null && l.stateSinceMs !== undefined) {
        if (now === null) when = ', changed at ' + l.stateSinceMs + ' ms';
        else if (l.stateSinceMs > now) when = ', changed at ' + l.stateSinceMs + ' ms (not this run)';
        else when = ', changed at ' + l.stateSinceMs + ' ms (' + (now - l.stateSinceMs) + ' ms ago)';
      }
      out.push('  state: ' + l.state + when);
      return out;
    }
    if (what !== 'up' && what !== 'down') {
      return ['% Invalid input: link ' + args.join(' ') + ' - expected up, down or state'];
    }
    if (!id) return ['% Incomplete command: link ' + what + ' <linkId>'];

    // No `at` means "now", and "now" is wherever the session is standing - not t=0 (#1385).
    let atMs = null;
    const at = args.indexOf('at');
    if (at !== -1) {
      atMs = Number(args[at + 1]);
      if (!Number.isFinite(atMs) || atMs < 0) return ['% Invalid time: ' + (args[at + 1] || '(none)')];
    }

    const res = this.sim.setLinkState(id, what, atMs === null ? {} : { atMs: atMs });
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
  // `show ip dns [zone [<name>]]`.
  //
  // `dns zone` and `dns add` have been writable since DNS was modelled, and `Simulator.resolveName()` answers
  // queries from those zones - but nothing could show a zone back. So an operator could add a record and had no way
  // to see what the server would actually answer, which is the same defect `show ip dhcp pool` closed for pools
  // (#1375). The rows come from `dns.normalizeZone()` and the honesty comes from `dns.validateZone()`: a zone the
  // server would refuse to answer for says so, with the reason, instead of being printed as if it were live.
  _showDns(args) {
    const dev = this.device;
    const dnsLib = require('./dns');
    const out = [];
    const zones = (dev.config && Array.isArray(dev.config.dnsZones)) ? dev.config.dnsZones : [];
    const servers = (dev.config && Array.isArray(dev.config.dnsServers)) ? dev.config.dnsServers : [];
    const sub = String(args[0] === undefined ? '' : args[0]).toLowerCase();
    const want = args.slice(1).join(' ').trim();

    const fmtRecord = function (rec) {
      const ttl = String(rec.ttl === null || rec.ttl === undefined ? '-' : rec.ttl);
      const prio = (rec.priority === null || rec.priority === undefined) ? '' : ' (priority ' + rec.priority + ')';
      return '  ' + pad(rec.name || '@', 34) + pad(ttl, 8) + pad('IN ' + rec.type, 10) + (rec.value || '-') + prio;
    };

    if (sub === '' || sub === 'zone' || sub === 'zones') {
      if (sub === 'zone' && want) {
        const key = dnsLib.normalizeName(want);
        const raw = zones.filter(function (z) { return dnsLib.normalizeName(z.name) === key; })[0];
        if (!raw) {
          out.push('% No DNS zone ' + want + ' on this device' +
            (zones.length ? ' (zones here: ' + zones.map(function (z) { return z.name; }).join(', ') + ')' : ''));
          return out;
        }
        const z = dnsLib.normalizeZone(raw);
        const check = dnsLib.validateZone(raw);
        out.push('Zone ' + z.name + ' (default TTL ' + z.defaultTtl + ')' +
          (check.ok ? '' : ' - NOT answered: ' + check.errors[0].message));
        if (!z.records.length) out.push('  (no records: every query is NXDOMAIN)');
        for (const rec of z.records) out.push(fmtRecord(rec));
        return out;
      }

      if (!zones.length) {
        out.push('% This device is not a DNS server (no "dns zone" configured)');
      } else {
        for (const raw of zones) {
          const z = dnsLib.normalizeZone(raw);
          const check = dnsLib.validateZone(raw);
          out.push('Zone ' + z.name + ' (default TTL ' + z.defaultTtl + ') - ' + z.records.length + ' record(s)' +
            (check.ok ? '' : ' - NOT answered: ' + check.errors[0].message));
          for (const rec of z.records) out.push(fmtRecord(rec));
        }
      }
      if (servers.length) {
        out.push('');
        out.push('Name servers this device asks: ' + servers.join(', '));
      } else if (zones.length) {
        out.push('');
        out.push('Name servers this device asks: none configured - a lookup falls back to any server in the lab');
      } else {
        out.push('');
        out.push('% No name servers configured (use "ip name-server <address>" in config mode)');
      }
      return out;
    }

    out.push('% Usage: show ip dns [zone [<name>]]');
    return out;
  }

  // `show ip dhcp binding` and `show ip dhcp pool`.
  //
  // DHCP has been modelled end to end since it was: pools, ranges, exclusions, reservations, lease times, renewals
  // and expiry. The server keeps an allocation table (mac -> address, expiry) and **nothing could read it**: there
  // was no `show ip dhcp` at all, so an operator could configure a pool and could not find out which addresses had
  // been handed out, to whom, or when they come back (#1373). The bindings come from the engine's own table
  // through `Simulator.dhcpBindings()`, and the pool view is the pool the server actually answers from
  // (`normalizePool()` + `validatePool()`), not a re-reading of the config text.
  _showDhcp(args) {
    const dev = this.device;
    const out = [];
    const dhcpLib = require('./dhcp');
    const pools = (dev.config && Array.isArray(dev.config.dhcpPools)) ? dev.config.dhcpPools : [];
    const sub = String(args[0] === undefined ? '' : args[0]).toLowerCase();
    const want = args.slice(1).join(' ').trim();

    const normalized = pools.map(function (raw) { return dhcpLib.normalizePool(raw); });
    const poolByName = function (name) {
      for (const p of normalized) { if (p.name === name) return p; }
      return null;
    };
    const human = function (sec) {
      if (sec === null || sec === undefined) return '-';
      const s = Math.max(0, Math.floor(sec));
      const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
      return s + 's' + (h ? ' (' + h + ':' + String(m).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0') + ')' : '');
    };
    if (sub === '' || sub === 'binding' || sub === 'bindings' || sub === 'lease' || sub === 'leases') {
      if (!pools.length) {
        out.push('% This device is not a DHCP server (no "ip dhcp pool" configured)');
        return out;
      }
      if (!this.sim) {
        out.push('% no binding state has been evaluated yet - run a simulation');
        return out;
      }
      let rows = this.sim.dhcpBindings ? this.sim.dhcpBindings(dev.id) : [];
      if (want) {
        const needle = want.toLowerCase();
        const looksMac = /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/.test(needle);
        const matched = rows.filter(function (r) {
          return looksMac ? String(r.mac).toLowerCase() === needle : r.ip === want;
        });
        if (!matched.length) {
          out.push('% No binding for ' + want +
            (looksMac ? ' (no lease is held by that MAC)' : ' (no lease holds that address)'));
          return out;
        }
        rows = matched;
      }
      out.push(pad('IP address', 16) + pad('Client identifier / MAC', 30) + pad('Pool', 18) + 'Expires in');
      if (!rows.length) {
        out.push('% no leases: nothing has asked this server for an address yet');
        return out;
      }
      let lapsed = 0;
      for (const r of rows) {
        const pool = r.pool ? poolByName(r.pool) : null;
        const reserved = !!(pool && pool.reservations && pool.reservations[r.mac] === r.ip);
        const isExpired = r.state === 'expired';
        if (isExpired) lapsed++;
        out.push(pad(r.ip, 16) + pad(r.mac + (reserved ? ' (reserved)' : ''), 30) +
          pad(r.pool || '-', 18) +
          (isExpired ? 'lapsed (address free)' : human(r.remainingSec)));
      }
      const active = rows.length - lapsed;
      out.push('');
      out.push(active + ' active binding(s)' + (lapsed ? ', ' + lapsed + ' lapsed' : '') +
        '; the lease clock runs from the instant the lease was granted');
      return out;
    }

    if (sub === 'pool' || sub === 'pools') {
      if (!pools.length) {
        out.push('% No DHCP pools configured (use "ip dhcp pool <name>" in config mode)');
        return out;
      }
      const bindings = (this.sim && this.sim.dhcpBindings) ? this.sim.dhcpBindings(dev.id) : null;
      const chosen = want ? [poolByName(want)].filter(Boolean) : normalized;
      if (!chosen.length) {
        out.push('% No DHCP pool named ' + want + ' (pools on this device: ' +
          normalized.map(function (p) { return p.name; }).join(', ') + ')');
        return out;
      }
      for (const p of chosen) {
        const check = dhcpLib.validatePool(p);
        out.push('Pool ' + p.name + ':');
        out.push('  Network:        ' + p.network + ' ' + p.mask);
        out.push('  Range:          ' + (p.rangeStart || '-') + ' - ' + (p.rangeEnd || '-'));
        out.push('  Default router: ' + (p.gateway || 'none'));
        out.push('  DNS servers:    ' + ((p.dns && p.dns.length) ? p.dns.join(', ') : 'none'));
        out.push('  Lease:          ' + (Number.isFinite(Number(p.leaseSec)) ? Number(p.leaseSec) + 's' : 'default'));
        const excl = Array.isArray(p.excluded) ? p.excluded : [];
        out.push('  Excluded:       ' + (excl.length
          ? excl.map(function (r) { return r.start + (r.end && r.end !== r.start ? '-' + r.end : ''); }).join(', ')
          : 'none'));
        const res = p.reservations || {};
        const resKeys = Object.keys(res).sort();
        out.push('  Reservations:   ' + (resKeys.length
          ? resKeys.map(function (m) { return res[m] + ' (' + m + ')'; }).join(', ')
          : 'none'));
        if (!check.ok) {
          // A pool that is not serving yet says why. It used to print `undefined`, because the verdict carries an
          // `errors` array and this read `check.error` (#1429).
          const why = (check.errors && check.errors[0] && check.errors[0].message) || check.error ||
            'this pool is not serving yet';
          out.push('  In use:         no - ' + why);
        } else if (bindings === null) {
          out.push('  In use:         not measured (no simulation has run)');
        } else {
          // Counted by membership, not by the recorded name: a lease row's pool is the pool it was granted from, and a
          // row without one still has an address that is inside this pool (#1429).
          const mine = bindings.filter(function (r) {
            if (r.state === 'expired') return false;
            return r.pool === p.name || dhcpLib.ipInPool(p, r.ip);
          });
          const cap = dhcpLib.poolCapacity ? dhcpLib.poolCapacity(p) : null;
          out.push('  In use:         ' + mine.length + (cap === null ? ' lease(s)' : ' of ' + cap + ' address(es)'));
          if (mine.length) {
            out.push('                  ' + mine.map(function (r) { return r.ip + ' (' + r.mac + ')'; }).join(', '));
          }
        }
        out.push('');
      }
      return out;
    }

    out.push('% Usage: show ip dhcp [binding [<address|mac>] | pool [<name>]]');
    return out;
  }

  // `show ip ospf`, `show ip ospf neighbour`, `show ip ospf interface`.
  //
  // OSPF has been configurable since it was modelled - router-id, area, `ip ospf cost|area|passive` - and the
  // engine computes adjacencies and an SPF tree from those numbers. None of it could be read back: the only
  // console answer that mentioned OSPF was `show ip route` saying `O`. So an operator could set a cost and had
  // no way to see whether the engine used it, or which port an adjacency formed on (#1371).
  //
  // Every row here comes from what `computeOspf()` recorded (`dev.ospfInterfaces`, `dev.ospfNeighbors`), so the
  // console and the route table cannot disagree about the same topology.
  _showOspf(args) {
    const dev = this.device;
    const out = [];
    const cfg = dev.config && dev.config.ospf;
    if (!cfg || !cfg.routerId) {
      out.push('% OSPF is not enabled (use "ospf router-id <ip>" in config mode)');
      return out;
    }
    const sub = String(args[0] === undefined ? '' : args[0]).toLowerCase();
    const rest = args.slice(1).filter(function (t) { return String(t).toLowerCase() !== 'detail'; });
    const ifaces = dev.ospfInterfaces || [];
    const neighbours = dev.ospfNeighbors || [];
    const evaluated = ifaces.length > 0 || neighbours.length > 0;

    // `unknown` separates "a port that exists but carries no OSPF" from "no such port". Without it the neighbour
    // report described a port that does not exist as one that is "not carrying OSPF", which is a claim about a
    // socket the box does not have (#1403).
    const portWanted = function () {
      if (!rest.length) return { name: null, unknown: false };
      const name = resolvePortName(dev, rest.join(' '));
      return name ? { name: name, unknown: false } : { name: rest.join(' '), unknown: true };
    };

    if (sub === '' || sub === 'process') {
      out.push('Routing Process "ospf ' + (cfg.areaId || 0) + '" with ID ' + cfg.routerId);
      const areas = Array.from(new Set(ifaces.map(function (i) { return i.area; })))
        .sort(function (a, b) { return a - b; });
      out.push('  Areas: ' + (areas.length ? areas.join(', ') : String(cfg.areaId || 0)));
      const passive = ifaces.filter(function (i) { return i.passive; }).length;
      out.push('  Interfaces: ' + ifaces.length + (passive ? ' (' + passive + ' passive)' : ''));
      out.push('  Neighbours: ' + neighbours.length);
      const installed = (dev.ospfRoutes || []).length;
      out.push('  Routes installed from OSPF: ' + installed +
        (dev.ospfConverged ? '' : ' (withheld: still converging)'));
      if (!evaluated) out.push('  (no OSPF state has been evaluated yet - run a simulation)');
      return out;
    }

    if (sub === 'neighbor' || sub === 'neighbour' || sub === 'neighbors' || sub === 'neighbours') {
      const wanted = portWanted();
      if (wanted.unknown) {
        out.push('% No interface ' + wanted.name + ' on ' + dev.name);
        return out;
      }
      const rows = wanted.name ? neighbours.filter(function (n) { return n.iface === wanted.name; }) : neighbours;
      out.push(pad('Neighbor ID', 16) + pad('Address', 17) + pad('Interface', 12) + 'State');
      if (!rows.length) {
        if (!evaluated) {
          out.push('(no OSPF state has been evaluated yet - run a simulation)');
        } else if (wanted.name) {
          // Name the port and say why nothing is on it: a passive interface forms no adjacency, and a port
          // OSPF is not running on is not in the table at all.
          const iface = ifaces.filter(function (i) { return i.name === wanted.name; })[0];
          if (!iface) {
            out.push('% ' + wanted.name + ' is not carrying OSPF' +
              (dev.interfaces.get(wanted.name) ? ' (no address, shut down, or not an OSPF interface)' : ''));
          } else if (iface.passive) {
            out.push('% ' + wanted.name + ' is passive: it advertises its prefix and forms no adjacency');
          } else {
            out.push('% no neighbour on ' + wanted.name + ' (nothing on the other end runs OSPF here)');
          }
        } else {
          out.push('% no adjacencies: nothing on the other end of an OSPF interface is running OSPF');
        }
        return out;
      }
      for (const n of rows) {
        out.push(pad(n.routerId, 16) + pad(n.address, 17) + pad(n.iface, 12) + n.state);
      }
      out.push('');
      out.push(rows.length + ' neighbour(s), all Fully adjacent' +
        (dev.ospfConverged ? '' : ' (routes withheld: still converging)'));
      return out;
    }

    if (sub === 'interface' || sub === 'interfaces') {
      const wanted = portWanted();
      const rows = wanted.name ? ifaces.filter(function (i) { return i.name === wanted.name; }) : ifaces;
      if (!evaluated) {
        out.push('% no OSPF state has been evaluated yet - run a simulation');
        return out;
      }
      if (!rows.length) {
        if (wanted.name) {
          const port = dev.interfaces.get(wanted.name);
          if (!port) {
            // Same sentence the rest of the console uses, and the same one this report's sibling prints (#1403).
            out.push('% No interface ' + wanted.name + ' on ' + dev.name);
          } else if (!port.enabled) {
            out.push('% ' + wanted.name + ' is administratively down: OSPF runs on no shut port with an address');
          } else if (!port.ip || !port.mask) {
            out.push('% ' + wanted.name + ' has no address: OSPF needs one to form an adjacency');
          } else {
            out.push('% ' + wanted.name + ' is not in OSPF');
          }
        } else {
          out.push('% OSPF is enabled but no interface qualifies (needs an address and the port up)');
        }
        return out;
      }
      out.push(pad('Interface', 12) + pad('IP Address', 17) + pad('Area', 6) + pad('Cost', 6) + pad('Cost from', 12) +
        pad('Adjacent', 10) + 'Passive');
      for (const i of rows) {
        const netLib = require('./net');
        const len = netLib.prefixOf(i.mask);
        out.push(pad(i.name, 12) + pad(i.ip + (len === null ? ' ' + i.mask : '/' + len), 17) +
          pad(String(i.area), 6) + pad(String(i.cost), 6) + pad(i.costSource === 'configured' ? 'configured' : 'link rate', 12) +
          pad(i.adjacent ? 'yes' : 'no', 10) + (i.passive ? 'yes' : 'no'));
      }
      out.push('');
      out.push(rows.length + ' interface(s) in OSPF');
      return out;
    }

    out.push('% Usage: show ip ospf [process | neighbour [<port>] | interface [<port>]]');
    return out;
  }

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
    // "Installed" has to mean installed (#1407). The count was of everything a peer sent, so a prefix BGP
    // learned but the device already reaches directly - a connected route wins on distance 0 - was counted
    // here as installed while `show ip route` printed it as "not installed". Two reports, one fact, two
    // answers; the routing table is the authority because it is the one the forwarding lookup agrees with.
    const learned = (dev.bgpRoutes || []).length;
    let installed = learned, shadowed = 0;
    if (learned && this.topo) {
      const bgpRows = dev.routesTable(this.topo).filter(function (r) { return r.type === 'bgp'; });
      installed = bgpRows.filter(function (r) { return r.installed !== false; }).length;
      shadowed = bgpRows.length - installed;
    }
    out.push(installed + ' prefix(es) installed from BGP' +
      (shadowed ? ' (' + shadowed + ' more received, not installed: a better route holds the prefix)' : ''));
    if (learned) {
      // Which prefixes, from where, with what path. The count alone answered "did BGP do anything" and not
      // "which route did I get and off which peer", which is the next question and the one `show ip route`
      // sends you here with (#1269).
      out.push('');
      const netLib = require('./net');
      const cells = dev.bgpRoutes.map(function (r) {
        // The mask is stored dotted, and the prefix length is the same rule `show ip route` uses, so the two
        // tables cannot print the same route two ways.
        const len = netLib.prefixOf(r.mask);
        return {
          network: r.dest + (len === null ? ' ' + r.mask : '/' + len),
          nextHop: r.nextHop || '-',
          metric: '0',
          locPrf: '100',
          weight: '0',
          path: (r.asPath && r.asPath.length ? r.asPath.join(' ') + ' ' : '') + 'i',
          via: r.iface || '-',
          session: r.session === 'ibgp' ? 'iBGP' : 'eBGP'
        };
      });
      const w = function (key, floor) {
        return Math.max(cells.reduce(function (m, c) { return Math.max(m, String(c[key]).length); }, 0) + 2,
          floor || 0);
      };
      const wNet = w('network', 17), wHop = w('nextHop', 9), wPath = w('path', 7);
      out.push(pad('Network', wNet) + pad('Next Hop', wHop) + pad('Metric', 8) + pad('LocPrf', 8) +
        pad('Weight', 8) + pad('Path', wPath) + 'Session');
      for (const c of cells) {
        out.push(pad(c.network, wNet) + pad(c.nextHop, wHop) + pad(c.metric, 8) + pad(c.locPrf, 8) +
          pad(c.weight, 8) + pad(c.path, wPath) + c.session);
      }
    }
    return out;
  }

  // "speed: 1Gb/s (auto), duplex: full" - or the forced rate, plainly marked, with what the link actually
  // negotiated when the two differ.
  // One sentence for what a port does with a frame: the mode, the VLAN an untagged frame lands in, and - when
  // a trunk parameter is stored but not in use - that it is staged rather than in force. Silent for a port
  // with no switchport configuration at all, because "switchport: none" would be a claim about a mode this
  // device does not have.
  _switchportLine(i) {
    if (!i.vlan) return null;
    // A routed port carries a `vlan` object too - the engine fills a default for every interface - but it does
    // not switch, so printing "access VLAN 1" beside a router's `ip: 10.9.9.1/24` claims a mode the device has
    // not got. The capability is what makes a port a switchport.
    const switches = Array.isArray(this.device.capabilities) &&
      this.device.capabilities.indexOf('l2-forward') !== -1;
    if (!switches) return null;
    return 'switchport: ' + require('./vlan').switchportSentence(i.vlan);
  }

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
    // A reason is prose and some of it has brackets of its own - `ACL 101 denied (in)` - which printed inside the
    // summary's own brackets produced `2 drops (ACL 101 denied (in) x2)`: the list closes early for any reader who
    // parses it, and nests for the one who does not. A reason that brings its own brackets is quoted instead, so
    // the bracketed list stays one level deep whether it is read by a person or split by a script (#1417).
    const shown = pairs.slice(0, max).map(function (p) {
      const why = /[()"]/.test(p[0]) ? '"' + p[0].replace(/"/g, "'") + '"' : p[0];
      return why + (p[1] > 1 ? ' x' + p[1] : '');
    });
    const rest = pairs.length - shown.length;
    return drops.total + (drops.total === 1 ? ' drop' : ' drops') +
      (shown.length ? ' (' + shown.join(', ') + (rest > 0 ? ', and ' + rest + ' more reason' + (rest === 1 ? '' : 's') : '') + ')' : '');
  }

  // "Is this port still somewhere a frame can go, and if not why" - the sentence both tables append to a
  // stale row. One helper so `show arp` and `show mac address-table` cannot describe the same port state
  // two different ways.
  // ---- NAT configuration -------------------------------------------------------------------------
  // `ip nat ...` reaches the model in engine/nat.js. Every rule is validated by `natLib.validateRule()` and
  // refused with the library's own sentence, so the console and the data path cannot disagree about what a
  // rule means. Rules live in `config.nat.rules` with their named pools in `config.nat.pools`, which is the
  // shape `Simulator._natTableOf()` already reads.
  _natConfig(args) {
    // Translating is what the `nat` capability means; a box without it can hold a table nothing consults.
    const cannotTranslate = this._capabilityRefusal('nat', 'translate addresses');
    if (cannotTranslate) return [cannotTranslate];
    const natLib = require('./nat');
    const nat = this.device.config.nat
      ? JSON.parse(JSON.stringify(this.device.config.nat))
      : { rules: [], pools: {} };
    nat.rules = Array.isArray(nat.rules) ? nat.rules : [];
    nat.pools = nat.pools && typeof nat.pools === 'object' ? nat.pools : {};
    const users = function (name) {
      return nat.rules.filter(function (r) { return r.pool === name; }).length;
    };
    const commit = function (self, said) {
      self.device.config.nat = nat;
      self._controlPlaneChanged();
      return [said];
    };
    const isIp = function (v) { return net.isIp(String(v || '')); };

    // ip nat pool <name> <start> <end> netmask <mask>
    if (String(args[0] || '').toLowerCase() === 'pool') {
      const name = args[1];
      const start = args[2];
      const end = args[3];
      const maskKw = String(args[4] || '').toLowerCase();
      const mask = args[5];
      if (name) {
        // A pool address that cannot exist is a typo with one obvious answer; a usage line leaves the operator
        // reading the whole syntax to find it (#1411).
        const badPool = [start, end].filter(function (x) { return x !== undefined && !isIp(x); })[0];
        if (badPool !== undefined) return ['% Invalid pool address "' + badPool + '": not an IPv4 address'];
      }
      if (!name || !isIp(start) || !isIp(end) || maskKw !== 'netmask' || !isIp(mask)) {
        return ['% Usage: ip nat pool <name> <start> <end> netmask <mask>'];
      }
      // A pool's netmask is a netmask: 255.0.255.0 is a legal dotted quad and not a mask, and every prefix rule
      // read from it would describe something the pool does not do.
      if (!net.isContiguousMask(mask)) {
        return ['% Invalid netmask: ' + mask + ' - a netmask is a run of ones then zeros (255.255.255.0, or 24)'];
      }
      if (nat.pools[name]) {
        return ['% A NAT pool called "' + name + '" already exists (' + nat.pools[name].start + ' - ' +
          nat.pools[name].end + '): remove it first with `no ip nat pool ' + name + '`'];
      }
      const a = start.split('.').reduce(function (n, o) { return n * 256 + Number(o); }, 0);
      const b = end.split('.').reduce(function (n, o) { return n * 256 + Number(o); }, 0);
      if (b < a) return ['% Pool "' + name + '" ends before it starts (' + start + ' - ' + end + ')'];
      if (b - a + 1 > 1024) {
        return ['% Pool "' + name + '" covers ' + (b - a + 1) + ' addresses: the model allows 1024 in one pool'];
      }
      nat.pools[name] = { start: start, end: end, netmask: mask };
      return commit(this, 'NAT pool "' + name + '" ' + start + ' - ' + end + ' netmask ' +
        (b - a === 0 ? '255.255.255.255' : mask));
    }

    const which = String(args[0] || '').toLowerCase();
    if (which !== 'inside' || String(args[1] || '').toLowerCase() !== 'source') {
      return ['% Usage: ip nat pool <name> <start> <end> netmask <mask> | ' +
        'ip nat inside source (static <local> <global> [tcp|udp <port>] | list <spec> (pool <name>|interface <if>) [overload])'];
    }
    const kind = String(args[2] || '').toLowerCase();

    // ip nat inside source static <local> <global> [tcp|udp <port>]
    if (kind === 'static') {
      const local = args[3];
      const global = args[4];
      const proto = String(args[5] || '').toLowerCase();
      const port = args[6];
      const badStatic = [local, global].filter(function (x) { return x !== undefined && !isIp(x); })[0];
      if (badStatic !== undefined) {
        return ['% Invalid address "' + badStatic + '" in a static NAT rule: not an IPv4 address'];
      }
      if (!isIp(local) || !isIp(global)) {
        return ['% Usage: ip nat inside source static <inside-local> <inside-global> [tcp|udp <port>]'];
      }
      if (proto && proto !== 'tcp' && proto !== 'udp') {
        return ['% A port forwarding rule needs tcp or udp, not "' + args[5] + '"'];
      }
      const rule = { type: 'static', insideLocal: local, insideGlobal: global };
      if (proto) { rule.protocol = proto; rule.port = Number(port); }
      const verdict = natLib.validateRule(rule);
      if (!verdict.ok) {
        return verdict.errors.map(function (e) { return '% ' + e.message; });
      }
      nat.rules.push(natLib.normalizeRule(rule));
      return commit(this, 'NAT rule added: ' + natLib.formatRuleLine(natLib.normalizeRule(rule)));
    }

    // ip nat inside source list <spec> (pool <name> | interface <if>) [overload]
    if (kind === 'list') {
      const spec = args[3];
      const via = String(args[4] || '').toLowerCase();
      const target = args[5];
      const overload = args.slice(4).some(function (t) { return String(t).toLowerCase() === 'overload'; });
      if (!spec || (via !== 'pool' && via !== 'interface') || !target) {
        return ['% Usage: ip nat inside source list <address spec> (pool <name>|interface <if>) [overload]'];
      }
      if (/^\d+$/.test(spec) && !spec.includes('.')) {
        // IOS takes an ACL number here. Dropping it into an address parser would make the rule silently
        // match nothing, so say what this model wants.
        return ['% ' + spec + ' is an ACL number: this model takes the inside local addresses here, ' +
          'e.g. `list 192.168.1.0/24` or `list any`'];
      }
      let global;
      let poolName = null;
      let ifaceName = null;
      if (via === 'pool') {
        const pool = nat.pools[target];
        if (!pool) {
          return ['% No NAT pool called "' + target + '"' +
            (Object.keys(nat.pools).length ? ' (configured: ' + Object.keys(nat.pools).join(', ') + ')' : '')];
        }
        const one = pool.start === pool.end;
        if (overload && !one) {
          return ['% PAT overloads one address; pool "' + target + '" holds more than one. ' +
            'Use a single-address pool for overload, or drop `overload` for a dynamic pool'];
        }
        global = one ? pool.start : (pool.start + '-' + pool.end);
        poolName = target;
      } else {
        const name = resolvePortName(this.device, args.slice(5).filter(function (t) {
          return String(t).toLowerCase() !== 'overload';
        }).join(' '));
        const iface = name ? this.device.interfaces.get(name) : null;
        if (!iface) return ['% Interface not found: ' + target];
        if (!iface.ip) {
          return ['% ' + iface.name + ' has no address: there is nothing for NAT to translate to'];
        }
        global = iface.ip;
        ifaceName = iface.name;
      }
      const rule = {
        type: overload ? 'pat' : 'dynamic',
        insideLocal: spec,
        insideGlobal: global,
        acl: spec
      };
      if (poolName) rule.pool = poolName;
      if (ifaceName) rule.iface = ifaceName;
      const verdict = natLib.validateRule(rule);
      if (!verdict.ok) return verdict.errors.map(function (e) { return '% ' + e.message; });
      const normalized = natLib.normalizeRule(rule);
      if (poolName) normalized.pool = poolName;
      if (ifaceName) normalized.iface = ifaceName;
      nat.rules.push(normalized);
      return commit(this, 'NAT rule added: ' + natLib.formatRuleLine(normalized));
    }

    return ['% Usage: ip nat inside source (static <local> <global> [tcp|udp <port>] | ' +
      'list <spec> (pool <name>|interface <if>) [overload])'];
  }

  // "The control plane has to run its timers again, from now." One place, so a command added later either calls it
  // or is caught by the test that walks the commands that change the forwarding decision (#1331).
  _controlPlaneChanged() {
    if (this.sim && typeof this.sim.markTopologyChange === 'function') this.sim.markTopologyChange();
    else if (this.topo && typeof this.topo.markChange === 'function') this.topo.markChange(0);
  }

  _staleNote(port, extra) {
    // One implementation, in the engine, because the state payload says the same thing to the browser (#1327).
    return this.device.portCarrierNote(port, this.topo, extra);
  }

  // `show power inline [<port>]` - what the PSE is supplying, and why a powered device got nothing.
  //
  // The engine has computed this since PoE was modelled (`computePoe()`), the inspector has displayed it, and the
  // console could not answer it at all: the one mechanism whose state could only be seen in the browser. Every
  // fact below comes from the engine's own result - no second copy of the allocation rule - and the port list
  // comes from the hardware, so a port the engine leaves out of its table (shut down, unplugged, or plugged into
  // something that is not a powered device) is still named and explained.
  _showPowerInline(typed) {
    const dev = this.device;
    const out = [];
    // The port name is the whole rest of the line, not its first word: "Port 1" is a name on 17 models of the
    // catalogue, and reading only "Port" answered `% No interface Port` about a port that is right there (#1401).
    const wanted = (typed && typed.length) ? typed.join(' ') : null;

    // The PSE hardware, in port order. A port can supply power whether or not it currently does.
    let pse = [...dev.interfaces.values()].filter(function (i) { return i.poeOut; });
    if (!pse.length) {
      return ['% No PoE on ' + dev.name + ': no port on this device can supply power'];
    }
    if (wanted) {
      const name = resolvePortName(dev, wanted);
      const one = name ? dev.interfaces.get(name) : null;
      if (!one) return ['% No interface ' + wanted + ' on ' + dev.name];
      if (!one.poeOut) {
        return ['% ' + one.name + ' on ' + dev.name + ' cannot supply power (it is not a PSE port)'];
      }
      pse = [one];
    }

    // "Not measured" and "measured zero" are different answers. `sim.poe` is undefined until something has run
    // the allocation, so asking it is asking whether anything has looked.
    const table = this.sim ? this.sim.poe : null;
    if (!Array.isArray(table)) {
      return ['Not measured (no simulation run): nothing has computed the power budget yet'];
    }
    const entry = table.filter(function (p) { return p.dev === dev.id; })[0] || null;
    // A device with PSE ports and no budget is not served by the engine at all, and saying "0 W" would be a
    // measurement it never made.
    if (!entry) {
      out.push(pad('Interface', 11) + pad('Admin', 7) + 'Supplied');
      for (const i of pse) {
        out.push(pad(i.name, 11) + pad(i.enabled ? 'up' : 'down', 7) + 'not measured');
      }
      out.push('budget not modelled on ' + dev.name +
        ': the ports are reported, the power they could supply is not');
      return out;
    }

    const byIface = new Map((entry.ports || []).map(function (p) { return [p.iface, p]; }));
    const nameOf = function (id) {
      const d = this.topo && typeof this.topo.getDevice === 'function' ? this.topo.getDevice(id) : null;
      return d ? (d.name || d.id) : id;
    }.bind(this);

    const rows = [];
    const idle = [];
    let supplied = 0;
    let denied = 0;
    for (const i of pse) {
      const p = byIface.get(i.name);
      const admin = i.enabled ? 'up' : 'down';
      if (p) {
        const draw = (Math.round((p.draw || 0) * 100) / 100) + ' W';
        rows.push(pad(i.name, 11) + pad(admin, 7) + pad(p.powered ? 'on' : 'off', 6) + pad(draw, 9) +
          nameOf(p.pd) + (p.powered ? '' : '  (denied)'));
        if (p.powered) supplied += p.draw || 0;
        else denied++;
        continue;
      }
      // Not in the engine's table: the port supplies nothing, and the reason is one of three, in the same words
      // `show interfaces` uses for a port that cannot carry a frame.
      let why;
      if (!i.enabled) why = 'administratively down';
      else {
        // The cable is found the same way `show interfaces` finds it - by asking the topology for the link that
        // touches this port - rather than by a second, private lookup.
        const link = (this.topo && typeof this.topo.linksFor === 'function')
          ? this.topo.linksFor(dev.id).filter(function (l) {
            return (l.a.deviceId === dev.id && l.a.iface === i.name) ||
                   (l.b.deviceId === dev.id && l.b.iface === i.name);
          })[0] || null
          : null;
        why = link ? 'the far end is not a powered device' : 'nothing plugged in';
      }
      if (why === 'nothing plugged in' && !wanted) {
        // A wall of "nothing plugged in" is how the one port that matters gets missed. They are still named,
        // once, below the table.
        idle.push(i.name);
        continue;
      }
      rows.push(pad(i.name, 11) + pad(admin, 7) + pad('off', 6) + pad('-', 9) + why);
    }

    out.push(pad('Interface', 11) + pad('Admin', 7) + pad('Oper', 6) + pad('Draw', 9) + 'Powered device');
    out.push.apply(out, rows);
    if (idle.length) {
      out.push(idle.length + ' port' + (idle.length === 1 ? '' : 's') + ' with nothing plugged in: ' +
        idle.slice(0, 5).join(', ') + (idle.length > 5 ? ' (+' + (idle.length - 5) + ' more)' : ''));
    }

    // Totals are the device's, so a question about one port does not get them: the number would be about
    // something else.
    if (!wanted) {
      const round = function (n) { return Math.round(n * 100) / 100; };
      const left = round((entry.budget || 0) - supplied);
      out.push('');
      out.push('Total: ' + round(supplied) + ' W of ' + entry.budget + ' W in use, ' + left + ' W left' +
        (denied ? ', ' + denied + ' port' + (denied === 1 ? '' : 's') + ' denied' : ', nothing denied'));
    }
    // The denial sentence is the one the timeline emitted, not a second rendering of the same arithmetic.
    for (const i of pse) {
      const p = byIface.get(i.name);
      if (p && !p.powered && p.reason) out.push('  ' + i.name + ': ' + p.reason);
    }
    return out;
  }

  // A `show` describes the lab at an instant, and the control planes are results - they are computed, not stored.
  // `show ip route` printed whatever the last `computeOspf()` left on the device, so a console with no run behind it
  // reported "no O routes" on a lab that was fully converged, and the answer to the same question depended on which
  // run happened before it (#1338). Recorded state is not the thing being asked about; the simulation is.
  _refreshControlPlane() {
    const sim = this.sim;
    if (!sim) return;
    // Recompute at the instant the session is standing at. Each of these is idempotent for a given
    // (topology, runAtMs), and each is what the packet path already runs before it sends anything.
    //
    // Only the processes this device is *configured* to run. Recomputing a process that is not configured does not
    // give the same answer twice - it erases the device's learned routes, so a `show` would quietly delete state that
    // something else installed (a test fixture, an imported lab, a future caller). A `show` may compute; it must not
    // destroy.
    const cfg = this.device.config || {};
    if (typeof sim.computeStp === 'function') sim.computeStp();
    if (cfg.vrrp && typeof sim.computeVrrp === 'function') sim.computeVrrp();
    if (cfg.ospf && typeof sim.computeOspf === 'function') sim.computeOspf();
    if (cfg.bgp && typeof sim.computeBgp === 'function') sim.computeBgp();
  }

  _show(tokens) {
    const what = (tokens[0] || '').toLowerCase();
    const dev = this.device;
    this._refreshControlPlane();
    const out = [];
    if (what === 'version' || what === 'ver') {
      if (tokens.length > 1) {
        return showNoTail('show version', tokens.slice(1), 'the banner is the answer');
      }
      out.push(this._banner());
      out.push('Vendor     : ' + dev.vendor);
      out.push('Model      : ' + dev.model + ' (' + dev.label + ')');
      out.push('Category   : ' + dev.category);
      out.push('Capabilities: ' + dev.capabilities.join(', '));
      out.push('Interfaces : ' + dev.interfaces.size);
      out.push('Simulator  : PacketForge 0.1.0');
    } else if (what === 'ip' && tokens[1] === 'nat') {
      // The other half of the reachability problem: a mechanism nobody can configure is invisible, and one
      // nobody can *inspect* is unverifiable. Both read the engine's own state - the rules it would apply and
      // the translations it has actually made in the traffic that crossed (#1366).
      const natLib = require('./nat');
      const natCfg = this.device.config.nat || { rules: [], pools: {} };
      const rules = Array.isArray(natCfg.rules) ? natCfg.rules : [];
      const sub = String(tokens[2] || '').toLowerCase();
      if (sub === 'rules') {
        if (!rules.length) {
          out.push('% No NAT rules configured');
          const pools = Object.keys(natCfg.pools || {});
          if (pools.length) {
            out.push('  % ' + pools.length + ' pool(s) configured but no rule uses them: ' + pools.join(', '));
          }
        } else {
          for (const r of rules) out.push(natLib.formatRuleLine(r));
        }
      } else if (sub === 'translations' || sub === 'translation') {
        // `dev.natTable` is created by the first packet that needed translating, so "no table" and "no
        // translations" are different answers: the first means nothing has crossed, the second means it has
        // and nothing needed translating.
        const table = this._natTableAt();
        if (!table) {
          out.push('No translations: no packet needing NAT has crossed this device' +
            (rules.length ? '' : ' (and there are no rules to need one)'));
        } else {
          // The library prints the rows; the header belongs with them or the columns are unlabelled.
          out.push(natLib.TABLE_HEADER);
          const shown = natLib.formatTable(table);
          out.push.apply(out, Array.isArray(shown) ? shown : String(shown).split(String.fromCharCode(10)));
        }
      } else if (sub === 'statistics' || sub === 'stat') {
        // Which ports a translation may happen on. Without this line a rule that never fires has no explanation:
        // the ports say nothing and the rule looks broken (#1391).
        out.push(this._natPortsSentence());
        const pools = natCfg.pools || {};
        const names = Object.keys(pools);
        out.push('Inside source rules: ' + rules.length + ' (' +
          rules.filter(function (r) { return r.type === 'static'; }).length + ' static, ' +
          rules.filter(function (r) { return r.type === 'dynamic'; }).length + ' dynamic, ' +
          rules.filter(function (r) { return r.type === 'pat'; }).length + ' PAT overload)');
        out.push('Address pools: ' + names.length +
          (names.length ? ' (' + names.map(function (n) {
            const p = pools[n];
            return n + ' ' + p.start + (p.start === p.end ? '' : '-' + p.end);
          }).join(', ') + ')' : ''));
        // The timeouts are in force whether or not anyone asked: a dynamic translation that has been idle for
        // one is gone. Printing them is the only way to read the rule the table is being held to.
        const timeouts = natCfg.timeouts;
        out.push('Timeouts (seconds): icmp ' + natLib.timeoutFor(timeouts, 'icmp') +
          ', udp ' + natLib.timeoutFor(timeouts, 'udp') +
          ', tcp ' + natLib.timeoutFor(timeouts, 'tcp') +
          ', other ' + natLib.timeoutFor(timeouts, 'other'));
        const table = this._natTableAt();
        const live = table && Array.isArray(table.translations) ? table.translations.length : 0;
        out.push('Active translations: ' + live + (table ? '' : ' (nothing has needed translating yet)'));
      } else {
        out.push('% Usage: show ip nat (rules | translations | statistics)');
      }
    } else if (what === 'ip' && tokens[1] === 'interface' && tokens[2] === 'brief') {
      if (tokens.length > 3) {
        const want = tokens.slice(3).join(' ');
        return showNoTail('show ip interface brief', tokens.slice(3), 'every interface is listed',
          'use `show interfaces ' + want + '` for one port');
      }
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
      // There is no `show ip route <prefix>` here, and the command used to answer as though there were: it printed
      // the whole table, so a prefix that is *not* installed came back looking installed (#1403).
      if (tokens.length > 2) {
        return showNoTail('show ip route', tokens.slice(2), 'the whole table is printed',
          'read the row for the prefix in the table below');
      }
      // The legend has to name every code the table can produce: routesTable() emits O (OSPF) and B
      // (BGP) rows as well as C and S, and an undefined code in the legend is a code the reader has to
      // guess at (#1234).
      out.push('Codes: C - connected, S - static, O - OSPF, B - BGP');
      // Every row arrives annotated by the device - displayCode, distance, and the sentence that says why it
      // cannot carry a packet - and the inspector's Routes table reads those same fields. Two surfaces printing
      // different verdicts for the same route is the defect this replaced (#1301).
      const rows = dev.routesTable(this.topo);

      // "Gateway of last resort" names the default that is actually installed - the one routeTo() would pick
      // among the candidates: lowest distance. A configured gateway (254) loses to a static default (1), and
      // printing the losing one would send the reader after a next hop no packet ever uses.
      //
      // "Installed" is not enough on its own: a default whose next hop no interface is on the subnet of is a
      // gateway no packet can reach, so the line must not name it either (#1439). `shadow` does not disqualify a
      // row - when the group's winner is unusable, the reachable candidate is the only gateway worth naming, and
      // it is the one `routeTo()` would fall through to once the unusable row cannot be used.
      const fallback = rows
        .filter(function (r) { return r.mask === '0.0.0.0' && r.gw && r.gw !== '-'; })
        .filter(function (r) { return !r.unusable; })
        .sort(function (a, b) { return a.distance - b.distance; })[0];
      if (fallback) out.push('Gateway of last resort is ' + fallback.gw + ' to network 0.0.0.0');

      for (const r of rows) {
        const prefix = net.prefixOf(r.mask);
        const dest = pad(r.dest, 15) + '/' + prefix;
        if (r.type === 'connected') {
          // A connected route stays listed - it is configuration, and `routeTo()` still finds it - but a
          // port that cannot carry a frame is why the ping to that very address fails. Saying nothing left
          // the reader with a route row that reads "directly connected" about a port with no cable (#1271).
          out.push('C   ' + dest + '  is directly connected, ' + r.iface +
            (r.note ? '  ' + r.note : '') + (r.shadow ? '  ' + r.shadow : ''));
          continue;
        }
        // [administrative distance/metric] - the distance is half of the rule that picks the installed
        // route (longest prefix first, then lowest distance), so a table without it cannot be checked
        // by reading. Three columns whatever the code length, so `S*` does not shift the whole row.
        out.push((r.displayCode.length === 1 ? r.displayCode + '  ' : r.displayCode + ' ') + dest +
          '  [' + r.distance + '/0] via ' + r.gw +
          (r.iface && r.iface !== '-' ? '  ' + r.iface : '') +
          (r.note ? '  ' + r.note : '') + (r.shadow ? '  ' + r.shadow : ''));
      }
    } else if (what === 'ip' && tokens[1] === 'dns') {
      out.push.apply(out, this._showDns(tokens.slice(2)));
    } else if (what === 'ip' && tokens[1] === 'dhcp') {
      out.push.apply(out, this._showDhcp(tokens.slice(2)));
    } else if (what === 'ip' && tokens[1] === 'ospf') {
      out.push.apply(out, this._showOspf(tokens.slice(2)));
    } else if (what === 'ip' && tokens[1] === 'bgp') {
      out.push.apply(out, this._showBgp(tokens.slice(2)));
    } else if (what === 'ipv6' && tokens[1] === 'nd') {
      out.push.apply(out, this._showIpv6Nd());
    } else if (what === 'power' && (tokens[1] || '').toLowerCase() === 'inline') {
      out.push.apply(out, this._showPowerInline(tokens.slice(2)));
    } else if (what === 'lldp') {
      if (tokens.length > 1 && String(tokens[1]).toLowerCase() !== 'neighbors' && String(tokens[1]).toLowerCase() !== 'neighbours') {
        return showNoTail('show lldp', tokens.slice(1), 'every neighbour on every port is listed');
      }
      if (tokens.length > 2) {
        return showNoTail('show lldp neighbors', tokens.slice(2), 'every neighbour on every port is listed',
          'the Local port column says which port each one is on');
      }
      // The table that answers "what is plugged into this port" - and it is honest,
      // because it is filled from LLDPDUs that actually crossed the link rather than
      // from the topology file. An empty table means nothing has announced itself.
      out.push('LLDP neighbours on ' + dev.name + ':');
      const rows = dev.lldpRows(this.topo);
      if (!rows.length) {
        out.push('  ' + pad('Neighbour', 20) + pad('Local port', 16) + pad('Port ID', 16) + 'Mgmt address');
        out.push('  (none - no LLDP has been heard on any port)');
      } else {
        // Column widths come from the data. A fixed 20-character Neighbour column ran a 55-character router
        // name into the Local port column, so the row could not be read field by field - and the one thing
        // this table is for is answering "what is on that port" (#1265).
        const cells = rows.map(function (r) {
          return {
            name: r.systemName,
            port: r.port + (r.note ? ' ' + r.note : ''),
            portId: r.portId,
            mgmt: r.mgmtIp
          };
        });
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
      if (tokens.length > 1) {
        return showNoTail('show access-lists', tokens.slice(1), 'every list is printed',
          'each list is headed by its number');
      }
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
      // `show vrrp <group>` printed every group: the one command that reports which router holds the virtual
      // address answered a question about one group with all of them (#1403).
      if (tokens.length > 1) {
        return showNoTail('show vrrp', tokens.slice(1), 'every group is listed',
          'each group is headed by its number');
      }
      out.push.apply(out, this._showVrrp());
    } else if (what === 'vlan') {
      if (tokens.length > 1 && String(tokens[1]).toLowerCase() !== 'brief') {
        return showNoTail('show vlan', tokens.slice(1), 'every VLAN is listed',
          'the Id column is the VLAN number');
      }
      if (tokens.length > 2) {
        return showNoTail('show vlan brief', tokens.slice(2), 'every VLAN is listed');
      }
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
      if (tokens.length > 1) {
        return showNoTail('show spanning-tree', tokens.slice(1), 'this device\'s tree is reported',
          'the Port column names the port each row is about');
      }
      // `dev.stp` is written by whichever Simulator computed it last, and every HTTP request builds its own - so a
      // console asked at instant 25000 could print the tree from an earlier pass at Infinity and call a port that is
      // still listening "forwarding" (#1335). The attached simulator recomputes for the instant it was given.
      if (this.sim && typeof this.sim.recomputeStp === 'function') this.sim.recomputeStp();
      const st = dev.stp || { states: {}, roles: {}, blocked: new Set() };
      const names = Object.keys(st.states || {}).sort();
      const stpLib = require('./stp');
      const mine = (dev.config && dev.config.stpPriority !== null && dev.config.stpPriority !== undefined)
        ? dev.config.stpPriority : stpLib.STP_DEFAULT_PRIORITY;
      // A box that is not a bridge does not run spanning tree, and saying "no election has run" about it implies it
      // would be in one: a router answered `show spanning-tree` with a root it had never looked for (#1399).
      // `isL2()` is the predicate `computeStp()` uses to decide what may be a bridge at all, so it is the one this
      // report must ask. A router answers false: it never joins an election, so no sentence here may imply it did.
      const bridgesAtAll = (typeof dev.isL2 !== 'function') || dev.isL2();
      if (!bridgesAtAll) {
        out.push('Spanning tree is not running on this device: it is not a bridge (no L2 forwarding).');
        return out;
      }
      out.push('Spanning tree enabled protocol ieee');
      // The bridge priority decides the election, so a tree report that omits it cannot explain itself.
      // A root with no identity is not a root: `runStp()` used to answer one for a topology with no bridges, and
      // `String(undefined)` is what came out (#1399). Two things are checked, so neither can print it again.
      const rootRes = (this.sim && this.sim.stpResult && this.sim.stpResult.root &&
        this.sim.stpResult.root.key !== undefined && this.sim.stpResult.root.key !== null)
        ? this.sim.stpResult.root : null;
      if (rootRes) {
        const rootDev = this.topo ? this.topo.getDevice(rootRes.key) : null;
        // A device's `name` is its catalogue label ("Aruba CX 6000 24G 4SFP+"), which names the model
        // three switches share, so a root report built on it named nothing. Hostname, else the id the
        // lab uses.
        const rootName = rootDev ? (rootDev.config.hostname || rootDev.id) : String(rootRes.key);
        out.push('  Bridge priority ' + mine + (rootRes.key === dev.id ? ' (this bridge is the root)' : '') +
          ', root bridge ' + rootName + ' priority ' + rootRes.priority);
      } else {
        out.push('  Bridge priority ' + mine + ', root bridge not measured (no election has run)');
      }
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
      // `show etherchannel <anything>` printed the summary whatever was asked for (#1403).
      {
        const known = { summary: 1, brief: 1, detail: 1, load: 1, port: 1, 'port-channel': 1, protocol: 1 };
        const extra = tokens.slice(1).filter(function (t) { return !known[String(t).toLowerCase()]; });
        if (extra.length) {
          return showNoTail('show etherchannel', extra, 'every group is listed',
            'each group is headed by its number');
        }
      }
      const lags = dev.config.lags || {};
      const ids = Object.keys(lags).sort();
      if (!ids.length) {
        out.push('% No link aggregation groups configured');
      } else {
        const lagLib = require('./lag');
        out.push(pad('Group', 7) + pad('Protocol', 18) + 'Ports');
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
          // The column is the protocol, so it names the protocol and the mode the operator chose, in the
          // words the operator chose them in.
          const modeWord = lagLib.cliMode(l.mode);
          const proto = modeWord === 'on' ? 'Static' : 'LACP (' + modeWord + ')';
          out.push(pad(id, 7) + pad(proto, 18) + shown.join(' '));
          // Why a member is not carrying, in the same words `show interfaces` uses, and what that means for
          // the bundle as a whole.
          for (const m of raw) {
            if (live.indexOf(m) === -1) {
              out.push('  ' + pad(m, 10) + 'not bundled ' + (why[m] || '(cannot carry a frame)'));
            }
          }
          // A bundle of one is not a bundle. The shortfall used to be a warning on every correct
          // `channel-group` line, which was noise; the standing view of the group is the right place for it,
          // and the only place that still reports it.
          if (raw.length === 1) {
            out.push('  group ' + id + ' has 1 member: a bundle needs at least 2 ports');
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
      // No `show arp <address>`: the cache is listed whole, and asked for one neighbour it used to answer with all
      // of them, which reads as "that address is in the cache" (#1403).
      if (tokens.length > 1) {
        return showNoTail('show arp', tokens.slice(1), 'the whole cache is listed',
          'the Address column is the neighbour');
      }
      // The Interface column used to be a header over nothing - every row stopped at the MAC - so the one
      // table that tells you which port a neighbour is on could not tell you (#1253). It also presented
      // every entry as a live neighbour: an entry learned on a port that has since gone down is a stale
      // cache entry, not evidence that the address is still reachable, and that is exactly the state you
      // are in when you run this command.
      out.push(pad('Protocol', 10) + pad('Address', 17) + pad('Age (min)', 11) +
        pad('Hardware Addr', 18) + 'Interface');
      // Rows are the rows at the instant this session is asking about: a neighbour silent for longer than
      // ARP_AGE_MS is gone, and the Age column counts the minutes since it was heard. Until this the column was a
      // header over a hard-coded '-' on every row, on the grounds that the simulator had steps and not minutes -
      // which stopped being true when convergence gave the model an instant in milliseconds (#1397).
      const nowMs = (this.sim && Number.isFinite(this.sim.runAtMs)) ? this.sim.runAtMs : null;
      const rows = [];
      for (const r of dev.arpRows(this.topo, nowMs)) {
        const ip = r.ip, mac = r.mac;
        // The reason travels with the status here too: "down" alone sends you looking for a cable
        // when the cable is fine and the far port is shut (#1253).
        let note = r.port === '-' ? '-' : r.port + (r.note ? ' ' + r.note : '');
        // Minutes, or '-' for an entry nothing dated: a device prints '-' for what it cannot age, and so does
        // this one (#1397).
        const age = (r.age === null || r.age === undefined) ? '-' : String(r.age);
        rows.push([ip, mac, age, note]);
      }
      rows.sort(function (a, b) { return String(a[0]).localeCompare(String(b[0]), undefined, { numeric: true }); });
      for (const r of rows) {
        out.push(pad('Internet', 10) + pad(r[0], 17) + pad(r[2], 11) + pad(r[1], 18) + r[3]);
      }
    } else if (what === 'mac' && tokens[1] === 'address-table') {
      // Rows are the rows at the instant this session is asking about: a dynamic entry that has been silent for
      // longer than MAC_AGE_MS is gone, and the Age column says how long ago it was heard. Before this the table
      // never aged anything and the row carried a note explaining that it might be stale (#1395).
      const nowMs = (this.sim && Number.isFinite(this.sim.runAtMs)) ? this.sim.runAtMs : null;
      // The rest of the line is a filter, and it used to be dropped on the floor: `show mac address-table
      // interface Port 1` answered with every entry on the box, which reads as "this port has all of them".
      // An argument that is accepted and not applied is the same defect as a config command that is accepted
      // and inert (#1401), so either it filters or it is refused - never ignored.
      const tail = tokens.slice(2);
      let only = null;
      if (tail.length) {
        const word = String(tail[0]).toLowerCase();
        if (word !== 'interface' && word !== 'int') {
          return ['% show mac address-table does not take "' + tail.join(' ') +
            '": use `show mac address-table interface <port>` for one port'];
        }
        const typed = tail.slice(1).join(' ');
        if (!typed) return ['% interface needs a port: show mac address-table interface <port>'];
        const name = ifaceName.resolvePortName(dev, typed);
        if (!name) return ['% No interface ' + typed + ' on ' + (dev.name || 'this device')];
        only = name;
      }
      out.push(pad('Vlan', 8) + pad('Mac Address', 20) + pad('Type', 12) + pad('Age', 8) + 'Ports');
      // The rows come from the engine, so the payload the browser reads and this table cannot disagree (#1327).
      let rows = dev.macRows(this.topo, nowMs);
      if (only) rows = rows.filter(function (r) { return r.port === only; });
      if (only && !rows.length) {
        // An empty table for a filter is a fact about that port, and it has to say so: a bare header reads as
        // "the switch knows nothing", which is a different claim about the whole box.
        out.push('(no entry learned on ' + only + ')');
      }
      for (const r of rows) {
        // Where the entry points, and whether that is still somewhere a frame for this VLAN can go. A MAC learned
        // before its port was shut or moved says why it cannot be the way to that address (#1255).
        const age = (r.age === null || r.age === undefined) ? '-' : (r.age + 's');
        out.push(pad(r.vlan, 8) + pad(r.mac, 20) + pad('DYNAMIC', 12) + pad(age, 8) +
          r.port + (r.note ? ' ' + r.note : ''));
      }
    } else if (what === 'interfaces' || what === 'interface') {
      // `show interfaces Fa0/1` printed every port on the box: the answer to a question about one socket was
      // the whole switch, and on a 48-port model the socket asked about could be eight screens down. The name
      // is resolved by the same table `interface Fa0/1` uses, so every spelling works, and a name that
      // matches nothing is refused by name rather than answered with a list.
      //
      // The name is the **whole rest of the line**, which is the rule `interface` has used since #1230: Ubiquiti
      // calls its ports "Port 1" and its cages "SFP+ 1", so taking `tokens[1]` read the name "Port" and answered
      // `% No interface Port` about a port that exists (#1401). One door was fixed and the other left behind.
      const wanted = tokens.length > 1 ? tokens.slice(1).join(' ') : null;
      let shown = [...dev.interfaces.values()];
      if (wanted) {
        const name = ifaceName.resolvePortName(dev, wanted);
        const one = name ? dev.interfaces.get(name) : null;
        if (!one) {
          // A real IOS view this console does not implement is not a misspelt port (#1443). `show interfaces
          // switchport`, `show interfaces status`, `show interfaces counters` and ten more answered
          // `% No interface switchport on <box>`, which is the same sentence a typo gets - so an operator who typed
          // a command they know from IOS was told a port did not exist, and went looking for a typo in a port name
          // instead of learning the view is not here. A word that is a keyword is reported as one.
          // Note it is checked *after* the port table: a device with a port genuinely called "status" gets its port.
          const keyword = INTERFACES_VIEW_KEYWORDS[String(wanted).toLowerCase()];
          if (keyword) {
            return ['% `' + wanted + '` is a view, not a port: this console has no `show interfaces ' + wanted +
              '`. ' + keyword];
          }
          // `show interfaces ?` is how a reader asks what can go here, and `% No interface ? on <box>` is the
          // worst possible answer to that question.
          if (String(wanted).trim() === '?' || /^help$/i.test(String(wanted).trim())) {
            return ['% Usage: `show interfaces` lists every port; `show interfaces <port>` prints one. ' +
              'There is no keyword form here - `help` lists the commands this console has, ' +
              '`show vlan` prints VLAN membership and `show lldp neighbors` prints what is plugged in.'];
          }
          // Ambiguity is refused rather than guessed, exactly as `interface` refuses it: the panel is the
          // only authority on which socket a spelling means.
          const ambiguous = portKey(wanted) !== null && [...dev.interfaces.keys()]
            .filter(function (n) { return portKey(n) === portKey(wanted); }).length > 1;
          return ['% No interface ' + wanted + ' on ' + (dev.name || 'this device') +
            (ambiguous ? ' (that spelling is ambiguous: more than one port folds onto it)' : '')];
        }
        shown = [one];
      }
      // A subinterface is an interface: it can hold an address, carry traffic and be configured, so it has to
      // be in the listing. It was omitted, and `show interfaces` printed 3 of the 4 interfaces on a router -
      // the one that was missing being the one with the address on it. Children follow their parent, which is
      // the order the blocks are read in.
      if (!wanted) {
        const byName = new Map(shown.map(function (i) { return [i.name, i]; }));
        const ordered = [];
        const placed = new Set();
        for (const i of shown) {
          if (placed.has(i.name)) continue;
          ordered.push(i); placed.add(i.name);
          for (const child of shown) {
            if (child === i || placed.has(child.name)) continue;
            if (child.parent === i.name || String(child.name).indexOf(i.name + '.') === 0) {
              ordered.push(child); placed.add(child.name);
            }
          }
        }
        shown = ordered;
        // Anything the parent walk did not reach (an orphaned child) is still printed, at the end.
        for (const i of shown) placed.add(i.name);
        for (const name of byName.keys()) {
          if (!placed.has(name)) shown.push(byName.get(name));
        }
      }
      for (const i of shown) {
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
        // What the port does with a frame, which is the other half of "what is this socket". The switchport
        // configuration was only visible in `show vlan` (membership) and `show running-config` (the lines),
        // so the command an operator opens first said `ip: unassigned` about a port whose whole job is its
        // VLAN.
        const swLine = this._switchportLine(i);
        if (swLine) out.push('  ' + swLine);
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
      // `show running-config interface Gi0/1` used to print the entire configuration, so the narrower question got
      // the wider answer and looked like an answer (#1403).
      if (tokens.length > 1) {
        const want = tokens.slice(1).join(' ');
        return showNoTail('show running-config', tokens.slice(1), 'the whole configuration is printed',
          /^interface|^int$/i.test(String(tokens[1])) ? 'use `show interfaces ' + tokens.slice(2).join(' ') +
            '` for one port\'s state' : 'the file is the plain `show running-config`');
      }
      out.push('! PacketForge running-config');
      out.push('hostname ' + (dev.config.hostname || dev.name));
      // Five features were configurable, stored, and printed nowhere: a config saved from the device came back
      // without its routing protocol, its name servers, its AS membership or its IPv6 router-advertisement
      // policy, and restoring it produced a different device. The test that was supposed to catch this
      // ("nothing configurable is left out") only ever configured the features it already knew about.
      //
      // Each line below is the exact spelling the parser takes back, printed only when it differs from the
      // default the device already assumes, in an order that replays: the OSPF router exists before the
      // interface overrides that require it.
      // The bridge priority decides who is root, and a restore that dropped it would silently move the
      // root to whichever other switch has the lower MAC.
      if (dev.config.nat && ((dev.config.nat.rules || []).length || Object.keys(dev.config.nat.pools || {}).length)) {
        const natLib = require('./nat');
        // Pools first: a rule that names one does not parse before the pool it names exists.
        for (const name of Object.keys(dev.config.nat.pools || {}).sort()) {
          const pool = dev.config.nat.pools[name];
          out.push('ip nat pool ' + name + ' ' + pool.start + ' ' + pool.end + ' netmask ' + pool.netmask);
        }
        for (const r of (dev.config.nat.rules || [])) out.push(natLib.formatRuleLine(r));
      }
      if (dev.config.stpPriority !== null && dev.config.stpPriority !== undefined) {
        out.push('spanning-tree priority ' + dev.config.stpPriority);
      }
      for (const ns of (dev.config.dnsServers || [])) out.push('ip name-server ' + ns);
      if (dev.config.scionAs) out.push('scion ' + dev.config.scionAs);
      // IPv6 is the same hole in the other address family: `ipv6 address`, `ipv6 route` and `ipv6 gateway`
      // were all accepted, stored in config.ip6/routes6/gateway6, and printed nowhere.
      if (dev.config.gateway6) out.push('ipv6 gateway ' + dev.config.gateway6);
      for (const r6 of (dev.config.routes6 || [])) {
        if (r6 && r6.dest) out.push('ipv6 route ' + r6.dest + '/' + r6.prefix + ' ' + r6.nextHop);
      }
      if (dev.config.ospf) {
        if (dev.config.ospf.routerId) out.push('ospf router-id ' + dev.config.ospf.routerId);
        if (dev.config.ospf.areaId) out.push('ospf area ' + dev.config.ospf.areaId);
      }
      if (dev.config.bgp && dev.config.bgp.as != null) {
        out.push('router bgp ' + dev.config.bgp.as);
        if (dev.config.bgp.routerId) out.push('bgp router-id ' + dev.config.bgp.routerId);
        for (const n of (dev.config.bgp.neighbors || [])) {
          if (n && n.address && n.remoteAs != null) out.push('neighbor ' + n.address + ' remote-as ' + n.remoteAs);
        }
      }
      {
        // Router advertisements: only what differs from the defaults the device already assumes, so a
        // device that never touched `ipv6 nd` prints nothing.
        const ra = require('./ra');
        const cfg = dev.config.ra ? ra.normalizeConfig(dev.config.ra) : null;
        if (cfg && (cfg.enabled || cfg.suppress || cfg.m || cfg.o || cfg.prefixes.length ||
            cfg.routerLifetime !== ra.DEFAULTS.routerLifetime)) {
          if (cfg.enabled) out.push('ipv6 nd ra enable');
          if (cfg.suppress) out.push('ipv6 nd suppress-ra');
          if (cfg.m) out.push('ipv6 nd ra managed');
          if (cfg.o) out.push('ipv6 nd ra other-config');
          if (cfg.routerLifetime !== ra.DEFAULTS.routerLifetime) {
            out.push('ipv6 nd ra lifetime ' + cfg.routerLifetime);
          }
          for (const pref of cfg.prefixes) {
            out.push('ipv6 nd prefix ' + pref.prefix + '/' + pref.prefixLen +
              ' valid ' + pref.validLifetime + ' preferred ' + pref.preferredLifetime);
          }
        }
      }
      for (const i of dev.interfaces.values()) {
        out.push('interface ' + i.name);
        if (i.description) out.push('  description ' + i.description);
        // Only when forced: a config that emits `speed auto` on every port is noise, and the round trip
        // already asserts that nothing configured is left out (#1259).
        if (i.speedMbps) out.push('  speed ' + i.speedMbps);
        if (i.duplex && i.duplex !== 'full') out.push('  duplex ' + i.duplex);
        if (i.parent) out.push('  encapsulation dot1q ' + i.encapVid);
        // The method is printed, not the outcome. A host that has a lease holds both the `dhcp` flag and the
        // address the lease gave it, and printing the address baked a leased value into the backup: restored
        // on another network, the host claimed a stale address and never asked for a new one. A backup has to
        // describe what was configured, or restoring it changes what the device does.
        if (i.dhcp) out.push('  ip address dhcp');
        else if (i.ip) out.push('  ip address ' + i.ip + ' ' + i.mask);
        if (i.vlan) {
          // The mode and the VLAN parameters are separate state, and they are printed separately. The
          // parameters used to be printed only in the mode that uses them, so a trunk staged on an access
          // port - `switchport trunk native vlan 20` before the cable is patched, which is exactly why the
          // console lets you type it - vanished from the backup and never came back.
          const spMode = i.vlan.mode === 'trunk' ? 'trunk' : 'access';
          const spAccess = Number(i.vlan.accessVlan) || 1;
          const spVoice = i.vlan.voiceVlan === null || i.vlan.voiceVlan === undefined
            ? null : Number(i.vlan.voiceVlan);
          const spNative = Number(i.vlan.nativeVlan) || 1;
          const spAllowed = i.vlan.allowedVlans;
          // An empty list is the engine's "unset", not a configuration: no command can produce it
          // (`switchport trunk allowed vlan` with no list is `% Incomplete command`), so printing it would
          // emit a line the console cannot read back - which is what `no switchport` used to leave behind.
          const spAllowedText = (spAllowed === 'all' || !Array.isArray(spAllowed) || spAllowed.length === 0)
            ? null : spAllowed.join(',');
          if (spMode === 'trunk' || spAccess !== 1) out.push('  switchport mode ' + spMode);
          if (spAccess !== 1) out.push('  switchport access vlan ' + spAccess);
          if (spVoice !== null) out.push('  switchport voice vlan ' + spVoice);
          if (spNative !== 1) out.push('  switchport trunk native vlan ' + spNative);
          if (spAllowedText !== null) out.push('  switchport trunk allowed vlan ' + spAllowedText);
        }
        // An IPv6 address lives in config.ip6, not on the interface object, so a printer that walked the
        // interfaces could not have found it even in principle.
        const v6a = dev.config.ip6 && dev.config.ip6[i.name];
        if (v6a && v6a.addr) out.push('  ipv6 address ' + v6a.addr + '/' + v6a.prefix);
        if (i.autoconfig) out.push('  ipv6 address autoconfig');
        // Per-interface OSPF overrides - the same hole one level down: `ip ospf cost`, `ip ospf area` and
        // `ip ospf passive` were stored on the interface and printed nowhere.
        if (dev.config.ospf && Array.isArray(dev.config.ospf.interfaces)) {
          const ov = dev.config.ospf.interfaces.filter(function (x) { return x && x.name === i.name; })[0];
          if (ov) {
            if (ov.cost != null) out.push('  ip ospf cost ' + ov.cost);
            if (ov.area != null) out.push('  ip ospf area ' + ov.area);
            if (ov.passive) out.push('  ip ospf passive');
          }
        }
        const lag = dev.lagFor ? dev.lagFor(i.name) : null;
        // Printed in the console's vocabulary, which is the only spelling the parser takes back.
        if (lag) out.push('  channel-group ' + lag.id + ' mode ' + require('./lag').cliMode(lag.mode));
        // Which side of the translation this port is on. A port declared inside or outside is a fact the config
        // parser accepts, so it belongs in the block that reads it back (#1391).
        if (i.natRole === 'inside' || i.natRole === 'outside') out.push('  ip nat ' + i.natRole);
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
        // Three shapes, each of which the parser takes back: via a next hop (optionally out a port), out a
        // port alone (the directly-connected form), or bare. The old line printed an empty field for a
        // missing gateway, leaving two spaces and a line that depended on the tokenizer being forgiving.
        out.push('ip route ' + r.dest + ' ' + r.mask +
          (r.gw ? ' ' + r.gw + (r.iface ? ' ' + r.iface : '') : (r.iface ? ' ' + r.iface : '')));
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
      '  show power inline [<port>]        PoE supplied, and why a port was denied',
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
      '  no ip access-group [<acl>] [in|out]        (interface mode)',
      '  no hostname | no vlan <id> | no ip dhcp pool <name> | no dns zone <name>',
      '  ping <ip> [count]',
      '  converge [at <ms>]                - when each control plane finishes',
      '  link up|down <id> [at <ms>]       - pull or replace a cable, re-converge from there',
      '  links                             - every cable and its state',
      '  show version | ip interface brief | ip route | arp',
      '  show vlan [brief] | spanning-tree | etherchannel summary',
      '  show access-lists',
      '  show mac address-table | interfaces | running-config',
      // Three protocol families were configurable and absent from this list: the console could do VRRP, OSPF
      // and BGP and the index that says what the console can do never mentioned any of them. `show vrrp` was
      // documented in prose and missing here and from the docs table.
      '  vrrp <vrid> ip <addr> | priority <1-255> | preempt      (interface mode)',
      '  show vrrp                          the group, its state, and the master it elected',
      '  ospf router-id <ip> | area <id>                        (config mode)',
      '  ip ospf cost <n> | area <id> | passive                 (interface mode)',
      '  show ip ospf [neighbour | interface] [<port>]  the process, its adjacencies and what each port costs',
      '  show ip dhcp [binding | pool] [<address|mac|name>]  who holds which address, and pool utilisation',
      '  show ip dns [zone [<name>]]                   the zones this device answers for, and its resolvers',
      '  ping <address|name> [<count 1-50>] [at <ms>]   a name is resolved through the lab\'s DNS servers',
      '  router bgp <as> | neighbor <ip> remote-as <as>         (config mode)',
      '  show ip bgp [summary]              neighbours, their state, and the prefixes installed'
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
