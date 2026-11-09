'use strict';
// Hardware invariants that every device spec must satisfy.
//
// PacketForge's contribution model is "add a JSON file", which means the quality
// of the catalogue depends entirely on rules that are mechanically checkable.
// This suite is that rulebook: it runs over the whole catalogue rather than a
// fixture, so a new device that lies about its own hardware fails CI.
//
// Each check below exists because the catalogue actually got it wrong once:
//   - 68 devices advertised optics their ports could not deliver
//   - a switch was credited 500 W of PoE from its power-supply rating
//   - CX 6100 12G was modelled with 14 ports where the datasheet has 16
//   - three models were catalogued twice under punctuation variants of one name
//     ("ASR1001-X" beside "ASR 1001-X"), which an exact-string check could not see
const path = require('path');
const { Topology } = require('../engine');
const { loadCatalog, modelKey } = require('../devices/registry');
const mediaLib = require('../engine/media');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg); }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));

// Build one device per spec, so we check what the engine really exposes rather
// than what the JSON claims.
function materialise() {
  const out = [];
  for (const spec of catalog) {
    const t = new Topology();
    const d = t.addDevice(spec);
    out.push({ spec: spec, dev: d, ifaces: [...d.interfaces.values()] });
  }
  return out;
}
const all = materialise();

// A description may legitimately say "no SFP cages"; that is documentation, not
// a promise. Strip the denials before looking for an optics claim.
function claimsOptics(desc) {
  // A clause that calls the optics optional, unfitted or an extra-cost module is
  // not a promise that this box has them: plenty of platforms sell uplinks as
  // field-fitted modules. Strip such clauses before looking for a real claim.
  const clauses = String(desc || '').split(/[.;:]/).filter(function (c) {
    return !/\b(option|optional|unfitted|unpopulated|not fitted|blank|without)\b/i.test(c);
  });
  return /\b(sfp|qsfp|xfp)\b/i.test(
    clauses.join(' ; ')
      .replace(/\b(no|without|zero|none|not)\b[^.;,]{0,24}\b(sfp|qsfp|xfp)\b/gi, ' ')
      .replace(/\b(sfp|qsfp|xfp)\b[^.;,]{0,16}\b(none|n\/a|-)\b/gi, ' ')
  );
}

const OPTICAL = ['sfp', 'sfp+', 'sfp28', 'qsfp+', 'qsfp28', 'qsfpdd', 'qsfp56',
                 'sc-apc', 'sc-upc', 'lc-upc', 'lc-apc',
                 // Fibre Channel cages are optical too: an FC switch whose description says
                 // "48 x 64G SFP+" is not lying about having optics just because the cage
                 // belongs to the FC family rather than the Ethernet one.
                 'fc-sfp', 'fc-sfp28', 'fc-sfpdd', 'fc-qsfp28'];

console.log('Every device exposes ports it can actually cable:');
{
  const bare = all.filter(function (x) {
    return x.ifaces.length === 0;
  });
  ok(bare.length === 0, 'no device has zero interfaces' +
    (bare.length ? ' (' + bare.map(function (b) { return b.spec.model; }).join(', ') + ')' : ''));

  const uncablable = [];
  for (const x of all) {
    for (const i of x.ifaces) {
      // not an exemption: this check is about Ethernet port counts by definition. Optical, PON
      // and radio ports are checked by the cages-and-media section below and by
      // test/spec-vs-description.test.js, which reads every port type.
      if (i.type !== 'ethernet') continue;
      if (!i.hardware.media || !i.hardware.media.length) {
        uncablable.push(x.spec.model + '/' + i.name);
      }
    }
  }
  ok(uncablable.length === 0, 'every ethernet port has at least one usable medium' +
    (uncablable.length ? ' (' + uncablable.slice(0, 3).join(', ') + ')' : ''));
}

