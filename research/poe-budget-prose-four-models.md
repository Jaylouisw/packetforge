# Four PoE budgets that were written in prose and never in the field the engine reads

Measured 2026-11-20 09:2x-09:4x UTC, one increment on the catalogue stream. No open device
request is answered here (`#130` UDW-PRO and `#803` E6616X are both still blocked upstream; see
`docs/DEVICE_REGISTRY.md`).

## The defect, in one line

`scripts/audit-poe-budget.js` reports two different failures and this pass closed only the quieter
one: a spec whose `description` or `notes` states a total wattage while the structured `poe` block
is missing. The figure is in the file, a human reads it, and `engine/simulator.js` never sees it -
`if (!dev.poeBudget) continue;` skips the box, so `show power inline` answers *"budget not
modelled"* for a device the catalogue can quote to the watt.

Before this pass: **75 of 411 PSEs** could not be asked how much they can supply, **10 of those
already quote a figure in prose**. After: **71 of 411**, **6 in prose**.

## The four, each against the vendor's own page

| spec | vendor figure, verbatim | source |
|--|--|--|
| `devices/tp-link/tl-sg3428xmp.json` | `PoE+ Ports: 24 Ports`; `PoE Power Budget: 384 W`; `Up to 30 W on Each Port` | <https://www.tp-link.com/us/business-networking/omada-switch-poe/tl-sg3428xmp/> (200, 189,932 B) |
| `devices/tp-link/tl-sg2428p.json` | `PoE+ Ports: 24 Ports`; `PoE Power Budget: 250 W` | <https://www.tp-link.com/us/business-networking/omada-switch-poe/tl-sg2428p/> (200, 181,862 B) |
| `devices/netgear/gs110tp.json` | `PoE (46 Watts of power budget)`; `delivering up to 15.4W of power`; `48V, 1.25A external power adapter`; `Power consumption: 59.3W maximum` | <https://www.netgear.com/images/datasheet/switches/SmartSwitches/GS110TP.pdf> (200, `application/pdf`, 405,458 B, 3 pp) |
| `devices/netgear/gs116lp.json` | `PoE Budget 76W`; `16 PoE+ ports with 76W total power budget, and includes NETGEAR FlexPoE making it expandable to 115W or even 183W (w/separate power supply)` | <https://www.netgear.com/business/wired/switches/unmanaged/gs116lp/> (200, 675,591 B) |

Both TP-Link budgets carry the vendor's own footnote - *"PoE budget calculations are based on
laboratory testing. Actual PoE power budget is not guaranteed"* - and both are far below the sum of
the port ceilings (24 x 30 W = 720 W against 384 W, and 720 W against 250 W). Recorded in each
spec's `poe.note` so a lab is not told the row can carry 24 x 30 W.

## GS110TP was worse than a missing number

Its eight copper ports carried no `poeOut` at all, and `poe-pse` / `802.3af` were absent from
`capabilities`, while the description promised *"802.3af PoE (15.4 W per port, 46 W total
budget)"*. So the box was a **silent PSE** - the same defect class as the EdgePoint S16
(`research/ubiquiti-edgepoint-poe-census.md`): nothing to report, nothing to refuse, the row simply
did not exist. Fixed here: `poeOut: 15.4`, `poeOutClass: "PoE"` on ports 1-8, the two capabilities,
and `poe.budgetW: 46`. 8 x 15.4 W = 123 W of ceiling against a 46 W supply, so the budget is the
limit and the note says so.

## What was left, and why

- `netgear/GS724TP` (192 W), `moxa/EDS-G4012-8P-4QGS-LVB-T` (150 W), `dahua/NVR5216-16P-EI2`
  (130 W), `hikvision/DS-7616NI-K2/16P` (200 W), `hikvision/DS-7608NI-K2/8P` (80 W): no vendor
  document was read in this increment, so no field was written. The prose figure alone is not a
  source - two of these are NVRs whose "PoE budget" is often the *adapter* rating, and one is a
  single-port ceiling quoted as a total.
- `aruba/2540-48g-poe-4sfp-plus-jl357a` (370 W): `www.arubanetworks.com/assets/ds/DS_2540SwitchSeries.pdf`
  answered **403** to the same crawler client that fetched the four above; the HPE datasheet host
  was not swept. Left for a pass that can read it.
