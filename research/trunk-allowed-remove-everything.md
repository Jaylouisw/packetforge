# `switchport trunk allowed vlan remove 1-4094`: refused, or a trunk that carries nothing?

**Question (one, narrow).** A trunk is still on its default allowed list (`all`). An operator prunes it with
`switchport trunk allowed vlan remove 1-4094` (or the equivalent `remove 1-1001,1006-4094`, which spares the
four media defaults). Does a Cisco-style switch accept that line, and if it does, what is left in the allowed
list - `none`, the four media defaults, or an error?

This is the question `research/trunk-allowed-vlan-none.md` deferred ("what does a box print for that removal is
a second question, not this one"). The console refused the line:

```
s1(config-if)# switchport trunk allowed vlan remove 1-4094
% that would leave the trunk allowing no VLANs: name what it should carry instead (switchport trunk allowed vlan <list>) or restore it with "no switchport trunk allowed vlan"
```

**Verdict: accepted, and the subtraction is committed.** A `remove` is a set difference from the list the port
carries, and the default list is 1-4094. A box can also be put in a trunk-carrying-nothing state directly -
`none` is a documented keyword meaning "an empty list" and the command reference's own glossary says so - so an
empty (or media-defaults-only) remainder is a state the box has, not one it refuses to reach. The console now
commits it: `remove 1-1001,1006-4094` stores `1002-1005` (the four media defaults, which cannot be removed from
a trunk) and `remove 10,20` on a list of `10,20` stores the empty list that `none` stores.

## Evidence

| Source | Says |
| --- | --- |
| [Cisco Community, "Tagged only Management VLAN procedure"](https://community.cisco.com/t5/switching/tagged-only-management-vlan-procedure/td-p/4595901) | A working configuration posted in a thread: `interface gi5` / `switchport mode trunk` / `switchport trunk native vlan 1001` / `switchport trunk allowed vlan remove 1-4094`. The line is part of the config the poster is running, not a rejected attempt. |
| [Cisco Community, "CLI not view configuration for trunk port on SF350-48"](https://community.cisco.com/t5/switches-small-business/cli-not-view-configuration-for-trunk-port-on-sf350-48/td-p/3724303) | "I try remove all vlans with: `switchport trunk allowed vlan remove 1-4094` and than add wanted vlans: `switchport trunk allowed vlan add 10,11,54,55,512,599,1000,3407`" - the same prune-then-add practice on a Cisco small-business switch. |
| [Cisco Community, "Vlans allowed on trunk"](https://community.cisco.com/t5/switching/vlans-allowed-on-trunk/td-p/1889903) | A 4500 session prunes with `switchport trunk allowed vlan remove 2-4094` and then adds `7,88`; the poster's conclusion is "This allowed me to only pass vlan 1,7,88". The subtraction ran on the default list and left VLAN 1, exactly the arithmetic `remove` documents. |
| [Cisco, VLAN Configuration Guide, IOS XE 17.14.x (Catalyst 9400) - Configuring VLAN Trunks](https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst9400/software/release/17-14/configuration_guide/vlan/b_1714_vlan_9400_cg/configuring_vlan_trunks.html) | "By default, a trunk port sends traffic to and receives traffic from all VLANs. All VLAN IDs, 1 to 4094, are allowed on each trunk. However, you can remove VLANs from the allowed list" and the syntax is `switchport trunk allowed vlan { word | add | all | except | none | remove} vlan-list`, with `vlan-list` "either a single VLAN number from 1 to 4094 or a range of VLANs". Nothing narrows `remove` to a proper subset. |
| [Cisco, Command Reference IOS XE 17.13.x (Catalyst 9300) - VLAN Commands, `switchport trunk`](http://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst9300/software/release/17-13/command_reference/b_1713_9300_cr/vlan_commands.html) | The vlan-list glossary: "**all** specifies all VLANs from 1 to 4094. This is the default. … **none** specifies an empty list." The destination of a full removal is a documented list value. (The same page's caveat - `none` "is not allowed on commands that require certain VLANs to be set" - is about commands that require VLANs, not the allowed-list form, which defines `none` as a value.) |
| [Cisco TAC, "How to define the VLANs allowed on a trunk link"](https://community.cisco.com/t5/networking-knowledge-base/how-to-define-the-vlans-allowed-on-a-trunk-link/ta-p/3131083) | "VLANs 1 and 1002 through 1005 are reserved VLANs and cannot be removed from any trunk link." Used here only for 1002-1005: the same knowledge base's worked example removes 5-10,12 and prints a remainder that runs through 1002-1005. (VLAN 1's removal is separately documented as the way to stop a trunk carrying VLAN 1 for data - see [trunk-allowed-remove-from-all.md](trunk-allowed-remove-from-all.md).) |

## What is known

1. The verb is `remove`, the list is a `vlan-list` over 1-4094, and `remove` subtracts from what the port
   carries. Nothing in the syntax or its usage notes excludes the whole range.
2. `none` is a legal allowed-list value and means the empty list, so a trunk carrying no frame-carrying VLAN
   is a state the device can be in.
3. 1002-1005 cannot be removed from a trunk, so a subtraction that names them (or names every id) leaves
   them behind. `remove 1-4094` and `remove 1-1001,1006-4094` therefore reach the same list.
4. Two field configurations use the full removal as a normal step before adding the VLANs the link should
   carry, which is only possible if the line is accepted.

## What is inferred

* **That the printed list after a full removal is `1002-1005`.** No capture pairs `remove 1-4094` with
  `show running-config` on the same port. The inference is the subtraction plus the pinned-defaults rule: the
  four ids cannot come off, so they are what remains, and the backup prints the effective list
  (`switchport trunk allowed vlan 1002-1005`). If a box instead prints `none` (because the remainder cannot
  carry an Ethernet frame), the difference is one line of output and no forwarding behaviour - no frame can be
  in VLAN 1002-1005 on an Ethernet port either way.
* **That the console's receipt is ours.** `Trunk on Fa0/1 allows VLANs 1002-1005 (removed 1-1001,1006-4094)`
  is this console's sentence, like every other switchport receipt; a box prints nothing on success.
* **That `except 1-4094` behaves like `remove 1-4094`.** `except` inverts the named list over 1-4094, so the
  inversion of the whole space is the pinned remainder too. No capture of either form was found; the two are
  the same destination reached by the two verbs the same command defines.

## What remains unresolved

* **The exact line a box prints after a full removal.** A capture of `remove 1-4094` followed by
  `show running-config interface` and `show interfaces trunk` would settle whether the remainder is printed
  as `1002-1005` or as `none`, and whether the trunk view's `Vlans allowed on trunk` cell says `none`.
* **Whether IOS refuses a `remove` list that names a reserved id.** The knowledge base says 1002-1005 "cannot
  be removed"; this console keeps them and answers a list that names only them with the rule. A transcript of
  `remove 1002` on a 2960 would show whether the box warns, ignores the id, or refuses the line.
* **A sibling sentence found while testing, left for its own run.** On the default `all` list,
  `switchport trunk allowed vlan remove 1002` (a list naming only pinned ids) answers
  `Trunk on Fa0/1 allows VLANs 1-4094 (removed ); 1002 stay: …` - an empty `(removed )` clause. The narrower
  `remove` branch never had the "nothing removable was named" guard the explicit-list branch has; that is a
  wording defect about reserved-only removals, not about this question, and it is recorded here rather than
  folded into this change.

## What changed

* `engine/cli.js`, `_switchport()`:
  * the `remove` branch on a trunk holding `all` no longer refuses a subtraction that leaves no
    frame-carrying VLAN; it commits `allVlansExcept(removed)` (the four media defaults) and the existing
    receipt names the remainder and the pinned ids;
  * the `except` branch does the same when the inversion leaves only the media defaults;
  * the `remove` branch on an explicit list commits the empty list (the state `none` stores) when the last
    frame-carrying VLAN comes off, with the receipt `Trunk on <port> allows no VLANs (removed <list>)`; the
    backup prints `switchport trunk allowed vlan none`.
* `test/trunk-allowed-remove-from-all.test.js` (55 checks), `test/trunk-allowed-reserved-vlans.test.js`
  (31 checks), `test/trunk-allowed-except.test.js` (26 checks), `test/trunk-allowed-add-remove.test.js`
  (58 checks): the old refusals are replaced by acceptance, the stored list, the backup line, the
  prune-then-add sequence, and the empty-list path.
* `docs/CLI.md` and `docs/ARCHITECTURE.md`: the two places that documented the dead-trunk refusal now
  document the committed state.
