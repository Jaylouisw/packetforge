# The "(N)-" documents are one uploader's bundle, not a chapter index

Follow-up to `research/optixtrans-client-board-chapters.md`, which left #803/#807/#808/#810 on one
missing file: a **client** (service) board chapter with a port table. This pass took the one route that
had been described but never walked to exhaustion - the "Related Materials" list on an
`e.huawei.com/en/documents/others/<32-hex>` page - and it resolves into a small, hand-assembled bundle,
not into the product-documentation tree. The bundle is now enumerated completely; it contains two board
chapters and neither is a client board.

## 1. The route, measured

Each material page carries a `Related Materials` block of six links of the same shape
(`/en/documents/others/<32-hex>.html`). Breadth-first from the five optical-transmission pages already
cited on the issue threads - `621bfc22e8564cf69ae86581569a7594` (`(2)-OptiXtrans E6616-Datasheet`),
`e1834b3d08c04fdaa91b379cd487879a` (`TNG2DAP`), `08ed3c9aa1274b2c84d9a591d467aaba` (`TNG2SRAPXF`),
`cc7356212e6146b58f38b74dd1102e08` (`OptiXtrans E9605 -`), `f55a928fcfcf48aa8de79728324c4cff`
(`(4)-(NMS 1) Ethernet Service OAM E6600`) - the crawl **drains at 40 pages**, 27 of which carry an
`(N)-` prefix.

Those 27 are numbered **2 to 28 with only `(1)` absent**: one uploader's document set uploaded as
numbered parts, every member publicly fetchable, anonymous, one asset per page.

| # | document | hash | what it is |
|--|--|--|--|
| 2 | OptiXtrans E6616-Datasheet (20 pp) | `621bfc22e8564cf69ae86581569a7594` | chassis chapter (already read) |
| 3 | OptiXtrans FAT-TEST | `937368e184e647fd817598ebae76cd2f` | test record |
| 4 | (NMS 1) Ethernet Service OAM E6600 | `f55a928fcfcf48aa8de79728324c4cff` | NMS feature |
| 5 | ITU-T STANDARDS | `b472be7505e643229a89419d83b796fe` | standards list |
| 6 | **UXCME** | `5fa3c10e4f454dfaa44f26447563718d` | **board chapter** - system control |
| 7, 11 | E6600 EMC Standards | `8212cf1db6ae4fa090d6a94e8c1eb5b3`, `8e3baf7aac1e4e00952dcebe2251ef0c` | EMC |
| 8 | International Standards-E6616 | `ecdf0bcb6a68443381130f86a7f5f741` | standards list |
| 9 | Lado Tributario @ 10G | `267b32b0cf0a4a109d056d3d67f38bf1` | transceiver (OSX010N30) |
| 10 | OptiXtrans E6616 Product Brochure | `2f296e623f4448b6a79a5d07f38354a9` | brochure |
| 12 | Lado Linea @ 10 Gb | `ddc43e5c58dd466c9aac51a966a35629` | transceiver (TSFP+ C-band 40 km) |
| 13 | E6600 Complied Standards | `8a10d4e0337444bab0fc7b010a638c57` | standards list |
| 14 | Amplificador Optico (Booster & Pre-amp) and (Booster) | `73f27c923ca2473f83013ea4b213c91f`, `4ac3178cb0e64929a45ec953803fe8db` | amplifier notes |
| 15, 16, 26, 27 | iMaster NCE-T pages | `3de8e81cc80141ed868303f6115a8c55`, `4d53f8bfccc541ada686e68f48473db2`, `71fb96dd3bdb48869b110421fa659a51`, `8130a7d8fcc6410db936f6227a236bb0` | NMS |
| 17 | OptiX OSN E6616 MIBs (273 pp) | `93497602262044be97b5e763c3b3c8da` | MIB reference |
| 18 | DAP Parameters on the NMS | `e903dc1ff3dc4cdfa0696a977f546fd3` | amplifier parameters |
| 19, 20, 24 | Fireproofing, Safety, Environment standards | `cd5225aa4e8a4fd4874035fab01267ba`, `b680bcaa62ea48c28b4132667e79e671`, `c3b8f28d422c448887879cd24352621b` | standards |
| 21 | **TMB3AUX** | `104eb87894f1489dac28e58171dca5cc` | **board chapter** - auxiliary board |
| 22 | iMaster NCE Web LCT | `248065bee57544f49b1e62804bc02983` | NMS |
| 23 | Optical Amplification System-HLD | `b38bbdf507d44009b5a7821589482fdc` | design note |
| 25 | Huawei_OA_Analisis_Ingenieria | `b429c1210c6948edb8476a08a0c51143` | Spanish engineering note |
| 28 | User Guide ALARMS (272 pp) | `97bca46c56124331873c5b027e943258` | NMS |

Two consequences, both worth not re-deriving:

- the numbering is the uploader's, **not** a manual's chapter sequence, so `(N)-` cannot be extended by
  arithmetic and a missing number is not a withheld chapter - `(1)` simply was not published;
- the six "related" links are the uploader's other uploads, so this graph cannot enumerate the
  *OptiXtrans E6600 Product Documentation* tree. The worry recorded in the E9600 note - that crawling
  siblings would eventually surface a client-board chapter - is answered here: it does not.

## 2. The two board chapters, read end to end

