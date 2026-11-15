'use strict';
// W_SPEED_DOWNGRADE could not fire when only one end was speed-limited (#1523).
//
// The rule required the negotiated rate to be below the maximum of BOTH ports, so it fired on the rarer
// shape - two 10G ports with a 1G module between them - and said nothing at all about the common one: a
// 10G RJ45 socket cabled to a 1G switch negotiates 1000 and emitted no code. Both are downgrades of a
// port that could go faster, and the second one is what a real rack is full of.
//
// These tests pin the threshold (either end, not both), the exemption that keeps deliberate 1G spans
// quiet (`speedExemptMbps`, a per-link declared rate rather than a mute), and the distinction the fix must
// not blur: `canMate()` answers the best-case socket speed, the link record answers what the cable runs at.
const { Topology } = require('../engine/topology');
const media = require('../engine/media');
const validation = require('../engine/validation');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

function codes(list) {
  return (list || []).map(function (e) { return e.code; });
}
function warnText(verdict) {
  return (verdict.warnings || []).filter(function (w) { return w.code === 'W_SPEED_DOWNGRADE'; })
    .map(function (w) { return w.message; }).join(' | ');
}
function hasDowngrade(verdict) {
  return codes(verdict.warnings).indexOf('W_SPEED_DOWNGRADE') !== -1;
}

// Two boxes, one port each, built from the same terse spec shape the device catalogue uses.
function pair(labelA, portA, labelB, portB) {
  const t = new Topology({});
  t.addDevice({ vendor: 'lab', model: labelA, label: labelA, category: 'switch', interfaces: [portA] }, 'a');
  t.addDevice({ vendor: 'lab', model: labelB, label: labelB, category: 'switch', interfaces: [portB] }, 'b');
  return t;
}

const TEN_G_RJ45 = { name: 'te1', type: 'ethernet', speed: '10G', connector: 'rj45' };
const ONE_G_RJ45 = { name: 'gi1', type: 'ethernet', speed: '1G', connector: 'rj45' };

console.log('');
console.log('The common case: one 10G end, one 1G end');

{
  const t = pair('SW10G', TEN_G_RJ45, 'SW1G', ONE_G_RJ45);
  const v = t.validateLink('a', 'te1', 'b', 'gi1');

  ok(v.ok === true, 'the cable is legal - this is a downgrade, not a refusal', JSON.stringify(codes(v.errors)));
  ok(v.speedMbps === 1000, 'and it negotiates 1G', String(v.speedMbps));
  ok(v.mediaId === '1000base-t', 'over the copper medium they share', String(v.mediaId));
  ok(hasDowngrade(v), 'so W_SPEED_DOWNGRADE fires on the 10G end', JSON.stringify(codes(v.warnings)));
  ok(/below the 10G of te1/.test(warnText(v)),
    'the message says which end gave something up', warnText(v));
  ok(/gi1 tops out at 1G/.test(warnText(v)),
    'and which end is the limit, because that is the part a reader cannot see from the warning alone',
    warnText(v));

  // Same cable, drawn from the other end: the rule must not depend on click order.
  const t2 = pair('SW10G', TEN_G_RJ45, 'SW1G', ONE_G_RJ45);
  const swapped = t2.validateLink('b', 'gi1', 'a', 'te1');
  ok(hasDowngrade(swapped) && /below the 10G of te1/.test(warnText(swapped)),
    'and the same warning comes back when the 1G end is drawn first', warnText(swapped));
}

console.log('');
console.log('The case that already worked: both ends faster than the link');

{
  // Two 10G SFP+ cages whose only shared module is a 1G copper SFP: same code, both ends named.
  const t = pair('SW10G-A', { name: 'sfp-sfpplus1', type: 'ethernet', speed: '10G' },
    'SW10G-B', { name: 'sfp-sfpplus2', type: 'ethernet', speed: '10G', media: ['1000base-t-sfp'] });
  const v = t.validateLink('a', 'sfp-sfpplus1', 'b', 'sfp-sfpplus2');

  ok(v.ok === true, 'the link is legal', JSON.stringify(codes(v.errors)));
  ok(v.speedMbps === 1000, 'and runs at 1G through the module', String(v.speedMbps));
  ok(hasDowngrade(v), 'W_SPEED_DOWNGRADE still fires', JSON.stringify(codes(v.warnings)));
  ok(/below the 10G of sfp-sfpplus1 and the 10G of sfp-sfpplus2/.test(warnText(v)),
    'with the both-ends sentence unchanged, so this fix does not rewrite the case that already worked',
    warnText(v));
  ok(warnText(v).indexOf('tops out at') === -1,
    'and it is not reported as a one-end limit, because neither end is the limit', warnText(v));
}

console.log('');
console.log('A link that loses nothing is not a downgrade');

