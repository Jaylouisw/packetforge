'use strict';
// vrrp.test.js -- VRRP group election, preempt behaviour and timer maths.
const vrrp = require('../engine/vrrp');

const VRRP_PROTOCOL = vrrp.VRRP_PROTOCOL;
const VRRP_DEFAULT_PRIORITY = vrrp.VRRP_DEFAULT_PRIORITY;
const VRRP_OWNER_PRIORITY = vrrp.VRRP_OWNER_PRIORITY;
const VRRP_DEFAULT_ADVERT_SEC = vrrp.VRRP_DEFAULT_ADVERT_SEC;
const validateGroup = vrrp.validateGroup;
const normalizeGroup = vrrp.normalizeGroup;
const virtualMac = vrrp.virtualMac;
const virtualMacMatches = vrrp.virtualMacMatches;
const electMaster = vrrp.electMaster;
const groupState = vrrp.groupState;
const advertInterval = vrrp.advertInterval;
const skewTime = vrrp.skewTime;
const masterDownInterval = vrrp.masterDownInterval;

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg); }
}

// A router as the simulator hands it to the election.
function router(id, priority, ip, up, extra) {
  return Object.assign({
    id: id,
    priority: priority,
    ip: ip,
    up: (up === undefined) ? true : up
  }, extra || {});
}

// A healthy group spec, with virtual IP 10.0.0.1 held by the owner.
function group(spec) {
  return Object.assign({
    vrid: 42,
    priority: 150,
    preempt: true,
    advertSec: 1,
    ips: ['10.0.0.1'],
    interfaceName: 'Gi0/1'
  }, spec || {});
}

function codes(result) {
  return result.errors.map(function (e) { return e.code; });
}

function hasCode(result, code) {
  return codes(result).indexOf(code) !== -1;
}

function ids(list) { return list.join(','); }

// ---------------------------------------------------------------------------
console.log('constants');
{
  ok(VRRP_PROTOCOL === 112, 'VRRP_PROTOCOL is 112');
  ok(VRRP_DEFAULT_PRIORITY === 100, 'VRRP_DEFAULT_PRIORITY is 100');
  ok(VRRP_OWNER_PRIORITY === 255, 'VRRP_OWNER_PRIORITY is 255');
  ok(VRRP_DEFAULT_ADVERT_SEC === 1, 'VRRP_DEFAULT_ADVERT_SEC is 1');
}

// ---------------------------------------------------------------------------
console.log('\nvirtualMac');
{
  ok(virtualMac(1) === '00:00:5e:00:01:01', 'VRID 1 -> 00:00:5e:00:01:01');
  ok(virtualMac(16) === '00:00:5e:00:01:10', 'VRID 16 -> 00:00:5e:00:01:10 (zero padded)');
  ok(virtualMac(42) === '00:00:5e:00:01:2a', 'VRID 42 -> 00:00:5e:00:01:2a (lowercase hex)');
  ok(virtualMac(255) === '00:00:5e:00:01:ff', 'VRID 255 -> 00:00:5e:00:01:ff');
  ok(virtualMac('7') === '00:00:5e:00:01:07', 'a numeric string VRID is accepted');
  ok(virtualMac(256) === null && virtualMac(-1) === null && virtualMac('x') === null,
    'out-of-range or non-numeric VRIDs return null');

  ok(virtualMacMatches('00:00:5e:00:01:2a', 42) === true, 'matches its own virtual MAC');
  ok(virtualMacMatches('00:00:5E:00:01:2A', 42) === true, 'matching is case insensitive');
  ok(virtualMacMatches('00-00-5e-00-01-2a', 42) === true, 'dash-separated MACs match too');
  ok(virtualMacMatches('00:00:5e:00:01:2b', 42) === false, 'a different VRID does not match');
  ok(virtualMacMatches('00:00:0c:07:ac:01', 42) === false, 'an HSRP-style MAC does not match');
  ok(virtualMacMatches('nonsense', 42) === false, 'a malformed MAC does not match');
}

