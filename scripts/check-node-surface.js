#!/usr/bin/env node
/**
 * The suite has to pass on Node 18, and the machine running it here is usually newer.
 *
 * CI tests 18, 20 and 22 (see the matrix in .forgejo/workflows/ci.yml). A developer on Node 24 -
 * which is what this repo's own dev machine runs - can use `Array.prototype.toSorted`,
 * `Object.groupBy` or `Promise.withResolvers`, watch a green suite, and push a commit that fails
 * only on the oldest job. The failure then appears twenty minutes later attributed to "Test (Node
 * 18)", which reads like a flaky runner rather than "you used a Node 20 API".
 *
 * This is a static check on purpose: it needs no second Node install, so it runs on every push
 * including the ones that only ever see one interpreter.
 *
 * It reads the files that *run* - `.js`, `.mjs`, `.cjs` and `.ts`/`.mts`/`.cts`, which `node`
 * executes after stripping the types. That last part is not decoration: the repository converts
 * `.js` to `.ts` on touch, so a gate that only read `.js` would lose sight of every file it
 * converted, and the loss would look exactly like a clean run.
 *
 * Usage:
 *   node scripts/check-node-surface.js            # check, exit 1 on findings
 *   node scripts/check-node-surface.js --list     # also print what is allowed and why
 *   node scripts/check-node-surface.js <dir>      # scan <dir> instead of this repository
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SKIP_DIRS = new Set(['node_modules', '.git', 'research', 'examples', 'dist', 'coverage']);
// `.ts` is here because a `.ts` file *runs*: `node` strips the types and executes the rest, so it
// reaches exactly the runtime API surface a `.js` file does - and the files this repository has
// been converting are the ones nobody was checking (`docs/TYPESCRIPT.md`). `.mts` and `.cts` are
// the same two module kinds under the extensions TypeScript gives them; nothing uses them yet,
// they cost one Set entry, and the alternative is discovering the hole the day one lands.
const EXTS = new Set(['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts']);
// Not this gate's business: a declaration file is not executed, so a post-18 API named in one is a
// type *about* a runtime rather than a use of it. `.d.ts` reaches this test through `.ts`.
const DECLARATION = /\.d\.(ts|mts|cts)$/;

// Anything added after Node 18. Each entry: needle, the version it appeared, and the shape to
// suggest instead. Keep the suggestions concrete - the point is to tell a contributor what to type.
const POST_18 = [
  ['Object.groupBy', 'Node 21', 'a reduce() into an object, or a Map'],
  ['Map.groupBy', 'Node 21', 'a reduce() into a Map'],
  ['Array.fromAsync', 'Node 22', 'an async for-loop pushing into an array'],
  ['Promise.withResolvers', 'Node 22', 'new Promise(function (res, rej) { ... }) and keep the pair'],
  ['Promise.try', 'Node 24', 'a Promise.resolve().then(function () { return fn(); })'],
  ['isWellFormed', 'Node 20', 'a try/catch around encodeURIComponent'],
  ['toWellFormed', 'Node 20', 'a manual surrogate pass'],
  ['Error.isError', 'Node 24', 'instanceof Error'],
  ['RegExp.escape', 'Node 24', 'a manual escape of regex metacharacters']
];

// Method names that arrived after 18, matched as `.name(` so a comment cannot trip the check.
const POST_18_METHODS = [
  ['.toSorted(', 'Node 20', '.slice().sort()'],
  ['.toReversed(', 'Node 20', '.slice().reverse()'],
  ['.toSpliced(', 'Node 20', 'a copy plus splice'],
  ['.with(', 'Node 20', 'a copy plus an index assignment'],
  ['.findLast(', 'Node 18', 'allowed - Node 18 has it (kept here to document the boundary)']
];

function walk(dir, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return out; }
  for (const e of entries) {
    if (e.name.startsWith('.') && e.name !== '.') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(full, out);
    } else if (EXTS.has(path.extname(e.name))) {
      if (DECLARATION.test(e.name)) continue;
      out.push(full);
    }
  }
  return out;
}

// A naive substring scan hits comments, docs and this file's own tables. Strip line comments and
// block comments, and skip string literals' contents only where it matters (the needles contain
// no quotes), so a comment explaining an API does not fail the build.
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

function main() {
  const list = process.argv.indexOf('--list') !== -1;
  // An optional positional scans that directory instead of this repository. The suite uses it to
  // point the guard at a fixture outside the tree, and that is not tidiness: CI runs this script
  // *beside* `npm test` in every leg (`ci.yml`, "Full test suite, syntax check and static checks,
  // together"), so a fixture written into the repository to prove the guard can fail is a fixture
  // a concurrent copy of the guard can find - a red leg about a tree nobody edited. A path that is
  // not a directory is an error, never an empty scan that passes.
  const positional = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  let root = ROOT;
  if (positional.length) {
    root = path.resolve(positional[0]);
    let stat;
    try { stat = fs.statSync(root); } catch (e) { stat = null; }
    if (!stat || !stat.isDirectory()) {
      console.error('check-node-surface: not a directory: ' + positional[0]);
      process.exit(2);
    }
  }
  const files = walk(root, []).sort();
  const findings = [];

  for (const file of files) {
    const rel = path.relative(root, file).replace(/\\/g, '/');
    // This script names every banned API in its own tables, so it exempts itself.
    if (rel === 'scripts/check-node-surface.js') continue;
    let src;
    try { src = fs.readFileSync(file, 'utf8'); } catch (e) { continue; }
    const code = stripComments(src);

    for (const [needle, since, instead] of POST_18) {
      if (code.indexOf(needle) === -1) continue;
      findings.push({ file: rel, what: needle, since: since, instead: instead });
    }
    for (const [needle, since, instead] of POST_18_METHODS) {
      if (since === 'Node 18') continue; // documented boundary, not a finding
      if (code.indexOf(needle) === -1) continue;
      findings.push({ file: rel, what: needle, since: since, instead: instead });
    }
  }

  if (list) {
    console.log('APIs newer than the Node 18 floor, and what to use instead:');
    for (const [needle, since, instead] of POST_18) {
      console.log('  ' + needle.padEnd(26) + since.padEnd(10) + instead);
    }
    for (const [needle, since, instead] of POST_18_METHODS) {
      if (since === 'Node 18') continue;
      console.log('  ' + needle.padEnd(26) + since.padEnd(10) + instead);
    }
    console.log('');
  }

  if (findings.length) {
    console.error('Node ' + process.versions.node + ' runs these; Node 18 does not:');
    for (const f of findings) {
      console.error('  ' + f.file + ': ' + f.what + ' (' + f.since + ') - use ' + f.instead);
    }
    console.error('');
    console.error('CI runs the suite on Node 22 and 24; this guard holds the older Node 18');
    console.error('surface on purpose, so a green local run on ' + process.versions.node + ' on the newest');
    console.error('runtime says nothing about the floor. See docs/CI.md.');
    process.exit(1);
  }

  console.log('No API newer than Node 18 in ' + files.length + ' source file(s).');
  process.exit(0);
}

main();
