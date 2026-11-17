# Two equal BGP paths: whose router ID decides, and what decides after that?

**Question (one, narrow).** When two paths to the same prefix tie on weight, local preference, local
origination, AS_PATH length, origin, MED and eBGP-over-iBGP, what does a real BGP speaker use next - and what
did PacketForge use?

**Verdict: known, and adopted.** RFC 4271 ends Phase 2 with the lowest **BGP Identifier of the advertising
speaker**, then the lowest **peer address**; Cisco states the same pair as steps 11 and 13 of the best-path
algorithm. PacketForge documented both steps, compared neither: `comparePaths()` read `path.routerId`, and no
candidate ever carried one, so the term compared `undefined` with `undefined`, returned 0, and the winner was
whichever advertisement `Array.prototype.sort` happened to see first. On a lab with two external peers
offering the same prefix, the route installed was the peer that had been added to the topology first.

## The standard's own order

RFC 4271 §9.1.2.2, *Breaking Ties (Phase 2)*, the last two criteria:

> f) Remove from consideration all routes other than the route that was advertised by the BGP speaker with
> the lowest BGP Identifier value.
>
> g) Prefer the route received from the lowest peer address.

* <https://www.rfc-editor.org/rfc/rfc4271.txt> (§9.1.2.2, pp. 82)

Note what (f) attributes to whom: the identifier belongs to **the speaker that advertised the route**, not to
the local box doing the comparison.

## The vendor's own order

Cisco, *Select BGP-path Algorithm* (document ID 13753):

> 8. Prefer the path with the lowest IGP metric to the BGP next hop.
> …
> 10. When both paths are external, prefer the path that was received first (the oldest one).
> 11. Prefer the route that comes from the BGP router with the lowest router ID.
>     **Note**: If a path contains route reflector (RR) attributes, the originator ID is substituted for the
>     router ID in the path selection process.
> 12. If the originator or router ID is the same for multiple paths, prefer the path with the minimum cluster
>     list length. This is only present in BGP RR environments.
> 13. Prefer the path that comes from the lowest neighbor address.
>     This address is the IP address that is used in the BGP `neighbor` configuration.

* <https://www.cisco.com/c/en/us/support/docs/ip/border-gateway-protocol-bgp/13753-25.html>

Three things follow. The tie-break is the **advertising** router's ID, not the local one. The cluster-list step
between them exists only where route reflectors exist. And the last criterion is the address the receiver put
in its own `neighbor` line - a number, compared numerically.

## What the engine did, and what it does now

`engine/bgp.js` carried the decision order as a comment - eight steps, ending "lower router ID" - and the
comparison ended with `compareRouterId(x.routerId, y.routerId)`. `engine/simulator.js:computeBgp()` built every
candidate without a `routerId` at all, so:

* step 8 was a comparison of two undefined values, always 0;
* `bestPath()` fell through to its own final `compareRouterId`, still 0, then to `comparePrefix` - equal for
  the same prefix - and `sort` kept the first element. The first element is whichever peer the topology walk
  reached first, i.e. device creation order;
* there was no peer-address step anywhere, so two peers advertising the same router ID (two routers in one AS,
  a duplicated `bgp router-id`, the same physical box reachable twice) also won by insertion order.

Now `computeBgp()` stamps two fields on every advertisement it sends:

* `routerId` - the **sending** speaker's BGP identifier (configured, or the elected one:
  `research/bgp-router-id-selection.md`);
* `fromIp` - `adj.localIp`, the address the sender uses on the session, which is exactly the string the
  receiver has in its `neighbor` line.

and `comparePaths()` compares `routerId`, then `fromIp` (numerically - `10.0.0.9` before `10.0.0.10`), after
eBGP-over-iBGP. A path with no `fromIp` is a locally originated one, already settled by step 3, and sorts after
any path that has an address, mirroring the existing rule that a path with no router ID sorts last.

`test/bgp-peer-tiebreak.test.js` holds 19 checks: both identifiers and their order at library level, the
numeric (not lexicographic) comparison of each, and a lab where a spine peers with two eBGP speakers in one AS
that both advertise `10.9.9.0/24` - flagged with 3.3.3.3 and 1.1.1.1, then both 1.1.1.1 - built with the
devices added in both orders. Before the change that lab installed the higher-ID peer's path when it was added
first, and flipped to the other peer's when the same-ID lab was built in the opposite order; after it, both
questions have one answer.

## What is inferred, not published

* **The identified route is the advertising peer's.** With no route reflectors in this model, that is the
  same router the RFC means. A route-reflector topology would need ORIGINATOR_ID, and Cisco's step 11 note
  substitutes it; nothing here can produce one.
* **Missing `fromIp` sorts last.** No document says what an address-less path does at step 13; locally
  originated paths never reach step 13 (step 3 decides them a dozen criteria earlier), so the choice only
  affects sparse hand-written paths in library tests. It is asserted as an inference.

## What remains unresolved

* **Step 8, lowest IGP metric to the next hop, is not implemented.** Candidates carry no interior cost, so a
  tie that a real box would settle on the IGP metric is settled here on the router ID instead. That changes
  which route wins whenever two equal paths have different IGP distances to their next hops.
* **Step 10, oldest external path, is not implemented.** This engine has no per-path age - `computeBgp()` is
  a pure recomputation - so "received first" has no meaning here. A real box prefers the incumbent route,
  which is precisely the flapping behaviour this model cannot exhibit.
* **Step 12, cluster list length,** is absent for the same reason as ORIGINATOR_ID: no reflector.
* **MED is still compared unqualified** between paths from different neighbouring ASes (noted in
  `engine/bgp.js` before this change), where Cisco compares it only when the first AS in the AS_PATH is the
  same. That can make a path look tied here that a box would have separated on MED, and the new steps then
  decide it - so fixing MED comparison would change these outcomes too.

What would settle the first two: a capture or `show ip bgp <prefix>` pair from a box with unequal IGP
distances to two equal eBGP paths (step 8), and one where a newer better-ID route is refused because the
older path is still up (step 10).