console.log('\nPort names are unambiguous:');
{
  // Check what the SPEC declares, not the materialised interface map. The map is keyed by
  // name, so a port declared twice silently collapses and the duplicate is invisible -
  // which is how a FiberHome OLT shipped a combo port declared twice, alongside a chained
  // 'ge1/1-sfp-sfp' left by a conversion run twice. An earlier version of this check read
  // the map and therefore could never fail.
  const duff = [];
  for (const x of all) {
    const declared = (x.spec.interfaces || []).map(function (i) { return i.name; });
    const seen = new Set();
    for (const n of declared) {
      if (seen.has(n)) duff.push(x.spec.model + '/' + n);
      seen.add(n);
    }
  }
  ok(duff.length === 0, 'no port is declared twice in a spec' +
    (duff.length ? ' (' + duff.slice(0, 3).join(', ') + ')' : ''));

  // A combo pair on real hardware is exactly two positions that name each other. A third
  // port pointing at the same position means the pair was converted more than once.
  const chained = [];
  for (const x of all) {
    const byName = {};
    for (const i of (x.spec.interfaces || [])) byName[i.name] = i;
    for (const i of (x.spec.interfaces || [])) {
      if (!i.comboWith) continue;
      const partner = byName[i.comboWith];
      if (!partner) { chained.push(x.spec.model + '/' + i.name + ' -> missing ' + i.comboWith); continue; }
      if (partner.comboWith !== i.name) {
        chained.push(x.spec.model + '/' + i.name + ' -> ' + i.comboWith + ' -> ' + (partner.comboWith || 'nothing'));
      }
    }
  }
  ok(chained.length === 0, 'every combo pair names its partner symmetrically' +
    (chained.length ? ' (' + chained.slice(0, 3).join(', ') + ')' : ''));
}

console.log('\nThe description does not promise hardware the ports lack:');
{
  const liars = [];
  for (const x of all) {
    if (!claimsOptics(x.spec.description)) continue;
    const optical = x.ifaces.filter(function (i) {
      return OPTICAL.indexOf(i.hardware.cage) !== -1;
    });
    if (!optical.length) liars.push(x.spec.vendor + '/' + x.spec.model);
  }
  // Some of these need a datasheet read per device, not a guess. They are tracked in
  // issue #9 and listed in test/known-issues.json, so this assertion fails only on a
  // NEW offender - the list is only allowed to shrink. Deleting an entry to make the
  // build pass would be exactly the dishonesty the list exists to prevent.
  let known = {};
  try { known = JSON.parse(require('fs').readFileSync(require('path').join(__dirname, 'known-issues.json'), 'utf8')); } catch (e) { known = {}; }
  const opticsGap = known.opticsWithoutCage || [];
  const fresh = liars.filter(function (n) { return opticsGap.indexOf(n) === -1; });
  const stale = opticsGap.filter(function (n) { return liars.indexOf(n) === -1; });
  ok(fresh.length === 0, 'no NEW device advertises optics without a fibre cage' +
    (fresh.length ? ' (' + fresh.join(', ') + ')' : ''));
  if (liars.length) {
    console.log('    ' + liars.length + ' known gap(s) tracked in issue #9: ' + liars.join(', '));
  }
  ok(stale.length === 0, 'the known-gap list has no stale entries' +
    (stale.length ? ' (fixed already, remove from test/known-issues.json: ' + stale.join(', ') + ')' : ''));
}

