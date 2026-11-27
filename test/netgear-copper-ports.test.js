'use strict';
// The Netgear multi-gig copper ports are RJ-45 jacks, and their ladder stops at 100 Mb/s (#1398).
//
// GS110EMX, GS728TPv3 and MS510TXM generated their access ports from a portTemplate that named only
// a rate -- type ethernet, speed 1G/2.5G, no connector, no speedCaps -- so inferCage() chose the
// cage and CAGE_SPEEDS.rj45 supplied the ladder. For a copper box the cage guess is right, which is
// to say nothing in the spec could disagree with it (#1398's whole point). The ladder was not right:
// it is the cage's full range, so the two GS110EMX 10G/Multi-Gig uplinks (100M/1G/2.5G/5G/10G) and
// the four MS510TXM 2.5G ports (100M/1G/2.5G) were handed 10BASE-T as well, and a 10BASE-T-only peer
// cabled into them came up at 10 Mb/s on hardware that cannot train below 100.
//
// So the tests below are of two kinds: the declaration (the spec now says the jack and the ladder),
// and the two links the old inference allowed and the hardware does not.
const fs = require('fs');
const path = require('path');
const { Topology, Simulator } = require('../engine');
const media = require('../engine/media');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  OK ' + msg); }
  else { failed++; console.error('  FAIL ' + msg + (detail ? '  [' + detail + ']' : '')); }
}
function section(name) { console.log('\n' + name); }

const catalog = loadCatalog(path.join(__dirname, '..', 'devices')).filter(function (s) { return !s.error; });
function spec(model) {
  const s = catalog.filter(function (x) { return x.vendor === 'netgear' && x.model === model; })[0];
  if (!s) throw new Error('missing spec ' + model);
  return s;
}

// model -> access count, access ladder, uplink cage, uplink ladder
const ROWS = {
  'GS110EMX': { access: 8, caps: [10, 100, 1000], uplinkCage: 'rj45', uplinkCaps: [100, 1000, 2500, 5000, 10000] },
  'GS728TPv3': { access: 24, caps: [10, 100, 1000], uplinkCage: 'sfp', uplinkCaps: [1000] },
  'MS510TXM': { access: 4, caps: [100, 1000, 2500], uplinkCage: 'rj45', uplinkCaps: [100, 1000, 2500, 5000, 10000] }
};

function portOf(model, name) {
  const t = new Topology();
  const d = t.addDevice(spec(model), 'D');
  return d.interfaces.get(name);
}

function peer(caps) {
  return media.derivePortHardware({ name: 'eth0', connector: 'rj45', speed: (caps[caps.length - 1] / 1000) + 'G',
    speedCaps: caps }, { model: 'PEER' });
}

section('The template declares the jack and the ladder, not just a rate');
for (const model of Object.keys(ROWS)) {
  const row = ROWS[model];
  const tpl = spec(model).portTemplate || {};
  ok(tpl.connector === 'rj45', model + ': portTemplate declares connector rj45', 'connector=' + String(tpl.connector));
  ok(JSON.stringify(tpl.speedCaps) === JSON.stringify(row.caps),
    model + ': portTemplate declares speedCaps ' + JSON.stringify(row.caps), JSON.stringify(tpl.speedCaps));
  ok(tpl.count === row.access, model + ': template still generates ' + row.access + ' ports', 'count=' + tpl.count);
}

