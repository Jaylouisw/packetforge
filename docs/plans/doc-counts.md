# Plan: the docs count things by hand, and one of those counts is already wrong

Status: forward plan, no code. Measured on `d81e56dd`, 2026-11-17. Closes no open issue - the queue is seven
device requests (#743, #742, #130, #803, #807, #808, #810), none about the documentation. Steps 1-4 change no
engine behaviour; step 5 is deliberately deferred and is labelled so.

The documentation quotes three kinds of numbers about the code: how many checks a suite has, how many `show`
forms the parser answers, and how many words a table holds. Nothing measures any of them. They are re-derived by
hand in the PR that changes the underlying count, and one has already drifted: `docs/ARCHITECTURE.md:1108` says
`test/trunk-allowed-add-remove.test.js` has **47 checks**; it prints **57** today (`#1831` added ten and the
sentence was not revisited). A reader has no way to tell a number that is current from one that was current.

## What exists today

Half the machinery is already written and one page already proves the pattern works.

* **The pattern.** `test/doc-catalog-counts.test.js` reads `docs/DEVICE_REGISTRY.md` and asserts its counts
  against `devices/` (`:45-51`), cell by cell (`:76`), with a floor so an empty table cannot pass (`:79`). Its
  header states the motive in one line: *prose goes stale and nothing was watching it.* That is this plan's
  whole argument, already accepted for one page.
* **The measurement.** `scripts/run-tests.js` already knows how many checks each suite ran - `tally()` (`:68-90`,
  regex at `:70`, TAP fallback at `:83`) is the authority `npm test` totals from. It is not exported (0
  `module.exports` in the file) and `runAll()` fires on load, so no test can borrow it yet.
* **The cost is known.** The 28 doc claims that name a suite path, run serially, take **34 s** (measured), against
  a 318-suite run; `--concurrency` already exists (`:54`), so a 4-way walk is about 10 s.
* **The census that is closest to being checked.** `test/docs-show-commands.test.js` prints exactly the numbers
  `docs/CLI.md:2339` quotes - *54 forms, 108 commands* - and `:2345` quotes *Sixty-six of the 108*; running it
  today prints `54`, `108 commands typed`, `66 refusals`. It asserts only a floor (`:92`, `forms.length >= 40`),
  so the doc and the test can disagree and both pass. That sentence was rewritten by hand three times in the last
  ten PRs (`#1780` 52/104/62, `#1852` 53/106/64, `#1854` 54/108/66), which is the churn this plan removes.
* **A live contradiction in a doc merged today.** `#1858` retitled a section "thirteen words, not twelve" and
  added the paragraph at `docs/ARCHITECTURE.md:713-717`, but the same section still reads *"for each of the twelve
  words the answer names it as a view"* (`:732`) - while `INTERFACES_VIEW_KEYWORDS` (`engine/cli.js:394-408`)
  holds 13 entries. Nothing failed. The 26 remaining checks at `:736` are a *portion* of that suite's 97, not a
  suite total, which is the shape trap step 2 has to survive.

The claim shapes, counted on `d81e56dd`: `N checks` appears 35 times (26 in `ARCHITECTURE.md`, 8 in `CLI.md`, 1 in
`DEVICE_REQUEST_SWEEP.md`); 28 of them name a `test/*.test.js` inside the same sentence; 4 sit in a "Neighbours
green: `dhcp` 134, ..." list under a short name; 3 say "reverting `engine/` fails N". A sweep of the 28 resolvable
ones found **1 drift (3.6 %)**, and every one of the 27 clean ones agrees by hand-maintenance, not by construction.

## What is missing or weak, ranked

1. **No one measures suite counts.** The claim decays with every PR that adds an assertion - the commonest kind of
   PR in this repo - and 27 of 28 are currently right only because each author remembered.
2. **`docs/CLI.md`'s census is a third-hand number.** The suite computes it and prints it; the page restates it;
   no line connects the two. Three hand edits in ten PRs, and the refusal count is per *command* (108 answers),
   not per form, which is exactly the kind of distinction a hand count gets wrong.
3. **Table sizes in prose** ("twelve/thirteen words") are readable from one array literal and asserted nowhere.
4. **Two live defects** to fix on the way past: `ARCHITECTURE.md:1108` (47 -> 57) and `:732` (twelve -> thirteen).

## Ordered steps

1. **Export the count (S).** New `scripts/suite-counts.js`: move `tally()` out of
   `scripts/run-tests.js:68-90` verbatim and `require()` it back there, so `npm test`'s totals and the doc check
   share one rule - the same "one rule, shared with the writer" argument `doc-catalog-counts` makes at `:15-17`.
   Plus `measure(files, {concurrency})` returning `{file: checks}` from real child processes.
2. **`test/doc-counts.test.js` (M).** Walk `docs/*.md`, join lines **within a paragraph** (a suite name and its
   count are on different lines at `ARCHITECTURE.md:1108-1109`), match `<test path> ... N checks` on the
   present-tense shape only, measure each suite once, assert documented === measured with the fix on the failure
   line (`docs/ARCHITECTURE.md:1108 says 47, measured 57`). Refuse to pass below a 20-claim floor, and fail on a
   doc naming a suite that no longer exists. Same file proves itself twice, the way `docs-show-commands:130-149`
   does: a synthetic doc with one correct and one wrong count must produce exactly one failure.
3. **Clear the two live defects (S).** `ARCHITECTURE.md:1108` 47 -> 57 and `:732` twelve -> thirteen. Doc-only, and
   it is what makes step 2 green without an allowlist on day one; land it before step 2, so the new suite arrives
   green and every future drift is attributable to its own PR.
4. **Make the `show` census the suite's own (M).** `test/docs-show-commands.test.js` already prints
   `documentedForms(doc).length` and `refusals.length`; assert those against the numbers in the paragraph it reads
   (`docs/CLI.md:2339`, `:2345`), parsing them out of the page rather than hardcoding a fourth copy. Deleting one
   hand-count from the workflow is the point, not a side effect.
5. **Deferred, on purpose - the two hard shapes (M, needs Jay's approval to schedule).** "Neighbours green: `dhcp`
   134" needs a short-name -> file resolver; "reverting `engine/` fails N" needs a revert harness and is a
   different claim (an assertion that the test *would* fail), so it should either be measured by a real revert in
   a nightly job or dropped from the prose. Both are 4 and 3 instances respectively; neither is worth building
   before steps 1-4 are green.

## Risks and tests

- **A prose matcher that is too eager.** "The remaining 26 checks are the port-first spelling" (`:736`) is a
  portion and must not be read as a suite total; the rule is *the first number after a suite path in the
  paragraph, present tense, `checks`* - anything else is skipped and counted, and the file prints what it skipped
  so a silent skip is visible (the failure mode `scripts/check-doc-citations.js` was built to avoid).
- **Historical counts.** A sentence describing what a number *was* in an old PR must not fail the build. Rule: a
  claim is in scope only if its paragraph carries no issue number in backticks.
- **Runtime.** 28 suites, 34 s serial; run at `--concurrency=4` (about 10 s, the same isolation the runner already
  relies on) and cap the walk at both a suite count and a wall clock, failing loudly rather than silently
  truncating.
- **Suites that need a lab.** These are ordinary engine suites that build their own topology and bind port 0, so
  no fixtures are needed - but a suite that exits non-zero must be reported as *unmeasured*, never as a match;
  the count is not the pass/fail verdict and this suite must not become a second, weaker `npm test`.
- **Net:** `node scripts/run-tests.js --filter=doc` plus the full run; the two known drifts are the acceptance
  test - step 2 must fail against `d81e56dd` and pass after step 3.

## Issues this would close

None open, and it competes with nothing in `docs/plans/`: `doc-citations.md` owns file:line drift, this owns
counts. Its first delivered value is small and immediate - the two wrong numbers already on `main`.