// ---------------------------------------------------------------------------
console.log('\nvalidateGroup');
{
  const good = validateGroup(group());
  ok(good.ok === true && good.errors.length === 0, 'a well-formed group validates');

  ok(hasCode(validateGroup(group({ vrid: 0 })), 'E_VRID_RANGE'), 'VRID 0 is out of range');
  ok(hasCode(validateGroup(group({ vrid: 256 })), 'E_VRID_RANGE'), 'VRID 256 is out of range');
  ok(hasCode(validateGroup(group({ vrid: 'abc' })), 'E_VRID_RANGE'), 'a non-numeric VRID is rejected');

  const dup = validateGroup(group({ ips: ['10.0.0.1', '10.0.0.2', '10.0.0.1'] }));
  ok(dup.ok === false && hasCode(dup, 'E_DUPLICATE_IP'), 'duplicate virtual IPs are rejected');
  ok(dup.errors.length === 1, 'the duplicate is reported exactly once');

  ok(hasCode(validateGroup(group({ ips: ['10.0.0.300'] })), 'E_IP_INVALID'),
    'an out-of-range octet is not a valid IP');
  ok(hasCode(validateGroup(group({ ips: [] })), 'E_NO_VIRTUAL_IP'),
    'a group with no virtual IP is rejected');

  ok(hasCode(validateGroup(group({ priority: 300 })), 'E_PRIORITY_RANGE'), 'priority 300 is out of range');
  ok(hasCode(validateGroup(group({ priority: -1 })), 'E_PRIORITY_RANGE'), 'a negative priority is rejected');
  ok(validateGroup(group({ priority: 0 })).ok === true, 'priority 0 is legal (master relinquished)');
  ok(validateGroup(group({ priority: 255 })).ok === true, 'priority 255 is legal');

  ok(hasCode(validateGroup(group({ advertSec: 0 })), 'E_ADVERT_RANGE'), 'a zero advertisement interval is rejected');
  ok(hasCode(validateGroup(group({ advertCs: -25 })), 'E_ADVERT_RANGE'), 'a negative advertCs is rejected');
  ok(validateGroup(group({ advertCs: 25 })).ok === true, 'advertCs 25 is legal');

  ok(hasCode(validateGroup(group({ preempt: 'maybe' })), 'E_PREEMPT_BOOL'), 'a non-boolean preempt is rejected');
  ok(hasCode(validateGroup(group({ authText: 'longsecret1' })), 'E_AUTH_LENGTH'),
    'authText longer than 8 characters is rejected');
  ok(validateGroup(group({ authText: 'secret12' })).ok === true, 'an 8-character authText is legal');

  const many = validateGroup({ vrid: 900, priority: 900, ips: ['nope'], advertSec: -1 });
  ok(many.ok === false && many.errors.length === 4, 'independent problems are all reported (4 errors)');
  ok(many.errors.every(function (e) {
    return typeof e.code === 'string' && typeof e.message === 'string' && e.message.length > 0;
  }), 'every error carries a code and a message');
}

// ---------------------------------------------------------------------------
console.log('\nnormalizeGroup');
{
  const d = normalizeGroup({});
  ok(d.vrid === 1 && d.priority === 100 && d.preempt === true && d.advertSec === 1,
    'defaults are vrid 1 / priority 100 / preempt true / 1s adverts');
  ok(Array.isArray(d.ips) && d.ips.length === 0, 'ips defaults to an empty array');
  ok(d.authText === '' && d.interfaceName === 'eth0', 'authText and interfaceName get defaults');

  const c = normalizeGroup({ vrid: '42', priority: '150', advertCs: 50, ips: ['10.0.0.1', '10.0.0.1'] });
  ok(c.vrid === 42 && c.priority === 150, 'numeric strings are coerced to numbers');
  ok(c.advertSec === 0.5, 'advertCs 50 normalises to 0.5s');
  ok(c.ips.length === 1 && c.ips[0] === '10.0.0.1', 'duplicate IPs are collapsed');

  const clamped = normalizeGroup({ vrid: 9999, priority: -40, authText: 'toolongsecret' });
  ok(clamped.vrid === 255, 'an out-of-range VRID is clamped to 255');
  ok(clamped.priority === 0, 'a negative priority is clamped to 0');
  ok(clamped.authText === 'toolongs' && clamped.authText.length === 8, 'authText is truncated to 8 characters');
  ok(normalizeGroup({ preempt: 'false' }).preempt === false, "the string 'false' normalises to false");
}

