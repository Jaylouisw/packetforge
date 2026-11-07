'use strict';
// acl.js -- Cisco-style standard/extended access control lists. Pure logic:
// no I/O, no network, no console. IPv4 wildcard maths is delegated to net.js.

const net = require('./net');

// A wildcard of all zeroes means "match every bit" (a single host); a wildcard
// of all ones means "no bits matter" (any address).
const WILDCARDS = { HOST: '0.0.0.0', ANY: '255.255.255.255' };

const STANDARD_RANGES = [[1, 99], [1300, 1999]];
const EXTENDED_RANGES = [[100, 199], [2000, 2699]];

const PROTOCOLS = ['ip', 'tcp', 'udp', 'icmp'];
const IP_PROTOCOLS = ['ip', 'tcp', 'udp', 'icmp'];
const PORT_OPS = ['eq', 'gt', 'lt'];

// Well-known service names accepted wherever a numeric port is accepted.
const PORT_NAMES = {
  'ftp-data': 20, ftp: 21, ssh: 22, telnet: 23, smtp: 25, domain: 53, dns: 53,
  bootps: 67, bootpc: 68, tftp: 69, www: 80, http: 80, pop3: 110, ntp: 123,
  imap: 143, snmp: 161, https: 443, 'www-ssl': 443, isakmp: 500, syslog: 514,
  msSql: 1433, sqlnet: 1521, radius: 1812, 'radius-acct': 1813, mysql: 3306,
  rdp: 3389
};

function err(code, message) {
  return { error: { code: code, message: message } };
}

