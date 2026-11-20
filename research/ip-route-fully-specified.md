# `ip route`: does the fully specified form take the interface *before* the next hop?

**Question (one, narrow).** `ip route <prefix> <mask> <interface> <next-hop>` - both halves given, interface
first. Is that the vendor's order, what does the routing table print for such a row, and what does the `no`
form of the same line remove?

**Verdict: yes, the interface comes first, and the row keeps its bracket and names both halves.**
`R1(config)# ip route 10.2.3.0 255.255.255.0 g0/0/0 10.1.2.2` -> `S 10.2.3.0/24 [1/0] via 10.1.2.2,
GigabitEthernet0/0/0`. This console refused the line - `% 10.2.3.0/24: no interface called "10.1.2.2"` -
because every word after the fifth was read as a port name or an administrative distance and nothing else.
It now reads an *address* in that position as the next hop, once the interface has been named and no next
hop has; a second address is refused by name. The `no` form reads the same three slots, which also fixed two
removal bugs in the same slot (below). Implemented in `engine/cli.js` (`_configMode`, the `ip route` and
`no ip route` branches) with `test/ip-route-fully-specified.test.js` (24 checks).

## The syntax line

`ip route prefix mask { ip-address | interface-type interface-number [ip-address] } [distance] [name]
[permanent | track number] [tag tag]` - the `[ip-address]` is inside the braces, i.e. it follows the
interface. Every configuration guide repeats the same shape:

* Cisco IOS IP Routing: Protocol-Independent Command Reference, `ip route`
  <https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/iproute_pi/command/iri-cr-book/iri-cr-a1.html>
  (the same text in the book's PDF, which prints the example
  `ip route 0.0.0.0 0.0.0.0 Ethernet 0/1 10.1.1.242 track 123` - interface, then next hop).
* Cisco IP Routing: Protocol-Independent Configuration Guide, 15M&T, "Fully Specified Static Routes":
  "both the output interface and the next hop are specified ... This form of static route is used when the
  output interface is a multi-access one" <https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/iproute_pi/configuration/15-mt/iri-15-mt-book.pdf>.
* Cisco 4000 Series ISRs Software Configuration Guide (IOS XE 16.5), Basic Router Configuration, step 1:
  `ip route prefix mask {ip-address | interface-type interface-number [ip-address]}`
  <https://cisco.com/c/en/us/td/docs/routers/access/4400/software/configuration/xe-16-5/isr4400swcfg-xe-16-5-book/bm_isr_4400_sw_config_guide_chapter_0110.html>.

## The captures

