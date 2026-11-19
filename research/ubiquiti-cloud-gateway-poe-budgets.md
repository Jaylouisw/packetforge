# Four cloud-gateway rows sourced PoE and carried no budget the vendor publishes

The open device request #130 is for a **Dream Wall Pro**, which Ubiquiti does not sell and has
never published ports for (see `research/ubiquiti-udw-pro-absent-from-vendor-catalogue.md` and the
sixteen comments on the issue). What that request stands in is the UniFi **cloud-gateway family**,
and reading the family's PoE rows on 2026-11-19 turned up a defect that has nothing to do with the
Pro: four rows declare `poe-pse` and carry `poeOut` ports while publishing **no `poe.budgetW`**,
even though the vendor prints a budget for every one of them.

## Why a missing budget is not cosmetic

`engine/simulator.js` opens its allocator with `if (!dev.poeBudget) continue;`. A PSE with a zero
budget is not a PSE with an unknown budget - it is skipped, so nothing on that box can be powered,
`show power inline` has no allocation to report, and a lab that cables a phone into the Dream
Router gets a dead port. That is the same shape `scripts/audit-poe-budget.js` was written for: it
reported **112 of 402 PSEs** that cannot be asked how much they can supply before this pass and
**108** after it.

## What the vendor publishes, row by row

Read from each product's rendered spec table on `techspecs.ui.com` (the page's own
`__NEXT_DATA__` -> `props.pageProps.product.technicalSpecification`, i.e. the table a reader sees,
not a scraped sentence), 2026-11-19.

| model | page bytes | "PoE Budget" as printed | PSE ports as printed | catalogue before |
|---|---|---|---|---|
| UDR | 685,730 | `40W` | `1 GbE RJ45 = 5 (2 PoE)`; `PoE = 15.4W`; `44-57V` | poe-pse, 2 `poeOut`, **no budget** |
| UDR7 | 694,473 | `15.4W` | `2.5 GbE RJ45 = 4 (1 PoE)`; `PoE = 15.4W`; `44-57V` | poe-pse, 1 `poeOut`, **no budget** |
| UDM-SE | 682,201 | `180W` | `8` copper; `PoE = 15.4W`, `PoE+ = 30W` | poe-pse, 8 `poeOut`, **no budget**, **no `sourceUrl` at all** |
| UCG-Industrial | 699,330 | `DC input: 270W` / `ATX power: 75W` | `2.5 GbE RJ45 = 4 (2 PoE+++, 2 PoE+)`, `10 GbE RJ45 = 1 (PoE+++)`; `PoE+ = 30W`, `PoE+++ = 90W` | poe-pse, 5 `poeOut`, **no budget** |
| UCG-Fiber | 667,145 | `30W` | **no interface row marks a port PoE** | no `poeOut`, no `poe-pse` - left alone |
| UDW | 704,702 | `420W` | `1 GbE RJ45 = 17 (4 PoE++; 4 PoE+; 4 PoE)` | 420 W, modelled |
| UDR-5G-Max | - | `15.4W` | `2.5 GbE RJ45 = 4 (1 PoE)` | 15.4 W, modelled 2026-11-19 |
| EF-Core, EFG, UCG-Max, UCG-Ultra, UDM, UDM-Pro, UDM-Pro-Max, UDM-Beast, UX, UX7 | - | none printed | no PoE row | no PSE, nothing to add |

Two of these were cross-read against the box's own datasheet text layer, so the budget is not
resting on one surface:

- `https://dl.ui.com/ds/udr_ds.pdf` - HTTP 200, 771,202 B, 3 pp. Prints `PoE budget 40W`,
  `PoE interface (2) PoE (Pair B 4, 5+; 7, 8-)`, `Max. PoE wattage per port by PSE 15.4W`,
  `Voltage range PoE mode 44-57V DC`, beside `Networking interface LAN: (4) GbE RJ45 ports`.
- `https://dl.ui.com/ds/udm_se_ds.pdf` - HTTP 200, 358,669 B, 3 pp. Prints
  `PoE interface (6) PoE (Pair A 1, 2+; 3, 6-)` / `(2) PoE+` and
  `Max. PoE wattage per port by PSE PoE: 15.4W / PoE+: 30W` - **but no aggregate budget**. The
  180 W exists on the tech-spec page only, so the two figures are cited to two different vendor
  documents rather than one table answering itself.

## What was written

| file | added |
|---|---|
| `devices/ubiquiti/udr.json` | `poe.budgetW = 40`, sourced to `dl.ui.com/ds/udr_ds.pdf`; top-level `sourceUrl` moved to that datasheet |
| `devices/ubiquiti/udr7.json` | `poe.budgetW = 15.4`, sourced to the tech-spec page (this model's document list holds only `https://ui.com/qig/udr7`, an installation guide, so there is no datasheet to cite) |
| `devices/ubiquiti/udm-se.json` | `poe.budgetW = 180` **and the row's first `sourceUrl`** - the file had no provenance field at all |
| `devices/ubiquiti/ucg-industrial.json` | `poe.budgetW = 270`, the DC-input ceiling, with the ATX figure (75 W) and the per-input conditionality in `poe.note`; same convention as `devices/allied-telesis/at-x530dp-28ghxm.json` |

No per-port wattage was added: each PSE port already carries its `poeOutClass` (`PoE`, `PoE+`,
`PoE++`, `PoE+++`), and the only single-number field the schema has (`poe.perPortW`) cannot state a
mixed-class box - UDM-SE is 6 PoE at 15.4 W plus 2 PoE+ at 30 W. On UCG-Industrial the arithmetic
is worth recording: 3 x 90 W + 2 x 30 W is 330 W against a 270 W budget, so the budget is what stops
a full-power fill; it is not a sum of the ports and the row must not be "corrected" to one.

## What was deliberately left, and the exact missing field

**UCG-Fiber** publishes `PoE Budget = 30W` on the same table and marks **no** port PoE in it
(`2.5 GbE RJ45 = 4`, `10 GbE RJ45 = 1`, no parenthetical class anywhere). Its document list holds
only `{"type":"InstallationGuide","url":"https://ui.com/qig/ucg-fiber"}` - no datasheet - and the
guessed datasheet slugs (`dl.ui.com/ds/ucg-fiber.pdf`, `ucg-fiber_ds.pdf`, `ucgf_ds.pdf`) all
answer 302 to the techspecs root. Writing `poe.budgetW` with no `poeOut` port would create exactly
the condition `scripts/audit-poe-budget.js` refuses (`Budget with no PSE port`), and writing
`poeOut` on a port the vendor has not marked would be an invented field. The missing fact is
precise: **which of the five RJ45 ports on the UCG-Fiber source PoE, and at which class**. One
Ubiquiti datasheet or spec row that says so unblocks it.

## Method notes worth keeping

- The per-port maximum is **not** in a `Max. PoE Wattage per Port by PSE` feature on these pages -
  that feature exists but has no value on all five products read here. The classes are separate
  features (`PoE`, `PoE+`, `PoE++`, `PoE+++`) each carrying a wattage, so a pass that looks only
  for the per-port field concludes the vendor published nothing.
- A product's `datasheet` field is `null` even when a datasheet exists; the document list
  (`product.documents`) is the reliable pointer (UDR -> `dl.ui.com/ds/udr_ds.pdf`,
  UDM-SE -> `dl.ui.com/ds/udm_se_ds.pdf`).
- UDM-SE carried no `sourceUrl`, so every field in that row was untraceable - the provenance gap
  and the budget gap were in the same file.
