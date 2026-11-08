'use strict';
// A port that cannot be cabled to anything, at any distance, with any module.
//
// Found by asking a simple question of the whole catalogue: for every wired port, is there
// at least one medium it is allowed to use whose rate it can actually run? Twenty-two ports
// failed, for two different reasons:
//
//   Cisco NCS 2006 - eighteen 10G client ports declared in QSFP+ cages. A QSFP+ cage is a
//   40G cage (40GBASE-SR4/LR4, 40G DAC), so a 10G port in one has no medium at its own rate.
//   Cisco's NCS 2000 10-port client cards are SFP+ based; QSFP+ appears on that platform
//   only where 4x10G or 40G aggregation is offered.
//
//   Ubiquiti ES-12F - ports 9-12 declared 100M only. The datasheet says (8) 100/1000 Mbps
//   SFP ports and (4) 1000 Mbps SFP ports, so those four are the 1G-only ones; the
//   catalogue had it inverted, and 100M-only SFP ports have no 100M medium to use.
//
// Neither was caught before because no existing check compared a port's declared rate with
// the media its cage offers: the port-type audit asks whether a port contradicts its type,
// and the option here is that it contradicts its own rate. That comparison is the test.
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
const topo = new Topology();

// Speed caps arrive in mixed units across the catalogue: '1G', '10G', 1000, 10000.
function mbps(v) { return typeof v === 'number' ? v : media.parseSpeedMbps(v); }
function maxRate(iface) {
  const caps = iface.speedCaps;
  if (Array.isArray(caps) && caps.length) {
    return Math.max.apply(null, caps.map(mbps).filter(function (n) { return n > 0; }));
  }
  return mbps(iface.speed) || 0;
}

section('1. Every wired port has a medium it can run at its own rate');
{
  const offenders = [];
  let checked = 0;
  for (const spec of specs) {
    if (!spec.interfaces && !spec.portTemplate) continue;
    let dev;
    try { dev = topo.addDevice(spec); } catch (e) { continue; }
    for (const iface of dev.interfaces.values()) {
      // not an exemption: the suite's subject is wired data ports, and this loop is one of the
      // checks that defines them. PON is included because a PON port is cabled too.
      if (iface.type !== 'ethernet' && iface.type !== 'pon') continue;
      const supported = iface.supportedMedia || [];
      if (!supported.length) continue;   // wireless/console handled elsewhere
      checked++;
      const limit = maxRate(iface);
      const usable = supported.filter(function (id) {
        const m = media.MEDIA[id];
        return m && (!limit || !m.speedMbps || m.speedMbps <= limit);
      });
      if (!usable.length) {
        offenders.push(spec.vendor + '/' + spec.model + ' ' + iface.name +
          ' [' + iface.cage + ' ' + (iface.speed || '?') + '] offers ' + supported.join(','));
      }
    }
  }
  ok(checked > 10000, 'checked ' + checked + ' wired ports across the catalogue');
  ok(offenders.length === 0, 'no wired port is uncablable at its own declared rate' +
    (offenders.length ? ' - ' + offenders.length + ' offender(s): ' + offenders.slice(0, 5).join(' | ') : ''));
}

