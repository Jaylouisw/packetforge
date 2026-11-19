# `show vlan brief` and an access EtherChannel: is the port `Po1`, or its members?

**Question (one, narrow).** On a Cisco IOS-style switch, an EtherChannel whose members are access ports in
VLAN 10 is one logical interface. When the operator runs `show vlan brief` (or the first table of
`show vlan`), does the `Ports` cell for VLAN 10 read `Po1`, the physical member names (`Gi1/0/1, Gi1/0/2`),
or both? The question is only about the name in that cell; the forwarding rule and the EtherChannel summary
are already modelled.

**Verdict: unresolved for IOS, and the one IOS sample in hand names the Port-channel.** Cisco's own
`show vlan-switch` sample ends VLAN 1's `Ports` cell with `Gi4/0, Gi4/1, Po1` - the logical interface is a
port in the VLAN table. Two NX-OS `show vlan brief` captures likewise print `Po1` and never the bundle's
members. What no capture in hand shows is an IOS `show vlan brief` taken on a switch whose *only* ports in
the VLAN are the members of a working access bundle, so the exact rule ("members are not also printed") is
inference, not a transcript. No engine change was made on that basis.

## What PacketForge does today

Measured in this worktree on two C2960X-24TS-L switches, Gi1/0/1-2 cabled between them, both ends configured
`switchport mode access`, `switchport access vlan 10`, `channel-group 1 mode active`. The bundle is up and
both members are bundled:

```
a# show etherchannel summary
...
Number of channel-groups in use: 1
Number of aggregators:           1
Group  Port-channel  Protocol    Ports
------+-------------+-----------+-----------------------------------------------
1      Po1(SU)         LACP      Gi1/0/1(P) Gi1/0/2(P)

a# show vlan brief
VLAN Name                             Status    Ports
---- -------------------------------- --------- -------------------------------
...
10   VLAN0010                         active    Gi1/0/1, Gi1/0/2
```

The CLI has no `Port-channel1` interface object (`show interfaces Port-channel1` answers
`% No interface Port-channel1 ...`), so the VLAN table can only name the members it walks. The engine's
other two tables that meet a bundle already fold it to the logical name: the MAC table prints `Po1` for an
entry learned on a member (`research/mac-table-port-channel-name.md`) and `show spanning-tree` groups the
members under the bundle (`research/stp-port-channel-name.md`). `show vlan` is the view that does not.

No test covers VLAN membership on a LAG: `grep -n 'vlan' test/*lag* test/*port-channel*` is empty, and
`test/show-vlan.test.js`'s lab has trunks and access ports but no channel group.

## Evidence

