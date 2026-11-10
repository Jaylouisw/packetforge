'use strict';
// nat.js -- NAT (Network Address Translation) model.
//
// Three flavours, mirroring what `ip nat inside source` can express on a
// router:
//   static  -- fixed one-to-one insideLocal <-> insideGlobal, both directions
//   dynamic -- an inside local takes the first free address of a global pool
//   pat     -- many inside locals overload one global address, told apart by
//              source port (NAT overload)
//
// Everything here is pure data + pure functions: no I/O, no console, no timers.
// A `table` is a plain object the caller owns; translateOutbound() and friends
// mutate the table on purpose (accumulating translations is the whole point)
// but they NEVER mutate the packet they are handed -- every result carries a
// new object. Steps are caller-supplied logical ticks, never Date.now(), so a
// simulation replays identically.
//
// Rule shape (see normalizeRule):
//   { type: 'static'|'dynamic'|'pat',
//     insideLocal:  '192.168.1.10' | '192.168.1.0/24' | 'x-y' | 'any',
//     insideGlobal: '203.0.113.5'  | pool spec (dynamic only),
//     protocol:     'tcp'|'udp'|'icmp'|'any'|number,
//     port:         number|null,
//     acl:          null | address spec(s) | opaque ACL name }
//
// `port` on a static rule pins the translated port (port forwarding) and is
// required by neither direction; a rule without it forwards every port.
//
// `acl` is either an address/subnet allow-list, evaluated here against the
// inside local address, or an opaque ACL name. A name is not something this
// module can evaluate -- the simulator's ACL stage runs before NAT -- so an
// entry that does not parse as an address is ignored rather than denying
// everything.

const net = require('./net');

const NAT_TYPES = {
  STATIC: 'static',
  DYNAMIC: 'dynamic',
  PAT: 'pat'
};

const TYPES = [NAT_TYPES.STATIC, NAT_TYPES.DYNAMIC, NAT_TYPES.PAT];

// PAT allocates source ports upwards from 1024; 0-1023 stays reserved.
const FIRST_PORT = 1024;
const LAST_PORT = 65535;

// How many addresses a pool spec may enumerate, so a typo like
// '10.0.0.0/8' cannot walk four billion hosts.
const MAX_POOL = 1024;

// Default translation ageing, in caller-supplied steps.
const DEFAULT_TIMEOUTS = { icmp: 60, udp: 300, tcp: 3600, default: 300 };

const PROTO_BY_NUMBER = {
  1: 'icmp', 6: 'tcp', 17: 'udp', 47: 'gre', 50: 'esp', 51: 'ah', 58: 'icmpv6'
};

const KNOWN_PROTOCOLS = [
  'any', 'tcp', 'udp', 'icmp', 'igmp', 'gre', 'esp', 'ah', 'icmpv6'
];

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

function err(code, message) {
  return { code: code, message: message };
}

function isObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function ipValue(ip) {
  try {
    return net.ipToInt(ip);
  } catch (e) {
    return null;
  }
}

function validIp(ip) {
  return ipValue(ip) !== null;
}

function numOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  if (!isFinite(n)) return null;
  return n;
}

function portOf(v) {
  const n = numOrNull(v);
  if (n === null) return null;
  return Math.floor(n);
}

function stepOf(step) {
  const n = numOrNull(step);
  return n === null ? 0 : n;
}

function str(v) {
  if (v === null || v === undefined) return '';
  return String(v).trim();
}

function normalizeProtocol(v) {
  if (v === null || v === undefined || v === '') return 'any';
  if (typeof v === 'number') return PROTO_BY_NUMBER[v] || String(v);
  const s = String(v).trim().toLowerCase();
  if (s === '') return 'any';
  if (s === 'all' || s === 'ip') return 'any';
  if (/^\d+$/.test(s)) return PROTO_BY_NUMBER[Number(s)] || s;
  return s;
}

function protocolMatches(a, b) {
  const x = normalizeProtocol(a);
  const y = normalizeProtocol(b);
  if (x === 'any' || y === 'any') return true;
  return x === y;
}

function hasPorts(proto) {
  const p = normalizeProtocol(proto);
  return p === 'tcp' || p === 'udp';
}

