'use strict';
// QSFP-DD: 200G/400G cages, and the backward-compatible downshift that makes them
// useful (issue #12).
//
// The cage set stopped at QSFP28/100G, so a 200G uplink could not be modelled at all
// - the Adtran SDX 6330 was rejected by the importer for exactly this. Adding the
// cage is easy; the interesting part is that a QSFP-DD port accepts a QSFP28 module
// and negotiates down to 100G. That is the "complex but possible" case this project
// exists to allow, as opposed to the impossible one it must refuse (fibre into a
// copper socket).
const media = require('../engine/media');
const { Topology } = require('../engine');
const { loadCatalog } = require('../devices/registry');
const path = require('path');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg); }
}

console.log('The cage exists and carries the right media:');
{
  ok(!!media.CAGES.qsfpdd, 'a QSFP-DD cage is defined');
  ok(media.CAGES.qsfpdd.family === 'optical', 'and it is an optical cage');
  const list = media.CAGE_MEDIA.qsfpdd(400000);
  ok(list.some(function (m) { return /200gbase/.test(m); }), '200G optics are offered');
  ok(list.some(function (m) { return /400gbase/.test(m); }), '400G optics are offered');
  ok(list.some(function (m) { return /100gbase/.test(m); }),
    'and 100G optics too, because a QSFP28 module fits the slot');
  const caps200 = media.CAGE_SPEEDS.qsfpdd(200000);
  ok(caps200.indexOf(200000) !== -1, 'a 200G port can run 200G');
  ok(caps200.indexOf(400000) === -1, 'but not 400G - the port caps it');
  const caps400 = media.CAGE_SPEEDS.qsfpdd(400000);
  ok(caps400.indexOf(400000) !== -1, 'a 400G port can run 400G');
}

console.log('\nCages mate only where they physically can:');
{
  ok(media.cagesMate('qsfpdd', 'qsfpdd') === true, 'QSFP-DD meets QSFP-DD');
  ok(media.cagesMate('qsfpdd', 'qsfp28') === true, 'QSFP-DD takes a QSFP28 module');
  ok(media.cagesMate('qsfpdd', 'qsfp+') === true, 'and a QSFP+ module');
  ok(media.cagesMate('qsfpdd', 'rj45') === false, 'but never a copper socket');
  ok(media.cagesMate('qsfpdd', 'sfp+') === false, 'nor an SFP+ slot');
}

console.log('\nA 400G port accepts a 100G module and downshifts:');
{
  const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
  const sdx = catalog.find(function (s) { return s.model === 'SDX 6330'; });
  ok(!!sdx, 'the SDX 6330 (the spec this issue unblocked) is in the catalogue');

  const probe = new Topology().addDevice(sdx);
  const qdd = [...probe.interfaces.values()].filter(function (i) { return i.hardware.cage === 'qsfpdd'; });
  ok(qdd.length > 0, 'and it models QSFP-DD ports (' + qdd.map(function (p) { return p.name; }).join(', ') + ')');
  ok(qdd.every(function (p) { return p.hardware.maxSpeedMbps === 200000; }), 'the 200G ports cap at 200G');

  // A 100G QSFP28 switch to plug into.
  let peerSpec = null, peerPort = null;
  for (const s of catalog) {
    if (s === sdx) continue;
    const d = new Topology().addDevice(s);
    const p = [...d.interfaces.values()].find(function (i) { return i.hardware.cage === 'qsfp28'; });
    if (p) { peerSpec = s; peerPort = p.name; break; }
  }
  ok(!!peerSpec, 'a QSFP28/100G switch exists to test against (' +
    (peerSpec ? peerSpec.vendor + '/' + peerSpec.model : 'none') + ')');

  if (peerSpec) {
    const t = new Topology();
    const a = t.addDevice(sdx);
    const b = t.addDevice(peerSpec);
    const v = t.validateLink(a.id, qdd[0].name, b.id, peerPort, {});
    ok(v && v.ok, 'a 200G QSFP-DD port can be cabled to a 100G QSFP28 port');
    if (v && v.ok) {
      const link = t.connect(a.id, qdd[0].name, b.id, peerPort);
      ok(link.speedMbps === 100000,
        'and the link negotiates down to 100G rather than pretending to be 200G (' + link.speedMbps + ')');
      ok(/100gbase/.test(String(link.mediaId)), 'using a 100G optic (' + link.mediaId + ')');
    }
  }
}

console.log('\nAnd the impossible case is still refused:');
{
  const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
  const sdx = catalog.find(function (s) { return s.model === 'SDX 6330'; });
  const pc = catalog.find(function (s) { return s.vendor === 'generic' && s.model === 'generic-pc'; });
  const t = new Topology();
  const a = t.addDevice(sdx);
  const b = t.addDevice(pc);
  const qdd = [...a.interfaces.values()].find(function (i) { return i.hardware.cage === 'qsfpdd'; });
  const v = t.validateLink(a.id, qdd.name, b.id, 'eth0', {});
  ok(v && !v.ok, 'a QSFP-DD cage refuses a copper RJ45 peer');
  ok(v && v.errors && v.errors.length > 0, 'and says why (' +
    (v && v.errors && v.errors[0] && v.errors[0].code) + ')');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
