'use strict';
// runner-honest-failure.test.js -- the test runner must not lie about failure.
//
// Two lies, both of which cost real time before they were written down here:
//
//   1. A suite that edits a tracked file and is interrupted leaves it modified, and the NEXT
//      run then reports failures that belong to the leftover. `test/canonical-urls.test.js`
//      edits README.md and restores it; one interrupted run left `M README.md` behind, the run
//      after it reported 6 failures, and `git checkout -- .` turned them into 52 passed,
//      0 failed. Three tool calls, one wrong diagnosis.
//   2. A run could exit 1 having named no suite at all - a local run printed `stdin is not a
//      tty` and nothing else - so there was nothing to re-run and nothing to fix.
//
// The subject is `scripts/run-tests.js`, and the only honest way to test it is to run it. So
// this suite builds a real repository in a temp directory: a copy of the runner plus four
// suites whose behaviour is known (pass, fail loudly, fail silently, ignore stdin), commits it
// so the worktree starts clean, and then runs the copy with real child processes.
//
// The copy is what makes it isolated: the runner derives its root from its own path
// (`path.resolve(__dirname, '..')`), so a copy two directories down runs against the fixture
// and never against this tree. No --root flag and no environment hook to keep in sync.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const RUNNER = path.join(ROOT, 'scripts', 'run-tests.js');

let passed = 0;
let failed = 0;

function ok(cond, msg, detail) {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.log('  not ok - ' + msg + (detail ? '  [' + detail + ']' : ''));
  }
}

function firstLine(text) {
  return String(text || '').split('\n')[0].slice(0, 200);
}

// ---------------------------------------------------------------------------
// The fixture
// ---------------------------------------------------------------------------

const SUITES = {
  // A suite that passes and says something, so a clean run has a real line to print.
  'alpha-pass.test.js': [
    "'use strict';",
    "console.log('alpha: a check that holds');",
    "console.log('');",
    "console.log('3 passed, 0 failed');",
    ''
  ].join('\n'),

  // A suite that fails the way a real one does: an assertion line, a summary, a non-zero exit.
  // BRAVO-SENTINEL is the marker this test looks for in the runner's failure block - if the
  // runner did not capture this suite's own output, that string cannot appear in its log.
  'bravo-fail.test.js': [
    "'use strict';",
    "console.error('  not ok - the refusal names the way forward');",
    "console.error('BRAVO-SENTINEL the last thing this suite printed');",
    "console.log('2 passed, 1 failed');",
    'process.exit(1);',
    ''
  ].join('\n'),

  // A suite that dies without a word: the shape that produced "exited 1 and named nothing".
  // It also reads stdin, because a suite must not be able to wedge the run on a terminal.
  'charlie-silent.test.js': [
    "'use strict';",
    'process.stdin.resume();',
    'process.stdin.on("end", function () { process.exit(3); });',
    '// A fallback so this fixture can never hang the run it is part of.',
    'setTimeout(function () { process.exit(3); }, 100);',
    ''
  ].join('\n'),

  // A suite that is green, so a filtered run has a pass to report.
  'delta-pass.test.js': [
    "'use strict';",
    "console.log('4 passed, 0 failed');",
    ''
  ].join('\n')
};

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

function haveGit() {
  try {
    execFileSync('git', ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return true;
  } catch (e) {
    return false;
  }
}

function buildFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-runner-'));
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'test'), { recursive: true });
  fs.copyFileSync(RUNNER, path.join(dir, 'scripts', 'run-tests.js'));
  Object.keys(SUITES).forEach(function (name) {
    fs.writeFileSync(path.join(dir, 'test', name), SUITES[name]);
  });
  // A tracked file for a suite to leave dirty, the way canonical-urls leaves README.md.
  fs.writeFileSync(path.join(dir, 'README.md'), '# a fixture\n');
  return dir;
}

function commitFixture(dir) {
  git(dir, ['init', '-q']);
  git(dir, ['add', '-A']);
  git(dir, ['-c', 'user.email=runner@example.invalid', '-c', 'user.name=runner test',
    '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture']);
}

function restore(dir) {
  git(dir, ['checkout', '--', '.']);
  git(dir, ['clean', '-fdxq']);
}

function porcelain(dir) {
  return git(dir, ['status', '--porcelain']).trim();
}

// The runner, run the way a person runs it: node scripts/run-tests.js [flags], from the
// fixture, with stdin closed so a suite cannot wait on a terminal.
function run(dir, args) {
  const r = spawnSync(process.execPath, [path.join(dir, 'scripts', 'run-tests.js')].concat(args || []), {
    cwd: dir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120000
  });
  return {
    code: r.status,
    signal: r.signal || null,
    out: String(r.stdout || '') + String(r.stderr || '')
  };
}

