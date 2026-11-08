'use strict';
// A 10G optic is not "a 10G optic" (#237).
//
// The request asked for Huawei's 10GE optical modules, and the useful thing about a fibre
// module is everything the marketing name leaves out: the wavelength decides whether it pairs
// with a counterpart or blinds it, the polish decides whether it mates with the patch panel,
// and the reach decides whether a run is legal. Nine parts here that all say "10G SFP+" behave
// very differently once they are in a cage.
//
// Part numbers and their specifications are transcribed from Huawei's own optical module
// datasheet, where the part name carries the facts:
//   Optical Transceiver,SFP+,10G,Single-mode Module(1310nm,10km,LC)
//
// What is locked here:
//   1. every part loads, is 10G, and sits in an SFP+ cage;
//   2. the multimode part declares MMF and the single-mode parts declare SMF, so a fibre type
//      mismatch is refusable rather than invisible;
//   3. the two BiDi parts pair with each other and refuse to pair with themselves - the
//      commonest single-strand mistake, and the one that leaves both ends deaf;
//   4. the electrical 10GBASE-T part is copper: RJ45, no wavelength, so a fibre lead cannot
//      terminate on it;
//   5. the reach ladder is real: SR 300 m < LR 10 km < ER 40 km < ZR 80 km.
const path = require('path');
const optical = require('../engine/optical');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.log('  \u2717 ' + msg); }
}
function eq(actual, expected, msg) {
  ok(actual === expected, msg + ' (expected ' + JSON.stringify(expected) +
    ', got ' + JSON.stringify(actual) + ')');
}
function section(name) { console.log('\n' + name); }

const PARTS = ['OMXD30000', 'OSX010000', 'OSX040N01', 'SFP-10G-ZR', 'SFP-10G-SR-eKit',
  'SFP-10G-LR-eKit', 'SFP-10G-BXU1', 'SFP-10G-BXD1', 'SFP-10GBaseT-SR'];

section('1. Every part loads with the form factor and rate it claims');
{
  for (const pn of PARTS) {
    const t = optical.transceiverByPart(pn);
    ok(!!t, pn + ' is in the catalogue');
    if (!t) continue;
    eq(t.formFactor, 'sfp+', pn + ' is an SFP+ module');
    eq(t.speedMbps, 10000, pn + ' is a 10G module');
  }
}

section('2. Fibre type is declared, not implied by the name');
{
  eq(optical.transceiverByPart('OMXD30000').fiber, 'mmf', 'the 850 nm part is multimode');
  eq(optical.transceiverByPart('SFP-10G-SR-eKit').fiber, 'mmf', 'and so is its eKit SKU');
  for (const pn of ['OSX010000', 'OSX040N01', 'SFP-10G-ZR', 'SFP-10G-LR-eKit']) {
    eq(optical.transceiverByPart(pn).fiber, 'smf', pn + ' is single-mode');
  }
}

section('3. The reach ladder is the published one, and ordered');
{
  eq(optical.transceiverByPart('OMXD30000').reachM, 300, 'SR reaches 300 m');
  eq(optical.transceiverByPart('OSX010000').reachM, 10000, 'LR reaches 10 km');
  eq(optical.transceiverByPart('OSX040N01').reachM, 40000, 'ER reaches 40 km');
  eq(optical.transceiverByPart('SFP-10G-ZR').reachM, 80000, 'ZR reaches 80 km');
  ok(optical.transceiverByPart('OMXD30000').reachM < optical.transceiverByPart('OSX010000').reachM &&
    optical.transceiverByPart('OSX010000').reachM < optical.transceiverByPart('OSX040N01').reachM &&
    optical.transceiverByPart('OSX040N01').reachM < optical.transceiverByPart('SFP-10G-ZR').reachM,
    'SR < LR < ER < ZR, so a lab can pick the shortest optic that does the job');
}

section('4. BiDi pairs across, and refuses to pair with itself');
{
  const up = optical.transceiverByPart('SFP-10G-BXU1');
  const down = optical.transceiverByPart('SFP-10G-BXD1');
  ok(up.biDi === true && down.biDi === true, 'both single-strand parts are marked BiDi');
  eq(up.wavelengthNm, 1270, 'the U part transmits 1270 nm');
  eq(up.pairWavelengthNm, 1330, 'and expects 1330 nm back');
  eq(down.wavelengthNm, 1330, 'the D part transmits 1330 nm');
  eq(down.pairWavelengthNm, 1270, 'and expects 1270 nm back');

  const good = optical.biDiPairsWith('SFP-10G-BXU1', 'SFP-10G-BXD1');
  ok(good.ok === true, 'BXU1 and BXD1 pair');

  const bad = optical.biDiPairsWith('SFP-10G-BXU1', 'SFP-10G-BXU1');
  eq(bad.ok, false, 'two BXU1 modules do not pair - both would transmit on 1270 nm');
  ok(typeof bad.code === 'string' && bad.code.length > 0, 'and the refusal carries a code');

  const bad2 = optical.biDiPairsWith('SFP-10G-BXD1', 'SFP-10G-BXD1');
  eq(bad2.ok, false, 'nor do two BXD1 modules');
}

section('5. The electrical 10GBASE-T part is copper, not an optic');
{
  const t = optical.transceiverByPart('SFP-10GBaseT-SR');
  eq(t.connector, 'rj45', 'it terminates in an RJ45');
  eq(t.wavelengthNm, null, 'it has no wavelength, because there is no light in it');
  eq(t.fiber, 'copper', 'and its medium is copper');
  eq(t.reachM, 30, 'rated 30 m over Cat6a');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
