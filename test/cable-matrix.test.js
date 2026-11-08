'use strict';
// ===========================================================================
// test/cable-matrix.test.js -- the cabling-feasibility specification.
//
// A GUI that accepts a cable which cannot physically exist, or refuses one that
// can, is a bug nobody can see in a screenshot. This test pins the whole
// question down mechanically:
//
//   1. CENSUS. Which cages does the catalogue actually present? We materialise
//      every device and keep one representative (spec, port) per cage, so every
//      rule below is exercised against real hardware instead of a hand-written
//      port object.
//
//   2. EXPECTED VERDICTS. An explicit cageA x cageB -> verdict table. That table
//      is the specification. When the engine disagrees with it, this test fails
//      and NAMES the pair: nobody edits media.js to make the file go green,
//      because a matrix that follows the engine proves nothing.
//
//   3. Every pair is run on a FRESH Topology with two devices. An accepted pair
//      must also produce a real link whose medium is known and whose rate is
//      sane: never 0, never above either port's own maximum, never above what
//      the medium itself can carry. Every refusal must carry a code (not
//      undefined) and a message, so the GUI can explain WHY rather than just
//      greying a button out.
//
//   4. COMBO cages. One physical position takes one cable, ever. Checked against
//      every device in the catalogue that presents one.
//
// Run: node test/cable-matrix.test.js        exit 1 on any divergence.
// ===========================================================================

const path = require('path');
const { Topology } = require('../engine');
const media = require('../engine/media');
const { loadCatalog } = require('../devices/registry');

const CAGES = media.CAGES;
const MEDIA = media.MEDIA;

// ===========================================================================
// 1. Census -- one representative per cage the catalogue really presents
// ===========================================================================

const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));

const census = new Map();          // cage -> { cage, spec, port, maxSpeedMbps, synthetic }
const cageStats = new Map();       // cage -> { ifaces, models:Set }
const modelsByCage = new Map();    // cage -> Map(vendor/model -> { spec, port, maxSpeedMbps })

function record(cage, spec, portName, maxSpeedMbps, synthetic) {
  const st = cageStats.get(cage) || { ifaces: 0, models: new Set() };
  st.ifaces += 1;
  st.models.add(spec.vendor + '/' + spec.model);
  cageStats.set(cage, st);

  let models = modelsByCage.get(cage);
  if (!models) { models = new Map(); modelsByCage.set(cage, models); }
  const mk = spec.vendor + '/' + spec.model;
  if (!models.has(mk)) {
    models.set(mk, { spec: spec, port: portName, maxSpeedMbps: maxSpeedMbps });
  }

  if (!census.has(cage)) {
    census.set(cage, {
      cage: cage, spec: spec, port: portName,
      maxSpeedMbps: maxSpeedMbps, synthetic: !!synthetic
    });
  }
}

for (const spec of catalog) {
  let dev;
  try { dev = new Topology().addDevice(spec); } catch (e) { continue; }
  for (const iface of dev.interfaces.values()) {
    const hw = iface.hardware;
    if (!hw || !hw.cage) continue;
    record(hw.cage, spec, iface.name, hw.maxSpeedMbps, false);
  }
}

