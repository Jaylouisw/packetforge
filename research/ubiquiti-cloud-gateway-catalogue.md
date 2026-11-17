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