{
  const t = pair('SW1G-A', ONE_G_RJ45, 'SW1G-B', { name: 'gi2', type: 'ethernet', speed: '1G', connector: 'rj45' });
  const v = t.validateLink('a', 'gi1', 'b', 'gi2');
  ok(v.ok === true, '1G to 1G is legal', JSON.stringify(codes(v.errors)));
  ok(v.speedMbps === 1000, 'and runs at its own maximum', String(v.speedMbps));
  ok(!hasDowngrade(v), 'nothing was given up, so there is nothing to warn about', JSON.stringify(codes(v.warnings)));
}

console.log('');
console.log('The exemption: a link declares the rate it is meant to run at');

{
  const t = pair('SW10G', TEN_G_RJ45, 'SW1G', ONE_G_RJ45);
  const v = t.validateLink('a', 'te1', 'b', 'gi1', { speedExemptMbps: 1000 });
  ok(v.ok === true && v.speedMbps === 1000, 'the declared link is still a 1G link', String(v.speedMbps));
  ok(!hasDowngrade(v), 'and declaring 1000 silences the warning', JSON.stringify(codes(v.warnings)));

  // A rate, not a flag: the declaration covers the rate it names and nothing else.
  const wrongRate = t.validateLink('a', 'te1', 'b', 'gi1', { speedExemptMbps: 10000 });
  ok(hasDowngrade(wrongRate),
    'declaring the wrong rate does not exempt the link - a flag could not tell these apart',
    JSON.stringify(codes(wrongRate.warnings)));

  const nonsense = t.validateLink('a', 'te1', 'b', 'gi1', { speedExemptMbps: 'fast' });
  ok(hasDowngrade(nonsense), 'and a value that is not a rate is not a declaration',
    JSON.stringify(codes(nonsense.warnings)));

  // The declaration is about one rate, not about the cable: the same pair pushed down to 100BASE-TX is
  // still a downgrade of both ends at 100 Mbps, and declaring 1000 does not cover it.
  const fallen = t.validateLink('a', 'te1', 'b', 'gi1', { mediaId: '100base-tx', speedExemptMbps: 1000 });
  ok(fallen.speedMbps === 100, 'the same cable on a 100BASE-TX module runs at 100M', String(fallen.speedMbps));
  ok(hasDowngrade(fallen),
    'and a declaration of 1000 does not silence a link that is no longer at 1000',
    JSON.stringify(codes(fallen.warnings)));
  const declaredAt100 = t.validateLink('a', 'te1', 'b', 'gi1', { mediaId: '100base-tx', speedExemptMbps: 100 });
  ok(!hasDowngrade(declaredAt100), 'declaring the rate it actually runs at does',
    JSON.stringify(codes(declaredAt100.warnings)));

  // The both-ends shape obeys the same declaration.
  const t2 = pair('SW10G-A', { name: 'sfp-sfpplus1', type: 'ethernet', speed: '10G' },
    'SW10G-B', { name: 'sfp-sfpplus2', type: 'ethernet', speed: '10G', media: ['1000base-t-sfp'] });
  const both = t2.validateLink('a', 'sfp-sfpplus1', 'b', 'sfp-sfpplus2', { speedExemptMbps: 1000 });
  ok(!hasDowngrade(both), 'a deliberate 1G module in a 10G cage is exempt too',
    JSON.stringify(codes(both.warnings)));
}

console.log('');
console.log('The exemption belongs to one link, not to the board');

