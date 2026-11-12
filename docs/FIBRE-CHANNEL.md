# Fibre Channel

Fibre Channel is a different network in the same socket. An 8G FC optic seats in an SFP+ cage
exactly as a 10GBASE-SR one does, the connector check passes, and the link still cannot carry a
frame. PacketForge models it as its own protocol family so that the physical fit and the frame
protocol are two separate questions, and a lab can build a SAN — or be told precisely why a cable
between a SAN switch and an Ethernet switch will never work.

## The rate ladder is not the number on the box

This is the part that surprises people, and the part the engine gets right. Fibre Channel frames
its payload, and which framing it uses changes the direction of the difference:

| Name | Line rate | Framing | Why |
|---|---|---|---|
| 2GFC | 2,125 Mbps | 8b/10b | line rate is **above** the name |
| 4GFC | 4,250 Mbps | 8b/10b | line rate is **above** the name |
| 8GFC | 8,500 Mbps | 8b/10b | line rate is **above** the name |
| 10GFC | 10,519 Mbps | 8b/10b | line rate is **above** the name |
| 16GFC | 14,025 Mbps | 64b/66b | line rate is **below** the name |
| 32GFC | 28,050 Mbps | 64b/66b | line rate is **below** the name |
| 64GFC | 57,800 Mbps | 64b/66b | line rate is **below** the name |
| 128GFC | 112,200 Mbps | 64b/66b | four 32G lanes |

So a "32G" port is 28.05 Gbit/s and a "2G" port is 2.125 Gbit/s. A model that read the name as a
bit rate would put a 64G port at 64000 Mbps, let it negotiate with a 100G Ethernet port, and be
wrong in both directions at once. `engine/media.js` carries the real rate in `speedMbps` and the
class in `fcRate`.

## Cages

Fibre Channel has its own cages rather than borrowing the Ethernet ones:

| Cage | Carries | Note |
|---|---|---|
| `fc-sfp` | 2G / 4G / 8G / 10G / 16G | the SFP+ socket, FC flavour |
| `fc-sfp28` | 8G / 16G / 32G | 32G needs the SFP28 width |
| `fc-sfpdd` | 16G / 32G / 64G | SFP-DD, for 64G |
| `fc-qsfp28` | 32G / 128G | four 32G lanes |

Sharing the Ethernet cages was the obvious shortcut and it is wrong: the cage supplies the
**default** rate ladder when a port declares none, so an Ethernet SFP+ port with no `speedCaps`
would inherit 8G/16G and an Ethernet-to-Ethernet link could negotiate a Fibre Channel rate. The
separate cages keep the two ladders apart while still mating physically — `cagesMate('sfp+',
'fc-sfp')` is `true`, because the hardware does.

### Checking this table against the engine

Every number above came from `engine/media.js`, and the one-liners are worth having because two of
them look broken if you read the tables as data. `CAGE_SPEEDS` and `CAGE_MEDIA` are **functions, not
objects** — `CAGE_MEDIA['fc-sfp']` is a function that *returns* the media list, so `JSON.stringify` on
it prints `undefined` and a reader can conclude the cage is unlisted when it is perfectly well listed:

```js
const m = require('./engine/media');
m.CAGE_SPEEDS['fc-sfp'](120000)   // [2125, 4250, 8500, 10519, 14025]
m.CAGE_MEDIA['fc-sfp']()          // ['2gfc-sw','2gfc-lw','4gfc-sw', … ,'16gfc-sw','16gfc-lw']
```

The measured ladders and media, one row per cage:

| Cage | `CAGE_SPEEDS[cage](…)` | `CAGE_MEDIA[cage]()` |
|---|---|---|
| `fc-sfp` | `[2125, 4250, 8500, 10519, 14025]` — 2/4/8/10/16G | `2gfc-*`, `4gfc-*`, `8gfc-*`, `10gfc-*`, `16gfc-*` |
| `fc-sfp28` | `[8500, 14025, 28050]` — 8/16/32G | `32gfc-*`, `16gfc-*`, `8gfc-*` |
| `fc-sfpdd` | `[14025, 28050, 57800]` — 16/32/64G | `64gfc-*`, `32gfc-*`, `16gfc-*` |
| `fc-qsfp28` | `[28050, 112200]` — 32G/128G | `128gfc-*`, `32gfc-*` |

The media are named `2gfc-sw`, `8gfc-lw`, `128gfc-sw` — *not* `fc-2g` or `fc-8g`. Each exists in an
`-sw` (short wave) and `-lw` (long wave) flavour, and the speed is the line rate, not the marketing
number: `8gfc-sw` is `8500`, `16gfc-sw` is `14025`, `32gfc-sw` is `28050`, `64gfc-sw` is `57800`,
`128gfc-sw` is `112200`.

