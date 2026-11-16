# Continuous integration and delivery

Everything runs on the forge (`git.jayw.uk`). There is no GitHub CI, no GitHub
Actions, and no second pipeline to keep in step — the mirror is a mirror.

This page explains what runs, what a red check means, and what to do when the
queue looks stuck. It is written from the workflows in `.forgejo/workflows/`, so
if the two disagree the workflow is right and this page is a bug.

If the forge itself is not answering — no push, no issue comment, no dispatch —
that is a different failure from a stuck queue. Start with
[`FORGE_TROUBLESHOOTING.md`](FORGE_TROUBLESHOOTING.md): a four-rung probe ladder
that separates "the backend is wedged" from "your token is wrong" in about a
minute.

## The workflows

| File | Trigger | What it does |
|---|---|---|
| `ci.yml` | pull request to `main`, push to `main`, manual dispatch | The matrix: tests on three Node versions, a live server smoke test, a Docker build |
| `auto-rebase.yml` | push to `main`, manual dispatch, and a 10-minute schedule the host never dispatches | Rebases open pull requests onto current `main` and re-arms auto-merge; stands down green, before its checkout, when the host has less than 512 MB free (#1508) |

`.github/workflows/` was deleted in #1059. While it existed, the GitHub workflow
ran on Forgejo too — and failed every time with `docker: command not found`,
because the Forgejo runner has no Docker-in-Docker. Two pipelines, one of which
could never pass.

## What a pull request goes through

Five checks on a code change, all required before a merge. A **data-only** diff is gated on the three test legs only — `smoke` and `docker` are skipped for it (*What runs, and why a device PR runs less of it*, below):

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

Two suites are randomised on purpose, and both are seeded so a failure reproduces exactly:

- `test/property-validator.test.js` — builds topologies from the real catalogue and asserts the
  connection validator never throws, that `ok` means exactly "no errors", that A→B and B→A agree,
  and that a refused `connect()` leaves nothing behind.
- `test/fuzz-importer.test.js` — mutates a real device spec four hundred ways and asserts the
  loader never throws and never invents ports.

Both print the seed with every failure. To reproduce one, use that seed in the generator at the
top of the file; nothing about the run depends on wall-clock time or on the order of the
surrounding suites.

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

## The disk the jobs share

The runner is not a container on a stranger's machine: it is on the forge host, and the
`docker` job builds against the **host daemon** through the mounted
`/var/run/docker.sock`. Its layers, its intermediate images and its build cache
therefore live on the same volume as Forgejo's database and repositories.

On 2026-11-12 that volume filled. The forge did not report "disk full" — it reported
three things that look unrelated to each other:

| What you see | What it actually is |
|---|---|
| `git push` → `error: couldn't set 'refs/heads/<branch>'` / `failed to update ref` | git cannot write a loose ref |
| API file write → `500` with `could not write config file .../local-repo/upload.git.../config: No space left on device` | the server cannot stage your commit |
| A pull request whose `Test (Node …)` jobs never appear at all | the task rows for jobs with `needs:` were never created, so the checks it is armed against cannot exist |

The third one is the expensive one: the pull request looks armed and healthy, and
nothing will ever run. A push does not fix it either — two force-pushes produced no
run, while a `workflow_dispatch` on the same branch created only the job that has no
`needs:`.

So the `docker` job now leaves the volume as it found it: it removes the image it built,
drops dangling images older than a day, bounds the builder cache with
`--keep-storage 2GB` (falling back to a plain prune on docker 20.10, which has no such
flag), and prints `docker system df` both **before** and **after** the build so a
growing disk reads as a trend in a log instead of being discovered by a rejected push.
The cleanup step carries `if: always()`, because the failure case — a build that dies
half way — is the one that leaves the most behind, and a cleanup written without it
would be skipped exactly then.

`scripts/check-ci-disk-hygiene.js` (also `npm run check:ci-disk`, and a step in the
test job) enforces the rule against every workflow file: a step that runs
`docker build` obliges the same job to prune, in a step that carries `if: always()`,
and to report `docker system df`. Prose in a comment does not count — the checker strips
full-line comments first, so documenting the rule cannot trip it.

Bounding the job stops the *next* fill; it cannot reclaim what is already gone, and a
full volume takes the forge down in four ways that look unrelated. Those four, and what
to run on the host, are in
[`FORGE_TROUBLESHOOTING.md`](FORGE_TROUBLESHOOTING.md#when-the-volume-is-full-every-retry-leaves-another-half-clone).

## Troubleshooting

| Symptom | Cause | What to do |
|---|---|---|
| Checks say *Waiting to run* for a long time | The queue is deep. Two jobs at a time against every open pull request. | Nothing to fix; push nothing and wait, or rebase to cancel your superseded run |
| A run says *cancelled* immediately | A newer commit to the same pull request superseded it | Expected. The newest run is the one that counts |
| A run on `main` says *cancelled* | Should not happen after #1076 | Open an issue — this is the bug that fix exists to prevent |
| `auto-rebase` has run but nothing moved | Every open PR was already up to date, or all rebases conflicted | Check the run log for the per-PR summary line |
| `auto-rebase` is green and did not even check out | The host was short of disk, so the tick stood down instead of spending the bytes it was waiting for | The first step prints how many MB it measured in the workspace and names the threshold; see the disk section above and #1507 |
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
- **Only badge a workflow this repository still has.** `.forgejo/workflows/` holds
  `ci.yml`, `auto-rebase.yml`, `pr-rebase.yml`, `closed-audit.yml` and `wiki-sync.yml`;
  `codeql.yml` was deleted with the move off GitHub. Forgejo renders a badge for a
  workflow it cannot find as `failure` forever — it is not a red build, it is a link
  to a file that is not there. The README carried one until #1470, which made the
  project look broken on the page every visitor lands on first.

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

| the diff touches | `Test (Node 18/20/22)` | `Server smoke test` | `Docker build` |
|---|---|---|---|
| only `devices/**/*.json`, `docs/*.md`, `research/*.json`, top-level `*.md` | three legs | skipped | skipped |
| anything else (scripts, tests, workflows, server, engine, web, config) | three legs | yes | yes |

Only the last two columns differ, and that is deliberate: there is no such thing as a data-only
test leg.

`npm test` still runs for a data-only change, and on **all three** Node versions: the diff
teaches the suite nothing, so cutting the matrix would buy speed with coverage the leg never had.
The `test` job carries that history in its own comment — a data-only `if:` that read
`matrix.node` was evaluated before the matrix existed, so every leg died about two seconds in (runs
1398, 1401, 1402), and a matrix built from an expression collapses to a single unnamed leg that
runs the suite once and reports it three times. Three versions, always. What the classifier still
saves is the pair of jobs where the slots were actually going: `smoke` and `docker` skip a
JSON-only diff entirely, ten minutes each against roughly a minute for the suite. A device spec
cannot change how the server boots or whether the image builds, and paying those two jobs to learn
that is how a two-runner host ends up with a queue that never reaches the next pull request.

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
| token-authenticated pushes being skipped | `ssh -T forgejo` reports `Hi there, jaylouisw! ... key named jay-laptop` | **ruled out** — the pushes are over **SSH with a named user key**, not an HTTP token, and the key maps to the same account whose other pushes dispatch |

### What that leaves

The event is created for other writers and not for this one, on the same repository, with the
same workflow files and the same runners, over the same protocol as some of them.

**The obvious suspect was wrong.** The first version of this page blamed token-authenticated
pushes being skipped for recursion - every CI system has a version of that rule, and it would
explain a whole credential going silent. It was checked rather than assumed:

```
$ ssh -T forgejo
Hi there, jaylouisw! You've successfully authenticated with the key named jay-laptop, ...
```

The pushes are over **SSH with a named user key**, not an HTTP token, and the key maps to the same
account whose other pushes do dispatch. So the recursion rule does not apply here, and the
remaining suspects are narrower:

1. **A repository or user setting** that suppresses runs for this actor - testable only in the UI.
2. **Something about the branch itself** - worth trying: push a commit onto a branch that
   currently *does* produce runs, and see whether the new commit runs. That single test separates
   "this credential" from "these branches", and it is the next thing to try.

### How to confirm in one look

Open any affected pull request in the web UI and look at the checks list. Then open
*Actions → Runs*:

- **no run row at all** → the event never created a run: settings or credential, not the workflow;
- **a run row stuck at "waiting"** → the scheduler never handed it to a runner: runner labels.

Run logs on this instance are behind a session login, so anyone debugging from an API token
cannot read them. That is why this section exists: the failure had to be documented somewhere a
person could find it.
