# Connectors, Cages and Ferrule Polish

**A port is a cage plus a set of media. A cable is legal only when the two cages
mate, the two ports share a medium, and a common line rate exists.** This
document is the reference for that model: every cage the engine knows, what each
one physically accepts, why some cables are refused, and how to add a new
connector family without breaking the ones already modelled.

All of it lives in two files:

| File | Holds |
|------|-------|
| `engine/media.js` | `MEDIA`, `CAGES`, `CAGE_ALIAS`, `CAGE_MATE`, `CAGE_MEDIA`, `CAGE_SPEEDS`, `FERRULE`, `inferCage`, `derivePortHardware`, `commonMedia`, `negotiateSpeed`, `canMate`, `polishMismatch` |
| `engine/validation.js` | `validateConnection`, `validateTopology`, the `RULES` catalogue of error codes |

`engine/media.js` is pure data plus pure functions — no dependency on `Device` or
`Topology` — so it can be required from the engine, the server or a test.

---

## 1. Vocabulary

| Term | Meaning | Where it is defined |
|------|---------|---------------------|
| **Cage** | The physical socket fitted to the box: `rj45`, `sfp+`, `qsfpdd`, `sc-apc`, `coax`, `antenna`… A cage is hardware, not a protocol. | `CAGES` (18 entries) |
| **Medium** | The cable, optic, DAC or radio band that goes *in* the cage: `10gbase-lr`, `dac-100g`, `gpon-sc-apc`, `wireless-5`. | `MEDIA` (53 entries) |
| **Mate** | Two cages are physically able to accept each other. | `CAGE_MATE` / `cagesMate()` |
| **Ferrule** | The precision ceramic sleeve at the end of a fibre connector. Has a *shape* (SC, LC, MPO) and a *polish* (UPC flat, APC angled 8°). | `FERRULE` / `ferrule()` |
| **Port hardware** | The derived descriptor hung on every interface: `{ cage, cageName, family, media[], speedCaps[], maxSpeedMbps, poeOut, poeIn }`. | `derivePortHardware()` |

Two cages with the same shape but a different polish are a *polish* mismatch;
two cages with different shapes are a *connector* mismatch. The engine keeps
those apart because "wrong patch lead, swap it" and "these two things cannot ever
connect" are different mistakes. See section 4.

---

## 2. The eighteen cages

Family is the value the engine reports in `port.hardware.family`. The
`combo`, `coax`, `dsl`, `powerline` and `management` values are the
subscriber/management families; the UI groups them as copper / combo / fibre /
console / other.

| Cage | Name | Family | Mates with | Media it can carry | Speed classes (Mbps) |
|------|------|--------|-----------|--------------------|----------------------|
| `rj45` | RJ45 | copper | `rj45`, `combo` | `10base-t`, `100base-tx`, `1000base-t`, plus `2.5gbase-t`, `5gbase-t`, `10gbase-t` when the port is rated that high | 10, 100, 1000 (all filtered by the port rating), plus 2500 / 5000 / 10000 when rated that high |
| `sfp` | SFP | optical | `sfp`, `sfp+`, `sfp28`, `combo` | `1000base-sx`, `1000base-lx`, `1000base-ex`, `1000base-zx`, `1000base-t-sfp`, `dac-1g` | 1000 |
| `sfp+` | SFP+ | optical | `sfp`, `sfp+`, `sfp28`, `combo` | `10gbase-sr`, `10gbase-lr`, `10gbase-er`, `1000base-sx`, `1000base-lx`, `1000base-t-sfp`, `dac-10g`, `dac-10g-active`, `aoc-10g` | 1000, 10000 |
| `sfp28` | SFP28 | optical | `sfp`, `sfp+`, `sfp28`, `combo` | `25gbase-sr`, `25gbase-lr`, `10gbase-sr`, `10gbase-lr`, `dac-25g`, `dac-10g` | 10000, 25000 |
| `combo` | Combo | combo | `combo`, `rj45`, `sfp`, `sfp+`, `sfp28` | Union of the `rj45` and `sfp` lists: the six copper media plus `1000base-sx`, `1000base-lx`, `1000base-ex`, `1000base-zx`, `1000base-t-sfp`, `dac-1g` | 10, 100, 1000, and 10000 when rated 10G |
| `qsfp+` | QSFP+ | optical | `qsfp+`, `qsfp28`, `qsfpdd` | `40gbase-sr4`, `40gbase-lr4`, `dac-40g` | 40000 |
| `qsfp28` | QSFP28 | optical | `qsfp+`, `qsfp28`, `qsfpdd` | `100gbase-sr4`, `100gbase-lr4`, `dac-100g`, `40gbase-sr4`, `40gbase-lr4` | 40000, 100000 |
| `qsfpdd` | QSFP-DD | optical | `qsfpdd`, `qsfp28`, `qsfp+` | `200gbase-dr4`, `200gbase-fr4`, `400gbase-dr4`, `400gbase-fr4`, `100gbase-sr4`, `100gbase-lr4`, `40gbase-sr4`, `40gbase-lr4`, `dac-100g` | 40000, 100000, 200000, 400000 (filtered by the port rating) |
| `sc-apc` | SC/APC | optical | `sc-apc` only | `gpon-sc-apc`, `xgspon-sc-apc` | 1244, 2488, 9953 |
| `sc-upc` | SC/UPC | optical | `sc-upc` only | `gpon-sc-upc`, `xgspon-sc-upc` | 1244, 2488, 9953 (filtered by rating) |
| `lc-upc` | LC/UPC | optical | `lc-upc` only | `gpon-lc-upc`, `xgspon-lc-upc`, plus one Ethernet optic chosen by rate: `1000base-lx` (≥1G), `10gbase-lr` (≥10G), `25gbase-lr` (≥25G), `100gbase-lr4` (≥100G) | 1000, 1244, 2488, 9953, 10000, 25000, 100000 (filtered by rating) |
| `lc-apc` | LC/APC | optical | `lc-apc` only | `gpon-lc-upc`, `xgspon-lc-upc`, plus one Ethernet optic chosen by rate: `1000base-lx` (≥1G), `10gbase-lr` (≥10G), `25gbase-lr` (≥25G), `100gbase-lr4` (≥100G) | 1000, 1244, 2488, 9953, 10000, 25000, 100000 (filtered by rating) |
| `coax` | F-connector | coax | `coax` only | `moca-11`, `moca-25`, `docsis-30`, `docsis-31` | 175, 1000, and 2500 / 5000 / 10000 gated by rating |
| `dsl` | RJ11 | dsl | `dsl` only | `adsl2plus`, `vdsl2-17a`, `vdsl2-35b` | 24, 100, and 300 when rated 300M |
| `powerline` | Mains | powerline | `powerline` only | `homeplug-av`, `homeplug-av2`, `ghn`, `ghn-25` | 200, 1000, 1700, 2500 (fixed) |
| `console` | Console | management | `console` only | `console-rs232` | 0.1152 (115200 baud) |
| `usb` | USB | management | `usb`, `console` | `usb-console` | 12 |
| `antenna` | Antenna | wireless | `antenna` only | `wireless-2.4`, `wireless-5`, `wireless-60` — narrowed to exactly one band per port | the port's declared rate |

