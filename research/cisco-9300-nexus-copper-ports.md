# The Catalyst 9300 and Nexus copper access ports: which jack, and which rates

**Question (one, narrow).** Issue #1398 counts template ports whose connector nothing declares.
After the 2960/3560/3750 pass, the Cisco rows still generating copper from a bare
`type: ethernet, speed: 1G` template were C9300-24T, C9300-48P, the generic Catalyst9300,
N3K-C3048TP-1GE and N9K-C92348GC-X - 192 ports. Is the access port an RJ-45 jack, and what
does it train at?

**Verdict: yes, and the two platforms do not share a ladder.** The Catalyst 9300 gigabit
downlinks are 10/100/1000BASE-T; the C9300-24UX downlinks are NBASE-T (100M/1G/2.5G/5G/10G);
the Nexus 3048 is 10/100/1000BASE-T; the Nexus 92348GC-X is **100M/1G only** - Cisco says its
48 Base-T ports "can be configured to work as 100-Mbps, 1-Gbps ports", with no 10M step. That
difference is exactly the kind of thing an inferred cage hides: both boards looked identical.

## Evidence

| Source | Says |
| --- | --- |
| [Catalyst 9300 data sheet](https://www.cisco.com/c/en/us/products/collateral/switches/catalyst-9300-series-switches/nb-06-cat9300-ser-data-sheet-cte-en.html), Platform details table, column *Total 10/100/1000, Multigigabit copper or SFP fiber* | `C9300-24T / 24 ports data`; `C9300-24UX / 24 ports Multigigabit Cisco UPOE (10G/5G/2.5G/1G/100M)`. The column header is the port family: 10/100/1000 copper for the gigabit rows, Multigigabit for the UX row. |
| Catalyst 9300 data sheet, Platform benefits | "Cisco Catalyst 9300 Series Switches provide optimum power saving with Energy Efficient Ethernet (EEE) on the RJ-45 ports". |
| [Catalyst 9300 HIG - Connector and Cable Specifications](https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst9300/hardware/install/b_c9300_hig/connector-cable-specs.html) | "**All 10/100/1000 ports use standard RJ-45 connectors and Ethernet pinouts.**" |
| [Catalyst 9300 HIG](https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst9300/hardware/install/b_c9300_hig.pdf) (PDF), section "10/100/1000 Ports" | "The 10/100/1000 ports use RJ-45 connectors with Ethernet pinouts. The maximum cable length is 328 feet (100 meters). The 100BASE-TX and 1000BASE-T traffic requires twisted pair (UTP) cable of Category 5 or higher. The 10BASE-T traffic can use Category 3 cable or higher." - the ladder in Cisco's own words. |
| [Nexus 3048 data sheet](https://www.cisco.com/c/en/us/products/collateral/switches/nexus-3000-series-switches/data_sheet_c78-685363.pdf) | "48 fixed 10/100/1000-Mbps Ethernet ports"; Physical: "48 10/100/1000-Mbps RJ-45 ports; 4 1/10 Gbps SFP+ uplink ports"; ordering: `N3K-C3048TP-1GE / Nexus 3048TP-1GE 1RU 48 10/100/1000 Mbps and 4 10Gbps ports`. |
| [Nexus 3000 Series HIG - Overview](https://www.cisco.com/c/en/us/td/docs/switches/datacenter/nexus3000/hw/installation/guide/b_n3000_hardware_install_guide/b_n3000_hardware_install_guide_chapter_01.html) | `3048TP (N3K-C3048TP-1GE) ... 48 fixed 10/100/1000 Ethernet downlink ports, 4 fixed 10-Gigabit Ethernet uplink ports`; figure legend "10/100/1000-Mbps Ethernet downlink ports (48)" and "1- and 10-Gigabit Ethernet uplink ports (4)". |
| Nexus 3000 Series HIG - port connections | "you use SFP or SFP+ transceivers on copper or optical cables or SFP+ transceivers on optical cables to make the 1- or 10-Gigabit Ethernet uplink connections" - the four uplinks are SFP+ cages, 1G or 10G. |
| [N9200 platform data sheet](https://www.cisco.com/c/en/us/products/collateral/switches/nexus-9000-series-switches/datasheet-c78-735989.html) | `Cisco N92348GC-X / 48p 100M/1G Base-T ports + 4p 1/10/25G SFP28, +2p 40/100G QSFP28`; "The 48 1GBASE-T downlink ports on the 92348GC-X can be configured to work as 100-Mbps, 1-Gbps ports. The 4 ports of SFP28 can be configured as 1/10/25-Gbps and the 2 ports of QSFP28 can be configured as 40- and 100-Gbps ports." Supported speeds row: "100M, 1 Gbps on Base-T ports and 1, 10, and 25 Gbps on SFP28 ports; 40 and 100G on QSFP28". |
| [N9200 HIG - Overview](https://www.cisco.com/c/en/us/td/docs/switches/datacenter/nexus9000/hw/n92348gc-x-hig/b_n92348GC-X-nxos-hardware-installation-guide/b_n9248GC-FX-nxos-hardware-installation-guide_chapter_01.html) | "100/1000-Megabit Ethernet RJ45 ports (48)" and "1/10/25-Gigabit Ethernet SFP28 ports (4)". |

`10BASE-T`, `100BASE-TX`, `1000BASE-T`, `2.5GBASE-T`, `5GBASE-T` and `10GBASE-T` are all
twisted-pair media over an RJ-45 plug (`engine/media.js`, MEDIA rows), which is `CAGE_SPEEDS.rj45`
exactly - so each declared ladder and its cage agree with no special case.

## What was changed

| Spec | Access template | Uplinks |
| --- | --- | --- |
| devices/cisco/c9300-24t.json | `connector: rj45`, `speedCaps: [10,100,1000]` (24 ports) | untouched - Gi1/1/1-8, 10G SFP+ |
| devices/cisco/c9300-48p.json | same (48 ports, PoE+ untouched) | untouched - Gi1/1/1-8, 10G SFP+ |
| devices/cisco/catalyst9300.json | `connector: rj45`, `speedCaps: [10,100,1000]` (24 ports) | none modelled - see below |
| devices/cisco/c9300-24ux.json | already declared `rj45`; gains `speedCaps: [100,1000,2500,5000,10000]` (the NBASE-T ladder the data sheet prints as 10G/5G/2.5G/1G/100M) | untouched - Gi1/1/1-8, 10G SFP+ |
| devices/cisco/n3k-c3048tp-1ge.json | `connector: rj45`, `speedCaps: [10,100,1000]` (48 ports) | Eth1/49-52 gain `connector: sfp+`, `speedCaps: [1000,10000]` |
| devices/cisco/n9k-c92348gc-x.json | `connector: rj45`, `speedCaps: [100,1000]` (48 ports) | Eth1/49-52 gain `connector: sfp28`, `speedCaps: [1000,10000,25000]`; Eth1/53-54 gain `connector: qsfp28`, `speedCaps: [40000,100000]` |

The uplink connectors were unstated too, and they are not copper: leaving them silent is how a
25G SFP28 port ends up drawn as an RJ-45 socket (the 288-port failure class in #1398). Their
rates come from the two data sheets above, not from the cage defaults.

## What is left open

* **Catalyst9300 is a generic id, not a SKU.** Its 24 gigabit ports are the C9300-24T shape. The
  real switch's uplinks live in a network module slot (C9300-NM-8X and siblings), so what is in
  that slot depends on the order; the id does not claim one and nothing is asserted. C9300-24T and
  C9300-48P model a C9300-NM-8X because their `interfaces` list already did.
* **The Nexus 3048 product page summarises its ports as "48 100/1000 Mbps RJ-45 ports"**, one
  step narrower than the data sheet ("48 10/100/1000-Mbps RJ-45") and the installation guide
  ("48 fixed 10/100/1000 Ethernet downlink ports"). Two Cisco documents that describe the chassis
  in detail outrank a marketing summary line, so the ladder is `[10,100,1000]`; the conflict is
  recorded here rather than silently resolved.
* **10GBASE-T on the 24UX needs Cat 6a** - a cabling question the engine already answers from the
  medium (`MEDIA['10gbase-t'].cable`), not a port question, so the spec says nothing about it.
