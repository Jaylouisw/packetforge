# The Peplink PSW switches: is the number in the model name the box's PoE budget, or a PSU-upgraded ceiling?

**Question (one, narrow).** `scripts/audit-poe-budget.js` reports exactly three devices whose PoE budget is
parsed from the model string rather than read from a document: `PSW-24-850W` (850 W), `PSW-48-800W` (800 W)
and `PSW-8-240W-RUG` (240 W). For the two big PSW switches the name and the datasheet agree. For the rugged
8-port they do not: Peplink's own specification row gives the box **90 W**, with 240 W described as an
upgrade. So: what does a PSW-8-240W-RUG supply out of the box, is 240 W reachable without buying anything,
and does `show power inline` on the modelled device print the right ceiling?

This note covers the family only. It does not touch the per-port class (30 W, 802.3at on all three) or the
catalogue's other Peplink routers, whose budgets come from a different document and a different rule.

**Verdict: 90 W as shipped; 240 W is the ceiling with an additional 180 W PSU that is not in the box.** The
24-port's 850 W and the 48-port's 800 W are correct as shipped - both SKUs bundle the three power supplies
that number assumes. The catalogue's 240 W is therefore the model name talking, not the box, and it is what
`show power inline` prints today.

## The 8-port

Two generations of Peplink's own rugged datasheet print the same pair of numbers, and the pairing is the
whole answer: a budget, and a parenthesised ceiling.

