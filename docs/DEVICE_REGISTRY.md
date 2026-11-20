# Device Registry

**Adding any manufacturer / hardware model is a data change, not a code change.**

Every device is a JSON file under `devices/<vendor>/`. The registry
(`devices/registry.js`) scans the tree, loads every `.json`, and exposes the
catalog to the API and the UI palette.

## Schema

```json
{
  "vendor": "cisco",
  "model": "ISR4321",
  "label": "ISR 4321 Router",
  "category": "router",
  "description": "Cisco ISR 4321 — 2x GE WAN, 1x GE LAN.",
  "capabilities": ["l3-forward", "cli", "dhcp-server", "nat"],
  "portTemplate": { "prefix": "Gi0/0/", "start": 0, "count": 3, "type": "ethernet", "speed": "1G" },
  "icon": "router",
  "color": "#f43f5e"
}
```

| Field | Required | Notes |
|-------|----------|-------|
| `vendor` | yes | lowercase manufacturer slug |
| `model` | yes | unique per vendor |
| `label` | yes | human-friendly name shown in the palette |
| `category` | yes | `router`, `switch`, `l3-switch`, `firewall`, `ap`, `tap`, `host`, `server`, `wireless`, `ptp`, `cloud`, `olt`, `ont`, `splitter`, `modem`, `powerline`, `nas`, `desktop`, `laptop`, `phone`, `tablet`, `printer`, `camera`, `nvr`, `iot` |


### Taps and passive hardware

`category: "tap"` covers network taps and packet brokers. Two things distinguish them.

**An active tap** (a packet broker: GigaVAVE VUE, Keysight Vision, Garland AA10G54AC) is a
device with software: it carries `l2-forward`, aggregates, filters, and behaves like a switch.

**A passive tap** carries `"passive": true` and **no capabilities at all**, because there is
nothing inside it to have capabilities with. The data path gives it exactly one behaviour:

- a frame arriving on a `net*` port is passed through to the other `net*` ports unchanged,
- and a copy is emitted on every `mon*` port,
- a frame arriving on a `mon*` port is discarded (`tap-inject-refused`), because a tap is a
  one-way street with a copy, not a hub,
- nothing is learned: a passive tap has no table.

Getting the category wrong is not cosmetic. Before this existed, the passive taps were filed
as `category: "firewall"` with an empty capability list, which the engine reads as "drops
everything" - so inserting a tap into a lab cut the link it was inserted into, and no test
noticed, because a link carrying nothing looks like a link with nothing to carry.
| `capabilities` | yes | drives the engine — see below |
| `interfaces` | one of | explicit array of `{name,type,speed}` |
| `portTemplate` | one of | generates N ports: `{prefix,start,count,type,speed}` |
| `description` | no | tooltip |
| `icon` | no | one of the built-in icons (or any emoji) |
| `color` | no | accent color (hex) |

## Capabilities

`host`, `l2-forward`, `l3-forward`, `cli`, `dhcp-server`, `dhcp-client`,
`nat`, `firewall`, `wireless`, `http-server`.

The engine branches on capabilities only. So:

- a **PC** is `["host","cli","dhcp-client"]`,
- an **L2 switch** is `["l2-forward","cli"]`,
- a **router** is `["l3-forward","cli","nat","dhcp-server"]`,
- an **L3 switch** is `["l2-forward","l3-forward","cli"]`.

### PoE: powered, powering, or both

`poe-pd` means the device is powered by PoE. `poe-pse` means it supplies PoE, which
also needs `poeOut` (and `poeOutClass`) on the port that does it.

A device may legitimately declare **both** — that is a passthrough port, an Access
hub powering a reader or a switch feeding a downstream AP. When it does, the
description must say so, because `spec-vs-description` checks the prose against the
ports and will not take the capability list as evidence:

```json
"description": "UniFi Door Hub (UA-Hub-Door) - 5x 1G RJ45 (1x PoE++ passthrough). 802.3bt PoE-in; 30 W max."
```

"Says PoE-in" and nothing else, with a `poeOut` port, is the failure. Naming the
passthrough port is the fix — do not drop `poeOut` to silence the check, and do not
add the device to the test's `KNOWN` list, which is debt for specs that genuinely
cannot be adjudicated.

## Explicit interfaces vs. port templates

```json
"interfaces": [
  { "name": "eth0", "type": "ethernet", "speed": "1G" },
  { "name": "sfp-sfpplus1", "type": "ethernet", "speed": "10G" }
]
```

```json
"portTemplate": { "prefix": "Fa0/", "start": 1, "count": 24, "type": "ethernet", "speed": "100M" }
```

The template expands to `Fa0/1 … Fa0/24`. Use `start: 0` for Cisco-style
zero-based ports (`Gi0/0/0`).

### Optical cages

A port is copper RJ45 unless you say otherwise. For an optical port set
`connector` — `sfp`, `sfp+`, `sfp28`, `qsfp+` or `qsfp28` — and give the speeds
the cage accepts in `speedCaps`:

```json
{ "name": "Gi1/1/1", "type": "ethernet", "speed": "10G",
  "connector": "sfp+", "speedCaps": [1000, 10000] }
```

Getting this wrong is the most common spec bug: a switch described as having
SFP+ uplinks but modelled with all-copper ports will *refuse* a fibre link that
the real hardware accepts, and *offer* copper where it does not fit. CI checks
every description against the ports it declares.

**The connector has to carry the speed you declare.** A cage cannot be faster than
its own standard, so `speed` above the cage's ceiling is a spec bug even when the
device really is that fast — the mistake is the connector string, not the number:

| `connector` | carries up to |
|---|---|
| `sfp` | 2.5G |
| `sfp+` | 10G |
| `sfp28` | 25G |
| `qsfp+` | 40G |
| `qsfp28` | 100G |

So a device with a 10G uplink is `"connector": "sfp+"`, never `"sfp"` with
`"speed": "10G"`. That single mistake has reached `main` twice — twenty devices in
total — because "SFP" is how the vendor's marketing copy says it and the JSON field
looks like it should match. `hardware-invariants` fails on it.

### PON ports and ferrule polish

PON is the one place the connector belongs to the medium rather than the cage: the
same OLT port takes an `SC/APC` or an `SC/UPC` module, and the two are **not**
intermateable. Model a PON port with `connector: "sc-apc"` (or `sc-upc`) and type
`pon`:

```json
{ "name": "gpon0/1", "type": "pon", "speed": "2.5G", "connector": "sc-apc" }
```

A port named `pon`, `pon1`, `gpon0/1`, `xgspon…` infers `sc-apc` automatically,
because that is the green angled ferrule virtually every OLT and ONT ships with.
Say `sc-upc` explicitly if the hardware really has the flat blue one.

| Connector | Ferrule | Polish | Colour | Mates with |
|---|---|---|---|---|
| `sc-apc` | SC | APC, angled 8° | green | `sc-apc` only |
| `sc-upc` | SC | UPC, flat | blue | `sc-upc` only |
| `lc` | LC | UPC, flat | blue | `lc` |
| `mpo` | MPO | UPC, flat | aqua | `mpo` |

