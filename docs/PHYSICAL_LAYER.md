# Physical Layer, Link Types and Feasibility Rules

PacketForge models the **physical layer** explicitly, so a topology can only be
cabled the way real hardware allows. This document covers the port model, the
medium catalogue, the feasibility rules, and the L2 features built on top
(VLANs, link aggregation, spanning tree).

---

## 1. The port model

Every interface has a derived **hardware descriptor** (`engine/media.js`):

```json
{
  "name": "sfp-sfpplus1",
  "cage": "sfp+",
  "cageName": "SFP+",
  "family": "optical",
  "media": ["10gbase-sr", "10gbase-lr", "10gbase-er", "1000base-sx", "1000base-lx", "..."],
  "speedCaps": [1000, 10000],
  "maxSpeedMbps": 10000,
  "poeOut": null,
  "poeIn": null
}
```

| Field | Meaning |
|-------|---------|
| `cage` | The physical connector/cage — **26 of them**: Ethernet cages (`rj45`, `sfp`, `sfp+`, `sfp28`, `sfp56`, `combo`, `qsfp+`, `qsfp28`, `qsfp56`, `qsfpdd`), the Fibre Channel set (`fc-sfp`, `fc-sfp28`, `fc-sfpdd`, `fc-qsfp28`), `xfp`, fibre connectors (`sc-apc`, `sc-upc`, `lc-apc`, `lc-upc`) and the non-Ethernet families (`coax`, `dsl`, `powerline`, `console`, `usb`, `antenna`, `wwan`). The full table is in [CONNECTORS.md](CONNECTORS.md). Note `mpo` is **not** a cage — it is a media `connector` value, and using it as a cage is an error |
| `media[]` | Media (optics / copper / DAC) the port can carry |
| `speedCaps[]` | Line rates the port can negotiate (Mbps) |
| `poeOut` | Watts this port can *source* (PSE) |
| `poeIn` | Watts this port *draws* (PD) |

### Derivation

Device specs stay terse (`{ "name": "ether1", "type": "ethernet", "speed": "1G" }`).
`inferCage()` in `engine/media.js` walks these rules in order and the first one wins:

| # | Signal | Cage |
|---|---|---|
| 1 | name starts `wwan*`, `wan5g`, `modem*`, `lte*`, `nr5g`, `nr*`, `5g*` | `wwan` — a cellular modem is neither copper nor Wi-Fi, and it is checked **before** `type` because specs rewrite these ports as `type: "wireless"` |
| 2 | `type` is a radio type (`wireless`, `radio`, `wifi`, …) | `antenna` |
| 3 | `type` is `console` / `usb` / `coax` / `dsl`, `adsl`, `vdsl` / `powerline`, `plc`, `mains` | that family (`console`, `usb`, `coax`, `dsl`, `powerline`) |
| 4 | name starts `wlan*`, `wifi*`, `wi-fi*`, `radio*`, `wwan*`, `nr5g*` | `antenna` |
| 5 | name contains `console`, `con<N>`, `tty`, `aux` → `console`; `usb` → `usb` | |
| 6 | name names a fibre connector (`sc-apc`, `sc-upc`, `lc-apc`, `lc-upc`, `scapc`, `lcupc`, …) | that cage |
| 7 | name says PON (`gpon`, `xg-pon`, `xgs-pon`, `pon<N>`) | `sc-apc` — the ISP convention, because a PON port's connector is a vendor choice; an explicit `connector` on the spec always wins |
| 8 | name matches `sfp`/`qsfp`/`xfp`/`cfp`/`xe-`/`et-`/`fc<N>`, **or** speed is 25G/40G/100G | optical, by rule 9 |
| 9 | optical: name says `qsfpdd` → `qsfpdd`; `qsfp56` → `qsfp56`; otherwise by max rate — ≥200G `qsfpdd`, ≥100G `qsfp28`, ≥40G `qsfp+`, ≥25G `sfp28`, ≥10G `sfp+`, else `sfp` | |
| 10 | nothing matched | `rj45` |

A port named for its cage beats its rate: `qsfpdd1/1` carrying 200G is a QSFP-DD cage, not a
QSFP28 that happens to be fast. QSFP56 has to be named for the same reason — a bare 200G rate
alone resolves to QSFP-DD, which is far more common.

Anything can be overridden explicitly, either per field or via a `hardware` block:

```json
{
  "name": "ether1",
  "type": "ethernet",
  "speed": "2.5G",
  "poeOut": 30
}
```

