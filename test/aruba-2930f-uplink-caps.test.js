'use strict';
// The Aruba 2930F "4SFP+" SKUs carry four identical 10G SFP+ uplinks, and an SFP+ cage
// takes a 1G SFP module as well as a 10G one. Three of the specs said otherwise: the first
// uplink in the group declared speedCaps [1000, 10000] while its siblings declared [10000],
// so modules 2-4 refused a 1G peer with E_NO_COMMON_SPEED while module 1 accepted it. The
// faceplate drew four identical cages; the picker offered four different answers.
//
// #994 fixed the low rate on each spec's first uplink only (49/25/9), which is how the rest
// of the group kept the defect through a green suite. Issue #1066 names the JL256A and this
// test holds all three SFP+ 2930F specs to the same claim: every cage, both rates, no
// sibling singled out.
//
// The datasheet's uplink group is "4 SFP+ 1/10GbE ports" for JL253A/JL256A/JL258A, and the
// 2930F Switch Series data sheet lists 1G SFP transceivers alongside 10G SFP+ ones for
// those ports (DS_2930FSwitchSeries.pdf, which is already the specs' own sourceUrl). The
// 1G-only SKUs (JL260A/JL261A/JL262A/JL557A) are the SFP rows and are asserted to stay 1G.
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
function byModel(model) {
  return catalog.filter(function (s) { return s.vendor === 'aruba' && s.model === model; })[0];
}

const SFP_PLUS_SKUS = [
  { model: '2930F 24G 4SFP+', label: 'JL253A', uplinks: ['25', '26', '27', '28'] },
  { model: '2930F 48G PoE+ 4SFP+', label: 'JL256A', uplinks: ['49', '50', '51', '52'] },
  { model: '2930F 8G PoE+ 2SFP+', label: 'JL258A', uplinks: ['9', '10'] }
];
const ONE_G_PEER = '2930F 24G PoE+ 4SFP (JL261A)';

section('The SFP+ 2930F specs still describe themselves as SFP+ at 10G');
{
  const missing = SFP_PLUS_SKUS.filter(function (s) { return !byModel(s.model); }).map(function (s) { return s.model; });
  ok(missing.length === 0, 'every SFP+ 2930F model is in the catalogue' +
    (missing.length ? ' (' + missing.join(', ') + ')' : ''));
  const mislabelled = SFP_PLUS_SKUS.filter(function (s) {
    const spec = byModel(s.model);
    return !spec || !/SFP\+/.test(spec.description) || !/10G/.test(spec.description);
  }).map(function (s) { return s.model; });
  ok(mislabelled.length === 0, 'and describes its uplinks as SFP+ at 10G, which is the claim under test' +
    (mislabelled.length ? ' (' + mislabelled.join(', ') + ')' : ''));
}

section('Every uplink in a group is the same cage at the same two rates');
for (const sku of SFP_PLUS_SKUS) {
  const spec = byModel(sku.model);
  if (!spec) continue;
  const t = new Topology();
  const sw = t.addDevice(spec, 'SW');

  const wrongCage = [], wrongCaps = [], noOneG = [], noTenG = [];
  for (const name of sku.uplinks) {
    const p = sw.interfaces.get(name);
    if (!p || p.cage !== 'sfp+' || p.hardware.family !== 'optical') {
      wrongCage.push(name + '=' + (p && p.cage));
      continue;
    }
    if (p.hardware.maxSpeedMbps !== 10000) wrongCage.push(name + ' top ' + p.hardware.maxSpeedMbps + ' Mbps');
    const caps = p.hardware.speedCaps || [];
    if (caps.indexOf(1000) === -1 || caps.indexOf(10000) === -1) wrongCaps.push(name + '=' + JSON.stringify(caps));
    const offered = p.hardware.media || [];
    if (offered.indexOf('1000base-sx') === -1) noOneG.push(name);
    if (offered.indexOf('10gbase-sr') === -1) noTenG.push(name);
  }
  ok(wrongCage.length === 0, sku.label + ': all ' + sku.uplinks.length + ' uplinks are 10G optical SFP+ cages' +
    (wrongCage.length ? ' (' + wrongCage.join(', ') + ')' : ''));
  ok(wrongCaps.length === 0, sku.label + ': each declares both 1G and 10G, not just the top rate' +
    (wrongCaps.length ? ' (' + wrongCaps.join(', ') + ')' : ''));
  ok(noOneG.length === 0 && noTenG.length === 0,
    sku.label + ': each offers a 1G and a 10G optic' +
    (noOneG.length ? ' (no 1G: ' + noOneG.join(', ') + ')' : '') +
    (noTenG.length ? ' (no 10G: ' + noTenG.join(', ') + ')' : ''));
}

