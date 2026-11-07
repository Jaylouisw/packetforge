'use strict';
// ipv6.test.js -- unit tests for engine/ipv6.js (IPv6 maths, RFC 5952 formatting,
// prefixes and neighbour discovery). Plain assertions, no framework.

const v6 = require('../engine/ipv6');

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

// Assert deep equality of the 8 parsed groups.
function eqGroups(actual, expected, msg) {
  ok(Array.isArray(actual) && actual.length === 8 &&
    actual.every(function (g, i) { return g === expected[i]; }),
    msg + ' (got ' + JSON.stringify(actual) + ')');
}

function eq(actual, expected, msg) {
  ok(actual === expected, msg + ' (expected ' + String(expected) + ', got ' + String(actual) + ')');
}

function parses(str) {
  return v6.parseIpv6(str);
}

function accepted(str) {
  return parses(str).valid === true;
}

function rejected(str) {
  return parses(str).valid === false;
}

// ---------------------------------------------------------------------------
// 1. parsing: full form, compression, case
// ---------------------------------------------------------------------------

const FULL = '2001:0db8:0000:0000:0000:0000:0000:0001';
const pFull = parses(FULL);
ok(pFull.valid === true, 'parses a full eight-group address');
ok(pFull.error === null, 'a valid parse carries error === null');
eqGroups(pFull.groups, [0x2001, 0x0db8, 0, 0, 0, 0, 0, 1], 'full form yields the right groups');
eq(pFull.bigint, v6.ipv6ToBigInt('2001:db8::1'), 'full form and compressed form share a bigint');

eqGroups(parses('1:2:3:4:5:6:7:8').groups, [1, 2, 3, 4, 5, 6, 7, 8], 'parses eight distinct groups');
eqGroups(parses('::').groups, [0, 0, 0, 0, 0, 0, 0, 0], "'::' parses to all zeros");
eqGroups(parses('::1').groups, [0, 0, 0, 0, 0, 0, 0, 1], "'::1' parses to loopback");
eqGroups(parses('fe80::1').groups, [0xfe80, 0, 0, 0, 0, 0, 0, 1], 'link-local parses');
eqGroups(parses('1:2:3:4:5:6:7::').groups, [1, 2, 3, 4, 5, 6, 7, 0],
  "'::' may stand for exactly one zero group at the end");
eqGroups(parses('::2:3:4:5:6:7:8').groups, [0, 2, 3, 4, 5, 6, 7, 8],
  "'::' may stand for exactly one zero group at the start");
ok(parses('FE80::ABCD:1').valid === true, 'uppercase input is accepted');
eq(v6.formatIpv6(parses('FE80::ABCD:1').groups), 'fe80::abcd:1', 'uppercase input formats lowercase');

// Leading/trailing whitespace around the whole address is tolerated.
ok(parses('  ::1  ').valid === true, 'surrounding whitespace is trimmed');

// ---------------------------------------------------------------------------
// 2. RFC 5952 formatting
// ---------------------------------------------------------------------------

eq(v6.formatIpv6([0x2001, 0x0db8, 0, 0, 0, 0, 0, 1]), '2001:db8::1', 'drops leading zeros and compresses');
eq(v6.formatIpv6([0, 0, 0, 0, 0, 0, 0, 0]), '::', 'all-zero address is "::"');
eq(v6.formatIpv6([0, 0, 0, 0, 0, 0, 0, 1]), '::1', 'loopback is "::1"');
eq(v6.formatIpv6([1, 2, 3, 4, 5, 6, 7, 8]), '1:2:3:4:5:6:7:8', 'no zero run means no "::"');
eq(v6.formatIpv6([0x2001, 0x0db8, 0, 1, 1, 1, 1, 1]), '2001:db8:0:1:1:1:1:1',
  'a single zero group is never compressed');
eq(v6.formatIpv6([0x2001, 0, 1, 0, 1, 0, 1, 0]), '2001:0:1:0:1:0:1:0',
  'scattered single zeros are all left in full');
eq(v6.formatIpv6([0x2001, 0x0db8, 0, 0, 1, 0, 0, 1]), '2001:db8::1:0:0:1',
  'tied zero runs compress the leftmost');
