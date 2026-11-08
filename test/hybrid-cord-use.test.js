'use strict';
// Issue #18, the part that makes the OLT-to-ODN span buildable: the hybrid
// patch-cord catalogue is actually consulted.
//
// The engine has always refused an SC/UPC ferrule against an SC/APC one with
// E_POLISH_MISMATCH, and that refusal is right - a flat endface and an 8-degree
// one touch along an edge, not on the core. What was wrong is that the refusal
// was unconditional: the catalogue of factory UPC/APC leads landed (13 real
// assemblies, catalogue/optics/hybrid-patch-cords.json) and nothing read it, so
// the commonest PON feeder in the field - vendor OLT module with an SC/UPC
// receptacle, APC ODN - could not be built at all.
//
// This suite pins the behaviour that fixes it, from the outside:
//
//   1. the catalogue is the source of the part, and it is loaded
//   2. SC/UPC to SC/APC is refused with no cord and accepted with one, and the
//      verdict names the part and its insertion loss
//   3. that loss is charged to the PON budget, and can push a branch over it
//   4. a cord that cannot bridge the pair changes nothing - the refusal stands
//   5. a cord terminates a link; it is not a way to walk a polish across a
//      multi-hop run
//
// Run: node test/hybrid-cord-use.test.js

const path = require('path');
const { Topology, optical, validation } = require('../engine');
const media = require('../engine/media');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg); }
}

function codes(list) { return (list || []).map(function (e) { return e.code; }); }
function has(verdict, code) { return codes(verdict.errors).indexOf(code) !== -1; }
function warn(verdict, code) { return codes(verdict.warnings).indexOf(code) !== -1; }
function messageOf(verdict, code) {
  const hit = (verdict.errors || []).filter(function (e) { return e.code === code; })[0];
  return hit ? String(hit.message) : '';
}
function warningOf(verdict, code) {
  const hit = (verdict.warnings || []).filter(function (w) { return w.code === code; })[0];
  return hit ? String(hit.message) : '';
}
function round2(n) { return Math.round(Number(n) * 100) / 100; }

const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
const splitter32 = catalog.find(function (s) { return s.model === 'PON Splitter 1:32'; });
const splitter2 = catalog.find(function (s) { return s.model === 'PON Splitter 1:2'; });

// The two ends of the span from the issue. Synthetic specs because the point is
// the ferrule on each port, not a model number: a vendor OLT PON module with an
// SC/UPC receptacle, and an SC/APC ODN port.
function ponPort(connector, name) {
  return {
    vendor: 'generic', model: 'pon-port-' + connector, label: 'PON', category: 'ont',
    capabilities: ['host'],
    interfaces: [{ name: name || 'pon', type: 'pon', speed: '2.5G', connector: connector }]
  };
}
const oltUpc = {
  vendor: 'generic', model: 'olt-sc-upc', label: 'OLT', category: 'olt',
  capabilities: ['l3-forward'],
  interfaces: [{ name: 'gpon0/1', type: 'pon', speed: '2.5G', connector: 'sc-upc' }]
};

function feeder(opts) {
  const t = new Topology();
  const olt = t.addDevice(oltUpc);
  const sp = t.addDevice(splitter32);
  return {
    t: t, olt: olt, sp: sp,
    validate: function (extra) {
      return t.validateLink(olt.id, 'gpon0/1', sp.id, 'uplink',
        Object.assign({ lengthM: 2000 }, opts || {}, extra || {}));
    }
  };
}

