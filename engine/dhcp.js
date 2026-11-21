'use strict';
// dhcp.js -- DHCPv4 pool + lease model.
//
// Covers the three things the simulator, the CLI and the editor need:
//   1. normalising a pool definition (range, mask, gateway, dns, reservations,
//      exclusions, lease time) into one canonical shape
//   2. validating that pool (ranges inside the subnet, contiguous mask,
//      non-conflicting reservations, a non-empty usable range, ...)
//   3. the four-message handshake as pure state transitions:
//        DISCOVER -> OFFER        (handleDiscover)
//        REQUEST  -> ACK | NAK    (handleRequest)
//        release / expiry         (releaseLease, expireLeases)
//
// Everything here is pure data + pure functions: no I/O, no clock, no
// Math.random. `step` is the simulator's tick, and a lease expires at
// step + leaseSec (one tick == one second), so a run is fully deterministic.
//
// Leases live in two Maps kept in sync (createLeaseState):
//   leases: mac  -> { ip, expiresStep }
//   byIp:   ip   -> mac
//
// Policy notes:
//   * a reservation always wins -- a client with a reservation is offered its
//     reserved address and is never handed a different one;
//   * an address is never handed to a MAC other than its reservation owner;
//   * a client re-requesting the address it already holds is a renewal: ACK,
//     with the lease time extended (never a NAK);
//   * OFFER does not commit anything. Only an ACK creates a lease, which is
//     what makes DISCOVER retries harmless.

const net = require('./net');

const DHCP_MESSAGE_TYPES = { DISCOVER: 1, OFFER: 2, REQUEST: 3, ACK: 5, NAK: 6 };

const DEFAULT_POOL_NAME = 'lan';
const DEFAULT_MASK = '255.255.255.0';
const DEFAULT_LEASE_SEC = 86400;
const STEP_SECONDS = 1;
// `lease infinite` is the vendor's own spelling for an unlimited lease (Cisco IOS IP Addressing Services Command
// Reference, `lease {days [hours [minutes]] | infinite}`: "Specifies that the duration of the lease is
// unlimited"). It is carried in a pool as the word itself, so no code downstream can mistake it for a number of
// seconds; on the wire it is 0xffffffff, the value RFC 2131 §3.3 reserves to represent "infinity".
const INFINITE_LEASE = 'infinite';
const INFINITE_LEASE_SEC = 0xFFFFFFFF;

// ---------------------------------------------------------------------------
// small parsers -- never throw, return null on garbage
// ---------------------------------------------------------------------------

function trimStr(v) {
  if (v === null || v === undefined) return '';
  return String(v).trim();
}

function parseIp(v) {
  if (!net.isIp(v)) return null;
  try {
    return net.ipToInt(v) >>> 0;
  } catch (err) {
    return null;
  }
}

// The mask rules live in engine/net.js: one predicate decides contiguity and one
// function turns a mask int into a prefix length, so this module cannot disagree
// with the router about what 255.255.255.0 means (#1249).
const prefixOfMask = net.prefixOfInt;

function parseMask(v) {
  const s = trimStr(v).replace(/^\/+/, '');
  if (!s) return null;
  if (/^\d{1,2}$/.test(s)) {
    const p = parseInt(s, 10);
    if (p < 0 || p > 32) return null;
    return p === 0 ? 0 : (0xffffffff << (32 - p)) >>> 0;
  }
  if (!net.isIp(s)) return null;
  let m;
  try {
    m = net.maskToInt(s) >>> 0;
  } catch (err) {
    return null;
  }
  return net.isContiguousMask(m) ? m : null;
}

// Canonical 'aa:bb:cc:dd:ee:ff' for anything macToInt() understands, else null.
function canonicalMac(v) {
  const s = trimStr(v);
  if (!s) return null;
  try {
    return net.intToMac(net.macToInt(s));
  } catch (err) {
    return null;
  }
}

