'use strict';
// ===========================================================================
// test/mikrotik-ccr-declared-hardware.test.js -- issue #2580.
//
// Four CCR rows described their ports in a `portTemplate` that declared no
// connector and no speedCaps. The ports existed and drew as something, but
// nothing in the spec said what they physically WERE: `derivePortHardware()`
// inferred a cage from the port name and fell back to 1 Gbit/s when the rate
// did not parse, so no datasheet claim could ever contradict them.
// `scripts/audit-port-types.js` reported all four under
// `undeclaredTemplateHardware` -- 49 ports.
//
// Two of the rows were also short of ports, which a lab hits directly:
//
//   * CCR2116-12G-4S+ has THIRTEEN 10/100/1000 ports, not twelve. The product
//     page's Ethernet row reads "10/100/1000 Ethernet ports  13", the manual's
//     Extension slots and ports section says "13x 10/100/1000 Ethernet ports.
//     4x 10G SFP+ ports.", and the product text explains where the thirteenth
//     comes from: "12 of them are running through the Marvel chip. And there is
//     another Gigabit port connected directly to the CPU. For management
//     purposes."  (https://mikrotik.com/product/ccr2116_12g_4splus ,
//      https://manual.mikrotik.com/hardware/ccr2116-12g-4s-plus/)
//   * CCR1036-8G-2S+ declared its eight copper ports and nothing else: the two
//     SFP+ cages that are in its own model name were missing, and the file had
//     no sourceUrl and no notes at all. The product page states both groups
//     -- Fiber: "SFP+ ports  2"; Ethernet: "10/100/1000 Ethernet ports  8" --
//     and adds "Supports both SFP (1.25G) and SFP+ (10G) modules".
//     (https://mikrotik.com/product/CCR1036-8G-2Splus)
//
// The cages that WERE named (the two SFP+ in the CCR2004-16G-2S+, the twelve
// SFP+ and two SFP28 in the CCR2004-1G-12S+2XS, the four SFP+ in the CCR2116)
// are declared per port, so this file also holds the numbers still: a thirteenth
// copper port must not turn up as an SFP cage, and a declared cage must resolve
// to the family its connector names.
//
// Run: node test/mikrotik-ccr-declared-hardware.test.js    exit 1 on divergence.
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
const MODELS = ['CCR2004-16G-2S+', 'CCR2004-1G-12S+2XS', 'CCR2116-12G-4S+', 'CCR1036'];
const specs = MODELS.map(spec);

function deviceOf(model) {
  const t = new Topology();
  const dev = t.addDevice(spec(model), 'D');
  return dev;
}

section('The four CCR rows are in the catalogue');
{
  const missing = MODELS.filter(function (m, i) { return !specs[i]; });
  ok(missing.length === 0, 'all four CCR rows load' + (missing.length ? ' (' + missing.join(', ') + ')' : ''));
}

section('Every port declares its own connector');
{
  // The defect: a template silent on connector / cage / speedCaps, so the cage was
  // inferred from the port name and the rate defaulted. This is exactly the list
  // `scripts/audit-port-types.js --json` prints under `undeclaredTemplateHardware`.
  for (const s of specs) {
    if (!s) continue;
    const undeclared = auditSpec(s).undeclaredPorts.map(function (p) { return p.name; });
    ok(undeclared.length === 0, s.model + ': no template port is left without a declared connector' +
      (undeclared.length ? ' (' + undeclared.length + ' port(s): ' + undeclared.slice(0, 4).join(', ') + ')' : ''));
  }
  // ...and nothing the audit does gate on fires either.
  for (const s of specs) {
    if (!s) continue;
    const r = auditSpec(s);
    const rules = [];
    for (const o of r.offenders) for (const rule of o.rules) rules.push(o.port + ' ' + rule);
    ok(rules.length === 0, s.model + ': no port contradicts its declared type' +
      (rules.length ? ' (' + rules.slice(0, 3).join(', ') + ')' : ''));
  }
}

section('A declared connector is the one the engine resolves');
{
  // Two-sided: the declaration must name the cage, and the resolved hardware must
  // belong to the family that connector names -- an SFP+ cage that lands on copper
  // renders RJ45 and refuses every optic.
  const mismatched = [];
  for (const s of specs) {
    if (!s) continue;
    const dev = deviceOf(s.model);
    for (const decl of effectiveInterfaces(s)) {
      const p = dev.interfaces.get(decl.name);
      if (!p || !p.hardware) continue;
      const declared = decl.connector || decl.cage || '';
      if (!declared) { mismatched.push(s.model + '/' + decl.name + ' declares nothing'); continue; }
      const optical = media.isOpticalCage(p.hardware.cage);
      if (/^(sfp|sfp\+|sfp28|qsfp|qsfp28)$/i.test(declared) && !optical) {
        mismatched.push(s.model + '/' + decl.name + ' ' + declared + ' -> ' + p.hardware.cage);
      }
      if (/^rj45$/i.test(declared) && optical) {
        mismatched.push(s.model + '/' + decl.name + ' rj45 -> ' + p.hardware.cage);
      }
    }
  }
  ok(mismatched.length === 0, 'every declared connector resolves to the cage it names' +
    (mismatched.length ? ' (' + mismatched.slice(0, 3).join(', ') + ')' : ''));
}

