# `show spanning-tree`: which timer is the `Aging Time` line, and what value does a factory switch print?

**Question (one, narrow).** Four lines above the port table, a Catalyst prints
`Hello Time   2 sec  Max Age 20 sec  Forward Delay 15 sec`. Three lines below it, at the end of the Bridge ID
block, it prints `Aging Time <n>`. Which timer is that second one - the spanning-tree **max age** (20 s, which the
same block has already printed), or the **forwarding-database (CAM) ageing** (300 s by default)? What does a switch
nobody has configured print, does the number follow `mac address-table aging-time`, and does the line carry a unit?

This is only about that one field. It does not touch the layout of the port table (that is
`docs/plans/stp-port-tunables.md`) or the block's other timers.

**Verdict: it is the bridge's forwarding-database ageing, not an STP timer - 300 on a factory switch.** Four
independent things say so:

1. **The same block prints both numbers at once.** A Catalyst 6500 12.1E sample prints `Max Age 20 sec` **and**
   `Aging Time 15` for one bridge on one page, so the field cannot be the max age.
2. **The detail view names it.** On that same page, `show spanning-tree detail` for a bridge group prints
   `Timers: hello 0, topology change 0, notification 0  bridge aging time 15` - the same 15, under a field whose
   name is *bridge aging time*, in a line that sits two lines below `hello 2, max age 20, forward delay 15`.
3. **The number is the CAM ageing's.** 300 s is the default of `mac address-table aging-time` on every Catalyst
   generation that prints this line, and 15 s is what that command sets. The bridge-MIB object with this default
   and this range (`10..1000000`) is `dot1dTpAgingTime`, "the timeout period in seconds for aging out
   dynamically learned forwarding information".
4. **The IEEE bridge keeps the two apart.** 802.1D's max age is a BPDU timer; the filtering-database ageing is the
   object the MIB exposes as `dot1dTpAgingTime`, and Cisco's own IE switch guide describes that timer as a
   property of *dynamic addresses* that a spanning-tree reconfiguration temporarily accelerates to the forward
   delay - two subsystems, one influence.

The wording is **not** settled, because Cisco's own documents print it two ways: `Aging Time 300` in the 12.1E /
15.2E 2960-X material and `Aging Time 300 sec` in the IOS XE 17.x material. Both forms are recorded below; a
simulator that has to pick one has to pick a generation first.

## The transcript that settles the timer

