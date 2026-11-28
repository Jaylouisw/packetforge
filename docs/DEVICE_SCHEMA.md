# Device spec reference

One file per physical device: `devices/<vendor>/<model>.json`. This page is the vocabulary the
importer accepts, taken from `scripts/import-devices.js` — if a value here is wrong, the importer
is right and this page has drifted. The capability list is the exception: it is not the
importer's to state, and is taken from `engine/device.js` (`CAPABILITIES`).

```json
{
  "vendor": "aruba",
  "model": "2540-48g-poe-4sfp-plus-jl357a",
  "label": "Aruba 2540 48G PoE+ 4SFP+ Switch (JL357A)",
  "category": "switch",
  "description": "Aruba 2540 48G PoE+ (JL357A) - 48x 1G RJ45 all PoE+, 4x SFP+ uplinks, 370 W budget.",
  "capabilities": ["l2-forward", "l3-forward", "poe-pse", "802.3af", "802.3at", "cli"],
  "interfaces": [
    { "name": "ge1", "type": "ethernet", "connector": "rj45", "speed": "1G",
      "poeOut": true, "poeOutClass": "PoE+" }
  ],
  "notes": "Vendor figures for JL357A: ..."
}
```

## Top-level fields

| field | required | rule |
|---|---|---|
| `vendor` | yes | **lowercase letters, digits and dashes only** (`^[a-z0-9][a-z0-9-]*$`). It names the directory, so `HPE` fails and `hpe` is right. |
| `model` | yes | the variant, unique inside the vendor. Becomes the filename. |
| `label` | recommended | what the UI shows, with the SKU in parentheses. |
| `category` | yes | one of the 25 below. |
| `description` | recommended | prose. Must agree with the ports — see the invariant. |
| `capabilities` | yes | non-empty array from the vocabulary below. |
| `interfaces` **or** `portTemplate` | yes | at least one port has to exist. |
| `notes` | optional | the vendor's numbers, and anything surprising. This is where a spec disagrees with its own model name. |
| `aliases` | optional | names people actually type: `["E6616", "B1LDCD"]`. An alias ranks with a model prefix in the palette search and is shown in the inspector. It may not equal another device's model name - that would shadow it - and `test/device-aliases.test.js` enforces that across the whole catalogue. |
| `fabric` | optional | `{ "capacityMbps": number, "kind": string, "excludes": ["line*"] }` — the switching or cross-connect capacity the vendor states. Declare it only when the capacity genuinely caps what the ports can do together; the palette shows the ratio, the invariant refuses a fabric slower than one of its own ports, and an `excludes` glob that matches no port is reported rather than silently obeyed. |

### A port list may be a stated build

A chassis shelf has no ports of its own. The ports belong to the cards fitted in it, so any spec of a
modular shelf states a **card complement** and the port list that complement produces. The rule for
where that complement lives:

- the complement goes in `label`, never in `model`. `model` is the variant and the filename, and a
  complement there makes the same box unfindable under its own name when the reader is holding a
  `E6616` and the catalogue says `OptiXtrans E6616 (14x B1LDCD)`. Precedent: `devices/arista/7504r.json`
  put `(4x 36CQ)` in `label` and left `model` as `7504R`; `devices/huawei/netengine-8000-x4.json` does
  the same with `(4x LPUI-4T, 32x 400GE)`.
- `aliases` carries the bare names people type (`E6616`, `OptiXtrans E6616`, `B1LDCD`), which is what
  keeps search working after the complement leaves `model` — `test/device-aliases.test.js` is the check.
- `notes` must state the slot count, the card part number and **the table the count came from**. A
  "fully populated" figure read off a datasheet maximum is not a build: `docs/MAINTAINING.md:110-118`
  already forbids treating "up to 16x10GE" as a port list, and a stated build is safe only because the
  card's own name carries its count.
- when the cited document does **not** carry the card census, `notes` says so and names the document
  that does. A citation that stops short of the claim it is attached to is the error this project has
  corrected most often; `research/optixtrans-e6600-xt-census.md` §5 is the worked case.

