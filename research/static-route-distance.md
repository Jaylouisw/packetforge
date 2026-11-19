# What the number after a static route's next hop means, and what it changes

**Question (one, narrow).** In `ip route <dest> <mask> <next-hop> <number>`, is that number an interface name,
which is how this console read it, or the route's administrative distance - and what does the box do with it?

**Verdict: settled, and corrected.** It is the administrative distance, 1-255 with a default of 1. It is what
makes a floating static a backup instead of a second copy of the same route, and the console refused it by
name:

```
r1(config)#ip route 0.0.0.0 0.0.0.0 10.1.1.2 200
% 0.0.0.0/0: no interface called "200"
```

Engine code changed: `engine/cli.js` (the `ip route` and `no ip route` parsers, the `running-config` printer)
and `engine/device.js` (`routeDistance()`, the static loop in `routeTo()`, the table row and its "not installed"
mark). `test/static-route-distance.test.js` pins 22 checks.

## What the vendor publishes

| Source | Says |
| --- | --- |
| [Cisco IOS IP Routing: Protocol-Independent Command Reference, `ip route`](https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/iproute_pi/command/iri-cr-book/iri-cr-a1.html) | Syntax: `ip route [ vrf vrf-name ] prefix mask { ip-address \| interface-type interface-number [ip-address] } [dhcp] [global] [distance] [multicast] [name next-hop-name] [permanent \| track number] [tag tag]`. "distance (Optional) Administrative distance. The range is 1 to 255. The default administrative distance for a static route is 1." And the purpose: "If you specify an administrative distance, you are flagging a static route that can [back up a dynamic route] ... specify an administrative distance greater than 100." |
| [Same reference, `distance (IP)`](https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/iproute_pi/command/iri-cr-book/iri-cr-a1.html) | The default-distance table: connected 0, static 1, eBGP 20, OSPF 110, IS-IS 115, RIP 120, iBGP 200, "Unknown 255". And the rule for the top of the range: "Routes with a distance value of 255 are not installed in the routing table." |
| [BGP Commands, `show ip route static download`](https://www.cisco.com/c/en/us/td/docs/ios/iproute_bgp/command/reference/irg_book/irg_bgp5.html) | A transcript of a static (here AAA-downloaded) route carrying a non-default distance: `P 10.1.3.0 [200/0] via 172.31.229.41, Dialer1` - the bracket's first number is the distance, and 200 is a configured value, not a per-source default. |
| [Cisco Business 350 CLI guide, `ip route`](https://www.cisco.com/c/en/us/td/docs/switches/lan/csbms/CBS_250_350/CLI/cbs-350-cli-/ip-routing-protocol-independent-commands.html) | The *other* spelling of the same idea on a Cisco SMB OS: `ip route prefix {mask \| /prefix-length} {{ip-address [metric value]} \| reject-route}`, "metric value - Metric of the route ... Range: 1-255", and its table prints `Distance/Metric` (`S 10.10.0.0/16 1/2 ...`). So trustworthiness per static exists across the line, but only the Catalyst/IOS form appends it as a bare number. |

## What is known

1. The positional grammar is `dest mask { next-hop | interface [next-hop] } [distance]`; a bare number in the
   distance slot is the distance and never a port. On IOS the interface form also accepts the next hop after
   the interface (`ip route 0.0.0.0 0.0.0.0 GigabitEthernet0/1 203.0.113.1`), which this console expresses as
   `... <gw> <iface>` and has for some time.
2. Selection is longest prefix first, then lowest distance. A static at 200 therefore loses to a static at 1,
   and to OSPF (110) and eBGP (20), for the same prefix - the "floating static" pattern. It wins when the
   lower-distance route is withdrawn.
3. A distance of 255 is a different statement: the route is configured, listed, and **never installed**.

## What this console did, and what it does now

`routeDistance()` (`engine/device.js`) returned a constant `1` for every static row, `routeTo()` priced every
static at `ad: 1`, and the parser read the token after the next hop as an interface name - so the distance
existed in the printed bracket only as that constant, and the command that sets it was refused. The state now
is:

* the distance is parsed in either position this console allows (after the next hop, or after the interface),
  stored on the route only when it was typed, and range-checked (`must be 1-255 (the default is 1)`);
* `routeTo()` prices the static at its configured distance and skips a 255 route entirely, so no packet leaves
  by a route the box would not install;
* `routesTable()` carries the distance into the row, the table prints it (`[200/0]`), and marks a shadowed
  static with the row that beat it - or, at 255, with the vendor's "never installed" reason;
* `running-config` prints the distance after the next hop/interface, so the saved file replays; a route typed
  without one still prints without one, because the box's own file does not carry the default of 1;
* `no ip route <dest> <mask> <gw> <distance>` removes that one route and leaves a different-distance route to
  the same prefix alone; the bare `no ip route <dest> <mask>` still removes every static for the prefix, which
  is what the vendor's `no` form does.

Measured (two statics to `10.9.0.0/16`, one at 1 and one at 200):

```
r1# show ip route
S   10.9.0.0/16  [200/0] via 10.0.0.253  (not installed: the S route for this prefix has distance 1)
S   10.9.0.0/16  [1/0] via 10.0.0.254
```

`routeTo('10.9.9.9')` returns `10.0.0.254` at `ad: 1`; after `no ip route 10.9.0.0 255.255.0.0 10.0.0.254` it
returns `10.0.0.253` at `ad: 200`.

## What is inferred, not published

* The per-route distance is validated to 1-255 and anything outside that (a 0, or a 300) is refused with the
  range named. IOS's own refusal wording for those numbers is not in the reference in hand; only the accepted
  range is. The sentence here is this console's, in the shape its other range refusals use.
* A route at distance 255 is kept in the table with a reason rather than hidden, because this console's table
  lists every candidate and marks it (the `#1407` rule); a real box simply does not print it. Both are "not
  installed"; the difference is the audit trail, and it is deliberate.
* The distance is not consulted by any other feature yet: redistribution, `distance` per protocol, and route
  maps are not modelled, so nothing changes the OSPF 110 or BGP 20/200 constants.

## What is unresolved

* `name`, `tag`, `permanent`, `track` and `vrf` are all in the same positional syntax and none is read. Typing
  `ip route 10.0.0.0 255.0.0.0 10.1.1.2 name BACKUP` still draws a refusal (the word is not a port and not a
  distance). Which of them is worth modelling is a separate question, and `tag` in particular has no consumer
  here.
* Whether a box re-derives the distance when the route is redefined with the same prefix, next hop and a new
  distance (does it replace the entry or hold two?) is not stated in the command reference in hand. This
  console stores both and lets selection pick - the safe reading, not a measured one.
* The vendor's `no` form with a distance is shown in the syntax but no transcript in hand exercises it; the
  behaviour here (match on the distance as typed) follows the syntax rather than a capture.

## What evidence would settle them

One `show running-config` / `show ip route` pair from a box where `ip route 10.0.0.0 255.0.0.0 10.1.1.2 200` is
retyped with `... 100`: how many lines the file holds, and whether the table carries one row or two. Plus one
`ip route ... name X` transcript for the `name` form.
