'use strict';
// scion.test.js -- unit tests for the SCION ISD/AS + path-segment model.
// Plain ok() assertions, no framework. Fixtures are hand-built plain objects so
// engine/scion.js is exercised in isolation (no simulator, no CLI, no server).

const scion = require('../engine/scion');

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

function eq(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function codes(list) {
  return (list || []).map(function (e) { return e.code; });
}

function hasCode(list, code) {
  return codes(list).indexOf(code) !== -1;
}

function firstMessage(list) {
  return (list && list.length) ? String(list[0].message) : '';
}

function clone(v) {
  return JSON.parse(JSON.stringify(v));
}

// ---------------------------------------------------------------------------
// fixtures -- one ISD, two core ASes, four non-core ASes
//
//   A -- M -- C1 -- C2 -- N -- B
//             \      /
//              410 (dual-homed edge AS, reaches both cores)
//
// Core ASes are the ones whose hex id ends in ':0' (C1 = ff00:0:0,
// C2 = ff00:100:0); A/M/N/B/410 are not.
// ---------------------------------------------------------------------------

const A = '1-ff00:0:110';
const M = '1-ff00:0:120';
const P = '1-ff00:0:210';
const B = '1-ff00:0:310';
const N = '1-ff00:0:320';
const E = '1-ff00:0:410';
const C1 = '1-ff00:0:0';
const C2 = '1-ff00:100:0';

function up1() {
  return scion.createSegment({ id: 'up1', type: 'up', from: A, to: C1, hops: [A, M, C1], mtu: 1400, latencyMs: 4 });
}
function down1() {
  return scion.createSegment({ id: 'down1', type: 'down', from: C1, to: B, hops: [C1, B], mtu: 1280, latencyMs: 3 });
}
function coreSeg() {
  return scion.createSegment({ id: 'core1', type: 'core', from: C1, to: C2, hops: [C1, C2], mtu: 1500, latencyMs: 2 });
}
function up2() {
  return scion.createSegment({ id: 'up2', type: 'up', from: A, to: C2, hops: [A, C2], mtu: 1500, latencyMs: 6 });
}
function down2() {
  return scion.createSegment({ id: 'down2', type: 'down', from: C2, to: B, hops: [C2, N, B], mtu: 1500, latencyMs: 5 });
}

// p1: A -> M -> C1 -> B           4 hops, 7 ms, mtu 1280
// p2: A -> C2 -> N -> B           4 hops, 11 ms, mtu 1500
// p3: A -> M -> C1 -> C2 -> N -> B  6 hops, 11 ms, mtu 1400
function paths() {
  return {
    p1: scion.buildPath([up1(), down1()]),
    p2: scion.buildPath([up2(), down2()]),
    p3: scion.buildPath([up1(), coreSeg(), down2()])
  };
}

// ---------------------------------------------------------------------------
// constants
// ---------------------------------------------------------------------------

ok(scion.SCION_UDP_PORT === 30041, 'SCION_UDP_PORT is 30041');
ok(eq(scion.PATH_TYPES, { UP: 'up', CORE: 'core', DOWN: 'down' }), 'PATH_TYPES is { UP: up, CORE: core, DOWN: down }');

// ---------------------------------------------------------------------------
// parseIsdAs / formatIsdAs
// ---------------------------------------------------------------------------

const idA = scion.parseIsdAs(A);
ok(idA.isd === 1, 'parseIsdAs: ISD part of 1-ff00:0:110 is 1');
ok(idA.asHex === 'ff00:0:110', "parseIsdAs: AS part of 1-ff00:0:110 is 'ff00:0:110'");
ok(idA.valid === true && idA.error === null, 'parseIsdAs: a valid id has valid=true and error=null');
ok(idA.asId === A, 'parseIsdAs: asId is the canonical full id');

ok(scion.formatIsdAs(idA.isd, idA.asHex) === A, 'formatIsdAs round-trips parseIsdAs');
ok(scion.formatIsdAs(1, 'ff00:0:110') === A, "formatIsdAs(1, 'ff00:0:110') is 1-ff00:0:110");

const padded = scion.parseIsdAs('01-FF00:00:0110');
ok(padded.valid === true && padded.isd === 1 && padded.asHex === 'ff00:0:110',
  'parseIsdAs: leading zeros and upper case are canonicalised');
ok(scion.formatIsdAs(' 1 ', 'FF00:0:110 ') === A, 'formatIsdAs trims and lower-cases its arguments');
ok(scion.formatIsdAs(A) === A, 'formatIsdAs reformats a full ISD-AS string');

ok(scion.parseIsdAs('0-ff00:0:110').isd === 0, 'ISD 0 is legal (parse)');
ok(scion.parseIsdAs('65535-ff00').isd === 65535, 'ISD 65535 is legal (upper bound)');
ok(scion.parseIsdAs('1-abcd').valid === true, 'a single 1-4 digit hex group is a legal AS id');
ok(scion.parseIsdAs(' 1-ff00:0:110 ').asId === A, 'parseIsdAs ignores surrounding whitespace');
ok(scion.parseIsdAs('1-a:b:c:d').valid === true, 'four single-digit hex groups are legal');

// ---------------------------------------------------------------------------
// ISD-AS validation errors
// ---------------------------------------------------------------------------

function badId(str, code, label) {
  const v = scion.validateIsdAs(str);
  ok(v.ok === false && hasCode(v.errors, code), label + ' -> ' + code);
}

badId('', 'ISD_AS_EMPTY', 'empty string');
badId('1ff00:0:110', 'ISD_AS_BAD_FORMAT', 'missing "-" separator');
badId('1-ff00-0-110', 'ISD_AS_BAD_FORMAT', 'more than one "-" separator');
badId('abc-ff00', 'ISD_AS_BAD_ISD', 'non-numeric ISD');
badId('-ff00', 'ISD_AS_BAD_ISD', 'empty ISD');
badId('65536-ff00', 'ISD_AS_ISD_RANGE', 'ISD above 65535');
badId('1-', 'ISD_AS_EMPTY_AS', 'empty AS part');
badId('1-ff00::110', 'ISD_AS_EMPTY_GROUP', 'doubled ":" (empty hex group)');
badId('1-ff00:0:110:', 'ISD_AS_EMPTY_GROUP', 'trailing ":" (empty hex group)');
badId('1-:ff00', 'ISD_AS_EMPTY_GROUP', 'leading ":" (empty hex group)');
badId('1-ff000:0:110', 'ISD_AS_BAD_GROUP', 'hex group longer than 4 digits');
badId('1-ff00:0:110g', 'ISD_AS_BAD_GROUP', 'non-hex digit in a group');
badId('1-ff00_0_110', 'ISD_AS_BAD_GROUP', 'underscore used as a separator');

const okId = scion.validateIsdAs(A);
ok(okId.ok === true && okId.errors.length === 0, 'validateIsdAs: a good id reports ok with no errors');
ok(scion.validateIsdAs(null).ok === false, 'validateIsdAs: null is rejected, not thrown on');
ok(scion.validateIsdAs('1-ff00::110:zz').errors.length >= 1, 'validateIsdAs: reports at least the first problem');
ok(scion.validateIsdAs('65536-ff000').errors.length === 2,
  'validateIsdAs: independent halves each report (bad ISD and bad AS group)');
ok(firstMessage(scion.validateIsdAs('65536-ff00').errors).indexOf('65536') !== -1,
  'validateIsdAs: the message names the offending ISD');

const notId = scion.parseIsdAs('nope');
ok(notId.valid === false && notId.isd === null && notId.asHex === null && notId.asId === null,
  'parseIsdAs: an invalid id yields null fields');
ok(typeof notId.error === 'string' && notId.error.length > 0, 'parseIsdAs: an invalid id yields an error string');
ok(scion.formatIsdAs('x', 'ff00') === '' && scion.formatIsdAs(1, 'zz') === '',
  'formatIsdAs: invalid parts format to the empty string');

// ---------------------------------------------------------------------------
// isCore -- documented rule: hex id ends in ':0'
// ---------------------------------------------------------------------------

ok(scion.isCore(C1) === true, "isCore: 1-ff00:0:0 is a core AS (ends in ':0')");
ok(scion.isCore(C2) === true, "isCore: 1-ff00:100:0 is a core AS (ends in ':0')");
ok(scion.isCore('ff00:0:0') === true, 'isCore: a bare hex id works too');
ok(scion.isCore(A) === false, 'isCore: 1-ff00:0:110 is not a core AS');
ok(scion.isCore('1-ff00') === false, "isCore: a single-group AS id does not end in ':0'");
ok(scion.isCore('garbage') === false && scion.isCore('') === false && scion.isCore(null) === false,
  'isCore: junk and empty values are not core ASes');

// ---------------------------------------------------------------------------
// endpoints
// ---------------------------------------------------------------------------

const epPlain = scion.parseEndpoint('1-ff00:0:110,[192.0.2.1]');
ok(epPlain.isdAs === A && epPlain.ip === '192.0.2.1', 'parseEndpoint: splits ISD-AS from the underlay IP');
ok(epPlain.port === null && epPlain.valid === true, 'parseEndpoint: no port means port=null');

const epPort = scion.parseEndpoint('1-ff00:0:110,[192.0.2.1]:30041');
ok(epPort.port === 30041, 'parseEndpoint: reads the :port suffix');
ok(epPort.isdAs === A && epPort.ip === '192.0.2.1', 'parseEndpoint: the port does not leak into the IP');

ok(scion.formatEndpoint({ isdAs: A, ip: '192.0.2.1', port: null }) === '1-ff00:0:110,[192.0.2.1]',
  'formatEndpoint: omits the port when there is none');
ok(scion.formatEndpoint(epPort) === '1-ff00:0:110,[192.0.2.1]:30041',
  'formatEndpoint: round-trips an endpoint with a port');
ok(scion.formatEndpoint('1-FF00:0:110,[192.0.2.1]') === '1-ff00:0:110,[192.0.2.1]',
  'formatEndpoint: normalises a string argument');
ok(scion.formatEndpoint(null) === '' && scion.formatEndpoint({}) === '',
  'formatEndpoint: null and empty endpoints format to the empty string');

const epUpper = scion.parseEndpoint(' 1-FF00:00:0110 , [192.0.2.7] ');
ok(epUpper.isdAs === A && epUpper.ip === '192.0.2.7', 'parseEndpoint: canonicalises ISD-AS and trims around the comma');

const epBare = scion.parseEndpoint('1-ff00:0:110,192.0.2.9:30041');
ok(epBare.valid === true && epBare.ip === '192.0.2.9' && epBare.port === 30041,
  'parseEndpoint: brackets are optional');

ok(scion.parseEndpoint('1-ff00:0:110').valid === false, 'parseEndpoint: a missing comma is rejected');
ok(scion.parseEndpoint('1-ff00:0:110,').valid === false, 'parseEndpoint: a missing IP is rejected');
ok(scion.parseEndpoint('1-ff00:0:110,[]').valid === false, 'parseEndpoint: empty brackets are rejected');
ok(scion.parseEndpoint('ff00:0:110,[192.0.2.1]').valid === false, 'parseEndpoint: the ISD part is required');
ok(scion.parseEndpoint('1-ff00::110,[192.0.2.1]').valid === false, 'parseEndpoint: a bad ISD-AS is rejected');
ok(scion.parseEndpoint('1-ff00:0:110,[999.1.1.1]').valid === false, 'parseEndpoint: an out-of-range octet is rejected');
ok(scion.parseEndpoint('1-ff00:0:110,[192.0.2.1').valid === false, 'parseEndpoint: an unterminated "[" is rejected');
ok(scion.parseEndpoint('1-ff00:0:110,[192.0.2.1]:0').valid === false, 'parseEndpoint: port 0 is rejected');
ok(scion.parseEndpoint('1-ff00:0:110,[192.0.2.1]:65536').valid === false, 'parseEndpoint: port 65536 is rejected');
ok(scion.parseEndpoint('1-ff00:0:110,[192.0.2.1]:udp').valid === false, 'parseEndpoint: a non-numeric port is rejected');
ok(scion.parseEndpoint('1-ff00:0:110,[192.0.2.1]x').valid === false, 'parseEndpoint: junk after "]" is rejected');
ok(scion.parseEndpoint('1-ff00:0:110,[192.0.2.1]:30041').port === scion.SCION_UDP_PORT,
  'parseEndpoint: the default SCION underlay port parses');

// ---------------------------------------------------------------------------
// createSegment / validateSegment
// ---------------------------------------------------------------------------

const segUp = scion.createSegment({ id: 'up1', type: 'UP', from: A, to: C1, hops: [A, C1] });
ok(segUp.type === 'up', 'createSegment: normalises the type to lower case');
ok(segUp.mtu === scion.DEFAULT_MTU, 'createSegment: mtu defaults to 1500');
ok(segUp.latencyMs === 2, 'createSegment: latencyMs defaults to one ms per hop');
ok(scion.createSegment({ type: 'up', from: A, to: C1, hops: [A, C1] }).id === 'up:1-ff00:0:110>1-ff00:0:0',
  'createSegment: derives an id when none is given');
ok(scion.createSegment({ type: 'up', from: A, to: C1, hops: [], latencyMs: 0 }).latencyMs === 0,
  'createSegment: an explicit latency of 0 is kept');

const spec = { id: 'x', type: 'up', from: A, to: C1, hops: ['1-FF00:0:110', C1] };
const madeSeg = scion.createSegment(spec);
ok(madeSeg.hops[0] === A, 'createSegment: canonicalises hop ids');
madeSeg.hops.push(M);
madeSeg.mtu = 1;
ok(spec.hops.length === 2 && spec.hops[0] === '1-FF00:0:110', 'createSegment: never aliases the caller\'s hops array');
ok(spec.mtu === undefined, 'createSegment: never mutates the caller\'s spec');

const vUp = scion.validateSegment(up1());
ok(vUp.ok === true && vUp.errors.length === 0, 'validateSegment: a well-formed segment is ok');
ok(hasCode(scion.validateSegment({ type: 'sideways', from: A, to: C1, hops: [A] }).errors, 'SEG_BAD_TYPE'),
  'validateSegment: an unknown type is SEG_BAD_TYPE');
ok(hasCode(scion.validateSegment({ type: 'up', from: A, to: C1, hops: [] }).errors, 'SEG_NO_HOPS'),
  'validateSegment: empty hops is SEG_NO_HOPS');
ok(hasCode(scion.validateSegment({ type: 'up', from: A, to: C1 }).errors, 'SEG_NO_HOPS'),
  'validateSegment: a missing hops array is SEG_NO_HOPS');
ok(hasCode(scion.validateSegment({ type: 'up', from: A, to: A, hops: [A] }).errors, 'SEG_SAME_ENDS'),
  'validateSegment: from === to is SEG_SAME_ENDS');
ok(hasCode(scion.validateSegment({ type: 'up', from: A, to: C1, hops: [A, 'nope', C1] }).errors, 'SEG_BAD_HOP'),
  'validateSegment: a bad hop id is SEG_BAD_HOP');
ok(hasCode(scion.validateSegment({ type: 'up', from: 'nope', to: C1, hops: [C1] }).errors, 'SEG_BAD_FROM'),
  'validateSegment: a bad from id is SEG_BAD_FROM');
ok(hasCode(scion.validateSegment({ type: 'up', from: A, to: 'nope', hops: [A] }).errors, 'SEG_BAD_TO'),
  'validateSegment: a bad to id is SEG_BAD_TO');
ok(hasCode(scion.validateSegment({ type: 'up', from: A, to: C1, hops: [A], mtu: 10 }).errors, 'SEG_BAD_MTU'),
  'validateSegment: an mtu below 68 is SEG_BAD_MTU');
ok(hasCode(scion.validateSegment({ type: 'up', from: A, to: C1, hops: [A], latencyMs: -1 }).errors, 'SEG_BAD_LATENCY'),
  'validateSegment: a negative latency is SEG_BAD_LATENCY');
ok(scion.validateSegment(null).ok === false, 'validateSegment: null is rejected, not thrown on');

// ---------------------------------------------------------------------------
// buildPath -- valid compositions
// ---------------------------------------------------------------------------

const P1 = paths();

ok(P1.p1.valid === true && P1.p1.error === null, 'buildPath([UP, DOWN]) is valid');
ok(eq(P1.p1.segments.map(function (s) { return s.id; }), ['up1', 'down1']), 'buildPath: keeps the segment order');
ok(eq(P1.p1.hops, [A, M, C1, B]), 'buildPath: flattens the hop list through the segments');
ok(P1.p1.segments[0].hops.length + P1.p1.segments[1].hops.length === 5 && P1.p1.hops.length === 4,
  'pathHops: the core AS shared by two segments appears once');

const P1b = scion.buildPath([scion.createSegment({ id: 'x', type: 'up', from: A, to: C1, hops: [A, C1], latencyMs: 2 })]);
ok(P1b.valid === false && hasCode([P1b.error], 'PATH_INVALID_COMPOSITION'), 'buildPath([UP]) alone is not a path');

ok(P1.p3.valid === true, 'buildPath([UP, CORE, DOWN]) is valid');
ok(eq(P1.p3.hops, [A, M, C1, C2, N, B]), 'buildPath([UP, CORE, DOWN]): flattened hops run up, across and down');

const cd = scion.buildPath([coreSeg(), down2()]);
ok(cd.valid === true, 'buildPath([CORE, DOWN]) is valid');
ok(eq(cd.hops, [C1, C2, N, B]), 'buildPath([CORE, DOWN]): starts at the core AS');

const uc = scion.buildPath([up1(), coreSeg()]);
ok(uc.valid === true, 'buildPath([UP, CORE]) is valid (core-only destination)');
ok(eq(uc.hops, [A, M, C1, C2]), 'buildPath([UP, CORE]): ends at the far core AS');

// ---------------------------------------------------------------------------
// buildPath -- rejected compositions
// ---------------------------------------------------------------------------

function badPath(segs, code, label) {
  const p = scion.buildPath(segs);
  ok(p.valid === false && p.error && p.error.code === code, label + ' -> ' + code);
  return p;
}

badPath([], 'PATH_NO_SEGMENTS', 'buildPath([])');
badPath(null, 'PATH_NO_SEGMENTS', 'buildPath(null)');
badPath([down1()], 'PATH_INVALID_COMPOSITION', 'a lone DOWN segment');
badPath([up1()], 'PATH_INVALID_COMPOSITION', 'a lone UP segment');
badPath([coreSeg()], 'PATH_INVALID_COMPOSITION', 'a lone CORE segment');
badPath([down1(), up1()], 'PATH_INVALID_COMPOSITION', 'DOWN followed by UP (the wrong way round)');
badPath([up1(), up2()], 'PATH_INVALID_COMPOSITION', 'UP followed by UP');
badPath([up1(), coreSeg(), coreSeg(), down2()], 'PATH_INVALID_COMPOSITION', 'two CORE segments in a row');
badPath([coreSeg(), up1(), down2()], 'PATH_INVALID_COMPOSITION', 'CORE, UP, DOWN');

const noJoin = badPath([up1(), down2()], 'PATH_SEGMENTS_DO_NOT_JOIN',
  'UP ending at C1 followed by a DOWN starting at C2');
ok(noJoin.error.message.indexOf(C1) !== -1 && noJoin.error.message.indexOf(C2) !== -1,
  'PATH_SEGMENTS_DO_NOT_JOIN: the message names both ASes that failed to meet');
ok(noJoin.error.message.indexOf('segment[0]') !== -1 && noJoin.error.message.indexOf('segment[1]') !== -1,
  'PATH_SEGMENTS_DO_NOT_JOIN: the message names both segment indexes');

const noJoin3 = badPath([up1(), coreSeg(), scion.createSegment({ type: 'down', from: C1, to: B, hops: [C1, B] })],
  'PATH_SEGMENTS_DO_NOT_JOIN', 'the third segment starts at the wrong core');
ok(noJoin3.error.message.indexOf('segment[2]') !== -1, 'PATH_SEGMENTS_DO_NOT_JOIN: flags the third segment too');

const badSeg = badPath([scion.createSegment({ id: 'broken', type: 'up', from: A, to: C1, hops: [] }), down1()],
  'PATH_INVALID_SEGMENT', 'a segment with no hops');
ok(badSeg.error.message.indexOf('segment[0]') !== -1 && badSeg.error.message.indexOf('SEG_NO_HOPS') !== -1,
  'PATH_INVALID_SEGMENT: the message carries the index and the inner code');

// rejected paths keep their segments so a CLI can still describe them
ok(noJoin.segments.length === 2 && eq(noJoin.hops, [A, M, C1, C2, N, B]),
  'a rejected path still carries its segments and best-effort hops');

// case-insensitivity across a join
const lowerJoin = scion.buildPath([
  scion.createSegment({ type: 'up', from: '1-FF00:00:0110', to: '1-FF00:0:0', hops: ['1-FF00:00:0110', '1-FF00:0:0'] }),
  scion.createSegment({ type: 'down', from: '1-ff00:0:0', to: B, hops: ['1-ff00:0:0', B] })
]);
ok(lowerJoin.valid === true, 'buildPath: segments join even when the ids differ in case or padding');

// ---------------------------------------------------------------------------
// non-mutation
// ---------------------------------------------------------------------------

const segsIn = [up1(), down1()];
const snapshot = clone(segsIn);
const built = scion.buildPath(segsIn);
ok(built.segments !== segsIn && built.segments.length === 2, 'buildPath: returns its own segments array');
ok(eq(segsIn, snapshot), 'buildPath: does not mutate the segments it was given');
scion.pathHops(built);
scion.pathLatency(built);
scion.pathMtu(built);
scion.describePath(built);
ok(eq(segsIn, snapshot), 'pathHops/pathLatency/pathMtu/describePath do not mutate the segments');

const pathListIn = [P1.p3, P1.p2, P1.p1];
const pathSnapshot = clone(pathListIn);
const policy = { avoidAses: [M], preferLatency: true };
const policySnapshot = clone(policy);
scion.selectPath(pathListIn, policy);
ok(eq(pathListIn, pathSnapshot), 'selectPath: does not mutate or reorder the path list');
ok(eq(policy, policySnapshot), 'selectPath: does not mutate the policy');

const nbIn = [[A, C1], [A, M], [M, C1], [B, N], [N, C2], [E, C1], [E, C2]];
const nbSnapshot = clone(nbIn);
scion.beaconing([C1, C2], nbIn);
ok(eq(nbIn, nbSnapshot), 'beaconing: does not mutate the neighbour list');

const coresIn = [C2, C1];
const coresSnapshot = clone(coresIn);
scion.beaconing(coresIn, nbIn);
ok(eq(coresIn, coresSnapshot), 'beaconing: does not mutate or reorder the core list');

// ---------------------------------------------------------------------------
// latency and MTU sums
// ---------------------------------------------------------------------------

ok(scion.pathLatency(P1.p1) === 7, 'pathLatency: 4 ms upstream + 3 ms downstream = 7 ms');
ok(scion.pathLatency(P1.p3) === 11, 'pathLatency: 4 + 2 + 5 = 11 ms across three segments');
ok(scion.pathLatency([]) === 0, 'pathLatency: an empty path is 0 ms');
ok(scion.pathLatency([{ latencyMs: '1.5' }, { latencyMs: 2 }, {}]) === 3.5,
  'pathLatency: numeric strings count, a missing latency counts as 0');
ok(scion.pathMtu(P1.p1) === 1280, 'pathMtu: the smallest segment MTU wins (1280)');
ok(scion.pathMtu(P1.p3) === 1400, 'pathMtu: 1400 beats the 1500 segments in a three-segment path');
ok(scion.pathMtu([]) === 0, 'pathMtu: an empty path has no MTU');

// ---------------------------------------------------------------------------
// selectPath
// ---------------------------------------------------------------------------

ok(scion.selectPath([P1.p3, P1.p2, P1.p1]) === P1.p1, 'selectPath: lowest total latency wins (7 ms)');
ok(scion.selectPath([P1.p1, P1.p2, P1.p3]) === P1.p1, 'selectPath: result does not depend on list order');
ok(scion.selectPath([P1.p2, P1.p3]) === P1.p2,
  'selectPath: equal latency (11 ms) is broken by fewer hops (4 vs 6)');

const avoided = scion.selectPath([P1.p3, P1.p2, P1.p1], { avoidAses: [M] });
ok(avoided === P1.p2, 'selectPath: avoidAses drops every path crossing the avoided AS');
ok(eq(scion.pathHops(avoided), [A, C2, N, B]), 'selectPath: the surviving path really avoids the AS');

ok(scion.selectPath([P1.p1], { avoidAses: [C1] }) === null,
  'selectPath: avoiding a mandatory core AS leaves nothing');
ok(scion.selectPath([], {}) === null, 'selectPath: an empty candidate list returns null');
ok(scion.selectPath(null) === null, 'selectPath: a missing candidate list returns null');
ok(scion.selectPath([P1.p1, P1.p2], { avoidAses: ['1-FF00:0:120'] }) === P1.p2,
  'selectPath: avoidAses matching is case-insensitive');

const invalidPath = scion.buildPath([down1()]);
ok(scion.selectPath([invalidPath, P1.p1]) === P1.p1, 'selectPath: invalid paths are skipped');

// tie-break: identical latency and hop count, different first hop
const tieDown = scion.createSegment({ id: 'tieDown', type: 'down', from: C1, to: B, hops: [C1, B], latencyMs: 3 });
const pathFromA = scion.buildPath([scion.createSegment({ id: 'ta', type: 'up', from: A, to: C1, hops: [A, C1], latencyMs: 2 }), tieDown]);
const pathFromP = scion.buildPath([scion.createSegment({ id: 'tp', type: 'up', from: P, to: C1, hops: [P, C1], latencyMs: 2 }), tieDown]);
ok(scion.pathLatency(pathFromA) === scion.pathLatency(pathFromP), 'tie-break fixture: both paths are 5 ms');
ok(pathFromA.hops.length === pathFromP.hops.length, 'tie-break fixture: both paths are 3 hops');
ok(scion.selectPath([pathFromP, pathFromA]) === pathFromA,
  'selectPath: last tie-break is the lexicographically smallest first hop');
ok(scion.selectPath([pathFromA, pathFromP]) === pathFromA,
  'selectPath: the first-hop tie-break is order independent');

// preferLatency: false -> fewest hops first
const fastLong = scion.buildPath([
  scion.createSegment({ id: 'fl-u', type: 'up', from: A, to: C1, hops: [A, M, C1], latencyMs: 4 }),
  scion.createSegment({ id: 'fl-d', type: 'down', from: C1, to: B, hops: [C1, B], latencyMs: 1 })
]);
const slowShort = scion.buildPath([
  scion.createSegment({ id: 'ss-u', type: 'up', from: A, to: C1, hops: [A, C1], latencyMs: 6 }),
  scion.createSegment({ id: 'ss-d', type: 'down', from: C1, to: N, hops: [C1, N], latencyMs: 3 })
]);
ok(scion.pathLatency(fastLong) === 5 && fastLong.hops.length === 4, 'preferLatency fixture: 4 hops, 5 ms');
ok(scion.pathLatency(slowShort) === 9 && slowShort.hops.length === 3, 'preferLatency fixture: 3 hops, 9 ms');
ok(scion.selectPath([fastLong, slowShort]) === fastLong, 'selectPath: preferLatency (default) takes the 5 ms path');
ok(scion.selectPath([fastLong, slowShort], { preferLatency: false }) === slowShort,
  'selectPath: preferLatency false takes the shorter 3-hop path instead');

// determinism over several shuffles
const pool = [P1.p1, P1.p2, P1.p3];
const orders = [[0, 1, 2], [2, 1, 0], [1, 0, 2], [2, 0, 1], [1, 2, 0], [0, 2, 1]];
let allSame = true;
for (const o of orders) {
  if (scion.selectPath([pool[o[0]], pool[o[1]], pool[o[2]]]) !== P1.p1) allSame = false;
}
ok(allSame, 'selectPath: every permutation of the same candidates picks the same path');

// ---------------------------------------------------------------------------
// beaconing
// ---------------------------------------------------------------------------

const neighbours = [
  [A, C1], [A, M], [M, C1],
  [B, N], [N, C2],
  [E, C1], [E, C2],
  [C1, C2] // core-to-core, never beaconed as an up/down segment
];
const beacons = scion.beaconing([C1, C2], neighbours);

ok(beacons.length === 12, 'beaconing: 3 ASes reached from C1 plus 3 from C2, up and down each');
ok(eq(beacons.map(function (b) { return b.type; }).filter(function (t) { return t === 'core'; }), []),
  'beaconing: core-to-core links produce no beacons');

function sortedByTypeFromTo(list) {
  for (let i = 1; i < list.length; i++) {
    const a = list[i - 1];
    const b = list[i];
    if (a.type !== b.type) { if (a.type > b.type) return false; continue; }
    if (a.from !== b.from) { if (a.from > b.from) return false; continue; }
    if (a.to > b.to) return false;
  }
  return true;
}
ok(sortedByTypeFromTo(beacons), 'beaconing: output is sorted by (type, from, to)');
ok(beacons[0].type === 'down' && beacons[0].from === C1,
  "beaconing: DOWN segments come first, from the lowest core AS");

const upFromB = beacons.find(function (b) { return b.type === 'up' && b.from === B; });
ok(upFromB !== undefined && upFromB.to === C2, 'beaconing: B gets an UP segment to its core C2');
ok(eq(upFromB.hops, [B, N, C2]), 'beaconing: UP hops run non-core -> ... -> core');
const downToB = beacons.find(function (b) { return b.type === 'down' && b.to === B; });
ok(downToB !== undefined && downToB.from === C2, 'beaconing: C2 gets a DOWN segment to B');
ok(eq(downToB.hops, [C2, N, B]), 'beaconing: DOWN hops run core -> ... -> non-core');

const upFromE = beacons.filter(function (b) { return b.type === 'up' && b.from === E; });
ok(upFromE.length === 2, 'beaconing: a dual-homed AS gets one UP segment per core');
ok(eq(upFromE.map(function (b) { return b.to; }), [C1, C2]), 'beaconing: its two UP segments are sorted by core AS');

ok(beacons.filter(function (b) { return b.from === C1 && b.to === C2; }).length === 0,
  'beaconing: a core AS is never the far end of an up/down segment');

const beaconsReversed = scion.beaconing([C2, C1], neighbours.slice().reverse().map(function (p) { return [p[1], p[0]]; }));
ok(eq(beaconsReversed, beacons), 'beaconing: same output for reversed cores and flipped edges');

const adjacencyMap = {};
adjacencyMap[A] = [C1, M];
adjacencyMap[M] = [C1];
adjacencyMap[B] = [N];
adjacencyMap[N] = [C2];
adjacencyMap[E] = [C1, C2];
adjacencyMap[C1] = [C2];
ok(eq(scion.beaconing([C1, C2], adjacencyMap), beacons), 'beaconing: an adjacency map yields the same beacons');

ok(eq(scion.beaconing([], neighbours), []), 'beaconing: no core ASes means no beacons');
ok(eq(scion.beaconing([C1], []), []), 'beaconing: no neighbours means no beacons');
const fromNonCoreRoot = scion.beaconing([A], neighbours);
ok(fromNonCoreRoot.length === 2 && fromNonCoreRoot.every(function (b) { return b.from === A || b.to === A; }),
  'beaconing: only the ASes listed in coreAses originate segments');
ok(fromNonCoreRoot.every(function (b) { return b.from !== C1 && b.to !== C1; }),
  'beaconing: a real core AS still acts as a boundary, never as a downstream AS');

const onlyC1 = scion.beaconing([C1], neighbours);
ok(onlyC1.length === 6 && onlyC1.every(function (b) { return b.from === C1 || b.to === C1; }),
  'beaconing: a single core only beacons what it reaches on its own side of the network');

const selfLoop = scion.beaconing([C1], [[C1, C1], [A, A], [A, C1]]);
ok(selfLoop.length === 2 && selfLoop.every(function (b) { return b.from === A || b.to === A; }),
  'beaconing: self links are ignored');

// ---------------------------------------------------------------------------
// describePath
// ---------------------------------------------------------------------------

const lines = scion.describePath(P1.p1);
ok(Array.isArray(lines) && lines.length >= 4, 'describePath: returns an array of lines');
ok(lines.every(function (l) { return typeof l === 'string'; }), 'describePath: every line is a string');
ok(lines[0] === 'SCION path: valid, 2 segments, 4 hops, 7 ms, mtu 1280, underlay UDP/30041',
  'describePath: the summary line carries segments, hops, latency, MTU and the underlay port');
ok(lines.indexOf('  hops: ' + [A, M, C1, B].join(' -> ')) !== -1, 'describePath: renders the flattened hop list');
ok(lines[1].indexOf('up') !== -1 && lines[1].indexOf(A) !== -1 && lines[1].indexOf(C1) !== -1,
  'describePath: a segment line names its type and both end ASes');
ok(lines[2].indexOf('down') !== -1, 'describePath: the DOWN segment is rendered second');

const badLines = scion.describePath(scion.buildPath([down1()]));
ok(badLines[0].indexOf('invalid') !== -1, 'describePath: an invalid path says so');
ok(badLines.join('\n').indexOf('PATH_INVALID_COMPOSITION') !== -1,
  'describePath: an invalid path prints the error code');

ok(eq(scion.describePath([]), ['SCION path: empty (0 segments)']), 'describePath: an empty path is described as empty');

const tripleLines = scion.describePath(P1.p3);
ok(tripleLines[0].indexOf('3 segments') !== -1 && tripleLines[0].indexOf('11 ms') !== -1,
  'describePath: counts and sums three-segment paths');
ok(tripleLines.join('\n').indexOf('core') !== -1, 'describePath: the CORE segment appears in the output');

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