That is **18 cages**. `CAGES` is the authority; if you add one, this table and
the tests in section 8.3 are what has to change with it.

### Reading the table

- **`rj45` is not a synonym for "ethernet".** It is one cage among eighteen. A
  10GBASE-T port is `rj45`; a 10GBASE-SR port is `sfp+`. Only the cage decides
  what plugs in.
- **The SFP family intermates across rates.** `sfp`, `sfp+` and `sfp28` all mate
  with each other in both directions, because a slower module fits a faster
  cage. What stops a 25G module in an SFP cage is the *medium and speed*
  intersection, not the connector — the 25G optics are simply not in the SFP
  cage's media list.
- **QSFP and SFP never mix.** `qsfp+`, `qsfp28` and `qsfpdd` mate among
  themselves; none of them mates with the SFP family. Different shell width.
- **The four PON cages mate only with themselves.** `sc-apc` will not meet
  `sc-upc`, and `lc-apc` will not meet `lc-upc`. That is the polish rule
  (section 4.2).
- **`lc-upc` and `lc-apc` carry identical media.** Both offer the PON media plus
  one Ethernet optic chosen by the declared rate (LR/LX variants, which really do
  terminate in LC), and neither medium id says "APC". Polish exists only in the
  cage and in `FERRULE`; `CAGE_MATE` refuses the pair before any medium is
  considered, so the enforcement is real even though the ids look identical.
- **LC is a connector, not a protocol.** A port whose spec says
  `"connector": "lc"` is aliased to `lc-upc` (the flat, blue, ubiquitous variant)
  rather than becoming a third, unmateable cage. Model APC explicitly as
  `lc-apc`.
- **`combo` speed classes stop at 10G** even when the port is rated higher, and
  they never include 2.5G/5G even though the media list offers those optics.
  Model a 2.5G combo port as its own cage rather than relying on this list.

### Speeds are the cage's, then the port's

`CAGE_SPEEDS` gives the *cage* its speed classes, and `derivePortHardware` calls
it with the port's declared rate. Rate-agile cages (`rj45`, `combo`, `qsfpdd`,
the PON cages, `coax`, `dsl`) filter their list with `maxMbps`; fixed-rate cages
(`sfp`, `sfp+`, `sfp28`, `qsfp+`, `qsfp28`, `powerline`, `console`, `usb`)
ignore it entirely. Final link speed is then:

```
speed = max(intersection(portA.speedCaps, portB.speedCaps))
speed = min(speed, chosenMedium.speedMbps)
```

The second clamp is why a 10G port pair with a `1000base-t-sfp` selected runs at
1000 Mbps, not 10000. "Both cages could do 10G" is not enough — the glass in the
cage decides.

Because the fixed lists ignore the port's rating, **an unqualified spec can
advertise more than its port can run**: a port declared `"speed": "10G"` with
`"connector": "sfp28"` gets `speedCaps: [10000, 25000]` and negotiates 25G
against an identical port, even though its own `maxSpeedMbps` is 10000. This is
why catalogue uplinks declare `speedCaps` explicitly:

```json
{ "name": "xe1/1", "type": "ethernet", "speed": "10G",
  "connector": "sfp28", "speedCaps": [10000, 25000] }
```

If the datasheet says the port is 10G only, say so with `speedCaps: [10000]`;
`CAGE_SPEEDS` will not do it for you.

