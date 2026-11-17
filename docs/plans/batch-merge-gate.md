# Plan: the batch-merge gate has no batch mode, and runs two of the five suites that read the tree

Status: forward plan, no code. Closes **no** open issue - the queue is five device requests
(#130, #803, #807, #808, #810), none of them about tooling. Improves a script that already
exists; the only step that adds a new obligation is step 5, and step 6 is documentation.
Scope: `scripts/premerge-check.js`, one new suite under `test/`, `docs/MAINTAINING.md:19-24`.
No engine rule, no device spec, no workflow.

Measured on `e95680c8`, 2026-11-17, with two throwaway branches built for the purpose (each
adds one eight-port switch, under two spellings of one model name, and regenerates the
registry sentence, so each branch is green on its own).

## What exists today

`scripts/premerge-check.js` (118 lines) exists because device pull requests "arrive in batches,
each green on its own base, and nothing re-tests `main` after a merge" (`:4-10`). It takes a
list of branches, and for each one builds a worktree of `origin/main` plus that branch's
changed files (`:66-72`), then runs `SUITES` in it (`:76-77`):

```js
const SUITES = ['test/hardware-invariants.test.js', 'test/spec-vs-description.test.js'];  // :27
```

Two things follow from that shape, both measured rather than argued.

**It checks one branch at a time.** The loop is `for (const branch of branches)` and the
worktree is `origin/main` + `changed` for *that* branch. Nothing ever puts two candidates in
one tree. The pair below, each green on all five catalogue suites alone, produced:

```
ok    pf-demo-a
ok    pf-demo-b

2/2 clean        (35 s)
```

The same five suites run in the tree that would exist if both merged:

| suite | pair merged |
|---|---|
| `test/hardware-invariants.test.js` | 26 passed, 0 failed |
| `test/spec-vs-description.test.js` | 3 passed, 0 failed |
| `test/catalogue-hygiene.test.js` | **23 passed, 2 failed** - `:50-51`, "every spec in the tree loads": the second spelling is refused **by the loader**, so the catalogue holds one box and a broken entry, the state `test/duplicate-models.test.js:1-17` (#60, the ASR/ISR pair) was written to prevent |
| `test/doc-catalog-counts.test.js` | **10 checks failed** - both branches regenerated the same sentence to different totals, and the survivor's number is one short |
| `test/duplicate-models.test.js` | 21 passed, 0 failed - it cannot see the pair, because `loadCatalog` already dropped the collider |

So the tool advertises the batch failure mode and is blind to it. What it *does* buy is real
but narrower: a branch green on an old base, re-verified against today's `main`. That is worth
keeping, and worth saying out loud.

**Two of five.** Five suites read the whole tree through
`loadCatalog(path.join(__dirname, '..', 'devices'))`: the four above plus `duplicate-models`.
Three are not in `SUITES`. `test/run-tests.js:8` calls `duplicate-models` "the gate that stops
two specs describing one box" - the one gate whose subject is two specs - and it is one of the
three left out.

And nothing tests the gate: `grep -rl premerge test/` returns nothing. The only mention in the
whole tree is `docs/plans/doc-citations.md:38`, which also pins `SUITES` at line 24; it is line
27 - line citations rot. `docs/MAINTAINING.md:19-24` warns in prose that "a batch that merges
while a second batch updates the same sentence" goes red, and never names the tool that could
have caught it.

## What is missing or weak, ranked

1. **No batch mode.** The incident class it was written for needs two branches in one tree; the
   tool never builds one. Measured above: `2/2 clean` on a pair whose merge is red.
2. **Three of five tree-level suites are not run**, including the identity gate. #60 is the
   precedent; nothing in this tool's list would have caught it.
3. **No test.** A mistake here fails open: a truncated list, a worktree that checked out
   nothing, a suite path that drifted - and the answer is still `N/N clean`, exit 0.
4. **Undiscoverable.** Not in `MAINTAINING.md`, not in `TRIAGE.md`, not in `CI.md`. A maintainer
   merging a queue of device pull requests has no pointer to it.
5. **The fetch is unbounded** (`:47`, `git fetch --no-tags -q origin +refs/heads/*`). #1856 and
   `docs/CI.md:105` bound every fetch in `ci.yml` (`timeout 120`, low-speed limits); this one,
   and `scripts/gh-bridge.js:281`, sit outside that policy.
6. **The report has no scope.** `4/4 clean` (`:114`) reads as "the branch is green"; it means
   "two suites, one branch, in isolation".

## Ordered steps

Each is one PR by one worker. Sizes are S/M/L.

1. **Say what it checked** (`:114`): print the suite count against the tree ("5 of 322 suites
   under `test/`, this branch alone against `origin/main`") and, on a clean run, the sentence
   that a full `npm test` is still owed. No behaviour change. **S.**
2. **Widen `SUITES` to the five tree-level suites**, each justified in the file by the property
   that makes it worktree-safe (it resolves the catalogue from its own `__dirname`, not `cwd`).
   Re-measure the runtime on three branches and put the number in the header. **S.**
3. **A `--together` mode.** Build one worktree holding every listed branch's changed files - the
   tree that would exist if all merged - and run `SUITES` there once. Report which branches
   touched the files a failing suite named; do not attempt per-branch attribution beyond that.
   Keep the per-branch mode as the default so existing habits do not change. **M.**
4. **Bound the fetch** (`:47`): `timeout 120`, and skip it when every argument already resolves
   to a local ref. Mirror the wording of `docs/CI.md:105` so the two cannot diverge. **S.**
5. **Test the gate itself**: `test/premerge-gate.test.js` builds the two synthetic branches in a
   temp clone - two spellings of one model, each green alone - and asserts the per-branch mode
   exits 0 on each and `--together` exits 1 with the failing suite's name in the output. This is
   the step that stops step 3 from being a claim. **M.**
6. **Document it**: a "Before merging a batch" subsection under `docs/MAINTAINING.md:19`, naming
   the command, the five suites, and the one thing the tool does not do. **S.**

Steps 1-4 change no engine behaviour and no test outcome. Step 5 adds a suite; it has to be in
the run before step 3 is trusted.

## Risks

* **Runtime.** 35 s for 2 suites x 2 branches, serial. Five suites x a twenty-branch queue is
  minutes, not seconds. The answer is `--together` (one tree, one pass), not parallelism; if it
  still hurts, land steps 2 and 3 in one PR so the cost is paid once.
* **A suite that is not tree-relative.** Any suite added to `SUITES` that reads `process.cwd()`
  instead of `__dirname` will quietly test `main` in every worktree. Step 2's comment and step
  5's assertion both exist for this.
* **False green is the failure mode.** Every step here makes a pass mean more; none of them
  makes a failure louder. That asymmetry is why step 5 outranks steps 3 and 4 in importance.
* **Worktrees on a shared checkout.** `pf-wt/*` already shares one object store across eleven
  worktrees; `git worktree add --detach` plus `remove --force` is the existing pattern (`:41`,
  `:90-93`), not a new one - but a killed run leaves `tmp/pfc-*` behind, which is disposable.
* **A second copy of the list.** The temptation is to repeat the five suites in a CI job. The
  list belongs in one place; a workflow that wants the same five should call the script.

## Test strategy

Step 1: `node scripts/premerge-check.js <two known branches>` and read the new line. Step 2:
`node test/run-tests.js --filter=catalogue`, plus the five suites by hand in a worktree built
from `origin/main` with one branch's files. Steps 3-5: `node test/premerge-gate.test.js`, which
is self-contained (temp clone, synthetic branches, one `git fetch` from a local path), then the
full `npm test` (322 suites) because step 5 adds one. The reproduction under "What exists today"
is the acceptance test: two branches green alone, one merged tree red, and the gate must say so.

## Issues

Closes none. #130, #803, #807, #808 and #810 are catalogue requests waiting on hardware data,
not on this. What the plan protects is the queue's landing rate: 297 of the last 300 commits on
`main` touch `devices/`, so batch composition is the normal case, and the two failures measured
here are the two the maintainer page already warns about in prose.

Deliberately not proposed: a CI job that runs the batch gate (the runner is the bottleneck
already), per-branch attribution of a merged-tree failure (guesswork dressed as a report), and
any change to the suites themselves - if `duplicate-models` cannot see a collider that
`loadCatalog` has already dropped, that is a question about the loader, and it belongs to a
plan of its own.
