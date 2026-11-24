# Plan: the conversion has no order, and two gates cannot see a `.ts` file

Status: forward plan, no code. Measured on `dfb3aee2`, 2026-11-24. Closes one open issue, #2488 - which is
already fixed in the tree by #2491 (`ci.yml:283-310`) and is open only because that pull request did not name it.
Steps 1-5 change no engine behaviour; step 6 is the first conversion and is deliberately the only one here.

`docs/TYPESCRIPT.md` states the rule: *every new file is TypeScript, `any` appears nowhere, and a legacy `.js`
file is converted when it is touched* (`:4`). The toolchain behind that rule exists and works. What does not exist
is an answer to "which file next", and three of the gates the page promises have a hole exactly the width of the
files that have been converted.

## What exists today

* **The toolchain, working.** `tsconfig.json:52` includes `engine/**/*.ts`, `scripts/**/*.ts`,
  `test/**/*.test.ts`; `allowJs: false` (`:50`) so legacy files are not dragged in; `erasableSyntaxOnly` and
  `noImplicitAny` on. The `Typecheck` job (`ci.yml:1631`) runs `tsc --noEmit` (`:1735`) and
  `check-no-any.ts` (`:1747`) on a provisioned 22.x runtime.
* **Two engine modules converted, both sound.** `engine/segment.ts` and `engine/link.ts`; the ledger in
  `docs/TYPESCRIPT.md:44-45` claims 236 and 243 lines and `wc -l` agrees today. `engine/index.js:5` and
  `engine/topology.js:4` require `./link.ts`, `engine/simulator.js:116` requires `./segment.ts` - the extension
  rule is being followed at every call site.
* **The resolver checker, and what it says right now.** `node scripts/check-module-paths.ts` resolves **1483
  specifiers in 553 files, 0 unresolvable**, and reports exactly **1 latent require**:
  `engine/segment.ts:118  require('./lag')  -> engine/lag.js today; it breaks when that file becomes .ts`
  (`check-module-paths.ts:584,642`). It is in `package.json:70` and in `scripts/premerge-check.js:134`.
* **The size of what is left.** 28 `.js` files in `engine/`, 30,324 lines, of which `cli.js` is 8,420 and
  `simulator.js` 4,809. `server/` has 4 `.js` files, `web/` 5.

## What is missing or weak, ranked

1. **`check-node-surface.js` does not read `.ts`.** `EXTS` is `.js`, `.mjs`, `.cjs` (`:25`), so both converted
   engine modules are outside the gate - while `docs/TYPESCRIPT.md:110` and the enforcement table at `:301` say
   that checker is what holds the Node 18 surface. Measured today: **0** banned needles in any `.ts` file, so the
   hole is empty and free to close.
2. **`check:module-paths` is a documented gate that CI never runs.** `docs/TYPESCRIPT.md:298` lists it beside
   `tsc` and `check-no-any`; the `Typecheck` job runs neither it nor anything that calls it, and the only caller
   is `scripts/premerge-check.js:134`, a local tool. So the single latent require above is visible only to
   whoever ran premerge by hand.
3. **No order, and the files are not equally convertible.** The rule is "when it is touched", so the next
   candidate is whoever happened to edit a file. Two of them will never be "touched" as one PR (`cli.js` 8,420
   lines), and one of them - `lag.js` - is already required by a converted file, so its conversion cannot be done
   without editing `segment.ts` in the same commit.
4. **The `include` list omits the trees people will write `.ts` into.** `server/**` and `web/**` are absent from
   `tsconfig.json:52`, and `test/**/*.test.ts` matches only test suites - so the first `server/x.ts` or
   `test/helper.ts` is checked by nothing, silently, and the rule "every new file is TypeScript" is what will
   create it.
5. **The ledger is hand-maintained.** `docs/TYPESCRIPT.md:38` says a file not in the table has not been converted
   "whatever its extension says" - an assertion no test can currently make true or false. Both rows are correct
   only because both authors remembered.

## Ordered steps

1. **Close #2488 (S).** No code: a PR or comment citing `ci.yml:283-310` and run 10054. The smoke job provisions
   v22.23.5 and asserts `v22.*|v23.*|v24.*` (`ci.yml:308-312`).
2. **`check-node-surface.js` scans `.ts` too (S).** One line at `:25`. The scanner is a text scan
   (`stripComments` + `indexOf`), so there is no parser to teach; measured 0 findings on today's `.ts` files, so
   it lands green. Keep the self-exemption at `:83`.
3. **Run `check:module-paths` in the `Typecheck` job (S).** A third step, 120 s timeout like `check-no-any`
   (`ci.yml:1747`). It exits 0 with the one latent require printed (`check-module-paths.ts:642`), so the job
   asserts *0 unresolvable* without a new policy, and the latent one becomes visible on every PR.
4. **Widen `tsconfig.json`'s `include` (S).** Add `server/**/*.ts`, `web/**/*.ts` and `test/**/*.ts`. Measured:
   no `.ts` exists outside the three current globs, so this is a green no-op that closes weakness 4 before the
   first file lands there.
5. **A test that reads the ledger (S).** `test/typescript-ledger.test.ts`: every `.ts` under `engine/` and
   `scripts/` has a row in `docs/TYPESCRIPT.md`'s table and the row's number equals `wc -l`. Assert on path and
   number, never on prose; a floor so an empty table cannot pass - the shape `test/doc-catalog-counts.test.js:79`
   already proves.
6. **Convert `engine/lag.js` next (M).** 542 lines, 7 engine importers and 5 suites
   (`test/lag-mode`, `lag-member-checks`, `lag-member-down`, `etherchannel-member-limit`,
   `brief-port-channel-row`, `channel-group-creating-receipt`). It is the only module a converted file already
   requires, so this conversion retires the tree's single latent require instead of creating one, and it retires
   the hand-written `memberSuspension()` type the ledger (`:52`) names as still JavaScript.

Left out on purpose: `cli.js` and `simulator.js` (both need a split first, and a split is its own plan); a `types/`
directory or any `.d.ts` (nothing needs one yet - `@types/node` covers the surface); putting `typecheck` inside
`npm test` (a runtime question, not a type one); any product surface.

## Risks and test strategy

Steps 2-5 are green-on-arrival *by measurement*, and that is the risk to check at review time rather than after:
re-run `check-node-surface.js`, `check-module-paths.ts`, `tsc --noEmit` and the ledger's two `wc -l` values on the
branch. The one way step 2 goes red later is a string literal containing `.with(` or `.toSorted(` in a `.ts` file -
the scanner strips comments, not strings. Step 6's risk is a missed importer: `check:module-paths` is the proof
the sweep is complete, `npm test` (the six lag suites) is the behaviour net, and `npm run typecheck` is the new
types. No step touches workflow behaviour except step 3, which only adds a check that passes today.
