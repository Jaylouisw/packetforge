'use strict';
// acl.test.js -- unit tests for engine/acl.js (Cisco-style ACLs).
// Plain harness, no framework. Packets are hand-built plain objects so the
// tests exercise the matcher in isolation (no device, no simulator).

const acl = require('../engine/acl');

let passed = 0;
let failed = 0;

function ok(cond, msg) {
  if (cond) {
    passed++;
    console.log('  \u2713 ' + msg);
  } else {
    failed++;
    console.error('  \u2717 ' + msg);
  }
}

function same(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function codes(list) {
  return (list || []).map(function (e) { return e.code; });
}

function hasCode(list, code) {
  return codes(list).indexOf(code) !== -1;
}

function mkPkt(spec) {
  return Object.assign({
    srcIp: '10.0.0.1',
    dstIp: '10.0.0.2',
    protocol: 'tcp',
    srcPort: 49152,
    dstPort: 80
  }, spec);
}

// ---------------------------------------------------------------------------
// 1. aclKind ranges
// ---------------------------------------------------------------------------

ok(acl.aclKind(1) === 'standard', 'aclKind(1) is standard');
ok(acl.aclKind(99) === 'standard', 'aclKind(99) is standard');
ok(acl.aclKind(1300) === 'standard', 'aclKind(1300) is standard');
ok(acl.aclKind(1999) === 'standard', 'aclKind(1999) is standard');
ok(acl.aclKind(100) === 'extended', 'aclKind(100) is extended');
ok(acl.aclKind(199) === 'extended', 'aclKind(199) is extended');
ok(acl.aclKind(2000) === 'extended', 'aclKind(2000) is extended');
ok(acl.aclKind(2699) === 'extended', 'aclKind(2699) is extended');
ok(acl.aclKind(0) === null, 'aclKind(0) is null');
ok(acl.aclKind(1299) === null, 'aclKind(1299) is null');
ok(acl.aclKind(2700) === null, 'aclKind(2700) is null');
ok(acl.aclKind(101.5) === null, 'aclKind(101.5) is null');
ok(acl.aclKind(null) === null, 'aclKind(null) is null');
ok(acl.aclKind('150') === 'extended', 'aclKind("150") accepts a numeric string');

// ---------------------------------------------------------------------------
// 2. wildcard constants
// ---------------------------------------------------------------------------

ok(acl.WILDCARDS.HOST === '0.0.0.0', 'WILDCARDS.HOST is 0.0.0.0');
ok(acl.WILDCARDS.ANY === '255.255.255.255', 'WILDCARDS.ANY is 255.255.255.255');

// ---------------------------------------------------------------------------
// 3. parseAddressSpec
// ---------------------------------------------------------------------------

const anySpec = acl.parseAddressSpec(['any'], 0);
ok(anySpec.any === true && anySpec.host === false, '"any" parses as any, not host');
ok(anySpec.ip === '0.0.0.0' && anySpec.wildcard === '255.255.255.255', '"any" becomes 0.0.0.0 255.255.255.255');
ok(anySpec.next === 1, '"any" consumes one token');

const hostSpec = acl.parseAddressSpec(['host', '10.0.0.5'], 0);
ok(hostSpec.ip === '10.0.0.5' && hostSpec.wildcard === '0.0.0.0', '"host 10.0.0.5" becomes 10.0.0.5 0.0.0.0');
ok(hostSpec.host === true && hostSpec.any === false, '"host ..." flags host, not any');
ok(hostSpec.next === 2, '"host 10.0.0.5" consumes two tokens');

const wildSpec = acl.parseAddressSpec('10.0.0.0 0.0.0.255', 0);
ok(wildSpec.ip === '10.0.0.0' && wildSpec.wildcard === '0.0.0.255', 'address + wildcard parses both fields');

const bareSpec = acl.parseAddressSpec(['10.0.0.7'], 0);
ok(bareSpec.wildcard === '0.0.0.0' && bareSpec.host === true, 'a lone address defaults to host');

const ipLogSpec = acl.parseAddressSpec(['10.0.0.7', 'log'], 0);
ok(ipLogSpec.wildcard === '0.0.0.0' && ipLogSpec.next === 1, 'a trailing "log" is not eaten as a wildcard');

ok(acl.parseAddressSpec(['permit', 'host', '10.0.0.9', 'log'], 1).ip === '10.0.0.9', 'parsing honours the start index');
ok(acl.parseAddressSpec(['host', '10.0.0.9'], 0).next === 2, 'next index points past the operand');

ok(hasCode([acl.parseAddressSpec(['host', '10.0.0.999'], 0).error], 'E_ADDRESS'), 'bad host address reports E_ADDRESS');
ok(hasCode([acl.parseAddressSpec(['10.0.0.0', '0.0.0.256'], 0).error], 'E_ADDRESS'), 'bad wildcard reports E_ADDRESS');
ok(hasCode([acl.parseAddressSpec([], 0).error], 'E_ADDRESS'), 'missing address reports E_ADDRESS');

// ---------------------------------------------------------------------------
// 4. ipMatches (significant bits = wildcard zeroes)
// ---------------------------------------------------------------------------

ok(acl.ipMatches('10.0.0.5', wildSpec) === true, '10.0.0.5 matches 10.0.0.0 0.0.0.255');
ok(acl.ipMatches('11.1.1.5', wildSpec) === false, '11.1.1.5 does not match 10.0.0.0 0.0.0.255');
ok(acl.ipMatches('10.0.0.5', hostSpec) === true, 'the host itself matches');
ok(acl.ipMatches('10.0.0.6', hostSpec) === false, 'a neighbour does not match a host entry');
ok(acl.ipMatches('203.0.113.9', anySpec) === true, 'any matches an arbitrary address');

const oddSpec = { ip: '10.1.5.1', wildcard: '0.0.255.0', any: false, host: false };
ok(acl.ipMatches('10.1.9.1', oddSpec) === true, 'a non-contiguous wildcard ignores the third octet');
ok(acl.ipMatches('10.2.5.1', oddSpec) === false, 'a non-contiguous wildcard still checks the second octet');
ok(acl.ipMatches('not-an-ip', anySpec) === false, 'a malformed packet address never matches');

// ---------------------------------------------------------------------------
// 5. parseEntry
// ---------------------------------------------------------------------------

const std = acl.parseEntry('permit host 10.0.0.5 log', 10);
ok(std.kind === 'standard' && std.action === 'permit', 'standard entry keeps kind and action');
ok(std.source.ip === '10.0.0.5' && std.source.wildcard === '0.0.0.0', 'standard entry keeps the host spec');
ok(std.log === true, 'standard entry records the log flag');
ok(std.destination === null && std.protocol === null, 'standard entry has no destination or protocol');
ok(std.acl === 10, 'parseEntry stamps the ACL number');

const stdAny = acl.parseEntry('deny any', 99);
ok(stdAny.action === 'deny' && stdAny.source.any === true, 'standard "deny any" parses');

const ext = acl.parseEntry('deny tcp host 10.0.0.5 any eq 80', 110);
ok(ext.kind === 'extended' && ext.protocol === 'tcp', 'extended entry keeps protocol tcp');
ok(ext.source.host === true && ext.destination.any === true, 'extended entry parses both addresses');
ok(ext.port && ext.port.op === 'eq' && ext.port.value === 80, 'eq 80 becomes { eq, 80 }');

const extGt = acl.parseEntry('permit udp any any gt 1023', 110);
ok(extGt.port.op === 'gt' && extGt.port.value === 1023, 'gt 1023 parses');

const extLt = acl.parseEntry('permit tcp any any lt 1024 log', 110);
ok(extLt.port.op === 'lt' && extLt.port.value === 1024, 'lt 1024 parses');
ok(extLt.log === true, 'port + log parse together');

ok(acl.parseEntry('permit tcp any any eq www', 110).port.value === 80, 'service names resolve (www -> 80)');

const seqEntry = acl.parseEntry('20 permit tcp any any', 110);
ok(seqEntry.sequence === 20, 'a leading sequence number is accepted');
ok(acl.parseEntry('permit tcp any any', 110).sequence === null, 'a missing sequence is left null');

ok(hasCode([acl.parseEntry('allow tcp any any', 110).error], 'E_ACTION'), 'a bad action reports E_ACTION');
ok(hasCode([acl.parseEntry('permit tcp any any', 42).error], 'E_PROTOCOL'), 'a protocol in a standard ACL reports E_PROTOCOL');
ok(hasCode([acl.parseEntry('permit host 10.0.0.5', 110).error], 'E_PROTOCOL'), 'a host line in an extended ACL reports E_PROTOCOL');
ok(hasCode([acl.parseEntry('permit tcp any any', 999).error], 'E_ACL_NUMBER'), 'an out-of-range ACL number reports E_ACL_NUMBER');
ok(hasCode([acl.parseEntry('permit tcp any any eq 99999', 110).error], 'E_PORT'), 'a port above 65535 reports E_PORT');
ok(hasCode([acl.parseEntry('permit tcp any any sniff 80', 110).error], 'E_ENTRY'), 'a junk keyword reports E_ENTRY');

// ---------------------------------------------------------------------------
// 6. first match wins / implicit deny / explicit deny
// ---------------------------------------------------------------------------

const ordered = {
  number: 110,
  entries: [
    acl.parseEntry('deny tcp host 10.0.0.5 any eq 80', 110),
    acl.parseEntry('permit tcp any any', 110)
  ]
};

const denied = acl.evaluate(ordered, mkPkt({ srcIp: '10.0.0.5', dstPort: 80 }));
ok(denied.action === 'deny', 'the first matching entry decides the action');
ok(denied.matchedIndex === 0, 'first-match-wins reports index 0');
ok(denied.implicit === false, 'an explicit match is not implicit');

const allowed = acl.evaluate(ordered, mkPkt({ srcIp: '10.0.0.5', dstPort: 443 }));
ok(allowed.action === 'permit' && allowed.matchedIndex === 1, 'the second entry wins when the first misses');

const missed = acl.evaluate({ number: 110, entries: [acl.parseEntry('permit host 10.0.0.9 any', 110)] }, mkPkt());
ok(missed.action === 'deny', 'no match produces a deny');
ok(missed.implicit === true && missed.matchedIndex === null, 'the deny is implicit with no matched index');

const permitAll = acl.evaluate({ number: 110, entries: [acl.parseEntry('permit ip any any', 110)] }, mkPkt({ protocol: 'icmp' }));
ok(permitAll.action === 'permit' && permitAll.implicit === false, 'permit ip any any permits icmp');

// 'ip' as a protocol matches anything; a named protocol does not over-match.
const ipOnly = acl.evaluate({ number: 110, entries: [acl.parseEntry('permit ip any any', 110)] }, mkPkt({ protocol: 'udp', dstPort: 53 }));
ok(ipOnly.action === 'permit', 'an "ip" entry matches udp too');

const tcpOnly = acl.evaluate({ number: 110, entries: [acl.parseEntry('permit tcp any any', 110)] }, mkPkt({ protocol: 'icmp' }));
ok(tcpOnly.action === 'deny' && tcpOnly.implicit === true, 'a tcp entry does not match icmp');

const unknownTransport = acl.evaluate({ number: 110, entries: [acl.parseEntry('permit tcp any any', 110)] }, mkPkt({ protocol: 'ip' }));
ok(unknownTransport.implicit === true, 'a tcp entry does not match a bare "ip" packet');

// ---------------------------------------------------------------------------
// 7. port operators
// ---------------------------------------------------------------------------

const eqAcl = { number: 110, entries: [acl.parseEntry('permit tcp any any eq 443', 110)] };
ok(acl.evaluate(eqAcl, mkPkt({ dstPort: 443 })).action === 'permit', 'eq matches the exact port');
ok(acl.evaluate(eqAcl, mkPkt({ dstPort: 444 })).action === 'deny', 'eq rejects a different port');

const gtAcl = { number: 110, entries: [acl.parseEntry('permit tcp any any gt 1023', 110)] };
ok(acl.evaluate(gtAcl, mkPkt({ dstPort: 1024 })).action === 'permit', 'gt matches a higher port');
ok(acl.evaluate(gtAcl, mkPkt({ dstPort: 1023 })).action === 'deny', 'gt rejects the boundary port');

const ltAcl = { number: 110, entries: [acl.parseEntry('permit tcp any any lt 1024', 110)] };
ok(acl.evaluate(ltAcl, mkPkt({ dstPort: 1023 })).action === 'permit', 'lt matches a lower port');
ok(acl.evaluate(ltAcl, mkPkt({ dstPort: 1024 })).action === 'deny', 'lt rejects the boundary port');
ok(acl.evaluate(eqAcl, mkPkt({ protocol: 'udp', dstPort: 443 })).action === 'deny', 'a tcp/443 entry does not match a udp/443 packet');

// ---------------------------------------------------------------------------
// 8. standard + wildcard matching through evaluate
// ---------------------------------------------------------------------------

const stdAcl = { number: 10, entries: [acl.parseEntry('permit 10.0.0.0 0.0.0.255', 10)] };
ok(acl.evaluate(stdAcl, mkPkt({ srcIp: '10.0.0.77', protocol: 'icmp' })).action === 'permit', 'a standard entry permits any transport from the subnet');
ok(acl.evaluate(stdAcl, mkPkt({ srcIp: '10.0.1.77' })).implicit === true, 'a standard entry rejects an outside source');

const stdDeny = { number: 10, entries: [acl.parseEntry('deny host 10.0.0.5', 10), acl.parseEntry('permit any', 10)] };
ok(acl.evaluate(stdDeny, mkPkt({ srcIp: '10.0.0.5' })).action === 'deny', 'an explicit standard deny matches the host');
ok(acl.evaluate(stdDeny, mkPkt({ srcIp: '10.0.0.6' })).action === 'permit', 'the following permit-any catches the rest');

// ---------------------------------------------------------------------------
// 9. ordering helpers + immutability
// ---------------------------------------------------------------------------

const unsorted = [
  acl.parseEntry('30 permit ip any any', 110),
  acl.parseEntry('10 deny tcp any any', 110),
  acl.parseEntry('20 permit udp any any', 110)
];
const beforeOrder = unsorted.map(function (e) { return e.sequence; });
const sorted = acl.sortAcl(unsorted);

ok(sorted.length === 3 && sorted !== unsorted, 'sortAcl returns a new array');
ok(same(sorted.map(function (e) { return e.sequence; }), [10, 20, 30]), 'sortAcl orders by sequence');
ok(same(unsorted.map(function (e) { return e.sequence; }), beforeOrder), 'sortAcl leaves the input untouched');

const autoSeq = acl.normalizeAcl([acl.parseEntry('permit any', 10), acl.parseEntry('deny host 10.0.0.5', 10)]);
ok(same(autoSeq.map(function (e) { return e.sequence; }), [10, 20]), 'normalizeAcl numbers unsorted entries 10, 20');

const mixed = acl.normalizeAcl([
  acl.parseEntry('permit ip any any', 110),
  acl.parseEntry('5 deny ip any any', 110)
]);
ok(mixed[0].sequence === 5 && mixed[1].sequence === 10, 'normalizeAcl sorts explicit sequences ahead');
ok(mixed[0] !== mixed[1] && typeof mixed[0].source.ip === 'string', 'normalizeAcl returns populated entries');

const mutable = { number: 110, entries: [acl.parseEntry('deny tcp any any eq 22', 110)] };
const snapshot = JSON.stringify(mutable);
acl.evaluate(mutable, mkPkt({ dstPort: 22 }));
acl.normalizeAcl(mutable.entries);
acl.sortAcl(mutable.entries);
ok(JSON.stringify(mutable) === snapshot, 'evaluate/normalize/sort do not mutate the caller\'s entries');
ok(mutable.entries[0].source.wildcard === '255.255.255.255', 'nested address specs survive evaluation');

const original = acl.parseEntry('permit tcp any any eq 80', 110);
const originalJson = JSON.stringify(original);
acl.normalizeAcl([original]);
ok(JSON.stringify(original) === originalJson, 'normalizeAcl does not mutate the entries it clones');

// ---------------------------------------------------------------------------
// 10. validateAcl
// ---------------------------------------------------------------------------

const good = acl.validateAcl({ number: 110, entries: [acl.parseEntry('permit tcp any any eq 80', 110)] });
ok(good.ok === true, 'a well-formed extended ACL validates');
ok(same(good.errors, []), 'a valid ACL reports no errors');

const goodStd = acl.validateAcl({ number: 1300, entries: [acl.parseEntry('deny host 10.0.0.5 log', 1300)] });
ok(goodStd.ok === true, 'a well-formed standard ACL validates');

const badNumber = acl.validateAcl({ number: 999, entries: [acl.parseEntry('permit any', 10)] });
ok(badNumber.ok === false && hasCode(badNumber.errors, 'E_ACL_NUMBER'), 'an out-of-range ACL number is rejected');
ok(/999/.test(badNumber.errors[0].message), 'the ACL-number error names the number');

const emptyAcl = acl.validateAcl({ number: 110, entries: [] });
ok(emptyAcl.ok === false && hasCode(emptyAcl.errors, 'E_NO_ENTRIES'), 'an empty ACL is rejected');

const dupSeq = acl.validateAcl({
  number: 110,
  entries: [acl.parseEntry('10 permit ip any any', 110), acl.parseEntry('10 deny ip any any', 110)]
});
ok(dupSeq.ok === false && hasCode(dupSeq.errors, 'E_SEQUENCE'), 'duplicate sequence numbers are rejected');

const kindMismatch = acl.validateAcl({
  number: 10,
  entries: [acl.parseEntry('permit tcp any any', 110)]
});
ok(kindMismatch.ok === false && hasCode(kindMismatch.errors, 'E_KIND'), 'an extended entry in a standard ACL is rejected');

const badAction = acl.validateAcl([{
  sequence: 10,
  kind: 'standard',
  action: 'allow',
  source: { ip: '0.0.0.0', wildcard: '255.255.255.255', any: true, host: false }
}]);
ok(badAction.ok === false && hasCode(badAction.errors, 'E_ACTION'), 'an invalid action is rejected');

const badPort = acl.validateAcl({
  number: 110,
  entries: [{
    sequence: 10,
    kind: 'extended',
    action: 'permit',
    protocol: 'tcp',
    source: { ip: '0.0.0.0', wildcard: '255.255.255.255', any: true, host: false },
    destination: { ip: '0.0.0.0', wildcard: '255.255.255.255', any: true, host: false },
    port: { op: 'eq', value: 70000 }
  }]
});
ok(badPort.ok === false && hasCode(badPort.errors, 'E_PORT'), 'a port above 65535 is rejected');

const badProtocol = acl.validateAcl({
  number: 110,
  entries: [{
    sequence: 10,
    kind: 'extended',
    action: 'permit',
    protocol: 'gre',
    source: { ip: '10.0.0.1', wildcard: '0.0.0.0', any: false, host: true },
    destination: { ip: '0.0.0.0', wildcard: '255.255.255.255', any: true, host: false }
  }]
});
ok(badProtocol.ok === false && hasCode(badProtocol.errors, 'E_PROTOCOL'), 'an unsupported protocol is rejected');

const badAddress = acl.validateAcl({ number: 10, entries: [acl.parseEntry('permit host 10.0.0.5', 10)] });
ok(badAddress.ok === true, 'a standard host entry validates clean');

const parsedErrors = acl.validateAcl({ number: 110, entries: [acl.parseEntry('allow tcp any any', 110)] });
ok(parsedErrors.ok === false && hasCode(parsedErrors.errors, 'E_ACTION'), 'parse errors surface through validateAcl');
ok(parsedErrors.errors.length > 0 && typeof parsedErrors.errors[0].message === 'string', 'validation errors carry a message');

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
