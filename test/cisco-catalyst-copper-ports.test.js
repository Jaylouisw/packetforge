'use strict';
// Six Cisco Catalyst specs generate their access ports from a portTemplate that said only
// `type: ethernet, speed: 1G` (or `100M`). No connector, no ladder: the engine inferred an RJ-45
// socket from the rate, which was right by luck and could never be contradicted (issue #1398).
//
// Cisco states both facts for every one of them:
//
//   2960 HIG, Table 1-1: "Catalyst 2960-24TT-L ... 24 10/100BASE-TX Ethernet ports and
//     2 10/100/1000BASE-T copper uplink ports (no SFP module slot)."
//   2960-X HIG, Table 1: "Catalyst 2960X-24TS-L ... 24 10/100/1000 ports and 4 SFP module slots";
//     "Catalyst 2960X-48FPS-L ... 48 10/100/1000 PoE+ ports (740 W) and 4 SFP module slots."
//   3560 HIG, Connector and Cable Specifications: "The 10/100 and 10/100/1000 Ethernet ports use
//     standard RJ-45 connectors and Ethernet pinouts with internal crossovers."
//   3560 HIG: "You can set the 10/100/1000 ports to operate at 10 or 100 Mb/s in half or full
//     duplex or at 1000 Mb/s in full duplex."
//   3750 data sheet: "WS-C3750G-24TS-S - 24 Ethernet 10/100/1000 ports - 4 SFP-based Gigabit
//     Ethernet ports".
//   3560-CX data sheet: "3560CX-8PC-S | 8 x 10/100/1000 Gigabit Ethernet | 8 PoE+ | 240W |
//     2 x 1G copper plus 2 x 1G SFP"; migration guide Table 4: "GE uplink - GigabitEthernet0/9".
//
// research/cisco-catalyst-copper-ports.md carries the sources and what is left open.
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
function spec(model) {
  const s = catalog.filter(function (x) { return x.vendor === 'cisco' && x.model === model; })[0];
  if (!s) throw new Error('missing spec ' + model);
  return s;
}
function dev(model) {
  const t = new Topology();
  return t.addDevice(spec(model), 'SW');
}

// [model, prefix, start, count] - the Gigabit copper rows.
const GIG = [
  ['C2960X-24TS-L', 'Gi1/0/', 1, 24],
  ['C2960X-48FPS-L', 'Gi1/0/', 1, 48],
  ['WS-C3560G-24TS-S', 'Gi0/', 1, 24],
  ['WS-C3750G-24TS-S', 'Gi1/0/', 1, 24],
  ['WS-C3560CX-8PC-S', 'Gi1/0/', 1, 8]
];

section('The template declares the jack and the ladder, not just a rate');
for (const row of GIG) {
  const model = row[0], tpl = spec(model).portTemplate || {};
  ok(tpl.connector === 'rj45', model + ': portTemplate declares connector rj45',
    'connector=' + String(tpl.connector));
  ok(JSON.stringify(tpl.speedCaps) === JSON.stringify([10, 100, 1000]),
    model + ': portTemplate declares speedCaps [10,100,1000]', JSON.stringify(tpl.speedCaps));
  ok(tpl.prefix === row[1] && tpl.start === row[2] && tpl.count === row[3],
    model + ': the template still generates ' + row[1] + row[2] + '-' + (row[2] + row[3] - 1),
    tpl.prefix + String(tpl.start) + ' x' + tpl.count);
}

section('And the ports it expands to carry that declaration');
for (const row of GIG) {
  const model = row[0], prefix = row[1], start = row[2], count = row[3];
  const sw = dev(model);
  const bad = [];
  for (let n = start; n < start + count; n++) {
    const p = sw.interfaces.get(prefix + n);
    if (!p) { bad.push(prefix + n + '=missing'); continue; }
    const caps = (p.hardware && p.hardware.speedCaps) || [];
    const offered = (p.hardware && p.hardware.media) || [];
    const wrong = p.cage !== 'rj45' || caps.indexOf(10) === -1 || caps.indexOf(100) === -1 ||
      caps.indexOf(1000) === -1 || caps.indexOf(2500) !== -1 ||
      offered.indexOf('10base-t') === -1 || offered.indexOf('100base-tx') === -1 ||
      offered.indexOf('1000base-t') === -1;
    if (wrong) bad.push(prefix + n + '=' + p.cage + JSON.stringify(caps));
  }
  ok(bad.length === 0, model + ': all ' + count + ' access ports are RJ-45 at 10/100/1000' +
    (bad.length ? ' (' + bad.slice(0, 4).join(', ') + ')' : ''));
}

section('Cabling: a cable meets an access port, an optic does not');
for (const row of GIG) {
  const model = row[0];
  const sw = dev(model);
  const a = sw.interfaces.get(row[1] + row[2]);
  const b = sw.interfaces.get(row[1] + (row[2] + row[3] - 1));
  const g = media.canMate(a.hardware, b.hardware, { mediaId: '1000base-t' });
  ok(g.ok === true && g.speedMbps === 1000, model + ': two access ports meet over 1000BASE-T at 1G',
    g.code + ': ' + g.message);
  const h = media.canMate(a.hardware, b.hardware, { mediaId: '100base-tx' });
  ok(h.ok === true, model + ': 100BASE-TX is not refused', h.code + ': ' + h.message);
  const c = media.canMate(a.hardware, b.hardware, { mediaId: '10base-t' });
  ok(c.ok === true, model + ': nor is 10BASE-T', c.code + ': ' + c.message);
  const offered = a.hardware.media || [];
  ok(offered.indexOf('1000base-sx') === -1 && offered.indexOf('1000base-lx') === -1,
    model + ': the cage offers copper media only, so no optic can be seated',
    JSON.stringify(offered));
}

