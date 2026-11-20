'use strict';
// The Aruba CX 6300M 24SFP+ 4SFP56 (JL658A)'s 24 downlinks are SFP+ cages, not RJ45 sockets.
//
// The row described the box correctly - "24x 1/10G SFP+ fiber ports" - and declared no connector on the
// template, so `derivePortHardware()` fell back to its copper default: all 24 downlinks came out as RJ45
// sockets carrying 10GBASE-T, on a model whose own label says SFP+ and whose sibling 48-port rows are the
// copper ones. `scripts/audit-port-types.js` reported the spec under "Template ports at 10G+ presented as
// RJ45 copper on a box that describes itself as SFP". The practical effect: a fibre aggregation leaf that
// could be patched with a Cat6A lead and into which no SFP+ optic would fit - the exact inversion of what
// the box is for. This is the same defect `test/aruba-cx-8320-cages.test.js` fixed on the 8320.
//
// HPE's documentation states both port groups as transceiver slots, not copper ports:
//
//   "Aruba 6300M 24-port SFP+ and 4-port SFP56 Switch  JL658A
//    ... Min=0 \ Max= 24 SFP/SFP+ 100M/1/10G Transceivers
//    ... Min=0 \ Max = 4 SFP/SFP+/SFP28/SFP56 1/10/25/50G Transceiver"
//   - HPE Aruba Networking CX 6300 Switch Series QuickSpecs, a00073540enw (Configuration Information)
//
// and the model's own specification row reads "24x 1G/10G SFP+ ports / 4x 1/10/25/50G SFP ports":
//   - Aruba CX 6300 Switch Series Data Sheet (DS_6300Series.pdf), JL658A column
//
// A "max 24 transceivers" ordering rule is not a list of sockets: nobody counts RJ45 ports in
// transceivers. research/aruba-cx-6300m-24sfp-cages.md carries the sources and the half left open (the
// 100M optic the QuickSpecs also lists, and the 50G rate the uplinks' hardware has but this cage does not).
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
const spec = catalog.filter(function (s) { return s.vendor === 'aruba' && s.model === 'CX 6300M 24SFP+ 4SFP56'; })[0];
ok(!!spec, 'the catalogue has the Aruba CX 6300M 24SFP+ 4SFP56');
ok(!!spec && /SFP\+/.test(spec.description) && /SFP56/.test(spec.description),
  'and it describes itself as SFP+ downlinks and SFP56 uplinks, which is the claim under test');

const t = new Topology();
const sw = t.addDevice(spec, 'LEAF');

section('The 24 downlinks are SFP+ cages');
{
  const wrongCage = [];
  const noOptic = [];
  const wrongCaps = [];
  for (let n = 1; n <= 24; n++) {
    const p = sw.interfaces.get('1/1/' + n);
    if (!p || p.cage !== 'sfp+') wrongCage.push('1/1/' + n + '=' + (p && p.cage));
    const offered = (p && p.hardware.media) || [];
    // An SFP+ cage has to hold a 10G optic and a 1G one, or "SFP+" is only a label.
    if (offered.indexOf('10gbase-sr') === -1 || offered.indexOf('1000base-sx') === -1) noOptic.push('1/1/' + n);
    const caps = (p && p.hardware.speedCaps) || [];
    if (!(caps.indexOf(1000) !== -1 && caps.indexOf(10000) !== -1)) wrongCaps.push('1/1/' + n);
  }
  ok(wrongCage.length === 0, 'none of the 24 downlinks is an RJ45 socket' +
    (wrongCage.length ? ' (' + wrongCage.slice(0, 3).join(', ') + ')' : ''));
  ok(noOptic.length === 0, 'each one offers a 10G and a 1G optic' +
    (noOptic.length ? ' (' + noOptic.slice(0, 3).join(', ') + ')' : ''));
  ok(wrongCaps.length === 0, 'and trains at 1G and 10G, the two rates the data sheet names for the group' +
    (wrongCaps.length ? ' (' + wrongCaps.slice(0, 3).join(', ') + ')' : ''));
  const p1 = sw.interfaces.get('1/1/1');
  ok(p1.hardware.family === 'optical', 'the port reports an optical cage, not copper', p1.hardware.family);
  ok(p1.hardware.maxSpeedMbps === 10000, 'with 10G as its top rate', String(p1.hardware.maxSpeedMbps));
  ok(p1.hardware.media.indexOf('1000base-t-sfp') !== -1,
    'a copper SFP (1GBASE-T module) is still a medium the cage can hold');
}

