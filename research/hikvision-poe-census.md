# Hikvision DS-3E PoE budgets, read off Hikvision's own datasheets

Measured 2026-11-20 06:5x UTC for the seven `devices/hikvision/ds-3e*.json` entries that
`scripts/audit-poe-budget.js` reported as "silent" (PoE out, no `poe.budgetW`). Three of the seven were
also **wrong in prose**, and in every case the wrong figure belonged to the `/M` build of the same
chassis. Every number below is printed by a Hikvision-hosted PDF; none is derived from the SKU suffix.

## What each datasheet prints

| spec | panel | `PoE Power Budget` | max power consumption | budget |
|---|---|---|---|---|
| `ds-3e0505hp-e` | 3x 1G PoE + 1x 1G Hi-PoE + 1x 1G uplink | **60 W** | 65 W (5 W idle) | 60 W |
| `ds-3e0505p-e` | 4x 1G PoE + 1x 1G uplink | **60 W** | 65 W (5 W idle) | 60 W |
| `ds-3e0510p-e` | 8x 1G PoE + 1x 1G RJ45 + 1x 1G SFP | **110 W** | 120 W (10 W idle) | 110 W |
| `ds-3e0518p-e` | 16x 1G PoE + 1x 1G RJ45 + 1x 1G SFP | **230 W** | 250 W (20 W idle) | 230 W |
| `ds-3e1105p-ei` | 4x 100M PoE + 1x 100M RJ45 | **60 W** | 65 W | 60 W |
| `ds-3e1318p-ei` | 16x 100M PoE + 2x 1G combo | **230 W** | 250 W (10 W idle) | 230 W |
| `ds-3e1326p-ei` | 24x 100M PoE + 2x 1G combo | **370 W** | 400 W | 370 W |

Sources (each recorded in the spec's `poe.sourceUrl` and top-level `sourceUrl`):

- 0505HP-E — `assets.hikvision.com/prd/public/all/doc/m000011310/DS-3E0505HP-E_Datasheet_20240315.pdf`
- 0505P-E — `assets.hikvision.com/prd/public/all/doc/m000008118/DS-3E0505P-E_Datasheet_20240308.pdf`
- 0510P-E — `assets.hikvision.com/prd/public/all/doc/m000008119/DS-3E0510P-E_Datasheet_20240308.pdf`
- 0518P-E — `hikvision.com/content/dam/hikvision/products/S000000001/S000000048/S000000068/S000000071/OFR000107/M000008120/Data_Sheet/DS-3E0518P-E_Datasheet_20240307.pdf`
- 1105P-EI — `hikvision.com/content/dam/hikvision/usa/data-sheet/DS-3E1105P-EI-DataSheet.pdf` (Hikvision USA, 2021)
- 1318P-EI — `hikvision.com/content/dam/hikvision/products/S000000001/S000000048/S000000068/S000005201/OFR011808/M000034940/Data_Sheet/DS-3E1318P-EI_Datasheet_20240428.pdf`
- 1326P-EI — `hikvision.com/content/dam/hikvision/products/S000000001/S000000048/S000000068/S000005201/OFR004644/M000034939/Data_Sheet/Datasheet-of-DS-1326P-EI-Smart-Managed-24-Port-100-Mbps-PoE-Switch_20200331.pdf`

## Three things worth not re-deriving

1. **`/M` builds share the chassis, not the supply.** Every wrong figure this pass corrected was an `/M`
   number sitting under the base part number: `DS-3E0510P-E/M` prints **58 W** (not the base model's
   110 W), `DS-3E1318P-EI/M` prints **130 W** and a *different panel* (1x 1G RJ45 + 1x 1G combo, not
   2x combo), `DS-3E0518P-E/M` prints **125 W**, `DS-3E0505P-E/M` **35 W**, `DS-3E1105P-EI/M` **45 W**.
   The 1318 entry had inherited both the /M budget and the /M uplink layout — the family-sibling error
   this catalogue has already corrected on UDM PoE, two i-MO console ports and three MA5801 uplinks.
2. **"Max. Power Consumption" is not the budget.** `ds-3e0505hp-e` was described as "65 W total" and
   `ds-3e0505p-e`/`ds-3e0518p-e` quoted 5 W and 20 W as though they were consumption; those are the
   *idle* figures. The vendor prints both rows side by side, and the gap is the board's own draw:
   60/65 W, 60/65 W, 110/120 W, 230/250 W, 60/65 W, 230/250 W, 370/400 W.
3. **Instrument note: `www.hikvision.com/content/dam/...` answers 200 for paths that do not exist.**
   Plain `curl` gets **985 bytes of `text/html`** (md5 `56d08439...`) for a real PDF path *and* for the
   control `content/dam/hikvision/usa/data-sheet/DS-3E9999ZZ-DoesNotExist.pdf`. So a 200 there is not
   evidence in either direction, and no PDF is readable with `curl`; `web_extract` reads the same URL
   fine. `assets.hikvision.com/prd/public/all/doc/<id>/...` behaves conventionally (PDF 200, missing
   asset **403** `application/xml`), which is why the asset host is preferred where a PDF exists on both.

## Series members this tree does not carry

Named by the same documents, absent from `devices/hikvision/`: `DS-3E0526P-E` (24x 1G PoE),
`DS-3E0510HP-E`, `DS-3E0520HP-E`, `DS-3E0528HP-E` (Hi-PoE variants), `DS-3E1309P-EI`,
`DS-3E1510P-SI`, `DS-3E1516-EI`, `DS-3E1518P-SI`, `DS-3E1524-EI`, `DS-3E1526P-SI`, `DS-3E1552P-SI`.
Each has a full vendor row, so any of them is a spec that can be written from a source rather than
inferred. The three NVRs with PSE ports (`DS-7608NI-K2/8P` 80 W, `DS-7616NI-K2/16P` 200 W, and
`DS-7616NXI-K2/16P`) are still uncited and are the next queue item on this vendor.
