#!/usr/bin/env node
/**
 * A PON lab without a 10G uplink is a tree with no trunk.
 *
 * Three OLT chassis promised 10G SFP+ uplinks in their descriptions and had none in the catalogue
 * (#987). Two of them had the ports but declared no connector, so the engine guessed a cage - and
 * the guess for a 10G port is the one rate where copper and fibre are equally plausible, which is
 * how a fibre uplink becomes an RJ45 socket (see #1069). The third had no uplink at all.
 *
 * The datasheets settled the details, and one of them surprised the model: FiberHome's HU2A card
 * puts its 10GE ports in **XFP** cages, not SFP+. XFP is larger, 10G-only, and an SFP+ module does
 * not seat in it - so the uplink is checked here against the cage a technician would actually meet.
 */
'use strict';

const path = require('path');
const { Topology } = require('../engine');
const { loadCatalog } = require('../devices/registry');
const media = require('../engine/media');

let passed = 0, failed = 0;
function ok(cond, name) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name); }
}
function t(name, fn) {
  console.log('\n' + name);
  if (typeof fn !== 'function') return;
  try { fn(); } catch (e) { failed++; console.log('  ✗ threw: ' + e.message); }
}

const specs = loadCatalog(path.join(__dirname, '..', 'devices'));
const byModel = {};
for (const s of specs) byModel[s.vendor + '/' + s.model] = s;
function devOf(key) {
  if (!byModel[key]) throw new Error('missing ' + key);
  return new Topology().addDevice(byModel[key]);
}

// A real aggregation peer with SFP+ ports: this is the trunk end of a PON lab.
const PEER = 'mikrotik/CRS326-24G-2S+RM';
function peerSfpPlus(name) {
  const dev = devOf(PEER);
  const list = [...dev.interfaces.values()].filter(p => p.hardware.cage === 'sfp+');
  return list[name || 0];
}

// ---------------------------------------------------------------------------
t('XFP is its own cage, and an SFP+ module does not fit it');

ok(!!media.CAGES.xfp, 'the xfp cage exists');
ok(media.CAGE_SPEEDS.xfp(10000).indexOf(10000) !== -1, 'it carries 10G');
ok(media.CAGE_SPEEDS.xfp(10000).every(n => n >= 10000), 'and nothing slower (an XFP cage is 10G only)');
ok(media.cagesMate('xfp', 'xfp'), 'XFP mates with XFP');
ok(!media.cagesMate('xfp', 'sfp+') && !media.cagesMate('sfp+', 'xfp'),
  'and not with SFP+, in either direction - they are different sizes');

{
  const xfp = media.derivePortHardware({ name: 'x', type: 'ethernet', connector: 'xfp', speed: '10G' });
  const sfp = media.derivePortHardware({ name: 's', type: 'ethernet', connector: 'sfp+', speed: '10G' });
  const v = media.canMate(xfp, sfp);
  ok(v.ok === false, 'an XFP port refuses an SFP+ port');
  ok(v.code === 'E_CONNECTOR_MISMATCH', 'as a connector problem, which is what it is (got ' + v.code + ')');
  const both = media.canMate(xfp, media.derivePortHardware({ name: 'y', type: 'ethernet', connector: 'xfp', speed: '10G' }));
  ok(both.ok === true && both.speedMbps === 10000, 'two XFP ports link at 10G');
}

// ---------------------------------------------------------------------------
t('Each chassis has the uplinks its datasheet describes');

const EXPECT = [
  ['adtran/SDX 6320', 'qsfp28', 4, 100000, '4x 100GbE QSFP28'],
  ['adtran/SDX 6320', 'sfp+', 4, 10000, '4x 10GbE SFP+'],
  ['fiberhome/AN5516-01', 'xfp', 2, 10000, '2x 10GE XFP (HU2A)'],
  ['huawei/MA5600T', 'sfp+', 2, 10000, '2x 10GE SFP+ (H801X2CS)']
];

for (const [key, cage, count, rate, why] of EXPECT) {
  const dev = devOf(key);
  const ports = [...dev.interfaces.values()].filter(p => p.hardware.cage === cage && p.hardware.maxSpeedMbps === rate);
  ok(ports.length === count, key + ': ' + why + ' (' + ports.length + '/' + count + ')');
  const bare = ports.filter(p => !(p.hardware.media || []).length);
  ok(bare.length === 0, key + ': those ' + cage + ' ports have a medium to cable with');
}

// ---------------------------------------------------------------------------
t('The uplink actually connects to an upstream switch');

for (const [key, index] of [['adtran/SDX 6320', 0], ['huawei/MA5600T', 0]]) {
  const olt = devOf(key);
  const up = [...olt.interfaces.values()].filter(p => p.hardware.cage === 'sfp+' && p.hardware.maxSpeedMbps === 10000)[index];
  const peer = peerSfpPlus(index);
  const v = media.canMate(up.hardware, peer.hardware);
  ok(v.ok === true, key + ': its 10G SFP+ uplink cables to a 10G aggregation switch');
  ok(v.speedMbps === 10000, 'and runs at 10G, not at the 1G fallback');
}