Both are titled *OptiXtrans E6600 Product Documentation*, V100R025C10, issue date 2026-03-31 (page
footers 2026-09-08 and 2026-09-14), and both are genuine board chapters of the single-board pattern
(Overview, Front Panel, Indicators, Ports, Specifications). Neither is a client board:

- **`(6)-UXCME`** -
  `.../Material/5fa3c10e4f454dfaa44f26447563718d/M3T1A669N1304588494599672043/_6_-UXCME.pdf`,
  HTTP 200, `application/pdf`, **590,457 B**, 22,746 characters of text layer. The board is
  `TMK5UXCME` (system control, switching and timing): front panel, indicator table, micro switches,
  active/standby switchover. **Zero** occurrences of `E6616X`, `E6608T`, `E6616`, `E9605`, `TMB1` or
  `TMK1`, and **no `Valid Slots` section** - unlike the E9600 board chapters, these carry no
  board-to-subrack matrix at all.
- **`(21)-TMB3AUX`** -
  `.../Material/104eb87894f1489dac28e58171dca5cc/M3T1A669N1304590990909157504/_21_-TMB3AUX.pdf`,
  HTTP 200, `application/pdf`, **482,177 B**, 8,135 characters. The AUX board: dry-contact alarm and
  orderwire interfaces, clock cascading on `CLK1/TOD1` to `CLK3/TOD3` (electrical) or `HP1...`
  (optical). Its port table is *External Clock/Time Input (CLKn/TODn) / Output (CLKn/TODn) /
  Input-Output (HPn) / Electrical Port Cascading / Optical Port Cascading* - no tributary cage, no line
  port. Measured occurrences: `E6616X` 0, `E6608` 0, `Valid Slot` 0.

So the bundle proves the publishing pipeline and the chapter template, and it does not contain the
census. An `E9605 (5x TNG2DAP)`-style card complement still has no client-port counterpart on the E6600
side.

## 3. The E6600 documentation *is* published per chapter, anonymously

Four chapters of *OptiXtrans E6600 Product Documentation* V100R022C10 answer 200 `application/pdf` with
no login, which is the strongest form of the claim that the client-board chapters exist as separate
assets - the gap is indexing, not access:

| chapter | asset path (after `e-file.huawei.com/marketingcloud/pep/asset/20000001/`) |
|--|--|
| eSFP 1550.12 nm, 125M-2.67G, 120 km | `Material/e650e67ac43a4b169fd5001518bd346d/M3T1A669N1178212931847860258/` |
| eSFP 125M-2.67G, 120 km | `Material/0e71a2a025a04163855086dca63a42a9/M3T1A669N1188254854208806999/` |
| eSFP 1550.12 nm (2024-06-30 issue) | `Material/9b1a332637cd4bb89b1a418725bea060/M3T1A669N1188619944221204499/` |
| SFP+ 1310 nm, 0.125-11.3G, 10 km | `Material/aa2f7c1318cc45aba3862d26ff5d0105/M3T1A669N1188623573976080486/` |

The search index holds only transceiver and optical-layer chapters for E6600; that is an index-coverage
fact, not a publication fact.

## 4. Routes re-tested today, and their state

| route | result (2026-11-17, 16:20-16:35 UTC) |
|--|--|
| `info.support.huawei.com/hedex/api/pages/EDOC1100214756/YEK0928G/12/resources/plan_plan_all.html` - the Dorado hedex page that answered **200** earlier the same day | **302** to the login gate, Chrome UA |
| `support.huawei.com/hedex/hdx.do?docid=EDOC1100163901&lang=en` | **403**, 0 bytes |
| `info.support.huawei.com/hedex/api/doc/EDOC1100163901` and `/hedex/api/pages/EDOC1100163901` | **302** |
| `support.huawei.com/enterprise/en/doc/EDOC1100163901` | **403** |
| Wayback CDX `support.huawei.com/hedex/pages/EDOC1100156575*` and `hdx.do?docid=EDOC1100156575*` | `[]` - never archived |
| Wayback CDX `info.support.huawei.com/hedex/api/pages/EDOC1100156575*` | IA answered **503** (unverified, not proof of absence) |
| `https://e.huawei.com/en/documents/others/dc67ba7b606b46df975107406dafb0a1` | **200 but a 404 page**, title `404`, no asset path: the search hit for *OptiXtrans E6616 V100R025C10 Product Brochure* is a stale index entry. `scripts/huawei-material-fetch.js` reports it instead of downloading the shell. |

Corollary for the "the document exists but is withheld" statements on the E9600 threads: the hedex wall
is not a fixed property - the same URL family answered 200 this morning and 302 this afternoon - so a
hedex 200 is transient and cannot be scheduled around.

## 5. What is still missing, per issue

| issue | device | missing field | one thing that closes it |
|--|--|--|--|
| #803 | E6616X | a client/service board chapter with a port table **and** a statement that the board is valid in the X. The bundle supplies neither, and E6600 board chapters as published carry no `Valid Slots` table - so even a client-board chapter may not settle the X's board set. | a stated configuration (`E6616X DC (12x <board>)`), or an E6600 ordering/configuration guide. |
| #807, #808, #810 | E9605, E9612, E9624 | one `TNG1N*` / `TNG1M*` client-board chapter. E9600 board chapters **do** carry `Valid Slots`, so this single file would settle the family. | one such chapter PDF (`EDOC1100621488` or `EDOC1100163901`, behind the account wall). |

Nothing here is guessed and no spec file changes: the frame arithmetic was already vendor-sourced and the
port half is unpublished on every reachable surface.
