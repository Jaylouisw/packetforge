#!/usr/bin/env node
/**
 * Rewrite the counts in `docs/DEVICE_REGISTRY.md` from the catalogue.
 *
 * The page states "**N models across M vendors**" and carries a small table of the largest vendors and
 * the categories. Those numbers are prose about a directory, so they go stale every time a device
 * lands — and they went stale in a way that is worse than untidy: `test/doc-catalog-counts.test.js`
 * fails on `main` while every open pull request is branched from a commit that predates the drift, so
 * one stale sentence turns the whole merge queue red. Correcting it by hand has gone wrong three
 * documented ways (a title-case label leaving the old number in place, a backreference regex writing
 * `\x01` over the number, and a plausible-looking count nobody printed).
 *
 * So the numbers are computed here, once, from `loadCatalog()`, and written into the page:
 *
 *   node scripts/regen-registry-doc.js           # rewrite the page
 *   node scripts/regen-registry-doc.js --check   # exit 1 if the page is stale, write nothing
 *
 * The label-to-key rule is exported, because the test asserting the page has to use the same one —
 * two copies of "what does this row mean" is how the `point-to-point` row stopped being checked at
 * all (its label resolves to `ptp` in the catalogue, not to `point-to-point`, so the test looked up a
 * category that does not exist, found zero models, and skipped the row).
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DOC = path.join(ROOT, 'docs', 'DEVICE_REGISTRY.md');

// A row's label is written for a reader; the catalogue's key is an identifier. Where the two differ,
// say so here rather than letting the lookup fail quietly.
const LABEL_ALIASES = {
  'point-to-point': 'ptp',
  'l3-switch': 'l3-switch',
  'iot': 'iot'
};

function keyForLabel(label) {
  const base = String(label).toLowerCase().replace(/\s+/g, '-');
  return LABEL_ALIASES[base] || base;
}

function catalogueCounts(devicesDir) {
  // Required lazily so `--check` can run from anywhere without a catalogue on disk in tests.
  const { loadCatalog } = require(path.join(ROOT, 'devices', 'registry.js'));
  const specs = loadCatalog(devicesDir || path.join(ROOT, 'devices')).filter(function (s) { return !s.error; });
  const byVendor = {}, byCategory = {};
  for (const s of specs) {
    byVendor[s.vendor] = (byVendor[s.vendor] || 0) + 1;
    byCategory[s.category] = (byCategory[s.category] || 0) + 1;
  }
  return { total: specs.length, vendors: Object.keys(byVendor).length, byVendor, byCategory };
}

// What a row should say. Returns null when the row names nothing the catalogue holds, which is a row
// to delete rather than a number to invent.
function expectedCount(label, counts) {
  const key = keyForLabel(label);
  if (counts.byVendor[key] !== undefined) return counts.byVendor[key];
  if (counts.byCategory[key] !== undefined) return counts.byCategory[key];
  return null;
}

function rewrite(doc, counts) {
  const changes = [];
  let out = doc.replace(/\*\*([\d,]+) models across ([\d,]+) vendors\*\*/, function (m, models, vendors) {
    const next = '**' + fmt(counts.total) + ' models across ' + fmt(counts.vendors) + ' vendors**';
    if (m !== next) changes.push('headline: ' + m + ' -> ' + next);
    return next;
  });

  out = out.split('\n').map(function (line) {
    if (!/^\|/.test(line)) return line;
    const cells = line.split('|');
    // | vendor | models | | category | models |   -> ["", " vendor ", " models ", " ", " category ", " models ", ""]
    if (cells.length < 7) return line;
    let touched = false;
    for (const pair of [[1, 2], [4, 5]]) {
      const label = (cells[pair[0]] || '').trim();
      const value = (cells[pair[1]] || '').trim();
      if (!label || !/^\d+$/.test(value)) continue;
      const want = expectedCount(label, counts);
      if (want === null || want === Number(value)) continue;
      cells[pair[1]] = ' ' + want + ' ';
      changes.push(label + ': ' + value + ' -> ' + want);
      touched = true;
    }
    if (!touched) return line;
    return cells.map(function (c, i) {
      // keep the original spacing convention: "| a | b | | c | d |"
      if (i === 0 || i === cells.length - 1) return c;
      return c.startsWith(' ') ? c : ' ' + c;
    }).join('|');
  }).join('\n');

  return { doc: out, changes: changes };
}

function fmt(n) {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function main(argv) {
  const check = argv.indexOf('--check') !== -1;
  const counts = catalogueCounts();
  const before = fs.readFileSync(DOC, 'utf8');
  const { doc, changes } = rewrite(before, counts);

  if (changes.length === 0) {
    console.log('docs/DEVICE_REGISTRY.md is current: ' + fmt(counts.total) + ' models across ' +
      counts.vendors + ' vendors.');
    return 0;
  }
  for (const c of changes) console.log('  ' + c);
  if (check) {
    console.error('\ndocs/DEVICE_REGISTRY.md is stale (' + changes.length + ' value(s)). Run: npm run regen:registry-doc');
    return 1;
  }
  fs.writeFileSync(DOC, doc);
  console.log('\nWrote ' + changes.length + ' value(s) to docs/DEVICE_REGISTRY.md.');
  return 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { keyForLabel, catalogueCounts, expectedCount, rewrite, LABEL_ALIASES };
