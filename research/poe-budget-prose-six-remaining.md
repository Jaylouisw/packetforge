# Six PoE budgets that were in prose, and the two that were more than a missing number

**Question (one, narrow).** `scripts/audit-poe-budget.js` named six specs that source power, carry no
`poe.budgetW`, and already quote a wattage in their own `description`. Does each vendor document
state that figure - and if it does, what does the field have to say to be true?

Measured 2026-11-20 18:1x-18:4x UTC, one increment on the catalogue stream. This closes the list the
previous pass left behind by name (`research/poe-budget-prose-four-models.md`, "What was left, and
why"): five of the six had "no vendor document was read", and the Aruba had been left because
`www.arubanetworks.com/assets/ds/DS_2540SwitchSeries.pdf` answered 403 to that crawler. The HPE
QuickSpecs host answered this time.

Census, same command before and after (`node scripts/audit-poe-budget.js`):
**61 of 411 PSEs silent, 6 of those with a figure in prose** -> **55 of 411 silent, 0 in prose.**
The 55 that remain were never touched by this pass and mostly have no published aggregate at all
(passive-PoE injectors, MikroTik hAPs, Teltonika routers).

## Verdict: all six vendor documents state it, and two specs were wrong beyond the missing field

| spec | vendor figure, verbatim | source |
|--|--|--|
| `devices/netgear/gs724tp.json` | **190 W** - `PoE / PoE+ ports: 24 PoE+ (190W PoE budget)`; `24 x 1000BASE-T PoE+ Copper ports`, `2 x 1000BASE-X Dedicated Fiber SFP ports` | <https://www.netgear.com/images/datasheet/switches/gs724tpv2_gs724tpp.pdf> |
| `devices/moxa/eds-g4012-8p-4qgs-lvb-t.json` | `Max. PoE Power Output per Port: 90 W`; `EDS-G4012-8P-4QGS-LVB(-T) models: ... Max. 180 W for total PD power consumption @ 48 VDC input; Max. 150 W @ 24 VDC input; Max. 62 W @ 12 VDC input`; `Support for IEEE 802.3bt PoE` | <https://www.moxa.com/getmedia/e08a3f88-7aea-49de-b97a-97c1a5c26580/moxa-eds-g4012-series-datasheet-v1.8.pdf> |
| `devices/dahua/nvr5216-16p-ei2.json` | `Total output power of PoE is 130 W, the maximum output power of a single port is 25.5 W`; `Total output of NVR is <= 10 W (without HDD)` | <https://www.dahuasecurity.com/products/network-products/network-recorders/wizsense-series/nvr-5-ei2-series/nvr5216-16p-ei2> |
| `devices/hikvision/ds-7616ni-k2-16p.json` | `PoE Interface: 16, RJ-45 10/100 Mbps self-adaptive Ethernet interface`; `Power: <= 200 W`; `Standard: IEEE 802.3 af/at` | <https://www.hikvision.com/en/products/IP-Products/Network-Video-Recorders/Pro-Series/ds-7616ni-k2-16p/> |
| `devices/hikvision/ds-7608ni-k2-8p.json` | `PoE Interface: 8, RJ-45 10/100 Mbps self-adaptive Ethernet interface`; `Power: <= 80 W`; `Standard: IEEE 802.3 af/at` | <https://www.hikvision.com/content/dam/hikvision/products/S000000001/S000000132/S000000007/S000000026/OFR000040/M000000568/Data_Sheet/Datasheet-of-DS-7608NI-K2_8P-NVR-D-or-E_4.71.410_20221026.pdf> |
| `devices/aruba/2540-48g-poe-4sfp-plus-jl357a.json` | `48 RJ-45 autosensing 10/100/1000 PoE+ ports`; `PoE power: 370 W PoE+`; `Maximum power rating 459 W`; `Idle power 48.6 W` | <https://www.hpe.com/psnow/downloadDoc/HPE+Aruba+Networking+2540+Switch+Series-c05278966.pdf?id=c05278966.pdf> |

The Hikvision product page for the DS-7608NI-K2/8P returned an empty body to the same client that
read the 7616 page in full, so its figure is taken from the vendor-hosted data sheet above rather
than from the page. Both Hikvision NVRs are marked discontinued on the vendor site; the numbers are
still published.

## GS724TP: the budget belonged to a different revision than the ports

The entry read *"24x 1G all PoE+, 2x SFP, 192 W budget"* - and 192 W is real, on the 2007 sheet:

> GS724TP and GS748TP Data Sheet (22 May 2007): `With a total power budget of 192 Watts for the
> GS724TP`; `Max 225W for GS724TP`; `IEEE 802.3af (Power over Ethernet)`; `GS724TP: 24 10/100/1000
> Mbps auto-sensing Gigabit Ethernet, 2 combo Gigabit copper/SFP slots`
> <https://www.downloads.netgear.com/files/GDC/GS724TP/enus_ds_gs724tp_gs748tp_business_22may07.pdf>

That revision is 802.3af - 15.4 W a port, not 30 - and its two SFP slots are *combo*, sharing cages
with two copper ports. The ports in this file are 24 PoE+ plus two **dedicated** SFP, which is the
v2/v3 layout, and that revision's total is 190 W. So the entry quoted one revision's supply beside
another revision's ports. It is now the PoE+ box at 190 W, sourced to the v2 data sheet, with the
192 W figure and the revision it belongs to kept in `poe.note` and in `notes`.

## Moxa: the ports were an inference, and the total is a function of the supply

`EDS-G4012-8P-4QGS-LVB-T` carried no `poeOut` on any port. Because its category is `switch` and its
label contains "PoE", the engine's own inference (`media.js`, `isPoePse`) gave all eight copper ports
15.4 W of 802.3af - on a switch the data sheet calls IEEE 802.3bt with a 90 W per-port maximum. A
budget cannot be added without ports to spend it on (the invariants refuse a budget with no PSE), so
this pass declared the eight ports (`poeOut: 90`, `poeOutClass: "PoE+++"`, `poe-pse` and `802.3bt`
capabilities) and wrote `poe.budgetW: 150`.

150 W is the **24 VDC** row. The sheet's other rows are 180 W at 48 VDC and 62 W at 12 VDC, and one
scalar cannot hold three numbers; the lowest supply voltage a lab is likely to use is the honest
conservative ceiling, and `poe.note` carries all three. This is the conditionality that
`docs/plans/poe-budget-variants.md` step 2 is for.

## What changed

Six specs gained `poe { budgetW, sourceUrl, note }`; nothing in `engine/` was touched. The Moxa also
gained the eight declared PSE ports above, and the GS724TP's description moved from 192 W to 190 W.
`test/poe-budget-prose-six.test.js` pins the six figures, their vendor-host URLs, that each device
resolves `poeBudgetSource === 'research'`, that `show power inline` prints
`Available:<n>.0(w)` instead of "budget not modelled", that each budget is smaller than the sum of
its own port ceilings, and the two special cases (GS724TP's revision note, Moxa's 90 W declared
ports). 47 checks.

## Unresolved, and what would settle each

1. **The Moxa's supply-dependent total.** 62 / 150 / 180 W by input voltage. The field holds one.
   Settling it needs `poe.budgetVariants` (the plan above), or a decision that the catalogue always
   takes the highest published row. Nothing here changes a verdict - the budget only ever denies
   power it cannot supply, and 150 W is the conservative choice.
2. **Whether `GS724TP` should be a v1 SKU at all.** The v1 is 192 W, 802.3af, with combo SFP. A lab
   that wants that box needs its own file (`gs724tpv1`?) with the combo port pairs; this file is now
   internally consistent as the PoE+ revision. A vendor page for the v1's exact SFP wiring would
   settle whether the two combo slots share ports 23-24 or are separate cages.
3. **Whether an NVR's PoE figure is a PSE budget or an adapter rating.** For these two Hikvisions and
   the Dahua it is stated as a PoE output figure (`Power: <= 200 W`, `Total output power of PoE is
   130 W`), with a separate system consumption, so it is read as a budget. A recorder whose sheet
   gave only a supply rating would look identical in prose; that is why the previous pass refused to
   write these from the description alone.
