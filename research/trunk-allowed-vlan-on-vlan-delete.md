# `no vlan 22` while a trunk's allowed list names 22: does the box refuse, and what happens to the list?

**Question (one, narrow).** On a Cisco IOS switch with a trunk configured as
`switchport trunk allowed vlan 10-30`, what happens when somebody types `no vlan 22` in global
configuration? Two halves: (a) does the box accept the command at all, or refuse it because a port still
carries the VLAN; and (b) does the configured allowed list change - does the box rewrite
`allowed vlan 10-30` into `10-21,23-30`, or does the line stay exactly as it was typed and only the
*active* membership drop 22?

**Verdict: (a) no refusal - the command is accepted; (b) unresolved, and nothing in `engine/` was changed.**
No vendor document found shows a refusal, and the published deletion procedure is unconditional even when
access ports are assigned to the VLAN. What the *allowed list* does afterwards is a different question, and
the evidence in hand does not answer it: the vendor describes trunk membership as a three-part test
(VLAN exists, VLAN enabled, VLAN in the list) rather than describing any edit to the list, which points one
way, but no transcript of `show running-config interface` after the deletion exists in any source found.
PacketForge currently refuses the whole command, with a sentence no box prints, and that refusal is the
invented half this note records.

## What PacketForge does today

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
% VLAN 22 is still carried by 1 port(s): Fa0/3 - move them off it first
```

The VLAN survives; `show vlan brief` still lists `22 voice`; the trunk is untouched. The refusal is deliberate
and its reason is written beside it (`engine/cli.js:1419`): *"deleting a VLAN does rewrite a trunk's allowed
list on the device, and the evidence for how is not good enough to model yet, so the refusal stays rather than
inventing it."* Three sibling refusals come from the same guard - a trunk native VLAN
(`Fa0/2 (native)`), an allowed list staged on a port that is not in trunk mode, and a voice VLAN - and they are
pinned by `test/vlan-delete-leaves-port-inactive.test.js:125` and
`test/show-interfaces-port.test.js:151,161,207`.

## Evidence

| Source | Says |
| --- | --- |
| [Catalyst 2960 12.2(55)SE, "Configuring VLANs"](https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst2960/software/release/12-2_55_se/configuration/guide/scg_2960/swvlan.pdf) | The whole procedure for deleting a VLAN is: `configure terminal`, `no vlan vlan-id` - "Remove the VLAN by entering the VLAN ID" - `end`, `show vlan brief`. The only caution is "When you delete a VLAN, any ports assigned to that VLAN become inactive. They remain associated with the VLAN (and thus inactive) until you assign them to a new VLAN." No precondition about trunks, no refusal, and no mention of any interface line being rewritten. |
| [Catalyst 3560 12.2(50)SE, "Configuring VLANs"](http://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst3560/software/release/12-2_50_se/configuration/guide/scg/swvlan.pdf) | The same section plus the VTP sentence: "When you delete a VLAN from a switch that is in VTP server mode, the VLAN is removed from the VLAN database for all switches in the VTP domain." Deletion is a *database* operation; the page then describes the allowed list as something the operator configures and VTP consults, never as something deletion edits. |
| [Catalyst 9200 16.11, "Configuring VLANs - Deleting a VLAN"](https://www.cisco.com/c/dam/en/us/td/docs/switches/lan/catalyst9200/software/release/16-11/configuration_guide/vlan/configuring_vlans.html) | The same caution, word for word, in a current release of the platform family this console models. Still no precondition and no refusal. |
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

* **The box accepts `no vlan 22`.** Confidence high, on (1) and (2). The refusal in PacketForge is a
  modelling convention that reads as a device sentence, and it is the one thing here that is certainly not
  device behaviour: `% VLAN 22 is still carried by 1 port(s): Fa0/3 - move them off it first` is this console's
  prose, not an IOS string.
* **The allowed list most probably survives verbatim**, i.e. `show running-config` still reads
  `switchport trunk allowed vlan 10-30` and `show interfaces Fa0/3` prints `allowed 10-30`, while the VLAN
  simply stops being carried. This is the reading that follows from (2)-(5). It is *inference*, not evidence:
  the mechanism is identical to the access-port case, where the vendor says outright that the port "remembers
  what VLAN it is assigned to" after the VLAN is gone.

## What is unresolved

1. **Whether the running-config line is rewritten.** No transcript found shows `show running-config interface`
   after `no vlan` on a switch whose trunk had a restricted allowed list. `switchport trunk allowed vlan
   remove 22` would produce `10-21,23-30` (the list is stored expanded on some platforms and as typed on
   others), and it is conceivable that a deletion is implemented as the same list edit. Nothing found says so.
2. **The native VLAN**, the staged allowed list on a non-trunk port, and the voice VLAN - the other three
   references PacketForge refuses on - are equally unexamined. A native VLAN naming a deleted VLAN has no
   documented outcome at all: the guide's only claim is that the port cannot be a member of a VLAN VTP does not
   know.
3. **Trunks allowing `all`.** If the model ever stops refusing, the difference between "list is `all`"
   (nothing to rewrite) and "list is explicit and contains 22" (something to rewrite) becomes the interesting
   one, and only a real paste distinguishes them.
4. **What the trunk shows while the VLAN is gone:** whether `show interfaces trunk` keeps 22 in
   `Vlans allowed on trunk` (it should, if the list is configuration) and whether the port's
   `switchport trunk allowed vlan` line is printed unchanged by `show running-config`.

## What evidence would settle it

One console paste. On any Catalyst with a trunk whose list is explicit:

```
vlan 22
interface Gi1/0/1
 switchport mode trunk
 switchport trunk allowed vlan 10-30
exit
no vlan 22
show running-config interface Gi1/0/1     ! 10-30, or 10-21,23-30?
show interfaces Gi1/0/1 trunk             ! 22 in "allowed", absent from "allowed and active"?
show vlan brief                           ! 22 gone, trunk not listed either way
```

That single paste answers (1), (4) and the `all` variant (repeat with `no switchport trunk allowed vlan`), and
it is enough to make the change below with a clear conscience. A second paste with the VLAN as the trunk's
* native* VLAN would cover the sibling refusal.

## What would change if that paste arrives

Nothing in this note touches `engine/`, on the rule this loop works to - an invented refusal is the honest
position while the alternative is an invented rewrite. If the paste shows the list untouched, the change is:

* `no vlan <id>` stops refusing for the live-trunk case, and instead removes the VLAN, leaves the allowed
  list (and the native VLAN) exactly as configured, names the trunks that stop carrying it in the receipt, and
  keeps the existing refusals for the *staged* cases until those are settled too;
* the data path must drop frames in a VLAN that is not in the database even when a trunk's allowed list names
  it - the same predicate `Device.inactiveVlan()` already supplies for access ports;
* `test/vlan-delete-leaves-port-inactive.test.js` and `test/show-interfaces-port.test.js` lose their
  "still carried" assertions and gain the transcript's observables.
