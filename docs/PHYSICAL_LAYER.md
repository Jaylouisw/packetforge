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
| `cage` | The physical connector/cage — 18 of them, from `rj45` and `sfp+` to `qsfpdd`, `sc-apc` and `antenna`. The full table is in [CONNECTORS.md](CONNECTORS.md) |
| `media[]` | Media (optics / copper / DAC) the port can carry |
| `speedCaps[]` | Line rates the port can negotiate (Mbps) |
| `poeOut` | Watts this port can *source* (PSE) |
| `poeIn` | Watts this port *draws* (PD) |

### Derivation

Device specs stay terse (`{ "name": "ether1", "type": "ethernet", "speed": "1G" }`).
The cage is inferred from the name and speed:

- `type: "wireless"` → `antenna`
- name contains `console`/`con0`/`tty` → `console`
- name contains `sfp`/`qsfp`/`xfp`/`cfp`, **or** speed is 25G/40G/100G → an optical cage
  (`sfp` < 10G ≤ `sfp+` < 25G ≤ `sfp28` < 40G ≤ `qsfp+` < 100G ≤ `qsfp28`)
- otherwise → `rj45`

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

If unset, a port is treated as a PSE when the model name contains `PoE` or the
device declares the `poe-pse` capability.

---

## 2. Medium catalogue

64 media across eight families (copper, fibre, DAC, coax, DSL, powerline,
console, wireless), carried by 19 cages — see [CONNECTORS.md](CONNECTORS.md) for
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

### Warnings (allow)

| Code | Meaning |
|------|---------|
| `W_DISTANCE` | Cable longer than the medium's reach |
| `W_DUPLEX_MISMATCH` | Ends configured with different duplex |
| `W_SPEED_DOWNGRADE` | Link runs below both ports' maximum |
| `W_POE_DRAW` | PoE-powered device on a port that cannot supply power |
| `W_COPPER_LONGRUN` | Copper run longer than the 90 m horizontal limit |

Try it live: **`POST /api/topologies/:id/validate-link`** returns the verdict plus
every valid medium, which is what the UI's media picker is built from.

---

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

Check it from the console:

```
switch# show spanning-tree
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
