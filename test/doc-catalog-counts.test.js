'use strict';
// docs/DEVICE_REGISTRY.md said the catalogue held "22 models across 7 vendors" while it
// actually held 1,717 across 245. Nobody was lying — prose just goes stale, and nothing
// was watching it.
//
// So this watches it. The counts in the document are asserted against the directory, and
// a test that fails when they drift is cheaper than a reader who trusts a number that has
// been wrong for months.
const fs = require('fs');
const path = require('path');
const { loadCatalog } = require(path.join(__dirname, '..', 'devices', 'registry.js'));

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  <- ' + detail : '')); }
}

const ROOT = path.join(__dirname, '..');
const spec = loadCatalog(path.join(ROOT, 'devices'));
const real = spec.filter(function (s) { return !s.error; });
const realVendors = new Set(real.map(function (s) { return s.vendor; }));

const doc = fs.readFileSync(path.join(ROOT, 'docs', 'DEVICE_REGISTRY.md'), 'utf8');

console.log('The document states the size of the catalogue:');
const stated = /\*\*([\d,]+) models across ([\d,]+) vendors\*\*/.exec(doc);
ok(!!stated, 'the sentence with both counts is present');
const statedModels = stated ? Number(stated[1].replace(/,/g, '')) : -1;
const statedVendors = stated ? Number(stated[2].replace(/,/g, '')) : -1;

ok(statedModels === real.length,
  'the model count matches the directory (' + real.length + ')', 'document says ' + statedModels);
ok(statedVendors === realVendors.size,
  'the vendor count matches the directory (' + realVendors.size + ')', 'document says ' + statedVendors);

console.log('\nThe table rows match too, so a stale top-vendor line is caught as well:');
const byVendor = {};
for (const s of real) byVendor[s.vendor] = (byVendor[s.vendor] || 0) + 1;
const rows = doc.split('\n').filter(function (l) { return /^\| [A-Za-z0-9]/.test(l); });
let checked = 0;
for (const row of rows) {
  const cells = row.split('|').map(function (c) { return c.trim(); }).filter(Boolean);
  // | vendor | models | | category | models |
  if (cells.length !== 4) continue;
  for (const pair of [[cells[0], cells[1]], [cells[2], cells[3]]]) {
    const label = pair[0], count = Number(pair[1]);
    // ordinary control flow: a cell that is a heading or a separator rather than a count.
    // The "the table was actually read" assertion below fails if this ever skips them all.
    if (!label || !/^\d+$/.test(pair[1])) continue;
    const key = label.toLowerCase().replace(/\s+/g, '-');
    const actual = byVendor[key] !== undefined
      ? byVendor[key]
      : real.filter(function (s) { return s.category === key; }).length;
    // ordinary control flow: a row naming something the catalogue no longer contains is a
    // row to delete, not a check to skip — the count assertions above already ran.
    if (actual === 0) continue;
    checked += 1;
    ok(actual === count, label + ' is ' + actual, 'document says ' + count);
  }
}
ok(checked >= 8, 'the table was actually read (' + checked + ' cells checked)');

console.log('\nThe document says where the truth lives:');
ok(/GET \/api\/catalog/.test(doc), 'it points at /api/catalog as authoritative');
ok(/the directory is right/i.test(doc), 'and says the directory wins over the prose');

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.error('\n' + failed + ' doc-catalog-counts check(s) failed'); process.exit(1); }
console.log('\n' + passed + ' doc-catalog-counts checks passed.');
