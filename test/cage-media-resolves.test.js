'use strict';
// A cage offered a medium that did not exist.
//
// Both SC cages returned '100base-fx' in their media list, and there was no MEDIA entry
// with that id - mediaById('100base-fx') returned null. So every PON port in the catalogue
// (111 devices carry sc-apc or sc-upc ports) advertised a medium the engine could not
// describe, and the device that actually needs it - the Allied Telesis AT-MC102XL's 100M
// sc-upc port - had no medium to be cabled with at all.
//
// The root cause is that a media id was written into a cage list in one place and the
// media itself was never added in another, and nothing compared the two. So the first
// check here is the general one: every id any cage offers, at any rate it might be asked
// about, must resolve. That invariant is what was missing.
//
// The second half is the specific hardware: 100BASE-FX terminates in a UPC ferrule, so the
// SC/APC PON cage must not offer it - an APC ferrule cannot mate with it without a hybrid
// cord, and offering a media that can never be used is the same class of lie as offering
// one that does not exist.
const path = require('path');
const { Topology } = require('../engine');
const media = require('../engine/media');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg); }
}
function eq(actual, expected, msg) {
  ok(actual === expected, msg + ' (expected ' + JSON.stringify(expected) +
    ', got ' + JSON.stringify(actual) + ')');
}
function section(name) { console.log('\n' + name); }

const specs = loadCatalog(path.join(__dirname, '..', 'devices'));

section('1. Every medium a cage offers actually exists');
{
  // The rate hint changes what a cage offers, so ask each cage at every rate band the
  // catalogue uses, plus the no-argument case.
  const hints = [undefined, 100, 1000, 2500, 10000, 25000, 40000, 100000];
  const phantom = [];
  const inspected = [];
  for (const cage of Object.keys(media.CAGE_MEDIA)) {
    for (const hint of hints) {
      let offered;
      try { offered = media.CAGE_MEDIA[cage](hint); }
      catch (e) { ok(false, 'CAGE_MEDIA[' + cage + '](' + hint + ') threw: ' + e.message); continue; }
      for (const id of offered || []) {
        inspected.push(cage + '/' + id);
        if (!media.mediaById(id)) phantom.push(cage + ' offers ' + id + ' (no MEDIA entry)');
      }
    }
  }
  ok(inspected.length > 50, 'inspected ' + inspected.length + ' cage-medium offers across ' +
    Object.keys(media.CAGE_MEDIA).length + ' cages');
  ok(phantom.length === 0, 'no cage offers a medium that does not resolve' +
    (phantom.length ? ': ' + phantom.slice(0, 4).join('; ') : ''));
}

section('2. 100BASE-FX is real, and described the way the hardware is');
{
  const fx = media.mediaById('100base-fx');
  ok(!!fx, 'mediaById("100base-fx") resolves');
  if (fx) {
    eq(fx.name, '100BASE-FX', 'it is named');
    eq(fx.family, 'fiber', 'it is fibre');
    eq(fx.speedMbps, 100, 'it runs at 100 Mbps');
    eq(fx.connector, 'sc-upc', 'and terminates in SC/UPC');
    eq(fx.maxRangeM, 2000, 'with a 2 km reach over multimode');
    eq(fx.fiber, 'mmf', 'declared as multimode');
    eq(fx.wavelengthNm, 1310, 'at 1310 nm');
  }
}

section('3. The device that needed it can now be cabled');
{
  const mc = specs.filter(function (s) { return /AT-MC102XL/.test(s.model); })[0];
  ok(!!mc, 'the AT-MC102XL media converter is in the catalogue');
  if (mc) {
    const port = (mc.interfaces || []).filter(function (i) { return i.connector === 'sc-upc'; })[0];
    ok(!!port, 'and it has an SC/UPC port');
    if (port) eq(port.speed, '100M', 'which is a 100M port (' + port.name + ')');

    // Two converters facing each other over one strand is the whole point of the part.
    const topo = new Topology();
    const a = topo.addDevice(mc);
    const b = topo.addDevice(mc);
    const v = topo.validateLink(a.id, port.name, b.id, port.name);
    ok(v.ok, 'two of them can be cabled together' + (v.ok ? '' : ': ' +
      JSON.stringify((v.issues || v.errors || v.error || []).slice(0, 2))));
    if (v.ok) {
      eq(v.speedMbps, 100, 'at 100 Mbps');
      const id = v.mediaId || v.media;
      ok(/100base-fx/.test(String(id)), 'over 100BASE-FX (got ' + id + ')');
    }
  }
}

section('4. The PON cage does not offer media it cannot mate');
{
  const apcOffers = media.CAGE_MEDIA['sc-apc'](2500) || [];
  ok(apcOffers.indexOf('100base-fx') === -1,
    'the SC/APC cage does not offer 100BASE-FX (UPC ferrule)');
  ok(apcOffers.indexOf('1000base-lx') === -1,
    'nor 1000BASE-LX (also a UPC ferrule)');
  ok(apcOffers.indexOf('gpon-sc-apc') !== -1, 'but it does offer GPON on SC/APC');

  // And the consequence, on a real OLT: no port advertises a medium that resolves to null.
  const olt = specs.filter(function (s) { return /SDX 6320/.test(s.model); })[0];
  ok(!!olt, 'a GPON OLT is in the catalogue');
  if (olt) {
    const d = new Topology().addDevice(olt);
    const pon = [...d.interfaces.values()].filter(function (i) { return i.cage === 'sc-apc'; })[0];
    ok(!!pon, 'with an SC/APC PON port (' + (pon && pon.name) + ')');
    if (pon) {
      const unresolvable = (pon.supportedMedia || []).filter(function (id) { return !media.mediaById(id); });
      ok(unresolvable.length === 0, 'whose supported media all resolve (' +
        (unresolvable.length ? unresolvable.join(', ') : 'none missing') + ')');
      ok((pon.supportedMedia || []).indexOf('100base-fx') === -1,
        'and do not include 100BASE-FX');
    }
  }
}

section('5. Nothing else changed about the SC/UPC cage');
{
  const upc = media.CAGE_MEDIA['sc-upc'](2500) || [];
  ok(upc.indexOf('gpon-sc-upc') !== -1, 'SC/UPC still offers GPON');
  ok(upc.indexOf('100base-fx') !== -1, 'and still offers 100BASE-FX');
  ok(upc.indexOf('1000base-lx') !== -1, 'and 1000BASE-LX at rates that carry it');
  ok((media.CAGE_MEDIA['sc-upc'](100) || []).indexOf('1000base-lx') === -1,
    'but not 1000BASE-LX on a 100M port');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
