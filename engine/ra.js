'use strict';
// ra.js -- Router Advertisement (ICMPv6 134) and Router Solicitation (133).
//
// This pair of messages is how an IPv6 host gets an address without anyone typing
// one in: it multicasts a solicitation to all routers (ff02::2), a router answers
// to all nodes (ff02::1) with the prefixes it owns, and the host splices its own
// EUI-64 interface identifier onto the advertised prefix. That is the default path
// for essentially every real IPv6 host, so a simulator that can only do static
// addresses cannot show how IPv6 is actually deployed.
//
// The messages are really encoded. build* returns the plain object the rest of the
// simulator reads; encode* lays out the ICMPv6 octets of RFC 4861 §4.2 and §4.6;
// parse* decodes those octets again. The forwarding path uses both ends, so a
// mistake in the layout cannot hide behind a structure that only ever talks to
// itself.
//
// Totality contract, same as ipv6.js: nothing here throws.
//   parse*        -> { valid: false, ra/rs: null, error: { code, message } }
//   build*        -> a message with safe defaults
//   deriveAddress -> '' when the prefix or the MAC cannot be understood
const ipv6 = require('./ipv6');

const RA_TYPE = 134;
const RS_TYPE = 133;

// All-nodes / all-routers multicast: the two groups every ND exchange uses.
const ALL_NODES = 'ff02::1';
const ALL_ROUTERS = 'ff02::2';
// IPv6 multicast MACs are 33:33 followed by the low 32 bits of the group.
const ALL_NODES_MAC = '33:33:00:00:00:01';
const ALL_ROUTERS_MAC = '33:33:00:00:00:02';

const OPT_SOURCE_LLADDR = 1;   // type 1, 8 octets: the sender's MAC
const OPT_PREFIX_INFO = 3;     // type 3, 32 octets: one on-link prefix

const INFINITE = 4294967295;   // "lifetime never expires" on the wire

// RFC 4861 defaults, plus the RFC 4862 suggested prefix lifetimes (30 days
// valid / 7 days preferred). A router that says nothing explicit still has to
// say something plausible.
const DEFAULTS = {
  curHopLimit: 64,
  routerLifetime: 1800,
  reachableTime: 0,
  retransTimer: 0,
  validLifetime: 2592000,
  preferredLifetime: 604800
};

const MAX_BIGINT = (1n << 128n) - 1n;

// --- error plumbing -------------------------------------------------------

function err(code, message) {
  return { code: code, message: message };
}

function badRa(code, message) {
  return { valid: false, ra: null, error: err(code, message) };
}

function badRs(code, message) {
  return { valid: false, rs: null, error: err(code, message) };
}

// --- small helpers --------------------------------------------------------

