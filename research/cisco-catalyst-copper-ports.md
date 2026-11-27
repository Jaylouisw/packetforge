# The Cisco Catalyst copper access ports: 10/100/1000BASE-T on an RJ-45 jack

**Question (one, narrow).** Issue #1398 counts template ports whose connector nothing declares.
Six Cisco Catalyst specs generated their access ports from a `portTemplate` that said only
`type: ethernet, speed: 1G` (or `100M`) — C2960X-24TS-L, C2960X-48FPS-L, WS-C3560G-24TS-S,
WS-C3750G-24TS-S, WS-C3560CX-8PC-S and the generic Catalyst2960 — 176 ports.

Does Cisco state the physical port, and does the port train below 1G?

**Verdict: yes on both counts.** Every one of these access ports is 10/100/1000BASE-T (or
10/100BASE-TX on the Fast Ethernet 2960) on a standard RJ-45 jack, and Cisco says in as many words
that the Gigabit ports negotiate 10, 100 and 1000 Mb/s. The 3560-CX spec additionally left its two
copper uplinks without a connector; the numbering table settles that they are Gi1/0/9-10 and that
they are 10/100/1000BASE-T copper, not optics.

## Evidence

| Source | Says |
| --- | --- |
| [Catalyst 2960 HIG — Product Overview](https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst2960/hardware/installation/guide/2960_hg/higover.html), Table 1-1 | `Catalyst 2960-24TT-L / LAN-Base / 24 10/100BASE-TX Ethernet ports and 2 10/100/1000BASE-T copper uplink ports (no SFP module slot)`. Same page: "The Catalyst 2960-24LT-L, Catalyst 2960-24TT-L, and Catalyst 2960-48TT-L switches have two 10/100/1000 uplink ports, numbered 1 and 2." |
| [Catalyst 2960-X HIG — Product Overview](https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst2960x/hardware/installation/guide/b_c2960x_hig/b_c2960x_hig_chapter_01.html), Table 1 | `Catalyst 2960X-24TS-L / LAN Base / 24 10/100/1000 ports and 4 SFP module slots`; `Catalyst 2960X-48FPS-L / LAN Base / 48 10/100/1000 Power over Ethernet Plus (PoE+) ports (PoE budget of 740 W) and 4 small form-factor pluggable (SFP) module slots`. |
| [Catalyst 3560 HIG — Product Overview](https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst3560/hardware/installation/guide/3560hig/higoverview.html), Table 1-1 and "10/100 and 10/100/1000 Ports" | `Catalyst 3560G-24TS / 24 10/100/1000 ports and 4 SFP module slots`; "The SFP module slots are numbered 25 to 28"; "You can set the 10/100/1000 ports to operate at 10 or 100 Mb/s in half or full duplex or at 1000 Mb/s in full duplex." |
| [Catalyst 3560 HIG — Connector and Cable Specifications](https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst3560/hardware/installation/guide/3560hig/higcables.html) | "The 10/100 and 10/100/1000 Ethernet ports use standard RJ-45 connectors and Ethernet pinouts with internal crossovers." |
| [Catalyst 3750 Series Data Sheet](https://www.cisco.com/c/en/us/products/collateral/switches/catalyst-3750-series-switches/product_data_sheet0900aecd80371991.pdf), ordering table | `WS-C3750G-24TS-S / 24 Ethernet 10/100/1000 ports / 4 SFP-based Gigabit Ethernet ports`. Configurations list: "Cisco Catalyst 3750G-24TS — 24 Ethernet 10/100/1000 ports and four Small Form-Factor Pluggable (SFP) uplinks". |
| [Catalyst 3560-CX / 2960-CX Data Sheet](https://www.cisco.com/c/en/us/products/collateral/switches/catalyst-3560-cx-series-switches/datasheet-c78-733229.html) | `3560CX-8PC-S / 8 x 10/100/1000 Gigabit Ethernet / 8 PoE+ / 240W / 2 x 1G copper plus 2 x 1G SFP`; ordering row `WS-C3560CX-8PC-S: 3560-CX Switch 8 GE PoE+, uplinks: 2 x 1G SFP and 2 x 1G copper, IP Base`. |
| [Catalyst 3560-CX HIG — Product Overview](https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst2960cx_3650cx/hardware/installation/guide/b_2960cx-3560cx_hig/product_overview.html) | `Catalyst 3560CX-8PC-S / IP Base / 8 10/100/1000 Power over Ethernet plus (PoE+) ports (PoE budget of 240 W); 2 Gigabit Ethernet and 2 small form-factor pluggable (SFP) module uplink slots`. |
| [Catalyst 2960CX/3560CX to 9200CX Migration Guide](https://www.cisco.com/c/en/us/products/collateral/switches/catalyst-9200-series-switches/mg-catalyst-2960cx-3560cx-to-9200cx-series.html), Table 4 "Switch interface naming and numbering conventions" | For the 2960CX/3560CX column: GE downlink = `GigabitEthernet0/1`; **GE uplink = `GigabitEthernet0/9`**; 10-GE uplink = `TenGigabitEthernet 1/0/1`. |
| [3560-CX/2960-CX Consolidated Platform Configuration Guide 15.2(7)E](https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst2960cx_3650cx/software/release/15-2_7_e/configuration_guide/b_1527e_consolidated_3560cx_2960cx_cg.pdf) | "The 10/100/1000 port numbers always begin at 1 … For a switch with 10/100/1000 ports and SFP module ports, SFP module ports are numbered consecutively following the 10/100/1000 ports." |

`10BASE-T`, `100BASE-TX` and `1000BASE-T` are all defined over twisted pair with an RJ-45 plug
(`engine/media.js`, MEDIA rows), which is exactly `CAGE_SPEEDS.rj45` — so the declared ladder and the
cage agree with no special case. On the Catalyst 2960 the ladder stops at 100: the ports are
10/100BASE-TX and a 1000BASE-T lead is refused.

## What was changed

| Spec | Access template | Uplinks |
| --- | --- | --- |
| devices/cisco/c2960x-24ts-l.json | `connector: rj45`, `speedCaps: [10,100,1000]` (24 ports) | unchanged — Gi1/0/25-28, 1G SFP |
| devices/cisco/c2960x-48fps-l.json | same (48 ports, PoE+ untouched) | unchanged — Gi1/0/49-52, 1G SFP |
| devices/cisco/ws-c3560g-24ts-s.json | same (24 ports) | unchanged — Gi0/25-28, 1G SFP |
| devices/cisco/ws-c3750g-24ts-s.json | same (24 ports) | unchanged — Gi1/0/25-28, 1G SFP |
| devices/cisco/ws-c3560cx-8pc-s.json | same (8 ports, PoE+ untouched) | Gi1/0/9-10 (the two 1G copper uplinks) gain `connector: rj45`, `speedCaps: [10,100,1000]`; Gi1/0/11-12 stay 1G SFP |
| devices/cisco/catalyst2960.json | `connector: rj45`, `speedCaps: [10,100]` (24 ports) | none modelled — see below |

## What is left open

* **Catalyst2960 is a generic id, not a SKU.** The 24 Fast Ethernet ports are the 2960-24TT-L shape,
  but that SKU also carries two fixed 10/100/1000BASE-T copper uplinks (Gi0/1-2), while the
  2960-24TC-L carries two dual-purpose copper-or-SFP uplinks in the same positions. Choosing one for
  a generic entry would invent a census the id does not claim, so the description names the
  unmodelled uplinks and nothing is asserted.
* **The 9300 and Nexus rows are a separate pass.** C9300-24T, C9300-48P, Catalyst9300, N3K-C3048TP-1GE
  and N9K-C92348GC-X still generate their copper ports from a bare template; the Nexus rows
  additionally have unconnected 25G SFP28 / 100G QSFP28 uplinks to settle.
