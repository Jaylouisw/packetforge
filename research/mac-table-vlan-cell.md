# `show mac address-table`: is the Vlan cell a label in column 0, or a right-aligned field?

**Question (one, narrow).** In the `show mac address-table` table, where does the value in the first column sit:
left-aligned in column 0 (the way `All` appears in every web page that quotes the command), or right-aligned in
a fixed field whose right edge is the end of the heading's `----` rule?

**Verdict: a fixed four-character field, right-aligned** — `   1` for VLAN 1, `  87` for VLAN 87, `1005` for a
four-digit id, and ` All` for the reserved block's word. The console printed the value left-aligned
(`1       0200.0000.0100`), which is the shape a browser-wrapped paste shows and not the shape a terminal shows.
Changed here.

## Evidence

| Source | What it prints |
| --- | --- |
| [ntc-templates, `cisco_ios_show_mac-address-table4.raw`](https://github.com/networktocode/ntc-templates/blob/master/tests/cisco_ios/show_mac-address-table/cisco_ios_show_mac-address-table4.raw) | A machine-recorded Catalyst session, spaces intact: `Vlan    Mac Address       Type        Ports` / `----    -----------       --------    -----` then ` All    0100.0ccc.cccc    STATIC      CPU` and `   1    30a3.30a3.a1c3    DYNAMIC     Po1`. The reserved word carries **one** leading space; a one-digit id carries three; both end in column 3, and the MAC cell starts in column 8. |
| [ntc-templates, `...table13.raw`](https://github.com/networktocode/ntc-templates/blob/master/tests/cisco_ios/show_mac-address-table/cisco_ios_show_mac-address-table13.raw) | A second, independent capture, same table with ` All    0100.0ccc.cccc`, ` All    ffff.ffff.ffff`, `   1    28af.fd99.82c7`, ` 87    0019.ab11.1111` and ` 87    12db.dbdb.1919` — a two-digit id, right-aligned by one space. It also shows a two-digit id and a four-character port name, so the alignment is not an artefact of short values. |
| [ntc-templates, `...table2.raw`](https://github.com/networktocode/ntc-templates/blob/master/tests/cisco_ios/show_mac-address-table/cisco_ios_show_mac-address-table2.raw) | The older 6500 `show mac-address-table` shape, a `vlan` field six characters wide, right-aligned: `   666`, `    60`, `  2000`, `*  777`. Same rule, wider field. |
| [Cisco Networking Academy, *Lab — View Network Device MAC Addresses* (7.2.7, PDF)](https://contenthub.netacad.com/courses/itn-dl/_common/7.2.7-lab---view-network-device-mac-addresses.pdf) | The lab's ``S1# show mac address-table`` sample keeps the field: ` All    0100.0ccc.cccc    STATIC      CPU` and `   1    5c26.0a24.2a60    DYNAMIC     Fa0/6`. |
| [Cisco, *Checking Port Status and Connectivity*, Catalyst 9300 IOS XE 26.x](https://cisco.com/c/en/us/td/docs/switches/lan/catalyst9300/software/release/26-x/configuration_guide/int_hw/b_26x_int_and_hw_9300_cg/checking_port_status_and_connectivity.html); the same example on the [9400 17.10](http://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst9400/software/release/17-10/configuration_guide/int_hw/b_1710_int_and_hw_9400_cg/checking_port_status_and_connectivity.html) and [9200 17.18](http://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst9200/software/release/17-18/command_reference/b_1718_9200_cr/system_management_commands.html) pages | The **HTML** text of the same command collapses every run of spaces: `Vlan Mac Address Type Ports`, `All 0100.0ccc.cccc STATIC CPU`, `1 188b.45eb.cc01 DYNAMIC Gi1/0/1`. This is the rendering, not the device — the identical example's PDF reaches the extractor one word per line, and the two raw captures above show the spaces. |

## What is known

1. The first column is a **field**, not a label: the value's right edge is column 3, the last dash of the
   heading's `----`, whether the value is `All`, `1`, `87` or `1005`.
2. The MAC cell starts in column 8 on every row: four characters of field, four of gap. This matches the
   heading (`Vlan` + four spaces + `Mac Address`).
3. The published HTML pages cannot show this, because they collapse the leading space and the padding. A
   sample copied out of one reads `All` in column 0 and looks like a left-aligned label — which is what this
   console had copied.

## What changed

* `engine/cli.js`: a new `macVlanCell()` builds the cell — the value right-aligned in four characters, then
  padded to the console's eight-character Vlan column — and both row builders (the reserved `All … CPU` block
  and the learned rows) use it. The console's column is eight characters wide because it carries an `Age`
  column the vendor's table does not; the field grew **to the right**, so the value keeps the device's right
  edge (column 3) and the MAC cell keeps its column (8).
* `test/mac-table-vlan-cell.test.js` (new, 15 assertions): the reserved word starts with one space; a VLAN 1
  entry with three; a four-digit id fills the field; every row's MAC starts in column 8; `DYNAMIC` stays in
  column 28; the filtered (`interface <port>`) view aligns the same way; and no row begins with an unpadded id
  or with `All` in column 0.
* Two existing suites read a row by its first word (`/^All\s/`, `/^\d+\s/`); they now allow the leading
  spaces the device prints (`test/mac-table-surround.test.js`, `test/mac-table-reserved-rows.test.js`).
* `docs/CLI.md`: the three printed samples and a new bullet under "Reading `show mac address-table`";
  `research/mac-table-surround.md`'s "what PacketForge prints now" sample was also still in the old shape
  (colon-form MACs, left-aligned id) and was re-flowed.

## What remains unresolved

* **Whether the field is `%4s` or the word `All` is special-cased.** Every capture is consistent with one
  four-character field holding either a decimal id or the word; none shows a VLAN id of five digits (they stop
  at 4094) or another word in that cell, so the two rules cannot be told apart. Nothing here depends on the
  answer.
* **The Ports cell's trailing pad.** `...table13.raw` prints `Vl1 ` and `Vl87 ` with a trailing space while
  `CPU` and `Gi1/1/1` have none, which suggests the port name is printed in a fixed field that is then
  trimmed — or that the capture's own line ends were padded. One table cannot settle it, and this console
  prints no trailing spaces.
* **Whether a Catalyst 2960 (non -X) prints the same four-character field.** The two raw captures do not name
  their platform; both are IOS-shaped `show mac address-table` tables with the same heading, which is why the
  rule is stated as one rule for the family. A named-platform capture would close it.