section('The explicit multi-gig ports declare their cage too');
{
  // These were the worst of the silent class: a bare speed: 10G lets inferCage() decide between
  // copper and optics on a rate it treats as ambiguous. Both boxes are copper at 10G.
  for (const name of ['port9', 'port10']) {
    const raw = spec('GS110EMX').interfaces.filter(function (i) { return i.name === name; })[0];
    ok(raw && raw.connector === 'rj45', 'GS110EMX/' + name + ': declares rj45', raw && String(raw.connector));
    ok(raw && JSON.stringify(raw.speedCaps) === JSON.stringify([100, 1000, 2500, 5000, 10000]),
      'GS110EMX/' + name + ': declares 100M/1G/2.5G/5G/10G', raw && JSON.stringify(raw.speedCaps));
  }
  for (const name of ['port5', 'port6', 'port7', 'port8']) {
    const raw = spec('MS510TXM').interfaces.filter(function (i) { return i.name === name; })[0];
    ok(raw && raw.connector === 'rj45', 'MS510TXM/' + name + ': declares rj45', raw && String(raw.connector));
    ok(raw && JSON.stringify(raw.speedCaps) === JSON.stringify([100, 1000, 2500, 5000, 10000]),
      'MS510TXM/' + name + ': declares 100M/1G/2.5G/5G/10G', raw && JSON.stringify(raw.speedCaps));
  }
}

section('And the ports the template expands to carry it');
for (const model of Object.keys(ROWS)) {
  const row = ROWS[model];
  const bad = [];
  for (let n = 1; n <= row.access; n++) {
    const p = portOf(model, 'port' + n);
    const caps = (p && p.hardware && p.hardware.speedCaps) || [];
    if (!p || p.cage !== 'rj45' || JSON.stringify(caps) !== JSON.stringify(row.caps)) {
      bad.push('port' + n + '=' + (p ? p.cage : 'missing') + JSON.stringify(caps));
    }
  }
  ok(bad.length === 0, model + ': all ' + row.access + ' access ports are RJ-45 ' + JSON.stringify(row.caps) +
    (bad.length ? ' (' + bad.slice(0, 4).join(', ') + ')' : ''));
}

section('A 10G copper port is copper in the engine, not an inferred optical cage');
{
  const p = portOf('GS110EMX', 'port9');
  ok(p.cage === 'rj45', 'GS110EMX/port9 resolves to an RJ-45 cage', p.cage);
  ok((p.hardware.media || []).indexOf('10gbase-t') !== -1, 'and offers 10GBASE-T', JSON.stringify(p.hardware.media));
  ok((p.hardware.media || []).indexOf('10gbase-sr') === -1, 'and does not offer fibre',
    JSON.stringify(p.hardware.media));
  const m = portOf('MS510TXM', 'port5');
  ok(m.cage === 'rj45' && (m.hardware.media || []).indexOf('5gbase-t') !== -1,
    'MS510TXM/port5 is RJ-45 at 5GBASE-T', m.cage + ' ' + JSON.stringify(m.hardware.media));
}

section('The ladder the inference invented is now refused: no 10BASE-T on a multi-gig port');
{
  // Before this change port9 caps were [10,100,1000,2500,5000,10000] and this link came up at 10.
  const ten = peer([10]);
  const v = media.canMate(portOf('GS110EMX', 'port9').hardware, ten);
  ok(v.ok === false && v.code === 'E_NO_COMMON_SPEED',
    'a 10BASE-T-only peer cannot cable GS110EMX/port9', v.code + ': ' + v.message);
  const v2 = media.canMate(portOf('MS510TXM', 'port1').hardware, ten);
  ok(v2.ok === false && v2.code === 'E_NO_COMMON_SPEED',
    'nor MS510TXM/port1 (100M/1G/2.5G)', v2.code + ': ' + v2.message);
  const ok100 = media.canMate(portOf('MS510TXM', 'port1').hardware, peer([100, 1000]));
  ok(ok100.ok === true && ok100.speedMbps === 1000, 'but a 100/1000 peer still meets it, at the highest common rate',
    String(ok100.speedMbps));
}