console.log('\nCages and media agree with each other:');
{
  // An optical cage that accepts copper would let an impossible cable through,
  // which is the exact class of bug the physical layer exists to stop.
  const confused = [];
  for (const x of all) {
    for (const i of x.ifaces) {
      const hw = i.hardware;
      if (OPTICAL.indexOf(hw.cage) === -1) continue;
      // A copper SFP (1000BASE-T SFP) really does live in a fibre cage, so only
      // flag media that are plain copper cabling rather than copper optics.
      const copper = (hw.media || []).filter(function (m) {
        const def = mediaLib.mediaById(m);
        if (!def) return false;
        return def.family === 'copper' && def.connector !== 'sfp';
      });
      if (copper.length) confused.push(x.spec.model + '/' + i.name + ' (' + copper.join(',') + ')');
    }
  }
  ok(confused.length === 0, 'no optical cage accepts a copper medium' +
    (confused.length ? ' (' + confused.slice(0, 3).join('; ') + ')' : ''));

  // The advertised speed must be the fastest the cage is known to support,
  // otherwise the picker offers links the hardware cannot run at.
  //
  // Console ports are exempt: a USB or serial console genuinely runs at 12 Mbps
  // or 115.2 kbps and is not a data path. Anything else under 100 Mbps is a
  // modelling error - and so is a port whose declared line rate outruns the
  // medium under it, which is exactly how 28 tablets ended up advertising a
  // gigabit on a USB 1.1 console port.
  function isConsoleOnly(hw) {
    const list = hw.media || [];
    if (!list.length) return false;
    return list.every(function (id) {
      const def = mediaLib.mediaById(id);
      return def && (def.family === 'console' || def.family === 'management');
    });
  }

  const slow = [], overreach = [];
  for (const x of all) {
    for (const i of x.ifaces) {
      const caps = i.hardware.speedCaps;
      if (!caps || !caps.length) continue;
      // not an exemption: a missing media array means there is nothing to intersect, and the
      // question of a port with NO medium is owned by test/wired-port-has-media.test.js (#1039).
      if (!i.hardware.media) continue;
      // A port with an empty media list has no medium at all in the model: nothing can be cabled
      // to it at any rate. That is a gap of its own, and it is skipped here only because this
      // check is about rates rather than cabling. Issue #1039 tracks the 84 remaining coax ports
      // (a CMTS port declaring 100 Mbps shares no rate with a 38 Mbps DOCSIS channel), and
      // test/wired-port-has-media.test.js is the check that owns this question.
      if (!i.hardware.media.length) continue;
      // Console ports used to be skipped outright here, which is how 163 of them carried a
      // gigabit (and later 100 Mbps) on a 115.2 kbps cage through a green suite. They are checked
      // now: a USB console runs at 12 Mbps and an RS-232 one at 0.1152, and both fit their cage.
      // NOTE: speedCaps are whatever the spec wrote - often "10G"/"1G" strings. The old
      // Math.max.apply(null, caps) therefore returned NaN for those, and every comparison
      // against NaN is false, so a port that declared its caps as text was never checked at
      // all. That is how an EdgePoint S16 carried a 10G claim on a 1G SFP cage through a
      // green suite. Parse first, then compare.
      const parsedCaps = caps.map(function (c) {
        return typeof c === 'number' ? c : mediaLib.parseSpeedMbps(c);
      }).filter(function (n) { return typeof n === 'number' && isFinite(n) && n > 0; });
      const top = parsedCaps.length ? Math.max.apply(null, parsedCaps) : 0;
      const declaredRaw = i.hardware.maxSpeedMbps || 0;
      const declared = typeof declaredRaw === 'number' ? declaredRaw : mediaLib.parseSpeedMbps(declaredRaw);
      // What the cage itself can carry, asked of the engine rather than inferred from the
      // port's own claim - comparing a port against itself can only ever pass.
      const cageSpeeds = mediaLib.CAGE_SPEEDS[i.hardware.cage];
      const cageRates = typeof cageSpeeds === 'function'
        ? cageSpeeds(Math.max(top, declared || 0))
        : (cageSpeeds || []);
      const cageTop = cageRates.length ? Math.max.apply(null, cageRates) : 0;
      // Fibre Channel used to be exempt here because it had no cage and no medium of its own,
      // so a 64G FC port riding in an SFP+ cage read as a 40G claim on a 10G cage (#980). It
      // has fc-sfp / fc-sfp28 / fc-sfpdd / fc-qsfp28 now, so FC is judged by the same rule as
      // Ethernet: the ladder a port declares must fit the cage it is in.
      // A DSL line port is SUPPOSED to be slow: ADSL2+ tops out at 24 Mbit/s and
      // ADSL at 8. Flagging that as a defect would push contributors to inflate the
      // one number a DSLAM must state honestly. PON is exempt for the same reason
      // in reverse - its rates are asymmetric and fine-grained.
      // A console is legitimately slow: 9600 baud to 115200 is the whole point of the port, so
      // it joins DSL and PON in the "slow is correct" set. That excuses the rate being LOW; it
      // does not excuse it being wrong, which is why the console skip below is gone.
      const slowIsCorrect = i.hardware.cage === 'dsl' || i.hardware.cage === 'pon' ||
        i.hardware.cage === 'console' || i.hardware.cage === 'serial';
      // A radio is not a cage. A HughesNet terminal's 25 Mbit/s downlink is the
      // honest number and a Wi-Fi 4 radio's 300 Mbit/s is not a 1G claim - this
      // check exists to stop a WIRED cage being understated, so it does not
      // apply to a wireless interface. Issue #76 tracks the related bug that
      // derivePortHardware still derives an rj45 cage for a radio.
      const isRadio = i.type === 'wireless' || i.hardware.cage === 'antenna';
      if (top < 100 && !slowIsCorrect && !isRadio) {
        slow.push(x.spec.model + '/' + i.name + ' top ' + top + ' Mbps');
      }
      // Line-rate rounding: a "2.5G" PON port is really 2.488 Gbit/s and a "10G" PON
      // port 9.953, so allow a couple of percent before calling it a claim the cage
      // cannot carry. Compare against cageTop (what the cage can carry), not against
      // the port's own caps.
      if (declared && cageTop && declared > cageTop * 1.02) {
        overreach.push(x.spec.model + '/' + i.name + ' claims ' + declared +
          ' Mbps on a ' + cageTop + ' Mbps ' + i.hardware.cage + ' cage');
      }
    }
  }
  ok(slow.length === 0, 'no data port advertises a sub-100 Mbps-only cage' +
    (slow.length ? ' (' + slow.slice(0, 3).join(', ') + ')' : ''));
  // Exempting radios must not become a way to say nothing: a wireless interface
  // is now outside the cage rule, so it has to declare the rate it does run at.
  const radioNoRate = [];
  for (const x of all) {
    for (const i of x.ifaces) {
      // not an exemption: this section is about wireless ports, by construction.
      if (i.type !== 'wireless') continue;
      const caps = i.hardware.speedCaps;
      if (!caps || !caps.length) radioNoRate.push(x.spec.model + '/' + i.name);
    }
  }
  ok(radioNoRate.length === 0, 'every radio declares the rate it runs at' +
    (radioNoRate.length ? ' (' + radioNoRate.slice(0, 3).join(', ') + ')' : ''));
  ok(overreach.length === 0, 'no port claims a line rate its cage cannot carry' +
    (overreach.length ? ' (' + overreach.slice(0, 3).join(', ') + ')' : ''));
}