// Parse an address spec into a matcher descriptor.
// kind: 'any' | 'host' | 'subnet' | 'range' | 'invalid'
function parseSpec(spec) {
  const s = str(spec);
  if (s === '' || s.toLowerCase() === 'any') return { kind: 'any', text: 'any' };

  if (s.indexOf('/') !== -1) {
    const parts = s.split('/');
    const ip = parts[0].trim();
    const mask = parts.slice(1).join('/').trim();
    if (!validIp(ip) || mask === '') return { kind: 'invalid', text: s };
    try {
      // Keep the mask as a dotted string: networkOf()/maskToInt() take a mask
      // spec, not a mask integer.
      const dotted = net.intToIp(net.maskToInt(mask));
      return {
        kind: 'subnet',
        ip: ip,
        mask: dotted,
        network: net.networkOf(ip, dotted),
        text: s
      };
    } catch (e) {
      return { kind: 'invalid', text: s };
    }
  }

  if (s.indexOf('-') !== -1) {
    const parts = s.split('-');
    const a = parts[0].trim();
    const b = parts.slice(1).join('-').trim();
    if (!validIp(a) || !validIp(b)) return { kind: 'invalid', text: s };
    const lo = net.ipToInt(a);
    const hi = net.ipToInt(b);
    if (lo > hi) return { kind: 'invalid', text: s };
    return { kind: 'range', lo: lo, hi: hi, text: s };
  }

  if (validIp(s)) return { kind: 'host', ip: s, text: s };
  return { kind: 'invalid', text: s };
}

function specContains(spec, ip) {
  const p = (isObject(spec) && spec.kind) ? spec : parseSpec(spec);
  if (p.kind === 'any') return true;
  if (p.kind === 'host') return p.ip === str(ip);
  if (p.kind === 'subnet') {
    if (!validIp(ip)) return false;
    return net.networkOf(ip, p.mask) === p.network;
  }
  if (p.kind === 'range') {
    const n = ipValue(ip);
    if (n === null) return false;
    return n >= p.lo && n <= p.hi;
  }
  return false;
}

// An allow-list of inside locals. Opaque entries (an ACL name, not an
// address) are skipped: an allow-list with no address at all allows.
function aclAllows(acl, ip) {
  if (acl === null || acl === undefined || acl === '') return true;
  const list = Array.isArray(acl) ? acl : [acl];
  let sawAddress = false;
  for (const entry of list) {
    const spec = parseSpec(entry);
    if (spec.kind === 'invalid') continue;
    sawAddress = true;
    if (specContains(spec, ip)) return true;
  }
  return !sawAddress;
}

// Enumerate the global addresses of a pooling rule (dynamic NAT only).
function poolGlobals(spec) {
  const out = [];
  const parts = str(spec).split(/[,\s]+/);
  for (const part of parts) {
    if (!part) continue;
    const p = parseSpec(part);
    if (p.kind === 'host') out.push(p.ip);
    else if (p.kind === 'range') {
      for (let n = p.lo; n <= p.hi && out.length < MAX_POOL; n++) out.push(net.intToIp(n));
    } else if (p.kind === 'subnet') {
      const prefix = net.prefixOf(p.mask);
      const total = Math.pow(2, 32 - prefix);
      const first = prefix >= 31 ? p.network : p.network + 1;
      const last = prefix >= 31 ? p.network + total - 1 : p.network + total - 2;
      for (let n = first; n <= last && out.length < MAX_POOL; n++) out.push(net.intToIp(n));
    }
  }
  return out;
}

function copyPacket(pkt) {
  const p = isObject(pkt) ? pkt : {};
  return Object.assign({}, p);
}

// ---------------------------------------------------------------------------
// rule normalisation + validation
// ---------------------------------------------------------------------------

