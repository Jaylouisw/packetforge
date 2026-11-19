# Peplink HD4 MBX: eight 802.3at outlets the catalogue could not ask about, on a row copied from the wrong chassis

Read 2026-11-19, one increment on the catalogue stream, under #130's fallback list (a
router/gateway node for a routed lab: NAT, DHCP, VPN, **cellular WAN** — which is exactly what the
HD4 MBX is). The box sat in the catalogue twice over: as a **silent PSE** (`MAX-HD4-MBX-GLTE`
declared eight `poeOut` ports and no `poe` block, so `engine/simulator.js` opened with
`if (!dev.poeBudget) continue;` and skipped it — not "unknown", skipped), and as a **copy of the
non-MBX chassis** for its ports and throughput.

## What Peplink prints

| | HD4 MBX | HD4 MBX 5G |
|--|--|--|
| tech-spec sheet | <https://www.peplink.com/compare/tech-specs/hd4-mbx.pdf> (200, `application/pdf`, 226,176 B, 6 pp) | <https://www.peplink.com/compare/tech-specs/hd4-mbx-5g.pdf> (200, `application/pdf`, 226,055 B, 6 pp) |
| Ethernet WAN | `3 / 2 (GE)` | `3 / 2 (GE)` |
| Ethernet LAN | `8 / 9 (GE)` | `8 / 9 (GE)` |
| port configurations | `3 WAN with 8 LAN, 2 WAN with 9 LAN` | same |
| Router throughput | `2.5Gbps` | `2.5Gbps` |
| PoE input | `No` | `No` |
| PoE output | `Up to 8x 802.3at PoE+` | `Up to 8x 802.3at PoE+` |
| the footnote | `2x 54V DC input is needed for all 8x LAN ports to have 802.3at PoE. Plugging in 1x 54V DC input will result in 4x LAN ports having 802.3at PoE.` | same |
| AC adapter | `AC Input 100V-240V, DC Output 54V 3.34A [13] Compatible with ACW-630` | same |
| nominal / max consumption | `35` / `55W (w/o PoE)` | `35` / `55W (w/o PoE)` |
| cellular | `4x CAT-12, 4x CAT-12 (FirstNet Ready), 4x CAT-18, 4x CAT-18 (ESN), 4x CAT-20`, `5G support No`, `SIM Slots 8` | 4x 5G |

Sheet pages: page 1 carries the WAN/LAN/throughput rows, page 6 the PoE and power rows (the 5G
sheet prints its AC adapter row on page 5).

`MAX-HD4-MBX-GLTE` is a real SKU pair, named on the product page
<https://www.peplink.com/products/enterprise-mobility/mbx/> (200, 187,714 B) as
`MAX-HD4-MBX-GLTE-G-T` (CAT-18) and `MAX-HD4-MBX-GLTE-S-T` (CAT-20) — GLTE is the CAT-20 option
of the same chassis, not a separate box.

## The trap: the row was the plain MAX HD4 wearing an MBX name

`devices/peplink/max-hd4-mbx-glte.json` cited
<https://download.peplink.com/resources/pepwave_max_hd4_datasheet.pdf> (200, 807,072 B, 2 pp) —
the **non-MBX** MAX HD4 datasheet, which prints `2x 100/1000M Ethernet WAN`,
`8x 100/1000M Ethernet LAN with 802.3at PoE Output#`, `Router Throughput 400Mbps`,
`Power Consumption 38W (max. before PoE Output)`, a `12V-56V` terminal block and a `12V4.2A`
ACW-635 supply, with the PoE kits (ACW-618: 2x 56V/2.1A PSUs, 8x 802.3at/af; ACW-622: 1x 56V PSU,
802.3af only) sold separately. Every one of those numbers had been copied into the MBX row: 400
Mbps, ten copper ports, no budget. The MBX is a different chassis — 2.5 Gbps, **eleven** GE ports,
55 W max, a 54V/3.34A ACW-630 adapter — so the row understated the throughput six-fold and was one
LAN port short. The same document is still the correct source for `devices/peplink/max-hd4-lte.json`,
which is the plain HD4 and stays as it is.

`devices/peplink/max-hd4-mbx-ltea.json` cited <https://download.peplink.com/resources/hd4.pdf>,
which now answers **HTTP 403**; it was re-pointed at the MBX sheet, whose printed rows match that
row's existing notes exactly (3/2 WAN, 8/9 LAN, 2.5 Gbps).

## The budget: derived, twice over

Peplink publishes no "PoE budget" row. The printed figures give the envelope, and the vendor's own
single-supply footnote checks the arithmetic:

```
two 54V inputs : 2 x (54 V x 3.34 A) = 360.72 W  -  55 W  =  305.72 W   ->  eight 802.3at ports (8 x 30 = 240 W) fit
one 54V input  :      (54 V x 3.34 A) = 180.36 W  -  55 W  =  125.36 W   ->  four 802.3at ports (4 x 30 = 120 W) fit, five do not
```

The second line is the vendor's own `1x 54V DC input will result in 4x LAN ports` footnote,
reproduced exactly by the subtraction — which is why the first line is trusted. `poe.budgetW` is
therefore `305.7`, marked DERIVED in `poe.note`, and it models the two-supply build: the only
configuration in which all eight LAN ports source power. A lab that feeds one supply has four PoE+
ports, and the note says so rather than pretending the box is short.

Which eight ports? The eight **LAN** ports of the `3 WAN with 8 LAN` configuration — the count and
the outlet count coincide there, so no port has to be guessed. In the default `2 WAN with 9 LAN`
build the vendor does not say which of the nine LAN ports loses power, so that build is recorded in
`notes` and not modelled.

## Still not modelled

No 802.3bt, no `802.3af` token (the sheet prints `802.3at PoE+` only), no SFP (`SFP LAN / WAN No`),
no serial port (`Serial Interface No`), no USB WAN interface, and no per-modem datarate (the sheet
gives categories, not Mbps). `MAX-HD4-MBX` (International) was left alone: it still cites
`https://www.peplink.com/compare/tech-specs/hd4.pdf` — the **plain** HD4 compare sheet — for
400 Mbps and 2-5 WAN / 5-8 LAN, which looks like the same copy-the-wrong-chassis defect, but no
MBX-specific sheet prints those figures and a guess here would be worse than the question.
