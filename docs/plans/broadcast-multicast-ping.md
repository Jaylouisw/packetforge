# Plan: `ping` cannot reach a broadcast or a group, and the report has no room for two answers to one echo

Status: forward plan, no code. Measured on `c85d3bbf`, 2026-11-27. Closes **no** open issue - the queue has nothing
about the ICMP echo path, and the evidence is the research note rather than a ticket. Steps 1-2 are additive. Steps 3-6
change what a `ping` to a non-unicast address does and prints: **needs Jay's approval**.

Related but not duplicated: `docs/plans/mtu-and-fragmentation.md` step 2 gives `ping` a `size`; this plan leaves the
payload alone. `docs/plans/traceroute-options.md` owns the option grammar beside it. `research/ping-broadcast-target.md`
is the evidence base and already records the behaviour the engine is missing; `research/ping-report-shape.md` owns the
marks line for a unicast run.

## What exists today

| fact | evidence |
|---|---|
| every echo is routed, including one addressed to a group | `_sendIcmp()` asks `routeTo(dstIp)` at `engine/simulator.js:3043` and drops at `:3045` when the table has no answer. Measured on a router + two PCs on `10.0.0.0/24`: `ping 224.0.0.1` -> `U`, `% Echoes lost: 1 drop ("no route to 224.0.0.1 (dropped by r1)")`; `ping 239.1.1.1` the same |
| a connected subnet's broadcast is ARPed for like a host | `10.0.0.255` matches the connected route, so the run resolves it at L2: measured `ping 10.0.0.255` -> `.`, `% Echoes lost: 1 drop (no ARP reply from 10.0.0.255)`. No capture shows a box ARPing a broadcast |
| the all-ones broadcast has no route at all | measured `ping 255.255.255.255` -> `.`, `no route to 255.255.255.255`. An all-ones echo needs no route |
| a receiver could not answer one if it arrived | `_handleLocalIp()` accepts an echo only when `dev.ownsIpOn(inIf4, frame.ip.dst)` (`engine/simulator.js:4005`), and `ownsIpOn()` is an address-ownership test (`engine/device.js:568`), so a broadcast or group destination is refused as `echo for unknown local IP` |
| a router would forward one | `_tryProcessL3()` hands any flooded IPv4 frame whose destination it does not own to `_forwardL3()` (`engine/simulator.js:3623`). There is no `ip directed-broadcast` model, and `255.255.255.255` is routable in principle |
| a reply has no identity | the reply is recorded as `{dst, id, seq, step}` (`engine/simulator.js:4028`) although the sender's address is in hand one line earlier (`from: frame.ip.src`, `:4029`), and `ping()` keeps only the first match per sequence (`:667`) |
| the report is one character per echo | `_pingReplyLines()` `engine/cli.js:5268`; the IPv4 call is `:5165` and the IPv6 call `:5137`, so the renderer is shared |
| the predicates are MAC-level only | `engine/net.js:118` `isBroadcastMac()`, `:119` `isMulticastMac()`; the IPv4 helpers are `broadcastOf()` `:83` and `sameSubnet()` `:84` - nothing classifies a *destination address* |
| the docs already say all of this is absent | `docs/SIMULATION.md:134` ("Multicast is treated as broadcast") and `:641` ("Multicast is routed." -> never). `show ip igmp groups` answers `% Invalid show command` |

## What is missing, ranked

1. **A box cannot send to a group or a broadcast.** Three of the four failures in the research note's transcript are
   this one gap, and each teaches a student something false about the device.
2. **A receiver cannot answer one**, and the fix is one ownership rule: "is this address one this interface is
   responsible for", not "is this address mine".
3. **A router forwards what it must drop.** `_tryProcessL3`'s fall-through means a directed broadcast that reaches a
   router is routed, which no default IOS does.
4. **The reply record cannot say who answered**, so even the unicast path cannot grow a second responder.
5. **The report has one shape**, one mark and one rate, for a run that may have N answers to one request.

## Ordered steps

**1. Classify a destination address (S).** Add `isIpv4Multicast()` (224/4), `isLimitedBroadcast()` (255.255.255.255)
and `isSubnetBroadcast(ip, iface)` to `engine/net.js` beside `broadcastOf()` (`:83`), reusing `networkOf`/`sameSubnet`
rather than re-deriving the mask. Pure functions, one unit test: `10.0.0.255` and `10.0.0.0` are the /24's broadcast and
network addresses, `10.0.1.255` is not, `224.0.0.1` is a group and not a broadcast. No behaviour change, so this lands
alone and is safe against everything else here.

**2. A router refuses a non-unicast destination, in its own words (S).** In `_forwardL3()` (`engine/simulator.js:3853`),
before the lookup, refuse `255.255.255.255`, 224/4 and a connected subnet's all-ones, emitting a named `drop`:
`directed broadcast refused (no ip directed-broadcast)` and `multicast routing is not modelled`. The second sentence is
the honest one - `docs/SIMULATION.md:641` already says multicast is never routed, so a silent forward is the only thing
worse than a refusal.

