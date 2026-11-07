'use strict';
// dns.test.js -- unit tests for the DNS zone model, resolver and answer cache.
// Plain asserts, no framework. Every fixture is a hand-built zone object so the
// tests exercise engine/dns.js in isolation (no simulator, no devices, no
// server). Cache freshness is driven purely by the `step` numbers passed in.

const dns = require('../engine/dns');

let passed = 0;
let failed = 0;

function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg); }
}

function eq(actual, expected, msg) {
  ok(actual === expected, msg + ' (expected ' + JSON.stringify(expected) +
    ', got ' + JSON.stringify(actual) + ')');
}

function section(title) {
  console.log('\n' + title);
}

function codes(list) {
  return (list || []).map(function (e) { return e.code; });
}

function hasCode(list, code) {
  return codes(list).indexOf(code) !== -1;
}

function messages(list) {
  return (list || []).map(function (e) { return e.message; }).join(' | ');
}

function types(res) {
  return (res.answers || []).map(function (a) { return a.type; });
}

function values(res) {
  return (res.answers || []).map(function (a) { return a.value; });
}

function text(res) {
  return dns.formatAnswer(res).join('\n');
}

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

function mkZone(overrides) {
  return Object.assign({
    name: 'lab',
    defaultTtl: 300,
    records: [
      { name: 'lab', type: 'SOA', value: 'ns1.lab. hostmaster.lab. 1 3600 600 86400 300' },
      { name: 'lab', type: 'NS', value: 'ns1.lab.' },
      { name: 'lab', type: 'MX', value: 'mail.lab.', priority: 10 },
      { name: 'ns1', type: 'A', value: '10.0.0.53' },
      { name: 'web', type: 'A', value: '10.0.0.10' },
      { name: 'web', type: 'A', value: '10.0.0.11' },
      { name: 'mail', type: 'A', value: '10.0.0.25' },
      { name: 'www', type: 'CNAME', value: 'web.lab' },
      { name: 'alias', type: 'CNAME', value: 'www.lab' },
      { name: 'txt', type: 'TXT', value: 'v=spf1 -all' },
      { name: 'v6', type: 'AAAA', value: 'fd00::10' },
      { name: 'sip', type: 'SRV', value: '0 5 5060 sip.lab' }
    ]
  }, overrides || {});
}

const ZONE = mkZone();
const PTR_ZONE = {
  name: '0.0.10.in-addr.arpa',
  defaultTtl: 300,
  records: [
    { name: '20', type: 'PTR', value: 'web.lab.' },
    { name: '25', type: 'PTR', value: 'mail.lab.' }
  ]
};

// d0 -> d1 -> ... -> d<N-1> -> d<N> (A record)
function chainZone(prefix, depth) {
  const records = [];
  for (let i = 0; i < depth; i++) {
    records.push({ name: prefix + i, type: 'CNAME', value: prefix + (i + 1) + '.chain' });
  }
  records.push({ name: prefix + depth, type: 'A', value: '10.9.9.' + (depth + 1) });
  return { name: 'chain', defaultTtl: 60, records: records };
}

// ---------------------------------------------------------------------------
// 1. constants
// ---------------------------------------------------------------------------

section('1. constants');

eq(dns.DNS_PORT, 53, 'DNS_PORT is 53');
eq(dns.CLASS_IN, 1, 'CLASS_IN is 1');
eq(dns.RECORD_TYPES.length, 9, 'there are nine record types');
eq(dns.RECORD_TYPES.indexOf('AAAA'), 1, 'AAAA is a known type');
ok(dns.RECORD_TYPES.indexOf('CNAME') !== -1, 'CNAME is a known type');
ok(dns.RECORD_TYPES.indexOf('SRV') !== -1, 'SRV is a known type');
eq(dns.RCODE.NOERROR, 0, 'NOERROR is 0');
eq(dns.RCODE.FORMERR, 1, 'FORMERR is 1');
eq(dns.RCODE.SERVFAIL, 2, 'SERVFAIL is 2');
eq(dns.RCODE.NXDOMAIN, 3, 'NXDOMAIN is 3');
eq(dns.RCODE.NOTIMP, 4, 'NOTIMP is 4');
eq(dns.RCODE.REFUSED, 5, 'REFUSED is 5');
eq(dns.MAX_CNAME_DEPTH, 8, 'the CNAME chain bound is 8');