An SC/APC pushed into an SC/UPC socket is refused with `E_POLISH_MISMATCH`,
naming both polishes: the angled endface does not seat, costs about 3 dB, and can
chip the face. It is a different verdict from `E_CONNECTOR_MISMATCH` (wrong shape
entirely, e.g. LC into SC) because "you have the wrong polish" is a fixable
mistake and "these two things cannot ever connect" is not.

PON media carry their real line rates: GPON is 2.488 Gbit/s down over 1.244 up,
XGS-PON is symmetric 9.953. A GPON port against an XGS-PON port negotiates down to
GPON rates rather than failing, which is what a GPON OLT does with an older ONT.

### Combo ports

Some hardware (common on Cisco, HPE, Huawei and Juniper) has a **combo** cage: one
physical port position that accepts either an RJ45 plug or an SFP module, never
both at once. Model it as two interfaces that name each other:

```json
{ "name": "Gi0/0/3", "type": "ethernet", "speed": "1G",
  "comboWith": "Gi0/0/3-sfp", "comboRole": "rj45" },
{ "name": "Gi0/0/3-sfp", "type": "ethernet", "speed": "1G", "connector": "sfp",
  "speedCaps": [1000], "comboWith": "Gi0/0/3", "comboRole": "sfp" }
```

Both halves accept a cable on their own, in their own medium. Once one is
cabled, the other is refused with `E_COMBO_OCCUPIED` naming the port in use, so
a lab cannot plug two links into one cage. Pull the cable and the sibling frees
up again. `AR2220` is the reference implementation.

Because a combo port costs two interfaces, a device with combo ports has *more*
interfaces than physical ports — that is correct, not a miscount.

## Example: adding a new vendor

To add a "Northbound NFX-9000" router, create
`devices/northbound/nfx9000.json`:

```json
{
  "vendor": "northbound",
  "model": "NFX9000",
  "label": "NFX-9000 Core Router",
  "category": "router",
  "description": "Northbound NFX-9000 — 8x 100G.",
  "capabilities": ["l3-forward", "cli", "nat"],
  "portTemplate": { "prefix": "xe-0/0/", "start": 0, "count": 8, "type": "ethernet", "speed": "100G" },
  "icon": "router",
  "color": "#a855f7"
}
```

Restart the server (or hit the catalog endpoint) and the model appears in the
palette, fully simulated — no other changes required.

## When a spec is wrong

A spec that cannot describe a device does **not** disappear, and it does **not** get quietly
repaired. It becomes an entry in the catalogue marked `vendor: "error"` whose `error` field names the
file and says what is wrong:

| the file | what the loader says |
|---|---|
| truncated JSON | `.../acme/box.json: Unexpected end of JSON input` |
| `"interfaces": "nope"` | `"interfaces" must be an array of ports, not string` |
| `"interfaces": []` with no template | `has an empty "interfaces" array and no "portTemplate"` |
| `"interfaces": [null]` | `port #1 has no "name" string - a port with no name cannot be cabled` |
| `"portTemplate": { "count": 0 }` | `"portTemplate.count" must be a positive whole number, got 0` |
| no `model` | `has no "model" field, so it cannot be identified` |
| no ports declared at all | `declares no ports: it needs "interfaces" or a "portTemplate"` |
| a JSON array | `is not a JSON object` |

Three of those used to load as ordinary devices. A string `interfaces` produced four invented ports
from the default template, a `count` of `0` or `-5` produced exactly one invented port, and a file
with no `model` was dropped in silence. Each one looked like a working device on the canvas and was
discovered by whoever tried to cable to it.

The loader also re-reads files rather than caching them, so a spec corrected on disk is picked up
without restarting the server.

`test/fuzz-importer.test.js` holds all of this in place: it mutates a real spec four hundred ways with
a seeded PRNG and asserts the two invariants that must never bend — the loader never throws, and every
entry it returns is either a device with at least one named port or an error that names the file.

## What is in the catalogue

**2,351 models across 258 vendors**, and it grows every time somebody's hardware is
added. The largest vendors and categories by model count, in descending order:

| vendor | models | | category | models |
|---|---:|---|---|---:|
| Ubiquiti | 367 | | switch | 429 |
| MikroTik | 362 | | router | 383 |
| Huawei | 102 | | L3 switch | 264 |
| Cisco | 89 | | wireless | 215 |
| Teltonika | 88 | | point-to-point | 212 |
| Aruba | 73 | | IoT | 125 |
| Peplink | 59 | | ONT | 120 |
| TP-Link | 57 | | | |
| NETGEAR | 52 | | | |

The authoritative list is not this page — it is the directory. `GET /api/catalog` returns
every spec the running server has loaded, with the category groupings the palette uses,
and `GET /api/requests` returns the hardware people have asked for that is not here yet.

If a number here disagrees with the directory, the directory is right; this section is
prose and prose goes stale. `npm run regen:registry-doc` rewrites those counts in place
and never moves a row, so the order above is an editor's to keep when a vendor overtakes
another.

<!-- open-requests:start -->
## What is left open, and why

Two hardware requests are open and cannot be modelled yet.
Not one of them is blocked on research effort: in every case the vendor publishes the
field *type* and not its *value*, and the value is what a spec needs. This table is
generated from `research/open-device-requests.json` - `npm run regen:registry-doc` after
editing it, and the issue threads stay the place where each one is argued. Every row
below carries the `blocked-on-build` label on its issue, which is what stops
`node scripts/request-queue.js` from counting it ready.

