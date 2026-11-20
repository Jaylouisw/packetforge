# Plan: two audits ask one question, and the ungated one is 33 devices wrong

Status: **landed** 2026-11-20 in #2301 (steps 1-6, below). Measured on `1855814a`, 2026-11-17, when it was a
forward plan. Closes **no** open issue — the queue is two device requests (#130, #803) and neither is
about tooling. Scope: `scripts/audit-devices.js`, one additive export in `engine/media.js`, one new suite
under `test/`, `package.json:11`, `docs/CI.md:44`. No engine rule changes verdict.

## What exists today

**The rule that is tested.** `test/hardware-invariants.test.js` asks whether a device that advertises
optics in its prose actually has an optical cage. It strips denials (`:42`), strips clauses that call
the optics optional, unfitted or an extra-cost module (`:44-48`), counts a port optical when
`derivePortHardware().cage` is in its `OPTICAL` list (`:131-134`), and asserts the leftovers are
exactly `test/known-issues.json` -> `opticsWithoutCage` (`:142-151`). That list is **empty**, and the
suite also fails if a listed device is fixed but not removed — so the test's answer today is **0**.

**The same rule, untested and unreachable.** `scripts/audit-devices.js` asks the same question with
its own tables: `OPTICAL_CAGES = ['sfp','sfp+','sfp28','qsfp+','qsfp28']` (`:16`), a two-regex denial
strip with no optional-module clause (`:53-57`), and its own verdict at `:77`. Nothing invokes it:
it has no `npm` script and appears in no workflow (checked over `.forgejo/workflows/` and
`package.json`). `CHANGELOG.md:364` still advertises it, and
`research/incoming/audit-port-types-report.md:87` cites it by name.

**Its answer today is 33.** `node scripts/audit-devices.js` on `1855814a`:

| devices | only cages present | why the old table misses it |
|---|---|---|
| 28 | `sc-apc` / `sc-upc` (GPON ONT/ONU, splitters) | PON cages are not in the 5-entry literal |
| 3 | `fc-sfp28`, `fc-sfpdd`, `fc-qsfp28` (Brocade/HPE/Dell FC SAN) | Fibre Channel cages are not in it either |
| 2 | `rj45` only (e.g. `watchguard/firebox-m290`) | prose says "no SFP cages **as shipped**", then names an optional SFP module |

**The table both of them should be reading.** `engine/media.js:339` already classifies every cage:
`family: 'optical'` covers `sfp` through `cfp2` **and** `sc-apc`/`sc-upc`/`lc-*`, and
`family: 'fibre-channel'` covers `fc-sfp`/`fc-sfp28`/`fc-sfpdd`/`fc-qsfp28`. It is exported as
`CAGES` (`:1560`), the engine reads it, and neither audit does.

**The gate that does run.** `package.json:11` — `audit-port-types && check-control-bytes && run-tests`.
`scripts/audit-port-types.js` is 659 lines, exports `auditSpec` "hand it a fixture and it audits it
exactly as the CLI does" (`:651`), and is exercised only through `test/template-expansion.test.js:28`,
a suite about template expansion. It exits 1 on offenders (`:646`) and, in the same run that prints
"264 port(s) in 7 spec(s)" under a heading naming the #60 defect shape, ends "No port contradicts its
declared type." (`:641`) — true only of the narrower rule it gates.

## What is missing, ranked

1. **One predicate for "is this cage optical".** Two audits, a hardcoded five-entry list, and a
   metadata table that already answers it. 33 devices differ because of it.
2. **The disagreement is invisible.** The older audit is 0.4 s and imports cleanly, but nothing runs
   it and it exits at import (`:81`, no `require.main` guard), so no test can ask it anything.
3. **Both tools end with an all-clear over a non-empty body.** `audit-devices:77` prints "No hard
   defects." after listing 33 findings it does not count as defects; `audit-port-types:641` says no
   port contradicts its type after printing 264 that do, under a rule it reports instead of gates.
4. **`docs/CI.md:44`** enumerates what the test job runs, omits `audit-devices`, and does not say
   whether that is deliberate.

## Ordered steps

1. **S — Make the older audit askable.** Split `main()` behind `if (require.main === module)` and
   export `auditCatalog(specs)` and `OPTICAL_CAGES` from `scripts/audit-devices.js`. Output and exit
   code unchanged; `node scripts/audit-devices.js` must print the same 33 before and after.
2. **S — Pin the disagreement as a test.** New `test/audit-agreement.test.js`: run
   `auditCatalog(loadCatalog(...)).opticalMissing` and the `hardware-invariants` predicate over the
   catalogue, assert the two name the same devices. Fails today with the 33-device difference; that
   failure *is* the reproduction, and it is why step 1 comes first.
3. **S — One predicate.** Add `isOpticalCage(cage)` to `engine/media.js` beside `CAGES`, true for
   `family` `optical` **or** `fibre-channel` (the two the engine can cable at a fibre end), and use it
   in `scripts/audit-devices.js` at `:16` and `:47` instead of the literal. Expected: 33 -> 2.
4. **S — The last two.** Strip the optional/unfitted clause the newer test already strips
   (`test/hardware-invariants.test.js:44-48`) in `scripts/audit-devices.js:53-57`. Expected: 2 -> 0,
   and the agreement suite from step 2 turns green.
5. **S — Say which audits run.** Either add `node scripts/audit-devices.js` to the `package.json:11`
   chain (0.4 s measured against a suite that already takes minutes) or delete the file and the
   `CHANGELOG.md:364` line. Deleting a documented tool is **needs Jay's approval**; running it only
   makes CI match the documentation that already claims it. Update `docs/CI.md:44` either way.
6. **S — Let each verdict name both numbers.** `scripts/audit-devices.js:77` and
   `scripts/audit-port-types.js:641` should print what they gated and what they merely reported
   ("0 contradictions; 264 ports reported under report-only rules"), so a green exit is not read as
   "nothing was found". Wording only — no rule, threshold or exit code changes.

## Risks

- **`engine/media.js` is the hottest module.** The export is additive and reads the table it already
  owns, but it is imported by `audit-port-types`, `hardware-invariants` and the link layer — run the
  full suite, not the two suites named here.
- **A wider predicate could hide a real defect.** Counting FC and PON cages as optical is correct for
  "can this port take a fibre lead", and wrong for "this is a datacentre uplink". If step 5 makes the
  audit gate, the two rules must stay separate answers, not one number.
- **Deletion looks like progress.** Step 5's delete is cheap and reversible only because git keeps the
  file; the 2,968 undeclared template ports `audit-port-types` reports are the reason to keep a
  second, differently-shaped audit rather than merge the two.

## Test strategy

`node test/audit-agreement.test.js` must fail on `1855814a` and pass after step 4 — that pair of runs
is the evidence for the whole plan. Then `npm test` (313 suites; `hardware-invariants`,
`template-expansion` and `optics-catalogue` are the ones that bite), `node scripts/audit-devices.js`
(expect `No hard defects.` and 0 in the optics line), and `node scripts/audit-port-types.js` (expect
still exit 0 — no rule changes here). Record the table from "Its answer today is 33" in each PR body,
because the counts are the finding.

## Issues this would close

None. Every open issue is a device request; this plan repairs tooling the repository already ships and
docs that already describe it. It unblocks nothing in the queue.

## Deliberately left out

The 2,968 template ports in 133 specs whose connector nothing declares — reported by design, and #71
is the tracked home for that coverage. The `otn`/`wdm` media family that #807/#808/#810 need —
`docs/plans/stated-configurations.md` step 6 owns that decision. The stale counts in
`test/template-expansion.test.js:4` ("186 of 902 specs", 4,476 of 11,190 ports; today 351 of 2,348 and
8,525 of 29,235) — a docs-in-test tidy-up that belongs with whichever PR touches that suite next, not
with an audit change.

## What landed, measured

Step 1 (`auditCatalog()`/`claimsOptics()` exported, `require.main` guard), step 3 (`isOpticalCage()` in
`engine/media.js`, read by both tools), step 4 (the optional-module clause), step 5 (`audit:devices`
added to the `package.json` test chain and to `docs/CI.md` — the file is kept, not deleted) and step 6
(both verdicts name what they gated and what they merely reported). One addition the plan did not have:
the denial strip now runs **before** the clause split, because `SFP: none` was being split at the colon
into a bare `SFP` and a dropped `none`.

| Run | Before | After |
|---|---|---|
| `node scripts/audit-devices.js`, optics line | 33 | **0** |
| `node test/hardware-invariants.test.js` | 26 passed | 26 passed (same answers, one predicate) |
| `node test/audit-agreement.test.js` | — (new) | 11 passed |
| `node scripts/audit-port-types.js`, exit 0 | "No port contradicts its declared type." | "Gated: 0 … Reported, not gated: 2,704" |

The 33 were exactly the table above: 28 PON (`sc-apc`/`sc-upc`), 3 Fibre Channel (`fc-sfp28`,
`fc-sfpdd`, `fc-qsfp28`: `brocade/g720`, `dell/ds-6630b`, `hpe/sn3600b`), and 2 optional module bays
(`watchguard/firebox-m290`, `microsemi/syncserver-s600`). The `audit:devices` step costs 0.43 s against
a suite that already takes minutes.

Still open, deliberately: the 2,704 template ports in 126 specs whose connector nothing declares (#71),
and the `otn`/`wdm` media family (#807/#808/#810, `docs/plans/stated-configurations.md` step 6).
