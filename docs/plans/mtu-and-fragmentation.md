# Plan: the MTU is 1500 everywhere, nothing can set it, and no packet in the lab can be too big

Status: forward plan, no code. Measured on `be18b65d`, 2026-11-19. Closes no open issue — the queue holds one
request (#130, a device) and none of the nine open PRs touches an MTU. Steps 1, 2, 5 and 6 are additive (a
command, a probe, a doc line); steps 3 and 4 change delivery outcomes and are **needs Jay's approval**.

`docs/plans/counter-reset.md` ends by naming this gap as out of scope: *"the MTU/bandwidth header lines a box
prints above the counters (the model holds `this.mtu = 1500` at `engine/device.js:90` and nothing prints or
sets it)"*. That is the plan in one clause. The field exists, one code path reads it, and no operator — in the
console, the UI or a saved file — can move it. So the failure every real network has once, a packet that fits
at the source and not two hops away, cannot be built, seen or taught here.

## What exists today

| fact | evidence |
|---|---|
| every interface carries an MTU, and it is a literal | `this.mtu = 1500;` `engine/device.js:90`. 0 of 2,356 device specs declare one (`find devices -name '*.json' \| wc -l`; a scan for an `mtu` key finds none) |
| the only reader | `Simulator.pathMtu()` `engine/simulator.js:3963-3983` — walks the route, `Math.min(mtu, egress.mtu)`, bounded at 32 hops and by a `seen` set |
| what it changes | MSS: `flowLib.mssForMtu()` `engine/flow.js:111-118`, applied at `engine/simulator.js:4122-4123` |
| the code says there is nothing else | `engine/simulator.js:3922-3924`: *"IP fragmentation — the MSS is derived from the path MTU, so no segment needs to fragment"* |
| the console will not set it | `ip mtu 9000` → `% Unrecognized interface command: ip mtu 9000` on this build; `grep -c mtu engine/cli.js` is 0 |
| and does not print it | `show interfaces Gi0/0` prints status, ip, peer, `speed … duplex`, switchport and counters — no MTU. There is no full `show ip interface`, only `brief` (`engine/cli.js:560-561`) |
| it does not survive a save | the port block of `Device.serialize()` (`engine/device.js:1374`) writes `duplex`, `vlan`, `lagId`, `role`, `bridgeGroup`, the hardware block — no `mtu`. Probe: `mtu = 9000` in memory, `Topology.serialize()` contains no `9000`, `fromJSON()` returns 1500 |
| the one way to get a narrow path today | assigning the field in JavaScript — what `test/flow.test.js:143` does to prove MSS follows the path MTU |
| the probe cannot be sized | `ping` prints a hard-coded `100-byte ICMP Echos` (`engine/cli.js:4175`, `:4203`); `ping 10.0.0.1 size 2000` → `% Unrecognized "size" (ping <address\|name> [<count 1-50>] [at <ms>])` |
| the engine already prices a size nobody sends | `opts.payloadSize` → `latency.pingFrameBits()` (`engine/simulator.js:661`, `:2430`; `engine/latency.js:186`), default 56 bytes (`:120`) — the arithmetic behind the printed 100 |
| a frame carries no length | `ethFrame()` `engine/simulator.js:142-150` returns macs, etherType, ip, icmp, arp, l4, flow, vid; size lives only in `l4.length` (flows) or the latency call (echoes) |
| no frag-needed, in either family | `engine/net.js:155-160` defines 0, 3, 8, 11; `engine/ipv6.js:21-27` defines 128, 129, 133-136 — no Packet Too Big (2), and `grep -c 1280 engine/*.js` is 0 |
| the docs already say so | `docs/SIMULATION.md:251` (*"Fragmentation and reassembly, PMTUD, IP options, jumbo frames"*), `:216` (frag-needed), `:574` (no PMTU black holes), `docs/CLI.md:1089` (the `show vlan` MTU column is 1500 on every row) |
| what is locked by tests | `test/flow.test.js:131-150` pins MSS 1460 on a 1500 path, 960 on a 1000 path; `test/ping-default-count.test.js` (11 occurrences), `test/ping-ipv6.test.js` and `test/ping-round-trip-clause.test.js` pin the `100-byte` sentence verbatim, as do 11 transcript lines in `docs/` |

