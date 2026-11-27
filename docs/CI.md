# Continuous integration and delivery

The gates run on **GitHub Actions**: `.github/workflows/ci.yml`, on
`github.com/jaylouisw/packetforge`. That file is the pipeline of record. The workflow
of the same name in `.forgejo/workflows/` is kept as a **read-only archive** — it is
where the measurements quoted on this page were taken, and it still runs if the
Forgejo repository is ever un-archived, but it gates nothing today.

This page explains what runs, what a red check means, and what to do when a run does
not start. It is written from `.github/workflows/ci.yml`, so if the two disagree the
workflow is right and this page is a bug.

Nothing here is about the simulator itself — see [`ARCHITECTURE.md`](ARCHITECTURE.md)
for that. If a *push*, an API call or a dispatch produces no run at all, that is a
different failure from a red check: the last section of this page separates the two.

## The workflows

| File | Trigger | What it does |
|---|---|---|
| `.github/workflows/ci.yml` | pull request to `main`, push to `main`, manual dispatch | The matrix — the suite on Node 22 and 24 — a `Typecheck` job, a live server smoke test, a Docker build — and, on an open pull request, a final `Arm auto-merge` job that merges it once every other check has reported green — and, for a green head that is behind `main`, updates the branch and dispatches `ci.yml` on it so the new head is verified before it merges (#1725, #1612) |
| `.forgejo/workflows/ci.yml` | *(archive)* | The same five checks, written for the self-hosted Forgejo runner. Kept for its comments; never named by a branch protection rule |
| `.forgejo/workflows/auto-rebase.yml` | *(archive)* | Rebases open pull requests onto current `main` and re-arms auto-merge only for a head whose reported checks are all green (#1508, #2180). The green half now lives in `ci.yml`'s `Arm auto-merge`, which updates the branch and dispatches `ci.yml` on the new head (#1612); the half that touched a head whose checks were not green has not come over |
| `.forgejo/workflows/pr-rebase.yml` | *(archive)* | The rebase that used to run on every push to a pull request. Not ported yet (`CONTRIBUTING.md` says what a contributor does instead) |
| `.forgejo/workflows/closed-audit.yml` | *(archive)* | Matches recently closed requests against the catalogue; a report, never a red build. Not ported yet |
| `.forgejo/workflows/close-merged-issues.yml` | *(archive)* | The issue sweep described under *What a merge closes*. Not ported yet: GitHub closes `Fixes #N` in a pull request body on its own, and the `[Device]:` sweep is the part still to bring over |
| `.forgejo/workflows/main-health.yml` | *(archive)* | Opens one tracking issue per red `main`. Not ported yet |
| `.forgejo/workflows/wiki-sync.yml` | *(archive)* | Mirrors `docs/wiki/*.md` into the separate wiki repository. Not ported yet |

`.github/workflows/` was deleted in #1059 and came back with this port. While it was
gone the GitHub workflow that used to live there ran on Forgejo too — and failed every
time with `docker: command not found`, because that runner had no Docker-in-Docker.
Two pipelines, one of which could never pass. The reason is now inverted: the
self-hosted runner's copy is the one nothing runs, and `ubuntu-latest` provides the
daemon the Docker job needs.


## What a pull request goes through

Five verification checks on a code change, all of which must be green before a merge. A **data-only** diff is gated on the two test legs, the typecheck and the syntax sweep — `Server smoke and Docker build` reports success without building anything, while `Syntax check (all JS)` reads every JavaScript file whether the diff touched data or code. The fourth of the five is one job, not two (#2219): the smoke client runs beside the image build in the same slot, and the job's `::error` titles still name which of the two checks went red. One more job status sits alongside them and is not a check on the diff: `Arm auto-merge`, which is the merge decision itself (*Merging*, below). There is no classifier job: the data-only question is asked inside the job that spends its answer, the first step of `Server smoke and Docker build`, and the test legs run for every diff (`What runs, and why a device PR runs less of it`, below, says why):

| Check | Catches |
|---|---|
| `Test (Node 22)` | Syntax or API that only works on newer Node. The floor is 22.18 and this is the leg that holds it — the oldest runtime that can run a `.ts` file with no build step (`docs/TYPESCRIPT.md`) |
| `Test (Node 24)` | Behaviour that regressed on the newest runtime in the window |
| `Typecheck` | A type error, an `any`, or a `require()` CommonJS cannot resolve (`tsc --noEmit`, then `scripts/check-no-any.ts`, then `scripts/check-module-paths.ts`). One answer about one tree, so one job — not a copy per Node version |
| `Server smoke and Docker build` | A server that boots but cannot serve (every API route, the catalogue, WebSocket upgrade) **or** a `Dockerfile` that does not build. One status, two checks: the smoke client runs beside the image build in the same job, and the failure titles still separate them. Runs on the Node 22 line `actions/setup-node` provides and asserts the 22.18 floor against it (`scripts/check-node-floor.js`) — a runtime below that line cannot load `engine/segment.ts` (#2488). Present as a build-syntax proxy, not a full image test |
| `Syntax check (all JS)` | A file the oldest parser in the window cannot read. `node --check` over every `*.js` file under `engine`, `server`, `devices`, `web`, `scripts`, `examples` and `test` — 577 of them, eight at a time — with the 22.18 floor asserted first (`scripts/check-node-floor.js`). A job of its own rather than a step of a test leg: overlapping the Node 22 suite it cost that leg a third of its speed (#1634) |

The test job runs more than the suite (`ci.yml`, the `test` job):

- `npm test` — `audit:ports`, then `audit:devices`, then `check:bytes`, then every
  `test/*.test.js` **and** `test/*.test.ts` that `scripts/run-tests.js` discovers;
- `scripts/check-node-surface.js` — no API newer than Node 18 (stricter than the declared 22.18 floor, on purpose), in every `.js`, `.mjs`, `.cjs` and `.ts` file, because `node` runs all four;
- `scripts/check-canonical-urls.js` — every project URL points at the project's canonical home;
- `scripts/check-ci-disk-hygiene.js` — every job that builds an image bounds what it writes;
- `examples/build-examples.js`, then `scripts/missing-devices.js examples --no-issues`, which
  cross-checks every model the built labs name.

The syntax sweep has a job of its own. `scripts/syntax-check.js` is the local superset; in CI the
same idea runs as a `node --check` over every `*.js` file, on the **Node 22 parser** — the oldest
parser that has to accept this tree. Until #1634 it started inside the Node 22 test leg and
overlapped `run-tests.js` on the same four-core runner: eight parser processes beside four suite
workers, and the suite paid for it — run 46063039819 ran the same 505 suites at the same four
workers in 97.1 s on the leg that swept syntax beside them and 62.8 s on the leg that did not,
with individual suites 2-3x slower (`acl-data` 1486 ms against 622 ms) and the I/O-bound ones
unchanged. It is `Syntax check (all JS)` now, its own runner: same 577 files, same `node --check`,
same 120 s bound with its `::error` title. It stands down for a closed pull request like its
siblings, and `Arm auto-merge` names it in `needs:` so the gate still waits for it.

The `typecheck` job is separate and adds the three things nothing else can check: `tsc --noEmit`
over the TypeScript the repository has written, `scripts/check-no-any.ts` over the same files, and
`scripts/check-module-paths.ts` over every `require()` in the tree. All three are properties of one
tree, so they are one job and one answer, not a copy per Node version; the resolver is there rather
than in a test leg for the same reason `tsc` is. It prints one note every run —
`engine/lag.ts:131 require('./iface-name')`, which resolves today and breaks the day
`iface-name.js` becomes `.ts` — and exits 0 on it, so the step asserts *0 unresolvable
specifiers* and leaves the latent one visible on every pull request. It is the only job in this
workflow that installs anything
— `typescript` is the repository's only devDependency. What that toolchain is, and why there is no
build step, is [`TYPESCRIPT.md`](TYPESCRIPT.md); it is the page to read before writing a line of it.

This paragraph used to name only the suite, `audit:ports`/`check:bytes`, the syntax check and the
canonical-URL check, and it omitted `audit:devices` — a script `CHANGELOG.md` has advertised since
it was written but that no job ran (`docs/plans/catalogue-audit-agreement.md`). It left out the Node-surface, disk-hygiene, example-lab and catalogue steps, and
its silence on the disk-hygiene check contradicted the shared-disk section below, which calls that
script "a step in the test job".

### Running the same checks locally

```bash
npm test                                # audit:ports, audit:devices, check:bytes, then every suite — what CI runs
npm run syntax                          # syntax-check across every JS and TS file
npm run typecheck                       # tsc --noEmit, then the scan that bans `any`
npm run check:no-any                    # just the `any` scan
npm run check:module-paths              # every require() resolves the way CommonJS will
node scripts/check-node-surface.js      # no API newer than the Node 18 floor
node scripts/check-canonical-urls.js    # every project URL points at the project's canonical home
npm run check:ci-disk                   # every image-building job bounds what it writes
npm run examples                        # build & verify the example labs
npm run missing:devices                 # every model those labs name exists in the catalogue
npm run smoke                           # starts the server, exercises every route, shuts down
docker build -t pf .                    # exactly what the Docker job does
npm run audit:ports                     # per-port type audit
npm run audit:devices                   # cage/optics accuracy over the whole catalogue
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

If `npm test` is green locally and CI is red, check the Node version: CI runs 22 and 24, and
a newer-than-22 API — `Promise.try`, `RegExp.escape`, `Error.isError` — is the usual culprit.
`scripts/check-node-surface.js` runs in every leg, ahead of the suite, precisely so that failure
is named instead of mysterious. It still bans everything newer than **Node 18**, which is now
stricter than the declared floor rather than equal to it: the floor moved to 22.18 for type
stripping, and the surface guard was deliberately not loosened with it, because a gate that
widens whenever a number changes is not a gate.

If a `.ts` file behaves differently under `node` than under `tsc` says it should, that is the
`Typecheck` job's business, not the matrix's: the two run the same file through different
readers. See [`TYPESCRIPT.md`](TYPESCRIPT.md).

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

Every job also carries a `timeout-minutes` bound — 5 on `arm`, 10 on `test`,
`Typecheck`, `Server smoke and Docker build` and `Syntax check (all JS)`. On GitHub-hosted
runners that bound is enforced: a job that runs past it is killed and shows up as
`cancelled`. That is
still not the bound the checks rely on, for two reasons. A hard kill takes the log
with it, so the job-level number buys the cost of an unexplained red rather than a
diagnosis; and on the self-hosted Forgejo runner this replaced, the same key was a
label rather than a bound — measured on 2026-11-17, task 12980 (run 5238, pull #1851)
reported `Failing after 13m48s` under a five-minute job, task 10860 (run 4596) 12m45s
and task 2694 (run 1342) 27,702 s, and every second of each held all five jobs of that
pull request at `Blocked by required conditions`.

So the bound that names the failure is in the step, and there is one on the thing that
can wait. The test leg's suite gets `timeout 300`, the Docker build `timeout 180`, the
smoke client `timeout 180` (it is 11 s median and 30 s at its slowest green run, so a
slow-but-working run still passes and a hung one stops holding the job), the
`node --check` sweep `timeout 120` in its own job, and each static scan `timeout 60`. Each of those
bounds carries its own `::error title=…`, so a stalled step says which check died
instead of leaving a killed job with no log. A stalled server costs three minutes, not
an afternoon.

## Merging

Merge commits are not used. One pull request becomes one commit on `main`, and the
decision to make that commit belongs to `ci.yml`'s **`Arm auto-merge`** job - the one
job that runs after the checks it reads.

Until #1725 every gate in this repository was an *arm*. The rebase workflows POSTed
`{"Do":"squash","merge_when_checks_succeed":true}` immediately after the force-push
that rebased the branch, and the forge evaluated that flag against the checks that
existed at the moment of the call. For a head pushed seconds earlier that set is
empty, and "all checks succeeded" over nothing is true. Measured on 2026-11-16 over the
25 most recently merged pull requests (`/commits/{sha}/status`): all 25 merged before
any of their seven checks reported, 15 of them with no status at all on the head commit
at the moment of the merge. #1719 armed at 19:59:43, merged at 19:59:54, and its own
first test leg did not finish until 20:00:46 — 52 s after the commit it was testing was
on `main`. That is why an arm is never the thing that decides.

`Arm auto-merge` takes `needs: [test, docker, typecheck, syntax]` for ordering but reads
`gh pr checks` for the verdict: at least one check has reported, nothing in the set is
anything but `pass`, and both `Test (Node …)` legs are among them — a set that has not
grown them is a run that has not started, not a run that passed. The job's own check is
excluded, because it is `pending` while it runs. It re-reads `head.sha` before arming
and stands down if the head moved, so a run against a commit that has since been
rebased away cannot merge a tree this run never tested. A head that is green and
*behind* `main` is not left for a person either: `mergeable_state` is `behind`, a state
no number of green checks clears, so the job calls
`PUT .../update-branch` — with `expected_head_sha`, so a head that moved is a 422
rather than an update of a tree nobody judged — and then runs `ci.yml` on the head
ref. A dispatch, because the run a bot's own push starts is held for an approval
nobody gives (#1612). That run carries no pull request, resolves it from the branch,
and merges; it does not update the branch a second time, since that would need a third
run to verify what the second one did, so a branch that is behind again after one
update goes red with the reason on the pull request.

Arming is `gh pr merge --squash --auto`, which is the closest GitHub has to
`merge_when_checks_succeed`: it defers to branch protection's required checks and
reviews instead of merging through them. Everything it reads has already reported, so
on a repository with no extra requirements it merges at once; where auto-merge is not
enabled in the repository settings, the job says so and merges directly, because the
decision to merge has already been made.

One platform fact is worth knowing before reading a merge as verified. A merge made
with the run's own `GITHUB_TOKEN` does not start the `push` run on `main` — GitHub does
not create workflow runs for events authored by that token. Set the repository secret
`PF_AUTOMERGE_TOKEN` (a PAT) to have the arm merge as a person, which does start it;
without it the job merges and prints a `::notice::` saying that `main` has to be
verified by dispatching `ci.yml` on the merge commit. If the required checks in branch
protection are set to exactly the five names `ci.yml`'s header lists — `Test (Node 22)`,
`Test (Node 24)`, `Typecheck`, `Server smoke and Docker build` and `Arm auto-merge` — the
platform refuses to merge before they are green anyway; the job reads them first so that a
repository without that protection is not merged through.

A green check on a stale base still proves nothing: let CI re-run against the current
tree, then merge. That is what the gate does now rather than merging on the old run's
verdict — the behind branch is updated and the updated head is verified by a dispatch
(#1612). #776 merged green off a stale base and took `main` red for hours.

## What a merge closes

> **Archived behaviour.** This section describes `close-merged-issues.yml`, which still
> lives in `.forgejo/workflows/` and has not been ported to GitHub Actions yet. Nothing
> here runs today. It is kept because the rule it encodes is the part that matters, and
> because `scripts/check-closing-keywords.js` — the guard you run before pushing — is
> unchanged. What changes on GitHub is the first mechanism: a merged pull request body
> containing `Fixes #N` closes the issue on the platform, without a workflow, and the
> `[Device]:` sweep is the half still to bring over.

The forge closes an issue when a merged pull request body contains `Fixes #N` — #1635
closed #1526 that way — but only if somebody remembered to write it, and never for a
`[Device]:` request whose device lands in a later, unrelated pull request.
`close-merged-issues.yml` runs `scripts/close-merged-issues.js` on every push to `main`
and finishes the job:

| | what it does |
|---|---|
| Keyword sweep | reads the commits in this push from the compare API, takes the ones a closing keyword cites (`fix`/`fixes`/`fixed`, `close`/`closes`/`closed`, `resolve`/`resolves`/`resolved`, then `#N`), adds the merged pull request body where the squash subject names one, and closes any of those issues still open — commenting first with the commit SHA and the pull request |
| Device sweep | asks, for every open `[Device]:` request, whether `devices/` now has the model, using the same matcher `scripts/sweep-device-requests.js` uses (its normaliser, candidate generator and guards are imported, not reimplemented); a hit is commented with the spec path and model and closed |

What it will **not** close, and why:

- **A number that is only mentioned.** `see #12 for context` claims nothing, and neither
  does a keyword that does not open a line or a sentence. The three real pull request
  bodies that made this rule necessary: #1867's *"Does **not** close #743"*, #1873's
  *"Refs #742 - this PR records measurements; it does **not** close the issue"* and its
  heading *"## What would close #742"*. All three name a number next to a keyword, none
  claims a fix, and #742/#743 are still open. That is not evidence about Forgejo's parser —
  see *The forge's own parser, and the sentence it cannot read*, below.
- **An issue that is already closed**, or a number that belongs to a pull request: it
  never reopens and never re-closes.
- **A device that is only nearly the same product.** `OptiXtrans E6616X` is not the
  catalogued `OptiXtrans E6616`, `RUT951 POE+` is not a `RUT951`, and a request for a
  shield "for NanoBeam NBE-M5-19" is not a request for the radio. `closed-audit.yml` is
  the opposite guard, and a close that contradicted the catalogue would show up there.
- **Anything a human reopened on purpose.** Every comment carries a marker naming the
  commit or the device it closed; if the marker is already there and the issue is open
  again, the sweep leaves it alone and says so. A second run can therefore not repeat
  itself, which is what makes it safe to run on every merge.

### The forge's own parser, and the sentence it cannot read

The sweep above reads a negation: *does not close #N* is not a claim, and `--explain` says so. The
forge does not always agree, and it has now closed three `[Device]:` requests on their own
disclaimers — two a few hours apart on 2026-11-18, the third two days later:

| pull request | the words | the request | what happened |
|---|---|---|---|
| #2000 | *"Refs #803 — does not close it"* and, further down, *"Why it cannot close #803:"* | #803 | `closed` at 16:04:48Z, two seconds after the merge, with no comment |
| #2005 | *"This PR does not close #130 — UDW-PRO still has no Ubiquiti source"* | #130 | `closed` at 18:00:05Z, also two seconds after the merge, no comment |
| #2301 | *"Does not close #130 or #803 — the two open device requests are blocked on their vendors"* | #130 | `closed` at 19:08:37Z, three seconds after the merge, no comment; **#803 stayed open** |

None of the three closes was this sweep: it posts a comment carrying its marker *before* it changes
state, and none of the issues carries one. All three were reopened by hand, the third at 21:24Z the
same day, which is where the cost is — a request that leaves the queue has to be found and put
back, and the next reader of the queue cannot see that it happened.

The third close pins the shape down a little further. #2301 named two requests in one disclaimer
and the forge closed exactly one: `or` is not a separator in its run, so the keyword bound to the
number directly after it and the second reference was ignored. The risk is therefore not "a number
near a keyword" but "the number adjacent to it" — a two-request disclaimer loses one request while
the body reads as if it protected both. It was also written after this section existed, which is
the argument for running `scripts/check-closing-keywords.js` before pushing rather than trusting
the rule to be remembered.

The identical shape in #1867 (*"Does **not** close #743"*) and #1873 (*"it does **not** close the
issue"*) closed nothing. So the forge's rule is not something that can be learned from outside, and
the conclusion is not "write a better negation" — it is **stop putting a closing keyword in a
sentence about a request you are not answering**. Two shapes are safe, and both were in use before
this was written down:

- **`Refs #N`** — a reference with no closing keyword anywhere in the sentence around it;
- **`issue N`**, or the model name — no `#`, so there is nothing for either parser to read.

`scripts/check-closing-keywords.js` checks a body for the first shape failing:

```bash
node scripts/check-closing-keywords.js --file body.md              # or --text "...", or from a pipe
node scripts/check-closing-keywords.js --file - < commit-msg.txt   # git log -1 --format=%B | ...
FORGEJO_TOKEN=... node scripts/check-closing-keywords.js --pr 2005 # the body and its commits
```

It prints every keyword-plus-number the forge could read as a close and this repository's rule
would not, with the reason (`negated`, `mid-sentence`, `hypothetical`) and a `--strict` exit code
of 1. It is deliberately not wired into CI: it is a check you run before pushing, and a careful
sentence should not be able to turn somebody else's merge red. `test/closing-keywords.test.js`
holds it in step with `parseClosingKeywords()`, so the two cannot drift into disagreeing about the
same body.

It never fails the build: a missing token, a refused write or a timeout is a
`::warning::` with the reason, and nothing is left half-closed (the comment is posted
before the state change, so a failure between them leaves an open issue with a note on
it rather than a closed one with no explanation).

### Seeing what it would do today, without closing anything

The script is dry-run by default and a manual dispatch keeps that: `dry_run` defaults to
`true`, and only the push run applies.

```bash
# what would this close, over the last 25 merges?
FORGEJO_TOKEN=... node scripts/close-merged-issues.js --limit 25 --explain

# the commits of a specific push, the way the workflow passes them
FORGEJO_TOKEN=... node scripts/close-merged-issues.js --from <before> --to <sha> --explain

# one sweep at a time, or actually apply (what the push run does)
FORGEJO_TOKEN=... node scripts/close-merged-issues.js --device-only
FORGEJO_TOKEN=... node scripts/close-merged-issues.js --apply
```

`--explain` names each `[Device]:` request it left open and the subject it compared, so
"nothing to do" is a reading rather than a silence. Set `FORGEJO_URL` to point it at an
instance other than the default address.

## The runners

`runs-on: ubuntu-latest`, one fresh VM per job, and no queue to manage: GitHub starts
each job on its own host and discards it afterwards. Nothing is shared between jobs,
which is why five checks now run in parallel without the second slot's contention
penalty, and why no step in `ci.yml` has to ask what else is running on the host.

The self-hosted runner this replaced was a container on the forge host with
`capacity: 2` — two jobs at a time, and that number was the throughput ceiling of the
entire project. Measured on the same host, same day:

| capacity | job starts | mean job duration | effective throughput |
|---|---|---|---|
| 1 | ~1.1 / min | ~50 s | 1.0× |
| 2 | ~2.2 / min | ~63 s | ~1.6× |

Those numbers are kept for one reason: they are why the job boundaries in `ci.yml` are
where they are. Splitting `Typecheck` out of the test legs, folding the smoke client
into the Docker job (#2219) and folding the classifier into the job that spends it were
all decisions about a scarce slot. They are still the right boundaries — one answer per
tree, and the checks that share a tree share a job — but nobody has to pay for them with
a queue any more. The archive copy of the workflow still carries the per-run
measurements, if you want to see what a slot cost.

## The disk the jobs share

Each GitHub-hosted job gets its own VM, its own filesystem and its own Docker daemon,
and the VM is destroyed with the job. The `docker` job still bounds what it writes, and
`scripts/check-ci-disk-hygiene.js` still enforces it, because the rule was never really
about one host: a step that builds an image is a promise to clean up after itself, and
32 GB of runner disk is not large enough to pretend otherwise.

The incident that put the rule there happened on the shared runner, where the bound was
not cleanliness but survival. The runner was a container on the forge host, the `docker`
job built against the **host daemon** through the mounted `/var/run/docker.sock`, and
its layers, intermediate images and build cache therefore lived on the same volume as
Forgejo's database and repositories.

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

So the `docker` job leaves its disk as it found it: it removes the image it built, bounds
the builder cache with `--keep-storage 2GB` (falling back to a plain prune on docker
20.10, which has no such flag), and prints `docker system df` both **before** and
**after** the build so a growing disk reads as a trend in a log instead of being
discovered by a failed push. The cleanup step carries `if: always()`, because the failure
case — a build that dies half way — is the one that leaves the most behind, and a cleanup
written without it would be skipped exactly then.

`scripts/check-ci-disk-hygiene.js` (also `npm run check:ci-disk`, and a step in the
test job) enforces the rule against every workflow file it can find —
`.github/workflows/` and `.forgejo/workflows/` both: a step that runs
`docker build` obliges the same job to prune, in a step that carries `if: always()`,
and to report `docker system df`. Prose in a comment does not count — the checker strips
full-line comments first, so documenting the rule cannot trip it.

Bounding the job stops the *next* fill; it cannot reclaim what is already gone, and on
the shared host a full volume took the forge down in four ways that looked unrelated.
Those four, and what to run on the host, are in
[`FORGE_TROUBLESHOOTING.md`](FORGE_TROUBLESHOOTING.md#when-the-volume-is-full-every-retry-leaves-another-half-clone)
— historical now that the jobs run on their own VMs, but it is the incident the rule came
from.

## Troubleshooting

| Symptom | Cause | What to do |
|---|---|---|
| Checks say *Queued* or *Waiting* for a long time | The run is waiting for a `concurrency` slot: one run per pull request, and `ci.yml` cancels the superseded one rather than queueing it | Nothing to fix; a new push to the same pull request replaces it |
| A run says *cancelled* immediately | A newer commit to the same pull request superseded it | Expected. The newest run is the one that counts |
| A run on `main` says *cancelled* | Should not happen: `cancel-in-progress` is `true` only for `pull_request` (#1076) | Open an issue — this is the bug that fix exists to prevent |
| A merge went in and there is no run on `main` for it | The merge was made with the run's own `GITHUB_TOKEN`, and GitHub does not start workflows for events authored by that token | Set `PF_AUTOMERGE_TOKEN`, or dispatch `ci.yml` on the merge commit (*Merging*, above) |
| `Arm auto-merge` is green and the pull request is unmerged | It read the checks before the last of them reported, or the head moved; the log names which | Nothing to fix; the run for the new head arms it. A `::warning::` naming a check means that check is not green |
| `Arm auto-merge` is red and the pull request is unmerged | The job refused: a check is not green, a test leg has not reported, the head moved, the branch could not be updated, or the merge itself was declined | The comment on the pull request names which; fix that and the next run decides. It is not a required check, so nothing is blocked — which is why a red here is the only signal that the queue has stopped |
| A check fails only in CI | Node version, or a path that differs on Linux | Run `npm test` on Node 22; check case-sensitivity in file paths |
| A job was killed at its `timeout-minutes` with no log | The hard job-level bound fired before any step's own bound did | Look for the last step that started; every long step carries its own `timeout` and an `::error title=` precisely so this cannot be the only evidence |

## Known gaps

- **The Forgejo-only workflows do not run at all.** `auto-rebase`, `pr-rebase`,
  `closed-audit`, `close-merged-issues`, `main-health` and `wiki-sync` are archived in
  `.forgejo/workflows/`; nothing updates a head whose checks are *not* green, closes a
  `[Device]:` request after a merge, tracks a red `main` in an issue, or mirrors the wiki
  until each one is ported. A green head that is behind `main` is the one case covered,
  by `Arm auto-merge` itself (#1612); the rest is still something a person does.
- **`main` is verified only when the merge produces a `push` run.** A merge made with
  the run's own token does not start one (*Merging*, above). Set `PF_AUTOMERGE_TOKEN` or
  dispatch `ci.yml` by hand after a bot merge; the job prints a `::notice::` when this
  applies.
- **Nothing enforces the required checks yet.** The five names `ci.yml`'s header lists are
  stable so that a branch protection rule can name them — `Syntax check (all JS)` is the
  sixth job and not one of them; `Arm auto-merge` names it in `needs:` instead — but a rule
  has to be created for that to mean anything; until then the merge decision is
  `Arm auto-merge` alone, which is why it reads the checks itself rather than trusting the
  platform to.
- **A stale pull request costs more than a fresh one.** Its head carries the workflow
  files of the day it was pushed, so a run against it tests an older `ci.yml`. Rebase
  before trusting a red or a green on a branch that has been open a while.
- **Only badge a workflow this repository still has.** A badge for a workflow file that
  does not exist on the default branch renders as `failure` forever — it is not a red
  build, it is a link to a file that is not there, on the page every visitor lands on
  first. The README carried one until #1470 for exactly that reason. `.github/workflows/`
  holds `ci.yml`; `.forgejo/workflows/` holds the archive.

## Reporting a problem with CI itself

Open an issue with the workflow run URL, and include:

```bash
# the runs for a branch or a commit, newest first
gh run list --repo jaylouisw/packetforge --limit 10

# why one run did what it did, including a job that never started
gh run view <run-id> --repo jaylouisw/packetforge --log
```

The run summary page is not enough on its own: a run that never started looks
identical to a run that is waiting for its `concurrency` group, and only the difference
tells you which bug you have.

## The automation token

`ci.yml` needs nothing but the run's own token. It declares `contents: read` and
`pull-requests: read` for the verification jobs. `Arm auto-merge` raises three:
`contents: write`, because a merge is a push to the base and `PUT .../update-branch` is
a write as well; `pull-requests: write`, for `gh pr merge` and the comment it posts
when it cannot; and `actions: write`, for the `ci.yml` dispatch that verifies a merge
made with the run's own token. There is no long-lived secret in the merge path, and a
missing token cannot fail a build: an unreadable answer from the API means "run the
job", never "stand it down".

There is one optional secret, **`PF_AUTOMERGE_TOKEN`** (*Settings → Secrets and
variables → Actions*), and it changes exactly one thing: a merge made with the run's own
token does not start the `push` run on `main`, because GitHub does not create workflow
runs for events authored by `GITHUB_TOKEN`. A PAT merges as a person, and that push run
happens. Without it the merge still happens and the job prints a `::notice::` saying
`main` has to be verified by dispatching `ci.yml` on the merge commit.

```yaml
env:
  GH_TOKEN: ${{ secrets.PF_AUTOMERGE_TOKEN || github.token }}
```

The archived `.forgejo/workflows/` files still read `FORGEJO_TOKEN` with the same
fallback shape; they are not wired to anything, and the name means nothing on GitHub.

### When a maintenance job goes red

A red ✗ on a pull request means "this change is broken". The rebase job failing means "the
automation could not do its housekeeping", which is not the contributor's problem and which they
cannot act on. So every failure path in the archived `pr-rebase.yml` printed a `::warning::` and
exited 0 — and `Arm auto-merge` copied that, which is the mistake #1610 names: a refusal printed
the same tick as a merge, so a queue that merged nothing looked healthy for a migration. The
outcomes are split now:

| situation | what happens |
|---|---|
| the head moved while the run was in flight | warns, exits green — the run for the new head decides |
| the pull request was closed or merged meanwhile | exits green, nothing left to arm |
| a check is not green, or a test leg has not reported | warns, exits green, unmerged |
| the head is green and behind `main` | updates the branch, dispatches `ci.yml` on it, exits green |
| the branch cannot be updated, or is behind again after one update | **red**, with the reason on the pull request |
| an `arm` or `merge` the step cannot answer by merging directly is refused | **red**, with the API's answer on the pull request |
| no `PF_AUTOMERGE_TOKEN` | merges with the run's own token, dispatches `ci.yml` on `main`, says so in a `::notice::` |

The rule is the one the gate can defend: a green tick means the queue did what it set out to do.
Anything that stopped it is red, and it says why in the log, in a `::warning title=Auto-merge::`,
and as a comment on the pull request.

### Reading a failure when the logs are behind a login

Run logs on a public repository are public, so a red check is its own bug report: the
`::error title=` lines in `ci.yml` exist to make it one, and every check names the
thing that failed rather than printing a bare exit code. On a private repository (or a
fork whose runs are not visible to you) the log needs a session login, which is why the
`Arm auto-merge` job comments its reason on the pull request instead of trusting the log
to be readable — same reason the archived `pr-rebase.yml` posted its note as a comment.

## What runs, and why a device PR runs less of it

`Server smoke and Docker build` asks one question about itself before it builds: can
this diff change runtime behaviour? It diffs the pull request against its base with
`scripts/classify-change.js`, in the first step of the job that spends the answer. There
is no separate classifier job — there used to be, and it cost a runner slot on every run
to publish one API call's worth of answers that every consumer now asks for itself.

| the diff touches | `Test (Node 22/24)` and `Typecheck` | `Syntax check (all JS)` | `Server smoke and Docker build` |
|---|---|---|---|
| only `devices/**/*.json`, `docs/*.md`, `research/*.json`, top-level `*.md` | two legs, one typecheck | the sweep | skipped |
| anything else (scripts, tests, workflows, server, engine, web, config) | two legs, one typecheck | the sweep | yes |

Only the `Server smoke and Docker build` column differs, and that is deliberate: there is no such
thing as a data-only test leg, and a `*.js` the Node 22 parser rejects is rejected whatever the
diff touched.

`npm test` still runs for a data-only change, and on **both** Node versions: the diff
teaches the suite nothing, so cutting the matrix would buy speed with coverage the leg never had.
The `test` job carries that history in its own comment — a data-only `if:` that read
`matrix.node` was evaluated before the matrix existed, so every leg died about two seconds in (runs
1398, 1401, 1402), and a matrix built from an expression collapses to a single unnamed leg that
runs the suite once and reports it three times. Two versions, always. What the classifier still
saves is the job where the time actually goes: `Server smoke and Docker build` skips a
JSON-only diff entirely, up to ten minutes of a runner against roughly a minute for the suite. A
device spec cannot change how the server boots or whether the image builds.

The classifier is deliberately hostile to the "skip" answer (`scripts/classify-change.js`):

- an **empty** diff is a code change — nothing to inspect is not evidence of safety;
- an **unknown base sha** (shallow clone, force-push, new branch) is a code change;
- only `<vendor>/<model>.json` under `devices/` counts as data — `devices/registry.js` and
  `devices/cisco/README.md` do not;
- `test/`, `scripts/`, `.github/` and `.forgejo/` are never data, because those are the changes
  that can make CI lie about itself.

`test/classify-change.test.js` asserts each of those, including the mixed-diff case.

## Known issue: some pushes create no workflow runs at all

Observed on the Forgejo instance on 2026-11-09, unresolved there, and recorded because a
log nobody can read is not a report. On GitHub the same symptom has a documented cause —
see the last subsection. The measurement is kept because it is the reason `ci.yml`
prefers `PF_AUTOMERGE_TOKEN` for the merge and why a merge without a `push` run is not a
mystery any more.

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
*Actions → CI*:

- **no run row at all** → the event never created a run: settings or credential, not the workflow;
- **a run row stuck at "Queued"** → the runner label is wrong or the account is out of
  Actions minutes, not a workflow bug.

### The same symptom on GitHub, and its documented cause

On GitHub this shape is not a mystery: **a push made with `GITHUB_TOKEN` does not start a
workflow run.** Every Actions implementation has a recursion guard of that shape, and on
GitHub it is documented rather than discovered — which is why the archived Forgejo
instance's behaviour above was never explained while this one is.

Two consequences for this pipeline, and they are the reason the merge gate prefers a PAT:

- the `Arm auto-merge` job merges with whichever token it was given. With the run's own
  token the merge is authored by `github-actions[bot]`, so the `push` run on `main` does
  not start and the merge commit is unverified until somebody dispatches `ci.yml`;
- a push made by an automation using `GITHUB_TOKEN` (a bot commit, a scheduled job's
  write) does not trigger CI either. A push made by a person with their own credential
  does. `gh run list --commit <sha>` is how you tell the two apart in one look.

A red check is never the explanation for this: if nothing reports, nothing ran.
