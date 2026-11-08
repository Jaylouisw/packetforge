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

- **`main` is verified only when a run survives to completion.** Post-merge runs
  are queued behind every open pull request, so on a busy day the default branch
  trails.
- **Throughput is one runner.** Capacity 2 is a ceiling of roughly 26 merged pull
  requests an hour; the backlog is larger than that.
- **`auto-rebase` runs on merge, not on a clock.** On this instance, scheduled and
  manually dispatched runs are created with their job rows and then never handed to
  a runner — `started` stays at epoch 0 forever, while pull-request and push runs
  dispatch normally. So the workflow triggers on `push` to `main`, which is the
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
