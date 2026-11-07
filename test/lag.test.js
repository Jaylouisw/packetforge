'use strict';
// lag.test.js -- LACP/LAG hashing, member selection and validation.
const lag = require('../engine/lag');

const LAG_MODES = lag.LAG_MODES;
const HASH_POLICIES = lag.HASH_POLICIES;
const normalizeLag = lag.normalizeLag;
const hashFrame = lag.hashFrame;
const selectMember = lag.selectMember;
const validateLag = lag.validateLag;

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg); }
}
function codes(list) { return (list || []).map(function (e) { return e.code; }); }
function hasCode(list, code) { return codes(list).indexOf(code) !== -1; }

// ---------------------------------------------------------------------------
console.log('constants');
ok(Array.isArray(LAG_MODES) && LAG_MODES.length === 3, 'LAG_MODES has 3 modes');
ok(LAG_MODES.join(',') === 'lacp-active,lacp-passive,static', 'LAG_MODES contents');
ok(HASH_POLICIES.join(',') === 'l2,l3,l3l4', 'HASH_POLICIES contents');

// ---------------------------------------------------------------------------
console.log('\nnormalizeLag');
{
  const d = normalizeLag();
  ok(d.mode === 'lacp-active', 'default mode is lacp-active');
  ok(d.hashPolicy === 'l3l4', 'default hash policy is l3l4');
  ok(Array.isArray(d.members) && d.members.length === 0, 'default members is empty');
  ok(typeof d.id === 'string' && d.id.length > 0, 'default id is a non-empty string');
  ok(d.minLinks === 2, 'default minLinks is 2');

  const n = normalizeLag({ id: ' po1 ', mode: 'STATIC', hashPolicy: 'L2', members: ['Gi0/1', { name: 'Gi0/2' }, '', null], minLinks: 1 });
  ok(n.id === 'po1', 'id is trimmed');
  ok(n.mode === 'static', 'mode is lower-cased');
  ok(n.hashPolicy === 'l2', 'hashPolicy is lower-cased');
  ok(n.members.length === 2 && n.members[0] === 'Gi0/1' && n.members[1] === 'Gi0/2', 'members normalised from strings and objects');
  ok(n.minLinks === 1, 'explicit minLinks kept');

  const dup = normalizeLag({ members: ['Gi0/1', 'Gi0/1'] });
  ok(dup.members.length === 2, 'duplicates survive normalisation (validation reports them)');

  const bad = normalizeLag({ mode: 'trunk-mode' });
  ok(bad.mode === 'trunk-mode', 'unknown mode is preserved so validation can flag it');
}

// ---------------------------------------------------------------------------
console.log('\nhashFrame');
{
  const f = { srcMac: 'aa:bb:cc:00:00:01', dstMac: 'aa:bb:cc:00:00:02', srcIp: '10.0.0.1', dstIp: '10.0.0.2', srcPort: 1234, dstPort: 80 };

  ok(hashFrame(f, 'l2') === hashFrame(f, 'l2'), 'l2 hash is deterministic across calls');
  ok(hashFrame(f, 'l3') === hashFrame(f, 'l3'), 'l3 hash is deterministic across calls');
  ok(hashFrame(f, 'l3l4') === hashFrame(f, 'l3l4'), 'l3l4 hash is deterministic across calls');

  let inRange = true;
  const frames = [f, {}, { srcMac: 'x' }, { srcIp: '2001:db8::1', dstIp: '2001:db8::2', srcPort: 1, dstPort: 65535 }];
  for (let i = 0; i < 500; i++) {
    const g = { srcMac: 'aa:bb:cc:00:00:' + (i % 256), dstIp: '10.0.' + (i % 256) + '.1', srcPort: i, dstPort: (i * 7) % 1000 };
    frames.push(g);
  }
  for (const fr of frames) {
    for (const pol of HASH_POLICIES) {
      const h = hashFrame(fr, pol);
      if (!(typeof h === 'number' && Number.isFinite(h) && h >= 0 && h < 1)) inRange = false;
    }
  }
  ok(inRange, 'every hash lands in [0,1) for all policies (500+ frames)');

  ok(hashFrame({}, 'l2') === hashFrame({}, 'l2'), 'empty frame hashes deterministically');
  ok(hashFrame(f, 'nonsense') === hashFrame(f, 'l3l4'), 'unknown policy falls back to l3l4');

  const macA = { srcMac: 'aa:bb:cc:00:00:01', dstMac: 'aa:bb:cc:00:00:02' };
  const macB = { srcMac: 'AA-BB-CC-00-00-01', dstMac: 'aabb.cc00.0002' };
  ok(hashFrame(macA, 'l2') === hashFrame(macB, 'l2'), 'l2 hash is MAC-format insensitive');

  const l2a = { srcMac: 'aa:bb:cc:00:00:01', dstMac: 'aa:bb:cc:00:00:02', srcIp: '10.0.0.1', dstIp: '10.0.0.2' };
  const l2b = { srcMac: 'aa:bb:cc:00:00:01', dstMac: 'aa:bb:cc:00:00:02', srcIp: '192.168.9.9', dstIp: '172.16.0.1' };
  ok(hashFrame(l2a, 'l2') === hashFrame(l2b, 'l2'), 'l2 ignores L3 fields');
  ok(hashFrame(l2a, 'l3') !== hashFrame(l2b, 'l3'), 'l3 distinguishes different IPs');
  ok(hashFrame(l2a, 'l3') === hashFrame({ srcIp: '10.0.0.1', dstIp: '10.0.0.2' }, 'l3'), 'l3 ignores L2/MAC fields');

  const p1 = { srcIp: '10.0.0.1', dstIp: '10.0.0.2', srcPort: 1234, dstPort: 80 };
  const p2 = { srcIp: '10.0.0.1', dstIp: '10.0.0.2', srcPort: 1234, dstPort: 443 };
  ok(hashFrame(p1, 'l3') === hashFrame(p2, 'l3'), 'l3 ignores L4 ports');
  ok(hashFrame(p1, 'l3l4') !== hashFrame(p2, 'l3l4'), 'l3l4 distinguishes different L4 ports');
  ok(hashFrame(p1, 'l3l4') === hashFrame({ srcIp: '10.0.0.1', dstIp: '10.0.0.2', srcPort: '1234', dstPort: '080' }, 'l3l4'),
    'l3l4 port fields are string/number insensitive');
  ok(hashFrame(l2a, 'l2') !== hashFrame(l2a, 'l3') || hashFrame(l2a, 'l3') !== hashFrame(l2a, 'l3l4'),
    'different policies produce different hashes for the same frame');
}

