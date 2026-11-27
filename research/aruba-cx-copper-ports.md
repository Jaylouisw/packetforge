# The Aruba CX access switches: is every "G" port an RJ-45?

**Question (one, narrow).** Issue #1398 counts template ports whose connector nothing declares. Ten
Aruba CX specs generated their access ports from a portTemplate that said only
`type: ethernet, speed: 1G` — CX 6000 24G/48G (plain and Class 4 PoE), CX 6200F 24G/48G (plain and
PoE), CX 6300M 48G (plain and PoE). Does HPE state the physical port for those models, and does it
train at 10 and 100 as well as 1000?

**Verdict: settled — every one of the ten is 10/100/1000BASE-T, i.e. an RJ-45 jack with a
[10, 100, 1000] ladder.** HPE's description line for each model opens with the port count and the
rate set, in exactly those words. The "G" in the model name is the third rate, not a product tier.

## Evidence

| Source | Says |
| --- | --- |
| [HPE Networking CX6000 Switch Series data sheet, a00112996enw](https://www.hpe.com/psnow/downloadDoc/HPE%20Networking%20CX6000%20Switch%20Series-a00112996enw.pdf?id=a00112996enw&isFutureVersion=true&ver=1&form=false&preview=false&hf=regular&isLinearized=false&contentDisposition=attachment) (Technical specifications, model rows) | R8N85A/R8N86A: "48x 10/100/1000BASE-T Class 4 PoE ports" / "48x 10/100/1000BASE-T ports 4x 1G SFP ports"; R8N87A/R8N88A: "24x 10/100/1000BASE-T ports 4x 1G SFP ports". Same data sheet, features: "Auto-MDIX provides automatic adjustments for straight-through or crossover cables on all 10/100/1000 ports". |
| [HPE Aruba Networking CX 6200F Switch Series — Specifications, a00099581en_us](https://support.hpe.com/hpesc/public/docDisplay?docId=a00099581en_us&docLocale=en_US) (I/O Ports row) | JL724A: "24x ports 10/100/1000BASE-T ports 4x 1/10G SFP Ports"; JL725A: "24x 10/100/1000BASE-T Class 4 PoE ports … 4x 1/10G SFP Ports"; JL726A: "48x Ports 10/100/1000BASE-T ports 4x 1/10G SFP Ports"; JL727A: "48x 10/100/1000BASE-T Class 4 PoE ports … 4x 1/10G SFP Ports". |
| [HPE Aruba Networking CX 6300 Switch Series QuickSpecs, a00073540enw](https://www.hpe.com/us/en/collaterals/collateral.a00073540enw.html) (Technical specifications) | JL663A: "48x ports 10/100/1000 BaseT ports 1G/10G/25G/50G SFP ports"; JL661A: "48x 10/100/1000 BASE-T PoE+ ports supporting up to 30W per port 4x 1G/10G/25G SFP ports". |
| [Aruba CX 6300 series product page](https://www.arubanetworks.com/es/productos/switches/6300-series/) | JL663A: "48 puertos 10/100/1000BaseT" (Spanish edition of the same model row; cited only as the second vendor page naming the rate set for JL663A). |

"10/100/1000BASE-T" is three clauses, not one: 10BASE-T, 100BASE-TX and 1000BASE-T are the three
media the port negotiates, and all three are defined over twisted pair with an RJ-45 plug
(engine/media.js MEDIA rows 10base-t, 100base-tx, 1000base-t, each connector: rj45). That is
exactly CAGE_SPEEDS.rj45, so the declared ladder and the cage agree without a special case.

## What was changed

Ten specs, portTemplate only — 384 ports:

| Spec | Template count |
| --- | --- |
| devices/aruba/cx-6000-24g-4sfp.json | 24 |
| devices/aruba/cx-6000-24g-cl4-poe-4sfp-370w.json | 24 |
| devices/aruba/cx-6000-48g-4sfp.json | 48 |
| devices/aruba/cx-6000-48g-cl4-poe-4sfp-370w.json | 48 |
| devices/aruba/cx-6200f-24g-4sfp.json | 24 |
| devices/aruba/cx-6200f-24g-cl4-poe-4sfp.json | 24 |
| devices/aruba/cx-6200f-48g-4sfp.json | 48 |
| devices/aruba/cx-6200f-48g-cl4-poe-4sfp.json | 48 |
| devices/aruba/cx-6300m-48g-4sfp56.json | 48 |
| devices/aruba/cx-6300m-48g-cl4-poe-4sfp56.json | 48 |

Each gains "connector": "rj45" and "speedCaps": [10, 100, 1000], the shape
devices/aruba/cx-6100-48g-4sfp.json already used for the same copper rows. Port names, counts,
uplinks and PoE blocks are untouched: a declaration is added to a template that previously described
its ports only by rate, so the audit's "template ports whose connector nothing declares" report drops
from 1,750 ports in 86 specs to 1,366 in 76 — and nothing about the models moves.

test/aruba-cx-copper-ports.test.js pins the family: the declaration, the expanded cage and ladder,
that a 1000BASE-T patch cord meets two of these ports at 1G, that 100BASE-TX meets them at 100M, and
that a fibre optic into an access port is refused as a connector mismatch instead of being accepted.
It fails on all ten specs before this change (they declare no connector at all) and passes after.

## What is inferred

* That 10/100/1000BASE-T means an RJ-45 jack. The media definitions carry that themselves — a
  BASE-T link does not exist on another connector — so this is the datasheet's own sentence read
  through the engine's medium table, not a guess about the box.
* That no access port is faster than 1000. HPE lists 1G access plus SFP uplinks for these ten; a
  2.5G or 5G access row is spelled "100M/1G/2.5G/5G BASE-T" as the CX 6300 Smart Rate models are,
  and none of these ten is one of those.

## What is unresolved

* **The 6200F uplinks contradict their own datasheet.** a00099581en_us says "4x 1/10G SFP Ports" for
  JL724A to JL727A, but the cx-6200f specs give uplink port 25 (or 49) speedCaps [1000, 10000] and
  its three siblings [10000] — the same residue #1066 fixed on the 2930F, on a different family.
  Twelve ports, and a 1G SFP is refused on three of the four uplinks. Left out of this pass to keep
  it to #1398's copper templates; it needs its own PR.
* **The 6300M uplinks declare no connector either.** The four SFP56 ports on each 6300M 48G are
  speed: 25G with no connector and no speedCaps, so they infer sfp28 from the rate and stop at 25G.
  HPE says the group is "1G/10G/25G/50G SFP ports" (50G over DAC). They are explicit interfaces,
  not template ports, so #1398's counter does not include them.
* **CX 6405 (R0X30A with one R0X39B line module)** declares 48 ports at 1/1/ — line-card ports on a
  chassis, so the copper claim has to come from the module's data sheet rather than the switch's. It
  has its own row in the same report and is left for a run that reads R0X39B.
* **Aruba Instant On 1930 24G** is a different product line with its own data sheet; also still in
  the report.
