'use strict';
// dhcp.test.js -- unit tests for the DHCPv4 pool / lease model.
// Plain asserts, no framework. Every fixture is a hand-built pool object so the
// tests exercise engine/dhcp.js in isolation (no simulator, no devices, no
// server). Leases are driven purely by the `step` numbers the tests pass in.

const dhcp = require('../engine/dhcp');

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

function codes(list) {
  return (list || []).map(function (e) { return e.code; });
}

function hasCode(list, code) {
  return codes(list).indexOf(code) !== -1;
}

function messages(list) {
  return (list || []).map(function (e) { return e.message; }).join(' | ');
}

function section(title) {
  console.log('\n' + title);
}

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

function mkPool(overrides) {
  return Object.assign({
    name: 'lan1',
    network: '192.168.10.0',
    mask: '255.255.255.0',
    rangeStart: '192.168.10.100',
    rangeEnd: '192.168.10.110',
    gateway: '192.168.10.1',
    dns: ['192.168.10.1', '1.1.1.1'],
    reservations: { 'aa:bb:cc:00:00:05': '192.168.10.105' },
    excluded: [],
    leaseSec: 600
  }, overrides || {});
}

const MAC_A = '02:00:00:00:00:0a';
const MAC_B = '02:00:00:00:00:0b';
const MAC_C = '02:00:00:00:00:0c';
const MAC_RESERVED = 'aa:bb:cc:00:00:05';

// DISCOVER then REQUEST, returning both replies.
function allocate(pool, state, mac, step, requestedIp) {
  const offer = dhcp.handleDiscover(pool, state, { mac: mac, requestedIp: requestedIp, step: step });
  const ack = dhcp.handleRequest(pool, state, {
    mac: mac, requestedIp: (offer && offer.ip) || requestedIp, step: step
  });
  return { offer: offer, ack: ack };
}

// ---------------------------------------------------------------------------
// 1. message types
// ---------------------------------------------------------------------------

section('1. message types');
eq(dhcp.DHCP_MESSAGE_TYPES.DISCOVER, 1, 'DISCOVER is 1');
eq(dhcp.DHCP_MESSAGE_TYPES.OFFER, 2, 'OFFER is 2');
eq(dhcp.DHCP_MESSAGE_TYPES.REQUEST, 3, 'REQUEST is 3');
eq(dhcp.DHCP_MESSAGE_TYPES.ACK, 5, 'ACK is 5');
eq(dhcp.DHCP_MESSAGE_TYPES.NAK, 6, 'NAK is 6');

// ---------------------------------------------------------------------------
// 2. normalisation
// ---------------------------------------------------------------------------

section('2. pool normalisation');

const bare = dhcp.normalizePool({ network: '10.0.0.99' });
eq(bare.mask, '255.255.255.0', 'omitted mask defaults to /24');
eq(bare.network, '10.0.0.0', 'a host address normalises to its network address');
eq(bare.name, 'lan', 'omitted name defaults to lan');
eq(bare.leaseSec, 86400, 'omitted leaseSec defaults to one day');
ok(Array.isArray(bare.dns) && bare.dns.length === 0, 'omitted dns becomes an empty array');
ok(Array.isArray(bare.excluded) && bare.excluded.length === 0, 'omitted excluded becomes an empty array');

const prefixed = dhcp.normalizePool(mkPool({ mask: 25, network: '192.168.10.200' }));
eq(prefixed.mask, '255.255.255.128', 'a prefix length normalises to a dotted mask');
eq(prefixed.network, '192.168.10.128', 'the network follows the supplied prefix');

