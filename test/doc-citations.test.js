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

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
