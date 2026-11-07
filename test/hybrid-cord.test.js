'use strict';
// Hybrid UPC/APC patch cords (issue #18): the OLT-to-ODN link.
//
// The engine refuses an SC/APC-to-SC/UPC cable with E_POLISH_MISMATCH, and that
// refusal is correct: an 8-degree angled ferrule against a flat one leaves an air
// gap and reflects light back into the laser. A single cable between those two
// polishes is not a thing.
//
// But the plant between an OLT and its ODN is routinely that pair, because real
// deployments use HYBRID PATCH CORDS: UPC at one end, APC at the other, the polish
// change made inside a factory-terminated assembly. Vendor OLT PON modules ship
// SC/UPC (FS GSFP-43-20C, XGS-SFP-52-20N2I) while the ODN side is SC/APC, so
// without the cord the feeder link could only be built by pretending the OLT had
// a ferrule it does not have.
//
// What this test pins down:
//   * the cords are catalogue parts with a real source, not a flag on a link
//   * hybridCord() answers "which part joins these two cages", both ways round
//   * the pair is still refused when no cord is declared
//   * it is accepted when one is, with polishWeakened set and a warning
//   * the cord's insertion loss is charged to the PON budget
//   * ordinary fibre is still refused afterwards - the rule was not loosened
const path = require('path');
const { Topology, optical, validation } = require('../engine');
const media = require('../engine/media');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg); }
}

