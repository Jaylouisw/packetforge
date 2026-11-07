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
    } else if (head === 'interface' || head === 'int') {
      if (!tokens[1]) return ['% Incomplete command'];
      if (!this.device.interfaces.has(tokens[1])) return ['% Interface not found: ' + tokens[1]];
      this.iface = tokens[1];
      this.mode = MODE_IFACE;
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
    } else if (what === 'arp') {
      out.push('Protocol  Address          Age (min)  Hardware Addr   Interface');
      for (const [ip, mac] of dev.arp.entries()) {
        out.push('Internet  ' + pad(ip, 15) + '-          ' + mac);
      }
    } else if (what === 'mac' && tokens[1] === 'address-table') {
      out.push('Destination Address     Type        Interface');
      for (const [mac, iface] of dev.macTable.entries()) {
        out.push(pad(mac, 23) + 'DYNAMIC     ' + iface);
      }
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
        if (i.ip) out.push('  ip address ' + i.ip + ' ' + i.mask);
        else if (i.dhcp) out.push('  ip address dhcp');
        if (!i.enabled) out.push('  shutdown');
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
      '  ping <ip> [count]',
      '  show version | ip interface brief | ip route | arp',
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
