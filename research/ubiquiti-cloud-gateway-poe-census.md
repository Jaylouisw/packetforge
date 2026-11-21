# UniFi cloud-gateway PoE census: five rows that billed every PSE socket at 1 W

Read 2026-11-21, one increment on the catalogue stream under #130's fallback list (a
router/gateway node for a routed lab: NAT, DHCP, VPN, cellular WAN). The Dream Wall Pro the
request names has no vendor page (the passes recorded on #130 say so, each with its own probes), so this pass
swept the gateway rows a lab substitutes for it - and found the same defect class the UDW row
had (PR #2404), on five more consoles.

## The defect

`poeOut: true` is a bare direction bit. `Device.poeDraw()` (`engine/device.js`) adds the field
into its watt total, so `true` is **1 W**; `pseDraw()` (`engine/validation.js`) sums the same
field against `poe.budgetW`. On these five rows that made every budget inert: a 90 W 802.3bt
device on UCG-Industrial eth0 was accepted as a 1 W load, and the 270 W budget could not bind.
The faceplate's `num()` refuses a boolean, so the panel drew the PoE badge with no figure.

Each row now declares the vendor's own per-port ceiling for the class the socket already
carried. The class-to-socket assignment is untouched - neither surface numbers which sockets
are which beyond the counts.

## What Ubiquiti prints (all server-rendered tech-spec tables, crawler UA, read 2026-11-21)

| model | port census | PSE ceiling per port | budget | page |
|--|--|--|--|--|
| UCG-Industrial | `2.5 GbE RJ45 = 4 (2 PoE+++, 2 PoE+)`, `10 GbE RJ45 = 1 (PoE+++)` | `PoE+ = 30W`, `PoE+++ = 90W` | `DC input: 270W / ATX power: 75W` | <https://techspecs.ui.com/unifi/cloud-gateways/ucg-industrial> (200, 699,443 B) |
| UDM-SE | `(6) PoE`, `(2) PoE+` (datasheet); `PoE Budget = 180W` | `PoE = 15.4W`, `PoE+ = 30W` | `180W` | <https://techspecs.ui.com/unifi/cloud-gateways/udm-se> (200, 682,320 B) |
| UDR | `1 GbE RJ45 = 5 (2 PoE)` | `PoE = 15.4W` | `40W` | <https://techspecs.ui.com/unifi/cloud-gateways/udr> (200, 685,837 B) |
| UDR7 | `2.5 GbE RJ45 = 4 (1 PoE)` | `PoE = 15.4W` | `15.4W` | <https://techspecs.ui.com/unifi/cloud-gateways/udr7> (200, 694,590 B) |
| UDR-5G-Max | `2.5 GbE RJ45 = 4 (1 PoE)` | `PoE = 15.4W` | `15.4W` | <https://techspecs.ui.com/unifi/cloud-gateways/udr-5g-max> (200, 876,426 B) |

The UDM-SE datasheet is the only surface that prints the PoE split *and* both ceilings in one
block: `PoE interface (6) PoE (Pair A 1, 2+; 3, 6-) / (2) PoE+ (Pair A 1, 2+; 3, 6-)` and
`Max. PoE wattage per port by PSE PoE: 15.4W / PoE+: 30W`
(<https://dl.ui.com/ds/udm_se_ds.pdf>, 200, `application/pdf`, 358,669 B, 3 pp, text layer).

Arithmetic, stated rather than reconciled: UCG-Industrial's panel is 3 x 90 + 2 x 30 = 330 W
against a 270 W budget, so the budget - not the socket sum - is what `show power inline`
spends (the same shape the UDW row records at 421.6 W against 420 W). UDM-SE is 2 x 30 + 6 x
15.4 = 152.4 W inside 180 W; UDR is 2 x 15.4 = 30.8 W inside 40 W, which is what its own
budget note already said.

Gate: `test/ubiquiti-gateway-pse-panel.test.js` (101 assertions), which also cables a powered
device to the first PSE socket of each row and asserts `poeDraw()` answers the ceiling.

## Traps, so they are not re-walked

- `https://dl.ui.com/ds/udm-se_ds.pdf` is the live path (hyphen). `https://dl.ui.com/ds/udm-se_ds.pdf`
  answers **302** into the 609,911-byte techspecs front page, which reads as a document if only
  the status code is checked.
- The tech-spec page stores its table twice: once as server-rendered HTML escaped inside a JSON
  string and once as a `"value"`/`"feature"` graph. Grepping the raw bytes for a label finds the
  first copy; a `strip-tags` on it returns nothing until the `\\"` escapes are undone.
- `https://techspecs.ui.com/unifi/cloud-gateways/umr` -> **307** (1 byte) and
  `.../umr-industrial` -> **307** (39 bytes, both to `/`). Those two mobile-router rows still
  carry `poeOut: true` and were **not** touched by this pass: no page, so no figure.

## Still open in the same class (not this pass's rows)

65 Ubiquiti specs across the tree (switches, APs, cameras, hubs) still carry `poeOut: true`. They are a
backlog of the same defects, each needing its own vendor ceiling; `node scripts/audit-poe-budget.js`
lists the ones with no budget, but the bare-bit census is
`grep -l '"poeOut": true' devices/ubiquiti/*.json`.
