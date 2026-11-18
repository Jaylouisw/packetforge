# The rows a Catalyst prints before it has learned anything

**Question (one, narrow).** `show mac address-table` on a switch nobody has configured: does the box print an
empty table, or a fixed block of entries it did not learn? If a block, which addresses are in it, in what order,
what do the columns say, does the closing total count them, and do they appear in a filtered view?

**Verdict: known for the block, and adopted.** A Catalyst holds a set of addresses that it forwards to its own
CPU rather than out of a port — CDP's two, the `0180.c200.0000`-`0010` group-address run (spanning tree, LACP
and LLDP among them), the all-nodes broadcast — and prints them above the learned rows as
`All … STATIC … CPU`. They are in **no VLAN** (hence `All`), nothing ever learned
them (hence `STATIC`), they have no age, and the device **counts them** in `Total Mac Addresses for this
criterion: N`. A filtered view has none of them, because none of them is on a port.

The one thing the sources do **not** agree on is the length of the list: the classic IOS access switches print
twenty rows, the IOS XE switches print twenty-one. PacketForge now prints the twenty that every published
transcript contains (see "What changed" for why that is the subset and not a guess).

## The transcripts

**A real 2960, twenty rows, total 21** — a 2960-I running 12.2SE, pasted during a MAC-flooding write-up
(<https://brezular.com/2010/10/10/mac-flooding-attack-2/>):

```
2960-I#show mac address-table

Mac Address Table
 -------------------------------------------

Vlan Mac Address Type Ports
 ---- ----------- -------- -----
 All 0100.0ccc.cccc STATIC CPU
 All 0100.0ccc.cccd STATIC CPU
 All 0180.c200.0000 STATIC CPU
 ...                                    (0180.c200.0001 … 0180.c200.0010, in order)
 All 0180.c200.0010 STATIC CPU
 All ffff.ffff.ffff STATIC CPU
100 001a.4b79.70b8 DYNAMIC Fa0/1
 Total Mac Addresses for this criterion: 21
```

The same page then adds one static entry by hand and the total becomes 22 — twenty CPU rows, one dynamic, one
configured static — which settles that the closing count is of *rows*, not of learned addresses.

**A 2960 in Cisco's own CCNA lab, same twenty rows, total 22** — "5.1.3.6 Lab - Viewing Network Device MAC
Addresses" (course copy at
<https://cisco.tu-sofia.bg/wp-content/uploads/courses/CCNA1/course/files/5.1.3.6%20Lab%20-%20Viewing%20Network%20Device%20MAC%20Addresses.pdf>)
prints the twenty rows over two learned ones and closes at 22.

**IOS XE, twenty-one rows** — Catalyst 9300 16.12 command reference, "show mac address-table Examples"
(<https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst9300/software/release/16-12/command_reference/b_1612_9300_cr/system_management_commands.html>):

```
Vlan    Mac Address       Type        Ports
----    -----------       --------    -----
 All    0100.0ccc.cccc    STATIC      CPU
 All    0100.0ccc.cccd    STATIC      CPU
 All    0180.c200.0000    STATIC      CPU
 ...                                     (0180.c200.0001 … 0180.c200.0010, in order)
 All    0180.c200.0010    STATIC      CPU
 All    0180.c200.0021    STATIC      CPU
 All    ffff.ffff.ffff    STATIC      CPU
```

The same twenty-one rows, in the same order, are on the 9400 16.9 "Checking Port Status and Connectivity" page
(<https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst9400/software/release/16-9/configuration_guide/int_hw/b_169_int_and_hw_9400_cg/checking_port_status_and_connectivity.html>),
the 9500 26.x page
(<https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst9500/software/release/26-x/configuration_guide/int_hw/b_26x_int_and_hw_9500_cg/checking_port_status_and_connectivity.html>),
the 9600 26.x page
(<http://cisco.com/c/en/us/td/docs/switches/lan/catalyst9600/software/release/26-x/configuration_guide/int_hw/b_26x_int_and_hw_9600_cg/checking_port_status_and_connectivity.html>)
and the 9200 26.x page that `research/mac-table-surround.md` already cites
(<https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst9200/software/release/26-x/configuration_guide/int_hw/b_26x_int_and_hw_9200_cg/checking_port_status_and_connectivity.html>) —
there with one dynamic row under them and `Total Mac Addresses for this criterion: 22`.

**A filtered view prints none of them.** The 9200 page's `show mac address-table interface Gi1/0/1` example
reprints the title, the rule, the headings and one dynamic row, and closes at 1. Nothing on the CPU is on a
port, so a port filter cannot match one.

**`show mac address-table count` does not count them either** — on the 2960 above, `count` reports for VLAN 1
`Static Address Count : 0` / `Total Mac Addresses : 0` while `show mac address-table` is printing twenty `All`
rows. They are in no VLAN, so a per-VLAN count has nothing to put them in. That is consistent with `All` being
the Vlan cell, not a summary of every VLAN.

## The false lead: the eleven-row `0000.0000.000x` sample

Cisco's current command references for the **2960-X, 2960-L, Catalyst 1000 and Catalyst Micro** switches print a
different, shorter block for the same command — five synthetic `0000.0000.0001/0002/0003/0009/0012` rows and six
`0180.c200.000b`-to-`0010` rows, closing at 12 with one dynamic entry:

* 2960-X 15.2(7)E: <http://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst2960x/software/15-2_7_e/command_reference/b_1527_2960x_cr/system_management_commands.html>
* 2960-L 15.2(7)E: <http://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst2960l/software/15-2_7_e/command_reference/b_1527_2960l_cr/system_management_commands.html>
* Catalyst 1000 15.2(7)Ex: <https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst1000/software/releases/15_2_7_e/command_reference/b_1527e_1000_cr/system_management_commands.html>
* Catalyst Micro 15.2(7)E3k: <https://cisco.com/c/en/us/td/docs/switches/lan/catalyst_microswitches/software/releases/15_2_7_e/command_reference/b_1527e_microswitch_cr/system_management_commands.html>

It should not be used as evidence, and the reason is not a matter of taste: **the identical eleven rows, in the
identical order, appear in third-party switch manuals** that inherit the same OEM sample text —
Hikvision's command guide
(<https://www.hikvision.com/content/dam/hikvision/en/support/download/firmware/transmission-&-display/04-network-switch/full-managed/command/gigabit/12-MAC%20Address%20Table%20Configuration%20Commands%20.pdf>)
and SNR's for its S2970G
(<https://snr.systems/site/data-files/site/data-files/SNR%20Switches/Command%20Guide/SNR-S2970G-48S/10-MAC%20Address%20Table%20Configuration%20Commands.pdf>).
A `0000.0000.0001` MAC is not an address a Catalyst forwards to its CPU; it is what an SDK sample puts in a
table when nobody filled one in. The Cisco pages carrying it are showing a copied example, not a paste from the
box the page is about — and the same page's own `show mac address-table static` example, a few paragraphs down,
shows the *other* set (`0100.0ccc.cccc`, `0180.c200.0000`, …), so the page does not even agree with itself.

Two independent real 2960 pastes (above) show the twenty, not the eleven, and the `static` example on the same
Cisco page shows a set of the same shape. The eleven-row sample is treated here as documentation boilerplate.

## What changed, and why the twenty rather than the twenty-one

`engine/cli.js` now prints the twenty rows the classic and XE transcripts share — `0100.0ccc.cccc`,
`0100.0ccc.cccd`, `0180.c200.0000` through `0180.c200.0010`, `ffff.ffff.ffff` — above the learned rows of an
unfiltered `show mac address-table` on a device whose category is a switch, counts them in the closing total,
and prints none of them under `interface <port>`. `test/mac-table-reserved-rows.test.js` (22 checks) pins the
set, the order, the four cells, the placement above the learned rows, the counted total, the filtered view, and
the fact that a PC answering the same command still gets an empty table.

This supersedes the judgement in `research/mac-table-surround.md` ("adopting one list would be inventing a
platform"). What changed is the evidence, not the standard: with a real 2960 paste in hand the variance is not
"a different set per image", it is **one row** — `0180.c200.0021`, which the XE family adds between `0010` and
`ffff.ffff.ffff`. The twenty printed are the intersection of every transcript, so no row this console prints is
a row some Catalyst would not have; on an XE model it prints one row fewer than the hardware would. That is the
same simplification this console already makes for `ping`'s defaults and for `show vlan`'s shape — one
IOS-shaped answer for a catalogue of 2,357 models — and it is recorded here rather than hidden.

## What remains unresolved

* **The XE row.** Printing `0180.c200.0021` for the models that would print it needs a per-model platform fact
  the catalogue does not carry (image family, not `model`). Until it does, the console prints the shared twenty
  for every switch, and an XE lab is one row and one count short.
* **What the block is not in.** The block is printed by the console and is not part of `macRows()`, so the state
  payload the browser's MAC panel reads still holds learned entries only. The block is not state — no frame
  teaches it and nothing can age it out — but a reader comparing the panel to the console will see the
  difference. Deciding whether the panel should draw it too is a payload question, not a CLI one.
* **`show mac address-table static`, `dynamic`, `vlan`, `count` and `address`** are still refused or unbuilt, and
  the reserved block is what those views disagree about most (the `static` view shows it, `dynamic` shows none of
  it, `count` shows it in no VLAN). Each is its own question.
* **Capacity.** A real box's table has a size, and the reserved rows consume twenty of it; nothing here models a
  full table or `show mac address-table count`'s free space.

## What would settle the rest

1. One paste of `show mac address-table` from a factory-default **C2960X-24TS-L** and one from a **C9200L-24P-4X**
   (both in the catalogue), captured rather than copied, would confirm or kill the 20/21 split at the two models
   the catalogue actually sells.
2. Cisco's reserved-address list per platform (the address tables behind CDP/STP/LLDP) would say whether
   `0180.c200.0021` is a protocol address the XE images added or a per-image implementation detail.
3. A capture of `show mac address-table static` and `show mac address-table vlan 1` on the same box would settle
   which views the block travels into — the question the next increment would need.
