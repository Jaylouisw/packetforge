'use strict';
// bgp.js -- BGP-4 session FSM, peer validation and best-path selection as a
// pure logic problem.
//
// Like ospf.js there is no live protocol state here: validatePeer() gates a
// configuration, nextState() is a lookup table that walks the RFC 4271 finite
// state machine one event at a time, advertise() rewrites a route list as a
// peer would export it, and comparePaths()/bestPath() rank candidate paths the
// way a BGP table does. Callers re-run them after any config or topology
// change, so nothing in this module has to be kept in sync with a running
// session.
//
// Deliberate simplifications:
//   * one session per peer -- no peer groups, no templates, no AFI/SAFI
//     negotiation (everything is treated as IPv4 unicast)
//   * the FSM ignores real timers: holdTime is validated and carried around but
//     keepalive/hold expiration never fires here; the caller feeds events in
//   * MED is compared unconditionally -- real BGP only compares MED between
//     paths learned from the same neighbour AS
//   * paths are plain objects; the fields read are weight, localPreference,
//     asPath, origin, med, type/peerType, routerId, nextHop and from. Missing
//     fields take the documented defaults so two sparse paths still compare
//     deterministically.
//
// Everything is deterministic: no clocks, no randomness, no I/O. Inputs are
// never mutated -- advertise() and bestPath() work on copies. An AS_SET is
// represented as a nested array inside asPath (a segment that counts as one
// hop however many AS numbers it holds).

const net = require('./net');

const BGP_PORT = 179;

// RFC 4271 8.2.2 states, in the order a session walks them.
const BGP_STATES = ['idle', 'connect', 'active', 'opensent', 'openconfirm', 'established'];

// The events this model accepts. RFC timers (ConnectRetry, HoldTimer) are the
// caller's business; these are the ones a simulator can inject.
const BGP_EVENTS = [
  'manual-start',
  'tcp-connected',
  'open-received',
  'keepalive-received',
  'error',
  'manual-stop'
];

// RFC 4271 ORIGIN path attribute: lower wins in the decision process.
const BGP_ORIGIN = { IGP: 0, EGP: 1, INCOMPLETE: 2 };

const AS_MIN = 1;
const AS_MAX = 4294967295;      // 4-byte AS numbers
const HOLD_TIME_MAX = 65535;
const HOLD_TIME_MIN_NONZERO = 3; // RFC 4271: a non-zero hold time is >= 3s
const DEFAULT_HOLD_TIME = 180;
const DEFAULT_LOCAL_PREF = 100;
const DEFAULT_WEIGHT = 0;
const DEFAULT_MED = 0;

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isDottedQuad(v) {
  if (typeof v !== 'string' && typeof v !== 'number') return false;
  const s = String(v).trim();
  if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(s)) return false;
  try {
    net.ipToInt(s);
    return true;
  } catch (err) {
    return false;
  }
}

// Accepts an integer number or a blob of digits. Returns null when the value is
// not a legal 1..4294967295 AS number (0 is reserved and rejected).
function parseAs(v) {
  if (typeof v === 'number') {
    if (!Number.isInteger(v) || v < AS_MIN || v > AS_MAX) return null;
    return v;
  }
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!/^\d{1,10}$/.test(s)) return null;
  const n = parseInt(s, 10);
  if (!Number.isInteger(n) || n < AS_MIN || n > AS_MAX) return null;
  return n;
}

// holdTime is 0 (no keepalives) or 3..65535. Returns null when illegal.
function parseHoldTime(v) {
  if (typeof v === 'number') {
    if (!Number.isInteger(v)) return null;
    if (v === 0) return 0;
    if (v < HOLD_TIME_MIN_NONZERO || v > HOLD_TIME_MAX) return null;
    return v;
  }
  if (typeof v === 'string') {
    const s = v.trim();
    if (!/^\d{1,5}$/.test(s)) return null;
    return parseHoldTime(parseInt(s, 10));
  }
  return null;
}

// Numeric field with a default. Numeric strings are tolerated so a path built
// straight from parsed CLI output still compares.
function num(v, fallback) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

