# The E6608T is a photonic shelf, not a small E6608 — and neither the X nor the T publishes a service board

Follow-up to `research/optixtrans-slot-census.md` and `research/optixtrans-board-census.md`, which left one
line open: *#803 E6616X / #804 E6608T — the E6600 matrix has not been read against the board documentation
yet.* It has now been read, and it is emptier than the E9600 side. This note records what the E6600 X/T
generation publishes, one correction to what the requests assume, and the exact field still missing for
both issues.

## 1. What the E6600 spec table actually says (read 2026-11-17)

`https://e.huawei.com/en/products/optical-transmission/optixtrans-e6600` — HTTP 200, 339,757 bytes. The
table has **four** model columns, `E6616 | E6608 | E6608T | E6616X`, and several rows use merged cells, so
column-by-column reading has to respect the merge. Per row, verbatim:

| Row | E6616 | E6608 | **E6608T** | **E6616X** |
|--|--|--|--|--|
| Dimensions (H x D x W) | 221.5 x 220 x 442 mm | 88.1 x 220 x 442 mm | **88.1 x 220 x 442 mm** | 221.5 x 220 x 442 mm |
| Weight | 10.6 kg | 4.9 kg | **4.9 kg** | 10.6 kg |
| Number of Service Board Slots | DC 14 / AC 12 | DC 6 / AC 4 | **DC 7 / AC 5** | DC 14 / AC 12 |
| Cross-connect Capacity | OTN(fgOTN)/PKT/SDH | OTN/PKT/SDH | **NA** | OTN/PKT/SDH |
| Maximum Number of Wavelengths | DWDM 96 / CWDM 8 | DWDM 96 / CWDM 8 | **DWDM 96 / CWDM 8** | **N/A** |
| Maximum Rate per Channel | 400 Gbit/s | 400 Gbit/s | **400 Gbit/s** | 100 Gbit/s (grey) |

The word "board" appears on that page exactly once, inside "Number of Service Board Slots". There is no
service-board row, no board part number, and no port count — for any of the four models.

## 2. The T is not a smaller E6608

Two rows above are the whole argument, and both contradict what #804 assumes:

- **Cross-connect Capacity: NA.** The E6608T has no OTN, packet or SDH cross-connect, so it is not an
  MS-OTN node with a smaller fabric. It is a **photonic / transponder shelf**: line boards, wavelength
  conversion boards, mux/demux, ROADM, amplifiers — the same shape as the E9605 in the E9600 family
  (Cross-connect Type: NA, 5 slots), one generation over. #804's capability line (MS-OTN; OTN/PKT/SDH
  unified switching) describes the **E6608**, not the T; its "100 Gbit/s grey per channel" belongs to the
  **E6616X** row. The T carries 400 Gbit/s per channel and 96 DWDM + 8 CWDM wavelengths, which a
  cross-connect-less shelf can only do by passing wavelengths through.
- **7 DC / 5 AC service slots against the E6608's 6 DC / 4 AC**, in the same 2 U, 4.9 kg enclosure. So the
  T is a *deeper shelf*, not a cut-down one: one more board position, no switching fabric behind it.

That distinction is exactly the class of error the catalogue exists to avoid. `devices/huawei/optixtrans-e6608.json`
models the E6608 as "6x B1LDCD, 24x 100GE client, 12x 200G line" and its notes already warn that an
AC-powered E6608 is a different box; an E6608T is a different box twice over.

## 3. What each reachable E6600 document contains

| URL | Result (2026-11-17) | Board content |
|--|--|--|
| `https://e.huawei.com/en/products/optical-transmission/optixtrans-e6600` | 200, 339,757 B | slot counts only, no board row (above) |
| `https://e-file.huawei.com/marketingcloud/pep/asset/20000001/Material/621bfc22e8564cf69ae86581569a7594/M3T1A669N1304588489052958777/_2_-OptiXtrans%20E6616-Datasheet.pdf` — *OptiXtrans E6616 Datasheet*, the document `devices/huawei/optixtrans-e6616.json` cites | 200, 1,535,511 B, 29,975 characters of text layer | chassis only: overview, components, **slot layout** (DC 14 service slots 1-14; AC slots 2 and 4 onward, 12/10; system 15/16; PIU; FAN 19), device capacity, heat, technical specs. Board codes present are `TMK5K31AFB` to `TMK5K36AFB` (assemblies), `TMB1APIU`, `TMK5FAN`, and the system/cross-connect boards `TMK5SXCH`, `TMK5XCH`, `TMK6XCH`, `TMK5XCS`, `TMK5UXCME`, `TMK1XCL`, `TMK1FXCL`. **No service board, no ports per board.** |
| `https://e.huawei.com/marketingcloud/pep/asset/20000001/Material/09b99122e93d41d6b062b43ee09f67f7/M3T1A590N1213159367844884537/OptiXtrans%20E6608%20V100R025C10%20Product%20Brochure%20%20_26H1_.docx` — the document `devices/huawei/optixtrans-e6608.json` cites | 200, 405,011 B, wordprocessingml document, text layer 6,771 characters | `Product Specifications (E6608)` only: dimensions, slots (DC 6 / AC 4), OTN 800G / OSU 800G / SDH 40-60G / packet 400G, 96 DWDM + 8 CWDM. The only board codes anywhere in the file are `K2UXCL` / `K2UXCLE` in the SDH cross-connect row. **No service board, no ports per board.** |
| `https://e.huawei.com/en/documents/products/enterprise-optical-network/91ebb26076e6453ab0c72480cd6e5464` leading to *OptiXtrans E6616X V100R026C00 Product Brochure (26H2)* | read end to end on a previous pass: 780G OTN (licence-gated TM65UXCL), 620G OSU, 160G VC-4, 820G packet, 14/12 slots, pluggable cages, MTBF | no board part numbers at all; the single board it names, `TM65UXCL`, is the system-control/cross-connect board |

