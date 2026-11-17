# The E9600 board census is public — as one PDF per board, on e-file.huawei.com

Follow-up to `research/optixtrans-e9600-board-datasheet.md`. That note ended on a wall: Huawei names the
board→subrack matrix in *OptiXtrans E9600 Board Datasheet* (`EDOC1100163901`) and every anonymous route
to it answers 404, so #807, #808 and #810 stayed open. The wall is real for that document ID. It is not
real for the census: Huawei publishes the same **OptiXtrans E9600 Product Documentation** as one PDF
per board, on `e-file.huawei.com`, with no login — and each of those chapters carries a *Valid slots*
table that names the subrack and the slot range.

The route was found by accident, through a search hit on the `TNG2DAP` chapter. Nothing in the product
page, the `hedex` viewer or the EDOC URLs points at these files; the asset paths are opaque
(`/marketingcloud/pep/asset/20000001/Material/<32-hex>/M3T1A669N<19 digits>/<board>.pdf`) and only a
search engine has them.

## 1. The documents, fetched 2026-11-17

| document | URL | bytes | pages |
|--|--|--|--|
| TNG2DAP (OA board) | `https://e-file.huawei.com/marketingcloud/pep/asset/20000001/Material/e75c775ac71144e6b522d7cef1601604/M3T1A669N1188254864652623965/TNG2DAP%20-.pdf` | 871,676 | 51 |
| TNG2SRAPXF (Raman + EDFA) | `https://e-file.huawei.com/marketingcloud/pep/asset/20000001/Material/08ed3c9aa1274b2c84d9a591d467aaba/M3T1A669N1178216511632400475/OptiXtrans%20E9600%20TNG2SRAPXF.pdf` | 1,104,102 | 45 |
| TNG3SRAPXF (Raman + EDFA) | `https://e-file.huawei.com/marketingcloud/pep/asset/20000001/Material/6677fd881f334204859ba21c75a70586/M3T1A669N1188254866071122092/TNG3SRAPXF%20-.pdf` | (indexed; not re-fetched) | — |

All three answer `HTTP 200`, `application/pdf`, with the same cover: *OptiXtrans E9600 V100R024C00
Product Documentation, Issue Date 2024-09-30*, and the same sentence — "This document describes all
boards supported by the device." Chapter structure is uniform: Overview, Update Description, Mappings
and Substitution, Front Panel, Application, Functions and Features, Physical Ports Displayed on the
NMS, **Valid Slots**, NMS parameters, Port Specifications, Board Specifications.

## 2. The frame↔board census is in the Valid Slots table

`TNG2DAP` §1.9 "Valid Slots", Table 1, verbatim in substance (one occupied slot per board in every
frame):

| Device | Occupied slots | Physical slot | Logical slot |
|--|--|--|--|
| OptiXtrans E9605 | 1 | IU1, IU2, IU3, IU4, IU5 | IU1, IU2, IU3, IU4, IU5 |
| OptiXtrans E9612 | 1 | IU1 to IU13 | IU1 to IU13 |
| OptiXtrans E9624 | 1 | IU1 to IU24 | IU1 to IU24 |
| OptiXtrans E9624X | 1 | IU1 to IU24 | IU1 to IU24 |

and, under the same table:

> In the 1:3 mode of an E9624 subrack, service boards cannot be installed in slots IU6, IU7, IU18, and
> IU19.

Two things this settles independently of the marketing page:

1. **The subrack names in the board documentation are the enterprise names** (`OptiXtrans E9605` /
   `E9612` / `E9624`), not `OSN 9800 M05/M12/M24`. No name mapping has to be assumed to use these
   tables.
2. **The 1:3 arithmetic is confirmed by the board side.** 24 slots minus IU6, IU7, IU18 and IU19 is 20 —
   exactly the "1:3 cross-connect mode: 10 large slots or 20 small slots" the family brochure prints.
   The slot count is not a property of the frame alone.

## 3. What is still missing, exactly

A **client-port** board chapter.

What this note adds to `research/optixtrans-board-census.md` is the other half of that census: that file
derives port *counts* from board names (partner mirror plus the HCIP-Transmission board table), but a
reseller listing cannot say which frame a board fits, and the Valid Slots table is the vendor-hosted
answer to exactly that question.