section('Nothing on the panel is a copper socket');
{
  // The 6300M family splits by SKU: 24SFP+ (JL658A) is the fibre one; the 1GbE and Smart Rate rows beside
  // it in the catalogue are the ones with RJ45 access ports. A copper port here would be a different box.
  const copper = [];
  for (const p of sw.interfaces.values()) {
    if (p.hardware && p.hardware.family === 'copper') copper.push(p.name + '=' + p.cage);
  }
  ok(copper.length === 0, 'no port on the box reports a copper cage' +
    (copper.length ? ' (' + copper.slice(0, 3).join(', ') + ')' : ''));
}

section('What a patch lead may do');
{
  // An empty SFP+ cage refuses an RJ45 peer, even a 10G one: a bare socket is not the module.
  const host = new Topology();
  const copperSpec = catalog.filter(function (s) { return s.vendor === 'asus' && s.model === 'RT-AX89X'; })[0];
  const leaf = host.addDevice(spec, 'LEAF');
  const copperBox = copperSpec ? host.addDevice(copperSpec, 'COPPER10G') : null;
  if (copperBox) {
    const v = media.canMate(leaf.interfaces.get('1/1/1').hardware,
      copperBox.interfaces.get('10g-rj45').hardware);
    ok(v.ok === false, 'a 10GBASE-T RJ45 host cannot plug into an empty SFP+ downlink',
      v.code + ': ' + v.message);
  }

  // ...and two of its own cages meet over a fibre optic at 10G, and over a 1G optic at 1G.
  const tenG = media.canMate(leaf.interfaces.get('1/1/1').hardware,
    leaf.interfaces.get('1/1/2').hardware, { mediaId: '10gbase-sr' });
  ok(tenG.ok === true, 'two downlinks meet over a 10GBASE-SR optic', tenG.code + ': ' + tenG.message);
  ok(tenG.speedMbps === 10000, 'at 10G', String(tenG.speedMbps));
  // A 1G optic is a medium the cage holds, which is the whole point of an SFP+ cage that also takes SFP.
  // What rate the *link* then reports is a separate question and is not asserted here: `negotiateSpeed()`
  // takes the highest shared port rate and ignores the optic named, so a 1000BASE-SX run between two 10G
  // cages currently reports 10G. That is a negotiation question, recorded as open in the research note,
  // not a cage question - pinning it here would make this test the place the defect is written down.
  const oneG = media.canMate(leaf.interfaces.get('1/1/1').hardware,
    leaf.interfaces.get('1/1/2').hardware, { mediaId: '1000base-sx' });
  ok(oneG.ok === true, 'and over a 1000BASE-SX optic', oneG.code + ': ' + oneG.message);

  // A 10G DAC, which is how this switch is cabled to a top-of-rack peer inside one rack.
  const dac = media.canMate(leaf.interfaces.get('1/1/1').hardware,
    leaf.interfaces.get('1/1/3').hardware, { mediaId: 'dac-10g' });
  ok(dac.ok === true, 'two downlinks meet over a 10G DAC', dac.code + ': ' + dac.message);
}

section('The four uplinks stay optical cages, and take a 10G SFP+ module');
{
  const wrong = [];
  for (let n = 25; n <= 28; n++) {
    const p = sw.interfaces.get('1/1/' + n);
    if (!p || !p.hardware || p.hardware.family !== 'optical') wrong.push('1/1/' + n);
  }
  ok(wrong.length === 0, '1/1/25-28 are optical cages' + (wrong.length ? ' (' + wrong.join(', ') + ')' : ''));
  const up = sw.interfaces.get('1/1/25');
  ok(up.hardware.maxSpeedMbps === 25000, 'with 25G as the top rate this cage models', String(up.hardware.maxSpeedMbps));
  // The data sheet's uplink group is "1/10/25/50G", and the QuickSpecs' transceiver rule names SFP+ as one
  // of the modules it holds - so a plain 10G SFP+ optic has to fit, whatever the top rate is.
  ok(up.hardware.media.indexOf('10gbase-sr') !== -1, 'and a 10G SFP+ optic is a medium it holds',
    JSON.stringify(up.hardware.media));
  ok(up.hardware.media.indexOf('25gbase-sr') !== -1, 'alongside the 25G one');
  const upPair = media.canMate(up.hardware, up.hardware, { mediaId: '25gbase-sr' });
  ok(upPair.ok === true && upPair.speedMbps === 25000, 'two uplinks meet over a 25GBASE-SR optic at 25G',
    upPair.code + ': ' + upPair.message);
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
