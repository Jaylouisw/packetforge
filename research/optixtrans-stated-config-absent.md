# OptiXtrans has no stated configuration to copy — the "typical configuration" in both brochure families is an MTBF footnote

Fourth follow-up to `research/optixtrans-board-datasheet.md`, for #807 (E9605), #808 (E9612), #810
(E9624) and #803 (E6616X). `docs/plans/stated-configurations.md` closed the NetEngine 8000 family by
copying a build the vendor states. The question this pass asked was whether the same kind of line
exists anywhere for the OptiXtrans frames. It does not, and this note records the measurement rather
than another search: the phrase is present in both brochure families, and in both it is a caveat on
MTBF, not a card complement. Everything below was read on **2026-11-17** with the crawler user-agent
the vendor file host serves PDFs to.

## 1. The NetEngine build comes from a power-measurement row. OptiXtrans has no such row.

`devices/huawei/netengine-8000-m14.json` models `2x CR5DE2NE4X14 + 1x CR5D00E8XM25 + 3x CR5D00LAXF91 +
1x CR5D00EAGF95` because the NetEngine 8000 M14 datasheet prints that complement as a *power figure*:

> "DC: 1\*fan+2\*DC power+2\*IPU+2\*CR5DE2NE4X14+1\*CR5D00E8XM25+3\*CR5D00LAXF91+1\*CR5D00EAGF95=905.6 W"

That is a list of part numbers with counts, in a table the request itself points at. The OptiXtrans
equivalents say the same-sounding thing and carry no part numbers at all:

| document | size | what the "typical configuration" text is attached to | board part numbers |
|--|--|--|--|
| *OptiXtrans E9600 Family* brochure, `.../Material/0f9e00e3f2ca431693884a01667d7ec6/.../OptiXtrans E9600 Family -.pdf` | 277,705 B | footnote `c` on the MTBF / availability rows (50.94 / 53.44 / 39.91 years): *"The preceding parameters are calculated based on the typical product configuration. In actual use, these parameters vary according to the configured module."* | `TNG` **0**, `TMB` **0** |
| *OptiXtrans E6616X V100R026C00 产品彩页*, `.../Material/41f5e9d76d5944f98b0f17008b050765/.../OptiXtrans E6616X V100R026C00 产品彩页.docx` | 1,629,242 B | footnote `b` on MTTR / MTBF 111.9 years / availability 99.999898%: *"以上参数根据产品典型配置计算得出"* | `TMB1` **0**, `TMK1` **0**, `TM65` **1** (`TM65UXCL`, the cross-connect) |
| *OptiXtrans E6616 Datasheet*, `.../Material/621bfc22e8564cf69ae86581569a7594/.../_2_-OptiXtrans E6616-Datasheet.pdf` | 1,535,511 B | section 1.4 slot layout and 1.5 slot capacity | `TNG1` **0**; the 26 `TMK` codes are the assembly chassis (`TMK5K31AFB`–`TMK5K36AFB`), `TMK5FAN`, the system-control/cross-connect set (`TMK5SXCH`, `TMK5XCH`, `TMK6XCH`, `TMK5UXCME`, `TMK1XCL`, `TMK1FXCL`) and `TMB1APIU`, the power board |

So the label that closed the NetEngine issues — "the build the vendor states" — has no OptiXtrans
counterpart in any document Huawei serves anonymously. The frame chapters go further and decline a
default in as many words. `OptiXtrans E9605 -` (117,447 B, 2 pp) and `OptiXtrans E9612 -` (333,351 B,
6 pp) both print, in the service-board row of the areas-and-slots table:

> "Service boards need to be configured based on the service plan and all of them are installed in the
> service board area."

## 2. Every publicly readable document on the four product pages, counted

Earlier passes counted the E9605 page (39 public of 149) and the OSN 9800 M24 page (28 of 174). The
E6616X page and the E9612 / E9624 pages had not been enumerated. Requested one id at a time at
`https://support.huawei.com/enterprise/en/doc/<EDOC…>`:

| product page | document ids | `200` | `302 → /view/notFound` | board part numbers in the bodies |
|--|--|--|--|--|
| OptiXtrans E6616X (`optixtrans-e6616x-pid-257173887`) | 260 | **47** (23 video / multimedia) | 213 | **0** |
| OptiXtrans E9612 (`optixtrans-e9612-pid-250733000`) + E9624 (`optixtrans-e9624-pid-250733004`), deduplicated | 164 | **45** (30 video / multimedia) | 119 | **0** |

A body scan for `TMB1…`, `TMK…`, `TM65…`, `TNK…`, `TNG1…`, `TNV…` over all 92 open documents
returns the empty set. The two biggest open ones are the family user guides — `EDOC1100605035`
*Huawei OptiX OSN 1800, OptiXtrans E6600, and DC908 User Guide* (551,070 B) and `EDOC1100605036`
*Huawei OptiX OSN 9800 and OptiXtrans E9600 User Guide* — and neither carries a board census. The
remaining 23 + 30 are product videos and the *【Optical Basics】* series.

That is the same result the E9605 page gave, from three more pages: the open documents describe the
family, the enclosure and the cross-connect, and never a service board.

## 3. Correction: the sitemaps do not index this document set, so absence there proves nothing

`research/optixtrans-client-board-chapters.md` §5 and the #808 thread treat "the public index" as
countable. It is countable, but it is not the same set as the one that serves chapters.

This pass downloaded **all 32** sitemap files listed in `https://e.huawei.com/robots.txt` — 111,538
`<loc>` entries, **4,151** unique document material pages — and fetched every one of the 836 pages
under `documents/products/enterprise-optical-network/` and `documents/others/`, recording title and
inlined asset path. What it found:

