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
  const key = portKey(t);
  let alias = null;
  for (const name of map.keys()) {
    if (portKey(name) === key) {
      if (alias === null) alias = name;
      else if (alias !== name) return null;                     // ambiguous: refuse to guess
    }
  }
  return alias;
}

// Same question, but returning the INTERFACE object rather than its name.
function resolveInterface(device, typed) {
  const name = resolvePortName(device, typed);
  if (!name || !device || !device.interfaces) return null;
  return { name: name, iface: device.interfaces.get(name) || null };
}

module.exports = { PORT_NAME_RULES, TYPE_SPELLINGS, portKey, foldInterfaceType, resolvePortName, resolveInterface };
