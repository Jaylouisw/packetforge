# `show ip route`: how does a row spell the interface, and what separates it from the next hop?

**Question (one, narrow).** In a `show ip route` row, is the exit interface written the way a table cell writes
it — the panel's abbreviated type (`Gi0/0`, `Fa0/1`) — or the way a sentence writes it (`GigabitEthernet0/0`,
`FastEthernet0/1`)? And in the `[distance/metric] via …` shape, what stands between the next hop and the port:
two spaces, or a comma?

**Verdict: the full type word, introduced by `, `.** Every vendor capture in hand writes
`C 10.44.192.0/24 is directly connected, GigabitEthernet0/0`, `P 172.16.4.0/8 [1/0] via 10.1.1.1, BRI0` and
`O E2 10.110.0.0 [160/5] via 10.119.254.6, 0:01:00, Ethernet2`. PacketForge printed the stored panel name and two
spaces — `C 10.0.1.0/24 is directly connected, Gi0/0`, `O 192.168.9.0/24 [110/2] via 10.0.0.1  Gi0` — a spelling
no box writes in this view. Fixed in `engine/device.js` (`routesTable()` now carries `ifaceDisplay`) and the two
row printers (`engine/cli.js`, `web/app.js`), with `test/show-ip-route-interface-spelling.test.js` (12 checks).

## Why this is the same rule the other views already had

This console had already settled the rule twice, in the two views either side of this one:

* `show ip interface brief` spells the type out because every published capture does —
  `research/interface-brief-name-spelling.md` records the captures, every one of them `GigabitEthernet1/0/1`.
* `show ip ospf neighbor` does too, adopted in the same release cycle as this change
  ([CHANGELOG, "names the port in full"](../CHANGELOG.md), `research/ospf-neighbor-table-layout.md`).

The dividing line those notes draw is *cell versus sentence*: `show vlan`, `show mac address-table`,
`show etherchannel summary` and `show spanning-tree` are tables and a box abbreviates inside them (`Fa0/1`,
`Po1`); `show ip route` prints one sentence per route (`… is directly connected, GigabitEthernet0/0`), and there
the box spells the word out. `routesTable()` is also the place `show ip route` had already put its shared facts
(`directlyConnected`, `displayCode`, `note`), so the printed spelling goes there too and the console and the
inspector's Routes panel cannot drift apart.

## The captures