const shaped = dhcp.normalizePool({
  network: '192.168.10.0',
  mask: '24',
  rangeStart: '192.168.10.100',
  rangeEnd: '192.168.10.110',
  gateway: '192.168.10.1',
  dns: '192.168.10.1 8.8.8.8',
  reservations: { 'AABB.CC00.0005': '192.168.10.105' },
  excluded: ['192.168.10.102', '192.168.10.108-192.168.10.109'],
  leaseSec: '900'
});
eq(shaped.mask, '255.255.255.0', '/24 normalises to 255.255.255.0');
eq(shaped.leaseSec, 900, 'a numeric string leaseSec becomes a number');
eq(shaped.dns.length, 2, 'a whitespace-separated dns string splits into entries');
eq(shaped.reservations['aa:bb:cc:00:00:05'], '192.168.10.105', 'reservation MACs canonicalise');
eq(shaped.excluded.length, 2, 'single addresses and ranges both normalise');
eq(shaped.excluded[1].start, '192.168.10.108', 'an excluded range keeps its start');
eq(shaped.excluded[1].end, '192.168.10.109', 'an excluded range keeps its end');
eq(dhcp.normalizePool(shaped).excluded.length, 2, 'normalisation is idempotent');

// ---------------------------------------------------------------------------
// 3. validation: the happy path
// ---------------------------------------------------------------------------

section('3. pool validation -- accepts');

const goodPool = mkPool();
const good = dhcp.validatePool(goodPool);
eq(good.ok, true, 'a well-formed pool validates: ' + messages(good.errors));
eq(good.errors.length, 0, 'no errors for a well-formed pool');
ok(Array.isArray(good.errors), 'errors is always an array');
eq(dhcp.validatePool(dhcp.normalizePool(goodPool)).ok, true, 'a normalised pool still validates');

// ---------------------------------------------------------------------------
// 4. validation: rejections
// ---------------------------------------------------------------------------

section('4. pool validation -- rejects');

const badOrder = dhcp.validatePool(mkPool({
  rangeStart: '192.168.10.110', rangeEnd: '192.168.10.100'
}));
eq(badOrder.ok, false, 'a reversed range is rejected');
ok(hasCode(badOrder.errors, 'E_DHCP_RANGE_ORDER'), 'reversed range reports E_DHCP_RANGE_ORDER: ' + messages(badOrder.errors));

const badOutside = dhcp.validatePool(mkPool({ rangeEnd: '192.168.11.20' }));
ok(hasCode(badOutside.errors, 'E_DHCP_RANGE_OUTSIDE'), 'a range off the subnet reports E_DHCP_RANGE_OUTSIDE');

const badMask = dhcp.validatePool(mkPool({ mask: '255.0.255.0' }));
eq(badMask.ok, false, 'a non-contiguous mask is rejected');
ok(hasCode(badMask.errors, 'E_DHCP_BAD_MASK'), 'non-contiguous mask reports E_DHCP_BAD_MASK');

const junkMask = dhcp.validatePool(mkPool({ mask: '24 bits' }));
ok(hasCode(junkMask.errors, 'E_DHCP_BAD_MASK'), 'unparseable mask reports E_DHCP_BAD_MASK');

const junkRange = dhcp.validatePool(mkPool({ rangeStart: '192.168.10.999' }));
ok(hasCode(junkRange.errors, 'E_DHCP_BAD_RANGE'), 'an invalid address in the range reports E_DHCP_BAD_RANGE');

const endpoint = dhcp.validatePool(mkPool({
  rangeStart: '192.168.10.0', rangeEnd: '192.168.10.255'
}));
ok(hasCode(endpoint.errors, 'E_DHCP_RANGE_ENDPOINT'), 'a range covering network/broadcast reports E_DHCP_RANGE_ENDPOINT');

const badGw = dhcp.validatePool(mkPool({ gateway: 'not-an-ip' }));
ok(hasCode(badGw.errors, 'E_DHCP_BAD_GATEWAY'), 'a junk gateway reports E_DHCP_BAD_GATEWAY');

const offSubnetGw = dhcp.validatePool(mkPool({ gateway: '10.9.9.9' }));
ok(hasCode(offSubnetGw.errors, 'E_DHCP_GATEWAY_OUTSIDE'), 'an off-subnet gateway reports E_DHCP_GATEWAY_OUTSIDE');

