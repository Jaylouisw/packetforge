# `show ip route`: how does a static route whose next hop is only an *interface* print?

**Question (one, narrow).** `ip route 192.168.2.0 255.255.255.0 GigabitEthernet0/1` names an exit interface
and no next-hop address. How does the routing table print that row - with `[distance/metric] via ...` like
every other static, or in some other shape? And if a distance was typed (`... GigabitEthernet0/1 40`), does the
bracket show it?

**Verdict: it prints as a *directly connected network*, with no bracket and no `via`.**
`S 192.168.2.0/24 is directly connected, GigabitEthernet0/1`, and `S* 0.0.0.0/0 is directly connected,
FastEthernet0` for a default. The administrative distance is not displayed even when one was configured; it
still prices the route for selection. This console printed the bracket form with a placeholder next hop -
`S 192.168.2.0/24  [1/0] via -  Gi0/0/0` - a row that named no next hop and priced a metric for it. Fixed in
`engine/cli.js` (`_show`, the row printer) and `engine/device.js` (`routesTable()`, which now sets the shared
`directlyConnected` flag the inspector also reads), with
`test/show-ip-route-static-via-interface.test.js` (14 checks).

## Why the row says "directly connected"

The vendor says so in the command that creates it. `ip route`, Usage Guidelines:

> When the next hop of a static route points to an interface, the router considers each of the hosts within
> the range of the route to be directly connected through that interface, and therefore it will send Address
> Resolution Protocol (ARP) requests to any destination addresses that route through the static route.

That is also why the same page warns that "adding a static route to an Ethernet or other broadcast interface
(for example, `ip route 0.0.0.0 0.0.0.0 Ethernet 1/2`) will cause the route to be inserted into the routing
table only when the interface is up", and why every configuration guide calls this form a *directly connected
static route*.

## The captures

