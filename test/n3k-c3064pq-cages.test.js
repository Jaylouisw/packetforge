'use strict';
// The Nexus 3064PQ's 48 downlinks are SFP+ cages, not RJ45 sockets.
//
// The catalogue row described the box correctly - "48x 1/10G SFP+ downlinks plus 4x 40G QSFP+
// uplinks" - and then declared no connector on either group, so `derivePortHardware()` fell back to
// its copper default: all 52 ports became RJ45 sockets. `scripts/audit-port-types.js` reported it
// under "Template ports at 10G+ presented as RJ45 copper on a box that describes itself as SFP",
// and the practical effect was a 10G leaf switch you could patch with a Cat6 lead and into which no
// optic would fit.
//
// Cisco's data sheet for the family states both groups as cages:
//
//   "Cisco Nexus 3064-X (N3K-C3064PQ-10GX): This 10-Gbps Enhanced Small Form-Factor Pluggable
//    (SFP+)-based top-of-rack switch has 48 SFP+ ports and 4 Quad SFP+ (QSFP+) ports. Each SFP+
//    port can operate in 100-Mbps, 1-Gbps, or 10-Gbps mode, and each QSFP+ port can operate in
//    native 40-Gbps or 4 x 10-Gbps mode."
//   - Cisco Nexus 3064-X, 3064-T, and 3064-32T Switches Data Sheet
//     http://www.cisco.com/en/US/prod/collateral/switches/ps9441/ps11541/data_sheet_c78-651097.pdf
//
//   Ordering information, same page: N3K-C3064PQ-10GX "48 SFP+ and 4 QSFP+ ports";
//   N3K-C3064TQ-10GT "48 10GBase-T and 4 QSFP+ ports" - the copper variant is a different SKU,
//   which is what rules out reading the downlinks as 10GBASE-T.
//
// The 100-Mbps mode the data sheet names is not declared as a speedCap: the catalogue carries no
// 100BASE SFP and `CAGE_MEDIA['sfp+']` offers none, so the cage's own 1G/10G ladder is the honest
// answer. The four QSFP+ cages are declared at native 40G only - the 4 x 10G breakout is a mode
// this model does not build, and declaring 10G without a 10G module in a QSFP+ cage would offer a
// rate nothing in the catalogue can fill.
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
const spec = catalog.filter(function (s) { return s.vendor === 'cisco' && s.model === 'N3K-C3064PQ-10GE'; })[0];
ok(!!spec, 'the catalogue has the Cisco N3K-C3064PQ-10GE');
ok(!!spec && /SFP\+/.test(spec.description) && /QSFP\+/.test(spec.description),
  'and it describes itself as SFP+ downlinks and QSFP+ uplinks, which is the claim under test');

const t = new Topology();
const sw = t.addDevice(spec, 'LEAF');

section('The 48 downlinks are SFP+ cages');
{
  const copper = [];
  const noOptic = [];
  for (let n = 1; n <= 48; n++) {
    const p = sw.interfaces.get('Eth1/' + n);
    if (!p || p.cage !== 'sfp+') copper.push('Eth1/' + n + '=' + (p && p.cage));
    // An SFP+ cage has to be able to hold a 10G optic and a 1G one, or "SFP+" is only a label.
    const offered = (p && p.hardware.media) || [];
    if (offered.indexOf('10gbase-sr') === -1 || offered.indexOf('1000base-sx') === -1) {
      noOptic.push('Eth1/' + n);
    }
  }
  ok(copper.length === 0, 'none of the 48 downlinks is an RJ45 socket' +
    (copper.length ? ' (' + copper.slice(0, 3).join(', ') + ')' : ''));
  ok(noOptic.length === 0, 'each one offers a 10G and a 1G optic' +
    (noOptic.length ? ' (' + noOptic.slice(0, 3).join(', ') + ')' : ''));
  const eth1 = sw.interfaces.get('Eth1/1');
  ok(eth1.hardware.speedCaps.indexOf(1000) !== -1 && eth1.hardware.speedCaps.indexOf(10000) !== -1,
    'and trains at 1G or 10G, the two rates the data sheet names for this cage',
    JSON.stringify(eth1.hardware.speedCaps));
  ok(eth1.hardware.media.indexOf('1000base-t-sfp') !== -1,
    'a copper SFP (GLC-T) is still a medium the cage can hold');
}

