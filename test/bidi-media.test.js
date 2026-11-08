'use strict';
// ===========================================================================
// test/bidi-media.test.js -- single-strand (BiDi) 1000BASE-BX, issue #97.
//
// The catalogue could not express the most ordinary short single-mode run there
// is: 1000BASE-BX10, one strand, TX 1310 / RX 1490 at one end and the mirror at
// the other. Every SM optic in the engine was duplex, so a 25 m BX patch across a
// riser had no medium to be drawn with.
//
// A BX run is not one medium with a direction flag, it is two parts that only work
// as a MIRRORED pair:
//
//   -U  TX 1310 nm / RX 1490 nm     (Cisco GLC-BX-U)
//   -D  TX 1490 nm / RX 1310 nm     (Cisco GLC-BX-D)
//
// "A 1000BASE-BX10-D device is always connected to a 1000BASE-BX10-U device with a
// single strand of standard SMF with an operating transmission range up to 10 km."
//   -- Cisco, SFP Modules for Gigabit Ethernet Applications, datasheet c78-366584.
//      IEEE 802.3ah-2004 clause 59 defines the 1000BASE-BX10 PMD.
//
// So the interesting half of this suite is the REFUSALS. U with U is two 1310 nm
// transmitters aimed into each other with both 1490 nm receivers deaf; that is not
// a wrong cable, it is an unbuildable link, and the engine has to say so by name.
//
// Run: node test/bidi-media.test.js        exit 1 on any failure.
// ===========================================================================
const path = require('path');
const { Topology } = require('../engine');
const media = require('../engine/media');
const { loadCatalog } = require('../devices/registry');

const MEDIA = media.MEDIA;
const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg); }
}

const BX_U = '1000base-bx-u';
const BX_D = '1000base-bx-d';
const BX_RUN = '1000base-bx';
const BX_IDS = [BX_U, BX_D, BX_RUN];

// A port that declares the module actually fitted in it. This is the existing
// `media:` override on an interface spec - the same mechanism a spec uses to
// describe any port whose optics are known, and the only way to say "this SFP cage
// holds a -U", because a cage on its own can hold either half.
function opticalPort(mediaIds, opts) {
  const o = opts || {};
  return {
    vendor: '__bidi__',
    model: o.model || ('bx ' + mediaIds.join('+')),
    label: 'BX probe',
    category: 'switch',
    interfaces: [{
      name: 'uplink1', type: 'ethernet', connector: o.connector || 'sfp',
      speed: o.speed || '1G', media: mediaIds
    }]
  };
}

function pairOf(specA, specB) {
  const t = new Topology();
  const a = t.addDevice(specA), b = t.addDevice(specB);
  return { t: t, a: a, b: b };
}

function codesOf(v) {
  return (v.errors || []).map(function (e) { return e.code; }).join('+') || 'none';
}

