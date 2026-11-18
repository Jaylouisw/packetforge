# The OptiXtrans support portal answers 146 of 174 documents with `notFound`, and the 28 that open carry no ports

Follow-up to `research/optixtrans-client-board-chapters.md` and `research/optixtrans-e9600-board-datasheet.md`.
Those notes closed the *vendor file host* (`e-file.huawei.com`) and the *vendor sitemap* (`e.huawei.com`,
713 document pages, two board chapters, both optical-layer). This note closes the third surface, the
support portal that hosts the numbered documents themselves — and records one vendor sentence that came
out of it, because it is the only statement found so far that puts the E9600 subracks and the OSN 9800 M
subracks in one family on Huawei's own site.

Checked 2026-11-17 against vendor hosts only.

## 1. The portal serves product pages to a crawler and 403s a browser

`https://support.huawei.com/enterprise/en/optical-transmission/optix-osn-9800-m24-pid-22048459`

| User-Agent | result |
|--|--|
| `Mozilla/5.0 (compatible; Googlebot/2.1; …)` | **200**, 442,970 B, server-rendered, full document list |
| Chrome/131 | **403**, 472 B |
| empty | **403**, 472 B |
| `curl/8.4.0`, `python-requests/2.31.0` | 200, but 25,028 B — a shell with no document list |

This is the same client fingerprint that `research/optixtrans-board-chapters-public.md` §5 recorded for
`e-file.huawei.com` ("serves PDFs to an empty User-Agent while returning 403 to a browser UA"), now measured
on the portal as well, in the opposite direction. It matters for the record rather than for the queue: a
browser-UA probe of this host measures the WAF, not the catalogue, which is why earlier passes logged
"unreachable" for pages that do render.

## 2. Every document on that page, counted

The rendered page links **174 unique document ids**. Each was requested with the crawler UA:

| result | count |
|--|--|
| `302` → `https://support.huawei.com/view/notFound` (404) | **146** |
| `200`, document body served | **28** |

Of the 28 that open, **24 are videos** — `(Video) OSN 9800 M Series Product Introduction (Full Version)`,
`(Video) OptiX OSN 9800 M Series Hardware Introduction`, the OSU-advantage set, and the twelve
`【Optical Basics】` issues. The remaining **2** are documents, and this is the pair worth naming:

- `EDOC1100605036` — *Huawei OptiX OSN 9800 & OptiXtrans E9600 User Guide*, 550,913 B;
- `EDOC1100605336` — *Product Supplementary Cybersecurity Information (EUCC) - OptiX OSN 9800 & OptiXtrans E9600*, 462,529 B.

Neither is hardware: in `EDOC1100605036` the strings `TNG1N`, `Port Specifications`, `IU1` and
`line service processing` occur **zero** times, and `E9605`/`E9612`/`E9624` occur once each, inside the
scope sentence quoted in §3. `EDOC1100605336` has `TNG1N` 0, `slot` 0, and one `E9605`, also in scope.
So of the whole document set Huawei publishes beside this subrack, **zero readable documents carry a port
table**, and the page's own Datasheet entry — *OptiX OSN 9800 Board Datasheet* → `EDOC1000074739` — is one
of the 146, i.e. the 2014-era `EDOC1000…` numbering is as closed as the current `EDOC11006…` one.

## 3. The one vendor sentence that does help, and its exact limit

Both readable documents carry the same scope paragraph:

> The hardware models covered by this guidance are: The OSN 9800 series (U64E/U32E/M24/M12/M05/P32/P32C)
> and E9600 series (E9605/E9612/E9624/E9624X).

and, describing the abbreviation: *"OSN Series is used to replace the OptiX OSN 9800 series … and E9600
series (E9605/E9612/E9624/E9624X)."*

Vendor-authored, on a Huawei host, naming all four subracks in the queue's family next to the OSN 9800 M
subracks. What it establishes: Huawei treats the E9600 subracks as the **same hardware family** as the OSN
9800 M subracks, so a board document filed under `OptiX OSN 9800` covers `E9605/E9612/E9624` rather than
being a sibling product like the E9624X. What it does **not** establish: an individual `E9605 → M05`
mapping. The two lists are printed in parallel, not pairwise, so this is supporting evidence for accepting
an OSN 9800 board chapter when one turns up — it is **not** a licence to take the M05's or M24's census and
call it an E9605. That distinction is the E6608-from-E6608T error this catalogue has already corrected.

## 4. The carrier marketing host has no board document either

`carrier.huawei.com` was not previously checked. It is not a candidate: its whole
`~/media/cnbgv2/download/products/networks/` PDF folder holds **103** archived URLs (Wayback CDX), of which
**8** are WDM/OTN, and every one is a brochure or a datasheet.