// ---------------------------------------------------------------------------
// 2. name handling
// ---------------------------------------------------------------------------

section('2. name normalisation');

eq(dns.normalizeName('WWW.Lab.'), 'www.lab', 'names lowercase and drop the trailing dot');
eq(dns.normalizeName('web.lab'), 'web.lab', 'an already canonical name is unchanged');
eq(dns.normalizeName('.'), '.', 'the root stays a single dot');
eq(dns.normalizeName(''), '.', 'an empty name is the root');
eq(dns.normalizeName(null), '.', 'a null name is the root');
eq(dns.normalizeName('a..'), 'a', 'repeated trailing dots are all stripped');
eq(dns.normalizeName('  Mail.LAB.  '), 'mail.lab', 'surrounding whitespace is ignored');

// ---------------------------------------------------------------------------
// 3. zone normalisation
// ---------------------------------------------------------------------------

section('3. zone normalisation');

const bare = dns.normalizeZone({});
eq(bare.name, '.', 'a nameless zone becomes the root');
eq(bare.defaultTtl, 3600, 'an omitted defaultTtl defaults to one hour');
ok(Array.isArray(bare.records) && bare.records.length === 0, 'an omitted records list becomes an empty array');

const relative = dns.normalizeZone({
  name: 'lab',
  records: [{ name: 'web', type: 'a', value: '10.0.0.10' }]
});
eq(relative.records[0].name, 'web.lab', 'a relative owner name is qualified against the apex');
eq(relative.records[0].type, 'A', 'record types are uppercased');
eq(relative.records[0].ttl, 3600, 'a record without a ttl inherits the zone default');

const absoluteRec = dns.normalizeZone({
  name: 'lab',
  records: [{ name: 'web.other.com.', type: 'A', value: '10.0.0.10', ttl: 60 }]
});
eq(absoluteRec.records[0].name, 'web.other.com', 'an absolute owner name is not re-qualified');
eq(absoluteRec.records[0].ttl, 60, 'an explicit ttl is kept');

const already = dns.normalizeZone({
  name: 'example.com',
  records: [{ name: 'www.example.com', type: 'A', value: '10.0.0.10' }]
});
eq(already.records[0].name, 'www.example.com', 'a name already inside the apex is not doubled up');

const atSign = dns.normalizeZone({ name: 'lab', records: [{ name: '@', type: 'NS', value: 'ns1.lab.' }] });
eq(atSign.records[0].name, 'lab', '@ means the apex');

const norm = dns.normalizeZone(ZONE);
eq(norm.name, 'lab', 'the zone keeps its apex');
eq(norm.defaultTtl, 300, 'the zone keeps its default ttl');
eq(norm.records.length, ZONE.records.length, 'every record survives normalisation');
eq(norm.records[8].name, 'alias.lab', 'the ninth record is qualified');
ok(JSON.stringify(dns.normalizeZone(ZONE)) === JSON.stringify(norm), 'zone normalisation is idempotent');

// ---------------------------------------------------------------------------
// 4. validation: the happy path
// ---------------------------------------------------------------------------

section('4. zone validation -- accepts');

const good = dns.validateZone(ZONE);
eq(good.ok, true, 'a well-formed zone validates: ' + messages(good.errors));
eq(good.errors.length, 0, 'a well-formed zone reports no errors');
ok(Array.isArray(good.errors), 'errors is always an array');
eq(dns.validateZone(norm).ok, true, 'a normalised zone still validates');
eq(dns.validateZone(PTR_ZONE).ok, true, 'a reverse zone validates');
eq(dns.validateZone(chainZone('d', 3)).ok, true, 'a CNAME chain zone validates');

const mxZero = dns.validateZone({
  name: 'lab',
  records: [
    { name: 'lab', type: 'MX', value: 'mail.lab.', priority: 0 },
    { name: 'lab', type: 'MX', value: 'backup.lab.', priority: 20 }
  ]
});
eq(mxZero.ok, true, 'an MX preference of 0 is valid and two MX differ by preference');

const stringPriority = dns.validateZone({
  name: 'lab',
  records: [{ name: 'lab', type: 'MX', value: 'mail.lab.', priority: '10' }]
});
eq(stringPriority.ok, true, 'a numeric-string MX priority is accepted');

