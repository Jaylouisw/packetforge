# Plan: `research/incoming` holds 185 files and none of them is incoming

Status: forward plan, no code. Closes **no** open issue — nothing in the tracker describes this
defect, and #1507 (the 46 GB forge volume) shares only the general theme of bytes that no longer
earn their place. Improves tooling that already exists; the only step that creates a new obligation
rather than repairing an inconsistency is step 7, which is marked. Touches `scripts/import-devices.js`
(one constant), `scripts/apply-research.js`, `scripts/classify-change.js:30`, one new
`scripts/research-inventory.js`, one new checker, two suites, `docs/RESEARCH.md`,
`docs/MAINTAINING.md:54-56`, `docs/REQUESTING-HARDWARE.md:86-118`. No `devices/` content changes, and
no engine or workflow file changes.

Measured on `33d8ef97`, 2026-11-17.

## What exists today

`research/` is 213 tracked files. 185 of them sit in `research/incoming/` — 1.9 MB, 178 of them
JSON in **30 distinct top-level shapes**: 137 files are lists of whole device specs, 27 wrap the
list under a `devices` key, 11 carry the two-table `{poe: [], ports: []}` shape that
`scripts/apply-research.js:4-11` documents as its input, and 3 are neither.

Nothing in that directory is pending. Every model it names is already in `devices/`: the importer's
own dry run prints `Would add: 0  duplicates: 1185  rejected: 2  refused duplicate spellings: 2`,
and `--all` prints `duplicates: 1509  rejected: 105`. The two rejections are the punctuation rule
working as designed — `peplink/MAX-BR1-PRO-5G` against `devices/peplink/max-br1-pro-5g.json`
("MAX BR1 Pro 5G"), `zte/F8648P` against `devices/zte/zxhn-f8648p.json` — and the 105 `--all`
rejections are PoE budget tables and optics catalogues being read as if they were devices.

