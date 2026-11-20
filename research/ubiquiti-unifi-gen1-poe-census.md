# UniFi Gen1 switch PoE census (US-8/24/48, PoE and non-PoE)

Read 2026-11-19, while working the open device-request queue (issue 130 is blocked on a
product Ubiquiti never listed; the catalogue that feeds routed-lab requests is the fallback).

The eight Gen1 rows in `devices/ubiquiti/` declared `poe-pse` and per-port `poeOut`, but **no
`poe.budgetW` at all** - so `engine/device.js` fell back to `parsePoeBudget(model)` and sourced
the budget from the SKU string (`poeBudgetSource === 'name'`). Two of those parsed numbers are
not what the vendor publishes, and one row's prose already contradicted the number in use.

## Vendor rows (Ubiquiti tech-spec pages, server-rendered table, read 2026-11-19)

| model | page | bytes | "Total PoE Availability" | port census row |
|---|---|---|---|---|
| US-8-60W | `https://techspecs.ui.com/unifi/switching/us-8-60w` | 634,544 | **48W** | `Port Layout = 1 GbE RJ45 8 (4 PoE) (1G/100M/10M)`; `PoE Ports = 4`; `Max. PoE Wattage per Port by PSE = PoE 15.4W` |
| US-8-150W | `.../us-8-150w` | 630,675 | **130W** | `1 GbE RJ45 8 (All PoE+) (1G/100M/10M)`; `1G SFP = 2`; `PoE Ports = PoE+ 8` |
| US-24 | `.../us-24` | 616,354 | - | `1 GbE RJ45 24 (1G/100M/10M)`; `1G SFP = 2`; no PoE row |
| US-24-250W | `.../us-24-250w` | 638,959 | 250W | `24 (All PoE+) (1G/100M/10M)`; `PoE Ports = PoE+ 24`; `Max. PoE Wattage per Port by PSE = PoE 17W / PoE+ 34W` |
| US-24-500W | `.../us-24-500w` | 629,652 | 500W | `24 (All PoE+)`; `PoE+ 24`; `Max. Power Consumption 30W excluding PoE / 500W including` |
| US-48 | `.../us-48` | 617,360 | - | `48 (1G/100M/10M)`; `1G SFP = 2`; no PoE row |
| US-48-500W | `.../us-48-500w` | 626,072 | 500W | `48 (All PoE+)`; `PoE+ 48` |
| US-48-750W | `.../us-48-750w` | 619,881 | 750W | `48 (All PoE+)`; `PoE+ 48` |

"The vendor's aggregate row" means the page prints the total as its own labelled row
(`Max. PoE Output = Up to PoE / Total PoE Availability = 48W`), not that it was summed here.

## What the name parser got wrong

| row | name parse | vendor | delta |
|---|---|---|---|
| US-8-60W | 60 W | **48 W** | 12 W of PoE the included AC/DC adapter cannot supply; `show power inline` handed out a budget the box would drop |
| US-8-150W | 150 W | **130 W** | 20 W |
| US-24-250W / -500W, US-48-500W / -750W | 250 / 500 / 500 / 750 W | same | traced to the document rather than the SKU string |

The first two are why `us-8-60w.json`'s description ("48 W PoE budget") and the allocator (60 W)
disagreed in the same file. `node scripts/audit-poe-budget.js` names this class
("budget not traced to a document"); its count falls 20 -> 14 after this change.

## The over-reach the fix uncovered

`engine/media.js` `isPoePse()` answers "yes" for every copper port of a `switch` whose
model/label claims PoE. `US-8-60W`'s label is "UniFi 8 PoE (Gen1)", so ports 5-8 (data-only in
the vendor's `8 (4 PoE)`) were given the 15.4 W 802.3af default: eight PSEs, 123.2 W of declared
PSE capacity, on a 48 W budget. The four data-only ports now say `"poeOut": 0` - the convention
`devices/fortinet/fortiswitch-124f-poe.json` already uses - so the row is 4 PSE ports again.
This is a catalogue fix, not an engine change: the inference rule stays for switches whose spec
is silent about a port.

## Speeds

Every page above prints the copper group as `(1G/100M/10M)`; all eight rows listed only
`1G`/`100M`, so a 10M half-duplex link (an old PoE phone, a serial-to-Ethernet adapter) could not
be negotiated on a port the vendor rates for it. `10M` added.

## Traps recorded