// ===========================================================================
// 1. The two halves, and the run they make
// ===========================================================================
console.log('The catalogue holds both halves of 1000BASE-BX10:');
{
  const u = MEDIA[BX_U], d = MEDIA[BX_D], run = MEDIA[BX_RUN];
  ok(!!u && !!d, 'a U and a D medium exist (' + BX_U + ', ' + BX_D + ')');

  ok(u && u.txWavelengthNm === 1310 && u.rxWavelengthNm === 1490,
    '-U transmits 1310 nm and receives 1490 nm (' + (u && u.txWavelengthNm) + '/' + (u && u.rxWavelengthNm) + ')');
  ok(d && d.txWavelengthNm === 1490 && d.rxWavelengthNm === 1310,
    '-D transmits 1490 nm and receives 1310 nm (' + (d && d.txWavelengthNm) + '/' + (d && d.rxWavelengthNm) + ')');
  ok(u && d && u.txWavelengthNm === d.rxWavelengthNm && u.rxWavelengthNm === d.txWavelengthNm,
    'and the two are exact mirrors of each other');

  ok(u && u.fiber === 'smf' && d && d.fiber === 'smf', 'both are single-mode');
  ok(u && u.strands === 1 && d && d.strands === 1, 'both run over ONE strand (' + (u && u.strands) + ')');
  ok(u && u.duplex === 'single' && d && d.duplex === 'single', 'and are marked single-strand');
  ok(u && u.speedMbps === 1000 && d && d.speedMbps === 1000, 'both are 1 Gbps parts');
  ok(u && u.matesWith === BX_D && d && d.matesWith === BX_U,
    'each one names its complement as its only mate');
  ok(u && u.maxRangeM === 10000 && d && d.maxRangeM === 10000,
    'reach is the datasheet 10 km class (' + (u && u.maxRangeM) + ' m)');

  // The run is its own medium: neither end's name describes the span.
  ok(!!run && run.linkOnly === true, 'the U/D pair has its own run medium (' + BX_RUN + ')');
  ok(run && run.speedMbps === 1000, 'the run is 1 Gbps (' + (run && run.speedMbps) + ')');
  ok(run && run.strands === 1 && run.maxRangeM === 10000, 'one strand, 10 km');

  // A medium no cage offers is not a module you can pick: it is produced by a pair.
  const offered = Object.keys(media.CAGE_MEDIA).filter(function (cage) {
    const list = media.CAGE_MEDIA[cage](1000) || [];
    return list.indexOf(BX_RUN) !== -1;
  });
  ok(offered.length === 0, 'no cage offers the run medium itself (' + (offered.join(',') || 'none') + ')');

  // Reaching 10 km is a claim about the class, not a limit of 25 m and not ZX's 80 km.
  ok(u.maxRangeM !== 25 && u.maxRangeM !== 80000, 'and 10 km is neither "25 m" nor the 80 km ZX class');

  ok(media.MEDIA_MATE[BX_U] && media.MEDIA_MATE[BX_U].with === BX_D,
    'MEDIA_MATE maps U -> D');
  ok(media.MEDIA_MATE[BX_D] && media.MEDIA_MATE[BX_D].with === BX_U,
    'and D -> U (the relation is a mirror, not a wildcard)');
  ok(media.MEDIA_MATE[BX_U].with !== BX_U && media.MEDIA_MATE[BX_D].with !== BX_D,
    'it is NOT reflexive: no half mates with itself');

  // Every cage that takes a 1G SFP can hold either half - that is what the cage is
  // for - and neither half is ever offered as a link on its own.
  for (const cage of ['sfp', 'sfp+', 'sfp28', 'combo']) {
    const list = media.CAGE_MEDIA[cage](10000) || [];
    ok(list.indexOf(BX_U) !== -1 && list.indexOf(BX_D) !== -1,
      'an ' + cage + ' cage takes either BX half');
  }
}

// ===========================================================================
// 2. U mates with D, at 1 Gbps, over 25 m
// ===========================================================================
console.log('\nA 25 m run of 1000BASE-BX over one strand can be built:');
{
  const P = pairOf(opticalPort([BX_U], { model: 'bx-u' }), opticalPort([BX_D], { model: 'bx-d' }));
  const v = P.t.validateLink(P.a.id, 'uplink1', P.b.id, 'uplink1', { lengthM: 25 });
  ok(v.ok, 'the U end and the D end cable together (' + (v.ok ? 'accepted' : codesOf(v)) + ')');
  ok(v.mediaId === BX_RUN, 'the run is described as ' + BX_RUN + ' (' + v.mediaId + ')');
  ok(v.speedMbps === 1000, 'and negotiates 1000 Mbps (' + v.speedMbps + ')');
  ok((v.media || []).indexOf(BX_RUN) !== -1, 'the run is in the common media list');

  const warn = (v.warnings || []).filter(function (w) { return w.code === 'W_DISTANCE'; })[0];
  ok(!warn, '25 m is well inside the reach, so no distance warning');

  const link = P.t.connect(P.a.id, 'uplink1', P.b.id, 'uplink1', { lengthM: 25 });
  ok(!!link, 'the link is created');
  ok(link.mediaId === BX_RUN && link.speedMbps === 1000,
    'and records the BX run at 1G (' + link.mediaId + ' @' + link.speedMbps + ')');
  ok(link.lengthM === 25, 'with its 25 m length (' + link.lengthM + ')');
}

console.log('\n...in either direction: a D end and a U end are the same link:');
{
  const P = pairOf(opticalPort([BX_D], { model: 'bx-d' }), opticalPort([BX_U], { model: 'bx-u' }));
  const v = P.t.validateLink(P.a.id, 'uplink1', P.b.id, 'uplink1', {});
  ok(v.ok && v.mediaId === BX_RUN && v.speedMbps === 1000,
    'D<->U is accepted as the same run (' + (v.ok ? v.mediaId + ' @' + v.speedMbps : codesOf(v)) + ')');
}

