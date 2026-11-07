'use strict';
// vlan.test.js -- unit tests for the pure 802.1Q VLAN engine (engine/vlan.js).
const assert = require('assert');
const vlan = require('../engine/vlan');

let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ok   ' + name);
  } catch (err) {
    failed++;
    console.error('  FAIL ' + name);
    console.error('         ' + err.message.split('\n')[0]);
  }
}

function hasCode(list, code) {
  return list.some(function (entry) { return entry.code === code; });
}

function section(title) {
  console.log('\n' + title);
}

// ---------------------------------------------------------------------------
section('constants');
// ---------------------------------------------------------------------------
check('VLAN_MIN is 1', function () {
  assert.strictEqual(vlan.VLAN_MIN, 1);
});
check('VLAN_MAX is 4094', function () {
  assert.strictEqual(vlan.VLAN_MAX, 4094);
});
check('VLAN_DEFAULT is 1', function () {
  assert.strictEqual(vlan.VLAN_DEFAULT, 1);
});

// ---------------------------------------------------------------------------
section('parseVlanList: accepted forms');
// ---------------------------------------------------------------------------
check('number 10 -> [10]', function () {
  const r = vlan.parseVlanList(10);
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.vlans, [10]);
  assert.deepStrictEqual(r.ranges, [[10, 10]]);
});
check('array [1,10,20] -> [1,10,20]', function () {
  const r = vlan.parseVlanList([1, 10, 20]);
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.vlans, [1, 10, 20]);
  assert.deepStrictEqual(r.ranges, [[1, 1], [10, 10], [20, 20]]);
});
check("string '10' -> [10]", function () {
  const r = vlan.parseVlanList('10');
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.vlans, [10]);
});
check("string '10,20-30' expands to 12 ids and 2 ranges", function () {
  const r = vlan.parseVlanList('10,20-30');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.vlans.length, 12);
  assert.strictEqual(r.vlans[0], 10);
  assert.strictEqual(r.vlans[1], 20);
  assert.strictEqual(r.vlans[11], 30);
  assert.deepStrictEqual(r.ranges, [[10, 10], [20, 30]]);
});
check("string '30-20' is normalised to 20-30", function () {
  const r = vlan.parseVlanList('30-20');
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.ranges, [[20, 30]]);
  assert.strictEqual(r.vlans.length, 11);
});
check("'all' covers 1..4094 minus the reserved block", function () {
  const r = vlan.parseVlanList('all');
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.ranges, [[1, 4094]]);
  assert.strictEqual(r.vlans.length, 4090);
  assert.strictEqual(r.vlans[0], 1);
  assert.strictEqual(r.vlans[r.vlans.length - 1], 4094);
  assert.strictEqual(r.vlans.indexOf(1003), -1);
});
check('duplicates are kept out of vlans but reported', function () {
  const r = vlan.parseVlanList('10,10,20');
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.vlans, [10, 20]);
  assert.deepStrictEqual(r.duplicates, [10]);
});

// ---------------------------------------------------------------------------
section('parseVlanList: rejected forms');
// ---------------------------------------------------------------------------
check('vlan 0 -> E_VLAN_RANGE', function () {
  const r = vlan.parseVlanList(0);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, 'E_VLAN_RANGE');
});
check('vlan 4095 -> E_VLAN_RANGE', function () {
  const r = vlan.parseVlanList(4095);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, 'E_VLAN_RANGE');
});
check('range 4000-5000 -> E_VLAN_RANGE', function () {
  const r = vlan.parseVlanList('4000-5000');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, 'E_VLAN_RANGE');
});
check('vlan 1002 -> E_VLAN_RESERVED', function () {
  const r = vlan.parseVlanList(1002);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, 'E_VLAN_RESERVED');
  assert.deepStrictEqual(r.vlans, []);
});
check('vlan 1005 -> E_VLAN_RESERVED, 1001 and 1006 are fine', function () {
  assert.strictEqual(vlan.parseVlanList(1005).error, 'E_VLAN_RESERVED');
  assert.strictEqual(vlan.parseVlanList(1001).ok, true);
  assert.strictEqual(vlan.parseVlanList(1006).ok, true);
});
check("'abc' -> E_VLAN_SYNTAX", function () {
  const r = vlan.parseVlanList('abc');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, 'E_VLAN_SYNTAX');
});
check('empty string / null / [] -> E_VLAN_EMPTY', function () {
  assert.strictEqual(vlan.parseVlanList('').error, 'E_VLAN_EMPTY');
  assert.strictEqual(vlan.parseVlanList(null).error, 'E_VLAN_EMPTY');
  assert.strictEqual(vlan.parseVlanList([]).error, 'E_VLAN_EMPTY');
});

