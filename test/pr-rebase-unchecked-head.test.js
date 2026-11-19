'use strict';

// #2082: a pull request reached 0 check statuses and stayed there. The head had been
// force-pushed by this repository's own rebase job, and no run was ever created for it -
// `/commits/<sha>/status` answered `total_count: 0` and `/actions/tasks` had no row for
// the sha at all. A head with no statuses can never be armed (`merge_when_checks_succeed`
// is read against the status set), and because the rebased head sits on current `main`,
// no later pass revisits it. The pull request is out of CI permanently.
//
// Refusing the push when the credential is the run's own token (auto-rebase.yml, and
// pr-rebase.yml since #2085) closes the case that was measured. It cannot close the class:
// a push is evidence that the branch moved, not that a run was created, and pr-rebase.yml
// never looked. So the rule asserted here is the one that holds whatever the credential:
// after force-pushing a pull-request branch, the job checks that the head it minted got
// checks, and if none appeared in the window it puts the branch back on the head it
// replaced - which still has the checks it had.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { jobBlocks, steps } = require('../scripts/check-ci-disk-hygiene');

const ROOT = path.join(__dirname, '..');

function rebaseStep() {
  const yml = fs.readFileSync(path.join(ROOT, '.forgejo/workflows/pr-rebase.yml'), 'utf8');
  const job = jobBlocks(yml).find(function (j) { return j.name === 'rebase'; });
  assert.ok(job, 'pr-rebase.yml must still have a `rebase` job');
  const found = steps(job.lines).find(function (s) { return /Rebase if behind, then arm/.test(s.text); });
  assert.ok(found, 'pr-rebase.yml must still have its `Rebase if behind, then arm` step');
  return found.text;
}

function at(text, needle, label) {
  const i = text.indexOf(needle);
  assert.notStrictEqual(i, -1, label);
  return i;
}

test('the rebase job checks that the head it pushed got checks', () => {
  const text = rebaseStep();
  const push = at(text, 'origin "HEAD:refs/heads/${head_ref}"',
    'a force-push of the pull-request branch must still be here');
  const sha = at(text, 'pushed_sha=$(git rev-parse HEAD)',
    'the head this pass pushed must be named: the old head is still in `head_sha`, so a poll on it answers about the commit that was fine before');
  const poll = at(text, '/commits/${pushed_sha}/status',
    'after the push the job must ask the forge whether the head it minted has any checks; that is the difference between a rebase and a pull request in CI');
  assert.ok(sha > push, 'the pushed head must be read after the push that minted it');
  assert.ok(poll > sha, 'the status poll must be of the head this pass pushed, not of the one it replaced');
});

test('a head the forge created no run for is put back, not left unchecked', () => {
  const text = rebaseStep();
  const poll = at(text, '/commits/${pushed_sha}/status', 'the job must still poll the pushed head');
  const zero = at(text, '[ "${reported:-}" = "0" ]',
    'the zero-status answer must be a branch of its own: it is the condition this repair exists for');
  const restore = at(text, '--force-with-lease="refs/heads/${head_ref}:${pushed_sha}"',
    'putting the branch back must be leased to the head this pass pushed, or it overwrites a push that landed meanwhile');
  assert.ok(zero > poll, 'the zero-status branch must read the answer the poll produced');
  assert.ok(restore > zero, 'the restore must happen only on the zero-status answer');

  // Back to the head that had checks - the one this pass replaced - not to some other commit.
  const window = text.slice(restore, restore + 400);
  assert.match(window, /origin "\$\{head_sha\}:refs\/heads\/\$\{head_ref\}"/,
    'the restore must push the pre-rebase head (`head_sha`), the only commit in this job known to have reported checks');

  // The step must stop after restoring: falling through arms a pull request against a
  // head the job just decided has no checks, or polls a mergeable state for a head that
  // is no longer the branch tip.
  const rest = text.slice(restore);
  const stop = rest.search(/^\s*exit 0\s*$/m);
  assert.notStrictEqual(stop, -1, 'the restore path must end the step');
  const arm = rest.indexOf('checks_green "$head_sha"');
  assert.ok(arm === -1 || stop < arm, 'the step must not reach the arming code after restoring the branch');
});

test('arming after a checked push names the head that exists', () => {
  const text = rebaseStep();
  const sha = at(text, 'head_sha="$pushed_sha"',
    'once the pushed head is known to be checked, arming must be about that head: `head_commit_id` from the pre-push sha makes the arm a stale decision');
  const arm = at(text, 'merge_when_checks_succeed', 'the job must still arm');
  assert.ok(sha < arm, 'the head must be updated before the arming payload that names it is built');
});
