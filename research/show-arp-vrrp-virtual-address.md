# `show arp` and a first-hop group's virtual address

**Question (one, narrow).** On a Cisco IOS router that is the master of a VRRP group, does `show arp` carry
a row for the group's *virtual* IP address, what hardware address does that row show, and what sits in
`Age (min)`? The previous note on this table (`research/show-arp-local-address.md`) left this open: it prints a
hyphen row for every interface address and said nothing about a group's.

**Verdict: the address is in the table, with the group's virtual MAC, and the hyphen on the box that answers
for it.** A router that merely *heard* the address carries it too, but as a normal entry with a counted age.
So the row exists either way, and the age cell is the same ownership test the rest of the table uses: hyphen for
local, minutes for learned.

## Evidence

| Source | What it prints |
| --- | --- |
| [Cisco, "Understand the Hot Standby Router Protocol Features and Functionality", doc 9234](https://www.cisco.com/c/en/us/support/docs/ip/hot-standby-router-protocol-hsrp/9234-hsrpguidetoc.html) | The guide's own check of a group, `show ip arp vrf vrf1` on the active router: `Internet 10.2.0.1 - 00d0.bbd3.bc22 ARPA Ethernet0/2` and `Internet 10.2.0.20 - 0000.0c07.ac01 ARPA Ethernet0/2`. The second row is the group's virtual address: hyphen age, `0000.0c07.ac01` = HSRP group 1's virtual MAC. |
| [Cisco IOS XE IP Addressing Configuration Guide, ARP](https://www.cisco.com/c/en/us/td/docs/routers/ios/config/17-x/ip-addressing/b-ip-addressing/m_arp-config-arp-0.html) | A `show ip arp` sample: `Internet 171.69.233.21 8 0000.0c07.ac00 ARPA Ethernet0/0` - HSRP group 0's virtual MAC under a **counted** age of 8 minutes, i.e. a learned entry, not a local one. |
| [CCIE Pursuit, "Question Of The Day: 02 May, 2008"](https://cciepursuit.wordpress.com/2008/05/02/question-of-the-day-02-may-2008/) | `r1#show ip arp 10.1.123.100` -> `Internet 10.1.123.100 1 0000.5e00.0101 ARPA FastEthernet0/0`, identified in the answer as a **VRRP** group 1 virtual address: the `0000.5e00.01xx` MAC, counted age 1. |
| [Cisco IOS XE VRRS configuration guide](https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/ipapp_fhrp/configuration/xe-2/fhp-xe-2-book/fhp-vrrs.html) | The MAC-substitution plug-in's check: `show ip arp` lists `Internet 172.24.1.254 - 0000.5e00.0101 ARPA GigabitEthernet0/0/0.1`. Hyphen beside a VRRP MAC, on the interface whose ARP entry the plug-in overwrote. |
| [Cisco IOS XR ARP command reference](https://www.cisco.com/c/en/us/td/docs/iosxr/cisco8000/ip-addresses/b-ip-addresses-cr-8k/arp-commands.html) | The field definition this table already rests on: "A hyphen (-) means the address is local." |

## What is known

1. A first-hop virtual address is not invisible to the box that holds it: three independent samples show the
   virtual IP in `show ip arp`, on routers running HSRP and VRRP.
2. The hardware address beside it is the group's **virtual MAC** - `0000.0c07.acXX` for HSRP, `0000.5e00.01XX`
   for VRRP - not the interface's burned-in address. That is the same MAC the box answers ARP with, which is
   what makes the address reachable at all.
3. The age cell splits by role, not by protocol. The router whose ARP table the address is *served from* prints
   the hyphen (doc 9234, VRRS); a router that has only heard the binding prints a counted age (IP Addressing
   guide, CCIE Pursuit).

## What is inferred

* That the split is the local/learned distinction the field table already defines, applied to a virtual address:
  the master answers for it, so it is local; a neighbour that received the binding in a frame learned it, so it
  ages like any other entry and would go at `arp timeout` (4 h) of silence.
* That VRRP behaves as HSRP does here. Same table, same field list, same virtual-MAC mechanism, same
  master/backup role. Direct VRRP evidence covers only the *learned* side (CCIE Pursuit) and the
  substituted-MAC side (VRRS), not the plain master.

## What is unresolved

* **A VRRP master's own `show arp`, in a transcript.** No public sample found shows a VRRP master printing the
  hyphen row for its group address with no VRRS in the picture; the hyphen row is documented for HSRP and for
  VRRS-substituted interface addresses. This is the one step of the rule that rests on the sibling protocol.
* **When a backup's dynamic entry appears.** The CCIE Pursuit sample shows age 1 minute, consistent with learning
  the binding from the master's gratuitous ARP on becoming master - but nothing found says whether the backup
  installs it from that GARP, from an advertisement, or only after its own ARP request is answered.
* **An address owner (virtual IP = interface address).** Whether the single row then carries the interface's
  burned-in address or the virtual MAC. The only MAC-substitution mechanism Cisco documents is the VRRS plug-in,
  which is opt-in, so this model prints the port's own address; no sample settles it.

## What changed

* `engine/cli.js` - `show arp` prints one hyphen row per VRRP group address the elected master claims
  (`device.vrrpClaims`, which `macForIp()` already uses to answer ARP), with the group's virtual MAC and the port
  the group is on. Interface rows are printed first and a group address that is also an interface address is not
  repeated.
* `test/show-arp-vrrp-virtual-address.test.js` - 18 assertions: the row's six cells, the MAC a `macForIp()` answer
  uses, the interface row surviving beside it, address ordering, the backup printing nothing, the owner's single
  row, two groups on one port carrying their own MACs, and the row leaving when the group is removed.
* `docs/CLI.md` - one bullet under the `show arp` field list, naming the row, its source and what a backup prints.
