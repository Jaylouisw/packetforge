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
// Two ways this file used to lie about failure, and the shape of the fix, because both were
// the runner's fault rather than a suite's:
//
//   1. A dirty worktree made the NEXT run lie. `test/canonical-urls.test.js` edits README.md
//      and restores it; an interrupted run left `M README.md` behind, and the run after it
//      reported 6 failures that were that one file - `git checkout -- .` and the same tree
//      ran 52 passed, 0 failed. Three tool calls went into that, one of them spent believing
//      the wrong suite. So the runner now refuses to start on a dirty worktree: it prints the
//      paths and the two commands that clean them. `--allow-dirty` proceeds with one warning
//      line, because a worker is sometimes genuinely mid-edit. CI checks out clean, so the
//      guard costs it one `git status` and changes nothing else.
//
//   2. A run could exit 1 with no suite named. One local run printed `stdin is not a tty`
//      and nothing else, so the failure could not be attributed at all. So: every non-zero
//      suite is named in the summary with how it exited and the tail of its own output, the
//      summary path no longer calls `process.exit()` (which drops writes still queued on a
//      pipe, and a lost summary reads exactly like a run that named nothing), and a run that
//      dies - uncaught throw, a signal, anything before the summary - still prints what it
//      knows. A red run has to be readable without re-running it.
//
// Usage:
//   node scripts/run-tests.js                  # every suite
//   node scripts/run-tests.js --filter=bgp     # suites whose path matches
//   node scripts/run-tests.js --bail           # stop at the first failure
//   node scripts/run-tests.js --verbose        # stream each suite's output
//   node scripts/run-tests.js --list           # show what would run
//   node scripts/run-tests.js --concurrency=4  # four suites at a time
//   node scripts/run-tests.js --allow-dirty    # run even if the worktree is dirty
//
// Exit codes: 0 every suite passed, 1 a suite failed, 2 the runner refused to start (a dirty
// worktree, or no suite matched). "I would not start" is not "a suite said so", and reading
// the second as the first is how the wrong thing gets debugged.
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
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const TEST_DIR = path.join(ROOT, 'test');
const TAIL_LINES = 20;
const REFUSED = 2;   // refused to start, which is not the same thing as a suite failing

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
const allowDirty = has('--allow-dirty');
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

// A failing suite is described by the last few lines it printed. Twenty is enough for a
// stack, a refusal line or the first assertion that broke; more is a log nobody scrolls.
function tailOf(text) {
  return String(text || '').replace(/\s+$/, '').split('\n').slice(-TAIL_LINES);
}

// ---------------------------------------------------------------------------
// The pre-run guard: is the worktree clean?
// ---------------------------------------------------------------------------
//
// `git status --porcelain` and nothing cleverer: a path a suite left modified, added or
// created is a path the next run reads, and a run that reads a half-edited README reports
// failures that belong to nobody's commit.
//
// The guard is not a failing suite - it refuses before the first one, with its own exit code
// and the commands that fix it. Returns the porcelain lines, or null when git cannot answer
// (a tarball install, a container without git, a checkout that is not a worktree). Unknown is
// not dirty: nothing to guard, so run as before rather than inventing a refusal.
function worktreeStatus() {
  let r;
  try {
    r = spawnSync('git', ['status', '--porcelain'], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    });
  } catch (e) {
    return null;
  }
  if (!r || r.error || r.status !== 0 || typeof r.stdout !== 'string') return null;
  return r.stdout.split('\n').map((l) => l.replace(/\s+$/, '')).filter(Boolean);
}

