# The last unread public E6600 document is a MIB guide: 273 pages, zero board tables

Measured 2026-11-19 00:4x UTC, one increment on request #803 (Huawei OptiXtrans E6616X). The issue has
one missing field - the service-board census (which board, how many ports, how many slots) - and every
route recorded on the thread ends at Huawei's login wall. What no note recorded was whether the one
member of the public 27-part `(N)-` bundle that nobody had opened, **`(17)-OptiX OSN E6616 MIBs`**,
carries an equipment or board table. It does not. This closes the MIB route, not the issue.

## 1. Provenance

| field | value |
|--|--|
| material page | `https://e.huawei.com/en/documents/others/93497602262044be97b5e763c3b3c8da` - 200, 337,826 B (crawler UA) |
| asset path (printed in the page's `attachmentUrl` input) | `https://e-file.huawei.com/marketingcloud/pep/asset/20000001/Material/93497602262044be97b5e763c3b3c8da/M3T1A669N1304591003040927770/_17_-OptiX%20OSN%20E6616%20MIBs.pdf` |
| fetch | **200**, `application/pdf`, **5,602,882 B**, sha256 `bce97d81…f3f50d87bae` |
| access nuance | no user-agent **200**; Googlebot UA **200**; desktop Chrome UA **403** (569 B) - the same host behaviour already recorded for the brochures |
| extraction | `pypdf` 6.21.4, **273 pages**, **495,778 characters** of text layer (no OCR needed, no image-only pages in the appendix) |
| title page | *OptiX OSN E6616 / V100R025C10SPC010 / User Guide / Issue 01 / Date 2025-12-31* |

Note the document family: this is the **OSN E6616** MIB user guide, not the *OptiXtrans E6600*
V100R025C10 product documentation whose chapter 1 the earlier pass read. Its issue date (2025-12-31) is
the newest printed date among the anonymously served members, which is why it was worth opening: it is
the one part of the set that could have been regenerated after the R025C10 chapters.

## 2. What its 273 pages actually are

Contents (p. ii-iii) is SNMP only: `2 Introduction` (SNMP framework), `3 Networking Mode`,
`5 Preparations for Using the SNMP`, `6 MIB Information of the Optical Network Product Line`,
`7 Differences Between Huawei Proprietary MIBs and Standard MIBs`, `8 FAQs`, and then
`9 Appendix: Description of the MIB Files` from page 18 to 273 - one subsection per MIB table
(`boardPer15mCurTable`, `new_boardPer24HHisTable`, `tunnelPer15mCurTable`, `otu1_pathPer15mCurTable`,
…), each printed as a row-per-node table of `Data Type`, `Description`, `Read/Write`, `Status` and an
OID prefix.

That is a performance and alarm data dictionary. It describes how to *poll* a board that is already
installed; it does not enumerate boards, cages or slot maps.

## 3. Keyword census over the extracted text (case-insensitive)

| string | occurrences | what the hits are |
|--|--|--|
| `E6616X` | **0** | - |
| `OptiXtrans` | **0** | the document names only `OptiX OSN E6616` |
| `Service Board` | **0** | - |
| `Number of Service` | **0** | - |
| `TM65` / `TMB1` / `TMB2` / `TMK5` | **0** each | no board part number of any generation |
| `board type` | **1** | prose in an alarm-trap description: *"Board slot ID and board type"* - a trap payload, not an enumeration |
| `slot` | **6** | all in the `board=%d,subcard=%d,port=%d,path=%d` index explanation and the same trap description |
| `port` | 346 | performance object names and index prose; no port census |

The appendix never lists an enumerated `boardType` (no `hwOptixBoard*`/`optixBoard*` node in the text
layer), so the one hope this document held - a MIB enumeration naming `TMB2DMS` as a type valid on the
E6616X - is absent.

## 4. The MIB files themselves are behind the same wall

Section 6.2 *Obtaining the MIB Files* is explicit: log in at `support.huawei.com`, then
`Transmission Network > WDM/OTN > OptiX OSN 1800`, `Software` page, version, download the package,
unzip. So the compiled MIB - the only artifact that could carry a board-type enumeration - is a
software download behind an account, exactly like the hardware descriptions. There is no anonymous
copy of the `.mib` set in this bundle; the bundle ships the guide to the MIBs, not the MIBs.

## 5. Where this leaves #803

Every member of the public bundle has now been either read end to end or measured against the census
question - the last two, `(17)` and `(3)`, in this pass - and the inventory is:

| anonymous document | content | board census |
|--|--|--|
| `(2)-OptiXtrans E6616-Datasheet` (20 pp) | chassis chapter: slot layout 1-14 / 15-16 / 17-18 / 19, DC vs AC power variants, per-slot capacity | no |
| `(6)-UXCME`, `(21)-TMB3AUX` | single-board chapters (system control, auxiliary) | no client board, no `Valid Slots` |
| `(17)-OptiX OSN E6616 MIBs` (273 pp, this pass) | SNMP performance/alarm dictionary | no |
| `(3)-OptiXtrans FAT-TEST` (8 pp, this pass) | factory-inspection report template, 9,004 chars: test steps and pass/fail boxes, no built complement | no |
| brochures, standards, NMS, transceiver notes (the other 24 parts) | marketing, compliance, management, optics | no |
| deployment tender (non-vendor, cited on the thread) | names `TM65K32AFB` + `65UXCL` + `B2PD1` + `B2DMS`, qty 1 each | partial, not a complement |

**Blocker, unchanged and now fully bounded:** the board set valid in an E6616X subrack and the
front-panel census of `TMB2DMS`/`TMB2PD1` (including whether `1*DMS+2*PD1` costs one slot or three).
It is not published anonymously, because the document that carries it is login-gated, not missing:
one authenticated read of `EDOC1100625826` (V100R026C00 documentation package) or `EDOC1100558549`
(V100R025C10 hardware description, 配套设备 table) settles it, as does a commissioning record of the
shape `E6616X, TM65K32AFB, slots 1-14: n x <board>`.

No spec file is added and no port, wattage or slot figure is asserted here. `tmp/` and `.staged/`
untouched.