function inRanges(n, ranges) {
  for (let i = 0; i < ranges.length; i++) {
    if (n >= ranges[i][0] && n <= ranges[i][1]) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// ACL numbering
// ---------------------------------------------------------------------------

function aclKind(number) {
  if (number === null || number === undefined) return null;
  const n = typeof number === 'number' ? number : Number(String(number).trim());
  if (!Number.isInteger(n)) return null;
  if (inRanges(n, STANDARD_RANGES)) return 'standard';
  if (inRanges(n, EXTENDED_RANGES)) return 'extended';
  return null;
}

// ---------------------------------------------------------------------------
// addresses + wildcards
// ---------------------------------------------------------------------------

function ipToIntSafe(ip) {
  try {
    return net.ipToInt(ip);
  } catch (e) {
    return null;
  }
}

function isValidIp(ip) {
  return typeof ip === 'string' && ipToIntSafe(ip) !== null;
}

function isValidWildcard(w) {
  return isValidIp(w);
}

function bareSpec(ip, wildcard, any, host) {
  return { ip: ip, wildcard: wildcard, any: !!any, host: !!host };
}

function specOf(spec) {
  return bareSpec(spec.ip, spec.wildcard, spec.any, spec.host);
}

// Parse one address operand out of a token list starting at index i.
// Accepts 'any', 'host 10.0.0.5' and '10.0.0.0 0.0.0.255'. A lone address
// (with nothing or a trailing keyword after it) is treated as a host.
function parseAddressSpec(tokens, i) {
  const list = Array.isArray(tokens)
    ? tokens
    : String(tokens === undefined || tokens === null ? '' : tokens).trim().split(/\s+/).filter(Boolean);
  const idx = Number.isInteger(i) && i >= 0 ? i : 0;
  const head = String(list[idx] === undefined ? '' : list[idx]).trim().toLowerCase();

  if (!head) return err('E_ADDRESS', 'missing address at token ' + idx);

  if (head === 'any') {
    return Object.assign(bareSpec('0.0.0.0', WILDCARDS.ANY, true, false), { next: idx + 1 });
  }

  if (head === 'host') {
    const ip = String(list[idx + 1] === undefined ? '' : list[idx + 1]).trim();
    if (!isValidIp(ip)) return err('E_ADDRESS', 'invalid host address "' + ip + '"');
    return Object.assign(bareSpec(ip, WILDCARDS.HOST, false, true), { next: idx + 2 });
  }

  const ip = String(list[idx]).trim();
  if (!isValidIp(ip)) return err('E_ADDRESS', 'invalid IPv4 address "' + ip + '"');

  const nxt = list[idx + 1];
  if (nxt === undefined || String(nxt).trim().toLowerCase() === 'log') {
    return Object.assign(bareSpec(ip, WILDCARDS.HOST, false, true), { next: idx + 1 });
  }
  const wildcard = String(nxt).trim();
  if (!isValidWildcard(wildcard)) {
    return err('E_ADDRESS', 'invalid wildcard mask "' + wildcard + '"');
  }
  return Object.assign(bareSpec(ip, wildcard, false, false), { next: idx + 2 });
}

// A bit is significant where the wildcard bit is 0.
function ipMatches(ip, spec) {
  if (!spec) return false;
  const s = typeof spec === 'string' ? bareSpec(spec, WILDCARDS.HOST, false, true) : spec;
  const addr = ipToIntSafe(ip);
  if (addr === null) return false;
  if (s.any) return true;
  if (!s.ip) return false;
  const base = ipToIntSafe(s.ip);
  if (base === null) return false;
  const wild = ipToIntSafe(s.wildcard === undefined || s.wildcard === null ? WILDCARDS.HOST : s.wildcard);
  if (wild === null) return false;
  const mask = (~wild) >>> 0;
  return ((((addr ^ base) & mask) >>> 0) === 0);
}

// ---------------------------------------------------------------------------
// ports
// ---------------------------------------------------------------------------

function parsePort(raw) {
  if (raw === undefined || raw === null) return null;
  const s = String(raw).trim().toLowerCase();
  if (/^\d{1,5}$/.test(s)) {
    const n = parseInt(s, 10);
    return n >= 0 && n <= 65535 ? n : null;
  }
  if (Object.prototype.hasOwnProperty.call(PORT_NAMES, s)) return PORT_NAMES[s];
  return null;
}

function portMatches(spec, pkt) {
  if (!spec) return true;
  const port = Number(pkt.dstPort);
  if (!Number.isInteger(port)) return false;
  const value = Number(spec.value);
  if (!Number.isInteger(value)) return false;
  if (spec.op === 'eq') return port === value;
  if (spec.op === 'gt') return port > value;
  if (spec.op === 'lt') return port < value;
  return false;
}

// ---------------------------------------------------------------------------
// parsing
// ---------------------------------------------------------------------------

// 'permit|deny <source> [log]'
// 'permit|deny <protocol> <source> <dest> [eq|gt|lt <port>] [log]'
function parseEntry(line, aclNumber) {
  const text = typeof line === 'string' ? line.trim() : '';
  if (!text) return err('E_ENTRY', 'empty ACL line');

  const tokens = text.split(/\s+/);
  const number = aclNumber === null || aclNumber === undefined ? null : aclNumber;
  let i = 0;
  let sequence = null;

  if (tokens.length > 2 && /^\d{1,9}$/.test(tokens[0])) {
    sequence = parseInt(tokens[0], 10);
    i = 1;
  }

  const action = String(tokens[i] === undefined ? '' : tokens[i]).toLowerCase();
  if (action !== 'permit' && action !== 'deny') {
    return err('E_ACTION', 'expected "permit" or "deny", got "' + (tokens[i] || '') + '"');
  }
  i++;

  let kind = null;
  let aclNumberValue = null;
  if (number !== null) {
    kind = aclKind(number);
    if (!kind) return err('E_ACL_NUMBER', 'invalid ACL number: ' + number);
    aclNumberValue = typeof number === 'number' ? number : Number(String(number).trim());
  } else {
    const head = String(tokens[i] === undefined ? '' : tokens[i]).toLowerCase();
    kind = PROTOCOLS.indexOf(head) !== -1 ? 'extended' : 'standard';
  }

  const log = false;

  if (kind === 'standard') {
    const head = String(tokens[i] === undefined ? '' : tokens[i]).toLowerCase();
    if (PROTOCOLS.indexOf(head) !== -1) {
      return err('E_PROTOCOL', 'standard entries take a source only, not a protocol ("' + tokens[i] + '")');
    }
    const source = parseAddressSpec(tokens, i);
    if (source.error) return source;
    i = source.next;
    let sawLog = log;
    for (; i < tokens.length; i++) {
      const t = String(tokens[i]).toLowerCase();
      if (t === 'log') { sawLog = true; continue; }
      return err('E_ENTRY', 'unexpected token "' + tokens[i] + '" in standard entry');
    }
    return {
      sequence: sequence,
      acl: aclNumberValue,
      kind: 'standard',
      action: action,
      source: specOf(source),
      destination: null,
      protocol: null,
      port: null,
      log: sawLog,
      line: text
    };
  }

  const protocol = String(tokens[i] === undefined ? '' : tokens[i]).toLowerCase();
  if (PROTOCOLS.indexOf(protocol) === -1) {
    return err('E_PROTOCOL', 'extended entry needs a protocol (ip, tcp, udp, icmp), got "' +
      (tokens[i] || '') + '"');
  }
  i++;

  const source = parseAddressSpec(tokens, i);
  if (source.error) return source;
  i = source.next;

  const destination = parseAddressSpec(tokens, i);
  if (destination.error) return destination;
  i = destination.next;

  let port = null;
  let sawLog = log;
  for (; i < tokens.length; i++) {
    const t = String(tokens[i]).toLowerCase();
    if (t === 'log') { sawLog = true; continue; }
    if (PORT_OPS.indexOf(t) !== -1) {
      if (port) return err('E_PORT', 'only one port operator is allowed per entry');
      const value = parsePort(tokens[i + 1]);
      if (value === null) return err('E_PORT', 'bad port value "' + (tokens[i + 1] === undefined ? '' : tokens[i + 1]) + '"');
      port = { op: t, value: value };
      i++;
      continue;
    }
    return err('E_ENTRY', 'unexpected token "' + tokens[i] + '"');
  }

  return {
    sequence: sequence,
    acl: aclNumberValue,
    kind: 'extended',
    action: action,
    protocol: protocol,
    source: specOf(source),
    destination: specOf(destination),
    port: port,
    log: sawLog,
    line: text
  };
}

// ---------------------------------------------------------------------------
// ordering (never mutates the caller's entries)
// ---------------------------------------------------------------------------

function cloneSpec(spec) {
  if (!spec) return null;
  return specOf(spec);
}

function cloneEntry(entry) {
  if (!entry || typeof entry !== 'object') return entry;
  const copy = Object.assign({}, entry);
  if (entry.source) copy.source = cloneSpec(entry.source);
  if (entry.destination) copy.destination = cloneSpec(entry.destination);
  if (entry.port) copy.port = { op: entry.port.op, value: entry.port.value };
  return copy;
}

function sequenceOf(entry, index) {
  const n = Number(entry && entry.sequence);
  return Number.isFinite(n) && n > 0 ? n : (index + 1) * 10;
}

function sortAcl(entries) {
  const list = Array.isArray(entries) ? entries : [];
  return list
    .map(function (entry, index) { return { entry: entry, seq: sequenceOf(entry, index), index: index }; })
    .sort(function (a, b) { return (a.seq - b.seq) || (a.index - b.index); })
    .map(function (slot) { return slot.entry; });
}

function normalizeAcl(entries) {
  const list = Array.isArray(entries) ? entries.map(cloneEntry) : [];
  list.forEach(function (entry, index) {
    const n = Number(entry.sequence);
    entry.sequence = Number.isFinite(n) && n > 0 ? n : (index + 1) * 10;
  });
  return sortAcl(list);
}

// ---------------------------------------------------------------------------
// matching + evaluation
// ---------------------------------------------------------------------------

function matchEntry(entry, pkt) {
  if (!entry || typeof entry !== 'object' || entry.error) return false;
  if (entry.action !== 'permit' && entry.action !== 'deny') return false;
  if (!pkt || typeof pkt !== 'object') return false;

  const proto = String(pkt.protocol === undefined || pkt.protocol === null ? 'ip' : pkt.protocol).toLowerCase();
  if (IP_PROTOCOLS.indexOf(proto) === -1) return false;

  if (!ipMatches(pkt.srcIp, entry.source)) return false;

  if (entry.kind === 'extended') {
    const want = String(entry.protocol === undefined || entry.protocol === null ? 'ip' : entry.protocol).toLowerCase();
    if (want !== 'ip' && want !== proto) return false;
    if (!ipMatches(pkt.dstIp, entry.destination)) return false;
    if (entry.port && !portMatches(entry.port, pkt)) return false;
  }

  return true;
}

function entriesOf(acl) {
  if (!acl) return [];
  if (Array.isArray(acl)) return acl;
  if (Array.isArray(acl.entries)) return acl.entries;
  return [];
}

// First match wins. Falling off the end is the implicit deny.
function evaluate(acl, pkt) {
  const list = sortAcl(entriesOf(acl));
  for (let i = 0; i < list.length; i++) {
    if (matchEntry(list[i], pkt)) {
      return { action: list[i].action, matchedIndex: i, implicit: false };
    }
  }
  return { action: 'deny', matchedIndex: null, implicit: true };
}

// ---------------------------------------------------------------------------
// validation
// ---------------------------------------------------------------------------

function validateAcl(acl) {
  const errors = [];
  function push(code, message) { errors.push({ code: code, message: message }); }

  if (!acl) {
    push('E_ACL_NUMBER', 'ACL is missing');
    return { ok: false, errors: errors };
  }

  let entries = [];
  let number = null;
  if (Array.isArray(acl)) {
    entries = acl;
    number = entries.length && entries[0] && entries[0].acl !== undefined ? entries[0].acl : null;
  } else {
    entries = Array.isArray(acl.entries) ? acl.entries : [];
    number = acl.number !== undefined && acl.number !== null ? acl.number : acl.acl;
  }

  const kind = aclKind(number);
  if (!kind) {
    push('E_ACL_NUMBER', 'ACL number must be 1-99 or 1300-1999 (standard) or 100-199 or 2000-2699 (extended), got ' +
      (number === undefined || number === null ? 'nothing' : String(number)));
  }

  if (!entries.length) push('E_NO_ENTRIES', 'ACL has no entries (it would deny everything)');

  const seenSeq = {};

  entries.forEach(function (entry, index) {
    if (!entry || typeof entry !== 'object') {
      push('E_ENTRY', 'entry ' + (index + 1) + ' is not an object');
      return;
    }
    const label = 'entry ' + (index + 1) +
      (entry.sequence === undefined || entry.sequence === null ? '' : ' (seq ' + entry.sequence + ')') + ': ';

    if (entry.error) {
      const code = entry.error.code || 'E_ENTRY';
      push(code, label + (entry.error.message || 'parse error'));
      return;
    }

    if (entry.action !== 'permit' && entry.action !== 'deny') {
      push('E_ACTION', label + 'action must be "permit" or "deny", got "' + String(entry.action) + '"');
    }

    const entryKind = entry.kind === 'extended' ? 'extended' : 'standard';
    if (kind && entryKind !== kind) {
      push('E_KIND', label + entryKind + ' entry placed in a ' + kind + ' ACL');
    }

    if (entry.sequence !== undefined && entry.sequence !== null) {
      const seq = Number(entry.sequence);
      if (!Number.isInteger(seq) || seq <= 0) {
        push('E_SEQUENCE', label + 'sequence must be a positive integer, got "' + String(entry.sequence) + '"');
      } else if (seenSeq[seq]) {
        push('E_SEQUENCE', label + 'duplicate sequence number ' + seq);
      } else {
        seenSeq[seq] = true;
      }
    }

    if (!entry.source) {
      push('E_ADDRESS', label + 'missing source address');
    } else if (!isValidIp(entry.source.ip)) {
      push('E_ADDRESS', label + 'invalid source address "' + String(entry.source.ip) + '"');
    } else if (entry.source.wildcard !== undefined && !isValidWildcard(entry.source.wildcard)) {
      push('E_ADDRESS', label + 'invalid source wildcard "' + String(entry.source.wildcard) + '"');
    }

    if (entryKind === 'extended') {
      const protocol = String(entry.protocol === undefined || entry.protocol === null ? '' : entry.protocol).toLowerCase();
      if (PROTOCOLS.indexOf(protocol) === -1) {
        push('E_PROTOCOL', label + 'unsupported protocol "' + String(entry.protocol) + '"');
      }
      if (!entry.destination) {
        push('E_ADDRESS', label + 'missing destination address');
      } else if (!isValidIp(entry.destination.ip)) {
        push('E_ADDRESS', label + 'invalid destination address "' + String(entry.destination.ip) + '"');
      } else if (entry.destination.wildcard !== undefined && !isValidWildcard(entry.destination.wildcard)) {
        push('E_ADDRESS', label + 'invalid destination wildcard "' + String(entry.destination.wildcard) + '"');
      }
    }

    if (entry.port) {
      if (entryKind !== 'extended') {
        push('E_PORT', label + 'a port operator is only valid on extended entries');
      }
      if (PORT_OPS.indexOf(entry.port.op) === -1) {
        push('E_PORT', label + 'unknown port operator "' + String(entry.port.op) + '"');
      }
      const value = Number(entry.port.value);
      if (!Number.isInteger(value) || value < 0 || value > 65535) {
        push('E_PORT', label + 'port must be 0-65535, got "' + String(entry.port.value) + '"');
      }
    }
  });

  return { ok: errors.length === 0, errors: errors };
}

module.exports = {
  aclKind,
  WILDCARDS,
  parseAddressSpec,
  parseEntry,
  normalizeAcl,
  ipMatches,
  matchEntry,
  evaluate,
  validateAcl,
  sortAcl
};
