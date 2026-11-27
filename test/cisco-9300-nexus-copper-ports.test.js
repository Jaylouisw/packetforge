'use strict';
// Five Cisco specs generated their access ports from a portTemplate that said only
// `type: ethernet, speed: 1G` - no connector, no ladder - and two of the Nexus ones left their
// SFP28/QSFP28 uplinks equally silent (issue #1398). An inferred cage is invisible until a
// cable is offered to it, so the spec said nothing and nothing could contradict it.
//
// Cisco states the jack for every one of them, and the two platforms do NOT share a ladder:
//
//   9300 HIG, Connector and Cable Specifications: "All 10/100/1000 ports use standard RJ-45
//     connectors and Ethernet pinouts."
//   9300 HIG, "10/100/1000 Ports": "The 10/100/1000 ports use RJ-45 connectors ... The 10BASE-T
//     traffic can use Category 3 cable or higher" (i.e. 10, 100 and 1000).
//   9300 data sheet: `C9300-24UX / 24 ports Multigigabit Cisco UPOE (10G/5G/2.5G/1G/100M)`.
//   Nexus 3048 data sheet: "48 10/100/1000-Mbps RJ-45 ports; 4 1/10 Gbps SFP+ uplink ports";
//     ordering N3K-C3048TP-1GE "1RU 48 10/100/1000 Mbps and 4 10Gbps ports".
//   N9200 data sheet: "N92348GC-X / 48p 100M/1G Base-T ports + 4p 1/10/25G SFP28, +2p 40/100G
//     QSFP28"; "The 48 1GBASE-T downlink ports ... can be configured to work as 100-Mbps,
//     1-Gbps ports."
//
// research/cisco-9300-nexus-copper-ports.md carries the sources and what is left open.
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

// [model, prefix, count, speedCaps] - the copper access rows this pass settles.
const ACCESS = [
  ['C9300-24T', 'Gi1/0/', 24, [10, 100, 1000]],
  ['C9300-48P', 'Gi1/0/', 48, [10, 100, 1000]],
  ['Catalyst9300', 'Gi1/0/', 24, [10, 100, 1000]],
  ['N3K-C3048TP-1GE', 'Eth1/', 48, [10, 100, 1000]],
  ['N9K-C92348GC-X', 'Eth1/', 48, [100, 1000]]
];

section('The template declares the jack and the ladder, not just a rate');
for (const row of ACCESS) {
  const model = row[0];
  const tpl = spec(model).portTemplate || {};
  ok(tpl.connector === 'rj45', model + ': portTemplate declares connector rj45',
    'connector=' + String(tpl.connector));
  ok(JSON.stringify(tpl.speedCaps) === JSON.stringify(row[3]),
    model + ': portTemplate declares speedCaps ' + JSON.stringify(row[3]),
    JSON.stringify(tpl.speedCaps));
  ok(tpl.count === row[2] && tpl.prefix === row[1], model + ': the same ' + row[2] + ' ports, same names',
    tpl.prefix + tpl.start + ' x' + tpl.count);
}

section('Every generated port resolves to an RJ-45 cage with that ladder');
for (const row of ACCESS) {
  const model = row[0], prefix = row[1], count = row[2];
  const sw = dev(model);
  const first = sw.interfaces.get(prefix + 1);
  const last = sw.interfaces.get(prefix + count);
  ok(first && first.cage === 'rj45', model + ': ' + prefix + '1 is an RJ-45 cage',
    first && first.cage);
  ok(last && last.cage === 'rj45', model + ': ' + prefix + count + ' exists and is RJ-45',
    last && last.cage);
  const caps = first && first.hardware && first.hardware.speedCaps;
  ok(JSON.stringify(caps) === JSON.stringify(row[3]),
    model + ': ' + prefix + '1 trains at ' + JSON.stringify(row[3]), JSON.stringify(caps));
}

section('C9300-24UX keeps its NBASE-T ladder');
{
  const tpl = spec('C9300-24UX').portTemplate || {};
  ok(tpl.connector === 'rj45', 'C9300-24UX: portTemplate still declares rj45', String(tpl.connector));
  ok(JSON.stringify(tpl.speedCaps) === JSON.stringify([100, 1000, 2500, 5000, 10000]),
    'C9300-24UX: speedCaps [100,1000,2500,5000,10000] (10G/5G/2.5G/1G/100M)',
    JSON.stringify(tpl.speedCaps));
  const sw = dev('C9300-24UX');
  const p = sw.interfaces.get('Gi1/0/1');
  const wants = ['100base-tx', '1000base-t', '2.5gbase-t', '5gbase-t', '10gbase-t'];
  for (const id of wants) {
    ok(p.hardware.media.indexOf(id) !== -1, 'C9300-24UX: Gi1/0/1 offers ' + id,
      JSON.stringify(p.hardware.media));
  }
}

