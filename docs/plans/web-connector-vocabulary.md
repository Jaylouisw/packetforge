# Plan: the browser names every connector three times, and 240 models print "Connector unknown"

Status: forward plan, no code. Measured on `fac38e6f`, 2026-11-19. Closes **no** open issue — the queue is
#2193 (docker cache), #2192/#2150/#130 (device data), #2191/#2190 (CLI and trunk docs) and #1980 (changelog),
and none of them is about the browser. Scope: `web/connectors.js` (new), the three label tables in
`web/faceplate.js`, `web/canvas.js`, `web/app.js`, one widened guard, `docs/CONNECTORS.md:814`. No engine rule
changes verdict; step 6 is the only step that touches the wire payload and is labelled **needs Jay's approval**.

The engine knows 28 cages and gives each a name, a family and a label (`engine/media.js:339-405`). The browser
knows a subset, three times over, in three files that cannot import each other — and the guard that claims
otherwise cannot fail. On the panel this is visible: an Advantech ICR-3231, an LTE router, draws
`2× RJ45 · 2× Console · 1× Connector unknown` (`web/faceplate.js` `plan()`), and every Fibre Channel SAN in the
catalogue files its 32G ports under the heading **Other**, after the console.

## What exists today

| fact | evidence |
|---|---|
| the authority | `CAGES` `engine/media.js:339-405`, 28 entries, each `{ name, family, label }`; exported (`engine/media.js:1562`), documented as authoritative at `docs/CONNECTORS.md:26` and `:77` |
| three copies in the browser | `CAGE_INFO` 22 entries `web/faceplate.js:46-79`; `names` 18 entries `web/canvas.js:33-55`; `known` 18 entries `web/app.js:1953-1962` |
| and they disagree | only `usb` is spelt the same in all four places; `rj45` is "RJ45 copper" (engine, canvas), "RJ45" (faceplate, app); `qsfpdd` is "QSFP-DD cage (200/400G)" in one file and "QSFP-DD" in another |
| the same ten are missing from canvas **and** app | `qsfp56`, `sfp56`, `xfp`, `fc-sfp`, `fc-sfp28`, `fc-sfpdd`, `fc-qsfp28`, `cfp2`, `serial`, `wwan` — so the tooltip prints `wwan (wwan)` (`web/canvas.js:476`) and the inspector prints `FC-SFP28 (fc-sfp28)` (`web/app.js:2202`, `:3263`) |
| faceplate is missing nine and carries two dead keys | `rj11` and `mpo`: no serialized port can hold either — `connector: "rj11"` is aliased to `dsl` by `CAGE_ALIAS` (`engine/media.js:410`), and `mpo` is a *medium* connector (`:180`), never a cage |
| what that costs on the panel | 240 of 2,355 models, **649 ports**, draw a group labelled `Connector unknown`: `wwan` 279, `fc-sfp28` 144, `fc-sfpdd` 80, `fc-sfp` 72, `cfp2` 54, `fc-qsfp28` 8, `sfp56` 8, `qsfp56` 2, `xfp` 2 |
| and they are drawn last | `familyOf()` returns `'other'` for any cage absent from `CAGE_INFO` (`web/faceplate.js:144-151`), and `FAMILY_ORDER` puts `other` after `console` (`web/faceplate.js:76`) |
| the guard cannot fail | `test/faceplate-names-every-connector.test.js:146` fails on `g.cage === 'unknown'`, but `plan()` keys each group by the *resolved* cage (`web/faceplate.js:313-323`) — an unnameable `fc-sfp` group is `{cage:'fc-sfp', label:'Connector unknown'}` and never equals `'unknown'`; `:137` also restricts the check to ports whose type is `serial`/`console` |
| the engine already computes the answer | `derivePortHardware()` sets `cageName` (`engine/media.js:1066`) and validation prints it (`engine/validation.js:350`), but `Device.serialize()` drops it — the serialized interface carries `cage` and not `cageName` |
| the docs tell maintainers to edit both copies | `docs/CONNECTORS.md:814` — *"UI labels — update the copies"*, naming `web/canvas.js: cageLabel()` and `web/faceplate.js: CAGE_INFO` |

Related but out of scope: `docs/plans/catalogue-audit-agreement.md` makes the same argument about
`scripts/audit-devices.js` reading its own `OPTICAL_CAGES` literal. That one is engine-side and already planned;
this one is the browser's copy of the same vocabulary.

## What is missing or weak, ranked

1. **649 ports, 240 models, one wrong heading.** "Connector unknown" is the panel's answer for a cellular radio,
   a 32G Fibre Channel port and a CFP2 line card. Fixing this is a table, not a feature.
2. **Ten cages unknown in the tooltip and the inspector.** The same ten in two files, because the two files were
   written from the same eleven-entry list at different times.
3. **The guard is a false negative.** Its headline sentence is true of no run: it passes while 240 models fail it.
   Until this is fixed, every step below can regress silently.
4. **Fibre Channel is filed as "Other".** A Brocade G720's ports sort after the console port, under a heading that
   says the panel does not know what they are.
5. **Wording drift nobody can see in one place.** 27 of 28 cages are spelt differently in at least two files; a
   doc quote of any label has to name which file it means.
6. **Two dead keys.** `rj11` and `mpo` in `CAGE_INFO` describe ports that cannot reach it, which makes the table
   look more complete than it is.