| Source | Shows |
| --- | --- |
| [Cisco Networking Academy lab 6.1.2, "Investigate Static Routes" (answers)](https://itexamanswers.net/6-1-2-lab-investigate-static-routes-answers.html) | The whole sequence on one box: `R1(config)# no ip route 10.2.3.0 255.255.255.0 10.1.2.2`, then `R1(config)# ip route 10.2.3.0 255.255.255.0 g0/0/0 10.1.2.2`, then `S 10.2.3.0/24 [1/0] via 10.1.2.2, GigabitEthernet0/0/0`. The wrong-order line and the right-order line are the same route; only the second prints the port. |
| [Manning, *Acing the CCNA Exam*, "fully specified static route"](https://livebook.manning.com/learn/concepts/fully-specified-static-route--technique/acing-the-ccna-exam-fundamentals-and-protocols) | `ip route 192.168.3.0 255.255.255.0 g0/0 192.168.12.2` -> `S 192.168.3.0/24 [1/0] via 192.168.12.2, GigabitEthernet0/0`, with the sentence "The entry shows both required values". |
| [HackMD CCNA static-route reference](https://hackmd.io/@Faelin/cisco-ios-reference-static-routes) | `R1(config)# ip route 172.16.1.0 255.255.255.0 GigabitEthernet 0/0/1 172.16.2.2`, and the parameter table's `exit-intf ip-address` row labelled "Creates a fully specified static route". |
| [Goldfish Networks, "How to Configure a Static Route on Cisco"](https://goldfishnetworks.com/guides/how-to-configure-a-static-route) | "Form C - fully specified: exit interface + next-hop (safest on multi-access)": `ip route 10.2.2.0 255.255.255.0 GigabitEthernet0/1 192.168.12.2`. |
| [ComputingForGeeks, "Cisco IPv4 Static Routes"](https://computingforgeeks.com/cisco-ipv4-static-routes-configuration/) | The grammar in one line - `ip route <network> <mask> <next-hop-ip \| exit-interface \| exit-interface next-hop-ip> [AD]` - with the fully specified example `ip route 192.168.2.0 255.255.255.0 Gi0/0 10.0.12.2`. |

The printed row was already right in this console: `show ip route` prints `via <hop>, <port>` for a row that
holds both (research/show-ip-route-interface-spelling.md), and the test that left this question open typed the
route in as table state rather than through the parser (test/show-ip-route-static-via-interface.test.js, whose
comment says so). Nothing about the row or the forwarding path changed here - `routeTo()` already read `gw`
and `iface` together, and `directlyConnected` is already false for that shape.

## What changed, and the two removal bugs it exposed

* **Accepting the documented order.** An address after the interface is the next hop. `ip route 10.2.3.0
  255.255.255.0 Gi0/0/0 10.1.2.2 40` puts the distance in the bracket (`[40/0]`), as the `[distance]` slot
  outside the braces says it should.
* **`no ip route <prefix> <mask> <iface>` answered `% Route not found`** for a route that was in the table.
  The fifth word was compared against the row's `gw`, and a directly connected static stores `gw: null`, so
  the filter could never match. It is now resolved as an interface and matched against `iface`, and an
  interface-only `no` still removes only the interface-only row - a recursive route to the same prefix
  survives, as a box's exact-line grammar requires.
* **`no ip route <prefix> <mask> <iface> <hop>`** (the fully specified line) was not read at all for the
  same reason; it is now, with or without a distance.

## Known, inferred, unresolved

**Known.** The interface precedes the next hop; the pair is a "fully specified" route; the row prints
`[ad/metric] via <hop>, <port>`; a distance may follow the pair.

**Inferred.** That the parser accepts the reversed pair here (`ip route ... <hop> <iface>`) is this console's
own tolerance, not the vendor's: no capture was found of that order being typed at a box, and the syntax line
does not offer it. It is kept because a saved file written by an older version of this console uses it and
must still replay (test/ip-route-fully-specified.test.js pins both orders to the same row).

**Unresolved.**

* **The order `show running-config` prints for this shape.** This console writes `ip route <dest> <mask>
  <hop> <iface>` - next hop first. No capture of a running-config holding a fully specified static was found
  (the dumps that turned up either hold recursive or interface-only routes, e.g. the Cisco Configuration
  Fundamentals guide's `ip route 0.0.0.0 0.0.0.0 GigabitEthernet0/0/0`). The round-trip argument says it
  should be interface-first - a box must be able to read back the file it writes, and its own grammar has no
  next-hop-first form - but that is inference, so the printer was left alone. **What would settle it:** one
  `show running-config | include ip route` on a box holding `ip route 10.2.3.0 255.255.255.0 g0/0/0 10.1.2.2`.
* **Whether the next hop must be on the interface's subnet.** The vendor says "The next hop must be directly
  attached to the specified output interface" (15M&T guide, *Fully Specified Static Routes*) but no capture
  was found of the refusal when it is not, so this console accepts the line and leaves the route to fail at
  forwarding time rather than inventing a sentence.
* **What a box prints at the moment of the command.** A real IOS answers a static route with the prompt
  alone (no receipt). This console's `Route added: ... via <hop> <iface>` is its own line, unchanged here.
