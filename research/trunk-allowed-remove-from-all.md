# Pruning one VLAN from a trunk that still allows all of them

**Question (one, narrow).** A trunk port has never had an allowed list typed on it, so it is carrying the
default `all`. What does `switchport trunk allowed vlan remove <list>` do on that port - is it accepted, what
does the port carry afterwards, and what does the box print for it?

**Verdict: it is accepted.** The box subtracts the named VLANs from the list it is already carrying and starts
printing the remainder - `1-4,7,11,13-4094` after `remove 5-10,12` plus `add 7` on a c3550, from Cisco's own
TAC knowledge-base article. The list is printed with runs folded into ranges, which is why "all of them but
one" is one short line and not 4,090 numbers. PacketForge refused the command instead, with a sentence no
switch prints; it now does the subtraction and prints the list the way the box does.

## What PacketForge did before this run

```
s1(config-if)# switchport mode trunk
s1(config-if)# switchport trunk allowed vlan remove 10
% this trunk allows all VLANs: name the list it should allow instead (switchport trunk allowed vlan <list>)
```

The refusal was deliberate - the comment above it said so: *"all minus 10" is 4,093 ids. A console that stores
that has written a line no operator would type and no diff would survive.* The arithmetic was right and the
conclusion was wrong: the reason the line looks unreadable is that this console printed an allowed list as one
number per VLAN (`10,20,30`), which is not the shape a switch uses.

## Evidence

