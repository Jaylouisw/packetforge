'use strict';

// #1610: the `Arm auto-merge` job reported success on every pull request and merged
// almost none of them. Two faults, each fatal on its own:
//
//   1. `gh pr merge --auto` is refused under the run's own GITHUB_TOKEN. The job treated
//      that as "auto-merge is off, merge now instead" - and the immediate merge is the
//      path that meets fault 2.
//   2. `main` requires branches to be up to date (`strict: true`). A pull request whose
//      base moved - which is nearly all of them, because the sibling loops push
//      continuously - is BLOCKED however green it is, `gh pr merge --squash` answers
//      "the head branch is not up to date", and the job warned, commented, and exited 0.
//
// A gate that cannot gate must not print the same tick as one that merged. So these tests
// run the real step from `.github/workflows/ci.yml` - extracted, not copied - against a
// stub `gh` that answers each of those refusals, and assert on what the step did and what
// it exited with. The sweep is over the *workflow file*, so a future edit that loses the
// update-branch path or turns a refusal green fails here rather than in the queue.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { jobBlocks, steps } = require('../scripts/check-ci-disk-hygiene');

const ROOT = path.join(__dirname, '..');
const NUMBER = '1608';
const HEAD = '6d6a0ec4aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

// CI runs these on ubuntu; a developer on Windows gets git-bash. A host with neither
// cannot execute a shell step, and skipping beats a false red.
const HAVE_BASH = (function () {
  const r = spawnSync('bash', ['-c', 'exit 0']);
  return r.status === 0;
})();

function armStep() {
  const yml = fs.readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8');
  const job = jobBlocks(yml).find(function (j) { return j.name === 'arm'; });
  assert.ok(job, 'ci.yml must still have the `arm` job');
  const step = steps(job.lines).find(function (s) {
    return /Merge once every check has reported green/.test(s.text);
  });
  assert.ok(step, 'the arm job must still have its merge step');
  const lines = step.text.split('\n');
  const at = lines.findIndex(function (l) { return /^\s+run:\s*\|/.test(l); });
  assert.notStrictEqual(at, -1, 'the merge step must carry a `run: |` block');
  const body = [];
  for (let i = at + 1; i < lines.length; i++) {
    if (lines[i].trim() === '') { body.push(''); continue; }
    if (!/^ {10}/.test(lines[i])) break;
    body.push(lines[i].slice(10));
  }
  assert.ok(body.some(function (l) { return /gh pr merge/.test(l); }), 'the extracted block looks empty');
  return body.join('\n');
}

const GREEN = JSON.stringify([
  { name: 'Test (Node 22)', state: 'SUCCESS', bucket: 'pass' },
  { name: 'Test (Node 24)', state: 'SUCCESS', bucket: 'pass' },
  { name: 'Typecheck', state: 'SUCCESS', bucket: 'pass' },
  { name: 'Server smoke and Docker build', state: 'SUCCESS', bucket: 'pass' },
  { name: 'Arm auto-merge', state: 'PENDING', bucket: 'pending' }
]);

const PENDING = JSON.stringify([
  { name: 'Test (Node 22)', state: 'PENDING', bucket: 'pending' },
  { name: 'Test (Node 24)', state: 'PENDING', bucket: 'pending' },
  { name: 'Typecheck', state: 'PENDING', bucket: 'pending' },
  { name: 'Arm auto-merge', state: 'PENDING', bucket: 'pending' }
]);

