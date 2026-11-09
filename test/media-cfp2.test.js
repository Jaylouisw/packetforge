'use strict';
// CFP2: the cage optical transport actually uses, and the one the catalogue could not name.
//
// The OptiXtrans E6616 and E6608 have 200G line ports. There was no CFP cage, so they were
// modelled in a QSFP56 cage and the note apologised for it - "the physical module is CFP2, so
// order CFP2, not QSFP56". That is a spec telling the reader not to believe the spec, which is
// worse than a missing entry: a lab that wires the modelled port with the modelled module gets a
// link the hardware cannot build.
//
// The interesting part is not that CFP2 was added. It is that CFP2 and QSFP56 carry the same 200G
// and must NOT mate: the module is a different size and latches differently. That makes this the
// first cage in the catalogue where "the rates match, so it fits" is wrong, and the validator has
// to refuse it by name rather than by rate.
const media = require('../engine/media');
const { Topology } = require('../engine');
const { loadCatalog } = require('../devices/registry');
const path = require('path');
const fs = require('fs');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; }
  else { failed++; console.log('  not ok - ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

console.log('');
console.log('The cage exists and carries the right media:');
ok(!!media.CAGES.cfp2, 'a CFP2 cage is defined');
ok(media.CAGES.cfp2.family === 'optical', 'and it is an optical cage');
const mediaList = media.CAGE_MEDIA.cfp2(200000);
ok(mediaList.indexOf('200gbase-fr4') !== -1, '200GBASE-FR4 is offered');
ok(mediaList.indexOf('100gbase-lr4') !== -1, '100G is offered - a muxponder board has a 100G line mode');
ok(mediaList.indexOf('40gbase-lr4') !== -1, 'and the older 40G optics a CFP2 port also takes');
ok(mediaList.every(function (m) { return m.indexOf('dac') === -1; }), 'no DAC: CFP2 is a line-side module, not a patch lead');
const cap200 = media.CAGE_SPEEDS.cfp2(200000);
ok(cap200.indexOf(200000) !== -1, 'a 200G CFP2 port runs at 200G');
ok(cap200.indexOf(400000) === -1, 'but not 400G - that is CFP8, a different cage');

console.log('');
console.log('CFP2 mates with CFP2 and nothing else:');
ok(media.cagesMate('cfp2', 'cfp2') === true, 'CFP2 meets CFP2');
ok(media.cagesMate('cfp2', 'qsfp56') === false, 'CFP2 does not meet QSFP56, despite both carrying 200G');
ok(media.cagesMate('cfp2', 'qsfpdd') === false, 'nor QSFP-DD');
ok(media.cagesMate('cfp2', 'qsfp28') === false, 'nor QSFP28');
ok(media.cagesMate('cfp2', 'sfp+') === false, 'nor SFP+');

console.log('');
console.log('And the validator says so in words, not with a rate complaint:');
{
  const specs = loadCatalog(path.join(__dirname, '..', 'devices'));
  const opt = specs.filter(function (s) { return /OptiXtrans E6616/.test(s.model || ''); })[0];
  ok(!!opt, 'the E6616 is in the catalogue');
  const t = new Topology();
  const a = t.addDevice(opt); a.name = 'otn1';
  const b = t.addDevice(opt); b.name = 'otn2';
  const res = t.validateLink(a.id, 'line1', b.id, 'line1', { medium: '200gbase-fr4' });
  ok(res.ok === true, 'CFP2 line ports cable to each other at 200G', JSON.stringify(res.issues || res.reason || res));

  // A QSFP56 200G port - the shape these line ports used to be modelled as.
  const q = specs.filter(function (s) {
    return (s.interfaces || []).some(function (i) { return i.connector === 'qsfp56'; });
  })[0];
  ok(!!q, 'a device with a QSFP56 cage exists');
  const t2 = new Topology();
  const c = t2.addDevice(opt); c.name = 'otn3';
  const d = t2.addDevice(q); d.name = 'other';
  const qPort = d.interfaces && [...d.interfaces.values()].filter(function (i) { return i.hardware && i.hardware.cage === 'qsfp56'; })[0];
  ok(!!qPort, 'and its QSFP56 port is addressable');
  const bad = t2.validateLink(c.id, 'line1', d.id, qPort.name, {});
  ok(bad.ok === false, 'a CFP2 port refuses a QSFP56 port');
  const text = JSON.stringify(bad.issues || bad);
  ok(/E_CONNECTOR_MISMATCH/.test(text), 'and names the connector mismatch, not the rate', text.slice(0, 160));
  ok(/CFP2/i.test(text) && /QSFP56/i.test(text), 'naming both cages so the reader knows which optic to swap', text.slice(0, 200));
}

console.log('');
console.log('The specs no longer apologise for themselves:');
{
  for (const slug of ['optixtrans-e6616', 'optixtrans-e6608']) {
    const file = path.join(__dirname, '..', 'devices', 'huawei', slug + '.json');
    const spec = JSON.parse(fs.readFileSync(file, 'utf8'));
    const linePorts = spec.interfaces.filter(function (i) { return i.name.indexOf('line') === 0; });
    ok(linePorts.length > 0, slug + ' has line ports');
    ok(linePorts.every(function (i) { return i.connector === 'cfp2'; }),
      slug + ' models every line port as CFP2',
      linePorts.filter(function (i) { return i.connector !== 'cfp2'; }).map(function (i) { return i.name + '=' + i.connector; }).join(','));
    // Mentioning QSFP56 is fine and useful - the note SHOULD say that a QSFP56 module will not
    // seat. What must be gone is the apology: "there is no CFP cage, so order CFP2, not QSFP56".
    ok(!/no CFP cage/i.test(spec.notes),
      slug + ' no longer claims there is no CFP cage', (spec.notes.match(/[^.]*no CFP cage[^.]*/i) || [''])[0]);
    ok(!/order CFP2, not QSFP56/i.test(spec.notes),
      slug + ' no longer tells the reader to order a different module than the one modelled');
    if (/QSFP56/i.test(spec.notes)) {
      ok(/will not seat|refus|E_CONNECTOR_MISMATCH/i.test(spec.notes),
        slug + ' mentions QSFP56 only to say it does not fit');
    } else {
      ok(true, slug + ' does not mention QSFP56 at all');
    }
  }
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exitCode = 1;
