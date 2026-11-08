'use strict';
// Apply researched port layouts to existing specs, with a dry run by default.
//
// The research format is deliberately dumb: a list of devices, each with a list of ports and
// the connector/speed/speedCaps a datasheet gives for them. This tool refuses to invent:
//
//   - a port named in the research must already exist in the spec (no new ports)
//   - the device must resolve to exactly one spec (an ambiguous model name is an error, not
//     a coin toss)
//   - only connector / speed / speedCaps / cage are written; everything else in the spec is
//     copied through untouched
//
// Usage:
//   node scripts/apply-port-layouts.js research/incoming/issue9-adc.json [...]
//   node scripts/apply-port-layouts.js --apply research/incoming/issue9-*.json
const fs = require('fs');
const path = require('path');
const { loadCatalog } = require('../devices/registry');

const ROOT = path.join(__dirname, '..');
const DEVICES = path.join(ROOT, 'devices');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const files = args.filter(function (a) { return !a.startsWith('--'); });

if (!files.length) {
  console.error('usage: node scripts/apply-port-layouts.js [--apply] <research.json> [...]');
  process.exit(2);
}

// Which fields a researched layout is allowed to set. Anything else in the record is
// metadata for a human, not something to write into the catalogue.
const WRITABLE = ['connector', 'cage', 'speed', 'speedCaps', 'notes'];

function specPathFor(spec) {
  if (spec && spec.__path) return spec.__path;
  // The registry does not keep the path, so rebuild it from vendor + model the same way the
  // loader lays it out: devices/<vendor>/<file>.json.
  const vendorDir = path.join(DEVICES, String(spec.vendor));
  if (!fs.existsSync(vendorDir)) return null;
  for (const f of fs.readdirSync(vendorDir)) {
    if (!f.endsWith('.json')) continue;
    const p = path.join(vendorDir, f);
    try {
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (String(j.model) === String(spec.model)) return p;
    } catch (e) { /* a broken file is the invariants' problem, not ours */ }
  }
  return null;
}

const catalog = loadCatalog(DEVICES);
let changed = 0, unchanged = 0, skipped = 0;
const problems = [];

for (const file of files) {
  const abs = path.isAbsolute(file) ? file : path.join(ROOT, file);
  if (!fs.existsSync(abs)) {
    problems.push({ file: file, why: 'research file not found' });
    continue;
  }
  let records;
  try {
    const j = JSON.parse(fs.readFileSync(abs, 'utf8'));
    // Two shapes arrive from research lanes: a bare array / {devices: []}, and the
    // verdict form {corrections: [], verification: []} where only corrections are edits.
    records = Array.isArray(j) ? j
      : (Array.isArray(j.devices) ? j.devices
      : (Array.isArray(j.corrections) ? j.corrections : []));
  } catch (e) {
    problems.push({ file: file, why: 'not valid JSON: ' + e.message });
    continue;
  }
  if (!records.length) {
    problems.push({ file: file, why: 'no device records (expected an array or {devices: []})' });
    continue;
  }

  console.log('\n' + path.basename(file) + ': ' + records.length + ' device(s)');

  for (const rec of records) {
    const matches = catalog.filter(function (s) {
      return String(s.vendor).toLowerCase() === String(rec.vendor).toLowerCase() &&
             String(s.model).toLowerCase() === String(rec.model).toLowerCase();
    });
    if (matches.length !== 1) {
      problems.push({
        device: rec.vendor + '/' + rec.model,
        why: matches.length ? matches.length + ' specs share that vendor+model (ambiguous)' : 'no spec carries that vendor+model'
      });
      skipped++;
      continue;
    }

    const specPath = specPathFor(matches[0]);
    if (!specPath) {
      problems.push({ device: rec.vendor + '/' + rec.model, why: 'spec file not found on disk' });
      skipped++;
      continue;
    }

    const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
    const ifaces = Array.isArray(spec.interfaces) ? spec.interfaces : [];
    const byName = {};
    for (const i of ifaces) byName[String(i.name)] = i;

    const edits = [];
    for (const want of (rec.ports || [])) {
      const iface = byName[String(want.name)];
      if (!iface) {
        problems.push({
          device: rec.vendor + '/' + rec.model,
          why: 'port ' + want.name + ' does not exist in the spec (a layout may not add ports)'
        });
        continue;
      }
      const delta = {};
      for (const k of WRITABLE) {
        if (want[k] === undefined) continue;
        const before = JSON.stringify(iface[k]);
        const after = JSON.stringify(want[k]);
        if (before !== after) { delta[k] = { from: iface[k], to: want[k] }; }
      }
      if (Object.keys(delta).length) {
        edits.push({ port: want.name, delta: delta, iface: iface, want: want });
      }
    }

    if (!edits.length) {
      unchanged++;
      console.log('  = ' + rec.vendor + '/' + rec.model + ' — already matches');
      continue;
    }

    console.log('  ' + (APPLY ? '*' : '~') + ' ' + rec.vendor + '/' + rec.model + ' (' +
      path.relative(ROOT, specPath) + ')');
    for (const e of edits) {
      const parts = Object.keys(e.delta).map(function (k) {
        return k + ': ' + JSON.stringify(e.delta[k].from) + ' → ' + JSON.stringify(e.delta[k].to);
      });
      console.log('      ' + e.port + '  ' + parts.join(', '));
      for (const k of Object.keys(e.want)) {
        if (WRITABLE.indexOf(k) !== -1) e.iface[k] = e.want[k];
      }
    }
    changed++;

    if (APPLY) {
      fs.writeFileSync(specPath, JSON.stringify(spec, null, 2) + '\n', 'utf8');
    }
  }
}

console.log('\n' + (APPLY ? 'Applied' : 'Would change') + ': ' + changed +
  ' device(s); already correct: ' + unchanged + '; skipped: ' + skipped);
if (problems.length) {
  console.log('\nProblems (' + problems.length + '):');
  for (const p of problems) {
    console.log('  - ' + (p.device ? p.device + ': ' : p.file + ': ') + p.why);
  }
}
if (!APPLY && changed) {
  console.log('\nDry run. Re-run with --apply to write these.');
}
process.exit(problems.length ? 1 : 0);
