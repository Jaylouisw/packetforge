#!/usr/bin/env node
'use strict';

// Check device pull requests against the invariants before merging them.
//
// Why this exists: device PRs arrive in batches, each green on its own base, and
// nothing re-tests `main` after a merge. A defect therefore appears only once
// several have landed together — four rounds of it now, twenty-one devices with a
// 10G port marked `connector: "sfp"`, and ten whose description never mentions the
// PoE port they pass through. By the time CI notices, it is noticing about `main`.
//
// So: build the tree that would exist if this branch merged, and run the two
// invariant suites against it. Those suites are the source of truth — this script
// does not reimplement their rules, it runs them.
//
// Usage:
//   node scripts/premerge-check.js <branch> [<branch> ...]
//   node scripts/premerge-check.js --range origin/main..origin/some-branch
//
// Exit code is 0 when every branch is clean, 1 when any is not.

const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SUITES = ['test/hardware-invariants.test.js', 'test/spec-vs-description.test.js'];

function git(args, opts = {}) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
}

function main(argv) {
  const branches = argv.filter((a) => !a.startsWith('--'));
  if (branches.length === 0) {
    console.error('usage: node scripts/premerge-check.js <branch> [<branch> ...]');
    return 2;
  }

  const repo = git(['rev-parse', '--show-toplevel']).trim();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pfc-'));
  const results = [];

  // Fetch once, not per branch: a fetch per branch dominated the runtime when this
  // checked twenty-four of them, and none of them change during the run. All heads,
  // not just main, so a branch name resolves without a local checkout.
  git(['fetch', '--no-tags', '-q', 'origin', '+refs/heads/*:refs/remotes/origin/*']);

  for (const branch of branches) {
    let ref = branch;
    if (!branch.startsWith('origin/') && !branch.startsWith('refs/')) {
      try {
        git(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}^{commit}`]);
        ref = `origin/${branch}`;
      } catch {
        // not a remote branch; let git report the failure below
      }
    }
    let worktree = null;
    try {
      // The tree a merge would produce: current `main`, then this branch's changed
      // files laid over it. The merge base is the wrong starting point — it is as old
      // as the branch, so it still contains defects that `main` has since fixed, and
      // the run would report failures that belong to the branch only by accident.
      const mergeBase = git(['merge-base', 'origin/main', ref]).trim();
      const changed = git(['diff', '--name-only', '--diff-filter=d', mergeBase, ref])
        .split('\n')
        .filter(Boolean);
      worktree = path.join(tmp, `wt-${results.length}`);
      git(['worktree', 'add', '--detach', '-q', worktree, 'origin/main']);
      if (changed.length > 0) {
        git(['-C', worktree, 'checkout', '-q', ref, '--', ...changed]);
      }

      const failures = [];
      for (const suite of SUITES) {
        const run = spawnSync(process.execPath, [suite], { cwd: worktree, encoding: 'utf8' });
        if (run.status !== 0) {
          const lines = `${run.stdout || ''}${run.stderr || ''}`.split('\n');
          const detail = lines
            .filter((l) => /✗|FAIL|Error/.test(l))
            .slice(0, 6)
            .join('\n    ') || lines.slice(-4).join('\n    ');
          failures.push({ suite, detail });
        }
      }
      results.push({ branch, ok: failures.length === 0, failures });
    } catch (error) {
      results.push({ branch, ok: false, error: String(error.message || error).split('\n')[0] });
    } finally {
      if (worktree) {
        try {
          git(['worktree', 'remove', '--force', worktree]);
        } catch {
          /* best effort; the temp dir is disposable */
        }
      }
    }
  }

  let bad = 0;
  for (const r of results) {
    if (r.ok) {
      console.log(`ok    ${r.branch}`);
      continue;
    }
    bad += 1;
    console.log(`FAIL  ${r.branch}${r.error ? ` — ${r.error}` : ''}`);
    for (const f of r.failures || []) {
      console.log(`  ${f.suite}`);
      console.log(`    ${f.detail}`);
    }
  }
  console.log(`\n${results.length - bad}/${results.length} clean`);
  return bad === 0 ? 0 : 1;
}

process.exitCode = main(process.argv.slice(2));
