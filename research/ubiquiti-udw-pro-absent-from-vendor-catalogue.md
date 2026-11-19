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
