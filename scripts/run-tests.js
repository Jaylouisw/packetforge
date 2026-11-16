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
//   node scripts/run-tests.js --concurrency=4  # four suites at a time
//
// Concurrency exists because the suite is now the slowest thing CI does: 257 suites,
// one process each, and a single core doing them one after another. Every suite is
// already a separate process with its own port (they all bind 0) and its own heap, so
// the isolation the serial loop was buying is the isolation the process boundary gives
// us for free - the loop was serial because that was the shape it started in, not
// because anything needed it. `PF_TEST_CONCURRENCY` (or --concurrency=N) is the knob;
// the default is 1, so a local `npm test` behaves exactly as it always has, and
// --bail and --verbose force it back to 1, both being single-suite-reading modes.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

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
const requestedConcurrency = Number(value('--concurrency') || process.env.PF_TEST_CONCURRENCY || 1);

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

// 1 unless asked otherwise, and never more than there is work for. `--bail` and --verbose
// are single-suite-reading modes, so they stay serial whatever the environment says.
const concurrency = Math.max(1, Math.min(
  Number.isFinite(requestedConcurrency) ? Math.floor(requestedConcurrency) : 1,
  verbose || bail ? 1 : 16,
  suites.length
));

console.log('PacketForge test runner \u2014 ' + suites.length + ' suite(s)' +
  (concurrency > 1 ? ' at ' + concurrency + '-way concurrency' : '') + '\n');

function report(r) {
  const note = !r.reported ? ' (no summary line)' : '';
  console.log((r.ok ? '  \u2713 ' : '  \u2717 ') + r.label.padEnd(34) +
    String(r.passed).padStart(5) + ' passed' +
    (r.failed ? ', ' + r.failed + ' failed' : '') +
    '  ' + String(r.ms).padStart(6) + ' ms' + note);
  if (verbose || !r.ok) {
    const text = r.out.trim().split('\n').slice(-25).join('\n');
    if (text) console.log(text.split('\n').map((l) => '      ' + l).join('\n'));
  }
}

// One suite, one process, one bound. The 300 s ceiling is unchanged from the serial loop:
// a suite that never returns is a bug in the suite, but it must not wedge the run.
function runSuite(suite) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let out = '';
    let settled = false;
    const finish = (status) => {
      if (settled) return;
      settled = true;
      clearTimeout(killer);
      const rel = path.relative(ROOT, suite).replace(/\\/g, '/');
      const label = path.basename(suite, '.test.js');
      const t = tally(suite, out, status);
      resolve({ suite, rel, label, ok: status === 0, ...t, ms: Date.now() - t0, out });
    };
    const child = spawn(process.execPath, [suite], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const killer = setTimeout(() => {
      out += '\n[runner] suite exceeded its 300 s budget and was killed\n';
      try { child.kill('SIGKILL'); } catch (e) { /* already gone */ }
      finish(1);
    }, 300000);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('error', () => finish(1));
    child.on('close', (code) => finish(code === null ? 1 : code));
  });
}

async function runAll() {
  if (concurrency === 1) {
    for (const suite of suites) {
      const r = await runSuite(suite);
      totalPassed += r.passed;
      totalFailed += r.failed;
      results.push(r);
      report(r);
      if (!r.ok && bail) {
        console.log('\nStopped at the first failure (--bail).');
        break;
      }
    }
    return;
  }

  // Results are printed in discovery order, not completion order, so the log of a
  // concurrent run diffs cleanly against the log of a serial one - only the timings
  // move. A slow suite at the front delays the lines after it in the buffer, which is
  // the only cost ordering has here, and the summary at the end is the same either way.
  const pending = new Map();
  let next = 0;        // next suite to start
  let printed = 0;     // next suite to print
  let stopped = false; // --bail tripped

  const flush = () => {
    while (pending.has(printed)) {
      const r = pending.get(printed);
      pending.delete(printed);
      printed += 1;
      totalPassed += r.passed;
      totalFailed += r.failed;
      results.push(r);
      report(r);
    }
  };

  const worker = async () => {
    while (!stopped) {
      const index = next;
      if (index >= suites.length) return;
      next += 1;
      const r = await runSuite(suites[index]);
      pending.set(index, r);
      flush();
      if (!r.ok && bail) stopped = true;
    }
  };

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  flush();
}

function summarise() {
  const failedSuites = results.filter((r) => !r.ok);
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);

  console.log('\n' + '-'.repeat(66));
  console.log(results.length + ' suite(s) in ' + elapsed + ' s \u2014 ' +
    totalPassed + ' assertions passed, ' + totalFailed + ' failed');

  if (failedSuites.length) {
    console.log('\nFailed:');
    failedSuites.forEach((r) => console.log('  \u2717 ' + r.rel));
    process.exit(1);
  }

  // A suite that printed no summary line is suspicious: it means the convention broke,
  // not that the suite was empty. Say so rather than letting the totals quietly
  // under-report.
  const silent = results.filter((r) => !r.reported);
  if (silent.length) {
    console.log('\nNote: ' + silent.length + ' suite(s) printed no "<n> passed, <m> failed" line:');
    silent.forEach((r) => console.log('  \u00b7 ' + r.rel));
  }

  console.log('OK \u2014 every suite passed.');
}

runAll().then(summarise).catch((err) => {
  console.error(err && err.stack ? err.stack : String(err));
  process.exit(1);
});