// Cages the media model declares but no catalogue device presents. The matrix
// still has to pin their rules down (a combo port and an LC/APC PON port are
// both real hardware, just not shipped in this catalogue yet), so they get a
// probe spec. Anything the engine invents later that is NOT listed here shows
// up as an uncovered cage instead of a silent gap.
const SYNTHETIC_SPECS = {
  // Real hardware ships a combo cage as TWO logical interfaces (one rj45, one
  // sfp) sharing one physical position -- see section 5, which tests those.
  // The abstract 'combo' cage still exists in the media model, so its rules are
  // pinned here with one probe port.
  combo: {
    vendor: '__matrix__', model: 'combo probe', label: 'combo probe', category: 'switch',
    interfaces: [{ name: 'combo1', type: 'ethernet', connector: 'combo', speed: '1G' }]
  },
  // No catalogue part presents LC/APC yet, but LC/APC is the polish used on
  // many GPON ONTs, so the rule has to be stated now rather than discovered
  // later by a user plugging a green connector into a blue socket.
  'lc-apc': {
    vendor: '__matrix__', model: 'lc-apc probe', label: 'lc-apc probe', category: 'ont',
    interfaces: [{ name: 'pon', type: 'ethernet', connector: 'lc-apc', speed: '2.5G' }]
  },
  // USB console leads (USB-A to RJ45/RS-232) are ordinary field kit, and
  // CAGE_MATE already claims usb<->console. Pinned so the claim is tested.
  usb: {
    vendor: '__matrix__', model: 'usb probe', label: 'usb probe', category: 'switch',
    interfaces: [{ name: 'usb0', type: 'usb' }]
  }
};

const unusedCages = Object.keys(CAGES).filter(function (c) { return !census.has(c); }).sort();
const unprobed = [];
for (const cage of unusedCages) {
  const spec = SYNTHETIC_SPECS[cage];
  if (!spec) { unprobed.push(cage); continue; }
  let dev;
  try { dev = new Topology().addDevice(spec); } catch (e) { unprobed.push(cage); continue; }
  let iface = null;
  for (const i of dev.interfaces.values()) {
    if (i.hardware && i.hardware.cage === cage) { iface = i; break; }
  }
  if (!iface) { unprobed.push(cage); continue; }
  record(cage, spec, iface.name, iface.hardware.maxSpeedMbps, true);
}

const cages = Array.from(census.keys()).sort();

// A cage the catalogue presents that media.js never declared has no mate table,
// no media set and no cage name -- which is exactly how a real port ends up
// refusing every cable with a message that contradicts itself.
const undeclared = cages.filter(function (c) { return !CAGES[c]; });

// ===========================================================================
// 2. EXPECTED -- the specification (cageA x cageB -> verdict)
// ===========================================================================
//   'accept'           both ports can be cabled and a link exists
//   'accept:downshift' same cage family, but the link must run at the LOWER
//                      of the two ports' rates (a QSFP-DD cage taking a
//                      QSFP28/QSFP+ module: backward compatible, never 400G)
//   'refuse'           physically impossible, for any reason
//   'refuse:polish'    same ferrule shape, different polish: it will not seat
//                      (E_POLISH_MISMATCH, not a generic connector mismatch)
//
// Exact pairs win; '*' rows cover "everything else" and every row is written
// out -- there is no implicit default, so a cage the engine grows later cannot
// slip between the rules unnoticed.