console.log('\nPoE claims are internally consistent:');
{
  const phantom = [], unknownOk = [];
  for (const x of all) {
    const pse = x.ifaces.filter(function (i) { return i.hardware.poeOut; });
    if (x.dev.poeBudget > 0 && pse.length === 0) {
      phantom.push(x.spec.model + ' (' + x.dev.poeBudget + ' W, 0 PSE ports)');
    }
    if (x.spec.poe && x.spec.poe.budgetUnknown) {
      // An explicit "never published" must not be silently replaced by a
      // model-name guess such as ES-24-500W's 500.
      unknownOk.push(x.dev.poeBudget === 0 ? 'ok' : 'LEAKED ' + x.spec.model);
    }
  }
  ok(phantom.length === 0, 'no device claims a power budget with no port to source it' +
    (phantom.length ? ' (' + phantom.slice(0, 3).join(', ') + ')' : ''));
  ok(unknownOk.every(function (s) { return s === 'ok'; }),
    'research-marked-unknown budgets stay unknown instead of falling back to the model name');

  // A budget must be a plausible number: watts, not a description of one.
  const daft = all.filter(function (x) {
    return x.dev.poeBudget < 0 || x.dev.poeBudget > 8000;
  });
  ok(daft.length === 0, 'every PoE budget is a plausible wattage');
}

