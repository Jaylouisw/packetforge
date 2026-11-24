# The Dream Wall Pro has no vendor page - and Ubiquiti's not-found is a redirect, not a soft 200

Request #130 asks for a **Ubiquiti UniFi Dream Wall Pro (UDW-PRO)** as a routed gateway. Its own
body says the port list is "inferred from the 4gon product name" and sends the reader to that
reseller listing, so the census was never sourced in the first place. This note records what
Ubiquiti publishes about the Pro (first written 2026-11-17, re-measured 2026-11-18) and, more
usefully, the one way this site answers for a slug it does not have - a redirect to the techspecs
root, corrected here from the "soft 200" reading an earlier pass had recorded.

## What Ubiquiti does publish: the non-Pro Dream Wall

- `https://techspecs.ui.com/unifi/cloud-gateways/udw` - HTTP 200, the page for the **UDW** only.
- `https://dl.ui.com/ds/udw_ds.pdf` - HTTP 200, `application/pdf`, 544,909 bytes, the UDW datasheet.

Its rear panel, read off that datasheet's text layer:

| field | value |
|---|---|
| 1 GbE RJ45 | **(17) LAN**, of which 4 PoE (15.4 W), 4 PoE+ (30 W), 4 PoE++ (60 W) |
| 2.5 GbE RJ45 | (1) WAN |
| 10G SFP+ | (1) LAN + (1) WAN |
| Management | Ethernet, Bluetooth, WiFi |
| Power | (2) hot-swappable 550 W PSU bays, 1 pre-installed; 532 W max |

That is the **UDW**, which is already modelled at `devices/ubiquiti/udw.json`. It says nothing about
the Pro, and the request is only for the Pro.

## What Ubiquiti does not publish about the Pro

| probe | status | final URL | bytes |
|---|---|---|---|
| `techspecs.ui.com/unifi/cloud-gateways/udw-pro` | **307** -> `Location: /` | `https://techspecs.ui.com/` after following | 1 -> 609,911 |
| `techspecs.ui.com/unifi/cloud-gateways/udw` | 200 | unchanged | 704,702 |
| `store.ui.com/us/en/products/udw-pro` | **404** | unchanged | 204,279 |
| `store.ui.com/us/en/products/udw` | 200 | unchanged | 568,104 |
| `dl.ui.com/ds/udw-pro_ds.pdf` | **302** -> `Location: https://techspecs.ui.com` | same, after following | 308 -> 609,911 |
| `dl.ui.com/ds/udw_ds.pdf` | 200 | unchanged | 544,909 |

The store page for the UDW mentions only `udw-us`, `udw-module` and `udw-raceway`; there is no
`udw-pro` slug anywhere in it. The reseller listing the request cites
(`4gon.co.uk/ubiquiti-unifi-dream-wall-pro-udwpro-p-10111.html`) now answers **403** to this host,
and would not be admissible evidence for a port count even if it did not.

## The trap, corrected 2026-11-18: these hosts redirect, they do not soft-200

This note first said `dl.ui.com` and `techspecs.ui.com` "answer HTTP 200 with the techspecs home page
for any slug they do not have". Re-measured today **without following redirects**, that is not what
happens: both hosts answer a redirect to the techspecs root with a 1-byte or ~300-byte body, and the
609,911-byte home page is the *landing* page reached only when the redirect is followed.

| probe, no `-L` | status | `Location` | body | landed page |
|---|---|---|---|---|
| `techspecs.ui.com/unifi/cloud-gateways/udw-pro` | **307** | `/` | 1 B | 200, 609,911 B |
| `techspecs.ui.com/unifi/cloud-gateways/udw-pro-techspecs` (control) | **307** | `/` | 1 B | 200, 609,911 B |
| `dl.ui.com/ds/udw-pro_ds.pdf` | **302** | `https://techspecs.ui.com` | 308 B | 200, 609,911 B |
| `dl.ui.com/ds/bogus-xyz_ds.pdf` (control) | **302** | `https://techspecs.ui.com` | 290 B | 200, 609,911 B |
| `dl.ui.com/qig/udw-pro.pdf` | **302** | `https://techspecs.ui.com` | 306 B | 200, 609,911 B |
| `techspecs.ui.com/` (the landing page itself) | 200 | - | 609,911 B | - |

The landing page is byte-identical to the bare root (md5 `5bec75c89b40d2283b11ac5397d85af1`), so the
fallback is the site's front door rather than a synthesised stub - which is why the earlier byte count
was right even though the status line it came from had been read after a redirect.

**Why the correction matters.** "200 on these hosts means nothing" is too strong, and it is the wrong
instrument for the next SKU. A 200 whose `%{url_effective}` is unchanged and whose body is not 609,911
bytes is a real page - that is how `techspecs.ui.com/unifi/cloud-gateways/udw` (704,702 B) and
`dl.ui.com/ds/udw_ds.pdf` (544,909 B) read as genuine today, side by side with the fallbacks above.
The instrument is `curl -w '%{http_code} %{redirect_url} %{num_redirects}'` **without** `-L`: a 307 or
302 to the root is the not-found, a 200 in place is a document. Consequence for the negative test this
note cares about: a Pro quick-start, if Ubiquiti ever publishes one, would present as a 200
`application/pdf` at that same URL, and the previous wording would have thrown it away as "the usual
fallback".

