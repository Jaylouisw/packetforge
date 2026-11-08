'use strict';
// run-tests.js -- aggregate test runner.
//
// Runs every test/*.test.js in its own Node process and reports every failure,
// unlike a shell `&&` chain that stops at the first red file and hides the rest.
// This is the single source of truth for "did the suite pass", shared by `npm test`
// locally and the CI workflow -- so a test file added under test/ can never drift
// off a hand-maintained list again.
//
// Usage:
//   node scripts/run-tests.js                 run every test/*.test.js
//   node scripts/run-tests.js --filter vlan   run files whose name contains "vlan"
//   node scripts/run-tests.js --verbose       print every file's output, not just failures
//   node scripts/run-tests.js --list          list the files that would run
//
// Exit: 0 = all passed, 1 = at least one failed (CI gate).

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TEST_DIR = path.join(ROOT, 'test');
const PER_FILE_TIMEOUT_MS = 120000; // 2 min per file; a hung suite fails instead of wedging the run

const argv = process.argv.slice(2);
function flag(name) { return argv.includes(name); }
function value(name) {
  const i = argv.indexOf(name);
  return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('-') ? argv[i + 1] : null;
}

const filter = value('--filter');
const verbose = flag('--verbose');
const listOnly = flag('--list');

const files = fs.readdirSync(TEST_DIR)
  .filter((f) => f.endsWith('.test.js'))
  .filter((f) => !filter || f.toLowerCase().includes(filter.toLowerCase()))
  .sort();

if (listOnly) {
  files.forEach((f) => console.log('test/' + f));
  console.log(files.length + ' test file(s)');
  process.exit(0);
}

if (files.length === 0) {
  console.error('No test files' + (filter ? ' match --filter "' + filter + '"' : '') + '.');
  process.exit(1);
}

const useColor = process.stdout.isTTY;
const green = (s) => (useColor ? '\x1b[32m' + s + '\x1b[0m' : s);
const red = (s) => (useColor ? '\x1b[31m' + s + '\x1b[0m' : s);
const dim = (s) => (useColor ? '\x1b[2m' + s + '\x1b[0m' : s);

// "N passed, M failed" from a file's output, if it follows the house convention.
function tally(out) {
  const m = /\b(\d+)\s+passed,\s*(\d+)\s+failed\b/.exec(out || '');
  return m ? { passed: Number(m[1]), failed: Number(m[2]) } : null;
}

let failures = 0;
const results = [];

for (const name of files) {
  const res = spawnSync(process.execPath, [path.join(TEST_DIR, name)], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 16 * 1024 * 1024,
    timeout: PER_FILE_TIMEOUT_MS
  });

  const out = (res.stdout || '') + (res.stderr || '');
  const killed = res.status === null; // timeout or external signal
  const ok = !killed && res.status === 0;
  if (!ok) failures++;

  const t = tally(out);
  const label = t
    ? t.passed + ' passed, ' + t.failed + ' failed'
    : (killed ? 'killed (' + (res.signal || 'unknown') + ')' : 'exit ' + res.status);

  results.push({ name, ok, out, label });
  console.log((ok ? green('\u2713') : red('\u2717')) + ' ' + name + '  ' + dim(label));
}

// Roll-up first, then the bodies of any failed file (and every file under
// --verbose) so the summary is never buried at the bottom.
console.log('');
for (const r of results) {
  if (r.ok && !verbose) continue;
  console.log(dim('---- ' + (r.ok ? 'PASS' : 'FAIL') + ' ' + r.name + ' ----'));
  process.stdout.write(r.out);
  if (!r.out.endsWith('\n')) console.log('');
}

const passed = results.length - failures;
console.log('\n' + passed + ' file(s) passed, ' + failures + ' failed (' + results.length + ' total).');
process.exit(failures ? 1 : 0);
