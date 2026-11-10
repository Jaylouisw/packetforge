#!/usr/bin/env node
'use strict';

// One runner, every suite.
//
// `npm test` used to be a hand-maintained `&&` chain of file names in package.json. That
// chain drifted twice in ways that mattered: three suites existed for weeks without ever
// running (duplicate-models, hybrid-cord-use, link-parts - the first of which is the gate
// that stops two specs describing one box), and because every new suite appended to the end
// of the same line, any two branches that each added a test conflicted in exactly the same
// place. A glob cannot drift, and it cannot conflict.
//
// Each suite is a standalone Node script that prints "<n> passed, <m> failed" and exits
// non-zero on failure. Rather than reimplementing that, this runner discovers them, runs
// them in separate processes (so one suite cannot leak state into the next, and a suite that
// hangs or crashes the heap does not take the run down with it), and aggregates what they
// report.
//
// Usage:
//   node scripts/run-tests.js                 # every suite
//   node scripts/run-tests.js --filter=bgp     # suites whose path matches
//   node scripts/run-tests.js --bail           # stop at the first failure
//   node scripts/run-tests.js --verbose        # stream each suite's output
//   node scripts/run-tests.js --list           # show what would run

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const TEST_DIR = path.join(ROOT, 'test');

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const value = (flag) => {
  const hit = argv.find((a) => a.startsWith(flag + '='));
  return hit ? hit.slice(flag.length + 1) : null;
};

const filter = value('--filter');
const bail = has('--bail');
const verbose = has('--verbose');
const listOnly = has('--list');

function discover() {
  if (!fs.existsSync(TEST_DIR)) return [];
  return fs.readdirSync(TEST_DIR)
    .filter((f) => f.endsWith('.test.js'))
    .sort()
    .map((f) => path.join(TEST_DIR, f))
    .filter((p) => !filter || p.replace(/\\/g, '/').includes(filter));
}

// A suite's own summary is the most honest count it can give us; the exit code is the
// authority on whether it passed. Where the two disagree the exit code wins, because a
// suite that dies half way through still has a summary line on stdout.
function tally(suite, stdout, status) {
  const text = String(stdout || '');
  const re = /(\d+)\s+passed,\s+(\d+)\s+failed/g;
  let m, last = null;
  while ((m = re.exec(text)) !== null) last = m;
  let passed = last ? Number(last[1]) : 0;
  let failed = last ? Number(last[2]) : 0;
  let reported = !!last;
  // A suite built on `node:test` prints TAP, not our summary line: `# pass 7`, `# fail 0`. Ignoring that counted
  // a whole suite as zero assertions - its checks passed, its exit code was 0, and the total quietly understated
  // what the repository verifies. Both shapes are read, our own first.
  if (!reported) {
    // `node --test` prints TAP (`# pass 6`) or, on current Node, the spec reporter's `i pass 6` - the same
    // number behind a different glyph.
    const tapPass = /^\s*(?:#|ℹ)\s*pass\s+(\d+)/m.exec(text);
    const tapFail = /^\s*(?:#|ℹ)\s*fail\s+(\d+)/m.exec(text);
    if (tapPass) {
      passed = Number(tapPass[1]);
      failed = tapFail ? Number(tapFail[1]) : 0;
      reported = true;
    }
  }
  return { passed, failed: status === 0 ? failed : Math.max(failed, 1), reported };
}

const suites = discover();
if (!suites.length) {
  console.error(filter ? 'No suite matches --filter=' + filter : 'No suites found in test/');
  process.exit(1);
}
if (listOnly) {
  suites.forEach((s) => console.log(path.relative(ROOT, s).replace(/\\/g, '/')));
  console.log('\n' + suites.length + ' suite(s)');
  process.exit(0);
}

const results = [];
let totalPassed = 0;
let totalFailed = 0;
const started = Date.now();

console.log('PacketForge test runner — ' + suites.length + ' suite(s)\n');

for (const suite of suites) {
  const rel = path.relative(ROOT, suite).replace(/\\/g, '/');
  const label = path.basename(suite, '.test.js');
  const t0 = Date.now();
  const res = spawnSync(process.execPath, [suite], {
    cwd: ROOT,
    encoding: 'utf8',
    // A suite that never returns is a bug in the suite, but it must not wedge the whole
    // run. Generous: the catalogue-wide audits walk ~975 specs each.
    timeout: 300000,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const ms = Date.now() - t0;
  const out = (res.stdout || '') + (res.stderr || '');
  const status = res.status === null ? 1 : res.status;
  const t = tally(suite, out, status);
  totalPassed += t.passed;
  totalFailed += t.failed;

  const ok = status === 0;
  results.push({ rel, label, ok, ...t, ms, out });

  const note = !t.reported ? ' (no summary line)' : '';
  console.log((ok ? '  ✓ ' : '  ✗ ') + label.padEnd(34) +
    String(t.passed).padStart(5) + ' passed' +
    (t.failed ? ', ' + t.failed + ' failed' : '') +
    '  ' + String(ms).padStart(6) + ' ms' + note);

  if (verbose || !ok) {
    const tail = out.trim().split('\n').slice(-25).join('\n');
    if (tail) console.log(tail.split('\n').map((l) => '      ' + l).join('\n'));
  }

  if (!ok && bail) {
    console.log('\nStopped at the first failure (--bail).');
    break;
  }
}

const failedSuites = results.filter((r) => !r.ok);
const elapsed = ((Date.now() - started) / 1000).toFixed(1);

console.log('\n' + '-'.repeat(66));
console.log(results.length + ' suite(s) in ' + elapsed + ' s — ' +
  totalPassed + ' assertions passed, ' + totalFailed + ' failed');

if (failedSuites.length) {
  console.log('\nFailed:');
  failedSuites.forEach((r) => console.log('  ✗ ' + r.rel));
  process.exit(1);
}

// A suite that printed no summary line is suspicious: it means the convention broke, not
// that the suite was empty. Say so rather than letting the totals quietly under-report.
const silent = results.filter((r) => !r.reported);
if (silent.length) {
  console.log('\nNote: ' + silent.length + ' suite(s) printed no "<n> passed, <m> failed" line:');
  silent.forEach((r) => console.log('  · ' + r.rel));
}

console.log('OK — every suite passed.');
