'use strict';
// cli.js — vendor-agnostic management console (Cisco-like, but the same
// commands work for every vendor in the registry). The engine operates on
// capabilities, not on vendor syntax, so a Huawei router and a Cisco router
// share one consistent command set.
const net = require('./net');
const { renderTable } = require('./table');
const psLib = require('./portsecurity');
const lldpLib = require('./lldp');

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
// Two words of the `show interfaces` family that are views this model does not keep. `accounting` is
// a real IOS view (nothing here bills or classifies traffic) and `usage` is a percentage nobody
// samples - both used to be answered "No interface named accounting", which is true and sends the
// operator looking for a port by that name.
const INTERFACE_VIEWS_NOT_KEPT = {
  accounting: ['% No traffic accounting is kept per port: nothing here bills or classifies',
    '% What is counted is packets, bytes and drops - "show interfaces counters"'],
  usage: ['% No utilisation percentage is computed: this model counts bytes, it does not',
    '% sample a line rate. Divide a port\'s bytes by the lab\'s uptime, or:',
    '%   show interfaces counters            packets, bytes and drops per port']
};

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

// The words whose next token is a value, not a question about a moment. `show mac address-table
// address 001122334455` was answering a table rebuilt at t=1122334455 ms and dropping the address,
// because a trailing all-digit token was read as an instant - the value of `address` is a number.
const INSTANT_VALUE_KEYWORDS = new Set([
  'interface', 'int', 'last', 'device', 'port', 'vlan', 'proto', 'id', 'neighbor', 'type', 'zone',
  'address', 'addr', 'mac', 'group', 'acl', 'list', 'sequence', 'seq', 'binding', 'entry', 'pool',
  'as', 'vrid', 'pid', 'priority', 'cost', 'mtu', 'speed', 'size'
]);

// The words a destination-taking command uses for its own arguments. A line that begins with one has
// no destination, which is a different fact from a destination the resolver cannot find (see
// `_requireDest` below). Kept as data rather than a regex so a new keyword is one edit and cannot be
// spelled differently at a second site.
const DEST_KEYWORDS = new Set(['at', 'count', 'port', 'bytes', 'proto', 'sport']);

// How to satisfy a prerequisite, in one place per feature. Six sites used to answer `% BGP is not
// enabled` with four different messages and two of them named no command at all - and the ones that
// did name one were the *configuration* verbs, not the shows, so the command you were refused for was
// the one place you could not learn how to fix it. `test/refusal-pointers.test.js` types the command
// out of each message and requires it to work, so a hint that drifts off the real spelling fails.
const NEEDS = {
  bgp: ' - "router bgp <as>" in config mode turns BGP on',
  ospf: ' - "ospf router-id <ip>" in config mode turns OSPF on',
  vrrp: ' - "vrrp <id> ip <addr>" inside an interface block adds a group',
  scion: ' - "scion <isd-as>" in config mode makes this device an AS',
  enable: ' - type "enable" first'
};

const MODE_EXEC = 'exec';
const MODE_ENABLE = 'enable';
const MODE_CONFIG = 'config';
const MODE_IFACE = 'iface';
const MODE_DHCP_POOL = 'dhcp-pool';
const MODE_ACL = 'acl';
const MODE_OSPF = 'ospf';

// One line per logged event. Rather than a switch per type - which would drift the moment a protocol
// adds a field - this prefers the fields that carry the *reason*, then the well-known addresses, then
// whatever identifying keys the event has. `reason` first is deliberate: a drop's whole value is why
// it was dropped.
function describeEvent(ev) {
  // A name resolution is one line, and it is the line an operator is sent to when a lookup fails:
  //   dns  R1  nosuch.lab.example -> NXDOMAIN from SRV1
  // The generic renderer printed the model's own field names in quotes instead
  // (`clientName "R1", qname "nosuch.lab.example", ok false, ...`), which is a dump of the record,
  // not an answer about the lookup.
  if (ev && ev.type === 'dns') {
    const name = ev.qname || '(no name)';
    if (ev.ok) {
      return name + ' -> ' + (ev.address || '(no address)') +
        (ev.server ? ' (answered by ' + ev.server + ')' : '');
    }
    const why = ev.reason || (ev.status ? String(ev.status) : 'no answer');
    return name + ' -> ' + why;
  }
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

// The long name of an interface type, so `GigabitEthernet0/0` finds the port the panel calls `Gi0/0`.
// IOS names a port by its type in full and accepts any unambiguous prefix of it; the panel label is
// the shortest spelling. Only the types a catalogue device actually uses are listed - anything else
// (SFP+1, ether1, ...) keeps the spelling it has.
const IFACE_LONG_TYPE = {
  gi: 'GigabitEthernet', fa: 'FastEthernet', eth: 'Ethernet', e: 'Ethernet', et: 'Ethernet',
  te: 'TenGigabitEthernet', tengige: 'TenGigabitEthernet', twe: 'TwentyFiveGigE',
  tw: 'TwoGigabitEthernet', fi: 'FiveGigabitEthernet', fo: 'FortyGigabitEthernet',
  hu: 'HundredGigE', po: 'Port-channel', vl: 'Vlan', vlan: 'Vlan', lo: 'Loopback', tu: 'Tunnel'
};

// Every spelling of a port name that its label stands for: the long type name, each prefix of it
// from two letters up, and the label itself. `Gi0/0` therefore answers to Gi0/0, Gig0/0, Giga0/0
// through GigabitEthernet0/0.
function ifaceNameAliases(name) {
  const m = /^([A-Za-z][A-Za-z-]*?)(\d[\d/]*)$/.exec(String(name));
  if (!m) return [];
  const label = m[1];
  const rest = m[2];
  const long = IFACE_LONG_TYPE[label.toLowerCase()];
  if (!long) return [];
  const out = [];
  for (let i = 2; i <= long.length; i++) out.push(long.slice(0, i) + rest);
  return out;
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
  if (alias) return alias;
  // The long spelling of a type: `GigabitEthernet0/0`, `FastEthernet0/1`, `Gig0/0`. Matched the same
  // way, so a spelling that fits two ports is refused rather than guessed.
  for (const name of map.keys()) {
    const hit = ifaceNameAliases(name).some(function (a) {
      return a.toLowerCase() === lower;
    });
    if (!hit) continue;
    if (alias === null) alias = name;
    else if (alias !== name) return null;
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
// The five output filters, in the order the help page lists them. `_applyPipe` resolves an
// abbreviation against this list, so the page and the parser cannot disagree about the names.
const PIPE_FILTERS = ['include', 'exclude', 'begin', 'section', 'count'];

const LOAD_ROUTE_FILTERS = {
  connected: ['C'], static: ['S'], ospf: ['O'], bgp: ['B']
};
// How a selector is spelled back in prose. "2 ospf routes" reads like a variable name; OSPF is an
// acronym and the console uses the proper spelling everywhere else.
const LOAD_ROUTE_LABELS = { connected: 'connected', static: 'static', ospf: 'OSPF', bgp: 'BGP' };

// The console says `active|passive|on`; `lag.js` says `lacp-active|lacp-passive|static`. One table,
// read by both the command that stores the mode and the table that prints it, so a bundle cannot be
// shown in a vocabulary it was not configured with.
const LAG_CLI_MODES = {
  active: 'lacp-active',
  passive: 'lacp-passive',
  on: 'static',
  static: 'static',
  'lacp-active': 'lacp-active',
  'lacp-passive': 'lacp-passive'
};
function lagModeWord(libMode) {
  const text = String(libMode === undefined || libMode === null ? '' : libMode).trim().toLowerCase();
  const lib = LAG_CLI_MODES[text] || text;
  if (lib === 'lacp-active') return 'LACP active';
  if (lib === 'lacp-passive') return 'LACP passive';
  if (lib === 'static') return 'static';
  return text || '?';
}

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
    if (this.mode === MODE_ACL) return host + '(config-' + (this.aclKindWord || 'std') + '-nacl)#';
    if (this.mode === MODE_OSPF) return host + '(config-router)#';
    if (this.mode === MODE_ENABLE) return host + '#';
    return host + '>';
  }

  // `run()` takes one line. It used to *silently ignore* the rest: `run('configure terminal',
  // 'hostname R1')` configured nothing and returned the output of the first line only, so eighteen
  // call sites across the test suite were asserting against a lab that had never been configured -
  // and passing, because an empty diff is a valid diff. A second line is now run, in order, and the
  // outputs are concatenated, which is what every one of those call sites already assumed.
  run(line) {
    const lines = Array.prototype.slice.call(arguments).filter(function (x) {
      return x !== undefined && x !== null;
    });
    if (lines.length > 1) {
      const all = { output: [], actions: [] };
      for (const one of lines) {
        const r = this.run(String(one));
        all.output.push.apply(all.output, r.output || []);
        all.actions.push.apply(all.actions, r.actions || []);
      }
      return all;
    }
    const out = [];
    if (typeof line !== 'string') {
      // `run(['a', 'b'])` used to fail inside `.trim()` with "line.trim is not a function", which
      // says nothing about what was wrong. The multi-line form is `run('a', 'b')`.
      throw new TypeError('CliSession.run expects a string, got ' +
        (Array.isArray(line) ? 'an array (pass the lines as separate arguments: run(a, b))'
          : typeof line));
    }
    // An output pipe: `show running-config | include route`. The filters IOS operators live by were
    // not supported at all, and worse than unsupported - the pipe was read as a port argument, so
    // `show running-config | include route` answered "takes one port, not \"| include route\"".
    // Split here, before anything else looks at the words, run the left side normally, and filter
    // what it printed.
    if (line.indexOf('|') !== -1) {
      const cut = line.indexOf('|');
      const main = line.slice(0, cut).trim();
      const pipes = line.slice(cut).split('|').slice(1).map(function (x) { return x.trim(); });
      if (!main) {
        return { output: ['% A filter needs a command before it - "show running-config | include route"'],
          actions: [] };
      }
      const inner = this.run(main);          // the view, unfiltered
      const lines = (inner && inner.output) || [];
      // A refusal is never filtered: a `| include` that swallowed the reason a command failed would
      // be the most expensive filter in the console.
      if (lines.some(function (l) { return /^\s*%/.test(l); })) {
        return { output: lines, actions: (inner && inner.actions) || [] };
      }
      // A `?` in a filter is the help character, not the string to look for - and the test has to
      // cover the *verb* position, not just "a `?` surrounded by spaces": `| inc?` and `| i?` were
      // read as filters whose text was the help character ("nothing in this answer matches \"| i?\"")
      // and `| c?` applied count and printed "7 lines", answering a question nobody asked. A `?`
      // attached to the filter word is the same question as `| include ?`.
      if (pipes.some(function (p) {
        const seg = String(p);
        const verbWord = seg.trim().split(/\s+/)[0] || '';
        return verbWord.indexOf('?') !== -1 || /(^|\s)\?(\s|$)$/.test(seg.trim());
      })) {
        return { output: this._pipeHelp(main, pipes), actions: [] };
      }
      let shown = lines;
      for (const pipe of pipes) {
        const r = this._applyPipe(shown, pipe);
        if (r.error) return { output: [r.error], actions: (inner && inner.actions) || [] };
        shown = r.lines;
      }
      // Silence is not an answer: "the view printed twelve lines and none of them matched" and "the
      // view printed nothing" look the same on a blank screen, and they are different problems.
      if (!shown.length) {
        shown = ['(nothing in this answer matches "| ' + pipes.join(' | ') + '" - the command printed ' +
          lines.length + ' line' + (lines.length === 1 ? '' : 's') + ')'];
      }
      return { output: shown, actions: (inner && inner.actions) || [] };
    }
    let tokens = line.trim().split(/\s+/).filter(Boolean);
    if (!tokens.length) return { output: out, actions: [] };
    // `show history` is a view of this session, so the console has to keep one. Bounded, because a
    // long run types thousands of lines and a history nobody can read is not history.
    this.history = this.history || [];
    // Asking for the history must not become part of it, or every question about it changes the
    // answer - the same defect as a `show` that moves a counter.
    if (!/^show\s+history\b/i.test(line.trim())) {
      this.history.push(line.trim());
      if (this.history.length > 200) this.history.shift();
    }

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

    // `GigabitEthernet 0/0` - a type word and its index split across two tokens - is one port name
    // in every position: `interface GigabitEthernet 0/0` answered "Interface not found:
    // GigabitEthernet" and left the index unread. Joined here, once, so no command has to know.
    if (this.device && this.device.interfaces && tokens.length >= 3) {
      for (let i = 1; i + 1 < tokens.length; i++) {
        const m = /^([A-Za-z][A-Za-z-]*)\s+(\d[\d/]*(?:\.\d+)?)$/.exec(tokens[i] + ' ' + tokens[i + 1]);
        if (!m) continue;
        // `vlan` is a keyword in its own right (`vlan 10`, `switchport access vlan 10`,
        // `spanning-tree vlan 10 priority 4096`) and joining it to the number turned every one of
        // those into an interface name. The SVI still answers to its single-token spellings.
        if (/^(vlan|vl)$/i.test(m[1])) continue;
        if (!resolvePortName(this.device, m[1] + m[2])) continue;
        tokens = tokens.slice(0, i).concat([m[1] + m[2]], tokens.slice(i + 2));
        break;
      }
    }

    // '!' is a comment, exactly as it is in a pasted IOS config: a device that
    // rejects the first line of its own dump cannot be restored from that dump.
    if (head === '!') return { output: out, actions: [] };

    try {
      if (this.mode === MODE_IFACE) {
        out.push.apply(out, this._ifaceMode(tokens));
      } else if (this.mode === MODE_DHCP_POOL) {
        out.push.apply(out, this._dhcpPoolMode(tokens));
      } else if (this.mode === MODE_OSPF) {
        out.push.apply(out, this._ospfRouterMode(tokens));
      } else if (this.mode === MODE_ACL) {
        out.push.apply(out, this._aclMode(tokens));
      } else if (this.mode === MODE_CONFIG) {
        out.push.apply(out, this._configMode(tokens));
      } else {
        // exec / enable mode
        // The exec verbs that change something and take no word: `write memory zzzz` saved the
        // configuration and dropped the word, `enable zzzz` was accepted in silence, `logout zzzz`
        // logged out anyway. The list is explicit rather than read from the page because the exec
        // page groups its rows with `|` (one row reads `show version | show clock | ...`), and the
        // readers already judge their own arguments (`show`, `ping`, `traceroute`, `clear ...`).
        const strayExec = this._execStrayWord(tokens);
        if (strayExec) return { output: out.concat(strayExec), actions: [] };
        if (head === 'renew' && tokens[1] === 'dhcp') {
          out.push.apply(out, this._dhcpClientVerb('renew', tokens.slice(2)));
        } else if (head === 'release' && tokens[1] === 'dhcp') {
          out.push.apply(out, this._dhcpClientVerb('release', tokens.slice(2)));
        } else if (head === 'enable' || head === 'en') {
          this.mode = MODE_ENABLE;
        } else if (head === 'clear' && tokens[1] === 'ip' && (tokens[2] === 'access-list' || tokens[2] === 'access-lists')) {
          // `clear ip access-list counters` - the spelling an operator reaches for first, because
          // every other ACL command starts with `ip`.
          if (tokens[3] !== 'counters') {
            out.push('% Incomplete command: clear ip access-list counters [<id|name>]');
          } else if (this.mode !== MODE_ENABLE) {
            out.push('% Privileged command - type "enable" first');
          } else {
            out.push.apply(out, this._clearAclCounters(tokens.slice(4)));
          }
        } else if (head === 'clear' && (tokens[1] === 'access-list' || tokens[1] === 'access-lists')) {
          // `clear ip access-list counters` and `clear access-list counters` are the same act; the
          // `ip` is optional exactly as it is on IOS.
          const rest = tokens[1] === 'access-list' || tokens[1] === 'access-lists'
            ? (tokens[2] === 'counters' ? tokens.slice(3) : null)
            : null;
          if (rest === null) {
            out.push('% Incomplete command: clear access-list counters [<id|name>]');
          } else if (this.mode !== MODE_ENABLE) {
            out.push('% Privileged command - type "enable" first');
          } else {
            out.push.apply(out, this._clearAclCounters(rest));
          }
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
            out.push('% clear counters needs enable mode' + NEEDS.enable);
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
        } else if (head === 'clear' && tokens[1] === 'ip' && tokens[2] === 'nat') {
          // The translation table is the one table in the model with no way to empty it: it fills as
          // traffic crosses the box and only `show ip nat translations` could read it, so an operator
          // could watch translations appear but never start again from a clean table.
          out.push.apply(out, this._clearNat(tokens.slice(3)));
        } else if (head === 'clear' && tokens[1] === 'ip' && tokens[2] === 'dhcp' && tokens[3] === 'binding') {
          // IOS: `clear ip dhcp binding *` or `clear ip dhcp binding <address>`. The binding table is
          // the server's record of who holds what; emptying it does not reach out and take an address
          // away from a client that is already using it, and saying so is the useful part.
          const which = tokens[4];
          const held = this.sim ? this.sim.dhcpBindings(this.device.id) : [];
          // Every line here goes through `out`: this dispatch returns its answer as lines, and a bare
          // `return [...]` from one arm reached the caller with no output envelope at all - the
          // command was accepted and said nothing, which is the one answer a refusal must not give.
          if (!this.device.hasCap('dhcp-server')) {
            out.push('% ' + this.device.name + ' is not a DHCP server - it holds no bindings to clear');
          } else if (!which) {
            // Clearing everything has a spelling - `*` - and it is destructive, so a bare command
            // must not be the way to do it.
            out.push('% Incomplete command: clear ip dhcp binding * | <address>');
          } else if (!held.length) {
            out.push('% ' + this.device.name + ' holds no DHCP bindings');
          } else if (which && which !== '*' && !held.some(function (b) { return b.ip === which; })) {
            out.push('% No binding for ' + which + ' - this server has: ' +
              held.map(function (b) { return b.ip; }).join(', '));
          } else {
            const cleared = this.sim.clearDhcpBindings(this.device.id, which || '*');
            out.push('Cleared ' + cleared.length + ' binding' + (cleared.length === 1 ? '' : 's') +
              (cleared.length ? ': ' + cleared.map(function (b) { return b.ip + ' (' + b.mac + ')'; }).join(', ') : ''));
            out.push('  Those clients keep the addresses they hold until they renew - a renew is now answered');
            out.push('  as a fresh request, so the address may change at that point');
          }
        } else if (head === 'clear' && tokens[1] === 'port-security') {
          out.push.apply(out, this._clearPortSecurity(tokens.slice(2)));
        } else if (head === 'clear' && (tokens[1] === 'arp' ||
            (tokens[1] === 'ip' && tokens[2] === 'arp') ||
            (tokens[1] === 'mac' && tokens[2] === 'address-table'))) {
          // The two tables a lab learns for itself: ARP (address -> MAC) and the MAC table
          // (MAC -> port). Both fill up as traffic crosses the lab and neither could be emptied,
          // so an operator who wanted to watch learning happen again had to rebuild the topology.
          // `clear counters` and `clear logging` already existed; these are the same action on the
          // state those two tables are.
          const isArp = tokens[1] !== 'mac';
          const rest = isArp
            ? tokens.slice(tokens[1] === 'ip' ? 3 : 2)
            : tokens.slice(3);
          // The IOS forms carry keywords - `clear mac address-table dynamic`, `... vlan 20`,
          // `... address <mac>`, `clear arp 10.0.0.5` - and every one of them was read as a *port*:
          //   % No interface named dynamic on SW1
          //   % No interface named 10.0.0.9 on R1
          // The keyword forms are parsed here, and each one narrows what is emptied.
          const usage = isArp
            ? 'clear arp [interface <port> | <ip>]'
            : 'clear mac address-table [dynamic | static | vlan <id> | interface <port> | address <mac>]';
          let pick = { ok: true };
          let wantVlan = null, wantMac = null, wantType = null;
          {
            const words = rest.map(function (x) { return String(x); });
            const lower = words.map(function (x) { return x.toLowerCase(); });
            const bad = [];
            let i = 0;
            while (i < words.length) {
              const w = lower[i];
              if (w === 'interface' || w === 'int') {
                const got = this._portArg(words.slice(i + 1, i + 2), this.device, usage);
                if (!got.ok) { bad.push(got.output); } else { pick = got; }
                i += 2;
              } else if ((w === 'dynamic' || w === 'static') && !isArp) {
                wantType = w; i += 1;
              } else if (w === 'vlan' && !isArp) {
                if (!/^\d+$/.test(String(words[i + 1] || ''))) {
                  bad.push(['% clear mac address-table vlan needs a VLAN id, not "' +
                    (words[i + 1] === undefined ? 'nothing' : words[i + 1]) + '"']);
                } else { wantVlan = Number(words[i + 1]); }
                i += 2;
              } else if (w === 'address' && !isArp) {
                wantMac = String(words[i + 1] || '').toLowerCase();
                i += 2;
              } else if (isArp && net.isIp(words[i])) {
                // `clear arp 10.0.0.5` - one entry, by the address the operator named.
                pick = Object.assign({}, pick, { arpIp: words[i] });
                i += 1;
              } else if (!isArp && /^([0-9a-f]{2}[:-]){5}[0-9a-f]{2}$/i.test(words[i])) {
                wantMac = words[i].toLowerCase(); i += 1;
              } else if (isArp) {
                // A bare word after `clear arp` may be a port (the port-scoped spelling `clear arp
                // Gi0/0` is real) or an address, and nothing else. When it is neither, say both
                // halves rather than answering "No interface named zzzz" - which sends the operator
                // looking for a port by that name when the mistake was the word.
                const asPort = this._portArg([words[i]], this.device, usage);
                if (asPort.ok && asPort.port) {
                  pick = asPort;
                  i += 1;
                } else {
                  // Both spellings are real here, so the refusal says both: the port message the
                  // port spelling gives, and what the word may be instead.
                  bad.push(['% No interface named ' + words[i] + ' on ' + (this.device.name || this.device.id),
                    '% A word here is an address ("clear arp 10.0.0.9") or a port ("clear arp ' +
                    (Array.from(this.device.interfaces.keys())[0] || 'Gi0/0') + '")']);
                  i += 1;
                }
              } else {
                // A bare word could be a port name (the old spelling) or a typo.
                const got = this._portArg([words[i]], this.device, usage);
                if (got.ok) { pick = got; i += 1; } else { bad.push(got.output); i += 1; }
              }
            }
            if (bad.length) {
              out.push.apply(out, bad[0]);
              pick = { ok: false };
            }
          }
          if (this.mode !== MODE_ENABLE) {
            out.push('% clear ' + (isArp ? 'arp' : 'mac address-table') + ' needs enable mode' + NEEDS.enable);
          } else if (!pick.ok) {
            // The refusals were pushed while parsing; nothing is cleared.
          } else if (pick.arpIp) {
            // One entry by address: a learned one is forgotten, a pinned one is configuration and is
            // refused with the verb that does remove it.
            const ip = pick.arpIp;
            if (this.device.arpStatic.has(ip)) {
              out.push('% ' + ip + ' is a static entry on ' + (this.device.name || this.device.id) +
                ' - it is configuration, not a cache');
              out.push('% Remove it with "no arp ' + ip + '"');
            } else if (this.device.arp.has(ip)) {
              const mac = this.device.arp.get(ip);
              this.device.arp.delete(ip);
              out.push('ARP entry ' + ip + ' (' + mac + ') cleared on ' + (this.device.name || this.device.id));
            } else {
              out.push('% No ARP entry for ' + ip + ' on ' + (this.device.name || this.device.id) +
                ' - nothing to clear');
            }
          } else if (!isArp && (this.device.isL2 && !this.device.isL2())) {
            // A router has no MAC table to clear because it has no bridge. Say which table it does
            // have, rather than "cleared (0 entries)", which reads like an empty switch.
            out.push('% ' + (this.device.name || this.device.id) +
              ' does not bridge, so it has no MAC address table');
            out.push('% Try "show arp" for the addresses it has learned');
          } else if (isArp) {
            const before = this.device.arp.size;
            let removed = 0;
            if (pick.port) {
              // A port filter clears the entries that resolve to that port and nothing else: the
              // cache holds no port, so the port is derived the same way `show arp` derives it.
              for (const [ip, mac] of Array.from(this.device.arp.entries())) {
                const owner = this.sim && this.sim.ownerOfIp ? this.sim.ownerOfIp(ip) : null;
                let onPort = null;
                if (owner) {
                  if (owner.id === this.device.id) onPort = '(self)';
                  else {
                    for (const i of this.device.interfaces.values()) {
                      if (i.peer && i.peer.deviceId === owner.id) onPort = i.name;
                    }
                  }
                }
                if (onPort !== pick.port) continue;
                this.device.arp.delete(ip);
                removed++;
              }
            } else {
              this.device.arp.clear();
              removed = before;
            }
            const where = (this.device.name || this.device.id) + (pick.port ? ' for ' + pick.port : '');
            // A static entry is configuration, not learning: `clear arp` empties what the lab taught
            // the device and leaves what the operator wrote, because the alternative is a command
            // documented as clearing the cache silently editing the running-config.
            const kept = this.device.arpStatic.size;
            out.push(removed
              ? 'ARP cache cleared on ' + where + ' (' + removed + ' entr' + (removed === 1 ? 'y' : 'ies') + ')'
              : 'ARP cache on ' + where + ' was already empty - nothing to clear');
            if (kept) {
              out.push('  ' + plural(kept, 'static entry') + ' kept - they are configured, not learned' +
                ' (remove with "no arp <ip>")');
            }
          } else if (wantType === 'static') {
            // Everything in this table was learned. A static address on a switch lives in
            // port-security (sticky or configured), so point there instead of reporting "0 cleared"
            // as though there had been nothing to clear.
            out.push('MAC address table on ' + (this.device.name || this.device.id) +
              ': no static entries - every address in it was learned');
            out.push('% A pinned address lives in port-security: "show port-security address",' +
              ' "clear port-security sticky"');
          } else {
            // `vlan <id>` narrows to that bridge domain; without it every table is emptied.
            const tableFor = function (vlan) {
              if (vlan === null) {
                return [this.device.macTable].concat(
                  Array.from((this.device.macTables || new Map()).values()));
              }
              if (vlan === 1) return [this.device.macTable];
              const t = (this.device.macTables || new Map()).get(vlan);
              return t ? [t] : [];
            }.bind(this);
            const tables = tableFor(wantVlan);
            const missingVlan = wantVlan !== null && !tables.length;
            if (missingVlan) {
              out.push('% No MAC address table for VLAN ' + wantVlan + ' on ' +
                (this.device.name || this.device.id) + ' - nothing has been learned there');
              out.push('% Nothing was cleared; "show vlan" lists the VLANs this switch has');
            }
            let removed = 0;
            for (const table of tables) {
              for (const [mac, iface] of Array.from(table.entries())) {
                if (pick.port && iface !== pick.port) continue;
                if (wantMac && String(mac).toLowerCase() !== wantMac) continue;
                table.delete(mac);
                removed++;
              }
            }
            const what = [pick.port ? 'for ' + pick.port : null,
              wantVlan !== null ? 'in VLAN ' + wantVlan : null,
              wantMac ? 'for ' + wantMac : null].filter(Boolean).join(' ');
            const where = (this.device.name || this.device.id) + (what ? ' ' + what : '');
            if (!missingVlan) {
              out.push(removed
                ? 'MAC address table cleared on ' + where + ' (' + removed + ' entr' +
                  (removed === 1 ? 'y' : 'ies') + ')'
                : 'MAC address table on ' + where + ' was already empty - nothing to clear');
            }
          }
        } else if (head === 'clear' && tokens[1] === 'ip' &&
            (tokens[2] === 'route' || tokens[2] === 'bgp')) {
          // Not modelled, and "Unrecognized command" is the wrong answer: the command exists in IOS
          // and an operator will try it. What they need to know is why there is nothing to flush.
          out.push('% There is no ' + (tokens[2] === 'route' ? 'routing table' : 'BGP session') +
            ' to clear: this model derives ' +
            (tokens[2] === 'route' ? 'routes from configuration and protocol state' : 'sessions from configuration') +
            ', so the next answer would be the same one');
          out.push('% Ask "show ip ' + tokens[2] + ' at <ms>|converged" for the state at an instant instead');
        } else if (head === 'clear' && tokens[1] === 'logging') {
          // Truncating the log is how you ask "what has happened *since*" without re-reading a
          // screenful. It is a privileged action, as in IOS, and it refuses to guess at a target.
          if (this.mode !== MODE_ENABLE) {
            // Not "Invalid exec command": the command is fine, the session is not privileged. Saying
            // otherwise sends an operator looking for a missing feature.
            out.push('% clear logging needs enable mode' + NEEDS.enable);
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
          // The other direction existed nowhere: a saved copy could be written and read, and nothing
          // ever loaded it back, so `write memory` was an act with no way to return to it. IOS's
          // `copy startup-config running-config` *merges* the saved copy into the running one (it does
          // not clear first - that is `reload`), and that is what this does.
          const reverse = !isWrite && (['startup-config', 'startup', 'start'].indexOf(tokens[1]) !== -1) &&
            (tokens[2] === 'running-config' || tokens[2] === 'run');
          const target = isWrite ? (tokens[1] === undefined ? 'memory' : tokens[1])
            : (tokens[1] === 'running-config' || tokens[1] === 'run' ? tokens[2] : null);
          const okTarget = isWrite
            ? ['memory', 'mem', 'startup-config', 'startup'].indexOf(target) !== -1
            : ['startup-config', 'startup', 'start'].indexOf(target) !== -1;
          if (reverse) {
            if (this.mode !== MODE_ENABLE) {
              out.push('% copy startup-config running-config needs enable mode' + NEEDS.enable);
            } else {
              out.push.apply(out, this._loadSavedConfig(this.device));
            }
          } else if (!okTarget) {
            out.push(head === 'write'
              ? '% write takes memory (or startup-config) - there is nothing else to write'
              : '% copy takes running-config startup-config, or startup-config running-config');
          } else if (this.mode !== MODE_ENABLE) {
            out.push('% ' + (isWrite ? 'write memory' : 'copy running-config startup-config') +
              ' needs enable mode' + NEEDS.enable);
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
        } else if (head === 'terminal') {
          // `terminal length 0` opens half the pasted transcripts on the internet, and it answered
          // "% Unrecognized command". There is no pager here - every line a view prints is printed -
          // so the honest answer is to take the command, keep the setting, and say what it changed.
          const what = String(tokens[1] || '').toLowerCase();
          const value = tokens[2];
          const extra = this._noExtra(tokens, 3, 'terminal length <0-512> | terminal width <40-512>');
          const usage = ['% Usage: terminal length <0-512>   (0 = no pager)',
            '%        terminal width <40-512>    (how wide the tables are drawn)'];
          if (extra) out.push.apply(out, extra);
          else if (!what) out.push.apply(out, ['% Incomplete command: terminal length|width <n>'].concat(usage));
          else if (what !== 'length' && what !== 'width') {
            out.push('% There is no "terminal ' + tokens[1] + '" - this console has length and width',
              '% Both change how the screen is drawn, not what the device is');
          } else if (value === undefined) {
            out.push.apply(out, ['% Incomplete command: terminal ' + what + ' <n>'].concat(usage));
          } else if (!/^\d+$/.test(String(value))) {
            out.push.apply(out, ['% terminal ' + what + ' takes a number, not "' + value + '"'].concat(usage));
          } else {
            const n = parseInt(value, 10);
            const lo = what === 'length' ? 0 : 40;
            const hi = what === 'length' ? 512 : 512;
            if (n < lo || n > hi) {
              out.push.apply(out, ['% ' + what + ' ' + n + ' is outside ' + lo + '-' + hi].concat(usage));
            } else if (what === 'length') {
              this.terminalLength = n;
              out.push('Console length set to ' + n + (n === 0 ? ' lines: no pager, every line is printed' :
                ' lines'), '  This console has no pager to pause: the setting is kept and reported by ' +
                '"show terminal"');
            } else {
              this.terminalWidth = n;
              out.push('Console width set to ' + n + ' columns', '  Tables are drawn to this width by "show terminal"');
            }
          }
        } else if (head === 'reload') {
          // `reload` reboots the box from its saved configuration. Nothing here boots - there is no
          // boot loader, no image, no POST - so answering "% Unrecognized command" would send the
          // operator looking for a typo. The saved copy is real, and the way back to it is real.
          const saved = this.device.savedConfig && this.device.savedConfig.lines;
          out.push('% There is no reload on this console - nothing here boots, so there is no restart');
          out.push('%   to schedule and no saved image to load on the way up');
          if (saved) {
            out.push('% The saved copy is real, and so is the way back to it:');
            out.push('%   copy startup-config running-config   merge the saved copy into the running one');
            out.push('%   show startup-config                the saved copy, plus what has changed since');
          } else {
            out.push('% Nothing has been saved in this lab yet: "write memory" keeps a copy to return to');
          }
          out.push('% To discard unsaved changes, build the device again - that is what a reboot would do here');
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
          // `!` is a comment here (as it is in a pasted IOS config); `#` is the other language's
          // comment and reading it as a command is the last thing an operator needs to debug.
          if (/^\s*#/.test(line)) {
            out.push('% A comment line starts with "!" - a line beginning with "#" is read as a command');
          }
        }
      }
    } catch (e) {
      out.push('% Error: ' + e.message);
    }
    return { output: out, actions: [] };
  }

  // ---------- config mode ----------
  // A verb family that changes device state has to be refused where the device has no such state, and
  // the page already holds the sentence - `_helpRefusal` is what hides the row. The parser did not ask
  // it, so on a host, a server and an AP:
  //
  //   no spanning-tree vlan 10      -> "Spanning tree bridge priority on D1 is already the default"
  //   ip dhcp pool lab              -> "Created DHCP pool lab"   (and the session entered the pool)
  //   no router bgp 65001           -> "BGP disabled"
  //   no ospf area 10               -> "OSPF disabled"
  //   ip route 10.9.0.0 ... 10.0.0.9-> "Route added"
  //
  // Each promised state the device cannot have. The families below are the ones that changed something
  // anyway; the rest already refuse in more specific words, and the gate leaves them alone.
  _capabilityGate(tokens) {
    const words = tokens.map(function (t) { return String(t).toLowerCase(); });
    const first = words[0];
    const second = words[1] || '';
    const family = first === 'no' ? second : first;
    // Only the *removal* half, and only where the handler accepted it in silence. The positive forms
    // already refuse well and in their own words - "% SW1 is a layer 2 switch: it cannot run BGP",
    // "% R1 does not bridge - spanning tree runs on switches" - and preempting those with the page's
    // generic sentence would be a worse answer, not a better one. `ip route` is deliberately absent:
    // a host here carries a default route (`ip route 0.0.0.0 0.0.0.0 <gateway>`) and labs rely on it.
    const removal = first === 'no';
    const families = ['spanning-tree', 'router', 'ospf', 'bgp', 'neighbor'];
    const isDhcp = (first === 'ip' && second === 'dhcp') ||
      (first === 'no' && second === 'ip' && words[2] === 'dhcp');
    // `ip nat inside|outside` sets a NAT role on a port. A device whose catalogue says it does not
    // translate took the role anyway (an L3 switch, which routes and so passed the routing test), and
    // then reported itself as a NAT interface in a lab where nothing could translate on it. The
    // removal half is left alone: `no ip nat inside` answers "is not a NAT interface", which is true.
    // The same two IPv6 families the page filters: turning forwarding on (`ipv6 unicast-routing`) or
    // advertising a prefix (`ipv6 nd …`) needs the capability, in both directions - the removal promised
    // "IPv6 unicast routing disabled" on a camera that forwards nothing.
    // Only the removal half is gated: the positive forms already refuse in the handler's own words
    // ("% PC1 does not route - PC1 forwards no IPv6", "% SW1 cannot advertise: it has no l3-forward
    // capability"), and those name the device and the row. What nothing judged was `no ipv6
    // unicast-routing`, which reported "forwarding disabled" on a camera that forwards nothing.
    const isIpv6Forward = first === 'no' && second === 'ipv6' &&
      ['unicast-routing', 'nd', 'router'].indexOf(words[2]) !== -1;
    const gated = (removal && families.indexOf(family) !== -1) || isDhcp || isIpv6Forward;
    if (!gated) return null;
    const why = this._helpRefusal(words.slice(0, 4).join(' '));
    if (!why) return null;
    return ['% ' + (this.device.name || this.device.id) + ' - ' + why];
  }

  _configMode(tokens) {
    const out = [];
    const head = tokens[0].toLowerCase();
    // Capability before syntax: on a device that cannot run OSPF at all, whether the `1` after `no
    // router ospf` is an extra word is not the question anyone is asking - yet that is the answer it
    // got ("% Unexpected argument \"1\" - no router ospf takes no more"), because the stray-word
    // guard consults the page first and the page's row has no argument.
    const gate = this._capabilityGate(tokens);
    if (gate) return gate;
    const stray = this._blockStrayWord(tokens, MODE_CONFIG);
    if (stray) return stray;
    if (head === 'help' || head === '?') return this._help();
    if (head === 'no' && String(tokens[1] || '').toLowerCase() === 'hostname') {
      // The removal half of `hostname`: back to the model's own name for this device.
      const had = (this.device.config && this.device.config.hostname) || null;
      const shown = this.device.name;
      if (tokens.length > 2) {
        return ['% Unexpected argument "' + tokens[2] + '" - no hostname takes no more',
          '% Usage: no hostname   (clears the configured name and restores the default)'];
      }
      if (!had) {
        return ['% No hostname is configured - this device is called ' + shown +
          ' (that is its label, not a hostname it was given)'];
      }
      if (this.device.config) this.device.config.hostname = null;
      const def = this.device.label + '-' + String(this.device.id).slice(-4);
      // The name shown right now came from this command when it matches what was configured; in that
      // case it goes back to the default too, so the two surfaces keep saying the same thing.
      const restored = shown === had ? def : shown;
      this.device.name = restored;
      return ['Hostname cleared: this device is called ' + restored +
        (shown === had ? ' again (the default name for this model)' : ' (its label - the hostname was ' + had + ')'),
        // The dump always names the device - IOS prints a default hostname too - so the line does not
        // vanish; what changes is that it now names the default rather than a name it was given.
        '  "show running-config" now reads "hostname ' + restored + '", the default for this device'];
    }
    if (head === 'hostname') {
      // The whole remainder is the name. Taking tokens[1] silently truncated
      // "core switch 1" to "core", which is what the UI's hostname field appeared to do
      // (issue #19) - the box was fine, the parser was eating the rest of the line.
      const name = tokens.slice(1).join(' ').trim();
      // A bare `hostname` used to clear config.hostname and say nothing - and because `device.name`
      // is only set when a name was given, the two fields the comment below promises cannot disagree
      // disagreed: the label said R1, the running-config said nothing. Nothing typed is not a rename.
      if (!name) {
        return ['% Incomplete command: hostname <name>',
          '% e.g. "hostname R1" - the name is the first line of "show running-config"'];
      }
      this.device.config.hostname = name || null;
      // device.name is what the UI renders: the canvas label, the inspector header, the
      // status bar. Setting only config.hostname left a device that reported
      // "hostname THE BIFROST" while every surface still said "THE" (issue #21). Both are
      // set from the same text, so they cannot disagree.
      if (name) this.device.name = name;
    } else if (head === 'vlan') {
      // Every refusal below used to be a guess. `vlan abc` answered "VLAN NaN created (name:
      // VLAN0NaN)" and wrote `config.vlans[NaN]`; an out-of-range id leaked the data-model field name
      // ("accessVlan 9999 is outside 1-4094") instead of naming the VLAN; re-typing an existing VLAN
      // said "created" again; and a router - which has no VLANs at all - accepted one. Four different
      // answers to "what is a VLAN id", from one command.
      // A PC with one Ethernet port answered "VLAN 10 created (name: VLAN0010)" and stored it, and so
      // did a server: a bridge domain on a device that neither bridges nor routes, which nothing on it
      // would ever read. A router may still declare one - it can route between VLANs and its
      // running-config round-trips the line - but a host cannot, and the refusal says which it is.
      if (!this._canDeclareVlan()) {
        return ['% ' + (this.device.name || this.device.id) +
          ' is not a switch or a router, so it has no VLANs',
          '% A VLAN is a broadcast domain: something has to switch it, or route between it',
          '% A host reaches other networks with "ip default-gateway <gw>"'];
      }
      const typed = tokens[1];
      if (typed === undefined) return ['% Incomplete command: vlan <id> [name]'];
      if (!/^\d+$/.test(String(typed))) {
        return ['% VLAN id must be a number, not "' + typed + '"',
          '% Usage: vlan <id> [name]'];
      }
      const id = parseInt(typed, 10);
      if (!(id >= 1 && id <= 4094)) return ['% VLAN ' + typed + ' is outside 1-4094'];
      // VLAN 1 exists before anything is configured - it is the default VLAN, never written to a
      // saved copy, and `no vlan 1` is refused. Reporting "VLAN 1 created" claimed an act the
      // configuration does not record.
      if (id === 1) {
        return ['VLAN 1 is the default VLAN - every port starts in it and it cannot be created or removed',
          'A VLAN you create gets its own id: "vlan 10 name users"'];
      }
      if (!this.device.config.vlans) this.device.config.vlans = {};
      const existing = this.device.config.vlans[id];
      // Two spellings, one meaning. This console takes `vlan <id> [name]` on one line, but an
      // operator coming from IOS types `vlan 20 name users` - and the word `name` was swallowed as
      // part of the name, so the VLAN came out called "name users". A keyword that is only a keyword
      // in IOS is still a keyword here: it is consumed, and the rest of the line is the name.
      const nameWords = tokens.slice(2);
      const typedName = (String(nameWords[0] || '').toLowerCase() === 'name'
        ? nameWords.slice(1) : nameWords).join(' ');
      if (existing) {
        if (typedName) {
          existing.name = typedName;
          out.push('VLAN ' + id + ' name changed to ' + typedName);
        } else {
          out.push('VLAN ' + id + ' already configured (name: ' + existing.name + ')');
        }
      } else {
        const name = typedName || ('VLAN' + String(id).padStart(4, '0'));
        this.device.config.vlans[id] = { name: name };
        out.push('VLAN ' + id + ' created (name: ' + name + ')');
      }
    } else if (head === 'no' && tokens[1] === 'vlan') {
      // `no vlan 99` answered "VLAN 99 removed" for a VLAN that never existed, `no vlan` answered
      // "VLAN NaN removed", and `no vlan 30` answered "removed" while two ports still carried it - so
      // `show vlan` kept printing the VLAN the command said it had deleted. Success was the one thing
      // this verb could not report honestly, because nothing checked whether there was anything to
      // remove or whether removing it meant anything.
      const typed = tokens[2];
      if (typed === undefined) return ['% Incomplete command: no vlan <id>'];
      if (!/^\d+$/.test(String(typed))) {
        return ['% VLAN id must be a number, not "' + typed + '"',
          '% Usage: no vlan <id>'];
      }
      const id = parseInt(typed, 10);
      if (!(id >= 1 && id <= 4094)) return ['% VLAN ' + typed + ' is outside 1-4094'];
      const extra = this._noExtra(tokens, 3, 'no vlan <id>');
      if (extra) return extra;
      const deps = this._vlanDependents(this.device, id);
      const declared = this.device.config.vlans && this.device.config.vlans[id];
      // Ports and SVIs are two different dependencies with two different remedies. Reporting both
      // as "those ports" told the operator to move an SVI with `switchport access vlan`, which is
      // advice that cannot be carried out: an SVI is the device's own address, not a port.
      if (deps.hard.length) {
        const notes = ['% VLAN ' + id + ' is carried by ' + deps.hard.join(', ') +
          ' - it cannot be removed while those ports are in it',
          '% Move them first, e.g. "switchport access vlan <other>" in each interface block'];
        if (deps.svis.length) {
          notes.push('% ' + deps.svis.join(', ') + ' also hold' + (deps.svis.length === 1 ? 's' : '') +
            ' an address in it - "no interface vlan ' + id + '" removes that first');
        }
        return notes;
      }
      if (deps.svis.length) {
        return ['% VLAN ' + id + ' is this device\'s own address: ' + deps.svis.join(', '),
          '% Remove the interface first - "no interface vlan ' + id + '" - and the VLAN stays empty',
          '% "show ip interface brief" lists the interfaces, "show vlan" the VLANs'];
      }
      if (!declared) {
        return ['% No VLAN ' + id + ' on ' + (this.device.name || this.device.id) +
          ' - nothing is configured for it and no port carries it',
          '% "show vlan" lists the VLANs this device has'];
      }
      const was = declared.name;
      delete this.device.config.vlans[id];
      out.push('VLAN ' + id + ' removed (was named ' + was + ')');
      // A trunk that listed the VLAN explicitly now passes one fewer VLAN; saying so is the
      // difference between a removal the operator can see in `show vlan` and one they have to
      // discover.
      for (const port of deps.listed) {
        const vi = this.device.interfaces.get(port);
        if (!vi || !vi.vlan || !Array.isArray(vi.vlan.allowedVlans)) continue;
        vi.vlan.allowedVlans = vi.vlan.allowedVlans.filter(function (x) { return Number(x) !== id; });
        out.push('  ' + port + ': VLAN ' + id + ' removed from the allowed list');
      }
    } else if (head === 'no' && (tokens[1] === 'interface' || tokens[1] === 'int')) {
      // `interface vlan 20` creates the switch's own address on a VLAN, and `no interface vlan 20`
      // is how IOS removes it. Here the two-token spelling read "vlan" as an interface name
      // ("% Interface not found: vlan"), and the one-token spelling - which resolves fine - answered
      // "% Vlan20 is a physical interface and cannot be removed", which is true of nothing. An SVI
      // could be created and never removed, and the refusal described the wrong object.
      const isSviSpelling = String(tokens[2] || '').toLowerCase() === 'vlan' && tokens[3] !== undefined;
      const typed = isSviSpelling ? 'vlan ' + tokens[3] : tokens[2];
      const name = isSviSpelling ? 'Vlan' + String(tokens[3]) : resolvePortName(this.device, typed);
      const vi = name ? this.device.interfaces.get(name) : null;
      if (!vi) {
        if (isSviSpelling) {
          return ['% No interface Vlan' + tokens[3] + ' on ' + (this.device.name || this.device.id),
            '% "show vlan" lists the VLANs, and "show ip interface brief" the interfaces'];
        }
        return ['% Interface not found: ' + (typed || '')];
      }
      if (vi.svi) {
        const vid = String(name).replace(/\D/g, '');
        const hadIp = vi.ip || null;
        this.device.interfaces.delete(name);
        out.push('Interface ' + name + ' removed' + (hadIp ? ' (its address ' + hadIp + ' went with it)' : ''));
        if (Array.isArray(this.device.config.routes)) {
          this.device.config.routes = this.device.config.routes.filter(function (r) {
            return String(r.iface || '') !== String(name);
          });
        }
        // The VLAN is separate configuration - `vlan <id>` was typed on its own line - and removing
        // the address must not remove a bridge domain other ports may still be carrying.
        const members = [];
        for (const i of this.device.interfaces.values()) {
          if (i.svi) continue;
          if (Number(i.vlan && i.vlan.accessVlan) === Number(vid)) members.push(i.name);
        }
        out.push(members.length
          ? '  VLAN ' + vid + ' stays: ' + members.join(', ') + (members.length === 1
            ? ' still carries it (remove with "no vlan ' + vid + '")'
            : ' still carry it (remove with "no vlan ' + vid + '")')
          : '  VLAN ' + vid + ' stays, empty - "no vlan ' + vid + '" removes it');
      } else if (!vi.parent) {
        return ['% ' + name + ' is a physical interface and cannot be removed',
          '% A port is hardware, not configuration - remove the cable instead'];
      } else {
        this.device.interfaces.delete(name);
        out.push('Subinterface ' + name + ' removed');
      }
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
      // A pool name is one word. `ip dhcp pool lab zzzz` created the pool and dropped the word.
      if (tokens[4] !== undefined) {
        return ['% Unexpected argument "' + tokens[4] + '" - ip dhcp pool <name> takes one name',
          '% A pool name has no spaces: "ip dhcp pool lab"'];
      }
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
      const scionExtra = this._noExtra(tokens, 2, 'scion <isd-as>');
      if (scionExtra) return scionExtra;
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
    } else if (head === 'ip' && tokens[1] === 'nat') {
      out.push.apply(out, this._ipNatConfig(tokens.slice(2)));
    } else if (head === 'no' && tokens[1] === 'ip' && tokens[2] === 'dhcp' && tokens[3] === 'pool') {
      // Nothing removed a pool from global config: `ip dhcp pool LAN` created one, `no pool` inside
      // the pool removed it, and the line `show running-config` printed could not be typed back. A
      // command whose only undo is a different syntax in a different mode has no undo as far as a
      // paste is concerned.
      const name = tokens[4];
      const pools = this.device.config.dhcpPools || [];
      if (!name) {
        return ['% Incomplete command: no ip dhcp pool <name>'].concat(pools.length
          ? ['% The pools on this device are: ' + pools.map(function (p) { return p.name; }).join(', ')]
          : ['% This device has no DHCP pools to remove']);
      }
      const pool = pools.filter(function (p) { return p.name === name; })[0];
      if (!pool) {
        return ['% No DHCP pool named "' + name + '"' + (pools.length
          ? ' - this device has: ' + pools.map(function (p) { return p.name; }).join(', ')
          : ' - this device has no DHCP pools')];
      }
      this.device.config.dhcpPools = pools.filter(function (p) { return p.name !== name; });
      out.push('DHCP pool ' + name + ' removed' +
        (pool.network ? ' (' + pool.network + (pool.mask ? ' / ' + pool.mask : '') + ')' : ''));
      const dhcpLib = require('./dhcp');
      const held = this.sim ? this.sim.dhcpBindings(this.device.id).filter(function (b) {
        return dhcpLib.ipInPool(pool, b.ip);
      }) : [];
      if (held.length) {
        out.push('  ' + held.length + ' lease' + (held.length === 1 ? '' : 's') + ' from it ' +
          (held.length === 1 ? 'is' : 'are') + ' no longer served: ' +
          held.map(function (b) { return b.ip + ' to ' + b.mac; }).join(', '));
        out.push('  Those clients keep their addresses until they renew, and a renew now goes unanswered');
      }
    } else if (head === 'no' && tokens[1] === 'ip' && tokens[2] === 'nat') {
      out.push.apply(out, this._noIpNatConfig(tokens.slice(3)));
    } else if (head === 'ip' && tokens[1] === 'access-list') {
      out.push.apply(out, this._ipAccessList(tokens.slice(2)));
    } else if (head === 'no' && tokens[1] === 'ip' && tokens[2] === 'access-list') {
      out.push.apply(out, this._noIpAccessList(tokens.slice(3)));
    } else if (head === 'spanning-tree') {
      out.push.apply(out, this._stpConfig(tokens.slice(1)));
    } else if (head === 'no' && tokens[1] === 'spanning-tree') {
      // `no spanning-tree vlan <id>` restores the default priority. The VLAN word is required, because
      // a bare `no spanning-tree` would read as "turn spanning tree off", which this model cannot do.
      const stpLib = require('./stp');
      const rest = tokens.slice(2).map(function (x) { return String(x).toLowerCase(); });
      const usage = 'no spanning-tree vlan <id> [priority <n> | root primary|secondary]';
      if (rest[0] !== 'vlan') {
        out.push('% Usage: ' + usage);
        out.push('% (spanning tree itself cannot be turned off in this model; only its priority can)');
      } else if (rest[1] === undefined) {
        out.push('% Incomplete command: ' + usage);
      } else if (!/^\d+$/.test(rest[1]) || !(Number(rest[1]) >= 1 && Number(rest[1]) <= 4094)) {
        out.push('% VLAN id must be a number 1-4094, not "' + rest[1] + '"');
      } else if (this._stpNoExtraWords(rest)) {
        out.push.apply(out, this._stpNoExtraWords(rest));
      } else if (this.device.config.stpPriority === undefined) {
        out.push('Spanning tree bridge priority on ' + (this.device.name || this.device.id) +
          ' is already the default (' + stpLib.STP_DEFAULT_PRIORITY + ')');
      } else {
        const had = this.device.config.stpPriority;
        delete this.device.config.stpPriority;
        delete this.device.config.stpRootMode;
        out.push('Spanning tree bridge priority reset to the default (' + stpLib.STP_DEFAULT_PRIORITY +
          ') on ' + (this.device.name || this.device.id) + ' (was ' + had + ')');
      }
    } else if (head === 'ipv6' && tokens[1] === 'route') {
      out.push.apply(out, this._ipv6Route(tokens.slice(2)));
    } else if (head === 'arp' || (head === 'no' && tokens[1] === 'arp')) {
      out.push.apply(out, this._staticArp(head === 'no' ? tokens.slice(2) : tokens.slice(1), head === 'no'));
    } else if (head === 'ip' && tokens[1] === 'domain-lookup') {
      out.push.apply(out, this._ipDomainLookup(true, tokens.slice(2)));
    } else if (head === 'no' && tokens[1] === 'ip' && tokens[2] === 'domain-lookup') {
      out.push.apply(out, this._ipDomainLookup(false, tokens.slice(3)));
    } else if (head === 'ip' && tokens[1] === 'domain-name') {
      out.push.apply(out, this._ipDomainName(tokens.slice(2), false));
    } else if (head === 'no' && tokens[1] === 'ip' && tokens[2] === 'domain-name') {
      out.push.apply(out, this._ipDomainName(tokens.slice(3), true));
    } else if (head === 'lldp' && tokens[1] === 'run') {
      out.push.apply(out, this._lldpRun(false, tokens.slice(2)));
    } else if (head === 'no' && tokens[1] === 'lldp' && tokens[2] === 'run') {
      out.push.apply(out, this._lldpRun(true, tokens.slice(3)));
    } else if (head === 'ipv6' && tokens[1] === 'unicast-routing') {
      out.push.apply(out, this._ipv6UnicastRouting(true, tokens.slice(2)));
    } else if (head === 'ipv6' && tokens[1] === 'gateway') {
      const v6 = require('./ipv6');
      // One address: `ipv6 gateway 2001:db8:9::1 zzzz` set the gateway and dropped the word.
      if (tokens[3] !== undefined) {
        return ['% Unexpected argument "' + tokens[3] + '" - ipv6 gateway <addr> takes one address'];
      }
      if (!v6.validateAddress6(tokens[2]).ok) out.push('% Invalid IPv6 gateway "' + (tokens[2] || '') + '"');
      else { this.device.config.gateway6 = tokens[2]; out.push('IPv6 default gateway ' + tokens[2]); }
    } else if (head === 'ipv6' && tokens[1] === 'nd') {
      out.push.apply(out, this._ipv6Nd(tokens.slice(2)));
    } else if (head === 'no' && tokens[1] === 'ipv6' && tokens[2] === 'nd') {
      out.push.apply(out, this._ipv6Nd(['no'].concat(tokens.slice(3))));
    } else if (head === 'no' && tokens[1] === 'ipv6' && tokens[2] === 'unicast-routing') {
      // Before the bare `no ipv6` arm below, which clears every IPv6 route: turning forwarding off
      // must not also delete the routing table, because turning it back on would then restore
      // nothing and the operator would reasonably conclude the command ate their configuration.
      out.push.apply(out, this._ipv6UnicastRouting(false, tokens.slice(3)));
    } else if (head === 'no' && tokens[1] === 'ipv6' && tokens[2] === 'route') {
      // The page documents `no ipv6 route <prefix/len> [<next-hop>]`, and it was never implemented:
      // the line fell through to the bare `no ipv6` arm, which cleared *every* IPv6 route. A removal
      // that empties more than it names is the defect the whole `no`-form series is about.
      const v6r = require('./ipv6');
      const pr = v6r.parsePrefix6(tokens[3]);
      if (!tokens[3] || !pr.valid) {
        // "Invalid" would make a documented form look like a typo in the sweep that types every
        // bracketed part; the shape is stated instead, which is what the operator needs anyway.
        return ['% "' + (tokens[3] || '') + '" is not an IPv6 prefix - write it as address/length',
          '% Usage: no ipv6 route <prefix> [<next-hop>]'];
      }
      const extraR6 = this._noExtra(tokens, 5, 'no ipv6 route <prefix> [<next-hop>]');
      if (extraR6) return extraR6;
      const wantNet = v6r.networkAddress6(tokens[3]);
      const wantHop = tokens[4] ? String(tokens[4]) : null;
      if (wantHop && !v6r.validateAddress6(wantHop).ok) {
        return ['% "' + wantHop + '" is not an IPv6 address',
          '% Usage: no ipv6 route <prefix> [<next-hop>]'];
      }
      const all6 = this.device.config.routes6 || [];
      const kept6 = all6.filter(function (r) {
        const sameNet = String(r.dest) === String(wantNet) && Number(r.prefix) === pr.prefixLen;
        return wantHop ? !(sameNet && String(r.nextHop) === wantHop) : !sameNet;
      });
      if (kept6.length === all6.length) {
        const there = all6.filter(function (r) {
          return String(r.dest) === String(wantNet) && Number(r.prefix) === pr.prefixLen;
        }).map(function (r) { return r.nextHop; });
        return ['% No IPv6 route to ' + wantNet + '/' + pr.prefixLen + (wantHop ? ' via ' + wantHop : '') +
          ' on ' + (this.device.name || this.device.id),
          there.length
            ? '% It is there via ' + there.join(', ') + ' - name that next hop, or drop it to remove the prefix'
            : '% "show ipv6 route" lists the routes this device has'];
      }
      this.device.config.routes6 = kept6;
      out.push('IPv6 route to ' + wantNet + '/' + pr.prefixLen + ' removed' + (wantHop ? ' (via ' + wantHop + ')' : ''));
    } else if (head === 'no' && tokens[1] === 'ipv6' && tokens[2] === 'gateway') {
      // `no ipv6 gateway zzzz` fell through to the bare `no ipv6` arm and cleared every IPv6 route
      // with it - a command that was not read, doing more than the one that was asked for.
      const extra6 = this._noExtra(tokens, 4, 'no ipv6 gateway [<addr>]');
      if (extra6) return extra6;
      const v6lib = require('./ipv6');
      if (tokens[3] && !v6lib.validateAddress6(tokens[3]).ok) {
        return ['% "' + tokens[3] + '" is not an IPv6 address, so it is not the gateway here',
          '% Usage: no ipv6 gateway [<addr>]  ("show ipv6 route" prints the one in use)'];
      }
      this.device.config.gateway6 = null;
      out.push('IPv6 default gateway cleared' + (tokens[3] ? ' (was ' + tokens[3] + ')' : ''));
    } else if (head === 'no' && tokens[1] === 'ipv6') {
      const extraBare = this._noExtra(tokens, 2, 'no ipv6');
      if (extraBare) return extraBare;
      this.device.config.gateway6 = null;
      this.device.config.routes6 = [];
      out.push('IPv6 routes cleared');
    } else if (head === 'switchport') {
      // The capability comes before the mode. On a host the old answer told the operator to enter an
      // interface and try again - advice that cannot work, because no port on it has a switchport.
      if (typeof this.device.isL2 === 'function' && !this.device.isL2()) {
        return ['% ' + (this.device.name || this.device.id) +
          ' does not switch, so no port on it has a switchport to configure',
          '% Switchport verbs belong to a switch'];
      }
      // The verbs are per interface, and at global scope the bare refusal reads like a typo. `vrrp`
      // already answers this way; `switchport` is typed here far more often.
      return ['% switchport is configured per interface: enter one first, e.g. "interface Gi0/1"',
        '% Then: switchport mode access|trunk, switchport access vlan <id>, switchport port-security'];
    } else if (head === 'ip' && tokens[1] === 'routing') {
      out.push.apply(out, this._ipRouting(tokens));
    } else if (head === 'no' && tokens[1] === 'ip' && tokens[2] === 'routing') {
      out.push.apply(out, this._ipRouting(tokens));
    } else if (head === 'router' && tokens[1] === 'ospf') {
      // `router bgp` was refused on a layer 2 switch; `router ospf 1` was accepted on a *host*, which
      // answered "OSPF process 1 enabled, entering router configuration mode" and then had no
      // interfaces to put in an area. The same gate, in the same words.
      if (typeof this.device.isL3 === 'function' && !this.device.isL3()) {
        return ['% ' + (this.device.name || this.device.id) +
          ' is not a router: OSPF describes paths between interfaces it can forward between',
          '% A host reaches other networks with "ip default-gateway <gw>"'];
      }
      out.push.apply(out, this._routerOspf(tokens));
    } else if (head === 'no' && tokens[1] === 'router' && tokens[2] === 'ospf') {
      this.device.config.ospf = null;
      this.device.ospfRoutes = [];
      out.push('OSPF disabled');
    } else if (head === 'router' && tokens[1] === 'bgp') {
      // `router bgp <as>` started BGP and stayed in config mode. Every real BGP block ends in `exit`,
      // so pasting one - the most common configuration in any BGP lab - dropped the operator out of
      // config mode on that line and every command after it was read as exec and lost. The mode is
      // the same one `router ospf` uses, which is why the prompt already says (config-router).
      // A switch has no routes to advertise and no table to put them in, and it accepted
      // `router bgp 65001` and entered router configuration mode. Refuse it in its own terms.
      if (typeof this.device.isL3 === 'function' && !this.device.isL3()) {
        return ['% ' + (this.device.name || this.device.id) + ' is a layer 2 switch: it cannot run BGP',
          '% BGP needs a device that routes - a router, or a layer 3 switch with "ip routing"'];
      }
      // One AS, one word: `router bgp 65001 zzzz` enabled BGP and dropped the word.
      if (tokens[3] !== undefined) {
        return ['% Unexpected argument "' + tokens[3] + '" - router bgp <as> takes one AS number'];
      }
      const accepted = this._bgp(['as', tokens[2]]);
      out.push.apply(out, accepted);
      if (!accepted.some(function (l) { return /^%/.test(l); })) {
        this.modeBeforeOspf = this.mode;
        this.routerKind = 'bgp';
        this.mode = MODE_OSPF;
        out.push('Entering router configuration mode (local AS ' + this.device.config.bgp.as + ')');
        out.push('  "neighbor <ip> remote-as <as>" adds a peer, "bgp router-id <ip>" names this router',
          '  "exit" leaves the mode, and a pasted configuration does not need it');
      }
    } else if (head === 'bgp' && (tokens[1] === 'router-id' || tokens[1] === 'neighbor')) {
      // IOS sets the speaker's identifier from global config, and this console's own usage text said
      // so ("router bgp <as> | bgp router-id <ip> | bgp neighbor <ip> remote-as <as>") while answering
      // "% Unrecognized command" to it. The verb was reachable only inside the process.
      if (typeof this.device.isL3 === 'function' && !this.device.isL3()) {
        return ['% ' + (this.device.name || this.device.id) + ' is a layer 2 switch: it cannot run BGP',
          '% BGP needs a device that routes - a router, or a layer 3 switch with "ip routing"'];
      }
      out.push.apply(out, this._bgp(tokens));
    } else if (head === 'no' && tokens[1] === 'router' && tokens[2] === 'bgp') {
      // `no router bgp zzzz` disabled BGP and dropped the word. Removing the process takes no
      // argument, and the page says so.
      const badAs = tokens.slice(3).filter(function (a) { return !/^\d+(\.\d+)?$/.test(a); })[0];
      if (badAs) {
        return ['% Unexpected argument "' + badAs + '" - no router bgp takes the AS it was started with, or nothing',
          '% Usage: no router bgp [<as>]'];
      }
      this.device.config.bgp = null;
      this.device.bgpRoutes = [];
      out.push('BGP disabled');
    } else if (head === 'no' && (tokens[1] === 'neighbor' || (tokens[1] === 'bgp' && tokens[2] === 'neighbor'))) {
      // `no bgp neighbor <ip>` is the spelling help documents; `no neighbor <ip>` is the one the rest
      // of the grammar suggests. Both remove the same neighbour.
      const addr = tokens[1] === 'bgp' ? tokens[3] : tokens[2];
      if (!this.device.config.bgp) out.push('% BGP is not enabled' + NEEDS.bgp);
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
    } else if (head === 'no' && tokens[1] === 'dns') {
      // A zone can be created with `dns zone <name>` and could never be removed: the line
      // `show running-config` prints had no `no` form, so a saved copy could only ever grow.
      out.push.apply(out, this._noDns(tokens.slice(2)));
    } else if (head === 'ip' && tokens[1] === 'name-server') {
      // Every word after the keyword is an address: `ip name-server 8.8.8.8 8.8.4.4` configures two,
      // and `ip name-server 8.8.8.8 zzzz` used to configure one and drop the other on the floor -
      // an accepted line that was partly not read, which is the defect this family is about.
      const wanted = tokens.slice(2);
      if (!wanted.length) {
        return ['% Incomplete command: ip name-server <address>',
          '% e.g. "ip name-server 8.8.8.8" - one or more addresses, space separated'];
      }
      const bad = wanted.filter(function (a) { return !net.isIp(a); })[0];
      if (bad) {
        return ['% Invalid name server "' + bad + '"',
          '% Expected an IPv4 or IPv6 address - usage: ip name-server <address> [<address> ...]'];
      }
      if (!this.device.config.dnsServers) this.device.config.dnsServers = [];
      const added = [];
      for (const ip of wanted) {
        if (this.device.config.dnsServers.indexOf(ip) === -1) {
          this.device.config.dnsServers.push(ip);
          added.push(ip);
        }
      }
      out.push(added.length
        ? 'Name server' + (added.length > 1 ? 's ' : ' ') + added.join(', ')
        : 'Already configured: ' + wanted.join(', '));
    } else if (head === 'no' && tokens[1] === 'ip' && tokens[2] === 'name-server') {
      // The page offers the removal with the address it configured, because that is how an IOS
      // removal is spoken: `no ip name-server 8.8.8.8`. A word that is not an address is refused.
      const badNs = tokens.slice(3).filter(function (a) { return !net.isIp(a); })[0];
      if (badNs) {
        return ['% Unexpected argument "' + badNs + '" - no ip name-server takes an address, or nothing',
          '% Usage: no ip name-server [<address> ...]'];
      }
      // A removal that names one address removes that address. This branch cleared **every**
      // configured server whatever was named, so `no ip name-server 8.8.4.4` also dropped 8.8.8.8 -
      // the same defect `no ipv6 gateway <addr>` had. A bare `no ip name-server` still clears all,
      // and says so, because that is the arithmetic it does.
      const named = tokens.slice(3);
      if (!named.length) {
        const had = (this.device.config.dnsServers || []).length;
        this.device.config.dnsServers = [];
        out.push(had ? 'Name servers cleared (' + had + ')' : 'No name servers were configured');
        return out;
      }
      const before = this.device.config.dnsServers || [];
      const kept = before.filter(function (s) { return named.indexOf(s) === -1; });
      const gone = before.filter(function (s) { return named.indexOf(s) !== -1; });
      const missing = named.filter(function (s) { return before.indexOf(s) === -1; });
      this.device.config.dnsServers = kept;
      if (gone.length) out.push('Name server' + (gone.length > 1 ? 's ' : ' ') + gone.join(', ') + ' removed');
      if (missing.length) {
        out.push('% Not a configured name server: ' + missing.join(', '),
          '% Configured: ' + (before.length ? before.join(', ') : '(none)'));
      }
    } else if (head === 'ospf') {
      // `ospf router-id 1.1.1.1` answered "OSPF enabled, router-id 1.1.1.1 area 0" on a **PC** and on
      // a **switch** - the same defect `router ospf 1` had, in the other spelling. The gate belongs on
      // the family, not on one entry point.
      if (typeof this.device.isL3 === 'function' && !this.device.isL3()) {
        return ['% ' + (this.device.name || this.device.id) +
          ' is not a router: OSPF describes paths between interfaces it can forward between',
          '% A host reaches other networks with "ip default-gateway <gw>"'];
      }
      out.push.apply(out, this._ospfConfig(tokens.slice(1)));
    } else if (head === 'no' && tokens[1] === 'ospf') {
      // `no ospf` ignored everything after it: `no ospf area 10`, `no ospf router-id 1.1.1.1` and even
      // `no ospf area -1` all disabled the whole process, while the page documents this row as "forget
      // the id, or one area". A value that cannot be an area id is judged before anything is touched.
      out.push.apply(out, this._noOspf(tokens.slice(2)));
    } else if (head === 'ip' && tokens[1] === 'route') {
      out.push.apply(out, this._ipRoute(tokens));
    } else if (head === 'no' && tokens[1] === 'ip' && tokens[2] === 'route') {
      out.push.apply(out, this._noIpRoute(tokens));
    } else if (head === 'ip' && tokens[1] === 'default-gateway') {
      out.push.apply(out, this._defaultGateway(tokens));
    } else if (head === 'no' && tokens[1] === 'ip' && tokens[2] === 'default-gateway') {
      const badGw = tokens.slice(3).filter(function (a) { return !net.isIp(a); })[0];
      if (badGw) {
        return ['% Unexpected argument "' + badGw + '" - no ip default-gateway takes an address, or nothing',
          '% Usage: no ip default-gateway [<address>]'];
      }
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
      // A real exec verb typed here is not a typo, and "% Unrecognized config command: write memory"
      // says it is. IOS refuses the same way but names the mode, which is the difference between
      // "you mistyped" and "you are one prompt away". `do` carries the read-only forms; `end` carries
      // the rest.
      const execVerbs = ['write', 'copy', 'reload', 'clear', 'ping', 'traceroute', 'tracert',
        'nslookup', 'enable', 'disable', 'configure', 'terminal'];
      const first = String(tokens[0] || '').toLowerCase();
      if (execVerbs.indexOf(first) !== -1) {
        out.push('% "' + tokens.join(' ') + '" is an exec command, not a configuration command');
        out.push('% "end" leaves the configuration and puts you back at privileged exec');
        // `do` carries reads only (`do show <...>`), so it is not offered here: a write, a ping or a
        // clear needs `end` first, and advice that cannot be followed is the defect, not the fix.
        out.push('% ("do" carries reads only - "do show <...>" - so this one needs "end" first)');
      } else {
        out.push('% Unrecognized config command: ' + tokens.join(' '));
      }
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
    // `interface range Fa0/1-4` and `interface Fa0/1-4` name several ports at once, and this model
    // keeps one block per port. Answering "% Unrecognized command" hid both halves: that the form
    // exists on a real device, and what the model keeps instead.
    {
      const first = String(tokens[0]).toLowerCase();
      const text = first === 'range' ? tokens.slice(1).join(',') : tokens.join(',');
      const listy = first === 'range' || /^[A-Za-z][A-Za-z-]*\d[\d/]*\s*[-,]/.test(tokens.join(' '));
      if (listy) {
        // The ports are read from the device, not expanded from the text: a name that is not on this
        // device is not offered as an example to type.
        const wanted = [];
        const re = /([A-Za-z][A-Za-z-]*)(\d+(?:\/\d+)*)(?:\s*-\s*(\d+))?/g;
        let m;
        while ((m = re.exec(text)) !== null) {
          const parts = m[2].split('/');
          const last = parseInt(parts[parts.length - 1], 10);
          const stop = m[3] === undefined ? last : parseInt(m[3], 10);
          for (let i = last; i <= stop && wanted.length < 64; i++) {
            const path = parts.slice(0, -1).concat([String(i)]).join('/');
            const resolved = resolvePortName(this.device, m[1] + path);
            if (resolved && wanted.indexOf(resolved) === -1) wanted.push(resolved);
          }
        }
        const sample = wanted.slice(0, 4).map(function (x) { return '"interface ' + x + '"'; }).join(', ');
        return {
          lines: ['% There is no "interface range" here - this console has one block per port',
            wanted.length
              ? '% The ports that form names are: ' + wanted.join(', ')
              : '% Name a port on this device: "show ip interface brief" lists them',
            sample
              ? '% Enter them one after another - ' + sample + (wanted.length > 4 ? ', ...' : '')
              : '% Enter them one after another, and "exit" between them'],
          name: null
        };
      }
    }
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
      // An SVI is the device's address in a VLAN, so that VLAN exists the moment the SVI does - the
      // same rule the access form follows, applied to the other carrier the table reads.
      const vlanCreated = this._declareVlan(vid);
      const svi = this.device.addSvi(vid);
      this.iface = svi.name;
      this.mode = MODE_IFACE;
      // Only a *new* object says so. Re-entering an SVI is not an event, and a paste that announces
      // every block it enters buries the one line that mattered.
      return {
        lines: existed ? [] : [svi.name + ' created - this device\'s own address in VLAN ' + vid +
          (vlanCreated ? ' (VLAN ' + vid + ' did not exist and was created)' : '')],
        name: svi.name
      };
    }
    // Both spellings of a port resolve here: the panel name from the spec and
    // the vendor-console name the operator may have typed (issue #27).
    // `interface GigabitEthernet 0/1` is one port name in two words, which is how a transcript writes
    // it. The type word alone is not a port, so it answered "% Interface not found: GigabitEthernet".
    let portWord = tokens[0];
    let consumed = 1;
    const indexed = tokens[1] !== undefined && /^\d+(?:\/\d+)*$/.test(String(tokens[1]));
    if (!resolvePortName(this.device, portWord) && indexed &&
        resolvePortName(this.device, String(portWord) + String(tokens[1]))) {
      portWord = String(portWord) + String(tokens[1]);
      consumed = 2;
    }
    let name = resolvePortName(this.device, portWord);
    // A word after the port is refused, not dropped: `interface Fa0/1 zzz` entered the block in
    // silence and the next lines configured a port the operator had not named - the same defect the
    // `show` family and the configuration blocks had, in the one command that moves the prompt.
    if (name && tokens.length > consumed) {
      return {
        lines: ['% Unexpected argument "' + tokens[consumed] + '" - interface <port> takes one port',
          '% A subinterface is "interface ' + name + '.10", and the device\'s own VLAN address is ' +
          '"interface vlan <id>"'],
        name: null
      };
    }
    if (!name) {
      // 'interface Gi0/0.10' creates a router subinterface on Gi0/0.
      const m = /^(.+)\.(\d+)$/.exec(portWord);
      const parent = m ? resolvePortName(this.device, m[1]) : null;
      if (m && parent) {
        const vid = parseInt(m[2], 10);
        if (!(vid >= 1 && vid <= 4094)) return { lines: ['% VLAN out of range: ' + m[2]], name: null };
        // A subinterface is a tag on a wire. An SVI has no wire - it is the address a VLAN answers
        // on - and creating one on it did two things nobody asked for: the parent SVI was rewritten
        // as a trunk with an empty allowed list, so VLAN 20 vanished from `show vlan`, and the child
        // was listed as a port of VLAN 1.
        const parentIface = this.device.interfaces.get(parent);
        if (parentIface && (parentIface.svi || parentIface.parent)) {
          return { lines: ['% ' + parent + ' is a logical interface - there is no wire to tag',
            parentIface.svi
              ? '% An SVI is the address its VLAN answers on; tag frames on the physical port'
              : '% A subinterface hangs off a physical port or a port-channel, not off another tag'],
            name: null };
        }
        this.device.addSubinterface(parent, vid);
        name = parent + '.' + vid;
        this.iface = name;
        this.mode = MODE_IFACE;
        // The VLAN tag comes from the interface number, which is a real convenience and also an
        // assumption: say it, and the `encapsulation dot1q` line the dump prints is no surprise.
        const inferred = String(name).indexOf('.') !== -1 ? String(name).split('.').pop() : null;
        const lines = ['Created subinterface ' + name + ' (parent ' + parent +
          (inferred ? ', dot1q ' + inferred + ' from the interface number' : '') + ')'];
        // A tag the port is not allowed to carry is configuration that forwards nothing - the same
        // class as a route statement that matches no interface. It is not refused here, because the
        // subinterface is configured before the trunk as often as after it, but it is said out loud
        // rather than left for the operator to discover from an empty flow.
        const pv = (this.device.interfaces.get(parent) || {}).vlan;
        if (pv && pv.mode === 'trunk' && Array.isArray(pv.allowedVlans) &&
            pv.allowedVlans.map(Number).indexOf(vid) === -1) {
          lines.push('  VLAN ' + vid + ' is not in ' + parent + '\'s allowed list (' +
            pv.allowedVlans.join(',') + '), so frames tagged ' + vid + ' are dropped there');
          lines.push('  Allow it with: interface ' + parent +
            ', then "switchport trunk allowed vlan add ' + vid + '"');
        }
        return { lines: lines, name: name };
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
      // Quote the spelling that was typed: a two-word port name that does not exist reported only the
      // type word, so "% Interface not found: GigabitEthernet" read as if the word were wrong.
      return { lines: ['% Interface not found: ' + (indexed ? portWord + ' ' + tokens[1] : portWord)],
        name: null };
    }
    this.iface = name;
    this.mode = MODE_IFACE;
    return { lines: [], name: name };
  }

  // `do show <…>` from inside a sub-mode is a read. It used to fall through to the global handler,
  // which treats a line it accepts as "you have left the block" - so one look at the interfaces
  // demoted the prompt from (config-if), (config-router) or (config-ext-nacl) to (config), and every
  // line after it was applied at the wrong level. (In the DHCP pool it was refused instead, which is
  // the other half of the same inconsistency.) Returns null when the line is not a `do show`.
  _doShowInMode(tokens) {
    if (String(tokens[0] || '').toLowerCase() !== 'do') return null;
    if (String(tokens[1] || '').toLowerCase() !== 'show') {
      return ['% do only supports "do show <...>" here',
        '% The prompt stays where it is: "exit" leaves this block, "end" leaves configuration'];
    }
    return this._show(tokens.slice(2));
  }


  // A word after a block command that takes no words was dropped on the floor, and the command ran:
  //
  //   SW1(config-if)#shutdown zzzz        -> "Fa0/1 administratively down"
  //   SW1(config-if)#no ip address zzzz   -> "IP address removed from Fa0/1"
  //   R1(config-dhcp)#no lease zzzz       -> accepted, nothing said
  //
  // These lines change state, so the empirical test used for `show` (compose the answer twice) is
  // not available here. Instead the block's own page is the contract: if a form of exactly this
  // shape is listed, the handler answers it; if the only thing that matched was an argument-less
  // form, the words after it are a mistake and are refused by the name of the command they follow.
  // Only argument-less forms are policed - an argument the console does read is judged by its
  // handler, which keeps free-text tails (`description uplink port`) working.
  // The exec verbs that take no word at all, longest spelling first so `write memory` is matched
  // before `write`. A word after one of them was dropped and the verb ran.
  _execStrayWord(tokens) {
    // `write` on its own is not here: its handler names the targets that exist, which is a better
    // refusal than "write takes no more".
    const NOWORD = ['copy running-config startup-config', 'configure terminal', 'clear ip nat translation *',
      'write memory', 'disable', 'enable', 'logout', 'quit', 'conf t', 'en'];
    if (!tokens || tokens.length < 2) return null;
    const typed = tokens.map(function (t) { return String(t).toLowerCase(); });
    // A line that is exactly one of these takes no extra word, so there is nothing to refuse - and
    // `write memory` must not be caught by the `write` entry.
    if (NOWORD.some(function (e) { return e === typed.join(' '); })) return null;
    // The longest spelling that matches wins, so `write memory` is not caught by `write`, and a
    // line that *is* an entry takes no extra word and is left alone.
    for (const entry of NOWORD.slice().sort(function (a, b) { return b.length - a.length; })) {
      const words = entry.split(' ');
      if (typed.length <= words.length) continue;
      let ok = true;
      for (let i = 0; i < words.length; i++) if (typed[i] !== words[i]) { ok = false; break; }
      if (!ok) continue;
      return ['% Unexpected argument "' + tokens.slice(words.length).join(' ') + '" - ' + entry + ' takes no more',
        '% Usage: ' + entry];
    }
    return null;
  }

  _blockStrayWord(tokens, mode) {
    if (!tokens || tokens.length < 2) return null;
    // Verbs that read their own words and say something better than "unexpected": `ip nat outside
    // inside` explains that a port cannot be on both sides, `channel-group 9` names the group the
    // port is not in, and the violation mode names the modes. The guard exists for the verbs that
    // say nothing at all, so these are left to their handlers.
    const OWN_WORDS = ['ip nat inside', 'ip nat outside', 'switchport port-security',
      'no switchport port-security', 'channel-group', 'no channel-group',
      'encapsulation dot1q', 'no encapsulation dot1q', 'power inline', 'no power inline',
      'switchport trunk allowed vlan', 'spanning-tree vlan'];
    const line = tokens.map(function (t) { return String(t).toLowerCase(); }).join(' ');
    for (const own of OWN_WORDS) {
      if (line === own || line.indexOf(own + ' ') === 0) return null;
    }
    let forms;
    try { forms = this._helpFormRowsAll(mode); } catch (e) { return null; }
    if (!Array.isArray(forms) || !forms.length) return null;
    const typed = tokens.map(function (t) { return String(t).toLowerCase(); });
    const exact = function (f) {
      if (f.tokens.length !== typed.length) return false;
      for (let i = 0; i < typed.length; i++) {
        const t = f.tokens[i];
        if (t && typeof t === 'object' && t.placeholder) continue;
        if (String(t).toLowerCase() !== typed[i]) return false;
      }
      return true;
    };
    if (forms.some(exact)) return null;
    // A block also answers global commands typed inside it (`ip nat inside source ...` after a pasted
    // `interface` line, which is how a device's own dump reads). If the line is a complete global
    // form, the block's job is to hand it on - not to refuse it for being longer than a local verb
    // that shares its first words (`ip nat inside`).
    if (mode !== MODE_CONFIG) {
      let globalForms;
      try { globalForms = this._helpFormRowsAll(MODE_CONFIG); } catch (e) { globalForms = null; }
      if (Array.isArray(globalForms) && globalForms.some(function (f) {
        if (!f.tokens || f.tokens.length !== typed.length) return false;
        for (let i = 0; i < typed.length; i++) {
          const t = f.tokens[i];
          if (t && typeof t === 'object' && t.placeholder) continue;
          if (String(t).toLowerCase() !== typed[i]) return false;
        }
        return true;
      })) return null;
    }
    let best = null;
    for (const f of forms) {
      if (!f.tokens.length || f.tokens.length >= typed.length) continue;
      if (f.tokens.some(function (t) { return !!t && typeof t === 'object'; })) continue;
      let ok = true;
      for (let i = 0; i < f.tokens.length; i++) {
        if (String(f.tokens[i]).toLowerCase() !== typed[i]) { ok = false; break; }
      }
      if (ok && (!best || f.tokens.length > best.tokens.length)) best = f;
    }
    if (!best) return null;
    // Alternatives are named together, in the order the page lists them: the row reads
    // `switchport mode access|trunk`, so the refusal that names only `trunk` looks like a different
    // command from the one on the page.
    const samePrefix = function (f) {
      if (f.tokens.length !== best.tokens.length) return false;
      for (let i = 0; i < f.tokens.length; i++) {
        const last = i === f.tokens.length - 1;
        if (last) continue;
        if (String(f.tokens[i]).toLowerCase() !== String(best.tokens[i]).toLowerCase()) return false;
      }
      return true;
    };
    const siblings = forms.filter(samePrefix).map(function (f) { return String(f.tokens[f.tokens.length - 1]); });
    const head = best.tokens.slice(0, -1).join(' ');
    const extraWord = String(tokens[best.tokens.length] || '').toLowerCase();
    // ...but only when the stray word is itself the other alternative: `switchport mode trunk access`
    // reads as "both modes", while `no lldp transmit extra` is simply a word too many after one
    // command and is named as that command.
    const words = (siblings.length > 1 &&
      siblings.some(function (s) { return s.toLowerCase() === extraWord; }))
      ? head + ' ' + siblings.join('|')
      : best.tokens.join(' ');
    // The same sentence `_noExtra` prints, so a handler that already validates and this guard that
    // catches the rest read as one console rather than two. The words are echoed as typed, not
    // lowercased: `no hostname FOO` is refused for "FOO".
    return ['% Unexpected argument "' + tokens.slice(best.tokens.length).join(' ') + '" - ' + words + ' takes no more',
      '% Usage: ' + words];
  }

  _ifaceMode(tokens) {
    const out = [];
    const head = tokens[0].toLowerCase();
    const doShow = this._doShowInMode(tokens);
    if (doShow) return doShow;
    // The same capability gate the configuration dispatcher uses: the last pass closed the removals in
    // configuration mode and left the interface block open, so a camera still answered
    // `no spanning-tree cost` with "the speed-derived default" for a cost it does not have.
    const gate = this._capabilityGate(tokens);
    if (gate) return gate;
    const stray = this._blockStrayWord(tokens, MODE_IFACE);
    if (stray) return stray;

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
      const mine = groups.filter(function (g) {
        return g.vrid === vrid && g.interface === this.iface;
      }, this)[0];
      if (!mine) {
        return ['% No VRRP group ' + tokens[2] + ' on ' + this.iface,
          '% "show vrrp" lists the groups configured on this device'];
      }
      // Everything after the id names the part to remove. `no vrrp 1 ip 10.0.0.99` used to remove
      // the **whole group** whether or not it owned that address: naming a different virtual address
      // deleted a working gateway and said "VRRP group 1 removed", which is the one answer an
      // operator would not question. The address is checked, and a full removal is the bare form.
      const rest = tokens.slice(3).map(function (x) { return String(x).toLowerCase(); });
      const ips = Array.isArray(mine.ips) ? mine.ips.slice() : [];
      if (!rest.length) {
        this.device.config.vrrp = groups.filter(function (g) { return g !== mine; });
        return ['VRRP group ' + vrid + ' removed from ' + this.iface +
          (ips.length ? ' (it owned ' + ips.join(', ') + ')' : '')];
      }
      if (rest[0] === 'ip') {
        const addr = tokens[4] === undefined ? null : String(tokens[4]);
        if (!addr) {
          if (!ips.length) return ['% Group ' + vrid + ' owns no virtual address on ' + this.iface];
          this.device.config.vrrp = groups.filter(function (g) { return g !== mine; });
          return ['VRRP group ' + vrid + ' on ' + this.iface + ' removed - it owned ' +
            ips.join(', ') + ' and a group with no virtual address has nothing to be master of'];
        }
        if (ips.indexOf(addr) === -1) {
          return ['% Group ' + vrid + ' on ' + this.iface + ' does not own ' + addr,
            '% It owns: ' + (ips.length ? ips.join(', ') : '(no virtual address)'),
            '% "no vrrp ' + vrid + '" removes the group itself'];
        }
        mine.ips = ips.filter(function (x) { return x !== addr; });
        if (!mine.ips.length) {
          // The last address went with it: a group that owns no virtual address is not a gateway, and
          // this console has no state for one - IOS's VRRP group exists while it owns an address.
          this.device.config.vrrp = groups.filter(function (g) { return g !== mine; });
          return ['VRRP group ' + vrid + ' on ' + this.iface + ' removed - ' + addr +
            ' was its only virtual address'];
        }
        return ['VRRP group ' + vrid + ' on ' + this.iface + ' no longer owns ' + addr];
      }
      if (rest[0] === 'priority') {
        const had = mine.priority;
        mine.priority = 100;
        return ['VRRP group ' + vrid + ' priority back to the default 100 (was ' + had + ')'];
      }
      if (rest[0] === 'preempt') {
        // `no vrrp <id> preempt` is not "reset to the default": preempt *is* on by default, and the
        // removal is how it is turned off (IOS). Reading it as a reset forced preempt back on and
        // then dumped nothing, so a configured "preempt off" was lost on every save and reload.
        const had = mine.preempt !== false;
        mine.preempt = false;
        return [had
          ? 'VRRP group ' + vrid + ' preempt off - a higher-priority router will not take the ' +
            'virtual address back'
          : 'VRRP group ' + vrid + ' preempt was already off'];
      }
      return ['% Unexpected argument "' + tokens[3] + '" for no vrrp ' + vrid,
        '% Usage: no vrrp <vrid> [ip [<address>] | priority | preempt]',
        '% "no vrrp ' + vrid + '" removes the group'];
    }
    if (head === 'ip' && tokens[1] === 'address') {
      if (String(tokens[2]).toLowerCase() === 'dhcp') {
        // `ip address dhcp zzzz` turned the port into a DHCP client and dropped the word. The page
        // lists the form as argument-less, so a word after it is a mistake, not a setting.
        const extraDhcp = this._noExtra(tokens, 3, 'ip address dhcp');
        if (extraDhcp) return extraDhcp;
        iface.dhcp = true;
        // Asking for an address again is the third way out of a released lease, after `renew dhcp`.
        iface.dhcpReleased = false;
        out.push('Interface ' + iface.name + ' set to DHCP');
      } else {
        // `secondary` is an IOS keyword, not a typo, so it is answered as a limitation before the
        // mask is judged - otherwise `ip address 10.0.0.1/24 secondary` was told that "secondary"
        // is not a contiguous mask, which is true and useless.
        if (tokens.some(function (t, i) { return i >= 2 && String(t).toLowerCase() === 'secondary'; })) {
          return ['% "secondary" is not modelled - one address per interface in this lab',
            '% Use a subinterface ("interface Gi0/0.10") for a second subnet on the same cable'];
        }
        let ip = tokens[2];
        let mask = tokens[3];
        // A word left over after a `10.0.0.1/24` address is the third token, not the fourth: the
        // prefix form already carries its mask, so anything after it is extra.
        let leftover = null;
        // `ip address 10.0.0.1/24` is the *same fact* as `10.0.0.1 255.255.255.0`, and it is the form
        // this console prints everywhere (`show ip interface brief`, `show running-config`, every table
        // with an Address column) and the form `ipv6 address` already accepts. Refusing what it prints
        // is the same asymmetry as a port name the config parser takes and the show commands do not.
        if (ip && String(ip).indexOf('/') !== -1) {
          const split = String(ip).split('/');
          ip = split[0];
          mask = split[1];
          if (tokens[3] !== undefined) leftover = tokens[3];
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
        // A router address is a *host* address in its own subnet, on exactly one interface. Every
        // rule below was violated silently before this: `ip address 0.0.0.0 0.0.0.0` became an
        // interface address of 0.0.0.0/0 (a default route worn as a port), `ip address 10.0.0.255
        // 255.255.255.0` took the subnet's broadcast address, `ip address 10.0.0.1 255.0.255.0`
        // printed "10.0.0.1/8" for a mask that is not a mask, the same address could sit on two
        // interfaces (so `show ip interface brief` had two owners for one address), and `secondary`
        // was dropped from the line while the answer said "IP address set".
        const addrInt = net.ipToInt(ip);
        if (!net.isContiguousMask(mask)) {
          return ['% ' + mask + ' is not a contiguous mask - the ones must all be on the left',
            '% Try 255.255.255.0, or the prefix form "ip address ' + ip + '/24"'];
        }
        const maskInt = net.maskToInt(mask);
        const prefix = net.prefixOf(mask);
        if (addrInt === 0 || addrInt === 0xffffffff) {
          return ['% ' + ip + ' is not a host address, so no interface can hold it'];
        }
        // A mask of 0.0.0.0 is contiguous by the bit test (no bits set) and was accepted, giving an
        // interface whose "subnet" is nothing and whose prefix is /0 - the default route worn as a
        // port. IOS refuses this mask for an interface, and so does this console now.
        if (maskInt === 0) {
          return ['% 0.0.0.0 addresses nothing - an interface mask has to have at least a /1',
            '% The smallest useful ones here: 255.255.255.252 (/30), 255.255.255.255 (/32) on a loopback'];
        }
        // Class D (224.0.0.0/4) is multicast and class E (240.0.0.0/4) is reserved: neither is an
        // address a host can hold, so `ip address 224.0.0.1 255.255.255.0` was an interface in a
        // multicast group - reachable by nothing and matched by every multicast route.
        if (addrInt >= 0xe0000000) {
          return ['% ' + ip + ' is a ' + (addrInt >= 0xf0000000 ? 'reserved (class E)' : 'multicast (class D)') +
            ' address, so no interface can hold it',
            '% A router address is a unicast host address in its own subnet'];
        }
        if (prefix <= 30) {
          const netAddr = (addrInt & maskInt) >>> 0;
          const bcast = (netAddr | ((~maskInt) >>> 0)) >>> 0;
          if (addrInt === netAddr) {
            return ['% ' + ip + ' is the network address of ' + net.intToIp(netAddr) + '/' + prefix +
              ' - a router address must be a host in its own subnet',
              '% Try ' + net.intToIp((netAddr + 1) >>> 0) + ', or a wider mask'];
          }
          if (addrInt === bcast) {
            return ['% ' + ip + ' is the broadcast address of ' + net.intToIp(netAddr) + '/' + prefix +
              ' - a router address must be a host in its own subnet',
              '% Try ' + net.intToIp((bcast - 1) >>> 0) + ', or a wider mask'];
          }
        }
        for (const other of this.device.interfaces.values()) {
          if (other === iface || !other.ip) continue;
          if (other.ip === ip) {
            return ['% ' + ip + ' is already on ' + other.name + ' - one address cannot be on two interfaces'];
          }
          let otherMask = null;
          try { otherMask = net.maskToInt(other.mask); } catch (e) { otherMask = null; }
          if (otherMask === null) continue;
          const otherPrefix = net.prefixOf(other.mask);
          if (prefix > 30 || otherPrefix > 30) continue;
          // `>>> 0` on the low ends: without it these are signed 32-bit results, and a subnet whose
          // network address has the top bit set compares as a negative number - which made
          // 192.168.0.0/24 "overlap" 10.0.0.0/24.
          const aLo = (addrInt & maskInt) >>> 0;
          const aHi = (aLo | ((~maskInt) >>> 0)) >>> 0;
          const bLo = (net.ipToInt(other.ip) & otherMask) >>> 0;
          const bHi = (bLo | ((~otherMask) >>> 0)) >>> 0;
          if (aLo <= bHi && bLo <= aHi) {
            // Overlapping subnets on two interfaces make "which port does this address leave by"
            // unanswerable, which is the question every ping in this lab asks.
            return ['% ' + net.intToIp(aLo) + '/' + prefix + ' overlaps ' + other.name + ' (' +
              other.ip + '/' + otherPrefix + ') - two interfaces in one subnet is ambiguous',
              '% A router routes between subnets: give this interface a different one'];
          }
        }
        const extra = leftover === null ? tokens[4] : leftover;
        if (extra !== undefined) {
          return ['% Unexpected argument "' + extra + '" - ip address <ip> <mask> takes no more' +
            ' ("ip address ' + ip + ' ' + net.intToIp(maskInt) + '")'];
        }
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
      // A port err-disabled by port security is administratively enabled and operationally down.
      // Its recovery is this command (IOS: `shutdown` then `no shutdown`), so the answer says what
      // recovered and what was kept - the violation count is evidence and deleting it would hide
      // the reason the port went down.
      const recovered = psLib.recover(this.device, iface.name);
      out.push(iface.name + ' up');
      if (recovered) {
        const st = psLib.peek(this.device, iface.name);
        out.push('  err-disable cleared: ' + recovered);
        out.push('  Security violation count kept at ' + (st ? st.violations : 0) +
          ' - "clear port-security counters" resets it');
      }
    } else if (head === 'mtu' || (head === 'no' && tokens[1] === 'mtu')) {
      out.push.apply(out, this._portMtu(head === 'no' ? tokens.slice(2) : tokens.slice(1), iface, head === 'no'));
    } else if (head === 'speed' || (head === 'no' && tokens[1] === 'speed')) {
      out.push.apply(out, this._portSpeed(head === 'no' ? tokens.slice(2) : tokens.slice(1), iface, head === 'no'));
    } else if (head === 'duplex' || (head === 'no' && tokens[1] === 'duplex')) {
      out.push.apply(out, this._portDuplex(head === 'no' ? tokens.slice(2) : tokens.slice(1), iface, head === 'no'));
    } else if ((head === 'lldp' || (head === 'no' && tokens[1] === 'lldp')) &&
               ['transmit', 'receive'].indexOf(String(tokens[head === 'no' ? 2 : 1] || '').toLowerCase()) !== -1) {
      const isNo = head === 'no';
      const dir = String(tokens[isNo ? 2 : 1]).toLowerCase();
      out.push.apply(out, this._portLldp(isNo, dir, iface, isNo ? tokens.slice(3) : tokens.slice(2)));
    } else if (head === 'power' && tokens[1] === 'inline') {
      out.push.apply(out, this._portPowerInline(tokens.slice(2), iface, false));
    } else if (head === 'no' && tokens[1] === 'power' && tokens[2] === 'inline') {
      out.push.apply(out, this._portPowerInline(tokens.slice(3), iface, true));
    } else if (head === 'no' && tokens[1] === 'encapsulation' &&
               String(tokens[2] || '').toLowerCase().indexOf('dot1') === 0) {
      // Every other verb in this block has a `no` form; `encapsulation dot1q` did not, so the tag
      // could be set and never taken back.
      if (!iface.parent) {
        // The advice has to be advice this device can take. On a router the old second line said
        // "a switch trunk does that with switchport" - and `switchport` on a router answers
        // "R1 does not switch - it has no switchports". A router tags with a subinterface; a switch
        // port tags by being made a trunk. Both spellings run where they are named.
        const switches = typeof this.device.isL2 === 'function' && this.device.isL2();
        return ['% ' + iface.name + ' is not a subinterface - only a subinterface carries a tag',
          switches
            ? '% A physical port is untagged on the wire; make it carry tags with ' +
              '"switchport mode trunk" in this interface'
            : '% A routed port is untagged; tag it with a subinterface: "interface ' + iface.name +
              '.10", then "encapsulation dot1q 10"'];
      }
      if (tokens.length > 3) {
        return ['% Unexpected argument "' + tokens[3] + '" - no encapsulation dot1q takes no more'];
      }
      // The tag lives on `encapVid`, and a subinterface is *born* with one inferred from its number,
      // so removing a tag means going back to that number - not to "no tag at all", which a
      // subinterface cannot be.
      const inferred = Number(String(iface.name).split('.')[1]);
      const was = iface.encapVid;
      if (!Number.isFinite(inferred)) {
        delete iface.encapVid;
        return ['Encapsulation removed from ' + iface.name];
      }
      if (was === inferred) {
        return ['Encapsulation on ' + iface.name + ' is already the inferred VLAN ' + inferred,
          '% It was tagged at creation from the interface number; nothing to remove'];
      }
      iface.encapVid = inferred;
      return ['Encapsulation removed from ' + iface.name + (was === undefined ? '' : ' (was VLAN ' + was + ')') +
        ' - back to the tag inferred from the interface number, VLAN ' + inferred];
    } else if (head === 'ip' && tokens[1] === 'nat') {
      // `show running-config` prints its rules after the interface blocks, so a paste delivers
      // `ip nat inside source …` while the session is still inside an interface. That is a global
      // command, not this port's side, and swallowing it as "ip nat inside takes no more" is how a
      // paste silently loses every NAT rule on the device.
      const rest = tokens.slice(2).map(function (x) { return String(x).toLowerCase(); });
      if (rest[0] === 'inside' && rest[1] === 'source') {
        out.push.apply(out, this._ipNatConfig(tokens.slice(2)));
      } else {
        out.push.apply(out, this._ipNatIface(tokens.slice(2), iface));
      }
    } else if (head === 'no' && tokens[1] === 'ip' && tokens[2] === 'nat' &&
               String(tokens[4] || '').toLowerCase() === 'source') {
      out.push.apply(out, this._noIpNatConfig(tokens.slice(3)));
    } else if (head === 'no' && tokens[1] === 'ip' && tokens[2] === 'nat') {
      const which = String(tokens[3] || '').toLowerCase();
      // A refusal without the `%` marker is not a refusal to anyone grepping a transcript - and these
      // two change nothing, so they are refusals. The sentence stays; the marker is what was missing.
      if (!iface.natRole) {
        const dev = this.device;
        out.push('% Interface ' + iface.name + ' is not a NAT interface - there is no role to remove' +
          (typeof dev.hasCap === 'function' && dev.hasCap('nat')
            ? '' : ' (and ' + (dev.name || dev.id) + ' does not translate addresses at all)'));
      } else if (which !== 'inside' && which !== 'outside') {
        out.push('% Incomplete command: no ip nat inside|outside');
      } else if (which !== iface.natRole) {
        out.push('% Interface ' + iface.name + ' is NAT ' + iface.natRole + ', not ' + which);
      } else {
        const was = iface.natRole;
        delete iface.natRole;
        out.push('Interface ' + iface.name + ' is no longer NAT ' + was);
      }
    } else if (head === 'spanning-tree') {
      out.push.apply(out, this._stpIface(tokens.slice(1), iface));
    } else if (head === 'no' && tokens[1] === 'spanning-tree') {
      const rest = tokens.slice(2);
      const what = String(rest[0] || '').toLowerCase();
      if (what === 'cost') {
        if (iface.stpCost === undefined) {
          out.push('Spanning tree cost on ' + iface.name + ' is already the speed-derived default');
        } else {
          const was = iface.stpCost;
          delete iface.stpCost;
          out.push('Spanning tree cost on ' + iface.name + ' back to the speed-derived default (was ' + was + ')');
        }
      } else {
        out.push.apply(out, this._stpIface(rest, iface));
      }
    } else if (head === 'ipv6' && tokens[1] === 'address') {
      out.push.apply(out, this._ipv6Iface(tokens.slice(2), iface));
    } else if (head === 'no' && tokens[1] === 'ipv6' && tokens[2] === 'address') {
      if (String(tokens[3] || '').toLowerCase() === 'autoconfig') {
        out.push.apply(out, this._noAutoconfig(iface));
      } else {
        // The word after `address` is an address or a length, and `no ipv6 address zzzz` used to
        // remove the address anyway - an accepted line whose argument was never read.
        const what6 = String(tokens[3] || '');
        const looksV6 = /^[0-9a-fA-F:]+(\/\d{1,3})?$/.test(what6) && what6.indexOf(':') !== -1;
        if (what6 && !looksV6 && !/^\d+$/.test(what6)) {
          return ['% "' + tokens.slice(3).join(' ') + '" is not an address or a prefix length',
            '% Usage: no ipv6 address [<address>|<length>|autoconfig]'];
        }
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
    } else if (head === 'switchport' && tokens[1] === 'port-security') {
      out.push.apply(out, this._portSecurity(tokens.slice(2), iface, false));
    } else if (head === 'no' && tokens[1] === 'switchport' && tokens[2] === 'port-security') {
      out.push.apply(out, this._portSecurity(tokens.slice(3), iface, true));
    } else if (head === 'switchport') {
      out.push.apply(out, this._switchport(tokens.slice(1), iface));
    } else if (head === 'no' && tokens[1] === 'switchport') {
      // `no switchport <what>` used to map every spelling onto a full reset, so
      // `no switchport trunk allowed vlan 10` wiped the port's mode, native VLAN and access VLAN
      // instead of removing VLAN 10 from a list - a targeted command answering with a broad one.
      out.push.apply(out, this._switchport(['no'].concat(tokens.slice(2)), iface));
    } else if (head === 'channel-group') {
      out.push.apply(out, this._channelGroup(tokens.slice(1), iface));
    } else if (head === 'no' && tokens[1] === 'channel-group') {
      out.push.apply(out, this._channelGroup(['no'].concat(tokens.slice(2)), iface));
    } else if (head === 'description') {
      // `description` with nothing after it answered "Description set" - a confirmation that set an
      // empty description, i.e. cleared one while reporting that it had been written.
      const text = tokens.slice(1).join(' ').trim();
      if (!text) {
        return out.concat(['% Incomplete command: description <text>',
          '% To clear a description: "no description"']);
      }
      iface.description = text;
      out.push('Description set on ' + iface.name + ': "' + text + '"');
    } else if (head === 'no' && tokens[1] === 'description') {
      // Silence here was the other half of the same problem: a clear and a typo looked identical.
      const had = String(iface.description || '').trim();
      iface.description = '';
      out.push(had
        ? 'Description cleared on ' + iface.name + ' (was "' + had + '")'
        : 'No description on ' + iface.name + ' - nothing to clear');
    } else if (head === 'exit') {
      this.mode = MODE_CONFIG;
    } else if (head === 'end') {
      this.mode = this._modeAfterConfig();
    } else if (head === 'show') {
      out.push.apply(out, this._show(tokens.slice(1)));
    } else {
      // Nothing in this block claimed the line. A global command typed inside an interface block is
      // applied at global scope - that is what lets a pasted `show running-config` run start to
      // finish, since the dump prints no `exit` between an interface stanza and the globals. The
      // block itself is kept: the dump re-enters one with its next `interface` line, and a person
      // typing a port's configuration is not made to notice that one of their lines was global.
      const asGlobal = this._configMode(tokens);
      // Any refusal counts, not just the one wording. `ipv6 nd ra suppress extra` fell through,
      // was refused by the global handler with its *own* sentence ("% Unknown IPv6 RA command"),
      // and the check below only knew to look for "% Unrecognized config command" - so the refusal
      // was treated as success, the interface block was left, and the operator's next three commands
      // were typed into the wrong mode. A line beginning with `%` is a refusal, whoever wrote it.
      const refused = asGlobal.some(function (l) { return /^%/.test(l); });
      if (refused) {
        // "Unrecognized" is only honest when nothing recognised the words. When the global handler
        // knew what they meant and refused for a reason - `ipv6 nd suppress-ra` on a switch, which
        // cannot route what a prefix would attract - that reason *is* the answer, and prefixing it
        // with "Unrecognized interface command" buries it under a claim that is not true.
        const generic = asGlobal.length === 1 &&
          /^% (Unrecognized|Unknown|Invalid) (config )?command/.test(asGlobal[0]);
        return generic
          ? ['% Unrecognized interface command: ' + tokens.join(' ')].concat(asGlobal)
          : asGlobal;
      }
      // The block is NOT left. It used to be, on the theory that a pasted dump carries no `exit`
      // between its last interface stanza and the globals - true, and still served, because the
      // global line applies either way and the dump's next `interface` line re-enters a block. What
      // the eviction cost was the *person*: `ip default-gateway …` typed inside an interface block
      // dropped the prompt to (config)#, and the next line they typed for the port - `ipv6 address
      // 2001:db8:9::50/64` - was read as a global command and refused. A dual-stack port configured
      // in three lines came out with no IPv6 address at all.
      out.push.apply(out, asGlobal);
      // Say so. `ospf area 0` inside an interface block is the *global* command: it configures the
      // process, not the port, and the block is left behind. Applying it silently is how an operator
      // concludes the interface is in area 0 when it is not - the fall-through exists so a pasted
      // running-config runs start to finish, not to make a meaning change invisible.
      //
      // The note used to end "(the per-port form is "ip <first word> ...")" whatever the command
      // was, which for `ipv6 nd suppress-ra` suggested `ip ipv6 ...` - a form that does not exist.
      // A note that invents a command is worse than no note.
      const perPort = this._perPortForm(tokens);
      out.push('  note: "' + tokens.join(' ') + '" is a global command - applied at global scope; ' +
        'you are still in this interface block' +
        (perPort ? ' (the per-port form is "' + perPort + '")' : ''));
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

  // Which ports carry which VLANs - one walk, so the table, the refusal in `no vlan` and the 404 in
  // `show vlan <id>` cannot disagree about who is in a VLAN. Each entry carries the decoration the
  // table prints: `(t)` for a trunk member, `(n)` for the native VLAN, `(trunk)` for a trunk that
  // allows them all and therefore has no list to name.
  // A VLAN has one source of truth: the configuration. Any command that names a VLAN something
  // carries - an access port, a voice VLAN, a trunk native VLAN, an SVI - creates it when it does not
  // exist, and says so. Without this `show vlan` described a bridge domain the saved configuration
  // did not contain, so the table and the dump disagreed about what the device had.
  _declareVlan(id) {
    const vid = Number(id);
    if (!(vid >= 1) || vid === 1) return false;      // VLAN 1 always exists and never needs a stanza
    if (!this.device.config.vlans) this.device.config.vlans = {};
    if (this.device.config.vlans[vid] !== undefined) return false;
    this.device.config.vlans[vid] = { name: 'VLAN' + String(vid).padStart(4, '0') };
    return true;
  }

  _vlanMap(dev) {
    const by = new Map();
    const add = function (id, text) {
      if (!by.has(id)) by.set(id, []);
      by.get(id).push(text);
    };
    for (const i of dev.interfaces.values()) {
      // A subinterface is a tag on its parent, not a port in a bridge domain: it has no cable and
      // no membership. It was listed in a column headed Ports under VLAN 1 - wrong twice, since it
      // is not a port and its tag was 30. The VLAN it tags is carried by the parent, which is
      // already in the table under its own memberships.
      if (i.parent) continue;
      const v = i.vlan || { mode: 'access', accessVlan: 1 };
      if (v.mode === 'trunk') {
        const native = Number(v.nativeVlan) || 1;
        const all = v.allowedVlans === 'all' || !Array.isArray(v.allowedVlans);
        if (all) add('all', i.name + '(trunk)');
        for (const id of (all ? [native] : v.allowedVlans.map(Number))) {
          add(id, i.name + (Number(id) === native ? '(n)' : '(t)'));
        }
        // A voice VLAN is carried by the port that names it, tagged like the rest of the trunk -
        // and it is the one thing this table would otherwise omit while the port really does
        // carry it.
        if (Number(v.voiceVlan)) add(Number(v.voiceVlan), i.name + '(v)');
      } else {
        // An SVI is the device's own address in a VLAN, not a port that carries it. IOS does not
        // list it in this column; the model shows it marked, because "which VLAN is my management
        // address on" is a question the table can answer, and `Vlan20` sitting in a column headed
        // Ports answered it as though a cable plugged into itself.
        add(Number(v.accessVlan) || 1, i.svi ? i.name + ' (SVI)' : i.name);
        // The phone port: untagged data in the access VLAN, tagged voice in its own. Both are
        // memberships, so both are in the column.
        if (!i.svi && Number(v.voiceVlan)) add(Number(v.voiceVlan), i.name + '(v)');
      }
    }
    return by;
  }

  // Who would break if a VLAN went away. Two different dependencies, and they are not the same fact:
  // a port whose *own* classification is that VLAN (an access port, or a trunk's native VLAN) cannot
  // go on without it, while a trunk that merely lists it in an allowed list can simply stop listing
  // it. Folding them together would either refuse a removal that is perfectly possible or allow one
  // that silently strands a port.
  _vlanDependents(dev, id) {
    const want = Number(id);
    const hard = [], listed = [], svis = [];
    for (const i of dev.interfaces.values()) {
      const v = i.vlan || { mode: 'access', accessVlan: 1 };
      // An SVI is not a port: it cannot be moved with `switchport access vlan`, so it is reported
      // separately and removed with `no interface vlan <id>`.
      if (i.svi) {
        if ((Number(v.accessVlan) || 1) === want) svis.push(i.name);
        continue;
      }
      if (v.mode === 'trunk') {
        if ((Number(v.nativeVlan) || 1) === want) hard.push(i.name + ' (native)');
        else if (Array.isArray(v.allowedVlans) &&
          v.allowedVlans.map(Number).indexOf(want) !== -1) listed.push(i.name);
      } else if ((Number(v.accessVlan) || 1) === want) {
        hard.push(i.name);
      }
    }
    return { hard: hard, listed: listed, svis: svis };
  }

  // One spelling of a flow id, shared by every door: `flow-3` and `3` are the same flow, and
  // anything else is not an id at all. Returns the canonical key, or null when the token cannot be
  // one - which keeps "wrong shape" and "no such flow" as two different answers.
  _flowId(token) {
    const text = String(token === undefined || token === null ? '' : token).trim().toLowerCase();
    if (!text) return null;
    const m = /^(?:flow-)?(\d+)$/.exec(text);
    return m ? 'flow-' + m[1] : null;
  }

  // An argument the command does not use must be refused by name, because ignoring it is
  // indistinguishable from honouring it. This console has been bitten by that shape five times now -
  // a port ignored by nine shows, an instant read as a destination, `ping at 5000` asking DNS about
  // `at`, `show vlan 99` printing every VLAN, `converge 100 extra` converging anyway - and each one
  // looked like an answer. One wording, so the next command that grows an argument inherits it.
  _noExtra(tokens, from, usage) {
    const extra = tokens.slice(from).filter(function (t) { return String(t).length; });
    if (!extra.length) return null;
    return ['% Unexpected argument "' + extra.join(' ') + '" - ' + usage + ' takes no more',
      '% Usage: ' + usage];
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
    // A matched route whose next hop no port can reach is the answer to "why does this drop", and
    // the lookup said nothing about it: `Interface -` is a dash, and the reason lived in the log.
    if (!route.iface && route.via) {
      const noWire = Array.from(dev.interfaces.values()).every(function (i) {
        if (i.enabled === false || !i.ip || !i.mask) return true;
        try {
          const m = net.ipToInt(i.mask);
          return ((net.ipToInt(route.via) & m) >>> 0) !== ((net.ipToInt(i.ip) & m) >>> 0);
        } catch (e) { return true; }
      });
      if (noWire) {
        out.push('  Reachability ' + route.via + ' is not on any connected subnet of this device' +
          ', and no route covers it');
        out.push('               so a packet matched here is dropped before it leaves: the drop ' +
          'reason is on "show logging"');
      }
    }
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
    // `encapsulation dot1q` with no value answered `% VLAN out of range: ` - an empty value in a
    // range complaint - and `encapsulation dot1q abc` answered `% VLAN out of range: abc`, which calls
    // a word out of range instead of not a number.
    const vidText = t[1];
    if (vidText === undefined) {
      return ['% Incomplete command: encapsulation dot1q <vlan-id>',
        '% e.g. "encapsulation dot1q 10" for the VLAN this subinterface carries'];
    }
    if (!/^\d+$/.test(String(vidText))) {
      return ['% VLAN id must be a number, not "' + vidText + '"',
        '% Usage: encapsulation dot1q <vlan-id>'];
    }
    const vid = parseInt(vidText, 10);
    if (!(vid >= 1 && vid <= 4094)) {
      return ['% VLAN ' + vidText + ' is outside 1-4094',
        '% Usage: encapsulation dot1q <vlan-id>'];
    }
    const trailing = this._noExtra(t, 2, 'encapsulation dot1q <vlan-id>');
    if (trailing) return trailing;
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
    const dev = this.device;
    const usage = 'ipv6 address <addr>/<len> | autoconfig';
    // `ipv6 address` with nothing after it used to answer % Invalid IPv6 address "" - an empty
    // string quoted back at the operator, which reads as though a word was sent and rejected.
    if (!tokens.length) return ['% Incomplete command: ' + usage];
    const spec = String(tokens[0]);

    // 'ipv6 address autoconfig': the address comes from a router advertisement.
    // Any address typed in by hand is removed, because two sources of truth for
    // one address is how a lab ends up "not working" with nothing to look at.
    if (spec.toLowerCase() === 'autoconfig') {
      const extra = this._noExtra(tokens, 1, 'ipv6 address autoconfig');
      if (extra) return extra;
      if (dev.config.ip6) delete dev.config.ip6[iface.name];
      iface.autoconfig = true;
      return ['IPv6 address autoconfig on ' + iface.name +
        ' (no address until a router advertisement arrives)'];
    }

    // Every word after the address is refused rather than dropped: `ipv6 address 2001:db8:1::2/64
    // extra` answered "IPv6 address 2001:db8:1::2/64 on Gi0/0" and threw `extra` away, which is
    // the same defect the `switchport` verbs had one layer down.
    const extra = this._noExtra(tokens, 1, usage);
    if (extra) return extra;
    const parts = spec.split('/');
    if (parts.length !== 2) {
      return ['% Incomplete command: ' + usage,
        '% an IPv6 interface address is written <addr>/<len>, e.g. 2001:db8:1::1/64'];
    }
    const parsed = v6.parseIpv6(parts[0]);
    if (!parsed.valid) return ['% Invalid IPv6 address "' + parts[0] + '"'];
    const len = /^\d+$/.test(parts[1]) ? parseInt(parts[1], 10) : NaN;
    if (!(len >= 0 && len <= 128)) return ['% Invalid prefix length "' + parts[1] + '"'];
    const addr = v6.formatIpv6(parsed.groups);
    // What a port may hold. `ipv6 address ff02::1/64` was accepted and then produced a *connected
    // route* for `ff02::/64` in `show ipv6 route` - a multicast group worn as a subnet, derived by
    // the same code that derives real ones. The address is refused by name instead.
    if (v6.isLoopback6(addr)) {
      return ['% ' + addr + ' is the loopback address - it cannot be assigned to ' + iface.name];
    }
    if (v6.isMulticast(addr)) {
      return ['% ' + addr + ' is a multicast address - a port cannot hold one'];
    }
    if (/^0(:0)*$/.test(addr) || addr === '::') {
      return ['% ' + addr + ' is the unspecified address - a port cannot hold it'];
    }
    if (v6.isLinkLocal(addr)) {
      return ['% ' + addr + ' is link-local - ' + iface.name +
        ' already has one derived from its MAC address'];
    }
    if (!dev.config.ip6) dev.config.ip6 = {};
    // The same address twice, or the same address on two ports, is not a configuration.
    for (const other of dev.interfaces.values()) {
      const e = dev.config.ip6[other.name];
      if (!e || e.addr !== addr) continue;
      if (other.name === iface.name) {
        return ['IPv6 address ' + addr + '/' + len + ' on ' + iface.name + ' (already configured)'];
      }
      return ['% ' + addr + ' is already configured on ' + other.name];
    }
    // One subnet on two ports is the ambiguity every ping has to resolve.
    const network = v6.networkAddress6(addr + '/' + len);
    for (const other of dev.interfaces.values()) {
      const e = dev.config.ip6[other.name];
      if (!e || other.name === iface.name || Number(e.prefix) !== len) continue;
      if (v6.networkAddress6(e.addr + '/' + e.prefix) !== network) continue;
      return ['% ' + network + '/' + len + ' is already on ' + other.name +
        ' - two ports in one IPv6 subnet is ambiguous'];
    }
    const prev = dev.config.ip6[iface.name];
    // A static address cancels autoconfiguration: the operator has just said
    // what the address is, so waiting for a router to say otherwise would only
    // produce a second address nobody asked for.
    iface.autoconfig = false;
    dev.config.ip6[iface.name] = { addr: addr, prefix: len };
    const said = ['IPv6 address ' + addr + '/' + len + ' on ' + iface.name];
    // One global address per port is this model's limit, and a second one used to replace the first
    // in silence - the address an operator typed a minute ago simply gone, with no line saying so.
    if (prev && prev.addr !== addr && !prev.autoconfig) {
      said.push('  note: replaced ' + prev.addr + '/' + prev.prefix +
        ' - this model keeps one global IPv6 address per port');
    }
    return said;
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

  // 'ipv6 unicast-routing': whether this box forwards an IPv6 packet that is not addressed to it.
  //
  // This lab has always forwarded IPv6 between configured interfaces the moment they had addresses,
  // so the switch starts **on** here rather than off as IOS does - documented, and the reason a
  // missing line in a running-config is not a claim that forwarding is off. What the command buys is
  // the other direction: `no ipv6 unicast-routing` really does stop the box forwarding, which is the
  // only way to tell a router with a broken route from a router that is not routing at all.
  // 'spanning-tree vlan <id> priority <n> | root primary|secondary'
  //
  // None of this existed: `spanning-tree vlan 1 root primary` and `... priority 4096` were both
  // `% Unrecognized config command`, so the election could be observed and never influenced - and
  // `show spanning-tree` did not print a root at all, while the help row for it promised "root
  // bridge, port roles and states". A spanning tree whose root cannot be chosen is a topology the
  // operator cannot build.
  // The removal of an STP priority takes the words the positive form takes: `no spanning-tree vlan
  // 10 root primary` is how an operator asks for what `spanning-tree vlan 10 root primary` did to be
  // undone, and it was refused as "% Unexpected argument \"root primary\"". A word that names a
  // setting this model does not hold is still refused, and so is a value that disagrees with the one
  // in force - the removal removes what is there, it does not overwrite it.
  _stpNoExtraWords(rest) {
    const stpLib = require('./stp');
    const cfg = this.device.config;
    if (rest.length <= 2) return null;
    const tail = rest.slice(2);
    if (tail[0] === 'root') {
      if (tail[1] !== 'primary' && tail[1] !== 'secondary') {
        return ['% Usage: no spanning-tree vlan <id> root primary|secondary'];
      }
      if (tail.length > 2) return ['% Unexpected argument "' + tail[2] + '" - no spanning-tree vlan <id> root ' + tail[1]];
      if (cfg.stpPriority !== undefined && cfg.stpRootMode !== tail[1]) {
        return ['% The priority here was set explicitly (' + cfg.stpPriority + '), not by root ' + tail[1],
          '% Remove it with "no spanning-tree vlan ' + rest[1] + ' priority ' + cfg.stpPriority + '"'];
      }
      if (cfg.stpVlan !== undefined && String(cfg.stpVlan) !== String(rest[1])) {
        return ['% The tree here is set for VLAN ' + cfg.stpVlan + ', not VLAN ' + rest[1],
          '% One tree covers every VLAN on this device - "no spanning-tree vlan ' + cfg.stpVlan + ' root ' + tail[1] + '"'];
      }
      return null;
    }
    if (tail[0] === 'priority') {
      if (tail[1] === undefined) return ['% Incomplete command: no spanning-tree vlan <id> priority <n>'];
      if (tail.length > 2) return ['% Unexpected argument "' + tail[2] + '" - no spanning-tree vlan <id> priority <n>'];
      if (cfg.stpPriority !== undefined && String(cfg.stpPriority) !== String(tail[1])) {
        return ['% The priority here is ' + cfg.stpPriority + ', not ' + tail[1],
          '% "no spanning-tree vlan ' + (cfg.stpVlan || rest[1]) + '" removes whatever is set'];
      }
      return null;
    }
    return ['% Unexpected argument "' + tail.join(' ') + '" - no spanning-tree vlan <id> takes no more',
      '% Usage: no spanning-tree vlan <id> [priority <n> | root primary|secondary]'];
  }

  _stpConfig(tokens) {
    const dev = this.device;
    const stpLib = require('./stp');
    const usage = 'spanning-tree vlan <id> priority <n> | root primary|secondary';
    if (!dev.isL2()) {
      return ['% ' + (dev.name || dev.id) + ' does not bridge - spanning tree runs on switches',
        '% ' + dev.label + ' forwards at L3, where a loop is a routing problem, not a bridging one'];
    }
    const t = tokens.map(function (x) { return String(x).toLowerCase(); });
    if (!t.length) return ['% Incomplete command: ' + usage];
    if (t[0] !== 'vlan') {
      return ['% Unrecognized spanning-tree command: spanning-tree ' + t.join(' '),
        '% Usage: ' + usage];
    }
    const vidWord = t[1];
    if (vidWord === undefined) return ['% Incomplete command: ' + usage];
    // `all` is the spelling an operator reaches for, and the model keeps one bridge priority, so it
    // is answered as what it would do rather than refused as nonsense.
    const vid = vidWord === 'all' ? 1 : Number(vidWord);
    if (vidWord !== 'all' && (!/^\d+$/.test(vidWord) || !(vid >= 1 && vid <= 4094))) {
      return ['% VLAN id must be a number 1-4094, not "' + vidWord + '"'];
    }
    const sub = t[2];
    if (sub === undefined) {
      const cur = (dev.config.stpPriority === undefined ? stpLib.STP_DEFAULT_PRIORITY : dev.config.stpPriority);
      return ['Spanning tree for VLAN ' + vid + ' on ' + (dev.name || dev.id) + ': bridge priority ' + cur,
        '  ' + usage];
    }
    if (sub === 'priority') {
      const raw = t[3];
      if (raw === undefined) return ['% Incomplete command: spanning-tree vlan ' + vid + ' priority <n>'];
      const extra = this._noExtra(t, 4, 'spanning-tree vlan ' + vid + ' priority <n>');
      if (extra) return extra;
      const n = Number(raw);
      if (!stpLib.validateBridgePriority(n)) {
        // IOS refuses with the rule, not just the number: 0-61440 in steps of 4096.
        return ['% Invalid bridge priority "' + raw + '" - it must be 0-61440 in steps of 4096',
          '% e.g. 4096, 8192, 24576, 32768 (the default), 61440'];
      }
      const was = dev.config.stpPriority;
      dev.config.stpPriority = n;
      // Typed as a number, so it is an explicit priority and not a root designation - the removal
      // form has to be told, or `no … root primary` would take this value for its own.
      delete dev.config.stpRootMode;
      // The VLAN the operator named is kept only so the dump can print the same words back. The
      // priority itself is the device's, which the next line says out loud.
      dev.config.stpVlan = vid;
      const said = ['Spanning tree bridge priority ' + n + ' on ' + (dev.name || dev.id)];
      if (was !== undefined && was !== n) said.push('  was ' + was);
      // One bridge priority is kept, for one spanning-tree instance, however the VLAN word is spelled.
      // The command accepted `vlan 10`, answered "for VLAN 10", and then applied it to the device - and
      // the dump wrote `spanning-tree vlan 1`, inventing a VLAN nobody typed. Say what it did.
      if (vid !== '1' && vid !== 'all') {
        said.push('  This model runs one spanning tree for every VLAN, so the priority is the device\'s;');
        said.push('  "show spanning-tree" prints it against that single instance');
      }
      return said;
    }
    if (sub === 'root') {
      const which = t[3];
      if (which === undefined) return ['% Incomplete command: spanning-tree vlan ' + vid + ' root primary|secondary'];
      const extra = this._noExtra(t, 4, 'spanning-tree vlan ' + vid + ' root primary|secondary');
      if (extra) return extra;
      if (which !== 'primary' && which !== 'secondary') {
        return ['% Unknown spanning-tree root role "' + which + '" - primary or secondary'];
      }
      // IOS picks 24576 for primary and 28672 for secondary, and goes lower if the current root is
      // already at or below that. The same rule here, so the answer is the priority it chose.
      const others = [];
      if (this.sim) {
        for (const other of this.sim.topo.devices.values()) {
          if (other === dev || !other.isL2 || !other.isL2()) continue;
          const p = other.config && other.config.stpPriority !== undefined
            ? other.config.stpPriority : stpLib.STP_DEFAULT_PRIORITY;
          others.push(p);
        }
      }
      const bestOther = others.length ? Math.min.apply(null, others) : stpLib.STP_DEFAULT_PRIORITY;
      let target = which === 'primary' ? 24576 : 28672;
      if (which === 'primary' && bestOther <= target) target = Math.max(0, bestOther - 4096);
      if (which === 'secondary' && bestOther <= target) target = Math.max(0, bestOther + 4096);
      dev.config.stpPriority = target;
      dev.config.stpVlan = vid;
      // Which form set it. Without this the removal has to guess from the number, and 4096 is both a
      // value an operator can type and one root primary can pick - so `no … root primary` would
      // remove a priority somebody set by hand and call it a root designation.
      dev.config.stpRootMode = which;
      return ['Spanning tree for VLAN ' + vid + ': ' + (dev.name || dev.id) + ' is set to be root ' +
        which + ' (bridge priority ' + target + ')',
        '  One spanning tree covers every VLAN here, so the priority is the device\'s'];
    }
    return ['% Unrecognized spanning-tree command: spanning-tree ' + t.join(' '), '% Usage: ' + usage];
  }

  // The per-port half: `spanning-tree cost <n>` changes the election (the tree picks a different
  // root port, which is the whole point); the two knobs this model has nothing to do with are
  // refused by naming that, rather than accepted as decoration.
  _stpIface(tokens, iface) {
    const dev = this.device;
    const t = tokens.map(function (x) { return String(x).toLowerCase(); });
    if (!dev.isL2()) {
      return ['% ' + (dev.name || dev.id) + ' does not bridge - spanning tree runs on switches'];
    }
    if (!t.length) {
      return ['% Incomplete command: spanning-tree cost <n> | port-priority <n> | portfast | bpduguard'];
    }
    if (t[0] === 'cost') {
      const raw = t[1];
      if (raw === undefined) return ['% Incomplete command: spanning-tree cost <n>'];
      const extra = this._noExtra(t, 2, 'spanning-tree cost <n>');
      if (extra) return extra;
      const n = Number(raw);
      if (!/^\d+$/.test(raw) || !(n >= 1 && n <= 200000000)) {
        return ['% Invalid path cost "' + raw + '" - it must be 1-200000000'];
      }
      iface.stpCost = n;
      return ['Spanning tree cost ' + n + ' on ' + iface.name];
    }
    if (t[0] === 'port-priority') {
      return ['% port-priority is not modelled - this spanning tree breaks a cost tie by bridge ID',
        '% and port name, never by port priority, so storing one would change nothing'];
    }
    if (t[0] === 'portfast') {
      return ['% portfast is not modelled - every port here converges at the same instant',
        '% (there is no Listening/Learning hold-off to skip; see "show spanning-tree <port> at <ms>")'];
    }
    if (t[0] === 'bpduguard' || t[0] === 'bpdufilter') {
      return ['% ' + t[0] + ' is not modelled - this model never injects a BPDU into an edge port,',
        '% so a guard would have nothing to react to'];
    }
    return ['% Unrecognized interface command: spanning-tree ' + t.join(' '),
      '% Usage: spanning-tree cost <n> | port-priority <n> | portfast | bpduguard'];
  }

  // The per-port spelling of a global command, or null when there is none worth naming.
  // Only forms that actually exist in this console are listed: the note exists to help an operator
  // who typed a global command in an interface block, and inventing a command does the opposite.
  _perPortForm(tokens) {
    const a = String(tokens[0] || '').toLowerCase();
    const b = String(tokens[1] || '').toLowerCase();
    // The value the operator typed is carried through, so the note is a command they can run
    // rather than a template they have to fill in again.
    if (a === 'ospf' && b === 'area') return 'ip ospf ...';
    if (a === 'vlan') return 'switchport access vlan <id>';
    return null;
  }

  _ipv6UnicastRouting(on, tokens) {
    const usage = on ? 'ipv6 unicast-routing' : 'no ipv6 unicast-routing';
    const extra = this._noExtra(tokens, 0, usage);
    if (extra) return extra;
    const dev = this.device;
    if (dev.config.ip6Routing === undefined) dev.config.ip6Routing = true;
    if (!dev.capabilities.includes('l3-forward') && on) {
      return ['% ' + (dev.name || dev.id) + ' does not route - ' + dev.label + ' forwards no IPv6'];
    }
    if (on) {
      if (dev.config.ip6Routing) return ['IPv6 unicast routing is already enabled on ' + (dev.name || dev.id)];
      dev.config.ip6Routing = true;
      return ['IPv6 unicast routing enabled on ' + (dev.name || dev.id)];
    }
    if (!dev.config.ip6Routing) return ['IPv6 unicast routing is already disabled on ' + (dev.name || dev.id)];
    dev.config.ip6Routing = false;
    return ['IPv6 unicast routing disabled on ' + (dev.name || dev.id) +
      ' - this device now forwards no IPv6 packet (its own addresses still answer)'];
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

      // Every ND verb takes a fixed number of words, and each of them dropped the rest: `ipv6 nd
      // ra enable extra` answered "enabled", `ipv6 nd suppress-ra extra` answered "suppressed",
      // and `ipv6 nd ra lifetime 600 900` answered 600. A dropped word here changes what a link
      // hears, which is not something to guess at.
      const ndExtra = function (allowed, usage) {
        if (t.length > allowed) {
          return ['% Unexpected argument "' + t[allowed] + '" - ' + usage + ' takes no more',
            '% Usage: ' + usage];
        }
        return null;
      };
      if (sub === 'enable' || sub === 'disable') {
        const bad = ndExtra(2, 'ipv6 nd ra ' + sub);
        if (bad) return bad;
        // 'no ipv6 nd ra enable' reads as "stop advertising", and that is what it
        // does: the negated form flips the verb rather than being refused.
        const on = (sub === 'enable') !== negated;
        c.enabled = on;
        return [on
          ? 'IPv6 router advertisements enabled on ' + dev.name
          : 'IPv6 router advertisements disabled on ' + dev.name];
      }
      if (sub === 'managed' || sub === 'other-config') {
        const bad = ndExtra(2, 'ipv6 nd ra ' + sub);
        if (bad) return bad;
        const on = !negated;
        if (sub === 'managed') c.m = on; else c.o = on;
        return ['IPv6 RA ' + (sub === 'managed' ? 'M (managed)' : 'O (other-config)') +
          ' flag ' + (on ? 'set' : 'cleared')];
      }
      if (sub === 'lifetime') {
        // The removal half of this verb did not exist: `no ipv6 nd ra lifetime 10` took the same
        // branch as the positive form and *set* 10 again, answer and all, while `no ipv6 nd ra
        // lifetime` (no value) answered "Incomplete command". A verb you can set and not unset is
        // the defect this series keeps finding; here the removal is a reset to the protocol default.
        if (negated) {
          // t is ['nd','lifetime',<value>?] - the `no` is already stripped, so a fourth word never
          // arrives; the value slot itself is what has to be checked, or `no … lifetime abc` reads
          // as junk-as-value and resets anyway.
          const had = t[2];
          if (had !== undefined && !/^\d{1,5}$/.test(had)) {
            return ['% Unexpected argument "' + had + '" - no ipv6 nd ra lifetime [<seconds>]',
              '% Usage: no ipv6 nd ra lifetime   (back to the protocol default)'];
          }
          const was = c.routerLifetime;
          delete c.routerLifetime;
          const def = require('./ra').DEFAULTS.routerLifetime;
          return ['IPv6 RA router lifetime back to the default ' + def + 's' +
            (was === undefined ? ' (it was not set)' : ' (was ' + was + 's)')];
        }
        const val = t[2];
        if (val === undefined) return ['% Incomplete command: ipv6 nd ra lifetime <seconds>'];
        if (!/^\d{1,5}$/.test(val)) return ['% Invalid router lifetime "' + val + '" (0..65535 seconds)'];
        const n = parseInt(val, 10);
        if (n > 65535) return ['% Router lifetime out of range: ' + val + ' (0..65535)'];
        const extra = ndExtra(3, 'ipv6 nd ra lifetime <seconds>');
        if (extra) return extra;
        c.routerLifetime = n;
        return ['IPv6 RA router lifetime ' + n + 's' + (n === 0 ? ' (not a default router)' : '')];
      }
      return ['% Unknown IPv6 RA command: ipv6 nd ra ' + sub];
    }

    if (t[0] === 'suppress-ra') {
      const bad = needsRouter();
      if (bad) return bad;
      if (t.length > 1) {
        return ['% Unexpected argument "' + t[1] + '" - ipv6 nd ' +
          (negated ? 'no ' : '') + 'suppress-ra takes no more',
          '% Usage: ipv6 nd suppress-ra'];
      }
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
      let gaveValid = false;
      let gavePreferred = false;
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
        if (key === 'valid') { valid = n; gaveValid = true; } else { preferred = n; gavePreferred = true; }
      }
      // A preferred lifetime past the valid one is a contradiction on the wire, and refusing it here
      // means the router never advertises nonsense - but only a *typed* one: citing the default
      // preferred lifetime back at an operator who asked for `valid 60` answered "% Preferred
      // lifetime (604800s) cannot exceed the valid lifetime (60s)" about a number they never typed
      // and could not see. When only the valid lifetime is given, the preferred one follows it down.
      let clamped = false;
      if (preferred > valid && gaveValid && !gavePreferred) {
        preferred = valid;
        clamped = true;
      }
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
      if (clamped) {
        // Say which number was not the operator's: printing "preferred 60s" without a word would
        // look like a value they chose, and the dump now carries it.
        lines.push('  the preferred lifetime followed the valid one down to ' + preferred +
          's (it is the default ' + raLib.DEFAULTS.preferredLifetime +
          's, which would outlast a valid lifetime of ' + valid + 's)');
      }
      if (parsed.prefixLen !== 64) {
        lines.push('% note: only a /64 leaves room for a 64-bit interface identifier, ' +
          'so hosts will not form a SLAAC address from this prefix');
      }
      return lines;
    }

    return ['% Unknown IPv6 ND command: ipv6 nd ' + t.join(' ')];
  }

  _ifaceList() {
    const names = [];
    for (const name of this.device.interfaces.keys()) names.push(name);
    return names;
  }

  // An interface named by the operator, in whatever case they typed it, or null.
  _ifaceNamed(text) {
    const want = String(text || '').toLowerCase();
    if (!want) return null;
    for (const name of this.device.interfaces.keys()) {
      if (String(name).toLowerCase() === want) return name;
    }
    return null;
  }

  // `ip route` used to take its four words and store them: nothing was checked, so a typo went into
  // the routing table and stayed there. `ip route abc 255.0.0.0 1.1.1.1` was answered
  //
  //   Route added: abc/8 via 1.1.1.1
  //
  // ...and from then on **every** lookup on that router threw `Invalid IPv4 address: abc`, because
  // routeTo() parsed the stored destination. The device was not merely misconfigured, it was bricked
  // by one mistyped word, and the error surfaced later, in `ping`, as `% Error: Invalid IPv4 address:
  // abc`. A next hop was never checked either: `... 255.255.255.0 abc` installed `via abc`, and
  // `... 255.255.255.0 1.1.1.1 999` stored `999` as an *interface* name (the fourth word is an
  // interface, not a distance), so the route pointed at a port that does not exist.
  _ipRoute(tokens) {
    const USAGE = 'ip route <network> <mask> <next-hop> [<interface>]';
    const dest = tokens[2], mask = tokens[3], target = tokens[4], ifaceText = tokens[5];
    if (!dest || !mask) {
      return ['% Incomplete command: ' + USAGE];
    }
    if (!net.isIp(dest)) {
      return ['% "' + dest + '" is not an IPv4 address, so it cannot be a destination network',
        '% Usage: ' + USAGE];
    }
    let prefix = null;
    try { prefix = net.prefixOf(mask); } catch (e) { prefix = null; }
    if (prefix === null || !net.isIp(mask)) {
      return ['% "' + mask + '" is not a subnet mask (e.g. 255.255.255.0)',
        '% Usage: ' + USAGE];
    }
    // A mask whose ones are interrupted is not a mask. `prefixOf` counts the leading ones and stops
    // at the first zero, so `ip route 10.0.0.0 255.0.255.0 10.0.0.9` was answered "Route added:
    // 10.0.0.0/8" - a route covering every 10/8 address, silently wider than the words typed.
    // `ip address` has refused this for a while (isContiguousMask); the route table had not.
    if (!net.isContiguousMask(mask)) {
      return ['% "' + mask + '" is not a contiguous mask - the ones must all be on the left',
        '% Read as /' + prefix + ' it would cover every address that prefix matches - wider than the words typed',
        '% Try 255.255.255.0, or a route for the wider network you meant'];
    }
    const extra = this._noExtra(tokens, ifaceText === undefined ? 5 : 6, USAGE);
    if (extra) return extra;
    if (target === undefined) {
      // A static route with no next hop is not a route: it claims reachability for a prefix while
      // naming nothing that could answer for it. It used to be accepted as "on-link", listed in
      // `show ip route`, and time out every packet sent to it.
      return ['% Incomplete command: ' + USAGE,
        '% A static route needs a next hop, e.g. "ip route 10.0.0.0 255.255.255.0 192.168.1.1"'];
    }

    let gw = null;
    let iface = null;
    if (ifaceText !== undefined) {
      // `ip route <net> <mask> <gw> <iface>`: the next hop is an address and the fourth word names the
      // port to reach it through.
      if (!net.isIp(target)) {
        return ['% "' + target + '" is not an IPv4 next hop',
          '% Usage: ' + USAGE];
      }
      gw = target;
      iface = this._ifaceNamed(ifaceText);
      if (!iface) {
        const listed = this._ifaceList();
        const out = ['% "' + ifaceText + '" is not an interface on ' +
          (this.device.name || 'this device')];
        if (/^\d+$/.test(ifaceText)) {
          // `ip route 10.0.0.0 255.255.255.0 1.1.1.1 250` reads as a distance in IOS. It cannot be
          // one here, and saying only "not an interface" would leave the reader guessing why.
          out.push('% The fourth word is an interface, not a distance - this model has no per-route' +
            ' administrative distance (AD is per source: connected 0, static 1, OSPF 110, eBGP 20)');
        }
        out.push('% Interfaces: ' + listed.slice(0, 8).join(', ') +
          (listed.length > 8 ? ', ...' : ''));
        return out;
      }
    } else if (net.isIp(target)) {
      gw = target;
      // A next hop is the address of one neighbour. These four cannot be one, so the route was a row
      // that claimed to forward (marked `*` in `show ip route`) with nothing that could ever answer
      // its ARP: measured 0/4 replies while the same prefix via a real neighbour answered 4/4.
      const kind = this._addressClass(gw);
      if (kind) {
        return ['% ' + gw + ' is ' + kind + ', so no neighbour can answer for it',
          '% A static route forwards to one next-hop address: a host on a connected subnet',
          '% Usage: ' + USAGE];
      }
    } else if (this._ifaceNamed(target)) {
      // `ip route 192.168.2.0 255.255.255.0 Gi0/0` - the interface-only form IOS accepts on a
      // point-to-point link. Here it installs a route that forwards nothing: the lookup resolves the
      // destination to itself with that port and then ARPs for the destination on the wire, where
      // nobody answers (measured: 0/4 replies, while the same lab with a next hop answers 4/4).
      // Accepting it would be a routing table that cannot tell a working route from a dead one.
      return ['% ' + target + ' is an interface, not a next hop - this model forwards to a next-hop' +
        ' address',
        '% Name the neighbour\'s address instead: "ip route ' + dest + ' ' + mask + ' <neighbour-ip>"',
        '% (the interface-only form is accepted by IOS on point-to-point links, and would forward' +
        ' nothing here)'];
    } else {
      const listed = this._ifaceList();
      return ['% "' + target + '" is neither an IPv4 next hop nor an interface on ' +
        (this.device.name || 'this device'),
        '% Usage: ' + USAGE,
        '% Interfaces: ' + listed.slice(0, 8).join(', ') + (listed.length > 8 ? ', ...' : '')];
    }

    // IOS installs a route once. Typing the same line twice used to append a second identical row,
    // so a dump pasted twice doubled the table - configuration applied twice was not the same
    // configuration, which is exactly what a paste has to be.
    const routes = this.device.config.routes;
    const twin = routes.filter(function (r) {
      return String(r.dest) === String(dest) && String(r.mask) === String(mask) &&
        String(r.gw || '') === String(gw || '') && String(r.iface || '') === String(iface || '');
    })[0];
    if (twin) {
      return [dest + '/' + prefix + ' is already configured: via ' + (gw || iface || 'on-link'),
        '  The table is unchanged - "no ip route ' + dest + ' ' + mask + '" removes it'];
    }
    routes.push({ dest: dest, mask: mask, gw: gw, iface: iface });
    return ['Route added: ' + dest + '/' + prefix + ' via ' + (gw || iface || 'on-link')];
  }

  // The removal is as narrow as the command that installed the route: it matches on what was stored,
  // and it says which route it removed rather than "Route removed" for a route that was never there.
  _noIpRoute(tokens) {
    const USAGE = 'no ip route <network> <mask> [<next-hop|interface>]';
    const dest = tokens[3], mask = tokens[4], target = tokens[5];
    if (!dest || !mask) return ['% Incomplete command: ' + USAGE];
    if (!net.isIp(dest) || !net.isIp(mask)) {
      return ['% "' + (net.isIp(dest) ? mask : dest) + '" is not an IPv4 address',
        '% Usage: ' + USAGE];
    }
    const extra = this._noExtra(tokens, 6, USAGE);
    if (extra) return extra;
    const matches = function (r) {
      if (r.dest !== dest || r.mask !== mask) return false;
      if (target === undefined) return true;
      return r.gw === target || String(r.iface || '').toLowerCase() === String(target).toLowerCase();
    };
    const before = this.device.config.routes.slice();
    const kept = before.filter(function (r) { return !matches(r); });
    if (kept.length === before.length) {
      return ['% No route to ' + dest + '/' + net.prefixOf(mask) +
        (target ? ' via ' + target : '') + ' is configured',
        '% "show ip route" lists what is: ' + (before.length
          ? before.map(function (r) { return r.dest + '/' + net.prefixOf(r.mask); }).join(', ')
          : 'no static routes')];
    }
    this.device.config.routes = kept;
    return ['Route removed: ' + dest + '/' + net.prefixOf(mask) +
      (target ? ' via ' + target : '')];
  }

  _defaultGateway(tokens) {
    const USAGE = 'ip default-gateway <address>';
    const ip = tokens[2];
    const extra = this._noExtra(tokens, 3, USAGE);
    if (extra) return extra;
    if (ip === undefined) return ['% Incomplete command: ' + USAGE];
    // `ip default-gateway abc` stored the string and reported success; the gateway was then parsed at
    // forwarding time, where it could only fail.
    if (!net.isIp(ip)) {
      return ['% "' + ip + '" is not an IPv4 address, so it cannot be a default gateway',
        '% Usage: ' + USAGE];
    }
    const kind = this._addressClass(ip);
    if (kind) {
      return ['% ' + ip + ' is ' + kind + ', so it cannot be a default gateway',
        '% A gateway is one unicast host on a directly connected subnet',
        '% Usage: ' + USAGE];
    }
    this.device.config.defaultGateway = ip;
    return ['Default gateway: ' + ip];
  }

  _ipv6Route(tokens) {
    const v6 = require('./ipv6');
    const dest = tokens[0];
    const nh = tokens[1];
    const p = v6.parsePrefix6(dest);
    if (!p.valid) return ['% Invalid IPv6 prefix "' + (dest || '') + '"'];
    // A missing next hop was quoted as an empty string: `% Invalid IPv6 next hop ""`.
    if (nh === undefined) {
      return ['% Incomplete command: ipv6 route <prefix> <next-hop>',
        '% e.g. "ipv6 route 2001:db8:1::/64 2001:db8::1"'];
    }
    if (!v6.validateAddress6(nh).ok) return ['% Invalid IPv6 next hop "' + nh + '"'];
    // A link-local next hop names no subnet: `fe80::1` on every wire is a different neighbour on each.
    // IOS requires the egress interface with one, and without it the route is a row that cannot be
    // resolved - accepted here as `2001:db8:9::/64 via fe80::1` with no port named anywhere.
    if (/^fe[89ab][0-9a-f]:/i.test(String(nh))) {
      return ['% ' + nh + ' is a link-local address, so it names a neighbour on one wire and not ' +
        'which wire',
        '% Give the route its egress interface: "ipv6 route ' + dest + ' ' + nh + ' <port>"',
        '% Or use the neighbour\'s global address, which is unambiguous'];
    }
    // A third word was dropped in silence: `ipv6 route 2001:db8:7::/64 2001:db8:1::2 250` answered
    // "IPv6 route ... via 2001:db8:1::2" and threw `250` away, so the operator who typed a distance
    // or an interface has no way to learn it was ignored.
    const usage = 'ipv6 route <prefix>/<len> <next-hop>';
    const extra = this._noExtra(tokens, 2, usage);
    if (extra) return extra;
    if (!this.device.config.routes6) this.device.config.routes6 = [];
    const net = v6.networkAddress6(dest);
    // Same rule as the IPv4 table: an identical route is not a second route. Found by pasting a dump
    // twice - the IPv4 half had been made idempotent and this half had not, so a double paste left
    // two identical `ipv6 route` lines and no way to tell why a dump had grown.
    const twin = (this.device.config.routes6 || []).filter(function (r) {
      return String(r.dest) === String(net) && Number(r.prefix) === p.prefixLen &&
        String(r.nextHop) === String(nh);
    })[0];
    if (twin) {
      return [net + '/' + p.prefixLen + ' is already configured: via ' + nh,
        '  The table is unchanged - "no ipv6 route ' + net + '/' + p.prefixLen + '" removes it'];
    }
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
    // This module-shadowing regex was the reason `neighbor 300.0.0.1 remote-as 65002` was accepted
    // and written to running-config: 300 matches `\d{1,3}`. `net.isIp()` parses the address, so it
    // cannot. (The library's own header notes the same mistake in another place.)
    const isIp = net.isIp;

    // An AS number is a number. `parseInt` read "1e3" as 1, "65001abc" as 65001 and asdot "1.10"
    // as 1 - three different ways to configure an AS nobody typed, each answered in the affirmative.
    // IOS accepts asplain (65001) and asdot (1.10 = 1*65536+10); both are read here, and the answer
    // says which number went in when the words did not spell it out.
    function parseAsn(raw) {
      const s = String(raw === undefined || raw === null ? '' : raw).trim();
      if (/^\d{1,10}$/.test(s)) {
        const n = Number(s);
        if (n >= 1 && n <= 4294967295) return { asn: n };
        return { error: '% Invalid AS number "' + s + '" - it must be 1-4294967295' };
      }
      const m = s.match(/^(\d{1,5})\.(\d{1,5})$/);
      if (m && Number(m[1]) <= 65535 && Number(m[2]) <= 65535) {
        const n = Number(m[1]) * 65536 + Number(m[2]);
        if (n >= 1) return { asn: n, asdot: s };
      }
      return { error: ['% Invalid AS number "' + s + '" - a whole number 1-4294967295, or asdot as in 1.10',
        '% e.g. 65001, or 1.10 which is the same as 65546'] };
    }

    function ensure(asn) {
      if (!dev.config.bgp) dev.config.bgp = { as: null, routerId: null, neighbors: [] };
      if (!dev.config.bgp.neighbors) dev.config.bgp.neighbors = [];
      if (asn !== undefined && asn !== null && asn !== '') dev.config.bgp.as = asn;
      return dev.config.bgp;
    }

    // router bgp <as>
    if (t[0] === 'as') {
      const parsed = parseAsn(t[1]);
      if (parsed.error) return Array.isArray(parsed.error) ? parsed.error : [parsed.error];
      const asn = parsed.asn;
      ensure(asn);
      return ['BGP enabled, local AS ' + asn + (parsed.asdot ? ' ("' + parsed.asdot + '" is asdot for ' + asn + ')' : '')];
    }

    // bgp router-id <ip>
    if (t[0] === 'router-id') {
      if (!isIp(t[1])) return ['% Invalid router-id "' + (t[1] || '') + '"'];
      if (!dev.config.bgp) return ['% BGP is not enabled' + NEEDS.bgp];
      if (dev.config.bgp.routerId === t[1]) {
        return ['BGP router-id ' + t[1] + ' is already configured', '  Nothing changed'];
      }
      const had = dev.config.bgp.routerId;
      dev.config.bgp.routerId = t[1];
      return ['BGP router-id ' + t[1] + (had ? ' (was ' + had + ')' : '')];
    }

    // neighbor <ip> remote-as <as>
    if (isIp(t[0]) && String(t[1] || '').toLowerCase() === 'remote-as') {
      const parsedAs = parseAsn(t[2]);
      if (parsedAs.error) {
        const errs = Array.isArray(parsedAs.error) ? parsedAs.error.slice() : [parsedAs.error];
        errs[0] = String(errs[0]).replace('% Invalid AS number', '% Invalid remote AS');
        return errs;
      }
      const asn = parsedAs.asn;
      if (!dev.config.bgp) return ['% BGP is not enabled' + NEEDS.bgp];
      const list = dev.config.bgp.neighbors;
      let n = null;
      for (const x of list) { if (x.address === t[0]) { n = x; break; } }
      if (n && n.remoteAs === asn) {
        return ['BGP neighbor ' + t[0] + ' remote-as ' + asn + ' is already configured',
          '  Nothing changed - "no neighbor ' + t[0] + '" removes it'];
      }
      if (n) {
        // Changing a peer's AS under it tears the session down in the real thing; say so rather than
        // reporting the new line as if it were an addition.
        const was = n.remoteAs;
        n.remoteAs = asn;
        return ['BGP neighbor ' + t[0] + ' remote-as ' + asn + ' (was ' + was + ')',
          '  The session restarts against the new AS'];
      }
      list.push({ address: t[0], remoteAs: asn });
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
      // A zone is one name: `dns zone lab zzzz` created "lab" and dropped the word.
      if (t[2] !== undefined) {
        return ['% Unexpected argument "' + t[2] + '" - dns zone <name> takes one name',
          '% The zone name is the apex, e.g. "dns zone lab.example"'];
      }
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
      const USAGE = 'dns add <name> <type> <value>';
      const name = t[1];
      const type = String(t[2] || 'A').toUpperCase();
      if (!name || !t[2]) return ['% Incomplete command: ' + USAGE,
        '% Types: ' + dnsLib.RECORD_TYPES.join(', ')];
      if (dnsLib.RECORD_TYPES.indexOf(type) === -1) {
        return ['% Unknown record type "' + type + '" (use ' + dnsLib.RECORD_TYPES.join('/') + ')'];
      }
      // A record's value is the *rest* of the line, not one word: `dns add note TXT hello world`
      // stored `hello` and dropped `world` without saying so.
      let value = t.slice(3).join(' ');
      let priority = null;
      if (type === 'MX') {
        // An MX record is a preference and a host; the library rejects one without a preference
        // (E_DNS_MX_NO_PRIORITY), so the console asks for it in that order rather than guessing.
        if (!t[3] || !/^\d+$/.test(t[3])) {
          return ['% An MX record needs a preference before the host',
            '% Usage: dns add <name> MX <preference> <host>   e.g. dns add lab MX 10 mail.lab.test'];
        }
        priority = Number(t[3]);
        value = t.slice(4).join(' ');
        if (!value) {
          return ['% Incomplete command: dns add <name> MX <preference> <host>'];
        }
      } else if (!value) {
        return ['% Incomplete command: ' + USAGE];
      }
      let z = null;
      if (this._dnsZone) {
        z = dev.config.dnsZones.filter(function (x) { return x.name === this._dnsZone; }, this)[0];
      }
      if (!z) z = dev.config.dnsZones[dev.config.dnsZones.length - 1];
      if (!z) return ['% No zone yet - create one with "dns zone <name>"'];

      // One opinion about what a record is: the library that answers the query judges the record.
      // Before, the console stored `dns add www A abc` and answered "Added ...", while validateZone()
      // in engine/dns.js called the same record `not a dotted-quad IPv4 address` - and the resolver
      // then handed `abc` to the data path, so `ping www.example.test` printed `Echos to abc`.
      // The errors a zone had *before* this record are not this record's fault, so they are compared
      // away rather than blocking the edit: a zone with a pre-existing complaint can still be fixed.
      const before = dnsLib.validateZone(z).errors.map(function (e) { return e.message; });
      const rec = { name: name, type: type, ttl: z.defaultTtl, value: value };
      if (priority !== null) rec.priority = priority;
      z.records.push(rec);
      const after = dnsLib.validateZone(z).errors;
      const fresh = after.filter(function (e) { return before.indexOf(e.message) === -1; });
      if (fresh.length) {
        z.records.pop();
        const out = fresh.slice(0, 3).map(function (e) {
          // `record 3 (www A): ...` - the position is noise when the operator just typed the record.
          // `record 3 (www.example.test A): ...` -> `www.example.test A: ...`
          return '% ' + String(e.message).replace(/^record \d+ \((.*?)\): /, '$1: ');
        });
        out.push('% ' + name + ' ' + type + (priority !== null ? ' ' + priority : '') + ' ' + value +
          ' was not added to ' + z.name);
        return out;
      }
      return ['Added ' + name + ' ' + type + (priority !== null ? ' ' + priority : '') + ' ' + value +
        ' to ' + z.name];
    }

    return ['% Usage: dns zone <name> | dns add <name> <type> <value>'];
  }

  // The removal half of the DNS server's own configuration: a zone, or one name's records.
  _noDns(tokens) {
    const dnsLib = require('./dns');
    const dev = this.device;
    const t = tokens.map(function (x) { return String(x); });
    const zones = dev.config.dnsZones || [];

    if (t[0] === 'zone') {
      const apex = t[1];
      if (!apex) {
        return ['% Incomplete command: no dns zone <name>',
          zones.length ? '% Zones here: ' + zones.map(function (z) { return z.name; }).join(', ')
            : '% This device serves no zone'];
      }
      const key = dnsLib.normalizeName(apex);
      const idx = zones.findIndex(function (x) { return dnsLib.normalizeName(x.name) === key; });
      if (idx === -1) {
        return ['% No zone named ' + key + ' on ' + (dev.name || dev.id),
          zones.length ? '% Zones here: ' + zones.map(function (z) { return z.name; }).join(', ')
            : '% This device serves no zone - nothing to remove'];
      }
      const gone = zones[idx];
      zones.splice(idx, 1);
      if (this._dnsZone === gone.name) this._dnsZone = null;
      const n = (gone.records || []).length;
      return ['Zone ' + gone.name + ' removed' + (n ? ' with its ' + n + ' record' + (n === 1 ? '' : 's')
        : ' (it held no records)'),
        // The fact the operator cannot see: a resolver that pointed at this server has lost its
        // answers, and nothing on the server says so.
        n ? 'Any resolver that pointed at this device for that name now has no answer for it' : null
      ].filter(Boolean);
    }

    if (t[0] === 'add') {
      const name = t[1];
      const type = t[2] ? String(t[2]).toUpperCase() : null;
      if (!name) return ['% Incomplete command: no dns add <name> [<type>]'];
      if (type && dnsLib.RECORD_TYPES.indexOf(type) === -1) {
        return ['% Unknown record type "' + type + '" (use ' + dnsLib.RECORD_TYPES.join('/') + ')'];
      }
      const key = dnsLib.normalizeName(name);
      const removed = [];
      for (const z of zones) {
        const keep = [];
        for (const r of (z.records || [])) {
          const sameName = dnsLib.normalizeName(r.name) === key;
          const sameType = !type || String(r.type || 'A').toUpperCase() === type;
          if (sameName && sameType) removed.push({ zone: z.name, rec: r });
          else keep.push(r);
        }
        z.records = keep;
      }
      if (!removed.length) {
        const held = [];
        for (const z of zones) {
          for (const r of (z.records || [])) {
            if (dnsLib.normalizeName(r.name) === key) held.push(z.name + ': ' + r.name + ' ' + r.type + ' ' + r.value);
          }
        }
        return ['% ' + name + ' has no ' + (type || 'record') + ' here',
          held.length ? '% That name holds: ' + held.join('; ')
            : '% No zone on this device holds a record for ' + key];
      }
      const out = ['Removed ' + removed.length + ' record' + (removed.length === 1 ? '' : 's') +
        ' for ' + name + (type ? ' (' + type + ')' : '')];
      for (const r of removed) {
        out.push('  ' + r.zone + ': ' + r.rec.name + ' ' + r.rec.type + ' ' + r.rec.value);
      }
      return out;
    }

    return ['% Usage: no dns zone <name> | no dns add <name> [<type>]'];
  }

  // ---------- OSPF ----------
  // `ip routing` / `no ip routing` - the switch every L3-switch lab sets, and which this model did not
  // have: `ip routing` answered `% Unrecognized config command` on a device whose whole purpose is
  // routing between its VLANs. The model forwarded whenever the device could, with no way to stop it.
  _ipRouting(tokens) {
    const dev = this.device;
    const negate = String(tokens[0]).toLowerCase() === 'no';
    const from = negate ? 3 : 2;
    const extra = this._noExtra(tokens, from, (negate ? 'no ' : '') + 'ip routing');
    if (extra) return extra;
    if (typeof dev.isL3 === 'function' && !dev.isL3()) {
      return ['% ' + (dev.name || dev.id) + ' is not a router: it has no interfaces to route between',
        '% A host uses "ip default-gateway <gw>" for the one router it sends everything to'];
    }
    const was = dev.config.ipRouting !== false;
    if (!negate) {
      if (was) return ['IP routing is already enabled on ' + (dev.name || dev.id)];
      dev.config.ipRouting = true;
      return ['IP routing enabled on ' + (dev.name || dev.id),
        '  Packets are forwarded between its interfaces again, and the routing table is used'];
    }
    if (!was) return ['IP routing is already disabled on ' + (dev.name || dev.id)];
    dev.config.ipRouting = false;
    return ['IP routing disabled on ' + (dev.name || dev.id),
      '  The device still switches within a VLAN, but it will not forward between its interfaces',
      '  Routes stay configured - "ip routing" turns forwarding back on'];
  }

  // `router ospf <pid>` - the way OSPF is configured on every real router, and the one spelling this
  // console did not have: it answered `% Unrecognized config command: router ospf 1` while `router
  // bgp` was implemented, so an operator following any lab guide could not start OSPF at all.
  _routerOspf(tokens) {
    const t = tokens.map(function (x) { return String(x); });
    // tokens are ['router', 'ospf', <pid>], so anything from index 3 on has no slot.
    const extra = this._noExtra(t, 3, 'router ospf <process-id>');
    if (extra) return extra;
    const word = String(t[2] === undefined ? '' : t[2]);
    if (!word) {
      return ['% Incomplete command: router ospf <process-id> (1-65535)',
        '% The process id is local to this router; it does not have to match the neighbour\'s'];
    }
    if (!/^\d+$/.test(word)) {
      return ['% "' + word + '" is not a process id', '% A process id is a number 1-65535'];
    }
    const pid = parseInt(word, 10);
    if (!(pid >= 1 && pid <= 65535)) {
      return ['% Process id ' + pid + ' is outside 1-65535'];
    }
    const cfg = this.device.config.ospf || { routerId: null, areaId: 0, interfaces: [] };
    if (!cfg.interfaces) cfg.interfaces = [];
    const already = cfg.pid === pid;
    cfg.pid = pid;
    // `router ospf 1` is what turns OSPF on: IOS creates the process here, and so must this model, or
    // `network` inside the mode would have nothing to attach to.
    this.device.config.ospf = cfg;
    this.modeBeforeOspf = this.mode;
    this.routerKind = 'ospf';
    this.mode = MODE_OSPF;
    const out = [already ? 'Entering router configuration mode (process ' + pid + ' was already there)'
      : 'OSPF process ' + pid + ' enabled, entering router configuration mode'];
    if (!already) {
      // Say what the mode is for, because it is the one thing an operator needs to know: the areas
      // live on the interfaces here, and `network` is the shorthand that writes them.
      out.push('  "network <net> <wildcard> area <id>" sets the area on every interface it matches');
      out.push('  "router-id <ip>" names this router; "exit" leaves the mode');
    }
    return out;
  }

  // Inside `router ospf`: the two verbs that matter, and nothing that pretends to be something else.
  _ospfRouterMode(tokens) {
    const head = String(tokens[0] || '').toLowerCase();
    if (this.routerKind === 'bgp') return this._bgpRouterMode(tokens);
    const doShow = this._doShowInMode(tokens);
    if (doShow) return doShow;
    const stray = this._blockStrayWord(tokens, MODE_OSPF);
    if (stray) return stray;
    if (head === 'help' || head === '?') return this._help();
    // Without `do`, a `show` here used to fall through to the global handler, which - having accepted
    // the line - leaves the block: one look at the routing table and the next `network` statement was
    // read as global config. A read is a read in every other block; it is one here too.
    if (head === 'show') return this._show(tokens.slice(1));
    const cfg = this.device.config.ospf;
    if (!cfg) { this.mode = MODE_CONFIG; this.routerKind = null; return ['% OSPF is no longer configured']; }
    if (head === 'exit') {
      this.mode = MODE_CONFIG;
      this.routerKind = null;
      return ['Leaving router configuration mode'];
    }
    if (head === 'end') {
      this.mode = MODE_ENABLE;
      this.routerKind = null;
      return [];
    }
    if (head === 'network') return this._ospfNetwork(tokens, false);
    if (head === 'no' && String(tokens[1] || '').toLowerCase() === 'network') {
      return this._ospfNetwork(tokens.slice(1), true);
    }
    if (head === 'router-id') {
      return this._ospfConfig(['router-id'].concat(tokens.slice(1)));
    }
    if (head === 'no' && String(tokens[1] || '').toLowerCase() === 'router-id') {
      const had = cfg.routerId;
      cfg.routerId = null;
      return [had ? 'Router-id cleared (was ' + had + ')' : 'No router-id was configured'];
    }
    // BGP verbs are not "the next block of a paste": `neighbor 10.10.0.2 remote-as 65002` typed while
    // editing an OSPF process fell through to global config and configured BGP from inside it. The
    // fall-through stays (a paste that omits `exit` must keep working), but not for the other
    // process's verbs - and `router bgp <as>` still switches processes, as it does on a real router.
    const bgpVerb = head === 'neighbor' || head === 'bgp' ||
      (head === 'no' && ['neighbor', 'bgp'].indexOf(String(tokens[1] || '').toLowerCase()) !== -1);
    if (bgpVerb) {
      return ['% "' + tokens.join(' ') + '" is not a router ospf command',
        '% That is a BGP verb - "exit" first, then "router bgp <as>"',
        '% In this mode: network <net> <wildcard> area <id>, router-id <ip>, exit, end'];
    }
    // A pasted configuration does not say `exit` before `interface Gi0/1`, and a real router accepts
    // it. Leaving the mode and re-dispatching is what makes a dump pasteable; a refusal that loses the
    // line is worse, because the paste then continues with a configuration that is subtly wrong.
    const saved = this.mode;
    this.mode = MODE_CONFIG;
    const asGlobal = this._configMode(tokens);
    const refused = asGlobal.length && /^% (Unrecognized|Unknown|Invalid) (config )?command/.test(asGlobal[0]);
    if (!refused) return asGlobal;
    // Nothing anywhere: report it in the vocabulary of the mode the operator is actually in.
    this.mode = saved;
    return ['% "' + tokens.join(' ') + '" is not a router ospf command',
      '% In this mode: network <net> <wildcard> area <id>, router-id <ip>, exit, end',
      '% Interface settings (cost, passive, area) are configured on the interface'];
  }

  // (config-router)# when the process is BGP. Deliberately the same mode and prompt as OSPF, because
  // on a real router it is the same mode; only the verbs differ.
  _bgpRouterMode(tokens) {
    const head = String(tokens[0] || '').toLowerCase();
    const doShow = this._doShowInMode(tokens);
    if (doShow) return doShow;
    if (head === 'show') return this._show(tokens.slice(1));
    if (!this.device.config.bgp) { this.mode = MODE_CONFIG; this.routerKind = null; return ['% BGP is no longer configured']; }
    if (head === 'exit') {
      this.mode = MODE_CONFIG;
      this.routerKind = null;
      return ['Leaving router configuration mode'];
    }
    if (head === 'end') {
      this.mode = MODE_ENABLE;
      this.routerKind = null;
      return [];
    }
    // A dump emits `neighbor ...` / `bgp router-id ...` and does not say `exit` between blocks.
    if (head === 'neighbor' || head === 'no' || head === 'bgp' || head === 'network') {
      if (head === 'network') {
        // This used to promise that connected *and static* routes are announced. Only the connected
        // ones are: a static route on R1 never reached the peer, so the sentence described a
        // behaviour the engine does not have. The rule is now the real one, and the view it points at
        // lists the originated prefixes.
        return ['% BGP "network" is not modelled here: this box announces the subnets it has an address',
          '% on, and nothing else - there is no "redistribute" either. "show ip bgp" lists them'];
      }
      if (head === 'no') {
        const asGlobalNo = (function (self) {
          const saved = self.mode; self.mode = MODE_CONFIG;
          const r = self._configMode(tokens);
          self.mode = saved;
          return r;
        })(this);
        const refused = asGlobalNo.length && /^% (Unrecognized|Unknown|Invalid) (config )?command/.test(asGlobalNo[0]);
        if (!refused) return asGlobalNo;
      } else {
        return this._bgp(tokens);
      }
    }
    // Anything else leaves the mode and is re-dispatched, exactly as OSPF does, so a paste never
    // loses a line: `interface Gi0/0` after a BGP block is configuration, not a BGP verb.
    const saved = this.mode;
    this.mode = MODE_CONFIG;
    this.routerKind = null;
    const asGlobal = this._configMode(tokens);
    const refused = asGlobal.length && /^% (Unrecognized|Unknown|Invalid) (config )?command/.test(asGlobal[0]);
    if (!refused) return asGlobal;
    this.mode = saved;
    this.routerKind = 'bgp';
    return ['% "' + tokens.join(' ') + '" is not a router bgp command',
      '% In this mode: neighbor <ip> remote-as <as>, bgp router-id <ip>, exit, end'];
  }

  // `network <net> <wildcard> area <id>` - the area is a property of the interface here, so this
  // writes it on every interface the wildcard selects, and says which ones those were. IOS accepts a
  // network statement that matches nothing in silence, which is the one time an operator most needs
  // to be told: the adjacency will never come up and nothing in the config looks wrong.
  _ospfNetwork(tokens, negate) {
    const dev = this.device;
    const cfg = dev.config.ospf;
    const usage = (negate ? 'no ' : '') + 'network <net> <wildcard> area <id>';
    const extra = this._noExtra(tokens, 5, usage);
    if (extra) return extra;
    const netWord = String(tokens[1] === undefined ? '' : tokens[1]);
    const wcWord = String(tokens[2] === undefined ? '' : tokens[2]);
    if (!netWord || !wcWord) {
      return ['% Incomplete command: ' + usage,
        '% Example: network 10.0.0.0 0.0.0.255 area 0'];
    }
    if (!net.isIp(netWord)) return ['% "' + netWord + '" is not a network address'];
    if (!net.isIp(wcWord)) {
      return ['% "' + wcWord + '" is not a wildcard mask',
        '% A wildcard is the mask inverted: 255.255.255.0 becomes 0.0.0.255'];
    }
    if (String(tokens[3] || '').toLowerCase() !== 'area') {
      return ['% Expected "area" after the wildcard, not "' + (tokens[3] === undefined ? 'nothing' : tokens[3]) + '"',
        '% Example: network 10.0.0.0 0.0.0.255 area 0'];
    }
    if (tokens[4] === undefined) {
      return ['% Incomplete command: ' + usage + ' - an area id is missing',
        '% Area 0 is the backbone'];
    }
    const area = require('./ospf').parseAreaId(String(tokens[4]));
    if (area === null) {
      return ['% "' + tokens[4] + '" is not an area id (0-4294967295, or a dotted quad like 0.0.0.1)'];
    }
    const netInt = net.ipToInt(netWord);
    const wcInt = net.ipToInt(wcWord);
    const matches = [];
    for (const i of dev.interfaces.values()) {
      // A routed interface is a routed interface: skipping `i.parent` meant a router-on-a-stick could
      // not put its own subinterface in an area - "No interface of R1 matches 10.0.20.0 0.0.0.255"
      // for an interface holding 10.0.20.1 - and skipping `i.svi` meant the same for an L3 switch's
      // own address, which the engine happily uses once it is listed. The address is the test.
      if (!i.ip) continue;
      const addr = net.ipToInt(i.ip);
      if (addr === null) continue;
      // The wildcard's zero bits are the ones that must match.
      if (((addr ^ netInt) & (~wcInt >>> 0)) !== 0) continue;
      matches.push(i);
    }
    if (!matches.length) {
      return ['% No interface of ' + (dev.name || dev.id) + ' matches ' + netWord + ' ' + wcWord +
        ' - nothing was changed',
        '% The interfaces and their addresses are in "show ip interface brief"',
        '% IOS would accept this in silence, and the adjacency would never form'];
    }
    const out = [];
    for (const i of matches) {
      let ov = null;
      for (const x of cfg.interfaces) { if (x.name === i.name) { ov = x; break; } }
      if (!ov) { ov = { name: i.name }; cfg.interfaces.push(ov); }
      if (negate) {
        if (ov.area === undefined) { out.push('  ' + i.name + ': no area was set here'); continue; }
        delete ov.area;
        out.push('  ' + i.name + ': area removed (was ' + (ov.area === undefined ? '' : String(area)) + ')');
      } else {
        const had = ov.area;
        ov.area = area;
        out.push('  ' + i.name + ' (' + i.ip + '): area ' + area +
          (had !== undefined && had !== area ? ' (was ' + had + ')' : ''));
      }
    }
    dev.config.ospf = cfg;
    return [(negate ? 'Removed' : 'Network ' + netWord + ' ' + wcWord + ' area ' + area + ' put') +
      ' ' + matches.length + ' interface' + (matches.length === 1 ? '' : 's') + ' in area ' + area]
      .concat(out);
  }

  _ospfConfig(tokens) {
    const dev = this.device;
    const t = tokens.map(function (x) { return String(x); });
    if (!t.length) return ['% Usage: ospf router-id <ip> | ospf area <id>'];
    const cfg = dev.config.ospf || { routerId: null, areaId: 0, interfaces: [] };
    if (!cfg.interfaces) cfg.interfaces = [];

    if (t[0] === 'router-id') {
      const ip = t[1] || '';
      const extra = this._noExtra(t, 2, 'ospf router-id <ip>');
      if (extra) return extra;
      // A shape check accepts `1.1.1.999`; the parser is what decides.
      if (!net.isIp(ip)) return ['% "' + ip + '" is not an IPv4 address, so it cannot be a router-id'];
      cfg.routerId = ip;
      dev.config.ospf = cfg;
      return ['OSPF enabled, router-id ' + ip + ' area ' + (cfg.areaId || 0)];
    }
    if (t[0] === 'area') {
      const extra = this._noExtra(t, 2, 'ospf area <id>');
      if (extra) return extra;
      // `parseInt` read `ospf area 255.255.255.255` as area **255** and answered `OSPF area 255`:
      // half the range the model allows (0-4294967295) was unreachable, and a dotted-quad area - the
      // form RFC 2328 prints - was silently truncated at its first dot.
      const id = require('./ospf').parseAreaId(t[1]);
      if (id === null) {
        return ['% "' + (t[1] || '') + '" is not an area id (0-4294967295, or a dotted quad like 0.0.0.1)'];
      }
      cfg.areaId = id;
      dev.config.ospf = cfg;
      return ['OSPF area ' + id];
    }
    return ['% Usage: ospf router-id <ip> | ospf area <id>'];
  }

  // A removal removes what it names. `no ospf` takes three shapes and each does one thing:
  //   no ospf                  turn the process off, saying which area and how many interfaces went
  //   no ospf router-id [<ip>] forget the id (a derived one takes over), or one the router does not use
  //   no ospf area [<id>]      put the process back in the default area 0, or refuse one it is not in
  _noOspf(words) {
    const dev = this.device;
    const cfg = dev.config.ospf;
    const name = dev.name || dev.id;
    const what = String(words[0] || '').toLowerCase();
    const areaOf = function (c) { return c && c.areaId !== undefined && c.areaId !== null ? c.areaId : 0; };

    if (!what) {
      if (!cfg) return ['% OSPF is not enabled on ' + name + ' - there is no process to remove'];
      const n = (cfg.interfaces || []).length;
      dev.config.ospf = null;
      dev.ospfRoutes = [];
      return ['OSPF disabled (it was in area ' + areaOf(cfg) + ', with ' + n + ' interface' +
        (n === 1 ? '' : 's') + ' in it)'];
    }

    if (what === 'router-id') {
      const ip = words[1] === undefined ? null : String(words[1]);
      if (ip === null) {
        if (!cfg) return ['% OSPF is not enabled on ' + name + ' - start it with "router ospf <process-id>"'];
        if (!cfg.routerId) {
          return ['% No router-id is configured on ' + name + ' - the id in use is derived from the',
            '% highest interface address, and it changes when that address does'];
        }
        const was = cfg.routerId;
        cfg.routerId = null;
        return ['Router-id ' + was + ' removed - OSPF derives one from the highest interface address now'];
      }
      if (!net.isIp(ip)) {
        return ['% "' + ip + '" is not an IPv4 address, so it cannot be a router-id'];
      }
      if (!cfg || cfg.routerId !== ip) {
        const using = cfg && cfg.routerId ? cfg.routerId : 'a derived id (no router-id is configured)';
        return ['% OSPF on ' + name + ' does not use ' + ip, '% It uses ' + using];
      }
      cfg.routerId = null;
      return ['Router-id ' + ip + ' removed - OSPF derives one from the highest interface address now'];
    }

    if (what === 'area') {
      const raw = words[1];
      if (raw === undefined) {
        if (!cfg) return ['% OSPF is not enabled on ' + name + ' - start it with "router ospf <process-id>"'];
        const cur = areaOf(cfg);
        if (cur === 0) {
          return ['OSPF on ' + name + ' is already in area 0 - that is the default, so there is nothing',
            'to remove'];
        }
        cfg.areaId = 0;
        return ['OSPF area reset to 0 (was ' + cur + '), which is the default'];
      }
      const id = require('./ospf').parseAreaId(raw);
      if (id === null) {
        return ['% "' + raw + '" is not an area id (0-4294967295, or a dotted quad like 0.0.0.1)',
          '% Nothing was changed'];
      }
      if (!cfg) {
        return ['% OSPF is not enabled on ' + name + ' - start it with "router ospf <process-id>"'];
      }
      const cur = areaOf(cfg);
      if (cur !== id) {
        return ['% OSPF on ' + name + ' is not in area ' + id,
          '% It is in area ' + cur + ' - "no ospf area" puts it back in the default area 0'];
      }
      cfg.areaId = 0;
      return ['OSPF area ' + id + ' removed - the process is back in the default area 0'];
    }

    return ['% Usage: no ospf | no ospf router-id [<ip>] | no ospf area [<id>]'];
  }

  _ipOspf(tokens, iface) {
    const dev = this.device;
    if (!dev.config.ospf) {
      // "% OSPF is not enabled" is right for a router that has not started it, and wrong for a host
      // or a switch, which cannot start it: those answer with what they are, the way `router ospf`
      // itself does.
      if (typeof dev.isL3 === 'function' && !dev.isL3()) {
        return ['% ' + (dev.name || dev.id) +
          ' is not a router: no routing protocol runs on its interfaces',
          '% A host sends everything to "ip default-gateway <gw>" instead'];
      }
      return ['% OSPF is not enabled' + NEEDS.ospf];
    }
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
      // `% Cost must be 1..65535` answered `ip ospf cost abc` with a range, never with the word that
      // was typed - and the same sentence for a missing value.
      if (rest[1] === undefined) return ['% Incomplete command: ip ospf cost <n> (1..65535)'];
      if (!/^\d+$/.test(String(rest[1]))) {
        return ['% Cost must be a number 1..65535, not "' + rest[1] + '"'];
      }
      const extraCost = this._noExtra(rest, 2, 'ip ospf cost <n>');
      if (extraCost) return extraCost;
      const c = parseInt(rest[1], 10);
      if (!(c >= 1 && c <= 65535)) return ['% Cost ' + rest[1] + ' is outside 1..65535'];
      ov.cost = c;
      return ['OSPF cost ' + c + ' on ' + iface.name];
    }
    if (rest[0] === 'area') {
      if (negate) { delete ov.area; return ['OSPF area reset on ' + iface.name]; }
      const id = require('./ospf').parseAreaId(rest[1]);
      if (id === null) {
        return ['% "' + (rest[1] || '') + '" is not an area id (0-4294967295, or a dotted quad)',
          '% Usage: ip ospf area <id>'];
      }
      ov.area = id;
      return ['OSPF area ' + id + ' on ' + iface.name];
    }
    if (rest[0] === 'passive') {
      ov.passive = !negate;
      return ['OSPF ' + (negate ? 'active' : 'passive') + ' on ' + iface.name];
    }
    // A usage line that omits a form the device accepts is a lie about the device: `ip ospf network
    // point-to-point` was accepted while this refusal listed only cost, area and passive.
    return ['% Usage: ip ospf cost <n> | ip ospf area <id> | ip ospf network <type> | ip ospf passive'];
  }

  // ---------- switchport / VLAN membership ----------
  _switchport(tokens, iface) {
    const vlanLib = require('./vlan');
    const t = tokens.map(function (x) { return String(x).toLowerCase(); });
    const devName = this.device.name || this.device.id;

    // A switchport is a membership in a bridge domain. A router has none (it forwards between its own
    // sockets), and a logical interface has none either (an SVI *is* the domain, and a subinterface is
    // a tag on a parent that already decided). Both used to accept `switchport access vlan 10` and
    // store it, so the console confirmed a membership nothing would ever read.
    if (!this.device.isL2()) {
      return ['% ' + devName + ' does not switch - it has no switchports',
        '% Its ports are routed sockets: put the address on the port with "ip address"'];
    }
    if (iface.svi || iface.parent) {
      return ['% ' + iface.name + ' is a logical interface - it is not a switchport',
        iface.svi
          ? '% An SVI is the VLAN\'s own address, not a member of it: configure the member ports'
          : '% A subinterface carries a tag on its parent; the parent decides the VLAN'];
    }

    // A VLAN id is a number in a range, and this is where every switchport spelling gets it - the
    // internal field name (`accessVlan 9999 is outside 1-4094`) is not an answer an operator can use.
    const vlanId = function (typed, usage) {
      if (typed === undefined || String(typed).length === 0) {
        return { error: ['% Incomplete command: ' + usage] };
      }
      if (!/^\d+$/.test(String(typed))) {
        return { error: ['% VLAN id must be a number, not "' + typed + '"', '% Usage: ' + usage] };
      }
      const id = parseInt(typed, 10);
      if (!(id >= 1 && id <= 4094)) {
        return { error: ['% VLAN ' + typed + ' is outside 1-4094', '% Usage: ' + usage] };
      }
      return { id: id };
    };

    if (t[0] === 'reset') {
      iface.vlan = vlanLib.normalizePortConfig({});
      return ['Switchport reset to defaults on ' + iface.name + ' (access VLAN 1)'];
    }
    if (t[0] === 'mode') {
      const mode = t[1];
      if (mode !== 'access' && mode !== 'trunk') return ['% Usage: switchport mode access|trunk'];
      // `switchport mode trunk access` was answered "Switchport mode trunk on Fa0/1" - the trailing
      // word dropped on the floor, which reads as if it had been taken as an option.
      const modeExtra = this._noExtra(tokens, 2, 'switchport mode access|trunk');
      if (modeExtra) return modeExtra;
      const next = Object.assign({}, iface.vlan, { mode: mode });
      // A trunk with no explicit allowed list must carry everything, otherwise
      // it would silently carry no VLANs at all.
      if (mode === 'trunk' && next.allowedVlans === undefined) next.allowedVlans = 'all';
      iface.vlan = vlanLib.normalizePortConfig(next);
      return ['Switchport mode ' + mode + ' on ' + iface.name];
    }
    if (t[0] === 'access' && t[1] === 'vlan') {
      const got = vlanId(tokens[2], 'switchport access vlan <id>');
      if (got.error) return got.error;
      const extra = this._noExtra(tokens, 3, 'switchport access vlan <id>');
      if (extra) return extra;
      // A VLAN named by a port but never created was shown by `show vlan` as an active VLAN with the
      // port in it, while `show running-config` had no such VLAN - the view inventing a bridge domain
      // the configuration did not contain, and a saved copy that lost it. IOS creates the VLAN here
      // and says so, and the message is the only place an operator learns a VLAN now exists.
      const created = this._declareVlan(got.id);
      iface.vlan = vlanLib.normalizePortConfig(Object.assign({}, iface.vlan, { mode: 'access', accessVlan: got.id }));
      return ['Access VLAN ' + got.id + ' on ' + iface.name + (created
        ? ' (VLAN ' + got.id + ' did not exist and was created - "no vlan ' + got.id + '" removes it)'
        : '')];
    }
    if (t[0] === 'trunk' && t[1] === 'native' && t[2] === 'vlan') {
      const got = vlanId(tokens[3], 'switchport trunk native vlan <id>');
      if (got.error) return got.error;
      const extra = this._noExtra(tokens, 4, 'switchport trunk native vlan <id>');
      if (extra) return extra;
      // A native VLAN is a VLAN untagged frames land in: it carries traffic, so it has to exist.
      // (The allowed list is the one that does not, because a filter is not a bridge domain.)
      const nativeCreated = this._declareVlan(got.id);
      iface.vlan = vlanLib.normalizePortConfig(Object.assign({}, iface.vlan, { mode: 'trunk', nativeVlan: got.id }));
      return ['Trunk native VLAN ' + got.id + ' on ' + iface.name + (nativeCreated
        ? ' (VLAN ' + got.id + ' did not exist and was created)' : '')];
    }
    if (t[0] === 'trunk' && t[1] === 'allowed' && t[2] !== 'vlan') {
      // `switchport trunk allowed` answered "% Unrecognized switchport command: trunk allowed" while
      // the next word down answered "% Incomplete command" - two spellings of "you stopped one word
      // short", and neither named the form.
      return [t[2] === undefined
        ? '% Incomplete command: switchport trunk allowed vlan <list|all>'
        : '% Unrecognized switchport command: ' + t.join(' ')];
    }
    if (t[0] === 'voice' && t[1] === 'vlan') {
      // `switchport voice vlan <id>` - the field `voiceVlan` has existed, been validated and been
      // printed by the reset message since VLANs were modelled, and nothing ever wrote it: the
      // command did not exist, so a phone port could not be configured at all and a lab could only
      // carry voice by pretending the phone spoke on the data VLAN.
      const got = vlanId(tokens[2], 'switchport voice vlan <id>');
      if (got.error) return got.error;
      const extra = this._noExtra(tokens, 3, 'switchport voice vlan <id>');
      if (extra) return extra;
      const cur = vlanLib.normalizePortConfig(iface.vlan);
      // The mode is a property of the port and the voice VLAN is a parameter of it: setting one must
      // not move the other. That is requirement and reality at once - `switchport access vlan 20`
      // sets the mode (the word "access" means the mode), and a phone port is *an access port plus a
      // tagged second VLAN*, so the voice form must work on an access port without turning it into a
      // trunk. Both modes are legal, and both are refused only for a real contradiction.
      const untagged = cur.mode === 'trunk' ? (Number(cur.nativeVlan) || 1) : (Number(cur.accessVlan) || 1);
      if (got.id === untagged) {
        // A state refusal, not a spelling one: the command is well formed and the number is legal,
        // it just names the VLAN that already leaves this port untagged. A voice VLAN must be a
        // different VLAN, because the tag is the only thing that tells the two apart on the wire.
        return ['% VLAN ' + got.id + ' is the VLAN that leaves ' + iface.name + ' untagged' +
          (cur.mode === 'trunk' ? ' (the native VLAN)' : ' (the access VLAN)'),
          '% Tagged voice traffic must land in a different VLAN - move the data VLAN first: ' +
          (cur.mode === 'trunk' ? '"switchport trunk native vlan <other>"'
            : '"switchport access vlan <other>"') + ', or choose another voice VLAN'];
      }
      const allowedNow = cur.allowedVlans;
      if (cur.mode === 'trunk' && Array.isArray(allowedNow) && allowedNow.indexOf(got.id) === -1) {
        const next = allowedNow.concat([got.id]).sort(function (a, b) { return a - b; });
        return ['% VLAN ' + got.id + ' is not in the allowed list on ' + iface.name +
          ' (it allows ' + allowedNow.join(',') + ')',
          '% A voice VLAN the trunk drops is not a voice VLAN: "switchport trunk allowed vlan ' +
          next.join(',') + '"'];
      }
      // The same creation rule as the access form: a VLAN a port names has to exist in the
      // configuration, or `show vlan` is describing a bridge domain the saved config does not have.
      const voiceCreated = this._declareVlan(got.id);
      iface.vlan = vlanLib.normalizePortConfig(Object.assign({}, cur, { voiceVlan: got.id }));
      return ['Voice VLAN ' + got.id + ' on ' + iface.name + ' (tagged; the untagged traffic on ' +
        'this port stays in VLAN ' + untagged + ')' + (voiceCreated
        ? ' - VLAN ' + got.id + ' did not exist and was created' : '')];
    }
    if (t[0] === 'trunk' && t[1] === 'allowed' && t[2] === 'vlan') {
      // `switchport trunk allowed vlan add 30` - the spelling IOS uses to widen a list without
      // retyping it - was joined into one token ("add30") and refused with the *parser's* words:
      // `% cannot parse VLAN token "add30"`. Three defects in one line: a real command that did not
      // exist, an error message written in the library's vocabulary, and no way to narrow a list
      // without retyping the whole thing (so `show vlan` and the notice on a new subinterface were
      // both pointing at a command that could not be run).
      let rest = t.slice(3);
      let op = null;
      if (rest.length > 1 && (rest[0] === 'add' || rest[0] === 'remove')) {
        op = rest[0];
        rest = rest.slice(1);
      } else if (rest.length > 1 && rest[0] === 'except') {
        return ['% This console keeps an explicit allowed list, so there is no "except" form',
          '% Use "switchport trunk allowed vlan add <list>" or "... remove <list>"'];
      }
      const spec = rest.join(',');
      if (!spec) {
        return [op
          ? '% Incomplete command: switchport trunk allowed vlan ' + op + ' <list>' +
            ' - the VLANs to ' + (op === 'add' ? 'add' : 'remove')
          : '% Incomplete command: switchport trunk allowed vlan <list|all>'];
      }
      // An empty allowed list is a real state (the trunk carries nothing tagged) and needs a
      // spelling, or the dump cannot express it: `switchport trunk allowed vlan` with nothing after
      // it is an incomplete command, so the state would vanish on a paste.
      if (spec === 'none') {
        iface.vlan = vlanLib.normalizePortConfig(Object.assign({}, iface.vlan, { mode: 'trunk', allowedVlans: [] }));
        return ['Trunk on ' + iface.name + ' allows no VLAN: every tagged frame is dropped there'];
      }
      if (spec === 'all') {
        iface.vlan = vlanLib.normalizePortConfig(Object.assign({}, iface.vlan, { allowedVlans: 'all' }));
        return ['Trunk on ' + iface.name + ' allows all VLANs'];
      }
      const parsed = vlanLib.parseVlanList(spec);
      if (!parsed.ok) {
        // The library's complaint names a "token", which is a parser's word and not an operator's.
        return ['% "' + spec + '" is not a VLAN id, a list (10,20) or a range (10-20)',
          '% Usage: switchport trunk allowed vlan <list|all> [add|remove <list>]'];
      }
      const bad = parsed.vlans.filter(function (v) { return v < 1 || v > 4094; });
      if (bad.length) return ['% VLAN out of range: ' + bad[0]];
      if (!op) {
        iface.vlan = vlanLib.normalizePortConfig(Object.assign({}, iface.vlan, { mode: 'trunk', allowedVlans: parsed.vlans }));
        return ['Trunk on ' + iface.name + ' allows VLANs ' + parsed.vlans.join(',')];
      }
      const current = iface.vlan.allowedVlans;
      if (!Array.isArray(current)) {
        if (op === 'add') return ['Trunk on ' + iface.name + ' already allows every VLAN - nothing to add'];
        return ['% The trunk on ' + iface.name + ' allows all VLANs - there is no list to remove ' +
          parsed.vlans.join(',') + ' from',
          '% Give it an explicit list first: "switchport trunk allowed vlan <list>"'];
      }
      const next = op === 'add'
        ? current.concat(parsed.vlans.filter(function (v) { return current.indexOf(v) === -1; }))
          .sort(function (a, b) { return a - b; })
        : current.filter(function (v) { return parsed.vlans.indexOf(v) === -1; });
      if (op === 'add' && next.length === current.length) {
        return ['Trunk on ' + iface.name + ' already allows ' + parsed.vlans.join(',')];
      }
      iface.vlan = vlanLib.normalizePortConfig(Object.assign({}, iface.vlan, { mode: 'trunk', allowedVlans: next }));
      const lines = [op === 'add'
        ? 'Trunk on ' + iface.name + ' now allows VLANs ' + next.join(',')
        : 'Trunk on ' + iface.name + ' no longer allows ' + parsed.vlans.join(',') +
          ' (now: ' + (next.length ? next.join(',') : 'nothing tagged') + ')'];
      if (!next.length) lines.push('  No VLAN is allowed on this trunk: every tagged frame it receives is dropped');
      return lines;
    }
    if (t[0] === 'no') {
      // Every `no switchport …` used to become a full reset. A removal has to be as narrow as the
      // command that added the thing: remove a VLAN from a list and the list shrinks; remove the mode
      // and the mode goes back to access. Only `no switchport` on its own is a reset.
      const rest = t.slice(1);
      if (!rest.length) {
        iface.vlan = vlanLib.normalizePortConfig({});
        return ['Switchport reset to defaults on ' + iface.name + ' (access VLAN 1)'];
      }
      if (rest[0] === 'mode') {
        const extra = this._noExtra(rest, 1, 'no switchport mode');
        if (extra) return extra;
        iface.vlan = vlanLib.normalizePortConfig(Object.assign({}, iface.vlan, { mode: 'access' }));
        return ['Switchport mode access on ' + iface.name +
          ' (the default) - access VLAN ' + (iface.vlan.accessVlan || 1) + ' is unchanged'];
      }
      if (rest[0] === 'access' && rest[1] === 'vlan') {
        const extra = this._noExtra(rest, 2, 'no switchport access vlan');
        if (extra) return extra;
        const had = iface.vlan.accessVlan || 1;
        iface.vlan = vlanLib.normalizePortConfig(Object.assign({}, iface.vlan, { accessVlan: 1 }));
        return ['Access VLAN 1 on ' + iface.name + ' (the default, was VLAN ' + had + ')'];
      }
      if (rest[0] === 'trunk' && rest[1] === 'native' && rest[2] === 'vlan') {
        const extra = this._noExtra(rest, 3, 'no switchport trunk native vlan');
        if (extra) return extra;
        const had = iface.vlan.nativeVlan || 1;
        iface.vlan = vlanLib.normalizePortConfig(Object.assign({}, iface.vlan, { nativeVlan: 1 }));
        return ['Trunk native VLAN 1 on ' + iface.name + ' (the default, was VLAN ' + had + ')'];
      }
      if (rest[0] === 'voice' && rest[1] === 'vlan') {
        const extra = this._noExtra(rest, 2, 'no switchport voice vlan');
        if (extra) return extra;
        const cur = vlanLib.normalizePortConfig(iface.vlan);
        if (cur.voiceVlan === null) {
          return [iface.name + ' has no voice VLAN - nothing to remove'];
        }
        const had = cur.voiceVlan;
        iface.vlan = vlanLib.normalizePortConfig(Object.assign({}, cur, { voiceVlan: null }));
        return ['Voice VLAN removed from ' + iface.name + ' (was VLAN ' + had +
          '; tagged frames for it are now classified by the allowed list alone)'];
      }
      if (rest[0] === 'trunk' && rest[1] === 'allowed' && rest[2] === 'vlan') {
        const spec = rest.slice(3).join('');
        if (!spec) {
          iface.vlan = vlanLib.normalizePortConfig(Object.assign({}, iface.vlan, { allowedVlans: 'all' }));
          return ['Trunk on ' + iface.name + ' allows all VLANs (no explicit list)'];
        }
        const current = iface.vlan.allowedVlans;
        const parsed = vlanLib.parseVlanList(spec);
        if (!parsed.ok) return ['% ' + (parsed.message || 'invalid VLAN list')];
        if (!Array.isArray(current)) {
          return ['% The trunk on ' + iface.name + ' allows all VLANs - there is no list to remove ' +
            parsed.vlans.join(',') + ' from',
            '% Give it an explicit list first: "switchport trunk allowed vlan <list>"'];
        }
        const gone = parsed.vlans.filter(function (v) { return current.indexOf(v) !== -1; });
        if (!gone.length) {
          return ['% VLAN ' + parsed.vlans.join(',') + ' is not in the allowed list on ' + iface.name +
            ' (it allows ' + current.join(',') + ')'];
        }
        const left = current.filter(function (v) { return gone.indexOf(v) === -1; });
        iface.vlan = vlanLib.normalizePortConfig(Object.assign({}, iface.vlan, { allowedVlans: left }));
        return ['Trunk on ' + iface.name + ': removed ' + gone.join(',') +
          (left.length ? ', still allows ' + left.join(',') : ' - the list is now empty')];
      }
      return ['% Unrecognized no switchport command: ' + rest.join(' ')];
    }
    if (!t.length || !t[0]) {
      return ['% Incomplete command: switchport mode access|trunk',
        '% Also: switchport access vlan <id> | switchport trunk native vlan <id> | ' +
        'switchport trunk allowed vlan <list|all> | switchport voice vlan <id>'];
    }
    return ['% Unrecognized switchport command: ' + t.join(' ')];
  }

  // ---------- link aggregation ----------
  _channelGroup(tokens, iface) {
    const lagLib = require('./lag');
    const dev = this.device;
    // A channel-group bundles switch ports into one logical link. A PC with one Ethernet port and a
    // router bundling its routed interfaces both accepted the command and answered "Interface eth0
    // added to channel group 1 (LACP active)" - while `show etherchannel` had just been taught to
    // refuse a device that does not switch, so the two disagreed about the same hardware.
    if (typeof dev.isL2 === 'function' && !dev.isL2()) {
      return ['% ' + (dev.name || dev.id) + ' does not switch, so it has no switch ports to bundle',
        '% A channel-group makes several switch ports act as one link ("show etherchannel")',
        '% Routed interfaces are a routing problem: see "ip route" and "show ip route"'];
    }
    // A LAG groups physical ports. An SVI is not a port at all, and it accepted the command and
    // joined the group - so `show etherchannel` listed a member with no wire behind it.
    const logical = this._logicalPortRefusal(iface, 'it cannot join a link aggregation group',
      'A LAG bundles physical switch ports into one link ("show etherchannel"); an SVI is the ' +
      'address its VLAN answers on and has no members to bundle');
    if (logical) return logical;
    const t = tokens.map(function (x) { return String(x).toLowerCase(); });
    if (!dev.config.lags) dev.config.lags = {};

    // The console's words and the library's words are not the same words. `channel-group 1 mode
    // active` was stored verbatim as `mode: 'active'`, while `lag.js` knows only `lacp-active`,
    // `lacp-passive` and `static` - so every single use of the command answered
    //
    //   % Warning: LAG lag1: unknown mode "active" (expected one of lacp-active, lacp-passive, static)
    //
    // a warning about the console's own vocabulary, and `mode on` - which means *static*, no LACP - was
    // rejected the same way, so the one mode that is not LACP could not be configured at all.
    const MODES = LAG_CLI_MODES;
    const modeWord = lagModeWord;

    if (t[0] === 'no') {
      const rest = t.slice(1);
      if (!rest.length) {
        const was = [];
        for (const id of Object.keys(dev.config.lags)) {
          const l = dev.config.lags[id];
          if ((l.members || []).indexOf(iface.name) === -1) continue;
          l.members = l.members.filter(function (m) { return m !== iface.name; });
          was.push(id);
          if (!l.members.length) delete dev.config.lags[id];
        }
        return [was.length
          ? 'Removed ' + iface.name + ' from channel group ' + was.join(', ')
          : iface.name + ' is not in any channel group - nothing to remove'];
      }
      const idText = rest[0];
      const extra = this._noExtra(rest, 1, 'no channel-group [<id>]');
      if (extra) return extra;
      if (!/^\d+$/.test(idText)) {
        return ['% Channel group id must be a number, not "' + idText + '"',
          '% Usage: no channel-group [<id>]'];
      }
      const lag = dev.config.lags[idText];
      if (!lag || (lag.members || []).indexOf(iface.name) === -1) {
        return ['% ' + iface.name + ' is not in channel group ' + idText,
          '% "show etherchannel" lists the groups and their member ports'];
      }
      lag.members = lag.members.filter(function (m) { return m !== iface.name; });
      const left = lag.members.length;
      if (!left) delete dev.config.lags[idText];
      return ['Removed ' + iface.name + ' from channel group ' + idText +
        (left ? ' (' + left + ' port' + (left === 1 ? '' : 's') + ' left)' : ' - the group is gone')];
    }

    const idText = t[0];
    if (!idText) return ['% Usage: channel-group <id> mode active|passive|on'];
    if (!/^\d+$/.test(idText)) {
      return ['% Channel group id must be a number, not "' + idText + '"',
        '% Usage: channel-group <id> mode active|passive|on'];
    }
    const groupNum = parseInt(idText, 10);
    if (!(groupNum >= 1 && groupNum <= 4096)) {
      return ['% Channel group ' + idText + ' is outside 1-4096'];
    }
    let mode = 'active';
    const mi = t.indexOf('mode');
    if (mi !== -1) {
      if (!t[mi + 1]) return ['% Incomplete command: channel-group ' + idText + ' mode active|passive|on'];
      mode = t[mi + 1];
      // Anything after the mode is a word the command has no slot for.
      const after = t.slice(mi + 2).filter(function (x) { return String(x).length; });
      if (after.length) {
        return ['% Unexpected argument "' + after.join(' ') + '" - channel-group <id> mode ' +
          'active|passive|on takes no more'];
      }
    } else if (t.length > 1) {
      return ['% Unexpected argument "' + t.slice(1).join(' ') + '" - channel-group <id> ' +
        'mode active|passive|on takes no more'];
    }
    const libMode = MODES[mode];
    if (!libMode) return ['% Invalid mode: ' + mode + ' (use active|passive|on)'];
    const g = dev.config.lags[idText] || { mode: libMode, hashPolicy: 'l2', members: [] };
    g.mode = libMode;
    if (g.members.indexOf(iface.name) === -1) g.members.push(iface.name);
    dev.config.lags[idText] = g;

    const out = ['Interface ' + iface.name + ' added to channel group ' + idText +
      ' (' + modeWord(libMode) + ')'];
    const chk = lagLib.validateLag ? lagLib.validateLag(g) : null;
    if (chk && chk.errors && chk.errors.length) {
      // "needs at least 2 member ports" is true of every bundle the moment its first port is added,
      // so saying it now would train the reader to ignore this line. Everything else is worth saying.
      const real = chk.errors.filter(function (e) { return e.code !== 'E_LAG_TOO_FEW'; });
      if (real.length) out.push('% Warning: ' + real[0].message);
    }
    return out;
  }

  // `clear ip nat translation [*]` / `clear ip nat translation <inside-local>` - empty the entries,
  // not the rules. IOS takes `*`, a bare local address, or a global/local pair; this model answers
  // the first two and refuses a pair by naming the form it has.
  _clearNat(rest) {
    const dev = this.device;
    if (this.mode !== MODE_ENABLE) {
      return ['% clear ip nat translation needs enable mode' + NEEDS.enable];
    }
    const what = String(rest[0] || '').toLowerCase();
    if (what !== 'translation' && what !== 'translations') {
      return ['% Incomplete command: clear ip nat translation [*]',
        '% (clear the entries with "*", or one host\'s entries with its inside-local address)'];
    }
    const table = dev.natTable;
    const entries = (table && table.translations) ? table.translations : [];
    if (rest.length > 1 && String(rest[1]) !== '*') {
      const arg = String(rest[1]);
      if (rest.length > 2) {
        return ['% Unexpected argument "' + rest[2] + '" - clear ip nat translation takes one',
          '% Usage: clear ip nat translation [*|<inside-local>]'];
      }
      const gone = entries.filter(function (e) { return String(e.insideLocal) === arg; });
      if (!gone.length) {
        const known = Array.from(new Set(entries.map(function (e) { return e.insideLocal; })));
        return ['% No translations for ' + arg + ' on ' + (dev.name || dev.id),
          '% Inside locals with entries: ' + (known.length ? known.join(', ') : '(none)')];
      }
      for (const e of gone) {
        const at = entries.indexOf(e);
        if (at >= 0) entries.splice(at, 1);
      }
      return [gone.length + ' translation' + (gone.length === 1 ? '' : 's') + ' for ' + arg +
        ' cleared on ' + (dev.name || dev.id)];
    }
    const n = entries.length;
    if (!n) return ['Translation table on ' + (dev.name || dev.id) + ' was already empty'];
    entries.length = 0;
    return [n + ' translation' + (n === 1 ? '' : 's') + ' cleared on ' + (dev.name || dev.id) +
      ' (the rules are untouched - use "no ip nat inside source …" for those)'];
  }

  // `show spanning-tree summary` (counts) and `show spanning-tree root` (who is root, and what it
  // costs this bridge to reach it) - both rendered from the election's own result, so neither can
  // disagree with the table `show spanning-tree` prints.
  _showStpSummary(dev, wantRoot, wantVlan) {
    const vlanNote = wantVlan === undefined || wantVlan === null ? null
      : 'VLAN ' + wantVlan + ' (one tree covers every VLAN on this device)';
    const st = dev.stp || { states: {}, roles: {}, costs: {}, blocked: new Set() };
    const ports = Object.keys(st.states || {}).sort();
    const rootName = (function (self) {
      if (!st.root || !st.root.mac) return null;
      if (st.isRoot) return self.name || self.id;
      const sim = this.sim;
      if (!sim) return null;
      for (const other of sim.topo.devices.values()) {
        if (other.stp && String(other.stp.bridgeId || '') === String(st.root.mac)) {
          return other.name || other.id;
        }
      }
      return null;
    }).call(this, dev);
    const rootPort = ports.filter(function (p) { return st.roles[p] === 'root'; })[0] || null;
    const rootPriority = st.root && st.root.priority !== undefined && st.root.priority !== null
      ? st.root.priority : require('./stp').STP_DEFAULT_PRIORITY;

    if (wantRoot) {
      // "for VLAN 1" was a specificity the model does not have: one tree covers every VLAN, so
      // naming one made the header look like a per-VLAN answer and made VLAN 1 look configured.
      const out = ['Root bridge for ' + (vlanNote || 'every VLAN (one tree)') + ': priority ' + rootPriority + ', ' +
        (st.root && st.root.mac ? st.root.mac : 'unknown') +
        (rootName ? ' (' + rootName + ')' : '') + (st.isRoot ? ' - this bridge' : '')];
      if (st.isRoot) {
        out.push('  This bridge is the root: root path cost 0, every port is designated or blocking');
      } else {
        out.push('  Root path cost for ' + (dev.name || dev.id) + ': ' +
          (st.pathCost === null || st.pathCost === undefined ? '?' : st.pathCost));
        out.push('  Root port: ' + (rootPort || 'none - no port leads to the root'));
        if (!rootPort) {
          out.push('  (a bridge with no root port is not reaching the root: check the link to it)');
        }
      }
      return out;
    }

    const counts = { forwarding: 0, blocking: 0, listening: 0, learning: 0 };
    const byRole = {};
    for (const p of ports) {
      const state = String(st.states[p] || 'forwarding');
      counts[state] = (counts[state] || 0) + 1;
      const role = String(st.roles[p] || '-');
      byRole[role] = (byRole[role] || 0) + 1;
    }
    const out = [];
    out.push('Spanning tree enabled protocol ieee - summary for ' + (dev.name || dev.id));
    out.push('  Root bridge: priority ' + rootPriority + ', ' +
      (st.root && st.root.mac ? st.root.mac : 'unknown') + (rootName ? ' (' + rootName + ')' : '') +
      (st.isRoot ? ' - this bridge' : ''));
    out.push('  Root path cost: ' + (st.isRoot ? 0 :
      (st.pathCost === null || st.pathCost === undefined ? '?' : st.pathCost)));
    out.push('  Ports in the tree: ' + ports.length +
      ' (root ' + (byRole.root || 0) + ', designated ' + (byRole.designated || 0) +
      ', alternate ' + (byRole.alternate || 0) + ')');
    out.push('  Port states: ' + ['forwarding', 'blocking', 'listening', 'learning']
      .filter(function (k) { return counts[k]; })
      .map(function (k) { return counts[k] + ' ' + k; }).join(', ') +
      (ports.length ? '' : ' (no port is bridged)'));
    if (counts.blocking) {
      out.push('  ' + counts.blocking + ' port' + (counts.blocking === 1 ? ' is' : 's are') +
        ' blocking: the loop is cut, which is the tree working');
    }
    return out;
  }

  // `clear port-security {counters|dynamic|sticky} [interface <port>]`.
  //
  // The recovery message on an err-disabled port tells the operator this command resets the violation
  // count - and it did not exist, so the console was pointing at itself. Three things can be cleared
  // and they are three different things: the evidence (counters), what was learned (dynamic), and what
  // was pinned (sticky). Clearing one must not clear another, or "clear the counters" would silently
  // unsecure the port.
  _clearPortSecurity(args) {
    const dev = this.device;
    if (this.mode !== MODE_ENABLE) {
      return ['% clear port-security needs enable mode' + NEEDS.enable];
    }
    if (!dev.isL2 || !dev.isL2()) {
      return ['% ' + (dev.name || dev.id) + ' does not switch, so it has no port security to clear'];
    }
    const what = String(args[0] || '').toLowerCase();
    const usage = 'clear port-security {counters|dynamic|sticky} [interface <port>]';
    if (!what) {
      return ['% Incomplete command: ' + usage,
        '% counters reset the violation evidence, dynamic forgets what was learned, sticky unpins what was pinned'];
    }
    if (['counters', 'dynamic', 'sticky'].indexOf(what) === -1) {
      return ['% "' + args[0] + '" is not something clear port-security can clear',
        '% Usage: ' + usage];
    }
    let rest = args.slice(1);
    if (rest.length && String(rest[0]).toLowerCase() === 'interface') rest = rest.slice(1);
    let only = null;
    if (rest.length) {
      const pick = this._portArg(rest, dev, 'clear port-security ' + what, null);
      if (!pick.ok) return pick.output;
      only = pick.port;
    }
    const ports = psLib.securedPorts(dev).filter(function (n) { return !only || n === only; });
    if (only && !ports.length) {
      return ['Port security is not enabled on ' + only,
        '% Secured ports: ' + (psLib.securedPorts(dev).join(', ') || 'none')];
    }
    if (!ports.length) {
      return ['% No ports have port security enabled on ' + (dev.name || dev.id)];
    }
    const where = only || (dev.name || dev.id);
    if (what === 'counters') {
      let total = 0;
      const had = [];
      for (const name of ports) {
        const st = psLib.peek(dev, name);
        if (st.violations) { had.push(name + ' (' + st.violations + ')'); total += st.violations; }
        st.violations = 0;
      }
      if (!total) return ['Security violation counters on ' + where + ' were already zero - nothing to clear'];
      return ['Security violation counters cleared on ' + where + ' (' + total + ')',
        '  The ports stay as they are: a count of what happened, not the state it left behind' +
          (had.length ? ' - was ' + had.join(', ') : '')];
    }
    if (what === 'dynamic') {
      const n = psLib.clearDynamic(dev, only || undefined);
      if (!n) {
        return ['No learned secure addresses on ' + where + ' - nothing to clear',
          '  Configured and sticky addresses are kept by definition'];
      }
      return ['Learned secure addresses cleared on ' + where + ' (' + n + ')',
        '  Configured and sticky addresses are kept: they were not learned'];
    }
    const n = psLib.clearSticky(dev, only || undefined);
    if (!n) return ['No sticky secure addresses on ' + where + ' - nothing to clear'];
    return ['Sticky secure addresses cleared on ' + where + ' (' + n + ')',
      '  The stations must be learned again, and the next one may be a different station'];
  }

  // `show interfaces <port> switchport` - the L2 view of one port. It was silently ignored: the
  // plain detail view was printed and the word `switchport` dropped, so an operator checking a trunk
  // was shown the counters of one and told nothing about it.
  // The counters table, for the family form and for `show interfaces <port> counters` - one renderer,
  // so a port's own counters and its row in the device table cannot disagree.
  _showCounters(dev, port) {
    if (!this.sim) return ['% No simulation is running, so nothing has been counted'];
    let rows = this.sim.portStats(dev.id);
    if (port) rows = rows.filter(function (r) { return r.iface === port; });
    const out = ['Interface counters on ' + dev.name + (port ? ' for ' + port : '') + ':'];
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

  _showPortSwitchport(dev, iface) {
    const v = iface.vlan || { mode: 'access', accessVlan: 1 };
    const mode = String(v.mode || 'access').toLowerCase();
    const out = ['Name: ' + iface.name,
      '  Administrative Mode: ' + (mode === 'trunk' ? 'trunk' : mode === 'access' ? 'static access' : mode) +
        // The model calls it `enabled`, not `shutdown`: a port is disabled by `shutdown` and enabled
        // by `no shutdown`, and `_ifaceState()` reads the same field.
        (iface.enabled === false ? ' (administratively down)' : '')];
    if (mode === 'trunk') {
      const allowed = v.allowedVlans === 'all' || !Array.isArray(v.allowedVlans)
        ? 'ALL' : v.allowedVlans.slice().sort(function (a, b) { return a - b; }).join(',');
      out.push('  Operational Mode: trunk');
      out.push('  Trunking Native Mode VLAN: ' + (Number(v.nativeVlan) || 1));
      out.push('  Trunking VLANs Enabled: ' + allowed);
      out.push('  Administrative private-vlan: none');
    } else if (mode === 'access') {
      out.push('  Operational Mode: static access');
      const vid = Number(v.accessVlan) || 1;
      const decl = (dev.config.vlans || {})[vid];
      const vname = typeof decl === 'string' ? decl : (decl && decl.name ? String(decl.name) : '');
      // The name only when there is one: the line used to end in a trailing space otherwise.
      out.push('  Access Mode VLAN: ' + vid + (vname ? ' (' + vname + ')' : ''));
    } else {
      out.push('  Operational Mode: ' + mode);
    }
    // This line was hardcoded `none` for every port in the lab, including one that (once the command
    // existed) had been told to carry voice. A view that cannot say yes is not a view.
    const voiceVlan = Number(v.voiceVlan) || null;
    out.push('  Voice VLAN: ' + (voiceVlan ? String(voiceVlan) + ' (tagged)' : 'none'));
    // Port security is part of this view on a real switch, and it is modelled here.
    const sec = dev.portSecurity && dev.portSecurity.ports ? dev.portSecurity.ports[iface.name] : null;
    if (sec && sec.enabled) {
      out.push('  Port Security: Enabled');
      out.push('  Maximum MAC Addresses: ' + (sec.maximum || 1));
      out.push('  Violation Mode: ' + (sec.violation || 'shutdown'));
      out.push('  Status: ' + (sec.errDisabled ? 'Secure-shutdown' : 'Secure-up'));
      const total = (sec.configured || []).length + (sec.sticky || []).length + (sec.learned || []).length;
      out.push('  Total Addresses: ' + total);
    } else {
      out.push('  Port Security: Disabled');
    }
    out.push('  Description: ' + (iface.description || '-'));
    if (iface.channelGroup || iface.lag) {
      out.push('  Channel-group: ' + (iface.channelGroup || iface.lag));
    }
    return out;
  }

  // Commands an operator brings from a real device or a lab guide, which this model deliberately
  // does not have. `% Invalid show command: cdp neighbors` reads like a typo, so the operator retypes
  // it and then goes looking for a bug that is not there. Naming the equivalent here costs one table
  // and turns a dead end into a redirection.
  _absentShow(tokens) {
    const words = tokens.map(function (t) { return String(t).toLowerCase(); });
    const has = function (w) { return words.indexOf(w) !== -1; };
    const first = words[0] || '';
    if (first === 'cdp') {
      return ['% CDP is not modelled: nothing here speaks it',
        '% These devices speak LLDP, and the table is the same one you were asking for:',
        '%   show lldp neighbors [<port>]      who is on the other end of each port',
        '%   show lldp neighbors detail        chassis, port, TTL and medium per neighbour',
        '%   show lldp interface               the per-port transmit/receive decision'];
    }
    // `show tech-support` is the first thing an operator types when a device misbehaves, and the
    // honest answer is not "invalid command": it is the list of views this model does keep, which
    // answer the same questions.
    if (first === 'tech-support' || (first === 'tech' && words[1] === 'support')) {
      return ['% There is no tech-support bundle here: no memory image, no register state, no log file to collect',
        '% The views that answer the same questions in this model:',
        '%   show version / show running-config     what this device is and how it is configured',
        '%   show interfaces / show interfaces counters   ports, addresses and per-port drops',
        '%   show ip route / show ip ospf / show ip bgp summary   the forwarding state',
        '%   show logging / show history            what happened, and what was typed'];
    }
    if (first === 'memory' || first === 'buffers' || first === 'controllers') {
      // A logical model has no RAM, no buffer pools and no register dumps - and inventing numbers for
      // them would be the same class of lie as an invented VLAN row.
      return ['% No memory, buffers or controller registers: this model keeps no hardware counters',
        '% What it does keep is the forwarding state and what happened to each packet:',
        '%   show interfaces counters   packets, bytes and drops per port',
        '%   show logging              every drop, with the reason it was dropped'];
    }
    if (first === 'diagnostic' || first === 'diagnostics' || first === 'selftest') {
      return ['% No on-board diagnostics: there is no hardware to test, so no self-test result exists',
        '% A port that is up and passing traffic is "up" in "show interfaces status"'];
    }
    if (first === 'flash' || first === 'filesystems' || first === 'boot' || first === 'license') {
      return ['% No filesystem, no boot image and no licence: nothing here is stored on disk',
        '% Configuration lives in this session: "write memory" keeps it as the startup config,',
        '%   and "show running-config" / "show startup-config" show the two sides'];
    }
    if (first === 'module' || first === 'stack' || first === 'chassis') {
      return ['% One fixed chassis: this model has no modules, no stacking and no supervisor slots',
        '% What the device is, including its port count, is in "show version"'];
    }
    if (first === 'standby' || (first === 'hsrp')) {
      // HSRP is the Cisco-only twin of the first-hop redundancy this model does have. Naming the
      // one it has is more use than a typo complaint.
      return ['% HSRP is not modelled: the first-hop redundancy here is VRRP',
        '%   show vrrp                  groups, priorities, state and virtual MAC',
        '%   vrrp <id> ip <addr>        inside an interface block, adds a group'];
    }
    if (first === 'inventory') {
      return ['% There is no inventory: this model has no serial numbers, no FRUs and no modules',
        '% What a device is: "show version" (vendor, model, capabilities, port count)',
        '% What its optics are: "show interfaces transceiver" (cage, medium, reach vs cable)'];
    }
    if (first === 'environment' || first === 'power' && has('supply')) {
      return ['% There are no environmental sensors here: no temperature, fan or PSU readings are modelled',
        '% The one power view this model keeps is PoE: "show power inline" (budget, allocation, denied ports)'];
    }
    if (first === 'terminal') {
      // The settings this console actually has. `terminal length`/`width` are real words here now, so
      // the question "what are they set to" needs an answer - and the answer includes the fact that
      // there is no pager, which is why `length 0` changes nothing anybody can see.
      const rows = [
        ['Terminal length', (this.terminalLength === undefined ? '0 (default)' : String(this.terminalLength))],
        ['Terminal width', (this.terminalWidth === undefined ? '80 (default)' : String(this.terminalWidth))],
        ['Pager', 'none - every line of a view is printed'],
        ['Session', (this.device.name || this.device.id) + ', ' + (this.mode === MODE_ENABLE ? 'privileged' : 'user') + ' exec']
      ];
      return ['Console settings for this session:'].concat(
        renderTable(['Setting', 'Value'], rows));
    }
    if (first === 'users' || first === 'sessions' || first === 'line') {
      return ['% One session: this console. Nothing else can log in, and there is no VTY line to configure',
        '% What this session has done is in "show history"'];
    }
    if (first === 'processes' || has('cpu')) {
      return ['% No CPU and no scheduler: every device forwards at line rate in this model',
        '% The only delay is serialisation at each port, and it is reported per packet:',
        '%   show interfaces counters            packets, bytes and drops per port'];
    }
    if (first === 'switchport') {
      // The three tables that carry the same facts, named so the operator does not have to guess.
      return ['% This model has no "show switchport": a port\'s L2 state is split across three tables',
        '%   show interfaces status             connected/notconnect, VLAN, duplex, speed, type',
        '%   show interfaces <port>             switchport mode, access VLAN, trunking, port security',
        '%   show interfaces <port> switchport  mtu, speed, duplex, description for one port'];
    }
    if (first === 'interfaces' && (has('switchport') || has('counters') && has('errors'))) {
      return ['% No port-level error counters are kept: this model drops frames by name instead',
        '% Every drop is an event with the reason (mtu, acl, port-security, no-cable), so:',
        '%   show interfaces counters            packets, bytes and drops per port',
        '%   show interfaces <port>              the drops on one port, in words'];
    }
    if (first === 'ip' && (has('eigrp') || has('rip'))) {
      return ['% This model runs OSPF and BGP; EIGRP and RIP are not modelled',
        '%   router ospf <pid>       "network <net> <wildcard> area <id>" sets the areas',
        '%   router bgp <as>         neighbours, then "show ip bgp" for what was installed',
        '%   show ip route           what any of them installed, with the protocol beside each row'];
    }
    // `show clock` is implemented and answers in its own words, so it is not in this table; `ntp` is
    // the one that has nowhere else to go.
    if (first === 'ntp') {
      return ['% There is no wall clock here, so no time source to synchronise with',
        '% Time is whatever you ask about: append "at <ms>" or "converged" to a show that depends on it',
        '%   show mac address-table at 50       the table as it stood 50 ms into the run'];
    }
    return null;
  }

  // `show history` - the commands typed into this session, from the console's own record.
  _showHistory() {
    const h = (this.history || []).slice();
    const size = 10;
    const shown = h.slice(Math.max(0, h.length - size));
    if (!shown.length) return ['No commands in this session yet'];
    const out = ['Last ' + shown.length + ' command' + (shown.length === 1 ? '' : 's') + ' in this session:'];
    shown.forEach(function (line, i) {
      out.push('  ' + String(i + 1) + '  ' + line);
    });
    if (h.length > size) out.push('  (' + h.length + ' typed; IOS keeps the last ' + size + ' by default)');
    return out;
  }

  // `show lldp` - the device's own LLDP state, which nothing printed: the console had exactly one
  // LLDP view (the neighbour table), so "is it on, on which ports, and has anything crossed them" had
  // no answer even though all three are modelled.
  _showLldpGlobal(dev) {
    const off = dev.config.lldp && dev.config.lldp.run === false;
    const ports = Array.from(dev.interfaces.values()).filter(function (i) { return !i.svi && !i.parent; });
    const txOn = off ? [] : ports.filter(function (i) { return i.lldpTx !== false && i.peer; });
    const out = [
      'Global LLDP Information:',
      '    Status: ' + (off ? 'DISABLED (no lldp run)' : 'ACTIVE'),
      '    LLDP advertisements are sent every ' + (lldpLib.DEFAULT_INTERVAL_S || 30) + ' seconds',
      '    LLDP hold time (before discarding): ' + (lldpLib.DEFAULT_TTL_S || 120) + ' seconds',
      '    LLDP snooping: disabled',
      '    Announcements on: ' + (txOn.length
        ? txOn.map(function (i) { return i.name; }).join(', ')
        : '(no port - nothing is cabled, or every port is told not to transmit)'),
      '    Neighbours learned: ' + (dev.lldp ? dev.lldp.size : 0),
      '',
      '  "show lldp neighbors" lists them, "show lldp neighbors detail" describes each one,',
      '  "show lldp interface" prints the per-port decision, "show lldp traffic" the counters'
    ];
    return out;
  }

  // `show lldp neighbors detail` - one block per neighbour, from the LLDPDUs that were actually heard.
  _showLldpDetail(dev) {
    if (dev.config.lldp && dev.config.lldp.run === false) {
      return ['% LLDP is disabled on ' + (dev.name || dev.id) + ' (no lldp run)',
        '% No port listens, so nothing can be described'];
    }
    const entries = dev.lldp ? Array.from(dev.lldp.entries()) : [];
    if (!entries.length) {
      return ['% No neighbours: no LLDPDU has been heard on any port of ' + (dev.name || dev.id),
        '% A neighbour appears once its announcement has crossed the link'];
    }
    const out = [];
    for (const [port, nb] of entries) {
      out.push('--------------------------------------------------');
      out.push('Local Intf: ' + port);
      out.push('Chassis id: ' + (nb.chassisId || '?'));
      out.push('Port id: ' + (nb.portId || '?'));
      out.push('Port Description: ' + (nb.portDesc || '-'));
      out.push('System Name: ' + (nb.systemName || '-'));
      out.push('System Description:');
      out.push('  ' + (nb.systemDesc || '-'));
      out.push('Management Addresses:');
      out.push('  ' + (nb.mgmtIp || 'none advertised'));
      out.push('Time To Live: ' + nb.ttl + ' seconds');
      const p = dev.interfaces.get(port);
      out.push('Cage/medium: ' + (nb.cage ? nb.cage + (nb.speedMbps ? ' (' + nb.speedMbps + ' Mbps)' : '') : '-'));
      // The state line answered from `lineUp` alone, so a port the administrator had shut still read
      // "up - the announcement is what proves the link is passing frames": a shut port passing
      // frames is the one thing it certainly is not. `_ifaceState` is the single answer to "is this
      // interface up", and the claim about frames is only made when it is true.
      const st = p ? this._ifaceState(p) : null;
      const stale = p ? this._portNotCarryingReason(port) : null;
      out.push('Local port state: ' + (st ? st.status + '/' + st.protocol : 'gone') +
        (stale ? ' - ' + stale + ', so this block is what was learned, not what is there now'
          : ' - the announcement is what proves the link is passing frames'));
    }
    out.push('--------------------------------------------------');
    out.push('  ' + entries.length + ' neighbour' + (entries.length === 1 ? '' : 's') + ' learned by LLDPDUs that crossed the link');
    return out;
  }

  // `show lldp interface [<port>]` and `show lldp traffic` - the per-port decision and the counters.
  _showLldpInterface(dev, args, trafficOnly) {
    // `show lldp interface` takes a port and nothing else. `detail` is the natural next word to try,
    // and it belongs to the neighbour table - so it gets said, rather than being read as a port name.
    const first = String(args[0] || '').toLowerCase();
    if (first === 'detail' || first === 'summary') {
      return ['% "show lldp ' + (trafficOnly ? 'traffic' : 'interface') + '" takes a port, not "' + args[0] + '"',
        '% The per-neighbour detail is "show lldp neighbors detail"',
        '% The per-port decision is "show lldp interface" with no argument'];
    }
    const pick = this._portArg(args, dev, trafficOnly ? 'show lldp traffic' : 'show lldp interface');
    if (!pick.ok) return pick.output;
    const off = dev.config.lldp && dev.config.lldp.run === false;
    const ports = Array.from(dev.interfaces.values())
      .filter(function (i) { return !i.svi && !i.parent && (!pick.port || i.name === pick.port); });
    if (!ports.length) return ['% No port named ' + pick.port + ' on ' + (dev.name || dev.id)];
    const out = [];
    if (trafficOnly) {
      // Counters, not a neighbour list: `show lldp traffic` answering with the neighbour table was
      // an answer to a question nobody asked.
      let tx = 0, rx = 0, disc = 0, err = 0;
      const rows = [];
      for (const i of ports) {
        const t = i.lldpTxFrames || 0, r = i.lldpRxFrames || 0;
        const d = i.lldpDiscarded || 0, e = i.lldpTxErrors || 0;
        tx += t; rx += r; disc += d; err += e;
        rows.push([i.name, t, r, d, e]);
      }
      out.push('LLDP traffic on ' + (dev.name || dev.id) + (pick.port ? ' for ' + pick.port : '') + ':');
      out.push.apply(out, renderTable(['Port', 'Tx frames', 'Rx frames', 'Discarded', 'Errors'], rows, 2));
      out.push('  Totals: ' + tx + ' sent, ' + rx + ' received' +
        (disc ? ', ' + disc + ' discarded by "no lldp receive"' : '') +
        (err ? ', ' + err + ' could not be sent' : ''));
      if (!tx && !rx) {
        out.push('  (nothing yet - an announcement is sent when the lab runs, and heard when it arrives)');
      }
      return out;
    }
    out.push('LLDP interface state on ' + (dev.name || dev.id) + ':');
    out.push('  Device state: ' + (off ? 'DISABLED (no lldp run) - neither transmits nor receives' : 'ACTIVE'));
    out.push.apply(out, renderTable(['Port', 'Tx', 'Rx', 'Cabled', 'Neighbour'],
      ports.map(function (i) {
        const nb = dev.lldp ? dev.lldp.get(i.name) : null;
        return [i.name,
          off || i.lldpTx === false ? 'disabled' : 'enabled',
          off || i.lldpRx === false ? 'disabled' : 'enabled',
          i.peer ? 'yes' : 'no',
          nb ? (nb.systemName || '?') : '-'];
      }), 2));
    out.push('  "no lldp transmit" stops this port announcing, "no lldp receive" stops it hearing,');
    out.push('  and "no lldp run" stops the whole device - the three are independent');
    return out;
  }

  // `show port-security`, `show port-security interface <port>`, `show port-security address`.
  //
  // Three views because they answer three questions: which ports are secured and how many addresses
  // they hold (the summary), why *this* port is refusing traffic (the detail), and which station is
  // pinned where (the address table). A secured port that has err-disabled must be visible in the
  // summary without reading the detail, or the first question after an incident has no answer.
  _showPortSecurity(args) {
    const dev = this.device;
    if (!dev.isL2 || !dev.isL2()) {
      return ['% ' + (dev.name || dev.id) + ' does not switch, so it has no secured ports',
        '% Port security is a bridge feature'];
    }
    // Aging is applied against the instant the question is asked at, the same `at <ms>` the rest of
    // the console reads time from: an address that has aged out by then is not in the answer.
    const nowMs = (this.sim && Number.isFinite(this.sim.runAtMs)) ? this.sim.runAtMs : 0;
    const aged = psLib.age(dev, nowMs);
    const ports = psLib.securedPorts(dev);
    const sub = String(args[0] || '').toLowerCase();
    if (sub === 'address') {
      if (args.length > 1) {
        return ['% show port-security address takes no argument',
          '% Usage: show port-security address'];
      }
      const rows = psLib.addressRows(dev);
      const out = [];
      if (!rows.length) {
        // An empty table has two very different explanations - nothing was ever learned, or what was
        // learned has aged out - and printing only the first sends the operator looking for a bug.
        if (aged.length) {
          out.push('% No secure addresses at this instant: ' + aged.length + ' aged out (' +
            aged.map(function (a) { return a.mac + ' on ' + a.port; }).join(', ') + ')');
          out.push('% Secured ports with a free slot: ' + ports.join(', '));
          return out;
        }
        out.push('% No secure addresses: no port has port security enabled, or none has learned a source');
        if (ports.length) out.push('% Secured ports with no address yet: ' + ports.join(', '));
        return out;
      }
      // The VLAN column is the port's own VLAN, not a constant: a header that always said 1 made
      // every secured port on a switch with VLANs a lie about which broadcast domain the station is in.
      const vlanOf = (function (dev) {
        return function (portName) {
          const p = dev.interfaces.get(portName);
          const v = (p && p.vlan) || {};
          if (v.mode === 'trunk') return 'trunk';
          return String(v.accessVlan || 1);
        };
      })(dev);
      out.push.apply(out, renderTable(['Mac Address', 'Vlan', 'Port', 'Type', 'Age (min)'],
        rows.map(function (r) { return [r.mac, vlanOf(r.port), r.port, r.type, r.age]; })));
      const configured = rows.filter(function (r) { return r.type === 'SecureConfigured'; }).length;
      const sticky = rows.filter(function (r) { return r.type === 'SecureSticky'; }).length;
      out.push('  ' + rows.length + ' secure address' + (rows.length === 1 ? '' : 'es') + ': ' +
        configured + ' configured, ' + sticky + ' sticky, ' + (rows.length - configured - sticky) + ' learned');
      if (aged.length) {
        // Nothing else on this console would explain a shorter table than the operator expected.
        out.push('  ' + aged.length + ' address' + (aged.length === 1 ? ' has' : 'es have') +
          ' aged out by now: ' + aged.map(function (a) { return a.mac + ' on ' + a.port; }).join(', '));
      }
      return out;
    }
    if (sub === 'interface') {
      if (args.length < 2) {
        return ['% Incomplete command: show port-security interface <port>',
          '% Name the port whose port security to describe'];
      }
      if (args.length > 2) {
        return ['% show port-security interface takes one port, not "' + args.slice(1).join(' ') + '"'];
      }
      const pick = this._portArg(args.slice(1), dev, 'show port-security interface', null);
      if (!pick.ok) return pick.output;
      // Advice has to be advice somebody can take. On an SVI this said "Enable it with switchport
      // port-security in that interface" - a command this console refuses there, with the very
      // sentence that says port security needs a physical port.
      const logical = this._logicalPortRefusal(dev.interfaces.get(pick.port), 'port security needs a port',
        'A secured port is one that learns addresses; an SVI is the address its VLAN answers on');
      if (logical) return logical;
      const st = psLib.peek(dev, pick.port);
      if (!st || !st.enabled) {
        return ['Port security is not enabled on ' + pick.port,
          '  Enable it with "switchport port-security" in that interface'];
      }
      const status = st.errDisabled ? 'Secure-shutdown' : 'Secure-up';
      return [
        'Port Security              : Enabled',
        'Port Status                : ' + status,
        'Violation Mode             : ' + st.violation,
        // Real settings now, printed the way IOS prints them, with the reason when they are off.
        'Aging Time                 : ' + (st.agingTimeMin ? st.agingTimeMin + ' mins' : '0 mins'),
        'Aging Type                 : ' + (st.agingType === 'inactivity' ? 'Inactivity' : 'Absolute'),
        'SecureStatic Address Aging : ' + (st.agingStatic ? 'Enabled' : 'Disabled'),
        'Maximum MAC Addresses      : ' + st.maximum,
        'Total MAC Addresses        : ' + psLib.macCount(st),
        'Configured MAC Addresses   : ' + st.configured.length,
        'Sticky MAC Addresses       : ' + st.stickyMacs.length,
        'Last Source Address:Vlan   : ' + (st.lastSource ? st.lastSource + ':1' : '0000.0000.0000:0'),
        'Security Violation Count   : ' + st.violations
      ].concat(st.errDisabled
        ? ['', '  err-disabled: ' + st.shutdownReason, '  "shutdown" then "no shutdown" recovers the port']
        : []);
    }
    if (args.length) {
      return ['% show port-security takes "interface <port>" or "address", not "' + args.join(' ') + '"',
        '% Usage: show port-security [interface <port>|address]'];
    }
    if (!ports.length) {
      return ['% No ports have port security enabled on ' + (dev.name || dev.id),
        '% Configure one in interface mode: switchport port-security'];
    }
    const out = [];
    out.push.apply(out, renderTable(
      ['Secure Port', 'MaxSecureAddr', 'CurrentAddr', 'SecurityViolation', 'Security Action'],
      ports.map(function (name) {
        const st = psLib.peek(dev, name);
        return [name + (st.errDisabled ? ' (err-disabled)' : ''), st.maximum,
          psLib.macCount(st), st.violations, st.violation];
      })));
    out.push('  ' + ports.length + ' secured port' + (ports.length === 1 ? '' : 's') + ' of ' +
      dev.bridgedInterfaces().length + ' bridged port' +
      (dev.bridgedInterfaces().length === 1 ? '' : 's'));
    const down = ports.filter(function (n) { const s = psLib.peek(dev, n); return s && s.errDisabled; });
    if (down.length) {
      out.push('  ' + down.length + ' err-disabled by a violation: ' + down.join(', ') +
        ' - "shutdown" then "no shutdown" recovers');
    }
    return out;
  }

  // One MAC parser for every command that takes one: `0011.2233.4455` and `00:11:22:33:44:55` are the
  // same address, and the tables print the colon form, so the console accepts both and stores one.
  _parseMac(text) {
    const word = String(text || '').trim().toLowerCase();
    const dotted = /^([0-9a-f]{4})\.([0-9a-f]{4})\.([0-9a-f]{4})$/.exec(word);
    if (dotted) return (dotted[1] + dotted[2] + dotted[3]).match(/../g).join(':');
    if (/^([0-9a-f]{2}[:-]){5}[0-9a-f]{2}$/.test(word)) return word.replace(/-/g, ':');
    return null;
  }

  // `switchport port-security …`: the switch's opinion about who may speak on a port.
  //
  // Before this, the model had no opinion at all: it learned whatever source arrived and forwarded to
  // whatever it had learned. The verbs below are the four decisions IOS asks for - whether the port is
  // secured, how many addresses it may hold, where the addresses come from, and what to do when a
  // fifth one arrives - and each is validated where it is typed, because a port-security line that
  // half-applies is worse than none.
  _portSecurity(args, iface, isNo) {
    const dev = this.device;
    const usage = 'switchport port-security [maximum <n>|mac-address <mac>|mac-address sticky|violation <mode>]';
    // Refused where it is typed: a device that does not bridge has no ports to secure, and a port
    // that is not a bridged access port is not one this model secures.
    if (!dev.isL2 || !dev.isL2()) {
      return ['% ' + (dev.name || dev.id) + ' does not switch, so it has no port to secure',
        '% Port security is a bridge feature: it decides which sources a switch port may hear'];
    }
    if (iface.svi || iface.parent) {
      return ['% ' + iface.name + ' is a logical interface: port security applies to a physical port',
        '% Configure it on the port itself'];
    }
    if (iface.vlan && iface.vlan.mode === 'trunk') {
      return ['% ' + iface.name + ' is a trunk port: this model secures access ports',
        '% One address per port is what port security describes; put the port in access mode first'];
    }
    const st = psLib.peek(dev, iface.name);
    // `no switchport port-security` is the whole feature off: one line, and the port goes back to
    // learning whatever arrives. The narrower `no` forms below undo exactly what their positive form did.
    if (isNo && !args.length) {
      if (!st || !st.enabled) return ['Port security is not enabled on ' + iface.name];
      psLib.clearDynamic(dev, iface.name);
      psLib.clearSticky(dev, iface.name);
      delete dev.portSecurity.ports[iface.name];
      return ['Port security disabled on ' + iface.name,
        '  The port accepts any source again - secure addresses, counters and err-disable state are gone'];
    }
    if (!args.length) {
      if (st && st.enabled) {
        return ['Port security is already enabled on ' + iface.name +
          ' (maximum ' + st.maximum + ', violation ' + st.violation +
          (st.sticky ? ', sticky' : '') + ')'];
      }
      const fresh = psLib.portState(dev, iface.name);
      fresh.enabled = true;
      return ['Port security enabled on ' + iface.name,
        '  Maximum ' + fresh.maximum + ' secure address, violation mode ' + fresh.violation +
          ' (IOS defaults)',
        '  The first source to arrive is learned; a second one is a violation'];
    }
    const sub = String(args[0]).toLowerCase();
    const rest = args.slice(1);
    if (sub === 'maximum') {
      if (isNo) {
        const extra = this._noExtra(rest, 0, 'no switchport port-security maximum');
        if (extra) return extra;
        const cur = st || psLib.portState(dev, iface.name);
        const had = cur.maximum;
        cur.maximum = psLib.DEFAULT_MAXIMUM;
        return ['Port security maximum on ' + iface.name + ' reset to ' + psLib.DEFAULT_MAXIMUM +
          ' (was ' + had + ')'];
      }
      const extra = this._noExtra(rest, 1, 'switchport port-security maximum <1-' + psLib.MAXIMUM_LIMIT + '>');
      if (extra) return extra;
      const word = String(rest[0] || '');
      if (!word) return ['% Incomplete command: switchport port-security maximum <1-' + psLib.MAXIMUM_LIMIT + '>',
        '% The maximum is how many source addresses this port may hold'];
      if (!/^[0-9]+$/.test(word)) {
        return ['% "' + word + '" is not a number of addresses'];
      }
      const n = parseInt(word, 10);
      if (n < 1 || n > psLib.MAXIMUM_LIMIT) {
        return ['% Maximum ' + n + ' is outside 1-' + psLib.MAXIMUM_LIMIT +
          ' (IOS tops out at ' + psLib.MAXIMUM_LIMIT + ' secure addresses on one port)'];
      }
      const cur = st || psLib.portState(dev, iface.name);
      if (cur.maximum === n) return ['Port security maximum on ' + iface.name + ' is already ' + n];
      const held = psLib.macCount(cur);
      cur.maximum = n;
      const out = ['Port security maximum on ' + iface.name + ' set to ' + n];
      // Lowering the limit below what is already held is allowed by IOS and is worth saying out loud:
      // the existing addresses stay, and the next new one is a violation.
      if (held > n) {
        out.push('  The port already holds ' + held + ' secure address' + (held === 1 ? '' : 'es') +
          ' - they are kept, and the next new source is a violation');
      }
      return out;
    }
    if (sub === 'mac-address') {
      const word = String(rest[0] || '').toLowerCase();
      if (isNo && !word) {
        return ['% Incomplete command: no switchport port-security mac-address <mac|sticky>',
          '% Name the address to remove, or "sticky" to forget the sticky ones'];
      }
      if (word === 'sticky') {
        const extra = this._noExtra(rest, 1, isNo
          ? 'no switchport port-security mac-address sticky'
          : 'switchport port-security mac-address sticky');
        if (extra) return extra;
        const cur = st || psLib.portState(dev, iface.name);
        if (isNo) {
          if (!cur.sticky) return ['Sticky learning is not enabled on ' + iface.name];
          cur.sticky = false;
          return ['Sticky learning disabled on ' + iface.name,
            '  The addresses it learned stay secure, but a clear will not keep them'];
        }
        if (cur.sticky) return ['Sticky learning is already enabled on ' + iface.name];
        cur.sticky = true;
        return ['Sticky learning enabled on ' + iface.name,
          '  Addresses learned from now on are kept across a reload and a clear'];
      }
      if (!word) {
        return ['% Incomplete command: switchport port-security mac-address <mac|sticky>',
          '% Write the address as 0011.2233.4455 or 00:11:22:33:44:55'];
      }
      const mac = this._parseMac(word);
      if (!mac) return ['% "' + String(rest[0]) + '" is not a MAC address',
        '% Write it as 0011.2233.4455 or 00:11:22:33:44:55'];
      if (psLib.isGroupMac(mac)) {
        return ['% ' + mac + ' is a multicast or broadcast MAC, so no single station owns it',
          '% A secure address is one station, so it must be unicast'];
      }
      const cur = st || psLib.portState(dev, iface.name);
      if (isNo) {
        const at = cur.configured.indexOf(mac);
        if (at === -1) return ['% ' + mac + ' is not a configured secure address on ' + iface.name];
        cur.configured.splice(at, 1);
        return ['Secure address ' + mac + ' removed from ' + iface.name,
          '  The port now allows ' + psLib.macCount(cur) + ' of ' + cur.maximum];
      }
      const extra = this._noExtra(rest, 1, 'switchport port-security mac-address <mac>');
      if (extra) return extra;
      // IOS refuses the same address on two secured ports, because a station is in one place.
      const elsewhere = this._securedMacElsewhere(mac, iface.name);
      if (elsewhere) {
        return ['% ' + mac + ' is already a secure address on ' + elsewhere,
          '% One station is on one port: remove it there first'];
      }
      if (cur.configured.indexOf(mac) !== -1) {
        return ['Secure address ' + mac + ' is already configured on ' + iface.name];
      }
      cur.configured.push(mac);
      // The address is held from now, so aging has an instant to count from. Without this a
      // configured address had no timestamp and `aging static` could never remove one - the setting
      // would be accepted and do nothing, which is the defect this whole pass is about.
      const nowMs = (this.sim && Number.isFinite(this.sim.runAtMs)) ? this.sim.runAtMs : 0;
      psLib.touch(cur, mac, nowMs, true);
      const out = ['Secure address ' + mac + ' configured on ' + iface.name,
        '  The port now allows ' + psLib.macCount(cur) + ' of ' + cur.maximum];
      if (psLib.macCount(cur) > cur.maximum) {
        out.push('  That is more than the maximum: the address is kept, and every frame from it is a violation');
      }
      return out;
    }
    if (sub === 'aging') {
      return this._psAging(rest, iface, isNo, st);
    }
    if (sub === 'violation') {
      const extra = isNo ? this._noExtra(rest, 0, 'no switchport port-security violation') : this._noExtra(rest, 1, 'switchport port-security violation <protect|restrict|shutdown>');
      if (extra) return extra;
      const cur = st || psLib.portState(dev, iface.name);
      if (isNo) {
        const had = cur.violation;
        cur.violation = psLib.DEFAULT_VIOLATION;
        return ['Violation mode on ' + iface.name + ' reset to ' + psLib.DEFAULT_VIOLATION +
          ' (was ' + had + ')'];
      }
      const mode = String(rest[0] || '').toLowerCase();
      if (!mode) {
        return ['% Incomplete command: switchport port-security violation <protect|restrict|shutdown>',
          '% protect drops silently, restrict drops and counts, shutdown drops and err-disables the port'];
      }
      if (psLib.VIOLATIONS.indexOf(mode) === -1) {
        return ['% "' + rest[0] + '" is not a violation mode',
          '% Use protect, restrict or shutdown'];
      }
      if (cur.violation === mode) return ['Violation mode on ' + iface.name + ' is already ' + mode];
      const had = cur.violation;
      cur.violation = mode;
      const what = {
        protect: 'a violating frame is dropped silently - no counter, no log, the port keeps working',
        restrict: 'a violating frame is dropped and counted, and the port keeps working',
        shutdown: 'a violating frame is dropped and the port is err-disabled until "shutdown" then "no shutdown"'
      }[mode];
      return ['Violation mode on ' + iface.name + ' set to ' + mode + (had ? ' (was ' + had + ')' : ''),
        '  ' + what];
    }
    return ['% Unrecognized port-security command: ' + String(args[0]),
      '% Usage: ' + usage];
  }

  // `switchport port-security aging {time <1-1440>|type absolute|inactivity|static}` - the three
  // settings the detail view has been printing since the feature landed, and which had no commands.
  _psAging(args, iface, isNo, st) {
    const usage = 'switchport port-security aging [time <1-1440>|type absolute|inactivity|static]';
    const what = String(args[0] || '').toLowerCase();
    const cur = st || psLib.portState(this.device, iface.name);
    if (!what) {
      return ['% Incomplete command: ' + usage,
        '% time is how long an address lives, type is what the clock counts from, static says whether written addresses age too'];
    }
    if (['time', 'type', 'static'].indexOf(what) === -1) {
      return ['% "' + args[0] + '" is not an aging setting', '% Usage: ' + usage];
    }
    const rest = args.slice(1);
    if (what === 'static') {
      const extra = this._noExtra(rest, 0, (isNo ? 'no ' : '') + 'switchport port-security aging static');
      if (extra) return extra;
      // `no aging static` is the default state, and saying so is more useful than a bare "ok".
      if (isNo) {
        if (!cur.agingStatic) return ['Aging of static addresses is already disabled on ' + iface.name];
        cur.agingStatic = false;
        return ['Aging of static addresses disabled on ' + iface.name,
          '  Configured addresses are kept until "no switchport port-security mac-address" removes them'];
      }
      if (cur.agingStatic) return ['Aging of static addresses is already enabled on ' + iface.name];
      cur.agingStatic = true;
      return ['Aging of static addresses enabled on ' + iface.name,
        '  Configured addresses now age out with everything else - they are no longer permanent'];
    }
    if (what === 'time') {
      if (isNo) {
        const extra = this._noExtra(rest, 0, 'no switchport port-security aging time');
        if (extra) return extra;
        const had = cur.agingTimeMin;
        cur.agingTimeMin = 0;
        return ['Aging time on ' + iface.name + ' reset to 0 - secure addresses no longer age out' +
          (had ? ' (was ' + had + ' min)' : '')];
      }
      const extra = this._noExtra(rest, 1, 'switchport port-security aging time <1-1440>');
      if (extra) return extra;
      const word = String(rest[0] || '');
      if (!word) {
        return ['% Incomplete command: switchport port-security aging time <1-1440>',
          '% The time is in minutes'];
      }
      if (!/^[0-9]+$/.test(word)) return ['% "' + word + '" is not a number of minutes'];
      const n = parseInt(word, 10);
      if (n < 1 || n > 1440) {
        return ['% Aging time ' + n + ' is outside 1-1440 minutes',
          '% 1440 minutes is a day, which is the longest IOS will age a secure address over',
          '% To stop aging entirely: no switchport port-security aging time'];
      }
      if (cur.agingTimeMin === n) return ['Aging time on ' + iface.name + ' is already ' + n + ' min'];
      const had = cur.agingTimeMin;
      cur.agingTimeMin = n;
      return ['Aging time on ' + iface.name + ' set to ' + n + ' min' + (had ? ' (was ' + had + ')' : ''),
        '  An address that has not been ' + (cur.agingType === 'inactivity' ? 'seen' : 'held') +
          ' for ' + n + ' min leaves the port, and the slot is free for the next station'];
    }
    // type
    if (isNo) {
      const extra = this._noExtra(rest, 0, 'no switchport port-security aging type');
      if (extra) return extra;
      const had = cur.agingType;
      if (had === 'absolute') return ['Aging type on ' + iface.name + ' is already absolute'];
      cur.agingType = 'absolute';
      return ['Aging type on ' + iface.name + ' reset to absolute (was ' + had + ')'];
    }
    const extra = this._noExtra(rest, 1, 'switchport port-security aging type absolute|inactivity');
    if (extra) return extra;
    const mode = String(rest[0] || '').toLowerCase();
    if (!mode) {
      return ['% Incomplete command: switchport port-security aging type absolute|inactivity',
        '% absolute counts from the first time the address was seen, inactivity from the last'];
    }
    if (['absolute', 'inactivity'].indexOf(mode) === -1) {
      return ['% "' + rest[0] + '" is not an aging type', '% Use absolute or inactivity'];
    }
    if (cur.agingType === mode) return ['Aging type on ' + iface.name + ' is already ' + mode];
    const had = cur.agingType;
    cur.agingType = mode;
    return ['Aging type on ' + iface.name + ' set to ' + mode + (had ? ' (was ' + had + ')' : ''),
      '  ' + (mode === 'absolute'
        ? 'the clock starts when an address is learned and is not reset by traffic'
        : 'the clock resets every time the address is seen, so a quiet station ages out')];
  }

  // One station is on one port: find the other secured port holding this address, if any.
  _securedMacElsewhere(mac, portName) {
    const table = this.device.portSecurity;
    if (!table || !table.ports) return null;
    for (const name of Object.keys(table.ports)) {
      if (name === portName) continue;
      const st = table.ports[name];
      if (st.configured.indexOf(mac) !== -1 || st.stickyMacs.indexOf(mac) !== -1) return name;
    }
    return null;
  }

  // `arp <ip> <mac> [arpa]` / `no arp <ip>`: a hand-written entry in the cache.
  //
  // The cache is real - it is what `_sendL3` reads before it decides whether to ask - and every entry
  // in it could only ever be learned. A static entry is the one thing an operator writes into it, and
  // it is the entry that must not be relearned: that is what makes it a defence as well as a shortcut.
  _staticArp(args, isNo) {
    const dev = this.device;
    const usage = isNo ? 'no arp <ip>' : 'arp <ip> <mac> [arpa]';
    if (isNo) {
      const extra = this._noExtra(args, 1, usage);
      if (extra) return extra;
      const ip = String(args[0] || '').trim();
      if (!ip) return ['% Incomplete command: ' + usage, '% The address whose entry to remove'];
      if (!net.isIp(ip)) return ['% "' + ip + '" is not an IPv4 address', '% Usage: ' + usage];
      const hadStatic = dev.arpStatic.get(ip);
      const hadLearned = dev.arp.get(ip);
      if (!hadStatic && !hadLearned) {
        return ['% No ARP entry for ' + ip + ' on ' + (dev.name || dev.id),
          '% The cache holds ' + plural(dev.arp.size + dev.arpStatic.size, 'address', 'addresses')];
      }
      dev.arpStatic.delete(ip);
      dev.arp.delete(ip);
      return ['ARP entry for ' + ip + ' removed from ' + (dev.name || dev.id) +
        (hadStatic ? ' (it was static: ' + hadStatic + ')' : '') +
        (hadLearned ? ' (it was learned: ' + hadLearned + ')' : ''),
        '  The next packet to ' + ip + ' asks for it again'];
    }
    // The third word is optional and is always `arpa` (the encapsulation, and the only one ARP has);
    // anything else there is still refused, but the optional word must not be read as an extra one.
    if (args[2] !== undefined && String(args[2]).toLowerCase() !== 'arpa') {
      return ['% Unexpected argument "' + args[2] + '" - arp <ip> <mac> [arpa]',
        '% The only word that can follow the MAC is "arpa" (the encapsulation)'];
    }
    const extra = this._noExtra(args, 3, usage);
    if (extra) return extra;
    const ip = String(args[0] || '').trim();
    const macText = String(args[1] || '').trim().toLowerCase();
    if (!ip) return ['% Incomplete command: ' + usage,
      '% arp <ip> <mac> pins the MAC used for one address'];
    if (!macText) return ['% Incomplete command: arp <ip> <mac> [arpa]',
      '% The MAC is required: a static entry is an address and the MAC it must reach'];
    if (!net.isIp(ip)) return ['% "' + ip + '" is not an IPv4 address', '% Usage: ' + usage];
    // Both spellings a MAC is written in - `0011.2233.4455` (Cisco) and `00:11:22:33:44:55` - are
    // accepted and stored in the one form the tables print.
    const mac = this._parseMac(macText);
    if (!mac) {
      return ['% "' + String(args[1]) + '" is not a MAC address',
        '% Write it as 0011.2233.4455 or 00:11:22:33:44:55'];
    }
    if (/^00:00:00:00:00:00$/.test(mac)) {
      return ['% The all-zero MAC is not an address anything can be reached at'];
    }
    if (parseInt(mac.slice(0, 2), 16) & 1) {
      return ['% ' + mac + ' is a multicast or broadcast MAC, so no single host owns it',
        '% A static ARP entry points at one device: use its unicast address'];
    }
    if (ip === '0.0.0.0' || ip === '255.255.255.255') {
      return ['% ' + ip + ' is not a host address, so no entry can point at a device'];
    }
    const existing = dev.arpStatic.get(ip);
    if (existing === mac) {
      return ['Static ARP entry for ' + ip + ' is already ' + mac + ' on ' + (dev.name || dev.id)];
    }
    dev.arpStatic.set(ip, mac);
    // A learned entry for the same address is now unreachable - the static one wins - so it is
    // dropped rather than left in the table to contradict the entry that replaced it.
    const learned = dev.arp.get(ip);
    if (learned) dev.arp.delete(ip);
    const out = ['Static ARP entry on ' + (dev.name || dev.id) + ': ' + ip + ' is at ' + mac +
      (existing ? ' (was ' + existing + ')' : ''),
      '  This entry never ages out and a reply cannot overwrite it - "no arp ' + ip + '" removes it'];
    if (learned) out.push('  The learned entry for ' + ip + ' (' + learned + ') was dropped: the static one wins');
    return out;
  }

  // Name resolution: whether this device asks, and what suffix an unqualified name gets.
  //
  // Both knobs change what `ping <name>` does, and neither existed - resolution was always on, and a
  // name was always asked exactly as typed. A lab about DNS is mostly about those two facts.
  _ipDomainLookup(on, rest) {
    const dev = this.device;
    const usage = on ? 'ip domain-lookup' : 'no ip domain-lookup';
    const extra = this._noExtra(rest, 0, usage);
    if (extra) return extra;
    const enabled = dev.config.domainLookup !== false;
    if (on) {
      if (enabled) return ['Name lookup is already enabled on ' + (dev.name || dev.id)];
      dev.config.domainLookup = true;
      return ['Name lookup enabled on ' + (dev.name || dev.id) +
        ': ping and traceroute resolve a name through the zones here, then the lab\'s resolvers'];
    }
    if (!enabled) return ['Name lookup is already disabled on ' + (dev.name || dev.id), '% Usage: ip domain-lookup'];
    dev.config.domainLookup = false;
    return ['Name lookup disabled on ' + (dev.name || dev.id) +
      ': a name is refused instead of resolved, and an address still works',
      '  "ip domain-lookup" puts it back'];
  }

  _ipDomainName(args, isNo) {
    const dev = this.device;
    const usage = isNo ? 'no ip domain-name [<name>]' : 'ip domain-name <name>';
    // The positive form takes the name, so the removal accepts it too: typing back the words you
    // configured with is how IOS removals are spoken, and refusing `no ip domain-name lab.local`
    // made the operator go and look up a shorter spelling of what was on their screen.
    const extra = this._noExtra(args, 1, usage);
    if (extra) return extra;
    if (isNo) {
      if (!dev.config.domainName) {
        // A word here names the domain being removed; with none configured it names nothing, and
        // answering only about the state left the word unread.
        const said = String((args || [])[0] || '').trim();
        if (said) {
          return ['% "' + said + '" is not a domain name on ' + (dev.name || dev.id) +
            ' - there is none configured to remove',
            '% "no ip domain-name" on its own reports the same thing; "ip domain-name <name>" sets one'];
        }
        return ['No domain name is set on ' + (dev.name || dev.id) + ' - unqualified names are asked as typed'];
      }
      const named = String(args[0] || '').trim().toLowerCase();
      if (named && named !== String(dev.config.domainName).toLowerCase()) {
        return ['% "' + args[0] + '" is not the domain name on ' + (dev.name || dev.id) +
          ' - it is "' + dev.config.domainName + '"',
          '% "no ip domain-name" alone clears whatever is set'];
      }
      const had = dev.config.domainName;
      dev.config.domainName = null;
      return ['Domain name cleared on ' + (dev.name || dev.id) + ' (was ' + had + ')',
        '  An unqualified name is now asked exactly as typed'];
    }
    const name = String(args[0] || '').trim().toLowerCase();
    if (!name) return ['% Incomplete command: ' + usage,
      '% An unqualified name gets this suffix before it is looked up'];
    // One rule for a DNS name: dotted labels of letters, digits and hyphens, no leading or trailing
    // hyphen, nothing over 253 characters. A suffix that cannot be a name would silently turn every
    // `ping www` into a lookup that cannot succeed.
    const bad = (function (n) {
      if (n.length > 253) return 'it is longer than 253 characters';
      const labels = n.split('.');
      if (labels.some(function (l) { return !l.length; })) return 'it has an empty label (a doubled or trailing dot)';
      for (const l of labels) {
        if (!/^[a-z0-9-]+$/.test(l)) return 'the label "' + l + '" has a character a name cannot carry';
        if (/^-|-$/.test(l)) return 'the label "' + l + '" starts or ends with a hyphen';
        if (l.length > 63) return 'the label "' + l + '" is longer than 63 characters';
      }
      return null;
    })(name);
    if (bad) return ['% "' + String(args[0]) + '" is not a domain name: ' + bad,
      '% Usage: ' + usage];
    if (dev.config.domainName === name) {
      return ['Domain name on ' + (dev.name || dev.id) + ' is already ' + name];
    }
    const had = dev.config.domainName;
    dev.config.domainName = name;
    return ['Domain name on ' + (dev.name || dev.id) + ' set to ' + name + (had ? ' (was ' + had + ')' : ''),
      '  An unqualified name is now asked as name.' + name + ' first'];
  }

  // `lldp run` / `no lldp run`: whether this device speaks LLDP at all.
  //
  // Turning it off is the whole point of the command: a lab in which discovery must not work (a
  // security exercise, a device that should not be found) had no way to be built, and a neighbour
  // table could only ever fill.
  _lldpRun(isNo, rest) {
    const dev = this.device;
    const usage = (isNo ? 'no ' : '') + 'lldp run';
    const extra = this._noExtra(rest, 0, usage);
    if (extra) return extra;
    if (!dev.lldp) {
      return ['% ' + (dev.name || dev.id) + ' has no LLDP stack',
        '% LLDP is a switch/router feature in this model; a plain host does not speak it'];
    }
    if (!dev.config.lldp) dev.config.lldp = { run: true };
    const running = dev.config.lldp.run !== false;
    if (isNo) {
      if (!running) return ['LLDP is already disabled on ' + (dev.name || dev.id), '% Usage: lldp run'];
      dev.config.lldp.run = false;
      const had = dev.lldp.size;
      dev.lldp.clear();
      return ['LLDP disabled on ' + (dev.name || dev.id) + ': no port announces and none listens',
        had ? '  ' + plural(had, 'neighbour') + ' forgotten; peers keep their entries until they stop listening'
          : '  No neighbour had been learned, so nothing was forgotten',
        '  "lldp run" turns it back on; "no lldp transmit|receive" does it for one port'];
    }
    if (running) return ['LLDP is already enabled on ' + (dev.name || dev.id)];
    dev.config.lldp.run = true;
    return ['LLDP enabled on ' + (dev.name || dev.id) + ': every cabled port announces and listens',
      '  Run a simulation ("show lldp neighbors") to hear and be heard again'];
  }

  // LLDP per port: whether this port speaks, and whether it listens.
  //
  // The neighbour table is filled from LLDPDUs that really crossed the link, which is what makes it
  // trustworthy - and it could only ever grow. There was no way to stop a device announcing, so the
  // only way to empty a neighbour table was to unplug the cable, and an operator building a lab in
  // which discovery must not work (the usual reason to care) had no command at all.
  _portLldp(isNo, dir, iface, rest) {
    const usage = (isNo ? 'no ' : '') + 'lldp ' + dir;
    const extra = this._noExtra(rest || [], 0, usage);
    if (extra) return extra;
    const flag = dir === 'transmit' ? 'lldpTx' : 'lldpRx';
    const on = dir === 'transmit' ? 'announcing itself' : 'listening';
    if (isNo) {
      if (iface[flag] === false) {
        return ['LLDP ' + dir + ' on ' + iface.name + ' is already off - the port is not ' + on];
      }
      iface[flag] = false;
      const out = ['LLDP ' + dir + ' off on ' + iface.name + ': the port is no longer ' + on];
      if (dir === 'receive') {
        // A port told to stop listening must not keep what it heard: with no ageing in this model,
        // an entry left behind would be a neighbour the port refused to hear.
        if (this.device.lldp && this.device.lldp.has(iface.name)) {
          const nb = this.device.lldp.get(iface.name);
          this.device.lldp.delete(iface.name);
          out.push('  The neighbour learned earlier on this port (' + (nb.systemName || nb.name || 'a peer') +
            ') is dropped: this port no longer listens.');
        }
      } else {
        out.push('  Peers will stop seeing ' + (this.device.name || this.device.id) +
          ' on this port once their entry ages out - this model keeps no timers, so it stays');
        out.push('  until they are told to stop listening or the link changes.');
      }
      return out;
    }
    if (iface[flag] !== false) {
      return ['LLDP ' + dir + ' on ' + iface.name + ' is already on - the port is ' + on];
    }
    iface[flag] = true;
    return ['LLDP ' + dir + ' on ' + iface.name + ' re-enabled: the port is ' + on + ' again',
      '  Run a simulation ("show lldp neighbors") to hear or be heard.'];
  }

  // Power inline: whether this port will feed a powered device.
  //
  // The PSE side of PoE was fully computed - a budget, an allocation per port, a PD marked
  // `poeUnpowered`, frames refused with `poe-deny` - and the console could not refuse a port: the
  // only way power was withheld was a budget the operator could not see running out. `power inline
  // never` is how a real operator frees budget for a camera, and it did not exist.
  _portPowerInline(args, iface, isNo) {
    const usage = isNo ? 'no power inline' : 'power inline <auto|never>';
    const dev = this.device;
    // The first word is the value, so only the words after it can be extra.
    const extra = this._noExtra(args, 1, usage);
    if (extra) return extra;
    if (isNo && args.length) {
      return ['% no power inline takes no word - it returns the port to auto',
        '% Usage: no power inline'];
    }
    // A port that cannot source power has nothing to be told; the refusal names the reason.
    if (!iface.poeOut) {
      const sourcing = Array.from(dev.interfaces.values()).filter(function (i) { return i.poeOut; });
      if (!sourcing.length) {
        // When the catalogue claims PoE and the ports do not carry it, the answer is the same
        // reason the show gives: a gap in the specification, not a state of the device.
        const claim = this._poeClaimWithoutPorts();
        if (claim) {
          return ['% ' + (dev.name || dev.id) + ' declares ' + claim + ' in its catalogue entry,',
            '% but no port record on it carries power-out - so ' + iface.name + ' has nothing to switch',
            '% That is a gap in the device specification, not something this console can configure'];
        }
        return ['% ' + (dev.name || dev.id) + ' does not source PoE, so ' + iface.name +
          ' has no power to give',
          '% PoE-out ports appear in "show power inline" on the devices that have them'];
      }
      return ['% ' + iface.name + ' is not a PoE-out port on ' + (dev.name || dev.id),
        '% The ports that can source power are: ' +
        sourcing.slice(0, 8).map(function (i) { return i.name; }).join(', ') +
        (sourcing.length > 8 ? ', ...' : '')];
    }
    const current = iface.poeAdmin || 'auto';
    const want = isNo ? 'auto' : String(args[0] || '').toLowerCase();
    if (!isNo && !want) return ['% Incomplete command: ' + usage,
      '% "power inline never" withholds power from this port; "auto" feeds a detected device'];
    if (want === 'static') {
      return ['% "power inline static" (pre-allocated power) is not modelled',
        '% This PSE grants power when a device is detected and refuses it when the budget runs out;',
        '% pre-allocation would reserve budget for a port that may never use it, which changes',
        '% nothing this simulator measures. Use "power inline never" to withhold, or "auto".'];
    }
    if (want !== 'auto' && want !== 'never') {
      return ['% Power inline is auto or never, not "' + want + '"',
        '% Usage: ' + usage];
    }
    if (want === 'auto') {
      if (current === 'auto') {
        return ['Power inline on ' + iface.name + ' is already auto (power is granted to a detected device)'];
      }
      iface.poeAdmin = 'auto';
      return ['Power inline on ' + iface.name + ' is auto: a detected device will be powered',
        '  (whether it gets the watts still depends on the port budget - see "show power inline")'];
    }
    // never
    if (current === 'never') {
      return ['Power inline on ' + iface.name + ' is already never - no device is being fed'];
    }
    iface.poeAdmin = 'never';
    const out = ['Power inline on ' + iface.name + ' set to never (was ' + current + ')',
      '  No device on this port will be powered, and its watts are freed for other ports.'];
    const peer = iface.peer;
    if (peer) {
      const pd = this.sim && this.sim.topo.getDevice(peer.deviceId);
      if (pd) out.push('  ' + (pd.name || pd.id) + ' is on this port and will lose power on the next run');
    }
    return out;
  }

  // ---------- per-port physical settings ----------
  //
  // `mtu`, `speed` and `duplex` are what an operator reaches for first when a link misbehaves, and
  // none of them existed: `mtu 1400` answered `% Unrecognized interface command: mtu 1400` on a
  // router port *and* on a switch port, while the model already carried `iface.mtu`, `iface.speed`
  // and `iface.duplex` and already used the MTU (path MTU) and the speed (STP path cost).
  //
  // Each one is stored where the model reads it, so a command that changes nothing is not offered.

  // MTU: the largest frame this port will put on the wire, and the number flows derive their MSS
  // from. `pathMtu()` takes the minimum over the path's egress ports, so this is observable.
  _portMtu(args, iface, isNo) {
    const usage = 'mtu <68-9216>';
    const port = iface.name;
    if (isNo) {
      if (args.length) return ['% Unexpected argument "' + args[0] + '" - no mtu takes no more'];
      const was = iface.mtu;
      iface.mtu = 1500;
      iface.mtuConfigured = false;
      return [was === 1500
        ? 'MTU on ' + port + ' is already the default 1500'
        : 'MTU on ' + port + ' back to 1500 (was ' + was + ')'];
    }
    if (!args.length) {
      return ['% Incomplete command: ' + usage,
        '% This port\'s MTU is ' + iface.mtu + '; "no mtu" restores 1500'];
    }
    const word = String(args[0]);
    if (!/^\d+$/.test(word)) {
      return ['% MTU must be a number of bytes, not "' + word + '"', '% Usage: ' + usage];
    }
    const extra = this._noExtra(args, 1, usage);
    if (extra) return extra;
    const n = parseInt(word, 10);
    if (n < 68) {
      return ['% MTU ' + n + ' is below the smallest IPv4 datagram (68 bytes)',
        '% Usage: ' + usage];
    }
    if (n > 9216) {
      return ['% MTU ' + n + ' is above this model\'s largest frame (9216 bytes)',
        '% Usage: ' + usage + ' (jumbo frames are allowed up to 9216 here)'];
    }
    if (n === iface.mtu) return ['MTU on ' + port + ' is already ' + n];
    const was = iface.mtu;
    iface.mtu = n;
    iface.mtuConfigured = true;
    const out = ['MTU on ' + port + ' set to ' + n + (was ? ' (was ' + was + ')' : '')];
    if (n < 1500) out.push('  Frames larger than ' + n + ' bytes on this port will be dropped, and flows');
    if (n < 1500) out.push('  routed through it derive their MSS from ' + n + ' (see "show flow <id>")');
    if (n > 1500) out.push('  Jumbo frames are accepted here; a path is only as large as its smallest MTU');
    return out;
  }

  // A logical interface has no wire, so the verbs that describe a wire have nothing to describe.
  // `switchport` and `port-security` already refused an SVI by name; `speed`, `duplex` and
  // `channel-group` had never been asked the question, and answered anyway:
  //
  //   SW1(config-if)#speed 1000     Speed on Vlan20 set to 1G (was virtual)
  //   SW1(config-if)#duplex full    Duplex on Vlan20 set to full (was full (default))
  //   SW1(config-if)#channel-group 1 mode active
  //   Interface Vlan20 added to channel group 1 (LACP active)
  //
  // The first two even printed the model's own placeholder ("virtual") and an unanswered lookup
  // ("was ?") as if they were speeds and states. One sentence, used by all three, so they cannot
  // drift apart the way `switchport` and `show etherchannel` once did.
  _logicalPortRefusal(iface, what, remedy) {
    if (!iface || !(iface.svi || iface.parent)) return null;
    return ['% ' + iface.name + ' is a logical interface - ' + what,
      '% ' + remedy];
  }

  // Speed: what this port is running at. `speedToCost()` turns it into a spanning-tree path cost, so
  // the effect of setting it is visible in `show spanning-tree` rather than only in this message.
  _portSpeed(args, iface, isNo) {
    const usage = 'speed <10-100000>';
    const port = iface.name;
    const logical = this._logicalPortRefusal(iface, 'nothing is transmitted at a rate here',
      'Speed is a property of the wire: an SVI is the address its VLAN answers on, ' +
      'so set the speed on the member ports ("show interfaces <port>")');
    if (logical) return logical;
    const caps = (iface.hardware && iface.hardware.speedCaps) || null;
    if (isNo) {
      if (args.length) return ['% Unexpected argument "' + args[0] + '" - no speed takes no more'];
      if (!iface.speedConfigured) return ['Speed on ' + port + ' is already negotiated (not configured)'];
      const was = iface.speed;
      iface.speed = iface.speedNegotiated || was;
      iface.speedMbps = iface.speedNegotiatedMbps || iface.speedMbps;
      iface.speedConfigured = false;
      return ['Speed on ' + port + ' back to negotiation (was ' + was + ')'];
    }
    if (!args.length) {
      return ['% Incomplete command: ' + usage,
        '% This port is at ' + iface.speed + (caps ? '; it supports ' + caps.join(', ') + ' Mbps' : '')];
    }
    const word = String(args[0]).toLowerCase();
    const extra = this._noExtra(args, 1, usage);
    if (extra) return extra;
    if (word === 'auto') {
      if (!iface.speedConfigured) return ['Speed on ' + port + ' is already negotiating'];
      const was = iface.speed;
      iface.speed = iface.speedNegotiated || was;
      iface.speedMbps = iface.speedNegotiatedMbps || iface.speedMbps;
      iface.speedConfigured = false;
      return ['Speed on ' + port + ' set to auto (was ' + was + ')'];
    }
    if (!/^\d+$/.test(word)) {
      return ['% Speed must be a number of Mbps or "auto", not "' + word + '"', '% Usage: ' + usage];
    }
    const mbps = parseInt(word, 10);
    if (caps && caps.indexOf(mbps) === -1) {
      // The usage line named the model-wide range while the refusal named this port's speeds, so the
      // second line invited a number the first line had just refused.
      return ['% ' + port + ' cannot run at ' + mbps + ' Mbps - it supports ' + caps.join(', ') + ' Mbps',
        '% Usage: speed ' + caps.join('|') + '   (the speeds this port has)'];
    }
    if (!caps && !(mbps >= 10 && mbps <= 100000)) {
      return ['% Speed ' + mbps + ' is outside 10-100000 Mbps', '% Usage: ' + usage];
    }
    const stpLib = require('./stp');
    const sim = require('./simulator');
    const cost = (sim.speedToCost ? sim.speedToCost(mbps) : null) ||
      (stpLib.pathCost ? stpLib.pathCost(mbps) : null);
    if (iface.speedConfigured && iface.speedMbps === mbps) {
      return ['Speed on ' + port + ' is already ' + mbps + ' Mbps'];
    }
    // A speed equal to what the port already runs at is the port's own default, not configuration:
    // `speed 1000` on a 1 Gbps port was stored and dumped, so a saved copy grew a line nobody had
    // changed anything by - the same rule the priority and preempt lines follow.
    if (!iface.speedConfigured) {
      const currentMbps = iface.speedMbps || (function (label) {
        const m = /^(\d+)\s*([GgMm])/.exec(String(label || ''));
        if (!m) return null;
        return parseInt(m[1], 10) * (m[2].toLowerCase() === 'g' ? 1000 : 1);
      })(iface.speed);
      if (currentMbps === mbps) {
        return ['Speed on ' + port + ' is already ' + mbps + ' Mbps - that is the port\'s own speed, ' +
          'so nothing is configured'];
      }
    }
    if (!iface.speedNegotiated) {
      iface.speedNegotiated = iface.speed;
      iface.speedNegotiatedMbps = iface.speedMbps;
    }
    const was = iface.speed;
    // The cost that is being replaced. A port that has never been configured keeps its speed in the
    // display string alone (`iface.speed = '1G'`), so reading only `speedMbps` printed no "(was …)" at
    // all on the first change - the one place the reader most wants the before and after.
    const wasMbps = iface.speedMbps || (function (label) {
      const m = /^(\d+)\s*([GgMm])/.exec(String(label || ''));
      if (!m) return null;
      return parseInt(m[1], 10) * (m[2].toLowerCase() === 'g' ? 1000 : 1);
    })(was);
    iface.speedMbps = mbps;
    // `iface.speed` is the display string the rest of the model prints (`1G`, `100M`).
    iface.speed = mbps >= 1000 ? (mbps % 1000 === 0 ? (mbps / 1000) + 'G' : mbps + 'M') : mbps + 'M';
    iface.speedConfigured = true;
    const out = ['Speed on ' + port + ' set to ' + iface.speed + ' (was ' + was + ')'];
    // `(was ?)` was printed whenever the port had not negotiated a speed: the old cost was read from
    // the *negotiated* figure only, and a port configured from the start never has one. The cost that
    // is being replaced is the one the port was already using.
    if (cost) {
      const oldCost = (sim.speedToCost && (wasMbps || iface.speedNegotiatedMbps))
        ? sim.speedToCost(wasMbps || iface.speedNegotiatedMbps) : null;
      out.push('  Spanning-tree path cost from this port is now ' + cost +
        (oldCost === null ? '' : ' (was ' + oldCost + ')'));
    }
    return out;
  }

  // Duplex: stored and printed, and `half` refused by naming what the model cannot honour. A
  // half-duplex link's behaviour is collisions, backoff and a shared medium - none of which this
  // model simulates - so accepting the word would be a promise it cannot keep.
  _portDuplex(args, iface, isNo) {
    const usage = 'duplex full|auto';
    const port = iface.name;
    const logical = this._logicalPortRefusal(iface, 'it has no duplex',
      'Duplex is a property of the wire: an SVI is the address its VLAN answers on');
    if (logical) return logical;
    if (isNo) {
      if (args.length) return ['% Unexpected argument "' + args[0] + '" - no duplex takes no more'];
      if (!iface.duplexConfigured) {
        return ['Duplex on ' + port + ' is already ' + (iface.duplex || 'auto') + ' (nothing was configured)'];
      }
      const was = iface.duplex;
      iface.duplex = iface.duplexDefault || 'full';
      iface.duplexConfigured = false;
      return ['Duplex on ' + port + ' back to ' + iface.duplex + ' (was ' + was + ')'];
    }
    if (!args.length) {
      return ['% Incomplete command: ' + usage,
        '% This port is ' + (iface.duplex || 'auto')];
    }
    const word = String(args[0]).toLowerCase();
    const extra = this._noExtra(args, 1, usage);
    if (extra) return extra;
    if (word === 'half') {
      return ['% Half duplex is not modelled: this simulator has no collision domain, no backoff and',
        '% no shared medium, so a "half" port would behave exactly like a full one while claiming',
        '% otherwise. Use "duplex full", or leave it at "auto".'];
    }
    if (word !== 'full' && word !== 'auto') {
      return ['% Duplex is full or auto, not "' + word + '"', '% Usage: ' + usage];
    }
    if (iface.duplexConfigured && iface.duplex === word) {
      return ['Duplex on ' + port + ' is already ' + word];
    }
    if (!iface.duplexConfigured) iface.duplexDefault = iface.duplex || 'full';
    const was = iface.duplexConfigured ? iface.duplex : (iface.duplexDefault || 'full') + ' (default)';
    iface.duplex = word;
    iface.duplexConfigured = true;
    return ['Duplex on ' + port + ' set to ' + word + ' (was ' + was + ')'];
  }

  // ---------- NAT ----------
  //
  // `engine/nat.js` has modelled NAT end to end all along - rules, translations, timeouts, outbound
  // and inbound rewriting - and the console could not create a single rule:
  //   R1(config)#ip nat inside source static 192.168.1.10 203.0.113.10
  //   % Unrecognized config command: ...
  //   R1#show ip nat statistics
  //   (no rules - NAT is configured from the topology, not this CLI)
  // A model whose whole purpose is being driven from a console was telling the operator to go and
  // edit the topology instead.

  // Which side of the box a port is on. Stored on the interface, dumped with it, and enforced by
  // the data path as soon as any port on the device declares one.
  _ipNatIface(tokens, iface) {
    const dev = this.device;
    const usage = 'ip nat inside|outside';
    if (!dev.isL3 || !dev.isL3()) {
      return ['% ' + (dev.name || dev.id) + ' does not route - NAT rewrites addresses between two',
        '% routed interfaces, and this device has none'];
    }
    // Routing is not translating. An L3 switch routes between its VLANs and passed the test above, yet
    // its catalogue says it translates nothing - and it took the role anyway, then reported itself as a
    // NAT interface in a lab where no packet could ever be rewritten.
    if (typeof dev.hasCap === 'function' && !dev.hasCap('nat')) {
      return ['% ' + (dev.name || dev.id) + ' does not translate addresses, so no port on it can be',
        '% a NAT inside or outside interface - it routes, but it rewrites nothing'];
    }
    const t = tokens.map(function (x) { return String(x).toLowerCase(); });
    if (!t.length) return ['% Incomplete command: ' + usage];
    const side = t[0];
    if (side !== 'inside' && side !== 'outside') {
      return ['% A NAT interface is inside or outside, not "' + tokens[0] + '"', '% Usage: ' + usage];
    }
    if (t.length > 1) {
      return ['% Unexpected argument "' + tokens[1] + '" - ' + usage + ' takes no more',
        '% A port cannot be on both sides: pick one.'];
    }
    if (iface.natRole === side) {
      return ['Interface ' + iface.name + ' is already NAT ' + side];
    }
    const was = iface.natRole;
    iface.natRole = side;
    const out = ['Interface ' + iface.name + ' is NAT ' + side];
    if (was) out.push('  was ' + was + ' - a port is on one side at a time');
    // The rules only work if both sides exist, and the operator is told which one is missing
    // rather than being left to discover it from a packet that is not translated.
    const sides = Array.from(dev.interfaces.values()).filter(function (i) { return i.natRole; })
      .map(function (i) { return i.natRole; });
    if (sides.indexOf('inside') === -1) out.push('  (no port is inside yet - translation waits for one)');
    if (sides.indexOf('outside') === -1) out.push('  (no port is outside yet - translation waits for one)');
    return out;
  }

  // `ip nat inside source static <local> <global>` and
  // `ip nat inside source list <acl> interface <if> overload`.
  _ipNatConfig(tokens) {
    const natLib = require('./nat');
    const dev = this.device;
    const out = [];
    const usage = 'ip nat inside source static <local> <global> | list <acl> interface <if> overload';
    const t = tokens.map(function (x) { return String(x).toLowerCase(); });
    if (!t.length) return ['% Incomplete command: ' + usage];
    if (t[0] !== 'inside') {
      return ['% This model translates inside source addresses ("ip nat inside source …"),',
        '% not "' + tokens[0] + '"'];
    }
    if (t[1] !== 'source') {
      return ['% Incomplete command: ip nat inside source static <local> <global>',
        '%                                   or: ip nat inside source list <acl> interface <if> overload'];
    }
    const form = t[2];
    if (form === undefined) {
      return ['% Incomplete command: ip nat inside source static <local> <global>',
        '%                   or: ip nat inside source list <acl> interface <if> overload'];
    }

    let rule = null;
    if (form === 'static') {
      const local = tokens[3];
      const global = tokens[4];
      if (local === undefined || global === undefined) {
        return ['% Incomplete command: ip nat inside source static <local> <global>'];
      }
      const extra = this._noExtra(t, 5, 'ip nat inside source static <local> <global>');
      if (extra) return extra;
      rule = { type: 'static', insideLocal: local, insideGlobal: global };
    } else if (form === 'list') {
      const aclId = tokens[3];
      if (aclId === undefined) return ['% Incomplete command: ip nat inside source list <acl> interface <if> overload'];
      const acls = dev.config.acls || {};
      const list = acls[String(aclId)];
      if (!list) {
        return ['% Access list ' + aclId + ' does not exist - the NAT list says which addresses',
          '% are translated, so it has to be built first',
          '% Configured lists: ' + (Object.keys(acls).join(', ') || '(none)')];
      }
      if (t[4] !== 'interface') {
        return ['% This model translates onto an interface address: "… interface <if> overload"',
          '% Got: "' + (tokens[4] === undefined ? '' : tokens[4]) + '"'];
      }
      const ifName = tokens[5];
      if (ifName === undefined) return ['% Incomplete command: ip nat inside source list <acl> interface <if> overload'];
      const iface = dev.resolveIface(ifName);
      if (!iface) {
        return ['% No interface ' + ifName + ' on ' + (dev.name || dev.id),
          '% Ports here: ' + Array.from(dev.interfaces.values()).map(function (i) { return i.name; }).join(', ')];
      }
      if (!iface.ip) {
        return ['% ' + iface.name + ' has no address - "overload" translates onto that address,',
          '% so it needs one before the rule can be written'];
      }
      const tail = t[6];
      if (tail !== 'overload') {
        return ['% Incomplete command: … interface ' + iface.name + ' overload',
          '% (a list-and-interface rule without "overload" would need a pool, which this model does not have)'];
      }
      if (t.length > 7) {
        return ['% Unexpected argument "' + tokens[7] + '" - the rule ends at "overload"'];
      }
      // The ACL's permitted sources become the addresses this rule translates. The library takes
      // specs (`10.0.0.0/24`, `10.0.0.5`, `a-b`), so a wildcard is turned into a prefix length -
      // an operator who wrote `permit 10.0.0.0 0.0.0.255` gets a rule that means that subnet.
      const specs = [];
      for (const e of list) {
        if (String(e.action).toLowerCase() !== 'permit') continue;
        const src = e.source || {};
        if (src.any) { specs.length = 0; specs.push('any'); break; }
        if (src.host) { specs.push(String(src.ip)); continue; }
        if (!src.ip) continue;
        const wild = String(src.wildcard || '0.0.0.0');
        const parts = wild.split('.').map(function (x) { return 255 - (Number(x) || 0); });
        const mask = parts.join('.');
        const dotted = mask === '255.255.255.255' ? String(src.ip) : (src.ip + '/' + mask);
        specs.push(dotted);
      }
      // The port the rule overloads onto is the *outside* one; a rule pointing at the inside port
      // would translate onto the address the traffic is coming from, which is not what an operator
      // means and is not something a later packet would reveal.
      if (iface.natRole === 'inside') {
        return ['% ' + iface.name + ' is the inside port - "overload" translates onto the outside',
          '% address, so name the port facing the provider (or mark it with "ip nat outside")'];
      }
      rule = {
        type: 'pat',
        insideLocal: 'any',
        insideGlobal: iface.ip,
        acl: specs.length ? specs : null,
        // Kept so the dump and every description can print the line the operator typed rather than
        // a compiled specification of it.
        fromList: String(tokens[3]),
        fromIface: iface.name
      };
    } else {
      return ['% ip nat inside source takes static or list, not "' + tokens[2] + '"', '% Usage: ' + usage];
    }

    const chk = natLib.validateRule(rule);
    if (chk && chk.ok === false) {
      // The library's sentence, not the shape of the error object.
      const first = (chk.errors || [])[0];
      return ['% ' + ((first && (first.message || first.code)) || 'invalid NAT rule')];
    }

    if (!dev.config.nat) dev.config.nat = { rules: [] };
    if (!Array.isArray(dev.config.nat.rules)) dev.config.nat.rules = [];
    const same = function (a, b) {
      return String(a.type) === String(b.type) &&
        String(a.insideLocal) === String(b.insideLocal) &&
        String(a.insideGlobal) === String(b.insideGlobal) &&
        String(a.fromList || '') === String(b.fromList || '') &&
        String(a.fromIface || '') === String(b.fromIface || '') &&
        JSON.stringify(a.acl || null) === JSON.stringify(b.acl || null);
    };
    if (dev.config.nat.rules.some(function (r) { return same(r, rule); })) {
      return ['This rule is already configured on ' + (dev.name || dev.id) + ': ' +
        describeNatRule(rule)];
    }
    dev.config.nat.rules.push(rule);
    // The translation table caches its rules on first use, so a rule written after the first packet
    // would never be seen. Dropping the cache is part of writing the rule.
    dev.natTable = null;
    out.push('NAT rule added on ' + (dev.name || dev.id) + ': ' + describeNatRule(rule));
    const roles = Array.from(dev.interfaces.values()).filter(function (i) { return i.natRole; });
    if (!roles.some(function (i) { return i.natRole === 'inside'; }) ||
        !roles.some(function (i) { return i.natRole === 'outside'; })) {
      out.push('  (a rule needs one interface inside and one outside - mark them with "ip nat inside"');
      out.push('   and "ip nat outside", or this rule will match nothing)');
    }
    return out;

    function describeNatRule(r) {
      if (r.type === 'static') return 'static ' + r.insideLocal + ' -> ' + r.insideGlobal;
      const list = r.fromList ? ('list ' + r.fromList) : 'list any';
      return 'pat ' + list + ' -> ' + (r.fromIface || r.insideGlobal) + ' (' + r.insideGlobal + ') overload';
    }
  }

  // `no ip nat inside source static <local> <global>` / `… list <acl> interface <if> overload`
  _noIpNatConfig(tokens) {
    const dev = this.device;
    const rules = (dev.config.nat && dev.config.nat.rules) || [];
    if (!rules.length) return ['% No NAT rules on ' + (dev.name || dev.id)];
    const t = tokens.map(function (x) { return String(x).toLowerCase(); });
    // With no rule named - `no ip nat`, `no ip nat inside`, `no ip nat inside source` - list what
    // is there: the same courtesy every other `no` form gives, and a reminder of the shape.
    const named = !(t.length === 0 ||
      (t.length === 1 && t[0] === 'inside') ||
      (t.length === 2 && t[0] === 'inside' && t[1] === 'source') ||
      t[t.length - 1] === 'source' || t[t.length - 1] === 'static' || t[t.length - 1] === 'list');
    if (!named) {
      return ['% No NAT rule named - the rules on ' + (dev.name || dev.id) + ':']
        .concat(rules.map(function (r, i) { return '  ' + (i + 1) + ') ' + describe(r); }));
    }
    // `no ip nat inside source static …` - the form the operator typed to create the rule, so the
    // words are shifted past the optional `inside` rather than being compared against a compiled
    // shape they never had.
    const body = (t[0] === 'inside') ? tokens.slice(1) : tokens;
    let idx = -1;
    if (body[0] === 'source' && body[1] === 'static' && body[2] !== undefined && body[3] !== undefined) {
      idx = rules.findIndex(function (r) {
        return r.type === 'static' && String(r.insideLocal) === String(body[2]) &&
          String(r.insideGlobal) === String(body[3]);
      });
    } else if (body[0] === 'source' && body[1] === 'list' && body[2] !== undefined) {
      idx = rules.findIndex(function (r) {
        return r.type !== 'static' && String(r.fromList) === String(body[2]) &&
          (body[4] === undefined || String(r.fromIface).toLowerCase() === String(body[4]).toLowerCase());
      });
    }
    if (idx === -1) {
      return ['% No NAT rule matching "' + tokens.join(' ') + '" on ' + (dev.name || dev.id)]
        .concat(rules.map(function (r, i) { return '  ' + (i + 1) + ') ' + describe(r); }));
    }
    const gone = rules.splice(idx, 1)[0];
    dev.natTable = null;
    return ['Removed NAT rule: ' + describe(gone)];

    function describe(r) {
      if (r.type === 'static') return 'ip nat inside source static ' + r.insideLocal + ' ' + r.insideGlobal;
      return 'ip nat inside source list ' + (r.fromList || 'any') + ' interface ' +
        (r.fromIface || r.insideGlobal) + ' overload';
    }
  }

  // ---------- access lists ----------

  // `ip access-list standard|extended <name>` - the named half of the ACL surface. Until this
  // existed an access list could only be built by number, one line per command, with no way to
  // name one; `ip access-list extended BLOCK` was `% Unrecognized config command`.
  //
  // Sequence numbers are the IOS default step of 10 (10, 20, 30 …), which is what makes
  // `no 20` a usable way to remove one line and what `show access-lists` prints.
  _ipAccessList(tokens) {
    const aclLib = require('./acl');
    const dev = this.device;
    const t = tokens.map(function (x) { return String(x).toLowerCase(); });
    const usage = 'ip access-list standard|extended <name>';
    if (!t.length) return ['% Incomplete command: ' + usage];
    const kind = t[0];
    if (kind !== 'standard' && kind !== 'extended') {
      return ['% access lists come in standard or extended, not "' + tokens[0] + '"',
        '% Usage: ' + usage];
    }
    const name = tokens[1];
    if (name === undefined) return ['% Incomplete command: ip access-list ' + kind + ' <name>'];
    const extra = this._noExtra(t, 2, 'ip access-list ' + kind + ' <name>');
    if (extra) return extra;
    // A number in a named ACL is legal on IOS and means the numbered list, but the two live in
    // different namespaces here; saying so is better than creating a second list with the same name.
    if (/^\d+$/.test(name)) {
      const numericKind = aclLib.aclKind(Number(name));
      if (!numericKind) {
        return ['% ' + name + ' is not a valid ACL number (standard 1-99, extended 100-199)'];
      }
      return ['% ' + name + ' is a number, and numbered access lists are built with',
        '%   access-list ' + name + ' <permit|deny> ...',
        '% ip access-list names a list; it does not number one'];
    }
    if (!dev.config.acls) dev.config.acls = {};
    const key = String(name);
    const existing = dev.config.acls[key];
    if (existing && existing.kind && existing.kind !== kind) {
      return ['% Access list ' + name + ' is ' + existing.kind + ', not ' + kind,
        '% Remove it first with: no ip access-list ' + kind + ' ' + name];
    }
    const out = [];
    if (!existing) {
      // Arrays carry the kind and the counters, the way a numbered list does; a named list is the
      // same object with a name, which is what keeps `show access-lists` and the dump one code path.
      const created = [];
      created.kind = kind;
      dev.config.acls[key] = created;
      out.push('Creating ' + kind + ' access list ' + name + ', 1 entry');
    } else {
      out.push(kind.charAt(0).toUpperCase() + kind.slice(1) + ' access list ' + name + ' (' +
        existing.length + ' entr' + (existing.length === 1 ? 'y' : 'ies') + ')');
    }
    this.mode = MODE_ACL;
    this.aclName = key;
    this.aclKindWord = kind === 'extended' ? 'ext' : 'std';
    this._enteredAclBlock = true;
    return out;
  }

  // `no ip access-list standard|extended <name>` - remove a named list whole, and say what it
  // unbinds. A list removed while a port still points at it is how a filter silently stops
  // filtering; the same rule the VLAN removal follows.
  _noIpAccessList(tokens) {
    const dev = this.device;
    const t = tokens.map(function (x) { return String(x).toLowerCase(); });
    const usage = 'no ip access-list standard|extended <name>';
    if (!t.length || t[0] === undefined) return ['% Incomplete command: ' + usage];
    // The kind is optional in the common case: an operator naming a list should not have to
    // remember which half of the syntax made it.
    const nameIndex = (t[0] === 'standard' || t[0] === 'extended') ? 1 : 0;
    const name = tokens[nameIndex];
    if (name === undefined) return ['% Incomplete command: ' + usage];
    const extra = this._noExtra(t, nameIndex + 1, usage);
    if (extra) return extra;
    const key = String(name);
    const list = (dev.config.acls || {})[key];
    if (!list) {
      return ['% No access list ' + name + ' - the lists here: ' +
        (Object.keys(dev.config.acls || {}).join(', ') || '(none)')];
    }
    const bound = [];
    const binds = dev.aclBindings || {};
    for (const k of Object.keys(binds)) {
      if (String(binds[k].in) === key) bound.push(k + ' in');
      if (String(binds[k].out) === key) bound.push(k + ' out');
    }
    delete dev.config.acls[key];
    for (const k of Object.keys(binds)) {
      if (String(binds[k].in) === key) delete binds[k].in;
      if (String(binds[k].out) === key) delete binds[k].out;
    }
    const what = (list.kind === 'standard' ? 'Standard' : 'Extended');
    return [what + ' access list ' + name + ' removed (' + list.length + ' entr' +
      (list.length === 1 ? 'y' : 'ies') + ')' +
      (bound.length ? ', unbound from ' + bound.join(', ') : '')];
  }

  // Inside `ip access-list ...`: one entry per line, `no <seq>` or `no <entry>` to remove one.
  _aclMode(tokens) {
    const aclLib = require('./acl');
    const dev = this.device;
    const key = this.aclName;
    const list = (dev.config.acls || {})[key];
    const head = String(tokens[0] || '').toLowerCase();
    const strayAcl = this._blockStrayWord(tokens, MODE_ACL);
    if (strayAcl) return strayAcl;
    const out = [];
    if (!list) {
      // The list disappeared underneath the session (a `no ip access-list` in another console).
      this.mode = MODE_CONFIG;
      return ['% Access list ' + key + ' no longer exists - back to config'];
    }
    const doShow = this._doShowInMode(tokens);
    if (doShow) return doShow;
    if (head === 'exit') { this.mode = MODE_CONFIG; this.aclName = null; return out; }
    if (head === 'end') { this.mode = this._modeAfterConfig(); this.aclName = null; return out; }
    // `show` works from inside a block, as it does in an interface block: the question "what does the
    // list look like now" is asked while adding to it, not after leaving it.
    if (head === 'show') {
      out.push.apply(out, this._show(tokens.slice(1)));
      return out;
    }
    const kind = list.kind || 'extended';
    if (head === 'no') {
      const rest = tokens.slice(1);
      if (!rest.length) return ['% Incomplete command: no <sequence> | no <permit|deny ...>'];
      const numeric = /^\d+$/.test(String(rest[0]));
      if (numeric && rest.length > 1) {
        return ['% no ' + rest[0] + ' takes a sequence number alone, or the entry without one'];
      }
      let idx = -1;
      if (numeric) {
        idx = list.findIndex(function (e) { return Number(e.sequence) === Number(rest[0]); });
        if (idx === -1) {
          return ['% No entry ' + rest[0] + ' in access list ' + key,
            '% Entries: ' + (list.map(function (e) { return e.sequence; }).join(', ') || '(none)')];
        }
      } else {
        const parsed = aclLib.parseEntry(rest.join(' '), null, kind);
        if (!parsed || parsed.error) {
          const detail = parsed && parsed.error && (parsed.error.message || parsed.error.code);
          return ['% ' + key + ': ' + (detail || 'invalid entry')];
        }
        const wanted = aclLib.entryKey(parsed);
        idx = list.findIndex(function (e) { return aclLib.entryKey(e) === wanted; });
        if (idx === -1) {
          return ['% No entry matching "' + rest.join(' ') + '" in access list ' + key,
            '% See "show access-lists ' + key + '" for the lines that are there'];
        }
      }
      const gone = list[idx];
      list.splice(idx, 1);
      return ['Removed entry ' + gone.sequence + ' (' + (gone.line || gone.action) + ') from ' + key];
    }
    // A line may carry its own sequence number: `10 permit ip any any` is what `show running-config`
    // prints, and a dump that cannot be pasted is not a dump.
    const numbered = /^\d+$/.test(head) && tokens.length > 1;
    if (!numbered && head !== 'permit' && head !== 'deny') {
      // A pasted dump has no `exit` between blocks: the next unindented line ends this one. So any
      // config-mode command typed here is applied globally and leaves the block - unless it is
      // refused, in which case the block is kept, because a refusal must not move the operator.
      // The flag, not the name: re-entering the *same* list (`ip access-list extended BLOCK` typed
      // again) leaves the name unchanged, so comparing names made that look like "no new block".
      this._enteredAclBlock = false;
      const asConfig = this._configMode(tokens);
      if (asConfig.some(function (l) { return /^%/.test(l); })) {
        return ['% Inside an access list, a line starts with permit or deny (or no <sequence>)',
          '% Got: "' + (tokens[0] || '') + '"'].concat(asConfig);
      }
      // `_configMode` sets whatever mode the command implies: an `interface` line goes to the port
      // block, and `ip access-list …` opens another list. Only a command that leaves the session in
      // this block still has to be told that the block no longer owns it - and only when the
      // command did not name a new list of its own (clearing the name it just set is how a pasted
      // dump lost every line after its first `ip access-list`).
      if (!this._enteredAclBlock && this.mode === MODE_ACL) {
        this.aclName = null;
        this.mode = MODE_CONFIG;
      }
      this._enteredAclBlock = false;
      return asConfig;
    }
    const parsed = aclLib.parseEntry(tokens.join(' '), null, kind);
    if (!parsed || parsed.error) {
      const detail = parsed && parsed.error && (parsed.error.message || parsed.error.code);
      // The library judges the words; the console prints the library's sentence and the list it
      // belongs to, so the message names where the mistake is.
      return ['% ' + key + ': ' + (detail || 'invalid entry')];
    }
    // A sequence number typed in the line is kept, which is what makes a pasted dump rebuild the
    // same list order; without one the entry goes on the end at the next step of 10.
    const given = (parsed.sequence === undefined || parsed.sequence === null) ? null : Number(parsed.sequence);
    const last = list.length ? Number(list[list.length - 1].sequence || 0) : 0;
    const seq = given === null ? last + 10 : given;
    parsed.sequence = seq;
    parsed.line = tokens.join(' ').replace(/^\d+\s+/, '');
    // An identical line is not a second entry, on a real box or here: the sequence number is the
    // identity of the entry, and the same rule twice would double its match counter and lengthen
    // every dump a paste touches.
    const identity = aclLib.entryKey(parsed);
    const dup = list.filter(function (e) { return aclLib.entryKey(e) === identity; })[0];
    if (dup) {
      return ['  ' + seq + ' ' + parsed.line + ' is already in ' + key +
        ' at sequence ' + dup.sequence + ' - the list is unchanged'];
    }
    list.push(parsed);
    list.sort(function (a, b) { return Number(a.sequence) - Number(b.sequence); });
    return ['  ' + seq + ' ' + parsed.line + '  (added to ' + key + ')'];
  }

  // `clear access-list counters [<id|name>]` - an ACL counter is evidence, and evidence you cannot
  // zero is evidence you cannot date.
  _clearAclCounters(tokens) {
    const dev = this.device;
    const acls = dev.config.acls || {};
    const want = tokens.length ? String(tokens[0]) : null;
    if (want !== null && !acls[want]) {
      return ['% No access list ' + want + ' - the lists here: ' +
        (Object.keys(acls).join(', ') || '(none)')];
    }
    const keys = want === null ? Object.keys(acls) : [want];
    let zeroed = 0;
    for (const k of keys) {
      const list = acls[k];
      if (!list) continue;
      for (const e of list) {
        if (e.matches) { zeroed += e.matches; e.matches = 0; }
      }
      if (list.implicitMatches) { zeroed += list.implicitMatches; list.implicitMatches = 0; }
    }
    if (!keys.length) return ['% No access lists configured - nothing to clear'];
    return ['Cleared ' + zeroed + ' access-list match counter' + (zeroed === 1 ? '' : 's') +
      ' on ' + (want === null ? Object.keys(acls).length + ' list(s)' : want)];
  }

  _accessList(tokens) {
    const aclLib = require('./acl');
    if (!tokens.length) return ['% Incomplete command'];
    const num = parseInt(tokens[0], 10);
    const kind = aclLib.aclKind(num);
    if (!kind) return ['% Invalid access list number: ' + tokens[0]];
    const entry = aclLib.parseEntry(tokens.slice(1).join(' '), num);
    if (!entry || entry.error) {
      // `% ' + entry.error` printed **`% [object Object]`** - the parser returns
      // `{ error: { code, message } }`, so the console showed the shape of the answer instead of the
      // answer. The library's sentence is the useful part; the code is what the docs table lists.
      const detail = entry && entry.error && (entry.error.message || entry.error.code);
      return ['% access-list ' + num + ': ' + (detail || 'invalid entry')];
    }
    const dev = this.device;
    if (!dev.config.acls) dev.config.acls = {};
    const key = String(num);
    if (!dev.config.acls[key]) {
      const created = [];
      created.kind = kind;
      dev.config.acls[key] = created;
    }
    const list = dev.config.acls[key];
    // Sequence numbers in the IOS default step of 10, so a numbered list and a named list print the
    // same way and `no <sequence>` means the same thing in both.
    const seq = (list.length ? Number(list[list.length - 1].sequence || 0) : 0) + 10;
    entry.sequence = seq;
    entry.line = tokens.slice(1).join(' ');
    const identity = aclLib.entryKey(entry);
    const dup = list.filter(function (e) { return aclLib.entryKey(e) === identity; })[0];
    if (dup) {
      return [kind.charAt(0).toUpperCase() + kind.slice(1) + ' access list ' + num + ': that entry is' +
        ' already there at sequence ' + dup.sequence + ' - the list is unchanged'];
    }
    list.push(entry);
    return [kind.charAt(0).toUpperCase() + kind.slice(1) + ' access list ' + num +
      ' (' + seq + '): ' + entry.action + ' entry added'];
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
    // Entry identity is the library's `entryKey`, which is the decision plus the fields the
    // decision reads - never the sequence number, the stored text, or the hit counter. Building a
    // second comparison here is how `no access-list 130 deny ip any any` started refusing a line
    // that was plainly there: the entry had been *used* since it was typed, so it carried a
    // `matches` counter the freshly parsed probe did not, and the key differed by that one field.
    const strip = function (e) { return aclLib.entryKey(e); };
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
    const dir = String(tokens[1] || '').toLowerCase();
    const dev = this.device;
    if (dir !== 'in' && dir !== 'out') return ['% Usage: ip access-group <acl> in|out'];
    // Three words for a binding meant the third was dropped silently, and a binding to a list that
    // is not there turned the port into a filter that filters nothing - the worst kind of quiet.
    if (tokens.length > 2) {
      return ['% Unexpected argument "' + tokens[2] + '" - ip access-group <acl> in|out takes no more'];
    }
    const want = String(tokens[0] || '');
    if (!want) return ['% Incomplete command: ip access-group <acl> in|out'];
    const acls = dev.config.acls || {};
    // A named list is bound by name: `ip access-group BLOCK in` used to be read with parseInt and
    // refused as "Invalid access list number: BLOCK", so a named ACL could be built and never applied.
    if (!acls[want]) {
      const numeric = /^\d+$/.test(want);
      return ['% Access list ' + want + ' does not exist' +
        (numeric ? '' : ' (named lists are bound by name)'),
        '% Configured: ' + (Object.keys(acls).join(', ') || '(none)')];
    }
    if (!dev.aclBindings) dev.aclBindings = {};
    if (!dev.aclBindings[iface.name]) dev.aclBindings[iface.name] = {};
    dev.aclBindings[iface.name][dir] = want;
    return ['Interface ' + iface.name + ': access list ' + want + ' applied ' + dir];
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
      // A named list unbinds by the same word it was bound with, not only by number.
      else if (s) wantNum = /^\d+$/.test(s) ? parseInt(s, 10) : s;
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
  // A number a console takes is decimal digits. `parseInt` reads "1e3" as 1, "0x10" as 16 and "12abc" as
  // 12, so a command configured a value nobody typed - the same defect `ospf area 255.255.255.255` had,
  // one layer down. Returns null when the word is not a number at all.
  _decimal(raw) {
    const s = String(raw === undefined || raw === null ? '' : raw).trim();
    if (!/^\d+$/.test(s)) return null;
    const n = Number(s);
    return Number.isSafeInteger(n) ? n : null;
  }

  _vrrpIfaceCommand(tokens) {
    const vrrpLib = require('./vrrp');
    const out = [];
    const dev = this.device;
    if (!this.iface) return ['% vrrp must be configured inside an interface'];
    const vrid = this._decimal(tokens[1]);
    if (vrid === null || vrid < 1 || vrid > 255) {
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
      // A missing address answered `% Invalid address: (none)` - a placeholder in the position where
      // the offending value should be. Nothing was typed, so there is nothing to quote.
      if (ip === undefined) {
        return ['% Incomplete command: vrrp <vrid> ip <address>',
          '% e.g. "vrrp 1 ip 10.0.0.254"'];
      }
      if (!net.isIp(ip)) return ['% Invalid address: ' + ip];
      // The row is documented as `vrrp <vrid> ip <addr> [priority <p>] [preempt] [advertise <s>]` and the
      // tail was ignored: `priority 1e3`, `priority 0x10` and `advertise 1.5` all answered "owns ..." and
      // configured nothing. Each setting is read here with the same validation its own form uses - and
      // the whole tail is judged *before* the group is created, so a refused line leaves nothing behind.
      const set = [];
      const tail = {};
      let i = 4;
      const bad = function (word) {
        return ['% Unexpected argument "' + word + '" - vrrp <vrid> ip <addr> [priority <p>] [preempt] ' +
          '[advertise <s>]', '% Nothing was changed'];
      };
      while (i < tokens.length) {
        const kw = String(tokens[i]).toLowerCase();
        if (kw === 'priority') {
          const p = this._decimal(tokens[i + 1]);
          if (p === null || p < 1 || p > 255) {
            return ['% Invalid priority: ' + (tokens[i + 1] || '(none)') + ' (1-255)', '% Nothing was changed'];
          }
          tail.priority = p;
          set.push('priority ' + p);
          i += 2;
        } else if (kw === 'preempt') {
          tail.preempt = true;
          set.push('preempt on');
          i += 1;
        } else if (kw === 'advertise') {
          const a = this._decimal(tokens[i + 1]);
          if (a === null || a < 1 || a > 255) {
            return ['% Invalid advertisement interval: ' + (tokens[i + 1] || '(none)') +
              ' (whole seconds, 1-255)', '% Nothing was changed'];
          }
          tail.advertSec = a;
          set.push('advertise ' + a + ' s');
          i += 2;
        } else {
          return bad(tokens[i]);
        }
      }
      if (!group) {
        group = { vrid: vrid, interface: this.iface, ips: [], priority: 100, preempt: true, advertSec: 1 };
        dev.config.vrrp.push(group);
      }
      if (group.ips.indexOf(ip) === -1) group.ips.push(ip);
      if (tail.priority !== undefined) group.priority = tail.priority;
      if (tail.preempt !== undefined) group.preempt = tail.preempt;
      if (tail.advertSec !== undefined) group.advertSec = tail.advertSec;
      out.push('VRRP group ' + vrid + ' on ' + this.iface + ' owns ' + ip +
        (set.length ? ' (' + set.join(', ') + ')' : ''));
    } else if (what === 'priority') {
      // The value is judged before the group is looked for: `vrrp 1 priority 256` answered "no group 1
      // on Gi0/0", which reads as "create the group first" and then refuses the number anyway. The
      // number is wrong whatever else is missing, so that is what the refusal is about.
      const p = this._decimal(tokens[3]);
      if (p === null || p < 1 || p > 255) return ['% Invalid priority: ' + (tokens[3] || '(none)') + ' (1-255)'];
      if (tokens[4] !== undefined) {
        return ['% Unexpected argument "' + tokens[4] + '" - vrrp <vrid> priority <p> takes no more'];
      }
      if (!group) return ['% No VRRP group ' + vrid + ' on ' + this.iface + NEEDS.vrrp];
      group.priority = p;
      out.push('VRRP group ' + vrid + ' priority ' + p);
    } else if (what === 'preempt') {
      if (!group) return ['% No VRRP group ' + vrid + ' on ' + this.iface];
      // `vrrp 1 preempt extra` answered "preempt enabled" and dropped the word - the answer looked
      // like it had considered it.
      if (tokens[3] !== undefined) {
        return ['% Unexpected argument "' + tokens[3] + '" - vrrp <vrid> preempt takes no more'];
      }
      group.preempt = !(tokens[0] === 'no');
      out.push('VRRP group ' + vrid + ' preempt ' + (group.preempt ? 'enabled' : 'disabled'));
    } else if (what === 'advertise' || what === 'advertisement') {
      // Whole seconds, 1-255, like the priority - and checked before the group, for the same reason.
      // `Number()` also accepted 0.5 and 3600, and a sub-second advertisement is not a value this
      // model's one-second tick can honour.
      const a = Number(tokens[3]);
      const whole = /^\d+$/.test(String(tokens[3] === undefined ? '' : tokens[3]));
      if (!whole || a < 1 || a > 255) {
        return ['% Invalid advertisement interval: ' + (tokens[3] || '(none)') + ' (whole seconds, 1-255)'];
      }
      if (tokens[4] !== undefined) {
        return ['% Unexpected argument "' + tokens[4] + '" - vrrp <vrid> advertise <s> takes no more'];
      }
      if (!group) return ['% No VRRP group ' + vrid + ' on ' + this.iface];
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
  _showVrrp(args) {
    const out = [];
    const dev = this.device;
    let groups = Array.isArray(dev.config && dev.config.vrrp) ? dev.config.vrrp : [];
    if (!groups.length) { out.push('% VRRP is not configured' + NEEDS.vrrp); return out; }
    // `show vrrp <group>` is the form an operator types to look at one group. It answered about a
    // *time* - the trailing 1 was read as "t=1 ms" - so it reported an unconverged table with no
    // master for a group that `show vrrp` listed as Master, a contradiction one word apart.
    const want = Array.isArray(args) ? args.filter(function (x) {
      return String(x).toLowerCase() !== 'brief';
    }) : [];
    if (want.length) {
      if (want.length > 1) {
        return ['% Unexpected argument "' + want[1] + '" - show vrrp [<group>]'];
      }
      if (!/^\d+$/.test(String(want[0]))) {
        return ['% show vrrp takes a group id, not "' + want[0] + '"',
          '% e.g. show vrrp | show vrrp ' + (groups[0] ? groups[0].vrid : 1) + ' | show vrrp at <ms>'];
      }
      const vrid = Number(want[0]);
      const picked = groups.filter(function (g) { return Number(g.vrid) === vrid; });
      if (!picked.length) {
        return ['% No VRRP group ' + vrid + ' on ' + (dev.name || dev.id),
          '% The groups here are: ' + groups.map(function (g) {
            return g.vrid + ' on ' + g.interface;
          }).join(', ')];
      }
      groups = picked;
    }
    const claims = (dev.vrrpClaims || []);
    // Who actually holds each group, which is not the same question as "do I". The Master column
    // used to print this device's own name beside `State: Backup` - a table contradicting itself in
    // one row - and a Backup told the operator "no group holds its address yet - run a simulation"
    // with a simulator attached and the peer holding it.
    const holderFor = (function (g) {
      const wanted = (g.ips || []);
      const self = claims.filter(function (c) {
        return c.vrid === g.vrid && c.iface === g.interface;
      })[0];
      if (self) return { dev: dev, claim: self };
      if (!this.sim) return null;
      for (const other of this.sim.topo.devices.values()) {
        if (other === dev) continue;
        const c = (other.vrrpClaims || []).filter(function (x) {
          return x.vrid === g.vrid && (x.ips || []).some(function (ip) { return wanted.indexOf(ip) !== -1; });
        })[0];
        if (c) return { dev: other, claim: c };
      }
      return null;
    }).bind(this);
    const rows = [];
    const why = [];
    for (const g of groups) {
      const own = claims.filter(function (c) { return c.vrid === g.vrid && c.iface === g.interface; })[0];
      const holder = holderFor(g);
      rows.push([g.interface, g.vrid, (g.priority === undefined ? 100 : g.priority),
        own ? 'Master' : 'Backup', holder ? (holder.dev.name || holder.dev.id) : '-',
        (g.ips || []).join(','), own ? own.mac : '-']);
      // A group that moved needs the reason in the same answer: "Backup" alone sends an operator
      // looking for a priority mistake when the cable is out.
      if (!own && holder) {
        const minePort = dev.resolveIface(g.interface);
        // The cable is the simulator's business and the administrative state is the device's; both
        // have to be asked, because the group moved for one of them and the operator gets one line.
        let cableDown = false;
        if (minePort && minePort.peer && this.sim && typeof this.sim._linkAt === 'function') {
          const l = this.sim._linkAt(dev.id, minePort.name);
          cableDown = !!(l && !l.isUp());
        }
        const reason = minePort && minePort.enabled === false ? 'is administratively down'
          : (minePort && (minePort.lineUp === false || cableDown) ? 'has no line'
            : null);
        if (reason) {
          why.push('  ' + (dev.name || dev.id) + ': ' + g.interface + ' ' + reason +
            ', so group ' + g.vrid + ' moved to ' + (holder.dev.name || holder.dev.id));
        }
      }
    }
    out.push.apply(out, renderTable(['Interface', 'Group', 'Pri', 'State', 'Master', 'Virtual IP', 'Virtual MAC'], rows));
    out.push.apply(out, why);
    const anyHolder = groups.some(function (g) { return !!holderFor(g); });
    if (!anyHolder) {
      out.push(this.sim
        ? '(no router holds the virtual address yet - the group has not converged)'
        : '(no simulation is attached, so no group has held its address)');
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
    const stray = this._blockStrayWord(tokens, MODE_DHCP_POOL);
    if (stray) return stray;
    if (head === 'help' || head === '?') return this._help();
    // The one sub-mode that refused `do show` instead of answering it - and refusing it without
    // leaving the block, which was the only half of the behaviour that was right.
    const doShow = this._doShowInMode(tokens);
    if (doShow) return doShow;
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
        // The console speaks sentences, not validator codes. `% E_DHCP_RANGE_ORDER: ...` named the
        // library's constant where the operator needed the pool's problem; the code is still in the
        // docs' validation table and in the library, where it is useful.
        for (const e of check.errors) out.push('% ' + e.message);
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
    // A pool is legitimately *incomplete* while it is being typed, so a missing piece waits for the
    // exit check. A piece that is already *wrong* does not: `network abc` and `default-router abc`
    // were stored in silence and reported at `exit` as `% E_DHCP_BAD_NETWORK: ...`, two commands
    // later, in the validator's vocabulary. Nothing the operator types afterwards can rescue a value
    // that is not an address, so it is refused where it is typed.
    const badAddress = function (value, what) {
      return ['% "' + value + '" is not an IPv4 address, so it cannot be ' + what];
    };
    if (head === 'network') {
      if (!tokens[1]) return incomplete('Incomplete command: network <network> [mask|/prefix]');
      if (!net.isIp(tokens[1])) return badAddress(tokens[1], "the pool's network");
      if (tokens[2] && !/^\d+$/.test(String(tokens[2]).replace(/^\//, ''))) {
        if (!net.isIp(tokens[2])) {
          return ['% "' + tokens[2] + '" is not a subnet mask (e.g. 255.255.255.0 or /24)'];
        }
      }
      pool.network = tokens[1];
      if (tokens[2]) pool.mask = tokens[2];
      // Silent, like every other line in this sub-mode: the pool is legitimately incomplete while it
      // is being typed, and `show ip dhcp pool` is where the resulting range is reported.
    } else if (head === 'default-router') {
      if (!tokens[1]) return incomplete('Incomplete command: default-router <address>');
      if (!net.isIp(tokens[1])) return badAddress(tokens[1], 'the default router');
      pool.gateway = tokens[1];
    } else if (head === 'dns-server') {
      if (!tokens[1]) return incomplete('Incomplete command: dns-server <address...>');
      for (const a of tokens.slice(1)) {
        if (!net.isIp(a)) return badAddress(a, 'a DNS server');
      }
      pool.dns = tokens.slice(1).join(' ');
    } else if (head === 'range') {
      if (!tokens[1] || !tokens[2]) return incomplete('Incomplete command: range <start> <end>');
      if (!net.isIp(tokens[1])) return badAddress(tokens[1], 'the start of the range');
      if (!net.isIp(tokens[2])) return badAddress(tokens[2], 'the end of the range');
      // The library has a code for this (E_DHCP_RANGE_ORDER); the operator gets the sentence now,
      // while the two values are still on the line in front of them.
      if (net.ipToInt(tokens[1]) > net.ipToInt(tokens[2])) {
        return ['% The range starts at ' + tokens[1] + ' and ends at ' + tokens[2] +
          ' - the start must not be above the end'];
      }
      pool.rangeStart = tokens[1];
      pool.rangeEnd = tokens[2];
    } else if (head === 'excluded-address' || (head === 'excluded' && tokens[1] === 'address')) {
      const from = head === 'excluded' ? 2 : 1;
      const addrs = tokens.slice(from).filter(Boolean);
      if (!addrs.length) return incomplete('Incomplete command: excluded-address <address[-address]>');
      for (const a of addrs) {
        for (const part of String(a).split('-')) {
          if (part && !net.isIp(part)) return badAddress(part, 'an excluded address');
        }
      }
      // `excluded-address 10.9.0.10 10.9.0.20` is one range, not two addresses: the two-argument
      // form is IOS's low/high spelling. Read as two singles, the addresses between them stayed
      // leaseable and a client was handed one from the middle of a range the operator had excluded.
      const canonical = function (low, high) {
        if (!high || low === high) return low;
        return net.ipToInt(low) <= net.ipToInt(high) ? low + '-' + high : high + '-' + low;
      };
      const entries = [];
      if (addrs.length === 2 && !String(addrs[0]).includes('-') && !String(addrs[1]).includes('-')) {
        entries.push(canonical(addrs[0], addrs[1]));
      } else {
        for (const a of addrs) {
          const parts = String(a).split('-').filter(Boolean);
          entries.push(parts.length === 2 ? canonical(parts[0], parts[1]) : a);
        }
      }
      // An entry already present is not added again: `copy startup-config running-config` replays the
      // dumped lines into a pool that already has them, and concatenating would turn one excluded
      // range into two identical ones every time a saved copy was loaded.
      const have = (Array.isArray(pool.excluded) ? pool.excluded : []).map(function (r) {
        return typeof r === 'string' ? r : (r && r.start ? canonical(r.start, r.end) : String(r));
      });
      for (const e of entries) if (have.indexOf(e) === -1) have.push(e);
      pool.excluded = have;
    } else if (head === 'lease') {
      // Days by default, like IOS: `lease 0 12 0` is 12 hours.
      const nums = tokens.slice(1).filter(function (x) { return /^\d+$/.test(x); }).map(Number);
      if (!nums.length) return incomplete('Incomplete command: lease <days> [hours] [minutes]');
      const days = nums[0] || 0, hours = nums[1] || 0, mins = nums[2] || 0;
      const sec = days * 86400 + hours * 3600 + mins * 60;
      if (sec <= 0) return incomplete('A lease must be longer than zero');
      // A number, not a string: the pool's own field is a duration, `show ip dhcp pool` prints
      // "86400s" from it, and a saved state that round-trips through JSON keeps its type.
      pool.leaseSec = sec;
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
      else if (what === 'excluded-address') {
        // Granularity, the same rule the other removals follow: naming one range removes that range,
        // and the bare form is what empties the list. Before this a named range was refused outright
        // ("no excluded-address takes no more"), so an operator could only delete every exclusion to
        // get rid of one - and would then hand out addresses they had deliberately reserved.
        const named = tokens.slice(2).filter(Boolean);
        const have = (Array.isArray(pool.excluded) ? pool.excluded : []).map(function (r) {
          return typeof r === 'string' ? r : (r && r.start ? String(r.start) + '-' + String(r.end) : String(r));
        });
        if (!named.length) {
          const had = have.length;
          pool.excluded = [];
          out.push(had ? 'All ' + had + ' excluded range' + (had === 1 ? '' : 's') + ' removed' : 'No exclusions were configured');
        } else {
          const keys = [];
          if (named.length === 2 && !String(named[0]).includes('-') && !String(named[1]).includes('-')) {
            const low = net.ipToInt(named[0]) <= net.ipToInt(named[1]) ? named[0] : named[1];
            const high = low === named[0] ? named[1] : named[0];
            keys.push(low + '-' + high);
          } else {
            for (const a of named) {
              const parts = String(a).split('-').filter(Boolean);
              if (!parts.every(function (x) { return net.isIp(x); })) {
                return ['% Invalid excluded address "' + a + '"',
                  '% Usage: no excluded-address [<address> [<address>]]'];
              }
              keys.push(parts.length === 2 ? parts.join('-') : parts[0]);
            }
          }
          const gone = keys.filter(function (k) { return have.indexOf(k) !== -1; });
          const missing = keys.filter(function (k) { return have.indexOf(k) === -1; });
          pool.excluded = have.filter(function (k) { return gone.indexOf(k) === -1; });
          if (gone.length) out.push('Excluded address' + (gone.length > 1 ? 's ' : ' ') + gone.join(', ') + ' removed');
          if (missing.length) {
            out.push('% Not an exclusion here: ' + missing.join(', '),
              '% Excluded: ' + (have.length ? have.join(', ') : '(none)'),
              '% "no excluded-address" removes them all');
          }
        }
      }
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
  // Every name this console resolves is recorded on the device's own timeline, wherever the answer
  // came from - a zone served by another device, the simulator's resolver, or `no ip domain-lookup`.
  // Without this `show hosts` had nothing to show: the console resolved names and reported the
  // answer in the ping's output, and then forgot it.
  _resolveHost(text, label) {
    const res = this._resolveHostOnce(text, label);
    // A malformed address (`999.1.1.1`) was never asked of a name server, so it is not a lookup and
    // does not belong in the resolver's history - recording it would make `show hosts` list typos as
    // names that failed to resolve.
    const wasLookup = !(res && res.literal) && !/^% Invalid /.test(String((res && res.message) || ''));
    try {
      if (wasLookup && this.sim && typeof this.sim.recordDnsLookup === 'function') {
        this.sim.recordDnsLookup(this.device.id, String(res && res.asked ? res.asked : text), res || {});
      }
    } catch (e) { /* a view must not fail because a log entry could not be written */ }
    return res;
  }

  _resolveHostOnce(text, label) {
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

    // `no ip domain-lookup` is the device being told not to ask, and `ip domain-name` is the suffix
    // an unqualified name gets before it is asked. Neither existed: name resolution was always on,
    // and a name was only ever looked up exactly as typed, so the two questions a lab asks about DNS
    // ("show me that resolution can be switched off" and "why does `ping www` work here") had no
    // answer at the console.
    if (dev.config.domainLookup === false) {
      return {
        ok: false,
        message: '% Cannot resolve ' + raw + ': name lookup is disabled on ' + (dev.name || dev.id) +
          ' (no ip domain-lookup)',
        hint: '% Use the address, or put resolution back with "ip domain-lookup"',
        reason: 'lookup disabled on ' + (dev.name || dev.id)
      };
    }
    // An unqualified name gets this device's domain appended, which is what makes `ping www` an
    // answer rather than a different question. The name actually asked for is reported, so the
    // operator can see the suffix that was applied instead of guessing at it.
    let asked = raw;
    let suffixed = false;
    const domain = String(dev.config.domainName || '').trim();
    if (domain && raw.indexOf('.') === -1 && raw.toLowerCase() !== domain.toLowerCase()) {
      asked = raw + '.' + domain;
      suffixed = true;
    }

    for (const zone of (dev.config.dnsZones || [])) {
      const res = dnsLib.resolve(zone, asked, 'A');
      if (!res.authoritative) continue;
      const address = firstA(res);
      if (address) {
        // The zone is the authority, but a zone can be written by hand (a topology file, an API
        // call) instead of at the console. A record whose value is not an address used to be handed
        // straight to the data path, so `ping www.example.test` printed `Echos to abc` and reported
        // timeouts against a value no packet can be addressed to.
        if (!net.isIp(address)) {
          return { ok: false, message: '% The A record for ' + asked + ' is "' + address +
            '", which is not an address - fix the record on ' + (dev.name || dev.id) };
        }
        return { ok: true, ip: address, asked: asked, suffixed: suffixed,
          server: (dev.name || dev.id) + ' (authoritative for ' + zone.name + ')' };
      }
      // An authoritative NXDOMAIN is a statement about the name, not a failure to ask.
      return { ok: false, message: '% Unknown host ' + asked + ': ' + (res.rcodeName || 'no A record') +
        ' from ' + (dev.name || dev.id) + ', which is authoritative for ' + zone.name };
    }

    if (this.sim && typeof this.sim.resolveName === 'function') {
      const res = this.sim.resolveName(dev, asked);
      if (res.ok && res.address) {
        return { ok: true, ip: res.address, asked: asked, suffixed: suffixed, server: res.server };
      }
      if (res.status === 'NXDOMAIN') {
        return {
          ok: false,
          message: '% Unknown host ' + asked + ': NXDOMAIN from ' + (res.server || '(no server)'),
          reason: 'NXDOMAIN from ' + (res.server || '(no server)'), asked: asked, suffixed: suffixed
        };
      }
      if (res.status === 'NODATA') {
        return {
          ok: false,
          message: '% Unknown host ' + asked + ': the name exists at ' +
            (res.server || '(no server)') + ' but has no A record',
          reason: 'NODATA (the name exists but has no A record) at ' + (res.server || '(no server)'),
          asked: asked, suffixed: suffixed
        };
      }
      return {
        ok: false,
        message: '% Unknown host ' + asked + ': no DNS server in this lab hosts a zone for it',
        reason: 'no server hosts a zone for it', asked: asked, suffixed: suffixed
      };
    }
    return {
      ok: false,
      message: '% Unknown host ' + raw + ': no DNS server and no local zone contains it',
      reason: 'no server on the lab responds and no local zone holds it', asked: raw
    };
  }

  // ---------- ping ----------
  //
  // `ping 10.0.0.2` and `ping 10.0.0.2 5 at 5000` - the last form asks the question 5 seconds after
  // power-on, which is the only way to watch a lab come up. Real hardware prints a time in
  // milliseconds; this prints the delay the engine computed from the path (propagation +
  // serialisation + store-and-forward), and falls back to the hop count if a link has no length.
  // The destination is the first token, and it is never one of the command's own keywords. Every
  // command in this family has keywords of its own (`at`, `count`, `port`, `proto`, `bytes`,
  // `sport`), and a command that *begins* with one has no destination at all. Passing that word to
  // the resolver accused DNS of not hosting a zone for it:
  //
  //   R1#ping at 5000
  //   % Unknown host at: no DNS server in this lab hosts a zone for it
  //
  // which is a wrong answer to a different question - the operator forgot the address. The reply is
  // now the same in all three commands and quotes the synopsis help prints, so the placeholder the
  // operator is missing is the one they were told about. The cost, stated plainly: a host actually
  // named `at` (or `port`, `count`, ...) cannot be pinged by name - resolve it first with
  // `nslookup` and use the address.
  _requireDest(tokens, usage) {
    const first = tokens[0];
    if (first === undefined || DEST_KEYWORDS.has(String(first).toLowerCase())) {
      return { ok: false, message: '% Incomplete command: ' + usage };
    }
    return { ok: true, value: first };
  }

  _ping(tokens) {
    // `ping ipv6 <addr>` is the spelling IOS 12 documents and the one an operator reaches for first.
    // The keyword was read as the destination and refused as an invalid target, so the *whole* IPv6
    // stack - addressing, static routes, router advertisements - could be configured and never
    // tested from the console: `ping 2001:db8:1::2` answered "% Invalid ping target". The simulator
    // has had ping6() all along; only the door was missing.
    if (tokens.length && String(tokens[0]).toLowerCase() === 'ipv6') tokens = tokens.slice(1);
    const v6lib = require('./ipv6');
    if (tokens.length && v6lib.validateAddress6(String(tokens[0])).ok) {
      return this._ping6(tokens);
    }
    const dest = this._requireDest(tokens, 'ping <dst> [count <n>] [at <ms>|converged]');
    if (!dest.ok) return [dest.message];
    let count = 4;
    let atMs = null;
    for (let i = 1; i < tokens.length; i++) {
      if (String(tokens[i]).toLowerCase() === 'at') {
        // `at` with nothing after it is a missing value, not an invalid one: the message used to
        // read `% Invalid instant: (none)`, which quotes a placeholder at the operator.
        if (tokens[i + 1] === undefined) {
          return ['% Incomplete command: ping <dst> [count <n>] [at <ms>|converged]'];
        }
        const when = parseInstant(tokens[i + 1]);
        if (!when.ok) return ['% Invalid instant: ' + tokens[i + 1]];
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
    const target = this._resolveHost(dest.value, 'ping target');
    if (!target.ok) return target.hint ? [target.message, target.hint] : [target.message];
    const ip = target.ip;
    const out = target.literal ? [] : ['Translating "' + dest.value + '"...domain server (' + target.server + ')'];
    // The suffix a domain name put on the question is shown, not left for the operator to work out
    // from the answer: `ping www` reaching www.lab.test is only useful if you can see why.
    if (target.suffixed) out.push('  (as ' + target.asked + ' - "ip domain-name" appended the suffix)');
    if (!this.sim) return ['% Simulator not attached'];
    if (atMs !== null) this.sim.setRunTime(atMs);
    out.push('Type escape sequence to abort.');
    out.push('Sending ' + count + ', 100-byte ICMP Echos to ' + ip + ', timeout is 2 seconds:' +
      (atMs !== null ? '  (at ' + instantLabel(atMs) + ')' : ''));
    const res = this.sim.ping(this.device.id, ip, { count: count });
    const marks = res.replies.map(function (r) { return r.success ? '!' : '.'; }).join('');
    out.push(marks);
    const ok = res.replies.filter(function (r) { return r.success; }).length;
    // The summary is the last line of the report. It used to be pushed before the per-reply lines, so a
    // reader met "Success rate is 100 percent" in the middle of the replies it was summarising.
    const rtts = res.replies.filter(function (r) { return r.success && typeof r.rtt === 'number'; })
      .map(function (r) { return r.rtt; });
    const summary = 'Success rate is ' + Math.round((ok / count) * 100) + ' percent (' + ok + '/' + count + ')' +
      (rtts.length ? ', round-trip min/avg/max = ' +
        [Math.min.apply(null, rtts), rtts.reduce(function (a, b) { return a + b; }, 0) / rtts.length,
          Math.max.apply(null, rtts)].map(function (v) {
          return (v < 1 ? v.toFixed(3) : v.toFixed(1));
        }).join('/') + ' ms' : '');
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
    out.push(summary);
    return out;
  }

  // The IPv6 half of `ping`. Same output shape as the IPv4 one on purpose: an operator comparing two
  // runs should be reading addresses, not two different report formats.
  _ping6(tokens) {
    const v6lib = require('./ipv6');
    const dst = String(tokens[0]);
    if (!v6lib.validateAddress6(dst).ok) return ['% Invalid IPv6 ping target: ' + dst];
    let count = 4;
    let atMs = null;
    for (let i = 1; i < tokens.length; i++) {
      const tok = String(tokens[i]);
      const lower = tok.toLowerCase();
      if (lower === 'at') {
        if (tokens[i + 1] === undefined) {
          return ['% Incomplete command: ping <v6dst> [count <n>] [at <ms>|converged]'];
        }
        const when = parseInstant(tokens[i + 1]);
        if (!when.ok) return ['% Invalid instant: ' + tokens[i + 1]];
        atMs = when.atMs;
        i++;
        continue;
      }
      const isKeyword = lower === 'count';
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
    if (!this.sim) return ['% Simulator not attached'];
    if (atMs !== null) this.sim.setRunTime(atMs);
    const out = ['Type escape sequence to abort.',
      'Sending ' + count + ', 100-byte ICMP Echos to ' + dst + ', timeout is 2 seconds:' +
      (atMs !== null ? '  (at ' + instantLabel(atMs) + ')' : '')];
    const res = this.sim.ping6(this.device.id, dst, { count: count });
    out.push(res.replies.map(function (r) { return r.success ? '!' : '.'; }).join(''));
    const ok = res.replies.filter(function (r) { return r.success; }).length;
    // Same report shape as the IPv4 ping: the summary ends the output and carries the round-trip figures.
    const rtts = res.replies.filter(function (r) { return r.success && typeof r.rtt === 'number'; })
      .map(function (r) { return r.rtt; });
    const summary = 'Success rate is ' + Math.round((ok / count) * 100) + ' percent (' + ok + '/' + count + ')' +
      (rtts.length ? ', round-trip min/avg/max = ' +
        [Math.min.apply(null, rtts), rtts.reduce(function (a, b) { return a + b; }, 0) / rtts.length,
          Math.max.apply(null, rtts)].map(function (v) {
          return (v < 1 ? v.toFixed(3) : v.toFixed(1));
        }).join('/') + ' ms' : '');
    for (const r of res.replies) {
      if (!r.success) { out.push('Request timed out (seq ' + r.seq + ')'); continue; }
      const t = (r.rtt === null || r.rtt === undefined)
        ? (r.hops + ' hops')
        : (r.rtt < 1 ? r.rtt.toFixed(3) : r.rtt.toFixed(1)) + ' ms';
      out.push('Reply from ' + dst + ': bytes=100 time=' + t);
    }
    // Why nothing answered is the question the marks ask. The drops the run recorded name the exact
    // reason - no route, no egress, forwarding switched off - so the answer does not leave an
    // operator guessing between "the address is wrong" and "the router is not routing".
    if (!ok) {
      const seen = [];
      for (const ev of res.events || []) {
        if (ev.type !== 'drop' && ev.type !== 'no-route6') continue;
        let who = ev.dev || '';
        if (who && this.sim && this.sim.topo && typeof this.sim.topo.getDevice === 'function') {
          const d = this.sim.topo.getDevice(who);
          if (d) who = d.name || d.id;
        }
        const line = '% ' + (ev.reason || ev.type) + (who ? ' on ' + who : '');
        if (seen.indexOf(line) === -1) seen.push(line);
      }
      for (const line of seen.slice(0, 4)) out.push(line);
    }
    out.push(summary);
    return out;
  }

  // ---------- traceroute ----------
  //
  // The forwarding path, hop by hop. TTL expiry is not modelled: the path is the one
  // the routing tables select right now, read from the same routeTo() the forwarder
  // uses. The delay column is the one-way propagation + serialisation to reach that
  // hop, which is why it grows down the list instead of jittering.
  _traceroute(tokens) {
    // The IPv6 path is not modelled hop by hop (there is no tracePath6), so an IPv6 destination is
    // refused by name and pointed at the command that does answer: `% Invalid traceroute target:
    // 2001:db8:1::2` reads as though the address were malformed.
    const v6lib = require('./ipv6');
    if (tokens.length && v6lib.validateAddress6(String(tokens[0])).ok) {
      return ['% traceroute does not follow an IPv6 path in this model - the forwarding path is',
        '% computed from IPv4 routing tables only. "ping ' + tokens[0] + '" does work over IPv6.'];
    }
    if (tokens.length && String(tokens[0]).toLowerCase() === 'ipv6') {
      return ['% traceroute ipv6 <dst> is not modelled - use "ping ipv6 <dst>"',
        '% (this model computes a hop-by-hop path for IPv4 only)'];
    }
    const dest = this._requireDest(tokens, 'traceroute <dst> [at <ms>|converged]');
    if (!dest.ok) return [dest.message];
    const target = this._resolveHost(dest.value, 'traceroute target');
    if (!target.ok) return target.hint ? [target.message, target.hint] : [target.message];
    const ip = target.ip;
    // The same note `ping` prints when a domain name appended the suffix: two commands that resolve
    // the same name must not describe the resolution differently.
    const resolvedNote = target.literal ? []
      : (target.suffixed ? ['  (as ' + target.asked + ' - "ip domain-name" appended the suffix)'] : []);
    if (!this.sim) return ['% Simulator not attached'];
    // Every word after the destination has to be one this command uses. It used to look only for
    // `at` and ignore everything else, so `traceroute 10.0.0.5 source abc` and `traceroute 10.0.0.5
    // ttl abc` traced the whole path and said nothing about the word they dropped - an answer that
    // looks like it considered the option. `ping` already refused these; the sibling did not.
    let atMs = null;
    let numeric = false;
    for (let i = 1; i < tokens.length; i++) {
      const word = String(tokens[i]).toLowerCase();
      if (word === 'numeric') { numeric = true; continue; }
      if (word !== 'at') {
        return ['% Unrecognised argument "' + tokens[i] + '" (expected at <ms>|converged or numeric)'];
      }
      if (tokens[i + 1] === undefined) {
        return ['% Incomplete command: traceroute <dst> [at <ms>|converged] [numeric]'];
      }
      const when = parseInstant(tokens[i + 1]);
      if (!when.ok) return ['% Invalid instant: ' + tokens[i + 1]];
      atMs = when.atMs;
      i++;
    }
    const latencyLib = require('./latency');
    const res = this.sim.tracePath(this.device.id, ip, atMs === null ? {} : { atMs: atMs });
    const out = target.literal ? [] : ['Translating "' + dest.value + '"...domain server (' + target.server + ')'];
    out.push.apply(out, resolvedNote);
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
      const named = (h.device || '') + (h.last ? '  (destination)' : '');
      // `numeric` is IOS's "do not resolve names", and this traceroute resolves them into a Device
      // column. Accepting the word and printing the column anyway would be the same silence the
      // other options were refused for, so the column goes when the word is given.
      hopRows.push(numeric ? [i + 1, h.address, t] : [i + 1, h.address, t, named]);
      if (h.device) chain.push(h.device);
    }
    out.push.apply(out, renderTable(numeric
      ? ['Hop', 'Address', 'Cumulative']
      : ['Hop', 'Address', 'Cumulative', 'Device'], hopRows, 2));
    // The `*` beside a time means the link had no cable length or line rate and the documented default
    // was used. It was explained only on a trace that arrived, so a failed trace printed a mark with no
    // legend - the one case where the reader has least to go on.
    const starNote = defaulted
      ? ['* ' + (defaulted === 1 ? 'a link' : defaulted + ' links') +
        ' had no cable length or line rate, so the documented default was used']
      : [];
    if (!res.arrived) {
      out.push('  *  *  *  (no reply)');
      out.push('% ' + (res.reason || 'destination unreachable'));
      if (res.reachedFrom) {
        out.push('% The last answer came from ' + res.reachedFrom + ' - the trace stops where the path does');
      }
      out.push.apply(out, starNote);
      return out;
    }
    out.push('');
    out.push('Path: ' + (numeric ? res.hops.map(function (h, i) { return h.address; }).join(' -> ')
      : chain.join(' -> ')) + '  (' + res.hops.length + ' hop' +
      (res.hops.length === 1 ? '' : 's') + ')');
    out.push.apply(out, starNote);
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
      const extra = this._noExtra(tokens, 1, 'converge [<ms>|converged]');
      if (extra) return extra;
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
      // `state` is the cable's record. Whether a frame crosses is a second fact - a cable into a
      // shut port is up and carries nothing - and this command is the one place an operator asks
      // about a link, so it answers both instead of leaving the second to be guessed.
      const st = this.topo.linkState(l);
      out.push('  carries: ' + (st.up ? 'frames' : 'nothing - ' + st.reason));
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
    // A row is a cable, and `State` is what was done to it. A cable into a shut port is up and
    // carries nothing, and this table said `up` for it - the same default-to-good-news the link
    // inspector and the canvas had. The reason is printed under the rows rather than squeezed into a
    // column, because a table of cables is scanned and a list of faults is read.
    const stuck = [];
    for (const l of this.topo.links.values()) {
      rows.push([l.id, this._endpointName(l.a) + ' <-> ' + this._endpointName(l.b), l.state]);
      const st = this.topo.linkState(l);
      if (!st.up) stuck.push('  ' + l.id + ': carries nothing - ' + st.reason);
    }
    const out = renderTable(['Link', 'Endpoints', 'State'], rows);
    if (stuck.length) {
      out.push.apply(out, stuck);
      out.push('  State is what was done to the cable; the lines above it are where no frame crosses.');
    }
    return out;
  }

  _endpointName(end) {
    const dev = this.topo.getDevice(end.deviceId);
    return (dev ? dev.name : end.deviceId) + ':' + end.iface;
  }

  // ---------- show ----------
  // show ip protocols
  //
  // One view of the routing processes a device is *running*, which is the question a lab asks
  // before it asks about any one of them. Every fact here is already held by the model (the OSPF
  // areas, the BGP peers, the administrative distances); nothing is invented, and a device with no
  // routing process says so instead of printing an empty table.
  _showIpProtocols(args) {
    const dev = this.device;
    const out = [];
    if (args.length) {
      return ['% show ip protocols takes no argument' + (args[0] ? ', not "' + args[0] + '"' : ''),
        '% The processes here are listed by "show ip protocols" without one'];
    }
    const ospf = dev.config && dev.config.ospf;
    const bgp = dev.config && dev.config.bgp;
    // One copy of the distances, from the module that decides routing with them.
    const AD = require('./device').Device.ADMIN_DISTANCE;
    if (ospf && ospf.pid !== undefined && ospf.pid !== null) {
      // The neighbours are computed, not stored, so ask the simulator first - the same rule the BGP
      // summary was taught: a view that reads stale state reports a fault that is not there.
      if (this.sim && typeof this.sim.computeOspf === 'function') {
        try { this.sim.computeOspf(); } catch (e) { /* keep the persisted state */ }
      }
      // The interfaces come from the device, as they do in `show ip ospf`. Reading a parallel config
      // map that does not exist made this view report "(none)" for a process whose interface was in
      // area 0 - the invented-emptiness defect, in a new place.
      const participating = [];
      for (const i of dev.interfaces.values()) {
        if (!i.enabled || !i.ip || !i.mask) continue;
        const ov = (ospf.interfaces || []).filter(function (x) { return x.name === i.name; })[0];
        participating.push({ name: i.name, area: (ov && ov.area !== undefined) ? ov.area : (ospf.areaId || 0),
          passive: !!(ov && ov.passive) });
      }
      const neighbours = dev.ospfNeighbors || [];
      out.push('Routing Protocol is "ospf ' + ospf.pid + '"');
      // The id in use, not a description of the rule that produced it: this line said "not
      // configured - the highest interface address" while `show ip ospf` named the address.
      out.push('  Router ID       ' + (ospf.routerId || (dev.ospfRouterId
        ? dev.ospfRouterId + ' (derived from the highest interface address)'
        : '(none - no interface has an address to derive one from)')));
      out.push('  Administrative distance ' + AD.ospf + ' for OSPF routes' +
        ' (a static route is ' + AD.static + ', so it wins for the same prefix)');
      out.push('  Areas           ' + (Array.from(new Set(participating.map(function (p) {
        return p.area;
      }))).sort().join(', ') || '(none - no interface has an address in an area)'));
      out.push('  Interfaces      ' + (participating.length
        ? participating.map(function (p) {
          return p.name + ' (area ' + p.area + (p.passive ? ', passive' : '') + ')';
        }).join(', ')
        : '(none - no interface has an address and a mask)'));
      out.push('  Neighbours      ' + neighbours.length + ' (' +
        neighbours.filter(function (n) { return n.state === 'FULL'; }).length + ' FULL)');
    }
    if (bgp && bgp.as) {
      const peers = bgp.neighbors || [];
      out.push('Routing Protocol is "bgp ' + bgp.as + '"');
      out.push('  Router ID       ' + (bgp.routerId || dev.bgpRouterId || '0.0.0.0' + ' (not yet chosen)'));
      out.push('  Peers           ' + (peers.length
        ? peers.map(function (n) { return n.address + ' (AS ' + n.remoteAs + ')'; }).join(', ')
        : '(none configured)'));
      out.push('  Administrative distance ' + AD.ebgp + ' for eBGP, ' + AD.ibgp + ' for iBGP');
    }
    if (!out.length) {
      const isL3 = typeof dev.isL3 === 'function' && dev.isL3();
      if (!isL3) {
        // A switch is not a host, and both reach other networks the same way - by hand.
        const kind = dev.isL2 && dev.isL2() ? 'layer 2 switch' : 'host';
        return ['% ' + (dev.name || dev.id) + ' runs no routing protocol',
          '% It is a ' + kind + ': its own reachability is "ip default-gateway <gw>", entered by hand'];
      }
      return ['% No routing protocol is running on ' + (dev.name || dev.id),
        '% OSPF: "router ospf <process-id>"   BGP: "router bgp <as>"',
        '% What is in the table now: "show ip route"'];
    }
    out.push('');
    out.push('Redistribution is not modelled: a route is connected, static, OSPF or BGP, and the');
    out.push('administrative distance above is what decides between them for the same prefix.');
    return out;
  }

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
    // A view that offers a way in must offer one this device can take: "% BGP is not enabled -
    // \"router bgp <as>\" in config mode turns BGP on" was printed by a switch, where that line is
    // refused. A view with no possible content is refused by name, as the DHCP statistics view is.
    if (typeof dev.isL3 === 'function' && !dev.isL3()) {
      return ['% ' + (dev.name || dev.id) + ' is a layer 2 switch: no BGP process can run here',
        '% There are no neighbours and no BGP table to show - BGP needs a device that routes',
        '% "show ip route" is the table this device does have'];
    }
    if (!cfg || !cfg.as) { out.push('% BGP is not enabled' + NEEDS.bgp); return out; }

    // `show ip bgp neighbors` printed the summary table - the same rows, twice under two names -
    // so the detail an operator asks for (which peer, what did it give me, why is it down) had no
    // command at all. Unknown words are refused rather than answered with the summary.
    const sub = String(args[0] || '').toLowerCase();
    if (sub === 'neighbors' || sub === 'neighbour' || sub === 'neighbors' || sub === 'neighbor') {
      return this._showBgpNeighbors(args.slice(1));
    }
    // `show ip bgp` on its own is the BGP table, which is a different question from the summary - and
    // the one an operator asks when a prefix is missing. A prefix argument narrows it to one entry.
    if (!sub) return this._showBgpTable([]);
    // `at <ms>` and `converged` are the console's instant conveniences and belong to the summary,
    // which is the view whose state changes over time.
    if (sub === 'summary' || sub === 'at' || sub === 'converged') {
      // falls through to the neighbour table below
    } else if (/^\d+\.\d+\.\d+\.\d+(\/\d+)?$/.test(String(args[0]))) {
      return this._showBgpTable([args[0]]);
    } else {
      return ['% show ip bgp takes summary, neighbors or a prefix' + ', not "' + args[0] + '"',
        '% e.g. show ip bgp | show ip bgp summary | show ip bgp 192.168.5.0/24'];
    }

    // The first question after configuring a peer answered "0 of 0 neighbour(s) established" and
    // told the operator to run a simulation - with one attached. Ask the simulator first, so the
    // table is the state now rather than the state after the next packet.
    if (this.sim && typeof this.sim.computeBgp === 'function') {
      try { this.sim.computeBgp(); } catch (e) { /* keep the persisted state */ }
    }

    let rows = dev.bgpNeighbors || [];
    // A configured neighbour that the simulator has not looked at yet was simply missing from the
    // table, which read "0 of 0" for a router with a peer configured one command earlier. The list of
    // neighbours is configuration; the state is not. Show every configured peer, and say `Idle` for
    // the ones with no evaluation yet, so the count is a count of reality.
    if (!rows.length && (cfg.neighbors || []).length) {
      rows = (cfg.neighbors || []).map(function (n) {
        return { address: n.address, remoteAs: n.remoteAs, state: 'Idle', reason: 'not yet evaluated' };
      });
    }
    out.push('BGP router identifier ' + (dev.bgpRouterId || cfg.routerId || '0.0.0.0') +
      ', local AS number ' + cfg.as);
    out.push('');
    if (!rows.length) {
      out.push(pad('Neighbor', 17) + pad('V', 3) + pad('AS', 8) + pad('State', 16) + 'Reason');
      out.push('(no neighbour is configured - "neighbor <ip> remote-as <as>" adds one)');
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
    // "installed" was the count of prefixes *received*, so a prefix a connected or static route beat
    // was still counted as installed - the summary said `2 prefix(es) installed from BGP` above a
    // table where both rows were marked as losing, and a routing table with no BGP row installed at
    // all. The routing table decides; this line only counts its answer.
    const learned = (dev.bgpRoutes || []).length;
    const rtBgp = (typeof dev.routesTable === 'function')
      ? dev.routesTable().filter(function (r) { return r.code === 'B'; }) : [];
    const installed = rtBgp.filter(function (r) { return r.installed; }).length;
    if (!learned) {
      out.push('no prefix received from BGP');
    } else if (installed === learned) {
      out.push(learned + ' prefix(es) received, all installed in the routing table');
    } else {
      out.push(learned + ' prefix(es) received, ' + installed + ' installed - the rest lose on ' +
        'distance (see "show ip bgp" and "show ip route")');
    }
    return out;
  }


  // `show ip bgp` - the BGP table. It printed the neighbour summary, which meant the console answered
  // two different questions ("are my peers up" and "what did they give me, and which row forwards")
  // with one table, and the second question had no command at all.
  //
  // The columns are only the ones this model holds. IOS prints Metric, LocPrf, Weight and Origin
  // here; nothing in this engine has a MED, a local preference, a weight or an origin attribute, so
  // printing `0  100  0  ?` would be four invented figures on every row. The header says what is not
  // modelled instead, and every number that is printed came from the peer.
  _showBgpTable(args) {
    const dev = this.device;
    const cfg = dev.config && dev.config.bgp;
    const out = [];
    if (!cfg || !cfg.as) { out.push('% BGP is not enabled' + NEEDS.bgp); return out; }
    if (this.sim && typeof this.sim.computeBgp === 'function') {
      try { this.sim.computeBgp(); } catch (e) { /* keep the persisted state */ }
    }
    const learned = (dev.bgpRoutes || []).slice();
    // Which row forwards is the routing table's answer, not this view's: an `O` or `C` route to the
    // same prefix can beat BGP, and the two views must not disagree about the same row.
    const rt = (typeof dev.routesTable === 'function') ? dev.routesTable() : [];
    const installedFor = function (row) {
      const match = rt.filter(function (x) {
        return x.dest === row.dest && x.code === 'B';
      })[0];
      return !!(match && match.installed);
    };
    const want = args && args.length ? String(args[0]) : null;

    if (want) {
      return this._showBgpPrefix(want, learned, installedFor);
    }

    out.push('BGP router identifier ' + (dev.bgpRouterId || cfg.routerId || '0.0.0.0') +
      ', local AS number ' + cfg.as);
    out.push('');
    if (!learned.length && !(dev.bgpOriginated || []).length) {
      out.push('     Network            Next Hop     Path');
      const peers = (dev.bgpNeighbors || []).length || (cfg.neighbors || []).length;
      out.push(peers
        ? '(no prefix has been received - ' + peers + ' neighbour(s) configured, see "show ip bgp summary")'
        : '(no prefix has been received and no neighbour is configured - "neighbor <ip> remote-as <as>")');
      return out;
    }
    // A prefix this router announces is part of its BGP table, and it was missing: the table showed
    // only what was received, so a box with no peers said "no prefix has been received" and nothing
    // else - although it was announcing its own subnets. Next hop 0.0.0.0 is how a locally originated
    // prefix is spelled, and it is the only marker needed.
    const own = (dev.bgpOriginated || []).map(function (r) {
      return ['*>', r.dest + '/' + net.prefixOf(r.mask), '0.0.0.0', '-'];
    });
    const rows = learned.map(function (r) {
      const best = installedFor(r);
      return [(best ? '*>' : '*'),
        r.dest + '/' + net.prefixOf(r.mask),
        r.nextHop || '-',
        (r.asPath && r.asPath.length) ? r.asPath.join(' ') : '-'];
    }).concat(own);
    rows.sort(function (a, b) { return String(a[1]).localeCompare(String(b[1])); });
    out.push.apply(out, renderTable(['', 'Network', 'Next Hop', 'Path'], rows));
    out.push('');
    out.push('  *> a received row that forwards, or a prefix this router announces (next hop 0.0.0.0)');
    out.push('  *  a received row that a closer route beats - see "show ip route"');
    out.push('  This model announces the subnets it has an address on; there is no "network" or');
    out.push('  "redistribute" verb to change that.');
    if (!learned.length) {
      const peers = (dev.bgpNeighbors || []).length || (cfg.neighbors || []).length;
      out.push(peers
        ? '  Nothing has been received from a peer: "show ip bgp summary" says whether one is up.'
        : '  Nothing has been received: no neighbour is configured ("neighbor <ip> remote-as <as>").');
    }
    out.push('  MED, local preference, weight and origin are fixed defaults here - nothing in this');
    out.push('  console changes them - so they are not shown; every figure above came from the peer.');
    for (const r of learned) {
      if (installedFor(r)) continue;
      const prefix = r.dest + '/' + net.prefixOf(r.mask);
      const winner = (dev.routeTo(r.dest) || {}).type;
      if (winner && winner !== 'bgp') {
        out.push('  ' + prefix + ' is also ' + (winner === 'connected' ? 'connected' : winner) +
          ' here, which is closer than BGP\'s distance ' + r.ad + ' - see "show ip route"');
      }
    }
    return out;
  }

  // One prefix in the BGP table. The question after "is the peer up" is "did that prefix arrive, and
  // if it did, why is it not forwarding" - so both answers are here.
  _showBgpPrefix(want, learned, installedFor) {
    const dev = this.device;
    const out = [];
    const text = String(want);
    const slash = text.indexOf('/');
    const addr = slash === -1 ? text : text.slice(0, slash);
    const addrInt = net.ipToInt(addr);
    if (addrInt === null) {
      return ['% "' + text + '" is not an address or a prefix',
        '% e.g. show ip bgp 192.168.5.0 | show ip bgp 192.168.5.0/24'];
    }
    let hit = null;
    if (slash !== -1) {
      const len = Number(text.slice(slash + 1));
      hit = learned.filter(function (r) {
        return r.dest === net.intToIp(net.networkOf(addr, String(len))) &&
          net.prefixOf(r.mask) === len;
      })[0] || null;
    } else {
      // No length given: the longest match containing the address, which is the question an operator
      // with a destination address in hand is actually asking.
      let bestLen = -1;
      for (const r of learned) {
        if (!net.ipInSubnet(addr, r.dest, r.mask)) continue;
        const len = net.prefixOf(r.mask);
        if (len > bestLen) { bestLen = len; hit = r; }
      }
    }
    if (!hit) {
      out.push('% ' + text + ' is not in the BGP table on ' + (dev.name || dev.id));
      if (learned.length) {
        out.push('% The prefixes here are: ' + learned.slice().sort(function (a, b) {
          return String(a.dest).localeCompare(String(b.dest));
        }).map(function (r) {
          return r.dest + '/' + net.prefixOf(r.mask);
        }).join(', '));
      } else {
        out.push('% Nothing has been received: "show ip bgp summary" says whether a peer is up');
      }
      return out;
    }
    const prefix = hit.dest + '/' + net.prefixOf(hit.mask);
    const best = installedFor(hit);
    out.push('BGP routing table entry for ' + prefix);
    out.push('  Received from  ' + hit.nextHop + ' (AS ' + (hit.peerAs || '?') + ', ' +
      (hit.session === 'ibgp' ? 'iBGP' : 'eBGP') + ')');
    out.push('  Next hop       ' + hit.nextHop + (hit.iface ? ' (' + hit.iface + ')' : ''));
    out.push('  AS path        ' + ((hit.asPath && hit.asPath.length) ? hit.asPath.join(' ') : '-'));
    out.push('  Distance       ' + hit.ad);
    if (best) {
      out.push('  Status         best - this row forwards');
    } else {
      const winner = (dev.routeTo(hit.dest) || {}).type;
      out.push('  Status         not installed: ' +
        (winner && winner !== 'bgp'
          ? 'a ' + winner + ' route to ' + prefix + ' is closer than distance ' + hit.ad
          : 'another path to ' + prefix + ' won') + ' - see "show ip route ' +
        hit.dest + '"');
    }
    out.push('  AS path and next hop are as the peer sent them. MED, local preference, weight and the');
    out.push('  origin attribute are fixed defaults in this engine - no verb changes them, so none is');
    out.push('  printed as though it were measured.');
    return out;
  }

  // The link-state database, as this model actually has it.
  //
  // There are no aged LSAs here: `engine/ospf.js` computes the tree from the adjacency graph on
  // every change instead of storing LSAs with an age and a sequence number. Printing invented
  // ages and sequence numbers would be the one thing this panel must never do, so the header says
  // what it is and every row is a fact the SPF ran on: this router's participating links, the
  // adjacencies they produced, and the prefixes the database put in the routing table.
  _showOspfDatabase(neighbors, mismatched) {
    const dev = this.device;
    const cfg = dev.config.ospf;
    const out = [];
    // `cfg.routerId` is null when no `router-id` was typed, and this printed the JavaScript value:
    // "OSPF link-state database for process 1 (ID null)" and a link-state row with `null` in two
    // columns. The process view already prints the elected identifier; this one reads it too.
    const selfId = cfg.routerId || dev.ospfRouterId || null;
    out.push('OSPF link-state database for process ' + (cfg.pid || 1) + ' (ID ' +
      (selfId || '(no address to derive one from)') + ')');
    out.push('  This model computes the tree from the adjacency graph, so links carry no age or');
    out.push('  sequence number: what follows is exactly what the SPF ran on.');
    out.push('');

    const overrides = cfg.interfaces || [];
    const areas = new Map();
    for (const i of dev.interfaces.values()) {
      if (!i.enabled || !i.ip || !i.mask) continue;
      const ov = overrides.filter(function (x) { return x.name === i.name; })[0];
      const area = (ov && ov.area !== undefined) ? ov.area : (cfg.areaId || 0);
      const passive = !!(ov && ov.passive);
      const cost = (ov && ov.cost) || (this.sim && typeof this.sim._ospfCost === 'function'
        ? this.sim._ospfCost(i) : '?');
      const viaPeer = neighbors.filter(function (n) { return n.iface === i.name; })[0];
      if (!areas.has(area)) areas.set(area, []);
      areas.get(area).push({
        iface: i.name, cost: cost, passive: passive,
        peer: viaPeer ? viaPeer.routerId : null,
        state: viaPeer ? viaPeer.state : (passive ? 'passive' : 'stub')
      });
    }

    const areaIds = Array.from(areas.keys()).sort(function (a, b) { return Number(a) - Number(b); });
    if (!areaIds.length) {
      out.push('(no links - no interface has an address and a mask, so nothing is advertised)');
      return out;
    }
    for (const area of areaIds) {
      out.push('Router Link States (Area ' + area + ')');
      const rows = [];
      for (const l of areas.get(area)) {
        rows.push([selfId || '-', selfId || '-', l.iface, String(l.cost),
          l.peer || '-', l.state]);
      }
      // A neighbour's own links are the other half of the database: without them a stub on this
      // router and a link the peer advertises look the same.
      for (const n of neighbors) {
        const peerArea = (overrides.filter(function (x) { return x.name === n.iface; })[0] || {}).area;
        const peerInArea = (peerArea === undefined) ? (cfg.areaId || 0) : peerArea;
        if (Number(peerInArea) !== Number(area)) continue;
        // The peer's own interface cost belongs to the peer and is not in this database; a guessed
        // number would be worse than an honest dash.
        rows.push([n.routerId || '-', n.routerId || '-', n.iface,
          n.cost === undefined ? '-' : String(n.cost), selfId || '-', n.state]);
      }
      out.push.apply(out, renderTable(['Link ID', 'ADV Router', 'Interface', 'Cost', 'Neighbour', 'State'],
        rows, 2));
      out.push('');
    }

    for (const m of mismatched) {
      out.push('% ' + m.peer + ' on ' + m.iface + ' advertises area ' + m.peerArea +
        ' - excluded from this database');
    }

    // The rows the SPF installed: `dev.ospfRoutes` is exactly that list, written by the same pass
    // that filled the router's table, so the database and `show ip route ospf` cannot disagree.
    const fromDb = (dev.ospfRoutes || []).slice();
    const maslen = function (mask) {
      if (!mask) return 32;
      let n = 0;
      for (const part of String(mask).split('.')) {
        n += (Number(part) || 0).toString(2).split('1').length - 1;
      }
      return n;
    };
    out.push('Prefixes this database produced:');
    if (!fromDb.length) {
      out.push('  (none - no SPF result has been installed; see "show ip route ospf")');
    } else {
      // A prefix the SPF produced is not necessarily a prefix that forwards: a static route at
      // distance 1 beats OSPF's 110 for the same length, and this table listed the OSPF route as if
      // it were in use. The mark is the routing table's, so the two views cannot disagree.
      const rtOspf = (typeof dev.routesTable === 'function')
        ? dev.routesTable().filter(function (r) { return r.code === 'O'; }) : [];
      const forwards = function (r) {
        const want = r.dest + '/' + maslen(r.mask);
        const match = rtOspf.filter(function (x) {
          return x.dest + '/' + net.prefixOf(x.mask) === want;
        })[0];
        return !!(match && match.installed);
      };
      out.push.apply(out, renderTable(['', 'Prefix', 'Next hop', 'Interface', 'Cost'],
        fromDb.map(function (r) {
          return [forwards(r) ? '*' : '-', r.dest + '/' + maslen(r.mask), r.nextHop || '-',
            r.iface || '-', r.cost === undefined ? '-' : String(r.cost)];
        }), 2));
      // The key is printed whether or not something lost: a mark with no legend is a guess.
      out.push('  * this route forwards      - a closer route holds the same prefix');
      const lost = fromDb.filter(function (r) { return !forwards(r); });
      if (lost.length) {
        for (const r of lost) {
          const prefix = r.dest + '/' + maslen(r.mask);
          const winner = dev.routeTo(r.dest) || {};
          out.push('  ' + prefix + ' is held by a ' + (winner.type || 'closer') + ' route' +
            (winner.ad === undefined ? '' : ' at distance ' + winner.ad) +
            ', which beats OSPF at 110 - "show ip route" is what forwards');
        }
      }
    }
    return out;
  }

  // `show ip bgp neighbors [<address>]` - one row per peer was all the summary could say.
  _showBgpNeighbors(args) {
    const dev = this.device;
    const cfg = dev.config && dev.config.bgp;
    const bgpLib = require('./bgp');
    if (this.sim && typeof this.sim.computeBgp === 'function') {
      try { this.sim.computeBgp(); } catch (e) { /* keep the persisted state */ }
    }
    let rows = dev.bgpNeighbors || [];
    // The same rule the summary was taught in this series: a peer is *configuration*, its session
    // state is not. Reading only the computed rows made this view contradict the summary one command
    // away - "no neighbours configured" for a router listing two of them, and "% No BGP neighbour
    // 10.0.0.2 ... Configured: (none)" for a peer configured three lines earlier, with advice to
    // configure the peer that was already there.
    if (!rows.length && (cfg.neighbors || []).length) {
      rows = (cfg.neighbors || []).map(function (n) {
        return { address: n.address, remoteAs: n.remoteAs, state: 'Idle', reason: 'not yet evaluated' };
      });
    }
    const want = args.length ? String(args[0]) : null;
    if (want !== null && !rows.some(function (r) { return String(r.address) === want; })) {
      return ['% No BGP neighbour ' + want + ' on ' + (dev.name || dev.id),
        '% Configured: ' + (rows.map(function (r) { return r.address; }).join(', ') || '(none)')];
    }
    if (args.length > 1) {
      return ['% Unexpected argument "' + args[1] + '" - show ip bgp neighbors [<address>]'];
    }
    const out = ['BGP router identifier ' + (dev.bgpRouterId || cfg.routerId || '0.0.0.0') +
      ', local AS number ' + cfg.as];
    const picked = want === null ? rows : rows.filter(function (r) { return String(r.address) === want; });
    if (!picked.length) {
      out.push('');
      out.push('(no neighbour is configured - "neighbor <ip> remote-as <as>" adds one)');
      return out;
    }
    // Two views, one fact: this count is the routing table's, exactly as the summary's is. Counting
    // `bgpRoutes.length` said "installed" about a prefix a connected route was forwarding.
    const installed = (typeof dev.routesTable === 'function')
      ? dev.routesTable().filter(function (x) { return x.code === 'B' && x.installed; }).length
      : (dev.bgpRoutes || []).length;
    const received = (dev.bgpRoutes || []).length;
    for (const r of picked) {
      const kind = r.session === 'ibgp' ? 'iBGP' : 'eBGP';
      out.push('');
      out.push('BGP neighbour ' + r.address + ' on ' + (dev.name || dev.id) +
        ' (local AS ' + cfg.as + ')');
      out.push('  Remote AS      ' + (r.remoteAs == null ? '?' : r.remoteAs) + ' (' + kind + ')');
      out.push('  State          ' + (r.established ? 'Established' : (r.state || 'Idle')));
      // The reason is the part that answers "why is it down" - a session that never formed and one
      // that was refused by its peer look identical in a state column.
      if (!r.established && (r.reason || r.code)) {
        out.push('  Reason         ' + (r.reason || r.code));
      }
      out.push('  Hold time      ' + bgpLib.DEFAULT_HOLD_TIME + ' s');
      if (r.established) {
        out.push('  Prefixes in    ' + received + ' (received)' + (
          received === installed ? ', all installed in the routing table'
            : ', ' + installed + ' installed - the rest lose on distance'));
      } else {
        out.push('  Prefixes in    0 (no session, so nothing was exchanged)');
      }
    }
    return out;
  }

  // show ip ospf [neighbor]
  //
  // The adjacencies behind the `O` routes. Before this existed the only way to
  // see an OSPF neighbour was to infer it from the route table, which cannot tell
  // you about a neighbour that formed but produced no route - a stub, or a port
  // that is passive. `show ip ospf` reports the process and its interfaces;
  // `show ip ospf neighbor` reports the peers.
  // Can this device own a VLAN at all? It switches, or it routes between VLANs. A host does neither:
  // it has one address and one gateway. One door, so `vlan`, `no vlan` and the help page agree.
  _canDeclareVlan() {
    const dev = this.device;
    const l2 = typeof dev.isL2 === 'function' && dev.isL2();
    const l3 = typeof dev.isL3 === 'function' && dev.isL3();
    return l2 || l3;
  }

  // A device whose capability list claims a PoE standard, and whose ports carry none. Returns the
  // claim in words, or null. One door, so the show and the verbs give the same reason.
  _poeClaimWithoutPorts() {
    const dev = this.device;
    const caps = ((dev.spec && dev.spec.capabilities) || []).filter(function (c) {
      return /^poe-pse$/.test(c) || /^802\.3(at|af)$/.test(c) || /^passive-poe$/.test(c);
    });
    if (!caps.length) return null;
    for (const i of dev.interfaces.values()) {
      if (i.poeOut || (i.hardware && i.hardware.poeOut)) return null;
    }
    return caps.join(', ');
  }

  _showOspf(args) {
    const dev = this.device;
    if (typeof dev.isL3 === 'function' && !dev.isL3()) {
      return ['% ' + (dev.name || dev.id) + ' is a layer 2 switch: no OSPF process can run here',
        '% There are no neighbours and no link-state database to show - OSPF needs a device that routes',
        '% "show ip route" is the table this device does have'];
    }
    const cfg = dev.config && dev.config.ospf;
    const out = [];
    // `router ospf 1` creates a process with no router-id yet: IOS elects one from the interface
    // addresses, and refusing the show here would hide the process the command had just created.
    if (!cfg || (!cfg.routerId && !cfg.pid)) { out.push('% OSPF is not enabled' + NEEDS.ospf); return out; }

    // Refresh from the current topology, so the table reflects the SPF that just
    // ran over it rather than whatever the last ping happened to leave behind.
    if (this.sim && typeof this.sim.computeOspf === 'function') {
      try { this.sim.computeOspf(); } catch (e) { /* keep the persisted state */ }
    }

    const what = String(args[0] || '').toLowerCase();
    const neighbors = dev.ospfNeighbors || [];

    const mismatched = dev.ospfAreaMismatch || [];
    // `show ip ospf database` printed the *interface* table - the same rows as `show ip ospf`,
    // under the name of a different question. The database is the thing the SPF ran on, and this
    // model has it: the participating interfaces and the adjacencies they produced.
    if (what === 'database' || what === 'db') {
      return this._showOspfDatabase(neighbors, mismatched);
    }
    // `show ip ospf interface` is what an operator types, and it means the process view.
    if (what === 'interface' || what === 'interfaces') {
      return this._showOspf([]);
    }
    // `show ip ospf <pid>` is the spelling used when a router runs more than one process. This model
    // runs one, so the honest answer for the pid it does run is the process view, and for any other
    // pid it is the pid it actually has - not "unexpected word".
    let wantedPid = null;
    if (what && /^\d+$/.test(what)) {
      if (args.length > 1) {
        return ['% Unexpected argument "' + args[1] + '" - show ip ospf <process-id>'];
      }
      if (Number(what) !== Number(cfg.pid)) {
        return ['% No OSPF process ' + what + ' on ' + (dev.name || dev.id),
          '% The process here is "ospf ' + (cfg.pid || 1) + '"'];
      }
      wantedPid = Number(what);
    }
    if (what && wantedPid === null && what !== 'neighbor' && what !== 'neighbors' && what !== 'neighbour') {
      return ['% show ip ospf takes neighbor, database, interface or a process id, not "' + args[0] + '"',
        '% e.g. show ip ospf | show ip ospf ' + (cfg.pid || 1) + ' | show ip ospf neighbor | show ip ospf database'];
    }
    if (args.length > 1 && (what === 'database' || what === 'db')) {
      return ['% Unexpected argument "' + args[1] + '" - show ip ospf database takes no more'];
    }
    if (what === 'neighbor' || what === 'neighbors') {
      if (!neighbors.length) {
        out.push('Neighbor ID     Pri   State           Address         Interface');
        out.push('(no adjacencies - no neighbour passed the passive, subnet and area checks)');
      } else {
        const rows = neighbors.map(function (n) {
          return [n.routerId || '?', '1', n.state, n.ip, n.iface];
        });
        out.push.apply(out, renderTable(['Neighbor ID', 'Pri', 'State', 'Address', 'Interface'], rows));
      }
      // A cabled peer that is not a neighbour is the question this table raises, so answer it here:
      // an area mismatch used to form a FULL adjacency, which is how the field went unnoticed.
      for (const m of mismatched) {
        out.push('% ' + m.peer + ' on ' + m.iface + ' is in area ' + m.peerArea +
          ' and this interface is in area ' + m.area +
          ' - no adjacency without a matching area');
      }
      return out;
    }

    // The process id is what `router ospf <pid>` created; it printed the constant `ospf 1` before,
    // which was right only for the one id nobody had been able to configure.
    out.push('Routing Process "ospf ' + (cfg.pid || 1) + '" with ID ' +
      (cfg.routerId || (dev.ospfRouterId
        ? dev.ospfRouterId + ' (derived: no router-id is configured, so the highest interface address is used)'
        : '(no address to derive one from - give an interface an address or configure router-id)')));
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
        // An MX record's preference is part of its value, and the table showed only the host - so
        // `show dns` and `show running-config` disagreed about the same record.
        const recRows = records.map(function (rec) {
          const shown = (rec.priority === null || rec.priority === undefined)
            ? (rec.value || '')
            : rec.priority + ' ' + (rec.value || '');
          return [rec.name, rec.type, shown];
        });
        out.push.apply(out, renderTable(['Name', 'Type', 'Value'], recRows, 4));
      }
    }
    out.push('  Name servers: ' +
      (servers.length ? servers.join(', ') : 'none (queries go to any server in the lab)'));
    // The two settings that decide what a name query even means, beside the zones they govern.
    out.push('  Lookup      : ' + (dev.config.domainLookup === false
      ? 'disabled (no ip domain-lookup) - a name is refused, an address still works'
      : 'enabled'));
    out.push('  Domain name : ' + (dev.config.domainName || 'none (an unqualified name is asked as typed)'));
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
      out.push('% This device is not a SCION AS' + NEEDS.scion);
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
  // The reverse name an address is asked as. A reverse lookup is not a different kind of question to
  // the DNS protocol, it is a different *name* (RFC 1035): `10.0.0.53` is asked as
  // `53.0.0.10.in-addr.arpa`, and an IPv6 address as its 32 nibbles under `ip6.arpa`. This console
  // asked the literal string `10.0.0.53` as if it were a hostname, so a PTR record could be
  // configured in a zone and never reachable.
  _reverseName(addr) {
    const net = require('net');
    const v = net.isIP(String(addr));
    if (v === 4) return String(addr).split('.').reverse().join('.') + '.in-addr.arpa';
    if (v === 6) {
      // Expand to eight groups first: `::1` is a valid address and a literal nibble split of it
      // would name a different space.
      let text = String(addr).toLowerCase();
      const halves = text.split('::');
      let groups;
      if (halves.length === 2) {
        const head = halves[0] ? halves[0].split(':') : [];
        const tail = halves[1] ? halves[1].split(':') : [];
        const fill = new Array(8 - head.length - tail.length).fill('0');
        groups = head.concat(fill, tail);
      } else {
        groups = text.split(':');
      }
      const nibbles = groups.map(function (g) { return g.padStart(4, '0'); }).join('');
      return nibbles.split('').reverse().join('.') + '.ip6.arpa';
    }
    return null;
  }

  _nslookup(args) {
    const dev = this.device;
    const dnsLib = require('./dns');
    const name = args[0];
    // An address in the argument slot is a reverse question, not a hostname that happens to be
    // spelled with dots. Asking for it by its literal spelling answered "no server hosts a zone for
    // 10.0.0.53" while the zone held the PTR record all along.
    const reverse = this._reverseName(name);
    const askedName = reverse || name;
    const type = String(args[1] || (reverse ? 'PTR' : 'A')).toUpperCase();
    // The same fact as `ping` with no destination: an argument slot is empty, which is not a usage
    // error in what was typed but a missing value. One wording for the whole family.
    if (!name) return ['% Incomplete command: nslookup <name> [type]'];
    if (type !== 'ANY' && dnsLib.RECORD_TYPES.indexOf(type) === -1) {
      return ['% Unknown record type "' + type + '" (use ' + dnsLib.RECORD_TYPES.join('/') + ')'];
    }

    const out = [];
    if (reverse) {
      // The name that was actually asked is shown: a reverse lookup is the one place the console
      // rewrites what the operator typed, and hiding it makes the answer look like magic.
      out.push('  (as ' + reverse + ' - a reverse lookup of ' + name + ')');
    }
    for (const zone of (dev.config.dnsZones || [])) {
      const res = dnsLib.resolve(zone, askedName, type);
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
      const res = this.sim.resolveName(dev, askedName, type);
      // A query typed at the console is a lookup the device made, so it goes in the resolver's own
      // record exactly as one made by `ping <name>` does - otherwise `show hosts` would omit the
      // lookups an operator asked for by hand, which are the ones they are most likely to re-read.
      try {
        if (typeof this.sim.recordDnsLookup === 'function') {
          this.sim.recordDnsLookup(dev.id, askedName, {
            ok: res.ok, ip: res.value || res.address, server: res.server,
            reason: res.ok ? null : (res.status === 'NODATA' ? 'NODATA (no ' + type + ' record) at ' + (res.server || '(no server)')
              : res.status === 'NXDOMAIN' ? 'NXDOMAIN from ' + (res.server || '(no server)')
                : 'no server hosts a zone for ' + askedName)
          });
        }
      } catch (e) { /* a view must not fail because a log entry could not be written */ }
      out.push('Server: ' + (res.server || '(none)'));
      const shown = reverse ? name : askedName;
      if (res.ok) {
        // A PTR answer is a name; saying "10.0.0.53 -> host1.lab.example" would invite reading the
        // arrow as an address. The type is printed with the answer so the two directions differ.
        out.push('  ' + shown + ' -> ' + (res.value || res.address) +
          (res.rtype && res.rtype !== 'A' ? ' (' + res.rtype + ')' : ''));

      } else if (res.status === 'NODATA') {
        out.push(reverse
          ? '  ' + askedName + ' is known in that zone but has no ' + type + ' record (NODATA)'
          : '  ' + askedName + ' exists but has no ' + type + ' record (NODATA)');
      } else if (res.status === 'NXDOMAIN') {
        out.push("  ** server can't find " + askedName + ': NXDOMAIN');
      } else if (reverse) {
        // No zone serves this reverse space at all, which is a configuration fact with an exact fix.
        const space = String(askedName).toLowerCase().endsWith('.ip6.arpa')
          ? 'under ip6.arpa' : String(askedName).split('.').slice(1).join('.');
        out.push('  ** server failure: no zone for the reverse space ' + space);
        out.push('  A reverse lookup needs a zone of its own - "dns zone ' +
          (String(askedName).toLowerCase().endsWith('.ip6.arpa') ? 'ip6.arpa' : space) +
          '" on the server, with a PTR record for each address');
      } else {
        out.push('  ** server failure: no DNS server in this lab hosts a zone for ' + askedName);
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
    if (a === 'ip' && b === 'arp') return true;
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
    // A trailing number is only an instant when the view has nothing else to do with a number.
    // `show vrrp 1` and `show ip ospf 1` name a group and a process: reading the 1 as "t=1 ms"
    // answered about the *whole* process or group at an instant before it converged, and said
    // nothing about the number having been taken as a time. `converged` is a word, so it stays an
    // instant everywhere - no view takes "converged" as an argument.
    const a = String(tokens[0] || '').toLowerCase();
    const b = String(tokens[1] || '').toLowerCase();
    if (/^\d+$/.test(last)) {
      if (a === 'vrrp' && tokens.length === 2) return null;
      if (a === 'ip' && (b === 'ospf' || b === 'bgp' || b === 'dhcp') && tokens.length === 3) return null;
    }
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

  // `copy startup-config running-config` - the merge IOS performs: the saved copy is replayed through
  // this same parser, line by line, so every line is validated exactly as it would be when pasted by
  // hand (a saved line that the parser refuses today is reported, not swallowed). Nothing is cleared
  // first: IOS's merge leaves running-config lines the saved copy does not mention, and `reload` is the
  // verb that discards them.
  _loadSavedConfig(dev) {
    const name = dev.name || dev.id;
    if (!dev.savedConfig || !dev.savedConfig.lines) {
      return ['% No startup-config on ' + name + ' - there is nothing to copy from',
        '% "write memory" saves the running configuration first'];
    }
    const lines = dev.savedConfig.lines.slice();
    const savedMode = this.mode;
    // The walk starts in configuration mode, exactly where a paste would: the saved copy is a
    // running-config body, and its first lines are global config verbs.
    this.modeBeforeConfig = this.mode;
    this.mode = MODE_CONFIG;
    const before = this._runningConfigLines(dev).slice(1);
    let applied = 0;
    const refused = [];
    for (const raw of lines) {
      const line = String(raw == null ? '' : raw).trim();
      if (!line || line.startsWith('!')) continue;
      // `hostname` is applied through the same path as everything else, so the label and the config
      // cannot disagree after a load either.
      const r = this.run(line);
      const text = (r && r.output ? r.output : []).join('\n');
      if (/^\s*%/.test(text)) refused.push(line + ' -> ' + text.split('\n')[0]);
      else applied++;
    }
    // Leave the prompt where a merge leaves it: privileged exec, whatever mode the walk ended in.
    this.mode = MODE_ENABLE;
    this.modeBeforeConfig = null;
    const after = this._runningConfigLines(dev).slice(1);
    const d = diffLines(before, after);
    const unchanged = !d.added.length && !d.removed.length;
    // "5 lines applied" next to "the running configuration did not change" reads as a contradiction:
    // the lines were *read*, and none of them changed anything. Say which is which.
    const head = 'Copied startup-config into the running configuration on ' + name + ': ' +
      applied + ' line' + (applied === 1 ? '' : 's') + (unchanged ? ' read' : ' applied');
    const out = [head];
    if (unchanged) {
      out.push('  none of them changed anything - the saved copy was already in force');
    } else {
      // A count is not a report: "1 line added, 1 line removed" says a change happened and nothing about
      // what it was. The lines are named, and a long diff is capped rather than dumped.
      out.push('  ' + describeDelta(d) + ' (this is a merge: lines the saved copy does not mention are kept)');
      d.added.slice(0, 6).forEach(function (l) { out.push('    + ' + String(l).trim()); });
      if (d.added.length > 6) out.push('    + ... and ' + (d.added.length - 6) + ' more');
      d.removed.slice(0, 6).forEach(function (l) { out.push('    - ' + String(l).trim()); });
      if (d.removed.length > 6) out.push('    - ... and ' + (d.removed.length - 6) + ' more');
    }
    if (refused.length) {
      out.push('  ' + refused.length + ' saved line' + (refused.length === 1 ? ' was' : 's were') +
        ' refused by the parser as it stands today:');
      refused.slice(0, 5).forEach(function (x) { out.push('    ' + x); });
    }
    this.mode = savedMode === MODE_CONFIG ? MODE_ENABLE : savedMode;
    return out;
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
    // LLDP is on unless it was turned off, so the off state is what the dump has to carry.
    if (dev.config.lldp && dev.config.lldp.run === false) out.push('no lldp run');
    // Static ARP entries are configuration, so they are in the dump; learned entries are not.
    if (dev.arpStatic && dev.arpStatic.size) {
      for (const [ip, mac] of dev.arpStatic.entries()) {
        // Dumped in the spelling the console accepts, so a paste restores the same table.
        out.push('arp ' + ip + ' ' + mac.replace(/:/g, '').replace(/(.{4})(?=.)/g, '$1.') + ' arpa');
      }
    }
    // Name resolution is on unless it was turned off, and a domain name changes what every
    // unqualified lookup asks - both survive a paste or the lab stops being the lab.
    if (dev.config.domainLookup === false) out.push('no ip domain-lookup');
    if (dev.config.domainName) out.push('ip domain-name ' + dev.config.domainName);

    // VLAN declarations, not just the switchport membership that points at them.
    const vlans = dev.config.vlans || {};
    for (const id of Object.keys(vlans).sort(function (a, b) { return Number(a) - Number(b); })) {
      out.push('vlan ' + id + (vlans[id] && vlans[id].name ? ' ' + vlans[id].name : ''));
    }

    // Spanning tree priority, before the interface blocks: a dump that forgets the root the
    // operator chose is a dump that pastes back into a different topology.
    if (dev.config.stpPriority !== undefined) {
      // The VLAN the operator named, not VLAN 1: the dump used to invent one, so a switch configured
      // with `spanning-tree vlan 10 priority 4096` dumped - and pasted back - VLAN 1.
      out.push('spanning-tree vlan ' + (dev.config.stpVlan || 1) + ' priority ' + dev.config.stpPriority);
    }

    // OSPF process first: `ip ospf …` inside an interface is refused until
    // `ospf router-id` has enabled the process, so the global lines must
    // precede the interface blocks to round-trip.
    const ospf = dev.config.ospf;
    // `no ip routing` is configuration, so it is dumped; a paste that dropped it would silently
    // restore forwarding that somebody had deliberately turned off.
    if (dev.config.ipRouting === false) out.push('no ip routing');
    if (ospf && ospf.routerId) {
      out.push('ospf router-id ' + ospf.routerId);
      if (ospf.areaId) out.push('ospf area ' + ospf.areaId);
      if (ospf.pid) {
        // `router ospf <pid>` with the network statements that recreate the per-interface areas.
        out.push('router ospf ' + ospf.pid);
        for (const ov of (ospf.interfaces || [])) {
          if (ov.area === undefined) continue;
          const iface = dev.interfaces.get(ov.name);
          if (!iface || !iface.ip) continue;
          out.push(' network ' + iface.ip + ' 0.0.0.0 area ' + ov.area);
        }
      }
    }
    const ospfIfaces = (ospf && ospf.interfaces) || [];
    // The process id is configuration: `router ospf 1` created it, and a dump without it rebuilds a
    // router whose OSPF has no process. The network statements are derived from the interfaces that
    // carry an area, one host-wildcard statement each, so the paste lands exactly the areas that were
    // there rather than a wildcard that happens to cover them.
    const ospfBlock = (ospf && ospf.pid) ? (function () {
      const lines = ['router ospf ' + ospf.pid];
      for (const ov of ospfIfaces) {
        if (ov.area === undefined) continue;
        const iface = dev.interfaces.get(ov.name);
        if (!iface || !iface.ip) continue;
        lines.push(' network ' + iface.ip + ' 0.0.0.0 area ' + ov.area);
      }
      return lines;
    })() : null;
    const vrrp = Array.isArray(dev.config.vrrp) ? dev.config.vrrp : [];

    // Access lists are emitted before the interface blocks. A dump is pasted from the top, so an
    // interface that says `ip access-group BLOCK in` before BLOCK exists is refused by the very
    // device that wrote the dump - and the binding is lost in the paste. (OSPF's global lines are
    // ordered first for the same reason.)
    const allAcls = dev.config.acls || {};
    const aclIds = Object.keys(allAcls).sort(function (a, b) {
      const na = parseInt(a, 10), nb = parseInt(b, 10);
      if (isNaN(na) && isNaN(nb)) return a < b ? -1 : (a > b ? 1 : 0);
      if (isNaN(na)) return 1;
      if (isNaN(nb)) return -1;
      return na - nb;
    });
    for (const id of aclIds) {
      const list = allAcls[id];
      // A named list pastes back as the block that made it. `access-list BLOCK deny ...` would be
      // read as a *numbered* list whose number is the word, which is a different object - and the
      // one form the device would then refuse.
      if (/^\d+$/.test(id)) {
        for (const e of list) out.push('access-list ' + id + ' ' + (e.line || e.action));
      } else {
        out.push('ip access-list ' + (list.kind || 'extended') + ' ' + id);
        for (const e of list) {
          out.push('  ' + ((e.sequence === undefined || e.sequence === null) ? '' : e.sequence + ' ') +
            (e.line || e.action));
        }
      }
    }

    for (const i of dev.interfaces.values()) {
      out.push('interface ' + i.name);
      if (i.description) out.push('  description ' + i.description);
      // Port security is configuration, and it decides what the port will refuse - a paste that
      // dropped it would hand back a port that accepts every source.
      const sec = psLib.peek(dev, i.name);
      if (sec && sec.enabled) {
        out.push('  switchport port-security');
        if (sec.maximum !== psLib.DEFAULT_MAXIMUM) out.push('  switchport port-security maximum ' + sec.maximum);
        for (const mac of sec.configured) {
          // Dumped in the spelling the console takes, so a paste restores the same addresses.
          out.push('  switchport port-security mac-address ' + mac.replace(/:/g, '')
            .replace(/(.{4})(?!$)/g, '$1.'));
        }
        if (sec.sticky) out.push('  switchport port-security mac-address sticky');
        if (sec.violation !== psLib.DEFAULT_VIOLATION) {
          out.push('  switchport port-security violation ' + sec.violation);
        }
        // Aging is configuration too: a paste that dropped it would pin the port to whoever is
        // plugged in now, which is the state aging exists to leave behind.
        if (sec.agingTimeMin) out.push('  switchport port-security aging time ' + sec.agingTimeMin);
        if (sec.agingType === 'inactivity') out.push('  switchport port-security aging type inactivity');
        if (sec.agingStatic) out.push('  switchport port-security aging static');
      }
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
      // ...and only a device that bridges has switchports at all. A router's port carries the tagged
      // frames of its subinterfaces (the model marks the parent as a trunk to do it), but the dump
      // then printed three `switchport` lines that the same device refuses:
      //   % R1 does not switch - it has no switchports
      // so its own running-config could not be pasted back into it. The tagging requirement is
      // already stated once, by the subinterface's `encapsulation dot1q <vid>` line.
      if (i.vlan && !i.svi && (typeof dev.isL2 !== 'function' || dev.isL2())) {
        // Outside the mode branches: the voice VLAN is a parameter of the port, not of the mode, so
        // a dump that printed it only under `trunk` would lose it on a port whose mode changed.
        const voice = Number(i.vlan.voiceVlan) || null;
        if (voice) out.push('  switchport voice vlan ' + voice);
        if (i.vlan.mode === 'trunk') {
          out.push('  switchport mode trunk');
          out.push('  switchport trunk native vlan ' + i.vlan.nativeVlan);
          const av = i.vlan.allowedVlans;
          out.push('  switchport trunk allowed vlan ' +
          (av === 'all' || !Array.isArray(av) ? 'all'
            : (av.length ? av.join(',') : 'none')));
        } else {
          const av = Number(i.vlan.accessVlan) || 1;
          if (av !== 1) {
            out.push('  switchport mode access');
            out.push('  switchport access vlan ' + av);
          }
        }
      }
      if (i.mtuConfigured) out.push('  mtu ' + i.mtu);
      if (i.speedConfigured) out.push('  speed ' + (i.speedMbps || i.speed));
      if (i.duplexConfigured) out.push('  duplex ' + i.duplex);
      // A port without power is a decision that has to survive a paste: the budget it frees is the
      // reason the line was typed, and a dump that dropped it would silently re-power the device.
      if (i.poeAdmin && i.poeAdmin !== 'auto') out.push('  power inline ' + i.poeAdmin);
      // LLDP is on by default, so only the departures from that are dumped.
      if (i.lldpTx === false) out.push('  no lldp transmit');
      if (i.lldpRx === false) out.push('  no lldp receive');
      if (i.natRole) out.push('  ip nat ' + i.natRole);
      if (i.stpCost !== undefined) out.push('  spanning-tree cost ' + i.stpCost);
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
        // `vrrp <vrid> preempt` was accepted, was in the group record, and was not in the dump: so a
        // paste silently dropped the one setting that decides whether this router takes the group
        // back when it returns. Both directions are printed, because "not default" is not the same
        // as "not configured".
        // Preempt is on by default, so only turning it *off* is configuration. The block above uses
        // the same test for priority and advertise (`!== default`); this line was the one place that
        // dumped a default value, which made a saved copy grow a line nobody typed.
        if (g.preempt === false) out.push('  no vrrp ' + g.vrid + ' preempt');
      }
      if (!i.enabled) out.push('  shutdown');
    }
    // NAT rules, after the interfaces that give them their sides and their global address.
    for (const n of ((dev.config.nat && dev.config.nat.rules) || [])) {
      if (n.type === 'static') {
        out.push('ip nat inside source static ' + n.insideLocal + ' ' + n.insideGlobal);
      } else if (n.type === 'pat') {
        // The line the operator typed, not a description of the compiled rule: `interface <ip>`
        // is not something the device would take back.
        const side = n.fromIface || (function (self, ip) {
          for (const i of self.interfaces.values()) if (i.ip === ip) return i.name;
          return null;
        })(dev, n.insideGlobal);
        if (side) {
          out.push('ip nat inside source list ' + (n.fromList || 'any') + ' interface ' + side + ' overload');
        }
      }
    }
    for (const r of dev.config.routes) {
      // An interface-only route has no next hop, and `(r.gw || '')` left its slot empty, so the line
      // came out with two spaces in the middle: `ip route 10.0.0.0 255.255.255.0  Gi0/1`.
      const words = ['ip route', r.dest, r.mask];
      if (r.gw) words.push(r.gw);
      if (r.iface) words.push(r.iface);
      out.push(words.join(' '));
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
      for (const rec of (z.records || [])) {
        // An MX record carries a preference, and the dump dropped it: `dns add lab MX mail.lab.test`
        // is a line the console now refuses, so the dump could not be pasted back into itself.
        out.push('dns add ' + rec.name + ' ' + rec.type +
          (rec.priority === null || rec.priority === undefined ? '' : ' ' + rec.priority) +
          ' ' + rec.value);
      }
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

  // One answer to "is this interface up", used by every table that has a state column.
  //
  // Status is the administrator's state and Protocol is what the line is doing. A logical interface
  // has no cable of its own, so its line is borrowed: an SVI is up by VLAN membership, a subinterface
  // by its parent. `show ip interface brief` used to answer from `i.enabled` alone, so a subinterface
  // whose parent was shut reported `up/up` while a ping to its own address answered 0 percent.
  _ifaceState(i, dev) {
    const owner = dev || this.device;
    const parent = i.parent ? owner.interfaces.get(i.parent) : null;
    if (!i.enabled) {
      return { status: 'administratively down', protocol: 'down', reason: 'administratively down' };
    }
    if (parent && !parent.enabled) {
      return {
        status: 'administratively down', protocol: 'down',
        reason: 'parent ' + parent.name + ' is administratively down'
      };
    }
    if (i.lineUp === false) {
      // A logical interface whose line is not up is still `up` in the Status column - IOS's
      // `Vlan10  up  down`, because the administrator has not shut it and the line protocol is what
      // is waiting. A physical port with no cable is `down` in both columns: there is nothing to
      // wait for, and claiming `up` is how an unplugged switch port used to answer `up/up`.
      const logical = !!(i.svi || i.parent);
      return {
        status: logical ? 'up' : 'down', protocol: 'down',
        reason: i.lineStateReason || (i.svi ? 'no active port in its VLAN' : 'no carrier')
      };
    }
    return { status: 'up', protocol: 'up', reason: null };
  }

  // Why this port is not carrying frames right now, or null when it is.
  //
  // Two views need this and neither can get it from a field: the LLDP neighbour table (a row built
  // from frames that crossed the link, which nothing ever took away again) and `show interfaces
  // transceiver` (which reported `(up)` from the cable's own state on a port the administrator had
  // shut). A cable pulled out of the topology is dropped outright by `topology.disconnect()`; every
  // other way a frame stops crossing - the port shut, the far port shut - is reported here in words,
  // because this model keeps no timers and a fabricated hold-time would be a number rather than a
  // fact.
  _portNotCarryingReason(port) {
    const own = this.device.interfaces.get(port);
    if (!own) return 'that port is gone from ' + (this.device.name || this.device.id);
    const here = this._ifaceState(own);
    if (here.reason) {
      // 'administratively down' is an adjective and reads as one; a line reason is a whole clause
      // ("the cable is down", "err-disabled (port security): ..."), so it is bracketed rather than
      // spliced - "this port is the cable is down" is what a blind prefix produces.
      if (here.reason === 'administratively down') return 'this port is administratively down';
      return 'this port is down (' + here.reason + ')';
    }
    if (!own.peer) return 'there is no cable on this port';
    const topo = this.sim && this.sim.topo;
    const far = topo && topo.devices ? topo.devices.get(own.peer.deviceId) : null;
    const farPort = far ? far.interfaces.get(own.peer.iface) : null;
    if (!far || !farPort) return 'the device at the other end is gone';
    const there = this._ifaceState(farPort, far);
    if (there.reason) {
      return 'the far port ' + farPort.name + ' on ' + (far.name || far.id) + ' is ' + there.reason;
    }
    return null;
  }


  // A word after a command that takes no words is not a comment: it is a mistake, and a view that
  // ignored it answered as though it had been understood.
  //
  //   R1#show version zzzz             -> the version, as if nothing had been typed
  //   R1#show interfaces Gi0/0 zzzz    -> the interface, the word dropped
  //   R1#show ip nat translations zzzz -> the table
  //
  // The test is empirical rather than inferred from the help page: the answer is composed, and then
  // composed again without the trailing words. If the two are identical, those words were ignored —
  // which is exactly the defect, whatever the page happens to say. A handler that judged the word
  // itself (a refusal, or a different answer) is left alone, so `show interfaces vlan 20`,
  // `show logging acl-deny summary` and every other multi-word argument keeps working.
  _ignoredArgRefusal(tokens, answer) {
    if (!tokens || tokens.length < 2 || !answer || !answer.length) return null;
    if (/^%/.test(String(answer[0]))) return null;      // the handler judged the words itself
    let forms;
    try { forms = this._helpFormRowsAll(MODE_ENABLE); } catch (e) { return null; }
    if (!Array.isArray(forms) || !forms.length) return null;
    const isPlaceholder = function (t) { return !!t && typeof t === 'object' && !!t.placeholder; };
    const completeAt = function (k) {
      const typed = ['show'].concat(tokens.slice(0, k).map(function (t) {
        return String(t).toLowerCase();
      }));
      return forms.some(function (f) {
        if (!f.tokens || f.tokens.length !== typed.length) return false;
        if (String(f.tokens[0]).toLowerCase() !== 'show') return false;
        for (let i = 0; i < typed.length; i++) {
          if (isPlaceholder(f.tokens[i])) continue;
          if (String(f.tokens[i]).toLowerCase() !== typed[i]) return false;
        }
        return true;
      });
    };
    // If the whole line is a form the page lists, the words are part of the command and the handler
    // answered them - even when the answer looks the same as the bare form's (`show vrrp 1` with one
    // group, `show vlan brief` which is the table, a peer filter with a single peer).
    if (completeAt(tokens.length)) return null;
    for (let k = tokens.length - 1; k >= 1; k--) {
      if (!completeAt(k)) continue;
      const shorter = this._showInner(tokens.slice(0, k));
      if (!shorter || !shorter.length || /^%/.test(String(shorter[0]))) return null;
      if (shorter.join('\n') !== answer.join('\n')) return null;
      // Identical answers are not proof on their own: an argument that filters, in a state where
      // everything matches it, narrows to the same table (`show access-lists TEST` with one list,
      // `show vrrp 1` with one group). So the position is probed with a word that names nothing -
      // if that changes the answer, the handler reads the position and the word was meaningful.
      const probe = this._showInner(tokens.slice(0, k).concat(['zzzz']));
      if (probe && probe.length && probe.join('\n') !== answer.join('\n')) return null;
      const words = ['show'].concat(tokens.slice(0, k)).join(' ');
      const extra = tokens.slice(k).join(' ');
      return ['% "' + extra + '" is not an argument to "' + words + '"',
        '% "' + words + '" takes no argument here - type it on its own, or "?" for the commands'];
    }
    return null;
  }

  _show(tokens) {
    // The answer, then a check that the words were actually used: see _ignoredArgRefusal.
    const answer = this._showInner(tokens);
    return this._ignoredArgRefusal(tokens, answer) || answer;
  }

  _showInner(tokens) {
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
    // `show ip access-lists [<name>]` is the spelling IOS documents and every lab guide types, and
    // this console answered `% Invalid show command: ip access-lists` while holding the table.
    // Rewritten to the one form the handler reads, so there is one table and not two.
    if (String(tokens[0] || '').toLowerCase() === 'ip' &&
        (String(tokens[1] || '').toLowerCase() === 'access-lists' ||
         String(tokens[1] || '').toLowerCase() === 'access-list')) {
      tokens = ['access-lists'].concat(tokens.slice(2));
    }
    const what = (tokens[0] || '').toLowerCase();
    const dev = this.device;
    const out = [];
    // A DHCP client has no address until it has asked, and the asking is part of deriving the planes.
    // `show ip interface brief` did not derive them, so a fresh client answered `unassigned` - and
    // then a ping ran the exchange and the same command answered 192.168.5.10, while
    // `show ip dhcp binding` had been showing the lease all along. Which answer you got depended on
    // whether something else had run first, which is not a property of a table.
    const showsAddress = (function () {
      const a = String(tokens[0] || '').toLowerCase();
      const b = String(tokens[1] || '').toLowerCase();
      return (a === 'ip' && (b === 'interface' || b === 'route' || b === 'dhcp')) || a === 'interfaces';
    })();
    if (atMs === null && this.sim && (this._instantCapable(tokens) || showsAddress)) {
      // The same question must get the same answer on a fresh simulator as after a ping. Without this,
      // `show spanning-tree` answered "No bridged ports: this device is not part of any L2 loop" until
      // something else had run - a confident conclusion drawn from an empty table. Cheap: the planes
      // are derived once per change of the lab, so a second show does no work.
      const first = String(tokens[0] || '').toLowerCase();
      const wantsIpv6 = first === 'ipv6';
      if (showsAddress) {
        this.sim.refreshControlPlanes({ dhcp: true });
      } else {
        this.sim.refreshControlPlanes({
          lldp: first === 'lldp' || wantsIpv6,
          ra: wantsIpv6
        });
      }
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
    } else if (what === 'ip' && tokens[1] === 'interface' &&
               String(tokens[2] || '').toLowerCase() !== 'brief') {
      // `show ip interface` (no `brief`) is the detailed view of the same ports, and it answered
      // `% Invalid show command: ip interface` - the one spelling an operator reaches for after the
      // brief table shows a port they do not expect. Every field here is one this model already
      // stores on the interface; nothing is invented, and a field nobody set is not printed.
      const pick = this._portArg(tokens.slice(2), dev, 'show ip interface');
      if (!pick.ok) return out.concat(pick.output);
      const blocks = [];
      for (const i of dev.interfaces.values()) {
        if (pick.port && i.name !== pick.port) continue;
        const st = this._ifaceState(i);
        const lines = [i.name + ' is ' + st.status + ', line protocol is ' + st.protocol];
        if (!i.ip) {
          lines.push('  Internet address is not set');
          if (i.dhcp) lines.push('  Address is negotiated by DHCP');
        } else {
          const prefix = net.prefixOf(i.mask);
          lines.push('  Internet address is ' + i.ip + '/' + prefix);
          const bcast = (function () {
            const n = net.ipToInt(i.ip), m = net.ipToInt(i.mask);
            return net.intToIp((n | (~m >>> 0)) >>> 0);
          })();
          lines.push('  Broadcast address is ' + bcast);
        }
        if (i.mtu) lines.push('  MTU is ' + i.mtu + ' bytes');
        if (i.natRole) lines.push('  NAT role: ' + i.natRole);
        if (i.helperAddresses && i.helperAddresses.length) {
          lines.push('  Helper addresses: ' + i.helperAddresses.join(', '));
        }
        if (st.reason) lines.push('  Line state: ' + st.reason);
        const bind = dev.aclBindings && dev.aclBindings[i.name];
        if (bind && bind.in) lines.push('  Inbound access list is ' + bind.in);
        if (bind && bind.out) lines.push('  Outgoing access list is ' + bind.out);
        blocks.push(lines.join('\n'));
      }
      if (!blocks.length) {
        return ['% No interface to describe on ' + (dev.name || dev.id)];
      }
      out.push('Interfaces on ' + (dev.name || dev.id) + ' (' + blocks.length + '):');
      out.push('');
      out.push.apply(out, blocks);
    } else if (what === 'ip' && tokens[1] === 'interface' && tokens[2] === 'brief') {
      const pick = this._portArg(tokens.slice(3), dev, 'show ip interface brief');
      if (!pick.ok) return out.concat(pick.output);
      const rows = [];
      for (const i of dev.interfaces.values()) {
        if (pick.port && i.name !== pick.port) continue;
        const ip = i.ip ? i.ip + '/' + net.prefixOf(i.mask) : 'unassigned';
        // Status is the administrator's state, Protocol is what the line is doing - the distinction
        // the two columns exist for. A logical interface (SVI, subinterface) has a line without a
        // cable of its own, and both used to report `up` from `i.enabled` alone while the data path
        // refused to use them.
        const st = this._ifaceState(i);
        rows.push([i.name, ip, 'YES', i.dhcp ? 'DHCP' : 'manual', st.status, st.protocol]);
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
        if (LOAD_ROUTE_FILTERS[word] || word === 'summary') {
          // `show ip route ospf at 5000` is answered by the instant handler above; anything else
          // after a protocol word would be silently dropped, which reads as a filter it does not
          // have.
          const extra = this._noExtra(arg, 1, 'show ip route ' + word);
          if (extra) return out.concat(extra);
        }
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
      // A table full of routes on a device that will not forward them is the most misleading output
      // in the model: every row looks live. Say it once, at the top, in the words of the command.
      if (dev.config && dev.config.ipRouting === false) {
        out.push('IP routing is disabled - these routes are configured but will not forward ("ip routing" turns it on)');
      }
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
      // The caveat comes after the rows it qualifies: a reader scans the table first, and a warning
      // printed above the header reads as part of the legend.
      const strandedLines = [];
      // An installed row whose next hop this router cannot reach is a route that will not forward,
      // and nothing in the table said so: `*` means "installed by distance", which an operator reads
      // as "this is the way out". Only gateways that are neither on a connected subnet nor covered by
      // any other route are reported - a recursive next hop that *is* covered is legitimate.
      const stranded = [];
      for (const r of rows) {
        if (!r.installed || !r.gw || r.gw === '-') continue;
        const onWire = Array.from(dev.interfaces.values()).some(function (i) {
          return i.enabled !== false && i.ip && i.mask &&
            net.ipToInt(i.ip) !== null &&
            (net.ipToInt(r.gw) & net.ipToInt(i.mask)) >>> 0 === (net.ipToInt(i.ip) & net.ipToInt(i.mask)) >>> 0;
        });
        if (onWire) continue;
        const covered = rows.some(function (o) {
          if (o === r) return false;
          try {
            const m = net.ipToInt(o.mask);
            return ((net.ipToInt(r.gw) & m) >>> 0) === ((net.ipToInt(o.dest) & m) >>> 0);
          } catch (e) { return false; }
        });
        if (!covered) stranded.push(r);
      }
      if (stranded.length) {
        strandedLines.push('% ' + stranded.length + ' installed route' + (stranded.length === 1 ? '' : 's') +
          ' ha' + (stranded.length === 1 ? 's' : 've') + ' a next hop this router cannot reach:');
        for (const r of stranded.slice(0, 4)) {
          strandedLines.push('%   ' + r.dest + '/' + net.prefixOf(r.mask) + ' via ' + r.gw +
            ' - not on a connected subnet, and no route covers it');
        }
        if (stranded.length > 4) strandedLines.push('%   and ' + (stranded.length - 4) + ' more');
      }
      if (strandedLines.length) {
        out.push('');
        out.push.apply(out, strandedLines);
      }
    } else if (what === 'ip' && tokens[1] === 'protocols') {
      out.push.apply(out, this._showIpProtocols(tokens.slice(2)));
    } else if (what === 'ip' && tokens[1] === 'bgp') {
      out.push.apply(out, this._showBgp(tokens.slice(2)));
    } else if (what === 'ip' && tokens[1] === 'ospf') {
      out.push.apply(out, this._showOspf(tokens.slice(2)));
    } else if (what === 'hosts') {
      out.push.apply(out, this._showHosts());
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
      // `detail`, `interface` and `traffic` are words of this command, not port names. Reading them
      // as ports produced `% No interface named detail` for the most-typed of the three, and - worse -
      // `show lldp traffic` and `show lldp interface` silently printed the neighbour table, which is
      // an answer to a different question.
      // `tokens` here is `['lldp', <sub>, ...]`: the word after `show` is tokens[0].
      const lldpSub = String(tokens[1] || '').toLowerCase();
      if (tokens[1] === undefined || lldpSub === 'detail') {
        if (tokens.length > 2) {
          return ['% show lldp ' + (lldpSub === 'detail' ? 'detail takes' : 'takes') +
            ' no argument, not "' + tokens.slice(2).join(' ') + '"'];
        }
        return out.concat(this._showLldpGlobal(dev));
      }
      if (lldpSub === 'neighbors' && String(tokens[2] || '').toLowerCase() === 'detail') {
        if (tokens.length > 3) {
          return ['% show lldp neighbors detail takes no argument, not "' + tokens.slice(3).join(' ') + '"'];
        }
        return out.concat(this._showLldpDetail(dev));
      }
      if (lldpSub === 'interface' || lldpSub === 'traffic') {
        return out.concat(this._showLldpInterface(dev, tokens.slice(2), lldpSub === 'traffic'));
      }
      if (lldpSub === 'neighbors') {
        // `show lldp neighbors [<port>]` is the table below; the literal word is a keyword.
        tokens = [tokens[0]].concat(tokens.slice(2));
      }
      const pick = this._portArg(tokens.slice(1), dev, 'show lldp neighbors');
      if (!pick.ok) return out.concat(pick.output);
      // A device told to stop speaking has no neighbour table, and saying "none" invites the reader
      // to look for a cabling fault. The state is the answer.
      if (!dev.lldp || (dev.config.lldp && dev.config.lldp.run === false)) {
        return ['% LLDP is disabled on ' + dev.name + ' (no lldp run)',
          '% No port announces and none listens, so no neighbour can be learned',
          '% "lldp run" turns it back on'];
      }
      if (pick.port) {
        const port = dev.interfaces.get(pick.port);
        if (port && port.lldpRx === false && !dev.lldp.has(pick.port)) {
          return ['% ' + pick.port + ' is not listening for LLDP (no lldp receive)',
            '% Nothing can be learned on it until "lldp receive" is put back'];
        }
      }
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
        const self = this;
        out.push.apply(out, renderTable(['Neighbour', 'Local port', 'Port ID', 'Mgmt address'],
          rows.map(function (r) {
            const port = r[0];
            const nb = r[1];
            return [nb.systemName || '?', port, nb.portId || '?', nb.mgmtIp || '-'];
          }), 2));
        // A row here is a frame that crossed the link once. When the link can no longer carry one,
        // the row is history - and a table printed without that sentence reads as "this is what is
        // there now", which is the same mistake the access-list filter made from the other side.
        const staleRows = [];
        for (const r of rows) {
          const why = self._portNotCarryingReason(r[0]);
          if (why) {
            staleRows.push('  ' + r[0] + ': ' + (r[1].systemName || 'the neighbour') +
              ' was heard here, but ' + why);
          }
        }
        if (staleRows.length) {
          out.push.apply(out, staleRows);
          out.push('  Those rows are what crossed the link, not what is there now: no timer expires');
          out.push('  them, so an entry stays until the port passes frames again or is told to stop.');
        }
      }
    } else if (what === 'port-security') {
      out.push.apply(out, this._showPortSecurity(tokens.slice(1)));
    } else if (what === 'ip' && tokens[1] === 'traffic') {
      out.push.apply(out, this._showIpTraffic());
    } else if (what === 'access-lists' || what === 'access-list') {
      const aclLib = require('./acl');
      const acls = dev.config.acls || {};
      // `show access-lists <name>` was in the help and ignored: every name, including one that did
      // not exist, printed the whole table. A filter that answers everything looks like a filter and
      // is worse than no filter, because the operator reads the output as "yes, that list is here".
      const wanted = tokens[1] === undefined ? null : String(tokens[1]);
      if (wanted !== null) {
        const hit = acls[wanted] || acls[String(wanted).toLowerCase()];
        if (!hit) {
          const have = Object.keys(acls);
          return ['% No access list ' + wanted + ' on ' + (dev.name || dev.id),
            have.length ? '% The lists here are: ' + have.join(', ')
              : '% There are no access lists at all - "access-list <number> permit …" creates one'];
        }
      }
      // Numeric lists first, by number; named lists after, alphabetically, rather than all of them
      // through parseInt (which made every name a NaN and the order arbitrary).
      const ids = Object.keys(acls).filter(function (id) {
        return wanted === null || String(id).toLowerCase() === wanted.toLowerCase();
      }).sort(function (a, b) {
        const na = parseInt(a, 10);
        const nb = parseInt(b, 10);
        const aNum = !isNaN(na) && String(na) === String(a);
        const bNum = !isNaN(nb) && String(nb) === String(b);
        if (aNum && bNum) return na - nb;
        if (aNum) return -1;
        if (bNum) return 1;
        return String(a).localeCompare(String(b));
      });
      if (!ids.length) out.push('% No access lists configured');
      const binds = dev.aclBindings || {};
      for (const id of ids) {
        const list = acls[id];
        const kind = list.kind || aclLib.aclKind(parseInt(id, 10)) || 'extended';
        out.push((kind === 'standard' ? 'Standard' : 'Extended') + ' IP access list ' + id);
        let n = 0;
        for (const e of list) {
          n += 1;
          const seq = (e.sequence === undefined || e.sequence === null) ? n * 10 : e.sequence;
          // The counter is the part an operator comes for: a list of rules with no hits is a list of
          // intentions, and "which line ate my packet" has no answer in it.
          out.push('  ' + String(seq).padStart(3) + ' ' + (e.line || (e.action + ' ' + (e.protocol || 'ip'))) +
            (e.matches ? '  (' + e.matches + ' match' + (e.matches === 1 ? '' : 'es') + ')' : ''));
        }
        if (list.implicitMatches) {
          out.push('      implicit deny  (' + list.implicitMatches + ' match' +
            (list.implicitMatches === 1 ? '' : 'es') + ')');
        }
        for (const k of Object.keys(binds)) {
          if (String(binds[k].in) === String(id)) out.push('    applied IN on ' + k);
          if (String(binds[k].out) === String(id)) out.push('    applied OUT on ' + k);
        }
      }
    } else if (what === 'vrrp') {
      out.push.apply(out, this._showVrrp(tokens.slice(1)));
    } else if (what === 'vlan') {
      // A router answered `show vlan` with a fabricated VLAN 1 containing every port, two lines after
      // `interface vlan 10` refuses to exist because "this device does not switch". A bridge domain is
      // a thing a router does not have, so the table was describing an object the model does not
      // contain.
      // A router printed VLAN 1 with every port in it - a fabricated bridge domain, because a router
      // forwards between its own sockets and never bridges them into a VLAN. It can still *declare* a
      // VLAN (a name for a broadcast domain its subinterfaces sit in), and `show running-config`
      // round-trips that, so the declaration is shown and the membership is not invented.
      const bridged = dev.isL2();
      // `show vlan <id>` took an argument and printed every VLAN whatever you typed - the same
      // ignored-argument defect as the nine shows that ignored a port, in a command that was missed
      // because it never claimed a port. A VLAN id either narrows the answer or is refused by name;
      // a word that is not an id at all is refused as a word, not silently dropped.
      let wantVlan = null;
      let wantSummary = null;
      // The synopsis quoted back on a trailing word has to be the form that was used.
      let vlanUsage = null;
      let typedVlan = null;      // what was typed, so a refusal quotes the operator's spelling
      {
        const rest = tokens.slice(1).map(function (t) { return String(t); });
        let i = 0;
        // `brief` is the synonym the docs already promise (and `show vlan 10 brief` is the same
        // table, narrower), so it is consumed rather than read as a VLAN id. `id <n>` is the IOS
        // spelling; both take one value and nothing else.
        // `show vlan summary` is the count view every operator opens before deciding whether a VLAN
        // is missing: it was read as a VLAN id and refused with `% Invalid VLAN id "summary"`. `count`
        // is not an IOS spelling, so it is answered by naming the one that is.
        const firstWord = String(rest[i] || '').toLowerCase();
        if (firstWord === 'summary' || firstWord === 'count') {
          wantSummary = firstWord;
          i += 1;
          if (rest[i] !== undefined) {
            return out.concat(['% Unexpected argument "' + rest[i] + '" - show vlan ' + firstWord +
              ' takes no more',
              firstWord === 'count'
                ? '% IOS spells it "show vlan summary"'
                : '% Usage: show vlan summary']);
          }
        } else if (String(rest[i] || '').toLowerCase() === 'id') {
          const value = rest[i + 1];
          // A missing value and a word that is not a number are different mistakes with different
          // fixes, and both answered "Incomplete command" - so `show vlan id aa` read as "you stopped
          // typing" when the word itself was wrong.
          if (value === undefined) {
            return out.concat(['% Incomplete command: show vlan id <id>',
              '% Try "show vlan" for every VLAN this device carries']);
          }
          if (!/^\d+$/.test(String(value))) {
            return out.concat(['% "' + value + '" is not a VLAN id (1-4094)',
              '% Usage: show vlan id <id>',
              '% Try "show vlan" for every VLAN this device carries']);
          }
          wantVlan = Number(value);
          typedVlan = String(value);
          i += 2;
        } else if (String(rest[i] || '').toLowerCase() === 'name') {
          // `show vlan name <name>` - the VLANs have names, so asking by one is a reasonable question;
          // the console read `name` as a VLAN id and refused with `% Invalid VLAN id "name"`.
          const wanted = rest[i + 1];
          if (wanted === undefined) {
            return out.concat(['% Incomplete command: show vlan name <name>',
              '% Try "show vlan" to see the names this device carries']);
          }
          // A declared VLAN is a record (`{ name }`), not the name itself: reading it as a string
          // printed `% Names here: [object Object], [object Object]`.
          const names = dev.config.vlans || {};
          const nameOf = function (k) {
            const v = names[k];
            return typeof v === 'string' ? v : (v && v.name ? String(v.name) : '');
          };
          const hit = Object.keys(names).filter(function (k) {
            return nameOf(k).toLowerCase() === String(wanted).toLowerCase();
          });
          if (!hit.length) {
            const known = Object.keys(names).map(nameOf).filter(Boolean);
            return out.concat(['% No VLAN named "' + wanted + '" on ' + (dev.name || dev.id),
              known.length ? '% Names here: ' + known.join(', ') : '% No VLAN has a name yet: vlan <id> name <name>']);
          }
          wantVlan = Number(hit[0]);
          typedVlan = nameOf(hit[0]);
          vlanUsage = 'show vlan name <name>';
          i += 2;
        } else if (String(rest[i] || '').toLowerCase() === 'brief') {
          i += 1;
        } else if (rest[i] !== undefined) {
          if (!/^\d+$/.test(rest[i])) {
            return out.concat(['% Invalid VLAN id "' + rest[i] + '" - ids are numbers 1-4094',
              '% Try "show vlan" for every VLAN this device carries']);
          }
          // A number outside the range is not an id that is missing; it cannot be an id at all, and
          // saying "no VLAN 9999" invites the reader to go looking for where it went.
          if (!(Number(rest[i]) >= 1 && Number(rest[i]) <= 4094)) {
            return out.concat(['% VLAN ' + rest[i] + ' is outside 1-4094',
              '% Try "show vlan" for every VLAN this device carries']);
          }
          wantVlan = Number(rest[i]);
          typedVlan = rest[i];
          i += 1;
        }
        if (String(rest[i] || '').toLowerCase() === 'brief') i += 1;
        const extra = this._noExtra(rest, i, vlanUsage || 'show vlan [<id>|brief]');
        if (extra) return out.concat(extra);
      }
      // One walk for the whole console: `_vlanMap()` is what `no vlan` and `show vlan <id>` read too.
      const byVlan = this._vlanMap(dev);
      const declaredIds = Object.keys(dev.config.vlans || {}).map(Number);
      // A device that does not bridge has no membership to report: its VLANs are names it declared.
      // A VLAN that was declared and carries nothing is still a VLAN this device has. The table was
      // built from membership only, so `vlan 20` then `show vlan` printed VLAN 1 and nothing else -
      // while `show vlan 20` answered for the VLAN the table had just denied. A switch lists what it
      // holds, and a VLAN with no ports is a row with `-` in the Ports column.
      // A host has no VLAN domain: it has one address and one gateway, and `vlan <id>` is refused on
      // it. Printing VLAN 1 with "-" in the Ports column invented the one object the device cannot
      // have - the same defect the router rows had, one class further down.
      if (!bridged && !this._canDeclareVlan()) {
        return out.concat(['% ' + (dev.name || dev.id) + ' is a host: it has no VLANs',
          '% A VLAN is a broadcast domain on something that switches it, or routes between it',
          '% Its own address and gateway are in "show ip interface brief"']);
      }
      // Membership is not existence. A trunk's allowed list names VLANs that may not exist at all,
      // and reading the table off membership printed VLAN 77 as an active VLAN carrying a port - a
      // bridge domain invented by a filter - while `show interfaces trunk` called the same VLAN
      // inactive, because it is not configured.
      //
      // What does make a VLAN real is something actually carrying traffic in it: a declared VLAN, an
      // access port, a native VLAN, a voice VLAN, or an SVI. The map's labels carry exactly that,
      // because `(t)` is the only one that means "allowed on a trunk and nothing more".
      const carriedForReal = function (k) {
        const labels = byVlan.get(k) || [];
        return labels.some(function (l) { return !/\(t\)$/.test(String(l)); });
      };
      let keys = bridged
        ? Array.from(new Set(Array.from(byVlan.keys()).filter(function (k) {
          return k === 'all' || k === 1 || declaredIds.indexOf(k) !== -1 || carriedForReal(k);
        }).concat(declaredIds)))
        : Array.from(new Set([1].concat(declaredIds)
          .filter(function (id) { return id === 1 ? declaredIds.indexOf(1) !== -1 : true; })));
      keys = keys.sort(function (a, b) {
        if (a === 'all') return 1;
        if (b === 'all') return -1;
        return a - b;
      });
      if (wantVlan !== null) {
        const configured = dev.config.vlans && dev.config.vlans[wantVlan];
        if (keys.indexOf(wantVlan) === -1 && !configured) {
          // "Carried" means a port carries it, which is membership - not the union this table now
          // lists. Reading it off `keys` made a declared-but-empty VLAN appear in both halves of the
          // sentence at once, so the refusal contradicted itself.
          // Sorted, not in the order the ports happen to be walked: this sentence is read as a list.
          // Three states, not two. A VLAN can be carried by a port, declared and empty, or merely
          // allowed on a trunk - and the last one is the trap: it appeared in `show vlan` as an
          // active VLAN and then in this sentence as "carried", so the refusal contradicted the table
          // and itself ("no port carries it", followed by a list including it).
          const realOf = function (k) {
            const labels = byVlan.get(k) || [];
            return labels.some(function (l) { return !/\(t\)$/.test(String(l)); });
          };
          const carried = Array.from(byVlan.keys())
            .filter(function (k) { return k !== 'all' && realOf(k); })
            .sort(function (a, b) { return a - b; });
          const allowedOnly = Array.from(byVlan.keys())
            .filter(function (k) { return k !== 'all' && !realOf(k); })
            .sort(function (a, b) { return a - b; });
          // A VLAN that is configured but carries nothing is neither carried nor absent, and an
          // operator who declared it should not be told it does not exist. Naming the sets
          // separately is the difference between "you have not made it" and "you made it empty".
          const declared = Object.keys(dev.config.vlans || {}).map(Number)
            .filter(function (id) { return carried.indexOf(id) === -1; });
          return out.concat(['% No VLAN ' + (typedVlan === null ? wantVlan : typedVlan) + ' on ' + dev.name +
            ' - it is not configured and no port carries it',
            '% Carried VLANs: ' + (carried.join(', ') || '(none)') +
              (declared.length ? '; configured but empty: ' + declared.join(', ') : '') +
              (allowedOnly.length ? '; allowed on a trunk only: ' + allowedOnly.map(function (id) {
                return id + ' (' + (byVlan.get(id) || []).join(', ') + ')';
              }).join('; ') : '')]);
        }
        keys = [wantVlan];
      }
      // ...and the VLANs that were left out are named, because an operator who allowed 77 on a trunk
      // and cannot find it in this table needs to be told which two commands would make it real or
      // take it off the list.
      const phantom = [];
      if (bridged) {
        for (const [k, ports] of byVlan.entries()) {
          if (k === 'all' || k === 1) continue;
          if (declaredIds.indexOf(Number(k)) !== -1) continue;
          if (carriedForReal(k)) continue;
          phantom.push({ id: Number(k), ports: ports });
        }
      }
      const vlanRows = [];
      // The `all` bucket is not a VLAN: it is a trunk whose allowed list says "every VLAN". It was
      // rendered as a second row numbered 1 named `default`, so a switch with one all-trunk printed
      // VLAN 1 twice with different names and different ports - one table, two answers. The fact it
      // stands for is stated below the table instead.
      const allTrunks = [];
      for (const id of keys) {
        if (id === 'all') {
          allTrunks.push.apply(allTrunks, byVlan.get(id) || []);
          continue;
        }
        const name = (dev.config.vlans && dev.config.vlans[id] && dev.config.vlans[id].name) || ('VLAN' + String(id).padStart(4, '0'));
        // A configured VLAN with no port in it is a real answer and says so, rather than printing an
        // empty Ports cell that reads like a layout failure.
        const ports = bridged
          ? ((byVlan.get(id) || []).join(', ') || '(no ports)')
          : '-';       // no bridge, so no membership - not an empty cell, a column with nothing to say
        vlanRows.push([id, name, 'active', ports]);
      }
      // Nothing declared and nothing bridged: a header row with no rows under it is not an answer.
      if (!bridged && !vlanRows.length) {
        return out.concat(['% ' + (dev.name || dev.id) + ' does not bridge, so it has no VLAN table',
          '% It can still declare VLAN names for the subinterfaces it routes: "vlan <id> name <name>"']);
      }
      if (wantSummary) {
        // Counted from the rows the table would print, so the summary and the table cannot disagree
        // about how many VLANs exist - the defect that made `show vlan` describe a VLAN the
        // configuration did not have, one layer down.
        const cell = function (r) { return String(r[3]); };
        const carriedRows = vlanRows.filter(function (r) {
          return cell(r) !== '-' && cell(r) !== '(no ports)';
        });
        const svis = vlanRows.filter(function (r) { return /\(SVI\)/.test(cell(r)); }).length;
        const ports = new Set();
        for (const r of vlanRows) {
          for (const p of cell(r).split(/,\s*/)) {
            const name = p.replace(/\(.*\)$/, '').trim();
            if (/^[A-Za-z]+\d/.test(name)) ports.add(name);
          }
        }
        out.push('VLAN summary on ' + (dev.name || dev.id) + ':');
        out.push('  Existing VLANs          : ' + vlanRows.length);
        out.push('  Declared                : ' + declaredIds.length +
          (declaredIds.length ? ' (' + declaredIds.join(', ') + ')' : ' (none - "vlan <id>" declares one)'));
        out.push('  Carried by a port       : ' + carriedRows.length);
        out.push('  SVIs                    : ' + svis);
        out.push('  Allowed on a trunk only : ' + phantom.length +
          (phantom.length ? ' (' + phantom.map(function (p) { return p.id; }).join(', ') +
            ' - not configured, so not a VLAN here)' : ''));
        out.push('  Ports in a VLAN         : ' + ports.size);
        if (wantSummary === 'count') {
          out.push('');
          out.push('% "count" is not an IOS word - the spelling is "show vlan summary"');
        }
        return out;
      }
      out.push.apply(out, renderTable(['VLAN', 'Name', 'Status', 'Ports'], vlanRows));
      if (allTrunks.length) {
        out.push('');
        out.push('% ' + allTrunks.map(function (l) { return String(l).replace(/\(trunk\)$/, ''); }).join(', ') +
          (allTrunks.length === 1 ? ' allows' : ' allow') + ' every VLAN on ' +
          (allTrunks.length === 1 ? 'its trunk' : 'their trunks') + ' ("switchport trunk allowed vlan all")');
      }
      if (phantom.length) {
        // The rows that were left out are named: `show interfaces trunk` lists these as allowed, and
        // an operator looking for them here needs to know which two commands make it real or take it
        // off the list.
        out.push('');
        out.push('% ' + phantom.map(function (p) { return p.id; }).join(', ') +
          (phantom.length === 1 ? ' is' : ' are') + ' allowed on a trunk but not configured, so ' +
          (phantom.length === 1 ? 'it is' : 'they are') + ' not a VLAN on this device:');
        out.push('%   vlan <id>                               creates it');
        out.push('%   switchport trunk allowed vlan remove <id>  drops it from the allowed list');
      }
    } else if (what === 'spanning-tree') {
      // `show spanning-tree summary` and `show spanning-tree root` are the two questions an operator
      // asks of a tree that is not converging, and both were answered "No interface named summary on
      // <device>" - the sub-word was read as a port name. A keyword is not a port.
      const sub = String(tokens[1] || '').toLowerCase();
      // `spanning-tree vlan 10 root primary` configures it per VLAN, and `show spanning-tree vlan 10`
      // answered "% show spanning-tree takes one port, not \"vlan 10\"" with advice about the port
      // list - a view of the thing the configuration names, refused as though it were a typo. The
      // model runs one tree for every VLAN, so the VLAN form shows that tree *and says so*, rather
      // than pretending to a per-VLAN table that does not exist here.
      let wantVlan = null;
      let tail = tokens.slice(1);
      // Asked before the VLAN is looked up: a device that does not bridge has no tree and no VLAN
      // domain, so "No VLAN 10 on PC1 … The VLANs here are: 1" answered with a list a host cannot
      // have - the invented VLAN 1 this series removed from every other view.
      if (sub === 'vlan' && (!dev.isL2 || !dev.isL2())) {
        const isL3 = typeof dev.isL3 === 'function' && dev.isL3();
        return ['% ' + (dev.name || dev.id) + ' does not bridge, so it runs no spanning tree',
          isL3 ? '% Routers forward at L3 - a loop between them is a routing problem'
            : '% A host sends everything to its default gateway and never forwards',
          '% The L2 view on a switch is "show spanning-tree"'];
      }
      if (sub === 'vlan') {
        const vidWord = String(tokens[2] === undefined ? '' : tokens[2]);
        if (!/^\d+$/.test(vidWord)) {
          return ['% show spanning-tree vlan needs a VLAN id, not "' +
            (tokens[2] === undefined ? 'nothing' : tokens[2]) + '"',
            '% e.g. "show spanning-tree vlan 10" or "show spanning-tree vlan 10 root"'];
        }
        const vid = Number(vidWord);
        const declared = (dev.config.vlans || {})[vid];
        const carried = this._vlanMap(dev).has(vid);
        if (!declared && !carried) {
          const have = Object.keys(dev.config.vlans || {}).map(Number)
            .concat(Array.from(this._vlanMap(dev).keys()).filter(function (x) { return x !== 'all'; }).map(Number));
          const uniq = Array.from(new Set(have)).sort(function (a, b) { return a - b; });
          return ['% No VLAN ' + vid + ' on ' + (dev.name || dev.id) +
            ' - nothing is configured for it and no port carries it',
            uniq.length ? '% The VLANs here are: ' + uniq.join(', ') : '% It has no VLANs at all'];
        }
        wantVlan = vid;
        tail = tokens.slice(3);
      }
      const sub2 = String(tail[0] || '').toLowerCase();
      if (sub2 === 'summary' || sub2 === 'root') {
        if (tail.length > 1) {
          return ['% Unexpected argument "' + tail[1] + '" - show spanning-tree ' +
            (wantVlan === null ? '' : 'vlan ' + wantVlan + ' ') + sub2 + ' takes no more'];
        }
        if (!dev.isL2 || !dev.isL2()) {
          return ['% ' + (dev.name || dev.id) + ' does not bridge, so it runs no spanning tree',
            '% Routers forward at L3 - a loop between them is a routing problem'];
        }
        // `out` already carries the instant line when the operator asked at a moment
        // (`STP at t=50 ms (control planes rebuilt for this answer)`). Returning a fresh array
        // dropped it, so `show spanning-tree summary at 50` answered as if the instant had not been
        // typed - the one silent acceptance in a sweep of 38 views.
        return out.concat(this._showStpSummary(dev, sub2 === 'root', wantVlan));
      }
      const pick = this._portArg(tail, dev, 'show spanning-tree', ['summary', 'root']);
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
      // `show spanning-tree` on a PC printed "Spanning tree enabled protocol ieee" and then a
      // sentence explaining it had no bridged ports - the first line a claim, the second its
      // retraction. The `summary` and `root` forms already refused by naming the device's nature;
      // the plain form now does the same, in the same words.
      if (!dev.isL2 || !dev.isL2()) {
        const isL3 = typeof dev.isL3 === 'function' && dev.isL3();
        return ['% ' + (dev.name || dev.id) + ' does not bridge, so it runs no spanning tree',
          isL3 ? '% Routers forward at L3 - a loop between them is a routing problem'
            : '% A host sends everything to its default gateway and never forwards',
          '% The L2 view on a switch is "show spanning-tree"'];
      }
      out.push('Spanning tree enabled protocol ieee');
      // Answering a VLAN-specific question with an identical table would read as "the argument was
      // ignored". It was not: there is one tree, and this line says the table is that tree.
      if (wantVlan !== null && wantVlan !== undefined) {
        out.push('  VLAN ' + wantVlan + ' - one tree covers every VLAN on this device, so this is it');
      }
      // The root, and the bridge that decided it. The help row has always promised "root bridge,
      // port roles and states"; the table printed roles and states and never a root, so the one
      // question the command exists for - which switch is root, and why - had no answer in it.
      const root = (st.root && st.root.mac) ? st.root : null;
      const sim = this.sim;
      const rootName = (function (self) {
        if (!root) return null;
        if (st.isRoot) return (self.name || self.id);
        // A device has no back-reference to the simulator; the session has it. Asking the device
        // made every non-root switch print a bridge MAC with no name beside it.
        if (!sim) return null;
        for (const other of sim.topo.devices.values()) {
          if (other.stp && String(other.stp.bridgeId || '') === String(root.mac)) {
            return other.name || other.id;
          }
        }
        return null;
      }).call(this, dev);
      if (root) {
        out.push('  Root bridge: ' + (rootName ? 'priority ' + root.priority + ', ' + root.mac +
          ' (' + rootName + ')' : 'priority ' + root.priority + ', ' + root.mac));
        const mine = dev.config.stpPriority === undefined
          ? require('./stp').STP_DEFAULT_PRIORITY : dev.config.stpPriority;
        out.push('  This bridge: ' + (dev.name || dev.id) + ' priority ' + mine + ', ' +
          (st.bridgeId || '-') + (st.isRoot ? '   (this bridge is the root)'
            : (st.pathCost !== null && st.pathCost !== undefined ? '   root path cost ' + st.pathCost : '')));
      }
      if (!names.length) {
        out.push('  No bridged ports: this device is not part of any L2 loop.');
      } else {
        const stRows = names.map(function (n) {
          const role = (st.roles || {})[n] || '-';
          const cost = (st.costs || {})[n];
          // Why an alternate port is alternate: its path to the root costs more than the winning
          // port on the same segment. Naming the cost is what turns "blocking" into a reason.
          const note = st.states[n] === 'blocking' ? '   (traffic dropped)' : '';
          return [n, role, st.states[n] + note, cost === undefined ? '-' : String(cost)];
        });
        out.push.apply(out, renderTable(['Port', 'Role', 'State', 'Cost'], stRows));
        // Why that port and not the other one, on its own line: a reason wedged into a column
        // stretches the table and makes the roles unreadable at a glance.
        for (const n of names) {
          if (((st.roles || {})[n] || '') !== 'alternate') continue;
          // Whose port won the segment, and on what: a cheaper path, or the same path and a lower
          // bridge ID. Both reasons are honest and they send an operator to different commands.
          const iface = dev.interfaces.get(n);
          const peer = iface && iface.peer && this.sim
            ? this.sim.topo.getDevice(iface.peer.deviceId) : null;
          const peerPort = peer && iface.peer
            ? peer.stp && peer.stp.roles ? ((function (pdev, pend) {
              for (const ifc of pdev.interfaces.values()) {
                if (ifc.name === pend) return ifc.name;
              }
              return pend;
            })(peer, iface.peer.iface)) : null
            : null;
          // The segment is won on root path cost, then on bridge ID - so the reason quotes those two
          // numbers, not the port's own cost (which is what the table's Cost column shows).
          const peerPath = peer && peer.stp ? peer.stp.pathCost : undefined;
          const minePath = st.pathCost;
          let why;
          if (peerPath !== undefined && peerPath !== null && minePath !== null && peerPath < minePath) {
            why = (peer.name || peer.id) + ' reaches the root for ' + peerPath + ', this bridge for ' +
              minePath;
          } else if (peerPath !== undefined && peerPath !== null) {
            why = (peer.name || peer.id) + ' reaches the root for the same ' + peerPath +
              ', and the tie goes to the lower bridge ID';
          } else {
            why = 'the other end of the segment wins it on root path cost or bridge ID';
          }
          out.push('  ' + n + ' is alternate: ' + why);
        }
      }
    } else if (what === 'etherchannel') {
      if (!dev.isL2 || !dev.isL2()) {
        return ['% ' + (dev.name || dev.id) + ' does not switch, so it has no link aggregation',
          '% A channel-group bundles switch ports into one logical link ("channel-group <n> mode …")'];
      }
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
          // The Protocol column used to print the raw stored word, which after the mapping bug was
          // `active` - ambiguous between an LACP bundle and a static one, and for a bundle the library
          // had rejected, simply wrong.
          return [id, lagModeWord(l.mode || 'static'), members.join(' ')];
        });
        out.push.apply(out, renderTable(['Group', 'Protocol', 'Ports'], lagRows));
      }
    } else if (what === 'arp' || (what === 'ip' && String(tokens[1] || '').toLowerCase() === 'arp')) {
      // `show ip arp` is the spelling IOS prints in its own help, and it was the one refused
      // (`% Invalid show command: ip arp`) while the shorthand `show arp` answered. Both doors,
      // one answer.
      // The header promised an Interface column that no row ever filled. The ARP cache
      // is ip -> mac (nothing else is needed to answer), so the port is derived from the
      // topology at display time - the local port whose link leads to whoever owns the
      // address - and says "-" rather than lying when there is no such link.
      const simRef = this.sim;
      const ifaceFor = function (ip) {
        const owner = (simRef && simRef.ownerOfIp) ? simRef.ownerOfIp(ip) : null;
        if (!owner) {
          // A hand-written (`arp <ip> <mac>`) entry has no owner in the topology, so its port was
          // `-` and `show arp Gi0/0` answered "(none)" while the address sat in that port's subnet -
          // a view that cannot see a row the operator typed one command earlier. The port a pinned
          // address belongs to is the one whose subnet contains it.
          for (const i of dev.interfaces.values()) {
            if (!i.ip || i.parent || i.svi) continue;
            if (!i.mask) continue;
            if (net.ipInSubnet(ip, i.ip, i.mask)) return i.name;
          }
          return '-';
        }
        if (owner.id === dev.id) return '(self)';
        for (const i of dev.interfaces.values()) {
          if (i.peer && i.peer.deviceId === owner.id) return i.name;
        }
        // Two hops away: no port on this device is peered to the owner, so the answer used to be
        // `-` - and `show arp Gi0/0` then answered "no cached address resolves to this port" for an
        // address that had just been learned across a ping through that very port. The port that
        // would carry the address is still decided by the subnet, whether the owner was typed in or
        // reached.
        for (const i of dev.interfaces.values()) {
          if (!i.ip || i.parent || i.svi) continue;
          if (!i.mask) continue;
          if (net.ipInSubnet(ip, i.ip, i.mask)) return i.name;
        }
        return '-';
      };
      // `show ip arp 10.0.0.1` is *the* way an operator asks for one address's MAC, and it answered
      // "No interface named 10.0.0.1 on R1" - an address read as a port. An address filters the
      // table; a port still filters by port; a word that is neither is refused naming both.
      // `show arp interface <port>` is the other spelling the help row offers, so the literal word
      // is stripped before the argument is judged by shape.
      let arpArgs = tokens.slice(what === 'arp' ? 1 : 2);
      // `interface` abbreviates here as it does in every other argument position, because the console
      // abbreviates keywords by prefix everywhere else: `show arp int Gi0/0` answered "% show arp
      // takes one port or one address, not \"int Gi0/0\"" - a refusal that names no port and offers no
      // clue, for a word with exactly one continuation in this slot.
      const saidInterface = (function () {
        const s = String(arpArgs[0] || '').toLowerCase();
        return s === 'interface' || (s.length >= 2 && 'interface'.startsWith(s));
      })();
      if (saidInterface) arpArgs = arpArgs.slice(1);
      if (saidInterface && !arpArgs.length) {
        return ['% ' + (what === 'arp' ? 'show arp' : 'show ip arp') + ' needs a port after "interface"',
          '% Usage: show arp [<port>|<address>]'];
      }
      if (arpArgs.length === 1 && net.isIp(String(arpArgs[0]))) {
        const want = String(arpArgs[0]);
        const entry = dev.arpLookup ? dev.arpLookup(want) : (dev.arp.get(want) ? { mac: dev.arp.get(want), source: 'learned' } : null);
        if (!entry) {
          return ['% No ARP entry for ' + want + ' on ' + (dev.name || dev.id),
            '% The cache holds ' + plural(dev.arp.size + dev.arpStatic.size, 'address', 'addresses') +
            ' - "show arp" lists them, and a ping to ' + want + ' would learn it',
            '% To pin it instead: arp ' + want + ' <mac>'];
        }
        // A static entry is the one row that never ages, so the row has to say which it is: the
        // operator asking about one address is usually asking exactly that.
        // One row, built by the same renderer as the table: the hand-padded version here put the
        // address in a column that changed width with the address, so a single-address answer did
        // not line up with the table it was a slice of.
        return renderTable(['Protocol', 'Address', 'Age (min)', 'Hardware Addr', 'Interface', 'Type'],
          [['Internet', want, '-', entry.mac, ifaceFor(want),
            entry.source === 'static' ? 'STATIC' : 'DYNAMIC']]);
      }
      if (arpArgs.length > 1) {
        return ['% show arp takes one port or one address, not "' + arpArgs.join(' ') + '"',
          '% e.g. "show ip arp Gi0/0" or "show ip arp 10.0.0.1"'];
      }
      // A word after the literal `interface` is unambiguously a port, so that refusal names the
      // missing port; a bare word could be either shape and is refused with both.
      const pick = this._portArg(arpArgs, dev, 'show arp', saidInterface ? null : ['an address']);
      if (!pick.ok) return out.concat(pick.output);
      const arpRows = [];
      let statics = 0;
      // Static entries first: they are the ones that cannot be emptied, and an operator scanning the
      // table should meet the hand-written rows before the learned ones.
      const merged = [];
      for (const [ip, mac] of dev.arpStatic.entries()) merged.push({ ip: ip, mac: mac, static: true });
      for (const [ip, mac] of dev.arp.entries()) merged.push({ ip: ip, mac: mac, static: false });
      merged.sort(function (a, b) {
        if (a.static !== b.static) return a.static ? -1 : 1;
        return String(a.ip).localeCompare(String(b.ip));
      });
      for (const row of merged) {
        const onPort = ifaceFor(row.ip);
        // Filtering by port is only honest for entries whose port is known: an entry behind a switch
        // shows `-`, and folding it into another port's answer would invent a fact.
        if (pick.port && onPort !== pick.port) continue;
        if (row.static) statics += 1;
        // The word STATIC used to be smuggled into the Interface column, which pushed that column out
        // of line with its own header on every static row. It is a type, so it gets a column - the
        // same column the single-address view already prints.
        arpRows.push(['Internet', row.ip, '-', row.mac, onPort, row.static ? 'STATIC' : 'DYNAMIC']);
      }
      if (pick.port) out.push('ARP entries on ' + pick.port + ' at ' + dev.name + ':');
      out.push.apply(out, renderTable(
        ['Protocol', 'Address', 'Age (min)', 'Hardware Addr', 'Interface', 'Type'], arpRows));
      // The Age column can only ever hold `-` here: this model does not age its cache, and a figure
      // would be invented. Saying so beats a dash that reads like "static" in IOS.
      // Only when a row is actually shown: a port filter that matched nothing is answered by the
      // "(none ...)" line, and a note about ages under an empty table explains nothing.
      if (arpRows.length) {
        out.push('  Age is not tracked in this model: a learned entry stays until "clear arp" ' +
          'removes it, or a reply from the same address replaces the MAC');
      }
      if (statics) {
        // The Interface column carries the word because the table's shape is IOS's; the line below
        // says what the word means and which command removes it.
        out.push('  ' + plural(statics, 'static entry is', 'static entries are') +
          ' hand-written: they never age out, a reply cannot overwrite them, and "clear arp" leaves them');
      }
      if (pick.port && !arpRows.length) {
        out.push('  (none - no cached address resolves to this port)');
      }
    } else if (what === 'mac' && tokens[1] === 'address-table') {
      // A PC with one port printed an empty table with headers: a switching table, on a device that
      // has no switching to tabulate. The L3 equivalent is the ARP cache, and saying so is the answer.
      if (!dev.isL2 || !dev.isL2()) {
        return ['% ' + (dev.name || dev.id) + ' does not switch, so it has no MAC address table',
          '% A MAC table is what a bridge learns: which port a hardware address is behind',
          '% The equivalent here is the address cache - "show arp"'];
      }
      // `show mac address-table count` and `... dynamic` are the two spellings an operator types
      // after looking at the table, and both were answered "No interface named count on <device>" -
      // the sub-word read as a port. `count` totals what is learned; `dynamic` is what this model
      // learns (everything it has is learned from traffic); `static` is honestly empty.
      const macSub = String(tokens[2] || '').toLowerCase();
      if (macSub === 'address') {
        // `show mac address-table address <mac>` is how an operator answers "which port is this
        // hardware address behind": the one question a MAC table exists for, and it was refused as
        // "takes one port, not address 0011.2233.4455" - a family that does take keywords, told it
        // takes only ports.
        // Three spellings, one address: dotted, colon-hex and bare. `net.normalizeMac` throws on a
        // word that is not a MAC, so the shape is tested before it is called.
        const macArg = String(tokens[3] === undefined ? '' : tokens[3]);
        const looksMac = /^[0-9a-f]{12}$/i.test(macArg.replace(/[.:-]/g, ''));
        const want = looksMac ? net.normalizeMac(macArg) : null;
        if (!want) {
          return ['% show mac address-table address needs a MAC address, in any of the three spellings',
            '%   show mac address-table address 0011.2233.4455',
            '%   show mac address-table address 00:11:22:33:44:55',
            '%   show mac address-table address 001122334455'];
        }
        if (tokens[4] !== undefined) {
          return ['% Unexpected argument "' + tokens[4] + '" - show mac address-table address <mac> takes one address'];
        }
        const all = [];
        for (const [mac, iface] of dev.macTable.entries()) all.push({ vlan: 1, mac: mac, iface: iface });
        for (const [vid, table] of (dev.macTables || new Map()).entries()) {
          for (const [mac, iface] of table.entries()) all.push({ vlan: vid, mac: mac, iface: iface });
        }
        const hits = all.filter(function (r) {
          return /^[0-9a-f]{12}$/i.test(String(r.mac).replace(/[.:-]/g, '')) &&
            net.normalizeMac(r.mac) === want;
        });
        if (!hits.length) {
          return ['% ' + tokens[3] + ' is not in the table on ' + (dev.name || dev.id),
            '% ' + plural(all.length, 'entry is', 'entries are') + ' learned, and a MAC entry appears only'
              + ' once traffic has been seen from it',
            '%   show mac address-table            everything learned, with its port'];
        }
        out.push('Mac address table on ' + (dev.name || dev.id) + ' for ' + want + ':');
        out.push.apply(out, renderTable(['Vlan', 'Mac Address', 'Type', 'Ports'],
          hits.map(function (r) { return [r.vlan, r.mac, 'DYNAMIC', r.iface]; })));
        if (hits.length === 1) {
          out.push('');
          out.push('  ' + want + ' is behind ' + hits[0].iface + ' in VLAN ' + hits[0].vlan
            + ' - traffic for it is forwarded out that port');
        } else {
          out.push('');
          out.push('  ' + want + ' is learned in ' + plural(hits.length, 'VLAN') +
            ' - a bridge domain per VLAN, one port each');
        }
        return out;
      }
      if (macSub === 'count' || macSub === 'dynamic' || macSub === 'static' || macSub === 'vlan') {
        if (macSub === 'vlan' && tokens[3] === undefined) {
          return ['% Incomplete command: show mac address-table vlan <id>'];
        }
        if (macSub !== 'vlan' && tokens[3] !== undefined) {
          return ['% Unexpected argument "' + tokens[3] + '" - show mac address-table ' + macSub + ' takes no more'];
        }
        const all = [];
        for (const [mac, iface] of dev.macTable.entries()) all.push({ vlan: 1, mac: mac, iface: iface });
        for (const [vid, table] of (dev.macTables || new Map()).entries()) {
          for (const [mac, iface] of table.entries()) all.push({ vlan: vid, mac: mac, iface: iface });
        }
        if (macSub === 'static') {
          return ['% No static MAC entries on ' + (dev.name || dev.id),
            '% This model learns every entry from traffic, so all ' + all.length +
            ' are dynamic - see "show mac address-table count"'];
        }
        let rows = all;
        if (macSub === 'vlan') {
          const vid = Number(tokens[3]);
          if (!/^\d+$/.test(String(tokens[3])) || !(vid >= 1 && vid <= 4094)) {
            return ['% VLAN id must be a number 1-4094, not "' + tokens[3] + '"'];
          }
          rows = all.filter(function (r) { return r.vlan === vid; });
          out.push('Mac address table for VLAN ' + vid + ' on ' + (dev.name || dev.id) + ':');
          out.push.apply(out, renderTable(['Vlan', 'Mac Address', 'Type', 'Ports'],
            rows.map(function (r) { return [r.vlan, r.mac, 'DYNAMIC', r.iface]; })));
          if (!rows.length) out.push('  (none - nothing has been learned in this VLAN)');
          return out;
        }
        if (macSub === 'dynamic') {
          out.push.apply(out, renderTable(['Vlan', 'Mac Address', 'Type', 'Ports'],
            rows.map(function (r) { return [r.vlan, r.mac, 'DYNAMIC', r.iface]; })));
          if (!rows.length) out.push('  (none - nothing has been learned yet)');
          return out;
        }
        // count
        const perVlan = new Map();
        for (const r of rows) perVlan.set(r.vlan, (perVlan.get(r.vlan) || 0) + 1);
        out.push('Mac address table count on ' + (dev.name || dev.id) + ':');
        out.push.apply(out, renderTable(['Vlan', 'Entries'],
          Array.from(perVlan.keys()).sort(function (a, b) { return a - b; })
            .map(function (v) { return [v, perVlan.get(v)]; })));
        out.push('  Total: ' + rows.length + ' dynamic, 0 static, 0 secure');
        if (!rows.length) out.push('  (nothing has been learned yet - move traffic and ask again)');
        return out;
      }
      const pick = this._portArg(tokens.slice(2), dev, 'show mac address-table',
        ['count', 'dynamic', 'static', 'vlan']);
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
               (tokens[1] === 'trunk' || tokens[1] === 'trunks')) {
      // `show interfaces trunk` read "trunk" as a port name and answered "No interface named trunk".
      // It is the first view an operator opens on a switch that is not passing tagged traffic, and
      // every fact in it - mode, native VLAN, allowed and active lists - was already in the model.
      out.push.apply(out, this._showInterfacesTrunk(tokens[2]));
    } else if ((what === 'interfaces' || what === 'interface') &&
               (tokens[1] === 'transceiver' || tokens[1] === 'transceivers')) {
      out.push.apply(out, this._showTransceiver(tokens[2]));
    } else if (what === 'interfaces' || what === 'interface') {
      // `show interfaces ether1` used to ignore the port and print every port on the box,
      // which is worse than a refusal: it looks like an answer. The token goes through the
      // same resolver the config parser uses, so any spelling of the port works.
      let only = null;
      const ifSub = String(tokens[1] || '').toLowerCase();
      if (ifSub === 'status') {
        // The table a switch operator lives in, and it did not exist: `show interfaces status`
        // answered "% \"show interfaces status\" is not a command here". Every column is a fact the
        // model already holds - the description typed on the port, its line state, its VLAN, its
        // negotiated speed and duplex - so nothing here is derived for the first time.
        if (tokens[2] !== undefined) {
          return ['% Unexpected argument "' + tokens[2] + '" - show interfaces status takes no more',
            '% For one port, use "show interfaces <port>"'];
        }
        if (!dev.isL2 || !dev.isL2()) {
          return ['% ' + (dev.name || dev.id) + ' does not switch, so it has no per-port VLAN status',
            '% Its ports are in "show ip interface brief", and their state in "show interfaces <port>"'];
        }
        const rows = [];
        for (const i of dev.interfaces.values()) {
          if (i.parent) continue;
          // `lineUp` is derived in computePortState() from shutdown, cable and link state, so this
          // column says `notconnect` for a port with nothing plugged into it rather than claiming
          // `connected` because nothing is broken.
          // A port err-disabled by a port security violation is not `notconnect` - something *is*
          // plugged in, and the port is refusing to use it. IOS has a word for that, and it is the
          // word an operator scans the table for after an incident.
          const sec = psLib.peek(dev, i.name);
          const link = !i.enabled ? 'disabled'
            : (sec && sec.errDisabled ? 'err-disabled'
              : (i.lineUp === false ? 'notconnect' : 'connected'));
          // The VLAN a frame leaving this port is in: a trunk carries many and says so.
          const vlan = (function () {
            const v = i.vlan || {};
            if (v.mode === 'trunk') return 'trunk';
            if (v.accessVlan) return String(v.accessVlan);
            return '1';
          })();
          const duplex = i.duplexConfigured ? String(i.duplex) : ('a-' + String(i.duplex || 'full'));
          const speed = i.speedConfigured ? String(i.speed) : ('a-' + String(i.speed || '1G'));
          rows.push([i.name, i.description || '', link, vlan, duplex, speed, i.type || 'ethernet']);
        }
        out.push('Ports on ' + (dev.name || dev.id) + ' (' + rows.length + '):');
        out.push.apply(out, renderTable(['Port', 'Name', 'Status', 'Vlan', 'Duplex', 'Speed', 'Type'], rows));
        const counts = rows.reduce(function (a, r) {
          a[r[2]] = (a[r[2]] || 0) + 1; return a;
        }, {});
        out.push('');
        out.push(Object.keys(counts).sort().map(function (k) { return counts[k] + ' ' + k; }).join(', '));
        return out;
      }
      if (ifSub === 'description') {
        // Every port's label, in one list - the reason you type a description at all. The label was
        // stored, dumped and pasted back, and could only ever be read one port at a time.
        const pick = this._portArg(tokens.slice(2), dev, 'show interfaces description');
        if (!pick.ok) return out.concat(pick.output);
        const rows = [];
        let labelled = 0;
        for (const i of dev.interfaces.values()) {
          if (pick.port && i.name !== pick.port) continue;
          const st = this._ifaceState(i);
          if (i.description) labelled++;
          rows.push([i.name, st.status, st.protocol, i.description || '']);
        }
        out.push('Interfaces on ' + (dev.name || dev.id) + ' (' + rows.length + '):');
        out.push.apply(out, renderTable(['Interface', 'Status', 'Protocol', 'Description'], rows));
        if (!labelled) {
          out.push('');
          out.push('  (no port on this device has a description - '
            + 'set one with "description <text>" in interface mode)');
        }
        return out;
      }
      if (ifSub === 'counters') {
        // `errors` is the word an operator adds when a link is flapping, and this model keeps no
        // error counters - so say that, rather than reading the word as a port named `errors`.
        const cw = String(tokens[2] || '').toLowerCase();
        if (['errors', 'detail', 'discards'].indexOf(cw) !== -1) {
          return ['% No per-port error counters are kept: this model drops frames by name instead',
            '% Each drop is an event with its reason (mtu, acl, port-security, no-cable), so:',
            '%   show interfaces counters            packets, bytes and drops per port',
            '%   show interfaces <port>              the drops on one port, in words'];
        }
        // This used to be refused with a pointer to a command that had no counters in it. It is a
        // command now, and the pointer is gone because it is no longer needed.
        const pick = this._portArg(tokens.slice(2), dev, 'show interfaces counters');
        if (!pick.ok) return out.concat(pick.output);
        return out.concat(this._showCounters(dev, pick.port));
      }
      if (tokens[1] !== undefined) {
        // `show interfaces vlan 20` is how an SVI is asked about on a real switch; the model names the
        // interface `Vlan20` and the two-word spelling was read as a port called `vlan`.
        if (String(tokens[1]).toLowerCase() === 'vlan' && /^\d+$/.test(String(tokens[2] || ''))) {
          const svi = dev.interfaces.get('Vlan' + tokens[2]) || dev.interfaces.get('VLAN' + tokens[2]) ||
            dev.interfaces.get('vlan' + tokens[2]);
          if (svi) {
            only = svi.name;
            tokens = [tokens[0], tokens[1] + ' ' + tokens[2]].concat(tokens.slice(3));
          }
        } else {
          only = resolvePortName(dev, tokens[1]);
        }
        if (!only && String(tokens[1] || '').toLowerCase() === 'switchport') {
          // `show interfaces switchport` is the whole switch's L2 state in one answer, and the model
          // had the per-port block already. Refusing the family form meant a 24-port switch was
          // twenty-four commands, or a script.
          if (tokens.length > 3) {
            return ['% Unexpected argument "' + tokens.slice(3).join(' ') +
              '" - show interfaces switchport [<port>] takes one port at most',
              '% Usage: show interfaces switchport [<port>]'];
          }
          if (!dev.isL2()) {
            return ['% ' + dev.name + ' does not switch: its ports are routed, so none of them has a',
              '% switchport state. A tag on a routed port is a subinterface - "show ip interface brief"'];
          }
          const named = tokens[2] === undefined ? null : resolvePortName(dev, tokens[2]);
          if (tokens[2] !== undefined && !named) {
            return ['% No interface named ' + tokens[2] + ' on ' + dev.name,
              '% Try "show ip interface brief" for the ports this device has'];
          }
          const phys = Array.from(dev.interfaces.values()).filter(function (i) {
            return !i.svi && !i.parent;
          }).filter(function (i) { return !named || i.name === named; })
            .sort(function (a, b) { return String(a.name).localeCompare(String(b.name)); });
          if (named && !phys.length) {
            return ['% ' + named + ' is a logical interface: it has no switchport state',
              '% Ask for the physical port it belongs to'];
          }
          const blocks = [];
          for (const p of phys) {
            if (blocks.length) blocks.push('');
            blocks.push.apply(blocks, this._showPortSwitchport(dev, p));
          }
          return out.concat(blocks);
        }
        if (!only) {
          // A word that looks like an IOS subcommand but is not a port reads as a typo otherwise:
          // `show interfaces counters` answered "No interface named counters", which is true and
          // sends the operator looking for a port by that name.
          // `switchport` is handled above (it is a keyword with its own view); the rest are words
          // this family does not have, and saying so beats "No interface named counters".
          if (INTERFACE_VIEWS_NOT_KEPT[String(tokens[1]).toLowerCase()]) {
            return INTERFACE_VIEWS_NOT_KEPT[String(tokens[1]).toLowerCase()];
          }
          const KNOWN_SUB = ['counters', 'status', 'summary', 'brief', 'description'];
          if (KNOWN_SUB.indexOf(String(tokens[1]).toLowerCase()) !== -1) {
            // One sentence for every word of this family, and it names the three tables that do
            // answer - including `show interfaces <port> switchport`, which now exists.
            return [
              '% "show interfaces ' + tokens.slice(1).join(' ') + '" is not a command here',
              '% A port\'s L2 state is split across three tables:',
              '%   show interfaces status             connected/notconnect, VLAN, duplex, speed, type',
              '%   show interfaces <port>             counters, MTU, speed, duplex, drops, peer',
              '%   show interfaces <port> switchport  mode, access VLAN or trunking, port security',
              '% No per-port error counters are kept: a frame is dropped by name (mtu, acl, port-security)',
              '% and each drop is an event, so "show interfaces counters" totals them per port'];
          }
          return ['% No interface named ' + tokens[1] + ' on ' + (dev.name || dev.id),
            '% Try "show ip interface brief" for the ports this device has'];
        }
      }
      // `show interfaces <port> counters` is IOS's spelling for the same table narrowed to one port.
      // It was refused as an unknown argument while the family form answered the question.
      if (only && INTERFACE_VIEWS_NOT_KEPT[String(tokens[2] || '').toLowerCase()]) {
        return INTERFACE_VIEWS_NOT_KEPT[String(tokens[2] || '').toLowerCase()].slice();
      }
      if (only && String(tokens[2] || '').toLowerCase() === 'counters') {
        const extra = this._noExtra(tokens, 3, 'show interfaces <port> counters');
        if (extra) return out.concat(extra);
        return out.concat(this._showCounters(dev, only));
      }
      // `switchport` narrows the detail view to the L2 half of one port.
      if (only && String(tokens[2] || '').toLowerCase() === 'switchport') {
        const extra = this._noExtra(tokens, 3, 'show interfaces <port> switchport');
        if (extra) return out.concat(extra);
        const port = dev.interfaces.get(only);
        if (!port || port.svi || port.parent) {
          return ['% ' + only + ' is a logical interface: it has no switchport state',
            '% Ask for the physical port it belongs to'];
        }
        // The family form refused a non-switch and the per-port form invented a switchport state for
        // one: `show interfaces eth0 switchport` on a PC printed `Access Mode VLAN: 1` and
        // `Port Security: Disabled` for a port that switches nothing - the word `switchport` was
        // dropped and the plain port view answered. Same question, same refusal.
        if (typeof dev.isL2 === 'function' && !dev.isL2()) {
          return ['% ' + (dev.name || dev.id) + ' does not switch: its ports are routed, so ' + only,
            '% has no switchport state. A tag on a routed port is a subinterface - ' +
              '"show ip interface brief"'];
        }
        return out.concat(this._showPortSwitchport(dev, port));
      }
      for (const i of dev.interfaces.values()) {
        if (only && i.name !== only) continue;
        out.push(i.name + ' (' + i.type + ', ' + i.speed + '), MAC ' + i.mac);
        out.push('  status: ' + this._ifaceState(i).status + (i.description ? ', desc: ' + i.description : ''));
        out.push('  ip: ' + (i.ip ? i.ip + '/' + net.prefixOf(i.mask) : 'unassigned') + (i.dhcp ? ' (dhcp)' : ''));
        // The physical settings an operator asks about when a link is suspect. Each one is a value the
        // model actually uses (MTU for the data path, speed for the spanning-tree cost), and the
        // `(default)` marker separates what was configured from what was inherited.
        if (!i.parent && !i.svi) {
          out.push('  MTU ' + (i.mtu || 1500) + ' bytes' + (i.mtuConfigured ? ' (configured)' : ' (default)') +
            ', duplex ' + (i.duplex || 'auto') + (i.duplexConfigured ? ' (configured)' : ' (default)') +
            ', speed ' + i.speed + (i.speedConfigured ? ' (configured)' : ' (negotiated)'));
        }
        if (i.parent) {
          // A subinterface has no socket either: the facts worth printing are which parent carries
          // it, which tag it stamps, and whether that parent can carry anything at all.
          const st = this._ifaceState(i);
          out.push('  parent: ' + i.parent + ', dot1q ' + (i.encapVid === null ? '(none)' : i.encapVid));
          out.push('  line protocol: ' + (st.protocol === 'up' ? 'up' : 'down (' + st.reason + ')'));
          if (this.sim) {
            const st2 = this.sim.portStats(dev.id, i.name);
            out.push('  input : ' + plural(st2.rx, 'packet') + ', ' + plural(st2.rxBytes, 'byte'));
            out.push('  output: ' + plural(st2.tx, 'packet') + ', ' + plural(st2.txBytes, 'byte'));
            out.push('  drops : ' + st2.drops);
          }
          continue;
        }
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
      if (!pick.ok) {
        // `show startup-config zzzz` is not a request for a port called zzzz - the port comes after
        // the literal `interface`. Answering "No interface named zzzz" sent the operator looking for
        // a port by that name when the mistake was the command's shape.
        if (tokens.length > 1 && String(tokens[1]).toLowerCase() !== 'interface') {
          return out.concat(['% "' + tokens.slice(1).join(' ') + '" is not an argument to "show startup-config"',
            '% It takes one port, written `show startup-config interface <port>`, or nothing at all']);
        }
        return out.concat(pick.output);
      }
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
      // Commands this model deliberately does not have, answered with the equivalent here rather
      // than `% Invalid show command`. Every one of these is a line from a real lab guide, so the
      // operator typed it in good faith and deserves to be told what this console answers instead.
      if (String(tokens[0] || '').toLowerCase() === 'history') {
        const extra = this._noExtra(tokens, 1, 'show history');
        if (extra) return out.concat(extra);
        return out.concat(this._showHistory());
      }
      const absent = this._absentShow(tokens);
      if (absent) return out.concat(absent);
      // `show` with nothing after it is a truncated command, not an invalid one - and it certainly is
      // not "% Invalid show command: (empty)", which printed the model's own empty-string artifact at
      // an operator who had typed a real word. IOS calls this an incomplete command and lists what
      // can follow; the completion list is exactly that list.
      if (!tokens.length) {
        // The words `show` takes, read from the same page `show ?` reads - so the answer and the
        // question can never disagree about the list.
        const after = [];
        for (const row of this._helpForms(MODE_ENABLE)) {
          const t = row.tokens || row;
          if (String(t[0] || '').toLowerCase() !== 'show') continue;
          if (typeof t[1] === 'string' && after.indexOf(t[1]) === -1) after.push(t[1]);
        }
        out.push('% Incomplete command.');
        out.push('% "show" needs a word after it' +
          (after.length ? ' - it takes ' + after.slice(0, 8).join(', ') +
            (after.length > 8 ? ' and ' + (after.length - 8) + ' more' : '') : '') +
          ' ("show ?" lists them all)');
        return out;
      }
      out.push('% Invalid show command: ' + tokens.join(' '));
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
    // A device whose catalogue says it does not translate addresses has no table to print. It printed
    // an empty one - "NAT translations on D1:" and nothing under it - which reads as a NAT box on which
    // nothing has happened yet. (The rules are topology-level, which is why the view exists everywhere;
    // the *device* still has to be able to hold them.)
    // The table is printed even on a device whose catalogue says it does not translate: that decision
    // is deliberate (see nat-show) - a view that answers "no translations yet, and here is the command
    // that writes a rule" is a better answer than a refusal, because the rule may come from the
    // topology and this is where an operator looks for it.
    const table = this.sim ? this.sim._natTableOf(dev) : natLib.createNatTable();
    const rules = Array.isArray(table.rules) ? table.rules : [];
    const translations = Array.isArray(table.translations) ? table.translations : [];

    if (what === 'statistics') {
      if (!rules.length) {
        return ['NAT statistics on ' + dev.name + ':',
          '  (no rules - add one with "ip nat inside source static <local> <global>"',
          '   or "ip nat inside source list <acl> interface <outside-port> overload")'];
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
      if (rules.length) {
        out.push('  (none yet - ' + rules.length + ' rule' + (rules.length === 1 ? '' : 's') +
          ' configured, but no traffic has been translated)');
      } else {
        // The old sentence sent the operator to the topology editor. A console that can write the
        // rule now says how, and what an empty table means when a rule *is* configured.
        out.push('  (none - no translations yet. A rule comes from "ip nat inside source …",');
        out.push('   and an entry appears here the first time a packet is translated)');
      }
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
      return ['% Usage: flow open <dst> [port <n>] [bytes <n>] [proto tcp|udp] [sport <n>]',
        '%        flow close <flow-id>',
        '%        show flows   (to read the table)'];
    }

    const args = tokens.slice(1);
    const dest = this._requireDest(args, 'flow open <dst> [port <n>] [bytes <n>] [proto tcp|udp]');
    if (!dest.ok) return [dest.message];
    const typedDst = dest.value;
    const resolved = this._resolveHost(typedDst, 'destination');
    if (!resolved.ok) return resolved.hint ? [resolved.message, resolved.hint] : [resolved.message];
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
          '% Usage: flow open <dst> [port <n>] [bytes <n>] [proto tcp|udp] [sport <n>] [at <ms>]'];
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
    // An id has a shape: `flow-3` as the list prints it, or the bare number for an operator who read
    // the table and typed the figure. `flow close abc` used to answer `% no such flow: abc`, which is
    // the answer to "is there a flow called abc" - a question nobody asked, in lower case unlike
    // every other refusal, hiding the typo behind a lookup that could never succeed.
    const shaped = this._flowId(id);
    if (!shaped) {
      return ['% Invalid flow id "' + id + '" - ids look like "flow-3" or "3" (see "show flows")'];
    }
    const res = this.sim.closeFlow(shaped);
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
    let wantTypes = false;
    const seenTypes = this._loggingTypes(events);
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === 'summary') {
        summary = true;
      } else if (a === 'last') {
        // Digits, not "whatever Number() accepts": `last 0x10` and `last 1e3` were both taken as a
        // count, so a typo shaped like a number quietly chose how much of the log to show. The
        // message claims a whole number of events, so the check is the spelling of one.
        const typed = String(args[i + 1] === undefined ? '' : args[i + 1]);
        i++;                                   // consume the value, as the old `args[++i]` did
        lastN = Number(typed);
        if (!/^\d+$/.test(typed) || !Number.isFinite(lastN) || lastN <= 0 ||
            Math.floor(lastN) !== lastN) {
          return ['% show logging last <n> takes a positive whole number of events' +
            (typed ? ' (got "' + typed + '")' : '')];
        }
      } else if (a === 'device' || a === 'dev') {
        const wanted = args[++i];
        if (wanted === undefined) return ['% show logging device <name> needs a device name'];
        const found = this._deviceByName(wanted);
        if (!found) {
          // A name that matches nothing is answered with the names that do, as every other refusal
          // here is: a lab of twenty devices should not require a second command to spell one.
          const have = this.topo && this.topo.devices ? Array.from(this.topo.devices.values())
            .map(function (d) { return d.name; }).sort() : [];
          return ['% No device named "' + wanted + '"',
            '% Devices in this lab: ' + (have.length ? have.join(', ') : '(none)')];
        }
        deviceName = found.name;
      } else if (a === 'types') {
        // The vocabulary, not the log: `show logging types` is the command to run *before* anything
        // has happened, and the empty-log branch below answered it with "nothing of any type".
        wantTypes = true;
      } else if (a[0] === '-') {
        return ['% Unknown option "' + a + '"'];
      } else if (type === null) {
        // A bare word is an event type: `show logging drop` is the common case.
        // `all` means no filter - it is what the bare command already does, and an operator who
        // types it is asking for the whole log, not for a type called "all".
        if (a === 'all') { type = null; continue; }
        // The type vocabulary is the log itself: a type exists here when an event of it has
        // happened. That is honest, and it means an empty log must not be dressed up as a filter:
        // "% No events of type "zzz"" with "Types seen: (none)" read like a type that exists and
        // is empty, so a typo and a quiet lab were indistinguishable.
        if (!events.length) {
          // An empty log answers a *filter* question and does not answer a *vocabulary* question: a
          // typo is still a typo in a lab where nothing has run yet, and the word only has to be
          // tested against the set. "nothing of any type" was the old answer to both.
          const known = require('./simulator').EVENT_TYPES || new Set();
          if (known.size && !known.has(a) &&
              !Array.from(known).some(function (t) { return t.indexOf(a) === 0; })) {
            return ['% "' + a + '" is not a type this console records, so no event of it can ever appear',
              '% "show logging types" lists the ' + known.size + ' types this console does record',
              '% The log is empty - nothing has run in this lab yet'];
          }
          const named = Array.from(known).filter(function (t) { return t.indexOf(a) === 0; });
          if (named.length === 1) {
            return ['% No event of type "' + named[0] +
              '" has happened here yet - it is a type this console records',
              '% The log is empty: nothing has run in this lab yet',
              '% Run something ("ping <addr>", a simulation step) and this fills up'];
          }
          return ['% The log is empty: nothing has run in this lab, so there is nothing of any type',
            '% Run something ("ping <addr>", a simulation step) and this fills up'];
        }
        const knownTypes = require('./simulator').EVENT_TYPES || new Set();
        if (seenTypes.indexOf(a) === -1) {
          // An unambiguous prefix of a type is that type, as keywords are everywhere else in this
          // console: `show logging dro` is `show logging drop`. The candidates are the types that
          // *can* happen as well as the ones that have, because `drop` is a real type in a quiet lab.
          const pool = seenTypes.concat(Array.from(knownTypes).filter(function (t) {
            return seenTypes.indexOf(t) === -1;
          }));
          const byPrefix = pool.filter(function (t) { return t.indexOf(a) === 0; });
          if (byPrefix.length === 1) {
            type = byPrefix[0];
            if (seenTypes.indexOf(type) === -1) {
              return ['% No event of type "' + type + '" has happened here yet - it is a type this console records',
                '% "show logging types" lists all ' + pool.length + ' of them, with what has happened'];
            }
            continue;
          }
          if (byPrefix.length > 1) {
            return ['% Ambiguous event type "' + a + '": ' + byPrefix.slice(0, 8).join(', ') +
              (byPrefix.length > 8 ? ', and ' + (byPrefix.length - 8) + ' more' : ''),
              '% "show logging types" lists them all'];
          }
          // The vocabulary is known, so this answer is a fact rather than a shrug: a word outside it
          // can never happen, and a word inside it has simply not happened yet. The old sentence
          // said "either a type that has not happened yet or a typo", which told the operator
          // nothing they could act on.
          if (!knownTypes.has(a)) {
            const all = Array.from(knownTypes).sort();
            const near = all.filter(function (t) { return t.indexOf(a.slice(0, 2)) === 0; }).slice(0, 6);
            return ['% "' + a + '" is not a type this console records, so no event of it can ever appear',
              '% "show logging types" lists the ' + all.length + ' types this console does record',
              '% Types with events so far: ' + (seenTypes.length ? seenTypes.join(', ') : '(none yet)')]
              .concat(near.length ? ['% Closest: ' + near.join(', ')] : []);
          }
          return ['% No event of type "' + a + '" has happened here yet - it is a type this console records',
            '% "show logging types" lists all ' + knownTypes.size + ' of them, with what has happened'];
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

    // The vocabulary, and what of it has happened here. A refusal cannot carry sixty type names, and
    // this is the question it was trying to answer: which words does this console know?
    if (wantTypes) {
      const known = Array.from(require('./simulator').EVENT_TYPES || []).sort();
      if (!known.length) return ['% This console records no event types'];
      const out = ['Event types this console records (' + known.length + '), and how many have happened here:'];
      out.push.apply(out, renderTable(['Type', 'Events'], known.map(function (t) {
        const n = events.filter(function (e) { return e.type === t; }).length;
        return [t, n ? String(n) : '-'];
      }), 2));
      const quiet = known.filter(function (t) {
        return !events.some(function (e) { return e.type === t; });
      }).length;
      out.push('');
      if (!events.length) {
        out.push('The log is empty, so every count is `-` - the vocabulary above is what this console');
        out.push('can record, which is a fact about the console and not about the lab. Send a packet');
        out.push('(`ping <dst>`) or run `converge`, then ask again.');
        return out;
      }
      out.push(quiet + ' of ' + known.length + ' have not happened in this lab yet - a `-` is a type');
      out.push('this console can record, not a typo. `show logging <type>` filters to one.');
      return out;
    }

    // `show logging summary last 3` printed "Event summary (67 of 67 events)" - the `last` was parsed
    // and then dropped on this branch. A summary of the last three events is a real question (what has
    // just happened, grouped), so it narrows here too and the header says which window it covers.
    if (summary) {
      const windowed = lastN !== null && lastN < rows.length ? rows.slice(-lastN) : rows;
      return this._loggingSummary(events, windowed, {
        type: type, deviceName: deviceName, lastN: lastN, ofTotal: rows.length
      });
    }

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
    // Three numbers, and each answers a different question: how many the summary covers, how many the
    // filters left, and how many the lab has recorded.
    const windowed = filter.lastN !== null && filter.ofTotal !== undefined &&
      filter.lastN < filter.ofTotal;
    out.push(windowed
      ? 'Event summary (last ' + filter.lastN + ' of ' + events.length + ' events):'
      : 'Event summary (' + rows.length + ' of ' + events.length + ' events):');
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
      const extra = this._noExtra(tokens, 1, 'show flows counters');
      if (extra) return extra;
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
      const extra = this._noExtra(tokens, 1, 'show flows <id>');
      if (extra) return extra;
      // The same id rule as `flow close`, so the two doors cannot disagree about what `3` means.
      const key = this._flowId(tokens[0]);
      if (!key) {
        return ['% Invalid flow id "' + tokens[0] + '" - ids look like "flow-3" or "3"',
          '% Try: show flows (for the list) or show flows counters'];
      }
      const rec = records.filter(function (r) { return String(r.id).toLowerCase() === key; })[0];
      if (!rec) {
        return ['% No flow ' + key + ' in this lab',
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
  // `renew dhcp [<port>]` and `release dhcp [<port>]` - the two verbs of the DHCP client.
  //
  // `ip address dhcp` and `show ip dhcp binding` existed, so a lease could be watched but never
  // renewed or given back: both verbs answered `% Unrecognized command`. A lease that cannot be
  // released is a lease an operator cannot test the pool with, and "the address is stuck" has no
  // answer in the console. Releasing writes both tables - the client's address and the server's
  // binding - in one call, because two commands that each write one table can disagree.
  _dhcpClientVerb(verb, tokens) {
    const dev = this.device;
    const usage = verb + ' dhcp [<port>]';
    const extra = this._noExtra(tokens, 1, usage);
    if (extra) return extra;
    const typed = tokens.length ? String(tokens[0]) : null;
    const pick = typed ? this._portArg(tokens, dev, usage) : { ok: true, port: null };
    if (!pick.ok) return pick.output;
    const clients = [];
    for (const i of dev.interfaces.values()) {
      if (pick.port && i.name !== pick.port) continue;
      if (i.dhcp) clients.push(i);
    }
    if (!clients.length) {
      if (pick.port) {
        return ['% ' + pick.port + ' is not a DHCP client - it has no "ip address dhcp" configured',
          '% "show ip interface brief" lists the Method column (DHCP or manual) for every port'];
      }
      return ['% ' + (dev.name || dev.id) + ' has no DHCP client interfaces',
        '% Configure one with "ip address dhcp" in an interface block'];
    }
    if (!this.sim) return ['% Simulator not attached'];
    // Both verbs are about a lease, so the exchange that produces one has to have happened before
    // either can be answered: `release dhcp` as the first command of a session reported "already
    // released" for a client that was about to be handed an address.
    this.sim.refreshControlPlanes({ dhcp: true });
    const out = [];
    for (const i of clients) {
      if (verb === 'release') {
        const had = i.dhcpLease;
        const res = this.sim.releaseDhcpLease(dev.id, i.name);
        // Stay released. The lease pass runs on every refresh, so without this flag the address would
        // be handed straight back and the command would be a no-op with a success message.
        i.dhcpReleased = true;
        if (!res) {
          out.push('DHCP lease on ' + i.name + ' was already released - the port holds no address');
          continue;
        }
        out.push('Released DHCP lease on ' + i.name + ' (was ' + res.ip + ')');
        if (res.forgotten) {
          out.push('  the server forgot the binding (' + res.forgotten + ' table' +
            (res.forgotten === 1 ? '' : 's') + ' updated)');
        } else if (had && had.from) {
          out.push('  no server binding to clear - the lease came from ' + had.from);
        }
        continue;
      }
      // renew: force the exchange rather than answering "still valid". A renewal asked for by hand
      // is an instruction, not a question, so the client asks the server even inside T1.
      const before = i.dhcpLease ? i.dhcpLease.ip : null;
      i.dhcpReleased = false;
      i.dhcpForceRenew = true;
      this.sim.refreshControlPlanes({ force: true });
      i.dhcpForceRenew = false;
      if (!i.dhcpLease) {
        out.push('% No DHCP server answered on ' + i.name + ' - it holds no address' +
          (before ? ' (the previous lease ' + before + ' is gone)' : ''));
        continue;
      }
      const held = i.dhcpLease;
      out.push('Renewed DHCP lease on ' + i.name + ': ' + held.ip +
        (held.leaseSec ? ' (lease ' + held.leaseSec + 's)' : ''));
      if (before && before !== held.ip) out.push('  note: the server handed out a different address');
    }
    return out;
  }

  // `show ip dhcp server statistics` answers with the counters this model actually keeps, and works
  // before the first lease exists - a server with no bindings still has pools, reservations and a
  // history of zero exchanges, and that is a real answer.
  // `show ip traffic` in IOS is a protocol breakdown. What this model counts is per port: frames and
  // bytes each way, and drops with the reason. So the view prints those totals and says plainly that
  // there is no per-protocol breakdown - a table of zeroed ICMP/TCP/UDP rows would be a claim about a
  // measurement nobody took. The per-port table answers the same question with more detail.
  _showIpTraffic() {
    const dev = this.device;
    const rows = this.sim ? this.sim.portStats(dev.id) : [];
    const sum = function (k) {
      return rows.reduce(function (n, r) { return n + (Number(r[k]) || 0); }, 0);
    };
    const out = [];
    const live = rows.filter(function (r) { return (r.rx || 0) + (r.tx || 0) + (r.drops || 0) > 0; });
    if (!live.length) {
      return ['% ' + dev.name + ' has carried no traffic since this lab started',
        '% Counters are per port - "show interfaces counters" lists them, "show interfaces <port>" one of them'];
    }
    out.push('Traffic through ' + dev.name + ' (per-port totals, all ports):');
    out.push('  Received     ' + sum('rx') + ' packets, ' + sum('rxBytes') + ' bytes');
    out.push('  Sent         ' + sum('tx') + ' packets, ' + sum('txBytes') + ' bytes');
    out.push('  Dropped      ' + sum('drops') + ' packets');
    const byReason = {};
    for (const r of rows) {
      for (const k of Object.keys(r.reasons || {})) byReason[k] = (byReason[k] || 0) + r.reasons[k];
    }
    for (const k of Object.keys(byReason).sort()) out.push('    ' + pad(k, 18) + byReason[k]);
    out.push('');
    out.push('What is not counted: a per-protocol breakdown (ICMP/TCP/UDP/ARP totals). This model counts');
    out.push('frames per port, so "show interfaces counters" is the same numbers with the ports kept apart.');
    return out;
  }

  // The trunk table, in the order IOS prints it: the port facts first, then what is allowed on the
  // trunk, then what is allowed *and* active (a VLAN somebody allowed but never created is not
  // active), then what the spanning tree is forwarding. Each section is derived from the same
  // records the rest of the model reads, so the answer cannot disagree with `show vlan` or with the
  // running configuration.
  _showInterfacesTrunk(only) {
    const dev = this.device;
    const out = [];
    if (!dev.isL2()) {
      return ['% ' + dev.name + ' does not switch: it has no trunk ports, and every port is routed',
        '% A tag on a routed port is a subinterface - "show ip interface brief" lists them'];
    }
    let want = null;
    if (only !== undefined && only !== null && String(only) !== '') {
      // The port argument goes through the same resolver the config parser uses, so an unknown word
      // is refused as an unknown *port* rather than reported as "not a trunk port" - which reads as
      // though the port exists and is simply misconfigured.
      const pick = this._portArg([String(only)], dev, 'show interfaces trunk');
      if (!pick.ok) return pick.output;
      want = pick.port || null;
      if (!want) {
        const ports = Array.from(dev.interfaces.values()).filter(function (i) { return !i.svi; })
          .map(function (i) { return i.name; });
        return ['% No interface named ' + only + ' on ' + dev.name,
          '% This device has: ' + ports.join(', ')];
      }
    }
    const ports = Array.from(dev.interfaces.values()).filter(function (i) {
      if (i.svi) return false;
      const v = i.vlan || {};
      return String(v.mode || '').toLowerCase() === 'trunk' && i.enabled !== false;
    }).filter(function (i) { return !want || i.name === want; })
      .sort(function (a, b) { return String(a.name).localeCompare(String(b.name)); });
    if (!ports.length) {
      return [(want ? '% ' + want + ' is not a trunk port' : '% No trunk ports on ' + dev.name),
        '% Ports with "switchport mode trunk" are listed here, one row per port, with the VLANs',
        '% allowed on it and the VLANs the spanning tree is forwarding'];
    }
    const declared = function (id) {
      const v = (dev.config.vlans || {})[id];
      return v !== undefined && v !== null;
    };
    const vlanList = function (i) {
      const v = i.vlan || {};
      const all = v.allowedVlans === 'all' || !Array.isArray(v.allowedVlans);
      if (all) {
        const ids = Object.keys(dev.config.vlans || {}).map(Number).filter(function (n) { return n > 0; });
        return { all: true, ids: ids.sort(function (a, b) { return a - b; }) };
      }
      return { all: false, ids: v.allowedVlans.slice().sort(function (a, b) { return a - b; }) };
    };
    const label = function (l) {
      const ids = l.ids;
      if (!ids.length) return 'none';
      if (l.all && ids.length > 6) return ids[0] + '-' + ids[ids.length - 1] + ' (all declared)';
      return ids.join(',');
    };
    const rows1 = ports.map(function (i) {
      const v = i.vlan || {};
      const st = this._ifaceState ? this._ifaceState(i) : { status: 'up' };
      return [i.name, 'on', '802.1q', st.status === 'up' ? 'trunking' : 'not-trunking',
        String(Number(v.nativeVlan) || 1)];
    }, this);
    out.push.apply(out, renderTable(['Port', 'Mode', 'Encapsulation', 'Status', 'Native vlan'], rows1));
    out.push('');
    out.push('Port      Vlans allowed on trunk');
    const active = function (i) {
      const l = vlanList(i);
      const ids = l.ids.filter(declared);
      const allowed = Array.from(dev.interfaces.values()).map(function (x) {
        const v = x.vlan || {};
        const set = [];
        if (String(v.mode || '').toLowerCase() === 'trunk') {
          if (v.allowedVlans === 'all' || !Array.isArray(v.allowedVlans)) set.push('ALL');
          else set.push.apply(set, v.allowedVlans);
        } else if (Number(v.accessVlan)) set.push(Number(v.accessVlan));
        return set;
      });
      const carried = ids.filter(function (id) {
        return allowed.some(function (s) { return s === 'ALL' || s.indexOf(id) !== -1; });
      });
      return { allowed: ids, carried: carried };
    };
    for (const i of ports) {
      const l = vlanList(i);
      out.push(pad(i.name, 10) + label(l));
    }
    out.push('');
    out.push('Port      Vlans allowed and active in management domain');
    for (const i of ports) out.push(pad(i.name, 10) + (active(i).allowed.join(',') || 'none'));
    out.push('');
    out.push('Port      Vlans in spanning tree forwarding state and not pruned');
    for (const i of ports) out.push(pad(i.name, 10) + (active(i).carried.join(',') || 'none'));
    // A port configured as a trunk with no link would not appear in this table on a real switch, and
    // its absence reads as "my configuration did not take". It is listed, and the reason it is not
    // trunking is spelled out rather than left as a word with no explanation.
    const down = ports.filter(function (i) {
      const st = this._ifaceState ? this._ifaceState(i) : { status: 'up' };
      return st.status !== 'up';
    }, this);
    if (down.length) {
      out.push('');
      out.push('% ' + down.map(function (i) { return i.name; }).join(', ') +
        ' is configured as a trunk but has no link - it will trunk when a cable arrives');
    }
    // A trunk with nothing allowed is a port that will drop every tagged frame, and that is the
    // usual reason somebody is reading this table.
    const empty = ports.filter(function (i) {
      const a = active(i);
      return !a.allowed.length || !a.carried.length;
    });
    if (empty.length) {
      out.push('');
      out.push('% ' + empty.map(function (i) { return i.name; }).join(', ') +
        ' carr' + (empty.length === 1 ? 'ies' : 'y') + ' no VLAN the spanning tree forwards:');
      out.push('% "show vlan" lists the VLANs that exist, and "show running-config" the allowed list');
    }
    return out;
  }

  // `show hosts` is the resolver's own view: the default domain, the servers it will ask, and the
  // names it has answered for. This console had `ip domain-name` and `ip name-server` accepted and
  // resolved names on `ping`, but the command answered `% Invalid show command: hosts` - so the one
  // place an operator checks "did that name resolve, and to what" did not exist.
  _showHosts() {
    const dev = this.device;
    const out = [];
    const cfg = dev.config || {};
    const domain = cfg.domainName || cfg.domain || null;
    const servers = (cfg.dnsServers || cfg.nameServers || []).slice();
    // The durable list, not the event log: a command may rebuild the log while it runs.
    const store = this.sim && Array.isArray(this.sim.dnsLookups) ? this.sim.dnsLookups
      : (this.sim && Array.isArray(this.sim.events) ? this.sim.events : []);
    const lookups = store.filter(function (e) {
      return e && e.type === 'dns' && e.dev === dev.id;
    });
    const newest = new Map();
    for (const e of lookups) {
      const prev = newest.get(e.qname);
      if (!prev || (e.step || 0) >= (prev.step || 0)) newest.set(e.qname, e);
    }
    out.push('Default domain is ' + (domain || '(none - an unqualified name is asked as typed)'));
    out.push('Name lookup is ' + (cfg.domainLookup === false ? 'disabled' : 'enabled') +
      (cfg.domainLookup === false ? ' ("ip domain-lookup" turns it back on)' : ''));
    out.push('Name servers are ' + (servers.length ? servers.join(', ')
      : '(none - "ip name-server <address>" names one)'));
    if (!newest.size) {
      out.push('');
      out.push('No name has been resolved here since this lab started');
      out.push('A "ping <name>" asks the servers above and records the answer here');
      return out;
    }
    out.push('');
    const now = this.sim && typeof this.sim.step === 'number' ? this.sim.step : 0;
    const rows = [];
    const names = Array.from(newest.keys()).sort();
    for (const name of names) {
      const e = newest.get(name);
      const age = Math.max(0, now - (e.step || 0));
      const ageText = age === 0 ? 'now' : (age < 60 ? age + 's' : Math.round(age / 60) + 'm');
      rows.push([name, e.ok ? (e.address || '-') : 'unresolved', e.ok ? 'dynamic' : 'failed', ageText]);
    }
    out.push.apply(out, renderTable(['Host', 'Address', 'Type', 'Age'], rows));
    const failedRows = [];
    for (const name of names) {
      const e = newest.get(name);
      if (!e.ok) failedRows.push([name, e]);
    }
    if (failedRows.length) {
      out.push('');
      // The reason belongs on the row that failed, not one table away: "unresolved" says a lookup
      // failed, not whether the name is missing (NXDOMAIN), present with no address (NODATA), or
      // never asked of anyone (no server hosts the zone). Those are three different fixes.
      for (const pair of failedRows) {
        out.push('% ' + pair[0] + ' did not resolve - ' + (pair[1].reason || 'no answer recorded'));
      }
      out.push('% The full record of each lookup is in "show logging" (type dns)');
    }
    return out;
  }

  _showDhcpStatistics(pools) {
    const dev = this.device;
    const out = [];
    // A device that is not a server has nothing to count, and a table of zeros reads as "a server
    // that has heard nothing" rather than "not a server at all".
    if (!pools.length && !dev.hasCap('dhcp-server')) {
      return ['% ' + dev.name + ' is not a DHCP server - it has no pools, no bindings and no ' +
        'statistics to report'];
    }
    const mine = (this.sim && Array.isArray(this.sim.events) ? this.sim.events : []).filter(function (e) {
      return e && e.type === 'dhcp' && (e.server === dev.id || e.serverName === dev.name);
    });
    const count = function (ph) {
      return mine.filter(function (e) { return e.phase === ph; }).length;
    };
    const failed = mine.filter(function (e) { return e.phase === 'failed'; });
    const why = {};
    for (const f of failed) why[f.reason || 'other'] = (why[f.reason || 'other'] || 0) + 1;
    const live = this.sim ? this.sim.dhcpBindings(dev.id) : [];
    const manual = pools.reduce(function (n, p) { return n + Object.keys(p.reservations || {}).length; }, 0);
    const row = function (label, value) { out.push('  ' + pad(label, 24) + value); };
    out.push('DHCP server statistics on ' + dev.name + ':');
    row('Address pools', pools.length);
    row('Automatic bindings', live.length);
    row('Manual bindings', manual);
    row('Leases given', count('ack'));
    row('Leases renewed', count('renewed'));
    row('Leases expired', count('expired'));
    row('Requests failed', failed.length);
    for (const k of Object.keys(why).sort()) out.push('    ' + pad(k, 20) + why[k]);
    out.push('');
    // One event per completed exchange is what the simulator records. A stat view that printed
    // zeroed DHCPDISCOVER/DHCPOFFER rows would be answering about messages it never counts.
    out.push('One event is recorded per completed exchange, not per message: this model does not');
    out.push('count DHCPDISCOVER/DHCPOFFER/REQUEST individually, so the numbers above are exchanges.');
    return out;
  }

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

    if (what === 'statistics' || (what === 'server' && String(tokens[1] || '') === 'statistics')) {
      return this._showDhcpStatistics(pools);
    }

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
        // What the range says and what a client can be given are two things: the router's own address
        // and the server address are inside the range and are never leased. Saying so here keeps
        // "Range: 10.0.0.1 - 10.0.0.254" from reading as "a client may be given .1".
        {
          const withheld = [];
          // Containment in the *range*, not "could this be leased": the whole point is that these
          // addresses are inside the range and outside what a client may be given.
          const inRange = function (addr) {
            try {
              const n = net.ipToInt(addr);
              return n >= net.ipToInt(p.rangeStart) && n <= net.ipToInt(p.rangeEnd);
            } catch (e) { return false; }
          };
          if (p.gateway && inRange(p.gateway)) withheld.push(p.gateway + ' (this router)');
          if (p.server && p.server !== p.gateway && inRange(p.server)) withheld.push(p.server + ' (the server)');
          if (withheld.length) out.push('    Not leased : ' + withheld.join(', '));
        }
        if (p.dns && p.dns.length) out.push('    DNS        : ' + p.dns.join(', '));
        if (Number.isFinite(Number(p.leaseSec)) && p.leaseSec) out.push('    Lease      : ' + p.leaseSec + 's');
        if (p.excluded && p.excluded.length) {
          // Entries are `low-high` strings from the console and {start,end} from a normalized pool.
          // Printed raw, the view said "[object Object], [object Object]" - a range nobody could read.
          out.push('    Excluded   : ' + p.excluded.map(function (r) {
            if (typeof r === 'string') return r;
            if (r && r.start && r.end) return r.start === r.end ? r.start : r.start + '-' + r.end;
            return String(r);
          }).join(', '));
        }
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

    if (what === 'snooping') {
      // A switch was answered with a usage line naming `show ip dhcp binding` and `show ip dhcp pool`
      // - two views of a DHCP *server*, on a device that cannot be one. The honest answer is that
      // snooping is not modelled, what the switch does instead, and which views do exist here.
      return [
        '% DHCP snooping is not modelled: a switch here forwards DHCP as an ordinary broadcast, and',
        '% nothing inspects, filters or rate-limits DHCP messages per port.',
        '% There is no trust state to show and no binding table to read - "show mac address-table"',
        '% answers which port a client is on, and "show ip dhcp binding" exists only on a server.'
      ];
    }

    if (what !== 'binding' && what !== 'bindings' && what !== 'lease' && what !== 'leases') {
      return ['% Usage: show ip dhcp binding | show ip dhcp pool | show ip dhcp server statistics'];
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
  // What an address *is*, when it is not a host address a wire could hold. One classifier for every
  // command that takes a peer address, so `ip route`, `ip helper-address` and `ip default-gateway`
  // refuse the same four classes in the same words - four commands used to accept them separately,
  // each promise ("Route added", "requests will be relayed to it", "Default gateway") impossible.
  _addressClass(addr) {
    const net = require('./net');
    let aInt = null;
    try { aInt = net.ipToInt(String(addr)); } catch (e) { return null; }
    if (aInt === 0) return 'the zero address (this host on this network)';
    if (aInt === 0xffffffff) return 'the limited broadcast address (every host on this wire)';
    if (aInt >= 0xe0000000 && aInt < 0xf0000000) return 'a multicast group address (class D)';
    if (aInt >= 0xf0000000) return 'a reserved address (class E)';
    if ((aInt >>> 24) === 127) return 'a loopback address (this host, always)';
    return null;
  }

  _helperAddress(args, iface) {
    const addr = args[0];
    if (addr === undefined) return ['% Incomplete command: ip helper-address <addr>'];
    // One address per line: `ip helper-address 10.0.0.1 zzzz` added the relay and dropped the word.
    if (args[1] !== undefined) {
      return ['% Unexpected argument "' + args[1] + '" - ip helper-address <addr> takes one address',
        '% A second server is a second line: repeat "ip helper-address <addr>"'];
    }
    if (!this._isIpv4(addr)) return ['% Invalid helper address "' + addr + '"'];
    // A relay sends a *unicast* to one server. Every one of these was accepted with "DHCP requests
    // will be relayed to it": 0.0.0.0 (this host on this network), 255.255.255.255 (every host on
    // this wire), 224.0.0.0/4 (a multicast group) and 127.0.0.0/8 (this host, always) - four
    // addresses that cannot answer, each of which would have been a relay that silently relayed
    // nothing. The class is named, because the fix differs: point it at a server address.
    const kind = this._addressClass(addr);
    if (kind) {
      return ['% ' + addr + ' is ' + kind + ', so nothing can answer a relayed request sent to it',
        '% A helper target is one unicast address: the server that will answer'];
    }
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
        // A value slot has values, and this device's are knowable: `interface Gi?` is the question
        // "which ports start with Gi", and answering "nothing starts with Gi" while the device is
        // holding three of them is the answer of a console that has not looked.
        const values = this._valueCompletions(wide, at, partial);
        if (values.length) {
          const outv = ['Completions for "' + typedStem + ' ' + partial + '" (' + values.length +
            ', completing "' + partial + '" from this device):'];
          const vlanStem = /\bvlan$/i.test(typedStem);
          outv.push.apply(outv, renderTable(['Value', 'What it is'], values.map(function (v) {
            return [v, vlanStem ? this._vlanMeaning(v) : this._portMeaning(v)];
          }.bind(this)), 2));
          return outv;
        }
        const why = this._explainMissingHelp(prefix, partial);
        const out = ['% Nothing after "' + typedStem + '" starts with "' + partial + '"' +
          (why ? ' on ' + (this.device.name || this.device.id) : '')];
        if (why) out.push('% ' + why);
        out.push('% Ask ? on its own for the words that can follow it',
          '% To write a literal "?" instead of asking, end the line with \\?');
        return out;
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
      const whyTrailing = this._explainMissingHelp(words, '');
      return ['% No completions for "' + typed + '"' +
        (whyTrailing ? ' on ' + (this.device.name || this.device.id) : ''),
        whyTrailing || '% Type ? on its own for every command this mode accepts',
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
      const tail = ['"' + typed + '" is as far as this command goes - nothing follows it',
        '% To complete the word you are typing, put the ? against it: "' + typed + '?"'];
      // ...but a pipe does follow it, and this page is the only place an operator would look for it.
      // A completion list that says "nothing follows" about a view whose output is filterable is
      // true about the command and wrong about the line.
      if (this._pipeable(typed)) {
        tail.push('');
        tail.push('The answer can be filtered - a pipe follows it:');
        tail.push.apply(tail, this._pipeLegend());
      }
      return tail;
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
        const hints = this._valueHintLines(survivors, words.length);
        if (hints.length) {
          out.push('');
          out.push.apply(out, hints);
        }
        out.push('');
        out.push('Names in angle brackets are values: type one, then ask ? again for what follows it.');
      }
      return out;
    }
    out.push.apply(out, renderTable(['Next', 'Meaning'], labels.map(function (label) {
      return [label, seen.get(label) || ''];
    }), 2));
    if (labels.some(function (l) { return l[0] === '<'; })) {
      const hints = this._valueHintLines(survivors, words.length);
      if (hints.length) {
        out.push('');
        out.push.apply(out, hints);
      }
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

  // The same parse, over the *unfiltered* page: for the callers that ask "is this command documented
  // anywhere?" rather than "would this device be shown it?" - the docs sweep, the `no`-form audit and
  // the help-coverage suite all ask the first question.
  _helpFormRowsAll(mode) {
    if (!this._helpRowCacheAll) this._helpRowCacheAll = new Map();
    if (this._helpRowCacheAll.has(mode)) return this._helpRowCacheAll.get(mode);
    const saved = this.mode;
    this.mode = mode;
    let rows;
    try {
      rows = this._helpPage();
    } finally {
      this.mode = saved;
    }
    const parsed = require('./abbrev').parseFormsWithDesc(rows);
    this._helpRowCacheAll.set(mode, parsed);
    return parsed;
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

  // What a VLAN id means as a choice: whether it has an SVI (and its address) or exists as a VLAN only.
  _vlanMeaning(id) {
    const dev = this.device || {};
    const svi = dev.interfaces ? dev.interfaces.get('Vlan' + id) : null;
    const exists = dev.vlans && (dev.vlans.get ? dev.vlans.get(Number(id)) : dev.vlans[Number(id)]);
    if (svi && svi.ip) {
      const len = String(svi.mask || '').split('.').reduce(function (n, o) {
        let v = parseInt(o, 10) || 0, c = 0;
        while (v) { c += v & 1; v >>= 1; }
        return n + c;
      }, 0);
      return 'SVI ' + svi.ip + (svi.mask ? '/' + len : '');
    }
    if (svi) return 'an SVI with no address';
    if (exists || svi) return 'a VLAN here, no SVI yet';
    return 'a VLAN with no name yet - "interface vlan ' + id + '" creates it';
  }

  // One line saying what a port is, for the value list. The list is a choice, so the second column has
  // to help make it: a name repeated back is a table with one column.
  _portMeaning(name) {
    const i = this.device && this.device.interfaces ? this.device.interfaces.get(name) : null;
    if (!i) return '';
    const bits = [];
    if (i.svi) bits.push('the switch address for VLAN ' + (i.vlanId || i.svi));
    else if (i.parent) bits.push('tag ' + (i.encapVid || '?') + ' on ' + i.parent);
    else if (i.vlan && i.vlan.mode === 'trunk') bits.push('trunk');
    else if (i.vlan && Number(i.vlan.accessVlan) > 1) bits.push('access VLAN ' + i.vlan.accessVlan);
    else if (i.ip) {
      const len = String(i.mask || '').split('.').reduce(function (n, octet) {
        let v = parseInt(octet, 10) || 0, c = 0;
        while (v) { c += v & 1; v >>= 1; }
        return n + c;
      }, 0);
      bits.push('routed ' + i.ip + (i.mask ? '/' + len : ''));
    }
    else if (this.device.isL2 && this.device.isL2()) bits.push('switchport, VLAN ' + Number((i.vlan && i.vlan.accessVlan) || 1));
    else bits.push('port');
    const down = (i.enabled === false || i.adminUp === false);
    const line = (i.lineUp === false || down);
    bits.push((down ? 'shut' : (line ? 'down' : 'up')));
    if (i.speed) bits.push(String(i.speed));
    return bits.join(', ');
  }

  // The values a device can put in a value slot, for the one slot whose values this console knows:
  // an interface name. `interface Gi?` lists the ports that start with Gi; any other placeholder
  // (`<dest>`, `<mac>`, `<id>`) is answered as before, because there is no list to read.
  // What kind of value a slot takes, decided by the slot's own name and by the word before it. One
  // place, because the attached form (`Fa0/?`) and the detached form (`show interfaces ?`) must agree
  // about what a slot means - they are the same question asked two ways.
  _valueKind(rows, at) {
    const tokOf = function (row) {
      const t = row.tokens[at];
      return t && typeof t === 'object' ? String(t.placeholder || '') : '';
    };
    const prevOf = function (row) { return String(row.tokens[at - 1] || '').toLowerCase(); };
    const any = function (test) {
      return (rows || []).some(function (r) { return test(tokOf(r), prevOf(r)); });
    };
    // `interface vlan <id>` is answered with the SVIs the device already has; every other `… vlan <id>`
    // (`show spanning-tree vlan <id>`, `show vlan <id>`, `no vlan <id>`) is answered with the VLAN ids
    // the device actually carries. One word, two kinds of value - the verb settles it.
    const ifaceVlan = any(function (ph, prev) { return /^id$/i.test(ph) && prev === 'vlan'; }) &&
      (rows || []).every(function (r) { return String(r.tokens[0] || '').toLowerCase() === 'interface'; });
    if (ifaceVlan) return 'svi';
    if (any(function (ph, prev) { return /^id$/i.test(ph) && prev === 'vlan'; })) return 'vlanid';
    // `show logging device <name>` takes a device, and `name` is otherwise a port slot - the word
    // before the slot is what settles it.
    if (any(function (ph, prev) { return /^(name|id)$/i.test(ph) && prev === 'device'; })) return 'device';
    if (any(function (ph, prev) { return /^name$/i.test(ph) && prev === 'pool'; })) return 'pool';
    if (any(function (ph, prev) { return /^name$/i.test(ph) && /^access-lists?$/.test(prev); })) return 'acl';
    if (any(function (ph, prev) { return /^type$/i.test(ph) && prev === 'logging'; })) return 'type';
    if (any(function (ph, prev) { return /^id$/i.test(ph) && /^(vlan|spanning-tree)$/.test(prev); })) return 'vlanid';
    // `show vlan name <name>` takes the name of a VLAN. `name` is otherwise a port slot, so this had
    // offered the device's *ports* as VLAN names - a value list for a different question.
    // The slot sits two words after `vlan` (`show vlan name <name>`), not one - the keyword in
    // between is `name`, so the test that mattered was whether `vlan` comes before it.
    const prev2Of = function (row) { return String(row.tokens[at - 2] || '').toLowerCase(); };
    if ((rows || []).some(function (r) {
      return /^name$/i.test(tokOf(r)) && prevOf(r) === 'name' && prev2Of(r) === 'vlan';
    })) return 'vlanname';
    // `show interfaces transceiver <port>` takes a module bay, not a data port: it listed the
    // device's ports, and every one of them was refused with "No transceiver port named eth0 on D1
    // (module bays: sfp1, sfp2)" - the console knew the answer and the hint did not ask for it.
    if ((rows || []).some(function (r) {
      return r.tokens.some(function (t) { return String(t).toLowerCase() === 'transceiver'; });
    })) return 'bay';
    if (any(function (ph) { return /^(name|port|interface|iface)$/i.test(ph); })) return 'port';
    return null;
  }

  // The values this device has for a kind of slot. A console that answers "nothing starts with G" for
  // a device holding three Gigabit ports has not looked; these are the answers it can look up.
  _valuesFor(kind, partial) {
    const dev = this.device || {};
    const want = String(partial || '').toLowerCase();
    const take = function (list, cap) {
      const out = [];
      for (const v of list) {
        const s = String(v);
        if (want && s.toLowerCase().indexOf(want) !== 0) continue;
        out.push(s);
        if (out.length >= cap) break;
      }
      return out;
    };
    if (kind === 'svi' || kind === 'vlanid') {
      const ids = new Set();
      for (const name of (dev.interfaces ? dev.interfaces.keys() : [])) {
        const m = /^[Vv]lan(\d+)$/.exec(name);
        if (m) ids.add(Number(m[1]));
      }
      if (kind === 'vlanid') {
        for (const id of Object.keys((dev.config && dev.config.vlans) || {})) ids.add(Number(id));
        // VLAN 1 exists on a device that bridges, and only there: the old list added it
        // unconditionally, so a router was offered `show vlan 1` and answered "No VLAN 1 on R1".
        if (typeof dev.isL2 === 'function' && dev.isL2()) {
          ids.add(1);
          for (const id of this._vlanMap(dev).keys()) if (id !== 'all') ids.add(Number(id));
        }
      }
      const out = Array.from(ids).filter(function (n) { return n > 0; }).sort(function (a, b) { return a - b; });
      return take(out, 24);
    }
    if (kind === 'vlanname') {
      // The names `show vlan name` matches are the declared ones - the same list its refusal prints.
      const names = (dev.config && dev.config.vlans) || {};
      const list = [];
      for (const k of Object.keys(names)) {
        const v = names[k];
        const n = typeof v === 'string' ? v : (v && v.name ? String(v.name) : '');
        if (n) list.push(n);
      }
      return take(list.sort(), 24);
    }
    if (kind === 'device') {
      const names = this.topo && this.topo.devices ? Array.from(this.topo.devices.values()) : [];
      return take(names.map(function (d) { return d.name || d.id; }).sort(), 24);
    }
    if (kind === 'pool') {
      const pools = (dev.config && dev.config.dhcpPools) || [];
      return take(pools.map(function (p) { return p.name; }).sort(), 24);
    }
    if (kind === 'acl') {
      return take(Object.keys((dev.config && dev.config.acls) || {}).sort(), 24);
    }
    if (kind === 'type') {
      return take(Array.from(require('./simulator').EVENT_TYPES || []).sort(), 12);
    }
    if (kind === 'bay') {
      const bays = [];
      for (const i of (dev.interfaces ? dev.interfaces.values() : [])) {
        if (this._isModuleBay(i)) bays.push(i.name);
      }
      return take(bays, 24);
    }
    if (kind === 'port') {
      return take(dev.interfaces ? Array.from(dev.interfaces.keys()) : [], 24);
    }
    return [];
  }

  _valueCompletions(rows, at, partial) {
    const kind = this._valueKind(rows, at);
    return kind ? this._valuesFor(kind, partial) : [];
  }

  // The line a value slot's `?` deserves: the values, named by what they are. `show logging device ?`
  // printed `Next: <name>` while the lab held three devices - the slot's name is not an answer a
  // console with a view of the topology can give.
  _valueHintLines(rows, at) {
    const kinds = new Map();
    for (const row of rows || []) {
      const t = row.tokens[at];
      if (!t || typeof t !== 'object') continue;
      const single = { tokens: row.tokens };
      const kind = this._valueKind([single], at);
      if (kind && !kinds.has(kind)) kinds.set(kind, []);
      if (kind) kinds.get(kind).push(single);
    }
    const LABEL = {
      svi: 'SVIs on this device', vlanid: 'VLANs on this device',
      vlanname: 'VLAN names on this device', device: 'Devices in this lab',
      pool: 'DHCP pools on this device', acl: 'Access lists on this device',
      type: 'Event types this console records', port: 'Ports on this device',
      bay: 'Module bays on this device'
    };
    const out = [];
    for (const kind of kinds.keys()) {
      const values = this._valuesFor(kind, '');
      if (!values.length) continue;
      const head = values.slice(0, 8).join(', ');
      const more = values.length > 8 ? ', ... (' + values.length + ' in all)' : '';
      out.push('  ' + (LABEL[kind] || 'Values') + ': ' + head + more);
    }
    return out;
  }

  // The output filters, and only these: the words IOS has, matched as plain case-insensitive text
  // rather than as a regular expression (this console says so rather than pretending to be grep).
  _pipeable(typed) {
    // Which commands print lines a pipe can filter. `show` is nearly all of it; the rest are the few
    // reads that print a report rather than a line (`ping`, `traceroute`) or a listing (`dir`, `more`).
    const head = String(typed || '').trim().split(/\s+/)[0].toLowerCase();
    if (head === 'show' || head === 'do') return true;
    return ['dir', 'more', 'ping', 'traceroute', 'write'].indexOf(head) !== -1;
  }

  _pipeLegend() {
    // The pipe is the filter an operator types on every third command, so the ? page has to answer
    // for it - and it has to answer the two questions that decide whether a filter is the right tool:
    // what it keeps, and whether the text is a regular expression (it is not, here).
    return ['  | include <text>   keep the lines containing <text>',
      '  | exclude <text>   everything except those lines',
      '  | begin <text>     from the first matching line to the end',
      '  | section <text>   each matching line and the lines indented under it (a stanza)',
      '  | count            one line: how many lines the view printed',
      '',
      '<text> is matched as plain text, case-insensitively - this console does not take regular',
      'expressions, and says so rather than pretending to be grep. Filters chain:',
      '  ' + '| include interface | count'.replace(/^/, 'show running-config ')];
  }

  _pipeHelp(main, pipes) {
    // `show running-config | include ?` asked what the filter's argument is. The ? was read as the
    // text to look for, so the answer was "nothing in this answer matches \"| include ?\"" - a
    // filter applied to the help character, which tells the operator nothing about either.
    //
    // A `?` against a partly typed filter word is the same question, narrowed: `| inc?` lists what
    // starts with `inc`, and `| include version | co?` answers about the second filter while naming
    // the first, because a chain is what the operator is building.
    const asked = pipes[pipes.length - 1] || '';
    const verbWord = String(asked).trim().split(/\s+/)[0].toLowerCase();
    const typed = verbWord.replace(/\?/g, '');
    const asking = verbWord.indexOf('?') !== -1;
    const before = pipes.slice(0, -1).filter(function (p) { return String(p).trim(); });
    const out = [];
    out.push('Filters for "' + String(main).trim() + '"'
      + (before.length ? ' (after | ' + before.join(' | ') + ')' : '') + ':');
    if (asking) {
      const fits = PIPE_FILTERS.filter(function (w) { return w.indexOf(typed) === 0; });
      if (!fits.length) {
        out.push('  % No filter starts with "' + typed + '" - this console has: ' +
          PIPE_FILTERS.join(', '));
        return out;
      }
      const legend = this._pipeLegend().filter(function (l) {
        const m = /^\s*\|\s*(\w+)/.exec(l);
        return m ? fits.indexOf(m[1]) !== -1 : false;
      });
      out.push.apply(out, legend.length ? legend : this._pipeLegend());
      const name = fits.length === 1 ? fits[0] : null;
      if (name === 'count') out.push('', '  | count takes no text - it counts the lines the view printed.');
      else if (name) {
        out.push('', '  | ' + name + ' takes the text to look for, e.g. ' + main.trim() +
          ' | ' + name + ' vlan');
      } else {
        out.push('', '  ' + fits.length + ' filters start with "' + typed + '" - keep typing, or ask again');
      }
      return out;
    }
    out.push.apply(out, this._pipeLegend());
    const name = PIPE_FILTERS.filter(function (w) { return w === verbWord || w.indexOf(verbWord) === 0; })[0];
    if (name === 'count') out.push('', '  | count takes no text - it counts the lines the view printed.');
    else if (name) {
      out.push('', '  | ' + name + ' takes the text to look for, e.g. ' + main.trim() + ' | ' + name + ' vlan');
    }
    return out;
  }

  _applyPipe(lines, pipe) {
    const m = /^(\w+)\s*(.*)$/.exec(String(pipe || '').trim());
    if (!m) return { error: '% A filter needs a word: "| include <text>", "| exclude <text>", "| begin <text>", "| section <text>" or "| count"' };
    // A filter name abbreviates like every other keyword in this console: `| c` is `| count` and
    // `| i route` is `| include route`. The five names were matched with ===, so a legitimate
    // abbreviation was refused by a sentence that then listed the five full words.
    let verb = m[1].toLowerCase();
    if (PIPE_FILTERS.indexOf(verb) === -1) {
      const fits = PIPE_FILTERS.filter(function (w) { return w.indexOf(verb) === 0; });
      if (fits.length > 1) {
        return { error: '% Ambiguous filter "| ' + m[1] + '" - it could be ' + fits.join(' or ') };
      }
      if (!fits.length) {
        return { error: '% There is no "| ' + m[1] + '" here - this console filters with include, exclude, begin, section and count' };
      }
      verb = fits[0];
    }
    const term = m[2].trim();
    const has = function (l) { return String(l).toLowerCase().indexOf(term.toLowerCase()) !== -1; };
    if (verb === 'count') {
      return { lines: [String(lines.length) + ' line' + (lines.length === 1 ? '' : 's')] };
    }
    // Reaching here means the verb resolved against PIPE_FILTERS: it is one of the four that take
    // text (`count` returned above), so there is nothing left to reject.
    if (!term) {
      return { error: '% "| ' + verb + '" needs a word to look for' };
    }
    if (verb === 'include') return { lines: lines.filter(has) };
    if (verb === 'exclude') return { lines: lines.filter(function (l) { return !has(l); }) };
    if (verb === 'begin') {
      const at = lines.findIndex(has);
      return { lines: at === -1 ? [] : lines.slice(at) };
    }
    // section: the matching line and everything indented under it, which is how a running-config is
    // laid out - `| section interface` is the stanza, not the one line.
    const kept = [];
    let inBlock = false;
    for (const l of lines) {
      if (has(l)) { kept.push(l); inBlock = true; continue; }
      if (inBlock && /^\s+\S/.test(l)) { kept.push(l); continue; }
      inBlock = false;
    }
    return { lines: kept };
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
    // `show <what>` defers to the exec tree for everything after `show`. The test is what `sh` can
    // stand for - a prefix of `show` - not "starts with sh", which also caught `shutdown` and
    // `switchport` and read them against the exec page, where neither exists.
    {
      const w0 = String(tokens[0] || '').toLowerCase();
      // `sh` inside a block is *two* words: `show` from the exec page and `shutdown` from this one.
      // The deferral above read it as `show` alone and answered "% Invalid show command: (empty)" -
      // an ambiguity reported as a broken command. Deferral is for a word that stands for `show` and
      // nothing else here; when this page has its own word with that prefix, the answer is ambiguous.
      if (w0 !== 'show' && w0.length >= 1 && w0.length < 4 && 'show'.indexOf(w0) === 0) {
        const own = [];
        const ownForms = this._helpForms(this.mode);
        for (const f of ownForms) {
          const first = String(f[0] || '').toLowerCase();
          if (first && first !== 'show' && first.indexOf(w0) === 0 && own.indexOf(first) === -1) own.push(first);
        }
        if (own.length) {
          return { ambiguous: w0, candidates: own.concat(['show']) };
        }
      }
      if (w0 === 'show' || (w0.length >= 2 && w0.length < 4 && 'show'.indexOf(w0) === 0)) {
        forms = this._helpForms(MODE_ENABLE);
      }
    }
    // A word that is already a complete command of the enclosing configuration is never abbreviated
    // into something else. `router ospf 1` typed inside `router ospf` mode was expanded to
    // `router-id ospf 1` - because `router` is a prefix of `router-id` *in that mode* - and then
    // refused with a message about `router-id`, which named a command the operator had not typed.
    if (!exec && this.mode !== MODE_CONFIG && tokens.length > 1) {
      // Only when the *whole line* reads as a configuration command: `ip add …` in interface mode
      // must still become `ip address …`, and that is the same first word.
      if (abbrev.readsAs(tokens, this._helpForms(MODE_CONFIG))) {
        // Leave the wording alone but not the spelling: `NO IP NAT INSIDE` typed in a block reached
        // the block's own handler as `IP`/`NAT`/`INSIDE` and was refused as unrecognized.
        // This block's own page first: it is the page the handler below reads, and a config form with
        // a placeholder in the same position would otherwise "match" and leave the block's keyword
        // un-respelled (`switchport PORT-SECURITY`).
        const respelt = abbrev.canonical(tokens, forms) ||
          abbrev.canonical(tokens, this._helpForms(MODE_CONFIG));
        // When neither page can spell the line back, the veto does not apply: the words only *look*
        // like a configuration command because `readsAs` matches by prefix. `sw p` and `l r` read as
        // configuration lines that way and are, in fact, this block's own commands abbreviated
        // (`switchport port-security`, `lldp receive`) - vetted here returned null, and the block
        // refused a spelling its `?` had just offered. `router ospf 1` in router mode is unaffected:
        // it *does* canonicalise against the config page, so it returns above.
        if (respelt) return { tokens: respelt };
      }
    }
    // Before expanding: a line already spelled as one of the forms is respelled to match it exactly.
    // `expand` respells only the words it had to *expand*, so `SWITCHPORT PORT-SECURITY` came back as
    // ['switchport','PORT-SECURITY'] and the block's own handler - which compares with `===` - refused
    // it as an unrecognized switchport command.
    // Expand first - that is the abbreviation (`sh ip int br`), and it must keep working - then
    // respell what expansion left behind. `expand` rewrites only the words it had to expand, so
    // `SHOW LOGGING SUMMARY` came back as ['show','logging','SUMMARY'] and the handler read
    // `SUMMARY` as an event type.
    let res = abbrev.expand(tokens, forms);
    // An ambiguity is the answer, and it comes back before any respelling: `li` is a prefix of both
    // `link` and `links`, and `canonical` below matched it against a row and returned it unchanged -
    // so the ambiguity was erased and the dispatcher answered "% Unrecognized command: li".
    if (res && res.ambiguous) return res;
    // The page this device shows is filtered by capability, so a word this device cannot use is
    // missing from it - and an abbreviation of a command the handler *answers* (with a refusal naming
    // the capability) stalled: `no ip nat inside` on a switch reached the handler as
    // `no ip n i`, because `nat` was not on that switch's page to expand against. The unfiltered
    // page is consulted as a second reading, and the reading that spells out more of the line wins.
    {
      const allForms = this._helpFormRowsAll(this.mode).map(function (r) { return r.tokens || r; });
      const wide = abbrev.expand(tokens, allForms);
      const spelled = function (r) {
        if (!r || !r.tokens) return -1;
        let n = 0;
        for (let i = 0; i < tokens.length; i++) {
          if (String(r.tokens[i]).toLowerCase() !== String(tokens[i]).toLowerCase()) n += 1;
        }
        return n;
      };
      if (wide && wide.tokens && spelled(wide) > spelled(res)) res = wide;
    }
    const arrived = res && res.tokens ? res.tokens : tokens;
    // The unfiltered page is consulted too: a verb the handler answers but this device's page filters
    // out (a switch has no NAT, yet `no ip nat inside` is answered with the reason) still has a
    // documented spelling, and `NO IP NAT INSIDE` must reach that handler as the words it knows.
    const respelt = abbrev.canonical(arrived, forms) ||
      abbrev.canonical(arrived, this._helpFormRowsAll(this.mode).map(function (r) { return r.tokens || r; }));
    if (respelt) return { tokens: respelt };
    return res;
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
  // `keywords` are the sub-words this particular command accepts besides a port (`summary`, `root`,
  // `count`, `dynamic`). They are only used to word the refusal: an operator who typed a real IOS
  // keyword and was told "no interface named summary" has been sent to look for a port that cannot
  // exist, which is worse than a plain "unknown word".
  _portArg(args, dev, what, keywords) {
    // The word `interface` in an argument position abbreviates like every other keyword on this
    // console, because the console abbreviates keywords by prefix everywhere else: `show run int
    // Gi0/0` answered "% show running-config takes one port, not \"int Gi0/0\"" - advice about the
    // port list, for a word that has exactly one continuation here and no port could spell.
    const isIface = function (a) {
      const s = String(a || '').toLowerCase();
      return s === 'interface' || (s.length >= 2 && 'interface'.startsWith(s));
    };
    const hadKeyword = (args || []).some(isIface);
    let rest = (args || []).filter(Boolean).filter(function (a) { return !isIface(a); });
    // A type word and its index split across two tokens - `interface GigabitEthernet 0/0` - is one
    // port name. Reading them separately answered "No interface named GigabitEthernet" and left the
    // index unread, which is the silent half of the same mistake.
    if (rest.length >= 2 && /^[A-Za-z][A-Za-z-]*$/.test(rest[0]) && /^\d[\d/]*(\.\d+)?$/.test(rest[1]) &&
        resolvePortName(dev, rest[0] + rest[1])) {
      rest = [rest[0] + rest[1]].concat(rest.slice(2));
    }
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
      // A word after the literal `interface` is unambiguously a port, so that refusal names the
      // missing port; only a bare word can be a keyword in the wrong place.
      const saidInterface = isIface(args[0]);
      if (keywords && keywords.length && !saidInterface) {
        return {
          ok: false,
          output: ['% ' + what + ' takes a port, or ' + keywords.join(' / ') + ' - not "' + rest[0] + '"',
            '% The ports this device has are in "show ip interface brief"']
        };
      }
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
      // The cable's state is not the port's. A run can be up while the socket it enters is
      // administratively down, and this line used to answer `(up)` from `link.state` alone: true
      // about the cable, and the one thing an operator chasing a dead port needed to be told here.
      const portNote = link ? this._portNotCarryingReason(i.name) : null;
      out.push('  link         : ' + (link
        ? link.id + ' -> ' + (function () {
          const far = link.a.deviceId === dev.id ? link.b : link.a;
          const farDev = topo.getDevice(far.deviceId);
          return (farDev ? farDev.name : far.deviceId) + '/' + far.iface;
        })() + ' (' + (link.state || 'up') + (portNote ? ', ' + portNote : '') + ')'
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
    // The table answers one question - what optic is in the socket, and does the run reach - and a
    // shut port still has an optic in it, so every number above stays true. But a reader who asks
    // this is usually chasing why nothing crosses, and a row that looks healthy on a socket nothing
    // can pass was the whole defect in `show lldp neighbors`. Uncabled ports are not listed: their
    // Verdict already reads "not cabled", which is the same fact in the row.
    const stuck = [];
    for (const i of ports) {
      if (!linkFor(i.name)) continue;
      const why = this._portNotCarryingReason(i.name);
      if (why) stuck.push('  ' + i.name + ': ' + why);
    }
    if (stuck.length) {
      out.push.apply(out, stuck);
      out.push('  The optic and the run are as above; those ports are why no frame crosses them.');
    }
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
      // Where a budget came from decides how much it can be trusted, so the line always says. A
      // derived budget is the standard's per-port limit times the copper ports, and it says so rather
      // than looking like a figure off a data sheet.
      const label = { spec: 'spec', research: 'research', name: 'model name', unknown: 'unknown' }[dev.poeBudgetSource] ||
        dev.poeBudgetSource;
      out.push('Power inline on ' + dev.name + ':');
      out.push('  Budget       : ' + rec.budget + ' W  (from ' + label + ')');
      out.push('  Used         : ' + round1(rec.used) + ' W');
      out.push('  Available    : ' + round1(Math.max(0, rec.budget - rec.used)) + ' W');
      const shown = only ? rec.ports.filter(function (x) { return x.iface === only; }) : rec.ports;
      // A port told `power inline never` with nothing plugged into it produced no row at all, because
      // the table was built from powered devices rather than from the ports. So the one state an
      // operator had just *configured* was the one the show could not display: the summary said
      // "(no powered device is attached)" and the decision was invisible.
      const withheld = Array.from(dev.interfaces.values()).filter(function (i) {
        return !i.svi && !i.parent && i.poeOut && i.poeAdmin === 'never' && i.name !== only;
      });
      if (!rec.ports.length && withheld.length) {
        out.push('  ' + pad('Port', 8) + pad('Admin', 8) + pad('Powered device', 22) +
          pad('Requested', 11) + 'Status');
        for (const i of withheld) {
          out.push('  ' + pad(i.name, 8) + pad('never', 8) + pad('-', 22) + pad('-', 11) +
            'off (administratively)');
        }
        out.push('  (no powered device is attached to the remaining ports)');
      } else if (!rec.ports.length) {
        out.push('  (no powered device is attached)');
      } else if (!shown.length) {
        // A port can be administratively without power and still cabled to a device; the filter has
        // to say which of those two it is, or `show power inline <port>` is silent about the port
        // the operator just changed.
        const ifaceRec = dev.interfaces.get(only);
        out.push('  ' + only + ': no powered device on this port' +
          (ifaceRec && ifaceRec.poeAdmin === 'never' ? ' (power inline never)' : ''));
      } else {
        out.push('  ' + pad('Port', 8) + pad('Admin', 8) + pad('Powered device', 22) +
          pad('Requested', 11) + 'Status');
        for (const p of shown) {
          const pd = sim.topo.getDevice(p.pd);
          const status = p.powered
            ? 'on'
            : (p.admin === 'never' ? 'off (administratively)' : 'denied (budget exhausted)');
          out.push('  ' + pad(p.iface, 8) + pad(p.admin || 'auto', 8) + pad(pd ? pd.name : p.pd, 22) +
            pad(p.draw + ' W', 11) + status);
        }
      }
    } else if (sourcing.length) {
      out.push('% ' + dev.name + ' has ' + sourcing.length + ' PoE-capable port(s) but no power budget, ' +
        'so none of them can source power');
    } else if (this._poeClaimWithoutPorts()) {
      // The device's catalogue entry and its port records disagree, and the show used to answer
      // "% POE1 neither sources nor draws PoE" - a statement about the device, when the fact is a gap
      // in the device's specification. An operator cannot fix this from the console, and should not
      // be sent looking for a fault in the box.
      out.push('% ' + dev.name + ' declares ' + this._poeClaimWithoutPorts() + ' in its catalogue entry,');
      out.push('% but no port record on it carries power-out - so there is nothing to switch on or off');
      out.push('% That is a gap in the device specification, not a state of the device');
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
      } else if (port.admin === 'never') {
        out.push('  ' + pad(i.name, 14) + port.draw + ' W from ' + where +
          ' - refused (the PSE port is administratively without power)');
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

    // A table is not a promise. `no ipv6 unicast-routing` leaves every row in place and stops the
    // forwarding, so the answer has to say so - otherwise the table reads as "this box will route
    // 2001:db8:2::/64" when it will drop it on the next packet.
    const routingOff = dev.config && dev.config.ip6Routing === false;
    const guard = routingOff
      ? ['! IPv6 unicast routing is DISABLED on this device - these routes are configured but no',
        '! packet is forwarded (ipv6 unicast-routing re-enables it)']
      : [];

    if (tokens.length) return guard.concat(this._routeLookup6(dev, tokens));

    const rows = dev.routes6Table();
    if (!rows.length) {
      out.push('% No IPv6 routes - no interface has a global address and none is configured');
      return out.concat(guard);
    }
    out.push.apply(out, guard);
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
    // `show ipv6 interface brief` is the one-line-per-port view, and `brief` is not a port name -
    // it used to be looked up as one and refused with "% No IPv6 port named brief on R1", which
    // reads as though the device has no such port rather than no such table.
    if (tokens.length && String(tokens[0]).toLowerCase() === 'brief') {
      const rest = tokens.slice(1);
      const pick = this._portArg(rest, dev, 'show ipv6 interface brief [<port>]');
      if (!pick.ok) return out.concat(pick.output);
      const addrs = dev.ip6Addrs();
      const rows = [];
      for (const i of dev.interfaces.values()) {
        if (pick.port && i.name !== pick.port) continue;
        if (!pick.port && this._isModuleBay(i)) continue;
        const mine = addrs.filter(function (a) { return a.name === i.name; });
        const st = this._ifaceState(i);
        if (!mine.length) rows.push([i.name, 'unassigned', st.status, st.protocol]);
        for (const a of mine) {
          rows.push([i.name, a.addr + '/' + a.prefix, st.status, st.protocol]);
        }
      }
      if (!rows.length) {
        return out.concat([pick.port
          ? '% No IPv6 port named ' + pick.port + ' on ' + (dev.name || dev.id)
          : '% No ports - this device has no interfaces']);
      }
      if (pick.port) out.push('Interface ' + pick.port + ' on ' + (dev.name || dev.id) + ':');
      out.push.apply(out, renderTable(['Interface', 'IP-Address', 'Status', 'Protocol'], rows));
      return out;
    }
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
      const state = this._ifaceState(i).status;
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
  // Why a verb family has no meaning on this device, or null if it has. One table, three readers:
  // the help page (which hides the row), the completion list (which explains the empty answer), and
  // the parser's own refusals quote the same facts.
  _helpRefusal(cmd) {
    const dev = this.device;
    // The interface page speaks for one interface, and a logical one (an SVI, a subinterface) has no
    // wire and no port: `speed`, `duplex`, `channel-group`, the `switchport` family, `port-security`
    // and `encapsulation dot1q` were all on the page for an SVI and all refused by the parser. A page
    // that offers a verb the parser refuses is the defect this filter exists to remove, so the page
    // follows the interface it is describing.
    if (this.mode === MODE_IFACE && this.iface && this.device.interfaces) {
      const cur = this.device.interfaces.get(this.iface);
      if (cur && (cur.svi || cur.parent)) {
        const w = String(cmd).toLowerCase().replace(/\|/g, ' ').trim().split(/\s+/);
        const logical = cur.svi
          ? 'it is an SVI - the VLAN\'s own address, not a member of it, and it has no wire'
          : 'it is a subinterface - a tag on a parent port, with no wire of its own';
        if (w.indexOf('port-security') !== -1) {
          return 'port security applies to a physical port, and ' + logical;
        }
        if (w.indexOf('switchport') !== -1) {
          return 'it is not a switchport (' + logical + ') - configure the member ports';
        }
        // The removal half is the same verb one word later, and it was left on the page after the
        // positive form was hidden - `no speed` and `no channel-group` are refused by the same gate
        // as `speed` and `channel-group`, so they leave with them.
        const verb = w[0] === 'no' ? (w[1] || '') : w[0];
        if (verb === 'speed' || verb === 'duplex') {
          return 'speed and duplex are properties of a wire, and ' + logical;
        }
        if (verb === 'channel-group') {
          return 'a LAG bundles physical ports, and ' + logical;
        }
        if (verb === 'encapsulation' && cur.svi) {
          return 'encapsulation dot1q belongs to a subinterface, and this is the VLAN address itself';
        }
      }
    }
    const words = String(cmd).toLowerCase().replace(/\|/g, ' ').trim().split(/\s+/);
    const l2 = typeof dev.isL2 === 'function' && dev.isL2();
    const l3 = typeof dev.isL3 === 'function' && dev.isL3();
    const has = function (c) { return typeof dev.hasCap === 'function' && dev.hasCap(c); };
    const first = words[0], second = words[1] || '';
    const switches = 'it does not switch, so no port on it has a switchport';
    const bridged = 'it runs no spanning tree, because it has no bridged domain to protect';
    const routes = 'it does not forward between interfaces, so it has no routes or adjacencies';
    // Switching: a VLAN, a port's L2 mode, the spanning tree over it.
    if (first === 'vlan' || (first === 'no' && second === 'vlan')) {
      return this._canDeclareVlan() ? null : 'it neither switches nor routes, so it has no VLANs';
    }
    if (first === 'spanning-tree' || (first === 'no' && second === 'spanning-tree')) {
      return l2 ? null : bridged;
    }
    // The `show` views that describe a bridge are bridge views: a host is not offered them, and
    // asking for one anyway explains what the device is (that refusal is the `show` handler's).
    if (first === 'show' && second) {
      // `show interfaces <port> switchport` is the L2 view of one port, so it goes with them.
      if (second === 'interfaces' && words.indexOf('switchport') !== -1) return l2 ? null : switches;
      if (['vlan', 'spanning-tree', 'port-security', 'etherchannel', 'mac'].indexOf(second) !== -1) {
        if (second === 'vlan') return this._canDeclareVlan() ? null : 'it neither switches nor routes, so it has no VLANs';
        return l2 ? null : switches;
      }
      // The NAT views answer on every device (see nat-show): an empty table with the command that
      // writes a rule is the documented answer, so the page offers them everywhere the handler answers.
      if (second === 'ip' && (words[2] === 'bgp' || words[2] === 'ospf')) return l3 ? null : routes;
    }
    if (first === 'switchport' ||
      (first === 'clear' && second === 'mac') || (first === 'clear' && second === 'port-security')) {
      return l2 ? null : switches;
    }
    if (first === 'interface' && (second === 'vlan' || second === '<parent>.<vlan>')) {
      return l2 ? null : switches;
    }
    if (first === 'no' && second === 'interface' && words[2] === '<parent>.<vlan>') {
      return l2 ? null : switches;
    }
    // Routing between interfaces.
    if (first === 'ip' && (second === 'routing' || second === 'route')) return l3 ? null : routes;
    if (first === 'no' && second === 'ip' && (words[2] === 'routing' || words[2] === 'route')) {
      return l3 ? null : routes;
    }
    if (first === 'router' && (second === 'ospf' || second === 'bgp')) return l3 ? null : routes;
    if (first === 'no' && second === 'router') return l3 ? null : routes;
    if (first === 'neighbor' || first === 'bgp') return l3 ? null : routes;
    // Per-interface verbs follow the interface-mode dispatcher, not the config one: a channel-group
    // bundles switch ports, a PoE verb needs a port that sources power, and the OSPF verbs need a
    // device that runs OSPF at all.
    if (first === 'no' && second === 'interface' && words[2] === 'vlan') {
      return this._canDeclareVlan() ? null : 'it is a host: it has no VLANs and no address on one';
    }
    if (first === 'channel-group' || (first === 'no' && second === 'channel-group')) {
      return l2 ? null : 'it does not switch, so it has no switch ports to bundle';
    }
    // Any row that names a switchport is a switch row, including the `no` forms: a PC was offered
    // `no switchport port-security` while the positive form was filtered, so the page listed a
    // removal for a setting the device could never have had.
    if (words.indexOf('switchport') !== -1) return l2 ? null : switches;
    if ((first === 'power' && second === 'inline') || (first === 'no' && second === 'power' && words[2] === 'inline')) {
      let sources = false;
      for (const i of dev.interfaces.values()) if (i.poeOut || (i.hardware && i.hardware.poeOut)) { sources = true; break; }
      return sources ? null : 'no port on it sources PoE, so there is no power to switch on or off';
    }
    if (first === 'ip' && second === 'ospf') return l3 ? null : 'no routing protocol runs on its interfaces';
    if (first === 'ospf' || (first === 'no' && second === 'ospf')) {
      return l3 ? null : 'it is not a router, so no routing protocol can run on it';
    }
    // BGP verbs, and the removals that pair with them: a switch was shown `no bgp neighbor <ip>` and
    // `no neighbor <ip>` while `router bgp` itself was filtered out - the removal of a process it
    // cannot start.
    // The test was `words.indexOf('bgp') !== -1`, which is true of any row that merely *offers* bgp
    // as one of several words: `show ip route [<dest>|connected|static|ospf|bgp|summary]` on a switch
    // was hidden with "it cannot run BGP" - the wrong reason, about a verb the operator had not
    // typed, for a row that starts with `show ip route`. A row is a BGP verb when BGP is the verb.
    // `show ip route` is never gated: every device in this model keeps a route table, and the view
    // answers on all of them - a switch prints its `ip default-gateway` route, a host prints an empty
    // table. Hiding it behind the layer-3 test told an operator the view did not exist while the
    // parser was answering it one line later.
    if (first === 'show' && second === 'ip' && words[2] === 'route') return null;
    const bgpVerb = first === 'bgp' ||
      (first === 'no' && (second === 'bgp' || second === 'neighbor')) ||
      (first === 'router' && second === 'bgp');
    if (bgpVerb) {
      return l3 ? null : 'it is a layer 2 switch, so it cannot run BGP';
    }
    if (first === 'no' && second === 'ip' && words[2] === 'ospf') {
      return l3 ? null : 'no routing protocol runs on its interfaces';
    }
    // Address translation and address service.
    // The NAT *views* answer on every device - an empty table plus the command that writes a rule is
    // the documented answer (nat-show), because a rule may come from the topology and this is where an
    // operator looks for it. The NAT *role* is a different question, and the handler asks the
    // capability itself, right after it has refused a device that does not route.
    // IPv6 routing and router advertisement need a device that forwards IPv6. Nineteen rows - `ipv6
    // unicast-routing` and every `ipv6 nd ra …` form - were offered on a camera, an ONT and an optical
    // shelf, each refused on the next line. `ipv6 address` is not one of them: a host has addresses.
    // `ipv6 route` is deliberately not in this list: a host here carries its way out as a route
    // (`ip route 0.0.0.0 0.0.0.0 <gw>`, and the IPv6 equivalent), the same decision IPv4 keeps.
    if ((first === 'ipv6' && ['unicast-routing', 'nd', 'router'].indexOf(second) !== -1) ||
        (first === 'no' && second === 'ipv6' &&
          ['unicast-routing', 'nd', 'router'].indexOf(words[2]) !== -1)) {
      const forwards = typeof dev.hasCap === 'function' ? dev.hasCap('l3-forward') : false;
      return forwards ? null : 'it does not forward IPv6, so it can neither route it nor advertise a prefix';
    }
    if (first === 'ip' && second === 'nat' && words[2] !== undefined &&
        words[2] !== 'translations' && words[2] !== 'statistics') {
      return has('nat') ? null : 'it does not translate addresses';
    }
    // `no ip nat inside|outside` and `clear ip nat translation` are answered on every device too: the
    // first says there is no role to remove (naming the capability in the note), the second says the
    // table was already empty. Both are refusals, and both are answers.
    // The removal of a NAT *rule* is not: `no ip nat inside source …` was shown on a switch and a PC
    // while the positive form was hidden - the same "removal of a setting the device cannot have" that
    // `no ip dhcp pool` had.
    if (first === 'no' && second === 'ip' && words[2] === 'nat' &&
        (words[4] === 'source' || words[3] === 'inside' || words[3] === 'outside')) {
      return has('nat') ? null : 'it does not translate addresses';
    }

    // The `no` half is the same capability: a host was still shown `no ip dhcp pool <name>` - a removal
    // for a pool it could never have had.
    if ((first === 'ip' && second === 'dhcp') ||
        (first === 'no' && second === 'ip' && words[2] === 'dhcp')) {
      return has('dhcp-server') ? null : 'it is not a DHCP server';
    }
    // ACLs, VRRP and IPv6 are not filtered, deliberately: the parser accepts them on anything that
    // takes a config line - a generic router has no `acl`, `vrrp` or `ipv6` capability tag and does
    // all three - so hiding them would hide working commands. The gate is the parser's, not the
    // catalogue's: help may only hide a family the parser actually refuses.
    return null;
  }

  _helpApplies(cmd) {
    return this._helpRefusal(cmd) === null;
  }

  // A completion that finds nothing used to say only that nothing matched, which reads like a typo
  // even when the word is a command on another device. When the *unfiltered* page has a row for what
  // was typed, say which row and why it is not here.
  _explainMissingHelp(stemWords, partial) {
    if (!stemWords.length) return null;
    const saved = this.mode;
    let all = [];
    try {
      all = this._helpPage ? this._helpPage() : [];
    } finally {
      this.mode = saved;
    }
    const want = stemWords.map(function (w) { return String(w).toLowerCase(); });
    for (const line of all) {
      if (!/^ {2}\S/.test(line)) continue;
      const synopsis = line.trim().split(/\s{2,}/)[0];
      const row = synopsis.toLowerCase().split(/\s+/);
      let ok = true;
      for (let i = 0; i < want.length; i++) {
        if (row[i] !== want[i]) { ok = false; break; }
      }
      if (!ok) continue;
      const next = row[want.length] || '';
      if (partial && next.indexOf(String(partial).toLowerCase()) !== 0) continue;
      const why = this._helpRefusal(synopsis);
      if (!why) continue;
      return '"' + synopsis + '" is a command here, but not on ' + (this.device.name || this.device.id) +
        ': ' + why;
    }
    return null;
  }

  // The page an operator sees, after the capability filter. Rows are strings (some of them two lines
  // when the synopsis is long), so the synopsis is recovered the way a reader recovers it: the first
  // run of text before the column gap.
  _help() {
    return this._helpShown(this._helpPage());
  }

  _helpShown(lines) {
    const out = [];
    let keep = true;
    for (const line of lines) {
      if (/^ {45}\S/.test(line)) { if (keep) out.push(line); continue; }
      if (/^ {2}\S/.test(line)) {
        keep = this._helpApplies(line.trim().split(/\s{2,}/)[0]);
        if (keep) out.push(line);
        continue;
      }
      keep = true;
      out.push(line);
    }
    return out;
  }

  _helpPage() {
    if (this.mode === MODE_CONFIG) return helpRows([
      'Config-mode commands (exit / end to leave):',
      helpLine('hostname <name>', 'set device hostname (spaces kept)'),
      helpLine('no hostname', 'back to the default name for this model'),
      helpLine('arp <ip> <mac> [arpa]', 'pin one address to a MAC - never ages out, cannot be overwritten'),
      helpLine('no arp <ip>', 'remove one ARP entry (static or learned)'),
      helpLine('ip domain-name <name>', 'suffix an unqualified name gets before it is looked up'),
      helpLine('no ip domain-name [<name>]', 'ask an unqualified name exactly as typed'),
      helpLine('ip domain-lookup', 'resolve names again (on by default)'),
      helpLine('no ip domain-lookup', 'refuse names; an address still works'),
      helpLine('lldp run', 'enable LLDP on this device (it is on by default)'),
      helpLine('no lldp run', 'stop announcing and listening; the neighbour table is forgotten'),
      helpLine('interface <name> | int <name>', 'enter interface configuration'),
      helpLine('interface vlan <id>', 'the switch\'s own address in that VLAN (an SVI)'),
      helpLine('interface <parent>.<vlan>', 'creates a tagged subinterface'),
      helpLine('vlan <id> [name]', 'declare a VLAN'),
      // The `no` half of every verb is a command in its own right, and `?` could not see any of them:
      // `no vlan ?` and `no ip nat ?` answered "No completions for …", so removal was the one part of
      // the command set an operator had to already know. Each row is the form the parser accepts.
      helpLine('no vlan <id>', 'remove a VLAN no port is still in'),
      helpLine('no interface <name> | no interface <parent>.<vlan>', 'remove a subinterface'),
      helpLine('no interface vlan <id>', 'remove this switch\'s own address on that VLAN (the VLAN stays)'),
      helpLine('ip nat inside source static <local> <global>', 'one-to-one translation'),
      helpLine('ip nat inside source list <acl> interface <if> overload', 'PAT onto an interface address'),
      helpLine('no ip nat inside source static <local> <global>', 'remove one static rule'),
      helpLine('no ip nat inside source list <acl> interface <if> overload', 'remove one PAT rule'),
      helpLine('no ip nat inside source', 'list the rules this device has'),
      helpLine('ip access-list standard|extended <name>', 'build a named access list, entry by entry'),
      // `<permit|deny ...>` put a literal `...` in a keyword position, so `?` offered a word that is
      // not a word. The part that varies is a value, and values are spelled as placeholders.
      helpLine('access-list <n> permit|deny <entry>', 'one line of a numbered list'),
      helpLine('no ip access-list <name>', 'remove a named list and its bindings'),
      helpLine('spanning-tree vlan <id> priority <n>', 'choose the root bridge'),
      helpLine('spanning-tree vlan <id> root primary|secondary', 'ask to be root, in words'),
      helpLine('no spanning-tree vlan <id> [priority <n> | root primary|secondary]',
        'forget this VLAN\'s priority and go back to the default'),
      helpLine('ip route <dest> <mask> <gw> [iface]', 'add a static route'),
      helpLine('no ip route <dest> <mask> [gw]', 'remove one, or all with that prefix'),
      helpLine('ip default-gateway <gw>', 'default gateway for hosts'),
      helpLine('no ip default-gateway [<gw>]', 'clear it'),
      helpLine('ip dhcp pool <name>', 'create/enter a DHCP pool'),
      helpLine('no ip dhcp pool <name>', 'remove the whole pool, and say which leases it was serving'),
      helpLine('ip name-server <ip>', 'DNS resolver for this device'),
      helpLine('no ip name-server [<ip>]', 'forget one resolver, or all of them'),
      helpLine('router bgp <as>', 'enable BGP'),
      helpLine('bgp router-id <ip> | bgp neighbor <ip> remote-as <as>',
        'BGP identity and peers'),
      helpLine('no bgp neighbor <ip> | no neighbor <ip>', 'stop peering with one address'),
      helpLine('no router bgp [<as>]', 'turn BGP off and drop every peer'),
      helpLine('switchport <verb>', 'per interface (mode, access vlan, port-security) - enter an interface first'),
      helpLine('ip routing | no ip routing', 'forward between this device\'s interfaces, or stop forwarding'),
      helpLine('router ospf <process-id>', 'start OSPF and enter router mode, where "network … area …" lives'),
      helpLine('no router ospf', 'remove the OSPF process and its routes'),
      helpLine('ospf router-id <ip> | ospf area <id>', 'enable OSPF'),
      helpLine('no ospf', 'turn OSPF off'),
      helpLine('no ospf router-id [<ip>] | no ospf area [<id>]', 'forget the id, or the area it is in'),
      helpLine('no dns zone <name>', 'remove a zone, and report the records it takes with it'),
      helpLine('no dns add <name> [type]', 'remove one name\'s records, or only one type\'s'),
      helpLine('dns zone <name> | dns add <name> <type> <value>',
        'serve a zone, or add a record to one'),
      helpLine('scion <isd-as>', 'join a SCION ISD-AS'),
      helpLine('no scion', 'leave it'),
      helpLine('ipv6 unicast-routing | no ipv6 unicast-routing',
        'whether this device forwards IPv6 it is not the destination of'),
      helpLine('ipv6 route <prefix> <next-hop>', 'static IPv6 route - prefix written address/length'),
      helpLine('ipv6 gateway <addr>', 'the IPv6 default gateway'),
      helpLine('no ipv6 route <prefix> [<next-hop>]',
        'remove one IPv6 route, by prefix or by prefix and next hop'),
      helpLine('no ipv6 gateway [<addr>]', 'clear the IPv6 default gateway'),
      helpLine('no ipv6 unicast-routing', 'stop forwarding IPv6 for other devices'),
      helpLine('ipv6 nd ra enable|disable|managed|other-config',
        'what this router advertises'),
      helpLine('ipv6 nd ra lifetime <s>', 'how often it advertises'),
      helpLine('ipv6 nd prefix <prefix>/<len> [valid <s>] [preferred <s>]',
        'a prefix to advertise (SLAAC)'),
      helpLine('ipv6 nd suppress-ra', 'stop advertising on this port'),
      helpLine('no ipv6 nd suppress-ra', 'start advertising again'),
      helpLine('access-list <1-2699> permit|deny <entry>', 'add an entry'),
      helpLine('no access-list <1-2699> [<entry>]', 'remove one entry, or the whole list'),
      // One row per form, so every word of the command is documented and completable here too - the
      // rows exist to say *where* the command lives, not to change its syntax. A single `vrrp
      // <vrid> ...` row covered both but put a literal `...` in a keyword position, which `?` then
      // offered as if it were a word.
      helpLine('vrrp <vrid> ip <addr>', 'per-interface - enter an interface first'),
      helpLine('vrrp <vrid> preempt', 'per-interface - enter an interface first'),
      helpLine('show <what> | do show <what>', 'any exec show, without leaving config mode'),
      helpLine('help / ?', 'this list'),
      helpLine('exit / end', 'back to exec mode')
    ]);

    if (this.mode === MODE_IFACE) return helpRows([
      'Interface-mode commands (' + this.iface + '):',
      helpLine('ip address <ip> <mask>', 'assign an IP - "10.0.0.1 255.255.255.0" or "10.0.0.1/24"'),
      // The two-form rows stay as they were: a `|` in a help row already expands into two spellings,
      // so `no ip address` and `no ip helper-address` are listed by `?` without a second row.
      helpLine('ip address dhcp | no ip address [dhcp]', 'DHCP client / clear'),
      helpLine('ip helper-address <addr> | no ip helper-address [<addr>]',
        'relay DHCP requests on this port to a server'),
      helpLine('shutdown', 'administratively down'),
      helpLine('description <text>', 'what this port is for'),
      helpLine('mtu <68-9216>', 'largest frame this port carries; flows derive their MSS from it'),
      helpLine('speed <mbps>|auto', 'port speed; the spanning-tree path cost follows it'),
      helpLine('duplex full|auto', 'duplex (half is refused: no collisions are modelled)'),
      helpLine('power inline auto|never', 'whether this port feeds a PoE device (frees its watts)'),
      // The four removals were one row, so a device with no PoE ports was shown `no power inline`
      // inside the bundle even after its positive form had been filtered out - the page offered a
      // removal for something it had just stopped offering.
      helpLine('no power inline', 'back to auto: the port feeds a device again'),
      helpLine('lldp transmit | no lldp transmit', 'whether this port announces itself'),
      helpLine('lldp receive | no lldp receive', 'whether this port listens for a neighbour'),
      // Split, not bundled: a row is filtered whole, so `no speed`/`no duplex` could not leave the
      // page of an interface that has no wire while `no mtu` (which an SVI does have) stayed.
      helpLine('no mtu', 'back to the default 1500'),
      helpLine('no speed | no duplex', 'back to negotiation, or to auto'),
      helpLine('encapsulation dot1q <vlan>', 'tag this subinterface'),
      helpLine('switchport mode access|trunk', 'the port carries one VLAN or many'),
      helpLine('switchport access vlan <id>', 'the access VLAN'),
      helpLine('switchport trunk native vlan <id>', 'the untagged VLAN on a trunk'),
      helpLine('switchport voice vlan <id>', 'a second, always-tagged VLAN for a phone on this port'),
      helpLine('switchport trunk allowed vlan <list|all>', 'which VLANs the trunk carries'),
      // Two rows, not one with a bracketed tail: `allowed vlan 10 add 10` is not a form the parser
      // takes, and a row that brackets an alternative the grammar does not allow is a page that lies.
      helpLine('switchport trunk allowed vlan add <list>', 'widen that list without retyping it'),
      helpLine('switchport trunk allowed vlan remove <list>', 'narrow that list'),
      helpLine('switchport port-security', 'secure the port: one source by default, and what to do about a second'),
      helpLine('switchport port-security maximum <n>', 'how many source addresses the port may hold (default 1)'),
      helpLine('switchport port-security mac-address <mac>', 'pin one station to this port'),
      helpLine('switchport port-security mac-address sticky', 'keep what the port learns, across a clear and a reload'),
      // The three modes are spelled out rather than held in a `<mode>` placeholder: the abbreviation
      // tree is built from these rows, so `<mode>` made the value opaque and `violation rest` was
      // refused while every other keyword on the page - `mode acc`, `root prim`, `summ` - was
      // accepted. One source for the surface, so a value the page names can be abbreviated to a
      // prefix that identifies it.
      helpLine('switchport port-security violation protect|restrict|shutdown',
        'what a violation costs: drop silently, drop and count, or err-disable the port'),
      helpLine('switchport port-security aging time <1-1440>', 'minutes an address lives before it leaves (0 = never)'),
      helpLine('switchport port-security aging type absolute|inactivity', 'count from the first sighting, or the last'),
      helpLine('switchport port-security aging static', 'let configured addresses age out too'),
      helpLine('no switchport port-security', 'turn port security off on the port (and forget its addresses)'),
      helpLine('channel-group <id> mode active|passive|on|static',
        'add this port to a LAG'),
      helpLine('ip access-group <acl> in|out | no ip access-group [<acl>] [in|out]',
        'bind (or unbind) an ACL to this port'),
      helpLine('ip ospf cost <n> | ip ospf area <id> | ip ospf network <type> | ip ospf passive',
        'per-port OSPF cost, area, or make it passive'),
      helpLine('no ip ospf cost | no ip ospf area | no ip ospf passive',
        'forget one of those three'),
      helpLine('ipv6 address <addr>/<len> | ipv6 address autoconfig',
        'a static IPv6 address, or one learned from a router'),
      helpLine('no ipv6 address [<addr>/<len>]', 'clear a static address (or all of them)'),
      helpLine('no ipv6 address autoconfig', 'stop autoconfiguring and drop the learned address'),
      helpLine('ipv6 nd suppress-ra | no ipv6 nd suppress-ra', 'stop / start advertising'),
      helpLine('no ipv6 nd prefix <prefix>/<len>', 'stop advertising one prefix'),
      helpLine('vrrp <vrid> ip <addr> [priority <p>] [preempt] [advertise <s>]',
        'join (or create) a VRRP group'),
      // `preempt` is a setting the group has on its own, and `no vrrp <vrid> preempt` is how it is
      // turned off - so both halves stand as commands, not only as flags after `ip <addr>`.
      helpLine('vrrp <vrid> preempt', 'take the virtual address back when this router has the best priority'),
      helpLine('no vrrp <vrid> preempt', 'stay Backup even with the best priority'),
      helpLine('no vrrp <vrid>', 'remove the group'),
      helpLine('ip nat inside|outside', 'which side of the NAT box this port is on'),
      helpLine('spanning-tree cost <n>', 'this port\'s path cost'),
      // The `no` half, as its own rows: `no ip nat ?` and `no spanning-tree ?` answered "No
      // completions" while both commands worked, so the operator could set a thing and not find the
      // way back.
      helpLine('no ip nat inside|outside', 'this port is on neither side'),
      helpLine('no spanning-tree cost', 'back to the cost from the cable speed'),
      helpLine('no ip access-group [<acl>] [in|out]', 'unbind an access list from this port'),
      // One row per removal, as real commands. The row used to read
      //   `no switchport mode | no switchport access vlan | no switchport trunk ... | no switchport voice vlan`
      // a single line with `|` between whole commands and a literal `...` where the trunk forms go - so
      // the console offered a word ("...") that is not a word, and `no switchport trunk ?` had nothing
      // to complete to.
      helpLine('no switchport mode', 'back to an access port (the default)'),
      helpLine('no switchport access vlan', 'back to VLAN 1 for untagged frames'),
      helpLine('no switchport trunk native vlan', 'untagged frames in VLAN 1 again'),
      helpLine('no switchport trunk allowed vlan [<list>]', 'every VLAN may cross again, or drop some'),
      helpLine('no switchport voice vlan', 'no phone VLAN on this port'),
      helpLine('no channel-group', 'take this port out of its LAG'),
      helpLine('no encapsulation dot1q', 'remove the tag from this subinterface'),
      helpLine('no description', 'clear the description'),
      helpLine('no shutdown', 'bring the port back up'),
      helpLine('interface <name>', 'switch to another port, stay in config-if'),
      // `do show` and `show` are the same thing in a block, and both work here - the page named only
      // `show`, so `do ?` answered "No completions" in this mode while it completed one mode up.
      helpLine('show <what> | do show <what>', 'any exec show, from here too'),
      // Not a row: `<any config-mode command>` is a value where a verb goes, so the page offered a
      // placeholder as if it were a command and nothing could complete or abbreviate it. The fact it
      // stood for is stated once, below the rows, where a reader looking for a verb never trips on it.
      helpLine('help / ?', 'this list'),
      helpLine('exit / end', 'config / exec'),
      // A prose line, not a row: it starts with `%` and no two-space indent, so the help parser skips
      // it (it is not a command) and the reader still sees it. Last, where a note belongs - and it is
      // the one fact this page cannot state as a row, because "any command" is not a command.
      '% any global configuration command may be typed here: it is applied at global scope, and this ' +
        'interface block is kept'
    ]);

    // Router mode is two processes behind one prompt: `router ospf` and `router bgp` both say
    // (config-router)#. The page was OSPF's for both, so a BGP process was shown `network … area 0`
    // (refused there) and was not shown `neighbor … remote-as` (the only verb it has).
    if (this.mode === MODE_OSPF) {
      if (this.routerKind === 'bgp') return helpRows([
        helpLine('neighbor <ip> remote-as <as>', 'accept sessions from that address in that AS'),
        helpLine('no neighbor <ip>', 'remove the peer'),
        helpLine('bgp router-id <ip>', 'name this speaker by an address of its own choosing'),
        helpLine('show <what> | do show <what>', 'any exec view, without leaving this process'),
        helpLine('exit', 'back to global configuration - the process stays running'),
        helpLine('end', 'leave configuration mode entirely')
      ], 'BGP mode - the process is this autonomous system, and its peers are the addresses below it');
      return helpRows([
        helpLine('network <net> <wildcard> area <id>', 'put every interface the wildcard matches into an area'),
        helpLine('no network <net> <wildcard> area <id>', 'take those interfaces out of the area'),
        helpLine('router-id <ip>', 'name this router in OSPF'),
        helpLine('show <what> | do show <what>', 'any exec view, without leaving this process'),
        helpLine('exit', 'back to global configuration - the process stays running'),
        helpLine('end', 'leave configuration mode entirely')
      ], 'Router mode - the areas live on the interfaces, and "network" is the shorthand that writes them');
    }
    if (this.mode === MODE_ACL) return helpRows([
      'Access-list ' + this.aclName + ' (' + (this.aclKindWord === 'ext' ? 'extended' : 'standard') + '):',
      helpLine('permit|deny <entry>', 'one line, in the order shown by "show access-lists"'),
      helpLine('no <sequence>', 'remove the line with that number'),
      helpLine('no permit|deny <entry>', 'remove the line that matches, without its number'),
      helpLine('show access-lists [<name>]', 'the list as it stands, with match counters'),
      helpLine('help / ?', 'this list'),
      helpLine('exit / end', 'back to config / to enable')
    ]);

    if (this.mode === MODE_DHCP_POOL) return helpRows([
      'DHCP pool commands (' + this.pool + '):',
      helpLine('network <net> [mask]', 'the subnet served'),
      helpLine('default-router <addr>', 'gateway handed to clients'),
      helpLine('dns-server <addr...>', 'resolvers handed to clients'),
      helpLine('range <start> <end>', 'leaseable range'),
      helpLine('excluded-address <low> [<high>]', 'addresses not to lease: one address, or a low/high range'),
      helpLine('excluded-address <low>-<high>', 'the same range in one token'),
      helpLine('lease <days> [hours] [minutes]', 'lease length'),
      helpLine('host <addr> <mac>', 'static reservation'),
      helpLine('no excluded-address [<low> [<high>]]', 'remove one excluded range, or every exclusion'),
      helpLine('no default-router|dns-server|range|lease',
        'clear one setting in this pool'),
      helpLine('no pool', 'delete this pool'),
      // The pool page had no exec escape at all, though `do show …` runs from it like any other block.
      // Only `do`, not a bare `show`: this block refuses `show version` by name, so the page must not
      // promise it - the row says the one spelling the parser takes here.
      helpLine('do show <what>', 'any exec view, without leaving this pool'),
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
      // A second row rather than a union on one row: a top-level `|` in a help row makes two spellings
      // of the *same* command, and the abbreviation table then no longer sees `count` after a value,
      // so `ping 10.0.0.5 cou` stopped expanding to `count`. Two rows expand two.
      helpLine('ping ipv6 <v6dst> [count <n>] [at <ms>|converged]',
        'the same echo over IPv6 (an IPv6 address needs no keyword either)'),
      helpLine('traceroute <dst> [at <ms>|converged] [numeric]', 'the forwarding path, hop by hop; numeric = addresses only (tracert too)'),
      helpLine('renew dhcp [<port>]', 'ask the server for a lease now (DHCP client ports)'),
      helpLine('release dhcp [<port>]', 'give the lease back; the port stays unaddressed until renewed'),
      helpLine('nslookup <name> [type]', 'resolve a name (own zones first, then the lab)'),
      helpLine('nslookup <address> [type]', 'reverse lookup: the address asked as d.d.c.b.in-addr.arpa, PTR by default'),
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
      helpLine('show logging [<type>|summary|types] [last <n>] [device <name>]',
        'why something happened - drops, forwards, protocol events'),
      helpLine('clear logging', 'truncate the event log'),
      helpLine('clear counters [<port>] / clear interface counters', 'zero the per-port counters'),
      helpLine('clear arp [<port>] / clear ip arp', 'empty the ARP cache so learning can be watched again'),
      helpLine('clear ip nat translation [*|<inside-local>]', 'empty the translation table, keeping the rules'),
      // Two rows, not one synopsis with `|` between a wildcard and a value: written as
      // `... binding * | <address>`, the parser made a second "command" out of `<address>` alone, so
      // the page carried a row whose first token was a value and nothing could complete or abbreviate
      // it (`?` offered a placeholder as if it were a verb).
      helpLine('clear ip dhcp binding *', 'empty the whole DHCP binding table (DHCP servers)'),
      helpLine('clear ip dhcp binding <address>', 'empty one entry of the DHCP binding table (DHCP servers)'),
      helpLine('clear mac address-table [dynamic | static | vlan <id> | interface <port> | address <mac>]',
        'empty the MAC table, or the part of it that matches (switches)'),
      helpLine('clear arp [interface <port> | <ip>]', 'forget the cache, or one port or one address of it'),
      helpLine('clear port-security counters [interface <port>]', 'reset the violation count, leave the ports as they are'),
      helpLine('clear port-security dynamic [interface <port>]', 'forget what was learned, keep what was configured or pinned'),
      helpLine('clear port-security sticky [interface <port>]', 'unpin the sticky addresses so they are learned again'),
      helpLine('show port-security', 'secured ports, addresses held, violations, violation mode'),
      helpLine('show port-security interface <port>', 'why this port is refusing traffic'),
      helpLine('show port-security address', 'which station is pinned to which port'),
      helpLine('show ip interface brief [<port>]', 'address and link state per port'),
      helpLine('show interfaces [<port>]', 'per-port detail and counters'),
      helpLine('show interfaces status', 'per-port Name, link state, VLAN, duplex, speed, type'),
      helpLine('show interfaces trunk [<port>]', 'trunk ports: mode, native VLAN, allowed and active VLANs, what the tree forwards'),
      helpLine('show interfaces switchport [<port>]', 'the L2 state of every port, or one: mode, VLAN, trunking, port security'),
      helpLine('show interfaces <port> switchport', 'one port\'s L2 state: mode, access VLAN or trunking, port security'),
      helpLine('show history', 'the commands typed into this session, last 10'),
      helpLine('show terminal', 'console length and width for this session, and that there is no pager'),
      helpLine('terminal length <0-512>', 'how many lines the screen holds (0 = no pager, which is what this is)'),
      helpLine('terminal width <40-512>', 'how many columns the tables are drawn to'),
      helpLine('show interfaces description [<port>]', 'every port label in one list, with its state'),
      helpLine('show ip interface [brief] [<port>]', 'per-port detail: address, mask, MTU, ACLs, NAT'),
      helpLine('show interfaces counters [<port>]', 'one row per port: packets, bytes, drops'),
      helpLine('show interfaces transceiver [<port>]', 'cage, optic, reach and cable-length verdict'),
      helpLine('show ip route [<dest>|connected|static|ospf|bgp|summary] [at <ms>|converged]',
        'the table, a lookup, a protocol filter, or an instant'),
      helpLine('show arp [<port>|<address>]', 'IP-to-MAC cache, or one address (show ip arp too)'),
      helpLine('show mac address-table [interface <port>|vlan <id>|address <mac>|dynamic|static|count]',
        'addresses learned per port and VLAN, a filter, or the totals'),
      helpLine('show vlan [<id>|brief|summary|count]', 'VLANs and their members, one VLAN by id, or the counts'),
      // The parser has taken `show vlan id <id>` since the `id` spelling was added (it is the form IOS
      // documents), and the page never showed it: typing it worked and `?` said it was a typo.
      helpLine('show vlan id <id>', 'one VLAN by id, in the spelling IOS documents'),
      helpLine('show vlan name <name>', 'the same table, narrowed by the name the VLAN was given'),
      helpLine('show spanning-tree vlan <id> [root|summary]',
        'the same tree, asked for by VLAN - one tree covers every VLAN here, and it says so'),
      helpLine('show spanning-tree [<port>|summary|root]',
        'root bridge, port roles and states; or the counts, or the path to the root'),
      helpLine('show etherchannel [summary]', 'LAGs and their members'),
      helpLine('show lldp', 'LLDP state: whether it runs, which ports announce, neighbours count'),
      helpLine('show lldp neighbors [<port>]', 'what announced itself on each port'),
      helpLine('show lldp neighbors detail', 'one block per neighbour: chassis, port, TTL, medium'),
      helpLine('show lldp interface [<port>]', 'per-port transmit/receive decision and the neighbour'),
      helpLine('show lldp traffic [<port>]', 'frames sent, received, discarded and refused'),
      helpLine('show access-lists [<name>]', 'entries, where they are bound, and the match counters'),
      helpLine('show ip access-lists [<name>]', 'the same table under the spelling IOS documents'),
      helpLine('show vrrp [<group>]', 'groups, priorities and current state - one group if named'),
      helpLine('show ip protocols', 'the routing processes running here, and their distances'),
      helpLine('show ip bgp', 'the BGP table: prefixes received, and which row forwards'),
      helpLine('show ip bgp <prefix>', 'one prefix in the table, and why it is or is not installed'),
      helpLine('show ip bgp summary', 'peers and installed prefixes'),
      helpLine('show ip bgp neighbors [<addr>]', 'one peer in detail, with the reason it is down'),
      helpLine('show ip ospf [<process-id>]', 'the process, its interfaces, areas and adjacencies'),
      helpLine('show ip ospf neighbor', 'adjacencies, and why one failed to form'),
      helpLine('show ip ospf database', 'the links the SPF ran on, and the prefixes it produced'),
      helpLine('show flows [<id> | counters]', 'conversations in this lab, and per-device counters'),
      helpLine('show ip nat translations', 'NAT entries the data path wrote'),
      helpLine('show ip nat statistics', 'rules, entries and hits'),
      helpLine('show dns', 'zones, records and resolvers'),
      helpLine('show hosts', 'default domain, name servers, and the names this device has resolved'),
      helpLine('show scion', 'membership, segments and reachability'),
      helpLine('show scion paths [<isd-as>]', 'composed paths, and the best of them'),
      helpLine('show ipv6 nd', 'what this device would advertise'),
      helpLine('show ipv6 interface [brief] [<port>] [at <ms>|converged]',
        'IPv6 addresses per port, and where each came from'),
      helpLine('show ipv6 route [<dest>] [at <ms>|converged]',
        'the IPv6 table, a longest-match lookup, or an instant'),
      helpLine('show ip traffic', 'per-port totals: packets, bytes and drops with their reasons (no per-protocol split)'),
      helpLine('show ip dhcp binding', 'leases handed out, or the lease held'),
      helpLine('show ip dhcp pool', 'pool summary and addresses in use'),
      helpLine('show ip dhcp server statistics', 'pools, bindings and a count of exchanges, with what is not counted'),
      helpLine('show power inline [<port>]', 'PoE budget and which ports are powered'),
      helpLine('show running-config', 'the whole configuration, pasteable'),
      helpLine('show startup-config', 'the saved copy, then what the running config changed'),
      helpLine('write memory', 'save the running configuration (privileged)'),
      helpLine('copy running-config startup-config', 'the same save, spelled the other way'),
      helpLine('copy startup-config running-config', 'merge the saved copy back into the running one'),
      helpLine('reload', 'what this console would do about booting - it does not boot'),
      '',
      '',
      'A show that reports control-plane state also answers "at <ms>" or "at converged":',
      'show ip route|ospf|bgp|dhcp, show arp, show mac address-table, show spanning-tree,',
      'show vrrp, show lldp.',
      '',
      // The exec and enable pages share one command set, so the page cannot hide the privileged half
      // without lying about the other one. What it can do is say which half it is: five `clear`
      // verbs, the two `copy` directions and `write memory` all answer "needs enable mode" until
      // `enable` is typed, and a page that lists them silently reads as if they work here.
      // The list is checked both ways by test/exec-privilege.test.js - every verb named here must
      // refuse in user exec, and every verb that refuses must be named - so it cannot drift.
      ...(this.mode === MODE_ENABLE ? [] : [
        '',
        'Privileged commands - they answer "needs enable mode" until you type "enable":',
        // Both spellings of the aliased ones are named here, because the page lists both spellings
        // and a reader who typed the alias would otherwise be told a verb the legend does not
        // mention is refused. The bridging clears are only named on a device that bridges, and the
        // NAT one only where NAT exists - naming a command the device does not have is the same
        // defect in the other direction.
        //
        // One leading space, never two: a line indented into the row column is a *form* to every
        // reader of this page (help-forms types it, help-coverage calls it a hand-padded row). This
        // is a note about rows, so it is shaped like prose.
        ' write memory, copy running-config startup-config, copy startup-config running-config,',
        ' clear logging, clear counters, clear interface counters, clear arp, clear ip arp,' +
          ((this.device.isL2 && this.device.isL2())
            ? ' clear mac address-table, clear port-security'
            : ' clear ip nat translation')
      ]),
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
