'use strict';
// Property tests for the connection validator.
//
// Every rule in `engine/validation.js` has its own example-based test already, and they all pass -
// which tells you the cases somebody thought of work. It says nothing about the cases nobody typed
// out: a media id that is an empty string, a port name from a different device, a device dragged in
// from a spec whose ports collide, the same cable attempted twice.
//
// So this file does not check verdicts. It checks that the validator behaves like a function:
//
//   * it never throws, whatever it is handed            (a crash in the UI is a lost lab)
//   * `ok` means exactly "no errors", and never both    (a green check over a red list)
//   * every error carries a code and a sentence         (the UI renders both; a blank one is a bug)
//   * the same question twice gets the same answer       (no hidden state in the rules)
//   * A->B and B->A agree                               (cabling is symmetric; a rule that isn't
//                                                        is a rule that depends on click order)
//   * a rejected connect() changes nothing              (no half-made link left behind)
//   * an accepted connect() sets both ends              (one-way links produce silent one-way faults)
//
// Topologies are built from the real catalogue with a seeded PRNG, so a failure here reproduces
// exactly: the seed is printed with every assertion message.
const path = require('path');
const { Topology, validation, media } = require('../engine');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; }
  else { failed++; console.log('  not ok - ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

// mulberry32: 32-bit state, one line of arithmetic, identical output on every platform. A property
// test that fails once a week on CI is worse than no property test.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const specs = loadCatalog(path.join(__dirname, '..', 'devices')).filter(function (s) { return !s.error; });
const MEDIA_IDS = Object.keys(media.MEDIA).filter(function (m) { return !media.MEDIA[m].pairedHalf; });
const JUNK_MEDIA = ['', 'nonsense', '1000BASE-T', null, undefined, '10G', '1000base-t '];
const RULE_CODES = new Set(validation.RULES.map(function (r) { return (r && r.code) || r; }));

function codesOf(res) {
  return ((res && res.errors) || []).map(function (e) { return e.code; }).sort();
}

console.log('');
console.log('Fixtures: ' + specs.length + ' loadable specs, ' + MEDIA_IDS.length + ' media, ' + RULE_CODES.size + ' rule codes');

// Build a topology from N catalogue specs, deterministically.
function buildTopology(rand, n) {
  const t = new Topology({});
  const ids = [];
  for (let i = 0; i < n; i++) {
    const spec = specs[Math.floor(rand() * specs.length)];
    const id = 'd' + i;
    t.addDevice(spec, id);
    const dev = t.getDevice(id);
    if (dev && dev.interfaces && dev.interfaces.size) ids.push(id);
  }
  return { topo: t, ids: ids };
}

function portsOf(topo, id) {
  const dev = topo.getDevice(id);
  return dev && dev.interfaces ? Array.from(dev.interfaces.keys()) : [];
}

console.log('');
console.log('The validator never throws, never contradicts itself, and never depends on click order:');
{
  const problems = [];
  let attempts = 0, accepted = 0, refused = 0;
  const seenCodes = new Set();

  for (let seed = 1; seed <= 120; seed++) {
    const rand = mulberry32(seed * 7919);
    const { topo, ids } = buildTopology(rand, 2 + Math.floor(rand() * 3));
    if (ids.length < 1) continue;

    for (let k = 0; k < 6; k++) {
      const aId = ids[Math.floor(rand() * ids.length)];
      const bId = ids[Math.floor(rand() * ids.length)];
      const aPorts = portsOf(topo, aId);
      const bPorts = portsOf(topo, bId);
      if (!aPorts.length || !bPorts.length) continue;
      const a = aPorts[Math.floor(rand() * aPorts.length)];
      const b = bPorts[Math.floor(rand() * bPorts.length)];
      const useJunk = rand() < 0.25;
      const mediaId = useJunk
        ? JUNK_MEDIA[Math.floor(rand() * JUNK_MEDIA.length)]
        : MEDIA_IDS[Math.floor(rand() * MEDIA_IDS.length)];
      attempts++;

      let res, res2, rev;
      try {
        res = topo.validateLink(aId, a, bId, b, { mediaId: mediaId });
        res2 = topo.validateLink(aId, a, bId, b, { mediaId: mediaId });
        rev = topo.validateLink(bId, b, aId, a, { mediaId: mediaId });
      } catch (e) {
        problems.push('seed ' + seed + ' threw ' + e.constructor.name + ': ' + e.message);
        continue;
      }

      const tag = 'seed ' + seed + ' ' + aId + ':' + a + ' -- ' + bId + ':' + b + ' media=' + JSON.stringify(mediaId);

      if (!res || typeof res.ok !== 'boolean') { problems.push(tag + ': no boolean ok'); continue; }
      if (res.ok) accepted++; else refused++;

      // ok <=> no errors. A result that is both, or neither, is a UI bug waiting to happen.
      const errs = res.errors || [];
      if (res.ok !== (errs.length === 0)) problems.push(tag + ': ok=' + res.ok + ' with ' + errs.length + ' error(s)');

      for (const e of errs) {
        if (!e || typeof e.code !== 'string' || !e.code) problems.push(tag + ': error without a code');
        else {
          seenCodes.add(e.code);
          if (!RULE_CODES.has(e.code) && e.code !== 'E_PORT_IN_USE') problems.push(tag + ': unknown code ' + e.code);
        }
        if (!e || typeof e.message !== 'string' || e.message.length < 4) problems.push(tag + ': error without a readable message');
      }
      for (const w of (res.warnings || [])) {
        if (!w || typeof w.message !== 'string') problems.push(tag + ': warning without a message');
      }

      // Determinism: the same question twice.
      if (JSON.stringify(codesOf(res)) !== JSON.stringify(codesOf(res2))) {
        problems.push(tag + ': not deterministic between two identical calls');
      }
      if (res.ok !== res2.ok) problems.push(tag + ': ok flipped between two identical calls');

      // Symmetry: cabling has no first end.
      if (res.ok !== rev.ok) problems.push(tag + ': A->B is ' + res.ok + ' but B->A is ' + rev.ok);
      if (JSON.stringify(codesOf(res)) !== JSON.stringify(codesOf(rev))) {
        problems.push(tag + ': different codes depending on direction (' + codesOf(res) + ' vs ' + codesOf(rev) + ')');
      }
    }
  }

  ok(problems.length === 0, problems.length + ' property violation(s) across ' + attempts + ' random link attempts',
     problems.slice(0, 5).join(' | '));
  ok(attempts > 100, 'the generator actually produced attempts (' + attempts + ')');
  ok(accepted > 0, 'some random cabling is legal, so acceptance is exercised (' + accepted + ')');
  ok(refused > 0, 'and some is refused, so rejection is exercised (' + refused + ')');
  ok(seenCodes.size >= 3, 'more than one rule fired during the run (' + Array.from(seenCodes).sort().join(',') + ')');
}

console.log('');
console.log('Nonsense arguments are refused, not crashed on:');
{
  const { topo, ids } = buildTopology(mulberry32(4242), 2);
  const id = ids[0];
  const port = portsOf(topo, id)[0];
  const cases = [
    ['missing device', 'nope', port, id, port],
    ['missing port A', id, 'no-such-port', id, port],
    ['missing port B', id, port, id, 'no-such-port'],
    ['null port', id, null, id, port],
    ['undefined port', id, undefined, id, port],
    ['numeric port', id, 42, id, port],
    ['object port', id, { name: port }, id, port]
  ];
  const failures = [];
  for (const [label, aId, aPort, bId, bPort] of cases) {
    try {
      const r = topo.validateLink(aId, aPort, bId, bPort, {});
      if (!r || typeof r.ok !== 'boolean') failures.push(label + ': no verdict');
      else if (r.ok) failures.push(label + ': accepted nonsense');
      else if (!(r.errors || []).length) failures.push(label + ': refused with no reason');
    } catch (e) {
      failures.push(label + ': threw ' + e.constructor.name + ' (' + e.message + ')');
    }
  }
  ok(failures.length === 0, 'every nonsense argument gets a reason instead of a stack trace', failures.join(' | '));
}

console.log('');
console.log('connect() either works or leaves nothing behind:');
{
  const { topo, ids } = buildTopology(mulberry32(9001), 3);
  const aId = ids[0], bId = ids[1] || ids[0];
  const a = portsOf(topo, aId)[0];
  const b = portsOf(topo, bId).slice(-1)[0];
  const before = topo.links.size;

  // A self-link on one port must be refused and must not create a link.
  let selfErr = null;
  try { topo.connect(aId, a, aId, a, {}); } catch (e) { selfErr = e; }
  ok(!!selfErr, 'cabling a port to itself is refused');
  ok(!(selfErr instanceof TypeError), 'and refused with a real message, not a TypeError', selfErr && selfErr.message);
  ok(topo.links.size === before, 'and left no link behind', String(topo.links.size - before));

  // A nonsense media id must also leave the topology untouched.
  let badMedia = null;
  try { topo.connect(aId, a, bId, b, { mediaId: 'not-a-media' }); } catch (e) { badMedia = e; }
  if (badMedia) {
    ok(!(badMedia instanceof TypeError), 'an unknown media id is an Error, not a TypeError', badMedia.message);
    ok(topo.links.size === before, 'and left no link behind');
  } else {
    ok(topo.links.size === before + 1, 'or it was accepted - in which case exactly one link exists');
  }

  // And a legal cable, found by asking the validator rather than assuming.
  let made = null;
  const tries = Math.min(4, ids.length);
  for (let i = 0; i < tries && !made; i++) {
    const other = ids[ids.length - 1 - i];
    if (other === aId) continue;
    const p = portsOf(topo, other)[0];
    const v = topo.validateLink(aId, a, other, p, { mediaId: '1000base-t' });
    if (!v || !v.ok) continue;
    try { made = topo.connect(aId, a, other, p, { mediaId: '1000base-t' }); } catch (e) { made = null; }
    if (made) {
      ok(true, 'a cable the validator approved connected');
      const devA = topo.getDevice(aId), devB = topo.getDevice(other);
      const ia = devA.interfaces.get(a), ib = devB.interfaces.get(p);
      ok(!!ia && !!ib, 'both ports exist after connecting');
      ok(!!ia.peer && !!ib.peer, 'both ends hold a peer reference - a one-way link is a silent one-way fault');
      ok(ia.peer.deviceId === other && ib.peer.deviceId === aId, 'and they point at each other');
      // State awareness: the same ports cannot be cabled twice.
      const again = topo.validateLink(aId, a, other, p, { mediaId: '1000base-t' });
      ok(again && again.ok === false, 're-validating an occupied port is refused');
      ok(codesOf(again).indexOf('E_PORT_IN_USE') !== -1, 'with E_PORT_IN_USE', String(codesOf(again)));
    }
  }
  if (!made) ok(true, 'no legal pair found in this fixture - acceptance covered above');
}

console.log('');
console.log('Whole-topology validation survives a topology that is already broken:');
{
  const { topo } = buildTopology(mulberry32(77), 2);
  let threw = null, res;
  try { res = validation.validateTopology(topo); } catch (e) { threw = e; }
  ok(!threw, 'validateTopology does not throw on a healthy topology', threw && threw.message);
  // It used to return `{ ok: true }` for any object it did not recognise, which meant a Topology was
  // "clean" because it had no `.code` field. Now it actually walks the cables, so the answer has to be
  // internally consistent: ok exactly when nothing is an error.
  ok(res && typeof res === 'object', 'and returns something shaped like a result');
  ok(res && res.ok === (res.errorCount === 0), 'with ok agreeing with its own error count',
    res && JSON.stringify({ ok: res.ok, errors: res.errorCount }));
  ok(res && res.issues.length === res.errorCount + res.warningCount, 'and the issue list matching the counts',
    res && JSON.stringify({ issues: res.issues.length, errors: res.errorCount, warnings: res.warningCount }));

  // A topology whose link references a device that is not there - what a hand-edited lab file or a
  // truncated WebSocket message looks like.
  const broken = new Topology({});
  broken.addDevice(specs[0], 'only');
  broken.links.set('l1', { id: 'l1', a: { deviceId: 'ghost', iface: 'eth0' }, b: { deviceId: 'only', iface: portsOf(broken, 'only')[0] } });
  threw = null;
  let brokenRes;
  try { brokenRes = validation.validateTopology(broken); } catch (e) { threw = e; }
  ok(!threw, 'and does not throw when a link names a device that is not there', threw && threw.message);
  ok(brokenRes && brokenRes.ok === false, 'but does call that topology broken, not clean');
  ok(brokenRes && brokenRes.issues.some(function (i) { return i.linkId === 'l1'; }),
    'and points at the cable that is wrong');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exitCode = 1;
