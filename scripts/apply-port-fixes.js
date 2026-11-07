'use strict';
// Apply researched port corrections to device specs.
//
// Reads research/incoming/issue9-*.json (the shape the port-research lanes write)
// and rewrites only the connector/speed fields of the named ports. Everything else
// in the spec is left alone: this is a correction tool, not a merge tool, so it must
// never invent ports, drop ports, or touch descriptions.
//
//   node scripts/apply-port-fixes.js            # dry run, shows every change
//   node scripts/apply-port-fixes.js --apply    # write
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const INCOMING = path.join(ROOT, 'research', 'incoming');
const DEVICES = path.join(ROOT, 'devices');
const apply = process.argv.indexOf('--apply') !== -1;

// A connector implies a legal set of rates. Refusing to write a combination the
// hardware cannot carry is the whole point of this project.
const CAGE_CAPS = {
  sfp: [100, 1000],
  'sfp+': [1000, 10000],
  sfp28: [10000, 25000],
  'qsfp+': [10000, 40000],
  qsfp28: [40000, 100000]
};
const SPEED_FOR = { 100: '100M', 1000: '1G', 2500: '2.5G', 5000: '5G', 10000: '10G', 25000: '25G', 40000: '40G', 100000: '100G' };

function findSpecFile(vendor, model) {
  const dir = path.join(DEVICES, vendor);
  if (!fs.existsSync(dir)) return null;
  for (const f of fs.readdirSync(dir)) {
    if (!/\.json$/.test(f)) continue;
    const full = path.join(dir, f);
    let spec;
    try { spec = JSON.parse(fs.readFileSync(full, 'utf8')); } catch (e) { continue; }
    if (spec.model === model) return { file: full, spec: spec };
  }
  return null;
}

const files = fs.existsSync(INCOMING)
  ? fs.readdirSync(INCOMING).filter(function (f) { return /^issue9-.*\.json$/i.test(f); })
  : [];
if (!files.length) { console.log('No issue9-*.json files to apply.'); process.exit(0); }

let changedDevices = 0, changedPorts = 0, problems = [];
const fixedModels = [];

for (const f of files) {
  let data;
  try { data = JSON.parse(fs.readFileSync(path.join(INCOMING, f), 'utf8')); } catch (e) {
    problems.push(f + ': invalid JSON'); continue;
  }
  const entries = data.corrections || (Array.isArray(data) ? data : []);
  for (const e of entries) {
    if (!e || !e.vendor || !e.model) continue;
    const hit = findSpecFile(e.vendor, e.model);
    if (!hit) { problems.push(e.vendor + '/' + e.model + ': spec file not found'); continue; }
    const spec = hit.spec;
    let touched = 0;
    for (const p of (e.ports || [])) {
      const iface = (spec.interfaces || []).find(function (i) { return i.name === p.name; });
      if (!iface) { problems.push(e.model + ': no port named ' + p.name + ' (research may have renamed it)'); continue; }
      const caps = p.speedCaps || CAGE_CAPS[p.connector];
      if (!caps) { problems.push(e.model + '/' + p.name + ': unknown connector ' + p.connector); continue; }
      const speedMbps = Math.max.apply(null, caps);
      iface.type = 'ethernet';
      iface.connector = p.connector;
      iface.speedCaps = caps.slice().sort(function (a, b) { return a - b; });
      iface.speed = SPEED_FOR[speedMbps] || String(speedMbps);
      touched++;
      changedPorts++;
      console.log('  ' + e.vendor + '/' + e.model + ' ' + p.name +
        ' -> ' + p.connector + ' ' + iface.speed + ' [' + iface.speedCaps.join(',') + ']');
    }
    if (touched) {
      changedDevices++;
      fixedModels.push(e.vendor + '/' + e.model);
      if (apply) fs.writeFileSync(hit.file, JSON.stringify(spec, null, 2) + '\n');
    }
  }
}

console.log('\n' + changedDevices + ' device(s), ' + changedPorts + ' port(s)' + (apply ? ' written.' : ' would change.'));
if (problems.length) {
  console.log('Unresolved (' + problems.length + '):');
  for (const p of problems) console.log('  - ' + p);
}
if (!apply) console.log('\nDry run. Re-run with --apply to write.');

// Emit the list so the known-issues file can be pruned deliberately.
if (fixedModels.length) {
  console.log('\nFixed (remove from test/known-issues.json once verified):');
  console.log(fixedModels.join('\n'));
}
