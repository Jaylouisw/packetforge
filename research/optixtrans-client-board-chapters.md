# The e-file board chapter is one board per document — and every chapter Huawei publishes is optical-layer

Follow-up to `research/optixtrans-board-chapters-public.md` (the note that PR #1816 carried for #807). That
note found the route — `e-file.huawei.com` serves *OptiXtrans E9600 Product Documentation* as one PDF per
board, anonymously, each with a **Valid Slots** table — and ended on one missing file: a chapter for a
**client-port** board. This pass went at that file from four directions and closed three of them. What it
found also removes a trap: the chapter boilerplate claims to describe *all* boards, and it does not.

## 1. The document set has IDs, and every one of them is a 404

`https://support.huawei.com/enterprise/en/optical-transmission/optixtrans-e9605-pid-250732995`
(HTTP 200, 436,367 B, crawler user-agent) lists the whole family's downloads. Names and IDs, so a human
with a Huawei account needs to fetch one file rather than search for it:

| document | ID |
|--|--|
| OptiXtrans E9600 V100R026C00 Product Documentation | `EDOC1100621488` |
| OptiXtrans E9600 V100R025C10 Product Documentation | `EDOC1100555960` |
| OptiXtrans E9600 V100R025C00 Product Documentation | `EDOC1100526526` |
| OptiXtrans E9600 V100R024C10 Product Documentation | `EDOC1100456274` |
| OptiXtrans E9600 V100R023C10 Product Documentation | `EDOC1100364568` |
| OptiXtrans E9600 V100R023C00 Product Documentation | `EDOC1100329304` |
| OptiXtrans E9600 V100R022C10 Product Documentation | `EDOC1100299692` |
| OptiXtrans E9600 V100R026C00 Hardware Description | `EDOC1100625542` |
| OptiXtrans E9600 V100R024C10 Hardware Description | `EDOC1100456418` |
| OptiXtrans E9600 Board Datasheet (2026-04-03) | `EDOC1100163901` |
| OptiXtrans E9605 Quick Installation Guide 02 | `EDOC1100156387` |

Each of the four doc roots retested today answers `302 -> https://support.huawei.com/view/notFound`, and the
`hedex` viewer is a 3,728-byte SPA shell whose JS bundle is the only asset it loads. `hedex/api/navi/<ID>`
still answers `401 {"status":401,"message":"NOT LOGIN!"}`. Nothing here has changed since the last pass; the
list is the useful part, not the URLs.

## 2. The boilerplate claims a board catalogue. It is not one.

`TNG2DAP -.pdf` was downloaded and read end to end this pass (871,676 B; 51 pages; `pdftotext -layout`
produces 123,451 characters of text layer). Chapter structure is the single-board pattern the earlier note
described — Overview, Update Description, Mappings and Substitution, Front Panel, Application, Functions and
Features, Physical Ports Displayed on the NMS, Valid Slots, NMS parameters, Port Specifications, Board
Specifications — and the file contains a sentence that reads exactly like an index:

> This document describes all boards supported by the device. Whether the boards can be supplied depends on
> the PCN release result.

It is a template artefact. Part-number census of the same 123,451 characters:

| pattern | occurrences |
|--|--|
| `TNG1N` | 0 |
| `TNG1M` | 0 |
| `TNG1T` | 0 |
| `TNV` | 0 |
| `TMB1` | 0 |

So "one PDF per board" is literal: the file documents TNG2DAP and nothing else, and the census needs the
client board's *own* chapter. Anyone reading that sentence as "the board list is inside" would download 51
pages of amplifier and conclude the board list had been withdrawn.

## 3. The frame census, verbatim from the vendor file

`§1.9 Valid Slots`, Table 1 (the `-layout` extraction splits the row labels below the values; the numbers
are as printed):

| Device | Occupied slots | Physical slot | Logical slot |
|--|--|--|--|
| OptiXtrans E9605 | 1 | IU1, IU2, IU3, IU4, IU5 | IU1, IU2, IU3, IU4, IU5 |
| OptiXtrans E9612 | 1 | IU1 to IU13 | IU1 to IU13 |
| OptiXtrans E9624 | 1 | IU1 to IU24 | IU1 to IU24 |
| OptiXtrans E9624X | 1 | IU1 to IU24 | IU1 to IU24 |

and the footnote on the same page:

> In the 1:3 mode of an E9624 subrack, service boards cannot be installed in slots IU6, IU7, IU18, and IU19.

That is the E9624 row #810 has been waiting for, from a vendor-hosted file rather than a partner mirror, and
it is the only field of the E9624 request that this pass could source.

## 4. Why the one public chapter must not be used to "unblock" the request

TNG2DAP is an amplifier. Its own port table, verbatim:

| Interface | Connector | Function |
|--|--|--|
| IN | LC | Receives from the line a multiplexed signal to be amplified. |
| OUT | LC | Transmits the amplified signal. |
| VI | LC | Receives a multiplexed signal for the VOA to adjust the signal power. |
| VO | LC | Transmits the power-adjusted signal to the EDFA module. |
| MON | LC | Connects to the spectrum analyzer boards for online optical performance monitoring. |

Five fibre interfaces per pluggable amplifier unit, none of them a client tributary. `OptiXtrans E9605
(5x TNG2DAP)` is therefore expressible as a spec and would be a **five-slot amplifier shelf** — a true
statement about a configuration nobody asked for, and a false answer to a request for an OTN node with
ODUk/PKT/VC cross-connect. Recorded here so a later pass does not reach for the one chapter that is actually
public: the same reasoning rules out `TNG2SRAPXF` and `TNG3SRAPXF` (Raman + EDFA hybrids).

## 5. Enumeration is closed, so the search route is spent

The asset path is `/marketingcloud/pep/asset/20000001/Material/<32-hex>/M3T1A669N<19 digits>/<file>` — the
32-hex material hash and the 19-digit token are unrelated to the board name, so a chapter cannot be guessed
from a sibling. Every listing endpoint tried answers 403 from the WAF:
`/marketingcloud/pep/asset/20000001/_system/shared/contenthub`, `/marketingcloud/pep/api/search?keyword=…`,
`/en/search?keyword=…` on `e.huawei.com` and `/api/search?keyword=…` on `e-file.huawei.com`. Scraping Bing
and DuckDuckGo for `site:e-file.huawei.com` returns nothing usable.

What the indexes do hold, and the complete set of it: `TNG2DAP`, `TNG2SRAPXF`, `TNG3SRAPXF`, and transceiver
chapters (`eSFP`, `SFP+`). Queries for `TNG1N206`, `TNG1N210`, `TNG1N401`, `TNG1M210D`, `TNG1M404DM`,
`TNG1M402`, `TNG1M520SM`, `TMB1LDCD` on `e.huawei.com` / `e-file.huawei.com` return the family brochure, a
partner page or nothing.

## 6. What each open issue is missing now

| issue | device | missing field | one thing that closes it |
|--|--|--|--|
| #803 | E6616X | service-board set valid in the X, with ports per board | a client board's port specifications from the E6600 set, or a stated `E6616X DC (14x <board>)` |
| #807 | E9605 | client board chapter (e.g. `TNG1N210`) | any `TNG1N*` / `TNG1M*` chapter PDF, then `E9605 (5x <board>)` |
| #808 | E9612 | same, 13 slots | same chapter |
| #810 | E9624 | same, 24 slots (20 in 1:3) | same chapter; frame arithmetic is now vendor-sourced (§3) |

The two documents that answer all four in one download are `EDOC1100621488` (V100R026C00 Product
Documentation) and `EDOC1100163901` (Board Datasheet), both behind the Huawei account wall.