// ---------------------------------------------------------------------------
// 5. validation: rejections
// ---------------------------------------------------------------------------

section('5. zone validation -- rejects');

const badType = dns.validateZone({
  name: 'lab', records: [{ name: 'web', type: 'WKS', value: '10.0.0.10' }]
});
eq(badType.ok, false, 'an unknown record type is rejected');
ok(hasCode(badType.errors, 'E_DNS_BAD_TYPE'), 'unknown type reports E_DNS_BAD_TYPE: ' + messages(badType.errors));

const noValue = dns.validateZone({
  name: 'lab', records: [{ name: 'web', type: 'A', value: '' }]
});
ok(hasCode(noValue.errors, 'E_DNS_MISSING_VALUE'), 'an empty value reports E_DNS_MISSING_VALUE');

const noValue2 = dns.validateZone({ name: 'lab', records: [{ name: 'web', type: 'A' }] });
ok(hasCode(noValue2.errors, 'E_DNS_MISSING_VALUE'), 'a missing value reports E_DNS_MISSING_VALUE');

const cnameClash = dns.validateZone({
  name: 'lab',
  records: [
    { name: 'www', type: 'CNAME', value: 'web.lab.' },
    { name: 'www', type: 'A', value: '10.0.0.10' }
  ]
});
eq(cnameClash.ok, false, 'a CNAME sharing an owner name is rejected');
ok(hasCode(cnameClash.errors, 'E_DNS_CNAME_CONFLICT'), 'CNAME plus A reports E_DNS_CNAME_CONFLICT');

const mxNoPrio = dns.validateZone({
  name: 'lab', records: [{ name: 'lab', type: 'MX', value: 'mail.lab.' }]
});
eq(mxNoPrio.ok, false, 'an MX without a preference is rejected');
ok(hasCode(mxNoPrio.errors, 'E_DNS_MX_NO_PRIORITY'), 'MX without priority reports E_DNS_MX_NO_PRIORITY');

const dup = dns.validateZone({
  name: 'lab',
  records: [
    { name: 'web', type: 'A', value: '10.0.0.10' },
    { name: 'web', type: 'A', value: '10.0.0.10' },
    { name: 'web', type: 'A', value: '10.0.0.11' }
  ]
});
eq(dup.ok, false, 'an identical duplicate record is rejected');
ok(hasCode(dup.errors, 'E_DNS_DUPLICATE'), 'the duplicate reports E_DNS_DUPLICATE');
eq(codes(dup.errors).filter(function (c) { return c === 'E_DNS_DUPLICATE'; }).length, 1,
  'only the repeated record is reported');

const dupCase = dns.validateZone({
  name: 'lab',
  records: [
    { name: 'lab', type: 'NS', value: 'ns1.lab.' },
    { name: 'lab', type: 'NS', value: 'NS1.LAB.' }
  ]
});
ok(hasCode(dupCase.errors, 'E_DNS_DUPLICATE'), 'duplicate detection is case-insensitive for names');

const notDup = dns.validateZone({
  name: 'lab',
  records: [
    { name: 'lab', type: 'MX', value: 'mail.lab.', priority: 10 },
    { name: 'lab', type: 'MX', value: 'mail.lab.', priority: 20 }
  ]
});
eq(notDup.ok, true, 'the same MX target with a different preference is not a duplicate');

const badA = dns.validateZone({
  name: 'lab', records: [{ name: 'web', type: 'A', value: '10.0.0.999' }]
});
ok(hasCode(badA.errors, 'E_DNS_BAD_VALUE'), 'a malformed IPv4 value reports E_DNS_BAD_VALUE');

const badTtl = dns.validateZone({
  name: 'lab', records: [{ name: 'web', type: 'A', value: '10.0.0.10', ttl: -5 }]
});
ok(hasCode(badTtl.errors, 'E_DNS_BAD_TTL'), 'a negative ttl reports E_DNS_BAD_TTL');

const junkTtl = dns.validateZone({
  name: 'lab', records: [{ name: 'web', type: 'A', value: '10.0.0.10', ttl: 'soon' }]
});
ok(hasCode(junkTtl.errors, 'E_DNS_BAD_TTL'), 'an unparseable ttl reports E_DNS_BAD_TTL');

