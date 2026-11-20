'use strict';
// Two audits ask "does this description promise optics the ports cannot deliver?"
// and they used to answer differently: 33 devices apart (docs/plans/catalogue-audit-agreement.md).
//
// `scripts/audit-devices.js` kept its own five-name cage list - ['sfp','sfp+','sfp28',
// 'qsfp+','qsfp28'] - so a Brocade SAN switch with fc-sfpdd cages and 28 GPON ONTs with
// sc-apc ports all read as copper. `test/hardware-invariants.test.js` kept a longer list of
// its own, which is why the same catalogue was 0 for one tool and 33 for the other.
//
// Both now call engine/media.js's `isOpticalCage()`, which reads the cage table the engine
// itself cables from, and both strip an "optional module" clause before reading a claim.
// This suite pins the three shapes that used to be wrong, the control that must still fail,
// and the catalogue-wide agreement between the audit's answer and the invariant's.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadCatalog } = require('../devices/registry');
const { Topology } = require('../engine/topology');
const media = require('../engine/media');
const { auditCatalog, claimsOptics } = require('../scripts/audit-devices');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}
const ROOT = path.join(__dirname, '..');

function fixture(specs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-audit-'));
  for (const [name, spec] of Object.entries(specs)) {
    fs.writeFileSync(path.join(dir, name + '.json'), JSON.stringify(spec, null, 2));
  }
  const loaded = loadCatalog(dir);
  fs.rmSync(dir, { recursive: true, force: true });
  return loaded;
}

console.log('A cage is optical because the media table says so, not because a list names it:');
{
  ok(media.isOpticalCage('sfp+') && media.isOpticalCage('qsfp28'), 'the Ethernet cages it always knew');
  ok(media.isOpticalCage('fc-sfpdd') && media.isOpticalCage('fc-qsfp28'),
    'a Fibre Channel cage is a fibre end (Brocade G720 / Dell DS-6630B were reported as copper)');
  ok(media.isOpticalCage('sc-apc') && media.isOpticalCage('sc-upc'),
    'a PON connector is a fibre end (28 GPON ONTs were reported as copper)');
  ok(!media.isOpticalCage('rj45') && !media.isOpticalCage('combo') && !media.isOpticalCage('dsl'),
    'copper, a copper-or-SFP combo position and a phone socket are not fibre ends');
  ok(!media.isOpticalCage('not-a-cage'), 'an unknown cage is not silently optical');
}

console.log('\nThe prose rule reads an optional module as a module, not as a promise:');
{
  const specs = fixture({
    // FC switch: claimed optics in prose, fc-sfpdd cages. Was in the 33.
    fc: { vendor: 'Testco', model: 'TS-FC', category: 'switch',
      description: 'Gen 7 FC SAN switch: 48 x 64G SFP+ ports plus 8 x 2x64G SFP-DD cages.',
      interfaces: [{ name: '0', type: 'ethernet', speed: '64G', connector: 'fc-sfpdd' }] },
    // PON ONT: prose names the SFP module it is built into. Was in the 33.
    pon: { vendor: 'Testco', model: 'TS-PON', category: 'ont',
      description: 'GPON ONT built into an SFP module with a single SC/APC fibre port.',
      interfaces: [{ name: 'pon', type: 'pon', speed: '2.5G', connector: 'sc-apc' }] },
    // Firewall: copper as shipped, SFP named only as an unfitted option. Was in the 33.
    optional: { vendor: 'Testco', model: 'TS-OPT', category: 'firewall',
      description: 'Branch firewall: 8x 1GbE RJ45 and no SFP cages as shipped (the open module bay '
        + 'accepts optional 4x1G SFP or 2x10G SFP+ modules).',
      portTemplate: { prefix: 'eth', start: 0, count: 8, type: 'ethernet', speed: '1G' } },
    // Control: a real claim with copper ports must still be caught.
    liar: { vendor: 'Testco', model: 'TS-LIAR', category: 'switch',
      description: '24-port 1G switch with 4 x 10G SFP+ uplinks.',
      portTemplate: { prefix: 'Gi', start: 1, count: 24, type: 'ethernet', speed: '1G' } },
    // Control: copper-only prose is not a claim at all.
    copper: { vendor: 'Testco', model: 'TS-CU', category: 'switch',
      description: '5-port 1G RJ45 unmanaged switch.',
      portTemplate: { prefix: 'eth', start: 1, count: 5, type: 'ethernet', speed: '1G' } }
  });
  const report = auditCatalog(specs);
  const flagged = report.opticalMissing.map(function (o) { return o.model; }).sort();
  ok(flagged.length === 1 && flagged[0] === 'Testco/TS-LIAR',
    'only the device that really promises optics without a cage is reported', flagged.join(','));
  ok(report.uncabliable.length === 0, 'and no fixture port is uncabliable',
    JSON.stringify(report.uncabliable));
  ok(claimsOptics('48 x 1G RJ45, SFP: none') === false, 'an explicit denial is still read as a denial');
  ok(claimsOptics('2 x 10G SFP+ uplinks') === true, 'an unqualified uplink claim is still a claim');
}

console.log('\nThe audit and the catalogue invariant name the same devices:');
{
  const catalog = loadCatalog(path.join(ROOT, 'devices'));
  const audit = auditCatalog(catalog).opticalMissing
    .map(function (o) { return o.model; }).sort();

  // The invariant's half, computed the way test/hardware-invariants.test.js does it: build a
  // real device and read the hardware the engine derived, rather than the registry's expansion.
  const invariant = [];
  for (const spec of catalog) {
    if (!claimsOptics(spec.description)) continue;
    const dev = new Topology().addDevice(spec);
    const ifaces = [...dev.interfaces.values()];
    const optical = ifaces.filter(function (i) { return media.isOpticalCage(i.hardware.cage); });
    if (!optical.length) invariant.push(spec.vendor + '/' + spec.model);
  }
  invariant.sort();

  ok(audit.length === 0, 'the catalogue has no optics claim without a fibre cage (' + audit.length + ')',
    audit.slice(0, 5).join(', '));
  ok(JSON.stringify(audit) === JSON.stringify(invariant),
    'the audit and the invariant name the same devices (' + audit.length + ' vs ' + invariant.length + ')',
    'audit: ' + audit.slice(0, 5).join(',') + ' | invariant: ' + invariant.slice(0, 5).join(','));
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
