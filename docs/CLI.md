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
| `show ip interface brief` | interface IP / status table (status = whether the port can carry a frame) |
| `show ip route` | routing table: connected, static, OSPF, BGP, and the default |
| `show arp` | ARP cache, with an age per neighbour, the port it was learned on, and whether that port can still carry a frame |
| `show mac address-table` | MAC table (switches), per VLAN, with an age per entry and stale entries marked |
| `show vlan` / `show vlan brief` | VLAN table: one row per VLAN, with the ports that actually carry it |
| `show spanning-tree` | per-port STP role and state, the bridge priority and the elected root, or "not measured" when nothing has run |
| `show etherchannel summary` | LAG members, `(P)` bundled or `(D)` unbundled with the reason |
| `show lldp` | LLDP neighbours, with the local port marked when it can no longer carry |
| `show access-lists` | ACL rules, bindings, and how many packets each rule has matched |
| `show ip bgp` / `show ip bgp summary` | BGP neighbours with their state and reason, and the prefixes installed |
| `show interfaces` | per-interface detail incl. MAC, peer, link state and what has crossed the port |
| `show power inline [<port>]` | PoE supplied per PSE port, the budget left, and why a powered device was denied |
| `show vrrp` | the group, its state (`Master`/`Backup`/`Init` with the reason), and the master the election chose |
| `show running-config` | full configuration |
| `ping <ip> [count]` | ICMP echo from this device |
| `traceroute <ip>` (`tracert`) | TTL-limited probes, one hop at a time; each router that expires a probe answers with ICMP time exceeded, the destination with an echo reply |
| `exit` / `logout` | leave the session |

## A command with words it cannot use refuses them

Every command above is the whole command. Two take a port name — `show interfaces <port>`,
`show power inline <port>` — and one takes a filter, `show mac address-table interface <port>`. The rest take
nothing, and **a word they cannot use is refused, with the words quoted and the command named**:

```
r1#show ip route 192.0.2.0/24
% show ip route does not take "192.0.2.0/24": the whole table is printed - read the row for the prefix in the table below
```

That refusal is the point, and it is worth stating why, because the alternative looked helpful. These commands used
to **ignore** the extra words and print the whole table. On a router whose table held one route, `10.0.0.0/24`,
asking whether `192.0.2.0/24` was installed printed:

```
Codes: C - connected, S - static, O - OSPF, B - BGP
C   10.0.0.0       /24  is directly connected, Gi0
```

A different prefix, printed as the answer to a question about this one. An operator checking whether a prefix is
installed is checking exactly the thing a silent drop fabricates: the table came back looking like a yes.

The same for `show arp <address>`, `show vlan <id>`, `show spanning-tree <port>`, `show lldp neighbors <port>`,
`show ip interface brief <port>`, `show running-config interface <port>`, `show access-lists <n>`,
`show etherchannel <x>`, `show vrrp <group>` and `show version <x>`. Where a narrower question has an answer, the
refusal names the command that gives it:

```
sw1#show ip interface brief Gi1/0/1
% show ip interface brief does not take "Gi1/0/1": every interface is listed - use `show interfaces Gi1/0/1` for one port

sw1#show running-config interface Gi1/0/1
% show running-config does not take "interface Gi1/0/1": the whole configuration is printed - use `show interfaces Gi1/0/1` for one port's state
```

Two kinds of answer are **not** refusals even though they begin with `%`, and the difference matters: a
device-level fact that holds whatever was typed. `show access-lists` on a device with no lists says
`% No access lists configured`; `show power inline` on a box that cannot supply power says so about the device, and
no port name can change that. Nor is `% No interface X on <device>` a refusal of the words — it is the answer to
them.

## `show running-config` is a config you can paste back

The output is a restorable backup, and that is a tested invariant rather than an aspiration
(`test/config-roundtrip.test.js`): paste it into a fresh device of the same model at the config prompt
and you get the same configuration, on the same ports.

Three properties make that work, all of them load-bearing:

* **Every interface block closes with `exit`.** Without it a reader never leaves interface mode, and
  every following line — including global ones like `ip route` — is parsed as an interface command. The
  failure was silent and destructive: an address meant for `Gi0/0/0` and a `shutdown` meant for
  `Gi0/0/1` both landed on the first interface in the file.
* **Comment lines (`!`, `#`) are ignored in every mode**, including the `! PacketForge running-config`
  header the printer writes itself.
* **An interface name is the rest of the line**, because some contain spaces — Ubiquiti's `Port 1`,
  `SFP+ 1`. Splitting on whitespace and taking one token made those devices' configs unreplayable.

Configs copied out before this was fixed (block after block, no `exit`) still replay: the parser treats
a new `interface` line inside interface mode as a mode switch, and falls through to global config
commands when a line is not an interface command.

### What the config contains

Being replayable is not enough — a config that omits the whole VLAN table is perfectly replayable. So
the output is also *complete*: every object the CLI can configure appears in it, in the form the parser
takes back.

| Section | Printed as |
|---|---|
| hostname | `hostname <name>` |
| interfaces | `interface <name>` block: description, `speed`, `duplex`, `ip address`, switchport VLAN/trunk, `channel-group`, `ip access-group`, `shutdown`, `vrrp <vrid> …` |
| VLAN table | `vlan <id> [name] <text>` |
| DHCP pools | `ip dhcp pool <name>` block: network, range, default-router, dns-server, excluded-address, lease, `host <addr> <mac>` |
| DNS zones | `dns zone <apex>` followed by `dns add <name> <type> <value>` |
| ACLs | `access-list <id> <rule>` |
| routing | `ip route <dest> <mask> <gateway> [iface]`, `ip default-gateway <addr>` |
| name servers | `ip name-server <addr>` (one line each) |
| SCION | `scion <isd-as>` |
| OSPF | `ospf router-id <ip>`, `ospf area <id>`, and per interface `ip ospf cost <n>`, `ip ospf area <id>`, `ip ospf passive` |
| BGP | `router bgp <as>`, `bgp router-id <ip>`, `neighbor <ip> remote-as <as>` |
| IPv6 addresses | per interface `ipv6 address <prefix>/<len>`, `ipv6 address autoconfig` |
| IPv6 routing | `ipv6 route <prefix>/<len> <next-hop>`, `ipv6 gateway <addr>` |
| IPv6 router advertisements | `ipv6 nd ra enable`, `ipv6 nd suppress-ra`, `ipv6 nd ra managed`, `ipv6 nd ra other-config`, `ipv6 nd ra lifetime <s>`, `ipv6 nd prefix <prefix>/<len> valid <s> preferred <s>` |

Two fields are deliberately **not** printed because no command can express them: a DNS zone's
`defaultTtl` (records inherit it) and a per-record `ttl`. A default value that the device already
assumes — VRRP `preempt` on, `advertise 1`, switchport `allowed vlan all` — is printed only when it
differs, which is the same rule the rest of the config follows.

`test/config-roundtrip.test.js` asserts both halves: the printed config replays into an identical
config, and no configured value is missing from the text.

That sweep cannot catch a feature *nobody configured in it*: it prints what each device holds and reads it
back, and a feature that is absent from the device is trivially consistent. Eight of them were absent from the
printer altogether - BGP, OSPF (global and per interface), SCION, name servers, IPv6 addresses, IPv6 routes
and gateway, and the IPv6 router-advertisement policy - so a backup of a configured router came back without
its routing protocol. `test/config-completeness.test.js` closes that hole from the other side: it declares
**every** key `device.config` can hold, with the pattern the printer must produce for it, so a new piece of
state that nobody taught the printer to print fails the suite instead of shipping as a silent omission.

### Undoing a command: every printed line has a `no` form

A backup is only a backup if you can edit it back. The rule `test/config-undo.test.js` holds every feature to
is: add a command, then remove it, and the printed config returns **byte for byte** to what it was — and
removing something that is not there refuses and names the thing.

```
r1(config)#no hostname
% No hostname set (the device is named ASR 1001-X aggregation services router-r1)

r1(config)#no vlan 20
% VLAN 20 is still carried by 1 port(s): Fa0/3 - move them off it first

r1(config-if)#no ip access-group 103 in
% Access list 102 is applied in on Gi0, not 103
```

Four commands used to be one-way doors — accepted, printed, and impossible to take back from the console —
and `no vlan` printed "VLAN 42 removed" whether or not a VLAN 42 existed:

| command | `no` form | removing what is not there |
|---|---|---|
| `hostname <name>` | `no hostname` | `% No hostname set (the device is named …)` |
| `ip dhcp pool <name>` | `no ip dhcp pool <name>` | `% No DHCP pool named <name>` |
| `dns zone <name>` | `no dns zone <name>` | `% No DNS zone named <name>` |
| `ip access-group <n> in\|out` | `no ip access-group [<n>] [in\|out]` | `% No access list <n> applied in on <port>` |
| `vlan <id>` | `no vlan <id>` | `% VLAN <id> does not exist` |

Two of those refusals are there for more than tidiness:

* `no ip access-group 103 in` while **102** is applied refuses and names 102. Silently clearing "whatever is
  bound" would remove a policy the operator did not ask about.
* `no vlan 20` refuses while any port **depends on** it, and says how. Two kinds of dependence are counted,
  and both are named:
  * **carried** — asked of the data plane's own rule, not a second copy of it, so a trunk allowing all VLANs
    counts (`still carried by 1 port(s): Fa0/4`) and a native VLAN is marked `(native)`;
  * **referenced** — a trunk parameter stored on a port that is not in trunk mode yet
    (`still referenced by 1 port(s): Fa0/3 (trunk native, trunk allowed, stored) - clear that first`).

  Deleting a VLAN behind the ports' backs left `show running-config` no longer printing `vlan 20` while
  `show vlan` still listed it from the member ports — two descriptions of one switch that disagreed. The
  referenced case was worse: removing the VLAN cleared a port's staged native VLAN in silence.

