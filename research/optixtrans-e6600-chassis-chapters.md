# The E6600 chassis chapters download anonymously - and they carry no board census

Follow-up to research/optixtrans-e6600-xt-census.md. #803 asks for the OptiXtrans E6616X and is
blocked on one field: which service boards are valid in the X subrack, and how many ports each has.
This pass found a new anonymous route into the per-chapter product documentation on the Huawei file
host and used it to fetch the E6616 chassis chapter. That chapter settles the frame slot arithmetic
from the vendor text - including a power-configuration trap the spec table hides - and it shows, by
inspection, that the downloadable chapter set contains no board census at all.

## 1. The route (reproducible, no login)

An e.huawei.com *material* page is server-rendered, and its HTML carries the asset path in clear:

```
https://e.huawei.com/en/documents/others/621bfc22e8564cf69ae86581569a7594
  -> HTTP 200, 337,802 bytes, title "(2)-OptiXtrans E6616-Datasheet - Huawei Enterprise"
  -> body contains pep/asset/20000001/Material/621bfc22e8564cf69ae86581569a7594/
       M3T1A669N1304588489052958777/_2_-OptiXtrans E6616-Datasheet.pdf
```

Fetching that path on e.huawei.com answers **301**; following the redirect lands on
e-file.huawei.com, **HTTP 200**, application/pdf, **1,535,511 bytes, 20 pages**. So the hard part of
reaching a chapter is one 32-hex *material hash* (which search engines do index); the 19-digit asset
token does not have to be found, because the page hands it over. scripts/huawei-material-fetch.js
automates however the asset lookup: it reads the page, then addresses
e-file.huawei.com/marketingcloud/pep/asset/... directly, because e.huawei.com answers 301 to a locale
page for some clients. Both hops were verified today; the script saves 1,535,511 bytes for this hash.

## 2. What the chapter is

OptiXtrans E6600 V100R025C10 - OptiXtrans E6600 Product Documentation, issue date **2026-03-31**,
page footers **2026-09-08**. Twenty pages, one chapter (1 E6616 Chassis): Overview, Change
Description, Components, **Slot Layout**, Device Capacity, Labels, Heat Dissipation System, Technical
Specifications.

## 3. Slot layout, from the vendor table

DC chassis (Table 1, section 1.4), verbatim in substance:

| Slot type | Slot IDs | Slots | Description |
|--|--|--|--|
| Service board slot | **1-14** | 14 | line board, tributary board, OTU board, OADM board, multiplexer/demultiplexer board, OA board, optical protection board, OSC board |
| System control board slot | **15, 16** | 2 | cross-connect, system control and clock board |
| DC power board slot | **17-18** | 2 | PIU board |
| FAN board slot | **19** | 1 | fan board |

AC chassis (Table 2): service slots are **2, 4 and 5-14**, printed as "12/10", with the note *"1500 W
AC chassis (with dual power supply modules): 12 - 2400 W AC chassis (with four power supply modules):
10"*; system control 15/16, AC power slots **1 and 3** (1500 W) or **1-4** (2400 W) for the TMB1APIU,
fan 19.

Same section, on regeneration: *"two line boards or two OTU boards must be configured in regeneration
paired slots ... For details about the support for paired slots, see the description of valid board
slots."*

## 4. The trap: "AC chassis: 12" is only one of the two AC variants

The public spec table prints DC chassis: 14 / AC chassis: 12. The chassis chapter shows the AC figure
is power-configuration-dependent: a **2400 W AC chassis has 10 service slots, not 12**, because four
slots carry TMB1APIU boards. A future E6616/E6616X spec label therefore has to name the power
configuration, or the slot count silently moves by two - the same class of error as quoting a frame
figure as a port figure.

Chassis assembly part numbers, from section 1.1: TMK5K31AFB (DC), TMK5K32AFB (DC, fiber tray),
TMK5K33AFB (AC 1500 W), TMK5K34AFB (AC 1500 W, fiber tray), TMK5K35AFB (AC 2400 W),
TMK5K36AFB (AC 2400 W, fiber tray).

## 5. What the chapter does not contain

There is no service-board census anywhere in the twenty pages. The only boards it names are:

- system control / cross-connect / clock: TMK5SXCH, TMK5XCH, TMK6XCH, TMK5UXCME, TMK5XCS;
- fgOTN cards: TMK1FXCL (100 Gbit/s fgOTN), TMK1XCL (40 Gbit/s fgOTN);
- power TMB1APIU, fan TMK5FAN.

Section 1.5 *Device Capacity* is per-slot **backplane** capacity (OTN / SDH / packet figures per
cross-connect board), and it says so: *"The slot capacity is the maximum access capability of the
backplane ... For details about the access capability of each board, see the specifications of each
board."* No port count, no cage, no board-to-slot matrix.