| Source | Shows | What it settles |
| --- | --- | --- |
| [Cisco IOS LAN Switching Command Reference, `show vlan-switch`](https://www.cisco.com/c/en/us/td/docs/ios/lanswitch/command/reference/lsw_book/lsw_s2.html) | `Router# show vlan-switch` -> VLAN 1 `Ports` cell runs `Fa4/0 ... Fa4/35` then `Gi4/0, Gi4/1, Po1`, followed by the media table | On IOS, a `Port-channel` interface **is** a port in the VLAN table. The sample is an EtherSwitch module, not a fixed-config Catalyst, and it does not show whether `Gi4/0`/`Gi4/1` are the bundle's members or independent uplinks. |
| Same page, `show vlan all-ports` | "To display VLAN information for trunk and access ports, use the `show vlan all-ports` command" | The default view is a membership view, and trunks only enter it through a separate command. That is consistent with the existing rule in `research/vlan-brief-trunk-ports.md`: mode, not link state, decides the cell. |
| [Cisco Nexus 1000V Command Reference 4.2(1)SV2(1.1), Show Commands](https://www.cisco.com/c/en/us/td/docs/switches/datacenter/nexus1000/sw/4_2_1_s_v_2_1_1/command/reference/n1000v_cmd_ref/n1000v_cmds_show.html) | `n1000v# show vlan brief` -> `1 default active Po1, Po2, Po12, Veth1, Veth2` | A Cisco switch OS prints the **Port-channel** in the cell, not the member `Eth` ports. NX-OS, not IOS. |
| [NetApp ONTAP, "Power on your AFX 1K storage system"](https://docs.netapp.com/us-en/ontap-afx/install-setup/power-on-hardware.html) (Cisco Nexus 9336C-FX2) | `cs1# show vlan brief` -> `1 default active Po1, Po999, Eth1/31, Eth1/32 ...`, later `40 VLAN0040 active Po1, Eth1/1 ...` | A second NX-OS capture: `Po1` is listed alongside physical access ports, and the summary below shows `1 Po1(SU) ... Eth1/31(P) Eth1/32(P)` - so the bundle is named, not its two members. |
| [Cisco Community, "About show vlan brief command"](https://community.cisco.com/t5/switching/about-show-vlan-brief-command/m-p/1638396) | "Even if it is UP/DOWN or DOWN/DOWN, still it will be shown in the output." | An access port's link state does not remove it from the cell; only its mode/membership does. This is why the unconnected-trunk question in the sibling note settles the way it does. |
| [Cisco IOS LAN Switching Command Reference, `show vlan` field table](https://www.cisco.com/c/en/us/td/docs/ios/lanswitch/command/reference/lsw_book/lsw_s2.html) | `Ports` - "Ports that belong to the VLAN" | The cell is about interface membership, not about physical links; a bundle is one interface. |

## What is known

* On IOS, `show vlan-switch` names a `Port-channel` interface in a VLAN's `Ports` cell.
* On NX-OS, `show vlan brief` names the `Po` interface and does not name the members that make it up.
* `show vlan` / `show vlan brief` list **access** ports only; trunks need `show vlan all-ports` (and the
  single-VLAN form `show vlan id N` is the documented exception that prints both). This is already the
  model's rule.
* Link state does not remove an access port: a down/down access port is still printed.

## What is inferred

* That an IOS access bundle's cell reads `Po1` and **not** `Gi1/0/1, Gi1/0/2`. The inference is from the
  IOS `show vlan-switch` sample (Po1 is a port), the NX-OS brief captures (Po named, members not), and the
  meaning of the column (interface membership: the bundle is the interface the switch forwards on). It is
  not a transcript of the exact `show vlan brief` case.
* That a **suspended or standalone** member (a port that never joined the bundle) stays a port in its own
  right, because it forwards as an ordinary access port. This is the rule the MAC table already applies
  (`research/mac-table-port-channel-name.md`): a member that never negotiated is named as itself. No VLAN
  capture confirms it.

## What is unresolved

1. **The IOS access-bundle cell.** Does `show vlan brief` print `Po1`, the members, or both? No capture in
   hand shows an IOS switch whose only VLAN-10 ports are a working access bundle.
2. **`show vlan` (full) vs `show vlan id 10`.** The command reference says the single-VLAN form prints trunk
   and non-trunk ports while the multi-VLAN form prints only non-trunk ports. Whether the bundle's members
   appear in the `id` form (which shows trunks) is a second, separate row-set question.
3. **A bundle that is down or has no live member.** `show etherchannel summary` prints `Po1(SD)` and the
   members as `(D)`; does `show vlan brief` still print `Po1`, or fall back to the members? No sample.
4. **Mixed bundles.** A member suspended for a VLAN mismatch forwards as an ordinary port in some designs;
   whether the box then lists the member beside `Po1` is not shown by any capture read here.

## What would settle it

One paste from a 2960-X or 9200 with two spare ports and nothing else in VLAN 10:

```
configure terminal
vlan 10
interface range GigabitEthernet1/0/1 - 2
 switchport mode access
 switchport access vlan 10
 channel-group 1 mode active
interface Port-channel1
 switchport mode access
 switchport access vlan 10
end
show etherchannel summary
show vlan brief
show vlan id 10
show vlan
show running-config interface Port-channel1
```

If the VLAN 10 cell reads `Po1`, the rule is "one logical port, named by the bundle"; if it reads
`Gi1/0/1, Gi1/0/2`, this console is already right; if it reads all three, the cell is a list of physical
and logical interfaces and the engine needs a de-duplication rule, not a rename.

## Why no engine change

The only IOS artifact found names `Po1` but does not show the members' absence, and the question is
specifically about that absence. Folding the members to the bundle is a visible change to an existing
table, so it waits for the capture above. The sibling note
(`research/vlan-brief-trunk-ports.md`, item 2) recorded the same gap from the other direction: a
knowledge-base sentence says bundled ports do not appear, and this run could not turn that sentence into a
transcript.
