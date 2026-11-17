# Both enumeration routes on Huawei's storage hosts are account-gated, and both are now measured

Follow-up to `research/oceanprotect-x-series-port-census.md`. That note left #742 (OceanProtect E8000)
blocked on one field - the front-end port census per controller - and ranked `Spare Parts Query` as the
*next* route, ahead of re-trying the document books, because the readable generation's Interface Module
chapter defers the answer to it by name. This pass measured that route and the document-tree route
instead of guessing at either, and re-fetched the one E8000 document that is published anonymously.

Neither route is fetchable. The E8000 census is unchanged, so #742 stays open. What is new is that the
two "next routes" recorded in the earlier note are now dead ends with a measurement behind them, which
is the difference between a lead and a loop.

## 1. The document tree is behind a Huawei account, at the service, not at the edge

The section URLs that do render (`.../EDOC1100319420/a9dbbf6/interface-module`) all carry a
revision-scoped topic hash, and the earlier note established that a hash cannot be derived: it does not
carry across books and a slug without a hash answers 404. The tree that holds the hashes is served by

`GET https://support.huawei.com/supportgateway/view/v1/enterprise/doc/catalogue?nid=EDOC1100486186`

and it answers **HTTP 401** with

```
{"status":401,"code":"support-view-020003","message":"need login."}
x-login-url: https://uniportal.huawei.com/uniportal1/
x-login-appid: x_app_id=huawei.support.microservice
```

Send a browser user-agent and the same host answers Akamai's **403** `Access Denied`; send a crawler
user-agent and it answers the 401 JSON above. So `403` is the edge refusing the client and `401` is the
document service refusing the request - the endpoint is reachable, and it wants a session. The response
is gzip-encoded whatever `Accept-Encoding` says, so it reads as an empty 91-byte body unless
`curl --compressed` is used, which is how an earlier pass could have recorded "no answer" here.

Consequence for #742 and #743: there is no anonymous enumeration entry point for a book's sections. The
only public way in is a hash that a search engine already indexed, which is why the X3000 V200R001
Product Description (`EDOC1100368234/8587c2ff/overview`) renders and the E8000 book does not.

## 2. Spare Parts Query: the CSRF handshake is public, the data service is not

`https://info.support.huawei.com/storage/spareparts/` is public - 200, 78,090 B shell, bundle
`main-ZCQDDWQH.js`, 2,605,430 B. The bundle names the data call exactly:

```
GET {API_HOST}/storage-gw/rest/itcms/getDataList
    ?appId=spare&dataSetId=SpareParts_Product_Output&nodeId=SpareParts_Product_Output
    &lang=en&child=true
API_HOST = "/storageinfogw"     API_HOST_V2 = "/storageinfo-gw-v2"
```

with the token from `/storageinfogw/csrf-gw/rest/csrf/getCsrfToken`. Measured, in one cookie session that
first loaded the app shell:

| request | result |
|---|---|
| `GET /storageinfogw/csrf-gw/rest/csrf/getCsrfToken` | **200**, `{"data":["<64-char token>"],"code":0}` |
| `GET .../getDataList?appId=spare&...` + `Csrf-Token` | **401, 0 bytes** |
| same, `X-Csrf-Token` and `csrf-token` variants | **401, 0 bytes** |
| same, without the session cookie, without `Referer`, with `lang: en` | **401, 0 bytes** |
| `GET /storageinfo-gw-v2/csrf-gw/rest/csrf/getCsrfToken` | **401**, no token issued |

So the v2 query path the app prefers (`POST /storageinfo-gw-v2/rest/v2/condition/query` with
`{"appId":"spare","conditionNodeId":"","distance":"2"}`, then
`/rest/v2/spare/query/list/nodeId/<productid>`) never gets as far as a token, and the v1 path issues a
token to anyone and then refuses the data. A token that is issued and then not honoured is the signature
of a service checking a session of its own, which a fetch-only client does not have.

The same gateway constants appear in `https://info.support.huawei.com/storage/spec/`
(`main-H3SH7DII.js`, 2,775,994 B), so Specifications Query - the other route #743 recorded - sits behind
the same gate. One measurement covers both tools.

## 3. The E8000 datasheet, re-fetched: same four slides, still no census

`https://e-file.huawei.com/marketingcloud/pep/asset/20000001/Material/597eb7d1363f4b5da0d4ad663da1f7b6/M3T1A590N1325408746781700176/Huawei%20OceanProtect%20E8000%20Backup%20and%20Archiving%20Converged%20Storage%20V200R001C20%20-%20Data%20Sheet.pptx`

