# `show spanning-tree`: the `Prio.Nbr` column, and where its number comes from

**Question (one, narrow).** The per-port table this console prints has `Interface`, `Role`, `Sts`,
`Cost` and `Type`; every capture also has a `Prio.Nbr` column between `Cost` and `Type`. What is in
that cell - and is the number in it one this simulator can state about a port it invented?

**Verdict: the column's geometry is settled and its value is not derivable from the port's name - but
it is derivable from the port's place, and `show spanning-tree` now prints it (second pass, #2580).**
`Prio.Nbr` holds `128.N`, where `N` is the port's ordinal in the chassis's own port table - the number
of ports the table places ahead of it, i.e. `base(module) + port`. That base is a slot-layout property,
not a name property: 0, 6, 24 and 128 all appear in captures of different boxes, and two captures of one
family use different strides. No function of the interface name reproduces those numbers. What the first
pass did not have was a second way to arrive at `N`: on a **single-unit** box - every model in this
catalogue - the base is 0 and the ordinal is simply the port's position in the front-panel list, which is
exactly the order the catalogue stores. Four more captures of that shape were found, the three that
settle the mixed-family case are quoted below, and `engine/stp.js`'s `portOrdinals()` now counts the
position off that list. A bundle keeps `-`; the half that is still open is a model whose catalogue list
omits a front-panel position, which nothing in the catalogue can reveal about itself.

## Evidence