// Answers what `gh` answers on each of the four paths, and records every call.
const STUB = [
  '#!/bin/sh',
  'echo "$*" >> "$GH_LOG"',
  'cmd="$*"',
  'case "$cmd" in',
  '  *update-branch*)',
  '    if [ "${FAKE_UPDATE:-ok}" = "ok" ]; then echo "{\\"message\\":\\"Updating pull request branch.\\"}"; exit 0; fi',
  '    echo "X Pull request #${NUMBER} cannot be updated: merge conflict" >&2; exit 1 ;;',
  '  *"pr list"*) printf "%s" "${FAKE_PR_LIST:-}"; exit 0 ;;',
  '  *"pr comment"*) exit 0 ;;',
  '  *"pr checks"*) printf "%s" "$FAKE_CHECKS"; exit 0 ;;',
  '  *"pr merge"*)',
  '    case "$cmd" in',
  '      *--auto*)',
  '        case "${FAKE_AUTO:-refused}" in',
  '          allowed) echo squashed; exit 0 ;;',
  '          denied) echo "GraphQL: Resource not accessible by integration (mergePullRequest)" >&2; exit 1 ;;',
  '          *) echo "X Pull request #${NUMBER} is not mergeable: Auto-merge is not allowed" >&2; exit 1 ;;',
  '        esac ;;',
  '      *)',
  '        case "${FAKE_SQUASH:-ok}" in',
  '          ok) echo squashed; exit 0 ;;',
  '          behind) echo "X Pull request #${NUMBER} is not mergeable: the head branch is not up to date with the base branch" >&2; exit 1 ;;',
  '          *) echo "X Pull request #${NUMBER} is not mergeable: merge conflict" >&2; exit 1 ;;',
  '        esac ;;',
  '    esac ;;',
  '  *"workflow run"*) echo dispatched; exit 0 ;;',
  '  *"repos/"*"pulls/"*)',
  '    case "$cmd" in',
  '      *"--jq .state"*) echo "${FAKE_STATE:-open}" ;;',
  '      *"--jq .head.sha"*) echo "${FAKE_HEAD:-$HEAD_SHA}" ;;',
  '      *mergeable_state*) echo "${FAKE_DRAFT:-false},${FAKE_MERGE_STATE:-clean}" ;;',
  '      *) echo "{}" ;;',
  '    esac; exit 0 ;;',
  '  *) echo "fake gh: unhandled: $cmd" >&2; exit 97 ;;',
  'esac',
  ''
].join('\n');

function runStep(env) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arm-gate-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'gh'), STUB);
  fs.chmodSync(path.join(bin, 'gh'), 0o755);
  const script = path.join(dir, 'step.sh');
  fs.writeFileSync(script, armStep());
  const log = path.join(dir, 'gh.log');
  fs.writeFileSync(log, '');
  const runner = path.join(dir, 'runner');
  fs.mkdirSync(runner);
  const r = spawnSync('bash', [script], {
    cwd: dir,
    encoding: 'utf8',
    env: Object.assign({}, process.env, {
      PATH: bin + path.delimiter + process.env.PATH,
      GH_LOG: log,
      GITHUB_REPOSITORY: 'jaylouisw/packetforge',
      NUMBER: NUMBER,
      HEAD_SHA: HEAD,
      RUNNER_TEMP: runner,
      HAVE_PAT: 'false',
      FAKE_STATE: 'open',
      FAKE_HEAD: HEAD,
      FAKE_MERGE_STATE: 'clean',
      FAKE_CHECKS: GREEN,
      FAKE_AUTO: 'refused',
      FAKE_SQUASH: 'ok',
      GITHUB_HEAD_REF: 'fix/1127-1732',
      DISPATCHED: 'false',
      GH_TOKEN: 'stub'
    }, env)
  });
  return {
    status: r.status,
    out: (r.stdout || '') + (r.stderr || ''),
    calls: fs.readFileSync(log, 'utf8')
  };
}

function calls(result, pattern) {
  return result.calls.split('\n').filter(function (l) { return pattern.test(l); });
}

