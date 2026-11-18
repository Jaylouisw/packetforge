# The E9612's build is settled by one table row: 13 slots x TNG1N210 = 130 line ports

Measured 2026-11-18, 08:55-09:15 UTC. This pass writes `devices/huawei/optixtrans-e9612.json` and
closes request #808. It is the second of the OptiXtrans requests to leave the queue, and it uses the
same reading that settled the E9605 (#807): the board-to-subrack validity row and the board's port
count are one table, not two inferences.

## 1. What the vendor states, and where

| field | value | where it was read (2026-11-18) |
|--|--|--|
| frame | 442 x 295 x 347.2 mm (7.8U) | `https://e.huawei.com/en/products/optical-transmission/optixtrans-e9600`, HTTP 200, 344,531 B, spec table, E9612 column |
| service slots | **13** | same table, row `Number of Service Slots` (E9624 12/24, E9612 13, E9605 5) |
| cross-connect | **NA** | same table, row `Cross-connect Type` (E9624 ODUk/PKT/VC; E9612 and E9605 NA) |
| line rate / per channel | 10G to 1.2 Tbit/s | same table |
| board fits an E9612 | `TNG1N206`/`TNG1N210`: **Y** | Boards Overview chapter, Table 3 *Mapping between the line boards and OptiXtrans 9800 E9624/E9612/E9605 subrack* |
| board port count | `TNG1N210: 10 x 10 Gbit/s Line Service Processing Board` | same chapter, Table 1 |
| slot map | IU1-IU13 | `TNG2DAP` section 1.9, Valid slots, E9612 row (IU numbering only) |

13 slots x 10 ports = 130 line ports. No arithmetic beyond that.

## 2. The 13 is conditional, and the spec says so

The subrack chapter re-read on 2026-11-17
(`.../1df5f09736174bdcaed9ea4e9276bf8b/M3T1A669N1188254859888107676/OptiXtrans%20E9612%20-.pdf`,
333,351 B, 6 pp) prints the slot count per layout and per power option:

| layout | DC | AC / HVDC |
|--|--|--|
| AUX+SCC | 12 (IU1-IU12) | 10 master / 11 slave (IU3 onward) |
| E3CTU | **13** (IU1-IU13) | 11 (IU3-IU13) |

Under AC power one APIU occupies physical IU1 *and* IU2 with logical slot IU1, which is where the two
missing slots go. So the modelled 13-board shelf is the DC, 13-slot layout; an AC shelf holds 10-11
boards and is a different box. That caveat is in the spec's `notes`, not only here - a reader who takes
the port count without reading the thread must still see it.

## 3. Why a mirror is cited, and exactly which rows came from it

The chapter (`EDOC1100126589BEJ09047`) is behind the support wall; its vendor copy, *OptiXtrans E9600
Board Datasheet* `EDOC1100163901`, answers `302 -> /view/notFound` for every user-agent tried, as do
`EDOC1100214449`, `EDOC1100621488`, `EDOC1100622610` and `EDOC1100622612`. The text was read from the
verbatim partner copy, `https://www.actfornet.com/solutions/solution/OptiXtrans_E9600_Boards_Overview`
(HTTP 200, 226,637 B), whose 127 `support.huawei.com/hedex/pages/...` links identify the vendor chapter.

Table 3, as printed there:

```
TNG1N206 / TNG1N210   E9624: 1:1 Y, 1:3 Y   E9612: Y   E9605: Y
TNG1N401              E9624: 1:1 Y, 1:3 Y   E9612: Y   E9605: Y
TNV3N220 / TNV5N220   E9624: 1:1 Y, 1:3 Y   E9612: NA  E9605: NA
```

Two things follow. First, the E9612 column takes no mode qualifier - unlike the E9624, whose N210
validity is mode-dependent (that is what keeps #810 open). Second, the shortlist for this frame is
wider than the N210 (the N401, the M-series OTUs and the A212 also read Y), so the spec names its
board rather than implying the frame has a fixed panel.

The board's own chapter, as reprinted by a reseller (`https://www.thunder-link.com/tng1n210.html`,
200, 659,498 B), agrees on 10 ports, all `SFP+ -10G`, and gives valid slots `OSN 9800 M12: IU1-IU13`.
It writes the carrier subrack name; the brand join (`OptiX OSN 9800 M12` = `OptiXtrans E9612`) is
Huawei's own, from the EUCC Security Target Table 1-1 (see
`research/optixtrans-euuc-security-target-brand-join.md`). The spec rests on the Table 3 column, not
on that reprint.

## 4. Port type and fabric

The line ports are OTU2/OTU2e wavelengths, filed as `ethernet` / `sfp+` because the engine has no `otn`
type - the house compromise documented in `otn-line-ports-need-no-new-type.md` and shared with the
E9605, E6616, Ciena WaveServer, ADVA FSP 3000 and PacketLight PL-2000M entries.

There is no `fabric` block because the vendor table prints `Cross-connect Type: NA` for the E9612: the
board terminates 10 OTU2 wavelengths and the shelf relays rather than grooms. The E9624, whose table
row reads `ODUk/PKT/VC`, would need one.

## 5. What is still missing for #810 (E9624)

One field, unchanged: the cross-connect mode. The vendor table's `12/24` is 1:1 (12 large / 24 small)
or 1:3 (10 large / 20 small), and Table 3's N210 row is Y in both - so the same board gives 240 ports
or 200 depending on a mode the request does not state. `24x TNG1N210` in 1:1 is the vendor maximum and
is one line of requester input away; until then the E9624 stays open rather than doubling the shelf's
port count on an unstated assumption.
