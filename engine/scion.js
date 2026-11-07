'use strict';
// scion.js -- SCION (Scalability, Control and Isolation On Next-generation
// networks) path model, computed as a pure graph problem.
//
// Three concepts, no packets and no state:
//   ISD  Isolation Domain -- a group of ASes that share a trust root, written
//        as a 16-bit decimal number (0-65535).
//   AS   Autonomous System inside an ISD, written as 1-4 hex digit groups
//        separated by ':' (e.g. ff00:0:110). A globally unique AS is written
//        ISD-AS, e.g. '1-ff00:0:110'.
//   SEG  a path segment -- UP (non-core AS up to a core AS), CORE (core to
//        core) or DOWN (core down to a non-core AS). A segment carries the
//        ordered ISD-AS hops it is built from.
//
// A usable SCION path is therefore an UP segment, optionally a CORE segment,
// and a DOWN segment -- see ALLOWED_SHAPES. Traffic between two non-core ASes
// always goes up -> (core) -> down, which is exactly what buildPath() enforces
// and what beaconing() hands out.
//
// The underlay that actually carries the SCION/UDP datagrams is plain IPv4
// (SCION_UDP_PORT), which is why endpoints look like
// '1-ff00:0:110,[192.0.2.1]:30041'.
//
// Everything here is deterministic: no clocks, no randomness, and every list
// that leaves the module is sorted, so the same segments always produce the
// same selected path and the same beacon set no matter what order the caller
// listed paths, cores or neighbours in.

const net = require('./net');

// UDP port every SCION router listens on for the underlay.
const SCION_UDP_PORT = 30041;

const PATH_TYPES = {
  UP: 'up',
  CORE: 'core',
  DOWN: 'down'
};

const SEGMENT_TYPES = [PATH_TYPES.UP, PATH_TYPES.CORE, PATH_TYPES.DOWN];

// Path compositions that carry traffic. Anything else (a lone DOWN segment, an
// UP followed by an UP, a CORE in the middle of two CORE segments, ...) is not
// a SCION path and is rejected by buildPath().
const ALLOWED_SHAPES = [
  [PATH_TYPES.UP, PATH_TYPES.DOWN],
  [PATH_TYPES.UP, PATH_TYPES.CORE, PATH_TYPES.DOWN],
  [PATH_TYPES.CORE, PATH_TYPES.DOWN],
  [PATH_TYPES.UP, PATH_TYPES.CORE]
];

const DEFAULT_MTU = 1500;          // SCION-capable Ethernet MTU
const MIN_MTU = 68;                // IPv4 minimum reassembly buffer
const MAX_MTU = 65535;
const DEFAULT_HOP_LATENCY_MS = 1;  // per hop, only used when a segment gives none

const MAX_ISD = 65535;
const MAX_PORT = 65535;

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

function compareStrings(a, b) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function pushError(list, code, message) {
  list.push({ code: code, message: message });
}

function trimString(v) {
  return (v === null || v === undefined) ? '' : String(v).trim();
}

function isHexGroup(g) {
  return /^[0-9a-fA-F]{1,4}$/.test(String(g));
}

// Leading zeros carry no meaning in a hex AS id group, so drop them: the
// canonical form of 'ff00:00:0110' is 'ff00:0:110'. Every id this module
// returns or compares is canonical, which is what makes joins and avoid-lists
// match no matter how the caller capitalised or zero-padded them.
function canonicalHexGroup(g) {
  const lower = String(g).toLowerCase();
  const stripped = lower.replace(/^0+/, '');
  return stripped === '' ? '0' : stripped;
}

function canonicalAsHex(asHex) {
  const raw = trimString(asHex);
  if (!raw) return null;
  const parts = raw.split(':');
  const out = [];
  for (const p of parts) {
    if (!isHexGroup(p)) return null;
    out.push(canonicalHexGroup(p));
  }
  return out.join(':');
}