console.log('\nEvery device can be plugged into a copy of itself:');
{
  // If no two ports on identical hardware can mate, the device is an island -
  // it could never take part in a lab, so the spec is useless even if valid.
  // A passive optical splitter is exempt: two of them cabled together is a
  // cascaded split, and beyond 1:8 that genuinely busts the PON power budget, so
  // refusing the link is CORRECT rather than a defect in the spec. What a
  // splitter must be able to do is take an ONT on one of its legs, which is
  // asserted separately below.
  const islands = [];
  for (const x of all) {
    if (x.spec.category === 'splitter') continue;
    if (x.ifaces.length === 0) { islands.push(x.spec.model + ' (no ports)'); continue; }
    const t = new Topology();
    const a = t.addDevice(x.spec);
    const b = t.addDevice(x.spec);
    let mated = false;
    for (const ia of a.interfaces.values()) {
      for (const ib of b.interfaces.values()) {
        const v = t.validateLink(a.id, ia.name, b.id, ib.name, {});
        if (v && v.ok) { mated = true; break; }
      }
      if (mated) break;
    }
    if (!mated) {
      // A device whose every port is a radio cannot be cabled at all - an M.2 5G module, a
      // satellite terminal. Calling that an island would force a fake Ethernet port onto
      // hardware that has none, which is the defect #129 exists to remove.
      const onlyRadios = x.ifaces.every(function (p) {
        return p.hardware.cage === 'antenna' || p.hardware.cage === 'wwan';
      });
      if (!onlyRadios) islands.push(x.spec.vendor + '/' + x.spec.model);
    }
  }
  ok(islands.length === 0, 'all ' + catalog.length + ' devices can be cabled to themselves' +
    (islands.length ? ' (' + islands.slice(0, 5).join(', ') + ')' : ''));

  // Every PON splitter must be able to take an ONT on a leg - otherwise the part is
  // decorative and a PON branch cannot be built with it at all.
  //
  // This only applies to parts that are actually PON-side. The splitter category now
  // also holds WDM muxes and fibre patch panels, which use LC ferrules and are not
  // supposed to meet an SC/APC ONT - an LC mux refusing an SC plug is correct
  // hardware behaviour, not a dead end.
  const splitterDeadEnds = [];
  const anyOnt = catalog.find(function (s) { return s.category === 'ont'; });
  for (const x of all) {
    if (x.spec.category !== 'splitter') continue;
    if (!anyOnt) break;
    const ponSide = x.ifaces.some(function (i) {
      return i.hardware.connector === 'sc-apc' || i.hardware.connector === 'sc-upc';
    });
    if (!ponSide) continue;
    const t = new Topology();
    const sp = t.addDevice(x.spec);
    const ont = t.addDevice(anyOnt);
    const leg = [...sp.interfaces.keys()].filter(function (n) { return n !== 'uplink'; })[0];
    const v = t.validateLink(sp.id, leg, ont.id, 'pon', {});
    if (!v || !v.ok) {
      splitterDeadEnds.push(x.spec.model + ' leg ' + leg + ' refuses an ONT' +
        (v && v.errors && v.errors.length ? ' (' + v.errors[0].code + ')' : ''));
    }
  }
  ok(splitterDeadEnds.length === 0, 'every PON splitter leg can accept an ONT' +
    (splitterDeadEnds.length ? ' (' + splitterDeadEnds.slice(0, 3).join('; ') + ')' : ''));
}

