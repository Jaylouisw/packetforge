# Plan: a citation is a claim, and the checker cannot see the pages that make the most of them

Status: forward plan, no code. Re-measured on `1cbf747e`, 2026-11-24. **No step of this plan has
landed** in the eight days since it was written: `documentationFiles()` (77) still reads `docs/*.md`
top level only, `check:citations` is still a lone `package.json:54` script with no CI step, and
neither `test/check-doc-citations.test.js` nor a baseline file exists. What changed is the size of
the blind spot — 62 citations then, **833** now — and the fact that the TypeScript conversion has
begun deleting the files those citations name.

## What exists today

The tool is unchanged: `DRIFT = 40` (32), `REF` (34), `CALL` (35), `resolve()` (53),
`definitionLine()` (61), `judgeLine()` (98), `run()` (123), `documentationFiles()` (77).

`node scripts/check-doc-citations.js` today:

```
Citations in docs: 364 — 24 judged against a unique definition, 263 lines left to a reader
Suspects (1, allowed drift 40 lines):
  docs\CLI.md:3676      engine/device.js:1161 is 401 lines from the definition at 760
```

The same `run()` pointed at the plan corpus (`run({files: docs/plans/*.md})`, 2026-11-24):

```
833 references — 68 judged (8%), 666 lines left to a reader, 37 suspects in 19 of 45 plans
worst plans: ipv6-visibility 7, vrrp-track 4, dhcp-relay 3, nat-table-rebuild 3
```

On 2026-11-16 that call reported 62 references and 1 suspect. The corpus gained 41 plans in eight
days — this stream writes one a run — and its citations now outnumber the docs' by 2.3:1.

Two classes the tool cannot report at all:

* **A converted file makes its citations vanish.** `REF` (34) lists `js|json|md|yml|html|css` and
  not `ts`, so `engine/lag.ts:131` is not a citation as far as the checker is concerned: not
  counted, not judged, not skipped, not suspected. That hides 19 citations in `docs/*.md` and 3 in
  the plans today. The conversion plan (`typescript-conversion-order.md`, step 6) has 28 engine
  modules left, and the plans cite `engine/cli.js` 143 times, `engine/simulator.js` 84 and
  `engine/device.js` 52 — so the tool's own reference total will **fall** as the tree converts, and
  a falling total reads as improvement.
* **A citation whose file is gone is skipped, not flagged.** Eight citations in three plans name
  a file that no longer exists: `engine/segment.js` three times in `dhcp-relay.md`, `engine/lag.js`
  four times in `lag-min-links.md` (90, 98, 99, 427), `scripts/canonical.js:33` in
  `changelog-discipline.md`. `resolve()` returns null, `judgeLine()` returns null, and the line
  lands in `skipped` — the same bucket as prose that names no symbol. The files now are
  `engine/segment.ts`, `engine/lag.ts` and `scripts/canonical.ts`: #2483, #2504 and #2484 are the
  three conversions that chased these citations.

Also: 40 of 45 plans carry "Measured on `<sha>`" and 5 carry none (`capability-vocabulary`,
`ospf-elections`, `poe-budget-variants`, `server-exposure`, `undo-granularity`), so a worker cannot
tell which tree those numbers were true on. `docs/MAINTAINING.md:142` still says "of 348 citations,
150 name a symbol, and 28 of those pointed more than 40 lines", and `:165` says "25 of 380 citations
are judged" — today's run says 364 references and 24 judged.

## What is missing or weak, ranked

1. **`REF` cannot see a `.ts` file** (34). Conversion is the one change that moves cited lines en
   masse, and it makes those citations disappear from the count rather than fail it.
2. **A dangling target is invisible.** Eight today; every conversion of a cited module adds more,
   and the reader who follows one arrives at a path that does not exist.
3. **The corpus is unscanned.** 833 references, 37 judged-wrong, 19 of 45 plans affected, and
   `documentationFiles()` (77) does not open one of them.
4. **Coverage: 68 of 833 judged (8%).** The rule needs one citation and one call on the same line;
   docs wrap at 100 columns, so 666 lines are skipped.
5. **No "measured at".** Five plans name no commit at all.
6. **Nothing fails on drift.** `--strict` is opt-in and invoked nowhere; there is no baseline file.
7. **The judge has no test.** Every number above rests on `judgeLine()` (98), which no suite names.
8. **Prose counts are outside its remit** — #2517 is the current example and still a human read.

## Ordered steps