### Categories

`router` `switch` `l3-switch` `firewall` `ap` `ont` `host` `server` `wireless` `ptp` `cloud`
`olt` `splitter` `modem` `powerline` `nas` `desktop` `laptop` `phone` `tablet` `printer` `camera`
`nvr` `iot` `tap`

`tap` covers passive and active network taps, including packet brokers. `splitter` is for passive
optical splits — a different device with a different failure mode. `ap` is in use once, by
`devices/huawei/wifi-extender-ax3000.json`; the catalogue's other 215 wireless devices — access points and
wireless routers from MikroTik, Ubiquiti, Aruba and others — are `wireless`, so the two are not spellings of
one category: `web/canvas.js` draws them with the same icon, and `devices/registry.js` sorts `ap` after
every category named in its `CATEGORY_ORDER`, because `ap` is not in that array.

### Capabilities

The list is `CAPABILITIES` in `engine/device.js`, and the importer imports it rather than
keeping a copy — so what follows is the vocabulary the engine honours. Every token in it is read
somewhere under `engine/`; `test/capability-vocabulary.test.js` is what keeps that true. Three
tokens are still declared without a reader — `dhcp-client`, `firewall` and `wireless` — and that
test names them as pending decisions (#1526) rather than letting them pass for behaviour.

| capability | means |
|---|---|
| `l2-forward` | bridges, has a MAC table, forwards frames |
| `l3-forward` | routes between subnets |
| `nat` | rewrites source addresses on egress |
| `firewall` | filters and drops by policy |
| `dhcp-server` / `dhcp-client` | hands out leases / asks for one |
| `wireless` | has radios and can associate clients |
| `cli` | has a command line |
| `http-server` | serves a management UI |
| `host` | is an endpoint: it can originate and terminate traffic |
| `poe-pse` | can source power on its ports |
| `poe-pd` | is powered by PoE |

A token that is not in that list is **kept**, exactly as the source declared it, and named in
the run:

```
1 spec(s) had warnings (still imported):
  - aruba/2540-48g-poe
      capability "802.3at" is not one of the 12 capabilities engine/device.js implements;
      kept as declared, so the simulator ignores it
```

Kept, because the spec is a record of the hardware and a token the datasheet declares is a fact
— dropping it is data loss, and it used to happen without a word (#1522). Named, because the
engine will not honour it and the run must not call that clean. `802.3af`, `802.3at`, `802.3bt`,
`poe-injector`, `passive-poe` and `midspan` are in this class today: real power facts with no
behaviour behind them. `vlan`, `lacp` and `stp` joined them (#1526): 213 specs state 802.1Q,
LACP or STP today because their datasheets do, but the engine runs VLANs, LAGs and spanning tree on
any `l2-forward` box, so the token is a hardware fact rather than behaviour — gating the
features on it would have switched VLANs off for almost the whole catalogue. If one of these
should grant behaviour, it belongs in `CAPABILITIES` and in the code that branches on it, not
in a second list here.

A capability that is not in that list but is within edit distance 2 of one is refused with
`capability "x" looks like a typo of "y"` rather than silently dropped, because a misspelt
capability would otherwise make a device quietly less capable than its datasheet.

### What a capability stops you doing

A capability is not a label: the data plane honours it, and the console refuses configuration the box could not
carry out. A device that cannot forward is not given a route, one without `nat` cannot hold a NAT table, one
without `dhcp-server` cannot create a pool, and one that is not a router cannot join a VRRP group:

```
Router> enable
Router# configure terminal
Enter configuration commands, one per line.  End with CNTL/Z.
Router(config)# ip dhcp pool p1              ! on a Raspberry Pi
% Raspberry Pi 5 SBC-d1 cannot serve DHCP: it has no dhcp-server capability
```

The gate is on the *command*, not the file: a hand-edited topology that gives a media converter a static route still
loads, and `show running-config` still prints it — the printer never drops a configured value. What changes is that
the console will not *create* one, so the "created / added / enabled" sentence and the hardware agree.

| command | capability | refused when absent |
|---|---|---|
| `ip route <dest> <mask> <gw>` | `l3-forward` | cannot install a route |
| `ospf router-id` / `ospf area` | `l3-forward` | cannot run OSPF |
| `ip nat pool` / `ip nat inside source …` | `nat` | cannot translate addresses |
| `ip dhcp pool <name>` | `dhcp-server` | cannot serve DHCP |
| `vrrp <group> ip <address>` | `l3-forward` | cannot run a VRRP group |
| `ipv6 nd ra …` | `l3-forward` | cannot advertise |
| `switchport …` / `no switchport` | `l2-forward` | cannot switch frames |
| `channel-group <n> mode …` | `l2-forward` | cannot bundle ports into a LAG |

The L2 rows are the mirror image of the others, and they close a disagreement the printer had already noticed:
`show interfaces` has never printed a `switchport:` line for a device without `l2-forward`, because "the capability
is what makes a port a switchport" — while the console happily answered `Switchport mode trunk on Gi0` for a router
and stored it where nothing would read it. One of the two had to give, and the printer was right.

A router is told what to do instead (`this port routes: use \`ip address <address> <mask>\``). A host is not: it does
not route either, and "this port routes" would be a second wrong statement in the same sentence.

## Interfaces

Two ways to write them. Both end up as the same list.

**Explicit** — for anything irregular:

```json
"interfaces": [
  { "name": "ge1",  "type": "ethernet", "connector": "rj45", "speed": "1G" },
  { "name": "sfp1", "type": "ethernet", "connector": "sfp+", "speed": "10G", "speedCaps": [1000, 10000] }
]
```

**Templated** — for `24 x 1G`:

```json
"portTemplate": { "count": 24, "prefix": "ge", "type": "ethernet", "connector": "rj45", "speed": "1G" }
```

`count` is 1..512, `prefix` must be non-empty, and the expansion must produce at least one port.

`prefix` carries the chassis and `start` carries the numbering — `start` is a **number**, not the first name:

```json
"portTemplate": { "prefix": "Gi1/0/", "start": 1, "count": 24, "type": "ethernet", "connector": "rj45", "speed": "1G" }
```

names `Gi1/0/1` .. `Gi1/0/24`. Writing the whole first name in `start` (`{ "prefix": "Gi", "start": "1/0/1" }`) is
refused rather than obeyed: the expander used to *add* it, which produced `Gi1/0/10` .. `Gi1/0/13` — plausible port
names that run past the end of the box, with every address, VLAN and cable attached to a port that does not exist.

The 1..512 range is **enforced** — by `portCountProblem()` in `devices/registry.js`, which the loader and the
expander both call. It used to be a sentence in this file and nothing else: the loader accepted any positive whole
number, and `count: 1000000` asked it for a million ports while `count: Infinity` (which is a positive whole number
as far as `Math.floor(n) === n` is concerned) asked for infinitely many, so building the catalogue never returned.
The expander now refuses a count it cannot honour instead of trying: a spec that arrives from a hand-edited saved
board never passes the loader, so the rule lives in the one function both doors use.

`prefix` and `start` are enforced the same way and in the same place (`portPrefixProblem()` and `portStartProblem()`,
called by the loader and by the expander). They used to be checked **only** by the loader, and the expander did
arithmetic on whatever arrived: prefix `5` with start `1` named its ports `6`, `7`, `8`, and a slashed start ran the
numbering off the end of the chassis. Every door that builds a device without reading a file — the importer
generating a template from observed names, `addDevice()`, an audit — went through the expander.

| field | rule |
|---|---|
| `name` | required, unique in the spec. Two ports called `ge1` are an error, not a typo to fix silently — `loadCatalog()` refuses the whole spec and says which name clashed (see *What the loader refuses* below). |
| `type` | `ethernet` `wireless` `console` `coax` `dsl` `adsl` `vdsl` `powerline` `plc` `mains` `pon` |
| `speed` | `8M` `24M` `50M` `100M` `200M` `300M` `1G` `2.5G` `5G` `8G` `10G` `16G` `25G` `32G` `40G` `64G` `100G` `200G` `400G`. Wireless speeds are the same vocabulary plus the `600M`-style form. |
| `connector` | free-form and preserved: `rj45`, `sfp`, `sfp+`, `qsfp+`, `qsfp28`, `qsfp56`, `qsfpdd`, `lc`, `sc`, `usb`, … |
| `speedCaps` | the rates the cage actually accepts, as Mbps. A `sfp+` that also takes 1G is `[1000, 10000]`. |
| `poeIn` | watts this port draws, as a **number** — 12.95 and 25.5 are different devices, so `true` is wrong — or `false` for a socket that is **not** a powered device (see below). |
| `poeOut` | `true` when this port sources power. |
| `poeOutClass` | the class this port sources, in the vendor's words: `PoE` (802.3af), `PoE+` (802.3at), `PoE++` (802.3bt Type 3), `PoE+++` (Type 4) or `passive` - a fixed-voltage vendor class (24/27/54 V), not an IEEE standard. Kept verbatim; nothing in the engine reads it (see below). |
| `cage`, `comboWith`, `comboRole`, `dualRole` | preserved verbatim; they describe shared cages and switchable ports. |

Anything unrecognised on an interface is **preserved**, not dropped: a field a later version of
the engine learns to read is better kept than lost at import time.

`poeIn: false` is a claim, not a silence, and the engine reads it as one. `derivePortHardware()`
copies the value through untouched (`engine/media.js:1098`), and the device-wide guess fires only on a
socket whose `poeIn` is still `null` (`:1122-1124`) — so a mains-supplied box that `isPoePd()`
matches on its model (`:1174`) keeps its sockets empty instead of claiming 12.95 W on each. The
allocation loop skips such a socket for the same reason (`engine/simulator.js:2743`). 35 specs spell
274 sockets this way — the three non-PoE UniFi switches (`devices/ubiquiti/usw-pro-48.json`),
the Peplink routers whose one PoE inlet is a named WAN port (`devices/peplink/max-br1-ip55.json`) —
and `test/ubiquiti-usw-ac-nonpoe.test.js` pins the first family socket by socket. What `false` does
not survive is normalisation: `completeHardware()` passes it through `numOrNull()`
(`engine/validation.js:363`, `:213`), which answers `0` for any boolean, so the connection validator
sees a socket that draws nothing but no longer sees that the socket was declared. `poeInDeclared` —
step 1 of [plans/poe-pd-inference.md](plans/poe-pd-inference.md) — is not in the engine yet:
`grep -rn poeInDeclared engine/` finds nothing.

The class is a record, not a rule. `derivePortHardware()` (`engine/media.js`) builds a port's `hardware`
from `poeOut`, `poeIn`, the cage and the speed caps and **drops** `poeOutClass`, so the string never
reaches a view: it is what the datasheet said about this port, and its vocabulary is the catalogue's
rather than a validator's. It is wider than the four standards today - 269 ports declare `PoE+++`
(`devices/ubiquiti/ecs-24-poe.json`), 109 across 37 specs declare `passive`
(`devices/ubiquiti/uisp-r.json`), and 34 write the parenthesised `PoE+ (802.3at)`. Spelling a passive
port `PoE` is not a cosmetic slip: 802.3af is a negotiated 48 V standard and a 24 V passive port does
not speak it, which is the pair of faults `test/uisp-r-poe.test.js` and `test/ep-s16-poe.test.js` were
written for.

The one rule over these tokens is `test/poe-injector-standard.test.js`: a `poe-injector` entry may not
source more than the highest standard it declares - 15.4 W for `802.3af`, 30 W for `802.3at`, 90 W for
`802.3bt` - and a midspan above 15.4 W that names no standard fails the same way. Three entries
declared `802.3at` (or nothing at all) beside a 60 W or 90 W port while their own vendor pages said
802.3bt, which is the defect [research/poe-injector-standard-claims.md](../research/poe-injector-standard-claims.md)
records. Switches are deliberately outside the gate: a vendor may pair "PoE+" with a proprietary
over-power mode above the standard's ceiling (PLANET's 36 W IGS-5225 ports), and no field in the schema
records that mode.

## Serial consoles, USB, FXS

They go in `notes`, not in `interfaces`. The engine forwards frames; a console port is a fact about
the box, not a link it can carry traffic on. Recording it as an interface makes a device look like
it has a port the simulator will never light up.

## The invariant a description has to survive

`test/spec-vs-description.test.js` compares the prose with the ports. It fails an entry that:

- promises more ports in the description than the interfaces actually have;
- says **PoE-powered** while claiming to source power it cannot supply (or the reverse);
- names a media type the interface list contradicts (`fibre` on an RJ-45-only box).

This is why `notes` and `description` are worth writing carefully: the check is cheap, and the
alternative is a catalogue that reads well and lies.

## One expansion rule

There is exactly one implementation of "a spec's ports": `effectiveInterfaces()` in `devices/registry.js`. The
engine (`engine/topology.js`) calls it, audits call it, the importer calls it.

It used to be two — one in the registry and one in the engine — kept in step by a test that compared port **names**
over the catalogue. That test could not see a divergence in any other field, on any spec outside the catalogue, or in
any edge case, and the copies had already diverged where it mattered: the loader refused a template it could not
honour and the engine started building it.

## What the loader refuses

`loadCatalog()` reads every `.json` under `devices/`. A spec that **cannot describe a device** becomes a
catalogue entry carrying `error`, naming the file and the reason. It is not dropped silently — a missing device is
harder to notice than a red one — and it cannot be mistaken for a working device, because the palette shows it as
broken.

| the spec… | the message says |
|---|---|
| does not parse | the JSON error |
| is not an object, or has no `model` | it cannot be identified |
| has `interfaces` that is not an array | what it got instead |
| has no ports, or expands to zero | nothing to cable to |
| has `portTemplate.count` of `0`, `-5`, `"8"` | must be a positive whole number |
| has `portTemplate.prefix` that is not a string | what it got instead, and the form that works |
| has `portTemplate.start` that is not a whole number ≥ 0 | what it got instead, and that the chassis belongs in `prefix` — `{"prefix":"Gi1/0/","start":1}` names the first port `Gi1/0/1` |
| gives **two ports the same name** | which name, and how many ports the device would really keep — `port name "Gi2" is used 2 times - a device would keep 4 of the 5 ports the spec describes` |
| declares a model **another file already declares** | the file that already has it — comparison ignores punctuation, so `ASR1001-X` and `ASR 1001-X` are one box |

The last two are the ones that used to pass. Ports are kept in a map keyed by name, so a duplicate did not error:
it *disappeared*, and a spec describing five ports produced a device with four. And a second file for the same box
put two entries in the palette for one machine, where `POST /api/topologies/default/devices {model}` silently took
whichever sorted first.

Both are checked at **load**, not only at import: the importer's duplicate gate only ever saw files that came
through the importer, and a spec can arrive by a rebase, a copy or a hand edit.

## Duplicate spellings are refused

`MAX-BR1-PRO-5G` and `MAX BR1 Pro 5G` are the same physical box. The importer normalises
punctuation and refuses the second spelling instead of adding a duplicate, because two entries for
one device make the palette look richer and the search results wrong.

## Importer flags

```
node scripts/import-devices.js --apply     # write
node scripts/import-devices.js             # dry run, prints what would change
```

It reports `Added`, `duplicates`, `rejected`, `refused duplicate spellings` and warnings, each
warning naming the model it belongs to. **Rejected means the spec is wrong** — read the message;
it names the field and the accepted values.