- The OSN 9800 M datasheet (`…/networks/optix-osn-9800-m-en.pdf`, capture `20261016161322`, 308,946 B, 6 pp)
  has a text layer of 14,161 characters with **0** occurrences of `TNG1N` and **0** of `N210`; it stops at
  *"board slots … 12 large slots or 24 small slots"*, which is capacity, not a census.
- The live host answers **403** (485 B) to both URL shapes under an empty UA and a browser UA.
- The brochure capture (`…/wdm-otn/osn-9800-m-en.pdf`, `20221007014829`) arrives truncated at exactly
  1,048,576 B and its xref is unreadable, so it is **not evidence either way** — recorded so the next pass
  does not spend two fetches discovering that.

`info.support.huawei.com` re-confirmed in passing: `hedex/hdx.do?docid=EDOC1100163901&lang=en`,
`hedex/api/pages/EDOC1100163901/EN/01` and a product path all answer 200 with the identical **91,294 B**
shell, crawler UA included.

## 5. What is still missing, and what would unblock

Unchanged, and now documented from three separate hosts: **one client-board chapter with a Port
Specifications table** — `TNG1N206` (6 x 10 Gbit/s line), `TNG1N210` (10 x 10 Gbit/s line) or `TNG1N401`
(1 x 100 Gbit/s line) — plus, for #808 the power option/layout and for #810 the protection mode that decide
the usable slot count.

What would unblock, in order:

1. `EDOC1100163901` (*OptiXtrans E9600 Board Datasheet*) or `EDOC1100214449` (*OptiXtrans E9624X Board
   Datasheet*), or any *OptiX OSN 9800 Board Datasheet* chapter, pasted by a reader with a support session —
   §3 makes an OSN 9800 board chapter acceptable for this family;
2. one board chapter as a published PDF on any host Huawei controls;
3. a stated configuration from the requester ("E9605, 5 x TNG1N210") **plus** that board's port table.

Then #807 becomes `OptiXtrans E9605 (5x TNG1N210)` — a stated card complement, the convention
`devices/huawei/optixtrans-e6616.json` already uses — and no field is guessed.

## 6. The E9605's own page, counted document by document

Every earlier note in this file measured a *neighbour's* page — the OSN 9800 M24's 174 ids. This pass
measured the page the request is actually about, and the result is the same shape with a smaller set.

`https://support.huawei.com/enterprise/en/optical-transmission/optixtrans-e9605-pid-250732995`
(HTTP 200, 436,367 B, crawler user-agent, read 2026-11-17) links **149 unique document IDs**. Requested one
at a time under the same user-agent:

| result | count | what they are |
|--|--|--|
| `200` | **39** | 24 `(Video)` items, 12 `【Optical Basics】` issues, 3 documents |
| `302 -> https://support.huawei.com/view/notFound` | **110** | everything else, including the Datasheet |

The three public documents are `EDOC1100605036` (*OptiX OSN 9800 and OptiXtrans E9600 User Guide*),
`EDOC1100605336` (EUCC supplementary cybersecurity statement) and `EDOC1100414468` (Smart Urban Rail
all-optical solution page). A text census across all 39 bodies: `TNG1` **0** occurrences,
`Port Specifications` **0**, `IU1` **0**. So the E9605's own support page does not print one board part
number, in any document it publishes — the board set exists on this page only as `EDOC1100163901`,
*OptiXtrans E9600 Board Datasheet* (2026-04-03), which is one of the 110.

## 7. The article URL shape is not the reason for the 404s

Two passes have wondered whether `…/en/doc/<ID>` 404s because the article-level URL form was wrong. It is
not. Huawei serves publicly-published documentation root pages at exactly that shape:

| URL | result |
|--|--|
| `…/enterprise/en/doc/EDOC1100400005` (*Optical Transmission Basics 01*, a guide listed on this same product page) | **200**, 492,157 B |
| `…/enterprise/en/doc/EDOC1100400005/bec365f7/network-management` (one article inside it) | **200**, 484,645 B, 28 sibling article links |
| `…/enterprise/en/doc/EDOC1100625542` (*E9600 V100R026C00 Hardware Description*) | **302 -> /view/notFound** |
| `…/enterprise/en/doc/EDOC1100163901` (*E9600 Board Datasheet*) | **302 -> /view/notFound** |

Same host, same user-agent, same minute. The difference is publication status, not URL grammar — which is
what makes the withholding conclusion safe to state and stops the next pass retrying a URL shape.

## 8. A tributary board is the cheaper artifact than a line board