const badDns = dhcp.validatePool(mkPool({ dns: ['192.168.10.1', 'dns.example'] }));
ok(hasCode(badDns.errors, 'E_DHCP_BAD_DNS'), 'a non-IP DNS server reports E_DHCP_BAD_DNS');

const resOutside = dhcp.validatePool(mkPool({
  reservations: { [MAC_RESERVED]: '192.168.10.200' }
}));
ok(hasCode(resOutside.errors, 'E_DHCP_RESERVATION_OUT_OF_RANGE'),
  'a reservation outside the range reports E_DHCP_RESERVATION_OUT_OF_RANGE');

const resOffNet = dhcp.validatePool(mkPool({
  reservations: { [MAC_RESERVED]: '10.1.1.5' }
}));
ok(hasCode(resOffNet.errors, 'E_DHCP_RESERVATION_OUTSIDE'),
  'a reservation off the subnet reports E_DHCP_RESERVATION_OUTSIDE');

const resClash = dhcp.validatePool(mkPool({
  reservations: { 'aa:bb:cc:00:00:05': '192.168.10.105', 'aa:bb:cc:00:00:06': '192.168.10.105' }
}));
ok(hasCode(resClash.errors, 'E_DHCP_RESERVATION_CONFLICT'),
  'two MACs on one address report E_DHCP_RESERVATION_CONFLICT');

const badMacKey = dhcp.validatePool(mkPool({ reservations: { 'not-a-mac': '192.168.10.105' } }));
ok(hasCode(badMacKey.errors, 'E_DHCP_BAD_MAC'), 'an unreadable reservation MAC reports E_DHCP_BAD_MAC');

const badLease = dhcp.validatePool(mkPool({ leaseSec: 0 }));
ok(hasCode(badLease.errors, 'E_DHCP_BAD_LEASE'), 'a non-positive leaseSec reports E_DHCP_BAD_LEASE');

const badExcluded = dhcp.validatePool(mkPool({ excluded: ['192.168.10.500'] }));
ok(hasCode(badExcluded.errors, 'E_DHCP_BAD_EXCLUDED'), 'a junk excluded entry reports E_DHCP_BAD_EXCLUDED');

const allExcluded = dhcp.validatePool(mkPool({
  reservations: {},
  rangeStart: '192.168.10.100',
  rangeEnd: '192.168.10.101',
  excluded: ['192.168.10.100', '192.168.10.101']
}));
ok(hasCode(allExcluded.errors, 'E_DHCP_NO_HOSTS'),
  'a fully excluded range reports E_DHCP_NO_HOSTS');

const allReserved = dhcp.validatePool(mkPool({
  rangeStart: '192.168.10.100',
  rangeEnd: '192.168.10.100',
  reservations: { [MAC_RESERVED]: '192.168.10.100' }
}));
ok(hasCode(allReserved.errors, 'E_DHCP_NO_HOSTS'),
  'a range that is entirely reserved reports E_DHCP_NO_HOSTS');

const empty = dhcp.validatePool({});
eq(empty.ok, false, 'an empty spec is rejected');
ok(empty.errors.length >= 2, 'an empty spec reports every missing field (' + empty.errors.length + ')');
ok(hasCode(empty.errors, 'E_DHCP_BAD_NETWORK'), 'an empty spec reports E_DHCP_BAD_NETWORK');
ok(hasCode(empty.errors, 'E_DHCP_BAD_RANGE'), 'an empty spec reports E_DHCP_BAD_RANGE');

// ---------------------------------------------------------------------------
// 5. ipInPool
// ---------------------------------------------------------------------------

section('5. ipInPool');

