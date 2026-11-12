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
| `sourceUrl` | recommended | the datasheet the numbers came from (1,313 of 1,661 specs carry one). **20 more carry `source` instead** — the older spelling of the same idea, never both — so 1,333 of 1,661 point at a datasheet somewhere |
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
writing a key that looks right does nothing at all. `derivePortHardware()` (`engine/media.js:875` — this page said 987, which is inside a different function now)
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
form every example in this page shows and the one **55 of the 62** files that state a port PoE rate use.
The other seven split into six that set it on `portTemplate` and never per-port, and the one nested file
named above. Two refinements that only show up when you count all three spellings rather than the files
that use each: **nine** files set `portTemplate.poeOut`, not six — three Peplink PLS boxes
(`pls-24-h2g-410w`, `pls-48-h2g-740w`, `pls-r-24-h2g-250w`) restate it per-port on 8, 16 and 8 interfaces
at the same 30 W, so the redundancy is harmless but the file does carry the rate twice — and there is no
`poe.poeOut` anywhere, so the nested form means `interfaces[].hardware.poeOut` and nothing else. The
catalogue's other **1,599** files state no rate at all, and the engine infers one from the device class.
Re-deriving the whole census:

```bash
node -e "const g=require('fs'),p=require('path');const f=[];(function w(d){for(const e of g.readdirSync(d,{withFileTypes:true})){const q=p.join(d,e.name);if(e.isDirectory())w(q);else if(q.endsWith('.json'))f.push(q)}})('devices');let any=0,per=0,tmpl=0,nest=0,both=0;for(const q of f){const d=JSON.parse(g.readFileSync(q,'utf8'));const i=d.interfaces||[];const t=[].concat(d.portTemplate||[]);const a=i.some(x=>x.poeOut!==undefined),b=t.some(x=>x&&x.poeOut!==undefined),c=i.some(x=>x.hardware&&x.hardware.poeOut!==undefined);if(a||b||c)any++;if(a)per++;if(b)tmpl++;if(c)nest++;if(a&&b)both++}console.log(any+' files state a PSE rate; '+per+' per-port, '+tmpl+' on portTemplate ('+both+' of them both), '+nest+' nested in hardware.poeOut')"
```

which prints `62 files state a PSE rate; 55 per-port, 9 on portTemplate (3 of them both), 1 nested in
hardware.poeOut` on this tree.

### Keys the catalogue carries that this table does not gate on

A survey of all 1,661 files finds **sixteen** top-level keys the schema table above never mentions — thirty-three exist in total, sixteen are in that table, and `poe` counts as documented because the `poeBudget` row names it (seventeen documented, sixteen not). They matter
because a contributor copying an existing spec will meet them, and because **whether any code reads a
key decides whether it can change behaviour**. Measured with `grep -rn "\.<key>" engine/ web/ server/`:

| Key | Files | Read by | Effect |
|---|---|---|---|
| `insertionLossDb` | 13 | `engine/optical.js` | **real** — the loss a passive part adds to a PON budget |
| `formFactor` | 7 | `engine/optical.js`, `web/app.js` | **real** — which cage a transceiver fits, and its label |
| `splitRatio` | 11 | `engine/validation.js` | **real** — a splitter's fan-out, and its loss |
| `dualRole` | 3 | `engine/device.js` (+ `web/app.js` builds the role picker from it) | **real** — e.g. a WAN/LAN combo port. This is the one row here that is **not** a top-level key: measured, it sits inside `interfaces[]` — two ports each in `devices/asus/rt-ax89u.json`, `devices/asus/rt-ax89x.json` and `devices/draytek/vigor-3912.json`, all `["wan", "lan"]` — which is why this table names seventeen things for sixteen top-level keys |
| `comboPorts` | 15 | nothing in `engine/`, `web/`, `server/` — written by `scripts/apply-research.js` | **annotation**: the pairing itself is expressed by per-port `comboWith`/`comboRole` |
| `source` | 20 | nothing that reads a device spec | annotation: a datasheet **URL** in the older spelling. `sourceUrl` is the key the registry exposes and the one the "1,313 of 1,661" coverage count above uses, so a spec carrying only `source` counts as uncovered (20 do; none carry both) |
| `returnLossDb`, `channelCount`, `channelPlan`, `monitorTapDb`, `insertionLossTypicalDb`, `bypassInsertionLossDb`, `attenuationRangeDb`, `attenuationStepDb`, `isolationDb`, `portSplitNote`, `powerMaxW` | 1–12 each | nothing | annotation: figures a datasheet gives for a passive optical part (CWDM muxes, VOAs, taps, attenuators), plus `powerMaxW` (7 files) — a radio's transmit power, which nothing models |

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

