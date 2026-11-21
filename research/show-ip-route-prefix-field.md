# `show ip route`: is the destination one field, or an address column plus a mask column?

**Question (one, narrow).** In a `show ip route` row, does IOS print the destination as a single
`network/len` token immediately after the route code - or as an address padded out to a fixed column with
the mask brought forward to a column of its own?

**Verdict: one token.** Every IOS sample joins the pair - `10.44.192.0/24`, `0.0.0.0/0`, `10.1.1.1/32` -
and the token sits directly after the code. What IOS pads is the *code* field (the width of that padding
varies by train and by table: `C 10.44.192.0/24` in IOS 15M, `C 10.10.10.0/24` in the BGP guide,
`C        10.2.1.0/24` in the protocol-independent reference). The prefix itself is never split, and it is
never aligned into a column of its own.

PacketForge printed `pad(dest, 15) + '/' + prefix`, so one table came out in two shapes:

```
C   10.1.2.0       /24  is directly connected, Gi0/0/0     <- mask at column 20
S* 0.0.0.0        /0  [1/0] via 10.1.2.1                   <- mask at column 20 too, address longer
```

The padded address was this console's invention, and it disagreed with the inspector's Routes panel,
which has always built its network cell as `dest + '/' + maskBits(mask)` (`web/app.js`).

## Evidence

| Source | What it prints |
| --- | --- |
| [Cisco, *Configure a Gateway of Last Resort that Uses IP Commands* (doc 16448, updated 2025, IOS 15M on a 3900)](https://www.cisco.com/c/en/us/support/docs/ip/routing-information-protocol-rip/16448-default.html) | `S* 0.0.0.0/0 [1/0] via 10.108.99.2`, then `C 10.44.192.0/24 is directly connected, GigabitEthernet0/0`, `L 10.44.192.1/32 is directly connected, GigabitEthernet0/0`; the network headers read `10.0.0.0/8 is variably subnetted, 4 subnets, 2 masks`. Also `S* 192.168.1.0/24 [1/0] via 10.44.192.2` - a candidate default that is not `0.0.0.0/0` |
| [Cisco IOS IP Routing: Protocol-Independent Command Reference, `show ip route`](https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/iproute_pi/command/Cisco_IOS_IP_Routing_Protocol-Independent_Command_Reference/IP_Routing_Protocol-Independent_Commands_S_through_T.html) | `C 10.2.1.0/24 is directly connected, Loopback1`, `L 10.2.1.1/32 is directly connected, Loopback1`, `S 10.10.10.0 is directly connected, Tunnel0`, `C 10.1.1.0/24 is directly connected, Tunnel0` |
| [Cisco IOS IP Routing: BGP Command Reference, `show ip route`](https://www.cisco.com/c/en/us/td/docs/ios/iproute_bgp/command/reference/irg_book/irg_bgp5.html) | `C 10.10.10.0/24 is directly connected, Vlan1`, `L 10.10.10.1/32 is directly connected, Vlan1`, `C 10.1.1.0/24 is directly connected, Tunnel0` |
| [Cisco Community, "Static IP Route"](https://community.cisco.com/t5/routing/static-ip-route/td-p/3299523) | `S* 0.0.0.0/0 [1/0] via 192.168.10.6` under `10.0.0.0/8 is variably subnetted, 2 subnets, 2 masks` |
| [Cisco Community, "s* what does this means?"](https://community.cisco.com/t5/network-management/s-what-does-this-means/td-p/4859369) | `S* 0.0.0.0/0 [1/0] via 172.17.17.1`, with `Gateway of last resort is 172.17.17.1 to network 0.0.0.0` above it |
| Cisco, *Using Cisco IOS Software* command reference, `show ip route` (11.x output, kept online) | the older shape, one field still: `C 172.19.64.0 is directly connected, Ethernet0`; the only pre-CIDR form in the corpus is a **dotted** mask with no slash (`C 171.69.232.32 255.255.255.240 is directly connected, Ethernet0`) - not a mask brought to its own column |

## What is known

1. The prefix is one token: address, slash, length, no space anywhere inside it.
2. It follows the code, and the code is padded to whatever fixed width that build uses.
3. A `/0` default prints `0.0.0.0/0`, in the same field, with the same absence of alignment against its
   neighbours: the `S*` row above a table does not line its `/0` up under anyone's `/24`.
4. The one historical exception is a *dotted* mask in pre-CIDR output (`171.69.232.32 255.255.255.240`)
   - two tokens, no slash - which no modern IOS prints for a classless route.

## What changed

* `engine/cli.js`: the row is built as `r.dest + '/' + prefix`. The code field is now four characters
  whatever the code is (one letter and three spaces, or `S*` and two), so the prefix begins in the same
  column on every row - which the old code achieved only by padding the address, and only for as long as
  no row's mask happened to be `/0`.
* `test/show-ip-route-prefix-one-field.test.js` (new, 18 assertions): every row prints `net/len` as one
  token; no row holds an address, whitespace, then a slash; no address is padded; the connected, static,
  static-default, configured-gateway, OSPF and eBGP rows each read in the device order; the second field
  of every row is the whole prefix; the prefix always precedes the bracket; and the console's prefix for
  each row is byte-identical to the network cell the inspector builds for the same row.
* Tests that had parsed the padded shape now parse the device shape: `show-ip-route`,
  `route-selection`, `routes-agreement`, `route-next-hop-unreachable`, `ospf-route-metric`,
  `ospf-adjacency-link-state`, `bgp-session-link-state`. The `route-next-hop-unreachable` helper matched
  `t[1] === dest && t[2] is a mask`, which is the shape this file removes - it now matches the field that
  *starts with* the destination and a slash.
* `docs/CLI.md` and `docs/ARCHITECTURE.md`: every printed sample re-flowed to the device shape, and the
  "Reading `show ip route`" section states the rule and cites the two command references.

## What remains unresolved

* **The code field's width is a build detail, not a rule.** IOS 15M samples print `C ` with a single
  space, the protocol-independent reference pads to nine characters, and post-15.2 output sometimes
  inserts a blank line between prefix groups. This console uses four characters for every code and no
  blank lines; a reader diffing against a particular build will see the gap, and which build to match is
  a decision this increment did not take.
* ~~**The two-space separator** before `is directly connected` / `[distance/metric]` is house style, not
  IOS.~~ **Settled:** [show-ip-route-field-separator.md](show-ip-route-field-separator.md) measured 22
  byte-preserving captures (64 `is directly connected` rows, 113 `[d/m] via` rows) and found one space in
  every one; the console now prints one. The two spaces before its own trailing notes stay, as a marker
  for a sentence no box writes.
* **Lines this console does not print**: `10.0.0.0/8 is variably subnetted, 4 subnets, 2 masks`, the
  `L - local` code and its `/32` rows, and the blank line between prefix groups. A box with a LAN
  interface prints all three; this table prints neither, so its rows cannot be compared group by group
  with a capture. The group header is now its own note: [show-ip-route-subnetted-header.md](show-ip-route-subnetted-header.md)
  carries the captures this bullet asked for (a classful /8 holding two subnets of one mask, and one holding
  two masks), the rule the header follows - key, mask, counts, and the shape of the rows under it - and what
  is still unobservable, which is its indentation. `L` rows and the blank line stay open here.