ok(dhcp.ipInPool(goodPool, '192.168.10.100') === true, 'the first address of the range is in the pool');
ok(dhcp.ipInPool(goodPool, '192.168.10.110') === true, 'the last address of the range is in the pool');
ok(dhcp.ipInPool(goodPool, '192.168.10.105') === true, 'a reserved address is still in the pool');
ok(dhcp.ipInPool(goodPool, '192.168.10.99') === false, 'an address below the range is out');
ok(dhcp.ipInPool(goodPool, '192.168.10.111') === false, 'an address above the range is out');
ok(dhcp.ipInPool(goodPool, '192.168.10.1') === false, 'an in-subnet address outside the range is out');
ok(dhcp.ipInPool(goodPool, '10.0.0.100') === false, 'a foreign address is out');
ok(dhcp.ipInPool(goodPool, 'garbage') === false, 'a non-address is out');
ok(dhcp.ipInPool(mkPool({ excluded: ['192.168.10.100'] }), '192.168.10.100') === false,
  'an excluded address is out');

// ---------------------------------------------------------------------------
// 6. allocation order and exhaustion
// ---------------------------------------------------------------------------

section('6. allocation');

const pool = mkPool();
const state = dhcp.createLeaseState();
ok(state.leases instanceof Map, 'createLeaseState().leases is a Map');
ok(state.byIp instanceof Map, 'createLeaseState().byIp is a Map');

const a1 = allocate(pool, state, MAC_A, 0);
eq(a1.offer.type, dhcp.DHCP_MESSAGE_TYPES.OFFER, 'DISCOVER is answered with an OFFER');
eq(a1.offer.ip, '192.168.10.100', 'the first client gets the lowest free address');
eq(a1.offer.mask, '255.255.255.0', 'the OFFER carries the mask');
eq(a1.offer.gateway, '192.168.10.1', 'the OFFER carries the gateway');
eq(a1.offer.dns.length, 2, 'the OFFER carries the DNS list');
eq(a1.offer.leaseSec, 600, 'the OFFER carries the lease time');
eq(a1.offer.server, '192.168.10.1', 'the OFFER carries a server identifier');
eq(a1.ack.type, dhcp.DHCP_MESSAGE_TYPES.ACK, 'REQUEST is answered with an ACK');
eq(a1.ack.ip, '192.168.10.100', 'the ACK confirms the offered address');
eq(a1.ack.expiresStep, 600, 'the lease expires at step + leaseSec');

const a2 = allocate(pool, state, MAC_B, 1);
eq(a2.offer.ip, '192.168.10.101', 'allocation walks the range upwards (second client)');
eq((allocate(pool, state, MAC_C, 2)).offer.ip, '192.168.10.102',
  'allocation walks the range upwards (third client)');
eq(dhcp.nextFreeIp(pool, state), '192.168.10.103', 'nextFreeIp reports the next unclaimed address');

// OFFER alone must not consume the address.
const quiet = dhcp.createLeaseState();
dhcp.handleDiscover(pool, quiet, { mac: MAC_A, step: 0 });
eq(dhcp.leaseTable(quiet).length, 0, 'a DISCOVER/OFFER does not create a lease');
eq(dhcp.nextFreeIp(pool, quiet), '192.168.10.100', 'an offered address stays free until the ACK');
ok(dhcp.handleDiscover(pool, quiet, { mac: 'nonsense', step: 0 }) === null,
  'a DISCOVER with an unreadable MAC gets no answer');

// A client asking for a specific free address gets it.
const picked = dhcp.handleDiscover(pool, state, { mac: '02:00:00:00:00:aa', requestedIp: '192.168.10.108', step: 3 });
eq(picked.ip, '192.168.10.108', 'a free requested address is honoured in the OFFER');