// ---------------------------------------------------------------------------
console.log('1. The part comes from the catalogue, and the catalogue is loaded:');
{
  const parts = optical.patchCords();
  ok(parts.length === 13, 'all 13 catalogue assemblies are visible to the engine (' + parts.length + ')');

  const byId = {};
  const byPart = {};
  let dup = null;
  parts.forEach(function (p) {
    if (byId[p.id]) dup = p.id;
    if (byPart[p.partNumber]) dup = p.partNumber;
    byId[p.id] = p; byPart[p.partNumber] = p;
  });
  ok(dup === null, 'with unique ids and part numbers' + (dup ? ' (duplicate: ' + dup + ')' : ''));

  const bridges = parts.filter(function (p) { return p.polishBridge === true; });
  ok(bridges.length === 10, '10 of them are polish bridges (' + bridges.length + ')');
  ok(bridges.every(function (p) {
    const a = media.ferrule(p.endA), b = media.ferrule(p.endB);
    return a && b && a.shape === b.shape && a.polish !== b.polish;
  }), 'and every one of those is same-shape, different-polish - the only pair a cord may fix');

  const shapeHybrids = parts.filter(function (p) { return p.polishBridge === false; });
  ok(shapeHybrids.length === 3, 'and 3 are shape hybrids that a cord cannot rescue (' + shapeHybrids.length + ')');
  ok(shapeHybrids.every(function (p) {
    const a = media.ferrule(p.endA), b = media.ferrule(p.endB);
    return a && b && a.shape !== b.shape;
  }), 'each marked polishBridge:false because it changes geometry, not just polish');

  // Parts that only exist in the second file: proof the loader reads both.
  ['ADAEP-ARYL003', 'FJ1-SCUSCAL-03P', 'FCA-S2SR-SCASCU-02M', 'OCJ-S1-05MASIA-S2'].forEach(function (pn) {
    const p = optical.patchCord(pn);
    ok(!!p && p.partNumber === pn,
      pn + ' resolves by part number (' + (p && p.id) + ')');
  });
  ok(!!optical.patchCord('patch-cord-hybrid-sc-upc-apc-siemon-fj1'),
    'and by catalogue id, so a renumbered vendor part is still findable');

  const pick = optical.hybridCord('sc-upc', 'sc-apc');
  ok(pick && pick.partNumber === 'SMSCSX',
    'SC/UPC to SC/APC resolves to SMSCSX (' + (pick && pick.partNumber) + ')');
  ok(pick && optical.cordLossDb(pick) === 0.3,
    'with the vendor figure attached (' + (pick && optical.cordLossDb(pick)) + ' dB)');
  const rev = optical.hybridCord('sc-apc', 'sc-upc');
  ok(rev && pick && rev.partNumber === pick.partNumber,
    'and the answer does not depend on argument order');
  ok(optical.hybridCord('sc-upc', 'sc-upc') === null &&
     optical.hybridCord('sc-apc', 'sc-apc') === null,
    'two ports of one polish are not a polish problem, so no cord is offered');
}

// ---------------------------------------------------------------------------
console.log('\n2. SC/UPC to SC/APC: refused bare, accepted with a cord that names itself:');
{
  const f = feeder();
  const bare = f.validate();
  ok(!bare.ok, 'the OLT port will not cable straight to the APC ODN port');
  ok(has(bare, 'E_POLISH_MISMATCH'), 'still refused as a polish mismatch (' + codes(bare.errors).join(',') + ')');
  ok(bare.patchCord === null && bare.patchCordLossDb === 0 && bare.polishWeakened === false,
    'with no cord recorded and no budget charged for one');

  const bareMsg = messageOf(bare, 'E_POLISH_MISMATCH');
  ok(/hybrid patch cord/i.test(bareMsg) && /SMSCSX/.test(bareMsg),
    'the refusal names the part that would fix it (SMSCSX)');
  ok(/0\.3 dB/.test(bareMsg), 'and its insertion loss, so the budget question is answerable');
  ok(/declare it on the link/.test(bareMsg),
    'and says how to make the run buildable rather than only that it failed');

  const corded = f.validate({ patchCord: 'SMSCSX' });
  ok(corded.ok, 'with the hybrid cord declared the same span is buildable (' + codes(corded.errors).join(',') + ')');
  ok(corded.patchCord === 'SMSCSX', 'the verdict names the part (' + corded.patchCord + ')');
  ok(corded.patchCordLossDb === 0.3, 'and carries its insertion loss (' + corded.patchCordLossDb + ' dB)');
  ok(corded.polishWeakened === true, 'and says a polish change is being carried');
  ok(corded.mediaId === 'gpon-sc-hybrid',
    'the medium is the bridged one, not either polish (' + corded.mediaId + ')');
  const warnMsg = warningOf(corded, 'W_HYBRID_CORD');
  ok(/SMSCSX/.test(warnMsg) && /0\.3 dB/.test(warnMsg),
    'the warning names the part and what it costs');

  // Declared by catalogue id, from the second file, must behave identically.
  const byId = f.validate({ patchCord: 'patch-cord-hybrid-sc-upc-apc-fs-smscsx' });
  ok(byId.ok && byId.patchCord === 'SMSCSX' && byId.patchCordLossDb === 0.3,
    'declaring the catalogue id selects the same part at the same loss');

  // A different part on the same pair is a different, real choice.
  const siemon = f.validate({ patchCord: 'FJ1-SCUSCAL-03P' });
  ok(siemon.ok && siemon.patchCord === 'FJ1-SCUSCAL-03P' && siemon.patchCordLossDb === 0.4,
    'a worse-but-real part is selectable too (' + siemon.patchCord + ', ' + siemon.patchCordLossDb + ' dB)');
}

