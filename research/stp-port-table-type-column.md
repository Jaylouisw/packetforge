# `show spanning-tree`: the `Type` cell, and what decides it

**Question (one, narrow).** In the per-port table `show spanning-tree` prints, what goes in the `Type`
column, and can this model derive it from what it holds? The previous note on this table left the column
open with a specific worry: "`P2p`, `Shr`, `P2p Edge` and `-` are the documented values; `Edge` is portfast,
`Shr`/`P2p` is a duplex decision about the link. This model has duplex on a link and no portfast, so a `Type`
cell would be a guess on half the rows" (`stp-port-table-cost-column.md`).

**Verdict: the link-type half is a documented, derivable rule, so the column is now printed; the `Edge`
half is not modelled and is never printed.** Cisco states the rule in as many words - the link type "is
automatically derived from the duplex mode of a port. A port that operates in full-duplex is assumed to be
point-to-point, while a half-duplex port is considered as a shared port by default" - so a full-duplex row
reads `P2p` and a half-duplex row reads `Shr`. Every row this table prints names a port with a link, and a
linked port here always has a duplex setting, so the cell is read rather than guessed. A row whose port has
no duplex answer prints `-`. `Edge` needs PortFast, which this console refuses by name
(`spanning-tree portfast` is in `STP_UNMODELLED`), so no row claims it.

## Evidence