// Clamp a number into a wire field. Anything that is not a finite number falls
// back to `dflt`, which keeps buildRa() total without hiding a real 0.
function clampInt(value, min, max, dflt) {
  const n = Number(value);
  if (!isFinite(n) || Math.floor(n) !== n) return dflt;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

function formatMacBytes(bytes) {
  const out = [];
  for (let i = 0; i < 6; i++) {
    out.push((bytes[i] < 16 ? '0' : '') + bytes[i].toString(16));
  }
  return out.join(':');
}

// 16 octets -> the eight 16-bit groups parseIpv6/formatIpv6 understand.
function prefixGroupsFromBytes(buf, offset) {
  const groups = [];
  for (let i = 0; i < 8; i++) groups.push(buf.readUInt16BE(offset + i * 2));
  return groups;
}

// One prefix information option, normalised. Returns null for anything that is
// not a usable prefix so the caller can simply skip it.
//
// The address is masked down to the network: an advertisement carries a prefix,
// not a host address, and a router configured with 2001:db8:1::1234/64 must not
// put those low bits on the wire - a host would splice its identifier over them
// anyway, but the option would be lying.
function normalizePrefixInfo(spec) {
  const src = (spec && typeof spec === 'object') ? spec : {};
  let text = (typeof spec === 'string') ? spec : src.prefix;
  if (typeof text !== 'string' || text === '') return null;

  if (text.indexOf('/') === -1) {
    const len = (src.prefixLen === undefined || src.prefixLen === null) ? 64 : src.prefixLen;
    text = text + '/' + len;
  }
  const parsed = ipv6.parsePrefix6(text);
  if (!parsed.valid) return null;

  const validLifetime = clampInt(src.validLifetime, 0, INFINITE, DEFAULTS.validLifetime);
  let preferredLifetime = clampInt(src.preferredLifetime, 0, INFINITE, DEFAULTS.preferredLifetime);
  // RFC 4862 §5.5.3: a preferred lifetime longer than the valid one is a
  // contradiction; the stricter of the two wins.
  if (preferredLifetime > validLifetime) preferredLifetime = validLifetime;

  return {
    prefix: ipv6.networkAddress6(parsed),
    prefixLen: parsed.prefixLen,
    // L=1 means "this prefix is on-link", A=1 means "form an address from it".
    // Both default to on because that is what a router advertises for its own
    // connected subnet unless it is explicitly told otherwise.
    onLink: src.onLink !== false,
    autonomous: src.autonomous !== false,
    validLifetime: validLifetime,
    preferredLifetime: preferredLifetime
  };
}

// Read a stored config.ra (possibly missing, possibly junk) into a shape the
// simulator can rely on. `enabled` and `suppress` are policy, not wire content,
// but they travel with the rest so one call describes a router completely.
function normalizeConfig(cfg) {
  const c = (cfg && typeof cfg === 'object') ? cfg : {};
  const prefixes = [];
  if (Array.isArray(c.prefixes)) {
    for (const p of c.prefixes) {
      const n = normalizePrefixInfo(p);
      if (n) prefixes.push(n);
    }
  }
  return {
    enabled: c.enabled === true,
    suppress: c.suppress === true,
    m: c.m === true,
    o: c.o === true,
    curHopLimit: clampInt(c.curHopLimit, 0, 255, DEFAULTS.curHopLimit),
    routerLifetime: clampInt(c.routerLifetime, 0, 65535, DEFAULTS.routerLifetime),
    reachableTime: clampInt(c.reachableTime, 0, INFINITE, DEFAULTS.reachableTime),
    retransTimer: clampInt(c.retransTimer, 0, INFINITE, DEFAULTS.retransTimer),
    prefixes: prefixes
  };
}

// --- build (structured message) -------------------------------------------

// The RA as a plain object. Everything here also exists on the wire; nothing
// exists only here.
function buildRa(opts) {
  const o = (opts && typeof opts === 'object') ? opts : {};
  const cfg = normalizeConfig(o);
  return {
    type: RA_TYPE,
    code: 0,
    checksum: 0,
    curHopLimit: cfg.curHopLimit,
    m: cfg.m,
    o: cfg.o,
    routerLifetime: cfg.routerLifetime,
    reachableTime: cfg.reachableTime,
    retransTimer: cfg.retransTimer,
    prefixes: cfg.prefixes.map(function (p) { return Object.assign({}, p); }),
    srcMac: (typeof o.srcMac === 'string' && o.srcMac !== '') ? o.srcMac : null
  };
}

// The solicitation: a header and, optionally, the sender's MAC so the router can
// answer unicast without a neighbour solicitation of its own.
function buildRs(opts) {
  const o = (opts && typeof opts === 'object') ? opts : {};
  return {
    type: RS_TYPE,
    code: 0,
    checksum: 0,
    reserved: 0,
    srcMac: (typeof o.srcMac === 'string' && o.srcMac !== '') ? o.srcMac : null
  };
}

// --- encode (octets) ------------------------------------------------------

function encodeSourceLladr(mac) {
  const bytes = ipv6.macToBytes(mac);
  if (!bytes) return null;
  const opt = Buffer.alloc(8);
  opt[0] = OPT_SOURCE_LLADDR;
  opt[1] = 1;                       // length in units of 8 octets
  for (let i = 0; i < 6; i++) opt[2 + i] = bytes[i];
  return opt;
}

function encodePrefixOption(pio) {
  const opt = Buffer.alloc(32);
  opt[0] = OPT_PREFIX_INFO;
  opt[1] = 4;                       // 32 octets
  opt[2] = pio.prefixLen;
  // L and A live in the flags octet, next to the prefix length (RFC 4861 §4.6.2).
  opt[3] = (pio.onLink ? 0x80 : 0) | (pio.autonomous ? 0x40 : 0);
  opt.writeUInt32BE(pio.validLifetime, 4);
  opt.writeUInt32BE(pio.preferredLifetime, 8);
  // octets 12..15 are reserved and stay zero
  const parsed = ipv6.parseIpv6(pio.prefix);
  if (parsed.valid) {
    for (let i = 0; i < 8; i++) opt.writeUInt16BE(parsed.groups[i], 16 + i * 2);
  }
  return opt;
}

function encodeRa(ra) {
  const msg = buildRa(ra);
  const options = [];
  const slla = encodeSourceLladr(msg.srcMac);
  if (slla) options.push(slla);
  for (const pio of msg.prefixes) options.push(encodePrefixOption(pio));

  let total = 16;
  for (const o of options) total += o.length;

  const buf = Buffer.alloc(total);
  buf[0] = RA_TYPE;
  buf[1] = 0;
  // The checksum is left at zero on purpose: this simulator never validates an
  // ICMPv6 checksum (there is no pseudo-header plumbing anywhere), and inventing
  // a wrong one would be worse than clearly not having one.
  buf.writeUInt16BE(0, 2);
  buf[4] = msg.curHopLimit;
  buf[5] = (msg.m ? 0x80 : 0) | (msg.o ? 0x40 : 0);
  buf.writeUInt16BE(msg.routerLifetime, 6);
  buf.writeUInt32BE(msg.reachableTime, 8);
  buf.writeUInt32BE(msg.retransTimer, 12);

  let off = 16;
  for (const o of options) { o.copy(buf, off); off += o.length; }
  return buf;
}

function encodeRs(rs) {
  const msg = buildRs(rs);
  const slla = encodeSourceLladr(msg.srcMac);
  const buf = Buffer.alloc(slla ? 16 : 8);
  buf[0] = RS_TYPE;
  buf[1] = 0;
  buf.writeUInt16BE(0, 2);          // checksum, see encodeRa
  buf.writeUInt32BE(0, 4);          // reserved
  if (slla) slla.copy(buf, 8);
  return buf;
}

// --- parse (octets -> structured message) --------------------------------

function parseRa(buf) {
  if (!Buffer.isBuffer(buf)) return badRa('E_TYPE', 'a router advertisement must be a Buffer of ICMPv6 octets');
  if (buf.length < 16) return badRa('E_SHORT', 'router advertisement is ' + buf.length + ' octets, the header alone is 16');
  if (buf[0] !== RA_TYPE) return badRa('E_ICMP_TYPE', 'expected ICMPv6 type ' + RA_TYPE + ', got ' + buf[0]);

  const flags = buf[5];
  const ra = {
    type: buf[0],
    code: buf[1],
    checksum: buf.readUInt16BE(2),
    curHopLimit: buf[4],
    // M: addresses come from DHCPv6. O: other configuration (DNS, ...) does too.
    m: (flags & 0x80) !== 0,
    o: (flags & 0x40) !== 0,
    routerLifetime: buf.readUInt16BE(6),
    reachableTime: buf.readUInt32BE(8),
    retransTimer: buf.readUInt32BE(12),
    prefixes: [],
    srcMac: null,
    options: []
  };

  let off = 16;
  while (off + 2 <= buf.length) {
    const type = buf[off];
    const lengthUnits = buf[off + 1];
    // A zero length would leave the cursor where it is and loop forever, so it
    // has to be refused rather than skipped.
    if (lengthUnits === 0) return badRa('E_OPTION_LEN', 'option ' + type + ' declares a zero length');
    const len = lengthUnits * 8;
    if (off + len > buf.length) {
      return badRa('E_OPTION_TRUNCATED', 'option ' + type + ' claims ' + len + ' octets but only ' + (buf.length - off) + ' remain');
    }

    if (type === OPT_PREFIX_INFO && len >= 32) {
      const pioFlags = buf[off + 3];
      const prefix = ipv6.formatIpv6(prefixGroupsFromBytes(buf, off + 16));
      if (prefix !== '') {
        ra.prefixes.push({
          prefix: prefix,
          prefixLen: buf[off + 2],
          onLink: (pioFlags & 0x80) !== 0,
          autonomous: (pioFlags & 0x40) !== 0,
          validLifetime: buf.readUInt32BE(off + 4),
          preferredLifetime: buf.readUInt32BE(off + 8)
        });
      }
    } else if (type === OPT_SOURCE_LLADDR && len >= 8) {
      ra.srcMac = formatMacBytes(buf.subarray(off + 2, off + 8));
    }
    // Unknown option types are skipped by their own length, which is the whole
    // reason the length field exists: a host must not choke on an option added
    // by a newer router.
    ra.options.push({ type: type, lengthUnits: lengthUnits, length: len });
    off += len;
  }

  if (off !== buf.length) {
    return badRa('E_TRAILING', 'router advertisement ends with ' + (buf.length - off) + ' unparsed octet(s)');
  }
  return { valid: true, ra: ra, error: null };
}

function parseRs(buf) {
  if (!Buffer.isBuffer(buf)) return badRs('E_TYPE', 'a router solicitation must be a Buffer of ICMPv6 octets');
  if (buf.length < 8) return badRs('E_SHORT', 'router solicitation is ' + buf.length + ' octets, the header alone is 8');
  if (buf[0] !== RS_TYPE) return badRs('E_ICMP_TYPE', 'expected ICMPv6 type ' + RS_TYPE + ', got ' + buf[0]);

  const rs = { type: buf[0], code: buf[1], checksum: buf.readUInt16BE(2), reserved: buf.readUInt32BE(4), srcMac: null };
  let off = 8;
  while (off + 2 <= buf.length) {
    const type = buf[off];
    const lengthUnits = buf[off + 1];
    if (lengthUnits === 0) return badRs('E_OPTION_LEN', 'option ' + type + ' declares a zero length');
    const len = lengthUnits * 8;
    if (off + len > buf.length) return badRs('E_OPTION_TRUNCATED', 'option ' + type + ' overruns the message');
    if (type === OPT_SOURCE_LLADDR && len >= 8) {
      rs.srcMac = formatMacBytes(buf.subarray(off + 2, off + 8));
    }
    off += len;
  }
  if (off !== buf.length) return badRs('E_TRAILING', 'router solicitation ends with unparsed octets');
  return { valid: true, rs: rs, error: null };
}

// --- SLAAC address formation ---------------------------------------------

// prefix + EUI-64 interface identifier. RFC 4862 only permits autoconfiguration
// from a /64 (the identifier has to fit in 64 bits), but the splice is done at
// the bit boundary rather than the byte one, so a shorter prefix still yields a
// deterministic address instead of nonsense.
function deriveAddress(prefix, prefixLen, mac) {
  let text = prefix;
  if (typeof text !== 'string' || text === '') return '';

  if (text.indexOf('/') === -1) {
    if (prefixLen === undefined || prefixLen === null) return '';
    text = text + '/' + prefixLen;
  }
  const parsed = ipv6.parsePrefix6(text);
  if (!parsed.valid) return '';

  const iid = ipv6.eui64FromMac(mac);
  if (iid === '') return '';                       // no MAC (or a group MAC): no EUI-64
  const iidParsed = ipv6.parseIpv6('::' + iid);
  if (!iidParsed.valid) return '';

  const mask = parsed.maskBigint;
  const value = (parsed.bigint & mask) | (iidParsed.bigint & (MAX_BIGINT ^ mask));
  return ipv6.bigIntToIpv6(value);
}

// Does this prefix information option describe something a host may form an
// address from? Kept as a predicate so both the simulator and the tests ask the
// same question.
function canAutoconfigure(pio) {
  if (!pio || typeof pio !== 'object') return false;
  if (pio.autonomous !== true) return false;
  if (typeof pio.prefixLen !== 'number') return false;
  if (pio.prefixLen > 64) return false;            // more prefix than room for an IID
  if (typeof pio.validLifetime === 'number' && pio.validLifetime === 0) return false;
  return ipv6.isLinkLocal(pio.prefix) === false;   // a link-local prefix is never global
}

module.exports = {
  RA_TYPE,
  RS_TYPE,
  ALL_NODES,
  ALL_ROUTERS,
  ALL_NODES_MAC,
  ALL_ROUTERS_MAC,
  OPT_SOURCE_LLADDR,
  OPT_PREFIX_INFO,
  INFINITE,
  DEFAULTS,
  normalizeConfig,
  normalizePrefixInfo,
  buildRa,
  buildRs,
  encodeRa,
  encodeRs,
  parseRa,
  parseRs,
  deriveAddress,
  canAutoconfigure
};