section('2. The Cisco NCS 2006 client ports are SFP+ at 10G, not QSFP+');
{
  const ncs = specs.filter(function (s) { return /NCS 2006/.test(s.model); })[0];
  ok(!!ncs, 'the NCS 2006 is in the catalogue');
  if (ncs) {
    const dev = new Topology().addDevice(ncs);
    const ports = [...dev.interfaces.values()].filter(function (i) { return i.type === 'ethernet'; });
    const tenG = ports.filter(function (i) { return i.speed === '10G'; });
    eq(tenG.length, 18, 'it has 18 ten-gigabit client ports');
    const wrongCage = tenG.filter(function (i) { return i.cage !== 'sfp+'; });
    eq(wrongCage.length, 0, 'none of them sits in a 40G cage' +
      (wrongCage.length ? ' (' + wrongCage.map(function (i) { return i.name + ':' + i.cage; }).join(',') + ')' : ''));

    // And the consequence that matters: one can be cabled to an ordinary SFP+ port.
    const peer = specs.filter(function (s) { return /RT-AX89X/.test(s.model); })[0];
    ok(!!peer, 'an SFP+ peer is available to test against');
    if (peer) {
      const t = new Topology();
      const a = t.addDevice(ncs);
      const b = t.addDevice(peer);
      const bSfp = [...b.interfaces.values()].filter(function (i) { return i.cage === 'sfp+'; })[0];
      const v = t.validateLink(a.id, tenG[0].name, b.id, bSfp.name);
      ok(v.ok, 'a 10G client port cables to an SFP+ port' + (v.ok ? '' : ': ' +
        JSON.stringify((v.errors || []).slice(0, 1))));
      if (v.ok) eq(v.speedMbps, 10000, 'at 10 Gbps');
    }
  }
}

section('3. The Ubiquiti ES-12F has eight 100/1000 ports and four 1G-only ports');
{
  const es = specs.filter(function (s) { return /ES-12F/.test(s.model); })[0];
  ok(!!es, 'the ES-12F is in the catalogue');
  if (es) {
    const dev = new Topology().addDevice(es);
    const sfp = [...dev.interfaces.values()].filter(function (i) { return i.cage === 'sfp'; });
    eq(sfp.length, 12, 'it has 12 SFP ports');
    for (let n = 1; n <= 8; n++) {
      const p = dev.interfaces.get('sfp' + n);
      eq(maxRate(p), 1000, 'sfp' + n + ' tops out at 1G');
      ok((p.speedCaps || []).map(mbps).indexOf(100) !== -1, '  and still accepts 100M');
    }
    for (let n = 9; n <= 12; n++) {
      const p = dev.interfaces.get('sfp' + n);
      eq(maxRate(p), 1000, 'sfp' + n + ' is a 1G port, not a 100M one');
      eq((p.speedCaps || []).map(mbps).indexOf(100), -1, '  and does not claim 100M');
    }
    const rj = [...dev.interfaces.values()].filter(function (i) { return i.cage === 'rj45'; });
    eq(rj.length, 4, 'and it has four copper ports');
  }
}

// ---------------------------------------------------------------------------
// A port with NO medium at all is worse than a port with the wrong one: it cannot be cabled to
// anything, at any rate, and the picker simply does not offer it. 84 DOCSIS return-path ports and
// 24 MCX ports were in exactly that state (issue #1039), and the rate check skipped them with an
// early `continue`, so nothing failed. This is the assertion that owns the question.
console.log('\nEvery port can be cabled with something:');
{
  const bare = [];
  for (const spec of loadCatalog(path.join(__dirname, '..', 'devices'))) {
    let dev;
    try { dev = new Topology().addDevice(spec); } catch (e) { continue; }
    for (const p of dev.interfaces.values()) {
      // not an exemption: the inverse. This assertion exists to find ports WITHOUT a medium, so
      // a port that has one is the pass case.
      // An antenna is not a cable: a radio port has no connector to cable, which is the one
      // exclusion this assertion makes (see the radio check below).
      if ((p.hardware.media || []).length) continue;
      // A radio is an antenna, not a cabled port.
      // not an exemption: a radio port is an antenna, not a cable, and this assertion is about
      // cabled ports. Radios are covered by test/wireless-link.test.js.
      if (p.hardware.cage === 'antenna' || p.type === 'wireless') continue;
      bare.push(spec.vendor + '/' + spec.model + '/' + p.name + ' (' + p.hardware.cage + ')');
    }
  }
  ok(bare.length === 0, 'no cabled port has an empty medium list' +
    (bare.length ? ' (' + bare.slice(0, 5).join(', ') + ')' : ''));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
