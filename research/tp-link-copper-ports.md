# The TP-Link Omada access switches: is every access port an RJ-45?

**Question (one, narrow).** Issue #1398 counts template ports whose connector nothing declares.
Six TP-Link specs generated their access ports from a portTemplate that said only
`type: ethernet, speed: 1G` — TL-SG2210MP (8 ports), TL-SG3428 and TL-SG3428X (24 each),
TL-SG3428XMP (24), TL-SG3452 and TL-SG3452X (48 each). Does TP-Link state the physical port for
those models, and does it train at 10 and 100 as well as 1000?

**Verdict: settled — every one of the six is 10/100/1000BASE-T, i.e. an RJ-45 jack with a
[10, 100, 1000] ladder.** TP-Link's Interfaces row opens with the port count and the rate set in
exactly those words, and the SFP/SFP+ slots are a separate column of the same row.

## Evidence

TP-Link product pages, Specifications → Interfaces (read 2026-11-27). The quotes below are the
Interfaces row of each model's spec table; they are transcribed here rather than linked because
the pages are re-published per hardware version and the row, not the URL, is what the catalogue
asserts.

| Model | Interfaces row | PoE row |
| --- | --- | --- |
| TL-SG2210MP | "8x 10/100/1000 Mbps RJ45 Ports, 2x Gigabit SFP Slots" | "PoE+ Ports: 8 Ports", "PoE Power Budget: 150 W", "up to 30 W on each port" (802.3af/at) |
| TL-SG3428 | "24x 10/100/1000 Mbps RJ45 Ports, 4x Gigabit SFP Slots" | — |
| TL-SG3428X | "24x 10/100/1000 Mbps RJ45 Ports, 4x 10G SFP+ Slots" | — |
| TL-SG3428XMP | "24x 10/100/1000 Mbps RJ45 Ports, 4x 10G SFP+ Slots" | "PoE+ Ports: 24 Ports", "PoE Power Budget: 384 W" |
| TL-SG3452 | "48x 10/100/1000 Mbps RJ45 Ports, 4x Gigabit SFP Slots" | — |
| TL-SG3452X | "48x 10/100/1000 Mbps RJ45 Ports, 4x 10G SFP+ Slots" | — |

"10/100/1000BASE-T" is three clauses, not one: 10BASE-T, 100BASE-TX and 1000BASE-T are the three
media the port negotiates, all defined over twisted pair with an RJ-45 plug (engine/media.js MEDIA
rows 10base-t, 100base-tx, 1000base-t — each `connector: rj45`). That is exactly CAGE_SPEEDS.rj45,
so the declared ladder and the cage agree without a special case.

## What was changed

Six specs, 176 template ports, plus the 12 SFP/SFP+ uplinks those templates do not cover:

| Spec | Template count | Uplinks |
| --- | --- | --- |
| devices/tp-link/tl-sg2210mp.json | 8 | 2x SFP, was silent |
| devices/tp-link/tl-sg3428.json | 24 | 4x SFP, was silent |
| devices/tp-link/tl-sg3428x.json | 24 | 4x SFP+ (already declared) |
| devices/tp-link/tl-sg3428xmp.json | 24 | 4x SFP+ (already declared) |
| devices/tp-link/tl-sg3452.json | 48 | 4x SFP, was silent |
| devices/tp-link/tl-sg3452x.json | 48 | 4x SFP+ (already declared) |

Each template gains `"connector": "rj45"` and `"speedCaps": [10, 100, 1000]`. The ten 1G SFP
uplinks on the three SFP models gain `"connector": "sfp"` and `"speedCaps": [1000]`: they are
explicit interfaces, so #1398's counter never saw them, but their cage was inferred from the port
name just the same — the name was simply right. Port names, counts and uplink ladders are
untouched, so the audit's "template ports whose connector nothing declares" report drops from
1,366 ports in 76 specs to 1,190 in 70 and nothing about the models moves.

**One defect found while transcribing:** TL-SG2210MP's description claimed "8x 1G PoE+
(802.3af/at, 150 W budget)" while the spec had no `poe` block and no `poeOut` anywhere, so the
model could not power a single device — `sw.poeBudget === 0` and the PSE allocation table was
empty. The template now declares `poeOut: 30` and the chassis declares `poe: { budgetW: 150 }`,
matching the datasheet's per-port ceiling and supply figure.

test/tp-link-copper-ports.test.js pins the family: the declaration for all six, a vendor-wide
sweep over devices/tp-link/*.json (no template may leave its connector to inference — the
regression guard for #1398), the expanded cage and ladder on every access port, a copper patch
cord between two access ports, a fibre uplink refused in an access jack, the uplink cages and
ladders unchanged, PoE on the two PoE models, and a real PD powered off Gi0/1 on the 2210MP.
It fails 27 of 58 assertions before this change and passes all 58 after.

## What is inferred

* That 10/100/1000BASE-T means an RJ-45 jack. The media definitions carry that themselves — a
  BASE-T link does not exist on another connector — so this is the datasheet's own sentence read
  through the engine's medium table, not a guess about the box.
* That the 1G SFP slots on the three SFP models are 1000BASE-X only. TP-Link calls them "Gigabit
  SFP Slots", and the product does not list 100M SFP support; a 100M optic is therefore refused
  there. This is the same reading the SFP+ models already carried (`[1000, 10000]`).

## What is unresolved

* **TL-SG2210MP is `capabilities: ["l2-forward", "http-server"]` with no CLI** — correct for an
  Omada web-managed switch, but it also means the model has no `cli` capability while its label
  says "web-managed smart switch". Nothing to declare here; recorded so the next reader does not
  "fix" it into a CLI box.
* **Cabling a PoE passthrough PD into a PoE+ port is refused with a nonsense message.**
  `TP-Link EAP225-Wall PoE budget exceeded: 1 powered port draw 15.4 W of a 13 W budget (1/1/1)` —
  the AP's 13 W *output* budget is charged the *switch's* port draw, because
  engine/validation.js `pseDraw()` walks the whole `connecting` list without checking that each
  port belongs to the device being budgeted. Any wall-plate AP or passthrough camera is affected.
  This pass added `poeOut` to the 2210MP and so made the bug reachable from one more switch; it is
  a validation defect, not a data one, and is filed separately.
