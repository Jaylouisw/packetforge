# A PoE budget is a field, not a sentence

Measured 2026-11-18, one increment on the catalogue stream. This is the census behind
`scripts/audit-poe-budget.js`. It exists because #130 found the failure mode in the one place
nobody was looking: `devices/ubiquiti/udw.json` described a 420 W console in prose and carried no
`poe.budgetW`, so the engine fell through to the model-name parser, got nothing from `UDW`, and
`show power inline` printed *"budget not modelled"* over twelve live PoE ports. The device was
present; the number was not.

## 1. The shape of the problem

| cohort | count | what it means |
|--|--|--|
| models in the catalogue | 2,356 | |
| source PoE on >= 1 port (`hardware.poeOut`) | 401 | the population that can be asked a wattage question |
| **silent** - PoE out, no budget, no "never published" marker | **129** | the engine reports the ports and refuses the arithmetic |
| **inferred** - budget parsed out of the model name | **20** | not traced to a document |
| **explicitly unknown** - `poe.budgetUnknown: true` | **16** | correct, and kept visible |
| **orphan** - budget with no PSE port | **0** | already policed by `test/hardware-invariants.test.js` |

The invariant suite polices the orphan direction only: *a device that claims a budget must have a
port to spend it on*. Nothing polices the reverse - a device with ports and no budget - which is
why #130's fallback was able to be wrong for as long as it was.

`node scripts/audit-poe-budget.js [--json] [--all] [--strict]` prints the four cohorts. It exits 0
unless `--strict` is passed, because turning it into a gate today would fail the build on 130
existing specs; the intent is to fix the cohorts and then gate the class.

Two corrections this script had to make to itself, both worth not re-deriving:

- **Read the engine's port hardware, not the spec's literal `poeOut` key.** A `portTemplate`'s
  generated ports never carry the key, and a cage cannot source watts. The first cut read
  `spec.interfaces` and reported 37 devices as "budget with no PSE port" that the invariants - which
  read `hardware.poeOut` - correctly treat as fine.
- **The prose column is a lead, not a source.** A regex that accepts "budget ... digits" read
  Teltonika's TSW040 as *30 W*, because the sentence is "a 240 W total budget and up to 30 W on any
  one port". A per-port class is never a budget. Requiring the figure *before* the word "budget",
  and accepting a thousands separator, stopped it inventing numbers in both directions - the first
  cut also read the Enterprise Campus 24 PoE's "1,050 W" as *50 W*. The prose lead list stands at 41
  of the 129 silent devices after the eight promotions below.

## 2. Promoted this pass: eight budgets that only existed in prose

Each was re-read from the vendor's own page today, not copied out of the description.

| spec | W | vendor line |
|--|--|--|
| `devices/tp-link/tl-sg1016pe.json` | 110 | "With a total PoE power budget of 110W, up to 30W per port" - <https://www.tp-link.com/us/business-networking/easy-smart-switch/tl-sg1016pe/> |
| `devices/tp-link/tl-sg1210mpe.json` | 123 | spec table "PoE Ports (RJ45) ... PoE Power Budget: 123 W" - <https://www.tp-link.com/us/business-networking/soho-switch-poe/tl-sg1210mpe/> |
| `devices/tp-link/tl-sg1218mp.json` | 250 | "250 W for all PoE ports" - <https://www.tp-link.com/us/business-networking/poe-switch/tl-sg1218mp/v1/> |
| `devices/teltonika/tsf000.json` | 120 | "4x PoE+ outputs with a 120 W power budget" - <https://wiki.teltonika-networks.com/view/TSF000> |
| `devices/teltonika/tsw040.json` | 240 | "total power budget of 240 W, or up to 30 W per port" - <https://wiki.teltonika-networks.com/view/TSW040> |
| `devices/ubiquiti/usw-pro-hd-24-poe.json` | 600 | "Total PoE Availability 600W" - <https://techspecs.ui.com/unifi/switching/usw-pro-hd-24-poe> |
| `devices/ubiquiti/usw-enterprise-48-poe.json` | 720 | "Total PoE Availability 720W" - <https://techspecs.ui.com/unifi/switching/usw-enterprise-48-poe> |
| `devices/ubiquiti/ecs-24-poe.json` | 1050 | "1,050W with (2) 600W modules" (shared mode) - <https://techspecs.ui.com/unifi/switching/ecs-24-poe> |

Three of these were prose figures that a reader would have taken as the budget and a lab would have
found wrong:

- **TL-SG1210MPE**'s other big number is 141.54 W - input power with 123 W of PD load attached, not
  a second budget;
- **USW-Pro-HD-24-PoE** publishes 60 W excluding PoE output and 660 W including it; the budget is
  600 W, and neither of the other two is it;
