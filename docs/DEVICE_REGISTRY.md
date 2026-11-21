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

**2,352 models across 258 vendors**, and it grows every time somebody's hardware is
added. The largest vendors and categories by model count, in descending order:

| vendor | models | | category | models |
|---|---:|---|---|---:|
| Ubiquiti | 367 | | switch | 430 |
| MikroTik | 362 | | router | 383 |
| Huawei | 103 | | L3 switch | 264 |
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

One hardware request is open and cannot be modelled yet.
Not one of them is blocked on research effort: in every case the vendor publishes the
field *type* and not its *value*, and the value is what a spec needs. This table is
generated from `research/open-device-requests.json` - `npm run regen:registry-doc` after
editing it, and the issue threads stay the place where each one is argued. Every row
below carries the `blocked-on-build` label on its issue, which is what stops
`node scripts/request-queue.js` from counting it ready.

| issue | model(s) | the field the vendor does not publish | what would unblock it |
|---:|---|---|---|
| 130 | Ubiquiti UniFi Dream Wall Pro (UDW-PRO) | the whole port layout, and the product itself: the SKU is not in Ubiquiti's cloud-gateway index (`udw-pro` occurs zero times in it - 610,409 B when the index was counted on 2026-11-17, 610,412 B today), `techspecs.ui.com/unifi/cloud-gateways/udw-pro` answers **307** with `Location: /` and a 1-byte body while `dl.ui.com/ds/udw-pro_ds.pdf` answers **302** to the techspecs root, so both land on the 609,911-byte site front page instead of a product page (re-measured 2026-11-18 without following redirects: the pages that exist do not redirect - the UDW tech-spec page is 704,702 B, its datasheet 544,909 B - and the earlier "serves its 404s as 200s" reading was a followed redirect), and `store.ui.com/.../udw-pro` is a 404. Three further surfaces were checked and are empty (2026-11-17): the EU storefront publishes only `udw-eu`, the 420 W UDW; no FCC grant exists under `SWX-UDWPRO`, `SWX-UDW-PRO` or `SWX-UDW2` (all 303, against 200 for `SWX-UDW`); and Wayback holds no capture of any of the four `udw-pro` URLs. A sentence quoted around this issue as Ubiquiti's early-access copy - "the Dream Wall and Dream Wall Pro (UDW/UDW Pro)" beside "Dream Wall Pro - Coming Soon" - has no Ubiquiti-hosted URL: its only citation is the third-party forum https://ubiquiti-networks-forum.de/board/thread/4925-ea-store-eu-dream-wall-early-access/, and Wayback holds no 2022 capture of any store.ui.com udw page (earliest 2023-06-03) or any ui.com dream-wall page (earliest 2023-10-18), so the Early-Access page that supposedly said it was never crawled. It is a forum reprint of a deleted page and is recorded here as such, not as vendor copy. The published datasheet `dl.ui.com/ds/udw_ds.pdf` is the non-Pro Dream Wall. Re-checked 2026-11-18: the cloud-gateway index is unchanged at 610,412 B with sixteen cards and zero occurrences of `udw-pro`; the techspecs front page the two Pro URLs land on is byte-identical to the bare root (md5 `5bec75c89b40d2283b11ac5397d85af1`, 609,911 B), so a 200 there is not evidence of a page. Also enumerated 2026-11-18 rather than sampled: the whole grantee code, `https://fccid.io/SWX`, is five server-rendered pages (30,975 / 30,185 / 29,647 / 29,861 / 17,622 B, all 200) and yields 432 unique grants from `SWX-AP1R2` 2005-02-18 to `SWX-USLAK` 2026-10-29, in which the only Dream Wall is `SWX-UDW` 2022-05-31 - while `SWX-UDMPRO`, `SWX-UDMPM`, `SWX-UDMPROSE` and `SWX-UXGPRO` show that Ubiquiti does list Pro variants as their own grants, and `SWX-UDW`'s own page (83,318 B) holds four application IDs all `Original Equipment` and no permissive change, so no Pro hides inside the parent grant. The store tree was enumerated too, which the earlier sweeps had not done: `store.ui.com/us/en/pro/products/` (234 archived URLs) and `store.ui.com/us/en/products/` filtered to `udw` hold only `udw`, `udw?variant=udw-us` (captured 2026-04-28, so the crawl is live) and the accessory `uacc-psu-udw`, with no `udw-pro` in any spelling or year. Caveat recorded: a radio-identical variant could in principle ship under a Class II permissive change, so this rules out a filed authorization, not the existence of the product; and a grant publishes frequencies, never port counts. research/ubiquiti-swx-grantee-census.md.  Then, 2026-11-19, the surface no earlier pass had read: Ubiquiti's own firmware index, `https://fw-update.ubnt.com/api/firmware?limit=1000&filter=eq~~product~~unifi-dream` -> HTTP 200, **340 releases across 17 platform codes** (`UDM`, `UDMPRO`, `UDMPROSE`, `UDMPROMAX`, `UDR`, `UDR5G`, `UDR7`, `UDRULT`, `UDW`, `UX`, `UXMAX`, `UCGF`, `UCGMAX`, `UCGA6AD`, `EFGCORE`, `UDMENT`, `UDMEA4C`), with `UDW` at 27 releases from 2022-05-07 to 2026-11-10 (latest `v6.0.17+7bcad58`, binary `/data/unifi-dream/2d04-UDW-6.0.17-…bin`) and **no `UDWPRO`**: the spellings `UDWPRO`, `UDW-PRO`, `UDWPROMAX`, `UDW2`, `UDWSE`, `UDWMAX` each return the 96-byte 0-release envelope, the same answer as the nonsense control `ZZZZ`, while `UDMPRO` returns 65, `UDMPROSE` 40 and `UDMPROMAX` 20 - three near-identical consoles that nevertheless carry three separate platform codes, which is why a shipped Pro Dream Wall would have its own. Caveat: a rebadged variant sharing the parent mainboard could hide under the `UDW` code, and no firmware index publishes port counts. research/ubiquiti-firmware-platform-census.md.  Then, 2026-11-19 (02:5x-03:1x UT): the Next.js build manifest https://techspecs.ui.com/_next/static/O4loEueJJ_fzZc5I2r7Ta/_buildManifest.js (200, 3,349 B) shows every product path is a dynamic route (`/[productLine]/[category]/[product]`) over 13 `sortedPages`, so no static route list exists to enumerate - but it exposed `/compliance/chile/[[...sku]]`, a SKU-keyed SUBTEL register, which is the first sub-tree on this host that answers a real 404 for a SKU it does not have: `.../compliance/chile/udw` 200, 615,226 B (names Dream Wall, UDW, UDW-EU) against `.../compliance/chile/udw-pro` and `.../compliance/chile/udwpro` 404, 512,657 B "This page could not be found" (index `.../compliance/chile` 200, 549,642 B; `.../compliance/udw` without a locale 307 to `/`). The Pro is absent from it. Also re-confirmed the UDW census off techspecs for the first time: the archived collection page https://web.archive.org/web/20230603042814/https://store.ui.com/us/en/collections/unifi-dream-wall/products/udw (200, 124,982 B) prints the family as Dream Wall / Dream Machine / Dream Router only, and the box as "(17) LAN: GbE RJ45 ports, (1) WAN: 2.5 GbE RJ45 port, (1) LAN: 10G SFP+ port, (1) WAN: 10G SFP+ port, PoE (4) PoE, (4) PoE+, (4) PoE++", with zero occurrences of "Dream Wall Pro", "udw-pro" or "Coming Soon" - matching devices/ubiquiti/udw.json exactly (20 interfaces), so no spec change. research/ubiquiti-udw-pro-absent-from-vendor-catalogue.md. Re-checked 2026-11-19 03:2x UT on the two surfaces earlier passes named but never resolved. (1) The storefront list is published by the page itself: `techspecs.ui.com/unifi/cloud-gateways/udw` carries `props.pageProps.product.alternativeStores` naming all nine storefronts for the SKU - br, ca, eu, jp, me, mx, tw, uk, us - and `/{store}/en/products/udw-pro` is 404 on every one (byte-identical 204,279 B not-found shell, md5 346734f60828bb9d80819a8092b2d291 on us/eu/tw) while the control `/{store}/en/products/udw` is 200 on all nine (492,349-589,781 B; the non-US hosts 307 from store.ui.com to {store}.store.ui.com, which is routing, not a miss). So "not a regional SKU" no longer rests on the US and EU category grids. (2) The document key pattern comes from the product's own `documents` field, `{"type":"InstallationGuide","url":"https://dl.ui.com/qig/udw"}`: `dl.ui.com/qig/udw.pdf` is 200, application/pdf, 8,279,805 B, so `qig/udw-pro.pdf` and `qig/udwpro.pdf` answering the 302-to-techspecs-root fallback (same as `qig/bogus-xyz.pdf`) is a tested negative instead of an untried guess, and `qig/udw-eu.pdf` missing shows the key is per SKU, not per region. That QIG is also the end of the quick-start hope as a text source: one page of Adobe Illustrator 28.0 artwork with zero BT/Tj/TJ operators in its five content streams and no /ActualText - every label is outlined - so a Pro QIG, if Ubiquiti ever published one, would have to be read by eye. The vendor's machine-readable `technicalSpecification` for the UDW (PoE Budget 420W, 112W max excluding PoE, Default WAN Ports (1) 2.5 GbE RJ45 + (1) 10G SFP+, Max. WAN Port Count 8) still agrees with devices/ubiquiti/udw.json, so no spec change. research/ubiquiti-udw-pro-absent-from-vendor-catalogue.md. Then, 2026-11-19 (03:5x UT), two Ubiquiti hosts no pass had read. (1) The marketing family page `https://ui.com/cloud-gateways` (200, 446,725 B) carries a schema.org `ItemList` naming 14 gateways with their techspec URLs - items 4 and 6 are `Dream Machine Pro Max` and `Dream Machine Pro`, item 13 is `Dream Wall` -> `/udw` - and `udw-pro` / `Dream Wall Pro` occur zero times; caveat: the list is curated (14 of the techspecs grid's 16, omitting `udr` and `ux`), so it corroborates rather than enumerates. (2) The support knowledge base is Zendesk, so its index is public: `help.ui.com/api/v2/help_center/articles/search.json?query=` for `dream wall pro`, `udw-pro` and `udw` returns 200 at 728,119 / 719,384 / 364,696 B (counts 33 / 105 / 13), 73 rows and 50 unique articles, in which `Dream Wall Pro`, `UDW-PRO` and `UDWPRO` occur zero times - the Dream Wall appears only as `Dream Wall (UDW)` (Consoles with Access Support; SD-WAN with Site Manager; Upgrading to UID Enterprise, which marks the UDW itself `(EA)`; Recovery Mode). Control: the same endpoint for `udm-pro` returns 1,737,208 B and 100 of 118 rows carrying `UDM-PRO` 39 times and `Dream Machine Pro` 18 times, so the index does hold Pro-suffixed names. Also recorded as a trap: `ui.com/robots.txt` declares `https://ui.com/sitemap.xml`, which is real (200, 8,712 B, 81 locs) but indexes sections, not SKUs (`/cloud-gateways`, `/how-it-works/...`, zero `dream`), so it cannot be cited as a negative either way. research/ubiquiti-udw-pro-absent-from-vendor-catalogue.md. Then, 2026-11-19 (07:5x UT), the one Ubiquiti host no pass had read: the UniFi Design Center, `https://design.ui.com/`. It is a client-rendered SPA - `/`, `/api/devices`, `/api/v1/devices`, `/api/models`, `/api/v1/models`, `/api/products`, `/api/catalog` and `/api/model-list` all answer 200 with the identical 8,107-byte `text/html` router shell - and neither the loader `/assets/index-Dhm9edlX.js` (200, 27,897 B) nor `/assets/Main-Dq_3TtAr.js` (200, 220,557 B) names a model endpoint (the developer pages, e.g. `/assets/DeveloperModelsPage-DG8YuRfL.js`, are 1,601-byte stubs), so the device library behind it is not reachable anonymously. Trap recorded: on this host a 200 is the SPA, not a page, so its silence cannot be cited as a negative - the same shape as the client-rendered `store.ui.com/us/en/search` result noted above. **Gated, not empty (2026-11-19):** `ea.store.ui.com` - the Early Access storefront, the channel that carries an announced-but-unpublished console, and the one whose slug `dream-wall-ea` is already on the UDW's own record - is **deployed and login-walled**: every path including `/_next/static/` answers 302 to `account.ui.com/login` with the path preserved, while `/favicon.ico` is 200/5,430 B, so the app is up and unreadable anonymously; its certificate is `CN=*.ui.com`, which cannot cover the two-label host, so a TLS error there is a certificate gap and not a dead host. The EA `storeId` is behind the same gate: `ea`, `ea-us` and `us-ea` each answer one masked validation error for the `udw` control, so they are rejected ids and not product misses. A credentialed read of that storefront, or the requester naming the SKU meant, is the remaining unblock. Then, 2026-11-19 (22:5x UT), the inventory rather than one shelf: all eight `techspecs.ui.com` product grids read with `node scripts/ubiquiti-techspecs-census.js` (redirects not followed) - accessories 18, cloud-gateways 16, door-access 61, integrations 36, physical-security 146, switching 70, wifi 47, `/uisp` 14 - give **408 cards / 398 unique SKUs** in which exactly one is a Dream Wall (`UDW`, `/unifi/cloud-gateways/udw`) and none matches `UDW-PRO`/`UDWPRO`, while **73 SKUs are `-Pro` tiers** whose neighbours are separate cards (`UDM-Pro`, `UDM-Pro-Max` beside `UDM-Beast`/`UDM-SE`; `U7-Pro-Max`, `U7-Pro-XG-Wall` in wifi). So the absence is not a category-placement miss - which was the one gap left by the earlier single-grid reads, given the Mobile Router sits under `/unifi/integrations/`. Trap recorded: `/unifi` and `/amplifi` both answer 200 and render the same sixteen cloud-gateway cards as `/unifi/cloud-gateways`, so a census that trusted "200 plus cards" would count that grid three times and invent an AmpliFi family. research/ubiquiti-udw-pro-techspecs-slug-census.md. Then, 2026-11-20 (07:2x-08:0x UT), the storefront's own route map rather than one slug: `store.ui.com/us/en/category/<slug>` embeds `subCategories[].products[]` - 15 cloud-gateway products, each with a full `technicalSpecification` (label/value rows) - but the list **omits the UDW itself**, whose page 200s and whose `category.currentCategory.id` is that same category, and the same 15 come back for a different slug, so it cannot be cited as a negative; `us/en/collections/*`, `api/search`, `api/products`, `api/collection`, `api/compare` and `us/en/products/*` misses all return one 204,478-byte not-found body, `sitemap.xml`/`robots.txt` are 307, and `api/opensearch` is a 502-byte OpenSearch *description* document, not a results API. `us/en/products/udw-pro` is still 404 (that same 204,478 B body, md5 `39388de6395c...` for two path shapes) against **200 / 568,234 B** for `udw`, and the UDW page's `__NEXT_DATA__` holds `name: UDW`, `displaySku: UDW (420W)`, `historicalSlugs`, `documents: [{InstallationGuide, https://dl.ui.com/qig/udw}]` and zero occurrences of `udw-pro` / `Dream Wall Pro`, with `linkedProducts: []`, `compatibleProducts` and `upsellProductCategories` null - no sibling is pointed at. research/ubiquiti-storefront-structure-spec-payload.md. Then, 2026-11-20 (22:2x UT), the one reading of the storefront that does not depend on a stored hash: `us/en/products/udw-pro` 404 (213,322 B, md5 `9a7b2ea2a5bb...`, served at the requested URL, no `Location`) is byte-identical to the impossible control slug `us/en/products/xzqv-nonexistent-sku`, against 200 / 568,234 B for `udw` - and it answers the same to a desktop Chrome UA as to a bot UA. The not-found shell has been rebuilt since the 204,478 B / md5 `39388de6395c...` recorded on 2026-11-19/20, so that fingerprint is stale: a future pass must re-run the control slug in the same minute, never compare bytes across days. `/us/en/pro/products/udw` now answers **308** to the canonical route, so the archived `/pro/` path is an alias and probing only it tests a redirect; `products.json`, `sitemap_products_1.xml` and `collections/all/products.json` 307/308 away, so the store is a Next.js app (motif-theme, assets.ecomm.ui.com) and there is no Shopify product API to enumerate. The live product payload (`__NEXT_DATA__` -> `props.pageProps.collection.products[0].technicalSpecification`) agrees with `devices/ubiquiti/udw.json` on all six port/PoE/WiFi rows, and its `Max. WAN Port Count = 8` / `Default WAN Ports` pair names no per-port rule, so no spec change: research/ubiquiti-storefront-product-payload.md. | a Ubiquiti page, datasheet, FCC exhibit or quick-start guide that names UDW-PRO's ports and PoE budget, or the requester confirming they meant the UDW (already catalogued as `devices/ubiquiti/udw.json`, census re-confirmed from the archived Ubiquiti store collection page on 2026-11-19). Modelling it from the non-Pro numbers is the family-sibling error this catalogue has already corrected. Per docs/RESOLUTIONS.md this request is not closed as unbuildable or impossible. |

