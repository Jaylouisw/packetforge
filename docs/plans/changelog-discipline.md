# Plan: the changelog has three "Unreleased" sections and nothing that reads it

Status: forward plan, no code. Measured on `b89ab7d6`, 2026-11-18. Closes **no** open issue - the queue is
two device requests (#130, #803) and neither is about the changelog. Scope: `CHANGELOG.md`, one new suite
under `test/`, `CONTRIBUTING.md`, and (step 6, needs Jay) one workflow file. No engine, server or web file
changes behaviour.

`CHANGELOG.md` is 551 lines and 6,397 words. It opens with `## Unreleased` and reaches its own `# Changelog`
title at line 308, below a server-CORS entry. Two more sections below that also claim to be unreleased. There
are no git tags, `package.json:3` still says `0.1.0`, and the only test that reads the file asserts it is
*exempt* from a rule - nothing asserts it is a changelog.

## What exists today

**Three headings for one release.** `## Unreleased` at `:1`, `## Unreleased` at `:315` (directly under the
`# Changelog` title and its Keep-a-Changelog preamble at `:308-314`), and `## [Unreleased]` at `:418`. The
entries below the title are not older than the entries above it: `git blame` puts `:319-353` on 2026-11-08,
the same day as `:152-241`. The title and preamble were written in the middle of the file and the sections
above and below it are the same release window split in two. A reader adding an entry has to guess which
heading is live, and the three blocks are the evidence that writers guessed differently.

**The format the preamble claims is not the format used.** The preamble at `:312` cites Keep a Changelog
1.1.0. Categories in the file: `Added` x7, `Fixed` x7, `Security` x2, plus `Devices` (`:399`) and
`Known defects (filed, not fixed)` (`:361`), which the spec does not define; `Changed`, `Removed` and
`Deprecated` are never used. Inside the live block alone, headings run `Fixed` (`:3`), `Added` (`:150`),
`Added` (`:217`), `Added` (`:239`), `Fixed` (`:251`), `Security` (`:282`), `Security` (`:295`) - six
headings where three would do, so a reader cannot scan one category and see the whole release.

**Nothing requires an entry.** `grep -rin changelog CONTRIBUTING.md` returns nothing, no file under
`.forgejo/workflows/` names it, and `docs/wiki/` holds six pages, none of them a changelog. Since 2026-11-07
the repository took **1,465 commits**, **274** of them touching `engine/`, while **36** touched
`CHANGELOG.md` - 24 of those on 11-07/11-08 and then **none at all until 11-16**. Of the 60 `- **` entries,
12 name a PR (`(#NNNN)`) and 9 cite a `research/` file, so an entry can be traced about one time in five.

**There is no release boundary.** `git ls-remote --tags origin` returns **0 tags**. The footer (`:550-551`)
defines `[Unreleased]` and `[0.1.0]` as GitHub compare links, owner spelled `Jaylouisw` - a capital
the forge never used - and `scripts/canonical.js:33` exempts the file from the URL rule on purpose.
So "Unreleased" has been the permanent home of every entry since 0.1.0, and the two links resolve to
a repository the project no longer develops on.

**One test, and it guards the exemption.** `test/canonical-urls.test.js:135-143` asserts
`EXEMPT_FILES.has('CHANGELOG.md')` and that the text still contains `github.com`. That is the whole test
surface: delete every entry and it still passes.

## What is missing or weak, ranked

1. **Three sections claim to be the live release**, so the file has no single place to append and no answer
   to "what is in the next release".
2. **No entry is required and the habit has already lapsed** - 274 engine commits against 36 changelog
   commits, seven consecutive days with none.
3. **No release boundary**: 0 tags, version pinned at 0.1.0, ~50 entries accumulated under "unreleased".
4. **Format drift**: duplicate categories within one release, two categories the spec does not define.
5. **Entry inflation**: median 64 words, but six entries run 211-311 words and carry the whole derivation
   inline, where 9 entries already show the better pattern - a summary plus a `research/` link.

## Ordered steps

1. **Collapse to one document, moving lines only** (S). One PR: `# Changelog` to line 1, preamble under it,
   one `## Unreleased`, the `:315-417` and `:418-532` blocks appended into it in their existing order, the
   `0.1.0` section last, one pair of link definitions. No prose edited. Verified before commit by a throwaway
   script that the multiset of entry lines is unchanged; that script is not committed.
2. **`test/changelog-shape.test.js`** (S). Fails-first, with a fixture proving the checker rejects a second
   `## Unreleased`. Asserts: first line is `# Changelog`; exactly one `## Unreleased`; every other `##`
   heading is a version and they descend; each category heading appears at most once per release and is one
   of the six; every entry starts `- **`.
3. **Repair the categories** (M). 18 `###` headings into at most one per category per release, folding
   `Devices` and `Known defects` into `Added`/`Fixed`. Two PRs - the live block, then the historic ones - so
   a reviewer sees heading moves and no rewritten claims.
4. **Backfill traceability** (M). 48 entries have no PR reference. `git log -S` on the test file each entry
   names usually finds the merge commit; where it does not, cite the test path instead. Then step 2's suite
   can require *a* reference, not specifically a PR number.
5. **Bring the six long entries down to size** (M). Their derivation moves to a `research/` page - the
   pattern 9 entries already use - leaving a summary, the source, and a link. Two PRs of three.
6. **Name a release and gate the file** (S + M, **needs Jay's approval**). Tag the commit where `package.json`
   became `0.1.0`, point the footer at `git.jayw.uk` (and update `test/canonical-urls.test.js:139-143` with
   it, keeping the exemption for historic entries), cut `0.2.0`. Then a `CONTRIBUTING.md` checklist line plus
   one CI check: a PR touching `engine/`, `server/` or `web/` must also touch `CHANGELOG.md` unless labelled
   `no-changelog`. `devices/` is deliberately excluded - 822 commits would make the gate noise, and the
   hardware catalogue has `docs/DEVICE_REGISTRY.md` for its own counts.

## Risks and test strategy

* **Conflict risk is the highest of any file.** Seven worker loops write prose in parallel; step 1 and step 2
  must land back to back or the file re-fragments, and step 1 should be rebased immediately before merge
  rather than resolved.
* **Steps 3 and 5 move other agents' prose.** The reviewer's check is that no claim, source or test name is
  lost, only relocated - a word-count-per-entry before/after table in the PR body is enough.
* **Step 6 moves 40 entries into a release nobody reviewed.** Tag `0.1.0` at the bump commit only if Jay
  agrees that is what shipped; the alternative is to rename the accumulated block to `0.2.0` and leave
  `0.1.0` as its nine-bullet summary.
* **The gate must not land before step 1**, or every new entry appends to whichever heading is nearest the
  top.
* Test strategy: `npm test` green, the new suite fails on a planted second `## Unreleased`, no engine suite
  touched, and `node scripts/check-canonical-urls.js` still clean.

## Deliberately left out

* **Reconstructing lost entries** for the 274 engine commits. The gate stops future loss; it cannot recover
  what was never written, and guessing from commit subjects would invent claims.
* **Generating the changelog from commit subjects.** Subjects here are already full sentences with issue
  numbers; a generator would produce a second copy of `git log` and none of the "why".
* **Publishing it to the wiki** (`docs/wiki/` has six hand-written pages) or adding a release-notes panel to
  `web/`. Both are product surface and would need Jay.
