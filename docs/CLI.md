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
| `show arp` | ARP cache, with the port each neighbour was learned on and whether that port can still carry a frame |
| `show mac address-table` | MAC table (switches), per VLAN, with stale entries marked |
| `show interfaces` | per-interface detail incl. MAC, peer, link state and what has crossed the port |
| `show running-config` | full configuration |
| `ping <ip> [count]` | ICMP echo from this device |
| `exit` / `logout` | leave the session |

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
| interfaces | `interface <name>` block: description, `ip address`, switchport VLAN/trunk, `channel-group`, `ip access-group`, `shutdown`, `vrrp <vrid> …` |
| VLAN table | `vlan <id> <name>` |
| DHCP pools | `ip dhcp pool <name>` block: network, range, default-router, dns-server, excluded-address, lease, `host <addr> <mac>` |
| DNS zones | `dns zone <apex>` followed by `dns add <name> <type> <value>` |
| ACLs | `access-list <id> <rule>` |
| routing | `ip route <dest> <mask> <gateway> [iface]`, `ip default-gateway <addr>` |

Two fields are deliberately **not** printed because no command can express them: a DNS zone's
`defaultTtl` (records inherit it) and a per-record `ttl`. A default value that the device already
assumes — VRRP `preempt` on, `advertise 1`, switchport `allowed vlan all` — is printed only when it
differs, which is the same rule the rest of the config follows.

`test/config-roundtrip.test.js` asserts both halves: the printed config replays into an identical
config, and no configured value is missing from the text.


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
| `ip address dhcp` | mark as DHCP client (reserved) |
| `shutdown` / `no shutdown` | administratively disable / enable |
| `description <text>` | set a description |
| `exit` | back to config mode |

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
  2 drops (ACL 101 denied (in) x2)
```

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

### Reading `show arp`

```
R1#show arp
Protocol  Address          Age (min)  Hardware Addr     Interface
Internet  10.0.0.9         -          02:00:00:00:02:00 Gi0
Internet  10.0.0.10        -          02:00:00:00:03:00 Gi0 (down: link down)
```

* **Interface** is the port the neighbour was heard on — where to look next.
* **Age** is `-`, always: the simulator counts steps, not minutes, and printing a step count in a minutes
  column would be a number with the wrong unit. ARP entries are not aged out here, so `-` is the honest
  answer rather than a zero that suggests they expire.
* A port that can no longer carry a frame is named **with its reason** — `(administratively down)`,
  `(down: no cable)`, `(down: link down)`, `(down: peer shut down)`. The entry is *not* deleted: a real ARP
  cache does not empty the moment a cable is pulled, and the state is what tells you the neighbour is stale.
* An entry with no recorded port — a topology restored from an older file — prints `-` rather than a guess,
  and one whose port no longer exists prints the name and `(gone)`.

Beyond ~30 entries the table is not the place to look for a neighbour; use the inspector's search.

### Reading `show mac address-table`

```
SW1#show mac address-table
Vlan    Mac Address         Type        Ports
1       02:00:00:00:01:00   DYNAMIC     Fa0/1
1       02:00:00:00:02:00   DYNAMIC     Fa0/2 (administratively down)
20      02:00:00:00:09:00   DYNAMIC     Fa0/1 (vlan mismatch)
```

* **Ports** is the port the source MAC was heard on, per VLAN.
* A port that can no longer carry a frame is named **with its reason**, the same sentence `show arp` uses.
  The entry is not deleted: a real switch ages entries out, this one does not, so the mark is what tells
  you the row is stale.
* `(vlan mismatch)` means the port does not carry that VLAN at all — an entry that cannot be a forwarding
  decision, however healthy the port looks.
* **A port's entries are flushed when its VLAN membership changes** (`switchport access vlan`,
  `switchport mode`, `switchport trunk native|allowed vlan`, `no switchport`). A switch that keeps a
  VLAN-1 entry on a port it has moved to VLAN 20 is a switch whose table describes a topology that no
  longer exists, and nothing here would ever remove it.

Trunk ports carry their allowed VLANs, so their entries are not marked; a moved host re-learns on the next
frame it sends.

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
% Still converging at t=5000 ms: stp on SW1 (ready at 30000 ms)
```

Replies now carry a real millisecond time, computed from the path (propagation in each medium,
serialisation at each port, store-and-forward at each device) rather than a hop count. See
[CONVERGENCE.md](CONVERGENCE.md).

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
link up   <linkId> [at <ms>]       # put it back
link state <linkId>                # what it is now, and since when
```

`at <ms>` is when the change happens, in milliseconds since power-on, so a script can say "the
uplink fails at 10 s" and then ask what the network looks like at 11 s. The command prints when the
network converges again. See [LINK-STATE.md](LINK-STATE.md).