section('A 1G SFP peer plugs into any uplink, not just the first');
{
  const peerSpec = byModel(ONE_G_PEER);
  ok(!!peerSpec, 'the catalogue has a 1G SFP peer to cable against (JL261A)');
  if (peerSpec) {
    for (const sku of SFP_PLUS_SKUS) {
      const spec = byModel(sku.model);
      if (!spec) continue;
      const t = new Topology();
      const sw = t.addDevice(spec, 'SW');
      const peer = t.addDevice(peerSpec, 'PEER');
      const peerPort = peer.interfaces.get('25');
      const refused = [], slow = [], wrongRate = [];
      for (const name of sku.uplinks) {
        const p = sw.interfaces.get(name);
        const v = media.canMate(p.hardware, peerPort.hardware, { mediaId: '1000base-sx' });
        if (!v.ok) { refused.push(name + '=' + v.code); continue; }
        if (v.speedMbps !== 1000) wrongRate.push(name + '=' + v.speedMbps);
        const pair = media.canMate(p.hardware, sw.interfaces.get(sku.uplinks[0]).hardware, { mediaId: '10gbase-sr' });
        if (!pair.ok || pair.speedMbps !== 10000) slow.push(name + '=' + (pair.ok ? pair.speedMbps : pair.code));
      }
      ok(refused.length === 0, sku.label + ': a 1000BASE-SX link into every uplink is accepted' +
        (refused.length ? ' (' + refused.join(', ') + ')' : ''));
      ok(wrongRate.length === 0, sku.label + ': and each such link reports 1G' +
        (wrongRate.length ? ' (' + wrongRate.join(', ') + ')' : ''));
      ok(slow.length === 0, sku.label + ': each uplink still meets its siblings at 10G' +
        (slow.length ? ' (' + slow.join(', ') + ')' : ''));
    }
  }
}

section('The 1G-only SFP SKUs are left alone');
{
  // JL260A/JL261A/JL262A/JL557A are the SFP rows: the fix must not turn every Aruba 2930F
  // uplink into a 10G cage, so each of their uplinks still declares a 1G SFP socket.
  const oneGOnly = [
    '2930F 24G PoE+ 4SFP (JL261A)',
    '2930F 48G PoE+ 4SFP (JL262A)',
    '2930F 48G PoE+ 4SFP 740W (JL557A)'
  ];
  const wrong = [];
  for (const model of oneGOnly) {
    const spec = byModel(model);
    if (!spec) { wrong.push(model + ' missing'); continue; }
    const t = new Topology();
    const sw = t.addDevice(spec, 'SW');
    for (const p of sw.interfaces.values()) {
      if (p.hardware.cage === 'sfp+') wrong.push(model + '/' + p.name + ' became SFP+');
      else if (p.hardware.cage === 'sfp' && (p.hardware.maxSpeedMbps !== 1000 ||
        (p.hardware.speedCaps || []).indexOf(10000) !== -1)) {
        wrong.push(model + '/' + p.name + '=' + JSON.stringify(p.hardware.speedCaps));
      }
    }
  }
  ok(wrong.length === 0, 'the SFP-only 2930F rows still declare 1G SFP cages' +
    (wrong.length ? ' (' + wrong.slice(0, 3).join(', ') + ')' : ''));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
