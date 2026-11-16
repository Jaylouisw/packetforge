# Plan: two answers to "is it already modelled?", and the queue's is the wrong one

Status: forward plan, no code. Moves #795 from "ready to implement" to "already catalogued".
Scope: `scripts/request-queue.js` (the duplicate predicate only), a shared matcher module,
`scripts/sweep-device-requests.js` (API base), `test/request-queue.test.js`,
`docs/REQUESTING-HARDWARE.md`. Nothing here changes an engine rule or a device spec.

Distinct from every plan in `docs/plans/`: this is the hardware-request front door, not the
simulator. Measured on `9438e075`.

## What exists today

Two scripts answer the same question - *does `devices/` already hold this request?* - with two
different comparators:

* **`scripts/request-queue.js`** (the maintainer's queue). `:68-70` builds `have`, a `Set` of
  ``vendor.toLowerCase() + '|' + model.toLowerCase()`` taken **verbatim** from the spec, and
  `:109` tests the form's answers against it with the same concatenation. `:123-124` turns that
  into `ready` / `duplicateOf`, and `:161-162` prints the four counts. The queue is grouped,
  age-annotated and `--json`-able; `--skeleton <n>` writes a stub. Its header (`:13-14`) states
  the contract: *"A request is 'ready' when it names a vendor, a model and a datasheet URL, and
  the model is not already in the catalog."*
* **`scripts/sweep-device-requests.js`** (the backlog sweeper). `deEntity()` `:98`, `deDash()`
  `:106`, `norm()` `:110` fold entities, typographic dashes and punctuation onto a normal form;
  `variantOfSameCode()` `:331` refuses a variant-for-base match; nine guards are documented with
  the incident behind each in `docs/DEVICE_REQUEST_SWEEP.md`, and `test/sweep-requests.test.js`
  (242 lines) pins them.

The normaliser is what the catalogue actually needs, because **stored models are slugs**:
`loadCatalog()` on `9438e075` returns **2,257 specs, of which 1,682 contain no space at all** and
575 are display names. Huawei is the extreme: 86 files, 52 slugs, e.g.
`devices/huawei/netengine-8000-m4.json` has `"model": "netengine-8000-m4"` while a reporter types
`NetEngine 8000 M4`. Against that, the queue's exact key is a spelling test.

Measured against the live tracker today (20 open issues labelled `device-request`):

| view | duplicates found | ready to implement |
|---|---|---|
| queue predicate (`request-queue.js:68`, `:109`) | **0** | **20** |
| sweep normaliser (`norm()`, `:110`) | **1** - #795 -> `devices/huawei/netengine-8000-m4.json` | - |

#795 (`[Device]: NetEngine 8000 M4`, body `### Vendor Huawei` / `### Exact model name NetEngine
8000 M4`) is in the catalogue and the queue offers it as the next device to write. The queue does
see the issue - the label is present and the form parses - so the failure is the comparator, not
the input.

Two supporting facts, both cheap to fix and both evidence of the same neglect:

* The duplicate predicate is **untestable by construction**. It lives inside `main()`;
  `:193` exports `{ field, slug, CATEGORY_MAP, parseIssue: null }` - `parseIssue` is a null
  placeholder - and `test/request-queue.test.js` (82 lines) therefore tests only the form reader.
  The one function that decides "already catalogued" has no case in its suite.
* `:6-7` still says the script "shells out to the `gh` CLI"; it has required `./forgejo-api`
  (`:20`) for some time. `sweep-device-requests.js:26` hardcodes
  `http://10.0.10.20:3000/api/v1`, while `scripts/check-closed-issues.js:109-140` probes
  candidate bases and honours `FORGEJO_URL` / `FORGEJO_API` - this instance answers on
  `odin:3000`, so the sweeper cannot run here without an edit.

## What is missing or weak, ranked

1. **The duplicate test disagrees with the matcher** - measured 0 vs 1 above. Every run
   under-reports, and the one class of request it cannot see (slug-named models) is 75% of the
   catalogue.
2. **The predicate has no test and no exported seam** (`:193` `parseIssue: null`), so it cannot
   regress loudly; the sweep's guards have 242 lines behind them and the queue's has none.
3. **Neither script runs anywhere.** `.forgejo/workflows/` holds five workflows;
   `closed-audit.yml` runs `check-closed-issues.js`, and nothing references `request-queue.js` or
   `sweep-device-requests.js`. The queue is measured only when a human types the command, which is
   how #795 stayed "ready".
4. **The sweeper cannot resolve its own host** (`:26` vs `check-closed-issues.js:119`), so even a
   scheduled run would be tied to one address.

## Ordered steps

| # | step | size |
|---|---|---|
| 1 | **One matcher, exported.** Add `scripts/device-match.js` exporting `normalizeModel()` and `alreadyModelled(vendor, model, catalogue)` - moving `deEntity`/`deDash`/`norm` and `variantOfSameCode` out of `sweep-device-requests.js` verbatim and re-exporting them from it, so `test/sweep-requests.test.js` keeps its imports and stays green. No caller changes yet. | S |
| 2 | **The queue asks the matcher.** Replace the `have` `Set` (`request-queue.js:68-70`, `:109`) with `alreadyModelled()`; export `parseIssue` for real (`:193`) and fix the stale `gh` comment (`:6-7`). Regression case built from #795's real title and body: `duplicateOf` must name `devices/huawei/netengine-8000-m4.json`. | S |
| 3 | **A negative that protects the guard.** Cases in `test/request-queue.test.js`: `UDW-PRO` is *not* `UDW` (both live: #130 vs `devices/ubiquiti/udw.json`), `NC8400-4TH` is not `nc8200-4td` (#757), and `E6616X` is not `OptiXtrans E6616 (14x B1LDCD)`. This is the test that stops a "simplification" from making the queue's advice wrong. | S |
| 4 | **The sweeper resolves its base.** Take the probe from `check-closed-issues.js:109-140` (share it, or lift it into `scripts/forgejo-api.js`) and delete the literal at `:26`; honour `FORGEJO_URL` / `FORGEJO_API` / `PF_API`. | S |
| 5 | **The queue runs on merge.** A workflow in the `closed-audit.yml` shape - push to `main` plus `workflow_dispatch`, token optional (skip, never fail), report only - printing `open / ready / waiting / already catalogued` and naming each stale entry. Report-only because a red build nobody can act on is worse than no report, the reason `closed-audit.yml` gives for itself. | M |
| 6 | **Close the stale one.** `node scripts/sweep-device-requests.js --limit 700 --close N` as a one-off act after step 4 - it comments and closes on the tracker, so **needs Jay's approval**; it is not a PR. | S |

Step 5 is the only new surface, and it adds no product feature: it is the sweep the project
already documents, put where a merge can see it.

## Risks

* **A shared matcher could start closing things.** The queue must keep classifying only; `--close`
  stays exclusive to the sweeper, which already refuses hints by design (`sweep-device-requests.js`
  tail comment: *"a hint is a question for a human, not an answer"*).
* **Moving `norm()` without its guards is worse than leaving it.** The vendor guard, the
  three-digit part-number rule and `variantOfSameCode()` are what stopped `NetEngine 8000 M4`
  matching `apple/iPad Pro 13-inch (M4)`; the module must carry all of them, not just the string
  folding. Step 1's acceptance is the sweep suite unchanged.
* **False duplicates cost more than misses.** A request marked `duplicateOf` is a request nobody
  writes; when in doubt the predicate answers "not modelled".
* A per-merge API read is one more thing that can rate-limit; `closed-audit.yml` has taken that
  trade 185 times (median 32 s) and skips without a token.

## Test strategy

* `test/request-queue.test.js`: a new duplicate section (the #795 positive plus the three
  negatives above), all offline against `devices/` - no tracker calls, so the suite stays runnable
  in CI without a token.
* `test/sweep-requests.test.js`: unchanged and green after the move; it is the regression net for
  step 1.
* One cross-check case that both entry points agree on the same fixture title, so the two answers
  cannot diverge again silently.
* `npm test` plus `node scripts/missing-devices.js examples --no-issues` (already a CI step).

## Open issues this would close

* Nothing mechanically. It makes **#795** closable *with evidence* (step 6, needs Jay), and it
  stops the device stream spending a PR on hardware already in `devices/` - today's queue would
  have offered #795 first, and the remaining 19 cluster into four families (NetEngine 8000 x8,
  OptiXtrans x5, OceanProtect x3, Peplink EPX x2) where the same duplicate is easy to repeat.

## Deliberately left out

* **Closing anything automatically** - the tracker is Jay's, and `docs/RESOLUTIONS.md` exists
  precisely because a wrong close is unrecoverable from every automated view.
* **Writing any of the 19 device specs** - that is the device stream's work, one family per PR.
* **A fuzzy/hint tier in the queue** - the sweeper already has one and it is a question for a
  human; duplicating it would make the queue's advice ambiguous.
* **#1507 (the 46 GB repository)** - host-side history work, not a repository change; already
  documented in `docs/CI.md` and `docs/FORGE_TROUBLESHOOTING.md`.