console.log('\nA port connector agrees with the port type:');
{
  // A radio port is an antenna, not a fibre cage. Three PtP radios shipped with an SFP
  // connector on a wireless interface - almost certainly because the box also has an
  // SFP uplink that should have been its own ethernet port - which made the *radio*
  // render as a fibre socket and allowed it to be "cabled" to a switch with a patch
  // lead. Drawing a physical link that cannot exist is the thing this project exists
  // to refuse.
  const TYPE_CAGES = {
    // Antenna for Wi-Fi, wwan for cellular: since #129 both are radios and the cage
    // distinguishes them, so both are legitimate resolutions of the wireless type.
    wireless: ['antenna', 'wwan'],
    console: ['console'],
    coax: ['coax'],
    dsl: ['dsl'],
    powerline: ['powerline'],
    pon: ['sc-apc', 'sc-upc', 'lc-upc', 'lc-apc']
  };
  const wrong = [];
  for (const x of all) {
    for (const i of x.ifaces) {
      const allowed = TYPE_CAGES[i.type];
      if (!allowed) continue;
      if (allowed.indexOf(i.hardware.cage) === -1) {
        wrong.push(x.spec.vendor + '/' + x.spec.model + ' ' + i.name +
          ' (type ' + i.type + ' -> cage ' + i.hardware.cage + ')');
      }
    }
  }
  ok(wrong.length === 0, 'every typed port resolves to a cage of its own type' +
    (wrong.length ? ': ' + wrong.slice(0, 5).join('; ') : ''));

  // And the cable itself must be refused, not merely drawn oddly.
  let tested = 0, refused = 0;
  for (const x of all) {
    const radio = x.ifaces.find(function (i) { return i.type === 'wireless'; });
    const fibre = x.ifaces.find(function (i) { return i.hardware.cage === 'sfp+'; });
    if (!radio || !fibre) continue;
    tested++;
    const t = new Topology();
    const a = t.addDevice(x.spec);
    const b = t.addDevice(x.spec);
    const v = t.validateLink(a.id, radio.name, b.id, fibre.name, {});
    if (v && !v.ok) refused++;
  }
  ok(tested === 0 || refused === tested,
    'a radio port refuses to cable to an SFP+ cage (' + refused + '/' + tested + ')');
}

console.log('\nUSB is not a network interface:');
{
  // This has now been fixed twice: once when 28 tablets advertised a gigabit on a
  // 12 Mbit/s "USB console" cage, and again when a DOCSIS batch quietly added
  // usb1 to two more. A USB port is not something you patch a topology into, so
  // the rule is mechanical from here: no device may declare one. A genuine USB
  // console port belongs under type "console", not as a NIC.
  const usbDevices = [];
  for (const x of all) {
    for (const i of x.ifaces) {
      if (i.type === 'usb' || /^usb/i.test(String(i.name || ''))) {
        usbDevices.push(x.spec.vendor + '/' + x.spec.model + ' ' + i.name);
      }
    }
  }
  ok(usbDevices.length === 0, 'no device models a USB port as a network interface' +
    (usbDevices.length ? ' (' + usbDevices.slice(0, 3).join(', ') + ')' : ''));
}

console.log('\nVendor and model identity is unique:');
{
  const seen = new Map();
  const dupes = [];
  for (const s of catalog) {
    const key = String(s.vendor).toLowerCase() + '|' + String(s.model).toLowerCase();
    if (seen.has(key)) dupes.push(key);
    seen.set(key, 1);
  }
  ok(dupes.length === 0, 'no two specs share a vendor and model' +
    (dupes.length ? ' (' + dupes.slice(0, 3).join(', ') + ')' : ''));
  ok(catalog.length >= 300, 'the catalogue is still populated (' + catalog.length + ' models)');
}

console.log('\nPunctuation cannot smuggle a duplicate into the catalogue:');
{
  // The check above compares the exact string, so it is blind to a vendor spelling one
  // model two ways. Issue #60 shipped exactly that: "ASR1001-X" beside "ASR 1001-X",
  // "ISR4331" beside "ISR 4331" and "RaspberryPi5" beside "Raspberry Pi 5". Nothing
  // collided at write time either, because the importer names files by slug(model) and
  // a space and a dash slug differently - so the catalogue offered the same box twice,
  // with different port counts, and whichever copy the search happened to return was
  // the one you got. Identity therefore has to be punctuation-insensitive: compare the
  // vendor and model with every non-alphanumeric character stripped.
  const byKey = new Map();
  const clashes = [];
  for (const s of catalog) {
    const key = modelKey(s);
    if (byKey.has(key)) {
      clashes.push(key + ' (' + byKey.get(key).model + ' == ' + s.model + ')');
    } else {
      byKey.set(key, s);
    }
  }
  ok(clashes.length === 0, 'no two specs share a normalised vendor+model key' +
    (clashes.length ? ' (' + clashes.slice(0, 3).join('; ') + ')' : ''));
  ok(byKey.size === catalog.length, 'every model squashes to a distinct key (' +
    byKey.size + '/' + catalog.length + ')');
}