function sign(n) {
  if (n < 0) return -1;
  if (n > 0) return 1;
  return 0;
}

function pushError(errors, code, message) {
  errors.push({ code: code, message: message });
}

// ---------------------------------------------------------------------------
// peer validation
// ---------------------------------------------------------------------------

// validatePeer(cfg) -> { ok, errors: [{ code, message }] }
// cfg: { localAs, peerAs, localIp, peerIp, holdTime }
// holdTime is optional here (normalizePeer() applies the default); when present
// it must be 0 or 3..65535.
function validatePeer(cfg) {
  const errors = [];
  const src = isObject(cfg) ? cfg : {};

  const localAs = parseAs(src.localAs);
  const peerAs = parseAs(src.peerAs);

  if (localAs === null) {
    pushError(errors, 'BAD_LOCAL_AS',
      'localAs must be an integer in 1..4294967295 (4-byte AS numbers are allowed)');
  }
  if (peerAs === null) {
    pushError(errors, 'BAD_PEER_AS',
      'peerAs must be an integer in 1..4294967295 (4-byte AS numbers are allowed)');
  }

  if (!isDottedQuad(src.localIp)) {
    pushError(errors, 'BAD_LOCAL_IP', 'localIp must be a dotted-quad IPv4 address');
  }
  if (!isDottedQuad(src.peerIp)) {
    pushError(errors, 'BAD_PEER_IP', 'peerIp must be a dotted-quad IPv4 address');
  }

  if (isDottedQuad(src.localIp) && isDottedQuad(src.peerIp) &&
      net.ipToInt(String(src.localIp).trim()) === net.ipToInt(String(src.peerIp).trim())) {
    pushError(errors, 'PEER_SELF',
      'peerIp must differ from localIp -- a router cannot peer with itself');
  }

  const hold = src.holdTime;
  if (hold !== undefined && hold !== null && hold !== '') {
    if (parseHoldTime(hold) === null) {
      pushError(errors, 'BAD_HOLD_TIME',
        'holdTime must be 0 or 3..65535 seconds, got "' + String(hold) + '"');
    }
  }

  return { ok: errors.length === 0, errors: errors };
}

// normalizePeer(spec) -> { localAs, peerAs, localIp, peerIp, holdTime, routeReflectorClient }
// Lossy on purpose: unparseable values fall back to 0 / '' so the object always
// has the same shape. validatePeer() is the gate for correctness -- normalise
// first, validate the result, and only then build a session.
function normalizePeer(spec) {
  const src = isObject(spec) ? spec : {};

  const localAs = parseAs(src.localAs);
  const peerAs = parseAs(src.peerAs);
  const hold = parseHoldTime(src.holdTime);

  return {
    localAs: localAs === null ? 0 : localAs,
    peerAs: peerAs === null ? 0 : peerAs,
    localIp: (src.localIp === undefined || src.localIp === null) ? '' : String(src.localIp).trim(),
    peerIp: (src.peerIp === undefined || src.peerIp === null) ? '' : String(src.peerIp).trim(),
    holdTime: hold === null ? DEFAULT_HOLD_TIME : hold,
    routeReflectorClient: !!(src.routeReflectorClient || src.rrClient)
  };
}

// sessionType(localAs, peerAs) -> 'ebgp' | 'ibgp'
function sessionType(localAs, peerAs) {
  const a = parseAs(localAs);
  const b = parseAs(peerAs);
  if (a === null || b === null) {
    // Fall back to a raw comparison so a half-built config still classifies.
    return String(localAs) === String(peerAs) ? 'ibgp' : 'ebgp';
  }
  return a === b ? 'ibgp' : 'ebgp';
}

