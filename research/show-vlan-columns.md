# `show vlan`: where the columns sit, and what the rule line is drawn from

**Question (one, narrow).** In the `show vlan` table, how wide is each field — the VLAN id, the name, the
status — where does the Ports list start, and is there a line under the header?

**Verdict: known, and now adopted.** Four Cisco command references print the same header, the same rule line
and the same field widths. The console here had the id column five characters too wide (it padded to eight) and
printed no rule line, so `Status` sat at column 41 instead of 38 and the ports at 51 instead of 48 — every row
three columns right of the heading above it. Fixed in `engine/cli.js` (`VLAN_COLUMNS`, `vlanLine`, `vlanRule`)
with `test/show-vlan-table-shape.test.js` (14 checks).

## The shape, character for character

```
VLAN Name                             Status    Ports
---- -------------------------------- --------- -------------------------------
1    default                          active    Fa0/1, Fa0/2
1002 fddi-default                     act/unsup
```

| field | width incl. separator | rule dashes | starts at column |
| --- | --- | --- | --- |
| VLAN | 5 | 4 | 0 |
| Name | 33 | 32 | 5 |
| Status | 10 | 9 | 38 |
| Ports | to end of line | 31 | 48 |

The rule line is 79 characters: each column draws its own width in dashes, one short of the field, because the
space between two columns is not a column. `Pad`ping the id to 8 made the header 56 characters and put the Ports
heading at 51, which is where the three-column offset came from.

## Evidence

| Source | Shows |
| --- | --- |
| [Cisco IOS LAN Switching Command Reference, `show vlan`](https://www.cisco.com/c/en/us/td/docs/ios/lanswitch/command/reference/lsw_book/lsw_s2.html) | Both `show vlan` and `show vlan brief` samples: `VLAN Name Status Ports`, the `---- ----… --- ----…` rule, then `1 default active Fa5/9` and `1002 fddi-default act/unsup` |
| [IOS XE 16.6 Command Reference (Catalyst 9400), `show vlan`](https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst9400/software/release/16-6/command_reference/b_166_9400_cr/b_166_9400_cr_chapter_01100.html) | Same header and rule; VLAN 1 with 48 ports, listed three ports to a line |
| [IOS XE 16.1 Command Reference (Catalyst 3850), `show vlan`](http://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst3850/software/release/16-1/command_reference/b_161_consolidated_3850_cr/b_161_consolidated_3850_cr_chapter_010010.html) | Same, and the reserved 1002–1005 rows with an empty Ports column |
| [Catalyst 3650 16.2 Command Reference, VLAN commands (PDF)](https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst3650/software/release/16-2/command_reference/b_162_consolidated_3650_cr/b_162_consolidated_3650_cr_chapter_010010.pdf) | Same, plus `40 vlan-40`, `300 VLAN0300` rows — a two- and a three-digit id in the same four-character column |

The reserved-row spacing that `test/show-vlan-reserved-defaults.test.js` asserted
(`1002    fddi-default …`) was the old eight-wide id column written down as an expectation; it is now
`1002 fddi-default …`, which is the string the vendor samples contain.

## What this run did not adopt

**Wrapping the Ports list.** On a real box the list breaks at the console width — the doc samples show three
`Gi1/0/x` ports per line for a 48-port VLAN, and the continuation continues in the Ports column. That is
consistent with a default terminal width of 80 columns and a 32-column Ports window, but the extraction of
every vendor page collapses the leading whitespace of a `<pre>` block, so the continuation *indent* was not
observable in the sources read here, and this console has no terminal-width model at all. A row longer than 80
columns is therefore still printed as one line.

What would settle it: a transcript (forum post, not a PDF) showing a wrapped Ports list with its indentation
intact, or a candidate running `terminal width 0` on a real switch, which is documented to stop the wrap and
would prove the break is width-driven rather than field-driven. Until then, wrapping would be a guess.
