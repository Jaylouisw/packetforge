'use strict';
// ===========================================================================
// test/mikrotik-ccr2216-declared-hardware.test.js -- the fifth CCR row.
//
// Issue #2594. Issue #2580 named "four CCR rows" and PR #2581 fixed them. The CCR2216 is
// the same generation as the CCR2116 it sits beside on MikroTik's product
// index, and it was left in exactly the state the four were in before that
// fix: portTemplate with a prefix, a count, a type and a rate, and nothing
// that says what the ports physically ARE. derivePortHardware() inferred a
// cage from the port name and no datasheet claim could contradict it, so
// scripts/audit-port-types.js listed the model under
// undeclaredTemplateHardware -- 14 ports.
//
// The vendor material is unambiguous about the panel:
//   * product page, Ethernet: "10/100/1000 Ethernet ports  1"
//   * product page, Fiber:    "Number of 25G SFP28 ports  12"
//                             "Number of 100G QSFP28 ports  2"
//   * product text: "There are 2x QSFP28 cages for blazing-fast 100 Gigabit
//     connectivity, 12x SFP28 cages for 25 Gigabit networking, and a Gigabit
//     Ethernet port."
//   (https://mikrotik.com/product/ccr2216_1g_12xs_2xq)
//
// The QSFP28 cages are named in the RouterOS manual for this board: "For
// MikroTik CRS5xx series and CCR2216 devices, QSFP28 interfaces support the
// following link speeds: 1x 100G, 2x 50G, 1x 40G, 4x 25G, 4x 10G, 4x 1G."
// The 2x/4x rows are breakout modes (sub-interfaces), so the port itself is
// declared at the 100G/40G the cage ladder carries and the breakout is not
// modelled as separate ports.
//   (https://manual.mikrotik.com/docs/7.25/wired-connections/mikrotik-wired-interface-compatibility/)
//
// Run: node test/mikrotik-ccr2216-declared-hardware.test.js    exit 1 on divergence.
// ===========================================================================

const path = require('path');
const { Topology } = require('../engine');
const media = require('../engine/media');
const { loadCatalog, effectiveInterfaces } = require('../devices/registry');
const { auditSpec } = require('../scripts/audit-port-types');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}
function section(name) { console.log('\n' + name); }

const catalog = loadCatalog(path.join(__dirname, '..', 'devices')).filter(function (s) { return !s.error; });
function spec(model) {
  return catalog.filter(function (s) { return s.vendor === 'mikrotik' && s.model === model; })[0];
}
const MODEL = 'CCR2216-1G-12XS-2XQ';
const s = spec(MODEL);

function deviceOf(model) {
  const t = new Topology();
  return t.addDevice(spec(model), 'D');
}

section('The CCR2216 is in the catalogue');
{
  ok(!!s, MODEL + ' loads');
}

section('No template port is left without a declared connector');
{
  const undeclared = s ? auditSpec(s).undeclaredPorts.map(function (p) { return p.name; }) : ['spec missing'];
  ok(undeclared.length === 0, MODEL + ': every one of the 15 ports declares its connector' +
    (undeclared.length ? ' (' + undeclared.length + ' left: ' + undeclared.slice(0, 4).join(', ') + ')' : ''));
  const r = s ? auditSpec(s) : { offenders: [] };
  const rules = [];
  for (const o of r.offenders) for (const rule of o.rules) rules.push(o.port + ' ' + rule);
  ok(rules.length === 0, MODEL + ': nothing contradicts its declared type' +
    (rules.length ? ' (' + rules.slice(0, 3).join(', ') + ')' : ''));
}

section('The panel is the one the product page prints');
{
  const dev = deviceOf(MODEL);
  const names = Array.from(dev.interfaces.keys());
  ok(names.length === 15, 'fifteen ports: one copper, twelve SFP28 and two QSFP28', String(names.length));
  const copper = names.filter(function (n) { return /^eth\d+$/.test(n); });
  const sfp28 = names.filter(function (n) { return /^SFP28-\d+$/.test(n); });
  const qsfp28 = names.filter(function (n) { return /^QSFP28-\d+$/.test(n); });
  ok(copper.length === 1, 'one RJ45 jack, which is the product page Ethernet row', copper.join(','));
  ok(sfp28.length === 12, 'twelve SFP28 cages', sfp28.join(','));
  ok(qsfp28.length === 2, 'two QSFP28 cages', qsfp28.join(','));
}