section('The Fast Ethernet 2960 stops at 100');
{
  const tpl = spec('Catalyst2960').portTemplate || {};
  ok(tpl.connector === 'rj45' && JSON.stringify(tpl.speedCaps) === JSON.stringify([10, 100]),
    'Catalyst2960: template declares rj45 and [10,100]',
    String(tpl.connector) + ' ' + JSON.stringify(tpl.speedCaps));
  const sw = dev('Catalyst2960');
  const bad = [];
  for (let n = 1; n <= 24; n++) {
    const p = sw.interfaces.get('Fa0/' + n);
    const caps = (p && p.hardware && p.hardware.speedCaps) || [];
    if (!p || p.cage !== 'rj45' || caps.indexOf(1000) !== -1 || caps.indexOf(100) === -1) {
      bad.push('Fa0/' + n + '=' + (p && p.cage) + JSON.stringify(caps));
    }
  }
  ok(bad.length === 0, 'all 24 Fa0/1-24 are RJ-45 and train no higher than 100' +
    (bad.length ? ' (' + bad.slice(0, 4).join(', ') + ')' : ''));
  const a = sw.interfaces.get('Fa0/1'), b = sw.interfaces.get('Fa0/24');
  const tx = media.canMate(a.hardware, b.hardware, { mediaId: '100base-tx' });
  ok(tx.ok === true, 'a 100BASE-TX lead meets the port', tx.code + ': ' + tx.message);
  const gb = media.canMate(a.hardware, b.hardware, { mediaId: '1000base-t' });
  ok(gb.ok === true && gb.speedMbps === 100,
    'and a 1000BASE-T lead comes up at 100 Mb/s, because the port stops there',
    gb.code + ': ' + gb.speedMbps + ' Mb/s');
}

section('3560CX: Gi1/0/9-10 are the copper uplinks, 11-12 the SFP cages');
{
  const sw = dev('WS-C3560CX-8PC-S');
  const bad = [];
  for (const n of [9, 10]) {
    const p = sw.interfaces.get('Gi1/0/' + n);
    const caps = (p && p.hardware && p.hardware.speedCaps) || [];
    if (!p || p.cage !== 'rj45' || JSON.stringify(caps) !== JSON.stringify([10, 100, 1000])) {
      bad.push('Gi1/0/' + n + '=' + (p && p.cage) + JSON.stringify(caps));
    }
  }
  ok(bad.length === 0, 'Gi1/0/9-10 declare an RJ-45 cage at 10/100/1000' +
    (bad.length ? ' (' + bad.join(', ') + ')' : ''));
  const s = [];
  for (const n of [11, 12]) {
    const p = sw.interfaces.get('Gi1/0/' + n);
    const caps = (p && p.hardware && p.hardware.speedCaps) || [];
    if (!p || p.cage !== 'sfp' || JSON.stringify(caps) !== JSON.stringify([1000])) {
      s.push('Gi1/0/' + n + '=' + (p && p.cage) + JSON.stringify(caps));
    }
  }
  ok(s.length === 0, 'Gi1/0/11-12 are still 1G SFP cages' + (s.length ? ' (' + s.join(', ') + ')' : ''));
  const copper = media.canMate(sw.interfaces.get('Gi1/0/9').hardware,
    sw.interfaces.get('Gi1/0/10').hardware, { mediaId: '1000base-t' });
  ok(copper.ok === true && copper.speedMbps === 1000, 'the two copper uplinks meet at 1G',
    copper.code + ': ' + copper.message);
  const optic = media.canMate(sw.interfaces.get('Gi1/0/9').hardware,
    sw.interfaces.get('Gi1/0/11').hardware, { mediaId: '1000base-sx' });
  ok(optic.ok === false && optic.code === 'E_CONNECTOR_MISMATCH',
    'a 1000BASE-SX optic into the copper uplink is a connector mismatch',
    optic.code + ': ' + optic.message);
}

section('The 1G SFP uplinks those specs already declared are untouched');
{
  const rows = [
    ['C2960X-24TS-L', 'Gi1/0/25', 'Gi1/0/28'],
    ['C2960X-48FPS-L', 'Gi1/0/49', 'Gi1/0/52'],
    ['WS-C3560G-24TS-S', 'Gi0/25', 'Gi0/28'],
    ['WS-C3750G-24TS-S', 'Gi1/0/25', 'Gi1/0/28']
  ];
  for (const r of rows) {
    const sw = dev(r[0]);
    const first = sw.interfaces.get(r[1]), last = sw.interfaces.get(r[2]);
    const good = first && last && first.cage === 'sfp' && last.cage === 'sfp' &&
      JSON.stringify(first.hardware.speedCaps) === JSON.stringify([1000]);
    ok(good, r[0] + ': ' + r[1] + '-' + r[2].split('/').pop() + ' remain 1G SFP');
  }
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
