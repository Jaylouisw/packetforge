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
| `category` | yes | `router`, `switch`, `l3-switch`, `firewall`, `tap`, `host`, `server`, `wireless`, `ptp`, `cloud`, `olt`, `ont`, `splitter`, `modem`, `powerline`, `nas`, `desktop`, `laptop`, `phone`, `tablet`, `printer`, `camera`, `nvr`, `iot` |
| `capabilities` | yes | drives the engine — see below |
| `interfaces` | one of | explicit array; per-port keys below |
| `portTemplate` | one of | generates N ports: `{prefix,start,count,type,speed}` plus any port key |
| `description` | no | tooltip — and CI audits it against the ports the spec declares |
| `sourceUrl` | recommended | the datasheet the numbers came from (1,276 of 1,626 specs carry one). **22 more carry `source` instead** — the older spelling of the same idea, never both — so 1,298 of 1,626 point at a datasheet somewhere |
| `notes` | no | research note kept beside the spec, quoted rather than paraphrased |
| `poeBudget` | no | PSE budget in watts; research-sourced specs use `poe: {"budgetW": 240}` instead |
| `passive` | no | `true` for a passive tap or splitter — no capabilities, no software |
| `role` | no | free-form hardware role, e.g. `["midspan","managed"]` |
| `technology` | no | e.g. `"TFF"`, `"mechanical splice / adapter panel"` |
| `icon` | no | one of the built-in icons (or any emoji) |
| `color` | no | accent color (hex) |

Per-port keys, all optional except the first three: `name`, `type`, `speed`, `connector`
(the cage — see [CONNECTORS.md](CONNECTORS.md) for all 26), `speedCaps` (the rates the cage
accepts), `poeOut` / `poeOutClass`, `poeIn`, `comboWith` / `comboRole`, `bridgeGroup`, `role`.

A port may also carry a **nested `hardware` block**, and it is the one place in the schema where
writing a key that looks right does nothing at all. `derivePortHardware()` (`engine/media.js:987`)
reads `spec.hardware` for four keys and derives the rest from `connector` and `speed`, so only these
four are the spec's to decide:

| Inside `hardware` | Honoured? | Evidence (measured) |
|---|---|---|
| `poeOut` | **yes** | a probe port declaring `poeOut: 30` derives `hardware.poeOut === 30` |
| `poeIn` | **yes** | same path, `media.js:1002` |
| `speedCaps` | **yes** | a probe declaring `speedCaps: [42]` keeps `[42]` while its cage offers 11 media |
| `maxRangeM` | **yes** | `media.js:1010` |
| `cage` | **no** — overwritten | a probe declaring `cage: 'qsfp28'` with `connector: 'sfp+'` derives `cage === 'sfp+'` |
| `media` | **no** — overwritten | the same probe's `media: ['made-up']` becomes the sfp+ list |
| `maxSpeedMbps` | **no** — overwritten | the same probe's `1234` becomes `10000`, from `speed` |

The cage is the authority on what fits and what the port can carry, which is the whole point of
[CONNECTORS.md](CONNECTORS.md); a spec that contradicts its own `connector` is not believed. If the
cage is wrong, fix `connector`.

Exactly one file uses the nested form today — `devices/microchip/pd-9501g-sfp.json`, whose `poe-out`
port says `"hardware": { "poeOut": 60 }` — and both spellings are read, because the flat `poeOut` was
the original one:

```js
// engine/media.js:1001 — nested first, then flat, then silence
poeOut: hw.poeOut !== undefined ? hw.poeOut : (spec.poeOut !== undefined ? spec.poeOut : null),
```

