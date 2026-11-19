# A Catalyst 2960X-48FPS-L: how many ports source PoE+, and out of what budget?

**Question (one, narrow).** The catalyst 2960-X family has a "full PoE+" 48-port member, the
**C2960X-48FPS-L**. How many of its ports source power, at what per-port maximum, and what is the switch's
PoE budget — and does this catalogue's copy of that model actually source any?

**Verdict: 48 PoE+ ports, 30 W per port, 740 W budget — and the catalogue sourced nothing.** Its `description`
already claimed "48x 1G PoE+ downlinks (740 W budget)", but its `portTemplate` carried no `poeOut` and the spec
no `poe` block, so the device's budget was 0 W and

```
sw1> show power inline
% No PoE on Catalyst 2960X-48FPS-L-sw1: no port on this device can supply power
```

was the answer on a switch whose front panel is 48 PoE+ ports. An access point cabled to Gi1/0/1 stayed dark.
The spec now declares the PSE ports and the published budget, and `test/c2960x-48fps-poe.test.js` pins both the
hardware and the allocation.

## Evidence

| Source | Says |
| --- | --- |
| [Catalyst 2960-X Switch Hardware Installation Guide, "Product Overview", Table 1 — Switch Models and Descriptions](https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst2960x/hardware/installation/guide/b_c2960x_hig/b_c2960x_hig_chapter_01.html) | The model row, verbatim: "**Catalyst 2960X-48FPS-L** \| LAN Base \| 48 10/100/1000 PoE+ ports (PoE budget of **740 W**) and 4 SFP module slots." The same table gives the sibling 48LPS-L 370 W and the non-PoE 48TS-L, so the F/L digit is a budget, not a port count. |
| [Same guide, "Front Panel" → "PoE and PoE+ Ports"](https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst2960x/hardware/installation/guide/b_c2960x_hig/b_c2960x_hig_chapter_01.html) | "The maximum switch power output is either 740 W or 370 W, depending on the switch model. … For switches with a 740 W power budget, you can budget the PoE and PoE+: 15.4 W of PoE output on 48 ports; 30 W of PoE+ on 24 ports." That is the ceiling rule in the vendor's own words — 48 × 15.4 W = 739.2 W fits, 25 × 30 W = 750 W does not. |
| [Same guide, "Technical Specifications" → Specifications for the Catalyst 2960-X Switches](http://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst2960x/hardware/installation/guide/b_c2960x_hig/b_c2960x_hig_appendix_0100.html) | "30 W-per-port maximum, 740-W switch maximum (Catalyst 2960X-48FPD-L and 2960X-48FPS-L switches)". The per-port figure this catalogue's `poe.perPortW` records, and the pairing that puts the 48FPS-L in the 740 W group rather than the 370 W one. |

No third-party transcript of `show power inline` on this exact model was used: the engine's own view is not a
copy of a Cisco screen (`Interface / Admin / Oper / Draw / Powered device`, "Total: … W of … W in use"), so a
capture of the box's table would settle a different question than the one asked here.

## What the catalogue said, and what changed

`devices/cisco/c2960x-48fps-l.json`:

| Field | Was | Is |
| --- | --- | --- |
| `portTemplate.poeOut` | absent (null on all 48 downlinks) | `true` on Gi1/0/1-48 |
| `portTemplate.poeOutClass` | absent | `"PoE+"` |
| `poe.budgetW` | absent → budget 0 W, source `name` | `740`, source `research` |
| `poe.standard`, `poe.perPortW` | absent | `"802.3at"`, `30` |
| `poe.sourceUrl` | absent | the Product Overview page above |

The four SFP cages (Gi1/0/49-52) were and remain non-PSE: they are `sfp` cages and the engine's own rule
(`carriesPower` in `engine/media.js`) refuses power on any cage that is not `rj45`/`combo`, which is what a
box does too — a fibre uplink cannot source watts. The 48 downlinks keep the 10/100/1000 ladder the template
already derived.

## What the console answers now

With a single 25.5 W 802.3at access point on Gi1/0/1, and nothing configured (PoE is on before any command):

```
sw1> show power inline
Interface  Admin  Oper  Draw     Powered device
Gi1/0/1    auto   on    25.5 W   HPE Aruba Networking AP-515-ap1
47 ports with nothing plugged in: Gi1/0/2, Gi1/0/3, Gi1/0/4, Gi1/0/5, Gi1/0/6 (+42 more)

Total: 25.5 W of 740 W in use, 714.5 W left, nothing denied
```

Thirty of them power 29 and deny the thirtieth, at Gi1/0/30, because 29 × 25.5 W = 739.5 W and the next 25.5 W
would pass 740 W:

```
  Gi1/0/30: PSE budget exhausted: 25.5 W requested, 0.5 W left
```

That denial sentence and the `poe-deny` event are pre-existing engine behaviour (`engine/simulator.js`,
`computePoe()`); this run only gave the hardware a real budget to spend. A 24-AP fleet draws 612 W and is
powered whole, which is the vendor's "30 W of PoE+ on 24 ports" shape.

## Known, inferred, unresolved

**Known.** 48 ports source PoE+; 30 W per port maximum; 740 W switch maximum; the four SFP slots are not PSE
ports. The vendor states each in the installation guide, and the two numbers reproduce the budgeting sentence
(15.4 W × 48 = 739.2 W; 30 W × 24 = 720 W, with 25 × 30 W over the line).

**Inferred.** That the 48 downlinks are all PoE+ capable rather than a mix: Table 1 says "48 … PoE+ ports" and
the front-panel section budgets across 48 ports, so none is a non-PoE uplink in the copper group.

**Unresolved.**

* **The exact `show power inline` table a real 2960X prints** — its column headings, class letters and the
  "Available:740.0(w) Used:0.0(w) Remaining:740.0(w)" totals line. This console has its own words there; no
  capture from this model was found, and inventing one was not worth a guess.
* **Class-based reservation.** The engine allocates in port order until the budget runs out. Whether a real
  box reserves per class, refuses a class it cannot guarantee at request time, or answers the PD with a
  lower class, is not stated in the pages read.
* **The other 2960-X PoE members.** 48LPS-L, 24PS-L and the -PD variants are not in the catalogue, so their
  370 W budgets are not encoded. Adding them is a device request, not a fidelity fix.

**What would settle the first two.** A `show power inline` capture from a C2960X-48FPS-L under partial load,
and the same box's behaviour when the 25th 30 W device asks for power.
