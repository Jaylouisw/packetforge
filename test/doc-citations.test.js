'use strict';
// A citation that names a call site is not a stale citation.
//
// `check-doc-citations.js` judges every `file.js:NNN` against the line where the symbol it names is
// *defined*. `docs/BGP-POLICY.md` cites `test/bgp.test.js:452` while naming `mkPath()` - and line 452
// is the line that *calls* `mkPath()`, which is defined at line 49. The checker therefore reported a
// correct citation as "403 lines from mkPath() at line 49" on every run, so the one remaining suspect
// was permanent and `--strict` could never be turned on. A doc that points at a call site is pointing
// at real code; the position is right even though the symbol lives elsewhere.
const fs = require('fs');
const path = require('path');
const citations = require('../scripts/check-doc-citations.js');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

// A file whose one definition sits at `defLine`, optionally with a call at `callLine`. The citation in
// every case names `computePath()`; `engine/cli.js` is only there to be a path the resolver recognises.
const TARGET = 'engine/cli.js';
function source(defLine, callLine, total) {
  const lines = [];
  for (let i = 1; i <= total; i++) lines.push('// nothing here');
  lines[defLine - 1] = 'function computePath(over) {';
  if (callLine) lines[callLine - 1] = '  ok(computePath({ med: 900 }) > 0, \'MED outranks\');';
  return lines.join('\n');
}
function judge(line, text) {
  return citations.judgeLine(line, function () { return text; });
}

console.log('');
console.log('A citation that lands on a call site is judged correct, however far the definition is:');
{
  const v = judge('| `engine/cli.js:600` `computePath()` | MED 900 |', source(10, 600, 700));
  ok(v && v.ok === true, 'a call at the cited line is accepted', JSON.stringify(v));
  ok(v && v.callSite === true, 'and it is recorded as a call site', JSON.stringify(v && v.callSite));
  ok(v && v.distance === 0, 'so no drift is reported', String(v && v.distance));
}

console.log('\nA line that does not call the symbol is still judged against the definition:');
{
  const far = judge('| `engine/cli.js:600` `computePath()` |', source(10, null, 700));
  ok(far && far.ok === false, '600 is a suspect when computePath() is defined at 10', JSON.stringify(far));
  ok(far && far.distance === 590, 'and the distance is the definition\'s', String(far && far.distance));
  const near = judge('| `engine/cli.js:30` `computePath()` |', source(10, null, 700));
  ok(near && near.ok === true, 'inside the allowed drift it is accepted', JSON.stringify(near));
  const atDef = judge('| `engine/cli.js:10` `computePath()` |', source(10, null, 700));
  ok(atDef && atDef.ok === true, 'and the definition line itself is accepted', JSON.stringify(atDef));
  ok(!judge('no citation here', source(10, null, 700)), 'a line with no citation is not judged at all');
}

console.log('\nThe citation that was reported every run is accepted, against the real file:');
{
  const doc = fs.readFileSync(path.join(__dirname, '..', 'docs', 'BGP-POLICY.md'), 'utf8').split('\n');
  const line = doc.filter(function (l) { return l.indexOf('test/bgp.test.js:452') !== -1; })[0];
  ok(!!line, 'docs/BGP-POLICY.md still cites test/bgp.test.js:452');
  const v = citations.judgeLine(line, function (p) { return fs.readFileSync(p, 'utf8'); });
  ok(v && v.ok === true, 'and the citation is not a suspect', JSON.stringify(v));
  ok(v && v.sym === 'mkPath', 'because the cited line calls mkPath()', String(v && v.sym));
}

console.log('\nThe plan document\'s engine coordinates land on the code they name:');
{
  // docs/BGP-POLICY.md's anchor table names a file:line for each piece of the console it means to change.
  // Code grows above those lines, so the numbers rot silently - three of the nine rows had drifted far
  // enough to land in a *different* command's block, which is worse than no pointer (#2542). Each row is
  // checked against the line it now cites: the cited line has to hold the thing the row describes.
  const doc = fs.readFileSync(path.join(__dirname, '..', 'docs', 'BGP-POLICY.md'), 'utf8').split('\n');
  const engine = fs.readFileSync(path.join(__dirname, '..', 'engine', 'cli.js'), 'utf8').split('\n');
  function row(describes) {
    return doc.filter(function (l) { return l.indexOf(describes) !== -1 && l.indexOf('cli.js:') !== -1; })[0] || '';
  }
  function cite(line) {
    const m = /cli\.js:(\d+)(?:-(\d+))?/.exec(line);
    return m ? { a: Number(m[1]), b: Number(m[2] || m[1]) } : null;
  }
  const cases = [
    ['config-mode BGP dispatch', "head === 'router' && tokens[1] === 'bgp'"],
    ['_bgp(tokens)', '_bgp(tokens) {'],
    ['this._dnsZone', 'this._dnsZone = z.name'],
    ['_help()', '_help() {']
  ];
  for (const c of cases) {
    const line = row(c[0]);
    ok(!!line, 'the table still has a row for ' + c[0], line);
    const cited = cite(line);
    ok(!!cited, 'and that row cites engine/cli.js', line);
    if (!cited) continue;
    ok((engine[cited.a - 1] || '').indexOf(c[1]) !== -1,
      'the line it cites (' + cited.a + ') holds ' + c[1], String(engine[cited.a - 1]));
  }
  // A range row must bracket the block it describes, not stop in the middle of it.
  const dispatch = cite(row('config-mode BGP dispatch'));
  ok(!!dispatch && (engine[dispatch.a - 1] || '').indexOf("head === 'router'") !== -1,
    'the dispatch range starts at the router bgp branch', JSON.stringify(dispatch));
  ok(!!dispatch && (engine[dispatch.b - 1] || '').indexOf('this._bgp(tokens.slice(1))') !== -1,
    'and ends on the bgp branch that dispatches to _bgp()', dispatch && String(engine[dispatch.b - 1]));
}

console.log('\nA citation the code moved away from is a suspect, and these two pages hold none:');
{
  const read = function (p) { return fs.readFileSync(p, 'utf8'); };
  const suspects = [];
  for (const name of ['BGP-POLICY.md', 'CLI.md']) {
    const lines = fs.readFileSync(path.join(__dirname, '..', 'docs', name), 'utf8').split('\n');
    lines.forEach(function (l, i) {
      const v = citations.judgeLine(l, read);
      if (v && v.ok === false) suspects.push(name + ':' + (i + 1) + ' ' + JSON.stringify(v));
    });
  }
  ok(suspects.length === 0, 'every judged citation in the two pages resolves', suspects.join(' | '));
}


console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
