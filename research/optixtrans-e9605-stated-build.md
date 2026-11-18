# The E9605's build is settled by one chapter: 5 slots x TNG1N210 = 50 line ports

Measured 2026-11-18, 08:00-08:20 UTC. This pass writes a spec (`devices/huawei/optixtrans-e9605.json`)
and closes request #807. It is the first of the five OptiXtrans requests to leave the queue, and the
reason is not new access — it is that the two fields previous passes held apart arrive in the *same*
vendor chapter, and that chapter prints the port count inside the board's own name.

## 1. What the vendor states, and where

| field | value | where it was read (2026-11-18) |
|--|--|--|
| subrack height | 177 mm (4U), 442 x 295 mm footprint | `https://e.huawei.com/en/products/optical-transmission/optixtrans-e9600` — HTTP 200, 344,532 B, specification table, E9605 column |
| service slots | **5** | same table, row `Number of Service Slots` (E9624 12/24, E9612 13, E9605 5) |
| cross-connect | **NA** | same table, row `Cross-connect Type` |
| board slot map | IU1-IU5 | `TNG2DAP` section 1.9, e-file PDF (871,676 B, 51 pp), E9605 row of *Valid slots* |
| board fits an E9605 | `TNG1N206`/`TNG1N210`: **Y** | Boards Overview chapter, Table 3 *Mapping between the line boards and OptiXtrans E9624/E9612/E9605 subrack* |
| board port count | `TNG1N210: 10 x 10 Gbit/s Line Service Processing Board` | same chapter, Table 1 |

The last two rows are the ones four earlier passes refused, and the refusal was right on the letter:
the Boards Overview chapter (`EDOC1100126589BEJ09047`) is behind the support wall, and its vendor copy
— `OptiXtrans E9600 Board Datasheet`, `EDOC1100163901` — answers `302 -> /view/notFound` today, as does
`EDOC1100214449` and `EDOC1100621488`. What had not been recorded before is that the **validity row and
the port count are one reading, not two inferences**: the chapter's Table 3 prints `Y` under the E9605
column for the N206/N210 row, and Table 1 names the board `10 x 10 Gbit/s`. Ten ports, five slots, no
arithmetic beyond 5 x 10.

## 2. Why the mirror is used here, and how it is labelled

The text was read from the verbatim partner copy,
`https://www.actfornet.com/solutions/solution/OptiXtrans_E9600_Boards_Overview` (HTTP 200, 226,637 B),
whose 127 `support.huawei.com/hedex/pages/...` links identify the vendor chapter it reproduces. The
spec's `notes` say exactly that: which fields came from the chapter text as mirrored, which from a
huawei.com page, and that the vendor copy is gated. This is the same disclosure shape the catalogue
already carries for the E6616 and E6608 (`TMB1LDCD` census behind `EDOC1100156575BEJ09044`), so a reader
of the spec can tell a vendor-read field from a mirror-read one without reading the thread.

What is **not** done: no field is taken from a sibling frame. `TNG2DAP` section 1.9 is still the DAP's
own slot table (see `optixtrans-dap-slots-are-dap-only.md`); it supplies the IU numbering, not validity.
The E9612 and E9624 stay open (#808, #810) because their slot counts move with power configuration and
their builds are not settled by this reading.

## 3. The port type compromise, restated for this spec

The line ports are OTU2/OTU2e wavelengths, filed as `ethernet` / `sfp+` because the engine has no `otn`
type — as in `devices/huawei/optixtrans-e6616.json`, `devices/ciena/waveserver-ai.json`,
`devices/adva/fsp-3000.json` and `devices/packetlight/pl-2000m.json`. The mismatch is written into the
spec's `notes`, and `scripts/audit-port-types.js` passes. See `otn-line-ports-need-no-new-type.md`.

## 4. What is still missing for the rest of the family

Unchanged: one **vendor** copy of the N210 chapter (or `EDOC1100163901`) would replace the mirror-read
rows above with a huawei.com URL and settle #808/#810 in the same paste. For those two the missing
field is not the board but the build: `E9612` is 13 service slots only in the E3CTU DC chassis (12 DC,
10/11 AC/HVDC), and an E9624 in 1:3 mode holds 20 boards, not 24.
