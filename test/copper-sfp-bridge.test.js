'use strict';
// A copper SFP in an SFP+ cage mates an RJ45 port (#1514).
//
// `connect()` refused an SFP+ cage against an RJ45 port outright, even when the spec or the caller said the
// cage holds `1000base-t-sfp` - which is what a copper SFP module is. The refusal contradicted the engine's
// own media table (CAGE_MEDIA['sfp+'] lists the module, so the cage is allowed to carry it) and offered no
// medium at all:
//
//   CRS305-1G-4S+IN/SFP+4 <-> RT-AX89X/wan: Cannot mate SFP+ to RJ45 (incompatible connectors).
//   1000BASE-T SFP (1000base-t-sfp) is not supported by both ...; possible media: none.
//
// The module IS the converter: the cage is a module slot and the socket on the outside of that module is an
// ordinary RJ45. Common real install: a 10G SFP+ port fed with a copper SFP from a 1G RJ45 appliance.
//
// What must NOT change: an EMPTY SFP+ cage still refuses an RJ45 socket. The cage default offers the module
// as one of eleven things it might hold; "it might hold one" is not "it holds one", so the link has to say so
// (a declared `media: ["1000base-t-sfp"]` on the port, or `mediaId` on the cable).
const path = require('path');
const { Topology } = require('../engine');
const { loadCatalog } = require('../devices/registry');
const media = require('../engine/media');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices')).filter(function (s) { return !s.error; });
const CRS = catalog.filter(function (s) { return s.model === 'CRS305-1G-4S+IN'; })[0];
const AX = catalog.filter(function (s) { return s.model === 'RT-AX89X'; })[0];

function port(spec) { return media.derivePortHardware(spec, { model: 'X' }); }

// connect() throws on a refusal; a test that wants to report the failure rather than die on it needs this.
function tryConnect(t, aDev, aPort, bDev, bPort, opts) {
  try { return t.connect(aDev, aPort, bDev, bPort, opts || {}); }
  catch (e) { console.error('    connect refused: ' + e.message); return null; }
}

console.log('');
console.log('The rule itself: a declared copper module converts the cage to RJ45');
{
  const copperSfp = port({ name: 'SFP+1', connector: 'sfp+', speed: '10G', media: ['1000base-t-sfp'] });
  const rj45 = port({ name: 'eth0', speed: '1G' });
  const v = media.canMate(copperSfp, rj45);
  ok(v.ok === true, 'SFP+ holding a copper SFP mates an RJ45 port', v.code + ': ' + v.message);
  ok(JSON.stringify(v.media) === JSON.stringify(['1000base-t-sfp']),
    'and the medium is the module, which is what is on the floor', JSON.stringify(v.media));
  ok(v.speedMbps === 1000, 'at the module rate of 1G, not the cage rate of 10G (' + v.speedMbps + ')');

  const back = media.canMate(rj45, copperSfp);
  ok(back.ok === true, 'and the answer does not depend on which end is asked first', String(back.ok));

  ok(JSON.stringify(media.commonMedia(copperSfp, rj45)) === JSON.stringify(['1000base-t-sfp']),
    'commonMedia() lists it, so a refusal can name a medium instead of none',
    JSON.stringify(media.commonMedia(copperSfp, rj45)));
}

console.log('');
console.log('An empty cage is still not RJ45: the module has to be declared');
{
  const bare = port({ name: 'SFP+1', connector: 'sfp+', speed: '10G' });
  const rj45 = port({ name: 'eth0', speed: '1G' });
  ok(bare.media.indexOf('1000base-t-sfp') !== -1, 'the empty cage still offers the copper module as a possibility');
  const v = media.canMate(bare, rj45);
  ok(v.ok === false && v.code === 'E_CONNECTOR_MISMATCH',
    'but an empty SFP+ cage does not mate an RJ45 socket', v.code);
  ok(JSON.stringify(media.commonMedia(bare, rj45)) === '[]',
    'and offers no medium for it', JSON.stringify(media.commonMedia(bare, rj45)));

  const fibre = port({ name: 'SFP+1', connector: 'sfp+', speed: '10G', media: ['10gbase-sr'] });
  const v2 = media.canMate(fibre, rj45);
  ok(v2.ok === false && v2.code === 'E_CONNECTOR_MISMATCH',
    'and a declared fibre module does not either', v2.code);

  const sc = port({ name: 'gpon0/1', speed: '2.5G', connector: 'sc-apc' });
  ok(media.canMate(sc, rj45).ok === false, 'nor does an SC/APC PON port');
}

