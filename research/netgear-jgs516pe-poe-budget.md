# JGS516PE: which sockets carry power, over what standard, out of how many watts

**Question (one, narrow).** The NETGEAR JGS516PE is a 16-port gigabit "smart managed plus" switch.
How many of its ports are PoE ports, are they 802.3af (15.4 W) or 802.3at (PoE+, 30 W), and what is
the switch's total PoE budget?

**Verdict: eight ports (1-8), 802.3af at 15.4 W, sharing 85 W.** The catalogue was wrong on all
three counts. It declared `poeOut: true, poeOutClass: "PoE+"` on eight ports and said nothing about
the other eight - and on a `poe-pse` switch the engine fills a silent copper port with 802.3af, so
all sixteen sourced power. It also carried no `poe` block, so `show power inline` answered "budget
not modelled" and the allocator counted no watt. NETGEAR's own two documents state the subset, the
standard and the budget in one place each.

## What the vendor publishes

| Source | Says |
| --- | --- |
| [JGS516PE/JGS524PE installation guide, Specifications](https://www.downloads.netgear.com/files/GDC/JGS516PE/JGS516PE_JGS524PE_IG_EN.pdf) | "Ports: **JGS516PE: 16, of which ports 1-8 are PoE ports**"; "Power budget: **JGS516PE: 15.4W per port for ports 1-8. Maximum power budget for the switch: 85W**"; "Power consumption: JGS516PE: 110W maximum with PoE". The same table gives the 24-port sibling 15.4 W on ports 1-12, a 100 W budget and 123 W maximum consumption. |
| [Gigabit Ethernet Plus Switches data sheet, "Hardware at a Glance"](https://www.netgear.com/images/datasheet/switches/gigabit_ethernet_plus_switches_ds.pdf) | The JGS516PE row: 16 x 10/100/1000 Base-T RJ45, **"PoE 802.3af Ports" = 8**, internal PSU, **PoE budget 85W**. The JGS524PE row beside it: 24 copper, 12 PoE 802.3af ports, 100W. |
| [NETGEAR's Japanese edition of the same sheet](https://www.netgear.com/jp/images/datasheet/switches/Gigabit_Ethernet_Smart_Managed_Plus_Switches_DS.pdf) | The identical JGS516PE row: 16 ports, 8 802.3af PoE ports, 85W. |
| [NETGEAR product listing as carried by ProVu](https://www.provu.co.uk/netgear-jgs516pe.html) | "8 Port PoE (IEEE 802.3af Power over Ethernet)"; "Total 85W PoE Power budget". |
| [The data sheet's older mirror on a reseller site](https://www.provu.co.uk/products/netgear/JGS516PE/JGS516PE.pdf) | The front/rear diagram and the same table: "JGS516PE | Rackmount | 16 | 8 | Internal | 85w". |

The contradiction the old `notes` field recorded - "85 W and 123 W both appear" - has a single
explanation on one page: **123 W is the JGS524PE's maximum power consumption with PoE**, printed in
the sentence directly below the JGS516PE's 110 W. It is not a budget, and it is not this model's
number. A budget of 123 W would also be impossible for a box whose whole worst-case draw is 110 W.

## What the engine did

Measured on `22ae1f92` (main) with the pre-change spec, before this fix:

```
PSE ports: 16 budget 0 name
Interface Admin  Supplied
ge1       auto   not measured
...
ge16      auto   not measured
budget not modelled on NETGEAR JGS516PE-sw1: the ports are reported, the power they could supply is not
```

Two separate faults produced that table: the silent ports on a `poe-pse` switch (`isPoePse()` in
`engine/media.js`, which treats every copper port of a PoE switch as a source), and the absent
`poe.budgetW`, which leaves `Device.poeBudget` at 0 and `_showPowerInline()` with no allocation to
report. `scripts/audit-poe-budget.js` counted this model under "PoE out, no budget, no never-published
marker" - 16 PSEs, one of the 38 the audit named.

## What changed

* `devices/netgear/jgs516pe.json`: ports `ge1`-`ge8` are `poeOut: true, poeOutClass: "PoE"`;
  `ge9`-`ge16` are explicitly `poeOut: false` (the engine's inference no longer has a silence to
  fill); `poe.budgetW = 85` with the installation guide as `sourceUrl` and its two rows quoted in
  `poe.note`; the `802.3at` capability is gone, `802.3af` remains; `notes` and `description` say
  eight 802.3af ports and 85 W and explain where the 123 W claim came from.
* `test/netgear-jgs516pe-poe.test.js` (28 checks): the spec's budget, source, class and description;
  exactly eight PSE ports, named ge1-ge8, the rest not; `poeBudget === 85` with source `research`;
  eight 12.95 W access points where six are funded (77.7 W) and the seventh and eighth are refused
  with `PSE budget exhausted: 12.95 W requested, 7.3 W left`; the `Available:85.0(w)` line, the
  `power-deny` rows and the under-table sentences; `show power inline ge9` refusing a non-PSE socket
  and `ge17` refusing a port the model does not carry.

`scripts/audit-poe-budget.js` now reports **37** silent PoE models, not 38.

## What is inferred, not published

* **That ports 1-8 are the leftmost eight sockets on the panel.** The installation guide numbers
  them "ports 1-8" and the data sheet's front diagram shows eight powered sockets together; which
  physical position each number occupies on the faceplate is not modelled by this file, whose ports
  are named `ge1`-`ge16` in order.
* **That the per-port ceiling is 15.4 W and not a per-port configurable limit.** The class is
  recorded (`PoE`), not a wattage, which is the form `docs/DEVICE_SCHEMA.md` asks for; the budget
  arithmetic spends the powered device's own draw, so 15.4 W never appears as a number in a view.
* **That the data sheet's 85 W is the internal supply's budget as shipped.** No PoE module or
  external supply is offered for this SKU in either document, so there is no second figure to
  exclude.

## What remains unresolved

* **What the box's own management UI reports as "available" power.** The installation guide
  documents a "PoE Max" LED that lights below 7 W remaining, which implies a reservation the 85 W
  figure does not show; no capture of the web UI's power page was found, so the simulator prints
  the data-sheet budget and does not pretend to be the GUI.
* **Whether a later hardware revision changed the class.** The documents above are the only
  NETGEAR sources found; every one says 802.3af, 15.4 W, 85 W, and no v2 datasheet was located. A
  unit label reading "PoE+" would settle it the other way, and nothing in hand does.
* **The 24-port sibling's class on this catalogue's terms.** The JGS524PE (12 PoE ports, 100 W,
  also 802.3af) is not in the catalogue at all, so there was no second entry to keep in step; that
  is a census gap, not part of this question.
