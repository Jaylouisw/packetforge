# `show ip route`: where does a router's own address appear in the table?

**Question (one, narrow).** A router configured with `ip address 10.1.1.1 255.255.255.252` holds a connected
route for `10.1.1.0/30`. Does `show ip route` also carry a row for the address itself? If it does, what code
does that row take, what mask, what wording, which line does it sit on, and what is its administrative
distance? And when does the row *not* appear?

**Verdict: the address is a row of its own - code `L`, a `/32`, "is directly connected", one line under the
subnet's `C` row, distance 0 - and there is no `L` row when the address was configured with a `/32` mask in
the first place.** Cisco's note on local host routes says all of it in one page, and prints the pair:

```
 C        10.1.1.0/30 is directly connected, Ethernet0/0
 L        10.1.1.1/32 is directly connected, Ethernet0/0
```

PacketForge printed only the `C` row, so the address a technician had just typed was absent from the table
they were told to check it in, and `ping <own address>` succeeded with no row explaining why. Changed here:
`routesTable()` now emits the local row beside the connected one, and the legend leads with `L - local` the
way the box's does.

## Evidence

| Source | Says |
| --- | --- |
| [Cisco, *Local Host Routes Installed in the Routing Table on Cisco IOS and Cisco IOS-XR* (doc 116264, IOS 15.0(1)S)](https://www.cisco.com/c/en/us/support/docs/ip/ip-routing/116264-technote-ios-00.html) | The whole rule, on one interface (`ip address 10.1.1.1 255.255.255.252`): "For each IPv4 and IPv6 address, Cisco IOS installs host routes in the respective routing tables", with the transcript `C 10.1.1.0/30 is directly connected, Ethernet0/0` over `L 10.1.1.1/32 is directly connected, Ethernet0/0`. Distance: "The local routes have the administrative distance of 0. This is the same adminstrative distance as connected routes." Redistribution: "when you configure redistributed connected under any routing process, the connected routes are redistributed, but the local routes are not." Purpose: a CEF **receive** entry, so a packet for the address "is punted in order to be processed by the router itself". The `/32` exception: "If an IPv4 address is configured with a mask of /32 on an interface of the router, which is typical for loopback interfaces, the host route appears in the routing table only as connected (it has the C flag)", printed as `C 10.100.1.1/32 is directly connected, Loopback0` and nothing else. Its MTR example also shows the pair alone in a topology's table (`C 10.1.1.0/30 …` / `L 10.1.1.1/32 …`). |
| [Cisco, *Configure a Gateway of Last Resort that Uses IP Commands* (doc 16448, IOS 15M on a 3900, updated 2025)](https://www.cisco.com/c/en/us/support/docs/ip/routing-information-protocol-rip/16448-default.html) | The same pair, in a different lab on a different platform, inside full `show ip route` output: `C 100.100.100.0/24 is directly connected, Serial1/0` then `L 100.100.100.2/32 is directly connected, Serial1/0`, and the same two lines for `192.168.12.0/24` / `192.168.12.2/32` on Serial1/1. Also the legend's first line, `Codes: L - local, C - connected, S - static, R - RIP, M - mobile, B - BGP`, with `O - OSPF` further down the block - so `B` precedes `O` in the box's order. |
| [Cisco, *Understand Administrative Distance for Route Selection*](https://www.cisco.com/c/en/us/support/docs/ip/ip-routed-protocols/113153-adjust-ad-00.html) | Two `show ip route` samples from the same lab, both pairing `C 100.100.100.0/24 is directly connected, Serial1/0` with `L 100.100.100.2/32 is directly connected, Serial1/0`; its own bracket field is `[administrative distance/metric]`, and the local row is never bracketed because it is printed as directly connected. |
| [Cisco, IOS XE 16 OSPF configuration guide, `show ip route vrf` sample](https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/iproute_ospf/configuration/xe-16/iro-xe-16-book/iro-sup-vrf.html) | A fourth, independent print of the same legend block beginning `Codes: L - local, C - connected, …` - the code list is a property of the image, not of the table. |

## What is known

1. Every IPv4 address on an interface with a mask shorter than `/32` produces **two** rows: the subnet with
   code `C`, then the address with code `L`, adjacent, in that order.
2. The `L` row's mask is `/32` whatever the interface's mask is; its wording is the connected row's
   (`is directly connected, <port>`), with no bracket and no `via`.
3. Its distance is 0, the same as the connected route, and it is **not** redistributed by
   `redistribute connected` even though the connected route is.
4. It is a **receive** entry: it exists so that traffic destined to the box's own address is punted to the
   box, and so that a more specific route learned from a peer cannot steal it.
5. An address configured with a `/32` mask produces **one** row - the `C` row - and no `L` row. (For IPv6 the
   same page says the opposite: a `/128` appears with both `L` and `C`. That is the IPv6 table, out of scope
   here.)
6. The box's legend puts `L - local` first and `B - BGP` before `O - OSPF`.

## What is inferred

* **That a DHCP-learned address is the same case.** The rule is stated for "each IPv4 and IPv6 address", with
  no mention of how it was configured, and the local route is a property of the address being on the box; but
  no capture pairs `ip address dhcp` with the table, so this console applies the rule it can cite and prints
  the row for an address whatever put it there.
* **That IOS 12.x has no `L` rows.** The technote dates IPv4 local routes to the Multi-Topology Routing
  feature and states the baselines as IOS 15.0(1)S / IOS XR 4.3.1; no 12.x table in hand shows an `L` row.
  This console has no per-device IOS version - it prints one IOS-15-shaped table for every model - so a
  12.4-flavoured box is the case that would be wrong if it ever mattered.

## Unresolved

* **The heading lines.** Classic IOS groups rows under classful headings - `10.0.0.0/8 is variably subnetted,
  2 subnets, 2 masks` - and indents the rows under them further to the right. This console prints a flat
  table, and did so before this change; the local row joins that flat table. Whether to adopt the headings is
  a separate question about the whole table's shape, not about this row, and the padding between code and
  prefix would move with it (the vendor's samples show the code field wider than the four characters used
  here).
* **A `/31`.** No capture in hand shows whether a `255.255.255.254` address prints one `L` row (its own
  address) or none; the rule as stated ("for each address") says one, and this console prints one.
* **`routeTo()`'s verdict.** The forwarding lookup has no "receive" answer: asked for the box's own address it
  describes the connected egress. The row and the lookup therefore disagree about *that one prefix* by
  construction, and `test/route-selection.test.js` skips local rows rather than pretending otherwise. A
  data-plane change would be its own question with its own evidence.

## What would settle it

A `show ip route` paste from (a) a 12.4 box with one addressed interface, (b) a box whose only address came
from `ip address dhcp`, and (c) a `/31` point-to-point link. The first would say whether the console should
suppress `L` for old images; the second whether the row follows the address or the configuration command; the
third fixes the `/31` count.

## What changed

* `engine/device.js` - `routesTable()` emits `{ code: 'L', type: 'local' }` for each addressed interface whose
  mask is not `/32`; a local row is `directlyConnected` (so it prints in the connected row's shape), is priced
  at distance 0 by `routeDistance()`, and takes its fault note from its port by the same branch the connected
  row uses.
* `engine/cli.js` - the `show ip route` legend now reads
  `Codes: L - local, C - connected, S - static, B - BGP, O - OSPF, * - candidate default`: the new code first,
  and the surviving codes in the box's order (`B` before `O`).
* `test/local-route-row.test.js` (23 checks) pins the pair, the order, the wording, distance 0, the `/32`
  one-row case, the shut-port withdrawal, the switch that does not route, and the receive-entry distinction
  from `routeTo()`.
* `docs/CLI.md` - the legend samples, the R1 walkthrough (now with `L` rows) and a paragraph stating the rule
  with the citation.