eq(v6.formatIpv6([0x2001, 0x0db8, 0, 0, 1, 0, 0, 0]), '2001:db8:0:0:1::',
  'a longer run further right wins over a shorter left run');
eq(v6.formatIpv6([1, 0, 0, 2, 0, 0, 0, 3]), '1:0:0:2::3',
  'longest run wins even when it is not first');
eq(v6.formatIpv6([0, 0, 1, 0, 0, 0, 1, 0]), '0:0:1::1:0',
  'longest of three runs wins and keeps its neighbours');
eq(v6.formatIpv6([0xfe80, 0, 0, 0, 0x021a, 0x2bff, 0xfe3c, 0x4d5e]),
  'fe80::21a:2bff:fe3c:4d5e', 'leading zero inside a group is dropped');
eq(v6.formatIpv6([0xff02, 0, 0, 0, 0, 1, 0xff00, 1]), 'ff02::1:ff00:1',
  'solicited-node shape formats canonically');
eq(v6.formatIpv6([0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff]),
  'ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff', 'all-ones address is never compressed');
eq(v6.formatIpv6(null), '', 'formatIpv6(null) is the empty string, not a throw');
eq(v6.formatIpv6([1, 2, 3]), '', 'formatIpv6 rejects a short array');
eq(v6.formatIpv6([1, 2, 3, 4, 5, 6, 7, 65536]), '', 'formatIpv6 rejects an out-of-range group');

// ---------------------------------------------------------------------------
// 3. round-trip parse -> format -> parse
// ---------------------------------------------------------------------------

const ROUND_TRIP = [
  '::',
  '::1',
  '1:2:3:4:5:6:7:8',
  '2001:db8::1',
  '2001:db8:85a3::8a2e:370:7334',
  'fe80::21a:2bff:fe3c:4d5e',
  'fd12:3456:789a::1',
  'ff02::1:ff00:1',
  '2001:db8:0:0:1:0:0:1',
  '2001:db8::1:0:0:1',
  '0:0:1::1:0',
  '1:0:0:2::3',
  '2001:0:2001:0:2001:0:2001:0',
  '101:0:0:0:0:0:0:101',
  '::ffff:c000:201',
  '64:ff9b::192.0.2.33'
];

ROUND_TRIP.forEach(function (addr) {
  const p = parses(addr);
  if (!p.valid) {
    ok(false, 'round-trip: ' + addr + ' must parse');
    return;
  }
  const text = v6.formatIpv6(p.groups);
  const again = parses(text);
  ok(again.valid === true && again.bigint === p.bigint,
    'round-trip keeps the value of ' + addr + ' (as ' + text + ')');
  ok(v6.formatIpv6(again.groups) === text,
    'formatting is idempotent for ' + addr);
});

// ---------------------------------------------------------------------------
// 4. embedded IPv4
// ---------------------------------------------------------------------------

const mapped = parses('::ffff:192.0.2.1');
ok(mapped.valid === true, 'parses a trailing embedded IPv4 under "::"');
eqGroups(mapped.groups, [0, 0, 0, 0, 0, 0xffff, 0xc000, 0x0201],
  'embedded IPv4 becomes the last two groups');
eq(v6.formatIpv6(mapped.groups), '::ffff:c000:201', 'v4-mapped formats as plain hex groups');
eq(v6.ipv6ToBigInt('::ffff:192.0.2.1'), 0xffffc0000201n, 'v4-mapped bigint is correct');

const nat64 = parses('64:ff9b::192.0.2.33');
ok(nat64.valid === true, 'parses a NAT64-style embedded IPv4');
eq(nat64.bigint & 0xffffffffn, 0xc0000221n, 'NAT64 low 32 bits are the IPv4 address');

const mixed = parses('1:2:3:4:5:6:1.2.3.4');
ok(mixed.valid === true, 'a dotted quad may close a full-form address');
eqGroups(mixed.groups, [1, 2, 3, 4, 5, 6, 0x0102, 0x0304], 'trailing dotted quad expands to two groups');
ok(rejected('1.2.3.4::'), 'an embedded IPv4 may not precede "::"');
ok(rejected('::1.2.3.4:5'), 'an embedded IPv4 may not be followed by more groups');
ok(rejected('::ffff:1.2.3.256'), 'an out-of-range dotted quad octet is rejected');
ok(rejected('::ffff:1.2.3'), 'a three-octet dotted quad is rejected');

