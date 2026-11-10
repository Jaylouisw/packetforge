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
| `show history` | the commands typed into this session, last 10 ([Commands from a lab guide](#commands-from-a-lab-guide-and-the-word-this-console-answers-with)) |
| `configure terminal` | enter config mode |
| `?` in any mode | only the commands this device can use ([help](#the-help-page-was-the-same-page-on-every-device)) |
| `channel-group`, `power inline`, `ip ospf …`, `no power inline` | per-interface verbs, gated the same way ([interface mode](#interface-mode-had-the-same-defect-one-prompt-deeper)) |
| `show vlan / spanning-tree / mac address-table / etherchannel` | the bridge's tables - and what the device is, on one that has none ([show](#the-show-views-a-device-could-not-have-and-answered-anyway)) |
| `show version` | vendor, model, category, capabilities |
| `show logging [<type> \| summary] [last <n>] [device <name>]` | the lab's event log — why something was dropped, forwarded or denied ([Event log](#event-log)) |
| `show clock` | the instant the lab is being asked about, and a plain statement that there is no wall clock ([Event log](#event-log)) |
| `clear logging` | truncate the event log (privileged exec) |
| `show startup-config` | the saved copy, then what the running config has changed ([Saving the configuration](#saving-the-configuration)) |
| `write memory` | save the running configuration as the startup copy (privileged exec) |
| `copy running-config startup-config` | the same save, spelled the other way |
| `copy startup-config running-config` | put the saved copy back, **merging** it into the running config — exec-only, and the way back from an unsaved change ([Saving the configuration](#saving-the-configuration)) |
| `reload` | answers instead of rebooting: nothing here boots, so it names the saved copy and the way back rather than pretending to restart ([Saving the configuration](#saving-the-configuration)) |
| `clear counters [<port>] / clear interface counters` | zero the per-port counters (privileged exec) — the two spellings are the same command |
| `clear ip nat translation [*\|<inside-local>]` | empty the translation table and keep the rules; `*` clears every entry, an inside-local clears that host's. Answers "was already empty" the second time |
| `clear arp [<port>] / clear ip arp` | empty the ARP cache (privileged exec); the next packet re-learns it. A port clears only the entries `show arp` attributes to that port — an entry behind a switch is attributed to `-` and survives |
| `clear mac address-table [interface <port>]` | empty the MAC table on a switch (privileged exec); a router refuses, because it does not bridge |
| `show ip interface brief [<port>]` | interface IP / status table; the **Method** column says `manual` or `DHCP`; one port narrows it ([Port arguments](#port-arguments--one-port-or-a-refusal)) |
| `show ip route` | connected (`C`), static (`S`), OSPF (`O`) and BGP (`B`) routes |
| `show arp [<port>]` | ARP cache (`show ip arp` is the same command, and the spelling IOS's own help prints); the Interface column is derived from the topology, because the cache itself holds only address → MAC. It names the port only when the owner is **directly cabled** to this device — a host behind a switch shows `-` — and prints `(self)` for the device's own address |
| `show mac address-table [interface <port>]` | MAC table (switches); one port narrows it |
| `show port-security` | secured ports: address limit, addresses held, violations, violation mode, and any port err-disabled by a violation |
| `show port-security interface <port>` | one port in detail: `Secure-up` / `Secure-shutdown`, mode, counts, last source, and the three aging settings ([Port security](#port-security-a-bridge-that-finally-has-an-opinion)) |
| `show port-security address` | which station is pinned to which port: `SecureConfigured`, `SecureSticky` or `SecureDynamic` |
| `clear port-security counters [interface <port>]` | reset the violation count and nothing else — the port stays err-disabled until `no shutdown` |
| `clear port-security dynamic [interface <port>]` | forget learned secure addresses, keeping configured and sticky ones |
| `clear port-security sticky [interface <port>]` | unpin the sticky addresses, so the next station to arrive may be a different one |
| `show interfaces [<port>]` | per-interface detail incl. MAC, peer and counters; name a port and it answers for that port only ([Port names](#port-names)) |
| `show interfaces counters [<port>]` | one row per port: packets, bytes and drops ([Interface counters](#interface-counters)) |
| `show interfaces transceiver [<port>]` | cage, negotiated medium, reach vs cable length, and the `W_DISTANCE` verdict |
| `show running-config` | the full configuration, including routing protocols — see the note below |
| `show vlan [<id>]` | VLAN table with trunk ports marked `(t)`, or one VLAN ([VLANs](#vlans)) |
| `show vlan name <name>` | the same table, narrowed by the name the VLAN was given ([VLANs](#vlans)) |
| `show spanning-tree [<port>]` | STP state, or "not part of any L2 loop"; one port narrows it |
| `show etherchannel` | LAG groups and member state ([Link aggregation](#link-aggregation)) |
| `show access-lists` | ACL entries and where each list is bound ([Access control lists](#access-control-lists)) |
| `show vrrp [<group>]` | group state after the last election; naming a group narrows the table ([VRRP](#vrrp-first-hop-redundancy)) |
| `show ip protocols` | the routing processes running here, their areas, peers and distances |
| `show ip bgp` | peers and installed prefixes ([BGP](#bgp)) |
| `router ospf <process-id>` | start OSPF and enter router mode, where `network … area …` lives ([The two commands](#the-two-commands-every-ospf-lab-starts-with-and-this-console-did-not-have)) |
| `router bgp <as>` | enter `(config-router)#` and configure BGP ([BGP mode](#bgp-had-no-mode-and-the-line-after-it-was-lost)) |
| `ip routing / no ip routing` | forward between this device's interfaces, or stop ([ip routing](#ip-routing-and-configuration-that-is-not-the-same-when-applied-twice)) |
| `show ip ospf [<process-id>]` | process, interfaces and adjacency count ([OSPF](#ospf)). **The `<process-id>` form refuses every number today** — nothing sets a process id, so the bare form is the one that answers; see [the measured note](#a-group-id-is-an-id-not-a-timestamp) |
| `show ip ospf neighbor` | peers the SPF ran over: router-id, state, address, port |
| `show lldp` | whether LLDP runs, the interval and hold time, which ports announce, neighbours learned ([One LLDP view](#one-lldp-view-and-three-questions-it-could-not-answer)) |
| `show lldp neighbors [<port>]` | neighbours actually heard on the wire ([One LLDP view](#one-lldp-view-and-three-questions-it-could-not-answer)) |
| `show lldp neighbors detail` | one block per neighbour: chassis id, port id, description, TTL, medium and speed |
| `show lldp interface [<port>]` | the per-port decision: Tx enabled, Rx enabled, cabled, and its neighbour |
| `show lldp traffic [<port>]` | DUs sent, received, discarded by `no lldp receive`, and failed |
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
  switchport voice vlan <id>
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

### A page that lists what the mode cannot run

Exec and enable share one command set here, so the page cannot hide the privileged half without lying
about the other one — and it was listing that half silently:

```
SW1>clear arp        % clear arp needs enable mode - type "enable" first
SW1>write memory     % write memory needs enable mode - type "enable" first
```

Both rows were on the page the operator was reading when they typed them. The page now names the
privileged half after the rows, so the answer arrives before the command does:

```
Privileged commands (they answer "needs enable mode" until you type "enable"):
  write memory, copy running-config startup-config, copy startup-config running-config,
  clear logging, clear counters, clear interface counters, clear arp, clear ip arp, clear mac
  address-table, clear port-security
```

The list is **capability-gated like every other row**: a router names `clear ip nat translation` and
not the bridging clears, a switch the other way round, because naming a command the device does not
have is the same defect in the other direction. It is checked **both ways** by the suite — every verb
it names must refuse in user exec, and every row that refuses must be named — so the list cannot
drift as verbs are added.

Two traps the suite had to learn, both worth writing down. A single session cannot walk a page that
contains `configure terminal`: part-way through, every later row is answered by the config parser. And
`help` prints this page, so a refusal check that greps the whole output reads a help page as a
privilege failure — the check is on the first line only.

### A saved copy you can never return to is a copy nobody needed

`write memory`, `copy running-config startup-config` and `show startup-config` all existed. Nothing
ever loaded the saved copy back, so the save was write-only:

```
R1#copy startup-config running-config   % copy takes running-config startup-config - the source must be running-config
R1#reload                               % Unrecognized command: reload
```

`copy startup-config running-config` now does what IOS does with it — **merge**, not replace: the
saved copy is replayed line by line through the same parser a paste uses, so every line is validated
as it would be by hand, and a saved line the parser refuses today is reported rather than swallowed.
Nothing is cleared first, and the answer says so:

```
R1#copy startup-config running-config
Copied startup-config into the running configuration on R1: 6 lines applied
  1 line added (this is a merge: lines the saved copy does not mention are kept)
```

`reload` gets the absent-family treatment rather than a typo message: nothing here boots, so there is
no restart to schedule — and with a saved copy it names the command that loads it and the one that
shows what is saved. Every pointer in that answer is run by the suite, so it cannot name a command the
device does not have.

### An exec verb in configuration mode is not a typo

The same pass found the neighbouring defect, in the mode that refuses most often:

```
R1(config)#write memory   % Unrecognized config command: write memory
R1(config)#reload         % Unrecognized config command: reload
```

Both are real commands, one prompt away. Configuration mode now names that: the verb is an exec verb,
`end` returns to privileged exec, and `do` is *not* offered for it, because `do` carries reads only
(`do show <...>`) — advice that cannot be followed is the defect being fixed, not the fix.

### A bracketed part is optional, and a default is not the operator's

Two questions asked of every help row containing `[optional]` parts: is each part accepted when
present, and accepted when absent? Both spellings are typed at the device and neither may come back
`% Unrecognized`. The sweep walks 37 such rows (96 lines) across config and interface mode on a
router and a switch, so a bracket added around something the parser actually requires fails the
suite instead of misleading a reader.

The same sweep turned up a refusal that blamed the operator for a number they never typed:

```
R1(config-if)#ipv6 nd prefix 2001:db8:9::/64 valid 60
% Preferred lifetime (604800s) cannot exceed the valid lifetime (60s)
```

The contradiction is real — a preferred lifetime past the valid one cannot be advertised — but
`604800` was the model's *default*, invisible to the operator, and the only way forward was to guess
it and type a preferred lifetime as well. When only the valid lifetime is given, the preferred one
follows it down, and the answer says which number was not theirs:

```
R1(config-if)#ipv6 nd prefix 2001:db8:9::/64 valid 60
IPv6 ND prefix 2001:db8:9::/64 advertised (L=1 A=1, valid 60s, preferred 60s)
  the preferred lifetime followed the valid one down to 60s (it is the default 604800s, which
  would outlast a valid lifetime of 60s)
```

A pair the operator *did* type is still refused, quoting their two numbers, and the clamped pair is
dumped (`valid 60 preferred 60`), so a paste reproduces the state rather than re-deriving it.

### A keyword abbreviates where it stands, not only first

The console abbreviates every keyword by prefix, from the help rows. That rule applied to the command
words and stopped at the *argument* position:

```
R1#show run int Gi0/0    % show running-config takes one port, not "int Gi0/0"
R1#show arp int Gi0/0    % show arp takes one port or one address, not "int Gi0/0"
```

Two refusals that name no port and offer no clue, for a word with exactly one continuation in that
slot and no port it could name. The argument parsers stripped the literal `interface` and nothing
else, so the two spellings of the same read gave different answers — one the interface block, the
other advice about the port list.

`interface` now abbreviates in an argument position wherever it stands: one shared predicate in the
port-argument helper (which every `show` that takes a port uses) and the same rule in the ARP
parser, which has its own. A single letter is still refused, because `i` could be the start of a port
name — being unhelpfully picky about `int` is not the same as inventing a rule for `i`.

The guard is a sweep rather than a list: for every `show …` row made only of literal keywords,
abbreviate each keyword after the first to three characters when that prefix identifies exactly one
word in the exec vocabulary, and require the same answer as the full spelling. It walks 46 positions
today, so a new argument keyword that forgets the rule fails the suite without anyone thinking of it.

### A slot that takes a number takes a number

Sweeping every numeric placeholder on the config pages with junk (`abc`, `-1`, `1e3`), an
out-of-range value and a boundary value found two slots that answered in the affirmative anyway:

```
R1(config)#router bgp 1e3            BGP enabled, local AS 1
R1(config)#router bgp 65001abc       BGP enabled, local AS 65001
R1(config)#ip route 10.0.0.0 255.0.255.0 10.0.0.9
                                     Route added: 10.0.0.0/8 via 10.0.0.9
```

Both were `parseInt` (or `prefixOf`, which counts leading ones and stops at the first zero) doing the
reading while the answer claimed the number had been understood. The first invents a process —
`router bgp 1.10` would have joined `router bgp 1` by accident — and the second **widens a route** to
a /8, claiming reachability for addresses nobody named.

`router ospf` had the strict check already and `ip address` already refused a non-contiguous mask, so
in both cases the defect was one verb being the odd one out. The AS slot now reads asplain
(`65001`) and asdot (`1.10` = 65546) — the two spellings IOS accepts — and says which number went in
when the words did not spell it out, because the answer is the only place the operator can see the
interpretation. Everything else is refused with the range in the message:

```
R1(config)#router bgp 1.10
BGP enabled, local AS 65546 ("1.10" is asdot for 65546)
R1(config)#ip route 10.0.0.0 255.0.255.0 10.0.0.9
% "255.0.255.0" is not a contiguous mask - the ones must all be on the left
% Read as /8 it would cover every address that prefix matches - wider than the words typed
```

### Every verb the page prints has a way back

A sweep of the config page typed each row with its placeholders filled, then typed the same words
behind `no`, and compared the running-config to the baseline. Three rows failed, in two shapes:

```
R1(config)#no hostname                      % Unrecognized config command: no hostname LAB
R1(config)#ipv6 nd ra lifetime 10           IPv6 RA router lifetime 10s
R1(config)#no ipv6 nd ra lifetime 10        IPv6 RA router lifetime 10s     <- set it again, and said so
SW1(config)#no spanning-tree vlan 10 root primary
                                            % Unexpected argument "root primary" - no spanning-tree vlan <id>
```

`hostname` renamed every surface of a device and had no removal at all; `no ipv6 nd ra lifetime` took
the *positive* branch, so a removal re-applied the value and answered as if it had been asked to;
`no spanning-tree vlan <id> root primary` refused the words the operator had just been told to type.
The removals now exist and undo:

```
R1(config)#no hostname
Hostname cleared: this device is called Router-d1 again (the default name for this model)
  "show running-config" now reads "hostname Router-d1", the default for this device
R1(config)#no ipv6 nd ra lifetime 10
IPv6 RA router lifetime back to the default 1800s (was 10s)
SW1(config)#no spanning-tree vlan 10 root primary
Spanning tree bridge priority reset to the default (32768) on SW1 (was 24576)
```

Two rules the sweep has to respect, and now states: a removal **removes what is there rather than
overwriting it** (`no … root primary` on a priority somebody set by hand refuses and names the value
to remove, instead of silently treating 4096 as a root designation — so the model records *which
form* set the priority), and a removal **accepts the words the positive form accepts**, because that
is how an operator speaks it back. `no ip domain-name <name>` was in the same family: it refused the
name and required the shorter spelling, and now matches what is configured (case-insensitively, since
the positive lowercases it) and names the configured value when it does not match.

The one case that is *not* a defect: `no vlan 10 name` resets the name to `VLAN0010` and leaves the
VLAN, because the VLAN and its name are two objects. The sweep reports it as residue if it compares
against a baseline from before the VLAN existed, which is why the battery lists its cases explicitly
rather than trusting the diff.

### A keyword the page lists as a placeholder is not abbreviatable

This console abbreviates keywords to any prefix that identifies exactly one continuation, and the tree
it expands against is built from the **help rows** — one source, so an abbreviation can never reach a
command that does not exist. That means a help row written with a placeholder silently opts its values
out of the rule:

The first command below always worked, because its help row lists real keywords. The second *used* to
fail, and the shape of the two outputs is the whole argument — the transcript is marked so nobody runs
the middle block expecting it to still print that:

```text
SW1(config-if)#switchport mode acc                 <- row lists access|trunk: expands
Switchport mode access on Fa0/1

SW1(config-if)#switchport port-security violation rest      <- BEFORE the row was fixed
% "rest" is not a violation mode
% Use protect, restrict or shutdown
```

That row read `violation <mode>`, so `rest` was an opaque value handed straight to a parser that compares
exactly: the vocabulary existed, but only inside the parser, where neither abbreviation nor completion
could see it. Spelling the modes out (`violation protect|restrict|shutdown`) puts them in the tree, and
the same operator now gets a real answer — measured after the change:

```text
SW1(config-if)#switchport port-security violation rest
Violation mode on Fa0/1 set to restrict (was shutdown)
  a violating frame is dropped and counted, and the port keeps working
```

`prot` and `shut` expand the same way, while `b` and `zz`, which identify nothing, are still refused with
the mode list — and the message quotes what was typed rather than what was expected:

```text
SW1(config-if)#switchport port-security violation b
% "b" is not a violation mode
% Use protect, restrict or shutdown
```

The lesson is the one the docs already state for the help page: **the row is the command surface**. A
placeholder is right for a value with no vocabulary (`<name>`, `<ip>`); it is wrong for a set of
keywords the parser will accept, because it hides them from both abbreviation and completion.

### A number that names something is not a time

This console answers a control-plane question *at an instant* — `show vrrp at 500` — and, as a
convenience, accepts a bare trailing number. Two views take a number as an **argument**, and there the
convenience won:

```
R2#show vrrp 1
VRRP at t=1 ms (control planes rebuilt for this answer)
Gi0/0  1  100  Backup  -  10.0.0.254  -            <- the group R2 was MASTER of
(no router holds the virtual address yet - the group has not converged)

R2#show vrrp
Gi0/0  1  100  Master  R2  10.0.0.254  00:00:5e:00:01:01
```

The `1` was read as one millisecond, the group id was dropped, and the answer was a *different
question* — the state before the election — with nothing saying the argument had been ignored. Same
shape in `show ip ospf 99`: a process id that does not exist answered as "at t=99 ms" about the
process that does.

The rule now: **a trailing number is an instant only where the view has no other use for a number.**
`show vrrp <group>` and `show ip ospf <process-id>` read the number as what it names, filter to it, and
refuse one that is not there while naming the ones that are:

```
R1#show vrrp 9
% No VRRP group 9 on R1
% The groups here are: 1 on Gi0/0, 2 on Gi0/0

R1#show ip ospf 1
% No OSPF process 1 on R1
% The process here is "ospf 7"
```

**Known limitation, measured: the OSPF form cannot currently succeed.** `show vrrp <group>` filters
correctly, but `show ip ospf <n>` refuses **every** `n`, including the process it names — because
nothing ever sets `config.ospf.pid`: there is no command that takes a process id, so the key is
`undefined`, and the comparison is `Number(what) !== Number(cfg.pid)`:

```text
R1#show ip ospf
Routing Process "ospf 1" with ID 1.1.1.1
  Area 0
  ...

R1#show ip ospf 1
% No OSPF process 1 on R1
% The process here is "ospf 1"
```

The second line is the misleading part: `cfg.pid` is `undefined`, and the message prints
`(cfg.pid || 1)`, so it invents the `1` it has just refused. Until the engine sets a process id (or
treats "no id configured" as id 1), use the bare `show ip ospf` — it answers the same question, and
`show ip ospf neighbor` / `database` / `interface` are unaffected. Two smaller artefacts of the same
path, both reproducible: `show ip ospf process 1` prints an unrelated `OSPF at t=1 ms` line before
refusing, and any unknown word is echoed back as `not "process"`.

Every `at <ms>` and every `converged` is still an instant everywhere — those are unambiguous, and they
are the spellings the help advertises.

### Two views of one peer, and only one of them could see it

One router, OSPF in area 0, one BGP peer. Three commands, three answers that could not all be right —
this is the state **before** the fix, kept because it is the clearest statement of the rule:

```text
R1#show ip bgp summary
10.0.0.2  4  65002  Idle   not yet evaluated     <- the peer is configured

R1#show ip bgp neighbors
(no neighbours configured - add one with "bgp neighbor <ip> remote-as <as>")

R1#show ip bgp neighbors 10.0.0.2
% No BGP neighbour 10.0.0.2 on R1
% Configured: (none)                              <- advice to configure the peer that exists
```

The summary read configuration; the detail views read only the **computed** session rows, so with no
simulation run they saw nothing and reported an absence. The rule the summary was already taught is
the fix: *a peer is configuration, its session state is not* — a configured peer with no evaluation is
`Idle / not yet evaluated`, not missing. Measured on the current tree, the same three commands agree:

```text
R1#show ip bgp summary
10.0.0.2  4  65002  Idle   not yet evaluated
0 of 1 neighbour(s) established

R1#show ip bgp neighbors
BGP neighbour 10.0.0.2 on R1 (local AS 65001)
  Remote AS      65002 (eBGP)
  State          Idle
  Reason         not yet evaluated
  Hold time      180 s
  Prefixes in    0 (no session, so nothing was exchanged)

R1#show ip bgp neighbors 10.0.0.2
BGP neighbour 10.0.0.2 on R1 (local AS 65001)
  ...the same block, narrowed to the peer that was named
```

`show ip protocols` was `% Invalid show command: ip protocols`, for a command whose facts the model
already holds:

```
R1#show ip protocols
Routing Protocol is "ospf 1"
  Router ID       (not configured - the highest interface address)
  Administrative distance 110 for OSPF routes (a static route is 1, so it wins for the same prefix)
  Areas           0
  Interfaces      Gi0/0 (area 0)
  Neighbours      0 (0 FULL)
Routing Protocol is "bgp 65001"
  Router ID       0.0.0.0 (not yet chosen)
  Peers           10.0.0.2 (AS 65002)
  Administrative distance 20 for eBGP, 200 for iBGP

Redistribution is not modelled: a route is connected, static, OSPF or BGP, and the
administrative distance above is what decides between them for the same prefix.
```

It reads the device's interfaces (as `show ip ospf` does, not a parallel map that does not exist) and
the one `Device.ADMIN_DISTANCE` table the route decision uses, so the distances cannot drift from the
table they explain. On a device with nothing running it names the commands that would start a
process; on a host it names what the device *is* instead.

`show standby` joined the absent-show table by naming VRRP — the first-hop redundancy this model has.

### `do show` demoted the prompt out of every block

A read is the one thing an operator does *while* configuring. Inside an interface block:

```
R1(config)#interface Gi0/0
R1(config-if)#do show ip interface brief
Interface  IP-Address  OK?  Method  Status  Protocol
Gi0/0      unassigned  YES  manual  down    down
R1(config)#                        <- the block is gone
```

`do show …` fell through to the global handler, whose rule is *"a line I accept means you have left
the block"* — right for `hostname`, wrong for a read. Every line after the look was applied at the
wrong level: an `ip address` written next went to global config and was refused there.

The ACL block and **both router modes** did the same, so one `do show ip route` in an OSPF process
left it, and the next `network` statement was read as global configuration. The DHCP pool was the
exception in the other direction: it **refused** `do show` as unrecognised. All five now share one
helper:

```
R1(config-router)#do write memory
% do only supports "do show <...>" here
% The prompt stays where it is: "exit" leaves this block, "end" leaves configuration
```

Plain `show <what>` is a read in every block too, router mode included — it used to leave the process
as well. The router-mode page now lists the read it accepts (`show <what> | do show <what>`), and the
deliberate behaviour is unchanged: a **global** verb typed in a block still leaves the block.

### The tree could be configured per VLAN and not viewed that way

`spanning-tree vlan 10 root primary` is accepted, and its own answer says *"Spanning tree for VLAN 10"*.
Asking to see it refused the command:

```
SW1#show spanning-tree vlan 10
% show spanning-tree takes one port, not "vlan 10"
% Try "show ip interface brief" for the ports this device has
```

Advice about the port list, for a command naming a VLAN the previous prompt had just accepted. And
`show spanning-tree root` claimed **"Root bridge for VLAN 1"** — a per-VLAN specificity the model does
not have, on a VLAN nobody configured.

The model runs **one tree for every VLAN**, so the fix is not a per-VLAN table it cannot back. It is to
answer the VLAN-shaped question with the tree that exists and say so:

```
SW1#show spanning-tree vlan 10
Spanning tree enabled protocol ieee
  VLAN 10 - one tree covers every VLAN on this device, so this is it
  Root bridge: priority 24576, 02:00:00:00:00:00 (SW1)
  ...

SW1#show spanning-tree vlan 10 root
Root bridge for VLAN 10 (one tree covers every VLAN on this device): priority 24576, ...

SW1#show spanning-tree vlan 99
% No VLAN 99 on SW1 - nothing is configured for it and no port carries it
% The VLANs here are: 10, 20
```

Without a VLAN, the root header now speaks for every VLAN instead of inventing VLAN 1. `root` and
`summary` combine with `vlan <id>`, and the capability gate runs **before** the VLAN lookup, because a
host answering *"No VLAN 10 on PC1 … The VLANs here are: 1"* re-invented the VLAN 1 that every other
view had already been taught to drop.

### `no vlan` blamed a port that was an SVI

A switch with its own address in VLAN 20 could not lose VLAN 20:

```
SW1(config)#no vlan 20
% VLAN 20 is carried by Vlan20 - it cannot be removed while those ports are in it
% Move them first, e.g. "switchport access vlan <other>" in each interface block
```

`Vlan20` is an **SVI** — the device's own address — and there is no `switchport` to move it with, so the
one instruction offered could not be carried out. The VLAN table made the same mistake, listing the SVI
in a column headed *Ports*:

```
VLAN  Name      Status  Ports
20    VLAN0020  active  Vlan20
```

Ports and SVIs are two dependencies with two remedies, so they are counted and reported separately now:

```
VLAN  Name      Status  Ports
20    VLAN0020  active  Vlan20 (SVI), Fa0/1

SW1(config)#no vlan 20
% VLAN 20 is this device's own address: Vlan20
% Remove the interface first - "no interface vlan 20" - and the VLAN stays empty
% "show ip interface brief" lists the interfaces, "show vlan" the VLANs
```

When a port carries it too, both are named, each with its own remedy. The instruction it gives works, and
the chain completes: `no interface vlan 20` → `no vlan 20` → gone from `show vlan`.

### A switch's own address could be created and never removed

`interface vlan 20` + `ip address` addresses the switch on that VLAN: it appears in
`show ip interface brief`, installs a connected route, and answers a ping. Removing it did not work,
in either spelling:

```
SW1(config)#no interface vlan 20
% Interface not found: vlan            <- the two-token spelling read "vlan" as a port name

SW1(config)#no interface Vlan20
% Vlan20 is a physical interface and cannot be removed    <- true of nothing
```

Now:

```
SW1(config)#no interface vlan 20
Interface Vlan20 removed (its address 10.0.20.1 went with it)
  VLAN 20 stays: Fa0/1 still carries it (remove with "no vlan 20")
```

Two objects, two lifetimes: the **interface** is the switch's address, the **VLAN** is a bridge domain
that other ports may still carry, so removing the address does not remove the domain — and the message
says which case applies (*"stays, empty - "no vlan 20" removes it"* when nothing carries it). A physical
port is still refused, now with a reason (*"A port is hardware, not configuration - remove the cable
instead"*), and an SVI is never described as physical.

The line protocol is honest, which is why the route appears only when it should: an SVI whose VLAN has
no up member port shows `up/down` in the brief and installs **no** connected route.

### The `clear` family read every argument as a port

IOS spells these with keywords. This console had only the port spelling, and read anything else as a
port name:

```
SW1#clear mac address-table dynamic
% No interface named dynamic on SW1
% Try "show ip interface brief" for the ports this device has

R1#clear arp 10.0.0.9
% No interface named 10.0.0.9 on R1
```

Both are the argument *misread*, not missing. Now each form narrows what is emptied, and the table is
checked afterwards, because "cleared 2 entries" is only true if the rows are gone:

```
SW1#clear mac address-table
MAC address table cleared on SW1 (2 entries)

SW1#clear mac address-table vlan 99
% No MAC address table for VLAN 99 on SW1 - nothing has been learned there
% Nothing was cleared; "show vlan" lists the VLANs this switch has

R1#clear arp 10.0.0.9
% 10.0.0.9 is a static entry on R1 - it is configuration, not a cache
% Remove it with "no arp 10.0.0.9"
```

`dynamic`, `static` (which says every address here was learned, and points at port-security where a
pinned one lives), `vlan <id>`, `interface <port>` and `address <mac>` are all accepted; a non-switch
answers with the table it does have. `clear arp` takes a port, an address, or `interface <port>` — and
a pinned address is refused with the verb that removes it, rather than silently edited.

`show logging summary last 3` printed **"Event summary (67 of 67 events)"**: the window was parsed and
then dropped on the summary branch. It now reads *"Event summary (last 3 of 67 events)"* and summarises
those three.

### Filters that answered everything, and a table that could not see a row

`show access-lists [<name>]` was on the page and the name was never read:

```
R1#show access-lists TEST
Extended IP access list 101      <- not the list that was asked for
R1#show access-lists NOSUCH
Extended IP access list 101      <- the same table, for a name that does not exist
```

That is worse than having no filter: the operator reads the output as *"yes, that list is here"*.
It filters now, refuses a name that is not there and lists the ones that are:

```
R1#show access-lists NOSUCH
% No access list NOSUCH on R1
% The lists here are: 101, VOICE
```

The same probe found the ARP table's port filter blind to a hand-written entry. `show arp Gi0/0`
answered *"(none)"* while `arp 10.10.0.5 00:11:22:33:44:55` sat in Gi0/0's subnet:

```
R1#show arp Gi0/0
ARP entries on Gi0/0 at R1:
Protocol  Address    Age (min)  Hardware Addr      Interface
Internet  10.10.0.5  -          00:11:22:33:44:55  Gi0/0  STATIC
  1 static entry is hand-written: they never age out, a reply cannot overwrite them
```

A pinned entry has no owner in the topology, so its port came from nowhere; it now comes from the
subnet it sits in. An address outside every local subnet keeps `-` — guessing a port for it would
invent a fact.

### Two processes, one prompt, and a page that belonged to one of them

`router ospf 1` and `router bgp 65001` both say `(config-router)#` — deliberately, because on a real
router it is the same mode. The help page, though, was OSPF's for both:

```
R1(config-router)#?                       <- after "router bgp 65001"
  network <net> <wildcard> area <id>      <- OSPF's verb, refused in a BGP process
  no network <net> <wildcard> area <id>
  router-id <ip>                          <- refused here too
```

`neighbor <ip> remote-as <as>` — the one verb a BGP process has — was not on the page at all. Now the
page follows the process:

```
R1(config-router)#?
  neighbor <ip> remote-as <as>   accept sessions from that address in that AS
  no neighbor <ip>               remove the peer
  bgp router-id <ip>             name this speaker by an address of its own choosing
  exit                           back to global configuration - the process stays running
  end                            leave configuration mode entirely
```

The suite asserts the property rather than the rows: **every row a mode shows is accepted in that
mode.** That is how the rest of this pass came out:

- `bgp router-id <ip>` was `% Unrecognized command` in **global config**, while this console's own
  usage text named it as a config-mode verb — and while the BGP-mode refusal said *"In this mode:
  neighbor <ip> remote-as <as>, bgp router-id <ip>, exit, end"*, pointing at a mode where it worked.
  Both spellings work now, from either mode, and the dump is unchanged.
- `neighbor 10.10.0.2 remote-as 65002` typed **inside an OSPF process** was accepted: it fell through
  to global config, which is what makes a paste without `exit` work, and configured BGP from inside
  the OSPF mode. The fall-through stays; the other process's verbs are now refused there
  (*"That is a BGP verb - "exit" first, then "router bgp <as>""*), while `router bgp <as>` still
  switches processes the way it does on a router.
- `ospf router-id 1.1.1.1` answered **"OSPF enabled, router-id 1.1.1.1 area 0" on a PC** — the same
  defect `router ospf 1` had, in the other spelling. The gate is on the family now, and a device that
  cannot route is shown no `ospf`, `bgp` or `neighbor` row at all.
- Repeating a `neighbor` line said nothing and looked like a second peer; it now answers
  *"BGP neighbor 10.10.0.2 remote-as 65002 is already configured"*, and changing a peer's AS reports
  the change (*"was 65002 … the session restarts against the new AS"*).

### Interface mode had the same defect, one prompt deeper

`?` inside an interface block was not filtered, and two of its rows were **accepted** on devices
that have no use for them:

```
PC1(config-if)#channel-group 1 mode active
Interface eth0 added to channel group 1 (LACP active)     <- a LAG on a one-port host

R1(config-if)#channel-group 1 mode active
Interface Gi0/0 added to channel group 1 (LACP active)    <- a bundle of routed interfaces
```

`show etherchannel` had just been taught to refuse a device that does not switch, so the command and
the view disagreed about the same hardware. Now:

```
R1(config-if)#channel-group 1 mode active
% R1 does not switch, so it has no switch ports to bundle
% A channel-group makes several switch ports act as one link ("show etherchannel")
% Routed interfaces are a routing problem: see "ip route" and "show ip route"
```

Two more, in the same block:

- **`ip ospf cost 10` on a switch** answered *"% OSPF is not enabled - "ospf router-id <ip>" turns
  OSPF on"* — describing a missing *configuration* where the truth is a missing *capability*. A
  device that is not a router now says so: *"% SW1 is not a router: no routing protocol runs on its
  interfaces"*. A router that simply has not started OSPF keeps the configuration answer, because
  there it is the right one.
- **`no power inline` was offered to devices with no PoE ports**, because it shared a row with
  `no mtu`, `no speed` and `no duplex`. A row that bundles four verbs cannot be filtered per verb, so
  the removals were split apart and each one is now gated with its positive form.

`no switchport port-security` was being shown to a PC while the positive form was filtered out — the
page offered the removal of a setting the device could never have had. Any row naming a switchport is
now a switch row, `no` forms included.

**The test found a defect in itself.** The first version of `test/iface-capability.test.js` wrote its
row filter with a doubled backslash, so `rows()` always returned an empty list — and every "is not
offered X" assertion passed, for the wrong reason, on nothing. The suite now starts by asserting that
each page renders more than twenty rows, so a broken filter fails loudly instead of quietly agreeing.

### The `show` views a device could not have, and answered anyway

The helper pages were filtered; the **`show` views were not, and they did not refuse — they
answered**. On a PC with one Ethernet port:

```
PC1#show vlan
VLAN  Name      Status  Ports        <- a VLAN 1, invented, with "-" where the ports would be
1     VLAN0001  active  -

PC1#show spanning-tree
Spanning tree enabled protocol ieee   <- "enabled", on a host
  No bridged ports: this device is not part of any L2 loop.

PC1#show mac address-table
Vlan  Mac Address  Type  Ports        <- a switching table, empty, on a device with one port

PC1#show etherchannel
% No link aggregation groups configured   <- true, and useless: it cannot have any
```

`show port-security` already answered properly — *"does not switch, so it has no secured ports"* —
so the fix was to make its four neighbours agree with it, in the `show` handler **and** on the page:

```
PC1#show vlan
% PC1 is a host: it has no VLANs
% A VLAN is a broadcast domain on something that switches it, or routes between it
% Its own address and gateway are in "show ip interface brief"

R1#show vlan
% R1 does not bridge, so it has no VLAN table
% It can still declare VLAN names for the subinterfaces it routes: "vlan <id> name <name>"
```

A router keeps `show vlan` (once it declares one, the row is listed) but loses `show
spanning-tree`; a switch keeps every table, because it has every one. The page follows the handler,
so a PC's `?` no longer offers `show vlan`, `show spanning-tree`, `show mac address-table`,
`show etherchannel` or `show interfaces <port> switchport`.

One line was invented on the way: the router's VLAN table used to print **VLAN 1** for a router that
never declared it — a fabricated bridge domain, preserved by an assertion that counted three lines
"header plus VLAN 1 and VLAN 99". The assertion was encoding the invention, so it changed with the
behaviour.

### The help page was the same page on every device

`?` printed **62 identical config rows on a PC, a server, a switch and a router**. A host with one
Ethernet port was offered `vlan <id>`, `switchport <verb>`, `spanning-tree vlan <id> root primary`,
`ip nat inside source …` and `router ospf <process-id>`. Worse, four of those were not merely
unhelpful - they were **accepted**:

```
PC1(config)#vlan 10
VLAN 10 created (name: VLAN0010)          <- a bridge domain on a host that does not bridge

PC1(config)#router ospf 1
OSPF process 1 enabled, entering router configuration mode   <- OSPF on a host
```

`switchport` and `router bgp` already refused a device that could not use them; `vlan` and
`router ospf` did not, so the page and the parser were wrong in the same direction. Both now use the
gate their neighbours had, and each says what the device *is* rather than what the command wanted:

```
PC1(config)#vlan 10
% PC1 is not a switch or a router, so it has no VLANs
% A VLAN is a broadcast domain: something has to switch it, or route between it
% A host reaches other networks with "ip default-gateway <gw>"

PC1(config)#switchport mode access
% PC1 does not switch, so no port on it has a switchport to configure
% Switchport verbs belong to a switch
```

The page is now filtered by capability, per verb family — switching on `l2-forward`, routing and the
routing protocols on `l3-forward`, NAT, DHCP server, ACLs, VRRP and IPv6 on their own capability
tags, and the three exec tables (`clear mac address-table`, `clear ip nat translation`,
`clear port-security …`) the same way. A router keeps `vlan <id>`, because it routes between VLANs
and its running-config round-trips the line, but loses `switchport` and `spanning-tree`; an L3 switch
keeps the switchport verbs and loses NAT. Row counts are a poor proxy for that — a router and an L3
switch both show 41 rows today, with different contents.

A `?` that finds nothing because of that filter says so, instead of leaving the operator to wonder
whether the word is a typo:

```
R1(config)#no span?
% Nothing after "no" starts with "span" on R1
% "no spanning-tree vlan <id>" is a command here, but not on R1: it runs no spanning tree, because it
  has no bridged domain to protect
```

The reason comes from the same table that hides the row (`_helpRefusal`), so the page, the completion
list and the parser's own refusals cannot disagree about *why* a family is absent.

**What guards it** (`test/help-truthful.test.js`, 33 assertions):

* every row a device is shown is typed back at that device — placeholders instantiated, optional
  groups dropped — and must not answer `% Unrecognized`, across six generic kinds and two real
  catalogue entries;
* a hidden row must be one the device really refuses, asked of the device rather than assumed;
* the filtered page must be a **subset** of the unfiltered one (`help-coverage`), so the filter can
  hide a row but never invent one.

### BGP had no mode, and the line after it was lost

`router bgp 65001` enabled the process and **stayed in global config**. On a real router it enters
`(config-router)#` — the same mode `router ospf` enters, which this console's prompt was already
claiming. Every BGP block in every lab ends in `exit`, so pasting one dropped the operator to exec on
that line, and every command after it was read as exec and silently lost:

```
R1(config)#router bgp 65001
BGP enabled, local AS 65001
R1(config-router)#neighbor 10.0.0.2 remote-as 65002
BGP neighbor 10.0.0.2 remote-as 65002
R1(config-router)#exit
Leaving router configuration mode
R1(config)#ip access-list extended WEB      <- used to be: % Unrecognized command, and then the rest
Creating extended access list WEB, 1 entry
```

The mode is shared with OSPF (`this.routerKind` records which process is being edited), so `exit`
returns to config, `end` to exec, a verb from the wrong process is refused in that process's words,
and anything that is not a BGP verb leaves the mode and is re-dispatched as configuration — which is
what makes a dump without `exit` pasteable. `router bgp` on a layer 2 switch is refused by name.

**Three more found by the same round trip, in families the first harness did not reach:**

| Symptom | Cause | Now |
| --- | --- | --- |
| `ipv6 route …` appeared twice after pasting a dump twice | the IPv4 table had been made idempotent, the IPv6 table had not | the same identity rule; a re-add says *"already configured: via …"* with the `no` form that removes it |
| `vrrp 1 preempt` was set, was in the group record, and was **not** in the dump | the dump printed only `ip`, `priority`, `advertise` | `preempt` and `no preempt` are both dumped, because *not default* is not the same as *not configured* |
| `spanning-tree vlan <id> root primary` | the dump printed the priority against VLAN 1 whatever VLAN was named, so a switch set up for VLAN 10 pasted back as VLAN 1 - one bridge priority is kept per device, and the dump no longer invents a VLAN | the VLAN the operator named is kept for the dump, and both the confirmation and the `root` form say that one spanning tree covers every VLAN here |
| `show ip bgp summary` read `0 of 0 neighbour(s)` with a peer configured one command earlier | the table was built from the simulator's evaluation, so configuration was invisible until a packet moved | every configured peer is listed, with state `Idle`, reason `not yet evaluated` |
| `mikrotik/RB960PGS` declared `poe-pse, 802.3at, 802.3af`, and `show power inline` said *"neither sources nor draws PoE"* while `power inline never` was refused on every port | per-port power comes only from explicit port records, so a capability list that claims a standard and no port that carries it left the console describing the *device* | the disagreement is reported as what it is: **"% POE1 declares poe-pse, 802.3at, 802.3af, passive-poe in its catalogue entry, but no port record on it carries power-out"** … *"That is a gap in the device specification, not a state of the device"*, and `power inline never` gives the same reason instead of "does not source PoE". The first fix derived a per-port wattage from the declared standard; three catalogue-wide guards refused it and were right - a port's wattage is a datasheet fact, not something to infer from a capability tag |
| a port told `power inline never` with nothing plugged in vanished from `show power inline` | the table was built from powered devices, so the state just configured was the one it could not show | configured-withheld ports are listed with `Admin never` and `off (administratively)` |

### `ip routing`, and configuration that is not the same when applied twice

`ip routing` answered `% Unrecognized config command` on `generic-l3-switch` — a device whose whole
purpose is routing between its VLANs. The model forwarded whenever the device *could*, with no way to
stop it, so the one switch every L3-switch lab sets did not exist:

```
L31(config)#no ip routing
IP routing disabled on L31
  The device still switches within a VLAN, but it will not forward between its interfaces
  Routes stay configured - "ip routing" turns forwarding back on

L31#show ip route
Codes: C - connected, S - static
IP routing is disabled - these routes are configured but will not forward ("ip routing" turns it on)
```

The table is where the lie would otherwise live: every row looks live. `_forwardL3()` checks the flag
first and drops with the reason `IP routing is disabled on L31 ("no ip routing")`, so the ping fails
*as written* rather than silently. The setting is dumped (a paste that dropped it would restore
forwarding somebody turned off), and a host is refused the verb by name, pointed at
`ip default-gateway`.

The same probe — apply a broad reference configuration, dump it, paste it into an identical device,
compare the two dumps — is now a test over five device kinds (`generic-switch`, `generic-l3-switch`,
`generic-router`, `generic-pc`, `generic-server`). It found a second class of defect immediately:
**pasting a dump twice was not the same as pasting it once.**

```
R1(config)#access-list 110 permit tcp 192.168.5.0 0.0.0.255 any eq 443
Extended access list 110 (10): permit entry added
R1(config)#access-list 110 permit tcp 192.168.5.0 0.0.0.255 any eq 443
Extended access list 110: that entry is already there at sequence 10 - the list is unchanged

R1(config)#ip route 10.0.0.0 255.255.0.0 10.10.0.254
Route added: 10.0.0.0/16 via 10.10.0.254
R1(config)#ip route 10.0.0.0 255.255.0.0 10.10.0.254
10.0.0.0/16 is already configured: via 10.10.0.254
  The table is unchanged - "no ip route 10.0.0.0 255.255.0.0" removes it
```

Three list-shaped settings appended blindly: static routes, ACL entries (both spellings) and — before
this pass — NAT rules, which already had the guard. An identical ACL line used to double its match
counter and lengthen every dump; an identical route used to appear twice in `show ip route` with the
same administrative distance. Identity is now the library's (`acl.entryKey`) or the route's own five
fields, so a paste is idempotent and a `show` of a table says how many rules it really has.

`switchport mode access` typed at global scope now answers the way `vrrp` does — *which mode the verb
lives in*, and what it takes — instead of `% Unrecognized config command: switchport mode access`.

### The two commands every OSPF lab starts with, and this console did not have

Found by writing a **dump-and-paste round trip** over a broad reference configuration: applying that
config produced a list of refusals, and in it was

```
R1(config)#router ospf 1
% Unrecognized config command: router ospf 1
R1(config)#network 10.10.0.0 0.0.0.255 area 0
% Unrecognized config command: network 10.10.0.0 0.0.0.255 area 0
```

`router bgp <as>` was implemented, so this was not a simplification anyone had decided on — it was an
asymmetry, and the OSPF half is the one every lab guide types. The model keeps the area on the
*interface* (`ip ospf area`), which is why `network` had no home: it is the shorthand that writes that
per-interface property.

```
R1(config)#router ospf 1
OSPF process 1 enabled, entering router configuration mode
  "network <net> <wildcard> area <id>" sets the area on every interface it matches
  "router-id <ip>" names this router; "exit" leaves the mode
R1(config-router)#network 10.0.0.0 0.0.0.255 area 0
Network 10.0.0.0 0.0.0.255 area 0 put 1 interface in area 0
  Gi0/0 (10.0.0.1): area 0
```

`network` says **which interfaces it matched**, and that is the whole point of the command here. IOS
accepts a statement that matches nothing in silence — the adjacency then never forms and nothing in
the configuration looks wrong. This console refuses it and says why:

```
R1(config-router)#network 10.9.9.0 0.0.0.255 area 0
% No interface of R1 matches 10.9.9.0 0.0.0.255 - nothing was changed
% The interfaces and their addresses are in "show ip interface brief"
% IOS would accept this in silence, and the adjacency would never form
```

The areas it writes are the ones the adjacency check already read, so a mismatch is explained rather
than mysterious (`R2 on Gi0/0 is in area 1 and this interface is in area 0 - no adjacency without a
matching area`), and agreeing makes the adjacency `FULL`.

**A pasted configuration does not say `exit` before `interface Gi0/1`.** A line that is not a
router-mode verb leaves the mode and is re-dispatched as global configuration, because refusing it
would lose the line and the paste would continue with a configuration that is subtly wrong.

The process id survives the dump as `router ospf <pid>` with one host-wildcard statement per
interface that carries an area — so a paste lands exactly the areas that were there, not a wildcard
that happens to cover them.

**Two defects this turned up in code that was already passing tests.** `show ip ospf` printed the
constant `Routing Process "ospf 1"` — right only for the one id nobody had been able to configure —
and now prints the real id (or says it is not configured yet). And the abbreviation pass rewrote
`router ospf 1` typed inside router mode into **`router-id ospf 1`**, because `router` is a prefix of
`router-id` *in that mode*, then refused it with a message about `router-id` — a refusal naming a
command the operator never typed. A word that is already a complete command of the enclosing
configuration is now never abbreviated into something else.

### Commands from a lab guide, and the word this console answers with

A real switch answers `show cdp neighbors`, `show inventory`, `show processes cpu`, `show users`,
`show line`. This one has none of them, and answered `% Invalid show command: cdp neighbors` — which
reads like a typo, so the operator retypes it and then goes looking for a bug that is not there.
Being told *what this console answers instead* is the difference between a dead end and a redirection:

```
SW1#show cdp neighbors
% CDP is not modelled: nothing here speaks it
% These devices speak LLDP, and the table is the same one you were asking for:
%   show lldp neighbors [<port>]      who is on the other end of each port
%   show lldp neighbors detail        chassis, port, TTL and medium per neighbour
%   show lldp interface               the per-port transmit/receive decision

SW1#show processes cpu
% No CPU and no scheduler: every device forwards at line rate in this model
% The only delay is serialisation at each port, and it is reported per packet:
%   show interfaces counters            packets, bytes and drops per port
```

The families an operator reaches for when a device misbehaves were the ones still answering like
typos, and `show tech-support` was the worst of them — it is the *first* command typed when something
is wrong:

```
SW1#show tech-support
% There is no tech-support bundle here: no memory image, no register state, no log file to collect
% The views that answer the same questions in this model:
%   show version / show running-config     what this device is and how it is configured
%   show interfaces / show interfaces counters   ports, addresses and per-port drops
%   show ip route / show ip ospf / show ip bgp summary   the forwarding state
%   show logging / show history            what happened, and what was typed

SW1#show memory
% No memory, buffers or controller registers: this model keeps no hardware counters
% What it does keep is the forwarding state and what happened to each packet:
%   show interfaces counters   packets, bytes and drops per port
%   show logging              every drop, with the reason it was dropped
```

`show memory`, `show buffers` and `show controllers` share one sentence (no hardware counters),
`show flash`, `show filesystems`, `show boot` and `show license` another (nothing is stored on disk,
and `write memory` is where configuration actually lives), `show module`/`show stack` a third (one
fixed chassis). None of them invents a number: a fabricated free-RAM figure would be the same class of
lie as the invented VLAN 1 rows this series removed.

One table (`_absentShow`) holds the whole family: CDP → LLDP, inventory → `show version` and
`show interfaces transceiver`, environment and PSU readings → `show power inline`, users/sessions/line
→ this one console, cpu → the per-port counters, NTP → the fact that time here is an *instant* you ask
about, and `show switchport` → the three tables that split a port's L2 state between them. Every
pointer in those sentences is a command the test runs, because a refusal that recommends something
absent is the defect this whole series is about.

`show history` was the one of these that deserved to exist rather than be explained: the console keeps
the lines typed into it, bounded at 200, and prints the last 10 the way IOS does. Asking for the
history is deliberately *not* recorded — a question that changes its own answer is the same defect as
a `show` that moves a counter.

Two commands did come out of the sweep as real work:

* **`show interfaces <port> switchport`** — the word was silently dropped and the plain counters view
  printed instead, so an operator checking a trunk was told nothing about it. It now prints
  administrative/operational mode, access VLAN (with its name) or native VLAN and allowed list, port
  security state, description and channel-group. Two bugs found by running it: the shut marker read
  `iface.shutdown` where the model stores `enabled` (so no port ever showed as shut), and the access
  VLAN line ended in a trailing space when the VLAN had no name.
* **`show interfaces vlan <id>`** — the two-word spelling of an SVI was read as a port called `vlan`;
  `show interfaces counters errors` was read as a port called `errors`.

### One LLDP view, and three questions it could not answer

`show lldp neighbors` was the only LLDP view the console had, so the three things that decide what
that table can possibly contain had no question:

```
SW1#show lldp neighbors detail
% No interface named detail on SW1
SW1#show lldp traffic
LLDP neighbours on SW1:        <- the neighbour table, answering a different question
SW1#show lldp interface
LLDP neighbours on SW1:        <- the same table again
```

The first is the familiar defect (a keyword read as a port name). The other two are worse: a **wrong
answer**, which nothing in the output marks as wrong. `show lldp interface` and `show lldp traffic` now
answer their own questions, from state the model already had:

```
SW1#show lldp
Global LLDP Information:
    Status: ACTIVE
    LLDP advertisements are sent every 30 seconds
    LLDP hold time (before discarding): 120 seconds
    Announcements on: Fa0/1, Fa0/2
    Neighbours learned: 2

SW1#show lldp interface
LLDP interface state on SW1:
  Device state: ACTIVE
  Port   Tx       Rx       Cabled  Neighbour
  Fa0/1  disabled  enabled  yes     SW2
  Fa0/8  enabled   enabled  no      -
```

`no lldp transmit` moves one column on one port and leaves the neighbour in place — SW2 keeps
announcing, we simply stopped answering — which is the distinction the per-port view exists to show.
`show lldp neighbors detail` prints one block per neighbour from the LLDPDU that arrived (chassis id,
port id, description, TTL, medium and speed, and whether our own port is passing frames).

**The counters are port state, not a walk of the event log.** `show lldp traffic` reads
`lldpTxFrames` / `lldpRxframes` / `lldpDiscarded` off the interface, written where a DU is sent or
heard, so `clear logging` cannot empty them:

```
SW1#show lldp traffic
LLDP traffic on SW1:
  Port   Tx frames  Rx frames  Discarded  Errors
  Fa0/1  1          0          1          0
  Totals: 2 sent, 1 received, 1 discarded by "no lldp receive"
```

A DU that arrives while the port is told not to listen is **discarded, not unheard** — a counter that
did not move would suggest the frames never arrived, which is a different fault.

`show lldp interface detail` is answered by name rather than read as a port: the word belongs to the
neighbour table, and the refusal says so.

### A neighbour table is a record, so it says when the record is history

The table is filled by frames that crossed the link, which is the reason to model LLDP at all rather
than read the cable out of the device spec. The other half of that sentence was missing: nothing ever
took an entry away again. Pulling the cable out of the topology did — `topology.disconnect()` drops
it — but shutting the port did not, and `show lldp neighbors detail` went further and said our port
was *passing frames*:

```
PC1#configure terminal
PC1(config)#interface eth0
PC1(config-if)#shutdown
eth0 administratively down

PC1#show lldp neighbors
LLDP neighbours on PC1:
  Neighbour  Local port  Port ID  Mgmt address
  SW1        eth0        Fa0/1    -
  eth0: SW1 was heard here, but this port is administratively down
  Those rows are what crossed the link, not what is there now: no timer expires
  them, so an entry stays until the port passes frames again or is told to stop.
```

The line the detail block used to print was `Local port state: up (the announcement is what proves
the link is passing frames)`, taken from `lineUp` alone — and `lineUp` is about the cable, not the
administrator, so a port that had been shut read **up**. Both views now take the state from
`_ifaceState`, the single answer every other table already uses, and the sentence about frames is
printed only when it is true:

```
PC1#show lldp neighbors detail
Local port state: administratively down/down - this port is administratively down, so this block is what was learned, not what is there now
```

A shut port at the far end is named the same way, because our own port is genuinely up — the reason
comes from the other end of the cable:

```
  eth0: SW1 was heard here, but the far port Fa0/1 on SW1 is administratively down
```

No timer expires these rows, because this model keeps none: a fabricated hold-time would be a number
rather than a fact, and the advertised TTL is what the DU claimed, not a countdown. The entry stays
until the port carries frames again — undo the shutdown and the note clears — or the port is told to
stop listening, which drops what it heard.

The same sweep turned up one more word read as a value: `show vlan name users` answered
`% Invalid VLAN id "name"`. VLANs have names here, so `show vlan name <name>` now resolves one
(case-insensitively), narrows the table, and on a miss lists the names that do exist. Two bugs in that
one: a declared VLAN is a record (`{ name }`), so reading it as a string printed
`% Names here: [object Object], [object Object]`; and the trailing-word refusal quoted
`show vlan [<id>|brief]` while the operator had typed `show vlan name users`, so the synopsis now
matches the form that was used.

### Three settings the detail view printed and nothing could configure

`show port-security interface` printed this from the day the feature landed:

```
Aging Time                 : 0 mins
Aging Type                 : Absolute
SecureStatic Address Aging : Disabled
```

…and `switchport port-security aging time 1` was `% Unrecognized port-security command: aging`. Three
lines of a show command describing a device that was not there — the same defect as recommending a
command that does not exist, one layer quieter. Aging is also the setting that makes port security
usable: without it the port is pinned to whoever was plugged in when it was configured.

```
SW1(config-if)#switchport port-security aging time 1
Aging time on Fa0/1 set to 1 min
  An address that has not been held for 1 min leaves the port, and the slot is free for the next station

SW1(config-if)#switchport port-security aging type inactivity
Aging type on Fa0/1 set to inactivity (was absolute)
  the clock resets every time the address is seen, so a quiet station ages out
```

**"Now" is the instant being asked about**, the same `at <ms>` the rest of the console reads time from
(`sim.setRunTime(ms)` from a test), because this lab has no wall clock to age against. That makes the two
types genuinely different, and observable:

| type | clock starts | traffic |
|---|---|---|
| `absolute` | when the address is learned | does not reset it — the address dies on schedule |
| `inactivity` | at the last sighting | resets it — a quiet station ages out, a talking one does not |

Aging runs **before** the ingress decision (in `_processFrame`) and again whenever a `show` asks a
question at an instant, so an address that has aged out is simply not held any more: the frame that
arrives after it left is **learned as the new occupant, not refused as a violation**. That is the whole
point, and the test asserts both sides — refused while the slot is held, accepted once it is free.

Configured addresses are configuration and are permanent by default; `aging static` makes them age too.
The one bug that made that flag a no-op is worth naming: a configured address had **no timestamp** at
all, so the sweep skipped it forever — the command was accepted and did nothing. Configuring an address
now records the instant it was held from.

The empty table also explains itself, because "no secure addresses" has two very different causes:

```
SW1#show port-security address
% No secure addresses at this instant: 1 aged out (02:00:00:00:01:00 on Fa0/1)
% Secured ports with a free slot: Fa0/1
```

Every word is validated where it is typed (a time outside 1–1440, `0` refused with a pointer at
`no … aging time` rather than being silently accepted, a type that is not one of the two, a missing or
extra argument), the three settings are dumped inside the interface block and paste back, and a port
left on the defaults contributes no line.

### The command the console recommended did not exist

Recovering an err-disabled port printed this:

```
SW1(config-if)#no shutdown
Fa0/1 up
  err-disable cleared: port security violation: 02:00:00:00:99:99 on a port that allows 1
  Security violation count kept at 1 - "clear port-security counters" resets it
```

…and `clear port-security counters` was `% Unrecognized command`. The console was pointing at a command
it did not have — which is worse than a missing feature, because it sends the operator somewhere that
does not exist. Three words now exist, and they clear three different things:

```
SW1#clear port-security counters
Security violation counters cleared on SW1 (1)
  The ports stay as they are: a count of what happened, not the state it left behind - was Fa0/1 (1)

SW1#clear port-security dynamic
Learned secure addresses cleared on SW1 (1)
  Configured and sticky addresses are kept: they were not learned

SW1#clear port-security sticky
Sticky secure addresses cleared on SW1 (1)
  The stations must be learned again, and the next one may be a different station
```

* **`counters`** resets the violation count and nothing else: the port stays err-disabled (that is a
  separate decision, made with `no shutdown`), and the addresses it holds stay held.
* **`dynamic`** forgets what was learned and keeps what was written or pinned — a clear that unsecured
  a configured station would be a clear that edited the configuration.
* **`sticky`** unpins the pinned addresses, which is the only one of the three where the *next* station
  to arrive may be a different station, and the answer says so.

All three take an optional `interface <port>`, report what they cleared and what they left, and say
"nothing to clear" the second time. From exec they ask for enable mode with the same sentence as
`clear arp`; in config mode both are `% Unrecognized config command`, because a clear is not
configuration.

### Two smaller lies found in the same sweep

* `show port-security address` printed a **constant VLAN of 1** for every row, so a station secured on a
  port in VLAN 20 was reported as being in VLAN 1. The column now reads the port's own VLAN (`trunk`
  for a trunk).
* `vlan 20 name users` created a VLAN called **"name users"**: the console takes `vlan <id> [name]` on
  one line, and the IOS keyword `name` was swallowed as part of the name. It is now consumed as the
  keyword, so both spellings name the VLAN `users`.
* And the table that followed: `vlan 20` then `show vlan` printed **VLAN 1 and nothing else**, because
  the table was built from membership only — while `show vlan 20` answered for the VLAN the table had
  just denied. A declared VLAN with no ports is now a row with `(no ports)`.

### Port security: a bridge that finally has an opinion

The model learns a source MAC per port and VLAN and forwards to what it has learned. That is a bridge
doing its job with no opinion about who is allowed to speak — and there was no way to give it one:

```
SW1(config-if)#switchport port-security
% Unrecognized interface command: switchport port-security
SW1#show port-security
% Invalid show command: port-security
```

Port security is the opinion, and the three violation modes are the point, because they differ in what
they cost:

```
SW1(config-if)#switchport port-security
Port security enabled on Fa0/1
  Maximum 1 secure address, violation mode shutdown (IOS defaults)
  The first source to arrive is learned; a second one is a violation

SW1#show port-security
Secure Port  MaxSecureAddr  CurrentAddr  SecurityViolation  Security Action
Fa0/1 (err-disabled)  1       1            1                  shutdown
  1 secured port of 8 bridged ports
  1 err-disabled by a violation: Fa0/1 - "shutdown" then "no shutdown" recovers

SW1#show interfaces status
Port   Name  Status        Vlan  Duplex  Speed  Type
Fa0/1        err-disabled  1     a-full  a-1G   ethernet
```

* **`protect`** drops the frame, counts nothing, logs nothing — the port keeps working for its own
  station, and the incident leaves no trace, which is exactly why the mode is not the default.
* **`restrict`** drops the frame and counts it. The port stays `Secure-up` and the counter is the
  evidence: two intruding frames are two violations.
* **`shutdown`** (the default) drops the frame, counts one violation and **err-disables the port**. One
  incident is one violation, not one per frame: further frames are dropped without being counted again.

The checks run **before the CAM learns anything**, so a refused source is never in the MAC table — the
two tables cannot contradict each other. A violation sets the port's line state, so `show interfaces`,
`show interfaces status` (`err-disabled`, not `notconnect` — something *is* plugged in) and
`show port-security` all describe the same port. Recovery is the port's own word, `shutdown` then
`no shutdown`, and the answer keeps the violation count:

```
SW1(config-if)#no shutdown
Fa0/1 up
  err-disable cleared: port security violation: 02:00:00:00:99:99 on a port that allows 1
  Security violation count kept at 1 - "clear port-security counters" resets it
```

Three `show` views, because they answer three questions: `show port-security` (which ports are secured,
how many addresses, how many violations), `show port-security interface <port>` (why *this* port is
refusing traffic — `Secure-up`/`Secure-shutdown`, the mode, the counts, the last source seen), and
`show port-security address` (which station is pinned where, as `SecureConfigured`, `SecureSticky` or
`SecureDynamic`).

Every word is validated where it is typed: a limit outside 1–3072, a mode that is not one of the three,
a MAC that is malformed or multicast, a station that is already secure on another port ("one station is
one port"), a trunk port (this model secures access ports), a logical interface, and a router ("does not
switch, so it has no port to secure"). Lowering the limit below what a port already holds is allowed and
says what it means: the addresses are kept and the next new source is a violation.

### An ARP cache that could only be learned into

Every packet this model routes reads the ARP cache before it decides whether to ask, so the cache is
real — and every entry in it could only ever be *learned*. The previous pass added `clear arp` to empty
it; there was still no way to write into it:

```
R1(config)#arp 10.0.0.50 0200.0000.0100 arpa
% Unrecognized config command: arp 10.0.0.50 0200.0000.0100 arpa
```

A static entry is the one thing an operator puts in that table by hand, and the one entry the lab must
not be able to take back:

```
R1(config)#arp 10.0.0.50 0200.0000.0100 arpa
Static ARP entry on R1: 10.0.0.50 is at 02:00:00:00:01:00
  This entry never ages out and a reply cannot overwrite it - "no arp 10.0.0.50" removes it

R1#show arp
Protocol  Address    Age (min)  Hardware Addr      Interface
Internet  10.0.0.50  -          02:00:00:00:01:00  Gi0/0  STATIC
  1 static entry is hand-written: they never age out, a reply cannot overwrite them, and "clear arp" leaves them

R1#clear arp
ARP cache on R1 was already empty - nothing to clear
  1 static entry kept - they are configured, not learned (remove with "no arp <ip>")
```

Four rules hold it together, and each one is a thing that used to be impossible to show:

* **The entry is used, and ARP is never asked.** With a static entry for a reachable host, the timeline
  contains no `arp-request` at all — the forward event says `via: arp-static`, not `arp-cache`, because
  a frame that never read the cache must not be reported as if it did. A wrong entry is used as written,
  and the ping fails: that is the reason it has to be right, not a bug.
* **A reply cannot overwrite it.** This is the part that makes a static entry a defence rather than a
  hint. A reply from another host claiming the same address is refused, an `arp-static-hold` event names
  the MAC that offered itself and the MAC that was kept, and the pending frame is sent to the configured
  MAC. Without the entry the identical reply is believed — the test asserts both directions.
* **`clear arp` empties only what was learned.** A command documented as clearing the cache must not
  silently edit the running-config, so the hand-written rows survive and the output says how many were
  kept and how to remove them (`no arp <ip>`).
* **It is configuration.** Static entries are in `show running-config` in the spelling the console
  accepts (`arp 10.0.0.50 0200.0000.0100 arpa`) and paste back; learned entries are not, because they
  are not configuration.

Both MAC spellings are accepted (`0200.0000.0100`, `02:00:00:00:01:00`) and stored in the one form the
tables print; the optional `arpa` word is optional and not a slot for anything else; and a MAC nothing
can be reached at is refused by name — the all-zero MAC, and a multicast MAC (`01:00:5e00.0001` is a
group, not a host).

### The two settings that decide what a name query even means

Name resolution worked and could not be configured. It was always on, and a name was always asked
exactly as typed:

```
PC1(config)#ip domain-name lab.test
% Unrecognized config command: ip domain-name lab.test
PC1(config)#no ip domain-lookup
% Unrecognized config command: no ip domain-lookup
```

A lab about DNS is mostly about those two facts — *show me that resolution can be switched off*, and
*why does `ping www` answer here* — and neither had a command.

```
PC1(config)#ip domain-name lab.test
Domain name on PC1 set to lab.test
  An unqualified name is now asked as name.lab.test first

PC1#ping www count 1
Translating "www"...domain server (R1)
  (as www.lab.test - "ip domain-name" appended the suffix)
Type escape sequence to abort.
Sending 1, 100-byte ICMP Echos to 10.0.0.50, timeout is 2 seconds:
!
Success rate is 100 percent (1/1)

PC1(config)#no ip domain-lookup
Name lookup disabled on PC1: a name is refused instead of resolved, and an address still works
  "ip domain-lookup" puts it back

PC1#ping www.lab.test count 1
% Cannot resolve www.lab.test: name lookup is disabled on PC1 (no ip domain-lookup)
% Use the address, or put resolution back with "ip domain-lookup"

PC1#ping 10.0.0.50 count 1
Success rate is 100 percent (1/1)
```

Three details matter more than the commands:

* The **suffix applied is shown** (`as www.lab.test`), so an answer that arrived from a name you did not
  type is explained rather than guessed at — and `traceroute` says the same thing, because two commands
  resolving one name must not describe it differently.
* A disabled lookup is **not blamed on a missing zone**. `% Cannot resolve … name lookup is disabled`
  names the switch and the way back, because `% Unknown host` would send the operator to look at DNS.
* An **address still works** with lookup off — which is the diagnostic value of the switch, and is what
  the test asserts, rather than only that names fail.

`show dns` prints both settings beside the zones they govern, a suffix that cannot be a DNS name is
refused where it is typed (empty label, leading or trailing hyphen, a character a name cannot carry, a
label over 63 characters), and both lines ride in `show running-config` and paste back.

### A neighbour table that could only ever fill

The LLDP neighbour table is trustworthy for one reason: it is filled from LLDPDUs that really crossed
the link, not from the topology file. It also had no off switch:

```
SW1(config)#no lldp run
% Unrecognized config command: no lldp run
SW1(config-if)#no lldp transmit
% Unrecognized interface command: no lldp transmit
SW1(config-if)#no lldp receive
% Unrecognized interface command: no lldp receive
```

So the table could only grow, and the only way to empty it was to unplug the cable — which is also the
one thing you cannot do when the lab is about a device that must not be discovered. Three decisions
now exist, at three scopes:

```
SW1(config)#no lldp run
LLDP disabled on SW1: no port announces and none listens
  2 neighbours forgotten; peers keep their entries until they stop listening
  "lldp run" turns it back on; "no lldp transmit|receive" does it for one port

SW1#show lldp neighbors
% LLDP is disabled on SW1 (no lldp run)
% No port announces and none listens, so no neighbour can be learned
% "lldp run" turns it back on

SW1(config-if)#no lldp receive
LLDP receive off on Fa0/1: the port is no longer listening
  The neighbour learned earlier on this port (SW2) is dropped: this port no longer listens.

SW1#show lldp neighbors Fa0/1
% Fa0/1 is not listening for LLDP (no lldp receive)
% Nothing can be learned on it until "lldp receive" is put back
```

Three details make the answers honest rather than convenient:

* `no lldp receive` **drops what that port had already heard**. This model keeps no hold timer, so an
  entry left behind would be a neighbour the port refused to hear — the table would contradict the
  decision.
* `no lldp transmit` says plainly that the **peer keeps its entry**, because ageing is what would
  remove it and there is no ageing here: *"this model keeps no timers, so it stays"*.
* `show lldp neighbors` on a disabled device answers with the state, never with
  `(none - no LLDP has been heard)`, which reads like a cabling fault.

Transmit and receive are independent per port, so a lab can have a switch that announces but does not
listen — the shape you need to show what a neighbour table is *for*. All three decisions are dumped
(`no lldp run` globally, `no lldp transmit` / `no lldp receive` inside the port's block) and paste
back, and every `no` form is a row `?` can see.

### A port that can refuse power, and a console that could not

PoE was one of the most completely modelled planes in this simulator: a budget per device, an
allocation per port, a powered device marked unpowered, and its frames refused with `poe-deny`. The
one decision an operator actually makes about it did not exist:

```
SW1(config-if)#power inline never
% Unrecognized interface command: power inline never
% Unrecognized config command: power inline never
```

Power was only ever withheld by a budget running out — a number the operator could watch but not
spend. `power inline never` is how you free budget for a camera that needs it:

```
SW1#show power inline
Power inline on SW1:
  Budget       : 67 W  (from research)
  Used         : 14 W
  Available    : 53 W
  Port    Admin   Powered device        Requested  Status
  1       auto    AP1                   7 W        on
  2       auto    AP2                   7 W        on

SW1(config)#interface 1
SW1(config-if)#power inline never
Power inline on 1 set to never (was auto)
  No device on this port will be powered, and its watts are freed for other ports.
  AP1 is on this port and will lose power on the next run

SW1#show power inline
  Used         : 7 W
  Available    : 60 W
  Port    Admin   Powered device        Requested  Status
  1       never   AP1                   7 W        off (administratively)
  2       auto    AP2                   7 W        on
```

The refusal is a decision, so it is checked **before** the budget and recorded as its own event
(`poe-admin-off`), not as a shortage: the port is refused and its watts stay available to the ports
that do want them. `no power inline` returns the port to auto, and says what that does and does not
promise (`a detected device will be powered` — whether it gets the watts is still the budget's
answer).

```
SW1(config-if)#power inline static
% "power inline static" (pre-allocated power) is not modelled
% This PSE grants power when a device is detected and refuses it when the budget runs out;
% pre-allocation would reserve budget for a port that may never use it, which changes
% nothing this simulator measures. Use "power inline never" to withhold, or "auto".
SW2(config-if)#power inline never
% SW2 does not source PoE, so Fa0/1 has no power to give
% PoE-out ports appear in "show power inline" on the devices that have them
```

A port that cannot source power names the ports that can; a device that cannot source power at all
says so instead. The line appears in `show running-config` inside its interface block and pastes
back, so a withheld port is not silently re-powered by a restore.

### The table a switch operator lives in, and the state column that lied

Two commands an operator types before anything else did not exist, and the state column they read was
wrong for every port nobody had plugged in:

```
SW1#show interfaces status
% "show interfaces status" is not a command here
SW1#show interfaces description
% "show interfaces description" is not a command here
R1#show ip interface
% Invalid show command: ip interface
SW1#show ip interface brief
Fa0/1     unassigned    YES  manual  up    up      <- cabled to PC1
Fa0/5     unassigned    YES  manual  up    up      <- nothing plugged in
```

The first two are the reason you give a port a description at all. The label was stored, dumped and
pasted back, and could only ever be read one port at a time. The third is the detail view of a table
that already existed. The fourth is the real defect: `lineUp` was maintained only for SVIs and
subinterfaces, so a physical port answered `up/up` in **every** table with a state column, because
nothing had told it there was no cable.

```
SW1#show interfaces status
Ports on SW1 (8):
Port   Name            Status      Vlan   Duplex  Speed  Type
Fa0/1  to PC1          connected   1      a-full  100M   ethernet
Fa0/2  uplink to R1    connected   1      a-full  a-1G   ethernet
Fa0/3                  notconnect  20     a-full  a-1G   ethernet
Fa0/4  spare (unused)  disabled    1      a-full  a-1G   ethernet
Fa0/5                  notconnect  1      a-full  a-1G   ethernet
...
2 connected, 1 disabled, 5 notconnect

SW1#show interfaces description
Interfaces on SW1 (8):
Interface  Status                 Protocol  Description
Fa0/1      up                     up        to PC1
Fa0/4      administratively down  down      spare (unused)

R1#show ip interface Gi0/0
Gi0/0 is up, line protocol is up
  Internet address is 10.0.0.1/24
  Broadcast address is 10.0.0.255
  MTU is 1500 bytes
  NAT role: inside
  Inbound access list is 10
```

Each column is a fact the model already held — the label typed on the port, its shutdown, its cable,
its VLAN, its negotiated speed — so nothing is derived twice: `computePortState()` decides a port's
line from shutdown + cable + link (the same three things the data path requires before it will
forward out of the port), and every table with a state column reads that one answer. `show interfaces
status` also counts its own rows (`2 connected, 1 disabled, 5 notconnect`), and the count is asserted
against the rows so a summary cannot drift from the table above it.

The state vocabulary follows IOS: a **physical** port with no cable is `down/down` in `show ip
interface brief` and `notconnect` in `show interfaces status`, while a **logical** interface is
`up/down` (`Vlan30  up  down`) because it is not shut and its line protocol is what is waiting —
`show ip interface` names the reason (`Line state: no port is cabled`) in both cases.

### A keyword is not a port name

Every `show` verb that takes an optional port argument reads an unrecognised word as a port, which is
right for a typo'd port name and wrong for a real IOS sub-word:

```
SW1#show spanning-tree summary
% No interface named summary on SW1
SW1#show spanning-tree root
% No interface named root on SW1
SW1#show mac address-table count
% No interface named count on SW1
SW1#show mac address-table dynamic
% No interface named dynamic on SW1
R1#show ip arp 10.0.0.50
% No interface named 10.0.0.50 on R1
```

Five commands sent the operator to look for a port that cannot exist. None of them needed new data:
the spanning-tree election already stores the root, its bridge ID and the root path cost; the MAC
table already holds every learned entry; the ARP cache is keyed by address.

```
SW1#show spanning-tree summary
Spanning tree enabled protocol ieee - summary for SW1
  Root bridge: priority 32768, 02:00:00:00:00:00 (SW1) - this bridge
  Root path cost: 0
  Ports in the tree: 3 (root 0, designated 3, alternate 0)
  Port states: 3 forwarding

SW3#show spanning-tree summary
  Root bridge: priority 32768, 02:00:00:00:00:00 (SW1)
  Root path cost: 20000
  Ports in the tree: 2 (root 1, designated 0, alternate 1)
  Port states: 1 forwarding, 1 blocking
  1 port is blocking: the loop is cut, which is the tree working

SW3#show spanning-tree root
Root bridge for VLAN 1: priority 32768, 02:00:00:00:00:00 (SW1)
  Root path cost for SW3: 20000
  Root port: Fa0/2

SW1#show mac address-table count
Mac address table count on SW1:
Vlan  Entries
1     3
  Total: 3 dynamic, 0 static, 0 secure

SW1#show mac address-table static
% No static MAC entries on SW1
% This model learns every entry from traffic, so all 3 are dynamic - see "show mac address-table count"

R1#show ip arp 10.0.0.50
Protocol  Address       Age (min)  Hardware Addr     Interface
Internet  10.0.0.50  -          02:00:00:00:01:00  -
```

The summary is rendered from the same election that prints the table, so the counts cannot drift from
the rows: `Port states:` counts exactly the rows `show spanning-tree` prints, and the root port named by
`show spanning-tree root` is the port the table calls `root`.

A word that is neither a port nor a keyword is now refused **as a keyword**, with the shapes the
command does take:

```
SW1#show spanning-tree bogus
% show spanning-tree takes a port, or summary / root - not "bogus"
% The ports this device has are in "show ip interface brief"
R1#show arp bogus
% show arp takes a port, or an address - not "bogus"
R1#show ip arp 10.0.0.99
% No ARP entry for 10.0.0.99 on R1
% The cache holds 2 addresses - "show arp" lists them, and a ping to 10.0.0.99 would learn it
```

`show spanning-tree summary` on a router is refused by naming why (`R1 does not bridge, so it runs no
spanning tree`), and `show mac address-table vlan abc` is refused with the range rather than a filter
that matches nothing.

The literal word `interface` still means a port, so a word after it is refused as a missing port and
not as a misused keyword:

```
SW1#show mac address-table interface 22
% No interface named 22 on SW1
% Try "show ip interface brief" for the ports this device has
```

### The three settings every operator reaches for first

`mtu`, `speed` and `duplex` are what you type when a link misbehaves, and none of them existed:

```
R1(config-if)#mtu 1400
% Unrecognized interface command: mtu 1400
% Unrecognized config command: mtu 1400
R1(config-if)#speed 100        -> the same two lines
R1(config-if)#duplex full      -> the same two lines
```

On a switch port too. Meanwhile the model already carried `iface.mtu`, `iface.speed` and
`iface.duplex`, already derived a **path MTU** from the MTU (the minimum over the path) and already
derived a **spanning-tree path cost** from the speed. The settings were used by the engine and
unreachable from the console.

```
R1(config-if)#mtu 100
MTU on Gi0/0 set to 100 (was 1500)
  Frames larger than 100 bytes on this port will be dropped, and flows
  routed through it derive their MSS from 100 (see "show flow <id>")
```

and the drop is real, named, and counted:

```
PC1>ping 198.51.100.9 count 1
Success rate is 0 percent (0/1)
R1#show interfaces Gi0/0
  MTU 100 bytes (configured), duplex full (default), speed 1G (negotiated)
  drops : 1  (1 frame of 134 bytes exceeds the 100-byte MTU on Gi0/0)
```

`speed` is not a label either — the spanning-tree cost follows it:

```
SW1(config-if)#speed 100
Speed on Fa0/2 set to 100M (was 1G)
  Spanning-tree path cost from this port is now 200000 (was 20000)
```

The hardware decides what can be asked for, and the refusal lists the caps:

```
R1(config-if)#speed 10000
% Gi0/0 cannot run at 10000 Mbps - it supports 10, 100, 1000 Mbps
% Usage: speed <10-100000>
```

`duplex half` is **refused rather than faked**, because this simulator has no collision domain, no
backoff and no shared medium — a "half" port would behave exactly like a full one while claiming
otherwise:

```
R1(config-if)#duplex half
% Half duplex is not modelled: this simulator has no collision domain, no backoff and
% no shared medium, so a "half" port would behave exactly like a full one while claiming
% otherwise. Use "duplex full", or leave it at "auto".
```

`show interfaces` separates what was configured from what was inherited (`(configured)` /
`(default)` / `(negotiated)`), `show running-config` carries only the three lines an operator
actually typed, and `no mtu` / `no speed` / `no duplex` each report what they restored.

### The removal half of the command set is a command too

Thirty `no` branches and nine help rows. The commands all worked; `?` could not see any of them, so
an operator could set a thing and then had to already know the way back:

```
R1(config)#no vlan ?
% No completions for "no vlan"
R1(config)#no ip nat ?
% No completions for "no ip nat"
R1(config)#no spanning-tree ?
% No completions for "no spanning-tree"
R1(config-if)#no ip nat ?
% No completions for "no ip nat"
```

Now every one of them is a row in its own right, in the mode that accepts it:

```
R1(config)#no vlan ?
Completions for "no vlan" (1):
  remove a VLAN no port is still in

  Next: <id>

R1(config)#no bgp neighbor ?
Completions for "no bgp neighbor" (1):
  stop peering with one address

  Next: <ip>

R1(config)#no span?
Completions for "no span" (1, completing "span"):
  Word           Meaning
  spanning-tree  forget this VLAN's priority and go back to the default

Then: vlan
```

Two defects came out of writing the rows:

* **`no encapsulation dot1q` did not exist.** The tag could be set and never taken back. It now
  reverts to the VLAN the subinterface's number infers, and says which tag it took off:

  ```
  R1(config-subif)#no encapsulation dot1q
  Encapsulation removed from Gi0/0.20 (was VLAN 42) - back to the tag inferred from the interface number, VLAN 20
  ```

* **A refusal that knew the reason also claimed not to recognise the words.** `ipv6 nd suppress-ra`
  on a switch answered `% Unrecognized interface command: …` and *then* the real reason. When the
  global handler understood the words and refused for a reason, that reason is the answer; the
  "unrecognized" line is now only for words nothing knows.

And one table joins the ones you can empty — `clear ip nat translation [*|<inside-local>]`:

```
R1#clear ip nat translation *
1 translation cleared on R1 (the rules are untouched - use "no ip nat inside source …" for those)
R1#clear ip nat translation *
Translation table on R1 was already empty
```

`test/no-forms.test.js` reads the mode dispatchers and requires a `no …` row for every `no` branch
that exists, so the next command added cannot repeat the omission.

### NAT is configured from the console

`engine/nat.js` modelled NAT end to end — rules, translations, timeouts, rewriting in both
directions — and the console could not create a single rule:

```
R1(config)#ip nat inside source static 10.0.0.50 203.0.113.50
% Unrecognized config command: ip nat inside source static 10.0.0.50 203.0.113.50
R1(config)#interface Gi0/0
R1(config-if)#ip nat inside
% Unrecognized interface command: ip nat inside
R1#show ip nat translations
NAT translations on R1:
  (none - no NAT rules; NAT is configured from the topology)
```

The model was telling the operator to go and edit the topology instead of the box. Now:

```
R1(config)#access-list 1 permit 10.0.0.0 0.0.0.255
R1(config)#interface Gi0/0
R1(config-if)#ip nat inside
Interface Gi0/0 is NAT inside
  (no port is outside yet - translation waits for one)
R1(config-if)#interface Gi0/1
R1(config-if)#ip nat outside
Interface Gi0/1 is NAT outside
R1(config-if)#ip nat inside source list 1 interface Gi0/1 overload
NAT rule added on R1: pat list 1 -> Gi0/1 (203.0.113.2) overload
```

```
PC1>ping 198.51.100.9 count 1
Success rate is 100 percent (1/1)
R1#show ip nat translations
Pro   Inside global     Inside local    Outside local      Outside global     Type
icmp  203.0.113.2:1024  10.0.0.50:4096  198.51.100.9:4096  198.51.100.9:4096  pat
```

**An ICMP echo used to cross a NAT box untranslated.** `_natOutbound` required a transport header,
and an echo carries `frame.icmp`, so the commonest test of all — ping from inside, watch a
translation appear — could never show one. The echo's source is now rewritten and its identifier is
the flow key for PAT, written back to the ICMP header rather than to a fabricated one.

**The roles are enforced, not decoration.** Once any port on the device declares `ip nat inside` or
`ip nat outside`, a packet is translated only when it leaves by an `outside` port and only when it
arrives on one — so unmarking the outside port routes traffic without translating it, and marking it
again brings the translation back. A lab built from the topology marks no roles, and there the
presence of rules is the whole story, exactly as before.

Every wrong word is refused where it is typed:

```
R1(config)#ip nat inside source list 99 interface Gi0/1 overload
% Access list 99 does not exist - the NAT list says which addresses
% are translated, so it has to be built first
% Configured lists: 1
R1(config)#ip nat inside source list 1 interface Gi0/0 overload
% Gi0/0 is the inside port - "overload" translates onto the outside
% address, so name the port facing the provider (or mark it with "ip nat outside")
R1(config)#ip nat inside source static 10.0.0.50
% Incomplete command: ip nat inside source static <local> <global>
```

Removal undoes exactly the rule it names, printing it in the words it was typed in:

```
R1(config)#no ip nat inside source
% No NAT rule named - the rules on R1:
  1) ip nat inside source list 1 interface Gi0/1 overload
  2) ip nat inside source static 10.0.0.50 203.0.113.50
R1(config)#no ip nat inside source static 10.0.0.50 203.0.113.50
Removed NAT rule: ip nat inside source static 10.0.0.50 203.0.113.50
```

`show running-config` carries `ip nat inside` / `ip nat outside` in the interface blocks and the
rules as the lines that created them, and pastes back into a device of the same shape. That test
caught a real trap: the rules are printed *after* the interface blocks, so the paste delivers
`ip nat inside source …` while the session is still inside an interface — and the interface verb
swallowed it. Rules written from inside an interface block now go to the router's configuration.

### The link-state database, and one BGP peer in detail

Two shows answered a different question than they named:

```
R1#show ip ospf database
Routing Process "ospf 1" with ID 1.1.1.1
  Area 0
  Interfaces:
    Interface  Cost  Area  State
    Gi0/0      10    0     active
    Gi0/1      10    0     active
  Neighbors: 1 (1 FULL)
R1#show ip ospf interface       <- byte for byte the same output
```

```
R1#show ip bgp neighbors        <- the summary table again, under another name
Neighbor  V  AS     State        Reason
10.9.0.2  4  65002  Established  eBGP
```

`show ip ospf database` is now the database, and it says what this model can and cannot show —
there are no aged LSAs here, because the tree is computed from the adjacency graph on every change:

```
R1#show ip ospf database
OSPF link-state database for process 1 (ID 1.1.1.1)
  This model computes the tree from the adjacency graph, so links carry no age or
  sequence number: what follows is exactly what the SPF ran on.

Router Link States (Area 0)
  Link ID  ADV Router  Interface  Cost  Neighbour  State
  1.1.1.1  1.1.1.1     Gi0/0      10    2.2.2.2    FULL
  1.1.1.1  1.1.1.1     Gi0/1      10    -          stub
  2.2.2.2  2.2.2.2     Gi0/0      -     1.1.1.1    FULL

Prefixes this database produced:
  Prefix       Next hop  Interface  Cost
  10.1.0.0/24  10.9.0.2  Gi0/0      20
```

Every row is a fact the SPF ran on: the links this router advertises, the adjacency each one
produced, the peer's own link state, and the prefixes the database installed (the same list
`show ip route ospf` reads). A peer in another area is not silently missing:

```
% R2 on Gi0/0 advertises area 1 - excluded from this database
```

`show ip bgp neighbors [<address>]` is per peer, and a peer that is **not** established says why —
a state column cannot carry that:

```
R1#show ip bgp neighbors
BGP router identifier 10.9.0.1, local AS number 65001

BGP neighbour 10.9.0.99 on R1 (local AS 65001)
  Remote AS      65002 (eBGP)
  State          idle
  Reason         no BGP speaker holds 10.9.0.99
  Hold time      180 s
  Prefixes in    0 (no session, so nothing was exchanged)
```

The prefix count is the same number the summary reports, because both read one list. Sub-words are
refused by naming what exists (`show ip ospf routes` → `takes neighbor, database or interface`), and
`show ip bgp summary` now asks the simulator before it answers — it used to say `0 of 0 neighbour(s)
established … run a simulation` with a simulator attached.

### An access list can be named, and every line can be counted

A filter could only be built by number, one line per command, and never counted:

```
R1(config)#ip access-list extended BLOCK
% Unrecognized config command: ip access-list extended BLOCK
R1(config-if)#ip access-group BLOCK in
% Invalid access list number: BLOCK
R1#show access-lists
Extended IP access list 101
   1 deny icmp any host 10.1.0.1
   2 permit ip any any
```

Both halves work now, and the numbering is IOS's default step of 10:

```
R1(config)#ip access-list extended BLOCK
Creating extended access list BLOCK, 1 entry
R1(config-ext-nacl)#deny icmp any host 10.1.0.1
    10 deny icmp any host 10.1.0.1  (added to BLOCK)
R1(config-ext-nacl)#deny tcp any host 10.1.0.1 eq 23
    20 deny tcp any host 10.1.0.1 eq 23  (added to BLOCK)
R1(config-ext-nacl)#exit
R1(config)#interface Gi0/0
R1(config-if)#ip access-group BLOCK in
Interface Gi0/0: access list BLOCK applied in
```

The prompt names the block (`config-std-nacl` / `config-ext-nacl`), `show` works from inside it, and
`no <sequence>` removes one line by number while `no deny icmp any host 10.1.0.1` removes it by
meaning — a line that has been *used* since it was typed is still removable, because a hit counter is
not part of what the line means.

**Counters.** `show access-lists` now carries the number an operator comes for:

```
R1#show access-lists
Extended IP access list BLOCK
   10 deny icmp any host 10.1.0.1  (3 matches)
   20 permit ip any any  (2 matches)
    applied IN on Gi0/0
```

and the implicit deny is counted too, because falling off the end of a list is the line that ate the
packet:

```
Extended IP access list STRICT
   10 deny icmp any host 10.1.0.5
      implicit deny  (2 matches)
```

`clear access-list counters [<id|name>]` (and `clear ip access-list counters`) zeroes them and says
how many it cleared, so a counter becomes dated evidence; clearing one list leaves the others.

**Refusals**, each naming the thing that was wrong: a kind that is not `standard|extended`, a missing
or trailing word, a *number* given to `ip access-list` (which points at `access-list <n> …`), a list
that cannot change kind, a binding to a list that is not configured (with the lists that are), a
third word on a binding, and `no 10 20` (a sequence number takes nothing else).

**The dump** prints the block and pastes back:

```
ip access-list extended BLOCK
  10 deny icmp any host 10.1.0.1
  20 permit ip any any
interface Gi0/0
  ip address 10.0.0.1 255.255.255.0
  ip access-group BLOCK in
```

Access lists are emitted **before** the interface blocks, because a dump is pasted from the top: an
interface that binds a list before the list exists is refused by the very device that wrote the dump,
and the binding is lost in the paste. A block ends where a pasted dump ends it — the next unindented
command closes it — and a *refused* command leaves the session in the block.

### The root bridge can be chosen, and the table names it

`show spanning-tree` printed roles and states and never a root — while its own help row promised
"root bridge, port roles and states". And nothing in the console could influence the election:

```
SW1(config)#spanning-tree vlan 1 root primary
% Unrecognized config command: spanning-tree vlan 1 root primary
SW1(config-if)#spanning-tree cost 19
% Unrecognized interface command: spanning-tree cost 19
```

The tree was decided by device creation order and cable speed alone. Both knobs now work, and the
table answers the question the command exists for:

```
SW2#show spanning-tree
Spanning tree enabled protocol ieee
  Root bridge: priority 4096, 02:00:00:00:01:00 (SW2)
  This bridge: SW2 priority 4096, 02:00:00:00:01:00   (this bridge is the root)
Port   Role        State       Cost
Fa0/1  designated  forwarding  20000
Fa0/2  designated  forwarding  20000
```

```
SW3#show spanning-tree
Spanning tree enabled protocol ieee
  Root bridge: priority 32768, 02:00:00:00:00:00 (SW1)
  This bridge: SW3 priority 32768, 02:00:00:00:02:00   root path cost 20000
Port   Role       State                         Cost
Fa0/1  alternate  blocking   (traffic dropped)  20000
Fa0/2  root       forwarding                    20000
  Fa0/1 is alternate: SW2 reaches the root for the same 20000, and the tie goes to the lower bridge ID
```

- `spanning-tree vlan <id> priority <n>` must be `0-61440` in steps of `4096`, and the refusal says
  so. Priority `0` is legal and wins every election — it was the one value a truthiness check threw
  away, so the lowest possible priority was the one the model ignored.
- `spanning-tree vlan <id> root primary|secondary` answers with the priority it chose (`24576` /
  `28672`, lowered when the current root is already at or below it), rather than storing a wish.
- `no spanning-tree vlan <id>` restores the default and reports what it replaced. A bare
  `no spanning-tree` says it cannot turn the protocol off, because it cannot. The three removal forms
  are not interchangeable, and the difference only shows up once a priority has been set — measured on
  a switch holding `priority 4096`:

  | Typed | Answer |
  |---|---|
  | `no spanning-tree vlan 10` | `Spanning tree bridge priority reset to the default (32768) on SW1 (was 4096)` |
  | `no spanning-tree vlan 10 priority 4096` | the same reset — the form the redirect below tells you to use |
  | `no spanning-tree vlan 10 priority` | `% Incomplete command: no spanning-tree vlan <id> priority <n>` — naming `priority` obliges you to name the value |
  | `no spanning-tree vlan 10 root primary` | `% The priority here was set explicitly (4096), not by root primary` / `% Remove it with "no spanning-tree vlan 10 priority 4096"` |

  With nothing set, that last form is not an error at all — it answers `Spanning tree bridge priority on
  SW1 is already the default (32768)`. So the same words mean "already done" or "wrong tool", depending
  on what the switch is holding.
- `spanning-tree cost <n>` per port is what the tree charges — **on the port the BPDU arrives on**,
  which is the port an operator configures. The election used the *sending* port's cost while the
  root-port choice used the receiving port's, so the two disagreed and a cost set on the port you
  care about moved nothing.

Refused by name, because this model has nothing for them to do: `port-priority` (a cost tie is
broken by bridge ID and port name), `portfast` (every port converges at the same instant — there is
no Listening/Learning hold-off to skip) and `bpduguard`/`bpdufilter` (no BPDU is ever injected into
an edge port). A router is refused with `does not bridge - spanning tree runs on switches`.

`show running-config` carries both lines, so the dump pastes back into the same tree.

### A device answers for an address it holds — including its own

Pinging your own address is the first check after configuring one, and it failed silently:

```
R1#ping 10.0.0.1 count 2
Sending 2, 100-byte ICMP Echos to 10.0.0.1, timeout is 2 seconds:
..
Success rate is 0 percent (0/2)
```

The echo was routed out of the very port it was addressed to, ARP'd for itself, and died — with no
drop event anywhere. An address this box holds is answered **by this box**, without a frame reaching
a wire:

```
R1#ping 10.0.0.1 count 2
!!
Success rate is 100 percent (2/2)
Reply from 10.0.0.1: bytes=100 time=0.000 ms
```

Nothing is counted as traffic (`show interfaces counters` stays at "no port has carried a frame"),
which is what makes it a loopback rather than a lucky round trip. The same rule answers a switch's
management SVI and a VRRP master's **virtual** address — the master could not reach the group address
it advertised.

### One group, one master — and the reason when it moves

After the master's cable was pulled, both boxes called themselves master:

```
[R1] Gi0/0  1  150  Master  R1  192.168.9.1  00:00:5e:00:01:01   <- cable pulled a moment ago
[R2] Gi0/0  1  100  Master  R2  192.168.9.1  00:00:5e:00:01:01
```

The candidate's `up` flag asked whether the port was enabled and had an address, never whether the
cable was still in it. It now means what `show ip interface brief` means by down — shut, no cable, or
an SVI whose VLAN carries nothing:

```
R1#show vrrp
Interface  Group  Pri  State   Master  Virtual IP   Virtual MAC
Gi0/0      1      150  Backup  R2      192.168.9.1  -
  R1: Gi0/0 has no line, so group 1 moved to R2
```

Two things in that answer are new, and both are the same defect one level down:
- the **Master column names who holds the group**, not who is asking — it used to print the device's
  own name beside `State: Backup`, a table contradicting itself in one row;
- a group that **moved says why**, because `Backup` alone sends an operator looking for a priority
  mistake when the cable is out. A shut port says `is administratively down`, a pulled cable says
  `has no line`.

Preemption returns the group to the higher priority when the line comes back, and the PC never loses
its gateway. When *no* router holds the address, the note distinguishes the two cases instead of
saying "run a simulation" with a simulator attached: `(no router holds the virtual address yet - the
group has not converged)` or `(no simulation is attached, so no group has held its address)`.

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

Every protocol in this lab writes events — 28 sites that emit a bare `drop`, plus forwards, ARP and
LLDP, STP blocks, VLAN drops, PoE denials, DHCP exchanges, OSPF and BGP state changes, SCION hops,
SLAAC refusals. The whole vocabulary is **80 event types across 148 emit sites**, and `show logging
<type>` filters on exactly those names, so here it is grouped — the names in code font are the literal
strings to pass the filter:

| group | types (13 of them hold 78 names; `acl-deny` and `lldp` are the other two) |
| --- | --- |
| frames and forwarding | `frame`, `switch`, `forward`, `ethernet`, `media`, `link-local`, `up`, `split`, `antenna`, `limit` |
| ARP and neighbour discovery | `arp-request`, `arp-reply`, `arp-cache`, `arp-static-hold`, `garp`, `nd-request`, `nd-advert`, `nd-cache`, `na`, `ns` |
| ICMP and ping | `icmp-echo`, `icmp-reply`, `icmp-received`, `icmp6-echo`, `icmp6-reply`, `icmp6-received`, `ping`, `ping6` |
| layer 2 policy | `vlan-drop`, `stp-block`, `lag`, `port-security-learn`, `port-security-age`, `port-security-drop` |
| addresses and routes | `connected`, `static`, `static6`, `default`, `default6`, `route`, `route6`, `svi`, `subinterface`, `set` |
| DHCP, DNS and NAT | `dhcp`, `dns`, `nat-outbound`, `nat-inbound`, `nat-drop`, `pat` |
| address autoconfiguration | `ra`, `ra-send`, `ra-recv`, `rs`, `rs-send`, `rs-recv`, `slaac-address`, `slaac-refused` |
| routing protocols | `ospf`, `bgp`, `bgp-session`, `ebgp`, `vrrp` |
| power | `poe-admin-off`, `poe-budget`, `poe-deny` |
| SCION | `scion-path`, `scion-hop`, `scion-delivered`, `scion-drop` |
| transport flows | `flow-open`, `flow-data`, `flow-close`, `flow-reset`, `flow-refused` |
| capture | `tap`, `tap-inject-refused` |
| unnamed drops | `drop` — the type whose reason string carries the explanation |

Recount any of it in one line, because the vocabulary grows with the model:

```sh
grep -oh "type: '[a-z0-9-]*'" engine/*.js | sort -u | wc -l     # 80 types
grep -oh "type: '[a-z0-9-]*'" engine/*.js | wc -l               # 148 emit sites
grep -c "type: 'drop'" engine/simulator.js                      # 28 bare-drop sites
```

Every one of those names is a working filter argument — measured by passing 36 of them (at least one
from every group, plus the awkward ones: `tap-inject-refused`, `poe-admin-off`, `arp-static-hold`,
`scion-delivered`, `flow-refused`) through `show logging <type> last 2`, all accepted. The answer says
how much it found and how much it skipped, so an empty result is still informative:

```text
P1#show logging icmp-echo last 2
Event log (1 icmp-echo events, from 16 in the lab):
  #   Step  Type       Device  Detail
  13  5     icmp-echo  R1      on Gi0/0, from 10.0.0.10, seq 0, vlan 1
``` Until `show logging` existed, **nothing read them**: the console could tell you a ping
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

Each one names the event type it filters on, so `show logging` + a type it cannot satisfy answers with
the types that *do* have events rather than an empty table — and it says exactly that, which matters,
because the filter cannot tell a typo from a real type that simply has not happened yet:

```text
PC1#show logging not-a-type
% No event of type "not-a-type" has happened here
% Types with events so far: arp-request, frame, lldp, ping
% A type is named after what happened (drop, acl-deny, dhcp, stp-block, ...), so this is
%   either a type that has not happened yet or a typo - "show logging" lists them all

PC1#show logging icmp-reply
% No event of type "icmp-reply" has happened here
% Types with events so far: arp-request, frame, lldp, ping
```

`icmp-reply` **is** a real type — it is one of the names in
[the vocabulary above](#event-log) — it just never fired in this lab. So the refusal below is a
statement about this log, not about the simulator: read the list as "what has happened", and the
inventory table as "what can happen".

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

### A group id is an id, not a timestamp

`show vrrp <n>` asks about group `n`, and `show ip ospf <n>` about process `n`. Both used to be parsed as
the trailing `at <ms>` argument, so the number was read as a *time*: `show vrrp 1` answered "VRRP at
t=1 ms" and then reported an unconverged table with no master for a group that plain `show vrrp` listed as
Master — a contradiction one word apart. The number in each of these commands is now an identifier, and
the time form has to say so:

```text
R1#show vrrp 1
Interface  Group  Pri  State   Master  Virtual IP  Virtual MAC
eth1       1      120  Master  R1      10.0.0.254  00:00:5e:00:01:01
R1#show vrrp 9
% No VRRP group 9 on R1
% The groups here are: 1 on eth1
R1#show vrrp at 5000
VRRP at t=5000 ms (control planes rebuilt for this answer)
Interface  Group  Pri  State   Master  Virtual IP  Virtual MAC
eth1       1      120  Master  R1      10.0.0.254  00:00:5e:00:01:01
R1#show vrrp abc
% show vrrp takes a group id, not "abc"
% e.g. show vrrp | show vrrp 1 | show vrrp at <ms>
R1#show ip ospf 9
% No OSPF process 9 on R1
% The process here is "ospf 1"
```

Three things to take from it: the id narrows the answer rather than changing the clock; an id that does
not exist names the ones that do; and a word where an id belongs is refused with the three accepted forms
rather than being silently treated as a filter that matches nothing.

The two arguments compose, but **only in one order**, and the failure the other way is quiet:

```text
R1#show vrrp 1 at 5000
VRRP at t=5000 ms (control planes rebuilt for this answer)
Interface  Group  Pri  State   Master  Virtual IP  Virtual MAC
eth1       1      120  Master  R1      10.0.0.254  00:00:5e:00:01:01
R1#show vrrp 1 2
VRRP at t=2 ms (control planes rebuilt for this answer)
Interface  Group  Pri  State   Master  Virtual IP  Virtual MAC
eth1       1      120  Backup  -       10.0.0.254  -
(no router holds the virtual address yet - the group has not converged)
R1#show vrrp at 5000 1
% Unexpected argument after the instant: 1
% Usage: show vrrp at <ms>|converged
```

`show vrrp 1 2` is **not** a refusal: the first number is the group and the second is read as the instant,
so the answer is "group 1 at t=2 ms" — and because the control planes are rebuilt for that answer, a group
that is Master at `t=0` comes back `Backup` with the "has not converged" note. A second id after `at` is
the case that is refused. `show vrrp brief` is accepted as a synonym for the summary view.

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

The cable's state and the port's are two different facts, and `link` prints both when they disagree.
A run can be up while the socket it enters is administratively down, and this line used to answer
`(up)` from the cable alone — true about the copper, and silent about the thing that was stopping
every frame. Measured on an EP-S16 `sfp1` cabled to an ASR 1001-X `Te0/0/0`:

```
SW1#configure terminal
SW1(config)#interface sfp1
SW1(config-if)#shutdown
sfp1 administratively down

SW1#show interfaces transceiver sfp1
sfp1 (ethernet, sfp+) - transceiver
  cage         : sfp+
  rate         : 10G
  optics       : 18 for this cage (SFP-10G-SR, SFP-10G-LR, SFP-10G-ER, ...)
  link         : l3 -> R2/Te0/0/0 (up, this port is administratively down)
  medium       : 10GBASE-SR (fiber, lc, 850 nm)
  reach        : 300 m
  length       : -
  verdict      : reach unchecked (no cable length)
```

The table gains no column, because the optic really is in the socket and the reach numbers are true
whatever the port is doing. The reason comes as a note under the rows instead, in the same words
`show lldp neighbors` uses — one helper answers both — and it names a shut port at the far end too,
since in that case our own port is genuinely up:

```
SW1#show interfaces transceiver
SW1 transceivers (2 cage ports):
  Port  Cage  Medium      Rate  Reach  Length  Verdict
  sfp1  sfp+  10GBASE-SR  10G   300 m  -       reach unchecked (no cable length)
  sfp2  sfp+  -           10G   -      -       not cabled
  sfp1: this port is administratively down
  The optic and the run are as above; those ports are why no frame crosses them.
```

With `sfp1` back and the ASR's `Te0/0/0` shut instead, the same line names the other end —
`sfp1: the far port Te0/0/0 on R2 is administratively down` — because this port has nothing wrong
with it. Uncabled ports are not listed: `not cabled` in the Verdict column is that fact already.

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

**There is no VLAN sub-mode, and that is the trap for anyone who has typed IOS.** `vlan 20` creates the
VLAN and returns you to config mode — it does not open a `(config-vlan)#` prompt — so the name has to be
on the same line. The block form an operator's fingers expect fails twice, and the second failure is
the confusing one:

```text
SW1(config)#vlan 20
VLAN 20 created (name: VLAN0020)
SW1(config)#name GUEST
% Unrecognized config command: name GUEST

SW1#show vlan name GUEST
% No VLAN named "GUEST" on SW1
% Names here: VLAN0020, VLAN0030
```

Nothing is broken — the VLAN exists, under the auto name — but the refusal names a list that contains
neither `GUEST` nor "VLAN 20", so it reads as though the VLAN vanished. Write it on one line and both
halves agree:

```text
SW1(config)#vlan 20 name GUEST
VLAN 20 name changed to GUEST
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
refusal names are exactly the ports the table lists — see `test/vlan-lifecycle.test.js` (44
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
% Also: switchport access vlan <id> | switchport trunk native vlan <id> | switchport trunk allowed vlan <list|all> | switchport voice vlan <id>
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

### `switchport voice vlan` — the field that was checked, stored, printed and read by nothing

`voiceVlan` has been part of a port's VLAN shape since VLANs were modelled. `normalizePortConfig()`
kept it, `validatePortConfig()` insisted the port be a trunk ("voice traffic is tagged"), the
switchport reset listed it when it cleared — and **nothing wrote it and nothing read it**. There was
no `switchport voice vlan`, so a phone port could not be configured at all; `classifyEgress` and
`classifyIngress` consulted the allowed list only, so a phone's tagged frames were classified into
the data VLAN; `show interfaces <port> switchport` printed `Voice VLAN: none` on every port in every
lab; and `serialize()` dropped the field, so a saved lab came back without one.

The command writes it, and the mode is **not** part of the setting: a voice VLAN is a parameter of
the port, so it works on an access port (the phone-port pair) and on a trunk, and setting it never
changes the mode. What it refuses is a real contradiction — naming the VLAN that already leaves the
port untagged, or a VLAN the trunk does not carry:

```
SW1(config-if)#switchport voice vlan 20
Voice VLAN 20 on Fa0/1 (tagged; the untagged traffic on this port stays in VLAN 1)
SW1(config-if)#switchport voice vlan 1
% VLAN 1 is the VLAN that leaves Fa0/1 untagged (the access VLAN)
% Tagged voice traffic must land in a different VLAN - move the data VLAN first: "switchport access vlan <other>", or choose another voice VLAN
SW1(config-if)#switchport mode trunk
Switchport mode trunk on Fa0/1
SW1(config-if)#switchport trunk allowed vlan 10,30
Trunk on Fa0/1 allows VLANs 10,30
SW1(config-if)#switchport voice vlan 20
% VLAN 20 is not in the allowed list on Fa0/1 (it allows 10,30)
% A voice VLAN the trunk drops is not a voice VLAN: "switchport trunk allowed vlan 10,20,30"
SW1(config-if)#switchport trunk native vlan 99
Trunk native VLAN 99 on Fa0/1
SW1(config-if)#switchport trunk allowed vlan 10,20,30
Trunk on Fa0/1 allows VLANs 10,20,30
SW1(config-if)#switchport voice vlan 20
Voice VLAN 20 on Fa0/1 (tagged; the untagged traffic on this port stays in VLAN 99)
```

The classifier carries it in both directions. A voice VLAN is the **one** tag an access port
understands (a phone tags its own traffic, the PC behind it speaks untagged), it always leaves
tagged — including on a port whose native VLAN happens to name the same number, which is why that
pair is refused rather than resolved — and a tagged frame in it is accepted into that VLAN:

```
SW1#show interfaces Fa0/1 switchport
Name: Fa0/1
  Administrative Mode: trunk
  Operational Mode: trunk
  Trunking Native Mode VLAN: 99
  Trunking VLANs Enabled: 10,20,30
  Administrative private-vlan: none
  Voice VLAN: 20 (tagged)
```

`show running-config` prints the line (before the mode, because it is a parameter and not a mode),
so a paste restores it; `serialize()` carries it, so a reload does too, and a file written before the
field existed restores with none rather than `NaN`:

```
SW1#show running-config
! PacketForge running-config
hostname SW1
interface Fa0/1
  switchport voice vlan 20
  switchport mode trunk
  switchport trunk native vlan 99
  switchport trunk allowed vlan 10,20,30
```

Removing it is as narrow as setting it, and the inspector's one line about the port names it
(`trunk · native 99 · allowed 10,20,30 · voice 20`):

```
SW1(config-if)#no switchport voice vlan
Voice VLAN removed from Fa0/1 (was VLAN 20; tagged frames for it are now classified by the allowed list alone)
SW1(config-if)#no switchport voice vlan
Fa0/1 has no voice VLAN - nothing to remove
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

`show vlan` marks trunk ports with `(t)`, a trunk's untagged VLAN with `(n)` and a voice VLAN with
`(v)` — the voice VLAN is a membership of the port that names it, so a table of memberships that
omitted it would be answering a narrower question than it appears to. `show vlan brief` is accepted as
a synonym; it prints the same table, because there is only one table.

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

The summary's `State` column is the one place `ip ospf passive` becomes visible, as `passive` beside the
interface. Two things about it are worth knowing before you trust it:

- **`ip ospf passive` is silently dropped if the OSPF process does not exist yet.** Typed into an
  interface before `router ospf <id>` has been configured, it echoes `OSPF passive on eth1` like any
  other accepted command, writes nothing to `show running-config`, and leaves the adjacency up — the
  interface's state still reads `active`. Configure the process first, then the interface override.
- Once it *is* applied, the effect is real and the state word says so: the adjacency goes away
  (`show ip ospf neighbor` → `(no adjacencies - no neighbour passed the passive, subnet and area
  checks)` on **both** ends), `show running-config` carries `ip ospf passive` in the interface block,
  and the interface's own network is still advertised — which is what a passive interface means: no
  adjacency, stub network still in the router LSA.

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

All of this is swept by `test/port-args.test.js` (85 assertions): every command is asked about a port it
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

`copy startup-config running-config` is the other direction, and it is the only way back from a change
you did not save. It **merges**: the saved copy is replayed into the running configuration, and lines the
running config has that the saved copy never mentions are **kept** — IOS's behaviour, not a restore:

```text
R1#configure terminal
R1(config)#hostname CHANGED
R1(config)#end
CHANGED#copy startup-config running-config
Copied startup-config into the running configuration on CHANGED: 4 lines applied
  1 line added, 1 line removed (this is a merge: lines the saved copy does not mention are kept)
CHANGED#show running-config
! PacketForge running-config
hostname EDGE
```

Measured, and the second half is the part people get wrong: with `description LATER` added to a port the
saved copy does not mention at all, a merge leaves it in place and says so rather than reporting a
silent success —

```text
R1#copy startup-config running-config
Copied startup-config into the running configuration on R1: 5 lines applied
  the running configuration did not change - the saved copy was already in force
```

`reload` is answered rather than obeyed, and the answer changes with the lab. On a device with nothing
saved it points at `write memory`; on one whose saved copy is real it prints the two commands that
actually do the job, because a reboot is the one thing this console cannot do:

```text
R1#reload
% There is no reload on this console - nothing here boots, so there is no restart
%   to schedule and no saved image to load on the way up
% The saved copy is real, and so is the way back to it:
%   copy startup-config running-config   merge the saved copy into the running one
%   show startup-config                the saved copy, plus what has changed since
% To discard unsaved changes, build the device again - that is what a reboot would do here
```

It is refused whether or not you are privileged — `reload` needs no enable mode, which is why it is the
one exec verb that answers a user-mode prompt with the full explanation rather than `% Invalid input`.

Two refusals worth knowing. It is an exec command, so configuring mode rejects it with a message that
names the way out rather than just refusing:

```text
R1(config)#copy startup-config running-config
% "copy startup-config running-config" is an exec command, not a configuration command
% "end" leaves the configuration and puts you back at privileged exec
% ("do" carries reads only - "do show <...>" - so this one needs "end" first)
```

and anything else after `copy` is answered by naming both directions, because the verb takes exactly
two argument pairs:

```text
R1#copy running-config nvram:
% copy takes running-config startup-config, or startup-config running-config
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

That identity is worth checking rather than believing, and it holds to the byte. Measured on a PC and
its router — the first command, then a second one, so the difference between the two steps is visible:

```text
PC1>ping 10.0.1.1 count 3
!!!            Success rate is 100 percent (3/3)

PC1>show interfaces counters
Port  Rx packets  Rx bytes  Tx packets  Tx bytes  Drops
eth0  5           530       5           530       0

PC1>ping 10.0.1.1 count 4
!!!!           Success rate is 100 percent (4/4)

PC1>show interfaces counters
Port  Rx packets  Rx bytes  Tx packets  Tx bytes  Drops
eth0  10          1130      10          1130      0
```

The first step is the documented sum: LLDP 64 + ARP 64 + 3 × 134 = **530**. The second step is
`1130 − 530 = 600`, which is LLDP 64 + 4 × 134 and **no ARP term at all** — the entry learned by the
first command was still there.

Two things follow, and both were measured rather than assumed. The ARP entry **persists** — it is device
state, not run state: it is still there after a second command, and still there on a brand-new
`Simulator` built over the same topology. The **counters do not**: they belong to the run, so a new
`Simulator` starts them at zero (`(no port has carried a frame since this lab started)`) even though the
ARP entry survived. A `ping` count and a counter total that differ by exactly 64 per command is the LLDP
advertisement, not a leak — and "counters are cumulative from the lab's start" means since *this* run
began, however many commands one session types into it.

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

The rule is literally a set membership in the engine — `FRAME_DROP_TYPES` holds those six names and
nothing else — so the table above cannot drift away from the code without the code changing. Three of
the rows, measured on labs built to hit them:

```text
SW1#show logging
  1   0     vlan-drop    SW1         VLAN 1 not allowed on egress, on Fa0/1, vlan 1
 24   8     drop         SW1         no egress ports in VLAN 10, on Fa0/1, vlan 10
 25   8     drop         R1          no route to 192.0.2.9
```

| lab | event | drops charged |
| --- | --- | --- |
| trunk allows VLAN 10 only, switch still advertises LLDP in VLAN 1 | `vlan-drop` | **1 on the trunk** (`Fa0/1`: 1 in, 0 out, 1 dropped) — by event #1, before any ping was sent |
| two access ports in different VLANs, one ping across them | `drop` | **4 on the ingress port**, 0 on the other — one per echo |
| a ping to a destination the router cannot reach | `drop` with no port | **0 on every port** — the frame died before an egress existed |

Two things fall out of that. The VLAN case a reader will actually build ("no egress ports in VLAN *n*")
reports as a plain **`drop`** with the port named, not as `vlan-drop`; `vlan-drop` is the narrower
"this port refuses that VLAN on egress" check, and the easiest way to see one is the trunk above, where
the switch's own LLDP advertisement in VLAN 1 is dropped because the trunk does not carry VLAN 1. So a
lab with a mistyped `switchport trunk allowed vlan` shows a drop counter on the trunk before you have
configured anything else — that is the LLDP, not user traffic.

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

The engine defines **147** distinct `E_*` codes, and **whether the console shows you one depends on
the family** — measured, not assumed. Count them yourself; the number is the distinct quoted `E_`
strings across `engine/`, which is the only reading that ignores identifiers and comments:

```
grep -oh "'E_[A-Z0-9_]*'" engine/*.js | sort -u | wc -l     # 147
grep -oh "'W_[A-Z0-9_]*'" engine/*.js | sort -u | wc -l     # 12 (eleven warnings + the 'W_' prefix)
```

Of those 147, **47** appear as rows in the tables below and **70** distinct `E_` tokens appear anywhere
in this document. The rest are reachable only through `validateTopology()`, the API, or a surface that
prints prose instead of the code, which is what the next table is about — so a code missing from the
tables is not necessarily a code that cannot happen, it is a code you cannot see from this console.

Count them rather than trusting the numbers, and count **tokens**, not substrings: looking for each
engine code with `in` finds `E_PORT` inside `E_PORT_PROTOCOL` and inflates the figure by a couple.

### The other vocabulary: warnings

`W_*` is a second set of eleven codes, and this appendix used to ignore it entirely — which is why a
reader who greps for `W_` finds names no page explains. They are not refusals: nothing is rejected,
the command succeeds and the warning rides back with it, so a rule that only looks for `% ` lines
misses all of them.

| Code | Raised by | What it means |
|---|---|---|
| `W_ACCESS_ON_TRUNK` | `vlan.js:440` | `switchport access vlan N` on a port currently in trunk mode — stored, but inert until the port goes access |
| `W_DUP_VLAN_IN_LIST` | `vlan.js:417` | the same VLAN twice in an allowed list; the list is de-duplicated |
| `W_VLAN1_AS_NATIVE` | `vlan.js:435` | VLAN 1 as the trunk native — legal, and the usual way to leak untagged frames between switches |
| `W_LAG_DISABLED_MEMBER` | `lag.js:288` | a LAG member whose port is administratively down; the bundle keeps it but does not use it |
| `W_SPEED_DOWNGRADE` | `validation.js:126` | the two ends negotiated a lower rate than the medium could carry |
| `W_COPPER_LONGRUN` | `validation.js:134` | copper past the length its BASE-T standard allows |
| `W_HYBRID_CORD` | `validation.js:138` | a patch cord whose polish matches neither end exactly — see `docs/HYBRID-PATCH.md` |
| `W_OPTICAL_HEADROOM` | `validation.js:712` | within budget, but with less margin than the part is specified for |
| `W_POE_DRAW` | `validation.js:130` | the load fits, but close to the PSE's limit |
| `W_DUPLEX_MISMATCH` | `validation.js:122` | one end half duplex, the other full |
| `W_DISTANCE` | `cli.js:9659` | an administrative distance outside the range the engine expects — a warning, not a refusal, so a lab can hold a route that will never be used |

### The 22 codes no page names

Of the 159 distinct quoted `[EW]_` strings in `engine/`, two are prefix literals (`'E_'`, `'W_'`) and
the other **157 are real codes**; of those, **22 appear in no document at all**. They are not missing
mistakes — every one is a parse-level guard whose message reaches you as prose (a malformed line, a
`% [object Object]`, a topology-validation error drawn in the UI) rather than as a code to grep. The
concentration is worth knowing, because it tells you where the console is least likely to hand you one:

| File | Undocumented | Which |
|---|---|---|
| `ipv6.js` | 14 | `E_DOUBLE_COMPRESSION`-class syntax guards: `E_EMPTY_GROUP`, `E_GROUP_COUNT`, `E_IPV4_POSITION`, `E_PREFIX_LEN`, `E_PREFIX_TYPE`, `E_UNSPECIFIED`, `E_PARSE` … |
| `acl.js` | 3 | `E_ADDRESS`, `E_ENTRY` — the per-entry guards behind the `% [object Object]` in [the appendix above](#refusal-codes-the-ones-you-will-actually-meet) |
| `dns.js` | 3 | `E_DNS_BAD_PRIORITY`, `E_DNS_BAD_VALUE`, `E_DNS_MISSING_VALUE` |
| `ra.js` | 3 | `E_ICMP_TYPE`, `E_SHORT`, `E_TYPE` — RA option parsing |
| `optical.js` | 1 | `E_UNKNOWN_SPLITTER` |

The other 135 are named somewhere in `docs/`, though not always in this file — `CONNECTORS.md` and
`PHYSICAL_LAYER.md` carry the optical and validation codes, `ARCHITECTURE.md` the API ones.

Recount both ways; the second number is the one that says whether this table is still true. Note it
counts **quoted** strings only — matching bare tokens instead finds codes that are assembled rather
than literal and inflates the answer to 58:

```sh
grep -oh "'[EW]_[A-Z0-9_]*'" engine/*.js | sort -u | wc -l          # 159 quoted, 2 of them prefix literals
grep -oh "'[EW]_[A-Z0-9_]*'" engine/*.js | sort -u | tr -d "'" \
  | while read c; do grep -q "$c" docs/*.md || echo "$c"; done | wc -l   # 22 never named
```
`grep -oh "'E_[A-Z0-9_]*'" engine/*.js | sort -u | wc -l` is the 145;
`grep -o 'E_[A-Z0-9_]*' docs/CLI.md | sort -u | wc -l` is the 69;
``grep -c '^| `E_' docs/CLI.md`` is the 47.

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
