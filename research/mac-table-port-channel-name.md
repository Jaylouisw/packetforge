# `show mac address-table`: the port-channel, or the member the frame arrived on?

**Question (one, narrow).** When a source address is learned through an EtherChannel, which name does the
`Ports` column carry - the physical member the frame came in on (`Fa0/2`), or the logical bundle (`Po1`)?

**Verdict: the port-channel.** The CAM entry is keyed to the logical port, not to the member, and every
vendor example of the table prints `Po<n>`. PacketForge learned on the member the frame hashed to, so the same
address was reported on `Fa0/2` on one ping and `Fa0/3` on the next: a fact about one frame, printed where the
reader expects a fact about where the address is. Changed here.

## Evidence

| Source | What it says |
| --- | --- |
| [Cisco, *Catalyst 4500 Series Switch Cisco IOS Command Reference* - `show mac-address-table dynamic`](https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst4500/12-2/31sga/command/reference/cmdref/show1.html) | "The **show mac-address-table dynamic** command output for an EtherChannel interface changes the port number designation (such as, 5/7) to a port group number (such as, Po80)." The same sentence appears verbatim in the [12.2(20)EW](https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst4500/12-2/20ew/command/reference/cmdref/show1.html), [12.2(25)EWA](https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst4500/12-2/25ewa/command/reference/cmdref/show1.html) and [IOS XE 3.8/15.2(4)E](https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst4500/XE3-8-0E/15-24E/command/reference/xe-380-command/show1.html) editions - five releases, one rule |
| [Cisco, *Validate Layer 2 Hardware on Catalyst 9000 Series Switches* (C9400, IOS-XE 16.6.1)](https://cisco.com/c/en/us/support/docs/ip/layer-two-tunnel-protocol-l2tp/217923-validate-layer-2-hardware-on-catalyst-94.html) | after `show etherchannel summary` prints `1  Po1(SU)  LACP  Gi1/0/13(P) Gi5/0/21(P)`, the table reads `100 20bb.c05e.5318 DYNAMIC Po1` / `100 20bb.c05e.5351 DYNAMIC Po1` beside `100 0000.0200.0800 DYNAMIC Gi1/0/1`, closed by `Total Mac Addresses for this criterion: 3`. Same table furniture this model prints |
| [Cisco Community, "Exclude interface Po from show mac address-table" (Apr 2024)](https://community.cisco.com/t5/switching/exclude-interface-po-from-show-mac-address-table/td-p/5057191) | a live Catalyst's own output: `1 c829.c88a.d016 DYNAMIC Po1`, `1 c829.c88a.d017 DYNAMIC Po1` in VLAN 1 and `255 c829.c88a.d030 DYNAMIC Po1` in VLAN 255, interleaved with `Gi1/0/24` rows. The poster's complaint is that filtering the member interfaces still leaves the entries - because the entries were never on the members |
| [Cisco, *Catalyst 6500 VSS packet-flow tech note*](https://www.cisco.com/c/en/us/support/docs/switches/catalyst-6500-virtual-switching-system-1440/109638-vss-pf-tshoot.html) | `* 10 000a.000a.000a dynamic Yes 0 Po1`, with the note "the MAC-address ... is learned via Port-channel1. What this output does not show, however, is which link in the etherchannel is selected for a particular packet" - the vendor drawing exactly the distinction this change makes |
| [Cisco Nexus 5000/5500 NX-OS `show mac address-table` reference](https://www.cisco.com/c/en/us/td/docs/switches/datacenter/nexus5500/sw/layer2/command/cisco_nexus5500_layer2_command_ref/cisco_nexus5500_layer2_command_ref_chapter_01101.pdf) | `+ 100 0000.0001.0003 dynamic 0 F F Po1` - the same behaviour on a different operating system, so it is a property of the forwarding database and not of one CLI |

## What is known

1. The entry names the port-channel. The vendor states it as a rule, not an example, and the rule has not
   changed across five documented releases.
2. The member is not the answer even though the frame physically arrived there: the 6500 note says in as many
   words that the table will not tell you which member a given packet took.
3. The rest of the table is unaffected - VLAN, address, type and the total count are the same rows.

## What is inferred

4. **A member that never negotiated is named as itself.** Cisco: "Incompatible ports are put into an
   independent state and continue to carry data traffic as would any other single link" (*Configuring
   EtherChannels*). A port forwarding as an ordinary link should therefore be learned as one. This model
   already makes that call for spanning tree (`Simulator._logicalPortName`); the table now follows the same
   rule, and the passive/passive case is asserted in the test. No vendor transcript of the table in that state
   was found, so it is an inference from the forwarding behaviour, not a quoted output.
5. **A filtered view by the member port still finds the entry.** IOS accepts
   `show mac address-table interface <type> <slot/port>`; what it returns for a member of a bundle (the
   port-channel's entries, or nothing) is not documented anywhere I could find. This model answers with what
   was learned on that cable, which is the question the operator asked, and the note in the code says so.

## Unresolved

6. **`show mac address-table interface Po1` does not resolve here.** The bundle is not an interface object in
   this model (`lagFor()` returns `{id}`, and `Po1` is a *printed* name), so the filter name lookup refuses it.
   A real box accepts it. Fixing that means making a port-channel nameable wherever a port name is - a
   port-identity change, not a table change, and out of scope for one increment.
7. **`show spanning-tree` still prints `lag-1`** for the same bundle, where IOS prints `Po1`. The same naming
   gap, in a view whose surrounding format is already this model's own rather than the vendor's; it was left
   alone deliberately so this change is one rule in one table.
8. **A bundle whose far end has no channel group** remains the model's known open question
   (`research/lacp-passive-both-ends.md`): the two ends of that cable disagree on a real box, and this model
   has one opinion per member. Such a member is currently grouped under the port-channel in the table, because
   `memberSuspension()` returns null there - the same answer spanning tree gives it.

## Evidence that would settle 5, 6 and 8

A capture of `show mac address-table interface Fa0/2` and `... interface Po1` on a Catalyst with a working
two-member bundle, and the same two commands on a box whose LACP is passive at both ends. One transcript
would close all three.