// ---------------------------------------------------------------------------
// 5. rejection cases (with stable error codes)
// ---------------------------------------------------------------------------

function rejectCode(str, code, msg) {
  const p = parses(str);
  ok(p.valid === false && p.error && p.error.code === code &&
    typeof p.error.message === 'string' && p.error.message.length > 0,
    msg + ' [' + (p.error ? p.error.code : 'no error') + ']');
}

rejectCode('1:2:3:4:5:6:7:8:9', 'E_GROUP_COUNT', 'rejects nine groups');
rejectCode('1:2:3:4:5:6:7', 'E_GROUP_COUNT', 'rejects seven groups without "::"');
rejectCode('1:2:3:4:5:6:7:8:9::', 'E_TOO_MANY_GROUPS', 'rejects "::" that compresses nothing');
rejectCode('::1::2', 'E_DOUBLE_COMPRESSION', "rejects a second '::'");
rejectCode('1:::2', 'E_TRIPLE_COLON', "rejects a ':::' run");
rejectCode('12345::', 'E_HEX', 'rejects a five-digit group');
rejectCode('g::1', 'E_CHARS', 'rejects a non-hex character');
rejectCode(':', 'E_EMPTY_GROUP', 'rejects a lone colon');
rejectCode(':1:2:3:4:5:6:7:8', 'E_EMPTY_GROUP', 'rejects a leading single colon');
rejectCode('1:2:3:4:5:6:7:8:', 'E_EMPTY_GROUP', 'rejects a trailing single colon');
rejectCode('::1:', 'E_EMPTY_GROUP', 'rejects a trailing single colon after "::"');
rejectCode('', 'E_EMPTY', 'rejects the empty string');
rejectCode('   ', 'E_EMPTY', 'rejects whitespace only');
rejectCode(':: 1', 'E_WHITESPACE', 'rejects whitespace inside the address');
rejectCode('fe80::1%eth0', 'E_CHARS', 'rejects a zone identifier');
rejectCode('192.0.2.1', 'E_GROUP_COUNT', 'rejects a bare IPv4 address');
rejectCode('::1.2.3.4:5', 'E_IPV4_POSITION', 'rejects an embedded IPv4 in a non-final slot');
rejectCode(null, 'E_TYPE', 'rejects null');
rejectCode(undefined, 'E_TYPE', 'rejects undefined');
rejectCode(42, 'E_TYPE', 'rejects a number');

// The failure shape is always complete and inert.
const badShape = parses('nope');
ok(badShape.groups === null && badShape.bigint === null,
  'a failed parse still has groups/bigint keys (set to null)');

// ---------------------------------------------------------------------------
// 6. prefixes
// ---------------------------------------------------------------------------

const p32 = v6.parsePrefix6('2001:db8::/32');
ok(p32.valid === true, 'parses 2001:db8::/32');
eq(p32.prefixLen, 32, 'prefix length is 32');
eq(p32.address, '2001:db8::', 'the prefix keeps the canonical address text');
eq(p32.maskBigint, ((1n << 128n) - 1n) << 96n & ((1n << 128n) - 1n), 'the /32 mask is 96 one bits followed by zeros');
eq(v6.networkAddress6('2001:db8::/32'), '2001:db8::', 'network address of 2001:db8::/32');
eq(v6.networkAddress6('2001:db8:abcd:1234::1/48'), '2001:db8:abcd::',
  'network address masks off the host bits');
eq(v6.networkAddress6('2001:db8:abcd:1234:5678:9abc:def0:1234/64'),
  '2001:db8:abcd:1234::', 'a /64 keeps the whole interface identifier zero');
