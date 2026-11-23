'use strict';
// Recursively syntax-check every JavaScript *and TypeScript* file under the project.
// Zero dependencies — `node --check` for `.js`, the runtime's own type stripper for `.ts`.
// Run: node scripts/syntax-check.js
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DIRS = ['engine', 'server', 'devices', 'web', 'scripts', 'examples', 'test'];

// `node --check` cannot parse a `.ts` file: it parses annotations as JavaScript and stops at the
// first one (`SyntaxError: Missing initializer in const declaration` on `const fs: X = require(..)`
// - measured, not assumed). Leaving `.ts` to `tsc` alone used to be the answer, and it was wrong
// for the reason this script exists: a `.ts` file outside `tsconfig.json`'s `include` - a fixture,
// a scratch file, a converted script nobody added - is not parsed by anything at all, and the gate
// that is supposed to catch "the tree does not load" was not looking at the files that now matter.
//
// What can parse a `.ts` file is the runtime's own type stripper: the same pass that loads these
// files. Strip, then parse the result as CommonJS with `vm.Script`, which parses without running.
// Using a second, different parser here would be a second answer to "does this file load", and the
// point of a syntax guard is that there is only one. It catches the erasable-syntax rule too:
// `enum` and `namespace` have nothing to strip and fail to load, and they fail here first
// (ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX) instead of on somebody's first run.
const TS_PARSE = [
  "const fs = require('node:fs');",
  "const vm = require('node:vm');",
  "const { stripTypeScriptTypes } = require('node:module');",
  'const file = process.argv[1];',
  "const stripped = stripTypeScriptTypes(fs.readFileSync(file, 'utf8'), { mode: 'strip' });",
  'new vm.Script(stripped, { filename: file });'
].join('\n');

function isTypeScript(file) {
  // `.mts`/`.cts`/`.tsx` are not in this tree, and `.tsx` would need a JSX pass this has no
  // business pretending to do. A file in one of those spellings is added here when it appears.
  return file.endsWith('.ts');
}

const files = [];
for (const d of DIRS) {
  const dir = path.join(ROOT, d);
  if (!fs.existsSync(dir)) continue;
  (function walk(p) {
    for (const e of fs.readdirSync(p)) {
      const f = path.join(p, e);
      const st = fs.statSync(f);
      if (st.isDirectory()) walk(f);
      else if (f.endsWith('.js') || isTypeScript(f)) files.push(f);
    }
  })(dir);
}

let failed = 0;
let jsFiles = 0;
let tsFiles = 0;
for (const f of files) {
  const ts = isTypeScript(f);
  if (ts) tsFiles++;
  else jsFiles++;
  try {
    // `--no-warnings` on the `.ts` child keeps the stripper's experimental notice out of the log;
    // the parse result is the whole output of that process.
    if (ts) execFileSync(process.execPath, ['--no-warnings', '-e', TS_PARSE, f], { stdio: 'pipe' });
    else execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
  } catch (e) {
    failed++;
    console.error('✗ ' + path.relative(ROOT, f));
    console.error(String(e.stderr || e.message));
  }
}
console.log('Syntax-checked ' + files.length + ' files (' + jsFiles + ' JavaScript, ' + tsFiles +
  ' TypeScript): ' + (failed ? failed + ' failed' : 'all OK'));
process.exit(failed ? 1 : 0);