console.log('\n...and it is a 1G link even in a 10G cage:');
{
  // The module sets the rate here, not the port: a 1G SFP in an SFP+ cage still runs
  // at 1G, and a BX pair is a 1G module by definition.
  const P = pairOf(
    opticalPort([BX_U], { connector: 'sfp+', speed: '10G', model: 'bx-u-on-sfp+' }),
    opticalPort([BX_D], { connector: 'sfp+', speed: '10G', model: 'bx-d-on-sfp+' })
  );
  const v = P.t.validateLink(P.a.id, 'uplink1', P.b.id, 'uplink1', {});
  ok(v.ok, 'a BX pair in two SFP+ cages is accepted');
  ok(v.speedMbps === 1000, 'and runs at 1000 Mbps, not 10G (' + v.speedMbps + ')');

  // canMate on its own must agree: it is called by more than validation.js.
  const pa = P.a.interfaces.get('uplink1').hardware, pb = P.b.interfaces.get('uplink1').hardware;
  const mate = media.canMate(pa, pb);
  ok(mate.ok && mate.speedMbps === 1000, 'canMate itself caps the pair at 1G (' +
    (mate.ok ? mate.speedMbps : mate.code) + ')');
}

// ===========================================================================
// 3. U with U is refused, by name
// ===========================================================================
console.log('\nTwo U ends are refused, and the code says why:');
{
  const P = pairOf(opticalPort([BX_U], { model: 'bx-u-1' }), opticalPort([BX_U], { model: 'bx-u-2' }));
  const v = P.t.validateLink(P.a.id, 'uplink1', P.b.id, 'uplink1', {});
  ok(!v.ok, 'U<->U is refused');
  ok(codesOf(v).indexOf('E_BIDI_SAME_WAVELENGTH') !== -1,
    'with E_BIDI_SAME_WAVELENGTH (' + codesOf(v) + ')');
  const msg = (v.errors || []).map(function (e) { return e.message; }).join(' ');
  ok(/1000BASE-BX10-U/.test(msg), 'the message names the part both ends carry');
  ok(msg.indexOf('1310') !== -1 && msg.indexOf('1490') !== -1,
    'and the wavelengths that collide (1310 nm out, 1490 nm expected back)');
  ok(/1000BASE-BX10-D/.test(msg), 'and names the part that would fix it');
  ok(!v.mediaId, 'no medium is chosen for an impossible pair (' + v.mediaId + ')');
  ok(media.commonMedia(P.a.interfaces.get('uplink1').hardware, P.b.interfaces.get('uplink1').hardware).length === 0,
    'and the shared id does NOT count as a common medium');

  // Same refusal from the raw model, with no Topology in the way.
  const mate = media.canMate(P.a.interfaces.get('uplink1').hardware, P.b.interfaces.get('uplink1').hardware);
  ok(!mate.ok && mate.code === 'E_BIDI_SAME_WAVELENGTH', 'canMate refuses it too (' + mate.code + ')');
}

console.log('\nTwo D ends are refused for the mirror reason:');
{
  const P = pairOf(opticalPort([BX_D], { model: 'bx-d-1' }), opticalPort([BX_D], { model: 'bx-d-2' }));
  const v = P.t.validateLink(P.a.id, 'uplink1', P.b.id, 'uplink1', {});
  ok(!v.ok, 'D<->D is refused');
  ok(codesOf(v).indexOf('E_BIDI_SAME_WAVELENGTH') !== -1,
    'with the same code (' + codesOf(v) + ')');
  const msg = (v.errors || []).map(function (e) { return e.message; }).join(' ');
  ok(/1000BASE-BX10-D/.test(msg) && msg.indexOf('1490') !== -1,
    'and the message names the D part and its 1490 nm transmit');
  ok(/1000BASE-BX10-U/.test(msg), 'plus the U part it needs');
}