| # | step | size | closes |
|---|---|---|---|
| 1 | Teach `REF` (34) `ts`. Fix the regex, not the resolver: the 22 `.ts` citations already in the tree are the fixture, and the reference count must rise by exactly them. | S | 1 |
| 2 | Report a target that does not resolve as its own count (`dangling`), printed beside judged and skipped, naming the near-miss (`engine/lag.js` to `engine/lag.ts`) without resolving to it. Expect 8. | S | 2 |
| 3 | Walk `docs/` recursively: `docs/plans` in, `docs/wiki` explicitly out (0 citations, and those pages are published where a line number means nothing). Print a per-directory count so a directory that appears later is visible rather than silently unscanned. | S | 3 |
| 4 | Judge the sentence, not the line: join continuation lines until a blank line, a bullet or a table row. Print judged-before and judged-after on the same totals line. | S | 4 |
| 5 | `test/check-doc-citations.test.js` over a fixture tree: in-range ok; 41 lines off a suspect; two symbols on one line skipped; a wrapped sentence judged only after step 4; a `.ts` citation counted; a dangling target reported. `run`, `judgeLine` and `definitionLine` are already exported. | S | 7 |
| 6 | Repair the eight dangling citations to the new name — four of them in one plan, so one commit. | S | 2 |
| 7 | Repair the 37 plan suspects, worst plan first: `ipv6-visibility` (7), `vrrp-track` (4), then the 3s. A plan's citation is a briefing, so a worker starting from one must land on the code. | S/M | 3 |
| 8 | A "Measured on" header on every plan, and a test that the sha it names exists in history. Five files need one written; the other forty are the fixture. | S | 5 |
| 9 | Baseline and gate: `scripts/doc-citations-baseline.json`, `--strict` fails on anything not in it, and the report prints the baseline size with the `.ts` and dangling counts on every run. One CI step beside the existing static checks. | S/M | 6 |
| 10 | The rule, written down: `CONTRIBUTING.md` gets "a citation names a symbol", and `docs/MAINTAINING.md`'s measurement paragraph is replaced by the command output rather than a second copy of the numbers. | S | 6 |
| 11 | **needs Jay to approve** — extend the derive-it rule `regen-registry-doc.js` already applies to one page into a checker for prose counts (models, cages, media, show forms). Same failure, different shape, and a doc-ownership decision rather than a defect fix. | M | 8 |

Steps 1 and 2 come before 3 on purpose: the walk changes what is scanned, so the counts have to be
honest first — otherwise the 833 arrives with 22 citations already missing and eight more silently
skipped. Step 6 comes before 7 because a dangling citation repaired by hand returns at the next
conversion; the durable fix is the new name plus step 1.

## Risks and test strategy

* **False accusations.** Keep the guards that make the tool trustworthy — one citation, one symbol,
  and a unique definition in the cited file — and never judge a sentence naming two functions.
* **A rename and a wrong path look alike.** Step 1 adds an extension; it must not add a fallback
  that resolves `lag.js` to `lag.ts`, or a genuinely wrong citation is pardoned forever.
* **A baseline becomes a hiding place.** Print its size in every run and require it to shrink, never
  grow, in a docs PR.
* **Line endings.** Docs are LF in `.gitattributes`; strip CR before matching, or a host that
  skipped normalisation reads every citation as drifted.

The fixture suite is the test for the checker. For the corpus the measure is the tool's own output:
references must rise from 364 to about 1,220 (833 plan citations plus the 22 `.ts` ones), judged
must rise beyond 68, `dangling` must reach 0 after step 6 and suspects 0 before step 9's baseline
lands. `npm test`, `node scripts/syntax-check.js` and `npm run typecheck` stay clean throughout; the
CI step is proved on a throwaway branch with a deliberately stale citation before it is trusted.

Left out on purpose: anchors or links instead of line numbers (the number is what a reader can check
in a terminal at the commit they hold); wrong-prose detection of the #1571 class (a regex cannot
tell a stale number from a wrong sentence, and keeping that a human read is the point of a narrow
tool);
`docs/wiki`, published to a separate repository; the counts checker, fenced as a decision.

## What this would close

No open issue. #2517 is a stale count in `docs/CLI.md`, which belongs to the doc-counts family, not
this one. The plan addresses the family that produced #1481 (the checker itself), and the seven
pages repaired by hand before it: #1571, #1578, #1582, #1587, #1621, #1628 and #1637.