// ---------------------------------------------------------------------------
console.log('\n3. The cord\'s loss is charged to the PON budget like a splice:');
{
  const base = { lengthM: 12000, wavelengthNm: 1310, splitters: ['1:32'], ponClass: 'B+' };
  const bare = optical.ponBudget(base);
  const smscsx = optical.ponBudget(Object.assign({}, base, { patchCordLossDb: 0.3 }));
  const siemon = optical.ponBudget(Object.assign({}, base, { patchCordLossDb: 0.4 }));

  ok(round2(smscsx.lossDb - bare.lossDb) === 0.3,
    'SMSCSX adds exactly its 0.3 dB to path loss (' + bare.lossDb + ' -> ' + smscsx.lossDb + ')');
  ok(round2(siemon.lossDb - bare.lossDb) === 0.4,
    'FJ1-SCUSCAL-03P adds its 0.4 dB (' + siemon.lossDb + ')');
  ok(round2(bare.headroomDb - smscsx.headroomDb) === 0.3,
    'the remaining budget drops by the cord\'s loss (' + bare.headroomDb + ' -> ' + smscsx.headroomDb + ' dB)');
  ok(smscsx.breakdown.patchCord.lossDb === 0.3 && bare.breakdown.patchCord.lossDb === 0,
    'and the breakdown attributes it to the cord, not to fibre or splices');

  // Find a feeder length that only just fits, then put the cord on it.
  let edgeL = null;
  for (let L = 1000; L <= 40000; L += 1) {
    const h = optical.ponBudget({
      lengthM: L, wavelengthNm: 1310, splitters: ['1:32'], ponClass: 'B+'
    }).headroomDb;
    if (h > 0 && h < 0.3) edgeL = L;
  }
  ok(edgeL !== null, 'a feeder length with less than 0.3 dB of class B+ headroom exists (' + edgeL + ' m)');

  const f = feeder({ lengthM: edgeL });
  const bareEdge = f.validate();
  ok(!has(bareEdge, 'E_OPTICAL_BUDGET'),
    'that branch fits the budget while it is bare (' + codes(bareEdge.errors).join(',') + ')');
  ok(has(bareEdge, 'E_POLISH_MISMATCH'), 'it is still refused - for polish, not for loss');

  const cordedEdge = f.validate({ patchCord: 'SMSCSX' });
  ok(!cordedEdge.ok && has(cordedEdge, 'E_OPTICAL_BUDGET'),
    'the same branch with the cord on it is over budget (' + codes(cordedEdge.errors).join(',') + ')');
  ok(!has(cordedEdge, 'E_POLISH_MISMATCH'),
    'and the reason is the loss the cord added, not the polish it fixed');
  ok(cordedEdge.patchCord === 'SMSCSX' && cordedEdge.patchCordLossDb === 0.3,
    'the refused verdict still records which cord was charged (' + cordedEdge.patchCord + ')');
}