Search reaches only OA boards (`TNG2DAP`, `TNG2SRAPXF`, `TNG3SRAPXF`) and one transceiver module (`eSFP,1310nm,1.25Gb/s…`, model `GE-1310nm-10km-SFP`). No OTU/tributary
chapter is indexed: queries for `TNG1N206`, `TNG1N210`, `TNG1N401`, `TNG1T206`, `TNG1T212`, `TNG1T401`,
`TNG1M210D`, `TNV1T210U` on `e.huawei.com` / `e-file.huawei.com` return the family brochure or nothing.
An OA board's ports are amplifier inputs and outputs — the wrong panel to hang a lab node on — so no
spec is written from the three chapters above.

`EDOC1100163901` remains unreachable. Re-probed today, so the next pass does not repeat it:

| URL shape | Result |
|--|--|
| `/enterprise/en/doc/EDOC1100163901/?` (trailing slash) | **404**, 452,479 B |
| `/enterprise/zh/doc/EDOC1100163901?idPath=…250732995` | **404**, 452,479 B |
| `/enterprise/en/doc/EDOC1100625542?idPath=…` (V100R026C00 HD) | **404**, 452,479 B |
| `/carrier/en/doc/EDOC1100163901` | **200**, 3,740 B — a Vue SPA shell (`/rmaweb/lst/js/index-*.js`), `<title></title>`, no server-rendered content and no anonymous content API |
| `/enterprise/en/doc/EDOC1100368229`, `/enterprise/en/doc/EDOC1100305240` (OceanProtect, control) | **404**, 452,479 B — the same not-found page, so this is the viewer refusing bare IDs, not a crawler problem |

## 4. What converts each issue now

The label shape is the one `docs/RESOLUTIONS.md` already sets — a stated configuration in the model
name. With a client board's chapter in hand, conversion is arithmetic, not judgement:

- **#807 E9605** = `OptiXtrans E9605 (5x <board>)` — 5 slots, `IU1–IU5`, from the table above.
- **#808 E9612** = `OptiXtrans E9612 (13x <board>)` — `IU1–IU13`.
- **#810 E9624** = `OptiXtrans E9624 (24x <board>, 1:3 mode)` or `(12x <board>, 1:1 large slots)`; the
  mode belongs in the label because it moves the count between 24, 20, 12 and 10.

Board candidates are *leads*, not sources, until their own chapter is read: a reseller mirror
(`https://www.actfornet.com/solutions/solution/OptiXtrans_E9600_Boards_Overview`) reprints a Y/NA
matrix in which `TNG1N206`/`TNG1N210` and `TNG1N401` are valid in all three subracks while the
`TNG1Txxx`/`TNV*` tributary boards are E9624-only. That is the right shape to *test* against a chapter;
it is not admissible as the census.

**One search hit per board is all that stands between this family and three closed issues** — or so this
note claimed on 2026-11-17. Section 5 below tests that claim by crawling the whole public graph, and it
does not hold: the OA chapters are the complete public set.

## 5. The document graph is exhausted: the client-board chapter is not published (2026-11-17)

The closing claim of section 4 — that one more search hit per board would convert #807/#808/#810 — was
tested this pass and does not hold. Three independent routes were walked to their end, and each one
stops at the same place: Huawei publishes *OA* board chapters and nothing else.

### 5.1 The "related materials" carousel is a graph, and it was crawled to exhaustion

Every `https://e.huawei.com/en/documents/others/<32-hex>` material page lists its siblings. Treated as a
graph and crawled breadth-first from the fourteen hashes already named on this thread, it drains in **52
material pages** — after that the frontier is empty, so the list below is the whole of it, not a sample:

| class | count | documents (52 pages in total) |
|--|--|--|
| OptiXtrans subrack/frame chapters | 4 | E9600 family brochure (`0f9e00e3…`), E9612 (`1df5f097…`), E9605 (`cc7356212e…`), E6608T (`a80f5e49…`) |
| OptiXtrans **board** chapters | 3 (4 pages) | `TNG2DAP` (`e75c775a…`, plus a second `TNG2DAP` page `e1834b3d…`), `TNG2SRAPXF` (`08ed3c9a…`), `TNG3SRAPXF` (`6677fd88…`) — all three are OA (amplifier) boards |
| transceiver datasheets | 6 | `SFP+ 2.5G/11.1G 80 km`, `SFP+ 1310 nm 10 km`, `eSFP 1310 nm 1.25G`, `eSFP 125M–2.67G 120 km`, `eSFP 1550.12 nm 120 km`, `SFP+ 1550.12 nm 80 km` |
| unrelated product lines on the same hub | 38 | OceanStor / Dorado / Pacific, CloudEngine, AirEngine, IdeaHub, FusionCube, eSpace UC (A220/A320/A350/C408S/DAG1000/MTG2000/SBC1000/TUC1000), eSDK … |

