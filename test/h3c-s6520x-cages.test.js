'use strict';
// The H3C S6520X-30QC-EI's 24 downlinks are SFP+ cages, not RJ45 sockets.
//
// The catalogue row described the box correctly - "24x 1G/10G SFP+ ports + 2x 40GE QSFP+" - and declared
// no connector on the template, so `derivePortHardware()` fell back to its copper default: all 24
// downlinks became RJ45 sockets carrying 10GBASE-T (and, from the copper ladder, 2.5G and 5G, rates an
// SFP+ cage cannot run at all). `scripts/audit-port-types.js` listed the spec under "these specs say
// SFP/QSFP and never say RJ45/copper/10GBASE-T, their template declares no connector ... so the fibre
// ports are modelled as copper sockets".
//
// H3C's own hardware specification for the model counts the ports by cage family:
//
//   | QSFP+ port | 2  |      <- S6520X-30QC-EI / -30QC-HI column
//   | SFP+ port  | 24 |
//   - "01-Hardware Information and Specifications", H3C S6520X-E series
//     https://www.h3c.com/en/Support/Resource_Center/EN/Home/Public/00-Public/Technical_Documents/
//     Product_Literature/Hardware_Information___Specifications/H3C_S6520X_E-11670/202512/2727552_294551_0.htm
//
// and the family datasheet gives the rate ladder on those cages as 1/10G:
//
//   "H3C S6520X-30QC-EI-provides 24 x 1/10G SFP+ ports, 2 x QSFP+ ports (40GE, can be split into four
//    10GE ports.), 2 x expansion slots ..."
//   - H3C S6520X-EI Series Datasheet, https://h3c.store/download/H3C_S6520X-EI_Datasheet.pdf
//
// The 1G half of that ladder is why this test expects a 1000BASE-SX optic to train at 1G as well as a
// 10GBASE-SR one at 10G: a cage that only offered 10G would be a different (and wrong) row.
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
const spec = catalog.filter(function (s) { return s.vendor === 'h3c' && s.model === 'S6520X-30QC-EI'; })[0];
ok(!!spec, 'the catalogue has the H3C S6520X-30QC-EI');
ok(!!spec && /SFP\+/.test(spec.description) && /QSFP\+/.test(spec.description),
  'and it describes itself as SFP+ downlinks and QSFP+ uplinks, which is the claim under test');
ok(!!spec && spec.portTemplate && spec.portTemplate.connector === 'sfp+',
  'the port template names the SFP+ cage rather than leaving the media to the copper default');

const t = new Topology();
const sw = t.addDevice(spec, 'AGG');

section('The 24 downlinks are SFP+ cages');
{
  const copper = [];
  const noOptic = [];
  const oddRate = [];
  for (let n = 1; n <= 24; n++) {
    const p = sw.interfaces.get('Ten-GigabitEthernet1/0/' + n);
    if (!p || p.cage !== 'sfp+') copper.push('1/0/' + n + '=' + (p && p.cage));
    const offered = (p && p.hardware.media) || [];
    if (offered.indexOf('10gbase-sr') === -1 || offered.indexOf('1000base-sx') === -1) {
      noOptic.push('1/0/' + n);
    }
    // 2.5G and 5G were what the copper fallback offered; no SFP+ cage runs them.
    const caps = (p && p.hardware.speedCaps) || [];
    if (caps.length !== 2 || caps.indexOf(1000) === -1 || caps.indexOf(10000) === -1) {
      oddRate.push('1/0/' + n + '=' + JSON.stringify(caps));
    }
  }
  ok(copper.length === 0, 'none of the 24 downlinks is an RJ45 socket' +
    (copper.length ? ' (' + copper.slice(0, 3).join(', ') + ')' : ''));
  ok(noOptic.length === 0, 'each one offers a 10G and a 1G optic' +
    (noOptic.length ? ' (' + noOptic.slice(0, 3).join(', ') + ')' : ''));
  ok(oddRate.length === 0, 'and trains at 1G or 10G, the two rates the datasheet names for this cage' +
    (oddRate.length ? ' (' + oddRate.slice(0, 3).join(', ') + ')' : ''));
  const p1 = sw.interfaces.get('Ten-GigabitEthernet1/0/1');
  ok(p1.hardware.family === 'optical', 'the port reports an optical cage, not copper', p1.hardware.family);
  ok(p1.hardware.media.indexOf('1000base-t-sfp') !== -1,
    'a copper SFP (1GBASE-T module) is still a medium the cage can hold');
}

