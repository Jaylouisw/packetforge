# `vlan 10-12`: is the argument an id, or a list — and what does this console answer?

**Question (one, narrow).** The global `vlan` command (and its `no` form) takes one word in this console, and
every other word is refused as "not a VLAN id". On a Catalyst, may that word be a **range** (`10-12`) or a
**comma-separated list** (`10,20`)? If it may, then the refusal
`% Invalid VLAN id "10-12": a VLAN id is a whole number from 1 to 4094` is not a refusal of an unmodelled form
but a false statement about IOS, and has to be reworded.

**Verdict: the argument is a list on a box — a single id, a comma-separated series, or a hyphenated range — and
the console's sentence claimed otherwise. The form is still not modelled here** (one `vlan` line creates one
VLAN; a list would create many and `no vlan` would need the same list, which is a capability rather than a
fidelity fix), **so the refusal now names the vendor's two spellings and the one-id-per-line form this console
takes instead, and states that nothing was changed.** No grammar was added; a false sentence was removed.

## Evidence

| Source | Says |
| --- | --- |
| [Catalyst 9300, IOS XE 17.16, *VLAN Commands* — `vlan`](https://cisco.com/c/en/us/td/docs/switches/lan/catalyst9300/software/release/17-16/command_reference/b_1716_9300_cr/vlan_commands.html) | The syntax description of `vlan-id`, word for word: "ID of the VLAN to be added and configured. The range is 1 to 4094. **You can enter a single VLAN ID, a series of VLAN IDs separated by commas, or a range of VLAN IDs separated by hyphens.**" The command's own syntax line is still `vlan vlan-id`, which is why the form is easy to miss. |
| [Catalyst 9600, IOS XE 17.7, *VLAN Commands* — `vlan`](http://cisco.com/c/en/us/td/docs/switches/lan/catalyst9600/software/release/17-7/command_reference/b_177_9600_cr/vlan_commands.html) | The same sentence, on a second platform family — so it is the command reference's description of the grammar, not one page's phrasing. The same page's `vlan-atom` description for the list-taking commands says "a single VLAN number from 1 to 4094 or a continuous range of VLANs described by two VLAN numbers, the lesser one first, separated by a hyphen" — the ordering rule this console already enforces on `switchport trunk allowed vlan` (`research/vlan-range-order.md`). |
| [Catalyst 6500, IOS 15.4SY, *Configuring VLANs*](https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst6500/ios/15-4SY/config_guide/sup2T/15_2_sy_swcg_2T/vlans.html) | The procedure writes the argument as a list: "Step 2 `Router(config)# vlan vlan_ID {[-vlan_ID]|[,vlan_ID]}`", and the prose distinguishes the two uses — "Enter the `vlan` command with an unused ID to create a VLAN. Enter the `vlan` command for an existing VLAN to modify the VLAN." |
| [Oracle Communications SDS *Initial Installation and Configuration Guide* (PDF)](https://docs.oracle.com/cd/F12285_01/docs.84/SDS%20Initial%20Installation%20and%20Configuration%20Guide.pdf) | Already quoted in `research/default-vlan-refusal-wording.md` for the deletion messages, and it is also a **transcript of the range form on the `no` door**: `Switch(config)#no vlan 2-1024` prints four `%Default VLAN ... may not be deleted.` lines and removes everything else. A box that answers a range by acting on each id has accepted the range. |
| [Cisco Nexus 3548, NX-OS 9.3(x), *Configuring VLANs* (PDF)](http://www.cisco.com/c/en/us/td/docs/switches/datacenter/nexus3548/sw/93x/layer-2-switching/configuration/guide/b-cisco-nx-os-3548-layer-2-switching-configuration-guide-93x/b-cisco-nx-os-3548-layer-2-switching-configuration-guide-93x_chapter_011.pdf) | A second OS family with the same form, and a worked example: "This example shows how to create a range of VLANs from 15 to 20: `switch(config)# vlan 15-20`", plus `show running-config vlan [vlan_id | vlan_range]`. Cited for the *shape* of the argument only; the wording this console models is Catalyst IOS. |

## What is known, inferred, unresolved

**Known.** On Catalyst IOS/IOS XE the `vlan` and `no vlan` commands accept a single id, a comma-separated
series, or a hyphenated range; the command reference states all three in the `vlan-id` description, two platform
families print the identical sentence, and a Catalyst transcript of `no vlan 2-1024` shows a range being acted on
id by id. It follows that a range is *not* an invalid VLAN id, and a console that says it is has misdescribed the
vendor's grammar — the failure mode this repository treats as a defect wherever a refusal speaks for the box.

**Inferred.** That the mixed form (`10-12,20`) is accepted, since the description names the two separators without
excluding their combination. Nothing here depends on it: every token with a separator is refused the same way.

**Unresolved, and deliberately not guessed at.**

* **What a box prints for `vlan 10-12` itself.** A box enters VLAN configuration mode and prints nothing, then
  `show vlan` lists the new rows; no capture of the exact prompt sequence was needed for this change because this
  console's receipts are its own (`VLAN 10 created (name: VLAN0010)`), not the vendor's.
* **Whether an invalid id inside a list aborts the whole line or applies the valid ones.** The Oracle transcript
  shows a range *partly* refused (four of 1,023 ids cannot be removed) and the rest applied, which is about
  deletion of protected ids, not about a malformed id (`vlan 10-4095`). It matters only to the unimplemented
  capability.
* **Whether `vlan 1-4094` is accepted whole** on a box that is in VTP server mode — the same class of question as
  the extended-range/VTP rule already recorded in `research/extended-vlan-creation-vtp.md`. Again: only the
  capability needs it.

## What was changed

* `engine/cli.js` — a new `_vlanListRefusal()` on the CLI, called by the two global doors (`vlan`, `no vlan`)
  before the per-id check. A token that is a range or a comma list — `/^[0-9]+([-,][0-9]+)+$/` — is refused with
  one line naming both vendor spellings and this console's one-id-per-line form, ending `nothing was changed` (or
  `nothing was removed` on the `no` door). Nothing is created, removed or stored. The three port doors
  (`switchport access vlan`, `switchport trunk native vlan`, `switchport voice vlan`) keep their existing
  sentences, because a port really does take a single VLAN there and their claims are true.
* `test/vlan-list-argument.test.js` — 37 assertions: the exact sentence at both doors; the list quoted back as
  typed; nothing created and nothing in `show vlan`, `show running-config` or the table; an existing VLAN
  surviving `no vlan 10-12`; the advice being actionable (`vlan 10`, `vlan 11`, `vlan 12` then create three);
  and every non-list token (`-5`, `1.5`, `abc`, `10-`, `10,`, `4095`, missing, `1002`) keeping the refusal it had.
* `docs/CLI.md` — the `vlan` section now separates the four single-id doors from the global command, quotes the
  vendor's sentence, and shows the new answer.
* `research/default-vlan-refusal-wording.md`'s observation that a range prints one line per protected id is now
  cross-referenced from here: it is the same transcript, read for the other fact.

## What is left, and what it would take

Creating (and removing) several VLANs from one command is a **capability**, so it is not in this change: it needs
a receipt per id in the console's own voice, a `no vlan <list>` that reports per id the way `%Default VLAN 1002 may
not be deleted.` already does, `show vlan` showing the batch, and a round-trip through `running-config`. The
evidence above is what such a change would be built on; nothing about today's refusal blocks it.