const noZoneName = dns.validateZone({ records: [] });
ok(hasCode(noZoneName.errors, 'E_DNS_MISSING_ZONE_NAME'), 'a nameless zone reports E_DNS_MISSING_ZONE_NAME');

// ---------------------------------------------------------------------------
// 6. record matching
// ---------------------------------------------------------------------------

section('6. record matching');

const webRec = { name: 'web.lab', type: 'A', ttl: 300, value: '10.0.0.10' };
eq(dns.recordMatches(webRec, 'web.lab', 'A'), true, 'an exact name and type matches');
eq(dns.recordMatches(webRec, 'WEB.LAB.', 'a'), true, 'matching ignores case and a trailing dot');
eq(dns.recordMatches(webRec, 'web.lab', 'AAAA'), false, 'a different type does not match');
eq(dns.recordMatches(webRec, 'mail.lab', 'A'), false, 'a different owner does not match');
eq(dns.recordMatches(webRec, 'web.lab', 'ANY'), true, 'ANY matches every type');
eq(dns.recordMatches(null, 'web.lab', 'A'), false, 'a null record does not match');

// ---------------------------------------------------------------------------
// 7. resolving exact names
// ---------------------------------------------------------------------------

section('7. resolve -- exact names');

const webRes = dns.resolve(ZONE, 'web.lab', 'A');
eq(webRes.rcode, dns.RCODE.NOERROR, 'an existing name answers NOERROR');
eq(webRes.rcodeName, 'NOERROR', 'the rcode name is spelled out');
eq(webRes.authoritative, true, 'the zone is authoritative for its own names');
eq(webRes.answers.length, 2, 'both A records come back');
eq(types(webRes).join(','), 'A,A', 'the answers are A records');
eq(values(webRes).join(','), '10.0.0.10,10.0.0.11', 'the answers carry their addresses');
eq(webRes.answers[0].ttl, 300, 'answers inherit the record ttl');
eq(webRes.cnameChain.length, 0, 'an exact match follows no CNAME');

const upperRes = dns.resolve(ZONE, 'WEB.Lab.', 'a');
eq(upperRes.answers.length, 2, 'case and a trailing dot do not change the answer');
eq(upperRes.qname, 'web.lab', 'the question name is echoed canonically');

const nsRes = dns.resolve(ZONE, 'lab', 'NS');
eq(nsRes.answers.length, 1, 'the apex NS is answered');
eq(nsRes.answers[0].value, 'ns1.lab.', 'the NS target is preserved');

const mxRes = dns.resolve(ZONE, 'lab', 'MX');
eq(mxRes.answers.length, 1, 'the apex MX is answered');
eq(mxRes.answers[0].priority, 10, 'the MX preference is carried on the answer');

const anyRes = dns.resolve(ZONE, 'web.lab', 'ANY');
eq(anyRes.answers.length, 2, 'ANY returns every record at the name');

const cnameOnly = dns.resolve(ZONE, 'www.lab', 'CNAME');
eq(cnameOnly.answers.length, 1, 'a direct CNAME query returns the CNAME itself');
eq(cnameOnly.cnameChain.length, 0, 'asking for the CNAME does not follow it');

const v6Res = dns.resolve(ZONE, 'v6.lab', 'AAAA');
eq(v6Res.answers.length, 1, 'an AAAA record is answered');
eq(dns.resolve(ZONE, 'v6.lab', 'A').answers.length, 0, 'A does not match an AAAA owner');

// ---------------------------------------------------------------------------
// 8. CNAME chains
// ---------------------------------------------------------------------------

section('8. resolve -- CNAME chains');

const wwwRes = dns.resolve(ZONE, 'www.lab', 'A');
eq(wwwRes.rcode, dns.RCODE.NOERROR, 'a CNAME chain still ends in NOERROR');
eq(wwwRes.answers.length, 3, 'the CNAME plus both target A records are returned');
eq(types(wwwRes).join(','), 'CNAME,A,A', 'the CNAME leads the answer list');
eq(wwwRes.cnameChain.join(','), 'www.lab', 'the chain names the owner that was followed');
eq(wwwRes.answers[0].value, 'web.lab', 'the CNAME keeps its target');
eq(wwwRes.answers[2].name, 'web.lab', 'the terminal records belong to the target owner');

