'use strict';
// vlan-membership-lookup.test.js -- asking "is this VLAN allowed on that trunk?"
// must not re-tokenise the allowed list on every call.
//
// `switchport trunk allowed vlan remove 2` on a default trunk leaves every other
// assignable id in allowedVlans: 4,089 of them. classifyEgress() normalises the
// port config and then asks vlanListIncludes() about one id, and both used to run
// the whole parseVlanList() tokeniser (string conversion, regex per entry, sort)
// over that array -- ~1.3 ms of work to answer a one-bit question (#1809). PR
// #1749 bounds 2,000 such calls at 3 s and went red in CI at 6 s.
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

function section(title) {
  console.log('\n' + title);
}

// The list `switchport trunk allowed vlan remove 2` leaves behind on a default
// trunk: every assignable id except 2, ascending, no duplicates, none reserved.
function fullAllowedList() {
  const out = [];
  for (let v = vlan.VLAN_MIN; v <= vlan.VLAN_MAX; v++) {
    if (v < 1002 || v > 1005) out.push(v);
  }
  return out.filter(function (v) { return v !== 2; });
}

// ---------------------------------------------------------------------------
section('membership: canonical list answers the same as a full parse');
// ---------------------------------------------------------------------------
const full = fullAllowedList();
const fullTrunk = { mode: 'trunk', nativeVlan: 1, allowedVlans: full.slice() };

check('the fixture is the 4,089-id list #1809 describes', function () {
  assert.strictEqual(full.length, 4089);
});

check('vlanListIncludes() agrees with parseVlanList() for every id 1-4094', function () {
  const reference = new Set(vlan.parseVlanList(full).vlans);
  for (let v = 1; v <= 4094; v++) {
    assert.strictEqual(vlan.vlanListIncludes(full, v), reference.has(v),
      'disagreement at VLAN ' + v);
  }
});

check('a sliced copy of the list gets the same answers as the original', function () {
  const copy = full.slice();
  assert.strictEqual(vlan.vlanListIncludes(copy, 1), true);
  assert.strictEqual(vlan.vlanListIncludes(copy, 2), false);   // removed
  assert.strictEqual(vlan.vlanListIncludes(copy, 1003), false); // reserved
  assert.strictEqual(vlan.vlanListIncludes(copy, 4094), true);
});

check('classifyEgress() on a 4,089-id trunk still untags the native VLAN', function () {
  assert.deepStrictEqual(vlan.classifyEgress(fullTrunk, 1), { action: 'untagged', vid: 1 });
});

check('classifyEgress() on a 4,089-id trunk still tags an allowed VLAN', function () {
  assert.deepStrictEqual(vlan.classifyEgress(fullTrunk, 4000), { action: 'tagged', vid: 4000 });
});

check('classifyEgress() drops a VLAN that was removed from the trunk', function () {
  assert.deepStrictEqual(vlan.classifyEgress(fullTrunk, 2), { action: 'drop', vid: 2 });
});

check('classifyEgress() drops a VLAN in the reserved block', function () {
  assert.deepStrictEqual(vlan.classifyEgress(fullTrunk, 1003), { action: 'drop', vid: 1003 });
});

check('classifyIngress() accepts an allowed tagged VLAN', function () {
  assert.deepStrictEqual(vlan.classifyIngress(fullTrunk, { tagged: true, vid: 4000 }),
    { action: 'accept', vlanId: 4000 });
});

check('classifyIngress() rejects a removed tagged VLAN', function () {
  const got = vlan.classifyIngress(fullTrunk, { tagged: true, vid: 2 });
  assert.strictEqual(got.action, 'drop');
  assert.strictEqual(got.reason, 'vlan-not-allowed');
});

// ---------------------------------------------------------------------------
section('membership: non-canonical lists keep their parsed meaning');
// ---------------------------------------------------------------------------
check('an unsorted list is still a membership list', function () {
  assert.strictEqual(vlan.vlanListIncludes([20, 10], 10), true);
  assert.strictEqual(vlan.vlanListIncludes([20, 10], 30), false);
});

check('a list with duplicate ids is still a membership list', function () {
  assert.strictEqual(vlan.vlanListIncludes([10, 10, 20], 10), true);
  assert.strictEqual(vlan.vlanListIncludes([10, 10, 20], 20), true);
});

check('a list of numeric strings is still a membership list', function () {
  assert.strictEqual(vlan.vlanListIncludes(['10', '20'], 10), true);
  assert.strictEqual(vlan.vlanListIncludes(['10', '20'], 20), true);
  assert.strictEqual(vlan.vlanListIncludes(['10', '20'], 30), false);
});

check('a reserved id in a list is still never a member', function () {
  assert.strictEqual(vlan.vlanListIncludes([10, 1003], 1003), false);
});

check('normalizePortConfig() returns a sorted, de-duplicated copy', function () {
  const cfg = vlan.normalizePortConfig({ mode: 'trunk', allowedVlans: [20, '10', 10, 10] });
  assert.deepStrictEqual(cfg.allowedVlans, [10, 20]);
});

check('normalizePortConfig() does not alias the caller array', function () {
  const input = [10, 20];
  const cfg = vlan.normalizePortConfig({ mode: 'trunk', allowedVlans: input });
  cfg.allowedVlans.push(30);
  assert.deepStrictEqual(input, [10, 20], 'input array was mutated through the result');
});

check('normalizePortConfig() does not alias a 4,089-id caller array', function () {
  const input = full.slice();
  const cfg = vlan.normalizePortConfig({ mode: 'trunk', allowedVlans: input });
  assert.deepStrictEqual(cfg.allowedVlans, input);
  assert.notStrictEqual(cfg.allowedVlans, input);
  cfg.allowedVlans.length = 0;
  assert.strictEqual(input.length, 4089, 'input array was mutated through the result');
});

check('normalizePortConfig() keeps a media default in an allowed list and drops out-of-range ids', function () {
  // 1003 is a member of a trunk's allowed list on a real box (the default list is 1-4094 and a switch will
  // not remove them), so the normaliser must not quietly drop it - see
  // research/trunk-allowed-reserved-vlans.md. 5000 is not a VLAN id at all and still goes.
  const cfg = vlan.normalizePortConfig({ mode: 'trunk', allowedVlans: [10, 1003, 5000] });
  assert.deepStrictEqual(cfg.allowedVlans, [10, 1003]);
});

// ---------------------------------------------------------------------------
section('performance: 2,000 egress decisions on a 4,089-id trunk');
// ---------------------------------------------------------------------------
// The bound PR #1749's suite uses. It is a symptom check, not the contract: the
// contract is that a membership question costs a lookup, not a tokenisation.
check('2,000 classifyEgress() calls finish in under 1,500 ms', function () {
  const cfgs = [];
  for (let i = 0; i < 2000; i++) cfgs.push(fullTrunk);
  let allowed = 0;
  const started = process.hrtime.bigint();
  for (let i = 0; i < cfgs.length; i++) {
    const verdict = vlan.classifyEgress(cfgs[i], 4000);
    if (verdict.action === 'tagged') allowed++;
  }
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  assert.strictEqual(allowed, 2000);
  assert.ok(ms < 1500, 'classification took ' + ms.toFixed(0) + ' ms for 2,000 calls');
  console.log('         (measured ' + ms.toFixed(0) + ' ms)');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
