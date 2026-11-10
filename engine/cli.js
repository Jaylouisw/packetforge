'use strict';
// cli.js — vendor-agnostic management console (Cisco-like, but the same
// commands work for every vendor in the registry). The engine operates on
// capabilities, not on vendor syntax, so a Huawei router and a Cisco router
// share one consistent command set.
const net = require('./net');
const { renderTable } = require('./table');

// A counter is prose as well as a number: "1 packets" is the kind of detail that makes an operator
// distrust the figure beside it.
function plural(n, one, many) {
  return n + ' ' + (n === 1 ? one : (many || one + 's'));
}

// A line-level diff, longest common subsequence. Configurations are a couple of hundred lines, so the
// quadratic table is nothing, and an accurate diff is the difference between "3 lines changed" and a
// number an operator cannot check. Duplicate lines are handled correctly because the walk pairs them
// positionally through the table rather than by set membership.
function diffLines(before, after) {
  const a = before || [], b = after || [];
  const n = a.length, m = b.length;
  const row = function () { return new Array(m + 1).fill(0); };
  const t = [];
  for (let i = 0; i <= n; i++) t.push(row());
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      t[i][j] = a[i] === b[j] ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1]);
    }
  }
  const added = [], removed = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { i++; j++; }
    else if (t[i + 1][j] >= t[i][j + 1]) { removed.push(a[i]); i++; }
    else { added.push(b[j]); j++; }
  }
  while (i < n) { removed.push(a[i]); i++; }
  while (j < m) { added.push(b[j]); j++; }
  return { added: added, removed: removed };
}

// "3 lines added, 1 removed" - with the singular spelled out, because "1 lines" is the kind of detail
// that makes a reader distrust the count.
function describeDelta(d) {
  const parts = [];
  if (d.added.length) parts.push(plural(d.added.length, 'line') + ' added');
  if (d.removed.length) parts.push(plural(d.removed.length, 'line') + ' removed');
  return parts.join(', ') || 'no changes';
}

// "  (2 acl-deny, 1 no route in this VLAN)" - a drop count without its reasons is a number nobody can
// act on, and the reasons are already tallied per port by the simulator.
function dropReasons(reasons) {
  const keys = Object.keys(reasons || {});
  if (!keys.length) return '';
  // Short reasons ride on the same line (`drops : 2  (2 acl-deny)`), the way a glance expects. A
  // reason that is a sentence - "2 device is PoE-powered but the PSE budget is exhausted" - would run
  // off the right edge and take the number with it, so those are listed underneath, one per line,
  // commonest first. The count is never dropped: it is the part the reader came for.
  const parts = keys.slice().sort(function (a, b) {
    return (reasons[b] - reasons[a]) || a.localeCompare(b);
  }).map(function (k) { return { n: reasons[k], why: k }; });
  const inline = '  (' + parts.map(function (p) { return p.n + ' ' + p.why; }).join(', ') + ')';
  if (inline.length <= 60) return inline;
  const width = parts.reduce(function (w, p) { return Math.max(w, String(p.n).length); }, 1);
  return parts.map(function (p) {
    return '\n          ' + String(p.n).padStart(width) + '  ' + p.why;
  }).join('');
}
const natLib = require('./nat');

// Keywords in a show command whose *next* token is their value, so a trailing number after one of
// them is an argument and never a bare instant. `show mac address-table interface 22` names a port;
// `show spanning-tree 5000` names a moment. The distinction is the word before the number.
// Commands that only read: they cannot change the lab, so asking one does not make the derived
// control planes stale. Everything else - configuration, enable/exit, ping, flow, clear, write - may.
const READER_HEADS = new Set(['show', 'help', '?', 'sh', 'do', 'exit', 'end']);

const INSTANT_VALUE_KEYWORDS = new Set([
  'interface', 'int', 'last', 'device', 'port', 'vlan', 'proto', 'id', 'neighbor', 'type', 'zone'
]);

const MODE_EXEC = 'exec';
const MODE_ENABLE = 'enable';
const MODE_CONFIG = 'config';
const MODE_IFACE = 'iface';
const MODE_DHCP_POOL = 'dhcp-pool';

// One line per logged event. Rather than a switch per type - which would drift the moment a protocol
// adds a field - this prefers the fields that carry the *reason*, then the well-known addresses, then
// whatever identifying keys the event has. `reason` first is deliberate: a drop's whole value is why
// it was dropped.
function describeEvent(ev) {
  const parts = [];
  if (ev.reason) parts.push(String(ev.reason));
  if (ev.iface) parts.push('on ' + ev.iface);
  for (const key of ['from', 'to', 'src', 'dst', 'ip', 'via', 'seq', 'phase', 'pool',
    'serverName', 'poolName', 'vlan', 'vlanId', 'proto', 'port', 'count', 'code', 'state',
    'mac', 'prefix', 'helper', 'giaddr', 'relayName', 'bytes',
    // An `acl-deny` is useless without these two: which list, applied which way. It is the row an
    // operator reads to change one line of config, so the number belongs on it.
    'acl', 'dir']) {
    if (ev[key] === undefined) continue;
    parts.push(key + ' ' + ev[key]);
  }
  if (parts.length) return parts.join(', ');
  const rest = Object.keys(ev).filter(function (k) {
    return k !== 'type' && k !== 'step' && k !== 'dev';
  });
  return rest.map(function (k) { return k + ' ' + JSON.stringify(ev[k]); }).join(', ');
}

// ---------------------------------------------------------------------------
// Port-name aliases (issue #27)
//
// A spec names a port the way the vendor prints it on the box, because the
// canvas, the inspector and the faceplate must show what a person standing in
// front of the hardware sees. The vendor's own console sometimes spells the
// same socket differently: MikroTik silkscreens "eth1" and "SFP+1" while
// RouterOS calls them "ether1" and "sfp-sfpplus1". An engineer types whichever
// spelling they learned, so the CLI resolves both onto the one physical port.
// The spec still decides what is DRAWN - aliases never rename anything.
//
// Each rule rewrites the console spelling onto the panel spelling, and the
// panel spelling onto itself, so one lowercase key covers both directions and
// the case difference (RouterOS is lowercase, the silkscreen is not).
const PORT_NAME_RULES = [
  [/^ether(\d+)$/, 'eth$1'],           // RouterOS ether1  <-> panel eth1
  [/^sfp-sfpplus(\d+)$/, 'sfp+$1'],    // RouterOS sfp-sfpplus1 <-> panel SFP+1
  [/^sfpplus(\d+)$/, 'sfp+$1'],        // tolerant of sfpplus1
  [/^qsfp-qsfpplus(\d+)$/, 'qsfp+$1'], // RouterOS qsfp-qsfpplus1 <-> QSFP+1
  [/^qsfpplus(\d+)$/, 'qsfp+$1'],      // RouterOS qsfpplus1 <-> panel QSFP+1
  [/^sfp(\d+)$/, 'sfp$1'],             // RouterOS sfp1 <-> panel SFP1
  [/^sfp28-(\d+)$/, 'sfp28-$1'],       // RouterOS sfp28-1 <-> panel SFP28-1
  [/^qsfp28-(\d+)$/, 'qsfp28-$1'],     // RouterOS qsfp28-1 <-> panel QSFP28-1
  [/^combo(\d+)$/, 'combo$1'],         // RouterOS combo1 <-> panel COMBO1
  [/^mgmt(\d*)$/, 'mgmt$1']            // RouterOS mgmt <-> panel MGMT
];

// The comparison key for a port name: case-insensitive, with every known
// console spelling folded onto the panel spelling.
function portKey(name) {
  let s = String(name === undefined || name === null ? '' : name).trim().toLowerCase();
  for (const rule of PORT_NAME_RULES) {
    if (rule[0].test(s)) { s = s.replace(rule[0], rule[1]); break; }
  }
  return s;
}

// Resolve a name the operator typed onto the device's own interface name.
// Returns null when the device has no such port, so callers can say so.
function resolvePortName(device, typed) {
  const map = device && device.interfaces;
  if (!map || !typed) return null;
  const t = String(typed).trim();
  if (map.has(t)) return t;                          // exact panel spelling
  const lower = t.toLowerCase();
  for (const name of map.keys()) {
    if (String(name).toLowerCase() === lower) return name;      // case only
  }
  // A subinterface inherits its parent's spelling: 'ether1.10' -> 'eth1.10'.
  const sub = /^(.+)\.(\d+)$/.exec(t);
  if (sub) {
    const parent = resolvePortName(device, sub[1]);
    const wanted = parent ? parent + '.' + sub[2] : null;
    if (wanted && map.has(wanted)) return wanted;
  }
  const key = portKey(t);
  let alias = null;
  for (const name of map.keys()) {
    if (portKey(name) === key) {
      if (alias === null) alias = name;
      else if (alias !== name) return null;          // ambiguous: refuse to guess
    }
  }
  return alias;
}


function pad(s, w) { s = String(s); return s + ' '.repeat(Math.max(0, w - s.length)); }

// One row of a help table: the command padded to a fixed column, then the
// explanation. Built rather than typed out, because a command that grows by a
// character used to push its description out of line with every other row.
//
// A command longer than the column (flow open takes 70 characters) has nowhere to
// pad to, so its description goes on the next line, indented to the same column.
// Gluing the two together is how "…[sport <n>]start a conversation from here" got
// printed once already.
function helpLine(cmd, desc) {
  const c = String(cmd);
  if (!desc) return '  ' + c;
  if (c.length <= 41) return '  ' + pad(c, 43) + desc;
  return '  ' + c + '\n' + ' '.repeat(45) + desc;
}

// `at <ms>` asks a question at an instant, and the instant sticks: it belongs to the
// run the simulator is answering, so a later command without `at` answers at the same
// instant rather than jumping back to "everything has finished". That is easy to trip
// over - ask once at t=0 and every command afterwards fails - so `at converged` (also
// `infinity`) puts the network back to the default a fresh lab has.
function parseInstant(token) {
  const text = String(token === undefined || token === null ? '' : token).trim().toLowerCase();
  // Number('') is 0, not NaN, so an empty value would silently mean "at t=0" - the one
  // instant where nothing has converged yet. Reject it instead.
  if (!text) return { ok: false, atMs: null };
  if (text === 'converged' || text === 'infinity' || text === 'inf') return { ok: true, atMs: Infinity };
  const n = Number(text);
  if (!Number.isFinite(n) || n < 0) return { ok: false, atMs: null };
  return { ok: true, atMs: n };
}

function instantLabel(atMs) {
  return atMs === Infinity ? 'converged' : 't=' + atMs + ' ms';
}

function helpRows(rows) {
  // helpLine yields one string per row, but a row too long for the column carries
  // its description after a newline. The console hands its lines to the API as well
  // as to a terminal, so flatten them: one array element, one printed line.
  const out = [];
  for (const row of rows) {
    for (const part of String(row).split('\n')) out.push(part);
  }
  return out;
}

// `show ip route <word>` selectors. Kept beside the class rather than inside it because the
// mapping is data, and a filter that disagrees with the legend codes would be a bug waiting.
const LOAD_ROUTE_FILTERS = {
  connected: ['C'], static: ['S'], ospf: ['O'], bgp: ['B']
};
// How a selector is spelled back in prose. "2 ospf routes" reads like a variable name; OSPF is an
// acronym and the console uses the proper spelling everywhere else.
const LOAD_ROUTE_LABELS = { connected: 'connected', static: 'static', ospf: 'OSPF', bgp: 'BGP' };

class CliSession {
  constructor(device, topology, simulator) {
    this.device = device;
    this.topo = topology;
    this.sim = simulator;
    this.mode = MODE_EXEC;
    this.iface = null;
  }

