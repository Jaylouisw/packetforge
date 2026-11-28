#!/usr/bin/env node
/**
 * Rewrite the catalogue totals in the pages that state them, from the catalogue.
 *
 * Three pages in this tree claim how big the catalogue is, and until now only one of them was written
 * by this script:
 *
 *   docs/DEVICE_REGISTRY.md   "**N models across M vendors**" plus the largest-vendor/category table
 *   README.md                 the same sentence, in the vendors row of the feature table
 *   docs/CONNECTORS.md        "**N models built from S distinct port shapes**", and the pasted
 *                             output of `test/faceplate-catalogue.test.js` underneath it
 *   docs/wiki/Home.md         "**N device models from M vendors**"
 *   scripts/build-wiki.js     the template that page is built from, which carries the same sentence
 *   docs/BUG_REPORTS.md       the catalogue-size row of the table saying what the bug report fills in
 *
 * The hand-typed copies went stale within hours of each other on 2026-11-16: the registry page was
 * regenerated to 2,214 models while README, CONNECTORS and the wiki still said 2,210 / 25,016 sockets
 * / 867 shapes, because two device pull requests had landed in between and only ran the generator - and
 * a later repair had to touch four pages and a template by hand to catch up. That is
 * the same failure the registry page had before it got a writer: prose about a directory, corrected by
 * hand, drifts faster than anyone reads it. So every page that states the number is written here, once,
 * and `--check` reports all of them:
 *
 *   node scripts/regen-registry-doc.js           # rewrite the pages
 *   node scripts/regen-registry-doc.js --check   # exit 1 if any page is stale, write nothing
 *
 * The label-to-key rule is exported, because the test asserting the table has to use the same one -
 * two copies of "what does this row mean" is how the `point-to-point` row stopped being checked at
 * all (its label resolves to `ptp` in the catalogue, not to `point-to-point`, so the test looked up a
 * category that does not exist, found zero models, and skipped the row). The port-shape rule lives in
 * `scripts/catalogue-shapes.js` for the same reason: the sweep in `test/faceplate-catalogue.test.js`
 * and the `--check` here must count the same thing, or the pasted block is always wrong.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DOC = path.join(ROOT, 'docs', 'DEVICE_REGISTRY.md');
const README = path.join(ROOT, 'README.md');
const CONNECTORS = path.join(ROOT, 'docs', 'CONNECTORS.md');
const WIKI_HOME = path.join(ROOT, 'docs', 'wiki', 'Home.md');
// The wiki page is built from a template that lives in the builder itself, so the number a human edits is
// in a .js file. Both are rewritten: the template so the build keeps producing the right page, the page so
// a publish that has not run yet is not quoting yesterday's catalogue.
const WIKI_BUILDER = path.join(ROOT, 'scripts', 'build-wiki.js');
// BUG_REPORTS.md lists what the app puts into a bug report, and its catalogue-size row states how big the
// tree is so a reader knows what "no devices in the palette" means at zero. That row was written by hand
// and drifted on its own: #1681 swept every current count to 2,357 and left this one at 2,358 (#1690).
const BUG_REPORTS = path.join(ROOT, 'docs', 'BUG_REPORTS.md');
// The registry page also states which hardware requests cannot be modelled yet and why. The issue
// threads for those requests cite `docs/DEVICE_REGISTRY.md` section "What is left open, and why" as
// the record - five separate threads did, and the section did not exist, because this page only ever
// wrote catalogue totals. The data lives in JSON so that adding or closing a request is one edit plus a
// regeneration, and the block below is regenerated rather than hand-corrected.
const OPEN_REQUESTS = path.join(ROOT, 'research', 'open-device-requests.json');
const OPEN_START = '<!-- open-requests:start -->';
const OPEN_END = '<!-- open-requests:end -->';

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
  const { loadCatalog, effectiveInterfaces } = require(path.join(ROOT, 'devices', 'registry.js'));
  const { shapeOf } = require(path.join(ROOT, 'scripts', 'catalogue-shapes.js'));
  const specs = loadCatalog(devicesDir || path.join(ROOT, 'devices')).filter(function (s) { return !s.error; });
  const byVendor = {}, byCategory = {};
  const shapes = new Set();
  let sockets = 0;
  for (const s of specs) {
    byVendor[s.vendor] = (byVendor[s.vendor] || 0) + 1;
    byCategory[s.category] = (byCategory[s.category] || 0) + 1;
    sockets += effectiveInterfaces(s).length;
    shapes.add(shapeOf(s));
  }
  return {
    total: specs.length, vendors: Object.keys(byVendor).length,
    sockets: sockets, shapes: shapes.size,
    byVendor, byCategory
  };
}

// What a row should say. Returns null when the row names nothing the catalogue holds, which is a row
// to delete rather than a number to invent.
function expectedCount(label, counts) {
  const key = keyForLabel(label);
  if (counts.byVendor[key] !== undefined) return counts.byVendor[key];
  if (counts.byCategory[key] !== undefined) return counts.byCategory[key];
  return null;
}

// "**N models across M vendors**" - the sentence on the registry page and in README.
function rewriteHeadline(doc, counts) {
  const changes = [];
  const out = doc.replace(/\*\*([\d,]+) models across ([\d,]+) vendors\*\*/, function (m, models, vendors) {
    const next = '**' + fmt(counts.total) + ' models across ' + fmt(counts.vendors) + ' vendors**';
    if (m !== next) changes.push('headline: ' + m + ' -> ' + next);
    return next;
  });
  return { doc: out, changes: changes };
}

