'use strict';
// bgp.test.js -- unit tests for the BGP-4 model.
// Plain assert, no framework. Every case builds paths and peer configs as hand
// written plain objects so engine/bgp.js is exercised in isolation (no device
// registry, no simulator, no session state).

const assert = require('assert');
const bgp = require('../engine/bgp');

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

function deq(a, b) {
  try {
    assert.deepStrictEqual(a, b);
    return true;
  } catch (err) {
    return false;
  }
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

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

// A neutral path: nothing about it wins or loses by accident.
function mkPath(over) {
  return Object.assign({
    prefix: '10.0.0.0/24',
    nextHop: '192.0.2.1',
    asPath: [65001],
    origin: bgp.BGP_ORIGIN.IGP,
    localPreference: 100,
    med: 0,
    routerId: '1.1.1.1',
    type: 'ibgp',
    from: 'peerA'
  }, over || {});
}

function mkPeer(over) {
  return Object.assign({
    localAs: 65001,
    peerAs: 65002,
    localIp: '10.0.0.1',
    peerIp: '10.0.0.2',
    holdTime: 180
  }, over || {});
}

function before(v) { return JSON.stringify(v); }

// ---------------------------------------------------------------------------
// 1. constants
// ---------------------------------------------------------------------------

console.log('\nconstants');

ok(bgp.BGP_PORT === 179, 'BGP_PORT is 179');

ok(deq(bgp.BGP_STATES, ['idle', 'connect', 'active', 'opensent', 'openconfirm', 'established']),
  'BGP_STATES lists the six RFC 4271 states in order');

ok(deq(bgp.BGP_EVENTS, ['manual-start', 'tcp-connected', 'open-received',
  'keepalive-received', 'error', 'manual-stop']), 'BGP_EVENTS lists the six injectable events');

ok(bgp.BGP_ORIGIN.IGP === 0 && bgp.BGP_ORIGIN.EGP === 1 && bgp.BGP_ORIGIN.INCOMPLETE === 2,
  'BGP_ORIGIN encodes IGP=0, EGP=1, INCOMPLETE=2');

// ---------------------------------------------------------------------------
// 2. validatePeer
// ---------------------------------------------------------------------------

console.log('\nvalidatePeer');

var v = bgp.validatePeer(mkPeer());
ok(v.ok === true && deq(v.errors, []), 'accepts a well formed eBGP peer with no errors');

ok(bgp.validatePeer({ localAs: 65001, peerAs: 65002, localIp: '10.0.0.1', peerIp: '10.0.0.2' }).ok === true,
  'holdTime is optional');

ok(bgp.validatePeer(mkPeer({ localAs: 4200000000, peerAs: 4294967295 })).ok === true,
  'accepts 4-byte AS numbers up to 4294967295');

ok(bgp.validatePeer(mkPeer({ localAs: '65001', peerAs: '65002' })).ok === true,
  'accepts digit-string AS numbers');

v = bgp.validatePeer(mkPeer({ localAs: 0 }));
ok(v.ok === false && hasCode(v.errors, 'BAD_LOCAL_AS'), 'rejects localAs 0 with BAD_LOCAL_AS');

v = bgp.validatePeer(mkPeer({ peerAs: 0 }));
ok(v.ok === false && hasCode(v.errors, 'BAD_PEER_AS'), 'rejects peerAs 0 with BAD_PEER_AS');

v = bgp.validatePeer(mkPeer({ peerAs: 4294967296 }));
ok(v.ok === false && hasCode(v.errors, 'BAD_PEER_AS'), 'rejects peerAs 4294967296 (above 4-byte range)');

v = bgp.validatePeer(mkPeer({ localAs: -1 }));
ok(v.ok === false && hasCode(v.errors, 'BAD_LOCAL_AS'), 'rejects a negative localAs');

v = bgp.validatePeer(mkPeer({ localAs: 'AS65001' }));
ok(v.ok === false && hasCode(v.errors, 'BAD_LOCAL_AS'), 'rejects a non-numeric AS string');

v = bgp.validatePeer(mkPeer({ localIp: '10.0.0.256' }));
ok(v.ok === false && hasCode(v.errors, 'BAD_LOCAL_IP'), 'rejects an out-of-range octet with BAD_LOCAL_IP');

v = bgp.validatePeer(mkPeer({ peerIp: '10.0.0' }));
ok(v.ok === false && hasCode(v.errors, 'BAD_PEER_IP'), 'rejects a three-part address with BAD_PEER_IP');

v = bgp.validatePeer(mkPeer({ peerIp: '10.0.0.1' }));
ok(v.ok === false && hasCode(v.errors, 'PEER_SELF'), 'rejects peering with your own localIp');

v = bgp.validatePeer(mkPeer({ holdTime: 1 }));
ok(v.ok === false && hasCode(v.errors, 'BAD_HOLD_TIME'), 'rejects holdTime 1 (below the 3s floor)');

v = bgp.validatePeer(mkPeer({ holdTime: 2 }));
ok(v.ok === false && hasCode(v.errors, 'BAD_HOLD_TIME'), 'rejects holdTime 2');

v = bgp.validatePeer(mkPeer({ holdTime: 65536 }));
ok(v.ok === false && hasCode(v.errors, 'BAD_HOLD_TIME'), 'rejects holdTime 65536 (above 16-bit range)');

v = bgp.validatePeer(mkPeer({ holdTime: 'soon' }));
ok(v.ok === false && hasCode(v.errors, 'BAD_HOLD_TIME'), 'rejects a non-numeric holdTime');

v = bgp.validatePeer(mkPeer({ holdTime: 1.5 }));
ok(v.ok === false && hasCode(v.errors, 'BAD_HOLD_TIME'), 'rejects a fractional holdTime');

ok(bgp.validatePeer(mkPeer({ holdTime: 0 })).ok === true, 'holdTime 0 (keepalives disabled) is legal');
ok(bgp.validatePeer(mkPeer({ holdTime: 3 })).ok === true, 'holdTime 3 is legal');
ok(bgp.validatePeer(mkPeer({ holdTime: 65535 })).ok === true, 'holdTime 65535 is legal');
ok(bgp.validatePeer(mkPeer({ holdTime: '180' })).ok === true, 'a digit-string holdTime is legal');

v = bgp.validatePeer({});
ok(v.ok === false && v.errors.length >= 4, 'an empty config reports every missing field at once');

v = bgp.validatePeer(null);
ok(v.ok === false && v.errors.length >= 4, 'a null config is reported, not thrown on');

var shaped = bgp.validatePeer({ localAs: 0, peerAs: 'x', localIp: 'nope', peerIp: '', holdTime: 1 });
var wellFormed = shaped.errors.every(function (e) {
  return typeof e.code === 'string' && e.code.length > 0 &&
    typeof e.message === 'string' && e.message.length > 0;
});
ok(shaped.ok === false && shaped.errors.length === 5 && wellFormed,
  'every error carries a non-empty code and message');
ok(/4294967295/.test(messages(shaped.errors)),
  'the AS range message names the 4-byte ceiling');

// ---------------------------------------------------------------------------
// 3. normalizePeer
// ---------------------------------------------------------------------------

console.log('\nnormalizePeer');

var spec = { localAs: '65001', peerAs: 65002, localIp: ' 10.0.0.1 ', peerIp: '10.0.0.2', holdTime: '180' };
var snapshot = before(spec);
var norm = bgp.normalizePeer(spec);

ok(deq(norm, {
  localAs: 65001, peerAs: 65002, localIp: '10.0.0.1', peerIp: '10.0.0.2',
  holdTime: 180, routeReflectorClient: false
}), 'coerces AS strings to numbers and trims the IPs');

ok(before(spec) === snapshot, 'normalizePeer does not mutate the spec it was given');

var blank = bgp.normalizePeer({});
ok(blank.localAs === 0 && blank.peerAs === 0 && blank.localIp === '' &&
  blank.peerIp === '' && blank.holdTime === bgp.DEFAULT_HOLD_TIME &&
  blank.routeReflectorClient === false, 'fills every field with a stable default');

ok(bgp.normalizePeer({ holdTime: 0 }).holdTime === 0, 'keeps an explicit holdTime of 0');

ok(bgp.normalizePeer({ routeReflectorClient: true }).routeReflectorClient === true,
  'carries routeReflectorClient through');

ok(bgp.normalizePeer({ rrClient: true }).routeReflectorClient === true,
  'accepts rrClient as an alias for routeReflectorClient');

ok(bgp.normalizePeer({ peerAs: 'not-an-as' }).peerAs === 0,
  'an unparseable peerAs falls back to 0 (validatePeer is the gate)');

// ---------------------------------------------------------------------------
// 4. sessionType
// ---------------------------------------------------------------------------

console.log('\nsessionType');

ok(bgp.sessionType(65001, 65002) === 'ebgp', 'different AS numbers form an eBGP session');
ok(bgp.sessionType(65001, 65001) === 'ibgp', 'the same AS number forms an iBGP session');
ok(bgp.sessionType('65001', 65001) === 'ibgp', 'a string AS still matches its numeric twin');
ok(bgp.sessionType(4200000000, 4200000001) === 'ebgp', '4-byte AS numbers classify correctly');
ok(bgp.sessionType(1, 4294967295) === 'ebgp', 'the two ends of the AS range differ');

// ---------------------------------------------------------------------------
// 5. finite state machine
// ---------------------------------------------------------------------------

console.log('\nnextState (FSM)');

ok(bgp.nextState('idle', 'manual-start') === 'connect', 'idle + manual-start -> connect');
ok(bgp.nextState('connect', 'tcp-connected') === 'opensent', 'connect + tcp-connected -> opensent');
ok(bgp.nextState('active', 'tcp-connected') === 'opensent', 'active + tcp-connected -> opensent');
ok(bgp.nextState('active', 'manual-start') === 'connect', 'active + manual-start -> connect');
ok(bgp.nextState('opensent', 'open-received') === 'openconfirm', 'opensent + open-received -> openconfirm');
ok(bgp.nextState('openconfirm', 'keepalive-received') === 'established',
  'openconfirm + keepalive-received -> established');
ok(bgp.nextState('established', 'keepalive-received') === 'established',
  'established + keepalive-received stays established');
ok(bgp.nextState('established', 'error') === 'idle', 'established + error -> idle');
ok(bgp.nextState('opensent', 'error') === 'idle', 'opensent + error -> idle');
ok(bgp.nextState('established', 'manual-stop') === 'idle', 'established + manual-stop -> idle');
ok(bgp.nextState('idle', 'manual-stop') === 'idle', 'idle + manual-stop is a no-op in idle');

ok(bgp.nextState('idle', 'tcp-connected') === 'idle', 'idle + tcp-connected is invalid and changes nothing');
ok(bgp.nextState('idle', 'open-received') === 'idle', 'idle + open-received is invalid and changes nothing');
ok(bgp.nextState('connect', 'open-received') === 'connect',
  'connect + open-received is invalid and stays in connect');
ok(bgp.nextState('opensent', 'keepalive-received') === 'opensent',
  'opensent + keepalive-received is invalid and stays in opensent');
ok(bgp.nextState('openconfirm', 'open-received') === 'openconfirm',
  'openconfirm + open-received is invalid and stays in openconfirm');
ok(bgp.nextState('established', 'manual-start') === 'established',
  'established + manual-start is invalid and stays established');
ok(bgp.nextState('opensent', 'hold-timer-expired') === 'opensent',
  'an unknown event leaves the state unchanged');
ok(bgp.nextState('bogus', 'manual-start') === 'idle',
  'an unknown state is not a transition and resets to idle');

// Full happy-path walk, then a teardown.
var walk = ['idle'];
var evs = ['manual-start', 'tcp-connected', 'open-received', 'keepalive-received'];
var st = 'idle';
for (var i = 0; i < evs.length; i++) {
  st = bgp.nextState(st, evs[i]);
  walk.push(st);
}
ok(deq(walk, ['idle', 'connect', 'opensent', 'openconfirm', 'established']),
  'a full event walk climbs idle -> established in five steps');
ok(bgp.nextState(st, 'manual-stop') === 'idle', 'the established session tears down to idle');

// ---------------------------------------------------------------------------
// 6. asPathLength
// ---------------------------------------------------------------------------

console.log('\nasPathLength');

ok(bgp.asPathLength([]) === 0, 'an empty AS path is zero hops');
ok(bgp.asPathLength(null) === 0, 'a missing AS path is zero hops');
ok(bgp.asPathLength([65001]) === 1, 'one AS is one hop');
ok(bgp.asPathLength([65001, 65002, 65003]) === 3, 'three ASes are three hops');
ok(bgp.asPathLength([65001, [65010, 65020, 65030], 65002]) === 3,
  'an AS_SET counts as exactly one hop');
ok(bgp.asPathLength([[65010, 65020]]) === 1, 'a lone AS_SET counts as one hop');
ok(bgp.asPathLength([65001, []]) === 1, 'an empty set adds nothing');
ok(bgp.asPathLength([65001, { type: 'set', asns: [65010] }, 65002]) === 3,
  'an object-shaped AS_SET counts as one hop');

// ---------------------------------------------------------------------------
// 7. pathIsLoopFree
// ---------------------------------------------------------------------------

console.log('\npathIsLoopFree');

ok(bgp.pathIsLoopFree([65001, 65002], 65003) === true, 'an AS absent from the path is loop free');
ok(bgp.pathIsLoopFree([65001, 65002], 65002) === false, 'the last AS in the path is a loop');
ok(bgp.pathIsLoopFree([65001, 65002, 65003], 65002) === false, 'a transit AS in the path is a loop');
ok(bgp.pathIsLoopFree([65001, [65010, 65099], 65002], 65099) === false,
  'an AS inside an AS_SET is a loop');
ok(bgp.pathIsLoopFree([65001, [65010, 65099], 65002], 65011) === true,
  'an AS outside the AS_SET is loop free');
ok(bgp.pathIsLoopFree([], 65001) === true, 'an empty path is loop free');
ok(bgp.pathIsLoopFree(['65001', '65002'], 65002) === false,
  'AS numbers stored as strings still match');
ok(bgp.pathIsLoopFree([65001], 'x') === true, 'an unparseable AS can never match');

// ---------------------------------------------------------------------------
// 8. advertise
// ---------------------------------------------------------------------------

console.log('\nadvertise');

var routes = [
  { prefix: '10.0.0.0/24', nextHop: '192.0.2.9', asPath: [65010, 65020], origin: bgp.BGP_ORIGIN.IGP,
    localPreference: 100, med: 20, from: 'peerX' },
  { prefix: '10.1.0.0/16', nextHop: '192.0.2.9', asPath: [65010], origin: bgp.BGP_ORIGIN.INCOMPLETE,
    localPreference: 150, med: 0, from: 'peerX' }
];
var routesSnapshot = before(routes);

var ebgpOut = bgp.advertise(routes, { localAs: 65001, type: 'ebgp', nextHop: '198.51.100.1' });
ok(before(routes) === routesSnapshot, 'advertise never mutates the input routes');
ok(ebgpOut.length === 2, 'advertise returns one entry per route');
ok(deq(ebgpOut[0].asPath, [65001, 65010, 65020]), 'eBGP prepends localAs to the AS path');
ok(ebgpOut[0].asPath.length === 3, 'localAs is prepended exactly once');
ok(ebgpOut[0].asPath[0] === 65001, 'the prepended AS sits at the head of the path');
ok(ebgpOut[1].asPath[0] === 65001 && ebgpOut[1].asPath[1] === 65010,
  'the prepend preserves the rest of the path in order');

var ibgpOut = bgp.advertise(routes, { localAs: 65001, type: 'ibgp', nextHop: '198.51.100.1' });
ok(deq(ibgpOut[0].asPath, [65010, 65020]), 'iBGP does not prepend localAs');
ok(ibgpOut[0].asPath.length === 2, 'the iBGP AS path keeps its original length');
ok(before(routes) === routesSnapshot, 'a second advertisement still leaves the input untouched');

ok(ebgpOut[0].nextHop === '198.51.100.1', 'opts.nextHop overrides the route next hop');
ok(bgp.advertise(routes, { localAs: 65001, type: 'ebgp' })[0].nextHop === '192.0.2.9',
  'without opts.nextHop the route keeps its own next hop');
ok(bgp.advertise([{ prefix: '10.0.0.0/24', asPath: [] }], { type: 'ibgp' })[0].nextHop === null,
  'a route with no next hop advertises null');

ok(ebgpOut[0].origin === bgp.BGP_ORIGIN.IGP && ebgpOut[1].origin === bgp.BGP_ORIGIN.INCOMPLETE,
  'origin survives advertisement unchanged');
ok(bgp.advertise([{ prefix: '10.0.0.0/24' }], { type: 'ibgp' })[0].origin === bgp.BGP_ORIGIN.INCOMPLETE,
  'an unspecified origin defaults to INCOMPLETE');
ok(bgp.advertise([{ prefix: '10.0.0.0/24', origin: 'igp' }], { type: 'ibgp' })[0].origin === 0,
  'a textual origin is normalised to its numeric code');
ok(bgp.advertise([{ prefix: '10.0.0.0/24', origin: 9 }], { type: 'ibgp' })[0].origin ===
  bgp.BGP_ORIGIN.INCOMPLETE, 'an out-of-range origin falls back to INCOMPLETE');

ok(ebgpOut[0].localPreference === 100 && ebgpOut[1].localPreference === 150,
  'local preference is carried per route');
ok(bgp.advertise([{ prefix: '10.0.0.0/24' }], { type: 'ibgp' })[0].localPreference === 100,
  'local preference defaults to 100');
ok(ebgpOut[0].med === 20 && ebgpOut[1].med === 0, 'MED is carried per route');
ok(bgp.advertise([{ prefix: '10.0.0.0/24' }], { type: 'ibgp' })[0].med === 0, 'MED defaults to 0');
ok(ebgpOut[0].from === 'peerX', 'the originating peer is copied through');
ok(bgp.advertise([{ prefix: '10.0.0.0/24' }], { type: 'ibgp' })[0].from === null,
  'a route with no source advertises null');
ok(ebgpOut[0].prefix === '10.0.0.0/24', 'the prefix is copied through');

ok(deq(Object.keys(ebgpOut[0]).sort(),
  ['asPath', 'from', 'localPreference', 'med', 'nextHop', 'origin', 'prefix']),
  'an advertised route carries exactly the documented fields');

ok(bgp.advertise([], { localAs: 65001, type: 'ebgp' }).length === 0, 'no routes advertise nothing');
ok(deq(bgp.advertise(null, { localAs: 65001 }), []), 'a non-array route list advertises nothing');
ok(bgp.advertise([null, 'nope'], { type: 'ibgp' }).length === 0, 'non-object entries are skipped');

// The output must be a copy, not a view onto the input.
var asPathSource = { prefix: '10.0.0.0/24', asPath: [65010, [65080, 65081]], origin: 0 };
var asPathSnapshot = before(asPathSource);
var copied = bgp.advertise([asPathSource], { localAs: 65001, type: 'ibgp' })[0];
copied.asPath.push(65055);
copied.asPath[1].push(65082);
ok(before(asPathSource) === asPathSnapshot,
  'mutating an advertised AS path cannot reach back into the route, AS_SET included');
ok(deq(asPathSource.asPath, [65010, [65080, 65081]]),
  'the nested AS_SET survives advertisement byte for byte');
ok(bgp.advertise([asPathSource], { localAs: 65001, type: 'ibgp' })[0].asPath !== asPathSource.asPath,
  'the advertised AS path is a fresh array');

// type defaults to iBGP, and an omitted peerAs falls back with it.
ok(deq(bgp.advertise(routes, { localAs: 65001 })[0].asPath, [65010, 65020]),
  'an omitted type advertises as iBGP and does not prepend');
ok(deq(bgp.advertise(routes, { localAs: 65001, peerAs: 65002 })[0].asPath, [65001, 65010, 65020]),
  'an omitted type is derived from peerAs when one is given');
ok(deq(bgp.advertise(routes, { localAs: 65001, peerAs: 65001 })[0].asPath, [65010, 65020]),
  'a matching peerAs makes the advertisement iBGP');
ok(deq(bgp.advertise(routes, { localAs: 0, type: 'ebgp' })[0].asPath, [65010, 65020]),
  'an invalid localAs is never prepended');

// ---------------------------------------------------------------------------
// 9. comparePaths -- one tie-break at a time
// ---------------------------------------------------------------------------

console.log('\ncomparePaths');

// 1. weight
var heavy = mkPath({ weight: 200 });
var light = mkPath({ weight: 100 });
ok(bgp.comparePaths(heavy, light) < 0, 'higher weight wins');
ok(bgp.comparePaths(light, heavy) > 0, 'lower weight loses');
ok(bgp.comparePaths(mkPath({ weight: 100 }), mkPath({ weight: 100 })) === 0,
  'equal weights fall through to the next test');
ok(bgp.comparePaths(mkPath({ weight: 50, localPreference: 50 }), mkPath({ weight: 60 })) > 0,
  'weight outranks local preference');

// 2. local preference
ok(bgp.comparePaths(mkPath({ localPreference: 200 }), mkPath({ localPreference: 100 })) < 0,
  'higher local preference wins');
ok(bgp.comparePaths(mkPath({ localPreference: 100 }), mkPath({ localPreference: 200 })) > 0,
  'lower local preference loses');
ok(bgp.comparePaths(mkPath({ localPreference: 300, asPath: [65001, 65002, 65003, 65004] }),
  mkPath({ localPreference: 100, asPath: [65001] })) < 0,
  'local preference outranks AS path length');

// 3. locally originated
var localPath = mkPath({ local: true, asPath: [65001, 65002, 65003] });
var learnedPath = mkPath({ asPath: [65001] });
ok(bgp.comparePaths(localPath, learnedPath) < 0, 'a locally originated path wins');
ok(bgp.comparePaths(learnedPath, localPath) > 0, 'a learned path loses to a local one');
ok(bgp.comparePaths(mkPath({ nextHop: '0.0.0.0', asPath: [65001, 65002] }),
  mkPath({ asPath: [65001] })) < 0, 'next hop 0.0.0.0 marks a path as locally originated');
ok(bgp.comparePaths(mkPath({ from: 'local', asPath: [65001, 65002] }),
  mkPath({ asPath: [65001] })) < 0, 'from === local marks a path as locally originated');
ok(bgp.comparePaths(mkPath({ local: true, localPreference: 90 }),
  mkPath({ localPreference: 100 })) > 0, 'local preference outranks locally originated');

// 4. AS path length
ok(bgp.comparePaths(mkPath({ asPath: [65001] }), mkPath({ asPath: [65001, 65002, 65003] })) < 0,
  'the shorter AS path wins');
ok(bgp.comparePaths(mkPath({ asPath: [65001, 65002] }), mkPath({ asPath: [65001] })) > 0,
  'the longer AS path loses');
ok(bgp.comparePaths(mkPath({ asPath: [65001, [65010, 65020]] }), mkPath({ asPath: [65001, 65002] })) === 0,
  'an AS_SET of any size weighs the same as a single AS hop');

// 5. origin
ok(bgp.comparePaths(mkPath({ origin: bgp.BGP_ORIGIN.IGP }),
  mkPath({ origin: bgp.BGP_ORIGIN.EGP })) < 0, 'IGP beats EGP');
ok(bgp.comparePaths(mkPath({ origin: bgp.BGP_ORIGIN.EGP }),
  mkPath({ origin: bgp.BGP_ORIGIN.INCOMPLETE })) < 0, 'EGP beats INCOMPLETE');
ok(bgp.comparePaths(mkPath({ origin: bgp.BGP_ORIGIN.INCOMPLETE }),
  mkPath({ origin: bgp.BGP_ORIGIN.IGP })) > 0, 'INCOMPLETE loses to IGP');
ok(bgp.comparePaths(mkPath({ origin: bgp.BGP_ORIGIN.IGP, asPath: [65001, 65002] }),
  mkPath({ origin: bgp.BGP_ORIGIN.INCOMPLETE, asPath: [65001] })) > 0,
  'AS path length outranks origin');

// 6. MED
ok(bgp.comparePaths(mkPath({ med: 10 }), mkPath({ med: 50 })) < 0, 'the lower MED wins');
ok(bgp.comparePaths(mkPath({ med: 50 }), mkPath({ med: 10 })) > 0, 'the higher MED loses');
ok(bgp.comparePaths(mkPath({ med: 999, origin: bgp.BGP_ORIGIN.EGP }),
  mkPath({ med: 0, origin: bgp.BGP_ORIGIN.IGP })) > 0, 'origin outranks MED');

// 7. eBGP over iBGP
ok(bgp.comparePaths(mkPath({ type: 'ebgp', routerId: '9.9.9.9' }),
  mkPath({ type: 'ibgp', routerId: '1.1.1.1' })) < 0, 'eBGP beats iBGP');
ok(bgp.comparePaths(mkPath({ type: 'ibgp', routerId: '1.1.1.1' }),
  mkPath({ type: 'ebgp', routerId: '9.9.9.9' })) > 0, 'iBGP loses to eBGP');
ok(bgp.comparePaths(mkPath({ localAs: 65001, peerAs: 65002, routerId: '9.9.9.9', type: undefined }),
  mkPath({ localAs: 65001, peerAs: 65001, routerId: '1.1.1.1', type: undefined })) < 0,
  'the session type is derived from localAs/peerAs when type is missing');
ok(bgp.comparePaths(mkPath({ med: 900, type: 'ebgp' }), mkPath({ med: 0, type: 'ibgp' })) > 0,
  'MED outranks the eBGP/iBGP preference');

// 8. router ID
ok(bgp.comparePaths(mkPath({ routerId: '1.1.1.1' }), mkPath({ routerId: '2.2.2.2' })) < 0,
  'the lower router ID wins');
ok(bgp.comparePaths(mkPath({ routerId: '2.2.2.2' }), mkPath({ routerId: '1.1.1.1' })) > 0,
  'the higher router ID loses');
ok(bgp.comparePaths(mkPath({ routerId: '10.0.0.2' }), mkPath({ routerId: '10.0.0.10' })) < 0,
  'router IDs compare numerically, not as strings');
ok(bgp.comparePaths(mkPath({ type: 'ebgp', routerId: '9.9.9.9' }),
  mkPath({ type: 'ibgp', routerId: '1.1.1.1' })) < 0, 'session type outranks the router ID');

// total order
ok(bgp.comparePaths(mkPath(), mkPath()) === 0, 'two identical paths compare equal');
ok(bgp.comparePaths({}, {}) === 0, 'two empty paths compare equal');
ok(bgp.comparePaths({}, null) === 0, 'a null neighbour is treated as an empty path');
ok(bgp.comparePaths(mkPath({ asPath: [] }), null) < 0,
  'an otherwise empty path still ranks by router ID');
ok(mkPath().asPath.length === 1 && mkPath().weight === undefined,
  'comparePaths never mutates the paths it compares');

// ---------------------------------------------------------------------------
// 10. bestPath
// ---------------------------------------------------------------------------

console.log('\nbestPath');

var best = mkPath({ prefix: '10.0.0.0/24', routerId: '4.4.4.4', localPreference: 300 });
var mid = mkPath({ prefix: '10.0.0.0/24', routerId: '2.2.2.2', localPreference: 200 });
var worst = mkPath({ prefix: '10.0.0.0/24', routerId: '1.1.1.1', localPreference: 100 });
var candidates = [worst, best, mid];
var candidatesSnapshot = before(candidates);

var winner = bgp.bestPath(candidates);
ok(winner === best, 'bestPath returns the highest local preference');
ok(winner.routerId === '4.4.4.4', 'the winner is the expected neighbour');
ok(before(candidates) === candidatesSnapshot, 'bestPath never mutates the candidate list');
ok(bgp.bestPath([mid, worst, best]) === best, 'the winner does not depend on input order');
ok(bgp.bestPath([best, mid, worst]) === best, 'a third order still elects the same path');
ok(deq(candidates.map(function (p) { return p.routerId; }), ['1.1.1.1', '4.4.4.4', '2.2.2.2']),
  'the caller\'s array keeps its original order');

var r1 = mkPath({ routerId: '1.1.1.1' });
var r2 = mkPath({ routerId: '2.2.2.2' });
ok(bgp.bestPath([r2, r1]) === r1, 'a total tie is broken on the lower router ID');

var sameIdA = mkPath({ routerId: '1.1.1.1', prefix: '10.0.0.0/24' });
var sameIdB = mkPath({ routerId: '1.1.1.1', prefix: '10.2.0.0/16' });
ok(bgp.bestPath([sameIdB, sameIdA]) === sameIdA, 'a router ID tie is broken on the lower prefix');
ok(bgp.bestPath([sameIdA, sameIdB]) === sameIdA, 'the prefix tie-break is order independent');

ok(bgp.bestPath([]) === null, 'no candidates elect nothing');
ok(bgp.bestPath(null) === null, 'a non-array candidate list elects nothing');
ok(bgp.bestPath([null, 'nope', 7]) === null, 'non-object candidates elect nothing');
ok(bgp.bestPath([null, r1, 'x']) === r1, 'non-object candidates are skipped, not fatal');

// The two-stage ranking: comparePaths first, prefix only to settle a full tie.
ok(bgp.bestPath([mkPath({ asPath: [65001, 65002, 65003] }), mkPath({ asPath: [65001] })])
  .asPath.length === 1, 'bestPath honours the AS path length ahead of every later field');

// ---------------------------------------------------------------------------
// 11. end-to-end: advertise then elect
// ---------------------------------------------------------------------------

console.log('\nadvertise + bestPath together');

var learned = bgp.advertise([
  { prefix: '203.0.113.0/24', nextHop: '192.0.2.1', asPath: [65010, 65020], origin: 0, med: 5, from: 'r2' }
], { localAs: 65001, type: 'ebgp', nextHop: '198.51.100.1' });
var localOriginated = bgp.advertise([
  { prefix: '203.0.113.0/24', nextHop: '0.0.0.0', asPath: [], origin: 0, from: 'local' }
], { localAs: 65001, type: 'ibgp', nextHop: '0.0.0.0' });

var table = bgp.bestPath([Object.assign({ routerId: '2.2.2.2' }, learned[0]),
  Object.assign({ routerId: '1.1.1.1' }, localOriginated[0])]);
ok(table.from === 'local', 'a locally originated path beats a learned one in the final table');
ok(table.routerId === '1.1.1.1', 'the elected entry is the expected candidate');
ok(learned[0].asPath[0] === 65001 && learned[0].asPath.length === 3,
  'the eBGP advertisement prepended before the election');
ok(learned[0].nextHop === '198.51.100.1', 'the advertised next hop is our own eBGP address');

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