function dirtyRefusal(entries) {
  const shown = entries.slice(0, 20);
  const lines = [];
  lines.push('Refusing to start: the worktree is dirty (' + entries.length +
    ' path' + (entries.length === 1 ? '' : 's') + ').');
  lines.push('');
  shown.forEach((e) => lines.push('  ' + e));
  if (entries.length > shown.length) lines.push('  ... and ' + (entries.length - shown.length) + ' more');
  lines.push('');
  lines.push('  A suite that edits a tracked file and is interrupted leaves the file behind, so the');
  lines.push('  next run fails on the leftover rather than on the tree - six failures that were one');
  lines.push('  dirty file, every one of them about a commit that was fine. Clean up first, so the');
  lines.push('  number after it means something:');
  lines.push('');
  lines.push('    git checkout -- .      # discard what a suite left in a tracked file');
  lines.push('    git clean -fd          # ... and remove what a suite created and never removed');
  lines.push('');
  lines.push('  Running mid-edit on purpose? node scripts/run-tests.js --allow-dirty');
  return lines.join('\n');
}

function dirtyWarning(entries) {
  const sample = entries.slice(0, 3).join(', ') + (entries.length > 3 ? ', ...' : '');
  return 'Warning: the worktree is dirty (' + entries.length + ' path' +
    (entries.length === 1 ? '' : 's') + ': ' + sample + ') and --allow-dirty was given, so ' +
    'this run goes ahead. If a suite blames a file nobody touched in this change, that is why.';
}

// A run that dirties the tree is a run whose *next* number nobody can trust. This fails
// nothing - the suites that passed did pass - but it names what was left, so the next run's
// failure is already explained here instead of three tool calls later.
function dirtyAfterRun(before) {
  const after = worktreeStatus();
  if (!after) return;
  const was = new Set(before || []);
  const added = after.filter((e) => !was.has(e));
  if (!added.length) return;
  console.log('\nThis run left the worktree dirty (' + added.length + ' path' +
    (added.length === 1 ? '' : 's') + ') - the next run will read these, not your commit:');
  added.slice(0, 20).forEach((e) => console.log('  ' + e));
  console.log('  A suite that edits a tracked file has to put it back in the same process, even when');
  console.log('  a check fails half way. `git checkout -- .` before believing the next run.');
}

const suites = discover();

const results = [];
let totalPassed = 0;
let totalFailed = 0;
const started = Date.now();
let summaryPrinted = false;
let refused = false;          // the runner said no; nothing failed, so say nothing on exit
let before = [];              // the dirty paths this run started with

// 1 unless asked otherwise, and never more than there is work for. `--bail` and --verbose
// are single-suite-reading modes, so they stay serial whatever the environment says.
const concurrency = Math.max(1, Math.min(
  Number.isFinite(requestedConcurrency) ? Math.floor(requestedConcurrency) : 1,
  verbose || bail ? 1 : 16,
  Math.max(1, suites.length)
));

// Every suite's own accounting, one line each, in discovery order. The tail of a failing
// suite's output is deliberately *not* printed here any more: it belongs in the failure
// block at the end, which is the block a reader scrolls to, and printing it twice is how the
// end of a log gets skimmed past.
function report(r) {
  const note = !r.reported ? ' (no summary line)' : '';
  const how = r.signal ? ' (' + r.how + ')' : '';
  console.log((r.ok ? '  \u2713 ' : '  \u2717 ') + r.label.padEnd(34) +
    String(r.passed).padStart(5) + ' passed' +
    (r.failed ? ', ' + r.failed + ' failed' : '') +
    '  ' + String(r.ms).padStart(6) + ' ms' + note + how);
  if (verbose) {
    const text = tailOf(r.out).join('\n');
    if (text) console.log(text.split('\n').map((l) => '      ' + l).join('\n'));
  }
}

