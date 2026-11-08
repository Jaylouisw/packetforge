'use strict';
// ===========================================================================
// test/sfp28-legacy.test.js -- does an SFP28 cage take a 1G SFP module? (issue #17)
//
// The question the issue asks is a field question, not a standards question:
// 25G ports are routinely used to hand a 1G SFP uplink to an access switch, and
// engineers expect that to work. It does, and every vendor that ships 25G ports
// says so in its own documentation:
//
//   Cisco Nexus 93180YC-FX hardware installation guide: "This switch has 48
//   10/25-Gigabit SFP+ downlink ports that support 1-Gigabit, 10-Gigabit, and
//   25-Gigabit Ethernet connections ... You can set the downlink port speeds on
//   a port-by-port basis."
//
//   Arista 7050X3 Q&A: "The 25G SFP ports accommodate a wide range of 25G, 10GbE
//   and 1GbE SFP transceivers and cables ... The pluggable transceiver used for
//   25GbE is an SFP28 and is the same size as both the 1GbE SFP and 10GbE SFP+."
//
//   Juniper QFX5120: "48 25GbE, 10GbE, or 1GbE SFP28 ports" and "The SFP28 ports
//   can operate at 25-Gbps, 10-Gbps, or 1-Gbps."
//
// The reason is mechanical, not commercial: SFP28 is SFF-8402, which kept the
// SFP+ cage from SFF-8432. TE's zSFP+ 28 Gb/s datasheet puts it plainly --
// "Backwards-compatibility: Shares same mating interface and cage dimensions
// with the SFP+ connector" -- so a 1G SFP and a 10G SFP+ both seat in an SFP28
// slot and simply run at their own rate.
//
// What the engine got wrong was narrower than the question sounds. The cage
// already advertised the 1G optics; it just claimed no 1G *rate*, so a 1G SFP
// plugged into an SFP28 port shared a medium with the peer and then failed
// negotiation. A port that offers 1000BASE-SX but refuses to run at 1000 is a
// contradiction, and it is the one this file pins shut.
//
// What the model still does NOT do, deliberately, is autonegotiate down: a real
// 25G port has to be *set* to 1G, and on several platforms the setting is per
// group of four ports (Arista: "The set of 4 ports in each group have a single
// port speed setting - 1/10G or 25G"; Juniper: "The SFP28 ports are grouped in
// quads"). That is a configuration constraint on hardware we do not model port
// by port, so it is documented in media.js rather than enforced here.
// ===========================================================================

const path = require('path');
const media = require('../engine/media');
const { Topology } = require('../engine');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg); }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));

function hw(spec) { return media.derivePortHardware(spec, { vendor: 'probe', model: 'probe' }); }

// A cage-level answer, independent of any one device.
const sfp1g = hw({ name: 'p1', type: 'ethernet', connector: 'sfp', speed: '1G' });
const sfp10g = hw({ name: 'p2', type: 'ethernet', connector: 'sfp+', speed: '10G' });
const sfp25g = hw({ name: 'p3', type: 'ethernet', connector: 'sfp28', speed: '25G' });

console.log('The cage takes all three generations of module:');
{
  const optics = media.CAGE_MEDIA.sfp28(25000);
  ok(optics.some(function (m) { return /^25gbase/.test(m); }), '25G SFP28 optics are offered');
  ok(optics.some(function (m) { return /^10gbase/.test(m); }),
    '10G SFP+ optics are offered, because an SFP+ module fits the same cage');
  ok(optics.some(function (m) { return /^1000base/.test(m); }),
    'and 1G SFP optics are offered too (' +
    optics.filter(function (m) { return /^1000base/.test(m); }).join(', ') + ')');

  const caps = media.CAGE_SPEEDS.sfp28(25000);
  ok(caps.indexOf(1000) !== -1, 'a 25G SFP28 port can run at 1G (' + caps.join(',') + ')');
  ok(caps.indexOf(10000) !== -1, 'and at 10G');
  ok(caps.indexOf(25000) !== -1, 'and at 25G');
  ok(caps.indexOf(100) === -1,
    'but not 100M: no vendor lists 100BASE-FX/T among the speeds of a 25G SFP28 port');

  // A port's own declared rate still bounds what the cage offers it.
  ok(media.CAGE_SPEEDS.sfp28(10000).indexOf(25000) === -1,
    'a 10G SFP28 port is not credited with a 25G rate it does not have');
  ok(media.CAGE_SPEEDS.sfp28(10000).indexOf(1000) !== -1, 'and keeps 1G');
}

