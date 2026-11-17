# Command-Line Reference

Every CLI-capable device exposes one **vendor-agnostic** console. It is
Cisco-like, but the same commands work on a Huawei router, a MikroTik switch,
or a generic PC — the engine operates on capabilities, not on vendor syntax.

Modes and their prompts:

| Mode | Prompt | How you get there |
|------|--------|-------------------|
| exec | `Hostname>` | (start) |
| enable | `Hostname#` | `enable` (or `en`) |
| config | `Hostname(config)#` | `configure terminal`, or any unique abbreviation of both words (`config t`, `conf term`, `configure term`) |
| interface | `Hostname(config-if)#` | `interface <name>` (from config) |
| subinterface | `Hostname(config-subif)#` | `interface <port>.<vlan>` (from config, or from another interface) |
| dhcp pool | `Hostname(dhcp-config)#` | `ip dhcp pool <name>` (from config) |

## Global / exec commands

| Command | Effect |
|---------|--------|
| `enable` | enter enable mode |
| `configure terminal` | enter config mode; abbreviable word by word, down to what is still unique - `config t` is accepted, `con` is refused as ambiguous (`configure` / `converge`), and a bare `configure` is `% Incomplete command` |
| `show version` | vendor, model, category, capabilities |
| `show ip interface brief` | interface IP / status table (status = whether the port can carry a frame) |
| `show ip route` | routing table: connected, static, OSPF, BGP, and the default - or `Gateway of last resort is not set` when there is none; a box that does not route prints `Default gateway is ...` over the host/redirect cache instead |
| `show arp` | ARP cache, with an age per neighbour, the port it was learned on, and whether that port can still carry a frame |
| `show mac address-table` | MAC table (switches), per VLAN, with an age per entry and stale entries marked, titled and ruled as the device prints it and closed by `Total Mac Addresses for this criterion: N` |
| `show vlan` / `show vlan brief` | VLAN table: one row per VLAN in the VLAN database, with the **access** ports in it - a trunk port carries the VLAN and appears in no row - and the four reserved defaults (1002-1005) a switch has from boot. `show vlan` is the full view: it then prints the media table (`Type`, `SAID`, `MTU`, `Stp`, `Trans1/2`), the empty `Remote SPAN VLANs` section and the empty private-VLAN table; `brief` stops after the first table |
| `show spanning-tree` | per-port STP role and state, the bridge priority and the elected root, or "not measured" when nothing has run |
| `show etherchannel summary` | the device's own summary: the nine-line flag key, both counts, `Po<N>(SU)` per group, LAG members `(P)` bundled, `(s)` suspended or `(D)` unbundled, with the reason |
| `show lldp` | LLDP neighbours, with the local port marked when it can no longer carry, and each row listed only for as long as the hold time its neighbour advertised |
| `show access-lists` | ACL rules, bindings, and how many packets each rule has matched |
| `show ip bgp` / `show ip bgp summary` | BGP neighbours with their state and reason, and the prefixes installed |
| `show interfaces` | per-interface detail incl. MAC, peer, link state and what has crossed the port |
| `show power inline [<port>]` | PoE supplied per PSE port, the budget left, and why a powered device was denied |
| `show vrrp` | the group, its state (`Master`/`Backup`/`Init` with the reason), and the master the election chose |
| `show running-config` | full configuration |
| `ping <ip> [count]` | ICMP echo from this device |
| `traceroute <address|name>` (`tracert`) | TTL-limited probes, one hop at a time, **three probes per hop**; each router that expires a probe answers with ICMP time exceeded, the destination with an echo reply, and every hop prints its address and a round trip per probe in `msec`; a probe refused with an ICMP destination-unreachable prints the letter for its code in that probe's column (`!N` network, `!H` host, `!P` protocol, `!U` port, `!A` administratively prohibited); a hop stopped by a down cable, a shut port or an ACL says why and ends the walk |
| `exit` / `logout` | leave the session |

## A command word can be shortened, down to what is still unique

`sh ver` is `show version`, `sh int` is `show interfaces`, `conf t` is `configure terminal`. IOS accepts an
abbreviation of a command word "to the number of characters that allow a unique abbreviation", and this console
follows that rule at the three places where it holds a complete list of the words that may appear there: the **first
word** of a line, the **view word after `show`**, and the **first word of a config line** (with the word after `do`
resolved as the EXEC word it is).

| typed | answered as |
|-------|-------------|
| `en`, `ena` | `enable` |
| `conf t`, `config term` | `configure terminal` |
| `sh ver`, `sh vers` | `version` |
| `sh int`, `sh int Fa0/1` | `interfaces` |
| `sh run`, `sh ru` | `running-config` |
| `trac` | `traceroute` |
| `host r1` | `hostname r1` |
| `in Fa0/1`, `int Fa0/1` | `interface Fa0/1` |
| `vla 20 name lab` | `vlan 20 name lab` |
| `sp priority 4096` | `spanning-tree priority 4096` |
| `do sh ver` | `do show version` |

A shortening two words share is refused, and the refusal names the words it could have been - the same sentence
`configure` has answered with since it learned to abbreviate:

```
sw1#sh i
% Ambiguous command "show i": ip | ipv6 | interfaces (type more characters)
```

So `c`, `co` and `con` are still ambiguous between `configure` and `converge`, `sh v` between `version`, `vlan`
and `vrrp`, and `sh p` between `port-channel` and `power`. At `(config)#` the same sentence names the config doors
- `i` is `interface | ip | ipv6`, `e` is `exit | end`:

```
sw1(config)#i
% Ambiguous config command "i": interface | ip | ipv6 (type more characters)
```

A prefix that is ambiguous changes no state: `e` at `(config)#` does not leave config mode, it says which doors it
could have opened.

The rule stops where this console has no complete list of the words that could appear. The words after `show ip`
are not shortened - type `show ip interface brief` in full; `sh ip int br` is refused as an unknown view - and a
keyword such as `brief` is not shortened either, nor is a value such as a port name: `sh int Fa` names no port
rather than guessing one. The **second** word of a config line is at that boundary too: `ip ro 10.0.0.0 255.0.0.0
10.0.0.1` is still refused, because this console cannot enumerate the words after `ip`. A one- or
two-letter prefix is also this simulator's answer rather than a claim about a particular switch: it is measured
against this console's shorter command set, so `sh s` reaches the spanning tree here where a box with `snmp`,
`ssh` and `spanning-tree` would call it ambiguous.

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

Four properties make that work, all of them load-bearing:

* **Every interface block closes with `exit`.** Without it a reader never leaves interface mode, and
  every following line — including global ones like `ip route` — is parsed as an interface command. The
  failure was silent and destructive: an address meant for `Gi0/0/0` and a `shutdown` meant for
  `Gi0/0/1` both landed on the first interface in the file.
* **Comment lines (`!`, `#`) are ignored in every mode**, including the `! PacketForge running-config`
  header the printer writes itself.
* **An interface name is the rest of the line**, because some contain spaces — Ubiquiti's `Port 1`,
  `SFP+ 1`. Splitting on whitespace and taking one token made those devices' configs unreplayable.
