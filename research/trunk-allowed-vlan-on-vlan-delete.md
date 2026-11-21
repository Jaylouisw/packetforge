# `no vlan 22` while a trunk's allowed list names 22: does the box refuse, and what happens to the list?

**Question (one, narrow).** On a Cisco IOS switch with a trunk configured as
`switchport trunk allowed vlan 10-30`, what happens when somebody types `no vlan 22` in global
configuration? Two halves: (a) does the box accept the command at all, or refuse it because a port still
carries the VLAN; and (b) does the configured allowed list change - does the box rewrite
`allowed vlan 10-30` into `10-21,23-30`, or does the line stay exactly as it was typed and only the
*active* membership drop 22?

**Verdict: settled. (a) the box accepts the command; (b) it does not rewrite the allowed list.** Deleting a
VLAN is a VLAN-database operation, and the interface line is configuration - two operators answer the exact
question on Cisco Community in those words ("No, you need to remove it manually from the trunk interface";
"only deleting it ('no vlan 30') won't make it disappear from the interface's config") - and the vendor's own
trunk documentation makes membership *derived*: a trunk port "can become a member of a VLAN if the VLAN is
enabled, if VTP knows of the VLAN, and if the VLAN is in the allowed list". The list therefore stays exactly as
typed and the port stops carrying the VLAN, because the VLAN no longer exists. PacketForge refused the command
with a sentence no box prints; it now commits the deletion, leaves the switchport configuration untouched, and
drops frames for a VLAN the database does not hold, on ingress and on egress. The native-VLAN variant carries
the same line and is treated the same way, with no direct transcript - recorded under "what remains
unresolved".

## What PacketForge does today

Measured on this branch, one `C2960X`, a trunk with `switchport trunk allowed vlan 10-30`, `vlan 22` in the
database:

```
sw1(config)#vlan 22 name voice
VLAN 22 created (name: voice)
sw1(config)#interface Fa0/3
sw1(config-if)#switchport mode trunk
Switchport mode trunk on Fa0/3
sw1(config-if)#switchport trunk allowed vlan 10-30
Trunk on Fa0/3 allows VLANs 10-30
sw1(config-if)#exit
sw1(config)#no vlan 22
VLAN 22 removed
Fa0/3 stops carrying VLAN 22: the switchport configuration is unchanged (vlan 22 brings it back)
```

`show running-config` still prints `switchport trunk allowed vlan 10-30` and `switchport mode trunk` for the
port; `show interfaces Fa0/3` still prints `switchport: trunk · native 1 · allowed 10-30`; `show vlan brief`
has no row for 22.

What the change consists of:

* `no vlan <id>` no longer refuses for a **live trunk**. It deletes the VLAN, names the trunks that stop
  carrying it, and leaves `switchport trunk allowed vlan ...` and `switchport trunk native vlan ...` exactly as
  they were typed (`engine/cli.js`, the `head === 'vlan'` branch).
* The ports that only **reference** the VLAN - a native VLAN or an allowed list stored on a port that is not in
  trunk mode, or a voice VLAN - still refuse, in the same sentence as before. Nothing found says what a box
  does with a stored reference that is not in force, and this note is not the place to guess it.
