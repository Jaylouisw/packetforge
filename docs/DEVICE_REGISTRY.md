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
| `category` | yes | `router`, `switch`, `l3-switch`, `firewall`, `tap`, `host`, `server`, `wireless`, `cloud`, `olt`, `ont`, `splitter`, `modem`, `powerline`, `nas`, `desktop`, `laptop`, `phone`, `tablet`, `printer`, `camera`, `nvr`, `iot` |


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

**2,357 models across 258 vendors**, and it grows every time somebody's hardware is
added. The largest vendors by model count:

| vendor | models | | category | models |
|---|---:|---|---|---:|
| MikroTik | 366 | | router | 383 |
| Ubiquiti | 369 | | switch | 429 |
| Aruba | 73 | | point-to-point | 212 |
| Huawei | 102 | | wireless | 220 |
| Cisco | 89 | | L3 switch | 264 |
| TP-Link | 57 | | IoT | 125 |
| Teltonika | 88 | | modem | 54 |
| HPE | 33 |
| NETGEAR | 52 | | | |

The authoritative list is not this page — it is the directory. `GET /api/catalog` returns
every spec the running server has loaded, with the category groupings the palette uses,
and `GET /api/requests` returns the hardware people have asked for that is not here yet.

If a number here disagrees with the directory, the directory is right; this section is
prose and prose goes stale.

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
| 130 | Ubiquiti UniFi Dream Wall Pro (UDW-PRO) | the whole port layout, and the product itself: the SKU is not in Ubiquiti's cloud-gateway index (`udw-pro` occurs zero times in it - 610,409 B when the index was counted on 2026-11-17, 610,412 B today), `techspecs.ui.com/unifi/cloud-gateways/udw-pro` answers **307** with `Location: /` and a 1-byte body while `dl.ui.com/ds/udw-pro_ds.pdf` answers **302** to the techspecs root, so both land on the 609,911-byte site front page instead of a product page (re-measured 2026-11-18 without following redirects: the pages that exist do not redirect - the UDW tech-spec page is 704,702 B, its datasheet 544,909 B - and the earlier "serves its 404s as 200s" reading was a followed redirect), and `store.ui.com/.../udw-pro` is a 404. Three further surfaces were checked and are empty (2026-11-17): the EU storefront publishes only `udw-eu`, the 420 W UDW; no FCC grant exists under `SWX-UDWPRO`, `SWX-UDW-PRO` or `SWX-UDW2` (all 303, against 200 for `SWX-UDW`); and Wayback holds no capture of any of the four `udw-pro` URLs. Ubiquiti's early-access copy names "the Dream Wall and Dream Wall Pro (UDW/UDW Pro)" and then lists only the UDW's ports, beside "Dream Wall Pro - Coming Soon". The published datasheet `dl.ui.com/ds/udw_ds.pdf` is the non-Pro Dream Wall. Re-checked 2026-11-18: the cloud-gateway index is unchanged at 610,412 B with sixteen cards and zero occurrences of `udw-pro`; the techspecs front page the two Pro URLs land on is byte-identical to the bare root (md5 `5bec75c89b40d2283b11ac5397d85af1`, 609,911 B), so a 200 there is not evidence of a page. Also enumerated 2026-11-18 rather than sampled: the whole grantee code, `https://fccid.io/SWX`, is five server-rendered pages (30,975 / 30,185 / 29,647 / 29,861 / 17,622 B, all 200) and yields 432 unique grants from `SWX-AP1R2` 2005-02-18 to `SWX-USLAK` 2026-10-29, in which the only Dream Wall is `SWX-UDW` 2022-05-31 - while `SWX-UDMPRO`, `SWX-UDMPM`, `SWX-UDMPROSE` and `SWX-UXGPRO` show that Ubiquiti does list Pro variants as their own grants, and `SWX-UDW`'s own page (83,318 B) holds four application IDs all `Original Equipment` and no permissive change, so no Pro hides inside the parent grant. The store tree was enumerated too, which the earlier sweeps had not done: `store.ui.com/us/en/pro/products/` (234 archived URLs) and `store.ui.com/us/en/products/` filtered to `udw` hold only `udw`, `udw?variant=udw-us` (captured 2026-04-28, so the crawl is live) and the accessory `uacc-psu-udw`, with no `udw-pro` in any spelling or year. Caveat recorded: a radio-identical variant could in principle ship under a Class II permissive change, so this rules out a filed authorization, not the existence of the product; and a grant publishes frequencies, never port counts. research/ubiquiti-swx-grantee-census.md.  Then, 2026-11-19, the surface no earlier pass had read: Ubiquiti's own firmware index, `https://fw-update.ubnt.com/api/firmware?limit=1000&filter=eq~~product~~unifi-dream` -> HTTP 200, **340 releases across 17 platform codes** (`UDM`, `UDMPRO`, `UDMPROSE`, `UDMPROMAX`, `UDR`, `UDR5G`, `UDR7`, `UDRULT`, `UDW`, `UX`, `UXMAX`, `UCGF`, `UCGMAX`, `UCGA6AD`, `EFGCORE`, `UDMENT`, `UDMEA4C`), with `UDW` at 27 releases from 2022-05-07 to 2026-11-10 (latest `v6.0.17+7bcad58`, binary `/data/unifi-dream/2d04-UDW-6.0.17-…bin`) and **no `UDWPRO`**: the spellings `UDWPRO`, `UDW-PRO`, `UDWPROMAX`, `UDW2`, `UDWSE`, `UDWMAX` each return the 96-byte 0-release envelope, the same answer as the nonsense control `ZZZZ`, while `UDMPRO` returns 65, `UDMPROSE` 40 and `UDMPROMAX` 20 - three near-identical consoles that nevertheless carry three separate platform codes, which is why a shipped Pro Dream Wall would have its own. Caveat: a rebadged variant sharing the parent mainboard could hide under the `UDW` code, and no firmware index publishes port counts. research/ubiquiti-firmware-platform-census.md. | a Ubiquiti page, datasheet, FCC exhibit or quick-start guide that names UDW-PRO's ports and PoE budget, or the requester confirming they meant the UDW (already catalogued as `devices/ubiquiti/udw.json`). Modelling it from the non-Pro numbers is the family-sibling error this catalogue has already corrected. |
| 803 | Huawei OptiXtrans E6616X | the service-board part number valid in an E6616X subrack, and that board's front-panel census. Correction (2026-11-17): the E6600 board documentation is not confined to the closed hedex tree - it is published one chapter per PDF on `e-file.huawei.com`, anonymous, and two board chapters were fetched and read today: `(6)-UXCME` (TMK5UXCME system control, 590,457 B) and `(21)-TMB3AUX` (auxiliary board, 482,177 B). Neither is a client board, and neither carries a `Valid Slots` table (zero occurrences), unlike the E9600 board chapters - so even a client-board chapter may not state which subrack accepts it. The 27-part numbered bundle those chapters belong to is now enumerated exhaustively and holds no client board. The E6616 chassis chapter (20 pp, `(2)-OptiXtrans E6616-Datasheet`) remains slot layout plus per-system-board capacity, with no port table. Public-doc census (2026-11-18): the three English E6600 product pages link 299 unique EDOC ids and exactly 47 answer 200 - 38 videos, 8 Routine Maintenance chapters, the joint OSN 1800/E6600/DC908 web-UI guide (EDOC1100605035, whose 74,406-char text layer holds no TMB1, TMK1, TMK5 or TNG1, no Valid Slots, no Port Spec) and the EUCC statement. Correction the same day: that census counted a gated document as an absent one. `/hedex/api/navi/<id>/first-level-tree` answers in three states - 200 public, **401 `NOT LOGIN!`** for a document that exists behind an account, 404 `No doc data found.` for an id that does not exist (controls: EDOC9999999999 and EDOC0000000000 404, EDOC1100447312 200) - and the Chinese product page for the E6616X links 176 ids of which 90 answer 200, **86 answer 401 and none 404**. The 86 include six 硬件描述 editions (R022C10 EDOC1100303423, R023C00 EDOC1100328735, R023C10 EDOC1100367203, R024C10 EDOC1100456168, R025C00 EDOC1100525984, R025C10 EDOC1100558549), the R026C00 产品文档 bundle EDOC1100625827, the E6616X快速安装指南 EDOC1100299473, the three E6616X release documents EDOC1100376749/50/51, and the English HD EDOC1100456166 the census had counted as absent. So the hardware description - the document whose chapters carry the board census - is published, not missing: it is login-gated. The boards-overview document the E6616 spec cites (EDOC1100156575BEJ09044) is not merely gated - its content endpoint /hedex/api/pages/EDOC1100156575/BEJ09044/01 answers 404 'No doc data found.' anonymously - and the downloadable package roots are closed at the root: V100R026C00 EDOC1100625826, V100R025C10 EDOC1100556468, V100R025C00 EDOC1100526008, V100R024C10 EDOC1100456079 and V100R023C10 EDOC1100366068 all 302, with the viewer PDF export /hedex/api/misc/<id>/pdf-dl-url answering 400 for each. Named 2026-11-18: the boards themselves, from a deployment rather than the vendor. A Ningbo Rail Transit Line 4 maintenance tender (135 pp, 91,554-char text layer) lists two E6616X in station equipment rooms, itemised as chassis **TM65K32AFB** + **65UXCL** (cross-connect/main control/clock) + **B2PD1** (2M processing) + **B2DMS** (2M interface) + `SSN1D75S` (32xE1/T1 75-ohm cable-out). So `TM65*` is the chassis and cross-connect prefix, not the service-board namespace as the R026 brochure's single `TM65UXCL` part number had suggested, and the X's 2M pair is the `B2` generation the price list calls `TMB2TPS` (1*DMS+2*PD1). What it does not give is the per-slot complement (every row is qty 1 - a spares list, not a built subrack), a port count for `B2DMS` alone, or the slot cost of the DMS+2xPD1 assembly - research/optixtrans-e6616x-deployment-board-inventory.md. Re-checked 2026-11-18 19:4x: the three chapters the last note named as candidates (TMB2PD1, TMB2DMS, TMB2TPS) are hosted by nobody but resellers - five search-engine queries on the e-file route that yielded (6)-UXCME and (21)-TMB3AUX return no Huawei-hosted asset for any of them, only verbatim reprints of the board chapters at szhuaxunjia.com/product/2298.html (TMB2DMS) and /2297.html (TMB2PD1). Those reprints do print the panel ("32 x 75-ohm/120-ohm E1 or 100-ohm T1") and a 配套关系 table naming E6616X with TM65UXCL from V100R022C10SPC010, but a re-hosted page is not a source. They also correct the criterion this entry has carried since 2026-11-17: the E6600 board chapters have no Valid Slots table at all - compatibility is expressed as a 配套设备 table, unlike the E9600 chapters - so asking for a Valid Slots table naming E6616X asks for a section this family never prints; the artifact is the TMB2DMS chapter itself - research/optixtrans-e6616x-2m-pair-chapter-format.md. Closed again 2026-11-18 21:2x: the OSN 1800 V substitution. The board chapters are linked under an `1800v/` hedex package path and `TMB2DMS` is sold as an OSN 1800 V Pro board, so a public OSN 1800 V hardware description would carry the same chapter - measured against seven editions on `optix-osn-1800-v-pro-pid-250732494` (EDOC1100558550, EDOC1100525975, EDOC1100456158, EDOC1100303420, EDOC1100249290, EDOC1100192279, and Product Description EDOC1100558552): every one answers 401 NOT LOGIN to `/hedex/api/navi/<id>/first-level-tree`, against controls answering 200 (EDOC1100447312) and 404 (EDOC9999999999) in the same minute - research/optixtrans-osn1800v-hd-also-gated.md. Re-checked 2026-11-18 21:5x: the gate is now measured by a script instead of by hand - `scripts/huawei-doc-gate-probe.js` probes `/hedex/api/navi/<id>/first-level-tree` for the 30 ids in `research/huawei-gated-docs.json` and exits non-zero when any state has moved. Baseline today: 27 `gated`, 2 `public` (the joint OSN 1800/E6600/DC908 web-UI guide and a public guide), 1 `absent` (EDOC9999999999) - no E6600 or OSN 1800 V Pro hardware description, board chapter, Quick Installation Guide or documentation package in the list is anonymously readable. Newly listed, not newly readable: the 26H2 set is on the portal as `EDOC1100625826` (V100R026C00 Product Documentation 01) with `EDOC1100625831` Feature Description and `EDOC1100625925` Upgrade Guide, all 401 - research/huawei-gated-doc-probe.md. Narrowed 2026-11-18 23:5x UTC: the E6616X has its own vendor spec sheet - `OptiXtrans E6616X Product Brochure` (216,145 B, 4 pp) rates the box at 680 Gbit/s OTN, 680 Gbit/s OSU, 800 Gbit/s packet, 100 Gbit/s grey per channel with line rates of 2.5/10/100 Gbit/s, 14/12 service board slots - so every frame field is sourced and the one missing item is a service-board part number valid in it plus that board's front-panel census. The E6616 row (14x B1LDCD, 100G/200G CFP2 DWDM line) cannot be reused: the E6616X sheet caps per channel at 100G grey and gives it no wavelength plan, and `E6616X` occurs zero times in the 22,964-character E6616 datasheet text. The leaflet class is measured shut too (E6616X brochure, the Chinese 产品彩页 .docx and the Railway 26H1 brochure: zero service-board part numbers between them). research/optixtrans-e6616x-grey-ceiling-and-own-spec-sheet.md. | the TMB2DMS chapter from Huawei: EDOC1100558549 (OptiXtrans E6600 V100R025C10 硬件描述, any of the six editions the Chinese product page lists) behind the free-login wall, or a Huawei-hosted PDF of the same chapter on the e-file asset route. Corrected 2026-11-18: not a Valid Slots table - the E6600 chapters print 配套设备 instead. the board set to be modelled (e.g. `E6616X DC (12x <board>)`), or an E6600 ordering/configuration guide. Routes closed on 2026-11-17: the related-materials graph (40 pages, 27 numbered parts, enumerated in `research/optixtrans-e-file-numbered-bundle.md`), the vendor sitemap (713 pages, no E6600 board chapter), hedex (302/403 for every user-agent today, including the Dorado path that answered 200 this morning), and Wayback (no capture of the E6600 boards overview under three URL prefixes). Closed again on 2026-11-18: the E6600 product-page document list (299 ids counted, no board chapter), hedex's content API ('No doc data found.'), the R026/R025 documentation-package roots and the PDF-export endpoint - research/optixtrans-e6616x-anonymous-doc-census.md. Measured 2026-11-18: every E6600 technical document on the navi/content API answers 401 NOT LOGIN to an anonymous crawler, so the remaining step is an authenticated session, not a vendor publication - one free Huawei enterprise account reading OptiXtrans E6600 V100R025C10 硬件描述 01 (`EDOC1100558549`, newest edition listed) would open the board chapters; research/optixtrans-e6616x-docs-gated-not-unpublished.md. Narrowed 2026-11-18: the per-slot complement of one real subrack (commissioning record or NE inventory export: 'E6616X, TM65K32AFB, slots 1-14: n x <board>'), or a Huawei board chapter whose Valid Slots table names E6616X - candidates now TMB2PD1 / TMB2DMS / TMB2TPS for the 2M path, and the GDC / EX10 / EG10 (TMK1* by inference) Ethernet set the same document maintains - research/optixtrans-e6616x-deployment-board-inventory.md. Also recorded 2026-11-18: the E6616X Quick Installation Guide exists as two ids for one document - English `EDOC1100299472` (printed under Quick Start on the support page) and Chinese `EDOC1100299473` - both 401, so the Quick Start class is not a bypass of the Hardware Description gate. Shortest path as of 2026-11-18: one authenticated read of `EDOC1100625826` - the R026C00 (26H2) documentation package, newer than the R025C10 id this entry previously named - whose board chapters carry the `配套设备` table; `node scripts/huawei-doc-gate-probe.js` reports the moment it stops being 401. Note 2026-11-18: scripts/huawei-material-fetch.js had begun answering 403 on every material page (node's TLS client is fingerprinted; curl gets 200 with the same headers) and now fetches through curl - re-verified on `(2)-OptiXtrans E6616-Datasheet` (1,535,511 B) and `(21)-TMB3AUX` (482,177 B). |