Sources last read for each, so the next pass starts from the end of this one rather than
from the beginning:

- **#130** (2026-11-20) - <https://techspecs.ui.com/unifi/cloud-gateways>, <https://techspecs.ui.com/unifi/cloud-gateways/udw-pro>, <https://dl.ui.com/ds/udw-pro_ds.pdf>, <https://eu.store.ui.com/eu/en/category/all-cloud-gateways>, <https://fccid.io/SWX-UDW>, <https://dl.ui.com/ds/udw_ds.pdf>, <https://fccid.io/SWX>, <https://fccid.io/SWX/page/2>, <https://fccid.io/SWX/page/3>, <https://fccid.io/SWX/page/4>, <https://fccid.io/SWX/page/5>, <https://web.archive.org/web/20250218070534/https://store.ui.com/us/en/products/uacc-psu-udw>, <https://fw-update.ubnt.com/api/firmware?limit=1000&filter=eq~~product~~unifi-dream>, <https://fw-update.ubnt.com/api/firmware?limit=1000&filter=eq~~platform~~udw>, <https://fw-update.ubnt.com/api/firmware?limit=1000&filter=eq~~platform~~udwpro>, <https://fw-download.ubnt.com/data/unifi-dream/2d04-UDW-6.0.17-090536d9-3df7-4572-98b3-a909e9659630.bin>, <https://techspecs.ui.com/compliance/chile/udw>, <https://techspecs.ui.com/compliance/chile/udw-pro>, <https://techspecs.ui.com/compliance/chile>, <https://techspecs.ui.com/_next/static/O4loEueJJ_fzZc5I2r7Ta/_buildManifest.js>, <https://web.archive.org/web/20230603042814/https://store.ui.com/us/en/collections/unifi-dream-wall/products/udw>, <https://dl.ui.com/qig/udw.pdf>, <https://dl.ui.com/qig/udw-pro.pdf>, <https://dl.ui.com/qig/udw-eu.pdf>, <https://br.store.ui.com/br/en/products/udw-pro>, <https://ca.store.ui.com/ca/en/products/udw-pro>, <https://jp.store.ui.com/jp/en/products/udw-pro>, <https://me.store.ui.com/me/en/products/udw-pro>, <https://mx.store.ui.com/mx/en/products/udw-pro>, <https://tw.store.ui.com/tw/en/products/udw-pro>, <https://uk.store.ui.com/uk/en/products/udw-pro>, <https://us.store.ui.com/us/en/products/udw-pro>, <https://ui.com/cloud-gateways>, <https://ui.com/robots.txt>, <https://ui.com/sitemap.xml>, <https://help.ui.com/api/v2/help_center/articles/search.json?query=udw-pro>, <https://help.ui.com/hc/en-us/articles/22230509487639-UniFi-Consoles-with-UniFi-Access-Support>, <https://help.ui.com/hc/en-us/articles/360043360253-UniFi-Recovery-Mode>, <https://ea.store.ui.com/us/en>, <https://uk.store.ui.com/uk/en/category/all-cloud-gateways>, <https://account.ui.com/login>, <https://archive.org/wayback/available?url=4gon.co.uk/ubiquiti-unifi-dream-wall-pro-udwpro-p-10111.html>, <https://www.4gon.co.uk/ubiquiti-unifi-dream-wall-pro-udwpro-p-10111.html>, <https://techspecs.ui.com/unifi/accessories>, <https://techspecs.ui.com/unifi/door-access>, <https://techspecs.ui.com/unifi/integrations>, <https://techspecs.ui.com/unifi/physical-security>, <https://techspecs.ui.com/unifi/switching>, <https://techspecs.ui.com/unifi/wifi>, <https://techspecs.ui.com/uisp>, <https://techspecs.ui.com/unifi/cloud-gateways/udw>, <https://techspecs.ui.com/unifi/cloud-gateways/bogus-xyz>, <https://techspecs.ui.com/unifi/integrations/udw-pro>, <https://techspecs.ui.com/amplifi>, <https://store.ui.com/us/en/products/udw>, <https://store.ui.com/us/en/products/udw-pro>, <https://store.ui.com/us/en/category/cloud-gateways-wifi-integrated>, <https://store.ui.com/api/opensearch?keyword=UDW>, <https://store.ui.com/us/en/products/xzqv-nonexistent-sku>, <https://store.ui.com/us/en/pro/products/udw>, <https://store.ui.com/products.json?limit=250>
<!-- open-requests:end -->