// Exhaustion.
const tiny = mkPool({ rangeStart: '192.168.10.100', rangeEnd: '192.168.10.101', reservations: {} });
const tinyState = dhcp.createLeaseState();
allocate(tiny, tinyState, MAC_A, 0);
allocate(tiny, tinyState, MAC_B, 0);
ok(dhcp.nextFreeIp(tiny, tinyState) === null, 'an exhausted pool reports no free address');
ok(dhcp.handleDiscover(tiny, tinyState, { mac: MAC_C, step: 0 }) === null,
  'an exhausted pool answers a DISCOVER with null');
eq(dhcp.handleRequest(tiny, tinyState, { mac: MAC_C, requestedIp: '192.168.10.101', step: 0 }).type,
  dhcp.DHCP_MESSAGE_TYPES.NAK, 'a REQUEST for a taken address is NAKed even when the pool is full');

// ---------------------------------------------------------------------------
// 7. reservations
// ---------------------------------------------------------------------------

section('7. reservations');

const resState = dhcp.createLeaseState();
eq(dhcp.nextFreeIp(pool, resState), '192.168.10.100', 'if it is free, the lowest address is not reserved here');

const reservedOffer = dhcp.handleDiscover(pool, resState, { mac: MAC_RESERVED, step: 0 });
eq(reservedOffer.ip, '192.168.10.105', 'a reserved MAC is offered its reservation, not the lowest address');
const reservedAck = dhcp.handleRequest(pool, resState, {
  mac: MAC_RESERVED, requestedIp: '192.168.10.105', step: 0
});
eq(reservedAck.type, dhcp.DHCP_MESSAGE_TYPES.ACK, 'the reservation is ACKed');

// Fill up to the reservation: .100 .. .104 must never include .105.
const fillState = dhcp.createLeaseState();
const filled = [];
for (let i = 0; i < 6; i++) {
  filled.push(dhcp.handleDiscover(pool, fillState, { mac: '02:00:00:00:00:f' + i, step: 0 }).ip);
  dhcp.handleRequest(pool, fillState, { mac: '02:00:00:00:00:f' + i, requestedIp: filled[i], step: 0 });
}
eq(filled.indexOf('192.168.10.105'), -1, 'nextFreeIp never hands out a reserved address');
eq(filled[4], '192.168.10.104', 'allocation reaches the address just below the reservation');
eq(filled[5], '192.168.10.106', 'allocation skips over the reserved address');

const otherWantsReserved = dhcp.handleRequest(pool, dhcp.createLeaseState(), {
  mac: MAC_A, requestedIp: '192.168.10.105', step: 0
});
eq(otherWantsReserved.type, dhcp.DHCP_MESSAGE_TYPES.NAK, 'another MAC cannot take a reserved address');
eq(otherWantsReserved.reason, 'RESERVED', 'the NAK names the reservation as the reason');

const reservedElsewhere = dhcp.handleRequest(pool, dhcp.createLeaseState(), {
  mac: MAC_RESERVED, requestedIp: '192.168.10.100', step: 0
});
eq(reservedElsewhere.type, dhcp.DHCP_MESSAGE_TYPES.NAK, 'a reserved MAC may not take a different address');

// ---------------------------------------------------------------------------
// 8. exclusions
// ---------------------------------------------------------------------------

section('8. exclusions');

const exclPool = mkPool({
  reservations: {},
  excluded: ['192.168.10.100', { start: '192.168.10.103', end: '192.168.10.104' }]
});
const exclState = dhcp.createLeaseState();
eq(dhcp.nextFreeIp(exclPool, exclState), '192.168.10.101', 'a single excluded address is skipped');

const exclAcks = [];
for (let i = 0; i < 4; i++) {
  const mac = '02:00:00:00:00:e' + i;
  const ip = dhcp.handleDiscover(exclPool, exclState, { mac: mac, step: 0 }).ip;
  exclAcks.push(ip);
  dhcp.handleRequest(exclPool, exclState, { mac: mac, requestedIp: ip, step: 0 });
}
eq(exclAcks.join(','), '192.168.10.101,192.168.10.102,192.168.10.105,192.168.10.106',
  'excluded addresses and ranges are skipped in order');