function codes(list) {
  return (list || []).map(function (e) { return e.code; });
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
const splitter32 = catalog.find(function (s) { return s.model === 'PON Splitter 1:32'; });
const splitter8 = catalog.find(function (s) { return s.model === 'PON Splitter 1:8'; });

// The OLT the issue is about: a vendor PON module with an SC/UPC receptacle.
// Synthetic rather than catalogue, because devices/*.json is another lane's file
// and the point here is the ferrule, not the model number.
const oltUpc = {
  vendor: 'generic', model: 'olt-sc-upc', label: 'OLT', category: 'olt',
  capabilities: ['l3-forward'],
  interfaces: [{ name: 'gpon0/1', type: 'pon', speed: '2.5G', connector: 'sc-upc' }]
};

// An LC/UPC PON port, for the small-form-factor cord.
const ontLcUpc = {
  vendor: 'generic', model: 'ont-lc-upc', label: 'ONT', category: 'ont',
  capabilities: ['host'],
  interfaces: [{ name: 'pon', type: 'pon', speed: '2.5G', connector: 'lc-upc' }]
};

const ontLcApc = {
  vendor: 'generic', model: 'ont-lc-apc', label: 'ONT2', category: 'ont',
  capabilities: ['host'],
  interfaces: [{ name: 'pon', type: 'pon', speed: '2.5G', connector: 'lc-apc' }]
};

function build() {
  const t = new Topology();
  const olt = t.addDevice(oltUpc);
  const sp = t.addDevice(splitter32);
  return { t: t, olt: olt, sp: sp };
}

// ---------------------------------------------------------------------------
console.log('Hybrid cords are catalogue parts, not a flag on a link:');
{
  const sc = optical.patchCord('patch-cord-hybrid-sc-upc-apc');
  const lc = optical.patchCord('patch-cord-hybrid-lc-upc-apc');

  ok(!!sc, 'the SC hybrid cord is in the ODN catalogue (' + (sc && sc.partNumber) + ')');
  ok(!!lc, 'and the LC one is too (' + (lc && lc.partNumber) + ')');
  ok(sc && sc.kind === 'patch-cord', 'it is filed as kind patch-cord');
  ok(sc && sc.id === 'patch-cord-hybrid-sc-upc-apc', 'under a stable catalogue id (' + (sc && sc.id) + ')');
  ok(sc && sc.endA === 'sc-upc' && sc.endB === 'sc-apc',
    'with a different polish on each end (' + (sc && sc.endA) + ' / ' + (sc && sc.endB) + ')');
  ok(lc && lc.endA === 'lc-upc' && lc.endB === 'lc-apc',
    'the LC lead likewise (' + (lc && lc.endA) + ' / ' + (lc && lc.endB) + ')');
  ok(sc && Array.isArray(sc.lengthM) && sc.lengthM.length > 0,
    'it declares the lengths it is stocked in (' + (sc && sc.lengthM) + ')');
  ok(sc && Number(sc.insertionLossDb) > 0 && Number(sc.insertionLossDb) <= 0.5,
    'with a published insertion loss (' + (sc && sc.insertionLossDb) + ' dB)');
  ok(sc && /^https?:\/\//.test(String(sc.sourceUrl)),
    'and a real vendor page behind it (' + (sc && sc.sourceUrl) + ')');
  ok(sc && typeof sc.note === 'string' && /hybrid|UPC|APC/i.test(sc.note),
    'and a note saying why the part exists');
  ok(optical.patchCord('NOT-A-CORD') === null, 'an unknown part number resolves to null');
  ok(optical.patchCord('smscsx') === sc, 'the vendor part number finds the same part, case-insensitively');
}

console.log('\nhybridCord() answers which part joins two cages:');
{
  const both = optical.hybridCord('sc-upc', 'sc-apc');
  ok(!!both, 'SC/UPC to SC/APC is bridged by a part (' + (both && both.partNumber) + ')');
  const rev = optical.hybridCord('sc-apc', 'sc-upc');
  ok(rev && both && rev.partNumber === both.partNumber,
    'and the answer does not depend on which end is asked about');
  ok(optical.hybridCord('sc-apc', 'sc-apc') === null, 'two APC ports need no cord');
  ok(optical.hybridCord('sc-upc', 'sc-upc') === null, 'two UPC ports need no cord');
  ok(optical.hybridCord('sc-apc', 'lc-upc') === null,
    'a different connector shape is not a polish problem, so no cord is offered');
  ok(optical.hybridCord('rj45', 'sc-apc') === null, 'and copper is not bridged at all');
  const lc = optical.hybridCord('lc-upc', 'lc-apc');
  ok(!!lc && lc.partNumber === 'SMLCSX', 'LC/UPC to LC/APC resolves to the LC lead');
}

console.log('\nThe feeder link from the issue, before and after the cord:');
{
  const b = build();
  const refused = b.t.validateLink(b.olt.id, 'gpon0/1', b.sp.id, 'uplink', { lengthM: 2000 });
  ok(!refused.ok, 'an SC/UPC OLT port will not cable straight to an SC/APC ODN port');
  ok(codes(refused.errors).indexOf('E_POLISH_MISMATCH') !== -1,
    'and the refusal is still a polish mismatch (' + codes(refused.errors).join(',') + ')');
  ok(refused.polishWeakened === false, 'with nothing weakened, because nothing is joined');
  ok(refused.patchCord === null, 'and no cord recorded on the link');
  const refusedMsg = (refused.errors[0] && refused.errors[0].message) || '';
  ok(/hybrid patch cord/.test(refusedMsg) && /SMSCSX/.test(refusedMsg),
    'the refusal points at the hybrid cord that would make the link buildable');

  const corded = b.t.validateLink(b.olt.id, 'gpon0/1', b.sp.id, 'uplink', {
    lengthM: 2000, patchCord: 'SMSCSX'
  });
  ok(corded.ok, 'with the hybrid cord the same link is buildable (' + codes(corded.errors).join(',') + ')');
  ok(corded.polishWeakened === true, 'the verdict says a polish change is being carried');
  ok(corded.patchCord === 'SMSCSX', 'and names the part that carries it');
  ok(corded.patchCordLossDb === 0.3, 'with its insertion loss attached (' + corded.patchCordLossDb + ' dB)');
  ok(corded.mediaId === 'gpon-sc-hybrid', 'the medium is the hybrid cord, not one polish (' + corded.mediaId + ')');
  ok(corded.media.indexOf(corded.mediaId) !== -1, 'and it is in the common media list the UI shows');
  ok(corded.speedMbps === 2488, 'GPON still negotiates 2488 Mbit/s over it (' + corded.speedMbps + ')');
  ok(codes(corded.warnings).indexOf('W_HYBRID_CORD') !== -1,
    'and the user is warned what the cord is and is not (' + codes(corded.warnings).join(',') + ')');
  const warn = corded.warnings.filter(function (w) { return w.code === 'W_HYBRID_CORD'; })[0];
  ok(warn && /cannot be swapped|cannot be replaced/.test(warn.message),
    'the warning says the lead cannot be replaced by a plain patch cord');
}

console.log('\nThe rule was not loosened - ordinary fibre is still refused:');
{
  const b = build();
  const again = b.t.validateLink(b.olt.id, 'gpon0/1', b.sp.id, 'uplink', { lengthM: 2000 });
  ok(!again.ok && codes(again.errors).indexOf('E_POLISH_MISMATCH') !== -1,
    'after a corded link exists, an uncorded SC/APC-to-SC/UPC pair is still refused');

  // ... and in the other order, which is the same physics.
  const t2 = new Topology();
  const oltApc = t2.addDevice({
    vendor: 'generic', model: 'olt-apc', label: 'OLT2', category: 'olt',
    capabilities: ['l3-forward'],
    interfaces: [{ name: 'gpon0/1', type: 'pon', speed: '2.5G', connector: 'sc-apc' }]
  });
  const sp = t2.addDevice(splitter8);
  const matched = t2.validateLink(oltApc.id, 'gpon0/1', sp.id, 'uplink', { lengthM: 1000 });
  ok(matched.ok && matched.polishWeakened === false,
    'a matched APC run needs no cord and is not marked weakened');
  const needless = t2.validateLink(oltApc.id, 'gpon0/1', sp.id, 'uplink', {
    lengthM: 1000, patchCord: 'SMSCSX'
  });
  ok(!needless.ok && codes(needless.errors).indexOf('E_PATCH_CORD_ENDS') !== -1,
    'and a hybrid lead offered to two APC ports is refused as the wrong part');

  const lcA = media.derivePortHardware({ name: 'pon', speed: '2.5G', connector: 'lc-upc' }, {});
  const lcB = media.derivePortHardware({ name: 'pon', speed: '2.5G', connector: 'lc-apc' }, {});
  const plainLc = validation.validateConnection({ portA: lcA, portB: lcB });
  ok(!plainLc.ok && codes(plainLc.errors).indexOf('E_POLISH_MISMATCH') !== -1,
    'an LC/UPC to LC/APC run is refused just as firmly');
  const bridgedLc = validation.validateConnection({ portA: lcA, portB: lcB, patchCord: 'SMLCSX' });
  ok(bridgedLc.ok && bridgedLc.polishWeakened === true,
    'and the LC hybrid cord bridges it (' + codes(bridgedLc.errors).join(',') + ')');
}

console.log('\nA cord is a specific part, not a free pass:');
{
  const b = build();
  const wrong = b.t.validateLink(b.olt.id, 'gpon0/1', b.sp.id, 'uplink', {
    lengthM: 2000, patchCord: 'SMLCSX'
  });
  ok(!wrong.ok, 'an LC lead cannot be declared on two SC ports');
  ok(codes(wrong.errors).indexOf('E_PATCH_CORD_ENDS') !== -1,
    'and the refusal names the ends (' + codes(wrong.errors).join(',') + ')');

  const unknown = b.t.validateLink(b.olt.id, 'gpon0/1', b.sp.id, 'uplink', {
    lengthM: 2000, patchCord: 'NOPE-123'
  });
  ok(!unknown.ok && codes(unknown.errors).indexOf('E_PATCH_CORD_UNKNOWN') !== -1,
    'an unknown part number is refused before anything is bridged');

  // The cord only helps where the polishes differ; it does not make two UPC ports
  // into a legal pair, because the part has one APC end and one UPC end.
  const t3 = new Topology();
  const a = t3.addDevice(oltUpc);
  const b2 = t3.addDevice({
    vendor: 'generic', model: 'ont-upc', label: 'ONT', category: 'ont',
    capabilities: ['host'],
    interfaces: [{ name: 'pon', type: 'pon', speed: '2.5G', connector: 'sc-upc' }]
  });
  const useless = t3.validateLink(a.id, 'gpon0/1', b2.id, 'pon', { patchCord: 'SMSCSX' });
  ok(!useless.ok, 'a hybrid lead on two UPC ports is the wrong part');
}

console.log('\nThe cord\'s insertion loss reaches the optical budget:');
{
  const bare = optical.ponBudget({ lengthM: 20000, wavelengthNm: 1310, splitters: ['1:32'], ponClass: 'B+' });
  const corded = optical.ponBudget({
    lengthM: 20000, wavelengthNm: 1310, splitters: ['1:32'], ponClass: 'B+', patchCordLossDb: 0.3
  });
  ok(Math.round((corded.lossDb - bare.lossDb) * 100) / 100 === 0.3,
    '0.3 dB of cord shows up as 0.3 dB of path loss (' + bare.lossDb + ' -> ' + corded.lossDb + ')');
  ok(corded.breakdown.patchCord && corded.breakdown.patchCord.lossDb === 0.3,
    'and the breakdown attributes it to the patch cord, not to the fibre');
  ok(bare.breakdown.patchCord.lossDb === 0, 'while an uncorded path is charged nothing for one');

  // A run that just fits becomes impossible once the cord is counted. 28 km at
  // 1:32 is 27.9 dB upstream (1310 nm) against a 28 dB class B+ budget.
  const b = build();
  const edge = b.t.validateLink(b.olt.id, 'gpon0/1', b.sp.id, 'uplink', { lengthM: 28000 });
  ok(codes(edge.errors).indexOf('E_OPTICAL_BUDGET') === -1,
    'an uncorded 28 km / 1:32 branch is refused for polish only, not for loss');
  const over = b.t.validateLink(b.olt.id, 'gpon0/1', b.sp.id, 'uplink', {
    lengthM: 28000, patchCord: 'SMSCSX'
  });
  ok(!over.ok && codes(over.errors).indexOf('E_OPTICAL_BUDGET') !== -1,
    'the same branch with the cord on it goes over the class B+ budget (' + codes(over.errors).join(',') + ')');
  ok(codes(over.errors).indexOf('E_POLISH_MISMATCH') === -1,
    'and it is refused for loss, not for polish - the cord did its job');
}

console.log('\nThe link record carries the part, and plain fibre is the default:');
{
  const b = build();
  const link = b.t.connect(b.olt.id, 'gpon0/1', b.sp.id, 'uplink', {
    lengthM: 2000, patchCord: 'SMSCSX'
  });
  ok(link.patchCord === 'SMSCSX', 'connect() keeps the cord on the link (' + link.patchCord + ')');
  ok(link.mediaId === 'gpon-sc-hybrid', 'and the link medium is the hybrid one');

  const saved = JSON.parse(JSON.stringify(b.t.serialize()));
  const reloaded = Topology.fromJSON(saved);
  const back = reloaded.links.get(link.id);
  ok(back && back.patchCord === 'SMSCSX', 'a saved topology reloads with its cord intact');
  ok(reloaded.getDevice(b.olt.id).interfaces.get('gpon0/1').cage === 'sc-upc',
    'and the port reloads with the ferrule it actually has, not one inferred from its name');

  // An ordinary link, and a saved topology that predates the field: both mean
  // plain cable, and neither may be charged a cord.
  const t2 = new Topology();
  const sw = t2.addDevice({
    vendor: 'generic', model: 'sw', label: 'SW', category: 'switch',
    capabilities: [], interfaces: [{ name: 'Fa0/1', speed: '1G' }]
  });
  const pc = t2.addDevice({
    vendor: 'generic', model: 'pc', label: 'PC', category: 'host',
    capabilities: [], interfaces: [{ name: 'eth0', speed: '1G' }]
  });
  const plain = t2.connect(sw.id, 'Fa0/1', pc.id, 'eth0');
  ok(plain.patchCord === null, 'a link built without a cord records null');

  const legacy = JSON.parse(JSON.stringify(t2.serialize()));
  delete legacy.links[0].patchCord;
  const old = Topology.fromJSON(legacy);
  const oldLink = old.links.get(plain.id);
  ok(oldLink && oldLink.patchCord === null,
    'a topology saved before this field existed loads as ordinary cable');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
