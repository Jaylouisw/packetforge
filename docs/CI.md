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

Two of those eight files are now inert, and the page should say so before a reader trusts them.
`dependabot.yml` still declares two ecosystems. `github-actions` has no target: it scans
`.github/workflows/`, which does not exist — the pipeline this project actually runs lives in
`.forgejo/workflows/`, which Dependabot does not read, and it is a GitHub service besides. `npm` has
no target either: `package.json` carries **no `dependencies` and no `devDependencies`**, there is no
lockfile of any kind, and `node_modules/` is not part of the tree — a zero-dependency project by
design, so there is nothing to bump. Whether the mirror has Dependabot enabled at all is not visible
without authentication, and if it ever did open a bump, `scripts/gh-bridge.js --prs` is the route back.
`labels.yml` is inert for the same kind of reason, and different in detail — see
[REQUESTING-HARDWARE.md](REQUESTING-HARDWARE.md#what-the-form-does-measured).

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
| `Server smoke test` | A server that boots but cannot serve. `scripts/smoke-http.js` runs **18 checks** against a real server on a free port: the UI shell, `/api/catalog`, `/api/media`, `/api/version` (twice — once that it answers, once that its device count agrees with `/api/catalog`), then topology create → place two devices → `validate-link` for a legal pair and an impossible medium → a refused cable → a legal cable → self-cabling refused → double-cabling refused → the topology read back → delete. **Not** "every route", and **not** the WebSocket upgrade: **twelve** board-scoped paths are outside it — `POST /api/topologies/:id/config/:devId`, `DELETE /api/topologies/:id/devices/:devId`, `POST /api/topologies/:id/interfaces/:devId/:ifName` (only for names without a slash: the handler splits on `/` and never decodes, so `Gi0/0` is unaddressable here — `…/Fa0%2F1` answers `interface not found`), `POST /api/topologies/:id/ping`, `GET` and `POST /api/topologies/:id/flows`, `GET` and `DELETE /api/topologies/:id/flows/:flowId`, `POST /api/topologies/:id/layout`, `POST /api/topologies/:id/load`, `POST /api/topologies/:id/reset`, `POST /api/topologies/:id/link-options`, `DELETE /api/topologies/:id/links/:linkId` and `PATCH` or `POST /api/topologies/:id/links/:linkId` (the length edit) plus `POST` or `PATCH /api/topologies/:id/links/:linkId/state` — the only path in the API that answers `405`. This row said ten until a fresh count, and it listed the percent-encoding workaround that does not work. The board prefix is part of the path: this row used to name them bare (`/api/config`, `/api/ping`, `/api/flows`, …), and every one of those answers `404 {"error":"unknown endpoint"}` on the real server, because `/api/` holds only four namespaces outside a board — `catalog`, `version`, `media` and `topologies`, and no automated check drives the upgrade handshake at all |
| `Docker build` | Two things, in order. First `scripts/check-dockerfile.js` — **nine** static checks over the file's 8 instructions — the list is under this table, and four of them are easy to miss: it also insists on a syntactically real base image, a declared `USER`, an entrypoint script that actually exists on disk, and it does not build anything. Then a **real `docker build` only where the job has a daemon**: the step installs the CLI and builds if `docker info` succeeds, otherwise it prints that the build was skipped and why. A green Docker job on a daemon-less runner therefore means "the Dockerfile is well-formed", not "the image builds". |

**The nine Dockerfile checks, since the row cannot hold them.** `check-dockerfile.js` reads the file,
counts its **8 instructions** and asserts, in order: it has a `FROM`; that base image is a real name
(`node:20-alpine`); it is **pinned** — no `:latest`, no bare `node`; it **declares a `USER`**; that user
is **not root**, which is a separate assertion because `USER root` satisfies the first and fails the
second; it declares a `HEALTHCHECK`; it has a `CMD` or `ENTRYPOINT`; every `COPY`/`ADD` source exists in
the repository (`COPY . .` is one such instruction); and, when the command names a `.js` file, that file
is really shipped — `CMD ["node", "server/index.js"]` is checked against `server/index.js` on disk. It
closes with a sentence no other guard prints: `The image itself was not built here`.


The test job runs, in order: `syntax-check`, `check-control-bytes`, `check-node-surface`
(the Node 18 floor), `check-canonical-urls`, `npm test` — which is `audit:ports` +
`check:bytes` + `scripts/run-tests.js`, and the runner discovers every `test/*.test.js`. Two wrinkles
worth knowing before you edit any of it: `check-control-bytes` therefore runs **twice** in the job (once
as its own step, once inside `npm test`), and `npm test` **inlines the two script paths** rather than
calling the `audit:ports` and `check:bytes` aliases — so re-pointing an alias changes what you run
locally and nothing at all about what CI runs. Then
`examples/build-examples.js` (rebuild and self-verify every example lab — note that it
  **rewrites** the four JSON files from the generator and only then pings a host, so a hand-edited
  example passes the job: the files are compared to nothing. `git diff --exit-code examples/` after
  the build would turn that into a real check. The ping half is no guard either: the script prints
  `verify <file>: ping OK` or `verify <file>: PING FAILED` and **returns 0 either way** — there is no
  `process.exit` and no `throw` anywhere in the file — so a lab that genuinely cannot be pinged still
  leaves the step green, with the failure visible only to whoever reads the log) and
`missing-devices.js examples --no-issues` (every model an example names still exists).

**Every command these pages tell you to run was resolved against the tree on 2026-11-12**, because a
broken one is invisible: the sentence stays grammatical and only the reader's terminal complains.
`npm run <target>` appears with **52** distinct targets across the docs, and all 52 are `package.json`
scripts; `npm test` is the 53rd name and is run bare, which leaves `check:bytes` as the one script no page
invokes by name — `npm test` inlines its path instead. `node <dir>/…js` appears with **32** distinct
repository paths, and all 32 exist; three other spellings are artefacts to create rather than files to run
(`md-check.js` and `/some/where/md-check.js`, which this page says is scratch-only, and
`scratch/optic-rows.js`, which the reader saves from the snippet below). What does *not* survive this
check is the other kind of citation — a **data**
path, which no manifest lists: `docs/DEVICE_REGISTRY.md` used to run `apply-research.js` against
`research/incoming/aruba-poe.json`, a file that is not in the tree, and a reader who copied it got a raw
`ENOENT` stack from `node:fs` rather than a usage line. Resolve commands by hand as well as paths, and
prefer an example file you have actually run.

**`syntax-check` is a parse, not a lint, over seven directories.** It runs `node --check` once per file
and reports `Syntax-checked 337 files: all OK` — every `.js` under `engine/`, `server/`, `devices/`,
`web/`, `scripts/`, `examples/` and `test/`, which is the whole application. That 337 is an **on-disk**
count, not a `git ls-files` count: 336 of them are tracked and one is not, so a suite you have written
but not `git add`ed is already being parsed — and the number will disagree with a tracked-file total
until you commit. `tmp/` is **not** one of the
seven, so the **109 tracked probe scripts** sitting there are never parsed by it (nor are
`research/incoming/check-san.js` or the stray file at the `C` + U+F03A path — 111 tracked `.js` files
outside the scan in total). That is the right trade for throwaway probes, but it means "the tree parses"
means the application parses: a broken probe stays broken until someone runs it.

Every number in that paragraph, and the two guards' own output, were re-read on 2026-11-12 and all still hold:
`syntax-check` prints `Syntax-checked 337 files: all OK`; `git ls-files` counts **2,846** tracked files; the
seven scanned directories hold **336** tracked `.js` files, so the 337 really is that plus one untracked file;
and `tmp/` really does hold **109** tracked probes that nothing parses. `check-control-bytes.js` prints
`No control bytes in source. (.js .json .md .yml .yaml .css .html .sh)`, `check-node-surface.js` prints
`No API newer than Node 18 in 466 source file(s).` (the 466 counts files, not APIs — it is a scan total, not a
finding, and it counts **whatever is on disk**: `walk()` covers the whole tree bar
`node_modules`/`.git`/`research`/`examples`/`dist`/`coverage` and dot-entries at any depth, so an untracked
probe in the repository root is inside the total — measured 466 clean and 467 with one `p822a.js` sitting
there, which is how a "drift" of exactly one usually turns out to be the auditor's own file), and
`check-canonical-urls.js` prints
`OK — 2332 files, every project URL points at https://git.jayw.uk/jaylouisw/packetforge`, with
`test/canonical-urls.test.js` at **43 passed, 0 failed** — which is the 2332 in context: a count that is
green *and* a count that moves when a file is added, so it is worth re-reading rather than quoting. The job
structure is also as described, read straight out of the workflow rather than remembered: three jobs
(`test`, `smoke`, `docker`) and **eleven steps that do work** — seven in `test`, one in `smoke`, three in
`docker`. Parsing the YAML counts **16** list items instead, because five of them are `checkout` and
`setup-node` boilerplate (two, two and one); the eleven are what remains, so the two numbers answer
different questions and neither is a miscount. `check-control-bytes` appears as its own step **once**,
which is why the twice-per-push remark above needs the
`npm test` half to be true (it is: `npm test` is `audit:ports && check:bytes && run-tests.js`).


**What the control-byte guard actually looks at.** `check-control-bytes.js` walks the tree and reads only
eight extensions — `.js .json .md .yml .yaml .css .html .sh` — skipping `.git`, `node_modules`,
`.github-cache`, `dist` and `coverage`. Tab, LF and CR pass; anything else below `0x20`, plus `0x7F`, is a
finding. That leaves **11 of the 2,846 tracked files outside the scan**: six with no extension
(`.dockerignore`, `.editorconfig`, `.gitattributes`, `.gitignore`, `Dockerfile`, `LICENSE`), four `.txt`
(three in `tmp/`, one research cache) and `research/incoming/build_devices_docsis.py`.

Do not count those with a `git ls-files | grep -vE '\\.(js|json|md|yml|yaml|css|html|sh)$'` recipe: it
returns **12**, not 11, and the extra line is a false positive worth knowing about. One tracked path in
this tree begins with a stray `C` followed by U+F03A, and the file at the end of it is `verify-slaac.js` —
inside the scan, because the guard tests `path.extname`, but *quoted by git* in `ls-files` output, so the
recipe's `$` anchor stops matching at the closing quote. The guard's own walk has no such problem: it
recurses on `readdirSync` with only its skip list excluded, so it visits that directory and reads the file.

Proved on a fixture
rather than assumed: the same `0x08` planted in ten files was caught in `.js`, `.json`, `.md` and `.yml`,
and **missed** in `.txt`, `.py`, `.bat`, `.svg`, `Dockerfile` and a dotfile with no extension. It takes no
flags either — `--check` and `--bogus` both run the normal job and exit 0 — which is the ignored-flag
behaviour the script table in `CONTRIBUTING.md` warns about for the rest of the tooling.


**That coverage gap has a consequence worth stating plainly.** The WebSocket upgrade is documented
in `docs/ARCHITECTURE.md` and was measured by hand with an RFC 6455 client, but nothing in CI or in
`test/` drives it — `grep -rl "Sec-WebSocket" test/ scripts/` finds nothing. A regression in the upgrade
handshake would be found by a human or by using the UI, not by a red check run.

The three jobs carry 7 + 1 + 3 steps between them (measured by counting `- name:` under each job in
`ci.yml`): the test job seven, the smoke job one, the Docker job three — the static `Dockerfile` check, the
CLI install, and the build.

**Of those three, only the build fails harmlessly.** The install is a hard step —
`apt-get update && apt-get install -y docker.io`, with **no `continue-on-error`**, and `git log -S
'continue-on-error' -- .forgejo/workflows/ci.yml` finds no commit that ever added one — so an apt failure
takes the Docker job red. The *build* is the guarded one: it asks `command -v docker` and `docker info`, builds
only if both answer, and otherwise prints the reason it did not ("No docker daemon in this job image…") and
passes. The order matters for reading a red mark: `Dockerfile static checks` failing means the file is wrong,
`Install Docker CLI` failing means the runner could not reach a package mirror, and neither is the image
failing to build.

Re-counted on 2026-11-12: three jobs, eleven named steps, `7 + 1 + 3`, and the `test` job's
`matrix.node: [18, 20, 22]` with `fail-fast: false` — five check runs from three jobs, exactly as the top of
this page says.

### Running the same checks locally

```bash
npm test              # every suite — but read the note below, it is three commands
npm run syntax        # syntax-check across every JS file
npm run smoke         # spawns the server, drives the routes a client needs first, shuts down
docker build -t pf .  # exactly what the Docker job does
npm run audit:ports   # per-port type audit
```

`npm run smoke` is safe to run with a lab open: `scripts/smoke-http.js` picks a free port with
`listen(0)` inside `freePort()` (`:26`), spawns the server with `PORT` set to it, `PF_DATA` pointed at
a temporary directory and a third variable, `PF_NO_OPEN=1`, that **nothing reads** —
[ARCHITECTURE.md](ARCHITECTURE.md#environment-variables) lists it as read by nothing, and the server
opens no browser with or without it — then kills the child, so your `data/topologies/` is never
touched. On this tree it prints **18** `ok`
lines and ends `HTTP smoke passed (all checks clean)`; the count grows whenever a route is added, so
read it as a snapshot rather than a contract — and read it as **eighteen**, not "every route": that phrase
used to sit in the command block above and contradicted this page's own row, which lists the ten board-scoped
routes the smoke never calls. Measured while checking: the scratch directory is `os.tmpdir()/packetforge-smoke-<pid>`,
`shutdown()` deletes it on the success path **and** on the start-failure path, and a run today left none behind —
but nothing handles a signal, so a `Ctrl-C` mid-run leaves one directory for you to remove.

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

// GFM makes the leading and trailing pipe optional, so counting `split('|').length - 2` reports a
// row that simply has no closing pipe as one cell short. Normalise both ends instead: that was a
// false positive against a nineteen-row table whose last row ends `(61 assertions)` with no `|`.
function cells(line) {
  const parts = line.replace(/\r$/, '').split(/(?<!\\)\|/);
  if (parts.length && parts[0].trim() === '') parts.shift();
  if (parts.length && parts[parts.length - 1].trim() === '') parts.pop();
  return parts.length;
}

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
    const n = cells(L[i]);
    for (let k = i + 1; k < L.length && L[k].startsWith('|'); k++) {
      const m = cells(L[k]);
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
const seenGhost = new Set();
for (const f of files) {
  const t = fs.readFileSync(f, 'utf8');
  for (const m of t.matchAll(/test\/([\w.-]+\.test\.js)/g)) {
    // One line per page-and-name pair, not per mention: a §11 row that names a ghost suite three
    // times is one citation to weigh, and counting mentions made this number drift with prose edits.
    if (seenGhost.has(f + ' ' + m[1])) continue;
    seenGhost.add(f + ' ' + m[1]);
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
    if (next.trim() === '' || next.startsWith('|') || next.startsWith('\`\`\`')) continue;
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
node md-check.js docs/*.md docs/wiki/*.md README.md CONTRIBUTING.md CHANGELOG.md
# 0 shape problem(s), 0 broken anchor(s), 11 cited-but-absent suite(s), 0 broken table(s), 0 cross-file anchor(s)
```

Three repairs were needed before the sample above would run at all, and each one had been hiding behind
the next:

- **A raw triple backtick inside the fence closed it.** `next.startsWith('```')` is legitimate JavaScript
  — check 4 needs it to skip a fenced line — but markdown ends the code block at that line, so the
  published script stopped mid-string and the rest of it rendered as prose. It now reads
  `next.startsWith('\`\`\`')`, which is the same three characters to JavaScript and invisible to the
  fence parser. Any page that publishes code *about* markdown has this trap.
- **The citation pass counted mentions, not citations.** It printed **16** lines over **11** page-and-name
  pairs, because a §11 row can name the same ghost suite three times. Deduplicating per page and name
  gives the **11** this page quotes, which is also the number the prose always described.
- **The shape pass assumed both pipes.** `split('|').length - 2` reports a row with no closing pipe as one
  cell short; GFM makes that pipe optional, so the check flagged a legitimate table and would flag every
  table in a page written without trailing pipes. `cells()` now normalises both ends.

**`md-check.js` is not in this repository, and that sentence is a lie on a fresh clone.** The script above is
published in full but it lives **outside** the tree — it was written as a scratch tool while these pages were
being audited — so `node md-check.js …` from the repository root answers
`Error: Cannot find module '…/md-check.js'`. Save the block above as `md-check.js` wherever you keep scratch
files and run it from there; the paths it takes are relative to your shell, not to the script:

```bash
node /some/where/md-check.js docs/*.md docs/wiki/*.md README.md CONTRIBUTING.md CHANGELOG.md
# 0 shape problem(s), 0 broken anchor(s), 11 cited-but-absent suite(s), 0 broken table(s), 0 cross-file anchor(s)
```

That is today's line (2026-11-12), and it is the reason the comment above is unreliable rather than wrong: with
**eleven** absent-suite citations the checker prints the long form, never `tables and anchors clean`, and the
number moves whenever a page gains or loses a citation. Read the first two fields as the pass/fail and the
third as a list you then have to look at.

The shape check matters more than it sounds: a `|` inside a backticked command —
`` `show flows [<id> | counters]` `` — silently adds a column, and the table still *renders*, just with
a cell pushed off the end. Escape it as `\|` inside the cell. The anchor check catches a link to a
heading that was renamed, which is the usual casualty of rewording a section title. The suite check
catches a document citing a `test/*.test.js` that does not exist — and re-measured on 2026-11-12 it reports
**eleven**, across **six** distinct absent names: two citations each for `bgp-policy`, `bgp-policy-wire`,
`poe-derived`, `upstream-baseline` and `upstream-service`, and one for `help-completeness`. By page:

```
5  SIMULATION.md          2  CI.md
2  BGP-POLICY.md          2  UPSTREAM-DESIGN.md
```

(each name without its `test/` prefix and `.test.js` suffix, so that this paragraph does not count itself
— spell them out in full here and the check below reports six more than the number beside it)

That total was **fifteen** when this paragraph was written, which is the honest history of a number that
counts citations rather than files: editing a row to say less about a proposal removes citations, and this
page's own audits do that. Recount before quoting it.

What each of the six is matters more than the total. Two are suites a design page proposes
(`BGP-POLICY.md`); two more are the same idea on `UPSTREAM-DESIGN.md`; `poe-derived` has never existed in
`git log --all` and is named only by §11 rows whose subject *is* that absence; and `help-completeness` is
an **upstream-only** file — the merge brings it, this branch has no such suite, which is said in full
twenty lines up. All six are written without prefix and suffix here, for the same reason as the block
above. That is why the check prints rather than fails — a design page naming a
file it wants written is legitimate — and the only way to keep the distinction honest is to look at the
list: recount with `node md-check.js … | grep 'cites test/'` before quoting a number from this paragraph,
because this one has been wrong in three successive directions for exactly that reason. The fourth check is the one this page learned the hard way:
a **table row wrapped onto a second line** keeps its cell count, so the shape check passes, but GitHub
renders the wrapped text as a paragraph and the table silently loses its last row on screen. Every
table must be followed by a blank line — including the one above.

### What the pages claim about the code

`md-check` reads the *prose as prose* — tables, links, suite names. It cannot see the other thing a
documentation page does: name a file, a script or a constant in backticks as though it exists. **Three**
classes go stale silently — a path, an `npm run` script, a constant or error code — and each of the three
has a one-liner below, written from a run on this tree. Two further checks continue the numbered list that
started above: the **fifth** is a link into the middle of another document, the **sixth** is a
`file.js:123` citation. So in this section *class* counts to three and *check* counts to six, and a
sentence about "the third class" is not talking about "the fifth check".

**A `js` label means JavaScript syntax, not a program that runs.** Nothing in CI executes a fence, so
the label has never been tested — and a census of the pages shows it should not be trusted as a promise.
Counting the **21 pages that carry code** — `docs/*.md`, `README.md`, `CONTRIBUTING.md` and
`CHANGELOG.md` — there are **727** fenced blocks (536 unlabelled, 62 `bash`, 45 `text`, 35 `js`, 26 `json`,
18 `sh`, 3 `jsonc`, 1 `yaml`, 1 `console`). **22 of the 35 `js` blocks parse under `node --check` and 13 do
not**, and none of the 13 is meant to: three are loop-body excerpts that end in `continue`
(`CONTRIBUTING.md:565` and `:576`, `docs/BGP-POLICY.md:690`), six are data shapes written as a literal with
a `'permit' | 'deny'` union or the same kind of fragment (`docs/BGP-POLICY.md:902` and `:1074`,
`docs/CONNECTORS.md:448` and `:1071`, `docs/PHYSICAL_LAYER.md:536`, `docs/UPSTREAM-DESIGN.md:208`), one
is a branch list lifted out of a dispatch chain (`docs/BGP-POLICY.md:983`), one a method body without its
class (`docs/UPSTREAM-DESIGN.md:369`), one a `return` at the top level without the function it returns
from (`docs/UPSTREAM-DESIGN.md:241`) and one an abbreviated expression
(`docs/DEVICE_REGISTRY.md:107`). Copy any of those thirteen and the first thing you get is a
`SyntaxError`. Both counts move whenever a page is edited, and the line references above are a census
rather than a fixture: all twelve older ones had drifted by exactly one line at this count, in the same
direction, after a single-line edit near the top of the pages involved — which is the price of citing a
line instead of quoting the block, and the thirteenth fragment arrived with a page that grew one.

Re-derive it rather than trusting the number: count the lines whose first non-space characters are three
backticks and halve, because every block contributes one opening and one closing line. That answers **727**
today; the same count with a column-0 pattern answers **677**, since 50 of these blocks are indented inside
list items — which is also why a census taken by eye and one taken by grep disagree, and why the numbers above
are worth re-running rather than quoting.

The twenty-two that do parse are the ones a reader actually runs, and those are worth keeping honest: if a
snippet has a `node` on the first line, execute it from the page before committing it, because the page
is the only place it will ever be tested.

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

On this tree it prints **18** missing, and every one is deliberate. Do not quote that number as a
target: an audit row that *describes* an absent file adds an absent file, and every pass that records a
removal adds one more citation of the thing removed. Run the one-liner, read the list, and check each
entry against the three groups below. The eighteen break down as: **9** citations of the four proposed
design suites (`upstream-baseline.test.js` ×3, `bgp-policy.test.js` ×2, `bgp-policy-wire.test.js` ×2,
`upstream-service.test.js` ×2); **4** citing `test/poe-derived.test.js`, which has never existed in
`git log --all` and appears only in §11 rows whose subject *is* that absence; and **5** citing
`web/link-parts.js`, which was deleted and is named only by the rows that record its removal
(`SIMULATION.md` three times, this page twice). By page: `SIMULATION.md` 10, `CI.md` 3,
`UPSTREAM-DESIGN.md` 3, `BGP-POLICY.md` 2. Those per-file counts do not match the suite-check block
above — `upstream-baseline.test.js` is 3 here and 4 there — because the two checks count different
things: `md-check` prints one line per **page-and-name pair**, and this one counts **citations**, so a
single row naming four files is one row and four citations, and a page that names the same absent suite on
four lines still contributes one pair. That is why the block above reads `SIMULATION.md 5` while the same
page holds nine citations of those names: five distinct names, nine mentions. Neither number is wrong;
quoting one against the other is. So the
number grows whenever history grows, which is why this paragraph carries the breakdown and not just a
count. Anything that does not fall into one of those three groups is a renamed file and a broken page.

**Every `npm run x` a page tells you to type, must be a script.** A renamed script is worse than a
missing file because the reader believes they made the mistake:

```bash
node -e '
const fs=require("fs");
const scripts=new Set(Object.keys(require("./package.json").scripts));
const docs=["README.md","CONTRIBUTING.md",...fs.readdirSync("docs").filter(f=>f.endsWith(".md")).map(f=>"docs/"+f),...fs.readdirSync("docs/wiki").map(f=>"docs/wiki/"+f)];
let bad=0;
for (const d of docs){ fs.readFileSync(d,"utf8").split("\n").forEach((l,i)=>{ let m;
  const re=/npm run ([a-z0-9:_-]+)/g; while((m=re.exec(l))){ const name=m[1];
    const after=l.slice(m.index+m[0].length, m.index+m[0].length+1);
    if (name==="x" || after==="<") continue;          // prose placeholder, not a citation
    if(!scripts.has(name)){ console.log(d+":"+(i+1)+" -> npm run "+name); bad++; } } }); }
console.log(bad?bad+" cited npm script(s) do not exist":"every cited npm script exists");'
```

It prints `every cited npm script exists` today, against the **54** scripts `package.json` actually defines.
Without the two `continue` guards it prints **four hits**, and every one is an artefact rather than a
finding: `npm run x` is this page's own placeholder (three pages quote it — here and twice in
`SIMULATION.md`), and `npm run test:<area>` in `CONTRIBUTING.md` is a family prefix, which the character
class happily swallows as the script `test:`. A checker that reports the sentence explaining it is worse
than useless, so the regex skips a bare `x` and anything followed by `<`. The guard still bites: point a page
at a script that is not there and it prints the file, the line and the name in its `<file>:<line> -> name`
form, which is why the two guards above name a shape rather than quote a fake.

Backticked **constants and error codes** are the third class, and the one where a raw existence check
misleads: `BGP-POLICY.md` and `UPSTREAM-DESIGN.md` are design documents, so they name codes the engine
does not raise yet (`W_SINGLE_HOMED`, `E_NAT_EGRESS_MISMATCH`, `MED_MAX`, `WELL_KNOWN_COMMUNITIES`)
deliberately, in a column headed *this design changes it to*. Grep for each one, and treat an absence as
a finding **only** on a page that describes what the engine does today — `CLI.md`, `LINK-STATE.md`,
`DEVICE_REGISTRY.md`, `PHYSICAL_LAYER.md`. Run over the whole tree the sweep answers **169** distinct `E_`/`W_` codes in `engine/`, `server/`, `web/`
and `scripts/`, **28** distinct codes cited that no source file raises, and **33** page-and-code lines —
the difference because a code can be named on more than one page. The 33 pairs break down as **26** in
`UPSTREAM-DESIGN.md` (16 `E_`, 10 `W_`), **4** here, **1** in `LINK-STATE.md`, **1** in `SIMULATION.md`
and **1** in `HYBRID-PATCH.md`. Every absence is accounted for: the 26 are that page's "this design
changes it to" column, **1** is `E_PATCH_CORD_NOT_A_BRIDGE` in `HYBRID-PATCH.md` as a proposed check on
`polishBridge`, and **1** is `E_CONVERGING`, which `LINK-STATE.md` mentions in order to say a reader will
*not* find it here — the sentence is about an absence, which is the one place a bare existence check
cannot tell diligence from drift. The remaining pairs are the accounting itself: **this page** quotes
`W_SINGLE_HOMED`, `E_NAT_EGRESS_MISMATCH`, `E_PATCH_CORD_NOT_A_BRIDGE` and `E_CONVERGING` while
explaining the sweep, and `SIMULATION.md` names `E_CONVERGING` twice in its own reconciliation rows — the
same self-reference the citation sweep hits with its invented `engine/foo.js`. A sweep that counts the
page documenting it will never read zero, which is why the number to watch is the list, not the total. So the sweep's answer is not "zero", it is "zero on the pages that describe today":

```bash
node -e '
const fs = require("fs"), path = require("path");
function walk(d, o = []) {
  for (const e of fs.readdirSync(d, { withFileTypes: true }))
    if (e.isDirectory()) walk(path.join(d, e.name), o);
    else if (e.name.endsWith(".js")) o.push(path.join(d, e.name));
  return o;
}
const CODE = /\b[EW]_[A-Z0-9]+(?:_[A-Z0-9]+)*\b/g;
const src = ["engine","server","web","scripts"].flatMap(d => walk(d))
  .map(f => fs.readFileSync(f, "utf8")).join("\n");
const have = new Set(src.match(CODE) || []);
for (const doc of fs.readdirSync("docs").filter(f => f.endsWith(".md")))
  for (const c of new Set(fs.readFileSync(path.join("docs", doc), "utf8").match(CODE) || []))
    if (!have.has(c)) console.log(doc, c);'
```


And a warning about the first check, because it cost this page a full pass of false confidence: as
originally written the separator test was `/^\|[\s:-|]+\|$/`, whose character class `[:\-|]` is the
range `:`–`|`. `-` is not in that range, so the test matched **no separator line in any table** and the
shape check silently inspected nothing while reporting "clean" after every run. It found seven real
violations the moment the hyphen moved to the front. If you rewrite the check, keep `-` first in the
class and prove it fails on a deliberately broken table before trusting a green line.

The fifth check is the one the list had been missing: same-file `#anchor` links were covered, but
a link into the middle of a different document (`OTHER.md#anchor`) was not, and that is the shape
that breaks on every heading rename. It resolves the target relative to the linking file and demands the
heading exist there. **Five** such links exist today, all in `README.md` — into `CLI.md` three times (the
NAT section, link aggregation and DHCP relay), into `ARCHITECTURE.md` once (transport flows) and into
`CI.md` once (known gaps) — and all five resolve. It was three when this paragraph was written, which is
the point of the next sentence: the number is not stable and does not need to be. Count them with

```bash
grep -rhoE '\]\([A-Za-z0-9_./-]*docs/[A-Za-z0-9_.-]+\.md#[^)]+' docs/*.md docs/wiki/*.md README.md CONTRIBUTING.md CHANGELOG.md | wc -l
# 5, on the tree this was measured against
```

That pattern requires a `docs/` prefix, so it counts one spelling rather than one kind of link, and
there are six more of the same shape written relative to the file they live in: `ARCHITECTURE.md` into
`DEVICE_REGISTRY.md` (the `#capabilities` heading) and into `../README.md` (the `#if-it-will-not-start`
one that climbs out of the directory), `CI.md` into `REQUESTING-HARDWARE.md`
(`#what-the-form-does-measured`), `CLI.md` into `SIMULATION.md` (`#33-routing-and-administrative-distance`),
`PHYSICAL_LAYER.md` into `DEVICE_REGISTRY.md` (`#correcting-an-existing-spec-with-researched-facts`) and
`SIMULATION.md` into `CLI.md` (`#dhcp-server`). All six resolve, which is why the check below reports
nothing broken while the recipe above prints 5 — the number belongs to the pattern, not to the tree.

The check was proved to bite by pointing one of them at a heading that does not exist — and it bit for
real when the NAT heading was renamed, which is how the count came to be re-measured.

The sixth class is `file.js:123`, and it splits cleanly into a part a checker can own and a part it
cannot. **Whether the cited line exists** is mechanical, and cheap enough to run on every pass:

```bash
node -e '
const fs=require("fs");
const docs=["README.md","CONTRIBUTING.md",...fs.readdirSync("docs").filter(f=>f.endsWith(".md")).map(f=>"docs/"+f),...fs.readdirSync("docs/wiki").map(f=>"docs/wiki/"+f)];
let n=0, bad=0; const files=new Set();
for (const d of docs) fs.readFileSync(d,"utf8").split("\n").forEach((l,i)=>{
  const re=/((?:engine|server|scripts|web|test)\/[\w./-]+\.js):(\d+)/g; let m;
  while((m=re.exec(l))){
    n++; files.add(m[1]);
    if(!fs.existsSync(m[1])) { console.log(d+":"+(i+1)+" -> "+m[1]+" does not exist"); bad++; continue; }
    if(+m[2] > fs.readFileSync(m[1],"utf8").split("\n").length) { console.log(d+":"+(i+1)+" -> "+m[1]+":"+m[2]+" is past the end"); bad++; }
  }});
console.log(n+" line citation(s) across "+files.size+" file(s); "+bad+" point at nothing");'
```

It prints `312 line citation(s) across 38 file(s); 1 point at nothing` on this tree, and it catches the
one failure that is invisible in prose: a citation left pointing past the end of a file that shrank. The
single reported line is this page's own illustration: the invented `engine/foo.js` cited further down, at
a line that does not exist, is there to show what the sweep catches, so a reading of 1 here is the
demonstration working rather than a defect. The citation count is not a property of the checker: it was
**293** when this paragraph was written and is **312** now, because pages keep being edited. What should
stay at zero is the number of *real* misses, and only a reading of the paths can tell those from the
example.

**Whether the cited line says what the sentence claims** does not reduce to a check, and it is worth
recording why, because the obvious version of it is a trap. Pair each citation with the backticked
identifier on the same line and demand the identifier appear within a few lines of the number: on this
tree that test has **53** lines it can pair up unambiguously — exactly one backticked citation and one
backticked name on the line — and it flags **24** of them at a two-line window. (The count was 49 and 19
when this paragraph was written; pages have been edited since, which moves both.) Reading them found
**zero** defects: they are multi-clause sentences citing one file for a clause that names no symbol, and
range citations whose first line is the comment above the definition. The two that look most like real
defects are both that first cause — `RULES` beside `engine/optical.js:140` names the enumeration the
sentence is about while the number points at the `E_OPTICAL_BUDGET` literal, and `validateTopology()`
beside `engine/vlan.js:387` points at the `E_VLAN_RESERVED` refusal in a file where that function does
not exist at all. A grey list that is wrong twenty-four times out of twenty-four does not get shorter
as the tree improves, because its false positives are all correct prose.

Worse, it misses the case the last audit of this page actually found. The two broken citations in
`SIMULATION.md`'s guard-rails bullet — `maxSteps = 8000` cited at `:156` when it is set at `:181`, and the
runaway guard cited at `:3095` when it is at `:3307` — sat on a line carrying **two** names and **two**
citations, which is exactly the line a one-name-one-citation rule skips as ambiguous. The tool would have
stayed quiet on the only two real findings in 293 citations. So: check existence mechanically, read the
pairing by hand, and expect the hand pass to be the slow one.

The wrapped-row check has one subtlety worth keeping: it only considers lines that belong to a real
table (a `|` line followed by a separator). Prose is allowed to start with `|` — a sentence that wraps
just after a pipe inside a code span does exactly that — and flagging it sends you to rewrite a
paragraph that renders perfectly. The first version of the check did not distinguish the two and spent
a pass pointing at a sentence in `CLI.md` about `ip ospf cost <n> | area <id> | passive`.

If `npm test` is green locally and CI is red, check the Node version: CI runs 18
as well as 22, and a newer-than-18 API — `Array.prototype.findLast`,
`structuredClone`, `Object.groupBy` — is the usual culprit. `scripts/check-node-surface.js`
runs before the matrix precisely so that failure is named instead of mysterious.

### The help-page guards: four tests, one question each

The console's help tree is the source of three separate promises, and four suites keep them apart. All
four were run on this tree to write these numbers; all four are green.

| Suite | Assertions | The question it asks |
|---|---|---|
| `test/abbrev.test.js` | 47 | a keyword typed as a prefix is the command it abbreviates — `sh ip int br` is the line people actually type |
| `test/completion.test.js` | 52 | `?` in any position is a question about what has been typed, never a bad argument |
| `test/shortest-abbrev.test.js` | 21 | every documented row, in **seven** modes, shortened to its *shortest unique* prefix, is not answered with a typo — an ambiguity passes only when the refusal names two or more candidates that exist on that page |
| `test/placeholder-rows.test.js` | 14 | every documented row **with a value in it**, in **eight** modes, filled in from a table of values, is a command the console takes |

**Four suites are not the whole surface.** `test/` carries **fourteen** suites that exercise help output;
these four are the ones above, and the other ten are `abbrev-ambiguity` (6), `arg-keyword-abbrev` (69),
`help-coverage` (26), `help-forms` (5), `help-placeholders` (20), `help-truthful` (33), `keyword-abbrev`
(27), `no-placeholders` (13), `pipe-help` (30) and `router-mode-help` (47) — **410 assertions across the
family**, all green on this tree. A help change that reddens one of the ten is still a help regression,
even though the 134 below did not move.

**134 assertions, and they fail in different directions.** All fourteen were re-run individually on
2026-11-12 and every count above reproduces — 47, 52, 21, 14 and 6, 69, 26, 5, 20, 33, 27, 13, 30, 47 —
for **410** across the family and **134** in the first four, the same two totals the prose derives. So the
table is a reading that currently holds, not an inheritance; when a help change lands, expect exactly one
number to move and re-derive both sums rather than one. The first two are behavioural: they type lines
and assert on answers. The last two are *derived* — they read the help rows and type what those rows
promise — so they can go red with no behaviour change at all, which is exactly what a doc row edit
produces. That is the mechanical reason a `cli.js` help change and a `CLI.md` edit belong in one commit:
the derived suites do not read the page, and the page is not checked by anything here.

The one that *does* read the page is `docs-syntax`, and it is the only member of the set that would
notice a command documented in `CLI.md` that no help row offers. Today it reads **312 help forms across
four modes and 173 command synopses from `CLI.md`** — and that 312 is a *HEAD* reading: run from a
detached checkout of `33406561` it prints 312 / 4 modes / 173, while the same test in the working tree
prints **313**, because the value-hints work uncommitted there adds a help form. A number from this
suite is only comparable with another number from the same tree.

Both of those readings were taken again to check the claim, and both reproduce exactly (`312` at the
detached commit, `313` in the tree, `173` synopses and `4` modes in both). The way to take the detached
half is a worktree, and it must live **outside** the repository — a checkout nested in the tree is walked by
`check-canonical-urls` and moves that figure, which is the same trap as an untracked probe:

```sh
git worktree add --detach ../pf-head 33406561      # ~17 s, no node_modules needed
cd ../pf-head && node test/docs-syntax.test.js     # Read 312 help forms from 4 modes and 173 command synopses
cd - && git worktree remove --force ../pf-head
```

The 48%…49%… progress lines `git worktree add` prints are just the 2,846-file checkout; the suite itself needs
nothing installed because it requires only `engine/`. Between them the five suites cover the keyword
sweep, the `?` surface, the shortest-prefix rule, the value-bearing rows, and the page — no one of them
subsumes another, so a green run means all five ran.

One direction none of the five covers: **every verb the dispatcher accepts is a verb the index mentions.**
`docs-syntax` checks the opposite way round (a command in `CLI.md` that no help row offers), and the four
derived suites read help rows rather than the parser, so a verb the console accepts and `help` never names
would be found by nothing here. Measured today by reading the tokens the dispatcher compares against `head`
out of `engine/cli.js` and requiring each in the `_help()` block: **64 tokens, 55 after dropping the nine
keypresses** (`?`, `end`, `exit`, `help`, `logout`, `quit`, `conf`, `en`, `int`) **and one absent — `!`**,
which is not a mechanism at all: `cli.js:519` matches `head === '!'` and returns the output with no actions, so
it belongs with the keypresses, not in an index an operator reads to find out what the box can do. Everything
else is named, including `traceroute`/`tracert`, `clock rate` and the DHCP pool sub-mode.

That matters for the merge rather than for this tree: upstream `main` carries `test/help-completeness.test.js`
for exactly this direction (it found fifteen unlisted verbs there, #1492), and this branch has no such file, so
the check arrives with the merge rather than being written here.

**Suite counts are not comparable across the merge line, and it is not close.** Measured against `1b1e1287`, which
both remotes now resolve to: upstream `main` tracks **248** files matching `test/*.test.js`, this branch tracks
**271**, and only **109** names appear on both sides — **162** exist only here, **139** only upstream. So
`git diff --name-status HEAD forgejo-http/main -- test/` reports `139 A, 162 D, 25 M`, which reads as though the merge
deletes most of the suite and does not: upstream's files are named differently for the same areas (`arp-ageing`,
`api-errors`, `address-rule` have no counterpart here under those names, while `abbrev`, `bgp-counts` and
`bgp-router-mode` have none there). Nothing in this page survives that comparison as a claim about `main`, which is
why every count here is explicitly a count of this branch: the post-merge total is not 248, not 271, and not their
sum.

**The page's own tables are typed by nothing.** The four suites read the *help rows*, and `docs-syntax`
compares synopses to help forms; none of them types a command **as a page writes it**, in the mode the
page puts it in. That gap is worth closing by hand occasionally, because it is the reader's view of the
system: fill each row's placeholders from a table of values and type it in the section's mode. On this
tree that is **106 rows — 71 `exec`, 27 `config`, 8 `interface` — and every one is accepted**. The three
that came back refused on the first pass were the harness's fault, not the page's, and all three are the
same warning: `ip helper-address` is an **interface-mode** command that a keyword classifier filed under
config, and `vlan-drop` / `vlan.js` are identifiers in a table's first cell rather than commands. Read
each flag by hand, and take the mode from the section heading rather than from the verb — the tables are
the mode.

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

Every job also carries a `timeout-minutes` bound — **15** for `test`, **10** each for `smoke` and
`docker`. A hung job on a single runner is not a slow job, it is a stopped queue — and
indistinguishable from a merely busy one.

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

### Reading an `auto-rebase` run log

The last line of a run is the whole story:

```
batch=5 rebased=2 current=1 conflicts=1 duplicates=1 armed=3 rearmed=12
```

Seven counters, and the per-PR lines above it name every pull request that made one move. The vocabulary
is worth having to hand, because each line is a different diagnosis:

| Line | Means |
|---|---|
| `PR #n: rebased onto main` | a real `git rebase` succeeded; the branch was force-pushed with `--force-with-lease` |
| `PR #n: already contains main` | nothing to do — the head already carries `main` |
| `PR #n: no diff against main (already merged elsewhere)` | the change is on `main` already; pushing would make an empty commit and block the merge for good |
| `PR #n: conflict, left for a human` | the rebase was aborted and the branch left untouched. A conflict is a decision about behaviour, so the workflow refuses to guess |
| `PR #n: push rejected (branch moved underneath us)` | someone pushed while the pass was rebasing; the next tick retries |
| `PR #n: mergeable still not computed after 120s, leaving it armed-pending` | the poll gave up. Forgejo computes `mergeable` off-thread, and arming early answers **405**, which looks like a refusal and is not |
| `PR #n: armed for squash merge on green checks`, `already armed` | armed, or already was — **409** is counted as success because it means exactly that |
| `PR #n: branch <ref> is gone` | the pull request was closed mid-pass |

Two things the counters do not say. `batch` is a **workflow-dispatch input, default 5** — one runner on
this host, so a tick rebases the oldest five and leaves the rest for the next one. And `rearmed` is
normally far larger than `armed`, because a force-push **clears** the armed flag on every branch in the
batch; after the rebase loop the workflow makes a second pass over everything already `mergeable`, so a
queue that lost its arms gets them back in one tick instead of five at a time.


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
  for the queue's health. The scale is worth knowing: `main` no longer carries
  `.github/workflows/` at all (it holds `.github/` templates, labels and dependabot
  config only), the remote advertises **872** heads and a sample of twelve spread evenly through that
  list found **nine** still carrying `.github/workflows/ci.yml`. So this is not a handful of forgotten
  branches; most of the queue is running workflows that cannot pass.

  Two things to know before reproducing those numbers. The count is `git ls-remote --heads <remote> |
  wc -l`, and `<remote>` matters: this checkout's `origin` is `ssh://forgejo/…`, an SSH host alias that
  resolves on the machine holding the key and **not** in a sandbox where the alias is absent — there it
  answers `ssh: Could not resolve hostname forgejo` and the count comes out `0`, which reads like an
  empty remote rather than a broken alias. The same repository is also configured as `forgejo-http`
  (`http://odin:3000/jaylouisw/packetforge`), and that is the remote these readings came from. Ask a
  branch whether it still carries the file with the API instead of cloning 872 of them:
  `http://odin:3000/api/v1/repos/jaylouisw/packetforge/contents/.github/workflows/ci.yml?ref=<branch>`
  answers **200** or **404** — twelve requests instead of twelve checkouts.
  the queue is running workflows that cannot pass.
- **Whether any suite is red is a reading, not a fact about the repository — so read it.** The two
  suites that were red for a long time are green now: `test/spec-vs-description.test.js` **3 passed, 0
  failed** and `test/canonical-urls.test.js` **43 passed, 0 failed**, with `scripts/check-canonical-urls.js`
  printing `OK — 2200 files, every project URL points at https://git.jayw.uk/jaylouisw/packetforge`. That
  number is the one in this paragraph that moves on its own: **2114 → 2200 → 2278 → 2332** today, and none of the
  three moves touched a URL, so read it as a snapshot and re-run the script rather than quoting it.

  The tree is **not** always green, and it moved twice in one evening while this paragraph was being
  written. Two full runs with `node scripts/run-tests.js`, minutes apart:

  | Run | Reading | Red suites |
  |---|---|---|
  | while the `show`-argument work was in flight | 232 suites, **9,980 passed, 62 failed** | 14 |
  | after the help rows caught up | 232 suites, **10,037 passed, 4 failed** | 3 — and one of those is a crash, not four failed assertions: `config-do-show` 1, `link-parts` 2, `ma5801` **0 passed, 1 failed, `(no summary line)`** |
  | three suites later, the OSPF and cost work landed | **239 suites, 10,200 passed, 3 failed** | 2 — `link-parts` 2 failed assertions (`the UI carries every catalogue part (34 of 58)`, and 24 multi-rate rows the catalogue has and `PART_ROWS` does not — 3 `QSFP-DD-400G-*`, 2 `QSFP56-200G-*`, 10 `QSFP28-100G-*`, 4 `QSFP-40G-*`, 2 `SFP-25G-*` and 3 `SFP-10G-*`, so the gap is not one family but every rate class above 10G) and `ma5801` a `TypeError: Cannot read properties of undefined (reading 'hardware')` crash rather than an assertion |

  The second and third rows are the same two suites red for a different reason each time, which is the
  useful part: `link-parts` fails whenever the catalogue grows past the UI's hard-coded part table, and
  `ma5801` crashes when a device's port list no longer matches what the suite indexes. Neither is a
  documentation problem, and both are worth naming here so the next reader does not investigate the
  wrong six hundred lines.

  The fourteen-suite failure had one cause rather than fourteen: `_ignoredArgRefusal()` in
  `engine/cli.js` (`_ignoredArgRefusal(tokens, answer)`, which reads the **enable-mode help table as the
  contract** through `_helpFormRowsAll(MODE_ENABLE)`) refuses a word its row does not declare with
  `% "<word>" is not an argument to "<command>"` before the handler's answer is accepted. The handler was right, the rows were stale, and the tests were the thing saying so.
  That is exactly why a sentence of the form "no suite is red" does not belong in a page: it is a
  reading, and readings go stale between two runs of the same command.

  **A reading also has to say which tree it measured.** Every row in that table was taken on a working
  tree that was being edited at the time, which is why two runs minutes apart disagree — the second one
  saw code the first had not. `node scripts/run-tests.js` reads the file system, not `HEAD`, so on a
  dirty tree it measures the work in progress and says nothing about what is committed. When the
  question is "is `HEAD` green?", measure `HEAD`:

  ```bash
  git worktree add --detach /tmp/pf-head HEAD
  cd /tmp/pf-head && node scripts/run-tests.js
  ```

  That also keeps the run reproducible by a later reader, since the commit it measured is named rather
  than implied. Delete the worktree afterwards (`git worktree remove /tmp/pf-head`) — the repository
  keeps a list, and stale entries accumulate silently. Measured on this machine while taking the fifth
  reading, that list had **nine** leftover worktrees in it (`pf-mainsuite`, `pf-combined`, `pf-int`,
  `pf-main-check`, `pf-mergeall`, `pf-rebase-auto`, `pf-ui`, `tmp/pfwork`, and a second `pf-mainsuite`
  entry) — every one from a past reading or merge attempt. **`git worktree prune` will clear all nine**, and
  this page used to say the opposite, on the reasoning that prune only forgets entries whose directory has
  vanished. That is not prune's rule. Prune forgets an entry whose **gitdir link no longer resolves**, and a
  directory that still exists does not protect the entry: all nine of these directories are still on disk
  (`test -d` says yes for every one), yet `git worktree list` marks all nine `prunable` and
  `git worktree prune --dry-run -v` names every one with the same reason —
  `gitdir file points to non-existent location`. Their `.git` files still point at the old
  `/mnt/c/…`-style path from before this checkout moved, so they are directories pretending to be
  worktrees. So `prune` is the right tool for this wreckage and `git worktree remove <path>` is the wrong
  one: remove expects a live worktree, and these are not. For a worktree you actually used, remove it by
  name (`--force` when it holds uncommitted work); for the ones whose directories merely survive, `prune`.

  Measured that way on `eeafda5a` — a full run, not a sample:

  | Tree | Reading | Red suites |
  |---|---|---|
  | `eeafda5a`, detached worktree, nothing else running | **251 suites in 308.8 s — 10,445 passed, 3 failed** | 2 — `link-parts` (2 assertions) and `ma5801` (a crash) |
  | `ef85c1a9`, detached worktree, nothing else running | **257 suites in 356.6 s — 10,627 passed, 3 failed** | 2 — the same two, the same 2 + 1 |
  | `d4319d27`, detached worktree, nothing else running | **264 suites in 333.4 s — 10,958 passed, 3 failed** | 2 — the same two, and the split is still exactly 2 + 1 |
  | `16d70abe`, detached worktree, nothing else running | **267 suites in 354.5 s — 11,029 passed, 3 failed** | 2 — the same two, still 2 + 1, four readings in |
  | `a1645088`, detached worktree, nothing else running | **269 suites in 368.8 s — 11,079 passed, 3 failed** | 2 — the same two, five readings in, still 2 + 1 |

  Across the five readings the suite grew by 18 suites and 634 assertions while the red set never moved:
  every time, `test/link-parts.test.js` reports `81 passed, 2 failed` and `test/ma5801.test.js` throws
  before printing any tally, so 2 + 1 = 3 assertions across 2 suites. Each row was re-run on its own tree
  rather than carried over, because five readings that agree about a count are not one reading that was
  taken — and the run time wanders between 308 and 369 s with nothing to explain it, which is itself worth
  knowing before you read a slow run as a regression.

  **None of these readings is a reading of `main`.** They were taken in the working tree, which sits on
  branch `fix/sfp-plus-connectors`, and that branch diverged from `origin/main` at `083e2ba1`
  (2026-11-08 16:58:44) — at the time of the fourth reading it was **382 ahead and 361 behind**, so not one of
  the commits above is an ancestor of `main`. That merge base is the only part of this paragraph that holds still.

  The **ahead** count is a fingerprint, not a fact: it is "commits since `083e2ba1`", so it grows by exactly one
  every time this page is committed. The **behind** count depends on the ref you name *and* on when you fetched it,
  because this clone has two remotes for the same repository — `origin` over ssh and `forgejo-http` over http.

  The shape is that those two are **two sampling points on one repository**, and either can lag or neither can.
  Measured three times in two iterations, which is why the number is not worth memorising: at iteration #627
  `origin/main` was `2961f42e` (last fetched 06:06, #1492) and read **395 behind**, while `forgejo-http/main` moved
  from `5bc43ccf` (#1500) to `1b1e1287` *within that iteration* and read **400 behind**; at iteration #634 both refs
  are `1b1e1287` — byte-identical, `git merge-base --is-ancestor` true in **both** directions — and both read
  **678 ahead / 400 behind**. So the earlier "origin has never seen five of forge's commits" is a fact about a
  moment, not about the remotes, and a page that quoted it as the invariant went stale in forty minutes.

  Name the ref, say when you fetched it, do not compare a number on this page with one you just measured, and check
  any commit before quoting it:

  ```bash
  git branch --show-current                              # fix/sfp-plus-connectors, not main
  git fetch forgejo-http main                            # moves the ref, not the worktree
  git fetch origin main
  git rev-list --left-right --count HEAD...origin/main         # 678  400  at iteration #634
  git rev-list --left-right --count HEAD...forgejo-http/main   # 678  400  identical refs, same reading
  git merge-base --is-ancestor d4319d27 origin/main || echo "not on main"
  ```

  This does not make the readings wrong — they are measurements of a tree that exists and has a commit
  id — but a red run here is not a red `main`, and a green one would not be either. The same caveat
  applies to every count on every page in this repository: the catalogue, the CLI transcripts and the
  capability matrix were all measured on this branch. If you need to know about `main`, run the suite on
  `main`.

  **The headline and the list count different things**, which is why "3 failed" sits above two `✗` lines.
  `run-tests.js` sums each suite's own `<n> passed, <m> failed` tally, so the headline is failed
  **assertions**; the `Failed:` block lists failing **suites**. Re-measured on the second reading:
  `test/link-parts.test.js` says `81 passed, 2 failed`, and `test/ma5801.test.js` throws
  `TypeError: Cannot read properties of undefined (reading 'hardware')` before printing any tally, so it
  contributes exactly **1** through `Math.max(failed, 1)` — 2 + 1 = 3 assertions across 2 suites. A
  crashed suite is therefore always worth **one**, no matter how much of it never ran.

  Both are the same two the table above names, for the reasons it gives, and both were re-read rather
  than assumed: `link-parts` reports `the UI carries every catalogue part (34 of 58)` and names the
  missing ones (`QSFP-DD-400G-SR8`, `QSFP-DD-400G-DR4`, `QSFP-DD-400G-FR4`, `QSFP56-200G-SR4`,
  `QSFP56-200G-FR4`, `QSFP28-100G-SR4`, …), so the catalogue is at **58 parts** and `web/app.js` still
  carries **34**; `ma5801` throws `TypeError: Cannot read properties of undefined (reading 'hardware')`
  at `test/ma5801.test.js:96` for `interfaces.get('gpon1/1')`, so the suite indexes a port name the box
  no longer exposes — the catalogue names the PON ports `pon1` … `pon16` (`devices/huawei/ma5801-gp16.json`),
  which is the whole difference between the suite and the spec. The suite is not broken from its first
  line: section 1 prints **10** ✓ lines, section 2 prints its heading and then dies on its very first
  assertion, so the transcript reads as a suite that was working until it wasn't. It has six sections and
  never reaches the last four (`3.` to `6.`), which is why one crash costs one failure rather than the
  assertions those sections would have contributed. Two failures, one message each, and neither is about documentation — which is what
  a "the tree is red" claim should look like when it is honest about which suites and why.

  **How to read the runner's own output**, because two of its habits surprise people:

  | What you see | What it means |
  |---|---|
  | `✓ name            36 passed      792 ms` | the suite's last summary line, and exit status 0 |
  | `✗ name            20 passed, 1 failed` | real assertion failures |
  | `✗ name             0 passed, 1 failed  (no summary line)` | the suite **threw**; the runner counted one failure and marked it so you can tell a crash from a red assertion |
  | trailing block `Failed:` followed by `✗ test/…` | the same suites, listed by path, for grepping |
  | trailing block `Note: N suite(s) printed no "<n> passed, <m> failed" line` | a suite that ran, passed, and never printed its tally — a broken convention rather than a green result |

  Two rules in the code are worth knowing before you trust a number. The **exit code is the authority**:
  `tally()` forces at least one failure whenever a suite exits non-zero, so a suite that prints
  `36 passed, 0 failed` and then dies still counts against you. And only the **last** summary line of a
  suite is used — a suite that prints several tallies reports its final one, which is the only one that
  describes the run that finished.

  The `Note:` block sits *after* the failure exit, so on a red run you will never see it: a crashed suite
  shows up as `(no summary line)` instead. **Three suites that pass are invisible to the total as well.**
  `test/bug-report.test.js`, `test/palette-empty.test.js` and `test/startup-error.test.js` end with
  `40 bug-report checks passed.`, `22 palette-empty checks passed.` and `25 startup-error checks passed.`
  — a different sentence from the convention — so `tally()` reads `passed: 0` for each and flags them
  `(no summary line)` on their own lines. They exit 0, so they are not red, but their **87 assertions
  never reach the headline**, and on any run that has a failure the `Note:` block naming them is never
  printed. A headline is therefore a floor, not a count of the assertions in the tree.

  The last full reading, taken with this runner on this branch (`0c9bdaef` plus the uncommitted
  value-hints work), agrees with the table above and is the arithmetic worth checking against it:

  ```
  272 suite(s) in 274.1 s — 11191 assertions passed, 3 failed
  Failed:
    ✗ test/link-parts.test.js
    ✗ test/ma5801.test.js
  ```

  The same two suites and the same 2 + 1. The 272 counts one suite that `git ls-files test` does not:
  `test/value-hints.test.js` is untracked in this tree and runs as `24 passed`. So the tree actually
  asserted 11,191 + 87 = **11,278** assertions, 3 of them red.

  That is still not the whole floor, and `ma5801` is why. A suite that crashes has no summary line, so
  `tally()` reads `passed: 0` for it — the assertions it had already printed are not merely unreported,
  they are discarded. Measured today: `node test/ma5801.test.js` prints **ten `✓` lines and zero `✗`**,
  then throws at `:96`, so ten green assertions vanish from the headline while the suite is counted as one
  failure. The honest total is therefore **11,288** (11,191 + 87 + 10), 3 of them red; a crashed suite
  costs you its pass count as well as its verdict.

  **What a clean checkout reports, measured rather than inferred.** The same command run in a
  `git worktree add --detach` at `20c68845`, outside the repository so the canonical-URL sweep cannot
  walk it, prints `271 suite(s) in 297.2 s — 11167 assertions passed, 3 failed`, the same two suites.
  The gap is the arithmetic above seen from the other side: 11,191 − 11,167 = **24**, exactly the
  untracked value-hints suite, which is what makes it the only difference between the two trees rather
  than merely a likely one. So the headline a reader gets depends on the tree: 271 / 11,167 at `HEAD`,
  272 / 11,191 with the writer's work in place. The floor of 11,288 is reachable from neither, because it
  is a corrected total rather than a printed one.

  Taken again 29 commits later on the same branch, with the writer's value-hints work still uncommitted:
  `272 suite(s) in 324.8 s — 11191 assertions passed, 3 failed`, the same two suites, the same 2 + 1.
  Identical counts, a duration 50 seconds longer — because the duration is wall-clock on a host doing
  other things. A third run on this tree finished in **234.9 s** with the same counts and the same two red
  suites: three readings of one tree spanning **90 seconds**, which is the clearest evidence available
  that the seconds are not a property of the tests. The counts and the failing pair are the comparable
  part of a reading; the seconds belong to the machine that took it. A fourth reading, taken at `38690d6a`
with the same uncommitted work, finished in **187.3 s** — same 272 suites, same 11,191, same two red suites —
which widens the spread on one tree to **137 seconds** without moving a single count. A fifth reading, on the
same tree and still carrying the same uncommitted work, came in at **149.9 s** — 272 suites, 11,191 passed, the
same two red suites — so the spread on one tree is now **174.9 seconds**, and the low end has halved against the
slowest reading. That is the point being made, taken to its conclusion: after five readings the only part of the
line worth comparing is the counts. If you are comparing two
readings, compare the counts, the suite total and the failing pair; treat the clock as noise, because a fresh
host can halve it. Two flags re-measured in the same session as well: `--list` still
  ends `272 suite(s)`, and `--filter=bgp` still answers `7 suite(s) in 3.8 s — 334 assertions passed,
  0 failed` — and again today as `7 suite(s) in 2.8 s — 334 assertions passed, 0 failed`: the same seven
  suites and the same 334 assertions, with a second off the clock. A third reading the same day gives
  `7 suite(s) in 2.4 s — 334 assertions passed, 0 failed`, and `--list` still ends `272 suite(s)`. The same
  lesson in miniature. A sixth full reading on 2026-11-12, same tree, same uncommitted work, printed
  `272 suite(s) in 174.2 s — 11191 assertions passed, 3 failed` with the same pair red, so the counts have
  now survived six readings and the spread stays at 174.9 seconds.

  A seventh reading on the same day printed `272 suite(s) in 169.7 s — 11191 assertions passed, 3 failed`,
  same pair red, **without** `--verbose` — which corrects the attribution this paragraph used to make. An
  eighth was taken by accident (a positional path the runner dropped, in the table below): `272 suite(s) in
  159.2 s — 11191 assertions passed, 3 failed`, same pair red. Ten readings, one set of counts, a spread
  from 149.9 s to 324.8 s. A tenth, taken 2026-11-12 at `f3058fd3`, printed `272 suite(s) in 174.7 s —
  11191 assertions passed, 3 failed` — but the run before it, at the same suite total, read **11,189
  passed, 5 failed** because a fourth suite went red: `test/docs-syntax.test.js`, which checks every
  synopsis in `docs/CLI.md`'s master command table against the help rows the device prints. Two rows
  added while updating that page said more than their help rows declare (`show spanning-tree vlan <id>
  [root]`, `show ip bgp neighbors [<address>]`), so **a documentation edit turned the suite red** and the
  corrected rows turned it green again, with no test file touched. The counts did not move; the tree did. An eleventh, taken 2026-11-12 at `c748bab0` in the
  foreground, printed `272 suite(s) in 172.9 s — 11191 assertions passed, 3 failed` with the same pair red,
  so three of that day's readings agree on every count and differ only on the clock.
  Treat that as a property of this repository rather than an anecdote: the docs are inside the test
  surface, and `node test/docs-syntax.test.js` is the two-second way to check an edit to that table.
  The `stdin is not a tty` failure was not about the flag either: it was seen with the run backgrounded onto a
  file (`> log 2>&1`) and `--verbose` on — a 26-byte log holding that line and `EXIT:1`, no summary — while the
  identical command in the foreground finished all 272, and the ninth reading above came from a harness that
  backgrounded the command and piped it into `grep`, which also finished all 272 with the summary intact.
  Re-measured today, the redirect turns out not to be what did it: `node scripts/run-tests.js --filter=bgp >
  log 2>&1` writes a 639-byte log ending `7 suite(s) — 334 assertions passed, 0 failed`, the same
  command backgrounded writes the same 639 bytes, and with `--verbose` it writes 8,892 bytes containing not one
  `stdin is not a tty`. So neither the file nor the background is the cause; whatever supervised that job was, and
  it is not in this tree — `grep -rn 'stdin is not a tty' --include='*.js' .` finds nothing outside the docs that
  quote it. Two rules survive: read the counts off the **end** of the output rather than the start, and never pipe
  the runner into `head` — it closes the pipe long before the summary line exists, so the run looks like it
  produced nothing.

  Useful flags, all from the header of the script:
  `--filter=bgp`, `--bail`, `--verbose`, `--list`.

  **The runner ignores flags it does not know, and that is the expensive kind of silence.** Measured
  here, each command run as written:

  | command | what happens |
  |---|---|
  | `node scripts/run-tests.js --list` | lists the suites; the last line reads `272 suite(s)` |
  | `node scripts/run-tests.js --filter=bgp` | `7 suite(s)`, then `OK — every suite passed.` |
  | `node scripts/run-tests.js --nosuchflag --list` | still lists, silently — the unknown flag is dropped |
  | `node scripts/run-tests.js --filet=bgp --list` | still lists: a **mistyped `--filter`** is dropped too |
  | `node scripts/run-tests.js --filter` (no value) | no error; the filter is empty, so the **whole** suite runs |
  | `node scripts/run-tests.js --filter bgp` (space, not `=`) | the same: re-measured today it was still running past **180 s** when a filtered run takes about four, so the space form is the bare form with a stray argument |
  | `node scripts/run-tests.js test/link-parts.test.js` | also the **whole** suite: `argv` reads only `--filter=`, so a bare path is dropped like an unknown flag. Measured today it finished all **272 suite(s) in 159.2 s**, where `--filter=link-parts` answers in seconds |

  So a typo does not fail loudly: it quietly turns a filtered run into the full one — and a bare
  `--filter` does the same. If a supposedly filtered run keeps going for minutes instead of finishing
  the handful of suites you asked for, suspect the spelling before you suspect the machine.

  So quote the runner rather than this paragraph: `node scripts/run-tests.js` prints the reading and
  `ls test/*.test.js | wc -l` prints the size. If the two disagree with the sentence you are reading,
  the sentence is what changed.

  Both closed the way this page predicted, and it is worth recording *which* way, because only one of
  them was the fix the bullet originally recommended:

  - `test/spec-vs-description.test.js` — the four Ubiquiti specs still carry `"poeOut": true` on `eth0`,
    and the fix was on the **prose side**: commit `c8b39db1` added the missing port to their
    descriptions. Three read *"(1x PoE++ passthrough)"* — `ua-g2-sk-pro`, `ua-hub-door-mini`,
    `ua-hub-gate` — and the fourth, `uisp-fiber-xg`, reads *"(1x PoE passthrough)"*, so a grep for the
    `++` spelling finds three of the four and not a discrepancy. The rule the test enforces is unchanged
    — a device described as PoE-powered must not source power — and a real passthrough is still tracked
    by name in its allowance list rather than by muting the rule.
  - `test/canonical-urls.test.js` — **not** an exemption, and this bullet used to say it was.
    `EXEMPT_FILES` is `new Set(['CHANGELOG.md'])`, one entry, and a test asserts exactly that; the other
    reasoned exceptions live in `canonical.ALLOW`, five of them (`docs/MIRRORING.md`,
    `test/canonical-urls.test.js`, `docs/PUBLIC-ACCESS.md`, `scripts/gh-bridge.js`, `CONTRIBUTING.md`),
    each with its reason. `DO-NOT-USE.md` is in neither list and does not need to be: it has never
    contained the old URL — not in the version committed in `8e7b843d`, not in the rewrite `c8b39db1`
    gave it — so nothing was ever skipped on its behalf. What that commit did was make the notice send
    readers to the mirror, which is the fix the guard wanted in the first place.

- **A red suite can exist in a working copy without existing in the repository — and it can go green while
  you watch.** While `test/block-stray-words.test.js` was being written it was **untracked**
  (`git ls-files` returned nothing for it), so CI, which checks out `HEAD`, never ran it. It reported
  `15 passed, 4 failed` at one point and `19 passed, 0 failed` twenty minutes later: it was being written
  alongside an uncommitted change to `engine/cli.js`, and the pair converged. Neither number belonged in
  this page, and both were true.

  It is tracked now — `git ls-files test/block-stray-words.test.js` returns the path, committed in
  `ae6e55af` — and it is **green on `HEAD`** (19 passed, 0 failed, sweeping 182 argument-less rows across
  seven blocks). So this paragraph has already gone stale once in the direction that matters: an untracked
  file became a tracked one, and the sentence "CI never runs it" stopped being true without changing a word
  of it. Check `git ls-files` before repeating either half.

  The measurement that *does* belong here is the full run, split by where the failure comes from:

  ```text
  234 suite(s) in 314.5 s — 10064 assertions passed, 15 failed
  Failed: link-parts, ma5801, poe-admin, port-security, ps-aging,
          skip-audit, switchport-args, undo-completeness
  ```

  `link-parts` and `ma5801` fail on `HEAD` as well — they are property of the tree. The other six fail only in a
  working copy carrying that uncommitted `engine/cli.js` change; run the same six against a pristine `HEAD` and
  they pass (34/0, 99/0, 53/0, 15/0, 42/0, 30/0). To separate the two without touching the working copy:

  ```bash
  d=$(mktemp -d) && git archive HEAD | tar -x -C "$d" && cd "$d" \
    && node test/poe-admin.test.js       # 34 passed, 0 failed - HEAD is clean, so the failure was the change
  ```

  The two failures that are actually the tree's:

  - `test/link-parts.test.js` — **the UI carries every catalogue part (34 of 58)**, and the two assertions that fail
    name what is missing. All **24** of them, and not all of them are the 400G modules the name of the suite
    suggests: **19 are QSFP** (3 QSFP-DD: `-400G-SR8`, `-DR4`, `-FR4`; 2 QSFP56: `-200G-SR4`, `-FR4`; 10 QSFP28:
    `-100G-SR4`, `-BIDI`, `-eBIDI`, `-CWDM4`, `-CWDM4-Lite`, `-DR`, `-FR1`, `-LR4`, `-ER4`, `-ZR4`; 4 QSFP-40G:
    `iSR4`, `eSR4`, `LX4-MM`, `LR4-Lite`) and **5 are SFP** — `SFP-25G-SR`, `SFP-25G-SR-E`, `SFP-10G-SR1`,
    `SFP-10G-SR-E`, `SFP-10G-iLR`. The SFP half is the surprising part: these are the 10G and 25G optics a reader
    would assume were covered first, and the page used to call the whole gap "the rest of the QSFP family".
    the table behind that is `PART_ROWS` in `web/app.js` — a pipe-delimited list of
    `part|form|media|speed|reach|polish|nm` rows — and nothing regenerates it, so a part added to
    `catalogue/optics/transceivers.json` does not reach the UI until somebody edits that array by hand.
    (These notes used to blame `web/link-parts.js`. That file is **not in the tree**; the table lives in
    `app.js` now, which is why grepping the old name finds nothing.)

    **Count it the way the suite does, not with a regex.** The obvious `PART_ROWS = [...]` match returns
    **25** rows because the array carries comment lines whose prose contains quoted strings; the assertion
    counts the parsed table, which is exposed at runtime as `pf.opticParts`. Boot `app.js` in a `vm`
    context (that is what the suite's `boot()` helper is for) and read it. Save the snippet below as
    `scratch/optic-rows.js` and run `node scratch/optic-rows.js` from the repository root — note the shape it
    reads: `catalogue/optics/transceivers.json` is a bare JSON **array** of 58 parts, not an
    object with a `parts` key, so `.parts.map(…)` is `undefined` and throws.

    ```js
const fs = require("fs"), vm = require("vm");
const APP = fs.readFileSync("web/app.js", "utf8");
const noop = () => {};
const el = { style: {}, classList: { add: noop, remove: noop }, appendChild: noop,
  addEventListener: noop, setAttribute: noop, querySelector: () => null, querySelectorAll: () => [], getContext: () => null };
const document = { createElement: () => Object.assign({}, el), createElementNS: () => Object.assign({}, el),
  getElementById: () => Object.assign({}, el), querySelector: () => Object.assign({}, el), querySelectorAll: () => [],
  addEventListener: noop, body: Object.assign({}, el) };
const ctx = { console, setTimeout, clearTimeout, setInterval, JSON, Promise, Object, Array, Number, String, Math, Date, Set,
  isFinite, parseFloat, localStorage: { getItem: () => null, setItem: noop }, location: { protocol: "http:", host: "x" },
  fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }), document, window: {}, PFCanvas: { on: {} } };
ctx.window.PFCanvas = ctx.PFCanvas; ctx.globalThis = ctx;
vm.createContext(ctx); vm.runInContext(APP, ctx, { filename: "app.js" });
const rows = ctx.window.__pf.opticParts;
const cat = JSON.parse(fs.readFileSync("catalogue/optics/transceivers.json", "utf8")).map((p) => p.partNumber);
console.log(rows.length, "rows of", cat.length, "parts | all in catalogue:",
  rows.every((r) => cat.includes(r.partNumber)), "| distinct:", new Set(rows.map((r) => r.partNumber)).size);
    ```

    Measured on 2026-11-12: `34 rows of 58 parts | all in catalogue: true | distinct: 34` — so the "34 of 58"
    in the assertion is exactly what it says, 34 distinct real parts against 58, and the gap is 24 parts rather
    than a table padded with rows for parts the catalogue does not contain.

  - `test/ma5801.test.js` — **crashes rather than failing**: `TypeError: Cannot read properties of undefined
    (reading 'hardware')` at line 96, because the suite asks for `gpon1/1` and the GP16's PON ports are now named
    `pon1` … `pon16` — the spec has **20** interfaces in total, the last four being `uplink1` … `uplink4`, so the
    port names stop at 16 while the interface count reads 20 (`new Topology().addDevice(spec).interfaces.has('gpon1/1')`
    is false). A rename in the catalogue left the test addressing the old names.

  Both are tests-vs-catalogue drift, which is the failure mode this project's own suite is worst at catching,
  because the test *is* the thing that is wrong.

  One more difference between the two views, worth knowing before you land a `cli.js` change. `docs-syntax`
  checks every command `CLI.md` documents against the help page, so a row that is split, renamed or merged
  has to change in both places in one commit. That is what happened to `no ipv6 route`: the combined
  `ipv6 route <prefix>/<len> <next-hop> | ipv6 gateway <addr>` row became three rows with the placeholder
  written `<prefix/len>`, and the behaviour behind it was fixed at the same time — on the old code
  `no ipv6 route 2001:db8:9::/64` answered `IPv6 routes cleared` and took **both** statics with it, where it
  now answers `IPv6 route to 2001:db8:9::/64 removed` and leaves the other static alone.

  Keep the sense of what that check enforces: it compares **tokens**, so a page and a help row have to be
  spelled identically — `<prefix>/<len>` in one and `<prefix/len>` in the other is a failure even when the
  handler accepts the typed line either way, which it did (`ipv6 route 2001:db8:9::/64 2001:db8:1::9` was
  accepted on the old code and printed `IPv6 route 2001:db8:9::/64 via 2001:db8:1::9`). A red `docs-syntax`
  says the two texts disagree, not that the feature is broken.

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

  **It has drifted again, and this time the drift is the count corrections.** Re-measured the same
  way on a later tree: three of the six pages differ from the live wiki, and all three differ because
  a fact inside them moved — (that reading is history now; see the fresh measurement below the table)

  | Page | Live wiki still says | `docs/wiki/` now says |
  |---|---|---|
  | `Home.md` | 1,584 models from 245 vendors | 1,661 from 247 |
  | `Requesting-Hardware.md` | 1,234 `sourceUrl`, 22 `source`, 1,256 pointing at a datasheet | 1,313 / 20 / 1,333 |
  | `Simulation-Fidelity.md` | L2 stops at LLDP, L3 at longest-prefix match | adds voice VLAN, port security with violation modes and aging, IPv6 first-hop |

  `_Sidebar.md`, `Contributing.md` and `Getting-Started.md` are still identical. The lesson is that a
  wiki page holding a number goes stale **by being right**: nothing about publishing changed, the
  catalogue did. And the reason it sits there is the next paragraph — a publish from a machine with no
  tty hangs on `could not read Username`, so the fix is a manual run, not something to leave to habit.

  **Re-measured today: the wiki is one page behind, and the two rows above are published.** Cloning
  `https://git.jayw.uk/jaylouisw/packetforge.wiki.git` anonymously (it is public; the credentials are
  needed for the *push*, not the clone) and comparing with `\r\n` stripped gives **five of six pages
  byte-identical**; the wiki repo's head is `e1c3304`, published `2026-11-11T05:55:04+00:00`. The single
  stale page is `Requesting-Hardware.md` — the live copy is 2,775 bytes against 4,157 in `docs/wiki/`,
  because that page now names the audit's **twelfth** rule and explains the template-collision case.
  So the drift has changed character: it used to be the catalogue moving under prose, and this time it
  is documentation correcting documentation. `Home.md` and `Simulation-Fidelity.md` went from stale to
  live in between, which is the honest reading of a hand-published wiki — the table above is a
  snapshot, and the only measurement that counts is the clone-and-diff you run yourself.

  **`--dry-run` reporting every page as "updated" is not staleness — it is line endings.**
  `publish-wiki.js` compares the clone's files to `docs/wiki/` as raw strings, and on a Windows host
  with `core.autocrlf=true` the two sides are not the same bytes even when they are the same text.
  Measured again on today's tree, where five of six pages are content-identical:

  ```
  $ PF_WIKI_REPO=https://git.jayw.uk/jaylouisw/packetforge.wiki.git \
      node scripts/publish-wiki.js --dry-run
  Would publish:
    updated Contributing.md
    updated Getting-Started.md
    updated Home.md
    updated Requesting-Hardware.md
    updated Simulation-Fidelity.md
    updated _Sidebar.md
  Dry run - nothing written or pushed.
  ```

  Six of six "updated" — so on that host `--dry-run` answered "is this host producing CRLF?", not "which
  page is behind?". (An earlier reading of this page said "six of six against one genuinely stale page".
  Re-measured on 2026-11-12, **four** of the six were behind by hundreds of characters — see the method
  below — so treat the six-of-six line as saying nothing at all about content.)

  **The build itself is the cheapest guard, and it is deterministic.** `node scripts/build-wiki.js` rewrites all
  six pages from the inline templates and prints `wrote 6 wiki pages to docs/wiki/`; run it on a tree where the
  pages already match their templates and `git status docs/wiki` stays **clean**. If it produces a diff, somebody
  edited a page instead of the template — and since the build always overwrites, that edit is already gone. Measured
  on 2026-11-12: exit `0`, six pages, no changes. The wiki pages' own commands were swept the same day as the docs'
  (four fences, three runnable): `node test/hardware-invariants.test.js` answers **25 passed, 0 failed** and the
  catalogue one-liner on `Requesting-Hardware` prints `1661 specs, 1313 sourceUrl, 20 source, 328 neither` —
  character for character what the page says it prints. Its fourth fence is a `git clone` of the repository, which
  needs nothing said about it.

  **The only reliable answer is to fetch the pages and compare.** The wiki API serves them anonymously,
  and two details cost a measurement each: page **titles contain spaces** (`Getting Started`,
  `Requesting Hardware`, `Simulation Fidelity`) while the files are hyphenated, and the body arrives in
  `content_base64` — `content` is present and **empty** for every page:

  ```bash
  node -e 'const a=require("./scripts/forgejo-api");(async()=>{
    const {API,OWNER,NAME}=a;
    const list=await (await fetch(API+"/repos/"+OWNER+"/"+NAME+"/wiki/pages")).json();
    for (const p of list) {
      const j=await (await fetch(API+"/repos/"+OWNER+"/"+NAME+"/wiki/page/"+encodeURIComponent(p.title))).json();
      const live=Buffer.from(j.content_base64,"base64").toString("utf8").replace(/\r\n/g,"\n");
      const local=require("fs").readFileSync("docs/wiki/"+p.title.replace(/ /g,"-")+".md","utf8").replace(/\r\n/g,"\n");
      console.log((live.trimEnd()===local.trimEnd()?"SAME ":"DIFF ")+p.title, live.length, local.length);
    }})()'
  ```

  Measured that way on 2026-11-12, four of six pages were genuinely behind and two were line endings only:

  ```
  DIFF Contributing          live 1592 local 2374
  SAME Getting Started       live 1846 local 1846
  DIFF Home                  live 1886 local 2434
  DIFF Requesting Hardware   live 2775 local 4467
  DIFF Simulation Fidelity   live 2956 local 3826
  SAME _Sidebar              live  357 local  357
  ```

  Note what that does to the count heuristic: the dry-run had just printed six lines, and the truth was
  four stale pages. Publishing needs a token (see the `TRIAGE.md` note — the scripts gate on a variable,
  not on what the endpoint allows), so on a host without one the wiki drifts and only this comparison says
  by how much.

  **The count heuristic, kept for what it is worth:** Re-run on 2026-11-12 it printed
  **two** lines — `Requesting-Hardware.md` and `Simulation-Fidelity.md` — and those were exactly the two pages
  edited since the live wiki's last publish (`e1c3304`, `2026-11-11T05:55:04+00:00`): one for the
  `grep -rl` overcount sentence, one for the instant/`converged` paragraphs. So the rule is not "never trust
  it", it is: **six of six means line endings, a subset means staleness.** Six is the CRLF artefact because it
  is every file; any smaller list is a comparison that actually compared. Read the list and ignore the exit
  code, which is `0` in both cases. It also exits `0` and takes under a second
  (anonymous clone, no push), which is why the failure people actually hit is at the push step.

  **The half that is easy to miss is that this repository is the side that is pinned.**
  `.gitattributes` here declares `* text=auto` and `*.md text eol=lf`, so `docs/wiki/*.md` sits in the
  worktree as LF — measured on `Home.md`: **34 LF, 0 CRLF**. The wiki repository has no `.gitattributes`
  at all (`git -C <clone> ls-files .gitattributes` prints nothing), so the identical bytes check out
  there as CRLF: cloned from a bare repo seeded with this repository's own copy, the same file reads
  **34 CRLF, 0 LF**, and git warns `LF will be replaced by CRLF the next time Git touches it`. Two
  repositories, two attribute regimes, one string compare that can never succeed. So "turn autocrlf
  off" is the wrong repair — that would rewrite this entire checkout. The three repairs that work:
  normalise line endings before comparing, run the check on Linux (where CI runs), or give the wiki
  repository the same `.gitattributes`.

  **"Already in sync" now has an answer, and on a CRLF host it cannot be reached.** The script grew an
  explicit branch for it — `if (!changed.length && !removed.length)` prints `Wiki is already up to date
  (N pages).` and exits **0** — but the comparison feeding that branch is a raw string compare of the
  clone's file against `docs/wiki/`, so with `core.autocrlf=true` every page always differs and the
  branch never fires. Re-measured against a **local bare repo seeded from `docs/wiki/` itself**
  (`git init --bare`, copy the six files in, push, `PF_WIKI_REPO=file:///…`) — the same bytes, so a
  correct compare would find nothing to do: all six pages still reported `updated`, and the run then
  died on `Error: Command failed: git -c user.name=… commit --quiet -m Publish wiki from docs/wiki`
  with a raw `child_process` stack trace, because `git add` normalised the LF copy straight back into
  the CRLF checkout and found nothing staged. So a stack trace naming `git … commit` still means
  **nothing to publish**, not a broken credential; a genuine auth failure names `git clone` or
  `git push` instead. Read the command in the error before chasing the wrong problem.

  **Which runs leak their temp clone is not which runs fail.** The script builds in
  `%TEMP%\packetforge-wiki-<pid>` and now removes it in a `finally`, so a run that **throws** — the
  commit crash above — cleans up after itself (measured: no new directory). What it cannot clean up is
  a run that leaves through `process.exit(0)` inside the `try`, because that ends the process without
  unwinding: **`--dry-run` leaks one every time.** Measured: `packetforge-wiki-7716` left behind with a
  full clone inside it (`.git` plus the six pages), while the crashing run left nothing. Eight such
  directories were already sitting in `%TEMP%` before this measurement started — that count is the
  honest answer to "how often does the dry run leak", and the fix is to delete them by hand:
  `ls -d $TEMP/packetforge-wiki-*`.

  **The default HTTPS clone URL cannot authenticate in a non-interactive run.** The first real
  publish attempt died with `could not read Username for 'https://git.jayw.uk'` (no tty to prompt on);
  `PF_WIKI_REPO=ssh://forgejo/jaylouisw/packetforge.wiki.git node scripts/publish-wiki.js` works,
  because the wiki repository exists and SSH keys are configured. That also settles an older claim in
  `CONTRIBUTING.md`: the wiki repository is created ahead of time here, not lazily by the first web-UI
  save.
- **Nothing checks that a `#anchor` inside a link resolves.** There are **81 in-page `#fragment`
  links** across `docs/` and the README (69 of them in `docs/CLI.md` alone, one per command family),
  plus **10 cross-file `file.md#fragment` links** — `README.md` carries 5 of those and every one of
  them names a page and a heading that must both still exist. Two were broken the first time anyone
  counted:
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
  the directory and prints **11** misses on this tree, over **six distinct names**. All eleven are
  legitimate, and the count read ten over five names for most of this page's life — the eleventh is
  `help-completeness`, an upstream suite this tree does not carry, which only entered the sweep when the
  merge paragraph below named it with its prefix:

  | Where | Count | Why it is legitimate |
  |---|---|---|
  | `docs/BGP-POLICY.md` | 2 | `bgp-policy.test.js`, `bgp-policy-wire.test.js` — the page is a **design**, and these are the suites it proposes ("New file:") |
  | `docs/UPSTREAM-DESIGN.md` | 2 | `upstream-baseline.test.js`, `upstream-service.test.js` — phase-0 and phase-2 gates, not yet written |
  | `docs/SIMULATION.md` | 5 | the iteration log **narrating** those same names: the §11 rows that record how the ghost-citation problem was found, and ones recording passes that "fixed" it — plus `poe-derived.test.js`, the file nobody ever wrote |
  | `docs/CI.md` | 2 | this page narrating the `poe-derived.test.js` incident — the page that explains the count is itself part of it — plus one mention of `help-completeness.test.js`, which is a suite on the upstream `main` and not in this tree (see the merge paragraph below) |

  **The rule the checker actually applies: one line per distinct missing name per file, and only when the
  name is written with the directory prefix in front of it.** That second half is why the table above is
  not a list of citations: it writes every name bare, and the regex wants the prefix. This page contributes
  **2**, and both are prefixed in prose — `test/poe-derived.test.js` in the paragraph on the two checks
  disagreeing above, and `test/help-completeness.test.js` in the merge paragraph below. So the arithmetic is
  2 + 2 + 5 + 2 = **11**, and the sixth name is `help-completeness`: not one of the five this table lists,
  because it is a suite that exists upstream rather than a proposal. Count bare filenames too and the same
  four pages carry **14** file-name pairs across **19** lines — a bigger number under the same facts, which
  is why the paragraph below says the two checks disagree rather than that one of them is wrong. Recount
  rather than trust these figures: they move whenever a §11 row is rewritten, and this one has read 15
  before it read 10, with the same names throughout that history.

  Five of the six have never existed: `git log --all --format=%h -- test/<name>` returns nothing for
  `bgp-policy`, `bgp-policy-wire`, `poe-derived`, `upstream-baseline` and `upstream-service`, and the
  sixth, `help-completeness`, is a file on upstream `main` this branch does not carry. That is the
  distinction worth keeping — a citation of a suite that was **renamed** is a broken link to fix, while a
  citation of a suite that was **proposed** is a promise, and only the design pages are allowed to make one.

  ```bash
  node md-check.js docs/*.md README.md CONTRIBUTING.md CHANGELOG.md docs/wiki/*.md | grep 'cites test/'
  ```

  Do not clear this by inventing a file to match a citation. That has already happened once:
  a pass needing to make the count go away cited a suite (`poe-derived.test.js`) with an assertion
  count beside it, and **no such file has ever existed in `git log --all`** — the citation
  survived because nothing compares prose to a run, and it is now recorded in
  `docs/SIMULATION.md` §11 as a defect rather than deleted quietly. If a real suite is
  renamed, rename the citation; if a page is proposing a suite, leave the name alone.

- **A symbol beside a line number answers a different question from a line that exists.** The
  mechanical sweep checks that `engine/foo.js:123` is inside the file; it cannot check that the
  sentence's *symbol* is what sits there. Pairing the two — a backticked name within a few characters
  of a backticked `file.js:NNN` — gives **174 pairs** across `docs/`, `README.md`, `CONTRIBUTING.md` and
  `CHANGELOG.md`. Of those, 42 fail a ±2-line window and 22 still fail at ±30, and every one of the 22
  is explained by one of three causes rather than by a defect:

  | Cause | Example | Why the pairing misses |
  |---|---|---|
  | a **call site**, cited deliberately | `buildSchedule()` at `engine/convergence.js:182` | 182 is the call to `vrrpTimers()`; `buildSchedule` is defined at `:147`, 35 lines above the window |
  | the sentence quotes a **wrong citation as the defect** | `E_NO_COMMON_SPEED` at `media.js:709` | that is one of the §11 rows recording the old error; the emit is at `:1338`, so the page is right and the citation is *evidence* |
  | the sentence names **two symbols** and the regex picked the wrong one | `eui64FromMac` beside `device.js:642` | the function lives in `engine/ipv6.js:384`; the line belongs to the other half of the sentence |

  That is why this is a triage recipe rather than a gate, and it is the same wall the pairing heuristic
  hit when it was tried as a check: a program would have to know which of the three a sentence means.
  What it is good for is finding the citations that point at **plausible but wrong** code — the
  `show ip route` anchor that named `_routeFiltered()` instead of the plain table was found this way,
  and no existence check would have flagged it, because the line exists and prints the same columns.

## Reporting a problem with CI itself

Open an issue with the workflow run URL, and include:

```bash
# what the queue looks like from the inside, if you have access
docker logs --tail 50 forgejo-runner
```

The web UI is not enough on its own: a run that never started looks identical to a
run that is waiting its turn, and only the difference tells you which bug you have.
