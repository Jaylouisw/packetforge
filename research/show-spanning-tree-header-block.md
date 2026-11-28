# `show spanning-tree`: the Root ID and Bridge ID blocks, field by field

**Question (one).** Above its port table a Catalyst prints two blocks — `Root ID` and `Bridge ID` — made of an
extended priority, a bridge address, two different middle lines and a timer line. This console printed one
sentence of its own instead (`Bridge priority 4096 (this bridge is the root), root bridge core-sw1 priority 4096`),
so the part of the report that explains the election was missing (#1713). Which fields does a box print, in what
order, in which columns, and which of them can this model fill from something it has actually computed?

**Verdict.** A Catalyst prints, above the port table:

```
VLAN0001
  Spanning tree enabled protocol ieee
  Root ID    Priority    4097
             Address     0004.9b78.0800
             This bridge is the root
             Hello Time   2 sec  Max Age 20 sec  Forward Delay 15 sec

  Bridge ID  Priority    4097   (priority 4096 sys-id-ext 1)
             Address     0004.9b78.0800
             Hello Time   2 sec  Max Age 20 sec  Forward Delay 15 sec
             Aging Time 15
```

and on a box that is *not* the root, the two middle lines of the Root ID block become the price of reaching the
root:

```
  Root ID    Priority    32769
             Address     0004.9b78.0800
             Cost        19
             Port        23 (GigabitEthernet0/23)
             Hello Time   2 sec  Max Age 20 sec  Forward Delay 15 sec
```

Every field is one this model already knows, except the timers, which it does not tune.

## Where the capture comes from

| Source | What it settles |
| --- | --- |
| Catalyst 6500 Series Cisco IOS Command Reference, 12.1E, `show spanning-tree` (<http://www.cisco.com/en/US/products/hw/switches/ps708/products_command_reference_chapter09186a008010273a.html>, mirrored verbatim at <https://myf5.net/post/84.htm>) | The block above, word for word: `VLAN0001`, the protocol line, `Root ID    Priority    4097`, `Address     0004.9b78.0800`, `This bridge is the root`, the timer line, then `Bridge ID  Priority    4097   (priority 4096 sys-id-ext 1)` and `Aging Time 15`. It is the sample that proves the extended priority is not the same number as the priority: 4096 was configured and 4097 is printed. |
| ntc-templates, `tests/cisco_ios/show_spanning-tree/cisco_ios_show_spanning_tree.raw` | A machine-recorded session, so the spacing in the columns survived: the port table this console already prints is transcribed from it, and the block above is the same header. |
| Cisco doc 221191, *Understanding and Configuring Spanning Tree Protocol (STP) on Catalyst Switches* | Names the two halves of the bridge ID — a 2-byte priority and a 6-byte MAC address — and that the low 12 bits of the priority are the system ID extension, i.e. the VLAN. |
| Catalyst 9200 Command Reference 17.1 / 9600 17.7, layer 2/3 commands, `show spanning-tree` field table | `Port ID` is "the port priority and the port number", which is what the `Port  <n> (<long name>)` line prints and what the table's `Prio.Nbr` cell already prints. `Aging Time 300 sec` — with the unit — in the IOS XE generation. |

## Field by field, and where this model's number comes from

| Line | What it is | This console's source |
| --- | --- | --- |
| `VLAN0001` | The VLAN whose tree is being reported. | This device runs **one** spanning tree over VLAN 1, and refuses every per-VLAN form (`STP_ONE_TREE`). One tree, one line, and it is the VLAN the model actually has. |
| `  Spanning tree enabled protocol ieee` | The protocol line. | Unchanged, and already printed by this console. |
| `Root ID    Priority    4097` | The root's bridge ID as an **extended** priority: the 16-bit priority of the root plus the VLAN's `sys-id-ext`. | `runStp()`'s `root.priority` + 1. The +1 is not a fudge: `sys-id-ext` 1 is VLAN 1, which is why the 6500 sample reads 4097 over a configured 4096. |
| `             Address     0004.9b78.0800` | The root bridge's MAC, in the dotted form every IOS table prints. | `runStp()`'s `root.mac`, formatted by `net.formatMac()`. |
| `             This bridge is the root` | Printed when the reporting box is the root. | `root.key === dev.id`. |
| `             Cost        19` | The **root path cost** of the reporting box — the whole path, not one hop. | `runStp()`'s Dijkstra distance for this bridge; the same number the root-port choice used. |
| `             Port        23 (GigabitEthernet0/23)` | The box's root port: its number in the chassis port table, and its long name in parentheses. | `runStp()`'s chosen root port; the number is `portOrdinals()` — the same ordinal the table's `Prio.Nbr` cell prints — and the long name is `iface-name.displayName()`, the one expander the brief table already uses. |
| `             Hello Time   2 sec  Max Age 20 sec  Forward Delay 15 sec` | The three BPDU timers - the **root's** on the Root ID line, this box's own on the Bridge ID line, so a non-root can print two different sets. | `convergence.stpTimers()` of the elected root (`root.key` → `topology.getDevice()`) for the upper line and of the answering device for the lower one; both of the answering device when no election has run. Factory defaults 2 / 20 / 15 s; a fixture can set them, the console cannot (`spanning-tree hello-time` is refused). `research/stp-timer-lines-source.md` (#1724). |
| `  Bridge ID  Priority    4097  (priority 4096 sys-id-ext 1)` | This box's own bridge ID, with the two numbers it is made of spelled out. | `dev.config.stpPriority` (else 32768), printed as the extended value and again inside the parentheses. |
| `             Address     ...` | This box's own bridge address. | `Device.lowestInterfaceMac()` — the rule the election has always used, now a method so the report and `runStp()` cannot disagree. |
| `             Aging Time  300 sec` | The forwarding-database ageing, not the max age. | `MAC_AGE_MS / 1000` — the same constant `show mac address-table` ages an entry by. See `research/show-spanning-tree-aging-time.md`, which settles what the field is and which two spellings exist. |

## Columns

The labels are not in a field of their own; they are laid out by hand:

* `VLAN0001` at column 1, the protocol line indented two.
* `  Root ID    ` and `  Bridge ID  ` are both exactly 13 characters, so the block labels line up.
* Every label inside a block starts at column 14 and every value at column 26: `Address` is followed by five
  spaces, `Cost`, `Port` and `Priority` by four (twelve characters of label field in all).
* `Hello Time` is the exception the captures show: ten characters plus three spaces puts its value in column 27,
  one further right than `Address`. This console reproduces that rather than tidy it.
* `Aging Time` is followed by two spaces (`Aging Time  300 sec`), which is the form the IOS XE 17.x books print
  with the unit. The 12.1E / 15.2E books print the same field without `sec`; the ageing note records both.

## What this console does now

`engine/cli.js` prints the block from the election's own record (`runStp()` now returns a per-bridge
`bridges[key] = { priority, mac, cost, rootPort }`, all of it already computed for the table) plus
`Device.lowestInterfaceMac()` for the bridge address. Nothing on those lines is derived a second time, so the
header and the table cannot disagree. `test/show-spanning-tree-header-block.test.js` pins the line order, the
columns, the numbers, and the three cases that are not an ordinary election: a priority somebody set, a console
with no simulator behind it, and a box that is not a bridge.

## Known, inferred, unresolved

**Known.** The block's shape, its line order and its columns (6500 12.1E sample plus the machine-recorded ntc
session). That the `Priority` in both blocks is extended by `sys-id-ext`, and that `sys-id-ext` 1 is VLAN 1 — the
4096/4097 pair is printed in one sample. That `Aging Time` is the FDB ageing
(`research/show-spanning-tree-aging-time.md`). That a non-root prints `Cost` and `Port` in place of `This bridge
is the root`.

**Inferred.** That the `Port` number and the `Prio.Nbr` ordinal are the same counter. Cisco's field table defines
`Port ID` as "port priority and port number" without saying the number is the chassis position, but the captures
the `Prio.Nbr` column was transcribed from (`research/stp-port-table-prio-nbr-column.md`) put the same number on
the same port in both places wherever both appear.

**Unresolved.**

* **The timers.** This model converges instantly and tunes no BPDU timer, so `Hello 2 / Max Age 20 / Forward
  Delay 15` are the factory defaults printed as constants. A box prints its *configured* values, which is what
  these would be — but nothing here can prove that, because there is nothing to configure.
* **The root's name.** The block has no field for it. A box identifies the root by its bridge address and nothing
  else, so this view no longer prints the lab id or the hostname the way the old sentence did (#1364 wanted an
  identifiable root; the address is the identity the hardware actually offers, and every switch prints its own
  in its Bridge ID block).
* **A bundle as the root port.** A `Port` line wants a chassis number, and a port-channel's number is the
  platform's own — the same gap the table's `Prio.Nbr` cell already leaves as `-`. This console prints
  `Port  - (Port-channel1)` there rather than invent one.
* **A partitioned tree.** A bridge that cannot reach the elected root has no cost and no root port to print; this
  console says `root bridge not measured (no path to the root from this device)` instead of printing `Infinity`.
  No capture in hand shows what a box prints in that state.
