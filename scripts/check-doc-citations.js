'use strict';
// Are the documentation's line citations still pointing at what the sentence says they are? (#1481)
//
// docs/*.md cite the implementation constantly — "`_emitFrame` sets `wireTagged`/`wireVid` … `engine/simulator.js:1666-1680`".
// A citation is a claim a reader can go and check, and it rots silently: the code moves, the number stays, and the
// reader lands in an unrelated function. A pointer into the wrong code is worse than no pointer, because it teaches
// the reader that the prose cannot be trusted either.
//
// Measured before this check existed: of 150 citations that name a symbol, 28 pointed more than 40 lines away from
// the code they named — several by nearly a thousand lines, into a different subsystem, because a feature landed
// above them and pushed them down.
//
// The rule here is deliberately narrow, because a wrong accusation is as bad as a missed one:
//   * a sentence must name exactly ONE function, written as a call (`routeTo()`), and give exactly ONE citation;
//   * that function must have exactly ONE definition in the cited file (two definitions means the name is
//     overloaded and a guess would be wrong);
//   * the citation may be up to DRIFT lines away — code underneath a pointer may grow before the pointer matters —
//     and anything further is drift.
// Everything else is skipped and counted, so the coverage is visible rather than implied.
//
// It is a *diagnostic*, not a gate, and that is a deliberate limit: a citation sometimes points at a test body or a
// region rather than at a definition, and a sentence mentioning a helper defined elsewhere is not drift. Judging
// that needs a reader. So the tool lists its suspects — with the distance, the symbol and the line it found — and a
// human decides. Run it after moving code that the docs cite.
//
// Usage: node scripts/check-doc-citations.js [--strict]
//   (default) print suspects and exit 0
//   --strict  exit 1 when a judged citation is further from its symbol than DRIFT lines
const fs = require('fs');
const path = require('path');

const DRIFT = 40;
const ROOT = path.join(__dirname, '..');
const REF = /([A-Za-z0-9_./-]+\.(?:js|json|md|yml|html|css)):(\d+)(?:-(\d+))?/g;
const CALL = /`([A-Za-z_][A-Za-z0-9_]*)\(\)?`/g;
// Words that name a concept, not a symbol. `ping()` is a command, `mode()` is not a function anywhere.
const GENERIC = new Set(('mode limit loop match neighbor static advertise source target length speed type name ' +
  'count index value key list item data state port file line text path time rate size host zone pool table rule ' +
  'link test note spec address packet frame route vlan switch bridge group member policy hash budget power ping ' +
  'trace enable configure interface show no').split(' '));

const byBase = new Map();
(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (!byBase.has(entry.name)) byBase.set(entry.name, []);
    if (!entry.isDirectory()) byBase.get(entry.name).push(full);
  }
})(ROOT);

function resolve(p) {
  for (const c of [path.join(ROOT, p), path.join(ROOT, 'docs', p)]) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  }
  const opts = byBase.get(path.basename(p)) || [];
  return opts.length ? opts[0] : null;
}

function definitionLine(srcLines, sym) {
  const esc = sym.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [
    new RegExp('^\\s*(?:async\\s+)?function\\s+' + esc + '\\s*\\('),
    new RegExp('^\\s*' + esc + '\\s*\\([^)]*\\)\\s*\\{'),
    new RegExp('^\\s*class\\s+' + esc + '\\b'),
    new RegExp('^\\s*(?:const|let|var)\\s+' + esc + '\\s*='),
    new RegExp('^\\s*' + esc + '\\s*[:=]\\s*function')
  ];
  const hits = [];
  for (let i = 0; i < srcLines.length; i++) {
    for (const re of patterns) { if (re.test(srcLines[i])) { hits.push(i + 1); break; } }
  }
  return hits.length === 1 ? hits[0] : 0;
}

function documentationFiles() {
  const docsDir = path.join(ROOT, 'docs');
  return fs.readdirSync(docsDir).filter(function (f) { return /\.md$/.test(f); })
    .map(function (f) { return path.join('docs', f); })
    .concat(['README.md', 'MAINTAINING.md'].filter(function (f) {
      return fs.existsSync(path.join(ROOT, f));
    }));
}

// Judge one line of documentation. Returns null when the line cannot be judged, or { ok, ... }.
function judgeLine(line, readFile) {
  REF.lastIndex = 0;
  const refs = Array.from(line.matchAll(REF));
  if (!refs.length) return null;
  CALL.lastIndex = 0;
  const calls = Array.from(line.matchAll(CALL))
    .map(function (m) { return m[1]; })
    .filter(function (s) { return s.length > 3 && !GENERIC.has(s.toLowerCase()); });
  if (refs.length !== 1 || calls.length !== 1) return null;
  const target = resolve(refs[0][1]);
  if (!target) return null;
  const src = readFile(target).split('\n');
  const def = definitionLine(src, calls[0]);
  if (!def) return null;
  const a = Number(refs[0][2]), b = refs[0][3] ? Number(refs[0][3]) : a;
  const ok = def >= a - DRIFT && def <= b + DRIFT;
  return { ok: ok, sym: calls[0], def: def, cited: refs[0][0], a: a, b: b, distance: Math.abs(def - a) };
}

function run(opts) {
  opts = opts || {};
  const readFile = opts.readFile || function (p) { return fs.readFileSync(p, 'utf8'); };
  const files = opts.files || documentationFiles();
  const drift = [];
  let checked = 0, skipped = 0, total = 0;
  for (const rel of files) {
    const lines = readFile(opts.absolute ? rel : path.join(ROOT, rel)).split('\n');
    for (let i = 0; i < lines.length; i++) {
      REF.lastIndex = 0;
      const here = (lines[i].match(REF) || []).length;
      if (!here) continue;
      total += here;
      const verdict = judgeLine(lines[i], readFile);
      if (!verdict) { skipped++; continue; }
      checked++;
      if (!verdict.ok) drift.push({ doc: rel, line: i + 1, verdict: verdict });
    }
  }
  return { checked: checked, skipped: skipped, drift: drift, references: total };
}

if (require.main === module) {
  const result = run();
  console.log('Citations in docs: ' + result.references + ' — ' + result.checked +
    ' judged against a unique definition, ' + result.skipped + ' lines left to a reader');
  if (!result.drift.length) {
    console.log('No judged citation is more than ' + DRIFT + ' lines from the code it names.');
  } else {
    console.log('Suspects (' + result.drift.length + ', allowed drift ' + DRIFT + ' lines):');
    for (const d of result.drift) {
      console.log('  ' + d.doc + ':' + d.line + '  ' + d.verdict.cited + ' is ' + d.verdict.distance +
        ' lines from ' + d.verdict.sym + '() at line ' + d.verdict.def);
    }
  }
  if (process.argv.includes('--strict') && result.drift.length) process.exit(1);
}

module.exports = { run: run, judgeLine: judgeLine, definitionLine: definitionLine, DRIFT: DRIFT };
