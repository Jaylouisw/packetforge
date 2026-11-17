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

**2,348 models across 258 vendors**, and it grows every time somebody's hardware is
added. The largest vendors by model count:

| vendor | models | | category | models |
|---|---:|---|---|---:|
| MikroTik | 366 | | router | 381 |
| Ubiquiti | 368 | | switch | 426 |
| Aruba | 73 | | point-to-point | 212 |
| Huawei | 94 | | wireless | 220 |
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

Seven hardware requests are open and cannot be modelled yet. Not one of them is blocked on
research effort: in every case the vendor publishes the field *type* and not its *value*,
and the value is what a spec needs. This table is generated from
`research/open-device-requests.json` - `npm run regen:registry-doc` after editing it, and the
issue threads stay the place where each one is argued.

| issue | model(s) | the field the vendor does not publish | what would unblock it |
|---:|---|---|---|
| 130 | Ubiquiti UniFi Dream Wall Pro (UDW-PRO) | the whole port layout, and the product itself: the SKU is not in Ubiquiti's cloud-gateway index (`udw-pro` occurs zero times in 610,409 B of it), `techspecs.ui.com/unifi/cloud-gateways/udw-pro` redirects to the site root, and `store.ui.com/.../udw-pro` is a 404. Three further surfaces were checked and are empty (2026-11-17): the EU storefront publishes only `udw-eu`, the 420 W UDW; no FCC grant exists under `SWX-UDWPRO`, `SWX-UDW-PRO` or `SWX-UDW2` (all 303, against 200 for `SWX-UDW`); and Wayback holds no capture of any of the four `udw-pro` URLs. Ubiquiti's early-access copy names "the Dream Wall and Dream Wall Pro (UDW/UDW Pro)" and then lists only the UDW's ports, beside "Dream Wall Pro - Coming Soon". The published datasheet `dl.ui.com/ds/udw_ds.pdf` is the non-Pro Dream Wall. | a Ubiquiti page, datasheet, FCC exhibit or quick-start guide that names UDW-PRO's ports and PoE budget, or the requester confirming they meant the UDW (already catalogued as `devices/ubiquiti/udw.json`). Modelling it from the non-Pro numbers is the family-sibling error this catalogue has already corrected. |
| 742 | Huawei OceanProtect E8000 | front-end port count per node. The V200R001C20 data sheet (4-slide pptx) and the product page both stop at port *types* - `16/32/64 Gb FC, 10/25/40/100 GbE` - because the count is a function of the controllers and interface cards ordered. | a controller/interface-card configuration, or an ordering guide that pins ports per base model. The same field is missing for #743. |
| 743 | Huawei OceanProtect X8100 / X9100 | per-model interface-module configuration: which slots take front-end modules and how many ports each module type has. The slot half is vendor-sourced (white paper: twelve hot-swappable IOMs per enclosure, six slots per controller); the port half is not. The books that carry it (`EDOC1100368229` / `EDOC1100368230` Product Description, `EDOC1100305240` / `EDOC1100305243` Hardware Installation Guide) are only served section-by-section and their section slugs are not indexed. | one section URL from either Product Description, or a stated configuration (e.g. "X8100 with a 4-port 10GE electrical module in IOM 0 and IOM 1"). X8100 and X9100 are different enclosures and get separate specs. |
| 803 | Huawei OptiXtrans E6616X | the service-board part number valid in an E6616X subrack, and that board's front-panel census. Correction (2026-11-17): the E6600 board documentation is not confined to the closed hedex tree - it is published one chapter per PDF on `e-file.huawei.com`, anonymous, and two board chapters were fetched and read today: `(6)-UXCME` (TMK5UXCME system control, 590,457 B) and `(21)-TMB3AUX` (auxiliary board, 482,177 B). Neither is a client board, and neither carries a `Valid Slots` table (zero occurrences), unlike the E9600 board chapters - so even a client-board chapter may not state which subrack accepts it. The 27-part numbered bundle those chapters belong to is now enumerated exhaustively and holds no client board. The E6616 chassis chapter (20 pp, `(2)-OptiXtrans E6616-Datasheet`) remains slot layout plus per-system-board capacity, with no port table. | the board set to be modelled (e.g. `E6616X DC (12x <board>)`), or an E6600 ordering/configuration guide. Routes closed on 2026-11-17: the related-materials graph (40 pages, 27 numbered parts, enumerated in `research/optixtrans-e-file-numbered-bundle.md`), the vendor sitemap (713 pages, no E6600 board chapter), hedex (302/403 for every user-agent today, including the Dorado path that answered 200 this morning), and Wayback (no capture of the E6600 boards overview under three URL prefixes). |
| 807 | Huawei OptiXtrans E9605 | the client board census - one TNG1N*/TNG1M* chapter with a Port Specifications table. The frame half is fully vendor-sourced: `TNG2DAP` section 1.9 gives E9605 = IU1-IU5, and the E9605 subrack chapter gives PIU/APIU IU100-IU101, EFI IU71-IU72 (`"The EFI board offers maintenance and management interfaces"`), fan IU90, five service boards in IU1-IU5, two CTU boards, 177 x 442 x 260 mm. What is missing is not findable by search: the vendor sitemap indexes 713 document pages and holds exactly two board chapters, both optical-layer (TNG2DAP EDFA, TNG3SRAPXF Raman+EDFA), with TNG1N*/TNG1M*/TNG1T*/TNV*/TNK*/TMB1* occurring zero times. | one TNG1N* or TNG1M* chapter PDF, or a stated configuration plus that board's Port Specifications table (e.g. "E9605 with 5x TNG1N210"). Access, not effort: the remaining routes are `EDOC1100621488` and `EDOC1100163901` behind the Huawei account wall. |
| 808 | Huawei OptiXtrans E9612 | the same client board chapter (TNG1N*/TNG1M*) - and the slot count is NOT mode-independent, which the earlier record had wrong. The E9612 subrack chapter gives 13 service slots (IU1-IU13) only in the E3CTU DC build: the older AUX+SCC layout is 12 (IU1-IU12) on DC, and under AC/HVDC power one APIU occupies IU1 and IU2 physically, leaving 10 (master) / 11 (slave); the E3CTU AC/HVDC build is IU3-IU13 = 11. So `IU1-IU13` in `TNG2DAP` section 1.9 is the E3CTU DC figure. | one client board chapter, plus the power option and subrack layout to model (E3CTU DC = 13, AUX+SCC DC = 12, AC/HVDC = 10 or 11). No protection mode is needed. |
| 810 | Huawei OptiXtrans E9624 | the same client board chapter (TNG1N*/TNG1M*), plus the protection mode, which decides the port count: 1:1 gives 12 large or 24 small slots, 1:3 gives 10 or 20, and IU6/IU7/IU18/IU19 are unusable in 1:3. The frame arithmetic is settled and vendor-sourced (`TNG2DAP` section 1.9 and the E9600 family brochure); the board chapters are absent from the vendor sitemap, so this is an access problem, not a search problem. | one client board chapter plus the protection mode to model (1:1 or 1:3). With both, the product is a stated card complement - `E9624 (24x <board>)` - and needs no guessing. |