The only MTU the product prints is a VLAN's, and it is a column literal — honest for a VLAN
(`docs/CLI.md:1089` explains why), silent about a port. That asymmetry is why no test can catch drift: one
number is printed, the other is not.

## What is missing or weak, ranked

1. **No door.** `ip mtu` is not a word, so a lab cannot have a 1400-byte transit and `pathMtu()` only ever
   sees 1500. Cheapest gap here, and the other five depend on it.
2. **The field is not saved.** Even set in memory it returns 1500 — the class of defect #1321
   (`maxSpeedMbps`, `poeOutDeclared`), #1405 (`speed`, `duplex`) and #1520 (the format stamp) each fixed for a
   neighbouring field.
3. **No instrument.** `ping` cannot send a packet larger than the default, so even with (1) and (2) nobody can
   ask "does this path carry my packet". `size` is the word IOS prompts for.
4. **No outcome.** Nothing compares a packet to an egress MTU: no fragments, no type 3 code 4 carrying the
   next-hop MTU, no retry at a smaller MSS. The PMTUD black hole — the most instructive MTU lab there is —
   cannot be assembled.
5. **IPv6 is further behind.** No Packet Too Big, no 1280 floor: the one family with a standard constant the
   model could already assert has neither.
6. **No line, so no drift check.** `show interfaces` prints the speed and duplex it negotiated and not the MTU
   it would enforce. `docs/plans/doc-counts.md` records how long a hand-printed number stays wrong.

## Steps

**1. The field gets a door and a save (S).** One arm beside `ip address` in the interface dispatcher
(`engine/cli.js:2191`): `ip mtu <68-9000>` and `no ip mtu`, the range refused by name (`% ip mtu must be
68-9000: "67" is below the IPv4 minimum`), the refusal shape `speed`/`duplex` already use. The port block of
`Device.serialize()` (`engine/device.js:1374`) writes `mtu` only when it differs from 1500 — the optional-field
rule `voiceVlan` and `mediaDeclared` follow — and the restore path (`engine/device.js:1600-1625`) reads it
back. `show interfaces <port>` gains `MTU <n>` beside the rate line (`_linkRateLine()`, `engine/cli.js:5137`,
printed `:6579`). New `test/mtu-config.test.js`: 68 and 9000 accepted, 67 and 9001 refused with the bound
named, `no ip mtu` restores 1500, the value survives serialize/fromJSON, the block prints it, and a board saved
before this change still loads (absent means 1500). No delivery change: `pathMtu()` already reads the field.

**2. A probe with a size (S).** `ping <ip> size <bytes>` and `ping6 … size <bytes>`, parsed in `_ping()`
(`engine/cli.js:4099`) beside `at`, passed as `opts.payloadSize` to `Simulator.ping()`/`ping6()` — the option
exists and already reaches `pingFrameBits()` at `:661`/`:2430`, so only the console is missing. The echo frame
must carry the size too (`ethFrame()` has no byte field; add `frame.bytes` or `icmp.bytes`) — step 3 needs it
and nothing else can supply it. The sentence becomes computed and stays byte-identical at the default (56-byte
payload → `100-byte`): 11 test occurrences and 11 doc transcript lines quote it. Range 8-9000, refused by name.

**3. The egress MTU is enforced (M) — needs Jay's approval.** One check where an IP packet leaves a device:
`_sendL3()` `engine/simulator.js:2993` and `_sendL3v6()` `:2018`, both of which already marshal, resolve and
queue. Size > `egress.mtu` → DF clear: fragments of `floor((mtu - 20) / 8) * 8` payload bytes, each queued and
counted; DF set (or IPv6): drop with a stated reason (`ip-mtu-exceeded`) and
`_icmpErrorTo(dev, inIface, frame, net.ICMP_DEST_UNREACH, 4)` (`:3789`) carrying the egress MTU. That helper
already refuses to answer a frame whose own `icmp.type` is 3 or 11 (`:3794`), which is what stops two boxes
trading frag-needed forever. Reassembly in `_deliver()` (`:3202`) before `_handleIp()`. Determinism is the
constraint: fixed fragment size and order, no loss, no reordering. Test: a 2000-byte echo over a 1500 path
arrives whole; with DF it fails with the MTU named; 9000 bytes over three 1500 hops is fragments at one hop and
one packet at the end.

