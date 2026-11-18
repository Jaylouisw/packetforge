# The E9624's mode was in the request all along: 1:1 = 24 small slots = 24x TNG1N210 = 240 line ports

Measured 2026-11-18, 09:5x UTC. This pass writes `devices/huawei/optixtrans-e9624.json` and closes
request #810 — the third and last of the E9600 subracks, after the E9605 (#807) and the E9612 (#808).
Every earlier pass (including `optixtrans-e9612-stated-build.md` §5) recorded the blocker as "the
cross-connect mode is not stated, and 1:1 vs 1:3 is 240 ports vs 200". That was wrong: the request's
own port line names the mode.

## 1. The stated configuration

Issue #810, "Ports and interfaces", verbatim:

> 12/24 service slots (1:1 cross-connect mode: 12 large or 24 small slots)

So the requester states the 1:1 cross-connect mode, and states the small-slot layout. `TNG1N210` is a
single-slot, 5.5 U board (237.1 x 30.5 x 220 mm, single-slot in the vendor's own valid-slot table), so
1:1 / small = 24 slots = 24 boards. The `unblock` field in `research/open-device-requests.json` asked
for exactly "one line naming the mode: `E9624, 1:1, 24x TNG1N210`"; the request supplies it in its own
words. No further input is needed and nothing here is inferred beyond 24 x 10.

## 2. What the vendor states, and where (all read 2026-11-18)

| field | value | source |
|--|--|--|
| frame | 747.2 (H) x 442 (W) x 295 (D) mm | *OptiXtrans E9600 Family* brochure PDF, E9624 column (`sourceUrl`), 277,705 B |
| service slots | 1:1: **12 large or 24 small**; 1:3: 10 large or 20 small; NOTE: one 11 U slot splits into two 5.5 U slots | same table, row *Max. number of service board slots* |
| slot map | physical and logical **IU1-IU24**, 1 occupied slot per board; 1:3 footnote: *service boards cannot be installed in slots IU6, IU7, IU18, and IU19* | `TNG2DAP` §1.9 Valid Slots, Table 1, E9624 row (871,676 B e-file PDF) |
| board fits an E9624 | `TNG1N206`/`TNG1N210`: **1:1 mode Y / 1:3 mode Y** | Boards Overview, Table 3, E9624 column |
| board port count | `TNG1N210: 10 x 10 Gbit/s Line Service Processing Board` | Boards Overview, Table 1 |
| cross-connect board, and where it sits | `TNG4CXP`, slots **IU71, IU72** — outside IU1-IU24 | EUCC-3089-2026-004 Security Target, Table 1-1 |
| brand join | `OptiX OSN 9800 M24` = `OptiXtrans E9624`, one row | same table, same page |

24 x 10 = 240 WDM-side line ports. The 20-slot 1:3 figure is the same arithmetic with the four excluded
slots removed (24 - 4 = 20), which is what the brochure prints; that mode is a *different box* and is
named as such in the spec's notes rather than being averaged in.

## 3. Why this shelf is not just "a bigger E9612"

Two vendor rows make it a different device, and both are in the spec:

- **It has a cross-connect.** The E9612 and E9605 tables print `Cross-connect Type: NA`; the E9624
  carries `TNG1CXP`, `TNG3CXP` or `TNG4CXP` in IU71/IU72 and switches `ODUk/PKT/VC`. Neither board has
  client ports and the engine has no cross-connect concept, so nothing is modelled for them — but the
  label says `1:1 mode` because the CXP board set is what that mode means.
- **It takes board types its siblings reject.** In the Boards Overview, the OTN tributary rows
  (`TNG1T206`, `TNG1T212`, `TNV1T410`) and the packet rows (`TNV2E224`) read **Y** under the E9624 column
  and **NA** under E9612/E9605. The modelled 24x N210 build is therefore one of several honest builds;
  the notes list the others so nobody reuses this file for a tributary shelf.

## 4. The mirror, and exactly which rows rest on it

`EDOC1100126589BEJ09047` (Boards Overview) is behind the support wall and its vendor copy
`EDOC1100163901` answers `302 -> /view/notFound` for every user-agent tried, so Tables 1 and 3 were read
from the verbatim partner copy `https://www.actfornet.com/solutions/solution/OptiXtrans_E9600_Boards_Overview`
(HTTP 200, 226,637 B), whose 127 `support.huawei.com/hedex` links identify the vendor chapter it
reproduces — the same basis the merged E9605 and E9612 entries use. The frame, slot map, mode arithmetic
and the cross-connect placement are all vendor-URL sources and do not depend on the mirror.

## 5. Port type

OTU2/OTU2e wavelengths filed as `ethernet` / `sfp+` because the engine has no `otn` type — the house
compromise in `otn-line-ports-need-no-new-type.md`, shared with the E9605, E9612, E6616, Ciena
WaveServer, ADVA FSP 3000 and PacketLight PL-2000M entries. `capabilities: ["cli"]`, no PoE, no copper.
