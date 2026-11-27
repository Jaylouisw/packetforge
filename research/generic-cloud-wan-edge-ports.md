# generic-cloud: the port census of a synthetic WAN edge

**Object:** `devices/generic/generic-cloud.json` (and the new `devices/generic/generic-isp.json`)
**Issue:** #30, "The internet is a single RJ45 port — no multihoming, no PON/coax/DSL upstream"
**Date:** 2026-11-27

## Why there is no vendor datasheet

`generic/*` is the catalogue's placeholder hardware: it describes a role, not a box. There is
no manufacturer page to quote for a port count, so the usual evidence rule cannot be applied
as "find the datasheet". What it can be applied to is the *medium*: every port on the new
cloud models a service family the engine already knows how to cable, and the connector and
rate on each port are exactly the ones `engine/media.js` resolves for that family. Nothing
here invents a medium, a cage or a part number; the choice is which of the modelled families
the internet object should expose.

## What the object is for

Before this change the only cloud in the catalogue had one port:

```json
{ "name": "eth0", "type": "ethernet", "speed": "10G" }
```

so every lab terminated on copper, a second WAN had nowhere to go, and an ONT's PON line could
not be cabled to "the internet" at all — the failure surfaced as `Cannot mate RJ45 to LC/UPC`.
The upstream probe recorded in `research/incoming/upstream-probe.json` reaches the same
conclusion: "the far end is the problem: generic-cloud has exactly one RJ45 port, so every lab
terminates on copper".

## Ports and the engine family each one uses

| port | declared | resolves to | engine source |
|---|---|---|---|
| `eth0` | ethernet, 10G, rj45 | `rj45`, 10/100/1G/2.5G/5G/10GBASE-T | `CAGES.rj45`, `CAGE_MEDIA.rj45` |
| `wan1`, `wan2` | ethernet, 1G, rj45 | `rj45`, 10/100/1000BASE-T | idem |
| `wan3` | ethernet, 2.5G, rj45 | `rj45`, adds 2.5GBASE-T | idem |
| `sfp1`, `sfp2` | ethernet, 10G, sfp+ | `sfp+` (10GBASE-SR/LR/ER, 1G SFP modules, DAC/AOC) | `CAGE_MEDIA['sfp+']` |
| `sfp28-1` | ethernet, 25G, sfp28 | `sfp28` (25G/10G/1G optics) | `CAGE_MEDIA.sfp28` |
| `qsfp28-1` | ethernet, 100G, qsfp28 | `qsfp28` (100GBASE-LR4/SR4, 40G, DAC) | `CAGE_MEDIA.qsfp28` |
| `pon1` | pon, 2.5G, sc-apc | `sc-apc` → `gpon-sc-apc` only | `CAGE_MEDIA['sc-apc']` |
| `pon2` | pon, 10G, sc-apc | `sc-apc` → `gpon-sc-apc`, `xgspon-sc-apc` | idem |
| `coax1` | coax, 10G, f | `coax` → DOCSIS 3.1/3.0, MoCA | `CAGE_MEDIA.coax` |
| `dsl1` | dsl, 300M, rj11 | `dsl` → ADSL2+, VDSL2 17a/35b | `CAGE_MEDIA.dsl` |

`eth0` is kept unchanged, at its original name and rate, because every shipped example and any
saved lab cables the cloud to `eth0`; a display change must not invalidate saved work
(issue #39). The new ports sit alongside it.

## What the change unblocks

- **Multihoming**: two routers cabled to `wan1` and `wan2` are two links to one upstream; the
  one-cable-per-port rule is untouched.
- **Dual-homed ISPs**: `generic/generic-isp` is a second cloud object, so ISP A and ISP B are
  two endpoints and each WAN link reads as its own provider.
- **PON / coax / DSL upstreams**: `pon1`/`pon2` mate with a GPON or XGS-PON ONT on `sc-apc`
  (`adtran/411`, `adtran/SDX 621`), `coax1` with a DOCSIS 3.1 modem (`arris/SB8200`), `dsl1`
  with a VDSL2 router (`avm/FRITZ!Box 7530`).

## Verification

`test/generic-cloud-wan-edge.test.js` (39 assertions) checks the census, the cage and media of
every port, the three line-service cable-ups, the dual-WAN case, and that an RJ45 WAN is still
refused at a PON port and at an SFP+ cage.