| issue | model(s) | the field the vendor does not publish | what would unblock it |
|---:|---|---|---|
| 130 | Ubiquiti UniFi Dream Wall Pro (UDW-PRO) | the whole port layout, and the product itself: the SKU is not in Ubiquiti's cloud-gateway index (`udw-pro` occurs zero times in it - 610,409 B when the index was counted on 2026-11-17, 610,412 B today), `techspecs.ui.com/unifi/cloud-gateways/udw-pro` answers **307** with `Location: /` and a 1-byte body while `dl.ui.com/ds/udw-pro_ds.pdf` answers **302** to the techspecs root, so both land on the 609,911-byte site front page instead of a product page (re-measured 2026-11-18 without following redirects: the pages that exist do not redirect - the UDW tech-spec page is 704,702 B, its datasheet 544,909 B - and the earlier "serves its 404s as 200s" reading was a followed redirect), and `store.ui.com/.../udw-pro` is a 404. Three further surfaces were checked and are empty (2026-11-17): the EU storefront publishes only `udw-eu`, the 420 W UDW; no FCC grant exists under `SWX-UDWPRO`, `SWX-UDW-PRO` or `SWX-UDW2` (all 303, against 200 for `SWX-UDW`); and Wayback holds no capture of any of the four `udw-pro` URLs. A sentence quoted around this issue as Ubiquiti's early-access copy - "the Dream Wall and Dream Wall Pro (UDW/UDW Pro)" beside "Dream Wall Pro - Coming Soon" - has no Ubiquiti-hosted URL: its only citation is the third-party forum https://ubiquiti-networks-forum.de/board/thread/4925-ea-store-eu-dream-wall-early-access/, and Wayback holds no 2022 capture of any store.ui.com udw page (earliest 2023-06-03) or any ui.com dream-wall page (earliest 2023-10-18), so the Early-Access page that supposedly said it was never crawled. It is a forum reprint of a deleted page and is recorded here as such, not as vendor copy. The published datasheet `dl.ui.com/ds/udw_ds.pdf` is the non-Pro Dream Wall. Re-checked 2026-11-18: the cloud-gateway index is unchanged at 610,412 B with sixteen cards and zero occurrences of `udw-pro`; the techspecs front page the two Pro URLs land on is byte-identical to the bare root (md5 `5bec75c89b40d2283b11ac5397d85af1`, 609,911 B), so a 200 there is not evidence of a page. Also enumerated 2026-11-18 rather than sampled: the whole grantee code, `https://fccid.io/SWX`, is five server-rendered pages (30,975 / 30,185 / 29,647 / 29,861 / 17,622 B, all 200) and yields 432 unique grants from `SWX-AP1R2` 2005-02-18 to `SWX-USLAK` 2026-10-29, in which the only Dream Wall is `SWX-UDW` 2022-05-31 - while `SWX-UDMPRO`, `SWX-UDMPM`, `SWX-UDMPROSE` and `SWX-UXGPRO` show that Ubiquiti does list Pro variants as their own grants, and `SWX-UDW`'s own page (83,318 B) holds four application IDs all `Original Equipment` and no permissive change, so no Pro hides inside the parent grant. The store tree was enumerated too, which the earlier sweeps had not done: `store.ui.com/us/en/pro/products/` (234 archived URLs) and `store.ui.com/us/en/products/` filtered to `udw` hold only `udw`, `udw?variant=udw-us` (captured 2026-04-28, so the crawl is live) and the accessory `uacc-psu-udw`, with no `udw-pro` in any spelling or year. Caveat recorded: a radio-identical variant could in principle ship under a Class II permissive change, so this rules out a filed authorization, not the existence of the product; and a grant publishes frequencies, never port counts. research/ubiquiti-swx-grantee-census.md.  Then, 2026-11-19, the surface no earlier pass had read: Ubiquiti's own firmware index, `https://fw-update.ubnt.com/api/firmware?limit=1000&filter=eq~~product~~unifi-dream` -> HTTP 200, **340 releases across 17 platform codes** (`UDM`, `UDMPRO`, `UDMPROSE`, `UDMPROMAX`, `UDR`, `UDR5G`, `UDR7`, `UDRULT`, `UDW`, `UX`, `UXMAX`, `UCGF`, `UCGMAX`, `UCGA6AD`, `EFGCORE`, `UDMENT`, `UDMEA4C`), with `UDW` at 27 releases from 2022-05-07 to 2026-11-10 (latest `v6.0.17+7bcad58`, binary `/data/unifi-dream/2d04-UDW-6.0.17-…bin`) and **no `UDWPRO`**: the spellings `UDWPRO`, `UDW-PRO`, `UDWPROMAX`, `UDW2`, `UDWSE`, `UDWMAX` each return the 96-byte 0-release envelope, the same answer as the nonsense control `ZZZZ`, while `UDMPRO` returns 65, `UDMPROSE` 40 and `UDMPROMAX` 20 - three near-identical consoles that nevertheless carry three separate platform codes, which is why a shipped Pro Dream Wall would have its own. Caveat: a rebadged variant sharing the parent mainboard could hide under the `UDW` code, and no firmware index publishes port counts. research/ubiquiti-firmware-platform-census.md.  Then, 2026-11-19 (02:5x-03:1x UT): the Next.js build manifest https://techspecs.ui.com/_next/static/O4loEueJJ_fzZc5I2r7Ta/_buildManifest.js (200, 3,349 B) shows every product path is a dynamic route (`/[productLine]/[category]/[product]`) over 13 `sortedPages`, so no static route list exists to enumerate - but it exposed `/compliance/chile/[[...sku]]`, a SKU-keyed SUBTEL register, which is the first sub-tree on this host that answers a real 404 for a SKU it does not have: `.../compliance/chile/udw` 200, 615,226 B (names Dream Wall, UDW, UDW-EU) against `.../compliance/chile/udw-pro` and `.../compliance/chile/udwpro` 404, 512,657 B "This page could not be found" (index `.../compliance/chile` 200, 549,642 B; `.../compliance/udw` without a locale 307 to `/`). The Pro is absent from it. Also re-confirmed the UDW census off techspecs for the first time: the archived collection page https://web.archive.org/web/20230603042814/https://store.ui.com/us/en/collections/unifi-dream-wall/products/udw (200, 124,982 B) prints the family as Dream Wall / Dream Machine / Dream Router only, and the box as "(17) LAN: GbE RJ45 ports, (1) WAN: 2.5 GbE RJ45 port, (1) LAN: 10G SFP+ port, (1) WAN: 10G SFP+ port, PoE (4) PoE, (4) PoE+, (4) PoE++", with zero occurrences of "Dream Wall Pro", "udw-pro" or "Coming Soon" - matching devices/ubiquiti/udw.json exactly (20 interfaces), so no spec change. research/ubiquiti-udw-pro-absent-from-vendor-catalogue.md. Re-checked 2026-11-19 03:2x UT on the two surfaces earlier passes named but never resolved. (1) The storefront list is published by the page itself: `techspecs.ui.com/unifi/cloud-gateways/udw` carries `props.pageProps.product.alternativeStores` naming all nine storefronts for the SKU - br, ca, eu, jp, me, mx, tw, uk, us - and `/{store}/en/products/udw-pro` is 404 on every one (byte-identical 204,279 B not-found shell, md5 346734f60828bb9d80819a8092b2d291 on us/eu/tw) while the control `/{store}/en/products/udw` is 200 on all nine (492,349-589,781 B; the non-US hosts 307 from store.ui.com to {store}.store.ui.com, which is routing, not a miss). So "not a regional SKU" no longer rests on the US and EU category grids. (2) The document key pattern comes from the product's own `documents` field, `{"type":"InstallationGuide","url":"https://dl.ui.com/qig/udw"}`: `dl.ui.com/qig/udw.pdf` is 200, application/pdf, 8,279,805 B, so `qig/udw-pro.pdf` and `qig/udwpro.pdf` answering the 302-to-techspecs-root fallback (same as `qig/bogus-xyz.pdf`) is a tested negative instead of an untried guess, and `qig/udw-eu.pdf` missing shows the key is per SKU, not per region. That QIG is also the end of the quick-start hope as a text source: one page of Adobe Illustrator 28.0 artwork with zero BT/Tj/TJ operators in its five content streams and no /ActualText - every label is outlined - so a Pro QIG, if Ubiquiti ever published one, would have to be read by eye. The vendor's machine-readable `technicalSpecification` for the UDW (PoE Budget 420W, 112W max excluding PoE, Default WAN Ports (1) 2.5 GbE RJ45 + (1) 10G SFP+, Max. WAN Port Count 8) still agrees with devices/ubiquiti/udw.json, so no spec change. research/ubiquiti-udw-pro-absent-from-vendor-catalogue.md. Then, 2026-11-19 (03:5x UT), two Ubiquiti hosts no pass had read. (1) The marketing family page `https://ui.com/cloud-gateways` (200, 446,725 B) carries a schema.org `ItemList` naming 14 gateways with their techspec URLs - items 4 and 6 are `Dream Machine Pro Max` and `Dream Machine Pro`, item 13 is `Dream Wall` -> `/udw` - and `udw-pro` / `Dream Wall Pro` occur zero times; caveat: the list is curated (14 of the techspecs grid's 16, omitting `udr` and `ux`), so it corroborates rather than enumerates. (2) The support knowledge base is Zendesk, so its index is public: `help.ui.com/api/v2/help_center/articles/search.json?query=` for `dream wall pro`, `udw-pro` and `udw` returns 200 at 728,119 / 719,384 / 364,696 B (counts 33 / 105 / 13), 73 rows and 50 unique articles, in which `Dream Wall Pro`, `UDW-PRO` and `UDWPRO` occur zero times - the Dream Wall appears only as `Dream Wall (UDW)` (Consoles with Access Support; SD-WAN with Site Manager; Upgrading to UID Enterprise, which marks the UDW itself `(EA)`; Recovery Mode). Control: the same endpoint for `udm-pro` returns 1,737,208 B and 100 of 118 rows carrying `UDM-PRO` 39 times and `Dream Machine Pro` 18 times, so the index does hold Pro-suffixed names. Also recorded as a trap: `ui.com/robots.txt` declares `https://ui.com/sitemap.xml`, which is real (200, 8,712 B, 81 locs) but indexes sections, not SKUs (`/cloud-gateways`, `/how-it-works/...`, zero `dream`), so it cannot be cited as a negative either way. research/ubiquiti-udw-pro-absent-from-vendor-catalogue.md. Then, 2026-11-19 (07:5x UT), the one Ubiquiti host no pass had read: the UniFi Design Center, `https://design.ui.com/`. It is a client-rendered SPA - `/`, `/api/devices`, `/api/v1/devices`, `/api/models`, `/api/v1/models`, `/api/products`, `/api/catalog` and `/api/model-list` all answer 200 with the identical 8,107-byte `text/html` router shell - and neither the loader `/assets/index-Dhm9edlX.js` (200, 27,897 B) nor `/assets/Main-Dq_3TtAr.js` (200, 220,557 B) names a model endpoint (the developer pages, e.g. `/assets/DeveloperModelsPage-DG8YuRfL.js`, are 1,601-byte stubs), so the device library behind it is not reachable anonymously. Trap recorded: on this host a 200 is the SPA, not a page, so its silence cannot be cited as a negative - the same shape as the client-rendered `store.ui.com/us/en/search` result noted above. **Gated, not empty (2026-11-19):** `ea.store.ui.com` - the Early Access storefront, the channel that carries an announced-but-unpublished console, and the one whose slug `dream-wall-ea` is already on the UDW's own record - is **deployed and login-walled**: every path including `/_next/static/` answers 302 to `account.ui.com/login` with the path preserved, while `/favicon.ico` is 200/5,430 B, so the app is up and unreadable anonymously; its certificate is `CN=*.ui.com`, which cannot cover the two-label host, so a TLS error there is a certificate gap and not a dead host. The EA `storeId` is behind the same gate: `ea`, `ea-us` and `us-ea` each answer one masked validation error for the `udw` control, so they are rejected ids and not product misses. A credentialed read of that storefront, or the requester naming the SKU meant, is the remaining unblock. Then, 2026-11-19 (22:5x UT), the inventory rather than one shelf: all eight `techspecs.ui.com` product grids read with `node scripts/ubiquiti-techspecs-census.js` (redirects not followed) - accessories 18, cloud-gateways 16, door-access 61, integrations 36, physical-security 146, switching 70, wifi 47, `/uisp` 14 - give **408 cards / 398 unique SKUs** in which exactly one is a Dream Wall (`UDW`, `/unifi/cloud-gateways/udw`) and none matches `UDW-PRO`/`UDWPRO`, while **73 SKUs are `-Pro` tiers** whose neighbours are separate cards (`UDM-Pro`, `UDM-Pro-Max` beside `UDM-Beast`/`UDM-SE`; `U7-Pro-Max`, `U7-Pro-XG-Wall` in wifi). So the absence is not a category-placement miss - which was the one gap left by the earlier single-grid reads, given the Mobile Router sits under `/unifi/integrations/`. Trap recorded: `/unifi` and `/amplifi` both answer 200 and render the same sixteen cloud-gateway cards as `/unifi/cloud-gateways`, so a census that trusted "200 plus cards" would count that grid three times and invent an AmpliFi family. research/ubiquiti-udw-pro-techspecs-slug-census.md. Then, 2026-11-20 (07:2x-08:0x UT), the storefront's own route map rather than one slug: `store.ui.com/us/en/category/<slug>` embeds `subCategories[].products[]` - 15 cloud-gateway products, each with a full `technicalSpecification` (label/value rows) - but the list **omits the UDW itself**, whose page 200s and whose `category.currentCategory.id` is that same category, and the same 15 come back for a different slug, so it cannot be cited as a negative; `us/en/collections/*`, `api/search`, `api/products`, `api/collection`, `api/compare` and `us/en/products/*` misses all return one 204,478-byte not-found body, `sitemap.xml`/`robots.txt` are 307, and `api/opensearch` is a 502-byte OpenSearch *description* document, not a results API. `us/en/products/udw-pro` is still 404 (that same 204,478 B body, md5 `39388de6395c...` for two path shapes) against **200 / 568,234 B** for `udw`, and the UDW page's `__NEXT_DATA__` holds `name: UDW`, `displaySku: UDW (420W)`, `historicalSlugs`, `documents: [{InstallationGuide, https://dl.ui.com/qig/udw}]` and zero occurrences of `udw-pro` / `Dream Wall Pro`, with `linkedProducts: []`, `compatibleProducts` and `upsellProductCategories` null - no sibling is pointed at. research/ubiquiti-storefront-structure-spec-payload.md. Then, 2026-11-20 (22:2x UT), the one reading of the storefront that does not depend on a stored hash: `us/en/products/udw-pro` 404 (213,322 B, md5 `9a7b2ea2a5bb...`, served at the requested URL, no `Location`) is byte-identical to the impossible control slug `us/en/products/xzqv-nonexistent-sku`, against 200 / 568,234 B for `udw` - and it answers the same to a desktop Chrome UA as to a bot UA. The not-found shell has been rebuilt since the 204,478 B / md5 `39388de6395c...` recorded on 2026-11-19/20, so that fingerprint is stale: a future pass must re-run the control slug in the same minute, never compare bytes across days. `/us/en/pro/products/udw` now answers **308** to the canonical route, so the archived `/pro/` path is an alias and probing only it tests a redirect; `products.json`, `sitemap_products_1.xml` and `collections/all/products.json` 307/308 away, so the store is a Next.js app (motif-theme, assets.ecomm.ui.com) and there is no Shopify product API to enumerate. The live product payload (`__NEXT_DATA__` -> `props.pageProps.collection.products[0].technicalSpecification`) agrees with `devices/ubiquiti/udw.json` on all six port/PoE/WiFi rows, and its `Max. WAN Port Count = 8` / `Default WAN Ports` pair names no per-port rule, so no spec change: research/ubiquiti-storefront-product-payload.md. | a Ubiquiti page, datasheet, FCC exhibit or quick-start guide that names UDW-PRO's ports and PoE budget, or the requester confirming they meant the UDW (already catalogued as `devices/ubiquiti/udw.json`, census re-confirmed from the archived Ubiquiti store collection page on 2026-11-19). Modelling it from the non-Pro numbers is the family-sibling error this catalogue has already corrected. Per docs/RESOLUTIONS.md this request is not closed as unbuildable or impossible. |
| 803 | Huawei OptiXtrans E6616X | the service-board part number valid in an E6616X subrack, and that board's front-panel census. Correction (2026-11-17): the E6600 board documentation is not confined to the closed hedex tree - it is published one chapter per PDF on `e-file.huawei.com`, anonymous, and two board chapters were fetched and read today: `(6)-UXCME` (TMK5UXCME system control, 590,457 B) and `(21)-TMB3AUX` (auxiliary board, 482,177 B). Neither is a client board, and neither carries a `Valid Slots` table (zero occurrences), unlike the E9600 board chapters - so even a client-board chapter may not state which subrack accepts it. The 27-part numbered bundle those chapters belong to is now enumerated exhaustively and holds no client board. The E6616 chassis chapter (20 pp, `(2)-OptiXtrans E6616-Datasheet`) remains slot layout plus per-system-board capacity, with no port table. Public-doc census (2026-11-18): the three English E6600 product pages link 299 unique EDOC ids and exactly 47 answer 200 - 38 videos, 8 Routine Maintenance chapters, the joint OSN 1800/E6600/DC908 web-UI guide (EDOC1100605035, whose 74,406-char text layer holds no TMB1, TMK1, TMK5 or TNG1, no Valid Slots, no Port Spec) and the EUCC statement. Correction the same day: that census counted a gated document as an absent one. `/hedex/api/navi/<id>/first-level-tree` answers in three states - 200 public, **401 `NOT LOGIN!`** for a document that exists behind an account, 404 `No doc data found.` for an id that does not exist (controls: EDOC9999999999 and EDOC0000000000 404, EDOC1100447312 200) - and the Chinese product page for the E6616X links 176 ids of which 90 answer 200, **86 answer 401 and none 404**. The 86 include six 硬件描述 editions (R022C10 EDOC1100303423, R023C00 EDOC1100328735, R023C10 EDOC1100367203, R024C10 EDOC1100456168, R025C00 EDOC1100525984, R025C10 EDOC1100558549), the R026C00 产品文档 bundle EDOC1100625827, the E6616X快速安装指南 EDOC1100299473, the three E6616X release documents EDOC1100376749/50/51, and the English HD EDOC1100456166 the census had counted as absent. So the hardware description - the document whose chapters carry the board census - is published, not missing: it is login-gated. The boards-overview document the E6616 spec cites (EDOC1100156575BEJ09044) is not merely gated - its content endpoint /hedex/api/pages/EDOC1100156575/BEJ09044/01 answers 404 'No doc data found.' anonymously - and the downloadable package roots are closed at the root: V100R026C00 EDOC1100625826, V100R025C10 EDOC1100556468, V100R025C00 EDOC1100526008, V100R024C10 EDOC1100456079 and V100R023C10 EDOC1100366068 all 302, with the viewer PDF export /hedex/api/misc/<id>/pdf-dl-url answering 400 for each. Named 2026-11-18: the boards themselves, from a deployment rather than the vendor. A Ningbo Rail Transit Line 4 maintenance tender (135 pp, 91,554-char text layer) lists two E6616X in station equipment rooms, itemised as chassis **TM65K32AFB** + **65UXCL** (cross-connect/main control/clock) + **B2PD1** (2M processing) + **B2DMS** (2M interface) + `SSN1D75S` (32xE1/T1 75-ohm cable-out). So `TM65*` is the chassis and cross-connect prefix, not the service-board namespace as the R026 brochure's single `TM65UXCL` part number had suggested, and the X's 2M pair is the `B2` generation the price list calls `TMB2TPS` (1*DMS+2*PD1). What it does not give is the per-slot complement (every row is qty 1 - a spares list, not a built subrack), a port count for `B2DMS` alone, or the slot cost of the DMS+2xPD1 assembly - research/optixtrans-e6616x-deployment-board-inventory.md. Re-checked 2026-11-18 19:4x: the three chapters the last note named as candidates (TMB2PD1, TMB2DMS, TMB2TPS) are hosted by nobody but resellers - five search-engine queries on the e-file route that yielded (6)-UXCME and (21)-TMB3AUX return no Huawei-hosted asset for any of them, only verbatim reprints of the board chapters at szhuaxunjia.com/product/2298.html (TMB2DMS) and /2297.html (TMB2PD1). Those reprints do print the panel ("32 x 75-ohm/120-ohm E1 or 100-ohm T1") and a 配套关系 table naming E6616X with TM65UXCL from V100R022C10SPC010, but a re-hosted page is not a source. They also correct the criterion this entry has carried since 2026-11-17: the E6600 board chapters have no Valid Slots table at all - compatibility is expressed as a 配套设备 table, unlike the E9600 chapters - so asking for a Valid Slots table naming E6616X asks for a section this family never prints; the artifact is the TMB2DMS chapter itself - research/optixtrans-e6616x-2m-pair-chapter-format.md. Closed again 2026-11-18 21:2x: the OSN 1800 V substitution. The board chapters are linked under an `1800v/` hedex package path and `TMB2DMS` is sold as an OSN 1800 V Pro board, so a public OSN 1800 V hardware description would carry the same chapter - measured against seven editions on `optix-osn-1800-v-pro-pid-250732494` (EDOC1100558550, EDOC1100525975, EDOC1100456158, EDOC1100303420, EDOC1100249290, EDOC1100192279, and Product Description EDOC1100558552): every one answers 401 NOT LOGIN to `/hedex/api/navi/<id>/first-level-tree`, against controls answering 200 (EDOC1100447312) and 404 (EDOC9999999999) in the same minute - research/optixtrans-osn1800v-hd-also-gated.md. Re-checked 2026-11-18 21:5x: the gate is now measured by a script instead of by hand - `scripts/huawei-doc-gate-probe.js` probes `/hedex/api/navi/<id>/first-level-tree` for the 30 ids in `research/huawei-gated-docs.json` and exits non-zero when any state has moved. Baseline today: 27 `gated`, 2 `public` (the joint OSN 1800/E6600/DC908 web-UI guide and a public guide), 1 `absent` (EDOC9999999999) - no E6600 or OSN 1800 V Pro hardware description, board chapter, Quick Installation Guide or documentation package in the list is anonymously readable. Newly listed, not newly readable: the 26H2 set is on the portal as `EDOC1100625826` (V100R026C00 Product Documentation 01) with `EDOC1100625831` Feature Description and `EDOC1100625925` Upgrade Guide, all 401 - research/huawei-gated-doc-probe.md. Narrowed 2026-11-18 23:5x UTC: the E6616X has its own vendor spec sheet - `OptiXtrans E6616X Product Brochure` (216,145 B, 4 pp) rates the box at 680 Gbit/s OTN, 680 Gbit/s OSU, 800 Gbit/s packet, 100 Gbit/s grey per channel with line rates of 2.5/10/100 Gbit/s, 14/12 service board slots - so every frame field is sourced and the one missing item is a service-board part number valid in it plus that board's front-panel census. The E6616 row (14x B1LDCD, 100G/200G CFP2 DWDM line) cannot be reused: the E6616X sheet caps per channel at 100G grey and gives it no wavelength plan, and `E6616X` occurs zero times in the 22,964-character E6616 datasheet text. The leaflet class is measured shut too (E6616X brochure, the Chinese 产品彩页 .docx and the Railway 26H1 brochure: zero service-board part numbers between them). research/optixtrans-e6616x-grey-ceiling-and-own-spec-sheet.md. Counted 2026-11-19: the E6600-Series list's Chinese twin (75 ids, disjoint from the English 189, 40 open) is entirely 传送小百科 / 【知光漫谈】 popular-science posts - spot-checked EDOC1100496833, EDOC1100535528, EDOC1100593014, EDOC1100550968 - so the 264-id union across both lists holds 63 open ids and no board chapter. The mirror host `support.huawei.cn` was measured for the first time: its E6616X page decodes to the same bytes as `.com` (md5 81580b68, 437,872 B) and its hedex gate answers identically (`EDOC1100558549` and `EDOC1100625831` 401 `NOT LOGIN!` via `uniportal.huawei.cn`, the public UI guide 200), so the second host is not a second door - research/optixtrans-e6616x-cn-mirror-same-gate.md. Then, 2026-11-19 02:0x, the surface that replaced hedex on the product page: `support.huawei.com/enterprise/en/.../optixtrans-e6616x-pid-257173887` is now a Vue single-page app - 200 but 6,539 B of shell, byte-identical with a `/knowledge-base` suffix - whose document list is fetched from `/supportgateway/supproductservice/v1/enterprise/`. Measured: `multi-language/init?pid=257173887` answers 200 with `mid: SUPE_DOC` and `hedexPath`, `multi-language/navi/tree` returns the same 24-category site taxonomy (1,337 B) for `257173887`, for `1` and for `9999999999999` - the path parameter is not used, so it is not a product tree - `auto-complete/doc-with-lang` returns `"data":[]` for every keyword including the published chapter names `TMB3AUX` and `TNG2DAP`, and the one call that would list a category, `aggregation/doc/second-item`, answers **400 `WSF check error`** (`support-productservice-010001`) while `security/csrf-token` hands an anonymous session `"data": null`, so it can never be signed. No anonymous document index exists behind the new portal; the board chapters stay behind the login. research/optixtrans-e6616x-support-gateway-not-a-doc-index.md. Same pass: the Greek edition of the same product page (200, 54,484 B to a Googlebot UA; 403, 433 B to a desktop UA) is a fourth vendor-hosted edition and prints `AC chassis: 12/10` plus `Equipment Capacity 2.8T/160G H/20G L`, corroborating the 1500 W/2400 W AC split on a product page - but it has no `E6616X` column and no board row. Reclassified 2026-11-19 02:2x UTC: the census is no longer what is missing. Three independent reprints agree the 2M pair presents **32 E1/T1** (`szhuaxunjia.com/product/2298.html`, 42,382 B: 32 x 75/120-ohm E1 or 100-ohm T1; `szdingwei.net/Product/6542134456.html`, 34,588 B, titled `32路E1/T1电接口板`; the Tanatel price row `03034FAA TMB2TPS 32xE1/T1 tributary board(1*DMS+2*PD1)`), and the `配套关系` table that only the szhuaxunjia reprint prints names the X row outright: `TMB2DMS \| E6616X \| TM65UXCL \| V100R022C10SPC010` (its TMB2PD1 page, 表2, prints the same). What stops a spec is the repository, not Huawei: **the engine has no E1/T1 port type and no E1 cage** - `engine/media.js` families are ethernet/wireless/console/dsl/pon/coax/powerline/serial, the serial cage is V.35 (`serial-v35`, 1.544 Mbps, cable v35) and the coax cage is an F-connector, so a G.703 tributary would be drawn as a WIC-2T or a cable-TV socket and `scripts/audit-port-types.js` polices exactly that. #803 therefore sits with #807/#808/#810 in the plan's rank 2 ('a port type the engine does not have'), not rank 3 ('the vendor never published it'). Two smaller corrections: `https://e.huawei.com/en/products/optical-transmission/optixtrans-e6616x` answers **200 with `<title>404</title>`** (336,300 B, same as the non-existent `-e6608` URL) so a 200 there is not a product page - the X has none of its own; and Tanatel is reachable again (200, 1,020,978 B) and lists **six** X chassis SKUs (K31/K32 DC, K33/K34/K36 AC 1500 W, K35 DC no-preconnection), i.e. **every AC SKU of the X is 1500 W** so the 12/10 AC split is an E6616 property, not the X's. - research/optixtrans-e6616x-port-type-gap.md.Re-checked 2026-11-19: the two bundle members no note had opened were measured, and both are negatives - `(17)-OptiX OSN E6616 MIBs` (273 pp, 5,602,882 B, 495,778 extracted chars) is an SNMP performance/alarm data dictionary with **0** occurrences of `E6616X`, `OptiXtrans`, `TM65`, `TMB1`, `TMB2` or `Service Board` and no enumerated board type, and its section 6.2 sends the MIB-file download to the login-gated Software page (so the compiled MIB is not an anonymous route either); `(3)-OptiXtrans FAT-TEST` (8 pp, 9,004 chars) is a factory-inspection report template whose only mentions of boards are test steps. Neither carries a complement, so the public E6600 bundle is now fully characterised and holds no board census - research/optixtrans-e6616x-public-corpus-inventory.md. Re-checked 2026-11-20 07:5x UTC, three measurements and still no spec. (1) `node scripts/huawei-doc-gate-probe.js --group e6600` reports **20/20 documents still 401 NOT LOGIN**, so nothing in the gated set has been published since the 2026-11-18 baseline and the authenticated read of `EDOC1100625826` is still the only route to the 配套设备 table. (2) The namespace correction of 2026-11-18 is closed too, and it was the best remaining lead: the `TM65*` family the X's own boards would carry - the prefix of its `TM65UXCL` cross-connect - has no board document behind any web-search hit, on two queries (`"TM65" huawei board OptiXtrans E6616X "valid slots" OR "front panel" pdf`, `site:e-file.huawei.com "TM65" board pdf`); the only TM65 string on any indexed Huawei host is still that licence footnote in the V100R025C10 brochure. (3) The last Huawei-authored description of this family that sits outside the login wall was read end to end: the Common Criteria security target the evaluation lab publishes (HTTP 200, 2,547,313 B, **83 pp**, 157,466 extracted characters) names the chassis and its SCC slots - E6616 `UXCME:15,16` = `TMK5UXCME`, E6608 `UXCLE:7,8` = `TMK2UXCLE`, E6608T `TMT1SCC` - and **no service-board part number at all**: zero matches for `B1L*`, `TMB*`, `TN13*`, `CFP2` or `QSFP28`. An 83-page vendor description of the frame still prints no census, so a later pass need not re-open it. The blocker is unchanged and is now the engine side as much as the vendor side: an E1/T1 path needs a port type `engine/media.js` does not have, which is out of scope for this stream. | the TMB2DMS chapter from Huawei: EDOC1100558549 (OptiXtrans E6600 V100R025C10 硬件描述, any of the six editions the Chinese product page lists) behind the free-login wall, or a Huawei-hosted PDF of the same chapter on the e-file asset route. Corrected 2026-11-18: not a Valid Slots table - the E6600 chapters print 配套设备 instead. the board set to be modelled (e.g. `E6616X DC (12x <board>)`), or an E6600 ordering/configuration guide. Routes closed on 2026-11-17: the related-materials graph (40 pages, 27 numbered parts, enumerated in `research/optixtrans-e-file-numbered-bundle.md`), the vendor sitemap (713 pages, no E6600 board chapter), hedex (302/403 for every user-agent today, including the Dorado path that answered 200 this morning), and Wayback (no capture of the E6600 boards overview under three URL prefixes). Closed again on 2026-11-18: the E6600 product-page document list (299 ids counted, no board chapter), hedex's content API ('No doc data found.'), the R026/R025 documentation-package roots and the PDF-export endpoint - research/optixtrans-e6616x-anonymous-doc-census.md. Measured 2026-11-18: every E6600 technical document on the navi/content API answers 401 NOT LOGIN to an anonymous crawler, so the remaining step is an authenticated session, not a vendor publication - one free Huawei enterprise account reading OptiXtrans E6600 V100R025C10 硬件描述 01 (`EDOC1100558549`, newest edition listed) would open the board chapters; research/optixtrans-e6616x-docs-gated-not-unpublished.md. Narrowed 2026-11-18: the per-slot complement of one real subrack (commissioning record or NE inventory export: 'E6616X, TM65K32AFB, slots 1-14: n x <board>'), or a Huawei board chapter whose Valid Slots table names E6616X - candidates now TMB2PD1 / TMB2DMS / TMB2TPS for the 2M path, and the GDC / EX10 / EG10 (TMK1* by inference) Ethernet set the same document maintains - research/optixtrans-e6616x-deployment-board-inventory.md. Also recorded 2026-11-18: the E6616X Quick Installation Guide exists as two ids for one document - English `EDOC1100299472` (printed under Quick Start on the support page) and Chinese `EDOC1100299473` - both 401, so the Quick Start class is not a bypass of the Hardware Description gate. Shortest path as of 2026-11-18: one authenticated read of `EDOC1100625826` - the R026C00 (26H2) documentation package, newer than the R025C10 id this entry previously named - whose board chapters carry the `配套设备` table; `node scripts/huawei-doc-gate-probe.js` reports the moment it stops being 401. Note 2026-11-18: scripts/huawei-material-fetch.js had begun answering 403 on every material page (node's TLS client is fingerprinted; curl gets 200 with the same headers) and now fetches through curl - re-verified on `(2)-OptiXtrans E6616-Datasheet` (1,535,511 B) and `(21)-TMB3AUX` (482,177 B). Revised 2026-11-19: not only a build any more. (a) the build - `E6616X DC (n x TMB2TPS)` with `TMB2TPS` = 1x TMB2DMS + 2x TMB2PD1 and 32 E1/T1 per group; what no source states is how many groups a 14-slot chassis is built with, or the DMS's own slot cost against its two PD1s; and (b) an E1/T1 port type plus cage in `engine/media.js` (no `bnc`, `rj48` or `g703` cage exists today), which is an engine change and out of scope for this stream - so the spec lands when both are decided, and neither is a Huawei publication gap. The vendor original of the 配套 table is still worth one authenticated read (`EDOC1100558549` or the R026C00 package `EDOC1100625826`) to lift the row from a reprint onto a vendor host. |

