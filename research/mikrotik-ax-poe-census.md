# The MikroTik AX boxes: one passive port each, and three boxes filed six times

**Question (one, narrow).** hAP ax², hAP ax³ and cAP ax each carry a single PoE-out port. Which port is
it, what does it speak, and how many watts may it pass - and why did the catalogue answer "none of the
above" for each of them?

**Verdict: each box sources *passive* PoE on one named port, and each was filed twice or three times.**
The three entries that survived are the SKU-named ones, with the port, the class and the vendor's own
wattage; the four copies are absorbed. Two of the copies had the PSE on the wrong port, all six classed
it as negotiated 802.3at, and none of them could be asked for a budget.

## Evidence

Read 2026-11-20. Sizes are the bytes served to a crawler UA.

| Source | Status | Says |
| --- | --- | --- |
| <https://manual.mikrotik.com/hardware/hap-ax-2/> | 200, 59,180 B | "PoE-out Passive PoE **Ether1**, max out per port output (input < 30 V): 600mA"; "A number of 1G Ethernet ports 5"; "A number of 1G Ethernet ports with PoE-out 1" |
| <https://mikrotik.com/product/hap_ax2> | 200, 368,967 B | PoE-out block: ports "Ether 1", "PoE out Passive PoE", low-voltage limit 600 mA, "Max total out (A) 0.6 A", "Total output current 0.6", **"Total output power 16.8W"**. Powering: "PoE in Passive PoE", "PoE in input Voltage 18-28 V" |
| <https://manual.mikrotik.com/hardware/hap-ax-3/> | 200, 60,191 B | "PoE-out Passive PoE **Ether1**, max out per port output (input < 30 V): 0.625 A"; "**PoE-out total output power 15 W**"; "Number of 1G Ethernet ports 4"; "Number of 2.5G Ethernet ports **1 (supports PoE-in/out)**"; "Product code C53UiG+5HPaxD2HPaxD" |
| <https://mikrotik.com/product/hap_ax3> | 200, 425,662 B | "2.5G ethernet PoE Input/Output" feature flag; "There are 4x Gigabit Ethernet ports and an ultra-fast 2.5 Gigabit port"; PoE-out block: "Ether 1", passive, 0.625 A, "Total output power 15" |
| <https://manual.mikrotik.com/hardware/cap-ax/> | 200, 63,839 B | "PoE-in 802.3af/at"; "PoE-Out **Passive PoE up to 57V**"; "PoE-Out ports **Ether2**, max out per port output (input < 30 V): 600 mA, max out per port output (input > 30 V): 400 mA. Over 300 mA current, please use a DC jack" |
| <https://mikrotik.com/product/cap_ax> | 200, 382,189 B | PoE-out block: "Ether2", "Passive PoE up to 57V", "Max total out (A) 600 mA", "Total output current 0.4", **"Total output power 19.2"** |

## The census

| Box | Copper ports | PSE port | Standard | Vendor wattage |
| --- | --- | --- | --- | --- |
| hAP ax² (C52iG-5HaxD2HaxD-TC) | 5x 1G | ether1 | passive, 600 mA | 16.8 W (0.6 A x 28 V, top of the 18-28 V input) |
| hAP ax³ (C53UiG+5HPaxD2HPaxD) | 4x 1G + **1x 2.5G** | ether1 (the 2.5G port) | passive, 0.625 A | 15 W (0.625 A x 24 V) |
| cAP ax (cAPGi-5HaxD2HaxD) | 2x 1G | ether2 | passive up to 57 V, 600 mA (<30 V) / 400 mA (>30 V) | 19.2 W (0.4 A x 48 V) |

The watts are printed by the vendor, not derived here: the ax² page says "16.8W" outright, and the ax³ and
cAP ax pages print a bare "15" and "19.2" in the same "Total output power" row. In each case the arithmetic
in brackets is only a check that the figure agrees with the current limit the same two tables publish.

"No 802.3at" is not a stylistic preference. 802.3at is a negotiated 48 V standard; these ports pass the
input voltage through (18-28 V on the two hAPs, up to 57 V on the cAP). `docs/DEVICE_SCHEMA.md` records the
same distinction for the UISP Router, and `test/uisp-r-poe.test.js` is the precedent for gating it.

## What went wrong

| File | Said | Fate |
| --- | --- | --- |
| `devices/mikrotik/hap-ax2.json` | PSE on **eth5**, class `PoE+`, no budget | absorbed |
| `devices/mikrotik/C52iG-5HaxD2HaxD.json` | no PSE port at all, one radio (1200M only) | absorbed |
| `devices/mikrotik/c52ig-5haxd2haxd-tc.json` | `poe-pse` capability, no port sourcing | **kept**, corrected |
| `devices/mikrotik/hap-ax3.json` | **four** 1G ports, PSE on eth4, class `PoE+`; notes claimed the ax3 "trades a port for a faster CPU against the ax2" | absorbed |
| `devices/mikrotik/c53uig-5hpaxd2hpaxd.json` | five ports, 2.5G on eth1 (right), but no PSE port and no budget | **kept**, completed |
| `devices/mikrotik/cap-ax.json` | PSE on eth2 (right), class `PoE+`, radios listed at 1G in the sibling | absorbed |
| `devices/mikrotik/capgi-5haxd2haxd.json` | two radios **at speed `1G`**, no PSE port | **kept**, corrected |

The ax³ claim is the one worth naming: the box did not trade a port away against the ax², it upgraded one
of five to 2.5G, so every plan that picked the ax³ on the "four ports" reading was short a 2.5G socket.

## Unresolved

- Neither vendor page states per-port wattage, only current limits and a box total, so the ports carry
  `poeOut: true` with class `passive` rather than a per-port figure.
- The hAPs' **PoE-in** is passive 18-28 V; neither page states a draw in watts, so `poeIn` stays unset
  rather than being filled with an 802.3af figure the port does not negotiate.
- `devices/mikrotik/hap-ax-lite.json` and the LTE variant `capgi-5haxd2haxd-eg12-ea` are separate products
  and were not touched.
