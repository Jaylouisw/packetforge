# A second `vrrp N ip` line: another address, or the same primary typed again?

**Question (one, narrow).** A VRRP group holds an address, `vrrp 10 ip 10.0.0.100`. An operator types
a second line, `vrrp 10 ip 10.0.0.101`, with no `secondary` keyword. Does the box **replace** the
primary, **refuse** the line, or **add** a second virtual address? Every other door in this console
distinguishes those three answers, and this one answers "add" without ever having been asked.

**Verdict: the vendor separates primary from secondary with a keyword, and a second bare line is not
the documented way to add one - but no capture in hand says what the box does with it, so nothing was
coded.** What *is* documented: the first address is the primary, additional addresses are typed with
`secondary`, and at least one Cisco OS refuses a secondary before a primary exists. What is **not**
documented anywhere found: the storage or the receipt for a second bare line. Two candidate rules
(replace the primary; refuse the line) remain unattested, and the third (silently append) is the one
the vendor's own grammar argues against.

## The evidence

| # | Source | Says |
|---|--------|------|
| 1 | [Cisco IOS First Hop Redundancy Protocols Command Reference, `vrrp ip`](https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/ipapp_fhrp/command/fhp-cr-book/fhp-v1.html) | Syntax: `vrrp group ip ip-address [secondary]` / `no vrrp group ip ip-address [secondary]`. "The first IP address specified in the VRRP configuration is used as the primary address for the virtual router." And: "Configure this command once without the secondary keyword to indicate the virtual router IP address. If you want to indicate additional IP addresses supported by this group, then do so and include the secondary keyword." |
| 2 | Same reference, Examples | Its one worked example pairs the two forms explicitly: `vrrp 1 ip 10.0.1.20` then `vrrp 1 ip 10.0.2.20 secondary` - a primary on the interface's primary subnet, a secondary on the interface's secondary subnet. No example types two bare lines. |
| 3 | [Cisco IOS XE 16 First Hop Redundancy Protocols Configuration Guide, Configuring VRRP](https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/ipapp_fhrp/configuration/xe-16/fhp-xe-16-book/fhp-vrrp.html) | "After you identify a primary IP address, you can use the vrrp ip command again with the secondary keyword to indicate additional IP addresses supported by this group." Note: "All routers in the VRRP group must be configured with the same primary address and a matching list of secondary addresses" - so the box *does* hold a primary plus a list, and the two are not interchangeable. The same page gives the reason: "The virtual router can manage multiple IP addresses, including secondary IP addresses. Therefore, if you have multiple subnets configured on an Ethernet interface, you can configure VRRP on each subnet." |
| 4 | [Cisco Nexus 9000 NX-OS Unicast Routing Configuration Guide 9.3(x), Configure VRRP](http://www.cisco.com/c/en/us/td/docs/switches/datacenter/nexus9000/sw/93x/unicast/configuration/guide/b-cisco-nexus-9000-series-nx-os-unicast-routing-configuration-guide-93x/b-cisco-nexus-9000-series-nx-os-unicast-routing-configuration-guide-93x_chapter_010011.pdf) | "You can configure one virtual IPv4 address for a VRRP group." Its `secondary` option means something else again (accepting packets addressed to the VIP), which is a warning against reading one OS's keyword into another's. |
| 5 | [Cisco IOS XR VRRP Commands, CRS](https://www.cisco.com/c/en/us/td/docs/routers/crs/software/ip-addresses/command/reference/b-ip-addresses-cr-crs/b-ipaddr-cr-crs_chapter_01011.html) | `address secondary` is a door of its own, separate from `address`, and "Before configuring secondary virtual IPv4 address, the primary virtual IPv4 address for the subordinate group must be configured" - a secondary is not a legal *first* address on that OS. |

## What the console does today

Measured on this branch, ISR 4331, `Gi0/0/0` addressed `10.0.0.1/24`:

```
R1(config-if)#vrrp 10 ip 10.0.0.100
VRRP group 10 on Gi0/0/0 owns 10.0.0.100
R1(config-if)#vrrp 10 ip 10.0.0.101
VRRP group 10 on Gi0/0/0 owns 10.0.0.101
R1(config-if)#vrrp 10 ip 10.0.0.102 secondary
VRRP group 10 on Gi0/0/0 owns 10.0.0.102
R1(config-if)#end
R1#show running-config
interface GigabitEthernet0/0/0
 ip address 10.0.0.1 255.255.255.0
 vrrp 10 ip 10.0.0.100
 vrrp 10 ip 10.0.0.101
 vrrp 10 ip 10.0.0.102
!
R1#show vrrp
Interface     Group  Pri  State      Master            Virtual IP      Virtual MAC
Gi0/0/0       10     100  Backup     -                 10.0.0.100,10.0.0.101,10.0.0.102-
```

Three things are visible in that capture, in descending order of confidence:

1. **Every line appends.** `_vrrpIfaceCommand()` keeps the addresses in one array and pushes any that is
   not already there, so a group can hold any number of addresses that were all typed in the *primary*
   form. The receipt says `owns`, which is true of any address in the list and therefore does not tell
   the operator which of the three rules the box just applied.
2. **`secondary` is accepted and then forgotten.** The parser reads the word (the `is not in the subnet`
   check runs for it too) and stores the address in the same array with no marker, so
   `show running-config` prints `  vrrp 10 ip 10.0.0.102` - the bare line - for an address that was
   typed with the keyword, while the vendor's own example keeps the keyword on the line (sources 1-2).
   A config saved here and replayed on an IOS box would set the primary three times, which is not the
   state this console holds.
3. **The `Virtual IP` cell overruns its column.** It is padded to 16 characters but not wrapped, so
   three addresses run past the header and the virtual MAC prints glued to the last one: `10.0.0.102-`
   under a `Virtual MAC` heading. One address - the vendor's normal case - fits, which is why the
   collision was never seen before a group could hold more than one.

A fourth limit closes off the documented use-case: this console refuses `ip address <ip> <mask>
secondary` on a port (one address per port), and a virtual address must be in the port's subnet
(`% 10.0.2.100 is not in the subnet of Gi0/0/0 (10.0.0.1/24)`). So the only second virtual address this
model can reach is another address in the *primary's* subnet - a shape no Cisco example shows, since the
vendor's reason for a secondary VIP is the interface's second subnet.

## What is inferred

* The `secondary` keyword is part of the command, not a comment: the command reference prints it in the
  syntax, the configuration guide tells the operator to add addresses *with* it, and IOS XR gives the
  secondary address its own door. An address typed with it should therefore stay marked as one in the
  config this console prints, because that is the only place the mark survives a save.
* A bare second line is "the primary address" being configured again. The two readings of that -
  replace, or refuse with a group-already-has-a-primary sentence - are both consistent with the
  documentation; nothing found chooses between them.

## Unresolved, and what would settle it

1. **What a second bare `vrrp N ip` does.** Settled by one capture from any IOS 15.x/16.x/17.x box:
   type `vrrp 1 ip A`, then `vrrp 1 ip B`, then `show running-config interface <port>` and
   `show vrrp detail`. One line or two, and the priority and state afterwards, answers it. A `show tech`
   from a box whose group carries a secondary address would also show whether IOS prints `secondary`
   back on the config line, the way IOS XR's `show running-config router vrrp` does (`address 10.20.30.2
   secondary`).
2. **Whether a secondary before any primary is refused.** IOS XR says the primary "must be configured"
   first (source 5); NX-OS's VRRPv3 carries the same instruction. IOS classic's wording is a procedure,
   not a refusal, and no capture shows the sentence it would use. This console currently makes
   `vrrp 10 ip 10.0.0.104 secondary` the group's *only* address.
3. **How a multi-address group should print.** This console has one 16-character cell. A box's detailed
   view has a `Virtual IP address is ...` line per address; `show vrrp brief` has a single `Group addr`
   cell whose width the vendor does not document. A capture with two addresses would decide both the
   cell and the wrap.

Nothing was changed in `engine/` on this: the append rule has an argument behind it (the vendor's list
of addresses), and the two rules that would replace it are unattested. The three findings above are
recorded so the next run starts from them rather than from the receipt's `owns`.