| Source | Says |
| --- | --- |
| [Catalyst 2960-X 15.2(2)E config guide, *Configuring VLAN Trunks*](https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst2960x/software/15-2_2_e/vlan/configuration_guide/b_vlan_1522e_2960x_cg/b_vlan_152ex_2960-x_cg_chapter_0100.html) | "By default, a trunk port sends traffic to and receives traffic from all VLANs. All VLAN IDs, 1 to 4094, are allowed on each trunk. However, you can remove VLANs from the allowed list". Its worked example, *Removing a VLAN from a Port*, is `interface gigabitethernet1/0/1` then `switchport trunk allowed vlan remove 2` then `end`, on a port whose list is the default. No error, no prior `allowed vlan` line. |
| [Catalyst 9200 command reference, `switchport trunk`](http://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst9200/software/release/17-18/command_reference/b_1718_9200_cr/vlan_commands.html) | The semantics, in words: "**remove** removes the defined list of VLANs from those currently set instead of replacing the list"; "The default for all VLAN lists is to include all VLANs"; "The no form of the allowed vlan command resets the list to the default list, which allows all VLANs". |
| Same page, *Allowed VLAN* usage note | "To reduce the risk of spanning-tree loops or storms, you can disable VLAN 1 on any individual VLAN trunk port by removing VLAN 1 from the allowed list. When you remove VLAN 1 from a trunk port, the interface continues to send and receive management traffic, for example CDP, PAgP, LACP, DTP and VTP, in VLAN 1." |
| [Cisco TAC KB, *How to define the VLANs allowed on a trunk link*](https://community.cisco.com/t5/networking-knowledge-base/how-to-define-the-vlans-allowed-on-a-trunk-link/tac-p/4947136) | A real session, and the one capture that settles both halves: `c3550(config-if)#switchport trunk allowed vlan remove 5-10,12` / `switchport trunk allowed vlan add 7` / `show interfaces fastEthernet 0/2 trunk` gives **`Fa0/2 1-4,7,11,13-4094`**. The removal ran on a default trunk, and the answer is the remainder with ranges folded. |
| [Catalyst 3650 thread, `show running-config interface` paste](https://community.cisco.com/t5/network-management/vmware-hosts-not-responding-on-catalyst-3650-switch/td-p/4389451) | A backup line in the same shape: `switchport trunk allowed vlan 1-3,100`. Ranges are what the *running config* prints, not only the trunk view. |
| [Catalyst 3750 12.2(52)SE config guide (PDF)](http://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst3750/software/release/12-2_52_se/configuration/guide/3750scg/swvlan.pdf) | The same `{add | all | except | remove}` form in an IOS 12.2 document, so the verb is not a quirk of one release train. |

## What is known

1. `remove` on a trunk that is still on the default list is accepted, and the result is the set difference
   between "all" and the named VLANs.
2. The top of that list is **4094**, not 1005: the c3550 transcript ends `13-4094`. Some older prose says
   "VLANs 1 through 1005 are allowed on each trunk by default" (the same TAC article says it), but the box that
   was actually asked printed 4094, so the default list is the whole assignable range.
3. The printed form folds runs into ranges: `1-4,7,11,13-4094`. A backup line is written the same way
   (`switchport trunk allowed vlan 1-3,100`).
4. `no switchport trunk allowed vlan` restores the default, and then nothing is printed in the running config.
5. Removing VLAN 1 is not an error - it is the documented way to stop a trunk carrying VLAN 1 for data, while
   control traffic keeps flowing in VLAN 1.

## What is inferred

* **The exact `show running-config` line after a removal.** No capture of that specific pair was found. The
  inference is that it is the same list as the trunk view (`switchport trunk allowed vlan 1,3-4094`), because
  the backup prints the effective list and the effective list is what `show interfaces ... trunk` prints. The
  c3550 transcript proves the effective list; the 3650 paste proves backups use ranges. Nobody published the
  two together.
* **A two-id run.** The transcript proves a run of four (`1-4`) folds and a single id (`11`) does not. Whether
  a pair prints `3-4` or `3,4` is not settled by any capture collected here; this simulator folds a pair, which
  is the same rule applied consistently and re-parses to the same list either way.

## What is unresolved

* **Removing a reserved VLAN.** The TAC article states "VLANs 1 and 1002 through 1005 are reserved VLANs and
  cannot be removed from any trunk link", which would mean `remove 1002` is refused or silently ignored. No
  transcript either way was found, and the engine already refuses the reserved block in every explicit list
  (`E_VLAN_RESERVED`), so nothing here depends on the answer. A capture of `remove 1002` on a 2960 would settle
  it.
* **The printed range across the reserved block.** The c3550 prints one continuous `13-4094`, i.e. it does not
  carve 1002-1005 out of the display. This console does, because its lists never contain them: the same
  configuration reads `1,3-1001,1006-4094`. It names exactly the VLANs the port carries, and `show vlan` prints
  1002-1005 as the reserved `act/unsup` rows either way, but the two strings differ. Nothing in the lab depends
  on it; a capture would tell us whether the split is worth matching.
* **`add` on an all-allowed trunk.** This console says "already allows all VLANs: add changes nothing" and
  leaves the field as `all`. Whether a real box converts the stored list to an explicit one on the first `add`
  is not known; no capture of `add` followed by `show running-config` on a default trunk was found.

## What this run changed

* `engine/cli.js` - the `remove` branch of `switchport trunk allowed vlan`: on a trunk still holding `all`, the
  new list is `allVlansExcept(removed)` instead of a refusal. Removing every assignable VLAN is still refused
  (a trunk carrying nothing is not a configuration this console will write), and `remove 1-4094` no longer
  answers `% Unrecognized "remove"` - the range is refused for the reserved VLANs it spans, which is the real
  reason.
* `engine/vlan.js` - `formatVlanList()` (runs folded into ranges) and `allVlansExcept()`. The running-config
  printer, the console's own replies and `switchportSentence()` use the folded form, so a trunk that removed
  one VLAN reads `allowed 1,3-1001,1006-4094` in one line instead of 4,089 numbers.
* `engine/vlan.js` - `normalizePortConfig()` and `vlanListIncludes()` skip re-parsing an array that is already
  sorted, unique and assignable, and cache the membership set per array. A list this long is classified once per
  frame per port, so the parser must not be in the data plane.
* `web/app.js` - the panel's mirror of `switchportSentence()` folds the list the same way, so the two views of
  one port cannot disagree (`test/switchport-agreement.test.js` compares them over 1,440 port states).
* `test/trunk-allowed-remove-from-all.test.js` - 45 checks: the device's answer, the backup line, the trunk
  sentence, ingress and egress decisions for a removed VLAN, the fold itself, re-typing the printed line back,
  `no switchport trunk allowed vlan`, the empty-list refusal, and a loose per-frame cost bound that fails if the
  parser goes back into the data plane.
* `test/trunk-allowed-add-remove.test.js` - the two checks that pinned the old refusal now pin the subtraction.
