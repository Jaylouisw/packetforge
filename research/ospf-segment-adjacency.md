# OSPF neighbours on a switch: is an adjacency a cable or a segment?

**Question (one, narrow).** Three routers are cabled into one access switch, all addressed in the
same subnet, all running OSPF in area 0. On a real box they are neighbours, and one of them is the
Designated Router. In this model `computeOspf()` walked `topo.links`, so an adjacency needed a cable
joining the two devices: two routers behind a switch were not neighbours at all, and
`show ip ospf neighbor` on all three answered

```
% no adjacencies: nothing on the other end of an OSPF interface is running OSPF
```

which is true about the cable and false about the network.

**Verdict: an adjacency belongs to the broadcast segment, and so does the DR election.** A Hello is
a multicast that goes everywhere in its broadcast domain and stops at a router - which is exactly the
walk `engine/segment.ts` already performs for DHCP (`segmentOf()`: it crosses bridges, honours the
VLAN a port is in, and passes nothing over a link that is down or a port the spanning tree is holding
out of Forwarding). Two routers joined by one cable are the degenerate case of that (a segment of
two), so adopting the segment set changes nothing about a two-router lab and makes the switch lab
work. The election had to move with it: elected per cable, a segment of three routers produced *two*
DRs - a table no box can print.

## The evidence