| Source | What it gives |
| --- | --- |
| [Cisco TAC, "Understand Rapid Spanning Tree Protocol (802.1w)" (PDF)](https://cisco.com/c/en/us/support/docs/lan-switching/spanning-tree-protocol/24062-146.pdf) | The rule in one sentence: "The link type is automatically derived from the duplex mode of a port. A port that operates in full-duplex is assumed to be point-to-point, while a half-duplex port is considered as a shared port by default. This automatic link type value can be overridden by explicit configuration." |
| [Cisco Nexus 3548 NX-OS Layer 2 Configuration Guide 7.x, "Configuring Rapid PVST+"](https://www.cisco.com/c/en/us/td/docs/switches/datacenter/nexus3548/sw/7x/layer2/configuration/guide/b_Cisco_N3548_Layer_2_Switching_Config_7x/b_Cisco_N3548_Layer_2_Switching_Config_7x_chapter_0110.html) | The same rule twice on one page: "Full-duplex ports are assumed to be point-to-point ports, while half-duplex ports are assumed to be shared ports", and "The switch learns the link type from the port duplex mode: a full-duplex port is considered to have a point-to-point connection and a half-duplex port is considered to have a shared connection." |
| [Cisco Business 350 CLI Guide, "spanning-tree link-type"](https://cisco.com/c/en/us/td/docs/switches/lan/csbms/CBS_250_350/CLI/cbs-350-cli-/spanning-tree-commands.html) | The command's **Default Configuration**: "The device derives the port link type from the duplex mode. A full-duplex port is considered a point-to-point link and a half-duplex port is considered a shared link." Same page shows the override (`auto | point-to-point | shared`) and a detail view reading `Type: Shared (configured: auto)`. |
| [ntc-templates, `cisco_ios_show_spanning_tree.raw`](https://raw.githubusercontent.com/networktocode/ntc-templates/master/tests/cisco_ios/show-spanning-tree/cisco_ios_show_spanning_tree.raw) | A machine-recorded table where every row is `Shr`: `Gi0/2  Desg FWD 4  128.3  Shr` / `Gi0/3  Root FWD 4  128.4  Shr` / `Gi1/0  Altn BLK 4  128.5  Shr`. That box's ports were half duplex (the same capture the `Cost` column was transcribed from), which is what makes `Shr` the correct cell there and not a typo. |
| [Pearson, *CCNA 200-301 Official Cert Guide* Vol 1, Appendix O (PDF)](https://ptgmedia.pearsoncmg.com/imprint_downloads/cisco/bookreg/9780135792735/resources/9780135792735_AppO.pdf) | `show spanning-tree vlan 10` on a 2960: `Fa0/13  Desg FWD 19  128.13  P2p Edge`, `Gi0/1  Root FWD 4  128.25  P2p`, `Gi0/2  Altn BLK 4  128.26  P2p`; and an EtherChannel row `Po1  Root FWD 12  128.64  P2p Peer(STP)`. The suffixes (`Edge`, `Peer(STP)`) sit after the link type. |
| [Cisco Community, "spanning tree vs loss of services"](https://community.cisco.com/t5/switching/spanning-tree-vs-loss-of-services/td-p/2171951) | A live 2960 table with `Fa0/41  Desg FWD 100  128.45  Shr Edge` among its `P2p Edge` rows, and the operator-level statement of the rule: "If the port operates at half duplex, Cisco switch assumes it is a shared link ... If the port operates at full duplex, Cisco switch assumes it is a point-to-point link." |
| [Cisco Nexus 7000 NX-OS Layer 2 Command Reference, `show spanning-tree`](http://www.cisco.com/c/en/us/td/docs/switches/datacenter/nexus7000/sw/layer2/command/cisco_nexus7000_layer2_command_ref/cisco_nexus7000_layer2_command_ref_chapter_01000.html) | The field definition: **Type** = `P2p/Shr` (point-to-point or shared), `vPC`, `vPC peer-link`, `Edge`, `Network`, and the `*ROOT_Inc`-style inconsistency markers. `Shr` is a value of the same cell as `P2p`, not a different column. |

## What is known

1. **The link type is derived from duplex.** Three Cisco documents say it in the same words, one of them the
   command reference's own "Default Configuration" for `spanning-tree link-type`; the override command exists
   precisely because the default is derived rather than configured.
2. **`P2p` and `Shr` are the two cells that follow from duplex.** `P2p` for full, `Shr` for half. Both appear
   in machine-recorded or vendor-published tables (`Shr` on every row of the ntc capture; `Shr` beside
   `Shr Edge` on the 2960 transcript).
3. **`Edge` is a third input, not a third link type.** It is PortFast: the Pearson text lists the two settings
   the switch uses - "the current duplex (full or half) and whether the PortFast feature is enabled" - and
   prints `P2p Edge` only where PortFast is on. `Peer(STP)`, `Bound(STP)` and the Nexus-only `vPC`/`Network`
   values are further suffixes/values from the peer's or the platform's state.
4. **A row in this table always has a link.** The tree is computed over cabled, up ports; this console prints
   a row for exactly the ports the election put in the tree, and omits a shut port (the `Cost` note records
   the same fact). Nothing here prints a row for an unplugged socket.
5. **A bundle's duplex is its members'.** `validateLag()` already refuses members that disagree on duplex
   (`E_LAG_DUPLEX_MISMATCH`), so one member's answer is the bundle's; a hand-edited document with no members
   (or disagreeing ones) answers nothing, and the cell is `-`.

## What is inferred

* **That a three-letter cell is worth printing without `Prio.Nbr` in front of it.** The capture's header runs
  `... Cost  Prio.Nbr Type`; this console cannot state `Prio.Nbr` (the port index is the platform's), so
  `Type` follows `Cost` and the header names it there. The alternative - printing the cell under no heading,
  or printing a made-up index so the columns line up - would be worse: a reader would take the number for a
  fact.
* **The `Type` field's width (8).** A reduced table stops where its columns stop, so the field is this
  console's; the words in it are the device's. `P2p`/`Shr` are three characters, and the width leaves room
  for the `Edge`/`Peer(STP)` suffixes if PortFast or peer-STP detection ever arrives.
* **`-` for a port with no duplex answer.** No capture shows what a box prints for a port whose duplex is
  unknown, because a box always has one. `-` is the same "the model has no answer" cell the `Cost` column
  uses, and it is unreachable from the console today (every catalogue port starts `full`).

## What changed

* `engine/stp.js`: `stpTypeCell(duplex)` - `'P2p'` for full, `'Shr'` for half, `null` for anything else -
  beside `stpRoleCell`/`stpStateCell`, with the vendor sentence in the comment.
* `engine/cli.js`: the table's widths grew a `type: 8` field, the header ends `Cost      Type`, and each row
  reads its duplex from the port it names (`lag-N` rows from the bundle's members, which must agree). The
  `Edge` suffix is never printed, and the block comment that called `Type` unmodelled now says why it is
  printed.
* `test/stp-port-table-type-column.test.js` (33 checks): the mapping and its non-guesses (`auto`, null,
  empty), the exact header/rule/column positions, `P2p` on both ends of a full-duplex cable, `Shr` on both
  ends when both are forced half, `Shr`/`P2p` on the two ends of a duplex mismatch, a bundle's `P2p` and a
  half-duplex bundle's `Shr`, `-` for a hand-edited port with no duplex, and the absence of `Edge`,
  `Prio.Nbr` and a sixth cell.
* Four existing suites updated for the header, the rule and the extra cell (`stp-cost-column`,
  `stp-port-table-role-and-sts`, `stp-port-order`, `stp-port-channel-name`).
* `docs/CLI.md`, `docs/ARCHITECTURE.md`: the two transcripts that quoted the four-column header.

## What remains unresolved

* **A box's `Type` for a port with no link.** Still unwitnessed: this table prints no such row, so nothing
  here depends on it, but a future "list every port" view would. Evidence that would settle it: a capture of
  `show spanning-tree` on a switch with a shut or unplugged port that still gets a row.
* **`Edge`.** Needs PortFast, which needs a command this console refuses. Adding the suffix without the
  command would print a configuration the box cannot hold.
* **`Peer(STP)`, `Bound(STP)`, `Network`, `vPC`.** These say something about the *peer* (a switch running a
  different STP flavour, a boundary port, a Nexus vPC). This model carries no peer-STP flavour, so no row can
  honestly claim one.
* **The override.** `spanning-tree link-type {auto | point-to-point | shared}` lets an operator make a
  half-duplex port `P2p`; it is in `STP_UNMODELLED`, and the cell would follow the override if it arrived.
* **Auto-negotiated half duplex.** Here duplex is a setting. A real box can land on half duplex without
  anyone typing `duplex half` (a hub, or a failed negotiation), and then prints `Shr` for a reason this model
  cannot produce. The mismatch `Shr`/`P2p` pair is tested, but a hub is not modelled.

## What evidence would settle the rest

1. `show spanning-tree` from a Catalyst with one shut port and one unplugged port, to see whether either gets
   a row and what its `Type` cell says.
2. A capture of a port that auto-negotiated to half duplex against a hub, on a box whose running-config has
   no `duplex half`, to confirm the cell tracks the negotiated result rather than the stored setting.
3. The `show spanning-tree` row for a port with `spanning-tree link-type point-to-point` configured while the
   duplex is half - does the cell read `P2p` (the override) or `Shr (configured: point-to-point)` in some
   other column.
