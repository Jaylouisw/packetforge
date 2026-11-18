# The `.cn` host is the same CDN, not a second index — and it cannot run the login-state test

Measured 2026-11-18 15:25-15:40 UTC, one increment on request #803 (Huawei OptiXtrans E6616X).
`research/optixtrans-e6616x-docs-gated-not-unpublished.md` ended with a reusable claim: the
`/hedex/api/navi/<ID>/first-level-tree` three-state test (200 public / 401 `NOT LOGIN!` / 404 absent)
is the instrument the next census should use. This pass asked the prior question — *is there a second
Huawei host that serves the same documents without the gate?* — because a search-index snippet advertises
`support.huawei.cn` as a mirror, and a mirror is exactly where an anonymous route would hide. It is not.
`.cn` is the same origin behind a different name, and the instrument does not run there at all.

## 1. The two hosts return the same bytes

| URL | status | bytes | `EDOC` ids | doc links |
|--|--|--|--|--|
| `https://support.huawei.com/enterprise/en/optical-transmission/optixtrans-e6616x-pid-257173887` | 200 | **454,559** | 260 | 253 |
| `https://support.huawei.cn/enterprise/en/optical-transmission/optixtrans-e6616x-pid-257173887` | 200 | **454,559** | 260 | 253 |

Identical length, identical order, and the 253 `(title, EDOC)` pairs extracted from each are the same set:
**zero ids present on one host and absent from the other**. The same holds one product over - the
`transmission-network` E6616 page (pid 250732937) answers 200 / 461,478 B / 298 ids from `.cn`, matching
the 298 the `.com` census counted on 2026-11-18. So `support.huawei.cn` is an alias for the enterprise
support CDN, not a regional catalogue with its own holdings.

## 2. The gate is identical per document

Same six documents, both hosts, Googlebot UA (a browser UA gets Akamai `403`, per
`research/optixtrans-infofinder-api.md` §7):

| EDOC | document | `.com` | `.cn` |
|--|--|--|--|
| `EDOC1100605035` | joint *OptiX OSN 1800 & OptiXtrans E6600 & DC908 User Guide* | 200 | 200, 551,070 B |
| `EDOC1100558547` | *E6600 V100R025C10 **Hardware Description** 01* (English) | 302 -> `/view/notFound` | 302 -> `/view/notFound` |
| `EDOC1100558549` | *E6600 V100R025C10 硬件描述 01* (Chinese) | 302 | 302 |
| `EDOC1100163902` | *OptiXtrans E6600 Brochure and Datasheet* | 302 | 302 |
| `EDOC1100621358` | *E6600 Heat Dissipation and Routine Maintenance* | 302 | 302 |
| `EDOC1100171248` | *E6600 Commissioning and Configuration (NCE) 11* | 302 | 302 |

Every row above was requested on both hosts in the same pass, 2026-11-18 15:2x-15:4x UTC. The 200/302
split is the one the census already measured, reproduced on the mirror, and it reproduces per document
rather than per host. No document became readable by changing the hostname.

## 3. The navi instrument is `.com`-only

`https://support.huawei.cn/hedex/api/navi/EDOC1100558547` answers **400** with a 282-byte body reading
`error!` - not the 401 `{"status":401,"message":"NOT LOGIN!"}` that distinguishes *gated* from *absent* on
`.com`. The `.cn` host has no hedex service to query, so no login-state verdict can be produced from it and
its 302s carry no information about publication status. Anyone repeating the census must use
`support.huawei.com` for the navi calls and treat a `.cn` 302 as a plain redirect.

## 4. Two byproducts, both useful

1. **The English Hardware Description edition list, complete.** The E6616X page links six English HD
   editions and they stop at R025C10: `EDOC1100558547` (R025C10), `EDOC1100525982` (R025C00),
   `EDOC1100456166` (R024C10), `EDOC1100367199` (R023C10), `EDOC1100328736` (R023C00),
   `EDOC1100303425` (R022C10). The same page *does* carry R026C00 in two other document classes -
   `Feature Description` `EDOC1100625831` and the R026C00 patch/release notes - so the absence of an
   R026C00 **English** HD is a gap in the English partition, not in R026C00. The only R026C00 package
   named anywhere in this thread is the Chinese bundle `EDOC1100625827`. An account holder who wants the
   edition the 26H2 brochure findings come from should open the **Chinese** tree, not the English one.
2. **A stale-snippet trap.** A search-engine snippet renders the E6616X pid page as
   *"Sorry, no document is found for this product."* The live page is 454,559 B with 260 ids. That text is
   a cached render of an earlier (or locale-varied) view; reading it as "Huawei publishes nothing for the
   E6616X" is the same error the 2026-11-18 census corrected in the other direction. The page proves the
   opposite: the X inherits the whole E6600 document set.

## 5. What this changes for #803

Nothing about the field, and it closes one more avenue rather than opening one:

- **Closed:** a second Huawei host with an ungated copy of the E6600 Hardware Description, or a `.cn`
  regional catalogue that lists documents `.com` does not (they are the same 253-entry table, byte for
  byte);
- **Unchanged:** the board census needs an authenticated read of `EDOC1100558549` (Chinese, R025C10) or the
  R026C00 bundle `EDOC1100625827` - both 302 to an anonymous crawler on both hosts;
- **No spec written:** no port count, slot cost or board part number was read this pass.