| Source | Shows |
| --- | --- |
| [Cisco IOS IP Routing: Protocol-Independent Command Reference, `ip route` and `show ip route`](https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/iproute_pi/command/iri-cr-book/iri-cr-a1.html) (same text in the [PDF](https://www.cisco.com/c/en/us/td/docs/ios/iproute_pi/command/reference/iri_book.pdf)) | The paragraph above, and a `show ip route` sample row `S 10.10.10.0 is directly connected, Tunnel0` - the interface-only static, bracketless, beside `C ... is directly connected` rows. |
| [Cisco TAC command reference, `show ip route`](https://www.cisco.com/E-Learning/bulk/public/tac/cim/cib/using_cisco_ios_software/cmdrefs/show_ip_route.htm) | A long table from a static-route-heavy config where every static row is the same shape: `S 134.134.0.0 is directly connected, Ethernet0`, `S 171.69.0.0 255.255.0.0 is directly connected, Ethernet0` - no brackets in the whole list. This is the 12.x-era layout, which is what makes the behaviour old rather than IOS XE-only. |
| [Cisco Catalyst SD-WAN Routing Configuration Guide 26.x, "Static route support for BFD sessions in transport VPN"](https://cisco.com/c/en/us/td/docs/routers/sdwan/26x-later/routing/routing-configuration-guide/bfd/c-static-route-support-for-bfd-sessions-in-transport-vpn.html) | The contrast, on one page: next-hop defaults print `S* 0.0.0.0/0 [1/0] via 10.0.0.1` (and `via 192.168.0.1, GigabitEthernet0/0/1` when both are given), while `ip route 0.0.0.0 0.0.0.0 Cellular0/0/0` prints `S* 0.0.0.0/0 is directly connected, Cellular0/0/0`. |
| [Cisco 900 Series ISR Software Configuration Guide, Basic Router Configuration](http://www.cisco.com/c/en/us/td/docs/routers/access/900/software/configuration/guide/900SCG/routconf.pdf), and the same page for the [800M series](https://www.cisco.com/c/en/us/td/docs/routers/access/800M/software/800MSCG/routconf.html) | `S* 0.0.0.0/0 is directly connected, gigabitethernet0` / `... FastEthernet0` - an **Ethernet** exit interface, not only a serial or cellular one. |
| [Cisco Press, *Routing Concepts 1.3*](https://www.ciscopress.com/articles/article.asp?p=2756479&seqNum=6) | `Gateway of last resort is 0.0.0.0 to network 0.0.0.0` followed by `S* 0.0.0.0/0 is directly connected, Serial0/0/0` (see the open question below - a 900-series guide prints `not set` above the same row). |
| [Cisco Learning Network, "Routing Showdown: Static Default Route To A Next-Hop IP Address vs. An Exit Interface"](https://learningnetwork.cisco.com/s/blogs/a0D3i000002SKOmEAO/routing-showdown-static-default-route-to-a-nexthop-ip-address-vs-an-exit-inte) | States the rule in words - "When a static route is associated with an exit interface, it shows up in the routing table as directly connected" - and prints both rows: `S* 0.0.0.0/0 [1/0] via 155.0.0.7` and `S* 0.0.0.0/0 is directly connected, GigabitEthernet1`. |
| [Cisco Community, "Administrative distance for static routes"](https://community.cisco.com/t5/routing/administrative-distance-for-static-routes/td-p/1714940) | A typed distance at an exit interface: `ip route 0.0.0.0 0.0.0.0 cellular 0/0/0 254` -> `S* 0.0.0.0/0 is directly connected, Cellular0/0/0`. The number is gone from the row. |
| [r/ccna, "AD of a static 'directly connected' route"](https://www.reddit.com/r/ccna/comments/fih7fu/ad_of_a_static_directly_connected_route/) | The same for a non-default: `ip route 10.0.0.0 255.255.255.0 f0/1 40` "still shows as 'directly connected'", and the answer is that the bracket is absent - `show ip route <prefix>` is where the configured distance is read. |
| [Pearson, CCNA Routing and Switching, ch.2 sample pages](https://ptgmedia.pearsoncmg.com/images/9781587133213/samplepages/03_9781587133213_ch02.pdf) | The rule with the consequence: "Although the routing table entry indicates 'directly connected', the administrative distance of the static route is still 1. Only a directly connected interface can have an administrative distance of 0." |

## What PacketForge did before, and what changed

`routesTable()` has always stored the two facts apart (`gw: null`, `iface: 'Gi0/0/0'`), and `routeNote()`
already explained the ARP consequence, so nothing about the data plane or the selection arithmetic changed.
Only the printed shape did:

```
before
S   192.168.2.0/24  [1/0] via -  Gi0/0/0  (no next hop: ARP for the destination on that segment)
S*  0.0.0.0/0  [1/0] via -  Gi0/0/0  (no next hop: ARP for the destination on that segment)

after
S   192.168.2.0/24  is directly connected, Gi0/0/0  (no next hop: ARP for the destination on that segment)
S*  0.0.0.0/0  is directly connected, Gi0/0/0  (no next hop: ARP for the destination on that segment)
```

The parenthesised note is this console's own annotation (the vendor puts that explanation in the command
reference, not on the row) and is kept: it is the reason the row behaves the way it does, and it is what makes
the ARP-on-the-segment behaviour visible at the moment somebody reads the table.

Which rows take the shape is decided once, in `Device.routesTable()`, as `row.directlyConnected` - a connected
route, or a static route with no gateway and a real interface. Both readers (the console and the web
inspector's Routes panel) read that flag instead of re-deriving the rule, which is the same discipline that
kept the two surfaces from disagreeing about shadowed routes in #1407. The **fully specified** form
(interface *and* next hop) is not a directly connected route and keeps its bracket row.

## Known, inferred, unresolved

**Known.** The interface-only static is printed as a directly connected network, on Ethernet as well as on
serial/cellular/tunnel interfaces, in both 12.x-era and 17.x/26.x-era material. The bracket (and with it the
administrative distance) is not printed, even when one was typed; `show ip route <prefix>` is where the
configured distance can be read. The row appears only while the interface is up (`ip route` reference, Usage
Guidelines).

**Inferred.** That the `*` of a candidate default sits on the code as usual (`S* ... is directly connected`) -
three of the captures show exactly that, so the inference is small. That the shape is stable across classic
IOS and IOS XE - the evidence spans both, but no single platform was read twice across releases.

**Unresolved.**

* **The gateway-of-last-resort sentence above such a row.** Cisco Press and the Learning Network blog print
  `Gateway of last resort is 0.0.0.0 to network 0.0.0.0`; the 900 Series ISR guide prints `Gateway of last
  resort is not set` immediately above the same `S* ... is directly connected` row. This console prints
  `not set` (its gateway line only names a row that has a next-hop address), which matches the 900 guide and
  nothing else found. Not changed here: it is a second fact, and the sources contradict.
* **The warning some releases print when the route is typed.** The `ip route` reference carries a note:
  "Configuring a default route that points to an interface, such as `ip route 0.0.0.0 0.0.0.0 ethernet 1/2`,
  displays the warning message: `%Default routes, must specify a next hop IP address if not a point-to-point
  interface`." Whether it fires for every interface-only default or only for broadcast media, whether it
  blocks the command or merely warns, and which releases print it, are all unstated. This console accepts the
  form and explains the ARP consequence instead (a note, not a refusal); that stays.
* **A down interface.** The vendor removes the route from the table when the interface goes down; this
  console keeps the row and annotates it `(down: no cable)`, the same choice it makes for every unusable
  route (#1271, #1439). Changing that would change what the table is (a view of configuration plus
  reachability) and is a separate question.
* **Word order for the fully specified form.** The vendor's syntax is
  `prefix mask { ip-address | interface-type interface-number [ip-address] }` - interface first, next hop
  second. This console's parser accepts the next hop first and then a port (`ip route 10.8.0.0 255.255.0.0
  10.9.0.9 Gi0/0/0`), and refuses the vendor's order (`... Gi0/0/0 10.9.0.9` -> `no interface called
  "10.9.0.9"`). Whether IOS accepts the reversed order at all is not established by anything read here, so
  the parser was not touched; the test that needs such a row builds it as table state instead of typing it.

**What would settle the rest.** On one 900-series or ISR with an Ethernet port and no next hop on the segment:
`ip route 0.0.0.0 0.0.0.0 Gi0/1` (does it print the `%Default routes...` warning? does it accept the line?),
then `show ip route` (the gateway sentence), then `ip route 192.0.2.0 255.255.255.0 Gi0/0/1 40` and
`show ip route 192.0.2.0` (does the plain row stay bracketless *and* does the detail view show `distance 40`?),
then `shutdown` on Gi0/1 and `show ip route` again (is the row gone or kept?), then retype the fully specified
form in the vendor's order (`ip route 192.0.2.0 255.255.255.0 Gi0/0/1 10.9.9.9`) and in the reversed one.
