# The storefront's product page carries a structured spec; its category page is an index that omits UDW

Measured 2026-11-20 07:2x-08:0x UTC on request #130 (Ubiquiti UDW-PRO), one increment. Everything below
was fetched with a desktop Chrome user-agent, redirects **not** followed, and is about the *shape* of
`store.ui.com` rather than about the Pro SKU - which is still absent from every surface, including these.

## 1. The storefront product page is a spec source, not just a shopping page

`https://store.ui.com/us/en/products/udw` - **200, 568,234 B**. Its `__NEXT_DATA__` blob is not the empty
SSG shell that `.../search` returns (`{"__N_SSG":true}` with `storeId`/`language` only). It carries
`props.pageProps.collection.products[]` with **one** object whose keys include `technicalSpecification`,
`documents`, `variants`, `historicalSlugs` and `displaySku`:

| field | value for the Dream Wall |
|--|--|
| `name` / `displaySku` | `UDW` / `UDW (420W)` |
| `historicalSlugs` | `dream-wall`, `dream-wall-ea`, `udw`, `unifi-dream-wall` |
| `documents` | `[{"type":"InstallationGuide","url":"https://dl.ui.com/qig/udw"}]` |
| `technicalSpecification` | `{template: "Cloud Gateways", sections: [...], hasCompareData: true}` |

`technicalSpecification.sections[].features[]` is the same `label` / `value` / `note` row structure
`techspecs.ui.com` serves, so for any product whose **slug is already known** the storefront is a second,
independently maintained vendor copy of its spec rows - useful as a cross-check, and it is the payload that
`dl.ui.com/qig/<slug>` and `dl.ui.com/ds/<slug>_ds.pdf` can be derived from.

## 2. `us/en/category/<slug>` is an enumerable index - of fifteen cloud gateways that omit UDW

`https://store.ui.com/us/en/category/cloud-gateways-wifi-integrated` - **200, 426,733 B** - embeds
`props.pageProps.subCategories[].products[]`, each product again with a full `technicalSpecification`. Five
sub-categories, **15 products**: EF-Core, EFG, UDM-Beast, UDM-Pro-Max, UDM-Pro, UDM-SE (180W), UCG-Fiber
(30W), UCG-Max, UCG-Ultra, UCG-Max-NS, UCG-Industrial (270W), UDR-5G-Max (15W), UDR7 (15W), UX7 (twice).

Two measured defects in it, both of which make it unusable as a negative:

- **UDW is not in the list**, although `.../products/udw` is 200 and its own `category.currentCategory.id`
  is `cloud-gateways-wifi-integrated`. A list that omits a product the store demonstrably sells cannot
  prove a second product absent.
- the same 15 come back for the mid-level `us/en/category/cloud-gateways-large-scale` (200, 426,232 B),
  so the route resolves the slug loosely rather than filtering by it; `us/en/category/cloud-gateways`
  itself is **307** to `/`.

There is no other enumeration: `us/en/collections/<any>` is **404** (204,478 B, the store's not-found
document, byte-identical for every miss - md5 `39388de6395c...` on both `udw-pro` shapes), `sitemap.xml`,
`robots.txt` and `us/en/sitemap.xml` are **307**, and `api/search`, `api/products`, `api/collection`,
`api/compare`, `api/sitemap` are all the same 404 body. `api/opensearch` is **200** but it is an
OpenSearch *description* document (502 B, `application/opensearchdescription+xml`) declaring
`https://store.ui.com/us/en/search?search={searchTerms}` - not a results API, and it ignores every
parameter tried.

## 3. What this does and does not change for #130

- `us/en/products/udw-pro` is **404** (204,478 B) with the same body as every other miss, against
  **200 / 568,234 B** for `udw`. That agrees with the nine-storefront sweep already on the issue, and
  against techspecs (`/unifi/cloud-gateways/udw-pro` is a 1-byte **307**) it is a cleaner instrument: a
  storefront miss is a 404, so `curl -L` cannot turn it into a hit.
- The UDW page mentions no Pro: zero occurrences of `udw-pro` / `UDW Pro` / `Dream Wall Pro`, and its
  `linkedProducts` is `[]` with `compatibleProducts` and `upsellProductCategories` `null` - so the page
  does not point at a sibling either.
- `.../search?search=UDW-PRO` is **200 / 261,056 B** and is byte-identical to `?search=zzzznotathing`, so
  a 200 on that route is the shell, not a hit. This is the trap `research/open-device-requests.json`
  already records for `design.ui.com`.
- Nothing here publishes a port count for a product that does not have a page, so **#130 stays blocked**
  on the same field set: RJ45 and SFP+ counts and rates, which are WAN, the PoE class mix and total
  budget, drive bays, cellular options.

## 4. Sources

`https://store.ui.com/us/en/products/udw` (200, 568,234 B), `https://store.ui.com/us/en/products/udw-pro`
(404, 204,478 B), `https://store.ui.com/us/en/category/cloud-gateways-wifi-integrated` (200, 426,733 B),
`https://store.ui.com/us/en/category/cloud-gateways-large-scale` (200, 426,232 B),
`https://store.ui.com/us/en/category/cloud-gateways` (307, 6 B), `https://store.ui.com/us/en/search?search=UDW-PRO`
(200, 261,056 B), `https://store.ui.com/api/opensearch?keyword=UDW` (200, 502 B,
`application/opensearchdescription+xml`), `https://store.ui.com/sitemap.xml` (307, 24 B).