section('Cabling: the multi-gig rates still come up, and fibre still does not go in');
{
  const t = new Topology();
  const a = t.addDevice(spec('GS110EMX'), 'A');
  const b = t.addDevice(spec('MS510TXM'), 'B');
  const l10 = t.connect(a.id, 'port9', b.id, 'port5');
  ok(!!l10 && l10.speedMbps === 10000, 'GS110EMX/port9 <-> MS510TXM/port5 runs at 10G', l10 && String(l10.speedMbps));
  const t2 = new Topology();
  const a2 = t2.addDevice(spec('GS110EMX'), 'A');
  const b2 = t2.addDevice(spec('MS510TXM'), 'B');
  const l25 = t2.connect(a2.id, 'port9', b2.id, 'port1');
  ok(!!l25 && l25.speedMbps === 2500, 'GS110EMX/port9 <-> MS510TXM/port1 runs at 2.5G', l25 && String(l25.speedMbps));
  const t3 = new Topology();
  const a3 = t3.addDevice(spec('GS110EMX'), 'A');
  const b3 = t3.addDevice(spec('MS510TXM'), 'B');
  let refused = null;
  try { t3.connect(a3.id, 'port10', b3.id, 'sfp+1'); } catch (e) { refused = e; }
  ok(!!refused && /incompatible connectors/.test(refused.message),
    'a fibre uplink cannot be pushed into a copper uplink', refused ? refused.message : 'link came up');
}

section('PoE is untouched: GS728TPv3 still powers what it powers');
{
  const sw = new Topology().addDevice(spec('GS728TPv3'), 'SW');
  ok(sw.poeBudget === 190, 'the chassis still declares its 190 W budget', String(sw.poeBudget));
  const dead = [];
  for (let n = 1; n <= 24; n++) {
    const p = sw.interfaces.get('port' + n);
    if (!p || !(p.hardware && p.hardware.poeOut > 0)) dead.push('port' + n);
  }
  ok(dead.length === 0, 'all 24 copper jacks still declare a PoE budget', dead.join(','));
  const t = new Topology();
  const s2 = t.addDevice(spec('GS728TPv3'), 'SW');
  const pdSpec = catalog.filter(function (x) { return x.vendor === 'mikrotik' && x.model === 'RBSXTsqG-5acD'; })[0];
  const pd = t.addDevice(pdSpec, 'PD');
  const cord = t.connect(pd.id, 'eth1', s2.id, 'port1');
  ok(!!cord, 'a PoE powered device cables into port1');
  const poe = new Simulator(t).computePoe()[0] || { ports: [] };
  const p = (poe.ports || []).filter(function (x) { return x.iface === 'port1'; })[0];
  ok(!!p && p.powered === true, 'port1 powers the device', JSON.stringify(p));
  ok(pd.poeUnpowered === false, 'and the device is not marked unpowered');
}

section('No other Netgear template is left guessing -- one documented exception');
{
  // GS748T's own description claims two of its SFP slots are combo/shared with RJ45 ports 47-48.
  // If that holds, those two cages are combo, not rj45, and declaring rj45 would refuse a
  // transceiver. The cage has to be settled from a datasheet row first, so it is counted here
  // rather than skipped: a new Netgear spec cannot join it silently.
  const EXCEPTIONS = { 'GS748T': 'combo-or-copper on ports 47-48 is unconfirmed (research/netgear-copper-ports.md)' };
  const dir = path.join(__dirname, '..', 'devices', 'netgear');
  const guessing = [];
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.json')) continue;
    const raw = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    if (!raw.portTemplate) continue;
    if (EXCEPTIONS[raw.model]) continue;
    if (!raw.portTemplate.connector || !Array.isArray(raw.portTemplate.speedCaps) || !raw.portTemplate.speedCaps.length) {
      guessing.push(raw.model);
    }
  }
  ok(guessing.length === 0, 'every Netgear portTemplate declares a connector and a ladder', guessing.join(','));
  ok(Object.keys(EXCEPTIONS).length === 1, 'and exactly one spec is held back, for a stated reason',
    Object.keys(EXCEPTIONS).join(','));
  const held = spec('GS748T').portTemplate;
  ok(!!held && !held.connector, 'GS748T is still the undeclared one, not silently declared', JSON.stringify(held));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
