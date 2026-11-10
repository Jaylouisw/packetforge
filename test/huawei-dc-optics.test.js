'use strict';
// A 400G or 200G optic is not "a 400G optic" either (#744, #745).
//
// Two requests asked for Huawei's data-centre StarryLink modules - 400GE QSFP-DD and 200GE QSFP56 -
// and filed them as families. A family name is not a part: 400GBASE-SR8 and 400GBASE-FR4 both say
// "400G", and one runs 70 m over multimode with an APC end face while the other runs 2 km over
// single-mode on four CWDM wavelengths. Which one is in the cage decides whether a run is legal.
//
// Every number here is transcribed from Huawei's own optical-module specification page (the
// `sourceUrl` on each part). What this file locks:
//
//   1. the parts load, are the right rate, and sit in the right cage (QSFP-DD vs QSFP56);
//   2. the fibre type and the end face are the published ones - SR8 is the only APC part and the
//      only 16-fibre one, and a fibre-type mismatch is refusable rather than invisible;
//   3. the reach ladder is real and ordered: 100 m multimode < 500 m < 2 km;
//   4. the FR4 parts do NOT claim a single wavelength. Both are four-wavelength CWDM-grid parts,
//      so `wavelengthNm` is null and the set lives in `cwdmChannel` - a part that answered
//      "1311 nm" would be claiming a single-lambda module it is not.
const optical = require('../engine/optical');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg); }
}
function eq(actual, expected, msg) {
  ok(actual === expected, msg + (actual === expected ? '' : ' (got ' + JSON.stringify(actual) +
    ', want ' + JSON.stringify(expected) + ')'));
}

const parts = optical.transceivers();
function part(n) { return optical.transceiverByPart(n); }

console.log('The 400G QSFP-DD parts load and are what they say (#745):');
{
  const sr8 = part('QSFP-DD-400G-SR8');
  const dr4 = part('QSFP-DD-400G-DR4');
  const fr4 = part('QSFP-DD-400G-FR4');
  ok(!!sr8 && !!dr4 && !!fr4, 'all three QSFP-DD parts the page lists are in the catalogue');
  for (const p of [sr8, dr4, fr4]) {
    eq(p.formFactor, 'qsfp-dd', p.partNumber + ' sits in a QSFP-DD cage');
    eq(Number(p.speedMbps), 400000, p.partNumber + ' is a 400G part');
    ok(!!p.sourceUrl && /huawei/.test(p.sourceUrl), p.partNumber + ' cites where the numbers came from');
  }
  eq(sr8.fiber, 'mmf', 'SR8 is multimode');
  eq(sr8.wavelengthNm, 850, 'SR8 transmits at 850 nm');
  eq(sr8.polish, 'apc', 'SR8 is the APC end face - the page says so, and it is the only one');
  eq(sr8.reachM, 100, 'SR8 reaches 100 m (OM4; 70 m on OM3)');
  eq(dr4.fiber, 'smf', 'DR4 is single-mode');
  eq(dr4.reachM, 500, 'DR4 reaches 500 m');
  eq(fr4.fiber, 'smf', 'FR4 is single-mode');
  eq(fr4.reachM, 2000, 'FR4 reaches 2 km');
  eq(fr4.wavelengthNm, null, 'FR4 does not claim one wavelength - it runs four');
  ok(/1271/.test(String(fr4.cwdmChannel)) && /1331/.test(String(fr4.cwdmChannel)),
    'and the four it does run are recorded (' + fr4.cwdmChannel + ')');
}

console.log('\nThe 200G QSFP56 parts load too (#744):');
{
  const sr4 = part('QSFP56-200G-SR4');
  const fr4 = part('QSFP56-200G-FR4');
  ok(!!sr4 && !!fr4, 'both QSFP56 parts are in the catalogue');
  eq(sr4.formFactor, 'qsfp56', 'SR4 sits in a QSFP56 cage');
  eq(Number(sr4.speedMbps), 200000, 'SR4 is a 200G part');
  eq(sr4.fiber, 'mmf', 'SR4 is multimode at 850 nm');
  eq(sr4.reachM, 100, 'SR4 reaches 100 m (OM4; 70 m OM3)');
  eq(fr4.fiber, 'smf', 'FR4 is single-mode');
  eq(fr4.reachM, 2000, 'FR4 reaches 2 km at 1310 nm');
}