```json
{
  "name": "sfp-sfpplus1",
  "type": "ethernet",
  "speed": "10G",
  "hardware": { "cage": "sfp+", "speedCaps": [1000, 10000] }
}
```

Device-level PoE budget:

```json
{ "poeBudget": 120 }
```

Resolution order — first match wins, and `Device.poeBudgetSource` records which one it was:

| Source | Field | Note |
|---|---|---|
| `spec` | `poeBudget` | an explicit number of watts |
| `research` | `poe: { "budgetW": 240 }` | a datasheet figure kept beside the spec |
| `unknown` | `poe: { "budgetUnknown": true }` | an explicit "not published" → 0 W. It deliberately does **not** fall through to the next row |
| `name` | a `NN–NNNN W` token in the model name | **a guess, and only kept if at least one port declares `poeOut`** |

`show power inline` prints the resolved budget **and its source**, so a 0 W budget that came from
an explicit "unknown" is distinguishable from one nobody ever declared:

```
SW1#show power inline
Power inline on SW1:
  Budget       : 20 W  (from spec)
  Used         : 13 W
  Available    : 7.1 W
  Port          Powered device        Requested  Status
  Gi0/1         CAM1                  12.95 W    on
  Gi0/2         CAM2                  12.95 W    denied (budget exhausted)
```

Two details in that block are worth reading twice, because both have caught people out:

- `Used` is the rounded total while the port column keeps the real figure, so a single 12.95 W port
  prints `Used : 13 W` above a line that says `12.95 W`. Both are the same decision.
- A `denied` port means the budget was already spent when `computePoe()` ran — which in a lab you
  built normally **cannot happen**, because cabling an over-budget combination is refused at the
  moment you draw the cable:

  ```
  Error: SW1 PoE budget exceeded: 2 powered ports draw 40 W of a 30 W budget (Gi0/1, Gi0/2).
  code: E_POE_BUDGET
  ```

  The check sums the ports' advertised `poeOut` — not what the powered devices ask for — so two
  20 W ports are refused on a 30 W budget even if the two cameras only want 12.95 W each. The
  `denied` status becomes reachable when the budget is *corrected after* the lab is wired (a
  datasheet figure revised by research), which is exactly when you want to see who lost power.

The same decision is readable from the powered device's side (`12.95 W from SW1 port 1/1/1 -
powered`, or `- denied (PSE budget exhausted)`), which is usually the faster answer to "why is
this camera dead". A port with no cable is not listed: nothing is being negotiated on it.

### A PSE with no budget answers as if it had no PoE at all

The refusal is keyed on a **resolved budget and a port that can source power**, not on the
`poe-pse` capability. So a device that declares itself a PSE and carries no budget anywhere in its
spec prints the "not a PoE device" answer, and the access point on the other end of the cable says
the PSE never replied. This is not a rare corner: **60 of the 102** PSE-capable devices in the
catalogue are in it (57 MikroTik, 3 Ubiquiti) — routers whose datasheets give a port count and a
`poe-pse` capability without a wattage.

```
SW1#show power inline
% SW1 neither sources nor draws PoE

AP1#show power inline
Power inline on AP1:
  eth0          12.9 W requested from SW1 port eth1 - no PSE answers
