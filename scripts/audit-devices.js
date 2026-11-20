'use strict';
// audit-devices.js -- accuracy audit over the whole catalogue.
//
// The importer guarantees a spec is well-FORMED. This guarantees it is
// well-FORMED-AND-PLAUSIBLE: that ports can actually be cabled, and that a
// device which advertises optical uplinks in its description really has fibre
// cages rather than copper RJ45 ports.
//
// "Is this cage optical" is answered by engine/media.js (isOpticalCage), not by a
// list kept here. The copy this file carried named the Ethernet cages only, so a
// Brocade SAN switch with fc-sfpdd cages and 28 GPON ONTs with sc-apc ports were
// all reported as promising optics they did not have -- 33 findings, none of them
// a defect (docs/plans/catalogue-audit-agreement.md).
//
// Usage: node scripts/audit-devices.js [--json]
const path = require('path');
const { loadCatalog } = require('../devices/registry');
const { expandInterfaces } = require('../engine/topology');
const media = require('../engine/media');

const ROOT = path.join(__dirname, '..');

// A description may legitimately say "no SFP cages"; that is documentation, not
// a promise. Two strips: a clause that calls the optics optional, unfitted or an
// extra-cost module is not a promise either (plenty of platforms sell uplinks as
// field-fitted modules -- WatchGuard's M290 ships eight copper ports and names
// four SFP options for its empty bay), and then an explicit denial of the cage.
function claimsOptics(desc) {
  // The denials come out BEFORE the clause split: "SFP: none" is one denial, but a split on
  // the colon turns it into a bare "SFP" and drops the word that denied it.
  const withoutDenials = String(desc || '')
    .replace(/\b(no|without|zero|none|not)\b[^.;,]{0,24}\b(sfp|qsfp|xfp)\b/gi, ' ')
    .replace(/\b(sfp|qsfp|xfp)\b\s*[:=-]?\s*(none|n\/a|0)\b/gi, ' ')
    .replace(/\b(sfp|qsfp|xfp)\b[^.;,]{0,16}\b(none|n\/a|-)\b/gi, ' ');
  const clauses = withoutDenials.split(/[.;:]/).filter(function (c) {
    return !/\b(option|optional|unfitted|unpopulated|not fitted|blank|without)\b/i.test(c);
  });
  return /\b(sfp|qsfp|xfp)\b/i.test(clauses.join(' ; '));
}

// Exported so test/ can ask the same question the CLI asks, over a fixture or
// over the catalogue.
function auditCatalog(specs) {
  const report = {
    models: specs.length,
    vendors: new Set(specs.map(function (s) { return s.vendor; })).size,
    ports: 0,
    uncabliable: [],     // ethernet port with no legal medium at all
    opticalMissing: [],   // description claims optics, ports are all copper
    expandFailed: []
  };

  for (const spec of specs) {
    let ifaces = [];
    try {
      ifaces = expandInterfaces(spec);
    } catch (e) {
      report.expandFailed.push({ model: spec.vendor + '/' + spec.model, error: e.message });
      continue;
    }

    let optical = 0;
    for (const i of ifaces) {
      report.ports++;
      const hw = media.derivePortHardware(i, spec);
      if (i.type === 'ethernet' && (!hw.media || !hw.media.length)) {
        report.uncabliable.push({ model: spec.vendor + '/' + spec.model, port: i.name, cage: hw.cage });
      }
      if (media.isOpticalCage(hw.cage)) optical++;
    }

    if (claimsOptics(spec.description) && optical === 0) {
      report.opticalMissing.push({ model: spec.vendor + '/' + spec.model, ports: ifaces.length });
    }
  }
  return report;
}

function main() {
  const asJson = process.argv.indexOf('--json') !== -1;
  const report = auditCatalog(loadCatalog(path.join(ROOT, 'devices')));

  if (asJson) { console.log(JSON.stringify(report, null, 2)); return 0; }

  console.log('Models: ' + report.models + ' across ' + report.vendors + ' vendors');
  console.log('Ports:  ' + report.ports);
  console.log('Uncablable ethernet ports: ' + report.uncabliable.length);
  for (const u of report.uncabliable.slice(0, 10)) console.log('   - ' + u.model + ' ' + u.port + ' (cage ' + u.cage + ')');
  console.log('Describe optics but have no fibre cage: ' + report.opticalMissing.length);
  for (const o of report.opticalMissing.slice(0, 15)) console.log('   - ' + o.model + ' (' + o.ports + ' ports)');
  if (report.opticalMissing.length > 15) console.log('   ... and ' + (report.opticalMissing.length - 15) + ' more');
  if (report.expandFailed.length) {
    console.log('Failed to expand: ' + report.expandFailed.length);
    for (const f of report.expandFailed.slice(0, 10)) console.log('   - ' + f.model + ': ' + f.error);
  }

  const bad = report.uncabliable.length + report.expandFailed.length;
  // Name both numbers: a green exit gates "a port can be cabled", it does not
  // report anything about the optics line above it.
  console.log('\nGated: ' + bad + ' hard defect(s). Reported, not gated: ' +
    report.opticalMissing.length + ' optics claim(s) without a fibre cage ' +
    '(test/hardware-invariants.test.js gates that rule, with issue #9 as its known-gap list).');
  return bad ? 1 : 0;
}

if (require.main === module) process.exit(main());

module.exports = { main: main, auditCatalog: auditCatalog, claimsOptics: claimsOptics };