eq(v6.networkAddress6('::/0'), '::', 'the default prefix has an all-zero network');
eq(v6.networkAddress6('2001:db8::/128'), '2001:db8::', 'a /128 is its own network');
eq(v6.parsePrefix6('::/0').prefixLen, 0, 'accepts a zero-length prefix');
eq(v6.parsePrefix6('2001:db8::').prefixLen, 128, 'a bare address is treated as /128');
ok(v6.parsePrefix6('2001:db8::/129').valid === false, 'rejects a prefix length above 128');
ok(v6.parsePrefix6('2001:db8::/abc').valid === false, 'rejects a non-numeric prefix length');
ok(v6.parsePrefix6('2001:db8::/32/8').valid === false, 'rejects a second slash');
ok(v6.parsePrefix6('2001:db8::/-1').valid === false, 'rejects a negative prefix length');
ok(v6.parsePrefix6(12345).valid === false, 'rejects a non-string prefix');
eq(v6.parsePrefix6('bogus/64').error.code, 'E_ADDRESS', 'an unparsable prefix reports E_ADDRESS');

ok(v6.prefixContains6('2001:db8::/32', '2001:db8:ffff::1') === true, '/32 contains its own far end');
ok(v6.prefixContains6('2001:db8::/32', '2001:db8:0:0:0:0:0:0') === true, '/32 contains the network address');
ok(v6.prefixContains6('2001:db8::/32', '2001:db9::1') === false, '/32 excludes the next prefix');
ok(v6.prefixContains6('2001:db8::/33', '2001:db8:7fff::1') === true,
  '/33 contains its lower half (0x7fff)');
ok(v6.prefixContains6('2001:db8::/33', '2001:db8:8000::1') === false,
  '/33 excludes its upper half (0x8000)');
ok(v6.prefixContains6('fe80::/10', 'febf:ffff::1') === true, 'fe80::/10 top edge is inside');
ok(v6.prefixContains6('fe80::/10', 'fec0::1') === false, 'fec0::1 is outside fe80::/10');
ok(v6.prefixContains6('::/0', '2001:db8::1') === true, 'the default prefix contains everything');
ok(v6.prefixContains6('2001:db8::/128', '2001:db8::') === true, '/128 contains only itself');
ok(v6.prefixContains6('2001:db8::/128', '2001:db8::1') === false, '/128 excludes the next address');
ok(v6.prefixContains6(p32, '2001:db8:1::2') === true, 'a parsed prefix object can be reused');
ok(v6.prefixContains6('2001:db8::/32', 'not-an-address') === false, 'a junk address is simply not contained');
ok(v6.prefixContains6(null, '::1') === false, 'a junk prefix is simply not contained');

// ---------------------------------------------------------------------------
// 7. classification
// ---------------------------------------------------------------------------

ok(v6.isLinkLocal('fe80::1') === true, 'fe80::1 is link-local');
ok(v6.isLinkLocal('febf:ffff::1') === true, 'febf:ffff::1 is link-local (top of /10)');
ok(v6.isLinkLocal('fe80::') === true, 'fe80:: is link-local');
ok(v6.isLinkLocal('fec0::1') === false, 'fec0::1 is not link-local');
ok(v6.isLinkLocal('2001:db8::1') === false, 'a global address is not link-local');
ok(v6.isLinkLocal('garbage') === false, 'junk is not link-local');

ok(v6.isUniqueLocal('fc00::1') === true, 'fc00::1 is unique-local');
ok(v6.isUniqueLocal('fd12:3456:789a::1') === true, 'fd12:3456:789a::1 is unique-local');
ok(v6.isUniqueLocal('fe80::1') === false, 'a link-local address is not unique-local');
ok(v6.isUniqueLocal('fbff::1') === false, 'fbff::1 is just below the ULA block');

ok(v6.isMulticast('ff02::1') === true, 'ff02::1 is multicast');
ok(v6.isMulticast('ff00::') === true, 'ff00:: is multicast (bottom of /8)');
ok(v6.isMulticast('fe80::1') === false, 'a link-local address is not multicast');
ok(v6.isMulticast('') === false, 'the empty string is not multicast');

ok(v6.isLoopback6('::1') === true, '::1 is loopback');
ok(v6.isLoopback6('::') === false, 'the unspecified address is not loopback');
ok(v6.isLoopback6('::2') === false, '::2 is not loopback');
ok(v6.isLoopback6('0:0:0:0:0:0:0:1') === true, 'the full form of loopback is loopback');

// ---------------------------------------------------------------------------
// 8. solicited-node multicast
// ---------------------------------------------------------------------------

eq(v6.solicitedNodeMulticast('2001:db8::1'), 'ff02::1:ff00:1',
  'solicited-node of 2001:db8::1');