section('The four uplinks are QSFP+ cages');
{
  const wrong = [];
  for (let n = 49; n <= 52; n++) {
    const p = sw.interfaces.get('Eth1/' + n);
    if (!p || p.cage !== 'qsfp+') wrong.push('Eth1/' + n + '=' + (p && p.cage));
  }
  ok(wrong.length === 0, 'Eth1/49-52 are QSFP+' + (wrong.length ? ' (' + wrong.join(', ') + ')' : ''));
  const up = sw.interfaces.get('Eth1/49');
  ok(up.hardware.media.indexOf('40gbase-sr4') !== -1 && up.hardware.media.indexOf('dac-40g') !== -1,
    'offering 40GBASE-SR4 optics and a 40G DAC',
    JSON.stringify(up.hardware.media));
  ok(up.hardware.maxSpeedMbps === 40000, 'at 40G, its native rate', String(up.hardware.maxSpeedMbps));
}

section('What a patch lead may do');
{
  // An empty SFP+ cage refuses an RJ45 peer: the cage is a module slot, and a bare socket is not
  // the module. (A copper SFP is checked separately below.)
  const host = new Topology();
  const pcSpec = catalog.filter(function (s) { return s.vendor === 'generic' && s.model === 'generic-pc'; })[0];
  const pc = host.addDevice(pcSpec, 'PC');
  const switchDev = host.addDevice(spec, 'SW');
  const v = media.canMate(switchDev.interfaces.get('Eth1/1').hardware, pc.interfaces.get('eth0').hardware);
  ok(v.ok === false, 'an RJ45 host cannot plug into an empty SFP+ downlink',
    v.code + ': ' + v.message);

  // ...and two of its own cages meet over a fibre optic at 10G.
  const pair = media.canMate(switchDev.interfaces.get('Eth1/1').hardware,
    switchDev.interfaces.get('Eth1/2').hardware, { mediaId: '10gbase-sr' });
  ok(pair.ok === true, 'two downlinks meet over a 10GBASE-SR optic', pair.code + ': ' + pair.message);
  ok(pair.speedMbps === 10000, 'at 10G', String(pair.speedMbps));

  // The uplinks meet over a 40G DAC, which is how a 3064PQ is normally cabled to its spine.
  const spine = media.canMate(switchDev.interfaces.get('Eth1/49').hardware,
    switchDev.interfaces.get('Eth1/52').hardware, { mediaId: 'dac-40g' });
  ok(spine.ok === true, 'two QSFP+ uplinks meet over a 40G DAC', spine.code + ': ' + spine.message);
  ok(spine.speedMbps === 40000, 'at 40G', String(spine.speedMbps));

  // The copper SFP case, which is the one way an RJ45 appliance reaches this switch. The module is
  // named on the cable (`mediaId`), because an empty cage offers it as one of the things it might
  // hold rather than as the thing it holds (test/copper-sfp-bridge.test.js).
  let copperLink = null;
  try { copperLink = host.connect(switchDev.id, 'Eth1/1', pc.id, 'eth0', { mediaId: '1000base-t-sfp' }); }
  catch (e) { ok(false, 'a copper SFP in the cage does take an RJ45 host', e.message); }
  if (copperLink) {
    ok(copperLink.mediaId === '1000base-t-sfp', 'a copper SFP in the cage does take an RJ45 host',
      copperLink.mediaId);
    ok(copperLink.speedMbps === 1000, 'at the module rate of 1G', String(copperLink.speedMbps));
  }
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
