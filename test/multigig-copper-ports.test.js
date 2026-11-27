'use strict';
// The multi-gig copper jacks on the small-office batch are RJ-45, and their ladder starts at 100 (#1398).
//
// Trendnet TEG-S380, Zyxel XGS1250-12 and QNAP QSW-M2108-2C all present 2.5G/5G/10G over twisted pair.
// Each spec's description already spells out the rate set its copper ports run --
//
//   TEG-S380    "8x 100M/1G/2.5G RJ45"                       (the 100M is the floor, not a 10M one)
//   XGS1250-12  "3x 100M/1G/2.5G/5G/10G RJ45"
//   QSW-M2108   "2x 10GbE SFP+/RJ45 combo ... 10G/5G/2.5G/1G/100M on copper"
//
// -- but the ports themselves declared only a rate. inferCage() then chose the cage and
// CAGE_SPEEDS.rj45 supplied the ladder, so every one of those jacks was handed 10BASE-T: a
// 10BASE-T-only peer cabled into TEG-S380/port1 came up at 10 Mb/s on a jack that cannot train
// below 100. This is the same failure #1628 fixed on the Netgear multi-gig copper ports; the cage
// was right and the ladder was the inference talking.
//
// The tests below pin the declaration, then the two links it changes: 10BASE-T is refused, and the
// 100M/1G/2.5G/5G/10G rungs still come up. 1G access jacks keep 10BASE-T -- they do train at 10.
const path = require('path');
const { Topology } = require('../engine');
const media = require('../engine/media');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  OK ' + msg); }
  else { failed++; console.error('  FAIL ' + msg + (detail ? '  [' + detail + ']' : '')); }
}
function section(name) { console.log('\n' + name); }

const catalog = loadCatalog(path.join(__dirname, '..', 'devices')).filter(function (s) { return !s.error; });
function spec(vendor, model) {
  const s = catalog.filter(function (x) { return x.vendor === vendor && x.model === model; })[0];
  if (!s) throw new Error('missing spec ' + vendor + '/' + model);
  return s;
}
function portOf(vendor, model, name) {
  const t = new Topology();
  const d = t.addDevice(spec(vendor, model), 'D');
  const p = d.interfaces.get(name);
  if (!p) throw new Error('missing port ' + model + '/' + name);
  return p;
}
function peer(caps, cage) {
  return media.derivePortHardware({ name: 'eth0', connector: cage || 'rj45',
    speed: (caps[caps.length - 1] / 1000) + 'G', speedCaps: caps }, { model: 'PEER' });
}
function mate(vendor, model, name, caps) {
  return media.canMate(portOf(vendor, model, name).hardware, peer(caps));
}

// spec -> the ladder its multi-gig copper jack has to state
const MULTIGIG = [
  { vendor: 'trendnet', model: 'TEG-S380', prefix: 'port', count: 8, caps: [100, 1000, 2500] },
  { vendor: 'zyxel', model: 'XGS1250-12', prefix: 'port', start: 9, count: 3, caps: [100, 1000, 2500, 5000, 10000] },
  { vendor: 'qnap', model: 'QSW-M2108-2C', names: ['9', '10'], caps: [100, 1000, 2500, 5000, 10000] }
];

section('The templates state the jack and the ladder, not just a rate');
{
  const tpl = function (v, m) { return spec(v, m).portTemplate || {}; };
  ok(tpl('trendnet', 'TEG-S380').connector === 'rj45', 'TEG-S380: portTemplate declares connector rj45',
    String(tpl('trendnet', 'TEG-S380').connector));
  ok(JSON.stringify(tpl('trendnet', 'TEG-S380').speedCaps) === JSON.stringify([100, 1000, 2500]),
    'TEG-S380: portTemplate declares 100M/1G/2.5G', JSON.stringify(tpl('trendnet', 'TEG-S380').speedCaps));
  ok(tpl('qnap', 'QSW-M2108-2C').connector === 'rj45', 'QSW-M2108-2C: portTemplate declares connector rj45',
    String(tpl('qnap', 'QSW-M2108-2C').connector));
  ok(JSON.stringify(tpl('qnap', 'QSW-M2108-2C').speedCaps) === JSON.stringify([100, 1000, 2500]),
    'QSW-M2108-2C: portTemplate declares 100M/1G/2.5G', JSON.stringify(tpl('qnap', 'QSW-M2108-2C').speedCaps));
  ok(tpl('zyxel', 'XGS1250-12').connector === 'rj45', 'XGS1250-12: the 1G template declares connector rj45',
    String(tpl('zyxel', 'XGS1250-12').connector));
  ok(JSON.stringify(tpl('zyxel', 'XGS1250-12').speedCaps) === JSON.stringify([10, 100, 1000]),
    'XGS1250-12: and 10M/100M/1G for the eight 1G jacks', JSON.stringify(tpl('zyxel', 'XGS1250-12').speedCaps));
}

function namesOf(row) {
  if (row.names) return row.names.slice();
  const out = [];
  for (let n = 0; n < row.count; n++) out.push(row.prefix + (row.start ? row.start + n : n + 1));
  return out;
}

