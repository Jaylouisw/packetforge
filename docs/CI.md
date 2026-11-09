# Continuous integration and delivery

Everything runs on the forge (`git.jayw.uk`). There is no GitHub CI, no GitHub
Actions, and no second pipeline to keep in step — the mirror is a mirror.

This page explains what runs, what a red check means, and what to do when the
queue looks stuck. It is written from the workflows in `.forgejo/workflows/`, so
if the two disagree the workflow is right and this page is a bug.

## The workflows

| File | Trigger | What it does |
|---|---|---|
| `ci.yml` | pull request to `main`, push to `main`, manual dispatch | The matrix: tests on three Node versions, a live server smoke test, a Docker build |
| `auto-rebase.yml` | every 10 minutes, manual dispatch | Rebases open pull requests onto current `main` and re-arms auto-merge |

`.github/workflows/` was deleted in #1059. While it existed, the GitHub workflow
ran on Forgejo too — and failed every time with `docker: command not found`,
because the Forgejo runner has no Docker-in-Docker. Two pipelines, one of which
could never pass.

## What a pull request goes through

Five checks, all required before a merge:

| Check | Catches |
|---|---|
| `Test (Node 18)` | Syntax or API that only works on newer Node. The floor is 18. |
| `Test (Node 20)` | Nothing Node 18 and 22 together cannot — kept for the middle of the support window |
| `Test (Node 22)` | Behaviour that regressed on the newest runtime |
| `Server smoke test` | A server that boots but cannot serve: every API route, the catalogue, WebSocket upgrade |
| `Docker build` | A `Dockerfile` that does not build. Present as a syntax/build proxy, not a full image test |

The test job runs the whole suite — `scripts/run-tests.js` discovers every
`test/*.test.js` — plus `audit:ports`, `check:bytes`, `syntax-check` and the
canonical-URL check.

### Running the same checks locally

```bash
npm test              # every suite, the same entry point CI uses
npm run syntax        # syntax-check across every JS file
npm run smoke         # starts the server, exercises every route, shuts down
docker build -t pf .  # exactly what the Docker job does
npm run audit:ports   # per-port type audit
```

If `npm test` is green locally and CI is red, check the Node version: CI runs 18
as well as 22, and a newer-than-18 API — `Array.prototype.findLast`,
`structuredClone`, `Object.groupBy` — is the usual culprit. `scripts/check-node-surface.js`
runs before the matrix precisely so that failure is named instead of mysterious.

## Concurrency: what gets cancelled and what does not

```yaml
concurrency:
  group: ci-${{ github.workflow }}-${{ github.event.pull_request.number || github.sha }}
  cancel-in-progress: ${{ github.event_name == 'pull_request' }}
```

Two runs of **one pull request** are the same question asked twice, so a rebase or
amend cancels the run it superseded. Without this, every force-push leaves a dead
run in the queue that still executes and still reports on a commit nobody will
merge.

Two runs **on `main`** are different questions — each verifies a different commit —
so they are grouped by commit and never cancel one another. This matters more than
it sounds: grouping pushes by branch instead, which is what `github.ref` gives you,
meant that a burst of merges cancelled its own verification and `main` went
untested. See #1076.

Every job also carries a `timeout-minutes` bound. A hung job on a single runner is
not a slow job, it is a stopped queue — and indistinguishable from a merely busy
one.

## Merging

Pull requests are armed with squash auto-merge as soon as `mergeable` settles,
which the forge computes asynchronously. A green check on a stale base proves
nothing: rebase first, let CI re-run against the current tree, then arm. #776
merged green off a stale base and took `main` red for hours.

Merge commits are not used. One pull request becomes one commit on `main`.

## The runner

Self-hosted, running on the forge host, `capacity: 2` — two jobs at a time.
That number is the throughput ceiling of the entire project. Measured on the same
host, same day:

| capacity | job starts | mean job duration | effective throughput |
|---|---|---|---|
| 1 | ~1.1 / min | ~50 s | 1.0× |
| 2 | ~2.2 / min | ~63 s | ~1.6× |

The second slot is not free: jobs take about a quarter longer when two run at once,
because they compete for the same disk and the same forty cores. Two slots still
beat one, but by roughly 1.6× rather than 2×, and the load average roughly doubles.
Watch memory rather than CPU if you raise it again — the host is shared with other
services, and a job that has to swap makes the whole queue slower.

