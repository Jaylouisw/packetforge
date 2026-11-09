'use strict';
// Fabric capacity: the difference between the cages a box has and the bits it can switch.
//
// The OptiXtrans E6608 is the case that forced this. It is a 2U MS-OTN subrack with six service
// slots, so a full load of B1LDCD boards presents **twelve 200G line cages** - 2.4 Tbit/s of
// ports - behind an **800 Gbit/s** OTN cross-connect. Three times the cages the fabric can fill.
// The spec says so in a note, and a note is what a reader skips: the port list says 200G twelve
// times and the box will only ever move 800G.
//
// So a spec can now declare `fabric`, and this module answers the only question that matters:
// given these ports, is the box oversubscribed, and by how much.
//
// The subtlety that makes a naive sum wrong: on a transponder or muxponder the **client** port and
// the **line** port are two ends of one connection, so the fabric carries that service once. Adding
// both sides would invent capacity the box does not have - it would read the E6608 as 6x
// oversubscribed when the honest figure is 3x (24x100GE client behind an 800G cross-connect). A
// device declares `fabric.excludes` with the cages whose traffic is already counted on the other
// side; a plain switch excludes nothing, because every port on it is a service port.
//
// What this is NOT: an oversubscription error. Access switches are oversubscribed on purpose -
// 48 gigabit ports behind a 10G uplink is normal and correct. A device declares `fabric` when the
// vendor states a switching/cross-connect capacity that genuinely caps what the ports can do
// together, and the audit reports the ratio rather than condemning it.

// Port types that consume switching capacity. A console port, a management NIC and a radio do
// not: an RS-232 socket moves kilobytes and a Wi-Fi radio's PHY rate is not fabric.
const COUNTS_TOWARD_FABRIC = ['ethernet', 'pon'];
const DOES_NOT_COUNT = ['console', 'management', 'wireless', 'wwan', 'powerline', 'dsl'];

function parseFabric(spec) {
  if (!spec || spec.fabric == null) return null;
  const f = spec.fabric;
  if (typeof f !== 'object') {
    throw new TypeError('fabric must be an object like { "capacityMbps": 800000 }');
  }
  const cap = Number(f.capacityMbps);
  if (!isFinite(cap) || cap <= 0) {
    throw new TypeError('fabric.capacityMbps must be a positive number of megabits per second');
  }
  const excludes = Array.isArray(f.excludes) ? f.excludes.filter(function (x) { return typeof x === 'string' && x; }) : [];
  return {
    capacityMbps: cap,
    excludes: excludes,
    // Free text, and worth filling in: "OTN cross-connect", "packet fabric", "switching capacity".
    kind: typeof f.kind === 'string' && f.kind ? f.kind : 'fabric',
    note: typeof f.note === 'string' ? f.note : null
  };
}

// A glob with one feature: a trailing star. "line*" matches every line port, and nothing else -
// deliberately not a regex, because a spec file should not be able to smuggle one in.
function matchesGlob(name, glob) {
  const n = String(name || '');
  const g = String(glob || '');
  if (!g) return false;
  if (g.charAt(g.length - 1) === '*') return n.indexOf(g.slice(0, -1)) === 0;
  return n === g;
}

// What the ports offer, in Mbps, counting only the ports that reach the fabric and are not
// excluded as the far end of a connection already counted.
function offeredMbps(spec) {
  if (!spec || !Array.isArray(spec.interfaces)) return 0;
  const fabric = spec.fabric && typeof spec.fabric === 'object' ? spec.fabric : null;
  const excludes = fabric && Array.isArray(fabric.excludes) ? fabric.excludes : [];
  let total = 0;
  for (const i of spec.interfaces) {
    if (!i) continue;
    const type = i.type || 'ethernet';
    if (DOES_NOT_COUNT.indexOf(type) !== -1) continue;
    if (COUNTS_TOWARD_FABRIC.indexOf(type) === -1) continue;
    if (excludes.some(function (g) { return matchesGlob(i.name, g); })) continue;
    total += speedToMbps(i.speed);
  }
  return total;
}

// "200G" -> 200000, "1G" -> 1000, "100M" -> 100, "2.5G" -> 2500. Anything unrecognised counts as
// zero and is reported by validateFabric rather than silently inflating the total.
function speedToMbps(speed) {
  if (typeof speed === 'number' && isFinite(speed)) return speed; // already Mbps
  const m = String(speed == null ? '' : speed).trim().match(/^([0-9]+(?:\.[0-9]+)?)\s*([KMGT]?)B?$/i);
  if (!m) return 0;
  const n = parseFloat(m[1]);
  switch ((m[2] || '').toUpperCase()) {
    case 'K': return n / 1000;
    case 'M': return n;
    case 'G': return n * 1000;
    case 'T': return n * 1000000;
    default: return n; // a bare number is Mbps, which is how the schema reads it
  }
}

