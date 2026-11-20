# Ten Ubiquiti door-access hubs had the PoE direction backwards, and none of them had a budget

Measured 2026-11-20 08:2x-08:5x UTC, one increment. Entry point was the audit gate, not a request:
`node scripts/audit-poe-budget.js` lists every spec that declares a PSE port without a budget. Its
Ubiquiti rows are almost all door-access hardware (`EAH-8`, `UA-Hub`, the `UA-Hub-*` and `UA-*-SK*`
kits), and on those the *port that is powered* had been modelled as the *port that powers*.

## 1. The vendor row, and what the catalogue did with it

`https://techspecs.ui.com/unifi/door-access/<slug>` prints one row for the whole PoE side. For the
UA-Hub-Door (200, 624,799 B, read 2026-11-20):

> **Networking Interface** (5) 10/100/1000 Base-T
> **PoE Interface** (1) PoE++ input, 50V DC, 1A | (4) PoE+ outputs, 50V DC, 30W per port (Max 45W aggregated)
> **Max. Power Consumption** 30W (Without PoE output) / 50W (With PoE output)
> **Power Method** PoE++

The spec before this pass read `poeOut` class `PoE++` on **eth0** - the input - and declared nothing on
eth1-eth4. So the box advertised a 60 W source on the jack that is fed *by* the upstream switch, and the
four jacks a camera is actually cabled to could source nothing. There was also no `poe.budgetW`, so
`engine/device.js` fell through to the model-name parser, found no wattage in `UA-Hub-Door`, and served
**0 W**.

## 2. The ten that share the row

| spec | ports | PoE row | aggregate | max without PoE |
|--|--|--|--|--|
| `ua-hub-door` | 5 | 1 PoE++ in + 4 PoE+ out @30 W | 45 W | 30 W |
| `ua-hub-door-mini` | 3 | 1 PoE++ in + 2 PoE+ out @30 W | 45 W | 19 W |
| `ua-hub-gate` | 5 | 1 PoE++ in + 4 PoE+ out @30 W | 55 W | 22 W |
| `ua-hub` | 5 | 1 PoE++ in + 4 PoE+ out @30 W | 45 W | 30 W (direction was already right) |
| `eah-8` | 10 | 8 PoE+ out @30 W | 190 W | 240 W consumption |
| `ua-g3-sk` | 3 | 1 PoE++ in + 2 PoE out @30 W | 45 W | 19 W |
| `ua-g3-sk-pro` | 5 | 1 PoE++ in + 4 PoE out @30 W | 45 W | 30 W |
| `ua-g3-sk-gate` | 5 | 1 PoE++ in + 4 PoE out @30 W | 55 W | 22 W |
| `ua-g2-sk` | 5 | 1 PoE++ in + 4 PoE out @30 W | 45 W | 30 W |
| `ua-g2-sk-pro` | 5 | 1 PoE++ in + 4 PoE out @30 W | 45 W | 30 W |

Every page prints 30 W per port, which is 802.3at Type 2, so the outputs are modelled `PoE+` even where
the row says "PoE outputs" (G3/G2 kits) rather than "PoE+ outputs" (hub family). Pages that print
`10/100/1000 Base-T` also gave both RJ45 banks the 10M rung.

`eah-8` is a different defect of the same family: its description said "240 W max", which is **Max. Power
Consumption**, not the PSE allocation. The budget is **190 W** across eight 30 W PoE+ ports.

## 3. What it changes in a lab

`UniFi Dream Wall` (PoE++ 420 W) -> `UA-Hub-Door` eth0, four 12.95 W PDs on eth1-eth4:

- before: hub budget 0 W, PSE skipped by `computePoe()`, no camera powered;
- after: budget 45 W, three cameras powered (38.85 W), the fourth refused with
  `PSE budget exhausted: 12.95 W requested, 6.15 W left`.

Four 30 W cameras on a hub whose aggregate is 45 W cannot be powered at all - which is the number a door
build has to budget, and the reason the aggregate is the field, not 4 x 30.

`node scripts/audit-poe-budget.js`: silent PSEs **85 -> 75**; Ubiquiti entries **25 -> 15**.

## 4. Left alone, and why

- `ua-g3-sk-elevator`: the page prints **(4) 10/100/1000 Base-T** *and* **Management (1) 10/100/1000
  Base-T** - five jacks - while the PoE row is **(1) PoE++ input + (4) PoE+ outputs** - also five. The
  jack map cannot be resolved from the page (does the management port double as the PoE++ input?), so
  nothing was written rather than guessing one.
- `ua-sk-elevator` and `ua-sk-gate`: the older kit SKUs, whose own tech-spec pages have to be read the
  same way before the same edit. Not done in this pass, so they remain on the audit's silent list with a
  single (wrongly-directed) PSE port each.

## 5. Sources

All ten, HTTP 200 with a desktop-Chrome UA on 2026-11-20, under
`https://techspecs.ui.com/unifi/door-access/`: `ua-hub-door`, `ua-hub-door-mini`, `ua-hub-gate`,
`eah-8`, `ua-g3-sk`, `ua-g3-sk-pro`, `ua-g3-sk-gate`, `ua-g2-sk`, `ua-g2-sk-pro` (and `ua-hub-door` again
for `ua-hub.json`, which cites the same page).
