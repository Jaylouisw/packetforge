# USW-Lite-8-PoE: which of the eight ports supply power?

**Question (one, narrow).** The UniFi Lite 8 PoE has eight RJ45 ports and a 52 W PoE budget. Does every
copper port source power (which is what this catalogue modelled), or only four of them?

**Verdict: four - ports 1-4 - and the model now says so port by port.** The engine's PSE inference promotes
every copper port of a `switch` whose model or label mentions PoE, a rule written for the 24- and 48-port
UniFi switches where every access port is a PSE. On the Lite 8 it made all eight ports PSE ports, so
`show power inline` offered power on 5-8 and the panel drew a PoE badge on sockets that are data-only.
`devices/ubiquiti/USW-Lite-8-PoE.json` now declares ports 1-4 as PoE+ and 5-8 as `"poeOut": 0`, and
`test/usw-lite-8-poe-pse-ports.test.js` (19 checks) holds the census, the allocation and the refusal.

## What the vendor publishes

| Source | Says |
| --- | --- |
| [Datasheet USW-Lite-8-PoE (PDF)](https://dl.ui.com/ds/usw-lite-8-poe.pdf) | "Networking interface: **(8) 10/100/1000 MbE RJ45 ports**"; "**PoE interface: (4) PoE/PoE+** (Pins 1, 2+; 3, 6-)"; "Max. PoE+ wattage per port by PSE: **30W**"; "PoE budget: **52W**" |
| [Ubiquiti tech specs, Lite 8 PoE](https://techspecs.ui.com/unifi/switching/usw-lite-8-poe) | Port Layout: "1 GbE RJ45 **8 (4 PoE+) (1G/100M/10M)**"; "Max. PoE Output: Up to PoE+"; "PoE Ports: PoE+ **4**"; "Max. PoE Wattage per Port by PSE: PoE+ **30W**"; "Total PoE Availability: **52W**" |
| [Installation-guide transcription, manuals.plus B08MBRKG2Q](https://manuals.plus/asin/B08MBRKG2Q) | The front-panel map: "**PoE LED** (Right, **per port 1-4**)". Setup: "For devices requiring Power over Ethernet (PoE), connect them to **ports 1-4**". Specifications: "PoE Interfaces: (4) 802.3af/at PoE Ports **(Ports 1-4)**" |
| [Second transcription, manuals.plus B08KC6KT1F](https://manuals.plus/asin/B08KC6KT1F) | "**RJ45 Ports (1-8):** Eight Gigabit Ethernet ports. **Ports 1-4 support 802.3at PoE+**"; "PoE LED (**Ports 1-4**)"; "PoE Interfaces: (4) 802.3at PoE+ Ports (**Ports 1-4**)" |

The count is the vendor's own in two places. The *numbering* is not in the datasheet: it comes from the
installation guide's front-panel map, which both transcriptions above reproduce identically. That is the one
inference in this note - that the four PoE sockets are the leftmost four, numbered 1-4 - and it is supported
by the panel drawing (a PoE LED per port 1-4) rather than by a sentence in the datasheet.

## What the catalogue already did elsewhere

The same split was already written on two sibling models, and this one had simply never been split:

* `devices/ubiquiti/usw-lite-16-poe.json`: ports 1-8 `"poeOut": 30`, ports 9-16 `"poeOut": 0`, 45 W.
* `devices/ubiquiti/us-8-60w.json`: ports 1-4 `"poeOut": true` with `"poeOutClass": "PoE"`, ports 5-8
  `"poeOut": 0`, 48 W - the same "8 (4 PoE)" panel shape as this model.

So the fix is data fidelity, not a new engine rule: the declaration mechanism and the inference's escape
hatch (`poeOut: 0` is not `null`, so `derivePortHardware()` does not guess) already existed.

## Why `true` and not `30`

The vendor's 30 W is a **PSE ceiling**, and this engine's numeric `poeOut` is read as a *draw* by
`pseDraw()` in `engine/validation.js` when a cable is connected. Writing `30` on four ports would make two
12.95 W access points look like 60 W against a 52 W budget and refuse the second cable - stricter than the
box, and stricter than the allocator, which correctly sums the PDs' `poeIn` (4 x 12.95 W = 51.8 W). The
boolean form plus `poeOutClass: "PoE+"` records what the datasheet says (the standard, not a wattage the
validator would misread), and is the form the Gen1 US-8-60W and USW-Ultra already use.

## What remains unresolved / out of scope

* **The exact port map on every hardware revision.** Two independent transcriptions of the installation
  guide agree on 1-4; no vendor page states it in a table. A photo of a unit's silkscreen, or Ubiquiti's
  own QSG text layer (the current `dl.ui.com/qig/` page is a JS image viewer with no text), would settle it
  beyond the transcription.
* **The 1G/100M/10M rung.** The tech-spec page prints "8 (4 PoE+) (1G/100M/10M)" and this spec still lists
  only `"speed": "1G"` with no `speedCaps`. That is the speed ladder's question, not this one, and was left
  unchanged.
* **Per-port budget policing.** `pseDraw()` still sums the PSE port's declared wattage rather than the
  connected PD's, which is why the boolean form was chosen here; making that function read the PD would be
  an engine change with a much wider blast radius.