// Total function: never throws, and never "fixes" a value that validateRule
// wants to complain about (a bad type stays as the caller's raw string, a bad
// port becomes null). Rules that omit `type` are inferred: host -> host is a
// static one-to-one, anything else is overload.
function normalizeRule(spec) {
  const s = isObject(spec) ? spec : {};

  const rawType = str(s.type).toLowerCase();
  let type = rawType;
  if (!type) {
    const local = parseSpec(s.insideLocal);
    const global = parseSpec(s.insideGlobal);
    type = (local.kind === 'host' && global.kind === 'host')
      ? NAT_TYPES.STATIC
      : NAT_TYPES.PAT;
  }

  let insideLocal = str(s.insideLocal);
  if (!insideLocal && type === NAT_TYPES.PAT) insideLocal = 'any';

  let acl = null;
  if (Array.isArray(s.acl)) {
    acl = s.acl.map(function (v) { return str(v); }).filter(function (v) { return v !== ''; });
    if (!acl.length) acl = null;
  } else if (s.acl !== undefined && s.acl !== null && str(s.acl) !== '') {
    acl = str(s.acl);
  }

  return {
    type: type,
    insideLocal: insideLocal,
    insideGlobal: str(s.insideGlobal),
    protocol: normalizeProtocol(s.protocol),
    port: portOf(s.port),
    acl: acl
  };
}

// Verdict: { ok, errors: [{ code, message }] }. Codes are stable strings the
// CLI and the UI switch on:
//   E_RULE_INVALID, E_RULE_TYPE, E_LOCAL_SPEC, E_LOCAL_NOT_HOST,
//   E_GLOBAL_SPEC, E_GLOBAL_NOT_HOST, E_SAME_ADDRESS, E_PROTOCOL,
//   E_PORT_RANGE, E_PORT_PROTOCOL, E_ACL
function validateRule(rule) {
  const errors = [];

  if (!isObject(rule)) {
    errors.push(err('E_RULE_INVALID', 'A NAT rule must be an object.'));
    return { ok: false, errors: errors };
  }

  const r = normalizeRule(rule);

  if (TYPES.indexOf(r.type) === -1) {
    errors.push(err('E_RULE_TYPE',
      'NAT type "' + str(rule.type) + '" is not one of static, dynamic or pat.'));
  }

  const local = parseSpec(rule.insideLocal);
  if (local.kind === 'invalid') {
    errors.push(err('E_LOCAL_SPEC',
      'insideLocal "' + local.text + '" is not an IPv4 host, subnet, range or any.'));
  } else if (local.kind === 'any' && r.type !== NAT_TYPES.PAT) {
    errors.push(err('E_LOCAL_SPEC',
      'insideLocal is required for a ' + r.type + ' rule (only pat may say any).'));
  } else if (r.type === NAT_TYPES.STATIC && local.kind !== 'host') {
    errors.push(err('E_LOCAL_NOT_HOST',
      'A static rule maps one host: insideLocal "' + local.text + '" must be a single address.'));
  }

  const global = parseSpec(rule.insideGlobal);
  if (global.kind === 'invalid') {
    errors.push(err('E_GLOBAL_SPEC',
      'insideGlobal "' + global.text + '" is not an IPv4 host, subnet, range or any.'));
  } else if (global.kind === 'any') {
    errors.push(err('E_GLOBAL_SPEC', 'insideGlobal is required: a translation needs a global address.'));
  } else if (r.type !== NAT_TYPES.DYNAMIC && global.kind !== 'host') {
    errors.push(err('E_GLOBAL_NOT_HOST',
      'A ' + r.type + ' rule overloads one address: insideGlobal "' + global.text +
      '" must be a single host (pools are for dynamic rules).'));
  }

  if (local.kind === 'host' && global.kind === 'host' && local.ip === global.ip) {
    errors.push(err('E_SAME_ADDRESS',
      'insideLocal and insideGlobal are both ' + local.ip + '; that rule translates nothing.'));
  }

  const proto = normalizeProtocol(rule.protocol);
  if (KNOWN_PROTOCOLS.indexOf(proto) === -1 && !/^\d+$/.test(proto)) {
    errors.push(err('E_PROTOCOL',
      'protocol "' + str(rule.protocol) + '" is not tcp, udp, icmp, any or a protocol number.'));
  }

  const rawPort = rule.port;
  if (rawPort !== undefined && rawPort !== null && rawPort !== '') {
    const n = numOrNull(rawPort);
    if (n === null || Math.floor(n) !== n || n < 1 || n > LAST_PORT) {
      errors.push(err('E_PORT_RANGE',
        'port "' + str(rawPort) + '" must be a whole number from 1 to ' + LAST_PORT + '.'));
    } else if (!hasPorts(proto)) {
      errors.push(err('E_PORT_PROTOCOL',
        'port ' + n + ' needs a port-bearing protocol (tcp or udp), not ' + proto + '.'));
    }
  }

  if (rule.acl !== undefined && rule.acl !== null && !Array.isArray(rule.acl) &&
      typeof rule.acl !== 'string' && typeof rule.acl !== 'number') {
    errors.push(err('E_ACL', 'acl must be a name string, an address or an array of them.'));
  }

  return { ok: errors.length === 0, errors: errors };
}