`no hostname` also puts the device's previous name back, because `hostname` sets both the config line and the
canvas label so the two cannot disagree (#21); undoing only half of it would leave a clean config over a
label that lies.


## Config-mode commands

| Command | Effect |
|---------|--------|
| `hostname <name>` | set device hostname |
| `no hostname` | clear it, restoring the device's previous name |
| `interface <name>` | enter interface config mode |
| `ip route <dest> <mask> <gw> [iface]` | add static route |
| `no ip route <dest> <mask> [gw]` | remove static route |
| `ip default-gateway <gw>` | set default gateway (hosts) |
| `no vlan <id>` | remove a VLAN (refused while ports still carry it) |
| `no ip dhcp pool <name>` | remove a DHCP pool |
| `no dns zone <name>` | remove a DNS zone and its records |
| `do show …` | run a `show` from config mode |
| `exit` / `end` | leave config mode |

## Interface-mode commands

A port answers to any spelling it is silkscreened or configured under, so `interface ether1` opens the
socket the panel calls `eth1` and `interface SFP+1` opens `sfp+1`. The naming table lives in
`engine/iface-name.js` and is used by both the console and the engine — there is no second copy, because two
copies of one naming rule drift. Ambiguity is refused rather than guessed: if two ports fold onto the same
spelling, that spelling resolves to nothing and the command says the port does not exist. Whatever you
type, everything printed afterwards uses the panel spelling.

A netmask has to be a run of ones followed by zeros — `255.0.255.0` is a valid IPv4 *address* and not a
netmask, because it has no prefix length, and every rule stated as a prefix length would describe something
other than what the device does. It is refused, and the refusal names the mask rather than the address:

```
R1(config-if)#ip address 10.9.9.9 255.0.255.0
% Invalid mask: 255.0.255.0 - a netmask is a run of ones then zeros (255.255.255.0, or 24)
```

The mask may be written as a prefix length (`24`) and is **stored in the dotted form** either way, so
nothing downstream has to guess which spelling it is looking at. The front panel applies the same rule: a
mask it cannot express as a prefix length is shown as `?`, never as a plausible number.

| Command | Effect |
|---------|--------|
| `ip address <ip> <mask>` | assign an IP (e.g. `192.168.1.1 255.255.255.0`); the mask must be a run of ones then zeros, and may be written as a prefix length (`24`) |
| `no ip address` | remove the IP |
| `clock rate <bps>` | (serial only) make this end the DCE and clock the line, e.g. `clock rate 64000`. Refused on a non-serial port, and for a rate the port cannot clock |
| `no clock rate` | drop the clock, leaving this end as DTE |
| `ip address dhcp` | make the port a DHCP client; the address it ends up with is the outcome of the exchange, not part of the configuration |
| `shutdown` / `no shutdown` | administratively disable / enable |
| `description <text>` | set a description |
| `exit` | back to config mode |

**A port has one method.** `ip address dhcp` displaces a static address and says which one it removed;
`ip address <ip> <mask>` displaces the DHCP client and says so. One port holding both was three lies at once —
it held an address it did not own, `show ip interface brief` reported Method `DHCP` beside that address, and
`show running-config` printed only the static line, so restoring the backup lost the DHCP intent. `no ip
address` now names what it removed (`IP address 10.0.0.9/24 removed`, `DHCP client removed`), or refuses when
there is nothing to remove.

`show running-config` prints the **method**, not the outcome: a host that has leased `10.0.0.100` prints `ip
address dhcp`, because a backup that bakes in a leased address claims that address on any network it is
restored onto and never asks again.

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
Codes: C - connected, S - static, O - OSPF, B - BGP
Gateway of last resort is 10.0.0.1 to network 0.0.0.0
C   10.0.1.0       /24  is directly connected, Gi0/0
C   10.0.2.0       /24  is directly connected, Gi0/1
S*  0.0.0.0        /0  [254/0] via 10.0.0.1
R1# ping 10.0.1.10
Type escape sequence to abort.
Sending 4, 100-byte ICMP Echos to 10.0.1.10, timeout is 2 seconds:
!!!!
Success rate is 100 percent (4/4)
```

### Reading `show ip interface brief`

The **Status** column answers "can this port carry a frame", not merely "did somebody shut it":

| Condition | Status | Protocol |
|---|---|---|
| shut down here (`shutdown`) | `administratively down` | `down` |
| no cable plugged in | `down` | `down` |
| cabled, but the far port is shut down | `down` | `down` |
| cable patched but taken down (`link down`) | `down` | `down` |
| otherwise | `up` | `up` |

The reason travels with it in `show interfaces` — `status: down (no cable)`, `status: down (peer shut
down)`, `status: down (link down)` — because `status: up` printed directly above `peer: disconnected`
was two halves of one output disagreeing. A cable that was pulled with `link down` is not the same fault
as a socket with nothing in it, and the two need different fixes. A wireless radio has no cable to miss, so it is up when its radio is.

A device that is **not part of a topology** has no cables to report on, so its ports keep their old
answer (`up` unless shut). The command cannot know about a cable it was never told about, and inventing
`down` for every port of a bare device would be a different wrong answer.

### Counters

Each port block also carries what has crossed it:

```
Gi0 (ethernet, 1G), MAC 02:00:00:00:00:00
  status: up, protocol: up
  ip: 10.0.0.1/24
  peer: sw/Fa0/1
  4 packets input, 196 bytes
  4 packets output, 196 bytes
```

Counted where the frame actually is: on arrival, before any drop test (a frame an ACL threw away was still
received), and on the port it leaves by, only if it really left. Counters accumulate over every run
against that topology, like real interface counters — a second `ping` adds to the first.

These are **interface** counters: they count every frame the socket moved, including ARP, LLDP and ICMP.
The flow figures reported elsewhere stay transport-only, so a switch sending an LLDP frame cannot make a
connection's byte count move.

Bytes are the payload carried: the transport payload, the ICMP echo payload, ARP's 28 bytes, or the TLVs
an LLDP frame is made of. A port that only received broadcasts is therefore not at zero — ARP for the
gateway and the switches' LLDP reach it — but it will have carried none of your echoes.

With **no simulation run** behind the device, the block says `counters: not measured (no simulation run)`
rather than printing zeros. "Nothing has looked" and "nothing crossed" are different answers, and a table
that conflates them is a table you cannot trust when a link is quiet.

#### What the port threw away

A fourth kind of line appears when the port discarded something, and only then:

```
  4 packets input, 200 bytes
  2 packets output, 124 bytes
  2 drops ("ACL 101 denied (in)" x2)
```

A reason that brings its own brackets is quoted, because printed inside the summary's own brackets it
nested — `2 drops (ACL 101 denied (in) x2)` — which closes the list early for anyone reading it as a list
and reads as two lists for anyone else. The summary is now one level deep whatever the reason says, so
`reasons xN, reasons xN` can be read back into exactly what was counted.

The console's per-port numbers and the payload's are the same numbers: `runtime.<device>.counters.ports` is
the tally `show interfaces` prints, published by `fullState()`, and `test/counters-agreement.test.js` runs
both across a crossing frame, a flooded one, a refused one, a shut port and a reset — then across every
switch in the catalogue — and requires them to agree port by port, reason by reason. A port that has counted
nothing is absent from the payload (there is no row to disagree about) and `counted` says whether the device
has carried anything at all.

The reason is the engine's own, so it names the thing you have to edit — the ACL and its direction, the VLAN
that had no path, the address nobody answered for. Counted in one place, where every discard passes:
`drop`, `acl-deny`, `vlan-drop`, `nat-drop`, and any event marked `discard: true`. An `acl-deny` emitted no
`drop` event at all before this, so a denied ping left the port looking completely idle.

Drops that never had a port in scope — `no route to 10.0.0.99` happens before an egress is chosen — are
reported once at the end of the table as `device-wide N drops (…)`, rather than being invented onto
whichever port was printed first. A frame waiting on an ARP reply that never came is reported the same way
it is counted: `no ARP reply from 10.0.0.9`, on the port that asked, and the `ping` that failed says the
same sentence instead of carrying a null reason.

`show interfaces` never claims a drop that did not happen: a port with a clean record prints no drops line
at all, because a wall of `0 drops` on every unused port is how a real one gets missed.

#### Naming one port, and what it does with a frame

`show interfaces <name>` answers about the port that was named, resolved by the same table `interface <name>`
uses, so both commands agree about which sockets exist — a name that matches nothing is refused by name rather
than answered with the whole box, which is what it used to do. With no name, every interface is listed,
subinterfaces included and placed after their parent.

**The name is the whole rest of the line.** Some devices in the catalogue name their ports with a space in them —
Ubiquiti's `Port 1`, `SFP+ 1`, `LAN IN` — and this command used to read only the first word, so

```
sw1#show interfaces Port 1
% No interface Port on EdgeSwitch 24 PoE (250W)
```

refused a port that was right there, and named one that does not exist. `interface Port 1` has read the rest of
the line since it was fixed for exactly this reason; the reporting side was left behind, and now reads the name the
same way. A name that really does match nothing is refused with **the whole name you typed**:
`% No interface Port 99 on …`, never truncated to its first word.

Each block carries one switchport line, because the command an operator opens first is the one that has to
say what the port does with a frame:

```
Gi0/0.10 (subinterface, 1G), MAC 02:00:00:00:00:00
  ...
  ip: 10.9.9.1/24
  ...
                    <- no switchport line: a routed port does not switch

Fa0/1 (ethernet, 1G), MAC 02:00:00:00:00:00
  ...
  switchport: access VLAN 20

Fa0/3 (ethernet, 1G), MAC 02:00:00:00:00:02
  ...
  switchport: access VLAN 1 · trunk staged: native 20 (not in use)

Fa0/2 (ethernet, 1G), MAC 02:00:00:00:00:01
  ...
  switchport: trunk · native 30 · allowed 10,20

Fa0/4 (ethernet, 1G), MAC 02:00:00:00:00:03
  ...
  switchport: trunk · native 1 · allowed none
```

A parameter that is stored but not in force is labelled **staged (not in use)** rather than reported as if the
port were trunking — the same distinction `show vlan` makes by listing the port under the VLAN it carries.
`allowed none` is a trunk that carries nothing: an empty allowed list drops every VLAN, so it is not reported as
`all`.

The sentence is written once, in `engine/vlan.js` (`switchportSentence`), and mirrored in `web/app.js` for the
inspector panel — the browser cannot `require` the engine. The panel used to print its own rendering (`access
1`), and it had already drifted: it knew nothing about staged parameters, and `|| 1` made an unset trunk native
VLAN indistinguishable from a native VLAN of 1. `test/switchport-agreement.test.js` compares the two across 360
port states and checks every claim the sentence makes against `classifyEgress`.

#### Line rate and duplex

```
  peer: sw/Fa0/1
  speed: 100Mb/s (forced), duplex: half
```

`(auto)` means the port offers its full ladder and the link negotiates; `(forced)` means `speed 100` pinned
it. When the two ends cap the link lower than either port could run, the block adds `link runs at …`. A rate
the port cannot do is refused, naming the port, the rate and what it *does* support — `Gi0 does not support
10G - it supports 10M, 100M, 1G`.

`duplex half` is why `W_DUPLEX_MISMATCH` exists: the validator has modelled the mismatch since the
connector rules were written, but nothing could set duplex, so the warning was unreachable. Force one end to
half against a full-duplex peer and it fires, naming both ends.

Both halves of this setting survive a save: `duplex` always did, and `speed` did not — a lab saved with
`speed 100` came back negotiating, with the command gone from `show running-config` too, so nothing put it back
(#1405). The forced rate is written to the port document only when it is set, so a port that negotiates its own
rate still writes no `speedMbps` line at all.

Two ends forced to rates with nothing in common do **not** silently work: the link has no line rate to run
at, it comes down, `show interfaces` says `link: down (no common rate with the peer)`, and frames across it
are counted as dropped with that reason.

### Reading `show vlan`

```
VLAN    Name                             Status    Ports
1       default                          active    Fa0/3, Fa0/4, Fa0/5, Fa0/6, Fa0/7, Fa0/8
20      twenty                           active    Fa0/1, Fa0/2, Fa0/3
30      thirty                           active    Fa0/2, Fa0/3
```

One row per VLAN, in VLAN order. **Membership is decided by the same rule the switch forwards by** — a port
appears under a VLAN if and only if a frame in that VLAN could leave by it:

* an access port appears in its access VLAN and in no other;
* a trunk appears in every VLAN its allowed list names — **and not in VLAN 1 unless VLAN 1 is allowed**. A
  trunk whose allowed list is `20,30` is not "in VLAN 1" because it is a trunk; that belief is how people
  chase a native-VLAN mismatch that the table was previously hiding;
* a trunk with `allowedVlan all` appears in every row.

A VLAN exists in this table if it is configured with `vlan <id> [name] [<text>]`, or if a port uses it. A configured
VLAN nothing carries prints an empty Ports column rather than an invented port.

`show vlan brief` prints the same table; there is no short form that disagrees with the long one.

### An address is an address

Every command that takes an IPv4 address asks one question of it, and the question is whether the octets are in
range - not whether the text has four dotted groups:

```
r1(config)#ip name-server 300.1.1.1
% Invalid name server "300.1.1.1": not an IPv4 address
r1(config)#ip default-gateway 300.1.1.1
% Invalid default gateway "300.1.1.1": not an IPv4 address
r1(config)#ip route 300.1.1.0 255.255.255.0 10.1.1.9
% Invalid destination "300.1.1.0": not an IPv4 address
r1(config)#ip route 192.0.2.0 255.255.255.0 300.1.1.9
% 192.0.2.0/24: "300.1.1.9" is neither a next-hop address nor an interface on ISR 4331 branch router-r1
r1(config)#ip nat pool NP 300.1.1.1 300.1.1.9 netmask 255.255.255.0
% Invalid pool address "300.1.1.1": not an IPv4 address
r1(config-router)#neighbor 300.1.1.1 remote-as 65002
% Invalid neighbor address "300.1.1.1": not an IPv4 address
r1(config)#ospf router-id 300.1.1.1
% Invalid router-id "300.1.1.1": not an IPv4 address
```

`net.isIp()` used to be a shape check - four groups of one to three digits - so `300.1.1.1` and `10.0.0.999` were
addresses as far as every caller was concerned, while `ip address`, `vrrp 1 ip` and `ping` refused them because they
went through `ipToInt()` instead. One predicate now, and it asks the parser: an address that cannot exist is refused
by every door, with the value quoted back.

Two neighbours of that rule live here too, because they are the same mistake in different clothes:

* **A mask is a mask.** `ip route` "validated" its mask with a call whose result it threw away, and `maskToInt()`
  turns a non-contiguous mask into an integer rather than refusing it - so `ip route 192.0.2.0 255.0.255.0
  10.1.1.9` answered `Route added: 192.0.2.0/8`, installing a prefix nobody asked for. It now uses the same
  contiguity rule and the same sentence as `ip address`: `% Invalid mask: 255.0.255.0 - a netmask is a run of ones
  then zeros (255.255.255.0, or 24)`.
* **A route with nowhere to go is not installed.** `ip route <dest> <mask>` with neither a next hop nor an
  interface used to be accepted as `on-link`, and the table then described it as *"no next hop: ARP for the
  destination on that segment"* - naming a segment the command never mentioned. It is now
  `% Incomplete command: ip route 192.0.2.0 255.255.255.0 needs a next hop or an interface`. The interface-only
  form is still legal and still says what it will take to work.

### A VLAN id is a number

Wherever a VLAN is named — `vlan <id>`, `no vlan <id>`, `switchport access vlan`, `switchport trunk native vlan`,
`switchport voice vlan` — the argument is a whole number from 1 to 4094. A word is refused, and the refusal quotes
it:

```
sw1(config)#vlan WORD
% Invalid VLAN id "WORD": a VLAN id is a whole number from 1 to 4094
sw1(config)#vlan 1.5
% Invalid VLAN id "1.5": a VLAN id is a whole number from 1 to 4094
sw1(config)#vlan 4095
% VLAN id 4095 is outside 1-4094
sw1(config)#vlan 1002
% VLAN id 1002 is reserved by IEEE 802.1Q (1002-1005)
sw1(config-if)#switchport access vlan WORD
% Invalid VLAN id "WORD": an access VLAN is a whole number from 1 to 4094
sw1(config-if)#switchport voice vlan banana
% Invalid VLAN id "banana": a voice VLAN is a whole number from 1 to 4094 or "none"
```

These five doors used to accept the word. `vlan WORD` answered **`VLAN NaN created (name: VLAN0NaN)`** and wrote
`vlan NaN VLAN0NaN` into `show running-config` — a line that is not a VLAN and cannot be typed back — while
`show vlan` did not list it at all, and the save file wrote the id as `null` and lost it. `switchport access vlan
WORD` answered `Access VLAN NaN on 1`, and `show interfaces` then said `switchport: access VLAN 1`, because it
read the same port through the normaliser that had turned the unreadable value into VLAN 1.

The cause was ordering, not a missing check: `normalizePortConfig()` exists to hand the engine a usable port, so it
replaces a value it cannot read with VLAN 1 — and `validatePortConfig()` was being handed that normalised copy. The
integer rule it has always had (`must be a whole number`) could never fire, because the only values that reached it
were the ones the normaliser had already made integral. The validator now receives the value the caller passed, so
every door shares one rule again, and the console checks the *shape* of the argument (a token, not a value) so its
answer can quote what was typed instead of the field name the validator uses internally.

### Pinging a name, and reading DNS

`ping <address|name> [<count 1-50>] [at <ms>]` — an address or a name, how many echoes, and optionally the instant to
ask at. The count is a whole number from 1 to 50: `ping 10.0.0.1 51` is refused rather than sent, because the count
is a loop bound and fifty is what one console answer is sized for. A stray word is refused too, with the usage
attached, and `at` must be followed by a number.

```
r1> ping 10.0.0.1 51
% Count must be a whole number from 1 to 50 (asked for 51)
r1> ping 10.0.0.1 abc
% Unrecognized "abc" (ping <address|name> [<count 1-50>] [at <ms>])
r1> ping 10.0.0.1 5 at later
% Invalid instant: later
```

A name is resolved through the lab's DNS servers before a packet is sent, and
the console prints the resolution the way a box does:

```
h1> ping r1.lab
Type escape sequence to abort.
Translating "r1.lab"...domain server (10.0.0.1) [OK]
  r1.lab -> 10.0.0.1
Sending 4, 100-byte ICMP Echos to 10.0.0.1, timeout is 2 seconds:
!!!!
Success rate is 100 percent (4/4)
Reply from 10.0.0.1: bytes=100 time=0.002 ms
```

A name that does not resolve is refused **before** anything is sent, and the three ways it can fail are kept apart,
because they have different causes and different fixes:

```
h1> ping nope.lab
% Could not resolve "nope.lab": NXDOMAIN - no zone any server here hosts contains that name
% Nothing was sent. Check the zone on 10.0.0.1, or the name servers this device asks.
h1> ping only-txt.lab
% Could not resolve "only-txt.lab": NODATA - the name exists on 10.0.0.1 but has no A record
% Nothing was sent. Add an A record: dns add only-txt.lab A <address>
```

and `SERVFAIL` when no device in the lab hosts a zone at all, or when no listed server answers. Digits and dots
that are not a valid address (`ping 10.0.0.999`) are refused as an address rather than looked up as a name.

`show ip dns` reads the zones back — the records that are actually answered, in zone-file shape:

```
r1> show ip dns
Zone lab (default TTL 3600) - 4 record(s)
  r1.lab                             3600    IN A        10.0.0.1
  www.lab                            3600    IN A        10.0.0.50
  alias.lab                          3600    IN CNAME    www.lab
  only-txt.lab                       3600    IN TXT      hello

% No name servers configured (use "ip name-server <address>" in config mode)
```

`show ip dns zone <name>` narrows to one zone; an unknown name lists the zones that do exist. A zone the server
would refuse to answer for is printed with `NOT answered: <reason>` and the offending record, rather than shown as
if it were live. A device with no zones says it is not a DNS server, and names the command that would make it one.

A resolver list is optional, and the report says what happens without one: a lookup asks *any* server in the lab,
which is what `Simulator.resolveName()` does for a small lab.

### Why an echo never came back

A ping that fails used to say one thing and know another. The exchange records a reason for every lost echo — the
earliest cause, ranked since #1431 — and the console printed the timeout and discarded it:

```
r1> ping 10.0.0.99 1
Type escape sequence to abort.
Sending 1, 100-byte ICMP Echos to 10.0.0.99, timeout is 2 seconds:
.
Success rate is 0 percent (0/1)
Request timed out (seq 0)          <- everything the console said
replies: [{ reason: "no ARP reply from 10.0.0.99" }]     <- everything it knew
```

That is the most-used command in the lab answering *something went wrong* to the question *what went wrong*. So the
report now closes with one line, in the engine's own words:

```
r1> ping 10.0.0.99 1
Type escape sequence to abort.
Sending 1, 100-byte ICMP Echos to 10.0.0.99, timeout is 2 seconds:
.
Success rate is 0 percent (0/1)
Request timed out (seq 0)
% Echoes lost: 1 drop (no ARP reply from 10.0.0.99)
```

Four echoes are one statement about the path, not four; the count lives in the sentence:

```
r1> ping 10.0.0.10 4
!!!!
Success rate is 0 percent (0/4)
Request timed out (seq 0)
Request timed out (seq 1)
Request timed out (seq 2)
Request timed out (seq 3)
% Echoes lost: 4 drops (peer port shut (R1 Gi0/0/0) x4)
```

The phrasing is the one the port counters already used — `3 drops (no route to 10.0.0.99 x2, link down)`, longest
reason first, `xN` for a repeat, reasons past the third counted rather than hidden — and it lives in one function,
`Simulator`'s `dropsSentence()`, which `show interfaces` and `ping` both call. A reason that brings its own brackets
is quoted (`"ACL 101 denied (in)"`), so the list stays one level deep for a reader and does not end early for a
parser.

Two silences are deliberate. A path that is **still converging** is not loss and keeps its own sentence (`% Still
converging: stp on s1 (ready at 30000 ms)`), never both. And a failure with **no recorded reason** prints nothing
extra: the timeout line already said what happened, and inventing a cause for it would be worse than the gap.

The browser's Simulate dialog draws the same sentence from the same rule, mirrored and checked case for case, so a
percentage and its explanation cannot drift apart on one surface and agree on the other.

### Reading DHCP

DHCP has been modelled end to end since it was: pools, ranges, exclusions, reservations, lease times, renewals
and expiry. The server keeps an allocation table — which MAC holds which address, and when it comes back — and
until now **nothing could read it**: there was no `show ip dhcp` at all. You could build a pool and not find out
whether a single address had been handed out.

```
r1> show ip dhcp binding
IP address      Client identifier / MAC          Pool              Expires in
192.168.10.100  02:00:00:00:01:00                lan               3540s (0:59:00)
192.168.10.105  02:00:00:00:00:0a (reserved)     lan               3595s (0:59:55)

2 active binding(s); the lease clock runs from the instant the lease was granted
```

`Expires in` is the lease time counted from the instant it was granted, not from the last time you looked. The
`(reserved)` marker means the address is the one that MAC is pinned to, so it will get it back after any lapse.

```
r1> show ip dhcp pool
Pool lan:
  Network:        192.168.10.0 255.255.255.0
  Range:          192.168.10.100 - 192.168.10.110
  Default router: 192.168.10.1
  DNS servers:    1.1.1.1
  Lease:          60s
  Excluded:       192.168.10.102
  Reservations:   192.168.10.105 (aa:bb:cc:00:00:99)
  In use:         2 of 10 address(es)
                  192.168.10.100 (02:00:00:00:01:00), 192.168.10.105 (02:00:00:00:00:0a)
```

The capacity in `In use` is counted the way allocation counts: the range endpoints included, exclusions removed,
network and broadcast removed, and the gateway removed when it sits inside the range. A reservation is counted,
because it is allocatable to its owner.

A binding can be asked for by address or by MAC, and an unknown one is reported rather than shown as an empty
table:

```
r1> show ip dhcp binding aa:bb:cc:dd:ee:ff
% No binding for aa:bb:cc:dd:ee:ff (no lease is held by that MAC)
r1> show ip dhcp pool guest
% No DHCP pool named guest (pools on this device: lan)
```

A lease that lapses is not kept forever: when the deadline passes the address goes back into the pool and can be
handed to someone else. `show ip dhcp binding` still shows a lapsed row — marked `lapsed (address free)` — for as
long as the server's table holds it, because a table that forgets a row cannot explain why an address is
unavailable.

```
sw1> show ip dhcp binding
% This device is not a DHCP server (no "ip dhcp pool" configured)
```

### Reading OSPF

OSPF has been configurable since it was modelled — `ospf router-id`, `ospf area`, and per interface
`ip ospf cost | area | passive` — and the engine turns those into adjacencies, an SPF tree and installed routes.
Until now the console could not report any of it: the only place OSPF appeared was an `O` in `show ip route`. You
could set a cost and had no way to find out whether the engine used it.

```
r1> show ip ospf
Routing Process "ospf 0" with ID 1.1.1.1
  Areas: 0
  Interfaces: 2 (1 passive)
  Neighbours: 1
  Routes installed from OSPF: 1
```

```
r1> show ip ospf neighbour
Neighbor ID     Address          Interface   State
2.2.2.2         10.1.0.2         Gi0/0/0     Full

1 neighbour(s), all Fully adjacent
```

```
r1> show ip ospf interface
Interface   IP Address       Area  Cost  Cost from   Adjacent  Passive
Gi0/0/0     10.1.0.1/24      0     25    configured  yes       no
Gi0/0/1     192.168.1.1/24   0     10    link rate   no        yes
```

`Cost from` answers the question the two numbers alone cannot: **25** because somebody typed `ip ospf cost 25`, or
**10** because the wire is 100 Mbps and nothing was typed (the derived cost uses a 100 Mbps reference bandwidth:
100 Mbps → 100, 1 Gbps → 10, 2.5 Gbps → 4, 5 Gbps → 2, 10 Gbps and above → 1). A cost that came from the link
rate changes when the link renegotiates; a configured one does not.

Every number here is what `computeOspf()` recorded, so the report and `show ip route` cannot disagree about the
same topology. That includes the wait: on a lab that has not settled, the summary says
`(withheld: still converging)` beside the route count, because that is what the engine did.

`show ip ospf neighbour <port>` and `show ip ospf interface <port>` narrow to one port, and name the reason when
the port you asked about is not contributing:

```
r1> show ip ospf neighbour Gi0/0/1
% Gi0/0/1 is passive: it advertises its prefix and forms no adjacency
r1> show ip ospf interface Gi0/0/2
% Gi0/0/2 has no address: OSPF needs one to form an adjacency
```

An access switch has no OSPF at all, and says so rather than printing an empty table:

```
sw1> show ip ospf
% OSPF is not enabled (use "ospf router-id <ip>" in config mode)
```

### The voice VLAN

```
interface Gi1/0/5
 switchport mode trunk
 switchport trunk allowed vlan 10
 switchport voice vlan 20
```

A phone on that port talks on VLAN 20 and the PC behind it on VLAN 10. The voice VLAN is carried by the trunk
**whether or not it appears in the allowed list** — that field is how the switch is told which VLAN voice traffic
arrives on — so the port above carries 10 (native data) and 20 (tagged voice) and nothing else.

The parameter needs a trunk, because voice traffic is tagged. On an access port it is accepted and **stored, not
in use**:

```
sw1(config-if)# switchport voice vlan 20
Voice VLAN 20 on Gi1/0/5 (stored; the port is in access mode - set "switchport mode trunk" to use it)
```

`show interfaces <port>` says the same thing in one sentence, and the inspector panel prints the same sentence:

```
switchport: trunk · native 10 · allowed 10 · voice 20
```

`no switchport voice vlan` removes it and names the value that was in force; `switchport voice vlan none` does the
same. `show running-config` prints `switchport voice vlan 20` inside the interface block, and a saved board restores
it, so a reloaded lab still separates voice from data.

### NAT: configuring it, and reading what it did

```
interface Gi0/0/1
  ip nat inside
exit
interface Gi0/0/0
  ip nat outside
exit
ip nat pool WAN 203.0.113.1 203.0.113.1 netmask 255.255.255.0
ip nat inside source list 192.168.10.0/24 pool WAN overload
ip nat inside source static 192.168.10.60 203.0.113.1 tcp 443
```

### Which side of the translation a port is on

`ip nat inside` and `ip nat outside` name the boundary, and a translation happens on it. Without them the model
translated on **every** port in both directions, because the "out" half ran before the route lookup and asked only
whether the source matched a rule — so a rule for `192.168.10.0/24` rewrote the source of a packet going from one
inside host to another through the same router, traffic that never left the private network.

```
% ip nat inside belongs to an interface: enter one first, e.g. interface Gi0/0/1
Interface Gi0/0/1 is now the inside interface for NAT
Interface Gi0/0/1 is now the outside interface for NAT (was inside)
% Gi0/0/1 is not the inside interface (it is the outside interface)
```

A port holds one side, not two: setting the second names the side it left. Clearing the side it does not hold says
which side it does hold. A device without the `nat` capability is refused all of it.

**A lab that declares no sides keeps the older behaviour** — a rule may translate on any port — because that is what
every board built before the roles existed does, and quietly changing what a saved lab does would be worse than the
defect. `show ip nat statistics` says which of the two rules is in force, first line:

```
Ports: inside Gi0/0/0, Gi0/0/1 - outside Gi0/0/2
Ports: no port is declared inside or outside - a rule may translate on any port
```

Declaring the sides is what stops the inside-to-inside translation, and the sides survive a save, a reload, and a
`show running-config` (printed inside the interface block, which is the only place the parser accepts them).

The engine has translated static, dynamic and PAT since it was written, and until now **no command could
configure any of them** — `config.nat` had no writer, so a lab could not ask the question at all. Four spellings
create a rule:

| command | rule |
|---|---|
| `ip nat inside source static <local> <global>` | one-to-one, both directions |
| `ip nat inside source static <local> <global> tcp <port>` | port forwarding |
| `ip nat inside source list <spec> pool <name>` | dynamic — the pool's addresses are handed out |
| `ip nat inside source list <spec> pool <name> overload` | PAT — many inside locals on one address |
| `ip nat inside source list <spec> interface <if> [overload]` | translate to the interface's address |

Rules are checked by the model's own `validateRule()`, so a rule the console accepts is a rule the data path can
apply. The refusals are specific:

```
% PAT overloads one address; pool "TWO" holds more than one. Use a single-address pool for overload,
  or drop `overload` for a dynamic pool
% 10 is an ACL number: this model takes the inside local addresses here, e.g. `list 192.168.1.0/24`
% Gi0/0/3 has no address: there is nothing for NAT to translate to
% NAT pool "WAN" ends before it starts (203.0.113.9 - 203.0.113.1)
```

`no ip nat inside source` removes the most recent rule and **names the rule it removed**; `no ip nat pool <name>`
refuses while a rule still uses the pool, and says how many.

```
show ip nat rules            # the rules, printed as the commands that would create them
show ip nat translations     # the live table: proto, inside global, inside local, outside local/global
show ip nat statistics       # rules by type, pools, timeouts, active translations
```

### What the MAC table remembers, and for how long

A dynamic entry is where a frame was last seen, and when. Silently, for longer than **300 s**, it is gone: the
`Age` column is the silence, so a run that carries no traffic for five minutes legitimately ends with an empty
table.

```
Vlan    Mac Address         Type        Age     Ports
1       02:00:00:00:01:00   DYNAMIC     0s      1/1/1
1       02:00:00:00:02:00   DYNAMIC     140s    1/1/2
```

The age is **silence, not a lifetime**: a frame from that address resets it, and a busy host never ages out. The
same rule decides forwarding, not just the report — an entry the table only remembers is not a port a frame may be
sent to, because a host that moved would otherwise be unreachable while the frame went where it used to be. When the
lookup answers nothing the frame floods, exactly as it does for an address never seen.

An entry that carries no timestamp — written by a fixture, an imported lab, an older caller — is never aged and
reports `-`. That is the honest reading: nothing recorded when it was seen. The simulator's own learning always
stamps the instant it was asked at, so a lab built by traffic ages; a lab built by hand does not, until traffic
touches it.

### A translation that has been idle is not in force

A dynamic or PAT translation lives for its protocol's timeout, and each packet through it restarts the clock:

| protocol | default |
|---|---|
| icmp | 60 s |
| udp | 300 s |
| tcp | 3600 s |
| anything else | 300 s |

`config.nat.timeouts` overrides any of them, and `show ip nat statistics` prints the values in force rather than
leaving the rule to be guessed:

```
Timeouts (seconds): icmp 60, udp 300, tcp 3600, other 300
```

The model has had `expireTranslations()` since it was written and nothing called it, so a translation was in force
for the life of the run. Two things were wrong because of it. A **two-address pool with three inside hosts** refused
the third host for ever — the first two connections had ended minutes earlier and still held the addresses. And
`show ip nat translations` listed entries past their timeout, because the report read the table directly instead of
asking at the instant the command was about.

Both now go through the same funnel: the table is aged at the instant being asked about, on the data path and in the
report. A translation that is still carrying traffic is never aged — the timeout is idle time, not a lifetime — and
a device that has carried no NAT traffic still says `No translations: no packet needing NAT has crossed this
device` rather than presenting an empty table it just created.

`show ip nat translations` distinguishes *nothing has crossed* (`No translations: no packet needing NAT has
crossed this device`) from *traffic crossed and nothing needed translating* — the same distinction
`show interfaces` makes for its counters. The rules survive a save and are printed by `show running-config`,
pools first, so a restored lab translates the same packets it did before.

### Reading `show spanning-tree`

```
Spanning tree enabled protocol ieee
  Bridge priority 4096 (this bridge is the root), root bridge core-sw1 priority 4096
Port          Role          State
Fa0/1         designated    forwarding
Fa0/2         root          blocking   (traffic dropped)
```

The header names the **bridge priority** and the **root bridge the election chose**. Without it the report
described a tree but not why it had that shape: priority decides the election before MAC address does, so two
switches with the same ports and the same cables can produce different trees and the output gave no clue which
one you were looking at. The priority in force is this device's; the root is named by hostname, else by the id
the lab uses — not by the model label, which is the same string on every switch of one kind.

There are three states, and the header says which one you are in:

* **a bridge in a tree** — `root bridge core-sw1 priority 4096`, with `(this bridge is the root)` after the
  priority when you are reading the root itself;
* **a lone bridge** — the election still runs, and answers with the only candidate: itself;
* **a box that is not a bridge** — a router. It prints `Spanning tree is not running on this device: it is not a
  bridge (no L2 forwarding)`, because a router never joins an election, and a report that describes one in terms
  of roots and bridge priorities implies it did.

A topology with **no bridges at all has no root**, and `engine/stp.js` answers `null` for it rather than a root
object with a default priority and no identity. That object is how `root bridge undefined priority 32768` reached
the console on 1,026 of the 2,038 models in the catalogue — the report was naming a hole.

### Setting the root

```
spanning-tree priority 4096
no spanning-tree priority
```

The bridge priority is `0`–`61440` in steps of `4096` (the low 12 bits are the system ID extension), and **lower
wins**. `0` is legal and is the best priority there is. A value that is not a step is refused rather than
rounded, because rounding silently picks a root the operator did not ask for:

```
% 4500 is not a valid bridge priority: it must be a multiple of 4096 (the low 12 bits are the system ID
  extension); the nearest valid values are 4096 and 8192
```

This model runs **one spanning tree for the device**, so IOS's per-VLAN spelling is refused with that reason
rather than accepted and quietly applied to everything:

```
% This device runs one spanning tree, not one per VLAN: use `spanning-tree priority <0-61440>`
```

`no spanning-tree priority` returns the bridge to the default `32768` and says what the default is. The value is
printed by `show running-config` and survives a save, so a reloaded lab elects the same root it did before.

With **no simulation run** behind the device the command says
`Not measured (no simulation run): nothing has computed the spanning tree` — the same distinction
`show interfaces` makes for its counters. "No ports are bridging" is a claim about the lab; "nothing has
looked" is a claim about this session, and printing the first when the second is true is how a lab gets
declared loop-free before anyone has looked at it.

### Reading `show etherchannel summary`

```
Group  Protocol          Ports
1      LACP (active)     Fa0/2(P) Fa0/3(D)
  Fa0/3     not bundled (down: link down)
  bundle 1 is running on 1 of 2 members: Fa0/2
```

The Protocol column names the protocol and the mode **in the words the mode is configured in** — `LACP
(active)`, `LACP (passive)`, `Static` for `mode on`. It used to print the model's internal spelling
(`lacp-active`), which no command accepts, while the console accepted `active` and then warned that it was an
unknown mode:

```
sw1(config-if)#channel-group 1 mode active
Interface Fa0/1 added to channel group 1 (mode active)
% Warning: LAG lag1: unknown mode "active" (expected one of lacp-active, lacp-passive, static).
```

That was the console and the model speaking different languages with no translation between them. The console
speaks IOS (`active|passive|on`); the model speaks `lacp-active|lacp-passive|static`; the table in
`engine/lag.js` translates once in each direction, so a lab saved by an older build holding `active` normalises
to the same state as one configured today.

Two consequences of the missing translation are worth knowing:

* **A group has one mode.** `channel-group 1 mode passive` from a second member changes the group for every
  member, and the console now says so — `Channel group 1 mode changed from active to passive for every
  member: Fa0/1` — instead of quietly reprinting the first port's configuration with the new mode.
* **A bundle of one is not a bundle**, and the summary says so (`group 1 has 1 member: a bundle needs at least
  2 ports`). It used to be a warning on every correct `channel-group` line, which is noise: the group is
  legitimately short between typing the first member and the second. The standing view of the group is the
  right place for a fact about the group.

`(P)` means bundled **and able to carry a frame**; `(D)` means the member cannot, and the line below it says
why in the same sentence `show interfaces` and `show arp` use — `administratively down`, `down: no cable`,
`down: link down`, `down: peer shut down`, or `(STP blocking)`.

The data plane uses the same rule: **the hash is taken over the members that can carry**, so unplugging one
member of a two-member bundle does not cost you half your flows while the other member sits idle. When no
member can carry, the bundle is reported down and the frames are still attempted and dropped with a reason,
so the loss is countable rather than invisible.

### Reading `show power inline`

```
sw1#show power inline
Interface  Admin  Oper  Draw     Powered device
1/1/1      up     on    12.95 W  PD1
1/1/2      up     off   12.95 W  PD2  (denied)
1/1/3      up     off   -        the far end is not a powered device
1/1/4      down   off   -        administratively down
22 ports with nothing plugged in: 1/1/5, 1/1/6, 1/1/7, 1/1/8, 1/1/9 (+17 more)

Total: 12.95 W of 25 W in use, 12.05 W left, 1 port denied
  1/1/2: PSE budget exhausted: 12.95 W requested, 12.05 W left
```

Every figure comes from the engine's own allocation (`Simulator.computePoe()`), not from a second copy of the
rule, and every PSE port is accounted for — including the ones the engine leaves out of its table, which are the
ones an operator is usually asking about:

* `denied` means the device asked and the budget could not supply it; the sentence under the table is the same
  one the timeline emitted for the `poe-deny` event, not a re-rendering of the same arithmetic;
* a port with a cable but no powered device behind it says so, rather than looking like a port that works;
* an administratively down port supplies nothing, and says why — the engine does not allocate through it, since
  it walks the active ports only;
* idle ports are summarised rather than printed one per line: a wall of `nothing plugged in` is how the one row
  that matters gets missed. `show power inline <port>` asks about any of them by name — the whole rest of the
  line, so `show power inline Port 1` asks about `Port 1` rather than about a port called `Port`.

The inspector's **Routes** table is the same table: it reads the rows `Device.routesTable(topo)` annotates,
so it shows the code the console prints (`S*` for the gateway of last resort), the administrative distance, and
the same sentence when a row cannot carry a packet — rather than a healthy-looking `code / prefix / gateway` list
on the one screen an operator has open while a link is broken.

Three things it refuses to fake: with no simulation run it prints `Not measured (no simulation run)` rather than
zeros; a device with PSE ports but **no budget** reports the ports and says the budget is not modelled, rather
than reporting 0 W it never measured; and a question about one port gets no device-wide total, because the number
would be about something else.

### Reading `show ip route` when a path is not there

An installed route can still lead nowhere. When its egress port cannot carry a frame, the row says so, in the
same words the other tables use:

```
C   10.0.0.0       /24  is directly connected, Gi0  (down: link down)
S  172.20.0.0     /16  [1/0] via 10.0.0.1  (down: link down)
```

A connected route or a static route stays listed when its port goes down — they are configuration, not
learned facts — but a row that reads as a working path while every packet to it is dropped is the defect. The
mark comes from the same helper `show arp` and `show mac address-table` use for the same port.

Learned routes behave differently, on purpose: an OSPF or BGP route whose session or adjacency is gone is
**withdrawn**, because the protocol would withdraw it. A router does not keep advertising a path it learned
over a cable that has been pulled.

### Reading `show ip bgp`

```
Neighbor         V  AS      State           Reason
10.0.0.1         4  65001   Idle            egress Gi0 cannot carry a frame (link down)

0 of 1 neighbour(s) established
0 prefix(es) installed from BGP
```

A session needs a port that can **carry a frame**, not merely a port nobody shut. `_bgpReachable()` used to
ask `enabled` and nothing else, so a session across an unplugged cable went on calling itself `Established`
and went on installing the prefixes it had learned over it — a `B` route whose next hop could not be reached.
Now the reason names the real fault: `cannot carry a frame (link down)`, `(peer shut down)`,
`(down: no cable)`, or `administratively down` for a port someone shut.

When prefixes are installed, the table below says which ones:

```
Network          Next Hop  Metric  LocPrf  Weight  Path     Session
10.0.0.0/24      10.0.0.1  0       100     0       65001 i  eBGP
```

The prefix list and `show ip route`'s `B` rows describe the same routes, with the same prefix lengths — they
are read together when a route is not being used.

### Reading `show access-lists`

```
Extended IP access list 101
  1 deny icmp any any (5 matches)
  2 permit ip any any
    applied IN on Gi0
```

Each rule carries how many packets it has matched, counted at the one place every frame is tested, so
permits are counted as well as denies. A rule that has matched nothing prints **no count at all** — saying
"0 matches" on every line of a twenty-line list is noise, and the absence of a number is the same statement.

`(implicit deny all: N matches)` appears once the implicit deny has actually dropped something. It is a real
rule even though nobody wrote it, and it is what throws away the traffic that matched nothing.

Counters are keyed by the rule's own text, so rewriting a list does not re-attribute old traffic to a new
rule that happens to sit at the same position. `no access-list <id>` deletes the counters with the list.

The number here and the `drops (ACL 101 denied (in) x5)` figure on `show interfaces` describe the same
packets; they are read together when working out why something is not getting through.

With no simulation run the table prints `counters: not measured (no simulation run)`; with a run but no
traffic through the list, `counters: no packet has been tested against this list`. Those are different
answers and neither of them is "zero".

### Reading `show lldp`

```
LLDP neighbours on Switch (L2)-sw:
  Neighbour                                  Local port  Port ID  Mgmt address
  ASR 1001-X aggregation services router-r1  Fa0/1       Gi0      10.0.0.1
  PC-pc                                      Fa0/2       eth0     -
```

The table is filled from LLDPDUs that actually crossed a link, not from the topology file, so an empty table
means nothing has announced itself. Column widths come from the data — a fixed 20-character Neighbour column
ran a 55-character router name into the Local port column, which made the row unreadable field by field.

A neighbour is **not** deleted when its link goes down: real switches hold the entry until its hold time
expires, and LLDP expiry is not modelled. Instead the Local port is marked with the reason, in the same
sentence `show arp` and `show mac address-table` use — `(down: link down)`, `(down: peer shut down)`,
`(administratively down)` — and the mark clears when the link comes back.

### Reading `show arp`

```
R1#show arp
Protocol  Address          Age (min)  Hardware Addr     Interface
Internet  10.0.0.9         20         02:00:00:00:02:00 Gi0
Internet  10.0.0.10        -          02:00:00:00:03:00 Gi0 (down: link down)
```

* **Interface** is the port the neighbour was heard on — where to look next.
* **Age** is the minutes since this neighbour was last **heard**, and it ages out: past four hours of silence
  (`ARP_AGE_MS`, the IOS default `arp timeout 14400`) the entry is gone and the router ARPs again for that
  next hop. Minutes, not steps — the model has had an instant in milliseconds since convergence was modelled.
* Using an entry does **not** reset its age. A cache hit is not hearing from the neighbour, so a host that
  replies only when spoken to still ages out; the age resets when a reply is heard.
* **`-`** is an entry nothing dated — a neighbour written by a fixture or carried in from an imported lab. The
  engine will not invent an age for it, and does not age it out either.
* A port that can no longer carry a frame is named **with its reason** — `(administratively down)`,
  `(down: no cable)`, `(down: link down)`, `(down: peer shut down)`. The entry is *not* deleted: a real ARP
  cache does not empty the moment a cable is pulled, and the state is what tells you the neighbour is stale.
* An entry with no recorded port — a topology restored from an older file — prints `-` rather than a guess,
  and one whose port no longer exists prints the name and `(gone)`.
* The rows are the rows **at the instant the session is at**, so a lab can be inspected mid-run: an entry that
  has aged by that instant is not in the table, and one that has not is printed with its age as of then. There
  is no `show arp at <ms>` — the instant is the session's, set by the run (`setRunTime`) or left over from a
  `ping … at` in a script that does not restore it.

Beyond ~30 entries the table is not the place to look for a neighbour; use the inspector's search.

### Reading `show mac address-table`

```
SW1#show mac address-table
Vlan    Mac Address         Type        Age     Ports
1       02:00:00:00:01:00   DYNAMIC     0s      Fa0/1
1       02:00:00:00:02:00   DYNAMIC     140s    Fa0/2 (administratively down)
20      02:00:00:00:09:00   DYNAMIC     -       Fa0/1 (vlan mismatch)
```

* **Ports** is the port the source MAC was heard on, per VLAN.
* **Age** is the silence: a dynamic entry leaves the table after 300 s without a frame from that address, and the
  same aged lookup decides forwarding — an entry the table only remembers is not a port a frame may be sent to. `-`
  is an entry nothing dated (a fixture's, an imported lab's), which is never aged.
* A port that can no longer carry a frame is named **with its reason**, the same sentence `show arp` uses.
  The entry is not deleted by the port going down: a real switch holds it until the age runs out, so the mark is
  what tells you the row is stale.
* **`interface <name>` filters to one port**, and the name is the rest of the line, as everywhere else:

  ```
  SW1#show mac address-table interface Port 1
  Vlan    Mac Address         Type        Age     Ports
  1       02:00:00:00:01:00   DYNAMIC     0s      Port 1
  ```

  A filter that matches nothing says so about that port (`(no entry learned on Port 9)`) rather than printing an
  empty table, which reads as a claim about the whole box. Any other trailing words are **refused** rather than
  ignored: `% show mac address-table does not take "vlan 1"`. The filter used to be accepted and dropped, so
  `… interface Port 1` answered with every entry on the switch.
* `(vlan mismatch)` means the port does not carry that VLAN at all — an entry that cannot be a forwarding
  decision, however healthy the port looks.
* **A VLAN parameter is not a mode change.** `switchport trunk native vlan`, `switchport trunk allowed vlan`,
  `switchport access vlan` and `switchport voice vlan` store their value and leave the port's mode alone, saying
  so when the value cannot be used yet:

  ```
  sw1(config-if)#switchport trunk native vlan 20
  Trunk native VLAN 20 on Fa0/1 (stored; the port is in access mode - set "switchport mode trunk" to use it)
  ```

  That is what staging a trunk is for — building it before the cable is patched — and it is what real gear
  does. These commands used to set `mode` as a side effect, so staging a trunk on an access port turned it
  into a trunk: a different command changed what the port forwards, and frames for VLAN 20 started leaving a
  port that was supposed to carry VLAN 1. Nothing but `switchport mode` changes the mode. Because the
  parameters are stored independently of the mode, `show running-config` prints them either way, so a staged
  trunk survives a backup.
* **A port's entries are flushed when its VLAN membership changes** (`switchport access vlan`,
  `switchport mode`, `switchport trunk native|allowed vlan`, and the `no` forms below). A switch that keeps
  a VLAN-1 entry on a port it has moved to VLAN 20 is a switch whose table describes a topology that no
  longer exists, and nothing here would ever remove it.

### `no switchport …` removes one leaf

Each negation removes its own value, refuses when the value is already the default, and says which value it
took away:

```
sw1(config-if)#no switchport access vlan
Access VLAN 30 removed from Fa0/1 (back to 1)
sw1(config-if)#no switchport
% Fa0/1 already has default switchport settings (access VLAN 1)
```

`no switchport mode` returns the port to access mode and **keeps** the trunk settings, printing them, so
`switchport mode trunk` brings the trunk back without retyping the native VLAN and the allowed list. Bare
`no switchport` is the only command that resets the whole port, and it lists each field it changed
(`mode trunk -> access, access VLAN 30 -> 1, native VLAN 20 -> 1, allowed list -> all`).

Every `no switchport …` form used to fall through to that whole-port reset: `no switchport access vlan`
cleared the mode, the access VLAN, the native VLAN and the allowed list together, announced as "reset to
defaults". The reset also left an empty allowed list behind, which printed as a bare
`switchport trunk allowed vlan` line — a backup the console answers with `% Incomplete command`.

Trunk ports carry their allowed VLANs, so their entries are not marked; a moved host re-learns on the next
frame it sends.

### Static routes: a next hop, or an interface, never a port name in the address field

`ip route` takes three shapes, and each of them replays from `show running-config`:

```
ip route 10.9.0.0 255.255.0.0 10.0.0.1        via a next hop
ip route 10.9.0.0 255.255.0.0 10.0.0.1 Gi0    via a next hop, out a named port
ip route 10.9.0.0 255.255.0.0 Gi0             out a port, with no next hop
```

The third used to be stored as `gw: "Gi0"` — a port name in the next-hop field — so the route was listed,
installed, printed, and then ARPed for an address called `Gi0`. Nothing said why it never worked. It is now
stored where `routeTo()` looks for an egress, and because the form carries a packet only when the far side
proxies ARP for the *destination*, both surfaces say so: the console when the line is typed, and the route
table afterwards.

```
r1(config)#ip route 192.168.9.0 255.255.255.0 Gi0
Route added: 192.168.9.0/24 out Gi0
  no next hop: this resolves by ARP on that segment, which needs proxy ARP on the far side

r1#show ip route
S  192.168.9.0    /24  [1/0] via -  Gi0  (no next hop: ARP for the destination on that segment)
```

Anything that is neither an address nor a port is refused, naming it and the route:

```
r1(config)#ip route 10.9.0.0 255.255.0.0 nonsense
% 10.9.0.0/16: "nonsense" is neither a next-hop address nor an interface on r1
r1(config)#ip route 10.9.0.0 255.255.0.0 Gi0 Gi0
% 10.9.0.0/16: Gi0 is an interface, so it cannot also be followed by Gi0
```

`ip address 10.0.0.1/24` is an address *with a prefix length*, which is not the same thing as an address and a
mask here, and the refusal says so rather than "Incomplete command":

```
r1(config-if)#ip address 10.0.0.77/24
% "10.0.0.77/24" is an address with a prefix length, not an address and a mask: use
  "ip address 10.0.0.77 255.255.255.0" or "ip address 10.0.0.77 24"
```

Inside a DHCP pool the `/prefix` spelling advertised by `network`'s own usage line is now split into a network
and a mask, so the two spellings produce the same state — instead of storing the string `10.5.0.0/24` and
producing a pool the validator rejects.

### Reading `show ip route`

The legend names every code the table can print — `C` connected, `S` static, `O` OSPF, `B` BGP — and
each row carries `[distance/metric]`. The distance is not decoration: it is half of the rule that picks
the installed route (longest prefix first, then lowest distance), and without it two rows for the same
prefix cannot be told apart.

The default gets two forms because there are two ways to configure one:

| Row | Source | Distance |
|---|---|---|
| `S*  0.0.0.0/0 [254/0] via …` | `ip default-gateway` | 254 |
| `S   0.0.0.0/0 [1/0] via …` | `ip route 0.0.0.0 0.0.0.0 …` | 1 |

`S*` marks a **candidate** default, not the installed one. The `Gateway of last resort is …` line names
the default packets actually leave by, so a device with both configured shows the static route there and
the configured gateway as `S*` below it — which is exactly the tie the old output hid by printing both as
`S`.

#### One prefix, one installed route

A prefix can be claimed by more than one source: a connected subnet that a peer also advertises over BGP, an
OSPF and a BGP route for the same network, a static someone added for a subnet the box is already on. The
lookup uses **longest prefix, then lowest distance** — connected 0, static 1, eBGP 20, OSPF 110, iBGP 200,
configured gateway 254 — and it always did. The table did not say so: it printed every candidate as an equal.

```
r1#show ip route
C   10.0.12.0      /24  is directly connected, Gi0
B  10.0.12.0      /24  [20/0] via 10.0.12.2  Gi0  (not installed: the C route for this prefix has distance 0)
O   10.3.3.0       /24  [110/0] via 10.0.12.2  Gi0  (not installed: the B route for this prefix has distance 20)
B  10.3.3.0       /24  [20/0] via 10.0.12.2  Gi0
```

Two rows, one destination, and now the table says which one a packet follows. A losing row is **not deleted** —
dropping it would hide what the peer sent and leave you asking where your BGP route went — it is marked, and the
code and distance that beat it are named. The mark is data on the row (`installed`, `shadowedBy`), computed once
in `routesTable()`, so the inspector's Routes table and the console cannot disagree about it, and
`test/route-selection.test.js` checks every mark against `routeTo()` — the lookup that actually forwards — for
every model in the catalogue.

`show ip bgp summary` counts the same way, because a count of *received* prefixes under the word "installed" was
the other half of the same lie:

```
1 prefix(es) installed from BGP (2 more received, not installed: a better route holds the prefix)
```

## Note on vendor syntax

This is intentionally a **unified** command set. A future release can add
per-vendor "translators" (e.g. accept Juniper `set interfaces …` or Huawei
`interface GigabitEthernet0/0/0`) while keeping the single underlying
configuration model. See `docs/ROADMAP.md`.

### ping — ask at an instant

```
ping <ip> [count] [at <ms>]
```

`at` asks the question that many milliseconds after power-on. Before the control plane has
finished, the reply is not a timeout - the engine names the process that is not done:

```
SW1#ping 10.0.0.2 1 at 5000
Success rate is 0 percent (0/1)
% Still converging: stp on SW1 (ready at 30000 ms) at t=5000 ms
```

Replies now carry a real millisecond time, computed from the path (propagation in each medium,
serialisation at each port, store-and-forward at each device) rather than a hop count. See
[CONVERGENCE.md](CONVERGENCE.md).

A converging path is reported as such — `Still converging: <process> on <device> (ready at <ms>) at t=<ms>` — and
never as packet loss. The line is printed once per ping, and the `t=` is the instant the answer belongs to: a ping
with no `at` is asked at `Infinity` and cannot be converging. `at <ms>` applies to that command only; the console
does not leave the session at the instant you last asked about.

### Configuration a box cannot carry out is refused

Each command that makes a promise about packet handling is checked against the device's declared capabilities, and
refused in one sentence naming the device, the capability and the consequence:

```
Router(config)# ip route 0.0.0.0 0.0.0.0 10.9.8.1     ! on an L2-only switch
% Aruba CX 6000 24G Class4 PoE 4SFP 370W (R8N87A)-d1 cannot install a route: it has no l3-forward capability
```

`ip route`, `ospf`, `ip nat`, `ip dhcp pool` and `vrrp` are gated on `l3-forward`, `nat` and `dhcp-server`
respectively, and `switchport …` and `channel-group` on `l2-forward` — a router does not switch frames, and it is told
what to do instead:

```
Router(config-if)# switchport mode trunk
% ISR 4331 branch router-d1 cannot switch frames: it has no l2-forward capability - this port routes: use `ip address <address> <mask>`
```

See [DEVICE_SCHEMA.md](DEVICE_SCHEMA.md#what-a-capability-stops-you-doing) for the table. A refused command changes
nothing — no half-made pool, no route that nothing forwards, no switchport state the printer will not describe.

### converge — when is it up?

```
converge [at <ms>]
```

Lists every process on every device with the instant it finishes, and the lab's fully-converged
time. With an instant, anything still pending is marked.

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
  exit
```

A pool is a named object on the device, not a property of an interface: one server can hold several
and a client picks by the subnet its own interface sits in. The pool is validated once, when the
sub-mode is left — `network` before `range` is the second keystroke, not an error:

```
R1(config)#ip dhcp pool lan
R1(config-dhcp)#network 10.0.0.0 255.255.255.0
R1(config-dhcp)#exit
% E_DHCP_BAD_RANGE: DHCP pool lan: both rangeStart and rangeEnd are required.
```

A client is configured with `ip address dhcp` on its interface. The exchange runs before the first
packet of a run, and the failures are the ones a server really produces — `no-server`, `no-pool`,
`pool-exhausted`, `nak`. See [SIMULATION.md §5.1](SIMULATION.md).

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

The virtual address has to be **in the interface's own subnet** — a gateway address is only a gateway for
hosts on its wire. Anything else is refused and no group is created:

```
R1(config-if)#vrrp 42 ip 10.0.0.254
% 10.0.0.254 is not in the subnet of Gi0 (10.9.9.1/24)
R1(config-if)#vrrp 42 ip 10.9.9.254
VRRP group 42 on Gi0 owns 10.9.9.254
```

An interface with no address cannot host a group at all, and says so. The election enforces the same rule
independently, so a topology restored from a file written before this check does not get a master for a
group it cannot serve: `show vrrp` reports that group as `Init` and prints the reason. A virtual address is
per-segment by nature — the same VRID and the same address on two unbridged segments elects one master per
segment, and each answers only on its own wire.

`show vrrp` reports the state after the last election:

```
R1#show vrrp
Interface     Group  Pri  State      Master            Virtual IP      Virtual MAC
Gi0/0         10     150  Master     10.0.0.1          10.0.0.254      00:00:5e:00:01:0a
```

* **State** is this router's own role: `Master`, `Backup`, or `Init` when it is not taking part at all
  (its group interface is down or has no address — a backup that cannot receive advertisements is not
  standing by, it is out).
* **Master** is the router the election chose, by the address of the interface that won it. On a backup
  this names *another* device — which is the whole point of the column — and after a failover it names
  the box that took over. A master that has been elected but has not finished converging is marked
  `(pending)`: the winner is decided, the virtual MAC is not answering ARP for it yet.
* The verdict is not recomputed here. `Simulator.computeVrrp()` keeps the election result per candidate
  port and the command prints it, so the table cannot disagree with the box that actually answers.

The election runs before the first packet of a run. A master whose interface is down relinquishes,
the backup takes over, and the virtual MAC does not change — which is the point. See
[SIMULATION.md §5.4](SIMULATION.md) and [CONVERGENCE.md](CONVERGENCE.md) for the master-down timing.

## Cables

A cable is not owned by a device, so these are accepted from any console in the lab.

```
links                              # every cable, its ends and its state
link down <linkId> [at <ms>]       # pull it: frames die, STP rebuilds, tables flush
                                   #   no `at` means now - the instant this session is at
link up   <linkId> [at <ms>]       # put it back
link state <linkId>                # what it is now, and since when
```

`at <ms>` is when the change happens, in milliseconds since power-on, so a script can say "the
uplink fails at 10 s" and then ask what the network looks like at 11 s. The command prints when the
network converges again. See [LINK-STATE.md](LINK-STATE.md).

## Every `show` form on this page is typed by a test

A row here is a promise an operator relies on before they ever open the app. `test/docs-show-commands.test.js`
reads this file, splits the alternatives (`show vlan [brief] | spanning-tree`), fills the placeholders with real
values from a real lab, and types each form at a router and a switch — 46 forms, 92 commands — and fails on the three
answers that mean the documentation and the parser disagree: `% Invalid show command`, `% Unrecognized …`, or a throw.

A *legitimate* refusal is not a failure, and the distinction is the whole point: a switch has no `show ip ospf` and
says so in a sentence (`% This device is not a DHCP server (no "ip dhcp pool" configured)`), which means this page is
right and the box is the wrong one to ask. Fifty-six of the ninety-two answers are refusals of that kind today, and
none of them complains about the command itself.

The check is real in the direction that matters: rename `show spanning-tree` to one letter off and the suite fails,
naming the form and both devices:

```
[r1] show spanning-trees -> % Invalid show command: spanning-trees
[sw] show spanning-trees -> % Invalid show command: spanning-trees
```

That example sits in a block rather than in backticks on purpose: **any show form written in backticks on this page
is a promise, and the test types every one of them**, so breaking examples are written as output rather than as
commands.

## `help` is an index, and a test reads it out of the parser

`help` is how an operator finds out what the box can do, so a verb the console accepts and the index does not mention is a verb only its author knows about. Two features landed in one day and neither appeared in it (#1491):

| accepted since | command | was in `help`? |
|---|---|---|
| #1484 | `traceroute <target> [max <n>]`, alias `tracert` | no |
| #1483 | `clock rate <bps>` (interface mode, serial only) | no |
| the DHCP pool feature | `network`, `range`, `default-router`, `lease`, `host`, `excluded-address`, `dns-server` | no — `help` mentioned only `no ip dhcp pool <name>` |
| the interface feature | `speed`, `duplex`, `description` | no |
| the SCION feature | `scion <isd-as>` / `no scion` | no |

All of them were documented in `docs/CLI.md` and reachable at the console; the index that a reader in a lab actually types was the one place they were absent.

`test/help-completeness.test.js` now checks the direction that used to be remembered rather than verified: it reads every token the dispatcher compares against `head` out of `engine/cli.js` — the console's whole vocabulary in the console's own spelling — drops the keypresses (`?`, `exit`, `quit`, `logout`, `end`, `help`, and the abbreviations `conf`, `en`, `int`), and requires each remaining verb to be named in the index. With the old index and the new check it reports **15 missing verbs**; with this one, none.

The opposite direction is a hand-written list on purpose: it has to describe modes as well as words (`['clock rate <bps>', 'iface', ROUTER]`), and parsing the index's prose to recover modes would be testing a prose parser. Every row in it is typed at a real device and must be accepted — 98 of them now, including the fourteen added here.

## Three commands that answered a question nobody asked

Each of these replied in the voice of a neighbouring command, and each answer looked plausible enough to believe (#1493).

### `spanning-tree portfast` was answered as `spanning-tree priority`

The handler took `tokens[2]` as a bridge priority without reading `tokens[1]`, so:

```
sw1(config-if)#spanning-tree portfast
% Usage: spanning-tree priority <0-61440 in 4096 steps>
sw1(config-if)#spanning-tree cost 19
% 19 is not a valid bridge priority: it must be a multiple of 4096 ...
```

`portfast` is the most-typed command in a switching lab and the console answered a question about priorities; `cost 19` was worse, because 19 is a number, so the reply reads like a verdict on the number instead of on the word. It now reads the verb first:

```
sw1(config-if)#spanning-tree portfast
% spanning-tree portfast is not modelled: this device runs one spanning tree, and its only tunable is
  `spanning-tree priority <0-61440 in 4096 steps>`
sw1(config-if)#spanning-tree portfst
% Unknown spanning-tree sub-command "portfst": the only form is `spanning-tree priority <0-61440 in 4096 steps>`
```

A misspelling is now `Unknown`, a real IOS sub-command this model does not implement is `not modelled`, and the two no longer read identically.

### `vlan 20 name lab` created a VLAN called "name lab"

`name` is a keyword in IOS's vlan sub-mode, not part of the name. The engine joined every word after the id:

```
sw1(config)#vlan 20 name lab
VLAN 20 created (name: name lab)      <- and every screen that lists names showed it
```

Now the keyword is read as a keyword, so `vlan 20 name lab`, `vlan 20 lab` and `vlan 20` mean what they say (`lab`, `lab`, `VLAN0020`); a two-word name still survives whole; `vlan 40 name-lab` is not eaten because the word only counts in front; and `vlan 20 name` with no text is refused as incomplete without writing anything.

There is no vlan sub-mode in this model, so IOS's two-line form meets a hint instead of a bare refusal:

```
sw1(config)#vlan 20
VLAN 20 created (name: VLAN0020)
sw1(config)#name lab
% There is no vlan sub-mode here: name the VLAN on its own line, `vlan <id> name <text>` (e.g. `vlan 20 name lab`)
```

### `do show vlan` rejected the command it was given

`do` passed `tokens.slice(1)` — still starting with `show` — into the `show` dispatcher, which expects the words *after* `show`:

```
sw1(config)#do show vlan
% Invalid show command: show vlan
```

Every `do show …` in every configuration session failed that way, echoing the command it had just failed to run. It now works, and `do` on anything else says what it does instead of pretending:

```
sw1(config)#do show ip interface brief
Interface              IP-Address      OK? Method Status                Protocol
Fa0/1                 unassigned      YES  manual  down                  down
sw1(config)#do ping 10.0.0.1
% `do` runs a show command from config mode here: `do show <command>` (for anything else, leave config mode with `end`)
```

`test/command-answers-the-question.test.js` pins all three: 27 checks, 27 passed. With the old handler: **11 passed / 16 failed**, each naming the neighbour's answer it used to give.