// ---------------------------------------------------------------------------
section('vlanListIncludes');
// ---------------------------------------------------------------------------
check("'10,20-30' includes 25, 30 and not 31", function () {
  assert.strictEqual(vlan.vlanListIncludes('10,20-30', 25), true);
  assert.strictEqual(vlan.vlanListIncludes('10,20-30', 30), true);
  assert.strictEqual(vlan.vlanListIncludes('10,20-30', 31), false);
});
check("array [1,10] includes 10 but string '10' does not contain 1", function () {
  assert.strictEqual(vlan.vlanListIncludes([1, 10], 10), true);
  assert.strictEqual(vlan.vlanListIncludes('10', 1), false);
});
check("'all' includes 4094, excludes 4095 and reserved 1003", function () {
  assert.strictEqual(vlan.vlanListIncludes('all', 4094), true);
  assert.strictEqual(vlan.vlanListIncludes('all', 4095), false);
  assert.strictEqual(vlan.vlanListIncludes('all', 1003), false);
});
check('malformed list never matches', function () {
  assert.strictEqual(vlan.vlanListIncludes('nope', 10), false);
  assert.strictEqual(vlan.vlanListIncludes(null, 10), false);
});

// ---------------------------------------------------------------------------
section('normalizePortConfig');
// ---------------------------------------------------------------------------
check('access defaults: pvid follows accessVlan', function () {
  assert.deepStrictEqual(vlan.normalizePortConfig({ mode: 'access', accessVlan: 10 }), {
    mode: 'access',
    accessVlan: 10,
    nativeVlan: 10,
    allowedVlans: [],
    pvid: 10,
    voiceVlan: null
  });
});
check('empty config becomes VLAN 1 access', function () {
  assert.deepStrictEqual(vlan.normalizePortConfig({}), {
    mode: 'access',
    accessVlan: 1,
    nativeVlan: 1,
    allowedVlans: [],
    pvid: 1,
    voiceVlan: null
  });
});
check('trunk defaults: allowed all, pvid follows nativeVlan', function () {
  assert.deepStrictEqual(vlan.normalizePortConfig({ mode: 'trunk' }), {
    mode: 'trunk',
    accessVlan: 1,
    nativeVlan: 1,
    allowedVlans: 'all',
    pvid: 1,
    voiceVlan: null
  });
});
check('trunk keeps explicit list sorted and unique', function () {
  const cfg = vlan.normalizePortConfig({ mode: 'TRUNK', nativeVlan: 5, allowedVlans: '20,5,10,5' });
  assert.strictEqual(cfg.mode, 'trunk');
  assert.deepStrictEqual(cfg.allowedVlans, [5, 10, 20]);
  assert.strictEqual(cfg.pvid, 5);
});
check('voiceVlan 0 normalises to null', function () {
  assert.strictEqual(vlan.normalizePortConfig({ voiceVlan: 0 }).voiceVlan, null);
});

// ---------------------------------------------------------------------------
section('classifyEgress');
// ---------------------------------------------------------------------------
check('access egress on its VLAN is untagged', function () {
  assert.deepStrictEqual(vlan.classifyEgress({ mode: 'access', accessVlan: 10 }, 10),
    { action: 'untagged', vid: 10 });
});
check('access egress to a foreign VLAN is dropped', function () {
  assert.deepStrictEqual(vlan.classifyEgress({ mode: 'access', accessVlan: 10 }, 20),
    { action: 'drop', vid: 20 });
});
check('trunk egress tags non-native allowed VLANs', function () {
  const cfg = { mode: 'trunk', nativeVlan: 1, allowedVlans: [1, 10, 20] };
  assert.deepStrictEqual(vlan.classifyEgress(cfg, 20), { action: 'tagged', vid: 20 });
});
check('trunk egress sends the native VLAN untagged', function () {
  const cfg = { mode: 'trunk', nativeVlan: 30, allowedVlans: [10, 30] };
  assert.deepStrictEqual(vlan.classifyEgress(cfg, 30), { action: 'untagged', vid: 30 });
});
check('trunk egress drops a VLAN that is not allowed', function () {
  const cfg = { mode: 'trunk', nativeVlan: 1, allowedVlans: [1, 10, 20] };
  assert.deepStrictEqual(vlan.classifyEgress(cfg, 30), { action: 'drop', vid: 30 });
});
check("trunk with allowedVlans 'all' tags VLAN 3000", function () {
  assert.deepStrictEqual(vlan.classifyEgress({ mode: 'trunk' }, 3000),
    { action: 'tagged', vid: 3000 });
});
check('egress to an out-of-range VLAN is dropped', function () {
  assert.strictEqual(vlan.classifyEgress({ mode: 'trunk' }, 4095).action, 'drop');
});

