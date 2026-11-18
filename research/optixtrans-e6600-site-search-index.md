# Huawei's own site search indexes products, cases and videos - never documents

One increment on request #803 (Huawei OptiXtrans E6616X), 2026-11-18 20:2x UTC. Every earlier pass on
this family searched the **open web** for an `e-file.huawei.com` board chapter and then read what it
found. None had asked Huawei's **own** index, which is the obvious next move: if a client-board chapter
for the E6600 generation is published anonymously but only weakly indexed by Google/Bing, the vendor's
own search should still hold it. It does not - and the reason is structural, not a wording problem: the
on-site search has no documents tenant at all. What follows closes that idea at the instrument, so the
next pass does not spend a run on query strings.

## 1. The instrument, and where it is declared

`https://e.huawei.com/en/search?keyword=<kw>` and `https://e.huawei.com/cn/resource/material-center`
both carry the same inline script. It builds

```
directUrl = https://e.huawei.com/external/api/services/pep/services/api/dynamic/apiserver/searchdirectnew
if (isCn) directUrl = directUrl.replace('huawei.com','huawei.cn') + '/cn'; else directUrl += '/op';
```

and fires `POST` with `JSON.stringify({language, site, keyword})`. Measured 2026-11-18, Googlebot UA,
`Content-Type: application/json`.

## 2. What it returns: three tenants, none of them documents

| keyword | endpoint | HTTP | tenants returned | hits |
|--|--|--|--|--|
| `TMB2DMS` | `/searchdirectnew/op` | 200 | 官网搜索-产品与解决方案-直达 / 官网搜索-案例-直达 / 官网搜索-视频-直达 | 0 / 0 / 0 |
| `E6616X` | `/searchdirectnew/op` | 200 | same three | 0 / 0 / 0 |
| `TMB2PD1` | `/searchdirectnew/op` | 200 | same three | 0 / 0 / 0 |

The tenant names are the finding. The index covers **product pages, case studies and videos**; there is
no document tenant to query. So a zero here is not evidence that a chapter is unpublished - the E9600
board chapters that *are* published anonymously (`TNG2DAP`, `TNG2SRAPXF`, see
`research/optixtrans-board-chapters-public.md`) would return zero on this endpoint too. The route is
closed as an instrument, not as a search term.

## 3. The two paths the same script names are dead

| URL | result |
|--|--|
| `https://e.huawei.cn/external/api/services/pep/services/api/dynamic/apiserver/searchdirectnew/cn` | **404**, ALB page, `HOST: e.huawei.cn`, `CODE: 404000`, *"Couldn't find any router rule"* |
| `https://e.huawei.com/enterprisesearch?keyword=TMB2DMS` (the other URL in the page source) | **504**, 163 B |

So the CN branch the JS documents is not served, and the app host it points at times out.

## 4. Locale is not a gate bypass - re-measured, so it is not re-tried

The support wall was recorded on `/enterprise/en/doc/...`. This pass checked whether another host or
locale serves the same id without the hop:

| URL | result |
|--|--|
| `https://support.huawei.cn/enterprise/en/doc/EDOC1100558549` | **302**, 100 B |
| `https://support.huawei.com/enterprise/ru/doc/EDOC1100558549` | **302**, 100 B |
| `https://support.huawei.com/enterprise/zh/doc/EDOC1100558549` | **302**, 100 B |
| `https://info.support.huawei.cn/hedex/api/pages/EDOC1100558549` | **302**, 355 B |
| `https://support.huawei.cn/enterprise/en/optical-transmission/optixtrans-e6616x-pid-257173887` | **200**, 454,139 B |

The `.cn` mirror renders the product page and redirects every document id exactly like the `.com` host,
so `EDOC1100558549` (OptiXtrans E6600 V100R025C10 Hardware Description) stays unreadable on all three
paths tried.

## 5. The CN product page carries no board census either

`https://e.huawei.com/cn/products/optical-transmission/optixtrans-e6600` - **200**, 353,474 B (the EN
page is 339,756 B) - holds **zero** occurrences of a `TMB*`, `TMK*`, `TN*` or `TNG*` part code and two
occurrences of `槽位`; the specification table is client-rendered, so a crawler gets the prose and not
the table. There is no per-board text to mine on the localised product page.

## 6. Status

| issue | device | still missing | one thing that closes it |
|--|--|--|--|
| #803 | OptiXtrans E6616X | the service-board set valid in an X subrack with a front-panel census per board | a stated configuration (`E6616X DC chassis, slots 1-14: n x <board>`), the readable `EDOC1100558549` (or the E6600 V100R024C10 / V100R025C00 Hardware Description editions), or a Huawei-hosted `TMB2DMS` / `TMB2PD1` / `TMK1EX10` chapter |

No spec is written and nothing in this note is a port count, slot figure or wattage: the frame
arithmetic stays where `research/optixtrans-e6600-chassis-chapters.md` put it, vendor-sourced, and the
board census stays empty rather than guessed.