const aliasRes = dns.resolve(ZONE, 'alias.lab', 'A');
eq(aliasRes.answers.length, 4, 'a two hop chain returns both CNAMEs and the addresses');
eq(aliasRes.cnameChain.join(','), 'alias.lab,www.lab', 'the chain lists every hop in order');
eq(types(aliasRes).join(','), 'CNAME,CNAME,A,A', 'both CNAMEs precede the addresses');

const chainZone8 = chainZone('d', 8);
const hop8 = dns.resolve(chainZone8, 'd0.chain', 'A');
eq(hop8.rcode, dns.RCODE.NOERROR, 'a chain of exactly eight hops resolves');
eq(hop8.cnameChain.length, 8, 'all eight hops are recorded');
eq(hop8.answers.length, 9, 'eight CNAMEs plus the terminal A are returned');
eq(hop8.answers[8].type, 'A', 'the last answer is the terminal record');

const chainZone9 = chainZone('e', 9);
const hop9 = dns.resolve(chainZone9, 'e0.chain', 'A');
eq(hop9.rcode, dns.RCODE.SERVFAIL, 'a chain longer than eight hops is SERVFAIL');
eq(hop9.answers.length, 0, 'a SERVFAIL carries no answers');
eq(hop9.note.indexOf('longer than 8') !== -1, true, 'the SERVFAIL note names the hop bound');
ok(hop9.cnameChain.length <= dns.MAX_CNAME_DEPTH, 'the traced chain stays within the bound');

// ---------------------------------------------------------------------------
// 9. CNAME loops
// ---------------------------------------------------------------------------

section('9. resolve -- CNAME loops');

const loopZone = {
  name: 'loop',
  records: [
    { name: 'a', type: 'CNAME', value: 'b.loop' },
    { name: 'b', type: 'CNAME', value: 'a.loop' }
  ]
};
const loopRes = dns.resolve(loopZone, 'a.loop', 'A');
eq(loopRes.rcode, dns.RCODE.SERVFAIL, 'a two name CNAME loop is SERVFAIL');
eq(loopRes.answers.length, 0, 'a loop returns no answers');
ok(loopRes.note.indexOf('loop') !== -1, 'the SERVFAIL note names the loop: ' + loopRes.note);
ok(loopRes.cnameChain.length <= dns.MAX_CNAME_DEPTH, 'a loop terminates within the depth bound');

const selfZone = {
  name: 'loop',
  records: [{ name: 'self', type: 'CNAME', value: 'self.loop' }]
};
eq(dns.resolve(selfZone, 'self.loop', 'A').rcode, dns.RCODE.SERVFAIL, 'a self-referential CNAME is SERVFAIL');

const threeZone = {
  name: 'loop',
  records: [
    { name: 'p', type: 'CNAME', value: 'q.loop' },
    { name: 'q', type: 'CNAME', value: 'r.loop' },
    { name: 'r', type: 'CNAME', value: 'p.loop' }
  ]
};
eq(dns.resolve(threeZone, 'p.loop', 'A').rcode, dns.RCODE.SERVFAIL, 'a three name CNAME loop is SERVFAIL');

// ---------------------------------------------------------------------------
// 10. negative answers
// ---------------------------------------------------------------------------

section('10. resolve -- negative answers');

const nx = dns.resolve(ZONE, 'nosuch.lab', 'A');
eq(nx.rcode, dns.RCODE.NXDOMAIN, 'an unknown name is NXDOMAIN');
eq(nx.rcodeName, 'NXDOMAIN', 'the rcode name is spelled out');
eq(nx.answers.length, 0, 'NXDOMAIN carries no answers');
eq(nx.cnameChain.length, 0, 'NXDOMAIN follows no chain');
eq(dns.resolve(ZONE, 'web', 'A').rcode, dns.RCODE.NXDOMAIN,
  'an unqualified name is not silently qualified at query time');

const outOfZone = dns.resolve(ZONE, 'other.example', 'A');
eq(outOfZone.rcode, dns.RCODE.NXDOMAIN, 'a name outside the zone is NXDOMAIN');
eq(outOfZone.authoritative, false, 'the zone is not authoritative outside its apex');

const danglingZone = {
  name: 'lab',
  records: [{ name: 'gone', type: 'CNAME', value: 'nowhere.lab' }]
};
const dangling = dns.resolve(danglingZone, 'gone.lab', 'A');
eq(dangling.rcode, dns.RCODE.NXDOMAIN, 'a CNAME pointing at a missing name is NXDOMAIN');
eq(dangling.cnameChain.join(','), 'gone.lab', 'the dangling hop is still traced');

