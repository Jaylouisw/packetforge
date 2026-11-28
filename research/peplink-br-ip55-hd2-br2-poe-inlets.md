# Peplink BR1 IP55, HD2 Mini, BR2 Pro: three inlets on the WAN side

Read 2026-11-28. Fifth increment of the powered-device work in `docs/plans/poe-pd-inference.md`
step 4, after `research/peplink-br1-mini-poe-inlet.md` did the BR1 Mini family and
`research/peplink-hd4-mbx-poe-census.md` did the PSE side of this vendor.

## What the catalogue had

| file | copper ports | declared inlets | class guess |
|--|--|--|--|
| `devices/peplink/max-br1-ip55.json` | wan1 lan1 lan2 | none | 3 x 12.95 W = 38.85 W |
| `devices/peplink/max-hd2-mini.json` | wan1 lan1 lan2 | none | 3 x 12.95 W = 38.85 W |
| `devices/peplink/max-br2-pro-5g.json` | wan1 wan2 lan1 lan2 lan3 lan4 | none | 6 x 12.95 W = 77.7 W |

All three carried the `poe-pd` capability and no `poeIn` on any port, so `derivePortHardware()`
promoted the device-level claim to every copper port (`engine/media.js`, the `isPoePd()` branch).
A BR2 Pro is a 30 W router; the catalogue had it asking a switch for 77.7 W across six cables.

## What Peplink prints

| | MAX BR1 IP55 | MAX HD2 Mini | MAX BR2 Pro 5G |
|--|--|--|--|
| tech-spec sheet | <https://www.peplink.com/compare/tech-specs/br1-ip55.pdf> (200, 6 pp) | <https://www.peplink.com/compare/tech-specs/hd2-mini.pdf> (200, 6 pp) | <https://www.peplink.com/compare/tech-specs/br2-pro.pdf> (200, 6 pp) |
| WAN | `1 (GE)` | `1 (GE)` | `2 / 1 (2.5G)` |
| LAN | `2 (GE)` | `2 (GE)` | `4 / 5 (GE)` |
| PoE input | `PoE Input PoE: DC 48-56V` / `Yes [2]`, `[2] 802.3at PoE+ or 56V Peplink Passive PoE` | `Yes [10]`, `[10] 1x 802.3at PoE` | `Yes [15]`, `[15] 1x 802.3at PoE port provide a power supply of 25W` |
| PoE output | `1x 802.3at PoE+` | `Up to 2x 802.3at PoE+ [11]` (kit) | `No` |
| consumption | `18W (w/o PoE)` | `15W (w/o PoE)` | `30W` |
| port naming | datasheet panel <https://download.peplink.com/resources/pepwave_max_br_ip55_datasheet.pdf> (200, 546,123 B): `1x 10/100/1000M Ethernet WAN (PoE Input)`, `2x 10/100/1000M Ethernet LAN (LAN1 - 802.3at PoE Output)` | datasheet panel <https://download.peplink.com/resources/pepwave_max_hd2_mini_datasheet.pdf> (200, 899,863 B): `1x 100/1000M Ethernet WAN/LAN with 802.3at PoE Input`, `2x 100/1000M Ethernet LAN with 802.3at PoE #` | hardware reference guide <https://download.peplink.com/manual/br2_pro_hardware_reference_guide.pdf> (200, 565,452 B): `1x GE WAN/LAN Port with 802.3at PoE Input` beside `4x GE LAN Ports` and `1x 2.5Gbps WAN Port` |

None of the three tech-spec sheets says which socket: they give the count (`1x`) and the class
(`802.3at`) over a port row. The naming comes from one document further down the page in each
case - a panel drawing on the two legacy products, the interface layout on the BR2 Pro.

Two of these rows are the reverse of what their own notes said:

- The IP55 is a **PD on WAN and a PSE on LAN 1**. The earlier note in
  `research/peplink-br1-mini-poe-inlet.md` read the tech sheet as "PoE input on the WAN port",
  which is right, but the sheet alone does not say so; the datasheet panel does, and it also
  shows LAN 1 as the optional 802.3at PoE+ *output* (injector ACW-107, sold separately).
- The HD2 Mini's inlet is the **WAN/LAN port**, not one of its two LAN ports - those are the
  optional PoE *outputs* (PoE Activation Kit, ACW-609 / ACW-622). A row that guessed "LAN 1
  because the others do" would have put the draw on a socket that pushes power out.

## The figure recorded

| row | port | `poeIn` | why that number |
|--|--|--|--|
| `MAX-BR1-IP55` | `wan1` | 18 | sheet `Maximum Power Consumption 18W (w/o PoE)` |
| `MAX-HD2-MINI` | `wan1` | 15 | sheet `Maximum Power Consumption 15W (w/o PoE)` |
| `MAX BR2 Pro 5G` | `wan2` | 25 | sheet `[15] 1x 802.3at PoE port provide a power supply of 25W`; the 30 W figure is mains-only |

The BR2 Pro is the one row where the maximum-consumption figure and the inlet figure disagree.
Peplink says the 802.3at port supplies 25 W and that a 30 W budget (dual cellular plus USB WAN)
needs the bundled 12V3A PSU or the passive injector kit, so 25 W is what this port can actually
draw - the 30 W number would describe a supply the inlet cannot provide. Every other copper port
on all three rows declares `poeIn: false`, the "explicitly not a PD" value already used by 25
rows (`devices/ubiquiti/udm-pro-max.json` and the UXG family): a `null` is exactly the silence
`isPoePd()` refills.

The two PoE *outputs* (IP55 LAN 1, HD2 Mini LAN 1-2) are documented in each row's notes and left
unmodelled: both need a separately sold injector or licence, and this increment is the PD side.
A later pass that models Peplink PSE ports should start there rather than re-deriving it.

## Census

Measured through `Topology().addDevice(spec)` over every spec in `devices/`:

```
                    declared PD ports   inferred PD ports   devices with >=2 inferred
before                          199              1,225                        154
after                           202              1,213                        151
```

Twelve guessed ports gone on three rows; no row gained a port it cannot power.

## Still open on this vendor

`MAX BR1 Pro 5G` (`devices/peplink/max-br1-pro-5g.json`) is the last Peplink `poe-pd` row with
no declared inlet. Its sheet prints `PoE Input Yes (HW3) [13]` / `[13] 1x 802.3at PoE` and
`Maximum Power Consumption 19W`; the HW3 hardware reference guide
(<https://download.peplink.com/manual/br1_pro_5g_hardware_reference_guide.pdf>, 200) draws the
board with `1x GE LAN Port with 802.3at PoE Input` next to `1x GE LAN Port (RJ45 Ethernet)`, but
neither document numbers the two LAN ports. The socket is one of three, and no Peplink document
read here says *which* - so it is a blocked row rather than a guess until a numbered panel,
Quick Start, or firmware port map turns up.
