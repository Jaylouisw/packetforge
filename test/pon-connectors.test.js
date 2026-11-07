'use strict';
// Fibre connectors on PON ports, and the rule that a port which cannot be identified
// must not be drawn as copper.
//
// Two defects behind this file, both reported from the live GUI:
//
// 1. The Adtran SDX 611's PON port was modelled as SC/APC. The hardware presents
//    LC/UPC. A wrong connector is not cosmetic - it refuses the one lead that fits and
//    accepts one that does not.
// 2. web/canvas.js defaulted an unresolved cage to 'rj45', so any port the engine
//    could not classify was painted copper and its tooltip asserted "RJ45 copper".
//    A confident wrong answer is worse than an admission of ignorance.
const path = require('path');
const media = require('../engine/media');
const { Topology } = require('../engine');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg); }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));

console.log('The SDX 611s PON port is LC/UPC:');
{
  const spec = catalog.find(function (s) { return s.vendor === 'adtran' && s.model === 'SDX611'; });
  ok(!!spec, 'the SDX 611 is in the catalogue');
  const ponSpec = (spec.interfaces || []).find(function (i) { return i.name === 'pon'; });
  ok(ponSpec && ponSpec.connector === 'lc-upc', 'the spec declares lc-upc (' + (ponSpec && ponSpec.connector) + ')');

  const dev = new Topology().addDevice(spec);
  const pon = [...dev.interfaces.values()].find(function (i) { return i.name === 'pon'; });
  ok(pon.hardware.cage === 'lc-upc', 'the engine resolves an LC/UPC cage, not rj45 (' + pon.hardware.cage + ')');
  ok(pon.hardware.family !== 'copper', 'and it is not classified as copper');
  ok(pon.hardware.media.indexOf('gpon-lc-upc') !== -1,
    'carrying GPON on an LC connector (' + pon.hardware.media.join(',') + ')');
  ok(pon.hardware.speedCaps.indexOf(2488) !== -1 && pon.hardware.speedCaps.indexOf(1244) !== -1,
    'at GPON rates 1244/2488 (' + pon.hardware.speedCaps.join(',') + ')');
  ok(!/SC\/APC/.test(spec.description || ''), 'the description no longer claims SC/APC');
  ok(/LC\/UPC/.test(spec.description || ''), 'and states LC/UPC instead');
}

console.log('\nAn LC ferrule only mates with the same polish:');
{
  ok(media.cagesMate('lc-upc', 'lc-upc') === true, 'LC/UPC joins LC/UPC');
  ok(media.cagesMate('lc-apc', 'lc-apc') === true, 'LC/APC joins LC/APC');
  ok(media.cagesMate('lc-upc', 'lc-apc') === false, 'but LC/UPC never joins LC/APC');
  ok(media.polishMismatch('lc-upc', 'lc-apc') === true,
    'and that refusal is named as a polish mismatch, not a generic error');
  ok(media.cagesMate('lc-upc', 'sc-upc') === false, 'nor does an LC join an SC - different shape');
  ok(media.polishMismatch('lc-upc', 'sc-upc') === false,
    'which is a shape difference, so it is not reported as a polish problem');
  ok(media.cagesMate('lc-upc', 'rj45') === false, 'and never a copper socket');
}

console.log('\nThe SDX 611 can be cabled to itself and refuses what will not fit:');
{
  const spec = catalog.find(function (s) { return s.vendor === 'adtran' && s.model === 'SDX611'; });
  const pcSpec = catalog.find(function (s) { return s.vendor === 'generic' && s.model === 'generic-pc'; });

  const t1 = new Topology();
  const a = t1.addDevice(spec);
  const b = t1.addDevice(spec);
  const v1 = t1.validateLink(a.id, 'pon', b.id, 'pon', {});
  ok(v1 && v1.ok, 'two SDX 611s cable PON-to-PON (LC/UPC to LC/UPC)');

  const t2 = new Topology();
  const ont = t2.addDevice(spec);
  const pc = t2.addDevice(pcSpec);
  const v2 = t2.validateLink(ont.id, 'pon', pc.id, 'eth0', {});
  ok(v2 && !v2.ok, 'but an LC PON port refuses a copper RJ45 peer');
  ok(v2 && v2.errors && v2.errors.length > 0, 'and says why (' +
    (v2 && v2.errors && v2.errors[0] && v2.errors[0].code) + ')');
}

console.log('\nNo fibre port anywhere in the catalogue resolves to copper:');
{
  // The general form of bug 2. A port whose spec says fibre - by connector or by
  // being a PON port - must never come out of the hardware model as an rj45 cage.
  const FIBRE_CONNECTORS = ['sfp', 'sfp+', 'sfp28', 'qsfp+', 'qsfp28', 'qsfpdd',
    'sc-apc', 'sc-upc', 'lc-upc', 'lc-apc'];
  const offenders = [];
  for (const spec of catalog) {
    let dev;
    try { dev = new Topology().addDevice(spec); } catch (e) { continue; }
    for (const iface of dev.interfaces.values()) {
      const declared = iface.specConnector || null;
      const specIface = (spec.interfaces || []).find(function (i) { return i.name === iface.name; });
      const connector = (specIface && specIface.connector) || null;
      const isPon = iface.type === 'pon' || (specIface && specIface.type === 'pon');
      const fibreish = (connector && FIBRE_CONNECTORS.indexOf(connector) !== -1) || isPon;
      if (fibreish && (iface.hardware.cage === 'rj45' || iface.hardware.family === 'copper')) {
        offenders.push(spec.vendor + '/' + spec.model + ' ' + iface.name +
          ' (declared ' + (connector || 'pon') + ', resolved ' + iface.hardware.cage + ')');
      }
    }
  }
  ok(offenders.length === 0,
    'every fibre/PON port resolves to a fibre cage' +
    (offenders.length ? ' - offenders: ' + offenders.slice(0, 6).join('; ') : ''));
}

console.log('\nThe canvas never defaults an unknown cage to copper:');
{
  const fs = require('fs');
  const src = fs.readFileSync(path.join(__dirname, '..', 'web', 'canvas.js'), 'utf8');
  ok(!/iface\.cage \|\| 'rj45'/.test(src), "canvas.js no longer writes iface.cage || 'rj45'");
  ok(/connector unknown/.test(src), 'and says "connector unknown" instead');
  ok(/'lc-upc'/.test(src) && /'lc-apc'/.test(src), 'with LC tints and labels available');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