HTTP 200, `application/vnd.openxmlformats-officedocument.presentationml.presentation`, **2,407,538 B**,
**4 slides**, resolved from the material page
`https://e.huawei.com/en/documents/products/storage/597eb7d1363f4b5da0d4ad663da1f7b6` with
`scripts/huawei-material-fetch.js`. Slide 3's spec rows, on the text layer: 2 controllers per node, up to
128 nodes, 2 PiB per node and 256 PiB per system, data disks 7.68-61.44 TB NVMe SSD plus 8-24 TB NL-SAS,
front-end port *types* `16/32/64 Gbit/s Fibre Channel; 10/25/40/100GE`, dimensions 86.1 x 447 x 920 mm
(NVMe controller enclosure) and 86.1 x 447 x 820 mm (controller enclosure).

Keyword counts over the whole deck: `slot` **0**, `interface module` **0**, `IOM` **0**, `onboard` **0**,
`port` **1**. It is the same document the earlier note transcribed, and it still contains no socket.

One coincidence worth refusing in writing: the 820 mm controller-enclosure depth is the depth the 1.3.0
X6000/X8000 Installation Guide gives for its 2 U 25-disk controller enclosure, and the E8000 is also 2 U
with 2 controllers. Equal depth is not a shared backplane and not a shared IOM population - the
X6000/X8000 books never put the E8000 in a slot or port table, and the one document that names all three
together (`EDOC1100305200`, Parts Replacement) only says the 2 U fan module and the smart disk enclosure
are shared field-replaceable units. Six IOM slots imported on that basis would be the same family-sibling
error as Dorado's Table 6-1.

## 4. What is still missing from #742, and what would now unblock it

Missing, unchanged: **the interface-module slots per controller on the E8000 node, and the port count of
each front-end module type (10/25/40/100GE, 16/32/64 Gbit/s FC) as fitted to it** - equivalently, one base
configuration line such as "E8000 node, 2 controllers, 2 x 4-port 25GE IOM per controller".

Unblock, in the order this pass would try them:

1. **one rendered section** of the E8000 V200R001 set - Product Description `EDOC1100486186`, Quick
   Installation Guide `EDOC1100485347`, or Installation Guide `EDOC1100486185` - pasted by a reader with a
   support session. Section rendering itself is not the obstacle: the X8000 1.3.0 *10GE Electrical
   Interface Module* section (`EDOC1100319420/7a0c3635`) renders in full, port table and all, to a client
   that can run the page. The Quick Installation Guide is the best single bet because Huawei's own product
   page now lists `OceanProtect E8000 Backup Storage V200R001 Quick Installation Guide`, dated 2026-09-30.
2. a stated configuration of the shape above, which converts in one step once a vendor port table
   corroborates the module - the module names print their own counts only in partner mirrors.
3. a support account, which turns section 1 and section 2 from walls into two fetches.

No spec is written from this: a 2 U frame with an unpublished IOM population is an empty array, and an
empty array is a question, not a census.

## 5. Sources read today

- <https://support.huawei.com/supportgateway/view/v1/enterprise/doc/catalogue?nid=EDOC1100486186> -
  401 `support-view-020003` "need login." (crawler UA), 403 Akamai (browser UA)
- <https://info.support.huawei.com/storage/spareparts/> - 200 shell; `main-ZCQDDWQH.js`, 2,605,430 B
- <https://info.support.huawei.com/storageinfogw/csrf-gw/rest/csrf/getCsrfToken> - 200, token issued
- <https://info.support.huawei.com/storageinfogw/storage-gw/rest/itcms/getDataList?appId=spare&dataSetId=SpareParts_Product_Output&nodeId=SpareParts_Product_Output&lang=en&child=true>
  - 401, 0 bytes, every token and header variant
- <https://info.support.huawei.com/storageinfo-gw-v2/csrf-gw/rest/csrf/getCsrfToken> - 401
- <https://info.support.huawei.com/storage/spec/> - 200 shell; `main-H3SH7DII.js`, 2,775,994 B
- <https://e.huawei.com/en/documents/products/storage/597eb7d1363f4b5da0d4ad663da1f7b6> - 200, E8000
  V200R001C20 data sheet, 2,407,538 B, 4 slides
- <https://support.huawei.com/enterprise/en/flash-storage/oceanprotect-e8000-pid-261860234/software/> -
  200, lists the E8000 Product Description, Quick Installation Guide and Installation Guide
- <https://support.huawei.com/enterprise/en/doc/EDOC1100319420/7a0c3635/10ge-electrical-interface-module>
  - rendered in full (X8000 control: the section route works when a hash is known)
