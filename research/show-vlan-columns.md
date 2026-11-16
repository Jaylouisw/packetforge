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

## Wrapping the Ports list (the question this note left open)

The first pass on this table stopped short of wrapping the Ports list: the vendor pages it read had their
leading whitespace collapsed by extraction, so the continuation *indent* was not observable, and a wrap built
on a guessed indent would have been a guess. It was recorded as the open question, with what would settle it.

**Verdict: settled, and adopted.** The list breaks at 80 columns, the continuation starts back under the
`Ports` heading at column 48, and the break carries no comma. One arithmetic rule reproduces every sample:

* the Ports cell has 80 - 48 = **32 columns** of room;
* entries are joined by `", "`;
* an entry that would take the cell past 32 columns starts a new line, indented 48 spaces, at the same entry.

### The samples, and what each one settles

| Source | Shows | What it settles |
| --- | --- | --- |
| [Cisco Catalyst 2960-X 15.2(6)E command reference, `show vlan`](https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst2960x/software/15_2_6_e/command_reference/b_1526_2960x_cr/vlan_commands.html) | 48 `Gi1/0/x` ports, **three to a line**, 16 continuation lines | The break is width-driven, not a port count: the same 32 columns hold three 8-character names and would hold four 5-character ones |
| [Cisco 2950 reset procedure, `show vlan`](https://www.cisco.com/c/en/us/support/docs/lan-switching/vlan/217969-reset-catalyst-switches-to-factory-defau.html) | 24 `Fa0/x` ports, **four to a line**; `VLAN Type SAID MTU ...` block below | Four-per-line for the short name, and that the break sits *inside* the Ports cell - the rows that follow keep their own columns |
| [Cisco lab 5.5.1 (PDF), `show vlan`](https://is.muni.cz/el/1433/jaro2014/PV234/cviceni/ESwitching/ESwitching_Lab_5_5_1.pdf) | The same table with its **indentation intact**: continuation lines begin at column 48, under `Ports`, and a `Gig0/1, Gig0/2` tail starts its own line because the previous one was full | The indent the first pass could not see. Also that a differently-named pair continues the same cell rather than starting a new column |
| [howtonetwork, `show vlan` on a 3550](https://www.howtonetwork.com/certifications/cisco-2/show-vlan/) | VLAN 1 `Fa0/11..Fa0/14` then `Fa0/20..Fa0/23` then `Fa0/24`; VLAN 150 `Fa0/2..Fa0/5`, `Fa0/6..Fa0/9`, `Fa0/10` | The same rule on a different id/name width, and that the last line may hold a single entry |

Worked check, 2960-X: `Gi1/0/2, Gi1/0/3, Gi1/0/4` is 28 characters, and `Gi1/0/5` would make it 38 - so the
sample's groups of three are exactly what a 32-column window produces. Worked check, 2950: `Fa0/1, Fa0/2,
Fa0/3, Fa0/4` is 26, and a fifth port would make 33 - so the sample's groups of four are the same window.

### What changed

`vlanRows()` in `engine/cli.js` prints a row as its head plus one or more Ports lines;
`VLAN_TERMINAL_COLS` (80), `VLAN_PORTS_INDENT` (computed from the three column widths, 48) and
`VLAN_PORTS_WIDTH` (32) are the rule. `test/show-vlan-ports-wrap.test.js` (13 checks) pins the 2950 row
character for character, the 2960-X rhythm at three per line, the column-48 indent, the 80-column ceiling, the
absence of a comma at the break, the whole list across the break, and a one-port VLAN staying on one line.
The two existing `show vlan` readers now fold continuation lines back into their row, because a row is one or
more printed lines.

### What remains open

* **Other tables.** `show interfaces` here is a key/value block on purpose, and `show access-lists` prints one
  rule per line, so neither wraps today; the question has not been asked of them.
* **Narrower terminals.** A box wraps at whatever width the terminal reports (`terminal width`, 0 = no wrap).
  This console has no width model and fixes 80, the default; a lab that sets another width would still see 80.
  What would settle a per-session width: a documented default per platform, or a decision to add
  `terminal width` - the latter is a feature, not a fidelity fix.
