# `show arp`: does the Interface column abbreviate the port, or spell it out?

**Question (one, narrow).** The Interface column of `show arp` / `show ip arp` names the port a binding was
learned on. On a real IOS-family box, is that cell the interface's whole name (`GigabitEthernet0/0/6`) or the
abbreviation the same box uses in tables that abbreviate (`Gi0/0/6`)? The console printed the stored (panel)
spelling, `Gi0/0`, while the same column in `show ip interface brief` spelled the name out - one box, two
spellings of one interface in two tables, and only one of them could be right.

**Verdict: the whole name.** Every primary capture read prints the type out - `Ethernet0/0`,
`GigabitEthernet0/0/6`, `GigabitEthernet0/0/2`, `FastEthernet0/3/0/6`, and `Vlan1` on switches, where the
abbreviation would be `Vl1`. Nothing on cisco.com abbreviates in this table. Changed here.

## Evidence

| Source | What the Interface cell holds |
| --- | --- |
| [Cisco TAC command reference, `show ip arp`](https://www.cisco.com/E-Learning/bulk/public/tac/cim/cib/using_cisco_ios_software/cmdrefs/show_ip_arp.htm) | `Internet  171.69.233.22  9  0000.0c59.f892  ARPA  Ethernet0/0`, and the field table defines the column as "Interface to which this address mapping has been assigned" |
| [Cisco IOS XE 16.7, *Address Resolution Protocol* configuration guide](https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/ipaddr_arp/configuration/xe-16-7/arp-xe-16-7-book/arp-config-arp.html) | `Device# show arp` → `Internet  10.1.1.1  43  001b.53e1.7201  ARPA  GigabitEthernet0/0/6` - the sample this file's Type column already cites |
| [Cisco TAC, ARP FAQ 117398 (PDF)](https://www.cisco.com/c/en/us/support/docs/ip/address-resolution-protocol-arp/117398-qanda-arp-timeout-00.pdf) | ASR1001-X: `Internet  10.2.2.1  -  30e4.dbb7.7e02  ARPA  GigabitEthernet0/0/2` above the aged neighbour on the same port - the ASR capture `research/show-arp-local-address.md` quotes |
| [Cisco, *Observing ARP with the Windows CLI, IOS CLI and Wireshark* (CCNA 5.2.1.8 lab, real gear)](https://cisco.tu-sofia.bg/wp-content/uploads/courses/CCNA1/course/files/5.2.1.8%20Lab%20-%20Observing%20ARP%20with%20the%20Windows%20CLI,%20IOS%20CLI,%20and%20Wireshark.pdf) | Router R1: `show arp` and `show ip arp` both print `ARPA  GigabitEthernet0/1`. Switch S1: `ARPA  Vlan1` |
| [Cisco, ARP FAQ 117398's sibling capture in `research/show-arp-local-address.md`](https://www.cisco.com/c/en/us/support/docs/ip/address-resolution-protocol-arp/117398-qanda-arp-timeout-00.pdf) | the 2960-CX transcript cited there prints `ARPA  Vlan1` |
| [Cisco CRS *IP Addresses and Services Command Reference*, ARP commands](https://www.cisco.com/c/en/us/td/docs/routers/crs/software/ip-addresses/command/reference/b-ip-addresses-cr-crs/b-ipaddr-cr-crs_chapter_010.html) | `show arp` → `FastEthernet0/3/0/6`, `MgmtEth0/2/CPU0/0` - a different table order (IOS-XR) but the same whole-name cell |
| [Cisco HSRP configuration guide 9234](https://www.cisco.com/c/en/us/support/docs/ip/hot-standby-router-protocol-hsrp/9234-hsrp.html) | `Internet 10.2.0.20 - 0000.0c07.ac01 ARPA Ethernet0/2` - the first-hop row, whole name |
| [Network Perception knowledge base, auxiliary data](https://www.network-perception.com/kb/additional-data) | One page, two tables: `show ip arp` → `ARPA GigabitEthernet0/1`; `show mac address-table` on the same page → `Gi0/1`. The abbreviation belongs to the MAC table in the vendor-collector's own samples |
| [thenetworkdna, "Top 15 network troubleshooting commands"](https://www.thenetworkdna.com/2026/03/top-15-network-troubleshooting-commands.html) (blog, hand-written sample) | `Internet 192.168.1.1 - aabb.cc00.0100 ARPA Gi0/0` - **the one contradicting sample found**; its rows are illustrative, not a device transcript |

## What is known

1. Six primary sources, spanning IOS 12.x through IOS XE 16.x and IOS-XR, print the whole interface name in
   this column. Not one prints a type abbreviation, and the `Vlan1` cells rule out a "column too narrow" rule:
   `Vlan1` is already shorter than its abbreviation would be.
2. `Interface` is the **last** column of the table, and no capture wraps it, so a long name
   (`GigabitEthernet0/0/0.100`, `TwentyFiveGigE1/0/1`) is printed whole rather than truncated. The table is
   the only IOS table with the interface in the tail position.
3. The abbreviation a box *does* use lives in other views: `show mac address-table` (`Gi0/1` in the same
   knowledge-base page that spells the ARP row out), `show vlan`, `show etherchannel summary`,
   `show interfaces status`. This repo already draws that line in `docs/CLI.md` - the ARP table was simply on
   the wrong side of it.
4. The one contradicting sample is a blog's illustrative output, and its authors also print `Age (min)` as
   `Age(min)` in another sample on the same page - i.e. it is retyped, not captured.

## What is inferred

* The console's cell came from `Device.arpRows()`, which reports `iface.name` - the **stored** name, which is
  the faceplate spelling (`Gi0/0`) because that is what `interface` resolves - and the printer wrote it out
  unexpanded. Nothing chose the abbreviation; it was the absence of the expansion step that
  `show ip interface brief` already had (`ifaceName.displayName()`).
* Because the stored name is untouched and only the printed cell is expanded, a name typed from a row
  (`interface GigabitEthernet0/0`) still resolves: `resolvePortName()` folds the long spelling onto the short
  one, which is the same round trip `show ip interface brief` relies on.

## What changed

* `engine/cli.js`, `show arp` branch: the Interface cell, the device's own local rows, and the VRRP-claimed
  rows print `ifaceName.displayName(name)`. The conflict paragraph that follows the table names the port the
  same way, so one output cannot spell one interface two ways. `displayName` moved into the small `ifaceName`
  alias beside `resolvePortName` (the `show ip interface brief` cell now calls the same function).
* Tests: `test/show-arp.test.js` (36 checks), `test/show-arp-local-address.test.js` (21),
  `test/show-arp-vrrp-virtual-address.test.js` (18), `test/arp-ageing.test.js` (31),
  `test/arp-conflict.test.js` (26). Each suite's Interface assertions now compare against
  `displayName(recorded)` rather than the stored name - they still prove the cell is the port the engine
  actually learned the binding on - and three new checks pin the literal spelling
  (`GigabitEthernet0` on the generic router, `GigabitEthernet0.10` for a subinterface,
  `GigabitEthernet9/9` for a stored name that no longer resolves).
* `docs/CLI.md` ("Reading `show arp`"): the sample rows and the VRRP bullet print whole names, and the
  Interface bullet states the rule with the captures above. The interface-naming paragraph now lists
  `show arp` among the views that spell the name out.

## What remains unresolved

* **Whether any platform abbreviates.** No cisco.com capture does, but the search was not exhaustive for
  IOS-XR 7.x or NX-OS (which uses a five-column table, `Address Age MAC Address Interface`, and would need its
  own rule anyway). A capture of `show arp` on an NX-OS box would say whether this table's shape is
  IOS-only - it already is, since the six-column header is IOS's.
* **How a name wider than the terminal is handled.** No sample in hand has a name longer than the 80-column
  default, so whether a box wraps the tail column or lets it run is not witnessed; this console lets it run.
* **`Age (min)` vs `Age(min)`.** The blog sample above prints the header without the space, which the TAC
  command reference contradicts; the space is already pinned here (`test/arp-ageing.test.js`) and was not
  re-opened.