// ---------------------------------------------------------------------------
// finite state machine
// ---------------------------------------------------------------------------
//
// Table from RFC 4271 8.2.2, trimmed to the events a simulator injects. Only
// the transitions listed here exist; anything else leaves the state alone.
// 'error' and 'manual-stop' are legal from every state and always land in idle,
// which is what makes a teardown from any point in the walk safe.
const FSM = {
  idle: {
    'manual-start': 'connect',
    'manual-stop': 'idle',
    error: 'idle'
  },
  connect: {
    'tcp-connected': 'opensent',
    'manual-stop': 'idle',
    error: 'idle'
  },
  active: {
    'manual-start': 'connect',
    'tcp-connected': 'opensent',
    'manual-stop': 'idle',
    error: 'idle'
  },
  opensent: {
    'open-received': 'openconfirm',
    'manual-stop': 'idle',
    error: 'idle'
  },
  openconfirm: {
    'keepalive-received': 'established',
    'manual-stop': 'idle',
    error: 'idle'
  },
  established: {
    'keepalive-received': 'established', // steady state: keepalives are absorbed
    'manual-stop': 'idle',
    error: 'idle'
  }
};

// nextState(state, event) -> state
// An unknown event is a no-op. An unknown *state* is not a transition at all,
// so it resets to 'idle'.
function nextState(state, event) {
  const from = (typeof state === 'string') ? state : String(state);
  if (!Object.prototype.hasOwnProperty.call(FSM, from)) return 'idle';
  const row = FSM[from];
  const key = (typeof event === 'string') ? event : String(event);
  if (!Object.prototype.hasOwnProperty.call(row, key)) return from;
  return row[key];
}

// ---------------------------------------------------------------------------
// path attributes
// ---------------------------------------------------------------------------

// AS_SET segments are nested arrays; every segment counts as one hop.
function asPathLength(asPath) {
  if (!Array.isArray(asPath)) return 0;
  let hops = 0;
  for (let i = 0; i < asPath.length; i++) {
    const seg = asPath[i];
    if (seg === null || seg === undefined) continue;
    if (Array.isArray(seg)) {
      if (seg.length > 0) hops++; // AS_SET counts as 1 no matter its size
    } else if (isObject(seg)) {
      hops++;                     // { type: 'set', asns: [...] } or similar
    } else {
      hops++;
    }
  }
  return hops;
}

function asSegments(asPath) {
  const out = [];
  if (!Array.isArray(asPath)) return out;
  for (let i = 0; i < asPath.length; i++) {
    const seg = asPath[i];
    if (Array.isArray(seg)) {
      for (let j = 0; j < seg.length; j++) out.push(seg[j]);
    } else if (isObject(seg) && Array.isArray(seg.asns)) {
      for (let j = 0; j < seg.asns.length; j++) out.push(seg.asns[j]);
    } else {
      out.push(seg);
    }
  }
  return out;
}

// pathIsLoopFree(asPath, asNumber) -> bool
// True when the local AS does not appear anywhere in the path (AS_SET members
// included). An unparseable AS number can never match, so such a path counts as
// loop-free.
function pathIsLoopFree(asPath, asNumber) {
  const target = parseAs(asNumber);
  if (target === null) return true;
  const members = asSegments(asPath);
  for (let i = 0; i < members.length; i++) {
    const as = parseAs(members[i]);
    if (as !== null && as === target) return false;
  }
  return true;
}

function copyAsPath(asPath) {
  if (!Array.isArray(asPath)) return [];
  const out = [];
  for (let i = 0; i < asPath.length; i++) {
    const seg = asPath[i];
    out.push(Array.isArray(seg) ? seg.slice() : seg);
  }
  return out;
}

function originCode(v) {
  if (typeof v === 'number') {
    if (v === BGP_ORIGIN.IGP || v === BGP_ORIGIN.EGP || v === BGP_ORIGIN.INCOMPLETE) return v;
    return BGP_ORIGIN.INCOMPLETE;
  }
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (s === 'igp' || s === 'i') return BGP_ORIGIN.IGP;
    if (s === 'egp' || s === 'e') return BGP_ORIGIN.EGP;
    if (s === 'incomplete' || s === '?') return BGP_ORIGIN.INCOMPLETE;
  }
  return BGP_ORIGIN.INCOMPLETE;
}