console.log('');
console.log('Rates still have to agree through the module');
{
  const only25 = port({ name: 'Ethernet1/1', cage: 'sfp28', speed: '25G', speedCaps: [25000], media: ['1000base-t-sfp'] });
  const rj45 = port({ name: 'eth0', speed: '1G' });
  const v = media.canMate(only25, rj45);
  ok(v.ok === false, 'a cage pinned to 25G cannot run a 1G module into a 1G RJ45 port', String(v.ok));
  ok(v.code === 'E_NO_COMMON_SPEED', 'and the refusal is about the rate, not the connector', v.code);
}

console.log('');
console.log('The install from the issue: CRS305 SFP+4 -> RT-AX89X wan');
{
  const t = new Topology();
  t.addDevice(CRS, 'sw');
  t.addDevice(AX, 'ap');

  const before = t.validateLink('sw', 'SFP+4', 'ap', 'wan', {});
  ok(before.ok === false, 'with no module named, the dry run still refuses it (nothing says the cage is loaded)', String(before.ok));

  const asked = t.validateLink('sw', 'SFP+4', 'ap', 'wan', { mediaId: '1000base-t-sfp' });
  ok(asked.ok === true, 'naming the module makes the dry run legal',
    (asked.errors || []).map(function (e) { return e.code + ' ' + e.message; }).join(' | '));
  ok(asked.mediaId === '1000base-t-sfp', 'and it is the medium the link is built with (' + asked.mediaId + ')');
  ok(asked.speedMbps === 1000, 'at 1G (' + asked.speedMbps + ')');

  const link = tryConnect(t, 'sw', 'SFP+4', 'ap', 'wan', { mediaId: '1000base-t-sfp' });
  ok(!!link && link.mediaId === '1000base-t-sfp', 'and connect() builds it without force',
    JSON.stringify(link && link.mediaId));
  ok(!!link && link.speedMbps === 1000, 'the cable runs at 1G, not the cage rate of 10G', String(link && link.speedMbps));
}

console.log('');
console.log('The module declared on the port is enough on its own');
{
  const spec = JSON.parse(JSON.stringify(CRS));
  const sfp = spec.interfaces.filter(function (i) { return i.name === 'SFP+4'; })[0];
  sfp.media = ['1000base-t-sfp'];
  const t = new Topology();
  t.addDevice(spec, 'sw');
  t.addDevice(AX, 'ap');
  const v = t.validateLink('sw', 'SFP+4', 'ap', 'wan', {});
  ok(v.ok === true, 'a port that declares the copper module mates an RJ45 port with no mediaId',
    (v.errors || []).map(function (e) { return e.code; }).join(','));
  ok(v.mediaId === '1000base-t-sfp', 'and the medium is the module (' + v.mediaId + ')');
  const link = tryConnect(t, 'sw', 'SFP+4', 'ap', 'wan');
  ok(!!link && link.speedMbps === 1000, 'and the link comes up at 1G', String(link && link.speedMbps));

  // A saved lab has to mean the same thing twice: the board comes back knowing the module is fitted, so
  // the cable can be re-validated rather than only drawn.
  const back = Topology.fromJSON(JSON.parse(JSON.stringify(t.serialize())));
  const portBack = back.getDevice('sw').interfaces.get('SFP+4').hardware;
  ok(portBack.mediaDeclared === true, 'the saved document records that the module is fitted');
  const v2 = media.canMate(portBack, port({ name: 'eth0', speed: '1G' }));
  ok(v2.ok === true, 'and the reloaded port still mates an RJ45 socket',
    v2.code + ': ' + v2.message);

  // An empty cage in a saved lab is still an empty cage, so a fresh board and a reloaded one agree.
  const bare = new Topology();
  bare.addDevice(CRS, 'sw2');
  bare.addDevice(AX, 'ap2');
  const bareBack = Topology.fromJSON(JSON.parse(JSON.stringify(bare.serialize())));
  ok(bareBack.getDevice('sw2').interfaces.get('SFP+4').hardware.mediaDeclared !== true,
    'a port with no module named stays an empty slot after a save and reload');
  const v3 = media.canMate(bareBack.getDevice('sw2').interfaces.get('SFP+4').hardware,
    port({ name: 'eth0', speed: '1G' }));
  ok(v3.ok === false && v3.code === 'E_CONNECTOR_MISMATCH', 'and still refuses an RJ45 socket', v3.code);
}

