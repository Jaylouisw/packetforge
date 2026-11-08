# What the simulator actually does

An honest capability matrix for the PacketForge **engine**: what is modelled,
what is a documented approximation, and what is simply not there.

This page is written from `engine/*.js`. It is deliberately not written from
[README.md](../README.md). Where the two disagree, believe this page — [§11](#11-where-the-other-docs-overstate-the-code)
lists the disagreements so they can be fixed in the marketing rather than
discovered in a lab.

Read it before you design a lab around a feature, and before you claim a feature
in a commit message.

---

## How to read this page

| Tag | Meaning |
|-----|---------|
| **Modelled** | The behaviour is produced by a real code path. If you configure it, packets behave accordingly. |
| **Approximate** | Something is modelled, but a constant, a rule or a tie-break is a simplification. The code says which. |
| **Absent** | There is no code path. Configuring it usually succeeds and then does nothing. |
| **Unknown** | The code does not answer the question. Said out loud instead of guessed. |

Every claim carries a `file:line` citation. Citations also name the symbol,
because line numbers drift as the engine grows — if a number is stale, the
symbol will still find it.

Two conventions used throughout:

- **A "run"** is one call to `Simulator.ping()`, `openFlow()` or `pingScion()`.
  State that lives on a `Device` survives between runs; state that lives on the
  `Simulator` does not. `Simulator.reset()` (`engine/simulator.js:106`) rewinds
  a run, not the network.
- **A "step"** is one frame handed to one port. It is a hop count, not a
  duration — see [§8](#8-time-what-rtt-means-and-what-it-does-not).

---

## 1. The engine loop

Everything else on this page depends on how a run is sequenced, so it comes
first.

**Modelled**

- A frame is a plain object (`{dstMac, srcMac, etherType, ip, icmp, arp, l4, flow}`),
  built by `ethFrame()` at `engine/simulator.js:31`.
- Transmissions go on a FIFO array and `_run()` drains it synchronously, one
  `step++` per delivery (`engine/simulator.js:1718`). There is no timer, no
  coroutine and no scheduling: a run is a single-threaded loop that ends when the
  queue is empty.
- Guard rails are loop detectors, not physics: `maxSteps = 8000`
  (`engine/simulator.js:110`) and a 100 000-iteration runaway guard
  (`engine/simulator.js:1723`). Exceeding either emits a `limit` event.
- Before the first packet, every run recomputes the world **once**, in this
  order: spanning tree, PoE, LLDP, router advertisements, OSPF, BGP
  (`engine/simulator.js:236-249`). The protocols are therefore converged before
  packet one, and do not reconverge during the run.
- Layer decisions are gated by `hasCap()`, and the only capabilities the
  forwarding path actually consults are `l2-forward`, `l3-forward` and `host`
  (`engine/simulator.js:1856`, `engine/simulator.js:1923`).

**Approximate**

- Device state (MAC tables, ARP cache, ND cache, PoE power state) lives on the
  `Device`, inside the `Topology`, so it persists across runs — which is what a
  real box does. But nothing ages it: no MAC ageing timer, no ARP timeout, no ND
  reachable-time, no DHCP lease expiry. A table learned in run 1 is still there
  in run 1 000 with the same entries (`engine/device.js:331`).
- The capability list at `engine/device.js:85-98` advertises more than the
  engine consumes: `vlan`, `lacp`, `stp`, `poe-pse`, `poe-pd`, `firewall`,
  `wireless` is never read by the forwarding
  path. VLANs and STP apply to any `l2-forward` device whether or not it claims
  them; see [§2](#2-ethernet-and-l2) and [§5.1](#51-dhcp--in-the-data-path-computed-rather-than-timed).

**Absent**

- Concurrency. Two flows, two pings and an OSPF reconvergence never interleave;
  each run owns the simulator until it finishes.
- Any notion of a device CPU. Control-plane work is instantaneous and free, so
  an OSPF flood cannot cause a CPU spike and a BGP flap cannot drop packets.

---

## 2. Ethernet and L2

### 2.1 MAC learning and flooding

| Verdict | Behaviour | Where |
|---|---|---|
| **Modelled** | Source MAC is learned on ingress, into a table **scoped to the frame's VLAN**. | `engine/simulator.js:1734`, `engine/device.js:331` |
| **Modelled** | Known unicast → one egress port. Unknown unicast, broadcast and multicast → flood within the VLAN only. | `engine/simulator.js:1895-2020` |
| **Modelled** | A flood never returns out of the ingress port, and never out of the LAG it arrived on. | `engine/simulator.js:1955-1970` |
| **Modelled** | A learned entry pointing back at the ingress port is dropped with `loop`, rather than forwarded. | `engine/simulator.js:1957` |
| **Approximate** | Learning happens before the ACL and the STP egress checks, so a frame that is then dropped still taught the switch a MAC. Real hardware does the same; worth knowing when reading a table after a denied flow. | `engine/simulator.js:1734` vs `1792` |
| **Approximate** | Multicast is treated as broadcast: no IGMP snooping, no per-group filtering. This is deliberate — IPv6 neighbour discovery would never arrive otherwise. | `engine/simulator.js:1842` |
| **Absent** | MAC ageing, MAC move detection, per-port MAC limits, port security, storm control, error counters, CRC/FCS errors, collisions. | — |

### 2.2 VLANs (802.1Q)

| Verdict | Behaviour | Where |
|---|---|---|
| **Modelled** | Per-port config: `mode: access\|trunk`, `accessVlan`, `nativeVlan`, `allowedVlans`. | `engine/vlan.js:6-14` |
| **Modelled** | **Access**: egress untagged on `accessVlan`; ingress accepts untagged, drops tagged. | `engine/vlan.js:303` |
| **Modelled** | **Trunk**: egress untagged for `nativeVlan`, tagged for every other allowed VLAN; ingress maps untagged → native VLAN, tagged → VID if allowed, else drops. | `engine/vlan.js:285`, `engine/vlan.js:303` |
| **Modelled** | Frames are really tagged on the wire: `_emitFrame` sets `wireTagged`/`wireVid` from `classifyEgress`, so the event log distinguishes a tagged trunk frame from an untagged access frame. | `engine/simulator.js:1666-1680` |
| **Modelled** | MAC tables are per VLAN; VLAN 1 keeps the flat legacy table. Flooding is scoped to the VLAN. | `engine/device.js:331-337`, `engine/simulator.js:1895` |
| **Modelled** | VLANs 1–4094; 1002–1005 are rejected as reserved. | `engine/vlan.js:24-26` |
| **Approximate** | Router-on-a-stick via subinterfaces works (`Gi0/0.10` creates a tagged logical interface), and `portPvid()` falls back to the parent's VLAN when no tag is present. | `engine/simulator.js:72-78`, `engine/cli.js:187-199` |
| **Absent** | Voice VLAN in the data path: `voiceVlan` is accepted and validated in the config shape (`engine/vlan.js:13`, `engine/vlan.js:423`) but nothing in the forwarder reads it. QinQ / 802.1ad, private VLANs, VTP, VLAN pruning negotiation. | — |

### 2.3 Link aggregation (LAG)

| Verdict | Behaviour | Where |
|---|---|---|
| **Modelled** | A LAG is one logical port: frames are hashed onto exactly one member, the event log records which. | `engine/simulator.js:2024-2045`, `engine/lag.js:157` |
| **Modelled** | Hash policies `l2`, `l3`, `l3l4`, deterministic FNV-1a — the same frame always lands on the same member. | `engine/lag.js:128` |
| **Modelled** | Spanning tree sees one edge per bundle, so it does not block members against each other. | `engine/simulator.js:315-334` |
| **Modelled** | A frame that arrived on a member never leaves by the same group (no hairpin). | `engine/simulator.js:1970` |
| **Approximate** | `mode` (`lacp-active`, `lacp-passive`, `static`) is validated and stored, and then has **no effect on behaviour** — only the hash policy is consulted at forwarding time. | `engine/lag.js:217-225` vs `engine/simulator.js:2039` |
| **Approximate** | `minLinks` is normalised and validated but never read at runtime: a bundle keeps forwarding at one member, it never shuts down. | `engine/lag.js:55-59` |
| **Absent** | LACPDUs, negotiation, per-member failure detection beyond `iface.enabled`, load-based member selection, L3/L4 hash entropy from anything but the fields present. | — |

### 2.4 Spanning tree (802.1D)

| Verdict | Behaviour | Where |
|---|---|---|
| **Modelled** | Root election (lowest bridge ID), root path cost, root/designated/alternate roles, forwarding/blocking states, blocked-port list. | `engine/stp.js:119`, `engine/simulator.js:306` |
| **Modelled** | Blocked ports drop **both** ingress and egress traffic (`stp-block` events). This is what turns a physical loop into a working topology instead of a storm. | `engine/simulator.js:1758`, `engine/simulator.js:1959-1963` |
| **Modelled** | Path cost derived from the negotiated link rate, and divided by member count for an aggregate. | `engine/simulator.js:81-89`, `engine/simulator.js:326-327` |
| **Approximate** | Only the **converged result** is computed: no BPDUs, no hello/max-age/forward-delay timers, no listening or learning states, no topology-change notifications. The tree is correct, the convergence is instantaneous and free. | `engine/stp.js:1-17` |
| **Approximate** | It runs for **every** `l2-forward` device regardless of whether the spec claims `stp`, and there is no way to disable it — `show spanning-tree` exists, `no spanning-tree` does not. | `engine/simulator.js:309` |
| **Absent** | RSTP/MSTP/PVST/PVRST, PortFast, BPDU guard/filter, root guard, loop guard, per-VLAN trees. | — |

### 2.5 Passive devices: taps and splitters

| Verdict | Behaviour | Where |
|---|---|---|
| **Modelled** | A **passive tap** (`category: tap` with no capabilities, or `passive: true`) passes frames between its network ports unchanged and duplicates them to monitor ports. A frame arriving on a monitor port is refused (`tap-inject-refused`) — a tap is not a hub. | `engine/simulator.js:1798-1821`, `engine/device.js:323` |
| **Modelled** | A **passive splitter** (`category: splitter`) replicates to every other leg, unchanged, in both directions. No learning, no lookup, no VLAN rewrite. | `engine/simulator.js:1824-1834`, `engine/device.js:317` |
| **Modelled** | Neither can learn: the MAC-learning step explicitly skips them, so a tap cannot be credited with a table it could not hold. | `engine/simulator.js:1734` |
| **Approximate** | SFP-based taps (the active/aggregating kind) are treated as passive if the spec says so; there is no aggregation port, no timestamping, no oversubscription. | — |

### 2.6 Bridge groups

| Verdict | Behaviour | Where |
|---|---|---|
| **Modelled** | Ports in the same `bridgeGroup` (e.g. `lan`) are treated as one L3 surface: an address configured on any member answers ARP/ICMP arriving on any other member, and the reply leaves by the port that asked. | `engine/device.js:261-298`, `engine/simulator.js:2036`, `engine/simulator.js:2064` |
| **Approximate** | A router's LAN sockets also enforce role separation: a LAN address is not reachable from the WAN port. | `engine/device.js:274` |
| **Absent** | **Bridging between bridge-group members.** A frame not addressed to the device is dropped (`not addressed to this device`) — it is not switched to another port in the group. Two PCs on a router's `lan2` and `lan3` cannot talk to each other unless the router routes between subnets, or the device also has `l2-forward`. This surprises people; it is the single most common misreading of the feature. | `engine/simulator.js:1916-1920` |

---

## 3. IPv4

### 3.1 ARP

| Verdict | Behaviour | Where |
|---|---|---|
| **Modelled** | ARP request floods the VLAN; only the owner replies, out of the port that asked (or the subinterface that owns the address). | `engine/simulator.js:2003-2029` |
| **Modelled** | Replies populate the cache, and pending packets for that next hop are flushed in order. | `engine/simulator.js:2027` |
| **Modelled** | A request for an address nobody owns is simply unanswered, so the ping times out — the correct symptom, arrived at honestly. | — |
| **Absent** | ARP cache ageing, gratuitous ARP, proxy ARP, ARP inspection (DAI), static ARP entries, duplicate-address detection. | — |

### 3.2 ICMP

| Verdict | Behaviour | Where |
|---|---|---|
| **Modelled** | Echo request → echo reply, with sequence numbers, per-reply success and a computed round trip. | `engine/simulator.js:2031-2090` |
| **Modelled** | TTL starts at 64, decrements per router, and expiring TTL drops the packet with an event. | `engine/simulator.js:1979-1983` |
| **Absent** | **Every other ICMP type.** There is no destination-unreachable, no time-exceeded, no redirect, no parameter-problem. A black-holed packet and a TTL-expired packet both look like silence to `ping`; only the event log tells you which. | `engine/net.js:81-82` |
| **Absent** | `traceroute`. Nothing in the engine is designed for it, and without time-exceeded there is nothing to build it on. | — |

### 3.3 Routing and administrative distance

**Modelled** — `Device.routeTo()` (`engine/device.js:366-443`), in this order:

1. Connected subnets (AD 0).
2. Static routes from `ip route` (AD 1).
3. BGP-learned routes (eBGP 20, iBGP 200) — `engine/device.js:401-418`.
4. OSPF-learned routes (AD 110) — `engine/device.js:420-435`.
5. `ip default-gateway` (AD 254) — only when nothing else matched.

Longest prefix always wins; equal-length prefixes are broken by lower
administrative distance. That ordering is the documented Cisco one, and it is
enforced by a single comparator (`better(prefix, ad)` at `engine/device.js:369`)
rather than by the order the loops run in — so a `/24` static really does lose to
a `/25` connected route regardless of list order.

**Approximate**

- The default gateway is consulted only when **no** route matched, instead of
  competing as a `0.0.0.0/0` route at AD 254. The practical difference shows up
  only if you configure both a default gateway and a `0.0.0.0/0` static route
  with a higher AD than 254.
- No route recursion: a next hop must resolve on a directly connected subnet
  (`Device.egressFor`, `engine/device.js:524`), so a static route pointing at a
  next hop that is itself only reachable via another route will drop.
- No ECMP. One best route, one egress port.

**Absent**

- Route redistribution in any direction (connected ↔ OSPF ↔ BGP). Each protocol
  originates only its own source of truth: OSPF from configured OSPF
  interfaces, BGP from connected prefixes (`engine/simulator.js:577-588`).
- Route-maps, distribute-lists, offset-lists, policy routing, VRF, tunnels.
- Fragmentation and reassembly, PMTUD, IP options, jumbo frames.

---

## 4. IPv6

### 4.1 Neighbour discovery

| Verdict | Behaviour | Where |
|---|---|---|
| **Modelled** | Every interface has an EUI-64 link-local address derived from its MAC. | `engine/device.js:468`, `engine/ipv6.js:384-405` |
| **Modelled** | NS is sent to the solicited-node multicast MAC (`33:33:ff:xx:xx:xx`), not to broadcast. | `engine/simulator.js:677-700` |
| **Modelled** | NA is returned only by the owner of the target address; receiving an NA fills the cache and flushes the pending queue. | `engine/simulator.js:747-790` |
| **Modelled** | A packet to an unresolved next hop is queued while the NS goes out, exactly like the ARP path. | `engine/simulator.js:698-742` |
| **Absent** | Duplicate address detection (DAD) — a host will happily take an address that another host already holds. Unsolicited NA, router/neighbour unreachability detection, ND table ageing. | — |

### 4.2 SLAAC

| Verdict | Behaviour | Where |
|---|---|---|
| **Modelled** | Host sends RS to `ff02::2`; router answers with an RA to `ff02::1`; host splices an EUI-64 identifier onto the advertised prefix. | `engine/simulator.js:798-960`, `engine/ra.js:353-372` |
| **Modelled** | The messages are encoded and decoded as real ICMPv6 octets (RFC 4861 §4.2/§4.6), so a layout mistake cannot hide behind a shared object. | `engine/ra.js:160-260` |
| **Modelled** | The M (managed) flag makes the host **refuse** to autoconfigure and say why (addresses come from DHCPv6). A manually configured address is never overwritten. | `engine/simulator.js:1018-1044` |
| **Modelled** | A router advertises a prefix only on a link where it holds an address inside that prefix. | `engine/simulator.js:957-964` |
| **Approximate** | One global address per interface: the first autonomous prefix wins, the rest are ignored. Real hosts keep one per prefix. | `engine/simulator.js:1049-1052` |
| **Approximate** | Valid/preferred lifetimes are carried and displayed, never aged. An address never becomes deprecated. | `engine/simulator.js:1054-1060` |
| **Absent** | DHCPv6, DHCPv6-PD, privacy/temporary addresses, stable-privacy IIDs, RDNSS/DNSSL, RA guard. | — |

### 4.3 Hop limit and forwarding

| Verdict | Behaviour | Where |
|---|---|---|
| **Modelled** | Hop limit starts at 64, decrements per router, expiry drops the packet. | `engine/simulator.js:761`, `engine/simulator.js:1045-1049` |
| **Modelled** | Static IPv6 routes and an IPv6 default gateway, longest prefix wins. | `engine/device.js:484-510`, `engine/cli.js:214-227` |
| **Approximate** | IPv6 route selection has **no administrative distance**: connected is installed first and only a strictly longer static prefix displaces it, so there is no OSPFv3/BGP-v6 to rank. | `engine/device.js:484-500` |
| **Absent** | ICMPv6 errors (time exceeded, destination unreachable, packet too big), fragmentation, OSPFv3, MP-BGP for IPv6, IPv6 ACLs (see [§5.3](#53-acls)), IPv6 NAT. | — |

---

## 5. Control plane

### 5.1 DHCP — **in the data path, computed rather than timed**

| Verdict | Behaviour | Where |
|---|---|---|
| **Modelled** | A complete DHCPv4 server model: pool normalisation, validation, DISCOVER→OFFER, REQUEST→ACK/NAK, renewals, reservations, exclusions, lease expiry — pure and deterministic. | `engine/dhcp.js:599`, `engine/dhcp.js:633` |
| **Configured** | `ip dhcp pool <name>`, `network <net> <mask>`, `range <start> <end>`, `default-router`, `dns-server`, `excluded-address`, `lease <d> <h> <m>`. `network` derives the allocatable range across the subnet the way IOS does; `range` overrides it. | `engine/cli.js` (config mode) |
| **Runs** | `computeDhcp()` runs in both pre-run phases, after PoE and before routing. For every interface flagged `dhcp` and still unaddressed, it walks the broadcast domain (through bridges, stopping at routers), finds a pool whose network covers the subnet of the server interface that received the broadcast, and applies the issued lease: address, mask, gateway, DNS, lease time. | `engine/simulator.js` `computeDhcp`, `_broadcastDomain` |
| **Refuses** | A server never allocates an address it already holds on that segment, so the derived range cannot hand out the router's own gateway. An exhausted pool emits `dhcp-no-offer`; a segment with no server emits `dhcp-failed` naming the reason. | `engine/simulator.js` |
| **Tested** | `test/dhcp.test.js` (library) and `test/dhcp-in-path.test.js` (33 assertions: leases, two clients, exhaustion, no server, exclusions, DNS, save/load, static clients, router-as-client). | `test/` |

**The honest limit:** the exchange is *computed* at the start of a run, not carried as
timed frames — the same approximation this engine already makes for OSPF, BGP and STP.
There is no DISCOVER timeout, no retry backoff, no T1/T2 renewal, and no packet in the
timeline showing a 4-way handshake; instead the events `dhcp-discover`, `dhcp-offer`,
`dhcp-request`, `dhcp-ack`, `dhcp-nak`, `dhcp-no-offer` and `dhcp-failed` record what
happened and why. A lab can show that DHCP works and demonstrate its failure modes; it
cannot show how long a lease takes to arrive.

Also absent: DHCP relay (`ip helper-address`), Option 82, vendor classes, DHCP snooping,
and any DHCPv6 — which SLAAC's M-flag tells a host to go and use
(`engine/simulator.js:1018`), and which still does not exist.

### 5.2 NAT / PAT

| Verdict | Behaviour | Where |
|---|---|---|
| **Modelled** | Static one-to-one, dynamic pool, and PAT/overload, in both directions, with ageing in simulated steps. | `engine/nat.js:676`, `engine/nat.js:710` |
| **Modelled** | Wired into the forwarding path: inbound rewrite **before** the local-address test, outbound rewrite **before** the routing decision — the order a real box works in. | `engine/simulator.js:1882`, `engine/simulator.js:1978` |
| **Modelled** | Port forwarding on a static rule. | `engine/nat.js:26-27` |
| **Approximate** | Translation keys on the 5-tuple and a caller-supplied step; there are no real timers, so translations age only if the caller advances `step`. | `engine/nat.js:54` |
| **Absent — important** | **Only frames carrying an L4 header are translated.** `_natOutbound`/`_natInbound` return early when `frame.l4` is absent, and an ICMP echo has no `l4`. So a ping across a NAT box is *not* translated: the echo reaches the router, fails the "is this address mine" test, and is dropped as unroutable. NAT only ever applies to transport flows opened through `openFlow()`. | `engine/simulator.js:2659`, `engine/simulator.js:2685` |
| **Absent in the CLI** | There is no `ip nat inside/outside`, no `ip nat inside source`. Rules come from `config.nat.rules` / `config.nat.portForwards` in the topology JSON. `grep -i nat engine/cli.js` finds only "native vlan". | `engine/simulator.js:2627-2644` |
| **Absent** | ALGs (FTP/SIP/H.323), NAT64/NPTv6, hairpinning, twice-NAT, ICMP error translation. | — |

### 5.3 ACLs

| Verdict | Behaviour | Where |
|---|---|---|
| **Modelled** | Standard (1–99, 1300–1999) and extended (100–199, 2000–2699) lists, wildcard masks, `host`/`any`, `eq`/`gt`/`lt`, service names. | `engine/acl.js:11-26` |
| **Modelled** | First match wins; falling off the end is the **implicit deny**, marked `implicit: true` so a tool can say why. | `engine/acl.js:342-350` |
| **Modelled** | Bound per interface and direction (`ip access-group`), evaluated inbound after learning and outbound on the **physical** port after subinterface parent resolution. | `engine/cli.js:339`, `engine/simulator.js:1792`, `engine/simulator.js:1688-1697` |
| **Approximate** | Extended rules can match protocol and ports, but only the fields the engine carries: src/dst IP, protocol, src/dst port. No flags, no ICMP type/code, no TOS, no fragments. | `engine/simulator.js:1487` |
| **Approximate** | ACLs are **IPv4-only**: anything that is not `0x0800` with an `ip` header passes untouched, including all ARP and all IPv6. | `engine/simulator.js:1477` |
| **Absent** | Any state. No `established`, no reflexive ACLs, no CBAC/zone-based policy, no connection table consultation — each packet is judged alone. No logging, no counters, no time-ranges, no IPv6 ACLs, no VTY/SNMP ACLs. | — |
| **Absent** | The `firewall` capability does nothing. 58 firewall models are catalogued and 217 device specs declare the capability; the engine never reads it. A firewall is a router with ACLs you configure by hand. | `engine/device.js:90` |

### 5.4 VRRP — **absent from the data path**

| Verdict | Behaviour | Where |
|---|---|---|
| **Modelled (as a library)** | Group maths, master/backup election by priority and IP, virtual MAC formation, advertisement interval arithmetic — pure functions with tests. | `engine/vrrp.js`, `test/vrrp.test.js` |
| **Exported** | Re-exported from the public API. | `engine/index.js:18` |
| **Absent in the simulator** | Never required by `engine/simulator.js`. No VRRP advertisement is ever sent, no group ever elects a master, and — the part that breaks labs — **nothing answers ARP for the virtual IP**. A host pointing at a VRRP virtual address gets no reply and times out. | grep `vrrp` in `engine/simulator.js` returns nothing |
| **Absent in the CLI** | No `vrrp` command, no `standby`/`hsrp` equivalent. | — |

There is no first-hop redundancy of any kind, and no HA failover to demonstrate.

### 5.5 OSPF

| Verdict | Behaviour | Where |
|---|---|---|
| **Modelled** | Adjacency graph from live links, Dijkstra SPF, code `O` routes installed at AD 110, next hop resolved to a directly connected neighbour. | `engine/simulator.js:397-493`, `engine/ospf.js:467` |
| **Modelled** | Areas: one area per link, an interface area overrides the router area (the ABR pattern), and a link is only usable when both ends agree on the area. | `engine/ospf.js:10-21`, `engine/ospf.js:363` |
| **Modelled** | Per-interface cost overrides, and interface cost otherwise derived from link rate against a 100 Mbps reference. | `engine/simulator.js:352`, `engine/simulator.js:380` |
| **Approximate** | No protocol state at all: no hellos, no dead timer, no LSAs, no DR/BDR election, no adjacency FSM. The SPT is recomputed from scratch before each run, so "convergence" is instantaneous and cannot be observed, only its result. | `engine/ospf.js:1-9` |
| **Approximate** | Link metric is a fixed 10 in the simulator's link list; per-interface costs enter through the graph builder. | `engine/simulator.js:441` |
| **Absent** | Area types (stub/NSSA), virtual links, ABR/ASBR route leaking, authentication, graceful restart, OSPFv3, redistribution. | — |

Known defects that change what a lab will show: [#42, #43, #44](#10-known-open-defects).

### 5.6 BGP

| Verdict | Behaviour | Where |
|---|---|---|
| **Modelled** | A session forms only when **both** sides list the other as a neighbour with a matching remote-as. Half a peering is not a peering. | `engine/simulator.js:534-564` |
| **Modelled** | Advertisement runs to convergence in rounds (max 12) before the first packet, originating every connected prefix. | `engine/simulator.js:577-638` |
| **Modelled** | Split horizon: a route is never advertised back to the peer it was learned from. | `engine/simulator.js:609` |
| **Modelled** | Best path: weight, local-preference, locally originated, shortest AS path, lowest origin, lowest MED, eBGP over iBGP, lowest router ID — in that order. | `engine/bgp.js:408-436` |
| **Modelled** | AS-path loop prevention including AS_SET members; 4-byte ASNs; eBGP prepend, iBGP no-prepend. | `engine/bgp.js:308`, `engine/bgp.js:503` |
| **Modelled** | Administrative distance 20 for eBGP, 200 for iBGP, installed into the routing table. | `engine/simulator.js:618` |
| **Approximate** | MED is compared unconditionally. Real BGP compares MED only between paths from the same neighbour AS. Declared in the module header. | `engine/bgp.js:18-19` |
| **Approximate** | The FSM exists (`idle→connect→active→opensent→openconfirm→established`) but is never fed: hold/keepalive timers are validated and carried, never expire, and no session ever drops. | `engine/bgp.js:14-21`, `engine/bgp.js:220-266` |
| **Approximate** | Next hop is rewritten to the advertising router's address on every advertisement, which is right for eBGP and wrong for an iBGP relay — see defect #41. | `engine/simulator.js:617` |
| **Absent** | Route reflectors, confederations, peer groups/templates, AFI/SAFI negotiation, IPv6 unicast, communities, route-maps, prefix-lists, `next-hop-self`, dampening, graceful restart. | — |
| **Absent in the CLI** | `router bgp`, `neighbor … remote-as`, `router-id` only. | `engine/cli.js:228-246` |

`docs/BGP-POLICY.md` is a **design document**, not a description of the code:
its tables read "Today … This design changes it to" (`docs/BGP-POLICY.md:39-50`)
and route-maps/communities are §8 and §5 of a proposal. None of that policy
layer exists in `engine/bgp.js` today.

### 5.7 DNS

| Verdict | Behaviour | Where |
|---|---|---|
| **Modelled** | Authoritative zones with A, AAAA, CNAME, MX, NS, PTR, SOA, TXT, SRV; relative/absolute name rules; CNAME chains to depth 8; NXDOMAIN distinguished from empty-NOERROR. | `engine/dns.js:47-50`, `engine/dns.js:342` |
| **Modelled** | `ping <hostname>` and `openFlow()` resolve through the lab's DNS servers before a packet is sent. The failure is named for what actually happened: `dns-nxdomain` (the name is not in the zone), `dns-nodata` (the name exists, the type does not — NOERROR with an empty answer), `dns-servfail` (no device in the lab hosts a zone). | `engine/simulator.js:137`, `engine/simulator.js:228-260` |
| **Approximate** | Server selection is a shortcut: the client's configured `dnsServers`, or — when it lists none — **any** device in the lab that hosts a matching zone. There is no recursive walk from root to TLD, no delegation, no forwarder. | `engine/simulator.js:137-156` |
| **Absent** | Recursion to a real resolver, DNSSEC, zone transfers, EDNS(0), negative caching, DNS over TCP. A resolver is only a listener on port 53 for flow purposes (`engine/flow.js:316`). | — |

### 5.8 SCION

| Verdict | Behaviour | Where |
|---|---|---|
| **Modelled** | ISD-AS identifiers, core-AS rule (hex id ending `:0`), UP/CORE/DOWN path segments, beaconing from core ASes over real adjacencies, path composition enforced by allowed shapes, selection by hop count or by latency. | `engine/scion.js:777`, `engine/scion.js:563`, `engine/scion.js:654` |
| **Modelled** | Deterministic: no clocks, no randomness, every list sorted, so the same topology always selects the same path. | `engine/scion.js:24-28` |
| **Approximate** | Path latency is the sum of per-segment `latencyMs`, defaulting to **1 ms per hop** when a segment states nothing. It is not measured from the links. | `engine/scion.js:55`, `engine/scion.js:415`, `engine/scion.js:534` |
| **Absent — important** | `pingScion()` walks the AS list and emits `scion-hop` events; **it does not put IP frames on the wire**, does not consult the routing table, and does not model the SCION header on real hardware. It answers "is there a beaconed path, and which one wins", not "does a packet traverse it". | `engine/simulator.js:1392-1471`, `engine/scion.js:5-18` |
| **Absent** | Trust roots and certificates, DRKey, beacon service/store persistence, path revocation, peering vs. provider/customer policy, hidden paths. | — |

### 5.9 LLDP

| Verdict | Behaviour | Where |
|---|---|---|
| **Modelled** | One LLDPDU per cabled port at the start of each run; the receiver stores a neighbour record keyed by port. | `engine/simulator.js:1196-1209`, `engine/lldp.js:18` |
| **Modelled** | Terminated at the nearest bridge and **never flooded**, so the simulator cannot invent neighbours two switches away. | `engine/simulator.js:1766-1776`, `engine/lldp.js:10-12` |
| **Approximate** | No transmit timer: one announcement per run, not every 30 s. TTL is carried as 120 and never counted down, so a neighbour never ages out. | `engine/lldp.js:15` |
| **Absent** | LLDP-MED, DCBX, CDP, per-TLV config, shutdown-on-neighbour. | — |

---

## 6. Physical layer

### 6.1 Cages, media and mating

| Verdict | Behaviour | Where |
|---|---|---|
| **Modelled** | 19 cages and 64 media across eight families (copper, fiber, dac, coax, dsl, powerline, console, wireless). Count them with `node -e "console.log(Object.keys(require('./engine/media').MEDIA).length)"`. | `engine/media.js:54`, `engine/media.js:157` |
| **Modelled** | Port hardware is derived from a terse spec (`{name, type, speed}` → cage, media, speed caps, PoE in/out). | `engine/media.js:562-641` |
| **Modelled** | An unrecognised cage is reported as unknown — no silent fallback to RJ45 and no fake media set. | `engine/media.js:574-586` |
| **Modelled** | The three-test mating rule: cages mate → shared medium → common speed. | `engine/media.js:744-786` |
| **Modelled** | Combo RJ45/SFP ports expose the union of both halves; QSFP-DD accepts QSFP28/QSFP+ modules and negotiates down. | `engine/media.js:208-219`, `engine/media.js:280` |
| **Modelled** | Preferred medium when several are valid: fiber/DAC over copper SFP, then highest speed. | `engine/media.js:790-802` |

### 6.2 Speed negotiation and downshift

| Verdict | Behaviour | Where |
|---|---|---|
| **Modelled** | Wired links run at the highest **common** rate, then clamped to what the chosen medium can carry. | `engine/media.js:736-741`, `engine/validation.js:610-619` |
| **Modelled** | A 10G SFP+ cabled to a 1G SFP negotiates 1000BASE-X at 1 Gbps — correct, because the cage accepts a 1G optic. | `engine/media.js:211-219` |
| **Modelled** | `W_SPEED_DOWNGRADE` warns when the link runs below **both** ports' maximum. | `engine/validation.js:751-761` |
| **Modelled** | `E_NO_COMMON_SPEED` blocks a pair with no shared rate. | `engine/validation.js:126` |
| **Approximate** | A radio association deliberately does **not** require an exact match: the client takes the best rate both sides and the band can sustain. | `engine/media.js:709-734` |
| **Absent** | Autonegotiation as a process (no FLP bursts, no parallel detection), forced speed/duplex from the CLI (`speed`/`duplex` are not commands), half-duplex collisions, duplex mismatch as anything but a warning. | `engine/validation.js:743-749` |

### 6.3 PoE

| Verdict | Behaviour | Where |
|---|---|---|
| **Modelled** | Per-port PSE/PD wattage, derived from the spec or inferred (802.3af 15.4 W out / 12.95 W in defaults). | `engine/media.js:628-638` |
| **Modelled** | Device-level budget, read from the spec or parsed out of the model string (`"… PoE+ 370W"`). | `engine/media.js:806-812` |
| **Modelled** | Budget is allocated before the run; a port that cannot be funded marks its peer `poeUnpowered`, and that device then neither transmits nor receives (`poe-deny` events both ways). | `engine/simulator.js:1211-1259`, `engine/simulator.js:1534-1540`, `engine/simulator.js:1783-1789` |
| **Modelled** | Cable-time check: `E_POE_BUDGET` refuses a link that would over-subscribe the PSE; `W_POE_DRAW` warns about a powered device on a port that cannot supply power. | `engine/validation.js:668-690`, `engine/validation.js:763-777` |
| **Approximate** | Allocation order is **alphabetical by port name**, not by LLDP power priority or by class: which device goes dark when the budget runs out is decided by `ports.sort()`. | `engine/simulator.js:1221-1226` |
| **Absent** | PoE class negotiation and classification, 802.3bt Type 3/4 class levels, power priority/critical ports, per-port current limits, power budgeting over time, inrush. | — |

### 6.4 Optical budget and PON splitters

| Verdict | Behaviour | Where |
|---|---|---|
| **Modelled** | A PON link is budgeted in **both** directions — 1490 nm downstream, 1310 nm upstream — because upstream is lossier and usually what fails. | `engine/validation.js:621-666`, `engine/optical.js:49-60` |
| **Modelled** | Splitter insertion loss per ratio (worst case across the catalogue), fibre attenuation per wavelength, connector pairs, splices, declared patch-cord loss, PON class (B+, C+, N1, N2 …). | `engine/optical.js:28-45`, `engine/optical.js:76-84`, `engine/optical.js:99` |
| **Modelled** | `E_OPTICAL_BUDGET` blocks the cable with a breakdown naming the element that ate the budget; `W_OPTICAL_HEADROOM` warns under 3 dB of spare. | `engine/validation.js:653`, `engine/validation.js:658-664` |
| **Approximate** | Budget maths only. Once the cable exists, the link is perfect: no bit errors, no FEC, no dispersion penalty, no aging, no dirty connectors. | — |
| **Absent** | Dispersion/OSNR limits, FEC latency, GPON framing and T-CONTs, upstream time-slot arbitration (the splitter replicates, it does not schedule), per-vendor optic budgets (a 1G LX and a 10G LR are both "standard reach"). | — |

### 6.5 Ferrule polish refusals

| Verdict | Behaviour | Where |
|---|---|---|
| **Modelled** | Six ferrule shapes with polish and angle: SC/UPC flat, SC/APC 8°, LC/UPC, LC/APC, MPO/UPC, bare LC → UPC. | `engine/media.js:250-257` |
| **Modelled** | Same shape, different polish → refused with `E_POLISH_MISMATCH` and a message that explains the ~3 dB cost and the risk of chipping the endface. | `engine/media.js:262-265`, `engine/media.js:754-763` |
| **Modelled** | The one legal way across a polish boundary is a declared **hybrid cord**, which is charged its insertion loss and flagged `W_HYBRID_CORD`. | `engine/media.js:691-706`, `engine/validation.js:138` |

### 6.6 Cable length

| Verdict | Behaviour | Where |
|---|---|---|
| **Modelled** | Length is a property of the lead (`Link.lengthM`), not a maximum reach; null means "not stated". | `engine/link.js:14-36` |
| **Modelled** | `W_DISTANCE` fires only when a length **and** a medium reach are both known. An unstated length produces no warning rather than an invented one. | `engine/validation.js:717-726` |
| **Modelled** | `W_COPPER_LONGRUN` at 90 m for the horizontal-run limit. | `engine/validation.js:157`, `engine/validation.js:728-736` |
| **Approximate** | Length affects **latency only** ([§8](#8-time-what-rtt-means-and-what-it-does-not)). An over-length cable still passes every packet perfectly — the warning is the entire model of the failure. | — |
| **Absent** | Attenuation, link-loss budgets for copper, bend radius, cable damage, intermittent faults. | — |

### 6.7 The cable matrix

Every cage pair has an **expected verdict** in a table that is treated as the
specification, not as a snapshot of the engine — a divergence fails the test and
names the pair, and each accepted pair must also produce a real link with a
sane medium and rate (`test/cable-matrix.test.js:1-30`).

That is the strongest correctness claim in the repo, and it is worth knowing
that it covers **cages and speeds**, not "this cable will carry traffic".

---

## 7. Wireless

| Verdict | Behaviour | Where |
|---|---|---|
| **Modelled** | Five radio media: 2.4 GHz, 5 GHz, 6 GHz (Wi-Fi 6E), 6 GHz (Wi-Fi 7), 60 GHz (802.11ad). | `engine/media.js:145-149` |
| **Modelled** | A radio's band set follows its **generation**, which follows its rate (n/ac/ax/be), unless the spec states bands explicitly. A Wi-Fi 5 radio is 2.4+5. | `engine/media.js:532-560` |
| **Modelled** | 60 GHz is a different radio, not a faster one: it is selected from the model text (`60 GHz`, `802.11ad`, `WiGig`), never from a high rate. | `engine/media.js:551-554` |
| **Modelled** | Association = the best shared band caps the rate, so a 2.5 Gbps phone on a 574 Mbps 2.4 GHz radio associates at 574 instead of refusing. | `engine/media.js:709-734` |
| **Modelled** | A radio can never be cabled to a wired port (`E_WIRELESS_TO_WIRED`), and an antenna port is not a cable at all. | `engine/media.js:748-752` |
| **Approximate** | "Wireless" is a link type with an antenna cage. There is no shared medium: two clients on one AP do not contend, do not share airtime, and cannot hear each other. | — |
| **Absent** | SSID, BSSID, beacons, association/auth frames, WPA/PSK/802.1X, channels and width, interference, RSSI, rate adaptation, retries, roaming, mesh, band steering, hidden SSID, MU-MIMO/OFDMA. `grep -i "ssid\|channel\|interfer" engine/*.js` finds nothing in the forwarder. | — |

A wireless "cable" in PacketForge is an Ethernet link with a different cage.
That is enough to teach cabling and VLANs over a radio, and not enough to teach
anything about 802.11.

---

## 8. Time: what "rtt" means and what it does not

| Verdict | Behaviour | Where |
|---|---|---|
| **Modelled** | A round trip is **computed** from the path the exchange actually walked. Every `frame` event between request and reply names the port it left; that port's link supplies the medium, the length and the line rate. | `engine/simulator.js:180-208` |
| **Modelled** | propagation = `length / (velocity factor × c)`, with per-family velocity factors (copper 0.66, fibre 0.68, coax 0.77, DAC 0.70, wireless 1.0, DSL 0.66, powerline 0.60). | `engine/latency.js:70-79`, `engine/latency.js:157` |
| **Modelled** | serialisation = `bits / line rate`, with the frame measured from destination MAC to FCS, plus 4 bytes per VLAN tag. | `engine/latency.js:165`, `engine/latency.js:186-194` |
| **Approximate** | A per-hop store-and-forward term of **50 µs** is charged on every crossing but the last. This is a single constant for every device in the model — switch, router, firewall — and is labelled as an approximation in the source, not derived from hardware. | `engine/latency.js:86-98`, `engine/latency.js:174` |
| **Modelled** | Round trip = forward + reverse, each summed over its own legs; both directions are charged, because the frame is serialised at every port twice. | `engine/latency.js:296-318`, `engine/simulator.js:204` |
| **Modelled** | An unstated length costs 0 m and reports `lengthKnown: false`; an unstated rate costs 0 s. The model refuses to invent a distance. | `engine/latency.js:100-106`, `engine/latency.js:132-136`, `engine/simulator.js:279` |
| **Absent** | Queueing delay, jitter, host ICMP processing, NIC interrupts, kernel wakeups, ARP resolution time, optical dispersion and FEC. All four are named as deliberately excluded at `engine/latency.js:22-31`. | — |

Three consequences a lab author needs:

1. **There are no timers anywhere in the engine.** `grep -n "setTimeout\|setInterval\|Date.now" engine/*.js` finds only comments. The delay is a
   number computed at the end of a run that already happened
   (`engine/latency.js:32-34`). Nothing sleeps, nothing interleaves, and a run
   takes the same wall-clock time whether the path is 1 m or 40 km.
2. **`hops` is not a duration.** `replies[].hops` is still the queue-step count
   (`engine/simulator.js:276`); `replies[].rtt` is the computed round trip in
   milliseconds, with `rttUs` alongside.
3. **RTT is a floor, not a prediction.** With queueing excluded, the number is
   what an idle network would deliver. A lab that "proves" a latency SLA is
   proving arithmetic.

---

## 9. What this is not

Blunt list. Each line is a thing someone reasonably assumes, and what is
actually true.

| Assumption | Reality | Where |
|---|---|---|
| "It's a TCP/IP stack." | There is a tiny TCP model — three-way handshake, MSS from path MTU, cumulative ACKs, four-way close — and nothing else: no congestion window, no retransmission timer, no SACK, no TIME_WAIT, no window scaling, no ICMP port-unreachable for stray UDP. | `engine/flow.js:19-24`, `engine/simulator.js:2249` |
| "Traffic starts connections." | Only an explicit API call does. `openFlow()` is invoked by the server on `POST /flows`; no packet ever triggers a connection on its own. | `engine/simulator.js:2249` |
| "Services respond." | A capability only registers **listeners** — `http-server` means "ports 80 and 443 answer SYN" (`engine/flow.js:77-85`). There is no HTTP request, no TLS handshake, no SSH banner, no FTP, no SMTP. A closed port answers RST, which is the whole application layer. | `engine/simulator.js:2546-2560` |
| "Congestion happens." | Nothing is ever dropped because of load. There are no queues, no buffers, no contention, no tail drop, no AQM. A link at 100 % of its rate behaves exactly like an idle one. | — |
| "Loss happens." | Nothing is lost except by an explicit rule: VLAN, ACL, STP, PoE, TTL, no route, NAT failure. A cable 10× over its reach still delivers every packet. | — |
| "There are real timers." | None. No scheduling, no concurrency, no ageing, no expiry. See [§8](#8-time-what-rtt-means-and-what-it-does-not). | `engine/latency.js:32` |
| "It's a stateful firewall." | ACLs are per-packet, stateless, IPv4-only. The `firewall` capability is inert. | `engine/simulator.js:1477`, `engine/acl.js:342` |
| "Routes redistribute." | They do not. Connected → OSPF and connected → BGP only; no OSPF→BGP, no BGP→OSPF, no static→anything. | `engine/simulator.js:577-588`, `engine/simulator.js:406-419` |
| "MPLS / VXLAN / GRE / IPsec / LISP / SRv6." | None of them. `grep -ri "mpls\|vxlan" engine/` returns nothing. | — |
| "DAI, DHCP snooping, IP Source Guard, RA guard." | None. ARP and ND are trusted completely. | — |
| "IPv6 is first-class." | ND and SLAAC are good; ACLs, NAT, routing protocols and first-hop redundancy are IPv4-only or absent. | `engine/simulator.js:1477`, `engine/device.js:484` |
| "HA exists." | No VRRP/HSRP in the data path, no BFD, no LACP failure detection, no graceful restart. | `engine/index.js:18` vs `engine/simulator.js` |
| "Multicast is routed." | Multicast floods like broadcast inside a VLAN and is never routed between subnets. No IGMP, no PIM. | `engine/simulator.js:1842` |
| "QoS exists." | No marking, no queues, no shaping, no policing, no CoS/DSCP anywhere. | — |
| "Counters show errors." | `show interfaces` counters are bytes/packets in and out. No CRC, no runts, no giants, no collisions, no drops-by-reason beyond the event log. | `engine/flow.js:354-360` |
| "A device can be overwhelmed." | Control-plane work is instantaneous: OSPF/BGP reconverge for free, LLDP/RAs cost nothing, and 8 000 steps is a loop guard rather than a capacity limit. | `engine/simulator.js:110` |
| "A hop is a time." | A step is a frame handed to a port. Latency is computed separately. | `engine/simulator.js:276` |
| "Config is validated." | Each module validates its own config when asked to; the engine will happily run an inconsistent topology and show you whatever the graph produces. | `engine/validation.js:1-24` |

And a short list of things that exist on the model but are **never read** —
i.e. configuring them is decoration:

- `Link.state` (`engine/link.js:41`) — `'up' | 'down' | 'blocked'` is serialised and never consulted; only `iface.enabled`, STP blocking and PoE gate a frame.
- `minLinks` on a LAG (`engine/lag.js:55`).
- LAG `mode` (`engine/lag.js:217`) — validated, then ignored.
- `voiceVlan` (`engine/vlan.js:13`).
- `iface.dhcp` (`engine/cli.js:307`).
- Capabilities `firewall`, `wireless`, `dhcp-server`, `dhcp-client`, and the tokens `vlan`/`lacp`/`stp` (`engine/device.js:85-98`).
- RA valid/preferred lifetimes (`engine/simulator.js:1054`).

---

## 10. Fixed defects, kept visible

Five control-plane defects were found by reading the code rather than by tripping
over them, and they are **fixed**. They stay listed because each one changed how a
lab behaves, and a topology saved before the fix may not route the way its author
expected:

| Issue | What used to happen | Now |
|---|---|---|
| **#41** | BGP re-advertised an iBGP-learned route to another iBGP peer, rewriting the next hop to the relayer — traffic that a real iBGP mesh without a route reflector would never carry. | A route is not sent back to the peer it came from, and learned routes are not relayed to other iBGP peers. |
| **#42** | OSPF installed a route for a router's **own** connected network at transit cost, so a code `O` entry could shadow the `C` entry. | Connected networks are excluded from OSPF installation; the connected route is the route. |
| **#43** | A passive OSPF interface was dropped from the graph entirely, so its prefix disappeared instead of being advertised as a stub. | The prefix is advertised; only the adjacency is suppressed. |
| **#44** | When a network was reachable from several routers, the **more expensive** advertisement won, by device-id order. | Cheapest cost wins; a genuine tie breaks on the lower advertising router id, so the result is deterministic. |
| **#54** | NAT's flow key omitted the inside source port, so two sockets from one host behind PAT collided on a single translation. | The key includes the inside port; each socket gets its own global port. |

Two more were found the same way and fixed in the same pass:

| Issue | What used to happen | Now |
|---|---|---|
| **#240** | An OSPF adjacency formed from the cable alone, so two routers addressed in different subnets installed routes via a next hop on no connected subnet — traffic black-holed. | Both ends must share subnet **and** mask; a mismatch forms no adjacency. |
| **#241** | Every DNS failure returned NXDOMAIN — a missing A record, a missing name, and a lab with no DNS server all looked identical. | `dns-nodata` (NOERROR, empty), `dns-nxdomain`, `dns-servfail` are reported separately. |

The mechanism this page relies on: a defect found while writing a suite is pinned
as a `DOCUMENTS BUG` assertion, so the suite stays green while the bug is live and
**fails the moment somebody fixes it** — the fix cannot land without flipping the
assertion to the correct behaviour. As of this revision no such assertion remains;
if one reappears, it names a live defect.
---

## 11. Where the other docs overstate the code

Found while writing this page. None of these are fixed here; they are recorded
so the next reader does not have to rediscover them.

| Document | Says | Reality |
|---|---|---|
| `README.md:84` | "53 media types across eight families and 18 connector cages" | 18 cages became 19 with the cellular cage (#129); the catalogue holds **64** media (`engine/media.js:54`). |
| `README.md:80` | "91 models / 17 vendors" | The catalogue loads **905** specs across **199** vendors at this tree. |
| `README.md:19-21` | "Real simulation … MAC learning, flooding, ARP, longest-prefix routing, default gateways, TTL decrement and ICMP echo/reply" | Accurate — and that is the whole list. It is a statement of scope, not an understatement. |
| `README.md:24-28` | "Physically accurate … impossible cables are refused, not drawn" | Accurate and well tested; just remember [§6.6](#66-cable-length) — length is otherwise cosmetic. |
| `docs/ARCHITECTURE.md:41` | `dhcp-server`, `nat`, `firewall`, `wireless`, `http-server` "reserved for future protocol support" | `nat`, `http-server` and now `dhcp-server`/`dhcp-client` are live; `firewall` and `wireless` are still inert. |
| `docs/ARCHITECTURE.md:61-69` | Routing order: connected, static, default gateway | Right, and incomplete: BGP (20/200) and OSPF (110) sit between static and the default gateway (`engine/device.js:364-443`). |
| `docs/ARCHITECTURE.md:94-111` | Flow API and counters | Accurate. |
| `docs/CLI.md:50` | `ip address dhcp` — "(reserved)" | Was correct and is now fixed: the flag is read by `computeDhcp`, which installs a real lease. |
| `docs/CLI.md` (whole) | Documents `show`, `interface`, `ip address`, `ip route`, `ping`, IPv6 ND | It does not document the commands that exist for `access-list`, `ip access-group`, `switchport`, `channel-group`, `router bgp`/`neighbor`, `ospf`, `dns`, `scion`. The CLI reference is behind the CLI. |
| `docs/ROADMAP.md:7-19` | Lists VLANs, STP, OSPF/RIP, NAT, ACLs, wireless, DNS as unchecked TODOs | All of those except RIP, DHCP-in-the-data-path and wireless association are implemented. A stale roadmap reads as a promise; here it reads as a warning that happens to be wrong in both directions. |
| `docs/BGP-POLICY.md` | A full policy design — local-pref, MED, communities, route-maps | A design document. Only the decision-order subset in `engine/bgp.js` exists. |

---

## 12. Things this page cannot tell you

Places where the code does not answer the question, stated rather than guessed:

- Whether `Link.state` was meant to gate forwarding. Nothing reads it, and no
  comment says what `'down'` should do.
- Whether a LAG below `minLinks` was meant to shut the bundle or merely stop
  forwarding.
- What `voiceVlan` was for, given that access ports reject tagged frames and the
  forwarder never consults it.
- Whether RA valid/preferred lifetimes were meant to age during a run (they are
  stored and displayed; nothing decrements them).
- Whether the `firewall` capability was meant to imply default-deny. Today a
  device with `firewall` and no bound ACL permits everything.

If you are relying on one of these, the honest move is to check the code at the
commit you are running, not this page and not the README.

---

## Checking a claim yourself

The engine is dependency-free, so every claim above is one command away:

```bash
node -e "const m=require('./engine/media'); console.log(Object.keys(m.MEDIA).length, Object.keys(m.CAGES).length)"
node -e "const {Simulator,Topology}=require('./engine'); /* build a two-host lab, ping, inspect replies[0].delay */"
grep -rn "dhcp" engine/simulator.js     # returns nothing: DHCP is not in the data path
grep -rn "vrrp" engine/simulator.js     # returns nothing: VRRP is not in the data path
grep -rn "setTimeout\|setInterval\|Date.now" engine/*.js   # comments only: there are no timers
npm test                                 # the suites that pin the behaviour above
```