// The audit. `ratio` is offered/capacity: 3.0 means the cages carry three times what the fabric
// can move at once - the E6608's twelve 200G cages behind an 800G cross-connect.
function auditFabric(spec) {
  const fabric = parseFabric(spec);
  if (!fabric) return null;
  const offered = offeredMbps(spec);
  const ratio = offered / fabric.capacityMbps;
  return {
    capacityMbps: fabric.capacityMbps,
    kind: fabric.kind,
    excludes: fabric.excludes,
    note: fabric.note,
    offeredMbps: offered,
    ratio: ratio,
    exceeds: offered > fabric.capacityMbps,
    overByMbps: Math.max(0, offered - fabric.capacityMbps)
  };
}

// Schema-level problems, for the catalogue invariants rather than for a single link.
function validateFabric(spec) {
  const problems = [];
  let fabric;
  try {
    fabric = parseFabric(spec);
  } catch (e) {
    return [e.message];
  }
  if (!fabric) return problems;
  const ifaces = (spec.interfaces || []).filter(Boolean);

  // A fabric slower than one of its own ports is not oversubscription, it is a typo: no vendor
  // ships a 200G cage behind a 100G cross-connect.
  const fastest = ifaces.reduce(function (max, i) {
    const t = i.type || 'ethernet';
    if (DOES_NOT_COUNT.indexOf(t) !== -1) return max;
    return Math.max(max, speedToMbps(i.speed));
  }, 0);
  if (fastest > fabric.capacityMbps) {
    problems.push('fabric capacity ' + fabric.capacityMbps + ' Mbps is slower than a single ' + fastest +
      ' Mbps port on the same device');
  }

  // An exclusion that matches nothing is worse than no exclusion at all.
  //
  // `excludes: ["line*"]` on a shelf whose ports are called `L1..L12` excludes nothing, the audit
  // then counts both ends of every connection, and the palette shows a figure that is wrong in the
  // direction of sounding impressive. Nothing else in the pipeline would ever notice: the JSON is
  // valid, the ports are valid, and the number renders.
  const exclusionProblems = excludedGlobProblems(spec);
  for (const p of exclusionProblems) problems.push(p);

  // Unparseable speeds inflate nothing but do make the audit meaningless, so they are named.
  for (const i of ifaces) {
    const t = i.type || 'ethernet';
    if (DOES_NOT_COUNT.indexOf(t) !== -1) continue;
    if (COUNTS_TOWARD_FABRIC.indexOf(t) === -1) continue;
    if (speedToMbps(i.speed) === 0) problems.push('port ' + (i.name || '?') + ' has an unreadable speed (' + i.speed + ')');
  }
  return problems;
}


// Which exclusion globs are wrong, and why. Exported because the audit and the inspector must agree
// about what an exclusion means - they are two implementations of one rule, and the only reason they
// have not drifted is that this one is tested against the other on the whole catalogue.
function excludedGlobProblems(spec) {
  const fabric = spec && spec.fabric;
  const problems = [];
  if (!fabric || !Array.isArray(fabric.excludes)) return problems;
  const names = ((spec.interfaces) || []).filter(Boolean).map(function (i) { return String(i.name || ''); });
  if (fabric.excludes.length && !names.length) {
    problems.push('fabric.excludes is declared but the device has no explicit interfaces to match against');
    return problems;
  }
  for (const glob of fabric.excludes) {
    if (typeof glob !== 'string' || !glob) { problems.push('fabric.excludes contains a non-string entry'); continue; }
    const hits = names.filter(function (n) { return matchesGlob(n, glob); });
    if (!hits.length) {
      problems.push('fabric.excludes glob ' + JSON.stringify(glob) + ' matches no port on this device, so it excludes nothing');
      continue;
    }
    // Excluding every data port would make the offered figure zero, which is never a real device.
    const dataPorts = names.filter(function (n, idx) {
      const t = ((spec.interfaces || [])[idx] || {}).type || 'ethernet';
      return COUNTS_TOWARD_FABRIC.indexOf(t) !== -1;
    });
    const dataHits = dataPorts.filter(function (n) { return matchesGlob(n, glob); });
    if (dataPorts.length && dataHits.length === dataPorts.length) {
      problems.push('fabric.excludes glob ' + JSON.stringify(glob) + ' excludes every data port on this device');
    }
  }
  return problems;
}

module.exports = {
  parseFabric,
  offeredMbps,
  auditFabric,
  validateFabric,
  excludedGlobProblems,
  speedToMbps,
  matchesGlob,
  COUNTS_TOWARD_FABRIC,
  DOES_NOT_COUNT
};