// ---------------------------------------------------------------------------
section('classifyIngress');
// ---------------------------------------------------------------------------
check('access ingress untagged lands in accessVlan', function () {
  assert.deepStrictEqual(vlan.classifyIngress({ mode: 'access', accessVlan: 10 }, { tagged: false, vid: null }),
    { action: 'accept', vlanId: 10 });
});
check('access ingress drops all tagged frames, even its own VLAN', function () {
  const cfg = { mode: 'access', accessVlan: 10 };
  const foreign = vlan.classifyIngress(cfg, { tagged: true, vid: 20 });
  assert.strictEqual(foreign.action, 'drop');
  assert.strictEqual(foreign.vlanId, null);
  assert.strictEqual(foreign.reason, 'tagged-frame-on-access');
  const own = vlan.classifyIngress(cfg, { tagged: true, vid: 10 });
  assert.strictEqual(own.action, 'drop');
});
check('trunk ingress untagged maps to the native VLAN', function () {
  const cfg = { mode: 'trunk', nativeVlan: 99, allowedVlans: [10, 20, 99] };
  assert.deepStrictEqual(vlan.classifyIngress(cfg, { tagged: false, vid: null }),
    { action: 'accept', vlanId: 99 });
});
check('trunk ingress accepts a tagged allowed VLAN as itself', function () {
  const cfg = { mode: 'trunk', nativeVlan: 99, allowedVlans: [10, 20, 99] };
  assert.deepStrictEqual(vlan.classifyIngress(cfg, { tagged: true, vid: 20 }),
    { action: 'accept', vlanId: 20 });
});
check('trunk ingress drops a tagged disallowed VLAN', function () {
  const cfg = { mode: 'trunk', nativeVlan: 99, allowedVlans: [10, 20, 99] };
  const r = vlan.classifyIngress(cfg, { tagged: true, vid: 30 });
  assert.strictEqual(r.action, 'drop');
  assert.strictEqual(r.vlanId, null);
  assert.strictEqual(r.reason, 'vlan-not-allowed');
});
check('trunk ingress drops a tagged frame with no VID', function () {
  const r = vlan.classifyIngress({ mode: 'trunk' }, { tagged: true, vid: null });
  assert.strictEqual(r.action, 'drop');
  assert.strictEqual(r.reason, 'tagged-frame-missing-vid');
});

