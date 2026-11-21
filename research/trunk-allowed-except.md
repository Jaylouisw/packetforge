# `switchport trunk allowed vlan except <list>`: what it stores, and whether it edits anything

**Question (one, narrow).** `switchport trunk allowed vlan` accepted a list, `all`, `add <list>` and `remove
<list>`, and refused every other word in front of the list — including `except`, which a vendor's own grammar
lists as one of the command's verbs. So: what does `except <list>` actually set, and how does the resulting list
differ from the one `remove <list>` on a default trunk produces?

**Verdict: known and adopted.** `except` is a verb of this command, and it is the only one that is not an edit:
it **replaces** the list with the inversion of the ids named, over the id space a trunk's default list covers
(1-4094), whatever the port carried before. The arithmetic is the same one `remove` on an `all` trunk already
performs, and a vendor lab transcript prints exactly that list: `except 1,999` → `2-998,1000-4094`.

## The grammar, from the command reference

Catalyst 9300, 17.12, *VLAN Commands* → `switchport trunk` → Usage Guidelines, verbatim:

> The vlan-list format is `all | none | [add | remove | except] vlan-atom [,vlan-atom...]` :
> * `all` specifies all VLANs from 1 to 4094. This is the default. …
> * `none` specifies an empty list. This keyword is not allowed on commands that require certain VLANs to be
>   set or at least one VLAN to be set.
> * `add` adds the defined list of VLANs to those currently set instead of replacing the list. …
> * `remove` removes the defined list of VLANs from those currently set instead of replacing the list. …
> * `except` lists the VLANs that should be calculated by **inverting** the defined list of VLANs. (VLANs are
>   added except the ones specified.) Valid IDs are from 1 to 1005. …
> * `vlan-atom` is either a single VLAN number from 1 to 4094 or a continuous range of VLANs described by two
>   VLAN numbers, the lesser one first, separated by a hyphen.

* https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst9300/software/release/17-12/command_reference/b_1712_9300_cr/vlan_commands.html

Three things follow from that paragraph alone: `except` exists; it is not `add`/`remove` ("instead of replacing
the list" is said only of those two); and the value it computes is a conventional allowed list, not a stored
negation — the grammar's `vlan-atom` is still the vocabulary of a positive list.

The 2960-X platform guide writes the same verb in its procedure for the same command:

> `switchport trunk allowed vlan {add | all | except | remove} vlan-list`

* https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst2960x/software/15-2_3_e/consolidated_guide/b_1523e_consolidated_2960x_cg/m_vlan_trunk_cg_2960-x.html

## The list it produces, measured

The CCNPv7.1 SWITCH lab 3-1 transcript is the one capture of the answer found. The lab has VLANs 1..1002 with
999 suspended, disallows 1 and 999, and then reads the trunk:

```
DLS1(config-if-range)# switchport trunk allowed vlan except 1,999
...
ALS1# show interface trunk
Port      Vlans allowed on trunk
Fa0/7     2-998,1000-4094
```

* https://data.kemt.fei.tuke.sk/TechnologieNaBazePrepinanychSieti/Cvicenia/2024/CCNPv7.1_SWITCH_Lab3-1_VLAN-TRUNK-VTP_STUDENT.docx

That is the complement of `{1,999}` over 1-4094, printed with runs folded, and it runs **through**
1002-1005 in one range — which is what `remove` on a default trunk also leaves behind, because a switch does not
let those four ids leave a trunk's allowed list ("You cannot remove VLANs 1002-1005", Catalyst 6500 ISL trunking
guide, `research/trunk-allowed-reserved-vlans.md`).

The same course material states the keyword set in prose, and it is the only source found that says what `none`
is for:

> The full command syntax `switchport trunk allowed {vlan-ids | all | none | add vlan-ids | remove vlan-ids |
> except vlan-ids}` provides a lot of power in a single command. The optional keyword `all` allows for all
> VLANs, while `none` removes all VLANs from the trunk link.

