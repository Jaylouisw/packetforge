# Command-Line Reference

Every CLI-capable device exposes one **vendor-agnostic** console. It is
Cisco-like, but the same commands work on a Huawei router, a MikroTik switch,
or a generic PC — the engine operates on capabilities, not on vendor syntax.

Modes and their prompts:

| Mode | Prompt | How you get there |
|------|--------|-------------------|
| exec | `Hostname>` | (start) |
| enable | `Hostname#` | `enable` |
| config | `Hostname(config)#` | `configure terminal` / `conf t` |
| interface | `Hostname(config-if)#` | `interface <name>` (from config) |
| dhcp pool | `Hostname(config-dhcp)#` | `ip dhcp pool <name>` (from config) |

`help` and `?` answer in **every** mode, and each list is scoped to the commands that
mode's parser actually accepts: exec lists `show`/`ping`/`traceroute`/`converge`/`link`, config lists
BGP/OSPF/DNS/SCION/DHCP, interface lists `switchport`/`ip ospf`/`vrrp`, and a DHCP pool
lists its own sub-commands (`network`, `range`, `lease`, …).

## Global / exec commands

| Command | Effect |
|---------|--------|
| `enable` | enter enable mode |
| `configure terminal` | enter config mode |
| `show version` | vendor, model, category, capabilities |
| `show logging [<type> \| summary] [last <n>] [device <name>]` | the lab's event log — why something was dropped, forwarded or denied ([Event log](#event-log)) |
| `show clock` | the instant the lab is being asked about, and a plain statement that there is no wall clock ([Event log](#event-log)) |
| `clear logging` | truncate the event log (privileged exec) |
| `show startup-config` | the saved copy, then what the running config has changed ([Saving the configuration](#saving-the-configuration)) |
| `write memory` | save the running configuration as the startup copy (privileged exec) |
| `copy running-config startup-config` | the same save, spelled the other way |
| `clear counters [<port>] / clear interface counters` | zero the per-port counters (privileged exec) — the two spellings are the same command |
| `clear arp [<port>] / clear ip arp` | empty the ARP cache (privileged exec); the next packet re-learns it. A port clears only the entries `show arp` attributes to that port — an entry behind a switch is attributed to `-` and survives |
| `clear mac address-table [interface <port>]` | empty the MAC table on a switch (privileged exec); a router refuses, because it does not bridge |
| `show ip interface brief [<port>]` | interface IP / status table; the **Method** column says `manual` or `DHCP`; one port narrows it ([Port arguments](#port-arguments--one-port-or-a-refusal)) |
| `show ip route` | connected (`C`), static (`S`), OSPF (`O`) and BGP (`B`) routes |
| `show arp [<port>]` | ARP cache (`show ip arp` is the same command, and the spelling IOS's own help prints); the Interface column is derived from the topology, because the cache itself holds only address → MAC. It names the port only when the owner is **directly cabled** to this device — a host behind a switch shows `-` — and prints `(self)` for the device's own address |
| `show mac address-table [interface <port>]` | MAC table (switches); one port narrows it |
| `show interfaces [<port>]` | per-interface detail incl. MAC, peer and counters; name a port and it answers for that port only ([Port names](#port-names)) |
| `show interfaces counters [<port>]` | one row per port: packets, bytes and drops ([Interface counters](#interface-counters)) |
| `show interfaces transceiver [<port>]` | cage, negotiated medium, reach vs cable length, and the `W_DISTANCE` verdict |
| `show running-config` | the full configuration, including routing protocols — see the note below |
| `show vlan [<id>]` | VLAN table with trunk ports marked `(t)`, or one VLAN ([VLANs](#vlans)) |
| `show spanning-tree [<port>]` | STP state, or "not part of any L2 loop"; one port narrows it |
| `show etherchannel` | LAG groups and member state ([Link aggregation](#link-aggregation)) |
| `show access-lists` | ACL entries and where each list is bound ([Access control lists](#access-control-lists)) |
| `show vrrp` | group state after the last election ([VRRP](#vrrp-first-hop-redundancy)) |
| `show ip bgp` | peers and installed prefixes ([BGP](#bgp)) |
| `show ip ospf` | process, interfaces and adjacency count ([OSPF](#ospf)) |
| `show ip ospf neighbor` | peers the SPF ran over: router-id, state, address, port |
| `show lldp` | neighbours actually heard on the wire |
| `show ipv6 nd` | what this device would advertise ([IPv6 commands](#ipv6-commands)) |
| `show ipv6 interface [<port>] [at <ms>\|converged]` | which ports hold a v6 address, and where each came from |
| `show ipv6 route [<dest>] [at <ms>\|converged]` | the IPv6 table, or the longest match for one destination |
| `show dns` | zones, records and configured name servers ([DNS](#dns)) |
| `nslookup <name> [type]` | ask this device's zones, then the lab's resolvers ([DNS](#dns)) |
| `show scion` | membership, segments, peers and reachability ([SCION](#scion)) |
| `show scion paths [<isd-as>]` | composed paths, and the one `pingScion()` would carry |
| `show flows [<id> \| counters]` | conversations in the lab, one in full, or per-device counters ([Flows](#flows)) |
| `show ip nat translations` | NAT entries the data path wrote ([NAT](#nat--configured-in-the-topology-not-the-cli)) |
| `show ip nat statistics` | rule counts, entry counts and hits |
| `show ip dhcp binding` | leases a server handed out, or the lease this device holds ([DHCP server](#dhcp-server)) |
| `show ip dhcp pool` | pool summary with addresses in use |
| `show power inline [<port>]` | PoE budget, its source, and per-port power decisions ([PHYSICAL_LAYER.md](PHYSICAL_LAYER.md)); on a device that neither sources nor draws PoE it answers `% <name> neither sources nor draws PoE` instead of inventing a budget |
| `flow open <dst> [port <n>] [bytes <n>] [proto tcp\|udp] [sport <n>]` | start a conversation from this device; `dst` is an address or a name ([Flows](#flows)) |
| `flow close <id>` | close one: TCP runs a four-way close, UDP is retired |
| `ping <dst> [count <n>] [at <ms>\|converged]` | ICMP echo; `dst` is an address **or a hostname** ([Destination names](#destination-names)) |
| `ping ipv6 <v6dst> [count <n>] [at <ms>\|converged]` | the same echo over IPv6 (an IPv6 address needs no keyword either) |
| `renew dhcp [<port>]` | ask the server for a lease now, on a port configured `ip address dhcp` |
| `release dhcp [<port>]` | give the lease back; the port stays unaddressed until renewed |
| `traceroute <dst> [at <ms>\|converged] [numeric]` | the forwarding path, hop by hop, with one-way delay (`tracert` too); `numeric` = addresses only |
| `converge [<ms>]` | when every control plane finishes (a bare number — the `at` keyword is **not** accepted here) |
| `links` / `link …` | cables and their state ([Cables](#cables)) |
| `help` / `?` | the command set for the mode you are in |
| `exit` / `logout` | leave the session |

### What a show derives, and what needs traffic

A `show` reports one of two kinds of fact, and the difference decides whether asking it is enough.

**A table the control plane produces is derived before it is printed.** Ask any of these on a lab that
has been configured and never simulated, and you get the answer, not a placeholder — measured on one
lab: two routers with OSPF and BGP, a host, and a switch loop, with no `ping` sent:

```
R1#show ip route
Codes: C - connected, S - static, O - OSPF, B - BGP
* = installed (this row is what forwards); an unmarked row loses on administrative distance
  *  Prefix          AD   Gateway    Interface
  *  C 10.0.12.0/24  0    -          Gi0/0
  *  C 10.0.1.0/24   0    -          Gi0/1
     O 10.0.99.0/24  110  10.0.12.2  Gi0/0
     B 10.0.12.0/24  20   10.0.12.2  Gi0/0
  *  B 10.0.99.0/24  20   10.0.12.2  Gi0/0
R1#show ip bgp
BGP router identifier 1.1.1.1, local AS number 65001
Neighbor   V  AS     State        Reason
10.0.12.2  4  65002  Established  eBGP
1 of 1 neighbour(s) established
2 prefix(es) installed from BGP
R1#show vrrp
Interface  Group  Pri  State   Master  Virtual IP  Virtual MAC
Gi0/0      10     120  Master  R1      10.0.1.254  00:00:5e:00:01:0a
```

That covers `show ip route`, `show ipv6 route`, `show ip ospf`, `show ip ospf neighbor`, `show ip bgp`,
`show vrrp`, `show ip dhcp binding` / `show ip dhcp pool`, `show spanning-tree`, `show lldp neighbors`,
and `show ipv6 interface`. A reader derives the planes it displays; a *non*-reader (a configuration
verb, a link change) bumps a revision so the next reader does the work. The upshot is the rule you
want from a console: **the same question gives the same answer regardless of what you typed before
it.** There was a period when it did not — `show ip bgp` said `(no neighbours have been evaluated yet
- run a simulation)` on a lab whose BGP session was configured and would establish, and `show ip route`
printed `C` rows only until something else happened to run OSPF.

Two consequences worth knowing:

- `show ip bgp` no longer answers `0 of 0 neighbour(s)` for a configured neighbour. It says `1 of 1
  neighbour(s) established`, because it evaluated the session before answering.
- A *bridge* is still a bridge: `show lldp neighbors` on the router shows the switch because LLDP
  frames are delivered, and the switch's MAC table already holds `DYNAMIC` rows even though nobody
  pinged — LLDP announcements alone are enough to populate the data path.

**A table the data path writes needs frames.** These are empty (header only, or a sentence saying so)
until traffic crosses, and no amount of asking fills them:

| Needs traffic | On an unpinged lab | After a ping |
|---|---|---|
| `show arp [<port>]` | header only, no entries | the peer's IP and MAC; a port filter keeps only entries whose port is known, because an entry behind a switch shows `-` and folding it into another port would invent a fact |
| `show interfaces counters [<port>]` | `(no port has carried a frame since this lab started)` | per-port rx/tx and bytes; `clear counters` resets |
| `show ip nat translations` | empty — no frame was translated | one row per translation, with hits |
| `show flows` | no conversations | one row per flow, open or closed |
| `show mac address-table` | header only | one `DYNAMIC` row per learned address (LLDP is enough to fill it) |

`show running-config`, `show interfaces`, `show ip interface brief`, `show vlan`, `show access-lists`,
`show dns` and `show power inline` report from configuration and need neither a run nor traffic.

### When a feature is off, the refusal names the fix

A command refused because a prerequisite is missing is the moment an operator most needs to be told
which command supplies it — so every one of them names it, quoted, in the spelling the console
accepts:

```
R1#show ip bgp
% BGP is not enabled - "router bgp <as>" in config mode turns BGP on
R1#show ip ospf
% OSPF is not enabled - "ospf router-id <ip>" in config mode turns OSPF on
R1#show vrrp
% VRRP is not configured - "vrrp <id> ip <addr>" inside an interface block adds a group
R1#show scion
% This device is not a SCION AS - "scion <isd-as>" in config mode makes this device an AS
R1>clear counters
% clear counters needs enable mode - type "enable" first
```

Three properties, each of which was absent before:

- **The show says as much as the verb.** `show ip bgp` answered `% BGP is not enabled` with no hint
  while `bgp neighbor …` answered `% BGP is not enabled (use "router bgp <as>")`. The show is where
  you learn the feature is off, so it was the one place that could not tell you how to turn it on.
- **One wording per feature.** Six call sites had grown four spellings of the same fact; they now read
  one string each (`NEEDS` in `engine/cli.js`), so a show and the verb it guards cannot disagree.
- **The hint is typed, not trusted.** `test/refusal-pointers.test.js` takes the quoted command out of
  every one of these refusals, fills its placeholders, types it in the mode the hint claims (config,
  interface block, or `enable` itself), requires it to work, and then requires the original command to
  stop refusing. A hint that drifts off the real spelling fails the suite — verified by writing
  `"bgp <as>"` into the BGP hint: 4 assertions fail; removing a hint entirely: 3.

`help` and `?` answer in **every** mode — exec, config, interface and the DHCP pool sub-mode — and
each list is the set of commands that mode's parser actually accepts, not one wall of text. The
interface list names the port you are on, and the pool list names the pool:

```
R1(config)# interface Gi0/0
R1(config-if)# ?
Interface-mode commands (Gi0/0):
  ip address <ip> <mask>                     assign an IP
  ip address dhcp | no ip address            DHCP client / clear
  shutdown | no shutdown                     administratively down / up
  description <text>                         (no description)
  encapsulation dot1q <vlan>                 tag this subinterface
  switchport mode access|trunk
  switchport access vlan <id>
  switchport trunk native vlan <id>
  switchport trunk allowed vlan <list|all>
  channel-group <id> mode active|passive|on|static
  ip access-group <acl> in|out | no ip access-group [<acl>] [in|out]
  ip ospf cost <n> | area <id> | passive
  ipv6 address <addr>/<len> | autoconfig | no ipv6 address [autoconfig]
  vrrp <vrid> ip <addr> [priority <p>] [preempt] [advertise <s>]
  no vrrp <vrid>                             remove the group
  interface <name>                           switch to another port, stay in config-if
  show <what>                                any exec show, from here too
  <any config-mode command>                  applied globally, then back to config
  help / ?                                   this list
  exit / end                                 config / exec
```

Every row is padded to the same column by the code that builds it, so a command that grows a
character cannot push its description out of line. A command longer than the column — `flow open`
takes 70 characters — keeps its description on the next line, indented to that same column, rather
than running the two together.

`show running-config` carries every protocol the CLI can configure: `hostname`, each `vlan`
declaration, every `interface` block (address — static, `dhcp` or IPv6 — ACL binding,
`switchport`, `channel-group`, OSPF overrides, VRRP groups), `access-list` lines, `ip route`
lines, `ip default-gateway`, the OSPF process (`ospf router-id` / `ospf area`), the BGP process
with its router-id and neighbours, IPv6 routes and gateway, IPv6 router-advertisement policy
(`ipv6 nd ra …`, `suppress-ra`, advertised prefixes), DNS zones and their records, name servers,
SCION membership, and DHCP pools (one block per pool, closed with `exit`).

The dump is **pasteable**: feed it back through `configure terminal` and the device comes back
identical. That works because `interface <name>` is accepted *inside* an interface block, a
global command typed there is applied globally and leaves the block, and a `!` line is a comment
— the same leniency real IOS has, and the reason a dump without `exit` lines between blocks still
runs. The RA timer values (hop limit, reachable time, retransmit timer) are the only state with no
CLI verb, so `show ipv6 nd` reports those while the dump omits them.

Verified by replay rather than by inspection: a switch config (VLANs, an access port, a trunk with
native and an allowed list), a router config (address, static route, OSPF, BGP with a neighbour, a
DNS zone, an ACL) and an IPv6 router-advertisement config were each dumped, pasted into a fresh
device of the same model, and dumped again — **byte-identical all three times**. Administrative state
survives too, and the asymmetry is IOS's own: a port is up by default, so `no shutdown` never appears
in the dump, while `shutdown` does (`  shutdown` under the interface block). A restored device
therefore comes back with its ports up unless the dump shuts them.

`do show …` runs a `show` from config mode — and plain `show …` works there too (in config mode and
inside an interface block), so `do` is only needed on habit.

OSPF and BGP state surface through `show ip route` (codes `O` and `B`), `show ip ospf` /
`show ip ospf neighbor` and `show running-config`, and the route legend names every code the table
actually uses (`C`, `S`, `O`, `B`), so no row is left unexplained by the header.

**`show ip route` derives the control planes before it prints.** Configure OSPF on two routers and
ask for the table: the `O` row and the `O - OSPF` legend entry are there, with no `ping` in between.
Which is the point — a table that only fills after some *other* command happens to run the control
plane answers a question about your history of typing, not about the lab. The legend names the codes
the table uses, so no row is unexplained.

`at <ms>` is a different question from "now": it rebuilds the planes **as they would stand at that
instant** and labels the answer, so `show ip route at 0` genuinely shows the table before the
election has run while a plain show shows today's.

The command tables below are the documented syntax, and they are checked in both directions:
`test/docs-syntax.test.js` compares them with the console's `help` (a row naming a command help
does not have, or a placeholder help does not declare, fails the build), and
`test/help-forms.test.js` types every help row at the parser to make sure the form it advertises
is one the console accepts. The transcripts are checked too, by `test/docs-commands.test.js`,
which requires every prompt line in the docs to be a command some mode recognises.

## Config-mode commands

| Command | Effect |
|---------|--------|
| `hostname <name>` | set device hostname — the whole rest of the line, spaces included; a bare `hostname` is `% Incomplete command: hostname <name>` rather than a silent clear |
| `interface vlan <id>` | the switch's own address in that VLAN — an **SVI** (`Vlan<id>`), the only way a switch can hold a management IP ([Switch management address](#switch-management-address--an-svi)) |
| `interface <name>` | enter interface config mode |
| `ip route <dest> <mask> <gw> [iface]` | add static route |
| `no ip route <dest> <mask> [gw]` | remove static route |
| `ip default-gateway <gw>` | set default gateway (hosts) |
| `vlan <id> [name]` | declare a VLAN ([VLANs](#vlans)) |
| `do show …` | run a `show` from config mode |
| `exit` / `end` | leave config mode |

## Interface-mode commands

| Command | Effect |
|---------|--------|
| `ip address <ip> <mask>` | assign an IP — `192.168.1.1 255.255.255.0` and `192.168.1.1/24` are the same fact and both are accepted; a bare address is refused by name, not with `% Incomplete command`. The address must be a **host** in its own subnet, the mask must be **contiguous**, and neither the address nor the subnet may already belong to another interface ([Address rules](#address-rules--a-host-in-its-own-subnet-on-one-interface)) |
| `no ip address` | remove the IP |
| `ip address dhcp` | make this a DHCP client — the DORA exchange runs before the first packet ([DHCP server](#dhcp-server)) |
| `ip helper-address <addr>` | relay DHCP requests heard on this port to a server elsewhere — `no ip helper-address [<addr>]` removes one, or all ([DHCP relay](#dhcp-relay)) |
| `shutdown` / `no shutdown` | administratively disable / enable |
| `description <text>` | set a description (`no description` clears it) |
| `switchport …` | VLAN membership ([VLANs](#vlans)) |
| `channel-group <id> mode …` | add the port to a LAG ([Link aggregation](#link-aggregation)) |
| `ip access-group <acl> in\|out` | bind an ACL ([Access control lists](#access-control-lists)) |
| `no ip access-group [<acl>] [in\|out]` | unbind an ACL — both directions with no arguments |
| `ip ospf cost\|area\|passive` | join the port to OSPF ([OSPF](#ospf)) |
| `encapsulation dot1q <vlan>` | tag a `<parent>.<vlan>` subinterface |
| `interface <name>` | switch to another port without leaving the block (as IOS does) |
| `exit` | back to config mode |

## Port names

One socket has more than one spelling, because the front panel and the vendor console
disagree: MikroTik silkscreens `eth1` and `SFP+1` while RouterOS calls them `ether1` and
`sfp-sfpplus1`. A lab file saved before a catalogue rename says whatever the catalogue said
then. `engine/iface-name.js` folds all of those onto one key, and **every** command that
names a port goes through it — config mode, `show interfaces`, `show interfaces transceiver`.

```
R1#show interfaces ether1
eth1 (ethernet, 1G), MAC 02:00:00:00:00:01
  status: up
  ip: unassigned
  peer: disconnected
```

The answer names the port by its **panel** spelling, because that is what is printed on the
box; the spelling you typed is only how you asked. `show interfaces eth1` prints the same
four lines, so a spelling can never change the answer — only find it.

Naming a port that does not exist is refused by name rather than ignored:

```
R1#show interfaces bogus9
% No interface named bogus9 on R1
% Try "show ip interface brief" for the ports this device has
```

That distinction matters: `show interfaces <port>` used to accept the argument and then
print **every** port on the box, which looks like an answer and is not one. Ambiguity is
refused too — if two ports fold onto the same key, the resolver declines to guess rather
than picking one.

## IPv6 commands

Config mode:

| Command | Effect |
|---------|--------|
| `ipv6 route <prefix>/<len> <next-hop>` | add a static IPv6 route |
| `ipv6 gateway <addr>` | set the default IPv6 gateway |
| `no ipv6` | clear the IPv6 gateway and static routes |
| `ipv6 nd ra enable` / `ipv6 nd ra disable` | advertise prefixes to the link (`l3-forward` only) |
| `ipv6 nd ra managed` / `ipv6 nd ra other-config` | set the M / O flag (`no …` clears it) |
| `ipv6 nd ra lifetime <s>` | router lifetime; `0` means "not a default router" |
| `ipv6 nd prefix <prefix>/<len> [valid <s>] [preferred <s>]` | advertise a prefix with L=A=1 |
| `no ipv6 nd prefix <prefix>/<len>` | withdraw a prefix |
| `ipv6 nd suppress-ra` | stop periodic advertisements, still answer solicitations (`no …` resumes) |
| `show ipv6 nd` | what this device would advertise, and which interfaces are waiting |
| `show ipv6 interface [<port>] [at <ms>\|converged]` | addresses per port and their provenance ([details](#show-ipv6-interface--which-address-is-on-which-port)) |
| `show ipv6 route [<dest>] [at <ms>\|converged]` | the IPv6 table, a longest-match lookup, or an instant ([details](#show-ipv6-route--the-table-route6to-reads)) |

Interface mode:

| Command | Effect |
|---------|--------|
| `ipv6 address <addr>/<len>` | assign a static global address |
| `ipv6 address autoconfig` | take an address from a router advertisement (SLAAC) |
| `no ipv6 address` | remove the static address |
| `no ipv6 address autoconfig` | stop autoconfiguring and drop the learned address |

A router advertises a prefix **only on the link where it holds an address inside
that prefix**, because a prefix is a promise to route the traffic addressed in
it. `show ipv6 nd` prints that mapping and says so when a configured prefix is
attached to no interface.

```
R1(config)# interface Gi0/0
R1(config-if)# ipv6 address 2001:db8:aa::1/64
R1(config-if)# exit
R1(config)# ipv6 nd ra enable
R1(config)# ipv6 nd prefix 2001:db8:aa::/64 valid 2592000 preferred 604800
R1(config)# exit
R1# show ipv6 nd
IPv6 router advertisements on R1:
  Device      : generic-router  (l3-forward)
  Advertise   : enabled
  Flags       : M=0 O=0   router lifetime 1800s
  Timers      : reachable 0ms, retrans 0ms, hop limit 64
  Prefixes    : 1
    prefix                    L  A  valid(s)    preferred(s)
    2001:db8:aa::/64          1  1  2592000     604800
  Interfaces  : Gi0/0 (2001:db8:aa::/64)
  Autoconfig  : none

PC1(config)# interface eth0
PC1(config-if)# ipv6 address autoconfig
PC1# show ipv6 nd
IPv6 router advertisements on PC1:
  Device      : generic-pc  (no l3-forward)
  Advertise   : unavailable - a device without l3-forward cannot route a prefix
  Flags       : M=0 O=0   router lifetime 1800s
  Timers      : reachable 0ms, retrans 0ms, hop limit 64
  Prefixes    : none - hosts would learn a default router only
  Autoconfig  : eth0 -> 2001:db8:aa::ff:fe00:100/64 (from fe80::ff:fe00:0)
  Default gw  : fe80::ff:fe00:0 via eth0
```

Two things about the host side. The `Autoconfig` line reads `eth0 (waiting for a router)` until a
**run** has happened — the solicit/advertise exchange is part of a run, not of `show` — and once the
advertisement lands it grows a `Default gw` line as well. And **nothing on the console can start an
IPv6 run**: `ping` takes a dotted quad and refuses a v6 literal (`% Invalid ping target: …`), and
`flow open` refuses one too (`% Invalid destination: …`). The path that exercises IPv6 is
`Simulator.ping6()` — the API and the tests — so a console-only lab will sit at *waiting for a
router* no matter how long you watch it. The IPv6 surface is `show ipv6 nd`, `show ipv6 route`
([below](#show-ipv6-route--the-table-route6to-reads)) and `show ipv6 interface` (next section).

The host sends a router solicitation to `ff02::2`, the router answers to
`ff02::1`, and the host splices its own EUI-64 identifier onto the advertised
prefix. If the advertisement carries the M (managed) flag the host refuses to
autoconfigure and reports why: addresses on that network come from DHCPv6.

### `show ipv6 interface` — which ports have an address, and where it came from

The one view that answers "does this port even have a v6 address yet", and the reason a lab can look
broken when it is only un-converged. Two rows per port: the link-local every v6 port gets, and the
global address if there is one.

```
R1#show ipv6 interface
IPv6 addressing on R1:
  Port   State  Address          Prefix  Source
  Gi0/0  up     fe80::ff:fe00:0  -       link-local
  Gi0/0  up     2001:db8:12::1   64      configured
  Gi0/1  up     fe80::ff:fe00:1  -       link-local
  Gi0/1  up     -                -       no global address
  Gi0/2  up     fe80::ff:fe00:2  -       link-local
  Gi0/2  up     -                -       no global address

3 ports, 1 with a global address
```

The `Source` column is the part worth reading: `configured` means someone typed it, `link-local` means
the interface derived it from its MAC, and **`no global address`** on a port you expected to be
addressed is usually a host waiting for a router advertisement rather than a broken config — on a PC
the command says so directly:

```
PC1#show ipv6 interface
IPv6 addressing on PC1:
  Port  State  Address            Prefix  Source
  eth0  up     fe80::ff:fe00:100  -       link-local
  eth0  up     -                  -       no global address

1 port, 0 with a global address
Global addresses appear when a router advertisement arrives - see `show ipv6 nd`
This is the state as last computed; ask again with `at converged` to run the
advertisement pass first.
```

It takes a port name and the usual instant, and labels the answer when you use the latter:

```
R1#show ipv6 interface Gi0/0
IPv6 addressing on R1:
  Port   State  Address          Prefix  Source
  Gi0/0  up     fe80::ff:fe00:0  -       link-local
  Gi0/0  up     2001:db8:12::1   64      configured

1 port, 1 with a global address

PC1#show ipv6 interface at converged
IPv6 interfaces at converged (control planes rebuilt for this answer)
IPv6 addressing on PC1:
  ...
```

### `show ipv6 interface` — which address is on which port

`show ip interface brief` is IPv4. IPv6 had no addressing command at all: `show ipv6 nd` reports
policy, and "what address does this port have, and did a human type it or did a router advertise it?"
could only be answered by reading `show running-config` and knowing that a *missing* `ipv6 address`
line means SLAAC.

```
R1#show ipv6 interface
IPv6 addressing on R1:
  Port   State                  Address          Prefix  Source
  Gi0/0  up                     fe80::ff:fe00:0  -       link-local
  Gi0/0  up                     2001:db8:12::1   64      configured
  Gi0/1  up                     fe80::ff:fe00:1  -       link-local
  Gi0/1  up                     2001:db8:23::1   64      configured
  Gi0/2  administratively down  -                -       -

3 ports, 2 with a global address
```

`Source` is the column that earns the command. An **autoconfigured** address appears with the router
that advertised it, not merely "SLAAC":

```
PC1#show ipv6 interface at converged
IPv6 interfaces at converged (control planes rebuilt for this answer)
IPv6 addressing on PC1:
  Port  State  Address                   Prefix  Source
  eth0  up     fe80::ff:fe00:100         -       link-local
  eth0  up     2001:db8:12::ff:fe00:100  64      autoconfig from fe80::ff:fe00:0

1 port, 1 with a global address (1 autoconfigured)
```

That distinction is the point: an autoconfigured address goes away when the advertisements stop, which
is a different situation from a configured one — and the address never appears in `show
running-config`, because what was configured was the *intent* (`ipv6 address autoconfig`), not the
address.

**A host that has not heard an advertisement yet says so, and says what to do.** The
router-advertisement pass runs at the start of a run and whenever a question is asked at an instant,
so a plain show is the state *as last computed* — here that is not a shortcut but the truth: the
address arrives in a frame that has to be delivered, and until that pass runs there is nothing to
report. It is the one place where "ask again with `at converged`" is the answer rather than a
workaround:

```
PC1#show ipv6 interface
IPv6 addressing on PC1:
  Port  State  Address            Prefix  Source
  eth0  up     fe80::ff:fe00:100  -       link-local
  eth0  up     -                  -       no global address

1 port, 0 with a global address
Global addresses appear when a router advertisement arrives - see `show ipv6 nd`
This is the state as last computed; ask again with `at converged` to run the
advertisement pass first.
```

One port, and an unknown name, work as they do everywhere else — the argument resolves through the
same port-name resolver, an unknown name is refused rather than answering with every port, and the
summary counts what was actually printed:

```
R1#show ipv6 interface Gi0/1
IPv6 addressing on R1:
  Port   State  Address          Prefix  Source
  Gi0/1  up     fe80::ff:fe00:1  -       link-local
  Gi0/1  up     2001:db8:23::1   64      configured

1 port, 1 with a global address

R1#show ipv6 interface bogus9
% No IPv6 port named bogus9 on R1
```

### `show ipv6 route` — the table `route6To()` reads

`show ip route` stays IPv4-only: its legend reads `Codes: C - connected, S - static` and no `:`/`::`
row ever appears in it. The IPv6 table has its own command, and it is the same shape:

```
R1#show ipv6 route
Codes: C - connected, S - static
  *  Prefix              AD  Gateway         Interface
  *  C 2001:db8:12::/64  0   -               Gi0/0
  *  S 2001:db8:99::/64  1   2001:db8:12::2  -
```

Two things differ from the IPv4 table and both are worth knowing before you read a blank cell. A
**static IPv6 route prints `-` under `Interface`** even when the gateway is on a directly connected
link: the next hop is resolved at forwarding time by `route6To()`, not stored on the route, so the
column says the truth rather than guessing an egress port. And the legend has **only `C` and `S`**,
because only connected prefixes and static routes exist for IPv6 here — there is no OSPFv3 and no
multi-protocol BGP, so an `O` or `B` row would be a claim this model cannot back. The `*` marker
works exactly as it does in IPv4: it marks the row that forwards, and the explaining line appears
only when a row is actually shadowed.

Its help row is `show ipv6 route [<dest>] [at <ms>|converged]`, which is three things:

| Form | Answers |
|---|---|
| `show ipv6 route` | the whole table, derived before printing |
| `show ipv6 route <dest>` | the longest match for that address or prefix, from `route6To()` |
| `show ipv6 route [<dest>] [at <ms>\|converged]` | the whole table, one destination's longest match, or the table at an instant — the latter labelled `IPv6 routes at t=0 ms (control planes rebuilt for this answer)` |

```
R1#show ipv6 route 2001:db8:99::5
  Destination  2001:db8:99::5
  Matched      2001:db8:99::/64  (static, AD 1)
  Next hop     2001:db8:12::2
  Interface    -
```

A connected answer says so in the `Next hop` line rather than repeating the destination as if it were
a next hop, and a losing row for the same prefix is named:

```
R1#show ipv6 route 2001:db8:12::5
  Destination  2001:db8:12::5
  Matched      2001:db8:12::/64  (connected, AD 0)
  Next hop     - (directly connected)
  Interface    Gi0/0
  Shadowed     S 2001:db8:12::/64  (static, AD 1)
```

Asking about a prefix instead of an address answers about that prefix — every row for it, winner and
shadow together — and a prefix with no row is refused by name:

```
R1#show ipv6 route 2001:db8:12::/64
  *  Prefix              AD  Gateway         Interface
  *  C 2001:db8:12::/64  0   -               Gi0/0
     S 2001:db8:12::/64  1   2001:db8:12::2  -

R1#show ipv6 route 2001:db8:12::/48
% No IPv6 route for 2001:db8:12::/48 in the table
```

A destination the table cannot reach is a refusal with the reason attached, and the second line names
the missing default rather than leaving you to infer it:

```
R1#show ipv6 route 2001:db8:77::9
% No IPv6 route to 2001:db8:77::9
% No IPv6 default gateway is configured on this device
```

A malformed destination is a parse error, not a lookup that quietly answers nothing:

```
R1#show ipv6 route zzz
% Invalid IPv6 destination "zzz": illegal character in IPv6 address: zzz
```

`show running-config` still re-emits `ipv6 route …` and `ipv6 gateway …` for a round trip, and
`show ipv6 nd` still reports the gateway it would advertise as `Default gw`; the table is now the
third way to see the same state rather than the missing one.

## Example session (two-subnet router)

Captured from the engine, verbatim — prompts, confirmation lines and all:

```
Router-d1>enable
Router-d1#configure terminal
Router-d1(config)#hostname R1
R1(config)#interface Gi0/0
R1(config-if)#ip address 10.0.1.1 255.255.255.0
IP address set on Gi0/0: 10.0.1.1/24
R1(config-if)#no shutdown
Gi0/0 up
R1(config-if)#exit
R1(config)#interface Gi0/1
R1(config-if)#ip address 10.0.2.1 255.255.255.0
IP address set on Gi0/1: 10.0.2.1/24
R1(config-if)#exit
R1(config)#exit
R1#show ip route
Codes: C - connected, S - static
  *  Prefix         AD  Gateway  Interface
  *  C 10.0.1.0/24  0   -        Gi0/0
  *  C 10.0.2.0/24  0   -        Gi0/1
R1#ping 10.0.1.10
Type escape sequence to abort.
Sending 4, 100-byte ICMP Echos to 10.0.1.10, timeout is 2 seconds:
....
Success rate is 0 percent (0/4)
Request timed out (seq 0)
Request timed out (seq 1)
Request timed out (seq 2)
Request timed out (seq 3)
```

That is the honest output for this lab: a router with two configured subnets and **nothing cabled to
either of them** gets no reply, and the timeout is per sequence number so you can see which ones
failed. Four details worth knowing, all visible above:

- **The prompt carries the device id until you name it.** A device with no hostname prompts as
  `Router-d1>`, where `d1` is its id on the canvas; `hostname R1` changes it for every later prompt.
- **`exit` from config lands at `>`, not at `#`.** IOS returns to privileged exec; this engine
  returns to plain exec. Nothing is enforced by that difference — `show ip route` works from `>` —
  so the prompt is a label, not a permission boundary. `enable` gets `#` back.
- **A command that changes state says so.** `ip address` prints `IP address set on Gi0/0:
  10.0.1.1/24` and `no shutdown` prints `Gi0/0 up`; a transcript without those lines is not one the
  engine produced.
- The route table prints the mask **attached** to the destination — `C 10.0.1.0/24` — so the route
  is one token you can copy. Its columns are measured from the rows rather than typed in: a `/32`
  destination widens the table instead of pushing the gateway out of line.
- **`*` marks the route that forwards**, and `AD` says why. A static route and an OSPF route can
  both cover a prefix; only one of them is installed. See *show ip route — as computed, or at an
  instant* below.

### Where `exit` and `end` leave you

`exit` steps back one level; `end` jumps out of configuration altogether. Both return you to the
mode you entered `configure terminal` from — privileged exec, if that is where you were:

```
R1#configure terminal
R1(config)#interface Gi0/0
R1(config-if)#exit
R1(config)#end
R1#show ip interface brief
```

Leaving configuration does **not** grant privilege. A session that never ran `enable` comes back to
`>` — the configuration is kept, but so is the restriction:

```
R1>configure terminal
R1(config)#exit
R1>show version
```

This matters because the wrong behaviour is quiet. Landing at `>` instead of `#` keeps the config
you just typed and refuses the next `show`, which reads as "the command does not exist" rather than
"you are no longer enabled".

### A global command typed inside a port block says so

An unrecognised line inside an interface block falls through to global configuration and leaves the
block. That is deliberate: a pasted `show running-config` prints the globals without an `exit`
between them, and the paste has to run start to finish. But the fall-through changes the *meaning*
of a line, so it is announced:

```
R1(config)#interface Gi0/0
R1(config-if)#ospf area 0
OSPF area 0
  note: "ospf area 0" is a global command - applied at global scope and the interface block was left (the per-port form is "ip ospf ...")
```

`ospf area 0` configures the **process**; the port joins an area with `ip ospf area 0`. Without the
note the first reads as if it had configured the port.

### Asking a state show about an instant

`show ip route at <ms>` began this; the same question applies wherever the answer is a product of the
control planes, so the following all take a trailing `at <ms>` or `at converged`:

`show ip route`, `show ip ospf [neighbor]`, `show ip bgp`, `show ip dhcp binding|pool`, `show arp`,
`show mac address-table`, `show spanning-tree`, `show vrrp`, `show lldp [neighbors]`.

The instant form rebuilds the control planes at that moment before composing the answer, and the
first line says which instant it describes. `at <ms>`, `at converged`, and the bare `converged` or
bare number are all accepted, because that is what the `[at <ms>|converged]` in help offers — a bare
`converged` used to be ignored, which printed the table as last computed while looking like an
answer:

```
SW1#show spanning-tree at 0
STP at t=0 ms (control planes rebuilt for this answer)
Spanning tree enabled protocol ieee
Port   Role        State
Fa0/1  designated  listening
Fa0/2  designated  listening

SW1#show spanning-tree at converged
STP at converged (control planes rebuilt for this answer)
Spanning tree enabled protocol ieee
Port   Role        State
Fa0/1  designated  forwarding
Fa0/2  designated  forwarding
```

Three consequences worth knowing:

- **The rebuild announces LLDP and RA**, because a question about what was *heard* needs something
  to have spoken. Those frames are real state, so `show mac address-table at 0` shows the entries
  they created.
- **A protocol with no timer answers the same at both instants.** BGP establishes immediately in
  this model, so `show ip bgp at 0` and `show ip bgp at converged` agree. The label reports the
  question; identical answers are the honest reply to it.
- **Shows that are not control-plane products refuse the instant** — `show interfaces transceiver at
  0` answers `% "interfaces transceiver at 0" does not take an instant`, and names the ones that
  do. A physical table cannot be asked what it will look like in five seconds.

### show ip route <protocol> — one protocol's rows, and how much of the table forwards

Reading a whole table to find the OSPF rows is what you do when there is no filter. There is one:

```
R1#show ip route ospf
  *  Prefix          AD   Gateway    Interface
     O 10.0.99.0/24  110  10.0.12.2  Gi0/0
  *  O 10.0.77.0/24  110  10.0.12.2  Gi0/0

2 OSPF routes, 1 installed
```

`connected`, `static` and `bgp` work the same way, and the selector is matched before the address
forms, so an address can never be read as a protocol. A protocol with nothing in the table is a
refusal that names what *is* there, rather than a blank table:

```
R1#show ip route bgp
% No BGP routes in the table
% Codes present: connected, static, OSPF
```

`summary` counts them. It is the only place the difference between "in the table" and "installed"
is a number you can read without counting stars:

```
R1#show ip route summary
Route summary
  Protocol   Routes  Installed
  connected  1       1
  static     2       2
  ospf       2       1
  total      5       4

1 route shadowed by a lower administrative distance - "show ip route" marks the installed ones
```

Every one of these takes the instant too (`show ip route ospf at converged`, `show ip route summary
at 0`), and each is rendered from the same `routesTable()` as the table itself, so a filter cannot
disagree with the thing it filters.

### show ip route <dest> — what would this box do with this address?

The table answers *what is installed*. The question that actually gets asked when something is
unreachable is *what would this box do with this address, and why* — which needs the longest match,
the covering prefix, the next hop, and the reason the winner won. Three forms, all of which IOS
accepts:

```
R1#show ip route 10.0.99.5
  Destination  10.0.99.5
  Matched      10.0.99.0/24  (static, AD 1)
  Next hop     10.0.12.2
  Interface    -
  Shadowed     O 10.0.99.0/24  (OSPF, AD 110)

R1#show ip route 10.0.12.7
  Destination  10.0.12.7
  Matched      10.0.12.0/24  (connected, AD 0)
  Next hop     - (directly connected)
  Interface    Gi0/0
```

`Shadowed` lists what lost for that prefix — the one fact the table makes you infer. A prefix
argument (`10.0.99.0/24`, or `10.0.99.0 255.255.255.0`, or `10.0.99.5/24` canonicalised) prints just
that prefix's candidates with the installed one marked, which is the same table above with one
prefix in it:

```
R1#show ip route 10.0.99.0 255.255.255.0
  *  Prefix          AD   Gateway    Interface
  *  S 10.0.99.0/24  1    10.0.12.2  -
     O 10.0.99.0/24  110  10.0.12.2  Gi0/0
```

No route is a refusal that says so, and names the usual reason:

```
R1#show ip route 172.16.0.1
% No route to 172.16.0.1
% No default route is configured on this device
```

The answer comes from `routeTo()` — the same call the data path makes — and the candidates from
`routesTable()` with its administrative distances, so the lookup cannot disagree with forwarding.
Malformed input is refused in this command's words (`% Invalid destination`, `% Invalid prefix
length`, `% Invalid mask: … (not a contiguous netmask)`), never by letting the address arithmetic
throw: `net.isIp()` is a shape check that accepts `10.0.0.999`, and the parse behind it raises
`Invalid IPv4 address`, which reached the console as `% Error: …` and looked like a crash.

### Configuring a static route — every word is checked

`ip route` took four words and stored them. Nothing was validated, and a typo in the first one did not
stay in the table: `routeTo()` parses the stored destination, so **one mistyped word bricked the
device's data path** — every ping, traceroute and flow on that router answered
`% Error: Invalid IPv4 address: abc`, a message about a word typed three commands earlier, appearing
in a different command:

```
R1(config)#ip route abc 255.0.0.0 1.1.1.1
Route added: abc/8 via 1.1.1.1
R1#ping 10.0.0.5
% Error: Invalid IPv4 address: abc
```

Now each word is checked where it is typed, and the refusal names the word:

```
R1(config)#ip route abc 255.0.0.0 1.1.1.1
% "abc" is not an IPv4 address, so it cannot be a destination network
% Usage: ip route <network> <mask> <next-hop> [<interface>]
R1(config)#ip route 192.168.2.0 255.255.255.0 abc
% "abc" is neither an IPv4 next hop nor an interface on R1
% Usage: ip route <network> <mask> <next-hop> [<interface>]
% Interfaces: Gi0/0, Gi0/1, Gi0/2
R1(config)#ip route 192.168.2.0 255.255.255.0 10.0.0.2 250
% "250" is not an interface on R1
% The fourth word is an interface, not a distance - this model has no per-route administrative distance (AD is per source: connected 0, static 1, OSPF 110, eBGP 20)
% Interfaces: Gi0/0, Gi0/1, Gi0/2
```

Three of those refusals exist because the form the console *advertises* is `ip route <network>
<mask> <next-hop> [<interface>]`: the fourth word is an **interface**, not an IOS distance. A number
in that slot used to be stored as an interface name (so the route pointed at a port that does not
exist), and the numerical hint is printed only when the word is a number, so a genuine misspelling of
`Gi0/0` is not answered with a lecture about distances.

**A route that names nothing is refused, and so is one that names a dead end.** Both of these used to
be accepted, listed in `show ip route` as if they forwarded, and answered 0/4 pings:

```
R1(config)#ip route 10.9.9.0 255.255.255.0
% Incomplete command: ip route <network> <mask> <next-hop> [<interface>]
% A static route needs a next hop, e.g. "ip route 10.0.0.0 255.255.255.0 192.168.1.1"
R1(config)#ip route 192.168.2.0 255.255.255.0 Gi0/0
% Gi0/0 is an interface, not a next hop - this model forwards to a next-hop address
% Name the neighbour's address instead: "ip route 192.168.2.0 255.255.255.0 <neighbour-ip>"
% (the interface-only form is accepted by IOS on point-to-point links, and would forward nothing here)
```

The second one is the interesting case: IOS accepts `ip route <net> <mask> <interface>` on a
point-to-point link, and this model resolves the destination to itself through that port and then ARPs
for the destination on the wire, where nobody answers — measured 0/4 replies, against 4/4 for the same
lab with a next-hop address. A routing table cannot tell a working route from a dead one, so the form
is refused rather than stored.

The working form, and the removal, are as narrow as they look — the removal names the route it
removed and refuses one that is not there:

```
R1(config)#ip route 192.168.2.0 255.255.255.0 10.0.0.2
Route added: 192.168.2.0/24 via 10.0.0.2
R1(config)#no ip route 10.9.9.0 255.255.255.0
% No route to 10.9.9.0/24 is configured
% "show ip route" lists what is: 192.168.2.0/24
R1(config)#no ip route 192.168.2.0 255.255.255.0
Route removed: 192.168.2.0/24
R1#ping 192.168.2.10 count 2
Success rate is 100 percent (2/2)
```

`ip default-gateway` is held to the same rule (`% "abc" is not an IPv4 address, so it cannot be a
default gateway`), and so are the small neighbours that used to quote an empty or placeholder value:
`ipv6 route <prefix>` with no next hop, `vrrp <vrid> ip` with no address (`% Invalid address: (none)`
before), and `encapsulation dot1q` with no VLAN (`% VLAN out of range: ` — an empty value inside a
range complaint).

**Where the address check itself was wrong.** `net.isIp()` was a pattern match, so it called
`10.0.0.999` an address and the parser behind it then threw `% Error: Invalid IPv4 address:
10.0.0.999` at the console. `isIp()` now keeps the regex as a first pass and lets the parser decide,
which fixes that class of answer everywhere it is used, not only in `ip route`.

### An area id, and the rule it was never used for

`ospf area` read its id with `parseInt`, which meant two things were true at once: half the range the
model allows (`0-4294967295`) was unreachable, and the dotted-quad form — the one RFC 2328 prints —
was **truncated at its first dot**:

```
R1(config)#ospf area 255.255.255.255
OSPF area 255
```

That is not a refusal and it is not the number that was typed. `engine/ospf.js` already had
`parseAreaId()`, which accepts both spellings and returns the 32-bit value it compares; the console
now uses it:

```
R1(config)#ospf area 255.255.255.255
OSPF area 4294967295
R1(config)#ospf area 0.0.0.1
OSPF area 1
R1(config)#ospf area 4294967296
% "4294967296" is not an area id (0-4294967295, or a dotted quad like 0.0.0.1)
```

**The area was also never compared.** RFC 2328's first rule is that both ends of a link must sit in
the same area, and `engine/ospf.js`'s own header says so — but two routers in areas 1 and 2 formed a
FULL adjacency and exchanged routes, so the field was configurable, displayable and inert:

```
R1(config)#ospf area 1
R1(config)#ospf router-id 1.1.1.1        # R2 is in area 2
R1#show ip ospf neighbor
Neighbor ID     Pri   State           Address         Interface
(no adjacencies - no neighbour passed the passive, subnet and area checks)
% R2 on Gi0/0 is in area 2 and this interface is in area 1 - no adjacency without a matching area
R1#show ip route ospf
% No OSPF routes in the table
% Codes present: connected
```

A cabled peer that is not a neighbour is the question the table raises, so the table answers it: the
mismatched link is recorded during the SPF and named afterwards, with both areas. A per-interface
`ip ospf area` still overrides the process default, and `show ip ospf` reports the interface's own
area — so an ABR with two areas is configured and read the same way it always was.

### show ip route — now, or at an instant

The plain command prints the table **as it stands now**, and getting there means deriving the
control planes first. So a plain `show ip route` and `show ip route at converged` give the same
table, and that is the honest answer: both are asking about the lab in its converged state.

`show ip route at <ms>` asks something else — *what would the table be at 5 s?* — and rebuilds the
planes at that instant, so it does not depend on what ran before. Each `at` answer is labelled,
because otherwise the forms are indistinguishable:

```
R1#show ip route at 0
Routes at t=0 ms (control planes rebuilt for this answer)
Codes: C - connected, S - static
  *  Prefix          AD  Gateway    Interface
  *  C 10.0.12.0/24  0   -          Gi0/0
  *  S 10.0.99.0/24  1   10.0.12.2  -

R1#show ip route at converged
Routes at converged (control planes rebuilt for this answer)
Codes: C - connected, S - static, O - OSPF
* = installed (this row is what forwards); an unmarked row loses on administrative distance
  *  Prefix          AD   Gateway    Interface
  *  C 10.0.12.0/24  0    -          Gi0/0
  *  S 10.0.99.0/24  1    10.0.12.2  -
     O 10.0.99.0/24  110  10.0.12.2  Gi0/0
  *  O 10.0.77.0/24  110  10.0.12.2  Gi0/0

R1#show ip route
Codes: C - connected, S - static, O - OSPF
* = installed (this row is what forwards); an unmarked row loses on administrative distance
  *  Prefix          AD   Gateway    Interface
  *  C 10.0.12.0/24  0    -          Gi0/0
  *  S 10.0.99.0/24  1    10.0.12.2  -
     O 10.0.99.0/24  110  10.0.12.2  Gi0/0
  *  O 10.0.77.0/24  110  10.0.12.2  Gi0/0
```

The last two are the same table, which is what "same question, same answer" means here. If you want
to see the lab *before* the routing protocol has run, ask for that instant: `at 0` is the only form
that shows `C` and `S` alone.

Three things that transcript shows honestly:

- **Both routes for a prefix are listed** when static and OSPF both cover it, and the one that
  actually forwards is marked `*`. The `AD` column is the reason: static is 1, OSPF is 110, so the
  OSPF row is a candidate and not a second live path. Row order is not preference order — the next
  hop that forwards is the one `traceroute` follows. The distances are the same ones `routeTo()`
  breaks ties with (`Device.ADMIN_DISTANCE`), not a display convention, and `test/route-
  installed.test.js` checks every starred row against `routeTo()`.
- **The `at` form leaves the table as it computed it**, exactly as `ping … at` re-bases the run.
  The state sticks; `at converged` puts it back to the fully-converged lab.

And one behaviour to unlearn: **a device cannot ping its own address.** `ping 10.0.2.1` from R1 times
out even though R1 owns 10.0.2.1: echo requests are answered when they *arrive over a link*, and a
frame a device originates to itself never crosses one. Real hardware answers; this does not.

**An address is only local on the interface that owns it**, which is the same rule seen from the
other side and catches far more people. `_handleLocalIp()` asks `dev.ownsIpOn(ingress, dst)`; if the
answer is null the echo is dropped with the event reason `echo for unknown local IP`, whatever the
routing table says. So on a two-port router with `10.0.12.2/24` on `Gi0/0` and `10.9.9.1/24` on
`Gi0/1`, both cabled:

| From | To | Result |
|---|---|---|
| PC1 on `10.9.9.0/24`, cabled to `Gi0/1` | `10.9.9.1` | **`!!!!` 4/4** — arrives on the interface that owns it |
| R1 across the link, route `10.9.9.0/24 via 10.0.12.2` | `10.9.9.1` | **`....` 0/4** — arrives on `Gi0/0`, which does not own it |
| R1 across the link | a host *behind* that router, `10.9.9.50` | **`!!!!` 4/4** — routed traffic is unaffected |

So a router answers for its far-side address only from that far side. The route exists, the brief
table says `up up`, and the ping still times out — which reads like a broken lab rather than a
modelling choice. `show ip route` is not the thing to check here; the ingress interface is.

A ping that does work, between two cabled hosts, prints the success line and then one line per
reply with a real millisecond time computed from the path:

```
PC1# ping 10.0.1.11
Type escape sequence to abort.
Sending 4, 100-byte ICMP Echos to 10.0.1.11, timeout is 2 seconds:
!!!!
Success rate is 100 percent (4/4)
Reply from 10.0.1.11: bytes=100 time=0.103 ms
Reply from 10.0.1.11: bytes=100 time=0.103 ms
Reply from 10.0.1.11: bytes=100 time=0.103 ms
Reply from 10.0.1.11: bytes=100 time=0.103 ms
```

## Note on vendor syntax

This is intentionally a **unified** command set. A future release can add
per-vendor "translators" (e.g. accept Juniper `set interfaces …` or Huawei
`interface GigabitEthernet0/0/0`) while keeping the single underlying
configuration model. See `docs/ROADMAP.md`.

### An argument the command does not use is refused, not dropped

Every command below used to accept an extra word and answer anyway, which is indistinguishable from
honouring it:

```
SW1#show vlan 99                       (printed every VLAN)
SW1#show flows counters 99             (printed the counters)
R1#show ip route connected extra       (printed the connected-routes filter)
R1#converge 100 extra                  (converged anyway)
R1#show logging last 0x10              (took 0x10 as 16 and showed the last sixteen events)
R1#flow close abc                      (answered "% no such flow: abc")
```

Now each one refuses and quotes its own synopsis:

```
R1#show ip route connected extra
% Unexpected argument "extra" - show ip route connected takes no more
% Usage: show ip route connected
R1#show logging last 0x10
% show logging last <n> takes a positive whole number of events (got "0x10")
R1#flow close abc
% Invalid flow id "abc" - ids look like "flow-3" or "3" (see "show flows")
```

Three details that matter more than the wording:

- **`show vlan <id>` narrows; it does not repeat the whole table.** Asking for a VLAN that is not
  there is refused by name and the refusal distinguishes the two ways a VLAN can be absent:
  `% Carried VLANs: 1, 10, 20; configured but empty: 30` — a VLAN a port carries, versus one that was
  declared and has nothing in it. `show vlan 30` answers with `(no ports)` rather than an empty cell.
  `show vlan brief` (the documented synonym) and `show vlan id 10` (the IOS spelling) still work —
  adding an argument must not remove a form the page already promised.
- **A flow id has a shape.** `flow-3` is what the list prints and `3` is the same flow, so
  `show flows 3`, `show flows flow-3`, `flow close 3` and `flow close flow-3` all agree. `abc` is
  refused as a shape, not looked up and reported missing — "no such flow: abc" was the answer to a
  question nobody asked.
- **`last <n>` takes the spelling of a count.** `0x10`, `1e3`, `+2`, `1.5`, `0`, `-2` and `abc` are
  all refused; before, the first two were silently read as 16 and 1000.

`test/extra-arguments.test.js` (59 assertions) covers all of it, plus a regression block over the nine
shows that already took a port strictly (`show arp Fa0/1 zzz` and friends), so the rule cannot drift
back in the commands that already obey it.

### The destination slot — one rule, three commands

`ping`, `traceroute` and `flow open` all take a destination as their **first** argument, and all
three have keywords of their own after it (`at`, `count`, `port`, `bytes`, `proto`, `sport`). A line
that begins with one of those keywords has no destination, and the answer says so in the synopsis
`help` prints:

```
R1#ping
% Incomplete command: ping <dst> [count <n>] [at <ms>|converged]
R1#ping at 5000
% Incomplete command: ping <dst> [count <n>] [at <ms>|converged]
R1#flow open port 22
% Incomplete command: flow open <dst> [port <n>] [bytes <n>] [proto tcp|udp]
R1#nslookup
% Incomplete command: nslookup <name> [type]
```

All four used to say something else, and two of them were wrong answers to a different question:

| Before | Why it was wrong |
|---|---|
| `% Invalid ping target: (none)` | `(none)` is a placeholder printed where a value belongs — nothing was ever in the slot |
| `% Unknown host at: no DNS server in this lab hosts a zone for it` | the keyword was handed to the resolver as a hostname, so a forgotten address came back as an accusation about DNS. An operator learns "this lab has no name server" from a command that never named a host |
| `% Incomplete command: flow open <dst-ip> [port <n>] …` | `<dst-ip>` appears in no help row; the documented placeholder is `<dst>`, so the message quoted a synopsis that does not exist |

The resolver is only consulted once a destination is actually present, which is the rule the whole
family now shares (`_requireDest()` in `engine/cli.js`). **One cost, stated plainly:** a host named
`at`, `port` or `count` cannot be reached by name through these three commands — resolve it with
`nslookup` and use the address. The keyword list is data (`DEST_KEYWORDS`), not a pattern at each
call site, so a new keyword cannot be spelled differently in one command and not another.
`test/dest-arguments.test.js` (38 assertions) types every keyword in the destination slot, requires
the incomplete message and the absence of any DNS blame, then requires real addresses, real names and
`traceroute … at <ms>` to keep working.

### ping — ask at an instant

```
ping <dst> [count <n>] [at <ms>|converged]
```

`dst` is an address or a hostname ([Destination names](#destination-names)); `count` is a whole
number of at least 1, and a value that is not one is refused by name rather than quietly replaced
with the default of 4.

`at` asks the question that many milliseconds after power-on. Before the control plane has
finished, the reply is not a timeout - the engine names the process that is not done:

```
SW1#ping 10.0.0.2 1 at 5000
Success rate is 0 percent (0/1)
% Still converging at t=5000 ms: stp on SW1 (ready at 30000 ms)
```

**The instant sticks.** It belongs to the run the simulator is answering, not to the one command,
so a later `ping` without `at` still answers at 5000 ms and does not mention it in its header. That
is deliberate - "what does the network do at t=5 s" is a state, not a probe - but it is easy to trip
over: ask once `at 0` and every command afterwards fails for a reason that has scrolled away.
`at converged` (also `at infinity`, `at inf`) puts the network back to the default a fresh lab has:

```
SW1#ping 10.0.0.2 at converged
Sending 4, 100-byte ICMP Echos to 10.0.0.2, timeout is 2 seconds:  (at converged)
!!!!
```

Replies now carry a real millisecond time, computed from the path (propagation in each medium,
serialisation at each port, store-and-forward at each device) rather than a hop count. See
[CONVERGENCE.md](CONVERGENCE.md).

### A DHCP lease can be taken and given back

`ip address dhcp` and `show ip dhcp binding` existed, so the client half of the exchange was readable
and untouchable — the two things an operator does with a lease had no command:

```
PC1#renew dhcp
% Unrecognized command: renew dhcp
PC1#release dhcp
% Unrecognized command: release dhcp
```

Both exist now, and they write **both** tables — the client's address and the server's binding — in
one call, because two commands that each write one table can disagree:

```
PC1#renew dhcp
Renewed DHCP lease on eth0: 192.168.5.10 (lease 86400s)
PC1#release dhcp
Released DHCP lease on eth0 (was 192.168.5.10)
  the server forgot the binding (1 table updated)
R1#show ip dhcp binding
DHCP bindings on R1: (none)
  no client has completed an exchange
R1#show ip dhcp pool
  LAN
    Range      : 192.168.5.10 - 192.168.5.20
    In use     : 0 of 11
```

A released lease **stays released** — otherwise the next refresh (every `show` derives the planes,
which runs the lease pass) would DISCOVER and hand the same address straight back, making the command
a success message with no effect. It comes back through `renew dhcp`, or by re-issuing
`ip address dhcp`.

Refusals are specific, because "it did not work" is not an answer:

```
R1#renew dhcp
% R1 has no DHCP client interfaces
% Configure one with "ip address dhcp" in an interface block
R1#renew dhcp Gi0/0
% Gi0/0 is not a DHCP client - it has no "ip address dhcp" configured
% "show ip interface brief" lists the Method column (DHCP or manual) for every port
PC1#renew dhcp Fa9/9
% No interface named Fa9/9 on PC1
```

### ...and the first question already knows the answer

The lease was answered two ways, depending on what had been typed first:

```
PC1#show ip interface brief          <- nothing has run yet
Interface  IP-Address  OK?  Method  Status  Protocol
eth0       unassigned  YES  DHCP    up      up
PC1#show ip dhcp binding
DHCP lease on PC1/eth0:  IP address : 192.168.5.10/24     <- the lease, all along
PC1#ping 192.168.5.1
PC1#show ip interface brief
eth0       192.168.5.10/24  YES  DHCP  up  up             <- now it agrees
```

The address arrives when the DHCP ACK is delivered, and delivering it is part of deriving the planes —
which `show ip interface brief` did not do. Any `show` that prints an address now derives them, and the
DHCP plane remembers whether its queue has actually been run (`_planesDhcp`, exactly as LLDP and RA
already did), so a lab configured a minute ago answers with its address on the first question.

### IPv6 can be configured, tested, and its arguments are its own

Every IPv6 feature in this model was configurable and none of it could be tested from the console:

```
R1#ping 2001:db8:1::2
% Invalid ping target: 2001:db8:1::2
R1#ping ipv6 2001:db8:1::2
% Unrecognised argument "2001:db8:1::2" (expected count <n> or at <ms>)
```

`sim.ping6()` had been there all along — only the door was missing. `ping` now takes an IPv6
destination, with or without the `ipv6` keyword, and reports in the same shape as the IPv4 run:

```
R1#ping 2001:db8:23::1 count 2
Type escape sequence to abort.
Sending 2, 100-byte ICMP Echos to 2001:db8:23::1, timeout is 2 seconds:
!!
Success rate is 100 percent (2/2)
Reply from 2001:db8:23::1: bytes=100 time=0.103 ms
```

When nothing answers, the answer says **why**, from the drops the run recorded:

```
R1#ping 2001:db8:23::1 count 2
..
Success rate is 0 percent (0/2)
Request timed out (seq 0)
Request timed out (seq 1)
% IPv6 unicast routing is disabled on M
```

`traceroute` does not follow an IPv6 path in this model, and now says so instead of calling the
address malformed:

```
R1#traceroute 2001:db8:1::2
% traceroute does not follow an IPv6 path in this model - the forwarding path is
% computed from IPv4 routing tables only. "ping 2001:db8:1::2" does work over IPv6.
```

#### `ipv6 unicast-routing` is a switch, not a decoration

The command was missing entirely, and the model forwarded IPv6 between configured interfaces
regardless. It exists now and **really does stop forwarding**:

```
M(config)#no ipv6 unicast-routing
IPv6 unicast routing disabled on M - this device now forwards no IPv6 packet (its own addresses still answer)
M#show ipv6 route
! IPv6 unicast routing is DISABLED on this device - these routes are configured but no
! packet is forwarded (ipv6 unicast-routing re-enables it)
Codes: C - connected
  *  Prefix              AD  Gateway  Interface
  *  C 2001:db8:12::/64  0   -        Gi0/0
  *  C 2001:db8:23::/64  0   -        Gi0/1
```

A table is not a promise, so the table says when it is not. (The switch starts **on** here, unlike
IOS, because this lab has always forwarded IPv6 the moment interfaces had addresses; that is stated
rather than implied by a missing line in a dump.)

#### The words an `ipv6` command does not use are refused

Only the **first** cell of a docs table is read as a command synopsis by `test/docs-syntax.test.js`,
so the cases below are described rather than quoted there.

```
typed                              before                                  now
<addr>/<len> extra                 success, `extra` dropped                % Unexpected argument "extra"
<addr>/<len> typed twice           success twice                           ... (already configured)
::1/128                            accepted                                % ::1 is the loopback address
ff02::1/64                         accepted, and show ipv6 route printed    % ff02::1 is a multicast address
                                   a *connected route for ff02::/64*        - a port cannot hold one
fe80::1/64                         accepted                                % fe80::1 is link-local - Gi0/0 already
                                                                           has one derived from its MAC
no argument at all                 % Invalid IPv6 address ""               % Incomplete command: ipv6 address
                                                                           <addr>/<len> | autoconfig
same address on two ports          accepted                                % ... is already configured on Gi0/0
two ports in one IPv6 subnet       accepted                                % 2001:db8:1::/64 is already on Gi0/0
                                                                           - two ports in one IPv6 subnet is
                                                                           ambiguous
a second global address            the first replaced in silence           note: replaced 2001:db8:1::1/64 - this
                                                                           model keeps one global IPv6 address
                                                                           per port
<prefix> <next-hop> 250            success, `250` dropped                  % Unexpected argument "250"
nd suppress-ra extra               success, `extra` dropped                % Unexpected argument "extra"
nd ra enable extra                 success, `extra` dropped                % Unexpected argument "extra"
nd ra lifetime 600 900             success, `900` dropped                  % Unexpected argument "900"
```

#### A refused command does not move the operator

`ipv6 nd suppress-ra extra` typed inside an interface block fell through to the global dispatcher,
which refused it **in its own words** (`% Unknown IPv6 RA command`); the fall-through only recognised
one refusal wording, so it treated the refusal as success, left the interface block, and the
operator's next commands went to the wrong prompt. Any line beginning with `%` is now a refusal,
whoever wrote it, and the block is kept.

The "this is a global command" note also used to end with `(the per-port form is "ip <first word>
...")` for every command — suggesting `ip ipv6 …` for `ipv6 nd suppress-ra`. It names a per-port form
only where one exists — `ospf area 0` inside a port block still says the block was left, and now says
`(the per-port form is "ip ospf ...")`; for `ipv6 nd suppress-ra` the note carries no form at all.

#### `show ipv6 interface brief`

```
R1#show ipv6 interface brief
Interface  IP-Address        Status  Protocol
Gi0/0      2001:db8:1::1/64  up      up
Gi0/1      unassigned        up      up
```

`brief` used to be looked up as a port name (`% No IPv6 port named brief on R1`), and the state
columns come from the same `_ifaceState()` the IPv4 tables use.

### A logical interface's state is the state of what carries it

`show ip interface brief` answered from `i.enabled` alone, so a subinterface whose parent was shut
reported `up/up` while a ping to its own address answered **0 percent**:

```
R1(config-if)#interface Gi0/0
R1(config-if)#shutdown
Gi0/0 administratively down
R1#show ip interface brief
Interface  IP-Address    OK?  Method  Status                 Protocol
Gi0/0      unassigned    YES  manual  administratively down  down
Gi0/0.10   10.10.0.1/24  YES  manual  up                     up
R1#ping 10.10.0.2 count 2
Success rate is 0 percent (0/2)
```

Two answers to one question, and the panel was the wrong one. A subinterface has no line of its own —
it borrows its parent's — so `computeSviState()` now sets `lineUp`/`lineStateReason` for it in the same
pass that already did the SVIs, and **one** helper (`_ifaceState()`) feeds every state column:
`show ip interface brief`, `show interfaces`, and `show ipv6 interface`.

```
R1#show ip interface brief
Interface  IP-Address    OK?  Method  Status                 Protocol
Gi0/0.10   10.10.0.1/24  YES  manual  administratively down  down
R1#show interfaces Gi0/0.10
Gi0/0.10 (subinterface, 1G), MAC 02:00:00:00:00:00
  status: administratively down
  ip: 10.10.0.1/24
  parent: Gi0/0, dot1q 10
  line protocol: down (parent Gi0/0 is administratively down)
  input : 3 packets, 332 bytes
  output: 3 packets, 332 bytes
  drops : 2
```

A **pulled cable** is a different fact from a shut port, and the columns say which one happened:
`Status: up` with `Protocol: down` and `line protocol: down (parent Gi0/0 has no link)`.

**And the counters counted nothing.** `show interfaces Gi0/0.10` reported `input : 0 packets` after
pings that answered 100 percent, because every frame was attributed to the physical port only. A frame
that a subinterface stamps and a subinterface answers now belongs to both, so the tagged interface shows
the traffic it carried — and a sibling subinterface whose VLAN the trunk does not allow stays at zero,
which is what makes the number mean something.

### A help placeholder must not become part of the command line

`switchport trunk allowed vlan all` is what the help row documents, and it was refused:

```
SW1(config-if)#switchport mode trunk
Switchport mode trunk on Fa0/1
SW1(config-if)#switchport trunk allowed vlan all
% cannot parse VLAN token "all>"
```

The word `all` was correct. The lexer that turns help rows into completable forms used
`WORD = /[^\s\[\]|]+/`, which does not exclude the angle brackets, so `… vlan <list|all>` became two
*keywords* — `<list` and `all>` — and abbreviation expansion rewrites a typed word to the documented
one. Typing `all` therefore produced `all>`, and the switchport parser quite correctly refused a VLAN
token that is not a VLAN.

A bracketed placeholder is now lexed as **one** token, brackets and alternatives included, so it
reaches the form parser as a value slot. `test/help-placeholders.test.js` sweeps every token of every
help form in every mode and asserts none of them contains a bracket — the class, not the row.

### A subinterface takes its tag from its number — and says so

```
R1(config)#interface Gi0/0.20
Created subinterface Gi0/0.20 (parent Gi0/0, dot1q 20 from the interface number)
```

The inference is a convenience, but it was silent, so `show running-config` printing
`encapsulation dot1q 20` for a line nobody typed looked like the dump inventing configuration. The
answer now names the assumption, and `encapsulation dot1q <vid>` overrides it.

### A router's dump contains no `switchport` lines

A router's port carries the tagged frames of its subinterfaces, and the model marks the parent as a
trunk to do it — so the dump printed `switchport mode trunk`, `switchport trunk native vlan 1` and
`switchport trunk allowed vlan all` for that port. The same device refuses `switchport` outright:

```
R1(config-if)#switchport mode trunk
% R1 does not switch - it has no switchports
```

A dump the device will not accept cannot restore the device. `switchport` lines are now emitted only
for a device that bridges; the tagging requirement is already stated once, by the subinterface's
`encapsulation dot1q <vid>` line. The test pastes the dump into a fresh router and asserts both that
every line is accepted and that the pasted device answers with the **same** dump.

### Address rules — a host in its own subnet, on one interface

`ip address` used to store whatever four numbers it was given. Every one of these was answered
"IP address set":

```
R1(config-if)#ip address 10.0.0.1 255.0.255.0
IP address set on Gi0/0: 10.0.0.1/8
R1(config-if)#ip address 10.0.0.255 255.255.255.0
IP address set on Gi0/0: 10.0.0.255/24
R1(config-if)#ip address 0.0.0.0 0.0.0.0
IP address set on Gi0/0: 0.0.0.0/0
```

`255.0.255.0` is not a mask — `prefixOf()` counted its leading ones and printed `/8`, so the console
described a subnet that does not exist. `10.0.0.255` is the broadcast address of its own subnet: no
host can answer for it. `0.0.0.0/0` is the default route worn as a port. Now:

```
R1(config-if)#ip address 10.0.0.1 255.0.255.0
% 255.0.255.0 is not a contiguous mask - the ones must all be on the left
% Try 255.255.255.0, or the prefix form "ip address 10.0.0.1/24"
R1(config-if)#ip address 10.0.0.255 255.255.255.0
% 10.0.0.255 is the broadcast address of 10.0.0.0/24 - a router address must be a host in its own subnet
% Try 10.0.0.254, or a wider mask
R1(config-if)#ip address 0.0.0.0 0.0.0.0
% 0.0.0.0 is not a host address, so no interface can hold it
```

A `/31` and a `/32` have no network or broadcast address, so that rule does not apply to them — a
point-to-point pair and a host route are both accepted, which is why the check is written against the
prefix rather than against "ends in `.255`".

**One address, one interface. One subnet, one interface.** Both of these were silent, and both matter
here more than they would on a real box, because a router in this lab answers for *every* address it
holds and forwards by lookup — so a duplicate address or an overlapping subnet makes two questions
unanswerable: who owns this address, and which port does it leave by.

```
R1(config-if)#ip address 10.0.0.1 255.255.255.0     (Gi0/1; Gi0/0 already has it)
% 10.0.0.1 is already on Gi0/0 - one address cannot be on two interfaces
R1(config-if)#ip address 10.0.0.2 255.255.255.0
% 10.0.0.0/24 overlaps Gi0/0 (10.0.0.1/24) - two interfaces in one subnet is ambiguous
% A router routes between subnets: give this interface a different one
```

The overlap test compares subnets as **unsigned** 32-bit ranges. A signed comparison makes any subnet
whose network address has the top bit set negative, which reported `192.168.0.0/24` as an overlap of
`10.0.0.0/24` — a false refusal is as bad as a false acceptance, and the test asserts both directions.

**`secondary` is a limitation, not a typo.** `ip address <ip> <mask> secondary` put the address on the
interface and dropped the word, so the answer said the whole line had been understood. One address per
interface is what this model holds, and it says so:

```
R1(config-if)#ip address 10.0.0.1/24 secondary
% "secondary" is not modelled - one address per interface in this lab
% Use a subinterface ("interface Gi0/0.10") for a second subnet on the same cable
```

Re-setting the **same** address on the **same** interface is a re-set, not a duplicate — the duplicate
rule looks at the other interfaces only.

### Clearing a learnt table — and the two that cannot be cleared

`clear counters` and `clear logging` zero state, but the two tables a lab fills by itself could not be
emptied at all, so the only way to watch ARP or MAC learning happen a second time was to rebuild the
topology:

```
R1#show arp
Protocol  Address    Age (min)  Hardware Addr      Interface
Internet  10.0.0.10  -          02:00:00:00:02:00  -
R1#clear arp
ARP cache cleared on R1 (1 entry)
R1#show arp
Protocol  Address  Age (min)  Hardware Addr  Interface
R1#clear arp
ARP cache on R1 was already empty - nothing to clear
```

The next packet re-learns the entry — the clear resets *learning*, it does not break the cache:

```
SW1#show mac address-table
Vlan  Mac Address        Type     Ports
1     02:00:00:00:00:00  DYNAMIC  Fa0/1
1     02:00:00:00:02:00  DYNAMIC  Fa0/2
SW1#clear mac address-table
MAC address table cleared on SW1 (2 entries)
```

**A port-scoped clear is as honest as the table it reads.** `show arp` derives the port from the
topology and prints `-` for a host behind a switch, because the cache holds only address → MAC. So
`clear arp Gi0/0` clears the entries it can attribute to that port and says when there were none —
it does not silently clear the whole cache to look useful:

```
R1#clear arp Gi0/0
ARP cache on R1 for Gi0/0 was already empty - nothing to clear
```

**Only a bridge has a MAC table.** A router answers by naming the table it does have:

```
R1#clear mac address-table
% R1 does not bridge, so it has no MAC address table
% Try "show arp" for the addresses it has learned
```

**`clear ip route *` and `clear ip bgp *` are refused with a reason, not with "Unrecognized command".**
There is nothing to flush: this model derives those tables from configuration and protocol state, so
the next answer would be the same one. An operator who knows IOS reads `% Unrecognized command` as
"this tool is missing a command" and goes looking:

```
R1#clear ip route *
% There is no routing table to clear: this model derives routes from configuration and protocol state, so the next answer would be the same one
% Ask "show ip route at <ms>|converged" for the state at an instant instead
```

### traceroute — which way, and how far

```
traceroute <dst> [at <ms>|converged] [numeric]       # tracert is accepted too
```

The forwarding path, hop by hop, read from the same `routeTo()` the forwarder uses. Each line
carries the address that would answer, the device it belongs to, and the cumulative **one-way**
delay to reach it:

```
PC1#traceroute 10.0.2.20
Type escape sequence to abort.
Tracing the route to 10.0.2.20

  Hop  Address    Cumulative  Device
  1    10.0.1.1   50.9 us*    R1
  2    10.0.12.2  101.8 us*   R2
  3    10.0.2.20  102.6 us*   PC2  (destination)

Path: PC1 -> R1 -> R2 -> PC2  (3 hops)
* 3 links had no cable length or line rate, so the documented default was used
```

**`numeric` means what it says.** The Device column and the names in the path line are a resolution
this tool does that IOS leaves to DNS; `numeric` suppresses both, and it is the only option besides
`at` that the command takes:

```
PC1#traceroute 10.2.2.10 numeric
Type escape sequence to abort.
Tracing the route to 10.2.2.10

  Hop  Address    Cumulative
  1    10.1.1.1   50.9 us*
  2    10.2.2.10  51.8 us*

Path: 10.1.1.1 -> 10.2.2.10  (2 hops)
* 2 links had no cable length or line rate, so the documented default was used
```

**Anything else is refused, not skipped.** The parser used to `continue` past every word that was not
`at`, so `traceroute 10.0.0.5 source abc` and `traceroute 10.0.0.5 ttl abc` printed a full hop table
and said nothing about the option they dropped — an answer that looks like it weighed the word.
`ping` already refused its own unknown options, so the two commands disagreed about whose mistake a
word they cannot use is:

```
R1#traceroute 10.0.0.5 source abc
% Unrecognised argument "source" (expected at <ms>|converged or numeric)
R1#traceroute 10.0.0.5 at
% Incomplete command: traceroute <dst> [at <ms>|converged] [numeric]
```

and `ping … at` with nothing after it is now the same incomplete command instead of
`% Invalid instant: (none)`, which quoted a placeholder at the operator.

The command sends nothing, so there is no TTL to expire. What *is* modelled is the answer: the path
the routing tables select right now, and the delay to each hop (propagation + serialisation +
store-and-forward, from each link's medium and length). Doubling the last figure gives the ping round
trip for the same path, which is a useful sanity check: `102.6 us` one way is the `0.205 ms` a ping on
that path reports.

**TTL itself is not absent from the engine, and an earlier draft of this page said it was.**
`_forwardL3()` does `frame.ip.ttl -= 1` at every router and drops the packet when it reaches zero,
emitting `{ type: 'drop', reason: 'TTL expired' }` — measured by forwarding a frame with `ttl: 1`
through a converged two-router lab: the counter went to `0` and the event log gained exactly one
`drop: TTL expired`. Since every origin stamps 64, a path of more than 64 hops stops the same way;
the event log names the device where it stopped. What is missing is the **report**: nothing generates
an ICMP time-exceeded, so the sender sees a silent timeout rather than a diagnostic. That is why
`traceroute` here reads the routing tables instead of collecting time-exceeded replies — the
information a real traceroute harvests is the one thing this model does not produce. `docs/SIMULATION.md`
§3.2 states it correctly; this page had it wrong.

**The unit changes with the size of the number**, so a short lab does not print `0.1 us` at you.
`formatDelayS` in `engine/latency.js` picks the unit by magnitude: below a microsecond it prints
**`ns`**, then **`us`**, then **`ms`** with three decimals, then **`s`**. Measured on one router hop
while the cable length changed:

| `lengthM` on the link | Cumulative printed at hop 1 |
|---|---|
| unset (default length and rate) | `880 ns*` |
| 1 | `885.1 ns` |
| 100 | `1.4 us` |
| 5000 | `26.2 us` |

A trailing `*` means that hop had no cable length or line rate and the documented default was
used — it appears per hop, not per path, so one route can mix starred and unstarred rows. `ping`
does **not** use this formatter: its reply line prints milliseconds only (`0.103 ms` under 1 ms
with three decimals, one decimal above), which is why the two commands' figures need converting
before they can be compared.

A hop with no route stops the walk and says why, instead of printing stars that hide the reason.
Which message you get depends on what is actually missing:

```
PC1#traceroute 8.8.8.8              # no default gateway on PC1
Tracing the route to 8.8.8.8

  Hop  Address  Cumulative  Device
  *  *  *  (no reply)
% no route to 8.8.8.8 on PC1
```

```
PC1#traceroute 8.8.8.8              # default gateway 10.0.1.99, which no device in the lab holds
Tracing the route to 8.8.8.8

  Hop  Address    Cumulative  Device
  1    10.0.1.99  50.9 us*
  *  *  *  (no reply)
% next hop 10.0.1.99 is not a device in this lab
```

The first is a host that was never told where to send anything; the second is a host pointed at a
gateway that does not exist. Collapsing both into "request timed out" would hide which one you
have.

### traceroute at an instant

`at <ms>` asks the same question as `ping … at`: what does the path look like that many
milliseconds after power-on? The trace rebuilds the control planes at that instant (STP, PoE, VRRP,
DHCP, OSPF, BGP — the same order `ping` uses), so the answer is the routing table that instant
would have, not the one the last run left behind. With no `at`, the answer is the fully converged
path.

```
PC1#traceroute 10.0.2.20 at 5000
Tracing the route to 10.0.2.20  (at t=5000 ms)

  Hop  Address   Cumulative  Device
  1    10.0.1.1  50.9 us*    R1
  *  *  *  (no reply)
% no route to 10.0.2.20 on R1 yet: ospf still converging (ready at 16000 ms)
```

That is the honest middle state: hop 1 exists because PC1's default gateway is static, R1 has no
route to `10.0.2.20` yet because OSPF has not finished, and the refusal names the process and the
time instead of leaving `*` to be interpreted. The same command at `at 17000` prints the full
three-hop path.

A link declared without a cable length or line rate gets a `*` on its delay and a footnote,
because the number then rests on the documented default rather than on anything the lab said.

### converge — when is it up?

```
converge [<ms>|converged]    # a bare instant, not "at <ms>"
```

The instant is validated, not coerced: `converge abc` and `converge -1` are refused, and
`converge at 1000` is refused with the form that works, because the `(pending)` marks below are
a claim about a moment and a wrong moment makes a confident-looking lie:

```
SW1#converge abc
% Invalid instant: abc
SW1#converge at 1000
% converge takes a bare instant: converge <ms>|converged (not "at <ms>")
```

A trailing number is a bare instant only when it is the *question*. After a keyword that takes a value
it is that keyword's value, so a port named by number stays a port:

```
SW1#show mac address-table 5000
MAC table at t=5000 ms (control planes rebuilt for this answer)
...
SW1#show mac address-table interface 22
% No interface named 22 on SW1
% Try "show ip interface brief" for the ports this device has
```

Lists every process on every device with the instant it finishes, and the lab's fully-converged
time. Give it an instant and anything still pending is marked:

```
SW1#converge
Process  Device  Ready     Basis
ospf     R1      16000 ms  hello 10 s + exchange, then SPF hold
stp      SW1     30000 ms  listening + learning (15 s forward-delay each)
stp      SW2     30000 ms  listening + learning (15 s forward-delay each)

Fully converged at 30000 ms.

SW1#converge 5000
Process  Device  Ready     Basis
ospf     R1      16000 ms  hello 10 s + exchange, then SPF hold  (pending)
stp      SW1     30000 ms  listening + learning (15 s forward-delay each)  (pending)
stp      SW2     30000 ms  listening + learning (15 s forward-delay each)  (pending)

Fully converged at 30000 ms.
```

**The instant is a bare number here.** `ping … at 5000` and `traceroute … at 5000` take the `at`
keyword; `converge` does not. `converge at 5000` is accepted and **silently ignores the instant** —
the table comes back with no `(pending)` marks and no error, which reads exactly like a lab that has
already converged. Write `converge 5000`.

If the lab runs nothing that converges over time, the answer is
`% Nothing in this lab runs a control plane that converges over time` rather than an empty table.

## DHCP server

```
ip dhcp pool <name>
  network <network> [mask|/prefix]
  default-router <address>
  dns-server <address...>
  range <start> <end>
  excluded-address <address[-address]>
  lease <days> [hours] [minutes]
  host <address> <mac>          # a reservation
  no pool                       # delete this pool
  exit
```

A pool is a named object on the device, not a property of an interface: one server can hold several
and a client picks by the subnet its own interface sits in.

**Incomplete waits; wrong is refused on the spot.** `network` before `range` is the second keystroke,
not an error, so a pool that is still being typed is judged when the sub-mode is left:

```
R1(config)#ip dhcp pool lan
Created DHCP pool lan
R1(config-dhcp)#network 10.0.0.0 255.255.255.0
R1(config-dhcp)#exit
% DHCP pool lan: no address range was given - "range <start> <end>" is required.
% Pool lan discarded - a pool is kept only once it is valid
% Add "range <start> <end>" inside the pool, or start again with "ip dhcp pool lan"
```

A value that is already *wrong*, on the other hand, is refused where it is typed: nothing the operator
does afterwards can rescue a network that is not an address, and waiting until `exit` meant the answer
arrived two commands later, in the validator's vocabulary (`% E_DHCP_BAD_RANGE: DHCP pool lan: both
rangeStart and rangeEnd are required.` — a field name the operator never typed):

```
R1(config-dhcp)#network abc
% "abc" is not an IPv4 address, so it cannot be the pool's network
R1(config-dhcp)#default-router abc
% "abc" is not an IPv4 address, so it cannot be the default router
R1(config-dhcp)#dns-server abc
% "abc" is not an IPv4 address, so it cannot be a DNS server
R1(config-dhcp)#range 10.9.9.50 10.9.9.10
% The range starts at 10.9.9.50 and ends at 10.9.9.10 - the start must not be above the end
```

`excluded-address` is checked the same way (each end of an `a-b` range), and the pool's remaining
complaints at `exit` are sentences: `E_DHCP_*` codes still exist in `engine/dhcp.js` and in the
validation table below, where they are useful, but they are no longer what the console prints.

**`lease <days>` takes days, as in IOS.** The one place this page is easiest to misread: `lease 600`
is 600 *days* and the pool then prints `Lease : 51840000s`; one day is `lease 1` (`86400s`); ten
minutes is `lease 0 0 10`, which prints `600s`. The examples below are that last case.

**`Expires in` is a deadline, not a length.** It is what is left of the lease at the instant the
question is asked about: `600s` on a fresh lab, `400s` when asked at `t=200000`, and `600s` again
after a renewal. Nothing runs a clock between questions, so a plain `show` reports the state at rest
(t=0) and the number only moves when you ask about a time.

A client is configured with `ip address dhcp` on its interface. The exchange runs before the first
packet of a run, and the failures are the ones a server really produces — `no-server`, `no-pool`,
`pool-exhausted`, `nak`. See [SIMULATION.md §5.1](SIMULATION.md).

What the exchange actually handed out is visible from both ends:

```
SRV#show ip dhcp binding
DHCP bindings on SRV:
  MAC                 IP               Pool          Expires in
  02:00:00:00:01:00   192.168.10.100   lan           600s

SRV#show ip dhcp binding at 200000
DHCP at t=200000 ms (control planes rebuilt for this answer)
DHCP bindings on SRV:
  MAC                 IP               Pool          Expires in
  02:00:00:00:01:00   192.168.10.100   lan           400s

PC1#show ip dhcp binding
DHCP lease on PC1/eth0:
  IP address   : 192.168.10.100/24
  Server       : 192.168.10.1  (pool lan)
  Gateway      : 192.168.10.1
  DNS          : 1.1.1.1
  Lease        : 600s
  Expires in   : 600s
```

The server table is the lease state the DORA run wrote, read back through
`dhcpLib.leaseTable()` — the same numbers the exchange produced, not a second opinion.

**A lease is the one thing in this lab that can run out, and now it does.** Ask at an instant past
the deadline and the binding is gone, the address is back in the pool, and a client that could not
renew is left honestly unaddressed. The setup matters: with the server reachable the client renews at
T1 (half the lease) and the binding never lapses, so an expiry needs a client that cannot reach its
server. A 60-second lease, with the cable pulled at `t=15s`:

```
SRV#show ip dhcp binding at 69000
DHCP at t=69000 ms (control planes rebuilt for this answer)
DHCP bindings on SRV:
  MAC                 IP               Pool          Expires in
  02:00:00:00:01:00   10.0.1.100       lan           1s

SRV#show ip dhcp binding at 70000
DHCP at t=70000 ms (control planes rebuilt for this answer)
DHCP bindings on SRV: (none)
1 lease expired at this instant - the address is back in the pool
```

The empty table now distinguishes the two ways it can be empty — `no client has completed an
exchange` and `N leases expired at this instant` — because only one of them means the lab is wrong.
The count survives re-asking the same instant, and `show ip dhcp pool` follows it: `In use : 0 of 21`.

`show ip dhcp pool` summarises the pools and how much of each range is in use:

```
SRV#show ip dhcp pool
DHCP pools on SRV:
  lan
    Network    : 192.168.10.0 / 255.255.255.0
    Range      : 192.168.10.100 - 192.168.10.110
    Router     : 192.168.10.1
    DNS        : 192.168.10.1, 1.1.1.1
    Lease      : 600s
    In use     : 1 of 11
```

`In use` counts the allocatable addresses (the range minus network/broadcast and exclusions), so
"1 of 11" means something. A device that is neither a server nor a client says so rather than
printing an empty table that looks like a bug.

A `host` line reserves an address for one MAC, and both the pool summary and the client's own view
say so — `Reserved : 192.168.10.110 for 02:00:00:00:01:00` in the pool table, and the reserved
address (not the first free one) on the client after a run:

```
SRV(config-dhcp)#host 192.168.10.110 02:00:00:00:01:00

PC1#show ip dhcp binding
DHCP lease on PC1/eth0:
  IP address   : 192.168.10.110/24
  Server       : 192.168.10.1  (pool lan)
  Gateway      : 192.168.10.1
  Lease        : 86400s
```

**A reservation outside the pool range silently disables the whole pool.** The validator knows —
`E_DHCP_RESERVATION_OUT_OF_RANGE: DHCP pool lan: reservation 192.168.10.200
(02:00:00:00:01:00) is outside the pool range 192.168.10.100-192.168.10.120.` — but nothing in the
console prints it, because the exchange skips a pool that fails validation instead of refusing. The
only symptom is a client that stays `unassigned` while the DHCP event blames the server's own
address: `the address of 192.168.10.1 is in none of the server pools`. That message is true and
points at the wrong line of your config. Keep every `host` address inside `range` and the pool keeps
working; put one outside and the pool disappears with no complaint on either console.

**A pool only serves the segment it is on.** A DISCOVER is a broadcast, bridges pass it and routers
stop it, and there is no relay agent (`ip helper-address` does not exist in this parser). A central
server with a pool for the far subnet therefore hands out nothing, and neither end claims success:
the client's `show ip dhcp binding` answers `% PC1 is not a DHCP server (no pools) and holds no DHCP
lease`, while the server's reads `DHCP bindings on SRV: (none - no client has completed an
exchange)`. A lab with clients on several subnets does **not** need a server on each: one server plus
`ip helper-address` on the routers in between is the normal arrangement — see
[DHCP relay](#dhcp-relay).

## DHCP relay

A DHCPDISCOVER is a broadcast, so it dies at the first router. That is why a lab built the obvious
way — one central server, clients on remote subnets — used to be impossible here: the client reported
`no-server` and stayed unaddressed, which reads like a misconfigured client rather than a missing
feature. `ip helper-address` is the fix, and it is now modelled:

```
R1#configure terminal
R1(config)#interface Gi0/0
R1(config-if)#ip helper-address 10.0.2.2
Helper address 10.0.2.2 on Gi0/0 (DHCP requests will be relayed to it)
```

The router on the client's wire unicasts the request to the helper and stamps **its own port address**
into `giaddr` — which is the whole point of the field, because the client's own address is useless to
a server that has never seen that subnet. The server then picks its pool by `giaddr`, not by its own
interface. Put a `/24` pool for `10.0.1.0/24` on a server living in `10.0.2.0/24` and the client on
the far side gets an address it can actually use:

```
PC1#show ip dhcp binding
DHCP lease on PC1/eth0:
  IP address   : 10.0.1.100/24
  Server       : 10.0.2.2  (pool remote)
  Gateway      : 10.0.1.1
  Relayed via  : Gi0/0 on R1  (giaddr 10.0.1.1)
  Lease        : 600s
  Expires in   : 600s
```

Both ends say how it happened. The server's binding table names the relay, because a binding whose
address belongs to a subnet the server has no interface on is otherwise inexplicable:

```
SRV#show ip dhcp binding
DHCP bindings on SRV:
  MAC                 IP               Pool          Expires in
  02:00:00:00:01:00   10.0.1.100       remote        600s

1 binding arrived through a relay: 10.0.1.100 via giaddr 10.0.1.1
```

And a relay asked about leases answers as a relay — it holds none, and "not a DHCP server (no pools)"
was true and useless:

```
R1#show ip dhcp binding
DHCP relay on R1:
  Gi0/0  ->  10.0.2.2

Requests heard on those ports are unicast to the server, with this port's address
as giaddr so the server allocates from the right subnet.
```

What is *not* modelled: the request is not re-broadcast on the server's wire, pool selection is a
plain subnet match on `giaddr` (no per-relay pool overrides), and there is no Option 82 — no
circuit-id, no remote-id. A helper address that no device in the lab owns is not an error at config
time and not a silent success at run time: the request is simply not relayable, so the client keeps
its honest `no-server`.

Refusals, because a typo must not silently clear a working relay:

```
R1(config-if)#ip helper-address
% Incomplete command: ip helper-address <addr>
R1(config-if)#ip helper-address 300.1.1.1
% Invalid helper address "300.1.1.1"
R1(config-if)#no ip helper-address 10.9.9.9
% No helper address 10.9.9.9 on Gi0/0 (set: 10.0.2.2)
```

`show running-config` emits the line under the port, so a pasted dump keeps the relay — a dump that
forgets it is worse than no dump, because it looks complete.

## Event log

Every protocol in this lab writes events — 25 separate drop sites, forwards, ARP and LLDP, STP
blocks, VLAN drops, PoE denials, DHCP exchanges, OSPF and BGP state changes, SCION hops, SLAAC
refusals. Until `show logging` existed, **nothing read them**: the console could tell you a ping
failed and never why, and the answer was in the event stream the whole time, reachable only from a
test.

The difference is easiest to see side by side. A ping that dies on an inbound ACL:

```
PC1#ping 10.0.9.9 count 1
Type escape sequence to abort.
Sending 1, 100-byte ICMP Echos to 10.0.9.9, timeout is 2 seconds:
.
Success rate is 0 percent (0/1)
Request timed out (seq 0)
PC1#show logging acl-deny
Event log (1 acl-deny events, from 13 in the lab):
  #   Step  Type      Device  Detail
  13  5     acl-deny  R1      on Gi0/0, src 10.0.1.10, dst 10.0.9.9, vlan 1, acl 101, dir in
```

Thirteen events, and the one that matters is the last: **R1 dropped it on `Gi0/0`, inbound, access
list 101.** The ping could only say "0 percent". This is the command that turns a failure into a
change.

`show logging` on its own is the whole log in order, compacted to the frame step each event happened
at:

```
PC1#show logging last 4
Event log (last 4 of 13 events):
  #   Step  Type       Device     Detail
  10  4     arp-cache  PC1        ip 10.0.1.1, vlan 1, mac 02:00:00:00:01:00
  11  4     forward    PC1        on eth0, via arp-resolved, vlan 1, mac 02:00:00:00:01:00
  12  5     frame      PC1 -> R1  from d1, to d2
  13  5     acl-deny   R1         on Gi0/0, src 10.0.1.10, dst 10.0.9.9, vlan 1, acl 101, dir in
```

Three things about that table are deliberate. The `#` column is the event's position in the log, so a
gap or a jump is visible immediately rather than being smoothed over. `Step` is the **frame hop**, not
a timestamp — see `show clock` below for why that distinction is stated rather than hidden. And a
`frame` has no single device (it is on the wire between two), so the Device column names the pair
rather than printing a dash.

Filters, because thirteen rows is fine and thirteen thousand is not:

The filters, and the question each one answers:

- `show logging drop` — every packet the lab threw away, with the reason
- `show logging acl-deny` — which policy stopped this, where, and in which direction
- `show logging device <name>` — one box's story
- `show logging last <n>` — the tail, for "it was working a minute ago"
- `show logging summary` — counts by type and by device, the aggregate view

Each one names the event type it filters on, so `show logging` + a wrong type answers with the types
that do exist rather than an empty table.

```
PC1#show logging summary
Event summary (13 of 13 events):
  Type         Events
  frame        5
  lldp         2
  acl-deny     1
  arp-cache    1
  arp-reply    1
  arp-request  1
  forward      1
  ping         1

  by device:
    Device  Events
    PC1     4
    R1      3
    (plus 6 link-level events with no single device - see the Device column in `show logging`)
```

The counts add up: the per-type column sums to the total, and the per-device column plus the
link-level line does too. A summary that does not reconcile is worse than no summary, and
`test/logging.test.js` asserts both sums.

### `show clock` — when is "now"?

There is no wall clock, and the console says so instead of inventing a plausible time:

```
PC1#show clock
t=0 ms - the lab is at rest (no instant asked)

This lab has no wall clock. A question may name an instant - `ping <dst> at 5000` -
and it sticks until `at converged` resets it. Events are ordered, not timestamped:
`show logging` reports the frame step each one happened at.
```

Ask at an instant and the clock reports it, which is the fastest way to confirm what `at` is currently
pinned to — the thing that used to be silent and therefore sticky:

```
PC1#ping 10.0.9.9 count 1 at 5000
PC1#show clock
t=5000 ms  (5 s) - the instant this lab was asked about
```

### Two ways the log can be empty, and only one is a problem

```
PC1#show logging
No events: the log is empty - nothing has run yet in this lab
Send a packet (`ping <dst>`) or run `converge`, then ask again.
```

`clear logging` truncates it (`Event log cleared (13 events dropped)`), is privileged like its IOS
counterpart, and refuses an argument it does not have. Asking for events *after* a clear is the other
common reason for an empty table, and the message distinguishes that from a lab where nothing has
happened.

`show logging` is lab-wide, like `links` and `show flows`: the event stream is the simulator's, so any
console sees the same timeline. A filter that matches nothing names what *is* there rather than
returning a blank table:

```
PC1#show logging nonsense
% No events of type "nonsense" in this lab
% Types seen: acl-deny, arp-cache, arp-reply, arp-request, forward, frame, lldp, ping
```

## Abbreviations

Every keyword may be abbreviated to any prefix that identifies exactly one command, which is the rule
IOS uses and the reason `sh ip int br` is the most-typed line in networking:

```
R1#sh ip int br
Interface  IP-Address  OK?  Method  Status  Protocol
Gi0/0      unassigned  YES  manual  up      up
Gi0/1      unassigned  YES  manual  up      up
Gi0/2      unassigned  YES  manual  up      up
```

Before this existed the console refused it outright — `% Unrecognized command: sh ip int br` — and
the only abbreviations that worked were `conf t` and `en`, hand-coded as aliases. A hand-written alias
list can never be complete, so this is a *rule* instead: the command tree is parsed out of `help`, so
a command is abbreviatable exactly when it is documented, and a new command becomes typable the
moment it has a help row (or a docs row the help guard demands).

An ambiguous prefix is refused **by name**, not guessed at — this is the difference between an
abbreviation and a bad autocomplete:

```
R1#sh l
% Ambiguous command: "sh l"
% Candidates: lldp, logging
```

A prefix that matches nothing is left completely alone, so a typo still says what it is:

```
R1#sh nosuchthing
% Invalid show command: nosuchthing
```

Four rules, and each one is a decision:

| Rule | Why |
|------|-----|
| a prefix matching one continuation is expanded | `sh` → `show`, `trac` → `traceroute`, `net` → `network` |
| a prefix matching several is refused with the candidates listed | guessing is worse than asking; the list is the fix |
| a prefix matching nothing changes nothing | abbreviation must never bend a typo into a real command |
| a keyword beats a value slot, and an exact match beats a longer keyword | `show ip route summ` is `summary`, and `int` stays the alias `int` rather than becoming `interface` |

**Values are never abbreviated.** A device named `links`, a description reading `route to core`, a
hostname that starts with `sh` — all pass through untouched, because abbreviation is about keywords,
not about the words an operator chose:

```
R1(config-if)#description route to core
Description set
R1#show running-config
 …
 description route to core
```

Abbreviation works in every mode and composes with `do`:

```
R1(config)#do sh ip int br
Interface  IP-Address  OK?  Method  Status  Protocol
 …same table…
```

The help rows themselves are the source, and the shapes in them carry meaning: `ipv6 nd ra
enable|disable` is one command with two endings (a tight bar shares the prefix), while
`interface <name> | int <name>` is two commands (a spaced bar separates them), and
`[at <ms>|converged]` is two alternatives inside a group. The parser reads that spacing, and
`test/abbrev.test.js` pins all three readings, because getting one wrong either invents a command or
loses one silently.

### `?` — asking what comes next

A trailing `?` answers a question about what you have already typed. It used to be an error about the
`?` itself:

```
R1#sh ?
% Unrecognized command: sh ?
```

which is the worst possible reply to a question — and it got worse when abbreviation landed, because
`sh ip int br` worked while `sh ip ?` did not. Now:

```
R1#sh ?
Completions for "sh" (19):
  Next            Meaning
  access-lists    entries, and where they are bound
  arp             IP-to-MAC cache
  clock           the instant this lab is being asked about
  dns             zones, records and resolvers
  etherchannel    LAGs and their members
  flows           conversations in this lab, and per-device counters
  interfaces      more options
  ip              more options
  ipv6            more options
  lldp            what announced itself on each port
  logging         why something happened - drops, forwards, protocol events
  mac             addresses learned per port and VLAN
  power           PoE budget and which ports are powered
  running-config  the whole configuration, pasteable
  scion           more options
  spanning-tree   root bridge, port roles and states
  version         model, vendor and software
  vlan            VLANs and their members
  vrrp            groups, priorities and current state
```

Three things in that table are decisions rather than formatting:

- **`more options`** marks a subtree. `ip` does not mean "address and link state per port" — that is
  one of its six children — so a word several commands lead through says so instead of borrowing the
  first description that happened to be handy.
- the list is exactly the **documented** subtree: it comes from the same parsed help tree that
  abbreviation uses, so a completion can only ever offer a command that exists. `test/
  completion.test.js` types every offered keyword back at the parser and requires none of them to be
  refused as unrecognised.
- an **exact keyword closes the position**: `show ip` means `ip`, never `ipv6`. That is why there is
  no `nd` under `show ip` (`nd` is `show ipv6 nd`) and why each entry has one meaning.

Each level narrows, as it should:

```
R1#show ip ?
Completions for "show ip" (6):
  Next       Meaning
  bgp        peers and installed prefixes
  dhcp       more options
  interface  more options
  nat        more options
  ospf       process, interfaces, adjacencies
  route      more options
```

When every completion belongs to one command, its description appears once and the endings are listed
together — eight spellings of the same thing do not need eight copies of its sentence:

```
R1#show ip route ?
Completions for "show ip route" (8, and this form ends here):
  the table, a lookup, a protocol filter, or an instant

  Next: at, bgp, connected, converged, ospf, static, summary, <dest>

Names in angle brackets are values: type one, then ask ? again for what follows it.
```

Values appear as their placeholder and say what to do next, because "type an address, then ask again"
is the useful answer. It works in every mode, and through `do`:

```
R1(config-if)#ip ospf ?
Completions for "ip ospf" (3):
  per-port OSPF cost, area, or make it passive

  Next: area, cost, passive
```

Completion **answers, it does not act**: nothing is inserted and no packet moves, which is honest
about a console with no line editor. A question with no answer says so and names the fallback:

```
R1#sh nosuch ?
% No completions for "sh nosuch"
% Type ? on its own for every command this mode accepts
```

### The `?` goes against the word

A space before the `?` asks *what may follow these words*. No space asks *what this word can be* — and
that is the form the key is actually typed in:

```
R1#sh st?
Completions for "sh st" (1, completing "st"):
  Word            Meaning
  startup-config  the saved copy, then what the running config changed

R1#show ip?
Completions for "show ip" (2, completing "ip"):
  Word  Meaning
  ip    more options
  ipv6  more options

R1(config)#no ip rou?
Completions for "no ip rou" (1, completing "rou"):
  Word   Meaning
  route  remove one, or all with that prefix

  Then: <dest>
  A name in angle brackets is a value: type one, then ask ? again for what follows it.
```

The stem is read as an **abbreviation**, so `sh st?` works and `conf t?` offers both `terminal` and the
alias's own `t`. `show ip?` offering `ipv6` as well is not noise: `ip` is a prefix of `ipv6`, and this
console accepts prefixes everywhere, so both readings really are open. When everything that fits agrees
on what comes after the completed word, `Then:` says so and saves the next keystroke.

Both forms used to be refused — `show ip?` answered `% Invalid show command: ip?`, as if the `?` were
part of the word. The spaced form at a word that ends the command now says so instead of printing an
empty table, and points at the other form:

```
R1#sh st ?
"sh st" is as far as this command goes - nothing follows it
% To complete the word you are typing, put the ? against it: "sh st?"
```

**A `?` that belongs to the text is escaped.** A trailing `?` is always a question, so a description
that ends in one needs the way out a real console needs Ctrl-V for:

```
R1(config-if)#description ready?
% Nothing after "description" starts with "ready"
% Ask ? on its own for the words that can follow it
% To write a literal "?" instead of asking, end the line with \?

R1(config-if)#description ready\?
Description set

R1(config-if)#description up? or down
Description set
```

Only the **trailing** character is a question. A `?` in the middle of free text is just text, which is
why the third form above needs no escape at all.

Building this exposed a defect in the help text rather than in the code: `ip ospf cost <n> | area <id>
| passive` used a spaced bar for what is really a shared prefix, so `area` and `passive` were being
read as commands in their own right. The rule the parser relies on — and which the test sweep now
enforces — is that a **tight** bar joins alternatives sharing everything before them (`link up|down
<id>`, `switchport mode access|trunk`) while a **spaced** bar separates two complete commands
(`interface <name> | int <name>`). Sixteen help rows that had no description at all were given one at
the same time, because a blank `Meaning` column is a hole in the help, not a formatting quirk.

## VRRP (first-hop redundancy)

A group belongs to an interface, so the commands live inside `interface`:

```
interface Gi0/0
  ip address 10.0.0.1 255.255.255.0
  vrrp <vrid> ip <virtual-address>
  vrrp <vrid> priority <1-255>        # 255 = address owner; 100 default
  vrrp <vrid> advertise <seconds>
  vrrp <vrid> preempt                 # default on
  no vrrp <vrid> preempt
  no vrrp <vrid>                      # remove the group
```

`show vrrp` reports the state after the last election:

```
R1#show vrrp
Interface     Group  Pri  State      Master      Virtual IP      Virtual MAC
Gi0/0         10     150  Master     R1          10.0.0.254      00:00:5e:00:01:0a
```

Before any run has happened there is nothing to report and the table says so instead of inventing a
master: the state reads `Backup`, the virtual MAC is `-`, and a line under the table adds
`(no group holds its address yet - run a simulation)`. A configured group is not a resolved one.

Two things about that table cost time if you read them the obvious way, both measured on a pair of
routers sharing group 1:

- **The `Master` column is this device's own name**, on every row, master or not. The peer is never
  named, so a backup row reads `Backup  R1` and looks self-contradictory. `State` is the answer;
  `Master` is a label.
- **`(no group holds its address yet …)` also appears on a healthy backup.** The line is keyed on
  whether *this* device won, not on whether the group is up, so the router that lost still prints it
  long after the election — the address is held, by the other box. Read it as "nothing here holds
  it", and check the peer's console for the `Master` row.

With equal priorities (both default 100) the **higher interface address** wins: on a
`10.0.12.1`/`10.0.12.2` pair, `10.0.12.2` becomes master and the virtual MAC `00:00:5e:00:01:01`
appears only on that row. Set `vrrp <vrid> priority` above 100 to choose deliberately.

The election runs before the first packet of a run. A master whose interface is down relinquishes,
the backup takes over, and the virtual MAC does not change — which is the point. See
[SIMULATION.md §5.4](SIMULATION.md) and [CONVERGENCE.md](CONVERGENCE.md) for the master-down timing.

## Cables

A cable is not owned by a device, so these are accepted from any console in the lab.

```
links                              # every cable, its ends and its state
link down <linkId> [at <ms>]       # pull it: frames die, STP rebuilds, tables flush
link up   <linkId> [at <ms>]       # put it back
link state <linkId>                # what it is now, and since when
```

`at <ms>` is when the change happens, in milliseconds since power-on, so a script can say "the
uplink fails at 10 s" and then ask what the network looks like at 11 s. The command prints when the
network converges again. See [LINK-STATE.md](LINK-STATE.md).

### Transceivers — what is in the bay, and will the light arrive

A cable that mates is not a cable that works. `validation.js` refuses a bad mate outright, but an
over-long run is only a warning (`W_DISTANCE`), so a lab can hold a link whose light never arrives
and, until this command, nothing in the console said so.

```
R1#show interfaces transceiver
R1 transceivers (8 cage ports):
  1 link exceeds the reach of its medium: the cable mates, but the light will not make it. W_DISTANCE is a warning, not a refusal.
  Port     Cage  Medium      Rate  Reach  Length  Verdict
  smm10g1  sfp+  10GBASE-SR  10G   300 m  1.2 km  W_DISTANCE: 1.2 km > 300 m reach
  smm10g2  sfp+  -           10G   -      -       not cabled
  smm10g3  sfp+  -           10G   -      -       not cabled
```

The verdict is the code `validateLink()` produced for that cable — one authority, two doors — and the
warning leads the table because it is the reason to read the numbers. An uncabled port says
`not cabled`, and a cable whose length nobody declared says `reach unchecked (no cable length)`
rather than guessing.

One thing this does **not** mean: an over-length link still carries every packet perfectly. Length
feeds latency and this warning, and nothing else, so `W_DISTANCE` is a cable you would not build in
the field rather than a link that drops frames — [SIMULATION.md §6.6](SIMULATION.md) says so from the
fidelity side.

Naming one port gives the whole physical record:

```
R1#show interfaces transceiver smm10g1
smm10g1 (ethernet, sfp+) - transceiver
  cage         : sfp+
  rate         : 10G
  optics       : 18 for this cage (SFP-10G-SR, SFP-10G-LR, SFP-10G-ER, ...)
  link         : l3 -> R2/Te0/0/0 (up)
  medium       : 10GBASE-SR (fiber, lc, 850 nm)
  reach        : 300 m
  length       : 1.2 km
  verdict      : W_DISTANCE: 1.2 km > 300 m reach
```

Only module bays are listed. That is not "not copper": an antenna, a coax spur and a console socket
are all non-copper cages with nothing to plug in, so the test is what the cage can carry — fibre,
fibre-channel and twinax are modules; copper, coax, console and wireless are not. A cage with no
catalogued optic still appears (a Brocade `fc-sfp28` has 24 of them) and its detail line says
`none catalogued - this cage is described by its rate class` instead of inventing a part number.
The port may be named in any spelling the resolver knows ([Port names](#port-names)), and an
unknown one is refused with the list of bays rather than a table of everything.

## Flows

A flow is one conversation, not a probe. It is opened from the device it starts on, and — like a
cable — it is lab-wide state once it exists, so the reading commands work from any console:

```
flow open <dst> [port <n>] [bytes <n>] [proto tcp|udp] [sport <n>]
flow close <id>
show flows                     # every conversation still in the table
show flows <id>                # one of them, in full
show flows counters            # per-device bytes, packets, opened and refused
```

Defaults are `port 80`, `bytes 1000`, `proto tcp`, and an ephemeral source port. `at <ms>` opens the
conversation as the network was at that instant (and `at converged` goes back to the default, exactly
as for `ping`). `flow open` prints the record it created, because the interesting part is the detail —
the handshake, the segmentation and the MSS the path allowed, not just "ok":

```
PC1#flow open 10.0.2.20 port 80 bytes 5000
Flow flow-1 opened: tcp 10.0.1.10:49152 -> 10.0.2.20:80, established
  5000 bytes in 4 segments, 11 packets on the wire, MSS 1460 (MTU 1500)
  (show flows flow-1 for the record)
```

A refusal is an answer with a reason, not silence. The code is the one the data path produced, so
"nothing is listening" and "there is no route" read differently — they are different failures. And
when the reason is that a control plane has not finished, the pending process is named, because "no
response" from an address whose owner has not been elected yet looks exactly like a dead server:

```
PC1#flow open 10.0.2.20 port 9 bytes 10
% flow refused (E_REFUSED): connection refused: nothing listening on 10.0.2.20:9
% the timeline says why - try show flows, or ping 10.0.2.20

PC1#flow open 192.0.2.99 port 80
% flow refused (E_NO_ROUTE): no route to 192.0.2.99
% the timeline says why - try show flows, or ping 192.0.2.99
```

That second line is printed on **every** refusal that is not a convergence wait, including
`E_NO_ROUTE` — where it is not helpful, because the answer is in the route table rather than the
timeline. It is a hint, not a diagnosis: read the refusal code first.

And in a lab where two routers share a virtual IP (`vrrp 1 ip 10.0.1.100`), asking before the
election has finished says which process is not ready, instead of leaving "no response" to be
misread as a dead server:

```
PC1#flow open 10.0.1.100 port 22 at 0
% flow refused (E_UNREACHABLE): no response from 10.0.1.100:22
% yet: vrrp on R1 still converging (ready at 3218.75 ms), vrrp on R2 still converging (ready at 3609.375 ms)
% try again after that, or ask at an instant with "at <ms>" (and "at converged" to go back)
```

At t=0 nobody has been elected to answer for the VIP. A flow and a ping agree about this —
`openFlow()` runs the same control planes `ping` does, in the same order (see
[CONVERGENCE.md](CONVERGENCE.md)) — which they did not always: VRRP and DHCP were missing from the
flow path, so a flow to a VIP failed on a fresh lab while a ping to the same address succeeded.

`flow close` runs what the protocol has: a four-way close for TCP (the packet count grows by FIN,
FIN-ACK, ACK), nothing at all for UDP. Closing twice is not an error:

```
PC1#flow close flow-1
Flow flow-1 closed: closed, 5000 of 5000 bytes delivered
PC1#flow close flow-1
Flow flow-1 closed: closed, 5000 of 5000 bytes delivered (already closed)
```

The heading separates three numbers that are easy to confuse, because a refused conversation is
counted and then dropped:

```
R1#show flows
Flows in this lab (2 recorded, 3 opened, 1 refused):
  Id      Proto  Source           Destination   State        Payload  Segs  Pkts  Opened
  flow-1  tcp    10.0.1.10:49152  10.0.2.20:80  established  5000     4     11    step 4
  flow-2  udp    10.0.1.10:49152  10.0.2.20:53  open         100      1     1     step 4
```

`2 recorded` is what is still in the table, `3 opened` counts the attempts that put a SYN or a
datagram on the wire, and `1 refused` counts the one a closed port turned away — its record is
deleted, so `recorded < opened` is the normal trace of something having been refused, not a fault.
`Opened` is a **step**, the simulator's own logical tick, not a wall-clock time.

`show flows flow-1` is the record in full — both ends resolved to device names, the state and whether
it is still open, the segmentation the payload produced, the MSS and MTU it was sized against, and
the egress port:

```
R1#show flows flow-1
Flow flow-1 (tcp):
  Source        10.0.1.10:49152  (PC1)
  Destination   10.0.2.20:80  (WEB)
  State         established  (still open)
  Payload       5000 bytes in 4 segments, 11 packets on the wire
  Delivered     5000 bytes
  MSS           1460   MTU 1500
  Egress        eth0
  Opened        step 4
```

`show flows counters` is the per-device half — the same numbers `engine/flow.js` counts as each
frame crosses an interface, sorted by how much traffic the device carried:

```
R1#show flows counters
Flow counters in this lab:
  Device  Bytes in  Bytes out  Packets in  Packets out  Opened  Refused
  R1          5100        5100        14           14           0        0
  PC1         0           5100        6            8            3        1
  WEB         5100        0           8            6            0        0
```

`Bytes in 0` for PC1 is not a bug: acknowledgements are packets without payload, so a sender
receives packets and no bytes — which is exactly why the two columns are separate.

## VLANs

Config mode declares the VLANs a lab uses; interface mode decides which ports carry them.

```
vlan <id>                    # create VLAN; any trailing text becomes its name
no vlan <id>                 # delete it
interface Fa0/1              # switch port
  switchport mode access
  switchport access vlan 20
interface Fa0/2              # uplink
  switchport mode trunk
  switchport trunk native vlan 99
  switchport trunk allowed vlan 10,20,30-32
no switchport                # reset a port to access VLAN 1
```

`vlan <id> [name]` reports what it did, and the second word is the name:

```
SW1(config)#vlan 30 SALES
VLAN 30 created (name: SALES)
SW1(config)#vlan 30
VLAN 30 already configured (name: SALES)
SW1(config)#vlan abc
% VLAN id must be a number, not "abc"
% Usage: vlan <id> [name]
SW1(config)#vlan 4095
% VLAN 4095 is outside 1-4094
```

`no vlan <id>` is a promise, so it refuses the two cases where it would be a lie — a VLAN that is
not there, and a VLAN a port is still in:

```
SW1(config)#no vlan 99
% No VLAN 99 on SW1 - nothing is configured for it and no port carries it
% "show vlan" lists the VLANs this device has
SW1(config)#no vlan 30
% VLAN 30 is carried by Fa0/1 - it cannot be removed while those ports are in it
% Move them first, e.g. "switchport access vlan <other>" in each interface block
```

Move the port and the removal is real, and says what it removed:

```
SW1(config)#interface Fa0/1
SW1(config-if)#switchport access vlan 1
SW1(config-if)#exit
SW1(config)#no vlan 30
VLAN 30 removed (was named SALES)
SW1#show vlan
VLAN  Name      Status  Ports
1     VLAN0001  active  Fa0/1, Fa0/2, Fa0/3, Fa0/4, Fa0/5, Fa0/6, Fa0/7, Fa0/8
```

A trunk is a **different dependency** from an access port, and the two are not folded together. A
trunk whose *native* VLAN is the one being removed cannot lose it (untagged frames would have nowhere
to land), so that blocks the removal and the port is marked `(native)`. A trunk that merely lists the
VLAN in its allowed list goes on without it, so the removal prunes the list and says so:

```
SW1(config)#interface Fa0/8
SW1(config)#switchport mode trunk
Switchport mode trunk on Fa0/8
SW1(config)#switchport trunk native vlan 30
Trunk native VLAN 30 on Fa0/8
SW1(config)#exit
SW1(config)#no vlan 30
% VLAN 30 is carried by Fa0/8 (native) - it cannot be removed while those ports are in it
% Move them first, e.g. "switchport access vlan <other>" in each interface block
```

```
SW1(config)#switchport trunk allowed vlan 10,30
Trunk on Fa0/8 allows VLANs 10,30
SW1(config)#exit
SW1(config)#no vlan 30
VLAN 30 removed (was named VLAN0030)
  Fa0/8: VLAN 30 removed from the allowed list
SW1#show vlan
VLAN  Name      Status  Ports
1     VLAN0001  active  Fa0/1, Fa0/2, Fa0/3, Fa0/4, Fa0/5, Fa0/6, Fa0/7
10    VLAN0010  active  Fa0/8(t)
```

A device that does not bridge — a router — may still **declare** a VLAN (its `show running-config`
carries the line and `interface Vlan99` sits in it), but it has no port membership to report, so the
Ports column holds `-` instead of inventing a bridge domain that contains every router port:

```
R1#show vlan
VLAN  Name   Status  Ports
1     VLAN0001  active  -
99    users     active  -
```

`show vlan <id>` and `no vlan <id>` read **one** membership walk (`_vlanMap()`), so the ports a
refusal names are exactly the ports the table lists — see `test/vlan-lifecycle.test.js` (43
assertions), which also proves the domain is real by pinging across it and then separating the hosts
by moving one port.

### `switchport` — a membership, and a `no` form as narrow as the command

The switchport verbs sit one level below the VLAN verbs, and had the same defect one level down: a
VLAN id was read with `parseInt` and used whatever came out.

```
SW1(config-if)#switchport access vlan abc
% VLAN id must be a number, not "abc"
% Usage: switchport access vlan <id>
SW1(config-if)#switchport access vlan 10 20
% Unexpected argument "20" - switchport access vlan <id> takes no more
% Usage: switchport access vlan <id>
SW1(config-if)#switchport
% Incomplete command: switchport mode access|trunk
% Also: switchport access vlan <id> | switchport trunk native vlan <id> | switchport trunk allowed vlan <list|all>
```

`switchport access vlan abc` used to answer **`Access VLAN NaN on Fa0/1`** — a confirmation for a
VLAN that does not exist — and `switchport access vlan` with no value answered the same thing.
An out-of-range id used to leak the data-model field name (`% accessVlan 9999 is outside 1-4094`), and
a word after the mode (`switchport mode trunk access`) was dropped without a word.

A `no` form is now **as narrow as the command it undoes**. Every `no switchport …` used to become a
full port reset, so a one-VLAN removal wiped the mode, the native VLAN and the access VLAN:

```
SW1(config-if)#switchport mode trunk
Switchport mode trunk on Fa0/1
SW1(config-if)#switchport trunk native vlan 99
Trunk native VLAN 99 on Fa0/1
SW1(config-if)#switchport trunk allowed vlan 10,20,30
Trunk on Fa0/1 allows VLANs 10,20,30
SW1(config-if)#no switchport trunk allowed vlan 10
Trunk on Fa0/1: removed 10, still allows 20,30
```

`show running-config` afterwards is `switchport mode trunk`, `switchport trunk native vlan 99`,
`switchport trunk allowed vlan 20,30` — the trunk is still a trunk, which is the whole point: a full
reset would have taken it away. `no switchport mode` returns to access *without* touching the access
VLAN; `no switchport access vlan` reports what it replaced (`(the default, was VLAN 30)`); and only a
bare `no switchport` is a reset. Removing a VLAN from a trunk that allows *all* is refused, because
the model has no way to say "all but 10":

```
SW1(config-if)#no switchport trunk allowed vlan 5
% The trunk on Fa0/1 allows all VLANs - there is no list to remove 5 from
% Give it an explicit list first: "switchport trunk allowed vlan <list>"
```

A port that cannot be a switchport says so instead of storing the setting:

```
R1(config-if)#switchport access vlan 10
% R1 does not switch - it has no switchports
% Its ports are routed sockets: put the address on the port with "ip address"
SW1(config-if)#switchport access vlan 10          (on Vlan10)
% Vlan10 is a logical interface - it is not a switchport
% An SVI is the VLAN's own address, not a member of it: configure the member ports
```

A trunk with no explicit allowed list carries **everything**; `switchport trunk allowed vlan all`
says so again. A list is accepted as ids and ranges (`10,20,30-32` is echoed back as
`10,20,30,31,32`), and an id outside 1–4094 is refused.

`show vlan` marks trunk ports with `(t)`, and `show vlan brief` is accepted as a synonym — it
prints the same table, because there is only one table.

```
SW1#show vlan
VLAN  Name      Status  Ports
1     VLAN0001  active  Fa0/3, Fa0/4, Fa0/5, Fa0/6, Fa0/7, Fa0/8
10    VLAN0010  active  Fa0/2(t)
20    VLAN0020  active  Fa0/1, Fa0/2(t)
30    VLAN0030  active  Fa0/2(t)
```

### Router subinterfaces (one-armed routing)

```
interface Gi0/0.20           # creates the subinterface on Gi0/0
  encapsulation dot1q 20     # 802.1Q tag this subinterface carries
  ip address 10.20.0.1 255.255.255.0
no interface Gi0/0.20        # delete the subinterface (config mode)
```

`encapsulation dot1q` is refused on a physical interface — it is only meaningful on a
`<parent>.<vlan>` subinterface — and the tag must be a VLAN id. The parent becomes a trunk so the
tagged frames arrive at all.

End to end it works, and it is worth seeing once because the failure mode when a piece is missing is
silence. Two VLANs on a switch, one access port each, the trunk to a router with a subinterface per
VLAN — two hosts on separate subnets ping each other through the router:

```
SW1(config)#vlan 10 LAB
SW1(config)#vlan 20 SERVERS
SW1(config)#interface Fa0/1
SW1(config-if)#switchport mode trunk
SW1(config-if)#switchport trunk allowed vlan 10,20
SW1(config-if)#interface Fa0/2
SW1(config-if)#switchport mode access
SW1(config-if)#switchport access vlan 10
SW1(config-if)#interface Fa0/3
SW1(config-if)#switchport mode access
SW1(config-if)#switchport access vlan 20

R1(config)#interface Gi0/0.10
R1(config-if)#encapsulation dot1q 10
R1(config-if)#ip address 10.10.0.1 255.255.255.0
R1(config-if)#interface Gi0/0.20
R1(config-if)#encapsulation dot1q 20
R1(config-if)#ip address 10.20.0.1 255.255.255.0

PC10#ping 10.20.0.20
Type escape sequence to abort.
Sending 4, 100-byte ICMP Echos to 10.20.0.20, timeout is 2 seconds:
!!!!
Success rate is 100 percent (4/4)
Reply from 10.20.0.20: bytes=100 time=0.307 ms
```

The router's own view is the check that the tagging landed: the subinterfaces appear in `show ip
interface brief` beside the parent (`Gi0/0.10   10.10.0.1/24  YES  manual  up  up`, with `Gi0/0 /
unassigned`), and `show ip route` carries both as connected — `C 10.10.0.0/24` out `Gi0/0.10`
and `C 10.20.0.0/24` out `Gi0/0.20`. If the trunk is missing an allowed VLAN the ping stops
and nothing else complains: the access port still shows the VLAN as active in `show vlan brief`, and
the subinterface still shows `up`. The tag is checked on the wire, not in the config.

## Link aggregation

```
interface Fa0/3
  channel-group 1 mode static     # active|passive|on|static are all accepted
no channel-group                  # remove this port from any group
```

`show etherchannel` (and `show etherchannel summary`) lists groups and member state:

```
SW1#show etherchannel
Group  Protocol  Ports
1      static    Fa0/3(P) Fa0/4(P) Fa0/5(P)
```

With nothing configured it says so — `% No link aggregation groups configured` — rather than printing
a header over an empty table.

**The `(P)` marker is not a health check.** It means the port is a bundle member, and it stays
there whether the member's cable is up or not: pull one of two members and the table still reads
`1      static    Fa0/1(P) Fa0/2(P)`, with traffic continuing to cross the remaining link (measured
`4/4` before and after). Pull both and the bundle carries nothing (`0/4`) while the table looks
exactly the same. `links` is where a dead member shows up, as `down` on its own row; `show
etherchannel` answers "what is bundled", never "what is passing".

### One vocabulary, translated once

The console says `active|passive|on`; the LAG validator in `engine/lag.js` says
`lacp-active|lacp-passive|static`. Those used to be two vocabularies with nothing between them, and
the seam showed on **every single use** of the command:

```
SW1(config-if)#channel-group 1 mode active
Interface Fa0/1 added to channel group 1 (mode active)
% Warning: LAG lag1: unknown mode "active" (expected one of lacp-active, lacp-passive, static).
```

The word went into the configuration verbatim, and the validator then rejected the bundle with
`E_LAG_BAD_MODE` — while `mode lacp-active`, the spelling that *would* validate, was refused by the
parser. So the console could not build a valid LACP bundle at all, and said so in a warning about its
own vocabulary on the way. One table now translates, and both the command and the table read it:

```
SW1(config-if)#channel-group 1 mode active
Interface Fa0/1 added to channel group 1 (LACP active)
SW1(config-if)#channel-group 2 mode on
Interface Fa0/6 added to channel group 2 (static)
SW1#show etherchannel
Group  Protocol     Ports
1      LACP active  Fa0/3(P) Fa0/4(P) Fa0/5(P)
2      static       Fa0/6(P)
```

`active` → `lacp-active`, `passive` → `lacp-passive`, `on` → `static`, and the library spellings are
accepted too, so a configuration written by the API and one written at the console mean the same
thing. The `Protocol` column prints `LACP active`, `LACP passive` or `static` — never the stored
identifier, and never a word the bundle was not configured with.

A bundle is **one logical link**, and the spanning tree proves it: with a bundle over `Fa0/7` and
`Fa0/8`, `show spanning-tree` lists a single port named `lag-1`; without one, the same lab lists
`Fa0/7` and `Fa0/8` separately. Both members carry frames (check `show interfaces counters`).

```
SW1(config-if)#channel-group abc
% Channel group id must be a number, not "abc"
% Usage: channel-group <id> mode active|passive|on
SW1(config-if)#channel-group 2 mode
% Incomplete command: channel-group 2 mode active|passive|on
SW1(config-if)#no channel-group 9
% Fa0/6 is not in channel group 9
% "show etherchannel" lists the groups and their member ports
```

`no channel-group <id>` removes the port from **that** group and says what is left
(`Removed Fa0/1 from channel group 1 (1 port left)`, or `- the group is gone` when it was the last
member); a bare `no channel-group` removes the port from whatever group holds it and names it, or
says `Fa0/1 is not in any channel group - nothing to remove`. It used to answer "Removed … from any
channel group" even for a group the port had never joined.

### `description` writes what it says

```
SW1(config-if)#description
% Incomplete command: description <text>
% To clear a description: "no description"
SW1(config-if)#description uplink to core
Description set on Fa0/6: "uplink to core"
SW1(config-if)#no description
Description cleared on Fa0/6 (was "uplink to core")
```

`description` with nothing after it used to answer **`Description set`** — a confirmation that wrote
an empty string, i.e. cleared the description it claimed to have set — and `no description` printed
nothing at all, so a clear and a typo looked the same. The echo also names the port, because "set"
alone did not say which one on a device full of blocks.

## Access control lists

Config mode builds the list; interface mode binds it to a direction.

```
access-list 10 permit 10.0.0.0 0.0.0.255     # 1-99: standard (source only)
access-list 10 deny any
access-list 101 permit tcp any any eq 80     # 100-199: extended (protocol + ports)
access-list 101 deny ip any any

interface Gi0/0
  ip access-group 101 in                     # in | out
  no ip access-group 101 in                  # unbind one direction
  no ip access-group                         # unbind both directions
```

**The `no` form lives in interface mode too.** `no ip access-group` typed at the config prompt is
refused (`% Unrecognized config command`), because the binding it removes belongs to an interface.

`no access-list <number>` deletes the whole list; `no access-list <number> <entry>` removes that
one entry. The distinction is the operator's: the second form used to delete the entire list and
answer `Access list 101 removed`, which discarded every other line while looking like success.

```
R1(config)#no access-list 101 permit tcp any host 10.0.1.6 eq 80
Access list 101: removed "permit tcp any host 10.0.1.6 eq www" (2 left)
R1(config)#no access-list 101 permit ip any any
% Access list 101 has no entry "permit ip any any"
% Entries: 1) permit tcp any host 10.0.1.5 eq 80  2) deny ip any any
```

An entry is matched by what it **means**, not how it was typed: `eq 80` and `eq www` both parse to
port 80, and `host 10.0.1.6` and `10.0.1.6 0.0.0.0` are the same address, so either spelling
removes the entry the table shows. An entry that is not there is refused and the list is printed,
because an entry you cannot find is usually an entry you misremembered. Removing the last entry
deletes the list and says so — `the list is now empty and was deleted` — rather than leaving an
empty list behind.

`no ip access-group [<acl>] [in|out]` unbinds a list from the interface: with a number and/or
direction it clears only the matching bindings (and refuses a number that is not bound), with no
arguments it clears both directions, and it says what it removed
(`Interface Gi0/0: removed access list binding (out)`).

```
R1#show access-lists
Extended IP access list 101
  1 permit tcp any any eq 80
  2 deny ip any any
    applied IN on Gi0/0
```

Both directions really filter transit traffic — bound `in` on the ingress port or `out` on the
egress one, a denied flow never reaches the far end. What the console tells you differs by command,
and the difference is worth knowing before you debug the wrong thing:

```
PC1#flow open 10.0.2.20 port 80
% flow refused (E_ACL_DENY): denied by access list 101 in Gi0/0 on d1
% the timeline says why - try show flows, or ping 10.0.2.20

PC1#ping 10.0.2.20
Type escape sequence to abort.
Sending 4, 100-byte ICMP Echos to 10.0.2.20, timeout is 2 seconds:
....
Success rate is 0 percent (0/4)
Request timed out (seq 0)
```

A flow names the list, its number, the direction and the port it was bound to. A **ping says none of
that** — it times out exactly as it would with the cable out, so an ICMP-denying ACL is invisible
from the ping itself and has to be found in the event log or by reading the config back.

Two details in the refusal line: the device is shown by its **id** (`on d1`), not its hostname, and
the hint after it is a hint — `try … ping` on a flow that was denied as ICMP would send you to a
command that cannot confirm anything.

**A malformed `access-list` line answers `% [object Object]`.** Measured on three different mistakes
— a bad action (`permitx`), an unknown protocol (`bogus`) and an out-of-range port (`eq 99999`) —
the console prints the parser's error object instead of its message, and `no access-list 101 99`
(a sequence number that does not exist) does the same. The list is left untouched, so nothing is
corrupted, but the reason is swallowed: you cannot tell a typo in the action from one in the port
by reading the console. Until that is fixed, the reliable check is `show access-lists` to see what
actually landed, and the codes the parser does produce (`E_ACTION`, `E_PROTOCOL`, `E_PORT`) are the
ones in the [refusal-code appendix](#refusal-codes-the-ones-you-will-actually-meet). This is a live
defect, not a documentation gap, and it is listed in `docs/SIMULATION.md` §10.

## NAT — configured in the topology, not the CLI

**There is no `nat` configuration command.** `ip nat inside source list …` is answered with
`% Unrecognized config command`, and the UI has no NAT panel. The engine is not missing the
feature — `engine/nat.js` implements static, dynamic and PAT, and the simulator translates before
routing on the way in and after routing on the way out — but the table is read from the device
config, so today you set it in the topology JSON:

```json
{ "config": { "nat": { "rules": [
  { "type": "pat",    "insideLocal": "10.0.0.0/24", "insideGlobal": "203.0.113.5",
    "protocol": "any", "port": null, "acl": null },
  { "type": "static", "insideLocal": "192.168.1.10", "insideGlobal": "203.0.113.10",
    "protocol": "tcp", "port": 8080 }
] } } }
```

Fields, as `engine/nat.js` reads them:

| Field | Values |
|---|---|
| `type` | `static` (one-to-one, both directions), `dynamic` (first free address from a pool), `pat` (many inside locals on one global address, told apart by source port) |
| `insideLocal` | an address, a prefix (`10.0.0.0/24`), a range (`x-y`) or `any` |
| `insideGlobal` | the translated address (a pool spec for `dynamic`) |
| `protocol` | `tcp`, `udp`, `icmp`, `any` or a number — but read the note below before writing an `icmp` rule: no ICMP packet ever reaches the NAT stage in this engine |
| `port` | pins the translated port — this is what port forwarding is; `null` forwards every port |
| `acl` | an address allow-list, or an ACL name the ACL stage has already applied. A token that is not an address is **ignored**, not treated as deny-all |

`portForwards` is accepted alongside `rules`, and the older `config.natRules` array is still read.
Both examples above work as written: the PAT rule turns `10.0.0.9:51000 → 198.51.100.7:443` into
`203.0.113.5:1024 → 198.51.100.7:443` and the return packet comes back to `10.0.0.9:51000`; the
static rule turns an inbound `→ 203.0.113.10:8080` into `→ 192.168.1.10:8080`.

Two things worth knowing: PAT allocates the translated source port from **1024 upward**, so it does
not preserve the original; and a packet the table cannot translate is dropped with a `nat-drop`
event carrying a code and message, rather than passing untranslated.

A third, and the one that costs people an afternoon: **ICMP is never translated.** The NAT stage
only sees frames that carry a transport header, and an echo request has none, so a `ping` across a
NAT box is handed to the routing table as if NAT were not configured. Measured: with the PAT rule
above, `ping 203.0.113.9` from `192.168.1.10` succeeds 4/4, `show ip nat translations` stays empty,
and nothing appears in the event log — not even a drop. Use a flow to test NAT (`ping` will happily
prove the opposite of what you meant), then read the table.

### Reading what the data path did

The rules are topology-only, but the *result* is readable from the console:

```
R1#show ip nat translations
NAT translations on R1:
Pro  Inside global     Inside local        Outside local   Outside global  Type
tcp  203.0.113.1:1024  192.168.1.10:49152  203.0.113.9:80  203.0.113.9:80  pat
udp  203.0.113.1:1025  192.168.1.10:49152  203.0.113.9:53  203.0.113.9:53  pat
```

Entry for entry this is the table the packet path wrote — the `insideGlobal`/`globalPort` pair in
the row is the one the `nat-outbound` event carried — not a replay of the rules. `Outside local`
and `Outside global` hold the same address because this model has no outside translation, which is
also what IOS prints when it does not.

The columns are measured from the data rather than typed at a fixed width, and the rows come from
`nat.js` — the same rows the API and the UI render, through `engine/table.js`. `test/nat-show.test.js`
asserts the console's row and `formatTable()`'s row are character-for-character identical, because a
table that two code paths believe they are printing is exactly how the `Type` column once ended up
needing a hand-computed offset.

`show ip nat statistics` answers the other question — configured, or merely idle:

```
R1#show ip nat statistics
NAT statistics on R1:
  rules                 1  (pat 1)
  translations          2
  dynamic entries       2
  hits                  6
```

Three states are worth telling apart, and the output names which one you are in: no rules at all
(`(none - no NAT rules; NAT is configured from the topology)`), rules but no traffic yet
(`(none yet - 1 rule configured, but no traffic has been translated)`), and a table with rows.

## OSPF

An interface joins OSPF by having a cost, an area or `passive` set on it — and that requires the
process to exist first.

```
ospf router-id 1.1.1.1     # config mode: creates the process
ospf area 0
interface Gi0/0
  ip ospf area 0            # refused until router-id exists
  ip ospf cost 10           # 1-65535
  ip ospf passive
no ospf                     # config mode: tear the process down
```

Installed routes show up in `show ip route` with code `O`. The adjacencies themselves are visible:

```
R1#show ip ospf
Routing Process "ospf 1" with ID 1.1.1.1
  Area 0
  Interfaces:
    Interface  Cost  Area  State
    Gi0/0      10    0     active
    Gi0/1      10    0     passive
  Neighbors: 1 (1 FULL)

R1#show ip ospf neighbor
Neighbor ID  Pri  State  Address    Interface
2.2.2.2      1    FULL   10.0.12.2  Gi0/0
```

Joining an interface to an OSPF process that does not exist is refused rather than silently ignored:
`% OSPF is not enabled - "ospf router-id <ip>" in config mode turns OSPF on`.

A neighbour appears only if the link passed the passive and subnet checks — the same set the SPF
ran over — so the table cannot claim an adjacency the routes did not use. When nothing passes, the
table says so instead of printing an empty header:

```
R1#show ip ospf neighbor
Neighbor ID     Pri   State           Address         Interface
(no adjacencies - no neighbour passed the passive and subnet checks)
```

**An adjacency needs a direct cable between two routers.** Routers that share a subnet through a
switch never peer — the adjacency graph is built from links whose two ends both run OSPF, and a
switch between them breaks that in two — so a campus lab with a router on each side of a switch shows
the empty table above, for reasons the message does not name. Cabling the two routers directly is the
only way to see `FULL`.

BGP is the opposite, which is worth knowing before blaming the tool: a session is keyed on the
configured neighbour address and rides the data path, so two eBGP routers on either side of a switch
do reach `Established  eBGP` ([BGP](#bgp)).

`state` is `FULL` when OSPF had converged **at the instant the simulator is sitting on**, and `INIT`
before that — which is worth spelling out because the instant is sticky and only one command moves
it. A `ping … at 500` leaves the simulator at t=500, so every later `show ip ospf neighbor` reports
`INIT` (and `show ip ospf` counts it: `Neighbors: 1 (0 FULL)`), and a plain `ping` or a bare
`converge` afterward does **not** clear it — `converge <ms>` is a question, not a time machine.
`ping … at converged` is what goes back, after which the same table reads `FULL`.

Only the word `neighbor` (or `neighbors`) changes the output. Any other second word —
`show ip ospf interface`, `show ip ospf database` — prints the **process summary above**, because
there is no per-interface view and no link-state database to show. It does not error, so a typo or a
`database` habit reads as success; if the output has `Routing Process` at the top, you got the
summary whatever you asked for.

## BGP

```
router bgp 65001                 # local AS, 1-4294967295
bgp router-id 1.1.1.1
bgp neighbor 10.0.12.2 remote-as 65002
no bgp neighbor 10.0.12.2        # drop one peer
no router bgp                    # disable BGP entirely
```

**Two spellings, one neighbour.** `bgp neighbor <ip> remote-as <as>` and `neighbor <ip> remote-as
<as>` do the same thing: the first is what `help` offers, the second is what `show running-config`
emits. That was not always true — the parser accepted only the second, so the documented spelling was
answered with `% Usage: router bgp <as> | bgp router-id <ip> | neighbor <ip> remote-as <as>` while
`bgp router-id` in the same row worked, which is exactly how a row of alternatives hides a broken
one. `test/running-config.test.js` now pins both spellings, the removal form, and the paste of the
dump, in a session where BGP is enabled — the only place the difference is visible.

`show ip bgp` derives the sessions before it answers, so a configured peer is not reported as
"unknown":

```
R1#show ip bgp
BGP router identifier 1.1.1.1, local AS number 65001

Neighbor   V  AS     State        Reason
10.0.12.2  4  65002  Established  eBGP

1 of 1 neighbour(s) established
2 prefix(es) installed from BGP
```

The `Reason` column is where a session that did *not* come up says why (wrong AS, no route to the
peer); an established one names the relationship instead. The counts at the bottom reconcile with the
rows above them, and `2 prefix(es) installed` is the number of `B` rows `show ip route` carries.

Learned routes appear in `show ip route` as `B`. Policy (local-pref, MED, communities, route-maps)
is designed in [BGP-POLICY.md](BGP-POLICY.md) but only the decision-order subset in
`engine/bgp.js` is live.

## DNS

```
dns zone lab.example                 # create/select a zone (required first)
dns add www.lab.example A 10.0.0.10  # A AAAA CNAME MX NS PTR SOA TXT SRV
ip name-server 10.0.0.53             # where a client sends its queries
no ip name-server                    # clear the list
```

A record added before any zone exists is refused (`% No zone yet - create one with "dns zone
<name>"`), and `dns add` attaches it to the zone most recently opened — or the last one created.
Answers and failures — `dns-nxdomain`, `dns-nodata`, `dns-servfail` — are distinguishable in the
event log; see [SIMULATION.md §5](SIMULATION.md).

**A record's value is the rest of the line, and it is judged by the library that will answer for
it.** Two things used to be wrong here. The value was one token, so `dns add note TXT hello world`
stored `hello` and dropped `world` in silence; and nothing checked the value against the record's
type, so `dns add www.lab.example A abc` was answered **`Added www.lab.example A abc`** while
`validateZone()` in `engine/dns.js` called the same record *not a dotted-quad IPv4 address* — and the
resolver then handed `abc` to the data path, which printed `Sending 1, 100-byte ICMP Echos to abc`:

```
R1(config)#dns add www.lab.example A abc
% www.lab.example A: "abc" is not a dotted-quad IPv4 address.
% www.lab.example A abc was not added to lab.example
R1(config)#dns add www.lab.example A 10.0.2.10
Added www.lab.example A 10.0.2.10 to lab.example
R1(config)#dns add note.lab.example TXT hello world
Added note.lab.example TXT hello world to lab.example
R1(config)#dns add mail.lab.example MX mail.lab.example
% An MX record needs a preference before the host
% Usage: dns add <name> MX <preference> <host>   e.g. dns add lab MX 10 mail.lab.test
R1(config)#dns add mail.lab.example MX 10 mail.lab.example
Added mail.lab.example MX 10 mail.lab.example to lab.example
```

The refusal is the library's own sentence, not a second set of rules: the record is appended, the
zone is validated, and a record that introduces an error is removed again — so duplicates
(`E_DNS_DUPLICATE`) and a `CNAME` sharing its owner name (`E_DNS_CNAME_CONFLICT`) are refused by the
same mechanism as a bad address. Errors the zone already had are compared away, so a zone containing
a hand-written bad record can still be repaired at the console.

An `MX` preference is stored as a number and shown with the host, which is also what
`show running-config` emits (`dns add mail.lab.example MX 10 mail.lab.example`). That matters for a
reason beyond tidiness: the dump has to be pasteable into a fresh device, and an `MX` line without its
preference is a line this console now refuses.

```
R1#show dns
DNS zones on R1:
  lab.example  (4 records)
    Name              Type  Value
    www.lab.example   A     10.0.2.10
    note.lab.example  TXT   hello world
    mail.lab.example  MX    10 mail.lab.example
    br.lab.example    A     10.0.0.5
  Name servers: none (queries go to any server in the lab)

R1#ping www.lab.example count 1
Translating "www.lab.example"...domain server (R1 (authoritative for lab.example))
Sending 1, 100-byte ICMP Echos to 10.0.2.10, timeout is 2 seconds:
```

The translation prints an address the packet can be addressed to (the ping itself fails only because
nothing in that one-router lab holds `10.0.2.10`). If a zone was written by hand with an `A` record
whose value is not an address, the lookup refuses rather than passing it on:

```
% The A record for www.broken.test is "abc", which is not an address - fix the record on R1
```

Show the table, and resolve a name:

```
R1#show dns
DNS zones on R1:
  lab.example  (2 records)
    Name              Type  Value
    www.lab.example   A     10.0.2.10
    mail.lab.example  A     10.0.2.25
  Name servers: none (queries go to any server in the lab)

R1#nslookup www.lab.example
Server: R1 (authoritative for lab.example)
Query: www.lab.example. A -> NOERROR (authoritative)
  www.lab.example. 3600 IN A 10.0.0.10

PC1#nslookup www.lab.example
Server: R1
  www.lab.example -> 10.0.0.10
```

`nslookup` asks the device's own zones first — an authoritative answer, including an authoritative
NXDOMAIN — and only then falls back to the lab's resolvers, the same path `ping <name>` uses.

**The second argument is a record type**, and it is easy to miss because the examples above all
default to `A`. `nslookup <name> [type]` accepts `A`, `AAAA`, `CNAME`, `MX`, `NS`, `PTR`, `SOA`,
`TXT` and `SRV`; anything else is refused with the list rather than silently treated as `A`:

```
R1#nslookup lab.example MX
Server: R1 (authoritative for lab.example)
Query: lab.example. MX -> NOERROR (authoritative)
  lab.example. 3600 IN MX 0 mail.lab.example.

R1#nslookup www.lab.example AAAA
Server: R1 (authoritative for lab.example)
Query: www.lab.example. AAAA -> NOERROR (authoritative)
  no AAAA records for www.lab.example. (empty NOERROR)

R1#nslookup www.lab.example BOGUS
% Unknown record type "BOGUS" (use A/AAAA/CNAME/MX/NS/PTR/SOA/TXT/SRV)
```

A type the name does not carry is **empty NOERROR, not NXDOMAIN** — the name exists, the record type
does not — which is the distinction a resolver makes and the one worth showing in a lab.

### Port arguments — one port, or a refusal

Nine show commands take a port. The rule for all nine is the same, and it is worth stating because this
console has now broken it three times in three different ways:

> A port argument either narrows the answer, or is refused **by name**. It is never ignored.

Ignoring is the worst of the three outcomes, because the answer still looks like an answer. `show
interfaces ether1` printed all 36 lines for nine ports; `show ip interface brief 1/1/3` did the same,
nine commands later, on a switch with 28 ports. Both read as "here is your port".

```
SW1#show lldp neighbors 1/1/3
LLDP neighbours on SW1:
  Neighbour  Local port  Port ID  Mgmt address
  PC1        1/1/3       eth0     10.0.0.10

SW1#show mac address-table 1/1/3
Mac address table on 1/1/3 at SW1:
Vlan  Mac Address        Type     Ports
1     02:00:00:00:01:00  DYNAMIC  1/1/3

SW1#show spanning-tree 1/1/3
Spanning tree enabled protocol ieee
Port   Role        State
1/1/3  designated  forwarding

SW1#show ip interface brief 1/1/3
Interface 1/1/3 on SW1:
Interface  IP-Address  OK?  Method  Status  Protocol
1/1/3      unassigned  YES  manual  up      up
```

The heading names the port that was asked about — `Mac address table on 1/1/3 at SW1:` — so a filtered
answer can never be mistaken for a full one. Where a question has no rows, the answer says so instead
of going blank, because an empty table has two meanings (nothing there, or a broken filter):

```
SW1#show lldp neighbors 1/1/12
LLDP neighbours on SW1:
  (none - no LLDP has been heard on 1/1/12)
  A neighbour appears here once an LLDPDU from it has crossed the link.

SW1#show mac address-table 1/1/12
Mac address table on 1/1/12 at SW1:
Vlan  Mac Address  Type  Ports
  (none - nothing has been learned on this port)

SW1#show arp 1/1/3
ARP entries on 1/1/3 at SW1:
Protocol  Address  Age (min)  Hardware Addr  Interface
  (none - no cached address resolves to this port)
```

That last one is a switch: it has no routed port in this model, so its ARP cache is empty whatever port
you name. On a router the same command filters a populated cache.

**`interface` is a keyword, not a port.** IOS spells some of these `show mac address-table interface
<port>`, and both readings work:

```
SW1#show mac address-table interface 1/1/3     ← same answer as `show mac address-table 1/1/3`
```

**Two ports is a question it will not guess at**, and an unknown name is refused with the port quoted
and the list named:

```
SW1#show arp 1/1/3 1/1/5
% show arp takes one port, not "1/1/3 1/1/5"
% Try "show ip interface brief" for the ports this device has

SW1#show spanning-tree 1/1/99
% No interface named 1/1/99 on SW1
% Try "show ip interface brief" for the ports this device has
```

**Spellings resolve through one resolver.** A MikroTik silkscreens `SFP+1` and RouterOS calls it
`sfp-sfpplus1`; both reach the same socket in every command, and the answer always names the panel
spelling, because that is what is printed on the box:

```
MT1#show interfaces sfp-sfpplus1
SFP+1 (ethernet, 10G), MAC 02:00:00:00:00:08
  status: up
  ip: unassigned
  peer: disconnected
```

That equality is not cosmetic. In the version this section replaces, `show interfaces sfp-sfpplus1` and
`show interfaces transceiver sfp-sfpplus1` both worked while `show ipv6 interface sfp-sfpplus1` refused
— one resolver, three opinions — because the IPv6 listing filtered module bays *before* matching the
name it had been given. The bay filter is a listing rule (a 24-cage switch should not print 24 empty
rows), not an answering rule: name a port and you get that port.

**A word that looks like an IOS subcommand gets an answer about the command**, not a hunt for a port by
that name:

```
SW1#show interfaces counters
% "show interfaces counters" is not a command here
% Per-port counters and status are in "show interfaces <port>"
% The list of ports is in "show ip interface brief"
```

Before, that answered `% No interface named counters`, which is true and sends the operator looking for
a port called `counters`.

All of this is swept by `test/port-args.test.js` (83 assertions): every command is asked about a port it
has and a port it does not, in two different labs, and the assertion is written against the *defect*
rather than against today's output — the filtered answer must not equal the full one, must carry fewer
of the full answer's lines, and must not mention any other port on the device.

## Saving the configuration

`write memory` saves the running configuration; `show startup-config` reads the copy back. Both
spellings of the save exist (`write memory`, `copy running-config startup-config`) because an operator
types one of them without thinking about which the box happens to prefer:

```
R1#write memory
Saved startup-config on R1: 7 lines
(this is the first save in this lab - "show startup-config" now answers)
```

The saved copy is the **rendered** configuration — the text `show running-config` prints, minus its
`! PacketForge running-config` label — not the model behind it. That is deliberate: it is what a person
reads and pastes, and it is the only thing a diff against the running config can honestly compare.

**The reason to have a saved copy is the difference.** IOS answers `Building configuration... [OK]` and
says nothing else; the question an operator asks next is "what did I change?", so the dump answers it:

```
R1#show startup-config
! PacketForge startup-config (saved copy)
hostname R1
vlan 99 users
interface Gi0/0
  ip address 10.0.1.1 255.255.255.0
interface Gi0/1
  description uplink
interface Gi0/2
!
! running-config differs from this copy: 2 lines added, 1 line removed
! not in this copy (running-config only):
! + vlan 100 extra
! +   ip address 192.168.9.1 255.255.255.0
! no longer in the running config (this copy still has):
! -   description uplink
! "write memory" replaces this copy with the running configuration
```

Three things about that output are load-bearing:

- **The delta is `!` comments.** A dump that cannot be pasted is a dump an operator has to edit before
  using it, and the whole block would break a paste if it were prose. Pasted onto a bare device, the
  dump rebuilds the same running configuration exactly — that round trip is a test, not a claim.
- **The counts are true.** The diff is a line-level longest-common-subsequence, not a set difference, so
  two identical `description` lines on two interfaces count as one removal when one goes away. The test
  recomputes the difference independently and requires the two to agree.
- **Nothing is invented on a first save.** There is no previous copy to compare against, so the answer
  says it is the first rather than reporting a delta of zero.

Saving again reports what it replaced, and a repeat save says there was nothing to do — without that
second state, an operator can never tell whether the save worked:

```
R1#write memory
Saved startup-config on R1: 8 lines (2 lines added, 1 line removed)
R1#write memory
Saved startup-config on R1: 8 lines (no changes since the previous save)
```

Before anything is saved, the command says so instead of printing an empty configuration, and a session
that never enabled is told why it cannot save:

```
R1#show startup-config
% No startup-config on R1 - nothing has been written in this lab
% "write memory" saves the running configuration (privileged, as on a real device)

R1>write memory
% write memory needs enable mode - type "enable" first
```

The saved copy belongs to the **device**, not to the console session: a new session on the same box
finds it, the other router in the lab does not have one, and it survives everything the running
configuration can do to itself — including being deleted. That is the entire point: a copy that changed
whenever the configuration did would answer no question at all.

What it is **not**: there is no `reload` in this lab, so a saved copy does not boot a device. It exists
to answer "what was on this box" and "what have I changed since".

### One interface at a time

Both configuration views take an optional interface, and the answer is that interface's block — the
`interface <name>` line and the lines indented under it, nothing else:

```
R1#show running-config interface Gi0/0
! PacketForge running-config, interface Gi0/0
interface Gi0/0
  description to-core
  ip address 10.0.1.1 255.255.255.0

R1#show startup-config interface Gi0/1
! PacketForge startup-config (saved copy), interface Gi0/1
interface Gi0/1
  description uplink
!
! running-config differs for Gi0/1: 1 line removed
! -   description uplink
! "write memory" replaces this copy with the running configuration
```

The second answer is the reason to have the filter at all. Asking about one port is usually the
question "is my change to **this** port saved?", and a whole-configuration delta makes the operator
search for the answer among changes to ports they never touched. So the filtered saved view carries its
own delta, and a port nobody touched reports none — which is also a check that the filter is really
filtering, since a filter that printed the whole configuration would report every change on every port.

Three rules hold the shape together:

- **The keyword is optional.** `show running-config Gi0/0` and `show running-config interface Gi0/0`
  are the same question, because both spellings are typed in practice.
- **`interface` with no port is refused as truncated** (`% show running-config needs a port after
  "interface"`), not answered with the whole configuration. That distinction is the whole point: the
  command used to drop its argument on the floor, so `show running-config bogus` printed everything and
  a typo read as success.
- **A filtered dump is still a dump.** The heading is a `!` comment, so a filtered block pastes onto a
  bare device and configures that port and nothing else.

What the filter does **not** do is match text: a port named inside a description (`description see Gi0/0
for the core`) or inside a static route (`ip route 10.9.9.0 255.255.255.0 Gi0/0`) is not part of
Gi0/0's block. Only an `interface` line starts a block.

## Switch management address — an SVI

A switch's own address lives on a **VLAN**, not on a socket. IOS calls that object an SVI and spells it
`interface Vlan10`; without one this console had no way to give a switch an address at all, and the
symptom was quiet: a 28-port switch's `show ip interface brief` was 28 rows of `unassigned`, and `ping`
from a switch could not even be attempted.

```
SW1(config)#interface vlan 10
Vlan10 created - this device's own address in VLAN 10
SW1(config-if)#ip address 10.10.0.1 255.255.255.0
IP address set on Vlan10: 10.10.0.1/24
```

The address appears where you would look for it, and it answers:

```
SW1#show ip interface brief
Interface  IP-Address    OK?  Method  Status  Protocol
1/1/1      unassigned    YES  manual  up      up
…
1/1/28     unassigned    YES  manual  up      up
Vlan10     10.10.0.1/24  YES  manual  up      up

H1#ping 10.10.0.1 count 2
!!!!!
Success rate is 100 percent (2/2)
Reply from 10.10.0.1: bytes=100 time=0.002 ms
Reply from 10.10.0.1: bytes=100 time=0.002 ms

SW1#ping 10.10.0.10 count 1
Success rate is 100 percent (1/1)
```

Four rules make it behave like a management address rather than a decorative field:

- **One address, one MAC.** The reply carries `Vlan10`'s MAC whichever port asked, so a host that moves
  between two ports of the same VLAN keeps the same cache entry instead of re-ARPing:
  ```
  SW1#show interfaces Vlan10
  Vlan10 (svi, virtual), MAC 02:00:00:00:00:8a
    status: up
    ip: 10.10.0.1/24
    vlan: 10 (access)
  ```
  A logical port has no socket, so `show interfaces` reports the VLAN it holds the address in rather
  than a `peer` that can never be plugged in.
- **The VLAN boundary still holds.** A host in VLAN 20 cannot reach an address in VLAN 10, and the
  reverse is also true. The address is reachable from the ports of *its* VLAN, which is exactly the
  rule the forwarder already had — `ownsIpOn()` says "a switch's management address belongs to a VLAN,
  not to a socket, so any port in that same access VLAN can reach it". What was missing was the object.
- **A switch with two SVIs is still not a router.** Owning an address is a host function; forwarding is
  a routing one. Two SVIs do not make VLAN 10 talk to VLAN 20 — you still need an L3 device.
- **It is never a bridge egress.** `show spanning-tree` does not treat it as a bridged port, it is not a
  module bay, and no frame is ever bridged *out of* it. `show vlan` does list it, because it is a member
  of its own VLAN:

```
SW1#show vlan
VLAN  Name      Status  Ports
1     VLAN0001  active  1/1/1, 1/1/2, 1/1/4, …
10    mgmt      active  1/1/3, Vlan10

SW1#show ip route
Codes: C - connected, S - static
  *  Prefix          AD  Gateway  Interface
  *  C 10.10.0.0/24  0   -        Vlan10
```

**The line is up because the VLAN carries traffic, not because the object exists.** A real switch
drops `Vlan10`'s line protocol when the last port in VLAN 10 goes away, keeps the address printed, and
stops answering for it. This console does the same, and says *why*:

```
SW1#show interfaces Vlan10
Vlan10 (svi, virtual), MAC 02:00:00:00:00:8a
  status: up
  ip: 10.10.0.1/24
  vlan: 10 (access)
  line protocol: down (no active port in VLAN 10)

SW1#show ip interface brief
Interface  IP-Address    OK?  Method  Status  Protocol
1/1/3      unassigned    YES  manual  up      up
Vlan10     10.10.0.1/24  YES  manual  up      down

SW1#ping 10.10.0.10 count 1
Success rate is 0 percent (0/1)

SW1#show ip route
Codes: C - connected, S - static
  *  Prefix          AD  Gateway  Interface
```

Note the three answers: **Status** is the administrator's state (up), **Protocol** is the line (down),
and the connected route is *gone* — a down interface contributes no route, so the table and the data
path agree. Put one port in the VLAN and all three change together:

```
SW1(config)#interface 1/1/3
SW1(config-if)#switchport access vlan 10

SW1#show ip route
  *  Prefix          AD  Gateway  Interface
  *  C 10.10.0.0/24  0   -        Vlan10
```

Membership is membership: a port in VLAN 20 does not bring VLAN 10 up, a trunk that *allows* VLAN 10
does, and any one member port is enough. Shut the last one and the line drops again. The two ways to be
down are told apart, because "down" on its own is not a diagnosis:

```
SW1#show interfaces Vlan10      ← every port shut
  line protocol: down (no active port in VLAN 10)

SW9#show interfaces Vlan10      ← nothing plugged in at all
  line protocol: down (no port is cabled)
```

And an administrator's `shutdown` outranks both — the status column names the administrator, not the
VLAN:

```
SW1(config-if)#shutdown
Vlan10 administratively down

SW1#show ip interface brief
Vlan10     10.10.0.1/24  YES  manual  administratively down  down

SW1#show interfaces Vlan10
  line protocol: down (administratively down)
```

Shutting the *interface* and shutting its last port are different lines in the same column, and the
trace above is the difference: one names the administrator, the other names the VLAN.

The dump round-trips, which is the property that matters: `show running-config` prints the object by its
interface name, and `interface Vlan10` creates it on a device that has never seen the VLAN, so the paste
needs no hand editing.

```
vlan 10 mgmt
interface Vlan10
  ip address 10.10.0.1 255.255.255.0
```

There is deliberately no `switchport` line: an SVI is in its VLAN by definition, not by configuration.
And a device that does not switch declines the command instead of creating an object that would never
carry a frame:

```
R1(config)#interface vlan 10
% R1 does not switch - it has no VLANs
% Put the address on the port: "interface Gi0/0"

SW1(config)#interface vlan abc
% VLAN id must be a number, not "abc"
SW1(config)#interface vlan
% Incomplete command: interface vlan <id>
SW1(config)#interface vlan 9999
% VLAN out of range: 9999
```

Swept by `test/svi.test.js` (49 assertions): the object and its visibility, both ping directions, one MAC
from two ports, VLAN isolation, two SVIs not routing, `shutdown`/`no shutdown`, no bridge egress, the
dump round-trip into a fresh switch, every refusal, and distinct MACs with no interface sharing one.

## Interface counters

`show interfaces <port>` has always been where you look for per-port detail, and it used to promise
counters it did not have. It has them now, and `show interfaces counters` is a command of its own:

```
R1#show interfaces Gi0/0
Gi0/0 (ethernet, 1G), MAC 02:00:00:00:00:00
  status: up
  ip: 10.0.1.1/24
  input : 5 packets, 530 bytes
  output: 5 packets, 530 bytes
  drops : 0
  peer: PC1/eth0

R1#show interfaces counters
Interface counters on R1:
Port   Rx packets  Rx bytes  Tx packets  Tx bytes  Drops
Gi0/0  5           530       5           530       0
Gi0/1  1           64        1           64        0

2 ports counted: 6 in, 6 out, 0 dropped
```

**The numbers are checkable, and that is the point.** Each one is counted where the frame actually
moved — `tx` on the port it left, `rx` on the port it arrived at — so they reconcile with the frames
the [event log](#event-log) recorded, port by port. The example above is a three-ping run and the
arithmetic is exact:

| frame | bytes | why |
| --- | --- | --- |
| LLDP | 64 | one per port per run; a real switch counts link traffic too, and `Gi0/1` shows only this |
| ARP request | 64 | the cache is per run, so the first echo resolves the next hop |
| ICMP echo ×3 | 3 × 134 | 100-byte payload + 20-byte IP header + 14-byte Ethernet header |

64 + 64 + 402 = 530. A byte counter nobody can reproduce is a byte counter nobody can trust, so the
frame sizes are stated rather than round numbers.

**Drops are counted with their reasons — but only frames count.** Which events may charge a port is a
named list, not a guess about English:

| event | charges the port | why |
| --- | --- | --- |
| `drop` (with a port) | yes | the frame died on that port: link down, not addressed to this device, no egress in the VLAN, loop |
| `acl-deny` | yes | the frame arrived and the list refused it |
| `vlan-drop` | yes | the port does not carry that VLAN |
| `stp-block` | yes | the port is discarding in the spanning tree |
| `nat-drop` | yes | the translation refused it |
| `poe-deny` | yes | a **frame** refused because the device had no power |
| `poe-budget` | **no** | the PSE deciding who gets funded — no frame exists at that moment |
| `drop` with no port | **no** | it died before an egress was chosen (`no route`, `TTL expired`); no port can honestly own it, and `show logging` is where it is read |

The distinction between the last three is the difference between a number and a guess. A PoE budget
denial and a frame refused for want of power are both power problems, and only one of them involves a
frame:

```
SW1#show interfaces counters
  (no port has carried a frame since this lab started)

PD2#show interfaces port1
  input : 2 packets, 128 bytes
  output: 0 packets, 0 bytes
  drops : 3
          2  device is PoE-powered but the PSE budget is exhausted
          1  no PoE power available - budget exhausted at the PSE
```

The switch's port lost the budget and dropped **nothing**; the device that could not transmit is
charged for the frames it could not handle. Long reasons are listed underneath rather than run off the
right edge — `2 acl-deny` stays on the line, a sentence gets its own.

A frame an ACL refuses arrives and is discarded, which is exactly what an input counter should show:

```
R1#show interfaces Gi0/0
  input : 3 packets, 332 bytes
  output: 1 packet, 64 bytes
  drops : 2  (2 acl-deny)
```

Note `output: 1 packet` — the echo that got through and its reply. The two denied echoes never left, so
no output counter was charged for them. **Clearing is explicit**, which is the only way a cumulative
number becomes useful:

```
R1#clear counters
Counters cleared on R1 (2 ports, 2 had traffic)

R1#show interfaces counters
Port   Rx packets  Rx bytes  Tx packets  Tx bytes  Drops
Gi0/0  0           0         0           0         0
Gi0/1  0           0         0           0         0

2 ports counted: 0 in, 0 out, 0 dropped
```

`clear counters <port>` zeroes one port; `clear interface counters` is the same command. It is
privileged, like `clear logging`, and it names what it cleared — a bare "done" after wiping counters is
how an operator loses the evidence they were about to read:

```
R1#clear counters Gi0/99
% No interface named Gi0/99 on R1
% Try "show ip interface brief" for the ports this device has

R1>clear counters
% clear counters needs enable mode - type "enable" first
```

Two properties worth stating because they are choices, not accidents:

- **Cumulative from the lab's start, not per command.** A console session begins every command with a
  fresh run, so clearing on every run would make the table always read zero — the counters would be
  reset by the act of asking. They accumulate exactly as a real device counts from boot, and
  `clear counters` is the reset.
- **Per port, including on a switch.** A frame a switch forwards is counted on the ingress port and on
  the egress port, so `1/1/3` shows what arrived and `1/1/4` what it forwarded. That is also why the
  counters are stored per device rather than under one `dev/iface` key: a port name contains slashes
  (`1/1/3`), so a flattened key could not be split back into a device and a port.

## Destination names

`ping`, `traceroute` and `flow open` all take a destination, and all three accept a **name** as
well as an address. The name goes through the resolver `nslookup` uses — this device's own
authoritative zones first, then any server in the lab that hosts the zone — so the two commands
cannot disagree about what a name means:

```
PC1#ping www.lab.example count 2
Translating "www.lab.example"...domain server (DNS)
Type escape sequence to abort.
Sending 2, 100-byte ICMP Echos to 10.0.2.10, timeout is 2 seconds:
!!
Success rate is 100 percent (2/2)
```

The translation line is printed only when a name was given, and it names the server that
answered — an address is already an answer and says nothing extra.

Three failures stay three failures, because the causes and the fixes differ:

```
PC1#ping nowww.lab.example
% Unknown host nowww.lab.example: NXDOMAIN from DNS

PC1#ping nothing.example
% Unknown host nothing.example: no DNS server in this lab hosts a zone for it

PC1#ping 10.0.0.999
% Invalid ping target: 10.0.0.999
```

NXDOMAIN means a server **authoritative** for that zone denied the name. "No server hosts a zone
for it" means nobody was authoritative, so nobody denied anything — a zone asked about a name it
does not own replies NXDOMAIN *without* the authority bit, and counting that as a denial would
accuse a server of refusing a domain it never served. And something that is only digits and dots
was meant to be an address, so a malformed one is called malformed rather than looked up as a
hostname.

**That type argument only applies to the device's own zones.** It is dropped on the lab-fallback
path, so a client asking a neighbour's server always gets the A question answered:

```
PC1#nslookup www.lab.example AAAA
Server: DNS
  www.lab.example -> 10.0.2.10

PC1#nslookup lab.example MX
Server: DNS
  lab.example exists but has no A record (NODATA)
```

The first answer is the `A` value under a bare `->` line with no type shown, so it looks like a
`AAAA` that happens to equal the IPv4 address. The second is worse to read: `lab.example` was asked
about as `MX` and answered as though you had asked for `A`. Both are correct for the question the
engine actually posed — run the same two commands **on the server** to see the typed answers above.

Reverse lookups are the other rough edge, and there is no workaround: the record is stored and
displayed but **no lookup path resolves it**. `dns add 10.0.2.10 PTR www.lab.example` is accepted
(`Added 10.0.2.10 PTR www.lab.example to lab.example`), `show dns` lists it under its zone, and then
`nslookup 10.0.2.10 PTR` on that same server still answers `** server can't find 10.0.2.10:
NXDOMAIN` — from the lab path, not authoritatively. Building the reverse zone by hand does not fix
it either: with `dns zone 2.0.10.in-addr.arpa` created and the PTR inside it, the query for
`10.0.2.10` is not rewritten to the reverse name, so the same NXDOMAIN comes back. Treat `PTR` as a
record you can store and read in the table, not one you can query; forward lookups (`A`, `AAAA`,
`CNAME`, `MX`, `NS`, `TXT`, `SRV`) are the ones that answer.

## SCION

```
scion 1-ff00:0:110     # join an ISD-AS; a core AS is labelled as such
no scion               # leave
```

The ISD-AS is validated on entry (an unparseable string is refused with the expected shape).

Inspect membership and paths:

```
R1#show scion
SCION membership on R1:
  ISD-AS       : 1-ff00:0:110  (non-core)
  Segments     : 2 up, 0 core, 2 down
  Peers        : 1-ff00:0:0, 1-ff01:0:0
  Network      : 4 AS(es), 2 core
  Reachability :
    1-ff00:0:0        unreachable
    1-ff00:0:120      4 path(s)
  ("show scion paths <isd-as>" describes the selected path)

R1#show scion paths 1-ff00:0:120
SCION paths from 1-ff00:0:110:
  1-ff00:0:120      4 paths  best 3 hops, 4 ms
    SCION path: valid, 2 segments, 3 hops, 4 ms, mtu 1500, underlay UDP/30041
      [0] up   1-ff00:0:110 -> 1-ff00:0:0  (2 hops, 2 ms, mtu 1500)
      [1] down 1-ff00:0:0 -> 1-ff00:0:120  (2 hops, 2 ms, mtu 1500)
      hops: 1-ff00:0:110 -> 1-ff00:0:0 -> 1-ff00:0:120
```

`show scion paths` with no destination summarises every other AS in the lab, marking an islanded
AS `no beaconed path` and counting the segments that were refused — `no beaconed path (1 refused)`
says the walk found a candidate and the policy rejected it, which is a different problem from
having no candidate at all. A reachable AS prints `1 path  best 3 hops, 4 ms` (plural `paths` when
there is more than one). The paths are composed from the beaconed segments over the real peering
graph — a link between two SCION-enabled devices is a peering between their ASes — and the selected
path is the one `pingScion()` would carry.

---

## Refusal codes: the ones you will actually meet

The engine defines **145** distinct `E_*` codes, and **whether the console shows you one depends on
the family** — measured, not assumed. Count them yourself; the number is the distinct quoted `E_`
strings across `engine/`, which is the only reading that ignores identifiers and comments:

```
grep -oh "'E_[A-Z0-9_]*'" engine/*.js | sort -u | wc -l     # 145
```

Of those 145, **47** appear as rows in the tables below and **69** are named anywhere in this
document — the rest are reachable only through `validateTopology()`, the API, or a surface that prints
prose instead of the code, which is what the next table is about. So a code missing from the tables is
not necessarily a code that cannot happen: it is a code you cannot see from this console.

| Surface | How the refusal reads |
|---|---|
| `flow open` / `openFlow()` | `% flow refused (E_NO_ROUTE): …` — always a code |
| DHCP pool (`exit` from `ip dhcp pool`) | `% E_DHCP_GATEWAY_OUTSIDE: DHCP pool p1: gateway 10.9.9.9 is outside 10.1.1.0/24.` — the code, the pool, then the reason |
| VLAN, trunk, LAG, VRRP (config mode) | **prose only**, at the keystroke: `% accessVlan 1004 is reserved by IEEE 802.1Q (1002-1005)`, `% Invalid virtual router id: 300 (1-255)`, `% Invalid mode: bogus (use active\|passive\|on)` |
| `access-list` | `% [object Object]` — the error object is stringified, so the reason is lost entirely (see [Access control lists](#access-control-lists)) |
| NAT | *no CLI surface at all*: rules live in the topology JSON, and the codes arrive through `validateTopology()` and the API |
| `validateTopology()` / the validator | `{ code, message }` objects with a severity, which is where the tables below are transcribed from |

So a code in these tables is not a promise that the console will print it. The tables are still worth
having: they say what the model considers wrong, which is what a `409` body, a `verdict.errors[]`
entry, or a `% flow refused` line is quoting. Anything not listed here — the wire-format decoders,
IPv6, DNS, SCION, BGP — is reachable with `grep -rn "E_" engine/*.js`.

### DHCP pools (`engine/dhcp.js`)

| Code | What was wrong |
|---|---|
| `E_DHCP_BAD_NETWORK` | `network` is not an IPv4 address |
| `E_DHCP_BAD_MASK` | `mask` is not a contiguous mask (`255.255.255.0` or `/24` both work) |
| `E_DHCP_BAD_RANGE` | a pool has no `range` (or only half of one) — this model allocates only from an explicit range, never from the whole subnet. An invalid pool is **discarded** when you leave the sub-mode, so it never appears in `show running-config` |
| `E_DHCP_RANGE_ORDER` | `rangeStart` is above `rangeEnd` |
| `E_DHCP_RANGE_OUTSIDE` | the range is not inside `network`/`mask` |
| `E_DHCP_RANGE_ENDPOINT` | the range includes the network or broadcast address |
| `E_DHCP_NO_HOSTS` | every address in the range is excluded, reserved, or network/broadcast — the pool can hand out nothing |
| `E_DHCP_BAD_GATEWAY` / `E_DHCP_BAD_DNS` | `default-router` / `dns-server` is not an IPv4 address |
| `E_DHCP_GATEWAY_OUTSIDE` | the gateway is outside the pool's subnet |
| `E_DHCP_BAD_LEASE` | `lease` is not a positive number of seconds |
| `E_DHCP_BAD_EXCLUDED` | an `excluded` entry is not an IPv4 address or range |
| `E_DHCP_BAD_RESERVATION` | a `host` reservation has an invalid address |
| `E_DHCP_RESERVATION_OUTSIDE` | a reservation is outside `network`/`mask` |
| `E_DHCP_RESERVATION_OUT_OF_RANGE` | a reservation is inside the subnet but outside the pool range — **this one disables the pool silently**, see [DHCP server](#dhcp-server) |
| `E_DHCP_RESERVATION_CONFLICT` | the same address is reserved for two different MACs |
| `E_DHCP_BAD_MAC` | a reservation key is not a MAC address |

### VRRP (`engine/vrrp.js`)

| Code | What was wrong |
|---|---|
| `E_GROUP_OBJECT` | the group spec is missing or not an object |
| `E_VRID_RANGE` | VRID is not an integer 1–255 |
| `E_PRIORITY_RANGE` | priority is not an integer 0–255 |
| `E_NO_VIRTUAL_IP` | the group advertises no virtual address |
| `E_IP_INVALID` | a virtual IP is not a valid IPv4 address |
| `E_DUPLICATE_IP` | the same virtual IP is listed twice |
| `E_ADVERT_RANGE` | the advertisement interval is not a positive value |
| `E_PREEMPT_BOOL` | `preempt` is not a boolean |
| `E_AUTH_LENGTH` | the VRRPv2 authentication text is longer than 8 characters |

### VLANs and trunks (`engine/vlan.js`)

| Code | What was wrong |
|---|---|
| `E_VLAN_SYNTAX` | an entry in the VLAN list cannot be parsed |
| `E_VLAN_RANGE` | a VLAN id is outside 1–4094 |
| `E_VLAN_RESERVED` | a VLAN id is reserved by 802.1Q — **1002–1005** |
| `E_VLAN_EMPTY` | the VLAN list is empty |
| `E_TRUNK_NO_VLANS` | a trunk was given an empty allowed list (use `all` to mean every VLAN) |
| `E_NATIVE_NOT_ALLOWED` | the native VLAN is not in the allowed list |
| `E_VOICE_VLAN_UNSUPPORTED` | a voice VLAN was set on an access port; voice traffic is tagged, so it needs a trunk |
| `E_VLAN` | *runtime*, not configuration: a frame was dropped because its VLAN is not allowed on the port |

### Link aggregation (`engine/lag.js`)

| Code | What was wrong |
|---|---|
| `E_LAG_TOO_FEW` | fewer than two member ports |
| `E_LAG_DUPLICATE_MEMBER` | the same port is listed twice |
| `E_LAG_SPEED_MISMATCH` / `E_LAG_DUPLEX_MISMATCH` | members disagree on rate or duplex |
| `E_LAG_VLAN_MISMATCH` | members are not in the same VLAN set |
| `E_LAG_BAD_MODE` | unknown mode. The console now translates its own vocabulary (`active`, `passive`, `on`) into the validator's (`lacp-active`, `lacp-passive`, `static`) before storing it, so this code is only reachable from a hand-written configuration; see [Link aggregation](#link-aggregation) |

### NAT rules (`engine/nat.js`)

| Code | What was wrong |
|---|---|
| `E_RULE_INVALID` | a rule is not an object |
| `E_RULE_TYPE` | `type` is not `static`, `dynamic` or `pat` |
| `E_LOCAL_SPEC` / `E_GLOBAL_SPEC` | `insideLocal` / `insideGlobal` is not an IPv4 host, subnet, range or `any` (and `any` is only legal on `pat` locals) |
| `E_LOCAL_NOT_HOST` / `E_GLOBAL_NOT_HOST` | a `static` rule's address is not a single host |
| `E_SAME_ADDRESS` | `insideLocal` and `insideGlobal` are identical, so the rule translates nothing |
| `E_PROTOCOL` | `protocol` is not `tcp`, `udp`, `icmp`, `any` or a protocol number |
| `E_PORT_PROTOCOL` | a port was given for a protocol that has no ports |
| `E_PORT_RANGE` | a port is not a whole number 1–65535 |
| `E_NAT_POOL_EXHAUSTED` / `E_NAT_PORT_EXHAUSTED` | *runtime*: every pool address, or every port on the overload address, is in use — the packet is dropped |

### Flow refusals, for comparison

`flow open` and `openFlow()` answer with the **runtime** codes instead, and they are the same
`E_NO_ROUTE` / `E_ACL_DENY` / `E_STP` / `E_UNREACHABLE` the console prints — plus `E_PROTO` (not tcp
or udp), `E_NO_ADDRESS` (the destination device has none), `E_IFACE_DOWN`, `E_NO_SOURCE_IP`,
`E_FLOW_TOO_LARGE` (more segments than a run allows) and `E_NO_ROUTE_TO_PEER` (BGP could not reach
its neighbour). See [Flows](#flows).