// ---------------------------------------------------------------------------
console.log('\nselectMember');
{
  const members = ['Gi0/1', 'Gi0/2', 'Gi0/3', 'Gi0/4'];
  const frame = { srcMac: 'aa:bb:cc:00:00:01', dstMac: 'aa:bb:cc:00:00:02', srcIp: '10.0.0.1', dstIp: '10.0.0.2', srcPort: 1234, dstPort: 80 };

  const first = selectMember(members, frame, 'l3l4');
  let stable = true;
  for (let i = 0; i < 50; i++) if (selectMember(members, frame, 'l3l4') !== first) stable = false;
  ok(stable, 'selectMember is stable across repeated calls');
  ok(members.indexOf(first) !== -1, 'selectMember returns one of the supplied members');

  const shuffled = ['Gi0/4', 'Gi0/2', 'Gi0/1', 'Gi0/3'];
  ok(selectMember(shuffled, frame, 'l3l4') === first, 'selectMember is order-independent (sorted before indexing)');
  const reversed = ['Gi0/4', 'Gi0/3', 'Gi0/2', 'Gi0/1'];
  ok(selectMember(reversed, frame, 'l3l4') === first, 'selectMember is order-independent for a reversed list');

  ok(selectMember([], frame, 'l2') === null, 'empty member list returns null');
  ok(selectMember(null, frame, 'l2') === null, 'null member list returns null');

  const disabled = [
    { name: 'Gi0/1', enabled: false },
    { name: 'Gi0/2', enabled: true }
  ];
  ok(selectMember(disabled, frame, 'l3l4') === 'Gi0/2', 'disabled members are skipped');
  ok(selectMember([{ name: 'Gi0/1', enabled: false }, { name: 'Gi0/2', enabled: false }], frame, 'l3l4') === null,
    'all members disabled returns null');
  ok(selectMember(['Gi0/1', 'Gi0/1', 'Gi0/2'], frame, 'l2') !== null, 'duplicate names do not break selection');

  const used = new Set();
  for (let i = 0; i < 1000; i++) {
    const f = { srcIp: '10.0.' + (i % 251) + '.1', dstIp: '10.1.' + (i % 241) + '.2', srcPort: 1024 + i, dstPort: 80 };
    used.add(selectMember(members, f, 'l3l4'));
  }
  ok(used.size === 4, 'all 4 members are used across 1000 distinct flows');

  const l2 = selectMember(members, { srcMac: 'aa:bb:cc:00:00:01', dstMac: 'aa:bb:cc:00:00:02' }, 'l2');
  ok(l2 === selectMember(members, { srcMac: 'aabb.cc00.0001', dstMac: 'AA:BB:CC:00:00:02' }, 'l2'),
    'selection is format-insensitive for the same flow');
}

