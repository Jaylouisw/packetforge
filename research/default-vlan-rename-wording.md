# Renaming VLAN 1: what an IOS switch actually prints

**Question (one, narrow).** When an operator tries to give the default VLAN a name - `vlan 1` then
`name Corp` in IOS's VLAN sub-mode, or the one-line `vlan 1 name Corp` this console accepts - what
does the box print, and is it one line? The rule itself (VLAN 1 cannot be renamed) is already
settled and already implemented; what was never sourced was the *sentence*.

**Verdict: the rule stands, and the wording is now the vendor's.** IOS refuses with

```
Default VLAN 1 may not have its name changed.
```

one line, no reason, no caret, no pointer at another command. This console printed a sentence of its
own invention (`% VLAN 1 is the default VLAN: it cannot be renamed (its name is "default")`) and the
documentation claimed the wording was covered by the sources for *deletion*; none of them print the
rename line. The engine now prints the vendor sentence, with the `%` the rest of the message family
carries (see "the one character not settled" below).

## What is known

| Source | Gives |
| --- | --- |
| [HowToNetwork, "VTP and VLANs Explained"](https://www.howtonetwork.com/technical/protocols/vtp/) | A full capture, prompt included: `VTP-Switch-1(config)#vlan 1` / `VTP-Switch-1(config-vlan)#mtu 1518` / `Default VLAN 1 may not have its MTU changed.` / `VTP-Switch-1(config-vlan)#name TEST` / `Default VLAN 1 may not have its name changed.` |
| [The same capture on howtonetwork.org](https://www.howtonetwork.org/switch/module-2/vlans-and-vtp-configuring-and-verifying-vlans/) | The same book's second hosting: not an independent witness of the text, only of its stability. |
| [Cisco Community thread, "Issue: Default VLAN 1 may not have its name changed."](https://community.cisco.com/t5/switching/issue-default-vlan-1-may-not-have-its-name-changed/td-p/3094819) | The operator's own subject line *is* the message, and the first reply confirms the rule: "VLAN 1 name cannot be changed. This is not a bug nor a 'Cisco thing-y'. This is the standard." |
| [CCNA chapter 2 flashcards](https://www.brainscape.com/flashcards/chapter-2-lan-switching-technologies-8600675/packs/14612744) | Exam question 118: "You receive the error `Default VLAN 1 may not have its name changed.`" Answer: "VLAN 1 is the default VLAN and it is not permitted by the IOS to change the VLAN in any way. This includes name change". |
| [VLAN slide deck, slide 25](https://www.scribd.com/presentation/711366322/Chapter-5-Virtual-LAN-VLAN) | A lab where two switches are told `vlan 1` / `name native`, with the same message printed for each: `Default VLAN 1 may not have its name changed.` |
| [Packet Tracer exercise document](https://www.scribd.com/document/834373417/Doc-for-it) | A step-by-step lab: "type vlan 1 and name v 1 ... Default VLAN 1 May not have its name changed." |

The sentence is therefore attested five times in three kinds of material (course text, exam bank, a
lab record), always in the same words with the same full stop. Four of them reproduce the command
that produced it, and one is a switch's own error being quoted as the subject of a support thread -
nobody writes that subject line from imagination.

That the *rule* holds is documented independently of the wording: Cisco's Catalyst 9000 VLAN
configuration guide says of the default VLAN, "You cannot delete or rename VLAN 1."
([C9000 VLAN Configuration Guide](https://www.cisco.com/c/en/us/td/docs/switches/lan/c9000/lyr2-fwd/vlan/vlan-configuration-guide/configure-vlan.html)),
and the NX-OS `name` command reference says "You cannot change the name for the default VLAN, VLAN 1,
or for the internally allocated VLANs."
([Nexus 5000 L2 command reference, `name`](https://www.cisco.com/c/en/us/td/docs/switches/datacenter/nexus5000/sw/command/reference/layer2/n5k-l2-cr/n5k-l2_cmds_n.html)).
What neither guide gives is the line the switch prints when you try.

## The one character not settled: the leading `%`

Every direct capture of *this* sentence above shows it **without** a `%`. Two sibling sentences from
the same message family carry one, in the same shape as the deletion refusal already implemented here
(`research/default-vlan-refusal-wording.md`) - `%Default ...`, no space after the `%`:

* `2960G(config-vlan)#state suspend` / `%Default VLAN 1 may not have its operational state changed.`
  (a Catalyst 2960G field capture, https://www.reddit.com/r/Cisco/comments/6ywwki/is_it_possible_to_remove_vlan_1/)
* `%Default VLAN 1 may not be deleted.` (four transcripts, in the note above)

IOS prints its error lines with a `%`; the course material that omitted it also renders every other
prompt and message in the same hand-typed block, and the exam-bank quote and the Community subject
line are both places a `%` is conventionally trimmed. The console prints the family's form,
`%Default VLAN 1 may not have its name changed.`: the words are the vendor's and the prefix is the
one both sibling messages and this console's own refusal family use. Nothing else about the line was
changed - no reason, no suggestion, no second sentence.

## What this console did, and what it does now

`vlan 1 name Corp` (the console has no VLAN sub-mode, so `name` is a keyword on the creating line)
used to answer

```
% VLAN 1 is the default VLAN: it cannot be renamed (its name is "default")
```

- a description of the box in words no box prints, and a parenthetical that restates the refusal as
  though the operator had asked what the name was. It was refused before anything was stored, and
  `show vlan brief` kept `1 default`; those two facts were already right and are unchanged.

It now answers `%Default VLAN 1 may not have its name changed.`, one line, and still stores nothing
(`engine/cli.js`, the `head === 'vlan'` branch; `test/default-vlan-is-not-deletable.test.js` asserts
the exact string, the untouched `show vlan` row, and the empty config record).

`vlan 1 name default` - naming it what it already is - is not a change and is still not an error.

## What remains unresolved

* **The `%` on this exact line.** No capture of the name-change sentence with a prefix is in hand. A
  capture from a box (or an IOSv/IOS XE transcript pasted raw) would settle it; the family evidence
  points one way and the direct captures the other.
* **The MTU sibling.** `Default VLAN 1 may not have its MTU changed.` is attested by the same
  capture, but this console has no `mtu` command at all, so there is nothing here to print it for.
* **Renaming 1002-1005.** `vlan 1002 name fddi-x` is refused here as "reserved". Whether a real
  Catalyst accepts a `name` on a media default, or answers with the same `Default VLAN 1002 may not
  have its name changed.` family line, was not established - the sources found only cover deletion
  ("You cannot delete VLANs 1002-1005"). It is a separate question and is left alone rather than
  guessed at.
* **Which platforms say it.** The captures span 2960-class IOS and Packet Tracer. IOS XE and NX-OS
  document the rule, but no sample output of the refusal was found, so this note claims the wording
  for IOS, which is the CLI this console imitates.
