# `show vlan brief` and an access EtherChannel: is the port `Po1`, or its members?

**Question (one, narrow).** On a Cisco IOS-style switch, an EtherChannel whose members are access ports in
VLAN 10 is one logical interface. When the operator runs `show vlan brief` (or the first table of
`show vlan`), does the `Ports` cell for VLAN 10 read `Po1`, the physical member names (`Gi1/0/1, Gi1/0/2`),
or both? The question is only about the name in that cell; the forwarding rule and the EtherChannel summary
are already modelled.

**Verdict: settled — the cell reads `Po1`, and the members are not printed beside it. Adopted.** A later run
found the transcript this note was waiting for: an IOU switch with `Et0/0`-`Et0/1` bundled (PAgP desirable) and
`switchport mode access` / `switchport access vlan 10` on the members prints `10 VLAN0010 active Po1` with an
empty VLAN 1 cell (<https://lkjil1224.tistory.com/70>). That is exactly the case the note asked for - a switch
whose only VLAN-10 ports are the members of a working bundle - and it names the bundle alone. `engine/cli.js`
now folds a working access bundle to `Po<n>` in that cell and leaves a member that never negotiated as its own
port, the rule the MAC table already applies; `test/vlan-brief-etherchannel.test.js` (13 checks).

The older evidence, kept because it is what the first pass had:

**Unresolved for IOS at the time, and the one IOS sample then in hand named the Port-channel.** Cisco's own
`show vlan-switch` sample ends VLAN 1's `Ports` cell with `Gi4/0, Gi4/1, Po1` - the logical interface is a
port in the VLAN table. Two NX-OS `show vlan brief` captures likewise print `Po1` and never the bundle's
members. What no capture in hand shows is an IOS `show vlan brief` taken on a switch whose *only* ports in
the VLAN are the members of a working access bundle, so the exact rule ("members are not also printed") is
inference, not a transcript. No engine change was made on that basis.

## What PacketForge did before this run

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
`% No interface Port-channel1 ...`), so the VLAN table named the members it walked. The engine's other two
tables that meet a bundle already fold it to the logical name: the MAC table prints `Po1` for an entry learned
on a member (`research/mac-table-port-channel-name.md`) and `show spanning-tree` groups the members under the
bundle (`research/stp-port-channel-name.md`). `show vlan` was the view that did not.

## What PacketForge prints now

Same lab, after the change (`test/vlan-brief-etherchannel.test.js`):

```
a# show vlan brief
VLAN Name                             Status    Ports
---- -------------------------------- --------- -------------------------------
1    default                          active    Fa0/1
10   VLAN0010                         active    Fa0/1, Po1
```

The bundle is appended after the physical ports, which is the order the `show vlan-switch` sample shows
(`... Gi4/0, Gi4/1, Po1`); a VLAN whose only member is the bundle reads `Po1` alone, as the IOU capture does.
A member that never negotiated LACP still carries traffic as a single link and keeps its own name, the rule
the MAC table already applies to that state.

## Evidence

| Source | Shows | What it settles |
| --- | --- | --- |
| [EtherChannel lab, IOU switch, 2021](https://lkjil1224.tistory.com/70) | `int range e0/0 - 1` / `switchport mode access` / `switchport access vlan 10` / `channel-group 1 mode desirable`; `show etherchannel summary` -> `1 Po1(SU) PAgP Et0/0(P) Et0/1(P)`; `show vlan brief` -> `1 default active` and `10 VLAN0010 active Po1` | **The case this note asked for**: a switch whose only VLAN-10 ports are the two members of a working access bundle. The cell names the bundle and no member, and VLAN 1 is empty. IOU (IOS-on-Unix) runs the IOS CLI; the same session prints the vendor's `show vlan brief` furniture unchanged. |
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

1. **Settled for the multi-VLAN table** by the IOU capture above, and adopted. What it does not show is a
   *hardware* Catalyst (the transcript is IOU), so the fixed-config switch remains confirmed only by the
   platform-agnostic rule in the IOS command reference; a 2960/9200 paste would close that.
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

## Why the first pass made no engine change

The only IOS artifact it found named `Po1` but did not show the members' absence, and the question is
specifically about that absence. Folding the members to the bundle is a visible change to an existing table,
so it waited for the capture above - which a later run found, and adopted. The sibling note
(`research/vlan-brief-trunk-ports.md`, item 2) recorded the same gap from the other direction: a
knowledge-base sentence says bundled ports do not appear, and the first pass could not turn that sentence
into a transcript.
