'use strict';
// ipv6.js -- pure IPv6 addressing, prefix and neighbour-discovery helpers.
// Zero dependencies. Self-contained 128-bit maths on BigInt (engine/net.js is
// IPv4-only and deliberately untouched).
//
// Totality contract: nothing in this module throws. Every entry point accepts
// arbitrary junk and degrades to a documented "empty" shape:
//   parse*        -> { valid: false, error: { code, message } }
//   string -> string helpers return '' when the input cannot be understood
//   predicates    -> false
//   ipv6ToBigInt  -> null
//   bigIntToIpv6  -> null (out of range / not an integer)
//   validateAddress6 -> { ok: false, errors: [{ code, message }] }
// Error objects are always { code, message } with a stable SCREAMING code.

const BITS = 128;
const MAX_BIGINT = (1n << 128n) - 1n;
const HEX4 = /^[0-9a-f]{1,4}$/;
const DEC3 = /^[0-9]{1,3}$/;

const ICMPV6_TYPES = {
  ECHO_REQUEST: 128,
  ECHO_REPLY: 129,
  ROUTER_SOLICIT: 133,
  ROUTER_ADVERT: 134,
  NEIGHBOUR_SOLICIT: 135,
  NEIGHBOUR_ADVERT: 136
};

const ND_DEFAULTS = {
  hopLimit: 255,
  reachableMs: 30000,
  retransTimerMs: 1000
};

// --- error plumbing -------------------------------------------------------

function err(code, message) {
  return { code: code, message: message };
}

function badParse(code, message) {
  return { valid: false, groups: null, bigint: null, error: err(code, message) };
}

function badPrefix(code, message) {
  return {
    valid: false,
    address: null,
    prefixLen: null,
    bigint: null,
    maskBigint: null,
    error: err(code, message)
  };
}

// --- shared normalisers ---------------------------------------------------

// Parse a dotted-quad into two 16-bit groups, or null.
function parseIpv4Quad(text) {
  if (typeof text !== 'string') return null;
  const parts = text.split('.');
  if (parts.length !== 4) return null;
  const groups = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (!DEC3.test(p)) return null;
    if (p.length > 1 && p.charAt(0) === '0') return null; // ambiguous octal form
    const v = parseInt(p, 10);
    if (v > 255) return null;
    groups.push(v);
  }
  return [(groups[0] << 8) | groups[1], (groups[2] << 8) | groups[3]];
}

// Turn a colon-separated chunk list into 16-bit groups.
// allowIpv4 permits a trailing dotted quad (the only legal position).
function partsToGroups(parts, allowIpv4) {
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p === '') return { ok: false, code: 'E_EMPTY_GROUP', message: 'empty group (stray colon)' };
    if (p.indexOf('.') !== -1) {
      if (!allowIpv4 || i !== parts.length - 1) {
        return {
          ok: false,
          code: 'E_IPV4_POSITION',
          message: 'an embedded IPv4 address must be the last field'
        };
      }
      const v4 = parseIpv4Quad(p);
      if (!v4) return { ok: false, code: 'E_IPV4', message: 'invalid embedded IPv4 address: ' + p };
      out.push(v4[0], v4[1]);
      continue;
    }
    if (!HEX4.test(p)) {
      return { ok: false, code: 'E_HEX', message: 'invalid hex group: ' + p };
    }
    out.push(parseInt(p, 16));
  }
  return { ok: true, groups: out };
}

// Accept an array of 8 group values (number, BigInt or hex string) and return
// plain numbers, or null when anything is off.
function normalizeGroups(groups) {
  if (!Array.isArray(groups) || groups.length !== 8) return null;
  const out = [];
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    let v = null;
    if (typeof g === 'bigint') {
      if (g < 0n || g > 65535n) return null;
      v = Number(g);
    } else if (typeof g === 'number') {
      if (!isFinite(g) || Math.floor(g) !== g || g < 0 || g > 65535) return null;
      v = g;
    } else if (typeof g === 'string') {
      const s = g.trim().toLowerCase();
      if (!HEX4.test(s)) return null;
      v = parseInt(s, 16);
    } else {
      return null;
    }
    out.push(v);
  }
  return out;
}

