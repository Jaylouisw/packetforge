# `show ip route`: which rows carry the candidate-default asterisk

**Question (one, narrow).** When `show ip route` prints an asterisk beside a route code - `S*`,
`O*E2`, `D*EX` - what is the asterisk saying about *that row*? Is it a mark for the installed default
route, for the route that lost to it, or for something every route to `0.0.0.0/0` carries?

**Verdict: the asterisk means "this route is a candidate default", and it belongs to the prefix.**
Every route to `0.0.0.0/0` carries it, whatever protocol produced it, and so does any other network
flagged as a candidate by `ip default-network`. It is not a one-per-box title and it does not mean
"not installed". The legend says exactly this - `* - candidate default`.

PacketForge had the field the other way round: it printed the star on the configured gateway (a
distance-254 row the engine invents) and printed a **typed static default as a plain `S`**, which is
the one shape no IOS produces for `ip route 0.0.0.0 0.0.0.0 <next hop>`. Changed here.

## Evidence

| Source | What it prints |
| --- | --- |
| [Cisco, *Configure a Gateway of Last Resort that Uses IP Commands* (doc 16448, updated 2025, IOS 15M on a 3900)](https://www.cisco.com/c/en/us/support/docs/ip/routing-information-protocol-rip/16448-default.html) | after `ip route 0.0.0.0 0.0.0.0 10.108.99.2`: legend `... ia - IS-IS inter area, * - candidate default, U - per-user static route ...`, then `Gateway of last resort is 10.108.99.2 to network 0.0.0.0`, then `S* 0.0.0.0/0 [1/0] via 10.108.99.2`. The same page's `ip default-network` example prints **two starred rows in one table**: `S* 0.0.0.0/0 [1/0] via 172.17.24.0` and `S* 192.168.1.0/24 [1/0] via 10.44.192.2` - a candidate default that is not `0.0.0.0/0`, and two of them at once |
| same page, `show ip route 0.0.0.0 0.0.0.0` | `Routing entry for 0.0.0.0/0, supernet` / `Known via "static", distance 1, metric 0, candidate default path` - the vendor's own name for the property |
| [Cisco Press, *Router Operation* (CCNA routing concepts)](https://www.ciscopress.com/articles/article.asp?p=2756479&seqNum=6) | "Notice that the configuration of the route generated an 'S*' entry ... The 'S' signifies that the route source is a static route, whereas the asterisk (\*) identifies this route as a possible candidate to be the default route." The same page prints `D*EX 0.0.0.0/0 [170/2297856]` - a learned default, starred, with the protocol's own suffix |
| [Cisco, *BGP Commands* - `show ip route`](https://www.cisco.com/c/en/us/td/docs/ios/iproute_bgp/command/reference/irg_book/irg_bgp5.html) | `S* 0.0.0.0/0 [1/0] via 192.168.1.2`, legend `* - candidate default route` |
| [Cisco, *900 Series ISR Software Configuration Guide* - Basic Router Configuration](http://www.cisco.com/c/en/us/td/docs/routers/access/900/software/configuration/guide/900SCG/routconf.html) | `S* 0.0.0.0/0 is directly connected, gigabitethernet0` beside a full legend ending `* - candidate default` |
| [Cisco Learning Network, "A few question on default route"](https://learningnetwork.cisco.com/s/question/0D53i00000Kt6EzCAJ/a-few-question-on-default-route) (practitioner transcript) | `S* 0.0.0.0/0 [1/0] via 10.0.0.6` under the same legend |

## What is known

1. The star is printed on the row, and the legend defines it as *candidate default* - a route the box
   could use as its gateway of last resort.
2. A static route typed as `ip route 0.0.0.0 0.0.0.0 <next hop>` prints `S*`, with `[1/0]`. This is the
   canonical default route in every Cisco document that shows one.
3. More than one row can carry it at the same time (doc 16448 prints two), so it is not a title held by
   a single "installed" route.
4. It is not tied to the static protocol: `D*EX 0.0.0.0/0` (EIGRP external) and `O*E2 0.0.0.0/0` (OSPF
   external type 2, in Cisco's OSPF default-route note) carry it too, with the protocol's own suffix
   after the star.
5. The row that loses selection keeps its star. In doc 16448's table the gateway of last resort is
   `172.17.24.0` and the starred `S* 0.0.0.0/0` row above it is a *different* candidate - the star says
   "candidate", the `Gateway of last resort is …` line says "winner".

## What is inferred

The star marks a property of the prefix (is this route a default candidate?), not of the selection
result, and not of the row's configuration source. That inference is what the four independent
transcripts above agree on: same mark, four different origins (typed static, `ip default-network`,
EIGRP external, OSPF external), and two starred rows in one table.

## What changed

* `engine/device.js`, `routesTable()`: `row.candidateDefault` is now computed from the prefix
  (`0.0.0.0/0`) and `displayCode` is `code + '*'` for those rows, instead of
  `type === 'default' ? 'S*' : code`. A typed static default prints `S*   0.0.0.0/0 [1/0] via …`; the
  configured gateway keeps its row at `[254/0]` and is *also* starred, because it is a candidate too.
* `engine/cli.js`: the legend now ends `, * - candidate default`. The table had been printing `S*`
  since #1407 while the legend defined only `C`, `S`, `O` and `B` - the one mark the table used was the
  one a reader could not look up.
* `test/route-candidate-default.test.js` (new) pins the rule: a typed default is starred, a non-default
  static is not, every `0.0.0.0/0` row from `routesTable()` is starred and no other row is, two
  candidates are both starred, a learned `/0` row is starred with its own code, and the legend defines
  the asterisk before any row uses it.
* `test/show-ip-route.test.js` and `test/routes-agreement.test.js` asserted the old inversion
  ("the configured static default is still a plain S", "exactly one row carries the S* code"); they now
  assert the device's rule and keep the part that mattered - the two rows are still distinguishable, by
  the distance in the brackets.
* `docs/CLI.md` ("Reading `show ip route`") states the rule and its evidence.

## What remains unresolved

* **The distance-254 gateway row is this simulator's own.** Doc 16448 is explicit that `ip default-gateway`
  "must only be used when ip routing is disabled on the Cisco router" - a routing box does not put that
  gateway in its table at all. PacketForge keeps a row for it (type `default`, distance 254) so a lab can
  have a default without typing a static route, and that row now shares the star with a real static
  default. Both rows are then told apart only by `[254/0]` against `[1/0]`, and the losing row's note
  reads "(not installed: the S* route for this prefix has distance 1)" - true, but it now names a code
  both rows wear. Rewording that sentence to name the *distance* rather than the code would be a change to
  the shadow prose, not to this rule, and is the natural next increment if it bites.
* **`ip default-network` is not modelled.** On IOS it stars a route to a non-zero network (doc 16448:
  `S* 192.168.1.0/24`) and that network then competes for the gateway of last resort. The engine has no
  `ip default-network`, so its only candidates are `0.0.0.0/0` rows. What would settle the wider rule: a
  decision to model `ip default-network`, at which point `candidateDefault` becomes "flagged by
  default-network OR prefix 0.0.0.0/0".
* **The protocol suffixes are not reproduced.** IOS prints `O*E2` and `D*EX`; this engine has one OSPF
  route type and no EIGRP, so a learned default would print `O*` or `B*` - the star in the right place,
  the suffix unmodelled. Not fixable without modelling external route types, which is a larger question
  than this one.
