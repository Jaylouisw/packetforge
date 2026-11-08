#!/usr/bin/env node
/**
 * Fibre Channel is a different protocol in the same socket.
 *
 * An 8G FC optic seats in an SFP+ cage exactly as a 10GBASE-SR one does, and the connector check
 * passes. What cannot happen is a frame crossing: FC has its own rate ladder, its own framing
 * (8b/10b up to 8G, 64b/66b above) and its own login. This suite pins three things the model used
 * to get wrong: the FC rates are line rates and not the numbers on the box, two FC ports link and
 * negotiate down the ladder, and an FC port cabled to an Ethernet port is refused *by name*
 * rather than mating happily and black-holing every frame.
 */
'use strict';

const path = require('path');
const { Topology } = require('../engine');
const { loadCatalog } = require('../devices/registry');
const media = require('../engine/media');

let passed = 0, failed = 0;
function ok(cond, name) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name); }
}
function t(name, fn) {
  console.log('\n' + name);
  if (typeof fn !== 'function') return;   // a section header with no body
  try { fn(); } catch (e) { failed++; console.log('  ✗ threw: ' + e.message); }
}

const root = path.join(__dirname, '..');
const specs = loadCatalog(path.join(root, 'devices'));
const byModel = {};
for (const s of specs) byModel[String(s.vendor) + '/' + String(s.model)] = s;

function build(vendorModel, extra) {
  const spec = byModel[vendorModel];
  if (!spec) throw new Error('missing spec ' + vendorModel);
  const topo = new Topology();
  const dev = topo.addDevice(spec);
  return { topo, dev };
}

function portByIndex(dev, n) {
  const list = [...dev.interfaces.values()].filter(p => p.hardware.cage !== 'rj45');
  return list[n];
}

// ---------------------------------------------------------------------------
t('The G in an FC part name is not the line rate');

ok(media.mediaById('8gfc-sw').speedMbps === 8500, '8GFC runs at 8.5 Gbit/s');
ok(media.mediaById('16gfc-sw').speedMbps === 14025, '16GFC runs at 14.025 Gbit/s, not 16');
ok(media.mediaById('32gfc-sw').speedMbps === 28050, '32GFC runs at 28.05 Gbit/s, not 32');
ok(media.mediaById('64gfc-sw').speedMbps === 57800, '64GFC runs at 57.8 Gbit/s, not 64');
ok(media.mediaById('128gfc-sw').speedMbps === 112200, '128GFC is four 32G lanes: 112.2 Gbit/s');
ok(media.mediaById('2gfc-sw').speedMbps === 2125, '2GFC runs at 2.125 Gbit/s');
ok(media.mediaById('4gfc-sw').speedMbps === 4250, '4GFC runs at 4.25 Gbit/s');
// The sign of the difference flips halfway up the ladder, which is the part that catches people
// out. Below 16G the line rate is ABOVE the name (8b/10b spends a fifth of the rate on framing:
// a 2G FC port runs at 2.125 Gbaud to carry a 2.0 Gbit/s payload). From 16G up the line rate is
// BELOW the name, because those generations describe the raw line rate and put 64b/66b on top.
const FC_LINE_EXACT = {
  '2gfc-sw': 2125, '2gfc-lw': 2125, '4gfc-sw': 4250, '4gfc-lw': 4250,
  '8gfc-sw': 8500, '8gfc-lw': 8500, '10gfc-sw': 10519, '10gfc-lw': 10519,
  '16gfc-sw': 14025, '16gfc-lw': 14025, '32gfc-sw': 28050, '32gfc-lw': 28050,
  '64gfc-sw': 57800, '64gfc-lw': 57800, '128gfc-sw': 112200, '128gfc-lw': 112200
};
const fcs = Object.keys(media.MEDIA).filter(id => media.MEDIA[id].family === 'fibre-channel');
ok(fcs.length === Object.keys(FC_LINE_EXACT).length,
  'every FC medium has a pinned line rate (' + fcs.length + ' of ' + Object.keys(FC_LINE_EXACT).length + ')');