The single discriminator between "spec batch" and "research artefact" is a **filename regex**:
`scripts/import-devices.js:274-280` reads only `devices-*.json` by default and everything else only
under `--all`, because "research/incoming also holds research artefacts … reading them as such
buries the real rejections in noise". The two identity maps a few lines below (`:326-333`, exact and
normalised) exist precisely because spelling is not identity — the directory has no such notion.
`docs/REQUESTING-HARDWARE.md:111` sends contributors to this directory ("Write specs to
`research/incoming/devices-*.json`"), and `:88` sends `missing-devices.js --stubs` there too.

The tools that consume the directory disagree about what it is:

* `scripts/apply-research.js` takes a path argument (`:66-71`), refuses to write anything that does
  not validate, and writes straight into the matched spec (`:115`, `:211`, `:218`). It has no way to
  say "this fact is already in the spec", so a re-run cannot report progress. It also has no
  `PF_INCOMING` variable — `test/apply-research.test.js:14` says both fixtures come from
  `PF_DEVICES`/`PF_INCOMING` and `:65` sets both, but a grep for `PF_INCOMING` in the applier returns
  nothing; the test's fixture directory is decorative.
* `scripts/merge-research.js` is 459 lines of hardcoded device objects (`:9`) under a header that
  calls itself a "One-shot merge of swarm-researched homelab gear" (`:2`), and `:451-456` writes
  any device it cannot already find into `devices/<vendor>/<slug>.json` **with no validation at
  all**; the rest are skipped by filename. Nothing references it; its
  output is already in the catalogue. It is a loaded gun in the scripts directory.
* `docs/MAINTAINING.md:54-56` states the rule that working files do not belong in the repository —
  `research/pdf/` and `research/_*.json` are gitignored (`.gitignore:26-27`) for exactly that reason
  — while 1.9 MB of consumed working files are committed beside them.
* `docs/ARCHITECTURE.md:623` and `:1089` cite `research/*.md` as the source of truth for a
  behaviour. Those notes are provenance and must stay; the directory mixes them with staging.

## What is missing or weak, ranked

1. **A filename is the only type system.** 324 of the 1600 models live in files the default run
   never opens, and `--all` converts 105 artefacts into rejections. Either way the directory has to
   be read with the wrong tool.
2. **Nothing answers "what here is not yet modelled?"** Dedupe is per-spec inside one run; the
   directory as a whole has no state. A genuinely new batch arrives as 1,185 duplicate lines, so
   the one file worth reading is the one file nobody can see.
3. **`apply-research` has no completion state and no fixture isolation** (§above): facts are applied
   by rewriting the spec, and the only record that it happened is the research file itself, which
   nothing then retires.
4. **`merge-research.js` writes unvalidated specs** and is still executable. Its 459 lines have zero
   callers and zero tests.
5. **The stated policy and the tree disagree** — `MAINTAINING.md:54-56` says working files are
   ignored; `research/incoming` is the largest committed directory under `research/`.

## Ordered steps

Each is one PR by one worker, smallest first, no step depends on a later one.

1. **S — `docs/RESEARCH.md`: name the three classes.** Notes (cited, permanent), applied evidence
   (kept, one file per batch, already in `devices/`), and inbox (empty by default; what is in it is
   what is not modelled yet). Link it from `MAINTAINING.md:54-56` and `REQUESTING-HARDWARE.md:111`
   and correct that line's claim that a committed batch *is* the inbox. Docs only; no test.
2. **S — `scripts/research-inventory.js`.** Walk `research/`, classify each JSON by shape (spec
   list / `devices` key / `apply-research` tables / other), normalise every declared model with the
   same punctuation-insensitive key `import-devices.js:326-333` already uses, and report the models
   absent from `devices/`. `--json`, never writes. One suite with a fixture tree, following the
   `PF_DEVICES` pattern at `apply-research.js:19`. This is the answer the second ranked gap is
   missing, and it is useful before any file moves.
3. **M — move, do not delete.** `git mv` every file the inventory calls applied out of
   `research/incoming/` and into `research/applied/`, leaving the inbox with a `.gitkeep` and
   whatever step 2 reports as genuinely unmodelled. Pure renames, no content edits. Two
   consequences to handle in the same PR: `scripts/classify-change.js:30` matches
   `^research/incoming/[^/]+\.json$` (and `:31` the flat `research/*.json`), so the new path must be
   added or those PRs get classified as code and run the full five-job matrix; and the `docs/*` links
   that point into `incoming/` (`docs/UPSTREAM-DESIGN.md:15` is one) must be repointed.
4. **S — delete `scripts/merge-research.js`.** No caller, no test, its output is in the catalogue,
   and `:451-456` writes unvalidated JSON. Record it in `docs/RESEARCH.md` as a one-shot that ran
   once, so the deletion is not a mystery in `git log`.
5. **S — `apply-research`: make the fixture real and the re-run honest.** Either honour
   `PF_INCOMING` in the applier or fix `test/apply-research.test.js:14`, and add `--verify`: for each
   entry, report whether the spec already carries that value, without writing. A fact file can then
   be re-run to decide whether it can be retired, instead of being applied twice or forgotten.
   Suite extends the existing one; no new fixture needed.
6. **M — `scripts/check-research-inbox.js`, wired into `npm test`.** Refuse (a) a JSON in
   `research/incoming/` that matches none of the documented shapes, (b) a model already present in
   `devices/`, and (c) a filename that does not match the shape it claims. Once (b) is enforced the
   directory stays empty by construction. The suite must assert the checker's own exit codes on a
   fixture tree, and that it writes nothing.
7. **S — needs Jay's approval: graduation.** Make "the PR that applies a batch also moves its file to
   `research/applied/`" a stated rule and, if Jay wants it enforced by tooling rather than by review,
   have the checker from step 6 fail a PR that touches `devices/` without retiring the evidence file.
   This is the only step that creates a review obligation; everything above repairs an inconsistency.

## Risks

* **A rename PR is a merge-conflict magnet** while device PRs are in flight: every batch in
  `research/incoming/` is touched by name. Land step 3 in a quiet window, or do it per-vendor in
  several PRs if the queue is busy — the plan does not require one big move.
* **Deleting evidence**: prefer `research/applied/` (step 3) over deletion. The 11 fact tables and
  the 105 `--all` rejections are the only record of what a datasheet said, and some are cited from
  docs. Only `merge-research.js` (step 4) is genuinely dead.
* **Classification regressions are silent**: `classify-change.js:30` treats a JSON at the shallow
  path as data-only. A file one directory deeper becomes code and runs the whole matrix — slower,
  never wrong, but easy to misread as a CI problem. Test the classifier in step 3.
* **`npm test` grows a fifth script**; the suite is already the slowest thing CI does
  (`run-tests.js:24-31`), so step 6's checker must run in milliseconds over JSON only, not re-parse
  `devices/` per file.
* **Fixture drift**: `test/missing-devices.test.js:117` asserts the report-only run creates nothing
  under `research/incoming`. Moving that directory must keep the assertion meaningful — assert on
  the constant, not the literal string.

## Test strategy

Steps 2, 5 and 6 each extend one suite; step 3 is proven by `node scripts/import-devices.js` printing
the same `Would add: 0` line before and after the move (a report comparison is the cheapest
regression test for a rename), plus `node scripts/classify-change.js --base <sha> --head HEAD` on the
move commit. Step 7, if built, needs one negative fixture: a PR that adds a spec without retiring its
evidence.

## Deliberately left out

* Any change to the importer's identity logic (`:326-333`) or its validators — `capability-vocabulary.md`
  owns the token vocabulary and `request-queue-duplicates.md` owns the request-queue comparator; this
  plan only *uses* the normalised key.
* The `research/pdf/` cache and `research/_*.json` (already ignored, `.gitignore:26-27`).
* Rewriting history to shrink the 1.9 MB. It is 1.9 MB; the cost of a rewrite exceeds the win, and
  #1507's 46 GB is a different cause.
* Any new product surface, any engine behaviour, and any device spec content.