console.log('\nA 1G SFP plugged into an SFP28 cage runs at the module rate, not the cage rate:');
{
  const v = media.canMate(sfp1g, sfp25g);
  ok(v.ok === true, 'the pair is accepted (was E_NO_COMMON_SPEED before issue #17)');
  ok(v.speedMbps === 1000,
    'and the link runs at 1000 Mbps, the module rate, not 25000 (' + v.speedMbps + ')');
  ok(Array.isArray(v.media) && v.media.length > 0 && v.media.every(function (m) {
    const def = media.MEDIA[m];
    return def && def.speedMbps <= 1000;
  }), 'over a 1G medium (' + (v.media || []).join(', ') + ')');
  ok((v.media || []).indexOf('25gbase-sr') === -1, 'never over a 25G optic the module cannot drive');
  ok(media.cagesMate('sfp28', 'sfp') === true, 'the cages themselves mate');
}

console.log('\nA 10G SFP+ in an SFP28 cage works at 10G:');
{
  const v = media.canMate(sfp10g, sfp25g);
  ok(v.ok === true, 'the pair is accepted');
  ok(v.speedMbps === 10000, 'at 10000 Mbps, the SFP+ rate (' + v.speedMbps + ')');
  ok((v.media || []).some(function (m) { return /^10gbase/.test(m); }),
    'over a 10G optic (' + (v.media || []).filter(function (m) { return /^10gbase/.test(m); }).join(', ') + ')');
  ok(media.CAGE_MEDIA.sfp28(25000).indexOf('10gbase-er') !== -1,
    'and the whole SFP+ optic class fits, not just SR/LR (10GBASE-ER included)');
}

console.log('\nThe rate never runs away upward:');
{
  const top = media.canMate(sfp25g, hw({ name: 'p4', connector: 'sfp28', speed: '25G' }));
  ok(top.ok && top.speedMbps === 25000, 'two 25G ports still meet at 25G (' + top.speedMbps + ')');

  const v = media.canMate(sfp1g, sfp25g);
  const cap = Math.min(sfp1g.maxSpeedMbps, sfp25g.maxSpeedMbps);
  ok(v.speedMbps <= cap, 'and never above the lower port maximum (' + v.speedMbps + ' <= ' + cap + ')');
  const m = media.MEDIA[v.media && v.media.length ? media.preferredMedia(v.media) : ''];
  ok(!!m && v.speedMbps <= m.speedMbps,
    'nor above what the chosen medium carries (' + v.speedMbps + ' <= ' + (m && m.speedMbps) + ')');
}

console.log('\nEnd to end, with real catalogue parts:');
{
  const oneG = catalog.find(function (s) { return s.model === 'ASR 1001-X'; });
  const twentyFive = catalog.find(function (s) { return s.model === '7280R3-48YC8'; });
  ok(!!oneG, 'a 1G SFP device is in the catalogue (Cisco ASR 1001-X)');
  ok(!!twentyFive, 'and a 25G SFP28 switch (Arista 7280R3-48YC8)');

  if (oneG && twentyFive) {
    const t = new Topology();
    const a = t.addDevice(JSON.parse(JSON.stringify(oneG)));
    const b = t.addDevice(JSON.parse(JSON.stringify(twentyFive)));
    const pa = [...a.interfaces.values()].find(function (i) { return i.hardware.cage === 'sfp'; });
    const pb = [...b.interfaces.values()].find(function (i) { return i.hardware.cage === 'sfp28'; });
    ok(!!pa && !!pb, 'both present an SFP-family cage (' +
      (pa && pa.name) + ' / ' + (pb && pb.name) + ')');

    const v = t.validateLink(a.id, pa.name, b.id, pb.name, {});
    ok(v.ok === true, 'a 1G SFP port cables to a 25G SFP28 port' +
      (v.ok ? '' : ' (' + v.errors.map(function (e) { return e.code; }).join(',') + ')'));
    if (v.ok) {
      const link = t.connect(a.id, pa.name, b.id, pb.name);
      ok(link.speedMbps === 1000, 'and the link comes up at 1G (' + link.speedMbps + ')');
      ok(/^1000base|^dac-1g/.test(String(link.mediaId)),
        'carried by a 1G module medium (' + link.mediaId + ')');
    }
  }
}