test('a green pull request that is behind its base is updated, not left for a human', { skip: !HAVE_BASH }, () => {
  // Every check green, the base moved: the old step tried `--squash`, was told the head
  // was not up to date, and exited 0. Nothing merged and nothing ran.
  const r = runStep({ FAKE_MERGE_STATE: 'behind', FAKE_SQUASH: 'behind' });
  assert.strictEqual(r.status, 0, 'updating the branch is progress, not a failure: ' + r.out);
  assert.strictEqual(calls(r, /update-branch/).length, 1,
    'the step must ask GitHub to update the branch when it is behind\n' + r.out);
  assert.strictEqual(calls(r, /pr merge/).length, 0,
    'a merge attempted before the update is the refusal this path exists to avoid\n' + r.out);
  assert.match(r.out, /updated it/i, 'the log has to say what happened: ' + r.out);
  // The push the update is made with is GITHUB_TOKEN's, and GitHub holds the run it starts
  // for an approval nobody gives (#1612: 46044715475, action_required, zero jobs). So the
  // new head is verified by a dispatch instead, and that run merges.
  assert.strictEqual(calls(r, /workflow run ci\.yml --repo \S+ --ref fix\/1127-1732/).length, 1,
    'the new head needs a run that is not held for approval\n' + r.out);
});

test('a refusal is not a green tick', { skip: !HAVE_BASH }, () => {
  // Green and up to date, and the merge is refused anyway - a conflict that appeared
  // between the checks and the merge, a protection rule this run cannot read. The step
  // used to warn, comment and exit 0: the tick that hid this for a whole migration.
  const r = runStep({ FAKE_MERGE_STATE: 'clean', FAKE_SQUASH: 'conflict' });
  assert.notStrictEqual(r.status, 0, 'a merge that did not happen must not report success\n' + r.out);
  assert.strictEqual(calls(r, /pr comment/).length, 1,
    'the reason still goes on the pull request, not only into the log\n' + r.out);
});

test('a stale clean verdict still recovers by updating the branch', { skip: !HAVE_BASH }, () => {
  // `mergeable_state` is computed asynchronously and lags a push; the squash then answers
  // "not up to date". That answer is checked for before it is treated as final.
  const r = runStep({ FAKE_MERGE_STATE: 'clean', FAKE_SQUASH: 'behind' });
  assert.strictEqual(r.status, 0, 'the fallback turned a refusal into progress: ' + r.out);
  assert.strictEqual(calls(r, /update-branch/).length, 1, 'the fallback must update the branch\n' + r.out);
});

test('a branch that cannot be updated goes red, with the reason on the pull request', { skip: !HAVE_BASH }, () => {
  const r = runStep({ FAKE_MERGE_STATE: 'behind', FAKE_UPDATE: 'conflict' });
  assert.notStrictEqual(r.status, 0, "an unupdatable branch is a person's problem, not a green tick\n" + r.out);
  assert.strictEqual(calls(r, /pr comment/).length, 1, 'and the comment says why\n' + r.out);
  assert.match(r.out, /cannot be updated|merge conflict/i, r.out);
});

test('a merge made with the run token asks for main to be verified', { skip: !HAVE_BASH }, () => {
  // GitHub starts no `push` run for a merge authored by GITHUB_TOKEN, so without a PAT the
  // new commit on main is the one commit nothing tested. An armed merge has the same
  // problem twice over: it lands after this step exits, so nothing here can follow it. The
  // merge is therefore made directly, and the step dispatches the matrix itself.
  const r = runStep({ FAKE_MERGE_STATE: 'clean', FAKE_SQUASH: 'ok' });
  assert.strictEqual(r.status, 0, r.out);
  assert.strictEqual(calls(r, /--squash --auto$/).length, 0,
    'nothing may arm a merge this step cannot see finish\n' + r.out);
  assert.strictEqual(calls(r, /--squash$/).length, 1, 'the merge is made directly instead\n' + r.out);
  assert.strictEqual(calls(r, /workflow run ci\.yml/).length, 1,
    'and main is verified afterwards, without needing a secret\n' + r.out);
});

test('a PAT that cannot arm still merges directly', { skip: !HAVE_BASH }, () => {
  // `GraphQL: Resource not accessible by integration (mergePullRequest)`: the wording the
  // job log of #1612 actually carried. It is not "auto-merge is not enabled", and the old
  // step did not recognise it - it refused, warned and exited 0 without ever trying.
  const r = runStep({ HAVE_PAT: 'true', FAKE_AUTO: 'denied', FAKE_MERGE_STATE: 'clean', FAKE_SQUASH: 'ok' });
  assert.strictEqual(r.status, 0, r.out);
  assert.strictEqual(calls(r, /--squash$/).length, 1,
    'a refused arm must still reach the direct merge\n' + r.out + '\nCALLS:\n' + r.calls);
  assert.match(r.out, /merged 6d6a0ec4/, r.out);
});

