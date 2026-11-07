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

// The comparison key for a port name: case-insensitive, with every known console spelling
// folded onto the panel spelling. A subinterface keeps its parent's key ('ether1.10' ->
// 'eth1.10').
function portKey(name) {
  let s = String(name === undefined || name === null ? '' : name).trim().toLowerCase();
  for (const rule of PORT_NAME_RULES) {
    if (rule[0].test(s)) { s = s.replace(rule[0], rule[1]); break; }
  }
  return s;
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

module.exports = { PORT_NAME_RULES, portKey, resolvePortName, resolveInterface };