* The data path drops a frame for a VLAN the database does not hold even when a trunk's list still names it,
  on ingress (so nothing is learned in a VLAN `show vlan` no longer prints) and on egress
  (`engine/simulator.js`, gated on `Device.knowsVlan()` and on the box being an L2 bridge, so a router's
  subinterfaces and a coupler's tagged frames are unaffected). Link-scoped LLDP is exempt, as it was from the
  allowed list (#1457).
* `test/vlan-delete-leaves-port-inactive.test.js` (39 checks) and `test/show-interfaces-port.test.js` (47)
  carry the transcript's observables: the receipt, the untouched backup, the drop counter and the MAC table.
  Two labs that used a native VLAN as a *mismatch* fixture (`test/switchport-mismatch.test.js`,
  `test/reason-names-the-box.test.js`) now create the id they name, because a native VLAN that does not exist is
  a fact of its own now.

## Evidence

| Source | Says |
| --- | --- |
| [Catalyst 2960 12.2(55)SE, "Configuring VLANs"](https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst2960/software/release/12-2_55_se/configuration/guide/scg_2960/swvlan.pdf) | The whole procedure for deleting a VLAN is: `configure terminal`, `no vlan vlan-id` - "Remove the VLAN by entering the VLAN ID" - `end`, `show vlan brief`. The only caution is "When you delete a VLAN, any ports assigned to that VLAN become inactive. They remain associated with the VLAN (and thus inactive) until you assign them to a new VLAN." No precondition about trunks, no refusal, and no mention of any interface line being rewritten. |
| [Catalyst 3560 12.2(50)SE, "Configuring VLANs"](http://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst3560/software/release/12-2_50_se/configuration/guide/scg/swvlan.pdf) | The same section plus the VTP sentence: "When you delete a VLAN from a switch that is in VTP server mode, the VLAN is removed from the VLAN database for all switches in the VTP domain." Deletion is a *database* operation; the page then describes the allowed list as something the operator configures and VTP consults, never as something deletion edits. |
| [Catalyst 9200 16.11, "Configuring VLANs - Deleting a VLAN"](https://www.cisco.com/c/dam/en/us/td/docs/switches/lan/catalyst9200/software/release/16-11/configuration_guide/vlan/configuring_vlans.html) | The same caution, word for word, in a current release of the platform family this console models. Still no precondition and no refusal. |
| [Cisco Community, "deleting VLAN" (solved, 2017)](https://community.cisco.com/t5/switching/deleting-vlan/td-p/3093024) | The question is this note's half (b), word for word: "if you delete a VLAN on a Cisco switch via 'no vlan x', will this automatically remove that vlan number from any 'switchport trunk allowed vlan x,x' commands in existence?" The accepted answer: "No, you need to remove it manually from the trunk interface." |
| [Cisco Community, "removing and deleting a vlan from a trunk"](https://community.cisco.com/t5/switching/removing-and-deleting-a-vlan-from-a-trunk/m-p/2564927) | An operator asks whether the VLAN can just be deleted from the switch or must come off the trunks first, and whether the deleted VLAN's line disappears. Answer: "It can (just be deleted from the switch), but only deleting it ('no vlan 30') won't make it disappear from the interface's config, which could cause confusion later..." - acceptance and the surviving line in one sentence, from the other end of the same question. |
| [Catalyst 9300 17.17, "Configuring VLAN Trunks"](https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst9300/software/release/17-17/configuration_guide/vlan/b_1717_vlan_9300_cg/configuring_vlan_trunks.pdf) | The membership rule, verbatim: "A trunk port can become a member of a VLAN if the VLAN is enabled, if VTP knows of the VLAN, and if the VLAN is in the allowed list for the port." Three conditions, and *existence in the VLAN database* is one of them - so a deleted VLAN stops being carried without the list having to change. The same paragraph says VTP adding a VLAN does **not** add it to the list. |
| [Catalyst 9500 17.13](http://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst9500/software/release/17-13/configuration_guide/vlan/b_1713_vlan_9500_cg/configuring_vlan_trunks.pdf) and [ESS3300](http://cisco.com/c/en/us/td/docs/switches/lan/embedded/ess3300/software_config/b_vlan_ess3300_cg/configuring_vlan_trunks.html) | The same sentence in two more product lines, so it is the trunk model rather than one platform's prose. |
| [Cisco Press, *Switching, Routing, and Wireless Essentials* 4.4, Example 4-29](https://www.ciscopress.com/articles/article.asp?p=3089357&seqNum=7) | A transcript where the two lists disagree, which is the useful part: `Port Vlans allowed on trunk / Fa0/1 1-4094` over `Port Vlans allowed and active in management domain / Fa0/1 1,10,20,99`. The first list is configuration ("all" means 1-4094 even when four VLANs exist), the second is what the database and STP leave of it. |
| [itpracticeexams, "802.1Q Trunking on Cisco"](https://itpracticeexams.com/kb/ccna/8021q-trunk-configuration/) | A secondary source that states the funnel explicitly: "Vlans allowed on trunk reflects configuration only. This list ignores whether the VLANs exist locally." Consistent with the Cisco transcript above, but it is a training page, not a vendor document. |
| [Cisco TAC, "Troubleshoot Switch Port and Interface Problems"](https://www.cisco.com/c/en/us/support/docs/switches/catalyst-6500-series-switches/12027-53.html) | The access-port half, already adopted: `Access Mode VLAN: 11 ((Inactive))`, "A port remembers what VLAN it is assigned to, even if the VLAN itself is deleted". Silent about trunks. |

## What is known

1. **No vendor document shows `no vlan` being refused.** Six configuration guides across four product lines
   describe the command as unconditional, and their caution is about ports going inactive, not about the
   command failing. That is an argument from absence, but from the documents that define the command.
2. **Deletion is a VLAN-database operation, and the allowed list is interface configuration.** The guides keep
   the two apart everywhere they touch them: VTP propagating a deletion changes the database; the allowed list
   is written by `switchport trunk allowed vlan` and read by the membership test.
3. **Membership is derived, not stored.** The 9300 sentence makes a trunk port's membership the *intersection*
   of enabled VLANs, known VLANs and the allowed list. Deleting the VLAN removes it from that intersection
   whatever the list says - no rewrite is needed for the observable "the trunk no longer carries 22".
4. **The two lists in `show interfaces trunk` are different objects**, which the Cisco Press transcript shows
   directly: `Vlans allowed on trunk` can be `1-4094` while `Vlans allowed and active in management domain` is
   four VLANs.
5. **VTP adding a VLAN does not add it to a trunk's allowed list** (same 9300 paragraph). If the forward
   direction does not edit configuration, the reverse direction editing configuration would be asymmetric.

## What is inferred

* **The native-VLAN variant.** `no vlan 22` while 22 is a trunk's native VLAN is accepted on the same ground -
  the procedure is unconditional, the command is a database operation, and the line is configuration - and the
  console prints the same receipt with the port marked `(native)`. No transcript pairs the two, so the claim
  that `switchport trunk native vlan 22` survives is an inference from the two allowed-list answers plus the
  general "config is not rewritten" rule. What the *frames* do afterwards is not inferred at all: a VLAN that
  does not exist carries nothing, so untagged frames filed into 22 are dropped, the same predicate the
  allowed-list case uses.
* **That `show interfaces trunk` would keep 22 in `Vlans allowed on trunk` and drop it from `Vlans allowed and
  active in management domain`.** That is what the two lists mean, and this console has no `show interfaces
  trunk` yet (`docs/plans/interfaces-trunk-view.md`, step 2 awaits approval), so the claim is untested here. It
  is why the console's receipt says the port *stops carrying* the VLAN rather than that it lost a line.

## What remains unresolved

1. **A paste of the native-VLAN variant**: the commands above with 22 as the trunk's native VLAN, then
   `show running-config interface` and `show interfaces ... trunk`. It would confirm the line survives and show
   which `Native vlan` cell the box prints.
2. **Ports whose reference is stored but not in force.** A native VLAN or allowed list on an access-mode port,
   and a voice VLAN, still refuse here. Whether a box rewrites those (it does not rewrite live ones) is
   unexamined, and the refusal is this console's sentence, not a device's.
3. **`switchport trunk allowed vlan all`.** Under the new rule the deletion is accepted with the whole trunk
   named in the receipt, and nothing is rewritten because there is no list to rewrite. A box would show the
   same - `all` is a keyword, not an expansion - but no capture confirms the keyword survives a deletion, and
   the model does not depend on it.