// ---------------------------------------------------------------------------
// translation table
// ---------------------------------------------------------------------------

function createNatTable() {
  return { rules: [], translations: [], nextPort: FIRST_PORT };
}

function ensureTable(table) {
  const t = isObject(table) ? table : createNatTable();
  if (!Array.isArray(t.rules)) t.rules = [];
  if (!Array.isArray(t.translations)) t.translations = [];
  const p = numOrNull(t.nextPort);
  if (p === null || p < FIRST_PORT || p > LAST_PORT) t.nextPort = FIRST_PORT;
  return t;
}

function ruleShape(raw) {
  return isObject(raw) ? normalizeRule(raw) : normalizeRule({});
}

function nextEntryId(table) {
  let max = 0;
  for (const e of table.translations) {
    if (typeof e.id === 'number' && e.id > max) max = e.id;
  }
  return max + 1;
}

function touch(entry, step) {
  entry.lastStep = step;
  entry.hits = (typeof entry.hits === 'number' ? entry.hits : 0) + 1;
}

// ---------------------------------------------------------------------------
// lookup + ageing
// ---------------------------------------------------------------------------

// Find the translation an inbound packet belongs to. `globalPort` may be null
// (a port-less protocol), in which case the first entry on that global address
// wins; `protocol` limits the match, with 'any' as a wildcard on either side.
function lookupTranslation(table, query) {
  const q = isObject(query) ? query : {};
  const t = isObject(table) ? table : {};
  const list = Array.isArray(t.translations) ? t.translations : [];

  const globalIp = str(q.globalIp);
  if (!globalIp) return null;
  const globalPort = portOf(q.globalPort);
  const proto = normalizeProtocol(q.protocol);

  for (const e of list) {
    if (str(e.insideGlobal) !== globalIp) continue;
    if (!protocolMatches(e.protocol, proto)) continue;
    // An entry with no port translation (static, or dynamic NAT) is keyed by
    // the global address alone, so a port in the query cannot rule it out.
    const ep = (e.globalPort === null || e.globalPort === undefined)
      ? null
      : portOf(e.globalPort);
    if (globalPort !== null && ep !== null && ep !== globalPort) continue;
    return e;
  }
  return null;
}

function timeoutFor(timeouts, proto) {
  const p = normalizeProtocol(proto);
  const from = function (o) {
    if (!isObject(o)) return null;
    if (typeof o[p] === 'number' && isFinite(o[p])) return o[p];
    if (typeof o.default === 'number' && isFinite(o.default)) return o.default;
    return null;
  };
  const v = from(timeouts);
  if (v !== null) return v;
  if (typeof DEFAULT_TIMEOUTS[p] === 'number') return DEFAULT_TIMEOUTS[p];
  return DEFAULT_TIMEOUTS.default;
}

// Age out dynamic and pat translations that have been idle for their protocol
// timeout. Static rules are configuration, not state, so they never expire.
// Returns how many entries were removed.
function expireTranslations(table, timeouts, step) {
  const t = isObject(table) ? table : null;
  if (!t || !Array.isArray(t.translations)) return 0;
  const now = stepOf(step);
  const keep = [];
  let removed = 0;

  for (const e of t.translations) {
    if (e.type === NAT_TYPES.STATIC) { keep.push(e); continue; }
    const limit = timeoutFor(timeouts, e.protocol);
    const last = numOrNull(e.lastStep);
    const idle = now - (last === null ? 0 : last);
    if (isFinite(limit) && idle >= limit) { removed++; continue; }
    keep.push(e);
  }

  t.translations = keep;
  return removed;
}

// ---------------------------------------------------------------------------
// port allocation (PAT)
// ---------------------------------------------------------------------------