console.log('\nThe refusal is a pair fact, not a port fact:');
{
  // The same U port is perfectly cablable to a D port - the port was never "bad",
  // the pair was. That distinction is what a symmetric cage-only model could not make.
  const u = opticalPort([BX_U], { model: 'bx-u' });
  const okPair = pairOf(u, opticalPort([BX_D], { model: 'bx-d' }));
  const badPair = pairOf(u, opticalPort([BX_U], { model: 'bx-u-again' }));
  ok(okPair.t.validateLink(okPair.a.id, 'uplink1', okPair.b.id, 'uplink1', {}).ok,
    'the U port links to a D port');
  ok(!badPair.t.validateLink(badPair.a.id, 'uplink1', badPair.b.id, 'uplink1', {}).ok,
    'and refuses another U port');
}

// ===========================================================================
// 4. BX against a duplex single-mode optic is refused
// ===========================================================================
console.log('\n1000BASE-BX will not pair with duplex 1000BASE-LX:');
{
  // Refused, not downgraded. LX transmits 1310 nm on one strand and listens at 1310 nm
  // on the other; a BX-U listens at 1490 nm on its single strand. Wired together, the
  // LX laser arrives on a wavelength the BX receiver is not looking at, and the BX
  // laser arrives at the LX receiver on the wrong strand. There is no common speed to
  // negotiate down TO - the two have no light in common at any rate - so this is
  // E_BIDI_MISMATCH, the same code engine/optical.js gives for a BiDi module paired
  // with a two-strand one.
  const P = pairOf(opticalPort([BX_U], { model: 'bx-u' }), opticalPort(['1000base-lx'], { model: 'lx' }));
  const v = P.t.validateLink(P.a.id, 'uplink1', P.b.id, 'uplink1', {});
  ok(!v.ok, 'BX-U <-> 1000BASE-LX is refused');
  ok(codesOf(v).indexOf('E_BIDI_MISMATCH') !== -1, 'with E_BIDI_MISMATCH (' + codesOf(v) + ')');
  const msg = (v.errors || []).map(function (e) { return e.message; }).join(' ');
  ok(/single-strand/i.test(msg) && /1000BASE-BX10-D/.test(msg),
    'and it explains that a single-strand optic only pairs with its matching half');

  const Q = pairOf(opticalPort([BX_D], { model: 'bx-d' }), opticalPort(['1000base-lx'], { model: 'lx-2' }));
  const v2 = Q.t.validateLink(Q.a.id, 'uplink1', Q.b.id, 'uplink1', {});
  ok(!v2.ok && codesOf(v2).indexOf('E_BIDI_MISMATCH') !== -1,
    'and the same from the D side (' + codesOf(v2) + ')');

  // A copper SFP in the far cage is refused for the plainer reason: no light at all.
  const C = pairOf(opticalPort([BX_U], { model: 'bx-u-c' }), opticalPort(['1000base-t-sfp'], { model: 'copper-sfp' }));
  const vc = C.t.validateLink(C.a.id, 'uplink1', C.b.id, 'uplink1', {});
  ok(!vc.ok && codesOf(vc).indexOf('E_BIDI_MISMATCH') !== -1,
    'and a BX half against a copper SFP module is refused too (' + codesOf(vc) + ')');
  ok((vc.errors || []).some(function (e) { return /not an optical medium/.test(e.message); }),
    'saying the far end carries no light at all');

  // Control: LX against LX is untouched by any of this.
  const R = pairOf(opticalPort(['1000base-lx'], { model: 'lx-3' }), opticalPort(['1000base-lx'], { model: 'lx-4' }));
  const v3 = R.t.validateLink(R.a.id, 'uplink1', R.b.id, 'uplink1', {});
  ok(v3.ok && v3.mediaId === '1000base-lx' && v3.speedMbps === 1000,
    'duplex LX <-> LX still links at 1G (' + (v3.ok ? v3.mediaId + ' @' + v3.speedMbps : codesOf(v3)) + ')');
}

