# `switchport trunk allowed vlan none` — is "no VLANs" a list the box takes?

**Question (one, narrow).** A trunk port is asked to carry nothing: `switchport trunk allowed vlan none`.
Does a Cisco-style switch accept that word, what does it store, and what does it print afterwards - or is
"no VLANs at all" a state the box has no way to be put in, as this console assumed?

**Verdict: the box takes it, and `none` is documented as an empty list.** The `vlan-list` form is
`all | none | [add | remove | except] vlan-atom`, and the command reference's own glossary says
"**none** specifies an empty list". The word is in the syntax line of every IOS 15.x / 16.x / 17.x trunk
guide, and a box's `?` help prints `none  no VLANs`. PacketForge refused it
(`% Unrecognized "none": this console takes a list (10,20), a range (10-20), "all" …`) and the
running-config printer was built on the opposite assumption - its comment said an empty allowed list was
"the engine's unset, not a configuration: no command can produce it". One command produces it. Both are
changed here.

## Evidence

| Source | Says |
| --- | --- |
| [Cisco, *Command Reference, Cisco IOS XE 17.13.x (Catalyst 9300) - VLAN Commands*, `switchport trunk`](http://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst9300/software/release/17-13/command_reference/b_1713_9300_cr/vlan_commands.html) | *"The vlan-list format is `all | none | [add | remove | except] vlan-atom [,vlan-atom...]`: **all** specifies all VLANs from 1 to 4094. This is the default. … **none** specifies an empty list. This keyword is not allowed on commands that require certain VLANs to be set or at least one VLAN to be set."* Also: *"The **no** form of the **allowed vlan** command resets the list to the default list, which allows all VLANs."* The same text is in the 17.12, 17.14, 17.15 and 17.16 books and in the 9400 17.18 command reference |
| [Cisco, *VLAN Configuration Guide, IOS XE 17.15.x (Catalyst 9200)* - Configuring VLAN Trunks](https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst9200/software/release/17-15/configuration_guide/vlan/b_1715_vlan_9200_cg/configuring_vlan_trunks.html) | the configuration step is `switchport trunk allowed vlan { word | add | all | except | none | remove} vlan-list` - `none` beside `all` in the command the operator is told to type, on 9200, 9300, 9400, 9500 and 9600 |
| [Cisco, *Catalyst 2960-XR 15.2(2)E Consolidated Configuration Guide* - Configuring VLAN Trunks (PDF)](https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst2960xr/software/15-2_2_e/consolidated_guide/configuration_guide/b_1522e_consolidated_2960xr_cg/b_1522e_consolidated_2960xr_cg_chapter_0110101.pdf) | same syntax line on the classic fixed-configuration access switch, **and** *"To return to the default allowed VLAN list of all VLANs, use the **no switchport trunk allowed vlan** interface configuration command"* |
| [Cisco, *Catalyst 2960 12.2(53)SE Software Configuration Guide* - Configuring VLANs (PDF)](http://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst2960/software/release/12-2_53_se/configuration/guide/2960scg/swvlan.pdf) | the earlier book has **no** `none`: `switchport trunk allowed vlan {add | all | except | remove} vlan-list`. The keyword arrived with the 15.x images, which is the grammar the rest of this console's switchport handling follows |
| [Cisco Learning Network, "about trunk in switch"](https://learningnetwork.cisco.com/s/question/0D53i00000Kt2QbCAJ/about-trunk-in-switch) (practitioner transcript) | a box's own help, quoted verbatim: `Switch(config-if)#switchport trunk allowed vlan ?` … `all  all VLANs` / `except  all VLANs except the following` / `none  no VLANs` |
| [Cisco, *CBS 250/350 CLI guide - VLAN commands* (PDF)](http://www.cisco.com/c/en/us/td/docs/switches/lan/csbms/CBS_250_350/CLI/cbs-250-cli/vlan-commands.pdf) | a second Cisco CLI family, spelled out: *"**none** - Specifies an empty VLAN list. The port does not belong to any VLAN."* |
| [Connected Dots, *switchport trunk allowed vlan*](https://www.connecteddots.online/resources/cisco/switchport-trunk-allowed-vlan) | the same help table (`none  no VLANs`), plus a `sh run int gi0/1` capture: a non-default list prints `switchport trunk allowed vlan 10,20,30,55-60`, while *"after we set the allowed VLANs to 'all' the switchport trunk allowed vlan line will not appear in the normal output of the running-config command since the value is set to its default value"* |
| [Cisco, *Changing the Scope* (Nexus 9000 NX-OS guide)](https://www.cisco.com/c/en/us/td/docs/switches/datacenter/nexus9000/sw/7-x/nxdb/configuration/guide/b_Configuring_NXDB_for_Nexus_9000_and_Communicating_with_NSXv_Controllers/b_Configuring_NXDB_for_Nexus_9000_and_Communicating_with_NSXv_Controllers_chapter_0101.html), and [Ansible `cisco.nxos.nxos_l2_interfaces`](https://docs.ansible.com/projects/ansible/latest/collections/cisco/nxos/nxos_l2_interfaces_module.html) | NX-OS captures of `show running-config interface` after the command: `switchport mode trunk` / `switchport trunk allowed vlan none`. NX-OS, not IOS - it settles only that a box of this family *prints the word back*, not the IOS spelling |
| [Cisco, *Command Reference 17.15 (Catalyst 9300)* - `show interfaces trunk`](https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst9300/software/release/17-15/command_reference/b_1715_9300_cr/interface_and_hardware_commands.html) | the view's empty column is printed `none` (`Vlans allowed on trunk` / `… and active in management domain` / `… in spanning tree forwarding state and not pruned`), which is the word this console's `switchportSentence()` already used for an empty list |

## What is known

1. `none` is a keyword of `switchport trunk allowed vlan`, not a typo, and it means the empty list.
2. It is a *replacement*, like a bare list and like `all` - the verb set `add`/`remove`/`except` is a
   different part of the syntax line, so `none` stands alone.
3. `no switchport trunk allowed vlan` returns the list to `all`, which is the default.
4. An empty allowed list prints as the word `none` in the trunk views, not as `1002-1005` and not as nothing.
5. The keyword is not in the 12.2 SE 2960 book; it is in 15.2(2)E and in every IOS XE book checked.

## What is inferred

* **The running-config line.** No IOS capture of `show running-config` *after* `none` was found; the NX-OS
  captures print `switchport trunk allowed vlan none`, and the IOS rule the Connected Dots capture shows is
  that only a non-default allowed list is printed at all (`all` is omitted). `none` is non-default, so the
  line has to be printed - which is what this console now does. The inference is about the *spelling of the
  line*, not about whether there is one.
* **The media defaults.** `research/trunk-allowed-reserved-vlans.md` establishes that 1002-1005 are in every
  trunk's list and cannot be *removed*. `none` is not a removal; the command reference calls it an empty
  list, and the view prints `none` - not `1002-1005` - so the stored state is the empty list, and the four
  media defaults are not exempted from it. The two statements are about different operations and do not
  contradict each other, but see the first unresolved item below.

## What is unresolved

* Nobody has measured whether `show interfaces trunk` on an IOS box with an allowed list of `none` prints
  `none` while the port is operationally *trunking* (the 9300 example above is a port whose `Status` is
  `other`). The state is the same; only the row's status differs.
* `switchport trunk allowed vlan remove 1-4094` on a default trunk should reach the same empty list, since
  `none` is a legal destination. The console refused that removal as "would leave the trunk allowing no
  VLANs" - a sentence no box prints - at the time of this note; the follow-up run accepts it and commits the
  pinned remainder (`research/trunk-allowed-remove-everything.md`).
* `engine/vlan.js`'s `validatePortConfig()` still reported `E_TRUNK_NO_VLANS` for an empty allowed list when this
  note was written. No command path calls it on a whole port config (it is the import/API lint), so it could not
  refuse what the CLI accepts, but the two opinions about the same state disagreed. Reconciled in
  [trunk-allowed-none-is-not-an-error.md](trunk-allowed-none-is-not-an-error.md).

## What changed

* `engine/cli.js`, `_switchport()`: `switchport trunk allowed vlan none` is accepted and stores the empty
  list; the answer names what the port now carries. The refusal for an unknown word now lists `none` among
  the words the command takes.
* `engine/cli.js`, `show running-config`: a trunk whose allowed list is an explicit empty array prints
  `switchport trunk allowed vlan none` - the line an operator typed - instead of printing nothing. The line
  is emitted only in trunk mode: an access port normalises an unset list to `[]` and `switchport reset`
  leaves one behind, so the empty array alone does not prove a command produced it.
* No view needed changing: `switchportSentence()` already prints `allowed none` and `classifyEgress()`
  already drops every VLAN on an empty list.
* `test/trunk-allowed-none.test.js` (new) pins the word's acceptance, the stored state, all three views
  (`show interfaces`, running-config, the classifier), the replay of the printed line into a fresh session,
  the editing verbs from the empty state, `no` restoring `all`, and the two places an empty array is *not*
  a configuration.

## What evidence would settle the open items

A capture from any IOS/IOS-XE switch (`show interfaces <port> trunk`, `show interfaces <port> switchport`,
`show running-config interface <port>`) after `switchport trunk allowed vlan none` on a port that is really
trunking, and the same three views after `switchport trunk allowed vlan remove 1-4094`.