// A path is locally originated when it was injected by this router: an explicit
// flag, from === 'local', or the BGP convention of next hop 0.0.0.0.
function isLocalPath(p) {
  if (p.local === true || p.originated === true || p.locallyOriginated === true) return true;
  if (typeof p.from === 'string' && p.from.trim().toLowerCase() === 'local') return true;
  if (typeof p.nextHop === 'string' && p.nextHop.trim() === '0.0.0.0') return true;
  return false;
}

// 0 = eBGP, 1 = iBGP. Unknown counts as iBGP so an explicit eBGP path wins and
// the result never depends on field ordering.
function pathRank(p) {
  const raw = p.type || p.peerType || p.sessionType;
  if (typeof raw === 'string') {
    const s = raw.trim().toLowerCase();
    if (s === 'ebgp' || s === 'e-bgp' || s === 'external') return 0;
    if (s === 'ibgp' || s === 'i-bgp' || s === 'internal') return 1;
  }
  const a = parseAs(p.localAs);
  const b = parseAs(p.peerAs);
  if (a !== null && b !== null) return a === b ? 1 : 0;
  return 1;
}

function routerIdInt(v) {
  if (typeof v === 'number') {
    if (!Number.isInteger(v) || v < 0 || v > 4294967295) return null;
    return v >>> 0;
  }
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(s)) return null;
  try {
    return net.ipToInt(s);
  } catch (err) {
    return null;
  }
}

// Lower router ID wins. A path with no router ID sorts last.
function compareRouterId(a, b) {
  const x = routerIdInt(a);
  const y = routerIdInt(b);
  if (x === null && y === null) {
    const sa = (a === undefined || a === null) ? '' : String(a);
    const sb = (b === undefined || b === null) ? '' : String(b);
    if (sa === sb) return 0;
    return sa < sb ? -1 : 1;
  }
  if (x === null) return 1;
  if (y === null) return -1;
  return sign(x - y);
}

// comparePaths(a, b) -> negative | 0 | positive
// Negative means a is better. Standard BGP decision order, one tie-break per
// step, every field defaulted so sparse paths still rank deterministically:
//   1. higher weight
//   2. higher local preference
//   3. locally originated
//   4. shorter AS path (AS_SET = 1)
//   5. lower origin (IGP < EGP < INCOMPLETE)
//   6. lower MED
//   7. eBGP over iBGP
//   8. lower router ID
function comparePaths(a, b) {
  const x = isObject(a) ? a : {};
  const y = isObject(b) ? b : {};
  let d;

  d = num(y.weight, DEFAULT_WEIGHT) - num(x.weight, DEFAULT_WEIGHT);
  if (d !== 0) return sign(d);

  d = num(y.localPreference, DEFAULT_LOCAL_PREF) - num(x.localPreference, DEFAULT_LOCAL_PREF);
  if (d !== 0) return sign(d);

  const lx = isLocalPath(x);
  const ly = isLocalPath(y);
  if (lx !== ly) return lx ? -1 : 1;

  d = asPathLength(x.asPath) - asPathLength(y.asPath);
  if (d !== 0) return sign(d);

  d = originCode(x.origin) - originCode(y.origin);
  if (d !== 0) return sign(d);

  d = num(x.med, DEFAULT_MED) - num(y.med, DEFAULT_MED);
  if (d !== 0) return sign(d);

  d = pathRank(x) - pathRank(y);
  if (d !== 0) return sign(d);

  return compareRouterId(x.routerId, y.routerId);
}

// --- prefix tie-breaking (bestPath only) ----------------------------------

// Parses '10.0.0.0/24' (or { prefix: '10.0.0.0/24' }) into comparable parts.
function prefixParts(v) {
  const raw = isObject(v) ? String(v.prefix === undefined ? '' : v.prefix) : String(v === undefined || v === null ? '' : v);
  const s = raw.trim();
  const slash = s.indexOf('/');
  if (slash === -1) return { net: null, len: null, raw: s };
  const ip = s.slice(0, slash);
  const lenStr = s.slice(slash + 1);
  if (!isDottedQuad(ip) || !/^\d{1,2}$/.test(lenStr)) return { net: null, len: null, raw: s };
  const len = parseInt(lenStr, 10);
  if (len < 0 || len > 32) return { net: null, len: null, raw: s };
  return { net: net.ipToInt(ip), len: len, raw: s };
}

