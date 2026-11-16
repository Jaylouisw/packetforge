# Plan: a citation is a claim, and the checker cannot see the pages that make the most of them

Status: forward plan, no code. Scope: `scripts/check-doc-citations.js`, one new suite under `test/`,
`.forgejo/workflows/ci.yml`, `docs/MAINTAINING.md`, `CONTRIBUTING.md`, and the citations in
`docs/plans/*.md`. Nothing here changes the engine's behaviour.

## What exists today

`scripts/check-doc-citations.js` is a real, deliberately narrow diagnostic:

* `REF` (line 34) matches `file.js:1234` / `file.js:1234-1250`; `CALL` (35) matches a backticked
  `symbol()`; `DRIFT = 40` (32).
* `judgeLine()` (87) judges a **line** only when it carries exactly one citation and exactly one
  backticked call longer than three characters that is not in `GENERIC` (37), and that symbol has
  exactly one definition in the cited file (`definitionLine()`). Everything else is skipped and
  counted.
* `run()` (106) returns `{references, checked, skipped, drift}`; the CLI prints them (130) and exits
  1 only with `--strict` (141).
* `documentationFiles()` (77) is `docs/*.md` — top level only — plus `README.md` and
  `docs/MAINTAINING.md`. `run()` already accepts `opts.files`, so the walk is a one-line change.

Measured on `b949ef3c`, 2026-11-16:

```
Citations in docs: 350 — 15 judged against a unique definition, 266 lines left to a reader
Suspects (7, allowed drift 40 lines):
  docs/BGP-POLICY.md:76      cli.js:4305 is 513 lines from _help() at 4818
  docs/BGP-POLICY.md:819     cli.js:4305 is 513 lines from _help() at 4818
  docs/BGP-POLICY.md:1090    test/bgp.test.js:452 is 403 lines from mkPath() at 49
  docs/SIMULATION.md:558     simulator.js:3709 is 117 lines from openFlow() at 3826
  docs/UPSTREAM-DESIGN.md:71 simulator.js:2908 is 68 lines from _deliver() at 2976
  docs/UPSTREAM-DESIGN.md:442 link.js:56 is 56 lines from serialize() at 112
  docs/UPSTREAM-DESIGN.md:821 topology.js:592 is 95 lines from setLinkLength() at 687
```

It is wired to nothing: `check:citations` exists only at `package.json:53`; `.forgejo/workflows/ci.yml`
runs control-bytes, node-surface, canonical-urls, ci-disk-hygiene, syntax and the suite but not this;
and `scripts/premerge-check.js` runs two device suites (`SUITES`, line 24). No test mentions
`judgeLine` or the script at all, so the rules that decide what is judged are themselves untested.

The pages that cite hardest are outside the scan. `docs/plans/*.md` holds **62 citations and none of
them is read**. Forced through the same code (`run({files: docs/plans/*})`): 62 references, **1
judged, 53 lines skipped, 1 suspect** — `docs/plans/capability-vocabulary.md:25` cites
`engine/cli.js:288-292` for `_capabilityRefusal()`, which is defined at `engine/cli.js:436`: 148 lines
away, on a plan written this morning.

The page that documents the tool has rotted with it: `docs/MAINTAINING.md:142` says "of 348 citations,
150 name a symbol, and 28 of those pointed more than 40 lines", and `:165` says "today's single suspect
is `docs/BGP-POLICY.md:1090`" — against 350 / 15 / 7 today.

## What is missing or weak, ranked

1. **The plan corpus is invisible.** 62 citations in `docs/plans/`, none judged, and those files are
   the least stable text in the repo: every step in them names lines that the PR implementing the step
   will move.
2. **Coverage: 15 of 350 citations judged (4%).** The rule needs one citation and one call on the same
   line; docs wrap at 100 columns, so a sentence whose symbol sits on line *n* and whose citation sits
   on *n+1* is skipped. 266 lines are skipped today.
3. **Nothing fails on drift.** Seven judged citations are wrong by 56 to 513 lines right now, and
   `--strict` is opt-in and invoked nowhere.
4. **No rule for how to cite**, so the corpus grows in the unjudgeable shape: a bare range with no
   symbol beside it cannot be checked by construction, and `docs/plans` is 62 for 62.
