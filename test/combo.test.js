'use strict';
// Combo ports: one physical cage position that takes EITHER an RJ45 copper port
// OR an SFP module, never both. Real switches expose the pair as two logical
// interfaces and configuring one disables the other, so the simulator has to
// block the second cable rather than quietly allow two links through one cage.
const path = require('path');
const { Topology } = require('../engine');
const { loadCatalog } = require('../devices/registry');
const media = require('../engine/media');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg); }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
const AR2220 = catalog.find(function (s) { return s.vendor === 'huawei' && s.model === 'AR2220'; });

console.log('The combo cage exists and reaches both worlds:');
{
  ok(!!media.CAGES.combo, 'a combo cage is defined');
  ok(media.cagesMate('combo', 'rj45') && media.cagesMate('rj45', 'combo'),
    'a combo port mates with copper (both directions)');
  ok(media.cagesMate('combo', 'sfp+') && media.cagesMate('sfp+', 'combo'),
    'a combo port mates with fibre (both directions)');
  const list = media.CAGE_MEDIA.combo(1000);
  ok(list.indexOf('1000base-t') !== -1, 'its media set offers copper cabling');
  ok(list.indexOf('1000base-sx') !== -1, 'its media set offers fibre');
  ok(list.indexOf('10gbase-sr') === -1, 'and it does not offer rates above its cap');
}

console.log('\nAR2220 models 3 physical GE ports, one of them combo:');
{
  const t = new Topology();
  const d = t.addDevice(AR2220);
  ok(d.interfaces.size === 4, '4 interfaces for 3 physical ports (' + d.interfaces.size + ')');
  const cu = d.interfaces.get('Gi0/0/3');
  const fib = d.interfaces.get('Gi0/0/3-sfp');
  ok(!!cu && !!fib, 'the combo half and its SFP half both exist');
  ok(cu.comboWith === 'Gi0/0/3-sfp' && fib.comboWith === 'Gi0/0/3',
    'they point at each other');
  ok(cu.hardware.cage === 'rj45' && fib.hardware.cage === 'sfp',
    'one is copper and one is optical');
}

console.log('\nEither half works on its own:');
{
  const t = new Topology();
  const a = t.addDevice(AR2220), b = t.addDevice(AR2220);
  a.name = 'R1'; b.name = 'R2';
  const copper = t.validateLink(a.id, 'Gi0/0/3', b.id, 'Gi0/0/1', { mediaId: '1000base-t' });
  ok(copper.ok, 'copper into the combo half is accepted');
  const fibre = t.validateLink(a.id, 'Gi0/0/3-sfp', b.id, 'Gi0/0/3-sfp', { mediaId: '1000base-sx' });
  ok(fibre.ok, 'and so is fibre into the SFP half, if nothing is plugged in yet');
}

console.log('\nBut not both: one cage, one cable:');
{
  const t = new Topology();
  const a = t.addDevice(AR2220), b = t.addDevice(AR2220);
  a.name = 'R1'; b.name = 'R2';
  t.connect(a.id, 'Gi0/0/3', b.id, 'Gi0/0/1');

  // The dry-run path must report it too, not just connect().
  const verdict = t.validateLink(a.id, 'Gi0/0/3-sfp', b.id, 'Gi0/0/3-sfp', { mediaId: '1000base-sx' });
  ok(verdict.ok === false, 'the dry run refuses the sibling');
  ok(verdict.errors[0] && verdict.errors[0].code === 'E_COMBO_OCCUPIED',
    'with E_COMBO_OCCUPIED, got: ' + (verdict.errors[0] || {}).code);
  ok(/Gi0\/0\/3/.test(verdict.errors[0].message),
    'and the message names the port actually in use');

  let threw = null;
  try { t.connect(a.id, 'Gi0/0/3-sfp', b.id, 'Gi0/0/3-sfp', { mediaId: '1000base-sx' }); }
  catch (e) { threw = e; }
  ok(!!threw, 'connect() refuses it as well');
  ok(threw && threw.code === 'E_COMBO_OCCUPIED', 'carrying the same code');
}

console.log('\nPulling the cable frees the cage again:');
{
  const t = new Topology();
  const a = t.addDevice(AR2220), b = t.addDevice(AR2220);
  a.name = 'R1'; b.name = 'R2';
  const link = t.connect(a.id, 'Gi0/0/3', b.id, 'Gi0/0/1');
  t.disconnect(link.id !== undefined ? link.id : link);
  const verdict = t.validateLink(a.id, 'Gi0/0/3-sfp', b.id, 'Gi0/0/3-sfp', { mediaId: '1000base-sx' });
  ok(verdict.ok, 'once the copper link is gone the SFP half can be used');
}

console.log('\nA combo port still cannot take the wrong medium:');
{
  const t = new Topology();
  const a = t.addDevice(AR2220), b = t.addDevice(AR2220);
  a.name = 'R1'; b.name = 'R2';
  const bad = t.validateLink(a.id, 'Gi0/0/1', b.id, 'Gi0/0/2', { mediaId: '1000base-sx' });
  ok(bad.ok === false, 'fibre into a plain RJ45 port is still refused');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
