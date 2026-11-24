# `show spanning-tree`: the `Cost` column, and what the first column is called

**Question (one, narrow).** In the per-port table `show spanning-tree` prints, what are the four columns
the device actually draws before its `Type` field - what is the first one headed, how wide is each field,
and what number goes under `Cost`? This console printed `Port  Role  Sts` in two 14-character fields, a
header no box produces, and no cost at all.

**Verdict: the header is `Interface  Role Sts Cost`, the fields are 20 / 5 / 4 / 10, and `Cost` carries
the short-method path cost of the link.** Changed: the header, the rule line under it, the column widths,
and a `Cost` cell read from the number `computeStp()` charged the port. Two columns of the vendor's header
are still not printed, and this note says why.

## Evidence

| Source | What it gives |
| --- | --- |
| [ntc-templates, `cisco_ios_show_spanning_tree.raw`](https://raw.githubusercontent.com/networktocode/ntc-templates/master/tests/cisco_ios/show_spanning-tree/cisco_ios_show_spanning_tree.raw) | A machine-recorded Catalyst session, so the spaces survive: `Interface           Role Sts Cost      Prio.Nbr Type` / `------------------- ---- --- --------- -------- --------------------------------` / `Gi0/2               Desg FWD 4         128.3    Shr`. Measured fields: `Interface` at 0-19, `Role` at 20, `Sts` at 25, `Cost` at 29, `Prio.Nbr` at 39, `Type` at 48; rule runs 19/4/3/9/8/32. A 1 Gb port reads `4`. |
| [Catalyst 9300 17.12 command reference, Layer 2/3 commands (PDF)](http://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst9300/software/release/17-12/command_reference/b_1712_9300_cr/layer_2_3_commands.pdf) | The same header and the same layout, with `Gi1/0/1  Desg FWD 20000  128.1  P2p` - the *long*-method cost, because that platform defaults to `pathcost method long`. The header is stable across the two methods; only the number under `Cost` moves. |
| [Pearson, *CCNA Portable Command Guide* appendix B (PDF)](http://ptgmedia.pearsoncmg.com/imprint_downloads/cisco/bookreg/9781587143731/40_9781587143731_appb.pdf) | `show spanning-tree vlan 10` on a 2960: `Fa0/13  Desg FWD 19  128.13  P2p Edge`, `Gi0/1  Root FWD 4  128.25  P2p`, `Gi0/2  Altn BLK 4  128.26  P2p`. A 100 Mb port reads `19` beside a 1 Gb port's `4` - the short table, on one box. |
| [Catalyst 9200 17.2 Layer 2 config guide](https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst9200/software/release/17-2/configuration_guide/lyr2/b_172_lyr2_9200_cg/configuring_spanning_tree_protocol.html) | "The short path cost method is the default STP path cost method", and the default table `10 Mbps 100 / 100 Mbps 19 / 1 Gbps 4 / 10 Gbps 2 / 25 Gbps 1 / 40 Gbps 1`. The numbers the engine already charges (`research/stp-path-cost.md`). |
| [Cisco ASR 920 LAN Switching guide, IOS XE 17](https://www.cisco.com/c/en/us/td/docs/routers/asr920/configuration/guide/lanswitch/17-1-1/b-lanswitch-xe-17-1-asr920/b-lanswitch-xe-17-1-asr920_chapter_0111.html) | `Gi0/0/7  Altn BLK 4  128.14  P2p` - the fourth independent row with `Cost` in the same place, and the same box's detail view one command away. |

`Cost` is therefore not a per-platform flourish: every capture has the column, the values are the path
cost of the port's rate, and the short-method numbers are the ones this engine already uses for the
election.

## What is inferred

* **That this console should print `Cost` at all.** It is an inference from completeness, not from a
  capture of *this* simulator: the cell exists on every captured box, the engine has held the number
  since the path-cost fix, and the one thing a reader compares when two ports disagree is the price of
  each. The same argument `show interfaces`' counters and `show vlan`'s media table were given.
* **The rule line.** The captures draw one under the header. This console draws it for the four fields it
  prints, so it stops at 40 characters instead of the capture's 80: a reduced table's rule ends where the
  table does.

## What changed

* `engine/simulator.js`: `computeStp()` now records the cost it charged each logical port on
  `dev.stp.costs[name]` (the value `runStp()` already returned in `ports[key][name].cost`), so the console
  reads one number instead of deriving a second one. `engine/device.js` initialises the map with the other
  runtime STP state.
* `engine/cli.js`: the table's header, rule and rows are the capture's - `Interface` in a 20-wide field,
  `Role` 5, `Sts` 4, `Cost` unpadded last - and each row's cost is `dev.stp.costs[name]`. A port label
  longer than its field pushes the row rather than running into the next cell, the rule
  `vlanMediaLine()` follows.
* `test/stp-cost-column.test.js` (23 checks): the exact header, the exact rule, the column positions, `4`
  for 1 Gb and `19` for 100 Mb, a three-switch triangle where every printed cell equals
  `dev.stp.costs[]`, a two-member bundle printed as `Po1` with the bundle's cost (`2`), and the absence of
  the two columns this model cannot state. Three existing suites were updated for the new header, the rule
  line and the fourth cell.
* `docs/CLI.md`, `docs/ARCHITECTURE.md`: the two transcripts that quoted the old header.

## What remains unresolved

* **`Prio.Nbr`.** The capture reads `Gi0/2 -> 128.3` and `Gi1/0 -> 128.5`, i.e. priority 128 in front of
  the port's *index* on the box, which is not the last number of the name and not the name's position in
  the table (that stack's numbering runs across members). A catalogue of 2,356 specs has names like
  `Port 3`, `eth0` and `Gi1/0/2`, and no source states how a box numbers a port whose name is not its
  index. Printing `128.<n>` would be right on a Catalyst and invented everywhere else. Evidence that would
  settle it: a capture from a box whose ports are numbered non-sequentially (a stack, or a switch with a
  down module) plus the vendor's definition of the port number - or a decision to model only names that
  are `Type slot/port`. `research/stp-port-table-prio-nbr-column.md` takes the
  mechanism further - the number is `base(module) + port` with bases 0, 1, 7, 24 and 129 measured on
  real chassis - and confirms that no rule derived from the name can reproduce it.
* **`Type`.** `P2p`, `Shr`, `P2p Edge` and `-` are the documented values; `Edge` is portfast, `Shr`/`P2p`
  is a duplex decision about the link. This model has duplex on a link and no portfast, so a `Type` cell
  would be a guess on half the rows. Evidence that would settle it: a capture of a *shut* or *unplugged*
  port's `Type` cell (does a box with no link say `P2p`, `Shr` or `-`?).
* **The per-VLAN heading.** Every capture prints one table per VLAN under a `VLAN0001` heading with
  `Root ID` / `Bridge ID` blocks; this console runs one tree per device and prints neither. That is a
  model change (PVST), not a layout fix, and `research/stp-path-cost.md` already records it as such.
* **The long-method platforms.** A C9500-32C or a CBS 250 prints the long numbers under the same header.
  The engine says "short" for every model because it has no per-model field to say otherwise; the note
  above carries that open item.
* **A bundle's cost.** `Po1` of two 1 Gb members reads `2` here and in the one measured pair
  (`research/port-channel-path-cost.md`). The arithmetic for three or more members is still an inference,
  and the table now prints it: a capture of a 3- or 4-member bundle's `Cost` cell would settle it.