// ---------------------------------------------------------------------------
console.log('\nelectMaster');
{
  // The owner wins even though another router is configured higher.
  const owner = electMaster([
    router('r1', 150, '10.0.0.1'),
    router('r2', 200, '10.0.0.2')
  ], group());
  ok(owner.masterId === 'r1', 'the address owner wins over a higher configured priority');
  ok(owner.reason === 'owner', 'the reason is owner');
  ok(ids(owner.backups) === 'r2', 'the other router is the backup');

  // Highest non-owner priority wins.
  const pri = electMaster([
    router('r1', 100, '10.0.0.2'),
    router('r2', 150, '10.0.0.3'),
    router('r3', 120, '10.0.0.4')
  ], group());
  ok(pri.masterId === 'r2', 'the highest non-owner priority wins');
  ok(ids(pri.backups) === 'r3,r1', 'backups are ordered by descending priority');
  ok(pri.reason === 'priority', 'the reason is priority');

  // A tie is broken by the higher numeric IP, not the lower.
  const tie = electMaster([
    router('low', 150, '10.0.0.2'),
    router('high', 150, '10.0.0.9')
  ], group());
  ok(tie.masterId === 'high', 'a priority tie goes to the higher IPv4 address');
  ok(tie.reason === 'tiebreak-ip', 'the reason is tiebreak-ip');
  ok(electMaster([router('x', 150, '10.0.0.9'), router('y', 150, '10.0.0.2')], group()).masterId === 'x',
    'input order does not change the outcome');

  // Priority 0 does not participate at all -- it is not a backup either.
  const zero = electMaster([
    router('r1', 0, '10.0.0.5'),
    router('r2', 50, '10.0.0.6')
  ], group());
  ok(zero.masterId === 'r2', 'a priority-0 router never becomes master');
  ok(zero.backups.length === 0, 'a priority-0 router is not listed as a backup');

  // Down routers are excluded.
  const down = electMaster([
    router('r1', 200, '10.0.0.2', false),
    router('r2', 90, '10.0.0.3')
  ], group());
  ok(down.masterId === 'r2', 'a down router is excluded from the election');
  ok(down.backups.length === 0, 'a down router is not listed as a backup');

  // Nothing eligible at all.
  const none = electMaster([router('r1', 0, '10.0.0.5'), router('r2', 100, '10.0.0.6', false)], group());
  ok(none.masterId === null && none.backups.length === 0, 'no eligible router yields a null master');
  ok(none.reason === 'no-candidates', 'the reason is no-candidates');

  const single = electMaster([router('r1', 120, '10.0.0.4')], group());
  ok(single.masterId === 'r1' && single.reason === 'only-candidate', 'a lone router wins unopposed');

  // Owner detection also works from a bare ips array and from the router's own
  // virtualIps list.
  ok(electMaster([router('o', 1, '10.5.5.5'), router('p', 200, '10.0.0.2')], ['10.5.5.5']).masterId === 'o',
    'owner detection accepts a bare ips array');
  ok(electMaster([
    router('o', 1, '10.9.9.9', true, { virtualIps: ['10.9.9.9'] }),
    router('p', 200, '10.0.0.2')
  ], group()).masterId === 'o', 'owner detection reads the router virtualIps list');
}

