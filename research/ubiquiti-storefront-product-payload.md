# The storefront's product payload, and why a stored 404 hash cannot be a test

Request #130 (UDW-PRO) is blocked because Ubiquiti publishes nothing about the Pro. Every vendor
surface the thread had named by 2026-11-20 08:00Z was measured and empty: the tech-spec grids, the
nine regional storefronts, the FCC grantee census, the firmware platform codes, the design centre,
the login-walled Early-Access store, the quick-start guide. This note adds one surface those passes
read only as a *category list*, and one measurement method that replaces a stored hash.

Measured 2026-11-20 ~22:20Z, `Mozilla/5.0 (compatible; PacketForgeBot/1.0)` and re-run with a desktop
Chrome UA (identical results, so nothing here is UA-gated), redirects **not** followed:

| URL | status | bytes | md5 (12) | note |
|---|---|---|---|---|
| `https://store.ui.com/us/en/products/udw` | 200 | 568,234 | `b808763a2e6a` | live product page |
| `https://store.ui.com/us/en/pro/products/udw` | **308** | 39 | - | `Location: https://store.ui.com/us/en/products/udw` |
| `https://store.ui.com/us/en/products/udw-pro` | **404** | 213,322 | `9a7b2ea2a5bb` | served at the requested URL, no `Location` |
| `https://store.ui.com/us/en/products/xzqv-nonexistent-sku` | **404** | 213,322 | `9a7b2ea2a5bb` | **control**: same body, same size |
| `https://store.ui.com/products.json?limit=250` | **307** | 24 | - | `Location: https://store.ui.com/404` |

## 1. The control slug is the test, not the hash

Earlier passes recorded the storefront's not-found page as a fixed fingerprint - `204,478` bytes,
md5 `39388de6395c…` for two path shapes (2026-11-19/20). Today the same route family answers
**213,322** bytes, md5 `9a7b2ea2a5bb…`: the storefront was rebuilt in between, and its not-found shell
grew by 8,844 bytes. A pass that compared today's body against the stored hash would have read a
*difference* and gone looking for a product page that does not exist.

What is durable is the relation, measured in the same minute with the same UA: a slug that cannot
exist (`xzqv-nonexistent-sku`) and `udw-pro` return the **same 213,322-byte body**, while a slug that
does exist (`udw`) returns 200 with a 568,234-byte product page. So the 404 is a real status and a
real absence, not a soft 200, not a redirect, and not the techspecs fallback that lands on the site
front page. Procedure for the next pass:

```
curl -sS -o /dev/null -w '%{http_code} %{size_download}\n' \
  https://store.ui.com/us/en/products/udw-pro \
  https://store.ui.com/us/en/products/xzqv-nonexistent-sku
```

Also worth knowing: `/us/en/pro/products/udw` still answers **308** to the canonical route, 568,234 B.
The `/pro/` prefix is the path shape the Wayback-era store used, so a future pass that probes only
`/us/en/pro/products/…` is testing an alias, not a product tree.

And the store is not Shopify: `products.json`, `sitemap_products_1.xml` and
`collections/all/products.json` all 307/308 away (the last to `/us/en/collections/all`, which is
itself the 213,322-byte not-found page). There is no Shopify product API here to enumerate SKUs from;
the pages are Next.js (`motif-theme`, `assets.ecomm.ui.com`).

## 2. What the live product payload publishes (and it agrees with the row)

`/us/en/products/udw` carries `__NEXT_DATA__` → `props.pageProps.collection.products[0]`, a 101,575-byte
product object whose `technicalSpecification` is the same five-section table the tech-spec site renders.
Read today, it confirms `devices/ubiquiti/udw.json` field for field:

| vendor row | value | `udw.json` |
|---|---|---|
| 1 GbE RJ45 | 17 (4 PoE++; 4 PoE+; 4 PoE) at 1G/100M/10M | 17 `eth0`-`eth16`, 4/4/4 classes, `speedCaps` 1G/100M/10M |
| 2.5 GbE RJ45 | 1 at 2.5G/1G/100M | `wan1`, 2.5G, caps 2.5G/1G/100M |
| 10G SFP+ | 2 at 10G/1G | `sfp1`, `sfp2`, caps 10G/1G |
| PoE Budget | 420 W | `poe.budgetW` 420 |
| Max. Power Consumption | 112 W excluding PoE output | description 112 W (532 W with PoE) |
| Integrated WiFi | 5 GHz 4x4 2.4 Gbps, 2.4 GHz 2x2 300 Mbps, 8 BSSIDs/radio | `radio1` 2.4G/5 GHz, `radio0` 300M/2.4 GHz |

One vendor row has no port-level counterpart and should not be invented: **`Max. WAN Port Count = 8`**
with **`Default WAN Ports = (1) 2.5 GbE RJ45 / (1) 10G SFP+`**. The payload names a ceiling and the
shipped defaults, never which of the seventeen GbE ports may take the WAN role, so the row keeps the
default assignment (`wan1` as WAN, both cages `dualRole: ["wan","lan"]`) rather than marking all
seventeen copper ports WAN-capable - a guess that would let a lab cable nine uplinks the vendor caps
at eight.

## 3. Verdict for #130

No change to `devices/`; the Pro remains absent from the live storefront, now with a control-validated
404 at the requested URL and a desktop-UA re-run. The unblock is unchanged: a Ubiquiti page, datasheet,
FCC exhibit or quick-start guide naming UDW-PRO's ports and PoE budget, or the requester confirming
they meant the UDW that is already catalogued.
