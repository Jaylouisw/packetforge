# The CRS418's Wi-Fi variant lit seventeen PoE sockets on a box with eight

Measured 2026-11-21, one increment on the catalogue stream. No open device request is answered
here: the tracker's queue is still the blocked requests (#130 UDW-PRO and the rest).

## The question

`devices/mikrotik/crs418-8p-8g-2s-5axq2axq-rm.json` declares `poe-pse` and seventeen RJ45 ports,
and `scripts/audit-poe-budget.js` listed it as a *silent PSE* with **17 PSE ports**. Does MikroTik's
`CRS418-8P-8G-2S+5axQ2axQ-RM` really source power on all seventeen, and what total budget does the
vendor print?

## Evidence

`https://mikrotik.com/product/crs418_8p_8g_2s_wifi` (HTTP 200, 448,215 B, read 2026-11-21 with a
desktop Chrome UA, no redirects followed; the URL is the one in the row's own `sourceUrl` and it is
listed in `https://mikrotik.com/sitemap.xml`, 200, 48,450 B). The page's `<h1>` and `Product code`
both read `CRS418-8P-8G-2S+5axQ2axQ-RM`, so this is the row's product, not a sibling.

The specification table, verbatim:

| row | value |
|---|---|
| 10/100/1000 Ethernet ports | 17 |
| Number of 1G Ethernet ports with PoE-out | 8 |
| PoE-out ports | Ether9-Ether16 |
| PoE out | 802.3af/at |
| Low voltage PoE-Out current limit | 1.1 A |
| High voltage PoE-Out current limit | 0.56 A |
| Total output power | 150 |
| SFP+ ports | 2 |
| Max power consumption | 227 W |
| Max power consumption without attachments | 43 W |

The marketing block on the same page repeats it in prose: "8x PoE Output ports (802.3af/at and 24V
Passive PoE Output) - up to 150 W total output".

## Verdict

**Known:** the PoE block is Ether9-Ether16, eight ports, 802.3af/at, total output 150 W. The 24 V
passive mode is an alternative mode on those same eight ports, not eight more. The row's port count
(17 copper, 2 SFP+) was already right; its `PoE-out ports` claim was not - a re-import filled the
capabilities and left the per-port flags out, so `isPoePse()`'s switch rule ("a switch that claims
PoE sources on every copper port") lit Ether1-Ether8 and Ether17 as well, and with no `poe` block the
budget fell through to the model-name parser, which finds no number in
`CRS418-8P-8G-2S+5axQ2axQ-RM` and answered 0 W.

**Changed:** the row now declares `poeOut: false` on Ether1-Ether8, Ether17 and both SFP+ cages,
`poeOut: true` + `poeOutClass: "PoE+"` on Ether9-Ether16, and a `poe` block
(`budgetW: 150`, `sourceUrl`, and a note quoting the vendor rows). Silent PSEs in the audit: 21 -> 20.
`test/crs418-wifi-poe.test.js` guards the eight-port split, the 150 W budget, the `show power inline`
summary (`Available:150.0(w)`) and the point where the budget runs out (five 25.5 W loads fit, the
sixth is `power-deny` with 22.5 W left), and checks the non-WiFi sibling still answers identically.

## Inferred, not captured

* The class is `PoE+` (802.3at) because the page prints `802.3af/at`; the engine has one class per
  port and the sibling row already takes the same position. The 24 V passive mode is *not* modelled
  as a second class, because no engine surface selects between the two yet.
* The 0.56 A high-voltage limit is read as per port (0.56 A x 54 V = 30 W, one 802.3at port), which
  is why it does not contradict the printed 150 W total. The sibling row's note reads "5.4 A" for the
  same reason (ten ports' worth of per-port limits), and neither figure is used to compute the budget:
  the budget is the vendor's own watt figure.

## Unresolved

* Whether `poeOutClass` should ever carry the passive mode for MikroTik boxes that offer both. Doing
  so needs a per-port mode in the config model first; the media layer has no vocabulary for it.
* 227 W with attachments against a 150 W PoE budget: the sheet's 43 W "without attachments" is a box
  draw, but the difference (184 W) is not documented as the PoE allowance and is not used as one.
* The other 20 silent PSEs in `scripts/audit-poe-budget.js --all` (teltonika OTD140/OTD144/RUT276,
  ubiquiti ES-16XP/N-SW/UISP-FIBER-XG/F-POE-G2 and the UniFi access-hub rows, fs AP-T565/PI35A-1,
  tp-link EAP225/235/615-Wall, planet POE-E201, reolink RLN8-410). Several are pass-through
  injectors where "no budget" is the truth; each needs its own page read.