const empty = dns.resolve(ZONE, 'txt.lab', 'A');
eq(empty.rcode, dns.RCODE.NOERROR, 'a name without the requested type is NOERROR');
eq(empty.answers.length, 0, 'the empty NOERROR carries no answers');
eq(empty.note.indexOf('without A') !== -1, true, 'the note explains the empty answer');
eq(dns.resolve(ZONE, 'txt.lab', 'TXT').answers.length, 1, 'the type the name does own still answers');

const notimp = dns.resolve(ZONE, 'web.lab', 'SPF');
eq(notimp.rcode, dns.RCODE.NOTIMP, 'an unsupported query type is NOTIMP');
eq(notimp.answers.length, 0, 'NOTIMP carries no answers');

// ---------------------------------------------------------------------------
// 11. reverse names
// ---------------------------------------------------------------------------

section('11. reverse lookup');

eq(dns.reverseName('10.0.0.20'), '20.0.0.10.in-addr.arpa', '10.0.0.20 reverses to 20.0.0.10');
eq(dns.reverseName('192.168.1.254'), '254.1.168.192.in-addr.arpa', '192.168.1.254 reverses octet-wise');
eq(dns.reverseName('8.8.8.8'), '8.8.8.8.in-addr.arpa', 'a symmetrical address reverses to itself');
eq(dns.reverseName('172.16.0.1'), '1.0.16.172.in-addr.arpa', '172.16.0.1 reverses octet-wise');
eq(dns.reverseName('256.1.1.1'), null, 'an out of range octet has no reverse name');
eq(dns.reverseName('10.0.0'), null, 'a three octet string has no reverse name');
eq(dns.reverseName('not-an-ip'), null, 'garbage has no reverse name');
eq(dns.reverseName(''), null, 'an empty string has no reverse name');

const ptrRes = dns.resolve(PTR_ZONE, dns.reverseName('10.0.0.20'), 'PTR');
eq(ptrRes.rcode, dns.RCODE.NOERROR, 'a reverse name resolves in the reverse zone');
eq(ptrRes.answers.length, 1, 'the PTR record is returned');
eq(ptrRes.answers[0].value, 'web.lab.', 'the PTR points at the forward name');
eq(dns.resolve(PTR_ZONE, dns.reverseName('10.0.0.99'), 'PTR').rcode, dns.RCODE.NXDOMAIN,
  'an unmapped address is NXDOMAIN in the reverse zone');

// ---------------------------------------------------------------------------
// 12. the answer cache
// ---------------------------------------------------------------------------

section('12. answer cache');

const cache = dns.createCache();
ok(cache.entries instanceof Map, 'a cache holds a Map of entries');
eq(cache.entries.size, 0, 'a new cache is empty');

const cold = dns.cacheLookup(cache, 'web.lab', 'A', 0);
eq(cold.hit, false, 'a cold lookup misses');
eq(cold.answers.length, 0, 'a miss carries no answers');
eq(cold.ttlRemaining, 0, 'a miss reports no remaining ttl');

const cached = dns.resolve(ZONE, 'web.lab', 'A').answers;
dns.cachePut(cache, 'web.lab', 'A', cached, 300, 0);
eq(cache.entries.size, 1, 'a put stores one entry');

const warm = dns.cacheLookup(cache, 'web.lab', 'A', 0);
eq(warm.hit, true, 'the stored entry hits at the same step');
eq(warm.answers.length, 2, 'the cached answer set is returned');
eq(warm.ttlRemaining, 300, 'the remaining ttl starts at the stored ttl');

eq(dns.cacheLookup(cache, 'web.lab', 'A', 10).ttlRemaining, 290, 'the ttl decrements with the step');
eq(dns.cacheLookup(cache, 'web.lab', 'A', 100).ttlRemaining, 200, 'the ttl keeps counting down');
eq(dns.cacheLookup(cache, 'web.lab', 'A', 299).hit, true, 'the entry still hits at ttl - 1');
eq(dns.cacheLookup(cache, 'web.lab', 'A', 299).ttlRemaining, 1, 'one second of ttl is left');