function rewriteTables(doc, counts) {
  const changes = [];
  const out = doc.split('\n').map(function (line) {
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

// A table cell must not carry a pipe (it would split the row) or a line break (it would split the table).
const BS_PIPE = String.fromCharCode(92) + '|';
function mdCell(v) {
  return String(v === undefined ? '' : v).split('|').join(BS_PIPE).split(String.fromCharCode(10)).join(' ').trim();
}

// The open-request block, rendered from research/open-device-requests.json. Wrapped in markers so the
// section is replaced in place and never duplicated; a page without the markers gets it appended once.
function renderOpenRequests() {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(OPEN_REQUESTS, 'utf8'));
  } catch (e) {
    return null; // no data file, no section - never write a half-empty table
  }
  const requests = Array.isArray(data.requests) ? data.requests : [];
  const lines = [OPEN_START, '## What is left open, and why', ''];
  // The count is derived, not typed: the sentence said "Seven" for as long as it took two of the
  // seven to be closed by other work, and a page about staleness must not go stale about its own
  // length. Numbers up to ten are spelled out because the page reads as prose.
  const WORDS = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten'];
  const n = requests.length;
  const count = n < WORDS.length ? WORDS[n] : String(n);
  if (n === 0) {
    lines.push('The queue is clear: no device request is open and unbuildable today. The table below');
    lines.push('is generated from `research/open-device-requests.json` and is empty when nothing is');
    lines.push('waiting on a vendor.');
  } else {
    lines.push(count + (n === 1 ? ' hardware request is open' : ' hardware requests are open') +
      ' and cannot be modelled yet.');
    lines.push('Not one of them is blocked on research effort: in every case the vendor publishes the');
    lines.push('field *type* and not its *value*, and the value is what a spec needs. This table is');
    lines.push('generated from `research/open-device-requests.json` - `npm run regen:registry-doc` after');
    lines.push('editing it, and the issue threads stay the place where each one is argued. Every row');
    lines.push('below carries the `blocked-on-build` label on its issue, which is what stops');
    lines.push('`node scripts/request-queue.js` from counting it ready.');
    lines.push('');
    lines.push('| issue | model(s) | the field the vendor does not publish | what would unblock it |');
    lines.push('|---:|---|---|---|');
    for (const r of requests) {
      const cells = [String(r.issue), r.models, r.missing, r.unblock].map(mdCell);
      lines.push('| ' + cells.join(' | ') + ' |');
    }
  }
  if (requests.length) {
    lines.push('');
    lines.push('Sources last read for each, so the next pass starts from the end of this one rather than');
    lines.push('from the beginning:');
    lines.push('');
    for (const r of requests) {
      const urls = (r.sources || []).map(function (u) { return '<' + u + '>'; }).join(', ');
      lines.push('- **#' + r.issue + '** (' + (r.checked || 'date not recorded') + ') - ' + urls);
    }
  }
  lines.push(OPEN_END);
  return lines.join(String.fromCharCode(10));
}

function rewriteOpenRequests(doc) {
  const block = renderOpenRequests();
  if (block === null) return { doc: doc, changes: [] };
  const start = doc.indexOf(OPEN_START);
  const end = doc.indexOf(OPEN_END);
  if (start !== -1 && end !== -1 && end > start) {
    const current = doc.slice(start, end + OPEN_END.length);
    if (current === block) return { doc: doc, changes: [] };
    return { doc: doc.slice(0, start) + block + doc.slice(end + OPEN_END.length),
      changes: ['open requests: section rewritten from research/open-device-requests.json'] };
  }
  // Appended, not inserted: the catalogue-totals prose is the page's natural close and a reader who
  // scrolls past it has finished with the counting rules.
  const NL = String.fromCharCode(10);
  const tail = doc.slice(-1) === NL ? doc : doc + NL;
  return { doc: tail + NL + block + NL,
    changes: ['open requests: section added from research/open-device-requests.json'] };
}

// The registry page: the headline sentence, the table, and the open-request block.
function rewrite(doc, counts) {
  const head = rewriteHeadline(doc, counts);
  const table = rewriteTables(head.doc, counts);
  const open = rewriteOpenRequests(table.doc);
  return { doc: open.doc, changes: head.changes.concat(table.changes, open.changes) };
}

// README states the same sentence; its other tables are not catalogue counts, so only the sentence is
// touched.
function rewriteReadme(doc, counts) {
  return rewriteHeadline(doc, counts);
}

// CONNECTORS states the model count and shape count in prose, then pastes the line
// `test/faceplate-catalogue.test.js` prints - which carries models, sockets and shapes.
function rewriteConnectors(doc, counts) {
  const changes = [];
  // A caller that only asked for the model counts (a fixture, an older harness) cannot be served the
  // shape sentence: it needs the sweep's numbers, not the directory's. Leave the page alone rather than
  // writing `undefined` into it.
  if (counts.shapes === undefined || counts.sockets === undefined) return { doc: doc, changes: [] };
  // The sentence wraps mid-phrase on the page, so the gap between "distinct" and "port shapes" is
  // matched and put back rather than normalised - rewriting it to a space would join two lines and
  // reflow the paragraph every time this runs.
  let out = doc.replace(/\*\*([\d,]+) models built from ([\d,]+) distinct(\s+)port shapes\*\*/,
    function (m, models, shapes, gap) {
      const next = '**' + fmt(counts.total) + ' models built from ' + fmt(counts.shapes) +
        ' distinct' + gap + 'port shapes**';
      if (m !== next) changes.push('prose: ' + m.replace(/\s+/g, ' ') + ' -> ' + next.replace(/\s+/g, ' '));
      return next;
    });

  out = out.replace(/\(([\d,]+) models, ([\d,]+) sockets, ([\d,]+) distinct port shapes\)/,
    function (m, models, sockets, shapes) {
      const next = '(' + counts.total + ' models, ' + counts.sockets + ' sockets, ' + counts.shapes +
        ' distinct port shapes)';
      if (m !== next) changes.push('pasted output: ' + m + ' -> ' + next);
      return next;
    });

  return { doc: out, changes: changes };
}

// The wiki states it as "**N device models from M vendors**".
function rewriteWiki(doc, counts) {
  const changes = [];
  const out = doc.replace(/\*\*([\d,]+) device models from ([\d,]+) vendors\*\*/,
    function (m, models, vendors) {
      const next = '**' + fmt(counts.total) + ' device models from ' + fmt(counts.vendors) + ' vendors**';
      if (m !== next) changes.push('wiki headline: ' + m + ' -> ' + next);
      return next;
    });
  return { doc: out, changes: changes };
}

// BUG_REPORTS states the size inside a sentence in the third cell of a three-column table, so the row is
// matched whole: the label picks the row, and the count is the one after "at 0 models than at".
function rewriteBugReports(doc, counts) {
  const changes = [];
  const out = doc.replace(/(\| Catalogue size \|[^\n]*?at 0 models than at )([\d,]+)( \|)/,
    function (m, lead, models, tail) {
      const next = lead + fmt(counts.total) + tail;
      if (m !== next) changes.push('catalogue size row: ' + models + ' -> ' + fmt(counts.total));
      return next;
    });
  return { doc: out, changes: changes };
}

const PAGES = [
  { file: 'docs/DEVICE_REGISTRY.md', path: DOC, rewrite: rewrite },
  { file: 'README.md', path: README, rewrite: rewriteReadme },
  { file: 'docs/CONNECTORS.md', path: CONNECTORS, rewrite: rewriteConnectors },
  { file: 'docs/wiki/Home.md', path: WIKI_HOME, rewrite: rewriteWiki },
  { file: 'scripts/build-wiki.js', path: WIKI_BUILDER, rewrite: rewriteWiki },
  { file: 'docs/BUG_REPORTS.md', path: BUG_REPORTS, rewrite: rewriteBugReports }
];

function fmt(n) {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function main(argv) {
  const check = argv.indexOf('--check') !== -1;
  const counts = catalogueCounts();
  let stale = 0, written = 0, pages = 0;

  for (const page of PAGES) {
    const before = fs.readFileSync(page.path, 'utf8');
    const { doc, changes } = page.rewrite(before, counts);
    if (changes.length === 0) continue;
    stale += changes.length;
    pages += 1;
    console.log(page.file + ':');
    for (const c of changes) console.log('  ' + c);
    if (!check) { fs.writeFileSync(page.path, doc); written += changes.length; }
  }

  if (stale === 0) {
    console.log('The catalogue pages are current: ' + fmt(counts.total) + ' models across ' +
      counts.vendors + ' vendors, ' + fmt(counts.sockets) + ' sockets, ' + counts.shapes +
      ' distinct port shapes.');
    return 0;
  }
  if (check) {
    console.error('\n' + stale + ' stale value(s) in ' + pages +
      ' page(s). Run: npm run regen:registry-doc');
    return 1;
  }
  console.log('\nWrote ' + written + ' value(s) across ' + pages + ' page(s): ' + fmt(counts.total) +
    ' models, ' + fmt(counts.sockets) + ' sockets, ' + counts.shapes + ' distinct port shapes.');
  return 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = {
  keyForLabel, catalogueCounts, expectedCount, rewrite, rewriteHeadline, rewriteReadme,
  rewriteConnectors, rewriteWiki, rewriteBugReports, mdCell, renderOpenRequests, rewriteOpenRequests, PAGES, LABEL_ALIASES
};