## Troubleshooting

| Symptom | Cause | What to do |
|---|---|---|
| Checks say *Waiting to run* for a long time | The queue is deep. Two jobs at a time against every open pull request. | Nothing to fix; push nothing and wait, or rebase to cancel your superseded run |
| A run says *cancelled* immediately | A newer commit to the same pull request superseded it | Expected. The newest run is the one that counts |
| A run on `main` says *cancelled* | Should not happen after #1076 | Open an issue — this is the bug that fix exists to prevent |
| `auto-rebase` has run but nothing moved | Every open PR was already up to date, or all rebases conflicted | Check the run log for the per-PR summary line |
| A check fails only in CI | Node version, or a path that differs on Linux | Run `npm test` on Node 18; check case-sensitivity in file paths |

## Known gaps

- **Pushed runs are starved behind pull-request work.** This is the root of most of
  the gaps below, and it was measured rather than guessed: twenty-seven push runs
  did start today, but only when the queue was otherwise empty. During a merge
  burst, every push run for the same commits — `ci.yml`, `auto-rebase` and two
  probe workflows differing only in their `permissions:` block — sat at `waiting`
  with `started` at epoch 0 and was never handed to a runner. It is not permissions
  and not specific to one workflow. **Consequence: `main` is verified and stale pull
  requests are rebased only when nothing else is queued — that is, never on the days
  you need it.** Until this is fixed on the host, treat post-merge verification as
  best-effort and run the suite locally before trusting `main`.
- **`main` is verified only when a run survives to completion.** Post-merge runs
  are queued behind every open pull request, so on a busy day the default branch
  trails. See above for the measured shape of it.
- **Throughput is one runner.** Capacity 2 is a ceiling of roughly 26 merged pull
  requests an hour; the backlog is larger than that.
- **`auto-rebase` runs on merge, not on a clock.** On this instance, scheduled and
  manually dispatched runs are created with their job rows and then never handed to
  a runner — `started` stays at epoch 0 forever, while pull-request runs dispatch
  normally and push runs dispatch only when the queue is idle. So the workflow
  triggers on `push` to `main`, which is the
  moment every open pull request becomes stale anyway. The schedule remains in the
  file as a safety net and does nothing; that is a dispatcher bug on the host, not a
  workflow bug, and it is worth knowing before you spend an evening reading YAML.
- **A stale pull request costs more than a fresh one.** Heads that predate #1059
  still carry `.github/workflows/`, so their runs include a CodeQL job and a Docker
  job that cannot pass here — three wasted jobs out of eight, on a queue that is the
  bottleneck. Rebasing removes them. That is the cheapest single thing you can do
  for the queue's health.

## Reporting a problem with CI itself

Open an issue with the workflow run URL, and include:

```bash
# what the queue looks like from the inside, if you have access
docker logs --tail 50 forgejo-runner
```

The web UI is not enough on its own: a run that never started looks identical to a
run that is waiting its turn, and only the difference tells you which bug you have.

## The automation token

Three workflows need to write: `auto-rebase.yml`, `pr-rebase.yml` and `wiki-sync.yml`. The
automatic Actions token is enough to read the API and to arm a merge, but it is scoped tightly
enough that pushing a branch with it is unreliable — and a rebase that cannot be pushed is the
whole job.

So the write token lives in a repository secret named **`FORGEJO_TOKEN`**
(*Settings → Actions → Secrets*). Both rebase workflows read it with a fallback chain:

```yaml
TOKEN: ${{ secrets.FORGEJO_TOKEN || secrets.GITHUB_TOKEN || github.token }}
```

If the secret is missing the workflow still runs, notices the empty token, warns, and exits
**successfully** — see below.

### Why a maintenance job never fails a pull request

A red ✗ on a pull request means "this change is broken". The rebase job failing means "the
automation could not do its housekeeping", which is not the contributor's problem and which they
cannot act on. So every failure path in `pr-rebase.yml` prints a `::warning::` and exits 0:

| situation | what happens |
|---|---|
| no token available | warns, exits green, names the secret to set |
| branch moved under the rebase | warns, exits green, branch untouched |
| rebase conflicted | comments the conflicting files, exits green, branch untouched |
| `mergeable` never settles | warns, exits green, not armed this time |