**4. The black hole becomes a lab (M) — needs Jay's approval.** `openFlow()` clamps MSS to `pathMtu()` (`:4122`),
which is why no flow has ever needed to fragment. Make the other case reachable: a flow whose segments exceed a
transit MTU retries at the smaller MSS named by frag-needed; and — the lab that matters — an ACL denying `icmp`
(the check is IPv4-only at `:2863`, so it sees the error frame) leaves the flow stalled with
`pmtuBlackhole: true` and the MSS it kept trying. `MAX_SEGMENTS` (`:4135`) must count fragments, not segments.

**5. IPv6 catches up (S).** `ICMPV6_TYPES.PACKET_TOO_BIG = 2` (`engine/ipv6.js:21-27`), produced by step 3 for
an IPv6 packet; a 1280 floor on an IPv6-enabled interface (RFC 8200 §5) — `ip mtu 1000` accepted for IPv4 but
refused with the reason when `ipv6 address` is configured; `ping6 … size` from step 2.

**6. The docs stop saying "absent" and say what it is (S).** Drop `docs/SIMULATION.md:251`'s line; rewrite
`:216` — frag-needed now exists, and the same row's *"Still absent: per-hop latency in `traceroute`"* is
already false (`engine/cli.js:780-806` prints the `msec` column; `research/traceroute-hop-line.md` landed it),
so the row is wrong in two directions; rewrite `:574`; add `ip mtu` to `docs/CLI.md:207` and `:217`; extend
`:1089` so the `show vlan` note says a port's MTU is now configurable while a VLAN's stays 1500;
eleven transcript lines across `docs/CLI.md` (8), `docs/CONVERGENCE.md:19` and `docs/ARCHITECTURE.md:885`, `:1766` quote the 100-byte sentence — check each.

## Risks

- **Step 3 changes what a board does.** No spec declares an MTU, so nothing regresses until someone types
  `ip mtu` — after which a lab that worked will drop. That is the feature; it needs one sentence beside the
  command saying so.
- **Fragment multiplication.** 9000 bytes over a 576-byte path is 16 frames per segment, and `_enqueue()`
  (`:3120`) has no depth bound. Count fragments in `MAX_SEGMENTS` or one API call becomes an unbounded run.
- **The ARP stash.** `_sendL3()` holds one pending packet per next hop (`dev.pending`, `:3010`); fragments
  queue one entry each, so an unresolved next hop with a large packet stores N copies. Fragment after
  resolution, or cap it.
- **Error-to-error loops.** The guard at `:3794` predates this plan and covers type 3/11; pin it with a test
  rather than assume it, because the obvious refactor is to start comparing codes.
- **Determinism is the repo's rule** (`docs/plans/flow-determinism.md`): fragment size and order computed,
  never sampled; the same board gives the same event stream twice.

## Test strategy

`test/mtu-config.test.js` (accept/refuse/restore/save/print), `test/ping-size.test.js` (default sentence
unchanged, size honoured, range refused, IPv6 shared), `test/mtu-forwarding.test.js` (fragment, DF refusal,
reassembly, an error never answered by an error), `test/pmtud.test.js` (retry at the named MSS; denied ICMP
leaves `pmtuBlackhole`), `test/ipv6-mtu.test.js` (type 2, 1280 floor). Then `node scripts/syntax-check.js` and
the full `npm test`: `engine/simulator.js` and `engine/cli.js` are the two most-shared files in the tree, and
`test/flow.test.js`, `test/topology-roundtrip.test.js` and the catalogue sweeps read every path this touches.

## Deliberately left out

`ip tcp adjust-mss` and MSS clamping on a transit box — a second model, and a decision about rewriting a packet
only being passed. IPv4 options, record-route, source-route. Jumbo-frame catalogue work (which ports declare
9000): 2,356 specs, its own sweep. A per-link MTU (a switch's `system mtu`), which is a link property rather
than a port one. Reassembly timers and overlapping-fragment attacks. A full `show ip interface`, which does not
exist and is its own plan. Making the `show vlan` MTU column per-VLAN: nobody has asked, and the row is
currently honest about being Ethernet-only.
