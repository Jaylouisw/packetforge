# `no vlan 1` / `no vlan 1002`: what does a Catalyst actually print?

**Question (one, narrow).** Every Catalyst refuses to delete VLAN 1 and VLANs 1002-1005. When the command
is refused, what is the sentence - character for character: is there a space after the `%`, does it end in a
full stop, does the VLAN's media name (`fddi-default`) appear in it, and what does a *range* print?

**Verdict: `%Default VLAN <id> may not be deleted.`** No space after the `%`, a full stop at the end, the
VLAN's number substituted, nothing else on the line, and **one line per VLAN** - a range prints the line once
for each default VLAN it could not remove (`no vlan 1-4094` yields five lines: 1, 1002, 1003, 1004, 1005).
Four independent sources agree, on IOS-XE-shaped and classic-IOS 2960-class switches, and the sentence is
the same for the media VLANs as for VLAN 1 with only the number changing. The media name is *not* in it.

The engine was answering in its own words instead (`% VLAN 1 is the default VLAN: every access port starts in
it and it cannot be deleted`, and a longer sentence for the four media defaults). That was true and it was not
what a box prints - `docs/CLI.md` already quoted the real sentence two paragraphs away from the console
contradicting it. This run replaced the paraphrase with the vendor's line.

## Evidence

| Source | Says |
| --- | --- |
| [pinglabz, "Native VLAN Configuration and Security on Cisco Switches"](https://www.pinglabz.com/change-native-vlan-cisco-switch/) | The decisive transcript, and it shows the survival too: `ACC-SW1# configure terminal` / `ACC-SW1(config)# no vlan 1` / `%Default VLAN 1 may not be deleted.` / `ACC-SW1(config)# end` / `ACC-SW1# show vlan brief \| include ^1` / `1 default active Et0/2, Et0/3`. IOS-XE-shaped (Et interfaces), and the refusal has no space after the `%` and a full stop at the end. |
| [Spiceworks Community, "Trying to understand my running config"](https://community.spiceworks.com/t/trying-to-understand-my-running-config/634153) | The same sentence for a media default, from a live box: `2960X-Gigabit#conf t` / `2960X-Gigabit(config)#no vlan 1002` / `%Default VLAN 1002 may not be deleted.` In the same post `show vlan brief` lists the four rows `fddi-default`, `token-ring-default`, `fddinet-default`, `trnet-default` as `act/unsup` - so the refused VLAN is not named in the refusal. |
| [Oracle Communications SDS Initial Installation and Configuration Guide (PDF)](https://docs.oracle.com/cd/F12285_01/docs.84/SDS%20Initial%20Installation%20and%20Configuration%20Guide.pdf) | The range case, on a Catalyst being reset to defaults: `Switch(config)#no vlan 2-1024` prints **four** lines - `%Default VLAN 1002 may not be deleted.` / `1003` / `1004` / `1005` - and the command otherwise succeeds (VLANs 2-1001 and 1006-1024 are removed). One line per default VLAN, not one line per command. |
| [Cisco Community, "Configure Replace (How to remove vlans?)"](https://community.cisco.com/t5/network-management/configure-replace-how-to-remove-vlans/td-p/1958786) | The widest range, and the count again: `SW1(config)#vlan 15` then `SW1(config-vlan)#no vlan 1-4094` prints five lines, `%Default VLAN 1 may not be deleted.` through `%Default VLAN 1005 may not be deleted.`, and VLAN 15 is still there afterwards. The same thread also shows the *interface* variant, with its different spacing: `% Default interface VLAN 1 may not be deleted.` |
| [Cisco Learning Network answer quoting a switch](https://learningnetwork.cisco.com/s/question/0D56e0000CQbNSHCQ3/hi-ive-doubts-for-this-question-refer-to-why-the-assigned-vlan-was-shutdown-option-its-correct) | Secondary, and worth having only for the prefix: independently reproduces `%Default VLAN 1 may not be deleted.` with the `%` hard against the `D`. A fifth copy of a line this short is weak evidence on its own; it is not what settled the question. |
| [Catalyst 2960-X 15.2(2)E configuration guide, "Configuring VLANs"](http://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst2960x/software/15-2_2_e/consolidated_guide/configuration_guide/b_1522e_consolidated_2960x_cg/m_vlan_vlan_cg_2960-x.html) | The **rule**, not the wording: "VLAN IDs 1 and 1002 to 1005 are automatically created and cannot be removed" and "You cannot delete the default VLANs for the different media types: Ethernet VLAN 1 and FDDI or Token Ring VLANs 1002 to 1005." This is what made the refusal necessary; it never shows the console's answer, which is why the paraphrase survived until a transcript turned up. |

## What is known, inferred, unresolved

**Known.** The deletion refusal is one sentence, `%Default VLAN <id> may not be deleted.`, printed once per
VLAN id that cannot be removed, with the vendor's own `%Default` prefix (no space) and a trailing full stop.
It is identical for VLAN 1 and for 1002-1005 apart from the number. The four media defaults are not named, and
nothing trails the sentence.

**Inferred.** That the sentence is stable across classic IOS and IOS XE: the transcripts span a 2960X on
15.2 and IOS-XE-shaped boxes, and the four-line range output in an Oracle install guide is a third, older
Catalyst. No transcript from a different platform family (NX-OS, CatOS, IOS XR) was used, so this claims
Catalyst IOS behaviour only - which is the family this model imitates.

**Unresolved.**

* **A single `no vlan 1002` on a box in VTP client mode.** Every transcript above is a standalone switch in
  the default VTP mode (the Oracle one a switch mid-reset). A VTP client may answer differently, or not at
  all, because the VLAN database is not its own. This model has no VTP, so nothing here depends on it.
* **The interface variant's exact spelling.** `no interface Vlan1` answers with a *different* message - one
  Cisco Community post shows `% Default interface VLAN 1 may not be deleted.`, with a space after the `%` and
  the word `interface` - a second door and a second sentence, not this one. Whether that spacing is stable
  across releases (it differs from the VLAN line inside the same thread) needs its own transcript.
* **Whether any release inserts the media name.** No source shows `fddi-default` inside a refusal; the name
  appears only in `show vlan` rows. Treated as settled-absent for the platforms above, not for all time.

**What would settle the open ones.** A capture of `no vlan 1002` on a VTP-client 2960, and of
`no interface Vlan1` beside `no vlan 1` on the same box in one session, so the two sentences can be compared
byte for byte.

## What was changed

* `engine/cli.js` - both branches of `no vlan` now return the vendor sentence verbatim:
  `%Default VLAN 1 may not be deleted.` for the default VLAN, `%Default VLAN <id> may not be deleted.` for
  each of the four media defaults. The rule and its reason stay in the comments and in `docs/CLI.md`; the
  console prints what a console prints. The refusal is emitted per id, which is the shape a range would need.
* `test/default-vlan-is-not-deletable.test.js` - the refusal is now asserted as an exact string equality,
  plus `%` immediately followed by `D` (the missing space, which is easy to "tidy" away) and the VLAN still
  present afterwards.
* `test/vlan-media-defaults.test.js` - each of the four media defaults is asserted equal to
  `%Default VLAN <id> may not be deleted.`, one line, with the number substituted; the old assertions on
  `cannot be deleted` and the media name are gone, because the box does neither.
* `docs/CLI.md` - both paragraphs now quote the sentence the console actually prints, and say why nothing is
  appended to it.
* `research/vlan-media-defaults.md` - its first open question ("the exact words a real box prints for
  `no vlan 1002`") is marked settled, pointing here.
