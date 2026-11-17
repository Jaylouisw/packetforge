# The vendor sitemap enumerates every document page - and the board census is not in it

Follow-up to `research/optixtrans-client-board-chapters.md`, which ended on "the indexes hold
`TNG2DAP`, `TNG2SRAPXF`, `TNG3SRAPXF` and transceivers, and the complete set of it". That statement
came from scraping search engines. This pass replaced it with a **finite enumeration of the vendor
index**: `e.huawei.com` publishes sitemaps, every document page is in them, and all 713 of them can
be titled. The board census the four OptiXtrans requests need is still absent - but "absent from a
set that has been counted" is a much stronger statement than "did not turn up in a search", and it
is what this note records.

Two by-products matter more than the negative result: the vendor file host's **User-Agent
inversion** (a browser UA is refused, an empty UA is served), and a **slot-count correction for the
E9612** that the queue record currently has wrong.

## 1. The route: robots.txt -> sitemap -> one page per document

`https://e.huawei.com/robots.txt` lists its sitemaps. `sitemap-ebg-x-default.xml` is 1,818,143 B
with 11,956 `<loc>` entries, of which **881** are `/en/documents/others/<32-hex>` document pages
(**713** unique). The zh sitemap adds 328 more, none of them optical.

Each document page is server-rendered and prints its title in an `<h1>`, so one request per hash
titles the whole set. All 713 were fetched on 2026-11-17: **708** carry a title, and the other five
are served as empty shells - no title, no attached file, so none of them can be a board chapter.

**Everything optical-transmission in those 713:**

| title | hash | what it is |
|---|---|---|
| `OptiXtrans E9600 Family -` | `0f9e00e3f2ca431693884a01667d7ec6` | family brochure |
| `OptiXtrans E9605 -` | `cc7356212e6146b58f38b74dd1102e08` | subrack (chassis) chapter |
| `OptiXtrans E9612 -` | `1df5f09736174bdcaed9ea4e9276bf8b` | subrack (chassis) chapter |
| `OptiXtrans E6608T -` | `a80f5e49b6d74beaa368b57673bc4c85` | subrack (chassis) chapter |
| `(2)-OptiXtrans E6616-Datasheet` | `621bfc22e8564cf69ae86581569a7594` | E6616 chassis chapter, 20 pp |
| `TNG2DAP -` | `e75c775ac71144e6b522d7cef1601604` | **board** chapter, 51 pp, optical amplifier |
| `TNG3SRAPXF -` | `6677fd881f334204859ba21c75a70586` | **board** chapter, Raman + EDFA |
| E6600 standards / EMC / MIB / NMS set | 5 hashes | compliance paperwork |

**Board chapters in the public index: two, both optical-layer.** `TNG1N206`, `TNG1N210`,
`TNG1N401`, `TNG1M*`, `TNG1T*`, `TNV*`, `TNK*` and `TMB1*` occur **zero** times across all 713
titles. The E9600 client board chapter is not "not yet indexed by Bing"; it is not in the vendor
sitemap, which is the list the vendor publishes *for crawlers*.

That closes the enumeration question three passes were circling. The remaining routes to the census
are exactly the account-walled documents already named - `EDOC1100621488`, `EDOC1100163901` - or a
human pasting one chapter.

## 2. The access matrix, before the next Huawei request

Different hosts want different clients, and the same URL that refuses a browser succeeds with no
User-Agent at all. Measured 2026-11-17:

| host / shape | browser UA | crawler UA | no UA |
|---|---|---|---|
| `e-file.huawei.com/marketingcloud/pep/asset/.../<board>.pdf` | 403 (533 B) | 403 | **200, full PDF** |
| `e.huawei.com/en/documents/others/<hash>` | 200 | 200 | 200 |
| `support.huawei.com/hedex/pages/<EDOC>/.../<topic>.html` | 403 (532 B) | 302 | 302 -> SPA shell |

Four dead ends, recorded so they are not re-walked:

- **The asset bucket does not list.** `/Material/<hash>/`, `?list-type=2`, `?prefix=` all answer
  HTTP 403 with an S3 body `AccessDenied`. A chapter cannot be enumerated from a sibling directory.
- **The hedex static-topic shape does not work for optical.** The shape that serves OceanStor topic
  HTML (`info.support.huawei.com/hedex/api/pages/<EDOC>/<lib>/<ver>/resources/<topic>.html`) answers
  200 for `EDOC1100126589` and returns the **91,294-byte support index**, not the topic - the same
  body the OceanProtect pass recorded. The `support.huawei.com/hedex/api/pages/...` variant 404s.