The one thing that does go red is the job itself failing before it can report a reason, which is
a defect worth seeing.

### Reading a failure when the logs are behind a login

Run logs on this instance are served behind a session login, so a failed run is unreadable to
anyone who is not signed in — including anyone debugging from an API token. That makes a red check
useless as a bug report, so `pr-rebase.yml` carries a final step that runs only on failure and
posts the collected note as a comment on the pull request. The comment says the automation failed,
that it is not the contributor's change, and that nothing was pushed.

If the job fails before that note exists, the comment says so explicitly rather than posting an
empty block.

## What runs, and why a device PR runs less of it

`ci.yml` starts with a **`Classify the change`** job. It diffs the pull request against its
base and answers one question: can this diff change runtime behaviour?

| the diff touches | Node matrix | smoke test | Docker build |
|---|---|---|---|
| only `devices/**/*.json`, `docs/*.md`, `research/*.json`, top-level `*.md` | **Node 20 only** | skipped | skipped |
| anything else (scripts, tests, workflows, server, engine, web, config) | 18 / 20 / 22 | yes | yes |

`npm test` still runs for a data-only change, so every catalogue invariant is still checked —
once instead of three times. A device spec cannot change how the server boots or whether the
image builds, and paying five runner slots to learn that is how a two-runner host ends up with a
queue that never reaches the next pull request.

The classifier is deliberately hostile to the "skip" answer (`scripts/classify-change.js`):

- an **empty** diff is a code change — nothing to inspect is not evidence of safety;
- an **unknown base sha** (shallow clone, force-push, new branch) is a code change;
- only `<vendor>/<model>.json` under `devices/` counts as data — `devices/registry.js` and
  `devices/cisco/README.md` do not;
- `test/`, `scripts/` and `.forgejo/` are never data, because those are the changes that can
  make CI lie about itself.

`test/classify-change.test.js` asserts each of those, including the mixed-diff case.

## Known issue: some pushes create no workflow runs at all

Observed 2026-11-09, unresolved, recorded here because a log nobody can read is not a report.

### What happens

Pull requests opened and merged through the API, from a branch pushed over HTTPS with a
repository token, produce **no workflow runs and no task rows**. Not "queued forever", not
"started and failed" — nothing is created. The commit statuses on the pull request stay
`pending` for every check, because nothing ever reports them.

At the same time, pushes from another writer on the same repository, same account and same
two-runner host dispatch normally and finish in about a minute.

### What was ruled out

| hypothesis | how it was tested | result |
|---|---|---|
| runner starvation | `actions/tasks` during the window | **ruled out** — 0 waiting, 2 running, jobs starting within seconds |
| the concurrency group | runs from the same period on other branches | **ruled out** — they dispatch under the same group key |
| a multi-clause `if:` guard | reverted it in #1172 | **no change** — still nothing dispatched |
| data-only gating (`changes` job) | the probe PRs predate and postdate #1174 | **ruled out** — an empty-commit probe also produced nothing |
| pull-request `head` format | probe opened with `jaylouisw:branch` and without | **ruled out** — identical result |
| the workflow files themselves | identical files run fine for other branches | **ruled out** |
| only pull requests affected | checked the merge of #1175 to `main` | **no push run either** — so it is every event from this credential |

### What that leaves

The event is created for other writers and not for this one, on the same repository, with the
same workflow files and the same runners. The remaining suspects are all server-side and need
access this project does not have from the API:

1. **Token-authenticated pushes being skipped.** Some runners deliberately skip workflow runs
   for commits pushed with the CI token to avoid recursion. If the *push* credential is the same
   token the workflows consume, every event from it can be dropped. Try pushing with a different
   credential (SSH key or a second token) and see whether runs appear.
2. **A repository or user Actions setting** that suppresses runs for this actor.

### How to confirm in one look

Open any affected pull request in the web UI and look at the checks list. Then open
*Actions → Runs*:

- **no run row at all** → the event never created a run: settings or credential, not the workflow;
- **a run row stuck at "waiting"** → the scheduler never handed it to a runner: runner labels.

Run logs on this instance are behind a session login, so anyone debugging from an API token
cannot read them. That is why this section exists: the failure had to be documented somewhere a
person could find it.