## Steps

**1. One table, no behaviour change (S).** `web/connectors.js`, an IIFE publishing `window.PFConnectors` with the
28 ids from `CAGES`, `{ label, family, familyLabel, rank }` each, plus `label(id)` and `familyOf(id, iface)`.
Load it above `faceplate.js` in `web/index.html` (that tag is at `:138`); `serveStatic()` serves it with no server change.
Its label is the engine's `name` — the short form the faceplate already uses — so the long descriptive text
("RJ45 copper") stays in the engine's own `label` for `show` output. New `test/web-connector-table.test.js`
loads `engine/media.js` and `web/connectors.js` in a `vm` (the pattern is already in
`test/faceplate-names-every-connector.test.js:13-25`) and asserts the id sets are equal, all 28 present, and no
key outside the engine's 28. Purely additive: nothing reads it yet.

**2. The faceplate reads it (S).** Delete `CAGE_INFO`/`FAMILY_ORDER`/`FAMILY_LABEL` from `web/faceplate.js:46-90`
and take them from `PFConnectors`; keep the `cageLabel` and `FAMILY_ORDER` exports (`web/faceplate.js:775`) because
`test/faceplate.test.js:88-90` and the connector sweep read them. New mappings: `fc-*` → `fibre-channel`
(rendered after fibre, before console), `cfp2`/`xfp`/`sfp56`/`qsfp56` → `fibre`, `wwan` → `wireless`. This one
step removes the 649 wrong headings and moves FC ports out of "Other". Update the expected strings in
`test/faceplate.test.js:88-90` in the same PR.

**3. The canvas tooltip reads it (S).** Delete `cageLabel` from `web/canvas.js:32-56`, call
`PFConnectors.label()` at `:476`, keep the `+ ' (' + cage + ')'` shape so a socket still shows its id. Nothing
pins these strings today, so add the four assertions (`sfp+`, `fc-sfp28`, `wwan`, an unknown id) to the existing
canvas suite rather than a new file.

**4. The inspector reads it (S).** Delete the `known` map at `web/app.js:1953-1962`; keep the exported
`cageLabel` at `:3263` as a one-line forward to `PFConnectors.label()` so `test/ui-render.test.js:102-104`
keeps testing the inspector's real path (`rj45`, `sfp+`, and the fallback, which becomes the raw id rather than
`toUpperCase()` — update those three expectations).

**5. Widen the guard (S).** In `test/faceplate-names-every-connector.test.js:130-155`, fail on
`g.label === 'Connector unknown'` for **every** port instead of `g.cage === 'unknown'` for serial/console only,
and assert the panel's cage vocabulary equals the engine's 28. This is the step that makes steps 2-4 stick, and
it should be reviewed first if the queue is short of work.

**6. Stop copying at all — needs Jay's approval (M).** `Device.serialize()` (`engine/device.js`, interface
serialization near `:1506`) omits `cageName` and `family` that `derivePortHardware()` already computes
(`engine/media.js:1066`); add both to the serialized interface and let the browser fall back to
`PFConnectors` only when the payload has no `cageName`. This is a payload change, so it needs a look at
`test/api-*.test.js`/snapshot consumers before it is scheduled; the browser can stay on step 1-5 indefinitely.

**7. Docs (S).** Rewrite `docs/CONNECTORS.md:814` to say *one* file — `web/connectors.js` — and that the test at
`test/web-connector-table.test.js` enforces it. `docs/ARCHITECTURE.md:403` says `web/` is "four files", which is
six today and seven after step 1; correct it in the same PR (the count itself belongs to
`docs/plans/doc-counts.md`, so change only this sentence).

## Risks

- **Labels are visible.** Any wording change lands in screenshots, `docs/*.md` quotes and the two test files above;
  keep the chosen text = the engine's `name` so there is one answer to quote.
- **Panel order changes.** Moving `wwan` to `wireless` and `fc-*` to a new family reorders sections, which
  `test/faceplate-clipping.test.js` (row widths) and `test/faceplate.test.js` (first-fibre socket index) may pin
  by position. Run both before merging step 2.
- **Script order.** `index.html` loads `faceplate.js`, `canvas.js`, `app.js` in that order (`web/index.html:138-140`); a table
  loaded last makes every caller fall back silently, which is exactly the failure mode this plan removes. The
  table test should also assert `index.html` loads it before the three consumers.
- **Step 6 is a payload change.** A client that reads `cageName` must still render for an older server document,
  so the fallback stays until the field is in a release.

## Test strategy

- `test/web-connector-table.test.js` (new): id-set equality with `engine/media.js` `CAGES`, all 28 present, no
  extras, `index.html` order.
- `test/faceplate-names-every-connector.test.js` (widened): sweep all 2,355 models, no group labelled
  `Connector unknown`, no empty heading, and the cage vocabulary equals the engine's.
- `test/faceplate.test.js`, `test/ui-render.test.js`: expected strings updated in the PR that changes them, not
  afterwards.
- Two named regressions, asserted as HTML: `devices/advantech/icr-3231.json` reads
  `2× RJ45 · 2× Console · 1× Cellular`; a Brocade G720 draws its `fc-sfp28` group under Fibre, before Console.

Sizes: steps 1-5 and 7 are **S**; step 6 is **M**.