- **The "related documents" carousel is not an index.** Every document page carries seven sibling
  links, which looked like a chapter set. Tested: the siblings of `TNG2DAP` are the E9600 brochure,
  two SFP+ datasheets, `TNG3SRAPXF`, `OptiXtrans E9612`, `OptiXtrans E6608T`, `OceanStor 5310 Data
  Sheet` and a DAG1000 ATA. It is a topical carousel, not a product family.
- **Client fingerprinting, not rate limiting.** `python urllib` with an empty UA answers 403 on
  document pages where `curl` answers 200 a second later. Bulk work on this host must use curl, or
  it reads as a WAF block that is not there.

## 3. What the chassis chapters settle, and one correction to the queue record

`OptiXtrans E9605 -` (2 pp), asset
`https://e-file.huawei.com/marketingcloud/pep/asset/20000001/Material/cc7356212e6146b58f38b74dd1102e08/M3T1A669N1188254859704168616/OptiXtrans%20E9605%20-.pdf`

> Service board areas | 5 service boards | IU1-IU5
> Power and interface area | Two PIU/APIU boards; Two EFI boards | PIU/APIU: IU100-IU101; EFI: IU71-IU72
> Fan areas | One fan tray assembly | IU90
> System control and cross-connect board area | Two CTU boards

Mechanical: **177 x 442 x 260 mm, 7.6 kg**. The request quotes 295 mm depth; the E9612 chapter
prints 347.2 x 442 x **295** mm, so 295 looks like the E9612 figure borrowed into the E9605 request.
Recorded as a discrepancy, not resolved.

**Correction 1 - the E9605 does have management interfaces.** The queue record says the spec table
shows "not even a management Ethernet port". The spec table does not, but the subrack chapter does:
`EFI: IU71-IU72`, and the E9612 chapter spells out the function - *"The EFI board offers maintenance
and management interfaces"*, *"The AUX board offers maintenance and management interfaces to provide
system clock signals for each service board"*. So the shelf has a management path; the port **count**
is still unpublished, and that is the field the request needs, so this unblocks nothing by itself.

**Correction 2 - the E9612 slot count is not mode-independent.**
`research/open-device-requests.json` and four issue comments state "#808: 13 slots, mode-independent,
unlike its E9624 sibling". The E9612 subrack chapter contradicts that in two dimensions:

| subrack layout | DC power | AC / HVDC power |
|---|---|---|
| AUX+SCC (older) | IU1-IU12 = **12** service slots | IU3-IU12 = **10** (master), 11 (slave) |
| E3CTU | IU1-IU13 = **13** service slots | IU3-IU13 = **11** |

> In the case of AC or high-voltage DC power supplies, one APIU board occupies physical service board
> slots IU1 and IU2, and the occupied logical slot is IU1.

So `IU1-IU13` from `TNG2DAP` section 1.9 is the **E3CTU DC** figure. An E9612 labelled "13 service
slots" that ships with AC power and an APIU is off by two - the same off-by-two the E6616 AC chassis
was already found to have. Any future `E9612 (13x <board>)` spec needs its power option and subrack
layout named, exactly as the E9624 needs its protection mode.

`OptiXtrans E6608T -` and `(2)-OptiXtrans E6616-Datasheet` (20 pp) add nothing new for the open
requests. The latter is the E6616 chassis chapter already summarised in
`optixtrans-e6600-chassis-chapters.md` - service slots 1-14, system 15-16, DC power 17-18, fan 19,
and "Device Capacity" broken out per system board (`TMK5SXCH`, `TMK5XCH`, `TMK6XCH`, `TMK5UXCME`,
`TMK5XCS`), still with no per-board port table.

## 4. State of the four requests after this pass

| issue | what is still missing | after this pass |
|---:|---|---|
| #803 | service-board part number valid in an E6616X, and its port table | unchanged; the chassis chapter is capacity-only |
| #807 | one client board chapter | enumeration closed: not in the vendor sitemap |
| #808 | one client board chapter | unchanged, **plus** the slot count now needs a power option |
| #810 | one client board chapter, plus protection mode | unchanged; frame arithmetic already sourced |

Nothing here justifies a spec and none was written. The one thing a later pass should not do is look
for the board chapter on `e.huawei.com` again.
