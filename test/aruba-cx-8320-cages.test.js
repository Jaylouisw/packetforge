'use strict';
// The Aruba CX 8320 48SFP+ 6QSFP+'s 48 downlinks are SFP+ cages, not RJ45 sockets.
//
// The catalogue row described the box correctly - "48x 1/10G SFP+ plus 6x 40G QSFP+" - and declared no
// connector on the template, so `derivePortHardware()` fell back to its copper default: all 48 downlinks
// became RJ45 sockets carrying 10GBASE-T. `scripts/audit-port-types.js` reported the spec under
// "Template ports at 10G+ presented as RJ45 copper on a box that describes itself as SFP", and the
// practical effect was a data-centre leaf you could patch with a Cat6A lead and into which no SFP+ optic
// would fit - while the six QSFP+ uplinks next to them were cages, because a bare 40G rate is read as
// optical by `inferCage()` and a bare 10G rate is not.
//
// HPE's documentation for JL479A states both groups as module slots:
//
//   "Aruba 8320 48p 10G SFP/SFP+ and 6p 40G QSFP+ with X472 5 Fans 2 Power Supply Switch Bundle"
//   "Supports 48 ports of 1/10G for use with SFP and SFP+ transceivers, and 6 ports of 40G for use
//    with QSFP+ transceivers. Optional 1GBASE-T and 10GBASE-T transceivers and 4x10G breakout cables."
//   - HPE Aruba Networking CX 8320 Switch Series QuickSpecs, a00029141enw
//     https://www.hpe.com/us/en/collaterals/collateral.a00029141enw.html
//
// and the installation guide's port table gives the same row (48 SFP+ ports, 6 QSFP+ ports, no RJ-45)
// with the footnote "SFP+ ports support 1G SFP, 1G RJ-45, and 10G SFP+ transceivers":
//   https://arubanetworking.hpe.com/techdocs/hardware/switches/8320/IGSG/Aruba_8320_IGSG_en_us.pdf
//
// The 1GBASE-T/10GBASE-T "transceivers" are modules fitted in the SFP+ cage, not a copper socket - which
// is why this test still expects an RJ45 host to be refused unless a copper SFP is named on the cable.
// The catalogue has no 10GBASE-T SFP+ module (`1000base-t-sfp` exists, `10gbase-t-sfp` does not), so the
// 10G copper module the QuickSpecs name is a gap recorded in research/aruba-cx-8320-downlinks-sfp.md,
// not something this row can offer.
const path = require('path');
const { Topology } = require('../engine');
const media = require('../engine/media');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}
function section(name) { console.log('\n' + name); }

const catalog = loadCatalog(path.join(__dirname, '..', 'devices')).filter(function (s) { return !s.error; });
const spec = catalog.filter(function (s) { return s.vendor === 'aruba' && s.model === 'CX 8320 48SFP+ 6QSFP+'; })[0];
ok(!!spec, 'the catalogue has the Aruba CX 8320 48SFP+ 6QSFP+');
ok(!!spec && /SFP\+/.test(spec.description) && /QSFP\+/.test(spec.description),
  'and it describes itself as SFP+ downlinks and QSFP+ uplinks, which is the claim under test');

const t = new Topology();
const sw = t.addDevice(spec, 'LEAF');

section('The 48 downlinks are SFP+ cages');
{
  const copper = [];
  const noOptic = [];
  for (let n = 1; n <= 48; n++) {
    const p = sw.interfaces.get('1/1/' + n);
    if (!p || p.cage !== 'sfp+') copper.push('1/1/' + n + '=' + (p && p.cage));
    // An SFP+ cage has to be able to hold a 10G optic and a 1G one, or "SFP+" is only a label.
    const offered = (p && p.hardware.media) || [];
    if (offered.indexOf('10gbase-sr') === -1 || offered.indexOf('1000base-sx') === -1) {
      noOptic.push('1/1/' + n);
    }
  }
  ok(copper.length === 0, 'none of the 48 downlinks is an RJ45 socket' +
    (copper.length ? ' (' + copper.slice(0, 3).join(', ') + ')' : ''));
  ok(noOptic.length === 0, 'each one offers a 10G and a 1G optic' +
    (noOptic.length ? ' (' + noOptic.slice(0, 3).join(', ') + ')' : ''));
  const p1 = sw.interfaces.get('1/1/1');
  ok(p1.hardware.speedCaps.indexOf(1000) !== -1 && p1.hardware.speedCaps.indexOf(10000) !== -1,
    'and trains at 1G or 10G, the two rates the QuickSpecs name for this cage',
    JSON.stringify(p1.hardware.speedCaps));
  ok(p1.hardware.media.indexOf('1000base-t-sfp') !== -1,
    'a copper SFP (1GBASE-T module) is still a medium the cage can hold');
  ok(p1.hardware.family === 'optical', 'and the port reports an optical cage, not copper', p1.hardware.family);
}

