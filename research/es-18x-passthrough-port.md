# The EdgeSwitch 18X: which of the sixteen copper ports is the PoE one, and which way does power flow?

**Question (one, narrow).** Ubiquiti's tech-spec table for the ES-18X prints a single PoE row —
`PoE interface: (1) 24V passive PoE port (Pins 4, 5+; 7, 8-)` — against `Networking interface: (16) 10/100/1000
Mbps Ethernet RJ45 ports`. It does not say *which* of the sixteen ports that is, and it does not say whether the
port sources or sinks power. So: which port is it, in or out, and how much can it pass?

**Verdict: port 1 is the PoE inlet and port 16 is the outlet — a 24 V passive passthrough rated 15 W.**
The vendor says so in its own datasheet, in one sentence, and the sibling model's datasheet uses the same
construction. PacketForge had the outlet on the wrong socket (eth0, the first) and — because the device is a
`switch` with the `poe-pse` capability — the engine's switch-wide inference then promoted the other fifteen copper
ports to 15.4 W 802.3af sources. `show power inline` listed sixteen PSE ports on a box with one, and would have
powered a device on fifteen sockets that cannot source anything. The port is now eth15, the outlet is the only
PSE, and eth0 declares the inlet.

## Evidence

| Source | Says |
| --- | --- |
| [ES-18X datasheet, Ubiquiti PDF (©2020), mirrored at media.dustin.eu](https://media.dustin.eu/media/d200001001720050/edgeswitch-18x-product-data-sheet-brochure.pdf) | **"Sixteen Gigabit RJ45 ports offer copper connectivity with PoE input on port 1 and PoE passthrough on port 16."** Then, in the table: `PoE Interfaces: (1) 24V Passive PoE Port (Pins 4, 5+; 7, 8-)`; `Power Method: External AC/DC Adapter, 24V Passive PoE`; `Power Supply: 24VDC, 1.0A Power Adapter (Included), 24V Passive PoE`; `Max. Power Consumption: 14W (Excludes PoE Output)`; `Passive PoE Max Wattage: 15W per Port`; `Passive PoE Voltage Range: 24V`; `PoE: Enable/Disable Passive PoE`. |
| [UISP EdgeSwitch 18X tech specs](https://techspecs.ui.com/uisp/wired/es-18x) (the page the catalogue entry already cited, HTTP 200, 580,575 B, read 2026-11-20) | The same rows, without the port numbers: `PoE interface: (1) 24V passive PoE port`, `Power method: 24V DC, 1A power adapter (Included) 24V Passive PoE`, `Max. power consumption: 14W (Excludes PoE output)`, `Passive PoE Max. wattage per port: 15W`. This is why the port could not be named from the entry's original source. |
| [HostiFi, "EdgeMAX — Which devices use active PoE and passive PoE?"](https://support.hostifi.com/en/articles/8386547-edgemax-which-devices-use-active-poe-and-passive-poe) | A per-model table of direction and port: `ES-18X — Type of PoE in: 24v in on port 1; Type of PoE out: 24v out on port 16; Number of PoE ports: 1`. Reseller documentation, but it agrees with the vendor sentence above rather than adding to it. |
| [EdgeSwitch X datasheet (Ubiquiti)](https://dl.ui.com/ds/edgeswitch_x_ds.pdf) | The same construction one size down: `For the EdgeSwitch 10X … eight Gigabit RJ45 ports offer copper connectivity with PoE input on port 1 and 24V PoE passthrough on port 8`, and `Software-selectable PoE Passthrough on Port 8`. The passthrough outlet is the **last** copper port in this family, not the first. |
| [EdgeSwitch XP User Guide (Ubiquiti)](https://dl.ui.com/guides/edgemax/EdgeSwitch_XP_UG.pdf) | `PoE is disabled by default on all ports. To output PoE to the connected device, select 24V or 48V`. The XP line's passive PoE is a per-port switch that starts off; the 18X's datasheet row `PoE: Enable/Disable Passive PoE` reads the same way. |

## What the catalogue said before, and what it says now

Before this pass (`devices/ubiquiti/es-18x.json` at `b98ca1c5`):

* `eth0` carried `poeOut: true, poeOutClass: "passive"` — the entry's own note admitted that the tech-spec page
  never names the port and that "this entry keeps it on eth0, the first, which is where the ES line puts it, and
  that is an assumption rather than a citation". The assumption was wrong: the line puts its single PoE port last.
* `eth1`–`eth15` carried nothing, and the device has `poe-pse` beside `category: "switch"`, so
  `derivePortHardware()` (`engine/media.js`) filled every one of them with **15.4 W** — the 802.3af default — even
  though this is a 24 V fixed-voltage box. Sixteen PSE ports, fifteen of them invented, on hardware where a
  cable to a downstream switch would have looked like a powered link.

Now:

* `eth15` (port 16) — `poeOut: 15`, `poeOutClass: "passive"`. The outlet, at the vendor's per-port ceiling.
* `eth0` (port 1) — `poeIn: 14`, the box's own `Max. Power Consumption: 14W (Excludes PoE Output)`, the same shape
  `devices/ubiquiti/er-10x.json` uses for its 8 W inlet. `poe-pd` is declared for the same reason.
* `eth1`–`eth14` — `poeOut: false`, which is how this catalogue says "the datasheet covers this port and it does
  not source" (the MikroTik entries use the same token) and what stops the switch-wide inference re-promoting them.
* A `poe` block with a **derived** 10 W ceiling (below), marked `DERIVED` in its note, so the audit stops counting
  the entry as silent while the number is never presented as one Ubiquiti printed.

`test/es-10x-passthrough.test.js` pins the outlet (`eth15=15`), the absence of every other PSE, the inlet
(`eth0=14`), the derived budget, and the console's answer — `show power inline` now names one port with nothing
plugged in, where it used to name sixteen PSE ports.

## What is inferred

* **eth15 is port 16.** The catalogue numbers this box's copper ports `eth0`–`eth15` in panel order, so the
  sixteenth is `eth15`. Nothing in the file states a panel label separately; the inference is the port order, not
  a caption.
* **"Passthrough" means the outlet carries the input rail.** The word is the vendor's, and it is what the sibling
  ES-10X datasheet spells out (`PoE input on port 1 and 24V PoE passthrough on port 8`). The consequence used here
  is that the outlet's ceiling depends on what feeds the box: 15 W per port is the hardware's limit, and the
  included 24 W adapter is the smaller supply.
* **10 W is the adapter-fed budget.** `24 W adapter − 14 W box draw = 10 W`, the same arithmetic
  `devices/ubiquiti/es-10xp.json` uses (60 − 8 = 52 W) and `devices/ubiquiti/uisp-r.json` before it. It is marked
  derived, not quoted, because Ubiquiti prints no total PoE row for this switch and the subtraction is ours. With a
  larger 24 V passive source on port 1 the outlet could pass more, so a lab that models one can state more.

## What remains unresolved, and what would settle it

* **Does the outlet work when the box is powered only by its adapter?** "Passthrough" suggests the outlet is fed
  from the input rail, and the adapter feeds the same rail, but no Ubiquiti sentence says the outlet is live in
  adapter mode. Settle it with a unit: adapter only, nothing on port 1, a 24 V passive device on port 16, and see
  whether it powers up. The model assumes yes (that is what a budget is for); if the answer is no, the port should
  depend on `poeIn` being live, which the engine cannot express today.
* **Which number binds — the port's 15 W or the adapter's 10 W?** The datasheet prints both and never compares
  them. The model takes the smaller (10 W) because a PSU rating must not be served as headroom the supply cannot
  deliver, the same call `research/catalyst-2960x-poe-budget.md` records for the 2960-X. A capture of a 12 W device
  on port 16 with the included adapter would settle whether the box really refuses it.
* **Is the outlet on out of the box?** The XP guide says PoE is disabled by default on all ports and the 18X row
  says "Enable/disable passive PoE", which reads the same way, but no 18X transcript or screenshot was found. The
  engine has no per-port PoE admin state at all (`_poeAdminMode()` returns `auto` for every port), so this is a
  question for a later pass either way; a fresh unit's `show` output, or the 18X's own UI, would settle it.
* **The inlet's real draw.** 14 W is the datasheet's *maximum*, excluding PoE output; idle draw is lower, so the
  10 W ceiling is conservative. A measured figure would tighten it, but no vendor page prints one.