---

## 3. Where cage inference comes from

Device specs stay terse: `{ "name": "Gi1/1/1", "type": "ethernet", "speed": "10G" }`.
`derivePortHardware` picks the cage in this order:

```
spec.cage  ->  spec.connector  ->  inferCage(spec, maxMbps)
```

so a spec can always name its own connector, and `"connector": "sfp+"` is the
usual way. Before the cage is used, `derivePortHardware` normalises it twice:

- **Aliases.** `CAGE_ALIAS` maps bare connector tokens that are really cages onto
  the cage they mean. Today that is one entry, `lc` → `lc-upc`, because a
  datasheet says "LC" and a cage has to carry a polish.
- **Unknowns.** A cage that is not a key of `CAGES` stays as it is, but with
  `family: 'unknown'`, no media, no speed caps and no mates — so every cable
  touching it is refused with `E_CONNECTOR_MISMATCH` naming the raw token. It is
  never silently reinterpreted as RJ45.

When the spec is silent, `inferCage` decides by **name first, then speed**:

1. `type` decides outright for the non-ethernet families: `wireless`/`radio` →
   `antenna`, `console` → `console`, `usb` → `usb`, `coax` → `coax`,
   `dsl`/`adsl`/`vdsl` → `dsl`, `powerline`/`plc`/`mains` → `powerline`.
2. The name decides console and USB: `/console|con\d|tty|aux/` → `console`,
   `/usb/` → `usb`.
3. The name decides fibre connectors, and it is checked **before** the generic
   PON fallback: `sc/apc` → `sc-apc`, `sc/upc` → `sc-upc`, `lc/apc` → `lc-apc`,
   `lc/upc` → `lc-upc`, then any PON-ish name (`gpon`, `xgspon`, `pon1`,
   `pon`) → `sc-apc`.
4. Otherwise the port is optical if the name looks optical
   (`sfp|qsfp|xfp|cfp|xe-|et-|fc\d`) **or** the declared speed is 25G, 40G or
   100G; if not, it is `rj45`.
5. Among optical ports, a name containing `qsfpdd` wins outright, then the rate
   grades it: ≥200G `qsfpdd`, ≥100G `qsfp28`, ≥40G `qsfp+`, ≥25G `sfp28`,
   ≥10G `sfp+`, otherwise `sfp`.

Two consequences worth knowing:

- **A 200G port with no connector in its spec becomes `qsfpdd` by rate alone**,
  and a 100G port becomes `qsfp28`. That is how most uplinks in the catalogue
  are modelled — correctly, as long as the rate in the spec is the truth.
- **A missing `speed` means 1G** (`parseSpeedMbps(spec.speed) || 1000`), which
  means a port with no speed and no connector is RJ45 at 1G. If a fibre port
  comes out copper, the first thing to check is a typo in the port name — the
  name is the only hint the deriver has.

---

## 4. What will not mate, and why

`canMate` answers in a fixed order and returns the **first** verdict:

1. `antenna` against anything that is not `antenna` → `E_WIRELESS_TO_WIRED`
2. `cagesMate()` fails and the polishes differ → `E_POLISH_MISMATCH`
3. `cagesMate()` fails → `E_CONNECTOR_MISMATCH`
4. no shared medium → `E_NO_COMMON_MEDIA`
5. no common speed → `E_NO_COMMON_SPEED`

| Refused pair | Code | Reason |
|--------------|------|--------|
| RJ45 into an SFP/SFP+/SFP28/QSFP cage | `E_CONNECTOR_MISMATCH` | Copper plug cannot enter a module cage |
| Fibre optic into an RJ45 socket | `E_CONNECTOR_MISMATCH` | The socket has no cage to hold a ferrule |
| SC/APC into SC/UPC, LC/APC into LC/UPC | `E_POLISH_MISMATCH` | Same ferrule shape, incompatible endface angle |
| LC into SC (any polish) | `E_CONNECTOR_MISMATCH` | Different ferrule shape |
| SFP28 into QSFP-DD, QSFP28 into SFP+ | `E_CONNECTOR_MISMATCH` | Different shell size |
| Antenna into anything wired | `E_WIRELESS_TO_WIRED` | A radio has no cable |
| Two radios on different bands | `E_NO_COMMON_MEDIA` | They mate, but share no radio band |
| Console into a data port | `E_CONSOLE_TO_DATA` | Management only |
| Combo RJ45 half while the SFP half is cabled | `E_COMBO_OCCUPIED` | One physical position, two logical ports |

### 4.1 Copper into an optical cage, and fibre into RJ45

The commonest refusal, and the one that is always correct. `CAGE_MATE.rj45` is
`['rj45', 'combo']`; no optical cage lists `rj45`. The reverse fails the same
way — an `sfp+` port against `rj45` finds no entry either.

There is a deliberate distinction inside the optical world that trips people up:
`1000base-t-sfp` is the **copper SFP module**, and it *is* legal in `sfp` and
`sfp+` cages. Bare `1000base-t` — RJ45 copper cabling — is deliberately absent
from those media lists, because including it once let two fibre cages be joined
by a copper run. If you need copper at the far end of an SFP link, the medium is
`1000base-t-sfp`; if you need copper *cabling*, the port is `rj45`.