section('The copper jack is a 10/100/1000BASE-T socket');
{
  const dev = deviceOf(MODEL);
  const eth1 = dev.interfaces.get('eth1');
  ok(!!eth1 && eth1.cage === 'rj45', 'eth1 is copper', eth1 && eth1.cage);
  ok(!!eth1 && eth1.hardware && eth1.hardware.maxSpeedMbps === 1000, 'topping out at 1G',
    eth1 && eth1.hardware && String(eth1.hardware.maxSpeedMbps));
  ok(!!eth1 && eth1.hardware && eth1.hardware.speedCaps.indexOf(100) !== -1 &&
    eth1.hardware.speedCaps.indexOf(1000) !== -1,
    'and training at the three rates the table names',
    eth1 && eth1.hardware && JSON.stringify(eth1.hardware.speedCaps));
  ok(!!eth1 && media.canMate(eth1.hardware, eth1.hardware, { mediaId: '1000base-t' }).ok === true,
    'a Cat5e/6 patch lead seats in it');
}

section('The twelve SFP28 cages are optical and take the SFP28 ladder');
{
  const dev = deviceOf(MODEL);
  for (let i = 1; i <= 12; i++) {
    const p = dev.interfaces.get('SFP28-' + i);
    ok(!!p, 'SFP28-' + i + ' exists');
    ok(!!p && p.cage === 'sfp28', 'SFP28-' + i + ' is an SFP28 cage', p && p.cage);
    ok(!!p && p.hardware && media.isOpticalCage(p.hardware.cage),
      'SFP28-' + i + ' presents as optical', p && p.hardware && p.hardware.cage);
    ok(!!p && p.hardware && p.hardware.maxSpeedMbps === 25000, 'SFP28-' + i + ' tops out at 25G',
      p && p.hardware && String(p.hardware.maxSpeedMbps));
    ok(!!p && p.hardware && p.hardware.speedCaps.indexOf(10000) !== -1 &&
      p.hardware.speedCaps.indexOf(1000) !== -1,
      'SFP28-' + i + ' also trains a 10G or 1G module',
      p && p.hardware && JSON.stringify(p.hardware.speedCaps));
  }
  const a = dev.interfaces.get('SFP28-1');
  const b = dev.interfaces.get('SFP28-12');
  if (a && b) {
    const v = media.canMate(a.hardware, b.hardware, { mediaId: '10gbase-sr' });
    ok(v.ok === true, 'two of them meet over a 10GBASE-SR optic',
      v.code + ': ' + v.message);
  }
}

section('The two QSFP28 cages are 100G cages that also train 40G');
{
  const dev = deviceOf(MODEL);
  for (const n of ['QSFP28-1', 'QSFP28-2']) {
    const p = dev.interfaces.get(n);
    ok(!!p, n + ' exists');
    ok(!!p && p.cage === 'qsfp28', n + ' is a QSFP28 cage', p && p.cage);
    ok(!!p && p.hardware && media.isOpticalCage(p.hardware.cage), n + ' presents as optical',
      p && p.hardware && p.hardware.cage);
    ok(!!p && p.hardware && p.hardware.maxSpeedMbps === 100000, n + ' tops out at 100G',
      p && p.hardware && String(p.hardware.maxSpeedMbps));
    ok(!!p && p.hardware && p.hardware.speedCaps.indexOf(40000) !== -1,
      n + ' also carries a 40G module', p && p.hardware && JSON.stringify(p.hardware.speedCaps));
  }
  const q1 = dev.interfaces.get('QSFP28-1');
  const q2 = dev.interfaces.get('QSFP28-2');
  if (q1 && q2) {
    const v100 = media.canMate(q1.hardware, q2.hardware, { mediaId: '100gbase-sr4' });
    ok(v100.ok === true && v100.speedMbps === 100000, 'the pair meets over 100GBASE-SR4 at 100G',
      v100.code + ': ' + v100.message);
    const v40 = media.canMate(q1.hardware, q2.hardware, { mediaId: '40gbase-sr4' });
    ok(v40.ok === true, 'and a 40GBASE-SR4 seats in them (the manual 1x 40G row)',
      v40.code + ': ' + v40.message);
  }
}

section('The spec cites the two vendor pages it was read from');
{
  ok(!!s && /^https:\/\/mikrotik\.com\/product\//.test(String(s.sourceUrl)),
    'cites its own product page', s && String(s.sourceUrl));
  ok(!!s && String(s.notes).indexOf('https://manual.mikrotik.com/') !== -1,
    'and the manual page that names the QSFP28 rates');
  ok(!!s && String(s.notes).trim().length > 40, 'with what the pages said, recorded');
}

section('The whole CCR row set is now fully declared');
{
  const CCR = catalog.filter(function (x) {
    return x.vendor === 'mikrotik' && /^CCR\d/.test(String(x.model));
  });
  const left = [];
  for (const x of CCR) {
    const u = auditSpec(x).undeclaredPorts;
    if (u.length) left.push(x.model + ' (' + u.length + ')');
  }
  ok(CCR.length >= 5, 'the CCR rows are all in the catalogue', String(CCR.length));
  ok(left.length === 0, 'all ' + CCR.length + ' CCR specs declare every port' +
    (left.length ? ' (' + left.join(', ') + ')' : ''));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