### What is left open, and why

Every remaining request in this project's issue tracker is blocked on one of four things.
None of them is a missing search: each is information that neither the vendor nor this
repository can supply, which is why they stay open rather than being guessed into the schema.

- **A chassis needs a stated configuration.** NetEngine 8000 (M4…M14, X4…X16, F1A/F8),
  OptiXtrans E6600/E9600, OptiXaccess MA5800 and the FS NC8200/NC8400 are frames with
  **slots**: Huawei publishes *maximum ports per subrack* (MA5800-X17: 272 GPON, 816 GE/FE)
  and *per-control-board* upstream ports, and FS publishes slot counts, but neither publishes
  a port census for an unconfigured frame. Modelling the maximum lets a lab cable 272 PONs
  into a chassis that might hold sixteen; modelling a representative board set means inventing
  the customer's order. The fix is one line from the requester - "MA5800-X7 with one MPLB and
  three GPHF boards" - and the ports then follow from the vendor's board tables.
- **A storage array publishes port *types*, not counts.** OceanProtect X8000/X8100/X9000/X9100
  and E8000 give front-end port *kinds* (16/32/64G FC, 10/25/40/100GE) and a controller count,
  because the port count is a function of the configuration ordered.
- **A modular router is a bay, not a port.** The Peplink EPX datasheet gives ranges - "4-28x
  10G SFP+ Ports, 8-56x GE Ports" - with a base model of "EPX Base Model, 1x OLED Module", i.e.
  seven module slots and no fixed ports at all. The SDX, by contrast, could be modelled (#458)
  because its ordering row named the base chassis's ports exactly.
- **The source genuinely says nothing usable.** The UniFi Dream Wall **Pro** has no tech-spec
  page and the published Dream Wall datasheet describes the non-Pro unit; the AmpliFi HD
  MeshPoint's three public sources disagree on whether it has zero, one or two Ethernet ports.
  A contradiction is recorded on the issue rather than resolved by preference (#282).

### What the catalogue cannot represent

Some hardware requests describe something with no interface at all, and those are declined
rather than padded into the schema:

- **power carried over fibre** - the PoE model in `engine/media.js` is a *copper* model: it
  computes PSE class, per-port `poeOut`, a shared `poeBudget` and the PD draw across Ethernet
  pairs. A PoF distribution unit that publishes 30 W per hybrid SC port and 400 W total
  (`huawei/OptiXaccess S0316`) therefore carries those figures in its `notes` and not as
  `poeOut`/`poeBudget`, because a machine-readable claim would have the engine evaluate a
  power budget over a medium it does not simulate. `test/poe-inference.test.js` enforces the
  same rule from the other side: no port on a non-copper cage may source or draw power. Making
  PoF first-class means a PoF media id, PoF cords and power on the optical rail - a feature, not
  a spec file;

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

- **A relative path is resolved against the process's cwd, and a missing one throws.** This bullet used
  to warn that `loadCatalog('devices')` returned **1,638 entries and every one of them an error**,
  because the walker `require()`d `path.join(dir, …)` and a bare relative path was read as a *module
  specifier*, so every file failed and the per-file `catch` turned the whole catalogue into "Broken
  spec" rows. That was fixed in the loader itself: `loadCatalog()` now starts with
  `dir = path.resolve(dir || __dirname)` (`devices/registry.js:15`), and the measured behaviour today is

  | call, from the repository root | result |
  |---|---|
  | `loadCatalog()` | **1,661** specs, **0** error rows — it defaults to `__dirname` |
  | `loadCatalog('devices')` | **1,661** specs, **0** error rows |
  | `loadCatalog('devices')` from any other cwd | **throws** `ENOENT: … scandir '<cwd>/devices'` |
  | `loadCatalog('no-such-dir')` | **throws** `ENOENT` — the directory is not swallowed into rows |

  So the failure mode is now loud rather than silent, and the only thing left to remember is that a
  relative path means "relative to wherever the process was started": pass `path.resolve('devices')` or
  `__dirname`, which is what `engine/` and `scripts/` do.
- **A file it cannot parse becomes a row, not an exception.** The shape is
  `{ vendor: 'error', model: '<filename>', label: 'Broken spec', error: '<message>' }`, so a caller
  that counts entries without filtering `d => !d.error` will report a model total one higher than the
  catalogue actually has. There are no error rows on this tree.

## Capabilities

Fifteen, as enumerated in `engine/device.js` (`CAPABILITIES`):

`host`, `l2-forward`, `l3-forward`, `cli`, `dhcp-server`, `dhcp-client`, `nat`, `firewall`,
`wireless`, `http-server`, `poe-pse`, `poe-pd`, `vlan`, `lacp`, `stp`.

**Three gate forwarding, six more are read, and six are pure labels.** The reads:

| Capabilities | Read by | Effect |
|---|---|---|
| `host`, `l2-forward`, `l3-forward` | `Device.isHost()`, `isL2()`, `isL3()` | forwarding: terminate, bridge (MAC learning, VLAN tagging, STP), route |
| `poe-pse`, `poe-pd` | `isPoePse()` / `isPoePd()` in `engine/media.js` | whether the device is treated as sourcing / drawing power when ports are derived |
| `cli`, `dhcp-server`, `http-server` | `SERVICE_PORTS` in `engine/flow.js` | which ports a transport flow can terminate on — SSH/Telnet 22/23, DHCP 67, HTTP/HTTPS 80/443 |
| `dhcp-server` *(again)* | `device.hasCap('dhcp-server')` in the `clear ip dhcp binding` handler and in the binding view | the refusal text — `% PC1 is not a DHCP server - it holds no bindings to clear`, and `% PC1 is not a DHCP server (no pools) and holds no DHCP lease` |
| `nat` | `has('nat')` in `_helpRefusal()`, which builds the `?` page (`engine/cli.js`) | it hides the `nat` verbs from completion and explains why. On a PC (caps `host`, `cli`, `dhcp-client`) `ip ?` lists no `nat` at all, and `ip nat ?` answers: `% No completions for "ip nat" on PC-d1` / `"ip nat inside source static <local> <global>" is a command here, but not on PC-d1: it does not translate addresses`. On a router (caps `l3-forward`, `cli`, `dhcp-server`, `nat`) the same page says `Completions for "ip nat" (1):` and `Next: inside` |

A capability read can hide a verb without refusing it, and `nat` is the example worth knowing: the PC above
answers `ip nat ?` with "not on PC-d1", and then **accepts** `ip nat inside source static 10.0.0.5 203.0.113.5`
with `NAT rule added on PC-d1: static 10.0.0.5 -> 203.0.113.5`. The capability decides what the help page
offers, not what the parser takes — so reading a capability is not the same as gating on it.

`firewall`, `wireless`, `dhcp-client`, `vlan`, `lacp` and `stp` are **not read anywhere** — `nat` was in this
list until a sweep of every capability read found `has('nat')` guards in `_helpRefusal()`. There are **two**
of them today, both returning the same string: `engine/cli.js:13288` for the `ip nat …` positive forms and
`:13298` for the `no ip nat inside|outside|source` removals. The NAT *views* — `show ip nat translations`,
`show ip nat statistics`, `clear ip nat translation` — are deliberately **not** gated and answer on every
device with an empty table, because a rule can arrive from the topology. Which is the difference between
"nothing consults it" and "nothing *acts* on it": those guards decide whether a command is offered, not
whether addresses are translated.
The features they name work from configuration and port hardware instead:

- DHCP server: `ip dhcp pool` in the running config; client: `ip address dhcp`,
- NAT: `nat` rules, filtering: `access-list` + `ip access-group` bindings,
- PoE: `poeOut` / `poeIn` on the port hardware,
- VLANs: `switchport` on the interface, LAG: `channel-group`, STP: implied by `isL2()`.

### The catalogue sets nineteen values, not fifteen

The engine's vocabulary is `CAPABILITIES` in `engine/device.js` — fifteen tokens — but the specs on
disk use **nineteen** distinct strings. Twelve of the fifteen are in use; `vlan`, `lacp` and `stp`
are defined and set by nothing. The other seven are hardware descriptors the vocabulary never
names, and `grep -l "'<token>'" engine/ server/ web/` finds **no reader for any of them**:

| Token | Specs | Where it is understood |
|---|---|---|
| `passive-poe` | 258 | `scripts/import-devices.js` only — an accepted descriptor |
| `802.3af` | 143 | same |
| `802.3at` | 143 | same |
| `802.3bt` | 25 | same |
| `bridge` | 18 | same file, as an **alias** for `l2-forward` — so these 18 specs carry a token the importer normalises on the way in, and they predate that map |
| `poe-injector` | 10 | same file, as an accepted descriptor |
| `vpn-ipsec` | 7 | nowhere at all — not the engine vocabulary, not the importer's list, so an import would move it to `role` |

The importer's own list is the engine's fifteen minus `vlan`/`lacp`/`stp`, plus `poe-injector`,
`passive-poe` and the three `802.3*` tokens, and its comment says why: those describe *power*, and
"they grant no behaviour". A token that is neither in that list nor within two edits of one is
moved to `role` rather than dropped (`import-devices.js:145-160`), which is the only place in the
repo that validates a capability string at all — nothing in the engine rejects an unknown one, so a
spec can carry any word here and the simulator will ignore it.

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

### The other catalogue scripts — and which ones are spent

`scripts/` holds five more tools that write device JSON. They are not interchangeable, and two of them
were one-off repairs for a specific issue, which is the thing a reader most needs to know before running
one:

| Script | What it does | Dry run | Still useful? |
|---|---|---|---|
| `apply-port-layouts.js <file> [...]` | applies a researched port layout, limited to `connector`, `cage`, `speed`, `speedCaps`, `notes` — anything else in the record is metadata, not a write | **yes, by default**; `--apply` writes. Exits 2 with a usage line and 1 when it finds problems | yes — the general port-layout tool |
| `apply-port-fixes.js` | same idea for the `research/incoming/issue9-*.json` shape, rewriting only connector/speed on named ports | **yes, by default**; `--apply` writes. Prints `No issue9-*.json files to apply.` and exits 0 when there is nothing | yes, when research arrives in that shape — but read the caveat below before believing its count |
| `fix-optics.js` | gives optical uplinks their own ports instead of inheriting the copper `portTemplate` | `--apply` writes | yes, for specs with mixed copper/optical layouts |
| `fix-optics-claims.js` | one-off repair for issue #9: converts a port named as SFP that was modelled as copper | `--apply` writes | **spent** — kept as a record of the rule it applied |
| `merge-research.js` | one-shot merge of the swarm-researched homelab gear into the registry | **none** — it writes as it runs | **spent and unsafe to re-run** |

**`apply-port-fixes.js` does not diff, so its headline is the size of the research, not the work left.**
It assigns `connector`, `speedCaps` and `speed` to the named port and prints a line for every port it
touched, whether or not the spec already said exactly that. Measured on today's tree: three
`research/incoming/issue9-*.json` files — `issue9-access.json` and `issue9-adc.json` are bare arrays,
`issue9-storage.json` wraps a `corrections` key, and both shapes are accepted — print **`13 device(s), 54
port(s) would change.`** Comparing those 54 against the specs port by port: **45 already hold the
proposed `connector`, `speedCaps` and `speed` exactly**, so `--apply` would rewrite those files with
identical bytes. The **9** that are real are worth a human read: `nokia/7302 ISAM` and `nokia/7330 ISAM
FTTN` `ge1`–`ge3` would widen `sfp` from `[1000]` to `[100, 1000]`, `truenas/R50` `enp1s0f0`/`enp1s0f1`
would move from `sfp+` `[1000, 10000]` to `qsfp28` `[40000, 100000]` — a different cage, not a wider one —
and its `oobm` would narrow from `[10, 100, 1000]` to `[1000]`.

Its closing hint, `Fixed (remove from test/known-issues.json once verified):` and thirteen device names,
is also stale by construction: `test/known-issues.json` holds `opticsWithoutCage: []` — already empty —
so there is nothing there to remove.

The other two, run today rather than read: `fix-optics.js` reports **`0 device(s) would be rewritten, 4
skipped`** with the reasons inline (`brocade/G720`, `hpe/SN3600B` and `watchguard/Firebox M290` have "no
explicit "Nx ... RJ45" claim to size the copper ports"; `mikrotik/CRS812-8DS-2DQ-2DDQ-RM` has "14 ports
declared vs 2 copper claimed"). `fix-optics-claims.js` reports **`Devices that can be repaired from their
own description: 0`** and **`Left for a human (60)`** — dominant reason `no port names in description`,
plus one `cisco/MDS 9124V` where "named ports did not match interfaces". So "spent" is accurate about the
tool and misleading about the defect class: nothing is repairable by it, and sixty devices still carry
the shape of problem it was written for.

Running the last two again is not a no-op: `merge-research.js` writes immediately and takes no flags, and
`fix-optics-claims.js` re-derives its decisions from the current specs rather than a snapshot, so its
result on today's tree is not the result it was written for. Prefer `apply-research.js` (above) or
`apply-port-layouts.js` for anything new.

`scripts/syntax-check.js` is in the same directory and writes nothing — it is what `npm run syntax` runs,
recursing the tree with `node --check` and no dependencies.
## Included catalog

**1,661 models across 247 vendors**, one JSON file each, in 25 distinct `category` values
(24 palette buckets — most APs are filed `wireless`; **eleven** specs still carry the legacy `ap`
value: five `fs` access points, four `ruckus`, `peplink/APO-AC-MINI` and `huawei/WiFi Extender AX3000`).
That is not one stray file but a small family, and it has a visible cost worth knowing: the palette's
type filter is built by walking `CAT_ORDER` in `web/app.js`, so a category outside that list gets no
entry in the dropdown and the device is reachable only through palette **search**. Count them
yourself:

```bash
node scripts/audit-devices.js          # models, vendors, ports, cablability, optics, verdict
node scripts/missing-devices.js        # what the catalogue is still missing
```

Neither of those counts the `ap` family or the buckets, so measure them directly — the two numbers that
decide whether the paragraph above is still true, both computed from the tree rather than typed in:

```bash
node -e '
const fs=require("fs"),p=require("path");const ap=[],cats=new Set();
const walk=d=>fs.readdirSync(d,{withFileTypes:true}).forEach(e=>{const f=p.join(d,e.name);
  if(e.isDirectory())walk(f);else if(f.endsWith(".json")){const s=JSON.parse(fs.readFileSync(f,"utf8"));
    if(s.category==="ap")ap.push(f);if(s.category)cats.add(s.category);}});
walk("devices");
const buckets=new Set(fs.readFileSync("web/app.js","utf8").match(/CAT_ORDER\s*=\s*\[([^\]]*)\]/)[1]
  .split(",").map(s=>s.trim().replace(/["\x27]/g,"")).filter(Boolean));
console.log(ap.length+" specs still filed ap, reachable only by search");
console.log(cats.size+" category values in use, "+buckets.size+" palette buckets");'
# 11 specs still filed ap, reachable only by search
# 25 category values in use, 24 palette buckets
```

The gap between those last two numbers is the whole cost: one `category` value that the dropdown does not
carry, and every model filed under it can only be found by typing its name.

`audit-devices.js` prints **four** counts and a verdict, not three. On this tree, in order:

```
Models: 1661 across 247 vendors
Ports:  17030
Uncablable ethernet ports: 0
Describe optics but have no optical cage: 26
   - brocade/G720 (57 ports)
   ...
No hard defects.
```

The fourth line is the one this page used to leave out, and it is the interesting one: 26 specs name
transceivers or wavelengths in their description while declaring **no optical cage** at all, so
`cagesMate()` has nowhere to put the optic the text promises. That is reported, not failed — it is a
soft finding, which is why the verdict underneath still reads `No hard defects.` The largest are
`brocade/G720` (57 ports), `dell/DS-6630B` (105) and `hpe/SN3600B` (25), and the tail is dominated by
GPON ONT sticks (`halny/HL-GSFP`, `leox/LXT-010S-H`, `fs/GPON-ONU-34-20BI`) whose "port" is the fibre
itself. The audit prints the first fifteen and `... and N more`; `--json` carries the whole list as
`opticalMissing` (and the empty `uncabliable` array beside it), which is the form to diff when a spec
change is supposed to empty it.


`audit-port-types.js` is the other half of that pair, and it is the one `npm test` runs **first**. On this
tree it prints:

```
Port type / connector audit
  models:  1661 across 247 vendors
  ports:   17030  (5148 of them expanded from a portTemplate in 213 specs)
  offending devices: 0
  offending ports:   0  (high 0, medium 0, low 0)

Template ports whose connector nothing declares: 3108 port(s) in 140 spec(s)
    - arista/720XP-48Y6  48/48 template ports (e.g. Ethernet1 -> rj45)
    ...
    ... and 125 more (see --json summary.undeclaredTemplateHardware)

No port contradicts its declared type.
```

The hard finding is the `offending` pair — a port whose declared `connector` or `type` contradicts the
cage it resolves to, which is the mistake that makes `cagesMate()` accept a part no datasheet allows.
Zero is the number to keep. The soft finding is the block under it, and it is not small: **3,108 of the
5,148 template-expanded ports, in 140 of the 213 specs that use a template**, declare no `connector`, no
`cage` and no `speedCaps`, so their cage comes from `derivePortHardware()` inferring it out of the port
name and rate. Nothing in the spec can contradict that inference — `arista/720XP-48Y6` and
`cisco/C9300-48P` both resolve their 48 template ports to `rj45`, which happens to be right, but the claim
is the audit's and not the datasheet's. Put a `connector` on the template when you touch one. `--json`
carries `summary.undeclaredTemplateHardware` as **`{ specs: 140, ports: 3108, models: [ … 140 names ] }`**
— counts and the spec names, not per-port detail — which is the shape to diff when a template change is
meant to shrink it.


The catalogue spans routers, switches, L3 switches, firewalls, taps, hosts, servers, wireless
APs, PTP radios, OLTs, ONTs, splitters, modems, powerline/MoCA adapters, NAS, desktops, laptops,
phones, tablets, printers, cameras, NVRs, IoT and cloud. Vendor coverage runs from Cisco, Juniper,
Arista, HPE/Aruba and Huawei to MikroTik, Ubiquiti, Zyxel, TP-Link, Calix, Nokia, Fiberhome,
Raritan and Vertiv.