// ===========================================================================
// 5. Reach is the 10 km class, and it is enforced
// ===========================================================================
console.log('\nThe reach figure is the datasheet one, and the length check uses it:');
{
  const P = pairOf(opticalPort([BX_U], { model: 'bx-u-r' }), opticalPort([BX_D], { model: 'bx-d-r' }));
  const at10k = P.t.validateLink(P.a.id, 'uplink1', P.b.id, 'uplink1', { lengthM: 10000 });
  ok(at10k.ok, 'a 10 km run is allowed');
  ok(!(at10k.warnings || []).some(function (w) { return w.code === 'W_DISTANCE'; }),
    'at exactly the rated reach, with no warning');

  const over = P.t.validateLink(P.a.id, 'uplink1', P.b.id, 'uplink1', { lengthM: 10001 });
  const warn = (over.warnings || []).filter(function (w) { return w.code === 'W_DISTANCE'; })[0];
  ok(!!warn, '10 001 m raises W_DISTANCE (' + (warn ? warn.code : 'none') + ')');
  ok(warn && warn.message.indexOf('10000') !== -1,
    'and the warning quotes the 10 km figure (' + (warn ? warn.message : '') + ')');
  ok(over.ok, 'it is a warning, not an impossibility - the link is still buildable');

  // Had the reach been modelled as the length in the issue ("25 m") this would fail,
  // and had it been copied from ZX (80 km) the warning above would never fire.
  ok(MEDIA[BX_RUN].maxRangeM === 10000 && MEDIA[BX_U].maxRangeM === 10000,
    'all three BX media carry maxRangeM 10000');
}

// ===========================================================================
// 6. Duplex single-mode optics are untouched
// ===========================================================================
console.log('\nA plain SFP-to-SFP run is still described as it was:');
{
  // Census: one representative port per cage the catalogue really presents, so the
  // claim below is about real hardware rather than a hand-written port object.
  const census = new Map();
  for (const spec of catalog) {
    let dev;
    try { dev = new Topology().addDevice(spec); } catch (e) { continue; }
    for (const iface of dev.interfaces.values()) {
      const hw = iface.hardware;
      if (!hw || !hw.cage || census.has(hw.cage)) continue;
      census.set(hw.cage, { cage: hw.cage, spec: spec, port: iface.name, media: hw.media.slice() });
    }
  }
  ok(census.size >= 15, 'the census covers the catalogue (' + census.size + ' cages)');

  // Nothing the catalogue presents offers the run as a cable - a cage offers modules,
  // and the run is not a module.
  let offeredRun = 0;
  const unknown = [];
  for (const rep of census.values()) {
    if (rep.media.indexOf(BX_RUN) !== -1) offeredRun++;
    for (const id of rep.media) if (!MEDIA[id] && unknown.indexOf(id) === -1) unknown.push(id);
  }
  ok(offeredRun === 0, 'no catalogue port offers the BX run as a medium (as a cage never should)');
  ok(BX_IDS.every(function (id) { return !!MEDIA[id]; }), 'and every BX id resolves to a medium');
  if (unknown.length) {
    // Pre-existing: some PON ports list 100BASE-FX, which the media table has never
    // defined. Older than this feature and untouched by it - recorded here so the
    // next reader knows it was seen rather than missed.
    console.log('      note: media ids listed by a port but not modelled (pre-existing): ' + unknown.join(', '));
  }

  // For every cage pair: if the two ports still share any medium that existed before
  // this feature, the pair must still be accepted, and it must not be re-described as
  // a BX run. That is precisely "no pre-existing pair changed verdict".
  const cages = Array.from(census.keys()).sort();
  const flipped = [], renamed = [], newlyViaBx = [];
  let pairs = 0, accepted = 0;
  const pre = function (list) { return list.filter(function (id) { return BX_IDS.indexOf(id) === -1; }); };
  for (let i = 0; i < cages.length; i++) {
    for (let j = i; j < cages.length; j++) {
      const ra = census.get(cages[i]), rb = census.get(cages[j]);
      // Only a pair whose cages mate can link at all: sharing a medium is necessary,
      // not sufficient, and a combo position is still not an SC ferrule.
      const sharedBefore = media.cagesMate(ra.cage, rb.cage)
        ? pre(ra.media).filter(function (m) { return pre(rb.media).indexOf(m) !== -1; })
        : [];
      const t = new Topology();
      const da = t.addDevice(JSON.parse(JSON.stringify(ra.spec)));
      const db = t.addDevice(JSON.parse(JSON.stringify(rb.spec)));
      const v = t.validateLink(da.id, ra.port, db.id, rb.port, {});
      pairs++;
      if (v.ok) accepted++;
      if (sharedBefore.length) {
        // E_NO_COMMON_SPEED is the matrix's own documented note class: the cages mate
        // and a medium is shared, but these two ports offer no rate in common (every
        // QSFP28 port here is 100G-only). Not a verdict this feature may change, and
        // not a refusal for a connector or medium reason either.
        const codes = codesOf(v);
        if (!v.ok && codes.indexOf('E_NO_COMMON_SPEED') === -1) {
          flipped.push(cages[i] + ' x ' + cages[j] + ' -> ' + codes);
        } else if (v.ok && BX_IDS.indexOf(v.mediaId) !== -1) {
          renamed.push(cages[i] + ' x ' + cages[j] + ' -> ' + v.mediaId);
        }
      } else if (v.ok) {
        // A pair with nothing in common but a BX half can only be a BX run.
        newlyViaBx.push(cages[i] + ' x ' + cages[j] + ' -> ' + v.mediaId);
      }
    }
  }
  ok(flipped.length === 0, 'every pair that shared a medium before is still accepted' +
    (flipped.length ? ': ' + flipped.slice(0, 4).join('; ') : ''));
  ok(renamed.length === 0, 'and none of them is now described as a BX run' +
    (renamed.length ? ': ' + renamed.slice(0, 4).join('; ') : ''));
  const wrongNew = newlyViaBx.filter(function (s) { return s.indexOf('-> ' + BX_RUN) === -1; });
  ok(wrongNew.length === 0, 'a pair newly accepted can only be accepted AS a BX run' +
    (wrongNew.length ? ': ' + wrongNew.slice(0, 4).join('; ') : ''));
  ok(pairs === cages.length * (cages.length + 1) / 2,
    'every unordered cage pair was checked (' + pairs + ' of ' + cages.length + ' cages)');
  console.log('      ' + accepted + ' accepted / ' + (pairs - accepted) + ' refused across the census');

  // The three pairs a GUI user actually sees, pinned by name.
  function pairVerdict(cageA, cageB) {
    const ra = census.get(cageA), rb = census.get(cageB);
    const t = new Topology();
    const da = t.addDevice(JSON.parse(JSON.stringify(ra.spec)));
    const db = t.addDevice(JSON.parse(JSON.stringify(rb.spec)));
    return t.validateLink(da.id, ra.port, db.id, rb.port, {});
  }
  const sxs = pairVerdict('sfp', 'sfp');
  ok(sxs.ok && sxs.mediaId === '1000base-sx' && sxs.speedMbps === 1000,
    'two SFP ports are still a 1000BASE-SX run at 1G (' + sxs.mediaId + ' @' + sxs.speedMbps + ')');
  const tenG = pairVerdict('sfp+', 'sfp+');
  ok(tenG.ok && tenG.mediaId === '10gbase-sr' && tenG.speedMbps === 10000,
    'two SFP+ ports are still a 10GBASE-SR run at 10G (' + tenG.mediaId + ' @' + tenG.speedMbps + ')');
  const pon = pairVerdict('lc-upc', 'lc-upc');
  ok(pon.ok && pon.mediaId === 'gpon-lc-upc',
    'and two LC/UPC PON ports are still GPON (' + pon.mediaId + ')');
}