section('The explicit multi-gig ports declare their cage too');
for (const row of MULTIGIG) {
  if (row.prefix && !row.names) continue;   // template-generated rows are checked below
  for (const name of namesOf(row)) {
    const raw = (spec(row.vendor, row.model).interfaces || []).filter(function (i) { return i.name === name; })[0];
    ok(raw && raw.connector === 'rj45', row.model + '/' + name + ': declares rj45', raw && String(raw.connector));
    ok(raw && JSON.stringify(raw.speedCaps) === JSON.stringify(row.caps),
      row.model + '/' + name + ': declares ' + row.caps.join('/'), raw && JSON.stringify(raw.speedCaps));
  }
}

section('And the generated ports carry the template declaration');
for (const row of MULTIGIG) {
  if (row.names) continue;
  const bad = [];
  for (const name of namesOf(row)) {
    const p = portOf(row.vendor, row.model, name);
    const caps = (p.hardware && p.hardware.speedCaps) || [];
    if (p.cage !== 'rj45' || JSON.stringify(caps) !== JSON.stringify(row.caps)) {
      bad.push(name + '=' + p.cage + JSON.stringify(caps));
    }
  }
  ok(bad.length === 0, row.model + ': all ' + row.count + ' multi-gig jacks are RJ-45 ' +
    JSON.stringify(row.caps) + (bad.length ? ' (' + bad.slice(0, 3).join(', ') + ')' : ''));
}

section('The ladder the inference invented is now refused: no 10BASE-T on a multi-gig jack');
for (const row of MULTIGIG) {
  for (const name of namesOf(row)) {
    const v = mate(row.vendor, row.model, name, [10]);
    ok(v.ok === false && v.code === 'E_NO_COMMON_SPEED',
      'a 10BASE-T-only peer cannot cable ' + row.model + '/' + name, v.code + ': ' + v.message);
  }
}

section('The rates the hardware does run still come up, at the highest common one');
{
  const v100 = mate('trendnet', 'TEG-S380', 'port1', [100]);
  ok(v100.ok === true && v100.speedMbps === 100, 'TEG-S380/port1 meets a 100BASE-TX peer at 100M',
    String(v100.speedMbps));
  const v25 = mate('trendnet', 'TEG-S380', 'port1', [100, 1000, 2500]);
  ok(v25.ok === true && v25.speedMbps === 2500, 'and a 2.5G one at 2.5G', String(v25.speedMbps));
  const v5 = mate('zyxel', 'XGS1250-12', 'port9', [100, 1000, 5000]);
  ok(v5.ok === true && v5.speedMbps === 5000, 'XGS1250-12/port9 meets a 5G peer at 5G', String(v5.speedMbps));
  const v10 = mate('zyxel', 'XGS1250-12', 'port10', [1000, 10000]);
  ok(v10.ok === true && v10.speedMbps === 10000, 'and a 10G peer at 10G', String(v10.speedMbps));
  const v10q = mate('qnap', 'QSW-M2108-2C', '9', [10000]);
  ok(v10q.ok === true && v10q.speedMbps === 10000, 'QSW-M2108-2C/9 (copper side of the combo) meets 10G at 10G',
    String(v10q.speedMbps));
}

section('The 1G jacks are not over-corrected: they still train at 10');
{
  const v = mate('zyxel', 'XGS1250-12', 'port1', [10]);
  ok(v.ok === true && v.speedMbps === 10, 'XGS1250-12/port1 (1G RJ45) still takes a 10BASE-T peer at 10M',
    v.code ? v.code + ': ' + v.message : String(v.speedMbps));
}

section('Cabling: copper meets copper, and fibre still cannot go in');
{
  const t = new Topology();
  const a = t.addDevice(spec('zyxel', 'XGS1250-12'), 'A');
  const b = t.addDevice(spec('qnap', 'QSW-M2108-2C'), 'B');
  const l = t.connect(a.id, 'port9', b.id, '9');
  ok(!!l && l.speedMbps === 10000, 'XGS1250-12/port9 <-> QSW-M2108-2C/9 runs at 10G', l && String(l.speedMbps));

  const t2 = new Topology();
  const a2 = t2.addDevice(spec('trendnet', 'TEG-S380'), 'A');
  const b2 = t2.addDevice(spec('zyxel', 'XGS1250-12'), 'B');
  const l2 = t2.connect(a2.id, 'port1', b2.id, 'port1');
  ok(!!l2 && l2.speedMbps === 1000, 'TEG-S380/port1 <-> XGS1250-12/port1 runs at 1G', l2 && String(l2.speedMbps));

  const lc = media.derivePortHardware({ name: 'eth0', connector: 'lc', speedCaps: [10000] }, { model: 'SFP' });
  const v = media.canMate(portOf('trendnet', 'TEG-S380', 'port1').hardware, lc);
  ok(v.ok === false && /incompatible connectors/.test(String(v.message)),
    'an LC fibre lead cannot be pushed into TEG-S380/port1', v.code + ': ' + v.message);

  const t3 = new Topology();
  const a3 = t3.addDevice(spec('qnap', 'QSW-M2108-2C'), 'A');
  const b3 = t3.addDevice(spec('qnap', 'QSW-M2108-2C'), 'B');
  const ls = t3.connect(a3.id, '9-sfp', b3.id, '10-sfp');
  ok(!!ls && ls.speedMbps === 10000, 'the SFP+ side of the combo still takes a 10G fibre link',
    ls && String(ls.speedMbps));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
