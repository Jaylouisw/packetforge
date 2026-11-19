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
  **302 -> `https://techspecs.ui.com/`**, i.e. the 609,911-byte site front page. There is no
  datasheet text layer for this family; the rendered tech-spec table is the only vendor surface,
  so all per-port figures above are tech-spec-only.
- `https://techspecs.ui.com/unifi/switching/us-16-150w` answers **307 -> `/`, 1 byte**, and
  `https://store.ui.com/us/en/products/us-16-150w` is a **404**. `us-16-150w.json` therefore keeps
  its name-parsed 150 W: not published is not the same as published and different, and nothing
  was invented for it.
- `us-24-250w` is **not** in the cards on `https://techspecs.ui.com/unifi/switching` (200,
  763,907 B, 70 product links) yet its own page answers 200 with the full table. Absence from the
  category grid is not absence of the page for this host - the opposite of the `udw-pro` result on
  the gateway grid, where absence was the finding.
- `https://store.ui.com/us/en/products/us-8-150w` answers 200 (426,778 B) and corroborates the
  class, but the store row does not print the total; it is cited nowhere for the budget.
