# EdgePoint family PoE census (EP-R6, EP-R8, EP-S16)

Three members, one datasheet, one family - a WISP control point whose whole purpose is powering
the radio above it. Read 2026-11-19 in two increments on the catalogue stream under #130's
fallback list (a router/gateway node for a routed lab: NAT, DHCP, VPN).

## EP-S16: sixteen PSE ports that could light nothing, and the four strongest filed as the weakest

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
  model on adjacent pages - page 6 is the EP-R6, page 7 the EP-R8, page 9 the EP-S16 (the printed
  footer number on each page; page 8 is the EdgeOS software table, and an earlier note in this file
  cited it for the S16 hardware rows) - so lifting
  "40 W max" from page 6 onto the R6, or the R6's five 24 V outputs onto the S16, is the same
  one-table-two-models trap as the Dream Wall's non-Pro datasheet.

## EP-R6 and EP-R8: the rest of the family, done

Read the same day, after the S16 landed. Both members were still unable to power the radio they
exist for, in two different ways.

### Sources (both surfaces, 2026-11-19)

| source | result |
|---|---|
| `https://dl.ui.com/datasheets/edgemax/EdgePoint_DS.pdf` | 200, `application/pdf`, 6,571,516 B, 12 pp, text layer; page 6 = EP-R6, page 7 = EP-R8, page 9 = EP-S16 |
| `https://techspecs.ui.com/uisp/wired/ep-r6` | 200, 577,753 B, server-rendered table (not the 609,911 B front page) |
| `https://techspecs.ui.com/uisp/wired/ep-r8` | 200, 578,035 B, same rows as the PDF |

### Vendor rows

| | EP-R6 (page 6) | EP-R8 (page 7) |
|---|---|---|
| data ports | `(5) 10/100/1000 RJ45 Ports`, `(1) 1 Gbps SFP Port` | `(6) 10/100/1000 RJ45 Ports`, `(2) 10/100/1000 RJ45/SFP Combination Ports`, `(1) RJ45 PoE In Port`, `(1) RJ45 Serial Port` |
| PoE output | `(5) 24V / 0.7A, 2-Pair (+4, 5; -7, 8) Passive PoE, eth0 to eth4` = 16.8 W x 5 | `(2) 54V or 24V / 1.4A, 4-Pair ... eth1 to eth2` = 75.6 W; `(5) 24V / 0.7A, 2-Pair ... eth3 to eth7` = 16.8 W |
| PoE input | `(1) 24V / 1.4A, 4-Pair ... eth0` | `(2) 54V / 1.5A, 4-Pair ... eth0 and PoE In` (`PoE In is DC Only, No Data`) |
| max consumption | `7W (Excludes PoE output)` | `40W (Excludes PoE output)` |
| DC input | `24V DC, 3A` = 72 W | `54V DC, 6A` = 324 W |
| derived budget | 72 - 7 = **65 W** | 324 - 40 = **284 W** |

Per-port watts are the vendor's own voltage x current rows, not a negotiated class: **no EdgePoint
prints an 802.3af/at row.** A 48 V 802.3 PD on any of these ports will not negotiate - the UISP
Router defect (`test/uisp-r-poe.test.js`) on the same vendor's passive-PoE line. Both budgets are
DERIVED and say so in `poe.note`, with the PoE-input alternative recorded (R6 on 24V/1.4A:
33.6 - 7 = 26.6 W; R8 on two 54V/1.5A inputs: 162 - 40 = 122 W).

### What was wrong

| spec | was | now |
|---|---|---|
| `ep-r6.json` | `poe-pse` claimed, **zero PSE ports**; no `poe` block; no `10M` rung | 5 x `poeOut: 16.8` passive, `poe.budgetW 65`, `poeIn: 7` on eth0 |
| `ep-r8.json` | `poeOut: true, poeOutClass: "PoE"` on **eth0 and eth1 only** - eth0 is the vendor's PoE *input* port, and "PoE" is 802.3af, which this chassis has nowhere - while eth2-eth7 (five real PSEs) were dry; no `poe` block; `poe-pd` missing | eth0 `poeIn: 40` and no output; eth1-eth2 `poeOut: 75.6` passive; eth3-eth7 `poeOut: 16.8` passive; `poe.budgetW 284`; `poe-pd` declared |

With no `poe` block, `computePoe()` opens with `if (!dev.poeBudget) continue;`, so both boxes were
*skipped* rather than reported unknown. `scripts/audit-poe-budget.js` counted the EP-R8 among its
silent PSEs (102 -> 101) and could not count the EP-R6 at all, because that row declared no PSE
port to be silent about - the audit can only count ports that exist.

`test/poe-inference.test.js` had EP-R6 in its `PD_ONLY` list, which it entered on the strength of
its own description ("Passive PoE-in") rather than the vendor's table. It leaves that list the way
ER-10X did, and is pinned by its own assertion instead; `test/edgepoint-poe.test.js` pins both rows.

### Traps

- **`dl.ui.com` answers 200 with the front page for keys it does not have.** `qig/ep-r8.pdf`,
  `qig/ep-r8`, `guides/edgemax/EdgePoint_QSG.pdf`, `guides/edgemax/EdgePoint_R8_QSG.pdf` and
  `guides/edgemax/EdgePoint_DS.pdf` all return the identical **609,911 B** HTML page, so a 200 on
  that host proves nothing.
- **Which two R8 copper positions are the RJ45/SFP combination ports is not published.** The
  datasheet gives the count and the PoE rows name `eth0`-`eth7`, but nothing pairs a position with
  `sfp1`/`sfp2`. The pairing is left undeclared rather than guessed: ten links into eight positions
  is exactly the bug a guessed `comboWith` causes. Panel artwork with readable labels, or the EdgeOS
  default config, would let it be declared.
- **The R8's separate "PoE In" RJ45 is not an interface** - "PoE In is DC Only, No Data", a power
  inlet like the DC terminal block.
- **`Power supply Min. 54V / 0.8A`** is the minimum *adapter*, not the input ceiling; the budget
  uses `54V DC, 6A input`. Reading the smaller row would give a 3 W PoE envelope.