**One DR per network, and it is adjacent to everybody on it.** RFC 2328, §7.3, verbatim from the
published text (<https://www.rfc-editor.org/rfc/rfc2328.txt>):

> The Designated Router becomes adjacent to all other routers on the network. Since the link state
> databases are synchronized across adjacencies (through adjacency bring-up and then the flooding
> procedure), the Designated Router plays a central part in the synchronization process.

and §7.4:

> In order to make the transition to a new Designated Router smoother, there is a Backup Designated
> Router for each broadcast and NBMA network. The Backup Designated Router is also adjacent to all
> routers on the network, and becomes Designated Router …

Those two sentences decide which pairs reach FULL: everything that involves the DR or the BDR, and
nothing else. Every other pair is two DROTHERs.

**What two DROTHERs print.** Cisco Learning Network, "DROther routers stay in a 2-way state? Or no?"
(<https://learningnetwork.cisco.com/s/question/0D53i00000KsvzUCAR/drother-routers-stay-in-a-2way-state-or-no>),
quoting the paragraph the poster is testing and then running the test on three routers cabled to a
2960:

> However, routers that are neither a DR nor a BDR—called DROthers by OSPF—never reach a full state
> because they do not do database exchange with each other. As a result, the show ip ospf neighbor
> command on these routers list some neighbors, permanently, in a state of 2-way, and not in a full
> state.

```
Neighbor ID     Pri   State           Dead Time   Address         Interface
2.2.2.2           1   FULL/DR         00:00:34    10.5.5.2        FastEthernet0/0
3.3.3.3           1   FULL/DROTHER    00:00:37    10.5.5.3        FastEthernet0/0
```

Three routers on one segment, and the box that printed this is the **BDR**: it is FULL with the DR
(`FULL/DR`) and FULL with the DROTHER (`FULL/DROTHER`) - §7.4's "adjacent to all routers" seen from
the other side. The DROTHER's own table is where the `2WAY` word appears; the same thread's answers
say so, and three further transcripts show it:

```
1.1.1.1 255 FULL/DR     00:00:35 10.0.0.1 FastEthernet0/0
2.2.2.2 254 FULL/BDR    00:00:35 10.0.0.2 FastEthernet0/0
4.4.4.4   1 2WAY/DROTHER 00:00:38 10.0.0.4 FastEthernet0/0
```

| Source | What it settles |
| --- | --- |
| Cisco Community, "OSPF -2way/Dbrother" <https://community.cisco.com/t5/routing/ospf-2way-dbrother/td-p/534419> | "On multiaccess media (like ethernet) The routers only form full adjacency with DRs or BDRs; with all other routers they stay in 2way state." |
| goldfishnetworks, "OSPF Neighbor Not Forming" <https://goldfishnetworks.com/guides/ospf-neighbor-not-forming> | A four-router segment through a switch: `2.2.2.2 1 2WAY/DROTHER`, `3.3.3.3 1 FULL/BDR`, `4.4.4.4 1 FULL/DR`; "Normal between two DROTHERs on a shared segment". |
| learnccna, OSPFv2 objective <https://learnccna.org/domain/3/3-4/> | Four routers on one segment: "of the six possible pairs on this segment, only R1 and R4 stop at 2-Way" - the count is the election's, not the cable's. |
| networkustad, "OSPF Priority" <https://networkustad.com/2019/12/20/the-ospf-priority/> | `2WAY/DROTHER` beside `FULL/BDR` in one table, and "From R1 (DROTHER): FULL adjacency with DR and BDR, but 2WAY with R2 (the other DROTHER)". |

**The election rule itself is unchanged**, and was already cited in this repository: highest Router
Priority, then highest Router ID (Cisco's `ip ospf priority` usage guidelines; RFC 2328 §9.4), with
priority 0 discarded before the comparison. What changed is the *electorate* - the eligible
interfaces of one segment instead of the two ends of one cable.

## What the model does now

* `Simulator._ospfSegmentPairs(byId)` asks `segmentOf()` for each OSPF interface and returns the
  deduplicated pairs of OSPF-speaking ports that can hear each other's Hellos. A segment is walked
  once from each end, so the pairs are deduplicated by the unordered pair; a two-router cable
  segment answers with the one pair the old per-link walk did.
* `computeOspf()` runs its existing checks (timers, area, mask/subnet, priority 0) over those pairs,
  then elects per *segment*: union-find over the accepted pairs, then one DR and one BDR from each
  component's eligible interfaces, everyone else DROTHER.
* A pair that comes out DROTHER/DROTHER is not an edge of the shortest-path tree. It is still a
  neighbour, so it is listed - `state: '2WAY/DROTHER'`, `full: false` - and `show ip ospf neighbor`
  prints it, while the route table may never use it as a next hop.
* `show ip ospf neighbor`'s closing sentence no longer says "all Fully adjacent" over a table with a
  2WAY row in it: it counts them (`3 neighbour(s), 2 fully adjacent (1 in 2WAY/DROTHER)`), and the
  unchanged wording is kept when every row is FULL.
* `show ip ospf interface`'s `Adjacent` column asks for a *full* adjacency on that port, so a port
  whose only neighbours are DROTHERs reads `no` even though the neighbour table lists them.

`test/ospf-segment-adjacency.test.js` (27 checks) pins all of it: two routers on a switch are
neighbours and route to each other; three elect DR/BDR/DROTHER with exactly one DR; four put the two
DROTHERs in 2WAY while both are FULL with the DR and BDR, and a route to a DROTHER's network goes via
the DR or BDR, never via the DROTHER; two routers in different VLANs on the same switch are not
neighbours; pulling the cable removes the adjacency; and a direct cable still reads
`1 neighbour(s), all Fully adjacent`.

## What is inferred rather than witnessed

* **That the segment walk is the right adjacency set at all.** It is the same walk the DHCP model
  uses to find a server across a bridge, and the properties it enforces (VLAN membership, link state,
  STP forwarding) are the properties that decide whether a multicast Hello arrives. None of the
  captures above shows a VLAN mismatch or a blocking port, so those two boundary cases are reasoned,
  not witnessed.
* **The order the rows print in.** A real table is ordered by neighbour, and this one lists the FULL
  rows in the order the pairs were found and appends the 2WAY rows. No capture was measured for row
  order on a mixed table; the columns and the state words are what these sources pin.
* **The transit cost.** Every edge still costs the constant 10 it cost before, so a segment's cost
  does not change with the port's rate. That is a pre-existing simplification, unchanged here, and
  `research/ospf-route-metric.md` is where it belongs.

## What remains unresolved

* **DR stickiness.** RFC 2328 §7.3: "when a router's interface to a network first becomes
  functional, it checks to see whether there is currently a Designated Router for the network. If
  there is, it accepts that Designated Router, regardless of its Router Priority. (This makes it
  harder to predict the identity of the Designated Router, but ensures that the Designated Router
  changes less often.)" This model elects from scratch on every computation, so a router with a
  higher priority added to a running segment takes the DR immediately - which a box does not do until
  the old DR goes away. Modelling that needs a notion of "there is already a DR here", i.e. state
  across runs, which the graph calculation does not have. **What would settle it:** a transcript of
  `ip ospf priority 200` applied to a DROTHER on a live segment, showing the DR unchanged until
  `clear ip ospf process`.
* **Network types other than broadcast and point-to-point.** NBMA, point-to-multipoint and virtual
  links have their own adjacency rules and their own `show` output; none is modelled, and this change
  does not touch them.
* **BGP has the same per-cable shape.** `computeBgp()` decides a session from a `topo.links` pair the
  same way OSPF did, so two BGP speakers cabled into one switch are not neighbours either - though a
  real box would form the session over the segment (and needs `neighbor <ip> update-source`, since
  the TCP connection follows the routing table). That is a separate question with a separate answer
  and was left alone here.
