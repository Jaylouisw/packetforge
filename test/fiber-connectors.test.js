'use strict';
// Fibre connectors and ferrule polish.
//
// The media model had no SC connector at all, so a PON port was indistinguishable
// from RJ45 copper and the SDX611's GPON port was being modelled as a 2.5 Gbit/s
// copper socket. Worse, nothing represented polish, so the single most common
// field error in fibre - an SC/APC patch into an SC/UPC socket - was silently
// accepted. Those ferrules are not intermateable: the 8 degree angled endface does
// not seat in a flat socket, costs about 3 dB, and can chip the endface.
const path = require('path');
const { Topology, Simulator } = require('../engine');
const media = require('../engine/media');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg); }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
const hw = media.derivePortHardware;

// An OLT PON port and an ONT PON port, which is the link a PON actually is.
const oltPon = hw({ name: 'gpon0/1', speed: '2.5G' }, { model: 'OLT' });
const ontPon = hw({ name: 'pon', speed: '2.5G' }, { model: 'ONT' });

console.log('A PON port is an SC connector, not copper:');
{
  ok(oltPon.cage === 'sc-apc', 'a port named gpon0/1 derives an SC/APC cage (' + oltPon.cage + ')');
  ok(ontPon.cage === 'sc-apc', 'a port named pon derives an SC/APC cage');
  ok(media.mediaById('gpon-sc-apc') !== null, 'GPON is a real medium in the catalogue');
  const copper = hw({ name: 'lan1', speed: '1G' }, { model: 'ONT' });
  const v = media.canMate(ontPon, copper);
  ok(!v.ok, 'an SC/APC PON port cannot be cabled to RJ45 copper');
  ok(v.code === 'E_CONNECTOR_MISMATCH', 'and it is refused as a connector mismatch (' + v.code + ')');
}

console.log('\nAPC and UPC are not intermateable:');
{
  const upc = hw({ name: 'pon', connector: 'sc-upc', speed: '2.5G' }, { model: 'ONT2' });
  const v = media.canMate(oltPon, upc);
  ok(!v.ok, 'SC/APC to SC/UPC is refused');
  ok(v.code === 'E_POLISH_MISMATCH', 'with a polish-specific verdict, not a generic one (' + v.code + ')');
  ok(/APC/.test(v.message) && /UPC/.test(v.message), 'the message names both polishes');
  ok(/3 dB|chip/.test(v.message), 'and explains the consequence rather than just saying no');

  const same = media.canMate(oltPon, ontPon);
  ok(same.ok, 'SC/APC to SC/APC mates');
  ok(same.speedMbps === 2488, 'GPON negotiates its real 2488 Mbit/s line rate (' + same.speedMbps + ')');
}

console.log('\nFerrule metadata is honest about the hardware:');
{
  const apc = media.ferrule('sc-apc');
  const upc = media.ferrule('sc-upc');
  ok(apc.polish === 'apc' && apc.angleDeg === 8, 'SC/APC is the 8 degree angled ferrule');
  ok(upc.polish === 'upc' && upc.angleDeg === 0, 'SC/UPC is flat');
  ok(apc.colour === 'green' && upc.colour === 'blue', 'and green/blue match the field convention');
  ok(media.polishMismatch('sc-apc', 'sc-upc') === true, 'polishMismatch flags the pair');
  ok(media.polishMismatch('sc-apc', 'sc-apc') === false, 'and not a matched pair');
  ok(media.polishMismatch('sc-apc', 'lc') === false, 'or a different connector shape entirely');
  const v = media.canMate(hw({ name: 'sfp1', speed: '1G' }, {}), oltPon);
  ok(v.code === 'E_CONNECTOR_MISMATCH', 'an LC cage to an SC port is a shape mismatch, not a polish one');
}

