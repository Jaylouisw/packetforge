'use strict';
// One port, many spellings.
//
// The front panel and the vendor console do not always agree on what a socket is called:
// MikroTik silkscreens "eth1" and "SFP+1" while RouterOS calls them "ether1" and
// "sfp-sfpplus1". An engineer types whichever spelling they learned, and a lab file saved
// before a naming change says whatever the catalogue said at the time.
//
// Renaming the catalogue to the printed form was right - it is what is on the box - but it
// broke every existing lab, because Topology.connect() looked a port up by exact name and
// threw "Unknown interface ether1". A display change must never invalidate saved work
// (issue #39), so the engine resolves names through this table and the CLI uses the same
// one. A spec still decides what is DRAWN; aliases never rename anything.

// Each rule rewrites the console spelling onto the panel spelling, and the panel spelling
// onto itself, so one lowercase key covers both directions and the case difference
// (RouterOS is lowercase, the silkscreen is not).
const PORT_NAME_RULES = [
  [/^ether(\d+)$/, 'eth$1'],            // RouterOS ether1  <-> panel eth1
  [/^sfp-sfpplus(\d+)$/, 'sfp+$1'],     // RouterOS sfp-sfpplus1 <-> panel SFP+1
  [/^sfpplus(\d+)$/, 'sfp+$1'],         // tolerant of sfpplus1
  [/^qsfp-qsfpplus(\d+)$/, 'qsfp+$1'],  // RouterOS qsfp-qsfpplus1 <-> QSFP+1
  [/^qsfpplus(\d+)$/, 'qsfp+$1'],       // RouterOS qsfpplus1 <-> panel QSFP+1
  [/^sfp(\d+)$/, 'sfp$1'],              // RouterOS sfp1 <-> panel SFP1
  [/^sfp28-(\d+)$/, 'sfp28-$1'],        // RouterOS sfp28-1 <-> panel SFP28-1
  [/^qsfp28-(\d+)$/, 'qsfp28-$1'],      // RouterOS qsfp28-1 <-> panel QSFP28-1
  [/^combo(\d+)$/, 'combo$1'],          // RouterOS combo1 <-> panel COMBO1
  [/^mgmt(\d*)$/, 'mgmt$1']             // RouterOS mgmt <-> panel MGMT
];

// The interface TYPE, which every vendor spells more than one way.
//
// `interface GigabitEthernet1/0/1` and `interface Gi1/0/1` are one command on a Catalyst, and
// so are `GigabitEthernet 1/0/1` and `Gi 1/0/1` - Cisco's own configuration guide states the
// four: "you can specify either gigabitethernet 0/1, gigabitethernet0/1, gi 0/1, or gi0/1"
// (Configuring Interface Characteristics, Catalyst Digital Building Series 15.2(6)E). The long form is what
// every Cisco document writes and what `show running-config` prints, so it is the spelling an
// operator is most likely to paste - and it was the one spelling the table below had no rule
// for, which made a pasted line fail on a port that exists.
//
// The table folds each spelling onto the TYPE, never onto a port: it cannot invent a socket,
// it only lets two names for one type meet. Both sides of a comparison go through it, so the
// device's own spelling and the typed one agree whichever way round the pair is written. The
// vendor's abbreviations differ (`Gi` on Cisco, `GE` on VRP) and both are here for that
// reason; where a vendor's abbreviation is not `gi`, folding it is the only way `interface
// GigabitEthernet0/0/1` can reach a port the catalogue calls `GE0/0/1`.
//
// Deliberately NOT here: partial spellings (`Gig1/0/1`). IOS accepts any unique prefix of a
// keyword, but which prefixes are unique depends on the command, and a prefix rule here would
// silently start matching names like `Port 1`. Left unresolved rather than guessed.
const TYPE_SPELLINGS = [
  ['gigabitethernet', ['gi', 'ge']],
  ['fastethernet', ['fa']],
  ['ethernet', ['eth', 'et']],
  ['tengigabitethernet', ['ten-gigabitethernet', 'te']],
  ['twentyfivegige', ['twe']],
  ['fortygigabitethernet', ['fortygige', 'fo']],
  ['hundredgigabitethernet', ['hundredgige', 'hu']],
  ['serial', ['se']],
  ['port-channel', ['portchannel', 'po']],
  ['vlan', ['vl']],
  ['loopback', ['lo']],
  ['tunnel', ['tu']],
  ['management', ['ma']]
];

