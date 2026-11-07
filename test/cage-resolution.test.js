'use strict';
// How a declared connector becomes a cage - and what happens when it cannot.
//
// engine/media.js derivePortHardware() used to read CAGES[cage] || CAGES.rj45, so any
// connector string it did not recognise silently became copper. The failure mode was
// ugly: an FS DWDM mux and an LC patch panel (64 ports between them) declared
// connector:"lc", presented as RJ45 ports advertising 10GBASE-T, and then refused
// every cable in the catalogue - including a cable to an identical port - with
// "Cannot mate RJ45 to RJ45".
//
// Two rules are locked here: a bare connector token resolves to the real cage it means,
// and an unknown cage is reported as unknown instead of being guessed at.
const path = require('path');
const media = require('../engine/media');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg); }
}

function hw(spec) { return media.derivePortHardware(spec, {}); }

console.log('A bare connector token resolves to the cage it means:');
{
  ok(media.CAGE_ALIAS && media.CAGE_ALIAS.lc === 'lc-upc', 'the alias table maps lc to lc-upc');
  const a = hw({ name: 'port1', type: 'ethernet', speed: '100G', connector: 'lc' });
  ok(a.cage === 'lc-upc', "connector 'lc' resolves to the lc-upc cage, not rj45");
  ok(a.family === 'optical', 'and it is optical');
  ok(Array.isArray(a.media) && a.media.indexOf('gpon-lc-upc') !== -1, 'it can carry a GPON medium');
  ok(a.media.indexOf('100gbase-lr4') !== -1, 'a 100G LC port also offers 100GBASE-LR4');
  const b = hw({ name: 'port1', type: 'ethernet', speed: '1G', connector: 'lc' });
  ok(b.media.indexOf('1000base-lx') !== -1, 'a 1G LC port offers 1000BASE-LX');
  ok(b.media.indexOf('100gbase-lr4') === -1, 'and does NOT offer a 100G optic it cannot drive');
}

console.log('\nAn unknown connector is reported as unknown, never as copper:');
{
  const u = hw({ name: 'weird1', type: 'ethernet', speed: '1G', connector: 'nonsense-cage' });
  ok(u.cage === 'nonsense-cage', 'the cage keeps the name it was given');
  ok(u.family === 'unknown', 'its family is unknown');
  ok(Array.isArray(u.media) && u.media.length === 0, 'it offers no medium at all');
  ok(Array.isArray(u.speedCaps) && u.speedCaps.length === 0, 'and claims no rate');
  ok(u.cage !== 'rj45', 'it is not silently turned into an RJ45 port');
}

console.log('\nThe catalogue resolves completely:');
{
  const { loadCatalog } = require('../devices/registry');
  const { Topology } = require('../engine');
  const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
  const unknown = [];
  let ports = 0;
  for (const spec of catalog) {
    const d = new Topology().addDevice(spec);
    for (const i of d.interfaces.values()) {
      ports++;
      if (i.hardware.family === 'unknown') unknown.push(spec.vendor + '/' + spec.model + '/' + i.name);
    }
  }
  ok(unknown.length === 0,
    'no port in ' + catalog.length + ' devices resolves to an unknown cage' +
    (unknown.length ? ' - ' + unknown.slice(0, 6).join(', ') : ''));
  ok(ports > 5000, 'the check covers the whole catalogue (' + ports + ' ports)');

  // The two devices that were broken, specifically.
  const mux = catalog.find(function (s) { return s.model === 'FMU-D402160M3'; });
  const panel = catalog.find(function (s) { return s.model === 'FHD-1U-PP-24LC'; });
  if (mux) {
    const d = new Topology().addDevice(mux);
    const p = [...d.interfaces.values()][0];
    ok(p.hardware.cage === 'lc-upc', 'the FS DWDM mux presents LC, not copper');
  }
  if (panel) {
    const d = new Topology().addDevice(panel);
    const p = [...d.interfaces.values()][0];
    ok(p.hardware.cage === 'lc-upc', 'the FS LC patch panel presents LC, not copper');
  }
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
