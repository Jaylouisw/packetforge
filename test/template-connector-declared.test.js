'use strict';
// ===========================================================================
// test/template-connector-declared.test.js -- issue #1398, the last 646.
//
// Issue #1398 counted the template ports whose connector nothing in the spec
// declared: 3396 when it was filed, 646 after the XGS and Palo Alto passes. A
// portTemplate that names only a prefix, a count, a type and a rate gives
// derivePortHardware() nothing to read for the cage, so inferCage() reads the
// PORT NAME and the rate and guesses. The audit could not complain, because
// the spec had not claimed anything: a wrong connector could never be caught.
//
// This pass declares the connector on every remaining template. The evidence is
// each spec's own description, which already transcribes the datasheet row
// ("48x 10/100/1000BASE-T RJ45", "8x 1G RJ45"), and the resolved ports are
// unchanged for all but three specs -- so this is a transcription, not a
// re-modelling.
//
// The three specs whose panel the template was getting wrong:
//
//   juniper/SRX1500   one 16-port template for "12x 1G RJ45 + 4x 1G SFP
//                     (ge-0/0/0-15)" modelled ge-0/0/12-15 as copper, so the
//                     four SFP cages refused a fibre lead and accepted RJ45.
//   netgear/GS748T    one 48-port copper template for a box whose description
//                     says two of the SFP slots are combo/shared with ports
//                     47-48, so those two positions take either medium.
//                     research/netgear-copper-ports.md held this one back.
//   huawei/AR651W-8P  one 10-port copper template for "2x GE combo WAN + 8x GE
//                     RJ45 LAN": the two WAN positions take an SFP module too.
//
// A combo position is ONE physical cage that takes an RJ45 lead or an SFP
// module, so it is declared connector "combo" rather than split into a copper
// port and a fibre port carrying a name the box's CLI does not have.
//
// Run: node test/template-connector-declared.test.js    exit 1 on divergence.
// ===========================================================================

const fs = require('fs');
const path = require('path');
const { Topology } = require('../engine');
const media = require('../engine/media');
const { loadCatalog, effectiveInterfaces } = require('../devices/registry');
const { auditSpec } = require('../scripts/audit-port-types');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  OK ' + msg); }
  else { failed++; console.error('  FAIL ' + msg + (detail ? '  [' + detail + ']' : '')); }
}
function section(name) { console.log('\n' + name); }

const DEVICES = path.join(__dirname, '..', 'devices');
const catalog = loadCatalog(DEVICES).filter(function (s) { return !s.error; });
function spec(vendor, model) {
  const s = catalog.filter(function (x) { return x.vendor === vendor && x.model === model; })[0];
  if (!s) throw new Error('missing spec ' + vendor + '/' + model);
  return s;
}
function device(vendor, model) {
  const t = new Topology();
  return t.addDevice(spec(vendor, model), 'D');
}
function hw(vendor, model, name) {
  const p = device(vendor, model).interfaces.get(name);
  if (!p) throw new Error('missing port ' + vendor + '/' + model + '/' + name);
  return p.hardware;
}
// A lead: what the far end presents.
function lead(connector, speed, caps) {
  return media.derivePortHardware({ name: 'eth0', connector: connector, speed: speed, speedCaps: caps },
    { model: 'LEAD' });
}
const FIBRE_1G = lead('sfp', '1G', [1000]);
const COPPER_1G = lead('rj45', '1G', [10, 100, 1000]);

function jsonFiles(dir) {
  const out = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.json')) out.push(p);
    }
  })(dir);
  return out;
}

