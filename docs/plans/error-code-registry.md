# Plan: one registry for every code, or the guard is a coin toss

Status: forward plan, no code. Answers #1654, whose *symptom* is gone from `main` and whose cause is
not. Scope: `engine/validation.js` (the `RULES` table only), `test/validation.test.js:370`,
`test/property-validator.test.js:48,125`, one new `scripts/check-code-registry.js` + its CI step,
and the code table in `docs/PHYSICAL_LAYER.md:181-196`. No rule's verdict is supposed to change.

## What exists today

`RULES` (`engine/validation.js:61`) is 24 `{code, severity, description}` entries, exported at
`:1083`, indexed by `SEVERITY_BY_CODE` (`:171`) and `DESCRIPTION_BY_CODE` (`:177`). The header
states the contract the table is supposed to satisfy (`:23-24`): "Codes are stable strings: the UI
switches on them, so never rename one without adding the replacement to RULES."

Measured on `abbab2e8` (regex `code: '...'` over all 30 files in `engine/`):

| surface | codes | outside `RULES` |
|---|---|---|
| `engine/` as a whole | 84 | 60 |
| the cabling path (`validation.js`, `media.js`, `optical.js`, `topology.js`, `link.js`) | 56 | 32 |
| `validation.js` alone — the module that owns the table | 29 | 5 |

The five its own module forgets are `E_OPTICAL_BUDGET` (`:780`), `W_OPTICAL_HEADROOM` (`:787`),
`E_LINK_UNCHECKABLE`, `E_NOT_A_TOPOLOGY`, `S_PATCH_CORD_REQUIRED`. `E_BIDI_MISMATCH` — the code in
the #1654 repro — is raised at `engine/optical.js:225` and in `engine/media.js`, and is registered
nowhere.

Three guards already claim this ground and none of them checks it:

* `test('RULES documents every code the engine can emit')` (`test/validation.test.js:370`) never
  reads a source file. It asserts the 24 entries are well-shaped and that **16 hardcoded codes** are
  present — a shape test wearing a completeness test's name. Its only size assertion is
  `RULES.length >= 16` (`:371`), so growth never trips it either.
* `docs/PHYSICAL_LAYER.md:181-196` tabulates **16** codes (11 errors, 5 warnings) — the same 16, and
  already 8 behind `RULES`. Six other docs pages carry code rows (`CONNECTORS.md` 32,
  `UPSTREAM-DESIGN.md` 26, `ARCHITECTURE.md` 10, ...), so the documentation is the de facto registry,
  hand-maintained, with no single authority.
* `test/property-validator.test.js:48` builds `RULE_CODES` from `RULES` and `:125` fails on anything
  outside it — with `E_PORT_IN_USE` exempted **by name**, so the gate is already known to be wrong.

Consequence when a code slips through anyway: `severityOf()` (`:975-979`) invents `error` for an
unknown code, and `collectIssues()` (`:1010-1012`) falls back to using the code itself as the user
message. An unregistered code that arrives without a message renders as `E_BIDI_MISMATCH` on screen.

Why `main` went red and then healed by itself: the property test builds each topology from
`specs[Math.floor(rand() * specs.length)]`, so **the catalogue's size is part of the seed**. #1647
took the fixture from 2202 to 2203 specs, seed 65 landed on a BiDi pairing, and the suite failed;
#1655 added one more device, the draw moved off it, and the suite went green with no test or engine
change. Locally today: 2203 specs, 24 rule codes, 19 assertions, 0 failures.

## What is missing, ranked

1. **One machine-readable list of every code the cabling path can emit.** Today: 24 registered, 32
   live, three hand-kept copies, and the authority is whichever file the reader opened.
2. **A guard that reads the sources.** The test that says it does this cannot fail for the reason
   it names; it fails only when somebody deletes a line from its own hardcoded array.
3. **A documented shape for the third prefix.** `S_PATCH_CORD_REQUIRED` is a suggestion, and the
   table's own test allows only `error`/`warning` (`test/validation.test.js:376`).
4. **The silent fallbacks** in `severityOf`/`collectIssues` — they turn a missing registration into a
   wrong severity and a raw token in the UI, instead of a build failure.
5. **The catalogue-coupled sample** in the property test — a separate defect, but the one that makes
   every catalogue PR a lottery ticket for #1654's symptom.

