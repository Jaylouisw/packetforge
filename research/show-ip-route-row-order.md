# `show ip route`: what order the rows come out in

**Question (one, narrow).** A routing table is a set; a screen is a sequence. In what order does a Cisco
box print the rows of `show ip route` - by code (all connected, then all static, then the protocols), by
the order the routes were configured, or by something about the prefixes themselves? And where in that
order does the candidate default sit?

**Verdict: by the prefixes, not by the code.** IOS 15.x prints the table "in the increasing order of all
network entries": the network address ascending, whatever letter stands in front of the row, with the
less specific of two rows for one address printed first. `S* 0.0.0.0/0` is therefore the *first* row of
the table, not the last, because 0.0.0.0 is the lowest entry. Before IOS 15 the display followed an
internal hash table, so the order inside a classful block looked haphazard and the default route could
land anywhere. Adopted: the 15.x rule.

PacketForge grouped the table by code. Connected and local rows came first (in interface order), then
every configured static in the order it was typed, then OSPF, then BGP - so a lab with two interfaces and
a static to a network *between* them printed the static below both interfaces, and the default route,
which sorts first on the hardware, printed last.

## The evidence

| Source | What it says |
| --- | --- |
| [Cisco Community, "Is the default route looked at first or last?", accepted solution by Peter Paluch (CCIE #29811)](https://community.cisco.com/t5/routing/is-the-default-route-looked-at-first-or-last/td-p/2661554) | The version split, measured on two boxes. **12.4T:** eight Loopbacks in one /24 print `C 1.0.1.0, C 1.0.0.0, C 1.0.3.0, C 1.0.2.0, C 1.0.5.0, C 1.0.4.0, C 1.0.7.0, C 1.0.6.0` - "the ordering indeed corresponds to the order in which the individual networks were stored in the hash table", the hash being the XOR of the octets (`1^0^1 = 0`, `1^0^0 = 1`, ...). Major networks ascend; the subnets inside one do not. **15.x:** "the routing table is automatically displayed in the increasing order of all network entries", with the same lab printing `1.0.0.0/24 ... 1.0.7.0/24`, then `172.19.0.0/24 ... 172.19.3.0/24`, then `172.20.x`, then `192.168.0.0/25` and `192.168.0.128/25`. The same answer separates display from lookup: the order "has absolutely no bearing on what order the routing table is **searched** in ... the default route, no matter where it shines in the **show ip route** output, is always tried as the very last routing table entry." |
| [US CyberPatriot, *Complex Networks using static routes* (PDF)](https://www.uscyberpatriot.org/Documents/Training%20Documents/Complex%20Routing_ACL_DMZ.pdf) | A classful-era `R1# show ip route` that settles the code question directly: `S 172.16.1.0 [1/0] via 172.16.2.2` is printed **above** `C 172.16.2.0 is directly connected, Serial0/0/0` and `C 172.16.3.0 is directly connected, FastEthernet0/0`, and the two statics for 192.168.1.0/24 and 192.168.2.0/24 follow. Four rows, two codes, sorted by address with no section per code. |
| [Cisco, *Configure a Gateway of Last Resort that Uses IP Commands* (doc 16448, IOS 15M on a 3900)](https://www.cisco.com/c/en/us/support/docs/ip/routing-information-protocol-rip/16448-default.html) | IOS 15 output, byte for byte: `Gateway of last resort is 10.108.99.2 to network 0.0.0.0`, then `S* 0.0.0.0/0 [1/0] via 10.108.99.2`, then the `10.0.0.0/8 is variably subnetted` group. The default is the first row, and it is outside the groups. |
| [KFUPM, *Chapter 3: Static Routing* (PDF)](https://faculty.kfupm.edu.sa/COE/adiche/articles/static_routing.pdf) | The counter-example, and it is the *old* order: `10.0.0.0/24 is subnetted, 2 subnets`, `C 10.0.1.0`, `C 10.0.2.0`, then `S* 0.0.0.0/0 [1/0] via 10.0.2.2` **below** both connected rows. A 12.4-era capture, consistent with the hash order above: on that build the default is not first, so "the default prints first" is a statement about 15.x and not about IOS in general. |
| [Cisco IOS IP Routing: Protocol-Independent Command Reference (`show ip route`)](https://www.cisco.com/c/en/us/td/docs/ios/iproute_pi/command/reference/iri_book.pdf) | The vendor's own sample output prints static rows in an order no rule explains (`S 10.134.0.0`, `S 10.10.0.0`, `S 10.129.0.0`, `S 10.128.0.0`, `S 10.49.246.0`, ...), and later samples print `S 172.31.0.0/16` above `S 10.0.0.0/8`. Read as a rule it is contradictory; read as a capture from a pre-15 build it is the hash order again. It is cited here as the reason a command reference alone cannot settle this question. |

## What is known

1. **The code is not a section.** Both a 15.x capture (the community thread, all `C`) and a classful one
   (CyberPatriot, `S` above `C`) are sorted by address. Nothing in the sources shows a table with all the
   `C` rows above all the `S` rows unless the addresses happen to fall that way.
2. **The sort key is the network entry, ascending.** In the 15.x capture the groups themselves ascend
   (1.x, 172.19.x, 172.20.x, 192.168.x) and the rows inside them ascend too, including a /25 pair
   (192.168.0.0 then 192.168.0.128).
3. **`0.0.0.0/0` sorts first on 15.x** - it is the lowest network entry - and that is where doc 16448
   prints it. A 12.4-era build printed it last (KFUPM), which is the version trap, not a rule.
4. **The order is a display property, not the lookup order.** The community answer is explicit: lookups
   are longest-prefix-match in a tree, and the default is always tried last.
5. **Which build this console imitates.** Its legend, its `L - local` rows and its per-line brackets are
   all 15.x shapes (`research/show-ip-route-codes-legend.md`, `research/local-route-in-show-ip-route.md`),
   so the 15.x order is the one it owes.

## What is inferred

* **Two rows for one network address: the shorter mask first.** `10.0.0.0/8` beside `10.0.0.0/16` is the
  one case the captures in hand do not show. A box stores prefixes in a tree and prints it by walking it,
  and a walk meets a parent node before its children, so the less specific row comes first. That is a
  reading of the structure, not a captured line.
* **A stable sort is the right instrument.** Two rows for the *same* prefix (this console prints a losing
  candidate beside the winner, a thing a box does not do at all) must keep the order the tie-break above
  them decided, or the row that says "not installed: the C route for this prefix has distance 0" would be
  printed above the row it names.

## What this console prints now

With two interfaces, three statics, one OSPF route and one BGP route configured in an order that matches
none of the above:

```
Gateway of last resort is 10.0.0.1 to network 0.0.0.0
S*  0.0.0.0/0 [1/0] via 10.0.0.1
C   10.0.0.0/24 is directly connected, GigabitEthernet0/0/0
L   10.0.0.1/32 is directly connected, GigabitEthernet0/0/0
S   10.2.0.0/16 [1/0] via 10.0.0.2
B   10.3.0.0/16 [20/0] via 10.0.0.4, GigabitEthernet0/0/0
C   10.5.0.0/16 is directly connected, GigabitEthernet0/0/1
L   10.5.0.1/32 is directly connected, GigabitEthernet0/0/1
O   10.7.0.0/16 [110/2] via 10.0.0.3, GigabitEthernet0/0/0
S   10.9.0.0/16 [1/0] via 10.0.0.254
```

The `Gateway of last resort is ...` sentence is untouched: it names the default `routeTo()` would use,
which is a selection question, not an ordering one (and the `S*` row can carry a `(down: ...)` note while
that sentence names another gateway - the row says what the route is, the sentence says what the box
would pick).

## What remains unresolved, and what would settle it

* **Same address, two masks.** No capture read here holds both `10.0.0.0/8` and a `10.0.0.0/16`. A
  `show ip route` from IOS 15.x or XE with both would settle whether the parent prints first, as assumed -
  and, in the same capture, whether the key is (address, then length) or (address, then the bit pattern).
* **Blank lines between prefix groups.** Later XE builds sometimes insert one between groups (noted in
  `research/show-ip-route-prefix-field.md`). This console prints a flat list with no groups, so there is
  nowhere for the blank line to go yet.
* **12.4T hash order is not modelled, on purpose.** One build has to be chosen; choosing both would mean
  a switch per IOS version, which this engine does not have.
* **Rows a box would not print at all.** A shadowed route (one prefix, two candidates) is this console's
  own row: a box installs one and shows one. Its position in the sort is therefore this console's
  decision as well, and the rule chosen is "where its prefix belongs, after the winner".