const excludedNak = dhcp.handleRequest(exclPool, dhcp.createLeaseState(), {
  mac: MAC_A, requestedIp: '192.168.10.103', step: 0
});
eq(excludedNak.type, dhcp.DHCP_MESSAGE_TYPES.NAK, 'a REQUEST for an excluded address is NAKed');
eq(excludedNak.reason, 'EXCLUDED', 'the NAK names the exclusion as the reason');

// ---------------------------------------------------------------------------
// 9. renewal and conflicts
// ---------------------------------------------------------------------------

section('9. renewal and conflicts');

const renewPool = mkPool();
const renewState = dhcp.createLeaseState();
const first = dhcp.handleRequest(renewPool, renewState, { mac: MAC_A, requestedIp: '192.168.10.100', step: 0 });
eq(first.expiresStep, 600, 'the first binding expires at step 600');

const renew = dhcp.handleRequest(renewPool, renewState, { mac: MAC_A, requestedIp: '192.168.10.100', step: 400 });
eq(renew.type, dhcp.DHCP_MESSAGE_TYPES.ACK, 'a client re-requesting its own address is ACKed (renewal)');
eq(renew.ip, '192.168.10.100', 'the renewal keeps the same address');
eq(renew.expiresStep, 1000, 'the renewal pushes the expiry out');
eq(dhcp.leaseTable(renewState).length, 1, 'a renewal does not duplicate the binding');

const conflict = dhcp.handleRequest(renewPool, renewState, { mac: MAC_B, requestedIp: '192.168.10.100', step: 401 });
eq(conflict.type, dhcp.DHCP_MESSAGE_TYPES.NAK, 'a second MAC requesting a live lease is NAKed');
eq(conflict.reason, 'CONFLICT', 'the conflict NAK names the conflict');
ok(conflict.ip === null, 'a NAK carries no address');

const outside = dhcp.handleRequest(renewPool, renewState, { mac: MAC_B, requestedIp: '192.168.10.200', step: 0 });
eq(outside.type, dhcp.DHCP_MESSAGE_TYPES.NAK, 'a REQUEST outside the pool is NAKed');
eq(outside.reason, 'OUTSIDE_POOL', 'the NAK names the pool as the reason');

const offSubnet = dhcp.handleRequest(renewPool, renewState, { mac: MAC_B, requestedIp: '10.0.0.7', step: 0 });
eq(offSubnet.type, dhcp.DHCP_MESSAGE_TYPES.NAK, 'a REQUEST off the subnet is NAKed');
eq(offSubnet.reason, 'OUTSIDE_SUBNET', 'the off-subnet NAK names the subnet');

const noIp = dhcp.handleRequest(renewPool, renewState, { mac: MAC_B, requestedIp: 'nope', step: 0 });
eq(noIp.reason, 'BAD_IP', 'a REQUEST without a usable address is NAKed');

const badPoolRequest = dhcp.handleRequest(mkPool({ mask: '255.0.255.0' }), renewState, {
  mac: MAC_B, requestedIp: '192.168.10.100', step: 0
});
eq(badPoolRequest.type, dhcp.DHCP_MESSAGE_TYPES.NAK, 'a broken pool NAKs every REQUEST');
eq(badPoolRequest.reason, 'BAD_POOL', 'the NAK names the pool as the reason');
ok(dhcp.handleDiscover(mkPool({ mask: '255.0.255.0' }), renewState, { mac: MAC_B, step: 0 }) === null,
  'a broken pool answers no DISCOVER');

// ---------------------------------------------------------------------------
// 10. release
// ---------------------------------------------------------------------------

section('10. release');