**3. Origination stops at the first hop (M).** In `_sendIcmp()` (`:3026`), before `routeTo()`, ask step 1 whether the
target is local: `255.255.255.255` (every attached interface that can carry a broadcast), a connected subnet's
broadcast or network address (that interface), or a group in 224/4 (every attached interface). Build the echo with
`ff:ff:ff:ff:ff:ff` or `01:00:5e` + the low 23 bits of the group, and hand it to `_forwardL2(dev, frame, null, true, vid)`
the way `_sendFromOwnIp()` does at `:3156` - no ARP, no route, no `nextHopIp`. The result gains `broadcast: true`.
Open question 5 of the research note (one frame per interface or one flooded frame) is decided here: one frame per
interface, with responders de-duplicated by (device, address).

**4. A receiver answers an address it is responsible for (M).** `_handleLocalIp()`'s ownership test (`:4005`) grows a
second arm: an echo whose destination is a broadcast/network address of the interface it arrived on. Group membership
is implicit and only where the engine already knows it: every device is in `224.0.0.1`, every router in `224.0.0.2`,
every OSPF speaker in `224.0.0.5`/`224.0.0.6`. Any other group is answered by nobody, and the loss sentence says
`no host on the wire joined <group>` rather than blaming a cable. The reply record gains `from` (`:4028`), which is the
address the capture names (`Reply to request 0 from 192.168.0.2`).

**5. `ping()` keeps every answer to one request (S/M).** Replace the first-match filter at `:667` with all matches for
`(id, seq)`, compute the round trip per responder, and return `replies[i].responders = [{address, dev, rttMs}]`.
`success` stays true when any responder answered, and a unicast run returns exactly one responder, so every existing
reader keeps its shape.

**6. The report switches shape for a non-unicast target (S - needs Jay's approval).** In `_pingReplyLines()`
(`engine/cli.js:5268`), when the result carries `broadcast`, print `Reply to request <n> from <addr>, <ms> ms` one line
per answer in arrival order, with no marks line and no success rate - the shape four independent pastes agree on. The
unanswered run is the one case no capture settles (open question 1): it keeps today's `.....`, `Success rate is 0
percent (0/5)` and `% Echoes lost` line, with a comment pointing at the research note, so the fallback is a decision
rather than an omission. Gate on the flag, never on the address shape, because the renderer is shared with `ping6()`.

**7. The two SIMULATION rows, in the PR that changes the behaviour (S).** `:134` and `:641` stop saying a group is
flooded and never routed; the research note's status line moves from "the engine is wrong about it - but not fixed
here" to what landed and what did not. Not a docs sweep: each row is rewritten by the step that makes it false.

## Risks

- **The L2 flood must not move.** IPv6 neighbour discovery and VRRP depend on a multicast MAC being flooded
  (`engine/simulator.js:3479-3481`). Every step here is ICMP origination or L3 forwarding; nothing touches `_forwardL2`'s
  candidate list.
- **Step 2 changes forwarding outcomes.** A lab that routes `10.0.0.255` today sees a drop tomorrow. That is the point,
  and the drop sentence has to name the command that would change it, or the reader files a bug.
- **Step 6 changes output**, so `test/ping-report-shape.test.js` and the transcript fixtures must be scoped to unicast
  targets; a test that pings a broadcast and asserts `!!!!!` is asserting the bug.
- **A new event type is a whole-repo change**: `test/event-legend.test.js:10` enumerates every `type:` the engine can
  emit and fails on a type with no legend case, so steps 2-4 should reuse `icmp-echo`, `icmp-received` and `drop`.
- **Group membership by construction** can answer a `ping 224.0.0.1` from a host that a real lab would answer too, but
  it must not be read as an IGMP model: the membership table does not exist and `show ip igmp groups` still refuses.
- **Duplicate answers** when a host holds two addresses in one subnet reached by two interfaces: de-duplicate on the
  responder address, not on the frame.

## Test strategy

New: `test/ping-broadcast-delivery.test.js` (the echo leaves as `ff:ff:ff:ff:ff:ff` per interface, no ARP, no route),
`test/ping-broadcast-report.test.js` (reply-block shape, grouping by request, no marks, no rate, the unanswered
fallback), `test/ping-group-membership.test.js` (`224.0.0.1` answered by every host, `224.0.0.2` by routers only, an
arbitrary group by nobody with the membership sentence), `test/directed-broadcast-refused.test.js` (a router refuses
`10.0.0.255` and `255.255.255.255` with the named reason).

Must stay green: `ping-report-shape`, `ping-surface`, `ping-loss-reason`, `ping-default-count`, `ping-own-address`,
`ping-ipv6`, `icmp-errors-traceroute`, `event-legend`, `docs-cli-transcript`, `canvas-ping-path`, `ipv6`, `vrrp`.

## Deliberately left out

`ip directed-broadcast` (the command that would make step 2's refusal configurable), IGMP joins and
`ip igmp join-group`, `show ip igmp groups`, IGMP snooping, PIM and any routed multicast - `docs/SIMULATION.md:641`
keeps saying none of it is modelled. Also out: an IPv6 multicast echo (`ping6 ff02::1`), a broadcast `ping` by hostname,
`size`, and TCP/UDP to a group.

## Open issues this closes

None. The queue holds #1398, #1366, #1218, #1164, #1069, #1066 and #30; none is about the echo path. The work is
justified by the measured transcripts above and by `research/ping-broadcast-target.md`.