const TYPE_KEY = new Map();
for (const row of TYPE_SPELLINGS) {
  TYPE_KEY.set(row[0], row[0]);
  for (const alt of row[1]) TYPE_KEY.set(alt, row[0]);
}

// The type word is everything before the first digit, the number is the rest - and the space
// between them is optional on the same rule, since `gigabitethernet 0/1` and `gi0/1` are the
// same command. `SFP+1` and `sfp28-1` split the same way and match no type, so they pass
// through untouched: this module folds spellings, it does not rewrite names it does not know.
const TYPE_AND_NUMBER = /^([a-z][a-z+_-]*)\s*(\d.*)$/;

function foldInterfaceType(name) {
  const s = String(name === undefined || name === null ? '' : name).trim().toLowerCase();
  const m = TYPE_AND_NUMBER.exec(s);
  if (!m) return s;
  const type = TYPE_KEY.get(m[1]);
  if (!type) return s;
  return type + m[2];
}

// The comparison key for a port name: case-insensitive, with every known console spelling
// folded onto the panel spelling, and the interface type folded onto its one name
// ('GigabitEthernet1/0/1', 'gi 1/0/1' and 'GE1/0/1' are one key). A subinterface keeps its
// parent's key ('ether1.10' -> 'eth1.10').
function portKey(name) {
  let s = String(name === undefined || name === null ? '' : name).trim().toLowerCase();
  for (const rule of PORT_NAME_RULES) {
    if (rule[0].test(s)) { s = s.replace(rule[0], rule[1]); break; }
  }
  return foldInterfaceType(s);
}

// The interface TYPE may be shortened to a prefix, and on a real box it usually is: a Catalyst
// operator types `interface g0/12` and a router operator types `interface s0/0/0`. IOS states the
// rule for every keyword it parses - "You can abbreviate commands and keywords to the number of
// characters that allow a unique abbreviation" (Cisco IOS Configuration Fundamentals, Using the
// Command-Line Interface, 12.2SX) - and the type word in an interface name is one of those
// keywords: a platform guide writes the command as `interface g 0/1/0` and the check as
// `show interface g0/1/0` (Cisco Embedded Service 6300 Series Software Configuration Guide,
// Configuring Ethernet Switch Ports), and a Catalyst 6500 configuration in Cisco's own support
// library opens with `interface g0/12` (Port-Security for mobile devices as laptops). Those are
// one-letter prefixes, so every longer prefix (`gi`, `gig`, `gigabit`) follows on the same rule.
//
// What that rule needs, and what a device-free table cannot supply, is *uniqueness*: `g` is
// unambiguous on a switch whose only G-type is GigabitEthernet, and `t` is ambiguous on a box
// that carries both TenGigabitEthernet and TwentyFiveGigE. So the prefix is expanded against the
// types the device actually has, and only when exactly one of them matches - the alternative is a
// guess, and a guessed port is worse than a refusal.
//
// It is deliberately not in `portKey()`. That key is device-free (saved labs are folded with it
// before any device exists), and a prefix rule there would start matching names the table never
// knew - `p1` would reach a UniFi `Port 1`, which is the one thing the naming table promises not
// to do. Only a type already in TYPE_SPELLINGS can be reached this way, and only through a device.
function deviceTypeSet(map) {
  const types = new Set();
  for (const name of map.keys()) {
    const m = TYPE_AND_NUMBER.exec(String(name).toLowerCase());
    if (!m) continue;
    const type = TYPE_KEY.get(m[1]);
    if (type) types.add(type);
  }
  return types;
}

// The name with its type word expanded to the one type the device has, or null when the word is
// already a documented spelling, matches no type, or matches more than one.
function expandTypePrefix(device, typed) {
  const map = device && device.interfaces;
  if (!map || !typed) return null;
  const m = TYPE_AND_NUMBER.exec(String(typed).trim().toLowerCase());
  if (!m) return null;
  const word = m[1];
  if (TYPE_KEY.has(word)) return null;                 // a documented spelling: portKey() owns it
  const hits = [];
  for (const type of deviceTypeSet(map)) {
    if (type.length > word.length && type.indexOf(word) === 0) hits.push(type);
  }
  if (hits.length !== 1) return null;                  // none, or ambiguous: refuse rather than guess
  return hits[0] + m[2];
}