Sources last read for each, so the next pass starts from the end of this one rather than
from the beginning:

- **#130** (2026-11-19) - <https://techspecs.ui.com/unifi/cloud-gateways>, <https://techspecs.ui.com/unifi/cloud-gateways/udw-pro>, <https://dl.ui.com/ds/udw-pro_ds.pdf>, <https://eu.store.ui.com/eu/en/category/all-cloud-gateways>, <https://fccid.io/SWX-UDW>, <https://dl.ui.com/ds/udw_ds.pdf>, <https://fccid.io/SWX>, <https://fccid.io/SWX/page/2>, <https://fccid.io/SWX/page/3>, <https://fccid.io/SWX/page/4>, <https://fccid.io/SWX/page/5>, <https://web.archive.org/web/20250218070534/https://store.ui.com/us/en/products/uacc-psu-udw>, <https://fw-update.ubnt.com/api/firmware?limit=1000&filter=eq~~product~~unifi-dream>, <https://fw-update.ubnt.com/api/firmware?limit=1000&filter=eq~~platform~~udw>, <https://fw-update.ubnt.com/api/firmware?limit=1000&filter=eq~~platform~~udwpro>, <https://fw-download.ubnt.com/data/unifi-dream/2d04-UDW-6.0.17-090536d9-3df7-4572-98b3-a909e9659630.bin>
- **#803** (2026-11-18) - <https://e.huawei.com/en/products/optical-transmission/optixtrans-e6600>, <https://e.huawei.com/en/documents/others/621bfc22e8564cf69ae86581569a7594>, <https://e.huawei.com/sitemap-ebg-x-default.xml>, <https://e-file.huawei.com/marketingcloud/pep/asset/20000001/Material/104eb87894f1489dac28e58171dca5cc/M3T1A669N1304590990909157504/_21_-TMB3AUX.pdf>, <https://e-file.huawei.com/marketingcloud/pep/asset/20000001/Material/5fa3c10e4f454dfaa44f26447563718d/M3T1A669N1304588494599672043/_6_-UXCME.pdf>, <https://e-file.huawei.com/marketingcloud/pep/asset/20000001/Material/e650e67ac43a4b169fd5001518bd346d/M3T1A669N1178212931847860258/eSFP_1550_12nm_125M%20to%202_67Gbps_0%20to%204_0dBm_-28_0dBm_LC_120km.pdf>, <https://e.huawei.com/en/documents/others/104eb87894f1489dac28e58171dca5cc>, <https://support.huawei.com/enterprise/zh/optical-transmission/optixtrans-e6616x-pid-257173887>, <https://support.huawei.com/hedex/api/navi/EDOC1100558549/first-level-tree>, <https://support.huawei.com/hedex/api/navi/EDOC1100456166/first-level-tree>, <https://support.huawei.com/hedex/api/navi/EDOC9999999999/first-level-tree>, <https://support.huawei.com/hedex/api/navi/EDOC1100447312/first-level-tree>, <http://ygcg.nbcqjy.org:8061/down/c1e5edbe-2560-4ddc-a308-0c0d66b1bacf/%E7%94%A8%E6%88%B7%E9%9C%80%E6%B1%82%E4%B9%A6-4.13.pdf>, <https://www.szhuaxunjia.com/product/2298.html>, <https://www.szhuaxunjia.com/product/2297.html>, <https://support.huawei.com/enterprise/en/optical-transmission/optix-osn-1800-v-pro-pid-250732494>, <https://support.huawei.com/hedex/api/navi/EDOC1100525975/first-level-tree>, <https://support.huawei.com/enterprise/en/doc/EDOC1100299472>, <https://support.huawei.com/enterprise/en/optical-transmission/optixtrans-e6616x-pid-257173887>, <https://support.huawei.com/hedex/api/navi/EDOC1100625826/first-level-tree>, <https://support.huawei.com/hedex/api/navi/EDOC1100625921/first-level-tree>, <https://e.huawei.com/marketingcloud/pep/asset/20000001/Material/6fffa7f348f9475081b17eb1fc591b10/M1T1A669N837008945971838990/OptiXtrans%20E6616X%20Product%20Brochure.pdf>, <https://e-file.huawei.com/marketingcloud/pep/asset/20000001/Material/6c94817240a44b19bb49566f0634ea9e/M3T1A590N1246470205869879492/OptiXtrans%20E6616%20V100R025C10%20%E4%BA%A7%E5%93%81%E5%BD%A9%E9%A1%B5.docx>, <https://e-file.huawei.com/marketingcloud/pep/asset/20000001/Material/00a9d517b714455ca0d59d9d8f2e5a2f/M3T1A669N1272073348910575792/Railway%20Optical%20Communication%20Network-Brochure_26H1_-TR.pdf>
<!-- open-requests:end -->
