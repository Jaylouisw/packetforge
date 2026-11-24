# Plan: a PoE budget is one number, and four boxes carry somebody else's

Status: forward plan; steps 1, 2 and 4 are **landed** (2026-11-24) - the audit is importable, carries a
`passthrough` and a `misdeclared` cohort pinned by `test/poe-budget-gate.test.js`, and the two remaining
silent PSEs now declare `passthrough`, so `--strict` exits 0 and step 3 is unblocked. Steps 3 and 5-7 are
open. Re-measured 2026-11-24 on `8bc5fbe5`. Closes **no** open issue — the
open queue is one build item (#2477), which carries its own PR. Scope:
`scripts/audit-poe-budget.js`, `engine/device.js:217-223`, `engine/cli.js:6440`, `web/app.js:2081`,
`package.json:11`, `docs/DEVICE_SCHEMA.md`, four device specs, one new suite. No allocation rule
changes a verdict.

## What changed since the last revision (2026-11-18, `bf587889`)

The promotion campaign this plan deferred to (#2012, closed) did its job. `node
scripts/audit-poe-budget.js` reported **128 silent / 39 prose / 20 name-inferred / 16 unknown** then,
and reports **4 / 0 / 0 / 26** now:

```
Models: 2352, of which 408 source PoE on at least one port
Silent: 4   ubiquiti/UDB-Pro, planet/POE-E201, ubiquiti/F-POE-G2, ubiquiti/UACC-LR-Endpoint
Inferred from the model name: 0
Marked unknown on purpose: 26
Budget with no PSE port: 0
```

**Then #2475 landed one minute after this revision did.** `fs/AP-T565` was never a passthrough box: it
was an indoor AP's datasheet mis-filed as the outdoor T565, giving the model five copper jacks and a
PoE+ PSE on `eth4`. The correct datasheet has one RJ45 inlet at 802.3af and one SFP cage, no PSE at
all, so the cohort is four, not five, and the PSE count is 408. Counts in this page are the ones the
audit printed on `5415d70d`.

**2026-11-23, one increment later: `planet/POE-E201` leaves this cohort, and not through `passthrough`.**
PLANET prints a figure for its own jack - `PoE Power | "PoE Out" Port: 44~52V DC, max. 26 watts`
(https://www.planet.com.tw/storage/products/49453/C-POE-E201v2_L.pdf, read 2026-11-23) - which is
exactly step 2's other branch: `poe.budgetW: 26`, and the jack ceiling replaced the 802.3at class
figure (30 W) the row had shipped with. `test/planet-poe-e201-budget.test.js` pins it, including the
contradiction: the product page's own `PoE Output at maximum 36 watts` cannot be true against a
30.8 W input maximum, so it is recorded in the spec's `poe.note` and not modelled. **Silent is now
3** - ubiquiti/UDB-Pro, ubiquiti/F-POE-G2, ubiquiti/UACC-LR-Endpoint - and all three really do carry
somebody else's watts, which is the state this plan exists to add.

That inverts the ordering. The gate (old step 9) waited on "silent reaches 0", and silent cannot reach
0: every one of the three remaining devices is a **passthrough** box, and the audit has no word for
one. The field work is no longer the blocker — a missing state is.

## Landed 2026-11-24: the audit is askable, and it has a word for a passthrough

`scripts/audit-poe-budget.js` now ends `module.exports = { auditPoeBudget, main }` and guards the run
behind `require.main === module`, so a suite can call it. `passthrough` is a cohort fed by
`spec.poe.passthrough === true`, printed on its own line and excluded from `silent` and from the
`--strict` failure count.

One cohort was added that this plan did not name. A `passthrough` flag is a label, and the plan's own
risk list says a label is a way to silence an audit unless something stops it being used as one, so a
flag that sits beside a `budgetW`, or on a box with no PSE port, lands in **`misdeclared`** and fails
`--strict` exactly like a silent one. `test/poe-budget-gate.test.js` pins all five shapes plus one
internal-consistency check on the real catalogue (no device in two cohorts) and the exit-code
agreement; 18 assertions, green.

Measured on the merged catalogue that day: 2,352 models, 408 sourcing, **silent 3** (ubiquiti/UDB-Pro,
ubiquiti/F-POE-G2, ubiquiti/UACC-LR-Endpoint), unknown 26, passthrough 0, misdeclared 0.
`--strict` therefore still **exits 1** - step 3 (the `package.json` gate) cannot land until step 2 has
marked the three Ubiquiti boxes, because a gate that is red on arrival teaches people to ignore it.
No spec set the flag on the day that landed, which is why step 5's documentation could follow rather than
block; the second increment below is what puts it in two files, and makes step 5 the next thing owed.

## Landed 2026-11-24, second increment: both remaining boxes say where their watts come from

`#2501` gave the audit the word; this spends it. The two silent PSEs that were left are now
`poe.passthrough: true`, each decided against a page read the same day, and **silent is 0**:

```
Models: 2352, of which 408 source PoE on at least one port
Silent: 0
Inferred from the model name: 0
Marked unknown on purpose: 26
Passthrough: 2   ubiquiti/UDB-Pro (1 PSE), ubiquiti/F-POE-G2 (1 PSE)
Contradictory passthrough declarations: 0
Budget with no PSE port: 0
```

`node scripts/audit-poe-budget.js --strict` now **exits 0** on the real catalogue, which is exactly what
step 3 was waiting for.

**`ubiquiti/UDB-Pro`** (`devices/ubiquiti/udb-pro.json`). The passive output on `eth1` has no supply of
its own: Ubiquiti's table reads `Power Method: PoE / PoE+ (Required for PoE output)` and
`Management: (1) PoE in (PoE output not used) / (1) Passive PoE output`
(https://techspecs.ui.com/unifi/wifi/udb-pro, HTTP 200, 628,754 B, read 2026-11-24). No wattage is printed
for the output port - the page's two figures are the included `48V, 0.32A` adapter (15.4 W **into** the
box) and `Max. Power Consumption: 9W` - so a `budgetW` would be a subtraction nobody published. This page
does not use the word "passthrough"; the requirement that the output be powered from a PoE+ input is what
makes it one, and that is the line quoted in the spec's `poe.note`.

**`ubiquiti/F-POE-G2`** (`devices/ubiquiti/f-poe-g2.json`). Here the vendor does use the word:
`Power Method: ... 4-pair (24V DC/50V DC input) passthrough / PoE RJ45 port ... PoE passthrough`
(https://techspecs.ui.com/uisp/fiber/optical-data-transport-for-outdoor-poe-devices, HTTP 200, 587,458 B,
read 2026-11-24). Its power figures are all inputs or its own draw - `Input DC voltage: 16-57V`,
`Power Consumption: 1.5W (Typical)`, `DC Output: Terminal block, 24V DC/50V DC, 2-wire` - and none is a
PSE ceiling. **The `sourceUrl` was also broken**: it ended at `...outdoor-poe-d`, which 307s to the
techspecs home page with no product on it, so the file had been citing a page that describes nothing; the
path with the slug intact is now what both `sourceUrl` and `poe.sourceUrl` carry.

The other two boxes step 2 named had already left the cohort through their own sheets rather than the flag:
`planet/POE-E201` by `budgetW: 26` (#2487) and `ubiquiti/UACC-LR-Endpoint` by `budgetW: 60` (#2495),
because both vendors print a figure for the outlet. `passthrough` is the answer only where nobody does.

What the flag does **not** do: the engine still serves 0 W on those ports - no allocation rule reads
`passthrough` and `engine/device.js` is untouched - so a camera behind a UDB-Pro is still refused. The
word buys an honest audit line and a gate that can go green; step 5's definition and the `misdeclared`
cohort are what stop it becoming an escape hatch.

## What exists today

**The ladder, and the hole in it.** `engine/device.js:217-223` resolves `poeBudget` four ways —
`spec.poeBudget` (`spec`), `spec.poe.budgetW` (`research`), `spec.poe.budgetUnknown` (`unknown`, 0),
else `mediaLib.parsePoeBudget(spec.model)` (`name`) — and keeps `poeBudgetSource` beside it. A `name`
budget is discarded when the device has no PSE port (`:311-316`). There is no fifth branch for "this
port sources power that arrived from upstream", and `grep -rn passthrough engine/ docs/DEVICE_SCHEMA.md`
returns nothing.

**The three that remain, and the documents that say so.** (The fourth, `planet/POE-E201`, now carries `poe.budgetW: 26` from its own sheet.) Each has one `poeOut` port and `poe: null`:
`planet/POE-E201` — its own description says it "passes the PSE's negotiated power through ... rather
than creating a new budget"; `ubiquiti/F-POE-G2` — "optical-to-PoE transport ... 16-57V DC in";
`ubiquiti/UACC-LR-Endpoint` — "PoE+++ input with passthrough up to PoE++"; `ubiquiti/UDB-Pro` — "PoE
input with passive PoE output". These are not unsourced figures: all four resolve through the name
parser, find nothing, and land at 0 W — boxes whose budget belongs to a device upstream of them.

**The audit cannot be asked.** `scripts/audit-poe-budget.js:120` is a bare `process.exit(main())` — no
`require.main` guard, no export — so no suite can call it, and it appears in neither
`package.json:11` (`audit-port-types && audit-devices && check-control-bytes && run-tests`) nor any
workflow. `--strict` already exits 1 on silent or orphan (`:117`); nothing runs it.

**A budget that is a function of powering.** `devices/ubiquiti/usw-ultra.json` stores `budgetW: 42`
and puts "16 W if only PoE+ is available" in `poe.note`; `ecs-24-poe.json` stores `1050` and puts
450 / 2,250 / 1,850 W in the note. `USW-Ultra-60W` and `USW-Ultra-210W` are separate files with the
same chassis note. **337 specs carry `poe.note`; a two-wattages-plus-a-condition-word regex matches
109** (an upper bound: notes also list per-port ceilings). Nothing in `engine/`, `devices/registry.js`
or `web/` reads `poe.note` — the only reader is a human.

**Provenance never reaches an operator.** `poeBudgetSource` is read at `device.js:311` and in the
audit; `show power inline` opens with `Available:... Used:... Remaining:...` (`engine/cli.js:6440`)
and names no source, so a research figure, a name-parsed guess and an explicit "unknown" print alike.
The browser panel keeps its own copy of the rule (`web/app.js:2081-2097`, keyed on the scalar,
returning `unknown: true` at 0), held to the engine only by `test/poe-agreement.test.js`.

**`budgetW` is undocumented.** `docs/DEVICE_SCHEMA.md` documents `poeIn` (`:208`) and the
`poe-pse` / `poe-pd` capabilities (`:92-93`); `grep -n budget docs/DEVICE_SCHEMA.md` matches only a
sample description. `CONTRIBUTING.md` says nothing either.

## What is missing, ranked

1. **A state for a budget that is upstream.** Without it the silent cohort has a floor of 4, so the
   gate cannot land and the audit keeps printing a number nobody can act on.
2. **A callable audit.** The premise of a gate — run this and trust the exit code — is untestable
   while the script cannot be imported.
3. **A budget that depends on the power input**, in a field that holds one number (USW-Ultra 42 vs
   202, ECS-24-PoE 1,050 vs 2,250).
4. **Provenance at the point of use.** 0 name-inferred today, but 26 explicit-unknown and 378 research
   figures are indistinguishable on screen.

## Ordered steps

1. **S — Make the audit askable, and give it the fifth state.** **[LANDED 2026-11-24]** Guard `main()` behind
   `require.main === module`; export `auditPoeBudget(cat)`; add a `passthrough` cohort fed by
   `spec.poe.passthrough === true`, printed on its own line and **excluded from `silent` and from the
   `--strict` failure count**. Flags, existing cohorts and exit codes unchanged; the four current
   silent specs keep printing until step 2.
2. **S — Mark the four, one PR per vendor.** **[LANDED 2026-11-24]** Set `poe.passthrough: true` where the page says the watts
   arrive from upstream (POE-E201, F-POE-G2, UACC-LR-Endpoint, UDB-Pro), citing the line in `notes`. Where a vendor does publish a figure for the port, that becomes `budgetW` instead — decided
   per file. After this, `--strict` exits 0 on the real catalogue: measured 0 silent / 2 passthrough.
3. **S — Gate it.** `node scripts/audit-poe-budget.js --strict` into `package.json:11`, after
   `audit-devices`. The collision this plan used to warn about is gone: `audit-devices` landed in that
   line with #2301, so this is the only edit there.
4. **S — Prove the gate can fail.** **[LANDED 2026-11-24]** `test/poe-budget-gate.test.js`: call the export on three fixtures —
   a silent PSE (fails), a `budgetUnknown` one (passes), a `passthrough` one (passes, counted) — and
   assert the cohort names, not just the exit code.
5. **S — Document the field.** `docs/DEVICE_SCHEMA.md`: the resolution ladder, what `budgetUnknown`
   means, what `passthrough` means, and that a conditional budget does not belong in a note.
6. **M — `poe.budgetVariants` — needs Jay's approval.** `[{ when, budgetW, sourceUrl? }]` beside
   `budgetW`; `Device` exposes the array and still resolves `poeBudget` from `budgetW`. Data-only: no
   default changes, no picker. Start with the USW-Ultra triplet and ECS-24-PoE.
7. **S — Say where the number came from.** One provenance clause on the summary line of
   `show power inline` (`engine/cli.js:6440`) and the same field through `poeSummary`
   (`web/app.js:2081`), with a variant-bearing case added to `test/poe-agreement.test.js` so the two
   cannot drift.

## Risks

- **`passthrough` is a label, not an allocation.** The engine still serves 0 W on those ports; a lab
  chaining two extenders still sees the downstream port dead. The word buys an honest audit line, not
  working power. A PR body claiming otherwise is the failure mode.
- **A permissive fifth state is a way to silence the audit.** Anything can be called passthrough. Step
  4 fixtures and the step 5 definition are what keep it a fact about a port rather than an escape.
- **Counts rot fast** — 128 to 4 in five days, and the fifth went away inside the minute between
  #2473 and #2475, for a reason that was not a budget at all. Every PR quotes the audit output it
  produced.
- **Variants invite a picker.** Nothing here lets an operator choose an input; making them selectable
  is new product surface and out of scope.

## Test strategy

New `test/poe-budget-gate.test.js` (step 4). Regression: `test/poe.test.js`,
`test/poe-inference.test.js` (the name parser), `test/poe-agreement.test.js` (engine vs panel),
`test/show-power-inline.test.js`, `test/hardware-invariants.test.js` (the orphan direction), then
`npm test` — 466 suites and 43 `test:*` scripts as of this commit. Every PR body records
`node scripts/audit-poe-budget.js` before and after.

## Issues this would close

None. #2012 is closed and its cohort is drained; #130 is closed. The only open issue is the build item
#2477, which carries its own PR.

## Deliberately left out

Per-port negotiation (LLDP 802.3at class exchange, `power inline auto`) — the engine does not model it
and it is far larger than a data field. The `poe-pse` / `poe-pd` vocabulary split, owned by
`docs/plans/capability-vocabulary.md`. The passive-PoE `poeOutClass` census, which landed in #2454.
The template ports with no declared connector, owned by `docs/plans/catalogue-audit-agreement.md`.