**Zero `TNG1N*`, `TNG1T*`, `TNG1M*` or `TNV*` chapters exist anywhere in that graph.** The absence is a
property of the content hub, not of this crawler: the OA chapters arrived in the graph through the same
edges a client-board chapter would have to use.

### 5.2 The 50-page `TNG3SRAPXF` chapter does not leak the client boards either

The previous pass listed `TNG3SRAPXF` as "indexed; not re-fetched". It was fetched this pass: `HTTP 200`,
`application/pdf`, **1,228,914 B, 50 pp**, same cover (*OptiXtrans E9600 V100R024C00 Product Documentation*,
2025-09-24). Its §1.3 *Mappings and Substitution Relationships* — the one table in the public set that
names boards other than its own subject — pairs only OA and CXP items: `TNG2SRAPXF01`, `TNG3SRAPX`,
`TNG1CXP`, `TNG3CXP`, `TNG1HCXP`, `TNG2HSOCXP`, `TNG3CXCS02/03`, `TNG3OACE101-108`, `TNG3OBCE106`.
Text-extracted occurrences of `TNG1N`, `TNG1T`, `TNG1M` and `TNV`: **0, 0, 0, 0**.

### 5.3 Two more routes, closed so nobody re-walks them

| route | result |
|--|--|
| `e.huawei.com` site search — `/en/search?q=`, `/en/search-result?keyword=`, `/en/searchcenter/search?keyword=`, `/en/documents?keyword=` | all four answer **200 with the same 336 KB client-rendered shell** and contain **0** occurrences of the query string. There is no server-side index to page through; the only index that resolves these hashes is an external search engine, which is exactly where the three OA chapters came from. |
| `info.support.huawei.com` document viewer / Info-Finder *Hardware Center* — `/hedex/api/pages/<EDOC>/…`, `/hedex/api/navi/<EDOC>`, `/hedex/api/book/<EDOC>`, `/hedex/api/menu/<EDOC>`, and `/info-finder/search-center/en/enterprise/…-pid-250732995/hardwarecenter` | every `hedex` path returns the same **91,294 B** Vue shell regardless of the EDOC (including the control URL that once served the Dorado connection-planning table), and the Hardware Center is a **5,804 B** shell whose bundle (`/info-finder/vue/assets/index-aac0aaf9.js`) sets `axios.create({baseURL:"/info-finder"})` and sends an `X-Csrf-Token` cookie. A browser user-agent gets **403** on both hosts. Neither is readable without a session. |

### 5.4 A certification record was checked as a possible second source, and is not one

`https://certification.enisa.europa.eu/document/download/e4a5ea1c-266b-4847-a8da-bf114e8dc6ff_en?filename=EUCC-3089-2026-004-CR.pdf`
— ENISA **EUCC-3089-2026-004**, *Certification Report*, 544,246 B, 25 pp, text layer extracted. It names
`OptiXtrans E9600 Series (E9605/E9612/E9624/E9624X)` and the product-documentation packages, i.e. it
confirms the document set exists — but it certifies software: **0** occurrences of `TNG`, **0** of
`board`. It cannot stand in for the board census.

### 5.5 What this changes

The exact missing field is unchanged — a `TNG1N*`/`TNG1M*` board's own *Front Panel* + *Port
Specifications*, one file. What changes is the next step. Searching again is not it: the public set is
complete for OA boards and empty for every board class an E9605/E9612/E9624 can actually carry service
on. The two routes that remain are a **stated configuration from the requester** (the label shape in
section 4), or a **Huawei support/partner login** for `EDOC1100163901` *OptiXtrans E9600 Board Datasheet*
— the one document that carries the board→subrack matrix and is withheld from anonymous readers.