const relPool = mkPool();
const relState = dhcp.createLeaseState();
allocate(relPool, relState, MAC_A, 0);
eq(dhcp.nextFreeIp(relPool, relState), '192.168.10.101', 'the leased address is not free');
ok(dhcp.releaseLease(relPool, relState, MAC_A) === true, 'releaseLease reports a released binding');
eq(dhcp.nextFreeIp(relPool, relState), '192.168.10.100', 'the released address is free again');
ok(relState.byIp.get('192.168.10.100') === undefined, 'release clears the reverse index');
ok(dhcp.releaseLease(relPool, relState, MAC_A) === false, 'releasing an unknown MAC reports false');
ok(dhcp.releaseLease(relPool, relState, 'not-a-mac') === false, 'releasing an unreadable MAC reports false');

const reAcquire = dhcp.handleRequest(relPool, relState, { mac: MAC_B, requestedIp: '192.168.10.100', step: 5 });
eq(reAcquire.type, dhcp.DHCP_MESSAGE_TYPES.ACK, 'a released address can be handed to another MAC');

// ---------------------------------------------------------------------------
// 11. expiry
// ---------------------------------------------------------------------------

section('11. expiry');

const expPool = mkPool();
const expState = dhcp.createLeaseState();
allocate(expPool, expState, MAC_A, 100);
eq(dhcp.leaseTable(expState)[0].expiresStep, 700, 'the lease expires at step + leaseSec');
eq(dhcp.expireLeases(expState, 699), 0, 'nothing expires before the deadline');
eq(dhcp.leaseTable(expState).length, 1, 'the binding is still there before the deadline');
eq(dhcp.expireLeases(expState, 700), 1, 'the lease is released exactly at the deadline');
eq(dhcp.leaseTable(expState).length, 0, 'the expired binding is gone from the table');
eq(dhcp.nextFreeIp(expPool, expState), '192.168.10.100', 'the expired address is allocatable again');
eq(dhcp.expireLeases(expState, 5000), 0, 'expiring an empty table releases nothing');

const mixedState = dhcp.createLeaseState();
dhcp.handleRequest(expPool, mixedState, { mac: MAC_A, requestedIp: '192.168.10.100', step: 0 });
dhcp.handleRequest(expPool, mixedState, { mac: MAC_B, requestedIp: '192.168.10.101', step: 500 });
eq(dhcp.expireLeases(mixedState, 700), 1, 'only the reached lease is released');
eq(dhcp.leaseTable(mixedState).length, 1, 'the later lease survives');
eq(dhcp.leaseTable(mixedState)[0].mac, MAC_B, 'the surviving lease is the right one');
eq(dhcp.leaseTable(mixedState)[0].ip, '192.168.10.101', 'the survivor keeps its address');

// ---------------------------------------------------------------------------
// 12. lease table
// ---------------------------------------------------------------------------

section('12. lease table');

const tblPool = mkPool();
const tblState = dhcp.createLeaseState();
dhcp.handleRequest(tblPool, tblState, { mac: MAC_B, requestedIp: '192.168.10.102', step: 1 });
dhcp.handleRequest(tblPool, tblState, { mac: MAC_A, requestedIp: '192.168.10.100', step: 2 });
const table = dhcp.leaseTable(tblState);
eq(table.length, 2, 'the table lists every binding');
eq(table[0].ip, '192.168.10.100', 'the table is ordered by address');
eq(table[1].ip, '192.168.10.102', 'the second row is the higher address');
eq(table[0].mac, MAC_A, 'rows carry the MAC');
eq(table[0].expiresStep, 602, 'rows carry the expiry');
ok(typeof table[0].expiresStep === 'number' && table[0].expiresStep > 0, 'expiresStep is a number');

// A state object that is not a real lease state is tolerated.
const rebuilt = dhcp.handleRequest(tblPool, {}, { mac: MAC_C, requestedIp: '192.168.10.107', step: 0 });
eq(rebuilt.type, dhcp.DHCP_MESSAGE_TYPES.ACK, 'a missing lease state is rebuilt instead of throwing');
eq(dhcp.leaseTable(null).length, 0, 'leaseTable tolerates a null state');

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