eq(v6.solicitedNodeMulticast('fe80::21a:2bff:fe3c:4d5e'), 'ff02::1:ff3c:4d5e',
  'solicited-node uses only the low 24 bits');
eq(v6.solicitedNodeMulticast('2001:db8:aaaa:bbbb:cccc:ddee:ff00:1234'),
  'ff02::1:ff00:1234', 'solicited-node of an address ending ::ff00:1234');
eq(v6.solicitedNodeMulticast('2001:db8::ff:1234'), 'ff02::1:ffff:1234',
  'solicited-node carries all three low bytes');
eq(v6.solicitedNodeMulticast('::1'), 'ff02::1:ff00:1', 'solicited-node of loopback');
eq(v6.solicitedNodeMulticast('::'), 'ff02::1:ff00:0', 'solicited-node of the unspecified address');
eq(v6.solicitedNodeMulticast('nonsense'), '', 'solicited-node of junk is empty');
eq(v6.solicitedNodeMulticast('ff02::1'), '', 'multicast addresses have no solicited-node group');
ok(v6.isMulticast(v6.solicitedNodeMulticast('2001:db8::1')) === true,
  'the solicited-node result really is multicast');

const snm = v6.solicitedNodeMulticast('2001:db8::abcd:ef01');
const snmPrefix = v6.parsePrefix6('ff02::1:ff00:0/104');
ok(v6.prefixContains6(snmPrefix, snm) === true,
  'the solicited-node address falls inside ff02::1:ff00:0/104');
ok(snm === snm.toLowerCase(), 'the solicited-node address is lowercase');

// ---------------------------------------------------------------------------
// 9. EUI-64 from MAC
// ---------------------------------------------------------------------------

eq(v6.eui64FromMac('00:1a:2b:3c:4d:5e'), '21a:2bff:fe3c:4d5e',
  'EUI-64 flips the U/L bit and inserts fffe');
eq(v6.linkLocalFromMac('00:1a:2b:3c:4d:5e'), 'fe80::21a:2bff:fe3c:4d5e',
  'link-local address from a MAC');
eq(v6.eui64FromMac('00:50:56:aa:bb:cc'), '250:56ff:feaa:bbcc',
  'EUI-64 matches the familiar VMware form');
eq(v6.linkLocalFromMac('00:50:56:aa:bb:cc'), 'fe80::250:56ff:feaa:bbcc',
  'link-local matches the familiar VMware form');
eq(v6.eui64FromMac('aa:bb:cc:dd:ee:ff'), 'a8bb:ccff:fedd:eeff',
  'a set U/L bit is cleared (aa -> a8)');
eq(v6.eui64FromMac('02:00:00:00:00:01'), '0:ff:fe00:1',
  'a set local bit is cleared (02 -> 00)');
eq(v6.linkLocalFromMac('02:00:00:00:00:01'), 'fe80::ff:fe00:1',
  'link-local for a locally administered MAC');
eq(v6.eui64FromMac('AA-BB-CC-DD-EE-FF'), 'a8bb:ccff:fedd:eeff', 'accepts dashed MACs');
eq(v6.eui64FromMac('aabb.ccdd.eeff'), 'a8bb:ccff:fedd:eeff', 'accepts Cisco dotted MACs');
eq(v6.eui64FromMac('aabbccddeeff'), 'a8bb:ccff:fedd:eeff', 'accepts bare hex MACs');
eq(v6.eui64FromMac('00:1a:2b:3c:4d:5e'), v6.eui64FromMac('00-1A-2B-3C-4D-5E'),
  'MAC notation does not change the interface identifier');
eq(v6.eui64FromMac('ff:ff:ff:ff:ff:ff'), '', 'a broadcast MAC has no EUI-64');
eq(v6.eui64FromMac('01:00:5e:00:00:01'), '', 'a multicast MAC has no EUI-64');
eq(v6.eui64FromMac('00:1a:2b:3c:4d'), '', 'a short MAC is rejected');
eq(v6.eui64FromMac('zz:bb:cc:dd:ee:ff'), '', 'a non-hex MAC is rejected');
eq(v6.linkLocalFromMac('nope'), '', 'linkLocalFromMac of junk is empty');

