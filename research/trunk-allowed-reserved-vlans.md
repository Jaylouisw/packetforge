# The four media defaults in a trunk's allowed list

**Question (one, narrow).** When `switchport trunk allowed vlan remove <list>` subtracts from a trunk that still
allows the default `all`, what happens to VLANs 1002-1005 - the FDDI and Token Ring defaults the switch is born
with? Are they in the remainder a box prints, or are they excluded from a vlan-list the way they are excluded from
an access port?

**Verdict: they are in the list, and they cannot be taken out of it.** A trunk's allowed list is a set of 802.1Q
tags over 1-4094; 1002-1005 are members of it by default and a switch documents that they cannot be removed. So
the remainder after a removal runs straight through them, and the publisher's own transcript of
`remove 5-10,12` + `add 7` on a c3550 prints `1-4,7,11,13-4094` - one run, not two.

PacketForge treated 1002-1005 as unnameable everywhere: the shared vlan-list parser failed on them, so the
allowed list was stored without them and the same removal printed `1-4,7,11,13-1001,1006-4094`. A line no box
prints, in the backup and in `show interfaces`, and a list that could not be typed back because the parser refused
it. Both halves were the same mistake: the rule that a *port* cannot sit in VLAN 1002 was applied to a *trunk's*
tag list, which is a different question.

## The device's own output

The transcript this repository already cites for the removal arithmetic, Cisco's TAC knowledge-base article on
defining the VLANs allowed on a trunk (c3550):

```
c3550(config-if)#switchport trunk allowed vlan remove 5-10,12
c3550(config-if)#switchport trunk allowed vlan add 7
c3550#show interfaces fastEthernet 0/2 trunk
Port        Vlans allowed on trunk
Fa0/2       1-4,7,11,13-4094
```

`13-4094` contains 1002-1005. If the box had dropped them the string would have been `13-1001,1006-4094`, which is
what PacketForge printed.

A second, older capture shows the same list being *set* with the block in it, and the same block surviving a
removal (Catalyst 6500/6000 ISL trunking guide):

```
Switch-A#show interfaces fastethernet 2/1 trunk
Port      Vlans allowed on trunk
Fa2/1     1-1005
...
Switch-A(config-if)#switchport trunk allowed vlan remove 1-1001
Switch-A(config-if)#switchport trunk allowed vlan add 2
Switch-A#show interfaces fastethernet 2/1 trunk
Port      Vlans allowed on trunk
Fa2/1     2,1002-1005
```

The same page states the rule in words: "VLANs 1-1005 are allowable on all trunk ports by default... You cannot
remove VLANs 1002-1005." And the removal that produced the second output is described as one that "removes all
removable VLANs from the trunk" - the four defaults are not removable.

## Evidence