console.log('\nA port that declares its own speeds still wins over the cage default:');
{
  // The Brocade G610's SFP28 ports are 8/16/32G Fibre Channel: the same physical
  // cage, none of the Ethernet rates. The engine default must not hand them 1G
  // just because the cage can carry it.
  const g610 = catalog.find(function (s) { return s.model === 'G610'; });
  ok(!!g610, 'the Brocade G610 (32G FC, SFP28 cages) is in the catalogue');
  const asr = catalog.find(function (s) { return s.model === 'ASR1001-X'; });
  if (g610 && asr) {
    const t = new Topology();
    const fc = t.addDevice(JSON.parse(JSON.stringify(g610)));
    const eth = t.addDevice(JSON.parse(JSON.stringify(asr)));
    const pfc = [...fc.interfaces.values()].find(function (i) { return i.hardware.cage === 'sfp28'; });
    const peth = [...eth.interfaces.values()].find(function (i) { return i.hardware.cage === 'sfp'; });
    ok(pfc.hardware.speedCaps.indexOf(1000) === -1,
      'its ports keep their declared FC rates (' + pfc.hardware.speedCaps.join(',') + ')');
    const v = t.validateLink(eth.id, peth.name, fc.id, pfc.name, {});
    ok(v.ok === false, 'so a 1G SFP is still refused there');
    ok(v.errors.some(function (e) { return e.code === 'E_NO_COMMON_SPEED'; }),
      'for want of a shared rate, not a shared connector (' +
      v.errors.map(function (e) { return e.code; }).join(',') + ')');
  }

  // Same rule for a 25G Ethernet port that cannot do 1G: Aruba's transceiver guide
  // is explicit that "the particular switch model or module may be limited in
  // supporting lower speeds", and the 8325P/9300 do not do 1G in an SFP28 cage at
  // all. The cage default must never overrule a port that states its own rates.
  const locked = media.derivePortHardware({
    name: 'p9', connector: 'sfp28', speed: '25G', hardware: { speedCaps: [25000] }
  }, { vendor: 'probe', model: 'probe' });
  ok(locked.speedCaps.indexOf(1000) === -1,
    'a port pinned to 25G only is not given 1G by the cage default (' + locked.speedCaps.join(',') + ')');
  const v2 = media.canMate(sfp1g, locked);
  ok(v2.ok === false && v2.code === 'E_NO_COMMON_SPEED',
    'and a 1G SFP is refused there (' + v2.code + ')');
}

console.log('\nAnd the impossible cases are still impossible:');
{
  const rj = hw({ name: 'c1', connector: 'rj45', speed: '1G' });
  const v = media.canMate(sfp25g, rj);
  ok(v.ok === false, 'an RJ45 plug does not go into an SFP28 cage');
  ok(v.code === 'E_CONNECTOR_MISMATCH', 'with a connector verdict (' + v.code + ')');

  const v2 = media.canMate(sfp25g, hw({ name: 'c2', connector: 'qsfp+', speed: '40G' }));
  ok(v2.ok === false && v2.code === 'E_CONNECTOR_MISMATCH', 'nor does a QSFP+ module (' + v2.code + ')');

  // 100BASE-FX is an SFP, not a 25G-port SFP. Refused, and it says which.
  const fx = hw({ name: 'c3', connector: 'sfp', speed: '100M' });
  const v3 = media.canMate(fx, sfp25g);
  ok(v3.ok === false, 'a 100M SFP is refused by an SFP28 cage');
  ok(typeof v3.code === 'string' && v3.code.length > 0, 'with a code (' + v3.code + ')');
  ok(typeof v3.message === 'string' && v3.message.length > 0, 'and a message the GUI can show');
}

console.log('\nThe cable matrix still sees one SFP family:');
{
  ok(media.cagesMate('sfp28', 'sfp28'), 'SFP28 meets SFP28');
  ok(media.cagesMate('sfp28', 'sfp+'), 'SFP28 takes SFP+');
  ok(media.cagesMate('sfp28', 'combo'), 'and a combo position');
  ok(!media.cagesMate('sfp28', 'qsfp28'), 'but never a QSFP28 module');
  ok(!media.cagesMate('sfp28', 'lc-upc'), 'nor a bare LC patch lead');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
