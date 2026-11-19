# What `show spanning-tree` calls a bundle in its Port column

**Question (one, narrow).** On a Cisco-style switch, when several ports are bundled into an EtherChannel,
what name does the per-port table under `show spanning-tree` carry for the bundle - and is `lag-1`, the name
this console printed, one any device uses?

**Verdict: `Po1` - the short form, in the table cell - and `lag-1` is this engine's own key, not a port name.**
Four captures from three platforms print the bundle as `Po<id>` in the `Interface`/port column, beside physical
ports in their own spelling (`Gi1/0/14`, `Eth1/45`). The engine was right to model one logical port; it was
printing the model's key as if it were a name.

## What PacketForge does today, and what changed

`Simulator._logicalPortName()` (and `engine/segment.js`) fold a bundle's members onto one logical port keyed
`lag-<id>`, which is what the tree should see: one port, one cost, one role. `show spanning-tree` printed the
keys of `dev.stp.states`, so a switch with `channel-group 1` answered:

```
Port          Role          State
lag-1         designated    forwarding
```

A label no box prints, in the one view an operator opens to ask which ports are forwarding. The row's role and
state were correct; only the name was the engine's.

The view now prints a bundle's name through `lagLib.portChannelName(id)` - the same function `show mac
address-table` and `show etherchannel summary` already take their `Po1` from - so the three views cannot call
one bundle three things. Physical ports are untouched (the mapping only rewrites `lag-<digits>`), and the
internal key stays `lag-1` everywhere in the engine. `test/stp-port-channel-name.test.js` pins the row, the
role/state agreement with `stpResult.ports`, the physical port beside a bundle, a blocking bundle, and a box
with no bundle (nothing is invented). `docs/CLI.md` states the rule.

## Evidence

| Source | Says |
| --- | --- |
| [Cisco, "Change of EtherChannel Member Interface Causes Disruption" (doc 221588)](https://www.cisco.com/c/en/us/support/docs/lan-switching/spanning-tree-protocol-stp-8021d/221588-change-of-etherchannel-member-interface.pdf) | Two `show spanning-tree` captures from a Catalyst 9600: `Po1 Desg FWD 10000 128.3433 P2p` and `Po2 Desg FWD 10000 128.3434 P2p`, and after a member change `Po1 Desg FWD 10000 128.3433 P2p` / `Po2 Desg FWD 20000 128.343 P2p`. The table's other rows are physical: `GI 1/0/14 Altn BLK 20000 128.14 P2p`. The same document's narrower command is spelled `show spanning-tree interface port-channel 1` - the long form belongs to the command line, not to the cell. |
| [Cisco, "Troubleshoot STP Issues on Catalyst Switches" (doc 28943)](https://www.cisco.com/c/en/us/support/docs/lan-switching/spanning-tree-protocol/28943-170.html) | A Catalyst 6500 with MST: `Interface Role Sts Cost Prio.Nbr Status` / `Gi3/8 Root FWD 20000 128.136 P2p` / `Po1 Desg FWD 20000 128.833 P2p`. Same table furniture, bundle shortened, physical port in its own form. |
| [Cisco DevNet, Nexus 9000 NX-API CLI reference, `show spanning-tree vlan 10`](https://developer.cisco.com/docs/cisco-nexus-9000-series-nx-api-cli-reference/latest/spanning-tree-commands/) | `Po1 Desg FWD 1 128.4096 (vPC) Edge P2p`, `Po50 Root FWD 1 128.4145 (vPC) P2p`, `Po100 Root FWD 1 128.4195 (vPC peer-link) Network P2p`, beside `Eth1/45 Desg FWD 2 128.177 Edge P2p`. So the short form is the convention on NX-OS as well, not an IOS 12.x accident. |
| [Michael McNamara, "LACP Configuration Examples (Part 6)"](https://blog.michaelfmcnamara.com/2013/11/lacp-configuration-examples-part-6/) | Two Catalyst 2950s with two LACP bundles between them: `Po1 Root FWD 100000 128.65 P2p` / `Po2 Desg FWD 100000 128.66 P2p`, under a block whose `Port` line reads `Port 65 (Port-channel1)` - the short name in the cell, the long name where the port is the subject of a line. The oldest platform in the set, and the same rule. |

## What is known, what is inferred, what is unresolved

**Known.**
1. The cell carries the short `Po<id>` on IOS, IOS XE and NX-OS; the captures above are from a 6500, a 9600
   and a 9000 and agree word for word in that column.
2. The long spelling (`Port-channel1`) is used where the interface is named in a sentence rather than a cell:
   the same 2950 capture heads its block `Port 65 (Port-channel1)`, and Cisco's own narrower command is spelled
   `show spanning-tree interface port-channel 1`. This console's view has no block heading or detail form, so no
   sentence here needs the long name; `show ip interface brief`, which does name the interface as the subject of
   its row, keeps `Port-channel1` (`research/port-channel-in-interface-brief.md`).
3. `lag-<id>` appears in no Cisco transcript read for this question. It is this engine's key.

**Inferred.**
4. A bundle whose members never negotiated is printed as the physical ports, because the tree groups only
   members that really formed the bundle (`_logicalPortName` asks `lagFor`, which the one-sided case leaves
   empty). The new label therefore only appears where a bundle exists, which is what the captures show. No
   capture of `show spanning-tree` in the one-sided state was found; the state itself is an open question in
   `research/lacp-passive-both-ends.md`.

**Unresolved.**
5. **Row order.** Real IOS lists this table by interface index, so `Po1` sorts among the ports by its own index
   rather than after them. This console sorts the tree's keys as strings, so a bundle appears after `Fa0/4`
   (`'F' < 'l'`). No source read states the ordering rule for a table holding both a bundle and physical ports,
   and changing the order changes no verdict, so it was left alone. One `show spanning-tree` paste from a box
   with a bundle and a spare physical port would settle it.
6. **The `Prio.Nbr` and `Type` columns** this model's table does not print at all (`128.1`, `P2p`) are the same
   table's other cells; they are a separate narrow question from the naming one, and are not claimed here.

## Evidence that would settle 5

A single `show spanning-tree` from a switch that has one EtherChannel and one physical port forwarding, pasted
whole, so the order of the two rows is visible.
