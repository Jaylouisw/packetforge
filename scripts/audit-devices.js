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

function main() {
  const asJson = process.argv.indexOf('--json') !== -1;
  const cat = loadCatalog(path.join(ROOT, 'devices'));

  const report = {
    models: cat.length,
    vendors: new Set(cat.map(function (s) { return s.vendor; })).size,
    ports: 0,
    uncabliable: [],     // ethernet port with no legal medium at all
    opticalMissing: [],   // description claims optics, ports are all copper
    expandFailed: []
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
    const desc = String(spec.description || '');
    if (/\b(sfp|qsfp|xfp)\b/i.test(desc) && optical === 0) {
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

  const bad = report.uncabliable.length + report.expandFailed.length;
  console.log('\n' + (bad ? bad + ' hard defect(s)' : 'No hard defects.'));
  return bad ? 1 : 0;
}

process.exit(main());