| Source | Says |
| --- | --- |
| [Cisco TAC KB, *How to define the VLANs allowed on a trunk link*](https://community.cisco.com/t5/networking-knowledge-base/how-to-define-the-vlans-allowed-on-a-trunk-link/tac-p/4947136) | c3550 session: `remove 5-10,12` then `add 7`, `show interfaces fa0/2 trunk` answers `1-4,7,11,13-4094`. The four media defaults are inside the last run. |
| [Catalyst 6500/6000 ISL trunking guide](https://www.cisco.com/c/en/us/support/docs/switches/catalyst-6000-series-switches/10682-2.html) | `show interfaces fa2/1 trunk` prints `1-1005` on a default trunk; after `switchport trunk allowed vlan remove 1-1001` and `add 2` it prints `2,1002-1005`. "VLANs 1-1005 are allowable on all trunk ports by default... You cannot remove VLANs 1002-1005." The removal "removes all removable VLANs from the trunk". |
| [Catalyst 9300 command reference 17.12, VLAN commands](http://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst9300/software/release/17-12/command_reference/b_1712_9300_cr/vlan_commands.html) | The vlan-list format is `all` or `none` or `[add, remove, except] vlan-atom`, and `vlan-atom` is "a single VLAN number from 1 to 4094 or a continuous range". No carve-out for 1002-1005. The carve-out the same page does make is stated where it applies: "VLAN 1, VLANs 1002 to 1005, and extended-range VLANs (VLANs 1006 to 4094) cannot be pruned." |
| [Catalyst 9400 17.14 VLAN guide, *Configuring VLAN Trunks*](https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst9400/software/release/17-14/configuration_guide/vlan/b_1714_vlan_9400_cg/configuring_vlan_trunks.html) | "By default, a trunk port sends traffic to and receives traffic from all VLANs. All VLAN IDs, 1 to 4094, are allowed on each trunk." - the default the command writes is the full id space, media defaults included. |
| [Catalyst 6500 15.4SY VLAN chapter](https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst6500/ios/15-4SY/config_guide/sup2T/15_2_sy_swcg_2T/vlans.html) | The id table files 1002-1005 as **Normal** VLANs, "Cisco defaults for FDDI and Token Ring. You cannot delete VLANs 1002-1005" - reserved against deletion, not outside the id space. |
| [Cisco 6500 IPsec/VPN-services example](https://www.cisco.com/c/en/us/support/docs/security-vpn/ipsec-negotiation-ike-protocols/26284-lan-lan-vam-router.html) | A running configuration: `switchport trunk allowed vlan 1,100,1002-1005` and `switchport trunk allowed vlan 1,209,1002-1005`. The block is typed in real configurations. |
| [EtherSwitch Network Module configuration example](https://www.cisco.com/c/en/us/support/docs/interfaces-modules/network-modules/82156-ether-switch-nm-config.html) | On a platform that enforces the rule: `switchport trunk allowed vlan 100,200` answers "Command rejected: Bad VLAN allowed list. You have to include all default vlans, e.g. 1-2,1002-1005." The defaults are required members, not forbidden ones. |

## What is known

1. A trunk's allowed list includes 1002-1005 by default (`1-4094`), and a switch will not remove them.
2. The ids are legal `vlan-atom`s for the allowed list; the 1002-1005 exclusion is printed for the
   *pruning-eligible* list, which is a different list with a different rule.
3. Real configurations name the block: `switchport trunk allowed vlan 1,100,1002-1005`.
4. Removing every other id leaves exactly those four (the 6500 capture: `2,1002-1005`).

## What is inferred

* **What a box does with `remove 1002`.** The documented sentence is "You cannot remove VLANs 1002-1005", but no
  capture of the command *naming* one was found: the switches in the transcripts remove ranges that exclude them.
  PacketForge answers the named case with its own sentence (`% VLANs 1002 stay on every trunk: ...`) and leaves
  the list untouched, which is the shape of the documented rule; the exact wording a box uses is unverified.
* **A list that omits them.** Some platforms reject it outright ("Bad VLAN allowed list", above), others accept
  it and add the defaults. PacketForge does neither - it stores what was typed - because choosing one would be
  inventing a platform rule from a single EtherSwitch note. What it does *not* do is refuse them, which was wrong
  on every platform in the table.
* **The dead-trunk refusal.** `remove 1-1001,1006-4094` on a real box would leave `1002-1005`, a list no Ethernet
  port can join. This console keeps its own refusal there ("that would leave the trunk allowing no VLANs"), which
  is the console speaking, not the device; the alternative was a trunk that looks configured and carries nothing.

## What was changed

* `engine/vlan.js`: `parseVlanList(spec, { keepReserved: true })` - the allowed-list caller gets 1002-1005 back as
  ordinary members; the default stays strict, so `switchport access vlan 1002`, `switchport trunk native vlan
  1002` and `switchport voice vlan 1002` are refused exactly as before. `isCanonicalVlanArray` accepts them (a
  member list is not an assignable list), `allVlansExcept()` no longer deletes them, and `normalizePortConfig` /
  `validatePortConfig` read the allowed list with the new option.
* `engine/cli.js`: the allowed-list door parses with `keepReserved`; `remove` subtracts only removable ids and says
  so when a named id stays; the dead-trunk guard now asks whether any *assignable* VLAN is left, since a remainder
  of only the media defaults carries nothing.
* `test/trunk-allowed-reserved-vlans.test.js`: the c3550 string, the named-and-kept case, the accepted list form,
  the backup round-trip, and the doors that must stay strict.
* `test/trunk-allowed-remove-from-all.test.js` and `test/vlan.test.js` had asserted the old shape (`1002-1005` in
  no list at all, `13-1001,1006-4094` in the backup); those assertions were the defect and are flipped, with the
  vendor strings beside them.

## What would settle the rest

1. A capture of `switchport trunk allowed vlan remove 1002` on a Catalyst - the sentence, and whether the list
   changes. One command, and it turns the inferred half of this note into a documented one.
2. A capture of `switchport trunk allowed vlan 10,20` (a list that omits the defaults) on a 2960/9300: accepted,
   or "Bad VLAN allowed list"? The EtherSwitch note is the only source found on either side.
