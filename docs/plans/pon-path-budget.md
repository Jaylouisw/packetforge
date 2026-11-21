# Plan: the PON budget calls itself a whole-path verdict, and prices one cable

Status: forward plan, no code. Measured on `38df68c5`, 2026-11-21. Closes **no** open issue — the
queue holds one device request (#130, UDW-PRO) and nothing optical. Scope: `engine/validation.js:771-816`,
`engine/optical.js:29-35,76-82,99-176,310-319`, `engine/topology.js:687-713`, `server/index.js:1030-1053`,
`engine/cli.js:789-803,7738`, `docs/DEVICE_SCHEMA.md:28-37,203-211`, `scripts/audit-devices.js`, the
first 5 of the 40 `category: olt` specs, one new suite. No rule changes a non-PON verdict.

## What exists today

**A path calculator nobody calls with a path.** `optical.ponBudget()` (`engine/optical.js:99-176`) takes
`lengthM`, `splitters[]`, `ponClass`, `patchCordLossDb` and returns `{ok, budgetDb, lossDb, headroomDb,
breakdown}` — fibre by kilometre and wavelength (1310 nm 0.35 dB/km, 1490 nm 0.22, `:53-59`), splitter
loss per ratio (`:29-35`, worst case 1:8 = 10.8 dB, 1:64 = 21.0), two connector pairs at 0.3 dB (`:84`),
and the class budgets B+ 28 / C+ 32 / N1 29 (`:76-82`). The breakdown names every element, so a refusal
can say what ate the budget. The arithmetic is right; the input is not a path.

**The call site is one cable.** `engine/validation.js:771-816` runs inside `validateLink()`, so `lengthM`
is `inp.lengthM` for *this* cable (`:793`) and `ratios` is built from the two devices at *its* two ends
(`:782-790`). Two 24 km legs of one PON are therefore priced as two 19.8 dB spans of 8.2 dB spare each,
and the 48 km path through the same 1:8 splitter is 28.2 dB against a 28 dB budget — 0.2 dB over, with
no verdict anywhere saying so. `engine/validation.js:139` calls this "a whole-path verdict"; it is a
per-cable one, and the comment is the only place the path exists.

**The spare is computed and dropped.** `:807-814` keeps `Math.min(down.headroomDb, up.headroomDb)` and
uses it for one thing: a warning below 3 dB. Nothing stores it. `setLinkLength()` (`engine/topology.js:687-713`)
re-runs the same per-cable verdict when a length is edited, and the PATCH door hands the warnings back in
its response body (`server/index.js:1050-1053`) where the next request forgets them. After cabling, no
command and no API field can say how much a span has left.

**Two fields the budget reads are unchecked and undocumented.** `devices/registry.js` loads 2,352 specs.
`category: splitter` covers 21 of them, and **6 carry no `splitRatio` at all** — `FBT Splitter 1x2 SC/APC`,
`FS-FWDM-1310-1490`, `FHD-PLC1x81SCA`, `FHD-1U-PP-24LC`, `C6AP-S24FT1U`, `MEMS VOA 0-30dB LC/UPC`. The
loop at `validation.js:785` pushes a ratio only `if (… spec.splitRatio)`, so each of those splitters is
priced at **0 dB**. Measured: the FBT 1:2 (real part 4.1 dB, `catalogue/optics/odn.json`) on a 66 km leg
validates clean with only `W_DISTANCE`, at 23.7 dB / 4.3 dB spare; with its own loss it is 27.8 dB /
0.2 dB spare, and the `W_OPTICAL_HEADROOM` the model promises never fires. Separately, **0 of 2,352 specs
declare `ponClass`**, so `validation.js:791-792` always falls through to `'B+'` — an XGS-PON OLT is priced
against a GPON budget. Neither field appears in `docs/DEVICE_SCHEMA.md` (grep: no `splitRatio`, no
`ponClass`) and neither is checked by `scripts/audit-devices.js`, though `engine/device.js:164` and
`docs/ARCHITECTURE.md:1011` both state the budget depends on them.

**The console promises optics it does not print.** `engine/cli.js:803` answers `show interfaces <port>
transceiver` with "The cage and its optics are in `show interfaces <port>`". The block starts at
`cli.js:7738` with `pon1/1 (pon, 10G), MAC …` and prints status, address, switchport and counters — no
cage, no media, no optics. Verified on `adtran/SDX 6312-4`, whose `pon1/1` is `connector: sc-apc`.

**What is honest and should be left alone.** `optical.catalogueSplitterLossDb()` (`:310-319`) is read only
by `test/optics-catalogue.test.js:87`, which looks like dead wiring — it is not. The built-in table is
deliberately *pessimistic* (1:8 10.8 vs catalogue 10.5, 1:64 21.0 vs 20.5, per the comment at `:22-27`),
so shipping the catalogue's real figures would make verdicts more permissive. Leave it.

## What is missing, ranked

1. **A path verdict.** The budget is a sum over hops and every hop is judged alone, so a chain can pass
   cable by cable and fail end to end (24+24 km through one 1:8: 28.2 dB vs 28).
2. **A splitter with no ratio is a free splitter.** 6 of 21 splitter models contribute 0 dB instead of
   3.4-21 dB, and no suite notices: every optical fixture in `test/` cables `PON Splitter 1:x`
   (`test/pon-splitter.test.js:37`), the 6 models with legs, and never a ratio-less part.
3. **Every PON is class B+.** 339 PON-cage ports on 140 models, none declaring a class; a 10G XGS-PON OLT
   is priced against 28 dB instead of 29/31.
4. **The spare is unreachable after cabling** — one transient warning at connect time, and a length edit
   re-prices one cable, not the branch.
5. **`show interfaces <port>` prints no media at all**, while the refusal at `cli.js:803` says it does.
6. **7 splitters have one port** (`SP-11600S2S2CAAA`, `XSPSG00009/10/54`, `FHD-PLC1x81SCA`,
   `FHD-1U-PP-24LC`, `C6AP-S24FT1U`), so 4 of them carry a ratio that can only ever be charged on their
   single upstream cable: the ODN cannot be built as the part is drawn.

## Ordered steps

1. **S — Price the path.** Add `optical.ponPath(topo, oltDev, oltIf, {ponClass})` (or a walker in
   topology) that follows PON media from an OLT port across splitters to every reachable ONT, summing each
   hop's `lengthM` and collecting every splitter ratio **once per path**; call `ponBudget()` once per
   direction and emit the existing `E_OPTICAL_BUDGET` on the OLT-side cable with a path-shaped message
   ("OLT/pon1/1 <-> ONT/pon: 48.0 km through 1:8, upstream 28.2 dB exceeds B+ by 0.2 dB"). Keep the
   per-cable call as the answer for a PON link with no splitter on it, so every existing single-cable
   verdict is byte-identical. No new error code — `docs/plans/error-code-registry.md` owns that registry.
2. **S — The ratio that isn't there.** `splitterRatioOf(spec)`: `splitRatio`, else `/1\s*[x:]\s*(\d+)/`
   over `model` (`PON Splitter 1x8`, `FHD-PLC1x81SCA`), else `insertionLossDb.max` mapped to the nearest
   table row. When none resolves, refuse the PON cable with `E_SPLITTER_RATIO_UNKNOWN` naming the part —
   a 0 dB splitter is worse than a refusal, because it reads as a pass. Test: the FBT 1:2 at 66 km.
3. **S — Say the class.** Add `ponClass` to 5 of the 40 `category: olt` specs where the vendor publishes
   it (the XGS-PON models first — `ubiquiti/UISP-FIBER-OLT-XGS` is not a GPON B+ box), add `ponClass` and
   `splitRatio` as rows in `docs/DEVICE_SCHEMA.md:28-37` (spec fields, beside `fabric`), and add an
   `audit-devices.js` warning for a `splitter` with no resolvable ratio. Default stays `'B+'`, and step
   1's message must name the class it used. The other 35 OLTs follow one PR per vendor, not one PR.
4. **S — Give the spare a home.** Store the verdict on the link at connect/PATCH time
   (`link.optical = {class, down, up, spare}`), have `server/index.js:1053` return it, and have
   `setLinkLength` refresh it. One stored number, one source, so a reloaded board and a fresh cabling
   agree — the same defect class `docs/ARCHITECTURE.md:995-1015` already fixed for `splitRatio`.
5. **S — Print the media.** `show interfaces <port>` gains one line for a fibre port: cage from
   `spec.interfaces[].connector`, media and distance from the link, and for a PON port the class and spare.
   That makes `cli.js:803` true; if step 4 is deferred, change the sentence instead — one of the two must
   stop lying in the same PR.
6. **M — `show pon` (needs Jay's approval).** A path table worst-spare-first: OLT port, ONT count, km,
   ratios, class, down/up spare. New surface, and the only step here that is.

## Risks

- **Step 1 changes verdicts on boards that exist today.** Any lab cabled splitter-to-ONT at long lengths
  can start refusing. Land it with the path message naming the hop count, and put the before/after in the
  PR body; if it proves too sharp, ship the path check as a warning for one release — but do not ship it
  silently.
- **The walk must count each splitter once.** A splitter with two cabled legs appears on two cables;
  accumulating per cable double-charges 10.8 dB and turns passes into refusals.
- **`isPonCage` (`validation.js:778-780`) includes `lc-upc`/`lc-apc`**, which is how CWDM muxes and
  ordinary 10GBASE-LR get into a "PON" budget. Step 1's walk should traverse only `sc-apc`/`sc-upc`
  media; widening the cage list is a different plan.
- **Ratio-from-model is a guess.** `PON Splitter 1x32` has 32 legs, `FHD-PLC1x81SCA` has one port and
  none. Refusing (step 2) is safe; inferring a ratio from a name that disagrees with the port count is not
  — the audit warning in step 3 is the only thing allowed to infer.
- **A 1:64 fan-out is a 64-node walk** on every validate and every length PATCH; memoise on a topology
  revision counter or the board will feel it.

## Test strategy

New `test/pon-path-budget.test.js`: the 24+24 km / 1:8 fixture must fail end to end and pass per cable if
the walk is disabled; a 1:16 at 72 legs completes in one validate; a splitter on two paths is charged
once each; a PON cable with no splitter keeps its byte-identical message. Regression set:
`test/pon-splitter.test.js`, `test/hybrid-cord.test.js`, `test/hybrid-cord-use.test.js`,
`test/spec-survives-load.test.js` (its `pon()` helper at `:46-51` is the fixture step 1 will change),
`test/validation.test.js`, `test/property-validator.test.js`, `test/optics-catalogue.test.js`, then
`npm test`. Every PR body quotes the exact dB figures before and after, as above.

## Issues this would close

None. The only open issue is #130 (UDW-PRO device request), which is catalogue work, not budget work.

## Deliberately left out

Transceiver DOM and per-cage optics inventory (`show interfaces transceiver` stays a refusal — step 5
prints media, not photodiodes). Wavelength budgeting for CWDM/DWDM muxes, which `odnParts()` can describe
but nothing prices per channel. Splitter fan-out validation, i.e. making `SP-11600S2S2CAAA` grow 16 legs
or refusing a 1×2 modelled with one — that is catalogue work for `docs/plans/catalogue-audit-agreement.md`.
Re-pricing on topology load beyond the link field in step 4. Any use of the catalogue's measured splitter
loss in a verdict (see the note above: the built-in table is the conservative one, on purpose). PoE.
