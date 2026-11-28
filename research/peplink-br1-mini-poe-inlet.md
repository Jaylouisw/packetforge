# Peplink BR1 Mini: four rows, one inlet, on the port the panel marks

Read 2026-11-28. Fourth increment of the powered-device work in
`docs/plans/poe-pd-inference.md` step 4 (batch by vendor, one product family per PR), after
`research/peplink-hd4-mbx-poe-census.md` did the PSE side of this vendor.

## What the catalogue had

All four BR1 Mini rows carried the `poe-pd` capability and no `poeIn` on any port:

| file | copper ports | declared inlets |
|--|--|--|
| `devices/peplink/max-br1-mini-lte-e.json` | lan1 lan2 lan3 | none |
| `devices/peplink/max-br1-mini-ltea-e.json` | lan1 lan2 lan3 | none |
| `devices/peplink/max-br1-mini-ltea-w.json` | lan1 lan2 lan3 | none |
| `devices/peplink/max-br1-mini-m2m-hw3.json` | lan1 lan2 | none |

`derivePortHardware()` therefore promoted the device-level claim to **eleven** copper ports
(`engine/media.js`, the `isPoePd()` branch): a BR1 Mini cabled into a PoE+ switch asked it for
3 x 12.95 W = 38.85 W to run an 18 W router, and two of the three cables carried a draw the
hardware does not have. The earlier note in the same plan counted this family by name -
`peplink/MAX-BR1-MINI-LTE-E router 0 PSE, 3 PD - the datasheet says "PoE Input Yes" on one WAN port`.
The first half of that sentence is right and the second half is the trap: the inlet is not on a
WAN port, and on this board there is no WAN port until PrimeCare turns LAN 3 into one.

## What Peplink prints

| | BR1 Mini HW3 (LTE-E / LTEA-E / LTEA-W) | BR1 Mini M2M HW3 |
|--|--|--|
| tech-spec sheet | <https://www.peplink.com/compare/tech-specs/br1-mini.pdf> (200, `application/pdf`, 226,453 B, 6 pp) | <https://download.peplink.com/resources/br1_mini_m2m_datasheet.pdf> (200, 9,889,455 B) |
| WAN | `0 / 1 (GE)` | `1x 10/100/1000M Ethernet` |
| LAN | `3 / 2 (GE)` | `2x 10/100/1000M Ethernet` |
| PoE input | `Yes [11]`, footnote `[11] 1x 802.3at PoE.` | `Power over Ethernet 802.3at` |
| PoE output | `No` | not printed |
| consumption | `Nominal 13W`, `Maximum 18W` | `13W (nominal), 18W (max.)` |
| AC adapter | `AC Input 100V-240V / DC Output 12V` (ACW-632) | same |
| hardware guide | <https://download.peplink.com/manual/br1_mini_hw3_hardware_reference_guide.pdf> (200, 4,816,585 B) | <https://download.peplink.com/manual/br1_mini_m2m_hardware_reference_guide.pdf> (200, 3,244,594 B) |

The sheet gives the **count** (`1x`) and the **class** (802.3at) but never the socket. The
hardware reference guide does, twice: the back-panel drawing labels the row
`LAN 1 | 2 | 3 / WAN` (M2M: `LAN 1 | 2 / WAN`) and prints `802.3at PoE IN` under LAN 1, and the
parts list reads `1x GE LAN Port with 802.3at PoE Input`. The BR1 Mini 5G guide at
<https://cdn11.bigcommerce.com/s-hltjsp5jm3/content/pdfs/MAX-BR1-MINI-5GN-T-M-PRM_Manual.pdf>
prints the same panel in the same place, so the inlet has not moved between revisions.

## The figure recorded

`poeIn: 18` on `lan1` - the sheet's **maximum** consumption, because that is the worst case the
cabling has to fund and it is what a lab budget should reserve. Not 25.5 W: 802.3at's class
ceiling is what the PSE must offer, not what this box takes. LAN 2 and LAN 3 (and LAN 2 on the
M2M) declare `poeIn: false`, the "explicitly not a PD" value already used by 25 rows
(`devices/ubiquiti/udm-pro-max.json` and the UXG family) - a `null` there is exactly the silence
`isPoePd()` refills.

## Census

Measured through `Topology().addDevice(spec)` over every spec in `devices/`:

```
                    declared PD ports   inferred PD ports   devices with >=2 inferred
before                          195              1,236                        158
after                           199              1,225                        154
```

Four rows, eleven guessed ports gone, four devices off the "asks for more than it has" list.

## Still open on this vendor

Four Peplink rows still carry `poe-pd` with no declared inlet: `MAX-BR1-IP55`, `MAX BR1 Pro 5G`,
`MAX BR2 Pro 5G` and `MAX-HD2-MINI`. Each needs its own reading, and two are already known to be
more than a one-line fix:

- `MAX-BR1-IP55` prints `PoE Input: PoE: DC 48-56V` under a footnote reading `802.3at PoE+ or 56V
  Peplink Passive PoE` on the **WAN** port, and `PoE Output: 1x 802.3at PoE+` on LAN 1 - so it is a
  PD and a silent PSE in one file, and the passive-48 V input is not the same claim as an 802.3at
  PD (`poeIn` watts, yes; a `802.3af` token, no).
- `MAX BR1 Pro 5G` prints `PoE Input Yes (HW3) [13]` with `[13] 1x 802.3at PoE`; the HW3 panel in
  its hardware reference guide has to be read the same way this one was, port by port.
- `MAX-HD2-MINI` prints `PoE Input Yes [10]` / `[10] 1x 802.3at PoE` but Peplink lists no hardware
  reference guide for the model, so the socket may not be published anywhere - that is the shape
  that ends as a blocked note rather than a row.