const wrong = fcs.filter(id => media.MEDIA[id].speedMbps !== FC_LINE_EXACT[id]);
ok(wrong.length === 0, 'each FC medium runs at its real line rate' +
  (wrong.length ? ' (' + wrong.join(', ') + ')' : ''));
ok(media.mediaById('2gfc-sw').speedMbps > 2000 && media.mediaById('64gfc-sw').speedMbps < 64000,
  'the framing overhead flips sign between 8G and 64G, as the standards say it does');

// ---------------------------------------------------------------------------
t('An FC port is in an FC cage, not an Ethernet one');

const FC_CAGES = ['fc-sfp', 'fc-sfp28', 'fc-sfpdd', 'fc-qsfp28'];
ok(FC_CAGES.every(c => media.CAGES[c] && media.CAGES[c].family === 'fibre-channel'),
  'all four FC cages exist and belong to the FC family');
ok(media.cagesMate('fc-sfp', 'sfp+') && media.cagesMate('sfp+', 'fc-sfp'),
  'an FC SFP+ socket and an Ethernet SFP+ socket are the same physical socket (both ways)');
ok(media.cagesMate('fc-sfpdd', 'sfp+'), 'an SFP-DD cage takes an SFP+ module, as SFP-DD is defined to');
ok(!media.cagesMate('fc-qsfp28', 'sfp28'), 'an SFP module does not fit a QSFP28 socket');
ok(media.CAGE_SPEEDS['fc-sfp28']().every(n => n <= 28050), 'the 32G FC cage carries nothing above 28.05G');
ok(media.CAGE_SPEEDS['fc-qsfp28']().indexOf(112200) !== -1, 'the 128G FC cage carries 112.2G');

// ---------------------------------------------------------------------------
t('An FC switch is modelled as an FC switch');

// model -> { cage: count }, and the fastest rate the device runs
const FC_DEVICES = [
  ['qlogic/5800V',    { 'fc-sfp': 24 },   10519],   // 20 device ports + 4 ISL
  ['hpe/SN3600B',     { 'fc-sfp28': 24 }, 28050],
  ['brocade/G610',    { 'fc-sfp28': 24 }, 28050],
  ['brocade/G720',    { 'fc-sfpdd': 56 }, 57800],
  ['cisco/MDS 9124V', { 'fc-sfpdd': 24 }, 57800],
  ['cisco/MDS 9148S', { 'fc-sfp': 48 },   14025],
  ['dell/DS-6630B',   { 'fc-sfp28': 96, 'fc-qsfp28': 8 }, 112200]
];

for (const [key, byCage, rate] of FC_DEVICES) {
  const { dev } = build(key);
  const fcPorts = [...dev.interfaces.values()].filter(p => FC_CAGES.indexOf(p.hardware.cage) !== -1);
  for (const cage of Object.keys(byCage)) {
    const n = fcPorts.filter(p => p.hardware.cage === cage).length;
    ok(n === byCage[cage], key + ': ' + byCage[cage] + ' port(s) in the ' + cage + ' cage (got ' + n + ')');
  }
  const fastest = Math.max.apply(null, fcPorts.map(p => p.hardware.maxSpeedMbps));
  ok(fastest === rate, key + ': fastest port is ' + rate + ' Mbps, not the marketing number (got ' + fastest + ')');
  const ethFibre = fcPorts.filter(p => (p.hardware.media || []).some(function (id) {
    const m = media.MEDIA[id];
    return m && m.family !== 'fibre-channel';
  }));
  ok(ethFibre.length === 0, key + ': no FC port advertises an Ethernet medium');
}

// ---------------------------------------------------------------------------
t('Two FC ports link, and negotiate down the ladder');