function groupsToBigInt(groups) {
  let n = 0n;
  for (let i = 0; i < 8; i++) {
    n = (n << 16n) | BigInt(groups[i]);
  }
  return n;
}

function bigIntToGroups(value) {
  const groups = [];
  let n = value;
  for (let i = 7; i >= 0; i--) {
    groups[i] = Number(n & 0xffffn);
    n >>= 16n;
  }
  return groups;
}

// --- parse / format -------------------------------------------------------

function parseIpv6(str) {
  if (typeof str !== 'string') {
    return badParse('E_TYPE', 'IPv6 address must be a string');
  }
  const raw = str.trim();
  if (raw === '') return badParse('E_EMPTY', 'empty IPv6 address');
  const lower = raw.toLowerCase();
  if (/\s/.test(lower)) {
    return badParse('E_WHITESPACE', 'whitespace inside IPv6 address');
  }
  if (!/^[0-9a-f:.]+$/.test(lower)) {
    return badParse('E_CHARS', 'illegal character in IPv6 address: ' + raw);
  }
  if (lower.indexOf(':::') !== -1) {
    return badParse('E_TRIPLE_COLON', "':' runs longer than '::' are invalid");
  }

  const pieces = lower.split('::');
  if (pieces.length > 2) {
    return badParse('E_DOUBLE_COMPRESSION', "'::' may appear only once");
  }
  const compressed = pieces.length === 2;

  let headParts = [];
  let tailParts = [];
  if (compressed) {
    if (pieces[0] !== '') headParts = pieces[0].split(':');
    if (pieces[1] !== '') tailParts = pieces[1].split(':');
  } else {
    headParts = lower.split(':');
  }

  // With '::' the head can never end in an embedded IPv4 (something follows it).
  const head = partsToGroups(headParts, !compressed);
  if (!head.ok) return badParse(head.code, head.message);
  const tail = compressed ? partsToGroups(tailParts, true) : { ok: true, groups: [] };
  if (!tail.ok) return badParse(tail.code, tail.message);

  let groups;
  if (compressed) {
    const explicit = head.groups.length + tail.groups.length;
    if (explicit > 7) {
      return badParse('E_TOO_MANY_GROUPS',
        "'::' must stand for at least one zero group (got " + explicit + ' explicit groups)');
    }
    const zeros = 8 - explicit;
    groups = head.groups.concat(new Array(zeros).fill(0), tail.groups);
  } else {
    if (head.groups.length !== 8) {
      return badParse('E_GROUP_COUNT',
        'expected 8 groups, got ' + head.groups.length);
    }
    groups = head.groups;
  }

  return {
    valid: true,
    groups: groups.slice(),
    bigint: groupsToBigInt(groups),
    error: null
  };
}

// RFC 5952 canonical text: lowercase, no leading zeros, single '::' for the
// longest run of >= 2 zero groups, leftmost run on a tie.
function formatIpv6(groups) {
  const g = normalizeGroups(groups);
  if (!g) return '';

  let bestStart = -1;
  let bestLen = 0;
  let i = 0;
  while (i < 8) {
    if (g[i] !== 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && g[j] === 0) j++;
    const len = j - i;
    if (len > bestLen) {
      bestLen = len;
      bestStart = i;
    }
    i = j;
  }
  if (bestLen < 2) {
    bestStart = -1;
    bestLen = 0;
  }

  const hex = [];
  for (let k = 0; k < 8; k++) hex.push(g[k].toString(16));

  if (bestStart === -1) return hex.join(':');
  const left = hex.slice(0, bestStart).join(':');
  const right = hex.slice(bestStart + bestLen).join(':');
  return left + '::' + right;
}

