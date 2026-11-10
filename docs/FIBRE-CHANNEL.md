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
  Only SFP+/SFP28/SFP-DD sockets take an FC module. The test suite pins the protocol answer
  against an SFP+ port and deliberately does not pin this one, because a connector refusal would
  prove nothing about the protocol — so the raw `cagesMate('sfp', 'fc-sfp')` matrix says `true`
  while the real pair refuses. `cagesMate` answers "could these sockets ever meet"; `canMate()` is
  what a link is actually judged by.

## Two FC ports link and negotiate down

A 64G port and a 32G port link at 28.05 Gbit/s: the faster port declares the whole ladder it can
run (`speedCaps`), and negotiation takes the highest rung both ends share, exactly as Ethernet does
with 1000/10000. Fibre Channel negotiates through 32/16/8, so this falls out of the same rule
rather than needing a special case.

## Devices

| Device | Ports |
|---|---|
| QLogic 5800V | 20 device ports at 2/4/8G + 4 ISL ports at 10GFC |
| Brocade G610, HPE SN3600B | 24 × 32G |
| Brocade G720 | 56 × 64G |
| Cisco MDS 9124V | 24 × multispeed 8/16/32/64G |
| Cisco MDS 9148S | 48 × multispeed 2/4/8/16G |
| Dell Connectrix DS-6630B | 96 × 32G + 8 × 128GFC |

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
   name. Brocade's "48 x 64G" is `[57800]`, or `[14025, 28050, 57800]` for a multispeed port.
2. Keep the marketing name in `speed` so the UI reads like the datasheet.
3. Say "Fibre Channel" (or the vendor's SAN branding) in the description. `test/spec-vs-description`
   uses that to know it should read "64G" as 57.8 Gbit/s, and `test/fibre-channel.test.js` uses the
   `fc-*` cages to check the port count against the description.