// ---------------------------------------------------------------------------
section('validatePortConfig: errors');
// ---------------------------------------------------------------------------
check('accessVlan 0 is an error', function () {
  const r = vlan.validatePortConfig({ mode: 'access', accessVlan: 0 }, { portName: 'Fa0/1' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(hasCode(r.errors, 'E_VLAN_RANGE'), true);
});
check('accessVlan 4095 is an error', function () {
  const r = vlan.validatePortConfig({ mode: 'access', accessVlan: 4095 });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(hasCode(r.errors, 'E_VLAN_RANGE'), true);
});
check('accessVlan 1002 is reserved', function () {
  const r = vlan.validatePortConfig({ mode: 'access', accessVlan: 1002 });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(hasCode(r.errors, 'E_VLAN_RESERVED'), true);
});
check('reserved VLAN inside the allowed list is an error', function () {
  const r = vlan.validatePortConfig({ mode: 'trunk', nativeVlan: 10, allowedVlans: [10, 1003] });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(hasCode(r.errors, 'E_VLAN_RESERVED'), true);
});
check('out-of-range VLAN inside the allowed list is an error', function () {
  const r = vlan.validatePortConfig({ mode: 'trunk', nativeVlan: 10, allowedVlans: '10,5000' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(hasCode(r.errors, 'E_VLAN_RANGE'), true);
});
check('trunk native VLAN missing from the allowed list', function () {
  const r = vlan.validatePortConfig({ mode: 'trunk', nativeVlan: 20, allowedVlans: [10, 30] });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(hasCode(r.errors, 'E_NATIVE_NOT_ALLOWED'), true);
});
check('trunk with an empty allowed list', function () {
  const r = vlan.validatePortConfig({ mode: 'trunk', nativeVlan: 10, allowedVlans: [] });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(hasCode(r.errors, 'E_TRUNK_NO_VLANS'), true);
});
check('a clean trunk validates', function () {
  const r = vlan.validatePortConfig({ mode: 'trunk', nativeVlan: 10, allowedVlans: [10, 20, 30] });
  assert.deepStrictEqual(r, { ok: true, errors: [], warnings: [] });
});

// ---------------------------------------------------------------------------
section('validatePortConfig: warnings');
// ---------------------------------------------------------------------------
check('VLAN 1 as trunk native VLAN warns', function () {
  const r = vlan.validatePortConfig({ mode: 'trunk', nativeVlan: 1, allowedVlans: [1, 10] });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(hasCode(r.warnings, 'W_VLAN1_AS_NATIVE'), true);
});
check('accessVlan on a trunk warns', function () {
  const r = vlan.validatePortConfig({ mode: 'trunk', nativeVlan: 10, allowedVlans: [10, 20], accessVlan: 5 });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(hasCode(r.warnings, 'W_ACCESS_ON_TRUNK'), true);
});
check('duplicate VLAN in the allowed list warns (not an error)', function () {
  const r = vlan.validatePortConfig({ mode: 'trunk', nativeVlan: 10, allowedVlans: '10,10,20' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.errors.length, 0);
  assert.strictEqual(hasCode(r.warnings, 'W_DUP_VLAN_IN_LIST'), true);
});
check('voiceVlan on an access port warns', function () {
  const r = vlan.validatePortConfig({ mode: 'access', accessVlan: 10, voiceVlan: 20 });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(hasCode(r.warnings, 'E_VOICE_VLAN_UNSUPPORTED'), true);
});
check('port name is quoted in messages', function () {
  const r = vlan.validatePortConfig({ mode: 'access', accessVlan: 0 }, { portName: 'Gi0/2' });
  assert.ok(r.errors[0].message.indexOf('Gi0/2') === 0);
});

// ---------------------------------------------------------------------------
section('framesCompatible (LAG member consistency)');
// ---------------------------------------------------------------------------
check('two access ports on the same VLAN are compatible', function () {
  assert.strictEqual(vlan.framesCompatible(
    { mode: 'access', accessVlan: 10 },
    { mode: 'access', accessVlan: 10 }
  ), true);
});
check('access ports on different VLANs are not compatible', function () {
  assert.strictEqual(vlan.framesCompatible(
    { mode: 'access', accessVlan: 10 },
    { mode: 'access', accessVlan: 20 }
  ), false);
});
check('identical trunks are compatible (list order irrelevant)', function () {
  assert.strictEqual(vlan.framesCompatible(
    { mode: 'trunk', nativeVlan: 10, allowedVlans: [10, 20] },
    { mode: 'trunk', nativeVlan: 10, allowedVlans: '20,10' }
  ), true);
});
check('trunks with different native VLANs are not compatible', function () {
  assert.strictEqual(vlan.framesCompatible(
    { mode: 'trunk', nativeVlan: 10, allowedVlans: [10, 20] },
    { mode: 'trunk', nativeVlan: 20, allowedVlans: [10, 20] }
  ), false);
});
check('trunks with different allowed sets are not compatible', function () {
  assert.strictEqual(vlan.framesCompatible(
    { mode: 'trunk', nativeVlan: 10, allowedVlans: [10, 20] },
    { mode: 'trunk', nativeVlan: 10, allowedVlans: [10] }
  ), false);
});
check('access vs trunk is never compatible', function () {
  assert.strictEqual(vlan.framesCompatible(
    { mode: 'access', accessVlan: 10 },
    { mode: 'trunk', nativeVlan: 10, allowedVlans: [10] }
  ), false);
});
check("two 'all' trunks are compatible", function () {
  assert.strictEqual(vlan.framesCompatible({ mode: 'trunk' }, { mode: 'trunk' }), true);
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