The outcome recorded here is unchanged - the Pro has no page, no datasheet and no quick-start today.
What changes is that a later pass can tell a new document from the fallback by the status line,
instead of by a byte count it has to remember.

## Why the non-Pro numbers cannot stand in

The two are not the same box with one more port. The request's own contested fields - LAN port
count, SFP+ count and speed, PoE budget, drive bays, cellular - are exactly the fields the Pro was
trailed with differing numbers for, and the only descriptions of them in circulation are 2022
Early-Access chatter and reseller catalogue text. Copying the UDW's 17 x 1 GbE into a `UDW-PRO`
record would be the family-sibling error this project has already corrected on UDM PoE draw, on
two i-MO console ports and on three MA5801 copper uplinks.

## What would unblock #130

Any one of:

1. A `techspecs.ui.com/unifi/cloud-gateways/udw-pro` page that returns **its own** content - a 200
   with no redirect to the root, at a byte count other than 609,911 (2026-11-18: today it is a 307
   to `/`, so this test is unambiguous) - then the census is one read away.
2. The UDW-PRO quick-start or installation guide at a URL that actually resolves.
3. A statement from Ubiquiti that the Pro was cancelled. The request is for a product that appears
   never to have reached the store, and "not a shipping product" is a closable answer; "no census
   published" is not, and the issue should stay open until one of the two is true.

## 2026-11-19 02:5x-03:1x UT: a second vendor surface for the UDW, a SKU-keyed register that really 404s, and a correction to what the ledger claims Ubiquiti said

Three things were measured this pass. None of them publishes a Pro census; the first and second
make the *negative* harder to argue with, and the third removes a sentence the ledger has been
leaning on that no Ubiquiti URL supports.

### 1. `techspecs.ui.com` can 404 - the SUBTEL register is SKU-keyed and it rejects the Pro

The build manifest was read to see whether a Pro page could exist unlinked. It cannot be enumerated
that way: `/_next/static/O4loEueJJ_fzZc5I2r7Ta/_buildManifest.js` (200, 3,349 B) lists 13
`sortedPages`, and every product path is a **dynamic** route
(`/[productLine]/[category]/[product]`), so there is no static route list - the 16 cards on the
category grid remain the only live enumeration. The manifest did expose one route no earlier pass
had touched: `/compliance/chile/[[...sku]]`, a SKU-keyed regulatory register.

| URL | result |
|---|---|
| `https://techspecs.ui.com/compliance/chile/udw` | **200**, 615,226 B - SUBTEL Resolution No. 737 page, body names `Dream Wall`, `UDW`, `UDW-EU` |
| `https://techspecs.ui.com/compliance/chile/udw-pro` | **404**, 512,657 B - Next.js `404 - This page could not be found` |
| `https://techspecs.ui.com/compliance/chile/udwpro` | **404**, 512,657 B |
| `https://techspecs.ui.com/compliance/chile` (index) | 200, 549,642 B; trailing slash answers **308** to the bare path |
| `https://techspecs.ui.com/compliance/udw` (no locale segment) | **307** to `https://techspecs.ui.com/` |

This matters less for the register it is (Chilean type-approval, so absence could only ever mean
"not certified for Chile") than for what it proves about the host: here is a sub-tree of
`techspecs.ui.com` that answers a **404 for a SKU it does not have** and a **200 for one it does**,
with no redirect and no shared front-page bytes. The standing caveat on this issue - that a 200 on
this host is meaningless, so a negative cannot be falsified - does not extend to this route. The
Pro is absent from it, as it is absent from the marketing tree.

### 2. The UDW census, from a second vendor surface and not from techspecs

`https://store.ui.com/us/en/collections/unifi-dream-wall/products/udw` @ **20230603042814** (200,
124,982 B raw). This is a *collection* page, i.e. the place a sibling SKU in the same family would
be listed, and its own navigation prints the family as **"Dream Wall New / Dream Machine / Dream
Router / Dream Wall UDW $999.00"**. In Ubiquiti's words the box is:

> (17) LAN: GbE RJ45 ports - (1) WAN: 2.5 GbE RJ45 port - (1) LAN: 10G SFP+ port - (1) WAN: 10G
> SFP+ port - PoE interface (4) PoE, (4) PoE+, (4) PoE++

Case-insensitive occurrences of `Dream Wall Pro`, `udw-pro` and `Coming Soon` on that page: **0, 0,
0**. This is the first confirmation of the UDW census that does not come from the tech-spec page or
the datasheet, and it agrees with `devices/ubiquiti/udw.json` exactly: 20 interfaces, 17 x 1 GbE
RJ45 (12 PoE-capable: 4 PoE++ at `eth0-3`, 4 PoE+ at `eth4-7`, 4 PoE at `eth8-11`), 1 x 2.5 GbE
RJ45, 2 x 10G SFP+. **No spec change follows** - the file was already right, which is why it is safe
to point a requester at it.

### 3. Correction: "Ubiquiti's early-access copy" is a forum reprint, and the ledger says otherwise

The ledger and two comments on this issue rest a frame on this sentence - that Ubiquiti's Early
Access copy *"names the Dream Wall and Dream Wall Pro (UDW/UDW Pro)"* and shows *"Dream Wall Pro -
Coming Soon"*. Its only citation, here and in `research/open-device-requests.json`, is
`https://ubiquiti-networks-forum.de/board/thread/4925-ea-store-eu-dream-wall-early-access/` - a
third-party enthusiast forum, not a Ubiquiti host. There is no Ubiquiti URL for that copy in the
`sources` list, and the archive cannot supply one:

| CDX query | earliest capture |
|---|---|
| `store.ui.com*`, `original:.*udw.*`, 2022-2023 | **2023-06-03** - no 2022 capture of any `udw` page |
| `ui.com*`, `original:.*dream.*`, 2022-2023 | **2023-10-18** (`/cloud-gateways/dream-wall`) - nothing EA-era |

So the Early-Access store page that supposedly carried "Coming Soon" was never crawled, and the
claim is a **reprint of a deleted page, attributed to Ubiquiti by a forum**. Call it what it is: the
only naming of a Pro anywhere is third-party. That does not change the open/closed state - but it
does mean the sentence cannot carry the inference drawn from it at the foot of this note, that the
Pro is "not a shipping product" and therefore closable. `docs/RESOLUTIONS.md` is explicit that no
request closes as unbuildable or impossible; a request whose product may exist but whose census
nobody publishes is the case that rule was written for. It stays open, as the ledger's `unblock`
field already says.

## 2026-11-19 03:2x UT: the page publishes its own storefront list (nine of nine 404), and the quick-start key resolves - to artwork with no text layer

Two surfaces this thread had named but never resolved, both reached from the UDW techspecs page's own
server-rendered `__NEXT_DATA__` rather than from a guessed URL. Neither publishes a Pro census. The
first makes "not a regional SKU" exhaustive instead of two-region; the second closes the
"the quick-start prints the layout" hope for this family at the level of the file format.

### 1. `alternativeStores` enumerates the storefronts, and the Pro is absent from all nine

`https://techspecs.ui.com/unifi/cloud-gateways/udw` (200, 704,702 B) carries
`props.pageProps.product.alternativeStores` - the storefronts that carry the SKU, published by the
vendor's own page. It names nine: `br`, `ca`, `eu`, `jp`, `me`, `mx`, `tw`, `uk`, `us`.

| storefront | `/{store}/en/products/udw` (control) | `/{store}/en/products/udw-pro` |
|---|---|---|
| us | 200, 568,104 B | **404**, 204,279 B |
| eu | 200, 588,457 B | **404**, 204,279 B |
| ca | 200, 589,781 B | **404**, 204,279 B |
| br | 200, 492,349 B | **404**, 204,279 B |
| jp | 200, 555,049 B | **404**, 204,279 B |
| me | 200, 485,478 B | **404**, 204,279 B |
| mx | 200, 510,785 B | **404**, 204,279 B |
| tw | 200, 491,408 B | **404**, 204,279 B |
| uk | 200, 584,209 B | **404**, 204,279 B |

Two details that keep the negative honest. Non-US requests answer **307** from
`store.ui.com/{store}/...` to `{store}.store.ui.com/{store}/...`: that is storefront routing, and the
control 200 at the end of it shows the route works. And the nine 404s are one page - identical
204,279 B, `md5 346734f60828bb9d80819a8092b2d291` when checked on `us`, `eu` and `tw` - so these are
product-keyed misses, not nine different errors.

Earlier passes walked the US and EU **category grids** and read the absence of `udw-pro` there. This
is the product-keyed version of the same test across every storefront the page itself names, so the
"it may be a regional SKU" avenue is now closed rather than merely unlikely.

### 2. The document key pattern is `dl.ui.com/qig/<slug>.pdf`, taken from the product's own record

`props.pageProps.product.documents` is
`[{"type": "InstallationGuide", "url": "https://dl.ui.com/qig/udw"}]`. Following the key it names:

| probe | status | type | bytes |
|---|---|---|---|
| `dl.ui.com/qig/udw.pdf` | **200** | `application/pdf` | 8,279,805 |
| `dl.ui.com/qig/udw-pro.pdf` | 302 -> `https://techspecs.ui.com` | - | 286 |
| `dl.ui.com/qig/udwpro.pdf` | 302 -> `https://techspecs.ui.com` | - | 305 |
| `dl.ui.com/qig/udw-eu.pdf` | 302 -> `https://techspecs.ui.com` | - | 305 |
| `dl.ui.com/qig/bogus-xyz.pdf` (control) | 302 -> `https://techspecs.ui.com` | - | 308 |

So the pattern an earlier pass guessed (`dl.ui.com/qs/UDW.pdf`) was wrong in the segment, not absent:
the quick-start exists for the UDW, at `/qig/`, and the fallback for a slug that has no document is
the same 302 to the techspecs root that a nonsense slug gets. `qig/udw-eu.pdf` missing while
`qig/udw.pdf` is present also shows the key is **per SKU, not per region** - there is no regional
quick-start to find.

**The part that ends the quick-start route as a census source for this family.** The UDW QIG is one
page, produced by Adobe Illustrator 28.0, and carries **no text at all**: none of its five
decompressed content streams contains a `BT`, `Tj` or `TJ` operator, and the file has no
`/ActualText`. Every label on the sheet is outlined vector artwork. A Pro quick-start, if Ubiquiti
ever published one, would still have to be read by eye by someone with the drawing in front of them;
it cannot be turned into a port census by text extraction, and reading outline artwork by guessing at
shapes is exactly the kind of inference this note exists to prevent.

### 3. The vendor's own machine-readable spec agrees with `devices/ubiquiti/udw.json`