section('The six uplinks stay QSFP+ cages');
{
  const wrong = [];
  for (let n = 49; n <= 54; n++) {
    const p = sw.interfaces.get('1/1/' + n);
    if (!p || p.cage !== 'qsfp+') wrong.push('1/1/' + n + '=' + (p && p.cage));
  }
  ok(wrong.length === 0, '1/1/49-54 are QSFP+' + (wrong.length ? ' (' + wrong.join(', ') + ')' : ''));
  const up = sw.interfaces.get('1/1/49');
  ok(up.hardware.media.indexOf('40gbase-sr4') !== -1 && up.hardware.media.indexOf('dac-40g') !== -1,
    'offering 40GBASE-SR4 optics and a 40G DAC',
    JSON.stringify(up.hardware.media));
  ok(up.hardware.maxSpeedMbps === 40000, 'at 40G, its native rate', String(up.hardware.maxSpeedMbps));
}

section('What a patch lead may do');
{
  // An empty SFP+ cage refuses an RJ45 peer, even a 10G one: a bare socket is not the module. The
  // copper variant of this family is a different SKU (JL581A, "48p 1G/10GBASE-T"), which is what
  // rules out reading these downlinks as 10GBASE-T.
  const host = new Topology();
  const copperSpec = catalog.filter(function (s) { return s.vendor === 'asus' && s.model === 'RT-AX89X'; })[0];
  const switchDev = host.addDevice(spec, 'SW');
  const copperBox = copperSpec ? host.addDevice(copperSpec, 'COPPER10G') : null;
  if (copperBox) {
    const v = media.canMate(switchDev.interfaces.get('1/1/1').hardware,
      copperBox.interfaces.get('10g-rj45').hardware);
    ok(v.ok === false, 'a 10GBASE-T RJ45 host cannot plug into an empty SFP+ downlink',
      v.code + ': ' + v.message);
  }

  // ...and two of its own cages meet over a fibre optic at 10G.
  const pair = media.canMate(switchDev.interfaces.get('1/1/1').hardware,
    switchDev.interfaces.get('1/1/2').hardware, { mediaId: '10gbase-sr' });
  ok(pair.ok === true, 'two downlinks meet over a 10GBASE-SR optic', pair.code + ': ' + pair.message);
  ok(pair.speedMbps === 10000, 'at 10G', String(pair.speedMbps));

  // The uplinks meet over a 40G DAC, which is how an 8320 is normally cabled to its spine.
  const spine = media.canMate(switchDev.interfaces.get('1/1/49').hardware,
    switchDev.interfaces.get('1/1/54').hardware, { mediaId: 'dac-40g' });
  ok(spine.ok === true, 'two QSFP+ uplinks meet over a 40G DAC', spine.code + ': ' + spine.message);
  ok(spine.speedMbps === 40000, 'at 40G', String(spine.speedMbps));

  // The copper SFP case, which is how an RJ45 appliance reaches this switch without an optic. The
  // module is named on the cable, because an empty cage offers it as one of the things it might hold
  // rather than as the thing it holds (test/copper-sfp-bridge.test.js).
  const pcSpec = catalog.filter(function (s) { return s.vendor === 'generic' && s.model === 'generic-pc'; })[0];
  const pc = host.addDevice(pcSpec, 'PC');
  let copperLink = null;
  try { copperLink = host.connect(switchDev.id, '1/1/1', pc.id, 'eth0', { mediaId: '1000base-t-sfp' }); }
  catch (e) { ok(false, 'a copper SFP in the cage does take an RJ45 host', e.message); }
  if (copperLink) {
    ok(copperLink.mediaId === '1000base-t-sfp', 'a copper SFP in the cage does take an RJ45 host',
      copperLink.mediaId);
    ok(copperLink.speedMbps === 1000, 'at the module rate of 1G', String(copperLink.speedMbps));
  }
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