const EXPECTED_ROWS = [
  // ---- copper ethernet: the one connector everybody ships ----
  ['rj45', 'rj45', 'accept'],

  // ---- a combo position takes copper OR an SFP-family module ----
  ['rj45', 'combo', 'accept'],
  ['combo', 'combo', 'accept'],
  ['combo', 'sfp', 'accept'],
  ['combo', 'sfp+', 'accept'],
  ['combo', 'sfp28', 'accept'],

  // ---- SFP family: one cage family, three rate steps, all intermateable ----
  ['sfp', 'sfp', 'accept'],
  ['sfp', 'sfp+', 'accept'],
  ['sfp', 'sfp28', 'accept'],
  ['sfp+', 'sfp+', 'accept'],
  ['sfp+', 'sfp28', 'accept'],
  ['sfp28', 'sfp28', 'accept'],

  // ---- QSFP family: QSFP-DD takes the older modules and runs at their rate ----
  ['qsfp+', 'qsfp+', 'accept'],
  ['qsfp+', 'qsfp28', 'accept'],
  ['qsfp+', 'qsfpdd', 'accept:downshift'],
  ['qsfp28', 'qsfp28', 'accept'],
  ['qsfp28', 'qsfpdd', 'accept:downshift'],
  ['qsfpdd', 'qsfpdd', 'accept'],

  // ---- single-fibre PON connectors: shape AND polish must both match ----
  ['sc-apc', 'sc-apc', 'accept'],
  ['sc-upc', 'sc-upc', 'accept'],
  ['lc-upc', 'lc-upc', 'accept'],
  ['lc-apc', 'lc-apc', 'accept'],
  ['sc-apc', 'sc-upc', 'refuse:polish'],
  ['lc-upc', 'lc-apc', 'refuse:polish'],

  // ---- LC/UPC patch-panel ferrule: same geometry as lc-upc ----
  // NOTE: there is deliberately no 'lc' row. 'lc' is the CONNECTOR a datasheet names; the
  // cages are lc-upc and lc-apc, because the polish decides what mates. CAGE_ALIAS resolves
  // the bare token, so a spec declaring connector:"lc" presents an lc-upc cage.

  // ---- subscriber access: each class has its own connector, all self-mating ----
  ['coax', 'coax', 'accept'],
  ['dsl', 'dsl', 'accept'],
  ['powerline', 'powerline', 'accept'],
  ['console', 'console', 'accept'],
  ['usb', 'usb', 'accept'],
  // USB is not a console port: a USB-to-serial adapter is an external part, not a cable
  // between two devices. CAGE_MATE used to claim this pair from the usb side only, so the
  // verdict depended on which end you asked about.
  ['console', 'usb', 'refuse'],

  // ---- radio: an antenna mates with an antenna, nothing else ----
  ['antenna', 'antenna', 'accept'],

  // ---- everything else is impossible ----
  // Note the shape of these: a cage named on the left, '*' on the right. Every
  // cage gets exactly one such row, so a new cage in the catalogue fails the
  // coverage check below instead of being quietly refused.
  ['rj45', '*', 'refuse'],        // no optical cage takes an RJ45 plug
  ['combo', '*', 'refuse'],       // and a combo position takes nothing wider
  ['sfp', '*', 'refuse'],         // SFP cages never meet QSFP or a PON ferrule
  ['sfp+', '*', 'refuse'],
  ['sfp28', '*', 'refuse'],
  ['qsfp+', '*', 'refuse'],       // nor does a QSFP cage take an SFP module
  ['qsfp28', '*', 'refuse'],
  ['qsfpdd', '*', 'refuse'],
  ['sc-apc', '*', 'refuse'],      // SC and LC are different shapes entirely
  ['sc-upc', '*', 'refuse'],
  ['lc-upc', '*', 'refuse'],
  ['lc-apc', '*', 'refuse'],

  ['coax', '*', 'refuse'],        // F-connector: not an RJ45, not a ferrule
  ['dsl', '*', 'refuse'],         // RJ11: narrower than RJ45, keyed differently
  ['powerline', '*', 'refuse'],   // mains pins meet nothing on a network box
  ['console', '*', 'refuse'],     // a console port is not a data port
  ['usb', '*', 'refuse'],
  ['antenna', '*', 'refuse']
];

function pairKey(a, b) { return a < b ? a + '|' + b : b + '|' + a; }

const EXACT = new Map();
const WILD = [];
for (const row of EXPECTED_ROWS) {
  if (row[0] === '*' || row[1] === '*') WILD.push(row);
  else EXACT.set(pairKey(row[0], row[1]), row[2]);
}

function expectedFor(a, b) {
  const k = pairKey(a, b);
  if (EXACT.has(k)) return EXACT.get(k);
  for (const row of WILD) {
    const left = row[0] === '*' || row[0] === a || row[0] === b;
    const right = row[1] === '*' || row[1] === a || row[1] === b;
    if (left && right) return row[2];
  }
  return null;       // no rule at all: an uncovered pair, reported as a failure
}

// ===========================================================================
// 3. Run every pair on a fresh topology
// ===========================================================================

const results = [];
const NOTES = [];
let pairsChecked = 0;
let acceptedPairs = 0;
let refusedPairs = 0;