const expired = dns.cacheLookup(cache, 'web.lab', 'A', 300);
eq(expired.hit, false, 'the entry misses exactly when the ttl runs out');
eq(expired.ttlRemaining, 0, 'an expired entry reports no remaining ttl');
eq(cache.entries.size, 0, 'an expired entry is evicted');

eq(dns.cacheLookup(cache, 'web.lab', 'A', 0).hit, false, 'the evicted entry does not come back');

dns.cachePut(cache, 'WEB.Lab.', 'a', cached, 120, 50);
eq(dns.cacheLookup(cache, 'web.lab', 'A', 55).hit, true, 'cache keys ignore case and a trailing dot');
eq(dns.cacheLookup(cache, 'web.lab', 'A', 55).ttlRemaining, 115, 'the ttl counts from the stored step');
eq(dns.cacheLookup(cache, 'web.lab', 'AAAA', 55).hit, false, 'another type is a different key');
eq(dns.cacheLookup(cache, 'mail.lab', 'A', 55).hit, false, 'another name is a different key');

dns.cachePut(cache, 'zero.lab', 'A', [], 0, 0);
eq(dns.cacheLookup(cache, 'zero.lab', 'A', 0).hit, false, 'a zero ttl entry never hits');

const shared = dns.cacheLookup(cache, 'web.lab', 'A', 55);
shared.answers.push({ name: 'x.lab', type: 'A', ttl: 1, value: '1.1.1.1' });
shared.answers[0].value = 'tampered';
const fresh = dns.cacheLookup(cache, 'web.lab', 'A', 55);
eq(fresh.answers.length, 2, 'mutating a returned answer set does not grow the cache');
eq(fresh.answers[0].value, '10.0.0.10', 'mutating a returned answer does not corrupt the cache');

eq(dns.cacheLookup(null, 'web.lab', 'A', 0).hit, false, 'a null cache misses instead of throwing');
ok(dns.cachePut(null, 'web.lab', 'A', cached, 60, 0) === undefined, 'a put on a null cache is a no-op');

// ---------------------------------------------------------------------------
// 13. server selection
// ---------------------------------------------------------------------------

section('13. planQuery');

const three = ['10.0.0.2', '10.0.0.1', '10.0.0.3'];
const planA = dns.planQuery(three, 'web.lab');
eq(planA.server, '10.0.0.1', 'the lowest address is chosen');
eq(planA.reason, 'lowest-ip', 'the reason names the lowest address rule');
const planB = dns.planQuery(three.slice().reverse(), 'web.lab');
eq(planB.server, '10.0.0.1', 'the choice does not depend on input order');
eq(dns.planQuery(three, 'web.lab').server, planA.server, 'repeated planning is stable');

eq(dns.planQuery(['10.0.0.10', '10.0.0.9'], 'web.lab').server, '10.0.0.9',
  'addresses compare numerically, not as strings');
eq(dns.planQuery(['10.0.0.1'], 'web.lab').reason, 'only-server', 'a lone server is chosen as the only one');
eq(dns.planQuery(['10.0.0.1'], 'web.lab').server, '10.0.0.1', 'a lone server is returned');

const none = dns.planQuery([], 'web.lab');
eq(none.server, null, 'no servers yields a null choice');
eq(none.reason, 'no-servers', 'no servers yields the no-servers reason');
eq(dns.planQuery(null, 'web.lab').reason, 'no-servers', 'a null server list is tolerated');

const primary = { ip: '10.0.0.9', zone: 'other' };
const secondary = { ip: '10.0.0.2', zone: 'lab' };
const zoned = dns.planQuery([primary, secondary], 'web.lab');
eq(zoned.server, secondary, 'a server authoritative for the name wins over a lower address');
eq(zoned.ip, '10.0.0.2', 'the chosen address is reported');
eq(zoned.reason, 'zone-match', 'the reason names the zone match');
eq(dns.planQuery([primary, secondary], 'host.other').server, primary,
  'a name in the other zone picks the other server');
eq(dns.planQuery([primary, secondary], 'host.other').reason, 'zone-match',
  'the other zone match reports the same reason');