{
  const a = build('brocade/G720', 'a');   // 64G ports, ladder 16/32/64
  const b = build('hpe/SN3600B', 'b');    // 32G ports, ladder 8/16/32
  const pa = portByIndex(a.dev, 0);
  const pb = portByIndex(b.dev, 0);
  const verdict = media.canMate(pa.hardware, pb.hardware);
  ok(verdict.ok === true, 'a 64G port mates with a 32G port');
  ok(!verdict.speedMbps || verdict.speedMbps <= 28050,
    'and the link runs at the lower rung, not at 57.8G (got ' + verdict.speedMbps + ')');
}

{
  const a = build('qlogic/5800V');         // 8G fabric switch
  const b = build('qlogic/5800V');
  const v = media.canMate(portByIndex(a.dev, 0).hardware, portByIndex(b.dev, 0).hardware);
  ok(v.ok === true && v.speedMbps === 8500, 'two 8G ports link at 8.5 Gbit/s');
}

// ---------------------------------------------------------------------------
t('An FC port accepts no Ethernet medium, and says so in words');

{
  const fcSwitch = build('brocade/G610').dev;
  // An SFP+ port, not a 1G SFP one: an 8G FC module does not physically fit a plain SFP cage,
  // so that pair refuses on the connector and would prove nothing about the protocol.
  const ethSwitch = build('mikrotik/CRS326-24G-2S+RM').dev;
  const pf = portByIndex(fcSwitch, 0);
  const pe = [...ethSwitch.interfaces.values()].find(p => p.hardware.cage === 'sfp+');
  ok(!!pe, 'found an Ethernet SFP+ port to test against');
  const v = media.canMate(pf.hardware, pe.hardware);
  ok(v.ok === false, 'an FC port refuses an Ethernet SFP port');
  ok(v.code === 'E_PROTOCOL_MISMATCH',
    'and the reason is the protocol, not the connector (got ' + v.code + ')');
  ok(/Fibre Channel/.test(v.message) && /Ethernet/.test(v.message),
    'the message names both protocols');
  ok(/28\.05|rate ladder/.test(v.message), 'and explains why the rates never meet');
}

{
  const fcSwitch = build('brocade/G720').dev;
  const eth = build('mikrotik/CRS326-24G-2S+RM').dev;
  const pf = portByIndex(fcSwitch, 0);
  const pe = [...eth.interfaces.values()].find(p => p.hardware.cage === 'sfp+');
  const v = media.canMate(pe.hardware, pf.hardware);
  ok(v.ok === false && v.code === 'E_PROTOCOL_MISMATCH',
    'and it is refused in the other direction too');
}

// ---------------------------------------------------------------------------
t('The physical layer is unchanged for everything Ethernet');

{
  const a = build('ubiquiti/EdgeSwitch-16').dev;
  const b = build('ubiquiti/EdgeSwitch-16').dev;
  const pa = [...a.interfaces.values()].find(p => p.hardware.cage === 'sfp');
  const pb = [...b.interfaces.values()].find(p => p.hardware.cage === 'sfp');
  const v = media.canMate(pa.hardware, pb.hardware);
  ok(v.ok === true, 'two Ethernet SFP ports still link');
  ok(v.code !== 'E_PROTOCOL_MISMATCH', 'and no protocol complaint is raised');
}

// ---------------------------------------------------------------------------
t('Fibre Channel is not a power source');

{
  const bad = [];
  for (const [key] of FC_DEVICES) { /* same list, first element is the model */
    const { dev } = build(key);
    for (const p of dev.interfaces.values()) {
      if (FC_CAGES.indexOf(p.hardware.cage) !== -1 && p.hardware.poeOut) {
        bad.push(key + '/' + p.name);
      }
    }
  }
  ok(bad.length === 0, 'no FC port claims to source PoE' + (bad.length ? ' (' + bad.slice(0, 3).join(', ') + ')' : ''));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