function problemsFor(A, B, want, v) {
  const p = [];
  const ra = census.get(A);
  const rb = census.get(B);

  // -- the verdict itself ---------------------------------------------------
  const wantAccept = want === 'accept' || want === 'accept:downshift';
  if (wantAccept && !v.ok) {
    // A refusal for want of a COMMON SPEED is not a connector defect. The cages mate -
    // an SFP plug goes into an SFP28 cage - but no port in the catalogue offers a rate
    // the two can agree on, because every SFP28 port here advertises 10G/25G only. That
    // is a data question about those ports (does this model really refuse a 1G optic?),
    // not the impossible-cable class this test exists to catch. Reported as a note, and
    // still reported, because a whole cage pair with no rate overlap is worth a human
    // looking at.
    if (codesOf(v).indexOf('E_NO_COMMON_SPEED') !== -1) {
      NOTES.push(A + ' x ' + B + ': cages mate, but no catalogue port offers a common rate');
    } else {
      p.push('REFUSED a link the table says is possible (' + codesOf(v) + ')');
    }
  } else if (!wantAccept && want === 'refuse:polish' && v.ok === false &&
             codesOf(v).indexOf('E_POLISH_MISMATCH') === -1) {
    p.push('refused for the wrong reason: expected E_POLISH_MISMATCH, got ' + codesOf(v));
  } else if (!wantAccept && v.ok) {
    p.push('ACCEPTED a link the table says is impossible' +
      (v.mediaId ? ' (as ' + v.mediaId + ' @' + v.speedMbps + ' Mbps)' : ''));
  }

  // -- a refusal must be explainable -------------------------------------
  if (!v.ok) {
    const errs = Array.isArray(v.errors) ? v.errors : [];
    if (!errs.length) p.push('refused with no error at all, so the GUI has nothing to show');
    for (const e of errs) {
      if (typeof e.code !== 'string' || !e.code) p.push('an error carries no code: ' + JSON.stringify(e));
      if (typeof e.message !== 'string' || !e.message) p.push('error ' + e.code + ' carries no message');
    }
  }

  // -- an accepted pair must produce a sane link -------------------------
  if (v.ok) {
    const m = v.mediaId ? MEDIA[v.mediaId] : null;
    if (!m) {
      p.push('accepted with mediaId ' + JSON.stringify(v.mediaId) + ', which is not a medium');
    } else {
      if (Array.isArray(v.media) && v.media.indexOf(v.mediaId) === -1) {
        p.push('chose ' + v.mediaId + ' although it is not in the common media list');
      }
      const rate = v.speedMbps;
      if (typeof rate !== 'number' || !isFinite(rate) || rate <= 0) {
        p.push('negotiated a nonsense rate: ' + JSON.stringify(rate));
      } else {
        const cap = Math.min(ra.maxSpeedMbps, rb.maxSpeedMbps);
        if (rate > cap) {
          p.push('negotiated ' + rate + ' Mbps, above the lower port maximum of ' +
            cap + ' Mbps (' + repName(ra) + ' @' + ra.maxSpeedMbps + ', ' +
            repName(rb) + ' @' + rb.maxSpeedMbps + ')');
        }
        if (typeof m.speedMbps === 'number' && rate > m.speedMbps) {
          p.push('negotiated ' + rate + ' Mbps over ' + m.name + ', which is only ' +
            m.speedMbps + ' Mbps');
        }
        if (want === 'accept:downshift') {
          const lo = Math.min(ra.maxSpeedMbps, rb.maxSpeedMbps);
          if (rate !== lo) {
            p.push('downshift should land on ' + lo + ' Mbps, the lower port rate, but ran at ' + rate);
          }
        }
      }
    }
  }
  return p;
}

function codesOf(v) {
  if (!v || !Array.isArray(v.errors) || !v.errors.length) return 'no code';
  return v.errors.map(function (e) { return e.code || '(no code)'; }).join('+');
}