section('The two uplinks stay QSFP+ cages');
{
  const wrong = [];
  for (let n = 25; n <= 26; n++) {
    const p = sw.interfaces.get('FortyGigE1/0/' + n);
    if (!p || p.cage !== 'qsfp+') wrong.push('1/0/' + n + '=' + (p && p.cage));
  }
  ok(wrong.length === 0, 'FortyGigE1/0/25-26 are QSFP+' + (wrong.length ? ' (' + wrong.join(', ') + ')' : ''));
  const up = sw.interfaces.get('FortyGigE1/0/25');
  ok(up.hardware.media.indexOf('40gbase-sr4') !== -1 && up.hardware.media.indexOf('dac-40g') !== -1,
    'offering 40GBASE-SR4 optics and a 40G DAC', JSON.stringify(up.hardware.media));
  ok(up.hardware.maxSpeedMbps === 40000, 'at 40G, its native rate', String(up.hardware.maxSpeedMbps));
}

section('What a patch lead may do');
{
  // A bare cage is not a copper socket: the 10GBASE-T RJ45 host is a different physical thing, and the
  // cage has to refuse it unless a copper SFP is named on the cable.
  const host = new Topology();
  const switchDev = host.addDevice(spec, 'AGG');
  const copperSpec = catalog.filter(function (s) { return s.vendor === 'asus' && s.model === 'RT-AX89X'; })[0];
  if (copperSpec) {
    const copperBox = host.addDevice(copperSpec, 'COPPER10G');
    const v = media.canMate(switchDev.interfaces.get('Ten-GigabitEthernet1/0/1').hardware,
      copperBox.interfaces.get('10g-rj45').hardware);
    ok(v.ok === false, 'a 10GBASE-T RJ45 host cannot plug into an empty SFP+ downlink',
      v.code + ': ' + v.message);
  }

  const ten = media.canMate(switchDev.interfaces.get('Ten-GigabitEthernet1/0/1').hardware,
    switchDev.interfaces.get('Ten-GigabitEthernet1/0/2').hardware, { mediaId: '10gbase-sr' });
  ok(ten.ok === true, 'two downlinks meet over a 10GBASE-SR optic', ten.code + ': ' + ten.message);
  ok(ten.speedMbps === 10000, 'at 10G', String(ten.speedMbps));

  // The 1G half of "1/10G": a 1000BASE-SX module in this cage reaches a plain 1G SFP port at 1G.
  // (A pair of these cages would negotiate 10G and pick a 10G module, which is the engine's
  // port-rate rule for everything but a single-strand BX run - see docs/CONNECTORS.md 4.4.)
  const oneGSpec = catalog.filter(function (s) {
    return s.vendor === 'advantech' && s.model === 'EKI-7708G-4FI';
  })[0];
  if (oneGSpec) {
    const oneGSw = host.addDevice(oneGSpec, 'SFP1G');
    const one = media.canMate(switchDev.interfaces.get('Ten-GigabitEthernet1/0/1').hardware,
      oneGSw.interfaces.get('sfp1').hardware, { mediaId: '1000base-sx' });
    ok(one.ok === true, 'the cage meets a 1G SFP port over a 1000BASE-SX optic', one.code + ': ' + one.message);
    ok(one.speedMbps === 1000, 'at 1G', String(one.speedMbps));
  }

  const spine = media.canMate(switchDev.interfaces.get('FortyGigE1/0/25').hardware,
    switchDev.interfaces.get('FortyGigE1/0/26').hardware, { mediaId: 'dac-40g' });
  ok(spine.ok === true, 'two QSFP+ uplinks meet over a 40G DAC', spine.code + ': ' + spine.message);
  ok(spine.speedMbps === 40000, 'at 40G', String(spine.speedMbps));

  const pcSpec = catalog.filter(function (s) { return s.vendor === 'generic' && s.model === 'generic-pc'; })[0];
  const pc = pcSpec ? host.addDevice(pcSpec, 'PC') : null;
  if (pc) {
    let copperLink = null;
    try {
      copperLink = host.connect(switchDev.id, 'Ten-GigabitEthernet1/0/3', pc.id, 'eth0',
        { mediaId: '1000base-t-sfp' });
    } catch (e) { ok(false, 'a copper SFP in the cage does take an RJ45 host', e.message); }
    if (copperLink) {
      ok(copperLink.mediaId === '1000base-t-sfp', 'a copper SFP in the cage does take an RJ45 host',
        copperLink.mediaId);
      ok(copperLink.speedMbps === 1000, 'at the module rate of 1G', String(copperLink.speedMbps));
    }
  }
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