**The `maxMbps` argument is not honoured by the optical or FC ladders.** Measured, capping at 1000:

| Cage | `(1000)` returns | Honours the cap? |
|---|---|---|
| `rj45` | `[10, 100, 1000]` | yes — filters everything above |
| `wwan` | `[1000]` | yes — the modem's category *is* the rate |
| `combo` | `[10, 100, 1000]` | partly — drops 10000, and never offers 2500/5000 at all |
| `sfp` | `[1000, 2500]` | **no** — 2500 is above the cap |
| `fc-sfp` | `[2125, 4250, 8500, 10519, 14025]` | **no** — the whole ladder, cap ignored |

So a port's declared ceiling does not narrow its FC ladder the way it narrows a copper one. When you
need the negotiated result rather than the catalogue's ladder, ask `negotiateSpeed()` or read a link's
`speedMbps` after a run — `CAGE_SPEEDS` answers "what could this socket ever do", and for FC that is
the whole ladder by design.

## What is refused, and why

An FC port cabled to an Ethernet port refuses with `E_PROTOCOL_MISMATCH`:

```
SFP28 (FC) is a Fibre Channel port and SFP+ is Ethernet. The connector is the same LC/SFP family
and the optic will even seat, but Fibre Channel carries FC frames at its own rate ladder
(8/16/32/64G run at 8.5/14.025/28.05/57.8 Gbit/s) and an Ethernet port has no FC login, so no
frame ever crosses. Put an FC HBA or switch on the other end.
```

Two details worth keeping:

- The check runs **before** the BiDi explanation. Both are true of some pairs, and the protocol is
  the more fundamental reason: a user who has plugged an FC optic into a switch port needs to hear
  about the protocol, not about the shape of the strand.
- An FC optic in a **1G SFP** cage is refused on the *connector* instead, because it genuinely
  does not seat: `E_CONNECTOR_MISMATCH`, `Cannot mate SFP+ (FC) to SFP (incompatible connectors).`
  That string is not fixed — it names the **FC optic's own** connector, so grepping a page for it and
  finding a different one is not a bug. Measured against one 1G SFP cage (`ISR 4331` `Gi0/0/0-sfp`):

  | FC device | its cage | the message |
  |---|---|---|
  | `MDS 9148S` | `fc-sfp` | `Cannot mate SFP+ (FC) to SFP (incompatible connectors).` |
  | `G610`, `DS-6630B` | `fc-sfp28` | `Cannot mate SFP28 (FC) to SFP (incompatible connectors).` |
  | `G720` | `fc-sfpdd` | `Cannot mate SFP-DD (FC) to SFP (incompatible connectors).` |
  | `DS-6630B` `icl0` | `fc-qsfp28` | `Cannot mate QSFP28 (FC) to SFP (incompatible connectors).` |

  Only SFP+/SFP28/SFP-DD sockets take an FC module. The test suite pins the protocol answer
  against an SFP+ port and deliberately does not pin this one, because a connector refusal would
  prove nothing about the protocol — so the raw `cagesMate('sfp', 'fc-sfp')` matrix says `true`
  while the real pair refuses. `cagesMate` answers "could these sockets ever meet"; `canMate()` is
  what a link is actually judged by.

## Two FC ports link and negotiate down

A 64G port and a 32G port link at 28.05 Gbit/s: the faster port declares the whole ladder it can
run (`speedCaps`), and negotiation takes the highest rung both ends share, exactly as Ethernet does
with 1000/10000. Fibre Channel negotiates through 32/16/8, so this falls out of the same rule
rather than needing a special case. Measured over three pairs:

| pair | media offered | chosen | `speedMbps` |
|---|---|---|---|
| `MDS 9148S` 16G ↔ `MDS 9148S` 16G | `2g`, `4g`, `8g`, `10g`, `16g` | `16gfc-sw` | **14025** |
| `MDS 9148S` 16G ↔ `G720` 64G | `16g` only | `16gfc-sw` | **14025** |
| `G610` 32G ↔ `G720` 64G | `32g`, `16g` | `32gfc-sw` | **28050** |

Two things to read off that table. The offer list narrows to what both ports can actually reach, which is
why a 16G↔64G pair offers only `16g`: the 64G port's `speedCaps` begin at 14025, so the slower rungs the
MDS declares are not shared with it. And `speedMbps` is the **negotiated line rate, not the medium's name**:
16G FC runs at 14.025 Gbit/s and 32G at 28.05, so a link whose `mediaId` says `16gfc-sw` still reports
`14025`. Reading the medium id as the rate is off by ~12% on every FC rung.

## Devices

