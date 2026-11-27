'use strict';
// ===========================================================================
// test/mikrotik-ccr2004-1g-12s-2xs-sfp-rates.test.js
//
// The twelve SFP+ cages on the CCR2004-1G-12S+2XS were declared `speedCaps:
// [10000]`, i.e. 10G only. That is not what MikroTik ships: their wired
// interface compatibility page lists the model under "Devices which SFP+ ports
// support 1G links" - "All SFP+ interfaces can be used in 1G mode if required".
// A 1G SFP uplink into SFP+1 was therefore refused by the simulator, and the
// only fix is a device fact, not an engine change: the sfp+ ladder already
// carries 1000, so the spec has to stop narrowing it to 10000.
//
// MikroTik also lists this model for 2.5G in both SFP+ and SFP28 cages. That
// claim is deliberately NOT declared here: no 2500BASE-X medium exists in the
// catalogue and the cage ladders carry no 2.5G optical rate, so a 2500
// speedCap would name a rate the connector table cannot honour. The last block
// pins that down so a later pass cannot quietly add it as a "fix".
//
// Run: node test/mikrotik-ccr2004-1g-12s-2xs-sfp-rates.test.js
// ===========================================================================

const path = require('path');
const media = require('../engine/media');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg); }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
const spec = catalog.filter(function (s) {
  return String(s.vendor).toLowerCase() === 'mikrotik' && s.model === 'CCR2004-1G-12S+2XS';
})[0];

ok(!!spec, 'devices/mikrotik/ccr2004-1g-12s-2xs.json is in the catalogue');
if (!spec) { console.error('\n0 passed, 1 failed'); process.exit(1); }

const hw = media.derivePortHardware;
const sfp1 = hw({ name: 'SFP+1', type: 'ethernet', speed: '10G', connector: 'sfp+',
  speedCaps: spec.portTemplate.speedCaps }, spec);
const sfp12 = hw({ name: 'SFP+12', type: 'ethernet', speed: '10G', connector: 'sfp+',
  speedCaps: spec.portTemplate.speedCaps }, spec);
const sfp28 = hw(spec.interfaces.filter(function (i) { return i.name === 'SFP28-1'; })[0], spec);

console.log('\nThe twelve SFP+ cages are not 10G-only:');
{
  ok(Array.isArray(spec.portTemplate.speedCaps), 'the portTemplate declares speedCaps at all');
  ok(spec.portTemplate.connector === 'sfp+', 'the portTemplate names its cage (sfp+)');
  ok(spec.portTemplate.count === 12, 'and there are twelve of them');
  ok(spec.portTemplate.speedCaps.indexOf(1000) !== -1,
    '1G is declared on the SFP+ cages (' + spec.portTemplate.speedCaps.join('/') + ')');
  ok(spec.portTemplate.speedCaps.indexOf(10000) !== -1, '10G is still declared');
  ok(sfp1.maxSpeedMbps === 10000, 'SFP+1 tops out at 10G (' + sfp1.maxSpeedMbps + ')');
  ok(sfp1.speedCaps.indexOf(1000) !== -1, 'SFP+1 can train at 1G (' + sfp1.speedCaps.join('/') + ')');
  ok(sfp12.speedCaps.indexOf(1000) !== -1, 'so can SFP+12 - the declaration is a template, not one port');
}

console.log('\nA 1G module in a cage now actually links:');
{
  const oneGigSfp = hw({ name: 'SFP1', type: 'ethernet', speed: '1G', connector: 'sfp' }, { model: 'PEER' });
  const mate = media.canMate(sfp1, oneGigSfp);
  ok(mate.ok, 'SFP+1 mates a 1G SFP peer' + (mate.ok ? '' : ' (' + mate.code + ': ' + mate.message + ')'));
  ok(media.negotiateSpeed(sfp1, oneGigSfp) === 1000, 'and the link runs at 1000 Mbps');
  ok(sfp1.media.indexOf('1000base-lx') !== -1, 'the 1G optics are offered on the cage');
  const tenGigSfp = hw({ name: 'SFP2', type: 'ethernet', speed: '10G', connector: 'sfp+' }, { model: 'PEER2' });
  ok(media.canMate(sfp1, tenGigSfp).ok, 'a 10G SFP+ peer still mates');
  ok(media.negotiateSpeed(sfp1, tenGigSfp) === 10000, 'and still runs at 10G');
}

console.log('\nThe two SFP28 cages keep their cage defaults:');
{
  ok(sfp28.cage === 'sfp28', 'SFP28-1 derives an sfp28 cage');
  ok(sfp28.speedCaps.indexOf(25000) !== -1, '25G is available');
  ok(sfp28.speedCaps.indexOf(10000) !== -1, '10G is available');
  ok(sfp28.speedCaps.indexOf(1000) !== -1, '1G is available');
}

console.log('\n2.5G is stated by the vendor but is NOT claimed here:');
{
  ok(spec.portTemplate.speedCaps.indexOf(2500) === -1,
    'the SFP+ template does not declare 2500 - no 2500BASE-X medium exists to carry it');
  ok(sfp1.speedCaps.indexOf(2500) === -1, 'and no 2.5G rate is offered on SFP+1');
  ok(media.mediaById('2500base-x') === null || !media.MEDIA['2500base-x'],
    'there is indeed no 2500BASE-X medium in the catalogue yet');
}

console.log('\nThe claim is cited:');
{
  ok(/wired-connections\/mikrotik-wired-interface-compatibility/.test(spec.notes),
    'notes cite the compatibility page');
  ok(/All SFP\+ interfaces can be used in 1G mode/.test(spec.notes),
    'and quote the sentence that lists this model for 1G');
  ok(spec.sourceUrl === 'https://mikrotik.com/product/ccr2004_1g_12s_2xs',
    'the spec keeps its product-page sourceUrl');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
