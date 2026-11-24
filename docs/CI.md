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
| `ci.yml` | pull request to `main`, push to `main`, manual dispatch | The matrix — the suite on Node 22 and 24 — a `Typecheck` job, a live server smoke test, a Docker build — and, on an open pull request, a final `Arm auto-merge` job that merges it once every check has reported green (#1725) |
| `auto-rebase.yml` | push to `main`, manual dispatch, and a 30-minute schedule the host never dispatches (the backstop, not the tick: #2180 stopped the ten-minute pass that could not rebase) | Rebases open pull requests onto current `main` and re-arms auto-merge only for a head whose reported checks are all green - anything else is left to `ci.yml`'s `Arm auto-merge` job; stands down green, before its checkout, when the host has less than 512 MB free (#1508); checks out with `git` rather than `actions/checkout`, so a tick can start when the runner cannot reach the forge - the runner pre-fetches every `uses:` action before step one (#2366) |
| `pr-rebase.yml` | pull request opened, pushed to, or reopened | The rebase that actually runs: rebases that one pull request onto current `main` and arms squash auto-merge - but only when every reported check on the new head is green, otherwise it says so and leaves the merge to `ci.yml`'s `Arm auto-merge` job. Every failure path warns and exits 0; a job that fails before it can report why comments the reason on the pull request |
| `closed-audit.yml` | push to `main`, manual dispatch (`limit`, default 120) | Matches recently closed requests against the catalogue and prints any close that names no file in `devices/`; a report, never a red build |
| `close-merged-issues.yml` | push to `main`, manual dispatch (`dry_run`, default `true`; `issues`, default 300) | Closes the issues this merge answered: the ones a closing keyword in the pushed commits or the merged pull request body cites, and the `[Device]:` requests the catalogue now demonstrably has. Idempotent, never reopens, never a red build (*What a merge closes*, below) |
| `main-health.yml` | a 15-minute schedule, manual dispatch (`sha`, default `main`'s head; `dry_run`, default `true`) | Reads the status set of `main`'s head and opens **one** issue, titled `main is red`, naming each failing check beside the run link its status carries; a later tick that finds the same head red adds nothing - the head is written into the issue body, so the same break is reported once - and the first tick that finds it green comments and closes it. Nothing is merged, rebased or armed, and a tick that cannot read the status set warns rather than claiming `main` is fine (#2326) |
| `wiki-sync.yml` | push to `main` that touches `docs/wiki/**`, manual dispatch | Mirrors `docs/wiki/*.md` into the separate `<owner>/<repo>.wiki` repository, removing pages deleted upstream; needs the `WIKI_TOKEN` secret and fails without it |

`.github/workflows/` was deleted in #1059. While it existed, the GitHub workflow
ran on Forgejo too — and failed every time with `docker: command not found`,
because the Forgejo runner has no Docker-in-Docker. Two pipelines, one of which
could never pass.

## What a pull request goes through

Four verification checks on a code change, all of which must be green before a merge. A **data-only** diff is gated on the two test legs and the typecheck only — `Server smoke and Docker build` reports success without building anything. The last of the four is one job, not two (#2219): the smoke client runs beside the image build in the same slot, and the job's `::error` titles still name which of the two checks went red. One more job status sits alongside them and is not a check on the diff: `Arm auto-merge`, which is the merge decision itself (*Merging*, below). There is no classifier job: the data-only question is asked inside the job that spends its answer, the first step of `Server smoke and Docker build`, and the test legs run for every diff (`What runs, and why a device PR runs less of it`, below, says why):

| Check | Catches |
|---|---|
| `Test (Node 22)` | Syntax or API that only works on newer Node. The floor is 22.18 and this is the leg that holds it — the oldest runtime that can run a `.ts` file with no build step (`docs/TYPESCRIPT.md`) |
| `Test (Node 24)` | Behaviour that regressed on the newest runtime in the window |
| `Typecheck` | A type error, an `any`, or a `require()` CommonJS cannot resolve (`tsc --noEmit`, then `scripts/check-no-any.ts`, then `scripts/check-module-paths.ts`). One answer about one tree, so one job — not a copy per Node version |
| `Server smoke and Docker build` | A server that boots but cannot serve (every API route, the catalogue, WebSocket upgrade) **or** a `Dockerfile` that does not build. One status, two checks: the smoke client runs beside the image build in the same job, and the failure titles still separate them. Runs on a pinned Node it downloads and then asserts against the 22.18 floor (`scripts/check-node-floor.js`) - the runner image ships 20, which cannot load `engine/segment.ts` (#2488). Present as a build-syntax proxy, not a full image test |

The test job runs more than the suite (`ci.yml`, the `test` job):

- `npm test` — `audit:ports`, then `audit:devices`, then `check:bytes`, then every
  `test/*.test.js` **and** `test/*.test.ts` that `scripts/run-tests.js` discovers;
- `scripts/syntax-check.js`, started beside the suite and waited on at the end of the same step;
- `scripts/check-node-surface.js` — no API newer than Node 18 (stricter than the declared 22.18 floor, on purpose), in every `.js`, `.mjs`, `.cjs` and `.ts` file, because `node` runs all four;
- `scripts/check-canonical-urls.js` — every project URL points at Forgejo;
- `scripts/check-ci-disk-hygiene.js` — every job that builds an image bounds what it writes;
- `examples/build-examples.js`, then `scripts/missing-devices.js examples --no-issues`, which
  cross-checks every model the built labs name.

The `typecheck` job is separate and adds the three things nothing else can check: `tsc --noEmit`
over the TypeScript the repository has written, `scripts/check-no-any.ts` over the same files, and
`scripts/check-module-paths.ts` over every `require()` in the tree. All three are properties of one
tree, so they are one job and one answer, not a copy per Node version; the resolver is there rather
than in a test leg for the same reason `tsc` is. It prints one note every run —
`engine/segment.ts:118 require('./lag')`, which resolves today and breaks the day `lag.js` becomes
`.ts` — and exits 0 on it, so what the step asserts is *0 unresolvable specifiers* while the latent
one stays visible on every pull request. It is the only job in this workflow that installs anything
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
node scripts/check-canonical-urls.js    # every project URL points at Forgejo
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

Every job also carries a `timeout-minutes` bound — 5 in `changes` and `arm`, 10 in
`test` and `Server smoke and Docker build` — but on this runner that bound is a label, not a
bound. It is not enforced: measured on 2026-11-17, task 12980 (run 5238, pull #1851)
reported `Failing after 13m48s` under the `changes` job's five minutes, task 10860
(run 4596) 12m45s, and task 2694 (run 1342) 27,702 s — and for every second of each,
all five jobs of that pull request read `Blocked by required conditions`. A hung job
on a single runner is not a slow job, it is a stopped queue, and a queue held for an
afternoon by a job the scheduler was supposed to have killed cannot be diagnosed
afterwards either: a task killed from outside exits without a log.

So the bound that holds is in the step, and there is one on the thing that can wait.
Every fetch in `ci.yml` is wrapped in `timeout 90` — at most two attempts per leg, and
`timeout 60` for the base commit the classifier diffs — with a git abort after 30 s
below 1 kB/s; the test leg's suite gets `timeout 300`, the Docker build `timeout
180` and the smoke client `timeout 180`, because the smoke client is 11 s median and
30 s at its slowest green run, so a slow-but-working run still passes and a hung one
stops holding a slot. A stalled server costs three minutes, not an afternoon.

## Merging

Merge commits are not used. One pull request becomes one commit on `main`, and the
decision to make that commit belongs to `ci.yml`'s **`Arm auto-merge`** job - the one
job that runs after the checks it reads.

Until #1725 every gate in this repository was an *arm*. `pr-rebase.yml` and
`auto-rebase.yml` both POSTed `{"Do":"squash","merge_when_checks_succeed":true}`
immediately after the force-push that rebased the branch, and the forge evaluates
that flag against the checks that exist at the moment of the call. For a head pushed
seconds earlier that set is empty, and "all checks succeeded" over nothing is true.
Measured on 2026-11-16 over the 25 most recently merged pull requests
(`/commits/{sha}/status`): all 25 merged before any of their seven checks reported,
15 of them with no status at all on the head commit at the moment of the merge.
#1719 armed at 19:59:43, merged at 19:59:54, and its own first test leg did not
finish until 20:00:46 — 52 s after the commit it was testing was on `main`.

So both rebase workflows now ask a narrower question first (`checks_green`, in
`pr-rebase.yml` and `auto-rebase.yml`): at least one check has reported, nothing in
the set is anything but `success`, and the three `Test (Node …)` legs are among them
— a set that has not grown them is a run that has not started, not a run that passed.
Each ignores its own status, which is `pending` while it runs. A pull request that
fails that test is left untouched and green, with a line naming `ci.yml`'s
`Arm auto-merge` job as the thing that will merge it instead; one that is already
green is still armed here, so a pull request that lost its arm does not sit
mergeable and unarmed.

`Arm auto-merge` takes `needs: [changes, test, docker]` for ordering but asks
the statuses API for the verdict, so a leg skipped for a data-only diff is a
legitimate absence while a leg that never reported is not. It merges with
`head_commit_id` set to the head it read, so a run against a commit that has since
been rebased away is refused by the server rather than merging a tree this run never
tested. `mergeable` is computed off the request thread, so a `405` means "not known
yet" and is waited on for up to 90 s. Nothing in it can go red: every failure is a
`::warning::` on a pull request left unmerged and untouched.

A green check on a stale base still proves nothing: rebase first, let CI re-run
against the current tree, then merge. #776 merged green off a stale base and took
`main` red for hours.

## What a merge closes

Forgejo closes an issue when a merged pull request body contains `Fixes #N` — #1635
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
| A check fails only in CI | Node version, or a path that differs on Linux | Run `npm test` on Node 22; check case-sensitivity in file paths |

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
  `ci.yml`, `auto-rebase.yml`, `pr-rebase.yml`, `closed-audit.yml`,
  `close-merged-issues.yml`, `main-health.yml` and `wiki-sync.yml`;
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

Three workflows need a token that can push: `auto-rebase.yml`, `pr-rebase.yml` and
`wiki-sync.yml`. The automatic Actions token is enough to read the API and to arm a merge, but it
is scoped tightly enough that pushing a branch with it is unreliable — and a rebase that cannot be
pushed is the whole job. `main-health.yml` writes too, but only issues, which the
`permissions: issues: write` it declares already grants the automatic token: it prefers the secret
and accepts the run's own token when there is none, warning instead of passing quietly.

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

| the diff touches | `Test (Node 22/24)` and `Typecheck` | `Server smoke and Docker build` |
|---|---|---|
| only `devices/**/*.json`, `docs/*.md`, `research/*.json`, top-level `*.md` | two legs, one typecheck | skipped |
| anything else (scripts, tests, workflows, server, engine, web, config) | two legs, one typecheck | yes |

Only the last column differs, and that is deliberate: there is no such thing as a data-only
test leg.

`npm test` still runs for a data-only change, and on **both** Node versions: the diff
teaches the suite nothing, so cutting the matrix would buy speed with coverage the leg never had.
The `test` job carries that history in its own comment — a data-only `if:` that read
`matrix.node` was evaluated before the matrix existed, so every leg died about two seconds in (runs
1398, 1401, 1402), and a matrix built from an expression collapses to a single unnamed leg that
runs the suite once and reports it three times. Three versions, always. What the classifier still
saves is the job where the slots were actually going: `Server smoke and Docker build` skips a
JSON-only diff entirely, up to ten minutes of one slot against roughly a minute for the suite. A
device spec cannot change how the server boots or whether the image builds, and paying that job to
learn that is how a two-runner host ends up with a queue that never reaches the next pull request.

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