For completeness, the same pageProps hold `product.technicalSpecification` - the spec table as data,
not as markup. The rows that matter here:

| row | value |
|---|---|
| PoE Budget | `420W` |
| Max. Power Consumption | `112W (Excluding PoE output)` |
| Default WAN Ports | `(1) 2.5 GbE RJ45` + `(1) 10G SFP+` |
| Max. WAN Port Count | `8` |
| Power Supply | `(2) Hot-Swappable AC/DC 550W PSU`, `(1) Pre-installed PSU` |
| NVR Storage | `512 GB microSD` + `128 GB SSD` |

That matches the datasheet text layer (`dl.ui.com/ds/udw_ds.pdf`, 544,909 B: 17 LAN GbE of which
4 PoE / 4 PoE+ / 4 PoE++, 1 WAN 2.5 GbE, 1 LAN + 1 WAN 10G SFP+, 532 W max consumption) and
`devices/ubiquiti/udw.json` (20 interfaces, 420 W budget). **No spec change follows** - the file was
already right, which is why pointing a requester at it is safe.

### What still unblocks #130

Unchanged, and now narrowed on two more surfaces: a Ubiquiti-hosted page, datasheet, quick-start,
FCC exhibit or storefront entry that names `UDW-PRO` and prints its ports and PoE budget - or the
requester confirming they meant the **UDW** (`devices/ubiquiti/udw.json`) or the **UDM-Pro**. The
quick-start avenue should be considered closed for any sibling that Ubiquiti publishes only as
`qig` artwork.

## 2026-11-19 03:5x UT: the marketing site publishes a product ItemList, and the support knowledge base publishes console names - neither knows a Pro Dream Wall

Two Ubiquiti hosts that the earlier passes never read. Both enumerate products by name; both answer
the Pro with nothing, and both answered a control correctly, which is what makes those nothings
usable.

### 1. `ui.com/cloud-gateways` carries a schema.org `ItemList` of the family - 14 named SKUs, no Pro

`https://ui.com/cloud-gateways` - **200**, 446,725 B, four `application/ld+json` blocks. One of them
is an `ItemList` whose `itemListElement` entries name each gateway and point at its tech-spec page:

| # | name | `item.url` |
|---|---|---|
| 1 | Enterprise Firewall Core | `techspecs.ui.com/unifi/cloud-gateways/ef-core` |
| 2 | Enterprise Firewall | `.../efg` |
| 3 | Dream Machine Beast | `.../udm-beast` |
| 4 | Dream Machine Pro Max | `.../udm-pro-max` |
| 5 | Dream Machine Special Edition | `.../udm-se` |
| 6 | Dream Machine Pro | `.../udm-pro` |
| 7-10 | Cloud Gateway Max / Fiber / Ultra / Industrial | `.../ucg-max`, `.../ucg-fiber`, `.../ucg-ultra`, `.../ucg-industrial` |
| 11 | Dream Router 5G Max | `.../udr-5g-max` |
| 12 | Dream Router 7 | `.../udr7` |
| 13 | **Dream Wall** | `.../udw` |
| 14 | UniFi Express 7 | `.../ux7` |

`udw-pro` occurs **0** times in those 446,725 bytes, `Dream Wall Pro` **0** times. The list is not
filtering Pro variants out: item 4 and item 6 are `Dream Machine Pro Max` and `Dream Machine Pro`, and
the sibling Dream Wall is item 13 - a Pro would be listed next to it.

Caveat, recorded rather than glossed: this is a **curated** list of 14, while the techspecs category
grid carries 16 cards - `udr` and `ux` are absent from the marketing list. So this page corroborates
the absence, it is not by itself an exhaustive enumeration. The exhaustive one remains the techspecs
grid.

### 2. The support knowledge base names consoles - "Dream Wall (UDW)", never a Pro

`help.ui.com` is Zendesk, so the search index is public and machine-readable:
`https://help.ui.com/api/v2/help_center/articles/search.json?query=<q>&per_page=…`

| query | HTTP | bytes | `count` |
|---|---|---|---|
| `dream wall pro` | 200 | 728,119 | 33 |
| `udw-pro` | 200 | 719,384 | 105 |
| `udw` | 200 | 364,696 | 13 |

73 result rows, **50 unique articles**; across all titles and bodies the strings `Dream Wall Pro`,
`UDW-PRO` and `UDWPRO` occur **zero** times. The Dream Wall appears only as `Dream Wall (UDW)` - in
*UniFi Consoles with UniFi Access Support*, *UniFi Gateway - SD-WAN with Site Manager and Fabrics*,
*Upgrading to UID Enterprise* (which marks it `(EA)`, the early-access flag, for the UDW itself) and
*UniFi Recovery Mode*.

**Control, because an empty search can also mean a broken index.** The same endpoint with
`query=udm-pro` returns 200, 1,737,208 B, 100 rows of 118, and those rows contain `UDM-PRO` **39**
times and `Dream Machine Pro` **18** times. The index does carry Pro-suffixed console names; it
simply has none for the Dream Wall.

### 3. A third instrument trap for this host family, and a corroboration that is not a spec change

