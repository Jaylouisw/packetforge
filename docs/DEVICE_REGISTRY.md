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
| 130 | Ubiquiti UniFi Dream Wall Pro (UDW-PRO) | the whole port layout: the SKU is not in Ubiquiti's own cloud-gateway index (sixteen cards, `udw-pro` occurs zero times), `techspecs.ui.com/unifi/cloud-gateways/udw-pro` redirects to the site root and `store.ui.com/.../udw-pro` answers 404. The published datasheet `dl.ui.com/ds/udw_ds.pdf` is the non-Pro Dream Wall. | a Ubiquiti page, datasheet or quick-start guide that names UDW-PRO's ports and PoE budget. Modelling it from the non-Pro numbers is the family-sibling error this catalogue has already corrected. |
| 742 | Huawei OceanProtect E8000 | front-end port count per node. The V200R001C20 data sheet (4-slide pptx) and the product page both stop at port *types* - `16/32/64 Gb FC, 10/25/40/100 GbE` - because the count is a function of the controllers and interface cards ordered. | a controller/interface-card configuration, or an ordering guide that pins ports per base model. The same field is missing for #743. |
| 743 | Huawei OceanProtect X8100 / X9100 | per-model interface-module configuration: which slots take front-end modules and how many ports each module type has. The slot half is vendor-sourced (white paper: twelve hot-swappable IOMs per enclosure, six slots per controller); the port half is not. The books that carry it (`EDOC1100368229` / `EDOC1100368230` Product Description, `EDOC1100305240` / `EDOC1100305243` Hardware Installation Guide) are only served section-by-section and their section slugs are not indexed. | one section URL from either Product Description, or a stated configuration (e.g. "X8100 with a 4-port 10GE electrical module in IOM 0 and IOM 1"). X8100 and X9100 are different enclosures and get separate specs. |
| 803 | Huawei OptiXtrans E6616X | the service-board part number valid in an E6616X subrack, and that board's front-panel census. The E6600 generation publishes its board list only inside the closed hedex tree. | the board set to be modelled (e.g. "E6616X with two TN13LSC"), or one section URL from the E6600 board chapter. |
| 807 | Huawei OptiXtrans E9605 | the board-to-subrack matrix. Every frame's support page links `OptiXtrans E9600 Board Datasheet` (`EDOC1100163901`) and every anonymous route to it answers `view/notFound`, while a control section URL on the same host returns 200 - so the matrix is withheld, not unpublished. | that one document. The frame arithmetic is already settled from vendor text, and the stated configuration is ready: E9605 (5x TNG1N210) = 50 x 10G. |
| 808 | Huawei OptiXtrans E9612 | the same board-to-subrack matrix (`EDOC1100163901`), plus the cross-connect mode, which decides whether the frame is modelled with 13 service slots or fewer. | the board datasheet, and a stated cross-connect mode. |
| 810 | Huawei OptiXtrans E9624 | the same board-to-subrack matrix (`EDOC1100163901`), plus the protection mode: 1:1 gives 12 large or 24 small slots, 1:3 gives 10 or 20, and slots IU6, IU7, IU18 and IU19 are unusable in 1:3 (read from `TNG2DAP`'s Valid Slots table). | the board datasheet plus the protection mode to model. |

Sources last read for each, so the next pass starts from the end of this one rather than
from the beginning:

- **#130** (2026-11-17) - <https://techspecs.ui.com/unifi/cloud-gateways>, <https://dl.ui.com/ds/udw_ds.pdf>
- **#742** (2026-11-17) - <https://e.huawei.com/en/products/storage/oceanprotect/oceanprotect-e8000>, <https://e.huawei.com/en/documents/products/storage/597eb7d1363f4b5da0d4ad663da1f7b6>
- **#743** (2026-11-17) - <https://e.huawei.com/en/products/storage/oceanprotect/x100-series>, <https://support.huawei.com/enterprise/en/data-protection/oceanprotect-x8100-pid-268353477>
- **#803** (2026-11-17) - <https://e.huawei.com/en/products/optical-transmission/optixtrans-e6600>
- **#807** (2026-11-17) - <https://support.huawei.com/enterprise/en/optical-transmission/optixtrans-e9605-pid-250732995>
- **#808** (2026-11-17) - <https://support.huawei.com/enterprise/en/optical-transmission/optixtrans-e9612-pid-250733000>
- **#810** (2026-11-17) - <https://support.huawei.com/enterprise/en/optical-transmission/optixtrans-e9624-pid-250733004>, <https://e.huawei.com/marketingcloud/pep/asset/20000001/Material/e75c775ac71144e6b522d7cef1601604/M3T1A669N1188254864652623965/TNG2DAP%20-.pdf>
<!-- open-requests:end -->
