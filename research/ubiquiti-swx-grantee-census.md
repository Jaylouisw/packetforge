# The SWX grant list, enumerated end to end - no Pro Dream Wall was ever filed

Read 2026-11-18, 23:2x-23:4x UTC, crawler user-agent, `fccid.io` (a mirror of the Commission's
equipment-authorization database, not the Commission). This pass answers one question the UDW-PRO
thread had only ever sampled: **does Ubiquiti hold an equipment authorization for a Dream Wall Pro
under *any* spelling?** The three prior passes asked it by guessing FCC IDs
(`SWX-UDWPRO`, `SWX-UDW-PRO`, `SWX-UDW2` - all 303). A guessed ID is a sample of one; the grantee
code is a finite list, so this pass read the list.

## 1. What this settles, and the one thing it does not

It settles: **Ubiquiti has filed no equipment authorization for a Dream Wall Pro.** Across all 432
grants under grantee code `SWX`, dated 2005-02-18 to 2026-10-29, the only Dream Wall grant is
`SWX-UDW`, 2022-05-31. No `UDW`-derived product code carries a Pro suffix, and the UDW grant itself
holds no permissive-change application that could hide one.

It does *not* settle: whether a Pro could exist without a new FCC ID. An intentional radiator needs
its own grant, but a variant with the same radios, module and power levels and a different port
complement may be covered by a **Class II permissive change** against the parent grant. So the
honest statement is narrower than "the product cannot exist": Ubiquiti never told the Commission
about a Pro, and `SWX-UDW` carries no C2PC entry that would be that filing. The port census still
has to come from a vendor page in any case - a grant lists frequencies, not RJ45 counts.

## 2. The enumeration

`https://fccid.io/SWX` is server-rendered and paginated: *"FCC ID applications by SWX (Ubiquiti Inc.)
- Page 1 of 5"*, with `<a href="/SWX/page/2">`. Pages 1-5 fetched, HTTP 200 each:

| page | bytes |
|---|---|
| `/SWX` | 30,975 |
| `/SWX/page/2` | 30,185 |
| `/SWX/page/3` | 29,647 |
| `/SWX/page/4` | 29,861 |
| `/SWX/page/5` | 17,622 |

Rows were extracted from `table.grantee-applications-table` (`<td>` text per `<tr>`) and de-duplicated:
**432 unique grants**, oldest `SWX-AP1R2 2005-02-18`, newest `SWX-USLAK 2026-10-29`.

**Liveness control.** The newest row is five weeks old, so the listing is a current index and not a
snapshot that stopped being maintained; the date range (twenty-one years, back to the 2005 AirPoint)
says the same thing from the other end - it is not a "recent applications" view that would drop an
older Pro.

## 3. What the 432 rows contain, around the Dream Wall

Everything in the list whose product purpose mentions Dream, Console or Gateway:

```
SWX-UDW      2022-05-31  Digital Transmission Radio
SWX-UDR      2021-11-24  UniFi Dream Router
SWX-UDB      2019-09-25  UniFi Dream Machine Beacon
SWX-UDMBT    2026-04-23  Dream Machine Beast
SWX-UDMPRO   2019-07-23  UniFi Dream Machine PRO
SWX-UDMPM    2024-04-23  UniFi Dream Machine Pro Max
SWX-UDMPROSE 2021-07-05  UniFi Network Dream Machine Pro SE
SWX-UISPCON  2021-10-07  UISP Console
SWX-UXGPRO   2020-06-04  UniFi Network Gateway Pro
SWX-EFGC     2026-04-28  Enterprise Fortress Gateway Core
SWX-UCGF     2025-01-31  UniFi Cloud Gateway Fiber
SWX-UCGM     2024-07-16  Cloud Gateway Max
SWX-UCGU     2024-02-07  UniFi Cloud Gateway Ultra
SWX-UXG      2023-11-10  UniFi Next-Generation Gateway
SWX-UXGF     2025-01-31  UniFi Gateway Fiber
SWX-UXGM     2024-04-01  UniFi Gateway Max
```

The control in that block: **Ubiquiti does give Pro variants their own grant.** `UDMPRO`, `UDMPM`,
`UDMPROSE` and `UXGPRO` are four Pro-suffixed consoles in the same list, three of them Dream Machine
Pro-family. A Pro Dream Wall would sit in this block as `SWX-UDWPRO`-something; the block is
exhaustive, so the absence is a fact about the filing history rather than a miss.

## 4. `SWX-UDW` itself - no variant hides inside the parent grant