Seven devices carry **304** Fibre Channel ports between them, in all four `fc-*` cages: `fc-sfp` 72,
`fc-sfp28` 144, `fc-sfpdd` 80, `fc-qsfp28` 8 (measured with `derivePortHardware()` over `devices/`, which
also gives the per-port `speedCaps` the table below summarises). No single box spans the ladder, so which
box you pick decides which rates a lab can test: **2G** exists only on the two 8G-class boxes (MDS 9148S and
SANbox 5800V), **10G FC** only on the 5800V's four ISLs, **64G** on G720 and MDS 9124V, and **128G** only on
the DS-6630B's eight ICL ports. A "does FC negotiate down the whole ladder" test needs more than one device
in the lab.

| Device | Ports | measured `speedCaps` (Mbps) |
|---|---|---|
| QLogic 5800V | 20 device ports at 2/4/8G + 4 ISL ports at 10GFC | 20 × `2125/4250/8500`, 4 × `8500/10519` |
| Brocade G610, HPE SN3600B | 24 × 32G | 24 × `8500/14025/28050` (per model) |
| Brocade G720 | 56 × 64G | 56 × `14025/28050/57800` |
| Cisco MDS 9124V | 24 × multispeed 8/16/32/64G | 24 × `8500/14025/28050/57800` |
| Cisco MDS 9148S | 48 × multispeed 2/4/8/16G | 48 × `2125/4250/8500/14025` |
| Dell Connectrix DS-6630B | 96 × 32G + 8 × 128GFC | 96 × `8500/14025/28050`, 8 × `28050/112200` |

The third column is the literal array each port carries, which is what makes drift visible: a device that
gains a rung, or a marketing rate that disagrees with its ladder, shows up here as a changed string rather
than as prose that still reads plausibly. Seven devices hold seven distinct arrays (the two 24 ×
`8500/14025/28050` boxes share one), and the cage per device is fixed — G610/SN3600B/DS-6630B in
`fc-sfp28` (DS-6630B's eight 128G ports in `fc-qsfp28`), G720 and MDS 9124V in `fc-sfpdd`, MDS 9148S and
the 5800V in `fc-sfp`.

The 5800V's 20G ISL figure is two 10GFC ports bonded, which this model expresses as two links
rather than one 20G port.

## What is not modelled

- **Fabric services.** No FLOGI/PLOGI, no name server, no zoning, no FC-IP. A lab can cable a SAN
  but not configure one; the simulator's data path is Ethernet/IP.
- **Optic part numbers.** `catalogue/optics/transceivers.json` has not been extended with FC
  transceivers, so an FC link is described by its rate class (SW/LW) rather than a vendor part.
- **Credit-based flow control and BB credits.** An FC link's real carrying capacity depends on
  buffer-to-buffer credits, which the simulator does not count.

## Adding an FC device

1. Put the ports in an `fc-*` cage and declare `speedCaps` from the ladder — never the marketing
   name. Those caps are the rate classes the port actually negotiates, so copy a set that already
   exists rather than inventing one. Every set in the catalogue today, with the ports that carry it:

   | `speedCaps` | Ports | Where |
   |---|---|---|
   | `[8500, 14025, 28050]` | 144 | G610 (24), DS-6630B (96), SN3600B (24) — the 32G ladder |
   | `[14025, 28050, 57800]` | 56 | G720 — the 64G ladder, no 8G step |
   | `[2125, 4250, 8500, 14025]` | 48 | MDS 9148S — 16G down to 2G |
   | `[8500, 14025, 28050, 57800]` | 24 | MDS 9124V — 8G up to 64G |
   | `[2125, 4250, 8500]` | 20 | SANbox 5800V — 8G down to 2G |
   | `[28050, 112200]` | 8 | DS-6630B — 128G on a box described as 32G |
   | `[8500, 10519]` | 4 | SANbox 5800V — 8G and 10G FC on an 8G box |

   Note what is **not** in that table: no port declares `[57800]` on its own. A 64G-only port would,
   but every 57800 today sits inside a multispeed set, so an example written as "64G is `[57800]`" is
   describing a port that does not exist here. The last two rows are the ones to look at twice before
   copying them: 128G on a 32G switch and 10G FC on an 8G switch are both plausible as ISL or uplink
   ports and both suspicious as transcription, and `10519` is 10G FC's *line* rate (`10.51875` Gbit/s)
   rather than a round number somebody would type by hand.
2. Keep the marketing name in `speed` so the UI reads like the datasheet.
3. Say "Fibre Channel" (or the vendor's SAN branding) in the description. `test/spec-vs-description`
   uses that to know it should read "64G" as 57.8 Gbit/s, and `test/fibre-channel.test.js` uses the
   `fc-*` cages to check the port count against the description.
