# Device spec reference

One file per physical device: `devices/<vendor>/<model>.json`. This page is the vocabulary the
importer accepts, taken from `scripts/import-devices.js` — if a value here is wrong, the importer
is right and this page has drifted.

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
| `category` | yes | one of the 24 below. |
| `description` | recommended | prose. Must agree with the ports — see the invariant. |
| `capabilities` | yes | non-empty array from the vocabulary below. |
| `interfaces` **or** `portTemplate` | yes | at least one port has to exist. |
| `notes` | optional | the vendor's numbers, and anything surprising. This is where a spec disagrees with its own model name. |
| `aliases` | optional | names people actually type: `["E6616", "B1LDCD"]`. An alias ranks with a model prefix in the palette search and is shown in the inspector. It may not equal another device's model name - that would shadow it - and `test/device-aliases.test.js` enforces that across the whole catalogue. |
| `fabric` | optional | `{ "capacityMbps": number, "kind": string, "excludes": ["line*"] }` — the switching or cross-connect capacity the vendor states. Declare it only when the capacity genuinely caps what the ports can do together; the palette shows the ratio, the invariant refuses a fabric slower than one of its own ports, and an `excludes` glob that matches no port is reported rather than silently obeyed. |

### Categories

`router` `switch` `l3-switch` `firewall` `ont` `host` `server` `wireless` `ptp` `cloud` `olt`
`splitter` `modem` `powerline` `nas` `desktop` `laptop` `phone` `tablet` `printer` `camera` `nvr`
`iot` `tap`

`tap` covers passive and active network taps, including packet brokers. `splitter` is for passive
optical splits — a different device with a different failure mode.

### Capabilities

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

Power descriptors, which grant **no** forwarding behaviour — they exist so the power model can say
whether a link will come up:

| capability | means |
|---|---|
| `poe-pse` | can source power on its ports |
| `poe-pd` | is powered by PoE |
| `poe-injector` | sits inline and sources power, forwards nothing logically |
| `passive-poe` | injects without negotiation |
| `802.3af` / `802.3at` / `802.3bt` | which standard it speaks, as source or sink |

A capability that is not in that list but is within edit distance 2 of one is refused with
`capability "x" looks like a typo of "y"` rather than silently dropped, because a misspelt
capability would otherwise make a device quietly less capable than its datasheet.

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

The 1..512 range is **enforced** — by `portCountProblem()` in `devices/registry.js`, which the loader and the
expander both call. It used to be a sentence in this file and nothing else: the loader accepted any positive whole
number, and `count: 1000000` asked it for a million ports while `count: Infinity` (which is a positive whole number
as far as `Math.floor(n) === n` is concerned) asked for infinitely many, so building the catalogue never returned.
The expander now refuses a count it cannot honour instead of trying: a spec that arrives from a hand-edited saved
board never passes the loader, so the rule lives in the one function both doors use.

| field | rule |
|---|---|
| `name` | required, unique in the spec. Two ports called `ge1` are an error, not a typo to fix silently — `loadCatalog()` refuses the whole spec and says which name clashed (see *What the loader refuses* below). |
| `type` | `ethernet` `wireless` `console` `coax` `dsl` `adsl` `vdsl` `powerline` `plc` `mains` `pon` |
| `speed` | `8M` `24M` `50M` `100M` `200M` `300M` `1G` `2.5G` `5G` `8G` `10G` `16G` `25G` `32G` `40G` `64G` `100G` `200G` `400G`. Wireless speeds are the same vocabulary plus the `600M`-style form. |
| `connector` | free-form and preserved: `rj45`, `sfp`, `sfp+`, `qsfp+`, `qsfp28`, `qsfp56`, `qsfpdd`, `lc`, `sc`, `usb`, … |
| `speedCaps` | the rates the cage actually accepts, as Mbps. A `sfp+` that also takes 1G is `[1000, 10000]`. |
| `poeIn` | watts this port draws, as a **number**. `true` is wrong — 12.95 and 25.5 are different devices. |
| `poeOut` | `true` when this port sources power. |
| `poeOutClass` | `PoE` / `PoE+` / `PoE++` — the standard this port sources. |
| `cage`, `comboWith`, `comboRole`, `dualRole` | preserved verbatim; they describe shared cages and switchable ports. |

Anything unrecognised on an interface is **preserved**, not dropped: a field a later version of
the engine learns to read is better kept than lost at import time.

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
| has `portTemplate.prefix` that is not a string | what it got instead |
| has `portTemplate.start` that is not a whole number ≥ 0 | what it got instead |
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

It reports `Added`, `duplicates`, `rejected` and `refused duplicate spellings`. **Rejected means
the spec is wrong** — read the message; it names the field and the accepted values.