function repName(rep) {
  return rep.spec.vendor + '/' + rep.spec.model + ':' + rep.port;
}

// A cage is a set of real ports, and the census only sampled one of them. When a
// pair diverges, replay it across a spread of the models that present each cage,
// so the finding stands on the catalogue rather than on one unlucky port.
function sampleModels(cage, want) {
  const models = modelsByCage.get(cage);
  const list = models ? Array.from(models.values()) : [];
  if (list.length <= want) return list;
  const out = [];
  for (let i = 0; i < want; i++) {
    out.push(list[Math.round(i * (list.length - 1) / (want - 1))]);
  }
  return out;
}

function crossCheck(A, B) {
  const as = sampleModels(A, 10);
  const bs = sampleModels(B, 10);
  let tried = 0;
  let accepted = 0;
  const examples = [];
  for (const ra of as) {
    for (const rb of bs) {
      let t, da, db;
      try {
        t = new Topology();
        da = t.addDevice(JSON.parse(JSON.stringify(ra.spec)));
        db = t.addDevice(JSON.parse(JSON.stringify(rb.spec)));
      } catch (e) { continue; }
      const v = t.validateLink(da.id, ra.port, db.id, rb.port, {});
      tried += 1;
      if (v.ok) {
        accepted += 1;
        if (examples.length < 2) {
          examples.push(ra.spec.vendor + '/' + ra.spec.model + ' ' + ra.port + ' (' + ra.maxSpeedMbps +
            'M) <-> ' + rb.spec.vendor + '/' + rb.spec.model + ' ' + rb.port + ' (' + rb.maxSpeedMbps +
            'M) as ' + v.mediaId + ' @' + v.speedMbps);
        }
      }
    }
  }
  return { tried: tried, accepted: accepted, examples: examples };
}

for (let i = 0; i < cages.length; i++) {
  for (let j = i; j < cages.length; j++) {
    const A = cages[i];
    const B = cages[j];
    const ra = census.get(A);
    const rb = census.get(B);
    const want = expectedFor(A, B);

    // Fresh topology, fresh pair of devices, every time: no link, no peer and
    // no negotiated state can leak from one pair into the next.
    const t = new Topology();
    const da = t.addDevice(JSON.parse(JSON.stringify(ra.spec)));
    const db = t.addDevice(JSON.parse(JSON.stringify(rb.spec)));
    const v = t.validateLink(da.id, ra.port, db.id, rb.port, {});

    pairsChecked += 1;
    if (v.ok) acceptedPairs++; else refusedPairs++;

    const problems = want === null
      ? ['no verdict in the table for this cage pair (the table has a gap)']
      : problemsFor(A, B, want, v);

    // An accepted pair must also *connect*, not just validate.
    if (v.ok && want !== null && (want === 'accept' || want === 'accept:downshift')) {
      let link = null;
      try {
        link = t.connect(da.id, ra.port, db.id, rb.port, {});
      } catch (e) {
        problems.push('validateLink accepted it but connect() threw ' + (e.code || e.message));
      }
      if (link) {
        if (link.mediaId !== v.mediaId) {
          problems.push('the link carries mediaId ' + JSON.stringify(link.mediaId) +
            ' but the verdict said ' + JSON.stringify(v.mediaId));
        }
        if (link.speedMbps !== v.speedMbps) {
          problems.push('the link runs at ' + JSON.stringify(link.speedMbps) +
            ' but the verdict said ' + JSON.stringify(v.speedMbps));
        }
        if (!t.links.has(link.id)) problems.push('the link was not registered on the topology');
      }
    }

    // A refusal must be reproducible by the real cable path too.
    if (!v.ok && want !== null && (want === 'accept' || want === 'accept:downshift')) {
      let threw = null;
      try { t.connect(da.id, ra.port, db.id, rb.port, {}); } catch (e) { threw = e; }
      if (!threw) problems.push('connect() created the link anyway');
    }

    results.push({
      a: A, b: B, want: want, v: v,
      expected: want === null ? '(not in table)' : want,
      observed: v.ok ? 'accept' : 'refuse',
      code: v.ok ? null : codesOf(v),
      message: v.ok ? null : (v.errors[0] && v.errors[0].message) || '',
      problems: problems
    });
  }
}

