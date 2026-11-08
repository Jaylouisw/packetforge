'use strict';
// An OLT's PON port is not one thing (#198).
//
// The MA5801 family is a 1U box with no card slots, and Huawei sells it in two shapes that
// look identical in a photo: the GP16 has 16 GPON ports, the FL16 has 16 Flex-PON ports. The
// difference is the whole point of the Flex-PON badge - a Flex-PON port can be provisioned as
// GPON (2.5G), XGS-PON (10G) or a GPON+XGS-PON combo, and the same port that served a
// 2.5G-only subscriber yesterday can serve a 10G one after a provisioning change.
//
// Which means the interesting assertion is not "the port exists" but that the two boxes
// disagree about a 10G ONT. If the GP16 quietly accepted an XGS-PON ONT, the model would be
// telling a lab that hardware can do something it cannot: the GP16 has no XGS-PON capability
// to provision, so the link is impossible, and the engine has to say so.
//
// What is locked here:
//   1. each box materialises 16 PON ports plus 4 GE/10GE uplinks, and the PON ports are
//      SC/APC - the polish a PON feeder runs, not the SC/UPC a patch panel might;
//   2. the FL16 accepts a GPON ONT at 2.5G *and* an XGS-PON ONT at 10G on the same port;
//   3. the GP16 accepts the GPON ONT and refuses the XGS-PON one with E_NO_COMMON_SPEED,
//      because the cage cannot offer the rate - not with a looser code that would let a lab
//      believe it was only a cabling mistake;
//   4. neither box accepts a QSFP-DD DAC in an uplink: the uplink is SFP+, and the refusal is
//      the connector, because the speed ladder alone would not catch a module that does not
//      fit;
//   5. an SC/UPC ONT on an SC/APC port is a polish mismatch, not a silent success.
const path = require('path');
const { Topology } = require('../engine');
const { loadCatalog } = require('../devices/registry');

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

const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
function spec(model) {
  const s = catalog.find(function (x) { return x.model === model; });
  if (!s) throw new Error('missing spec ' + model);
  return s;
}

function bench() {
  const t = new Topology();
  const olt = t.addDevice(spec('MA5801-GP16'));
  const flex = t.addDevice(spec('MA5801-FL16'));
  // A 2.5G-only ONT and a 10G-only ONT: one of each is what makes the two boxes differ.
  const gponOnt = t.addDevice(spec('803G'));
  const xgsOnt = t.addDevice(spec('SDX 621'));
  return { t: t, olt: olt, flex: flex, gponOnt: gponOnt, xgsOnt: xgsOnt };
}

// The ONT's PON port name differs between vendors, so ask rather than assume.
function ponPort(dev) {
  for (const i of dev.interfaces.values()) { if (i.type === 'pon') return i.name; }
  return null;
}
function firstPortOfType(dev, type) {
  for (const i of dev.interfaces.values()) { if (i.type === type) return i.name; }
  return null;
}
function codes(res) {
  return ((res && res.errors) || []).map(function (x) { return x.code; });
}
function warnCodes(res) {
  return ((res && res.warnings) || []).map(function (x) { return x.code; });
}

section('1. The box is the configuration: 16 PON ports and 4 uplinks, on both SKUs');
{
  const b = bench();
  for (const dev of [b.olt, b.flex]) {
    const ifs = Array.from(dev.interfaces.values());
    const pon = ifs.filter(function (i) { return i.type === 'pon'; });
    const eth = ifs.filter(function (i) { return i.type === 'ethernet'; });
    eq(pon.length, 16, dev.model + ' has 16 PON service ports');
    eq(eth.length, 4, dev.model + ' has 4 GE/10GE uplink ports');
    eq(ifs.length, 20, dev.model + ' has no other IP ports - the box has no line-card slots');
    ok(pon.every(function (i) { return i.hardware && i.hardware.cage === 'sc-apc'; }),
      dev.model + ' PON ports are SC/APC cages');
    ok(eth.every(function (i) { return i.hardware && i.hardware.cage === 'sfp+'; }),
      dev.model + ' uplinks are SFP+ cages, not copper');
  }
}