{
  // One 10G box with two 1G neighbours: the cable to 'b' is declared deliberate, the cable to 'c' is not.
  const t = new Topology({});
  t.addDevice({
    vendor: 'lab', model: 'SW10G', label: 'SW10G', category: 'switch',
    interfaces: [
      { name: 'te1', type: 'ethernet', speed: '10G', connector: 'rj45' },
      { name: 'te2', type: 'ethernet', speed: '10G', connector: 'rj45' }
    ]
  }, 'a');
  t.addDevice({
    vendor: 'lab', model: 'SW1G-1', label: 'SW1G-1', category: 'switch',
    interfaces: [{ name: 'gi1', type: 'ethernet', speed: '1G', connector: 'rj45' }]
  }, 'b');
  t.addDevice({
    vendor: 'lab', model: 'SW1G-2', label: 'SW1G-2', category: 'switch',
    interfaces: [{ name: 'gi1', type: 'ethernet', speed: '1G', connector: 'rj45' }]
  }, 'c');

  const declared = t.connect('a', 'te1', 'b', 'gi1', { speedExemptMbps: 1000 });
  const plain = t.connect('a', 'te2', 'c', 'gi1');
  ok(declared.speedExemptMbps === 1000, 'the declared cable records the rate it was declared at',
    String(declared.speedExemptMbps));
  ok(plain.speedExemptMbps === null, 'and the ordinary cable records nothing', String(plain.speedExemptMbps));

  const verdicts = [
    Object.assign({ linkId: declared.id },
      t.validateLink('a', 'te1', 'b', 'gi1', { revalidate: t.revalidateFor(declared.id), speedExemptMbps: 1000 })),
    Object.assign({ linkId: plain.id },
      t.validateLink('a', 'te2', 'c', 'gi1', { revalidate: t.revalidateFor(plain.id) }))
  ];
  const summary = validation.validateTopology(verdicts);
  const hits = (summary.issues || []).filter(function (i) { return i.code === 'W_SPEED_DOWNGRADE'; });
  ok(hits.length === 1, 'exactly one of the two 10G-to-1G cables warns', JSON.stringify(codes(summary.issues)));
  ok(hits.length === 1 && hits[0].linkId === plain.id,
    'and it is the one that declared nothing, not the one next to it',
    JSON.stringify(hits.map(function (h) { return h.linkId; })));

  // The whole-lab answer is what the server puts in every state payload, and it must agree with the
  // per-cable answer: a board-wide verdict that still warned here would be two answers to one question.
  const wholeBoard = validation.validateTopology(t);
  const boardHits = (wholeBoard.issues || []).filter(function (i) { return i.code === 'W_SPEED_DOWNGRADE'; });
  ok(boardHits.length === 1 && boardHits[0].linkId === plain.id,
    'and the whole-board verdict says the same thing',
    JSON.stringify(boardHits.map(function (h) { return h.linkId; })));

  // Re-checking the declared cable for another reason (a length edit) must not resurrect the warning.
  const rechecked = t.setLinkLength(declared.id, 30);
  ok(rechecked.ok, 'the declared cable still re-checks clean', JSON.stringify(codes(rechecked.errors)));
  ok(!(rechecked.warnings || []).some(function (w) { return w.code === 'W_SPEED_DOWNGRADE'; }),
    'and a length edit does not undo the declaration', JSON.stringify(codes(rechecked.warnings)));

  // A saved board keeps the declaration: the exemption is part of the lab, not of the session.
  const reloaded = Topology.fromJSON(JSON.parse(JSON.stringify(t.serialize())));
  const back = reloaded.links.get(declared.id);
  ok(back && back.speedExemptMbps === 1000, 'the declaration survives a save and a reload',
    back ? String(back.speedExemptMbps) : 'link missing');
  const afterReload = reloaded.validateLink('a', 'te1', 'b', 'gi1', { speedExemptMbps: back.speedExemptMbps });
  ok(!hasDowngrade(afterReload), 'and the reloaded cable is still quiet',
    JSON.stringify(codes(afterReload.warnings)));

  // An ordinary cable writes no field, so an unrelated lab's saved file does not change.
  const plainDoc = JSON.parse(JSON.stringify(t.serialize())).links.filter(function (l) { return l.id === plain.id; })[0];
  ok(plainDoc && plainDoc.speedExemptMbps === undefined,
    'a link that declares nothing carries no field in the document', JSON.stringify(plainDoc));
}

console.log('');
console.log('The reported speed is the cable, not the socket');

{
  // The distinction this fix must not blur: canMate() answers the best-case socket speed, the link record
  // and the verdict answer what the cable actually runs at. They differ here, and that is correct.
  const t = pair('SW10G-A', { name: 'sfp-sfpplus1', type: 'ethernet', speed: '10G' },
    'SW10G-B', { name: 'sfp-sfpplus2', type: 'ethernet', speed: '10G', media: ['1000base-t-sfp'] });
  const hwA = t.getDevice('a').interfaces.get('sfp-sfpplus1').hardware;
  const hwB = t.getDevice('b').interfaces.get('sfp-sfpplus2').hardware;
  const mate = media.canMate(hwA, hwB);
  const verdict = t.validateLink('a', 'sfp-sfpplus1', 'b', 'sfp-sfpplus2');
  const link = t.connect('a', 'sfp-sfpplus1', 'b', 'sfp-sfpplus2');

  ok(hwA.maxSpeedMbps === 10000, 'the socket is a 10G socket', String(hwA.maxSpeedMbps));
  ok(mate.speedMbps === 10000, 'canMate() answers the best-case socket speed', String(mate.speedMbps));
  ok(verdict.speedMbps === 1000, 'the verdict answers what the cable runs at', String(verdict.speedMbps));
  ok(link.speedMbps === 1000, 'and so does the link record', String(link.speedMbps));
  ok(link.mediaId === '1000base-t-sfp', 'with the module that sets it', String(link.mediaId));
  ok(hasDowngrade(verdict), 'the warning is about the cable, which is why it fires on a 1000 Mbps link',
    JSON.stringify(codes(verdict.warnings)));
}

console.log('');
console.log('The rule still names every warning code it emits');

{
  // `RULES` is the declared catalogue the UI renders and the docs table is audited against; a rule whose
  // description still claims "both ports" would be a docs defect the moment this predicate changed.
  const rule = validation.RULES.filter(function (r) { return r.code === 'W_SPEED_DOWNGRADE'; })[0];
  ok(!!rule && rule.severity === 'warning', 'W_SPEED_DOWNGRADE is still a warning',
    rule ? rule.severity : 'missing');
  ok(!!rule && /at least one/.test(rule.description),
    'and its description states the threshold this test measures', rule ? rule.description : 'missing');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
