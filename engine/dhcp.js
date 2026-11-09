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

  const rawLease = (s.leaseSec === undefined || s.leaseSec === null || s.leaseSec === '')
    ? DEFAULT_LEASE_SEC
    : Number(s.leaseSec);
  const leaseSec = (Number.isFinite(rawLease) && rawLease > 0) ? Math.floor(rawLease) : rawLease;

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

function maskIntOf(p) { return parseMask(p.mask); }
function networkIntOf(p) { return parseIp(p.network); }
function rangeInts(p) {
  const start = parseIp(p.rangeStart);
  const end = parseIp(p.rangeEnd);
  if (start === null || end === null) return null;
  return { start: start, end: end };
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

function leaseSeconds(p) {
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
  if (p.rangeStart === '' || p.rangeEnd === '') {
    err('E_DHCP_BAD_RANGE', where + 'both rangeStart and rangeEnd are required.');
  } else {
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
        p.rangeStart + '-' + p.rangeEnd + '.');
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
  if (!Number.isFinite(lease) || lease <= 0) {
    err('E_DHCP_BAD_LEASE', where + 'leaseSec "' + p.leaseSec + '" must be a positive number of seconds.');
  }

  // --- is anything left to hand out? --------------------------------------
  if (range !== null && parseIp(p.rangeStart) !== null && parseIp(p.rangeEnd) !== null &&
    parseIp(p.rangeStart) <= parseIp(p.rangeEnd)) {
    let usable = 0;
    for (let n = parseIp(p.rangeStart); n <= parseIp(p.rangeEnd); n++) {
      if (isEndpointInt(p, n)) continue;
      if (isExcludedInt(p, n)) continue;
      const owner = reservationOwner(p, n);
      if (owner !== null) continue;
      usable++;
      break;
    }
    if (usable === 0) {
      err('E_DHCP_NO_HOSTS',
        where + 'every address in ' + p.rangeStart + '-' + p.rangeEnd +
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

// Never trust the caller's state object; rebuild it if it is not the shape we
// expect (a simulator restart, a fresh device, a hand-written test fixture).
function stateOf(state) {
  if (state && state.leases instanceof Map && state.byIp instanceof Map) return state;
  return createLeaseState();
}

// Commit a lease, keeping both maps consistent: a MAC holds at most one
// address, an address belongs to at most one MAC.
function recordLease(state, mac, ip, step, leaseSec) {
  const prev = state.leases.get(mac);
  if (prev && prev.ip !== ip && state.byIp.get(prev.ip) === mac) state.byIp.delete(prev.ip);

  const holder = state.byIp.get(ip);
  if (holder && holder !== mac) state.leases.delete(holder);

  const expiresStep = step + (Math.max(1, Math.floor(leaseSec)) * STEP_SECONDS);
  state.leases.set(mac, { ip: ip, expiresStep: expiresStep });
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

  const reserved = {};
  for (const key of Object.keys(p.reservations)) {
    const n = parseIp(p.reservations[key]);
    if (n !== null) reserved[net.intToIp(n)] = true;
  }

  for (let n = range.start; n <= range.end; n++) {
    if (isEndpointInt(p, n)) continue;
    if (isExcludedInt(p, n)) continue;
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
    return nakMessage(p, 'OUTSIDE_POOL', ip + ' is outside the pool range ' +
      p.rangeStart + '-' + p.rangeEnd + '.');
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

  const expiresStep = recordLease(s, mac, ip, step, leaseSeconds(p));
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
function leaseTable(state) {
  const s = stateOf(state);
  const rows = [];
  for (const mac of Array.from(s.leases.keys())) {
    const lease = s.leases.get(mac);
    if (!lease) continue;
    rows.push({ mac: mac, ip: lease.ip, expiresStep: lease.expiresStep });
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
  validatePool,
  normalizePool,
  ipInPool,
  nextFreeIp,
  createLeaseState,
  handleDiscover,
  handleRequest,
  releaseLease,
  expireLeases,
  leaseTable
};