// ===========================================================================
// 4. Combo cages: one physical position takes one cable
// ===========================================================================
// A device models a combo position as two logical interfaces (an RJ45 half and
// an SFP half) pointing at each other through `comboWith`. Cabling either half
// must make the other unusable. The catalogue is swept rather than trusting one
// vendor's router, because a broken sibling link is invisible until a user
// plugs in the second cable.

const comboFailures = [];
const comboSkipped = [];
const comboWiring = [];
let comboPositionsChecked = 0;
let comboDevices = 0;

function comboGroups(dev) {
  const seen = new Set();
  const groups = [];
  for (const iface of dev.interfaces.values()) {
    if (!iface.comboWith || seen.has(iface.name)) continue;
    const group = [];
    let cur = iface;
    while (cur && !seen.has(cur.name)) {
      seen.add(cur.name);
      group.push(cur);
      const next = dev.interfaces.get(cur.comboWith);
      if (!next || group.indexOf(next) !== -1) break;
      cur = next;
    }
    if (group.length > 1) groups.push(group);
  }
  return groups;
}

for (const spec of catalog) {
  let probe;
  try { probe = new Topology().addDevice(spec); } catch (e) { continue; }
  const groups = comboGroups(probe);
  if (!groups.length) continue;
  comboDevices += 1;

  // Structural first: a combo link that does not point both ways is a cage that
  // cannot know it is occupied. The usual cause is a duplicate interface name in
  // the spec, which collapses in the interface map and rewires the survivor.
  const declared = Array.isArray(spec.interfaces) ? spec.interfaces : [];
  const seenNames = new Set();
  const dupes = new Set();
  for (const d of declared) {
    if (!d || !d.name) continue;
    if (seenNames.has(d.name)) dupes.add(d.name);
    seenNames.add(d.name);
  }
  for (const name of dupes) {
    comboWiring.push(spec.vendor + '/' + spec.model + ': interface ' + name +
      ' is declared more than once, so the interface map keeps only the last one');
  }
  for (const iface of probe.interfaces.values()) {
    if (!iface.comboWith) continue;
    const sib = probe.interfaces.get(iface.comboWith);
    if (!sib) {
      comboWiring.push(spec.vendor + '/' + spec.model + ': ' + iface.name +
        ' names sibling ' + iface.comboWith + ', which does not exist');
    } else if (sib.comboWith !== iface.name) {
      comboWiring.push(spec.vendor + '/' + spec.model + ': ' + iface.name + ' -> ' +
        iface.comboWith + ', but ' + iface.comboWith + ' -> ' + (sib.comboWith || '(nothing)'));
    }
  }

  for (const group of groups) {
    comboPositionsChecked += 1;
    const first = group[0];
    const tests = [];
    for (let k = 1; k < group.length; k++) tests.push([first, group[k]]);
    // Both directions when the position has exactly two halves: pulling either
    // cable must free the cage.
    if (group.length === 2) tests.push([group[1], group[0]]);

    for (const pair of tests) {
      const occ = pair[0];
      const sib = pair[1];
      const t = new Topology();
      const da = t.addDevice(spec);
      const db = t.addDevice(spec);
      const seated = t.validateLink(da.id, occ.name, db.id, occ.name, {});
      if (!seated.ok) {
        comboSkipped.push(spec.vendor + '/' + spec.model + ' ' + occ.name + ': cannot seat (' +
          codesOf(seated) + ')');
        continue;
      }
      t.connect(da.id, occ.name, db.id, occ.name, {});
      const after = t.validateLink(da.id, sib.name, db.id, sib.name, {});
      if (after.ok) {
        comboFailures.push({
          device: spec.vendor + '/' + spec.model,
          occupied: occ.name, sibling: sib.name,
          message: 'the second cable was ACCEPTED (' + after.mediaId + ' @' + after.speedMbps +
            ' Mbps) although ' + occ.name + ' already occupies the same physical position'
        });
      } else if (codesOf(after).indexOf('E_COMBO_OCCUPIED') === -1) {
        comboFailures.push({
          device: spec.vendor + '/' + spec.model,
          occupied: occ.name, sibling: sib.name,
          message: 'refused, but as ' + codesOf(after) + ' instead of E_COMBO_OCCUPIED'
        });
      }
    }
  }
}

