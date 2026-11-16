'use strict';

// A job that builds an image against the host daemon is a job that writes to the disk
// Forgejo keeps its database on. The rule is that it cleans up after itself, in the same
// job, in a step that runs even when the build fails.
//
// These tests exist because the failure is not visible in the job that causes it: on
// 2026-11-12 the volume filled and the forge answered pushes with `couldn't set
// 'refs/heads/...'`, returned 500 `No space left on device` from its own clone path, and
// stopped creating the jobs that carry `needs:` - so pull requests sat armed against
// checks that could not exist. Nothing in the log of a green Docker build said any of
// that.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('node:os');
const path = require('path');
const { spawnSync } = require('node:child_process');
const { audit, jobBlocks, steps } = require('../scripts/check-ci-disk-hygiene');

const ROOT = path.join(__dirname, '..');

function codes(text) {
  return audit(text, 'test.yml').map(function (o) { return o.code; });
}

const BUILD_ONLY = [
  'jobs:',
  '  docker:',
  '    name: Docker build',
  '    runs-on: ubuntu-latest',
  '    steps:',
  '      - uses: actions/checkout@v4',
  '      - name: Build image',
  '        run: |',
  '          docker build -t packetforge:ci .',
  ''
].join('\n');

const BOUNDED = [
  'jobs:',
  '  docker:',
  '    name: Docker build',
  '    runs-on: ubuntu-latest',
  '    steps:',
  '      - name: Build image',
  '        run: |',
  '          docker build -t packetforge:ci .',
  '      - name: Bound what the build left behind',
  '        if: always()',
  '        run: |',
  '          docker image rm -f packetforge:ci >/dev/null 2>&1 || true',
  '          docker builder prune -f --keep-storage 2GB >/dev/null 2>&1 || true',
  '          docker system df || true',
  ''
].join('\n');

test('the real workflows bound what they write', () => {
  const dirs = ['.forgejo/workflows', '.github/workflows'];
  let checked = 0;
  for (const dir of dirs) {
    const full = path.join(ROOT, dir);
    if (!fs.existsSync(full)) continue;
    for (const entry of fs.readdirSync(full)) {
      // Not an exemption: this is looking for workflow files, and an entry that is not one
      // has nothing to be exempted from.
      if (!/\.ya?ml$/.test(entry)) continue;
      const rel = dir + '/' + entry;
      const offenders = audit(fs.readFileSync(path.join(ROOT, rel), 'utf8'), rel);
      assert.deepStrictEqual(offenders.map(function (o) { return o.code + ' at ' + o.line; }), [],
        rel + ' must bound what its jobs write');
      checked++;
    }
  }
  assert.ok(checked > 0, 'expected at least one workflow file to check');
});

test('a build with no cleanup is unbounded and unmeasured', () => {
  const found = codes(BUILD_ONLY);
  assert.ok(found.indexOf('E_UNBOUNDED_DOCKER_BUILD') !== -1, 'a build with no prune must be reported');
  assert.ok(found.indexOf('E_NO_DISK_REPORT') !== -1, 'a build with no `docker system df` must be reported');
});

test('cleanup in a step without `if: always()` is skipped exactly when it is needed', () => {
  const text = BUILD_ONLY.replace(
    '      - name: Build image\n',
    '      - name: Bound what the build left behind\n' +
    '        run: |\n' +
    '          docker builder prune -f --keep-storage 2GB || true\n' +
    '          docker system df || true\n' +
    '      - name: Build image\n');
  const found = codes(text);
  assert.ok(found.indexOf('E_PRUNE_SKIPPED_ON_FAILURE') !== -1,
    'a prune step without `if: always()` must be reported, got ' + JSON.stringify(found));
});

test('a fully bounded job reports nothing', () => {
  assert.deepStrictEqual(audit(BOUNDED, 'test.yml'), []);
});

test('cleanup in another job does not excuse the job that builds', () => {
  const text = [
    'jobs:',
    '  tidy:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - name: Bound what the build left behind',
    '        if: always()',
    '        run: |',
    '          docker builder prune -f --keep-storage 2GB || true',
    '          docker system df || true',
    '  docker:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - name: Build image',
    '        run: |',
    '          docker build -t packetforge:ci .',
    ''
  ].join('\n');
  const found = audit(text, 'test.yml');
  // The `tidy` job writes nothing, so it is never asked; the `docker` job writes and is asked.
  const onDocker = found.filter(function (o) { return o.code === 'E_UNBOUNDED_DOCKER_BUILD'; });
  assert.strictEqual(onDocker.length, 1, 'exactly the building job must be reported, got ' + JSON.stringify(found));
  assert.ok(found.every(function (o) { return o.code !== 'E_PRUNE_SKIPPED_ON_FAILURE'; }),
    'the tidy job does carry `if: always()`, so it must not be reported for that');
});