Sources last read for each, so the next pass starts from the end of this one rather than
from the beginning:

- **#130** (2026-11-17) - <https://techspecs.ui.com/unifi/cloud-gateways>, <https://eu.store.ui.com/eu/en/category/all-cloud-gateways>, <https://fccid.io/SWX-UDW>, <https://dl.ui.com/ds/udw_ds.pdf>
- **#742** (2026-11-17) - <https://e.huawei.com/en/products/storage/oceanprotect/oceanprotect-e8000>, <https://e.huawei.com/en/documents/products/storage/597eb7d1363f4b5da0d4ad663da1f7b6>
- **#743** (2026-11-17) - <https://e.huawei.com/en/products/storage/oceanprotect/x100-series>, <https://support.huawei.com/enterprise/en/data-protection/oceanprotect-x8100-pid-268353477>
- **#803** (2026-11-17) - <https://e.huawei.com/en/products/optical-transmission/optixtrans-e6600>, <https://e.huawei.com/en/documents/others/621bfc22e8564cf69ae86581569a7594>, <https://e.huawei.com/sitemap-ebg-x-default.xml>, <https://e-file.huawei.com/marketingcloud/pep/asset/20000001/Material/104eb87894f1489dac28e58171dca5cc/M3T1A669N1304590990909157504/_21_-TMB3AUX.pdf>, <https://e-file.huawei.com/marketingcloud/pep/asset/20000001/Material/5fa3c10e4f454dfaa44f26447563718d/M3T1A669N1304588494599672043/_6_-UXCME.pdf>, <https://e-file.huawei.com/marketingcloud/pep/asset/20000001/Material/e650e67ac43a4b169fd5001518bd346d/M3T1A669N1178212931847860258/eSFP_1550_12nm_125M%20to%202_67Gbps_0%20to%204_0dBm_-28_0dBm_LC_120km.pdf>, <https://e.huawei.com/en/documents/others/104eb87894f1489dac28e58171dca5cc>
- **#807** (2026-11-17) - <https://support.huawei.com/enterprise/en/optical-transmission/optixtrans-e9605-pid-250732995>, <https://e-file.huawei.com/marketingcloud/pep/asset/20000001/Material/e75c775ac71144e6b522d7cef1601604/M3T1A669N1188254864652623965/TNG2DAP%20-.pdf>, <https://e-file.huawei.com/marketingcloud/pep/asset/20000001/Material/cc7356212e6146b58f38b74dd1102e08/M3T1A669N1188254859704168616/OptiXtrans%20E9605%20-.pdf>, <https://e.huawei.com/sitemap-ebg-x-default.xml>
- **#808** (2026-11-17) - <https://support.huawei.com/enterprise/en/optical-transmission/optixtrans-e9612-pid-250733000>, <https://e-file.huawei.com/marketingcloud/pep/asset/20000001/Material/e75c775ac71144e6b522d7cef1601604/M3T1A669N1188254864652623965/TNG2DAP%20-.pdf>, <https://e-file.huawei.com/marketingcloud/pep/asset/20000001/Material/1df5f09736174bdcaed9ea4e9276bf8b/M3T1A669N1188254859888107676/OptiXtrans%20E9612%20-.pdf>, <https://e.huawei.com/sitemap-ebg-x-default.xml>
- **#810** (2026-11-17) - <https://support.huawei.com/enterprise/en/optical-transmission/optixtrans-e9624-pid-250733004>, <https://e-file.huawei.com/marketingcloud/pep/asset/20000001/Material/e75c775ac71144e6b522d7cef1601604/M3T1A669N1188254864652623965/TNG2DAP%20-.pdf>, <https://e.huawei.com/sitemap-ebg-x-default.xml>
<!-- open-requests:end -->
