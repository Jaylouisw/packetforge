# Roadmap

PacketForge is a working foundation, not a finished product. Priorities below.

## Simulation engine

- [ ] **TCP/UDP** sockets and a tiny transport layer (ports, SYN/ACK handshake).
- [ ] **DHCP** (DORA exchange) using the existing `dhcp-server` / `dhcp-client` capabilities.
- [ ] **DNS** for name resolution in the `ping hostname` path.
- [ ] **VLANs / 802.1Q** trunks and per-VLAN MAC tables.
- [ ] **Spanning Tree (STP)** to prevent L2 loops in redundant topologies.
- [ ] **OSPF / RIP** dynamic routing (adjacency + SPF).
- [x] **NAT** (source NAT using the `nat` capability) — static, dynamic and PAT, configurable from the console (`ip nat …`) and readable (`show ip nat …`).
- [ ] **ACLs / firewall rules** using the `firewall` capability.
- [ ] **Wireless** association + a virtual RF medium for the `wireless` capability.

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
- [ ] Authentication + per-user topologies.
- [ ] Persistent storage (SQLite / file) for topologies.
- [ ] A **pcap export** of the simulated frames (replay in Wireshark).
- [ ] Embeddable build (single-file `dist/`) and a hosted demo.

## Project

- [ ] More device models + a community device-pack format.
- [ ] Unit tests for the simulator's edge cases (loops, ARP retries, TTL).
- [ ] CI (the test suite needs no dependencies, so any runner works).

## Contributing

Pick any checkbox. The engine is pure JavaScript with no dependencies; the test
suite is `node test/engine.test.js`. Keep the capability model — new protocol
logic goes in `engine/simulator.js`, new hardware goes in `devices/*.json`.
