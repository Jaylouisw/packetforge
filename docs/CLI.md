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

## Global / exec commands

| Command | Effect |
|---------|--------|
| `enable` | enter enable mode |
| `configure terminal` | enter config mode |
| `show version` | vendor, model, category, capabilities |
| `show ip interface brief` | interface IP / status table |
| `show ip route` | connected + static routes |
| `show arp` | ARP cache |
| `show mac address-table` | MAC table (switches) |
| `show interfaces` | per-interface detail incl. MAC + peer |
| `show running-config` | full configuration |
| `ping <ip> [count]` | ICMP echo from this device |
| `exit` / `logout` | leave the session |

## Config-mode commands

| Command | Effect |
|---------|--------|
| `hostname <name>` | set device hostname |
| `interface <name>` | enter interface config mode |
| `ip route <dest> <mask> <gw> [iface]` | add static route |
| `no ip route <dest> <mask> [gw]` | remove static route |
| `ip default-gateway <gw>` | set default gateway (hosts) |
| `do show …` | run a `show` from config mode |
| `exit` / `end` | leave config mode |

## Interface-mode commands

| Command | Effect |
|---------|--------|
| `ip address <ip> <mask>` | assign an IP (e.g. `192.168.1.1 255.255.255.0`) |
| `no ip address` | remove the IP |
| `ip address dhcp` | make this interface a DHCP client; a lease is acquired at the start of the next run (see [SIMULATION §5.1](SIMULATION.md#51-dhcp--in-the-data-path-computed-rather-than-timed)) |
| `shutdown` / `no shutdown` | administratively disable / enable |
| `description <text>` | set a description |
| `exit` | back to config mode |

## DHCP server commands

A router or L3 switch with a pool answers DHCP on any segment it holds an address in.
The pool sub-commands apply to the pool named last; `exit` forgets it.

| Command | Effect |
|---------|--------|
| `ip dhcp pool <name>` | create or select a pool |
| `no ip dhcp pool <name>` | delete a pool |
| `network <net> <mask>` | the subnet this pool serves; derives the allocatable range across it (network and broadcast excluded) |
| `range <start> <end>` | override the derived range |
| `default-router <ip>` | gateway handed to clients |
| `dns-server <ip>` | DNS server handed to clients (repeatable) |
| `excluded-address <start> [end]` | addresses never allocated; repeatable |
| `lease <days> [hours] [minutes]` | lease time; unset means the library default |

The server never allocates an address it already holds on the segment, so a pool on
`192.168.1.0/24` with a gateway of `192.168.1.1` hands out `.2` onwards. Lease allocation
is deterministic: clients are served in a stable order, so addresses do not shuffle
between runs of the same lab.

```
configure terminal
interface Gi0/0
 ip address 192.168.1.1 255.255.255.0
exit
ip dhcp pool LAN
 network 192.168.1.0 255.255.255.0
 default-router 192.168.1.1
 dns-server 192.168.1.53
 lease 0 12 0
exit
```

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

PC1(config)# interface eth0
PC1(config-if)# ipv6 address autoconfig
PC1# show ipv6 nd
IPv6 router advertisements on PC1:
  Autoconfig  : eth0 -> 2001:db8:aa::ff:fe00:200/64 (from fe80::ff:fe00:0)
```

The host sends a router solicitation to `ff02::2`, the router answers to
`ff02::1`, and the host splices its own EUI-64 identifier onto the advertised
prefix. If the advertisement carries the M (managed) flag the host refuses to
autoconfigure and reports why: addresses on that network come from DHCPv6.

## Example session (two-subnet router)

```
Router> enable
Router# configure terminal
Router(config)# hostname R1
R1(config)# interface Gi0/0
R1(config-if)# ip address 10.0.1.1 255.255.255.0
R1(config-if)# no shutdown
R1(config-if)# exit
R1(config)# interface Gi0/1
R1(config-if)# ip address 10.0.2.1 255.255.255.0
R1(config-if)# exit
R1(config)# exit
R1# show ip route
Codes: C - connected, S - static
C  10.0.1.0/24  via -  Gi0/0
C  10.0.2.0/24  via -  Gi0/1
R1# ping 10.0.1.10
Type escape sequence to abort.
Sending 4, 100-byte ICMP Echos to 10.0.1.10, timeout is 2 seconds:
!!!!
Success rate is 100 percent (4/4)
```

## Note on vendor syntax

This is intentionally a **unified** command set. A future release can add
per-vendor "translators" (e.g. accept Juniper `set interfaces …` or Huawei
`interface GigabitEthernet0/0/0`) while keeping the single underlying
configuration model. See `docs/ROADMAP.md`.