console.log('\nA BX run can still be asked for explicitly on ordinary SFP ports:');
{
  // This is how a user draws the run the issue is about without editing a device
  // JSON: both cages can hold either half, so the pair is offered, and the picker
  // can choose it. What it must NOT do is offer a HALF as if it were a cable.
  const censusSfp = catalog.filter(function (s) {
    return (s.interfaces || []).some(function (i) { return i.connector === 'sfp'; });
  })[0];
  const t = new Topology();
  const a = t.addDevice(censusSfp), b = t.addDevice(censusSfp);
  const pa = [...a.interfaces.values()].find(function (i) { return i.hardware.cage === 'sfp'; });
  const pb = [...b.interfaces.values()].find(function (i) { return i.hardware.cage === 'sfp'; });

  const chosen = t.validateLink(a.id, pa.name, b.id, pb.name, { mediaId: BX_RUN });
  ok(chosen.ok && chosen.mediaId === BX_RUN && chosen.speedMbps === 1000,
    'requesting the BX run on two SFP ports works (' + chosen.mediaId + ' @' + chosen.speedMbps + ')');

  const half = t.validateLink(a.id, pa.name, b.id, pb.name, { mediaId: BX_U });
  ok(!half.ok && codesOf(half).indexOf('E_MEDIA_NOT_SUPPORTED') !== -1,
    'but a single half cannot be named as the cable (' + codesOf(half) + ')');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