* https://netacad.fit.vutbr.cz/wp-content/uploads/ccnp/ce1/CE1_M1-5.pdf

## What is inferred

* **The universe of the inversion is 1-4094, not the port's current list.** The capture above was taken on a
  port that had never had a list typed on it, so it shows only the default universe. The command reference's
  "inverting the defined list of VLANs" says nothing about the port's own list, and `except` is described as
  neither adding nor removing. PacketForge therefore replaces: `except 5` on a port allowing only `10` leaves
  `1-4,6-4094`, not `20,30`.
* **A named media default is answered, not performed.** No capture exists of `except 1002`. The documented rule
  is that 1002-1005 cannot be removed from a trunk, and this console already answers a *named* `remove 1002`
  with that sentence and leaves the list alone; `except 1002` gets the same answer, since an inversion that
  dropped 1002 would be the same forbidden removal by another route.
* **What the backup prints.** PacketForge stores and prints the computed list (`switchport trunk allowed vlan
  2-998,1000-4094`), as it already does after `remove` on an `all` trunk. Whether a real box keeps the word
  `except` in `show running-config` was not established — see below.

## What is unresolved

1. **The running-config form.** Does a Catalyst print `switchport trunk allowed vlan except 1,999`, or the
   expanded `2-998,1000-4094`? One `show running-config` after the lab's own command would settle it, and if the
   box keeps the verb, this console's stored form (a positive list) is a defensible simplification but not a
   copy.
2. **`except` naming a media default.** The sentence printed for `except 1002` is the console applying a rule it
   has evidence for, not a transcript. A capture would say whether the box refuses, re-adds the four ids, or
   accepts a list without them.
3. **Extended-range ids in an `except` list.** The 9300 grammar line says "Valid IDs are from 1 to 1005" for
   `except`, exactly as it says for `add` and `remove` — and both of those carry a note that extended-range ids
   *are* valid on the allowed list. `except` carries no such note, while `vlan-atom` is defined as 1-4094. This
   console reads the list as 1-4094, the same way `add`/`remove` do.
4. **`none`.** Documented as "an empty list", and the console did not implement it when this note was
   written: an allowed list with no assignable VLAN was the dead trunk this project refused to build by
   subtraction. `none` is now accepted (`research/trunk-allowed-vlan-none.md`), and the full inversion commits
   the pinned remainder instead of refusing it (`research/trunk-allowed-remove-everything.md`). No capture
   shows what `show interfaces trunk` prints for a trunk in that state.

## What changed

* `engine/cli.js`: the allowed-list door reads `except` as a verb (`inverting`), parses the list with
  `keepReserved` like the other forms, and replaces the stored list with `vlanLib.allVlansExcept(<named,
  non-reserved>)`. The dead-trunk check is asked first (so `except 1-4094` reached it, not a sentence about
  1002); the follow-up run now commits that remainder instead of refusing it
  (`research/trunk-allowed-remove-everything.md`). A named media default gets the existing "cannot be removed"
  answer, and the reply names the ids the inversion left out:
  `Trunk on Fa0/1 allows VLANs 2-998,1000-4094 (all but 1,999)`. The refusal that used to list four forms now
  lists five.
* `test/trunk-allowed-except.test.js`: the lab's string, replacement-not-subtraction, the pinned-default
  answer (the dead-trunk answer was later replaced by acceptance, `research/trunk-allowed-remove-everything.md`),
  the backup round-trip (the printed line typed back is a no-op), the mode note, and the word-after-the-verb
  cases.
* `test/trunk-allowed-add-remove.test.js` asserted `% Unrecognized "except"` as the example of a word the
  console quotes back; that assertion was the defect, so the example is now `banana` and `except` is listed
  among the forms.
* `docs/CLI.md` and `docs/ARCHITECTURE.md` describe the three verbs and no longer use `except 20` as the
  unknown-word example.
