# The new support portal is a signed single-page app - its document index is not anonymous either

One increment on request #803 (Huawei OptiXtrans E6616X), 2026-11-19 02:0x UTC. Every earlier Huawei
pass on this family worked the **hedex** document tree (`/hedex/api/navi/<EDOC>/first-level-tree`, 401) or
the anonymous `e-file.huawei.com` asset route. Nobody had measured the surface that has since replaced
both on the product page: `support.huawei.com` now serves `enterprise/en/...` pages as a Vue single-page
app whose document list is **fetched**, not printed. If that fetch were anonymous, the board chapters
would be reachable at last. It is not - and the endpoint names are read out of the app itself, so this is
a closed instrument rather than a query that failed.

## 1. The page is a shell

| URL | result |
|--|--|
| `https://support.huawei.com/enterprise/en/optical-transmission/optixtrans-e6616x-pid-257173887` | **200, 6,539 B** - `<div id="app">` shell, no document content, no `idAbsPath`, no `EDOC` id |
| same, `/knowledge-base` suffix | **200, 6,539 B** - byte-identical shell |

It loads `/enterpriseproduct/ssgstatic/entry-DktVkHMd.js` (**22,214 B**), which imports
`product-aggregation-Otop6Eoe.js` (**2,511 B**), `api-data-transfer-G_NvvNrF.js` (**35,080 B**),
`knowledge-base-CZoFJnCZ.js` (**2,489 B**), `doc-CBtK1J04.js` (**4,024 B**). Access detail worth keeping:
the static chunks answer **403, 431 B** to a plain client UA and **200** once a browser UA, an
`Accept-Language` and a `Referer` on the same host are sent, so a bare probe reports the app as absent.

## 2. The endpoints it names, and what each answers anonymously

| endpoint (all under `/supportgateway/`) | call | result |
|--|--|--|
| `supproductservice/v1/enterprise/multi-language/init?pid=257173887` | GET | **200, 625 B** - `mid: SUPE_DOC`, `hedexPath: https://support.huawei.com/hedex/hdx.do`, `mulTitle: "Huawei OptiXtrans E6616X OptiXtrans E6600 Series Multilingual Manual & Guide"`, `isOpenJudgeSpider: false` |
| `supproductservice/v1/enterprise/multi-language/navi/tree?vocationIdAbsPath=<x>&lang=en` | GET | **200, 1,337 B, identical for every `x`** - 24 top-level site categories (Switches, Routers, WLAN, ... Enterprise Professional Services). `257173887`, `1` and `9999999999999` return the same bytes: the parameter is not used, so this is the site taxonomy, not a product's document tree |
| `supproductservice/v1/enterprise/auto-complete/doc-with-lang?keyword=<kw>&pageLang=en` | GET | **200, 109 B, `"data":[]`** for `TMB2DMS`, `OptiXtrans`, `E6600`, `E1616`, `TMB3AUX`, `TNG2DAP`. The last two are chapter names that *are* published anonymously on `e-file.huawei.com`, so an empty answer is a property of the instrument (no session), not evidence of non-publication |
| `supproductservice/v1/enterprise/aggregation/doc/second-item` | POST | **400, 118 B**, `"WSF check error"`, `code: support-productservice-010001` - this is the call the product page itself makes for a document category |
| `newsservice/v1/enterprise/security/csrf-token` | GET | **200, 65 B**, `"data": null` - no token is issued to an anonymous session, so the POST above can never be signed |

## 3. What that settles

The two generations of the support site gate the same content by different means: hedex answers **401
`NOT LOGIN!`** per document id (already on the record), and the SPA's gateway answers **400 `WSF check
error`** to the one call that would list a product's documents while declining to hand out a CSRF token.
There is no anonymous document index behind the modern product page, and the per-document nav tree that
used to be the last hope above `e-file` is now unreachable twice over. The only anonymous vendor route to
an E6600 chapter remains the `e-file.huawei.com` asset path recorded in
`research/optixtrans-e-file-numbered-bundle.md`.

## 4. A vendor product page that does print the AC split - in Greek

Chasing the same page turned up a **fourth vendor-hosted edition** of the E6600 spec table, and the first
one to print the AC service-slot split. `https://e.huawei.com/gr/products/optical-transmission/optiXtrans-e6600`
returns **200, 54,484 B** to a Googlebot UA (a desktop UA gets **403, 433 B** - the same WAF behaviour as
`e-file`), and its table reads, verbatim:

> | Number of Service Board Slots | DC chassis: 14<br>AC chassis: 12/10 | DC chassis: 6<br>AC chassis: 4 | DC chassis: 7<br>AC chassis: 5 |
> | Equipment Capacity | 2.8T/160G H/20G L | 800G/400G/60G H/10G L | N/A |

with `8.0 kg / 3.6 kg / 4.9 kg` above it and the marketing line *"Maximum OTN capacity of 2.8T per
subrack and access capacity of 200G per slot; 200G/λ, up to 80-wavelength DWDM, and 16T/fiber."*

Two things follow. First, `AC chassis: 12/10` - until now sourced only from the chassis chapter - is on a
vendor product page, so the `12 under 1500 W AC / 10 under 2400 W AC` reading in
`devices/huawei/optixtrans-e6616.json` rests on two vendor artifacts rather than one. Second, this is an
**older edition of the same page**, not a different claim: 80 wavelengths against the English table's 96,
200 Gbit/s against its 400, 8.0 kg against its 10.6 kg, and **no `E6616X` column at all** (0 occurrences
of `E6616X`, against 1 on the English page, which in turn has 0 of `12/10`).

## 5. Blocker, unchanged

Neither edition carries a board row, and no edition names a service board. #803 still needs **the
service-board part number valid in an E6616X subrack plus that board's front-panel census** - the
`TMB2DMS`/`TMB2PD1` pair the deployment inventory and the presales deck both name, whose port count and
slot cost no vendor-hosted artifact states. One authenticated read of `EDOC1100625826`,
`EDOC1100558549` or `EDOC1100625831`, or a stated build of the shape `E6616X DC (14x <board>)`, still
closes it.
