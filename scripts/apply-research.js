'use strict';
// Apply researched datasheet facts to device specs, with validation.
//
//   node scripts/apply-research.js research/incoming/aruba-poe.json [--dry-run] [--force]
//
// Input is a JSON document of the shape:
//   { "poe":   [ { "vendor": "aruba", "model": "CX 6100 48G ...", "poeBudgetW": 370, "sourceUrl": "..." } ],
//     "ports": [ { "vendor": "aruba", "model": "...", "rj45Count": 48, "sfpCount": 4,
//                  "sfpType": "sfp+", "sfpSpeedsMbps": [10000], "sourceUrl": "..." } ] }
//
// Nothing is written unless it validates. A null budgetW is treated as "researched
// and not found" and is recorded as such rather than silently skipped.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DEVICES = path.join(ROOT, 'devices');

function findSpec(vendor, model) {
  const dir = path.join(DEVICES, String(vendor).toLowerCase());
  if (!fs.existsSync(dir)) return null;
  const want = String(model).toLowerCase().replace(/\s+/g, '');
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    const p = path.join(dir, f);
    let spec;
    try { spec = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { continue; }
    const have = String(spec.model || '').toLowerCase().replace(/\s+/g, '');
    if (have === want && String(spec.vendor || '').toLowerCase() === String(vendor).toLowerCase()) {
      return { path: p, spec: spec };
    }
  }
  return null;
}

function isUrl(s) { return typeof s === 'string' && /^https?:\/\//.test(s); }

const args = process.argv.slice(2);
const file = args.find(function (a) { return !a.startsWith('--'); });
const dryRun = args.indexOf('--dry-run') !== -1;
const force = args.indexOf('--force') !== -1;

if (!file) {
  console.error('usage: node scripts/apply-research.js <file.json> [--dry-run] [--force]');
  process.exit(2);
}

const input = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
let applied = 0, skipped = 0, rejected = 0;
const problems = [];
const report = [];

function reject(what, why) { rejected++; problems.push('REJECTED ' + what + ': ' + why); }

// ---------------------------------------------------------------- PoE budgets
for (const entry of (input.poe || [])) {
  const label = entry.vendor + '/' + entry.model;
  const found = findSpec(entry.vendor, entry.model);
  if (!found) { reject(label, 'no matching device spec'); continue; }
  if (!isUrl(entry.sourceUrl)) { reject(label, 'no source URL - unverifiable'); continue; }

  const w = entry.poeBudgetW;
  if (w !== null && (typeof w !== 'number' || !(w >= 30 && w <= 4000))) {
    reject(label, 'budget ' + JSON.stringify(w) + ' outside a plausible 30-4000 W');
    continue;
  }

  const spec = found.spec;
  const existing = (spec.poe && spec.poe.budgetW) || null;
  if (existing !== null && w !== null && existing !== w && !force) {
    reject(label, 'existing budget ' + existing + ' W differs from researched ' + w +
      ' W (use --force to overwrite)');
    continue;
  }
  if (w === null) {
    spec.poe = Object.assign({}, spec.poe, { budgetW: null, budgetUnknown: true, sourceUrl: entry.sourceUrl });
    report.push('  ~ ' + label + '  budget NOT FOUND (recorded as unknown)');
    skipped++;
  } else {
    spec.poe = Object.assign({}, spec.poe, { budgetW: w, sourceUrl: entry.sourceUrl });
    delete spec.poe.budgetUnknown;
    report.push('  + ' + label + '  ' + w + ' W' + (existing !== null ? ' (was ' + existing + ')' : ''));
    applied++;
  }
  if (!dryRun) fs.writeFileSync(found.path, JSON.stringify(spec, null, 2) + '\n');
}

// --------------------------------------------------------------- port layouts
for (const entry of (input.ports || [])) {
  const label = entry.vendor + '/' + entry.model;
  const found = findSpec(entry.vendor, entry.model);
  if (!found) { reject(label, 'no matching device spec'); continue; }
  if (!isUrl(entry.sourceUrl)) { reject(label, 'no source URL - unverifiable'); continue; }

  const rj45 = entry.rj45Count, sfp = entry.sfpCount, type = entry.sfpType;
  if (typeof rj45 !== 'number' || typeof sfp !== 'number') {
    reject(label, 'rj45Count/sfpCount must be numbers');
    continue;
  }
  if (!type) { reject(label, 'sfpType missing'); continue; }
  if (![ 'sfp', 'sfp+', 'sfp28', 'qsfp+', 'qsfp28' ].includes(String(type).toLowerCase())) {
    reject(label, 'sfpType ' + JSON.stringify(type) + ' is not a known cage');
    continue;
  }

  const spec = found.spec;
  const ifaces = Array.isArray(spec.interfaces) ? spec.interfaces : [];
  if (ifaces.length !== rj45 + sfp) {
    reject(label, 'spec has ' + ifaces.length + ' interfaces but research says ' +
      rj45 + ' rj45 + ' + sfp + ' sfp = ' + (rj45 + sfp));
    continue;
  }

  const speeds = Array.isArray(entry.sfpSpeedsMbps) && entry.sfpSpeedsMbps.length
    ? entry.sfpSpeedsMbps : null;

  // The trailing `sfp` interfaces are the cages; everything before is copper.
  for (let i = 0; i < ifaces.length; i++) {
    const isSfp = i >= rj45;
    if (isSfp) {
      ifaces[i].connector = String(type).toLowerCase();
      const mbps = speeds ? speeds[Math.min(i - rj45, speeds.length - 1)] : null;
      if (mbps) {
        ifaces[i].speed = mbps >= 1000 ? (mbps / 1000) + 'G' : mbps + 'M';
        ifaces[i].speedCaps = [mbps];
      }
    } else {
      delete ifaces[i].connector;
    }
  }
  if (entry.sfpSharedWithRj45 === true) spec.comboPorts = sfp;
  report.push('  + ' + label + '  ' + rj45 + 'x rj45 + ' + sfp + 'x ' + type +
    (entry.sfpSharedWithRj45 === true ? ' (combo/shared)' : ''));
  applied++;
  if (!dryRun) fs.writeFileSync(found.path, JSON.stringify(spec, null, 2) + '\n');
}

console.log((dryRun ? '[dry run] ' : '') + 'Applied ' + applied + ', ' +
  'recorded unknown ' + skipped + ', rejected ' + rejected);
if (report.length) console.log(report.join('\n'));
if (problems.length) { console.log(''); console.log(problems.join('\n')); }
process.exit(rejected ? 1 : 0);
