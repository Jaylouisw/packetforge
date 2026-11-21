# The RB260GSP is in the catalogue twice, and only one copy was repaired

**Question.** `devices/mikrotik/` holds two specs for one MikroTik box: `rb260gsp.json` (model
`RB260GSP`, added in #1153) and `css106-1g-4p-1s.json` (model `CSS106-1G-4P-1S`, added in #405, which is
the same product). The MikroTik PoE census (#2294) repaired the first and never looked at the second,
because the census table is keyed by file and that file was not on it. Does the product-code entry
describe the same hardware as the marketing-name entry?

It did not. On the model the engine's switch-wide guess - *every RJ45 port of a `poe-pse` switch
sources 15.4 W unless the spec says otherwise* (`isPoePse()` in `engine/media.js`) - the entry then
claimed:

- **five** PoE sockets, where the box has four;
- each at **15.4 W / 802.3af**, on a box whose vendor row says **passive** PoE.

## What the vendor publishes

MikroTik's specification table for this product, read 2026-11-21
(https://mikrotik.com/product/RB260GSP, HTTP 200, `text/html`, 344,158 B):

| row | value |
|---|---|
| `Number of DC inputs` | `2 (DC jack, PoE-IN)` |
| `PoE in` | `Passive PoE` |
| `PoE in input Voltage` | `11-30 V` |
| `PoE-out ports` | `Ether2-Ether5` |
| `PoE out` | `Passive PoE` |
| `Low voltage PoE-Out current limit` | `1 A` |
| `Max total out (A)` | `2 A` |

Read plainly: **Ether1 is the inlet, Ether2-Ether5 are the outlets**, the outlets are a fixed-voltage
passive pair rather than a negotiated 48 V standard, and the ceiling is a **current** (2 A total, 1 A
per port) against an 11-30 V input window - not a wattage.

The same page's `PoE-out ports Ether2-Ether5` is the sentence that settles the port set without any
inference; it is the identical evidence #2294 used for the sibling entry.

## What was changed

`devices/mikrotik/css106-1g-4p-1s.json` now states what the page states: `poeOut: false` on `eth1`
(the inlet, declared so the switch-wide guess cannot re-promote it), `poeOut: true` with
`poeOutClass: "passive"` on `eth2`-`eth5`, `connector: "rj45"` on the five copper ports, and a `poe`
block carrying `budgetUnknown: true` with the quoted current limit and the vendor URL - no wattage is
computed, because 2 A against 11-30 V is arithmetic MikroTik did not do and the entry must not do it
either. `test/rb260gsp-poe-out-census.test.js` (36 assertions) pins the port set, the class, the absent
wattage, the console's four `show power inline` rows, and the fact that the two entries now agree port
for port - which is the check that would have caught this the first time.

Effect on the audit: `node scripts/audit-poe-budget.js` drops from 22 to 21 *silent* PSEs and rises
from 24 to 25 *marked unknown*; the device's PSE count falls from five to four.

## What is unresolved

**Whether one box should hold two catalogue entries at all.** `RB260GSP` and `CSS106-1G-4P-1S` are a
marketing name and a product code, and the catalogue already carries that pair for other MikroTik
products (`hAP ac2` / `RBD52G-5HacD2HnD-TC`, `Chateau 5G` / `D53G-5HacD2HnD-TC&RG502Q-EA`), so the
duplication is a convention rather than an accident - but a convention with a cost, which is exactly
this defect: a repair applied to one name and not the other. `aliases` cannot absorb the second name
while it is a model of its own (`test/device-aliases.test.js` refuses an alias equal to another
device's model).

What would settle it: a decision, not a document - either the catalogue keeps one entry per SKU and
takes on a test that pins *shared sourceUrl* entries to the same hardware (which would gate this class
of defect for every vendor), or the SKU entries are folded into `aliases` and removed. Until one of
those happens, `test/rb260gsp-poe-out-census.test.js` is the local guard for this pair only.

**The inlet's draw is unstated.** The schema wants `poeIn` in watts; MikroTik publishes only an
11-30 V window on a passive inlet with no current limit, so neither entry carries `poeIn`. That is a
gap in the vendor's own sheet, not an omission to paper over.
