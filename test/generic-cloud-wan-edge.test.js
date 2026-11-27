'use strict';
// generic/generic-cloud declared exactly one port: eth0, 10G RJ45. So "the internet"
// could carry exactly one cable, of exactly one medium: no multihoming, no dual-homed
// ISPs, no fibre WAN, and nowhere for an ONT's PON line or a cable modem's coax drop to
// land (issue #30, and the "Cannot mate RJ45 to LC/UPC" failure when an ONT was cabled in).
//
// The fix is a WAN edge on the same object: four RJ45 hand-offs, three optical cages and
// GPON / XGS-PON / DOCSIS 3.1 / VDSL2 line ports. eth0 is kept unchanged so every saved lab
// and shipped example that cables the cloud to eth0 still loads; the new ports sit
// alongside it. A second object, generic/generic-isp, gives each provider its own endpoint.
//
// No vendor publishes this hardware - it is a synthetic object - so the evidence is the
// engine's own modelled families: rj45 ethernet, sfp+/sfp28/qsfp28 optics, sc-apc PON, f
// coax and rj11 DSL.
const path = require('path');
const { Topology } = require('../engine');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  OK ' + msg); }
  else { failed++; console.error('  FAIL ' + msg + (detail ? '  [' + detail + ']' : '')); }
}
function section(name) { console.log('\n' + name); }

const catalog = loadCatalog(path.join(__dirname, '..', 'devices')).filter(function (s) { return !s.error; });
function spec(vendor, model) {
  const s = catalog.filter(function (x) { return x.vendor === vendor && x.model === model; })[0];
  if (!s) throw new Error('missing spec ' + vendor + '/' + model);
  return s;
}
function cloud(model) {
  const t = new Topology();
  return t.addDevice(spec('generic', model || 'generic-cloud'), 'C');
}

section('The cloud is a WAN edge, not a single jack');
{
  const c = cloud();
  const names = [...c.interfaces.keys()];
  ok(names.length >= 10, 'the cloud has ten or more ports', names.join(','));
  ok(names.indexOf('eth0') !== -1, 'eth0 is still there, so saved labs keep loading');
  ok(c.interfaces.get('eth0').hardware.cage === 'rj45' &&
    c.interfaces.get('eth0').hardware.maxSpeedMbps === 10000,
    'and eth0 is still the 10G RJ45 port it always was',
    c.interfaces.get('eth0').hardware.cage + ' ' + c.interfaces.get('eth0').hardware.maxSpeedMbps);
  ok(JSON.stringify(spec('generic', 'generic-cloud').capabilities).indexOf('"l3-forward"') !== -1,
    'the cloud still forwards');
}

section('Four copper hand-offs at 1G / 1G / 2.5G / 10G');
{
  const c = cloud();
  const expect = { wan1: 1000, wan2: 1000, wan3: 2500, eth0: 10000 };
  Object.keys(expect).forEach(function (n) {
    const p = c.interfaces.get(n);
    ok(!!p && p.hardware.cage === 'rj45', n + ' is an RJ45 cage', p && p.hardware.cage);
    ok(!!p && p.hardware.maxSpeedMbps === expect[n], n + ' tops out at ' + expect[n] + ' Mbps',
      p && p.hardware.maxSpeedMbps);
  });
  ok(c.interfaces.get('wan1').hardware.media.indexOf('1000base-t') !== -1,
    'wan1 offers 1000BASE-T');
  ok(c.interfaces.get('wan3').hardware.media.indexOf('2.5gbase-t') !== -1,
    'wan3 offers 2.5GBASE-T (a 2.5G ONT/modem LAN can land on it)');
}

section('Optical hand-offs: 10G SFP+, 25G SFP28, 100G QSFP28');
{
  const c = cloud();
  ok(c.interfaces.get('sfp1').hardware.cage === 'sfp+', 'sfp1 is an SFP+ cage');
  ok(c.interfaces.get('sfp1').hardware.media.indexOf('10gbase-lr') !== -1, 'sfp1 offers 10GBASE-LR');
  ok(c.interfaces.get('sfp28-1').hardware.cage === 'sfp28', 'sfp28-1 is an SFP28 cage');
  ok(c.interfaces.get('sfp28-1').hardware.media.indexOf('25gbase-lr') !== -1, 'sfp28-1 offers 25GBASE-LR');
  ok(c.interfaces.get('qsfp28-1').hardware.cage === 'qsfp28', 'qsfp28-1 is a QSFP28 cage');
  ok(c.interfaces.get('qsfp28-1').hardware.media.indexOf('100gbase-lr4') !== -1,
    'qsfp28-1 offers 100GBASE-LR4');
}

