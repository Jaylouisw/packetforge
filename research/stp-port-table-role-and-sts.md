# `show spanning-tree`: what the `Role` and `Sts` cells hold

**Question (one, narrow).** In the per-port table `show spanning-tree` prints, does the device
spell the role and state out (`designated`, `forwarding`) or abbreviate them (`Desg`, `FWD`),
and does a blocked port carry a note such as `(traffic dropped)`?

**Verdict: the table abbreviates, and the note is not a device string.** Every capture found prints
four- or five-letter roles and three-letter states, and the command reference enumerates those
abbreviations as the column's valid values. The long words are real device output too, but in
`show spanning-tree detail`, where the port is the subject of a sentence. This console printed the
detail sentence in the table cell and appended `(traffic dropped)`, which no capture shows. Changed
here.

## Evidence

| Source | What it prints |
| --- | --- |
| [Cisco Catalyst 9300 17.12 command reference, Layer 2/3 commands (PDF)](http://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst9300/software/release/17-12/command_reference/b_1712_9300_cr/layer_2_3_commands.pdf) | `show spanning-tree` sample: `Interface  Role Sts Cost  Prio.Nbr Type` / `Gi1/0/1  Desg FWD 20000  128.1  P2p`. Field table: **Role** = "Current 802.1w role; valid values are Boun (boundary), Desg (designated), Root, Altn (alternate), and Back (backup)"; **Sts** = "Spanning-tree states; valid values are BKN* (broken), BLK (blocking), DWN (down), LTN (listening), LBK (loopback), LRN (learning), and FWD (forwarding)". |
| [Cisco ASR 920 LAN Switching Configuration Guide, IOS XE 17](https://www.cisco.com/c/en/us/td/docs/routers/asr920/configuration/guide/lanswitch/17-1-1/b-lanswitch-xe-17-1-asr920/b-lanswitch-xe-17-1-asr920_chapter_0111.html) | One box, two commands, same instant: the table prints `Gi0/0/7  Altn BLK 4  128.14  P2p`, and `show spanning-tree interface gigabitEthernet 0/0/7 detail` prints `Port 14 (GigabitEthernet0/0/7) of VLAN0001 is alternate blocking`. The short cells and the long sentence are the same verdict in two views. |
| [Pearson, *CCNA Portable Command Guide* appendix B (PDF)](http://ptgmedia.pearsoncmg.com/imprint_downloads/cisco/bookreg/9781587143731/40_9781587143731_appb.pdf) | `SW3# show spanning-tree vlan 10` rows: `Fa0/13  Desg FWD 19  128.13  P2p Edge`, `Gi0/1  Root FWD 4  128.25  P2p`, `Gi0/2  Altn BLK 4  128.26  P2p`. All three roles this model can elect, in the cells. |
| [Cisco Community, `show spanning-tree detail` output](https://community.cisco.com/t5/switching/question-regarding-output-of-show-spanning-tree-detail-command/td-p/2302431) | A 2960-class box: `Port 1 (FastEthernet0/1) of VLAN0001 is designated forwarding`. The long pair belongs to the detail view, not the table. |

## What is known

1. The table's header is `Interface  Role Sts Cost  Prio.Nbr Type`; the cells under `Role` are
   `Root`, `Desg`, `Altn` (and `Boun`/`Back` on platforms that can produce them), and under `Sts`
   are `FWD`, `BLK`, `LTN`, `LRN`, `DWN`, `LBK`, `BKN*`.
2. The transitional states are part of that vocabulary: `listening` prints `LTN` and `learning`
   prints `LRN`, between the election and `FWD`.
3. No captured table has a `(traffic dropped)` suffix, or any other parenthetical explaining what
   `BLK` means. The explanation lives in the detail view's sentence (`is alternate blocking`) and
   in the prose of the configuration guide ("Alternate - A blocked port providing an alternate path
   to the root bridge").
4. `show spanning-tree detail` is a different command with a different shape: sentences, per-port
   paragraphs, BPDU counters. The table is not that view with the words shortened; both are the
   device's, one cell spelling and one prose spelling.

## What is inferred

This console's table is a reduced IOS table: it prints the port name, the role and the state, and
omits `Cost`, `Prio.Nbr` and `Type`. A reduced table still has to use the vocabulary of the columns
it keeps, or the one cell an operator compares against a capture is the one that does not match.
(`Cost` has since been added, with the header and widths transcribed from a machine-recorded capture -
`research/stp-port-table-cost-column.md`; `Prio.Nbr` and `Type` stay out.)
The state comes from the convergence model (`engine/convergence.js`), which reports `listening`,
`learning`, `forwarding` and `blocking`; the first two are exactly `LTN` and `LRN` in the command
reference's list, so they are mapped rather than left in lower case.

## What changed

* `engine/stp.js` now owns the cell spelling: `stpRoleCell()` maps `root`/`designated`/`alternate`
  to `Root`/`Desg`/`Altn`, and `stpStateCell()` maps `forwarding`/`blocking`/`listening`/`learning`
  to `FWD`/`BLK`/`LTN`/`LRN`. A word outside those sets is returned unchanged - the mapping does not
  invent a cell for a role or state the engine cannot produce.
* `engine/cli.js` prints the two mapped cells and no longer appends `(traffic dropped)`; the table
  row is the device's, not the detail view's. (The header it printed at the time was
  `Port          Role          Sts`; the heading and widths have since become the capture's, and a
  `Cost` column was added - `research/stp-port-table-cost-column.md`.)
* The detail-view sentence is still produced by `stpPortText()` and still travels in the runtime
  payload and the faceplate tooltip, where a sentence is the right shape. The console and the
  tooltip now differ in wording because the device differs, not because two code paths drifted.
* `test/stp-port-table-role-and-sts.test.js` (26 checks) pins the mapping, the header, the
  transitional `LTN` cell, the converged `Root FWD`/`Desg FWD`/`Altn BLK` cells, the absence of any
  spelled-out word or `(traffic dropped)` note in the table, and the survival of the payload
  sentence. Existing suites that read the table were updated to the cells.

## What remains unresolved

* **The first column's heading and the row widths - closed.** A box prints `Interface` in a
  20-character field; this console printed `Port` in a 14-character one. Both are now the capture's,
  together with the `Cost` column (`research/stp-port-table-cost-column.md`).
* **`Prio.Nbr` and `Type`.** The device prints them; this table does not model the port's platform
  index or the link type (P2p/Shr/Edge), and neither can be derived from what the model holds.
  `research/stp-port-table-cost-column.md` records what would settle each.
* **Roles and states the model cannot produce.** `Boun`, `Back`, `BKN*`, `DWN`, `LBK` are in the
  device's vocabulary but not in any election this engine runs. They are deliberately unmapped:
  a mapping with no producing path would be a rule with no fact behind it.
* **A shut port's row.** This console omits a shut port from the table (the convergence model does
  not put it in the tree). Some IOS captures show such a port with a `DWN`/`DIS`-style cell; none
  of the captures in hand pairs a shut port with its own `show spanning-tree` row on the same
  platform, so what a 2960 prints for it is not settled here.