- `https://dl.ui.com/ds/us-8-60w_ds.pdf`, `us-8-150w_ds.pdf` and `us-48-750w_ds.pdf` all answer
  **302 -> `https://techspecs.ui.com/`**, i.e. the 609,911-byte site front page. **The `dl.ui.com/ds/`
  convention is the wrong place to look for this family** - corrected 2026-11-20, below: the family
  datasheet is served from `dl.ui.com/datasheets/unifi/`, where it has a text layer.
- `https://techspecs.ui.com/unifi/switching/us-16-150w` answers **307 -> `/`, 1 byte**, and the live
  `https://store.ui.com/us/en/products/us-16-150w` is a **404** - but the *archived* storefront prints the
  allocation, so the row no longer keeps its name-parsed 150 W. See the 2026-11-20 section.
- `us-24-250w` is **not** in the cards on `https://techspecs.ui.com/unifi/switching` (200,
  763,907 B, 70 product links) yet its own page answers 200 with the full table. Absence from the
  category grid is not absence of the page for this host - the opposite of the `udw-pro` result on
  the gateway grid, where absence was the finding.
- `https://store.ui.com/us/en/products/us-8-150w` answers 200 (426,778 B) and corroborates the
  class, but the store row does not print the total; it is cited nowhere for the budget.

## 2026-11-20: the datasheet does exist, and the archived storefront prints the allocation

The trap above ("no datasheet text layer for this family") was true only of the `dl.ui.com/ds/` path. The
family datasheet lives one directory over and was found from the product's own page, which serves
`https://www.ui.com/downloads/datasheets/unifi/UniFi_PoE_Switch.pdf` -> **301** ->
`https://dl.ui.com/datasheets/unifi/UniFi_PoE_Switch.pdf` (**HTTP 200, 3,962,155 B, 12 pp, real text
layer**). It covers US-8-150W, US-16-150W, US-24-250W/500W, US-48-500W/750W, one spec table per model,
plus a model-bullet page.

The second route is Wayback. The live storefront 404s for these retired SKUs, but the captures do not:
`web.archive.org/web/<ts>id_/https://store.ui.com/us/en/products/<sku>` returns the original page with the
**full spec table and the key-feature list**, and the key-feature list is where Ubiquiti puts the
allocation in words ("`122W total PoE availability`"). This is the same archived-vendor-page class the
queue already accepts for the Dream Wall census, and it is a vendor surface: the URL is `store.ui.com`.

### What it settled

| row | was | vendor | where |
|---|---|---|---|
| US-16-150W | 150 W (name) | **122 W** | storefront row `Total available PoE = 122W`; datasheet p.7 `Including PoE Output 150W / Excluding PoE Output 28W` |
| ES-16-150W | 150 W (name) | 150 W, now traced | storefront key feature `150W total PoE availability` |
| ES-8-150W | 150 W (name) | 150 W, now traced | storefront key feature `150W total PoE availability` |

US-16-150W is the third instance of the class this file already names (US-8-60W 60 -> 48, US-8-150W
150 -> 130): **the model string carries the supply rating, and the allocation is smaller by the box's own
draw.** 150 - 28 = 122, and Ubiquiti prints 122 itself, so no subtraction of ours is needed. Under the old
number `show power inline` handed out 28 W the supply cannot allocate.

### Two census corrections the datasheet forced

- **US-16-150W has a serial console**, at odds with its own spec table: the model bullets (p.3) read
  `(1) Serial Console Port` while the p.7 `Management Interface` row reads only `Ethernet In-Band`
  (US-8-150W has no bullet and no table row; US-24-250W and up print `(1) RJ45 Serial Port Out-of-Band,
  Ethernet In-Band` in the table). A spec that trusted the table alone would delete a real jack. The
  catalogue declares it, and the note records the conflict.
- **Per-port PoE+ ceiling differs between the two vendor surfaces**: 34.2 W on the datasheet, 32 W on the
  storefront, for the same row. Both are recorded; neither is used as a budget.

### Still open in this family

`ES-8-150W` and `ES-16-150W` now declare the out-of-band UART console their pages print (neither did);
`US-24-250W`/`US-48-*` already had theirs. `node scripts/audit-poe-budget.js` moves this family's
"inferred from name" count from 11 to 8 - the three 150 W rows are traced; what is left on HPE, Peplink and
the remaining UniFi Gen1 rows is untouched by this pass.
