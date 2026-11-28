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
  `Simulator` does not. `Simulator.reset()` (`engine/simulator.js:202`) rewinds
  a run, not the network.
- **A "step"** is one frame handed to one port. It is a hop count, not a
  duration — see [§8](#8-time-what-rtt-means-and-what-it-does-not).

---

## 1. The engine loop

Everything else on this page depends on how a run is sequenced, so it comes
first.

**Modelled**

- A frame is a plain object (`{dstMac, srcMac, etherType, ip, icmp, arp, l4, flow}`),
  built by `ethFrame()` at `engine/simulator.js:142`.
- Transmissions go on a FIFO array and `_run()` drains it synchronously, one
  `step++` per delivery (`engine/simulator.js:3244-3253`). The loop waits on nothing —
  no wall-clock timer, no coroutine, no concurrency: a run is a single-threaded drain
  that ends when the queue is empty. Simulated time is a separate axis, and this page
  uses it: the schedule below, the port states in §2.4, and the ageing in the
  *Approximate* list.
- Guard rails are loop detectors, not physics: `maxSteps = 8000`
  (`engine/simulator.js:210`) and a 100 000-iteration runaway guard
  (`engine/simulator.js:3249`). Exceeding either emits a `limit` event.
- Before the first packet, a run recomputes the world **once**, and which steps it
  runs is the entry point's own. `ping()` runs eight, in this order: spanning tree,
  PoE, the VRRP election, the DHCP pull, LLDP, router advertisements, OSPF, BGP
  (`engine/simulator.js:612-628`). The election comes before the pull because a host
  that takes its gateway from DHCP should pull the address something already answers
  for; both come before the announcements because a host with no address cannot be
  asked anything. `traceroute()` and `openFlow()` run the six without those two
  (`engine/simulator.js:762-767`, `engine/simulator.js:4222-4228`).
  `ping6()` runs five, without LLDP (`engine/simulator.js:2524-2531`).
  `pingScion()` runs PoE and the SCION paths alone
  (`engine/simulator.js:2862-2863`). That recompute is the *converged* answer, and it is no longer the only
  one: `Simulator.setRunTime(ms)` (`engine/simulator.js:446`) asks the same question at an instant, so at
  0 ms a port that will forward is still Listening and an OSPF route is still withheld — the timers in
  `engine/convergence.js` decide when each process is done. `Infinity` (the default) is the old
  "everything has finished" answer, and a cable change re-bases the schedule at the instant it moved, so a
  run does reconverge. See [CONVERGENCE.md](CONVERGENCE.md) and [LINK-STATE.md](LINK-STATE.md).
- Layer decisions are gated by `hasCap()`, through the predicates that name each
  token — `isL2()`, `isL3()`, `isHost()` (`engine/device.js:708-760`), with `isL3()`
  also requiring `ip routing` to be on — and the only capabilities the forwarding path
  actually consults are `l2-forward`, `l3-forward` and `host`
  (`engine/simulator.js:3575-3585`).

The pointers above were read off this tree (`97da585c`), and they had slid before: `_run()`'s loop
was cited at 3105-3112, then at 3158-3169, then at 3232-3241, and 3232-3241 is now the interface-counter comment
and an `_enqueue()` call - a reader following it learned how a frame is queued, not where a run is bounded. A
fourth pass re-measured every range in this section: `device.js`'s predicate block sits at 708-760 (quoted at
703-755 for `6d5c37c7`, itself 22 lines below the 681-733 that named it before), the forwarding gate at
3575-3585 (29 lines below 3546-3556), and the `openFlow()` and `ping6()` ranges had each stopped one line short
of the `computeBgp()` that closes them (4222-4228 and 2524-2531). `npm run check:citations` cannot catch this
class: it judges a citation only when the sentence names exactly one function and one line, and a bare range or
a bare number names no function to check it against. Each number above was read off the definition it belongs
to; the rest of this page's citations were not re-measured in the same pass.

**Approximate**

