# The Dream Wall Pro has no vendor page, and Ubiquiti serves its 404s as 200s

Request #130 asks for a **Ubiquiti UniFi Dream Wall Pro (UDW-PRO)** as a routed gateway. Its own
body says the port list is "inferred from the 4gon product name" and sends the reader to that
reseller listing, so the census was never sourced in the first place. This note records what
Ubiquiti publishes about the Pro today (2026-11-17) and, more usefully, the two ways this site
makes a page look present when it is not.

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
| `techspecs.ui.com/unifi/cloud-gateways/udw-pro` | 200 | `https://techspecs.ui.com/` | 609,911 |
| `techspecs.ui.com/unifi/cloud-gateways/udw` | 200 | unchanged | 704,702 |
| `store.ui.com/us/en/products/udw-pro` | **404** | unchanged | 204,279 |
| `store.ui.com/us/en/products/udw` | 200 | unchanged | 568,104 |
| `dl.ui.com/ds/udw-pro_ds.pdf` | 200 | `https://techspecs.ui.com/` | 609,911 |
| `dl.ui.com/ds/udw_ds.pdf` | 200 | unchanged | 544,909 |

The store page for the UDW mentions only `udw-us`, `udw-module` and `udw-raceway`; there is no
`udw-pro` slug anywhere in it. The reseller listing the request cites
(`4gon.co.uk/ubiquiti-unifi-dream-wall-pro-udwpro-p-10111.html`) now answers **403** to this host,
and would not be admissible evidence for a port count even if it did not.

## The trap: on these two hosts, 200 means nothing

`dl.ui.com` and `techspecs.ui.com` answer **HTTP 200 with the techspecs home page** for any slug
they do not have. Two controls, run the same way as the probes above:

- `techspecs.ui.com/unifi/cloud-gateways/udw-pro-techspecs` - 200, final `https://techspecs.ui.com/`, 609,911 bytes.
- `dl.ui.com/ds/bogus-xyz_ds.pdf` - 200, final `https://techspecs.ui.com/`, 609,911 bytes.

Both are byte-identical to the `udw-pro` probes. So the only honest reading of a 200 on those hosts
is **compare the final URL and the byte count**, never the status line. The same caveat kills the
quick-start-guide pattern as a negative test: `dl.ui.com/qs/UDW-Pro.pdf` and `dl.ui.com/qs/UDW.pdf`
both fall back to 609,911 bytes, so "no QSG at that path" proves nothing about either model.

This is why the 2026-11-10 comment on #130 ("`techspecs.ui.com/.../udw-pro` redirects") was right
about the outcome and unsafe as a method: a redirect to the techspecs home page is the site's
not-found, not a link to the product.

## Why the non-Pro numbers cannot stand in

The two are not the same box with one more port. The request's own contested fields - LAN port
count, SFP+ count and speed, PoE budget, drive bays, cellular - are exactly the fields the Pro was
trailed with differing numbers for, and the only descriptions of them in circulation are 2022
Early-Access chatter and reseller catalogue text. Copying the UDW's 17 x 1 GbE into a `UDW-PRO`
record would be the family-sibling error this project has already corrected on UDM PoE draw, on
two i-MO console ports and on three MA5801 copper uplinks.

## What would unblock #130

Any one of:

1. A `techspecs.ui.com/unifi/cloud-gateways/udw-pro` page that returns **its own** content (final URL
   unchanged, byte count different from 609,911) - then the census is one read away.
2. The UDW-PRO quick-start or installation guide at a URL that actually resolves.
3. A statement from Ubiquiti that the Pro was cancelled. The request is for a product that appears
   never to have reached the store, and "not a shipping product" is a closable answer; "no census
   published" is not, and the issue should stay open until one of the two is true.