const ll = v6.linkLocalFromMac('00:1a:2b:3c:4d:5e');
ok(v6.isLinkLocal(ll) === true, 'the derived address classifies as link-local');
ok(v6.formatIpv6(v6.parseIpv6(ll).groups) === ll, 'the derived link-local address is canonical');
eq(v6.solicitedNodeMulticast(ll), 'ff02::1:ff3c:4d5e',
  'the derived link-local address has the expected solicited-node group');

// ---------------------------------------------------------------------------
// 10. BigInt conversions
// ---------------------------------------------------------------------------

eq(v6.ipv6ToBigInt('::'), 0n, ':: is bigint zero');
eq(v6.ipv6ToBigInt('::1'), 1n, '::1 is bigint one');
eq(v6.ipv6ToBigInt('::2'), 2n, '::2 is bigint two');
eq(v6.ipv6ToBigInt('1::'), 1n << 112n, '1:: is one in the top group');
eq(v6.ipv6ToBigInt('ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff'), (1n << 128n) - 1n,
  'all-ones maps to 2^128-1');
eq(v6.ipv6ToBigInt('ffff::'), 0xffffn << 112n, 'ffff:: is 65535 in the top group');
eq(v6.ipv6ToBigInt('bogus'), null, 'junk maps to null, not a throw');
eq(v6.ipv6ToBigInt(null), null, 'null maps to null');

eq(v6.bigIntToIpv6(0n), '::', '0n formats as ::');
eq(v6.bigIntToIpv6(1n), '::1', '1n formats as ::1');
eq(v6.bigIntToIpv6(2n), '::2', '2n formats as ::2');
eq(v6.bigIntToIpv6((1n << 128n) - 1n), 'ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
  '2^128-1 formats as all ones');
eq(v6.bigIntToIpv6(1n << 112n), '1::', '2^112 formats as 1::');
eq(v6.bigIntToIpv6(0x20010db8000000000000000000000001n), '2001:db8::1',
  'a known 128-bit value formats canonically');
eq(v6.bigIntToIpv6(-1n), null, 'a negative bigint is out of range');
eq(v6.bigIntToIpv6(1n << 128n), null, 'a bigint above 2^128-1 is out of range');
eq(v6.bigIntToIpv6('123'), null, 'a string is not a bigint');
eq(v6.bigIntToIpv6(1.5), null, 'a fractional number is rejected');
eq(v6.bigIntToIpv6(1), '::1', 'a safe integer number is accepted');

ROUND_TRIP.forEach(function (addr) {
  const n = v6.ipv6ToBigInt(addr);
  ok(typeof n === 'bigint' && v6.ipv6ToBigInt(v6.bigIntToIpv6(n)) === n,
    'bigint round-trip for ' + addr);
});

ok(v6.bigIntToIpv6(v6.ipv6ToBigInt('2001:db8::1')) ===
  v6.formatIpv6(parses('2001:db8::1').groups),
  'bigIntToIpv6 agrees with formatIpv6(parseIpv6(...).groups)');

// ---------------------------------------------------------------------------
// 11. validateAddress6
// ---------------------------------------------------------------------------

const good = v6.validateAddress6('2001:db8::1');
ok(good.ok === true && Array.isArray(good.errors) && good.errors.length === 0,
  'a global unicast address validates clean');
ok(v6.validateAddress6('fe80::1').ok === true, 'a link-local address is assignable');
ok(v6.validateAddress6('fd00::1').ok === true, 'a ULA address is assignable');

const badParse6 = v6.validateAddress6('not-an-address');
ok(badParse6.ok === false && badParse6.errors.length === 1 &&
  badParse6.errors[0].code === 'E_PARSE', 'junk reports a single E_PARSE');
ok(typeof badParse6.errors[0].message === 'string' && badParse6.errors[0].message.length > 0,
  'E_PARSE carries a human message');

const mc = v6.validateAddress6('ff02::1');
ok(mc.ok === false && mc.errors.some(function (e) { return e.code === 'E_MULTICAST'; }),
  'a multicast address is refused with E_MULTICAST');

const unspecified = v6.validateAddress6('::');
ok(unspecified.ok === false &&
  unspecified.errors.some(function (e) { return e.code === 'E_UNSPECIFIED'; }),
  'the unspecified address is refused with E_UNSPECIFIED');