`https://fccid.io/SWX-UDW` - 200, 83,318 B. Product code `UDW`, equipment class *Digital Transmission
Radio*, four application IDs, **every one `Original Equipment`** (2022-05-23 x2, 2022-05-31 x2), none
a permissive change; `Model | UDW`; the string `pro` appears nowhere in the page. Exhibits are all
the UDW's own (`User Manual QIG` 4 MB, `Internal Photos`, `External Photos`, test reports 15.247 and
15.407). This is the document set the thread already used for the non-Pro; the point here is only
that it holds no second model.

## 5. The store tree, both prefixes, every `udw` slug ever captured

The earlier scratch ran a CDX query against `techspecs.ui.com/unifi/cloud-gateways/*` (104 URLs, 18
slugs, no `udw-pro`). The **store** tree was never enumerated, and that is the tree that would carry
a launch page. Prefix queries, `collapse=urlkey`:

| query | result |
|---|---|
| `store.ui.com/us/en/pro/products/` (prefix, unfiltered) | 234 archived URLs; `udw` 2023-11-27 200, `uacc-psu-udw` 2023-12-27 200 |
| `store.ui.com/us/en/products/` (prefix, `original:.*udw.*`) | 5 rows: `uacc-psu-udw` 2025-02-18 200; `udw` 2023-06-05 307; `udw?variant=udw-us` 2026-04-28 200; `udw%22` 2024-02-12 404 and `udw%22,` 2024-01-19 404 (mangled crawler URLs) |
| `ui.com/unifi/cloud-gateways/` (prefix) | 2 rows, 124 B - empty |

No `udw-pro`, `udwpro` or `udw_pro` in either tree, in any year.

**Crawl-liveness control:** `store.ui.com/us/en/products/udw?variant=udw-us` was captured **2026-04-28**
- six months ago, with the query string a real variant URL uses. The archive is still taking captures
of this exact product family, so an empty result for the Pro is a gap in the product line, not a gap
in the crawl.

## 6. An instrument found on the way

The archived product pages are **not** client-rendered in the way the store's search page is (that
one was recorded on the thread as answering 200 with zero results, because the results are fetched
later). A product page prints its whole record as embedded JSON. From
`https://web.archive.org/web/20250218070534/https://store.ui.com/us/en/products/uacc-psu-udw`
(200, 354,417 B):

```json
{"name":"UACC-PSU-UDW","description":"Provides optional power redundancy for Dream Wall.",
 "status":"Available","manufacturer":"Ubiquiti","slug":"uacc-psu-udw",
 "datasheet":{"html":...},"technicalSpecification":null,"collectionSlug":"accessories-pro-poe-and-power"}
```

So for any Ubiquiti store product that has *ever* been archived, `datasheet` and
`technicalSpecification` are readable out of the HTML without a browser - a cheaper route than
`dl.ui.com` for the products that do have pages. For #130 the record is the accessory's, 550 W
(54.8 V) AC-to-DC aux power module for "Dream Wall", and `udw-pro` occurs zero times in it.

## 7. Wayback's state during this sweep, so nothing is read off a timeout

A domain-wide filtered query (`url=ui.com&matchType=domain&filter=original:.*udw.*`) returned **504**
twice - too broad for the service. Narrow prefix queries answered normally and are the ones quoted
above. Near the end of the pass the service began returning its *"Internet Archive: Temporarily
Offline"* page, so the sweep stopped there. **No negative in this note rests on a timeout or on an
offline page**; the two empty results in §5 are 200 responses with row counts.

## 8. What would still answer #130

Unchanged, and now with one surface removed from the list: a Ubiquiti-hosted page, datasheet,
quick-start guide or FCC exhibit that states the Pro's RJ45/SFP+ census and PoE budget, or the
requester confirming the **UDW** (`devices/ubiquiti/udw.json`, 420 W) or the **UDM-Pro** is what was
meant. The grant route cannot answer it even in principle - it publishes frequencies, not ports - and
has now been enumerated rather than sampled.

## Sources

- https://fccid.io/SWX
- https://fccid.io/SWX/page/2
- https://fccid.io/SWX/page/3
- https://fccid.io/SWX/page/4
- https://fccid.io/SWX/page/5
- https://fccid.io/SWX-UDW
- http://web.archive.org/cdx/search/cdx?url=store.ui.com/us/en/pro/products/&matchType=prefix
- http://web.archive.org/cdx/search/cdx?url=store.ui.com/us/en/products/&matchType=prefix&filter=original:.*udw.*
- https://web.archive.org/web/20250218070534/https://store.ui.com/us/en/products/uacc-psu-udw