### 4.2 SC/APC into SC/UPC, and LC/APC into LC/UPC

An APC ferrule is ground at an **8° angle**; a UPC ferrule is flat. Push the two
together and the endfaces meet along one edge only, leaving an **air gap** across
the core. The glass/air boundary reflects roughly 4 % of the light straight back
down the fibre into the transmitter — the very reflection the angled polish
exists to deflect into the cladding. In practice that costs about **3 dB** of
loss, destabilises the laser, and the spring load on the single contact edge can
**chip the endface**. It is not a marginal link; it is a damaged connector.

So `sc-apc` lists only `sc-apc`, `sc-upc` only `sc-upc`, and the same for the LC
pair. `FERRULE` carries the geometry that lets the engine say *why*:

```js
'sc-apc': { shape: 'sc', polish: 'apc', colour: 'green', angleDeg: 8 },
'sc-upc': { shape: 'sc', polish: 'upc', colour: 'blue',  angleDeg: 0 },
'lc-apc': { shape: 'lc', polish: 'apc', colour: 'green', angleDeg: 8 },
'lc-upc': { shape: 'lc', polish: 'upc', colour: 'blue',  angleDeg: 0 },
```

`polishMismatch(a, b)` is true only when `fa.shape === fb.shape` **and**
`fa.polish !== fb.polish`. Anything else falls through to the generic connector
mismatch, which is why SC against LC/APC is `E_CONNECTOR_MISMATCH` and not a
polish error.

Field conventions for the colours are enforced only by comment and by the
`colour` field: green is APC, blue is UPC, aqua is MPO. Use the colour as your
sanity check when reading a datasheet — an OLT "green SC" port is APC.

### 4.3 LC into SC

Different shape (`shape: 'lc'` versus `shape: 'sc'`), so `polishMismatch` is
false and the verdict is `E_CONNECTOR_MISMATCH`: "Cannot mate SC/APC to LC/UPC
(incompatible connectors)". There is no adapter in the model, because there is
no adapter in the field that does not cost you a patch panel and a second lead.
Model the patch panel as a device if you need one.

Note that `FERRULE` also contains `lc` and `mpo` keys. Those exist because the
`MEDIA` catalogue uses them as `connector` values; they are not cages. `mpo` is
the 40G/100G/200G/400G ribbon connector and currently has no cage of its own —
those optics ride in QSFP cages. That is a known gap, not an oversight in this
document.

### 4.4 QSFP-DD taking QSFP28 and QSFP+ modules

`CAGE_MATE.qsfpdd` includes `qsfp28` and `qsfp+`, and `CAGE_MEDIA.qsfpdd`
includes the 100G and 40G optics. That is by design: a QSFP-DD cage is
backward-compatible with older modules, and refusing the pair would make a 400G
port unable to accept the 100G optic most labs actually own.

The consequence is that **the link runs at the module's rate, not the cage's
maximum**. A 200G `qsfpdd` port against a 100G `qsfp28` port negotiates the
highest common rate, picks `100gbase-sr4`, and reports `speedMbps: 100000`. It
does **not** raise `W_SPEED_DOWNGRADE`, because that warning fires only when the
rate is below the maximum of *both* ports and here one of them is a 100G port.
Do not read "no warning" as "ran at full speed" — read `speedMbps`.

The other direction is not automatic: `qsfpdd` does **not** mate with `sfp28`,
and `qsfp28` does **not** mate with `sfp+`. A 100G uplink cabled to a 25G uplink
is refused with `E_CONNECTOR_MISMATCH`, not silently downshifted. Backward
compatibility runs QSFP-DD → QSFP28 → QSFP+, never across the SFP shell.

### 4.5 Combo RJ45/SFP cages

A combo port is one physical position that accepts **either** an RJ45 plug or an
SFP module, never both. Hardware sells it that way; `CAGES.combo` models it as
one cage that mates with both worlds, and the device spec models it as two
interfaces that name each other:

```json
{ "name": "Gi0/0/3",     "type": "ethernet", "speed": "1G",
  "comboWith": "Gi0/0/3-sfp", "comboRole": "rj45" },
{ "name": "Gi0/0/3-sfp", "type": "ethernet", "speed": "1G", "connector": "sfp",
  "speedCaps": [1000], "comboWith": "Gi0/0/3", "comboRole": "sfp" }
```

Either half accepts a cable on its own, in its own medium. Once one is cabled the
other is refused with **`E_COMBO_OCCUPIED`**, naming the sibling port. That check
is *not* in `validation.js` — it is in `Topology.validateLink` (`engine/topology.js`),
so that the dry-run endpoint and a real connection attempt behave identically.
`E_COMBO_OCCUPIED` therefore never appears from a bare
`validation.validateConnection()` call, and a contributor adding cable rules
should remember that one code lives outside the rules engine.

Two traps: exclusion only works when **both** halves carry `comboWith`, and a
device with combo ports has *more interfaces than physical ports* — that is
correct, not a miscount.

### 4.6 An antenna port is not cablable

`CAGE_MATE.antenna` is `['antenna']`, and `canMate` short-circuits first: if
exactly one side is `antenna`, the answer is `E_WIRELESS_TO_WIRED`. An AP's
`radio0` cannot be cabled to a switch port, a router port or a PON port.

