'use strict';
// The optics parts catalogue: real transceiver part numbers and real ODN parts.
//
// A standard name ("10GBASE-LR") is not a part. It does not tell you the reach, the
// ferrule, or which module it can be paired with. A catalogue lets the simulator
// answer "can I put this module in that cage, and will the pair work" using the
// numbers the vendor actually publishes, and lets a contributor add a part without
// touching the engine.
const optical = require('../engine/optical');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg); }
}

const parts = optical.transceivers();
const odn = optical.odnParts();

console.log('The catalogue loads:');
{
  ok(parts.length >= 20, 'transceiver catalogue has real parts (' + parts.length + ')');
  ok(odn.length >= 10, 'ODN catalogue has real passive parts (' + odn.length + ')');
  const missing = parts.filter(function (t) { return !t.partNumber || !t.formFactor || !t.sourceUrl; });
  ok(missing.length === 0, 'every part has a part number, a form factor and a source');
  const badSpeed = parts.filter(function (t) { return !(Number(t.speedMbps) > 0); });
  ok(badSpeed.length === 0, 'every part declares a line rate');
}

console.log('\nParts are looked up by cage and by number:');
{
  const sfpPlus = optical.transceiversForCage('sfp+');
  ok(sfpPlus.length > 0, 'the catalogue knows what fits an SFP+ cage (' + sfpPlus.length + ' parts)');
  ok(sfpPlus.every(function (t) { return t.formFactor === 'sfp+'; }), 'and nothing else leaks in');
  const lr = optical.transceiverByPart('SFP-10G-LR');
  ok(!!lr, 'a part is found case-insensitively by number');
  ok(lr && Number(lr.reachM) >= 10000, 'and carries its real reach (' + (lr && lr.reachM) + ' m)');
  ok(optical.transceiverByPart('NOT-A-PART') === null, 'an unknown part resolves to null');
}

console.log('\nSingle-strand BiDi optics only work as a crossed pair:');
{
  const bidi = parts.filter(function (t) { return t.biDi; });
  ok(bidi.length >= 2, 'the catalogue has BiDi parts to check (' + bidi.length + ')');
  const a = bidi[0];
  const b = bidi.filter(function (t) {
    return Number(t.wavelengthNm) !== Number(a.wavelengthNm);
  })[0];
  ok(!!b, 'and at least two different wavelengths');
  if (b) {
    const crossed = optical.biDiPairsWith(a, b);
    ok(crossed.ok === true, 'a 1270/1330 against a 1330/1270 pair works');
    ok(/Crossed/.test(crossed.message), 'and says so');
  }
  // The classic mistake: two of the same part. Both transmit on one wavelength and
  // both receivers are deaf.
  const same = optical.biDiPairsWith(a, a);
  ok(same.ok === false, 'two identical BiDi modules are refused');
  ok(same.code === 'E_BIDI_SAME_WAVELENGTH', 'with a wavelength-specific verdict (' + same.code + ')');
  ok(/deaf|transmit/.test(same.message), 'and an explanation that names the problem');

  const dual = parts.filter(function (t) { return !t.biDi; })[0];
  ok(optical.biDiPairsWith(a, dual).ok === false, 'BiDi cannot be paired with a two-strand module');
  ok(optical.biDiPairsWith(dual, dual).ok === true, 'two ordinary modules are fine together');
}

console.log('\nSplitter loss in the catalogue is physically sane:');
{
  const splitters = odn.filter(function (p) { return String(p.kind) === 'splitter'; });
  ok(splitters.length >= 4, 'the ODN catalogue has splitters (' + splitters.length + ')');
  let idealViolations = [];
  for (const s of splitters) {
    const n = Number(String(s.ratio).split(':')[1]);
    if (!n) continue;
    const ideal = 10 * Math.log10(n);
    const loss = typeof s.insertionLossDb === 'number' ? s.insertionLossDb : Number(s.insertionLossDb.max);
    // A passive splitter cannot beat the physics of dividing the light.
    if (!(loss >= ideal - 0.05)) idealViolations.push(s.ratio + ' at ' + loss + ' dB vs ideal ' + ideal.toFixed(2));
  }
  ok(idealViolations.length === 0, 'no splitter claims less loss than the split ratio allows' +
    (idealViolations.length ? ' (' + idealViolations.join('; ') + ')' : ''));
}

console.log('\nThe built-in design table is the worst case, not the best:');
{
  for (const ratio of ['1:2', '1:4', '1:8', '1:16', '1:32', '1:64']) {
    const table = optical.splitterLossDb(ratio);
    const real = optical.catalogueSplitterLossDb(ratio);
    if (real === null) continue;
    ok(table >= real - 0.0001,
      ratio + ' table (' + table + ' dB) is no better than the real part (' + real + ' dB)');
  }
  const n = 2;
  ok(optical.splitterLossDb('1:2') > 10 * Math.log10(n),
    'and 1:2 is above the ideal 3.01 dB');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
