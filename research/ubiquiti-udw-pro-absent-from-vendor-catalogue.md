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