// ---------------------------------------------------------------------------
section('No template port in the catalogue is left to inferCage()');
{
  const withTemplate = catalog.filter(function (s) { return s.portTemplate; });
  const left = [];
  let ports = 0;
  for (const s of withTemplate) {
    const u = auditSpec(s).undeclaredPorts;
    if (u.length) { left.push(s.vendor + '/' + s.model + ' (' + u.length + ')'); ports += u.length; }
  }
  ok(withTemplate.length >= 350, 'the template-bearing specs are all here', String(withTemplate.length));
  ok(left.length === 0, 'every one of them declares its connector' +
    (left.length ? ' -- ' + left.slice(0, 6).join(', ') + (left.length > 6 ? ', ...' : '') : ''),
    ports + ' port(s) left');
  ok(ports === 0, 'the audit undeclared-template count is zero', String(ports));
}
{
  // The audit only sees specs the registry loaded; this reads the files, so a spec
  // that fails to load cannot hide a silent template behind a broken-spec entry.
  const silent = [];
  for (const f of jsonFiles(DEVICES)) {
    let j;
    try { j = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { continue; }
    if (!j.portTemplate) continue;
    const t = j.portTemplate;
    if (!t.connector && !t.cage) silent.push(path.relative(DEVICES, f));
  }
  ok(silent.length === 0, 'and no devices/**/*.json portTemplate is silent', silent.join(', '));
}

// ---------------------------------------------------------------------------
section('juniper/SRX1500: twelve copper jacks, then four SFP cages');
{
  const s = spec('juniper', 'SRX1500');
  const ports = effectiveInterfaces(s);
  ok(ports.length === 20, 'still 20 front-panel ports after the split', String(ports.length));
  ok(s.portTemplate.count === 12, 'the template generates the twelve copper ports', String(s.portTemplate.count));
  ok(s.portTemplate.connector === 'rj45', 'and says they are RJ-45', String(s.portTemplate.connector));

  const copper = [];
  for (let n = 0; n <= 11; n++) {
    const h = hw('juniper', 'SRX1500', 'ge-0/0/' + n);
    if (h.cage !== 'rj45') copper.push('ge-0/0/' + n + '=' + h.cage);
  }
  ok(copper.length === 0, 'ge-0/0/0-11 are copper', copper.join(', '));

  const fib = [];
  for (let n = 12; n <= 15; n++) {
    const h = hw('juniper', 'SRX1500', 'ge-0/0/' + n);
    if (h.cage !== 'sfp') fib.push('ge-0/0/' + n + '=' + h.cage);
    else if (JSON.stringify(h.speedCaps) !== '[1000]') fib.push('ge-0/0/' + n + ' caps ' + h.speedCaps.join(','));
  }
  ok(fib.length === 0, 'ge-0/0/12-15 are 1G SFP cages (was every port an RJ-45 jack)', fib.join(', '));

  // The failure the split fixes: a fibre lead into the SFP half.
  const into12 = media.canMate(hw('juniper', 'SRX1500', 'ge-0/0/12'), FIBRE_1G);
  ok(into12.ok === true, 'a 1000BASE-SX lead seats in ge-0/0/12 (was a connector mismatch)',
    into12.code + ': ' + into12.message);
  ok(into12.speedMbps === 1000, 'and comes up at 1000 Mb/s', String(into12.speedMbps));
  const copperInto12 = media.canMate(hw('juniper', 'SRX1500', 'ge-0/0/12'), COPPER_1G);
  ok(copperInto12.ok === false, 'an RJ-45 lead is refused by ge-0/0/12 (there is no jack)',
    copperInto12.code + ': ' + copperInto12.message);
  const into11 = media.canMate(hw('juniper', 'SRX1500', 'ge-0/0/11'), FIBRE_1G);
  ok(into11.ok === false, 'and ge-0/0/11 still refuses fibre', into11.code + ': ' + into11.message);

  const xe = hw('juniper', 'SRX1500', 'xe-0/0/16');
  ok(xe.cage === 'sfp+', 'the 10G uplinks are still SFP+', xe.cage);
  ok(JSON.stringify(xe.speedCaps) === '[1000,10000]', 'taking a 1G module as well as a 10G one',
    xe.speedCaps.join(','));
}

// ---------------------------------------------------------------------------
section('netgear/GS748T: ports 47-48 are the combo positions');
{
  const s = spec('netgear', 'GS748T');
  const ports = effectiveInterfaces(s);
  ok(ports.length === 50, 'the box still presents 50 ports', String(ports.length));
  ok(s.portTemplate.count === 46, 'the template is the 46 plain copper jacks', String(s.portTemplate.count));
  ok(s.portTemplate.connector === 'rj45', 'and declares them RJ-45', String(s.portTemplate.connector));
  ok(JSON.stringify(s.portTemplate.speedCaps) === '[10,100,1000]', 'with the copper ladder stated',
    String(s.portTemplate.speedCaps));

  const h47 = hw('netgear', 'GS748T', 'port47');
  const h48 = hw('netgear', 'GS748T', 'port48');
  ok(h47.cage === 'combo', 'port47 is a combo position, as the description says', h47.cage);
  ok(h48.cage === 'combo', 'port48 is a combo position', h48.cage);

  const f47 = media.canMate(h47, FIBRE_1G);
  ok(f47.ok === true, 'a 1G SFP in port47 comes up (the one this research note held back)',
    f47.code + ': ' + f47.message);
  const c47 = media.canMate(h47, COPPER_1G);
  ok(c47.ok === true, 'and an RJ-45 lead does too', c47.code + ': ' + c47.message);

  const f1 = media.canMate(hw('netgear', 'GS748T', 'port1'), FIBRE_1G);
  ok(f1.ok === false, 'port1 is copper only', f1.code + ': ' + f1.message);
  const sfp = hw('netgear', 'GS748T', 'sfp1');
  ok(sfp.cage === 'sfp', 'the dedicated SFP uplink is an SFP cage', sfp.cage);
  const cSfp = media.canMate(sfp, COPPER_1G);
  ok(cSfp.ok === false, 'and refuses copper', cSfp.code + ': ' + cSfp.message);
}

// ---------------------------------------------------------------------------
section('huawei/AR651W-8P: the two WAN positions take copper or fibre');
{
  const s = spec('huawei', 'AR651W-8P');
  const ports = effectiveInterfaces(s).filter(function (p) { return p.type === 'ethernet'; });
  ok(ports.length === 10, 'ten GE ports, as before', String(ports.length));
  ok(s.portTemplate.count === 2, 'the template is the two combo WAN positions', String(s.portTemplate.count));
  ok(s.portTemplate.connector === 'combo', 'declared combo, not copper', String(s.portTemplate.connector));

  for (const n of ['GigabitEthernet0/0/1', 'GigabitEthernet0/0/2']) {
    const h = hw('huawei', 'AR651W-8P', n);
    ok(h.cage === 'combo', n + ' is one position taking either medium', h.cage);
    ok(media.canMate(h, FIBRE_1G).ok === true, 'a fibre module seats in ' + n);
    ok(media.canMate(h, COPPER_1G).ok === true, 'and so does a copper lead');
  }
  const lan = [];
  for (let n = 3; n <= 10; n++) {
    const h = hw('huawei', 'AR651W-8P', 'GigabitEthernet0/0/' + n);
    if (h.cage !== 'rj45') lan.push('GE0/0/' + n + '=' + h.cage);
  }
  ok(lan.length === 0, 'the eight LAN ports are RJ-45 copper', lan.join(', '));
  const lanFibre = media.canMate(hw('huawei', 'AR651W-8P', 'GigabitEthernet0/0/3'), FIBRE_1G);
  ok(lanFibre.ok === false, 'and refuse a fibre lead', lanFibre.code + ': ' + lanFibre.message);
}

// ---------------------------------------------------------------------------
section('Every rj45 template resolves to a copper cage');
{
  const wrong = [];
  const withTpl = catalog.filter(function (s) {
    return s.portTemplate && s.portTemplate.connector === 'rj45';
  });
  for (const s of withTpl) {
    const dev = new Topology().addDevice(s);
    const ports = effectiveInterfaces(s);
    const n = s.portTemplate.count === undefined || s.portTemplate.count === null ? 1 : s.portTemplate.count;
    for (let i = 0; i < n; i++) {
      const p = dev.interfaces.get(ports[i].name);
      if (!p) { wrong.push(s.model + '/' + ports[i].name + ' missing'); continue; }
      if (p.hardware.cage !== 'rj45') wrong.push(s.model + '/' + ports[i].name + '=' + p.hardware.cage);
      else if (!p.hardware.speedCaps.length) wrong.push(s.model + '/' + ports[i].name + ' has no ladder');
    }
  }
  ok(withTpl.length >= 40, 'the copper templates are in the catalogue', String(withTpl.length));
  ok(wrong.length === 0, 'and every generated port is an RJ-45 jack with a rate ladder' +
    (wrong.length ? ' -- ' + wrong.slice(0, 5).join(', ') : ''), String(wrong.length));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
