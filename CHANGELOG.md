# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **BGP route installation.** Sessions form only when BOTH sides are configured
  (each lists the other with a matching remote-as); advertisement runs to
  convergence with per-neighbour split horizon and AS-path loop detection; the
  best path per prefix is installed with eBGP 20 / iBGP 200 administrative
  distance. CLI: `router bgp <as>`, `bgp router-id`, `neighbor <ip> remote-as`,
  `no neighbor`.
- **DNS in the data path.** `ping` accepts a hostname, resolves it through a
  device that hosts the zone (honouring the client's resolver list) and follows
  CNAMEs before sending a single ICMP packet. CLI: `dns zone`, `dns add`,
  `ip name-server`. `bgp`, `dns`, `scion` and `ipv6` are now exported from the
  public engine API.
- Administrative-distance ordering in the routing table (connected 0, static 1,
  eBGP 20, OSPF 110, iBGP 200, default 254) — previously only prefix length
  decided, so a static route could not override a routing protocol.
- **OSPF route installation.** Area-aware adjacency graph built from the live
  topology, per-router SPF, next-hop resolved to a real adjacent IP, routes
  installed as code `O`; costs derive from link rate, passive interfaces are
  advertised but form no adjacency.
- `scripts/import-devices.js` — strict validation of researched device specs
  (vocabulary, declared ports, line rates, duplicate detection).
- `scripts/audit-devices.js` — catalogue accuracy audit: uncablable ports and
  devices that describe optics but expose no optical cage.
- 226 researched devices across 24 vendor families, taking the catalogue to
  317 models / 32 vendors; every ethernet port verified cablable.

- **VLANs, LAG and STP are now enforced in the data path**, not just modelled:
  - per-VLAN MAC tables and VLAN-scoped flooding; broadcast never crosses a VLAN
  - 802.1Q tagging on trunks, untagging on access ports (visible in the event log)
  - spanning tree blocks ports in both directions, turning a physical loop into a
    working topology instead of a broadcast storm
  - LAG groups act as one logical port: STP does not block members, one member
    carries each frame, and frames never hairpin back out the ingress group
- `switchport` CLI family: `mode access|trunk`, `access vlan`, `trunk native vlan`,
  `trunk allowed vlan`, plus `channel-group` and `vlan <id>` configuration.
- `show vlan brief`, `show spanning-tree`, `show etherchannel summary`, and a
  VLAN-aware `show mac address-table`.
- `test/l2.test.js` (28 assertions) proving the behaviour above end to end.
- Physical-layer model: 32 media types (copper / fiber / DAC / console / wireless),
  9 cage types, per-port media + speed capabilities, and PoE source/sink budgets.
- Live cabling feasibility engine — 11 blocking rules and 5 warnings. Impossible
  cables are refused with a stable error code, both at the API and in the UI.
- Link-type picker: when several media are valid, the user chooses the physical
  medium (and can deliberately force a lower speed, e.g. 100BASE-TX).
- 802.1Q VLAN membership: access/trunk, native VLAN, allowed-VLAN lists.
- LACP / static link aggregation with deterministic hashing and member validation.
- 802.1D spanning-tree election (root / designated / alternate roles, blocking ports).
- `GET /api/media` and `POST /api/topologies/:id/validate-link` endpoints.
- `docs/PHYSICAL_LAYER.md`.
- 202 new test assertions (validation 22, VLAN 59, LAG 57, STP 64).

### Fixed

- The multi-vendor campus example lab cabled a 25G SFP28-only switch to 1G RJ45
  ports — physically impossible. Rebuilt with valid copper and 1G-fiber uplinks;
  the new validator now catches this class of error in CI.

## [0.1.0] - 2026-11-07

### Added

- Event-driven L2/L3/ARP/ICMP simulation engine: MAC learning, unknown-unicast/broadcast
  flooding, longest-prefix routing, default gateways, TTL decrement, ICMP echo/reply.
- Vendor-agnostic Cisco-like CLI (`show`, `interface`, `ip address`, `ip route`, `ping`).
- Browser UI: pan/zoom SVG canvas, port cabling, per-device console, live packet
  animation, WebSocket multi-client sync, topology save/load.
- Hardware catalog: 91 models across 17 vendors — routers, switches, L3 switches,
  firewalls, ONTs/CPEs, access points, and 22 point-to-point radios (Ubiquiti
  airFiber / airMAX AC / GigaBeam / Wave + MikroTik Wireless Wire / LHG / DynaDish / SXT).
- Searchable, manufacturer/type-filtered device palette with collapsible vendor groups.
- Example labs (single-switch, routed campus, multi-vendor WAN) that self-verify.
- CI/CD: test matrix (Node 18/20/22), server smoke test, Docker image published to
  GitHub Container Registry on tags, CodeQL analysis, Dependabot for Actions.

[Unreleased]: https://github.com/Jaylouisw/packetforge/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Jaylouisw/packetforge/releases/tag/v0.1.0