// --- prefixes -------------------------------------------------------------

function parsePrefix6(str) {
  if (typeof str !== 'string') {
    return badPrefix('E_PREFIX_TYPE', 'prefix must be a string like 2001:db8::/32');
  }
  const s = str.trim();
  if (s === '') return badPrefix('E_PREFIX_FORMAT', 'empty prefix');

  const slash = s.indexOf('/');
  let addrText = s;
  let lenText = null;
  if (slash !== -1) {
    if (s.indexOf('/', slash + 1) !== -1) {
      return badPrefix('E_PREFIX_FORMAT', 'prefix may contain only one "/"');
    }
    addrText = s.slice(0, slash);
    lenText = s.slice(slash + 1);
  }

  const parsed = parseIpv6(addrText);
  if (!parsed.valid) {
    return badPrefix('E_ADDRESS', 'invalid address in prefix: ' + parsed.error.message);
  }

  let prefixLen = 128; // a bare address is a host route
  if (lenText !== null) {
    if (!DEC3.test(lenText)) {
      return badPrefix('E_PREFIX_LEN', 'invalid prefix length: ' + lenText);
    }
    prefixLen = parseInt(lenText, 10);
    if (prefixLen > 128) {
      return badPrefix('E_PREFIX_LEN', 'prefix length must be 0..128, got ' + prefixLen);
    }
  }

  const shift = BigInt(BITS - prefixLen);
  const maskBigint = (MAX_BIGINT << shift) & MAX_BIGINT;

  return {
    valid: true,
    address: formatIpv6(parsed.groups),
    prefixLen: prefixLen,
    bigint: parsed.bigint,
    maskBigint: maskBigint,
    error: null
  };
}

// Accept either a prefix string or an already-parsed prefix object.
function normalizePrefix(prefix) {
  if (typeof prefix === 'string') return parsePrefix6(prefix);
  if (prefix && typeof prefix === 'object' &&
      typeof prefix.bigint === 'bigint' &&
      typeof prefix.maskBigint === 'bigint') {
    return prefix;
  }
  return badPrefix('E_PREFIX_TYPE', 'expected a prefix string or parsed prefix');
}

function prefixContains6(prefix, ipStr) {
  const p = normalizePrefix(prefix);
  if (!p || p.valid !== true) return false;
  const ip = parseIpv6(ipStr);
  if (!ip.valid) return false;
  return (ip.bigint & p.maskBigint) === (p.bigint & p.maskBigint);
}

function networkAddress6(prefix) {
  const p = normalizePrefix(prefix);
  if (!p || p.valid !== true) return '';
  return formatIpv6(bigIntToGroups(p.bigint & p.maskBigint));
}

// --- classification -------------------------------------------------------

function isLinkLocal(str) {
  const p = parseIpv6(str);
  if (!p.valid) return false;
  return (p.bigint >> 118n) === 0x3fan; // fe80::/10
}

function isUniqueLocal(str) {
  const p = parseIpv6(str);
  if (!p.valid) return false;
  return (p.bigint >> 121n) === 0x7en; // fc00::/7
}

function isMulticast(str) {
  const p = parseIpv6(str);
  if (!p.valid) return false;
  return (p.bigint >> 120n) === 0xffn; // ff00::/8
}

function isLoopback6(str) {
  const p = parseIpv6(str);
  if (!p.valid) return false;
  return p.bigint === 1n; // ::1
}

// --- neighbour discovery --------------------------------------------------

// ff02::1:ffXX:XXXX -- the low 24 bits of the target address.
function solicitedNodeMulticast(ipStr) {
  const p = parseIpv6(ipStr);
  if (!p.valid) return '';
  if ((p.bigint >> 120n) === 0xffn) return ''; // no SNM for a multicast target
  const low24 = Number(p.bigint & 0xffffffn);
  const groups = [
    0xff02, 0, 0, 0, 0, 1,
    0xff00 | ((low24 >> 16) & 0xff),
    low24 & 0xffff
  ];
  return formatIpv6(groups);
}