// ---------------------------------------------------------------------------
console.log('\n4. A cord that cannot bridge the pair leaves the refusal intact:');
{
  // Right shape, wrong part: an LC hybrid lead offered to two SC ports.
  const t = new Topology();
  const a = t.addDevice(ponPort('sc-upc', 'ponA'));
  const b = t.addDevice(ponPort('sc-apc', 'ponB'));
  const wrongPart = t.validateLink(a.id, 'ponA', b.id, 'ponB', { patchCord: 'SMLCSX' });
  ok(!wrongPart.ok, 'an LC/UPC-LC/APC lead on an SC span does not make it legal');
  ok(has(wrongPart, 'E_PATCH_CORD_ENDS'), 'it is refused as the wrong part (' + codes(wrongPart.errors).join(',') + ')');
  ok(has(wrongPart, 'E_POLISH_MISMATCH'), 'and the polish refusal is untouched');
  ok(wrongPart.patchCord === null && wrongPart.patchCordLossDb === 0 && wrongPart.polishWeakened === false,
    'a part that fits nothing is not recorded and costs nothing');

  // Shape hybrid: a real, purchasable assembly the engine must NOT use here.
  const t2 = new Topology();
  const lc = t2.addDevice(ponPort('lc-upc', 'pon'));
  const sc = t2.addDevice(ponPort('sc-apc', 'pon'));
  const shape = t2.validateLink(lc.id, 'pon', sc.id, 'pon', { patchCord: 'N366-02M-AP' });
  ok(!shape.ok && has(shape, 'E_CONNECTOR_MISMATCH'),
    'an LC-to-SC assembly does not bridge a connector shape (' + codes(shape.errors).join(',') + ')');
  ok(!has(shape, 'W_HYBRID_CORD') && shape.polishWeakened === false,
    'nothing is declared bridged, because nothing was');
  ok(optical.hybridCord('lc-upc', 'sc-apc') === null,
    'and the selector never offers a shape change as a polish bridge');

  // Unknown hardware is not hardware.
  const unknown = t.validateLink(a.id, 'ponA', b.id, 'ponB', { patchCord: 'SMSCSX-XX' });
  ok(!unknown.ok && has(unknown, 'E_PATCH_CORD_UNKNOWN'),
    'a part number that is not in the catalogue is refused (' + codes(unknown.errors).join(',') + ')');

  // The catalogue genuinely has no part for the pair: say so, because then the
  // answer is re-termination or a different port, not a purchase order. Simulated
  // by removing the lookup, since every same-shape/different-polish pair among
  // the catalogue's connector shapes happens to have a part today.
  const realHybridCord = optical.hybridCord;
  let noPart = null;
  try {
    optical.hybridCord = function () { return null; };
    noPart = t.validateLink(a.id, 'ponA', b.id, 'ponB', { lengthM: 2000 });
  } finally {
    optical.hybridCord = realHybridCord;
  }
  ok(!!noPart && !noPart.ok && has(noPart, 'E_POLISH_MISMATCH'),
    'with no bridging part the pair is still refused as a polish mismatch');
  const noPartMsg = noPart ? messageOf(noPart, 'E_POLISH_MISMATCH') : '';
  ok(/no hybrid patch cord in the catalogue/i.test(noPartMsg),
    'and the refusal says the catalogue has no hybrid cord for these two polishes');
  ok(/hybrid-patch-cords\.json/.test(noPartMsg),
    'naming the catalogue file, so the user knows what was searched');
  ok(/re-terminate|patch panel/.test(noPartMsg),
    'and pointing at the alternatives that do exist');

  // Ordinary fibre is untouched: same polish is still plain cable.
  const t3 = new Topology();
  const u1 = t3.addDevice(ponPort('sc-upc', 'pon'));
  const u2 = t3.addDevice(ponPort('sc-upc', 'pon'));
  const plain = t3.validateLink(u1.id, 'pon', u2.id, 'pon', { lengthM: 500 });
  ok(plain.ok && plain.patchCord === null && plain.polishWeakened === false,
    'two UPC ports cable as they always did, with no cord recorded');
}