const dir = buildFixture();
const gitAvailable = haveGit();
try {
  if (!gitAvailable) {
    console.log('  (dirty-worktree cases skipped: git is not available here)');
  } else {
    commitFixture(dir);
  }

  // -------------------------------------------------------------------------
  // 1. The baseline: a clean worktree runs the suites it found.
  // -------------------------------------------------------------------------
  console.log('\nA clean fixture runs, and a suite that passes is reported as passing:');
  {
    const r = run(dir, ['--filter=alpha']);
    ok(r.code === 0, 'a clean worktree runs the suite it found and exits 0', 'exit ' + r.code + ' / ' + firstLine(r.out));
    ok(/1 suite\(s\) in/.test(r.out), 'the summary counts the suite that ran', firstLine(r.out));
    ok(r.out.indexOf('OK \u2014 every suite passed.') !== -1, 'and says every suite passed');
    ok(r.out.indexOf('Refusing to start') === -1, 'and does not refuse a clean worktree');
    ok(/alpha-pass\s+3 passed/.test(r.out),
      'the suite line is printed for the suite that ran', r.out.slice(-400));
  }

  // -------------------------------------------------------------------------
  // 2. A dirty worktree is refused before a single suite runs.
  // -------------------------------------------------------------------------
  console.log('\nA dirty worktree is refused, and the refusal names the path and the fix:');
  if (!gitAvailable) {
    console.log('  (skipped - no git)');
    passed++;
  } else {
    // Exactly what an interrupted suite leaves: a tracked file modified, nothing else.
    fs.appendFileSync(path.join(dir, 'test', 'alpha-pass.test.js'), '\n// left behind by an interrupted run\n');
    const dirty = porcelain(dir);
    ok(/M test\/alpha-pass\.test\.js/.test(dirty), 'the fixture is dirty in the shape a suite leaves',
      JSON.stringify(dirty));

    const r = run(dir, ['--filter=alpha']);
    ok(r.code !== 0, 'a dirty worktree is not run', 'exit ' + r.code + ' / ' + firstLine(r.out));
    ok(r.code === 2, 'and the refusal is distinguishable from a failing suite (exit 2, not 1)',
      'exit ' + r.code);
    ok(r.out.indexOf('Refusing to start') !== -1, 'the refusal says it refused',
      firstLine(r.out));
    ok(r.out.indexOf('test/alpha-pass.test.js') !== -1, 'and names the dirty path, so it can be cleaned',
      r.out.slice(0, 600));
    ok(/git checkout -- \./.test(r.out), 'and names the command that fixes a suite\'s leftovers',
      r.out.slice(0, 600));
    ok(r.out.indexOf('--allow-dirty') !== -1, 'and names the way to run anyway',
      r.out.slice(0, 600));
    ok(r.out.indexOf('PacketForge test runner') === -1,
      'and nothing ran: no banner, no suite line, no summary', r.out.slice(0, 400));
    ok(r.out.indexOf('OK \u2014 every suite passed.') === -1,
      'and a refused run cannot be mistaken for a green one');

    // -----------------------------------------------------------------------
    // 3. --allow-dirty proceeds, with one warning line.
    // -----------------------------------------------------------------------
    console.log('\n--allow-dirty proceeds on the same dirty worktree, and says it did:');
    const allowed = run(dir, ['--filter=alpha', '--allow-dirty']);
    ok(allowed.code === 0, '--allow-dirty runs the suites on a dirty worktree', 'exit ' + allowed.code + ' / ' + firstLine(allowed.out));
    ok(allowed.out.indexOf('Warning:') !== -1, 'and warns once, rather than silently', firstLine(allowed.out));
    ok(/--allow-dirty was given/.test(allowed.out), 'and the warning says what let it through', firstLine(allowed.out));
    ok(allowed.out.indexOf('test/alpha-pass.test.js') !== -1, 'and names the path it is running over',
      firstLine(allowed.out));
    ok(/1 suite\(s\) in/.test(allowed.out), 'and the suites really ran', firstLine(allowed.out));
    ok(allowed.out.indexOf('OK \u2014 every suite passed.') !== -1, 'and the run finished green',
      allowed.out.slice(-300));

    restore(dir);
    ok(porcelain(dir) === '', 'the fixture is clean again, so the next case starts honest',
      porcelain(dir));
  }

  // -------------------------------------------------------------------------
  // 4. A failing suite is named, with how it exited and the tail of its own output.
  // -------------------------------------------------------------------------
  console.log('\nA failing suite is named in the summary with its exit code and its output:');
  {
    const r = run(dir, []);
    ok(r.code === 1, 'two failing suites make the run exit 1', 'exit ' + r.code + ' / ' + firstLine(r.out));
    ok(/4 suite\(s\) in/.test(r.out), 'all four suites ran', firstLine((/3 suite\(s\) in/.test(r.out) ? 'only 3 ran' : r.out)));
    ok(r.out.indexOf('test/bravo-fail.test.js') !== -1, 'the failing suite is named by path',
      r.out.slice(-800));
    ok(r.out.indexOf('test/charlie-silent.test.js') !== -1, 'so is the one that printed nothing',
      r.out.slice(-800));
    ok(/BRAVO-SENTINEL/.test(r.out),
      'and the tail of its own output is in the log, so it can be read without re-running it',
      r.out.slice(-800));
    ok(/exit 1 \u00b7 test\/bravo-fail\.test\.js/.test(r.out),
      'the block leads with how it exited, then the file', r.out.slice(-800));
    ok(/exit 3 \u00b7 test\/charlie-silent\.test\.js/.test(r.out),
      'a suite that died silently is still attributed, by exit code', r.out.slice(-800));
    ok(/printed nothing on stdout or stderr/.test(r.out),
      'and the block says so rather than printing an empty tail', r.out.slice(-800));

    // CI decides which suites to re-run alone from this exact shape:
    //   grep -oE 'test/[A-Za-z0-9._/-]+\.test\.js$'
    // A block that moved the path into the middle of a sentence would make that grep find
    // nothing, and a host flake would read as a broken tree. So the shape is asserted here.
    const ciGrep = /^.*test\/[A-Za-z0-9._/-]+\.test\.js$/m;
    const named = (r.out.match(new RegExp(ciGrep.source, 'gm')) || []);
    ok(named.some((l) => /test\/bravo-fail\.test\.js$/.test(l)),
      'the named line ends with the suite path, which is what CI greps for to re-run it alone',
      JSON.stringify(named.slice(0, 4)));
    ok(!named.some((l) => /test\/alpha-pass\.test\.js$/.test(l)),
      'and a suite that passed is not blamed', JSON.stringify(named.slice(0, 4)));
    ok(!named.some((l) => /test\/delta-pass\.test\.js$/.test(l)),
      'not the other passing suite either', JSON.stringify(named.slice(0, 4)));

    // The summary itself must still be the line people (and CI's logs) read for the totals.
    ok(/4 suite\(s\) in [\d.]+ s \u2014 \d+ assertions passed, \d+ failed/.test(r.out),
      'the totals line still reads as it always has', r.out.slice(-900));
    ok(r.out.indexOf('OK \u2014 every suite passed.') === -1,
      'and a red run never claims every suite passed');
  }

  // -------------------------------------------------------------------------
  // 5. The runner names what a run leaves behind, so the next run is already explained.
  // -------------------------------------------------------------------------
  console.log('\nA run that dirties the worktree says so at the end of that run:');
  if (!gitAvailable) {
    console.log('  (skipped - no git)');
    passed++;
  } else {
    // A suite that edits a tracked file and never puts it back - the canonical-urls shape.
    fs.writeFileSync(path.join(dir, 'test', 'echo-dirty.test.js'), [
      "'use strict';",
      "const fs = require('fs');",
      "const path = require('path');",
      "fs.appendFileSync(path.join(__dirname, '..', 'README.md'), 'a suite wrote this\\n');",
      "console.log('1 passed, 0 failed');",
      ''
    ].join('\n'));
    git(dir, ['add', '-A']);
    git(dir, ['-c', 'user.email=runner@example.invalid', '-c', 'user.name=runner test',
      '-c', 'commit.gpgsign=false', 'commit', '-qm', 'a suite that dirties the tree']);
    const r = run(dir, ['--filter=echo-dirty']);
    ok(r.code === 0, 'the suite itself passes', 'exit ' + r.code + ' / ' + firstLine(r.out));
    ok(r.out.indexOf('left the worktree dirty') !== -1,
      'but the runner names what the run left behind', r.out.slice(-600));
    ok(/M README\.md/.test(r.out), 'by path, so the next run\'s failure is already explained',
      r.out.slice(-600));
    restore(dir);
  }
} finally {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* temp dir */ }
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exitCode = 1;
