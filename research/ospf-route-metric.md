# The second number in `[110/n]`: what `show ip route` prints for an OSPF route

**Question (one, narrow).** When a real IOS-like router prints an OSPF-learned route, what is the number after
the slash in `[110/n]`, how is it calculated, and can PacketForge print it?

**Verdict: settled, and the console was printing a placeholder.** The second number is the protocol's metric for
that path, and for OSPF it is the cost from this router to the router that advertises the network plus the cost
of the network link itself. PacketForge printed a literal `0` on every row, for every protocol, and the engine's
SPF could not have produced the device's number anyway: it charged a hop as *both* interfaces' costs added
together. Both halves are now the device's rule, and `test/ospf-route-metric.test.js` holds the bracket.

## What PacketForge did before this change

```
r2# show ip route
Codes: C - connected, S - static, O - OSPF, B - BGP
C   10.0.12.0      /24  is directly connected, Gi0/0/0
O   192.168.1.0    /24  [110/0] via 10.0.12.1  Gi0/0/0
O   192.168.3.0    /24  [110/0] via 10.0.23.3  Gi0/0/1
```

Three routes, one bracket. The distance half (110) was right, and the metric half was the same `0` for a LAN one
hop away and a LAN three hops away, so the one column an operator compares two OSPF paths by said nothing. The
value was not merely missing: `routesTable()` did not carry a metric at all, and `computeOspf()` discarded the
SPF distance it had computed when it copied the route (`cost` survived on the raw route object, not on the row).

## Evidence

| Source | Says |
| --- | --- |
| [Cisco, `show ip route` command reference](https://www.cisco.com/E-Learning/bulk/public/tac/cim/cib/using_cisco_ios_software/cmdrefs/show_ip_route.htm) | `[160/5]` — "The first number in the brackets is the administrative distance of the information source; the second number is the metric for the route." |
| [Cisco, Understand Administrative Distance](http://cisco.com/c/en/us/support/docs/ip/border-gateway-protocol-bgp/15986-admin-distance.pdf) | "In `show ip route` output, the values in brackets use the format [administrative distance/metric] ... In this case, [110/2] means that the route has an administrative distance of 110 and an OSPF metric of 2." |
| [RFC 2328 §16.1](https://www.rfc-editor.org/rfc/rfc2328.txt), second stage | "Calculate the distance D of stub network from the root. D is equal to the distance from the root to the router vertex (calculated in stage 1), plus the stub network link's advertised cost." |
| RFC 2328 §16.1, "Distance from root" | "The link state cost of a path is calculated as the sum of the costs of the path's constituent links (as advertised in router-LSAs and network-LSAs)." A router-LSA advertises the **output** cost of the interface the packet leaves by, so a hop costs what its sender says, not what both ends say. |
| RFC 2328 §12.4.1, loopback interfaces | "If the state of the interface is Loopback, add a Type 3 link (stub network) ... and the cost set to 0." |
| [Cisco, How to configure OSPF cost](https://community.cisco.com/t5/networking-knowledge-base/how-to-configure-ospf-cost/ta-p/3133153) | The interface cost `ip ospf cost` sets is the number the metric is built from; default reference bandwidth 100 Mbps, so 100 Mbps and faster cost 1. |
| [Cisco Press, Implementing OSPFv2](https://www.ciscopress.com/articles/article.asp?p=3197438&seqNum=3) | A transcript that matches this lab: `O 10.1.1.0/24 [110/2] via 10.1.14.1 ...` — one hop plus the far LAN's link. |

## What is now implemented

* `ospf.outCost(edge, from)` — a link is charged at the cost the **sending** router advertises for its own
  interface (`costA` belongs to `a`, `costB` to `b`). The edge's summed `cost` survives as the fallback for an
  endpoint that advertises nothing, which is what the module-level fixtures without interface costs rely on.
  `adjacencyIndex()` builds the directed adjacency list from it, so two ends of one cable may cost different
  numbers, as they do on a device.
* `ospf.stubCost()` / the equivalent in `computeOspf()` — a route's metric is the SPF distance to the router
  advertising the network plus that network link's own cost; a `/32` (loopback) stub link costs 0.
* `Device.routesTable()` puts `metric` on every row (0 for connected, static, BGP and gateway defaults; the OSPF
  cost for `O`), and `show ip route` prints `[distance/metric]`.
* `test/ospf-route-metric.test.js`: the two-router gigabit lab reads `[110/2]`, a three-router chain `[110/3]`,
  `ip ospf cost 10` moves it to `[110/11]`, a static default still reads `[1/0]`, a connected row has no bracket,
  and the printed bracket is checked against the same field the inspector's table carries.
* `test/ospf.test.js` and `test/protocol-regression.test.js` were asserting the old arithmetic (20 for a hop of
  10, "an OSPF link costs the sum of both interface costs"); their expectations are now the device's numbers and
  the comments state the rule.

## What remains unresolved

* **Inter-area and external routes.** Summaries (`IA`) and `E1`/`E2` do not exist in this model — one area per
  link, no ABR, no redistribution — so there is no metric for them to be wrong about. An `IA` route costs the
  distance to the ABR plus the summary's own cost, and an `E2` metric is the external metric with no internal
  cost added at all; when those routes exist they will need this rule, not this sum.
* **Equal-cost multipath.** A device prints one row per next hop under a single `[110/n]` (the continuation line
  aligns under the bracket). This table prints one row: the winner. `show ip ospf route` — the second surface
  that shows the same cost — is not implemented either, so the metric can only be read in `show ip route`.
* **BGP's metric column.** A `B` row prints `0`; a device prints the MED. BGP here carries `asPath` and `ad` but
  no MED, so `0` is the honest placeholder rather than a number invented to fill the column.
* **A link whose far end advertises nothing.** The sum stays as the fallback (a fixture convenience), so a graph
  built without interface costs still prices a hop as the link's own `cost`; no simulator lab reaches that path,
  because `computeOspf()` derives a cost for every OSPF interface.
* **What evidence would settle ECMP**: a capture of `show ip route` on a box with two equal-cost OSPF next hops,
  showing the continuation line's exact indent and whether the bracket is repeated on it.