The three line boards named so far (`TNG1N206` 6x10G, `TNG1N210` 10x10G, `TNG1N401` 1x100G) all terminate
on the **WDM side**: their ports are OTU2/OTUk optical interfaces, which `engine/media.js` cannot describe
except as `ethernet`/`sfp+` — a wrong protocol claim on a real socket. A **tributary** board is different:
its ports face the client, and the E9600 tributary/transponder set (`TNG1M*`, `TNG1A212`, `TNG1T2xx`) carries
10GE LAN as a first-class client service, so `type: ethernet, speed: 10G, connector: sfp+` is the vendor's
own claim rather than a translation.

The candidate worth naming is **`TNG1A212`**, *12 x 10 Gbit/s any-rate service processing board* — each port
usable as a tributary port or a line port. It is a **lead, not evidence**: the only statements that it fits
an E9605 (`IU1-IU5`) and that it has 12 ports come from partner mirrors
(`actfornet.com/solutions/solution/OptiXtrans_E9600_Boards_Overview`,
`thunder-link.com/tng1m210d.html`), and this catalogue has already corrected three family-sibling errors.
No Huawei-hosted chapter for `TNG1A212`, `TNG1T212` or `TNG1M210D` is indexed on `e-file.huawei.com` or
`e.huawei.com` today (searched 2026-11-17).

If that chapter surfaces, `#807` closes as `OptiXtrans E9605 (5x TNG1A212)` = 60 x 10G client ports plus
that board's own published line ports, with the slot count from `TNG2DAP` §1.9 (`IU1-IU5`) and nothing
guessed. That is a smaller ask than a whole Board Datasheet and it is the same one file for `#808`/`#810`.

## 9. A different Huawei host or TLD is the same deployment, not a way round the wall

Previous passes have looked for an alternative route into these documents. This section closes the *host* axis:
`support.huawei.cn` and `info.support.huawei.com` were never tested, and both are the same backend.

| URL | result |
|--|--|
| `https://support.huawei.cn/enterprise/en/optical-transmission/optixtrans-e6616x-pid-257173887` | **200**, 25,028 B - a Nuxt SPA shell, zero document links, `window.__NUXT__` config only |
| `https://support.huawei.cn/enterprise/en/doc/EDOC1100486186` | **200**, **3,800 B** |
| `https://support.huawei.cn/enterprise/en/doc/EDOC1100163901` | **200**, **3,800 B** |
| `https://support.huawei.cn/supportgateway/view/v1/enterprise/doc/catalogue?nid=EDOC1100163901` | **401** `{"status":401,"code":"support-view-020003","message":"need login."}` |
| `https://info.support.huawei.com/enterprise/br/optical-transmission/optixtrans-e9624-pid-250733004` | **403**, 370 B (Chrome UA); **200, 91,294 B** (Googlebot and bare `curl`) |

The 3,800 B is the same `supportview/lst` bundle loader `support.huawei.com` serves, and the 401 is the same
gateway code and message as §5 on `.com`. A regional TLD is a CDN edge in front of one document service.
The `info.` host answers 403 to a browser and, to a crawler, the 91,294-byte generic support index - the same
page every dead `hedex` path already returns - so a 200 from `info.` is the not-found, exactly as on `dl.ui.com`.

`e-file.huawei.com/robots.txt` and `e-file.huawei.com/sitemap.xml` answer Akamai **403** (387 B and 388 B,
`errors.edgesuite.net` reference), so there is no asset index to enumerate material hashes from. The only
index that lists these chapters is a search engine's, and it carries no `TNG1N*` client chapter.

## 10. `idPath` is navigation context, tested in the form the site itself emits

Section 7 showed the article URL shape is not the reason for the 404s, using a bare `…/en/doc/<ID>`. The E9605
support page does not emit bare links - it emits `…/enterprise/en/doc/<EDOC>?idPath=24030884|9856748|9858640|250707904|250732995`.
Requested exactly that way (pipes percent-encoded, crawler UA, 2026-11-17):

| Document | `EDOC` | result |
|--|--|--|
| OptiXtrans E9600 Board Datasheet | `EDOC1100163901` | **404 -> `/view/notFound`**, 452,479 B |
| E9600 V100R024C10 Hardware Description 04 | `EDOC1100456418` | **404 -> `/view/notFound`**, 452,479 B |
| E9600 V100R023C10 Hardware Description 08 | `EDOC1100365420` | **404 -> `/view/notFound`**, 452,479 B |

So the parameter does not resolve them either, and the two ids are new to this thread: the E9605 page's
own Hardware Description entries for R024C10 and R023C10 are `EDOC1100456418` (issue 04) and
`EDOC1100365420` (issue 08).

**Unchanged blocker, and it is now measured on every axis tried:** one client-board chapter
(`TNG1A212`, `TNG1T212`, `TNG1M210D`, `TNG1N206`, `TNG1N210` or `TNG1N401`) with a Front Panel and Port
Specifications table, or `EDOC1100163901` pasted by a reader with a support session. Nothing in sections 1-10
is a substitute for that one file.
