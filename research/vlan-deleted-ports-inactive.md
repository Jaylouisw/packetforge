# When a VLAN is deleted, what happens to the ports that are in it?

**Question (one, narrow).** On a real Cisco-style access switch, does `no vlan 22` succeed while access ports
are assigned to VLAN 22, and what state do those ports end up in?

**Verdict: settled, and the console was wrong.** The VLAN is deleted; every access port on it keeps its
`switchport access vlan 22` line, becomes **inactive** (forwards nothing), disappears from `show vlan`, and
comes back to life when the VLAN is re-created. PacketForge refused the deletion instead - now it does not.

## What PacketForge did before this change

```
sw1(config)# no vlan 22
% VLAN 22 is still carried by 1 port(s): Gi1/0/1 - move them off it first
```

The refusal was deliberate and its motive was sound: with the port still assigned, `show vlan brief` built its
table from the port list, so the deleted VLAN would have reappeared as a row on a switch that no longer had it
- two descriptions of one switch that disagreed. The device avoids the same disagreement a different way: it
drops the row *and* the port, and marks the port inactive.

## Evidence

| Source | Says |
| --- | --- |
| [Catalyst 9200 Configuration Guide 16.11, Configuring VLANs - Deleting a VLAN](https://www.cisco.com/c/dam/en/us/td/docs/switches/lan/catalyst9200/software/release/16-11/configuration_guide/vlan/configuring_vlans.html) | Caution: "When you delete a VLAN, any ports assigned to that VLAN become inactive. They remain associated with the VLAN (and thus inactive) until you assign them to a new VLAN." The step text is `Device(config)# no vlan 4` - "Removes the VLAN by entering the VLAN ID", with no precondition about ports. |
| [Catalyst 6500 15.4SY, VLANs](https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst6500/ios/15-4SY/config_guide/sup6T/15_3_sy_swcg_6T/vlans.html) | Repeats it for the wider chassis: "any LAN ports configured as access ports assigned to that VLAN become inactive. The ports remain associated with the VLAN (and inactive) until you assign them to a new VLAN." |
| [IE3500 17.17, Configuring VLANs](https://cisco.com/c/en/us/td/docs/IIOT/switches/ie35xx/sw-config-guide/17-17/b_ie3500_1717-cg/configuring_vlans.html) and [ESS3300](http://cisco.com/c/en/us/td/docs/switches/lan/embedded/ess3300/software_config/b_vlan_ess3300_cg/configuring_vlans.html) | The same caution and the same `no vlan 4` step, thirteen years and three product lines apart. |
| [Cisco TAC, Troubleshoot Switch Port and Interface Problems](https://www.cisco.com/c/en/us/support/docs/switches/catalyst-6500-series-switches/12027-53.html) | "If that VLAN is deleted, then the port or interface becomes inactive." Shows `Access Mode VLAN: 11 ((Inactive))` from `show interfaces switchport`; "A port remembers what VLAN it is assigned to, even if the VLAN itself is deleted"; re-adding the VLAN makes the ports active again. |
| [Catalyst 2960 command reference - `shut` / `no shut`](https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst2960/software/release/15-0_2_se/command/reference/cr2960/cli3.html) | "The no shut command has no effect if the port is a static-access port assigned to a VLAN that has been deleted, suspended, or shut down. The port must first be a member of an active VLAN before it can be re-enabled." - the port's admin state cannot rescue it. |
| [Catalyst 9200 command reference 26.x, interface commands](http://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst9200/software/release/26-x/command_reference/b_26x_9200_cr/interface_and_hardware_commands.pdf) | `show interfaces status [inactive]` - "Displays interfaces in an inactive state", so `inactive` is a value the Status column really takes. |
| [Cisco Press, Switching, Routing, and Wireless Essentials 4.4](https://www.ciscopress.com/articles/article.asp?p=3089357&seqNum=7) | Transcript: `S1(config)# no vlan 10`, then `show vlan brief` without VLAN 10 - "port Fa0/6 has not been reassigned to the default VLAN"; `show interface fa0/6 switchport` -> `Access Mode VLAN: 10 (Inactive)`; "Re-creating the missing VLAN would automatically reassign the hosts to it." |

## What is now implemented

* `no vlan <id>` deletes the VLAN when the only ports on it are access ports, and names them as they go:
  `Gi1/0/1, Gi1/0/2 are now inactive: their access VLAN no longer exists (vlan 22 brings them back)`.
* `Device.inactiveVlan()` answers "is this access port waiting for a VLAN?"; `ifaceStatus()` reports such a port
  `down` / `down` with reason `inactive`, so `show interfaces` says `status: down (inactive)` and
  `show ip interface brief` says `down down`. The cable tests come after it: a deleted VLAN is not fixed by
  plugging something in.
* `show vlan brief` no longer lets a port resurrect its VLAN as a row, and the port is not listed under any
  other VLAN either.
* The data path refuses to carry a frame in or out of such a port (`_processFrame`, `_emitFrame`), and the MAC
  entries learned in the deleted VLAN are dropped (`Device.flushMacsOnVlan`).
* `vlan 22` re-creates the VLAN and the ports go back to work with no interface command, which is what the
  device does.

`test/vlan-delete-leaves-port-inactive.test.js` holds the control plane, the data plane and the restore.

## What remains unresolved (and why nothing was changed for it)

* **A trunk that carries the VLAN.** On the device, deleting a VLAN also removes it from a trunk's allowed
  list (a community answer says "the device will remove them from the uplinks allowed list"), but no primary
  source found states exactly what happens to a native VLAN, to a staged allowed list on a port out of trunk
  mode, or to a trunk allowing `all`. The console still refuses with
  `% VLAN 22 is still carried by 1 port(s): Fa0/4 - move them off it first` rather than guessing.
* **The canvas.** `web/faceplate.js` decides a port's colour and status text from asked facts - enabled,
  cabled, link down, peer enabled, STP blocked - and the published state payload carries no VLAN database, so
  a port whose access VLAN was deleted still reads `up` on the canvas while the console says `down (inactive)`.
  Closing that needs the VLAN database in the payload and a new fact in the shared state rule; it is a second
  change, not a line in this one.
* **Voice VLANs, private VLANs and SVIs** on a deleted VLAN were not examined at all.
* **VTP.** Every source above assumes a single box; in a VTP domain the deletion propagates, and this model has
  no VTP.

## What evidence would settle the trunk half

A console transcript showing `no vlan 22` on a switch with (a) a trunk allowing 22, (b) a trunk with native
VLAN 22, and (c) a port with a staged allowed list, followed by `show interfaces trunk` and
`show running-config interface` on each. Cisco's `switchport trunk allowed vlan` reference would be the
second-best source; the configuration guides only describe deleting a VLAN from the database.
