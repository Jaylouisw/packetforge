# TP-Link Omada SG2008P: 62 W, four PoE+ ports, and the four that are not

Read 2026-11-21 from the vendor's own product page. The SKU moved with the line's rebrand: both
`https://www.tp-link.com/us/business-networking/omada-switch-poe/sg2008p/` and
`https://www.omadanetworks.com/us/business-networking/omada-switch-access/sg2008p/` resolve to the same
document - **HTTP 200, 187,036 B**, final URL the `omadanetworks.com` one.

## What the specification table prints

```
Interface            - 8x 10/100/1000 Mbps RJ45 Ports (Ports 1-4 Support 802.3at/af PoE+)
                       - Auto-Negotiation/Auto MDI/MDIX
Power Supply         - AC/DC Adapter (Input: 100-240V AC; Output: 53.5V DC/1.31A)
PoE Ports (RJ45)     - Standard: 802.3af/at compliant
                       - PoE Ports: 4 Ports
                       - Power Supply: 62 W*
                       - Fast PoE & Perpetual PoE
Max. Power Consumption - 73.4 W (220 V/50 Hz @ 25 C) (with 62 W PD connected)
                       - 74.7 W (110 V/60 Hz @ 25 C) (with 62 W PD connected)
```

The page's own summary line names it a budget rather than a supply rating: *"62 W Power Budget"*. The
footnote is the usual variance disclaimer - *"PoE budget calculations are based on laboratory testing.
Actual PoE power budget is not guaranteed and will vary as a result of client limitations and
environmental factors."* - not a different number.

## Why 62 W is the PD-side allowance

The adapter is 53.5 V DC at 1.31 A, i.e. **70.1 W** at the DC output, so 62 W cannot be the supply's
rating. The max-consumption row settles it: with a full 62 W of PD load attached the box draws 73.4 W
from the wall - 62 W to the powered devices plus ~11 W of chassis. Four 802.3af loads (4 x 15.4 W =
61.6 W) therefore fit inside 62 W, and four Class-4 25.5 W loads (102 W) do not. That is the ceiling the
engine now enforces with `poe.budgetW: 62`; the third 25.5 W access point on the box is refused with
`PSE budget exhausted: 25.5 W requested, 11 W left`.

## What the catalogue had

`devices/tp-link/SG2008P.json` described the PoE in prose ("4 PoE+ ports and 62 W power budget") and
declared none of it in hardware: no `poeOut` on any port, no `poe-pse` capability, no `poe` block. The
console answered `% No PoE on ...: no port on this device can supply power`, and
`scripts/audit-poe-budget.js` could not see the gap either, because it counts devices that already
source power somewhere.

The end-of-sale sibling `TL-SG2008P` (`devices/tp-link/tl-sg2008p.json`) is the same 8-port, four-PoE+
layout - *"Ports 1-4 Support 802.3at/af PoE+"*, *"PoE Ports: 4 Ports / Power Supply: 62 W"*, max
consumption 77.3 W with 62 W of PD attached - and had the second half of the same defect: four real PSE
ports, no budget, and four *invented* ones. `engine/media.js` fills a silent `poeOut` on every RJ45 port
of a `switch` that claims `poe-pse`, so `eth4`-`eth7` were being credited 15.4 W apiece against a budget
that did not exist.

Both rows now declare ports 1-4 as PoE+ and ports 5-8 as `poeOut: false`.

## Still open

Nothing about this SKU's port census or budget. The page prints no per-port ceiling, so `poe.perPortW`
is deliberately absent rather than copied from the 802.3at standard: 30 W is what the standard allows,
not a figure this vendor published for this box.