function stepOf(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

// ---------------------------------------------------------------------------
// normalisation
// ---------------------------------------------------------------------------

// Accept 'a.b.c.d', { start, end }, { from, to } or { ip } and return
// { start, end } pairs of raw strings. Validation is what complains about
// garbage; normalisation only sorts out the shapes.
function normalizeExcluded(list) {
  const out = [];
  const items = Array.isArray(list) ? list : (list === null || list === undefined ? [] : [list]);
  for (const item of items) {
    if (item === null || item === undefined) continue;
    if (typeof item === 'string') {
      const s = item.trim();
      if (!s) continue;
      const dash = s.indexOf('-');
      if (dash > 0) {
        out.push({ start: s.slice(0, dash).trim(), end: s.slice(dash + 1).trim() });
      } else {
        out.push({ start: s, end: s });
      }
      continue;
    }
    if (typeof item === 'object') {
      const first = item.start !== undefined ? item.start
        : (item.from !== undefined ? item.from : item.ip);
      const last = item.end !== undefined ? item.end
        : (item.to !== undefined ? item.to : first);
      out.push({ start: trimStr(first), end: trimStr(last) });
    }
  }
  return out;
}

function normalizeDns(v) {
  let items;
  if (Array.isArray(v)) items = v;
  else if (v === null || v === undefined || v === '') items = [];
  else items = String(v).split(/[\s,]+/);
  const out = [];
  for (const d of items) {
    const s = trimStr(d);
    if (s) out.push(s);
  }
  return out;
}

// Normalise a (possibly partial) pool spec into the canonical shape.
//
// Values that are present but wrong are kept verbatim (mask/range/gateway/
// leaseSec/reservation ip) so validatePool() can name them in an error instead
// of silently "fixing" a typo. Only absent values get defaults.
function normalizePool(spec) {
  const s = (spec && typeof spec === 'object') ? spec : {};

  const name = trimStr(s.name) || DEFAULT_POOL_NAME;

  const maskInt = parseMask(
    (s.mask === undefined || s.mask === null || s.mask === '') ? DEFAULT_MASK : s.mask
  );
  const mask = (maskInt === null) ? trimStr(s.mask) : net.intToIp(maskInt);

  const networkIn = trimStr(s.network);
  const networkInt = parseIp(networkIn);
  const network = (networkInt !== null && maskInt !== null)
    ? net.intToIp((networkInt & maskInt) >>> 0)
    : networkIn;

  const rangeStart = trimStr(s.rangeStart);
  const rangeEnd = trimStr(s.rangeEnd);

  const gatewayIn = trimStr(s.gateway);
  const gatewayInt = parseIp(gatewayIn);
  const gateway = gatewayIn === '' ? null
    : (gatewayInt === null ? gatewayIn : net.intToIp(gatewayInt));

  const dns = normalizeDns(s.dns);

  const reservations = {};
  const rawReservations = (s.reservations && typeof s.reservations === 'object') ? s.reservations : {};
  for (const key of Object.keys(rawReservations)) {
    const mac = canonicalMac(key);
    const outKey = mac || trimStr(key).toLowerCase();
    const ipIn = trimStr(rawReservations[key]);
    const ipInt = parseIp(ipIn);
    reservations[outKey] = (ipInt === null) ? ipIn : net.intToIp(ipInt);
  }

  const excluded = normalizeExcluded(s.excluded);

  const leaseIn = (s.leaseSec === undefined || s.leaseSec === null || s.leaseSec === '')
    ? DEFAULT_LEASE_SEC
    : s.leaseSec;
  // A word, not a duration: `infinite` survives normalisation as the word, so validatePool(), the
  // running-config printer and the console's pool view all read one fact instead of three guesses.
  const rawLease = (typeof leaseIn === 'string' && leaseIn.trim().toLowerCase() === INFINITE_LEASE)
    ? INFINITE_LEASE
    : Number(leaseIn);
  const leaseSec = (rawLease === INFINITE_LEASE) ? INFINITE_LEASE
    : ((Number.isFinite(rawLease) && rawLease > 0) ? Math.floor(rawLease) : rawLease);

  // The server identifier is not part of the pool shape, so derive one: an
  // explicit `server`, else the gateway, else the first usable address.
  let server = trimStr(s.server);
  if (!parseIp(server)) {
    const gwInt = parseIp(gateway);
    if (gwInt !== null) server = net.intToIp(gwInt);
    else if (networkInt !== null && maskInt !== null) server = net.intToIp((networkInt + 1) >>> 0);
    else server = '';
  }

  return {
    name: name,
    network: network,
    mask: mask,
    rangeStart: rangeStart,
    rangeEnd: rangeEnd,
    gateway: gateway,
    dns: dns,
    reservations: reservations,
    excluded: excluded,
    leaseSec: leaseSec,
    server: server
  };
}

// ---------------------------------------------------------------------------
// accessors on a normalised pool (all tolerant -- they never throw)
// ---------------------------------------------------------------------------

// How many addresses this pool can hand out. Counted the way allocation walks the range: endpoints included,
// exclusions removed, network/broadcast removed, and the gateway removed when it sits inside the range (it is
// deliberately not allocatable). Reservations are inside the range and are counted, because they are allocatable
// to their owner. Returns null for a pool that could not be used, so a caller can say "unknown" rather than print
// a number it invented.
function poolCapacity(p) {
  const check = validatePool(p);
  if (!check.ok) return null;
  const range = rangeInts(p);
  if (range === null) return null;
  const gw = parseIp(p.gateway);
  let count = 0;
  for (let n = range.start; n <= range.end; n++) {
    if (isEndpointInt(p, n)) continue;
    if (isExcludedInt(p, n)) continue;
    if (gw !== null && n === gw) continue;
    count++;
  }
  return count;
}

// What `show ip dhcp pool` states about one pool: how big the subnet it serves is, how much of that
// subnet the pool can hand out, and the address the allocator would try next. IOS's words for the three
// are `Total addresses`, `Excluded addresses` and `Current index` (research/show-ip-dhcp-pool-layout.md).
//
// Only one of them is stored. The other two are derived here, once, so the console cannot compute them a
// second way:
//   total    - the subnet's usable addresses, network and broadcast removed: 254 for a /24, which is what
//              every published capture of a /24 pool prints, whatever its exclusions.
//   excluded - what is left of the subnet after `poolCapacity()`. A configured `range` narrower than the
//              subnet leaves addresses the server will never offer, and IOS counts "excluded" as exactly
//              that: an address the server will not offer. With the gateway (not allocatable either) that
//              makes leased + excluded + free add up to the subnet, the arithmetic the IOS XE capture
//              prints (`61 / 62 / 254`).
//   index    - the first address in the subnet the server would hand out next, skipping the endpoints,
//              exclusions, the gateway, the reservations and the leases the caller can see. `null` when
//              there is none left - IOS prints that as `0.0.0.0`.
//
// `taken` is the addresses already leased, or null when that is not known yet, so the console can say
// "not measured" instead of a zero it did not observe.
function poolSummary(pool, taken) {
  const p = normalizePool(pool);
  const maskInt = maskIntOf(p);
  const netInt = networkIntOf(p);
  const range = rangeInts(p);
  const capacity = poolCapacity(p);
  if (maskInt === null || netInt === null) {
    return { total: null, capacity: capacity, excluded: null, index: null, range: null };
  }
  const bcast = (netInt | (~maskInt >>> 0)) >>> 0;
  const size = (bcast - netInt + 1) >>> 0;
  // A /31 and a /32 have no network or broadcast address to lose (RFC 3021); every wider mask loses two.
  const total = size > 2 ? size - 2 : size;
  const first = size > 2 ? netInt + 1 : netInt;
  const last = size > 2 ? bcast - 1 : bcast;

  // Everything the server will not offer from this subnet, on top of what poolCapacity() already removed.
  const excluded = (capacity === null) ? null : total - capacity;

  const held = {};
  for (const ip of (Array.isArray(taken) ? taken : [])) held[ip] = true;
  for (const mac of Object.keys(p.reservations || {})) {
    if (typeof p.reservations[mac] === 'string') held[p.reservations[mac]] = true;
  }

  let index = null;
  if (range !== null && capacity !== null) {
    for (let n = first; n <= last; n++) {
      // Outside the configured range is the same fact as an exclusion: the server will not offer it.
      if (n < range.start || n > range.end) continue;
      if (isEndpointInt(p, n)) continue;
      if (isExcludedInt(p, n)) continue;
      const ip = net.intToIp(n);
      if (p.gateway !== null && ip === p.gateway) continue;
      if (held[ip]) continue;
      index = ip;
      break;
    }
  }
  return {
    total: total,
    capacity: capacity,
    excluded: excluded,
    index: index,
    range: { start: net.intToIp(first), end: net.intToIp(last) }
  };
}

function maskIntOf(p) { return parseMask(p.mask); }
function networkIntOf(p) { return parseIp(p.network); }

// The addresses a subnet can hand to a host: network+1 through broadcast-1. A /31 and a /32 have no
// network or broadcast address to lose (RFC 3021), so those two keep every address.
function subnetHostInts(netInt, maskInt) {
  const bcast = (netInt | (~maskInt >>> 0)) >>> 0;
  const size = (bcast - netInt + 1) >>> 0;
  return size > 2 ? { start: netInt + 1, end: bcast - 1 } : { start: netInt, end: bcast };
}

// The addresses this pool may offer.
//
// `range` is optional on the box, not required: a pool with a `network` and no `range` serves that whole
// subnet, which is the shape of every configuration example Cisco publishes and of the 850/870 capture whose
// `show ip dhcp pool` prints `10.10.0.1 - 10.10.0.254` for a pool that never named a range
// (research/dhcp-range-is-optional.md). Only a pool that names one end of a range and not the other is
// unreadable, and validatePool() says so.
function rangeInts(p) {
  const start = parseIp(p.rangeStart);
  const end = parseIp(p.rangeEnd);
  if (start !== null && end !== null) return { start: start, end: end };
  if (trimStr(p.rangeStart) !== '' || trimStr(p.rangeEnd) !== '') return null;
  const netInt = networkIntOf(p);
  const maskInt = maskIntOf(p);
  if (netInt === null || maskInt === null) return null;
  return subnetHostInts(netInt, maskInt);
}

// The range as the console writes it: the configured pair when there is one, else the subnet's own, so a
// sentence about "the pool range" never prints two empty strings.
function rangeText(p) {
  const r = rangeInts(p);
  if (r === null) return (p.rangeStart || p.rangeEnd) ? (p.rangeStart + '-' + p.rangeEnd) : 'the pool range';
  return net.intToIp(r.start) + '-' + net.intToIp(r.end);
}

function excludedInts(p) {
  const out = [];
  for (const r of (Array.isArray(p.excluded) ? p.excluded : [])) {
    const a = parseIp(r && r.start);
    const b = parseIp(r && r.end);
    if (a === null || b === null) continue;
    out.push({ start: Math.min(a, b), end: Math.max(a, b) });
  }
  return out;
}

function isExcludedInt(p, n) {
  for (const r of excludedInts(p)) {
    if (n >= r.start && n <= r.end) return true;
  }
  return false;
}

// network / broadcast / all-ones are never handed out.
function isEndpointInt(p, n) {
  const m = maskIntOf(p);
  if (m === null) return false;
  const netInt = networkIntOf(p);
  if (netInt === null) return false;
  const bcast = (netInt | (~m >>> 0)) >>> 0;
  return n === netInt || n === bcast || n === 0 || n === 0xffffffff;
}

function reservationOwner(p, n) {
  for (const mac of Object.keys(p.reservations)) {
    if (canonicalMac(mac) === null) continue;
    if (parseIp(p.reservations[mac]) === n) return mac;
  }
  return null;
}

// The address reserved for a MAC, if any.
function reservationFor(p, mac) {
  if (!mac) return null;
  for (const key of Object.keys(p.reservations)) {
    if (canonicalMac(key) !== mac) continue;
    const n = parseIp(p.reservations[key]);
    if (n === null) return null;
    return net.intToIp(n);
  }
  return null;
}

// Is this pool's lease the unlimited one? Takes a raw spec or a normalised pool, because both shapes reach the
// console and the console has to answer the same question about each.
function isInfiniteLease(pool) {
  const v = (pool && typeof pool === 'object') ? pool.leaseSec : pool;
  if (v === undefined || v === null) return false;
  return String(v).trim().toLowerCase() === INFINITE_LEASE;
}

// The lease time as the handshake carries it: seconds, or 0xffffffff for an unlimited lease (RFC 2131 §3.3).
function leaseSeconds(p) {
  if (isInfiniteLease(p)) return INFINITE_LEASE_SEC;
  const n = Number(p.leaseSec);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LEASE_SEC;
  return Math.floor(n);
}

function serverId(p) {
  const s = trimStr(p.server);
  if (parseIp(s) !== null) return s;
  const gw = parseIp(p.gateway);
  if (gw !== null) return net.intToIp(gw);
  const netInt = networkIntOf(p);
  if (netInt !== null && maskIntOf(p) !== null) return net.intToIp((netInt + 1) >>> 0);
  return '';
}

// ---------------------------------------------------------------------------
// validation
// ---------------------------------------------------------------------------

// Validation takes a raw spec or a normalised pool and returns
//   { ok, errors: [{ code, message }] }
// with one error per distinct problem (so a fully broken spec reports several
// times, which is what an editor wants to show).
function validatePool(pool) {
  const p = normalizePool(pool);
  const errors = [];

  function err(code, message) { errors.push({ code: code, message: message }); }
  const where = 'DHCP pool ' + p.name + ': ';

  const maskInt = maskIntOf(p);
  const networkInt = networkIntOf(p);
  const range = rangeInts(p);

  // --- network + mask -----------------------------------------------------
  if (p.network === '') {
    err('E_DHCP_BAD_NETWORK', where + 'no network address was given.');
  } else if (networkInt === null) {
    err('E_DHCP_BAD_NETWORK', where + 'network "' + p.network + '" is not a valid IPv4 address.');
  }

  if (maskInt === null) {
    err('E_DHCP_BAD_MASK',
      where + 'mask "' + p.mask + '" is not a valid contiguous IPv4 mask (try 255.255.255.0 or 24).');
  }

  // --- range --------------------------------------------------------------
  // No `range` at all is legal - the pool serves its whole subnet (`rangeInts()` derives it) - so only a
  // half-typed range is an error here. `range 10.0.0.10` on its own is refused by the console before it is
  // stored; this guard is for a pool spec that reached the library some other way.
  if ((p.rangeStart === '') !== (p.rangeEnd === '')) {
    err('E_DHCP_BAD_RANGE', where + 'a range takes both ends: range <start> <end>.');
  } else if (p.rangeStart !== '' && p.rangeEnd !== '') {
    const startInt = parseIp(p.rangeStart);
    const endInt = parseIp(p.rangeEnd);
    if (startInt === null || endInt === null) {
      err('E_DHCP_BAD_RANGE',
        where + 'range ' + p.rangeStart + '-' + p.rangeEnd + ' contains an invalid IPv4 address.');
    } else {
      if (startInt > endInt) {
        err('E_DHCP_RANGE_ORDER',
          where + 'rangeStart ' + p.rangeStart + ' is above rangeEnd ' + p.rangeEnd + '.');
      }
      if (networkInt !== null && maskInt !== null) {
        const bcast = (networkInt | (~maskInt >>> 0)) >>> 0;
        if (((startInt & maskInt) >>> 0) !== networkInt || ((endInt & maskInt) >>> 0) !== networkInt) {
          err('E_DHCP_RANGE_OUTSIDE',
            where + 'range ' + p.rangeStart + '-' + p.rangeEnd + ' is not inside ' +
            p.network + '/' + prefixOfMask(maskInt) + '.');
        }
        if (startInt === networkInt || endInt === bcast) {
          err('E_DHCP_RANGE_ENDPOINT',
            where + 'range ' + p.rangeStart + '-' + p.rangeEnd +
            ' overlaps the network or broadcast address.');
        }
      }
    }
  }

  // --- gateway ------------------------------------------------------------
  if (p.gateway !== null) {
    const gwInt = parseIp(p.gateway);
    if (gwInt === null) {
      err('E_DHCP_BAD_GATEWAY', where + 'gateway "' + p.gateway + '" is not a valid IPv4 address.');
    } else if (networkInt !== null && maskInt !== null &&
      ((gwInt & maskInt) >>> 0) !== networkInt) {
      err('E_DHCP_GATEWAY_OUTSIDE',
        where + 'gateway ' + p.gateway + ' is outside ' + p.network + '/' + prefixOfMask(maskInt) + '.');
    }
  }

  // --- dns ----------------------------------------------------------------
  for (const d of p.dns) {
    if (parseIp(d) === null) {
      err('E_DHCP_BAD_DNS', where + 'DNS server "' + d + '" is not a valid IPv4 address.');
    }
  }

  // --- reservations -------------------------------------------------------
  const seenIps = {};
  for (const key of Object.keys(p.reservations)) {
    const mac = canonicalMac(key);
    if (mac === null) {
      err('E_DHCP_BAD_MAC', where + 'reservation key "' + key + '" is not a valid MAC address.');
      continue;
    }
    const ipInt = parseIp(p.reservations[key]);
    if (ipInt === null) {
      err('E_DHCP_BAD_RESERVATION',
        where + 'reservation for ' + mac + ' has invalid address "' + p.reservations[key] + '".');
      continue;
    }
    const ip = net.intToIp(ipInt);
    if (seenIps[ip] && seenIps[ip] !== mac) {
      err('E_DHCP_RESERVATION_CONFLICT',
        where + ip + ' is reserved for both ' + seenIps[ip] + ' and ' + mac + '.');
    } else {
      seenIps[ip] = mac;
    }
    if (networkInt !== null && maskInt !== null && ((ipInt & maskInt) >>> 0) !== networkInt) {
      err('E_DHCP_RESERVATION_OUTSIDE',
        where + 'reservation ' + ip + ' (' + mac + ') is outside ' +
        p.network + '/' + prefixOfMask(maskInt) + '.');
      continue;
    }
    if (range !== null && range.start <= range.end && (ipInt < range.start || ipInt > range.end)) {
      err('E_DHCP_RESERVATION_OUT_OF_RANGE',
        where + 'reservation ' + ip + ' (' + mac + ') is outside the pool range ' +
        rangeText(p) + '.');
    }
  }

  // --- exclusions ---------------------------------------------------------
  for (const r of p.excluded) {
    if (parseIp(r.start) === null || parseIp(r.end) === null) {
      err('E_DHCP_BAD_EXCLUDED',
        where + 'excluded entry "' + r.start + '-' + r.end + '" is not a valid IPv4 range.');
    }
  }

  // --- lease --------------------------------------------------------------
  const lease = Number(p.leaseSec);
  if (!isInfiniteLease(p) && (!Number.isFinite(lease) || lease <= 0)) {
    err('E_DHCP_BAD_LEASE', where + 'leaseSec "' + p.leaseSec + '" must be a positive number of seconds.');
  }

  // --- is anything left to hand out? --------------------------------------
  // Asked of the range the pool will actually walk, derived or configured, so a pool whose whole subnet is
  // excluded is refused for the same reason a pool whose configured range is all excluded is.
  if (range !== null && range.start <= range.end) {
    let usable = 0;
    for (let n = range.start; n <= range.end; n++) {
      if (isEndpointInt(p, n)) continue;
      if (isExcludedInt(p, n)) continue;
      const owner = reservationOwner(p, n);
      if (owner !== null) continue;
      usable++;
      break;
    }
    if (usable === 0) {
      err('E_DHCP_NO_HOSTS',
        where + 'every address in ' + rangeText(p) +
        ' is excluded, reserved or a network/broadcast address.');
    }
  }

  return { ok: errors.length === 0, errors: errors };
}

// ---------------------------------------------------------------------------
// lease state
// ---------------------------------------------------------------------------

function createLeaseState() {
  return { leases: new Map(), byIp: new Map() };
}

// A lease state is topology state, so the document carries it - and it is two Maps, which JSON cannot write. The
// encoder writes what a lease is (the address, who holds it, which pool, when it lapses); the decoder rebuilds both
// maps from that one list, so a document can never restore a MAC map and an address map that disagree (#1465).
function leaseStateToJSON(state) {
  const s = stateOf(state);
  const leases = [];
  for (const mac of Array.from(s.leases.keys())) {
    const l = s.leases.get(mac);
    if (!l || !l.ip) continue;
    leases.push({
      mac: mac, ip: l.ip,
      pool: l.pool === undefined ? null : l.pool,
      leaseSec: l.leaseSec === undefined ? null : l.leaseSec,
      expiresStep: l.expiresStep === Infinity ? INFINITE_LEASE
        : (l.expiresStep === undefined ? null : l.expiresStep)
    });
  }
  return { leases: leases };
}

function leaseStateFromJSON(rec) {
  const state = createLeaseState();
  const list = rec && Array.isArray(rec.leases) ? rec.leases : [];
  for (const raw of list) {
    if (!raw || !raw.mac || !raw.ip) continue;
    const lease = {
      ip: raw.ip,
      expiresStep: raw.expiresStep === INFINITE_LEASE ? Infinity
        : (Number.isFinite(Number(raw.expiresStep)) ? Number(raw.expiresStep) : null),
      pool: raw.pool === undefined ? null : raw.pool,
      leaseSec: Number.isFinite(Number(raw.leaseSec)) ? Number(raw.leaseSec) : null
    };
    // One address, one holder: a document that names the same address twice keeps the first and drops the rest,
    // which is the rule the running server applies too.
    if (state.byIp.has(raw.ip)) continue;
    state.leases.set(raw.mac, lease);
    state.byIp.set(raw.ip, raw.mac);
  }
  return state;
}

// Never trust the caller's state object; rebuild it if it is not the shape we
// expect (a simulator restart, a fresh device, a hand-written test fixture).
function stateOf(state) {
  if (state && state.leases instanceof Map && state.byIp instanceof Map) return state;
  return createLeaseState();
}

// Commit a lease, keeping both maps consistent: a MAC holds at most one
// address, an address belongs to at most one MAC.
function recordLease(state, mac, ip, step, leaseSec, poolName, infinite) {
  const prev = state.leases.get(mac);
  if (prev && prev.ip !== ip && state.byIp.get(prev.ip) === mac) state.byIp.delete(prev.ip);

  const holder = state.byIp.get(ip);
  if (holder && holder !== mac) state.leases.delete(holder);

  // An unlimited lease never lapses: `expiresStep` is Infinity, an instant no run reaches and that
  // expireLeases() therefore never collects. A saved document writes it as the word, because JSON has no
  // Infinity (see leaseStateToJSON).
  const expiresStep = infinite ? Infinity
    : step + (Math.max(1, Math.floor(leaseSec)) * STEP_SECONDS);
  // The pool name is kept with the lease so the server can answer "which pool is this address from" without
  // re-deriving it, and so a lease can be explained when the pool it came from is later edited (#1373).
  state.leases.set(mac, { ip: ip, expiresStep: expiresStep, pool: poolName || null, leaseSec: leaseSec });
  state.byIp.set(ip, mac);
  return expiresStep;
}

// ---------------------------------------------------------------------------
// pool membership
// ---------------------------------------------------------------------------

// True when `ip` is inside the pool's range, is not a network/broadcast
// address and is not excluded. Reservations are still *in* the pool, they are
// just pinned to one MAC, so they count here.
function ipInPool(pool, ip) {
  const p = normalizePool(pool);
  const n = parseIp(ip);
  if (n === null) return false;
  const range = rangeInts(p);
  if (range === null) return false;
  if (n < range.start || n > range.end) return false;
  if (isEndpointInt(p, n)) return false;
  if (isExcludedInt(p, n)) return false;
  return true;
}

// Lowest address in the pool that nothing claims: not a reservation, not
// excluded, not a live lease. Returns null when the pool is exhausted (or the
// range is unreadable).
function nextFreeIp(pool, state) {
  const p = normalizePool(pool);
  const s = stateOf(state);
  const range = rangeInts(p);
  if (range === null) return null;

  // The pool's gateway is the address the box answers on, so it is not an address the box may hand out.
  // `poolCapacity()` and `poolSummary()` have always counted it that way; the allocator did not, and a pool
  // whose range covered .1 offered .1 to the first client that asked - the router's own address, which is the
  // one address on the subnet a client can never use (research/dhcp-range-is-optional.md).
  const gw = parseIp(p.gateway);

  const reserved = {};
  for (const key of Object.keys(p.reservations)) {
    const n = parseIp(p.reservations[key]);
    if (n !== null) reserved[net.intToIp(n)] = true;
  }

  for (let n = range.start; n <= range.end; n++) {
    if (isEndpointInt(p, n)) continue;
    if (isExcludedInt(p, n)) continue;
    if (gw !== null && n === gw) continue;
    const ip = net.intToIp(n);
    if (reserved[ip]) continue;
    if (s.byIp.has(ip)) continue;
    return ip;
  }
  return null;
}

// Can this MAC take this address right now?
function isAllocatable(p, s, n, mac) {
  const range = rangeInts(p);
  if (range === null) return false;
  if (n < range.start || n > range.end) return false;
  if (isEndpointInt(p, n)) return false;
  if (isExcludedInt(p, n)) return false;
  // The gateway half of the same rule `nextFreeIp()` applies, so an OFFER and the REQUEST that follows it
  // cannot disagree about the one address the box answers on.
  const gw = parseIp(p.gateway);
  if (gw !== null && n === gw) return false;

  const ip = net.intToIp(n);
  const owner = reservationOwner(p, n);
  if (owner !== null && owner !== mac) return false;

  const holder = s.byIp.get(ip);
  if (holder && holder !== mac) return false;

  // A MAC that owns a reservation elsewhere may not take a different address:
  // the reservation always wins.
  const reserved = reservationFor(p, mac);
  if (reserved !== null && reserved !== ip) return false;

  return true;
}

// ---------------------------------------------------------------------------
// messages
// ---------------------------------------------------------------------------

function baseMessage(p, type, ip, leaseSec) {
  return {
    type: type,
    ip: ip,
    mask: p.mask,
    gateway: p.gateway,
    dns: (Array.isArray(p.dns) ? p.dns : []).slice(),
    leaseSec: leaseSec,
    server: serverId(p)
  };
}

function offerMessage(p, ip) {
  return baseMessage(p, DHCP_MESSAGE_TYPES.OFFER, ip, leaseSeconds(p));
}

function ackMessage(p, ip, mac, expiresStep) {
  const msg = baseMessage(p, DHCP_MESSAGE_TYPES.ACK, ip, leaseSeconds(p));
  msg.mac = mac;
  msg.expiresStep = expiresStep;
  return msg;
}

function nakMessage(p, reason, text) {
  const msg = baseMessage(p, DHCP_MESSAGE_TYPES.NAK, null, 0);
  msg.reason = reason;
  msg.message = text;
  return msg;
}

// ---------------------------------------------------------------------------
// DISCOVER -> OFFER
// ---------------------------------------------------------------------------

// Answer a DHCPDISCOVER with the address we would give this client:
// the reservation if it has one, else the address it asked for when that one
// is legitimately its own, else the lowest free address. null means "stay
// silent": bad MAC, invalid pool, or nothing left to allocate.
//
// OFFER is deliberately non-committing -- only handleRequest writes a lease.
function handleDiscover(pool, state, req) {
  const p = normalizePool(pool);
  const r = (req && typeof req === 'object') ? req : {};
  const s = stateOf(state);

  const mac = canonicalMac(r.mac);
  if (mac === null) return null;
  if (!validatePool(p).ok) return null;

  const reserved = reservationFor(p, mac);
  if (reserved !== null) {
    if (!ipInPool(p, reserved)) return null;
    return offerMessage(p, reserved);
  }

  const want = parseIp(r.requestedIp);
  if (want !== null && isAllocatable(p, s, want, mac)) {
    return offerMessage(p, net.intToIp(want));
  }

  // A client that already holds a lease is offered **the address it holds** (#1429).
  //
  // Without this the allocator answered every DISCOVER with the next free address, so a client that came back - a
  // renewal, a second ping in the same lab, any run at all - was moved to a different address, and two clients ended
  // up trading addresses on every request (.10 -> .12 -> .11 between runs). Nothing was broken in any single exchange;
  // the lab simply could not hold still, and every expectation written against an address was wrong a run later.
  const held = s.leases.get(mac);
  if (held && ipInPool(p, held.ip) && isAllocatable(p, s, parseIp(held.ip), mac)) {
    return offerMessage(p, held.ip);
  }

  const free = nextFreeIp(p, s);
  if (free === null) return null;
  return offerMessage(p, free);
}

// ---------------------------------------------------------------------------
// REQUEST -> ACK | NAK
// ---------------------------------------------------------------------------

// Answer a DHCPREQUEST.
//   ACK -- the address is in the pool and free, or already held by this MAC
//          (renewal: the lease time is extended).
//   NAK -- outside the pool/subnet, excluded, reserved for someone else, or
//          held by another MAC.
function handleRequest(pool, state, req) {
  const p = normalizePool(pool);
  const r = (req && typeof req === 'object') ? req : {};
  const s = stateOf(state);
  const step = stepOf(r.step);

  const mac = canonicalMac(r.mac);
  if (mac === null) {
    return nakMessage(p, 'BAD_MAC', 'DHCPREQUEST with no usable client MAC address.');
  }
  if (!validatePool(p).ok) {
    return nakMessage(p, 'BAD_POOL', 'DHCP pool ' + p.name + ' is not correctly configured.');
  }

  const want = parseIp(r.requestedIp);
  if (want === null) {
    return nakMessage(p, 'BAD_IP', 'DHCPREQUEST without a valid requested address.');
  }
  const ip = net.intToIp(want);

  const maskInt = maskIntOf(p);
  const netInt = networkIntOf(p);
  if (maskInt !== null && netInt !== null && ((want & maskInt) >>> 0) !== netInt) {
    return nakMessage(p, 'OUTSIDE_SUBNET', ip + ' is not on ' + p.network + '/' + prefixOfMask(maskInt) + '.');
  }

  const range = rangeInts(p);
  if (range === null || want < range.start || want > range.end) {
    return nakMessage(p, 'OUTSIDE_POOL', ip + ' is outside the pool range ' + rangeText(p) + '.');
  }
  if (isEndpointInt(p, want)) {
    return nakMessage(p, 'OUTSIDE_POOL', ip + ' is a network or broadcast address.');
  }
  if (isExcludedInt(p, want)) {
    return nakMessage(p, 'EXCLUDED', ip + ' is excluded from the pool.');
  }

  const holder = s.byIp.get(ip);
  if (holder && holder !== mac) {
    return nakMessage(p, 'CONFLICT', ip + ' is already leased to ' + holder + '.');
  }

  const reservedFor = reservationOwner(p, want);
  if (reservedFor !== null && reservedFor !== mac) {
    return nakMessage(p, 'RESERVED', ip + ' is reserved for ' + reservedFor + '.');
  }

  const reserved = reservationFor(p, mac);
  if (reserved !== null && reserved !== ip) {
    return nakMessage(p, 'RESERVED', mac + ' must use its reserved address ' + reserved + '.');
  }

  const expiresStep = recordLease(s, mac, ip, step, leaseSeconds(p), p.name, isInfiniteLease(p));
  return ackMessage(p, ip, mac, expiresStep);
}

// ---------------------------------------------------------------------------
// release / expiry / table
// ---------------------------------------------------------------------------

// Drop a MAC's lease (DHCPRELEASE). Returns true when a lease existed.
// `pool` is accepted for symmetry with the other entry points; releasing is a
// pure lease-table operation and never consults the pool.
function releaseLease(pool, state, mac) {
  void pool;
  const s = stateOf(state);
  const key = canonicalMac(mac);
  if (key === null) return false;

  const lease = s.leases.get(key);
  if (!lease) return false;

  s.leases.delete(key);
  if (s.byIp.get(lease.ip) === key) s.byIp.delete(lease.ip);
  return true;
}

// Release every lease whose expiresStep has been reached. Returns the count.
function expireLeases(state, step) {
  const s = stateOf(state);
  const now = stepOf(step);
  let released = 0;

  for (const mac of Array.from(s.leases.keys())) {
    const lease = s.leases.get(mac);
    if (!lease) continue;
    if (lease.expiresStep <= now) {
      s.leases.delete(mac);
      if (s.byIp.get(lease.ip) === mac) s.byIp.delete(lease.ip);
      released++;
    }
  }
  return released;
}

// Current bindings, ordered by address so output is stable across runs.
//
// `step` is optional: given one, each row also says which pool it came from, how long it was for, how much of it
// is left and whether it has lapsed. Without it the historical three-field shape is returned, so the table stays
// usable by anything that only wants the bindings. Nothing is dropped or hidden here - an expired lease is still
// a row, marked `expired`, because a console that silently forgets one cannot explain why an address is stuck.
function leaseTable(state, step) {
  const s = stateOf(state);
  const now = step === undefined || step === null ? null : stepOf(step);
  const rows = [];
  for (const mac of Array.from(s.leases.keys())) {
    const lease = s.leases.get(mac);
    if (!lease) continue;
    const row = { mac: mac, ip: lease.ip, expiresStep: lease.expiresStep };
    // The row's pool is the one the lease was granted from (#1429). It used to be undefined whenever the caller did
    // not pass `step`, so `show ip dhcp pool` printed "-" in the Pool column and counted 0 leases for a pool that was
    // holding them - the address and its pool are one fact, and it was being dropped half the time.
    if (row.pool === undefined) row.pool = lease.pool === undefined ? null : lease.pool;
    if (now !== null) {
      const expiresStep = Number(lease.expiresStep);
      row.pool = lease.pool === undefined ? null : lease.pool;
      row.leaseSec = lease.leaseSec === undefined ? null : lease.leaseSec;
      // An unlimited lease has no "left": saying `null` would read as "not measured", and the console would print
      // the same dash for a lease that never ends and one that no clock has been set for (#fidelity: lease
      // infinite). Infinity is the fact, and the console prints the vendor's word for it.
      row.remainingSec = lease.expiresStep === Infinity ? Infinity
        : (Number.isFinite(expiresStep) && Number.isFinite(now) ? expiresStep - now : null);
      row.state = lease.expiresStep === Infinity ? 'active'
        : (Number.isFinite(expiresStep) && Number.isFinite(now) && expiresStep <= now ? 'expired' : 'active');
    }
    rows.push(row);
  }
  rows.sort(function (a, b) {
    const ai = parseIp(a.ip);
    const bi = parseIp(b.ip);
    if (ai === null && bi === null) return a.mac < b.mac ? -1 : (a.mac > b.mac ? 1 : 0);
    if (ai === null) return 1;
    if (bi === null) return -1;
    return ai - bi;
  });
  return rows;
}

module.exports = {
  DHCP_MESSAGE_TYPES,
  INFINITE_LEASE,
  INFINITE_LEASE_SEC,
  isInfiniteLease,
  leaseSeconds,
  validatePool,
  normalizePool,
  ipInPool,
  nextFreeIp,
  createLeaseState,
  leaseStateToJSON,
  leaseStateFromJSON,
  handleDiscover,
  handleRequest,
  releaseLease,
  expireLeases,
  leaseTable,
  poolCapacity,
  poolSummary
};
