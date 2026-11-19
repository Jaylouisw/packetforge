# EdgeRouter PoE routers: the wattage is an envelope, and Ubiquiti prints both operands

Read 2026-11-19, one increment on the catalogue stream. These two rows sit directly under
#130's fallback list (a router/gateway node for a routed lab, NAT + DHCP + VPN), and both
were **silent PSEs**: fourteen `poeOut` ports between them, no `poe.budgetW`, so
`show power inline` printed "budget not modelled" over ports that really do source power.

## What Ubiquiti prints

| | ER-6P | ER-12P |
|--|--|--|
| tech-spec page | <https://techspecs.ui.com/uisp/wired/er-6p> (200, 582,715 B) | <https://techspecs.ui.com/uisp/wired/er-12p> (200, 575,620 B) |
| Networking interface | (5) GbE RJ45, (1) 1G SFP | (10) 10/100/1000 RJ45, (2) 1 Gbps SFP |
| PoE interface | (5) 24V **Passive** PoE ports (2-pair and 4-pair) | (10) 24V passive PoE ports, 2-pair (Pins 4, 5+; 7, 8-) |
| Power supply | AC/DC adapter, external, **60W** (24V, 2.5A, included) | AC/DC adapter, **60W**, 24V DC, 2.5A (included) |
| Max. power consumption | **16W (Excluding PoE output)** | **20W (Excludes PoE output)** |
| Max. PoE wattage per port | 24W (24V, 1A, 4-pair); 12W (24V, 0.5A, 2-pair) | 17W (24V) |
| Supported voltage range | 16-30V DC | 9-30V DC |
| store page (corroborating) | <https://store.ui.com/us/en/products/er-6p> (200, 332,139 B) | <https://store.ui.com/us/en/products/er-12p> (200, 323,284 B) |

## The decision: 44 W and 40 W, labelled as arithmetic

Neither page prints a "PoE budget" row, and neither does the store. What both print is a
supply rating and a device draw explicitly marked *excluding/excludes PoE output* - a
parenthetical that only has a purpose if the reader is meant to subtract. So the spec records
the stated configuration's envelope:

- ER-6P: 60 W adapter - 16 W device = **44 W** across five passive ports;
- ER-12P: 60 W adapter - 20 W device = **40 W** across ten passive ports.

`poe.note` says in as many words that this is derived from two printed figures rather than a
figure Ubiquiti publishes, and that a lab fitting a larger supply inside the unit's voltage
range states its own. That is the same shape as the ECS-24-PoE entry (#803 family): record
one reachable configuration and carry the rest of the arithmetic where a lab can read it.
Leaving the field absent instead - the previous state - was not neutral: `engine/simulator.js`
opens `computePoe()` with `if (!dev.poeBudget) continue;`, so the ports were not "unknown",
they were skipped, and they could not power anything at all.

## Two traps, so they are not re-walked

- **`dl.ui.com/ds/er-6p_ds.pdf` and `dl.ui.com/ds/er-12p_ds.pdf` are 302 to
  `https://techspecs.ui.com`** and land on the 609,911-byte front page. There is no EdgeMAX
  datasheet at either spelling - the same silent-fallback shape already recorded for
  `ucg-fiber`, `uxg-pro`, `umr-ultra` and `urr-industrial`. Every figure above is tech-spec-only.
- **`dl.ui.com/qig/er-6p/` is 200 but is not a quick-start PDF**: it is the 6,176-byte
  iframe shell that embeds the tech-spec page. `qig/er-12p` 302s to the front page. So a 200
  on the `qig` path is not evidence of a document.

## Still silent in this neighbourhood

`devices/ubiquiti/ep-r8.json` (2 PSE), `ep-s16.json` (16 PSE) and `uisp-r.json` (8 PSE) are
the next three Ubiquiti routers/switches with ports that source and no budget; none of their
pages prints a total either, so each needs the same treatment on its own evidence. Not done
here: one family per increment.
