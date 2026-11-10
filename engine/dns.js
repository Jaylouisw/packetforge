'use strict';
// dns.js -- authoritative zone model, resolver and answer cache.
//
// Covers the four things the simulator, the CLI and the editor need:
//   1. normalising a zone spec into one canonical shape (normalizeZone)
//   2. validating that zone (unknown types, missing values, a CNAME sharing an
//      owner name, MX without a preference, duplicated records, ...)
//   3. answering a query out of the zone (resolve), including CNAME chains,
//      NXDOMAIN and the empty-NOERROR case
//   4. a step-driven answer cache + a deterministic upstream-server pick
//
// Everything here is pure data + pure functions: no I/O, no clock, no
// Math.random. Cache freshness is expressed in abstract integer `step`s, never
// wall-clock time, so a run is fully deterministic.
//
// Naming rules (get these wrong and nothing else lines up):
//   * an owner name is stored lowercase with no trailing dot, so 'WWW.Lab.' and
//     'www.lab' are the same key. The root is the single character '.'.
//   * a name written inside a zone is relative to that zone's apex unless it is
//     absolute (trailing dot) or already ends in the apex: zone 'lab' with a
//     record named 'web' owns 'web.lab'. '@' and an empty name mean the apex.
//   * `resolve()` builds a fresh copy of the zone on every call, so neither the
//     caller's spec nor a previously returned zone object is ever mutated.
//
// Answer shape is { name, type, ttl, value, priority? } with the owner name in
// canonical form and `ttl` already resolved against the zone default.

const net = require('./net');

const DNS_PORT = 53;
const CLASS_IN = 1;

const RECORD_TYPES = ['A', 'AAAA', 'CNAME', 'MX', 'NS', 'PTR', 'SOA', 'TXT', 'SRV'];

const RCODE = {
  NOERROR: 0,
  FORMERR: 1,
  SERVFAIL: 2,
  NXDOMAIN: 3,
  NOTIMP: 4,
  REFUSED: 5
};

const RCODE_NAME = {};
Object.keys(RCODE).forEach(function (k) { RCODE_NAME[RCODE[k]] = k; });

const ROOT = '.';
const DEFAULT_TTL = 3600;
const MAX_CNAME_DEPTH = 8;
const ANY = 'ANY';

// ---------------------------------------------------------------------------
// small parsers -- never throw
// ---------------------------------------------------------------------------

function trimStr(v) {
  if (v === null || v === undefined) return '';
  return String(v).trim();
}

function isBlank(v) {
  return v === null || v === undefined || trimStr(v) === '';
}

function numOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return n;
}