```

Both lines are correct and neither is helpful on its own: the switch is a PSE by capability and a
non-PSE by data, and the AP's line is the only one that names a wattage. When a lab shows this,
check the switch spec for `poeBudget` / `poe.budgetW` before assuming the model is broken — the same
section's budget table is the list of ways to supply it. `poe.budgetUnknown: true` says "a PSE, but
nobody published the figure" and yields 0 W explicitly rather than by omission; exactly one device in
the catalogue uses it, so it is a supported escape hatch rather than a pattern to copy from.

Fixing one of these is not a hand edit: `scripts/apply-research.js` takes a research file with a
mandatory `sourceUrl`, refuses a budget outside 30–4000 W, and records `null` as "researched, not
published" rather than as a blank ([DEVICE_REGISTRY.md](DEVICE_REGISTRY.md#correcting-an-existing-spec-with-researched-facts)).
That is the path from "the datasheet says 65 W" to a switch that powers an AP.

The name heuristic exists because most PoE switches put the budget in the model (`GS110TP-100W`),
but it is discarded when nothing on the device can source power: `ES-24-500W` is a 500 W PSU, not a
500 W PoE budget, and `AR651W-8P` parses to 651 W on a router with no PoE-out ports. A
research-sourced figure is kept even when it looks odd — a contradiction there is a data bug for a
human to see, not something to hide.

There is no `poe-pse` capability check in the **budget** path: the budget comes from the fields above,
and a port sources power because it declares `poeOut`. The capability still matters one step
earlier, for the default: a device with `poe-pse` whose port declares no `poeOut` gets the 802.3af
figure of **15.4 W** (measured), while the same port on a device without the capability gets `null`
and can never source power. So `poe-pse` decides *whether a port defaults to sourcing*, and
`poeOut` decides *how much it can actually give*.

---

## 2. Medium catalogue

89 media across nine families (copper, fiber, fibre-channel, DAC, coax, DSL,
powerline, console, wireless), carried by 26 cages — see [CONNECTORS.md](CONNECTORS.md) for
the cage-by-cage table. Selected highlights:

| Family | Medium | Speed | Connector | Reach |
|--------|--------|-------|-----------|-------|
| copper | `10base-t` / `100base-tx` / `1000base-t` | 10M / 100M / 1G | RJ45 | 100 m |
| copper | `2.5gbase-t` / `5gbase-t` / `10gbase-t` | 2.5G / 5G / 10G | RJ45 | 100 m |
| fiber | `1000base-sx` / `-lx` / `-ex` / `-zx` | 1G | LC | 550 m – 80 km |
| fiber | `10gbase-sr` / `-lr` / `-er` | 10G | LC | 300 m – 40 km |
| fiber | `25gbase-sr` / `-lr` | 25G | LC | 100 m – 10 km |
| fiber | `40gbase-sr4` / `-lr4` | 40G | MPO / LC | 150 m – 10 km |
| fiber | `100gbase-sr4` / `-lr4` | 100G | MPO / LC | 100 m – 10 km |
| DAC | `dac-10g`, `dac-10g-active`, `aoc-10g` | 10G | SFP | 7 / 15 / 20 m |
| DAC | `dac-40g`, `dac-100g` | 40G / 100G | QSFP | 5 / 3 m |
| console | `console-rs232`, `usb-console` | 115.2 kbps | RJ45 / USB | 15 m |
| wireless | `wireless-2.4`, `wireless-5`, `wireless-60` | radio | antenna | — |

The full list is served at **`GET /api/media`**.

---

## 3. Can these two ports be cabled?

Three tests, in order (`media.canMate`):

1. **Cages mate?** `CAGE_MATE` — RJ45 only mates RJ45; optical cages mate within the
   SFP family (`sfp` ↔ `sfp+` ↔ `sfp28`) and within the QSFP family.
2. **Shared medium?** The intersection of the two ports' `media[]` must be non-empty.
3. **Common speed?** The intersection of `speedCaps[]` must be non-empty; the link
   runs at the highest common rate.

If all three pass, the link is created with the **preferred** medium (fiber/DAC over
copper SFP; higher speed wins) unless the user picks another valid one.

Example: a 10G SFP+ port cabled to a 1G SFP port negotiates **`1000base-sx` at 1 Gbps** —
physically correct, because the SFP+ cage accepts a 1G optic.

---

## 4. Feasibility rules

`engine/validation.js` returns `{ ok, errors[], warnings[], media[], mediaId, speedMbps }`.
**Errors block the link**; warnings are surfaced but allowed.

### Errors (block)

| Code | Meaning |
|------|---------|
| `E_NO_PORT` | Port does not exist on the device |
| `E_SELF_LINK` | A device cannot be cabled to itself |
| `E_PORT_IN_USE` | Port already carries a link |
| `E_CONNECTOR_MISMATCH` | Cages cannot physically mate (e.g. RJ45 → SFP+) |
| `E_NO_COMMON_MEDIA` | Cages mate but no shared optic/DAC/copper module |
| `E_NO_COMMON_SPEED` | Shared medium but no common line rate |
| `E_WIRELESS_TO_WIRED` | Radio port cabled to a wired port |
| `E_CONSOLE_TO_DATA` | Console port cabled to a data port |
| `E_MEDIA_NOT_SUPPORTED` | Requested medium is not supported by both ports |
| `E_POE_BUDGET` | Powered ports exceed the PSE's PoE budget |
| `E_LAG_SPEED_MISMATCH` | LAG members run at different line rates |
| `E_POLISH_MISMATCH` | Same connector shape, different polish (SC/APC against SC/UPC). An 8° angled ferrule does not seat against a flat one; only a hybrid cord joins them |
| `E_PATCH_CORD_UNKNOWN` | The patch-cord part number the link declares is not in the optics catalogue |
| `E_PATCH_CORD_ENDS` | The declared patch cord is not terminated in the two connectors it is joining |
| `E_OPTICAL_BUDGET` | The span's loss (fibre, splices, connectors) exceeds the optic's budget, per direction |

### Warnings (allow)

| Code | Meaning |
|------|---------|
| `W_DISTANCE` | Cable longer than the medium's reach |
| `W_DUPLEX_MISMATCH` | Ends configured with different duplex |
| `W_SPEED_DOWNGRADE` | Link runs below both ports' maximum |
| `W_POE_DRAW` | PoE-powered device on a port that cannot supply power |
| `W_COPPER_LONGRUN` | Copper run longer than the 90 m horizontal limit |
| `W_HYBRID_CORD` | A UPC/APC hybrid lead joins two different polishes: legal, but it costs its insertion loss and cannot be swapped for a plain lead |
| `W_OPTICAL_HEADROOM` | The link passes, but with only a few dB of the PON class budget left |

Try it live: **`POST /api/topologies/:id/validate-link`** returns the verdict plus
every valid medium, which is what the UI's media picker is built from.

### A refusal that tells you what to buy

`validateConnection()` returns the reason **and**, where the catalogue has a fix, the part that
performs it. Mating an SC/APC PON port to an SC/UPC one (both derive from the port name — `pon1`
and `scupc1`) produces:

```
E_POLISH_MISMATCH  olt-x/pon1 <-> ont-x/scupc1: SC/APC and SC/UPC take the same SC ferrule but not
the same polish (APC angled 8 deg vs UPC flat). They are not intermateable - forcing it costs about
3 dB and can chip the endface. A hybrid patch cord (SMSCSX, sc-upc to sc-apc, 0.3 dB insertion loss)
joins these two polishes: declare it on the link (patchCord: "SMSCSX") and the run becomes buildable.
```

plus a machine-readable `suggestion`:

```json
{ "code": "S_PATCH_CORD_REQUIRED", "field": "patchCord", "value": "SMSCSX", "lossDb": 0.3,
  "message": "Add SMSCSX (sc-upc → sc-apc) and this link is buildable." }
