# What a port-channel charges the spanning tree: the aggregate rule, and the arithmetic nobody publishes

**Question (one, narrow).** When several ports are bundled into one port-channel, what path cost does the
spanning tree charge that bundle on a Cisco-style switch - and does this simulator's rule (the member's cost
divided by the number of members) produce a number the vendor could have printed?

**Verdict: the *rule* is settled - the cost comes from the port-channel's bandwidth, which is the sum of the
active members' bandwidths - and the *arithmetic* is not.** This engine divides and rounds down to the short
table's floor, which reaches a value (`1`) no vendor table could produce for a 3 Gb/s bundle, because the
vendor's own long-method number for a two-member bundle (10,000) is half of one member's (20,000), not the
table's cost for 2 Gb/s, and the short table has no row between 1 Gb (4) and 10 Gb (2) for an aggregate to
land on. Nothing in the engine was changed: the one number the engine could adopt is one no source states.

## What the vendor publishes

| Source | Says |
| --- | --- |
| [Cisco support doc 221588, "Change of EtherChannel Member Interface Causes Disruption"](https://www.cisco.com/c/en/us/support/docs/lan-switching/spanning-tree-protocol-stp-8021d/221588-change-of-etherchannel-member-interface.pdf) | A Catalyst 9600 with the long method, `show spanning-tree`: `Po1 Desg FWD 10000 128.3433 P2p`, `Po2 Desg FWD 20000 128.343 P2p <<< pathcost updated in po2`. The prose: "The addition or removal of the member interface of EtherChannel changes its STP port cost." So one bundle is charged 10,000 and another 20,000 **on the same box at the same time**, i.e. the number follows the bundle's member count, and 10,000 is exactly half of the 20,000 a single 1 Gb port costs in the long method. |
| [Cisco Community, "Cost stp for etherchannel"](https://community.cisco.com/t5/switching/cost-stp-for-etherchannel/td-p/2401310) (accepted answer, [also at /m-p/2401321](https://community.cisco.com/t5/switching/cost-stp-for-etherchannel/m-p/2401321)) | "The STP cost is computed from the bandwidth, and on EtherChannels, the bandwidth of the Port-channel interface is automatically updated to the sum of bandwidths of the active member interfaces. With two 1Gbps Ethernet interfaces, the total bandwidth is currently set to 2,000,000 [kb/s], and the STP cost is computed accordingly." Its table carries a row `N X 1 Gbps | 3 | 10,000` (old/short | new/long) and the sentence "any number of 1Gbps links will be a cost of 3". |
| [Cisco Business 350 CLI guide, Spanning Tree Commands](https://www.cisco.com/c/en/us/td/docs/switches/lan/csbms/CBS_250_350/CLI/cbs-350-cli-/spanning-tree-commands.html) | The only *documented* port-channel rule found: `Port-channel` - "Half the default cost based on Port-channel interface speed", for both the long and the short method. On a small-business OS, so it is a rule for that family, not for the Catalyst this model imitates. |
| [Catalyst 3750 configuration guide 12.2(52)SE, Configuring EtherChannels](https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst3750/software/release/12-2_52_se/configuration/guide/3750scg/swethchl.html) | "A spanning-tree reconvergence is not triggered unless there is a change in the EtherChannel bandwidth." The tree watches bandwidth, not membership - which is why a member going down or coming up can move the cost and move the root port. |
| [Catalyst 9500 command reference 17.13, Layer 2/3 commands](http://cisco.com/c/en/us/td/docs/switches/lan/catalyst9500/software/release/17-13/command_reference/b_1713_9500_cr/layer_2_3_commands.pdf) | `spanning-tree pathcost method` - "Command Default: short". The method this engine implements is the Catalyst default, so the question is about the short table. |

## What PacketForge does today

`engine/simulator.js` builds one logical port per bundle and charges it the member link's cost divided by the
number of members, then lets `portCost()` floor the result at the table's minimum:

```js
let cost = stpLib.costForSpeedMbps(link ? link.speedMbps : null);
if (members.length > 1) cost = Math.round(cost / members.length); // aggregate
```

Measured on two `generic-switch` boxes with a 1 Gb member link and the short table (4 for 1 Gb):

| Active members | This engine | 1 Gb member, short table | Long method, vendor evidence |
| --- | --- | --- | --- |
| 1 | 4 | 4 | 20,000 |
| 2 | 2 | (no row for 2 Gb) | 10,000 ([doc 221588](https://www.cisco.com/c/en/us/support/docs/lan-switching/spanning-tree-protocol-stp-8021d/221588-change-of-etherchannel-member-interface.pdf)) |
| 3 | 1 | (no row for 3 Gb) | (no source) |
| 4 | 1 | (no row for 4 Gb) | (no source) |
| 2 up, 1 shut | 2 | - | - |

Two things in that table are already right, and are asserted now: only members whose link is *up* are counted
("active member interfaces"), and a member coming up or going down changes the number.

One thing in it cannot be right under any reading of the sources: at three members the division reaches the
short table's floor of `1`, which is the cost of a **100 Gb** port. No table, and no formula that halves per
doubling (long: 20,000 -> 10,000 -> 6,667 -> 5,000), produces `1` for 3 Gb/s.

The `// aggregate` comment on that line is also wrong on its own terms: dividing a member's cost is not the
aggregate rule the vendor documents, which starts from the summed bandwidth. It is corrected to point here.

## What is known, what is inferred, what is unresolved

**Known.** (1) The cost is derived from the port-channel's bandwidth, which is the sum of the **active** members'
bandwidths. (2) In the long method a two-member 1 Gb bundle costs 10,000 and a one-member bundle 20,000 on the
same box, so the number falls as members are added and it falls by half when the bundle doubles. (3) The tree
reconverges on a *bandwidth* change, not merely on membership. (4) The short method is the Catalyst default.

**Inferred.** That the short method uses the same derivation - a monotonically falling cost between the 1 Gb row
(4) and the 10 Gb row (2) as the aggregate grows from 1 Gb to 10 Gb. The one short-method number in the sources,
`3` for a bundle of 1 Gb links, sits exactly in that interval, which is consistent with the inference and
inconsistent with simple division (2 at two members).

**Unresolved, and why nothing was changed.** Where `3` comes from, and what the short method gives for 2, 3, 4
and 8 members. The community answer's row is labelled `N X 1 Gbps` - "any number" - which cannot be a table
lookup and is not reproduced by any formula in hand; taken literally it says a two-member bundle costs 3 while
the long method on real hardware says a two-member bundle costs exactly half a member (10,000 / 20,000), i.e.
`2` if the short table were halved. Both readings are defensible, they differ at the number a `show
spanning-tree` would print, and the engine's own answer (2, then 1) agrees with neither at three or more
members. Adopting any of them would be inventing the number.

**What would settle it.** One switch running the short method (its default), two 1 Gb ports in a bundle, one
neighbour: `show spanning-tree` before and after the second member is added, and again after a third. Three
`Cost` values for the port-channel settle the whole table. A second capture with `spanning-tree pathcost method
long` on the same box would confirm the 20,000 -> 10,000 step independently of the TAC document.