function stepOf(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

// Numeric TTL, rounded down and never negative; falls back to `fallback` (then
// to DEFAULT_TTL) when the value on the wire is unreadable.
function ttlOf(v, fallback) {
  const n = numOrNull(v);
  if (n !== null && n >= 0) return Math.floor(n);
  const f = numOrNull(fallback);
  if (f !== null && f >= 0) return Math.floor(f);
  return DEFAULT_TTL;
}

// Normalisation keeps a present-but-wrong TTL verbatim so validateZone() can
// name it instead of silently "fixing" a typo.
function ttlField(v, fallback) {
  if (isBlank(v)) return fallback;
  const n = numOrNull(v);
  if (n === null || n < 0) return v;
  return Math.floor(n);
}

function normType(t) {
  const s = trimStr(t).toUpperCase();
  if (s === '*' || s === 'ANY') return ANY;
  return s;
}

// lowercase, trailing dot(s) stripped; the root '.' stays '.'
function normalizeName(name) {
  const s = trimStr(name).toLowerCase();
  if (!s) return ROOT;
  let out = s;
  while (out.length > 1 && out.charAt(out.length - 1) === '.') out = out.slice(0, -1);
  return out || ROOT;
}

// Presentation form: 'web.lab' -> 'web.lab.', root stays '.'
function fqdn(name) {
  const n = normalizeName(name);
  return n === ROOT ? ROOT : n + '.';
}

// True when `name` sits at or below `apex`.
function inZone(name, apex) {
  const n = normalizeName(name);
  const a = normalizeName(apex);
  if (a === ROOT) return true;
  if (n === a) return true;
  return n.length > a.length && n.slice(-(a.length + 1)) === '.' + a;
}

// Zone data is written relative to the apex: qualify 'web' inside 'lab'.
function qualifyName(raw, apex) {
  const s = trimStr(raw).toLowerCase();
  const a = normalizeName(apex);
  if (!s || s === '@') return a;
  const absolute = s.charAt(s.length - 1) === '.';
  const n = normalizeName(s);
  if (a === ROOT) return n;
  const inside = n === a || (n.length > a.length && n.slice(-(a.length + 1)) === '.' + a);
  if (absolute || inside) return n;
  return n + '.' + a;
}

// net.isIp() only checks the shape, so 10.0.0.999 slips through it; a real
// address has to survive ipToInt(), which enforces 0-255 per octet.
function isIPv4(v) {
  const s = trimStr(v);
  if (!net.isIp(s)) return false;
  try {
    net.ipToInt(s);
    return true;
  } catch (err) {
    return false;
  }
}

function rcodeName(rcode) {
  const n = numOrNull(rcode);
  if (n === null) return 'SERVFAIL';
  return RCODE_NAME[n] || ('RCODE_' + n);
}

function copyRecord(rec) {
  const out = {
    name: normalizeName(rec.name),
    type: normType(rec.type),
    ttl: rec.ttl,
    value: rec.value === null || rec.value === undefined ? null : String(rec.value)
  };
  if (rec.priority !== null && rec.priority !== undefined) out.priority = rec.priority;
  return out;
}

function copyRecords(list) {
  const out = [];
  for (const r of (Array.isArray(list) ? list : [])) out.push(copyRecord(r));
  return out;
}

// ---------------------------------------------------------------------------
// normalisation
// ---------------------------------------------------------------------------

// spec: { name, defaultTtl, records: [{ name, type, ttl, value, priority }] }
// ->    { name, records: [], defaultTtl }
function normalizeZone(spec) {
  const s = (spec && typeof spec === 'object') ? spec : {};

  const name = normalizeName(isBlank(s.name) ? ROOT : s.name);
  const defaultTtl = ttlField(s.defaultTtl, DEFAULT_TTL);

  const rawRecords = Array.isArray(s.records) ? s.records : [];
  const records = [];
  for (const item of rawRecords) {
    const r = (item && typeof item === 'object') ? item : {};
    const rec = {
      name: qualifyName(r.name, name),
      type: normType(r.type),
      ttl: ttlField(r.ttl, defaultTtl),
      value: (r.value === null || r.value === undefined) ? null : trimStr(r.value)
    };
    const prio = r.priority;
    if (prio === null || prio === undefined || trimStr(prio) === '') {
      rec.priority = null;
    } else {
      const p = numOrNull(prio);
      rec.priority = (p === null || p < 0) ? prio : Math.floor(p);
    }
    records.push(rec);
  }

  return { name: name, records: records, defaultTtl: defaultTtl };
}

// ---------------------------------------------------------------------------
// validation
// ---------------------------------------------------------------------------

function validateZone(zone) {
  const raw = (zone && typeof zone === 'object') ? zone : {};
  const z = normalizeZone(raw);
  const errors = [];

  function add(code, message) {
    // Messages end in a period and several embed fqdn(), which already ends in one:
    // "... already defined at dup.example.test.." was what the console printed.
    errors.push({ code: code, message: String(message).replace(/\.\.$/, '.') });
  }

  if (isBlank(raw.name)) {
    add('E_DNS_MISSING_ZONE_NAME', 'Zone has no name; expected an apex such as "lab" or "example.com".');
  }
  if (typeof z.defaultTtl !== 'number') {
    add('E_DNS_BAD_TTL', 'Zone defaultTtl "' + String(z.defaultTtl) + '" is not a non-negative number.');
  }

  const byName = new Map();
  const seen = new Map();

  z.records.forEach(function (rec, i) {
    const where = 'record ' + (i + 1) + ' (' + (rec.name || '?') + ' ' + (rec.type || '?') + ')';
    const hasValue = rec.value !== null && trimStr(rec.value) !== '';
    const known = RECORD_TYPES.indexOf(rec.type) !== -1;

    if (!known) {
      add('E_DNS_BAD_TYPE', where + ': unknown record type "' + String(rec.type || '') +
        '"; expected one of ' + RECORD_TYPES.join(', ') + '.');
    }
    if (!hasValue) {
      add('E_DNS_MISSING_VALUE', where + ': no value.');
    }
    if (typeof rec.ttl !== 'number') {
      add('E_DNS_BAD_TTL', where + ': ttl "' + String(rec.ttl) + '" is not a non-negative number.');
    } else if (rec.ttl < 0) {
      add('E_DNS_BAD_TTL', where + ': ttl ' + rec.ttl + ' is negative.');
    }

    if (hasValue && known) {
      if (rec.type === 'A' && !isIPv4(rec.value)) {
        add('E_DNS_BAD_VALUE', where + ': "' + rec.value + '" is not a dotted-quad IPv4 address.');
      }
      if (rec.type === 'AAAA' && rec.value.indexOf(':') === -1) {
        add('E_DNS_BAD_VALUE', where + ': "' + rec.value + '" does not look like an IPv6 address.');
      }
      if (rec.type === 'MX') {
        if (rec.priority === null) {
          add('E_DNS_MX_NO_PRIORITY', where + ': MX "' + rec.value + '" has no preference (priority).');
        } else if (typeof rec.priority !== 'number') {
          add('E_DNS_BAD_PRIORITY', where + ': MX priority "' + String(rec.priority) + '" is not a non-negative number.');
        }
      }
    }

    if (!byName.has(rec.name)) byName.set(rec.name, []);
    byName.get(rec.name).push(rec);

    // Duplicates are judged on owner + type + value + preference, and a value
    // that is a name compares case-insensitively ('NS1.lab' == 'ns1.lab').
    const key = [rec.name, rec.type, trimStr(rec.value).toLowerCase(),
      rec.priority === null ? '' : String(rec.priority)].join('|');
    const count = (seen.get(key) || 0) + 1;
    seen.set(key, count);
    if (count === 2) {
      add('E_DNS_DUPLICATE', where + ': duplicate record; the same ' + rec.type +
        ' "' + trimStr(rec.value) + '" is already defined at ' + fqdn(rec.name) + '.');
    }
  });

  // A CNAME is exclusive: nothing else may live at the same owner name.
  for (const owner of Array.from(byName.keys())) {
    const list = byName.get(owner);
    const cnames = list.filter(function (r) { return r.type === 'CNAME'; });
    const others = list.filter(function (r) { return r.type !== 'CNAME'; });
    if (cnames.length && others.length) {
      add('E_DNS_CNAME_CONFLICT', 'CNAME at ' + fqdn(owner) + ' coexists with ' +
        others.map(function (r) { return r.type; }).join(', ') +
        '; a CNAME must be the only record at its owner name.');
    }
  }

  return { ok: errors.length === 0, errors: errors };
}

// ---------------------------------------------------------------------------
// matching
// ---------------------------------------------------------------------------

// Owner name and type must both match; 'ANY' / '*' matches every type.
function recordMatches(record, qname, qtype) {
  if (!record || typeof record !== 'object') return false;
  if (normalizeName(record.name) !== normalizeName(qname)) return false;
  const type = normType(qtype);
  if (type === ANY) return true;
  return normType(record.type) === type;
}

function recordsAt(map, name) {
  return map.get(normalizeName(name)) || [];
}

function selectType(recs, type) {
  if (type === ANY) return recs.slice();
  return recs.filter(function (r) { return r.type === type; });
}

function firstOfType(recs, type) {
  for (const r of recs) if (r.type === type) return r;
  return null;
}

// ---------------------------------------------------------------------------
// resolve
// ---------------------------------------------------------------------------

// resolve(zone, qname, qtype)
//   -> { rcode, authoritative, answers: [], cnameChain: [] }
// plus the convenience fields qname, qtype, rcodeName and note.
//
// Rules:
//   * CNAMEs are followed, at most MAX_CNAME_DEPTH hops; a cycle (or a chain
//     longer than the bound) is SERVFAIL, never an infinite loop. SERVFAIL
//     drops the answer section (as a real server does) but keeps the partial
//     chain so the CLI can say where resolution gave up.
//   * NXDOMAIN when the queried name, or any name a CNAME points at, holds no
//     records at all in this zone.
//   * NOERROR with an empty answer list when the name exists but owns no record
//     of the requested type -- that is an answer, not an error.
function resolve(zone, qname, qtype) {
  const z = normalizeZone(zone);
  const name = normalizeName(qname);
  const type = normType(qtype) || 'A';
  const authoritative = inZone(name, z.name);

  function out(rcode, answers, chain, note) {
    return {
      rcode: rcode,
      rcodeName: rcodeName(rcode),
      authoritative: authoritative,
      qname: name,
      qtype: type,
      answers: copyRecords(answers),
      cnameChain: (chain || []).slice(),
      note: note || ''
    };
  }

  if (type !== ANY && RECORD_TYPES.indexOf(type) === -1) {
    return out(RCODE.NOTIMP, [], [], 'unsupported query type ' + type);
  }

  const map = new Map();
  for (const rec of z.records) {
    if (!map.has(rec.name)) map.set(rec.name, []);
    map.get(rec.name).push(rec);
  }

  const start = recordsAt(map, name);
  if (start.length === 0) {
    return out(RCODE.NXDOMAIN, [], [], 'no such name in zone ' + fqdn(z.name));
  }

  const direct = selectType(start, type);
  if (type === ANY || type === 'CNAME') {
    return out(RCODE.NOERROR, direct, []);
  }
  if (direct.length) return out(RCODE.NOERROR, direct, []);
  if (firstOfType(start, 'CNAME') === null) {
    return out(RCODE.NOERROR, [], [], 'name exists without ' + type + ' records');
  }

  // Walk the CNAME chain.
  const answers = [];
  const chain = [];
  const seen = new Set([name]);
  let current = name;
  let depth = 0;

  while (true) {
    const here = recordsAt(map, current);
    const cn = firstOfType(here, 'CNAME');

    if (cn === null) {
      if (here.length === 0) {
        return out(RCODE.NXDOMAIN, answers, chain,
          'cname target ' + fqdn(current) + ' does not exist in zone ' + fqdn(z.name));
      }
      return out(RCODE.NOERROR, answers.concat(selectType(here, type)), chain);
    }

    if (depth >= MAX_CNAME_DEPTH) {
      return out(RCODE.SERVFAIL, [], chain,
        'cname chain longer than ' + MAX_CNAME_DEPTH + ' hops');
    }

    const target = normalizeName(cn.value);
    answers.push(cn);
    chain.push(current);

    if (seen.has(target)) {
      return out(RCODE.SERVFAIL, [], chain,
        'cname loop at ' + fqdn(target));
    }
    seen.add(target);
    current = target;
    depth++;
  }
}

// ---------------------------------------------------------------------------
// reverse lookup
// ---------------------------------------------------------------------------

// '10.0.0.10' -> '10.0.0.10.in-addr.arpa'; null for anything that is not IPv4.
function reverseName(ip) {
  const s = trimStr(ip);
  if (!net.isIp(s)) return null;
  let n;
  try {
    n = net.ipToInt(s);
  } catch (err) {
    return null;
  }
  const octets = net.intToIp(n).split('.');
  octets.reverse();
  return octets.join('.') + '.in-addr.arpa';
}

// ---------------------------------------------------------------------------
// answer cache (step driven, never wall-clock)
// ---------------------------------------------------------------------------

function createCache() {
  return { entries: new Map() };
}

function cacheMap(cache) {
  if (cache && typeof cache === 'object' && cache.entries instanceof Map) return cache.entries;
  return null;
}

function cacheKey(qname, qtype) {
  return normalizeName(qname) + '|' + (normType(qtype) || 'A');
}

// Store an answer set. `ttl` counts down from the step it was stored at.
function cachePut(cache, qname, qtype, answers, ttl, step) {
  const entries = cacheMap(cache);
  if (entries === null) return;
  entries.set(cacheKey(qname, qtype), {
    qname: normalizeName(qname),
    qtype: normType(qtype) || 'A',
    answers: copyRecords(answers),
    ttl: ttlOf(ttl, 0),
    storedStep: stepOf(step)
  });
}

// -> { hit, answers, ttlRemaining }. An entry whose remaining TTL has dropped to
// zero is a miss and is evicted lazily.
function cacheLookup(cache, qname, qtype, step) {
  const miss = { hit: false, answers: [], ttlRemaining: 0 };
  const entries = cacheMap(cache);
  if (entries === null) return miss;

  const key = cacheKey(qname, qtype);
  const entry = entries.get(key);
  if (!entry) return miss;

  const elapsed = stepOf(step) - entry.storedStep;
  const remaining = entry.ttl - elapsed;
  if (remaining <= 0) {
    entries.delete(key);
    return miss;
  }
  return { hit: true, answers: copyRecords(entry.answers), ttlRemaining: remaining };
}

// ---------------------------------------------------------------------------
// upstream server selection
// ---------------------------------------------------------------------------

function describeServer(s, index) {
  if (typeof s === 'string') {
    const v = trimStr(s);
    return { raw: s, ip: net.isIp(v) ? v : null, zone: null, index: index };
  }
  if (s && typeof s === 'object') {
    const ipIn = trimStr(s.ip !== undefined ? s.ip
      : (s.address !== undefined ? s.address
        : (s.addr !== undefined ? s.addr : s.server)));
    const zoneIn = trimStr(s.zone !== undefined ? s.zone : s.zoneName);
    return {
      raw: s,
      ip: net.isIp(ipIn) ? ipIn : null,
      zone: zoneIn === '' ? null : normalizeName(zoneIn),
      index: index
    };
  }
  return { raw: s, ip: null, zone: null, index: index };
}

function compareServers(a, b) {
  const ai = a.ip === null ? null : net.ipToInt(a.ip);
  const bi = b.ip === null ? null : net.ipToInt(b.ip);
  if (ai !== null && bi !== null) {
    if (ai !== bi) return ai - bi;
    return a.index - b.index;
  }
  if (ai !== null) return -1;
  if (bi !== null) return 1;
  if (a.ip !== b.ip) return String(a.ip) < String(b.ip) ? -1 : 1;
  return a.index - b.index;
}

// Deterministic choice: prefer a server that is authoritative for the queried
// name, then take the lowest IP address (numeric, not lexicographic). Stable for
// equal addresses by input order.
function planQuery(servers, qname) {
  let list;
  if (Array.isArray(servers)) list = servers.filter(function (s) { return s !== null && s !== undefined; });
  else if (servers === null || servers === undefined) list = [];
  else list = [servers];

  if (list.length === 0) return { server: null, ip: null, reason: 'no-servers' };

  const name = normalizeName(qname);
  const described = list.map(describeServer);

  const inZoneList = described.filter(function (d) { return d.zone !== null && inZone(name, d.zone); });
  const pool = (inZoneList.length ? inZoneList : described).slice();
  pool.sort(compareServers);

  const best = pool[0];
  let reason;
  if (list.length === 1) reason = 'only-server';
  else if (inZoneList.length && inZoneList.length < described.length) reason = 'zone-match';
  else reason = 'lowest-ip';

  return { server: best.raw, ip: best.ip, reason: reason };
}

// ---------------------------------------------------------------------------
// presentation
// ---------------------------------------------------------------------------

function rdataText(rec) {
  const type = normType(rec.type);
  const value = trimStr(rec.value);
  const prio = (typeof rec.priority === 'number') ? rec.priority : 0;
  if (type === 'MX') return prio + ' ' + fqdn(value);
  if (type === 'CNAME' || type === 'NS' || type === 'PTR') return fqdn(value);
  if (type === 'TXT') return '"' + value + '"';
  return value;
}

function answerLine(rec) {
  const type = normType(rec.type) || 'A';
  return fqdn(normalizeName(rec.name)) + ' ' + ttlOf(rec.ttl, DEFAULT_TTL) +
    ' IN ' + type + ' ' + rdataText(rec);
}

// -> array of human-readable lines, for a CLI 'nslookup' command.
function formatAnswer(res) {
  const r = (res && typeof res === 'object') ? res : {};
  const qname = normalizeName(r.qname);
  const qtype = normType(r.qtype) || ANY;
  const rcode = (typeof r.rcode === 'number') ? r.rcode : RCODE.SERVFAIL;
  const answers = Array.isArray(r.answers) ? r.answers : [];
  const chain = Array.isArray(r.cnameChain) ? r.cnameChain : [];

  const lines = [];
  lines.push('Query: ' + fqdn(qname) + ' ' + qtype + ' -> ' + rcodeName(rcode) +
    (r.authoritative ? ' (authoritative)' : ' (non-authoritative)'));

  for (const a of answers) lines.push('  ' + answerLine(a));

  if (chain.length) {
    const parts = chain.map(fqdn);
    const finalRecord = answers.filter(function (a) { return normType(a.type) !== 'CNAME'; })[0];
    if (finalRecord) {
      const owner = fqdn(finalRecord.name);
      if (parts[parts.length - 1] !== owner) parts.push(owner);
    }
    lines.push('  cname chain: ' + parts.join(' -> '));
  }

  if (rcode === RCODE.NXDOMAIN) {
    lines.push("  ** server can't find " + fqdn(qname) + ': NXDOMAIN');
  } else if (rcode === RCODE.SERVFAIL) {
    lines.push('  ** server failure: ' + (r.note || 'resolution failed'));
  } else if (rcode !== RCODE.NOERROR) {
    lines.push('  ** ' + rcodeName(rcode) + (r.note ? ': ' + r.note : ''));
  } else if (answers.length === 0) {
    lines.push('  no ' + qtype + ' records for ' + fqdn(qname) + ' (empty NOERROR)');
  }

  return lines;
}

module.exports = {
  DNS_PORT,
  RECORD_TYPES,
  RCODE,
  CLASS_IN,
  MAX_CNAME_DEPTH,
  normalizeZone,
  validateZone,
  normalizeName,
  recordMatches,
  resolve,
  reverseName,
  createCache,
  cachePut,
  cacheLookup,
  planQuery,
  formatAnswer
};