console.log('\nXGS-PON negotiates a different rate on the same connector:');
{
  const xgsOlt = hw({ name: 'gpon0/2', speed: '10G' }, { model: 'OLT-XGS' });
  const xgsOnt = hw({ name: 'pon', connector: 'sc-apc', speed: '10G' }, { model: 'S800E' });
  const v = media.canMate(xgsOlt, xgsOnt);
  ok(v.ok, 'two 10G SC/APC ports mate');
  ok(v.speedMbps === 9953, 'and negotiate the 9953 Mbit/s XGS-PON line rate (' + v.speedMbps + ')');
  const mixed = media.canMate(oltPon, xgsOnt);
  ok(mixed.ok && mixed.speedMbps === 2488,
    'a GPON port against an XGS-PON port settles on GPON rates (' + (mixed && mixed.speedMbps) + ')');
}

console.log('\nReal hardware carries the connector it actually has:');
{
  // Adtran's SDX 611 presents its PON on LC/UPC, not SC/APC. Asserting SC here is
  // what let the wrong connector survive: the test agreed with the spec, and both
  // disagreed with the hardware.
  const sdx = catalog.find(function (s) { return s.model === 'SDX611'; });
  const d = new Topology().addDevice(sdx);
  const pon = d.interfaces.get('pon');
  ok(pon.hardware.cage === 'lc-upc', 'SDX611 GPON port is LC/UPC');
  ok(pon.hardware.media.indexOf('gpon-lc-upc') !== -1, 'and offers GPON on an LC connector');
  const lan = d.interfaces.get('lan1');
  ok(lan.hardware.cage === 'rj45', 'while its LAN port is copper');
  ok(pon.hardware.cage !== lan.hardware.cage, 'so the PON port is not the LAN port in disguise');

  const s800 = catalog.find(function (s) { return s.model === 'S800E'; });
  const stick = new Topology().addDevice(s800);
  ok(stick.interfaces.get('pon').hardware.cage === 'sc-apc', 'S800E PON tail is SC/APC');
  ok(stick.interfaces.get('host').hardware.cage === 'sfp+', 'and its host edge is an SFP+ cage');
}

console.log('\nThe topology refuses the impossible cable, and accepts the real one:');
{
  // Two PON ports cabled together is the sane case; a PON port into a switch's
  // RJ45 is not.
  const oltSpec = {
    vendor: 'generic', model: 'generic-olt', label: 'OLT', category: 'olt',
    capabilities: ['l3-forward', 'cli'],
    interfaces: [{ name: 'gpon0/1', type: 'pon', speed: '2.5G', connector: 'sc-apc' }]
  };
  // The ONT has to match the OLT's connector: an SC/APC OLT cannot be cabled to the
  // SDX 611's LC/UPC port, and it should not be able to.
  const ontSpec = {
    vendor: 'generic', model: 'generic-ont', label: 'ONT', category: 'ont',
    capabilities: ['host'],
    interfaces: [{ name: 'pon', type: 'pon', speed: '2.5G', connector: 'sc-apc' }]
  };
  const t = new Topology();
  const olt = t.addDevice(oltSpec);
  const cpe = t.addDevice(ontSpec);
  const link = t.connect(olt.id, 'gpon0/1', cpe.id, 'pon');
  ok(!!link, 'an OLT PON port cables to an ONT PON port');
  const l = [...t.links.values()][0];
  ok(l && l.mediaId === 'gpon-sc-apc', 'the link is GPON over SC/APC (' + (l && l.mediaId) + ')');
  ok(l && l.speedMbps === 2488, 'and it negotiated 2488 Mbit/s (' + (l && l.speedMbps) + ')');

  const sw = catalog.find(function (s) { return s.vendor === 'aruba' && s.model === '2930F 24G 4SFP+'; });
  const t2 = new Topology();
  const olt2 = t2.addDevice(oltSpec);
  const switchDev = t2.addDevice(sw);
  const verdict = t2.validateLink(olt2.id, 'gpon0/1', switchDev.id, '1');
  ok(verdict && verdict.ok === false, 'a PON port into an RJ45 switch port is refused');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