// ---------------------------------------------------------------------------
console.log('\nvalidateLag');
{
  const goodPorts = [
    { name: 'Gi0/1', speedMbps: 1000, duplex: 'full', vlanCompatible: true, enabled: true },
    { name: 'Gi0/2', speedMbps: 1000, duplex: 'full', vlanCompatible: true, enabled: true }
  ];
  const good = validateLag({ id: 'po1', mode: 'lacp-active', members: ['Gi0/1', 'Gi0/2'] }, goodPorts);
  ok(good.ok === true, 'healthy 2-member bundle validates');
  ok(good.errors.length === 0, 'no errors on a healthy bundle');
  ok(good.warnings.length === 0, 'no warnings on a healthy bundle');

  const tooFew = validateLag({ members: ['Gi0/1'] }, goodPorts);
  ok(tooFew.ok === false && hasCode(tooFew.errors, 'E_LAG_TOO_FEW'), 'single member -> E_LAG_TOO_FEW');

  const noMembers = validateLag({ members: [] }, goodPorts);
  ok(noMembers.ok === false && hasCode(noMembers.errors, 'E_LAG_TOO_FEW'), 'empty member list -> E_LAG_TOO_FEW');

  const speed = validateLag({ members: ['Gi0/1', 'Gi0/2'] }, [
    { name: 'Gi0/1', speedMbps: 1000, duplex: 'full', vlanCompatible: true, enabled: true },
    { name: 'Gi0/2', speedMbps: 10000, duplex: 'full', vlanCompatible: true, enabled: true }
  ]);
  ok(speed.ok === false && hasCode(speed.errors, 'E_LAG_SPEED_MISMATCH'), 'mixed speeds -> E_LAG_SPEED_MISMATCH');

  const duplex = validateLag({ members: ['Gi0/1', 'Gi0/2'] }, [
    { name: 'Gi0/1', speedMbps: 1000, duplex: 'full', vlanCompatible: true, enabled: true },
    { name: 'Gi0/2', speedMbps: 1000, duplex: 'half', vlanCompatible: true, enabled: true }
  ]);
  ok(duplex.ok === false && hasCode(duplex.errors, 'E_LAG_DUPLEX_MISMATCH'), 'mixed duplex -> E_LAG_DUPLEX_MISMATCH');

  const vlan = validateLag({ members: ['Gi0/1', 'Gi0/2'] }, [
    { name: 'Gi0/1', speedMbps: 1000, duplex: 'full', vlanCompatible: true, enabled: true },
    { name: 'Gi0/2', speedMbps: 1000, duplex: 'full', vlanCompatible: false, enabled: true }
  ]);
  ok(vlan.ok === false && hasCode(vlan.errors, 'E_LAG_VLAN_MISMATCH'), 'VLAN-incompatible member -> E_LAG_VLAN_MISMATCH');

  const dup = validateLag({ members: ['Gi0/1', 'Gi0/1'] }, goodPorts);
  ok(dup.ok === false && hasCode(dup.errors, 'E_LAG_DUPLICATE_MEMBER'), 'repeated member -> E_LAG_DUPLICATE_MEMBER');

  const badMode = validateLag({ mode: 'pagp-desirable', members: ['Gi0/1', 'Gi0/2'] }, goodPorts);
  ok(badMode.ok === false && hasCode(badMode.errors, 'E_LAG_BAD_MODE'), 'unknown mode -> E_LAG_BAD_MODE');
  ok(validateLag({ mode: 'static', members: ['Gi0/1', 'Gi0/2'] }, goodPorts).ok === true, 'static mode is accepted');
  ok(validateLag({ mode: 'lacp-passive', members: ['Gi0/1', 'Gi0/2'] }, goodPorts).ok === true, 'lacp-passive is accepted');

  const disabled = validateLag({ members: ['Gi0/1', 'Gi0/2'] }, [
    { name: 'Gi0/1', speedMbps: 1000, duplex: 'full', vlanCompatible: true, enabled: false },
    { name: 'Gi0/2', speedMbps: 1000, duplex: 'full', vlanCompatible: true, enabled: true }
  ]);
  ok(disabled.ok === true, 'a disabled member is not a hard error');
  ok(hasCode(disabled.warnings, 'W_LAG_DISABLED_MEMBER'), 'disabled member -> W_LAG_DISABLED_MEMBER warning');

  const messy = validateLag({ mode: 'bogus', members: ['Gi0/1', 'Gi0/1', 'Gi0/2'] }, [
    { name: 'Gi0/1', speedMbps: 1000, duplex: 'full', vlanCompatible: true, enabled: true },
    { name: 'Gi0/2', speedMbps: 100, duplex: 'half', vlanCompatible: false, enabled: false }
  ]);
  ok(messy.ok === false, 'a badly formed bundle fails');
  ok(messy.errors.length >= 5, 'all independent problems are reported together (' + messy.errors.length + ' errors)');
  ok(messy.errors.every(function (e) { return typeof e.code === 'string' && typeof e.message === 'string' && e.message.length > 0; }),
    'every error carries a code and a message');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
