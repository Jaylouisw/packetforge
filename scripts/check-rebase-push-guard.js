'use strict';
// A maintenance job may only force-push a pull-request branch with a credential that
// will make the forge create a run for the head it mints.
//
// On 2026-11-19 (#2082) the queue filled with pull requests at zero check statuses that
// stayed there permanently. `/commits/<sha>/status` answered `state: ""`,
// `total_count: 0`, and `/actions/tasks` had no row for the sha at all - the run was
// never created, not created and cancelled. The dividing line was the credential the
// push was made with, not the branch and not the workflow: heads pushed by a pass
// holding a user token got their eight statuses inside ~25 s, and heads pushed by a pass
// holding only the run's own `github.token` got nothing. A head with no statuses can
// never be armed (`merge_when_checks_succeed` has to read a full status set) and can
// never be merged by the gate, so every such push silently removed its pull request
// from CI - and the branch, now sitting on current `main`, was never touched again, so
// nothing retried.
//
// auto-rebase.yml learned this on 2026-11-18 and refuses to push on the run token.
// pr-rebase.yml has the same force-push and did not have the same guard, and it is the
// one that fires on every push to every pull request - so it, not the batched pass, is
// where the dead heads came from (their committer is the identity it sets:
// `packetforge-bot@users.noreply.git.jayw.uk`).
//
// The rule, checked as text: a step that runs `git push --force-with-lease ... refs/heads/`
// must, earlier in the file, carry `RUN_TOKEN` in its environment and compare `TOKEN`
// against it in a branch that stops the pass (`exit 0` / `continue`) before that push.
//
// Workflows are read as text: this repository has no YAML dependency and does not want
// one. Full-line comments are stripped first, because the prose above and in the
// workflows mentions the guard and a checker that counted its own documentation as
// evidence would pass on a file that only talks about it.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const WORKFLOW_DIRS = ['.forgejo/workflows', '.github/workflows'];

function stripComments(text) {
  return text
    .split('\n')
    .filter(function (line) { return !/^\s*#/.test(line); })
    .join('\n');
}

// `git push` is written across continuation lines in both maintenance workflows, so the
// question "is this a force-push of a pull-request branch" is asked of a small window
// rather than of one line.
function forcePushes(lines) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/\bgit push\b/.test(lines[i])) continue;
    const window = lines.slice(i, i + 8).join(' ');
    if (!/--force-with-lease/.test(window)) continue;
    if (!/refs\/heads\//.test(window)) continue;
    out.push(i);
  }
  return out;
}

function audit(text, label) {
  const lines = stripComments(text).split('\n');
  const findings = [];
  for (const pushAt of forcePushes(lines)) {
    const before = lines.slice(0, pushAt);
    const hasRunToken = before.some(function (l) { return /^\s*RUN_TOKEN:/.test(l); });
    const guardAt = before.findIndex(function (l) {
      return /\$\{TOKEN\}/.test(l) && /\$\{RUN_TOKEN:?-?\}/.test(l);
    });
    if (!hasRunToken) {
      findings.push({ file: label, line: pushAt + 1, code: 'E_NO_RUN_TOKEN',
        detail: 'the force-pushing step does not carry RUN_TOKEN, so it cannot tell a user token from the run token' });
      continue;
    }
    if (guardAt === -1) {
      findings.push({ file: label, line: pushAt + 1, code: 'E_PUSH_WITHOUT_GUARD',
        detail: 'a force-push on the run token mints a head the forge creates no run for, and that head can never be armed' });
      continue;
    }
    const stops = lines.slice(guardAt + 1, guardAt + 6).some(function (l) {
      return /^\s*(exit 0|continue)\b/.test(l);
    });
    if (!stops) {
      findings.push({ file: label, line: guardAt + 1, code: 'E_GUARD_DOES_NOT_STOP',
        detail: 'the TOKEN/RUN_TOKEN comparison is not a refusal - the pass goes on to the push it just decided not to make' });
    }
  }
  return findings;
}

function workflowFiles() {
  const files = [];
  for (const dir of WORKFLOW_DIRS) {
    const full = path.join(ROOT, dir);
    if (!fs.existsSync(full)) continue;
    for (const entry of fs.readdirSync(full)) {
      if (/\.ya?ml$/.test(entry)) files.push(path.join(dir, entry).replace(/\\/g, '/'));
    }
  }
  return files;
}

function main() {
  const files = workflowFiles();
  const findings = [];
  for (const rel of files) {
    findings.push.apply(findings, audit(fs.readFileSync(path.join(ROOT, rel), 'utf8'), rel));
  }
  if (!findings.length) {
    console.log('Every force-push of a pull-request branch checks for the run token first. (' + files.length + ' workflow file(s))');
    return 0;
  }
  console.error('A maintenance job force-pushes a pull-request branch on the run token:');
  for (const f of findings) {
    console.error('  ' + f.file + ':' + f.line + '  ' + f.code);
    console.error('    ' + f.detail);
  }
  console.error('\nThe failure this prevents is not a red check: it is a pull request with');
  console.error('no checks at all, at zero statuses, that no later pass ever revisits.');
  console.error('Leave the branch as the author wrote it and say why.');
  return 1;
}

module.exports = { audit: audit, stripComments: stripComments, forcePushes: forcePushes };

if (require.main === module) process.exit(main());