section('Line-service ports: GPON, XGS-PON, DOCSIS 3.1, VDSL2');
{
  const c = cloud();
  ok(c.interfaces.get('pon1').hardware.cage === 'sc-apc', 'pon1 is SC/APC');
  ok(c.interfaces.get('pon1').hardware.media.join(',') === 'gpon-sc-apc',
    'pon1 is a GPON line (2.5G down)', c.interfaces.get('pon1').hardware.media.join(','));
  ok(c.interfaces.get('pon2').hardware.media.indexOf('xgspon-sc-apc') !== -1,
    'pon2 carries XGS-PON (10G) as well as GPON');
  ok(c.interfaces.get('coax1').hardware.cage === 'coax', 'coax1 is an F-connector');
  ok(c.interfaces.get('coax1').hardware.media.indexOf('docsis-31') !== -1,
    'coax1 offers DOCSIS 3.1');
  ok(c.interfaces.get('dsl1').hardware.cage === 'dsl', 'dsl1 is an RJ11');
  ok(c.interfaces.get('dsl1').hardware.media.indexOf('vdsl2-35b') !== -1,
    'dsl1 offers VDSL2 35b');
}

section('Behaviour: multihoming two routers into one cloud');
{
  const t = new Topology();
  const c = t.addDevice(spec('generic', 'generic-cloud'), 'NET');
  const r1 = t.addDevice(spec('generic', 'generic-router'), 'R1');
  const r2 = t.addDevice(spec('generic', 'generic-router'), 'R2');
  const l1 = t.connect(r1.id, 'Gi0/0', c.id, 'wan1');
  const l2 = t.connect(r2.id, 'Gi0/0', c.id, 'wan2');
  ok(!!l1 && !!l2 && l1.id !== l2.id, 'two routers hold two separate WAN links to the same cloud');
  ok(l1.speedMbps === 1000 && l2.speedMbps === 1000, 'both negotiate 1G',
    l1.speedMbps + '/' + l2.speedMbps);
  let threw = null;
  try { t.connect(r1.id, 'Gi0/1', c.id, 'wan1'); } catch (e) { threw = e; }
  ok(!!threw && /already connected/.test(threw.message),
    'one port still takes one cable: multihoming is more ports, not an overloaded one');
}

section('Behaviour: an ONT and a cable modem terminate on their own medium');
{
  const t = new Topology();
  const c = t.addDevice(spec('generic', 'generic-cloud'), 'NET');
  const ont = t.addDevice(spec('adtran', '411'), 'ONT');
  const pon = t.connect(ont.id, 'pon', c.id, 'pon1');
  ok(pon.mediaId === 'gpon-sc-apc', 'a GPON ONT PON port cables to cloud pon1', pon.mediaId);

  const t2 = new Topology();
  const c2 = t2.addDevice(spec('generic', 'generic-cloud'), 'NET');
  const ont2 = t2.addDevice(spec('adtran', 'SDX 621'), 'ONT2');
  const pon2 = t2.connect(ont2.id, 'pon1', c2.id, 'pon2');
  ok(pon2.mediaId === 'xgspon-sc-apc', 'an XGS-PON ONT PON port cables to cloud pon2', pon2.mediaId);

  const t3 = new Topology();
  const c3 = t3.addDevice(spec('generic', 'generic-cloud'), 'NET');
  const cm = t3.addDevice(spec('arris', 'SB8200'), 'CM');
  const coax = t3.connect(cm.id, 'coax', c3.id, 'coax1');
  ok(coax.mediaId === 'docsis-31', 'a DOCSIS 3.1 modem F-connector cables to cloud coax1', coax.mediaId);
}

section('Behaviour: the media still refuse what cannot exist');
{
  const t = new Topology();
  const c = t.addDevice(spec('generic', 'generic-cloud'), 'NET');
  const r = t.addDevice(spec('generic', 'generic-router'), 'R1');
  let bad = null;
  try { t.connect(r.id, 'Gi0/0', c.id, 'pon1'); } catch (e) { bad = e; }
  ok(!!bad && bad.code === 'E_CONNECTOR_MISMATCH',
    'an RJ45 WAN will not cable into a PON port', bad && bad.code);

  let copper = null;
  try { t.connect(r.id, 'Gi0/1', c.id, 'sfp1'); } catch (e) { copper = e; }
  ok(!!copper, 'a copper port will not cable into the 10G SFP+ cage',
    copper && (copper.code || copper.message));

  const dslRouter = t.addDevice(spec('avm', 'FRITZ!Box 7530'), 'DSL');
  const dsl = t.connect(dslRouter.id, 'dsl0', c.id, 'dsl1');
  ok(dsl.mediaId === 'vdsl2-35b', 'a VDSL2 router DSL port meets cloud dsl1 at 35b', dsl.mediaId);
}

section('A second cloud object makes two ISPs legible');
{
  const t = new Topology();
  const ispA = t.addDevice(spec('generic', 'generic-isp'), 'ISPA');
  const ispB = t.addDevice(spec('generic', 'generic-isp'), 'ISPB');
  const r = t.addDevice(spec('generic', 'generic-router'), 'R1');
  const a = t.connect(r.id, 'Gi0/0', ispA.id, 'port1');
  ok(a.speedMbps === 1000, 'ISP A terminates the 1G hand-off at 1G', a.speedMbps);
  ok(ispA.id !== ispB.id, 'the two providers are two distinct endpoints');
  ok(ispB.interfaces.get('port2').hardware.cage === 'rj45' &&
    ispB.interfaces.get('port2').hardware.maxSpeedMbps === 10000,
    'ISP B also has a 10G RJ45 hand-off',
    ispB.interfaces.get('port2').hardware.cage + ' ' + ispB.interfaces.get('port2').hardware.maxSpeedMbps);
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