console.log('A product is described once, whatever its file is called:');
{
  // The NanoStation M3 landed as nbm3.json beside an nsm3.json that already existed, because a
  // stale research record and the device request disagreed about the model string while both
  // named the same box. Two files, one product: nothing in the catalogue could tell a reader
  // which one to cable, and the importer kept recreating the twin on every run.
  //
  // The label is the product's name; the model is only its identity. So a repeated label means
  // one product under a second slug. The exceptions are products a vendor genuinely lists under
  // two model numbers, tracked in test/known-issues.json (which can only shrink) along with the
  // labels that are outright wrong - a shared label is the symptom, the wrong name is the bug.
  let knownLabels = {};
  try { knownLabels = JSON.parse(require('fs').readFileSync(require('path').join(__dirname, 'known-issues.json'), 'utf8')); } catch (e) { knownLabels = {}; }
  const waived = (knownLabels.duplicateLabels || []).map(function (s) { return String(s).toLowerCase(); });
  const groups = new Map();
  for (const s of catalog) {
    const label = String(s.label || '').trim().toLowerCase();
    if (!label) continue;
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(s);
  }
  const offenders = [];
  const examples = [];
  for (const pair of groups) {
    const list = pair[1];
    if (list.length < 2) continue;
    const sorted = list.slice().sort(function (a, b) {
      return (a.vendor + '/' + a.model).localeCompare(b.vendor + '/' + b.model);
    });
    for (const extra of sorted.slice(1)) {
      offenders.push(String(extra.vendor + '/' + extra.model).toLowerCase());
      examples.push(extra.vendor + '/' + extra.model + ' <= "' + pair[0] + '"');
    }
  }
  const fresh = offenders.filter(function (n) { return waived.indexOf(n) === -1; });
  const stale = waived.filter(function (n) { return offenders.indexOf(n) === -1; });
  ok(fresh.length === 0, 'no NEW device repeats a product name the catalogue already uses' +
    (fresh.length ? ' (' + fresh.slice(0, 3).join(', ') + ')' : ''));
  ok(stale.length === 0, 'the duplicate-name list has no stale entries' +
    (stale.length ? ' (fixed already, remove from test/known-issues.json: ' + stale.join(', ') + ')' : ''));
  if (offenders.length) {
    console.log('    ' + offenders.length + ' repeated name(s) tracked: ' + examples.join('; '));
  }
}


console.log('Every device can be named in a list:');
{
  // Twenty Huawei consumer devices carried no label at all, so the catalogue listed them by model
  // string alone - the one field a reader scans was blank, and a label-less entry cannot be told
  // apart from a parser artefact. Two more carried an import placeholder as their name
  // ("Smart speaker, Wi-Fi only", "Smart display, Wi-Fi only"), which is a description, not a product.
  const nameless = [];
  for (const s of catalog) {
    if (!String(s.label || '').trim()) nameless.push(s.vendor + '/' + s.model);
  }
  ok(nameless.length === 0, 'every spec carries a label' +
    (nameless.length ? ' (' + nameless.slice(0, 3).join(', ') + ')' : ''));

  const placeholders = [];
  const PLACEHOLDER = /^(smart speaker|smart display|wireless access point|network switch|access point|router|\s*)$/i;
  for (const s of catalog) {
    const label = String(s.label || '').trim();
    if (!label) continue;
    // A generic device template is allowed to say what it is; a real product is not.
    if (s.vendor === 'generic') continue;
    if (PLACEHOLDER.test(label)) placeholders.push(s.vendor + '/' + s.model + ' <= "' + label + '"');
  }
  ok(placeholders.length === 0, 'no real device is labelled with its category instead of its name' +
    (placeholders.length ? ' (' + placeholders.slice(0, 3).join(', ') + ')' : ''));
}


console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