section('The Nexus ladders differ, and the spec says which is which');
{
  const x = dev('N9K-C92348GC-X').interfaces.get('Eth1/1');
  const t = dev('N3K-C3048TP-1GE').interfaces.get('Eth1/1');
  ok(x.hardware.speedCaps.indexOf(10) === -1,
    '92348GC-X: no 10M step (100M floor, per "100-Mbps, 1-Gbps ports")',
    JSON.stringify(x.hardware.speedCaps));
  ok(x.hardware.speedCaps.indexOf(100) !== -1 && x.hardware.speedCaps.indexOf(1000) !== -1,
    '92348GC-X: trains at 100M and 1G', JSON.stringify(x.hardware.speedCaps));
  ok(t.hardware.speedCaps.indexOf(10) !== -1,
    '3048TP: 10M is on the ladder (data sheet: 48 10/100/1000-Mbps RJ-45)',
    JSON.stringify(t.hardware.speedCaps));
}

section('The uplinks are cages, not copper');
{
  const n9 = dev('N9K-C92348GC-X');
  for (const n of ['Eth1/49', 'Eth1/50', 'Eth1/51', 'Eth1/52']) {
    const p = n9.interfaces.get(n);
    ok(p.cage === 'sfp28', '92348GC-X: ' + n + ' is an SFP28 cage', p.cage);
    ok(JSON.stringify(p.hardware.speedCaps) === JSON.stringify([1000, 10000, 25000]),
      '92348GC-X: ' + n + ' trains at 1/10/25G', JSON.stringify(p.hardware.speedCaps));
  }
  for (const n of ['Eth1/53', 'Eth1/54']) {
    const p = n9.interfaces.get(n);
    ok(p.cage === 'qsfp28', '92348GC-X: ' + n + ' is a QSFP28 cage', p.cage);
    ok(JSON.stringify(p.hardware.speedCaps) === JSON.stringify([40000, 100000]),
      '92348GC-X: ' + n + ' trains at 40/100G', JSON.stringify(p.hardware.speedCaps));
  }
  const n3 = dev('N3K-C3048TP-1GE');
  for (const n of ['Eth1/49', 'Eth1/52']) {
    const p = n3.interfaces.get(n);
    ok(p.cage === 'sfp+', '3048TP: ' + n + ' is an SFP+ cage', p.cage);
    ok(JSON.stringify(p.hardware.speedCaps) === JSON.stringify([1000, 10000]),
      '3048TP: ' + n + ' trains at 1/10G', JSON.stringify(p.hardware.speedCaps));
  }
  const copperIntoSfp = media.canMate(n9.interfaces.get('Eth1/1').hardware,
    n9.interfaces.get('Eth1/49').hardware);
  ok(copperIntoSfp.ok === false && copperIntoSfp.code === 'E_CONNECTOR_MISMATCH',
    '92348GC-X: the copper downlink will not cable to its own SFP28 uplink',
    copperIntoSfp.code + ': ' + copperIntoSfp.message);
}

section('A copper link across two of these switches still comes up at 1G');
{
  const a = dev('C9300-48P'), b = dev('N3K-C3048TP-1GE');
  const r = media.canMate(a.interfaces.get('Gi1/0/1').hardware, b.interfaces.get('Eth1/1').hardware);
  ok(r.ok === true && r.speedMbps === 1000, 'C9300-48P to Nexus 3048 meets at 1G',
    r.code + ' ' + r.speedMbps);
  const ux = dev('C9300-24UX');
  const r2 = media.canMate(ux.interfaces.get('Gi1/0/1').hardware, a.interfaces.get('Gi1/0/1').hardware);
  ok(r2.ok === true && r2.speedMbps === 1000,
    'a 10G NBASE-T port meets a 1G port at 1G, not at the faster side',
    r2.code + ' ' + r2.speedMbps);
  const u = dev('N9K-C92348GC-X'), v = dev('N3K-C3048TP-1GE');
  const r3 = media.canMate(u.interfaces.get('Eth1/49').hardware, v.interfaces.get('Eth1/49').hardware);
  ok(r3.ok === true && r3.speedMbps === 10000, 'SFP28 uplink to SFP+ uplink meets at 10G',
    r3.code + ' ' + r3.speedMbps);
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
