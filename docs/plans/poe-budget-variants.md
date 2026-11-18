# Plan: a PoE budget that depends on how the box is powered, in a field that holds one number

Status: forward plan, no code. Measured on `bf587889`, 2026-11-18. Closes **no** open issue — the
queue is empty (0 issues, 3 open PRs: #1980, #2011, #2012). Scope: `engine/device.js:186-195`,
`engine/simulator.js:2547-2553`, `engine/cli.js:5179-5305`, `web/app.js:2039-2076`,
`scripts/audit-poe-budget.js`, `devices/ubiquiti/usw-ultra*.json`, `devices/ubiquiti/ecs-24-poe.json`,
one new suite, `CONTRIBUTING.md`. No engine rule changes a verdict.

## What exists today

**One scalar, five sources.** `engine/device.js:189-194` resolves `this.poeBudget` in a fixed order —
`spec.poeBudget` (`spec`), `spec.poe.budgetW` (`research`), `spec.poe.budgetUnknown` (`unknown`, 0),
else `mediaLib.parsePoeBudget(spec.model)` (`name`) — and keeps `this.poeBudgetSource` beside it. A
`name` budget is discarded when the device has no PSE port (`:276-283`). 237 specs carry
`poe.budgetW`; 401 models source PoE on at least one port (`node scripts/audit-poe-budget.js`).

**The census, and its own drift.** `research/poe-budget-field-census.md:16` records 129 silent, 40 of
them quoting a figure in prose, 20 name-inferred, 16 explicitly unknown, 0 orphan. Today's run of the
same script says **128 silent / 39 prose / 20 inferred / 16 unknown / 0 orphan** — `#2010` promoted
the Pro XG 8 PoE and nobody updated the doc. The counts are the finding, and they rot within a day.

**Where the conditionality went.** Ubiquiti publishes PoE availability as a function of the power
input, not as a number. `devices/ubiquiti/usw-ultra.json:124` stores `budgetW: 42` and `:125` puts the
other four rows in a `note` string — "PoE++ input 42 W, PoE+ input 16 W, 60 W AC adapter 52 W, 210 W
AC adapter 202 W". `devices/ubiquiti/ecs-24-poe.json:385-386` does the same for a 1,050 W figure only
reachable with two 600 W modules in shared mode, and writes the 1,200 W-module rows into the note too.
`USW-Ultra-60W` and `USW-Ultra-210W` are separate files carrying the identical note, because the field
cannot express "same chassis, different powering".

**Nothing reads the note.** 209 specs carry `poe.note`; a regex over those notes finds 16 whose wording
makes the budget a function of configuration. `grep` finds no consumer of `spec.poe.note` anywhere in
`engine/`, `devices/registry.js` or `web/`. The only reader of the words is a human.

**Provenance never reaches an operator.** `poeBudgetSource` is written at `device.js:194` and read in
exactly two places: the name-fallback guard at `:276` and the audit at
`scripts/audit-poe-budget.js:83-84`. The total line of `show power inline` (`engine/cli.js:5285`)
prints "Total: X W of Y W in use, Z W left" with no source, so the 20 name-inferred budgets —
including `ubiquiti/ES-48-500W`, where 500 W is the PSU rating — print exactly like a sourced figure.

**Silence is invisible twice.** `computePoe()` opens with `if (!dev.poeBudget) continue;`
(`engine/simulator.js:2553`), so the 128 silent PSEs never enter the table, and `show power inline`
falls through to "budget not modelled on `<dev>`: the ports are reported, the power they could supply
is not" (`engine/cli.js:5222-5223`). The browser panel has its own copy of the rule
(`web/app.js:2039-2076`), keyed on the same scalar and returning `unknown: true` at 0.

**The audit cannot be asked, and is not gated.** `scripts/audit-poe-budget.js:120` is a bare
`process.exit(main())` with no `require.main` guard, so no test can call it; and it appears in neither
`package.json:11` (`audit-port-types && check-control-bytes && run-tests`) nor any workflow under
`.forgejo/workflows/`. `poe.budgetW` itself is documented in neither `CONTRIBUTING.md` nor `docs/` —
`grep -rn budgetW CONTRIBUTING.md docs/` returns nothing.

## What is missing, ranked

1. **A field for a budget that is a function of configuration.** One number per chassis means a lab
   powering a USW-Ultra from the 210 W adapter is capped at 42 W — a 4.8x under-power the engine
   reports as arithmetic, not as a guess, because `budgetSource` is `research`.
2. **Provenance at the point of use.** 20 budgets derived from a model name are indistinguishable
   from sourced ones in every surface an operator sees.
3. **The census cannot tell conditional from flat**, so the promotion campaign now in flight (#2012,
   sourcing 16 prose figures) can lock in whichever row the description happened to quote.
4. **128 PSEs the engine refuses to arithmetic**, in a file nothing invokes and no test can call.

## Ordered steps

1. **S — Make the audit askable, and make it count conditionality.** Guard `main()` behind
   `require.main === module`, export `auditPoeBudget(cat)`, and add a fifth cohort: specs whose
   `poe.note` or description names two or more distinct totals alongside a condition word, where the
   stored `budgetW` is one of them. Output and exit code for existing flags must be unchanged
   (`128 of 401 PSEs cannot be asked...`). Same shape as `docs/plans/catalogue-audit-agreement.md`
   step 1, different file — the two can land in either order.
2. **S — `poe.budgetVariants` (needs Jay's approval).** An array of `{ when, budgetW, sourceUrl? }`
   beside `budgetW`; `Device` exposes `poeBudgetVariants` and keeps resolving `poeBudget` from
   `budgetW` exactly as today. Data-only addition: no allocation, no verdict, no default change. The
   audit from step 1 stops counting a variant-bearing spec as silent.
3. **S — Say where the number came from.** `show power inline` (`engine/cli.js:5285`) gains a
   provenance line: the source, and when variants exist, the condition in force and the ceiling the
   others would allow ("42 W in use of 42 W (PoE++ input); 202 W if powered by the 210 W adapter").
   Wording only — the answer to "is this port powered" must not change.
4. **S — Carry the panel too.** `web/app.js:2039` must read the same source and variants through
   `poeSummary`, or `test/poe-agreement.test.js` should fail on a variant-bearing device. This is the
   #1293 defect class: two implementations of one rule drifting apart, already caught once on a
   shut-down port.
5. **S — Move the conditional notes onto the field**, beginning with the USW-Ultra triplet and
   ECS-24-PoE, and assert in the suite that each file's `budgetW` equals the variant its own model
   name or SKU names. `note` keeps the vendor quote; it stops being the only record.
6. **M — The 20 name-inferred, five per PR.** Each from the vendor's own page; `budgetUnknown: true`
   where the vendor publishes nothing (`ES-48-500W` is a PSU rating read as a PSE ceiling). Not
   covered by #2012, which is the prose-silent cohort.
7. **S — The models that claim PoE and resolve to 0 while quoting a figure**:
   `moxa/EDS-G4012-8P-4QGS-LVB-T` (802.3bt, up to 90 W per port, no `poe` block),
   `ubiquiti/UA-Hub` ("45 W aggregate"), `ubiquiti/USW-Flex` ("60 W PoE budget"). Three files, three
   sources, one PR each if the sources disagree.
8. **S — Document the field** in `CONTRIBUTING.md`'s device-schema section: the resolution ladder, what
   `budgetUnknown` means, and that a conditional budget belongs in `budgetVariants`, not a note. Until
   this lands, every future promotion re-derives the cohort rules from a script comment.
9. **S — Gate it, last.** `node scripts/audit-poe-budget.js --strict` into `package.json:11` once
   silent reaches 0. This is the one line `docs/plans/catalogue-audit-agreement.md` step 5 also edits —
   land them in sequence, not in parallel.

## Risks

- **Three copies of the allocation rule.** `engine/simulator.js:2553`, `web/app.js:2039` and
  `engine/cli.js:5290` each decide something about the budget. Step 2 must be additive to all three,
  or the console and the panel will disagree about which condition is in force.
- **A variant list invites a picker.** Nothing here lets an operator choose an input: `budgetW` stays
  the answer and the other rows are documentation the engine can print. Making them selectable is new
  product surface and is not in this plan.
- **The census numbers rot** (129 to 128 in under a day). Every PR body here should quote the audit
  output it produced, not the table in the census doc.
- **Promoting a conditional figure to `budgetW` looks like progress** and is the failure #2012 can
  introduce at scale. Step 1 exists to make it visible before step 6.

## Test strategy

New `test/poe-variants.test.js`: a fixture PSE with two variants resolves to `budgetW`, reports the
condition, and denies a draw only the larger variant would satisfy. Regression set:
`test/poe.test.js`, `test/poe-inference.test.js` (the name parser and its 20 live claims),
`test/poe-agreement.test.js` (engine vs panel, five cases and a budget sweep),
`test/show-power-inline.test.js`, `test/hardware-invariants.test.js` (the orphan direction), then
`npm test` — 344 suites as of #2003. Record `node scripts/audit-poe-budget.js` before and after in
every PR body; the cohort line is the evidence.

## Issues this would close

None. The queue is empty, and the device-request thread these models came from (#130) is already
closed. #2012 is in flight on the prose cohort and is deliberately not re-proposed here.

## Deliberately left out

The 39 prose promotions (#2012 owns them). Per-port power negotiation — LLDP 802.3at class exchange
and `power inline auto` arbitration — which the engine does not model at all and which is a far larger
change than a data field. The `poe-pse`/`poe-pd` capability vocabulary split, owned by
`docs/plans/capability-vocabulary.md`. The 2,968 template ports with no declared connector, owned by
`docs/plans/catalogue-audit-agreement.md`.
