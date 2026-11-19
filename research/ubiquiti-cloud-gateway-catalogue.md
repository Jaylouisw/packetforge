# Ubiquiti's own gateway index has one Dream Wall, and its SKU is UDW

#130 asks for a **UniFi Dream Wall Pro (UDW-PRO)**. Three passes have tried to read that product's
specs and each failed on a retrieval detail — `techspecs.ui.com/unifi/cloud-gateways/udw-pro`
redirects to the tech-spec home, `store.ui.com/us/en/products/udw-pro` is 404, and the one published
Dream Wall datasheet (`https://dl.ui.com/ds/udw_ds.pdf`, 544,909 B) describes the non-Pro UDW. Each
pass therefore recorded the blocker as *"Ubiquiti has not published this model's port layout yet"*,
which invites the next pass to keep looking. This note closes that framing: the model is not
unpublished, it is **absent from Ubiquiti's own product index**, and the index is readable.

## The index, read 2026-11-17

`https://techspecs.ui.com/unifi/cloud-gateways` — HTTP 200, 610,409 bytes, crawler user-agent, fully
server-rendered. It is the grid behind `category=all-cloud-gateways` and it prints every gateway
Ubiquiti sells as a card of the shape `<h6>title</h6><p class="...Sku...">SKU</p>`, each wrapped in a
link to `/unifi/cloud-gateways/<slug>?subcategory=all-cloud-gateways`.

Sixteen cards, sixteen slugs:

```
ef-core  efg  ucg-fiber  ucg-industrial  ucg-max  ucg-ultra
udm-beast  udm-pro  udm-pro-max  udm-se  udr  udr-5g-max  udr7  udw  ux  ux7
```

The Dream Wall card is:

> `<a class="...CardWrapper..." href="/unifi/cloud-gateways/udw?subcategory=all-cloud-gateways">`
> `<h6 class="...Title...">Dream Wall</h6>`
> `<p class="...Sku...">UDW</p>`

The string `udw-pro` occurs **zero** times in those 610,409 bytes, in the slug list, in the card
titles and in the SKU labels. The grid sits next to the Dream Router (`udr`) and the Dream Machine
line (`udm-pro`, `udm-pro-max`, `udm-se`, `udm-beast`), so this is the page a Pro-tier Dream Wall
would appear on; the Pro suffixes that do exist — `udm-pro`, `udm-pro-max` — are the naming pattern
Ubiquiti actually uses.

## Why this is a different finding from the 404s

A 404 on `/products/udw-pro` is a fact about one URL: it can mean a retired page, a locale-specific
slug or a redirect chain. An absence from the category grid is a fact about the **catalogue**: the
grid is the store's own product source, so a SKU that is not in it is a SKU Ubiquiti does not list
for sale, under any slug. Three passes of URL-by-URL probing could not distinguish those two cases;
this page does.

## Trap: the store's search page cannot be used either way

`https://store.ui.com/us/en/search?q=dream+wall` answers HTTP 200, 252,278 bytes, and contains
**zero** occurrences of "dream wall" — the results are rendered client-side. Its emptiness is not
evidence of absence and its 200 is not evidence of presence. Recorded so the next pass does not
read a JS shell as a result.

## The base model is already in the catalogue, and it matches the vendor

`devices/ubiquiti/udw.json` (`UniFi Dream Wall`, sourceUrl
`https://techspecs.ui.com/unifi/cloud-gateways/udw`) models 19 ports. Against the same page read
today (704,702 bytes):

| vendor row (`Port Layout`) | catalogue |
|---|---|
| 1 GbE RJ45 — 17 (4 PoE++; 4 PoE+; 4 PoE), 1G/100M/10M | `eth0`–`eth3` PoE++, `eth4`–`eth7` PoE+, `eth8`–`eth11` PoE, `eth12`–`eth16` plain — 17 total |
| 2.5 GbE RJ45 — 1 (2.5G/1G/100M) | `eth17`, 2.5G with 1G/100M caps |
| 10G SFP+ — 2 (10G/1G) | `sfp1`, `sfp2`, 10G with 1G caps |

The page also prints `PoE Budget 420W` and `Max. Power Consumption 112W (Excluding PoE output)`;
the spec's description carries the 112 W figure, which is the unit's own draw, not the PoE budget.
So under either reading of #130 there is no catalogue gap to fill: the box that exists is modelled
correctly, and the box that does not exist cannot be.

## What would unblock #130

1. Any Ubiquiti-hosted URL naming a Pro Dream Wall — a store slug, a `techspecs` page, a
   `dl.ui.com/ds/udw-pro_ds.pdf`, or the unit's quick-start guide.
2. Or the requester saying they meant the UDW, which is already catalogued above.

Until one of those arrives, writing `UDW-PRO` from UDW's numbers is the family-sibling error this
project has corrected three times (a phantom UDM PoE draw, a phantom console port on two i-MO kits,
invented copper uplinks on three MA5801s). The request stays open.

## The last three "maybe it is sold somewhere" surfaces, checked and empty (2026-11-17)

Sections above settle that `udw-pro` is absent from Ubiquiti's own gateway index, that
`techspecs.ui.com/unifi/cloud-gateways/udw-pro` redirects to the site root and that
`store.ui.com/us/en/products/udw-pro` is a 404. That leaves three ways a real product could still
be hiding: sold in another region, certified but not listed, or once listed and since removed. All
three were checked this pass, and all three are empty.

