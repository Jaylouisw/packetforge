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
| **silent** - PoE out, no budget, no "never published" marker | **130** | the engine reports the ports and refuses the arithmetic |
| **inferred** - budget parsed out of the model name | **22** | not traced to a document |
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
  of the 130 silent devices after the eight promotions below.

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

## 4. What is still open

- **130 silent PSEs.** 41 of them quote a budget in prose, which makes them promotions waiting for a
  vendor read rather than new research. The remainder - mostly MikroTik routers with one PoE-out
  port and Ubiquiti EdgeRouter/EP models - may genuinely never publish a figure; those should end up
  as `poe.budgetUnknown` rather than staying silent, so the audit can distinguish "not checked" from
  "not published".
- **22 name-inferred budgets.** `ES-24-250W` and `ES-48-500W` really do encode their PoE budget in
  the model string; `ES-24-500W` encodes its PSU. Each wants one datasheet line before the inference
  is taken as fact.
- **The gate.** `--strict` exists but is not wired into CI: it would fail on the 130. The end state
  is zero silent devices, then `--strict` in the test job, which is what makes the class stay fixed.
