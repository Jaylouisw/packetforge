# The H3C S6520X-30QC-EI's 24 downlinks: SFP+ cages or RJ45 sockets?

**Question (one, narrow).** The catalogue's `h3c/S6520X-30QC-EI` declared its 24 downlinks as
`type: ethernet, speed: 10G` with no connector, so `derivePortHardware()` fell back to its copper
default: all 24 `Ten-GigabitEthernet1/0/1-24` ports became RJ45 sockets carrying 10GBASE-T - and,
from the copper ladder, with 2.5G and 5G on them too. Does H3C's own documentation say those 24
ports are module slots, and what does the spec owe them?

**Verdict: settled - they are 1G/10G SFP+ cages, and the spec now says so.** The portTemplate
carries `"connector": "sfp+"`, so all 24 downlinks report an SFP+ cage offering 10GBASE-SR/LR/ER
and the 1G optics (including a 1000BASE-T copper SFP), train at 1G or 10G, and refuse a 10GBASE-T
RJ45 host. `test/h3c-s6520x-cages.test.js` pins it. The two 40G uplinks were already QSFP+ cages -
a bare 40G rate is read as optical by `inferCage()`, a bare 10G rate is not - and the test keeps
them that way.

## Evidence

| Source | Says |
| --- | --- |
| [H3C S6520X-EI Series datasheet (PDF, July 2020)](https://h3c.store/download/H3C_S6520X-EI_Datasheet.pdf) | Model list: "H3C S6520X-30QC-EI-provides **24 x 1/10G SFP+ ports**, **2 x QSFP+ ports** (40GE, can be split into four 10GE ports.), 2 x expansion slots, 2 x fan tray slots, and 2 x power module slots". Features: "It provides **48/24\*10/1GE autosensing SFP+ ports**, two QSFP28 or QSFP+ ports onboard, and two expansion slots". Specifications table: "Service ports: **24 x 1/10GE SFP+ fiber ports**; **2 x QSFP+ fiber ports** (for S6520X-30QC-EI)". |
| [H3C "01-Hardware Information and Specifications", S6520X-E series](https://www.h3c.com/en/Support/Resource_Center/EN/Home/Public/00-Public/Technical_Documents/Product_Literature/Hardware_Information___Specifications/H3C_S6520X_E-11670/202512/2727552_294551_0.htm) | Port census per model: for the S6520X-30QC-EI column, `QSFP+ port` = **2**, `SFP+ port` = **24**, `QSFP28 port` = N/A. Also "The S6520X-30QC-EI, S6520X-54QC-EI, S6520X-30QC-HI, and S6520X-54QC-HI switches and the LSWM2QP2P interface module provide QSFP+ ports" and "each provide two QSFP+ ports". |
| Same datasheet, transceiver list | Modules named for these cages: `SFP-GE-SX-MM850-A` (1000BASE-SX), `SFP-GE-LX-SM1310-A` (1000BASE-LX), `SFP-GE-T` (1000BASE-T SFP), `SFP-XG-SX-MM850-E` / `SFP-XG-LX-SM1310-E` / `SFP-XG-LH40-SM1550` (10G SFP+), `QSFP-40G-LR4` (40GBASE-LR4). |
| [H3C S6520X-30QC-EI reseller specification, network-switch.com](https://network-switch.com/products/h3c-s6520x-30qc-ei-switch-ns) | "24 x 10GE SFP+ access ports and 2 x 40GE QSFP+ uplinks ... Uplink Ports 2 x 40GE QSFP+ (breakout supported)". A third, independent restatement; it is a reseller page, so it is corroboration rather than authority. |

## What is known

1. All 24 downlinks are **SFP+ cages** taking 1G SFP and 10G SFP+ modules. H3C's spec sheet calls
   them "1/10GE SFP+ **fiber** ports", which rules out 10GBASE-T RJ45 sockets: the copper variant
   in this family is a different SKU, and this model has none.
2. The rate ladder is **1G and 10G** - "1/10G SFP+", "10/1GE autosensing" - which is exactly the
   ladder `CAGE_MEDIA['sfp+']` / `CAGE_RATES['sfp+']` already offers (`[1000, 10000]`).
3. The two uplinks are **QSFP+ (40GE)**, not QSFP28: the 30QC is the 40G model, the 30HC is the
   100G one.
4. A 1000BASE-T **copper SFP** module is in H3C's own list (`SFP-GE-T`), so the cage's offer of
   `1000base-t-sfp` is right for this box and not a generic assumption.

## What was changed

* `devices/h3c/s6520x-30qc-ei.json`: the portTemplate gains `"connector": "sfp+"`. Nothing else in
  the row changed - the same 24 names (`Ten-GigabitEthernet1/0/1-24`), the same `10G` speed, the
  same two `FortyGigE1/0/25-26` uplinks.
* `test/h3c-s6520x-cages.test.js`: all 24 downlinks are SFP+ cages and none is RJ45; each offers a
  10G and a 1G optic and no 2.5G/5G rate; a 10GBASE-T RJ45 host is refused by an empty cage; two
  downlinks meet over 10GBASE-SR at 10G; the cage meets a plain 1G SFP port over 1000BASE-SX at
  1G; two uplinks meet over a 40G DAC; a copper SFP takes an RJ45 host at 1G.

## What is inferred

* That every one of the 24 cages takes a 1G module. The datasheet says "24 x 1/10G SFP+" and
  "10/1GE autosensing" for the group as a whole; no document in hand says a subset is 10G-only,
  and the transceiver list has 1G modules for these cages.
* That the copper fallback's 2.5G/5G rates are wrong here. They follow from the `10gbase-t` RJ45
  medium in the engine, which is a 10GBASE-T socket's ladder; an SFP+ cage has no such rates, and
  no H3C document lists a 2.5G/5G SFP+ module for this model.

## What is unresolved

* **The 40G breakout is not modelled.** Both H3C documents say each QSFP+ port "can be split into
  four 10GE ports" with a QSFP+ to SFP+ splitter cable ("Max 72\*10GE supported on one single
  switch"). The catalogue row carries two 40G ports and no logical 10G children, which is the same
  shape every other breakout-capable switch in the catalogue has. Whether the simulator should
  offer split ports is a modelling question for the port model, not a fact about this row, and was
  left alone.
* **The two expansion slots are not modelled.** H3C sells "8-Port 10G SFP+ Interface Module",
  "2-port 25GE SFP28 interface module", copper 1/2.5/5/10GBASE-T modules and more for them, so a
  real chassis can carry up to 16-24 more ports. No fixed-configuration row in the catalogue has
  module bays; this one does not either. Adding them is a schema feature, not a fidelity fix.
* **Whether the 40G ports accept a 40GBASE-SR4 module** is not stated in the documents cited here
  (they list `QSFP-40G-LR4` only). The engine's QSFP+ cage offers `40gbase-sr4` as well; that
  offer is generic to the cage family and was not changed by this run.