**1. The EU store lists one Dream Wall, and it is the UDW.**
`https://eu.store.ui.com/eu/en/category/all-cloud-gateways` - HTTP 200, 487,282 B, crawler
user-agent, server-rendered. The cloud-gateway grid carries `Dream Wall UDW (420W)` with SKU
`udw-eu`; the string `udw-pro` occurs **zero** times in those 487,282 bytes (the only `udw` tokens
are `udw`, `UDW`, `udw-eu`, `UDW-EU`, `uDWa-d` from a CSS class). So the Pro is not a regional SKU
either - the one non-US variant the storefront publishes is the 420 W PoE build of the UDW.

**2. No FCC certification record exists for any Pro variant.**
Ubiquiti's grantee prefix is `SWX`, so a shipping console must hold a grant there:

| FCC ID | `fccid.io` result |
|---|---|
| `SWX-UDW` | **200**, 83,318 B - *UDW, Digital Transmission Radio, Ubiquiti Inc* |
| `SWX-UDWPRO` | **303** (no such grant) |
| `SWX-UDW-PRO` | **303** |
| `SWX-UDW2` | **303** |

A radio device that has never been certified cannot have been sold, which is the mechanism behind
the empty techspecs and store surfaces rather than a separate fact. (`fcc.report/FCC-ID/SWX-UDW`
answers 403 to a crawler; `fccid.io` is the readable mirror and is a mirror, so this is strong
evidence, not the Commission's own index.)

**3. No archived Ubiquiti page can be recovered either.**
`http://archive.org/wayback/available` returns `"archived_snapshots": {}` for all four URLs that
would have carried the Pro: `techspecs.ui.com/unifi/cloud-gateways/udw-pro`,
`store.ui.com/us/en/products/udw-pro`, `store.ui.com/products/udw-pro` and
`ui.com/unifi/cloud-gateways/udw-pro`. Nothing was ever crawled, so there is no withdrawn page to
read.

**The one vendor-authored sentence that names a Pro, and what it does not say.** Ubiquiti's
early-access store copy, quoted on
`https://ubiquiti-networks-forum.de/board/thread/4925-ea-store-eu-dream-wall-early-access/`, reads
*"The Dream Wall and Dream Wall Pro (UDW/UDW Pro) are wall-mounted UniFi OS Consoles that serve as
standalone, space-saving deployment hosting solutions."* It names the pair and nothing else: the
feature list printed immediately below it is the **UDW's** (17 GbE RJ45 with 4 PoE++/4 PoE+/4 PoE,
2.5 GbE WAN, 10G SFP+ WAN and LAN), and the same post shows *"Dream Wall Pro - Coming Soon"*. So
the Pro was announced, never listed, and has no port census anywhere - which is a different and
stronger statement than "Ubiquiti has not published the layout yet".

This changes nothing about the blocker and closes three avenues: **#130** stays open, and the next
pass should not re-check the EU storefront, the FCC grant index or Wayback.

## Surface 4: the device-fingerprint index — machine-readable, and regenerated the same evening

Read 2026-11-19 22:2x UTC: `https://static.ui.com/fingerprint/ui/public.json` — HTTP/2 **200**,
`content-type: application/json`, `content-length: 832585`, `last-modified: Thu, 19 Nov 2026
17:40:52 GMT`, `sha256 f8dd439503e37a2c32b94e63727eba570fca58252e0e78cf8c323b49291d03ee`. This is
not a web page but the record set Ubiquiti's controllers use to recognise a device they adopt: 701
device records, each carrying `sku`, `sysid`, `product.name`, `fcc`, `ic`, `deviceType` and
`compliance.modelName`.

The complete Dream line in that file:

| `sku` | `product.name` |
|---|---|
| UDM | Dream Machine |
| UDM-Beast | Dream Machine Beast |
| UDM-Pro | Dream Machine Pro |
| UDM-Pro-Max | Dream Machine Pro Max |
| UDM-SE | Dream Machine Special Edition |
| UDR | Dream Router |
| UDR-5G-Max | Dream Router 5G Max |
| UDR7 | Dream Router 7 |
| UDW | Dream Wall |

One Dream Wall: `sku: UDW`, `sysid: ea2a`, `fcc: SWX-UDW`, `ic: 6545A-UDW`, `deviceType: console`,
`compliance.modelName: "UDW"`. `udw-?pro` occurs **zero** times in the 832,585 bytes, and the
case-sensitive `UDW Pro` also zero.

**Why this is a different and stronger surface than the three already recorded.** The techspecs grid
is HTML that a locale slug or a retired card can perturb; the storefront is a merchandising view; the
FCC index is a mirror. The fingerprint file is the identity list a controller consults at adoption,
and it already carries *every Pro tier Ubiquiti ships* — `UDM-Pro` and `UDM-Pro-Max` sit two rows
from `UDW`. It is also current: `last-modified` is 17:40Z today, about five hours before this read,
so "the Pro has not been added yet" would have to mean added after an index that already lists
`UDR7` and `UDM-Beast`.

**Trap, stated so it is not over-read.** `public.json` enumerates devices a controller can adopt; it
is not a roadmap. Its emptiness is evidence that no Pro SKU is adoptable anywhere, which is
consistent with — not independent of — the early-access "Dream Wall Pro — Coming Soon" post quoted
above. It does not prove no Pro unit was ever built.

**What this pass did not do.** No spec was written, and `devices/ubiquiti/udw.json` was not touched:
the base model already matches the vendor page row for row (17x 1 GbE RJ45 in a 4/4/4 PoE split with
10M rungs, 1x 2.5G, 2x 10G SFP+ at 10G/1G, 420 W budget). For the requirement in #130 there is also a
shipping cellular gateway already in the catalogue — `devices/ubiquiti/udr-5g-max.json`
(`wwan0` 3.4G, 4x 2.5G + 1x 10G SFP+, 15.4 W PoE) — which is the device to reach for if the need was
"a routed lab with a cellular WAN" rather than the Pro chassis specifically.