5. **The judge has no test.** A simplification of `judgeLine()` can silently stop judging while the
   output still prints a number that looks like coverage.
6. **Prose numbers are outside its remit.** Counts ("2,188 models", "48 show forms / 96 commands") are
   typed by hand; `scripts/regen-registry-doc.js` derives one page's counts, and the rest keeps
   drifting — #1621, #1628 and #1637 all landed today.

## Ordered steps

| # | step | size | closes |
|---|---|---|---|
| 1 | Walk `docs/` recursively: `docs/plans` in, `docs/wiki` explicitly out (measured: 0 citations, and those pages are published to a separate repository where a line number means nothing to the reader). Print a per-directory count so a directory that appears later is visible rather than silently unscanned. Expect 412 references. | S | 1 |
| 2 | Judge the sentence, not the line: join continuation lines until a blank line, a bullet or a table row, then match. Report judged-before and judged-after on the same totals line, so the gain is a number and not a claim. | S | 2 |
| 3 | `test/check-doc-citations.test.js` over a fixture tree: in-range judged ok; 41 lines off is a suspect; two symbols on one line skipped; a wrapped sentence judged only after step 2; a subdirectory included. The script already exports `run`, `judgeLine` and `definitionLine`, so no refactor is needed. | S | 5 |
| 4 | Repair the 8 suspects (the 7 above plus the plan one), each to the line where the named symbol is defined. Docs only; no claim about behaviour changes. | S | 3 |
| 5 | Baseline and gate: `scripts/doc-citations-baseline.json` of accepted suspects, `--strict` fails on anything not in it, and the report prints the baseline size every run. One CI step beside `check-node-surface`, so a citation that rots inside a PR fails that PR. | S/M | 3 |
| 6 | The rule, written down: `CONTRIBUTING.md` gets "a citation names a symbol", and the 62 ranges in `docs/plans/` become `symbol()` plus a range. The measurement paragraph in `docs/MAINTAINING.md` is replaced by the command output rather than a second copy of the numbers. | S | 4 |
| 7 | **needs Jay to approve** — extend the derive-it rule that `regen-registry-doc.js` already applies to one page into a checker for prose counts (models, cages, media, show forms). Same failure, different shape, and a doc-ownership decision rather than a defect fix. | M | 6 |

## Risks

* **False accusations.** Sentence scope can pair a symbol defined elsewhere with this citation. Keep
  the two guards that make the tool trustworthy — one symbol, one citation, and a unique definition in
  the cited file — and never judge a sentence that names two or more functions.
* **A baseline becomes a hiding place.** Print its size in every run, and require it to shrink, never
  grow, in a docs PR.
* **Line endings.** Docs are stored LF (`.gitattributes`), but a checkout that skipped normalisation
  leaves CR; strip it before matching, or every citation on such a host reads as drifted.
* **Wiki drift.** `docs/wiki` is published separately; including it would gate PRs on pages whose line
  numbers a reader of the wiki can never use. Step 1 excludes it on purpose.

## Test strategy

The new fixture suite is the test strategy for the checker itself (step 3). For the docs, the measure
is the tool output: references must rise by the 62 that `docs/plans` already held, judged must rise
beyond 150, and suspects must reach 0 before the baseline file lands. `npm test` and
`node scripts/syntax-check.js` stay clean; the step 5 CI step is exercised with a deliberately stale
citation on a throwaway branch before it is trusted.

## Deliberately left out

* Replacing line numbers with anchors or links: the number is what a reader can check in a terminal at
  the commit they have. The plan adds a symbol beside it, not a different scheme.
* Prose that describes the wrong behaviour (#1571 class): a regex cannot tell a stale line number from
  a wrong sentence, and keeping that a human read is the point of a narrow tool.
* The counts checker is step 7 and fenced as a decision; the wiki pages and `docs/CI.md` are untouched.

## What this would close

Nothing open. It addresses the family that has produced #1481 (the checker itself), plus #1571, #1578,
#1582, #1587, #1621, #1628 and #1637 — seven of them closed today, each repaired by hand, one page at
a time, because nothing derives the claim.
