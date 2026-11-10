# Roadmap

PacketForge is a working foundation, not a finished product. Priorities below.

A box is ticked only where the code answers for itself — every shipped line names the module
and the suite that keeps it honest, so a tick is checkable rather than aspirational, and an
unticked line that survives here is a real gap.

## Simulation engine

- [x] **TCP/UDP transport** — `engine/flow.js` is a real transport layer, not a probe: the
      three-way handshake as three frames, an MSS derived from the path MTU, segmented data with
      cumulative ACKs, a four-way close, RST, and UDP datagrams with ephemeral ports
      (`test/flow.test.js`; flows are opened over `POST /flows`, never by a stray packet). What is
      **not** there, in the module's own words: no congestion window, no retransmission timer, no
      SACK, no TIME_WAIT, no window scaling, and no ICMP port-unreachable for a stray UDP datagram.
      Nothing above transport either — no HTTP request, no TLS handshake, no SSH banner. **Sockets,
      HTTP and TLS remain absent.**
- [x] **DHCP** (DORA exchange) — `engine/dhcp.js` is in the data path, with pools, ranges,
      exclusions and reservations (`test/dhcp.test.js`, `test/dhcp-in-path.test.js`). Relay,
      snooping, Option 82 and DHCPv6 remain absent.
- [x] **DNS** for name resolution — NXDOMAIN / NODATA / SERVFAIL reported as distinct answers
      (`engine/dns.js`, `test/dns.test.js`, `test/dns-wire.test.js`).
- [x] **VLANs / 802.1Q** access, trunk and native VLANs with per-VLAN MAC tables
      (`engine/vlan.js`, `test/vlan.test.js`).
- [x] **Spanning Tree (802.1D)** with Listening/Learning timing in the convergence schedule
      (`engine/stp.js`, `test/stp.test.js`). RSTP fast convergence is not modelled.
- [x] **OSPF** adjacency + SPF, hello/SPF hold accounted for (`engine/ospf.js`,
      `test/ospf.test.js`, `test/ospf-wire.test.js`). **RIP** is still absent.
- [x] **NAT** — all three types (`NAT_TYPES` = `static`, `dynamic`, `pat`), each translated in the
      data path: a dynamic rule hands out a pool address and a PAT rule rewrites the port
      (`engine/nat.js`, `test/nat.test.js`). Rules are configured in the topology JSON — there is no
      `nat` CLI command — and the console can read the result two ways: `show ip nat translations`
      (the entries the data path wrote) and `show ip nat statistics` (`rules 1 (pat 1)`, `translations`,
      `dynamic entries`, `hits`).
- [x] **ACLs** — extended ACLs in the data path (`engine/acl.js`, `test/acl.test.js`,
      `test/acl-data.test.js`). The `firewall` capability itself is still inert; ACLs are what
      actually filters.
- [ ] **Wireless** 802.11 association state machine. The RF medium, band ceiling and
      association rate are modelled at the physical layer (`engine/media.js`), but the
      capability named `wireless` still does nothing.

## UI / UX

- [ ] Multi-select, copy/paste, alignment snapping, undo/redo.
- [ ] Curve / orthogonal link routing and link labels (IP subnets on hover).
- [ ] Per-interface tooltips with live ARP/MAC tables.
- [ ] Saved/exported PNG snapshot of the topology.
- [ ] Multi-tab topologies and a topology picker.
- [ ] Theme light/dark toggle and accessibility polish.

## Platform

- [ ] Per-vendor **CLI translators** (Juniper `set`, Huawei, MikroTik) over the
      unified config model.
- [ ] Authentication + per-user topologies. There is no login in `server/index.js`; where
      access control exists it is a reverse proxy in front of it
      ([PUBLIC-ACCESS.md](PUBLIC-ACCESS.md)).
- [x] Persistent storage for topologies — **file per board**, `data/topologies/<id>.json`, written
      atomically on every edit with no database and no dependency (`server/index.js`; `PF_DATA`
      relocates it for tests, and boards land in its `topologies/` subdirectory). What is still
      missing is a database, per-user storage, and a deletion that sticks: every board is global to
      the server, and `DELETE` forgets a board in memory without removing its file, so it returns
      on the next restart ([ARCHITECTURE.md](ARCHITECTURE.md)). The browser's import/export is a
      separate path.
- [ ] A **pcap export** of the simulated frames (replay in Wireshark).
- [ ] Embeddable build (single-file `dist/`) and a hosted demo.

## Project

- [x] Device models — **1,593 models across 246 vendors**, one JSON file each
      ([docs/DEVICE_REGISTRY.md](DEVICE_REGISTRY.md)). A community device-pack format is still
      an open question; today a "pack" is a pull request.
- [x] Unit tests for the simulator's edge cases — **well over a hundred suites**
      (`ls test/*.test.js | wc -l` gives today's number; the count moves with every PR, so run it
      rather than trusting a figure here) covering loops, ARP, TTL, convergence, link state,
      running-config round-trip, OSPF adjacencies and the catalogue invariants (`npm test`).
- [x] CI — Forgejo Actions on **pull requests to `main` and pushes to `main`**, plus manual dispatch
      (`.forgejo/workflows/ci.yml`, [docs/CI.md](CI.md)). Not "every branch": a push to a feature branch
      runs nothing until it is a pull request, and the dispatch entry exists because merging through the
      API does not arrive as a push event.

## Contributing

Pick any checkbox. The engine is pure JavaScript with no dependencies; `npm test` runs every
suite through one runner (`scripts/run-tests.js`), and `node test/engine.test.js` runs just the
engine suite. Keep the capability model — new protocol logic goes in `engine/simulator.js`,
new hardware goes in `devices/*.json`.
