# Roadmap

PacketForge is a working foundation, not a finished product. Priorities below.

## Simulation engine

Three states, and no fourth: **Modelled** (in the data path), **Partial** (some of it, and the row says
which part) and **Absent** (a gap worth picking up). Detail lives in [`SIMULATION.md`](SIMULATION.md) and
the section numbers below are its own; this page is the gap list, so a row flips in the PR that lands it
rather than being remembered later. The same rule holds for the checkboxes below: a ticked box is work
this tree already does, and the row says where, in the code rather than in a promise.

| state | subsystem | where |
|---|---|---|
| Modelled | TCP/UDP: a tiny TCP - three-way handshake, MSS from the path MTU, cumulative ACKs, four-way close. No congestion window, no retransmission timer | `engine/flow.js` |
| Modelled | DHCP (the DORA exchange, before the first packet) | `engine/dhcp.js`, §5.1 |
| Modelled | DNS: zones and records, and a resolver that listens on 53 | `engine/dns.js`, §5.7 |
| Modelled | VLANs / 802.1Q, with per-VLAN MAC tables | `engine/vlan.js`, §2.2 |
| Modelled | LAG: one logical port, a deterministic hash onto one member. `mode` is validated and stored, not negotiated | `engine/lag.js`, §2.3 |
| Modelled | Spanning tree: root election, roles, blocked ports. One tree, not one per VLAN | `engine/stp.js`, §2.4 |
| Modelled | OSPF: adjacency and SPF, encoded as real octets | `engine/ospf.js`, §5.5 |
| Modelled | BGP: the decision-order subset, not policy | `engine/bgp.js`, §5.6 |
| Modelled | VRRP: a virtual gateway that fails over | `engine/vrrp.js`, §5.4 |
| Modelled | IPv6 neighbour discovery and SLAAC. No duplicate address detection | `engine/ipv6.js`, `engine/ra.js`, §4.1-4.2 |
| Modelled | LLDP neighbours, each row expiring at the hold time its neighbour advertised | `engine/lldp.js`, §5.9 |
| Modelled | SCION | `engine/scion.js`, §5.8 |
| Modelled | NAT - static, dynamic and PAT, configurable from the console (`ip nat ...`) and readable (`show ip nat ...`) | `engine/nat.js`, §5.2 |
| Modelled | ACLs, with a match counter per rule | `engine/acl.js`, §5.3 |
| Partial | Wireless: five radio media, and a rate capped by the best shared band, on a link that is otherwise Ethernet. No 802.11 - no SSID, beacons, channels, RSSI or shared airtime | `engine/media.js`, §7 |
| Partial | The capability tokens `firewall`, `dhcp-client` and `wireless`: declared, read by nobody. Behaviour is gated on `nat`, `http-server` and `l3-forward` instead | `engine/device.js` |
| Absent | RIP: no implementation, and no reference to it under `engine/` | - |

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
- [x] Persistent storage (SQLite / file) for topologies - one JSON file per board under
      `PF_DATA/topologies/`, written synchronously before the answer is sent (`saveTopologyNow()`,
      [`server/index.js`](../server/index.js); [ARCHITECTURE.md](ARCHITECTURE.md#what-is-on-the-disk)).
      No database, and no dependency.
- [ ] A **pcap export** of the simulated frames (replay in Wireshark).
- [ ] Embeddable build (single-file `dist/`) and a hosted demo.

## Project

- [ ] More device models + a community device-pack format.
- [ ] Unit tests for the simulator's edge cases (loops, ARP retries, TTL).
- [x] CI - `.forgejo/workflows/ci.yml` runs the suite on Node 18, 20 and 22, with the live-server smoke
      test beside the image build; [CI.md](CI.md) is the page that says what each job proves.

## Contributing

Pick any checkbox. The engine is pure JavaScript with no dependencies; the test
suite is `node test/engine.test.js`. Keep the capability model — new protocol
logic goes in `engine/simulator.js`, new hardware goes in `devices/*.json`.