test('with a PAT the merge is armed and the matrix is not dispatched twice', { skip: !HAVE_BASH }, () => {
  const r = runStep({ HAVE_PAT: 'true', FAKE_AUTO: 'allowed' });
  assert.strictEqual(r.status, 0, r.out);
  assert.strictEqual(calls(r, /pr merge .*--auto/).length, 1, 'it must arm first\n' + r.out);
  assert.strictEqual(calls(r, /workflow run/).length, 0,
    'an armed merge has not happened yet, and its own push run verifies main\n' + r.out);
});

test('checks that have not reported are still not merged', { skip: !HAVE_BASH }, () => {
  const r = runStep({ FAKE_CHECKS: PENDING });
  assert.strictEqual(r.status, 0, r.out);
  assert.strictEqual(calls(r, /pr merge/).length, 0, 'nothing merges before the checks report\n' + r.out);
  assert.strictEqual(calls(r, /update-branch/).length, 0, 'and there is nothing to update yet\n' + r.out);
});

test('a head that moved while the run was in flight is left to its own run', { skip: !HAVE_BASH }, () => {
  const r = runStep({ FAKE_HEAD: 'ffffffffffffffffffffffffffffffffffffffff' });
  assert.strictEqual(r.status, 0, r.out);
  assert.strictEqual(calls(r, /pr merge/).length, 0, r.out);
});

test('a merged or closed pull request is stood down', { skip: !HAVE_BASH }, () => {
  const r = runStep({ FAKE_STATE: 'closed' });
  assert.strictEqual(r.status, 0, r.out);
  assert.strictEqual(calls(r, /pr merge/).length, 0, r.out);
});

test('a dispatch on a pull request branch finds its pull request and merges it', { skip: !HAVE_BASH }, () => {
  // The run the behind path dispatches carries no pull request of its own; it is the same
  // matrix on the same head, so the arm step has to find the PR by branch or the update it
  // just made would be verified by a run that refuses to act on the result.
  const r = runStep({ NUMBER: '', DISPATCHED: 'true', FAKE_PR_LIST: NUMBER });
  assert.strictEqual(r.status, 0, r.out);
  assert.strictEqual(calls(r, /pr list/).length, 1, 'it must resolve the request by branch\n' + r.out);
  assert.strictEqual(calls(r, /--squash --auto$/).length, 0,
    'an armed merge happens after this step exits, so its own commit on main can never be dispatched\n' + r.out);
  assert.strictEqual(calls(r, /--squash$/).length, 1, 'the merge is made directly instead\n' + r.out);
  assert.match(r.out, /this dispatch is for #1608/, r.out);
});

test('a dispatch on main has no pull request and stands down', { skip: !HAVE_BASH }, () => {
  const r = runStep({ NUMBER: '', DISPATCHED: 'true', FAKE_PR_LIST: '' });
  assert.strictEqual(r.status, 0, r.out);
  assert.strictEqual(calls(r, /pr merge/).length, 0, r.out);
  assert.match(r.out, /nothing to merge/, r.out);
});

test('a dispatched run does not update the branch a second time', { skip: !HAVE_BASH }, () => {
  // One update, one advertised dispatch. A dispatch that finds the branch behind again
  // must say so and stop: the alternative is a run that updates and a run that verifies,
  // forever, with nobody approving either.
  const r = runStep({ NUMBER: '', DISPATCHED: 'true', FAKE_PR_LIST: NUMBER, FAKE_MERGE_STATE: 'behind' });
  assert.notStrictEqual(r.status, 0, 'the second update is a person\'s decision\n' + r.out);
  assert.strictEqual(calls(r, /update-branch/).length, 0, r.out);
  assert.match(r.out, /PF_AUTOMERGE_TOKEN/, 'the refusal has to name the way out: ' + r.out);
});