Catalyst 6500 Series Cisco IOS Command Reference, 12.1E, `show spanning-tree`
(<http://www.cisco.com/en/US/products/hw/switches/ps708/products_command_reference_chapter09186a008010273a.html>,
mirrored verbatim at <https://myf5.net/post/84.htm>) - note the two different numbers in one header block:

```
Router# show spanning-tree
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
Interface        Port ID                     Designated                Port ID
...
```

and, further down the same page, `show spanning-tree detail` for a bridge group:

```
  Bridge group 1 is executing the ieee compatible Spanning Tree protocol
   Bridge Identifier has priority 32768, address 00d0.d39c.004d
   Configured hello time 2, max age 20, forward delay 15
...
   Times:  hold 1, topology change 35, notification 2
           hello 2, max age 20, forward delay 15
   Timers: hello 0, topology change 0, notification 0  bridge aging time 15
```

`Max Age 20` and `Aging Time 15` are both printed, for the same bridge, twice. The field is the FDB ageing, and
its name in the detail view is *bridge aging time*.

## The evidence

| Source | What it says |
| --- | --- |
| [Catalyst 6500 IOS Command Reference 12.1E, `show spanning-tree`](https://myf5.net/post/84.htm) (reprint of the Cisco page above) | `Max Age 20 sec` and `Aging Time 15` in the same Bridge ID block; `show spanning-tree detail` → `Timers: hello 0, topology change 0, notification 0  bridge aging time 15`. The field is 13 spaces in, `Aging Time` then **one** space then the number - two columns left of the `Hello Time` values above it. Field table 2-40 defines only `Port ID Prio.Nbr`, `Cost` and `Sts`: the vendor's field list does **not** define `Aging Time` at all. |
| [Catalyst 2960-X Consolidated Platform Command Reference 15.2(6)E, Layer 2 Commands](http://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst2960x/software/15_2_6_e/command_reference/b_1526_2960x_cr/layer_2_commands.html) | `show spanning-tree active`: `Hello Time 2 sec  Max Age 20 sec  Forward Delay 15 sec` … `Aging Time 300` followed by `Uplinkfast enabled`. The same box's `show spanning-tree detail`: `Configured hello time 2, max age 20, forward delay 15` and `Timers: hello 0, topology change 0, notification 0, aging 300`. Both views, one number, and it is not the 20. |
| [Catalyst 2960-X Command Reference 15.2(7)E, System Management Commands](http://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst2960x/software/15-2_7_e/command_reference/b_1527_2960x_cr/system_management_commands.html), `mac address-table aging-time` | "To set the length of time that a dynamic entry remains in the MAC address table after the entry is used or updated"; syntax `{0 \| 10-1000000} [vlan vlan-id]`; **"The default is 300 seconds."** The range is the bridge-MIB object's range, digit for digit. |
| [Catalyst 2960 / 2960-S Software Configuration Guide 12.2(58)SE, Administering the Switch](http://cisco.com/c/en/us/td/docs/switches/lan/catalyst2960/software/release/12-2_58_se/configuration/guide/2960scg/swadmin.html) | "Default MAC Address Table Configuration: **Aging time 300 seconds**." So 300 is the factory value of the timer the `Aging Time` field reports. |
| [Catalyst 4500 Configuration Guide 12.2(37)SG, Configuring STP and MST](https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst4500/12-2/37sg/configuration/guides/config/spantree.html) | `show spanning-tree vlan 1` → `Hello Time 2 sec Max Age 20 sec Forward Delay 15 sec` / `Aging Time 300`; `show spanning-tree detail` → `Timers:hello 0, topology change 0, notification 0, aging 300`. A second platform, same pair. |
| [Catalyst 9200 Command Reference 17.1, Layer 2/3 Commands](https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst9200/software/release/17-1/command_reference/b_171_9200_cr/layer_2_3_commands.pdf) (and the 9600 17.7 book, same page name) | `Aging Time 300 sec` - **with the unit**. The same release's `show spanning-tree detail` keeps `Configured hello time 2, max age 20, forward delay 15, transmit hold-count 6` and omits the ageing line. |
| [Cisco TAC, Troubleshooting Network Latency and Packet Drops on Catalyst 9000](https://www.cisco.com/c/en/us/support/docs/switches/catalyst-9300-series-switches/225617-troubleshooting-network-latency-and.html) | A live `show spanning-tree` with `Aging Time 300 sec`, and immediately beside it `show mac address-table aging-time` → `Global Aging Time: 300 <===== MAC aging`. The article then says a topology change prompts switches to "shorten their MAC address aging time from the default (300 seconds) to the Forward Delay value (typically 15 seconds)". |
| [Industrial Ethernet 3500 Configuration Guide, Configuring STP, "Accelerated Aging to Retain Connectivity"](https://www.cisco.com/c/en/us/td/docs/IIOT/switches/ie35xx/sw-config-guide/17-18/b_ie3500_1718-cg/configuring_spanning_tree_protocol.pdf) | "The default for aging dynamic addresses is 5 minutes, the default setting of the `mac address-table aging-time` global configuration command. However, a spanning-tree reconfiguration can cause many station locations to change … the address-aging time is accelerated … The accelerated aging is the same as the forward-delay parameter value … when the spanning tree reconfigures." The ageing is a CAM property that STP *touches*; the max age is an STP property that CAM ignores. |
| [RFC 1493 / BRIDGE-MIB, `dot1dTpAgingTime`](https://www.loriotpro.com/Products/On-line_Documentation_V8/LoriotProDoc_EN/rfc/rfc1493.htm) (and RFC 4188) | `SYNTAX Integer32 (10..1000000)`, "The timeout period in seconds for aging out dynamically-learned forwarding information. 802.1D-1998 recommends a default of 300 seconds." The MIB range is the CLI range, the MIB default is the CLI default: one object behind both spellings. |
| [Catalyst 2960-XR Consolidated Configuration Guide 15.2(2)E, Configuring Optional Spanning-Tree Features](http://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst2960xr/software/15-2_2_e/consolidated_guide/b_1522e_consolidated_2960xr_cg/b_1522e_consolidated_2960xr_cg_chapter_010001.html) (2960-CX, 2960-L and 3560-CX guides carry the same sample) | `Aging Time 0 sec` - the unit **and** a zero, on a sample whose other numbers were scrubbed (`Bridge ID Priority 2 (priority 0 sys-id-ext 2)`). Recorded, not relied on: a zero is what `mac address-table aging-time 0` would produce, and this sample cannot be told apart from a placeholder. |
| [Cisco IOS Bridging Command Reference](https://www.cisco.com/c/en/us/td/docs/ios/bridging/command/reference/br_book.pdf), `bridge-group aging-time` | "To set the length of time that a dynamic entry can remain in the bridge table from the time the entry was created or last updated … **300 seconds**", range 10 to 1000000 - the CRB spelling of the same timer, in the same book whose `show spanning-tree` samples print `Aging Time 15` and `Aging Time 300`. |

## What this console does today

`show spanning-tree` prints **no timers at all**: `Spanning tree enabled protocol ieee`, one bridge-priority line and
a three-column port table (`engine/cli.js:6204`, `:6217`, `:6230`). `show spanning-tree detail` and
`show spanning-tree bridge` are refused by name (`:6183`), and `mac address-table aging-time` is
`% Unrecognized config command` in config mode - measured, one command at a time on a generic switch. So there is
nothing here printing the wrong number.

The number the field would carry already exists and is already 300: `MAC_AGE_MS = 300000` (`engine/device.js:6`)
is what the model ages a learned MAC by, and it is the same constant `show mac address-table` reports in its `Age`
column. A future IOS-shaped header block would therefore *read* the field this note is about, not invent it.

Added here as a research note rather than a code change because printing the line is new output on a view that
does not have a timer block yet - the shape belongs to `docs/plans/stp-port-tunables.md`, which already plans the
`Cost` / `Prio.Nbr` / `Type` columns for the same table.

## Known, inferred, unresolved

**Known.** `Aging Time` is the forwarding-database ageing, not the max age: a 6500 prints `Max Age 20` and
`Aging Time 15` together and its detail view calls the same number *bridge aging time*. A factory switch prints
300. The value is the `mac address-table aging-time` value (`bridge-group aging-time` in the bridging book), whose
default and range match BRIDGE-MIB's `dot1dTpAgingTime`.

**Inferred.** That the naive view and the detail view are fed by one object (they agree at 300 on the 2960-X and
at 15 on the 6500, and disagree nowhere in the material read). That a per-VLAN ageing (`mac address-table
aging-time 100 vlan 10`) would show in `show spanning-tree vlan 10` and not in another VLAN's block - the command
is per-VLAN on 2960-X, but no sample prints two VLANs with different ages.

**Unresolved.**

* **The unit suffix.** 12.1E and 15.2(6)E 2960-X: `Aging Time 300`. IOS XE 17.1/17.7 (9200/9600) and the 9300
  TAC article: `Aging Time 300 sec`. 15.2(2)E config guides: `Aging Time 0 sec`. Three documents, two forms, no
  version boundary that accounts for all three. A simulator has to choose; the honest default is the form of the
  platform it claims to be.
* **The spacing.** `Aging Time` is followed by one space in every sample read, so the number starts two columns
  left of `Hello Time`'s value. That is an artefact of a three-space-separated `Hello Time   2 sec` field and a
  one-space `Aging Time` label; whether a box right-pads the label when the number is three digits is not shown
  by any sample in hand (all are 3 digits or fewer).
* **What a reconfiguration prints.** The IE guide says a topology change accelerates the *aging* to the forward
  delay. No sample shows `Aging Time` read *during* a topology change, so whether the field reports the configured
  ageing or the accelerated one is not settled by anything here.
* **MST.** Every sample quoted is PVST/RSTP (`VLAN0001`, `Spanning tree enabled protocol ieee` / `rstp`). Whether
  the MST instance header carries the line is not established by this note - no MST `show spanning-tree`
  transcript was read for it.

**What would settle the rest.** On one 2960-X: `show spanning-tree | include Aging`, then
`mac address-table aging-time 200`, then the same line again (does it say 200?), then
`mac address-table aging-time 100 vlan 10` and `show spanning-tree vlan 10` beside `show spanning-tree vlan 20`
(per-VLAN or not), then `mac address-table aging-time 0` (whether it prints `0 sec`, as one Cisco sample
already suggests).
A capture taken across a cable pull answers the accelerated-ageing question, and one `show spanning-tree` plus
`show spanning-tree mst 0` on a box in `spanning-tree mode mst` answers the MST one.