Sources last read for each, so the next pass starts from the end of this one rather than
from the beginning:

- **#130** (2026-11-20) - <https://techspecs.ui.com/unifi/cloud-gateways>, <https://techspecs.ui.com/unifi/cloud-gateways/udw-pro>, <https://dl.ui.com/ds/udw-pro_ds.pdf>, <https://eu.store.ui.com/eu/en/category/all-cloud-gateways>, <https://fccid.io/SWX-UDW>, <https://dl.ui.com/ds/udw_ds.pdf>, <https://fccid.io/SWX>, <https://fccid.io/SWX/page/2>, <https://fccid.io/SWX/page/3>, <https://fccid.io/SWX/page/4>, <https://fccid.io/SWX/page/5>, <https://web.archive.org/web/20250218070534/https://store.ui.com/us/en/products/uacc-psu-udw>, <https://fw-update.ubnt.com/api/firmware?limit=1000&filter=eq~~product~~unifi-dream>, <https://fw-update.ubnt.com/api/firmware?limit=1000&filter=eq~~platform~~udw>, <https://fw-update.ubnt.com/api/firmware?limit=1000&filter=eq~~platform~~udwpro>, <https://fw-download.ubnt.com/data/unifi-dream/2d04-UDW-6.0.17-090536d9-3df7-4572-98b3-a909e9659630.bin>, <https://techspecs.ui.com/compliance/chile/udw>, <https://techspecs.ui.com/compliance/chile/udw-pro>, <https://techspecs.ui.com/compliance/chile>, <https://techspecs.ui.com/_next/static/O4loEueJJ_fzZc5I2r7Ta/_buildManifest.js>, <https://web.archive.org/web/20230603042814/https://store.ui.com/us/en/collections/unifi-dream-wall/products/udw>, <https://dl.ui.com/qig/udw.pdf>, <https://dl.ui.com/qig/udw-pro.pdf>, <https://dl.ui.com/qig/udw-eu.pdf>, <https://br.store.ui.com/br/en/products/udw-pro>, <https://ca.store.ui.com/ca/en/products/udw-pro>, <https://jp.store.ui.com/jp/en/products/udw-pro>, <https://me.store.ui.com/me/en/products/udw-pro>, <https://mx.store.ui.com/mx/en/products/udw-pro>, <https://tw.store.ui.com/tw/en/products/udw-pro>, <https://uk.store.ui.com/uk/en/products/udw-pro>, <https://us.store.ui.com/us/en/products/udw-pro>, <https://ui.com/cloud-gateways>, <https://ui.com/robots.txt>, <https://ui.com/sitemap.xml>, <https://help.ui.com/api/v2/help_center/articles/search.json?query=udw-pro>, <https://help.ui.com/hc/en-us/articles/22230509487639-UniFi-Consoles-with-UniFi-Access-Support>, <https://help.ui.com/hc/en-us/articles/360043360253-UniFi-Recovery-Mode>, <https://ea.store.ui.com/us/en>, <https://uk.store.ui.com/uk/en/category/all-cloud-gateways>, <https://account.ui.com/login>, <https://archive.org/wayback/available?url=4gon.co.uk/ubiquiti-unifi-dream-wall-pro-udwpro-p-10111.html>, <https://www.4gon.co.uk/ubiquiti-unifi-dream-wall-pro-udwpro-p-10111.html>, <https://techspecs.ui.com/unifi/accessories>, <https://techspecs.ui.com/unifi/door-access>, <https://techspecs.ui.com/unifi/integrations>, <https://techspecs.ui.com/unifi/physical-security>, <https://techspecs.ui.com/unifi/switching>, <https://techspecs.ui.com/unifi/wifi>, <https://techspecs.ui.com/uisp>, <https://techspecs.ui.com/unifi/cloud-gateways/udw>, <https://techspecs.ui.com/unifi/cloud-gateways/bogus-xyz>, <https://techspecs.ui.com/unifi/integrations/udw-pro>, <https://techspecs.ui.com/amplifi>, <https://store.ui.com/us/en/products/udw>, <https://store.ui.com/us/en/products/udw-pro>, <https://store.ui.com/us/en/category/cloud-gateways-wifi-integrated>, <https://store.ui.com/api/opensearch?keyword=UDW>, <https://store.ui.com/us/en/products/xzqv-nonexistent-sku>, <https://store.ui.com/us/en/pro/products/udw>, <https://store.ui.com/products.json?limit=250>
- **#803** (2026-11-20) - <https://e.huawei.com/en/products/optical-transmission/optixtrans-e6600>, <https://e.huawei.com/en/documents/others/621bfc22e8564cf69ae86581569a7594>, <https://e.huawei.com/sitemap-ebg-x-default.xml>, <https://e-file.huawei.com/marketingcloud/pep/asset/20000001/Material/104eb87894f1489dac28e58171dca5cc/M3T1A669N1304590990909157504/_21_-TMB3AUX.pdf>, <https://e-file.huawei.com/marketingcloud/pep/asset/20000001/Material/5fa3c10e4f454dfaa44f26447563718d/M3T1A669N1304588494599672043/_6_-UXCME.pdf>, <https://e-file.huawei.com/marketingcloud/pep/asset/20000001/Material/e650e67ac43a4b169fd5001518bd346d/M3T1A669N1178212931847860258/eSFP_1550_12nm_125M%20to%202_67Gbps_0%20to%204_0dBm_-28_0dBm_LC_120km.pdf>, <https://e.huawei.com/en/documents/others/104eb87894f1489dac28e58171dca5cc>, <https://support.huawei.com/enterprise/zh/optical-transmission/optixtrans-e6616x-pid-257173887>, <https://support.huawei.com/hedex/api/navi/EDOC1100558549/first-level-tree>, <https://support.huawei.com/hedex/api/navi/EDOC1100456166/first-level-tree>, <https://support.huawei.com/hedex/api/navi/EDOC9999999999/first-level-tree>, <https://support.huawei.com/hedex/api/navi/EDOC1100447312/first-level-tree>, <http://ygcg.nbcqjy.org:8061/down/c1e5edbe-2560-4ddc-a308-0c0d66b1bacf/%E7%94%A8%E6%88%B7%E9%9C%80%E6%B1%82%E4%B9%A6-4.13.pdf>, <https://www.szhuaxunjia.com/product/2298.html>, <https://www.szhuaxunjia.com/product/2297.html>, <https://support.huawei.com/enterprise/en/optical-transmission/optix-osn-1800-v-pro-pid-250732494>, <https://support.huawei.com/hedex/api/navi/EDOC1100525975/first-level-tree>, <https://support.huawei.com/enterprise/en/doc/EDOC1100299472>, <https://support.huawei.com/enterprise/en/optical-transmission/optixtrans-e6616x-pid-257173887>, <https://support.huawei.com/hedex/api/navi/EDOC1100625826/first-level-tree>, <https://support.huawei.com/hedex/api/navi/EDOC1100625921/first-level-tree>, <https://e.huawei.com/marketingcloud/pep/asset/20000001/Material/6fffa7f348f9475081b17eb1fc591b10/M1T1A669N837008945971838990/OptiXtrans%20E6616X%20Product%20Brochure.pdf>, <https://e-file.huawei.com/marketingcloud/pep/asset/20000001/Material/6c94817240a44b19bb49566f0634ea9e/M3T1A590N1246470205869879492/OptiXtrans%20E6616%20V100R025C10%20%E4%BA%A7%E5%93%81%E5%BD%A9%E9%A1%B5.docx>, <https://e-file.huawei.com/marketingcloud/pep/asset/20000001/Material/00a9d517b714455ca0d59d9d8f2e5a2f/M3T1A669N1272073348910575792/Railway%20Optical%20Communication%20Network-Brochure_26H1_-TR.pdf>, <https://support.huawei.cn/enterprise/zh/optical-transmission/optixtrans-e6616x-pid-257173887>, <https://support.huawei.cn/hedex/api/navi/EDOC1100558549/first-level-tree>, <https://support.huawei.cn/hedex/api/navi/EDOC1100625831/first-level-tree>, <https://support.huawei.com/enterprise/zh/optical-transmission/optixtrans-e6600-series-pid-266120513>, <https://support.huawei.com/enterprise/zh/doc/EDOC1100496833>, <https://support.huawei.com/enterprise/zh/doc/EDOC1100535528>, <https://support.huawei.com/enterprise/zh/doc/EDOC1100593014>, <https://support.huawei.com/enterprise/zh/doc/EDOC1100550968>, <https://support.huawei.com/enterprise/en/optical-transmission/optixtrans-e6616x-pid-257173887/knowledge-base>, <https://support.huawei.com/supportgateway/supproductservice/v1/enterprise/multi-language/init?pid=257173887>, <https://support.huawei.com/supportgateway/supproductservice/v1/enterprise/multi-language/navi/tree?vocationIdAbsPath=257173887&lang=en>, <https://support.huawei.com/supportgateway/supproductservice/v1/enterprise/auto-complete/doc-with-lang?keyword=TMB2DMS&pageLang=en>, <https://support.huawei.com/supportgateway/supproductservice/v1/enterprise/aggregation/doc/second-item>, <https://support.huawei.com/supportgateway/newsservice/v1/enterprise/security/csrf-token>, <https://e.huawei.com/gr/products/optical-transmission/optiXtrans-e6600>, <https://www.szdingwei.net/Product/6542134456.html>, <https://www.tanatel-comm.com/product/e6616/>, <https://e.huawei.com/en/products/optical-transmission/optixtrans-e6616x>, <https://e.huawei.com/en/documents/others/93497602262044be97b5e763c3b3c8da>, <https://e-file.huawei.com/marketingcloud/pep/asset/20000001/Material/93497602262044be97b5e763c3b3c8da/M3T1A669N1304591003040927770/_17_-OptiX%20OSN%20E6616%20MIBs.pdf>, <https://e.huawei.com/en/documents/others/937368e184e647fd817598ebae76cd2f>, <https://e-file.huawei.com/marketingcloud/pep/asset/20000001/Material/937368e184e647fd817598ebae76cd2f/M3T1A669N1304588489820618926/_3_-OptiXtrans%20FAT-TEST.pdf>, <https://atsec.com/webfiles/Common_Criteria_Certificates/2026_Certificates/2026-10-28_Huawei_OptiX_OSN_1800_OptiXtrans_E6600_DC908/Huawei%20OptiX%20OSN%201800%20&%20OptiXTrans%20E6600%20&%20DC908%20management%20component%20software%20V100R024C10SPC100%20-%20ST%20v0.16.pdf>
<!-- open-requests:end -->
