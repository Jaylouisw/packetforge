# The Interface column of `show ip interface brief`: the short name or the long one?

**Question (one, narrow).** A row of `show ip interface brief` starts with the interface name. Does a real
IOS-like box print the catalogue's short spelling (`Gi1/0/1`) or the spelled-out type
(`GigabitEthernet1/0/1`) — and what did this console print?

**Verdict: known, and adopted.** Every published capture of the command prints the type in full. This
console printed the short spelling *under the vendor's own header*, whose 23-column Interface field is
sized for the long word — so rows read `Gi1/0/1` where the heading above them was drawn for
`GigabitEthernet1/0/1`. The stored name is unchanged (it is the panel's spelling, and every lookup key),
and so is the `show interfaces` block header: that block is this console's own shape, a tested rule says
it prints the panel name (`test/iface-type-spelling.test.js`), and it is not a vendor table whose cells can
be measured. The brief table is.

## What the vendor prints

| Source | Shows |
| --- | --- |
| [IOS XE 17.18.x Catalyst 9200 command reference, Interface and Hardware Commands](http://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst9200/software/release/17-18/command_reference/b_1718_9200_cr/interface_and_hardware_commands.html) | `Device# show ip interface brief` → `Vlan1 unassigned YES NVRAM administratively down down` / `GigabitEthernet0/0 unassigned YES NVRAM down down` / `GigabitEthernet1/0/1 unassigned YES NVRAM down down` … one row per port, every name spelled out |
| [Cisco IOS Interface and Hardware Component Command Reference, `show ip interface`](https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/interface/command/ir-cr-book/ir-s5.html) | `GigabitEthernet0/0/0 unassigned YES NVRAM down down`, `Serial1/0/0 unassigned YES unset down down`, `GigabitEthernet0 unassigned YES NVRAM up up`; the field list describes the column as the interface name |
| [Catalyst 2960 lab capture, IOS 15.0(2) SE](https://www.studocu.com/en-au/document/university-of-technology-sydney/networking-essentials/building-a-simple-network-cisco-lab/8616584) | A real 2960's own table: `Vlan1 unassigned YES unset up up`, `FastEthernet0/1 …`, `GigabitEthernet0/1 …`, `GigabitEthernet0/2 …` — the copper ports and the two uplinks, all long |
| [Cisco 8100 Series configuration guide, IOS XE 17.18.1](https://cisco.com/c/en/us/td/docs/routers/secure-routers/sec-8100-series/software/config-guide/cisco-8100-series-secure-routers-software-configuration-guide/m-interface-configuration.html) | Same table with `Cellular0/2/0`, `Loopback100`, `Port-channel2`, `Vlan1 10.10.10.1 YES NVRAM up up` — the long form for every type family, not only Ethernet |
| [Cisco 4000 Series ISR guide, IOS XE 16.11.x](http://www.cisco.com/c/en/us/td/docs/routers/access/4400/software/configuration/xe-16-11/isr4400swcfg-xe-16-11-book/m_initconfig.html) | `GigabitEthernet0/0/0 unassigned YES NVRAM administratively down down` — the administratively-down case, same spelling |

The counter-example that keeps the rule honest: [the Catalyst 3560 command
reference](http://www.cisco.com/en/US/docs/switches/lan/catalyst3560/software/release/15.0_2_se/command/reference/cli3.html)
shows `show interface gigabitethernet0/1 switchport` answering `Name: Gi0/1`. A box *does* print the short
word — as the value of a `Name:` field inside a block, not as the subject of a table row. That split is
already the one `research/port-channel-in-interface-brief.md` measured for bundles: the brief table says
`Port-channel1`, the summary says `Po1`.

## What this console did

Measured on `06da3f7d`, `generic-switch` and `C2960X-24TS-L`:

```
Interface              IP-Address      OK? Method Status                Protocol
Gi1/0/1                unassigned      YES unset  down                  down
```

The header is the vendor's, character for character — `test/interface-brief-columns.test.js` pins it
against Cisco's sample. Its Interface field is 23 columns, which is exactly the room a 23-character
`TenGigabitEthernet1/1/1` needs and more than `GigabitEthernet0/0` (18) or `FastEthernet0/1` (16) needs:
the table was drawn for the long word and filled with the short one. The same row showed up in
`show interfaces` as `Gi1/0/1 (ethernet, 1G), MAC …`, so one port was named two ways by two views of the
same device, and `docs/CLI.md` printed both examples.

## What changed

* `engine/iface-name.js`: `displayName(name)` expands a leading type word from a table of the IOS-style
  abbreviations (`gi`, `ge`, `fa`, `te`, `twe`, `fo`, `hu`, `se`, `vl`, `lo`, `po`) onto the vendor's long
  word, and returns every other name untouched. It never renames a port: the catalogue key, the lookup
  table and `show running-config` are unchanged.
* `engine/cli.js`: the `show ip interface brief` row prints `displayName(i.name)`. The `show interfaces`
  block header was measured too and deliberately left on the panel spelling: the block is not the vendor's
  output (its `status:`/`peer:`/`ip:` lines are this console's own), and a tested rule owns the spelling
  there. The vendor's own block would say `GigabitEthernet0/0 is up, line protocol is up`; this console
  does not print that block at all.
* `test/interface-brief-name-spelling.test.js` (26 checks): a 2960-X row character for character
  (`GigabitEthernet1/0/1`, cage 25, no `Gi` row at all), the stored name still short and both spellings
  still accepted on input, a subinterface (`GigabitEthernet0/0.20`), a 10G cage
  (`TenGigabitEthernet1/0/1`), the pass-through cases (`eth1`, `Eth1/1`, `Ethernet1`, `xe-0/0/0`,
  `Port 1`, `sfp+1`, `1/1/1`, `mgmt0`), the block header staying on the panel name, and the expansion
  table itself.
* Twelve existing suites found their rows by the short name; they now find them by the name the table
  prints, and `docs/CLI.md`'s two worked examples show the long spelling.

## What is inferred rather than read

* **The 23-column field was drawn for the long spelling.** That is arithmetic, not a vendor sentence:
  `GigabitEthernet0/0` is 18 characters and `TenGigabitEthernet1/1/1` exactly 23, while no short spelling
  comes near the width. It is strong evidence that the header came from a sample with long rows, which is
  what the samples above are.
* **Which abbreviations expand.** `gi`/`fa`/`te`/`twe`/`fo`/`hu`/`se`/`vl`/`lo`/`po` are the type words
  `engine/iface-name.js` already treats as aliases of one type, and the long form is the word IOS prints.
  `ge` is expanded because VRP's own `display ip interface brief` prints `GigabitEthernet0/0/1`.
  `eth`/`et` are deliberately **not** expanded: RouterOS prints `ether1`, Edgecore prints `Eth1/1`, and
  those boxes' console spellings are what this console must keep. `ma` is not expanded either (Nexus
  prints `Mgmt0`, Arista `Management1`).
* **The block header.** IOS heads a block with `GigabitEthernet0/0 is up, line protocol is up`; this
  console's block is its own shape (`Gi0/0 (ethernet, 1G), MAC …`) and keeps the panel name. Two views of
  one port therefore spell it two ways - as they already did for a bundle (`Port-channel1` in the brief
  table, `Po1` in the summary) - because one view is the vendor's table and the other is not.

## What is unresolved

* **A name wider than the field.** `FortyGigabitEthernet1/0/1` is 26 characters and
  `HundredGigabitEthernet1/0/1` is 27, past the 23-column field. `briefLine()` pushes the rest of the row
  right rather than truncating, which is what a table does with a name it will not shorten — but no
  capture of a 40G/100G port in this command was found, so whether IOS shifts, widens or truncates is
  unmeasured.
* **The rest of the console.** `show vlan`'s Ports list, `show etherchannel summary`, `show power inline`
  and the MAC table's `Ports` column print `Fa0/1`/`Gi1/0/1`, and the vendor's own samples of those
  commands do the same. The short names that remain are the ones a box abbreviates, not an oversight —
  but no single rule was derived here for which command abbreviates; each was read off its own samples.
* **A non-IOS equivalent.** Aruba CX's `show ip interface brief` prints bare `1/1/1`, and no `display`
  capture was collected for every vendor in the catalogue. The expansion table therefore only claims the
  spellings it lists, and passes everything else through untouched.

## What evidence would settle the rest

1. One `show ip interface brief` capture from a box with a 40G or 100G port, to see the row past column 23.
2. The same table from an Aruba CX and a Juniper box, to decide whether a bare `1/1/1` or `xe-0/0/0` row
   should be left alone (it is, today) or rewritten.
3. An IOS capture of `show interfaces` on a subinterface, to confirm the parent-and-child spelling in a
   block headed `GigabitEthernet0/0.10 is up` - which this console would have to adopt wholesale, not by
   renaming one line, if it ever prints the vendor's block.
