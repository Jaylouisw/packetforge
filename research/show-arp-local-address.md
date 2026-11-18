# `show arp`: the row for the box's own address

**Question (one, narrow).** Does a Cisco IOS-family device list an entry for an address configured on one of its
own interfaces in `show ip arp`, and what does that row say in the `Age (min)` column?

**Verdict: known, and adopted.** A box lists one row per interface that holds an IPv4 address - its own MAC in
`Hardware Addr`, the interface name in `Interface`, `ARPA` in `Type` - and the age column holds a **hyphen**,
because the address is local rather than learned. Cisco's own field list for the command states the rule, and a
router transcript and a switch transcript each show the row. PacketForge printed only what it had *heard*, so
the address configured on the box was missing from the box's own ARP cache: the row an operator looks for when
checking which address is on which port was simply not there.

## The device's own output

Router (Cisco TAC, ARP FAQ 117398) - the local address above the neighbour the article is discussing:

```
ASR1k#show arp
Protocol  Address          Age (min)  Hardware Addr   Type   Interface
Internet  10.2.2.1                −   30e4.dbb7.7e02  ARPA   GigabitEthernet0/0/2
Internet  10.2.2.2              253   0004.c01d.7c1a  ARPA   GigabitEthernet0/0/2
```

Switch (Cisco Learning Network, a 2960-CX serving DHCP) - the SVI address, hyphen, above the PC it serves:

```
SW_SDVoE#Show ip arp
Internet 192.168.2.1 - d42c.4461.e340 ARPA Vlan1
Internet 192.168.2.4 0 a0ce.c8fb.3249 ARPA Vlan1
```

A second Catalyst transcript (Cisco Learning Network, "Using the show ip arp command on a Layer 2 switch?") shows
the same shape with a different switch's addressing:

```
SW-B#show ip arp
Protocol Address    Age (min) Hardware Addr  Type Interface
Internet 192.168.1.101      -   00E0.B044.B69D ARPA Vlan1
Internet 192.168.1.102      0   0090.0C29.4720 ARPA Vlan1
Internet 192.168.1.103      0   0090.2BC9.313A ARPA Vlan1
```

The macro glyph in the first transcript is a `-`; the upper-case hex in the switch one is how that poster pasted
it, and this console prints hardware addresses the way the same vendor prints them elsewhere - lower-case dotted
quartets (`0000.0c59.f892` in Cisco's own samples).

## Evidence

| Source | Says |
| --- | --- |
| [Cisco TAC, *show ip arp* command reference](https://www.cisco.com/E-Learning/bulk/public/tac/cim/cib/using_cisco_ios_software/cmdrefs/show_ip_arp.htm) | The field table, verbatim: `Age (min)` - "Age, in minutes, of the cache entry; **a hyphen (-) means the address is local**". The rule this model now follows. |
| [Cisco TAC, *ARP FAQ: Why are some dynamic ARP entries still present in the ARP table after the respective ARP timeout has expired?* (doc 117398, PDF)](https://www.cisco.com/c/en/us/support/docs/ip/address-resolution-protocol-arp/117398-qanda-arp-timeout-00.pdf) | `show arp` on an ASR1001-X: `Internet 10.2.2.1 - 30e4.dbb7.7e02 ARPA GigabitEthernet0/0/2` beside the learned 10.2.2.2 at 253 minutes. The local address is on the interface the article's `show interfaces gi0/0/2` output names. |
| [Cisco Learning Network, 2960-CX as a local DHCP server](https://learningnetwork.cisco.com/s/question/0D56e0000EBtNkDCQV/having-trouble-configuring-cisco-2960cx-switch-as-local-lan-dhcp-server) | Switch transcript: `Internet 192.168.2.1 - d42c.4461.e340 ARPA Vlan1` above the PC's 192.168.2.4 entry. Confirms the row exists on a switch's SVI, not only on a router's routed port. |
| [Cisco Learning Network, "Using the show ip arp command on a Layer 2 switch?"](https://learningnetwork.cisco.com/s/question/0D53i00000Kt6ldCAB/using-the-show-ip-arp-command-on-a-layer-2-switch) | A second switch's table: `192.168.1.101 - ... ARPA Vlan1` above two learned entries at age 0. Same row, different platform generation. |
| [Cisco IOS XE 16.7 *IP Addressing: ARP Configuration Guide*](https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/ipaddr_arp/configuration/xe-16-7/arp-xe-16-7-book/arp-config-arp.html) | Its `show arp` sample prints rows whose age is `-` among aged neighbours, and the same field table (the "local" rule) appears under the unsupported-platform list. |
| [Cisco IOS XE 17.x *IP Addressing Configuration Guide*](https://www.cisco.com/c/en/us/td/docs/routers/ios/config/17-x/ip-addressing/b-ip-addressing/m_arp-config-arp-0.html) | Reproduces `show arp` output and points at the command reference for the fields; no change to the rule fifteen years on. |
| [Orion Networks IP Service Command Guide, ARP commands (third-party, corroborating)](https://data.nag.wiki/Orion%20Networks/Manuals/Orion%20Beta%20B26Q/Command%20Guide/05-IP%20Service%20Commands/01-ARP%20Commands.pdf) | For a local IP address a hyphen is displayed; the same convention on a different IOS-like CLI - useful only as corroboration, not as the source of the rule. |

## What is known, inferred, unresolved

**Known.** The hyphen in `Age (min)` marks a local address, per the vendor's field table; a box prints a row for
an address held by one of its own interfaces; that row carries the interface's MAC and name; it is not a
neighbour and is not aged like one. Seen on a router's routed port and on a switch's SVI.

**Inferred.** That the row is created when the address is configured and exists before any traffic: the
transcripts show boxes that have been passing traffic, so "no traffic yet" is inference. The engine prints it
from configuration alone, which is the reading the field description supports ("an entry for a local IP address
that has been derived from an interface", IOS XE ARP guide).

**Unresolved.**

* **A local row on an interface that is administratively down, or with no cable.** No transcript found shows
  `show arp` while the addressed port is shut. This console prints the row regardless, because the address is
  still configured, and marks nothing about the link in that row - the row is not the place the link state is
  reported (`show interfaces` is).
* **Static and alias entries.** The same hyphen is documented for static/alias entries by the third-party Orion
  guide; this model has no `arp <ip> <mac>` command, so nothing here depends on it.
* **Secondary addresses and VRRP virtual addresses.** Multiple addresses per interface are not modelled, and a
  VRRP virtual address is not an address on the interface; whether a real box lists the virtual address as local
  is not settled by anything in hand, so no row is printed for it.
* **Hosts.** An end station's cache holds its neighbours, not itself, so `isHost()` devices print no local row.
  That is a claim about hosts in general, not a transcript; the model's IOS-style console on a PC is already an
  approximation.

## What changed

* `engine/cli.js` - the `show arp` renderer adds one row per interface with an IPv4 address and a MAC, age `-`,
  Hardware Addr the interface's own MAC (dotted), Interface its name; skipped on `isHost()` devices and when a
  learned entry already holds that address. Rows still sort together by address.
* `test/show-arp-local-address.test.js` - 20 checks: the row's six columns, the hyphen age, the port's MAC and
  name, presence before any traffic, a learned neighbour still printed beside it, numeric ordering, no row on an
  end host, a subinterface's own row borrowing the parent MAC, and a box with no address printing none.
* `test/show-arp.test.js` - the two assertions that counted rows and indexed the neighbour by position now count
  the local row and pick the neighbour out by address.
* `docs/CLI.md` - the `show arp` table row, the sample (a local row added), and a bullet stating what the hyphen
  means and which devices get the row.
