# A midspan's watts against the standard it names: 60 W is not 802.3at

**Question (one, narrow).** A single-port midspan injects exactly one standard's power, so its entry
states a standard and a wattage together. May an entry declare `802.3at` beside a 60 W PSE port (or a
90 W port and no standard at all) - and if not, what does each of the catalogue's three such entries
actually speak?

**Verdict: no, and the vendor pages say what they speak.** 802.3at's ceiling is 30 W at the PSE; 60 W is
802.3bt Type 3 and 90 W is 802.3bt Type 4. Three injected-power entries carried a wattage their declared
standard cannot reach: `microchip PD-9501GCO` and `phihong POE60U-1BT-2-R` declared `802.3at` alone beside
60 W ports, and `phihong POE90U-1BT-N6-R` declared no standard at all beside 90 W. All three products are
802.3bt on the vendor's own page. Corrected here; nothing about the power they inject changed.

## Evidence

| Source | Says |
| --- | --- |
| [Cisco Catalyst 9000 PoE Configuration Guide, Table 1](https://www.cisco.com/c/en/us/td/docs/switches/lan/c9000/infra/poe/poe-configuration-guide/g-poe/c-poe.html) | The ceilings, one row each: `IEEE 802.3af` Type 1 **15.4 W**, `IEEE 802.3at` Type 2 **30 W**, `IEEE 802.3bt` Type 3 **60 W**, `IEEE 802.3bt` Type 4 **90 W** (PoE, PoE+, PoE++, 4PPoE) |
| [Microchip PD-9501GCO product page](https://www.microchip.com/en-us/product/PD-9501GCO) | Heading: "1 port, 60W, IEEE 802.3bt outdoor PoE midspan". Compliance row: "IEEE 802.3bt type 3, IEEE 802.3af/at (PoE), RoHS Compliant, WEEE Compliant, CE". Prose: "guaranteeing 60 Watts of power" |
| [Phihong POE60U-1BT-2-R product page](https://www.phihong.com/products/power-over-ethernet/poe60u-1bt-2-r/) | "IEEE802.3bt PoE Injector - Single-Port - 60W - 2.5G"; features "Compliant with IEEE802.3bt Standard"; "Power/Port - 60" |
| [Phihong POE60U-1BT data sheet (PDF)](https://www.phihong.com/wp-content/uploads/POE60U-1BT-X-R.pdf) | Conversion table: "Detection Standards Output #1 - IEEE802.3af/at/bt, Output #2 - IEEE802.3af/at/bt, Output #1 & #2 - IEEE802.3.bt"; "Total Output Power 60W @ 40C, 30W @ 50C, 15W @ 60C" |
| [Phihong POE90U-1BT-N6-R product page](https://www.phihong.com/products/power-over-ethernet/poe90u-1bt-n6-r/) | "POE Injector 90W Midspan with SNMP - IEEE802.3bt - 1G"; "Output Power - 90W, Output Volt - 56V, Output Current - 1.6A, Power/Port - 90"; "IEEE802.3bt Compliant" |
| [Phihong POE90U-1BT-X data sheet (PDF)](https://www.phihong.com/wp-content/uploads/POE90U-1BT-X-R.pdf) | "90W Single Port Multi-Gig Power over Ethernet / IEEE802.3bt Compliant Power Injector"; "Total Output Power 90W"; 1.6 A at 56 V |

## What is known

1. **The ceilings are the standards'.** 15.4 / 30 / 60 / 90 W at the PSE for af / at / bt Type 3 / bt Type
   4. A 60 W port cannot be an 802.3at PSE, whatever else is true of the box.
2. **All three entries were 802.3bt products.** The vendors' pages name the standard in the product
   heading, not in a footnote: Microchip says "60W, IEEE 802.3bt"; both Phihong pages say "IEEE802.3bt".
   The 60 W Phihong's data sheet goes further and names the detection standards per output:
   `IEEE802.3af/at/bt`.
3. **The wattage was right and the standard was wrong.** Each entry's `poeOut` (60, 60, 90) matches the
   page ("Power/Port - 60", "Power/Port - 90"; "Total Output Power 90W"). Only the `capabilities` array
   was short.
4. **The rest of the catalogue already did this.** Every other 60 W/90 W PSE entry names `802.3bt` -
   the Allied Telesis X530 family, the Moxa EDS-G4012-8P, the Zyxel XGS2220s, the Netgear M4250s, the
   H3C S5130S-UPWR pair, the Cambium EX2016M-P and the Extreme X465-24MU-24W. These three were the
   exceptions, not a house convention.
5. **Two of the three files contradicted themselves before any vendor page was read.** Each of the
   three carries the bt *type* in `role` - `["midspan", "802.3bt-type-3"]` on the Microchip,
   `["802.3bt-type-3"]` on the 60 W Phihong and `["midspan", "802.3bt-type-4", "managed"]` on the
   90 W one - while `capabilities` said `802.3at`, or said nothing. Those are the only three entries
   in the catalogue that name a bt type in `role`, and the type they name is the one the well-known
   60 W / 90 W split describes, so the file already held the answer its `capabilities` contradicted.
6. **Silence is not a standard.** The four fixed-voltage midspans (`mikrotik RBGPOE`,
   `ubiquiti POE-24-24W`, `POE-48-24W`, and the passive classes on the EdgePoints) source 24 V or 54 V
   with no IEEE detection at all: `passive-poe`, no class word, no ceiling to measure against.

## What is inferred

* **`poeOut` is the PSE output figure**, which is the reading every other entry in the catalogue uses:
  a midspan's "Power/Port" row is what leaves the PSE, so it is compared with the PSE ceilings, not with
  the PD-side 51 W / 71.3 W figures.
* **Which standards to name when the sheet names several.** `802.3af` and `802.3at` are kept wherever the
  vendor names them, because a bt PSE is expected to detect and power an af/at PD. Microchip's compliance
  row names all three, so all three are declared. The 60 W Phihong's detection row names all three, so all
  three are declared. The 90 W Phihong's sheet names only bt, so only bt is declared - the same shape as
  `devices/moxa/eds-g4012-8p-4qgs-lvb-t.json`, which also declares bt alone.

## What changed

* `devices/microchip/pd-9501gco.json`: `["poe-injector", "802.3at"]` -> `["poe-injector", "802.3af",
  "802.3at", "802.3bt"]`, plus a note citing the page and the ceilings.
* `devices/phihong/poe60u-1bt-2-r.json`: same three standards, same reason.
* `devices/phihong/poe90u-1bt-n6-r.json`: `["poe-injector"]` -> `["poe-injector", "802.3bt"]`.
* `test/poe-injector-standard.test.js` (new, 37 checks): the rule over the whole catalogue - for every
  `poe-injector` spec, no negotiated-standard PSE port may exceed the highest standard the spec declares,
  and a midspan above 15.4 W that names no standard fails. It re-states the three pre-fix shapes as
  fixtures so the gate cannot go vacuous (measured against the previous commit: three failures, one per
  entry), reads the `802.3bt-type-N` token in `role` as a second ceiling (60 W for Type 3, 90 W for Type
  4) so a type-3 entry cannot claim a type-4 wattage, pins that a passive port is not measured against a
  standard, and pins the scope decision below by showing that the same rule applied to a switch would flag
  every one of its ports.
* `docs/DEVICE_SCHEMA.md`: one paragraph under the port-field table naming the gate and its scope.

## What is unresolved

* **A switch may pair "PoE+" with more than 30 W, and the schema cannot say so.** PLANET's IGS-5225-8P4S
  page states "802.3at/end-span PSE on ports 1-8, 36 W a port at the top of the range", and four entries
  carry that pairing (`IGS-5225-8P2S2X`, `IGS-5225-8P4S`, `IGS-5225-8P4S-12V`, and `GS-4210-48P4S`, which
  carries 36 W with no standard named at all). The wattage and the standard are both the vendor's, and
  neither is wrong on its own: 36 W is a proprietary over-power/Extend mode above the standard's 30 W
  ceiling. Measuring it the way midspans are measured would declare four correct entries wrong, so the
  gate is scoped to `poe-injector` and these four are left alone. What would settle it is a vendor
  statement of what the 36 W mode negotiates - whether it is class 4 at the standard's 30 W with a
  proprietary extension, or a bt class 5 - and a schema field to record it (no field exists today).
* **Where the bt type lives: `role` or `poeOutClass`?** The standards token `802.3bt` covers Type 3 (60 W)
  and Type 4 (90 W) alike, so a wattage ceiling alone cannot tell them apart. Two fields could: `role`,
  which these three entries already use (`802.3bt-type-3`, `802.3bt-type-4`, and no other entry in the
  catalogue names a type there), and `poeOutClass`, which `docs/DEVICE_SCHEMA.md` maps to the types
  (`PoE++` = Type 3, `PoE+++` = Type 4) but which the catalogue uses unevenly -
  `devices/allied-telesis/at-x530-10ghxm.json` calls 90 W ports `PoE++` while
  `devices/ubiquiti/ecs-24-poe.json` declares `PoE+++` - and `derivePortHardware()` drops it, so nothing
  reads either field. The test reads `role` because it is the only field these three actually populate;
  settling it needs a decision on which field is *the* type, then a census of every port whose class,
  role and wattage disagree (the 90 W ports classed `PoE++` are the first candidates).
* **Whether the af/at tokens mean "negotiates" or "compliant with".** They are descriptive today (no
  engine reader), so declaring them changes no packet. If a later increment ever reads them - a
  negotiation gate, say - the 90 W Phihong would then be the one bt injector that refuses an af PD, on
  the strength of its data sheet staying silent. No source in hand says whether it detects af.