## 4. The board document exists, and it is the one part of Huawei's site that is genuinely closed

The document that pairs boards with E6600 subracks — the boards-overview chapter `EDOC1100156575BEJ09044`,
whose sub-pages carry one entry per board — is served from the **hedex** static tree, not from
`/enterprise/en/doc/`. Measured today on a representative section page
(`https://support.huawei.com/hedex/pages/EDOC1100156575BEJ09044/01/EDOC1100156575BEJ09044/01/resources/1800v/hd/otu/ldcd/ldcd.html`):

| User-agent | Result |
|--|--|
| Googlebot crawler UA | **302**, 0 bytes (redirect to the login gate) |
| `curl/8.0` | **302**, 0 bytes |
| Chrome 120 desktop UA | **403**, 519 bytes |

This is the opposite of the `/enterprise/en/doc/<ID>/<8hex>/<slug>` pages, which a crawler UA reads whole
(see `research/huawei-netengine-8000-m-series-slots.md`). So hedex is a real wall and `EDOC1100156575BEJ09044`
cannot be quoted from here.

A partner page, `https://www.actfornet.com/solutions/solution/OptiXtrans_E66000_Boards_Overview`, is titled
"OptiXtrans E6600(E6608T E6608 E6616) Boards Overview" and lists about 40 boards (`TMB1LDCD`, 4-channel
100 Gbit/s to 2-channel OTUC2; `TMB1LTX`, 12 x multi-rate; `TMB1ELOM`, 8 x multi-rate; `TMK1EX10`,
10 x 10GE; `TMK1SL16Q`, 4 x STM-16; and so on), each linking into those hedex pages. That title is the
evidence that one board set serves all three subracks — but a partner mirror is a **lead, not evidence**,
and its entries stop at the board name, so it supplies neither the per-subrack validity matrix nor the
front-panel census.

## 5. A citing gap worth recording (not fixed here)

Neither document cited by the two shipped E6600 specs contains the board complement those specs model:

- `devices/huawei/optixtrans-e6616.json` — "14x B1LDCD, 56x 100GE client, 28x 200G line", source = the E6616
  Datasheet PDF above, which has no `B1...`/`...LDCD` string anywhere in its text layer;
- `devices/huawei/optixtrans-e6608.json` — "6x B1LDCD, 24x 100GE client, 12x 200G line", source = the
  V100R025C10 brochure above, which names only the cross-connect codes `K2UXCL` / `K2UXCLE`.

Both port lists are *consistent* with the board in their own labels (`TMB1LDCD` = 4 x 100GE client +
2 x 200G line, which the partner matrix states and which 14 x 4 and 14 x 2 multiply out to), so nothing
here says the numbers are wrong. What is recorded is that their `sourceUrl` does not carry the board
claim, and the claim's only readable home is the closed hedex document. The next pass that touches those
two specs should fix the citation rather than re-read the datasheets.

## 6. Exact missing field, and what would unblock #803 and #804

**Missing field:** the service-board part number valid in each subrack, plus that board's front-panel port
census — for the E6608T, *which of the 7 DC / 5 AC service slots accept which board*. Equivalently, one base
configuration line in the shape already used for E6608/E6616, for example "E6608T DC chassis with
7 x TMB1LDCD", which the catalogue can express today as a flat port list (28 x 100GE QSFP28 client,
14 x 200G CFP2 line).

**What would unblock it:**

- the boards-overview chapter of `EDOC1100156575BEJ09044` (or its V100R026 successor for the X/T
  generation), pasted by a reader with support access — that one page settles both issues;
- or a Huawei ordering / configuration guide that pins boards per E6608T and E6616X base model;
- or a decision to model these shelves as *frames with slots* rather than flat port lists — an engine
  feature, not a spec file, and outside this stream.

Until one of those arrives both issues stay open, and neither is guessed: an E6608T carrying the E6608's
cross-connect-capable board list would be a box that cannot exist, and an E6608T carrying a photonic board
list would need front-panel counts that no reachable vendor page prints.
