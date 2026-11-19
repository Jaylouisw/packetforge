# 408 product cards, 398 SKUs, one Dream Wall: Ubiquiti's tech-spec site enumerated

Read 2026-11-19 22:5x UT. Every earlier pass on #130 read **one** grid on `techspecs.ui.com` - the
cloud-gateway index, sixteen cards - and the build manifest, which showed the product route is
dynamic (`/[productLine]/[category]/[product]`) and therefore that no static slug list exists. Neither
is an inventory: the first is one category, the second is a router shape. What had not been done was
the obvious one - **count the cards on every category grid the site publishes**.

That distinction matters because a product's category cannot be guessed from its name. The UniFi
Mobile Router, a router, is filed under `/unifi/integrations/`; the Dream Wall, a gateway, under
`/unifi/cloud-gateways/`; the U7 Pro Wall, an access point, under `/unifi/wifi/`. A pass that reads
the gateway grid and stops has checked one seventh of the site's UniFi inventory.

## The eight grids

`/unifi` links seven categories (`accessories`, `cloud-gateways`, `door-access`, `integrations`,
`physical-security`, `switching`, `wifi`) and `/uisp` is a separate top-level family. All eight are
server-rendered: each product is a card carrying `<h6>title</h6><p>SKU</p>` inside the escaped RSC
payload, next to a `href` to the product page. Read with `node scripts/ubiquiti-techspecs-census.js`
(added with this note), redirects never followed:

| route | HTTP | bytes | cards |
|---|---|---|---|
| `/unifi/accessories` | 200 | 816,361 | 18 |
| `/unifi/cloud-gateways` | 200 | 610,412 | 16 |
| `/unifi/door-access` | 200 | 706,784 | 61 |
| `/unifi/integrations` | 200 | 623,688 | 36 |
| `/unifi/physical-security` | 200 | 876,477 | 146 |
| `/unifi/switching` | 200 | 763,907 | 70 |
| `/unifi/wifi` | 200 | 665,417 | 47 |
| `/uisp` | 200 | 591,708 | 14 |
| **total** | | | **408 cards / 398 unique SKUs** |

Ten SKUs are listed in two grids (`UX7`, `ENVR`, `ENVR-Core`, `UNVR`, `UNVR-G2`, `UNVR-G2-Pro`,
`UNVR-Pro`, `UNVR-Instant`, `UNVR-Instant-Kit`, `USW-Mission-Critical`), which is why 408 cards are
398 SKUs. The duplicates are the same product on two category shelves, not two products.

## The absence, at SKU scale

Across all 398 SKUs:

| probe | cards |
|---|---|
| `UDW-PRO`, `UDWPRO`, `DW-PRO` (any case, `-` or `_`) | **0** |
| `UDW` | **1** - `Dream Wall` at `/unifi/cloud-gateways/udw` |
| `Dream Wall Pro` in any card title | **0** |

Eight cards carry a `Dream` title, and that is the whole line:

`UDM-Beast` (Dream Machine Beast), `UDM-Pro-Max`, `UDM-Pro`, `UDM-SE`, `UDR-5G-Max`, `UDR7`, `UDW`
(Dream Wall), `UDR`. All eight already resolve to a spec in `devices/ubiquiti/`
(`udm-beast.json`, `udm-pro-max.json`, `UDM-Pro.json`, `udm-se.json`, `udr-5g-max.json`, `udr7.json`,
`udw.json`, `udr.json`), so the Dream line is not "missing a member" in the catalogue either: the
ninth card that #130 asks for is absent from the vendor inventory, not from ours.

## Why an empty result here is about the product line, not the tile layout

**73 of the 398 SKUs carry a `-Pro` tier name**, and adjacent tiers are separate cards in the same
grid: `UDM-Beast`, `UDM-Pro`, `UDM-Pro-Max` and `UDM-SE` sit together in cloud-gateways; `U7-Pro`,
`U7-Pro-Max`, `U7-Pro-XG`, `U7-Pro-XG-Wall` and `U7-Pro-Outdoor` sit together in wifi; `UNVR-Pro` and
`UNVR-G2-Pro` sit beside `UNVR` and `UNVR-G2`. So a Pro Dream Wall would be a card
of its own in cloud-gateways, next to `UDW`, exactly as `UDM-Pro` sits next to `UDM`. It is not
there, and it is not anywhere else on the host.

## Traps, measured

- **`/unifi` and `/amplifi` are not families.** Both answer 200 (609,944 B and 609,946 B) and both
  render **the same sixteen cloud-gateway cards as `/unifi/cloud-gateways`** - card-for-card, in the
  same order. A census that trusted "200 + product cards" would count the gateway grid three times
  and invent an AmpliFi family; `/amplifi` is not a route Ubiquiti uses. Only fixed category paths
  are enumerated above.
- **Not-found is a redirect, and this pass re-measured it.** `/unifi/<category>/<unknown-slug>` - on
  cloud-gateways, integrations, switching, wifi and door-access alike - answers **307** with
  `Location: https://techspecs.ui.com/` and a 1-byte body (control: `.../cloud-gateways/bogus-xyz`
  identical; a real slug such as `udm-pro-max` is 200 / 677,375 B). `dl.ui.com/ds/<unknown>_ds.pdf`
  answers **302** to the techspecs root (controls `udw-pro_ds.pdf` and `bogus-xyz_ds.pdf` alike;
  real `udw_ds.pdf` 200 / 544,909 B). So `curl -L` turns every miss into a 200 on the site home
  page: judge on the final URL, never the status. The same redirects were already recorded in
  `research/open-device-requests.json` on 2026-11-18; three user agents were tried tonight and all
  three see the 307, so the "serves its 404s as 200" sentence in the November 17 comments is the
  stale reading, not this one.
- **There is no sitemap to enumerate.** `/robots.txt` and `/sitemap.xml` are 307s to `/`. The
  category grids are the only inventory, which is why they are hard-coded in the script rather than
  crawled.
- **Bytes drift, counts do not.** `/unifi/door-access` measured 706,555 B at 22:52 and 706,784 B at
  22:56 with the same 61 cards - CloudFront and a live build. Compare card counts across passes,
  not `content-length`.

## What this settles, and what it cannot

**Settles:** #130 is not hiding behind a category. No SKU on Ubiquiti's own spec site is a Dream
Wall Pro, on any shelf; the only Dream Wall there is `UDW`, which is catalogued and matches its page.

**Cannot settle:** anything about ports, and it does not close the issue. The card carries a title
and a SKU; a product that exists but has no spec card (the Early Access storefront is the remaining
gated surface) is outside this inventory. **No spec was written or changed by this pass.**

**Unblock, unchanged:** a Ubiquiti-hosted artefact - page, datasheet, quick-start, FCC exhibit,
storefront row, device-fingerprint record or a card in this census - naming `UDW-PRO` with a port
census, or the requester confirming the catalogued `UDW` was meant.