## Ordered steps

Each is one PR by one worker; sizes are relative.

1. **S — inventory, no verdicts.** Add `scripts/check-code-registry.js`: scan `engine/*.js` for
   emitted codes, diff against `validation.RULES`, print `registered / emitted / missing` and the
   file each missing code comes from. Exit 0, print only; wire it into CI as an advisory step so the
   number is visible on every PR. Nothing about behaviour.
2. **M — register the cabling path.** Add the 32 codes to `RULES` with severity and a one-sentence
   description, and decide `S_`'s fate in the same PR (either add a third severity to the table and
   to `:376`, or rename it to `W_` and note the rename in the changelog comment). Table-only: no
   rule body, no verdict is touched. Expect `test/validation.test.js` and every example test to stay
   green untouched.
3. **S — make the completeness test real.** Replace the hardcoded 16-code array at
   `test/validation.test.js:370` with the scan from step 1 (shared helper, not a copy), so the test
   fails when a new emitter appears without a registration. Delete the 16-name list; keep the
   shape/duplicate/severity assertions.
4. **S — point the property gate at the same list.** In `test/property-validator.test.js`, build
   `RULE_CODES` from the registry helper instead of `RULES` alone, and delete the `E_PORT_IN_USE`
   exemption at `:125`. This is the line that made #1654 look like an engine regression.
5. **S — flip the advisory step to a gate.** `scripts/check-code-registry.js` exits non-zero for the
   cabling path; keep an explicit, shrinking allowlist for the runtime families (step 7) so the step
   lands green.
6. **M — generate the doc table.** Render `docs/PHYSICAL_LAYER.md:181-196` from `RULES` with a
   `--check` mode in CI. Compare line-ending-normalised text, not raw bytes: `docs/wiki` publishes
   through the same trap and reports every page stale on a Windows host.
7. **M — the runtime family, needs Jay's approval.** The remaining 28 codes (`simulator.js`,
   `vrrp.js`, `ipv6.js`, `topology.js` restore) are not cabling verdicts; they belong in their own
   namespace or a second table. This is a product decision about how much of the API's error surface
   is public, so it is labelled rather than assumed.
8. **S — decouple the sample from the catalogue.** Seed the property test's device pick from stable
   spec ids and a fixed fixture count, so adding a device changes the catalogue, not the test's
   meaning. Independent of 1-6 and worth landing even if they stall.

## Risks

* **Renames are breaking.** `web/app.js:1335` switches on `S_PATCH_CORD_REQUIRED`; any code the UI or
  an API consumer matches must keep its string. Steps 2 and 7 add, never rename — step 2's only
  rename candidate is the `S_` prefix, and only if the third severity is rejected.
* **Severity is load-bearing.** Registering a code that `severityOf()` previously guessed as `error`
  can only preserve or relax a verdict; registering one as `warning` would make a blocking error
  advisory. Step 2 must register each code at the severity it already behaves as, and the PR should
  say so per code.
* **A gate that fails on `main` blocks everyone.** Step 5 must land with the allowlist already
  matching reality; the failure mode here is a second #1654, not a caught bug.
* **Two registries is worse than one.** If step 7 introduces a second table, step 3's scan must know
  which files each table owns, or it will drift the same way the docs did.

## Test strategy

Steps 1, 3, 4, 5, 8 each ship with the suite they touch: `node --test test/validation.test.js` and
`node --test test/property-validator.test.js` before `npm test`; steps 1 and 5 are checked by running
the script on a tree with one code deliberately unregistered (fails) and on `main` (passes). Step 2's
acceptance is *no test changes at all* apart from step 3's, which is the proof that the addition is
inert. Step 6 is checked by regenerating twice (byte-identical) and by a CRLF checkout. Every step
must leave all three `CI / Test` legs green on Node 18/20/22.

## Issues

Closes **#1654**. Its repro is a seed; its cause is this table. The plan fixes the cause and leaves a
guard that fails when the condition recurs, which the current one cannot. Deliberately not in scope:
#1507 (disk), the device-request queue, and any change to what the validator *decides*.

Deliberately left out: rendering codes in the UI, a public `/api/codes` endpoint, and translating
`RULES` into other locales — all product surface, none of it needed to make the guard honest.