console.log('');
console.log('Every cage that can hold the module converts, and no other cage does');
{
  const rj45 = port({ name: 'eth0', speed: '1G' });
  const canHold = [];
  const cannot = [];
  // The population: module cages. rj45, combo and antenna are the copper and radio sockets, where the
  // question "does a copper module convert this cage" does not arise.
  const moduleCages = Object.keys(media.CAGES).filter(function (c) {
    return c !== 'rj45' && c !== 'combo' && c !== 'antenna';
  });
  for (const cage of moduleCages) {
    const p = port({ name: 'p1', cage: cage, speed: '10G', speedCaps: [1000, 10000], media: ['1000base-t-sfp'] });
    const v = media.canMate(p, rj45);
    const repertoire = media.MEDIA['1000base-t-sfp'] && (function () {
      try { return (media.CAGE_MEDIA[cage] || function () { return []; })(10000).indexOf('1000base-t-sfp') !== -1; }
      catch (e) { return false; }
    })();
    if (v.ok) canHold.push(cage);
    else if (repertoire) cannot.push(cage + ' (' + v.code + ')');
  }
  ok(canHold.length > 0, 'the module converts the cages that can hold it', canHold.join(','));
  ok(cannot.length === 0, 'and every cage whose repertoire offers the module converts too (no gap left)',
    cannot.join(' | '));
}

console.log('');
console.log('Catalogue-wide: no port mates RJ45 behind the engine back');
{
  const rj45 = port({ name: 'eth0', speed: '1G' });
  const surprises = [];
  // The population is every data port in the catalogue whose cage could hold the copper module; the
  // assertion is that mating an RJ45 socket follows the spec's word and nothing else.
  const everyPort = [];
  for (const spec of catalog) {
    for (const iface of (spec.interfaces || [])) everyPort.push({ spec: spec, iface: iface });
  }
  const candidates = everyPort
    .map(function (x) { x.hw = media.derivePortHardware(x.iface, x.spec); return x; })
    .filter(function (x) { return !/console|serial/i.test(String(x.iface.type || '')); })
    .filter(function (x) {
      return x.hw.cage !== 'rj45' && x.hw.cage !== 'combo' && x.hw.cage !== 'antenna';
    })
    .filter(function (x) { return (x.hw.media || []).indexOf('1000base-t-sfp') !== -1; });
  ok(candidates.length > 0, 'the catalogue has ports whose cage could hold the module', String(candidates.length));
  for (const c of candidates) {
    const declared = Array.isArray(c.iface.media) && c.iface.media.indexOf('1000base-t-sfp') !== -1;
    const v = media.canMate(c.hw, rj45);
    if (v.ok !== declared) {
      surprises.push(c.spec.model + '/' + c.iface.name + ' (' + c.hw.cage + ') declared=' + declared + ' mate=' + v.ok);
    }
  }
  ok(surprises.length === 0,
    'and each one mates RJ45 exactly when the spec says the module is fitted', surprises.slice(0, 4).join(' | '));
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
