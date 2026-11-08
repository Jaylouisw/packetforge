# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

### Fixed

- **OSPF refused to form an adjacency between interfaces addressed in different
  subnets.** The adjacency was built from the cable alone, so two routers that
  disagreed about the subnet installed routes via a next hop that was on no
  connected subnet — traffic that never resolves is traffic that is black-holed.
  Both ends of a broadcast link must now share the subnet **and** the mask, which
  is the check that makes a misconfigured router a misconfigured router instead of
  a silently-working one. `test/protocol-regression.test.js` proves the refusal,
  and proves a matching subnet still forms the adjacency (#240).
- **DNS reported three different failures as NXDOMAIN.** A name with no `A` record
  (NODATA), a name the zone does not hold (NXDOMAIN), and a lab with no DNS server
  configured at all (SERVFAIL) all came back as "no such domain". They are now
  distinguished — NODATA is NOERROR with an empty answer — and a failed ping says
  `dns-nodata`, `dns-nxdomain` or `dns-servfail` instead of always
  `dns-nxdomain` (#241).
- **`docs/SIMULATION.md` listed five defects as open that were already fixed**
  (#41, #42, #43, #44, #54). The section now records what each one used to do and
  what it does instead, so the page does not cry wolf about its own engine.

### Added

- **The simulator has a notion of time.** Propagation (by medium and length), serialisation
  (by frame size and line rate) and a per-hop store-and-forward term are summed over both
  directions, so a 40 km fibre measures slower than a 1 m patch lead instead of identically.
  An unrecorded length stays unknown rather than inventing a distance.
- **A palette search that finds what exists.** Punctuation is folded on both sides, vendor +
  model match together, a punctuation-only query matches everything, and exact model hits
  rank first. No fuzzy typo tolerance — a confident wrong hit is worse than none.
- **A faceplate that fits its labels**: shrink within a floor, then shorten from the front,
  full name in the tooltip. `Fa0/2` and `Fa0/24` can no longer look identical.
- **TP-Link TL-SG105 and TL-SG105E** 5-port gigabit switches, from the datasheet.
- **A hybrid UPC/APC patch-cord catalogue** plus the rules for when a hybrid lead is correct,
  because a flat ferrule cannot meet an 8° angled one.
- **An upstream/transit design** (`docs/UPSTREAM-DESIGN.md`) replacing "the internet is one
  RJ45" with real link types and multihoming.
- **235 assertions over the control plane** (BGP, OSPF, VRRP, DHCP, NAT, DNS), five of which
  document defects as `DOCUMENTS BUG` and reference the issues that will flip them.

### Fixed

- An 8-wide faceplate group no longer clips port names mid-glyph.
- Palette search finds `MC220L` by `mc-220l`, `mc 220l` or `TL-MC220L`.

### Known defects (filed, not fixed)

- #41 BGP re-advertises an iBGP-learned route to another iBGP peer; next hop becomes the relayer.
- #42 OSPF installs a route for its own connected network, at transit cost.
- #43 OSPF does not advertise a passive interface's network at all.
- #44 OSPF keeps the more expensive advertisement for a shared network, chosen by id order.
- #54 NAT `flowKeyOf()` omits the inside source, so two hosts behind one PAT pool collide.


### Added

- **Cables are drawn as what they are made of.** Every medium was one grey 2 px line and
  wireless-versus-not was the only distinction the canvas had. Colour now carries the family
  (copper, fiber, dac, aoc, pon, coax, dsl, powerline, wireless), width the construction and a
  dash "not a plain cable run", with `data-medium` and `data-media-id` on every line (#34).
- **Cable length is a property of the lead.** The picker offers the lengths people actually buy
  per family, defaults to the short lead, and an existing cable's length can be set from the
  inspector or `PATCH /topologies/<id>/links/<id>` (#31).
- **A 3 m DAC is expressible at last**, because the ceiling ("up to 7 m") is no longer printed
  where the length belongs (#31).
- `docs/CONNECTORS.md` gained the canvas colour key and how to wire up a new medium.

### Fixed

- **SFP28 accepts 1G SFP and 10G SFP+ modules**, with the reaches widened to the whole module
  class (1000BASE-EX/ZX, 10GBASE-ER). 100M stays out deliberately (#17).
- **MikroTik ports read eth1 / SFP+1**, not the RouterOS CLI spelling, and the CLI keeps the
  RouterOS names as aliases so existing commands still resolve (#27).
- **The inspector no longer draws the cable label and the LLDP neighbour on top of each
  other** — they have their own row and can wrap (#25).
- **A cable passing behind a chassis is no longer erased**: devices are drawn first, cables
  after (#34).
- **Re-validating an existing cable** is no longer refused as `E_PORT_IN_USE`; the check
  compares the actual endpoint rather than an interface name that is only unique per device.
- **A server restart no longer discards the board**, and the browser notices when it is stale:
  connection badge, backoff retry, and a re-fetch that reports when fewer devices come back
  than the tab was showing (#24).

### Devices

- Acer Nitro 5 AN515-57 added from hardware request #23.


### Fixed

- **A server restart no longer discards the board.** Topologies are saved to
  `data/topologies/<id>.json` on every change and loaded at start-up, written
  synchronously: a 120 ms debounce looked harmless but on Windows a kill calls
  `TerminateProcess`, so no signal handler runs and the tail of your work vanished.
  Saves are atomic (write then rename), a board that cannot be parsed is reported
  and left in place rather than deleted, and device ids survive the round trip (#24).
- **The browser notices when it is stale.** The socket had no `onclose`, no `onerror`
  and no retry, so a tab kept drawing a board the server had never heard of. It now
  shows a connection badge in the status bar, retries with backoff, and re-fetches the
  server's copy on reconnect - reporting it when fewer devices come back than the tab
  was showing (#24).

## [Unreleased]

### Added

- **SLAAC via router advertisements.** IPv6 hosts can now get an address off the
  wire instead of having one typed in. `engine/ra.js` builds, encodes and parses
  ICMPv6 router solicitations (133) and advertisements (134) — M/O flags, router
  lifetime, reachable/retrans timers, prefix information options (prefix, length,
  L/A, valid and preferred lifetimes) and the source link-layer address option.
  A host with `ipv6 address autoconfig` multicasts an RS to `ff02::2`, the router
  answers to `ff02::1`, and the host splices its own EUI-64 identifier onto the
  advertised prefix, installs the router's link-local as its default gateway
  (remembering which port it was heard on, because `fe80::` is on-link
  everywhere) and can then be pinged from another host. An advertisement with the
  M flag set is refused with a stated reason rather than silently ignored, only a
  device with `l3-forward` ever advertises anything, a prefix is only advertised
  on the link the router is attached to, and `suppress-ra` stops the periodic
  advertisement without silencing the answer to a host that asks. New commands:
  `ipv6 nd ra enable|disable|managed|other-config|lifetime`, `ipv6 nd prefix
  <prefix>/<len> [valid <s>] [preferred <s>]`, `ipv6 nd suppress-ra`,
  `ipv6 address autoconfig` and `show ipv6 nd`. Tests:
  `test/ipv6-slaac.test.js`.
- **SCION in the forwarding path.** ASes are declared with `scion <isd>-<as>`
  (`1-ff00:0:0` is core because its AS number ends in `:0`, the SCION
  convention). Beaconing runs over the real peering graph derived from the
  topology — up-segments away from each core, down-segments back out, and
  core-to-core segments chained across adjacent core ASes. Paths compose from
  that segment set, are validated by shape (`up|down`, `up|core|down`, …) and
  selected with policy (`avoidAses`). `Simulator.pingScion()` then source-routes
  the packet along the path, one hop per AS, with **no IP addresses and no
  routing table involved** — which is the point of path-aware networking, and is
  asserted: not one interface has an IPv4 address and the packet still arrives.
  A non-core AS that no beacon reaches has no up-segment, so it gets no path and
  a stated reason.
- **Hardware-aware inspector.** The Device tab only showed port / IP / mask,
  hiding the entire physical layer it was built on. Each port is now a row with
  cage, negotiated rate, admin state and a cabled marker, expanding to an IP
  editor plus a hardware grid (cage, speed caps, supported media, PoE, VLAN
  mode/access/native/allowed, LAG, sub-interface encap). A port filter handles
  52-port switches, and PoE switches report their real power budget.
- **Link inspection.** Cables were previously unselectable. Clicking one opens
  an inspector with the media id, negotiated rate, duplex, length and both
  endpoints' cage and port state — and states that the cable passed the
  physical-layer check rather than implying it.
- **PoE budget bug.** 27 devices exposed PSE-capable ports but every one had a
  0 W budget, because nothing populated it — including an Aruba whose model name
  says `370W`. The budget is now derived from the model name when the spec does
  not carry one, and the inspector says "budget not modelled" rather than
  displaying a misleading 0 W.
- `test/ui-render.test.js` — loads the real `web/app.js` in a stub DOM and
  asserts on the HTML it produces, so the inspector is tested rather than
  assumed.
- **IPv6 in the forwarding path.** Interfaces take `ipv6 address <addr>/<len>`;
  every interface derives an EUI-64 link-local from its MAC; neighbour discovery
  runs over the wire (NS to the solicited-node multicast MAC `33:33:ff:…`, NA
  back, cached, pending packets flushed on resolution); ICMPv6 echo request/reply
  (types 128/129) with hop-limit decrement on every router. Multicast MACs are
  now received and flooded like broadcast, which is what makes NS arrive.
  CLI: `ipv6 address`, `ipv6 route`, `ipv6 gateway`. `Simulator.ping6()`.
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