`https://ui.com/robots.txt` (200, 367 B) declares `Sitemap: https://ui.com/sitemap.xml`. That sitemap
is real - 200, 8,712 B, 81 `<loc>` entries - but it indexes **sections**, not SKUs
(`/cloud-gateways`, `/how-it-works/multi-site`, `/physical-security/dome-turret`, …), and contains
zero occurrences of the string `dream`. It therefore says nothing about a Dream Wall of any kind:
**absence from this sitemap must not be cited as a negative**, the way absence from the techspecs grid
legitimately can be. Recorded so a later pass does not count it either way.

The recovery article does give one incidental cross-check on the UDW census: *"Connect to the Dream
Wall via Port 18, not Port 1"* - a vendor-published statement that the box has at least 18 numbered
Ethernet ports, consistent with the 17 LAN + 1 WAN RJ45 already in `devices/ubiquiti/udw.json` (20
interfaces with the two SFP+). It corroborates; it does not add a field, so no spec change follows.

### What still unblocks #130

Unchanged: a Ubiquiti-hosted page, datasheet, quick-start, FCC exhibit, storefront entry or
knowledge-base article that names `UDW-PRO` and prints its ports and PoE budget - or the requester
confirming they meant the **UDW** (`devices/ubiquiti/udw.json`) or the **UDM-Pro**. The Pro's missing
fields remain the whole census: RJ45 and SFP+ counts and rates, PoE budget and per-port maxima, drive
bays, WAN options.

## 2026-11-19 04:2x UT: the commerce backend answers per SKU, and its not-found carries a store list that stays empty for the Pro

Every pass above tested the store with the wrong instrument. Nine storefronts were probed by fetching
`/{store}/en/products/udw-pro` and reading the 404 - a **page route**. A route can be removed while
the product still sits in the catalogue, and a page can be switched off while the row survives. This
pass asked the database instead: `store.ui.com` is a Next.js front end over a GraphQL service, and its
per-SKU lookup answers anonymously.

### 1. How to reach it, and why the obvious door is shut

The product page's HTML gives one hint - `<link rel="preconnect" href="https://ecomm.svc.ui.com">` -
and no paths; the operations live in the JS chunks. `https://ecomm.svc.ui.com/graphql` is live:
`{__typename}` answers `{"data":{"__typename":"Query"}}`.

Three things about it have to be known before a result means anything:

- **Introspection is refused.** `{__schema{queryType{fields{name}}}}` answers **400**.
- **Validation errors are masked.** An unknown field does not say "unknown field"; it returns *N* copies
  of `{"message":"Internal Server Error","code":"INTERNAL_SERVER_ERROR"}`. The **count** is still an
  oracle: adding a valid optional input field leaves the count unchanged, an invalid field adds 1, and
  a missing *required* field removes 1. That is how `limit` and `offset` were found to be required and
  `ids` to be invalid - no guessing beyond that was needed.
- **The list query is not usable.** `storefrontProducts(input:...)` answers four masked errors for
  every selection and every input tried, including a valid `storeId`. There is no catalogue-wide
  enumeration here; this instrument is slug-at-a-time.

The lookup that does work, taken from the `GetProduct` operation in the bundle:

```
query GetProduct($slug:LowercaseTrimmedString!,$storeId:StoreId!,
                 $language:LowercaseTrimmedString!,$displayCurrency:Currency!){
  storefrontProduct(slug:$slug,storeId:$storeId,language:$language,
                    displayCurrency:$displayCurrency){
    id title displaySku slug status historicalSlugs }}
```

`storeId` must be **lowercase** (`"us"` works, `"US"` returns the masked validation error). Reproduce
all of this with `node scripts/ubiquiti-storefront-catalogue.js --slug udw,udw-pro`.

### 2. The controls first, because a miss is only evidence if a hit is possible

This API returns products that are **gone**, and resolves names they used to have. If it could only
return current listings, a miss would prove nothing.

| slug | result | `status` | `historicalSlugs` |
|---|---|---|---|
| `udw` | **FOUND**, `displaySku` `UDW (420W)` | `SoldOut` | `["dream-wall","dream-wall-ea","udw","unifi-dream-wall"]` |
| `udm` | **FOUND**, `displaySku` `UDM` | `SoldOut` | `["unifi-dream-machine"]` |
| `udm-pro` | **FOUND**, `displaySku` `UDM-Pro` | `Available` | `["udm-pro","udm-pro-u"]` |
| `ucg-fiber` | **FOUND**, `displaySku` `UCG-Fiber (30W)` | `Available` | `[]` |

So retired rows are served, and `dream-wall-ea` - the early-access slug - is on the UDW's own record.
A Pro variant sold under an old name would be reachable by that name.

### 3. The Pro, asked at the database, from every storefront

The not-found error carries `extensions.alternativeStores`, which is the API naming the catalogues that
*do* hold the product. On the control it is populated; on the Pro it is empty everywhere.

| store | `udw` (control) | `udw-pro` |
|---|---|---|
| us | **FOUND** `SoldOut` | **NOT_FOUND**, `alternativeStores: []` |
| eu | NOT_FOUND, **9 stores listed** | **NOT_FOUND**, `alternativeStores: []` |
| ca | NOT_FOUND, **9 stores listed** | **NOT_FOUND**, `alternativeStores: []` |
| br | NOT_FOUND, **9 stores listed** | **NOT_FOUND**, `alternativeStores: []` |
| jp | NOT_FOUND, **9 stores listed** | **NOT_FOUND**, `alternativeStores: []` |
| me | NOT_FOUND, **9 stores listed** | **NOT_FOUND**, `alternativeStores: []` |
| mx | NOT_FOUND, **9 stores listed** | **NOT_FOUND**, `alternativeStores: []` |
| tw | NOT_FOUND, **9 stores listed** | **NOT_FOUND**, `alternativeStores: []` |
| uk | NOT_FOUND, **9 stores listed** | **NOT_FOUND**, `alternativeStores: []` |

