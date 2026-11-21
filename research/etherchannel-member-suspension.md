# A member whose switchport config differs from the bundle's: bundled, stand-alone, or suspended?

**Question (one, narrow).** One member of an existing EtherChannel is given a switchport configuration
that no longer matches the bundle - a different access VLAN, native VLAN, allowed-VLAN list or trunk
mode. What does the box do with that port: keep it in the bundle, drop it to the **independent**
("stand-alone", `I`) state this console already models, or **suspend** it (`s`)? And what does each view
then print? This console prints a warning when the port *joins* and then keeps hashing frames over it.

**Verdict: the member is suspended (`s`) and carries nothing; the port-channel stays up on its remaining
members (`Po1(SU)` beside `(P)` and `(s)`); and suspended is a different state from independent.** The
vendor's own field list separates them: `susp` is "not attached to any aggregator", `indep` is "not
bundled but able to handle data traffic". **Nothing was changed in this run**: the console's only
suspension-shaped state is the stand-alone one, and six call sites treat that state as "forwards as an
ordinary single link" - which is exactly what a suspended port does *not* do. The fix is a third member
state, not a letter-change in one table.

## Evidence

| Source | Says |
| --- | --- |
| [Layer 2 Command Reference, Catalyst 2960-X 15.2(3)E (PDF), `show lacp` field list](https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst2960x/software/15-2_3_e/b-layer-2-3-1523e-2960x-cr.pdf) | `susp—Port is in a suspended state; it is not attached to any aggregator.` / `indep—Port is in an independent state (not bundled but able to handle data traffic. In this case, LACP is not running on the partner port).` Two flags, two meanings, one page. |
| [Layer 2 Configuration Guide, Catalyst 2960-X 15.2(2)E, Configuring EtherChannels](https://cisco.com/c/en/us/td/docs/switches/lan/catalyst2960x/software/15-2_2_e/layer2/configuration_guide/b_layer2_1522e_2960x_cg/b_layer2_1522e_2960x_cg_chapter_0100.html) | Restrictions: "All ports in an EtherChannel must be assigned to the same VLAN or they must be configured as trunk ports." Guidelines: "Ports with different native VLANs cannot form an EtherChannel." / "If the allowed range of VLANs is not the same, the ports do not form an EtherChannel even when PAgP is set to the auto or desirable mode." Also names the compared fields: LACP groups "ports with the same speed, duplex mode, native VLAN, VLAN range, and trunking status and type". |
| [Catalyst 2960 Configuration Guide 12.2(46)SE, Configuring EtherChannels (PDF)](http://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst2960/software/release/12-2_46_se/configuration/guide/scg1/swethchl.pdf) | "Incompatible ports are suspended. Beginning with Cisco IOS Release 12.2(35)SE, instead of a suspended state, the local port is put into an independent state and continues to carry data traffic as would any other single link." - the *negotiation* case, and the sentence this console's `(I)` was built from (`engine/simulator.js`, `_logicalPortName`). |
| [0x2142, "L2 Basics: Configuring an EtherChannel"](https://0x2142.com/l2-basics-configuring-an-etherchannel/) | Live kit, after `switchport trunk allowed vlan 30` on one member only: `%EC-5-CANNOT_BUNDLE2: Et0/1 is not compatible with Et0/0 and will be suspended (vlan mask is different)`, and in prose: "Eth0/1 immediately gets put into a suspended state, and is no longer active in the port-channel interface." |
| [CCNP ENCOR EtherChannel lab (agent6)](https://agent6.github.io/CCNP-ENCOR-STUDY/labs/guides/ENCOR-ETHERCHANNEL/index.html) | A one-member allowed-VLAN mismatch on an otherwise working LACP bundle: "Po1 is up (SU) but one DIST-2 member shows `s` - suspended for a config inconsistency", and the repair (`switchport trunk allowed vlan 10,30,100,999` on Et0/1) returns it to `(P)`. The bundle's own row stays `Po1(SU)` throughout. |
| [RouteLearn, "Lab: EtherChannel with LACP"](https://routelearn.net/ccna/switching/lab-etherchannel) (documentation-based, states so itself) | `1 Po1(SU) LACP Gi1/0/23(P) Gi1/0/24(s)` beside the explanation "Gi1/0/24 is (s) suspended", and a table of the fields that must match: speed, duplex, mode, allowed VLANs, native VLAN. |
| [Cisco Community, "%EC-SP-5-CANNOT_BUNDLE2 - switch incorrectly sees port in DTP"](https://community.cisco.com/t5/switching/ec-sp-5-cannot-bundle2-switch-incorrectly-sees-port-in-dynamic/td-p/1819846) | Two further reason strings: `(trunk mode of Te2/1 is trunk, Te1/1 is dynamic)` and `(dtp nonegotiate of Te2/1 is 0, Te1/1 id 1)`; a reply quotes `Gi1/0/11 is not compatible with Po1 and will be suspended (vlan mask is different)` - the reference is the **port-channel**, not a member, when the difference is against Po1's own configuration. |
| [Cisco Community, "Question about Etherchannel configuration"](https://community.cisco.com/t5/switching/question-about-etherchannel-configuration/td-p/4485564) | `%EC-5-CANNOT_BUNDLE2: Fa0/2 is not compatible with Po1 and will be suspended (native vlan of Fa0/2 is 99, Po1 id 1)` - the native-VLAN reason, with both values printed. |

## What is known

* **Three states, three behaviours.** Bundled (`P`) forwards in the bundle; independent (`I`) forwards as
  an ordinary single link; suspended (`s`) is "not attached to any aggregator" and, in the transcript's
  words, "no longer active in the port-channel interface". The `I` state exists because 12.2(35)SE replaced
  *suspension* with *independence* for the port that gets no LACP answer - a different cause from a config
  mismatch, and the vendor keeps both words in the field list.
* **Suspension is a configuration-mismatch state, checked continuously.** The 0x2142 transcript changes one
  member of a working bundle (it is not a join-time check), and the agent6 lab restores `(P)` by making the
  member match again.
* **The bundle survives.** `Po1(SU)` with one `(P)` and one `(s)` is printed in two of the sources; only a
  bundle with no usable member goes `SD`.
* **Fields compared:** access VLAN, native VLAN, allowed-VLAN range, trunk mode/encapsulation, DTP
  nonegotiate, speed, duplex. Spanning-tree path cost is explicitly *not* one ("Ports with different
  spanning-tree path costs can form an EtherChannel if they are otherwise compatibly configured", 2960-X
  guide).
* **The box names the reference and the field** at the moment of the change, as a `%EC-5-CANNOT_BUNDLE2`
  syslog: `is not compatible with <other member | Po1> and will be suspended (<field> is different)`, with
  four observed reason shapes (`vlan mask`, `native vlan ... , Po1 id ...`, `trunk mode ...`, `dtp
  nonegotiate ...`).
* **It is not a link-down.** The port is up and administratively unchanged; `(s)` is not `(D)`.

## What is inferred

* **That the guide's "do not form an EtherChannel" is the `s` state**, not a refusal at the CLI. The guide
  states the rule; only the forum/lab captures print the flag the rule produces, and they all print `s`.
* **That a suspended member is dropped in both directions.** "Not attached to any aggregator" plus "no
  longer active in the port-channel interface" say so in words; no capture in hand shows per-port counters
  on the suspended member.
* **That `show running-config` still prints the member's `channel-group` line** - the configuration is
  unchanged, only the operational state. Implied by the negotiation case's "The port configuration does not
  change", not witnessed for suspension.
* **Which side is the reference.** `with Et0/0` (the other member) and `with Po1` (the port-channel) both
  appear, so the comparison is probably against the bundle's derived configuration when the bundle has one
  and against the first/lowest member when it does not. Not settled.

## What this console does today (measured at this base)

Two C2960s, `Fa0/1`-`Fa0/2` cabled pair-to-pair, `channel-group 1 mode active` on both ends - `Po1(SU)`,
both members `(P)`. Then, on `sw1` only:

```
sw1(config)# interface Fa0/2
sw1(config-if)# switchport access vlan 20
sw1(config-if)# end
sw1# show etherchannel summary
...
1      Po1(SU)         LACP      Fa0/1(P) Fa0/2(P)
```

Both members still read `(P)`: the mismatched member is bundled and carries its share of the hash, which
on the hardware it would not. The only trace is at join time, when the port is added to a group that
already holds a differently configured member:

```
% Warning: LAG 1: member(s) Fa0/2 are not VLAN-compatible; every member must be in the same VLAN set.
```

That sentence is `E_LAG_VLAN_MISMATCH`, an **error** in `lag.validateLag()` (`ok: false`), printed by the
console as a warning that does not refuse the join (`engine/cli.js`, `_channelGroupJoin`) - so one rule is
an error in the validator and a warning at the door. Neither path produces the state the box produces.

## Why this is not a one-line change

`lag.memberSuspension()` already answers "is this port standing outside the bundle?", and six call sites
consume its answer as **"so it forwards as an ordinary port"**:

* `engine/cli.js:5916` - `_lagMemberStates()`: reason text `(stand-alone: ...)`, letter `(I)`.
* `engine/cli.js:6973` - `show vlan` Ports cell: the port is dropped from the bundle and listed by its own
  name (correct for `I`, wrong for `s`, which is in no VLAN's forwarding path at all).
* `engine/device.js:798` - `macRows()`: the row is named by the physical port instead of `Po1`.
* `engine/segment.js:69` - the STP/forwarding predicate: a stand-alone port is its own STP port.
* `engine/simulator.js:897` - `_logicalPortName()`: same grouping question for the tree.
* `engine/simulator.js:3679` - egress: `if (!lag || memberSuspension(...)) egresses.push(name)`, i.e. the
  port is used as a single link. For a suspended port this would send traffic over a port the box has
  taken out of service - worse than today's silent bundling.

So the fix is a distinct verdict ("suspended `s`, reason") that the summary prints as `(s)` and the data
plane treats as *not an egress and not an ingress*. That is a new member state with its own answers for
`show vlan`, the MAC table and the tree - each of which the captures above do **not** settle. Adding it by
overloading `memberSuspension()` would make a suspended member forward, which is the opposite of the
vendor's definition.

## What remains unresolved

1. **The other views on a box with one suspended member.** A capture of `show etherchannel summary` with
   `show vlan brief`, `show spanning-tree` and `show mac address-table` on the same box would say whether
   the suspended port is still listed in its VLAN's Ports cell, whether the tree sees it at all, and
   whether entries learned through it survive. Two of the three are guesses today.
2. **Traffic, measured.** Per-member counters (`show interfaces Fa0/2 | include packets`) before and after
   the mismatch would confirm that a suspended member drops both directions rather than only egress.
3. **The reference port.** Why some messages name the other member and others name `Po1`; and whether the
   comparison is against the lowest port number, the first member, or the bundle's derived config.
4. **Whether the state is re-derived on load.** A saved board with mismatched members: does a box suspend
   on replay, and does the startup configuration keep the mismatch?
5. **A per-release wrinkle, adjacent but not this question.** The [Catalyst 2960-XR 15.2(7)E consolidated
   guide](http://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst2960xr/software/15_2_7_e/configuration_guide/b_1527e_consolidated_2960xr_cg/m_1522e_layer2_etherchanl_2960xr_xcg.html)
   says: "With CSCtn96950, by default, standalone mode is enabled. When no response is received from an
   LACP peer, ports in the port channel are moved to suspended state." That would make the `(I)` this
   console prints for a one-sided LACP group
   (`research/lacp-one-sided-group.md`) release-dependent - a second question, with its own capture.