| Source | Shows |
| --- | --- |
| [Cisco, *Configure a Gateway of Last Resort that Uses IP Commands* (doc 16448, updated 2025; IOS 15M on a 3900)](https://www.cisco.com/c/en/us/support/docs/ip/routing-information-protocol-rip/16448-default.html) | `C 10.44.192.0/24 is directly connected, GigabitEthernet0/0`, `L 10.44.192.1/32 is directly connected, GigabitEthernet0/0`, `C 10.108.99.0/24 is directly connected, GigabitEthernet0/1`; and `S* 0.0.0.0/0 [1/0] via 10.44.192.2` with no interface at all — the next-hop-only static |
| [Cisco IOS IP Routing: Protocol-Independent Command Reference, `show ip route` (IOS XE 17)](https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/iproute_pi/command/Cisco_IOS_IP_Routing_Protocol-Independent_Command_Reference/IP_Routing_Protocol-Independent_Commands_S_through_T.html) | `Device# show ip route static` prints `P 172.16.4.0/8 [1/0] via 10.1.1.1, BRI0`; `show ip route nhrp` prints `H 172.16.99.0 [250/1] via 10.1.1.99, 00:11:43, Tunnel0`; the main sample is `O E2 10.110.0.0 [160/5] via 10.119.254.6, 0:01:00, Ethernet2` |
| [Cisco TAC, `show ip route` command reference (12.x-era output)](https://www.cisco.com/E-Learning/bulk/public/tac/cim/cib/using_cisco_ios_software/cmdrefs/show_ip_route.htm) | `E 192.67.131.0 [200/128] via 131.119.254.244, 0:02:22, Ethernet2` and `S 134.134.0.0 is directly connected, Ethernet0`, plus the field list: "`Ethernet 2` — Specifies the interface through which the specified network can be reached" and "`0:01:00` — Specifies the last time the route was updated" |
| [Cisco Community, "#show ip route !!!" (IOS 15 on a 2911-class box)](https://community.cisco.com/t5/switching/show-ip-route/td-p/2736277) | A pasted table: `C 192.168.1.0/24 is directly connected, GigabitEthernet0/0`, `L 192.168.1.1/32 is directly connected, GigabitEthernet0/0`, `C 192.168.2.0/24 is directly connected, GigabitEthernet0/1` |
| [Cisco Learning Network, "Is my understanding, right?"](https://learningnetwork.cisco.com/s/question/0D5Kd0000C823x0KQA/is-my-understanding-right) | The fully specified static, in words and as a row: `S 172.16.2.0/24 [1/0] via 172.16.4.2, Serial0/0/1` — "This shows both the next-hop (via 172.16.4.2) and the outgoing interface (Serial0/0/1)" |
| [Cisco Learning Network, "Output of show ip route command with EIGRP"](https://learningnetwork.cisco.com/s/question/0D53i00000Kt2hNCAR/output-of-show-ip-route-command-with-eigrp) | A pasted table with `D 1.1.1.1 [90/130816] via 172.16.10.1, 00:00:30, GigabitEthernet1/0` and `C 172.16.10.0/30 is directly connected, GigabitEthernet1/0` |
| [Matt Oswalt, "The Anatomy of Show IP Route"](https://oswalt.dev/2011/07/the-anatomy-of-show-ip-route/) | An older image with the same shape: `C 1.1.1.0 is directly connected, FastEthernet0/1`, `O 1.1.1.4 [110/2] via 1.1.1.2, 00:10:04, FastEthernet0/1` — so the spelling is not an IOS XE convention |

## The one kind of source that disagrees, and why it does not count

Teaching pages that *paraphrase* a check write the short form:

* netforge-ai's lab walk-through: "look for `C 192.168.20.0/24 is directly connected, Gi0/1`";
* bytesizedacademy's "a small router might show" block: `O 10.2.0.0/16 [110/20] via 10.0.0.2, 00:01:12, Gi0/1`.

Both are instructions to a reader — what to type and what to look for — not pasted device output, and both sit in
pages whose surrounding prose is a lesson rather than a transcript. No pasted `show ip route` table found in this
pass abbreviates the type word. That is why the verdict is "full word" rather than "thin": the disagreement is
between transcripts and paraphrase, not between two transcripts.

## What changed

* `engine/device.js` — `routesTable()` sets `row.ifaceDisplay = displayName(row.iface)` for every row that names a
  port, using the same `displayName()` that `show ip interface brief` and `show ip ospf neighbor` use. The stored
  `row.iface` is untouched: it is the key `routeTo()`, the shadowing notes and the inspector's port links look up.
* `engine/cli.js` — the row printer prints `ifaceDisplay` in both shapes and puts `', '` (not two spaces) before a
  port that follows a next hop. A next-hop-only route still prints no interface and no dangling comma.
* `web/app.js` — the Routes panel reads the same `ifaceDisplay`, so the two surfaces cannot spell one route two
  ways.
* `docs/CLI.md` — the four sample rows in the routing sections follow; a paragraph states the field rule.

## What remains open

1. **The route age on protocol-learned rows.** A box prints three fields in this shape —
   `via 10.119.254.6, 0:01:00, Ethernet2` — the middle one being how long the route has been in the table. This
   engine tracks no install time per route, so the row prints two fields. Printing a fabricated `00:00:00` would
   be worse than omitting the field; what would settle it is a decision to give `routesTable()` an install
   timestamp (the convergence clock already has an instant, `sim.runAtMs`) and a formatting rule for it —
   `h:mm:ss` in the 12.x captures, `hh:mm:ss` in the modern ones, which is itself unresolved.
2. **Whether any image abbreviates here.** No counter-example was found, but the search was for pasted tables;
   a transcript from IOS XR, NX-OS or a very old 11.x image would say whether "full type word" is IOS-wide or
   IOS/IOS XE-wide.
3. **The same question in other sentence-shaped views.** `show ip bgp` prints its own `via`/`Interface` columns
   from the same rows but formats them separately (`engine/cli.js`, `_showBgp`); it was not re-measured in this
   pass and may still print the panel spelling.