- Device state (MAC tables, ARP cache, ND cache, PoE power state) lives on the
  `Device`, inside the `Topology`, so it persists across runs — which is what a
  real box does. Two of those tables age against the instant a question is asked:
  a MAC entry after 300 s of silence (`MAC_AGE_MS`) and an ARP entry after 4 h
  (`ARP_AGE_MS`). The rest do not: no ND reachable-time, no DHCP lease expiry by
  wall clock. An entry that nothing dated — written by a fixture — never ages.
  See §3.2 and [CLI.md](CLI.md#what-the-mac-table-remembers-and-for-how-long).
- The capability list at `engine/device.js:151-160` advertises more than the
  layer predicates consume: `isL2()`, `isL3()` and `isHost()` read `l2-forward`,
  `l3-forward` and `host` and nothing else. Three of its tokens have no reader
  anywhere under `engine/` today — `dhcp-client`, `firewall` and `wireless` — the
  pending list `test/capability-vocabulary.test.js` holds to exactly three, and
  the same three [`DEVICE_SCHEMA.md`](DEVICE_SCHEMA.md#capabilities) names. This
  bullet used to call six of them unread: the fourth pass re-measured the ranges
  on this page and took the vocabulary on trust, so the writers that landed since
  left it stale. `poe-pse` and `poe-pd` are read by the PoE predicates in
  `engine/media.js:1159` and `engine/media.js:1177`, and `dhcp-server` by the data
  path's listener table (`engine/flow.js:84` - a `dhcp-server` terminates UDP/67)
  and by the DHCP-server gate in `engine/cli.js:2038`. A token nothing reads is
  still what the guard forbids, so the three are pending decisions rather than
  behaviour. VLANs, LAGs and STP apply to any `l2-forward` device whether or not it
  claims them, which is why `vlan`, `lacp` and `stp` are no longer in the
  vocabulary at all (#1526) — the datasheet fact stays in the spec, but nothing
  advertises it as behaviour. See
  [DEVICE_SCHEMA.md](DEVICE_SCHEMA.md#capabilities), [§2](#2-ethernet-and-l2) and
  [§5.1](#51-dhcp--in-the-data-path-since-1051).

**Absent**

- Concurrency. Two flows, two pings and an OSPF reconvergence never interleave;
  each run owns the simulator until it finishes.
- Any notion of a device CPU. Control-plane work takes the seconds its own timers name — STP’s two
  forward delays, OSPF’s hello plus SPF hold, the DHCP exchange ([CONVERGENCE.md](CONVERGENCE.md)) — but
  nothing ever *competes*: one process cannot starve another, so an OSPF flood cannot cause a CPU spike and
  a BGP flap cannot drop packets.

---

## 2. Ethernet and L2

### 2.1 MAC learning and flooding

| Verdict | Behaviour | Where |
|---|---|---|
| **Modelled** | Source MAC is learned on ingress, into a table **scoped to the frame's VLAN**. | `engine/simulator.js:3490` (`learnMac()` on the way in), `engine/device.js:968` (`learnMac()`, one table per VLAN) |
| **Modelled** | Known unicast → one egress port. Unknown unicast, broadcast and multicast → flood within the VLAN only. | `engine/simulator.js:3682-3824` (`_forwardL2()`) |
| **Modelled** | A flood never returns out of the ingress port, and never out of the LAG it arrived on. | `engine/simulator.js:3688` (the ingress port is not a candidate), `engine/simulator.js:3843` (`_egressRefusal()` answers `bundle`) |
| **Modelled** | A learned entry pointing back at the ingress port is dropped with `loop`, rather than forwarded. | `engine/simulator.js:3707` |
| **Approximate** | Learning happens before the ACL and the STP egress checks, so a frame that is then dropped still taught the switch a MAC. Real hardware does the same; worth knowing when reading a table after a denied flow. | `engine/simulator.js:3490` (learning) before `3497` (the inbound ACL) and `3733` (the egress filter, whose first refusal is the spanning tree's) |
| **Approximate** | Multicast is treated as broadcast: no IGMP snooping, no per-group filtering. This is deliberate — IPv6 neighbour discovery would never arrive otherwise. | `engine/simulator.js:3528-3529` (`isMulticastMac()` folded into `flood`) |
| **Modelled** | A dynamically learned entry ages out after **300 s** of silence (`MAC_AGE_MS`), and the aged lookup is what the data path uses, not just what the report prints: an entry the table only remembers is not a port a frame may be sent to. The `Age` column in `show mac address-table` is that silence, refreshed by traffic, not a lifetime. | `engine/device.js:6` (`MAC_AGE_MS`), `macLookup()` and `ageMacs()` |
| **Absent** | MAC move detection, per-port MAC limits, port security, storm control, error counters, CRC/FCS errors, collisions. | — |

Every number in that table was re-read off the tree as it stood at `d1ad8f93`, because all six had slid into the BGP block: `1734`
and `1792` were route-installation lines, `1842` a "neighbour is not on a connected subnet" refusal, `1895-2020`
the session walk, and `1955-1970` the `bgp` event's payload - so a reader following any of them learned how a prefix
is installed, not how a frame is learned. `engine/device.js:331`, cited for the VLAN-scoped table, is
`addSubinterface()`; the table is `learnMac()` at 961. Only the learning-and-flooding rows are re-measured here; the
rest of this page's citations were not, in that pass.

They moved again after it: five commits to `engine/simulator.js` landed between that pass and this one
(#2427, #2437, #2489, #2483, #2504), and every number in the six rows had slipped - `learnMac()`
3413 -> 3442, `_forwardL2()` 3605 -> 3634, the ingress skip 3611 -> 3640, `_egressRefusal()` 3766
-> 3790, the `loop` drop 3629 -> 3658, the inbound ACL 3420 -> 3449, the egress filter 3657 -> 3686,
and `isMulticastMac()` 3451 -> 3480, with `engine/device.js`'s `learnMac()` at 934 -> 961. The rows
were re-read off this tree again; what each one names is unchanged.

They moved once more, all by the same amount: the two OSPF adjacency changes (#1646, #1652) put 48 lines above the
frame path, so `learnMac()` 3442 -> 3490 (and `engine/device.js`'s at 961 -> 968), `_forwardL2()` 3634 -> 3682, the
ingress skip 3640 -> 3688, `_egressRefusal()`'s `bundle` answer 3790 -> 3843, the `loop` drop 3658 -> 3707, the
inbound ACL 3449 -> 3497, the egress filter 3686 -> 3733, and `isMulticastMac()` 3480 -> 3528. The six rows are
re-read off the tree at `d7cac843`; what each one names is unchanged.

### 2.2 VLANs (802.1Q)

| Verdict | Behaviour | Where |
|---|---|---|
| **Modelled** | Per-port config: `mode: access\|trunk`, `accessVlan`, `nativeVlan`, `allowedVlans`. | `engine/vlan.js:8-14` |
| **Modelled** | **Access**: egress untagged on `accessVlan`; ingress accepts untagged, drops tagged. | `engine/vlan.js:502-533` (`classifyEgress()`), `engine/vlan.js:537-578` (`classifyIngress()`) |
| **Modelled** | **Trunk**: egress untagged for `nativeVlan`, tagged for every other allowed VLAN; ingress maps untagged → native VLAN, tagged → VID if allowed, else drops. | `engine/vlan.js:502-533` (`classifyEgress()`), `engine/vlan.js:537-578` (`classifyIngress()`) |
| **Modelled** | Frames are really tagged on the wire: `_emitFrame` sets `wireTagged`/`wireVid` from `classifyEgress`, so the event log distinguishes a tagged trunk frame from an untagged access frame. | `engine/simulator.js:3210-3286` (`_emitFrame()`) |
| **Modelled** | MAC tables are per VLAN; VLAN 1 keeps the flat legacy table. Flooding is scoped to the VLAN. A dynamically learned entry ages out after `MAC_AGE_MS` (300 s) of silence, and the same aged lookup decides forwarding: an entry the table only remembers is not a port a frame may be sent to. | `engine/device.js` `learnMac()`, `macLookup()`, `macRows()`; `engine/simulator.js` |
| **Modelled** | VLANs 1–4094; 1002–1005 are rejected as reserved. | `engine/vlan.js:24-25`, `engine/vlan.js:28-33` (`RESERVED_VLANS`) |
| **Approximate** | Router-on-a-stick via subinterfaces works (`Gi0/0.10` creates a tagged logical interface), and `portPvid()` gives an untagged frame the VLAN its port carries untagged - the trunk's `nativeVlan`, or the access VLAN. | `engine/simulator.js:167-173` (`portPvid()`), `engine/device.js:338-373` (`addSubinterface()`), `engine/cli.js:2075-2089` (the `interface <parent>.<n>` door) |
| **Modelled** | The voice VLAN. On an access port `switchport voice vlan <id>` is live: `classifyEgress` sends that
VLAN tagged while the access VLAN goes untagged, `classifyIngress` accepts a tagged frame in it and still refuses
every other tag, and `show vlan` lists the port under both VLANs. On a trunk the parameter is stored and not
consulted - the allowed list is the whole answer - because Cisco's voice VLAN "is only supported on device access
ports" ([research/voice-vlan-port-mode.md](../research/voice-vlan-port-mode.md)).
`switchportSentence()`, the panel and `show running-config` all agree, and a save restores it. | `engine/vlan.js:classifyEgress`, `classifyIngress` |
| **Absent** | QinQ / 802.1ad, private VLANs, VTP, VLAN pruning negotiation. | — |

The `Where` cells here are the ones the passes above left alone, and most of them had been stale for longer than
the OSPF shift: `classifyEgress()` is defined at `502` and ends at `533`, but the cell cited `483-514` - a range that
opens inside `switchportSentence()` (from `455`) at its staged-trunk sentence and stops nineteen lines into
`classifyEgress()`. `classifyIngress()` is `537-578`, not `518-559`, which closes the egress access branch and stops
nineteen lines into the ingress classifier. `_emitFrame()` is `3210-3286`: `3156` is the ARP-cache branch of
`_sendL3` and `3216` the PoE refusal string already inside the function, and the range is not a pure shift - the
function grew, because the inactive-VLAN gate (#1568) and the subinterface outbound ACL (#1517) both sit inside it,
so its tail moved sixteen lines further down than its head. The router-on-a-stick row was wrong in all three cells:
`portPvid()` is `167-173` (the old range took the blank line after it), `addSubinterface()` is `338-373` (`330-360`
is the comment above it and stops inside the body), and the `interface Gi0/0.10` door is `engine/cli.js:2075-2089`,
where `internalConfig` calls `addSubinterface()` - `1754` is a device-name assignment. Re-read off the tree at
`afc27808`; the behaviour each row describes is unchanged.

### 2.3 Link aggregation (LAG)

| Verdict | Behaviour | Where |
|---|---|---|
| **Modelled** | A LAG is one logical port: frames are hashed onto exactly one member, the event log records which. | `engine/simulator.js:3787-3800` (`selectMember()` and the `lag` event), `engine/lag.ts:407` (`selectMember()`) |
| **Modelled** | Hash policies `l2`, `l3`, `l3l4`, deterministic FNV-1a — the same frame always lands on the same member. | `engine/lag.ts:235` (`HASH_POLICIES`), `engine/lag.ts:337` (`fnv1a()`), `engine/lag.ts:372` (`hashFrame()`) |
| **Modelled** | Spanning tree sees one edge per bundle, so it does not block members against each other. | `engine/simulator.js:922-925` (`computeStp()` groups members under `_logicalPortName()`) |
| **Modelled** | A frame that arrived on a member never leaves by the same group (no hairpin). | `engine/simulator.js:3843` (`_egressRefusal()` answers `bundle`) |
| **Approximate** | `mode` (`lacp-active`, `lacp-passive`, `static`) is validated and stored and now decides two things — whether the two ends would negotiate at all, and how wide the group may be (16 members for LACP, 8 for `on`) — but no LACPDU crosses the wire: a passive/passive pair and a one-ended group are answered by rule, not by a protocol. | `engine/lag.ts:488` (`negotiationVerdict()`), `engine/lag.ts:521` (`memberSuspension()`), `engine/lag.ts:260` (`maxMembers()`) |
| **Approximate** | `minLinks` is normalised and validated but never read at runtime: a bundle keeps forwarding at one member, it never shuts down. | `engine/lag.ts:299-301` (`minLinks` normalisation) |
| **Modelled** | A bundle carries **eight active links**; the rest of a LACP group (up to 16 members) are **hot-standby** — chosen in port order, shown `(H)` in `show etherchannel summary`, never hashed onto, and promoted when an active link goes away. A non-negotiating (`mode on`) group holds eight members and refuses a ninth. | `engine/lag.ts:254` (`MAX_ACTIVE_LINKS`), `engine/lag.ts:427` (`carryingMembers()`), `:443` (`activeMembers()`), `:448` (`standbyMembers()`) |
| **Absent** | LACPDUs, negotiation, per-member failure detection beyond `iface.enabled`, load-based member selection, L3/L4 hash entropy from anything but the fields present. | — |

Two rows in this table were still carrying the numbers from before the OSPF work, because the §2.1 pass
re-measured its own six cells and left the tables below them alone: `3739-3752`, cited for `selectMember()`
and the `lag` event, is now the refused-port list and the `Collapse LAG members` comment, and `3795`, cited
for `_egressRefusal()`'s `bundle` answer, is the `degraded:` comment inside the `lag` event. It is the same
+48 lines the two OSPF adjacency changes (#1646, #1652) put above the frame path: the call and its event are
at `3787-3800`, and `_egressRefusal()` answers `stp` before `bundle` at `3843`. The four rows citing
`engine/lag.ts` needed nothing - that file has not moved. Re-read off the tree at `bd2c1896`; the rows below
this section were not re-measured in this pass either.

### 2.4 Spanning tree (802.1D)

| Verdict | Behaviour | Where |
|---|---|---|
| **Modelled** | Root election (lowest bridge ID), root path cost, root/designated/alternate roles, forwarding/blocking states, blocked-port list. | `engine/stp.js:191`, `engine/simulator.js:951` |
| **Modelled** | Blocked ports drop **both** ingress and egress traffic (`stp-block` events). This is what turns a physical loop into a working topology instead of a storm. | `engine/simulator.js:3429-3432` (ingress gate), `engine/simulator.js:3736-3738` (the `stp-block` event) |
| **Modelled** | Path cost derived from the negotiated link rate by the vendor's **short** path-cost table (10 Mb 100, 100 Mb 19, 1 Gb 4, 10 Gb 2, faster 1), and divided by member count for an aggregate. A rate with no row of its own takes the next slower row's cost, so cost never rises with speed. | `engine/stp.js:47` (`costForSpeedMbps()`), `engine/simulator.js:979-988` |
| **Approximate** | The **election** is the converged result and is computed from the graph: no BPDU is put on the wire, and the hello time is printed rather than counted. The walk to Forwarding *is* timed — a port that will forward spends one forward-delay in Listening and the next in Learning (30 s at the 802.1D defaults), and a bridge that kept its own cable but lost its root pays the old root’s Max Age first (50 s); `show spanning-tree` prints the state it is in (`LTN`, `LRN`, `FWD`), so a lab asked at 5 s answers that the cable is up and nothing passes. A topology change flushes every bridge’s MAC table, but no TCN frame is sent. | `engine/stp.js:1-17` (the election only), `engine/convergence.js:54` (`stpTimers()`), `engine/convergence.js:181` (`stpMaxAgeHold()`), `engine/convergence.js:379` (`stpPortStateAt()`), `engine/simulator.js:1048-1068` |
| **Approximate** | It runs for **every** `l2-forward` device regardless of whether the spec claims `stp`, and there is no way to disable it — `show spanning-tree` reports the tree, and `no spanning-tree` clears the bridge priority back to the default 32768 rather than turning the tree off. | `engine/simulator.js:951` (`computeStp()`), `engine/cli.js:1115` (the `no spanning-tree` undo row) |
| **Absent** | RSTP/MSTP/PVST/PVRST, PortFast, BPDU guard/filter, root guard, loop guard, per-VLAN trees. | — |

Both `stp-block` anchors in this table pointed somewhere else: `3381-3384` is the link-down guard in
`_deliver()` and `3686-3692` is the flood-candidate loop in `_forwardL2()`, so neither named a blocked port even
though the claim about blocked ports dropping in both directions is true. The ingress gate is `3429-3432`
(`_processFrame()` refuses before anything is learned), and the egress event is `3736-3738`, the branch that fires
when `_egressRefusal()` answers `stp` - and it still answers that first, at `3839`, ahead of `bundle`. Re-read off
the tree at `afc27808`.

Two more anchors in this table had slid, and so had one claim. Both `computeStp()` pointers read `905`,
which is the discard ranking inside `_traceProbe()`, and the cost row read `942`, which is
`_logicalPortName()`: the election is built at `951` and a port’s cost is charged at `979-988`. The row
that called the convergence "instantaneous and free" was written before `engine/convergence.js` existed
(#1397): the tree is still a pure graph problem, but the seconds between the cable going green and the first
frame crossing are modelled, and #1731 put the old root’s Max Age in front of them for an indirect
failure. Re-read off the tree at `ed4fb5b2`.

### 2.5 Passive devices: taps and splitters

| Verdict | Behaviour | Where |
|---|---|---|
| **Modelled** | A **passive tap** (`category: tap` with no capabilities, or `passive: true`) passes frames between its network ports unchanged and duplicates them to monitor ports - a port counts as a monitor when its name begins `mon`/`monitor`, there is no monitor flag in the spec. A frame arriving on a monitor port is refused (`tap-inject-refused`, `simulator.js:3547`) — a tap is not a hub. | `engine/simulator.js:3536-3561`, `engine/device.js:726-731` |
| **Modelled** | A **passive splitter** (`category: splitter`) replicates to every other leg, unchanged, in both directions. No learning, no lookup, no VLAN rewrite. | `engine/simulator.js:3563-3573`, `engine/device.js:721` |
| **Modelled** | Neither can learn: the MAC-learning step explicitly skips them, so a tap cannot be credited with a table it could not hold. | `engine/simulator.js:3442` (`!isSplitter() && !isPassiveTap()`) |
| **Approximate** | SFP-based taps (the active/aggregating kind) are treated as passive if the spec says so; there is no aggregation port, no timestamping, no oversubscription. | — |

### 2.6 Bridge groups

| Verdict | Behaviour | Where |
|---|---|---|
| **Modelled** | Ports in the same `bridgeGroup` (e.g. `lan`) are treated as one L3 surface: an address configured on any member answers ARP/ICMP arriving on any other member, and the reply leaves by the port that asked. | `engine/device.js:261-298`, `engine/simulator.js:2036`, `engine/simulator.js:2064` |
| **Approximate** | A router's LAN sockets also enforce role separation: a LAN address is not reachable from the WAN port. | `engine/device.js:274` |
| **Absent** | **Bridging between bridge-group members.** A frame not addressed to the device is dropped (`not addressed to this device`) — it is not switched to another port in the group. Two PCs on a router's `lan2` and `lan3` cannot talk to each other unless the router routes between subnets, or the device also has `l2-forward`. This surprises people; it is the single most common misreading of the feature. | `engine/simulator.js:1916-1920` |

---

## 3. IPv4

### 3.1 Address ownership

Two different questions, and the forwarding path has to ask the first one first:

- **Do I hold this address at all?** A routing device has one IP stack, so any address it
  is configured with is its own whichever port a frame arrives on. `Device.holdsIp()`.
- **Will I serve it on this interface?** Not always: WAN and LAN are separate L3 surfaces, an
  address in VLAN 20 is not answered from a port in VLAN 10, and a subinterface answers for
  its own tag. `Device.ownsIpOn()`.

| Verdict | Behaviour | Where |
|---|---|---|
| **Modelled** | A router serves any of its own addresses on any of its ports. Ping the far-side address of your own gateway and it answers — previously it forwarded the packet, decremented the TTL and died, so the host saw silence while the router held the address. | `engine/device.js` `ownsIpOn`, `holdsIp` |
| **Modelled** | A reply leaves by the port the request arrived on, not the port that owns the address. The second half matters as much as the first: a router that accepts the packet and replies into an uncabled port has answered and still looks dead to the host. A tagged subinterface is the exception and sends the reply tagged. | `engine/simulator.js` `_handleLocalIp` |
| **Modelled** | An echo to an address the box holds is answered by its own stack: the request is never built into a frame, so nothing ARPs for the box's own address and the modelled round trip is the empty path's (`0.000 ms`). RFC 1812 §5.2.3 makes local delivery the rule when the destination "exactly matches one of the router's IP addresses", and §4.3.3.6 requires the echo server to answer it. `holdsIp()` only names an enabled port, so an address on a disabled one still fails the routing way. | `engine/simulator.js` `_sendIcmp`, `_sendIcmp6`; `engine/device.js` `holdsIp` |
| **Modelled** | The interface-scoped rules still outrank stack ownership: WAN/LAN role separation, L2 VLAN isolation, bridge-group membership. | `engine/device.js` |

### 3.2 ARP

| Verdict | Behaviour | Where |
|---|---|---|
| **Modelled** | ARP request floods the VLAN; only the owner replies, out of the port that asked (or the subinterface that owns the address). | `engine/simulator.js:2003-2029` |
| **Modelled** | Replies populate the cache, and pending packets for that next hop are flushed in order. | `engine/simulator.js:2027` |
| **Modelled** | A request for an address nobody owns is simply unanswered, so the ping times out — the correct symptom, arrived at honestly. | — |
| **Modelled** | A reply stamps the entry with the instant it was heard. Past `ARP_AGE_MS` (4 h, the IOS default `arp timeout`) the lookup answers nothing, so the frame is ARP'd for instead of being sent to a neighbour that has moved, and the entry is swept from the cache and from the port it was learned on. Using an entry does not reset its age: a cache hit is not hearing from the neighbour. | `engine/device.js` `arpLookup()`, `ageArps()`, `learnArp()` |
| **Absent** | Gratuitous ARP, proxy ARP (it is *not* one default: on by default on the IOS/IOS XE enterprise families, off on NX-OS and IOS XR, and flipped off on the IE3x00 at 26.2.1 - [research/proxy-arp-default.md](../research/proxy-arp-default.md)), ARP inspection (DAI), static ARP entries, duplicate-address detection. | — |

### 3.3 ICMP

| Verdict | Behaviour | Where |
|---|---|---|
| **Modelled** | Echo request → echo reply, with sequence numbers, per-reply success and a computed round trip. | `engine/simulator.js:2031-2090` |
| **Modelled** | TTL starts at 64, decrements per router, and an expiry sends **ICMP type 11 (time exceeded, code 0)** back to the sender from the router's address on the ingress side. | `engine/simulator.js` `_forwardL3`, `_icmpErrorTo` |
| **Modelled** | A router with no route to the destination sends **ICMP type 3 (destination unreachable, code 0)** instead of dropping silently. | `engine/simulator.js` `_icmpErrorTo` |
| **Modelled** | An ICMP error is never sent about an ICMP error, and never to a broadcast source — the guard that stops a routing loop becoming a packet storm. | `engine/simulator.js` `_icmpErrorTo` |
| **Modelled** | `traceroute <ip>` from the CLI, and `Simulator.traceroute()`: three probes at each of TTL-1, TTL-2, …; each hop that expires one answers, the destination answers with an echo reply, and every hop prints a round trip per probe in `msec` (the outbound legs are the echo request's and the return legs the reply's — an ICMP error carries the original sequence number but its own id, so the two halves are measured separately); a silent hop prints `*  *  *` with the reason the drop recorded. A probe stopped by a down cable, a shut port, a denying ACL or a VLAN the port is not allowed on — `FINAL_DROP` — ends the walk at that hop instead of repeating the star to the 30-hop ceiling; a hop that is merely silent (no ARP reply yet, a lab still converging) is printed and the walk continues. A probe refused with an ICMP destination-unreachable prints the letter for its code in that probe's column (`!N` network, `!H` host, `!P` protocol, `!U` port, `!A` administratively prohibited, `?` unnamed), one letter per probe, and the refusal stops the trace rather than being reported as a timeout, as a real one does. | `engine/cli.js` `_traceroute`, `engine/simulator.js` `traceroute` / `_traceProbe`, `FINAL_DROP` |
| **Absent** | **Redirect, parameter-problem, source-quench, timestamp**, and ICMP fragmentation-needed for path-MTU discovery. | `engine/net.js` |

### 3.4 Routing and administrative distance

**Modelled** — `Device.routeTo()` (`engine/device.js:1033`), in this order:

1. Connected subnets (AD 0).
2. Static routes from `ip route` (AD 1).
3. BGP-learned routes (eBGP 20, iBGP 200) — the `bgpRoutes` loop, `engine/device.js:1073-1090`.
4. OSPF-learned routes (AD 110) — the `ospfRoutes` loop, `engine/device.js:1092-1107`.
5. A default route handed out by DHCP to a box that routes (AD 254).
6. `ip default-gateway` (AD 254) — only when nothing else matched, and only on a box that does not route:
   the command is scoped to "when IP routing is disabled", so its line stays in `show running-config` while
   `ip routing` is on and steers nothing (`research/ip-default-gateway-when-routing.md`).

Longest prefix always wins; equal-length prefixes are broken by lower
administrative distance. That ordering is the documented Cisco one, and it is
enforced by a single comparator (`better(prefix, ad)` at `engine/device.js:1036`)
rather than by the order the loops run in — so a `/24` static really does lose to
a `/25` connected route regardless of list order.

**Approximate**

- The default gateway is consulted only when **no** route matched, instead of
  competing as a `0.0.0.0/0` route at AD 254. The practical difference shows up
  only if you configure both a default gateway and a `0.0.0.0/0` static route
  with a higher AD than 254.
- No route recursion: a next hop must resolve on a directly connected subnet
  (`Device.egressFor`, `engine/device.js:1207`), so a static route pointing at a
  next hop that is itself only reachable via another route will drop.
- No ECMP. One best route, one egress port.

**Absent**

- Route redistribution in any direction (connected ↔ OSPF ↔ BGP). Each protocol
  originates only its own source of truth: OSPF from configured OSPF
  interfaces, BGP from connected prefixes (`computeBgp()`, `engine/simulator.js:1725-1738`).
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
| **Modelled** | Static IPv6 routes and an IPv6 default gateway, longest prefix wins. | `engine/device.js:1185-1210` (`route6To()`), `engine/cli.js:3277` (`_ipv6Route()`) |
| **Approximate** | IPv6 route selection has **no administrative distance**: connected is installed first and only a strictly longer static prefix displaces it, so there is no OSPFv3/BGP-v6 to rank. | `engine/device.js:1189-1200` |
| **Absent** | ICMPv6 errors (time exceeded, destination unreachable, packet too big), fragmentation, OSPFv3, MP-BGP for IPv6, IPv6 ACLs (see [§5.3](#53-acls)), IPv6 NAT. | — |

---

## 5. Control plane

### 5.1 DHCP — **in the data path** (since #1051)

| Verdict | Behaviour | Where |
|---|---|---|
| **Modelled** | A complete DHCPv4 model: pool normalisation, validation, DISCOVER→OFFER, REQUEST→ACK/NAK, renewals, reservations, exclusions, lease expiry — all pure and deterministic. | `engine/dhcp.js` |
| **Wired** | `Simulator.computeDhcp()` runs before the first packet of a run: every interface with `ip address dhcp` sends a DISCOVER into its broadcast domain, a server whose own interface sits in a pool's subnet answers, and the lease is installed on the interface (address, mask, gateway, DNS, lease time). | `engine/simulator.js` `computeDhcp()` |
| **Broadcast domain** | Walked rather than assumed: bridges pass the DISCOVER on, routers stop it, a spanning-tree blocked port passes nothing, and a VLAN boundary is a boundary. | `engine/segment.ts` |
| **In the timeline** | The exchange is an event, so a lab can see the ACK and read the pool it came from. | `{ type: 'dhcp', phase: 'ack', ip, pool, serverIp, leaseSec }` |
| **In the CLI** | `ip dhcp pool <name>` with `network`, `default-router`, `dns-server`, `range`, `excluded-address`, `lease`, `host` (reservation, address and MAC in either order). The pool is validated once, on leaving the sub-mode — a half-typed pool is not an error. | `engine/cli.js` `_dhcpPoolMode()` |
| **Reported** | `show ip dhcp binding [<address\|mac>]` and `show ip dhcp pool [<name>]` read the server's own allocation table (`Simulator.dhcpBindings()` → `dhcp.leaseTable()`), so the console and the engine cannot disagree about who holds an address. Expiry is applied at the instant asked (`expireLeases()`), so a lapsed lease frees its address instead of holding it for the life of the run. | `engine/cli.js` `_showDhcp()`, `engine/simulator.js` `dhcpBindings()` |

The failures are the ones a real server produces, and each is distinguishable:

| Reason | Meaning |
|---|---|
| `no-server` | nothing in this broadcast domain holds a pool |
| `no-pool` | a server is present, but its own address is in none of its pools |
| `pool-exhausted` | every address in range is leased, reserved or excluded |
| `nak` | the server refused to acknowledge the offered address |

A run asked at an instant before the exchange completes (1000 ms by default) leaves the host
unaddressed and the ping reports `converging` — see [CONVERGENCE.md](CONVERGENCE.md).

Also absent: DHCP relay (a DISCOVER does not cross a router — a lab with a central server and a
remote subnet will not work, by design rather than by accident), Option 82, vendor classes, DHCP
snooping, lease expiry during a run (leases are computed at run start, not aged), and any DHCPv6
(which SLAAC's M-flag tells the host to go and use — and which does not exist).

### 5.2 NAT / PAT

| Verdict | Behaviour | Where |
|---|---|---|
| **Modelled** | Static one-to-one, dynamic pool, and PAT/overload, in both directions, with ageing in simulated steps. | `engine/nat.js:676`, `engine/nat.js:710` |
| **Modelled** | Wired into the forwarding path: inbound rewrite **before** the local-address test, outbound rewrite **before** the routing decision — the order a real box works in. | `engine/simulator.js:1882`, `engine/simulator.js:1978` |
| **Modelled** | Port forwarding on a static rule. | `engine/nat.js:26-27` |
| **Approximate** | Translation keys on the 5-tuple and a caller-supplied step; there are no real timers, so translations age only if the caller advances `step`. | `engine/nat.js:54` |
| **Modelled** | ICMP is translated too. The guard used to read `frame.l4`, which an ICMP echo does not have, so a ping crossed a NAT router untouched and the first test anybody runs reported the model as broken. The packet view now comes from `frame.icmp` when there is no `l4`, and only the address is rewritten (an echo is identified by its id, not a port). | `engine/simulator.js:_natPacket` |
| **Modelled in the CLI** | `ip nat pool`, `ip nat inside source static … [tcp|udp <port>]`, `ip nat inside source list <spec> pool <name> [overload]`, `ip nat inside source list <spec> interface <if> [overload]`, and the `no` forms. Rules are validated by `nat.js`'s own `validateRule()`, so the console and the data path cannot disagree about what a rule means. `show ip nat rules`, `show ip nat translations` and `show ip nat statistics` report from the engine's own table. | `engine/cli.js:_natConfig` |
| **Modelled** | Inside and outside are per-port facts (`ip nat inside` / `ip nat outside`), and a translation only happens across that boundary. Before they existed the "out" half of the translation ran before the route lookup, so a rule for a private range also rewrote traffic between two hosts on the private side. A board with no port declared keeps the older "any port" behaviour, and `show ip nat statistics` names which rule is in force. | `engine/simulator.js:_natMayTranslate`, `engine/cli.js:_setNatRole` |
| **Modelled** | Translations age out after their protocol's idle timeout (ICMP 60 s, UDP 300 s, TCP 86400 s, other 86400 s, and a UDP entry to the DNS ALG port 53 - a port-translated entry - 60 s), overridable in `config.nat.timeouts`. `expireTranslations()` existed from the start and nothing called it, so a dynamic or PAT entry was in force for the life of the run: a two-address pool stayed exhausted by connections that had ended, and the translation table listed entries past their timeout. | `engine/simulator.js:_natTableOf`, `engine/nat.js:expireTranslations` |
| **Absent** | ALGs (FTP/SIP/H.323), NAT64/NPTv6, hairpinning, twice-NAT, ICMP error translation. | — |

### 5.3 ACLs

| Verdict | Behaviour | Where |
|---|---|---|
| **Modelled** | Standard (1–99, 1300–1999) and extended (100–199, 2000–2699) lists, wildcard masks, `host`/`any`, `eq`/`gt`/`lt`, service names. | `engine/acl.js:11-26` |
| **Modelled** | First match wins; falling off the end is the **implicit deny**, marked `implicit: true` so a tool can say why. | `engine/acl.js:443-451` |
| **Modelled** | Bound per interface and direction (`ip access-group`), evaluated inbound after learning — on the port and, where one is bound, on the VLAN interface the frame lands on — and outbound on the interface the frame leaves by: the subinterface when a list is bound there, the physical port it rides otherwise (#1517). | `engine/cli.js:4473-4524` (`_accessGroup()`), `engine/simulator.js:2968-2988` (`_aclCheck()`), `engine/simulator.js:3197-3198` (out) and `engine/simulator.js:3449` and `:3459` (in: the port, then the VLAN interface) |
| **Modelled** | Per-rule match counters: each evaluation tallies the line that matched, and the implicit deny separately, so `show access-lists` can name the rule that is doing the denying. A rule that matched nothing prints no count, and a list never tested says so rather than showing zeros (#1267). The implicit deny's own tally is never printed, because a box counts explicit denies only (research/acl-implicit-deny-counter.md). | `engine/simulator.js:2996-3025` (`_countAclHit()`), `engine/cli.js:7080-7139` |
| **Approximate** | Extended rules can match protocol and ports, but only the fields the engine carries: src/dst IP, protocol, src/dst port. No flags, no ICMP type/code, no TOS, no fragments. | `engine/simulator.js:2974-2980` |
| **Approximate** | ACLs are **IPv4-only**: anything that is not `0x0800` with an `ip` header passes untouched, including all ARP and all IPv6. | `engine/simulator.js:2971` |
| **Absent** | Any state. No `established`, no reflexive ACLs, no CBAC/zone-based policy, no connection table consultation — each packet is judged alone. No logging, no time-ranges, no IPv6 ACLs, no VTY/SNMP ACLs. | — |
| **Absent** | The `firewall` capability does nothing. 64 firewall models are catalogued, and 753 of the 2,358 device specs declare the capability; the engine never reads it. A firewall is a router with ACLs you configure by hand. | `engine/device.js:151-160` |

### 5.3b Link state — **in the data path** (since #1057)

`Link` has carried `state: 'up' | 'down' | 'blocked'` since the physical layer was built, and until
now nothing in the engine read it. A cable marked down still carried every frame, still cost what it
cost in the spanning tree, and was still walked by the DHCP segment search: the field was
decoration, and a lab could show a cut link passing traffic.

| Verdict | Behaviour | Where |
|---|---|---|
| **Enforced** | A frame crossing a down link is dropped with `reason: 'link down'` and the link id. | `Simulator._run()` dequeue |
| **In the tree** | A port whose cable is down is not a bridge port, so a redundant topology heals around the failure. | `Simulator.computeStp()` |
| **In the segment walk** | DHCP will not offer a lease across a cut cable. | `engine/segment.ts` |
| **Flushed** | A topology change empties every bridge MAC table — a stale entry is how a real network black-holes. | `Simulator.setLinkState()` |
| **Re-based** | The convergence schedule restarts from the instant of the change. | `engine/convergence.js` `fromMs` |
| **In the drawing** | A down cable is dashed and red, and carries `data-link-state` for anything that wants to know. | `web/canvas.js` |

Not modelled: degraded links (no CRC errors, no flapping), autonegotiation on recovery, interface
self-test failures, and RSTP fast convergence. See [LINK-STATE.md](LINK-STATE.md).

### 5.4 VRRP — **in the data path** (since #1052)

| Verdict | Behaviour | Where |
|---|---|---|
| **Modelled** | Group maths, master/backup election by priority then highest interface address, address-owner priority 255, virtual MAC formation, advertisement/skew/master-down arithmetic. | `engine/vrrp.js` |
| **Wired** | `Simulator.computeVrrp()` elects once per (broadcast domain, vrid) before the first packet. The winner claims the group's addresses and `ownsIpOn()` serves them, so ARP and ICMP for the VIP are answered locally instead of being forwarded and dying at TTL 1. | `engine/simulator.js` |
| **Virtual MAC on the wire** | The master answers ARP for the VIP with `00:00:5E:00:01:<vrid>`, not its own, and accepts frames addressed to that MAC although no port owns it. Without both halves a host resolves the gateway and still cannot reach it. | `Device.macForIp()`, `Simulator._processFrame()` (the `dev.vrrpClaims` match) |
| **Gratuitous ARP on takeover** | The new master announces every virtual address in a broadcast ARP, which re-points the switches' MAC tables. Not decoration: without it the old master's port keeps receiving the traffic and black-holes it. | `Simulator._sendGratuitousArp()` |
| **Failover** | A master whose interface goes down relinquishes (it is no longer a candidate), and the backup takes the VIP with the same virtual MAC — the host never relearns. | `test/vrrp-in-path.test.js` |
| **In the CLI** | `vrrp <vrid> ip <address>`, `priority`, `preempt` (always on - see [CLI.md](CLI.md#vrrp-first-hop-redundancy)), `advertise`, plus `show vrrp` reporting Master/Backup/Init, the elected master's address, the virtual IP and the virtual MAC. A group belongs to an interface, so the command is refused outside one, and the virtual address must be in that interface's subnet — a gateway address is only a gateway for its own wire (#1245). The election applies the same rule, so a restored group that could not be served is reported as `Init` rather than `Backup`. | `engine/cli.js` `engine/simulator.js` |

Absent: VRRPv3, IPv6 virtual addresses, authentication beyond storing the text, and any detection of
lost advertisements — a master is displaced only by losing its interface, never by going quiet.
HSRP and GLBP do not exist.

### 5.5 OSPF

| Verdict | Behaviour | Where |
|---|---|---|
| **Modelled** | Adjacency graph from live links, Dijkstra SPF, code `O` routes installed at AD 110, next hop resolved to a directly connected neighbour. | `engine/simulator.js:397-493`, `engine/ospf.js:467` |
| **Modelled** | Areas: one area per link, an interface area overrides the router area (the ABR pattern), and a link is only usable when both ends agree on the area. | `engine/ospf.js:10-21`, `engine/ospf.js:363` |
| **Modelled** | Per-interface cost overrides, and interface cost otherwise derived from link rate against a 100 Mbps reference. | `engine/simulator.js:352`, `engine/simulator.js:380` |
| **Approximate** | No protocol state at all: no hellos, no dead timer, no LSAs, no adjacency FSM. The role beside a neighbour in `show ip ospf neighbour` is derived rather than elected, but it is derived for the **segment**: every OSPF speaker reachable through the L2 fabric takes part (`segmentOf()`, the walk DHCP uses), so three routers on one access switch elect one DR and one BDR (highest configured priority, then highest router ID, RFC 2328 9.4), the routers that are neither read `FULL/DR` and `FULL/BDR` beside their neighbours and `2WAY/DROTHER` beside each other, and a serial port — point-to-point, where nobody stands — reads `FULL/ -`. `ip ospf priority <0-255>` is modelled and printed in both views; a port at 0 is ineligible and the other end takes the DR alone, and with both ends at 0 there is no DR — a real pair stops at `2WAY/DROTHER`, so the link is refused rather than printed as FULL. The election has no stickiness — a new higher-priority router takes the DR immediately, where a box keeps the incumbent until it goes away — and there is no wait timer. The SPT is recomputed from scratch at the instant the question is asked at, and what it computes is not in the table until the timers have run: hello (10 s) plus the DBD/LSDB exchange plus the SPF hold is 16 s on the defaults, and until then `show ip ospf` reads `routes withheld: still converging` and a ping to a route it would have installed answers `Still converging: ospf on … (ready at 16000 ms)` instead of counting five lost echoes. The countdown beside a neighbour is recomputed from the instant asked about, not run: no hello is ever lost and no dead interval ever expires. | `engine/ospf.js:1-9`, `engine/simulator.js` `computeOspf()` |
| **Approximate** | Link metric is a fixed 10 in the simulator's link list; per-interface costs enter through the graph builder. | `engine/simulator.js:441` |
| **Absent** | Area types (stub/NSSA), virtual links, ABR/ASBR route leaking, authentication, graceful restart, OSPFv3, redistribution. | — |

Three OSPF defects were found here — [#42, #43, #44](#10-fixed-defects-kept-visible) — and all three are
**fixed**; a lab saved before the fix may still route differently, which is why [§10](#10-fixed-defects-kept-visible) keeps them.

### 5.6 BGP

| Verdict | Behaviour | Where |
|---|---|---|
| **Modelled** | A session forms only when **both** sides list the other as a neighbour with a matching remote-as. Half a peering is not a peering. | `engine/simulator.js:1810-1889` |
| **Modelled** | Advertisement runs to convergence in rounds (max 12) before the first packet, originating every connected prefix. | `engine/simulator.js:1989-2040` |
| **Modelled** | Split horizon: a route is never advertised back to the peer it was learned from. | `engine/simulator.js:1998` |
| **Modelled** | Best path: weight, local-preference, locally originated, shortest AS path, lowest origin, lowest MED, eBGP over iBGP, lowest router ID — in that order. | `engine/bgp.js:526-559` |
| **Modelled** | AS-path loop prevention including AS_SET members; 4-byte ASNs; eBGP prepend, iBGP no-prepend. | `engine/bgp.js:308`, `engine/bgp.js:503` |
| **Modelled** | Administrative distance 20 for eBGP, 200 for iBGP, installed into the routing table. | `engine/simulator.js:2016` |
| **Approximate** | MED is compared only between paths learned from the same neighbouring AS - `neighbourAs()` reads the leftmost AS of the AS_PATH, and `medComparable()` skips the comparison only when both paths name one and the two differ, as RFC 4271 9.1.2.2(c) requires. `bgp always-compare-med` and `bgp deterministic-med` are not modelled, and `bestPath()` sorts rather than eliminating, which only matters with three or more candidates. | `engine/bgp.js:18-20`, `engine/bgp.js:488-509` |
| **Approximate** | The FSM exists (`idle→connect→active→opensent→openconfirm→established`) but is never fed: hold/keepalive timers are validated and carried, never expire, and no session ever drops. | `engine/bgp.js:14-21`, `engine/bgp.js:220-266` |
| **Approximate** | Next hop is rewritten to the advertising router's address on every advertisement, which is right for eBGP and wrong for an iBGP relay — see defect #41. | `engine/simulator.js:2009` |
| **Absent** | Route reflectors, confederations, peer groups/templates, AFI/SAFI negotiation, IPv6 unicast, communities, route-maps, prefix-lists, `next-hop-self`, dampening, graceful restart. | — |
| **Absent in the CLI** | `router bgp`, `neighbor … remote-as`, `router-id` only. | `engine/cli.js:2193` (`router bgp`), `engine/cli.js:3752` (`_bgp()`), `engine/cli.js:3789` (`as`) and `engine/cli.js:3815-3825` (`neighbor ... remote-as`) |

All three pointers in that last row were re-read off this tree (#2399, #2406). The row cited
`engine/cli.js:1933-1934`, `:3200` and `:3234-3243`, which is where they sat when `eb5159fd` measured them; #2399
inserted 36 lines above the `router bgp` door and #2406 a further 35 above `_bgp()`, so `1901` now falls inside the
`no dns zone` handler and `3168`/`3202` inside `_ipv6Nd()`'s prefix parser - a reader following either learned how a
zone is deleted, or how a router-advertisement lifetime is validated, not what BGP commands this console has.
They were read a third time on this tree (`89c0c818`), where they sat at 1944, 3246 and 3279 — 7, 7 and 6
lines below the numbers the first re-read recorded — and a fourth time once the console had grown again, at 2009,
3361 and 3394, which was 65, 115 and 115 lines below the third reading. A fifth reading was needed after #2532 and
#2537 grew the console again: they now sit at 2052, 3404 and 3438, which is 43, 43 and 44 lines below the fourth,
and is why the row above carries these figures. The fourth reading had rotted into the same three places: `2009`
falls inside the `no dns zone` handler, `3361` inside `_ipv6Nd()`'s lifetime parser and `3394` inside
`_ipv6Route()`. That fourth pass had also re-read the two `engine/simulator.js` pointers in the rows above, which had
fallen inside `ping()`'s own convergence preamble: the next-hop rewrite is at 2009 and the eBGP/iBGP distance at
2016, with split horizon at 1998 and the advertisement rounds at 1989-2040.

`docs/BGP-POLICY.md` is a **design document**, not a description of the code:
its tables read "Today … This design changes it to" (`docs/BGP-POLICY.md:39-50`)
and route-maps/communities are §8 and §5 of a proposal. None of that policy
layer exists in `engine/bgp.js` today.

### 5.7 DNS

| Verdict | Behaviour | Where |
|---|---|---|
| **Modelled** | Authoritative zones with A, AAAA, CNAME, MX, NS, PTR, SOA, TXT, SRV; relative/absolute name rules; CNAME chains to depth 8; NXDOMAIN distinguished from empty-NOERROR. | `engine/dns.js:47-50`, `engine/dns.js:342` |
| **Modelled** | `ping <hostname>` resolves through the lab's DNS servers before a single packet is sent. The failure is named for what actually happened: `dns-nxdomain` (the name is not in the zone), `dns-nodata` (the name exists, the type does not — NOERROR with an empty answer), `dns-servfail` (no device in the lab hosts a zone). `openFlow()` does **not** resolve a name: it takes a destination device or an address, and `POST /flows` refuses a body without a `dstDevice`, so a flow never carries a hostname to look up. | `resolveName()` at `engine/simulator.js:292`, called at `engine/simulator.js:637` before the first frame; the three statuses at `engine/simulator.js:347-369`, and `openFlow()` at `engine/simulator.js:4207` |
| **Approximate** | Server selection is a shortcut: the client's configured `dnsServers`, or — when it lists none — **any** device in the lab that hosts a matching zone. There is no recursive walk from root to TLD, no delegation, no forwarder. | `engine/simulator.js:292-307` |
| **Reported** | `show ip dns [zone [<name>]]` prints the zones this device answers for, record by record, with each record's TTL; a zone the server would refuse to answer for says `NOT answered: <reason>` instead of appearing live. `ping <name>` prints the translation and the server that answered, and refuses before sending when the resolver failed — naming `NXDOMAIN`, `NODATA` or `SERVFAIL`, which have different causes. | `engine/cli.js` `_showDns()`, `_ping()` |
| **Absent** | Recursion to a real resolver, DNSSEC, zone transfers, EDNS(0), negative caching, DNS over TCP. A resolver is only a listener on port 53 for flow purposes (`engine/flow.js:316`). | — |

### 5.8 SCION

| Verdict | Behaviour | Where |
|---|---|---|
| **Modelled** | ISD-AS identifiers, core-AS rule (hex id ending `:0`), UP/CORE/DOWN path segments, beaconing from core ASes over real adjacencies, path composition enforced by allowed shapes, selection by hop count or by latency. | `engine/scion.js:777`, `engine/scion.js:563`, `engine/scion.js:654` |
| **Modelled** | Deterministic: no clocks, no randomness, every list sorted, so the same topology always selects the same path. | `engine/scion.js:24-28` |
| **Approximate** | Path latency is the sum of per-segment `latencyMs`, defaulting to **1 ms per hop** when a segment states nothing. It is not measured from the links. | `engine/scion.js:55`, `engine/scion.js:415`, `engine/scion.js:534` |
| **Absent — important** | `pingScion()` walks the AS list and emits `scion-hop` events; **it does not put IP frames on the wire**, does not consult the routing table, and does not model the SCION header on real hardware. It answers "is there a beaconed path, and which one wins", not "does a packet traverse it". | `engine/simulator.js:2407`, `engine/scion.js:5-18` |
| **Absent** | Trust roots and certificates, DRKey, beacon service/store persistence, path revocation, peering vs. provider/customer policy, hidden paths. | — |

### 5.9 LLDP

| Verdict | Behaviour | Where |
|---|---|---|
| **Modelled** | One LLDPDU per cabled port at the start of each run; the receiver stores a neighbour record keyed by port. | `engine/simulator.js:2696-2709` (`announceLldp()`, called from the run, `ping` and `openFlow()` setup), `engine/simulator.js:3544-3560` |
| **Modelled** | Terminated at the nearest bridge and **never flooded**, so the simulator cannot invent neighbours two switches away. | `engine/simulator.js:3539-3562`, `engine/lldp.js:10-12` |
| **Approximate** | No transmit timer: one announcement per run, not every 30 s. The record carries its TTL (120 s by default) and the device notes the instant it was heard (`lldpSeenAt`, runtime state, not part of the record a save writes), and `lldpRows(topo, nowMs)` drops it once that TTL has lapsed at the instant the session asks at, so a neighbour that stops announcing does age out; but nothing re-announces between runs, so a live neighbour is only as fresh as the last run that announced it, and a record heard with no clock is never aged. A received TTL of 0 drops the entry immediately. | `engine/lldp.js:15`, `engine/device.js` `lldpRows()` |
| **Absent** | LLDP-MED, DCBX, CDP, per-TLV config, shutdown-on-neighbour. | — |

---

## 6. Physical layer

### 6.1 Cages, media and mating

| Verdict | Behaviour | Where |
|---|---|---|
| **Modelled** | 28 cages and 90 media across ten families (copper, `fiber`, `fibre-channel`, dac, coax, dsl, powerline, serial, console, wireless). Count them with `node -e "console.log(Object.keys(require('./engine/media').MEDIA).length)"`, and the same line with `CAGE_MEDIA` for the cages. | `engine/media.js:75`, `engine/media.js:549` |
| **Modelled** | Port hardware is derived from a terse spec (`{name, type, speed}` → cage, media, speed caps, PoE in/out). | `engine/media.js:958-1137` `derivePortHardware()` |
| **Modelled** | An unrecognised cage is reported as unknown — no silent fallback to RJ45 and no fake media set. | `engine/media.js:1002-1013` (the `known` verdict in `derivePortHardware()`) |
| **Modelled** | The three-test mating rule: cages mate → shared medium → common speed. | `engine/media.js:1397` `canMate()`, whose three gates are `cagesMate()` `engine/media.js:518`, `commonMedia()` `engine/media.js:1252` and `negotiateSpeed()` `engine/media.js:1306` |
| **Modelled** | Combo RJ45/SFP ports expose the union of both halves; QSFP-DD accepts QSFP28/QSFP+ modules and negotiates down. | `engine/media.js:570-575` `CAGE_MEDIA.combo`, `engine/media.js:637-641` `CAGE_MEDIA.qsfpdd` |
| **Modelled** | Preferred medium when several are valid: fiber/DAC over copper SFP, then highest speed. | `engine/media.js:1537-1575` `preferredMedia()` |

### 6.2 Speed negotiation and downshift

| Verdict | Behaviour | Where |
|---|---|---|
| **Modelled** | Wired links run at the highest **common** rate, then clamped to what the chosen medium can carry. | `engine/media.js:1332-1338` `negotiateSpeed()`, `engine/validation.js:732-740` |
| **Modelled** | A 10G SFP+ cabled to a 1G SFP negotiates 1000BASE-X at 1 Gbps — correct, because the cage accepts a 1G optic. | `engine/media.js:589-593` (the SFP+ medium list), `engine/media.js:739` (its rate ladder) |
| **Modelled** | `W_SPEED_DOWNGRADE` warns when the link runs below **either** port's maximum — both ends (two 10G cages with a 1G module), or one end against a slower peer (10G RJ45 into 1G RJ45 negotiates 1000). A link running at an installed module's own rate is exempt, because the part was chosen. | `engine/validation.js:904-949` |
| **Modelled** | `E_NO_COMMON_SPEED` blocks a pair with no shared rate. | `engine/media.js:1511-1516` `canMate()` |
| **Approximate** | A radio association deliberately does **not** require an exact match: the client takes the best rate both sides and the band can sustain. | `engine/media.js:1315-1331` `negotiateSpeed()` |
| **Modelled** | A port's rate and duplex are pinnable from the console — `speed auto\|<mbps>` (`speed 100`, `speed 1G`; a rate the catalogue ladder has not got is refused, naming what the port does support) and `duplex auto\|full\|half` — and the write goes back through the same mating rule, so a forced rate no peer shares takes the link down instead of being ignored. `W_DUPLEX_MISMATCH` becomes reachable once one end is forced to half. | `engine/cli.js:3104-3129` (the dispatch branches), `engine/cli.js:3821` `_speed()`, `engine/cli.js:3921` `_duplex()`; the link is re-judged by `engine/topology.js:420-448` `renegotiate()` |
| **Absent** | Autonegotiation as a process (no FLP bursts, no parallel detection), half-duplex collisions, duplex mismatch as anything but a warning. | `engine/validation.js:891-902` |

### 6.3 PoE

| Verdict | Behaviour | Where |
|---|---|---|
| **Modelled** | Per-port PSE/PD wattage, derived from the spec or inferred (802.3af 15.4 W out / 12.95 W in defaults). The inference reads the port's own name first, then the device's model and label - and a label that denies PoE ("... no PoE") is a denial, not a claim: the three EnGenius non-PoE rows (ECS1528, ECS2512, ECS5512) source nothing, as the vendor's model-comparison table prints "PoE Capable Ports: -" and "Total PoE Budget: -" for each ([EnGenius model comparison](https://www.engeniustech.com/eu/products/network-switches/ecs2512fp/)). | `engine/media.js:1139-1172` `isPoePse()` |
| **Modelled** | Device-level budget, read from the spec or parsed out of the model string (`"… PoE+ 370W"`). | `engine/device.js:218-230` (spec, research, unknown, then the name), `engine/media.js:1579-1585` `parsePoeBudget()` |
| **Modelled** | Budget is allocated before the run; a port that cannot be funded marks its peer `poeUnpowered`, and that device then neither transmits nor receives (`poe-deny` events both ways). | `engine/simulator.js:2711-2775` `computePoe()` (the denial is emitted at `2760`), the transmit gate in `_emitFrame()` `engine/simulator.js:3213-3219`, the receive gate in `_processFrame()` `engine/simulator.js:3519-3524` |
| **Modelled** | Cable-time check: `E_POE_BUDGET` refuses a link that would over-subscribe the PSE; `W_POE_DRAW` warns about a powered device on a port that cannot supply power. | `engine/validation.js:823-841`, `engine/validation.js:973-987` |
| **Modelled** | Allocation order is **port order** - numeric, not string order - so the ports left dark are the highest-numbered ones. That is the one ordering Cisco states (power is granted "in ascending order of the port numbers" and denied "in descending order of the port numbers", [research/poe-allocation-order.md](../research/poe-allocation-order.md)). Budgets are accounted in milliwatts, so a budget exactly equal to the draw of N ports funds all N. | `engine/simulator.js` `computePoe()`, `engine/iface-name.js` `comparePortNames()` |
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
| **Modelled** | Length is a property of the lead (`Link.lengthM`), not a maximum reach; null means "not stated". | `engine/link.ts:137`, `engine/link.ts:169` |
| **Modelled** | `W_DISTANCE` fires only when a length **and** a medium reach are both known. An unstated length produces no warning rather than an invented one. | `engine/validation.js:870-879` (the check), `engine/validation.js:157` (its code entry) |
| **Modelled** | `W_COPPER_LONGRUN` at 90 m for the horizontal-run limit. | `engine/validation.js:881-889` (the check), `engine/validation.js:207` (`COPPER_RUN_LIMIT_M = 90`), `engine/validation.js:173` (its code entry) |
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
| **Modelled** | Five radio media: 2.4 GHz, 5 GHz, 6 GHz (Wi-Fi 6E), 6 GHz (Wi-Fi 7), 60 GHz (802.11ad). | `engine/media.js:272-276` (the `MEDIA` wireless block: `wireless-2.4` through `wireless-60`) |
| **Modelled** | A radio's band set follows its **generation**, which follows its rate (n/ac/ax/be), unless the spec states bands explicitly. A Wi-Fi 5 radio is 2.4+5. | `engine/media.js:921-925` (`WIRELESS_GENERATIONS`), `engine/media.js:938-943` (`generationBands()`), `engine/media.js:945-948` (`wirelessBands()` - an explicit `bands`/`band` wins first) |
| **Modelled** | 60 GHz is a different radio, not a faster one: it is selected from the model text (`60 GHz`, `802.11ad`, `WiGig`), never from a high rate. | `engine/media.js:950-955` (`wirelessBands()`, the model-text test at `:953`) |
| **Modelled** | Association = the best shared band caps the rate, so a 2.5 Gbps phone on a 574 Mbps 2.4 GHz radio associates at 574 instead of refusing. | `engine/media.js:1315-1331` `negotiateSpeed()` |
| **Modelled** | A radio can never be cabled to a wired port (`E_WIRELESS_TO_WIRED`), and an antenna port is not a cable at all. | `engine/media.js:1397` (`canMate()`), `:1401-1404` (the antenna check), `engine/media.js:709` (`CAGE_MEDIA.antenna` - a radio carries bands, not a cable) |
| **Approximate** | "Wireless" is a link type with an antenna cage. There is no shared medium: two clients on one AP do not contend, do not share airtime, and cannot hear each other. | — |
| **Absent** | SSID, BSSID, beacons, association/auth frames, WPA/PSK/802.1X, channels and width, interference, RSSI, rate adaptation, retries, roaming, mesh, band steering, hidden SSID, MU-MIMO/OFDMA. `grep -rin "ssid\|rssi\|interference\|wpa-" engine/` returns nothing; every `channel` match is LAG vocabulary (`channel-group`, `etherchannel`, `port-channel`) or `Fibre Channel`. | — |

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

1. **There are no wall-clock timers anywhere in the engine.** `grep -n "setTimeout\|setInterval\|Date.now" engine/*.js` finds only comments. The delay is a
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
| "It's a TCP/IP stack." | There is a tiny TCP model — three-way handshake, MSS from path MTU, cumulative ACKs, four-way close — and nothing else: no congestion window, no retransmission timer, no SACK, no TIME_WAIT, no window scaling, no ICMP port-unreachable for stray UDP. | `engine/flow.js:19-24`, `engine/simulator.js:4531` (`openFlow()`) |
| "Traffic starts connections." | Only an explicit API call does. `openFlow()` is invoked by the server on `POST /flows`; no packet ever triggers a connection on its own. | `engine/simulator.js:4531` (`openFlow()`), `server/index.js:1311` |
| "Services respond." | A capability only registers **listeners** — `http-server` means "ports 80 and 443 answer SYN" (`engine/flow.js:77-85`). There is no HTTP request, no TLS handshake, no SSH banner, no FTP, no SMTP. A closed port answers RST, which is the whole application layer. | `engine/simulator.js:4846-4857` (`listensOn()` decides, `resetPacket()` answers) |
| "Congestion happens." | Nothing is ever dropped because of load. There are no queues, no buffers, no contention, no tail drop, no AQM. A link at 100 % of its rate behaves exactly like an idle one. | — |
| "Loss happens." | Nothing is lost except by an explicit rule: VLAN, ACL, STP, PoE, TTL, no route, NAT failure. A cable 10× over its reach still delivers every packet. | — |
| "There are real timers." | Nothing sleeps, nothing interleaves, no thread runs against another — but simulated time is real to the model. A MAC entry ages out after 300 s and an ARP entry after 4 h, measured against the instant a question asks (`MAC_AGE_MS`, `ARP_AGE_MS`); STP, OSPF, the DHCP exchange and the VRRP election finish on a schedule rather than at t=0. See [§8](#8-time-what-rtt-means-and-what-it-does-not) and the convergence section at the end. | `engine/device.js:6`, `engine/device.js:12`, `engine/convergence.js:265` (`buildSchedule()`) |
| "It's a stateful firewall." | ACLs are per-packet, stateless, IPv4-only. The `firewall` capability is inert. | `engine/simulator.js:3295-3309` (every frame through `evaluate()`, and an IPv6 frame returns `permit` before a list is read), `engine/acl.js:455` (`evaluate()`), `test/capability-vocabulary.test.js:45` |
| "Routes redistribute." | They do not. Connected → OSPF and connected → BGP only; no OSPF→BGP, no BGP→OSPF, no static→anything. | `engine/simulator.js:1968-1985` (OSPF installs nothing the connected route already covers), `engine/simulator.js:2287` (BGP originates every connected prefix) |
| "MPLS / VXLAN / GRE / IPsec / LISP / SRv6." | None of them. `grep -rni "mpls\|vxlan" engine/` finds three comment lines in `engine/cli.js:6539-6544` (BGP research notes) and no code. | — |
| "DAI, DHCP snooping, IP Source Guard, RA guard." | None. ARP and ND are trusted completely. | — |
| "IPv6 is first-class." | ND and SLAAC are good; ACLs, NAT, routing protocols and first-hop redundancy are IPv4-only or absent. | `engine/device.js:1231` (`route6To()`: on-link, static, default, and no protocol), `engine/simulator.js:3295` (an ACL is not consulted for an IPv6 frame) |
| "HA exists." | VRRP is in the data path (#1052), so a virtual gateway fails over. Still absent: HSRP/GLBP, BFD, LACP failure detection, graceful restart, and detection of a master that goes quiet rather than down. | `engine/simulator.js` `computeVrrp()` |
| "Multicast is routed." | Multicast floods like broadcast inside a VLAN and is never routed between subnets. No IGMP, no PIM. | `engine/simulator.js:3803-3805` (`isMulticastMac()` folded into `flood`) |
| "QoS exists." | No marking, no queues, no shaping, no policing, no CoS/DSCP anywhere. | — |
| "Counters show errors." | `show interfaces` counters are bytes/packets in and out. No CRC, no runts, no giants, no collisions, no drops-by-reason beyond the event log. | `engine/flow.js:354-360` |
| "A device can be overwhelmed." | There is nothing to overwhelm. Control-plane work now takes the seconds its own timers name — STP 30 s (50 s after an indirect failure), OSPF 16 s to its first route, the DHCP exchange 1 s — but nothing ever competes for a resource: one process cannot starve another, LLDP and RAs cost no steps, BGP’s one advertisement round is still untimed, and 8 000 steps is a loop guard rather than a capacity limit. | `engine/convergence.js:265` (`buildSchedule()`), `engine/simulator.js:210` |
| "A hop is a time." | A step is a frame handed to a port. Latency is computed separately. | `engine/simulator.js:3568-3578` (`_run()`: one queued frame per step), `engine/latency.js` |
| "Config is validated." | Each module validates its own config when asked to; the engine will happily run an inconsistent topology and show you whatever the graph produces. | `engine/validation.js:1-24` |

And a short list of things that exist on the model but are **never read** —
i.e. configuring them is decoration:

- `minLinks` on a LAG (`engine/lag.ts:39`) — normalised and stored, and no verdict consults
  it: a bundle's health is the members that can carry, not this threshold.
- Capabilities `firewall`, `wireless` and `dhcp-client` (`engine/device.js:158-168`). Everything
  else in that vocabulary has a reader: `nat`, `dhcp-server`, `l3-forward` and `l2-forward`
  through `_capabilityRefusal()`, `http-server` through the listener table in
  `engine/flow.js`. The tokens `vlan`/`lacp`/`stp` used to be listed here and are no longer
  capabilities at all (#1526).

Five fields have left this list, each when the code started reading them — and each of them
changed what a lab does, which is why the pointer is here rather than in a changelog:

| Field | What reads it now |
|---|---|
| `Link.state` | a frame crossing a down cable is dropped with `reason: 'link down'` and the link id (`engine/simulator.js:3661`), and the switch logic in `engine/segment.ts` will not carry a frame over one ([LINK-STATE.md](LINK-STATE.md)) |
| LAG `mode` | `negotiationVerdict()` through `memberSuspension()`: two `passive` ends never form a bundle, and neither does a far end in no channel group at all (`test/lacp-passive-both-ends.test.js` + `test/lacp-one-sided-group.test.js`, 54 assertions) |
| `voiceVlan` | `classifyEgress()` and `classifyIngress()` carry it on an access port as one tagged VLAN beside the untagged access VLAN, and ignore it on a trunk (`engine/vlan.js`, #1368) |
| `iface.dhcp` | `Simulator.computeDhcp()` collects every port carrying the flag as a client and applies the lease it is given (`engine/simulator.js:1274`) |
| RA valid/preferred lifetimes | written into the prefix information option the router advertises (`engine/ra.js:283-284`), and read back out of it on arrival |

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
| `README.md`, Features → "Real simulation, not canned animation" | "MAC learning, flooding, ARP, longest-prefix routing, default gateways, TTL decrement and ICMP echo/reply" | Accurate — and that is the whole list. It is a statement of scope, not an understatement. |
| `README.md`, Features → "Physically accurate" | "impossible cables are refused, not drawn" | Accurate and well tested; just remember [§6.6](#66-cable-length) — length is otherwise cosmetic. |
| `docs/ARCHITECTURE.md:61-71` | Routing order: connected, static, default gateway | Right, and incomplete: eBGP (20), OSPF (110) and iBGP (200) sit between static and the default gateway (`engine/device.js`, `routeTo` and `routeDistance`). |
| `docs/ARCHITECTURE.md`, Throughput: two counts, one shape | Flow API and counters | Accurate. |
| `docs/BGP-POLICY.md` | A full policy design — local-pref, MED, communities, route-maps | A design document. Only the decision-order subset in `engine/bgp.js` exists. |

Six rows have left this table since it was written. Two were the README's counts, which now match the
tree — **90** media types across **ten** families and **28** connector cages, and **2,358 models across
258 vendors** in 25 categories:

```bash
node -e "const m=require('./engine/media');const f=new Set(Object.values(m.MEDIA).map(x=>x.family).filter(Boolean));console.log('media',Object.keys(m.MEDIA).length,'cages',Object.keys(m.CAGES).length,'families',f.size)"
node -e "const {loadCatalog}=require('./devices/registry');const s=loadCatalog('./devices').filter(x=>!x.error);console.log('models',s.length,'vendors',new Set(s.map(x=>x.vendor)).size,'categories',new Set(s.map(x=>x.category)).size)"
```

Citing a line number into a README was the wrong shape for that claim as well as the wrong numbers: the
figures move, the command does not. The third row called `ip address dhcp` "(reserved)" — the port becomes
a DHCP client, a static address is displaced and named, and `show running-config` prints the method rather
than the lease, so `docs/CLI.md` documents it with the one-method rule instead.

The fourth said `docs/CLI.md` documented `show`, `interface`, `ip address`, `ip route`, `ping` and IPv6 ND,
and none of the commands behind `access-list`, `ip access-group`, `switchport`, `channel-group`,
`router bgp`/`neighbor`, `ospf`, `dns` or `scion` — that the CLI reference was behind the CLI. All nine
families are in the reference now (its "What the config contains" table gives the printed form of each),
and the gap is no longer invisible: `test/help-completeness.test.js` fails when a mechanism it enumerates
is missing from `help` or from `docs/CLI.md` (nineteen mechanisms today — the guard prints the count it
ran), and
`test/docs-show-commands.test.js` types every `show` form the page prints.

The fifth was the capability table this page was quoting. It called `nat`, `firewall`, `wireless` and
`http-server` "reserved for future protocol support", and listed `dhcp-client` beside `dhcp-server` as
live. `nat` and `http-server` each have a reader in `engine/` — the `ip nat` commands are refused
without the token, and an `http-server` answers on TCP 80 and 443 — while `dhcp-client` has none: a port
becomes a client through `ip address dhcp`, which is a flag on the port, not the capability. The table
now separates the tokens something reads from the three that are only declared, the same three
`test/capability-vocabulary.test.js` lists as pending.

The sixth was `docs/ROADMAP.md`, which listed DHCP, DNS, VLANs, STP, OSPF, ACLs and wireless as unchecked
TODOs and NAT as the only thing that had shipped. Its engine section now states each subsystem's real state -
**Modelled**, **Partial** or **Absent** - with the file behind it and the section of this page that describes
it, so a stale promise and a stale apology cannot both be true again: a row that flips cites a file here.

---

## 12. Things this page cannot tell you

Places where the code does not answer the question, stated rather than guessed:

- Whether `Link.state` was meant to gate forwarding. Nothing reads it, and no
  comment says what `'down'` should do.
- Whether a LAG below `minLinks` was meant to shut the bundle or merely stop
  forwarding.
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
grep -n "computeDhcp()" engine/simulator.js   # DHCP is in the data path (#1051)
grep -n "computeVrrp()" engine/simulator.js   # so is VRRP (#1052)
grep -rn "setTimeout\|setInterval\|Date.now" engine/*.js   # comments only: nothing sleeps on the wall clock
npm test                                 # the suites that pin the behaviour above
```

## Convergence is timed, interleaving is not

Control-plane processes used to finish at t=0, which made "power it on and watch it come up"
impossible to demonstrate. `Simulator.setRunTime(ms)` now asks a question at an instant: processes
that have not finished leave their device in the state the standard puts it in — STP ports
Listening or Learning (and dropping traffic), OSPF without learned routes, no DHCP lease — and a
failed ping reports `converging` with the process and its ready time instead of pretending a packet
was lost.

What is not modelled: real-time interleaving (a question is answered *as of* an instant, computed
from the timers — nothing runs a clock during a run) and hello loss, so no dead interval ever expires.
Re-convergence after a topology change *is* modelled: the schedule is re-based at the instant of the
change, and a bridge that lost the root without losing a port of its own pays the old root’s Max Age
before its ports walk. See [CONVERGENCE.md](CONVERGENCE.md) and [LINK-STATE.md](LINK-STATE.md).
