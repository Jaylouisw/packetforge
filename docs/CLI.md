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
| `ip address dhcp` | mark as DHCP client (reserved) |
| `shutdown` / `no shutdown` | administratively disable / enable |
| `description <text>` | set a description |
| `exit` | back to config mode |

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