The non-US control rows are the important ones: from `eu`, the UDW is **not in that catalogue**, and
the error lists all nine storefronts that have it. That is the instrument demonstrating it can see a
product outside the store being asked about. The same query for `udw-pro` lists **nothing**, from all
nine. Five spellings were tried at the database - `udw-pro`, `udwpro`, `udw-pro-us`,
`dream-wall-pro`, `dreamwallpro` - and all are `NOT_FOUND` with an empty store list.

### 4. What this does and does not prove

**It proves** there is no catalogue row for a Pro Dream Wall in any Ubiquiti storefront, that no
alias on record resolves to one, and that this is not a delisting: a delisted product answers
`SoldOut` and is still returned.

**It does not prove the product never existed.** This API *purges* rows - `usg` and `uxg` are also
`NOT_FOUND` while `udm`, `udr` and `ucg-fiber` are found - so a purged legacy SKU is indistinguishable
from one that was never created. That distinction is exactly why the request stays open: the census
fields were never published, and "Ubiquiti no longer has a record" is not a port count.

### 5. Two further traps on this host, so they are not re-walked

`store.ui.com/robots.txt`, `/sitemap.xml`, `/us/en/sitemap.xml` and `/products.json` **all 404** -
the same 204,279-byte page as any other miss, so the store publishes no product index and is not
Shopify (no `products.json`). And the earlier thread's note that store search is client-rendered still
holds; this API is the only machine-readable door, and it is per-SKU.

**No spec change follows.** `devices/ubiquiti/udw.json` is untouched: the vendor's machine-readable
`technicalSpecification` agrees with it, and none of the Pro's fields exist to add.

### What still unblocks #130

Unchanged. A Ubiquiti-hosted page, datasheet, quick-start, FCC exhibit, storefront entry or KB article
that names `UDW-PRO` and prints its ports and PoE budget - or the requester confirming they meant the
**UDW** (`devices/ubiquiti/udw.json`) or the **UDM-Pro**. What has changed is the strength of the
negative: it no longer rests on rendered pages, but on the catalogue itself, asked per SKU across nine
storefronts with a control that returns retired rows and foreign-store hits.

*Follow-up (2026-11-19): the same negative was then read off the record the controller adopts hardware
from — `https://static.ui.com/fingerprint/ui/public.json`, 701 device records, no `UDW-PRO`. See
`research/ubiquiti-udw-pro-device-fingerprint-census.md`, which also shows why absence there covers
early-access and retired hardware.*

## 2026-11-19 17:3x UT: the ISP Design Center is a different host from the Design Center read this morning, and its device enum is plain JavaScript

The 07:5x pass read `https://design.ui.com/` and found a client-rendered SPA where `/api/devices`,
`/api/models` and friends all answer the same 8,107-byte router shell, so the library behind it could
not be read. **`https://ispdesign.ui.com/` is a separate application** - a Create-React-App build
(`/static/js/<chunk>.<hash>.js`), not the `/assets/index-<hash>.js` bundle - and it ships its whole
device catalogue inside the JavaScript, in the clear, with no API call required.

| probe | status | bytes | md5 |
|---|---|---|---|
| `https://ispdesign.ui.com/` | 200, `text/html` shell | 4,165 | `7000750e8514df7b71036ccc10428b3f` |
| `https://ispdesign.ui.com/static/js/522.5aa1f7ec.js` | 200, holds the model enum | 1,740,400 | `e241753a934d443624d64442c87c4d3c` |

(Nine chunks were fetched; the enum lives in `522`. The host is server-static throughout, so unlike
`design.ui.com` and `store.ui.com/search`, a 200 here is real content and its silence is citable.)

### The controls, because a miss only counts if a hit is possible

The enum is `Ident:"Label"` pairs over the devices the tool can place in a topology. **80 of its
members carry a `Pro` suffix**, including routers:

```
EdgeRouter_8_PRO:"EdgeRouter 8 PRO"      EdgeRouter_Infinity:"EdgeRouter Infinity"
EdgeRouter_12P:"EdgeRouter 12P"          U7_Pro_Max:"U7 Pro Max"
```

So Pro-suffixed and `Infinity`-named hardware **is** modelled here; the absence below is not an
artefact of the enum stripping suffixes.

### What it says about the one box that exists

`Dream_Wall:"Dream Wall"` and `Dream_Wall_2_4_GHz:"Dream Wall (2.4 GHz)"` (the two radio variants of
one chassis), whose record carries:

```
sku:"UDW", sys_id:"ea2a", uidb_id:"3904d899-2536-40db-b437-055eb0bd61df",
wifi_standard:Wifi6, power_consumption:532
```

**532 W is 420 W + 112 W** - the PoE budget and the max draw excluding PoE that
`devices/ubiquiti/udw.json` already declares. That is an independent vendor figure agreeing with the
spec, and it is the only thing this host adds: the records hold radio, antenna, power and description
fields and **no port list at all** (zero hits for `port_count`, `portProfile` or `ports:[` in the
chunk), so it is not a census source and cannot fill the Pro's missing fields.