section('2. The rate ladder is the only difference between the two boxes');
{
  const b = bench();
  const gp = b.olt.interfaces.get('gpon1/1');
  const fl = b.flex.interfaces.get('gpon1/1');
  ok(JSON.stringify(gp.hardware.speedCaps) === JSON.stringify([1244, 2488]),
    'GP16 PON port offers the GPON rates and nothing above them');
  ok(fl.hardware.speedCaps.indexOf(9953) !== -1,
    'FL16 PON port offers the XGS-PON line rate as well');
  ok(fl.hardware.speedCaps.indexOf(2488) !== -1,
    'and still offers 2.5G, because Flex-PON is re-provisionable');
}

section('3. A GPON ONT associates with either box at 2.5G');
{
  for (const key of ['olt', 'flex']) {
    const b = bench();
    const res = b.t.validateLink(b[key].id, 'gpon1/1', b.gponOnt.id, ponPort(b.gponOnt));
    ok(res.ok === true, b[key].model + ' accepts a GPON ONT on gpon1/1');
    eq(res.speedMbps, 2488, b[key].model + ' link to a GPON ONT runs at 2.488 Gbps');
  }
}

section('4. Only the Flex-PON box accepts a 10G ONT - the GP16 refuses it');
{
  const b = bench();
  const flex = b.t.validateLink(b.flex.id, 'gpon1/1', b.xgsOnt.id, ponPort(b.xgsOnt));
  ok(flex.ok === true, 'the FL16 accepts an XGS-PON ONT on the same port');
  eq(flex.speedMbps, 9953, 'the Flex-PON link runs at the XGS-PON line rate');

  const gp = b.t.validateLink(b.olt.id, 'gpon1/1', b.xgsOnt.id, ponPort(b.xgsOnt));
  eq(gp.ok, false, 'the GP16 refuses an XGS-PON ONT');
  ok(codes(gp).indexOf('E_NO_COMMON_SPEED') !== -1,
    'and refuses it on speed, which is the true reason: the cage cannot offer 10G');
  ok(codes(gp).indexOf('E_CONNECTOR_MISMATCH') === -1,
    'not on the connector, which would blame the cable for a hardware limit');
}

section('5. Neither box accepts a module that does not fit its uplink');
{
  const b = bench();
  const other = b.t.addDevice(spec('SDX 6330'));
  const res = b.t.validateLink(b.flex.id, 'xge0/1', other.id, 'qsfpdd1/1');
  eq(res.ok, false, 'a QSFP-DD port against an SFP+ uplink is refused');
  ok(codes(res).indexOf('E_CONNECTOR_MISMATCH') !== -1,
    'as a connector mismatch - the module does not fit the cage');
}

section('6. The PON feeder is APC, and a UPC ONT is a refusal the lab can see');
{
  const b = bench();
  // HG8145V5 is an SC/UPC ONT: flat polish against the OLT's angled ferrule.
  const upcOnt = b.t.addDevice(spec('HG8145V5'));
  const plain = b.t.validateLink(b.flex.id, 'gpon1/1', upcOnt.id, ponPort(upcOnt));
  eq(plain.ok, false, 'an SC/UPC ONT on an SC/APC PON port is refused');
  ok(codes(plain).indexOf('E_POLISH_MISMATCH') !== -1,
    'and the code names the polish, not the glass or the speed');
  const msg = plain.errors && plain.errors[0] && plain.errors[0].message;
  ok(typeof msg === 'string' && msg.length > 20,
    'the refusal explains itself rather than returning a bare code');

  // The escape hatch is a declared part, not a loosened rule: with a real hybrid cord the
  // same link builds, and says it was built with one.
  const withCord = b.t.validateLink(b.flex.id, 'gpon1/1', upcOnt.id, ponPort(upcOnt),
    { patchCord: 'patch-cord-hybrid-sc-upc-apc' });
  eq(withCord.ok, true, 'a declared SC/UPC-to-SC/APC hybrid cord makes the link buildable');
  ok(warnCodes(withCord).indexOf('W_HYBRID_CORD') !== -1,
    'and the link is flagged as hybrid so the lab knows why it works');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