- The five OptiXtrans material hashes already on these threads — `e75c775ac71144e6b522d7cef1601604`
  (TNG2DAP), `6677fd881f334204859ba21c75a70586` (TNG3SRAPXF), `1df5f09736174bdcaed9ea4e9276bf8b`
  (E9612 subrack), `cc7356212e6146b58f38b74dd1102e08` (E9605 subrack), `0f9e00e3f2ca431693884a01667d7ec6`
  (family brochure) — appear **0 times** in the sitemap set.
- The only OptiXtrans entries that *are* in it are brochures: *OptiXtrans E6616X* and *OptiXtrans
  E6608T* 26H2 彩页, plus *OptiX OSN 9800 M / K12 / K36 / U32E-U64E* 26H2 彩页.

So: a chapter that is public need not be in a sitemap, and a chapter that is absent from the sitemaps
need not be unpublished. Do not use either direction as evidence again; the search-engine hit is the
only discovery route into `/marketingcloud/pep/asset/20000001/Material/…`, and the asset path
(`<32-hex>/M3T1A669N<19 digits>/`) cannot be derived from a sibling board.

One useful by-product: the OSN 9800 M 26H2 brochure prints the *same* frame arithmetic as the E9600
family page — `1:1 模式：12个大槽位或24个小槽位；1:3 模式：10个大槽位或20个小槽位`, `13`, `5`, with heights
747.2 / 347.2 / 177 mm — and no board list either. The twins do not unblock each other.

## 4. The one build that *is* expressible, and why it is not written

`TNG2DAP` is the only board chapter Huawei publishes (`e75c…`, 871,676 B, 51 pp), and its §1.9 Valid
Slots row plus its Port Specifications table are enough to write `OptiXtrans E9605 (5x TNG2DAP)` = 25
LC ports. That complement is **not** vendor-stated — Huawei states that the board fits IU1–IU5, not
that a five-board shelf is a product — and TNG2DAP is an EDFA, whose ports are `IN/OUT/VI/VO/MON`.
Writing it would answer #807 with an amplifier shelf and would be exactly the "complement the vendor
never printed" that `docs/DEVICE_SCHEMA.md` § "A port list may be a stated build" rules out. Not
written.

## 5. Exact missing field, per issue

| issue | frame | missing field | the one artifact that closes it |
|--|--|--|--|
| #807 | E9605 (5 service boards, IU1–IU5; `IU73-IU74` unexplained) | a client-board chapter — `TNG1N*`, `TNG1M*`, `TNG1A212` — carrying Front Panel + Port Specifications | that chapter PDF, or a vendor line of the form `E9605, DC master, 5 x <board>` |
| #808 | E9612 (12 DC master / 10 AC master / 13 DC slave / 11 AC slave) | same | same chapter, plus the power option and the AUX+SCC vs E3CTU layout named in the label |
| #810 | E9624 (12 large or 24 small in 1:1; 10 / 20 in 1:3, IU6/7/18/19 excluded) | same | same chapter, plus the protection mode named in the label |
| #803 | E6616X (14 DC / 12 AC service slots; grey light, `Maximum Number of Wavelengths: N/A`) | a service-board part number valid in the X subrack **and** its front-panel census | `EDOC1100156575BEJ09044` (E6600 boards overview), the E6616X hardware description, or an ordering/configuration guide line |

## 6. Sources checked this pass (2026-11-17)

| URL | result |
|--|--|
| `https://e.huawei.com/en/products/optical-transmission/optixtrans-e9600` | 200, 344,530 B; the strings `TNG`, `board`, `typical` occur 0 / 0 / 0 times — the page is a specification table, not a build |
| `.../Material/0f9e00e3f2ca431693884a01667d7ec6/M3T1A669N1188254857740624027/OptiXtrans E9600 Family -.pdf` | 200, 277,705 B; "typical product configuration" is footnote `c` on MTBF |
| `.../Material/41f5e9d76d5944f98b0f17008b050765/M3T1A590N1296407376208097515/OptiXtrans E6616X V100R026C00 产品彩页.docx` | 200, 1,629,242 B; 典型配置 once, on MTBF; no service board |
| `.../Material/621bfc22e8564cf69ae86581569a7594/M3T1A669N1304588489052958777/_2_-OptiXtrans E6616-Datasheet.pdf` | 200, 1,535,511 B; chassis, PIU, fan and system-control codes only |
| `.../Material/cc7356212e6146b58f38b74dd1102e08/.../OptiXtrans E9605 -.pdf` | 200, 117,447 B; "configured based on the service plan" |
| `.../Material/1df5f09736174bdcaed9ea4e9276bf8b/.../OptiXtrans E9612 -.pdf` | 200, 333,351 B; same sentence, per power option |
| `https://support.huawei.com/enterprise/en/optical-transmission/optixtrans-e6616x-pid-257173887` + 260 `/enterprise/en/doc/<ID>` requests | 200, 454,559 B; 47 of 260 open, no board codes |
| `.../optixtrans-e9612-pid-250733000` + `.../optixtrans-e9624-pid-250733004`, 164 `/doc/<ID>` requests | 45 of 164 open, no board codes |
| all 32 sitemaps from `https://e.huawei.com/robots.txt`, 4,151 document pages, 836 fetched | section 3 — the document set is outside the sitemaps |

Nothing here closes an issue. #807, #808, #810 and #803 each need one client-board artifact, and the
route that closed the NetEngine family does not exist for this one.