// One suite, one process, one bound. The 300 s ceiling is unchanged from the serial loop:
// a suite that never returns is a bug in the suite, but it must not wedge the run.
function runSuite(suite) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let out = '';
    let killed = false;
    let settled = false;
    const finish = (status, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(killer);
      const rel = path.relative(ROOT, suite).replace(/\\/g, '/');
      const label = path.basename(suite, '.test.js');
      const t = tally(suite, out, status);
      const how = killed ? 'killed after 300 s' : (signal ? 'signal ' + signal : 'exit ' + status);
      resolve({
        suite, rel, label, ok: status === 0, ...t,
        code: status, signal: signal || null, killed, how,
        ms: Date.now() - t0, out
      });
    };
    const child = spawn(process.execPath, [suite], {
      cwd: ROOT,
      // stdin is /dev/null on purpose: a suite must not be able to block the run waiting for
      // a terminal that is not there, and a grandchild's `stdin is not a tty` is not a
      // diagnosis of anything.
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const killer = setTimeout(() => {
      killed = true;
      out += '\n[runner] suite exceeded its 300 s budget and was killed\n';
      try { child.kill('SIGKILL'); } catch (e) { /* already gone */ }
      finish(1, null);
    }, 300000);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('error', (err) => {
      out += '\n[runner] could not start this suite: ' +
        (err && err.message ? err.message : String(err)) + '\n';
      finish(1, null);
    });
    child.on('close', (code, signal) => finish(code === null ? 1 : code, signal || null));
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

// ---------------------------------------------------------------------------
// Failure attribution
// ---------------------------------------------------------------------------
//
// The rule: a red run is readable without re-running anything - which suite, how it exited,
// and the last 20 lines it printed. Anything less and the reader is back at the terminal
// guessing, which is what `stdin is not a tty` and a bare exit 1 cost.
//
// The suite path stays at the END of its line on purpose. CI reads a failing run's log with
// `grep -oE 'test/[A-Za-z0-9._/-]+\.test\.js$'` to decide which suites to re-run on their
// own, so moving the path into the middle of a sentence would quietly stop that working - the
// retry would find nothing, and a host flake would read as a broken tree.
function failureBlock(failedSuites, total) {
  const lines = [];
  lines.push('');
  lines.push(failedSuites.length === 1
    ? '1 of ' + total + ' suite(s) failed - this is what it said:'
    : failedSuites.length + ' of ' + total + ' suite(s) failed - this is what each one said:');
  failedSuites.forEach((r) => {
    lines.push('');
    lines.push('  \u2717 ' + r.how + ' \u00b7 ' + r.rel);
    const counts = r.reported
      ? r.passed + ' passed, ' + r.failed + ' failed'
      : 'no summary line - the exit code is the whole report';
    lines.push('      ' + counts + ' \u00b7 ' + Math.round(r.ms) + ' ms');
    const tail = tailOf(r.out);
    if (!tail.length || (tail.length === 1 && tail[0] === '')) {
      lines.push('      (printed nothing on stdout or stderr)');
      return;
    }
    lines.push('      last ' + tail.length + ' line' + (tail.length === 1 ? '' : 's') + ' of its output:');
    tail.forEach((l) => lines.push('      | ' + l));
  });
  return lines.join('\n');
}

function writeSync(text) {
  try {
    fs.writeSync(1, text);
  } catch (e) {
    try { console.error(text); } catch (e2) { /* nothing left to say it with */ }
  }
}

// The last resort. If the runner stops before it can summarise - an uncaught throw, a
// SIGTERM from a CI step's timeout, a suite that took the process with it - this prints what
// is known, synchronously, because a write still queued on a pipe at exit time is exactly
// the write that never lands. Named suites first: an unnamed failure is the defect, not the
// report.
function lastResort(reason) {
  const failed = results.filter((r) => !r.ok);
  const lines = [''];
  lines.push('! The run stopped before it could finish: ' + reason);
  if (failed.length) {
    lines.push('  Suites that had already failed (' + failed.length + '):');
    failed.forEach((r) => {
      lines.push('    \u2717 ' + r.how + ' \u00b7 ' + r.rel);
      tailOf(r.out).forEach((l) => lines.push('      | ' + l));
    });
  } else {
    lines.push('  No suite had failed at this point - the failure is the runner, not a suite.');
  }
  const notRun = suites.filter((s) => !results.some((r) => r.suite === s));
  if (notRun.length) {
    const names = notRun.slice(0, 10).map((s) => path.basename(s));
    lines.push('  ' + notRun.length + ' suite(s) never reported: ' + names.join(', ') +
      (notRun.length > names.length ? ', ...' : ''));
  }
  const one = results.length
    ? results[results.length - 1].rel
    : (suites[0] ? path.relative(ROOT, suites[0]).replace(/\\/g, '/') : 'test/<name>.test.js');
  lines.push('  One suite on its own: node ' + one);
  writeSync(lines.join('\n') + '\n');
}

function summarise() {
  summaryPrinted = true;
  const failedSuites = results.filter((r) => !r.ok);
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);

  console.log('\n' + '-'.repeat(66));
  console.log(results.length + ' suite(s) in ' + elapsed + ' s \u2014 ' +
    totalPassed + ' assertions passed, ' + totalFailed + ' failed');

  if (failedSuites.length) {
    console.log(failureBlock(failedSuites, results.length));
    // --bail leaves suites unrun; a reader should not have to infer that from the count.
    if (results.length < suites.length) {
      console.log('\n' + (suites.length - results.length) + ' suite(s) never ran (--bail).');
    }
    dirtyAfterRun(before);
    // Deliberately not process.exit(1): stdout is a pipe under `npm test` and under CI's
    // `| tee`, and an exit before the last write lands is how a summary disappears.
    process.exitCode = 1;
    return;
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
  dirtyAfterRun(before);
}

async function main() {
  before = worktreeStatus() || [];
  if (before.length && !allowDirty) {
    console.log(dirtyRefusal(before));
    process.exitCode = REFUSED;
    refused = true;
    return;
  }
  if (before.length) console.log(dirtyWarning(before) + '\n');

  console.log('PacketForge test runner \u2014 ' + suites.length + ' suite(s)' +
    (concurrency > 1 ? ' at ' + concurrency + '-way concurrency' : '') + '\n');

  await runAll();
  summarise();
}

// A closed stdout (piped into `head`, a terminal that went away) is not a test result, and
// the EPIPE crash it used to cause exited 1 with the summary half written - the exact shape
// of lie this file exists to stop.
process.stdout.on('error', (err) => {
  if (err && err.code === 'EPIPE') return;
  throw err;
});

process.on('uncaughtException', (err) => {
  lastResort('uncaught ' + (err && err.message ? err.message : String(err)));
  process.exitCode = 1;
  process.exit(1);
});
process.on('unhandledRejection', (err) => {
  lastResort('unhandled rejection: ' + (err && err.message ? err.message : String(err)));
  process.exitCode = 1;
  process.exit(1);
});
['SIGINT', 'SIGTERM', 'SIGHUP'].forEach((sig) => {
  // For CI's `timeout --signal=TERM` on Linux, where the process is asked to stop and can
  // still print. Windows `kill` is a TerminateProcess and runs no handler at all, so this is
  // a backstop for the platform that can take it, not the only thing between a killed run
  // and silence - the exit hook below is the one that always runs.
  process.on(sig, () => {
    lastResort('stopped by ' + sig);
    process.exitCode = 1;
    process.exit(1);
  });
});
// The fallback of the fallback: if this process is about to exit non-zero having printed no
// summary, say that much. `[runner]` marks it as the harness talking, not a suite.
process.on('exit', (code) => {
  if (code !== 0 && !summaryPrinted && !refused) {
    writeSync('\n[runner] exited ' + code + ' without printing a summary - ' +
      (results.length ? 'the suites that had reported are listed above'
        : 'no suite had reported yet, so nothing can be attributed to one') + '\n');
  }
});

if (!suites.length) {
  console.error(filter ? 'No suite matches --filter=' + filter : 'No suites found in test/');
  process.exitCode = REFUSED;
  refused = true;
} else if (listOnly) {
  // A listing runs nothing, so a dirty worktree is irrelevant to it: no guard here.
  suites.forEach((s) => console.log(path.relative(ROOT, s).replace(/\\/g, '/')));
  console.log('\n' + suites.length + ' suite(s)');
} else {
  main().catch((err) => {
    lastResort('the runner threw: ' + (err && err.message ? err.message : String(err)));
    process.exitCode = 1;
  });
}