// ---------------------------------------------------------------------------
console.log('\n5. A cord terminates a link; it does not travel down a run:');
{
  // OLT(SC/UPC) -> splitter A(uplink SC/APC) -> splitter B(uplink SC/APC) -> ONT(SC/UPC)
  const t = new Topology();
  const olt = t.addDevice(oltUpc);
  const spA = t.addDevice(splitter2);
  const spB = t.addDevice(splitter2);
  const ont = t.addDevice(ponPort('sc-upc', 'pon'));

  const hop1Bare = t.validateLink(olt.id, 'gpon0/1', spA.id, 'uplink', { lengthM: 5000 });
  ok(!hop1Bare.ok && has(hop1Bare, 'E_POLISH_MISMATCH'),
    'hop 1 (OLT SC/UPC to ODN SC/APC) needs its own cord');

  const hop1 = t.connect(olt.id, 'gpon0/1', spA.id, 'uplink', { lengthM: 5000, patchCord: 'SMSCSX' });
  ok(hop1.patchCord === 'SMSCSX', 'hop 1 is built with the cord and records it (' + hop1.patchCord + ')');

  const hop2 = t.validateLink(spA.id, 'leg1', spB.id, 'uplink', { lengthM: 3000 });
  ok(hop2.ok, 'hop 2 (APC to APC) needs nothing and is unaffected (' + codes(hop2.errors).join(',') + ')');
  ok(hop2.patchCord === null && hop2.patchCordLossDb === 0 && hop2.polishWeakened === false,
    'hop 2 records no cord and is charged none');

  // The cord from hop 1 must not be able to sit here: a lead between two APC
  // ports is the wrong part, which is what stops a cord being used mid-run.
  const hop2Corded = t.validateLink(spA.id, 'leg1', spB.id, 'uplink', {
    lengthM: 3000, patchCord: 'SMSCSX'
  });
  ok(!hop2Corded.ok && has(hop2Corded, 'E_PATCH_CORD_ENDS'),
    'the same cord cannot be re-used in the middle of the run (' + codes(hop2Corded.errors).join(',') + ')');

  // The far end is a fresh mismatch: hop 1's cord buys it nothing.
  const hop3 = t.validateLink(spB.id, 'leg1', ont.id, 'pon', { lengthM: 1000 });
  ok(!hop3.ok && has(hop3, 'E_POLISH_MISMATCH'),
    'hop 3 (SC/APC to SC/UPC ONT) is refused on its own terms, not helped by hop 1');
  ok(hop3.patchCord === null, 'and hop 3 has no cord of its own');

  const hop3Corded = t.connect(spB.id, 'leg1', ont.id, 'pon', { lengthM: 1000, patchCord: 'OCJ-S1-05MASIA-S2' });
  ok(hop3Corded.patchCord === 'OCJ-S1-05MASIA-S2',
    'declaring a cord at hop 3 fixes hop 3 (' + hop3Corded.patchCord + ')');

  // Each link owns its own cord, and re-checking one does not disturb another.
  const links = Array.from(t.links.values()).map(function (l) { return l.patchCord; });
  ok(links.length === 2 && links[0] === 'SMSCSX' && links[1] === 'OCJ-S1-05MASIA-S2',
    'the run carries two cords, one per terminated span (' + links.join(' / ') + ')');

  // Re-validating an existing cable names the pair it re-checks (issue #31), so
  // the port-in-use rule does not drown out what we are asking about.
  const hop1Again = t.validateLink(olt.id, 'gpon0/1', spA.id, 'uplink', {
    lengthM: 5000, patchCord: 'SMSCSX',
    revalidate: { a: { deviceId: spA.id, iface: 'uplink' }, b: { deviceId: olt.id, iface: 'gpon0/1' } }
  });
  ok(hop1Again.ok && hop1Again.patchCord === 'SMSCSX' && hop1Again.patchCordLossDb === 0.3,
    're-checking hop 1 still charges hop 1\'s cord, not hop 3\'s (' + hop1Again.patchCordLossDb + ' dB)');

  const hop3Again = t.validateLink(spB.id, 'leg1', ont.id, 'pon', {
    lengthM: 1000, patchCord: 'OCJ-S1-05MASIA-S2',
    revalidate: { a: { deviceId: ont.id, iface: 'pon' }, b: { deviceId: spB.id, iface: 'leg1' } }
  });
  ok(hop3Again.ok && hop3Again.patchCord === 'OCJ-S1-05MASIA-S2' &&
     hop3Again.patchCordLossDb === 0.5,
    'and hop 3 is charged its own 0.5 dB part (' + hop3Again.patchCordLossDb + ' dB)');

  ok(optical.hybridCord('sc-upc', 'sc-apc').partNumber === 'SMSCSX' &&
     optical.cordLossDb(optical.hybridCord('sc-upc', 'sc-apc')) === 0.3,
    'the selector is still the catalogue\'s answer, not a link\'s memory');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
