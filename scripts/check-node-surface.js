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
 * Usage:
 *   node scripts/check-node-surface.js            # check, exit 1 on findings
 *   node scripts/check-node-surface.js --list     # also print what is allowed and why
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SKIP_DIRS = new Set(['node_modules', '.git', 'research', 'examples', 'dist', 'coverage']);
const EXTS = new Set(['.js', '.mjs', '.cjs']);

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
  const files = walk(ROOT, []).sort();
  const findings = [];

  for (const file of files) {
    const rel = path.relative(ROOT, file).replace(/\\/g, '/');
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
    console.error('CI tests Node 18/20/22. A green local run on ' + process.versions.node +
      ' does not mean the matrix is green.');
    process.exit(1);
  }

  console.log('No API newer than Node 18 in ' + files.length + ' source file(s).');
  process.exit(0);
}

main();
