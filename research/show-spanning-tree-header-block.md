# `show spanning-tree`: what does the block above the port table say?

**Question (one, narrow).** A Catalyst asked for `show spanning-tree` prints four to nine lines above the port
table - a `VLAN0001` heading, the protocol line, a **Root ID** block, a **Bridge ID** block, then the table. This
console printed one sentence of its own instead: `Bridge priority 32768 (this bridge is the root), root bridge
sw1 priority 32768`. What exactly does the vendor print there, at what columns, and which of those fields does
this model already hold?

**Verdict: the vendor's block, transcribed from a machine-recorded session.** Every field it carries was already
computed by the election; nothing had to be invented, and one sentence of this console's own making was removed.

## The capture

`ntc-templates`, `tests/cisco_ios/show_spanning-tree/cisco_ios_show_spanning_tree.raw`
(<https://github.com/networktocode/ntc-templates/blob/master/tests/cisco_ios/show_spanning-tree/cisco_ios_show_spanning_tree.raw>)
- a recorded session, so the spacing survived. First block, byte for byte:

```
VLAN0001
  Spanning tree enabled protocol ieee
  Root ID    Priority    32769
             Address     fa16.3e57.336f
             Cost        8
             Port        4 (GigabitEthernet0/3)
             Hello Time   2 sec  Max Age 20 sec  Forward Delay 15 sec

  Bridge ID  Priority    32769  (priority 32768 sys-id-ext 1)
             Address     fa16.3e77.b50c
             Hello Time   2 sec  Max Age 20 sec  Forward Delay 15 sec
             Aging Time  300 sec

Interface           Role Sts Cost      Prio.Nbr Type
```

That file is already this repo's witness for the table header below the block
(`research/stp-port-table-role-and-sts.md`), so the two halves of the view now come from one recording.

The same shape, on other platforms and other generations:

| Source | Shows |
| --- | --- |
| [Cisco, "Troubleshoot Layer-2 Loops on Catalyst 9000" (doc 221191)](https://www.cisco.com/c/en/us/support/docs/switches/catalyst-9200-series-switches/221191-troubleshoot-layer-2-loops.html) | Four captures (9200/9300 stack), each opening `VLAN0001` / `Spanning tree enabled protocol rstp` / `Root ID Priority 1` / ... / `Bridge ID Priority 32769 (priority 32768 sys-id-ext 1)` / `Aging Time 300 sec`. The page also states why the heading is there: "in per-vlan spanning-tree, each VLAN represents a unique instance of spanning-tree". |
| [Cisco, Catalyst 6500 IOS Command Reference 12.1E](https://myf5.net/post/84.htm) (reprint; quoted in `research/show-spanning-tree-aging-time.md`) | `VLAN0001` / `Root ID    Priority    4097` / `This bridge is the root` / `Bridge ID  Priority    4097   (priority 4096 sys-id-ext 1)` / `Aging Time 15`. Same fields; the ageing line without a unit, and three spaces before the bracket. |
| [Juniper KB, RPVST+ convergence on native VLAN 1](https://supportportal.juniper.net/s/article/EX-VSTP-and-RPVST-convergence-on-native-vlan-1) | A Cisco peer's block in full, including `This bridge is the root` and the closing `Aging Time 300`. |
| [Cisco Networking Academy lab, "Building a Switched Network with Redundant Links"](https://www.ii.pwr.edu.pl/~kano/course/files/4.1.2.10%20Lab%20-%20Building%20a%20Switched%20Network%20with%20Redundant%20Links.pdf) | Three 2960s, non-root blocks with `Cost 19` / `Port 2 (FastEthernet0/2)`; and the course text: "32769 = 32768 + 1, where default priority = 32768, VLAN number = 1". |

## What each field is

* **`VLAN0001`** - the VLAN whose tree this block describes. PVST+ runs one instance per VLAN and prints one
  block per VLAN in ascending order; a factory box has only VLAN 1.
* **`Root ID    Priority    32769`** - the *extended* bridge ID: `priority + sys-id-ext`, where the extension is
  the VLAN id in the low 12 bits. The base is what an operator configures, and the `Bridge ID` line repeats it
  in brackets. 32769 for VLAN 1 at the default base, 4097 for a base of 4096.
* **`Address`** - the bridge MAC, in the IOS dotted `aabb.ccdd.eeff` form: the root's in the Root ID block, this
  bridge's own in the Bridge ID block. A Cisco switch's bridge ID uses the chassis MAC, which is the lowest port
  MAC on the box - the value `computeStp()` already builds its bridge list from.
* **`This bridge is the root`** - printed *instead of* the next two lines when this box won. A non-root prints
  **`Cost`** (its root path cost, the sum of port costs along the path the tree chose) and **`Port <id>
  (<name>)`** (its root port, numbered by the port's place in the chassis port table - the number the table's
  `Prio.Nbr` carries after `128.`).
* **`Hello Time   2 sec  Max Age 20 sec  Forward Delay 15 sec`** - 802.1D defaults, printed twice: once in each
  block.
* **`Aging Time  300 sec`** - the forwarding-database ageing, on the Bridge ID block only:
  `research/show-spanning-tree-aging-time.md` settles that it is the CAM ageing and not the max age the line
  above already printed. 300 s is the factory value, and the same 300 this model ages a learned MAC by
  (`MAC_AGE_MS`).

## What PacketForge does now

`show spanning-tree` on a bridge prints that block, from these sources, and then the port table unchanged:

* `runStp()` now returns **`costs`** - `dist`, Dijkstra's root path cost per bridge, which the election already
  computed to choose root ports but never exposed. `null` for a bridge with no path to the root, so the `Cost`
  line can print `-` rather than a 0 that would claim a path.
* `computeStp()` stores, per bridge, **`bridgeMac`** (the lowest port MAC it fed the election) and **`rootCost`**,
  so the block cannot disagree with the map it came from.
* `stpTimers()` gained **`helloSec`** and **`maxAgeSec`** beside the milliseconds it already returned; the block
  prints the same hello/max-age/forward-delay the convergence schedule counts.
* the priority printed is `base + 1` with `(priority <base> sys-id-ext 1)` in brackets, so the line reads like
  the vendor's instead of printing a bare base 32768 that no Catalyst puts there.
* `Aging Time` is `MAC_AGE_MS / 1000` with the unit the machine-recorded capture carries.

## Inferred, and why

* **One block, headed `VLAN0001`, for a box with many VLANs.** This console runs one tree per device and refuses
  the per-VLAN spelling by design. The tree it computes is every VLAN's, so printing it once under the default
  VLAN's heading is the smallest honest claim; printing no heading would drop the one line that tells a reader
  which instance they are looking at.
* **`-` for a cost or a port number the model cannot state.** A bridge with every uplink shut has no path to the
  root, and a bundle's port ID is the platform's own (128.20, 128.65 and 128.3433 in three captures). The table
  already prints `-` for those cells, and the block uses the same dash rather than a number nobody computed.
* **The unit on `Aging Time`.** 12.1E prints `Aging Time 15`; IOS XE prints `Aging Time 300 sec`. The choice is
  the machine-recorded capture's - the same source, and the same generation, as the table header this view
  already prints.

## Unresolved

* Whether any platform prints the block with **no** `VLAN0001` heading (a 9000 in a mode with no per-VLAN
  instance). Every capture in hand is per-VLAN, and `research/stp-mode-default.md` records the same gap.
* **MST**: whether an instance header (`MST0`) carries `Aging Time`, and what its `Priority` lines read. No MST
  capture was read for this note.
* Whether the root is ever named by anything but its bridge MAC in this block on any platform. No capture in
  hand prints a hostname there, which is why this console stopped printing one.