ok(v6.validateAddress6(null).ok === false, 'null fails validation');
ok(Array.isArray(v6.validateAddress6(undefined).errors), 'validation always returns an errors array');

// ---------------------------------------------------------------------------
// 12. constants
// ---------------------------------------------------------------------------

eq(v6.ICMPV6_TYPES.ECHO_REQUEST, 128, 'ICMPv6 echo request is 128');
eq(v6.ICMPV6_TYPES.ECHO_REPLY, 129, 'ICMPv6 echo reply is 129');
eq(v6.ICMPV6_TYPES.ROUTER_SOLICIT, 133, 'ICMPv6 router solicit is 133');
eq(v6.ICMPV6_TYPES.ROUTER_ADVERT, 134, 'ICMPv6 router advert is 134');
eq(v6.ICMPV6_TYPES.NEIGHBOUR_SOLICIT, 135, 'ICMPv6 neighbour solicit is 135');
eq(v6.ICMPV6_TYPES.NEIGHBOUR_ADVERT, 136, 'ICMPv6 neighbour advert is 136');
eq(v6.ND_DEFAULTS.hopLimit, 255, 'ND hop limit default is 255');
eq(v6.ND_DEFAULTS.reachableMs, 30000, 'ND reachable time default is 30s');
eq(v6.ND_DEFAULTS.retransTimerMs, 1000, 'ND retransmit timer default is 1s');

// ---------------------------------------------------------------------------
// 13. totality: no entry point may throw
// ---------------------------------------------------------------------------

const JUNK = [
  null, undefined, 0, 42, -1, 1.5, NaN, true, false, '', '   ', ':', '::', ':::',
  '::::', 'g::1', '1:2:3:4:5:6:7:8:9', '..', '1.2.3.4', '::%', 'fe80::1%eth0',
  'fe80::1 zone', {}, [], [1, 2, 3], function () {}, Symbol('x'), '\u0000', 'ff:ff:ff:ff:ff:ff'
];

function noThrow(fn, args) {
  try {
    return { threw: false, value: fn.apply(null, args) };
  } catch (e) {
    return { threw: true, value: null };
  }
}

let threw = 0;
JUNK.forEach(function (junk) {
  const calls = [
    v6.parseIpv6, v6.formatIpv6, v6.parsePrefix6, v6.networkAddress6,
    v6.isLinkLocal, v6.isUniqueLocal, v6.isMulticast, v6.isLoopback6,
    v6.solicitedNodeMulticast, v6.eui64FromMac, v6.linkLocalFromMac,
    v6.ipv6ToBigInt, v6.bigIntToIpv6, v6.validateAddress6
  ];
  calls.forEach(function (fn) {
    if (noThrow(fn, [junk]).threw) threw++;
  });
  if (noThrow(v6.prefixContains6, [junk, junk]).threw) threw++;
  if (noThrow(v6.prefixContains6, [junk, '::1']).threw) threw++;
  if (noThrow(v6.prefixContains6, ['::/0', junk]).threw) threw++;
});
ok(threw === 0, 'no helper throws on malformed input (' + threw + ' throws seen)');

// Every helper still returns its documented "empty" shape for junk.
ok(typeof v6.formatIpv6('nope') === 'string', 'formatIpv6 returns a string for junk');
ok(typeof v6.parsePrefix6('nope').valid === 'boolean', 'parsePrefix6 returns a verdict for junk');
ok(typeof v6.solicitedNodeMulticast(99) === 'string', 'solicitedNodeMulticast returns a string');
ok(typeof v6.eui64FromMac([]) === 'string', 'eui64FromMac returns a string');
ok(v6.ipv6ToBigInt(Symbol('x')) === null, 'ipv6ToBigInt returns null for a symbol');
ok(v6.prefixContains6('::/0', {}) === false, 'prefixContains6 returns false for an object address');
ok(v6.validateAddress6({}).ok === false, 'validateAddress6 returns a verdict for an object');

// Sanity: a valid address never trips the no-throw guard either.
ok(v6.validateAddress6('2001:db8::1').ok === true, 'the module is still healthy at the end');

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