// Accepts aa:bb:cc:dd:ee:ff, aa-bb-..., aabb.ccdd.eeff and aabbccddeeff.
function macToBytes(mac) {
  if (typeof mac !== 'string') return null;
  const s = mac.trim().toLowerCase();
  let hex = null;
  if (/^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/.test(s)) hex = s.split(':').join('');
  else if (/^[0-9a-f]{2}(-[0-9a-f]{2}){5}$/.test(s)) hex = s.split('-').join('');
  else if (/^[0-9a-f]{4}(\.[0-9a-f]{4}){2}$/.test(s)) hex = s.split('.').join('');
  else if (/^[0-9a-f]{12}$/.test(s)) hex = s;
  if (hex === null) return null;

  const bytes = [];
  for (let i = 0; i < 12; i += 2) bytes.push(parseInt(hex.substr(i, 2), 16));
  return bytes;
}

// EUI-64 interface identifier: flip the universal/local bit and splice fffe
// into the middle. Multicast/broadcast MACs have no EUI-64 -> ''.
function eui64FromMac(mac) {
  const b = macToBytes(mac);
  if (!b) return '';
  if ((b[0] & 0x01) === 1) return ''; // group bit set: multicast / broadcast

  const e = b.slice();
  e[0] = e[0] ^ 0x02;

  const groups = [
    (e[0] << 8) | e[1],
    (e[2] << 8) | 0xff,
    (0xfe << 8) | e[3],
    (e[4] << 8) | e[5]
  ];
  const hex = [];
  for (let i = 0; i < groups.length; i++) hex.push(groups[i].toString(16));
  return hex.join(':');
}

function linkLocalFromMac(mac) {
  const iid = eui64FromMac(mac);
  if (iid === '') return '';
  const parts = iid.split(':');
  const groups = [0xfe80, 0, 0, 0];
  for (let i = 0; i < 4; i++) groups.push(parseInt(parts[i], 16));
  return formatIpv6(groups);
}

// --- 128-bit conversions --------------------------------------------------

function ipv6ToBigInt(str) {
  const p = parseIpv6(str);
  if (!p.valid) return null;
  return p.bigint;
}

function bigIntToIpv6(value) {
  let n = null;
  if (typeof value === 'bigint') {
    n = value;
  } else if (typeof value === 'number' && isFinite(value) && Math.floor(value) === value) {
    n = BigInt(value);
  } else {
    return null;
  }
  if (n < 0n || n > MAX_BIGINT) return null;
  return formatIpv6(bigIntToGroups(n));
}

// --- validation -----------------------------------------------------------

// Parse plus "may this be assigned to an interface?" checks.
function validateAddress6(str) {
  const errors = [];
  const p = parseIpv6(str);
  if (!p.valid) {
    errors.push(err('E_PARSE', p.error.message));
    return { ok: false, errors: errors };
  }
  if (p.bigint === 0n) {
    errors.push(err('E_UNSPECIFIED', 'the unspecified address :: cannot be assigned to an interface'));
  }
  if ((p.bigint >> 120n) === 0xffn) {
    errors.push(err('E_MULTICAST', 'a multicast address cannot be assigned to an interface'));
  }
  return { ok: errors.length === 0, errors: errors };
}

module.exports = {
  ICMPV6_TYPES,
  ND_DEFAULTS,
  parseIpv6,
  formatIpv6,
  parsePrefix6,
  prefixContains6,
  networkAddress6,
  isLinkLocal,
  isUniqueLocal,
  isMulticast,
  isLoopback6,
  solicitedNodeMulticast,
  macToBytes,
  eui64FromMac,
  linkLocalFromMac,
  ipv6ToBigInt,
  bigIntToIpv6,
  validateAddress6
};