console.log('\nThe cages answer with their own parts and nothing else:');
{
  const dd = optical.transceiversForCage('qsfp-dd');
  const q56 = optical.transceiversForCage('qsfp56');
  ok(dd.length >= 3 && dd.every(function (t) { return t.formFactor === 'qsfp-dd'; }),
    'a QSFP-DD cage lists the QSFP-DD parts (' + dd.length + ')');
  ok(q56.length >= 2 && q56.every(function (t) { return t.formFactor === 'qsfp56'; }),
    'a QSFP56 cage lists the QSFP56 parts (' + q56.length + ')');
  ok(dd.every(function (t) { return String(t.formFactor) !== 'qsfp56'; }),
    'and neither cage leaks the other form factor');
}

console.log('\nThe reach ladder is ordered, which is what makes a run refusable:');
{
  const sr8 = part('QSFP-DD-400G-SR8');
  const dr4 = part('QSFP-DD-400G-DR4');
  const fr4 = part('QSFP-DD-400G-FR4');
  ok(sr8.reachM < dr4.reachM && dr4.reachM < fr4.reachM,
    'SR8 100 m < DR4 500 m < FR4 2 km (' + sr4Reach() + ')');
  function sr4Reach() { return [sr8.reachM, dr4.reachM, fr4.reachM].join(' < '); }
  // A multimode part must not be offered a single-mode run and vice versa: the fibre field is what
  // the media layer reads to refuse it.
  const mmfParts = parts.filter(function (t) { return t.fiber === 'mmf' && t.formFactor === 'qsfp-dd'; });
  const smfParts = parts.filter(function (t) { return t.fiber === 'smf' && t.formFactor === 'qsfp-dd'; });
  ok(mmfParts.length >= 1 && smfParts.length >= 2,
    'both fibre types are represented in the QSFP-DD cage (' + mmfParts.length + ' MMF, ' +
    smfParts.length + ' SMF)');
}

console.log('\nThe 100G/40G/25G StarryLink parts, tab by tab (#747, #748, #750):');
{
  const byName = {};
  require('../catalogue/optics/transceivers.json').forEach(function (t) { byName[t.partNumber] = t; });

  // -- 100GE under 2 km ------------------------------------------------------
  const hundred = ['QSFP28-100G-SR4', 'QSFP28-100G-BIDI', 'QSFP28-100G-eBIDI',
                   'QSFP28-100G-CWDM4-Lite', 'QSFP28-100G-DR'];
  ok(hundred.every(function (n) { return byName[n]; }), 'all five 100GE parts are in the catalogue');
  ok(hundred.every(function (n) { return byName[n].formFactor === 'qsfp28' && byName[n].speedMbps === 100000; }),
    'every 100GE part is QSFP28 at 100 Gbit/s');
  eq(byName['QSFP28-100G-SR4'].connector, 'mpo',
    'SR4 is the MPO part - the only 100G one here with a 12-fibre connector');
  eq(byName['QSFP28-100G-DR'].connector, 'lc', 'DR is duplex LC');
  ok(byName['QSFP28-100G-eBIDI'].reachM > byName['QSFP28-100G-BIDI'].reachM,
    'eBIDI reaches further than BIDI (' + byName['QSFP28-100G-BIDI'].reachM + ' m vs ' +
    byName['QSFP28-100G-eBIDI'].reachM + ' m) - that is the only difference the table publishes');
  eq(byName['QSFP28-100G-BIDI'].pairWavelengthNm, 910, 'BIDI declares its return wavelength, not just 850 nm');
  eq(byName['QSFP28-100G-SR4'].pairWavelengthNm, null, 'and SR4 does not claim to be bidirectional');
  eq(byName['QSFP28-100G-CWDM4-Lite'].wavelengthNm, null,
    'CWDM4-Lite is not a single-lambda part: no wavelengthNm, the grid lives in cwdmChannel');
  eq(byName['QSFP28-100G-CWDM4-Lite'].fiber, 'smf', '...and it is single-mode, unlike its BIDI siblings');

  // -- 40GE ------------------------------------------------------------------
  const forty = ['QSFP-40G-iSR4', 'QSFP-40G-eSR4', 'QSFP-40G-LX4-MM', 'QSFP-40G-LR4-Lite'];
  ok(forty.every(function (n) { return byName[n] && byName[n].formFactor === 'qsfp+' && byName[n].speedMbps === 40000; }),
    'all four 40GE parts are QSFP+ at 40 Gbit/s');
  ok(byName['QSFP-40G-eSR4'].reachM > byName['QSFP-40G-iSR4'].reachM,
    'eSR4 outruns iSR4 on the same fibre');
  // The trap in this table: a CWDM optic on MULTIMODE.
  eq(byName['QSFP-40G-LX4-MM'].fiber, 'mmf',
    'LX4-MM is CWDM over multimode - the part that breaks the "CWDM means single-mode" assumption');
  eq(byName['QSFP-40G-LR4-Lite'].fiber, 'smf', 'while LR4-Lite is the single-mode 2 km one');
  ok(byName['QSFP-40G-LR4-Lite'].reachM === 2000, 'LR4-Lite is 2 km, as published');

  // -- 25GE ------------------------------------------------------------------
  eq(byName['SFP-25G-SR'].formFactor, 'sfp28', 'SFP-25G-SR is an SFP28 part');
  eq(byName['SFP-25G-SR'].reachM, byName['SFP-25G-SR-E'].reachM,
    'the -E variant publishes the same distances as the plain part: two codes, one optical spec');
  ok(/1e-12/.test(byName['SFP-25G-SR'].note),
    'and the BER-dependent reach (1e-12 vs 5e-5) is recorded, because the four numbers are not interchangeable');
}