test('prose in a comment is not evidence of a build', () => {
  const text = [
    'jobs:',
    '  test:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - name: Full test suite',
    '        # The docker job runs `docker build` against the host daemon.',
    '        run: npm test',
    ''
  ].join('\n');
  assert.deepStrictEqual(audit(text, 'test.yml'), []);
});

test('a job that never builds is never asked to prune', () => {
  const text = [
    'jobs:',
    '  smoke:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - name: Drive the API',
    '        run: node scripts/smoke-http.js',
    ''
  ].join('\n');
  assert.deepStrictEqual(audit(text, 'test.yml'), []);
});

test('the cleanup step runs after the build, and removes the image it created', () => {
  const ci = fs.readFileSync(path.join(ROOT, '.forgejo/workflows/ci.yml'), 'utf8');
  const docker = jobBlocks(ci).find(function (j) { return j.name === 'docker'; });
  assert.ok(docker, 'ci.yml must still have a `docker` job');
  const texts = steps(docker.lines).map(function (s) { return s.text; });
  const buildAt = texts.findIndex(function (t) { return /docker\s+build/.test(t); });
  const pruneAt = texts.findIndex(function (t) { return /docker\s+builder\s+prune/.test(t); });
  assert.ok(buildAt !== -1, 'the docker job must still build the image');
  assert.ok(pruneAt !== -1, 'the docker job must prune the builder cache');
  assert.ok(pruneAt > buildAt, 'cleanup must come after the build it cleans up');
  const bound = texts[pruneAt];
  assert.match(bound, /if:\s*always\(\)/, 'cleanup must run even when the build fails');
  assert.match(bound, /docker image rm -f packetforge:ci/,
    'the image the job created exists to prove a build; it must not be left on the host');
  assert.match(bound, /--keep-storage/, 'the cache must be bounded, not dropped wholesale');
  assert.match(bound, /docker system df/, 'the job must report what it left behind');
});

