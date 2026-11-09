'use strict';
// audit-devices.js -- accuracy audit over the whole catalogue.
//
// The importer guarantees a spec is well-FORMED. This guarantees it is
// well-FORMED-AND-PLAUSIBLE: that ports can actually be cabled, and that a
// device which advertises optical uplinks in its description really has optical
// cages rather than copper RJ45 ports.
//
// Usage: node scripts/audit-devices.js [--json]
const path = require('path');
const { loadCatalog } = require('../devices/registry');
const { expandInterfaces } = require('../engine/topology');
const media = require('../engine/media');

const ROOT = path.join(__dirname, '..');
const OPTICAL_CAGES = ['sfp', 'sfp+', 'sfp28', 'qsfp+', 'qsfp28'];

// -- duplicate detection ---------------------------------------------------
// Two files describing one product are invisible to every other check: both
// load, both expand to plausible ports, and the doc assertions only count
// totals. Found the hard way - synology/rackstation-rs1221.json and
// synology/rs1221.json were the same 2U RS1221+ at the same time, which is how
// this pass got written.
//
// The normalisation is deliberately conservative because a false positive here
// fails the build: '+' becomes 'plus' so DS923 and DS923+ stay distinct, and
// only vendor-neutral family words are dropped.
const FAMILY_WORDS = /\b(rackstation|diskstation|flashstation|columstation|truenas|nas)\b/g;
function normModel(s) {
  return String(s || '')
    .toLowerCase()
    .replace(FAMILY_WORDS, '')
    .replace(/\+/g, 'plus')
    .replace(/[^a-z0-9]/g, '');
}

function findDuplicates(cat) {
  const sameVendor = new Map();
  const crossVendor = new Map();
  for (const spec of cat) {
    if (spec.error) continue;
    const n = normModel(spec.model);
    if (!n) continue;
    const vk = spec.vendor + ' | ' + n;
    if (!sameVendor.has(vk)) sameVendor.set(vk, []);
    sameVendor.get(vk).push(spec);
    if (!crossVendor.has(n)) crossVendor.set(n, []);
    crossVendor.get(n).push(spec);
  }

  const dups = [];
  for (const [key, specs] of sameVendor) {
    if (specs.length > 1) {
      dups.push({
        key: key,
        entries: specs.map(function (s) { return s.vendor + '/' + s.model; })
      });
    }
  }

  // Same normalised model, different vendor strings. Not a hard failure: whether
  // athom/homey or philips/philips-hue is canonical is a naming decision, not a
  // defect, so these are reported and left to a human.
  const twins = [];
  for (const [key, specs] of crossVendor) {
    const vendors = new Set(specs.map(function (s) { return s.vendor; }));
    if (vendors.size > 1) {
      twins.push({
        key: key,
        entries: specs.map(function (s) { return s.vendor + '/' + s.model; })
      });
    }
  }
  return { dups: dups, twins: twins };
}

function main() {
  const asJson = process.argv.indexOf('--json') !== -1;
  const cat = loadCatalog(path.join(ROOT, 'devices'));
  const dups = findDuplicates(cat);

  const report = {
    models: cat.length,
    vendors: new Set(cat.map(function (s) { return s.vendor; })).size,
    ports: 0,
    uncabliable: [],     // ethernet port with no legal medium at all
    opticalMissing: [],   // description claims optics, ports are all copper
    expandFailed: [],
    duplicates: dups.dups,
    crossBrandTwins: dups.twins
  };

  for (const spec of cat) {
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
      if (OPTICAL_CAGES.indexOf(hw.cage) !== -1) optical++;
    }

    // Only flag when the prose promises optics the ports cannot deliver.
    // A description that explicitly denies optics ("no SFP cages", "SFP: none")
    // is correct documentation, not a defect - read the negation.
    const desc = String(spec.description || '');
    const withoutDenials = desc
      .replace(/\b(no|without|zero|none|not)\b[^.;,]{0,24}\b(sfp|qsfp|xfp)\b/gi, ' ')
      .replace(/\b(sfp|qsfp|xfp)\b[^.;,]{0,16}\b(none|n\/a|-)\b/gi, ' ');
    if (/\b(sfp|qsfp|xfp)\b/i.test(withoutDenials) && optical === 0) {
      report.opticalMissing.push({ model: spec.vendor + '/' + spec.model, ports: ifaces.length });
    }
  }

  if (asJson) { console.log(JSON.stringify(report, null, 2)); return 0; }

  console.log('Models: ' + report.models + ' across ' + report.vendors + ' vendors');
  console.log('Ports:  ' + report.ports);
  console.log('Uncablable ethernet ports: ' + report.uncabliable.length);
  for (const u of report.uncabliable.slice(0, 10)) console.log('   - ' + u.model + ' ' + u.port + ' (cage ' + u.cage + ')');
  console.log('Describe optics but have no optical cage: ' + report.opticalMissing.length);
  for (const o of report.opticalMissing.slice(0, 15)) console.log('   - ' + o.model + ' (' + o.ports + ' ports)');
  if (report.opticalMissing.length > 15) console.log('   ... and ' + (report.opticalMissing.length - 15) + ' more');
  if (report.expandFailed.length) {
    console.log('Failed to expand: ' + report.expandFailed.length);
    for (const f of report.expandFailed.slice(0, 10)) console.log('   - ' + f.model + ': ' + f.error);
  }

  console.log('Same product entered twice (same vendor): ' + report.duplicates.length);
  for (const d of report.duplicates) console.log('   - ' + d.entries.join('  ==  '));
  if (report.crossBrandTwins.length) {
    console.log('Same model under different vendor strings (needs a naming decision): ' + report.crossBrandTwins.length);
    for (const t of report.crossBrandTwins) console.log('   ? ' + t.entries.join('  ~  '));
  }

  const bad = report.uncabliable.length + report.expandFailed.length + report.duplicates.length;
  console.log('\n' + (bad ? bad + ' hard defect(s)' : 'No hard defects.'));
  return bad ? 1 : 0;
}

process.exit(main());