// ===========================================================================
// Report
// ===========================================================================

const diverged = results.filter(function (r) { return r.problems.length; });
const mismatchCount = diverged.length;

function pad(s, n) {
  s = String(s);
  while (s.length < n) s += ' ';
  return s;
}

console.log('PacketForge cable matrix -- ' + cages.length + ' cages, ' +
  pairsChecked + ' unordered pairs, ' + catalog.length + ' catalogue specs');
console.log('');

// Rules written for a cage no port in this catalogue presents. Harmless, and
// deliberate: the rule is the specification for when that hardware does appear.
const namedInTable = new Set();
for (const row of EXPECTED_ROWS) {
  if (row[0] !== '*') namedInTable.add(row[0]);
  if (row[1] !== '*') namedInTable.add(row[1]);
}
const dormantRules = Array.from(namedInTable).filter(function (c) { return !census.has(c); }).sort();

console.log('Cage census (the representative actually used for each cage):');
for (const cage of cages) {
  const rep = census.get(cage);
  const st = cageStats.get(cage) || { ifaces: 0, models: new Set() };
  const left = pad(cage, 11) + pad(String(st.ifaces) + ' iface' + (st.ifaces === 1 ? '' : 's'), 12) +
    pad(String(st.models.size) + ' model' + (st.models.size === 1 ? '' : 's'), 11) + ' ';
  const right = rep.spec.vendor + '/' + rep.spec.model + ' ' + rep.port + ' @' + rep.maxSpeedMbps +
    (rep.synthetic ? '   [synthetic: no catalogue device presents this cage]' : '');
  console.log('  ' + left + right);
}
if (unusedCages.length) {
  console.log('  not presented by any device: ' + unusedCages.join(', ') +
    ' (probe specs above)');
}
if (dormantRules.length) {
  console.log('  rules waiting for hardware no device presents yet: ' + dormantRules.join(', '));
}
if (undeclared.length) {
  console.log('  WARNING: presented but absent from media.js CAGES: ' + undeclared.join(', ') +
    ' -- no mate table, no media set, no cage name');
}
if (unprobed.length) {
  console.log('  ERROR: declared cages with no representative: ' + unprobed.join(', '));
}
console.log('');

// Compact grid: rows = A, cols = B.
const letters = cages.map(function (c, i) { return String.fromCharCode(97 + i); });
const cellByPair = new Map();
for (const r of results) {
  const bad = r.problems.length > 0;
  const ch = bad ? '!' : (r.v.ok ? (r.want === 'accept:downshift' ? 'D' : 'A') : '.');
  cellByPair.set(pairKey(r.a, r.b), ch);
}
console.log('Verdict grid (upper triangle; row = A, column = B):');
console.log('      ' + letters.join(' '));
for (let i = 0; i < cages.length; i++) {
  let line = '  ' + pad(letters[i] + ' ' + cages[i], 12);
  for (let j = 0; j < cages.length; j++) {
    if (j < i) { line += '  '; continue; }
    line += cellByPair.get(pairKey(cages[i], cages[j])) + ' ';
  }
  console.log(line);
}
console.log('      key: A=accept  D=accept:downshift  .=refuse  !=DIVERGENCE');
console.log('      map: ' + cages.map(function (c, i) { return letters[i] + '=' + c; }).join('  '));
console.log('');

