# `show arp`: the Type column, and what may honestly fill it

**Question (one, narrow).** The ARP table has six columns in the vendor's own field list — Protocol, Address,
Age (min), **Hardware Addr**, **Type**, Interface. This console printed five: the Type column was simply absent.
What is the column, where exactly does it sit, what values can it hold, and which of those values can this model
print without inventing a behaviour?

**Verdict: known and adopted.** Type sits between the hardware address and the interface, and its vendor field
list gives three values — `ARPA` (Ethernet), `SNAP` (RFC 1042), `SAP` (IEEE 802.3). Every binding this engine can
learn is IPv4 over 802.3 Ethernet, so `ARPA` is the only value it may print; the column is now printed, constant,
in the vendor's position.

## The evidence

The Cisco TAC command reference for `show ip arp` (`show arp` is the alias) prints the sample and then the field
table, verbatim:

```
Router# show ip arp
Protocol  Address       Age(min) Hardware Addr  Type Interface
Internet  171.69.233.22 9        0000.0c59.f892 ARPA Ethernet0/0
Internet  171.69.233.21 8        0000.0c07.ac00 ARPA Ethernet0/0
```

| Field | Value | Description |
|---|---|---|
| Age (min) | 9 | Age, in minutes, of the cache entry; a hyphen (-) means the address is local |
| Hardware Addr | 0000.0c59.f892 | Data-link address |
| Type | ARPA | Type of encapsulation: ARPA — Ethernet; SNAP — RFC 1042; SAP — IEEE 802.3 |
| Interface | Ethernet0/0 | Interface to which this address mapping has been assigned |

* https://www.cisco.com/E-Learning/bulk/public/tac/cim/cib/using_cisco_ios_software/cmdrefs/show_ip_arp.htm

Two independent configuration guides print the same six-column header on current hardware, and both use `ARPA`:

* ARP Configuration Guide, IOS XE 3SE (Catalyst 3850): `Device# show arp` →
  `Protocol  Address  Age (min)  Hardware Addr  Type  Interface` /
  `Internet  10.1.1.1  43  001b.53e1.7201  ARPA  GigabitEthernet0/0/6`
  https://www.cisco.com/en/US/docs/ios-xml/ios/ipaddr_arp/configuration/xe-3se/3850/arp-config-arp.pdf
* The same page in the 15-S form: https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/ipaddr_arp/configuration/15-s/arp-15-s-book/arp-config-arp.pdf
* IOS XE 16.7: https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/ipaddr_arp/configuration/xe-16-7/arp-xe-16-7-book/arp-config-arp.html

The 16.x configuration guide's sample is the one that shows all three values at once — `AppleTalk 4028.5 … SNAP
Ethernet2` beside `Internet 10.108.42.112 … ARPA Ethernet3` — which is what rules out "Type is always ARPA on any
platform" and makes the column meaningful: it says *how* this binding is encapsulated, not merely that one exists.

A support-document transcript confirms the column and one more value this model does not have: a binding that was
asked for and never answered is printed as `Internet 172.16.100.5 0 Incomplete ARPA` — the hardware address is the
word `Incomplete`, the age is 0.

* https://www.cisco.com/c/en/us/support/docs/ios-nx-os-software/ios-software-releases-121-mainline/12778-ping-traceroute.html

## Why `ARPA` is the only value this console may print

`SNAP` and `SAP` are 802.3/RFC 1042 encapsulations used on media where the MAC header does not carry a plain
EtherType — Token Ring and FDDI in the transcripts above. The catalogue has no Token Ring or FDDI port, and every
ARP binding this engine learns is IPv4 over 802.3 framing, including on the fibre and coax media. Printing `SNAP`
anywhere would be an invention; printing `ARPA` is a statement about the medium the frame actually crossed.

## What changed

`show arp` prints `Type` between `Hardware Addr` and `Interface`, `ARPA` on every row, padded from the same widths
as the header so the word lands under its own heading. Regression: `test/show-arp.test.js` (the header names the
column in position, the row reads `ARPA`, and the two align column-for-column), with the column indices in
`test/arp-ageing.test.js` moved to the six-column layout. `docs/CLI.md` and `docs/ARCHITECTURE.md` samples updated
to the printed width.

## Unresolved

* **Incomplete entries are not modelled.** The engine learns a binding only from a reply, so the
  `0  Incomplete  ARPA` row the support document shows for an unanswered ARP has no counterpart here. Adding it
  would mean keeping a negative entry with a lifetime, which the data path does not currently do — a behaviour
  change, not a formatting one, so it was left alone.
* **PROBE entries** (the short-lived row a box writes while it is resolving, before the reply) are likewise absent,
  and the two transcripts found do not state their exact printing on IOS 15/16, only on older releases.
* Whether `SAP` still appears anywhere outside Token Ring hardware was not established; no transcript with a `SAP`
  row was found, only the field-list description. Nothing here depends on the answer, because the model cannot
  produce one either way.