```

Declaring that cord turns the refusal into a `W_HYBRID_CORD` warning and the link builds at the
cord's loss, which is the point: the answer to "why can't I cable this?" is a part number rather
than a shrug. See [HYBRID-PATCH.md](HYBRID-PATCH.md).

---

### The check runs when a cable is drawn, and again whenever state is served

`connect()` asks the rule once, at the moment of building, and then forgot the answer: nothing asked
again. A topology that arrived from a file — hand-edited, written against an older catalogue, or
produced by anything that was not this UI — could therefore hold a run that could never have been
built, and the link inspector answered for every cable with one hardcoded sentence:

> this cable passed the physical-layer check when it was created

which is a claim about a check that, for a loaded cable, nobody had run. A copper pair joined by
`1000base-lx` in the file was described that way, while the engine's own rule said:

```
E_MEDIA_NOT_SUPPORTED: 1000BASE-LX (1000base-lx) is not supported by both PC/eth0 and Switch (L2)/Fa0/1;
possible media: 10BASE-T, 100BASE-TX, 1000BASE-T.
```

`Topology.linkVerdict(link)` runs that same rule over the hardware as it is now, in the `revalidate`
form so a pair that is cabled to each other is not refused for being cabled, and returns the verdict.
Every state payload the server builds carries one per link. It is attached in `fullState()` and not in
`serialize()`, deliberately: a saved file records what was built, while a verdict is a derived answer
about the hardware as it is now, and one written into a file would be read back as fact long after the
hardware it describes had changed.

The inspector renders what it is handed rather than asserting anything of its own:

| verdict | what the panel says |
| --- | --- |
| `ok` | the cages mate and the media is supported at both ends, checked against the hardware as it is now |
| `ok` with a warning | the same, plus the warning — an over-length run still carries `W_DISTANCE` |
| refused | this cable cannot exist as drawn, with the engine's own message, and that drawing it now would be refused |
| absent | this cable has not been checked in this session — never a claim that it passed |

**What this does not do:** the data path does not consult the physical rule. Frames still cross a
cable that could never have been built, exactly as they still cross an over-length run — the verdict
is a report, not a door. Making it a door is a different change with a sharp edge: a lab restored from
a hand-edited file would fall silent the moment it loaded, so the refusal stays at the panel and says
what it would do.

## 5. VLANs (802.1Q) — enforced in the data path

`engine/vlan.js` implements per-port configuration:

```js
{ mode: 'access' | 'trunk', accessVlan: 10, nativeVlan: 1, allowedVlans: 'all' | [10, 20] }
```

- **Access**: egress untagged on `accessVlan`; ingress accepts untagged, drops tagged.
- **Trunk**: egress untagged for `nativeVlan`, tagged for every other allowed VLAN;
  ingress maps untagged → `nativeVlan`, tagged → VID when allowed, else drops.

The simulator calls `classifyIngress` on every received frame and `classifyEgress`
before every transmission, so:

- **MAC tables are per VLAN** (`Device.macTableFor(vid)`), because VLANs are separate
  broadcast domains. VLAN 1 keeps the flat legacy table.
- **Flooding is scoped to the VLAN**: a broadcast never crosses a VLAN boundary.
- **Trunks tag real frames** — inspect the event log and you will see 802.1Q-tagged
  frames on trunk links and untagged frames on access ports.
- Frames that a port's VLAN rules reject are dropped with a `vlan-drop` event.

VLANs 1–4094 are valid; 1002–1005 are reserved and rejected.

## 6. Link aggregation (LACP) — enforced in the data path

`engine/lag.js` — modes `lacp-active`, `lacp-passive`, `static`; hash policies
`l2`, `l3`, `l3l4`. `hashFrame` is a deterministic hash and `selectMember` maps a
frame onto a member (order-independent, skips disabled members).

In the simulator a LAG is **one logical port**:

- Spanning tree sees a single edge, so it does **not** block member links.
- Exactly one member carries each frame (a `lag` event records which).
- A frame that arrived on a member is **never sent back out the same group** —
  that would hairpin the frame and loop.

`validateLag` enforces: ≥ 2 members, identical speed, identical duplex, identical
VLAN configuration.

## 7. Spanning tree (802.1D) — enforced in the data path

`engine/stp.js` — `runStp({bridges})` performs a deterministic root election and
returns per-port roles (`root` / `designated` / `alternate`) and states
(`forwarding` / `blocking`), plus the list of blocked ports.

`Simulator.computeStp()` builds the bridge graph from the live topology (including
LAG collapsing) and is run before every ping. Blocked ports **drop both ingress and
egress traffic** (`stp-block` events), which is what turns a physical loop into a
working topology instead of a broadcast storm.

Check it from the console. Two switches wired twice — a loop someone built by accident — settle
into one forwarding path and one blocked port:

```
switch# show spanning-tree
Spanning tree enabled protocol ieee
Port   Role        State
Fa0/1  designated  forwarding
Fa0/2  designated  forwarding
Fa0/3  designated  forwarding

