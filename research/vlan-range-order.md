# A VLAN range typed high-to-low: does the box flip it, or refuse it?

**Question (one, narrow).** `switchport trunk allowed vlan 30-20` — a range whose two ids are the wrong way
round. Does an IOS-like box read it as `20-30` and carry on, or does it refuse the line and leave the trunk as
it was?

**Verdict: it refuses, and this console flipped it.** `engine/vlan.js` swapped the pair and carried on, so a
transposed range silently configured the VLANs the operator had *not* named:

```
sw1(config-if)#switchport trunk allowed vlan 30-20
Trunk on Fa0/1 allows VLANs 20-30        <- the port now carries 20-30
```

Every view then reported the swap as though it were what was typed — `show interfaces` said `allowed 20-30`
and the backup wrote `switchport trunk allowed vlan 20-30` — so nothing in the lab showed that the line had
been rewritten. It is now refused, in the console's own voice, with the two ids named back in the order that
would work:

```
sw1(config-if)#switchport trunk allowed vlan 30-20
% VLAN range 30-20 runs backwards: give the lower id first (20-30)
```

The refusal is the same for all three forms (`<list>`, `add <list>`, `remove <list>`) and leaves the allowed
list untouched, because all three reach the one parser.

## Evidence

| Source | Says |
| --- | --- |
| [Catalyst 2960-X 15.2(2)E config guide, *Configuring VLAN Trunks*](https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst2960x/software/15-2_2_e/vlan/configuration_guide/b_vlan_1522e_2960x_cg/b_vlan_152ex_2960-x_cg_chapter_0100.html) | "The *vlan-list* parameter is either a single VLAN number from 1 to 4094 or a range of VLANs described by **two VLAN numbers, the lower one first**, separated by a hyphen." |
| [Catalyst 9200 17.5 config guide, *Configuring VLAN Trunks* (PDF)](https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst9200/software/release/17-5/configuration_guide/vlan/b_175_vlan_9200_cg/configuring_vlan_trunks.pdf) | The same sentence, word for word, twelve releases later. |
| [Catalyst 3850 16.9 config guide, *Configuring VLAN Trunks*](https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst3850/software/release/16-9/configuration_guide/vlan/b_169_vlan_3850_cg/configuring_vlan_trunks.html) | The same sentence again, on a different platform, so the rule is the vlan-list grammar's and not one switch's. |
| [Catalyst 9500 16.6 command reference, `switchport trunk` / `vlan`](http://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst9500/software/release/16-6/command_reference/b_166_9500_cr/b_166_9500_cr_chapter_011000.pdf) | The `vlan-list` format is `all \| none \| [add \| remove \| except] vlan-atom [,vlan-atom...]`, and "If you enter an invalid VLAN ID, you receive an error message and do not enter VLAN configuration mode." A range that does not describe a set of VLANs is not a vlan-atom the grammar can read. |
| [Catalyst 2960 15.2(4)E command reference, `vlan`](https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst2960/software/release/15-2_4_e/command/reference/cr_2960/cli3.html) | The `vlan` command takes "a single VLAN ID, a series of VLAN IDs separated by commas, or a range of VLAN IDs separated by hyphens", and an invalid id is "an error message", not a normalised value. |
| [NX-OS 7000 5.x, *Configuring Layer 2 Interfaces*](http://www.cisco.com/c/en/us/td/docs/switches/datacenter/sw/5_x/nx-os/interfaces/configuration/guide/if_cli/if_access_trunk.html) | A worked example in the same shape — `switchport trunk allowed vlan 15-20` — always ascending; no Cisco document shows a descending range being accepted. |

## What is known

1. The vlan-list grammar is defined as an **ascending** range: "two VLAN numbers, the lower one first".
   That phrasing is identical across the Catalyst 2960-X, 3850 and 9200 configuration guides, spanning
   15.2(2)E to IOS XE 17.5.
2. An input the grammar cannot read is answered with an error message and no configuration change — the
   command references say so for the `vlan` command in as many words, and the `switchport trunk` reference
   repeats it for an invalid id.
3. No Cisco document, command reference or worked example shows a descending range being read as its
   reverse. The swap this console performed was not a documented behaviour that a reader could have checked;
   it was the parser being helpful.

## What is inferred

* **The box's exact sentence.** No capture of `switchport trunk allowed vlan 30-20` on real hardware was found
  — the searchable sources are vendor references and worked examples, and none of them shows a refused range.
  The refusal itself follows from (1) and (2); only its **wording** is unverified. The console therefore uses
  its own sentence, in the shape it uses for every other refusal here (`% <what is wrong>: <what would work>`),
  rather than inventing a Cisco string nobody has published.
* **Where the caret would land if the box answered `% Invalid input detected at '^' marker.`** The project
  deliberately does not print that message ([parse-error-caret.md](parse-error-caret.md)); the console quotes
  the offending input instead, and the range is quoted here for the same reason.

## Why this is a fidelity fix and not a new feature

`switchport trunk allowed vlan` already parsed ranges; the only question was what a transposed one means. Two
existing behaviours also pointed the same way and disagreed with the parser:

* the `vlan 10-5` command already **refuses** the same shape (`% Invalid VLAN id "10-5"`), so one door refused
  a transposed range and the other quietly reversed it;
* `engine/dhcp.js` already refuses a pool whose `rangeStart` is above its `rangeEnd`
  (`E_DHCP_RANGE_ORDER`), for the same reason: a range is an interval, and an interval that runs backwards is
  a typo, not a request.

## What remains unresolved

* The box's exact wording for a transposed range, and whether it is a careted parse error or a `%` sentence.
  A console capture from any Catalyst (or an IOS-XE device) would settle it; nothing public collected here
  shows one.
* Whether a box accepts `20-20` (a "range" of one). This console accepts it as VLAN 20; no source was found
  either way, and the value it produces is the same under any reading, so nothing was changed for it.
* Whether any *other* vlan-list consumer on a real box (pruning-eligible lists, `switchport voice vlan`) words
  the refusal differently. Only the trunk allowed list is modelled here, and it shares this one parser.