Antenna-to-antenna is legal — that is how a point-to-point radio link is drawn —
but the two radios must also agree on a band, because `derivePortHardware`
narrows an antenna port to a single medium:

```
rated >= 5000 Mbps -> wireless-60
rated >= 1000 Mbps -> wireless-5
otherwise          -> wireless-2.4
```

and `speedCaps` for a radio is `[maxMbps]`, i.e. exactly the declared rate. So a
5 GHz radio against a 2.4 GHz radio mates and then fails with
`E_NO_COMMON_MEDIA: No shared medium between Antenna and Antenna.` — which sounds
odd until you remember both ends are simply "Antenna".

### 4.7 Console and USB

`console` mates only `console`. `CAGE_MATE.usb` lists both `usb` and `console`,
but the table is read one-way, so the pair is not actually usable:

```text
cagesMate('usb', 'console')      -> true
cagesMate('console', 'usb')      -> false
```

and even in the permitted direction there is no shared medium (`console-rs232`
versus `usb-console`), so `canMate` ends at `E_NO_COMMON_MEDIA` or
`E_CONNECTOR_MISMATCH` depending on which port is passed first. **Treat a USB
console port as connectable only to another USB console port.** This is the
cleanest example in the codebase of why step 3 of the new-connector checklist
(symmetry) exists: a one-sided entry is silent, survives review, and produces an
order-dependent verdict that is miserable to debug.

`validateConnection` reports `E_CONSOLE_TO_DATA` and suppresses the connector
verdict when a console port is paired with a data port, so the message the user
sees is "console cannot be cabled to the data port", not "RJ45 does not mate
Console".

---

## 5. How the engine decides

The full chain, in call order:

```
iface spec  (JSON)
   |
   v  derivePortHardware(spec, devSpec)          engine/media.js
   |     cage  = spec.cage || spec.connector || inferCage(spec, maxMbps)
   |     media = CAGE_MEDIA[cage](maxMbps)       (or spec.media / spec.supportedMedia)
   |     speeds= CAGE_SPEEDS[cage](maxMbps)      (or hw.speedCaps / spec.speedCaps)
   v
port hardware  { cage, media[], speedCaps[], maxSpeedMbps, poeOut, poeIn }
   |
   v  Topology.validateLink(aId, aIface, bId, bIface)    engine/topology.js
   |     1. combo sibling check -> E_COMBO_OCCUPIED
   |     2. delegate to validateConnection
   v
validateConnection({portA, portB, ...})            engine/validation.js
      E_NO_PORT -> E_SELF_LINK -> E_PORT_IN_USE -> E_CONSOLE_TO_DATA
      -> canMate() verdict (E_WIRELESS_TO_WIRED / E_POLISH_MISMATCH /
         E_CONNECTOR_MISMATCH / E_NO_COMMON_MEDIA / E_NO_COMMON_SPEED)
      -> E_MEDIA_NOT_SUPPORTED (only when the caller names a mediaId)
      -> speed = max(common caps), clamped by the chosen medium
      -> E_OPTICAL_BUDGET (PON only) / W_OPTICAL_HEADROOM
      -> E_POE_BUDGET, E_LAG_SPEED_MISMATCH
      -> warnings: W_DISTANCE, W_COPPER_LONGRUN, W_DUPLEX_MISMATCH,
         W_SPEED_DOWNGRADE, W_POE_DRAW
   v
{ ok, errors[], warnings[], media[], mediaId, speedMbps }
```

`cagesMate(a, b)` reads `CAGE_MATE[a]` **only**, so the table has to be
symmetric by hand. Add `b` to `a`'s list and `a` to `b`'s, or the link will be
refused in one direction and accepted in the other.

`commonMedia` is the intersection of the two ports' `media[]`, but only after
`cagesMate` passes — a mating failure produces no media list at all, which is why
`verdict.media` is empty on a refused link. `preferredMedia` then ranks
`fiber > dac > copper > console/wireless`, breaking ties on speed, and
`negotiateSpeed` takes the maximum shared `speedCaps` entry.

### Error and warning codes

Everything the rules engine can emit, and where it comes from:

| Code | Severity | Emitted by | Meaning |
|------|----------|-----------|---------|
| `E_NO_PORT` | error | validation | Port does not exist on its device |
| `E_SELF_LINK` | error | validation | A device cabled to itself |
| `E_PORT_IN_USE` | error | validation | Port already carries a link |
| `E_COMBO_OCCUPIED` | error | **topology.js** | The other half of the combo cage is in use |
| `E_CONSOLE_TO_DATA` | error | validation | Console port paired with a data port |
| `E_WIRELESS_TO_WIRED` | error | media `canMate` | Radio against a wired cage |
| `E_POLISH_MISMATCH` | error | media `canMate` | Same ferrule shape, different polish |
| `E_CONNECTOR_MISMATCH` | error | media `canMate` | Cages cannot physically mate |
| `E_NO_COMMON_MEDIA` | error | media `canMate` | Cages mate but share no medium |
| `E_NO_COMMON_SPEED` | error | media `canMate` | Shared medium, no common rate |
| `E_MEDIA_NOT_SUPPORTED` | error | validation | Caller asked for a medium one port lacks |
| `E_OPTICAL_BUDGET` | error | validation | PON downstream *or* upstream over the class budget |
| `E_POE_BUDGET` | error | validation | PSE ports draw more than the budget |
| `E_LAG_SPEED_MISMATCH` | error | validation | LAG members at different rates |
| `W_OPTICAL_HEADROOM` | warning | validation | PON link within 3 dB of the budget |
| `W_DISTANCE` | warning | validation | Length exceeds the medium's reach |
| `W_COPPER_LONGRUN` | warning | validation | Copper past the 90 m horizontal limit |
| `W_DUPLEX_MISMATCH` | warning | validation | Ends disagree on duplex |
| `W_SPEED_DOWNGRADE` | warning | validation | Link below the maximum of *both* ports |
| `W_POE_DRAW` | warning | validation | Powered device on a port that supplies no PoE |