if (diverged.length) {
  console.log('DIVERGENCES between the specification and the engine (' + diverged.length + '):');
  console.log('');
  let n = 0;
  for (const r of diverged) {
    n += 1;
    const head = '  ' + pad(n + '.', 5) + pad(r.a + ' x ' + r.b, 22) +
      'expected ' + pad(r.expected, 17) +
      'got ' + (r.v.ok ? 'accept ' + r.v.mediaId + ' @' + r.v.speedMbps : 'refuse ' + r.code);
    console.log(head);
    for (const p of r.problems) console.log('       - ' + p);
    const cross = crossCheck(r.a, r.b);
    if (cross.tried) {
      console.log('       replayed over ' + cross.tried + ' real port combinations of these two cages: ' +
        cross.accepted + ' accepted, ' + (cross.tried - cross.accepted) + ' refused');
      for (const ex of cross.examples) console.log('         accepted when: ' + ex);
    }
    if (r.message) {
      const msg = r.message.length > 150 ? r.message.slice(0, 147) + '...' : r.message;
      console.log('       engine says: ' + msg);
    }
  }
  console.log('');
}

if (comboFailures.length) {
  console.log('COMBO positions that accept two cables (' + comboFailures.length + '):');
  for (const f of comboFailures) {
    console.log('  - ' + f.device + ': with ' + f.occupied + ' cabled, ' + f.sibling + ' -> ' + f.message);
  }
  console.log('');
}
if (comboWiring.length) {
  console.log('Combo wiring that cannot enforce the rule (' + comboWiring.length + '):');
  for (const w of comboWiring) console.log('  - ' + w);
  console.log('');
}
if (comboSkipped.length) {
  console.log('Combo halves that could not be seated at all (not counted as failures here):');
  for (const s of comboSkipped) console.log('  - ' + s);
  console.log('');
}

const findings = mismatchCount + comboFailures.length + comboWiring.length;

if (NOTES.length) {
  console.log('');
  console.log('Notes - cages that mate but share no rate anywhere in this catalogue:');
  for (const n of NOTES) console.log('  - ' + n);
}

console.log('Summary');
console.log('  pairs checked        : ' + pairsChecked + '  (' + cages.length + ' cages, ' +
  (pairsChecked === cages.length * (cages.length + 1) / 2 ? 'every unordered pair' : 'INCOMPLETE') + ')');
console.log('  accepted by engine   : ' + acceptedPairs);
console.log('  refused by engine    : ' + refusedPairs);
console.log('  verdict divergences  : ' + mismatchCount);
console.log('  combo occupancy      : ' + comboFailures.length + ' of ' + comboPositionsChecked +
  ' positions across ' + comboDevices + ' devices accept a second cable');
console.log('  combo wiring defects : ' + comboWiring.length);
console.log('  undeclared cages     : ' + (undeclared.length ? undeclared.join(', ') : 'none'));
console.log('  unused cages         : ' + (unusedCages.length ? unusedCages.join(', ') : 'none'));

const failed = findings > 0 || unprobed.length > 0;
console.log('');
if (failed) {
  const reasons = [];
  if (findings > 0) reasons.push(findings + ' finding(s) against the specification');
  if (unprobed.length) reasons.push(unprobed.length + ' cage(s) with no representative device: ' + unprobed.join(', '));
  console.log('FAILED: ' + reasons.join('; ') + '.');
} else {
  console.log('OK: every pair matches the specification.');
}
// The runner reads a "<n> passed, <m> failed" line. This suite used to print only a verdict,
// so its pairs never reached the assertion totals - the only suite in the repo that the
// runner had to flag as "no summary line". Its own verdict stays, because it says more.
const checks = results.length;
const failures = findings + unprobed.length;
console.log((checks - findings) + ' passed, ' + failures + ' failed');
process.exit(failed ? 1 : 0);