- **USW-Enterprise-48-PoE**'s 870 W is the supply rating, its 150 W is the non-PoE draw, and the
  budget is 720 W.

## 3. The one that is a stated configuration, not a number

`ECS-24-PoE` publishes its PoE availability as a function of the fitted PSUs:

| PSUs | 200-240 V shared | 100-120 V shared | redundant |
|--|--|--|--|
| (2) 600 W | 1,050 W | 1,050 W | 450 W |
| (2) 1,200 W | 2,250 W | 1,850 W | 1,050 W (200-240 V) / 850 W (100-120 V) |

No single number is "the" budget. The spec records **1,050 W** - the two-600 W-module chassis, the
only configuration where 1,050 W is reachable at any input voltage - and the `poe.note` carries all
six figures so a lab that needs the 1,200 W ceiling states it rather than inheriting it. This is the
same shape as the E6616X's AC/DC slot arithmetic (#803): a frame's capacity is a function of what is
plugged into it, and a spec that hides the configuration is off by whatever the configuration is
worth.

## 4. The power input is the configuration, not a constant

The USW-Ultra family is the same shape as the ECS-24-PoE, one layer further down: the budget is not
a property of the chassis at all, it is a property of **how the chassis is powered**. All three
catalogue specs - `usw-ultra`, `usw-ultra-60w`, `usw-ultra-210w` - carried the description "42 W PoE
budget", including the 210 W one, and none carried `poe.budgetW`.

Ubiquiti's spec table publishes one row, "Total PoE Availability", with five values:

| power input | PoE availability |
|--|--|
| PoE++ input | 42 W |
| PoE+ input | 16 W |
| 60 W PoE adapter input | 42 W |
| 60 W AC adapter input | 52 W |
| 210 W AC adapter input | 202 W |

Read from <https://techspecs.ui.com/unifi/switching/usw-ultra> (200, 628,685 B) and the two variant
slugs `.../usw-ultra-60w` (628,751 B) and `.../usw-ultra-210w` (628,783 B), all three of which print
the identical five-row table - the SKU suffix names the adapter, not a different PoE engine. The
store page spells the same thing out in prose: "PoE input is supported for switch operation, with
PoE+/PoE++ input or AC power required for PoE output", and offers the one product with "No AC
Adapter" / "60W AC Adapter" / "210W AC Adapter" as power options
(<https://store.ui.com/us/en/products/usw-ultra> -> `.../pro-category/switching-utility/collections/pro-ultra/products/usw-ultra`,
200, 673,337 B).

The three specs now hold 42 W / 52 W / 202 W respectively - each the row its own name selects - and
each `poe.note` carries all five, so a lab that powers the unit from a different adapter takes that
row instead of inheriting the one in the field.

**The census error the same table hid.** The specs also described port 8 as a 60 W PoE++ *source*
(`"poeOut": true, "poeOutClass": "PoE++"`), giving the switch 8 PSE ports. The vendor's port layout
is "8 (7 PoE+; 1 PoE++ **input**)" and "Max. PoE Output: Up to PoE+", with "Max. PoE Wattage per
Port by PSE: PoE+ 30 W" and no PoE++ row - the PoE++ port is where the unit *takes* power from an
upstream switch, which is also why its power method reads "(1) AC/DC adapter (Excluded) / (1)
PoE++". That is the phantom-PoE class again (the UDM PoE draw this catalogue already corrected),
this time on the source side of one port. Port 8 is now `"poeOut": 0, "poeIn": 9` (9 W is the
vendor's "max. power consumption excluding PoE output with PoE input"), so `show power inline`
counts 7 PSE ports on this model instead of 8. The eight ports also gained the `10M` cap the same
line publishes ("1G/100M/10M") and the specs had dropped.

**Trap recorded so it is not re-walked:** `https://dl.ui.com/ds/usw-ultra_ds.pdf` 302s to
`https://techspecs.ui.com/` and serves the same 609,911-byte home page that every missing
`dl.ui.com` document serves - there is no Ultra datasheet, and that page is not one.

## 5. What is still open

- **129 silent PSEs.** 40 of them quote a budget in prose, which makes them promotions waiting for a
  vendor read rather than new research. The remainder - mostly MikroTik routers with one PoE-out
  port and Ubiquiti EdgeRouter/EP models - may genuinely never publish a figure; those should end up
  as `poe.budgetUnknown` rather than staying silent, so the audit can distinguish "not checked" from
  "not published".
- **20 name-inferred budgets.** `ES-24-250W` and `ES-48-500W` really do encode their PoE budget in
  the model string; `ES-24-500W` encodes its PSU. Each wants one datasheet line before the inference
  is taken as fact.
- **The gate.** `--strict` exists but is not wired into CI: it would fail on the 129. The end state
  is zero silent devices, then `--strict` in the test job, which is what makes the class stay fixed.