| Source | What it gives |
| --- | --- |
| [ntc-templates, `cisco_ios_show_spanning_tree.raw`](https://raw.githubusercontent.com/networktocode/ntc-templates/master/tests/cisco_ios/show_spanning-tree/cisco_ios_show_spanning_tree.raw) | A machine-recorded session, so the spaces survived. Header `Interface           Role Sts Cost      Prio.Nbr Type`; rule runs 19/4/3/9/8/32; fields begin at 0, 20, 25, 29, 39, 48 - so `Prio.Nbr` is a 9-wide left-aligned field and `Type` starts at column 48. Rows `Gi0/2 ... 128.3`, `Gi0/3 ... 128.4`, `Gi1/0 ... 128.5`, one box at one instant. |
| [Router Alley, *Spanning Tree Protocol* guide (PDF)](https://www.routeralley.com/guides/stp.pdf) | `show spanning-tree interface gi2/10` prints `Prio.Nbr 128.34` and `show spanning-tree interface gi2/24` prints `128.48`; the same guide's detail view prints `Port 47 (GigabitEthernet2/23)`. Module 2's base is 24 on that chassis: 24+10, 24+24, 24+23. |
| [Catalyst 4500 configuration guide, 12.2(25SG), Configuring STP and MST (PDF)](https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst4500/12-2/25sg/configuration/guide/conf/spantree.pdf) | Table rows `Fa3/1  Desg FWD 19  128.129  P2p` and `Fa4/5  Desg FWD 200000  128.197  P2p`, with the detail view printing `Port 129 (FastEthernet3/1) of VLAN0001 is forwarding`. 128 ports sit before module 3's first one and 192 before module 4's: a 64-port stride on that chassis. |
| [Cisco ASR 920 LAN Switching guide, IOS XE 17](https://www.cisco.com/c/en/us/td/docs/routers/asr920/configuration/guide/lanswitch/17-1-1/b-lanswitch-xe-17-1-asr920/b-lanswitch-xe-17-1-asr920_chapter_0111.html) | `Gi0/0/7  Altn BLK 4  128.14  P2p` beside `show spanning-tree interface gigabitEthernet 0/0/7 detail` -> `Port 14 (GigabitEthernet0/0/7)`. Base 7 on a box whose eight ports are `0/0/0`-`0/0/7`. |
| [Pearson, *CCNA Portable Command Guide* appendix B (PDF)](http://ptgmedia.pearsoncmg.com/imprint_downloads/cisco/bookreg/9781587143731/40_9781587143731_appb.pdf) | A 24-port 2960: `Fa0/13 ... 128.13`, `Gi0/1 ... 128.25`, `Gi0/2 ... 128.26` - the two uplinks sit after the 24 downlinks here. |
| [Catalyst 1200 CLI guide, spanning-tree commands](http://www.cisco.com/c/en/us/td/docs/switches/campus-lan-switches-access/Catalyst-1200-and-1300-Switches/cli/C1200-cli/spanning-tree-commands.html) | `show spanning-tree detail`: `Port 1 (gi1/0/1) ... Port id: 128.1`, with ports 2, 3, 4 reading `128.2`, `128.3`, `128.4`; a designated port on a 24-port neighbour reads `128.25`. |
| [Catalyst 9400 16.12 command reference, Layer 2/3 commands (PDF)](http://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst9400/software/release/16-12/command_reference/b_1612_9400_cr/layer_2_3_commands.pdf) | `Gi1/0/1  Desg FWD 20000  128.1`, `Te1/0/25  Desg FWD 20000  128.25`, and the detail view `Port 1 (GigabitEthernet1/0/1) of VLAN0001 is designated forwarding`. |
| [Catalyst 9200 17.7 command reference, Layer 2/3 commands (PDF)](http://cisco.com/c/en/us/td/docs/switches/lan/catalyst9200/software/release/17-7/command_reference/b_177_9200_cr/layer_2_3_commands.pdf) | The field tables: `Prio.Nbr` = "Port ID that consists of the port priority and the port number", and "Port ID Prio.Nbr / Port ID and priority number". The command's own sample also prints `Port path cost 20000, Port priority 128, Port Identifier 128.1.` |

## What is known

1. The cell is `<port priority>.<port number>`, written with no padding inside the field: `128.1`,
   `128.34`, `128.129`. Two vendor field tables say so, and every row above agrees.
2. The same number is the detail view's `Port N (<long name>)` and its `Port Identifier 128.N`. The two
   views are one fact printed twice, which is how a table cell and a detail paragraph can be checked
   against each other on a single box.
3. Within one box the numbers are affine in the port number: `gi2/10` and `gi2/24` are 34 and 48
   (difference 14, the difference of 24 and 10), `Fa3/1` and `Fa4/5` are 129 and 197 (difference 68 =
   64 + 5 - 1), `Gi0/2` and `Gi0/3` are 3 and 4. So the number is `base(module) + port` on every captured box,
   where the base is the count of ports the chassis places ahead of that module.
4. The priority byte is the port's `spanning-tree port-priority`, default 128; the captures that set it
   print `64.33` and `129.8` in the detail view.
5. The geometry (20/5/4/10/9/rest, `Type` at column 48, rule runs 19/4/3/9/8/32) is measured, not
   inferred - the ntc-templates session is machine-recorded.

## What is inferred

* **That the number is the port's ordinal in the chassis port table, not anything in its name.** `N`
  is 1 + the ports the table places before it: 3 for `Gi0/2` on the ntc box (whose own rows force
  `Gi0/0`=1 and `Gi0/1`=2, since `Gi0/3` reads 4), 13 for `Fa0/13` on a 24-port 2960, 14 for `Gi0/0/7`
  on the ASR (six ports ahead of that module), 34 for `gi2/10` (24 ahead of module 2) and 129 for
  `Fa3/1` (128 ahead of module 3). Two of those are the *same product family* on different chassis -
  Router Alley's 24-port modules and the 4500 guide's 64-port stride - which rules out a per-family
  rule as well as a per-name one.
* **That a 2960's uplinks are numbered after its downlinks** on the Pearson box (`Gi0/1`->25). "The SFP
  ports come first" is not a platform convention either, only a chassis one.
* **That a bundle takes an index too.** The 4500 chapter prints a `PO0 ... 128.20` row, so a
  Port-channel has a place in the same table. This console has no such table, and a bundle row here is
  `Po1`.

## The two captures that settle the mixed-family case (second pass)

The first pass could say that `N` is an ordinal but not what order the ordinal follows when a box has two
families of port - the case every access switch in this catalogue is. Three captures answer it, and all three
say the numbering **continues** across the family boundary instead of restarting:

| Source | Rows |
| --- | --- |
| [Cisco Community, "Root Bridge has Backup port"](https://community.cisco.com/t5/switching/root-bridge-has-backup-port/td-p/4818830) - a 9200 on IOS 17.x, `show spanning tree vlan128 detail` | `Gi1/0/1 ... 128.1` through `Gi1/0/24 ... 128.24`, then `Gi1/0/25 ... 128.25`, `Gi1/0/26 ... 128.26`, `Gi1/0/27 ... 128.27`. The uplinks are the last four positions of one table, not a second table. |
| [Cisco Community, "Spanning-tree between 4 connected switches"](https://community.cisco.com/t5/switching/spanning-tree-between-4-connected-switches/td-p/2546434) | `Gi0/25 Desg FWD 19 128.25 Edge P2p`, `Gi0/26 ... 128.26`, `Gi0/27 ... 128.27` on a 24-port box, and the same box's root-cost block prints `Port 47 (GigabitEthernet0/47)` - port 47, index 47. |
| [Cisco Learning Network, "Port in show spanning-tree vlan x"](https://learningnetwork.cisco.com/s/question/0D53i00000Kt6h5CAB/port-in-show-spanningtree-vlan-x) | `Gi0/1 Root FWD 4 128.25 P2p`, `Gi0/2 Altn BLK 4 128.26 P2p` - the same 24 + 1 and 24 + 2 shape, with the uplink as the root port. |

Together with the Pearson capture already in the table above (`Fa0/13 128.13`, `Gi0/1 128.25`, `Gi0/2 128.26`)
that is four boxes, two releases and two vendors' worth of stacking, all agreeing that position 25 is the
first uplink. The ntc-templates session agrees from the other end: its `Gi0/2` is `128.3` because that box's
first port is `0/0`, so `0/2` is the third position.

## What the console does now

`engine/stp.js`'s `portOrdinals(device)` walks `device.interfaces` in front-panel order and gives every port
whose `type` is `ethernet` the next number; `show spanning-tree` prints `128.<n>` in a 9-wide field between
`Cost` and `Type`. Two rules are applied and both are stated in the source:

* **A combo uplink is one position with two front ends.** The catalogue stores such a pair as two interfaces
  (`comboWith`/`comboRole`, e.g. `Gi1/0/9` and `Gi1/0/9-sfp` on a C1000-8P-2G-L), so the SFP half takes its
  RJ45 partner's number instead of consuming one. Without this, every port after a combo pair on 31 models
  would be one place too high.
* **A port that is not an Ethernet front end takes no place.** A console line, a radio, a DSL or PON socket is
  not a bridge port, so it neither takes a number nor shifts one: the ordinal is over Ethernet ports only.

A bundle row keeps `-`. Its port ID is real but platform-assigned - `PO0 128.20` on a 4500, `Po1 128.65` on a
2950, `Po1 128.3433` on a 9600 - and no catalogue field carries that number, so inventing one would be the
guess this note exists to avoid.

## What is still unresolved

* **A model whose catalogue port list omits a front-panel position.** The ordinal is only as faithful as the
  list it counts, and a spec that covered 24 of a chassis's 28 sockets would number everything after the gap
  one place short. Nothing in a spec says it is complete; the port-count audits check declared ports against
  declared templates, not against the datasheet's socket count. A model whose family numbering skips a number
  (e.g. `Gi1/0/1-24` then `Gi1/0/27-28`) is the visible symptom, and no such model was found, but absence of
  the symptom is not proof of a complete list.
* **A modular or stacked box.** `Fa4/5 128.197` (a 64-port stride) and `Port 204 (GigabitEthernet4/0/42)` show
  that the base is per-chassis, and no model in this catalogue names a module other than 0 or 1.
* **A bundle's own ID**, above.

## Why the first pass left the engine alone (and why the second does not)

A name-derived cell is right exactly where the base happens to be 0 and the numbering is contiguous,
and wrong on the boxes a reader would check: `Gi0/1` is `128.1` on a Catalyst 1200 and `128.25` on a
24-port 2960, and `Gi2/10` is `128.10` on a box whose module 2 starts at 1 but `128.34` on Router
Alley's. The catalogue carries each model's ports but not its slot map or its index base, so every
candidate rule is "right on the model in front of the author, wrong on the next one". The console
already prints `-` in the `Type` cell rather than guess a link type; a whole column of guessed
`128.<n>` values would be worse than the column's absence, because a reader would trust it.

The geometry, by contrast, was already measured: a `prio` field between `cost` and `type` in
`STP_TABLE_WIDTHS`, the cell padded to 9, and `Type` moved to column 48 reproduce the capture exactly. The
first pass stopped there because it could not name a rule for the number; the second found one that needs
nothing the catalogue does not already store (the front-panel order), so the column is printed and the
residual risk is confined to the two cases above rather than spread over every row.

## What would settle the remainder

* **A per-family port map**, from a same-box triple: the `Prio.Nbr` cell, the detail view's
  `Port N (<name>)`, and `show snmp mib ifmib ifindex [interface]` for the same port. If `Prio.Nbr`
  tracks `ifIndex` on those platforms - the 6500 command reference documents that command as printing
  "the SNMP interface index identification numbers (ifIndex values) ... assigned to interfaces" - then
  the property to model is an ifIndex per port, a real device property with one number per port, and not
  a spanning-tree field. A stack would settle the harder half: whether member 2's first port continues
  member 1's numbering.
* **Or a decision to model a subset**: single-module boxes whose catalogue names run `Type 0/1` ...
  `Type 0/N` with base 0, printing the column only there and `-` elsewhere - plus a capture of a `Po`
  row on a box whose bundle number and port number disagree, which is the one case this console cannot
  compute at all.

One capture could not be used: the Catalyst 2960-XR command reference prints `Gi2/0/1 ... 128.24` and
`Gi0/1 ... 128.24` in the same table block, so at least one of the two is a rendering artefact, and the
PDF's text layer does not preserve the spacing that would say which.