## 6. Why the rest of the downloadable set does not close the gap either

The same upload batch is reachable by the same route and was checked by title today (all HTTP 200):
(7)-OptiXtrans E6600 -EMC Standards, (8)-International Standards-E6616, (17)-OptiX OSN E6616 MIBs.
None is a board chapter. Two structural reasons a sibling cannot be guessed:

1. **Tokens run in an unknown sequence.** (2) is M3T1A669N1304588489052958777, (7) is
   ...1304588495816020204, (8) is ...1304588497429086385 - same prefix, different remaining digits.
   Only the chapters a search engine has indexed are addressable.
2. **The related-materials block is unrelated.** Each material page links six neighbours drawn from
   the same upload pool (CloudEngine 8855-32CQ4BQ, 6855-48T8CQ, 6863H, S12700E, S6750-H, S5755-S
   datasheets). Walking that graph does not reach an E6600 board chapter.

https://support.huawei.com/enterprise/en/optical-transmission/optixtrans-e6616x-pid-257173887
(HTTP 200, 454,559 bytes) lists the same E6600 document set plus a Datasheet entry
"OptiXtrans E6600 Brochure and Datasheet" dated **2026-07-01**, newer than the 26H2 brochure read
earlier, which has no board list. No anonymous asset URL for that 2026-07-01 item was found, and the
list is rendered client-side, so the page itself yields no download link.

The E6600 board mirror at https://www.actfornet.com/solutions/solution/OptiXtrans_E66000_Boards_Overview
(a partner reprint - a lead, not evidence) carries port counts in the board names
(TMK1UNQ2: 4 x 10G universal line service processing Board, TMK1UNS5, TMK1GTA, TMK1TTA, TMK1TDC,
TMK1EX10, TMK1SL16Q, TMK1SL64S, TMK1SLNO, TMK1MDCA) but its matrix columns are
**E6608T / E6608 / E6616** - the E6616X is not one of them.

## 7. What #803 is still missing, exactly

Per service-board model valid in the E6616X: **(a)** the part number, **(b)** that it is valid in the
E6616X subrack and in which slots (14 DC / 12 AC / 10 AC-2400), **(c)** its front-panel port census
(count, rate, cage). Any one of these would let "OptiXtrans E6616X (14x BOARD)" be written without
guessing:

- any TMB1* / TMK1* chapter PDF whose **Valid Slots** table names OptiXtrans E6616X, found by its
  32-hex material hash and fetched with scripts/huawei-material-fetch.js;
- a readable section of EDOC1100456166 (OptiXtrans E6600 V100R024C10 Hardware Description) or of the
  current-generation hardware description for the X;
- or a stated configuration from the requester.

No spec is added by this file: the frame arithmetic is now vendor-sourced and the card arithmetic is
not published in any chapter an anonymous reader can reach.

## 8. Sources read this pass (2026-11-17)

| URL | Result |
|--|--|
| https://e.huawei.com/en/documents/others/621bfc22e8564cf69ae86581569a7594 | 200, 337,802 B - material page, asset path in HTML |
| https://e.huawei.com/marketingcloud/pep/asset/20000001/Material/621bfc22e8564cf69ae86581569a7594/M3T1A669N1304588489052958777/_2_-OptiXtrans%20E6616-Datasheet.pdf | 301 to e-file.huawei.com, 200, application/pdf, 1,535,511 B, 20 pp |
| https://e.huawei.com/en/documents/others/8212cf1db6ae4fa090d6a94e8c1eb5b3 | 200, 337,891 B - (7)-OptiXtrans E6600 -EMC Standards |
| https://e.huawei.com/en/documents/others/ecdf0bcb6a68443381130f86a7f5f741 | 200, 337,882 B - (8)-International Standards-E6616 |
| https://e.huawei.com/en/documents/others/93497602262044be97b5e763c3b3c8da | 200, 337,826 B - (17)-OptiX OSN E6616 MIBs |
| https://support.huawei.com/enterprise/en/optical-transmission/optixtrans-e6616x-pid-257173887 | 200, 454,559 B - document set incl. OptiXtrans E6600 Brochure and Datasheet 2026-07-01, no asset link |
| https://e.huawei.com/en/products/optical-transmission/optixtrans-e6600 | spec table, four model columns (unchanged since 2026-11-16) |
| https://www.actfornet.com/solutions/solution/OptiXtrans_E66000_Boards_Overview | 200 - partner mirror, lead only |
| https://support.huawei.com/hedex/pages/EDOC1100126589BEJ09047/03/EDOC1100126589BEJ09047/03/resources/help/wdm/9800/hd/line/n210/n210.html | 403 (browser UA), 302 (curl and no UA) - still closed |
