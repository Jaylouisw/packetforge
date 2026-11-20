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

// Every line of a list with the sequence number a box shows beside it.
//
// The number is the entry's own when it was given one, and otherwise the default the vendor documents:
// "if entries with no sequence numbers are applied, the first entry is assigned a sequence number of 10,
// and successive entries are incremented by 10" (Cisco IOS XE, IP Access List Entry Sequence Numbering,
// sec-acl-seq-num). The default is taken from the position the entry was *typed* at, not from where it
// lands after sorting, so an entry given 5 in front of one that defaulted to 10 keeps its ten.
//
// ...except that a **standard** list is not printed in sequence order at all. IOS moves every entry that
// pins one address - `host 10.1.1.1`, `10.1.1.1 0.0.0.0`, both of which it stores with a wildcard of all
// zeroes - above the entries that match a range, and it does so in the configuration file as well as in the
// show output:
//
//   "The switch always rewrites the order of standard access lists so that entries with host matches and
//    entries with matches having a don't care mask of 0.0.0.0 are moved to the top of the list, above any
//    entries with non-zero don't care masks. Therefore, in show command output and in the configuration
//    file, the ACEs do not necessarily appear in the order in which they were entered."
//   (Catalyst 2960-X 15.2(6)E configuration guide, and the same paragraph in the 2960 12.2(25)FX through
//    15.2(4)E books, the 2960-XR, 3560CX/2960CX, Catalyst 1000 and IE4010/5000 guides)
//
// A capture on an IOS router settles the one thing the guides leave open - what happens to the numbers of
// the moved lines: a named standard list typed in one order prints its two host entries (30, 40) above the
// /24 entries numbered 10 and 20, each line keeping the number it was given, so the column is no longer
// monotonic (Cisco Community, "Reordered named access-list",
// https://community.cisco.com/t5/switching/reordered-named-access-list/td-p/844044). The reply on that
// thread calls it long-standing IOS behaviour on every router and version. research/standard-ace-host-order.md.
//
// Within each group the order is still sequence-then-typed, because that is all the capture shows (the two
// hosts are 30 then 40 and the ranges are 10, 20, 50, 60, 70 - both readings agree).
//
// The display and the first-match evaluation read this one ordering, so the numbers an operator reads are
// the order the box tests packets in, and neither can drift from the other.
function isHostEntry(entry) {
  if (!entry || typeof entry !== 'object' || entry.error) return false;
  if (entry.kind !== 'standard') return false;
  const spec = entry.source;
  if (!spec || spec.any || isAnySpec(spec)) return false;
  const wild = ipToIntSafe(spec.wildcard === undefined || spec.wildcard === null ? WILDCARDS.HOST : spec.wildcard);
  return wild === 0;
}

function numberedEntries(acl) {
  const list = entriesOf(acl);
  return list
    .map(function (entry, index) { return { entry: entry, seq: sequenceOf(entry, index), index: index }; })
    .sort(function (a, b) {
      const aHost = isHostEntry(a.entry) ? 0 : 1;
      const bHost = isHostEntry(b.entry) ? 0 : 1;
      if (aHost !== bHost) return aHost - bHost;
      return (a.seq - b.seq) || (a.index - b.index);
    });
}

function sortAcl(entries) {
  return numberedEntries(Array.isArray(entries) ? entries : []).map(function (slot) { return slot.entry; });
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
// display
// ---------------------------------------------------------------------------

// The body of a standard entry, in the spelling a box puts after the sequence number.
//
// `show access-lists` printed the line exactly as it had been typed, so a standard entry read
//   `10 permit 192.168.1.0 0.0.0.255`
// where every IOS prints
//   `10 permit 192.168.1.0, wildcard bits 0.0.0.255`
// and read `20 deny host 10.0.1.10` where a box drops the `host` keyword (`20 deny 10.0.1.10`). The comma
// and the words `wildcard bits` are the vendor's own rendering - the standard-list form, not the extended
// one, which keeps `host` and prints the address and wildcard side by side with no comma:
//   * https://www.cisco.com/c/en/us/support/docs/security/ios-firewall/23602-confaccesslists.html
//     (`15 permit 10.10.10.0, wildcard bits 0.0.0.255`, `25 deny any`, `30 permit 172.16.1.11`)
//   * Catalyst 2960 12.2(44)SE Command Reference, `show access-lists`
//     (http://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst2960/software/release/12-2_44_se/command/reference/cr/cli2.pdf)
//     (`10 permit 1.1.1.1`, `30 permit any`)
//   * Catalyst 2960-L 15.2(5)E config guide, `show ip access-lists kmd1`
//     (`100 permit 10.4.4.0, wildcard bits 0.0.0.255`)
//   * ntc-templates real captures, cisco_ios_show_access-list.raw
//     (https://raw.githubusercontent.com/networktocode/ntc-templates/master/tests/cisco_ios/show_access-list/cisco_ios_show_access-list.raw)
//     (`10 permit 10.1.2.3 log`, `30 deny   192.168.1.0, wildcard bits 0.0.0.255`)
//
// A host is printed as the bare address, `any` as `any`, and anything else as `<address>, wildcard bits
// <wildcard>`. `any` covers both spellings of the same ACE: an entry typed `0.0.0.0 255.255.255.255` prints
// `any` too, because that is the object the box stored - the address/wildcard pair is turned into an ACE at
// parse time and the display is generated from the ACE, not from the keystrokes
// (research/show-access-lists-any-wildcard.md).
//
// Returns null for an entry this function does not speak for - an extended line, or one with no parsed
// source (an older topology file that stored only the text) - so the caller keeps printing the typed line
// rather than inventing a rendering.
// Is this spec the ACE `any`? Two spellings, one object: the keyword, and the address and wildcard
// `0.0.0.0 255.255.255.255` that the vendor documents as `any`'s expansion. A host of 0.0.0.0
// (`0.0.0.0 0.0.0.0`) is not this - its wildcard is all zeroes, so every bit is compared.
function isAnySpec(spec) {
  if (!spec) return false;
  if (spec.any) return true;
  return ipToIntSafe(spec.ip) === 0 && ipToIntSafe(spec.wildcard) === 0xffffffff;
}

function displayBody(entry) {
  if (!entry || typeof entry !== 'object' || entry.error) return null;
  if (entry.kind !== 'standard' || !entry.source || !entry.action) return null;
  const spec = entry.source;
  let source;
  if (isAnySpec(spec)) source = 'any';
  else if (!spec.wildcard || spec.wildcard === WILDCARDS.HOST) source = String(spec.ip);
  else source = String(spec.ip) + ', wildcard bits ' + String(spec.wildcard);
  return entry.action + ' ' + source + (entry.log ? ' log' : '');
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
      return { action: list[i].action, matchedIndex: i, matchedEntry: list[i], implicit: false };
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
  sortAcl,
  numberedEntries,
  displayBody
};