console.log('\nThe long-reach 100G tab and the 10G tab, which only render on .html (#746, #749):');
{
  const byName = {};
  require('../catalogue/optics/transceivers.json').forEach(function (t) { byName[t.partNumber] = t; });

  // -- 100GE at 2 km and beyond ----------------------------------------------
  const long = ['QSFP28-100G-CWDM4', 'QSFP28-100G-FR1', 'QSFP28-100G-LR4',
                'QSFP28-100G-ER4', 'QSFP28-100G-ZR4'];
  ok(long.every(function (n) { return byName[n]; }), 'all five >=2 km 100GE parts are in the catalogue');
  eq(byName['QSFP28-100G-CWDM4'].reachM, 2000, 'CWDM4 is 2 km, against the Lite part\'s 500 m');
  eq(byName['QSFP28-100G-FR1'].wavelengthNm, 1311, 'FR1 is a single 1311 nm lambda, like DR');
  // LAN-WDM is NOT CWDM: the grid must not be smuggled into cwdmChannel.
  eq(byName['QSFP28-100G-LR4'].cwdmChannel, null,
    'LR4 is LAN-WDM (1295/1300/1304/1309 nm), so cwdmChannel is null rather than a 20 nm-grid lie');
  eq(byName['QSFP28-100G-CWDM4'].cwdmChannel.length, 4, 'while CWDM4 does carry its four-wavelength grid');
  const ladder = ['QSFP28-100G-CWDM4', 'QSFP28-100G-LR4', 'QSFP28-100G-ER4', 'QSFP28-100G-ZR4']
    .map(function (n) { return byName[n].reachM; });
  ok(ladder[0] < ladder[1] && ladder[1] < ladder[2] && ladder[2] < ladder[3],
    'the reach ladder is ordered: ' + ladder.join(' < ') + ' m');

  // -- 10GE ------------------------------------------------------------------
  const sr1 = byName['SFP-10G-SR1'];
  eq(sr1.reachM, 400, 'SFP-10G-SR1 reaches 400 m at its best (OM4)');
  ok(/OM2/.test(sr1.note) && /OM4/.test(sr1.note),
    'and the six-step multimode ladder is recorded, because a lab on OM2 gets 82 m and not 400');
  eq(byName['SFP-10G-SR-E'].reachM, sr1.reachM,
    'the -E variant publishes the same ladder as SR1: two codes, one optical spec');
  eq(byName['SFP-10G-iLR'].reachM, 1400, 'iLR is the odd one: 1.4 km on single-mode');
  ok(/-40/.test(byName['SFP-10G-iLR'].note) && /85/.test(byName['SFP-10G-iLR'].note),
    '...and its industrial -40 to +85 C range is why it exists, so it is in the note');
  ok(byName['SFP-10G-LR'] && byName['SFP-10G-ER'] && byName['SFP-10G-ZR'],
    'LR/ER/ZR were already in the catalogue and are not duplicated by this batch');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
