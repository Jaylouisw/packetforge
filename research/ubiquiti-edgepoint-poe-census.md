# EdgePoint S16: sixteen PSE ports that could light nothing, and the four strongest filed as the weakest

Read 2026-11-19, one increment on the catalogue stream, under #130's fallback list (a
router/gateway node for a routed lab: NAT, DHCP, VPN). The EdgePoint S16 is the switching member
of the same WISP control-point family and it sat in the catalogue as a **silent PSE**: sixteen
`poeOut` ports, no `poe` block, so `engine/simulator.js` opened with `if (!dev.poeBudget) continue;`
and skipped the whole box. Not "unknown" - skipped. `show power inline` had nothing to report and
no airMAX radio on the tower could be powered.

## What Ubiquiti prints

| | EP-S16 |
|--|--|
| datasheet | <https://dl.ui.com/datasheets/edgemax/EdgePoint_DS.pdf> (200, `application/pdf`, 6,571,516 B, 12 pp, "Models: EP-R6, EP-R8, EP-S16") |
| tech-spec page | <https://techspecs.ui.com/uisp/wired/ep-s16> (200, 577,761 B - not the 609,911 B front page) |
| Data ports | `(16) 10/100/1000 RJ45 Ports` + `(2) 1/10 Gbps SFP+ Ports` + `(1) RJ45 Serial Port` |
| Passive PoE input | `(2) 54V / 1.5A, 4-Pair (+1, 2, 4, 5; -3, 6, 7, 8)`, ports 1 and 2 |
| Passive PoE output | `(4) 54V or 24V / 1.4A, 4-Pair`, ports **1-4**; `(12) 802.3af/at or 24V / 0.7A, 2-Pair`, ports **5-16** |
| Power method | `(1) DC terminal block, 54V DC, 6A input`; `Power supply Min. 54V / 0.8A (Excludes PoE output)` |
| Max. power consumption | `40W (Excludes PoE output)` |

The rendered tech-spec table prints the second output row as `(12) PoE/PoE+ or 24V/0.7A, 2-pair`,
which is the same claim in the page's own vocabulary.

## Two defects, one root

1. **The class split was inverted.** The row said `poeOutClass: "PoE"` on eth0-eth3 and `"PoE+"` on
   eth4-eth15. But ports 1-4 are the *passive* 54/24 V 4-pair ports at 1.4 A (75.6 W at 54 V), while
   ports 5-16 are the ones that actually negotiate 802.3af/at. So the four highest-power ports were
   filed as the weakest, and a lab cabling a 48 V 802.3af phone into port 1 was told it would work
   on hardware with no 802.3 detection at all. This is the UISP Router defect again
   (`test/uisp-r-poe.test.js`), on the same vendor's passive-PoE line.
2. **No budget.** Neither surface prints a "PoE budget" row, exactly as for the ER-6P/ER-12P and the
   UISP Router. Both print a supply rating and a draw marked *excluding PoE output*, so the envelope
   is arithmetic on two published numbers: `54 V x 6 A = 324 W` in, less the `40 W` the switch draws,
   leaves **284 W** for the sixteen ports. Recorded as derived, in `poe.note`, with the alternative
   configuration spelled out: fed only by its two 54 V/1.5 A PoE inputs (2 x 81 W), the same box has
   at most 162 - 40 = 122 W for its own ports, so a lab that powers it that way states its own figure.

Ports 1-2 also became PoE **inputs** (`poeIn: 40`, the vendor's max consumption - the 1.5 A row is the
port's input capacity, not a draw), so cabling the switch to a PoE source powers it instead of
reporting an unpowered box. `l2-forward` was added: the datasheet calls the EP-S16 "Layer-2 switch
with some layer-3 capabilities", and it lists Static/PBR routing, so `l3-forward` stays too.

## Traps, so they are not re-walked

- `dl.ui.com/datasheets/edgemax/EdgePoint_DS.pdf` is the **one** live path. `EdgePoint_S16_DS.pdf`,
  `EP-S16.pdf`, `EdgePoint_S16.pdf` and `datasheets/edgemax/EP-S16_DS.pdf` all answer **302** into
  the 609,911-byte tech-spec front page, which reads as a document if you only check for 200.
- The datasheet is a **three-model** document (EP-R6, EP-R8, EP-S16). The PoE tables differ per
  model on adjacent pages - page 5 is the EP-R6, page 6 the EP-R8, page 8 the EP-S16 - so lifting
  "40 W max" from page 6 onto the R6, or the R6's five 24 V outputs onto the S16, is the same
  one-table-two-models trap as the Dream Wall's non-Pro datasheet.

## The siblings, still silent or still thin

Same datasheet, not done here (one device per increment):

- `devices/ubiquiti/ep-r6.json` - **five** 24 V/0.7 A passive outputs (`eth0 to eth4`), one 24 V/1.4 A
  4-pair input on eth0, `7W (Excludes PoE output)`, `24VDC, 3A` input. The row declares **no**
  `poeOut` at all today, so its five PSE ports are missing, not mislabelled.
- `devices/ubiquiti/ep-r8.json` - seven outputs (`eth1-eth2` 54/24 V 1.4 A 4-pair; `eth3-eth7`
  24 V/0.7 A), two 54 V/1.5 A 4-pair inputs (`eth0` and the no-data "PoE In" port), `40W (Excludes
  PoE output)`, `54VDC, 6A` input. The row has two `poeOut` ports, both labelled `"PoE"`, and no
  budget. Its ports 7-8 are **RJ45/SFP combination** cages and the spec has no `comboPorts` entry,
  so a lab can currently cable `eth6` and `sfp1` as if they were two ports.