// ---------------------------------------------------------------------------
console.log('\ngroupState (preempt)');
{
  const routers = function () {
    return [
      router('r1', 200, '10.0.0.2'), // just came back
      router('r2', 150, '10.0.0.3')  // currently master
    ];
  };

  const pre = groupState(routers(), { preempt: true, currentMaster: 'r2', group: group() });
  ok(pre.masterId === 'r1', 'with preempt the higher-priority router takes over');
  ok(pre.changed === true && pre.reason === 'preempt', 'the transition is reported as preempt');
  ok(pre.previousMasterId === 'r2' && ids(pre.backups) === 'r2', 'the old master becomes the only backup');

  const nopre = groupState(routers(), { preempt: false, currentMaster: 'r2', group: group() });
  ok(nopre.masterId === 'r2', 'without preempt the live master keeps the role');
  ok(nopre.changed === false && nopre.reason === 'incumbent-keeps', 'the transition is reported as incumbent-keeps');
  ok(ids(nopre.backups) === 'r1', 'the returning router is held as a backup');

  const stable = groupState(routers(), { preempt: true, currentMaster: 'r1', group: group() });
  ok(stable.masterId === 'r1' && stable.changed === false && stable.reason === 'unchanged',
    'a master that is still the best stays put');

  const deadIncumbent = groupState([
    router('r1', 200, '10.0.0.2'),
    router('r2', 150, '10.0.0.3', false)
  ], { preempt: false, currentMaster: 'r2', group: group() });
  ok(deadIncumbent.masterId === 'r1' && deadIncumbent.changed === true,
    'a dead master is replaced even without preempt');
  ok(deadIncumbent.reason === 'failover', 'the transition is reported as failover');

  const first = groupState(routers(), { group: group() });
  ok(first.masterId === 'r1' && first.reason === 'initial', 'no incumbent means an initial election');

  // The owner preempts a higher-priority non-owner: 255 implied beats 200.
  const ownerBack = groupState([
    router('r1', 100, '10.0.0.1'),
    router('r2', 200, '10.0.0.3')
  ], { preempt: true, currentMaster: 'r2', group: group() });
  ok(ownerBack.masterId === 'r1', 'the owner reclaims mastership when it comes back up');
  ok(groupState([router('r1', 0, '10.0.0.2'), router('r2', 150, '10.0.0.3', false)],
    { preempt: true, currentMaster: 'r2', group: group() }).masterId === null,
  'no eligible router leaves the group without a master');
}

// ---------------------------------------------------------------------------
console.log('\ntimers');
{
  ok(advertInterval({}) === 1, 'the advertisement interval defaults to 1s');
  ok(advertInterval({ advertCs: 25 }) === 0.25, 'advertCs 25 is 0.25s');
  ok(advertInterval({ advertCs: 100 }) === 1, 'advertCs 100 is 1s');
  ok(advertInterval({ advertSec: 3 }) === 3, 'advertSec is used when there are no centiseconds');
  ok(advertInterval({ advertCs: 50, advertSec: 9 }) === 0.5, 'advertCs wins over advertSec');

  ok(skewTime({ priority: 100 }) === 0.609375, 'skew time at priority 100 is 0.609375s');
  ok(skewTime({ priority: 255 }) === 0.00390625, 'skew time at the owner priority is 0.00390625s');
  ok(skewTime({}) === 0.609375, 'skew time falls back to the default priority');

  ok(masterDownInterval({ advertSec: 1, priority: 100 }) === 3.609375,
    'master-down is 3 * 1s + 0.609375s = 3.609375s');
  ok(masterDownInterval({ advertCs: 50, priority: 100 }) === 2.109375,
    'master-down is 3 * 0.5s + 0.609375s = 2.109375s');
  ok(masterDownInterval({ advertSec: 1, priority: 255 }) === 3.00390625,
    'an owner waits barely longer than three advertisements');
  ok(masterDownInterval({ advertSec: 1, priority: 150 }, 0.5) === 3.5,
    'an explicit skew time overrides the priority-derived one');
  ok(masterDownInterval(group({ priority: 100 })) === 3.609375,
    'master-down works straight off a group spec');
  ok(masterDownInterval({ advertCs: 29, priority: 100 }) === 1.479375,
    'centisecond intervals do not leak float noise into the timer (3 * 0.29 + 0.609375)');
  ok(advertInterval(normalizeGroup({ advertCs: 25 })) === 0.25,
    'a normalised group keeps its centisecond advert interval');
}

// ---------------------------------------------------------------------------
console.log('\ndeterminism');
{
  const routers = [
    router('a', 150, '10.0.0.2'),
    router('b', 150, '10.0.0.9'),
    router('c', 150, '10.0.0.9')
  ];
  const first = electMaster(routers, group());
  const again = electMaster(routers.slice().reverse(), group());
  ok(first.masterId === again.masterId, 'the winner does not depend on input order');
  ok(ids(first.backups) === ids(again.backups), 'the backup list does not depend on input order');
  ok(electMaster(routers, group()).masterId === 'b', 'a full tie falls back to the lowest id');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