function comparePrefix(a, b) {
  const x = prefixParts(a);
  const y = prefixParts(b);
  if (x.net !== null && y.net !== null) {
    if (x.net !== y.net) return x.net < y.net ? -1 : 1;
    if (x.len !== y.len) return x.len < y.len ? -1 : 1;
  } else if (x.net !== null) {
    return -1;
  } else if (y.net !== null) {
    return 1;
  }
  if (x.raw === y.raw) return 0;
  return x.raw < y.raw ? -1 : 1;
}

function compareForBest(a, b) {
  const d = comparePaths(a, b);
  if (d !== 0) return d;
  const r = compareRouterId(a.routerId, b.routerId);
  if (r !== 0) return r;
  return comparePrefix(a.prefix, b.prefix);
}

// bestPath(candidates) -> candidate | null
// Sorts a copy, so the caller's array keeps its order. Returns the object it was
// given (not a clone) so callers can keep their own bookkeeping attached.
function bestPath(candidates) {
  if (!Array.isArray(candidates)) return null;
  const list = [];
  for (let i = 0; i < candidates.length; i++) {
    if (isObject(candidates[i])) list.push(candidates[i]);
  }
  if (list.length === 0) return null;
  list.sort(compareForBest);
  return list[0];
}

// ---------------------------------------------------------------------------
// advertisement
// ---------------------------------------------------------------------------

// advertise(routes, opts) -> [{ prefix, nextHop, asPath, origin, localPreference, med, from }]
// opts: { localAs, type: 'ebgp'|'ibgp', nextHop }
//   * eBGP prepends localAs to the AS path, iBGP does not (the next hop and the
//     AS path of an iBGP-learned route are carried unchanged inside the AS)
//   * the next hop is opts.nextHop when supplied, otherwise the route's own
//   * type defaults to iBGP, so an unspecified advertisement never rewrites the
//     AS path
// Never mutates the input routes: every AS path is copied, AS_SETs included.
function advertise(routes, opts) {
  const o = isObject(opts) ? opts : {};
  const list = Array.isArray(routes) ? routes : [];

  const localAs = parseAs(o.localAs);
  let type = (o.type === 'ebgp' || o.type === 'ibgp') ? o.type : null;
  if (type === null) {
    const peerAs = parseAs(o.peerAs);
    type = (localAs !== null && peerAs !== null) ? sessionType(localAs, peerAs) : 'ibgp';
  }
  const nextHopOverride = (typeof o.nextHop === 'string' && o.nextHop.trim() !== '')
    ? o.nextHop.trim()
    : null;

  const out = [];
  for (let i = 0; i < list.length; i++) {
    const route = list[i];
    if (!isObject(route)) continue;

    const path = copyAsPath(route.asPath);
    const asPath = (type === 'ebgp' && localAs !== null) ? [localAs].concat(path) : path;

    let nextHop = null;
    if (nextHopOverride !== null) nextHop = nextHopOverride;
    else if (typeof route.nextHop === 'string' && route.nextHop.trim() !== '') nextHop = route.nextHop.trim();

    out.push({
      prefix: (route.prefix === undefined) ? null : route.prefix,
      nextHop: nextHop,
      asPath: asPath,
      origin: originCode(route.origin),
      localPreference: num(route.localPreference, DEFAULT_LOCAL_PREF),
      med: num(route.med, DEFAULT_MED),
      from: (route.from === undefined) ? null : route.from
    });
  }
  return out;
}

module.exports = {
  BGP_PORT,
  BGP_STATES,
  BGP_EVENTS,
  BGP_ORIGIN,
  DEFAULT_HOLD_TIME,
  DEFAULT_LOCAL_PREF,
  validatePeer,
  normalizePeer,
  sessionType,
  nextState,
  comparePaths,
  bestPath,
  advertise,
  asPathLength,
  pathIsLoopFree
};