`engine/cli.js` accepts either when it decides whether a port can source power, so a contributor may
use whichever the surrounding file already uses; prefer the flat key in a new spec, because it is the
form every example in this page shows and the one 51 of the 52 files that state a PoE rate use (the
catalogue's other 1,534 files state none at all, and the engine infers from the device class).

### Keys the catalogue carries that this table does not gate on

A survey of all 1,626 files finds **fourteen** top-level keys the schema table above never mentions — thirty-two exist in total, eighteen are in that table, and `poe` counts as documented because the `poeBudget` row names it. They matter
because a contributor copying an existing spec will meet them, and because **whether any code reads a
key decides whether it can change behaviour**. Measured with `grep -rn "\.<key>" engine/ web/ server/`:

| Key | Files | Read by | Effect |
|---|---|---|---|
| `insertionLossDb` | 13 | `engine/optical.js` | **real** — the loss a passive part adds to a PON budget |
| `formFactor` | 7 | `engine/optical.js`, `web/app.js` | **real** — which cage a transceiver fits, and its label |
| `splitRatio` | 11 | `engine/validation.js` | **real** — a splitter's fan-out, and its loss |
| `dualRole` | 2 | `engine/device.js`, `web/`, `server/` | **real** — e.g. a WAN/LAN combo port |
| `comboPorts` | 15 | nothing in `engine/`, `web/`, `server/` — written by `scripts/apply-research.js` | **annotation**: the pairing itself is expressed by per-port `comboWith`/`comboRole` |
| `source` | 22 | nothing that reads a device spec | annotation: a datasheet **URL** in the older spelling. `sourceUrl` is the key the registry exposes and the one the "1,276 of 1,626" coverage count above uses, so a spec carrying only `source` counts as uncovered (22 do; none carry both) |
| `returnLossDb`, `channelCount`, `channelPlan`, `monitorTapDb`, `insertionLossTypicalDb`, `bypassInsertionLossDb`, `attenuationRangeDb`, `attenuationStepDb`, `isolationDb`, `portSplitNote` | 1–12 each | nothing | annotation: figures a datasheet gives for a passive optical part (CWDM muxes, VOAs, taps, attenuators) |

The annotation keys all sit on passive hardware under `devices/fs/` and similar: they record what the
part *is* without claiming the model simulates it. Adding one is harmless; expecting it to change a
simulation is not. The rule for a new spec is the same one this table has always implied — if you want
a key to matter, it has to be read somewhere, and if it is read, it belongs in the schema table above.

`poeOut` on a port is the strongest statement in the file: it is read before any inference
(`isPoePse` only fills in a value when the port declares nothing). `poeOutClass` beside it is
**pure annotation** — `"PoE++"`, `"PoE+"`, `"PoE"` — and `grep -rn poeOutClass engine/ web/
server/ scripts/` returns nothing: no code parses it, so it documents intent and changes no
behaviour. Only the `rj45` and `combo` cages carry power at all, so a `poeOut` on a fibre cage is
ignored rather than honoured.

Because that key overrules the prose, the two can disagree — and four specs once did: on
`ubiquiti/UISP-FIBER-XG`, `UA-Hub-Door-Mini`, `UA-G2-SK-Pro` and `UA-Hub-Gate`, `eth0` carried
`"poeOut": true` while the same file's `description` said the unit was *PoE-powered*. The engine
believed the port, so those four supplied power their prose said they consumed, and
`test/spec-vs-description.test.js` failed on exactly them. **The descriptions were the thing that
changed**: all four now read *"1x PoE++ passthrough"* (measured — the `poeOut` key never moved), so the
port and the prose agree and the suite is green. That is the shape of the fix to prefer: the port key is
the model's truth, so either the prose or the port is wrong, and correcting the prose is a one-line
edit that leaves the simulation unchanged.

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

### What the catalogue cannot represent

Some hardware requests describe something with no interface at all, and those are declined
rather than padded into the schema:

- **passive RF accessories** - radomes, RF isolator shields, coaxial duplexers and NxN MIMO
  multiplexers. They have no Ethernet, console, optical or DSL port, no address and no
  management surface, so a spec would be a name with an empty `interfaces` array. The palette
  would then offer a lab something that *looks* cabledable and is not - which is worse than the
  request staying open.
- **bundles** - a "kit" of router plus mesh points is not a model. Its parts are the models.
- **components** - parts that must be installed *inside* something else to exist: miniPCIe and
  M.2 modems, chassis line cards, and TAP modules that slot into a rack chassis. A component has
  no enclosure of its own and no ports until it is seated, so the device that hosts it is the
  catalogue entry and the component is a fact about that device (which modem, which line card),
  not a node in a topology.
- **software** - a backup, controller or management *application*. There is no box and no port to
  cable; the hardware it runs on is the device, and if that hardware is already in the catalogue
  the request is answered.

The distinction that matters when closing a request: an accessory or component is **structurally**
unrepresentable (nothing to simulate on its own), while a device that merely lacks a published
figure - say a switch whose PoE budget the vendor never quotes - stays **open**, because that is a
gap in the source, not in the simulator. Never invent the figure to close it.

## Reading the catalogue in code

`loadCatalog(dir)` walks `dir` recursively and returns an array of spec objects. Two things about it
are worth knowing before you call it:

- **Give it an absolute path.** `loadCatalog('devices')` returns **1,626 entries and every one of them
  is an error**: the helper `require()`s `path.join(dir, …)`, and a relative path with no leading `./`
  is read as a *module specifier*, so nothing resolves. The `catch` that exists to survive one
  malformed spec then swallows the whole directory. `path.resolve('devices')` works; `__dirname` from
  inside the module is what `engine/` and `scripts/` use.
- **A file it cannot parse becomes a row, not an exception.** The shape is
  `{ vendor: 'error', model: '<filename>', label: 'Broken spec', error: '<message>' }`, so a caller
  that counts entries without filtering `d => !d.error` will report a model total one higher than the
  catalogue actually has. There are no error rows on this tree.

## Capabilities

Fifteen, as enumerated in `engine/device.js` (`CAPABILITIES`):

`host`, `l2-forward`, `l3-forward`, `cli`, `dhcp-server`, `dhcp-client`, `nat`, `firewall`,
`wireless`, `http-server`, `poe-pse`, `poe-pd`, `vlan`, `lacp`, `stp`.

**Three gate forwarding, five more are read, and seven are pure labels.** The reads:

| Capabilities | Read by | Effect |
|---|---|---|
| `host`, `l2-forward`, `l3-forward` | `Device.isHost()`, `isL2()`, `isL3()` | forwarding: terminate, bridge (MAC learning, VLAN tagging, STP), route |
| `poe-pse`, `poe-pd` | `isPoePse()` / `isPoePd()` in `engine/media.js` | whether the device is treated as sourcing / drawing power when ports are derived |
| `cli`, `dhcp-server`, `http-server` | `SERVICE_PORTS` in `engine/flow.js` | which ports a transport flow can terminate on — SSH/Telnet 22/23, DHCP 67, HTTP/HTTPS 80/443 |

`nat`, `firewall`, `wireless`, `dhcp-client`, `vlan`, `lacp` and `stp` are **not read anywhere**.
The features they name work from configuration and port hardware instead:

- DHCP server: `ip dhcp pool` in the running config; client: `ip address dhcp`,
- NAT: `nat` rules, filtering: `access-list` + `ip access-group` bindings,
- PoE: `poeOut` / `poeIn` on the port hardware,
- VLANs: `switchport` on the interface, LAG: `channel-group`, STP: implied by `isL2()`.

All fifteen are still worth setting: the device panel shows them as chips (`web/app.js`), several
suites assert them on specific models, and a reviewer reads them as the spec's intent. Useful
shapes:

- a **PC** is `["host","cli","dhcp-client"]`,
- an **L2 switch** is `["l2-forward","cli"]`,
- a **router** is `["l3-forward","cli","nat","dhcp-server"]`,
- an **L3 switch** is `["l2-forward","l3-forward","cli"]`.

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

A spec decides what is **drawn**, not every spelling that will be accepted. RouterOS
silkscreens `SFP+1` and calls it `sfp-sfpplus1`, so both are legal on the command line: the
`PORT_NAME_RULES` in `engine/iface-name.js` fold the console spelling onto the panel spelling
and every command that names a port resolves through them ([CLI.md § Port names](CLI.md)).
Writing `sfp-sfpplus1` in a spec is therefore fine — it is a real name an operator will type —
but the alias table is what makes the *other* spelling work.

### Optical cages

A port is copper RJ45 unless you say otherwise. For an optical port set
`connector` — `sfp`, `sfp+`, `sfp28`, `sfp56`, `xfp`, `qsfp+`, `qsfp28`, `qsfp56`, `qsfpdd`, or one
of the Fibre Channel cages (`fc-sfp`, `fc-sfp28`, `fc-sfpdd`, `fc-qsfp28`) — and give the speeds
the cage accepts in `speedCaps`. [CONNECTORS.md](CONNECTORS.md) holds the complete table of all 26
cages, what each mates with and which media it carries; guessing at the list here is how the two
drift apart.

```json
{ "name": "Gi1/1/1", "type": "ethernet", "speed": "10G",
  "connector": "sfp+", "speedCaps": [1000, 10000] }
```

Getting this wrong is the most common spec bug: a switch described as having
SFP+ uplinks but modelled with all-copper ports will *refuse* a fibre link that
the real hardware accepts, and *offer* copper where it does not fit. CI checks
every description against the ports it declares.

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
| `lc-upc` | LC | UPC, flat | blue | `lc-upc` only |
| `lc-apc` | LC | APC, angled 8° | green | `lc-apc` only |
| `mpo` | MPO | UPC, flat | aqua | `mpo` — ferrule only, no cage (ribbon optics ride in QSFP cages) |

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

## Correcting an existing spec with researched facts

Adding a device is one JSON file. **Fixing** one — a PoE budget nobody wrote down, a port layout
that was inferred from the model name — goes through `scripts/apply-research.js`, which refuses to
write anything it cannot check. It is the only supported path to those fields, and it is what the
`poe.budgetUnknown` escape hatch above is for.

```bash
node scripts/apply-research.js research/incoming/aruba-poe.json --dry-run
node scripts/apply-research.js research/incoming/aruba-poe.json
```

The input is a JSON document with a `poe` array and/or a `ports` array:

```json
{ "poe":   [ { "vendor": "aruba", "model": "CX 6100 48G", "poeBudgetW": 370, "sourceUrl": "https://…" } ],
  "ports": [ { "vendor": "aruba", "model": "CX 6100 48G", "rj45Count": 48, "sfpCount": 4,
               "sfpType": "sfp+", "sfpSpeedsMbps": [1000, 10000], "sourceUrl": "https://…" } ] }
```

`--dry-run` prints what it would do and writes nothing; without it every accepted entry is written
into the device file. Five refusals were measured against a fixture catalogue, each naming the
reason rather than failing quietly:

```
[dry run] Applied 2, recorded unknown 0, rejected 5
  + acme/ACME-SW24  370 W
  + acme/ACME-SW24  2x rj45 + 2x sfp+

REJECTED acme/ACME-SW24: budget 5000 outside a plausible 30-4000 W
REJECTED acme/ACME-SW24: no source URL - unverifiable
REJECTED acme/ACME-NOPE: no matching device spec
REJECTED acme/ACME-SW24: device has 4 ports (template + explicit, combo counted once) but research says 24 rj45 + 4 sfp = 28
REJECTED acme/ACME-SW24: sfpType "rj45" is not a known cage
```

- **A `sourceUrl` is mandatory.** An unverifiable claim is rejected rather than written. The
  catalogue is not uniformly there yet: **46** devices carry a numeric `poe.budgetW` and **4** of them
  have no `poe.sourceUrl` (`antaira/LNP-0800G-24-T`, `axis/S3008`, `dahua/NVR5216-16P-4KS2E`,
  `microchip/PD-9501G-SFP`) because they were written by hand before the applier existed. Those are
  the entries a research pass can still improve, and re-running the applier with their datasheets is
  what would close them.
- **The budget must be plausible** — 30 to 4000 W — so a datasheet figure copied in the wrong unit is
  caught instead of shipped.
- **`poeBudgetW: null` is a fact, not a blank.** It means "researched, and the datasheet does not say",
  and is recorded as `{ "budgetW": null, "budgetUnknown": true, "sourceUrl": …, "note": … }` with the
  line `~ vendor/model  budget NOT FOUND (recorded as unknown)`.
- **An existing different value is not overwritten without `--force`**:
  `REJECTED acme/ACME-SW24: existing budget 300 W differs from researched 370 W (use --force to overwrite)`.
  With `--force` the same run prints `+ acme/ACME-SW24  370 W (was 300)`.
- **Port counts are checked against the expanded hardware, not the raw array** — a `portTemplate` that
  generates 24 ports plus four explicit SFP entries is 28 positions, and a combo cage counts once.
  When research says the *tail* of a template should be optical, the applier splits the template:
  copper keeps the template, the optical tail is written out explicitly with `speedCaps` taken from
  `sfpSpeedsMbps`, and the run prints `(template split)`.

Exit status is `1` if anything was rejected, so a CI step or a research agent can tell "wrote
everything" from "wrote some of it", and the output always ends with the
`Applied N, recorded unknown M, rejected K` line. `PF_DEVICES` points the applier at a fixture
catalogue instead of `devices/`, which is how `test/apply-research.test.js` covers it without
touching the real tree.

## Included catalog

**1,626 models across 246 vendors**, one JSON file each, in 25 distinct `category` values
(24 palette buckets — every AP is filed `wireless`; a single spec still carries the legacy `ap`
value, `huawei/WiFi Extender AX3000`). The last one has a visible cost worth knowing: the palette's
type filter is built by walking `CAT_ORDER` in `web/app.js`, so a category outside that list gets no
entry in the dropdown and the device is reachable only through palette **search**. Count them
yourself:

```bash
node scripts/audit-devices.js          # models, vendors, ports, cablability
node scripts/missing-devices.js        # what the catalogue is still missing
```

The catalogue spans routers, switches, L3 switches, firewalls, taps, hosts, servers, wireless
APs, PTP radios, OLTs, ONTs, splitters, modems, powerline/MoCA adapters, NAS, desktops, laptops,
phones, tablets, printers, cameras, NVRs, IoT and cloud. Vendor coverage runs from Cisco, Juniper,
Arista, HPE/Aruba and Huawei to MikroTik, Ubiquiti, Zyxel, TP-Link, Calix, Nokia, Fiberhome,
Raritan and Vertiv.
