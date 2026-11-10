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
| `auto-rebase.yml` | **push to `main`** (the trigger that actually fires), a 10-minute schedule, manual dispatch | Rebases open pull requests onto current `main` and re-arms auto-merge. The schedule is a safety net only: on this host scheduled and dispatched runs are created but never handed to a runner ([Known gaps](#known-gaps)) |

`.github/workflows/` was deleted in #1059. While it existed, the GitHub workflow
ran on Forgejo too — and failed every time with `docker: command not found`,
because the Forgejo runner has no Docker-in-Docker. Two pipelines, one of which
could never pass. **The `.github/` directory itself is still there** and still does a job: it holds
`ISSUE_TEMPLATE/` (including `device_request.yml`, the template the wiki links to), `labels.yml`,
`dependabot.yml` and `PULL_REQUEST_TEMPLATE.md`. Only `workflows/` went — so a reader who greps for
`.github` and finds eight files has not found a contradiction, and a stale pull request whose head
predates #1059 still carries a `workflows/` directory that this runner cannot satisfy.

## What a pull request goes through

**Three jobs, five check runs** — all required before a merge. The count is worth stating precisely
because it is easy to misread a matrix: `ci.yml` defines three jobs, and the `test` job's Node matrix
expands its *one* job into three separate check runs (`Test (Node 18)`, `20`, `22`). A red mark on any
leg fails the same job, so "three jobs" and "five checks" are both true and neither alone is honest.

| Check run | Catches |
|---|---|
| `Test (Node 18)` | Syntax or API that only works on newer Node. The floor is 18. |
| `Test (Node 20)` | Nothing Node 18 and 22 together cannot — kept for the middle of the support window |
| `Test (Node 22)` | Behaviour that regressed on the newest runtime |
| `Server smoke test` | A server that boots but cannot serve: every API route, the catalogue, WebSocket upgrade |
| `Docker build` | Two things, in order. First `scripts/check-dockerfile.js` — static checks that a build would have caught early: the base image is **pinned**, the container does **not run as root**, there is a `HEALTHCHECK`, **every `COPY` source exists in the repo**, and there is a command to run. Then a **real `docker build` only where the job has a daemon**: the step installs the CLI and builds if `docker info` succeeds, otherwise it prints that the build was skipped and why. A green Docker job on a daemon-less runner therefore means "the Dockerfile is well-formed", not "the image builds". |

The test job runs, in order: `syntax-check`, `check-control-bytes`, `check-node-surface`
(the Node 18 floor), `check-canonical-urls`, `npm test` — which is `audit:ports` +
`check:bytes` + `scripts/run-tests.js`, and the runner discovers every `test/*.test.js` —
then `examples/build-examples.js` (rebuild and self-verify every example lab — note that it
  **rewrites** the four JSON files from the generator and only then pings a host, so a hand-edited
  example passes the job: the files are compared to nothing. `git diff --exit-code examples/` after
  the build would turn that into a real check) and
`missing-devices.js examples --no-issues` (every model an example names still exists).

The three jobs carry 7 + 1 + 3 steps between them (measured by counting `- name:` under each job in
`ci.yml`): the test job seven, the smoke job one, the Docker job three — the last of which is the static
`Dockerfile` check, the CLI install that may fail harmlessly, and the build that runs only if a daemon
appeared.

### Running the same checks locally

```bash
npm test              # every suite — but read the note below, it is three commands
npm run syntax        # syntax-check across every JS file
npm run smoke         # starts the server, exercises every route, shuts down
docker build -t pf .  # exactly what the Docker job does
npm run audit:ports   # per-port type audit
```

`npm run smoke` is safe to run with a lab open: `scripts/smoke-http.js` picks a free port with
`listen(0)`, spawns the server with `PORT` set to it and `PF_DATA` pointed at a temporary directory,
and kills it at the end — your `data/topologies/` is never touched. On this tree it prints **18** `ok`
lines and ends `HTTP smoke passed (all checks clean)`; the count grows whenever a route is added, so
read it as a snapshot rather than a contract.

**`npm test` is not one thing.** The script is
`node scripts/audit-port-types.js && node scripts/check-control-bytes.js && node scripts/run-tests.js`,
so the two audits run *first* and a red audit aborts the whole command **before a single suite prints**.
The failure looks like a test failure and is not one: a port-type finding stops the run at `&&` with no
suite output at all, which is the shape of a hang rather than a red test. If `npm test` produces no
`suite(s) in …` line, run `npm run audit:ports` on its own to see the finding. CI then runs
`check-control-bytes.js` again as its own step, so it is executed twice per push — harmless, and worth
knowing before you spend time working out why its count appears in two places in the log.

Five checks live in no job, because they only matter after editing documentation by hand — and every
one of them has caught real breakage in `docs/` that every other job passed. Save this as `md-check.js` (it
is not in the repository yet) and run it over the prose:

```js
// The five markdown checks no job in this repository runs.
//   node md-check.js docs/*.md README.md CONTRIBUTING.md CHANGELOG.md
const fs = require('fs');

const files = process.argv.slice(2);

// 1. every table row has the same number of cells as its header.
//    A `|` inside a backticked command adds a column silently; escape it as \|.
let shape = 0;
for (const f of process.argv.slice(2)) {
  const L = fs.readFileSync(f, 'utf8').split('\n');
  for (let i = 0; i < L.length; i++) {
    // NB: '-' must come first in the class. As [:‑|] written later it forms the range
    // ':'..'|', which excludes '-' — and then this test matches no separator line at all,
    // so check 1 silently never runs. Keep the hyphen first.
    if (!L[i].startsWith('|') || !/^\|[-:\s|]+\|$/.test((L[i + 1] || '').trim())) continue;
    const n = L[i].split(/(?<!\\)\|/).length - 2;
    for (let k = i + 1; k < L.length && L[k].startsWith('|'); k++) {
      const m = L[k].split(/(?<!\\)\|/).length - 2;
      if (m !== n) { console.log(f + ':' + (k + 1) + ' has ' + m + ' cells, header has ' + n); shape++; }
    }
  }
}

// 2. every intra-repository anchor resolves to a heading in the same file.
let anchors = 0;
for (const f of files) {
  const t = fs.readFileSync(f, 'utf8');
  const heads = [...t.matchAll(/^#{2,4} (.+)$/gm)]
    .map(m => m[1].toLowerCase().replace(/[^\w\s-]/g, '').trim().replace(/ /g, '-'));
  for (const m of t.matchAll(/\]\(#([^)]+)\)/g)) {
    if (!heads.includes(m[1])) { console.log(f + ' -> #' + m[1] + ' (no such heading)'); anchors++; }
  }
}

// 3. every `test/*.test.js` a document names exists on disk.
//    Design pages cite suites they are *proposing*; those are the only legitimate misses,
//    and printing them keeps that difference deliberate rather than accidental.
let ghosts = 0;
const onDisk = new Set(fs.readdirSync('test').filter(f => f.endsWith('.test.js')));
for (const f of files) {
  const t = fs.readFileSync(f, 'utf8');
  for (const m of t.matchAll(/test\/([\w.-]+\.test\.js)/g)) {
    if (!onDisk.has(m[1])) { console.log(f + ' cites test/' + m[1] + ' (not on disk)'); ghosts++; }
  }
}

// 4. every table is followed by a blank line (or end of file).
//    A cell wrapped onto the next line looks like a normal row to every other check — the
//    counts still agree — but GitHub renders the wrap as a paragraph and the table loses
//    its last row on screen.
let broken = 0;
for (const f of files) {
  const L = fs.readFileSync(f, 'utf8').split('\n');
  // Only lines that belong to a real table count. A *prose* line is allowed to start with '|'
  // (a sentence that wraps after a pipe in a code span), and it renders as text, not a table —
  // flagging it was a false positive that kept pointing at a paragraph in CLI.md.
  let inTable = false;
  for (let i = 0; i < L.length; i++) {
    if (!L[i].startsWith('|')) { inTable = false; continue; }
    if (!inTable) {
      const sep = (L[i + 1] || '').trim();
      if (!/^\|[-:\s|]+\|$/.test(sep)) { inTable = false; continue; }  // '|' line with no separator: prose
      inTable = true;
      i++;                       // skip the separator
      continue;
    }
    const next = L[i + 1];
    if (next === undefined) break;
    if (next.trim() === '' || next.startsWith('|') || next.startsWith('```')) continue;
    console.log(f + ':' + (i + 2) + ' breaks a table row (a table must be followed by a blank line)');
    broken++;
  }
}


// 5. every cross-file anchor (a link whose target is another .md file plus #heading) resolves in
//    the file it names. Check 2 only looks at same-file anchors, which is the rarer shape: a
//    document that links into the middle of another document breaks silently on a heading rename.
//    NB: do not write literal link syntax in this comment — it is published inside CI.md, and the
//    checkers then read the comment as a real broken link.
let cross = 0;
const slug = h => h.toLowerCase().replace(/[^\w\s-]/g, '').trim().replace(/ /g, '-');
const headingCache = new Map();
function headingsOf(path) {
  if (!headingCache.has(path)) {
    let txt;
    try { txt = fs.readFileSync(path, 'utf8'); } catch (e) { headingCache.set(path, null); return null; }
    headingCache.set(path, [...txt.matchAll(/^#{1,6} (.+)$/gm)].map(m => slug(m[1])));
  }
  return headingCache.get(path);
}
const path = require('path');
for (const f of files) {
  const t = fs.readFileSync(f, 'utf8');
  for (const m of t.matchAll(/\]\(([^)#\s]+\.md)#([^)]+)\)/g)) {
    const target = path.resolve(path.dirname(path.resolve(f)), m[1]);
    const heads = headingsOf(target);
    if (heads === null) { console.log(f + ' -> ' + m[1] + ' (file not found)'); cross++; continue; }
    if (!heads.includes(m[2])) { console.log(f + ' -> ' + m[1] + '#' + m[2] + ' (no such heading)'); cross++; }
  }
}

console.log(shape || anchors || ghosts || broken || cross
  ? shape + ' shape problem(s), ' + anchors + ' broken anchor(s), ' + ghosts + ' cited-but-absent suite(s), ' + broken + ' broken table(s), ' + cross + ' cross-file anchor(s)'
  : 'tables, anchors and suite citations clean');
```

```bash
node md-check.js docs/*.md README.md CONTRIBUTING.md CHANGELOG.md
# tables and anchors clean
```

The shape check matters more than it sounds: a `|` inside a backticked command —
`` `show flows [<id> | counters]` `` — silently adds a column, and the table still *renders*, just with
a cell pushed off the end. Escape it as `\|` inside the cell. The anchor check catches a link to a
heading that was renamed, which is the usual casualty of rewording a section title. The suite check
catches a document citing a `test/*.test.js` that does not exist — and it reports **thirteen** today, not
five: the two suites `BGP-POLICY.md` proposes, the three `UPSTREAM-DESIGN.md` proposes, and eight §11 rows
in `SIMULATION.md` that narrate those same names. That is why the check prints rather than fails — a
design page naming a file it wants written is legitimate — and the only way to keep the distinction
honest is to look at the list: recount with `node md-check.js … | grep 'cites test/'` before quoting a
number from this paragraph, because this one was wrong for exactly that reason. The fourth check is the one this page learned the hard way:
a **table row wrapped onto a second line** keeps its cell count, so the shape check passes, but GitHub
renders the wrapped text as a paragraph and the table silently loses its last row on screen. Every
table must be followed by a blank line — including the one above.

### What the pages claim about the code

`md-check` reads the *prose as prose* — tables, links, suite names. It cannot see the other thing a
documentation page does: name a file, a script or a constant in backticks as though it exists. Two
one-liners cover the two classes that go stale silently, and both were run on this tree to write the
numbers below.

**Every backticked path that looks like a file, must be one.** This catches a module that was renamed
or deleted while three pages kept citing it:

```bash
node -e '
const fs=require("fs");
const docs=["README.md","CONTRIBUTING.md",...fs.readdirSync("docs").filter(f=>f.endsWith(".md")).map(f=>"docs/"+f),...fs.readdirSync("docs/wiki").map(f=>"docs/wiki/"+f)];
const re=/`((?:engine|server|web|scripts|devices|examples|catalogue|research|test)\/[A-Za-z0-9_.-]+\.(?:js|css|html|json|md))`/g;
let bad=0;
for (const d of docs){ const L=fs.readFileSync(d,"utf8").split("\n");
  L.forEach((l,i)=>{ let m; while((m=re.exec(l))) if(!fs.existsSync(m[1])) {console.log(d+":"+(i+1)+" -> "+m[1]); bad++;} }); }
console.log(bad?bad+" missing file citation(s)":"every cited file exists");'
```

On this tree it prints **11** missing, and all eleven are the proposed design suites counted above (it
omits `CHANGELOG.md`, which is why `md-check` reads 13 for the same fact). Anything else in that list is
a renamed file and a broken page.

**Every `npm run x` a page tells you to type, must be a script.** A renamed script is worse than a
missing file because the reader believes they made the mistake:

```bash
node -e '
const fs=require("fs");
const scripts=new Set(Object.keys(require("./package.json").scripts));
const docs=["README.md","CONTRIBUTING.md",...fs.readdirSync("docs").filter(f=>f.endsWith(".md")).map(f=>"docs/"+f),...fs.readdirSync("docs/wiki").map(f=>"docs/wiki/"+f)];
let bad=0;
for (const d of docs){ fs.readFileSync(d,"utf8").split("\n").forEach((l,i)=>{ let m;
  const re=/npm run ([a-z0-9:_-]+)/g; while((m=re.exec(l))) if(!scripts.has(m[1])) {console.log(d+":"+(i+1)+" -> npm run "+m[1]); bad++;} }); }
console.log(bad?bad+" cited npm script(s) do not exist":"every cited npm script exists");'
```

It prints `every cited npm script exists` today, against the **54** scripts `package.json` actually defines.

Backticked **constants and error codes** are the third class, and the one where a raw existence check
misleads: `BGP-POLICY.md` and `UPSTREAM-DESIGN.md` are design documents, so they name codes the engine
does not raise yet (`W_SINGLE_HOMED`, `E_NAT_EGRESS_MISMATCH`, `MED_MAX`, `WELL_KNOWN_COMMUNITIES`)
deliberately, in a column headed *this design changes it to*. Grep for each one, and treat an absence as
a finding **only** on a page that describes what the engine does today — `CLI.md`, `LINK-STATE.md`,
`DEVICE_REGISTRY.md`, `PHYSICAL_LAYER.md`. The same sweep over this tree finds every such code present in `engine/`
except one: `LINK-STATE.md` mentions `E_CONVERGING` to say a reader will *not* find it here — the sentence
is about an absence, which is the one place a bare existence check cannot tell diligence from drift.

And a warning about the first check, because it cost this page a full pass of false confidence: as
originally written the separator test was `/^\|[\s:-|]+\|$/`, whose character class `[:\-|]` is the
range `:`–`|`. `-` is not in that range, so the test matched **no separator line in any table** and the
shape check silently inspected nothing while reporting "clean" after every run. It found seven real
violations the moment the hyphen moved to the front. If you rewrite the check, keep `-` first in the
class and prove it fails on a deliberately broken table before trusting a green line.

The fifth check is the one the list had been missing: same-file `#anchor` links were covered, but
a link into the middle of a different document (`OTHER.md#anchor`) was not, and that is the shape
that breaks on every heading rename. It resolves the target relative to the linking file and demands the
heading exist there. All six such links in the tree currently resolve; the check was proved to bite by
pointing one at a heading that does not exist.

The wrapped-row check has one subtlety worth keeping: it only considers lines that belong to a real
table (a `|` line followed by a separator). Prose is allowed to start with `|` — a sentence that wraps
just after a pipe inside a code span does exactly that — and flagging it sends you to rewrite a
paragraph that renders perfectly. The first version of the check did not distinguish the two and spent
a pass pointing at a sentence in `CLI.md` about `ip ospf cost <n> | area <id> | passive`.

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
- **No suite is red on the current tree.** Measured by running the two that used to be:
  `test/spec-vs-description.test.js` **3 passed, 0 failed** and `test/canonical-urls.test.js`
  **43 passed, 0 failed**, with `scripts/check-canonical-urls.js` printing
  `OK — 2114 files, every project URL points at https://git.jayw.uk/jaylouisw/packetforge`. As always,
  quote the runner rather than this paragraph: `node scripts/run-tests.js` prints the reading and
  `ls test/*.test.js | wc -l` prints the size.

  Both closed the way this page predicted, and it is worth recording *which* way, because only one of
  them was the fix the bullet originally recommended:

  - `test/spec-vs-description.test.js` — the four Ubiquiti specs still carry `"poeOut": true` on `eth0`,
    and the fix was on the **prose side**: their descriptions now read *"1x PoE++ passthrough"* rather
    than *"PoE-in"*, so the port key and the description agree instead of contradicting. The rule the
    test enforces is unchanged — a device described as PoE-powered must not source power — and a real
    passthrough is still tracked by name in its exemption list rather than by muting the rule.
  - `test/canonical-urls.test.js` — `DO-NOT-USE.md` was **exempted**, not deleted:
    `scripts/check-canonical-urls.js` consults `canonical.EXEMPT_FILES` and skips it, on the reasoning
    that a quarantined file whose entire purpose is to record the stale URL is not a violation. The two
    assertions that depended on a clean tree followed the exemption.

- **Nothing checks that the generated wiki is current.** `docs/wiki/` is written by
  `scripts/build-wiki.js` from text templates held in that script, and no job runs
  it — `grep -r wiki .forgejo/workflows/` returns nothing. So the pages drift, and
  they did: `Home.md` still advertised 926 models from 208 vendors when the
  catalogue held 1,584 from 245, and the fidelity page still repeated a convergence
  claim the docs had already retracted. Rebuilding is a manual step:

  ```bash
  node scripts/build-wiki.js && git diff --quiet docs/wiki/ || echo "wiki was stale"
  ```

  That one-liner is a candidate for the test job; until it lands, treat any change
  to a count or a capability claim as a reminder to run it. Publishing is a second manual step:
  `node scripts/publish-wiki.js --dry-run` prints the pages that differ from the live wiki without
  writing anything.

  **The live wiki was two pages behind and the dry-run could not tell you which.** Measured by
  cloning `packetforge.wiki.git` and comparing with line endings normalised: four of the six pages
  were byte-identical once `\r\n` was stripped, and two were genuinely stale — `Home.md` still said
  **926 models from 208 vendors** against a catalogue of 1,584/245, and `Simulation-Fidelity.md` was
  missing the NAT caveat ("no `nat` CLI command yet") and the convergence-timing paragraph. After
  publishing, all six are content-identical and the blobs in the wiki repo are LF.

  **`--dry-run` reporting every page as "updated" is not staleness — it is `core.autocrlf`.**
  `publish-wiki.js` compares the clone's files to `docs/wiki/` as raw strings; on Windows with
  `core.autocrlf=true` the checkout is CRLF while the repo stores LF, so every page differs on every
  run, forever. Comparing after normalising line endings, or running the check on Linux (where CI
  runs), is what makes it a signal.

  **When the wiki is already in sync, the script crashes instead of saying so.** Measured twice in
  one sitting: with nothing to publish, `node scripts/publish-wiki.js` copies the pages, runs
  `git add`, then dies on
  `Error: Command failed: git -c user.name=… commit --quiet -m Publish wiki from docs/wiki` with a
  raw `child_process` stack trace. The cause is `core.autocrlf=true` again — the copy writes LF into a
  CRLF checkout, `git add` normalises it straight back, and the commit finds nothing staged. So a
  stack trace naming `git … commit` means **nothing to publish**, not a broken credential; a genuine
  auth failure names `git clone` or `git push` instead. Read the command in the error before chasing
  the wrong problem.

  **A failed run leaves its temp clone behind.** The script builds in
  `%TEMP%\packetforge-wiki-<pid>` (five of them accumulated here before anyone looked), so a publish
  that dies — auth prompt, nothing to commit — also litters. `ls -d $TEMP/packetforge-wiki-*` and
  remove them when the numbers stop changing.

  **The default HTTPS clone URL cannot authenticate in a non-interactive run.** The first real
  publish attempt died with `could not read Username for 'https://git.jayw.uk'` (no tty to prompt on);
  `PF_WIKI_REPO=ssh://forgejo/jaylouisw/packetforge.wiki.git node scripts/publish-wiki.js` works,
  because the wiki repository exists and SSH keys are configured. That also settles an older claim in
  `CONTRIBUTING.md`: the wiki repository is created ahead of time here, not lazily by the first web-UI
  save.
- **Nothing checks that a `#anchor` inside a link resolves.** There are 32 intra-repository anchor
  links across the README and `docs/`, and two of them were broken the first time anyone counted:
  `#51-dhcp--absent-from-the-data-path` pointed at a heading that had been rewritten to say DHCP is
  *in* the data path, and `#10-known-open-defects` pointed at a section now titled "Fixed defects,
  kept visible". Renaming a heading breaks every link to it and no job notices. The check is three
  lines in a test: for each file in `docs/` plus the README, collect its headings, slug them the way
  a renderer does, and assert every `#fragment` in the file lands on one.
- **Nothing checks that a Markdown table has the same number of columns in every row.** An
  unescaped `|` inside a cell — most often a shell pipe inside a code span, as in
  `` `ls test/*.test.js | wc -l` `` — adds a column to that one row, and a renderer does not
  complain: the table just gains a stray cell and the reader assumes the column was meant to be
  empty. Two such rows were live in `docs/` when this was added (one in `CLI.md`, one with a whole
  extra cell in `SIMULATION.md` §11). The same rule as anchors applies: split each row on unescaped
  pipes only (`/(?<!\\)\|/`), take the header row after a `|---|` separator as the expected count,
  and escape the pipe in the source rather than the count in the test.

- **The "cited-but-absent suite" count is a warning, and it should not be zero.** The
  local markdown checker (`md-check`, the script reproduced [above](#running-the-same-checks-locally) —
  it lives outside the repository by design) resolves every `test/*.test.js` a page names against
  the directory and prints 13 misses on this tree. All 13 are legitimate, in three
  categories, and the count is stable because the pages are stable:

  | Where | Count | Why it is legitimate |
  |---|---|---|
  | `docs/BGP-POLICY.md` | 2 | `bgp-policy.test.js`, `bgp-policy-wire.test.js` — the page is a **design**, and these are the suites it proposes ("New file:") |
  | `docs/UPSTREAM-DESIGN.md` | 3 | `upstream-baseline.test.js` ×2, `upstream-service.test.js` — phase-0 and phase-2 gates, not yet written |
  | `docs/SIMULATION.md` | 8 | the iteration log **narrating** those same names: the §11 rows that record how the ghost-citation problem was found, and one recording a pass that "fixed" it |

  ```bash
  node md-check.js docs/*.md README.md CONTRIBUTING.md CHANGELOG.md docs/wiki/*.md | grep 'cites test/'
  ```

  Do not clear this by inventing a file to match a citation. That has already happened once:
  a pass needing to make the count go away cited a suite (`poe-derived.test.js`) with an assertion
  count beside it, and **no such file has ever existed in `git log --all`** — the citation
  survived because nothing compares prose to a run, and it is now recorded in
  `docs/SIMULATION.md` §11 as a defect rather than deleted quietly. If a real suite is
  renamed, rename the citation; if a page is proposing a suite, leave the name alone.

## Reporting a problem with CI itself

Open an issue with the workflow run URL, and include:

```bash
# what the queue looks like from the inside, if you have access
docker logs --tail 50 forgejo-runner
```

The web UI is not enough on its own: a run that never started looks identical to a
run that is waiting its turn, and only the difference tells you which bug you have.