// Resolve a name the caller used onto the device's own interface name. Returns null when
// the device has no such port, so callers can say so rather than inventing one. Ambiguity
// is refused: if two ports fold onto the same key, naming that key is not a guess worth
// making.
function resolvePortName(device, typed) {
  const map = device && device.interfaces;
  if (!map || !typed) return null;
  const t = String(typed).trim();
  if (map.has(t)) return t;                                     // exact panel spelling
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
  // One pass over the ports for one key: the port's name, null for "no port has this key", or
  // false when two ports share it. "Ambiguous" and "absent" are different answers - the prefix
  // pass below may only rescue the second, so a spelling that folds onto two ports cannot be
  // rescued into one of them by a shorter type.
  const matchKey = function (key) {
    let found = null;
    for (const name of map.keys()) {
      if (portKey(name) !== key) continue;
      if (found === null) found = name;
      else if (found !== name) return false;                    // ambiguous: refuse to guess
    }
    return found;
  };
  let alias = matchKey(portKey(t));
  if (alias === false) return null;                             // ambiguous: still a refusal
  // A shortened TYPE is the same port as the long one ('g0/12' -> 'Gi0/12'), and the expansion is
  // done against this device's own ports so a prefix that could mean two types resolves to
  // neither (see expandTypePrefix above).
  if (alias === null) {
    const expanded = expandTypePrefix(device, t);
    if (expanded && expanded !== t.toLowerCase()) alias = matchKey(portKey(expanded));
  }
  return alias || null;
}

// Port order: the order a box numbers, serves and prints its ports in.
//
// `Array.prototype.sort()` compares strings, and string order is not port order: "1/1/10" sorts
// before "1/1/2", so a 24-port switch read "in port order" is really in order for its first nine
// ports and the tens after them. Nothing on the hardware orders ports that way - a PSE serves
// them by port number, `show` commands print them by port number, and the number is the last run
// of digits in the name.
//
// The comparison is run by run: numeric runs compare as numbers, everything else as folded text.
// That puts 10 after 2 while still sorting GigabitEthernet before TenGigabitEthernet, and it needs
// no per-vendor table of what a port name looks like - "eth10", "SFP+2", "1/1/10", "Port 9" and
// "Te1/1/1" all come out in the order the panel is silk-screened in.
const PORT_RUNS = /[0-9]+|[^0-9]+/g;

function portRuns(name) {
  const text = (name === null || name === undefined) ? '' : String(name);
  return text.match(PORT_RUNS) || [];
}

function comparePortNames(a, b) {
  const ra = portRuns(a);
  const rb = portRuns(b);
  const n = Math.min(ra.length, rb.length);
  for (let i = 0; i < n; i++) {
    const x = ra[i];
    const y = rb[i];
    const xn = /^[0-9]+$/.test(x);
    const yn = /^[0-9]+$/.test(y);
    if (xn && yn) {
      const diff = Number(x) - Number(y);
      // Equal value, different spelling ("0/01" and "0/1") falls through to the raw comparison
      // below, so the order is still total and the same list comes out sorted the same way twice.
      if (diff !== 0) return diff < 0 ? -1 : 1;
      continue;
    }
    if (xn !== yn) return String(a) < String(b) ? -1 : 1;   // one run is a number, one is not
    const xl = x.toLowerCase();
    const yl = y.toLowerCase();
    if (xl !== yl) return xl < yl ? -1 : 1;
  }
  if (ra.length !== rb.length) return ra.length < rb.length ? -1 : 1;
  const sa = String(a);
  const sb = String(b);
  if (sa === sb) return 0;
  return sa < sb ? -1 : 1;
}

// Same question, but returning the INTERFACE object rather than its name.
function resolveInterface(device, typed) {
  const name = resolvePortName(device, typed);
  if (!name || !device || !device.interfaces) return null;
  return { name: name, iface: device.interfaces.get(name) || null };
}

module.exports = { PORT_NAME_RULES, TYPE_SPELLINGS, portKey, foldInterfaceType, expandTypePrefix,
  resolvePortName, resolveInterface, comparePortNames, portRuns };