function allocPort(table, globalIp, protocol) {
  const proto = normalizeProtocol(protocol);
  const used = {};

  for (const e of table.translations) {
    if (str(e.insideGlobal) !== globalIp) continue;
    if (!protocolMatches(e.protocol, proto)) continue;
    const p = portOf(e.globalPort);
    if (p !== null) used[p] = true;
  }
  // Static port-forwarding rules reserve their global port too.
  for (const raw of table.rules) {
    const r = ruleShape(raw);
    if (r.type !== NAT_TYPES.STATIC) continue;
    if (r.insideGlobal !== globalIp || r.port === null) continue;
    if (!protocolMatches(r.protocol, proto)) continue;
    used[r.port] = true;
  }

  const span = LAST_PORT - FIRST_PORT + 1;
  const start = table.nextPort;
  for (let i = 0; i < span; i++) {
    const port = FIRST_PORT + (((start - FIRST_PORT) + i) % span);
    if (!used[port]) {
      table.nextPort = port >= LAST_PORT ? FIRST_PORT : port + 1;
      return port;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// outbound (inside -> outside)
// ---------------------------------------------------------------------------

function findStaticOutbound(rules, p, proto) {
  let fallback = null;
  for (const raw of rules) {
    const r = ruleShape(raw);
    if (r.type !== NAT_TYPES.STATIC) continue;
    if (r.insideLocal !== str(p.srcIp)) continue;
    if (!protocolMatches(r.protocol, proto)) continue;
    if (!aclAllows(r.acl, p.srcIp)) continue;
    if (r.port === null) {
      if (!fallback) fallback = r;
      continue;
    }
    const sp = portOf(p.srcPort);
    if (sp !== null && sp === r.port) return r;
  }
  return fallback;
}

function findStaticInbound(rules, p, proto) {
  let fallback = null;
  for (const raw of rules) {
    const r = ruleShape(raw);
    if (r.type !== NAT_TYPES.STATIC) continue;
    if (r.insideGlobal !== str(p.dstIp)) continue;
    if (!protocolMatches(r.protocol, proto)) continue;
    if (r.port === null) {
      if (!fallback) fallback = r;
      continue;
    }
    const dp = portOf(p.dstPort);
    if (dp !== null && dp === r.port) return r;
  }
  return fallback;
}

function recordStatic(table, rule, now) {
  const pin = rule.port;
  let entry = null;
  for (const e of table.translations) {
    if (e.type !== NAT_TYPES.STATIC) continue;
    if (e.insideLocal !== rule.insideLocal) continue;
    if (e.insideGlobal !== rule.insideGlobal) continue;
    if (portOf(e.globalPort) !== pin) continue;
    entry = e;
    break;
  }
  if (!entry) {
    entry = {
      id: nextEntryId(table),
      type: NAT_TYPES.STATIC,
      protocol: normalizeProtocol(rule.protocol),
      insideLocal: rule.insideLocal,
      insideGlobal: rule.insideGlobal,
      localPort: pin,
      globalPort: pin,
      dstIp: null,
      dstPort: null,
      createdStep: now,
      lastStep: now,
      hits: 0
    };
    table.translations.push(entry);
  }
  touch(entry, now);
  return entry;
}

// The flow a PAT entry is keyed on: the full inside-to-outside 5-tuple
// (protocol, inside address, inside port, destination address, destination
// port) plus the global address the pool picked. Leaving the inside port out
// collapsed every connection from one host to the same destination onto a
// single global port, so replies for the second socket were delivered to the
// first (#54).
function flowKeyOf(insideLocal, srcPort, dstIp, dstPort, proto, insideGlobal) {
  return [proto, str(insideLocal), portOf(srcPort), str(dstIp), portOf(dstPort),
    str(insideGlobal)].join('|');
}

function findPatFlow(table, key) {
  for (const e of table.translations) {
    if (e.type !== NAT_TYPES.PAT) continue;
    if (e.flowKey === key) return e;
  }
  return null;
}

function translatePat(table, rule, p, proto, now) {
  const key = flowKeyOf(p.srcIp, p.srcPort, p.dstIp, p.dstPort, proto, rule.insideGlobal);
  const existing = findPatFlow(table, key);

  if (existing) {
    p.srcIp = existing.insideGlobal;
    p.srcPort = existing.globalPort;
    touch(existing, now);
    return { action: 'translate', pkt: p, entry: existing };
  }

  const port = allocPort(table, rule.insideGlobal, proto);
  if (port === null) {
    return {
      action: 'drop', pkt: p, entry: null,
      reason: 'E_NAT_PORT_EXHAUSTED',
      message: 'No free port left on ' + rule.insideGlobal + ' for ' + proto + ' overload.'
    };
  }

  const entry = {
    id: nextEntryId(table),
    type: NAT_TYPES.PAT,
    protocol: proto,
    insideLocal: str(p.srcIp),
    insideGlobal: rule.insideGlobal,
    localPort: portOf(p.srcPort),
    globalPort: port,
    dstIp: str(p.dstIp),
    dstPort: portOf(p.dstPort),
    createdStep: now,
    lastStep: now,
    hits: 1,
    flowKey: key
  };
  table.translations.push(entry);

  p.srcIp = entry.insideGlobal;
  p.srcPort = port;
  return { action: 'translate', pkt: p, entry: entry };
}

function globalClaimed(table, globalIp) {
  for (const raw of table.rules) {
    const r = ruleShape(raw);
    if (r.type === NAT_TYPES.STATIC && r.insideGlobal === globalIp) return true;
  }
  for (const e of table.translations) {
    if (e.type === NAT_TYPES.STATIC) continue;
    if (str(e.insideGlobal) === globalIp) return true;
  }
  return false;
}

function findDynamicByLocal(table, insideLocal, pool) {
  for (const e of table.translations) {
    if (e.type !== NAT_TYPES.DYNAMIC) continue;
    if (e.insideLocal !== insideLocal) continue;
    if (pool && pool.indexOf(e.insideGlobal) === -1) continue;
    return e;
  }
  return null;
}

function translateDynamic(table, rule, p, proto, now) {
  const pool = poolGlobals(rule.insideGlobal);
  let entry = findDynamicByLocal(table, str(p.srcIp), pool);

  if (!entry) {
    let global = null;
    for (const g of pool) {
      if (globalClaimed(table, g)) continue;
      global = g;
      break;
    }
    if (global === null) {
      return {
        action: 'drop', pkt: p, entry: null,
        reason: 'E_NAT_POOL_EXHAUSTED',
        message: 'Every address in pool ' + rule.insideGlobal + ' is already translated.'
      };
    }
    entry = {
      id: nextEntryId(table),
      type: NAT_TYPES.DYNAMIC,
      protocol: proto,
      insideLocal: str(p.srcIp),
      insideGlobal: global,
      localPort: portOf(p.srcPort),
      globalPort: null,
      dstIp: str(p.dstIp),
      dstPort: portOf(p.dstPort),
      createdStep: now,
      lastStep: now,
      hits: 1
    };
    table.translations.push(entry);
  } else {
    touch(entry, now);
  }

  p.srcIp = entry.insideGlobal;
  return { action: 'translate', pkt: p, entry: entry };
}

// Rewrite a packet leaving the inside network.
// -> { action: 'translate'|'pass'|'drop', pkt, entry, reason?, message? }
function translateOutbound(table, pkt, step) {
  const tbl = ensureTable(table);
  const p = copyPacket(pkt);
  const now = stepOf(step);
  const proto = normalizeProtocol(p.protocol);

  const srule = findStaticOutbound(tbl.rules, p, proto);
  if (srule) {
    const entry = recordStatic(tbl, srule, now);
    if (srule.port !== null) p.srcPort = srule.port;
    p.srcIp = srule.insideGlobal;
    return { action: 'translate', pkt: p, entry: entry };
  }

  for (const raw of tbl.rules) {
    const rule = ruleShape(raw);
    if (rule.type !== NAT_TYPES.PAT && rule.type !== NAT_TYPES.DYNAMIC) continue;
    if (!specContains(rule.insideLocal, p.srcIp)) continue;
    if (!protocolMatches(rule.protocol, proto)) continue;
    if (!aclAllows(rule.acl, p.srcIp)) continue;
    if (rule.type === NAT_TYPES.PAT) return translatePat(tbl, rule, p, proto, now);
    return translateDynamic(tbl, rule, p, proto, now);
  }

  return { action: 'pass', pkt: p, entry: null };
}

// ---------------------------------------------------------------------------
// inbound (outside -> inside)
// ---------------------------------------------------------------------------

// Rewrite a packet arriving from the outside. Static rules match on the global
// IP; pat and dynamic translations match on (globalIp, globalPort, protocol)
// and land on the inside local, port included.
function translateInbound(table, pkt, step) {
  const tbl = ensureTable(table);
  const p = copyPacket(pkt);
  const now = stepOf(step);
  const proto = normalizeProtocol(p.protocol);

  const rule = findStaticInbound(tbl.rules, p, proto);
  if (rule) {
    const entry = recordStatic(tbl, rule, now);
    if (rule.port !== null) p.dstPort = rule.port;
    p.dstIp = rule.insideLocal;
    return { action: 'translate', pkt: p, entry: entry };
  }

  const entry = lookupTranslation(tbl, {
    globalIp: p.dstIp,
    globalPort: p.dstPort,
    protocol: proto
  });
  if (entry) {
    p.dstIp = entry.insideLocal;
    if (entry.localPort !== null && entry.localPort !== undefined) {
      p.dstPort = entry.localPort;
    }
    touch(entry, now);
    return { action: 'translate', pkt: p, entry: entry };
  }

  return { action: 'pass', pkt: p, entry: null };
}

// ---------------------------------------------------------------------------
// `show ip nat translations`
// ---------------------------------------------------------------------------

const TABLE_HEADER = 'Pro  Inside global          Inside local           ' +
  'Outside local          Outside global';

function pad(s, width) {
  const text = String(s);
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

function fmtAddr(ip, port) {
  const i = str(ip);
  if (!i) return '---';
  const p = portOf(port);
  return p === null ? i : i + ':' + p;
}

function ipIntOrZero(ip) {
  const n = ipValue(ip);
  return n === null ? 0 : n;
}

// One line per translation, in the classic column order. Sorted by global
// address then global port so repeated calls render identically.
function formatTable(table) {
  const t = isObject(table) ? table : {};
  const list = Array.isArray(t.translations) ? t.translations.slice() : [];

  list.sort(function (a, b) {
    const ai = ipIntOrZero(a.insideGlobal);
    const bi = ipIntOrZero(b.insideGlobal);
    if (ai !== bi) return ai - bi;
    const ap = portOf(a.globalPort);
    const bp = portOf(b.globalPort);
    if (ap !== bp) return (ap === null ? -1 : ap) - (bp === null ? -1 : bp);
    const ax = String(a.protocol) + '|' + String(a.insideLocal);
    const bx = String(b.protocol) + '|' + String(b.insideLocal);
    if (ax === bx) return 0;
    return ax < bx ? -1 : 1;
  });

  return list.map(function (e) {
    return pad(e.protocol || 'any', 5) +
      pad(fmtAddr(e.insideGlobal, e.globalPort), 23) +
      pad(fmtAddr(e.insideLocal, e.localPort), 23) +
      pad(fmtAddr(e.dstIp, e.dstPort), 23) +
      pad(fmtAddr(e.dstIp, e.dstPort), 23) +
      str(e.type);
  });
}

// A normalized rule, printed as the command that would create it. Used by `show ip nat rules`,
// `show running-config` and the `no` form - one spelling, so a printed rule always replays.
function formatRuleLine(rule) {
  const r = normalizeRule(rule);
  const head = 'ip nat inside source';
  if (r.type === NAT_TYPES.STATIC) {
    let line = head + ' static ' + str(rule.insideLocal) + ' ' + str(rule.insideGlobal);
    if (r.protocol && r.protocol !== 'any' && r.port !== null && r.port !== undefined) {
      line += ' ' + r.protocol + ' ' + r.port;
    }
    return line;
  }
  const where = rule.iface ? ('interface ' + rule.iface) : ('pool ' + (rule.pool || str(rule.insideGlobal)));
  return head + ' list ' + str(rule.insideLocal) + ' ' + where + (r.type === NAT_TYPES.PAT ? ' overload' : '');
}

module.exports = {
  NAT_TYPES,
  validateRule,
  normalizeRule,
  createNatTable,
  translateOutbound,
  translateInbound,
  lookupTranslation,
  expireTranslations,
  formatTable,
  DEFAULT_TIMEOUTS,
  TABLE_HEADER,
  formatRuleLine
};