{
  // The XFP uplink reaches the same switch, but only through an XFP peer: this asserts the
  // refusal rather than pretending the two cages are the same.
  const olt = devOf('fiberhome/AN5516-01');
  const up = [...olt.interfaces.values()].find(p => p.hardware.cage === 'xfp');
  const peer = peerSfpPlus(0);
  const v = media.canMate(up.hardware, peer.hardware);
  ok(v.ok === false, 'an XFP uplink refuses an SFP+ switch port, as the hardware does');
  ok(/XFP|connector/i.test(v.message), 'and the message is about the connector');
}

// ---------------------------------------------------------------------------
t('The uplink can run fibre at its own rate');

// Not "is fibre only": an SFP+ cage really does accept a 1000BASE-T SFP, and refusing that option
// would be the model lying in the other direction. The claim that matters is that a fibre module
// exists at the port's own rate, because that is what an OLT uplink is for.
const noFibre = [];
for (const [key] of EXPECT) {
  const dev = devOf(key);
  for (const p of dev.interfaces.values()) {
    if (!['qsfp28', 'sfp+', 'xfp'].includes(p.hardware.cage)) continue;
    const fibres = (p.hardware.media || []).filter(function (id) {
      const m = media.mediaById(id);
      return m && m.family === 'fiber' && m.speedMbps >= p.hardware.maxSpeedMbps * 0.98;
    });
    if (!fibres.length) noFibre.push(key + '/' + p.name + ' (' + p.hardware.maxSpeedMbps + 'M)');
  }
}
ok(noFibre.length === 0, 'every chassis uplink has a fibre medium at its own rate' +
  (noFibre.length ? ' (' + noFibre.slice(0, 3).join('; ') + ')' : ''));

// ---------------------------------------------------------------------------
t('The subscriber side stays PON');

{
  const dev = devOf('huawei/MA5600T');
  const dsl = [...dev.interfaces.values()].filter(p => p.hardware.cage === 'dsl');
  ok(dsl.length === 48, 'MA5600T keeps its 48 VDSL2 ports (' + dsl.length + ')');
  const ge = [...dev.interfaces.values()].filter(p => p.hardware.cage === 'sfp' && p.hardware.maxSpeedMbps === 1000);
  ok(ge.length === 4, 'and the SCUN board\'s four GE optical uplinks (' + ge.length + ')');
}

{
  const dev = devOf('fiberhome/AN5516-01');
  const pon = [...dev.interfaces.values()].filter(p => p.hardware.cage === 'sc-apc');
  ok(pon.length === 16, 'AN5516-01 keeps its 16 GPON ports (' + pon.length + ')');
  const sfp = [...dev.interfaces.values()].find(p => p.hardware.cage === 'sfp');
  const ponPort = pon[0];
  if (sfp) {
    const v = media.canMate(ponPort.hardware, sfp.hardware);
    ok(v.ok === false, 'and a GPON port is not cablable to an Ethernet SFP port');
  }
}

{
  const dev = devOf('adtran/SDX 6320');
  const pon = [...dev.interfaces.values()].filter(p => p.hardware.cage === 'sc-apc');
  ok(pon.length === 16, 'SDX 6320 keeps its 16 combo PON ports (' + pon.length + ')');
  ok(pon.every(p => (p.hardware.speedCaps || []).indexOf(9953) !== -1),
    'each of which carries XGS-PON at 9953 Mbps');
}

// ---------------------------------------------------------------------------
t('No OLT in the catalogue promises an uplink it cannot run');

{
  // The general rule, applied to every device filed as an OLT: if the description names a
  // 10G/100G uplink, a port must exist at that rate in a fibre cage.
  const oltSpecs = specs.filter(s => String(s.category) === 'olt');
  const missing = [];
  for (const spec of oltSpecs) {
    const desc = String(spec.description || '');
    const claims = desc.match(/(\d+)\s*[x\u00d7]\s*(\d+)\s*Gb?E\s*(QSFP28|QSFP\+|SFP\+|XFP|SFP)/gi) || [];
    if (!claims.length) continue;
    let dev;
    try { dev = new Topology().addDevice(spec); } catch (e) { continue; }
    const fibrePorts = [...dev.interfaces.values()].filter(p =>
      ['qsfp28', 'qsfp+', 'sfp+', 'xfp', 'sfp', 'sfp28', 'qsfp56', 'qsfpdd'].includes(p.hardware.cage));
    for (const claim of claims) {
      const m = /(\d+)\s*[x\u00d7]\s*(\d+)\s*Gb?E\s*(\S+)/i.exec(claim);
      if (!m) continue;
      const count = Number(m[1]);
      const rate = Number(m[2]) * 1000;
      const usable = fibrePorts.filter(p => p.hardware.maxSpeedMbps >= rate * 0.98);
      if (usable.length < count) {
        missing.push(spec.vendor + '/' + spec.model + ': ' + claim + ' (' + usable.length + ' port(s))');
      }
    }
  }
  ok(missing.length === 0, 'every counted uplink claim in an OLT description has ports behind it' +
    (missing.length ? ' (' + missing.slice(0, 4).join('; ') + ')' : ''));
  ok(oltSpecs.length > 3, 'and the rule ran over the OLT category (' + oltSpecs.length + ' devices)');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
