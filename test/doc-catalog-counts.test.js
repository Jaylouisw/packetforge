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
const { loadCatalog, effectiveInterfaces } = require(path.join(__dirname, '..', 'devices', 'registry.js'));
// The same shape rule the sweep in test/faceplate-catalogue.test.js uses, so "distinct port shapes"
// means one thing in the page, in that test's printed line, and here.
const { shapeOf } = require(path.join(__dirname, '..', 'scripts', 'catalogue-shapes.js'));
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
let sockets = 0;
const shapes = new Set();
for (const s of real) { sockets += effectiveInterfaces(s).length; shapes.add(shapeOf(s)); }
const counts = { total: real.length, vendors: realVendors.size, byVendor: byVendor, byCategory: byCategory,
  sockets: sockets, shapes: shapes.size };
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

// README and docs/CONNECTORS.md state the same totals, and neither was written by anything. Both went
// stale on 2026-11-16: two device pull requests landed, only the registry page was regenerated, and the
// front page spent the rest of the day claiming 4 fewer models and 164 fewer sockets than the catalogue
// held. A number a reader trusts has to be a number something checks.
console.log('\nREADME states the same sentence the registry page does:');
const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
const rStated = /\*\*([\d,]+) models across ([\d,]+) vendors\*\*/.exec(readme);
ok(!!rStated, 'the sentence is still on the page');
ok(rStated ? Number(rStated[1].replace(/,/g, '')) === real.length : false,
  'README models match the directory (' + real.length + ')',
  'README says ' + (rStated ? rStated[1] : 'nothing'));
ok(rStated ? Number(rStated[2].replace(/,/g, '')) === realVendors.size : false,
  'README vendors match the directory (' + realVendors.size + ')',
  'README says ' + (rStated ? rStated[2] : 'nothing'));

console.log('\nCONNECTORS states the model count, the socket count and the shape count:');
const connectors = fs.readFileSync(path.join(ROOT, 'docs', 'CONNECTORS.md'), 'utf8');
const cProse = /\*\*([\d,]+) models built from ([\d,]+) distinct\s+port shapes\*\*/.exec(connectors);
ok(!!cProse, 'the prose sentence is still on the page');
ok(cProse ? Number(cProse[1].replace(/,/g, '')) === real.length : false,
  'the prose model count matches (' + real.length + ')', cProse ? cProse[1] : 'nothing');
ok(cProse ? Number(cProse[2].replace(/,/g, '')) === shapes.size : false,
  'the prose shape count matches (' + shapes.size + ')', cProse ? cProse[2] : 'nothing');
// This block is pasted output: test/faceplate-catalogue.test.js prints exactly this line, so a stale
// paste is a page quoting a number the suite no longer prints.
const cBlock = /\(([\d,]+) models, ([\d,]+) sockets, ([\d,]+) distinct port shapes\)/.exec(connectors);
ok(!!cBlock, 'the pasted test output is still on the page');
ok(cBlock ? Number(cBlock[1].replace(/,/g, '')) === real.length : false,
  'the pasted model count matches (' + real.length + ')', cBlock ? cBlock[1] : 'nothing');
ok(cBlock ? Number(cBlock[2].replace(/,/g, '')) === sockets : false,
  'the pasted socket count matches (' + sockets + ')', cBlock ? cBlock[2] : 'nothing');
ok(cBlock ? Number(cBlock[3].replace(/,/g, '')) === shapes.size : false,
  'the pasted shape count matches (' + shapes.size + ')', cBlock ? cBlock[3] : 'nothing');

console.log('\nEvery page that states a total is what the generator would write:');
const regen = require(path.join(__dirname, '..', 'scripts', 'regen-registry-doc.js'));
for (const page of regen.PAGES) {
  const before = fs.readFileSync(page.path, 'utf8');
  const out = page.rewrite(before, counts);
  ok(out.changes.length === 0, page.file + ' is current', out.changes.join('; '));
}
{
  // And the gate bites: a page with a plausible-looking wrong number is reported and repaired, on both
  // kinds of page, without reflowing either.
  const staleReadme = readme.replace(/\*\*[\d,]+ models across [\d,]+ vendors\*\*/,
    '**2,210 models across 252 vendors**');
  const fixedReadme = regen.rewriteReadme(staleReadme, counts);
  ok(fixedReadme.changes.length === 1, 'a stale README is noticed (' + fixedReadme.changes[0] + ')');
  ok(fixedReadme.doc.split('\n').length === staleReadme.split('\n').length,
    'and repaired in place, without adding a line');

  const staleConn = connectors
    .replace(/\(([\d,]+) models, ([\d,]+) sockets, ([\d,]+) distinct port shapes\)/,
      '(2210 models, 25016 sockets, 867 distinct port shapes)');
  const fixedConn = regen.rewriteConnectors(staleConn, counts);
  ok(fixedConn.changes.length === 1, 'a stale pasted block is noticed (' + fixedConn.changes[0] + ')');
  ok(fixedConn.doc.split('\n').length === staleConn.split('\n').length,
    'and repaired in place, without reflowing the paragraph');
}

// docs/BUG_REPORTS.md says what the app puts into a bug report, and its catalogue-size row states the
// size of the tree so a reader can interpret "no devices in the palette" at 0 models. It sat outside
// every writer and every test: when #1681 swept the current counts to 2,357 this row kept saying 2,358
// (#1690). A page quoting a number is a promise that the number is checked.
console.log('\nBUG_REPORTS states the catalogue size the report stamps:');
const bugReports = fs.readFileSync(path.join(ROOT, 'docs', 'BUG_REPORTS.md'), 'utf8');
const brRow = /(\| Catalogue size \|[^\n]*?at 0 models than at )([\d,]+)( \|)/.exec(bugReports);
ok(!!brRow, 'the catalogue size row is still on the page');
ok(brRow ? Number(brRow[2].replace(/,/g, '')) === real.length : false,
  'the row matches the directory (' + real.length + ')', 'page says ' + (brRow ? brRow[2] : 'nothing'));
{
  // And the writer it is now in PAGES with can repair it, on that row and nowhere else.
  const staleBug = bugReports.replace(/at 0 models than at ([\d,]+)/, 'at 0 models than at 2,358');
  const fixedBug = regen.rewriteBugReports(staleBug, counts);
  ok(fixedBug.changes.length === 1, 'a stale row is noticed (' + fixedBug.changes[0] + ')');
  ok(fixedBug.doc.indexOf('at 0 models than at ' + counts.total.toLocaleString('en-US')) !== -1,
    'and rewritten to the count printed from the catalogue');
  ok(fixedBug.doc.split('\n').length === staleBug.split('\n').length,
    'without adding or removing a line');
}

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.error('\n' + failed + ' doc-catalog-counts check(s) failed'); process.exit(1); }
console.log('\n' + passed + ' doc-catalog-counts checks passed.');