const plain = [{ ip: '10.0.0.7' }, { ip: '10.0.0.6' }];
eq(dns.planQuery(plain, 'web.lab').server.ip, '10.0.0.6', 'servers without a zone fall back to lowest ip');
eq(dns.planQuery(plain, 'web.lab').reason, 'lowest-ip', 'servers without a zone report lowest-ip');
eq(dns.planQuery([{ name: 'ns1.lab' }, { ip: '10.0.0.4' }], 'web.lab').ip, '10.0.0.4',
  'an unreadable server address sorts last');

// ---------------------------------------------------------------------------
// 14. presentation
// ---------------------------------------------------------------------------

section('14. formatAnswer');

const wwwLines = dns.formatAnswer(wwwRes);
ok(Array.isArray(wwwLines), 'formatAnswer returns an array');
ok(wwwLines[0].indexOf('www.lab.') !== -1, 'the header carries the question name');
ok(wwwLines[0].indexOf('NOERROR') !== -1, 'the header carries the rcode');
ok(text(wwwRes).indexOf('IN CNAME web.lab.') !== -1, 'a CNAME answer is rendered');
ok(text(wwwRes).indexOf('IN A 10.0.0.10') !== -1, 'an A answer is rendered');
ok(text(wwwRes).indexOf('cname chain: www.lab. -> web.lab.') !== -1, 'the chain is rendered');
eq(text(wwwRes).split('\n').length, 5, 'a header, three answers and a chain line are produced');

ok(text(nx).indexOf('NXDOMAIN') !== -1, 'an NXDOMAIN line is rendered');
ok(text(nx).indexOf("can't find nosuch.lab.") !== -1, 'the NXDOMAIN line names the name');
ok(text(empty).indexOf('no A records') !== -1, 'an empty NOERROR is spelled out');
ok(text(mxRes).indexOf('IN MX 10 mail.lab.') !== -1, 'the MX preference is rendered');
ok(text(dns.resolve(ZONE, 'txt.lab', 'TXT')).indexOf('IN TXT "v=spf1 -all"') !== -1, 'a TXT value is quoted');
ok(text(dns.resolve(ZONE, 'lab', 'NS')).indexOf('IN NS ns1.lab.') !== -1, 'an NS target is presented fully qualified');
ok(text(loopRes).indexOf('server failure') !== -1, 'a SERVFAIL line is rendered');
ok(Array.isArray(dns.formatAnswer(null)) && dns.formatAnswer(null).length >= 1,
  'formatAnswer tolerates a null result');
eq(dns.formatAnswer(wwwRes).join('\n'), dns.formatAnswer(wwwRes).join('\n'), 'formatting is stable');

// ---------------------------------------------------------------------------
// 15. purity -- nothing is mutated
// ---------------------------------------------------------------------------

section('15. non-mutation');

const pristine = mkZone();
const before = JSON.stringify(pristine);
dns.resolve(pristine, 'www.lab', 'A');
dns.resolve(pristine, 'nosuch.lab', 'A');
dns.resolve(pristine, 'web.lab', 'ANY');
eq(JSON.stringify(pristine), before, 'resolving never mutates the zone spec');
eq(pristine.records[4].name, 'web', 'the spec keeps its relative owner names');
eq(pristine.records[0].ttl, undefined, 'the spec gains no ttl it did not have');

const validated = JSON.stringify(pristine);
dns.validateZone(pristine);
eq(JSON.stringify(pristine), validated, 'validating never mutates the zone spec');

const frozen = dns.normalizeZone(ZONE);
const frozenBefore = JSON.stringify(frozen);
const res1 = dns.resolve(frozen, 'alias.lab', 'A');
eq(JSON.stringify(frozen), frozenBefore, 'resolving never mutates a normalised zone');
res1.answers[0].value = 'tampered.lab';
eq(JSON.stringify(frozen), frozenBefore, 'mutating answers does not reach the zone');
res1.answers[0].name = 'tampered.lab';
eq(dns.resolve(frozen, 'alias.lab', 'A').answers[0].value, 'www.lab',
  'a fresh resolve is unaffected by a mutated answer');

const repeatA = JSON.stringify(dns.resolve(ZONE, 'www.lab', 'A'));
const repeatB = JSON.stringify(dns.resolve(ZONE, 'www.lab', 'A'));
eq(repeatA, repeatB, 'resolving the same question twice gives identical output');

ok(JSON.stringify(dns.resolve(ZONE, 'web.lab', 'A').answers.map(function (a) { return a.ttl; })) === '[300,300]',
  'answer ttls follow the zone default');

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
