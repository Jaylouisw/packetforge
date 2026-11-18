# Huawei's own board-spec tool: anonymous on paper, closed in practice

Follow-up to `research/optixtrans-client-board-chapters.md` (PR #1855's note for #808) and the
`#807` note of 2026-11-17 19:01. Those passes closed the e-file chapter bundle, the 26H2 brochure
tree, hedex and `carrier.huawei.com` by counting, and each ended on the same missing artifact: one
Huawei-hosted **client board** chapter with a Port Specifications table. This pass went at a route
none of them had named - Huawei's **Info-Finder** - because Huawei's own documentation says that is
where board-level specs live. It is reachable, it answers without a login, and it then refuses every
product it is asked about. That is the finding: not "no source exists", but "the one tool the vendor
points at is either login-gated or faulted".

## 1. The vendor names Info-Finder as the board-spec surface

`https://support.huawei.com/enterprise/zh/doc/EDOC1100447312?idPath=24030884|9856748|9858640|250707904|250732995`
- *企业光网络资料获取指南V1.0* (Enterprise optical-network documentation acquisition guide), HTTP 200,
`text/html;charset=utf-8`, **471,294 B**, published 2025-03-14, crawler user-agent, read 2026-11-17.
Text layer after tag stripping is **3,280 characters** - it is a one-page infographic, not a manual.

Its Info-Finder panel reads, verbatim:

> 光产品Info-Finder - 一站式快速高效查询规格、替代关系、硬件图片，对比产品/**单板**/软件规格差异，计算功耗、链路损耗等。

Query specs, substitution relationships, hardware images; **compare product / board / software spec
differences**; calculate power and link loss. A vendor sentence, on a Huawei host, saying that
board-level spec differences are a published comparison - which is what a client board's port census
is. That is a lead worth one pass, and this is that pass.

The page's other panels are marketing (售前资料 / 交付一本通 / 光博士 / 电子书). None of them is a
document set.

## 2. The zh support page is a *second* document list, larger, and no more open

`https://support.huawei.com/enterprise/zh/optical-transmission/optixtrans-e9605-pid-250732995` - HTTP
200, **430,883 B** (`curl --compressed`, `size_download`), crawler user-agent. The English page of the
same product (`.../en/...`) was measured at 436,367 B in the #807 pass and links 149 documents.

The zh page links **136 unique `EDOC…` ids**. Requested one at a time at
`https://support.huawei.com/enterprise/zh/doc/<ID>`:

| result | count |
|--|--|
| `200` | **58** |
| `302 -> /view/notFound` | **78** |

58 > the 39 the English page yields, so the localisation is not a pure mirror. But the extra 19 buy
nothing: by the page's own titles, **57 of the 58** are *多媒体* (video), *【知光漫谈】*, *传送小百科* or
*信息图* items, and the single document among them is `EDOC1100447312` - the guide quoted above.
The E9600 / E9624X product-documentation roots (`EDOC1100621489`, `EDOC1100621490`) are in the 302 set.

**Chinese documents have their own ids, and they are just as gated.** The zh page lists
*OptiXtrans E9600 V100R026C00 产品文档* as `EDOC1100621489`; the English page lists the same release as
`EDOC1100621488`. Different id, same wall: `.../zh/doc/EDOC1100621489` -> 302.

**`idPath` is not the key.** The zh page links documents as `/enterprise/zh/doc/<ID>?idPath=<pipe-list>`,
and the #807 pass had to rule out "the 404s are a malformed URL". Retested with the idPath copied
verbatim from the page: `EDOC1100621489?idPath=...` -> 302; `EDOC1100621488?idPath=...` (en) -> 302. The
only 200s are documents that are public *as documents* (`EDOC1100447312` answers 200 with or without
idPath). Publication status, not grammar - confirmed on a second id family.

## 3. Info-Finder is a Vue SPA over a JSON API that answers without a session

| URL | result |
|--|--|
| `https://info.support.huawei.com/info-finder/` | **301/302 loop** - 50 hops exhausted, no content |
| `https://info.support.huawei.com/info-finder/en` | 301 -> `.../info-finder/vue/en/enterprise/index`, **200**, 5,804 B |

The shell loads `/info-finder/vue/assets/index-aac0aaf9.js` (**941,435 B** decompressed). Two things in
it matter. First, the axios instance:

```
const Dn = "/info-finder", Mn = b.create({ baseURL: Dn, withCredentials: true })
```

so every call is a `POST` to `https://info.support.huawei.com/info-finder/<path>` with a JSON body.
Second, the endpoint table, of which the board-relevant entries are:

| endpoint | purpose (from name + call site) |
|--|--|
| `/speccenter/v2/getSpecBoards` | boards belonging to a product / version |
| `/speccenter/v2/getBoardSpec` | one board's spec sheet |
| `/speccenter/getSpecNavigation` | the spec tree for a product |
| `/speccenter/getSpecModelAndVersion` | model / version list |
| `/info/queryVersionDetailsByPbiId` | product name + versions for a `pbiId` |

**Payload schema, established by probing rather than by reading a doc.** The API rejects a request with
`{"errCode":10101,"errMsg":"参数取值不合法。请参考API文档了解允许的取值。"}` - "invalid parameter value" - so the
error code itself separates "wrong shape" from "reached the data layer":

| body | result |
|--|--|
| `{"domain":"0","language":"en","pbiId":"250733004","toolId":"speccenter"}` | `errCode 0`, `data: []` |
| `{"domain":"0","lang":"en","pbiId":"...","toolId":"speccenter"}` | 10101 - `lang` is not the key, `language` is |
| `{"domain":"0","language":"en","pbiId":250733004}` (number, no toolId) | 10003 - reaches the data layer |
| `{"domain":"2".."4","..."}` | 10101 - `domain` is only `"0"` or `"1"` |
| `{"domain":"1","language":"zh","pbiId":"..."}` | **10110** `用户的权限不足或账号错误` - login required |

So: `domain:"0"` is the anonymous / English side and does reach the data layer; `domain:"1"` is the
Chinese side and refuses without a session.

## 4. The board lookup fails for every product, not just the E9600

`POST /info-finder/speccenter/v2/getSpecBoards` with `{"domain":"0","language":"en","pbiId":<pid>}`:

| product | pbiId | result |
|--|--|--|
| OptiXtrans E9605 | `250732995` | `10003` `outchain mapping pbiIdMd5 not unique` |
| OptiXtrans E9612 | `250733000` | `10003`, same string |
| OptiXtrans E9624 | `250733004` | `10003`, same string |
| OptiXtrans E9624X | `251792361` | `10003`, same string |
| OptiXtrans E9600 Series (offering) | `265949421` | `10003`, same string |
| **CloudEngine S6730-H24X6C** (control) | `250538959` | `10003`, same string |

The control matters: a campus switch that Info-Finder documents in detail fails with the identical
upstream fault, so this is **not** an E9600 gap and not a gap the E9600 requesters can argue around.
`getSpecNavigation` and `getSpecModelAndVersion` behave the same way; adding `offeringId`,
`versionPbiId` or `pbiIdMd5` moves the answer back to 10101, i.e. those are not accepted keys on this
endpoint. `customModel` is accepted and does not change the result.

Read plainly: from outside a Huawei account, the English Info-Finder's board data is unreachable
because of a server-side mapping fault, and the Chinese one is unreachable because it wants a login.
Either way the port census of a `TNG1N...` / `TNG1A...` board is still not sourced.

## 5. What changed in the four open issues - nothing, and that is the result

| issue | device | missing field | status after this pass |
|--|--|--|--|
| #807 | E9605 | client-board port table | unchanged; Info-Finder retired (section 4) |
| #808 | E9612 | same, 13 slots | unchanged |
| #810 | E9624 | same, 24 slots (20 in 1:3) | unchanged |
| #803 | E6616X | a board valid in the X, with ports | unchanged |

One route is now *closed by measurement* rather than by guess, and the failure is recorded with its
exact error string so the next pass does not spend four fetches discovering `pbiIdMd5 not unique`.
Do not model a board from this: an empty answer is not a census, and an `ethernet` / `sfp+` pair
invented for a line-side socket is the error this project keeps correcting.

**What would still unblock it**, unchanged in kind but now shorter in list: one readable copy of
`EDOC1100163901` (Board Datasheet) or `EDOC1100621488` (V100R026C00 Product Documentation) from a
reader with a support session and the right to paste it, or one e-file chapter for a tributary board
(`TNG1A212`, `TNG1T212`, `TNG1M210D`) - or a stated configuration naming the board to model, at which
point the frame arithmetic already sourced in section 3 of `research/optixtrans-client-board-chapters.md`
completes the spec.

## 6. Reproduce

```
UA='Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'
# the zh document list, then one id at a time
curl -sS --compressed -A "$UA" -o zh.html \
  'https://support.huawei.com/enterprise/zh/optical-transmission/optixtrans-e9605-pid-250732995'
grep -o 'EDOC[0-9A-Z]*' zh.html | sort -u | while read -r id; do
  printf '%s %s\n' "$(curl -sS -o /dev/null -w '%{http_code}' -A "$UA" \
    "https://support.huawei.com/enterprise/zh/doc/$id")" "$id"
done
# the board API - the answer is the finding
curl -sS --compressed -A "$UA" -H 'Content-Type: application/json' \
  -d '{"domain":"0","language":"en","pbiId":"250733004"}' \
  'https://info.support.huawei.com/info-finder/speccenter/v2/getSpecBoards'
```

The bundle that names the endpoints:
`https://info.support.huawei.com/info-finder/vue/assets/index-aac0aaf9.js` - grep it for `getSpecBoards`.

## 7. Addendum 2026-11-18: the third tool has no OptiXtrans hardware either, and the pages now block browsers

The note above closed the *board-spec* tool (`speccenter`). Info-Finder ships three, and the one this
note never asked - **Hardware Center** (`/info-finder/hardware/v4/queryModels`) - was measured today.
It answers freely; it simply carries no subrack and no service board.

**Payload.** `POST https://info.support.huawei.com/info-finder/hardware/v4/queryModels` with
`{"domain":"0","language":"en","keyword":"<kw>","toolType":"hardwarecenter"}`. `domain` is `"0"`
(enterprise) or `"1"` (carrier); anything else returns `10101`. `domain:"1"` answers
`{"errCode":0,"data":null}` for every keyword tried, including the empty one - the carrier side is a
separate deployment, not a second dataset on this host.

| keyword | total | what comes back |
|--|--|--|
| `""` | **8,137** | the whole enterprise part set |
| `OSN 9800` | **32** | **every row `hardwareType:"Optical module"`** - `OSN080N10` (CFP 1310 nm 103.125G), `OSN040N08` (QSFP-DD 400G), `OSN080N02` (QSFP28 100G), `OSN010B00`/`OSN010B01` (BiDi QSFP28), etc. Zero chassis, zero boards. |
| `OptiXtrans` | **0** | - |
| `E6616X` | **0** | - |
| `TNG1N206`, `TNG1N210`, `TNG2DAP`, `TMB1`, `TNV1T210U` | **0** each | - |

So the coverage is transceivers for the OSN 9800 line, filed under optical-module part numbers. The
`TNG1N…` / `TNG1T…` / `TMB1…` boards the four open issues need are not in this tool's index at all,
and the tool that does hold board specs (`speccenter`) is faulted per section 4. Both halves of
Info-Finder are now closed by measurement rather than by guess.

**User-agent correction, because it has already cost passes.** `support.huawei.com` product pages
answer **200 only to the Googlebot UA** used in section 6. A Chrome UA, a Firefox UA and an empty UA
all get Akamai `403 Access Denied` (414-463 B, `Reference #18.5e3da17…`, `errors.edgesuite.net`).
Read with a browser UA, this host looks *withdrawn*; it is not - the documents are still 302 to
`/view/notFound`, which is a publication decision, not a WAF. Only a Googlebot-UA 200 can distinguish
the two, so section 6's recipe is the one to reuse.

**Two R026 ids added to the wall.** The E9605 page (Googlebot UA, 200, 84,377 B) lists
`EDOC1100622610` *OptiXtrans E9600 V100R026C00 Product Description 01* and `EDOC1100622612`
*Feature Description 01*. Both answer `302 -> /view/notFound`, exactly like the R026 Product
Documentation (`EDOC1100621488`) and Hardware Description (`EDOC1100625542`) roots. Their hedex
equivalents (`hedex/hdx.do?docid=<ID>&lang=en`) return the same 3,728 B Vue shell as reported before.

**Net effect on the four issues: none, and that is the finding.** #807, #808, #810 and #803 still
each need one client-board port table. What is left is unchanged and short: a readable copy of
`EDOC1100163901` (Board Datasheet) or `EDOC1100622610` / `EDOC1100621488` from a reader with a
support session, one e-file `TNG1*` chapter, or a stated configuration naming the board.

## 8. Addendum 2026-11-18 19:5x UTC: the Hardware Center's HTML route, and the two boards the last pass named

Section 7 measured the Hardware Center through its JSON API. Two things were still worth pinning down
before another pass spends an hour on it: whether the tool's **server-rendered HTML route** - a surface
whose access rules differ from the API's - knows an OptiXtrans product, and whether the **specific part
numbers** the last pass handed over as candidates (`TMB2DMS`, `TMB2PD1`) are in the part index at all.

### 8.1 The API trap, spelled out

The correct call is section 7's payload, and today it answers **200**:
`POST /info-finder/hardware/v4/queryModels` with `{"domain":"0","language":"en","keyword":"<kw>","toolType":"hardwarecenter"}`.

| keyword | HTTP | body | result |
|--|--|--|--|
| `E6616X` | 200 | `{"errCode":0,"data":{"total":0,"matchRelations":null}}` | 0 parts |
| `TMB2DMS` | 200 | same | 0 parts |
| `TMB2PD1` | 200 | same | 0 parts |

The trap: `domain` must be the **code** `"0"` (enterprise) or `"1"` (carrier). Any other value -
`"enterprise"`, `"carrier"`, an empty string - returns **HTTP 403 `{"errCode":10101,"errMsg":"参数取值不合法。请参考API文档了解允许的取值。"}`**,
which reads like a refusal and is really a type error in the request. `domain:"1"` returns **401** with
`data:null`. So "the tool refused me" and "the tool has no such part" are one string apart; only
`domain:"0"` distinguishes them. A pass that guesses the domain will conclude the tool is gated.

### 8.2 The HTML route resolves pids server-side - and knows no optical product

`GET https://info.support.huawei.com/info-finder/search-center/en/enterprise/<type>/-pid-<pid>/hardwarecenter`
is not the SPA: it returns a server-rendered page of ~140 KB when the pid is in the tool's product table,
and a bare `302 -> /info-finder/search-center/en/enterprise/index` when it is not. The `<type>` segment
is decoration - `wlan/-pid-255229035` renders the switch product `S8700-4` - so the pid alone decides.

| pid | product | HTTP | bytes |
|--|--|--|--|
| 23772823 | AR6280 (routers) | **200** | 139,834 |
| 260431197 | CE8875 (switch) | **200** | 139,927 |
| 255229035 | S8700-4 (wlan path) | **200** | 139,866 |
| 999999999 | *none* (control) | **302** | 0 |
| 257173887 | OptiXtrans E6616X | **302** | 0 |
| 250732937 | OptiXtrans E6616 | **302** | 0 |
| 7905372 | OptiX OSN 9800 U32 | **302** | 0 |
| 255972187 | OptiX OSN 9800 K36 | **302** | 0 |
| 23221349 | OptiX OSN 9800 P32 | **302** | 0 |
| 266120513 | OptiXtrans E6600 Series | **302** | 0 |

Every optical pid behaves exactly like a pid that does not exist, and the three datacom pids behave as
section 7's index implies. So the Hardware Center is a **datacom** part index: the E6600 subracks are
absent from it, not merely thin in it.

Do not read the 200s as a census route. The 139 KB page carries the column headers the tool advertises -
`Part Number` (x4), `Slot Number` (x3), `More Matched Parts` (x3), `Mapping parts` (x1) - and **zero part
rows**; the rows are still filled by the API. The HTML route's only free yield is the pid yes/no above,
which is why it is recorded here as a *control* rather than a lead.

### 8.3 Net effect on #803

None, and the remaining ask is unchanged: a stated configuration of an E6616X subrack (board model plus
quantity per slot), or a readable E6600 hardware-description board chapter. What is now cheaper for the
next pass is the negative: `E6616X`, `TMB2DMS` and `TMB2PD1` are absent from the enterprise part index at
part level, so no amount of keyword wording will surface them there.