`RULES` in `validation.js` is the declared catalogue, and `validateTopology`
uses it for severity. Three codes above are emitted but **not** in `RULES`:
`E_COMBO_OCCUPIED` (it lives in `topology.js`), `E_OPTICAL_BUDGET` and
`W_OPTICAL_HEADROOM`. Unknown codes are still classified — anything starting
`W_` is a warning, everything else an error — but if you add a code, add it to
`RULES` so the UI can document it and the counts stay honest.

One behaviour to expect while debugging: **warnings are computed even when a
link is refused.** An SC/APC to SC/UPC pair returns `E_POLISH_MISMATCH` *and*
`W_SPEED_DOWNGRADE`, because the speed intersection is calculated regardless of
the connector verdict. The error is the one that blocks; ignore the warning on a
refused link.

---

## 6. Worked examples

Both transcripts are real output from
`new Topology().validateLink(aId, aIface, bId, bIface)` with the catalogue in
`devices/`. The `devices` are built from the JSON shown, so you can reproduce
either one.

### 6.1 Refused: copper into an SFP+ uplink

`devices/generic/generic-pc.json` declares `{ "name": "eth0", "type": "ethernet",
"speed": "1G" }` — no connector, so it infers `rj45`. The Catalyst 9300 uplink
declares its cage:

```json
{ "name": "Gi1/1/1", "type": "ethernet", "speed": "10G",
  "connector": "sfp+", "speedCaps": [10000] }
```

```text
> validateLink(pc, 'eth0', c9300, 'Gi1/1/1')

{
  "ok": false,
  "errors": [
    {
      "code": "E_CONNECTOR_MISMATCH",
      "message": "PC/eth0 <-> Catalyst 9300-48P/Gi1/1/1: Cannot mate RJ45 to SFP+ (incompatible connectors)."
    }
  ],
  "warnings": [],
  "media": [],
  "mediaId": null,
  "speedMbps": null
}
```

The refusal is correct and the fix is a hardware decision, not a config one.
Either put a 1000BASE-T SFP in the uplink (`"media": ["1000base-t-sfp"]` on the
spec, or just let the medium be chosen — it is already in the `sfp+` media list),
or cable `eth0` to one of `Gi1/0/1`…`Gi1/0/48`, which are `rj45`.

### 6.2 Refused: SC/APC into an SC/UPC socket

The OLT is real hardware from the catalogue; the ONT is the minimum spec that
demonstrates the rule:

```json
{ "vendor": "lab", "model": "ONT-UPC", "label": "Lab ONT (SC/UPC)",
  "category": "ont", "capabilities": ["host"],
  "interfaces": [
    { "name": "pon", "type": "pon", "speed": "2.5G", "connector": "sc-upc" }
  ] }
```

The OLT's `pon1` is `sc-apc` (declared in `devices/adtran/sdx-6320.json`).

```text
> validateLink(olt, 'pon1', onu, 'pon')

ok=false  speedMbps=2488
[E_POLISH_MISMATCH] SDX 6320 10G Combo PON OLT/pon1 <-> Lab ONT (SC/UPC)/pon:
  SC/APC and SC/UPC take the same SC ferrule but not the same polish
  (APC angled 8 deg vs UPC flat). They are not intermateable - forcing it costs
  about 3 dB and can chip the endface.
[W_SPEED_DOWNGRADE] Link ... runs at 2.488G, below the 10G of pon1 and the
  2.5G of pon.
```

Note the second line: the GPON rate *was* negotiated (2488 Mbps) even though the
link is impossible. The error blocks; the warning is noise in this context.

The fix is a green-vs-blue patch lead: declare the ONT `"connector": "sc-apc"`,
or swap the OLT's PON module for an SC/UPC one and declare `sc-upc` on both ends.
Declaring *one* end differently to silence the error is the bug this check
exists to catch.

### 6.3 Accepted: a 100G module in a 200G QSFP-DD cage

Neither spec names its cage; both are inferred from the rate.

```json
/* devices/adtran/sdx-6330.json */
{ "name": "qsfpdd1/1", "type": "ethernet", "speed": "200G" }
```

```json
/* devices/arista/7050cx3-32s.json — 32x 100G QSFP28 */
{ "name": "Ethernet1", "type": "ethernet", "speed": "100G" }
```

```text
> validateLink(sdx6330, 'qsfpdd1/1', a7050cx3, 'Ethernet1')

ok=true  mediaId=100gbase-sr4  speedMbps=100000
```

What happened, step by step:

1. `inferCage` saw 200G on the left → `qsfpdd`; 100G on the right → `qsfp28`.
2. `CAGE_MATE.qsfpdd` contains `qsfp28`, so they mate.
3. Shared media: the 100G and 40G optics, both in each cage's list.
4. `preferredMedia` ranked fibre over DAC and picked the fastest — `100gbase-sr4`.
5. `negotiateSpeed` took the highest shared caps entry, `100000`.

To force the 40G path instead, pass `mediaId`:

```js
validateConnection({ portA, portB, mediaId: '40gbase-lr4' })  // 40000 Mbps
```

and to prove the model is not merely permissive, change `Ethernet1` to an
`sfp28` port: the same call then returns
`E_CONNECTOR_MISMATCH: Cannot mate QSFP-DD to SFP28 (incompatible connectors).`

---

## 7. Debugging a refused cable

In order:

1. **Read the code, not the label.** `E_CONNECTOR_MISMATCH` names both cages in
   the message. If it says "RJ45" about a port you believe is fibre, the spec
   does not say what you think it says.
2. **Print the derived hardware**, not the JSON:
   `new Topology().addDevice(spec)` then read `iface.hardware` — `cage`,
   `media`, `speedCaps`, `maxSpeedMbps`. The JSON is an input; this is what the
   rules actually used.
3. **Check for an unknown cage.** A connector that is not in `CAGES` does not
   throw: the port keeps the raw string, reports `family: 'unknown'` with an
   empty `media` and `speedCaps`, and refuses everything — including a port of
   its own kind, with the slightly comic `Cannot mate sfp++ to sfp++`. If a port
   shows no media and no rates at all, the cage name is wrong or unmodelled.
4. **Check `speedCaps` overrides.** A spec that declares
   `"speedCaps": [10000]` on an SFP+ port removes 1000 from the negotiation, and
   a 1G optic in it then fails with `E_NO_COMMON_SPEED` even though the cage
   supports both rates. `CAGE_SPEEDS` is only a default.
5. **Check the medium, not just the cages.** `E_NO_COMMON_MEDIA` after a
   successful mate almost always means one port carries `1000base-t` (RJ45
   copper) while the other carries `1000base-t-sfp`. They are different ids on
   purpose.
6. **Check for a combo sibling.** `E_COMBO_OCCUPIED` means the other half of the
   position is patched.
7. **Remember the missing speed.** No `speed` field means 1G, and that silently
   grades an optical port down to `sfp`.
8. **Trust warnings about distance, not about speed, on a refused link.**

---

## 8. Adding a new connector family

A connector family is data, not logic. The checklist below is the whole job;
each item is a constant in `engine/media.js` unless stated otherwise. Use
`combo`, `sc-apc` and `qsfpdd` as reference implementations of a hybrid cage, a
polish-sensitive cage and a backward-compatible cage.

### 8.1 Checklist

1. **`MEDIA` — add the media the new cage can carry.** One entry per
   cable/optic/band, with `name`, `family` (`copper` | `fiber` | `dac` |
   `console` | `wireless`, plus `coax` | `dsl` | `powerline`), `connector`,
   `speedMbps`, `maxRangeM`, and `fiber`/`wavelengthNm` or `upstreamMbps` where
   relevant. A cage with no media in `MEDIA` can never carry a link.
2. **`CAGES` — add the cage** with `name`, `family` and `label`. The `label` is
   what the UI tooltip shows, so write it for a human: `'SC/APC (green, angled
   8 deg)'`. If the datasheet calls the connector by a bare token that is not a
   cage (as `lc` is), add a `CAGE_ALIAS` entry pointing it at the real cage — an
   unaliased token becomes an unknown cage and refuses every cable.
3. **`CAGE_MATE` — add the cage to *both* sides of every pair.** Symmetry is
   manual. A cage that mates with itself needs its own name in its own list. The
   `usb`/`console` pair is the codebase's own example of getting this wrong:
   `usb` lists `console`, `console` does not list `usb`, and the verdict now
   depends on argument order.
4. **`CAGE_MEDIA` — add a function `(maxMbps) => [mediaId]`.** Filter by
   `maxMbps` when the cage has a rate ceiling (see `rj45`, `coax`); return a
   fixed list when it does not (see `sfp`, `powerline`). Never put a bare
   copper id (`1000base-t`) in an optical cage.
5. **`CAGE_SPEEDS` — add a function `(maxMbps) => [Mbps]`.** Fixed list for a
   fixed-rate cage, filtered list for a rate-agile one. These are the values
   `negotiateSpeed` intersects, so a missing entry means the link cannot form
   even if both cages "obviously" support the rate.
6. **`FERRULE` — only for optical cages.** Add `{ shape, polish, colour,
   angleDeg }` so a polish mistake produces `E_POLISH_MISMATCH` with a reason
   instead of a generic refusal. Shapes must be spelled identically for two
   cages to be considered the same shape (`'sc'`, `'lc'`); polish is `'upc'` or
   `'apc'`; APC is `angleDeg: 8` and green, UPC is `0` and blue.
7. **`inferCage` — add a name rule, in the right place.** Name rules go before
   the generic optical test, and **any fibre connector rule must go before the
   PON fallback** (`/gpon|xgs-?pon|pon/` → `sc-apc`), or every port you name
   will be captured by it. If the family is selected by `type` (`coax`, `dsl`,
   `powerline`, `wireless`), add it to the `type` block at the top instead.
