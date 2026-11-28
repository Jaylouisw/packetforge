# `show ip route <protocol>`: a word this console refused, and the one it would have got wrong

**Question (one, narrow).** `show ip route` takes a word after it. Is a *protocol* word one of them, what does
the box print for it, and does `connected` keep the `L` (local host) rows as well as the `C` ones?

**Verdict: the word is real, and `connected` keeps both codes.** The vendor's argument list is explicit -
`show ip route [ip-address [mask] | protocol [process-id] | ...]`, with *protocol* defined as "the name of a
routing protocol or the keyword **connected**, **mobile**, **static**, or **summary**", and the routing
protocols as "bgp, eigrp, hello, isis, odr, ospf, nhrp, or rip". Every capture prints the same furniture as the
bare view - the whole nine-line codes legend, the `Gateway of last resort` line - and only the rows of that
source. `connected` is the interesting one: a local host route is a subtype of the connected route, so
`show ip route connected` prints the `C` row *and* the `L` row under it, interface by interface.

This console answered all of them with one sentence: *`show ip route` does not take "static": the whole table is
printed - run `show ip route` and read the row for the prefix*. That sentence is right about a **prefix**
(#1403: a table printed for a prefix reads as "yes, it is in there") and wrong about a **protocol**, which the
box can always answer, including when the answer is "none of those rows exist".

## Evidence

| Source | Says |
| --- | --- |
| [Cisco IOS IP Routing: Protocol-Independent Command Reference, `show ip route`](https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/iproute_pi/command/iri-cr-book/iri-cr-s1.html) | `show ip route [ip-address [repair-paths / next-hop-override [dhcp] / mask [longer-prefixes]] / protocol [process-id] / list [...] / static download / update-queue]`; *protocol* = "The name of a routing protocol or the keyword connected, mobile, static, or summary. If you specify a routing protocol, use one of the following keywords: bgp, eigrp, hello, isis, odr, ospf, nhrp, or rip." |
| [Cisco IOS XE 3SE BGP command reference, `show ip route`](https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/iproute_bgp/command/iproute_bgp-xe-3se-3850-cr-book/iproute_bgp-xe-3se-3850-cr-book_chapter_0100.html) | The same syntax and the same field list on a Catalyst 3850 image, and a sample `Device# show ip route static`. |
| [Cisco E-Learning reprint of `show ip route` (11.x)](https://www.cisco.com/E-Learning/bulk/public/tac/cim/cib/using_cisco_ios_software/cmdrefs/show_ip_route.htm) | The older spelling of the same argument: `show ip route [address [mask] [longer-prefixes]] / [protocol [process-id]]`, *protocol* = "Name of a routing protocol; or the keyword connected, static, or summary", keywords "bgp, egp, eigrp, hello, igrp, isis, ospf, or rip". `egp`/`igrp` were removed in 12.2(13)T per the current reference. |
| [learnccna.org, "Configure and verify IPv4 and IPv6 static routing"](https://learnccna.org/domain/3/3-3/) | A `show ip route static` transcript: the legend, `Gateway of last resort is 10.1.12.2 to network 0.0.0.0`, `S* 0.0.0.0/0 [1/0] via 10.1.12.2`, the `10.0.0.0/8 is variably subnetted, 5 subnets, 3 masks` header, then the `S` rows. "`show ip route static` filters the output to static routes only." |
| [buildthenet.io, `show ip route static`](https://www.buildthenet.io/commands/show-ip-route-static) | A second independent transcript: legend, `Gateway of last resort is not set`, `S 172.16.0.0/16 [1/0] via 10.0.12.1`, nothing else. |
| [thisbridgeistheroot.com, "Understanding Static Routing"](https://thisbridgeistheroot.com/blog/understanding-static-routing) | A third: the full ten-line legend, the gateway line, `S* 0.0.0.0/0`, a `169.254.0.0/24 is subnetted, 1 subnets` header and the `S` row under it. |
| [Cisco, "Local Host Routes Installed in the Routing Table on Cisco IOS and Cisco IOS-XR" (doc 116264)](https://www.cisco.com/c/en/us/support/docs/ip/ip-routing/116264-technote-ios-00.html) | "Local routes are marked with an `L` in the output from the `show ip route` command"; "The local route is a subtype of the connected route"; the table shows `C 10.1.1.0/30` directly above `L 10.1.1.1/32` for the same interface. |
| [Cisco, "Configure EIGRP to Influence Path Selection" (doc 221548)](https://www.cisco.com/c/en/us/support/docs/ip/enhanced-interior-gateway-routing-protocol-eigrp/221548-configure-eigrp-to-influence-path-selection.pdf) | A `show ip route connected` capture that prints **both** codes, block after block: `C 10.10.10.0/24 is directly connected, Loopback10` then `L 10.10.10.10/32 is directly connected, Loopback10`, then the same pair for `10.10.20.0/24` and `10.10.30.0/30`. |
| [the-packet-thrower, "The Great Divide - Working with VRFs"](https://the-packet-thrower.com/2016/05/08/the-great-divide-working-with-vrfs/) | A practitioner transcript of the same thing inside a VRF: `sh ip route connected` printing `C 10.7.8.0/24 ...` and `L 10.7.8.7/32 ...` for each subinterface. |

## What is known

1. The word is an argument of the command, documented in every generation of the reference.
2. The narrowed view keeps the **whole codes legend** and the **gateway-of-last-resort line**. Neither is a
   property of the filtered source: the legend is the image's, and the gateway line names the RIB's default.
3. The rows are the same rows, in the same order, with the same codes - including the `*` on a candidate
   default (`S* 0.0.0.0/0` prints under `show ip route static`).
4. `connected` selects **C and L**. A local host route is installed by the connected process, which is what
   makes it a subtype rather than a separate source.
5. `summary` is in the same argument slot and is a **different table** - route sources with backup and deleted
   counts, and memory per protocol - not a narrowed routing table.
6. A second word is a process id (`show ip route ospf 1`) or `static download`; both narrow further.

## What is inferred

* **The gateway line under a view whose own source holds no default.** Every capture in hand has the default in
  the source being filtered (`show ip route static` with an `S*`). The line is printed here from the whole table
  regardless, on the reading that it names what `routeTo()` would pick rather than what the filter selected. No
  capture with a non-static default and `show ip route ospf` was found; the alternative - suppressing the line
  when the default is of another source - would be a second rule to get wrong.
* **The classful headers.** A real table groups rows under `10.0.0.0/8 is variably subnetted, 5 subnets, 3 masks`
  and `169.254.0.0/24 is subnetted, 1 subnets`, and a real narrowed table recomputes them from what is left.
  This console prints no such header in any view (`research/show-ip-route-subnetted-header.md`), so the narrowed
  view prints none either. The rows themselves are right; the grouping is missing from both views equally.

## What changed

`engine/cli.js`: `IP_ROUTE_PROTOCOL_WORDS` (the vendor's keyword list, each with the route codes it keeps) and
`ipRouteProtocol()`, which resolves the word through the same `resolveCommandWord()` every other keyword slot
uses - so `c` is `connected`, `s` is ambiguous between `static` and `summary` in the box's own sentence, and the
word is case-insensitive. The route branch keeps the prefix refusal untouched and filters the row set it prints;
the legend, the annotations on each row and the gateway line are unchanged. `summary` is refused as a different
table, a second word as a process id this console does not keep, and a box that does not route refuses the word
rather than printing a router's table.

`test/show-ip-route-protocol.test.js` (33 assertions): the full table is unchanged; `static` prints exactly the
`S` rows including `S*`; `connected` prints two `C` and two `L`; `ospf` prints only `O`; `bgp` prints no rows but
the full legend and the gateway line; the four filters partition the table with nothing lost or duplicated;
filtered rows keep the table's order; abbreviations and case; the ambiguous `s`; `summary`, a prefix, a junk word
and a process id each refused in their own words; a non-routing switch refused.

## What remains unresolved

* **The prefix form.** `show ip route 10.1.1.0 255.255.255.0` is a documented argument and prints the *detailed*
  `Routing entry for ...` block on a router, not a one-line row. That is a different view with its own field set
  (known via, distance, metric, `Routing Descriptor Blocks`, tag, redistributed, advertised); it stays refused
  here, and the refusal now names the protocol word as the argument that does work.
* **The process id.** `show ip route ospf 1` is accepted and refused by wording only: this console keeps one set
  of routes per box, so there is nothing for a number to select.
* **`show ip route summary`, `list <acl>`, `static download`, `update-queue`, `vrf`.** Real views, none modelled;
  `summary` gets its own sentence, the rest fall to the prefix refusal or the `vrf` door.
* **`longer-prefixes`.** `show ip route 10.1.0.0 255.255.0.0 longer-prefixes` is the prefix view with a modifier,
  so it stays open with the prefix form.
