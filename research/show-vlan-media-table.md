# `show vlan` is two tables — what the second one holds, and what prints it

**Question (one, narrow).** On a real Cisco-style access switch, does `show vlan` print the same thing as
`show vlan brief`, and if not, what does the extra part contain — column by column?

**Verdict: known, and adopted.** `brief` is the subset. The vendor's syntax description says it prints "only a
single line for each VLAN, naming the VLAN, status, and ports"; the full view prints that table and then a
media table (`VLAN Type SAID MTU Parent RingNo BridgeNo Stp BrdgMode Trans1 Trans2`) followed by two sections
— `Remote SPAN VLANs` and the private-VLAN table — which are printed whether or not they have contents.

PacketForge sent both words to the same printer, so `show vlan` answered with the brief view: a reader asking
which media a VLAN is, or what its SAID is, got no column that holds the answer, and `brief` was a synonym
rather than a narrower question. Fixed in `engine/cli.js` (`VLAN_MEDIA_COLUMNS`, `vlanMediaCells`,
`vlanMediaLine`, `vlanMediaRule`) with `test/show-vlan-media-table.test.js` (56 checks).

## The shape, character for character

```
VLAN Type  SAID       MTU   Parent RingNo BridgeNo Stp  BrdgMode Trans1 Trans2
---- ----- ---------- ----- ------ ------ -------- ---- -------- ------ ------
1    enet  100001     1500  -      -      -        -    -        0      0
1002 fddi  101002     1500  -      -      -        -    -        0      0
1003 tr    101003     1500  -      -      -        -    -        0      0
1004 fdnet 101004     1500  -      -      -        ieee -        0      0
1005 trnet 101005     1500  -      -      -        ibm  -        0      0

Remote SPAN VLANs
------------------------------------------------------------------------------

Primary Secondary Type              Ports
------- --------- ----------------- ------------------------------------------
```

| field | width incl. separator | rule dashes | starts at column |
| --- | --- | --- | --- |
| VLAN | 5 | 4 | 0 |
| Type | 6 | 5 | 5 |
| SAID | 11 | 10 | 11 |
| MTU | 6 | 5 | 22 |
| Parent | 7 | 6 | 28 |
| RingNo | 7 | 6 | 35 |
| BridgeNo | 9 | 8 | 42 |
| Stp | 5 | 4 | 51 |
| BrdgMode | 9 | 8 | 56 |
| Trans1 | 7 | 6 | 65 |
| Trans2 | 6 | 6 | 72 |

Header and rule are 78 columns; a row is 73 because the box trims the padding after the last value. The
`Type  ` and `Stp  ` double spaces in the header are the giveaway that these are fixed fields and not
single-space-separated words: only the 6-wide `Type` and the 5-wide `Stp` fields produce them.

## Evidence

| Source | Shows |
| --- | --- |
| [Cisco IOS LAN Switching Command Reference, `show vlan`](https://www.cisco.com/c/en/us/td/docs/ios/lanswitch/command/reference/lsw_book/lsw_s2.html) | The exact spacing above: 78-column header and rule, 73-column rows, `1    enet  100001     1500  -      -      -        -    -        0      0`, then `Remote SPAN VLANs`, then `Primary Secondary Type              Ports` |
| [Catalyst 2960-XR 15.2(5)E Consolidated Platform Command Reference, `show vlan`](https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst2960xr/software/15-2_5_e/command_reference/b_1525e_consolidated_2960xr_cr/m_vlan_cr.html) | `1003 token-ring-default act/unsup`, `1003 tr 101003 1500 …`, `1005 trnet 101005 1500 …`, the RSPAN section with `2000,3000` under it, then the private-VLAN header |
| [Catalyst 2960-L 15.2(7)E Command Reference, VLAN commands](http://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst2960l/software/15-2_7_e/command_reference/b_1527_2960l_cr/vlan_commands.html) | Same rows and sections on a third platform |
| [Catalyst 9200 16.10 Command Reference, VLAN Commands (PDF)](https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst9200/software/release/16-10/command_reference/b_1610_9200_cr/b_1610_9200_cr_chapter_010010.pdf) | Same table, a 78-dash RSPAN rule, and the `vlan` command's defaults: "The default said-value is 100000 plus the VLAN ID; the mtu-size variable is 1500; the stp-type is ieee" |
| [Cisco Community, "Show Vlan command does not show all Vlans"](https://community.cisco.com/t5/switching/show-vlan-command-does-not-show-all-vlans/m-p/3918577) | A live 3850 running 16.3.9: `1003 tr 101003 1500 - - - - - 0 0`, `1004 fdnet … ieee`, `1005 trnet … ibm`, both trailing sections present with nothing under them |
| [Cisco Catalyst 1000 15.2(7)E Command Reference (PDF)](https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst1000/software/releases/15_2_7_e/command_reference/b_1527e_1000_cr/vlan_commands.pdf) | Same view, same 78-dash RSPAN rule |

## What each part is, and how sure

* **`brief` is the subset, and the media table belongs to the full view: documented** by the syntax
  description ("only a single line for each VLAN") and by every sample, which prints `show vlan brief` with the
  first table alone.
* **The four reserved rows carry their medium's type, SAID, and spanning-tree flavour: documented.** `fddi` /
  `tr` / `fdnet` (ieee) / `trnet` (ibm); the SAIDs are 101002-101005.
* **`Stp` prints `-` on an Ethernet row, although the `vlan` command's default stp-type is `ieee`:
  documented, and apparently contradictory.** Every sample shows `-`; the display is of the media's flavour,
  not of the value the command would accept. Both facts are in the sources above.
* **MTU 1500 on every row: true for the platforms this console follows, false for others.** The 6500 sample
  gives its Token Ring rows 4472 (and `Parent 1005`, `RingNo 3276`, `srb` for `trcrf`), because those rows are
  real Token Ring media with real parents. This console can only create Ethernet VLANs, so it prints Ethernet
  MTUs and no parent/ring/bridge numbers. It has no source-route bridging and no translational bridge, so
  `Trans1`/`Trans2` are always 0; a 6500 sample shows 303/0 for a VLAN that has one.
* **The RSPAN rule is 78 dashes: platform-dependent.** Every modern platform (2960-XR, 2960-L, 9200, Catalyst
  1000) and the live 3850 print 78; the older Supervisor-engine sample prints 17, the length of the words
  above it. This console follows the modern one, which is the platform family its other tables come from.
* **The private-VLAN table is printed even with no private VLANs: documented** in the 2960-XR and 6500
  samples and in the 3850 transcript, where the heading and rule are followed by nothing at all.
* **Whether an empty `Remote SPAN VLANs` section prints the rule and nothing else: documented** — the 3850
  transcript ends the section with the rule and no list.
* **What a `show vlan id <n>` prints is unresolved, and out of scope here.** This console refuses the form
  (`show vlan` "does not take" an argument) so there is no second view to keep consistent with this one. A
  sample of `show vlan id 20` from a 2960-X would show whether it reprints both tables or only the first, and
  whether the trailing sections survive.

## What would settle the remaining question

One `show vlan id 20` from a 2960-X/9200, and one from a 6500 with a translational bridge configured, would
answer the two open items: which parts of the furniture a filtered view reprints, and whether a platform with
a real bridge prints `BrdgMode`/`Trans1` where this one prints `-`/`0`.