8. **UI labels — update the copies.** `web/canvas.js: cageLabel()` and
   `web/faceplate.js: CAGE_INFO` both keep their own cage → label/family maps
   (the canvas cannot import the app module). Both fall back gracefully
   (`|| cage`, `CAGE_INFO.unknown`), so a missing entry is a cosmetic bug, not a
   crash — but it will show a raw id in the tooltip.
9. **Tests — run the ones that exist, then add one.** See 8.3.
10. **Docs — this file, and `docs/PHYSICAL_LAYER.md` if the medium catalogue
    changed.** Add a row to section 2, and a "will not mate" case if the new
    family has an obvious trap.

### 8.2 A worked sketch

To add a hypothetical `cs` connector (a duplex LC-sized push-pull used on some
100G/400G optics), the diff would touch exactly five constants and one regex:

```js
// 1. MEDIA: nothing new if the optics already exist — reuse 100gbase-*.
// 2. CAGES
cs: { name: 'CS', family: 'optical', label: 'CS duplex (flat polish)' },
// 3. CAGE_MATE  (both directions!)
cs: ['cs', 'qsfp28', 'qsfpdd'],
// 4. CAGE_MEDIA
cs: function (maxMbps) { return ['100gbase-sr4', '100gbase-lr4', '400gbase-dr4', '400gbase-fr4']; },
// 5. CAGE_SPEEDS
cs: function (maxMbps) { return [100000, 400000].filter(function (v) { return v <= maxMbps; }); },
// 6. FERRULE (flat polish, so a CS/APC variant would be a separate cage)
cs: { shape: 'cs', polish: 'upc', colour: 'blue', angleDeg: 0 },
```

and in `CAGE_MATE`, `qsfp28` and `qsfpdd` must each gain `'cs'` as well, or the
pair is refused from the QSFP side. Then add the name rule to `inferCage`
*above* the PON fallback.

### 8.3 Which test to run

| Test | What it protects |
|------|------------------|
| `node test/hardware-invariants.test.js` | Runs the whole catalogue: every spec's claimed optics must be deliverable by its ports, no unknown cages, no impossible media |
| `node test/combo.test.js` | Combo cage mates both worlds and `E_COMBO_OCCUPIED` blocks the second cable |
| `node test/fiber-connectors.test.js` | SC/APC vs SC/UPC refusal, ferrule geometry, PON ports are not copper |
| `node test/pon-connectors.test.js` | LC/SC connectors on real OLT/ONT specs; unresolved cages are never painted copper |
| `node test/qsfpdd.test.js` | QSFP-DD cage, 200G/400G optics, downshift to a QSFP28 module |
| `node test/optics-catalogue.test.js` | Every optical medium is reachable from at least one cage |
| `node test/validation.test.js` | Error codes and severities, rule ordering |
| `npm test` | Everything, in the order CI runs it |

Add a case to the closest of those rather than a new file: a new connector
family belongs in `fiber-connectors.test.js` (or a sibling) with at least
"mates with itself", "refused against the nearest wrong cage", and "carries the
medium its datasheet claims". `npm run syntax` catches the rest.

---

## 9. Model limits worth knowing

Stated so nobody debugs a limitation as a bug:

- **MPO has no cage.** The 40G/100G/200G/400G ribbon optics ride in QSFP cages,
  and `FERRULE.mpo` exists for the media catalogue. There is no separate MPO
  patch-panel cage or breakout modelling.
- **No adapters, no gender changers, no media converters.** Every link is
  cage-to-cage. Model an adapter as a device if a lab needs one.
- **DAC length is a medium property, not a cage property.** `dac-1g` to
  `dac-100g` carry their own `maxRangeM`; the cage does not constrain it.
- **`console` is 0.1152 Mbps**, i.e. 115200 baud expressed in the same unit as
  everything else. Do not "fix" it to 0.
- **Polish is enforced by the cage pair, not by the medium.** `lc-upc` and
  `lc-apc` share medium ids; only `CAGE_MATE` and `FERRULE` keep them apart.
- **An unrecognised connector is reported as unknown, not guessed.** No media, no
  rates, no mates, `family: 'unknown'` — a refusal you can act on instead of a
  copper port that refuses every lead. Add the cage to `CAGES` if it is real.
- **`W_SPEED_DOWNGRADE` needs both ports to be faster than the link.** A 400G
  port on a 100G link produces no warning if the other port is 100G. Read
  `speedMbps` and `mediaId` instead of inferring rate from the absence of
  warnings.
- **Verdicts can depend on argument order.** Where `CAGE_MATE` is one-sided (the
  `usb`/`console` pair), swapping `portA` and `portB` changes the code from
  `E_CONNECTOR_MISMATCH` to `E_NO_COMMON_MEDIA`. Pass the ports in the order the
  user drew the cable, and never write a test that assumes the two are
  interchangeable.

---

See also: [docs/PHYSICAL_LAYER.md](PHYSICAL_LAYER.md) for the medium catalogue and
the L2 rules built on top, and [docs/DEVICE_REGISTRY.md](DEVICE_REGISTRY.md) for
how a device spec declares its connectors.