// #1508: `auto-rebase` ticks every ten minutes. While the volume was full it checked the
// repository out into the runner workspace and then failed at the first write, so six red
// crosses an hour spent the bytes it was waiting for and were indistinguishable from a real
// regression. A host out of disk is not a code failure: the tick has to measure the room a
// checkout needs and stand down green, before the checkout that would consume it.
test('the rebase tick measures the room it needs before it checks out', () => {
  const yml = fs.readFileSync(path.join(ROOT, '.forgejo/workflows/auto-rebase.yml'), 'utf8');
  const job = jobBlocks(yml).find(function (j) { return j.name === 'rebase'; });
  assert.ok(job, 'auto-rebase.yml must still have a `rebase` job');
  const texts = steps(job.lines).map(function (s) { return s.text; });

  const guardAt = texts.findIndex(function (t) { return /df\s+-Pk/.test(t); });
  const checkoutAt = texts.findIndex(function (t) { return /uses:\s*actions\/checkout@/.test(t); });
  assert.notStrictEqual(guardAt, -1,
    'the job must measure free space (`df -Pk`): it checks out and force-pushes onto the same volume Forgejo keeps its data on');
  assert.notStrictEqual(checkoutAt, -1, 'the job must still check out');
  assert.ok(guardAt < checkoutAt,
    'the measurement must come before the checkout it is deciding about (guard at step ' + guardAt +
    ', checkout at step ' + checkoutAt + ')');

  const guard = texts[guardAt];
  assert.match(guard, /exit 0/,
    'a host out of disk is not a red build: the tick must stand down with a green result and the reason in its log');
  assert.match(guard, /#1507/, 'the message must name the disk issue it is standing down for');
  assert.match(guard, /-lt/, 'there must be a threshold - a printed number with nothing comparing it stands down for nobody');
  assert.match(guard, /room=true/,
    'the verdict must default to "proceed": a tick that stands itself down because `df` answered oddly is a silent outage');

  // `exit 0` inside a step ends that step and nothing else - the step after it runs anyway, so
  // the checkout would still run and still consume the room. Standing the *job* down therefore
  // needs the verdict carried in a step output that gates the work that follows it.
  assert.match(guard, /GITHUB_OUTPUT/,
    'the verdict must be published as a step output, or `exit 0` just moves on to the checkout');
  const id = (/id:\s*([A-Za-z0-9_-]+)/.exec(guard) || [])[1];
  assert.ok(id, 'the guard step needs an `id` for the later steps to read its output');

  // Read the gate as text rather than with a regular expression: the verdict is the word
  // `room` in an `if:` on the step that would otherwise run.
  const gateName = 'steps.' + id + '.outputs.';
  function gated(text) {
    return text.split(String.fromCharCode(10)).some(function (line) {
      return line.indexOf(gateName) !== -1 && line.indexOf("'true'") !== -1;
    });
  }
  assert.ok(gated(texts[checkoutAt]),
    "the checkout must be gated on the guard's verdict, or the bytes are spent regardless");
  const workAt = texts.findIndex(function (t) { return /Rebase and arm/.test(t); });
  assert.notStrictEqual(workAt, -1, 'the job must still have its `Rebase and arm` step');
  assert.ok(workAt > guardAt, 'the work must come after the guard');
  assert.ok(gated(texts[workAt]),
    "the rebase must be gated on the same verdict: a checkout that was skipped leaves nothing to rebase");
});

// #1651: the guard decides whether to spend the bytes a checkout needs, from a number
// `df` may be unable to print at all. A filesystem it cannot measure answers with a dash
// or `n/a` in the Available column, and that success is not a reading of zero: the
// guard's own rule is that unmeasurable runs the batch, because a tick that stands itself
// down on a figure it could not read is a silent outage that reports green. Reading the
// step as text cannot tell those two apart - `0 MB free` and `could not read the figure`
// both look like a working guard - so the step is executed against a `df` this test owns.
function guardScript() {
  const yml = fs.readFileSync(path.join(ROOT, '.forgejo/workflows/auto-rebase.yml'), 'utf8');
  const job = jobBlocks(yml).find(function (j) { return j.name === 'rebase'; });
  assert.ok(job, 'auto-rebase.yml must still have a `rebase` job');
  const texts = steps(job.lines).map(function (s) { return s.text; });
  const guard = texts.find(function (t) { return /df\s+-Pk/.test(t); });
  assert.ok(guard, 'the job must still measure free space with `df -Pk`');
  const lines = guard.split('\n');
  const at = lines.findIndex(function (l) { return /^\s*run:\s*\|\s*$/.test(l); });
  assert.notStrictEqual(at, -1, 'the guard step must still have a `run: |` block');
  const body = lines.slice(at + 1);
  const indent = Math.min.apply(null, body.filter(function (l) { return l.trim(); })
    .map(function (l) { return l.match(/^ */)[0].length; }));
  return body.map(function (l) { return l.slice(indent); }).join('\n') + '\n';
}

// Run the guard with a `df` that answers exactly `rows` (or fails, when `exitStatus` is
// set), and report its verdict. Null when there is no shell to run it in: the step only
// ever runs on a Linux runner, so a host without `bash` skips rather than fails.
function runGuard(rows, exitStatus) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-guard-'));
  function posix(p) { return p.split(String.fromCharCode(92)).join('/'); }
  try {
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    const shim = exitStatus
      ? '#!/bin/sh\nexit ' + exitStatus + '\n'
      : '#!/bin/sh\ncat "$(dirname "$0")/rows"\n';
    fs.writeFileSync(path.join(bin, 'df'), shim);
    fs.chmodSync(path.join(bin, 'df'), 0o755);
    if (rows) fs.writeFileSync(path.join(bin, 'rows'), rows.join('\n') + '\n');
    const script = path.join(dir, 'guard.sh');
    fs.writeFileSync(script, guardScript());
    const outFile = path.join(dir, 'verdict');
    const run = spawnSync('bash', [posix(script)], {
      encoding: 'utf8',
      timeout: 30000,
      env: Object.assign({}, process.env, {
        GITHUB_WORKSPACE: posix(dir),
        GITHUB_OUTPUT: posix(outFile),
        PATH: posix(bin) + ':' + (process.env.PATH || '')
      })
    });
    if (run.error) return null;
    const verdict = fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8').trim() : '';
    return { status: run.status, stdout: run.stdout || '', stderr: run.stderr || '', verdict: verdict };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const DF_HEADER = 'Filesystem 1024-blocks Used Available Capacity Mounted on';

test('a `df` that cannot say how much room there is must not switch the rebase off', function (t) {
  const run = runGuard([DF_HEADER, '/dev/sda1 1000 999 n/a 99% /']);
  if (!run) return t.skip('no shell to run the guard in');
  assert.strictEqual(run.status, 0, 'the guard must end green whatever it decides, got stderr: ' + run.stderr);
  assert.match(run.verdict, /room=true/,
    'an unreadable figure is not a full disk: the batch must run, and the guard answered ' +
    JSON.stringify(run.verdict) + ' with log ' + JSON.stringify(run.stdout));
  assert.doesNotMatch(run.stdout, /\b0 MB free\b/,
    'an unmeasured figure must not be reported as a reading of zero: ' + JSON.stringify(run.stdout));
});

test('a disk with no room still stands the tick down, and says so', function (t) {
  const run = runGuard([DF_HEADER, '/dev/sda1 1000 999 1 99% /']);
  if (!run) return t.skip('no shell to run the guard in');
  assert.strictEqual(run.status, 0, 'standing down is green, not a failure');
  assert.match(run.verdict, /room=false/, '1 KB free is less than a checkout needs, so the batch must be skipped');
  assert.match(run.stdout, /Not enough disk/, 'the log must carry the reason and the issue it is standing down for');
});

test('a `df` that fails outright still runs the batch', function (t) {
  const run = runGuard(null, 1);
  if (!run) return t.skip('no shell to run the guard in');
  assert.match(run.verdict, /room=true/,
    'a command that answered nothing must not switch the workflow off silently, got ' + JSON.stringify(run.verdict));
});