  // Where `exit`/`end` out of configuration returns to. Privileged exec unless the session never
  // gained it, so this fixes the drop without handing out privilege that was never taken.
  _modeAfterConfig() {
    return this.modeBeforeConfig === MODE_ENABLE ? MODE_ENABLE : MODE_EXEC;
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
    let tokens = line.trim().split(/\s+/).filter(Boolean);
    if (!tokens.length) return { output: out, actions: [] };

    // A trailing `?` asks what can follow what you have already typed - `sh ?`, `show ip ?`,
    // `show ip route ?`. This used to be an error about the `?` itself (`sh ?` answered
    // `% Unrecognized command: sh ?`), which is the worst kind of reply to a question. Completion
    // does not insert anything: it prints the completions, which is honest about what this console
    // is (there is no line editor to insert into).
    //
    // The `?` does not need a space in front of it: `show ip?` and `sh st?` are how the key is
    // actually typed, and both were refused as if the `?` were part of the word. The typed text is
    // handed over as it stands - the walk already treats a word as a prefix of the keywords it
    // offers - so `sh st?` narrows to `startup-config` instead of listing everything after `show`.
    // A `?` that is part of the text is escaped, the way a real console needs Ctrl-V for it:
    // `description ready\?` writes the question mark instead of asking a question.
    if (/(^|[^\\])\?$/.test(line.trim())) {
      const whole = line.trim().replace(/\?$/, '');
      const words = whole.split(/\s+/).filter(Boolean);
      const attached = !/\s$/.test(whole) && words.length > 1 ? words.pop() : null;
      if (!words.length) return { output: this._help(), actions: [] };
      return { output: this._complete(words, attached), actions: [] };
    }
    if (/\\\?$/.test(line.trim())) {
      line = line.replace(/(\\\?)$/, '?');
      tokens = line.trim().split(/\s+/).filter(Boolean);
    }

    // Anything that is not a question may change the lab, and the control planes derived from it are
    // then stale. Bumped here, at the one door every command comes through, rather than in each of the
    // ~200 configuration verbs: a verb added tomorrow would otherwise answer from the state before its
    // own effect. Readers do not bump, so a second show of the same thing does no work at all.
    if (this.sim && !READER_HEADS.has(String(tokens[0]).toLowerCase())) this.sim.markChanged();

    // Unambiguous keyword abbreviation, the IOS rule (`sh ip int br`). Done before dispatch so every
    // mode gets it from one place, and skipped for `?`/`help` so the help itself can never be
    // rewritten into something else.
    if (tokens[0] !== '?' && tokens[0] !== 'help' && tokens.indexOf('?') === -1) {
      const res = this._expandAbbrev(tokens);
      if (res && res.ambiguous) {
        return {
          output: ['% Ambiguous command: "' + line.trim() + '"',
            '% Candidates: ' + res.candidates.join(', ')],
          actions: []
        };
      }
      if (res && res.tokens) tokens = res.tokens;
    }
    const head = tokens[0].toLowerCase();

    // '!' is a comment, exactly as it is in a pasted IOS config: a device that
    // rejects the first line of its own dump cannot be restored from that dump.
    if (head === '!') return { output: out, actions: [] };

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
        } else if (head === 'clear' && (tokens[1] === 'counters' ||
            ((tokens[1] === 'interface' || tokens[1] === 'interfaces') && tokens[2] === 'counters'))) {
          // Zeroing a counter is how you ask "what has happened *since the last problem*", which is the
          // only way a cumulative number becomes useful. Privileged, like `clear logging`, and it
          // names what it cleared: a bare "done" after wiping counters is how an operator loses the
          // evidence they were about to read.
          const rest = tokens[1] === 'counters' ? tokens.slice(2) : tokens.slice(3);
          const pick = this._portArg(rest, this.device, 'clear counters');
          if (!pick.ok) {
            out.push.apply(out, pick.output);
          } else if (this.mode !== MODE_ENABLE) {
            out.push('% clear counters needs enable mode - this session is at the user prompt');
          } else if (!this.sim) {
            out.push('% No simulation is running, so there is nothing to clear');
          } else {
            const rows = pick.port ? [pick.port] : this.sim.portStats(this.device.id)
              .map(function (r) { return r.iface; });
            let cleared = 0;
            for (const name of rows) {
              const rec = this.sim._portStat(this.device.id, name);
              if (rec.rx || rec.tx || rec.drops) cleared++;
              rec.rx = 0; rec.tx = 0; rec.rxBytes = 0; rec.txBytes = 0;
              rec.drops = 0; rec.reasons = {};
            }
            out.push('Counters cleared on ' + (pick.port || (this.device.name || this.device.id)) +
              ' (' + (pick.port ? '1 port' : rows.length + ' port' + (rows.length === 1 ? '' : 's')) +
              ', ' + cleared + ' had traffic)');
          }
        } else if (head === 'clear' && tokens[1] === 'logging') {
          // Truncating the log is how you ask "what has happened *since*" without re-reading a
          // screenful. It is a privileged action, as in IOS, and it refuses to guess at a target.
          if (this.mode !== MODE_ENABLE) {
            // Not "Invalid exec command": the command is fine, the session is not privileged. Saying
            // otherwise sends an operator looking for a missing feature.
            out.push('% clear logging needs enable mode - this session is at the user prompt');
          } else if (tokens.length > 2) {
            out.push('% Unexpected argument "' + tokens[2] + '" (clear logging takes none)');
          } else {
            const had = (this.sim && this.sim.events) ? this.sim.events.length : 0;
            if (this.sim && this.sim.events) this.sim.events.length = 0;
            out.push('Event log cleared (' + had + ' event' + (had === 1 ? '' : 's') + ' dropped)');
          }
        } else if (head === 'write' || head === 'copy') {
          // `write memory` and `copy running-config startup-config` are the same act, and both are how
          // an operator answers "what was on this box before I started changing it". The saved copy is
          // the *rendered* configuration, not the model: it is what a person reads and pastes, and it
          // is the only thing a diff against the running config can honestly compare.
          const isWrite = head === 'write';
          const target = isWrite ? (tokens[1] === undefined ? 'memory' : tokens[1])
            : (tokens[1] === 'running-config' || tokens[1] === 'run' ? tokens[2] : null);
          const okTarget = isWrite
            ? ['memory', 'mem', 'startup-config', 'startup'].indexOf(target) !== -1
            : ['startup-config', 'startup', 'start'].indexOf(target) !== -1;
          if (!okTarget) {
            out.push(head === 'write'
              ? '% write takes memory (or startup-config) - there is nothing else to write'
              : '% copy takes running-config startup-config - the source must be running-config');
          } else if (this.mode !== MODE_ENABLE) {
            out.push('% ' + (isWrite ? 'write memory' : 'copy running-config startup-config') +
              ' needs enable mode - this session is at the user prompt');
          } else {
            out.push.apply(out, this._saveConfig(this.device));
          }
        } else if (head === 'configure' || head === 'conf') {
          if (tokens[1] === 'terminal' || tokens[1] === 't') {
            // Remember where we came from: `exit`/`end` return to that prompt. IOS puts you back
            // at privileged exec, and the old code sent every session to *user* exec instead, so a
            // pasted config followed by `show ip interface brief` answered "Invalid exec command"
            // until the operator typed `enable` again - a privilege drop nobody asked for, and the
            // reason a stray `exit` used to make the next block of config vanish into refusals.
            this.modeBeforeConfig = this.mode;
            this.mode = MODE_CONFIG;
          }
          else out.push('% Invalid input: ' + line);
        } else if (head === 'show') {
          out.push.apply(out, this._show(tokens.slice(1)));
        } else if (head === 'ping') {
          out.push.apply(out, this._ping(tokens.slice(1)));
        } else if (head === 'traceroute' || head === 'tracert') {
          out.push.apply(out, this._traceroute(tokens.slice(1)));
        } else if (head === 'nslookup') {
          out.push.apply(out, this._nslookup(tokens.slice(1)));
        } else if (head === 'flow') {
          out.push.apply(out, this._flowCommand(tokens.slice(1)));
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
    if (head === 'help' || head === '?') return this._help();
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
      const typed = tokens[2];
      const name = resolvePortName(this.device, typed);
      const vi = name ? this.device.interfaces.get(name) : null;
      if (!vi) return ['% Interface not found: ' + (typed || '')];
      if (!vi.parent) return ['% ' + typed + ' is a physical interface and cannot be removed'];
      this.device.interfaces.delete(name);
      out.push('Subinterface ' + name + ' removed');
    } else if (head === 'access-list') {
      out.push.apply(out, this._accessList(tokens.slice(1)));
    } else if (head === 'no' && tokens[1] === 'access-list') {
      out.push.apply(out, this._noAccessList(tokens.slice(2)));
    } else if (head === 'interface' || head === 'int') {
      out.push.apply(out, this._enterInterface(tokens.slice(1)).lines);
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
      // Snapshot the pool as it was, and remember whether it was just created: leaving the sub-mode
      // validates it, and an invalid pool must not survive as configuration. A pool the console
      // accepted and then cannot re-enter is the defect this snapshot prevents - the running-config
      // dump prints pools, and a dump that fails its own validation on paste is not a dump.
      this.poolSnapshot = JSON.parse(JSON.stringify(pool));
      this.poolCreated = !pool.rangeStart && !pool.network;
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
    } else if (head === 'no' && (tokens[1] === 'neighbor' || (tokens[1] === 'bgp' && tokens[2] === 'neighbor'))) {
      // `no bgp neighbor <ip>` is the spelling help documents; `no neighbor <ip>` is the one the rest
      // of the grammar suggests. Both remove the same neighbour.
      const addr = tokens[1] === 'bgp' ? tokens[3] : tokens[2];
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
      this.mode = this._modeAfterConfig();
    } else if (head === 'show') {
      out.push.apply(out, this._show(tokens.slice(1)));
    } else if (head === 'do') {
      // Allow an exec-style command from config mode: 'do show ...'. _show()
      // expects the tokens AFTER 'show', so both 'do' and 'show' have to be
      // dropped - the original one-token slice handed _show the literal word
      // 'show', and every 'do show ...' answered "% Invalid show command: show ...".
      if (String(tokens[1] || '').toLowerCase() === 'show') {
        out.push.apply(out, this._show(tokens.slice(2)));
      } else {
        out.push('% do only supports "do show <...>" here');
      }
    } else {
      out.push('% Unrecognized config command: ' + tokens.join(' '));
    }
    return out;
  }

  // ---------- interface mode ----------
  // Resolve `interface <name>` to a real port, creating a dot1q subinterface when
  // asked for one. `name` is null when the port does not exist and `lines` carries
  // the explanation. Both config mode and interface mode go through here, so a
  // `show running-config` dump can be pasted without exiting every block first.
  _enterInterface(tokens) {
    if (!tokens[0]) return { lines: ['% Incomplete command'], name: null };
    // `interface vlan <id>` - the switch's own address, on a VLAN rather than on a socket. This is the
    // object ownsIpOn() had a rule for and nothing could create, so a switch could not hold a
    // management address at all.
    if (String(tokens[0]).toLowerCase() === 'vlan') {
      if (!tokens[1]) return { lines: ['% Incomplete command: interface vlan <id>'], name: null };
      if (!/^\d+$/.test(String(tokens[1]))) {
        return { lines: ['% VLAN id must be a number, not "' + tokens[1] + '"'], name: null };
      }
      const vid = parseInt(tokens[1], 10);
      if (!(vid >= 1 && vid <= 4094)) return { lines: ['% VLAN out of range: ' + tokens[1]], name: null };
      if (!this.device.isL2()) {
        // A router has no VLANs to put an address in; the port is the socket. Refusing by name beats
        // creating an object that would never carry a frame.
        return { lines: ['% ' + (this.device.name || this.device.id) + ' does not switch - it has no VLANs',
          '% Put the address on the port: "interface ' +
            ((Array.from(this.device.interfaces.values())[0] || {}).name || 'Gi0/0') + '"'], name: null };
      }
      const existed = this.device.interfaces.has('Vlan' + vid);
      const svi = this.device.addSvi(vid);
      this.iface = svi.name;
      this.mode = MODE_IFACE;
      // Only a *new* object says so. Re-entering an SVI is not an event, and a paste that announces
      // every block it enters buries the one line that mattered.
      return {
        lines: existed ? [] : [svi.name + ' created - this device\'s own address in VLAN ' + vid],
        name: svi.name
      };
    }
    // Both spellings of a port resolve here: the panel name from the spec and
    // the vendor-console name the operator may have typed (issue #27).
    let name = resolvePortName(this.device, tokens[0]);
    if (!name) {
      // 'interface Gi0/0.10' creates a router subinterface on Gi0/0.
      const m = /^(.+)\.(\d+)$/.exec(tokens[0]);
      const parent = m ? resolvePortName(this.device, m[1]) : null;
      if (m && parent) {
        const vid = parseInt(m[2], 10);
        if (!(vid >= 1 && vid <= 4094)) return { lines: ['% VLAN out of range: ' + m[2]], name: null };
        this.device.addSubinterface(parent, vid);
        name = parent + '.' + vid;
        this.iface = name;
        this.mode = MODE_IFACE;
        return { lines: ['Created subinterface ' + name + ' (parent ' + parent + ')'], name: name };
      }
      // `interface Vlan10` must work on a device that has no SVI yet, or `show running-config` cannot
      // be pasted: the dump names the object by its interface name, and a dump that has to be
      // hand-edited to reload is worse than no dump.
      const sviName = /^vlan(\d+)$/i.exec(tokens[0]);
      if (sviName) {
        const vid = parseInt(sviName[1], 10);
        if (vid >= 1 && vid <= 4094 && this.device.isL2()) {
          const created = this.device.addSvi(vid);
          this.iface = created.name;
          this.mode = MODE_IFACE;
          return { lines: [], name: created.name };
        }
      }
      return { lines: ['% Interface not found: ' + tokens[0]], name: null };
    }
    this.iface = name;
    this.mode = MODE_IFACE;
    return { lines: [], name: name };
  }

  _ifaceMode(tokens) {
    const out = [];
    const head = tokens[0].toLowerCase();

    // Switching ports from inside an interface block keeps a pasted
    // `show running-config` working; the current interface is replaced, so this
    // runs before that interface is resolved.
    if (head === 'interface' || head === 'int') {
      return this._enterInterface(tokens.slice(1)).lines;
    }

    const iface = this.device.interfaces.get(this.iface);

    if (head === 'help' || head === '?') return this._help();
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
        let ip = tokens[2];
        let mask = tokens[3];
        // `ip address 10.0.0.1/24` is the *same fact* as `10.0.0.1 255.255.255.0`, and it is the form
        // this console prints everywhere (`show ip interface brief`, `show running-config`, every table
        // with an Address column) and the form `ipv6 address` already accepts. Refusing what it prints
        // is the same asymmetry as a port name the config parser takes and the show commands do not.
        if (ip && mask === undefined && String(ip).indexOf('/') !== -1) {
          const split = String(ip).split('/');
          ip = split[0];
          mask = split[1];
        }
        if (!ip) {
          return ['% ip address needs an address: "ip address 10.0.0.1 255.255.255.0" or "ip address 10.0.0.1/24"'];
        }
        if (mask === undefined) {
          // A bare address used to answer "% Incomplete command", which says nothing about *what* is
          // missing. The mask is the missing half, and both spellings are offered because an operator
          // who typed one may not know the other.
          return ['% ip address ' + ip + ' needs a mask - the address alone does not say the subnet',
            '% Either spelling works: "ip address ' + ip + ' 255.255.255.0" or "ip address ' + ip + '/24"'];
        }
        net.ipToInt(ip); net.maskToInt(mask);
        iface.ip = ip; iface.mask = mask; iface.dhcp = false;
        out.push('IP address set on ' + iface.name + ': ' + ip + '/' + net.prefixOf(mask));
      }
    } else if (head === 'ip' && tokens[1] === 'helper-address') {
      out.push.apply(out, this._helperAddress(tokens.slice(2), iface));
    } else if (head === 'no' && tokens[1] === 'ip' && tokens[2] === 'helper-address') {
      out.push.apply(out, this._noHelperAddress(tokens.slice(3), iface));
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
    } else if (head === 'no' && tokens[1] === 'ip' && tokens[2] === 'access-group') {
      out.push.apply(out, this._noAccessGroup(tokens.slice(3), iface));
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
      this.mode = this._modeAfterConfig();
    } else if (head === 'show') {
      out.push.apply(out, this._show(tokens.slice(1)));
    } else {
      // Nothing in this block claimed the line. Real IOS applies a global command
      // typed inside an interface block and leaves the block; doing the same is
      // what lets a pasted `show running-config` run start to finish, since the
      // dump does not print `exit` between an interface block and the globals.
      const asGlobal = this._configMode(tokens);
      const refused = asGlobal.some(function (l) { return /^% Unrecognized config command/.test(l); });
      if (refused) return ['% Unrecognized interface command: ' + tokens.join(' ')];
      if (this.mode === MODE_IFACE) this.mode = MODE_CONFIG;
      out.push.apply(out, asGlobal);
      // Say so. `ospf area 0` inside an interface block is the *global* command: it configures the
      // process, not the port, and the block is left behind. Applying it silently is how an operator
      // concludes the interface is in area 0 when it is not - the fall-through exists so a pasted
      // running-config runs start to finish, not to make a meaning change invisible.
      out.push('  note: "' + tokens.join(' ') + '" is a global command - applied at global scope and the ' +
        'interface block was left (the per-port form is "ip ' + tokens[0] + ' ...")');
    }
    return out;
  }

  // Protocol selectors for `show ip route <protocol>`. Keys are what an operator types; values are
  // the codes the table uses, so the filter cannot disagree with the legend.
  // `all` is not here on purpose: it is the default, and offering it would imply the bare command
  // means something else.

  // One protocol's rows, with the installed mark and the distance that decides it.
  _routeFiltered(dev, codes, word) {
    const rows = dev.routesTable().filter(function (r) { return codes.indexOf(r.code) !== -1; });
    const label = LOAD_ROUTE_LABELS[word] || word;
    if (!rows.length) {
      return ['% No ' + label + ' routes in the table',
        '% Codes present: ' + this._routeCodesPresent(dev.routesTable())];
    }
    const out = [];
    out.push.apply(out, renderTable(['*', 'Prefix', 'AD', 'Gateway', 'Interface'],
      rows.map(function (r) {
        return [(r.installed ? '*' : ''), r.code + ' ' + r.dest + '/' + net.prefixOf(r.mask),
          String(r.ad === undefined ? '-' : r.ad), r.gw, r.iface];
      }), 2));
    const installed = rows.filter(function (r) { return r.installed; }).length;
    out.push('');
    out.push(rows.length + ' ' + label + ' route' + (rows.length === 1 ? '' : 's') + ', ' +
      installed + ' installed');
    return out;
  }

  // How many routes there are, per protocol, and how many of them forward. The full table shows the
  // rows; only a count says how much of it is shadowed.
  _routeSummary(dev) {
    const rows = dev.routesTable();
    const order = [['connected', 'C'], ['static', 'S'], ['ospf', 'O'], ['bgp', 'B']];
    const body = [];
    let totalRows = 0;
    let totalInstalled = 0;
    for (const entry of order) {
      const mine = rows.filter(function (r) { return r.code === entry[1]; });
      if (!mine.length) continue;
      const up = mine.filter(function (r) { return r.installed; }).length;
      body.push([entry[0], String(mine.length), String(up)]);
      totalRows += mine.length;
      totalInstalled += up;
    }
    if (!body.length) return ['% The routing table is empty'];
    body.push(['total', String(totalRows), String(totalInstalled)]);
    const out = ['Route summary'];
    out.push.apply(out, renderTable(['Protocol', 'Routes', 'Installed'], body, 2));
    if (totalInstalled !== totalRows) {
      out.push('');
      out.push((totalRows - totalInstalled) + ' route' + ((totalRows - totalInstalled) === 1 ? '' : 's') +
        ' shadowed by a lower administrative distance - "show ip route" marks the installed ones');
    }
    return out;
  }

  // The codes actually in the table, so a refusal can name what is there instead of only what is not.
  _routeCodesPresent(rows) {
    const names = { C: 'connected', S: 'static', O: 'OSPF', B: 'BGP' };
    const seen = [];
    for (const r of rows) {
      if (seen.indexOf(names[r.code] || r.code) === -1) seen.push(names[r.code] || r.code);
    }
    return seen.length ? seen.join(', ') : '(none)';
  }

  // `show ip route <dest>` - the lookup, not the table.
  //
  // Three forms, all of which IOS accepts: a bare address (longest match), address/length, or an
  // address with a dotted mask. The answer comes from `routeTo()`, the same call the data path
  // makes, so it cannot drift from what a ping would do; the candidates come from `routesTable()`,
  // which carries the administrative distances that explain the choice.
  _routeLookup(dev, arg) {
    const out = [];
    const text = String(arg[0] === undefined ? '' : arg[0]);
    // `net.isIp` is a shape check only - it accepts `10.0.0.999` - and the arithmetic behind it
    // then throws `Invalid IPv4 address`, which reaches the console as `% Error: Invalid IPv4
    // address`. So a refusal here reads like a crash next to the clean refusals every other
    // command prints, and worse, the throw depends on the device: with no interfaces configured
    // `routeTo()` never calls it and answers "no route" instead. Validate by parsing.
    const isIp = function (v) {
      if (!net.isIp(v)) return false;
      try { net.ipToInt(v); return true; } catch (e) { return false; }
    };
    const TYPE_NAME = { connected: 'connected', static: 'static', ospf: 'OSPF', bgp: 'BGP',
      default: 'default' };
    let addr = null;
    let len = null;

    if (arg.length > 2) {
      return ['% Usage: show ip route [<dest> | <dest>/<len> | <dest> <mask>] [at <ms>|converged]'];
    }
    if (arg.length === 2) {
      // address + dotted mask, as a config line spells it. A length and a mask are alternatives,
      // not a pair, so mixing them is a usage error rather than a mask of "10.0.99.5/24".
      if (text.indexOf('/') !== -1) {
        return ['% Usage: show ip route [<dest> | <dest>/<len> | <dest> <mask>] [at <ms>|converged]'];
      }
      if (!isIp(text)) return ['% Invalid destination: ' + text];
      let bits;
      let plen;
      try {
        bits = net.maskToInt(arg[1]);
        plen = net.prefixOf(arg[1]);
      } catch (e) {
        return ['% Invalid mask: ' + arg[1]];
      }
      const canonical = plen === 0 ? 0 : (0xffffffff << (32 - plen)) >>> 0;
      if (bits !== canonical) return ['% Invalid mask: ' + arg[1] + ' (not a contiguous netmask)'];
      addr = text;
      len = plen;
    } else if (text.indexOf('/') !== -1) {
      const parts = text.split('/');
      if (parts.length !== 2 || !isIp(parts[0])) return ['% Invalid prefix: ' + text];
      if (!/^\d{1,2}$/.test(parts[1]) || parseInt(parts[1], 10) > 32) {
        return ['% Invalid prefix length: ' + parts[1]];
      }
      addr = parts[0];
      len = parseInt(parts[1], 10);
    } else if (isIp(text)) {
      addr = text;
    } else {
      return ['% Invalid destination: ' + text,
        '% Use an address, an address/length, or an address and a mask'];
    }

    const rows = dev.routesTable();
    const rowsFor = function (prefix) {
      return rows.filter(function (r) { return r.dest + '/' + net.prefixOf(r.mask) === prefix; });
    };

    if (len !== null) {
      // Prefix form: exactly this prefix, every candidate, and which one is installed.
      const wanted = net.intToIp(net.networkOf(addr, String(len))) + '/' + len;
      const here = rowsFor(wanted);
      if (!here.length) return ['% No route for ' + wanted + ' in the table'];
      out.push.apply(out, renderTable(['*', 'Prefix', 'AD', 'Gateway', 'Interface'],
        here.map(function (r) {
          return [(r.installed ? '*' : ''), r.code + ' ' + r.dest + '/' + net.prefixOf(r.mask),
            String(r.ad === undefined ? '-' : r.ad), r.gw, r.iface];
        }), 2));
      return out;
    }

    // Longest match, which is the question the table cannot answer.
    const route = dev.routeTo(addr);
    if (!route) {
      out.push('% No route to ' + addr);
      if (!dev.config.defaultGateway) out.push('% No default route is configured on this device');
      return out;
    }
    const prefix = net.intToIp(net.networkOf(addr, String(route.prefix))) + '/' + route.prefix;
    out.push('  Destination  ' + addr);
    out.push('  Matched      ' + prefix + '  (' + (TYPE_NAME[route.type] || route.type) +
      ', AD ' + route.ad + ')');
    out.push('  Next hop     ' + (route.type === 'connected' ? '- (directly connected)'
      : (route.via || '-')));
    out.push('  Interface    ' + (route.iface || '-'));
    const shadowed = rowsFor(prefix).filter(function (r) { return !r.installed; });
    for (const r of shadowed) {
      out.push('  Shadowed     ' + r.code + ' ' + r.dest + '/' + net.prefixOf(r.mask) +
        '  (' + (TYPE_NAME[{ C: 'connected', S: 'static', O: 'ospf', B: 'bgp' }[r.code]] || r.code) +
        ', AD ' + r.ad + ')');
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
    // Two spellings, both documented by someone: the help row offers `bgp neighbor <ip> remote-as <as>`
    // and `show running-config` emits `neighbor <ip> remote-as <as>`. The console accepted only the
    // second, so the command help advertised was refused with a usage line and the dump could not be
    // pasted back - the same class of defect the paste test exists to catch, this time at the parser.
    let t = tokens.map(function (x) { return String(x); });
    if (String(t[0] || '').toLowerCase() === 'bgp') t = t.slice(1);
    if (String(t[0] || '').toLowerCase() === 'neighbor') t = t.slice(1);
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

    return ['% Usage: router bgp <as> | bgp router-id <ip> | bgp neighbor <ip> remote-as <as>',
      '% ("neighbor <ip> remote-as <as>" works too - it is what "show running-config" emits)'];
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

  // no access-list <n> [<entry...>]
  //
  // With only a number, the list goes away - that is the old behaviour and it stays. With the
  // entry spelled out, only that entry goes, which is what IOS does and what an operator
  // typing `no access-list 101 permit tcp any host 10.0.1.5 eq 80` means. It used to delete
  // the whole list and answer "Access list 101 removed": a request to remove one line silently
  // discarded the rest, and the confirmation named the list rather than the entry, so the
  // damage looked like success.
  _noAccessList(tokens) {
    const aclLib = require('./acl');
    const dev = this.device;
    const num = parseInt(tokens[0], 10);
    const kind = aclLib.aclKind(num);
    if (!kind) return ['% Invalid access list number: ' + (tokens[0] || '')];
    const key = String(num);
    const list = (dev.config.acls || {})[key];
    if (!list || !list.length) return ['% Access list ' + num + ' does not exist'];

    const unbind = function () {
      const binds = dev.aclBindings || {};
      for (const k of Object.keys(binds)) {
        if (String(binds[k].in) === String(num)) delete binds[k].in;
        if (String(binds[k].out) === String(num)) delete binds[k].out;
      }
    };

    if (tokens.length === 1) {
      delete dev.config.acls[key];
      unbind();
      return ['Access list ' + num + ' removed (' + list.length +
        (list.length === 1 ? ' entry)' : ' entries)')];
    }

    // The typed entry is parsed, not string-matched: `eq 80` and `eq www` are the same entry,
    // and the canonical `line` is what the list stores and prints.
    const typed = tokens.slice(1).join(' ');
    const probe = aclLib.parseEntry(typed, num);
    if (!probe || probe.error) return ['% ' + ((probe && probe.error) || 'invalid entry')];
    // Compare what the entries *mean*, not how they were typed: `host 10.0.1.6` and
    // `10.0.1.6 0.0.0.0` are one entry, and so are `eq 80` and `eq www` - both parse to
    // port 80. Matching on the stored text would refuse to remove an entry the operator
    // had just read in `show access-lists` under a different spelling.
    // A spec is canonicalised too: `host 10.0.1.6` and `10.0.1.6 0.0.0.0` are the same address,
    // and only the `host` flag records which spelling was used.
    const specKey = function (spec) {
      if (!spec) return null;
      if (spec.any) return 'any';
      return spec.ip + '/' + (spec.host ? '0.0.0.0' : spec.wildcard);
    };
    const canon = function (e) {
      const c = {};
      for (const k of Object.keys(e)) {
        if (k === 'line' || k === 'sequence') continue;
        if (k === 'source' || k === 'destination') { c[k] = specKey(e[k]); continue; }
        c[k] = e[k];
      }
      return JSON.stringify(c);
    };
    const strip = canon;
    let idx = -1;
    for (let i = 0; i < list.length; i++) {
      if (strip(list[i]) === strip(probe)) { idx = i; break; }
    }
    if (idx === -1) {
      // Refuse rather than shrug: an entry that is not there means the text was misremembered,
      // and printing what *is* there is the only way to see the difference.
      const out = ['% Access list ' + num + ' has no entry "' + (probe.line || typed) + '"'];
      out.push('% Entries: ' + list.map(function (e, i) { return (i + 1) + ') ' + e.line; }).join('  '));
      return out;
    }
    const removed = list.splice(idx, 1)[0];
    if (!list.length) {
      delete dev.config.acls[key];
      unbind();
      return ['Access list ' + num + ': removed "' + removed.line + '" - the list is now empty and was deleted'];
    }
    return ['Access list ' + num + ': removed "' + removed.line + '" (' + list.length + ' left)'];
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

  // no ip access-group [<acl>] [in|out]
  //
  // Once a list was bound there was no way to unbind it, which made "turn the ACL
  // off and watch the flow succeed" impossible from the CLI. With no arguments it
  // clears both directions; with a number and/or a direction it clears only the
  // bindings that match, so a typo is refused instead of silently removing the
  // other direction.
  _noAccessGroup(tokens, iface) {
    const dev = this.device;
    const binds = dev.aclBindings && dev.aclBindings[iface.name];
    if (!binds || (binds.in == null && binds.out == null)) {
      return ['% No access list is bound to ' + iface.name];
    }
    let wantNum = null;
    let wantDir = '';
    for (const t of tokens) {
      const s = String(t).toLowerCase();
      if (s === 'in' || s === 'out') wantDir = s;
      else if (/^\d+$/.test(s)) wantNum = parseInt(s, 10);
    }
    const removed = [];
    for (const dir of ['in', 'out']) {
      if (binds[dir] == null) continue;
      if (wantDir && wantDir !== dir) continue;
      if (wantNum !== null && Number(binds[dir]) !== wantNum) continue;
      delete binds[dir];
      removed.push(dir);
    }
    if (!removed.length) {
      return ['% Access list ' + (wantNum !== null ? wantNum + ' ' : '') +
        'is not bound' + (wantDir ? ' ' + wantDir : '') + ' on ' + iface.name];
    }
    return ['Interface ' + iface.name + ': removed access list binding (' + removed.join(', ') + ')'];
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
    const claims = (dev.vrrpClaims || []);
    out.push.apply(out, renderTable(['Interface', 'Group', 'Pri', 'State', 'Master', 'Virtual IP', 'Virtual MAC'],
      groups.map(function (g) {
        const claim = claims.filter(function (c) {
          return c.vrid === g.vrid && c.iface === g.interface;
        })[0];
        return [g.interface, g.vrid, (g.priority === undefined ? 100 : g.priority),
          claim ? 'Master' : 'Backup', dev.name || '', (g.ips || []).join(','),
          claim ? claim.mac : '-'];
      })));
    if (!claims.length) out.push('(no group holds its address yet - run a simulation)');
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
    if (head === 'help' || head === '?') return this._help();
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
        // An invalid pool is not configuration, so it does not stay in the configuration. The old
        // behaviour validated on exit and kept the object anyway, which left a pool that `show
        // ip dhcp pool` listed, that allocated nothing, and whose own line in `show running-config`
        // could not be pasted back without the same error.
        const wasNew = this.poolCreated;
        if (wasNew) {
          this.device.config.dhcpPools = (this.device.config.dhcpPools || [])
            .filter(function (q) { return q.name !== pool.name; });
          out.push('% Pool ' + pool.name + ' discarded - a pool is kept only once it is valid');
          out.push('% Add "range <start> <end>" inside the pool, or start again with "ip dhcp pool ' +
            pool.name + '"');
        } else if (this.poolSnapshot) {
          Object.keys(pool).forEach(function (k) { delete pool[k]; }, this);
          Object.assign(pool, this.poolSnapshot);
          out.push('% Pool ' + pool.name + ' restored to its previous configuration - the edit was ' +
            'not valid');
        }
      }
      this.mode = mode;
      this.pool = null;
      this.poolSnapshot = null;
      this.poolCreated = false;
      return out;
    };

    if (head === 'exit') return finish(MODE_CONFIG);
    if (head === 'end') return finish(this._modeAfterConfig());
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

  // Resolve the target an operator typed.
  //
  // An address is already an answer. A name goes through the same two doors `nslookup`
  // uses - this device's own authoritative zones first, then the lab's resolvers - so
  // `ping www.lab.test` and `nslookup www.lab.test` cannot disagree. This existed nowhere:
  // `ping <name>` was refused outright while docs/CLI.md described the resolver path as
  // "the same one `ping <name>` uses".
  _resolveHost(text, label) {
    const dev = this.device;
    const dnsLib = require('./dns');
    const what = label || 'target';
    const raw = String(text === undefined || text === null ? '' : text).trim();
    if (!raw) return { ok: false, message: '% Invalid ' + what + ': (none)' };
    if (net.isIp(raw)) {
      // net.isIp() only checks the shape; 10.0.0.999 slips through it, so the strict
      // conversion is the one that decides.
      try { net.ipToInt(raw); } catch (e) { return { ok: false, message: '% Invalid ' + what + ': ' + raw }; }
      return { ok: true, ip: raw, literal: true };
    }
    // Something that is only digits and dots (or carries a colon) was meant to be an
    // address, so it is a malformed one - not a hostname to look up. Saying "unknown
    // host 999.1.1.1" would blame DNS for a typo.
    if (/^[0-9.]+$/.test(raw) || raw.indexOf(':') !== -1) {
      return { ok: false, message: '% Invalid ' + what + ': ' + raw };
    }

    const firstA = function (res) {
      const answers = (res && res.answers) || [];
      const a = answers.filter(function (x) {
        return String(x.type || '').toUpperCase() === 'A';
      })[0] || answers[0];
      return a ? (a.value || a.address || a.data || null) : null;
    };

    for (const zone of (dev.config.dnsZones || [])) {
      const res = dnsLib.resolve(zone, raw, 'A');
      if (!res.authoritative) continue;
      const address = firstA(res);
      if (address) {
        return { ok: true, ip: address, server: (dev.name || dev.id) + ' (authoritative for ' + zone.name + ')' };
      }
      // An authoritative NXDOMAIN is a statement about the name, not a failure to ask.
      return { ok: false, message: '% Unknown host ' + raw + ': ' + (res.rcodeName || 'no A record') +
        ' from ' + (dev.name || dev.id) + ', which is authoritative for ' + zone.name };
    }

    if (this.sim && typeof this.sim.resolveName === 'function') {
      const res = this.sim.resolveName(dev, raw);
      if (res.ok && res.address) return { ok: true, ip: res.address, server: res.server };
      if (res.status === 'NXDOMAIN') {
        return { ok: false, message: '% Unknown host ' + raw + ': NXDOMAIN from ' + (res.server || '(no server)') };
      }
      if (res.status === 'NODATA') {
        return { ok: false, message: '% Unknown host ' + raw + ': the name exists at ' +
          (res.server || '(no server)') + ' but has no A record' };
      }
      return { ok: false, message: '% Unknown host ' + raw + ': no DNS server in this lab hosts a zone for it' };
    }
    return { ok: false, message: '% Unknown host ' + raw + ': no DNS server and no local zone contains it' };
  }

  // ---------- ping ----------
  //
  // `ping 10.0.0.2` and `ping 10.0.0.2 5 at 5000` - the last form asks the question 5 seconds after
  // power-on, which is the only way to watch a lab come up. Real hardware prints a time in
  // milliseconds; this prints the delay the engine computed from the path (propagation +
  // serialisation + store-and-forward), and falls back to the hop count if a link has no length.
  _ping(tokens) {
    let count = 4;
    let atMs = null;
    for (let i = 1; i < tokens.length; i++) {
      if (String(tokens[i]).toLowerCase() === 'at') {
        const when = parseInstant(tokens[i + 1]);
        if (!when.ok) return ['% Invalid instant: ' + (tokens[i + 1] === undefined ? '(none)' : tokens[i + 1])];
        atMs = when.atMs;
        i++;
        continue;
      }
      // `count <n>` and a bare `<n>` are both accepted, as IOS does. A count that is not a
      // number used to be dropped on the floor, so `ping x count abc` silently sent four -
      // the same "looks like an answer" failure as an ignored port.
      const tok = String(tokens[i]);
      const isKeyword = tok.toLowerCase() === 'count';
      const value = isKeyword ? tokens[i + 1] : tok;
      const whole = /^[+-]?\d+$/.test(String(value === undefined ? '' : value));
      if (!isKeyword && !whole) {
        return ['% Unrecognised argument "' + tok + '" (expected count <n> or at <ms>)'];
      }
      if (!whole || Number(value) < 1) {
        return ['% count expects a whole number of at least 1 (got ' +
          (value === undefined ? '(none)' : value) + ')'];
      }
      count = Number(value);
      if (isKeyword) i++;
    }
    const target = this._resolveHost(tokens[0], 'ping target');
    if (!target.ok) return [target.message];
    const ip = target.ip;
    const out = target.literal ? [] : ['Translating "' + tokens[0] + '"...domain server (' + target.server + ')'];
    if (!this.sim) return ['% Simulator not attached'];
    if (atMs !== null) this.sim.setRunTime(atMs);
    out.push('Type escape sequence to abort.');
    out.push('Sending ' + count + ', 100-byte ICMP Echos to ' + ip + ', timeout is 2 seconds:' +
      (atMs !== null ? '  (at ' + instantLabel(atMs) + ')' : ''));
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

  // ---------- traceroute ----------
  //
  // The forwarding path, hop by hop. TTL expiry is not modelled: the path is the one
  // the routing tables select right now, read from the same routeTo() the forwarder
  // uses. The delay column is the one-way propagation + serialisation to reach that
  // hop, which is why it grows down the list instead of jittering.
  _traceroute(tokens) {
    if (!tokens[0]) return ['% Invalid traceroute target: (none)'];
    const target = this._resolveHost(tokens[0], 'traceroute target');
    if (!target.ok) return [target.message];
    const ip = target.ip;
    if (!this.sim) return ['% Simulator not attached'];
    let atMs = null;
    for (let i = 1; i < tokens.length; i++) {
      if (String(tokens[i]).toLowerCase() !== 'at') continue;
      if (tokens[i + 1] === undefined) return ['% Incomplete command: traceroute <ip> at <ms>|converged'];
      const when = parseInstant(tokens[i + 1]);
      if (!when.ok) return ['% Invalid instant: ' + tokens[i + 1]];
      atMs = when.atMs;
      i++;
    }
    const latencyLib = require('./latency');
    const res = this.sim.tracePath(this.device.id, ip, atMs === null ? {} : { atMs: atMs });
    const out = target.literal ? [] : ['Translating "' + tokens[0] + '"...domain server (' + target.server + ')'];
    out.push('Type escape sequence to abort.');
    out.push('Tracing the route to ' + ip + (atMs !== null ? '  (at ' + instantLabel(atMs) + ')' : ''));
    out.push('');
    let cumulative = 0;
    let defaulted = 0;
    const chain = [this.device.name || this.device.id];
    const hopRows = [];
    for (let i = 0; i < res.hops.length; i++) {
      const h = res.hops[i];
      cumulative += (h.delayS || 0);
      if (!h.delayKnown) defaulted++;
      const t = latencyLib.formatDelayS(cumulative) + (h.delayKnown ? '' : '*');
      // A hop with no matching device in the lab has no name to print; renderTable
      // trims the trailing padding rather than leaving it on the console line.
      hopRows.push([i + 1, h.address, t,
        (h.device || '') + (h.last ? '  (destination)' : '')]);
      if (h.device) chain.push(h.device);
    }
    out.push.apply(out, renderTable(['Hop', 'Address', 'Cumulative', 'Device'], hopRows, 2));
    if (!res.arrived) {
      out.push('  *  *  *  (no reply)');
      out.push('% ' + (res.reason || 'destination unreachable'));
      return out;
    }
    out.push('');
    out.push('Path: ' + chain.join(' -> ') + '  (' + res.hops.length + ' hop' +
      (res.hops.length === 1 ? '' : 's') + ')');
    if (defaulted) {
      out.push('* ' + (defaulted === 1 ? 'a link' : defaulted + ' links') +
        ' had no cable length or line rate, so the documented default was used');
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
    // A bare number, validated: `converge abc` used to mean "no instant" and `converge -1`
    // meant "one millisecond before power-on", so both answered a question nobody asked.
    let atMs = null;
    if (tokens[0] !== undefined) {
      if (String(tokens[0]).toLowerCase() === 'at') {
        return ['% converge takes a bare instant: converge <ms>|converged (not "at <ms>")'];
      }
      const when = parseInstant(tokens[0]);
      if (!when.ok) return ['% Invalid instant: ' + tokens[0]];
      atMs = when.atMs;
    }
    const rows = sched.entries.map(function (e) {
      const mark = (atMs !== null && Number.isFinite(atMs) && e.readyAtMs > atMs) ? '  (pending)' : '';
      return [e.process, String(e.device.name || e.deviceId), (e.readyAtMs + ' ms'),
        (e.basis || '') + mark];
    });
    out.push.apply(out, renderTable(['Process', 'Device', 'Ready', 'Basis'], rows));
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
    const rows = [];
    for (const l of this.topo.links.values()) {
      rows.push([l.id, this._endpointName(l.a) + ' <-> ' + this._endpointName(l.b), l.state]);
    }
    return renderTable(['Link', 'Endpoints', 'State'], rows);
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
    if (!rows.length) {
      out.push(pad('Neighbor', 17) + pad('V', 3) + pad('AS', 8) + pad('State', 16) + 'Reason');
      out.push('(no neighbours have been evaluated yet - run a simulation)');
    } else {
      const table = rows.map(function (r) {
        return [r.address, '4', String(r.remoteAs == null ? '?' : r.remoteAs),
          r.established ? 'Established' : 'Idle',
          r.established ? (r.session === 'ibgp' ? 'iBGP' : 'eBGP') : (r.reason || r.code || '')];
      });
      out.push.apply(out, renderTable(['Neighbor', 'V', 'AS', 'State', 'Reason'], table));
    }
    const up = rows.filter(function (r) { return r.established; }).length;
    out.push('');
    out.push(up + ' of ' + rows.length + ' neighbour(s) established');
    const learned = (dev.bgpRoutes || []).length;
    out.push(learned + ' prefix(es) installed from BGP');
    return out;
  }

  // show ip ospf [neighbor]
  //
  // The adjacencies behind the `O` routes. Before this existed the only way to
  // see an OSPF neighbour was to infer it from the route table, which cannot tell
  // you about a neighbour that formed but produced no route - a stub, or a port
  // that is passive. `show ip ospf` reports the process and its interfaces;
  // `show ip ospf neighbor` reports the peers.
  _showOspf(args) {
    const dev = this.device;
    const cfg = dev.config && dev.config.ospf;
    const out = [];
    if (!cfg || !cfg.routerId) { out.push('% OSPF is not enabled'); return out; }

    // Refresh from the current topology, so the table reflects the SPF that just
    // ran over it rather than whatever the last ping happened to leave behind.
    if (this.sim && typeof this.sim.computeOspf === 'function') {
      try { this.sim.computeOspf(); } catch (e) { /* keep the persisted state */ }
    }

    const what = String(args[0] || '').toLowerCase();
    const neighbors = dev.ospfNeighbors || [];

    if (what === 'neighbor' || what === 'neighbors') {
      if (!neighbors.length) {
        out.push('Neighbor ID     Pri   State           Address         Interface');
        out.push('(no adjacencies - no neighbour passed the passive and subnet checks)');
      } else {
        const rows = neighbors.map(function (n) {
          return [n.routerId || '?', '1', n.state, n.ip, n.iface];
        });
        out.push.apply(out, renderTable(['Neighbor ID', 'Pri', 'State', 'Address', 'Interface'], rows));
      }
      return out;
    }

    out.push('Routing Process "ospf 1" with ID ' + cfg.routerId);
    out.push('  Area ' + (cfg.areaId || 0));

    const overrides = cfg.interfaces || [];
    const participating = [];
    for (const i of dev.interfaces.values()) {
      if (!i.enabled || !i.ip || !i.mask) continue;
      const ov = overrides.filter(function (x) { return x.name === i.name; })[0];
      participating.push({
        name: i.name,
        cost: (ov && ov.cost) || (this.sim && typeof this.sim._ospfCost === 'function'
          ? this.sim._ospfCost(i) : '?'),
        area: (ov && ov.area !== undefined) ? ov.area : (cfg.areaId || 0),
        passive: !!(ov && ov.passive)
      });
    }
    out.push('  Interfaces:');
    if (!participating.length) {
      out.push('    (none - no interface has an address and a mask)');
    } else {
      out.push.apply(out, renderTable(['Interface', 'Cost', 'Area', 'State'],
        participating.map(function (p) {
          return [p.name, p.cost, p.area, p.passive ? 'passive' : 'active'];
        }), 4));
    }
    out.push('  Neighbors: ' + neighbors.length + ' (' +
      neighbors.filter(function (n) { return n.state === 'FULL'; }).length + ' FULL)');
    return out;
  }

  // show dns
  //
  // The zone table and the resolvers. DNS was configurable (`dns zone`,
  // `dns add`, `ip name-server`) and observable only through the event log of a
  // ping, which is a strange place to check a record.
  _showDns() {
    const dev = this.device;
    const out = [];
    const zones = dev.config.dnsZones || [];
    const servers = dev.config.dnsServers || [];

    out.push('DNS zones on ' + (dev.name || dev.id) + ':');
    if (!zones.length) {
      out.push('  (none - create one with "dns zone <name>")');
    } else {
      for (const z of zones) {
        const records = z.records || [];
        out.push('  ' + z.name + '  (' + records.length + ' record' +
          (records.length === 1 ? '' : 's') + ')');
        const recRows = records.map(function (rec) {
          return [rec.name, rec.type, rec.value || ''];
        });
        out.push.apply(out, renderTable(['Name', 'Type', 'Value'], recRows, 4));
      }
    }
    out.push('  Name servers: ' +
      (servers.length ? servers.join(', ') : 'none (queries go to any server in the lab)'));
    return out;
  }

  // show scion [paths [<isd-as>]]
  //
  // Membership, the segments this AS holds, and the paths the beaconed segments
  // compose. SCION was configurable (`scion <isd-as>`) and inspectable only
  // through the event log of `pingScion`; `scion.js` already had describePath()
  // written for exactly this body.
  _showScion(args) {
    const dev = this.device;
    const scionLib = require('./scion');
    const out = [];
    const raw = dev.config.scionAs;
    if (!raw) {
      out.push('% This device is not a SCION AS (use "scion <isd-as>" in config mode)');
      return out;
    }
    const parsed = scionLib.parseIsdAs(raw);
    const self = parsed.valid ? scionLib.formatIsdAs(parsed.isd, parsed.asHex) : String(raw);
    const core = scionLib.isCore(self);

    if (this.sim && typeof this.sim.computeScion === 'function') {
      try { this.sim.computeScion(); } catch (e) { /* keep whatever is persisted */ }
    }
    const S = (this.sim && this.sim.scion) || { members: [], cores: [], segments: [], neighbours: [] };
    const members = S.members || [];
    const segments = S.segments || [];
    const cores = S.cores || [];

    const what = String(args[0] || '').toLowerCase();

    if (what === 'path' || what === 'paths') {
      if (!this.sim || typeof this.sim.scionPaths !== 'function') {
        out.push('% Simulator not attached');
        return out;
      }
      const dstArg = args[1];
      const peers = members.map(function (m) { return m.id; })
        .filter(function (id) { return id !== self; });
      const targets = dstArg ? [dstArg] : peers;
      out.push('SCION paths from ' + self + ':');
      for (const dst of targets) {
        const r = this.sim.scionPaths(self, dst);
        const best = scionLib.selectPath(r.paths, null);
        if (!r.paths.length) {
          out.push('  ' + pad(dst, 18) + 'no beaconed path' +
            (r.failures.length ? ' (' + r.failures.length + ' refused)' : ''));
          continue;
        }
        out.push('  ' + pad(dst, 18) + r.paths.length + ' path' +
          (r.paths.length === 1 ? '' : 's') +
          (best ? '  best ' + scionLib.pathHops(best).length + ' hops, ' +
            scionLib.pathLatency(best) + ' ms' : ''));
        if (dstArg && best) {
          for (const line of scionLib.describePath(best)) out.push('    ' + line);
        }
      }
      return out;
    }

    const UP = scionLib.PATH_TYPES.UP;
    const DOWN = scionLib.PATH_TYPES.DOWN;
    const CORE = scionLib.PATH_TYPES.CORE;
    const ups = segments.filter(function (s) { return s.from === self && s.type === UP; });
    const downs = segments.filter(function (s) { return s.to === self && s.type === DOWN; });
    const coreSegs = segments.filter(function (s) {
      return s.type === CORE && (s.from === self || s.to === self);
    });
    const peers = [];
    for (const p of (S.neighbours || [])) {
      if (p[0] === self && peers.indexOf(p[1]) === -1) peers.push(p[1]);
      if (p[1] === self && peers.indexOf(p[0]) === -1) peers.push(p[0]);
    }
    peers.sort();

    out.push('SCION membership on ' + (dev.name || dev.id) + ':');
    out.push('  ISD-AS       : ' + self + (core ? '  (core AS)' : '  (non-core)'));
    out.push('  Segments     : ' + ups.length + ' up, ' + coreSegs.length + ' core, ' + downs.length + ' down');
    out.push('  Peers        : ' + (peers.length ? peers.join(', ') : 'none (no SCION cable to another AS)'));
    out.push('  Network      : ' + members.length + ' AS(es), ' + cores.length + ' core');
    const others = members.map(function (m) { return m.id; })
      .filter(function (id) { return id !== self; });
    if (others.length) {
      out.push('  Reachability :');
      for (const dst of others) {
        const r = (this.sim && typeof this.sim.scionPaths === 'function')
          ? this.sim.scionPaths(self, dst) : { paths: [] };
        out.push('    ' + pad(dst, 18) + (r.paths.length ? r.paths.length + ' path(s)' : 'unreachable'));
      }
      out.push('  ("show scion paths <isd-as>" describes the selected path)');
    }
    return out;
  }

  // nslookup <name> [type]
  //
  // Ask the device's own zones first — a box that hosts the zone answers
  // authoritatively, and `dns.js` already formats that answer. Only if no local
  // zone knows the name does it fall back to the lab's resolvers, the same path
  // `ping <name>` uses.
  _nslookup(args) {
    const dev = this.device;
    const dnsLib = require('./dns');
    const name = args[0];
    const type = String(args[1] || 'A').toUpperCase();
    if (!name) return ['% Usage: nslookup <name> [type]'];
    if (type !== 'ANY' && dnsLib.RECORD_TYPES.indexOf(type) === -1) {
      return ['% Unknown record type "' + type + '" (use ' + dnsLib.RECORD_TYPES.join('/') + ')'];
    }

    const out = [];
    for (const zone of (dev.config.dnsZones || [])) {
      const res = dnsLib.resolve(zone, name, type);
      // If the name falls inside a zone this device hosts, that zone's answer is
      // the authoritative one — including an authoritative NXDOMAIN, which is a
      // statement about the name rather than a failure to ask anybody.
      if (res.authoritative) {
        out.push('Server: ' + (dev.name || dev.id) + ' (authoritative for ' + zone.name + ')');
        out.push.apply(out, dnsLib.formatAnswer(res));
        return out;
      }
    }

    if (this.sim && typeof this.sim.resolveName === 'function') {
      const res = this.sim.resolveName(dev, name);
      out.push('Server: ' + (res.server || '(none)'));
      if (res.ok) {
        out.push('  ' + name + ' -> ' + res.address);
      } else if (res.status === 'NODATA') {
        out.push('  ' + name + ' exists but has no A record (NODATA)');
      } else if (res.status === 'NXDOMAIN') {
        out.push("  ** server can't find " + name + ': NXDOMAIN');
      } else {
        out.push('  ** server failure: no DNS server in this lab hosts a zone for ' + name);
      }
      return out;
    }
    out.push('% No DNS server available and no local zone contains ' + name);
    return out;
  }

  // Which shows can be asked about an instant. These are the ones whose answer is a product of
  // the control planes; the physical and configuration shows are not, and pretending otherwise
  // would suggest something changed that cannot.
  _instantCapable(tokens) {
    const a = String(tokens[0] || '').toLowerCase();
    const b = String(tokens[1] || '').toLowerCase();
    if (a === 'spanning-tree' || a === 'vrrp' || a === 'arp' || a === 'lldp') return true;
    if (a === 'mac' && b === 'address-table') return true;
    if (a === 'ip' && (b === 'bgp' || b === 'ospf' || b === 'route' || b === 'dhcp')) return true;
    // IPv6 routes come from addresses and configuration, but a SLAAC host has a route only after a
    // router advertisement has been heard, so the instant question is a real question here too.
    if (a === 'ipv6' && b === 'route') return true;
    // An autoconfigured address exists only after the advertisement was heard. In this model that
    // is the single router-advertisement pass at the start of a run, so the table does not actually
    // change with the instant - but the question is well formed, the label says which instant was
    // asked about, and pretending the command cannot take one would be the larger lie.
    if (a === 'ipv6' && b === 'interface') return true;
    return false;
  }

  // A trailing `converged` or bare number on a show that can take an instant. Needed because the
  // caller has to know whether to call `_splitInstant()` at all: without this, a row advertising
  // `[at <ms>|converged]` would still only be checked for the literal word `at`.
  // A bare trailing instant (`converged`, a number) - but only when it is the *question*, not the
  // value of the keyword before it. `show mac address-table interface 22` asks about a port named 22,
  // and answering it with a table rebuilt at t=22 ms answered a question nobody asked while dropping
  // the port. One predicate, because `_looksLikeBareInstant` and `_splitInstant` have to agree: when
  // they disagreed, the first said "an instant is present" and the second refused the line.
  _bareInstantToken(tokens) {
    if (!tokens.length) return null;
    const last = String(tokens[tokens.length - 1] === undefined ? '' : tokens[tokens.length - 1]);
    if (!/^(converged|\d+)$/i.test(last)) return null;
    const prev = tokens[tokens.length - 2];
    if (prev !== undefined && INSTANT_VALUE_KEYWORDS.has(String(prev).toLowerCase())) return null;
    return last;
  }

  _looksLikeBareInstant(tokens) {
    if (!tokens.length || !this._instantCapable(tokens)) return false;
    return this._bareInstantToken(tokens) !== null;
  }

  // Split a trailing `at <ms>|converged` off a show command, refusing anything after it so a
  // typo cannot read as a valid instant.
  _splitInstant(tokens) {
    // Help advertises `[at <ms>|converged]`, which offers four spellings, and only the `at` ones
    // were parsed: `show spanning-tree converged` ignored the word and printed the table as last
    // computed - an answer to a question nobody asked, with nothing to say it had been ignored.
    // So a trailing `converged` or a bare number is an instant too.
    let at = tokens.indexOf('at');
    if (at === -1) {
      const last = this._bareInstantToken(tokens);
      if (last !== null) {
        const when = parseInstant(last);
        if (when.ok) return { ok: true, atMs: when.atMs, tokens: tokens.slice(0, -1) };
        return { ok: false, lines: ['% Invalid instant: ' + last] };
      }
      return { ok: true, atMs: null, tokens: tokens };
    }
    const head = 'show ' + tokens.slice(0, at).join(' ');
    if (tokens[at + 1] === undefined) {
      return { ok: false, lines: ['% Incomplete command: ' + head + ' at <ms>|converged'] };
    }
    const when = parseInstant(tokens[at + 1]);
    if (!when.ok) return { ok: false, lines: ['% Invalid instant: ' + tokens[at + 1]] };
    if (at + 2 !== tokens.length) {
      return { ok: false, lines: ['% Unexpected argument after the instant: ' + tokens[at + 2],
        '% Usage: ' + head + ' at <ms>|converged'] };
    }
    return { ok: true, atMs: when.atMs, tokens: tokens.slice(0, at) };
  }

  // The noun the instant label uses, so the answer reads as English rather than as a header.
  _instantLabelFor(tokens) {
    const a = String(tokens[0] || '').toLowerCase();
    const b = String(tokens[1] || '').toLowerCase();
    if (a === 'ip' && b === 'route') return 'Routes';
    if (a === 'ipv6' && b === 'route') return 'IPv6 routes';
    if (a === 'ipv6' && b === 'interface') return 'IPv6 interfaces';
    if (a === 'ip' && b === 'ospf') return 'OSPF';
    if (a === 'ip' && b === 'bgp') return 'BGP';
    if (a === 'ip' && b === 'dhcp') return 'DHCP';
    if (a === 'mac') return 'MAC table';
    if (a === 'spanning-tree') return 'STP';
    if (a === 'vrrp') return 'VRRP';
    if (a === 'arp') return 'ARP';
    if (a === 'lldp') return 'LLDP';
    return 'State';
  }

  // Save the running configuration as the startup copy, and report what changed since the last save.
  //
  // IOS says "Building configuration... [OK]" and tells you nothing else. The one question worth
  // answering here is the one the operator will ask next - *what is different* - so the answer names
  // the delta against the copy being replaced. The first save has nothing to compare against, and says
  // so rather than inventing a zero.
  _saveConfig(dev) {
    // The header line is a label, not configuration: `! PacketForge running-config` would be a lie in a
    // copy that is no longer the running config, and keeping it would make every diff report one line
    // added and one removed for the label alone. The body is what is saved and what is compared.
    const lines = this._runningConfigLines(dev).slice(1);
    const previous = dev.savedConfig;
    dev.savedConfig = { lines: lines.slice(), savedAtRun: this.sim ? this.sim.step : null };
    const head = 'Saved startup-config on ' + (dev.name || dev.id) + ': ' + lines.length + ' lines';
    if (!previous) {
      return [head, '(this is the first save in this lab - "show startup-config" now answers)'];
    }
    const d = diffLines(previous.lines, lines);
    if (!d.added.length && !d.removed.length) return [head + ' (no changes since the previous save)'];
    return [head + ' (' + describeDelta(d) + ')'];
  }

  // The `interface <name>` block of a rendered configuration: the header line and the indented lines
  // under it, stopping at the first line that is not indented. A block is what a person pastes and
  // what a diff about one port has to compare, so it is extracted once and used by both shows.
  _configBlock(lines, port) {
    const out = [];
    let inside = false;
    for (const line of lines) {
      const header = /^interface\s+(.+)$/i.exec(line);
      if (header) {
        inside = resolvePortName(this.device, header[1].trim()) === port ||
          header[1].trim() === port;
        if (inside) out.push(line);
        continue;
      }
      if (!inside) continue;
      if (line === '' || !/^ /.test(line)) { inside = false; continue; }
      out.push(line);
    }
    return out;
  }

  // `show startup-config` - the saved copy, then what the running config has done to it since.
  //
  // The delta is printed as `!` comments so the whole answer stays pasteable: a config dump that
  // cannot be pasted is a config dump an operator has to edit before using.
  _showStartupConfig(dev, only) {
    const saved = dev.savedConfig;
    if (!saved) {
      return ['% No startup-config on ' + (dev.name || dev.id) +
        ' - nothing has been written in this lab',
      '% "write memory" saves the running configuration (privileged, as on a real device)'];
    }
    const current = this._runningConfigLines(dev).slice(1);
    if (only) {
      // One interface: the saved block, then whether *this* block was saved. An operator asking about
      // one port wants to know whether the change they just made to it is in the copy - a whole-config
      // delta makes them search for the answer.
      const savedBlock = this._configBlock(saved.lines, only);
      const runningBlock = this._configBlock(current, only);
      const out = ['! PacketForge startup-config (saved copy), interface ' + only].concat(savedBlock);
      const bd = diffLines(savedBlock, runningBlock);
      if (bd.added.length || bd.removed.length) {
        out.push('!');
        out.push('! running-config differs for ' + only + ': ' + describeDelta(bd));
        for (const l of bd.added) out.push('! + ' + l);
        for (const l of bd.removed) out.push('! - ' + l);
        out.push('! "write memory" replaces this copy with the running configuration');
      }
      return out;
    }
    const out = ['! PacketForge startup-config (saved copy)'].concat(saved.lines);
    const d = diffLines(saved.lines, current);
    if (d.added.length || d.removed.length) {
      out.push('!');
      out.push('! running-config differs from this copy: ' + describeDelta(d));
      const CAP = 12;
      if (d.added.length) {
        out.push('! not in this copy (running-config only):');
        for (const l of d.added.slice(0, CAP)) out.push('! + ' + l);
        if (d.added.length > CAP) out.push('! ... ' + (d.added.length - CAP) + ' more');
      }
      if (d.removed.length) {
        out.push('! no longer in the running config (this copy still has):');
        for (const l of d.removed.slice(0, CAP)) out.push('! - ' + l);
        if (d.removed.length > CAP) out.push('! ... ' + (d.removed.length - CAP) + ' more');
      }
      out.push('! "write memory" replaces this copy with the running configuration');
    }
    return out;
  }

  // The running configuration, as the lines a person reads and a paste re-enters.
  //
  // One rendering, used by `show running-config`, by `write memory` (which stores this text as the
  // saved copy) and by the diff against it. Two renderings would drift, and the diff would then
  // compare a configuration to something that was never printed.
  _runningConfigLines(dev) {
    const out = [];
    out.push('! PacketForge running-config');
    out.push('hostname ' + (dev.config.hostname || dev.name));

    // VLAN declarations, not just the switchport membership that points at them.
    const vlans = dev.config.vlans || {};
    for (const id of Object.keys(vlans).sort(function (a, b) { return Number(a) - Number(b); })) {
      out.push('vlan ' + id + (vlans[id] && vlans[id].name ? ' ' + vlans[id].name : ''));
    }

    // OSPF process first: `ip ospf …` inside an interface is refused until
    // `ospf router-id` has enabled the process, so the global lines must
    // precede the interface blocks to round-trip.
    const ospf = dev.config.ospf;
    if (ospf && ospf.routerId) {
      out.push('ospf router-id ' + ospf.routerId);
      if (ospf.areaId) out.push('ospf area ' + ospf.areaId);
    }
    const ospfIfaces = (ospf && ospf.interfaces) || [];
    const vrrp = Array.isArray(dev.config.vrrp) ? dev.config.vrrp : [];

    for (const i of dev.interfaces.values()) {
      out.push('interface ' + i.name);
      if (i.description) out.push('  description ' + i.description);
      if (i.parent) out.push('  encapsulation dot1q ' + i.encapVid);
      if (i.ip) out.push('  ip address ' + i.ip + ' ' + i.mask);
      // `ip address dhcp` is accepted after a static address and does not clear
      // it, so a port that has both must emit both lines or the flag is lost.
      if (i.dhcp) out.push('  ip address dhcp');
      // A relay that the dump forgets is a relay the pasted config loses, which is the one thing
      // `show running-config` exists to prevent.
      for (const helper of (i.helperAddresses || [])) {
        out.push('  ip helper-address ' + helper);
      }
      // An SVI is a member of its VLAN by definition, not by configuration: `switchport` on a
      // logical interface is not a thing, and emitting it made the dump describe the port rather
      // than the object it belongs to.
      if (i.vlan && !i.svi) {
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
      // OSPF interface overrides, carried by the same interface block.
      const ov = ospfIfaces.filter(function (x) { return x.name === i.name; })[0];
      if (ov) {
        if (ov.cost !== undefined) out.push('  ip ospf cost ' + ov.cost);
        if (ov.area !== undefined) out.push('  ip ospf area ' + ov.area);
        if (ov.passive) out.push('  ip ospf passive');
      }
      // IPv6 addressing: autoconfig is the source of truth; a static address
      // is only emitted when the interface is not waiting on a router.
      if (i.autoconfig) {
        out.push('  ipv6 address autoconfig');
      } else if (dev.config.ip6 && dev.config.ip6[i.name] && dev.config.ip6[i.name].addr) {
        out.push('  ipv6 address ' + dev.config.ip6[i.name].addr + '/' + dev.config.ip6[i.name].prefix);
      }
      // VRRP is configured per interface, so it round-trips inside the block.
      for (const g of vrrp) {
        if (g.interface !== i.name) continue;
        for (const vip of (g.ips || [])) out.push('  vrrp ' + g.vrid + ' ip ' + vip);
        if (g.priority !== undefined && g.priority !== 100) out.push('  vrrp ' + g.vrid + ' priority ' + g.priority);
        if (g.advertSec !== undefined && g.advertSec !== 1) out.push('  vrrp ' + g.vrid + ' advertise ' + g.advertSec);
      }
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

    // BGP: the process line must precede router-id and neighbours.
    const bgp = dev.config.bgp;
    if (bgp && bgp.as) {
      out.push('router bgp ' + bgp.as);
      if (bgp.routerId) out.push('bgp router-id ' + bgp.routerId);
      for (const n of (bgp.neighbors || [])) out.push('neighbor ' + n.address + ' remote-as ' + n.remoteAs);
    }

    // IPv6 routing.
    for (const r6 of (dev.config.routes6 || [])) {
      out.push('ipv6 route ' + r6.dest + '/' + r6.prefix + ' ' + r6.nextHop);
    }
    if (dev.config.gateway6) out.push('ipv6 gateway ' + dev.config.gateway6);

    // IPv6 router advertisements. Only non-default state is emitted: a device
    // that never configured RA has `ra === null`, and the timer values (hop
    // limit, reachable, retransmit) have no CLI verb, so there is nothing to say
    // about them.
    const raLib = require('./ra');
    const ra = dev.config.ra ? raLib.normalizeConfig(dev.config.ra) : null;
    if (ra) {
      if (ra.enabled) out.push('ipv6 nd ra enable');
      if (ra.m) out.push('ipv6 nd ra managed');
      if (ra.o) out.push('ipv6 nd ra other-config');
      if (ra.suppress) out.push('ipv6 nd suppress-ra');
      if (ra.routerLifetime !== raLib.DEFAULTS.routerLifetime) {
        out.push('ipv6 nd ra lifetime ' + ra.routerLifetime);
      }
      for (const p of ra.prefixes) {
        out.push('ipv6 nd prefix ' + p.prefix + '/' + p.prefixLen +
        ' valid ' + p.validLifetime + ' preferred ' + p.preferredLifetime);
      }
    }

    // DNS: each zone's records follow its `dns zone`, so a paste re-attaches
    // them to the right zone rather than the last one opened.
    for (const z of (dev.config.dnsZones || [])) {
      out.push('dns zone ' + z.name);
      for (const rec of (z.records || [])) out.push('dns add ' + rec.name + ' ' + rec.type + ' ' + rec.value);
    }
    for (const ns of (dev.config.dnsServers || [])) out.push('ip name-server ' + ns);

    if (dev.config.scionAs) out.push('scion ' + dev.config.scionAs);

    // DHCP pools: a block per pool, `exit` returning to config mode between them.
    for (const pool of (dev.config.dhcpPools || [])) {
      out.push('ip dhcp pool ' + pool.name);
      if (pool.network) out.push('  network ' + pool.network + (pool.mask ? ' ' + pool.mask : ''));
      if (pool.gateway) out.push('  default-router ' + pool.gateway);
      if (pool.dns) out.push('  dns-server ' + pool.dns);
      if (pool.rangeStart && pool.rangeEnd) out.push('  range ' + pool.rangeStart + ' ' + pool.rangeEnd);
      if (pool.excluded && pool.excluded.length) out.push('  excluded-address ' + pool.excluded.join(' '));
      const lease = Number(pool.leaseSec);
      if (Number.isFinite(lease) && lease > 0) {
        const days = Math.floor(lease / 86400);
        const hours = Math.floor((lease % 86400) / 3600);
        const mins = Math.floor((lease % 3600) / 60);
        out.push('  lease ' + days + ' ' + hours + ' ' + mins);
      }
      const reservations = pool.reservations || {};
      for (const mac of Object.keys(reservations)) out.push('  host ' + reservations[mac] + ' ' + mac);
      out.push('  exit');
    }
    return out;
  }

  _show(tokens) {
    // An SVI's line protocol depends on the current link state, so it is recomputed before every
    // `show` rather than trusted from the last run: configuration can change between two questions,
    // and a stale `lineUp` would answer about a VLAN that no longer has a live port. One place, so no
    // show command can forget it.
    if (this.sim) this.sim.computeSviState();
    // A trailing `at <ms>|converged` asks the state shows for a different instant: the control
    // planes are rebuilt at that moment before the answer is composed, and the answer says which
    // instant it describes. Without the label the two answers - "as last computed" and "as it
    // would be at 5 s" - are indistinguishable, which is the whole reason for having both.
    let atMs = null;
    if (tokens.indexOf('at') !== -1 || this._looksLikeBareInstant(tokens)) {
      if (!this._instantCapable(tokens)) {
        return ['% "' + tokens.join(' ') + '" does not take an instant',
          '% Control-plane shows do: show ip route|ospf|bgp|arp|dhcp ..., show mac address-table, show spanning-tree, show vrrp, show lldp'];
      }
      const split = this._splitInstant(tokens);
      if (!split.ok) return split.lines;
      tokens = split.tokens;
      atMs = split.atMs;
    }
    const what = (tokens[0] || '').toLowerCase();
    const dev = this.device;
    const out = [];
    if (atMs === null && this.sim && this._instantCapable(tokens)) {
      // The same question must get the same answer on a fresh simulator as after a ping. Without this,
      // `show spanning-tree` answered "No bridged ports: this device is not part of any L2 loop" until
      // something else had run - a confident conclusion drawn from an empty table. Cheap: the planes
      // are derived once per change of the lab, so a second show does no work.
      const first = String(tokens[0] || '').toLowerCase();
      const second = String(tokens[1] || '').toLowerCase();
      const wantsIpv6 = first === 'ipv6';
      this.sim.refreshControlPlanes({
        lldp: first === 'lldp' || wantsIpv6,
        ra: wantsIpv6
      });
    }
    if (atMs !== null) {
      if (!this.sim) return ['% Simulator not attached'];
      // LLDP and RA are announced as well: a question about what was *heard* needs something to
      // have spoken, and a question about routes does not care.
      this.sim.refreshControlPlanes({ atMs: atMs, lldp: true, ra: true });
      const label = this._instantLabelFor(tokens);
      out.push(label + ' at ' + instantLabel(atMs) + ' (control planes rebuilt for this answer)');
    }
    if (what === 'version' || what === 'ver') {
      out.push(this._banner());
      out.push('Vendor     : ' + dev.vendor);
      out.push('Model      : ' + dev.model + ' (' + dev.label + ')');
      out.push('Category   : ' + dev.category);
      out.push('Capabilities: ' + dev.capabilities.join(', '));
      out.push('Interfaces : ' + dev.interfaces.size);
      out.push('Simulator  : PacketForge 0.1.0');
    } else if (what === 'ip' && tokens[1] === 'interface' && tokens[2] === 'brief') {
      const pick = this._portArg(tokens.slice(3), dev, 'show ip interface brief');
      if (!pick.ok) return out.concat(pick.output);
      const rows = [];
      for (const i of dev.interfaces.values()) {
        if (pick.port && i.name !== pick.port) continue;
        const ip = i.ip ? i.ip + '/' + net.prefixOf(i.mask) : 'unassigned';
        const status = i.enabled ? 'up' : 'administratively down';
        // Status is the administrator's state, Protocol is what the line is doing - the distinction
        // the two columns exist for, and the one an SVI makes because it has a line without a cable.
        const line = !i.enabled ? 'down' : (i.svi && i.lineUp === false ? 'down' : 'up');
        rows.push([i.name, ip, 'YES', i.dhcp ? 'DHCP' : 'manual', status, line]);
      }
      if (pick.port) out.push('Interface ' + pick.port + ' on ' + dev.name + ':');
      out.push.apply(out, renderTable(['Interface', 'IP-Address', 'OK?', 'Method', 'Status', 'Protocol'], rows));
    } else if (what === 'ip' && tokens[1] === 'route') {
      // `show ip route` prints the table as last computed; the instant form is handled before
      // dispatch, in `_show()`. A word that is not an instant is refused rather than ignored -
      // `show ip route at 0` used to answer for t=0 and `show ip route 0` still prints the table,
      // which reads as though the argument was understood.
      // `show ip route <dest>` asks a different question from the table: not "what is in the
      // table" but "what would this box do with this address, and why". That is the one place a
      // longest-match answer exists, so it names the covering prefix, the next hop, the distance,
      // and the candidates that lost.
      if (tokens.length > 2) {
        // A protocol word is a filter, not a destination: `show ip route ospf` asks for one
        // protocol's rows, which the full table makes you scan for. `summary` counts them, and is
        // the only place the difference between "in the table" and "installed" is a number.
        const arg = tokens.slice(2);
        const word = String(arg[0] === undefined ? '' : arg[0]).toLowerCase();
        if (LOAD_ROUTE_FILTERS[word]) return out.concat(this._routeFiltered(dev, LOAD_ROUTE_FILTERS[word], word));
        if (word === 'summary') return out.concat(this._routeSummary(dev));
        return out.concat(this._routeLookup(dev, arg));
      }
      //
      // The legend names every code the table actually uses. It used to print only
      // "C - connected, S - static", so an O or B row was real but unexplained.
      const rows = dev.routesTable();
      const present = { C: true, S: true };
      for (const r of rows) present[r.code] = true;
      const names = { C: 'connected', S: 'static', O: 'OSPF', B: 'BGP' };
      const order = ['C', 'S', 'O', 'B'];
      const legend = [];
      for (const c of order) if (present[c]) legend.push(c + ' - ' + names[c]);
      for (const c of Object.keys(present)) {
        if (order.indexOf(c) === -1) legend.push(c + ' - other');
      }
      out.push('Codes: ' + legend.join(', '));
      // The note only appears when something is shadowed: on a table where every row forwards,
      // explaining that the unmarked ones do not would be inventing a distinction.
      if (rows.some(function (r) { return !r.installed; })) {
        out.push('* = installed (this row is what forwards); an unmarked row loses on administrative distance');
      }
      // The mask is part of the destination, as on a real box: `10.0.1.0/24` is one token an
      // operator copies. The `Ad` column explains the mark: a static route (1) beats an OSPF
      // route (110) for the same prefix, so the unmarked row is not a second live path.
      out.push.apply(out, renderTable(['*', 'Prefix', 'AD', 'Gateway', 'Interface'],
        rows.map(function (r) {
          return [(r.installed ? '*' : ''), r.code + ' ' + r.dest + '/' + net.prefixOf(r.mask),
            String(r.ad === undefined ? '-' : r.ad), r.gw, r.iface];
        }), 2));
    } else if (what === 'ip' && tokens[1] === 'bgp') {
      out.push.apply(out, this._showBgp(tokens.slice(2)));
    } else if (what === 'ip' && tokens[1] === 'ospf') {
      out.push.apply(out, this._showOspf(tokens.slice(2)));
    } else if (what === 'dns' || (what === 'ip' && tokens[1] === 'dns')) {
      out.push.apply(out, this._showDns());
    } else if (what === 'ip' && tokens[1] === 'nat') {
      out.push.apply(out, this._showNat(tokens.slice(2)));
    } else if (what === 'ip' && tokens[1] === 'dhcp') {
      out.push.apply(out, this._showDhcp(tokens.slice(2)));
    } else if (what === 'dhcp') {
      out.push.apply(out, this._showDhcp(tokens.slice(1)));
    } else if (what === 'scion') {
      out.push.apply(out, this._showScion(tokens.slice(1)));
    } else if (what === 'ipv6' && tokens[1] === 'nd') {
      out.push.apply(out, this._showIpv6Nd());
    } else if (what === 'ipv6' && tokens[1] === 'route') {
      out.push.apply(out, this._showIpv6Route(tokens.slice(2)));
    } else if (what === 'ipv6' && tokens[1] === 'interface') {
      out.push.apply(out, this._showIpv6Interface(tokens.slice(2)));
    } else if (what === 'power' && tokens[1] === 'inline') {
      const pick = this._portArg(tokens.slice(2), dev, 'show power inline');
      if (!pick.ok) return out.concat(pick.output);
      out.push.apply(out, this._showPowerInline(pick.port));
    } else if (what === 'flows') {
      out.push.apply(out, this._showFlows(tokens.slice(1)));
    } else if (what === 'logging') {
      out.push.apply(out, this._showLogging(tokens.slice(1)));
    } else if (what === 'clock') {
      out.push.apply(out, this._showClock());
    } else if (what === 'lldp') {
      // The table that answers "what is plugged into this port" - and it is honest,
      // because it is filled from LLDPDUs that actually crossed the link rather than
      // from the topology file. An empty table means nothing has announced itself.
      const pick = this._portArg(tokens.slice(2), dev, 'show lldp neighbors');
      if (!pick.ok) return out.concat(pick.output);
      out.push('LLDP neighbours on ' + dev.name + ':');
      let rows = Array.from(dev.lldp.entries());
      if (pick.port) {
        rows = rows.filter(function (r) { return r[0] === pick.port; });
        if (!rows.length) {
          // "Nothing has announced itself on this port" and "nothing anywhere" are different facts,
          // and the second is not an answer to a question about one port.
          return out.concat(['  (none - no LLDP has been heard on ' + pick.port + ')',
            '  A neighbour appears here once an LLDPDU from it has crossed the link.']);
        }
      }
      if (!rows.length) {
        out.push('  (none - no LLDP has been heard on any port)');
      } else {
        out.push.apply(out, renderTable(['Neighbour', 'Local port', 'Port ID', 'Mgmt address'],
          rows.map(function (r) {
            const port = r[0];
            const nb = r[1];
            return [nb.systemName || '?', port, nb.portId || '?', nb.mgmtIp || '-'];
          }), 2));
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
    } else if (what === 'vrrp') {
      out.push.apply(out, this._showVrrp());
    } else if (what === 'vlan') {
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
      const vlanRows = [];
      for (const id of keys) {
        if (id === 'all') {
          vlanRows.push([1,
            (dev.config.vlans && dev.config.vlans[1] && dev.config.vlans[1].name) || 'default',
            'active', byVlan.get(id).join(', ')]);
          continue;
        }
        const name = (dev.config.vlans && dev.config.vlans[id] && dev.config.vlans[id].name) || ('VLAN' + String(id).padStart(4, '0'));
        vlanRows.push([id, name, 'active', byVlan.get(id).join(', ')]);
      }
      out.push.apply(out, renderTable(['VLAN', 'Name', 'Status', 'Ports'], vlanRows));
    } else if (what === 'spanning-tree') {
      const pick = this._portArg(tokens.slice(1), dev, 'show spanning-tree');
      if (!pick.ok) return out.concat(pick.output);
      const st = dev.stp || { states: {}, roles: {}, blocked: new Set() };
      const names = Object.keys(st.states || {}).sort().filter(function (n) {
        return !pick.port || n === pick.port;
      });
      if (pick.port && !names.length) {
        // A port that is not bridged (no loop, or shut) is a legitimate answer, but "not in any loop"
        // and "no such port" must not look the same - the latter was already refused above.
        return out.concat(['% ' + pick.port + ' is not running spanning tree on ' + dev.name,
          '% It is not part of any L2 loop - see "show spanning-tree" for the ports that are']);
      }
      out.push('Spanning tree enabled protocol ieee');
      if (!names.length) {
        out.push('  No bridged ports: this device is not part of any L2 loop.');
      } else {
        const stRows = names.map(function (n) {
          const role = (st.roles || {})[n] || '-';
          return [n, role, st.states[n] +
            (st.states[n] === 'blocking' ? '   (traffic dropped)' : '')];
        });
        out.push.apply(out, renderTable(['Port', 'Role', 'State'], stRows));
      }
    } else if (what === 'etherchannel') {
      const lags = dev.config.lags || {};
      const ids = Object.keys(lags).sort();
      if (!ids.length) {
        out.push('% No link aggregation groups configured');
      } else {
        const lagRows = ids.map(function (id) {
          const l = lags[id] || {};
          const members = (l.members || []).map(function (m) {
            const blocked = dev.stp && dev.stp.blocked && dev.stp.blocked.has(m);
            return m + '(' + (blocked ? 'D' : 'P') + ')';
          });
          return [id, l.mode || 'static', members.join(' ')];
        });
        out.push.apply(out, renderTable(['Group', 'Protocol', 'Ports'], lagRows));
      }
    } else if (what === 'arp') {
      // The header promised an Interface column that no row ever filled. The ARP cache
      // is ip -> mac (nothing else is needed to answer), so the port is derived from the
      // topology at display time - the local port whose link leads to whoever owns the
      // address - and says "-" rather than lying when there is no such link.
      const simRef = this.sim;
      const ifaceFor = function (ip) {
        const owner = (simRef && simRef.ownerOfIp) ? simRef.ownerOfIp(ip) : null;
        if (!owner) return '-';
        if (owner.id === dev.id) return '(self)';
        for (const i of dev.interfaces.values()) {
          if (i.peer && i.peer.deviceId === owner.id) return i.name;
        }
        return '-';
      };
      const pick = this._portArg(tokens.slice(1), dev, 'show arp');
      if (!pick.ok) return out.concat(pick.output);
      const arpRows = [];
      for (const [ip, mac] of dev.arp.entries()) {
        const onPort = ifaceFor(ip);
        // Filtering by port is only honest for entries whose port is known: an entry behind a switch
        // shows `-`, and folding it into another port's answer would invent a fact.
        if (pick.port && onPort !== pick.port) continue;
        arpRows.push(['Internet', ip, '-', mac, onPort]);
      }
      if (pick.port) out.push('ARP entries on ' + pick.port + ' at ' + dev.name + ':');
      out.push.apply(out, renderTable(['Protocol', 'Address', 'Age (min)', 'Hardware Addr', 'Interface'], arpRows));
      if (pick.port && !arpRows.length) {
        out.push('  (none - no cached address resolves to this port)');
      }
    } else if (what === 'mac' && tokens[1] === 'address-table') {
      const pick = this._portArg(tokens.slice(2), dev, 'show mac address-table');
      if (!pick.ok) return out.concat(pick.output);
      const rows = [];
      for (const [mac, iface] of dev.macTable.entries()) rows.push([1, mac, iface]);
      for (const [vid, table] of (dev.macTables || new Map()).entries()) {
        for (const [mac, iface] of table.entries()) rows.push([vid, mac, iface]);
      }
      rows.sort(function (a, b) { return (a[0] - b[0]) || String(a[1]).localeCompare(String(b[1])); });
      if (pick.port) {
        const mine = rows.filter(function (r) { return r[2] === pick.port; });
        out.push('Mac address table on ' + pick.port + ' at ' + dev.name + ':');
        out.push.apply(out, renderTable(['Vlan', 'Mac Address', 'Type', 'Ports'],
          mine.map(function (r) { return [r[0], r[1], 'DYNAMIC', r[2]]; })));
        if (!mine.length) out.push('  (none - nothing has been learned on this port)');
        return out;
      }
      out.push.apply(out, renderTable(['Vlan', 'Mac Address', 'Type', 'Ports'],
        rows.map(function (r) { return [r[0], r[1], 'DYNAMIC', r[2]]; })));
    } else if ((what === 'interfaces' || what === 'interface') &&
               (tokens[1] === 'transceiver' || tokens[1] === 'transceivers')) {
      out.push.apply(out, this._showTransceiver(tokens[2]));
    } else if (what === 'interfaces' || what === 'interface') {
      // `show interfaces ether1` used to ignore the port and print every port on the box,
      // which is worse than a refusal: it looks like an answer. The token goes through the
      // same resolver the config parser uses, so any spelling of the port works.
      let only = null;
      if (tokens[1] !== undefined
          && String(tokens[1]).toLowerCase() === 'counters') {
        // This used to be refused with a pointer to a command that had no counters in it. It is a
        // command now, and the pointer is gone because it is no longer needed.
        const pick = this._portArg(tokens.slice(2), dev, 'show interfaces counters');
        if (!pick.ok) return out.concat(pick.output);
        if (!this.sim) return ['% No simulation is running, so nothing has been counted'];
        let rows = this.sim.portStats(dev.id);
        if (pick.port) rows = rows.filter(function (r) { return r.iface === pick.port; });
        out.push('Interface counters on ' + dev.name + (pick.port ? ' for ' + pick.port : '') + ':');
        if (!rows.length) {
          return out.concat(['  (no port has carried a frame since this lab started)',
            '  Counters are cumulative from the lab\'s start: ask again after a ping, or move traffic.']);
        }
        out.push.apply(out, renderTable(['Port', 'Rx packets', 'Rx bytes', 'Tx packets', 'Tx bytes', 'Drops'],
          rows.map(function (r) { return [r.iface, r.rx, r.rxBytes, r.tx, r.txBytes, r.drops]; }), 0));
        const totals = rows.reduce(function (a, r) {
          a.rx += r.rx; a.tx += r.tx; a.drops += r.drops; return a;
        }, { rx: 0, tx: 0, drops: 0 });
        out.push('');
        out.push(plural(rows.length, 'port') + ' counted: ' + totals.rx + ' in, ' + totals.tx +
          ' out, ' + totals.drops + ' dropped');
        return out;
      }
      if (tokens[1] !== undefined) {
        only = resolvePortName(dev, tokens[1]);
        if (!only) {
          // A word that looks like an IOS subcommand but is not a port reads as a typo otherwise:
          // `show interfaces counters` answered "No interface named counters", which is true and
          // sends the operator looking for a port by that name.
          const KNOWN_SUB = ['counters', 'status', 'summary', 'brief', 'description', 'switchport'];
          if (KNOWN_SUB.indexOf(String(tokens[1]).toLowerCase()) !== -1) {
            return ['% "show interfaces ' + tokens[1] + '" is not a command here',
              '% Per-port counters and status are in "show interfaces <port>"',
              '% The list of ports is in "show ip interface brief"'];
          }
          return ['% No interface named ' + tokens[1] + ' on ' + (dev.name || dev.id),
            '% Try "show ip interface brief" for the ports this device has'];
        }
      }
      for (const i of dev.interfaces.values()) {
        if (only && i.name !== only) continue;
        out.push(i.name + ' (' + i.type + ', ' + i.speed + '), MAC ' + i.mac);
        out.push('  status: ' + (i.enabled ? 'up' : 'administratively down') + (i.description ? ', desc: ' + i.description : ''));
        out.push('  ip: ' + (i.ip ? i.ip + '/' + net.prefixOf(i.mask) : 'unassigned') + (i.dhcp ? ' (dhcp)' : ''));
        if (i.svi) {
          // "peer: disconnected" is true of a logical port and means nothing: an SVI has no socket to
          // be plugged into. The facts worth printing are which VLAN it holds the address in, and
          // whether that VLAN is carrying anything - an SVI is up by VLAN membership, not by a cable.
          out.push('  vlan: ' + (Number(i.vlan && i.vlan.accessVlan) || 1) + ' (access)');
          out.push('  line protocol: ' + (i.enabled === false ? 'down (administratively down)'
            : (i.lineUp === false ? 'down (' + (i.lineStateReason || 'no active port in its VLAN') + ')'
              : 'up')));
          continue;
        }
        if (this.sim) {
          // The three lines an operator opens this command for. Counted by the simulator where the
          // frames actually moved, not derived from the event log - the log is a history and this is
          // a total.
          const st = this.sim.portStats(dev.id, i.name);
          out.push('  input : ' + plural(st.rx, 'packet') + ', ' + plural(st.rxBytes, 'byte'));
          out.push('  output: ' + plural(st.tx, 'packet') + ', ' + plural(st.txBytes, 'byte'));
          out.push('  drops : ' + st.drops + dropReasons(st.reasons));
        }
        out.push('  peer: ' + (i.peer
          ? ((this.sim && this.sim.topo.getDevice(i.peer.deviceId) || {}).name || i.peer.deviceId) +
            '/' + i.peer.iface
          : 'disconnected'));
      }
    } else if (what === 'startup-config' || what === 'start') {
      const pick = this._portArg(tokens.slice(1), dev, 'show startup-config');
      if (!pick.ok) return out.concat(pick.output);
      out.push.apply(out, this._showStartupConfig(dev, pick.port));
    } else if (what === 'running-config' || what === 'run') {
      // The argument used to be dropped on the floor: `show running-config interface Gi0/0` printed
      // the whole configuration, and so did `show running-config bogus` - an answer that looks like an
      // answer to the question asked. One port narrows it; anything else is refused by name.
      const pick = this._portArg(tokens.slice(1), dev, 'show running-config');
      if (!pick.ok) return out.concat(pick.output);
      if (!pick.port) {
        out.push.apply(out, this._runningConfigLines(dev));
      } else {
        out.push('! PacketForge running-config, interface ' + pick.port);
        out.push.apply(out, this._configBlock(this._runningConfigLines(dev), pick.port));
      }
    } else {
      out.push('% Invalid show command: ' + (tokens.join(' ') || '(empty)'));
    }
    return out;
  }

  // NAT has no CLI verb - rules come from the topology - so these two shows are
  // the only way to see what the data path actually did. Translations use the
  // formatter the NAT module already carried for this purpose (same column order
  // as IOS, and the same entry the packet path wrote), so this is the run's own
  // answer rather than a second opinion. Statistics answer the other question:
  // is it configured at all, and is anything hitting it.
  _showNat(tokens) {
    const dev = this.device;
    const what = String(tokens[0] || '').toLowerCase();
    const table = this.sim ? this.sim._natTableOf(dev) : natLib.createNatTable();
    const rules = Array.isArray(table.rules) ? table.rules : [];
    const translations = Array.isArray(table.translations) ? table.translations : [];

    if (what === 'statistics') {
      if (!rules.length) {
        return ['NAT statistics on ' + dev.name + ':',
          '  (no rules - NAT is configured from the topology, not this CLI)'];
      }
      const byType = {};
      for (const r of rules) {
        const t = String((r && r.type) || 'any').toLowerCase();
        byType[t] = (byType[t] || 0) + 1;
      }
      const kinds = Object.keys(byType).sort().map(function (t) {
        return t + ' ' + byType[t];
      }).join(', ');
      let hits = 0;
      let dynamic = 0;
      for (const e of translations) {
        if (typeof e.hits === 'number') hits += e.hits;
        if (String(e.type) !== 'static') dynamic++;
      }
      return ['NAT statistics on ' + dev.name + ':',
        '  ' + pad('rules', 22) + rules.length + '  (' + kinds + ')',
        '  ' + pad('translations', 22) + translations.length,
        '  ' + pad('dynamic entries', 22) + dynamic,
        '  ' + pad('hits', 22) + hits];
    }

    if (what && what !== 'translations') {
      return ['% Unknown nat show: show ip nat ' + tokens[0],
        '% Try: show ip nat translations | statistics'];
    }

    const out = ['NAT translations on ' + dev.name + ':'];
    if (!translations.length) {
      out.push(rules.length
        ? '  (none yet - ' + rules.length + ' rule' + (rules.length === 1 ? '' : 's') +
          ' configured, but no traffic has been translated)'
        : '  (none - no NAT rules; NAT is configured from the topology)');
      return out;
    }
    // The rows come from nat.js and the layout from table.js, so this table cannot
    // drift from the formatter the API and the UI use - they are the same rows.
    out.push.apply(out, renderTable(natLib.TABLE_COLUMNS, natLib.translationRows(table)));
    return out;
  }

  // `flow open` / `flow close` drive the transport model from the console.
  //
  // Until now a conversation could only be started from the UI or the API, which
  // left the strangest hole in the command set: the one thing the engine models in
  // real detail - a three-way handshake, MSS-sized segments, cumulative ACKs, a
  // four-way close - was the one thing a console user could not trigger and then
  // read back with `show flows`. The refusal path matters as much as the success
  // path, so a refused open prints the code and the reason the data path gave,
  // not a generic failure.
  _flowCommand(tokens) {
    const sub = String(tokens[0] || '').toLowerCase();
    if (!this.sim) return ['% No simulator attached to this session'];
    if (sub === 'close') return this._flowClose(tokens.slice(1));
    if (sub !== 'open') {
      return ['% Usage: flow open <dst-ip> [port <n>] [bytes <n>] [proto tcp|udp] [sport <n>]',
        '%        flow close <flow-id>',
        '%        show flows   (to read the table)'];
    }

    const args = tokens.slice(1);
    const typedDst = args[0];
    if (!typedDst) return ['% Incomplete command: flow open <dst-ip> [port <n>] ...'];
    const resolved = this._resolveHost(typedDst, 'destination');
    if (!resolved.ok) return [resolved.message];
    const dst = resolved.ip;

    let port = 80;
    let bytes = 1000;
    let proto = 'tcp';
    let sport = null;
    let atMs = null;
    const num = function (text) {
      if (!/^\d+$/.test(String(text))) return null;
      return Number(text);
    };
    for (let i = 1; i < args.length; i++) {
      const key = String(args[i]).toLowerCase();
      const val = args[i + 1];
      if (key === 'port' || key === 'bytes' || key === 'sport' || key === 'at') {
        if (key === 'at') {
          const when = parseInstant(val);
          if (!when.ok) return ['% Invalid instant: ' + (val === undefined ? '(none)' : String(val))];
          atMs = when.atMs;
          i += 1;
          continue;
        }
        const n = num(val);
        if (n === null) return ['% ' + key + ' needs a number (got ' + String(val) + ')'];
        if (key === 'port') {
          if (n < 1 || n > 65535) return ['% port out of range: ' + n];
          port = n;
        } else if (key === 'sport') {
          if (n < 1 || n > 65535) return ['% sport out of range: ' + n];
          sport = n;
        } else {
          bytes = n;
        }
        i += 1;
      } else if (key === 'proto') {
        const p = String(val || '').toLowerCase();
        if (p !== 'tcp' && p !== 'udp') return ['% proto must be tcp or udp (got ' + String(val) + ')'];
        proto = p;
        i += 1;
      } else {
        return ['% Unknown keyword: ' + args[i],
          '% Usage: flow open <dst-ip> [port <n>] [bytes <n>] [proto tcp|udp] [sport <n>] [at <ms>]'];
      }
    }

    const res = this.sim.openFlow({
      proto: proto,
      srcDevice: this.device.id,
      dstIp: dst,
      dstPort: port,
      bytes: bytes,
      srcPort: sport === null ? undefined : sport,
      atMs: atMs === null ? undefined : atMs
    });
    if (!res.ok) {
      const out = ['% flow refused (' + res.code + '): ' + res.reason];
      // "no response" and "the election has not finished" look identical from the
      // console, so name the process that would have made it work - the same
      // courtesy `traceroute` pays when a hop has no route yet.
      const waiting = (this.sim._stillConverging ? this.sim._stillConverging() : []).map(function (e) {
        return e.process + ' on ' + (e.device && e.device.name ? e.device.name : '?') +
          ' still converging (ready at ' + e.readyAtMs + ' ms)';
      });
      if (waiting.length) {
        out.push('% yet: ' + waiting.slice(0, 3).join(', ') +
          (waiting.length > 3 ? ' (and ' + (waiting.length - 3) + ' more)' : ''));
        out.push('% try again after that, or ask at an instant with "at <ms>" ' +
          '(and "at converged" to go back)');
      } else {
        out.push('% the timeline says why - try show flows, or ping ' + dst);
      }
      return out;
    }

    const rec = res.flow;
    const out = ['Flow ' + rec.id + ' opened: ' + rec.proto + ' ' + rec.srcIp + ':' + rec.srcPort +
      ' -> ' + rec.dstIp + ':' + rec.dstPort + ', ' + rec.state +
      (atMs === null ? '' : '  (at ' + instantLabel(atMs) + ')')];
    let detail = '  ' + rec.bytes + ' bytes in ' + rec.segments + ' segment' +
      (rec.segments === 1 ? '' : 's') + ', ' + rec.packets + ' packet' +
      (rec.packets === 1 ? '' : 's') + ' on the wire';
    if (rec.mss) detail += ', MSS ' + rec.mss + (rec.mtu ? ' (MTU ' + rec.mtu + ')' : '');
    out.push(detail);
    if (rec.stalled) {
      out.push('  % stalled at segment ' + rec.stalled.segment + ': ' + rec.stalled.bytesSent +
        ' bytes sent, ' + rec.stalled.bytesAcked + ' acknowledged - nothing retransmits here');
    }
    out.push('  (show flows ' + rec.id + ' for the record)');
    return out;
  }

  _flowClose(args) {
    const id = String(args[0] || '');
    if (!id) return ['% Incomplete command: flow close <flow-id>'];
    const res = this.sim.closeFlow(id);
    if (!res.ok) return ['% ' + res.reason];
    const rec = res.flow;
    const tail = res.already ? ' (already closed)'
      : res.detached ? ' (source device is gone; the record was retired)' : '';
    return ['Flow ' + rec.id + ' closed: ' + rec.state + ', ' + rec.bytesDelivered +
      ' of ' + rec.bytes + ' bytes delivered' + tail];
  }

  // ---------------------------------------------------------------------
  // show logging / show clock - why did it fail, and when was "now"
  // ---------------------------------------------------------------------
  //
  // Every protocol in this lab writes events: 25 separate drop sites, forwards, STP blocks, VLAN
  // drops, PoE denials, DHCP exchanges, OSPF/BGP state changes, SCION hops, SLAAC refusals. Nothing
  // read them. So the console could say *that* a ping failed and never *why* - the answer was in
  // `sim.events` the whole time, reachable only from a test.
  //
  // This is the door. It is deliberately one command rather than a per-protocol show, because the
  // question an operator asks is "what happened", not "what did DHCP think".
  _showLogging(args) {
    const events = (this.sim && this.sim.events) || [];
    let type = null;
    let deviceName = null;
    let lastN = null;
    let summary = false;
    const seenTypes = this._loggingTypes(events);
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === 'summary') {
        summary = true;
      } else if (a === 'last') {
        lastN = Number(args[++i]);
        if (!Number.isFinite(lastN) || lastN <= 0 || Math.floor(lastN) !== lastN) {
          return ['% show logging last <n> takes a positive whole number of events'];
        }
      } else if (a === 'device' || a === 'dev') {
        const wanted = args[++i];
        if (wanted === undefined) return ['% show logging device <name> needs a device name'];
        const found = this._deviceByName(wanted);
        if (!found) return ['% No device named "' + wanted + '"'];
        deviceName = found.name;
      } else if (a[0] === '-') {
        return ['% Unknown option "' + a + '"'];
      } else if (type === null) {
        // A bare word is an event type: `show logging drop` is the common case.
        if (seenTypes.indexOf(a) === -1) {
          return ['% No events of type "' + a + '" in this lab',
            '% Types seen: ' + (seenTypes.join(', ') || '(none)')];
        }
        type = a;
      } else {
        return ['% Unexpected argument "' + a + '"'];
      }
    }

    const topo = this.sim && this.sim.topo;
    const nameOf = function (id) {
      if (!id) return '-';
      const d = topo && topo.getDevice ? topo.getDevice(id) : null;
      return d ? d.name : String(id);
    };
    // A `frame` has no single device - it is on a wire between two - so the Device column reports the
    // pair rather than a bare `-` for eleven rows out of twenty-six.
    let rows = events.map(function (e, idx) {
      const dev = e.dev ? nameOf(e.dev)
        : (e.from && e.to ? nameOf(e.from) + ' -> ' + nameOf(e.to) : '-');
      return { idx: idx + 1, ev: e, dev: dev };
    });
    if (type) rows = rows.filter(function (r) { return r.ev.type === type; });
    if (deviceName) rows = rows.filter(function (r) { return r.dev === deviceName; });

    if (summary) return this._loggingSummary(events, rows, { type: type, deviceName: deviceName });

    const total = rows.length;
    if (lastN !== null) rows = rows.slice(-lastN);

    const scope = (type ? type + ' events' : 'events') +
      (deviceName ? ' on ' + deviceName : '');
    if (!total) {
      const why = events.length === 0
        ? 'the log is empty - nothing has run yet in this lab'
        : 'none of the ' + events.length + ' recorded events match';
      return ['No ' + scope + ': ' + why,
        events.length === 0
          ? 'Send a packet (`ping <dst>`) or run `converge`, then ask again.'
          : 'Try `show logging summary` for the types that are present.'];
    }

    const out = [];
    out.push('Event log (' + (lastN !== null && lastN < total
      ? 'last ' + lastN + ' of ' + total : String(total)) + ' ' + scope +
      (events.length !== total ? ', from ' + events.length + ' in the lab' : '') + '):');
    out.push.apply(out, renderTable(['#', 'Step', 'Type', 'Device', 'Detail'],
      rows.map(function (r) {
        return [String(r.idx), String(r.ev.step === undefined ? '-' : r.ev.step),
          r.ev.type, r.dev, describeEvent(r.ev)];
      }), 2));
    return out;
  }

  // Which types exist in the log right now - used by the refusal, so a typo lists the alternatives
  // instead of only saying no.
  _loggingTypes(events) {
    const seen = [];
    for (const e of events) if (seen.indexOf(e.type) === -1) seen.push(e.type);
    return seen.sort();
  }

  _loggingSummary(events, rows, filter) {
    if (!rows.length) {
      return ['No ' + (filter.type ? filter.type + ' events' : 'events') +
        (filter.deviceName ? ' on ' + filter.deviceName : '') + ' to summarise'];
    }
    const counts = new Map();
    for (const r of rows) counts.set(r.ev.type, (counts.get(r.ev.type) || 0) + 1);
    const byType = Array.from(counts.entries()).sort(function (a, b) {
      return b[1] - a[1] || a[0].localeCompare(b[0]);
    });
    // A frame has no single device - it is on the wire between two - so it is counted separately
    // rather than listed as a pseudo-device called `PC1 -> R1`. An aggregate view that mixes devices
    // with links is the sort of table a reader stops trusting.
    const devCounts = new Map();
    let linkLevel = 0;
    for (const r of rows) {
      if (r.ev.dev) devCounts.set(r.dev, (devCounts.get(r.dev) || 0) + 1);
      else linkLevel++;
    }
    const out = [];
    out.push('Event summary (' + rows.length + ' of ' + events.length + ' events):');
    out.push.apply(out, renderTable(['Type', 'Events'],
      byType.map(function (e) { return [e[0], String(e[1])]; }), 2));
    out.push('');
    out.push('  by device:');
    out.push.apply(out, renderTable(['Device', 'Events'],
      Array.from(devCounts.entries()).sort(function (a, b) { return b[1] - a[1]; })
        .map(function (e) { return [e[0], String(e[1])]; }), 4));
    if (linkLevel) {
      out.push('    (plus ' + linkLevel + ' link-level event' + (linkLevel === 1 ? '' : 's') +
        ' with no single device - see the Device column in `show logging`)');
    }
    return out;
  }

  // The lab has no wall clock, and saying so is more useful than a plausible fake time: every
  // answer in this console is a question asked at an instant (`at <ms>`, `at converged`), and the
  // event log is ordered rather than timestamped. `Step` in `show logging` is the frame hop.
  _showClock() {
    const at = this.sim && this.sim.runAtMs;
    const out = [];
    if (Number.isFinite(at)) {
      out.push('t=' + at + ' ms  (' + (at / 1000) + ' s) - the instant this lab was asked about');
    } else {
      out.push('t=0 ms - the lab is at rest (no instant asked)');
    }
    out.push('');
    out.push('This lab has no wall clock. A question may name an instant - `ping <dst> at 5000` -');
    out.push('and it sticks until `at converged` resets it. Events are ordered, not timestamped:');
    out.push('`show logging` reports the frame step each one happened at.');
    return out;
  }

  // Flows are topology-wide state - one conversation, seen by every device on its
  // path - so, like `links`, this is a lab-wide view printed from any console.
  // The three numbers in the heading are deliberately distinct: `recorded` is what
  // is still in the table, `opened` counts the attempts that put a SYN or a
  // datagram on the wire, and `refused` counts the ones a peer or a policy turned
  // away. A refused record is deleted, so recorded < opened is normal and means
  // something happened, not that something is wrong.
  _showFlows(tokens) {
    const sim = this.sim;
    const flowLib = require('./flow');
    const state = sim ? sim.flowState : null;
    const records = flowLib.listFlows(state);
    const counters = (state && state.counters) || {};
    const nameOf = function (devId) {
      if (!devId) return '-';
      const d = sim && sim.topo ? sim.topo.getDevice(devId) : null;
      return d ? d.name : String(devId);
    };

    let opened = 0;
    let refused = 0;
    for (const devId of Object.keys(counters)) {
      opened += counters[devId].flowsOpened || 0;
      refused += counters[devId].flowsRefused || 0;
    }

    const what = String(tokens[0] || '').toLowerCase();

    if (what === 'counters') {
      const ids = Object.keys(counters);
      if (!ids.length) return ['Flow counters: none - no traffic has been offered yet'];
      const out = ['Flow counters in this lab:'];
      ids.sort(function (a, b) {
        const c = counters[a];
        const d = counters[b];
        return (d.packetsIn + d.packetsOut) - (c.packetsIn + c.packetsOut);
      });
      out.push.apply(out, renderTable(
        ['Device', 'Bytes in', 'Bytes out', 'Packets in', 'Packets out', 'Opened', 'Refused'],
        ids.map(function (devId) {
          const c = counters[devId];
          return [nameOf(devId), c.bytesIn, c.bytesOut, c.packetsIn, c.packetsOut,
            c.flowsOpened, c.flowsRefused];
        }), 2));
      return out;
    }

    if (what) {
      const rec = records.filter(function (r) { return String(r.id).toLowerCase() === what; })[0];
      if (!rec) {
        return ['% No flow ' + tokens[0] + ' in this lab',
          '% Try: show flows (for the list) or show flows counters'];
      }
      const out = ['Flow ' + rec.id + ' (' + rec.proto + '):'];
      const row = function (label, value) { return '  ' + pad(label, 14) + value; };
      out.push(row('Source', rec.srcIp + ':' + rec.srcPort + '  (' + nameOf(rec.srcDevice) + ')'));
      out.push(row('Destination', rec.dstIp + ':' + rec.dstPort + '  (' + nameOf(rec.dstDevice) + ')'));
      out.push(row('State', rec.state + (rec.closedStep === null || rec.closedStep === undefined
        ? '  (still open)' : '  (closed at step ' + rec.closedStep + ')')));
      out.push(row('Payload', rec.bytes + ' bytes in ' + rec.segments + ' segment' +
        (rec.segments === 1 ? '' : 's') + ', ' + rec.packets + ' packet' +
        (rec.packets === 1 ? '' : 's') + ' on the wire'));
      out.push(row('Delivered', rec.bytesDelivered + ' bytes'));
      if (rec.mss) out.push(row('MSS', rec.mss + (rec.mtu ? '   MTU ' + rec.mtu : '')));
      if (rec.iface) out.push(row('Egress', rec.iface));
      out.push(row('Opened', 'step ' + rec.openedStep));
      if (rec.code) out.push(row('Code', rec.code));
      if (rec.reason) out.push(row('Reason', rec.reason));
      return out;
    }

    if (!records.length) {
      return ['Flows in this lab: none' + (opened || refused
        ? ' (' + opened + ' opened, ' + refused + ' refused, no record kept)'
        : ' - nothing has been offered yet')];
    }

    records.sort(function (a, b) {
      const ao = Number(a.openedStep) || 0;
      const bo = Number(b.openedStep) || 0;
      if (ao !== bo) return ao - bo;
      return String(a.id) < String(b.id) ? -1 : 1;
    });

    const out = ['Flows in this lab (' + records.length + ' recorded, ' + opened +
      ' opened, ' + refused + ' refused):'];
    out.push.apply(out, renderTable(
      ['Id', 'Proto', 'Source', 'Destination', 'State', 'Payload', 'Segs', 'Pkts', 'Opened'],
      records.map(function (r) {
        return [r.id, r.proto, r.srcIp + ':' + r.srcPort, r.dstIp + ':' + r.dstPort,
          r.state, r.bytes, r.segments, r.packets, 'step ' + r.openedStep];
      }), 2));
    return out;
  }

  // show ip dhcp binding | show ip dhcp pool
  //
  // The bindings are the lease state the DORA exchange actually wrote, read back
  // through dhcpLib.leaseTable(), so this is the same answer the run produced and
  // not a second opinion. The client side reports the lease the device was handed.
  _showDhcp(tokens) {
    const dev = this.device;
    const dhcpLib = require('./dhcp');
    const what = String(tokens[0] || '').toLowerCase();
    const rawPools = Array.isArray(dev.config.dhcpPools) ? dev.config.dhcpPools : [];
    const pools = rawPools.map(function (p) { return dhcpLib.normalizePool(p); });
    const out = [];

    const poolOf = function (ip) {
      for (const p of pools) if (dhcpLib.ipInPool(p, ip)) return p.name;
      return '-';
    };

    if (what === 'pool' || what === 'pools') {
      if (!pools.length) return ['% ' + dev.name + ' has no DHCP pools'];
      out.push('DHCP pools on ' + dev.name + ':');
      for (const p of pools) {
        const bindings = (this.sim ? this.sim.dhcpBindings(dev.id) : []).filter(function (b) {
          return dhcpLib.ipInPool(p, b.ip);
        });
        out.push('  ' + p.name);
        out.push('    Network    : ' + p.network + ' / ' + p.mask);
        if (p.rangeStart && p.rangeEnd) out.push('    Range      : ' + p.rangeStart + ' - ' + p.rangeEnd);
        if (p.gateway) out.push('    Router     : ' + p.gateway);
        if (p.dns && p.dns.length) out.push('    DNS        : ' + p.dns.join(', '));
        if (Number.isFinite(Number(p.leaseSec)) && p.leaseSec) out.push('    Lease      : ' + p.leaseSec + 's');
        if (p.excluded && p.excluded.length) out.push('    Excluded   : ' + p.excluded.join(', '));
        const macs = Object.keys(p.reservations || {});
        for (const mac of macs) out.push('    Reserved   : ' + p.reservations[mac] + ' for ' + mac);
        // How much of the range is actually usable, so "2 in use" means something.
        let total = null;
        try {
          const rs = net.ipToInt(p.rangeStart);
          const re = net.ipToInt(p.rangeEnd);
          const span = re - rs + 1;
          if (span > 0 && span <= 4096) {
            total = 0;
            for (let n = rs; n <= re; n++) if (dhcpLib.ipInPool(p, net.intToIp(n))) total++;
          }
        } catch (e) { total = null; }
        out.push('    In use     : ' + bindings.length + (total === null ? '' : ' of ' + total));
      }
      return out;
    }

    if (what !== 'binding' && what !== 'bindings' && what !== 'lease' && what !== 'leases') {
      return ['% Usage: show ip dhcp binding | show ip dhcp pool'];
    }

    const bindings = this.sim ? this.sim.dhcpBindings(dev.id) : [];
    const held = [];
    for (const i of dev.interfaces.values()) if (i.dhcpLease) held.push(i);

    // A relay is neither a server nor a client: it holds no lease and has no pool, and the only
    // thing it can say is which ports forward requests where. Without this it answered "not a DHCP
    // server", which is true and useless.
    const relays = [];
    for (const i of dev.interfaces.values()) {
      for (const helper of (i.helperAddresses || [])) relays.push({ iface: i.name, helper: helper });
    }
    if (!bindings.length && !held.length && !pools.length && relays.length) {
      out.push('DHCP relay on ' + dev.name + ':');
      for (const r of relays) out.push('  ' + r.iface + '  ->  ' + r.helper);
      out.push('');
      out.push('Requests heard on those ports are unicast to the server, with this port\'s address');
      out.push('as giaddr so the server allocates from the right subnet.');
      return out;
    }
    if (!bindings.length && !held.length) {
      if (pools.length) {
        const out2 = ['DHCP bindings on ' + dev.name + ': (none)'];
        // "no exchange happened" and "the lease ran out" are different situations, and only one of
        // them means the lab is misconfigured.
        const gone = this._dhcpExpiredAtThisInstant();
        out2.push(gone
          ? gone + ' lease' + (gone === 1 ? '' : 's') + ' expired at this instant - the address' +
            (gone === 1 ? ' is' : 'es are') + ' back in the pool'
          : 'no client has completed an exchange');
        return out2;
      }
      return ['% ' + dev.name + ' is not a DHCP server (no pools) and holds no DHCP lease'];
    }

    if (bindings.length) {
      out.push('DHCP bindings on ' + dev.name + ':');
      out.push('  ' + pad('MAC', 20) + pad('IP', 17) + pad('Pool', 14) + 'Expires in');
      for (const b of bindings) {
        // `remainingSec` comes from the simulator's clock, which is the instant the question was
        // asked at. Reading `sim.step` here printed the packet-loop counter instead, so the column
        // said "60s" for a lease that was already two minutes old.
        const left = b.remainingSec === null || b.remainingSec === undefined
          ? Math.max(0, Number(b.expiresStep) - (this.sim ? this.sim.step : 0))
          : b.remainingSec;
        out.push('  ' + pad(b.mac, 20) + pad(b.ip, 17) + pad(poolOf(b.ip), 14) + left + 's');
      }
      const relayed = this.sim && this.sim.dhcpRelayedBindings
        ? this.sim.dhcpRelayedBindings(dev.id) : [];
      if (relayed.length) {
        out.push('');
        out.push(relayed.length + ' binding' + (relayed.length === 1 ? '' : 's') +
          ' arrived through a relay: ' +
          relayed.map(function (r) { return r.ip + ' via giaddr ' + r.giaddr; }).join(', '));
      }
      const goneNow = this._dhcpExpiredAtThisInstant();
      if (goneNow) {
        out.push('');
        out.push(goneNow + ' lease' + (goneNow === 1 ? '' : 's') +
          ' expired at this instant and ' + (goneNow === 1 ? 'is' : 'are') +
          ' no longer in the table');
      }
    }

    for (const i of held) {
      const l = i.dhcpLease;
      out.push('DHCP lease on ' + dev.name + '/' + i.name + ':');
      out.push('  IP address   : ' + l.ip + '/' + net.prefixOf(l.mask));
      out.push('  Server       : ' + l.server + '  (pool ' + l.pool + ')');
      if (l.gateway) out.push('  Gateway      : ' + l.gateway);
      // A relayed lease came from a server with no interface on this wire, so the relay is the only
      // explanation of how it was handed out - and the field that made it work (giaddr) is worth
      // showing, because it is the relay's address, not the client's.
      if (l.giaddr) {
        const relayName = this.sim && l.relayDevice
          ? ((this.sim.topo.getDevice(l.relayDevice) || {}).name || l.relayDevice) : null;
        out.push('  Relayed via  : ' + (l.relayedVia || 'relay') +
          (relayName ? ' on ' + relayName : '') + '  (giaddr ' + l.giaddr + ')');
      }
      if (l.dns && l.dns.length) out.push('  DNS          : ' + l.dns.join(', '));
      if (Number.isFinite(Number(l.leaseSec))) out.push('  Lease        : ' + l.leaseSec + 's');
      // The deadline, not just the length: a lease is the only thing in this lab that can run out,
      // and "Lease: 60s" is the same answer whenever you ask it.
      if (l.expiresStep !== undefined && this.sim) {
        const left = Math.max(0, Number(l.expiresStep) - this.sim._nowStep());
        out.push('  Expires in   : ' + left + 's' +
          (l.renewed ? '  (renewed at this instant)' : ''));
      }
    }
    return out;
  }

  // `ip helper-address <addr>` - a DHCP relay on this port.
  //
  // A DISCOVER is a broadcast, so it dies at the first router; a relay agent turns it into a unicast
  // to a server elsewhere, stamping the port's own address into giaddr so the server knows which
  // subnet to allocate from. This is the config half; `Simulator.computeDhcp()` does the relaying.
  _helperAddress(args, iface) {
    const addr = args[0];
    if (addr === undefined) return ['% Incomplete command: ip helper-address <addr>'];
    if (!this._isIpv4(addr)) return ['% Invalid helper address "' + addr + '"'];
    if (!iface.helperAddresses) iface.helperAddresses = [];
    if (iface.helperAddresses.indexOf(addr) !== -1) {
      return ['Helper address ' + addr + ' is already set on ' + iface.name];
    }
    iface.helperAddresses.push(addr);
    return ['Helper address ' + addr + ' on ' + iface.name +
      ' (DHCP requests will be relayed to it)'];
  }

  _noHelperAddress(args, iface) {
    const addr = args[0];
    const have = iface.helperAddresses || [];
    if (!have.length) return ['% No helper address on ' + iface.name];
    if (addr === undefined) {
      iface.helperAddresses = [];
      return ['Helper addresses removed from ' + iface.name];
    }
    if (!this._isIpv4(addr)) return ['% Invalid helper address "' + addr + '"'];
    if (have.indexOf(addr) === -1) {
      // Refused rather than silently clearing the port: a typo must not remove a working relay.
      return ['% No helper address ' + addr + ' on ' + iface.name +
        ' (set: ' + have.join(', ') + ')'];
    }
    iface.helperAddresses = have.filter(function (a) { return a !== addr; });
    return ['Helper address ' + addr + ' removed from ' + iface.name];
  }

  // `?` - what may follow the words typed so far.
  //
  // The list is the documented subtree, not a hand-kept one: it comes from the same parsed help forms
  // that abbreviation uses, so a completion can only ever offer a command that exists, and a command
  // becomes completable when it is documented. Values are shown as their placeholder (`<dest>`) with
  // the row's description, because "a destination goes here" is the answer to the question.
  _complete(prefix, partial) {
    const abbrev = require('./abbrev');
    const mode = this._completionMode(prefix);
    const forms = this._helpFormRows(mode);
    // Inside configuration, `do show …` is an exec command with a prefix on the front: the `do` (and
    // the `show` that follows it) belong to the door, not to the tree being searched, so they are
    // dropped before matching. Without this, `do sh ip ?` found nothing because no exec row starts
    // with `do`.
    const words = (mode !== this.mode && prefix.length && String(prefix[0]).toLowerCase() === 'do')
      ? prefix.slice(1) : prefix;
    // Walk the words one at a time, refining: an *exact* keyword match closes the position to longer
    // keywords (`show ip route` does not also mean `show ipv6 route`), and a keyword beats a value
    // slot. Without the exact-match rule the IPv6 rows leaked into `show ip route ?`, and `<dest>`
    // then carried two different descriptions - which the reader sees as "more options" beside a
    // word that has one meaning.
    let candidates = forms;
    for (let i = 0; i < words.length && candidates.length; i++) {
      const want = String(words[i]).toLowerCase();
      const step = candidates.filter(function (row) {
        const tok = row.tokens[i];
        if (tok === undefined) return false;
        if (typeof tok === 'object') return true; // a value slot accepts whatever was typed
        return tok.toLowerCase().indexOf(want) === 0;
      });
      const exact = step.filter(function (row) {
        return typeof row.tokens[i] === 'string' && row.tokens[i].toLowerCase() === want;
      });
      const keywords = step.filter(function (row) { return typeof row.tokens[i] === 'string'; });
      candidates = exact.length ? exact : (keywords.length ? keywords : step);
    }
    // An attached `?` (`sh st?`) is asking about the *word being typed*, not about what follows it.
    // The walk above has already narrowed to the commands this text can still become, so the answer
    // is the spellings of the next keyword that start with the fragment - which is what the key does
    // on a real console, and what the reader needs: `startup-config`, not a list of its options.
    if (partial) {
      const at = words.length;
      const typedStem = prefix.join(' ');
      // The stem is matched as an *abbreviation*, not as an exact word: `conf` is a prefix of both
      // `configure` and the alias `conf t`, and the exact-match narrowing above (which exists so a
      // completion list is not noisy) would keep only the alias and hide `terminal`. Every row the
      // stem can still become is a candidate for completing the fragment.
      let wide = forms;
      for (let i = 0; i < words.length && wide.length; i++) {
        const want = String(words[i]).toLowerCase();
        wide = wide.filter(function (row) {
          const tok = row.tokens[i];
          if (tok === undefined) return false;
          if (typeof tok === 'object') return true;
          return String(tok).toLowerCase().indexOf(want) === 0;
        });
      }
      const keywordRows = wide.filter(function (row) {
        const tok = row.tokens[at];
        return typeof tok === 'string' && tok.toLowerCase().indexOf(partial.toLowerCase()) === 0;
      });
      const exactRow = keywordRows.filter(function (row) {
        return String(row.tokens[at]).toLowerCase() === partial.toLowerCase();
      });
      // Every spelling that starts with the fragment is listed, not just an exact one. The exact-match
      // rule belongs to words *already chosen* (it keeps `show ip route` from dragging in `ipv6`); a
      // word being completed has the opposite need - `conf t?` must show `terminal`, and the exact
      // match there is the alias's own `t`. Exact spellings are listed first.
      const use = keywordRows;
      void exactRow;
      const meanings = new Map();
      for (const row of use) {
        const spelling = String(row.tokens[at]);
        if (!meanings.has(spelling)) meanings.set(spelling, []);
        const d = row.desc || '';
        if (d && meanings.get(spelling).indexOf(d) === -1) meanings.get(spelling).push(d);
      }
      if (!meanings.size) {
        return ['% Nothing after "' + typedStem + '" starts with "' + partial + '"',
          '% Ask ? on its own for the words that can follow it',
          '% To write a literal "?" instead of asking, end the line with \\?'];
      }
      const out = ['Completions for "' + typedStem + ' ' + partial + '" (' + meanings.size +
        ', completing "' + partial + '"):'];
      const spellings = Array.from(meanings.keys()).sort(function (a, b) {
        const ax = a.toLowerCase() === partial.toLowerCase() ? 0 : 1;
        const bx = b.toLowerCase() === partial.toLowerCase() ? 0 : 1;
        return ax - bx || a.localeCompare(b);
      });
      out.push.apply(out, renderTable(['Word', 'Meaning'], spellings.map(function (w) {
        const d = meanings.get(w);
        return [w, d.length === 1 ? d[0] : (d.length > 1 ? 'more options' : '')];
      }), 2));
      // If every command that fits agrees on what comes after the completed word, say it: the next
      // question is already answered, and asking it costs a keystroke.
      const then = new Set();
      for (const row of use) {
        const tok = row.tokens[at + 1];
        then.add(tok === undefined ? null : (typeof tok === 'object' ? '<' + tok.placeholder + '>' : String(tok)));
      }
      const followed = Array.from(then);
      if (followed.length === 1 && followed[0] !== null) {
        out.push('');
        out.push('Then: ' + followed[0]);
        if (followed[0][0] === '<') {
          out.push('A name in angle brackets is a value: type one, then ask ? again for what follows it.');
        }
      }
      return out;
    }
    const survivors = candidates;
    const typed = prefix.join(' ');
    if (!survivors.length) {
      // A trailing `?` is a question, so text that ends in one cannot be typed as text - which is
      // exactly the trap a real console has, and it needs the same way out: say so, and name it.
      return ['% No completions for "' + typed + '"',
        '% Type ? on its own for every command this mode accepts',
        '% To write a literal "?" instead of asking, end the line with \\?'];
    }
    // Group by what can come next. A label that several different commands reach is a *subtree*
    // (`show ip` continues into interface, route, bgp, ospf, nat, dhcp), so it must not borrow the
    // description of whichever row happened to come first - that made `ip` mean "address and link
    // state per port", which is one of its six children. One description means that command; several
    // mean "more options"; none means the row was undocumented, which the help sweep also forbids.
    const byLabel = new Map();
    let openEnded = false;
    for (const row of survivors) {
      const next = row.tokens[words.length];
      if (next === undefined) { openEnded = true; continue; }
      const label = typeof next === 'object' ? '<' + next.placeholder + '>' : String(next);
      if (!byLabel.has(label)) byLabel.set(label, []);
      const desc = row.desc || '';
      if (byLabel.get(label).indexOf(desc) === -1) byLabel.get(label).push(desc);
    }
    const seen = new Map();
    for (const [label, descs] of byLabel) {
      const real = descs.filter(function (d) { return d; });
      seen.set(label, real.length === 1 ? real[0] : (real.length > 1 ? 'more options' : ''));
    }
    const labels = Array.from(seen.keys()).sort(function (a, b) {
      // Keywords first, then value slots, then alphabetically - the operator is usually looking for a
      // keyword, and a `<dest>` that sorts before `route` reads like a typo.
      const av = a[0] === '<' ? 1 : 0;
      const bv = b[0] === '<' ? 1 : 0;
      return av - bv || a.localeCompare(b);
    });
    const out = [];
    if (!labels.length) {
      // Every command that fits ends at the last word typed, so there is no list to print. An empty
      // table under a header claiming completions is a broken answer; the fact is that the word is
      // already as far as it goes - and the attached form asks about the word itself, which is
      // usually what was meant.
      return ['"' + typed + '" is as far as this command goes - nothing follows it',
        '% To complete the word you are typing, put the ? against it: "' + typed + '?"'];
    }
    out.push('Completions for "' + typed + '" (' + labels.length +
      (openEnded ? ', and this form ends here' : '') + '):');
    // When every completion belongs to the same command row, its description belongs in the header
    // rather than eight times beside eight spellings of the same thing:
    //   `show ip route ?` is one command with eight endings, not eight commands.
    const meanings = [];
    for (const label of labels) {
      const m = seen.get(label) || '';
      if (meanings.indexOf(m) === -1) meanings.push(m);
    }
    if (meanings.length === 1 && meanings[0]) {
      out.push('  ' + meanings[0]);
      out.push('');
      // `Next:` names the list explicitly: a bare line of comma-separated words under a description
      // reads like another sentence, and the console is not the place to make a reader guess which
      // line is the answer.
      out.push('  Next: ' + labels.join(', '));
      if (labels.some(function (l) { return l[0] === '<'; })) {
        out.push('');
        out.push('Names in angle brackets are values: type one, then ask ? again for what follows it.');
      }
      return out;
    }
    out.push.apply(out, renderTable(['Next', 'Meaning'], labels.map(function (label) {
      return [label, seen.get(label) || ''];
    }), 2));
    if (labels.some(function (l) { return l[0] === '<'; })) {
      out.push('');
      out.push('Names in angle brackets are values: type one, then ask ? again for what follows it.');
    }
    return out;
  }

  // Which tree a `?` should be answered from - `do show …` and `show …` defer to the exec tree, the
  // same way abbreviation does, so the two commands never disagree about the shape of the CLI.
  _completionMode(prefix) {
    const first = String(prefix[0] || '').toLowerCase();
    if (first === 'do' && prefix.length > 1) {
      return this._completionMode(prefix.slice(1));
    }
    if (this.mode === MODE_EXEC || this.mode === MODE_ENABLE) return MODE_ENABLE;
    if (first === 'show' || first.indexOf('sh') === 0) return MODE_ENABLE;
    return this.mode;
  }

  // Parsed help rows (with descriptions) per mode, cached like the plain forms.
  _helpFormRows(mode) {
    if (!this._helpRowCache) this._helpRowCache = new Map();
    if (this._helpRowCache.has(mode)) return this._helpRowCache.get(mode);
    const saved = this.mode;
    this.mode = mode;
    let rows;
    try {
      rows = this._help();
    } finally {
      this.mode = saved;
    }
    const parsed = require('./abbrev').parseFormsWithDesc(rows);
    this._helpRowCache.set(mode, parsed);
    return parsed;
  }

  // Which mode's help a typed line should be expanded against. `do show …` inside configuration is
  // the exception: the tail is an *exec* command, so it is expanded against the exec forms, which is
  // what makes `do sh ip int br` work rather than only the first word of it.
  _expandAbbrev(tokens) {
    const abbrev = require('./abbrev');
    const exec = this.mode === MODE_EXEC || this.mode === MODE_ENABLE;
    let forms = this._helpForms(this.mode);
    if (!exec && tokens[0] === 'do') {
      const tail = tokens.slice(1);
      if (!tail.length) return null;
      const res = abbrev.expand(tail, this._helpForms(MODE_ENABLE));
      if (!res) return null;
      return res.tokens ? { tokens: ['do'].concat(res.tokens) } : res;
    }
    if (tokens[0] === 'show' || (tokens[0] && tokens[0].toLowerCase().indexOf('sh') === 0)) {
      // `show <what>` defers to the exec tree for everything after `show`.
      forms = this._helpForms(MODE_ENABLE);
    }
    return abbrev.expand(tokens, forms);
  }

  // Parsed help forms per mode, cached: the help text is the command surface, so a command is
  // abbreviatable exactly when it is documented.
  _helpForms(mode) {
    if (!this._helpFormCache) this._helpFormCache = new Map();
    if (this._helpFormCache.has(mode)) return this._helpFormCache.get(mode);
    const saved = this.mode;
    this.mode = mode;
    let rows;
    try {
      rows = this._help();
    } finally {
      this.mode = saved;
    }
    const forms = require('./abbrev').parseForms(rows);
    this._helpFormCache.set(mode, forms);
    return forms;
  }

  // A port argument, resolved the same way in every show command: any spelling the config parser
  // accepts, and an unknown name refused *by name* instead of ignored. Five commands added after the
  // original `show interfaces <port>` fix had the same defect that fix was for - they took the port,
  // dropped it, and printed the whole table, which reads as an answer about one port and is not.
  _portArg(args, dev, what) {
    const hadKeyword = (args || []).some(function (a) {
      return String(a).toLowerCase() === 'interface';
    });
    const rest = (args || []).filter(Boolean).filter(function (a) {
      return String(a).toLowerCase() !== 'interface';
    });
    if (!rest.length) {
      // `interface` on its own is a truncated command, not an absent argument: answering it with the
      // whole table is the same silent-ignore this helper exists to prevent, one keystroke earlier.
      if (hadKeyword) {
        return {
          ok: false,
          output: ['% ' + what + ' needs a port after "interface"',
            '% Try "show ip interface brief" for the ports this device has']
        };
      }
      return { ok: true, port: null };
    }
    if (rest.length > 1) {
      return {
        ok: false,
        output: ['% ' + what + ' takes one port, not "' + rest.join(' ') + '"',
          '% Try "show ip interface brief" for the ports this device has']
      };
    }
    const port = resolvePortName(dev, rest[0]);
    if (!port) {
      return {
        ok: false,
        output: ['% No interface named ' + rest[0] + ' on ' + (dev.name || dev.id),
          '% Try "show ip interface brief" for the ports this device has']
      };
    }
    return { ok: true, port: port };
  }

  // Case-insensitive device lookup, for commands that take a device name rather than an address.
  _deviceByName(name) {
    const wanted = String(name).toLowerCase();
    if (!this.sim || !this.sim.topo) return null;
    for (const dev of this.sim.topo.devices.values()) {
      if (String(dev.name).toLowerCase() === wanted) return dev;
    }
    return null;
  }

  // Digits-and-dots that actually parse. `net.ipToInt` throws on nonsense, so it is not a validator.
  _isIpv4(text) {
    const s = String(text === undefined ? '' : text);
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(s)) return false;
    try { net.ipToInt(s); return true; } catch (e) { return false; }
  }

  // How many leases died at the instant being asked about, if any. The simulator records the step
  // it expired leases at, because a second refresh at the same instant finds nothing left to expire
  // and the explanation must not vanish when the table is re-rendered.
  _dhcpExpiredAtThisInstant() {
    const rec = this.sim && this.sim.dhcpExpired;
    if (!rec || typeof rec !== 'object') return 0;
    if (!this.sim || typeof this.sim._nowStep !== 'function') return 0;
    return rec.step === this.sim._nowStep() ? rec.count : 0;
  }

  // show interfaces transceiver [<port>]
  //
  // Everything that decides whether a link can exist is physical: the cage, the medium
  // that mates with it, the rate the two ends agree on, and whether the cable is longer
  // than the optic can drive. All of it is computed when the cable is made - and then
  // thrown away. `validation.js` refuses a bad mate outright, but an over-long cable is
  // only a warning (`W_DISTANCE`), so a lab can hold a link that will never work and no
  // command said so. This reports the numbers the verdict was made from.
  // A transceiver goes in a module bay, and a bay is a cage that mates with a removable
  // module. That is not the same as "not copper": an antenna, a coax spur and a console
  // socket are all non-copper cages with nothing to plug in. The test is what the cage
  // can carry - fibre or an active optical cable - or a catalogued optic for it.
  _isModuleBay(iface) {
    if (iface && iface.svi) return false;   // a logical port has no bay to report
    const cage = iface.hardware && iface.hardware.cage;
    if (!cage) return false;
    const mediaLib = require('./media');
    const opticalLib = require('./optical');
    // Families that are a fixed socket or a fixed lead: nothing is plugged into them.
    // Everything else - fiber, fibre-channel, dac - is a module in a bay. Naming the
    // five non-bays rather than the two bays matters: Fibre Channel media report their
    // family as `fibre-channel`, and a twinax DAC reports `dac`, and both are modules.
    const FIXED = /^(copper|coax|console|wireless|dsl|powerline)$/i;
    const allowed = (iface.hardware.media || [])
      .map(function (id) { return mediaLib.mediaById(id); })
      .filter(Boolean);
    if (allowed.some(function (m) { return !FIXED.test(String(m.family || '')); })) return true;
    return (opticalLib.transceiversForCage(cage) || []).length > 0;
  }

  _showTransceiver(only) {
    const dev = this.device;
    const mediaLib = require('./media');
    const opticalLib = require('./optical');
    const topo = this.sim ? this.sim.topo : null;
    const out = [];

    // The port token goes through the engine's own resolver, so the console spelling works
    // here exactly as it does in config mode: `interface ether1` and `ether1` in a show
    // command are the same socket, and a panel name is not the only legal spelling.
    const typed = only ? String(only) : null;
    const wanted = typed ? resolvePortName(dev, typed) : null;
    const ports = [];
    for (const i of dev.interfaces.values()) {
      if (!this._isModuleBay(i)) continue;
      if (typed && i.name !== wanted) continue;
      ports.push(i);
    }
    // An unresolvable name is not "show me everything": it resolves to nothing, and
    // printing every bay would answer a question nobody asked.
    if (!ports.length) {
      const bays = [];
      for (const i of dev.interfaces.values()) {
        if (this._isModuleBay(i)) bays.push(i.name);
      }
      return [typed
        ? '% No transceiver port named ' + typed + ' on ' + (dev.name || dev.id) +
          (bays.length ? ' (module bays: ' + bays.join(', ') + ')' : '')
        : '% Every port on ' + (dev.name || dev.id) + ' is copper: there are no module bays'];
    }

    const linkFor = function (ifaceName) {
      if (!topo) return null;
      for (const l of topo.links.values()) {
        if ((l.a.deviceId === dev.id && l.a.iface === ifaceName) ||
            (l.b.deviceId === dev.id && l.b.iface === ifaceName)) return l;
      }
      return null;
    };
    const metres = function (m) {
      // Number(null) is 0, which would print "0 m" for a medium that declares no range
      // and for a link with no length - both are "unknown", not zero metres.
      if (m === null || m === undefined || m === '') return '-';
      const n = Number(m);
      if (!Number.isFinite(n)) return '-';
      return n >= 1000 ? (Math.round(n / 100) / 10) + ' km' : n + ' m';
    };
    const verdictFor = function (medium, link) {
      if (!link) return 'not cabled';
      const reach = medium && medium.maxRangeM !== undefined && medium.maxRangeM !== null
        ? Number(medium.maxRangeM) : null;
      const length = link.lengthM !== undefined && link.lengthM !== null ? Number(link.lengthM) : null;
      if (length === null) return 'reach unchecked (no cable length)';
      if (reach === null) return 'within reach (medium declares none)';
      if (length > reach) return 'W_DISTANCE: ' + metres(length) + ' > ' + metres(reach) + ' reach';
      return 'within reach';
    };

    // One port named: the whole physical record for it, in the shape of the other
    // per-interface answers rather than a one-row table.
    if (wanted) {
      const i = ports[0];
      const link = linkFor(i.name);
      const medium = link && link.mediaId ? mediaLib.mediaById(link.mediaId) : null;
      const optics = opticalLib.transceiversForCage(i.hardware.cage) || [];
      const rate = (link && link.speedMbps) || i.hardware.maxSpeedMbps || null;
      out.push(String(i.name) + ' (' + i.type + ', ' + i.hardware.cage + ') - transceiver');
      out.push('  cage         : ' + i.hardware.cage);
      out.push('  rate         : ' + (rate ? mediaLib.formatSpeedMbps(rate) : 'unknown'));
      out.push('  optics       : ' + (optics.length
        ? optics.length + ' for this cage (' + optics.slice(0, 3).map(function (o) { return o.partNumber; }).join(', ') +
          (optics.length > 3 ? ', ...' : '') + ')'
        : 'none catalogued - this cage is described by its rate class'));
      out.push('  link         : ' + (link
        ? link.id + ' -> ' + (function () {
          const far = link.a.deviceId === dev.id ? link.b : link.a;
          const farDev = topo.getDevice(far.deviceId);
          return (farDev ? farDev.name : far.deviceId) + '/' + far.iface;
        })() + ' (' + (link.state || 'up') + ')'
        : 'not cabled'));
      if (medium) {
        out.push('  medium       : ' + medium.name + ' (' + medium.family + ', ' + medium.connector +
          (medium.wavelengthNm ? ', ' + medium.wavelengthNm + ' nm' : '') + ')');
      }
      out.push('  reach        : ' + metres(medium ? medium.maxRangeM : null));
      out.push('  length       : ' + (link && link.lengthM !== undefined && link.lengthM !== null
        ? metres(link.lengthM) : '-'));
      if (link && link.patchCord) out.push('  patch cord   : ' + link.patchCord);
      out.push('  verdict      : ' + verdictFor(medium, link));
      return out;
    }

    const rows = ports.map(function (i) {
      const link = linkFor(i.name);
      const medium = link && link.mediaId ? mediaLib.mediaById(link.mediaId) : null;
      const rate = (link && link.speedMbps) || i.hardware.maxSpeedMbps || null;
      return [i.name, i.hardware.cage, medium ? medium.name : '-',
        rate ? mediaLib.formatSpeedMbps(rate) : '-',
        metres(medium ? medium.maxRangeM : null),
        link && link.lengthM !== undefined && link.lengthM !== null ? metres(link.lengthM) : '-',
        verdictFor(medium, link)];
    });
    out.push((dev.name || dev.id) + ' transceivers (' + ports.length + ' cage port' +
      (ports.length === 1 ? '' : 's') + '):');
    // The warning leads the table rather than trailing it: it is the reason to read the
    // numbers, and a note at the same indent as a row reads as one more row.
    const overlong = rows.filter(function (r) { return /^W_DISTANCE/.test(r[6]); }).length;
    if (overlong) {
      out.push('  ' + overlong + (overlong === 1 ? ' link exceeds' : ' links exceed') +
        ' the reach of its medium: the cable mates, but the light will not make it. ' +
        'W_DISTANCE is a warning, not a refusal.');
    }
    out.push.apply(out, renderTable(['Port', 'Cage', 'Medium', 'Rate', 'Reach', 'Length', 'Verdict'], rows, 2));
    return out;
  }

  // show power inline
  //
  // PoE is enforced inside computePoe(): a port that asks for more than the budget
  // has left is denied and the PD is marked unpowered. Until now the only trace of
  // that decision was a poe-budget/poe-deny event on the timeline, so the console could not
  // answer "why is this camera dead". This prints the same decision from both ends.
  _showPowerInline(only) {
    const dev = this.device;
    const out = [];
    if (this.sim) this.sim.computePoe();
    const sim = this.sim;
    const round1 = function (n) { return Math.round(Number(n) * 10) / 10; };

    const rec = sim ? (sim.poe || []).filter(function (r) { return r.dev === dev.id; })[0] : null;
    const sourcing = Array.from(dev.interfaces.values()).filter(function (i) { return i.poeOut; });

    if (rec) {
      const label = { spec: 'spec', research: 'research', name: 'model name', unknown: 'unknown' }[dev.poeBudgetSource] ||
        dev.poeBudgetSource;
      out.push('Power inline on ' + dev.name + ':');
      out.push('  Budget       : ' + rec.budget + ' W  (from ' + label + ')');
      out.push('  Used         : ' + round1(rec.used) + ' W');
      out.push('  Available    : ' + round1(Math.max(0, rec.budget - rec.used)) + ' W');
      const shown = only ? rec.ports.filter(function (x) { return x.iface === only; }) : rec.ports;
      if (!rec.ports.length) {
        out.push('  (no powered device is attached)');
      } else if (!shown.length) {
        out.push('  ' + only + ': no powered device on this port');
      } else {
        out.push('  ' + pad('Port', 14) + pad('Powered device', 22) + pad('Requested', 11) + 'Status');
        for (const p of shown) {
          const pd = sim.topo.getDevice(p.pd);
          out.push('  ' + pad(p.iface, 14) + pad(pd ? pd.name : p.pd, 22) + pad(p.draw + ' W', 11) +
            (p.powered ? 'on' : 'denied (budget exhausted)'));
        }
      }
    } else if (sourcing.length) {
      out.push('% ' + dev.name + ' has ' + sourcing.length + ' PoE-capable port(s) but no power budget, ' +
        'so none of them can source power');
    }

    // The other half of the same decision: what this device is being fed. Only a
    // port with a cable can be fed, so an unconnected PoE-in port is not reported -
    // "no PSE answers" about a port with nothing plugged into it is noise.
    for (const i of dev.interfaces.values()) {
      if (!i.poeIn || !i.peer) continue;
      if (only && i.name !== only) continue;
      const peer = (i.peer && sim) ? sim.topo.getDevice(i.peer.deviceId) : null;
      const peerRec = (peer && sim) ? (sim.poe || []).filter(function (r) { return r.dev === peer.id; })[0] : null;
      const port = peerRec ? peerRec.ports.filter(function (p) { return p.iface === i.peer.iface; })[0] : null;
      if (!out.length) out.push('Power inline on ' + dev.name + ':');
      const where = peer ? peer.name + ' port ' + i.peer.iface : 'nothing';
      if (!port) {
        out.push('  ' + pad(i.name, 14) + i.poeIn + ' W requested from ' + where + ' - no PSE answers');
      } else if (port.powered) {
        out.push('  ' + pad(i.name, 14) + port.draw + ' W from ' + where + ' - powered');
      } else {
        out.push('  ' + pad(i.name, 14) + port.draw + ' W from ' + where + ' - denied (PSE budget exhausted)');
      }
    }

    if (!out.length) return ['% ' + dev.name + ' neither sources nor draws PoE'];
    return out;
  }

  // `show ipv6 route` - the table the IPv6 data path actually reads.
  //
  // IPv6 had no console at all for this: `ipv6 route` and `ipv6 gateway` were configurable and
  // printed in `show running-config`, and `route6To()` routed with them, but nothing let an operator
  // see the table the router would use. It reads `routes6Table()`, which is built from the same
  // connected addresses and static routes `route6To()` compares, so the answer and the table cannot
  // disagree - and `installed` marks the row that forwards, exactly as on the IPv4 side.
  _showIpv6Route(tokens) {
    const v6 = require('./ipv6');
    const dev = this.device;
    const out = [];
    const AD = dev.constructor.ADMIN_DISTANCE;

    if (tokens.length) return this._routeLookup6(dev, tokens);

    const rows = dev.routes6Table();
    if (!rows.length) {
      out.push('% No IPv6 routes - no interface has a global address and none is configured');
      return out;
    }
    const present = {};
    for (const r of rows) present[r.code] = true;
    const names = { C: 'connected', S: 'static' };
    const legend = [];
    for (const code of ['C', 'S']) if (present[code]) legend.push(code + ' - ' + names[code]);
    out.push('Codes: ' + legend.join(', '));
    if (rows.some(function (r) { return !r.installed; })) {
      out.push('* = installed (this row is what forwards); an unmarked row loses on administrative distance');
    }
    out.push.apply(out, renderTable(['*', 'Prefix', 'AD', 'Gateway', 'Interface'],
      rows.map(function (r) {
        return [(r.installed ? '*' : ''), r.code + ' ' + r.dest + '/' + r.prefix,
          String(r.ad === undefined ? '-' : r.ad), r.gw, r.iface];
      }), 2));
    const selfConfigured = rows.filter(function (r) { return r.autoconfig; });
    if (selfConfigured.length) {
      out.push('');
      out.push(selfConfigured.length + ' prefix' + (selfConfigured.length === 1 ? '' : 'es') +
        ' came from a router advertisement (SLAAC), not from this device\'s configuration');
    }
    if (rows.some(function (r) { return r.type === 'default6' && r.iface === '-'; })) {
      out.push('(the default gateway pins no interface: neighbour discovery picks the egress per destination)');
    }
    if (AD.connected !== 0 || AD.static !== 1) {
      // Nothing to say unless someone changes the distances; kept so the numbers cannot be
      // hard-coded in this method without the constant being read.
      out.push('(distances: connected ' + AD.connected + ', static ' + AD.static + ')');
    }
    return out;
  }

  // `show ipv6 route <dest>` - the longest-match lookup, from `route6To()`.
  _routeLookup6(dev, arg) {
    const v6 = require('./ipv6');
    const TYPE_NAME = { connected: 'connected', static6: 'static', default6: 'default' };
    const out = [];
    const text = String(arg[0] === undefined ? '' : arg[0]);
    if (arg.length > 1) return ['% Usage: show ipv6 route [<prefix>/<len> | <address>]'];

    // A "/" means the caller asked about a prefix; otherwise an address.
    const isPrefix = text.indexOf('/') !== -1;
    const parsed = isPrefix ? v6.parsePrefix6(text) : v6.parseIpv6(text);
    if (!parsed || !parsed.valid) {
      const why = parsed && parsed.error && parsed.error.message ? ': ' + parsed.error.message : '';
      return ['% Invalid IPv6 ' + (isPrefix ? 'prefix' : 'destination') + ' "' + text + '"' + why];
    }

    const rows = dev.routes6Table();
    if (isPrefix) {
      // `parsePrefix6` reports the length as `prefixLen`. Reading the wrong field printed
      // "/undefined" and then matched nothing, which looked like an empty table rather than a bug.
      const len = parsed.prefixLen;
      if (typeof len !== 'number') return ['% Internal: no prefix length parsed from "' + text + '"'];
      const wanted = v6.networkAddress6(text) + '/' + len;
      const here = rows.filter(function (r) { return r.dest + '/' + r.prefix === wanted; });
      if (!here.length) return ['% No IPv6 route for ' + wanted + ' in the table'];
      out.push.apply(out, renderTable(['*', 'Prefix', 'AD', 'Gateway', 'Interface'],
        here.map(function (r) {
          return [(r.installed ? '*' : ''), r.code + ' ' + r.dest + '/' + r.prefix,
            String(r.ad === undefined ? '-' : r.ad), r.gw, r.iface];
        }), 2));
      return out;
    }

    const route = dev.route6To(text);
    if (!route) {
      out.push('% No IPv6 route to ' + text);
      if (!dev.config.gateway6) out.push('% No IPv6 default gateway is configured on this device');
      return out;
    }
    const prefix = v6.networkAddress6(text + '/' + route.prefix) + '/' + route.prefix;
    out.push('  Destination  ' + text);
    out.push('  Matched      ' + prefix + '  (' + (TYPE_NAME[route.type] || route.type) +
      ', AD ' + route.ad + ')');
    out.push('  Next hop     ' + (route.type === 'connected' ? '- (directly connected)'
      : (route.via || '-')));
    out.push('  Interface    ' + (route.iface || '-'));
    const shadowed = rows.filter(function (r) {
      return !r.installed && r.dest + '/' + r.prefix === prefix;
    });
    for (const r of shadowed) {
      out.push('  Shadowed     ' + r.code + ' ' + r.dest + '/' + r.prefix +
        '  (' + (r.type === 'static6' ? 'static' : TYPE_NAME[r.type] || r.type) + ', AD ' + r.ad + ')');
    }
    return out;
  }

  // `show ipv6 interface [<port>]` - the IPv6 addressing question.
  //
  // IPv4 has `show ip interface brief`. IPv6 had nothing: an operator could not answer "which global
  // address is on this port, and did a human type it or did a router advertise it?" without reading
  // `show running-config` and knowing that a missing `ipv6 address` line means SLAAC. The provenance
  // is the point - an autoconfigured address goes away when the advertisements stop, which is a
  // different situation from a configured one - so it has its own column.
  _showIpv6Interface(tokens) {
    const dev = this.device;
    const out = [];
    const typed = tokens.length ? String(tokens[0]) : null;
    const wanted = typed ? resolvePortName(dev, typed) : null;
    const addrs = dev.ip6Addrs();
    const ports = [];
    for (const i of dev.interfaces.values()) {
      if (typed) {
        // A named port is answered for whatever it is. The bay filter below is a listing rule - a
        // 24-cage switch should not print 24 empty rows - but applying it to an explicit question made
        // `show ipv6 interface SFP+1` refuse a port that `show interfaces SFP+1` happily described, and
        // that an operator can put an address on.
        if (i.name !== wanted) continue;
      } else if (this._isModuleBay(i)) {
        continue;
      }
      ports.push(i);
    }
    // An unresolvable port name is not "show me everything": it would answer a question nobody
    // asked, which is the defect this console has fixed twice already.
    if (!ports.length) {
      return [typed ? '% No IPv6 port named ' + typed + ' on ' + (dev.name || dev.id)
        : '% No ports - this device has no interfaces'];
    }
    const rows = [];
    let withGlobal = 0;
    let selfConfigured = 0;
    for (const i of ports) {
      const state = i.enabled ? 'up' : 'administratively down';
      if (i.enabled) rows.push([i.name, state, dev.linkLocal6(i), '-', 'link-local']);
      const mine = addrs.filter(function (a) { return a.name === i.name; });
      if (!mine.length) {
        rows.push([i.name, state, '-', '-', i.enabled ? 'no global address' : '-']);
        continue;
      }
      withGlobal++;
      for (const a of mine) {
        if (a.autoconfig) selfConfigured++;
        rows.push([i.name, state, a.addr, String(a.prefix),
          a.autoconfig ? 'autoconfig' + (a.from ? ' from ' + a.from : '') : 'configured']);
      }
    }
    out.push('IPv6 addressing on ' + (dev.name || dev.id) + ':');
    out.push.apply(out, renderTable(['Port', 'State', 'Address', 'Prefix', 'Source'], rows, 2));
    out.push('');
    out.push(ports.length + ' port' + (ports.length === 1 ? '' : 's') + ', ' + withGlobal +
      ' with a global address' + (selfConfigured ? ' (' + selfConfigured + ' autoconfigured)' : ''));
    // A host's global addresses appear when an advertisement arrives. Saying so turns "nothing
    // here" into a next step - and only for a device that cannot advertise itself.
    if (!withGlobal && !dev.hasCap('l3-forward')) {
      // Name the escape hatch as well as the cause: this answer is "as last computed", and the
      // router-advertisement pass runs at run start and whenever a question is asked at an instant.
      // Without the second half, a host that is about to autoconfigure looks broken.
      out.push('Global addresses appear when a router advertisement arrives - see `show ipv6 nd`');
      // `runAtMs` is the run's instant: Infinity means no instant has been asked for, so this
      // answer is the state as last computed rather than a rebuilt one.
      if (this.sim && this.sim.runAtMs === Infinity) {
        out.push('This is the state as last computed; ask again with `at converged` to run the');
        out.push('advertisement pass first.');
      }
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

  // ---------- help ----------
  // `help` and `?` answer in every mode. The list is the command set THIS mode
  // actually accepts, because a help page that invents a command the engine then
  // refuses is a worse lie than a missing line. Modes differ, so the help differs
  // with this.mode rather than dumping one wall of text at an operator who is
  // three prompts deep.
  _help() {
    if (this.mode === MODE_CONFIG) return helpRows([
      'Config-mode commands (exit / end to leave):',
      helpLine('hostname <name>', 'set device hostname (spaces kept)'),
      helpLine('interface <name> | int <name>', 'enter interface configuration'),
      helpLine('interface vlan <id>', 'the switch\'s own address in that VLAN (an SVI)'),
      helpLine('interface <parent>.<vlan>', 'creates a tagged subinterface'),
      helpLine('no interface <parent>.<vlan>', 'remove a subinterface'),
      helpLine('vlan <id> [name]', 'declare a VLAN  (no vlan <id>)'),
      helpLine('ip route <dest> <mask> <gw> [iface]', 'add a static route'),
      helpLine('no ip route <dest> <mask> [gw]', 'remove one, or all with that prefix'),
      helpLine('ip default-gateway <gw>', 'default gateway for hosts'),
      helpLine('ip dhcp pool <name>', 'create/enter a DHCP pool'),
      helpLine('ip name-server <ip>', 'DNS resolver for this device'),
      helpLine('router bgp <as>', 'enable BGP  (no router bgp)'),
      helpLine('bgp router-id <ip> | bgp neighbor <ip> remote-as <as> | no bgp neighbor <ip>',
        'BGP identity and peers'),
      helpLine('ospf router-id <ip> | ospf area <id>', 'enable OSPF  (no ospf)'),
      helpLine('dns zone <name> | dns add <name> <type> <value>',
        'serve a zone, or add a record to one'),
      helpLine('scion <isd-as>', 'join a SCION ISD-AS  (no scion)'),
      helpLine('ipv6 route <prefix>/<len> <next-hop> | ipv6 gateway <addr>',
        'static IPv6 route, or the default gateway'),
      helpLine('ipv6 nd ra enable|disable|managed|other-config',
        'what this router advertises'),
      helpLine('ipv6 nd ra lifetime <s>', 'how often it advertises'),
      helpLine('ipv6 nd prefix <prefix>/<len> [valid <s>] [preferred <s>]',
        'a prefix to advertise (SLAAC)'),
      helpLine('ipv6 nd suppress-ra | no ipv6 nd ...',
        'stop advertising on this port'),
      helpLine('access-list <1-2699> permit|deny ...', 'add an entry'),
      helpLine('no access-list <1-2699> [<entry>]', 'remove one entry, or the whole list'),
      helpLine('vrrp <vrid> ...', 'per-interface - enter an interface first'),
      helpLine('show <what> | do show <what>', 'any exec show, without leaving config mode'),
      helpLine('help / ?', 'this list'),
      helpLine('exit / end', 'back to exec mode')
    ]);

    if (this.mode === MODE_IFACE) return helpRows([
      'Interface-mode commands (' + this.iface + '):',
      helpLine('ip address <ip> <mask>', 'assign an IP - "10.0.0.1 255.255.255.0" or "10.0.0.1/24"'),
      helpLine('ip address dhcp | no ip address', 'DHCP client / clear'),
      helpLine('ip helper-address <addr> | no ip helper-address [<addr>]',
        'relay DHCP requests on this port to a server'),
      helpLine('shutdown | no shutdown', 'administratively down / up'),
      helpLine('description <text>', '(no description)'),
      helpLine('encapsulation dot1q <vlan>', 'tag this subinterface'),
      helpLine('switchport mode access|trunk', 'the port carries one VLAN or many'),
      helpLine('switchport access vlan <id>', 'the access VLAN'),
      helpLine('switchport trunk native vlan <id>', 'the untagged VLAN on a trunk'),
      helpLine('switchport trunk allowed vlan <list|all>', 'which VLANs the trunk carries'),
      helpLine('channel-group <id> mode active|passive|on|static',
        'add this port to a LAG'),
      helpLine('ip access-group <acl> in|out | no ip access-group [<acl>] [in|out]',
        'bind (or unbind) an ACL to this port'),
      helpLine('ip ospf cost <n> | ip ospf area <id> | ip ospf passive',
        'per-port OSPF cost, area, or make it passive'),
      helpLine('ipv6 address <addr>/<len> | ipv6 address autoconfig | no ipv6 address [autoconfig]',
        'a static IPv6 address, or one learned from a router'),
      helpLine('vrrp <vrid> ip <addr> [priority <p>] [preempt] [advertise <s>]',
        'join (or create) a VRRP group'),
      helpLine('no vrrp <vrid>', 'remove the group'),
      helpLine('interface <name>', 'switch to another port, stay in config-if'),
      helpLine('show <what>', 'any exec show, from here too'),
      helpLine('<any config-mode command>', 'applied globally, then back to config'),
      helpLine('help / ?', 'this list'),
      helpLine('exit / end', 'config / exec')
    ]);

    if (this.mode === MODE_DHCP_POOL) return helpRows([
      'DHCP pool commands (' + this.pool + '):',
      helpLine('network <net> [mask]', 'the subnet served'),
      helpLine('default-router <addr>', 'gateway handed to clients'),
      helpLine('dns-server <addr...>', 'resolvers handed to clients'),
      helpLine('range <start> <end>', 'leaseable range'),
      helpLine('excluded-address <addr[-addr]...>', 'addresses not to lease'),
      helpLine('lease <days> [hours] [minutes]', 'lease length'),
      helpLine('host <addr> <mac>', 'static reservation'),
      helpLine('no default-router|dns-server|range|lease|excluded-address',
        'clear one setting in this pool'),
      helpLine('no pool', 'delete this pool'),
      helpLine('help / ?', 'this list'),
      helpLine('exit / end', 'back to config mode')
    ]);

    // exec / enable share one command set
    return helpRows([
      'Available commands:',
      helpLine('enable / en', 'enter enable mode'),
      helpLine('configure terminal / conf t', 'enter config mode'),
      helpLine('flow open <dst> [port <n>] [bytes <n>] [proto tcp|udp] [sport <n>] [at <ms>|converged]', 'start a conversation from here (dst = address or name)'),
      helpLine('flow close <id>', 'close one (TCP four-way, UDP retired)'),
      helpLine('ping <dst> [count <n>] [at <ms>|converged]', 'ICMP echo; dst = address or name, "at" = an instant'),
      helpLine('traceroute <dst> [at <ms>|converged]', 'the forwarding path, hop by hop (tracert too)'),
      helpLine('nslookup <name> [type]', 'resolve a name (own zones first, then the lab)'),
      helpLine('converge [<ms>|converged]', 'when each control plane finishes'),
      helpLine('link up|down <id> [at <ms>]', 'pull or replace a cable, re-converge from there'),
      helpLine('link state <id>', 'one cable: endpoints, state, since when'),
      helpLine('links', 'every cable and its state'),
      helpLine('help / ?', 'this list'),
      helpLine('exit / logout / quit', 'leave the session'),
      '',
      'Show commands:',
      helpLine('show version', 'model, vendor and software'),
      helpLine('show clock', 'the instant this lab is being asked about'),
      helpLine('show logging [<type>|summary] [last <n>] [device <name>]',
        'why something happened - drops, forwards, protocol events'),
      helpLine('clear logging', 'truncate the event log'),
      helpLine('clear counters [<port>] / clear interface counters', 'zero the per-port counters'),
      helpLine('show ip interface brief [<port>]', 'address and link state per port'),
      helpLine('show interfaces [<port>]', 'per-port detail and counters'),
      helpLine('show interfaces counters [<port>]', 'one row per port: packets, bytes, drops'),
      helpLine('show interfaces transceiver [<port>]', 'cage, optic, reach and cable-length verdict'),
      helpLine('show ip route [<dest>|connected|static|ospf|bgp|summary] [at <ms>|converged]',
        'the table, a lookup, a protocol filter, or an instant'),
      helpLine('show arp [<port>]', 'IP-to-MAC cache'),
      helpLine('show mac address-table [interface <port>]', 'addresses learned per port and VLAN'),
      helpLine('show vlan', 'VLANs and their members'),
      helpLine('show spanning-tree [<port>]', 'root bridge, port roles and states'),
      helpLine('show etherchannel', 'LAGs and their members'),
      helpLine('show lldp neighbors [<port>]', 'what announced itself on each port'),
      helpLine('show access-lists', 'entries, and where they are bound'),
      helpLine('show vrrp', 'groups, priorities and current state'),
      helpLine('show ip bgp', 'peers and installed prefixes'),
      helpLine('show ip ospf [neighbor]', 'process, interfaces, adjacencies'),
      helpLine('show flows [<id> | counters]', 'conversations in this lab, and per-device counters'),
      helpLine('show ip nat translations', 'NAT entries the data path wrote'),
      helpLine('show ip nat statistics', 'rules, entries and hits'),
      helpLine('show dns', 'zones, records and resolvers'),
      helpLine('show scion', 'membership, segments and reachability'),
      helpLine('show scion paths [<isd-as>]', 'composed paths, and the best of them'),
      helpLine('show ipv6 nd', 'what this device would advertise'),
      helpLine('show ipv6 interface [<port>] [at <ms>|converged]',
        'IPv6 addresses per port, and where each came from'),
      helpLine('show ipv6 route [<dest>] [at <ms>|converged]',
        'the IPv6 table, a longest-match lookup, or an instant'),
      helpLine('show ip dhcp binding', 'leases handed out, or the lease held'),
      helpLine('show ip dhcp pool', 'pool summary and addresses in use'),
      helpLine('show power inline [<port>]', 'PoE budget and which ports are powered'),
      helpLine('show running-config', 'the whole configuration, pasteable'),
      helpLine('show startup-config', 'the saved copy, then what the running config changed'),
      helpLine('write memory', 'save the running configuration (privileged)'),
      helpLine('copy running-config startup-config', 'the same save, spelled the other way'),
      '',
      '',
      'A show that reports control-plane state also answers "at <ms>" or "at converged":',
      'show ip route|ospf|bgp|dhcp, show arp, show mac address-table, show spanning-tree,',
      'show vrrp, show lldp.',
      '',
      'For config commands: configure terminal, then ?'
    ]);
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