switch2# show spanning-tree
Spanning tree enabled protocol ieee
Port   Role        State
Fa0/1  root        forwarding
Fa0/2  alternate   blocking   (traffic dropped)
Fa0/3  designated  forwarding
```

The switch that is not the root blocks the second path — `alternate`/`blocking`, with
`(traffic dropped)` spelled out, because a reader should not have to know what `BLK` implies. The root
keeps both of its ports `designated`/`forwarding`; the loop is broken on one side, which is all STP
needs.

**STP state is computed on a run, so there is nothing to show before one.** In a freshly opened lab,
even with the loop cabled, the command answers `No bridged ports: this device is not part of any L2
loop.` — the same wiring, described honestly as not-yet-computed. Run anything (`ping`, a flow,
`converge`) and the table appears:

```
switch# show etherchannel summary
switch# show vlan brief
```

---

## 8. Adding a new medium

1. Add an entry to `MEDIA` in `engine/media.js` (family, connector, speed, reach).
2. Add it to the relevant `CAGE_MEDIA` entry so ports expose it.
3. Add a test to `test/validation.test.js` covering the new compatibility case.

No other code changes are required — the UI and API read the catalogue dynamically.

## Protocol families

A cage decides what physically mates; the medium decides what protocol the link carries. Ethernet
and Fibre Channel share the SFP socket family and share nothing else, so FC has its own cages and
its own rate ladder, and an FC-to-Ethernet cable is refused by name. See
[FIBRE-CHANNEL.md](FIBRE-CHANNEL.md).