### The Pro, in the same enum

Twelve Dream-family variants are modelled - Machine, Machine 2.4, Wall, Wall 2.4, Router, Router 2.4,
Router 7 x3, Router 5G Max x3. Across all nine chunks the strings `Dream_Wall_Pro`, `udw-pro`,
`udwpro` and `Wall Pro` (case-insensitive) occur **zero** times.

### What this does and does not prove

It is the **third independent device register** to be read, after the 701-record
`static.ui.com/fingerprint/ui/public.json` and the per-SKU commerce API, and it agrees with both.

It is **corroboration, not decision**: this enum carries the base `Dream_Machine:"Dream Machine"`
(`sku:"UDM"`) and `UCG_Industrial`, but *no* UDM Pro and no UDM Pro Max - so its console coverage is a
subset of the line-up, and a console missing here need not be missing from the world. The decisive
negatives remain the ones already recorded: the techspecs gateway grid (16/16 cards, no `udw-pro`),
the SWX grantee census (no Pro grant), the firmware platform codes (no `UDWPRO`) and the 701-record
fingerprint register.

**No spec change follows.** `devices/ubiquiti/udw.json` is untouched. What unblocks #130 is unchanged:
a Ubiquiti-hosted page, datasheet, quick-start, grant exhibit, storefront entry or KB article naming
`UDW-PRO` with its ports and PoE budget - or the requester confirming they meant the UDW, already
catalogued.

## 2026-11-19 17:5x UTC: the Early Access storefront is live and login-gated - the one surface that is *gated* rather than empty

Every earlier section here ends in "absent". This one does not: the channel where an announced-but-unreleased console
would sit is **deployed and cannot be read anonymously**, which is a different fact and a sharper blocker.

### 1. `ea.store.ui.com` fails TLS, and that is a certificate gap, not a dead host

| host | certificate | SANs | `curl` without `-k` |
|---|---|---|---|
| `ea.store.ui.com` | `CN=*.ui.com` | `*.ui.com`, `unifi.ui.com`, `beta.unifi.ui.com` | error 60, no connection |
| `store.ui.com` | `CN=store.ui.com` | `store.ui.com`, `*.store.ui.com` | 200 |

`*.ui.com` is a single-label wildcard and `ea.store.ui.com` is two labels to the left of the apex, so the presented
certificate cannot match - **by design, not by decommissioning**. The name still resolves (CloudFront,
`2600:9000:2038:...`). Recorded because "curl says the certificate is wrong" is exactly how a pass concludes
"retired" and moves on; the earlier trap list in this file has the same shape for hosts that redirect instead of 404.

### 2. Behind the certificate it is a deployed shop with a global login gate

Measured with `-k`, because the certificate is not the subject here:

| path | status | body | `Location` |
|---|---|---|---|
| `/` | **302** | 0 | `account.ui.com/login?redirect=...%2F` |
| `/us/en` | **302** | 0 | `...redirect=https%3A%2F%2Fea.store.ui.com%2Fus%2Fen` |
| `/us/en/products/udw-pro` | **302** | 0 | `...%2Fus%2Fen%2Fproducts%2Fudw-pro` |
| `/nonexistent-xyz` (control) | **302** | 0 | `...%2Fnonexistent-xyz` |
| `/_next/static/` | **302** | 0 | `...%2F_next%2Fstatic%2F` |
| `/favicon.ico` | 200 | 5,430 | - (`image/vnd.microsoft.icon`, md5 `9fe014bbdbd4d12c3312fcbc41b0c436`) |

The bogus path is what makes the table mean something: a missing page would answer 404 with content, and a retired
host would not serve a 5,430-byte favicon from a build. Instead **every** path - a product page, a junk path, and the
JavaScript bundle directory - is redirected to `account.ui.com/login` with the requested path preserved.
`account.ui.com/login?redirect=...` answers 200, 1,634 B, `<title>Ubiquiti Account`. So the application is up, and both
its payload and the bundle that would name the EA `storeId` are behind the same wall.

### 3. The retail store has no anonymous early-access path either

`store.ui.com/us/en/early-access` -> **307** to `/us/en` (26 B), and
`store.ui.com/us/en/collections/early-access` -> **307** to `/us/en` (6 B). The EA shop is its own host, not a
category of the retail one.

### 4. The commerce backend will not answer for EA store ids

The per-SKU query takes a `storeId`. `ea`, `ea-us` and `us-ea` each answer **one** masked `INTERNAL_SERVER_ERROR` for
**both** `udw` (the control) and `udw-pro`. Under the oracle already recorded in this file - invalid input adds an
error, valid optional input does not - one error on the control means the *store id* was rejected, not that the product
is missing. Reproduce with
`node scripts/ubiquiti-storefront-catalogue.js --slug udw,udw-pro --store ea --json`.

### 5. Why this matters for this SKU specifically

The UDW's own commerce row carries `historicalSlugs ["dream-wall","dream-wall-ea","udw","unifi-dream-wall"]` - the Wall
first existed in the Early Access storefront under an EA slug. A console that has been announced but not yet made
public is precisely what that channel carries, and it is the only Ubiquiti surface checked across these passes whose
silence is **not citable**. So the negative is now "absent from every vendor surface readable without credentials, and
unreadable on the one that is gated" - not "absent everywhere".

Two reconfirmations from the same pass, neither changing the negative:

- `https://uk.store.ui.com/uk/en/category/all-cloud-gateways` - 200, 483,934 B, **16** embedded `StorefrontProduct`
  records with `displaySku` and `historicalSlugs`; `udw-pro` and `UDW-PRO` occur **zero** times. The UDW's record is
  `displaySku "UDW (420W)"`, `historicalSlugs ["dream-wall","dream-wall-ea","udw","unifi-dream-wall"]` - the same alias
  table the API returns, read this time out of rendered HTML on a third storefront.
- The citation the request was built from, `4gon.co.uk/ubiquiti-unifi-dream-wall-pro-udwpro-p-10111.html`, answers
  **403** with a Cloudflare interstitial (5,626 B), and `archive.org/wayback/available` returns
  `{"archived_snapshots": {}}`. The page the body's port list was "inferred from" has **never been archived**, so
  even the premise cannot be re-derived.

### What unblocks #130, narrowed

Two readings, both cheap for someone who is not an anonymous crawler: (a) open `ea.store.ui.com` signed in to a
Ubiquiti account and read the `udw-pro` entry's port list - this worker cannot pass the gate; or (b) the requester
confirming the SKU meant is the catalogued **UDW** (`devices/ubiquiti/udw.json`) or the **UDM-Pro**. The anonymous
vendor surfaces are exhausted as far as this worker can see.

**No spec change follows.** `devices/ubiquiti/udw.json` is untouched.

### 6. The marketing sitemap and the JSON-LD product list (2026-11-20)

Two surfaces above the store, both readable anonymously, both negative:

- `https://ui.com/sitemap.xml` - **200, `application/xml`, 7,794 B, 82 `<loc>` entries**. Unlike the
  `techspecs.ui.com` sitemap recorded earlier in this thread (a 609,911-byte not-found page), this one is a real
  index. It carries category pages only - `/cloud-gateways`, `/cloud-gateways/wifi-integrated`,
  `/cloud-gateways/large-scale` - and **no per-product URL**, so there is nothing to enumerate from it.
- `https://ui.com/cloud-gateways` - 200, 529,519 B, and it embeds a schema.org `ItemList` of the gateway range.
  Fourteen `ListItem`s, positions 1-14, every one pointing at a `techspecs.ui.com/unifi/cloud-gateways/<slug>`
  page: `ef-core, efg, udm-beast, udm-pro-max, udm-se, udm-pro, ucg-max, ucg-fiber, ucg-ultra,
  ucg-industrial, udr-5g-max, udr7, udw, ux7`. Position 13 is `"name":"Dream Wall"`,
  `"@id":".../udw#product"`. **Zero** entries name a Dream Wall Pro.

This is the vendor's own marketing taxonomy rather than a third-party grid, and it is the sixth independent
Ubiquiti surface - after the tech-spec grid, the storefront, the fingerprint register, the SWX grantee census
and the firmware platform codes - to print the same fourteen-to-sixteen console range with no Pro member. It
does not change the disposition: still blocked on a vendor artefact naming `UDW-PRO`.

**What did change here:** the same datasheet and tech-spec rows that make the Pro unmodellable *did* settle the
base UDW's WAN side, which `devices/ubiquiti/udw.json` had never encoded - see the PR that carries this note.

### Resolved 2026-11-24: the request was for the Dream Wall, and the Dream Wall is catalogued

Issue #130 closed on 2026-11-24 00:49Z, and it closed the way `docs/RESOLUTIONS.md` allows a device
request to close - the catalogue answers it and the comment names the file - not because a vendor
surface finally produced a Pro. The evidence that settled it came from a page this file had already
listed as a route and never read properly, because it is client-rendered: the store product page
`https://store.ui.com/us/en/products/udw` has a **Technical** tab, and that tab carries the whole
port table (read in a browser on 2026-11-23; the rows and their values are quoted in the closing
comment on #130). Every row - 17 x 1 GbE RJ45 with the 4 PoE++ / 4 PoE+ / 4 PoE split, 1 x 2.5 GbE
RJ45, 2 x 10G SFP+, a 420 W budget - is already in `devices/ubiquiti/udw.json`, and the same tables
are in `https://techspecs.ui.com/unifi/cloud-gateways/udw` (200, 704,702 B) and
`https://dl.ui.com/ds/udw_ds.pdf` (200, 544,909 B).

The negative stands and is not weakened by the close: there is no `UDW-PRO` SKU. The store
"Cloud Gateways" category enumerates nine products, none of them a Dream Wall Pro; every
`/products/udw-pro` route 404s on every regional storefront; and the techspecs grid and the Wayback
CDX hold no `udw-pro` row. What was wrong was the request, not the catalogue: a reseller listing had
named a product the vendor never shipped, and the fields the issue asked for were the fields the
Dream Wall already declares.

**What moved with the close.** `research/open-device-requests.json` no longer lists #130, so
`docs/DEVICE_REGISTRY.md` (regenerated) reports the queue as clear and
`scripts/check-closed-issues.js` stops reporting a close that contradicts this project's own record.
Two suites had been using #130 as their live control row - `test/closed-issues-audit.test.js`
("the live mirror still yields a row to audit") and `test/close-merged-issues.test.js` ("the queue
parses and is not empty") - and both now pin the behaviour with a synthetic row instead: whether a
check can see a row is a property of the check, not of the backlog staying non-empty.