* SD Switch datasheet, ref `sdswitch-201811-v5`
  (<https://download.peplink.com/resources/peplink_switch_datasheet.pdf>, PDF dated 2019-11-28), ordering
  table:

  > `PSW-8-240W-RUG  Peplink SD Switch 8-Port Rugged, 8 ports, 90W power budget (Upgradable to 240W), 8x GE Ports (PoE+), 2x 1G SFP Ports.`

  and its specifications table, the 8-port column:

  > `20W System,` / `90W PoE+ Power Budget` / `(Upgradable to 240W*)`
  >
  > `* The bundled PSU provides 90W of PoE+ power budget. Additional ACW-623 (180W PSU) is required to enable up to 240W power budget.`

* SD Switch Rugged datasheet, ref `sd-switch-rugged-202109-v14`
  (<https://download.peplink.com/resources/peplink_switch_rugged_datasheet.pdf>, PDF re-exported
  2023-11-17), same columns for the 8-port and 16-port rugged pair:

  > `Power Consumption | 20W System, 90W PoE+ Power Budget (supports up to 240W#) | 20W System, 90W PoE+ Power Budget (supports up to 240W#) | 50W System, 120W PoE+ Power Budget (supports up to 250W%)`
  >
  > `# The bundled PSU provides 90W of PoE power budget. If you require 240W of power budget, please add 180W PSU (ACW-630) to your device.`

The accessory's part number changed between the two sheets - `ACW-623` in 2019, `ACW-630` in 2021 - and both
are the same 180 W, 54 V unit (the 2019 sheet prices ACW-623 at `54V, 3.34A, 180W`). The number that did not
change is 90 W bundled.

**The box contents agree with the footnote.** The 2021 sheet's Package Content row, read by column rather
than by extraction order, is:

| column | PSU in the box |
| --- | --- |
| SD Switch 8-Port Rugged | 1x PSU **120W** |
| SD Switch 16-Port Rugged | 1x PSU **120W** |
| SD Switch 24-Port Rugged | 1x PSU **180W (ACW-630)** |

and the arithmetic closes:

* 8-port: 120 W PSU - 20 W system = 100 W of supply for PoE; the declared budget is 90 W, i.e. 10 W of margin.
* 16-port: same 120 W PSU, same 90 W budget.
* 24-port: 180 W PSU - 50 W system = 130 W; declared 120 W, the same 10 W margin.

So 90 W is not a typo for 120 W: it is the PoE budget a 120 W supply can fund on a 20 W switch. 240 W
cannot come out of that supply at all, which is why Peplink sells the 180 W PSU separately.

## Why the model name is not the budget

`PSW-8-240W-RUG` names the **maximum** the platform will pass to PoE ports, not the supply in the crate -
Peplink's own ordering sentence reads "8 ports, 90W power budget (Upgradable to 240W)" and then the name
says 240W. Operators read the name and stop there, which is visible in the vendor's own forum: a thread
asking how much PoE a terminal-block supply can deliver quotes exactly the bundled-PSU footnote and asks
whether 90 W is "the PoE cutoff"
(<https://forum.peplink.com/t/8-poe-port-sd-switch-no-fans-always-reliable/16422>). No Peplink answer in that
thread gives a headroom number.

Two retailer pages reproduce the split, one of them with a figure of its own:

* <https://5gstore.com/product/8431_peplink_8_port_sd_switch_rugged_240w_power_budget> - title "240W Power
  Budget", specification "**10W System, 240W PoE+ Power Budget** (additional PSU required for max budget,
  sold separately)", package "1x PSU 120W", and a Q&A that says "The PSU that comes with it outputs DC 54V
  and provides 90W". Four numbers for one box (10/20 W system, 240/90 W budget): the 10 W is that page's own
  typo against both datasheets, and the ordering line it copies is the 240 W one. The page marks the SKU
  discontinued.
* <https://www.voipsupplies.co.uk/products/peplink-8-port-rugged-industrial-grade-poe-sd-switch-psw-8-240w-rug> -
  "20W System, 90W PoE+ Power Budget (supports up to 240W)", matching the 2021 datasheet.

## The 24- and 48-port: the name is the budget, because the PSUs are in the box

Both the 2019 switch datasheet and the 2023 AC-only datasheet
(<https://download.peplink.com/resources/peplink_switch_ac_datasheet.pdf>, PDF dated 2023-11-17) pair each
850 W / 800 W figure with the PSU count that funds it, and the ordering table says those supplies ship with
the switch:

> `PSW-24-850W  PoE enabled (delivers up to 850W) Gigabit (24 ports) and SFP+ (2 ports) switch with redundant power inputs and 3x power supplies.`
> `PSW-48-800W  ... Gigabit (48 ports) and SFP+ (4 ports) switch with redundant power inputs and 3x power supplies.`

> `850W: 3x Redundant PSU | 50W System, 850W PoE+ Power Budget | ... | 24x 802.3at (PoE+) GE Ports, 2x SFP+ Ports`
> `3x Redundant PSU | 100W System, 800W PoE+ Power Budget | ... | 48x 802.3at (PoE+) GE Ports, 4x SFP+ Ports`

The 2019 sheet prints the pair as `2-3x Redundant PSU | 50W System, 550W or 850W PoE+ Power Budget`, because
the 550 W build is a **separate SKU** (`PSW-24-550W`, "2x power supplies"), not a lower setting of this one.
So for these two the model name is exactly the shipped budget, and only the provenance was missing.

## What this console does today

`engine/device.js:214-221` derives `poeBudget` in three steps: a structured `spec.poe.budgetW`, then
`poe.budgetUnknown`, then `parsePoeBudget(spec.model)`. All three Peplink PSWs had no `poe` block, so all
three took the third path and were credited with the number in the name - correct for two of them, and 150 W
too generous for the rugged 8-port. `show power inline` prints that figure as
`Available:<budget>.0(w)`, so the rugged box claimed to fund 8 x 30 W (240 W) when its supply funds 8 x 11 W.

## Known, inferred, unresolved

**Known.** The PSW-8-240W-RUG's specification row gives `20W System, 90W PoE+ Power Budget (supports up to
240W)`; the footnote under it says the bundled PSU provides 90 W and that an added 180 W PSU
(`ACW-623` / `ACW-630`) is what enables 240 W; the 2021 Package Content row puts a 120 W PSU in the box, and
120 - 20 = 100 W is the headroom a 90 W budget is drawn from. The 24-port's 850 W and the 48-port's 800 W are
the shipped figures, with their three supplies named in the ordering table.

**Inferred.** That 90 W is a hard budget and not a negotiated/priority-managed figure - no Peplink document
describes PoE priority, budgeting mode or a per-port reservation for these switches, and the 10 W margin on
both 120 W and 180 W supplies looks like a fixed headroom rule rather than an allocation one.

**Unresolved.**

* **What a terminal-block supply delivers.** The 2021 sheet says "PoE output requires a minimum of 48V power
  input" and the 8-port takes `Terminal Block: 12V - 56V DC` alongside two 54 V DC DIN inputs. Whether a
  56 V bench supply at, say, 10 A raises the budget above 90 W is published nowhere, and the forum thread
  above is somebody asking that exact question. The 90 W figure is tied to the bundled 120 W adapter.
* **Whether the budget is firmware-capped.** 120 W supply - 20 W system = 100 W, and the budget is 90 W; if a
  180 W supply were fitted, the same 10 W rule would predict 150 W, not 240 W. Either the extra supply also
  lifts a firmware cap (240 W = 8 x 30 W, the full 802.3at class ceiling) or the 10 W rule is coincidence.
  No document says which.
* **Whether the SKU is still sold.** One retailer marks it discontinued; Peplink's own rugged datasheet
  (re-exported 2023-11-17) still lists it with no end-of-sale note. That does not change the budget, but it
  does mean a 2024-era box cannot be assumed identical to the 2021 sheet.
* **A `show` capture.** No Peplink CLI transcript for `show poe` / the web UI's PoE page was found, so the
  figure here is the datasheet's, not a reading off a running box.

**What would settle the rest.** One PSW-8-240W-RUG on the bench: read the PoE budget with only the bundled
120 W adapter, then with the ACW-630 fitted, then from a 54 V terminal-block supply of known amperage, and
read the same three numbers from the web UI's PoE page. That answers the firmware-cap and the terminal-block
questions in three readings.
