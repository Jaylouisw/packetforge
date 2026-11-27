# The Aruba 2930F SFP+ uplinks: which of them run at 1G?

**Question (one, narrow).** Issue #1066 says the JL256A's four uplinks are identical 10G SFP+ ports, but
the catalogue gave port 49 `speedCaps: [1000, 10000]` and ports 50-52 `[10000]`. Does HPE say all four
cages take a 1G SFP module (so the ports are interchangeable), or only the first? And does the same split
exist on the other 2930F rows?

**Verdict: settled - every SFP+ uplink in the 2930F family is a "1G/10G" cage, all four on the JL256A.**
HPE never distinguishes one uplink from another: the whole group is one line, "4 SFP/SFP+ 1G/10G ports".
The three rows that disagreed with that were fixed, and the "first port only" pattern was a residue of
#994, which patched the one port an audit named.

## Evidence

| Source | Says |
| --- | --- |
| [HPE Aruba Networking 2930F Switch Series QuickSpecs, c05052929](https://www.hpe.com/psnow/downloadDoc/HPE+Aruba+Networking+2930F+Switch+Series+QuickSpecs-c05052929.pdf?id=c05052929.pdf&isFutureVersion=true&ver=27&form=false&preview=false&hf=regular&isLinearized=false&contentDisposition=attachment) (Configuration Information, model rows) | "Aruba 2930F 24G 4SFP+ Switch  JL253A - 24 RJ-45 autosensing 10/100/1000 ports - **4 SFP/SFP+ 1G/10G ports** - min=0 \ max=4 SFP/SFP+ Transceivers"; the same block for JL254A, JL255A and **JL256A**; "Aruba 2930F 8G PoE+ 2SFP+ Switch JL258A - 8 RJ-45 PoE+ ... - **2 SFP/SFP+ 1G/10G ports**"; "Aruba 2930F 12G PoE+ 2G/2SFP+ Switch JL693A - ... - **2 SFP/SFP+ 1G/10G ports**". |
| Same QuickSpecs, Technical Specifications | JL256A: "I/O ports and slots - 48 RJ-45 autosensing 10/100/1000 PoE+ ports ... **4 SFP/SFP+ 1G/10G ports** ... min=0 \ max=4 SFP/SFP+ Transceivers". |
| [HPE product catalogue, 2930F 24G PoE+ 4SFP+ (JL255A) specifications](https://www.hpe.com/uk/en/product-catalog/options/pip.specifications.aruba-2930f-24g-poeplus-4sfpplus-switch.1008995332.html) | "(24) RJ-45 autosensing 10/100/1000 PoE+ ports **(4) SFP+ 1/10GbE ports**"; the differentiator repeats "4x 10G / 1G SFP+ transceiver slots for uplink connectivity". |
| [Aruba 2930F Installation and Getting Started Guide, Table 3 "Network ports"](https://arubanetworking.hpe.com/techdocs/hardware/switches/2930/IGSG/Aruba_2930_IGSG.pdf) | JL253A/JL254A/JL255A/JL256A: SFP ports "-", **SFP+ ports 4**; JL258A and JL693A: **SFP+ ports 2**. The 4SFP (non-plus) models JL259A/JL260A/JL261A/JL262A/JL557A are the rows with SFP ports, not SFP+. |

"1G/10G" on an SFP+ cage is the same claim `CAGE_SPEEDS['sfp+']` already encodes as `[1000, 10000]`
(`engine/media.js`), and the same one the engine uses to offer `1000base-sx` on an SFP+ port. HPE counts
the group in *transceivers* ("max=4 SFP/SFP+ Transceivers"), i.e. four sockets of one kind - not one
10G socket and three of something else.

## What was changed

* `devices/aruba/2930f-48g-poe-4sfp.json` (JL256A): ports 50, 51, 52 gain `1000` -> `[1000, 10000]`
  (port 49 already had it). Fixes #1066.
* `devices/aruba/2930f-24g-4sfp.json` (JL253A): ports 26, 27, 28 likewise.
* `devices/aruba/2930f-8g-poe-2sfp.json` (JL258A): port 10 likewise.
* `test/aruba-2930f-sfp-uplink-speeds.test.js` - 19 assertions. It failed on exactly those seven ports
  before the spec change and passes after; it also pins that the 1G-only SFP rows (JL260A, JL557A) do not
  pick up 10G, and that a 10G peer, a 10G DAC and a 1G SFP all cable to port 50 as they do to 49.

Nothing else moved: same port names, same `10G` label, same `sfp+` connector, same port count. The
JL693A (12G PoE+ 2G/2SFP+) and JL255A (24G PoE+ 4SFP+) rows already declared `[1000, 10000]` on every
uplink and are only covered by the test.

## What is inferred

* That the four JL256A uplinks are interchangeable rather than "port 49 is the odd one". Every HPE
  document states the group as one line with one transceiver ceiling, and none of them singles out a
  first port; a switch that offered 1G on exactly one of four identical cages would be a hardware
  curiosity nobody documents.
* That "1G/10G" means the cage accepts both an SFP (1G) and an SFP+ (10G) module. That is the MSA
  behaviour of an SFP+ cage and what the engine's `sfp+` ladder already assumes; the alternative reading
  (a 1G-only cage) is written as "SFP" on the sibling JL259A-JL262A rows, which HPE does distinguish.

## What is unresolved

* **The 2930F TAA SKUs.** JL263A, JL264A, JL559A and JL692A are the TAA twins of JL255A/JL256A/JL558A/
  JL258A and carry the same "4 SFP/SFP+ 1G/10G ports" line, but none of them is in the catalogue at all.
  Adding them is a device-addition task, not a port fix, and is left for a device request.
* **The link rate over a 1G optic in a 10G cage.** `negotiateSpeed()` returns the highest shared *port*
  rate, so a 1000BASE-SX run between two SFP+ ports reports 10G. That is a negotiation question
  (`research/aruba-cx-6300m-24sfp-cages.md` records it too), not a cage one, and the test does not assert
  a rate for the 1G run.