* **The file ends with `end`.** That is the line a real config closes with, and its job is the paste: read
  in global configuration mode it leaves configuration mode, so a pasted backup finishes instead of leaving
  the operator at `(config)#`. The number of bare `!` lines a box puts above it varies by release — one in
  the IOS 11.2 command reference, two in the ISR 4400 guide — so only `end` is copied. `end` typed at
  privileged EXEC, where a paste usually starts, is accepted and says nothing
  (`research/running-config-end.md`, `test/running-config-end.test.js`).

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
| interfaces | `interface <name>` block: description, `speed`, `duplex`, `encapsulation dot1q <vlan>` (a subinterface), `ip address`, switchport VLAN/trunk, `channel-group`, `ip access-group`, `shutdown`, `vrrp <vrid> …` |
| VLAN table | `vlan <id> [name] <text>` |
| DHCP pools | `ip dhcp pool <name>` block: network, range, default-router, dns-server, excluded-address, lease, `host <addr> <mac>` |
| DNS zones | `dns zone <apex>` followed by `dns add <name> <type> <value>` |
| ACLs | `access-list <id> <rule>` |
| routing | `ip route <dest> <mask> <gateway> [iface]`, `ip default-gateway <addr>`, and `ip routing` when the box is not in its platform's default state |
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
* `no vlan 20` still refuses while a **trunk** carries it, or while any port holds a trunk parameter that
  names it, and says which:
  * **carried by a trunk** — asked of the data plane's own rule, not a second copy of it, so a trunk allowing
    all VLANs counts (`still carried by 1 port(s): Fa0/4`) and a native VLAN is marked `(native)`;
  * **referenced** — a VLAN named on a port that does not carry it as its data VLAN: a native VLAN or an allowed
    list stored on a port that is not in trunk mode yet, or the **voice VLAN**, which an access port carries
    tagged and a trunk only stores (the name says which: `(voice)` against `(voice, no effect)`). The refusal
    names every field it found
    (`still referenced by 1 port(s): Fa0/3 (trunk native, stored, trunk allowed, stored, voice, no effect) -
    clear that first`). The voice VLAN was the reference this check did not look at, so `no vlan 20` removed a
    VLAN a port was configured with and left `switchport voice vlan 20` in the running config (#1701).

  Removing a VLAN cleared a port's staged native VLAN in silence and left `show running-config` printing no
  `vlan 20` while `show vlan` still listed it from the member ports — two descriptions of one switch that
  disagreed. An **access** port no longer stops the removal, because on the device it does not: the VLAN goes
  and the port stays assigned to it, inactive, until the VLAN comes back. Deleting a VLAN does rewrite a
  trunk's allowed list on the device, and no primary source found states exactly how, so that half keeps the
  refusal rather than replacing it with a guess.

`no hostname` also puts the device's previous name back, because `hostname` sets both the config line and the
canvas label so the two cannot disagree (#21); undoing only half of it would leave a clean config over a
label that lies.

**VLAN 1 is the exception, and it is the switch vendors' rule, not this model's.** The default VLAN is created
when the box initialises, so `vlan 1` has nothing to create: it says so and writes no `vlan 1` line into the
config, and the name stays `default` instead of becoming `VLAN0001`. `no vlan 1` is refused by name —
`% VLAN 1 is the default VLAN: every access port starts in it and it cannot be deleted` — rather than answered
with `% VLAN 1 does not exist`, which was a denial of the one VLAN that is certainly there. Neither can the name
be changed. Every vendor documents the same rule: the Catalyst 2960 configuration guide says VLAN IDs 1 and 1002
to 1005 "are automatically created and cannot be removed", the Nexus 3548 layer 2 guide says "VLAN1 is the
default VLAN and cannot be created or deleted", and a real IOS XE switch answers `no vlan 1` with
`%Default VLAN 1 may not be deleted.`


## Config-mode commands

| Command | Effect |
|---------|--------|
| `hostname <name>` | set device hostname |
| `no hostname` | clear it, restoring the device's previous name |
| `interface <name>` | enter interface config mode |
| `interface <port>.<vlan>` | create a subinterface, or open an existing one, on that parent port - the prompt is `(config-subif)#`, as a box prints it (`research/subinterface-prompt.md`) |
| `ip route <dest> <mask> <gw> [iface]` | add static route |
| `no ip route <dest> <mask> [gw]` | remove static route |
| `ip default-gateway <gw>` | set default gateway (hosts) |
| `no vlan <id>` | remove a VLAN (refused while a trunk carries it, or a port holds a trunk parameter or a voice VLAN naming it) |
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

The interface **type** is folded the same way, because every vendor spells it more than one way. Cisco
states the four forms in one sentence - "you can specify either gigabitethernet 0/1, gigabitethernet0/1,
gi 0/1, or gi0/1" - so `interface GigabitEthernet1/0/1`, `interface GigabitEthernet 1/0/1` and
`interface gi1/0/1` all open the port the panel calls `Gi1/0/1`. The long form is the one
`show running-config` prints on real gear, so it is also the form most likely to be pasted here. The fold
is onto the *type* rather than onto one vendor's abbreviation, which is what lets
`interface GigabitEthernet0/0/1` reach a Huawei port the catalogue names `GE0/0/1`.

A type may also be shortened to a prefix, which is what an operator actually types: `interface g1/0/1`,
`interface f0/1`, `interface s0/0/0`. IOS abbreviates every keyword to the number of characters that keep it
unique, and the type word is a keyword - a Cisco platform guide writes `interface g 0/1/0` and `show interface
g0/1/0` in the same procedure. What a table cannot supply is *uniqueness*, so the prefix is expanded against
the types **this** device has: `g` is `GigabitEthernet` on a switch that has no other G-type, and a prefix
that could mean two of the device's types resolves to neither (`t` on a box with both TenGigabitEthernet and
TwentyFiveGigE). A prefix that names no type the device has is refused as before, and the expansion never
reaches a name the table does not know - a UniFi `Port 1` is not `p1`. Evidence and the open questions are in
[research/interface-type-spellings.md](../research/interface-type-spellings.md).

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

One subnet, one wire. A second **primary** address that lands in a subnet another port on the same box
already holds is refused, in the vendor's one line, and nothing is applied:

```
R1(config-if)#ip address 192.168.254.32 255.255.255.192
% 192.168.254.0 overlaps with Gi0/0
```

The number is the network of the address *being typed*, under the mask being typed, and the line names the
port that got there first. Overlap is asked of the two address ranges rather than of "the same subnet",
because `10.1.1.1/16` and `10.1.2.1/24` are different subnets that still cover the same host — a box refuses
those too, in either order. A subinterface collides exactly like a port (`Gi0/0/0.20` against `Gi0/0/0`), the
same port may be re-addressed freely, `no ip address` frees the subnet, and the same subnet on another device
is the normal case and is untouched. What the refusal does *not* decide — an incumbent that is administratively
down, and an address a DHCP client holds at run time — is recorded in
[research/ip-address-overlap.md](../research/ip-address-overlap.md).

An address that is not a host address is refused before any of that is asked. Under the mask it was typed
with, the all-zeros host part names the subnet itself and the all-ones host part is its broadcast address;
neither may sit on a port, and IOS answers either one with the same line, naming the prefix length and echoing
what was typed:

```
R1(config-if)#ip address 192.168.0.0 255.255.255.0
Bad mask /24 for address 192.168.0.0
R1(config-if)#ip address 192.168.1.255 255.255.255.0
Bad mask /24 for address 192.168.1.255
```

The line carries no `%`: four raw transcripts print it bare, and the sibling refusal from the same parser
(`Not a valid host address - 0.0.0.1`) is bare too, so a marker here would be this console's addition rather
than the device's. A **/31** is the exception — RFC 3021 gives both of its addresses to the two ends of the
link, which Cisco's configuration guide states in as many words and demonstrates with `ip address 192.168.1.0
255.255.255.254` — so `192.168.1.0/31` and `192.168.1.1/31` are both accepted, one per end. A `/32` and a
`/0` are left exactly as they were: the one thread in hand says a physical port refused `192.168.2.1
255.255.255.255` while the same mask was taken on a loopback, and no second transcript settles it. What is
known, what is inferred and what would settle the rest is in
[research/ip-address-not-a-host.md](../research/ip-address-not-a-host.md).

| Command | Effect |
|---------|--------|
| `ip address <ip> <mask>` | assign an IP (e.g. `192.168.1.1 255.255.255.0`); the mask must be a run of ones then zeros and may be written as a prefix length (`24`), and the address must be a host address of that subnet (not its network or broadcast address, except on a `/31`). No word may follow the mask: IOS's syntax is `ip address ip-address mask [secondary]`, and
`secondary` adds a second address rather than replacing the primary - which this model, one address per port,
cannot honour, so `secondary` is refused by name and every other word is refused with the word quoted |
| `no ip address` | remove the IP; the line takes no argument, so `no ip address <word>` is refused and nothing is removed |
| `clock rate <bps>` | (serial only) make this end the DCE and clock the line, e.g. `clock rate 64000`. Refused on a non-serial port, and for a rate the port cannot clock |
| `no clock rate` | drop the clock, leaving this end as DTE |
| `ip address dhcp` | make the port a DHCP client; the address it ends up with is the outcome of the exchange, not part of the configuration |
| `encapsulation dot1q <vlan>` | subinterface only: tag the subinterface's frames with `<vlan>`, and make the parent port a trunk. Refused on a physical port, for a VLAN outside 1-4094, and for any other encapsulation |
| `shutdown` / `no shutdown` | administratively disable / enable |
| `description <text>` | set a description |
| `exit` | back to config mode |

**A subinterface is a VLAN tag, so the tag is in its config.** `interface Gi0/0.20` prints `encapsulation dot1q 20`
in `show running-config` even when the line was never typed, because the VLAN in the name is the tag; naming a
different one (`encapsulation dot1q 30` inside `Gi0/0.20`) stores what was typed and prints that. The command is
refused on a physical port (`% encapsulation dot1q is only valid on a subinterface (e.g. Gi0/0.10)`) and for a VLAN
outside 1-4094, anything but `dot1q` is refused as an unsupported encapsulation, and the parent port is made a
trunk - which is the router-on-a-stick pairing a saved config has to carry.

**A port has one method.** `ip address dhcp` displaces a static address and says which one it removed;
`ip address <ip> <mask>` displaces the DHCP client and says so. One port holding both was three lies at once —
it held an address it did not own, `show ip interface brief` reported Method `DHCP` beside that address, and
`show running-config` printed only the static line, so restoring the backup lost the DHCP intent. `no ip
address` now names what it removed (`IP address 10.0.0.9/24 removed`, `DHCP client removed`), or refuses when
there is nothing to remove.

**The line ends at the mask.** `ip address <ip> <mask>` reads one optional word after the mask, `secondary`, and
nothing else. Cisco's reference gives that syntax and says what the word buys - "An interface can have one
primary IP address and multiple secondary IP addresses" - and its worked example prints the primary beside two
`secondary` lines, so the keyword adds an address instead of replacing one
([`ip address` command reference](https://www.cisco.com/E-Learning/bulk/public/tac/cim/cib/using_cisco_ios_software/cmdrefs/ip_address.htm)).
This console used to drop the word and set the address anyway, which made `ip address 10.0.0.2 255.255.255.0
secondary` a *replacement* of the primary reported as `IP address set`. One port here holds one address, so the
keyword cannot be honoured: it is refused by name (`% ip address <ip> <mask> secondary adds a second address to
this port, which this console does not model: one address per port, and the address was not changed`), any other
word is refused with the word quoted, and in both cases nothing is written. The same silence covered `ip address
dhcp 5` and `no ip address foo`, which are refused the same way.

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
IPv6 address 2001:db8:aa::1/64 on Gi0/0
R1(config-if)# exit
R1(config)# ipv6 nd ra enable
IPv6 router advertisements enabled on R1
R1(config)# ipv6 nd prefix 2001:db8:aa::/64 valid 2592000 preferred 604800
IPv6 ND prefix 2001:db8:aa::/64 advertised (L=1 A=1, valid 2592000s, preferred 604800s)
R1(config)# end
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
IPv6 address autoconfig on eth0 (no address until a router advertisement arrives)
PC1(config-if)# end
PC1# ping 2001:db8:aa::1
Type escape sequence to abort.
Sending 5, 100-byte ICMP Echos to 2001:db8:aa::1, timeout is 2 seconds:
!!!!!
Success rate is 100 percent (5/5), round-trip min/avg/max = 0.002/0.002/0.002 ms
Reply from 2001:db8:aa::1: bytes=100 time=0.002 ms
Reply from 2001:db8:aa::1: bytes=100 time=0.002 ms
Reply from 2001:db8:aa::1: bytes=100 time=0.002 ms
Reply from 2001:db8:aa::1: bytes=100 time=0.002 ms
Reply from 2001:db8:aa::1: bytes=100 time=0.002 ms
PC1# show ipv6 nd
IPv6 router advertisements on PC1:
  Device      : generic-pc  (no l3-forward)
  Advertise   : unavailable - a device without l3-forward cannot route a prefix
  Flags       : M=0 O=0   router lifetime 1800s
  Timers      : reachable 0ms, retrans 0ms, hop limit 64
  Prefixes    : none - hosts would learn a default router only
  Autoconfig  : eth0 -> 2001:db8:aa::ff:fe00:100/64 (from fe80::ff:fe00:0)
  Default gw  : fe80::ff:fe00:0 via eth0  (learned from a router advertisement)
```

The host sends a router solicitation to `ff02::2`, the router answers to
`ff02::1`, and the host splices its own EUI-64 identifier onto the advertised
prefix. If the advertisement carries the M (managed) flag the host refuses to
autoconfigure and reports why: addresses on that network come from DHCPv6.

The host's line is a **derived** address, not a number the page can choose: the interface identifier is spliced
from the port's own MAC, so the host in this lab — holding `02:00:00:00:01:00` — ends `::ff:fe00:100`, while the
same host built in another order, or a second host on the cable, ends somewhere else. The solicitation and
advertisement run before the first packet a host sends, which is why the `ping` above already finds its router;
until they have, `show ipv6 nd` prints `(waiting for a router)`.

## Example session (two-subnet router)

`Gi0/0` and `Gi0/1` are patched to a host on each subnet — `10.0.1.10` and `10.0.2.10` — and every change
the console accepts prints what it did:

```
Router> enable
Router# configure terminal
Router(config)# hostname R1
R1(config)# interface Gi0/0
R1(config-if)# ip address 10.0.1.1 255.255.255.0
IP address set on Gi0/0: 10.0.1.1/24
R1(config-if)# no shutdown
Gi0/0 up
R1(config-if)# exit
R1(config)# interface Gi0/1
R1(config-if)# ip address 10.0.2.1 255.255.255.0
IP address set on Gi0/1: 10.0.2.1/24
R1(config-if)# exit
R1(config)# exit
R1# show ip route
Codes: C - connected, S - static, O - OSPF, B - BGP, * - candidate default
Gateway of last resort is not set
C   10.0.1.0       /24  is directly connected, Gi0/0
C   10.0.2.0       /24  is directly connected, Gi0/1
R1# ping 10.0.1.10
Type escape sequence to abort.
Sending 5, 100-byte ICMP Echos to 10.0.1.10, timeout is 2 seconds:
!!!!!
Success rate is 100 percent (5/5), round-trip min/avg/max = 0.002/0.002/0.002 ms
Reply from 10.0.1.10: bytes=100 time=0.002 ms
Reply from 10.0.1.10: bytes=100 time=0.002 ms
Reply from 10.0.1.10: bytes=100 time=0.002 ms
Reply from 10.0.1.10: bytes=100 time=0.002 ms
Reply from 10.0.1.10: bytes=100 time=0.002 ms
```

The success-rate line is the vendor's, clause and all. When at least one echo comes back it goes on with
`, round-trip min/avg/max = <min>/<avg>/<max> ms`; when none does it stops at the rate, because there is no round
trip to average. Both halves are the vendor's own: the 4/5 ping in Cisco's NAT connectivity note prints
`Success rate is 80 percent (4/5), round-trip min/avg/max = 1/1/2 ms`, and the ping/traceroute note prints
`Success rate is 0 percent (0/5)` with nothing after it. The figures are in this console's units - the ones the
`Reply from` lines print, one precision for the whole clause - because a real box truncates to whole milliseconds
and would print `0/0/0 ms` for this path beside `time=0.002 ms`, which is two answers to one question.
`test/ping-round-trip-clause.test.js` pins both halves of the rule.

Only the two connected subnets are in the table because no default has been configured yet, and the console
says so between the legend and the first row (`Gateway of last resort is not set`); `ip
default-gateway` and `ip route 0.0.0.0 0.0.0.0` are the two ways to add one, and their rows — plus the
`(down: no cable)` a port with nothing plugged into it prints beside its subnet — are in
[Reading `show ip route`](#reading-show-ip-route).

### Reading `show ip interface brief`

The **Status** column answers "can this port carry a frame", not merely "did somebody shut it":

| Condition | Status | Protocol |
|---|---|---|
| shut down here (`shutdown`) | `administratively down` | `down` |
| no cable plugged in | `down` | `down` |
| cabled, but the far port is shut down | `down` | `down` |
| cable patched but taken down (`link down`) | `down` | `down` |
| access VLAN deleted (`no vlan 22`) | `down` | `down` |
| otherwise | `up` | `up` |

The **Method** column names where the address came from, and a port with no address says `unset`:
`Gi0/0  unassigned  YES unset  down  down`. `manual` belongs beside an address configured at the console, and
`DHCP` stays beside `unassigned` while an `ip address dhcp` client has no lease yet - the method records the
intent, not whether it has succeeded. Cisco's field list defines `unset` as "Unset" and its sample output pairs
`Serial1  unassigned  YES unset  administratively down down`; `manual` beside `unassigned` would claim a
configuration nobody typed.

The reason travels with it in `show interfaces` — `status: down (no cable)`, `status: down (peer shut
down)`, `status: down (link down)`, `status: down (inactive)` — because `status: up` printed directly above
`peer: disconnected` was two halves of one output disagreeing. `inactive` is the deleted-VLAN state and beats
the cable tests: a port with nothing to forward in is down whatever is plugged into it, and that is reported on
the port's own `status:` line and nowhere else. There is no filtered table of "inactive ports" to ask for: the
console reads those words as a view it does not have, and refuses them in a sentence that says so rather than
printing every port as though that were the answer. A cable that was pulled with `link down` is not the same fault
as a socket with nothing in it, and the two need different fixes. A wireless radio has no cable to miss, so it is up when its radio is.

The **Method** column answers the other half of the question — how the port came by the address it holds —
and a port with no address has no method at all:

| What the port holds | IP-Address | Method |
|---|---|---|
| an address from `ip address <a> <mask>` | the address, bare | `manual` |
| `ip address dhcp`, no lease yet | `unassigned` | `DHCP` |
| nothing | `unassigned` | `unset` |

The **IP-Address** cell is the bare dotted quad - `10.0.0.1`, never `10.0.0.1/24`. IOS's field list defines
the column as "IP address assigned to the interface", and every sample output in the command reference prints
it without a mask: the IOS reference (`Ethernet0 10.108.00.5 YES NVRAM up up`), the Catalyst 2960 command
reference's interface summary (`Vlan1 172.20.135.202 YES NVRAM up up`), the CPT and 4000-series ISR guides, and
a practitioner transcript of a DHCP lease (`Ethernet0/1 192.168.12.2 YES DHCP up up`). The mask is not lost:
`show interfaces` prints `ip: 10.0.0.1/24` and `show running-config` prints
`ip address 10.0.0.1 255.255.255.0`, which are the two views a box prints it in. This console added `/24` of
its own, so a row pasted into a ticket carried a string the hardware cannot produce;
`test/interface-brief-address-cell.test.js` pins the cell against those samples.

`unassigned` beside `unset` is what a real IOS prints, and the pairing is the point: this table used to say
`manual` beside `unassigned`, which claims a person configured an address the port does not have. `DHCP` is
kept before a lease arrives because asking is a method — a client that has not been answered still reads
`unassigned YES DHCP` on hardware. `NVRAM` — the spelling a real IOS uses for an address it read back from
the saved configuration — is not distinct here: this model keeps one configuration, so a static address reads
`manual` whether or not the board has been saved.

The header is padded from the same widths as the rows, so a heading cannot sit one column to the right of the
values beneath it — `Method` above `manual`, `Status` above `down`.

A device that is **not part of a topology** has no cables to report on, so its ports keep their old
answer (`up` unless shut). The command cannot know about a cable it was never told about, and inventing
`down` for every port of a bare device would be a different wrong answer.

### Counters

Each port block also carries what has crossed it:

```
Gi0 (ethernet, 1G), MAC 0200.0000.0000   
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
Gi0/0.10 (subinterface, 1G), MAC 0200.0000.0000   
  ...
  ip: 10.9.9.1/24
  ...
                    <- no switchport line: a routed port does not switch

Fa0/1 (ethernet, 1G), MAC 0200.0000.0000   
  ...
  switchport: access VLAN 20

Fa0/3 (ethernet, 1G), MAC 0200.0000.0002   
  ...
  switchport: access VLAN 1 · trunk staged: native 20 (not in use)

Fa0/2 (ethernet, 1G), MAC 0200.0000.0001   
  ...
  switchport: trunk · native 30 · allowed 10,20

Fa0/4 (ethernet, 1G), MAC 0200.0000.0003   
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

Half duplex is a 10/100 setting, and the order of the two commands matters as it does on a real box: a port
whose ladder reaches Gigabit refuses `duplex half` outright, and `speed 100` first makes it legal. The refusal
names the rate that is in the way, because the fix is the rate. The other direction is refused too — a port in
half duplex cannot be forced to 1G, and `speed auto` is refused while the port is half, since auto would
negotiate the Gigabit back. A port that stops at 100 Mb/s (a Fast Ethernet router, say) takes `duplex half` at
auto with no argument. Both refusals and the vendor transcripts behind them are in
`research/half-duplex-is-10-100.md`.

Both halves of this setting survive a save: `duplex` always did, and `speed` did not — a lab saved with
`speed 100` came back negotiating, with the command gone from `show running-config` too, so nothing put it back
(#1405). The forced rate is written to the port document only when it is set, so a port that negotiates its own
rate still writes no `speedMbps` line at all.

Two ends forced to rates with nothing in common do **not** silently work: the link has no line rate to run
at, it comes down, `show interfaces` says `link: down (no common rate with the peer)`, and frames across it
are counted as dropped with that reason.

### Reading `show vlan`

```
VLAN Name                             Status    Ports
---- -------------------------------- --------- -------------------------------
1    default                          active    Fa0/3, Fa0/4, Fa0/5, Fa0/6
                                                Fa0/7, Fa0/8
20   twenty                           active    Fa0/1, Fa0/2, Fa0/3
30   thirty                           active    Fa0/2, Fa0/3
1002 fddi-default                     act/unsup
1003 token-ring-default               act/unsup
1004 fddinet-default                  act/unsup
1005 trnet-default                    act/unsup
```

The column widths are the device's own — a four-character id, a 32-character name, a nine-character status, Ports
in column 48 — and the rule line under the header draws those widths in dashes, so a row pasted into a ticket
lines up with the header when it is read on the device
(`test/show-vlan-table-shape.test.js`).

A Ports list that fills the console wraps: the box breaks it at 80 columns and starts the continuation back
under the `Ports` heading, at column 48, so the cell has 32 columns of room and the break carries no comma.
The arithmetic is the box's, not a per-family port count — 24 Fast Ethernet ports print four to a line, 48
Gigabit ports three to a line, because a longer name fits fewer entries in the same 32 columns — and it
reproduces three published samples exactly: the Catalyst 2960-X 15.2(6)E `show vlan` output, the 2950
factory-reset procedure's 24-port table, and Cisco lab 5.5.1, whose indentation survives the PDF
(`test/show-vlan-ports-wrap.test.js`, 13 checks; `research/show-vlan-columns.md`).

One row per VLAN, in VLAN order. **The Ports column is access membership**, and that is the vendor's rule rather
than the data plane's — Cisco's `show vlan` usage guideline says "When displaying multiple VLANs only non-trunk
ports are displayed", and `show vlan all-ports` exists precisely because the default view leaves trunks out
(`research/vlan-brief-trunk-ports.md`):

* an access port appears under its access VLAN, and under any voice VLAN it tags for a phone (that VLAN needs a
  row of its own to appear in, so it has to be in the database), and in no other row;
* **a trunk appears in no row at all** — not in the VLANs its allowed list names, and not in VLAN 1. It carries
  those VLANs; it is not a member of them, so a trunk that allows `20,30` is not "in VLAN 1" either. Listing
  trunks was the older rule, which read membership out of `classifyEgress()`: the right answer about forwarding
  and the wrong one for this table (#1638).

A VLAN has a row if it is in the VLAN database — configured with `vlan <id> [name] [<text>]`, created by
`switchport access vlan <id>`, or held from boot (VLAN 1 is there from power-on, named `default`, before anybody
types anything) — and no row otherwise. A trunk's allowed list creates nothing, and after `no vlan 22` the row
goes even though the port that names 22 still points at it: `show interfaces` reports that port inactive and
`vlan 22` is what brings it back. A configured VLAN nothing carries prints an empty Ports column rather than an
invented port.

**A switch has five VLANs before anything is configured**: 1, and the four reserved Token Ring / FDDI defaults,
1002-1005. They belong to the VLAN database from power-on, no port may be assigned to one, and they print
`act/unsup` with an empty Ports column — which is the fact behind `% VLAN id 1002 is reserved`. They are not
configuration: `show running-config` never prints them, and they keep their place in the sort, so a hand-made
VLAN 2000 appears after 1005. The names are `RESERVED_VLANS` in `engine/vlan.js`, the same list the reserved-range
refusal quotes. A device that is not a bridge is not given the reserved rows, because it has no VLAN database
(`test/show-vlan-reserved-defaults.test.js`, 30 checks).

The Ports column of such a device is empty, because a routed port is not in a VLAN: `show interfaces switchport`
refuses it with "is not a switchable port", and a router's VLAN table lists its switch module's ports only
(Cisco, *EtherSwitch Network Module*: the router's own view, `vlan-switch brief`, prints
`1 default active Fa0/2, Fa0/9, Fa0/14, Gi0/0`).
This table used to walk every interface on every box, so a router printed `1 default active Gi0/0, Gi0/1, Gi0/2`
- its own routed sockets offered as members of VLAN 1, which the hardware cannot produce. Membership now uses the
same predicate `Device.inactiveVlan()` uses; a switch is untouched
(`test/show-vlan-router-ports.test.js`, 15 checks, `research/vlan-on-a-router.md`).

A router still answers `show vlan` with a table at all, and that remains the open half: some IOS routers refuse
the command (`% Invalid input detected at '^' marker.`), some reach a VLAN database only through privileged
`vlan database ... apply`, and routers with integrated switch ports take `vlan` in global config. Whether the
command exists is per platform, and the catalogue has no "has a switch module" flag to ask, so the table stays
rather than being replaced by a refusal the model cannot justify.

### `show vlan` is two tables, and `brief` is only the first

The vendor's syntax description for `show vlan brief` says it prints "only a single line for each VLAN, naming
the VLAN, status, and ports" — the first table, and nothing else. The full view goes on:

```
VLAN Type  SAID       MTU   Parent RingNo BridgeNo Stp  BrdgMode Trans1 Trans2
---- ----- ---------- ----- ------ ------ -------- ---- -------- ------ ------
1    enet  100001     1500  -      -      -        -    -        0      0
20   enet  100020     1500  -      -      -        -    -        0      0
1002 fddi  101002     1500  -      -      -        -    -        0      0
1003 tr    101003     1500  -      -      -        -    -        0      0
1004 fdnet 101004     1500  -      -      -        ieee -        0      0
1005 trnet 101005     1500  -      -      -        ibm  -        0      0

Remote SPAN VLANs
------------------------------------------------------------------------------

Primary Secondary Type              Ports
------- --------- ----------------- ------------------------------------------
```

The header and its rule are 78 columns; every row is 73, because the box trims the padding after the last
value. Each column's rule run is one dash shorter than its field — the same rule the name table follows — and
the widths are declared once (`VLAN_MEDIA_COLUMNS` in `engine/cli.js`), so the header, the rule and the rows
cannot drift apart (`test/show-vlan-media-table.test.js`, 56 checks).

What the columns say, and how sure it is:

* **`Type` is `enet` for every VLAN you can configure, and the media for the four reserved ones** — `fddi`,
  `tr`, `fdnet`, `trnet` — with `fdnet` under IEEE spanning tree and `trnet` under IBM's. Documented: the
  2960-XR `show vlan` sample prints exactly those five words
  (<https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst2960xr/software/15-2_5_e/command_reference/b_1525e_consolidated_2960xr_cr/m_vlan_cr.html>),
  a live 3850 prints the same
  (<https://community.cisco.com/t5/switching/show-vlan-command-does-not-show-all-vlans/m-p/3918577>), and the
  `vlan` command's own defaults section states the media, the SAID, the MTU and the stp-type
  (<https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst9200/software/release/16-10/command_reference/b_1610_9200_cr/b_1610_9200_cr_chapter_010010.pdf>).
* **`SAID` is 100000 + the VLAN id** for an Ethernet VLAN, and `101002`-`101005` for the reserved rows — the
  same page: "The default said-value is 100000 plus the VLAN ID".
* **`Stp` reads `-` on an Ethernet row even though that default is `ieee`.** That is what every published
  sample prints; the field shows the media's spanning-tree flavour, not the value the box would accept.
* **`Parent`, `RingNo`, `BridgeNo`, `BrdgMode`, `Trans1`/`Trans2` are `-`/`-`/`-`/`-`/`0`/`0` here** because
  nothing in this model bridges between media: there is no source-route bridging and no translational bridge
  to name. A 6500 sample prints a non-zero `Trans1` for a VLAN that has one; this console cannot configure
  one, so it never invents the number.
* **The MTU is 1500 on every row.** The 6500 sample gives its Token Ring rows 4472, and the 2960-XR/9200/L
  samples give all four reserved rows 1500; the difference is the platform's media, and every VLAN this
  console can create is an Ethernet one.
* **The two trailing sections are printed whether or not they have contents**, as the box prints them, and
  both are always empty here: this console cannot configure an RSPAN VLAN or a private VLAN. Adopting the
  headings without the model behind them is the same bet the MAC table makes with its closing count — the
  device's furniture belongs in the answer.
* **The RSPAN rule is 78 dashes**, as the 2960-XR/2960-L/9200/Catalyst 1000 pages and the 3850 transcript
  print it. The older Supervisor-engine sample draws it 17 long, the width of the words above it; that
  platform is not the one this console follows.
* **`show vlan brief` prints the first table and stops.** The two words used to print the same thing, which
  made `brief` a synonym rather than a narrower question.

### An address is an address

Every command that takes an IPv4 address asks one question of it, and the question is whether the octets are in
range - not whether the text has four dotted groups:

```
r1(config)#ip name-server 300.1.1.1
% Invalid name server "300.1.1.1": not an IPv4 address
r1(config)#ip default-gateway 300.1.1.1
% Invalid default gateway "300.1.1.1": not an IPv4 address
r1(config)#ip route 300.1.1.0 255.255.255.0 10.1.1.9
% Invalid destination "300.1.1.0": not an IPv4 address (the form is `ip route <dest> <mask> <next-hop|interface>`)
r1(config)#ip route 192.0.2.0 255.255.255.0 300.1.1.9
% 192.0.2.0/24: "300.1.1.9" is neither a next-hop address nor an interface on ISR 4331 branch router-r1
r1(config)#ip nat pool NP 300.1.1.1 300.1.1.9 netmask 255.255.255.0
% Invalid pool address "300.1.1.1": not an IPv4 address
r1(config)#neighbor 300.1.1.1 remote-as 65002
% Invalid neighbor address "300.1.1.1": not an IPv4 address
r1(config)#ospf router-id 300.1.1.1
% Invalid router-id "300.1.1.1": not an IPv4 address
```

`net.isIp()` used to be a shape check - four groups of one to three digits - so `300.1.1.1` and `10.0.0.999` were
addresses as far as every caller was concerned, while `ip address`, `vrrp 1 ip` and `ping` refused them because they
went through `ipToInt()` instead. One predicate now, and it asks the parser: an address that cannot exist is refused
by every door, with the value quoted back.

`router bgp <as>` is a statement in config mode, not a mode of its own: the prompt stays `r1(config)#` and the
`neighbor` and `bgp` lines are typed there. This page used to print `r1(config-router)#` over the neighbour
refusal, a prompt `prompt()` never returns - the console has no router sub-mode, and
[BGP-POLICY.md](BGP-POLICY.md) makes the same choice for route maps ("There is no `(config-route-map)#`
prompt"). An operator pasting that line into a real session would have been looking for a prompt their box
never shows.

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
attached, and `at` must be followed by a number. With no count, a ping sends **five** echoes — the repeat count an
IOS-style box prompts with (`Repeat count [5]:`) and sends itself — so a bare `ping <address>` here and on real gear
send the same five and print the same `Sending 5 ...` header (research/ping-default-repeat-count.md).

```
r1> ping 10.0.0.1 51
% Count must be a whole number from 1 to 50 (asked for 51)
r1> ping 10.0.0.1 abc
% Unrecognized "abc" (ping <address|name> [<count 1-50>] [at <ms>])
r1> ping 10.0.0.1 5 at later
% Invalid instant: later
```

A name is resolved through the lab's DNS servers before a packet is sent, and
the console prints the resolution the way a box does: the lookup line comes
first, names the server the query went to in parentheses, and carries `[OK]`
only when a name came back. The resolved address is the ping target, so there
is no second "name -> address" line to read. A device with no `ip name-server`
sends the lookup to `255.255.255.255`, and the line says so:

```
h1> ping r1.lab
Translating "r1.lab"...domain server (10.0.0.1) [OK]
Type escape sequence to abort.
Sending 5, 100-byte ICMP Echos to 10.0.0.1, timeout is 2 seconds:
!!!!!
Success rate is 100 percent (5/5), round-trip min/avg/max = 0.002/0.002/0.002 ms
Reply from 10.0.0.1: bytes=100 time=0.002 ms
```

A name that does not resolve is refused **before** anything is sent, and the three ways it can fail are kept apart,
because they have different causes and different fixes:

```
h1> ping nope.lab
Translating "nope.lab"...domain server (10.0.0.1)
% Could not resolve "nope.lab": NXDOMAIN - no zone any server here hosts contains that name
% Nothing was sent. Check the zone on 10.0.0.1, or the name servers this device asks.
h1> ping only-txt.lab
Translating "only-txt.lab"...domain server (10.0.0.1)
% Could not resolve "only-txt.lab": NODATA - the name exists on 10.0.0.1 but has no A record
% Nothing was sent. Add an A record: dns add only-txt.lab A <address>
```

and `SERVFAIL` when no device in the lab hosts a zone at all, or when no listed server answers. The lookup line is
printed on the failure path too, without `[OK]`: it is the half of that output which says what was asked and where.
Digits and dots that are not a valid address (`ping 10.0.0.999`) are refused as an address rather than looked up as
a name.

`show ip dns` reads the zones back — the records that are actually answered, in zone-file shape:

```
r1> show ip dns
Zone lab (default TTL 3600) - 4 record(s)
  r1.lab                            3600    IN A      10.0.0.1
  www.lab                           3600    IN A      10.0.0.50
  alias.lab                         3600    IN CNAME  www.lab
  only-txt.lab                      3600    IN TXT    hello

Name servers this device asks: none configured - a lookup falls back to any server in the lab
```

`show ip dns zone <name>` narrows to one zone; an unknown name lists the zones that do exist. A zone the server
would refuse to answer for is printed with `NOT answered: <reason>` and the offending record, rather than shown as
if it were live. A device with no zones says it is not a DNS server, and names the command that would make it one.

A resolver list is optional, and the report says what happens without one: a lookup asks *any* server in the lab,
which is what `Simulator.resolveName()` does for a small lab.

### Tracing a name

`traceroute <address|name>` — the same walk, and a name is resolved through the lab's DNS before the first probe
goes out. The lookup is announced the way `ping` announces it, and the target line carries both names the box now
holds: the name it was given first, the address it resolved to in parentheses after it.

```
h1> traceroute srv.lab
Translating "srv.lab"...domain server (10.0.2.2) [OK]
Type escape sequence to abort.
Tracing the route to srv.lab (10.0.9.9)
 1  10.0.1.1  0.002 msec  0.002 msec  0.002 msec
 2  10.0.2.2  0.103 msec  0.103 msec  0.103 msec
 3  10.0.9.9  0.205 msec  0.205 msec  0.205 msec
```

The order is the vendor's, and it is not the obvious one: the lookup line precedes `Type escape sequence to abort.`,
exactly as it does for `ping`, and the resolved address is on the target line rather than on a line of its own.
Cisco pastes of `traceroute google.com` show the same three lines in the same order
(`research/traceroute-name-target.md`).

The hops are the hops the address form walks. `traceroute 10.0.9.9` prints the same three lines under a target line
with no parentheses:

```
h1> traceroute 10.0.9.9
Type escape sequence to abort.
Tracing the route to 10.0.9.9
 1  10.0.1.1  0.002 msec  0.002 msec  0.002 msec
 2  10.0.2.2  0.103 msec  0.103 msec  0.103 msec
 3  10.0.9.9  0.205 msec  0.205 msec  0.205 msec
```

so naming a host cannot change the path a trace reports — the two answers differ only in the lines that name the
question.

A name that does not resolve sends nothing, and the failure is named rather than traced. These are the two sentences
`ping` prints, from the same resolver helper, so the echo and the trace in one ticket cannot describe one failure two
ways:

```
h1> traceroute nope.lab
Translating "nope.lab"...domain server (10.0.2.2)
% Could not resolve "nope.lab": NXDOMAIN - no zone any server here hosts contains that name
% Nothing was sent. Check the zone on 10.0.2.2, or the name servers this device asks.
h1> traceroute only-txt.lab
Translating "only-txt.lab"...domain server (10.0.2.2)
% Could not resolve "only-txt.lab": NODATA - the name exists on 10.0.2.2 but has no A record
% Nothing was sent. Add an A record: dns add only-txt.lab A <address>
```

Digits and dots that are not an address (`traceroute 10.0.9.999`) are refused as an address rather than looked up as
a name, which is the rule `ping` already applies: a typo sent to the resolver comes back as a name that does not
exist, and sends the operator looking in the wrong place.

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
Type escape sequence to abort.
Sending 4, 100-byte ICMP Echos to 10.0.0.10, timeout is 2 seconds:
....
Success rate is 0 percent (0/4)
Request timed out (seq 0)
Request timed out (seq 1)
Request timed out (seq 2)
Request timed out (seq 3)
% Echoes lost: 4 drops ("peer port shut (r2 Gi0/0/0)" x4)
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

### A trace that stops where the cable did

`ping` and `traceroute` are read side by side in a ticket, so a trace is not allowed to be vaguer than the echo
beside it. A hop that was **stopped** — a cable that is down, a port that is shut, an ACL that refused the probe, a
VLAN the egress port is not allowed on — is not the same statement as a hop that stayed silent, and the walk now
ends where the wire did instead of printing the same star thirty times:

```
PC1#traceroute 10.0.3.9
Type escape sequence to abort.
Tracing the route to 10.0.3.9
 1  *  *  *  (link down)
% destination not reached after 1 hops
```

That is PC1's own cable pulled: `show interfaces eth0` says `status: down (link down)` and counts `link down` in
its drops. The bracketed clause is the reason the engine recorded for the drop, in the vocabulary `show interfaces`
already counts (`peer port shut (R2 Gi0/0)`, `ACL 101 denied (out)`, `VLAN not allowed on egress`), and it is chosen
differently from `ping`'s: a trace looks for the structural cause first, because `no ARP reply from <ip>` is a
conclusion drawn from the silence that followed the drop, and it would name the symptom instead of the cable.

The walk stops there because a probe that never crossed a link cannot take another road with a larger TTL — hops
two to thirty would repeat that sentence verbatim, and thirty identical stars are not a report.

One silence is deliberately **not** final: `no ARP reply from <ip>` alone is not a stopped probe, because a lab that
is still converging can resolve it on the next probe, so that hop prints its reason and the walk continues. When the
drop was recorded on a router in the path rather than on the box you are standing at, the clause says so, so a trace
from a PC does not read as though the PC dropped its own probe.

### The hop line: three probes, and a time for each

A trace is read for one number - how long the path takes to a hop - and this console used to print the address and
no figure at all, while `ping`, over the same latency model and the same wire, printed the round trip one command
earlier. A Cisco-style `traceroute` sends three probes at every TTL (`Probe count [3]`) and prints a result for
each, so a hop is the address followed by three columns in `msec`:

```
r1#traceroute 10.0.1.2
Type escape sequence to abort.
Tracing the route to 10.0.1.2
 1  10.0.0.1  0.103 msec  0.103 msec  0.103 msec
 2  10.0.1.2  0.205 msec  0.205 msec  0.205 msec
```

The engine really does send three probes per hop, and each column is that probe's own round trip: the outbound legs
are the echo request's, and the return legs are the reply's - for a hop that expired the probe, the returning frame
is an ICMP time-exceeded, which carries the original sequence number but its own id, so the two halves are measured
separately. A figure here and the figure `ping` prints for the same address are the same measurement: `ping 10.0.1.2`
in that lab reports `0.205 ms`, and a hop that took 0.205 ms says so.

The three figures of one hop agree to the last digit, and that is the model being honest rather than lazy: nothing
in it jitters or queues a frame (`engine/latency.js` says so at the top), so three identical probes on an unchanged
path do take the same time. Inventing a spread would be inventing the number the command exists to report.

A probe that was **refused** rather than answered is a letter where its time would go, and the three columns are
still three columns - a router with no route replies to each of the three probes with ICMP type 3 code 0, and a box
prints that as `!N`, three times:

```
MPLS-FW-01#traceroute 172.30.1.126
Type escape sequence to abort.
Tracing the route to 172.30.1.126
1 10.3.133.2 0 msec 0 msec 0 msec
2 172.30.91.8 0 msec 0 msec 0 msec
3 172.30.91.8 10 msec 0 msec 0 msec
4 172.30.36.131 !N !N !N
```

The letter is the ICMP code's, from the vendor's own table (`N` network unreachable, `H` host, `P` protocol, `U`
port, `A` administratively prohibited, `?` any other), and it is per probe: `2 10.10.20.2 !H * !H` is one refused
probe, one that went missing and one refused again. A code that table does not name keeps `?`. This console sends
code 0 - a router with no route - so its refusal is `!N`, which is the letter a box prints for that code.
`research/traceroute-hop-line.md` carries the transcripts and the table.

The other silence is a hop that answered nothing at all: it prints three stars in the address column -
` 2  *  *  *  (link down)` - because there is no address to print.

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

`show ip dhcp pool` is the block a real box prints, field for field — the size of the subnet the pool serves, how
much of it the pool will offer, and the address it would hand out next — over the one-row subnet table
([research/show-ip-dhcp-pool-layout.md](../research/show-ip-dhcp-pool-layout.md)):

```
r1> show ip dhcp pool
Pool lan :
 Utilization mark (high/low)    : 100 / 0
 Subnet size (first/next)       : 0 / 0
 Total addresses                : 254
 Leased addresses               : 2
 Excluded addresses             : 244
 Pending event                  : none
 1 subnet is currently in the pool :
 Current index        IP address range                     Leased/Excluded/Total
 192.168.10.101       192.168.10.1 - 192.168.10.254        2 / 244 / 254
```

`Total addresses` is the subnet's, not the range's: a /24 has 254 usable addresses however narrow the range is.
`Excluded addresses` is everything the pool will not offer — the addresses the `range` leaves out, the
`excluded-address` entries, and the gateway — so leased + excluded + free add up to the total, which is the
arithmetic the IOS XE captures print. `Current index` is the address the server would allocate next, skipping the
leases, the exclusions and the reservations; it reads `0.0.0.0` once the pool has nothing left, which is what IOS
prints for an exhausted pool. `Utilization mark` and `Subnet size` drive on-demand address pools, which this console
does not model, so every pool prints the pair every published non-ODAP capture prints.

What the pool is *configured* with is `show running-config`'s answer — `network`, `range`, `default-router`,
`dns-server`, `excluded-address`, `lease`, `host` — and this view no longer restates it. With no simulation behind
the session, `Leased addresses` reads `not measured (no simulation has run)` and the table's lease cell the same:
the engine only counts leases at an instant, and a zero it has not observed would read as "nobody has asked".

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

An **area id is a 32-bit number** and is written either way: a decimal value (0-4294967295) or a dotted
quad. `ospf area 0.0.0.1` is area 1, not area 0 — it used to be read with `parseInt`, which stops at the
first dot, so every dotted area became area 0 and two routers in *different* areas formed a full adjacency
(`test/ospf-area-id.test.js`). The id is kept in the form it was configured with, so the console echoes
`0.0.0.1` back in `show running-config` and in the `Area` column; what decides an adjacency is the 32-bit
value the Hello carries (RFC 2328 §9), so `0.0.0.1` and `1` are one area. A dotted area makes the `Area`
column wider rather than running into `Cost`.
Until now the console could not report any of it: the only place OSPF appeared was an `O` in `show ip route`. You
could set a cost and had no way to find out whether the engine used it.

```
r1> show ip ospf
Routing Process with ID 1.1.1.1
  Areas: 0
  Interfaces: 2 (1 passive)
  Neighbours: 1
  Routes installed from OSPF: 1
```

```
r1> show ip ospf neighbour
Neighbor ID     Pri   State           Dead Time   Address         Interface
2.2.2.2           1   FULL/DR         00:00:40    10.1.0.2        Gi0/0/0

1 neighbour(s), all Fully adjacent
```

The six columns are the device's, in its order and at its own columns - Neighbor ID, Pri, State,
Dead Time, Address, Interface - so a reader who knows the command finds the priority and the
countdown where they belong instead of the port under `Address`. **Pri** is the neighbour's Hello
priority: 1 here, the hardware default, because `ip ospf priority` is not modelled and the column is
carried as a number rather than spelled at the console. **Dead Time** is the Router Dead Interval
counting down from the neighbour's last Hello, and it comes from `convergence.ospfTimers()` - the
same timers the OSPF schedule converges on, not a second table - so a converged table prints the
whole interval (00:00:40 over the default 10 s hello) and a run stopped 15 s in prints 00:00:35.

**State** is two facts in one cell, the way IOS prints it: the adjacency's state, then the role the
**neighbour** holds on that segment. A broadcast segment elects a designated router and a backup -
highest interface priority first, then highest router ID, with every port here at the default
priority 1 - so across a cable with two speakers the higher router ID is the DR, and reads
`FULL/DR` from the other end, which is itself the BDR. The cell travels with the neighbour and not
with the box doing the looking: a router in the middle of a chain reads `FULL/BDR` on one port and
`FULL/DR` on the other. A serial line's default OSPF network type is point-to-point, where no
election runs at all, and the box prints `FULL/ -`. The cell used to say `Full` - one word where the
hardware prints a state and a role, which described a segment where nobody had stood for election.
`research/show-ospf-neighbor-state.md` has the sources and what is still unmodelled (`ip ospf
priority`, `ip ospf network`, a third speaker on one segment); `research/ospf-neighbor-table-layout.md`
has the column order, the measured widths and what the countdown cell still cannot show.

```
r1> show ip ospf interface
Interface   IP Address       Area  Cost  Cost from   Adjacent  Passive
Gi0/0/0     10.1.0.1/24      0     25    configured  yes       no
Gi0/0/1     192.168.1.1/24   0     1     link rate   no        yes
```

`Cost from` answers the question the two numbers alone cannot: **25** because somebody typed `ip ospf cost 25`, or
**1** because the wire is 100 Mbps and nothing was typed. The derived cost is IOS's own arithmetic -
`10^8 / bandwidth`, truncated, minimum 1, against the default 100 Mbps reference bandwidth - so 10 Mbps → 10,
100 Mbps and anything faster → 1, and a 1.544 Mbps T1 → 64. (A 10 Gbps reference, which is what
`auto-cost reference-bandwidth 10000` selects, would make a 100 Mbps port cost 100; this console does not model
that command, so it does not apply its arithmetic either.) A cost that came from the link
rate changes when the link renegotiates; a configured one does not.

Every number here is what `computeOspf()` recorded, so the report and `show ip route` cannot disagree about the
same topology. That includes the wait: on a lab that has not settled, the summary says
`(withheld: still converging)` beside the route count, because that is what the engine did.

The `Cost` column is also the first term of every metric that leaves by that port: a hop costs what the router
sending the packet advertises for its own interface — RFC 2328 §16.1 prices a path as "the sum of the costs of
the path's constituent links (as advertised in router-LSAs)" — so an asymmetric link costs what each end says it
costs, and the `[110/n]` beside an `O` route is that sum plus the cost of the destination link. The engine used to
add both ends of every link together, which priced one hop as two interfaces; `test/ospf.test.js` carries the
arithmetic and `test/ospf-route-metric.test.js` the bracket.

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
 switchport access vlan 10
 switchport mode access
 switchport voice vlan 20
```

The lines come out in the order a real switch writes them - the VLAN parameters, then the mode they select,
then the voice line - rather than the order this project happened to hold them in
(`research/running-config-switchport-order.md` has the vendor output that fixes it).

A phone on that port talks on VLAN 20 and the PC behind it on VLAN 10. The phone tags its own frames with the
voice VLAN; the PC's frames pass through the phone untagged and land in the access VLAN. The port does not become
a trunk - it carries exactly one tagged VLAN - and `show vlan` prints it under both, because it is a member of
both (`research/voice-vlan-port-mode.md`):

```
sw1# show vlan brief
VLAN Name                             Status    Ports
---- -------------------------------- --------- -------------------------------
10   VOICE-DATA                       active    Gi1/0/5
20   VOICE                            active    Gi1/0/5
```

`switchport voice vlan` is an access-port feature: Cisco's prerequisite is that voice VLAN configuration "is only
supported on device access ports; ... not supported on trunk ports", and the note beside it says a trunk "can
carry any number of voice VLANs, similar to regular VLANs". So on a trunk the command is accepted, stored and
**has no effect** - the allowed list alone decides what the trunk carries:

```
sw1(config-if)# switchport voice vlan 20
Voice VLAN 20 on Gi1/0/5 (stored; a trunk carries VLANs by its allowed list, so the voice VLAN has no effect until the port is in access mode)
```

`show interfaces <port>` says the same thing in one sentence, and the inspector panel prints the same sentence:

```
switchport: access VLAN 10 · voice 20 (tagged)
```

`no switchport voice vlan` removes it and names the value that was in force; `switchport voice vlan none` does the
same. `show running-config` prints `switchport voice vlan 20` inside the interface block, and a saved board restores
it, so a reloaded lab still separates voice from data.

### A trunk's allowed list is edited in place: `add` and `remove`

`switchport trunk allowed vlan <list>` replaces the list. `add <list>` and `remove <list>` edit the one the port
already carries, so adding VLAN 41 to a forty-VLAN trunk does not mean retyping the other thirty-nine from memory:

```
sw1(config-if)#switchport mode trunk
Switchport mode trunk on Fa0/1
sw1(config-if)#switchport trunk allowed vlan 10,20
Trunk on Fa0/1 allows VLANs 10,20
sw1(config-if)#switchport trunk allowed vlan add 30
Trunk on Fa0/1 allows VLANs 10,20,30 (added 30)
sw1(config-if)#switchport trunk allowed vlan remove 10
Trunk on Fa0/1 allows VLANs 20,30 (removed 10)
```

An edit that changes nothing says so instead of reporting a success that did not happen, and `no switchport trunk
allowed vlan` puts the default back — VLAN 1 through 4094, as `all`:

```
sw1(config-if)#switchport trunk allowed vlan add 30
Trunk on Fa0/1 already allows VLANs 30: the list is unchanged (20,30)
sw1(config-if)#switchport trunk allowed vlan remove 99
% VLANs 99 are not allowed on Fa0/1: the list is unchanged (20,30)
sw1(config-if)#no switchport trunk allowed vlan
Trunk on Fa0/1 allows all VLANs again
```

A `remove` that would empty the list is refused rather than committed, with both ways out named — a trunk carrying
no VLAN is not something to arrive at by subtraction. A `remove` on a trunk that still allows the default `all` is
not refused, because a switch subtracts from it; the remainder prints the way the box prints a list, runs folded
into ranges and the reserved 1002-1005 block never in the answer:

```
sw1(config-if)#switchport trunk allowed vlan remove 10
Trunk on Fa0/1 allows VLANs 1-9,11-1001,1006-4094 (removed 10)
```

The word in front of the list is read as a word. A list typed with spaces or with spaced ranges still parses
(`10, 20` and `40 - 42` are `10,20` and `40-42`), and anything that is neither a verb nor a list is quoted back
with the four forms the command takes:

```
sw1(config-if)#switchport trunk allowed vlan banana
% Unrecognized "banana": this console takes a list (10,20), a range (10-20), "all", "add <list>" or "remove <list>"
sw1(config-if)#switchport trunk allowed vlan add
% Incomplete command: switchport trunk allowed vlan add <list>
```

A range is two ids, written low-to-high the way every Cisco `vlan-list` note writes one — "two VLAN numbers, the
lower one first". A transposed pair is refused rather than read upside down, and the two ids are named back in
the order that works, so a typo cannot quietly configure VLANs nobody asked for
([research/vlan-range-order.md](../research/vlan-range-order.md)):

```
sw1(config-if)#switchport trunk allowed vlan 30-20
% VLAN range 30-20 runs backwards: give the lower id first (20-30)
```

`add` and `remove` used to be glued onto the list with no separator, so `add 30` arrived as the token `add30` and the
console refused a word nobody had typed — the only way to add one VLAN was to retype the whole list
([ARCHITECTURE.md](ARCHITECTURE.md), "A verb eaten by a join, and the token nobody typed"). What the list holds
afterwards is what the backup and the inspector both print, so an edited trunk survives a save without retyping:
`show running-config` writes the folded ranges `switchport trunk allowed vlan 1-9,11-1001,1006-4094`, and
`show interfaces` repeats them as `switchport: trunk · native 1 · allowed 1-9,11-1001,1006-4094`.

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
% PAT overloads one address; pool "TWO" holds more than one. Use a single-address pool for overload, or drop `overload` for a dynamic pool
% 10 is an ACL number: this model takes the inside local addresses here, e.g. `list 192.168.1.0/24` or `list any`
% Gi0/0/3 has no address: there is nothing for NAT to translate to
% Pool "WAN" ends before it starts (203.0.113.9 - 203.0.113.1)
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
1       0200.0000.0100      DYNAMIC     0s      1/1/1
1       0200.0000.0200      DYNAMIC     140s    1/1/2
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
| tcp | 86400 s (24 hours) |
| anything else | 86400 s (24 hours) |

These are Cisco's published defaults (`ip nat translation (timeout)`: `icmp-timeout` 60 s, `udp-timeout` 300 s,
`tcp-timeout` 86400 s, general `timeout` 86400 s;
<https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/ipaddr/command/ipaddr-cr-book/ipaddr-i4.html>).
`config.nat.timeouts` overrides any of them, and `show ip nat statistics` prints the values in force rather than
leaving the rule to be guessed:

```
Timeouts (seconds): icmp 60, udp 300, tcp 86400, other 86400
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
the console on the models in the catalogue that are not bridges — 1,026 of the 2,038 when #1399 was fixed,
1,061 of the 2,348 today — the report was naming a hole.

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
Flags:  D - down        P - bundled in port-channel
        I - stand-alone s - suspended
        H - Hot-standby (LACP only)
        R - Layer3      S - Layer2
        U - in use      f - failed to allocate aggregator
        M - not in use, minimum links not met
        u - unsuitable for bundling
        w - waiting to be aggregated
        d - default port
Number of channel-groups in use: 1
Number of aggregators:           1
Group  Port-channel  Protocol    Ports
------+-------------+-----------+-----------------------------------------------
1      Po1(SU)         LACP      Fa0/2(P) Fa0/3(D)
  Fa0/3     not bundled (down: link down)
  bundle 1 is running on 1 of 2 members: Fa0/2
```

The key, the two counts, the header and the rule are the device's, character for character — including the
place where the device is **not** self-consistent: the header spends 14 columns on `Port-channel` and 12 on
`Protocol`, a row spends 16 and 10, so `Protocol` sits two columns left of `LACP` while `Ports` and the member
list both start at column 33. That drift is the box's, and lining it up would be tidier than the box.

With no channel groups the same four pieces print and nothing follows them: both counts read `0`, then the
header and the rule, and no row. This console used to answer `% No link aggregation groups configured` — a
sentence no IOS prints, and one that turned an empty view into an error. A device with nothing in a view still
answers with the view: Cisco's errdisable recovery document opens its port-channel example with a 6500 that has
no groups in use and prints exactly this empty table (`research/etherchannel-summary-layout.md`).

`Po1(SU)` is the bundle's own flags: `S` Layer2, and `U` in use or `D` down — `Po1(SD)` when no member can
carry a frame, which is the row above saying the same thing about the group as `(D)` says about a member.

#### Two ends that are both `passive` never form a bundle

A `passive` port answers LACP and never starts it, so two passive ends wait for a partner that neither of them
sends: "A port in the passive mode cannot form an EtherChannel with another port that is also in the passive
mode because neither port starts LACP negotiation" (Cisco, *Configuring EtherChannels*, LACP modes). The bundle
therefore never comes up — `Po1(SD)`, every member `(s)` suspended — and the member is **not** lost: the same
chapter's next sentence is that incompatible ports are "put into an independent state" and "continue to carry
data traffic as would any other single link". This model does that, so a ping between a passive/passive pair
still crosses; it crosses over one physical link, because with the bundle gone the spanning tree sees two
parallel links between the two bridges and blocks one of them. Before this the summary claimed `Po1(SU)` with
both members `(P)` and the data plane hashed frames across a bundle no box would have built
(`research/lacp-passive-both-ends.md`).

Only two **configured** ends are decided this way. A far end in no channel group at all still lets the group
come up: the vendor sentence is about two configured ends, and what a lone negotiating port does against an
unconfigured one is not modelled here rather than guessed.

The Protocol column names a protocol and nothing else: `LACP` for `active`/`passive`, `-` for `mode on`,
because `on` negotiates nothing and there is no protocol to name (Cisco's own lab transcripts print `-` there).
It used to read `LACP (active)` and `Static`, strings no box produces; the mode is still readable in
`show running-config`, where the device keeps it, and the internal spelling (`lacp-active`) no longer leaks
into the table either, while the console accepted `active` and then warned that it was an unknown mode:

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

### `no channel-group` undoes the group it names

`no channel-group <id>` takes the port out of **that** group and of nothing else:

```
sw1(config-if)#no channel-group 5
% Fa0/1 is not in channel group 5: it is in group 2
```

The id used to be dropped by the dispatcher, so `no channel-group 9999` answered
`Fa0/1 removed from channel group 2 (the group had no other members)`: a technician correcting a typo took the
port out of the bundle that was carrying traffic, and every view afterwards agreed the port was loose. An id
outside `1-4096` is now refused as an id, and a port that is in no group says where it looked. A bare
`no channel-group` keeps its old meaning - the group the port is actually in - because that is what you type
when you do not remember the number.

A port belongs to **one** bundle. A second `channel-group` **moves** it, and says where from -
`Interface Fa0/1 moved from channel group 2 to 10 (mode on)`. Before this each line added membership to another
group, so one cable was listed in every bundle it had ever been joined to, which is a state no switch can be in.

The table is ordered by number rather than as strings, so groups read `2, 10, 100`.

### Reading `show power inline`

```
sw1#show power inline
Interface  Admin  Oper  Draw     Powered device
1/1/1      auto   on    12.95 W  PD1
1/1/2      auto   off   12.95 W  PD2  (denied)
1/1/3      auto   off   -        the far end is not a powered device
1/1/4      auto   off   -        administratively down
22 ports with nothing plugged in: 1/1/5, 1/1/6, 1/1/7, 1/1/8, 1/1/9 (+17 more)

Total: 12.95 W of 25 W in use, 12.05 W left, 1 port denied
  1/1/2: PSE budget exhausted: 12.95 W requested, 12.05 W left
```

Every figure comes from the engine's own allocation (`Simulator.computePoe()`), not from a second copy of the
rule, and every PSE port is accounted for — including the ones the engine leaves out of its table, which are the
ones an operator is usually asking about:

* `denied` means the device asked and the budget could not supply it; the sentence under the table is the same
  one the timeline emitted for the `poe-deny` event, not a re-rendering of the same arithmetic;
* `Admin` is the port's PoE **administration mode**, not the link's: the vendor's field table reads
  "Administration mode: auto, off, static", `auto` is the factory default, and `off` is what
  `power inline never` leaves behind. This console has no `power inline` command, so every PSE port is `auto` —
  including a shut one, whose shutdown is carried by `Oper off` and by the reason column. `up`/`down` is the
  link's word and used to be printed here, which made a shut port read as though its PoE mode had been set;
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

The header names the identifier the box elected for itself. With no `bgp router-id` typed, that is the
highest address on a loopback interface, or - when there is none - the highest address on a port, which is
what a real router reports (`research/bgp-router-id-selection.md`). It is a maximum over the addresses the
box holds, not the first port the catalogue lists, so `192.168.1.1` on Gi0/1 outranks `10.0.0.1` on Gi0/0.

When prefixes are installed, the table below says which ones:

```
Network          Next Hop  Metric  LocPrf  Weight  Path     Session
10.0.0.0/24      10.0.0.1  0               0       65001 i  eBGP
```

The `LocPrf` cell is empty on an eBGP-learned route, and `100` only where the path arrived over an iBGP
session: local preference is an attribute carried inside an AS, eBGP does not pass it, and so a box prints
nothing there rather than a number it never received ([Cisco, BGP and Local Preference](https://community.cisco.com/t5/routing/bgp-and-local-preference/td-p/1082270);
the [BGP Case Studies](http://www.cisco.com/c/en/us/support/docs/ip/border-gateway-protocol-bgp/26634-bgp-toc.html)
print an external route as `*> 192.208.10.0 192.208.10.5 0 <blank> 0 300 i`). This console printed `100` on
every row, which is a value a box never puts beside an eBGP path. The cell is blank, not missing: `Weight`,
`Path` and `Session` stay in their columns, so a row still parses.

The prefix list and `show ip route`'s `B` rows describe the same routes, with the same prefix lengths — they
are read together when a route is not being used.

### Reading `show access-lists`

```
Extended IP access list 101
    10 deny icmp any any (5 matches)
    20 permit ip any any
    applied IN on Gi0
```

The number is the line's own sequence number, four columns in under the header. A list typed without
sequence numbers is numbered from 10, stepping by ten, because that is what a box does: "if entries with no
sequence numbers are applied, the first entry is assigned a sequence number of 10, and successive entries
are incremented by 10" ([Cisco IOS XE, IP Access List Entry Sequence Numbering](https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/sec_data_acl/configuration/xe-16-11/sec-data-acl-xe-16-11-book/sec-acl-seq-num.pdf)).
An entry typed with a sequence of its own keeps it, and moves to its place in the list — a `5` is read, and
tested, before a `10`. The numbering and the first-match order come from one helper, so the table cannot
show an order the engine does not use (research/show-access-lists-numbering.md).

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

A neighbour is **not** deleted the moment its link goes down: real switches hold the entry until the
hold time it advertised runs out, and that is what happens here. The box notes the instant it heard each
neighbour (`lldpSeenAt`, beside the record rather than in it, because a clock reading is not something the far
end advertised) and a row older than its own TTL is dropped, so a host that is unplugged or shut stops being
listed about two minutes later — the default 120 s: `lldp timer` 30 s times the hold multiplier 4, which is
IEEE 802.1AB's Time To Live TLV and Cisco's `lldp holdtime` default. Until then the Local port is marked with
the reason, in the same sentence `show arp` and `show mac address-table` use — `(down: link down)`,
`(down: peer shut down)`, `(administratively down)` — and a fresh LLDPDU from the far end puts the row back and
restarts its clock.

Two empty tables are two different answers. `(none - no LLDP has been heard on any port)` is a lab where
nothing ever announced itself; `(none - every neighbour has gone past the hold-time it advertised without a
fresh LLDPDU)` is one whose neighbours have all gone silent, which is the state you are looking at when a link
has just died. An entry with no reception instant — written by a fixture or carried in from an imported lab — is
printed unaged and is never dropped, and neither is anything on a session with no clock (a run at `Infinity`),
because an age for it would be a guess. A received TTL of 0 is 802.1AB's "this information is no longer valid",
so that entry is dropped at once rather than read as a missing value and defaulted to 120 s.

### Reading `show arp`

```
R1#show arp
Protocol  Address          Age (min)  Hardware Addr     Type    Interface
Internet  10.0.0.9         20         0200.0000.0200    ARPA    Gi0
Internet  10.0.0.10        -          0200.0000.0300    ARPA    Gi0 (down: link down)
```

A hardware address prints the way an IOS-family device prints one: three dotted quartets, `0200.0000.0300`,
not the colon-separated form the engine stores, compares and hashes them in. The same rule covers the
`Mac Address` column of `show mac address-table`, the `MAC` on a `show interfaces <port>` block, and the
virtual MAC in `show vrrp` (`0000.5e00.010a`).

* **Type** is the encapsulation the binding was learned over, and it has three values on a real box:
  `ARPA` (Ethernet), `SNAP` (RFC 1042) and `SAP` (IEEE 802.3). Only `ARPA` is reachable here — the
  catalogue carries no Token Ring or FDDI port, the two media SNAP and SAP were for — so the column is a
  constant rather than a guess. It sits between the hardware address and the interface, which is where
  Cisco's own `show arp` field list puts it (research/show-arp-type-column.md).
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

          Mac Address Table
-------------------------------------------

Vlan    Mac Address         Type        Age     Ports
----    -----------         --------    ---     -----
1       0200.0000.0100      DYNAMIC     0s      Fa0/1
1       0200.0000.0200      DYNAMIC     140s    Fa0/2 (down: peer shut down)
20      0200.0000.0900      DYNAMIC     -       Fa0/1 (vlan mismatch)
Total Mac Addresses for this criterion: 3
```

* **The table is titled, ruled and counted, the way the device prints it.** `Total Mac Addresses for this
  criterion: N` counts the rows just printed — so under `interface <port>` it is that port's entries, not the
  switch's, and a view that matched nothing reads `…: 0` rather than losing the line. The underline under the
  headings is the device's own fixed run of dashes (4, 11, 8 and 5 for Vlan, Mac Address, Type and Ports); `Age`
  is this model's column and is underlined to the length of its own name.
* **Ports** is the port the source MAC was heard on, per VLAN.
* **Age** is the silence: a dynamic entry leaves the table after 300 s without a frame from that address, and the
  same aged lookup decides forwarding — an entry the table only remembers is not a port a frame may be sent to. `-`
  is an entry nothing dated (a fixture's, an imported lab's), which is never aged.
* A port that can no longer carry a frame is named **with its reason**, the same sentence `show arp` uses.
  A port that goes down stops being the way to an address, and the entries go with it: `shutdown` and an
  unplugged cable both drop what was learned on that port at the moment it stops carrying, as a real switch does
  (research/mac-table-link-down-flush.md). Closing a port with a learned address on it says so —
  `Fa0/2 administratively down (1 learned address on it dropped)` — and reopening it does not bring the entry
  back; the host has to speak again. The mark still earns its place for a row a fixture or an imported lab
  wrote, and for a port whose **far** end went away, which nothing here observes as an event.
* **`interface <name>` filters to one port**, and the name is the rest of the line, as everywhere else:

  ```
  SW1#show mac address-table interface Port 1

            Mac Address Table
  -------------------------------------------

  Vlan    Mac Address         Type        Age     Ports
  ----    -----------         --------    ---     -----
  1       0200.0000.0100      DYNAMIC     0s      Port 1
  Total Mac Addresses for this criterion: 1
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

The legend names every code the table can print — `C` connected, `S` static, `O` OSPF, `B` BGP, and
`*` for a candidate default — and each row carries `[distance/metric]`. The distance is not decoration: it is half of the rule that picks
the installed route (longest prefix first, then lowest distance), and without it two rows for the same
prefix cannot be told apart.

The metric is the protocol's own cost for the path, in the format Cisco's `show ip route` reference
states — `[administrative distance/metric]`, where "`[110/2]` means that the route has an administrative
distance of 110 and an OSPF metric of 2". It used to be a literal `0` on every row, so two OSPF paths to
the same prefix read the same. For an `O` row it is the distance to the router that advertises the
network plus that network link's own cost ([RFC 2328](https://www.rfc-editor.org/rfc/rfc2328.txt) §16.1,
second stage), which is why a LAN one gigabit hop away behind a neighbour is `[110/2]` and one two hops
away is `[110/3]`; a configured `ip ospf cost` is a term in that sum, and a loopback's stub link costs 0
(§12.4.1). `S` and `B` rows print `0` in that column: no cost is computed for them here.

The default gets two forms because there are two ways to configure one:

| Row | Source | Distance |
|---|---|---|
| `S*  0.0.0.0/0 [254/0] via …` | `ip default-gateway` | 254 |
| `S*  0.0.0.0/0 [1/0] via …` | `ip route 0.0.0.0 0.0.0.0 …` | 1 |

The asterisk is the device's mark for a **candidate default**, and it belongs to the prefix, not to the
row's origin: every route to `0.0.0.0/0` carries it, and the legend's last entry says so
(`* - candidate default`). A typed static default therefore reads `S* 0.0.0.0/0 [1/0] via …`, which is
the shape Cisco's own gateway-of-last-resort note prints, and so does a default learned by a protocol
(`O*E2 0.0.0.0/0`, `D*EX 0.0.0.0/0`).

What separates two candidate defaults is what separates any two routes: the distance in the brackets. The
`Gateway of last resort is …` line names the one packets actually leave by, so a device holding both shows
the static route (`[1/0]`) there and lets the configured gateway's `[254/0]` row say it is not installed.
Starring only the configured gateway — which is what this console did — put the mark on the one row no real
router keeps in its table and left the route an operator types looking like a plain `S`
(`research/show-ip-route-candidate-default.md`).

A box that routes always answers that question, in one of two forms. With no reachable default it is the
negative one, in the place Cisco's own samples put it — directly under the codes legend, above the first
route row:

```
r1#show ip route
Codes: C - connected, S - static, O - OSPF, B - BGP, * - candidate default
Gateway of last resort is not set
```

A box that does not route gets no router sentence at all. A Catalyst without `ip routing` answers
`show ip route` with a different shape, its default gateway over the host/redirect cache — three lines and no
codes legend, which is what this console prints for it now:

```
sw1#show ip route
Default gateway is 10.0.0.1
Host               Gateway           Last Use    Total Uses  Interface
ICMP redirect cache is empty
```

The first line is `Default gateway is not set` when no `ip default-gateway` is configured, and it names the
gateway verbatim when one is. The route rows are absent because such a box builds no table; `ip default-gateway`
still appears in `show running-config` and still answers for management traffic. The host cache under the header
is not modelled, so it is printed empty in the wording a box with nothing cached uses — see
`research/show-ip-route-host-table.md`.

#### Which of the two shapes a box prints: `ip routing`

Both shapes above have always been printed here, but only one of them could be *chosen*: whether a device routes
was decided by the `l3-forward` capability in its catalogue entry, so a Catalyst sold with L3 hardware printed a
routing table from the moment it was placed on the board. That is not the state a Catalyst arrives in:

> By default, the switch is in Layer 2 switching mode and IP routing is disabled. To use the Layer 3
> capabilities of the switch, you must enable IP routing.
>
> — [Catalyst 3560 Software Configuration Guide, *Configuring IP Unicast Routing*](https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst3560/software/release/15-0_2_se/configuration/guide/scg3560/swiprout.html);
> the [Catalyst 9300 defaults table](https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst9300/software/release/26-x/configuration_guide/rtng/b_26x_rtng_9300_cg/configuring_ip_unicast_routing.html)
> states the same thing in one line: `IP routing | Disabled`

`ip routing` and `no ip routing` are now commands, and the capability only decides whether the *command* exists:

```
sw1(config)#ip routing
IP routing enabled
sw1(config)#no ip routing
IP routing disabled
```

A box with no L3 forwarding has no such line, and is refused in the words it uses for every other missing
capability — `Catalyst 2960-sw2 cannot route between networks: it has no l3-forward capability` — while a word
after the command is refused rather than ignored, because `ip routing fast` must not be read as `ip routing`.

The flag is not a second copy of the answer: `show ip route`, the per-port L3 data path, the IPv6 router
advertisements and the installed-route table all ask `Device.isL3()`, which is the capability **and** the switch.
So a box cannot print a table it will not forward from, and one command moves all of them together:

```
pc1#ping 10.0.20.2
!!!!!
Success rate is 100 percent (5/5), round-trip min/avg/max = 0.103/0.103/0.103 ms
sw1(config)#no ip routing
pc1#ping 10.0.20.2
.....
Success rate is 0 percent (0/5)
% Echoes lost: 5 drops ("packet not for us and not routable (dropped by sw1)" x5)
```

Static routes are configuration, not table entries, so `no ip routing` hides them from `show ip route` and keeps
them in `show running-config`; the box's own addresses still answer, because owning an address is a host function
and routing off does not make a device deaf. The printed line follows the rule the whole file follows — only what
differs from the platform default is written — so a router (whose default is *on*) prints nothing for `ip routing`
and `no ip routing` when it was turned off, while a Catalyst prints `ip routing` only after somebody typed it.

The defaults are now a platform fact rather than a global one: a Cisco `l3-switch` category entry starts in Layer 2
mode, and every other box keeps the answer it gave before the command existed, because the documented default of a
C9200 is not evidence about a Huawei S5720. `research/ip-routing-default.md` records the citations, the two
platforms, and which models still need their own `show running-config` before their default can be claimed.

#### One prefix, one installed route

A prefix can be claimed by more than one source: a connected subnet that a peer also advertises over BGP, an
OSPF and a BGP route for the same network, a static someone added for a subnet the box is already on. The
lookup uses **longest prefix, then lowest distance** — connected 0, static 1, eBGP 20, OSPF 110, iBGP 200,
configured gateway 254 — and it always did. The table did not say so: it printed every candidate as an equal.

```
r1#show ip route
C   10.0.12.0      /24  is directly connected, Gi0
B  10.0.12.0      /24  [20/0] via 10.0.12.2  Gi0  (not installed: the C route for this prefix has distance 0)
O   10.3.3.0       /24  [110/2] via 10.0.12.2  Gi0  (not installed: the B route for this prefix has distance 20)
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
converge [<ms> | at <ms>]
```

Lists every process on every device with the instant it finishes, and the lab's fully-converged
time. With an instant — a bare number of milliseconds, `converge 10000`, or the `at` form
`converge at 10000` — anything still pending is marked `(pending)`.

Both spellings are one command. `at` is the keyword `link down <id> at <ms>` has always taken, and
`converge at 10000` used to be worse than refused: `_converge()` read `Number(tokens[0])`,
`Number('at')` is `NaN`, and a `NaN` instant fails the "is this process still pending" comparison —
so every `(pending)` mark vanished and the console reported a converged lab at an instant before it
converged. This page named the bare form and blamed the `help` index for teaching the other
(`engine/cli.js:5272`); the parser reads both now, and a word that is neither an instant nor `at` is
refused by name: `converge 1000 wibble` is `% Unrecognized "wibble" (converge [<ms> | at <ms>])`, and
`converge at`, `converge wibble`, `converge -5` are each `% Invalid instant: …`. A refusal changes
nothing, so the answer you then ask for is the one you get.

## DHCP server

```
ip dhcp pool <name>
  network <network> [mask|/prefix]
  default-router <address>
  dns-server <address...>
  range <start> <end>
  excluded-address <address[-address]>
  lease <days> [hours] [minutes] | infinite
  host <address> <mac>          # a reservation
  exit
```

`host` takes the address and the hardware address in either order, and the hardware address in any notation
this console prints one in - `aa:bb:cc:00:00:99`, `aa-bb-cc-00-00-99`, or the dotted `aabb.cc00.0099` that
`show mac address-table` and `show arp` use. All three fold onto the canonical form the pool stores, so a
reservation is written once and `no host`, `show ip dhcp binding` and `show running-config` agree about it
whichever spelling was typed. The console used to hold a colon-only shape of its own in each of those three
places, so the dotted address it prints was refused as "neither" an address nor a MAC, and a lease held by
exactly that address was answered "no lease holds that address".

`lease` takes the two forms the vendor's own reference states — `lease {days [hours [minutes]] | infinite}`, where
`infinite` means "the duration of the lease is unlimited"
([Cisco IOS IP Addressing Services Command Reference, `lease`](https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/ipaddr/command/ipaddr-cr-book/ipaddr-l1.html)).
A pool given the word carries the word: `show running-config` prints `lease infinite` back, and a binding granted
from that pool never lapses — the handshake
carries `0xffffffff`, the value [RFC 2131 §3.3](https://www.rfc-editor.org/rfc/rfc2131) reserves to represent
"infinity", and `show ip dhcp binding` prints `Infinite` in the `Expires in` column, which is the vendor word for a
static binding's lease expiration. The numeric form is unchanged, and `lease 0` is still refused as a zero-length
lease rather than read as a synonym — see
[research/dhcp-infinite-lease.md](../research/dhcp-infinite-lease.md) for what the evidence does and does not settle.

A pool is a named object on the device, not a property of an interface: one server can hold several
and a client picks by the subnet its own interface sits in. The pool is validated once, when the
sub-mode is left — `network` before `range` is the second keystroke, not an error. The verdict is
phrased as a statement about the **pool**, not about the command just typed, because after `no range`
the pool is incomplete and that is exactly the state that was asked for; the library's error code
rides at the end in parentheses so it is greppable without being the message:

```
R1(config)#ip dhcp pool lan
Created DHCP pool lan
R1(dhcp-config)#network 10.0.0.0 255.255.255.0
R1(dhcp-config)#exit
% Pool lan is incomplete - DHCP pool lan: both rangeStart and rangeEnd are required. (E_DHCP_BAD_RANGE)
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
  vrrp <vrid> preempt                 # the default, and the only value there is
  no vrrp <vrid>                      # remove the group - the only `no` form
```

**`no` reads the vrid and nothing after it.** The interface-mode handler matches `no vrrp <vrid>`
before it looks at the rest of the line — `_ifaceMode()`, `engine/cli.js:1651` — so any `no` that
names a group removes that group, whatever follows the vrid:

```
R1(config-if)#no vrrp 10 preempt
VRRP group 10 removed from Gi0
```

`no vrrp 10 priority`, `no vrrp 10 advertise` and `no vrrp 10 wibble` are answered by the same line.
Two consequences are worth knowing before typing it. There is no command that turns preemption off:
the sub-command parser has a `no` branch for it, but the dispatcher has already removed the group
by the time it would run, so every group that exists preempts. And a line written to switch one
option off deletes the virtual gateway instead - check `show vrrp` afterwards.

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
Gi0/0         10     150  Master     10.0.0.1          10.0.0.254      0000.5e00.010a   
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

A row here is a promise an operator relies on before they ever open the app. `test/docs-show-commands.test.js` reads
this file, splits the alternatives (`show vlan [brief] | spanning-tree`), fills the placeholders with real values from
a real lab, and types each form at a router and a switch — 54 forms, 108 commands today, including the
`show ?` and `show ipv6 ?` examples in the section on the help key — and fails on the three answers that mean the
documentation and the parser disagree: `% Invalid show command`, `% Unrecognized …`, or a throw.

A *legitimate* refusal is not a failure, and the distinction is the whole point: a box with no OSPF configured has no
`show ip ospf` to give and says so in a sentence (`% OSPF is not enabled (use "ospf router-id <ip>" in config mode)`),
which means this page is right and the box is the wrong one to ask. Sixty-six of the 108 answers are refusals of
that kind today, and none of them complains about the command itself.

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
| #1484 | `traceroute <ip>`, alias `tracert` | no |
| #1483 | `clock rate <bps>` (interface mode, serial only) | no |
| the DHCP pool feature | `network`, `range`, `default-router`, `lease`, `host`, `excluded-address`, `dns-server` | no — `help` mentioned only `no ip dhcp pool <name>` |
| the interface feature | `speed`, `duplex`, `description` | no |
| the SCION feature | `scion <isd-as>` / `no scion` | no |

All of them were documented in `docs/CLI.md` and reachable at the console; the index that a reader in a lab actually types was the one place they were absent.

`test/help-completeness.test.js` now checks the direction that used to be remembered rather than verified: it reads every token the dispatcher compares against `head` out of `engine/cli.js` — the console's whole vocabulary in the console's own spelling — drops the keypresses (`?`, `exit`, `quit`, `logout`, `end`, `help`, and the abbreviations `conf`, `en`, `int`), and requires each remaining verb to be named in the index. With the old index and the new check it reports **15 missing verbs**; with this one, none.

The opposite direction is a hand-written list on purpose: it has to describe modes as well as words (`['clock rate <bps>', 'iface', ROUTER]`), and parsing the index's prose to recover modes would be testing a prose parser. Every row in it is typed at a real device and must be accepted — 102 of them now: the fourteen added here, plus one more in each of the two groups that name the pool's sub-mode, because `lease` became two rows (`lease <days> <hours> <minutes>` and `lease infinite`) when the pool learned the word (#1776), plus `ip routing` and `no ip routing` — the switch that decides whether a box forwards between networks at all (#1869). The number is a reading, not a memory: the guard prints how many rows it typed.

One of those index rows is still larger than the command behind it: the traceroute row in `help` reads
`traceroute|tracert <address|name> [max <n>]`. The name half is real now — `traceroute srv.lab` resolves through
the lab's DNS and prints the lookup and the double target line a box prints ("Tracing a name"). The hop limit is
not: `_traceroute()` reads `tokens[0]` and nothing else, so `traceroute 10.0.0.1 max 5` runs the default 30-hop walk
(`Simulator.traceroute()`'s `opts.maxHops` is never passed) and swallows `max 5` without a word. That half is still
indexed and not implemented.

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
Fa0/1                  unassigned      YES unset  down                  down
sw1(config)#do ping 10.0.0.1
% `do` runs a show command from config mode here: `do show <command>` (for anything else, leave config mode with `end`)
```

`test/command-answers-the-question.test.js` pins all three: 27 checks, 27 passed. With the old handler: **11 passed / 16 failed**, each naming the neighbour's answer it used to give.

## A word the console does not know is never swallowed

Three handlers answering a neighbouring command's question (#1493) suggested a wider question: **what does each command family do when it is handed a word that does not exist?** Thirty-three families, one nonsense word each, and every answer sorted into three classes:

| class | meaning |
|---|---|
| **silent** | nothing objected — and a typo that changes state with no witness is the worst answer there is |
| **unquoted** | an objection that does not name the word; acceptable only when it names the *capability* the device lacks, or lists the values the command does take |
| **quoted** | names the word back — the shortest route from a typo to a correction |

The sweep found three, and the first two were silent:

```
sw1(config-if)#channel-group flurbish
Interface Fa0/2 added to channel group flurbish (mode active)
                                                  <- and config.lags = {"flurbish": {...members:["Fa0/2"]}}
```

The *mode* was validated (`mode flurbish` -> `% Invalid mode: flurbish`) and the **id** was not, so a typo became a channel group named "flurbish" — complete with a receipt. `show etherchannel` then lists a group no other port can ever join.

```
sw1(config-if)#shutdown flurbish
Fa0/2 administratively down
```

The extra word was ignored and the port went down. A typo that costs a link had no witness at all. Both now refuse, quote the word, and change nothing:

```
% Invalid channel group id "flurbish": a channel group is identified by a number, 1-4096 (e.g. `channel-group 1 mode active`)
% `shutdown` takes no argument: it closes this port, `no shutdown` opens it (the word "flurbish" was not used)
```

The third was misleading rather than silent — `ip route flurbish` answered `% Incomplete command: ip route <dest> <mask> <gateway|interface>`, sending the reader to add a mask to something that is not an address. The shape of the destination is now checked before the rest of the line:

```
Router(config)#ip route flurbish
% Invalid destination "flurbish": not an IPv4 address (the form is `ip route <dest> <mask> <next-hop|interface>`)
Router(config)#ip route 10.9.0.0
% Incomplete command: ip route <dest> <mask> <gateway|interface>
```

`test/no-command-swallows-a-word.test.js` runs the whole sweep as a guard — 33 families, three classes, and a rule for what an unquoted refusal is allowed to be — so the next command that accepts a word it does not know is caught by measurement rather than by someone noticing. 21 checks; with the old handler, 12 passed / 9 failed.

## A short line is not a wrong value

Fifteen commands were asked what they do with **no argument at all**. Two answered by doing something, and three answered a question nobody had asked (#1497).

### `hostname` with no name erased the name

```
Router(config)#hostname core-router
Router(config)#hostname
Router(config)#
```

No output, and `config.hostname` became `null`. `hostname` is the command that sets the name, so the one place to look for what it did is the surfaces that render it — and a bare line silently unset them. It now refuses, and says the name is unchanged:

```
Router(config)#hostname
% Incomplete command: hostname <name> (the name is unchanged)
```

### `description` with no text cleared it and reported success

```
Router(config-if)#description uplink to the core
Description set
Router(config-if)#description
Description set              <- and the description is now gone
```

A change the receipt did not name. Now a bare `description` is refused — clearing is `no description`, which says what it removed:

```
Router(config-if)#description
% Incomplete command: description <text> (use `no description` to clear it)
Router(config-if)#description uplink to the core
Description set: uplink to the core
Router(config-if)#no description
Description removed: uplink to the core
Router(config-if)#no description
Gi0/0/0 had no description
```

### A missing value was reported as an invalid one

Same shape as `ip route flurbish` in #1495 — the *empty string* was validated as a value:

| typed | used to answer | now |
|---|---|---|
| `ip name-server` | `% Invalid name server "": not an IPv4 address` | `% Incomplete command: ip name-server <address>` |
| `ipv6 address` | `% Invalid IPv6 address ""` | `% Incomplete command: ipv6 address <address>/<prefix> (or `ipv6 address autoconfig`)` |
| `vrrp 1 ip` | `% Invalid address: (none)` | `% Incomplete command: vrrp <vrid> ip <address>` |

A genuinely bad value is still quoted back (`Invalid name server "flurbish"`), so the two problems now read differently.

## Two things measured and left alone

**Whitespace is already robust.** A lab is pasted, not typed, so every command in the sweep was also run with double spaces, a tab, a leading space, a trailing space and a mix: **108 variant runs, 0 differences** in either the answer or the resulting config. That property is pinned by a test rather than assumed.

**A global command at an interface prompt is applied in global config** — deliberately, so that a pasted running-config block works without `exit` lines between blocks (#1230). It is leniency by design; what it costs is that the answer does not say where the configuration landed. The reverse is refused by name, and where the console knows better it says so:

```
Router(config)#vrrp 1 ip 10.0.0.254
% vrrp is configured per interface: enter an interface first, e.g. interface Gi0/0
```

`test/missing-argument-is-not-a-value.test.js` holds all of it: fifteen bare commands, the `hostname` and `description` receipts, the three missing-not-invalid messages, the whitespace sweep, and the leniency that is deliberate. 29 checks; with the old handler, 13 passed / 16 failed.
## `?` is a keypress in every prompt, and `exit` walks one level at a time

The console prints the mode in its prompt — `>`, `#`, `(config)#`, `(config-if)#`, `(dhcp-config)#` — and two keys that a technician uses to find their way around only worked in some of them.

`?` printed the whole index at `>` and `#`, and was a **syntax error** in the other three:

```
Router(config)#?
% Unrecognized config command: ?
Router(config-if)#?
% Unrecognized interface command: ?
```

The one key that means "I do not know what I can type here" was reported as though the key itself were a typo. The index already labels each row with the mode it belongs to (`(config mode)`, `(interface mode)`, `(in a dhcp pool)`), so the same list is the right answer in every prompt; `help` says the same thing, since the two have always been one command.

`exit` was worse in a quieter way. At `#` it did nothing at all:

```
Router#exit
Router#                   <- and again, and again
```

Exec and privileged EXEC share one dispatcher, and only `exit` at `>` was handled (as a no-op, because there is no login to leave). One level up from `#` is `>`, which this console always has underneath, so the ladder is now continuous — `(config-if)#` → `(config)#` → `#` → `>` — and each step is one `exit`.

What did **not** change: a word the console does not know is still reported in every mode (`% Unrecognized config command: flurbish`), because the fix is the two help keys and the one level, not a general amnesty.

`?` was still a typo one position after a word, though, and that position is one of the two the console keeps a complete table for — the other is the end of a `no` line, in the `no` section below. Every other place is left alone deliberately — there is no complete list of what may follow `interface` or `speed`, and a console that guesses there accepts lines the box it imitates would refuse:

```
Router#show ?
% Invalid show command: ?
Router#show ip ?
% `show ip` needs a view. This console has: route, interface brief, ospf, ...
```

So the operator unsure of the *first* word of a `show` line was told the key was invalid, while the one unsure of the second was handed the list. `show ?` now answers from `SHOW_VIEW_WORDS` — the same table the dispatcher resolves `sh ver` against, so the list cannot name a view that `show` then refuses — and every row it prints is a completion of `show `, which is why `mac address-table` and `power inline` appear with the words they need and the whole list can be typed back. `ip` and `ipv6` are words that take a view of their own, so they are named on their own line, and `show ipv6 ?` names its one view (`nd`) where it used to be the same invalid-command report.

`test/help-key-works-in-every-prompt.test.js` holds it: ten checks — the index at each of the five prompts (from `?` and from `help`, with the prompt unchanged afterwards), a command still working after asking for help, the full `exit` ladder, the unknown-word reports, and the `show ?` listing described above. The first nine of them — everything except the `show ?` check, which #1679 added — scored 4 passed / 5 failed against the old handler.

## A `no` that names one thing must not remove another

`no` is the only undo a technician has. An undo that refuses is annoying; an undo that removes something *else* is a fault, because the running-config then holds a state nobody asked for and the next `show` disagrees with the intention.

### `no spanning-tree portfast` cleared the bridge priority

The set form of `spanning-tree` was taught to read its verb before its value in #1493. The `no` form never read the word at all:

```js
} else if (head === 'no' && tokens[1] === 'spanning-tree') {
  const dev = this.device;
  if (!dev.config.stpPriority && dev.config.stpPriority !== 0) { /* "No bridge priority set" */ }
  dev.config.stpPriority = null;      // whatever the third word said
```

So on a switch with `spanning-tree priority 4096`:

| typed | answered |
|---|---|
| `no spanning-tree portfast` | `Bridge priority cleared (was 4096), back to the default 32768` |
| `no spanning-tree cost` | `Bridge priority cleared (was 4096), back to the default 32768` |
| `no spanning-tree bpduguard` | `Bridge priority cleared (was 4096), back to the default 32768` |
| `no spanning-tree flurbish` | `Bridge priority cleared (was 4096), back to the default 32768` |

Four different questions, one answer, and the answer destroyed a setting none of them named. The root election is decided by exactly this number, so the effect is a lab that reconverges to a different root after an operator tried to remove portfast.

The word is now read, and the two forms answer alike — portfast, cost, bpduguard and the rest are named as *not modelled, so there is nothing to remove*, an unknown word is quoted back, and only `no spanning-tree` or `no spanning-tree priority` touch the priority:

```
sw1(config)#no spanning-tree portfast
% spanning-tree portfast is not modelled, so there is nothing to remove: this device runs one
  spanning tree, and its only tunable is `spanning-tree priority <0-61440 in 4096 steps>`
```

### `help` promised a spelling the parser refuses

The index said `speed auto|forced <mbps>`; `_speed()` has never had a `forced` keyword — it parses `auto` or a rate (`100`, `1000`, `1G`), and its own usage line said `speed auto | <mbps>`.

```
Router(config-if)#speed forced 100
% Invalid rate "forced" - give a number of Mbps or auto
```

A documented spelling the parser refuses is worse than one that is missing, because the help is the first thing trusted. The row now reads `speed auto|<mbps>` with both accepted spellings shown, and the test types all three forms at a port.

### `no ip access-group` answered with a sentence that was not one

```
% No an access list applied in or out on Gi0/0
```

Ungrammatical, no subject, and phrased as if the command had removed something. It now uses the shape the sibling refusals already had — `No hostname set`, `No DHCP pool named nope` — so it says which list, or that there is none, and where it looked:

| typed (nothing applied) | answered |
|---|---|
| `no ip access-group` | `% No access list applied in or out on Gi0/0` |
| `no ip access-group 101 in` | `% No access list 101 applied in on Gi0/0` |

Writing it a different way first — `Access list 101 is not applied in on Gi0/0`, which reads fine — failed an existing check in `test/config-undo.test.js`, which had already pinned the house shape for this refusal. The repo's own test caught the deviation, so the new wording follows the neighbours instead of the other way round.

`test/no-command-touches-only-what-it-names.test.js` holds all three: twelve checks today, covering the four destructive `no` forms, the two forms that really do clear the priority, the "nothing set" answer, the help row, the three speed spellings, both access-group sentences, and the five added since - `no channel-group` naming the group it does not touch, a bare `no channel-group` still meaning the group the port is in, a second `channel-group` moving the port rather than adding it, the bundle table's numeric order, and the set and `no` directions agreeing about per-VLAN spanning tree. It shipped with seven checks, and against the old handler those seven scored 3 passed / 4 failed.

### `no vlan 42 name ?` removed the VLAN

The `no` forms in this section all read the word that names what to undo. None of them read the words *after*
it: a branch takes the tokens it needs and ignores the rest, so a `?` typed at the end of a `no` line where the
operator was asking for help was one more token to ignore and the line acted.

```
sw1(config)#no vlan 42 name ?
VLAN 42 removed
sw1(config)#no hostname ?
Hostname cleared (device is now d1)
sw1(config-if)#no description ?
Description removed: uplink to core
```

Three destructive lines, three receipts shaped like success, and none of them answers the question the key was
asking. Checking the value position (#1685, #1691) cannot see this one, because the damage is done by the words
*before* the key — `no vlan 42` is a complete and destructive line on its own.

So the key is checked once, before any `no` branch acts, and the refusal is written in the words of the branch it
stopped, which is the syntax the operator wanted in the first place:

```
sw1(config)#no vlan 42 name ?
% "?" is the help key, not a value: `no vlan <id>` removes a VLAN - nothing was removed
sw1(config)#no hostname ?
% "?" is the help key, not a value: `no hostname` clears the hostname - nothing was cleared
sw1(config-if)#no description ?
% "?" is the help key, not a value: `no description` clears the description on this port - nothing was cleared
```

The table behind it is `NO_FORMS` in `engine/cli.js`: 32 branches — 15 in config mode, 9 at an interface, 8 in a
DHCP pool — and the longest match wins, so `no ip nat pool <name>` is named rather than the `no ip nat` beside it.
A head the table does not know is refused without inventing a syntax it never had:

```
sw1(config)#no flurbish ?
% "?" is the help key, not a value: a `no` line undoes a command that is already configured - nothing was changed
```

`no ?` is the one line where the key really is a question — the word it wanted is missing, so the answer is where
the index is:

```
sw1(config)#no ?
% Incomplete command: `no` needs the command it undoes, e.g. `no vlan <id>`; type `?` on its own for the index - nothing was changed
```

Only a whole token is the key. A `?` inside a longer word is part of the word and is left alone, so on a box
with VLAN 42, `no vlan 42 name lab?1` is still a `no vlan 42` and answers `VLAN 42 removed`.

`test/no-form-help-key.test.js` holds the lot: eight groups covering the three destructive lines above and the
state each one left behind (`show vlan` still lists VLAN 42, the running-config still prints the hostname, the port
keeps its description), the other `no` heads that ignore trailing tokens, `no network ?` and `no pool ?` in pool
mode, the whole-token rule, the bare `no ?`, and an unrecognised head. 81 checks; with the old handler, 13 passed
/ 68 failed.

## A stated range is the range the check applies

Every handler that takes a number prints the range it accepts, and that sentence is the only specification the
operator has: nobody reads the source to find out whether `4097` is a channel group. So the check behind the
sentence and the sentence itself have to be the same two numbers — no wider, and no narrower.

`test/stated-range-is-the-enforced-range.test.js` asks the question at four points per setting — below the range,
the low edge, the high edge, above the range — and requires refused, accepted, accepted, refused:

| setting | range | probed |
|---|---|---|
| `vlan <id>` | 1-4094 | 0, 1, 4094, 4095 |
| `channel-group <id>` | 1-4096 | 0, 1, 4096, 4097 |
| `vrrp <vrid>` | 1-255 | 0, 1, 255, 256 |
| `vrrp <vrid> priority` | 1-255 | 0, 1, 255, 256 |
| `spanning-tree priority` | 0-61440 in steps of 4096 | -1, 0, 61440, 61441 |
| `ipv6 nd ra lifetime` | 0-65535 | 0, 65535, 65536 |
| `ip ospf cost` | 1-65535 | 0, 1, 65535, 65536 |
| `ping <address> <count>` | 1-50 | 0, 1, 50, 51 |

A refusal is also the place the range is quoted back, so both refusals must *state* it, and any value a refusal
offers as valid must itself be accepted. Two settings failed that (#1505); the rest of the table was already right
and stays as a guard.

### `channel-group 4097` built a bundle its own refusal says cannot exist

```
sw1(config-if)#channel-group 4097 mode active
Interface Fa0/2 added to channel group 4097 (mode active)                  ← before
% Invalid channel group id "4097": a channel group is identified by a number, 1-4096   ← now
```

The condition was `!/^\d+$/.test(id) || Number(id) < 1` — a lower bound only. #1495 fixed the half where a *word*
became configuration (`channel-group flurbish` created a group called "flurbish") and left the ceiling unapplied,
so an id one digit too far became a bundle that `show etherchannel summary` then printed as fact. A refused id now
leaves nothing behind: no entry in the bundle table, no membership on the port, no row in the summary.

### `spanning-tree priority 61441` offered a correction that is also refused

```
% 61441 is not a valid bridge priority: it must be a multiple of 4096 (the low 12 bits are the system ID
  extension); the nearest valid values are 61440 and 65536                            ← before
% 61441 is not a valid bridge priority: the range is 0 to 61440                       ← now
```

The range was tested *last*, so the step rule answered first and computed its neighbours arithmetically
(`Math.ceil(61441 / 4096) * 4096`), past the top of the range. `65536` is not a bridge priority: the handler that
suggested it refuses it. The range is now asked before the step, so the value one step too far is answered with
the range in the same words the neighbouring refusals use, and the only values ever suggested are ones the check
accepts.

Measured at the same time and correct as it stands: `encapsulation dot1q` and `ip access-group` refuse a *physical
port* and a *list that does not exist*, and both answer in terms of the real problem rather than the number.
