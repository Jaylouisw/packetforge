# The Aruba CX 8320's 48 downlinks: SFP+ cages or RJ45 sockets?

**Question (one, narrow).** The catalogue's `aruba/CX 8320 48SFP+ 6QSFP+` (JL479A) declared its 48
downlinks as `type: ethernet, speed: 10G` with no connector, so `derivePortHardware()` resolved them to
RJ45 copper sockets carrying 10GBASE-T. Does HPE's own documentation say those 48 ports are module
slots (SFP/SFP+ cages), and what does the spec owe them?

**Verdict: settled - they are SFP/SFP+ cages, and the spec now says so.** The portTemplate carries
`"connector": "sfp+"`, so all 48 downlinks report an SFP+ cage offering 10GBASE-SR/LR/ER and the 1G
optics, train at 1G or 10G, and refuse an RJ45 patch lead. `test/aruba-cx-8320-cages.test.js` pins it.
The six 40G uplinks were already resolving to QSFP+ cages (a bare 40G rate is read as optical by
`inferCage()`; a bare 10G rate was not), and the test keeps them that way.

## Evidence

| Source | Says |
| --- | --- |
| [HPE Aruba Networking CX 8320 Switch Series QuickSpecs, a00029141enw](https://www.hpe.com/us/en/collaterals/collateral.a00029141enw.html) | Model row: "Aruba 8320 48p 10G SFP/SFP+ and 6p 40G QSFP+ ... (JL479A)". Technical specifications: "Supports 48 ports of 1/10G for use with SFP and SFP+ transceivers, and 6 ports of 40G for use with QSFP+ transceivers. Optional 1GBASE-T and 10GBASE-T transceivers and 4x10G breakout cables." The ordering rules list "Max = 48 SFP/SFP+ 1/10G Transceivers" and "Max = 6 QSFP+ 40G Transceiver". |
| [Aruba 8320 Installation and Getting Started Guide (PDF)](https://arubanetworking.hpe.com/techdocs/hardware/switches/8320/IGSG/Aruba_8320_IGSG_en_us.pdf) | The port table separates the three columns: JL479A has `–` under "10GBASE-T non-PoE RJ-45 ports", **48** under "SFP+ ports" and **6** under "QSFP+ ports". Footnote: "SFP+ ports support 1G SFP, 1G RJ-45, and 10G SFP+ transceivers." |
| [HPE transceiver compatibility guide, 8320 entry](https://arubanetworking.hpe.com/techdocs/Switches/xcvrs/xcvr_guide/Content/GUID-DBCDD469-13AD-4ECB-9453-B35F34197A8C.html) | Lists "Aruba 8320 48p SFP/SFP+ & 6p 40G QSFP+ Switch (JL479A)" as a QSFP+ capable product - i.e. the 40G group is a cage family, not copper. |
| Same QuickSpecs, sibling SKU | "Aruba 8320 48p 1G/10GBASE-T and 6p 40G QSFP+ ... (JL581A)" - the copper variant is a **different model number**, which is what rules out reading JL479A's 48 ports as 10GBASE-T. |
| [Aruba 8320 product page](https://www.arubanetworks.com/core-and-data-center/8320-series/) | "models with 48 ports of 10GbE (SFP/SFP+ and 10GBASE-T) and 6 ports of 40GbE" - the family comes in both media, per SKU. |

## What is known

1. JL479A's 48 downlinks are SFP/SFP+ cages that accept 1G SFP, 1G RJ-45 (copper SFP) and 10G SFP+
   modules. They are not 10GBASE-T RJ45 sockets; the RJ45 variant is JL581A.
2. The cage trains at 1G and 10G, which is the ladder `CAGE_MEDIA['sfp+']` already offers.
3. HPE also sells 1GBASE-T and 10GBASE-T **transceivers** for these cages, and 4x10G breakout cables for
   the QSFP+ uplinks.

## What was changed

* `devices/aruba/cx-8320-48sfp-6qsfp.json`: the portTemplate gains `"connector": "sfp+"`. Nothing else
  in the row changed - the same 48 names, the same `1G`/`10G` ladder, the same six QSFP+ uplinks.
* `test/aruba-cx-8320-cages.test.js`: all 48 ports are SFP+, offer a 10G and a 1G optic, train at
  1G/10G, and hold a `1000base-t-sfp` module; a 10GBASE-T RJ45 host (an ASUS RT-AX89X's 10G port) is
  refused by an empty cage; two downlinks meet over 10GBASE-SR at 10G; the uplinks meet over a 40G DAC.

## What is inferred

* That the 48 ports are one cage family (SFP+) rather than a mix: both HPE documents count 48 SFP+
  ports and 48 transceivers, and no source shows a mix of SFP and SFP+ *slots* on this SKU. The
  "*SFP/SFP+*" wording is read as "takes both module generations", which is how the engine's SFP+ cage
  already behaves.
* That the 1G rate is available on all 48 ports. The QuickSpecs say "1/10G" for the group; no document
  in hand says a subset is 10G-only.

## What is unresolved

* **The 10GBASE-T SFP+ module is not in the medium catalogue.** The QuickSpecs name "optional ...
  10GBASE-T transceivers", and the engine has `1000base-t-sfp` but no `10gbase-t-sfp`, so a lab cannot
  cable this 10G copper module even though the hardware takes it. Adding the medium (and its mate rule
  against an RJ45 10GBASE-T port) is a medium-catalogue change, not a spec fix, and was left alone here.
* **Breakout is not modelled.** "4x10G breakout cables" for the six QSFP+ uplinks would make each 40G
  cage four 10G ports; this model, like the Nexus 3064PQ before it, keeps the native 40G rate only.
* **Which module ships in the bundle.** HPE's model description says "with X472 5 Fans 2 Power Supply",
  and the QuickSpecs' ordering rules start the transceiver count at zero ("Min=0"), so no optics are
  included. No page in hand states a bundle SKU with a fitted module, so the catalogue leaves every
  cage empty - which is also what a real box ships.

## What evidence would settle it

A `show interface transceiver` (or `show interfaces 1/1/1 transceiver`) capture from an 8320 with a
10GBASE-T module fitted, naming the part; and HPE's transceiver guide page listing the 10GBASE-T SFP+
SKU for JL479A. Either would justify adding `10gbase-t-sfp` to `engine/media.js` and to
`CAGE_MEDIA['sfp+']`.
