# `show ip interface brief`: what the IP-Address cell holds

**Question (one, narrow).** On a real IOS/IOS-XE device, does the IP-Address column of
`show ip interface brief` carry the subnet mask or prefix length (`10.0.0.1/24`), or the bare address
(`10.0.0.1`)? And if the mask is not there, which view does print it?

**Verdict: the bare address.** Every vendor sample and transcript found prints a dotted quad with no
prefix, and the vendor's field list defines the column as the address alone. The engine printed
`10.0.0.1/24`, a string the hardware cannot produce. Changed here.

## Evidence

| Source | What it prints |
| --- | --- |
| [Cisco IOS Interface and Hardware Component Command Reference, `show ip interface brief`](https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/interface/command/ir-cr-book/ir-s5.html) | `Ethernet0 10.108.00.5 YES NVRAM up up`; field list: `IP-Address` = "IP address assigned to the interface" - no mask field |
| [Catalyst 2960 Command Reference 12.2(50)SE, interface summary](https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst2960/software/release/12-2_50_se/command/reference/cr/cli2.html) | `Vlan1 172.20.135.202 YES NVRAM up up` - a switch, with the SVI holding the address |
| [Catalyst 2960 Command Reference 15.0(2)SE (PDF)](https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst2960/software/release/15-0_2_se/command/reference/cr2960.pdf) | same table, same bare address, `GigabitEthernet6/0/1 unassigned YES unset up up` |
| [Cisco CPT Command Reference 9.3 (PDF)](https://www.cisco.com/c/en/us/td/docs/optical/cpt/r9_3/command/reference/cpt93_cr/cpt93_cr_chapter_01110.pdf) | `GigabitEthernet0/2 192.168.190.235 YES unset up up` |
| [Cisco 4000 Series ISR Software Configuration Guide, interface summary (PDF)](https://www.cisco.com/c/en/us/td/docs/routers/access/4400/software/configuration/guide/isr4400swcfg/bm_isr_4400_sw_config_guide_chapter_0111.pdf) | `GigabitEthernet0/0/0 10.0.0.1 YES manual down down` |
| [networklessons.com, "Static IP vs Dynamic IP"](https://networklessons.com/cisco/ccna-200-301/static-ip-vs-dynamic-ip) (practitioner transcript) | `Ethernet0/1 192.168.12.2 YES DHCP up up` after a DHCP lease - bare, and the Method column is `DHCP` |

## What is known

1. The cell is a bare dotted quad, or the word `unassigned`. No sample anywhere prints `/24` there,
   on routers (`NVRAM`/`manual`) or on switches (SVI), static or DHCP.
2. The mask is not hidden, it is reported in other views: `show interfaces` prints
   `Internet address is 10.0.0.1/24` and `show running-config` prints
   `ip address 10.0.0.1 255.255.255.0`. `show ip interface` prints
   `Internet address is 10.10.46.10, subnet mask is 255.0.0.0`.
3. The Method column is where this table keeps its provenance, not the address cell: `manual` for an
   address typed in this session, `NVRAM` for one read back from the saved configuration, `DHCP` for a
   client, `unset` when there is no address at all.
4. Not every vendor's brief view agrees. Arista EOS `show ip interface brief` prints
   `Ethernet1 10.0.0.1/24 up up 1500` - CIDR, in a five-column table with no `OK?`/`Method` columns.
   So "brief view" is not one format; the table's *own* vendor decides the cell.

## What is inferred

PacketForge prints IOS's table - IOS's header (`Interface  IP-Address  OK? Method  Status  Protocol`),
IOS's Method vocabulary, IOS's Status/Protocol words. A table that is IOS's in five of six columns has to
be IOS's in the sixth: `10.0.0.1/24` was a cell no device with that header would print, and it is the
cell an operator diffs first when they compare a lab against a switch.

## What changed

`engine/cli.js` prints the port's address and nothing else; `10.0.0.1/24` became `10.0.0.1`. Nothing else in
the row moved: the cell is still padded to IOS's 16-character `IP-Address` column, the Method column still
follows IOS's vocabulary, and the address cell of a DHCP client with no lease is still `unassigned` beside
`DHCP`. `test/interface-brief-address-cell.test.js` (12 checks) pins the cell against the samples above - a
static address, a `/30` address, an address that arrived from a lease, and an empty port - and checks the two
views that do print the mask, so the information moved nowhere. `test/brief-method-unset.test.js` previously
asserted the `/24`; it now asserts the bare address. `docs/CLI.md` ("Reading `show ip interface brief`") states
the rule and cites the samples.

## What remains unresolved

* **`NVRAM` vs `manual`.** A real box says `NVRAM` for an address restored from the saved configuration and
  `manual` for one configured in the running session. This model keeps one configuration and has no
  saved/unsaved distinction to report, so it prints `manual` in both cases. Making that honest would mean
  modelling "configured but not saved", which is a bigger question than this one.
* **The `OK?` = `NO` case.** Cisco's samples show `NO` for an interface whose address configuration is invalid
  (the 4000-series guide's `SSLVPN-VIF0 unassigned NO unset up up`). This model refuses an invalid address at
  the command instead, so it never has an invalid one to report - no sample and no engine path disagree here,
  but nothing tests it either.
* **The Interface column's width.** Published samples do not agree on it: the router samples pad to 23
  (`Interface              IP-Address`), the 2960 command-reference PDF pads to 27
  (`Vlan1                      172.20.135.202  YES NVRAM`). The longest name in the 2960 sample is
  `GigabitEthernet6/0/1` (20 characters), the same length as the router samples' `GigabitEthernet0/0/3`, so
  "longest name plus a fixed gap" does not explain both - which leaves either a per-platform width or a
  PDF-rendering artefact, and one sample cannot settle it. This console fixes the column at 23 (IOS's router
  header, asserted by #1521's test), and `briefLine()` pushes the rest of a row right when a name is longer
  than its column. One catalogue model has a name longer than 23 characters -
  `Ten-GigabitEthernet1/0/25` on the H3C S5560X-30C-EI, 25 - and on it `unassigned` lands in column 26 while
  `IP-Address` sits in column 23. What would settle the width: a captured `show ip interface brief` from a box
  whose longest name is longer than 23 (a Catalyst with `TenGigabitEthernet1/1/1`, or a Comware switch),
  compared column by column with its own header.
