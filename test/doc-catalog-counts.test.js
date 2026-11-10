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
// One rule for "what does this row mean", shared with the writer, so a label the writer can resolve
// cannot be silently skipped by the reader. This is how the point-to-point row stopped being checked:
// its label resolves to `ptp`, the lookup asked for `point-to-point`, found nothing, and skipped.
const { expectedCount } = require(path.join(__dirname, '..', 'scripts', 'regen-registry-doc.js'));

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  <- ' + detail : '')); }
}

const ROOT = path.join(__dirname, '..');
const spec = loadCatalog(path.join(ROOT, 'devices'));
const real = spec.filter(function (s) { return !s.error; });
const realVendors = new Set(real.map(function (s) { return s.vendor; }));

const byVendor = {}, byCategory = {};
for (const s of real) {
  byVendor[s.vendor] = (byVendor[s.vendor] || 0) + 1;
  byCategory[s.category] = (byCategory[s.category] || 0) + 1;
}
const counts = { total: real.length, vendors: realVendors.size, byVendor: byVendor, byCategory: byCategory };
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
    const actual = expectedCount(label, counts);
    if (actual === null) {
      // A row naming something the catalogue does not contain is a row to delete. It used to be
      // skipped, which is how a stale number on a row nobody could resolve sat here unread.
      failed += 1;
      console.error('  ✗ ' + label + ' names nothing in the catalogue  <- row says ' + count +
        ', delete the row or fix its label');
      continue;
    }
    checked += 1;
    ok(actual === count, label + ' is ' + actual, 'document says ' + count);
  }
}
ok(checked >= 8, 'the table was actually read (' + checked + ' cells checked)');

console.log('\nThe document says where the truth lives:');
ok(/GET \/api\/catalog/.test(doc), 'it points at /api/catalog as authoritative');
ok(/the directory is right/i.test(doc), 'and says the directory wins over the prose');

  console.log('\nThe page is what the generator would write:');
const { rewrite } = require(path.join(__dirname, '..', 'scripts', 'regen-registry-doc.js'));
const regenerated = rewrite(doc, counts);
ok(regenerated.changes.length === 0,
  'regen-registry-doc.js has nothing to change', regenerated.changes.join('; '));
{
  // A writer that agrees with a current page proves nothing about whether it can fix a stale one.
  const stale = doc.replace(/\*\*[\d,]+ models across [\d,]+ vendors\*\*/, '**2,015 models across 245 vendors**');
  const fixed = rewrite(stale, counts);
  ok(fixed.changes.length > 0, 'a stale headline is noticed (' + fixed.changes[0] + ')');
  ok(fixed.doc.indexOf('**' + counts.total.toLocaleString('en-US') + ' models across ' + counts.vendors + ' vendors**') !== -1,
    'and rewritten to the counts printed from the catalogue');
  ok(fixed.doc.split('\n').length === stale.split('\n').length,
    'without adding or removing a line (a count page acquires stray characters when it is rebuilt by regex)');
}

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.error('\n' + failed + ' doc-catalog-counts check(s) failed'); process.exit(1); }
console.log('\n' + passed + ' doc-catalog-counts checks passed.');