section('CCR2116-12G-4S+ terminates thirteen copper ports');
{
  const dev = deviceOf('CCR2116-12G-4S+');
  const copper = [];
  for (const p of dev.interfaces.values()) {
    if (/^eth\d+$/.test(p.name)) copper.push(p.name);
  }
  ok(copper.length === 13, 'thirteen eth sockets, which is the product page Ethernet row',
    copper.length + ' found: ' + copper.join(','));
  const mgmt = dev.interfaces.get('eth13');
  ok(!!mgmt, 'eth13 exists - the CPU-connected management jack the twelve-port model dropped');
  ok(!!mgmt && mgmt.cage === 'rj45', 'and it is an RJ45 socket', mgmt && mgmt.cage);
  ok(!!mgmt && mgmt.hardware && mgmt.hardware.maxSpeedMbps === 1000, 'terminating at 1G, as the CPU port does',
    mgmt && mgmt.hardware && String(mgmt.hardware.maxSpeedMbps));
  // It must be cableable at all: a management jack a topology cannot reach is the
  // same defect as one that is missing from the spec.
  ok(!!mgmt && mgmt.hardware && media.canMate(mgmt.hardware, mgmt.hardware, { mediaId: '1000base-t' }).ok === true,
    'eth13 takes a Cat5e/6 patch lead');
  const total = Array.from(dev.interfaces.values()).length;
  ok(total === 17, 'seventeen ports on the panel: thirteen copper and four SFP+', String(total));
  ok(!!dev.interfaces.get('SFP+4') && media.isOpticalCage(dev.interfaces.get('SFP+4').cage),
    'and SFP+4 is still an optical cage');
}

section('CCR1036-8G-2S+ declares its two SFP+ cages');
{
  const dev = deviceOf('CCR1036');
  const names = Array.from(dev.interfaces.keys());
  ok(names.length === 10, 'ten ports: eight copper and two SFP+', names.join(','));
  for (const n of ['SFP+1', 'SFP+2']) {
    const p = dev.interfaces.get(n);
    ok(!!p, 'the model name names the cage ' + n + ', and it exists');
    ok(!!p && p.cage === 'sfp+', 'and it is an SFP+ cage', p && p.cage);
    ok(!!p && p.hardware && p.hardware.family === 'optical', 'presenting as optical',
      p && p.hardware && p.hardware.family);
    ok(!!p && p.hardware && p.hardware.maxSpeedMbps === 10000, 'with 10G as its top rate',
      p && p.hardware && String(p.hardware.maxSpeedMbps));
    // "Supports both SFP (1.25G) and SFP+ (10G) modules" - a 1G optic has to fit too.
    ok(!!p && p.hardware && p.hardware.speedCaps.indexOf(1000) !== -1 &&
      p.hardware.speedCaps.indexOf(10000) !== -1,
      'and it trains at both the rates the product page names for the group',
      p && p.hardware && JSON.stringify(p.hardware.speedCaps));
  }
  const p1 = dev.interfaces.get('SFP+1');
  const p2 = dev.interfaces.get('SFP+2');
  if (p1 && p2) {
    const v = media.canMate(p1.hardware, p2.hardware, { mediaId: '10gbase-sr' });
    ok(v.ok === true && v.speedMbps === 10000, 'two of its cages meet over a 10GBASE-SR optic at 10G',
      v.code + ': ' + v.message);
  }
  const eth8 = dev.interfaces.get('eth8');
  ok(!!eth8 && eth8.cage === 'rj45', 'eth8 is still copper', eth8 && eth8.cage);
}

section('A copper port is not a cage, on any of the four');
{
  for (const s of specs) {
    if (!s) continue;
    const dev = deviceOf(s.model);
    const bad = [];
    for (const p of dev.interfaces.values()) {
      if (!p.hardware) continue;
      const nameSaysFibre = /^(sfp|qsfp)/i.test(p.name);
      if (nameSaysFibre && !media.isOpticalCage(p.hardware.cage)) bad.push(p.name + '=' + p.hardware.cage);
      if (!nameSaysFibre && media.isOpticalCage(p.hardware.cage)) bad.push(p.name + '=' + p.hardware.cage);
    }
    ok(bad.length === 0, s.model + ': the silkscreen and the modelled cage agree' +
      (bad.length ? ' (' + bad.slice(0, 3).join(', ') + ')' : ''));
  }
}

section('Each row cites the vendor page it was read from');
{
  for (const s of specs) {
    if (!s) continue;
    ok(/^https:\/\/mikrotik\.com\/product\//.test(String(s.sourceUrl)),
      s.model + ': cites its own product page', String(s.sourceUrl));
    ok(!!s.notes && String(s.notes).trim().length > 40, s.model + ': and records what the page said');
  }
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