function normalizeIsd(v) {
  const s = trimString(v);
  if (!s || !/^\d+$/.test(s)) return null;
  const n = parseInt(s, 10);
  if (!Number.isFinite(n) || n < 0 || n > MAX_ISD) return null;
  return n;
}

function numberOr(v, fallback) {
  if (v === null || v === undefined || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function padRight(s, width) {
  let out = String(s);
  while (out.length < width) out += ' ';
  return out;
}

// ---------------------------------------------------------------------------
// ISD-AS identifiers
// ---------------------------------------------------------------------------

// Shared parser. Returns { isd, asHex, errors, error } where isd/asHex are only
// filled in when that half parsed cleanly; errors collects every complaint so
// validateIsdAs() can report more than the first one.
function checkIsdAs(input) {
  const errors = [];
  const out = { isd: null, asHex: null, errors: null, error: null };
  const raw = trimString(input);

  if (!raw) {
    pushError(errors, 'ISD_AS_EMPTY', 'ISD-AS id is required (expected e.g. 1-ff00:0:110)');
    out.errors = errors;
    out.error = errors[0].message;
    return out;
  }

  const dash = raw.indexOf('-');
  if (dash === -1) {
    pushError(errors, 'ISD_AS_BAD_FORMAT',
      '"' + raw + '" is missing the "-" between ISD and AS (expected e.g. 1-ff00:0:110)');
  } else if (raw.indexOf('-', dash + 1) !== -1) {
    pushError(errors, 'ISD_AS_BAD_FORMAT',
      '"' + raw + '" has more than one "-" (expected exactly one, e.g. 1-ff00:0:110)');
  } else {
    const isdPart = raw.slice(0, dash).trim();
    const asPart = raw.slice(dash + 1).trim();

    if (!isdPart) {
      pushError(errors, 'ISD_AS_BAD_ISD', 'ISD part is empty in "' + raw + '"');
    } else if (!/^\d+$/.test(isdPart)) {
      pushError(errors, 'ISD_AS_BAD_ISD',
        'ISD "' + isdPart + '" must be a decimal number 0-' + MAX_ISD);
    } else {
      const isd = parseInt(isdPart, 10);
      if (isd < 0 || isd > MAX_ISD) {
        pushError(errors, 'ISD_AS_ISD_RANGE',
          'ISD ' + isdPart + ' is out of range (0-' + MAX_ISD + ')');
      } else {
        out.isd = isd;
      }
    }

    if (!asPart) {
      pushError(errors, 'ISD_AS_EMPTY_AS', 'AS part is empty in "' + raw + '"');
    } else {
      const groups = asPart.split(':');
      const canon = [];
      let ok = true;
      for (const g of groups) {
        if (g === '') {
          pushError(errors, 'ISD_AS_EMPTY_GROUP',
            'AS "' + asPart + '" has an empty group (no leading, trailing or doubled ":")');
          ok = false;
          break;
        }
        if (!isHexGroup(g)) {
          pushError(errors, 'ISD_AS_BAD_GROUP',
            'AS group "' + g + '" must be 1-4 hex digits');
          ok = false;
          break;
        }
        canon.push(canonicalHexGroup(g));
      }
      if (ok) out.asHex = canon.join(':');
    }
  }

  out.errors = errors;
  out.error = errors.length ? errors[0].message : null;
  return out;
}

function validateIsdAs(str) {
  const c = checkIsdAs(str);
  return { ok: c.errors.length === 0, errors: c.errors };
}

// '1-ff00:0:110' -> { isd: 1, asHex: 'ff00:0:110', asId: '1-ff00:0:110',
//                     valid: true, error: null }
// asId is the canonical full ISD-AS string, i.e. formatIsdAs(isd, asHex).
function parseIsdAs(str) {
  const c = checkIsdAs(str);
  if (c.errors.length !== 0) {
    return { isd: null, asHex: null, asId: null, valid: false, error: c.error };
  }
  return {
    isd: c.isd,
    asHex: c.asHex,
    asId: c.isd + '-' + c.asHex,
    valid: true,
    error: null
  };
}

function formatIsdAs(isd, asHex) {
  // Convenience: formatIsdAs('1-FF00:0:110') reformats an existing id.
  if (asHex === undefined && typeof isd === 'string' && isd.indexOf('-') !== -1) {
    const p = parseIsdAs(isd);
    return p.valid ? p.asId : '';
  }
  const d = normalizeIsd(isd);
  const h = canonicalAsHex(asHex);
  if (d === null || h === null) return '';
  return d + '-' + h;
}

function canonicalIsdAs(v) {
  const p = parseIsdAs(v);
  return p.valid ? p.asId : null;
}

// Canonical id when the value is a valid ISD-AS, otherwise the trimmed input --
// so hand-built fixtures with junk still flow through to validation instead of
// silently turning into ''.
function canonicalOrRaw(v) {
  const c = canonicalIsdAs(v);
  return (c === null) ? trimString(v) : c;
}

// Documented core-AS rule: an AS whose hex id ends in ':0' is a core AS.
// Canonicalisation strips leading zeros, so the trailing group really has to
// be '0' -- 'ff00:0:0' and 'ff00:100:0' are core, 'ff00:0:110' is not.
// Accepts both a bare hex id ('ff00:0:0') and a full ISD-AS ('1-ff00:0:0').
function isCore(asId) {
  const raw = trimString(asId);
  if (!raw) return false;

  let hex;
  if (raw.indexOf('-') !== -1) {
    const p = parseIsdAs(raw);
    if (!p.valid) return false;
    hex = p.asHex;
  } else {
    hex = canonicalAsHex(raw);
    if (hex === null) return false;
  }
  return /:0$/.test(hex);
}

// ---------------------------------------------------------------------------
// endpoints
// ---------------------------------------------------------------------------

function isValidIpv4(s) {
  const raw = trimString(s);
  if (!raw || !net.isIp(raw)) return false;
  try {
    net.ipToInt(raw); // range-checks the octets, which net.isIp only shape-checks
    return true;
  } catch (err) {
    return false;
  }
}

// '1-ff00:0:110,[192.0.2.1]'          -> port null
// '1-ff00:0:110,[192.0.2.1]:30041'    -> port 30041
// The brackets are optional ('1-ff00:0:110,192.0.2.1:30041' works too) but they
// are what formatEndpoint() emits, so round-trips are always canonical.
function parseEndpoint(input) {
  const out = { isdAs: null, ip: null, port: null, valid: false, error: null };
  const raw = trimString(input);
  if (!raw) {
    out.error = 'endpoint is required (expected e.g. 1-ff00:0:110,[192.0.2.1])';
    return out;
  }

  const comma = raw.indexOf(',');
  if (comma === -1) {
    out.error = '"' + raw + '" is missing the "," after the ISD-AS id';
    return out;
  }

  const isdAsRaw = raw.slice(0, comma).trim();
  const tail = raw.slice(comma + 1).trim();

  const parsed = parseIsdAs(isdAsRaw);
  if (!parsed.valid) {
    out.error = 'bad ISD-AS "' + isdAsRaw + '": ' + parsed.error;
    return out;
  }
  if (!tail) {
    out.error = 'endpoint "' + raw + '" has no underlay IP address';
    return out;
  }

  let host = tail;
  let portText = null;
  if (tail.charAt(0) === '[') {
    const close = tail.indexOf(']');
    if (close === -1) {
      out.error = 'unterminated "[" in "' + tail + '"';
      return out;
    }
    host = tail.slice(1, close).trim();
    const after = tail.slice(close + 1).trim();
    if (after) {
      if (after.charAt(0) !== ':') {
        out.error = 'unexpected "' + after + '" after "]" (expected ":port")';
        return out;
      }
      portText = after.slice(1).trim();
    }
  } else {
    const colon = tail.indexOf(':');
    if (colon !== -1) {
      host = tail.slice(0, colon).trim();
      portText = tail.slice(colon + 1).trim();
    }
  }

  if (!host) {
    out.error = 'endpoint "' + raw + '" has no underlay IP address';
    return out;
  }
  if (!isValidIpv4(host)) {
    out.error = '"' + host + '" is not a valid IPv4 address';
    return out;
  }

  let port = null;
  if (portText !== null) {
    if (!/^\d+$/.test(portText)) {
      out.error = 'port "' + portText + '" must be a decimal number 1-' + MAX_PORT;
      return out;
    }
    const n = parseInt(portText, 10);
    if (n < 1 || n > MAX_PORT) {
      out.error = 'port ' + portText + ' is out of range (1-' + MAX_PORT + ')';
      return out;
    }
    port = n;
  }

  out.isdAs = parsed.asId;
  out.ip = host;
  out.port = port;
  out.valid = true;
  out.error = null;
  return out;
}

// Inverse of parseEndpoint(); a string argument is normalised through the
// parser first, so formatEndpoint('1-FF00:0:110,[192.0.2.1]') is canonical too.
function formatEndpoint(ep) {
  if (ep === null || ep === undefined) return '';
  const src = (typeof ep === 'string') ? parseEndpoint(ep) : ep;
  if (!src || typeof src !== 'object') return '';

  const isdAs = canonicalOrRaw(src.isdAs);
  const ip = trimString(src.ip);
  if (!isdAs || !ip) return '';

  let port = null;
  const p = Number(src.port);
  if (src.port !== null && src.port !== undefined && src.port !== '' &&
      Number.isInteger(p) && p > 0 && p <= MAX_PORT) {
    port = p;
  }
  return isdAs + ',[' + ip + ']' + (port === null ? '' : ':' + port);
}

// ---------------------------------------------------------------------------
// segments
// ---------------------------------------------------------------------------

function normalizeSegmentType(v) {
  return trimString(v).toLowerCase();
}

function isSegmentType(v) {
  return SEGMENT_TYPES.indexOf(normalizeSegmentType(v)) !== -1;
}

// spec: { id, type: 'up'|'core'|'down', from: isdAs, to: isdAs, hops: [isdAs],
//         mtu, latencyMs }
// Everything is defaulted and canonicalised, and hops is always copied, so the
// caller's spec object is never aliased by the returned segment.
function createSegment(spec) {
  const src = (spec && typeof spec === 'object') ? spec : {};

  const type = normalizeSegmentType(src.type);
  const from = canonicalOrRaw(src.from);
  const to = canonicalOrRaw(src.to);

  const hopsIn = Array.isArray(src.hops) ? src.hops : [];
  const hops = [];
  for (const h of hopsIn) hops.push(canonicalOrRaw(h));

  const mtu = Math.trunc(numberOr(src.mtu, DEFAULT_MTU));
  const latencyMs = numberOr(src.latencyMs, hops.length * DEFAULT_HOP_LATENCY_MS);

  const rawId = trimString(src.id);
  const id = rawId ? rawId : (type + ':' + from + '>' + to);

  return {
    id: id,
    type: type,
    from: from,
    to: to,
    hops: hops,
    mtu: mtu,
    latencyMs: latencyMs
  };
}

function validateSegment(seg) {
  const errors = [];
  const src = (seg && typeof seg === 'object') ? seg : {};

  const type = normalizeSegmentType(src.type);
  if (!type) {
    pushError(errors, 'SEG_BAD_TYPE', 'type is required (one of up, core, down)');
  } else if (!isSegmentType(type)) {
    pushError(errors, 'SEG_BAD_TYPE',
      'type "' + type + '" must be one of up, core, down');
  }

  const from = canonicalIsdAs(src.from);
  if (!from) {
    pushError(errors, 'SEG_BAD_FROM',
      'from "' + trimString(src.from) + '" is not a valid ISD-AS id');
  }

  const to = canonicalIsdAs(src.to);
  if (!to) {
    pushError(errors, 'SEG_BAD_TO',
      'to "' + trimString(src.to) + '" is not a valid ISD-AS id');
  }

  if (from && to && from === to) {
    pushError(errors, 'SEG_SAME_ENDS',
      'from and to must differ (both are "' + from + '")');
  }

  if (!Array.isArray(src.hops) || src.hops.length === 0) {
    pushError(errors, 'SEG_NO_HOPS', 'hops must be a non-empty array of ISD-AS ids');
  } else {
    for (let i = 0; i < src.hops.length; i++) {
      const hopRaw = trimString(src.hops[i]);
      if (!canonicalIsdAs(src.hops[i])) {
        pushError(errors, 'SEG_BAD_HOP',
          'hops[' + i + '] "' + hopRaw + '" is not a valid ISD-AS id');
      }
    }
  }

  if (src.mtu !== undefined && src.mtu !== null && src.mtu !== '') {
    const mtu = Number(src.mtu);
    if (!Number.isInteger(mtu) || mtu < MIN_MTU || mtu > MAX_MTU) {
      pushError(errors, 'SEG_BAD_MTU',
        'mtu must be an integer ' + MIN_MTU + '-' + MAX_MTU + ' (got "' + src.mtu + '")');
    }
  }

  if (src.latencyMs !== undefined && src.latencyMs !== null && src.latencyMs !== '') {
    const lat = Number(src.latencyMs);
    if (!Number.isFinite(lat) || lat < 0) {
      pushError(errors, 'SEG_BAD_LATENCY',
        'latencyMs must be a number >= 0 (got "' + src.latencyMs + '")');
    }
  }

  return { ok: errors.length === 0, errors: errors };
}

// ---------------------------------------------------------------------------
// paths
// ---------------------------------------------------------------------------

function segmentsOf(path) {
  if (Array.isArray(path)) return path;
  if (path && typeof path === 'object' && Array.isArray(path.segments)) return path.segments;
  return [];
}

// The hop list of one segment, always starting at `from` and ending at `to`.
function segmentHops(seg) {
  const src = (seg && typeof seg === 'object') ? seg : {};
  const out = [];

  const raw = Array.isArray(src.hops) ? src.hops : [];
  for (const h of raw) {
    const id = canonicalOrRaw(h);
    if (!id) continue;
    if (out.length === 0 || out[out.length - 1] !== id) out.push(id);
  }

  const from = canonicalOrRaw(src.from);
  const to = canonicalOrRaw(src.to);
  if (from && (out.length === 0 || out[0] !== from)) out.unshift(from);
  if (to && (out.length === 0 || out[out.length - 1] !== to)) out.push(to);
  return out;
}

// Flattened hop list, dropping the duplicate a segment boundary produces: an UP
// segment ending at a core and the DOWN segment starting at that same core
// contribute the core once.
function pathHops(path) {
  const segs = segmentsOf(path);
  const out = [];
  for (const seg of segs) {
    for (const hop of segmentHops(seg)) {
      if (out.length === 0 || out[out.length - 1] !== hop) out.push(hop);
    }
  }
  return out;
}

function pathLatency(path) {
  const segs = segmentsOf(path);
  let total = 0;
  for (const seg of segs) {
    total += numberOr(seg && seg.latencyMs, 0);
  }
  // Segments carry small decimals at most; trim float noise so 0.1+0.2 == 0.3.
  return Math.round(total * 1000) / 1000;
}

function pathMtu(path) {
  const segs = segmentsOf(path);
  if (segs.length === 0) return 0;
  let mtu = Infinity;
  for (const seg of segs) {
    const v = numberOr(seg && seg.mtu, DEFAULT_MTU);
    if (v < mtu) mtu = v;
  }
  return mtu === Infinity ? DEFAULT_MTU : mtu;
}

function shapeKey(types) {
  return types.join(',');
}

// Valid compositions only: [UP, DOWN], [UP, CORE, DOWN], [CORE, DOWN],
// [UP, CORE]. On top of the shape, consecutive segments must actually join: the
// `to` of one segment has to be the `from` of the next, because that shared AS
// is where the path changes direction.
function buildPath(segments) {
  const list = Array.isArray(segments) ? segments.slice() : [];

  // A rejected path still carries the segments it was built from (and the hops
  // they flatten to) so 'show scion paths' can render what was refused and why;
  // only `valid` decides whether the path may be used.
  const fail = function (code, message) {
    return {
      segments: list,
      hops: pathHops(list),
      valid: false,
      error: { code: code, message: message }
    };
  };

  if (list.length === 0) {
    return fail('PATH_NO_SEGMENTS', 'a SCION path needs at least one path segment');
  }

  // --- 1. shape -----------------------------------------------------------
  const types = [];
  for (const seg of list) types.push(normalizeSegmentType(seg && seg.type));

  const shape = shapeKey(types);
  const allowed = [];
  for (const s of ALLOWED_SHAPES) allowed.push(shapeKey(s));
  if (allowed.indexOf(shape) === -1) {
    return fail('PATH_INVALID_COMPOSITION',
      'segment types [' + shape + '] are not a valid SCION path (allowed: ' +
      allowed.join(' | ') + ')');
  }

  // --- 2. every segment on its own ---------------------------------------
  for (let i = 0; i < list.length; i++) {
    const v = validateSegment(list[i]);
    if (!v.ok) {
      return fail('PATH_INVALID_SEGMENT',
        'segment[' + i + ']: ' + v.errors[0].message + ' [' + v.errors[0].code + ']');
    }
  }

  // --- 3. the segments have to meet at the same AS ------------------------
  for (let i = 1; i < list.length; i++) {
    const prev = list[i - 1];
    const next = list[i];
    const prevTo = canonicalOrRaw(prev.to);
    const nextFrom = canonicalOrRaw(next.from);
    if (prevTo !== nextFrom) {
      const prevLabel = 'segment[' + (i - 1) + '] (' + normalizeSegmentType(prev.type) +
        ' ' + canonicalOrRaw(prev.from) + ' -> ' + prevTo + ')';
      const nextLabel = 'segment[' + i + '] (' + normalizeSegmentType(next.type) +
        ' ' + nextFrom + ' -> ' + canonicalOrRaw(next.to) + ')';
      return fail('PATH_SEGMENTS_DO_NOT_JOIN',
        prevLabel + ' ends at ' + prevTo + ' but ' + nextLabel + ' starts at ' +
        nextFrom + '; the two segments must share that AS');
    }
  }

  return {
    segments: list,
    hops: pathHops(list),
    valid: true,
    error: null
  };
}

// ---------------------------------------------------------------------------
// path selection
// ---------------------------------------------------------------------------

function firstHop(path) {
  const hops = pathHops(path);
  return hops.length ? hops[0] : '';
}

function compareHopLists(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const c = compareStrings(a[i], b[i]);
    if (c !== 0) return c;
  }
  return a.length - b.length;
}

// policy: { avoidAses: [isdAs], preferLatency: true }
//
// Order of preference is latency, then hop count, then the lexicographically
// smallest first hop, then the full hop list -- the last step is what makes the
// answer unique when two paths are otherwise identical, so a shuffled input
// list can never change the winner. preferLatency: false swaps the first two
// criteria (fewest hops wins, latency breaks the tie).
function selectPath(paths, policy) {
  const p = (policy && typeof policy === 'object') ? policy : {};

  const avoid = new Set();
  const rawAvoid = Array.isArray(p.avoidAses) ? p.avoidAses
    : ((p.avoidAses === null || p.avoidAses === undefined || p.avoidAses === '') ? [] : [p.avoidAses]);
  for (const a of rawAvoid) {
    const key = canonicalIsdAs(a);
    if (key) avoid.add(key);
  }

  const preferLatency = (p.preferLatency === undefined) ? true : !!p.preferLatency;

  const candidates = [];
  const list = Array.isArray(paths) ? paths : [];
  for (const path of list) {
    if (!path || typeof path !== 'object') continue;
    if (path.valid === false) continue;

    const hops = pathHops(path);
    if (hops.length === 0) continue;

    let avoided = false;
    for (const hop of hops) {
      if (avoid.has(hop)) { avoided = true; break; }
    }
    if (avoided) continue;

    candidates.push({ path: path, hops: hops, latency: pathLatency(path) });
  }

  if (candidates.length === 0) return null;

  candidates.sort(function (a, b) {
    if (preferLatency) {
      if (a.latency !== b.latency) return a.latency - b.latency;
      if (a.hops.length !== b.hops.length) return a.hops.length - b.hops.length;
    } else {
      if (a.hops.length !== b.hops.length) return a.hops.length - b.hops.length;
      if (a.latency !== b.latency) return a.latency - b.latency;
    }
    const byFirst = compareStrings(a.hops[0], b.hops[0]);
    if (byFirst !== 0) return byFirst;
    return compareHopLists(a.hops, b.hops);
  });

  return candidates[0].path;
}

// ---------------------------------------------------------------------------
// beaconing
// ---------------------------------------------------------------------------

// neighbours accepts three shapes, all equivalent:
//   [['1-ff00:0:110', '1-ff00:0:0'], ...]        pair list
//   [{ from: '...', to: '...' }, ...]            edge objects
//   { '1-ff00:0:110': ['1-ff00:0:0'], ... }      adjacency map
// Links are undirected and self-links are ignored.
function buildAdjacency(neighbours) {
  const adj = new Map();

  function addOne(a, b) {
    if (!a || !b || a === b) return;
    if (!adj.has(a)) adj.set(a, new Set());
    adj.get(a).add(b);
  }
  function link(a, b) {
    addOne(a, b);
    addOne(b, a);
  }

  function pairOf(entry) {
    if (Array.isArray(entry)) {
      if (entry.length < 2) return null;
      return [canonicalOrRaw(entry[0]), canonicalOrRaw(entry[1])];
    }
    if (entry && typeof entry === 'object') {
      const a = (entry.from !== undefined) ? entry.from
        : ((entry.a !== undefined) ? entry.a : entry.as);
      const b = (entry.to !== undefined) ? entry.to
        : ((entry.b !== undefined) ? entry.b : entry.peer);
      if (a === undefined || b === undefined) return null;
      return [canonicalOrRaw(a), canonicalOrRaw(b)];
    }
    return null;
  }

  if (Array.isArray(neighbours)) {
    for (const entry of neighbours) {
      const pair = pairOf(entry);
      if (pair) link(pair[0], pair[1]);
    }
  } else if (neighbours && typeof neighbours === 'object') {
    const keys = Object.keys(neighbours).sort(compareStrings);
    for (const key of keys) {
      const from = canonicalOrRaw(key);
      const list = neighbours[key];
      const arr = Array.isArray(list) ? list
        : ((list === null || list === undefined) ? [] : [list]);
      for (const v of arr) link(from, canonicalOrRaw(v));
    }
  }

  const out = new Map();
  const keys = Array.from(adj.keys()).sort(compareStrings);
  for (const key of keys) {
    out.set(key, Array.from(adj.get(key)).sort(compareStrings));
  }
  return out;
}

// Deterministic beacon propagation. For every core AS we walk outward (BFS,
// neighbours in sorted order) over non-core ASes only, and emit both directions
// of what we find:
//   UP   the segment a non-core AS uses to reach the core (hops ordered
//        non-core -> ... -> core)
//   DOWN the segment the core uses to reach that AS (hops ordered
//        core -> ... -> non-core)
// Core-to-core links are not beaconed: those are CORE segments, created
// directly, and a walk never crosses one. coreAses is authoritative (it is not
// filtered through isCore), but any AS whose hex id ends in ':0' that the walk
// meets is still treated as a boundary rather than a downstream AS.
// Output is sorted by (type, from, to).
function beaconing(coreAses, neighbours) {
  const cores = [];
  const seenCores = new Set();
  const rawCores = Array.isArray(coreAses) ? coreAses : ((coreAses === null || coreAses === undefined) ? [] : [coreAses]);
  for (const c of rawCores) {
    const key = canonicalIsdAs(c);
    if (!key || seenCores.has(key)) continue;
    seenCores.add(key);
    cores.push(key);
  }
  cores.sort(compareStrings);

  const adj = buildAdjacency(neighbours);
  const out = [];

  for (const core of cores) {
    const parent = new Map();
    const visited = new Set([core]);
    let frontier = [core];

    while (frontier.length) {
      const next = [];
      for (const node of frontier) {
        const nbrs = adj.get(node) || [];
        for (const nb of nbrs) {
          if (visited.has(nb)) continue;
          visited.add(nb);
          parent.set(nb, node);
          // Another core is the far end of a CORE segment -- stop here.
          if (isCore(nb)) continue;
          next.push(nb);
        }
      }
      frontier = next;
    }

    const reached = [];
    for (const node of visited) {
      if (node === core) continue;
      if (isCore(node)) continue;
      reached.push(node);
    }
    reached.sort(compareStrings);

    for (const node of reached) {
      const chain = [node];
      let cur = node;
      while (parent.has(cur)) {
        cur = parent.get(cur);
        chain.push(cur);
      }
      chain.reverse(); // [core, ..., node]

      const downHops = chain.slice();
      const upHops = chain.slice().reverse();
      out.push({ from: node, to: core, type: PATH_TYPES.UP, hops: upHops });
      out.push({ from: core, to: node, type: PATH_TYPES.DOWN, hops: downHops });
    }
  }

  out.sort(function (a, b) {
    const byType = compareStrings(a.type, b.type);
    if (byType !== 0) return byType;
    const byFrom = compareStrings(a.from, b.from);
    if (byFrom !== 0) return byFrom;
    return compareStrings(a.to, b.to);
  });

  return out;
}

// ---------------------------------------------------------------------------
// rendering (the CLI 'show scion paths' body)
// ---------------------------------------------------------------------------

function describePath(path) {
  const segs = segmentsOf(path);
  const hops = pathHops(path);
  const latency = pathLatency(path);
  const mtu = pathMtu(path);
  const isObject = path && typeof path === 'object' && !Array.isArray(path);
  const valid = !(isObject && path.valid === false);

  const lines = [];
  if (segs.length === 0) {
    lines.push('SCION path: empty (0 segments)');
    return lines;
  }

  lines.push('SCION path: ' + (valid ? 'valid' : 'invalid') +
    ', ' + segs.length + (segs.length === 1 ? ' segment' : ' segments') +
    ', ' + hops.length + (hops.length === 1 ? ' hop' : ' hops') +
    ', ' + latency + ' ms' +
    ', mtu ' + mtu +
    ', underlay UDP/' + SCION_UDP_PORT);

  if (!valid) {
    const err = isObject ? path.error : null;
    const code = (err && err.code) ? err.code + ': ' : '';
    const msg = (err && err.message) ? err.message : 'path is not usable';
    lines.push('  error: ' + code + msg);
  }

  for (let i = 0; i < segs.length; i++) {
    const seg = (segs[i] && typeof segs[i] === 'object') ? segs[i] : {};
    const seq = segmentHops(seg);
    lines.push('  [' + i + '] ' + padRight(normalizeSegmentType(seg.type) || '?', 4) + ' ' +
      canonicalOrRaw(seg.from) + ' -> ' + canonicalOrRaw(seg.to) +
      '  (' + seq.length + (seq.length === 1 ? ' hop' : ' hops') +
      ', ' + numberOr(seg.latencyMs, 0) + ' ms' +
      ', mtu ' + numberOr(seg.mtu, DEFAULT_MTU) + ')');
  }

  lines.push('  hops: ' + hops.join(' -> '));
  return lines;
}

module.exports = {
  SCION_UDP_PORT,
  PATH_TYPES,
  DEFAULT_MTU,
  parseIsdAs,
  formatIsdAs,
  validateIsdAs,
  isCore,
  parseEndpoint,
  formatEndpoint,
  createSegment,
  validateSegment,
  buildPath,
  pathHops,
  pathLatency,
  pathMtu,
  selectPath,
  beaconing,
  describePath
};
